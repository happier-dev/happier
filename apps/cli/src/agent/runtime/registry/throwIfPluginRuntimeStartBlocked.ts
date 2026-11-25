import { PluginDiagnosticError } from '@/plugins/runtime/moduleFailure';
import type { EngineAdapterResolution } from './engineRegistryTypes';

export function throwIfPluginRuntimeStartBlocked(resolution: EngineAdapterResolution): void {
  if (resolution.provenance !== 'external') {
    return;
  }

  for (const diagnostic of resolution.diagnostics ?? []) {
    if (diagnostic.code !== 'engine_plugin_daemon_module_load_failed'
      && diagnostic.code !== 'engine_plugin_registry_diagnostic') continue;
    const code = diagnostic.detailCode;
    if (code === 'plugin_trust_approval_required' || code === 'plugin_untrusted') {
      throw new PluginDiagnosticError({ code, message: diagnostic.message, details: diagnostic.details });
    }
  }
}
