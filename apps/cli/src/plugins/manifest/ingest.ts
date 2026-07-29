import {
  ingestPluginManifestV2,
  type PluginManifestIngestionDiagnostic,
} from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from './types';
import { validatePluginManifest, type PluginManifestValidationOptions } from './validate';

export type CanonicalPluginManifestIngestionResult =
  | Readonly<{ ok: true; manifest: CanonicalPluginManifest }>
  | Readonly<{ ok: false; diagnostics: readonly PluginManifestIngestionDiagnostic[] }>;

export function ingestCanonicalPluginManifest(
  input: unknown,
  options: Pick<PluginManifestValidationOptions, 'manifestAuthority' | 'enforceEngineCompatibility'> = {},
): CanonicalPluginManifestIngestionResult {
  const ingestion = ingestPluginManifestV2(input);
  if (!ingestion.ok) return ingestion;
  const validation = validatePluginManifest(ingestion.manifest, {
    ...options,
    parsedManifest: ingestion.manifest,
  });
  if (!validation.ok) {
    return {
      ok: false,
      diagnostics: validation.diagnostics.map((diagnostic) => ({
        code: 'plugin_manifest_invalid',
        message: diagnostic.message,
      })),
    };
  }
  return { ok: true, manifest: validation.manifest };
}
