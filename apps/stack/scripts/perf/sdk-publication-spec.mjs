import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeRuntimeImport } from '../utils/proc/runtimeImportProbe.mjs';

const self = fileURLToPath(import.meta.url);
export const SDK_PUBLICATION_SPEC_GRAPH = Object.freeze({
  id: 'sdk-publication-spec', entry: 'packages/plugin-sdk/scripts/apiSurfaceCli.mjs',
});

export async function loadSdkPublicationSpec({ repoDir, signal, env = process.env }) {
  const result = await probeRuntimeImport({ entrypoint: self,
    args: [join(repoDir, 'packages/plugin-sdk')], cwd: repoDir, signal, env });
  // Publication errors can include source text; publish only the owner and code.
  return { ...result, graph: SDK_PUBLICATION_SPEC_GRAPH.id, entry: SDK_PUBLICATION_SPEC_GRAPH.entry,
    basis: 'current-source', ...(result.status === 'failed' ? {
      firstFailingModule: SDK_PUBLICATION_SPEC_GRAPH.entry,
      loadError: { name: 'SdkPublicationSpecError', code: 'sdk_publication_spec_failed', message: '' },
    } : {}) };
}

if (process.argv[1] === self) {
  try {
    const { readCurrentApiSurfaceInventory } = await import('../../../../packages/plugin-sdk/scripts/apiSurfaceCli.mjs');
    await readCurrentApiSurfaceInventory({ packageRoot: process.argv[2] });
  } catch {
    // The parent owns diagnostics. Never print author source or fixture values.
    process.exitCode = 1;
  }
}
