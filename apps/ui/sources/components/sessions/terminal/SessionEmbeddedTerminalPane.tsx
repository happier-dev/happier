// Vite/Vitest doesn't resolve RN platform suffixes by default, so keep a stable `.tsx` entrypoint for web/test.
// Metro/Expo resolves `SessionEmbeddedTerminalPane.native.tsx` (ios/android) and
// `SessionEmbeddedTerminalPane.web.tsx` (web) automatically.
export { SessionEmbeddedTerminalPane } from './SessionEmbeddedTerminalPane.web';

