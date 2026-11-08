import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import { resolvePluginManifestSetReferencesV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { logger } from '@/ui/logger';
import { projectPluginFailureText } from '../lifecycle/utils';
import { collectBlockingPluginReloadDiagnostics } from './diagnostics';

function normalizePluginIds(pluginIds: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(pluginIds.map((pluginId) => pluginId.trim()).filter(Boolean))].sort());
}

/**
 * Activates the exact executable contributions whose readiness must be proven
 * before their registry can become serving. Callers retain ownership of the
 * surrounding candidate/restart lifecycle and cleanup.
 */
export async function activatePluginRuntimeForReadiness(params: Readonly<{
  registry: ResolvedExecutablePluginRuntimeRegistry;
  pluginIds: readonly string[];
}>): Promise<void> {
  const pluginIds = normalizePluginIds(params.pluginIds);
  if (pluginIds.length === 0) return;
  await params.registry.activatePluginsForValidation(pluginIds);
}

/** One exclusion decision for cold startup, candidate preparation and adoption. */
export async function settlePluginRuntimeReadiness(
  registry: ResolvedExecutablePluginRuntimeRegistry,
): Promise<readonly string[]> {
  const blocking = collectBlockingPluginReloadDiagnostics(registry, Object.keys(registry.pluginDiagnosticsByPluginId));
  if (blocking.length === 0) return [];
  const blockingPlugins = blocking.map(({ pluginId, diagnostics }) => ({
    pluginId, codes: [...new Set(diagnostics.map(diagnostic => diagnostic.code))],
  }));
  const excluded = new Map<string, PluginCompatibilityDiagnostic>(blocking.map(({ pluginId, diagnostics }) => [pluginId, diagnostics[0]!]));
  const blockingPluginIds = new Set(excluded.keys());
  // References, including host-access references, belong to the manifest owner.
  // Ask it only about edges to excluded plugins so an unrelated declaration
  // diagnostic cannot become a new runtime exclusion.
  const manifests = new Map([
    ...(registry.contributes.pluginDeclarations ?? []).map(declaration => [declaration.pluginId, declaration.manifest] as const),
    ...registry.contributes.activationTargets.map(target => [target.pluginId, target.manifest] as const),
  ]);
  while (true) {
    const resolution = resolvePluginManifestSetReferencesV2(
      [...manifests.values()].filter(manifest => !excluded.has(manifest.id)), new Set(excluded.keys()),
    );
    if (resolution.ok) break;
    const dependents = resolution.diagnostics.filter(diagnostic => !excluded.has(diagnostic.pluginId));
    if (dependents.length === 0) break;
    for (const diagnostic of dependents) {
      excluded.set(diagnostic.pluginId, {
        // Removing the unavailable target makes this manifest's reference
        // inadmissible. Reuse the admission exclusion consumed by every catalog
        // surface, including plugins without a daemon activation fact.
        code: 'plugin_manifest_invalid',
        stage: 'normalization',
        message: `Plugin '${diagnostic.pluginId}' depends on unavailable plugin contributions: ${diagnostic.message}`,
        details: { blockingPlugins },
      });
    }
  }
  logger.warn('[PLUGIN RUNTIME] Isolated unavailable plugins before registry publication', {
    blockingPlugins, excludedPluginIds: [...excluded.keys()],
  });
  for (const [pluginId, diagnostic] of excluded) {
    if (!registry.activatedPluginIds.has(pluginId) && blockingPluginIds.has(pluginId)) continue;
    try {
      await registry.recordPluginActivationFailure(pluginId, diagnostic);
    } catch (error) {
      // The activation owner records unavailability synchronously before
      // retiring consumers. A failed optional cleanup must not withdraw peers.
      logger.warn('[PLUGIN RUNTIME] Unavailable plugin cleanup failed', {
        pluginId, code: diagnostic.code, error: projectPluginFailureText(error),
      });
    }
  }
  return Object.freeze([...excluded.keys()]);
}
