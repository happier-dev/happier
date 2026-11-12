import { loadEntryGraph } from './entry-load.mjs';
import { BUNDLED_MANIFEST_GRAPH } from './entry-graphs.mjs';
export { BUNDLED_MANIFEST_GRAPH } from './entry-graphs.mjs';

export async function loadBundledManifestContracts({ repoDir, signal, env = process.env }) {
  return await loadEntryGraph(BUNDLED_MANIFEST_GRAPH, { repoDir, signal, env });
}
