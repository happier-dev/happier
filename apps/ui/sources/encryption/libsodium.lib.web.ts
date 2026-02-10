import type sodiumType from 'libsodium-wrappers';

// IMPORTANT:
// Metro web bundles are currently executed as classic scripts (not ESM modules).
// Importing `libsodium-wrappers` via its package `exports.import` path pulls in ESM
// builds which (via Expo's Node builtin polyfills) can introduce top-level `await`,
// causing a hard syntax error and a blank page in the web dev server.
//
// Force the CommonJS build on web to avoid top-level-await parsing errors.
// Use require() so TypeScript doesn't need to resolve the deep subpath (monorepo installs
// typically hoist `node_modules` to the workspace root).
// eslint-disable-next-line @typescript-eslint/no-var-requires
//
// Note: `libsodium-wrappers` now exposes only "." in its package `exports`. Importing the
// deep dist/modules path can throw ERR_PACKAGE_PATH_NOT_EXPORTED on modern Node runtimes.
// Requiring the package root still selects the CommonJS build under the "require" condition.
const sodium = require('libsodium-wrappers');

export default sodium as typeof sodiumType;
