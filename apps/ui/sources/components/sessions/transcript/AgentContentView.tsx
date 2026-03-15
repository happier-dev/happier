// Vite/Vitest doesn't resolve RN platform suffixes by default, so keep a stable `.tsx` entrypoint for web/test.
// Metro/Expo resolves `AgentContentView.native.tsx` (ios/android) and `AgentContentView.web.tsx` (web) automatically.
export { AgentContentView } from './AgentContentView.web';
