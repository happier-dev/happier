import { readFile } from 'node:fs/promises';

import { formatPluginManifestIngestionDiagnostic } from '@happier-dev/protocol';
import { decodePluginManifestUtf8 } from '@happier-dev/protocol/plugins/manifest';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { ingestCanonicalPluginManifest } from './ingest';
import type { PluginSourceProvenance } from './sourceProvenance';
import type { CanonicalPluginManifest } from './types';

export type ReadPluginManifestResult =
  | Readonly<{
      ok: true;
      manifestPath: string;
      manifestRawText: string;
      manifest: CanonicalPluginManifest;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

export async function readPluginManifest(params: Readonly<{
  manifestPath: string;
  manifestAuthority?: 'external' | 'bundled_first_party';
  /** See `PluginManifestValidationOptions.sourceProvenance`. */
  sourceProvenance: PluginSourceProvenance;
  enforceEngineCompatibility?: boolean;
}>): Promise<ReadPluginManifestResult> {
  let manifestRawBytes: Uint8Array;
  try {
    manifestRawBytes = await readFile(params.manifestPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'plugin_manifest_missing',
            message: `Plugin manifest not found at ${params.manifestPath}`,
          },
        ],
      };
    }
    throw error;
  }

  const ingestion = ingestCanonicalPluginManifest(manifestRawBytes, {
    ...(params.manifestAuthority ? { manifestAuthority: params.manifestAuthority } : {}),
    sourceProvenance: params.sourceProvenance,
    ...(params.enforceEngineCompatibility !== undefined
      ? { enforceEngineCompatibility: params.enforceEngineCompatibility }
      : {}),
  });
  if (!ingestion.ok) {
    return {
      ok: false,
      diagnostics: ingestion.diagnostics.map((diagnostic) => ({
        code: 'plugin_manifest_invalid',
        message: `${diagnostic.code}: ${formatPluginManifestIngestionDiagnostic(diagnostic)}`,
      })),
    };
  }

  const manifestRawText = decodePluginManifestUtf8(manifestRawBytes);

  return {
    ok: true,
    manifestPath: params.manifestPath,
    manifestRawText,
    manifest: ingestion.manifest,
  };
}
