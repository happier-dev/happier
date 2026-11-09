import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginAccountAdministrationActionInputSchemas as inputs } from '@happier-dev/protocol/actions/pluginAccountAdministrationActionFamily';
import { createPluginAccountReleaseAdministration } from '@/components/settings/plugins/pluginAccountReleaseSelectionController';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Account lifetime and Availability remain authoritative. Action input never
 * supplies a reader, release facts, preparation callbacks or artifact bytes. */
export function createPluginAccountAdministrationActionDeps(account: Pick<LazyActionAccountContext,
    'serverId' | 'accountId' | 'accountLifetime' | 'assertCurrent'>,
    intentIsCurrent: () => boolean = () => true,
    readProjection?: () => PluginProjectionV2 | null,
): Pick<ActionExecutorDeps, 'pluginAccountAdministrationAction'> {
    return { pluginAccountAdministrationAction: async ({ actionId, input, context }) => {
        account.assertCurrent();
        context.signal?.throwIfAborted();
        const scope = getActiveServerAccountScope();
        const current = () => scope !== null && account.accountLifetime.isCurrent() && !context.signal?.aborted
            && intentIsCurrent() && scope.accountId === account.accountId
            && areServerProfileIdentifiersEquivalent(scope.serverId, account.serverId)
            && areServerAccountScopesEqual(scope, getActiveServerAccountScope());
        const unavailable = () => actionId === 'plugins.account.release.select'
            ? { kind: 'unavailable' as const, code: 'target_release_unavailable' as const }
            : { kind: 'unavailable' as const };
        if (!scope || !current()) return unavailable();
        const lifetime = { ...account.accountLifetime, isCurrent: current };
        const controller = createPluginAccountReleaseAdministration({ captureLifetime: () => lifetime });
        const retire = () => controller.retire();
        context.signal?.addEventListener('abort', retire, { once: true });
        try {
            const reader = readPluginAccountAvailability(scope);
            if (!current()) return unavailable();
            switch (actionId) {
                case 'plugins.account.release.select': {
                    const parsed = inputs[actionId].parse(input);
                    const daemon = parsed.daemon;
                    const loaded = !readProjection && daemon?.machineId && daemon.serverId
                        && areServerProfileIdentifiersEquivalent(daemon.serverId, account.serverId)
                        ? await loadDaemonMergedProjectionCacheEntry({ machineId: daemon.machineId,
                            serverId: account.serverId, accountLifetime: lifetime, reuseFreshReady: true, signal: context.signal,
                            // Release execution matches the plugin UI bundle entries only.
                            sections: ['familiesById.pluginUi'] }) : null;
                    if (!current()) return unavailable();
                    return await controller.select({ ...parsed, reader,
                        projection: readProjection ? readProjection() : loaded?.kind === 'ready' ? loaded.inputs.pluginProjectionV2 : null,
                        daemon: parsed.daemon ?? { serverId: null, serverIdentityId: null, machineId: null }, isCurrent: current });
                }
                case 'plugins.account.hosting.set':
                    return await controller.setHostedArtifactsEnabled({ ...inputs[actionId].parse(input), reader });
                case 'plugins.account.hosting.remove':
                    return await controller.disableAndRemoveHostedArtifacts({ ...inputs[actionId].parse(input), reader });
                case 'plugins.account.cache.clear':
                    return await controller.clearHostedArtifactCache({ ...inputs[actionId].parse(input), reader });
            }
        } finally {
            context.signal?.removeEventListener('abort', retire);
            controller.retire();
        }
    } };
}
