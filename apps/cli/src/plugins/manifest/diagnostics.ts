import type { CanonicalPluginManifestIngestionDiagnostic } from './ingest';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { projectPluginFailureMessage } from '@happier-dev/protocol/plugins/failureProjection';

/** Only host-attributed diagnostics may replace a generic acquisition/staging refusal. */
export function projectPluginAttributedCompatibilityFailure(
  diagnostics: readonly PluginCompatibilityDiagnostic[] | undefined,
): Readonly<{ code: string; message: string }> | undefined {
  const diagnostic = diagnostics?.find(entry => entry.contribution);
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
  if (diagnostic.code === 'plugin_contribution_skipped') {
    return {
      code: diagnostic.code,
      stage: 'normalization',
      message: 'A plugin contribution was skipped because its declaration is unknown, invalid, or references an unavailable contribution.',
      ...(attributed ? { contribution: { pluginId: diagnostic.pluginId!, localId: diagnostic.contributionId! } } : {}),
      details: { ...(diagnostic.path ? { path: [...diagnostic.path] } : {}),
        ...(diagnostic.reason ? { reason: diagnostic.reason } : {}) },
    };
  }

  return {
    code: 'plugin_manifest_invalid',
    message: projectPluginFailureMessage(attributed
      ? `Plugin '${diagnostic.pluginId}' Settings '${diagnostic.contributionId}'${diagnostic.fieldId ? ` field '${diagnostic.fieldId}'` : ''}: ${diagnostic.code}`
      : diagnostic.safeCompatibilityMessage ?? `Plugin manifest compatibility check failed: ${diagnostic.code}.`),
    ...(attributed ? {
      contribution: { pluginId: diagnostic.pluginId!, localId: diagnostic.contributionId! },
      details: { code: diagnostic.code, ...(diagnostic.fieldId ? { fieldId: diagnostic.fieldId } : {}) },
    } : {}),
  };
}
