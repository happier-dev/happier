// Web bundle stub for @huggingface/transformers.
//
// The real package currently emits `import.meta` references that Metro's web export
// output executes as a classic script (not an ESM module), causing a hard runtime
// syntax error in browsers.
//
// This stub keeps the UI runnable on web. Any feature that depends on Transformers.js
// must be gated to supported platforms and/or implemented with a web-compatible bundle.

export const env: Record<string, unknown> = {};

export default {
  env,
};

