/**
 * Tunnel frame layer.
 *
 * This barrel preserves the module specifier `./frames` that `registerRoutes.ts`, `relay.ts` and
 * the directory barrel already import, so the 2026-08-23 split of the former 1,498-line
 * `frames.ts` changed no consumer and no behaviour.
 */
export type * from './types.js';
export * from './primitives.js';
export * from './binaryCodec.js';
export * from './applicationSubstreamSession.js';
export * from './substreamMux.js';
export * from './flowAccounting.js';
export * from './streamSession.js';
