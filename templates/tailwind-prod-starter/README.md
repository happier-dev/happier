# Tailwind Production Starter

A minimal, production-ready React + TypeScript starter with Tailwind CSS, Vite, and essential tooling.

## Features
- React + TypeScript
- Tailwind CSS with PostCSS
- Vite dev/build server
- ESLint + Prettier + Husky + lint-staged
- Vitest for testing
- Simple project structure suitable for production apps

## Getting started
1. Copy this template into your repo or install via your preferred bootstrap method.
2. Install dependencies:
   - npm: `npm install`
   - or yarn: `yarn install`
3. Start the dev server: `npm run dev` or `yarn dev`
4. Build for production: `npm run build` or `yarn build`
5. Preview the production build: `npm run preview` or `yarn preview`

## Production notes
- Tailwind is configured via `tailwind.config.js` and `postcss.config.js`.
- ESLint/Prettier are wired with `lint-staged` and `husky` for pre-commit checks.
- TS strict mode is enabled in `tsconfig.json`.

## Customization
- Update `src/App.tsx` to build your UI.
- Extend `tailwind.config.js` as needed for your design system.
- Add tests under `src/__tests__` and configure Vitest in `vitest.config.ts`.
