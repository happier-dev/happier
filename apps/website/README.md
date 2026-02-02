# Happier Website

Static marketing website for the Happier project.

## Tech Stack

- **Vite** - Fast build tool and dev server
- **Tailwind CSS** - Utility-first CSS framework
- **Vanilla JS** - No framework overhead

## Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Preview production build
pnpm preview
```

## Pre-release vs Release

This website currently supports two homepage variants:

- `index.prerelease.html` — pre-release notice + links (Discord/GitHub/Discussions)
- `index.release.html` — full “Get Started” / install-focused marketing page

`index.html` is the active entry file used by Vite.

To switch locally:

```bash
cp index.prerelease.html index.html
# or
cp index.release.html index.html
```

Docker/Doc Ploy wiring (planned):
we can later add a build-time switch (e.g. `WEBSITE_VARIANT=prerelease|release`) that copies the chosen variant to `index.html` before `vite build`, without having to edit files manually.

## Features

- Dark/Light mode with system preference detection
- Responsive design for all screen sizes
- Accessible keyboard navigation
- Smooth scroll animations
- Copy-to-clipboard functionality

## Structure

```
website/
├── public/
│   └── images/          # Static images (logos, favicon)
├── src/
│   ├── styles.css       # Tailwind + custom styles
│   └── main.js          # Theme toggle, interactions
├── index.html           # Main HTML page
├── package.json
├── tailwind.config.js
├── postcss.config.js
└── vite.config.js
```

## Deployment

The `dist/` folder after `pnpm build` can be deployed to any static hosting:
- Vercel
- Netlify
- GitHub Pages
- Cloudflare Pages

## License

MIT - See root LICENSE file
