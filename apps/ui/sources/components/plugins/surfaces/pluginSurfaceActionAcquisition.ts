import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { createPluginUiProjectedActionResolver, isPluginProjectedActionExecutable,
    type PluginUiActionProjection } from '@/sync/domains/plugins/ui/projection';
import { mergeInstalledPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import type { DispatchPluginSurfaceActionInput, PluginSurfaceContributedActionBinding } from './pluginSurfaceActionDispatch';
import { createPluginSurfaceActionFailure as failure } from './actionFailure';

/** Resolve only the addressed declaration under the caller's existing admission. */
export function resolveProjectedContributedAction(input: DispatchPluginSurfaceActionInput,
    identity: PluginContributionIdentityV1): PluginUiActionProjection | null {
    try {
        const action = input.resolveContributedAction?.(identity) ?? null;
        return isPluginProjectedActionExecutable(action) && action.pluginId === identity.pluginId
            && action.id === identity.localId && (input.expectedContributorOccurrenceId === undefined
                || action.occurrenceId === input.expectedContributorOccurrenceId) ? action : null;
    } catch { return null; }
}

/** A targeted mount may omit a callee; its realm's owner supplies it. */
export async function acquirePluginSurfaceContributedAction(input: DispatchPluginSurfaceActionInput,
    identity: PluginContributionIdentityV1, machine?: PluginSurfaceContributedActionBinding,
    accountLifetime = input.actionAccountLifetime ?? machine?.accountLifetime,
): Promise<DispatchPluginSurfaceActionInput | ReturnType<typeof failure> | null> {
    if (accountLifetime) {
        const availability = readPluginAccountAvailability(accountLifetime.scope);
        await availability.ensureCurrentAccountExecution(identity.pluginId);
        const account = availability.readAccountUiProjection();
        const resolveAccount = createPluginUiProjectedActionResolver(account?.actionsById);
        if (resolveAccount(identity)?.hostAccountOrigin) {
            const acquired = { ...input,
                pluginUiProjection: mergeInstalledPluginUiProjections(account ? [account] : [], input.pluginUiProjection ?? null),
                resolveContributedAction: (candidate: PluginContributionIdentityV1) => candidate.pluginId === identity.pluginId
                    && candidate.localId === identity.localId ? resolveAccount(candidate) : input.resolveContributedAction?.(candidate) ?? null,
            };
            return resolveProjectedContributedAction(acquired, identity) ? acquired
                : failure('unavailable', 'plugin_surface_action_projection_unavailable', { retryable: false });
        }
    }
    if (!machine) return null;
    // An answer held at the current projection revision is the current Action
    // projection: the revision advances on every registry change, daemon
    // replacement and stale-dispatch refusal, and the daemon still fences each
    // execute by its expected occurrence. Re-describing per operation only
    // repeated an equal answer (one round trip before every operation).
    const loaded = await loadDaemonMergedProjectionCacheEntry({ machineId: machine.machineId, serverId: machine.serverId,
        accountLifetime, signal: input.signal, sections: ['actionsById'], reuseFreshReady: true });
    const unavailable = () => failure('unavailable', 'plugin_surface_action_projection_unavailable', { retryable: false });
    if (loaded?.kind === 'unsupported' || (loaded?.kind === 'error' && loaded.retryAtMs === null)) return unavailable();
    if (loaded?.kind !== 'ready') return null;
    if (!loaded.inputs.pluginUiProjection) return unavailable();
    const projection = mergeInstalledPluginUiProjections(input.pluginUiProjection ? [input.pluginUiProjection] : [], loaded.inputs.pluginUiProjection);
    if (!projection) return unavailable();
    const resolveMachine = createPluginUiProjectedActionResolver(loaded.inputs.pluginUiProjection.actionsById);
    const resolveMerged = createPluginUiProjectedActionResolver(projection.actionsById);
    const acquired = { ...input, pluginUiProjection: projection,
        resolveContributedAction: (candidate: PluginContributionIdentityV1) => candidate.pluginId === identity.pluginId
            && candidate.localId === identity.localId ? resolveMachine(candidate) : resolveMerged(candidate) };
    return resolveProjectedContributedAction(acquired, identity) ? acquired : unavailable();
}
