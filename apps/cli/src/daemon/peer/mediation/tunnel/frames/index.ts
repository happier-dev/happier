/**
 * Tunnel frame layer.
 *
 * This barrel preserves the module specifier `./frames` that `registerRoutes.ts`, `relay.ts` and
 * the directory barrel already import, so the 2026-08-23 split of the former 1,498-line
 * `frames.ts` changed no consumer and no behaviour.
 */
export * from './types';
export * from './binaryCodec';
export * from './applicationSubstreamSession';
export * from './substreamMux';
export * from './flowAccounting';
export * from './streamSession';
