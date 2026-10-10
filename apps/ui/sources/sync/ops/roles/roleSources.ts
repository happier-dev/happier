import { PluginRoleDeclarationV1Schema } from '@happier-dev/protocol/plugins/contributions/roles';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveUiAccountActionFallbackMachineId } from '@/sync/ops/actions/accountActionDeps';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** Account role consumers share the same admitted plugin projection source. */
export async function readUiPluginRoleSources(account: LazyActionAccountContext, signal?: AbortSignal) {
  account.assertCurrent();
  signal?.throwIfAborted();
  const machineId = resolveUiAccountActionFallbackMachineId(account);
  if (!machineId) return [];
  const entry = await loadDaemonMergedProjectionCacheEntry({ machineId, serverId: account.serverId,
    accountLifetime: account.accountLifetime, reuseFreshReady: true });
  account.assertCurrent();
  signal?.throwIfAborted();
  // An unavailable serving daemon withdraws plugin sources, never Account documents or built-ins.
  if (entry?.kind !== 'ready') return [];
  const projection = entry.inputs.pluginProjectionV2;
  return Object.values(projection?.familiesById.roles?.entriesById ?? {}).flatMap(source => {
    if (!source.pluginId) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
    const installed = projection?.installedPackagesById[source.pluginId];
    if (!installed?.occurrenceId) return [];
    const { id: localId, ...role } = PluginRoleDeclarationV1Schema.parse(source.definition);
    return [{ pluginId: source.pluginId, pluginDisplayName: installed.displayName, localId, role }];
  });
}
