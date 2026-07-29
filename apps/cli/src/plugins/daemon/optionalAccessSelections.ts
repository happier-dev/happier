import type { PluginManifestHostAccessV2 } from '@happier-dev/protocol';

import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';

import type { PluginResourceSelection } from './changeContract';

export function createSelectedPluginOptionalAccess(params: Readonly<{
  pluginId: string;
  declarations: PluginManifestHostAccessV2['optional'];
  decisions: readonly PluginResourceSelection[];
  selectedAtMs: number;
}>) {
  const declarations = new Map(params.declarations.map((request) => [request.id, request]));
  const seen = new Set<string>();
  const registry = createDefaultPluginAccessScopeRegistry();

  return Object.freeze(params.decisions.flatMap((decision) => {
    if (seen.has(decision.accessId)) throw new Error(`Duplicate optional access decision '${decision.accessId}'`);
    seen.add(decision.accessId);
    const declaration = declarations.get(decision.accessId);
    if (!declaration) throw new Error(`Unknown optional access decision '${decision.accessId}'`);
    if (!decision.selected) return [];
    return [registry.createSelection({
      pluginId: params.pluginId,
      accessId: declaration.id,
      capability: declaration.capability,
      scope: declaration.scope,
      selectedAtMs: params.selectedAtMs,
    })];
  }));
}
