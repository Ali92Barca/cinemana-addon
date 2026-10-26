Cinemana + TMDB + subtitles — configurable Render deployment

This package adds the standard Stremio addon configuration page. The user enters their TMDB API key on /configure; the key is passed as addon configuration and is not hardcoded in server.js.

Deploy to Render using a PRIVATE GitHub repository:
- Upload server.js and package.json to the repository root.
- Render > New > Web Service > connect repository.
- Build command: npm install
- Start command: npm start
- Instance type: Free
- Do not add TMDB_API_KEY as an environment variable if you want each user to enter their own key on the Configure page. (You may set it as a private fallback for your own instance.)

After deployment, open https://YOUR-SERVICE.onrender.com/configure, enter your TMDB API key and save/configure. Install the resulting configured manifest URL in Nuvio if Nuvio supports standard Stremio addon configuration URLs. You can also test https://YOUR-SERVICE.onrender.com/manifest.json.

Security: configured manifest URLs can contain encoded user configuration. Do not share your configured manifest URL with other people. Use a private GitHub repository and never commit API keys. Since the API key was previously pasted into chat and hardcoded in earlier versions, consider regenerating it in TMDB before deployment.

Free Render instances sleep after inactivity; the first request after sleeping may be slow. This package was syntax-checked locally, but live deployment and Nuvio configuration must be verified after publishing.
