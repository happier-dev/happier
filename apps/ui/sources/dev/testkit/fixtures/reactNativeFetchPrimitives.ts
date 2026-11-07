import { createRequire } from 'node:module';

// Resolve the actual platform implementations through their declaring owner,
// rather than relying on undeclared dependencies hoisted into the UI package.
const requireReactNative = createRequire(createRequire(import.meta.url).resolve('react-native/package.json'));

// These CommonJS platform packages are untyped at the require boundary. The
// constructors intentionally retain their native, incomplete web API surface.
export const { AbortController: NativeAbortController, AbortSignal: NativeAbortSignal } = requireReactNative('abort-controller') as {
    AbortController: typeof AbortController;
    AbortSignal: typeof AbortSignal;
};
export const { Response: NativeResponse } = requireReactNative('whatwg-fetch') as { Response: typeof Response };
