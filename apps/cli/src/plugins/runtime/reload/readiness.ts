import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';

import { hasBlockingPluginReloadDiagnostic } from './controller';

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
  if (!params.registry.activatePluginsForValidation) {
    throw new Error('Prepared plugin runtime registry cannot activate plugins for readiness');
  }
  await params.registry.activatePluginsForValidation(pluginIds);
}

/** Rejects a readiness candidate before it can become desired or serving. */
export function assertPluginRuntimeReadiness(params: Readonly<{
  registry: ResolvedExecutablePluginRuntimeRegistry;
  executablePluginIds: readonly string[];
}>): void {
  const executablePluginIds = normalizePluginIds(params.executablePluginIds);
  if (
    executablePluginIds.length === 0
    || !hasBlockingPluginReloadDiagnostic(params.registry, executablePluginIds)
  ) {
    return;
  }
  const diagnostic = executablePluginIds
    .flatMap((pluginId) => params.registry.pluginDiagnosticsByPluginId[pluginId] ?? [])
    .at(0);
  throw new Error(diagnostic?.message ?? 'Prepared plugin runtime registration graph is invalid');
}

/**
 * Constructs required primary Agent runtimes under the registry-owned
 * retirement signal. This is readiness construction only; it does not admit
 * Session/provider/action/background business work.
 */
export async function bootstrapPrimaryAgentRuntimesForReadiness(params: Readonly<{
  registry: ResolvedExecutablePluginRuntimeRegistry;
  pluginIds: readonly string[];
}>): Promise<void> {
  const pluginIds = new Set(normalizePluginIds(params.pluginIds));
  if (pluginIds.size === 0) return;
  const registrations = [...params.registry.agentRuntimesByAgentId.values()]
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  for (const registration of registrations) {
    if (!pluginIds.has(registration.pluginId) || !registration.hasPrimaryRuntime) continue;
    await registration.createRuntime({ signal: registration.retirementSignal });
  }
}
