import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import type { PluginManifestIngestionDiagnostic } from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from './types';
import { normalizeParsedPluginManifestV2 } from './normalize';
import { assertPluginManifestSettingsValid } from '@/plugins/settings/manifestSettings';
import { PluginLocalSettingsDeclarationError } from '@/plugins/settings/localSettingsContributions';
import { PluginSettingsProjectionError } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
  validatePluginManifest,
  type PluginManifestValidationDiagnostic,
  type PluginManifestValidationOptions,
} from './validate';

export type CanonicalPluginManifestIngestionDiagnostic = Omit<PluginManifestIngestionDiagnostic, 'code'>
  & Pick<PluginManifestValidationDiagnostic, 'safeCompatibilityMessage'> & Readonly<{
    code: PluginManifestIngestionDiagnostic['code'] | PluginLocalSettingsDeclarationError['code'] | PluginSettingsProjectionError['code'];
    pluginId?: string;
    contributionId?: string;
    fieldId?: string;
  }>;

export type CanonicalPluginManifestIngestionResult =
  | Readonly<{ ok: true; manifest: CanonicalPluginManifest; diagnostics?: readonly CanonicalPluginManifestIngestionDiagnostic[] }>
  | Readonly<{ ok: false; diagnostics: readonly CanonicalPluginManifestIngestionDiagnostic[] }>;

export type PluginManifestReadPurpose = 'admission' | 'installedRead';

type CanonicalPluginManifestIngestionOptions =
  Pick<PluginManifestValidationOptions, 'manifestAuthority' | 'sourceProvenance' | 'enforceEngineCompatibility'>
  & Readonly<{ purpose?: PluginManifestReadPurpose }>;

export function ingestCanonicalPluginManifest(
  input: CanonicalPluginManifest,
  options: CanonicalPluginManifestIngestionOptions
    & Readonly<{ admission: 'build'; manifestAuthority: 'bundled_first_party' }>,
): CanonicalPluginManifestIngestionResult;
export function ingestCanonicalPluginManifest(
  input: unknown,
  options: CanonicalPluginManifestIngestionOptions,
): CanonicalPluginManifestIngestionResult;
export function ingestCanonicalPluginManifest(
  input: unknown,
  options: CanonicalPluginManifestIngestionOptions & Readonly<{ admission?: 'build' }>,
): CanonicalPluginManifestIngestionResult {
  // The bundled publisher serialized this owner's admitted shape in the same
  // shipped closure. The typed overload consumes that result without admission.
  if (options.admission === 'build') {
    return { ok: true, manifest: normalizeParsedPluginManifestV2(input as CanonicalPluginManifest) };
  }
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
  // Existing installations retain healthy contributions. Their Settings groups
  // are admitted on demand by the same owner used for new-publication refusal.
  if (options.purpose === 'installedRead') return { ok: true, manifest: validation.manifest };
  try {
    assertPluginManifestSettingsValid(validation.manifest);
  } catch (error) {
    if (!(error instanceof PluginLocalSettingsDeclarationError) && !(error instanceof PluginSettingsProjectionError)) throw error;
    return { ok: false, diagnostics: [{ code: error.code, message: error.message,
      pluginId: error.pluginId, contributionId: error.contributionId,
      ...(error.fieldId ? { fieldId: error.fieldId } : {}),
    }] };
  }
  return { ok: true, manifest: validation.manifest };
}
