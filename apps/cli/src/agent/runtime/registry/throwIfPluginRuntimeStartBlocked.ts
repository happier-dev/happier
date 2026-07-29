import type { EngineAdapterResolution } from './engineRegistryTypes';

export function throwIfPluginRuntimeStartBlocked(resolution: EngineAdapterResolution): void {
  if (resolution.provenance !== 'external') {
    return;
  }

  const blockingDiagnostic = (resolution.diagnostics ?? []).find((diagnostic) =>
    (
      diagnostic.code === 'engine_plugin_daemon_module_load_failed'
      || diagnostic.code === 'engine_plugin_registry_diagnostic'
    )
    && (
      diagnostic.detailCode === 'plugin_trust_approval_required'
      || diagnostic.detailCode === 'plugin_untrusted'
    ));
  if (!blockingDiagnostic) {
    return;
  }

  if (blockingDiagnostic.detailCode === 'plugin_trust_approval_required') {
    throw new Error('Plugin trust approval is required before this backend can run.');
  }
  if (blockingDiagnostic.detailCode === 'plugin_untrusted') {
    throw new Error('Refusing to load executable plugin daemon entry from an untrusted source.');
  }

  throw new Error(blockingDiagnostic.message);
}
