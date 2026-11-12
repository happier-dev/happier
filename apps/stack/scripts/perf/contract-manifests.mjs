import { loadEntryGraph } from './entry-load.mjs';

export const BUNDLED_MANIFEST_GRAPH = Object.freeze({
  id: 'bundled-plugin-manifests',
  entry: 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts',
  cwd: '.',
  conditions: ['happier-source'],
  args: ['--root', '.', '--mode', 'check', '--daemon-projections'],
});

export async function loadBundledManifestContracts({ repoDir, signal, env = process.env }) {
  const result = await loadEntryGraph(BUNDLED_MANIFEST_GRAPH, { repoDir, signal, env });
  // Generator drift errors include actual/expected declaration bytes. Keep
  // their owner and error identity, never return those bytes to publishers.
  const output = result.loadError?.message.match(/(?:generated output differs|missing generated output): (.+?)(?: at byte \d+|$)/)?.[1];
  return { ...result, ...(output ? { firstFailingModule: output } : {}),
    loadError: result.loadError ? { ...result.loadError, message: '' } : null };
}
