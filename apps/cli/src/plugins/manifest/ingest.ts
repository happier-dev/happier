import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import type { PluginManifestIngestionDiagnostic } from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from './types';
import {
  validatePluginManifest,
  type PluginManifestValidationDiagnostic,
  type PluginManifestValidationOptions,
} from './validate';

type CanonicalPluginManifestIngestionDiagnostic = PluginManifestIngestionDiagnostic
  & Pick<PluginManifestValidationDiagnostic, 'safeCompatibilityMessage'>;

export type CanonicalPluginManifestIngestionResult =
  | Readonly<{ ok: true; manifest: CanonicalPluginManifest }>
  | Readonly<{ ok: false; diagnostics: readonly CanonicalPluginManifestIngestionDiagnostic[] }>;

export function ingestCanonicalPluginManifest(
  input: unknown,
  options: Pick<PluginManifestValidationOptions, 'manifestAuthority' | 'sourceProvenance' | 'enforceEngineCompatibility'>,
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
        ...(diagnostic.safeCompatibilityMessage === undefined
          ? {}
          : { safeCompatibilityMessage: diagnostic.safeCompatibilityMessage }),
      })),
    };
  }
  return { ok: true, manifest: validation.manifest };
}
