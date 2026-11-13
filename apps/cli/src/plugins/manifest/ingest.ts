import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import type { PluginManifestIngestionDiagnostic } from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from './types';
import { normalizeParsedPluginManifestV2 } from './normalize';
import { assertPluginManifestSettingsValid, readPluginManifestSettingsErrors } from '@/plugins/settings/manifestSettings';
import { notificationChannelSettingsContributionId } from '@/plugins/settings/notificationChannelSettings';
import { PluginLocalSettingsDeclarationError } from '@/plugins/settings/localSettingsContributions';
import { PluginSettingsProjectionError } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
  validatePluginManifest,
  type PluginManifestValidationDiagnostic,
  type PluginManifestValidationOptions,
} from './validate';

export type CanonicalPluginManifestIngestionDiagnostic = Omit<PluginManifestIngestionDiagnostic, 'code'>
  & Pick<PluginManifestValidationDiagnostic, 'safeCompatibilityMessage'> & Readonly<{
    code: PluginManifestIngestionDiagnostic['code'] | PluginLocalSettingsDeclarationError['code'] | PluginSettingsProjectionError['code'] | 'plugin_manifest_engine_incompatible';
    pluginId?: string;
    contributionId?: string;
    fieldId?: string;
  }>;

/** One ingestion diagnostic for a settings declaration failure; never carries the error's free-form reason. */
export function projectPluginSettingsDeclarationDiagnostic(
  error: PluginLocalSettingsDeclarationError | PluginSettingsProjectionError,
): CanonicalPluginManifestIngestionDiagnostic {
  return { code: error.code, message: error.message,
    pluginId: error.pluginId, contributionId: error.contributionId,
    ...(error.fieldId ? { fieldId: error.fieldId } : {}),
  };
}

export type CanonicalPluginManifestIngestionResult =
  | Readonly<{ ok: true; manifest: CanonicalPluginManifest; diagnostics?: readonly CanonicalPluginManifestIngestionDiagnostic[] }>
  | Readonly<{ ok: false; manifest?: CanonicalPluginManifest; diagnostics: readonly CanonicalPluginManifestIngestionDiagnostic[] }>;

export type PluginManifestReadPurpose = 'admission' | 'installedRead' | 'authoring';

type CanonicalPluginManifestIngestionOptions =
  Pick<PluginManifestValidationOptions, 'manifestAuthority' | 'sourceProvenance' | 'registryPackageName' | 'enforceEngineCompatibility'>
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
  const load = options.purpose === 'admission' || options.purpose === 'installedRead';
  const ingestion = ingestPluginManifestV2(input, { mode: load ? 'load' : 'author' });
  if (!ingestion.ok) return ingestion;
  let manifest = ingestion.manifest;
  const diagnostics: CanonicalPluginManifestIngestionDiagnostic[] = [...(ingestion.diagnostics ?? [])];
  if (load) {
    const errors = readPluginManifestSettingsErrors(manifest);
    if (errors.length) {
      const invalid = new Set(errors.map(error => error.contributionId));
      for (const error of errors) diagnostics.push({ code: 'plugin_contribution_skipped',
        pluginId: error.pluginId, contributionId: manifest.contributes.notificationChannels.find(channel => (
          notificationChannelSettingsContributionId(channel.id) === error.contributionId
        ))?.id ?? error.contributionId,
        message: 'Contribution skipped because its Settings declaration is invalid.',
        ...(error.fieldId ? { fieldId: error.fieldId } : {}) });
      const settled = ingestPluginManifestV2({ ...manifest, contributes: { ...manifest.contributes,
        settings: manifest.contributes.settings.filter(group => !invalid.has(group.id)),
        notificationChannels: manifest.contributes.notificationChannels.filter(channel => (
          !invalid.has(notificationChannelSettingsContributionId(channel.id))
        )),
      } }, { mode: 'load' });
      if (!settled.ok) return settled;
      manifest = settled.manifest;
      diagnostics.push(...(settled.diagnostics ?? []));
    }
  }
  const validation = validatePluginManifest(manifest, {
    ...options,
    // Host admission cannot be opted out by an author-time caller option.
    enforceEngineCompatibility: load ? true : options.purpose === 'authoring' ? false : options.enforceEngineCompatibility,
    parsedManifest: manifest,
  });
  if (!validation.ok) {
    return {
      ok: false,
      manifest,
      diagnostics: validation.diagnostics.map((diagnostic) => ({
        code: diagnostic.code === 'plugin_manifest_engine_incompatible' ? diagnostic.code : 'plugin_manifest_invalid',
        message: diagnostic.message,
        ...(diagnostic.safeCompatibilityMessage === undefined
          ? {}
          : { safeCompatibilityMessage: diagnostic.safeCompatibilityMessage }),
      })),
    };
  }
  if (load) return { ok: true, manifest: validation.manifest,
    ...(diagnostics.length ? { diagnostics } : {}) };
  try {
    assertPluginManifestSettingsValid(validation.manifest);
  } catch (error) {
    if (!(error instanceof PluginLocalSettingsDeclarationError) && !(error instanceof PluginSettingsProjectionError)) throw error;
    return { ok: false, diagnostics: [projectPluginSettingsDeclarationDiagnostic(error)] };
  }
  return { ok: true, manifest: validation.manifest,
    ...(diagnostics.length ? { diagnostics } : {}) };
}
