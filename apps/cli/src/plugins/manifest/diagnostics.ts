import { projectPluginSettingsDeclarationDiagnostic, type CanonicalPluginManifestIngestionDiagnostic } from './ingest';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { projectPluginFailureMessage } from '@happier-dev/protocol/plugins/failureProjection';
import { PluginLocalSettingsDeclarationError } from '@/plugins/settings/localSettingsContributions';
import { PluginSettingsProjectionError } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

/** Only host-attributed diagnostics may replace a generic acquisition/staging refusal. */
export function projectPluginAttributedCompatibilityFailure(
  diagnostics: readonly PluginCompatibilityDiagnostic[] | Error | undefined,
): Readonly<{ code: string; message: string }> | undefined {
  const diagnostic = diagnostics instanceof Error
    ? diagnostics instanceof PluginLocalSettingsDeclarationError || diagnostics instanceof PluginSettingsProjectionError
      ? projectPluginManifestCompatibilityDiagnostic(projectPluginSettingsDeclarationDiagnostic(diagnostics))
      : undefined
    : diagnostics?.find(entry => entry.code === 'plugin_manifest_engine_incompatible' || entry.contribution);
  if (diagnostic?.code === 'plugin_manifest_engine_incompatible') {
    return { code: diagnostic.code, message: diagnostic.message };
  }
  const details = diagnostic?.details;
  if (!diagnostic || !details || typeof details !== 'object' || Array.isArray(details)
    || typeof details.code !== 'string') return undefined;
  return { code: details.code, message: diagnostic.message };
}

/** Safe publication diagnostics contain identities and host codes, never authored values. */
export function projectPluginManifestCompatibilityDiagnostic(
  diagnostic: CanonicalPluginManifestIngestionDiagnostic,
): PluginCompatibilityDiagnostic {
  const attributed = diagnostic.pluginId && diagnostic.contributionId;
  if (diagnostic.code === 'plugin_contribution_skipped' || diagnostic.code === 'plugin_optional_reference_unavailable') {
    return {
      code: diagnostic.code,
      stage: 'normalization',
      message: diagnostic.code === 'plugin_optional_reference_unavailable'
        ? 'An optional connected-account reference is unavailable. The owning contribution remains available.'
        : 'A plugin contribution was skipped because its declaration is unknown, invalid, or references an unavailable contribution.',
      ...(attributed ? { contribution: { pluginId: diagnostic.pluginId!, localId: diagnostic.contributionId! } } : {}),
      details: { ...(diagnostic.path ? { path: [...diagnostic.path] } : {}),
        ...(diagnostic.reason ? { reason: diagnostic.reason } : {}),
        ...(diagnostic.unavailableSource ? { unavailableSource: diagnostic.unavailableSource } : {}) },
    };
  }
  return {
    code: diagnostic.code === 'plugin_manifest_engine_incompatible' ? diagnostic.code : 'plugin_manifest_invalid',
    message: projectPluginFailureMessage(attributed
      ? `Plugin '${diagnostic.pluginId}' Settings '${diagnostic.contributionId}'${diagnostic.fieldId ? ` field '${diagnostic.fieldId}'` : ''}: ${diagnostic.code}`
      : diagnostic.safeCompatibilityMessage ?? `Plugin manifest compatibility check failed: ${diagnostic.code}.`),
    ...(attributed ? {
      contribution: { pluginId: diagnostic.pluginId!, localId: diagnostic.contributionId! },
      details: { code: diagnostic.code, ...(diagnostic.fieldId ? { fieldId: diagnostic.fieldId } : {}) },
    } : {}),
  };
}
