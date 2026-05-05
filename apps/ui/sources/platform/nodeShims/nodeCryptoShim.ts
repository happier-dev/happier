/**
 * Empty stub for `node:crypto` imports.
 *
 * Some `*.node.ts` test-only platform variants (e.g. cryptoRandom.node.ts)
 * import `node:crypto` for vitest. Metro scans those files during haste-map
 * build and tries to resolve `node:crypto` as a real path, which fails with
 * "Failed to get the SHA-1 for: node:crypto" and breaks the bundle.
 *
 * RN/Expo runtime paths never call into Node's crypto — they use expo-crypto
 * via the non-`.node.ts` siblings. So an empty default export is sufficient
 * to keep the resolver happy while never executing any real Node code.
 */
export default {};
