import type { PluginStateRecord } from '@/plugins/store/state';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

/** Installed state cannot claim the host's bundled provenance. */
export function readInstalledPluginSourceDiagnostic(record: PluginStateRecord): PluginCompatibilityDiagnostic | null {
  const approvalFailure = record.compatibility.diagnostics.find(diagnostic => diagnostic.code === 'plugin_trust_approval_required');
  if (approvalFailure) return approvalFailure;
  if (record.source.kind === 'bundled') {
    return {
      code: 'plugin_source_kind_unsupported',
      message: `Plugin state source kind 'bundled' is host-derived bundled provenance and cannot be claimed by installed plugin state`,
    };
  }
  if (record.install.mode !== 'managed_install' && record.source.kind !== 'path') {
    return {
      code: 'plugin_source_kind_unsupported',
      message: `Plugin state source kind '${record.source.kind}' is unsupported for non-managed installs; expected 'path'`,
    };
  }
  return null;
}
