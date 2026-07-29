/**
 * Internal manifest-ingestion security limits.
 *
 * Measured corpus (47 real manifests plus public-authoring, generated, local,
 * archive, and all-family fixtures): 38,167 formatted bytes, depth 13, 846
 * nodes, 11,680 aggregate UTF-8 string bytes, 143 array items, and 702 record
 * entries. These limits leave at least 6.7x headroom on every measured axis.
 */
export const PLUGIN_MANIFEST_INPUT_LIMITS = Object.freeze({
  rawBytes: 256 * 1024,
  nodes: 16_384,
  depth: 32,
  stringBytes: 192 * 1024,
  arrayEntries: 8_192,
  recordEntries: 8_192,
});
