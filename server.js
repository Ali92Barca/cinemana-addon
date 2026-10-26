const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { AsyncLocalStorage } = require("node:async_hooks");
const requestContext = new AsyncLocalStorage();

const PORT = Number(process.env.PORT || 7000);
const BASE = (process.env.CINEMANA_BASE || "https://cinemana.shabakaty.com").replace(/\/+$/, "");
const ADDON_ID = process.env.ADDON_ID || "org.local.cinemana-nuvio";
const PAGE_SIZE = 30;
const MAX_SEARCH_PAGES = 15;
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const tmdbSearchCache = new Map();
const tmdbDetailsCache = new Map();
const tmdbSeasonCache = new Map();
const seriesEpisodeSearchCache = new Map();

const categories = [
  { id: "cinemana_action", name: "Cinemana • أكشن", categoryID: "97,84" },
  { id: "cinemana_thriller", name: "Cinemana • إثارة", categoryID: "80" },
  { id: "cinemana_crime", name: "Cinemana • جريمة", categoryID: "60" },
  { id: "cinemana_western", name: "Cinemana • حياة الغرب", categoryID: "89" },
  { id: "cinemana_scifi", name: "Cinemana • خيال علمي", categoryID: "78" },
  { id: "cinemana_fantasy", name: "Cinemana • خيالي", categoryID: "67" },
  { id: "cinemana_drama", name: "Cinemana • دراما", categoryID: "62" },
  { id: "cinemana_animation", name: "Cinemana • رسوم متحركة", categoryID: "57" },
  { id: "cinemana_horror", name: "Cinemana • رعب", categoryID: "70" },
  { id: "cinemana_romance", name: "Cinemana • رومانسي", categoryID: "77" },
  { id: "cinemana_sport", name: "Cinemana • رياضي", categoryID: "79" },
  { id: "cinemana_mystery", name: "Cinemana • غموض", categoryID: "76" },
  { id: "cinemana_comedy", name: "Cinemana • كوميدي", categoryID: "59" },
  { id: "cinemana_adventure", name: "Cinemana • مغامرة", categoryID: "56" },
  { id: "cinemana_documentary", name: "Cinemana • وثائقي", categoryID: "61" }
];

const manifest = {
  id: ADDON_ID,
  version: "0.5.1",
  name: "Cinemana (unofficial)",
  description: "Cinemana movies and series enriched with TMDB metadata and Cinemana playback IDs. Uses the TMDB API but is not endorsed or certified by TMDB.",
  resources: ["catalog", "meta", "stream", "subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["cinemana:", "cinemana-series:"],
  behaviorHints: { configurable: true, configurationRequired: true },
  config: [
    { key: "tmdb_api_key", type: "password", title: "TMDB API Key" },
    { key: "language", type: "select", title: "Metadata language", options: ["ar-SA", "en-US", "ar-IQ"] , default: "ar-SA" }
  ],
  catalogs: [
    { type: "movie", id: "cinemana_search", name: "Cinemana Movies Search", extra: [{ name: "search", isRequired: false }] },
    { type: "series", id: "cinemana_series_search", name: "Cinemana Series Search", extra: [{ name: "search", isRequired: false }] },
    ...categories.map(c => ({ type: "movie", id: c.id, name: c.name })),
    ...categories.map(c => ({ type: "series", id: `${c.id}_series`, name: `${c.name} • مسلسلات` }))
  ]
};

const builder = new addonBuilder(manifest);

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function absoluteImage(item) {
  const value = item?.imgObjUrl || item?.imgMediumThumbObjUrl || item?.imgThumbObjUrl || "";
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? value : `${BASE}/${value.replace(/^\/+/, "")}`;
}

function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.info)) return data.info;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.videos)) return data.videos;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function numericId(value) {
  const id = String(value ?? "").trim();
  return /^\d+$/.test(id) ? id : "";
}

function rootSeriesId(item) {
  const root = numericId(item?.rootSeries);
  return root && root !== "0" ? root : "";
}


function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function currentTmdbConfig() {
  const config = requestContext.getStore() || {};
  return {
    apiKey: String(config.tmdbApiKey || TMDB_API_KEY || "").trim(),
    language: String(config.language || "ar-SA").trim() || "ar-SA"
  };
}

async function tmdbJson(path, params = {}) {
  const { apiKey, language } = currentTmdbConfig();
  if (!apiKey) throw new Error("TMDB API key is missing. Open the addon's Configure page and enter your key.");
  const qs = new URLSearchParams({ api_key: apiKey, ...params });
  const response = await fetch(`${TMDB_BASE}${path}?${qs.toString()}`, {
    headers: { accept: "application/json", "user-agent": "CinemanaNuvioAddon/0.5.2" }
  });
  if (!response.ok) throw new Error(`TMDB API returned HTTP ${response.status}`);
  return response.json();
}

function titleCandidates(item) {
  return [...new Set([
    firstText(item?.en_title, item?.other_title, item?.title),
    firstText(item?.ar_title),
  ].filter(Boolean))];
}

function scoreTmdbResult(result, query, type, itemYear) {
  const queryNorm = normalizeTitle(query);
  const resultNorm = normalizeTitle(type === "movie" ? (result.title || result.original_title) : (result.name || result.original_name));
  let score = 0;
  if (queryNorm && resultNorm === queryNorm) score += 100;
  else if (queryNorm && (resultNorm.includes(queryNorm) || queryNorm.includes(resultNorm))) score += 45;
  const resultDate = type === "movie" ? result.release_date : result.first_air_date;
  const resultYear = resultDate ? Number(resultDate.slice(0, 4)) : 0;
  if (itemYear && resultYear) score += Math.max(0, 25 - Math.abs(itemYear - resultYear) * 5);
  score += Math.min(10, Number(result.popularity || 0) / 10);
  return score;
}

async function searchTmdb(item, type) {
  const candidates = titleCandidates(item);
  const { apiKey, language: configuredLanguage } = currentTmdbConfig();
  const cacheKey = `${apiKey}|${configuredLanguage}|${type}|${candidates.join("|")}|${item?.year || ""}`;
  if (tmdbSearchCache.has(cacheKey)) return tmdbSearchCache.get(cacheKey);

  // Cache the in-flight promise as well as its result, so concurrent requests
  // for the same title don't trigger duplicate TMDB calls.
  const pending = (async () => {
    const endpoint = type === "movie" ? "/search/movie" : "/search/tv";
    const primary = candidates[0];
    const secondary = candidates.find(x => normalizeTitle(x) !== normalizeTitle(primary));
    const queries = primary ? [{ query: primary, language: "en-US" }] : [];
    if (secondary) queries.push({ query: secondary, language: "ar-SA" });

    let best = null;
    for (const { query, language } of queries) {
      try {
        const data = await tmdbJson(endpoint, {
          query, language: (language || configuredLanguage), include_adult: "false", page: "1"
        });
        const results = Array.isArray(data.results) ? data.results : [];
        const candidate = results
          .map(result => ({ result, score: scoreTmdbResult(result, query, type, Number.parseInt(item?.year, 10) || 0) }))
          .sort((a, b) => b.score - a.score)[0];
        if (candidate && (!best || candidate.score > best.score)) best = candidate;
        if (best?.score >= 100) break;
      } catch (error) {
        console.warn(`TMDB search failed for ${query}: ${error.message}`);
      }
    }
    return best && best.score >= 40 ? best.result : null;
  })();
  tmdbSearchCache.set(cacheKey, pending);
  try {
    const result = await pending;
    tmdbSearchCache.set(cacheKey, result);
    return result;
  } catch (error) {
    tmdbSearchCache.delete(cacheKey);
    throw error;
  }
}

async function getTmdbDetails(tmdbId, type) {
  const { apiKey, language: configuredLanguage } = currentTmdbConfig();
  const cacheKey = `${apiKey}|${configuredLanguage}|${type}|${tmdbId}`;
  if (tmdbDetailsCache.has(cacheKey)) return tmdbDetailsCache.get(cacheKey);
  const endpoint = type === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
  const pending = tmdbJson(endpoint, { language: currentTmdbConfig().language });
  tmdbDetailsCache.set(cacheKey, pending);
  try {
    const details = await pending;
    tmdbDetailsCache.set(cacheKey, details);
    return details;
  } catch (error) {
    tmdbDetailsCache.delete(cacheKey);
    throw error;
  }
}

async function enrichMetaWithTmdb(meta, item, type) {
  try {
    const result = await searchTmdb(item, type);
    if (!result?.id) return meta;
    const details = await getTmdbDetails(result.id, type);
    const tmdbPoster = details.poster_path || result.poster_path;
    const tmdbYear = (type === "movie" ? details.release_date : details.first_air_date) || "";
    const tmdbName = type === "movie"
      ? firstText(details.title, details.original_title)
      : firstText(details.name, details.original_name);
    const overview = firstText(details.overview, result.overview);
    const genres = Array.isArray(details.genres) ? details.genres.map(g => g.name).filter(Boolean) : undefined;
    return {
      ...meta,
      name: tmdbName || meta.name,
      poster: tmdbPoster ? `${TMDB_IMAGE_BASE}${tmdbPoster}` : meta.poster,
      background: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : meta.background,
      description: overview || meta.description,
      year: Number.parseInt(tmdbYear.slice(0, 4), 10) || meta.year,
      releaseInfo: tmdbYear.slice(0, 4) || meta.releaseInfo,
      genres: genres?.length ? genres : meta.genres,
      imdbRating: Number.isFinite(Number(details.vote_average)) ? Number(details.vote_average).toFixed(1) : meta.imdbRating,
      links: [...(meta.links || []), { name: "TMDB", category: "tmdb", url: `https://www.themoviedb.org/${type === "movie" ? "movie" : "tv"}/${result.id}` }],
      _tmdbId: result.id,
      _tmdbDetails: details
    };
  } catch (error) {
    console.warn(`TMDB metadata enrichment failed: ${error.message}`);
    return meta;
  }
}

async function getTmdbSeason(tmdbId, seasonNumber) {
  const { apiKey, language: configuredLanguage } = currentTmdbConfig();
  const cacheKey = `${apiKey}|${configuredLanguage}|${tmdbId}|${seasonNumber}`;
  if (tmdbSeasonCache.has(cacheKey)) return tmdbSeasonCache.get(cacheKey);
  const pending = tmdbJson(`/tv/${tmdbId}/season/${seasonNumber}`, { language: currentTmdbConfig().language });
  tmdbSeasonCache.set(cacheKey, pending);
  try {
    const season = await pending;
    tmdbSeasonCache.set(cacheKey, season);
    return season;
  } catch (error) {
    tmdbSeasonCache.delete(cacheKey);
    throw error;
  }
}

async function enrichSeriesVideosWithTmdb(videos, details) {
  if (!details?.id || !Array.isArray(videos) || !videos.length) return videos;

  const seasonNumbers = [...new Set(videos.map(video =>
    Math.max(0, Number.parseInt(video.season, 10) || 1)
  ))];
  const seasonEntries = await Promise.all(seasonNumbers.map(async seasonNumber => {
    try {
      return [seasonNumber, await getTmdbSeason(details.id, seasonNumber)];
    } catch (error) {
      console.warn(`TMDB season lookup failed for S${seasonNumber}: ${error.message}`);
      return [seasonNumber, null];
    }
  }));
  const seasons = new Map(seasonEntries);

  return videos.map(video => {
    const seasonNumber = Math.max(0, Number.parseInt(video.season, 10) || 1);
    const episodeNumber = Math.max(1, Number.parseInt(video.episode, 10) || 1);
    const seasonData = seasons.get(seasonNumber);
    const episode = (seasonData?.episodes || []).find(e => Number(e.episode_number) === episodeNumber);
    if (!episode) return video;
    return {
      ...video,
      title: firstText(episode.name, video.title) || `Episode ${episodeNumber}`,
      overview: firstText(episode.overview, video.overview),
      released: episode.air_date || video.released,
      thumbnail: episode.still_path ? `https://image.tmdb.org/t/p/w300${episode.still_path}` : video.thumbnail
    };
  });
}

async function findCinemanaEpisodesForSeries(item, rootId) {
  const titleNames = new Set(titleCandidates(item).map(normalizeTitle).filter(Boolean));
  const cacheKey = `${rootId}|${[...titleNames].join("|")}`;
  if (seriesEpisodeSearchCache.has(cacheKey)) return seriesEpisodeSearchCache.get(cacheKey);

  const pending = (async () => {
    const results = [];
    const seen = new Set();
    // Searching every page serially (up to 1,200 results) made opening a series
    // very slow. Fetch a bounded number of pages in parallel and cache the result.
    // videoSeason remains the primary source; this is only an expansion fallback.
    const queries = titleCandidates(item).slice(0, 2);
    for (const query of queries) {
      const pagesToFetch = 10;
      let pageArrays = [];
      try {
        pageArrays = await Promise.all(Array.from({ length: pagesToFetch }, (_, page) =>
          getSearchPage(query, "series", page).then(extractItems).catch(() => [])
        ));
      } catch (error) {
        console.warn(`Cinemana episode search failed for ${query}: ${error.message}`);
      }
      let queryAdded = 0;
      for (const pageItems of pageArrays) {
        for (const candidate of pageItems) {
          const id = numericId(candidate?.nb || candidate?.id);
          if (!id || seen.has(id)) continue;
          const candidateRoot = rootSeriesId(candidate);
          const candidateTitle = normalizeTitle(firstText(candidate.en_title, candidate.ar_title, candidate.other_title, candidate.title));
          if (candidateRoot !== String(rootId) && !titleNames.has(candidateTitle)) continue;
          seen.add(id);
          results.push(candidate);
          queryAdded++;
        }
      }
      // Arabic title search is a fallback; skip it if English already found a useful set.
      if (queryAdded > 0) break;
    }
    return results;
  })();
  seriesEpisodeSearchCache.set(cacheKey, pending);
  try {
    const result = await pending;
    seriesEpisodeSearchCache.set(cacheKey, result);
    return result;
  } catch (error) {
    seriesEpisodeSearchCache.delete(cacheKey);
    throw error;
  }
}

function makeCatalogMeta(item, type = "movie") {
  const videoId = numericId(item?.nb || item?.id);
  if (!videoId) return null;
  const seriesId = rootSeriesId(item) || videoId;
  const id = type === "series" ? `cinemana-series:${seriesId}` : `cinemana:${videoId}`;
  const name = firstText(item.en_title, item.ar_title, item.other_title, item.title) || `Cinemana ${videoId}`;
  const meta = {
    id,
    type,
    name,
    poster: absoluteImage(item),
    year: Number.parseInt(item.year, 10) || undefined,
    description: firstText(item.description, item.en_description, item.ar_description, item.en_content, item.ar_content),
    genres: Array.isArray(item.categories)
      ? item.categories.map(c => firstText(c?.en_title, c?.ar_title)).filter(Boolean)
      : (item.category_en_title ? [item.category_en_title] : undefined),
    imdbRating: item.stars ? String(item.stars) : undefined,
    releaseInfo: item.year ? String(item.year) : undefined,
    language: item.language_lighttigerNb ? String(item.language_lighttigerNb) : undefined,
    links: item.imdbUrlRef ? [{ name: "IMDb", category: "imdb", url: item.imdbUrlRef }] : undefined
  };
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined && v !== ""));
}

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json", "user-agent": "CinemanaNuvioAddon/0.4" }
  });
  if (!response.ok) throw new Error(`Cinemana API returned HTTP ${response.status} for ${path}`);
  return response.json();
}

async function getCategoryPage(categoryID, offset, videoKind = "1") {
  const qs = new URLSearchParams({
    categoryID: String(categoryID), orderby: "desc", videoKind: String(videoKind),
    offset: String(offset), level: "0"
  });
  return getJson(`/api/android/videosByCategory?${qs.toString()}`);
}

async function getSearchPage(query, type = "movies", page = 0) {
  const qs = new URLSearchParams({
    level: "0", videoTitle: query, staffTitle: "", page: String(page),
    year: "1900,2026", type: String(type)
  });
  return getJson(`/api/android/AdvancedSearch?${qs.toString()}&`);
}

async function getAllSearchResults(query, type, requiredCount) {
  const all = [];
  const seenIds = new Set();
  let previousPageSignature = "";

  for (let page = 0; page < MAX_SEARCH_PAGES && all.length < requiredCount; page++) {
    const data = await getSearchPage(query, type, page);
    const pageItems = extractItems(data);
    if (!pageItems.length) break;

    const signature = pageItems.map(x => String(x?.nb || x?.id || "")).join(",");
    if (!signature || signature === previousPageSignature) break;
    previousPageSignature = signature;

    let added = 0;
    for (const item of pageItems) {
      const id = numericId(item?.nb || item?.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      all.push(item);
      added++;
    }
    // If page parameter is ignored by the API, stop rather than loop over duplicates.
    if (added === 0) break;
  }
  return all;
}

async function getSeriesEpisodes(id) {
  // videoSeason may return the starting season plus child records for later
  // seasons. Follow one representative record per additional season so anime
  // with multiple seasons can expose more than the first batch of episodes.
  const found = new Map();
  const pending = [String(id)];
  const visitedIds = new Set();
  const queriedSeasons = new Set();
  const MAX_SEASON_LOOKUPS = 12;
  let lookups = 0;

  while (pending.length && lookups < MAX_SEASON_LOOKUPS) {
    const currentId = pending.shift();
    if (!numericId(currentId) || visitedIds.has(currentId)) continue;
    visitedIds.add(currentId);
    lookups++;

    let data;
    try {
      data = await getJson(`/api/android/videoSeason/id/${encodeURIComponent(currentId)}`);
    } catch (error) {
      console.warn(`Cinemana videoSeason lookup failed for ${currentId}: ${error.message}`);
      continue;
    }

    const items = extractItems(data).filter(item => numericId(item?.nb || item?.id));
    if (!items.length) continue;

    const currentRecord = items.find(item => numericId(item?.nb || item?.id) === currentId);
    const baseSeason = Math.max(1, Number.parseInt(currentRecord?.season ?? items[0]?.season, 10) || 1);
    queriedSeasons.add(baseSeason);

    for (const item of items) {
      const episodeId = numericId(item.nb || item.id);
      const season = Math.max(1, Number.parseInt(item.season, 10) || 1);
      const episode = Math.max(1, Number.parseInt(item.episodeNummer, 10) || 1);
      const episodeName = firstText(item.en_title, item.ar_title, item.other_title, item.title) || `Episode ${episode}`;
      if (!found.has(episodeId)) {
        found.set(episodeId, {
          id: `cinemana:${episodeId}`,
          title: episodeName,
          season,
          episode,
          released: item.mDate || item.releaseDate || undefined,
          overview: firstText(item.description, item.en_description, item.en_content, item.ar_content)
        });
      }
    }

    // A child item with a nonzero rootSeries and a different season can be the
    // entry point for that season. Query one ID per season, not every episode.
    const nextBySeason = new Map();
    for (const item of items) {
      const episodeId = numericId(item?.nb || item?.id);
      const season = Math.max(1, Number.parseInt(item?.season, 10) || 1);
      const root = rootSeriesId(item);
      if (!episodeId || !root || season === baseSeason || queriedSeasons.has(season)) continue;
      if (!nextBySeason.has(season)) nextBySeason.set(season, episodeId);
    }
    for (const [season, nextId] of nextBySeason) {
      queriedSeasons.add(season);
      if (!visitedIds.has(nextId)) pending.push(nextId);
    }
  }

  return [...found.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function makeEpisodeFallback(item, rawId) {
  const season = Math.max(1, Number.parseInt(item?.season, 10) || 1);
  const episode = Math.max(1, Number.parseInt(item?.episodeNummer, 10) || 1);
  return [{
    id: `cinemana:${rawId}`,
    title: firstText(item?.en_title, item?.ar_title, item?.other_title, item?.title) || `Episode ${episode}`,
    season,
    episode,
    released: item?.mDate || undefined,
    overview: firstText(item?.description, item?.en_description, item?.ar_description, item?.en_content, item?.ar_content)
  }];
}

builder.defineCatalogHandler(async ({ type = "movie", id, extra = {} }) => {
  const isSeries = type === "series" || id === "cinemana_series_search" || String(id).endsWith("_series");
  const resultType = isSeries ? "series" : "movie";
  const skip = Math.max(0, Number.parseInt(extra.skip || "0", 10) || 0);
  let items = [];

  if (id === "cinemana_search" || id === "cinemana_series_search") {
    const query = String(extra.search || "").trim();
    if (!query) return { metas: [] };
    items = await getAllSearchResults(query, isSeries ? "series" : "movies", skip + PAGE_SIZE);
  } else {
    const baseId = String(id).endsWith("_series") ? String(id).slice(0, -7) : id;
    const category = categories.find(c => c.id === baseId);
    if (!category) return { metas: [] };

    const target = skip + PAGE_SIZE;
    let cursor = 0;
    let guard = 0;
    const seen = new Set();
    while (items.length < target && guard < 30) {
      const data = await getCategoryPage(category.categoryID, cursor, isSeries ? "2" : "1");
      const pageItems = extractItems(data);
      if (!pageItems.length) break;
      let added = 0;
      for (const item of pageItems) {
        const key = numericId(item?.nb || item?.id);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(item);
        added++;
      }
      const next = Number.parseInt(data?.offset, 10);
      if (added === 0 || !Number.isFinite(next) || next <= cursor) break;
      cursor = next;
      guard++;
    }
  }

  items = items.slice(skip, skip + PAGE_SIZE);
  const metas = [];
  const seenSeriesIds = new Set();
  const seenRootlessTitles = new Set();
  for (const item of items) {
    const meta = makeCatalogMeta(item, resultType);
    if (!meta) continue;
    if (isSeries) {
      const videoId = numericId(item?.nb || item?.id);
      const rootId = rootSeriesId(item);
      const seriesIdentity = rootId || videoId;
      const titleKey = `${firstText(item?.en_title, item?.ar_title, item?.other_title, item?.title)?.toLocaleLowerCase() || ""}|${String(item?.year || "")}`;
      // Some anime episodes have rootSeries=0; group those by title/year.
      if (seenSeriesIds.has(seriesIdentity)) continue;
      if (!rootId && titleKey !== "|" && seenRootlessTitles.has(titleKey)) continue;
      seenSeriesIds.add(seriesIdentity);
      if (!rootId && titleKey !== "|") seenRootlessTitles.add(titleKey);
    }
    metas.push(meta);
  }
  return { metas };
});

builder.defineMetaHandler(async ({ id, config = {} }) => requestContext.run({
  tmdbApiKey: String(config.tmdb_api_key || TMDB_API_KEY || "").trim(),
  language: String(config.language || "ar-SA").trim() || "ar-SA"
}, async () => {
  const idText = String(id || "");
  const isSeries = idText.startsWith("cinemana-series:");
  const rawId = idText.replace(/^cinemana-series:/, "").replace(/^cinemana:/, "");
  if (!numericId(rawId)) return { meta: null };

  if (isSeries) {
    let item = null;
    try {
      const data = await getJson(`/api/android/allVideoInfo/id/${encodeURIComponent(rawId)}`);
      item = Array.isArray(data) ? data[0] : (data?.info ? (Array.isArray(data.info) ? data.info[0] : data.info) : data);
    } catch (_) {}

    let videos = [];
    try { videos = await getSeriesEpisodes(rawId); } catch (error) {
      console.warn(`Cinemana videoSeason lookup failed for ${rawId}: ${error.message}`);
    }

    if (!item && videos.length) {
      item = { ...(videos[0] || {}), nb: rawId };
    }
    if (!item) return { meta: null };

    // The Cinemana videoSeason endpoint can list only a subset for rootSeries=0 anime.
    // Expand from Cinemana's series search by title and merge by the real Cinemana video ID.
    try {
      const searchedEpisodes = await findCinemanaEpisodesForSeries(item, rawId);
      const byId = new Map(videos.map(v => [String(v.id).replace(/^cinemana:/, ""), v]));
      for (const episodeItem of searchedEpisodes) {
        const episodeId = numericId(episodeItem.nb || episodeItem.id);
        if (!episodeId) continue;
        const season = Math.max(1, Number.parseInt(episodeItem.season, 10) || 1);
        const episode = Math.max(1, Number.parseInt(episodeItem.episodeNummer, 10) || 1);
        const old = byId.get(episodeId);
        byId.set(episodeId, {
          id: `cinemana:${episodeId}`,
          title: old?.title || `Episode ${episode}`,
          season,
          episode,
          released: episodeItem.mDate || episodeItem.videoUploadDate || old?.released,
          overview: old?.overview || firstText(episodeItem.en_content, episodeItem.ar_content, episodeItem.en_description, episodeItem.ar_description)
        });
      }
      videos = [...byId.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
    } catch (error) {
      console.warn(`Cinemana series search expansion failed: ${error.message}`);
    }

    if (!videos.length) videos = makeEpisodeFallback(item, rawId);
    let base = makeCatalogMeta({ ...item, nb: item.nb || rawId }, "series");
    if (!base) return { meta: null };

    // TMDB supplies richer series metadata and official season/episode titles, but only
    // Cinemana IDs are used for playback. If matching fails, Cinemana metadata remains.
    let tmdbDetails = null;
    try {
      const tmdbResult = await searchTmdb(item, "tv");
      if (tmdbResult?.id) {
        tmdbDetails = await getTmdbDetails(tmdbResult.id, "tv");
        base = await enrichMetaWithTmdb(base, item, "tv");
      }
    } catch (error) {
      console.warn(`TMDB series enrichment failed: ${error.message}`);
    }
    if (tmdbDetails) videos = await enrichSeriesVideosWithTmdb(videos, tmdbDetails);
    base.videos = videos;
    delete base._tmdbId;
    delete base._tmdbDetails;
    return { meta: base };
  }

  const data = await getJson(`/api/android/allVideoInfo/id/${encodeURIComponent(rawId)}`);
  const item = Array.isArray(data) ? data[0] : (data?.info ? (Array.isArray(data.info) ? data.info[0] : data.info) : data);
  if (!item) return { meta: null };
  const base = makeCatalogMeta({ ...item, nb: item.nb || rawId }, "movie");
  return { meta: await enrichMetaWithTmdb(base, item, "movie") };
}));

builder.defineStreamHandler(async ({ id }) => {
  const rawId = String(id || "").replace(/^cinemana-series:/, "").replace(/^cinemana:/, "");
  if (!numericId(rawId)) return { streams: [] };

  const data = await getJson(`/api/android/transcoddedFiles/id/${encodeURIComponent(rawId)}`);
  const versions = Array.isArray(data) ? data : (data?.info || data?.files || []);
  const streams = versions
    .filter(v => typeof v.videoUrl === "string" && /^https?:\/\//i.test(v.videoUrl))
    .map(v => ({
      name: "Cinemana",
      title: `${v.resolution || v.transcoddedFileName || "Video"} · ${v.container || "MP4"}`,
      url: v.videoUrl,
      behaviorHints: { notWebReady: false }
    }));
  return { streams };
});

// Cinemana exposes signed subtitle URLs in allVideoInfo, usually in `translations`.
// Prefer VTT tracks when present, and fall back to the signed SRT paths.
const subtitleInfoCache = new Map();
async function getSubtitleTracks(rawId) {
  if (subtitleInfoCache.has(rawId)) return subtitleInfoCache.get(rawId);
  const pending = (async () => {
    const data = await getJson(`/api/android/allVideoInfo/id/${encodeURIComponent(rawId)}`);
    const item = Array.isArray(data) ? data[0] : (data?.info ? (Array.isArray(data.info) ? data.info[0] : data.info) : data);
    if (!item) return [];

    const translations = Array.isArray(item.translations) ? item.translations : [];
    const tracks = [];
    const languages = [
      { code: "ar", lang: "ara", label: "Arabic", path: item.arTranslationFilePath, filename: item.arTranslationFile },
      { code: "en", lang: "eng", label: "English", path: item.enTranslationFilePath, filename: item.enTranslationFile },
      { code: "sp", lang: "spa", label: "Spanish", path: item.spTranslationFilePath, filename: item.spTranslationFile }
    ];

    for (const language of languages) {
      const candidates = translations.filter(track => {
        const type = String(track.type || "").toLowerCase();
        const name = String(track.name || "").toLowerCase();
        return type === language.code || name === language.label.toLowerCase();
      });
      const preferred = candidates.find(track => String(track.extention || track.extension || "").toLowerCase() === "vtt")
        || candidates.find(track => /^https?:\/\//i.test(String(track.file || "")));
      const url = preferred?.file || language.path;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) {
        tracks.push({ id: `${rawId}-${language.code}`, url, lang: language.lang, label: language.label });
      }
    }
    return tracks;
  })();
  subtitleInfoCache.set(rawId, pending);
  try {
    const tracks = await pending;
    subtitleInfoCache.set(rawId, tracks);
    return tracks;
  } catch (error) {
    subtitleInfoCache.delete(rawId);
    console.warn(`Cinemana subtitles lookup failed for ${rawId}: ${error.message}`);
    return [];
  }
}

builder.defineSubtitlesHandler(async ({ id }) => {
  const rawId = String(id || "").replace(/^cinemana-series:/, "").replace(/^cinemana:/, "");
  if (!numericId(rawId)) return { subtitles: [] };
  const tracks = await getSubtitleTracks(rawId);
  return {
    subtitles: tracks.map(track => ({ id: track.id, url: track.url, lang: track.lang, label: track.label }))
  };
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Cinemana Nuvio addon listening on port ${PORT}`);
