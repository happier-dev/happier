// Node/Vitest and unknown targets use the native-safe fail-closed owner.
// Metro selects `.web.ts` or `.native.ts` for production platform bundles.
export { resolveDefaultReactNativeLoaderBackend } from './resolveDefaultReactNativeLoaderBackend.native';
