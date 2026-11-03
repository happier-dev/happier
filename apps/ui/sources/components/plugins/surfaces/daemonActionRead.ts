import type { MachinePluginStructuredMessageActionResult } from '@/sync/ops/machineContributionRegistryProjection';
import { buildMachinePluginActionExecuteRequest, isMachinePluginActionScopeCurrent, type MachinePluginActionExecuteOptions } from '@/sync/ops/machinePluginActionRequest';
import { randomUUID } from '@/platform/randomUUID';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createContextualResourceWatchOwner } from './daemonResourceWatch';
import type { DispatchPluginSurfaceActionInput } from './pluginSurfaceActionDispatch';

/** Dependency admission shares the daemon watch lifetime; it never executes the read. */
export async function observeDaemonActionRead(
    machineId: string,
    options: MachinePluginActionExecuteOptions,
    observation: NonNullable<DispatchPluginSurfaceActionInput['readObservation']>,
): Promise<MachinePluginStructuredMessageActionResult> {
    if (!isMachinePluginActionScopeCurrent(options)) return { supported: false, reason: 'error' };
    let request: ReturnType<typeof buildMachinePluginActionExecuteRequest>;
    try { request = buildMachinePluginActionExecuteRequest(machineId, { ...options, requiredReadOnly: true }); }
    catch { return { supported: false, reason: 'error' }; }
    if (request.invocation?.kind !== 'clientPluginAction') return {
        supported: true, result: { ok: false, code: 'plugin_action_read_observation_unavailable' },
    };
    const action = parseQualifiedPluginContributionKey(request.qualifiedActionId);
    if (!action) return { supported: true, result: { ok: false, code: 'plugin_action_not_found' } };
    const subscriptionId = randomUUID();
    let disposed = false;
    const current = () => !disposed && !options.signal?.aborted && options.isCurrent?.() !== false
        && (options.accountLifetime === undefined || options.accountLifetime?.isCurrent() === true);
    const owner = createContextualResourceWatchOwner({ pluginId: action.pluginId,
        resource: { machineId, serverId: options.accountLifetime?.scope.serverId ?? options.serverId,
            ...(options.accountLifetime ? { accountId: options.accountLifetime.scope.accountId } : {}),
            expectedCallerOccurrenceId: request.expectedContributorOccurrenceId,
            ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }) },
        isCurrent: current,
    });
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        options.signal?.removeEventListener('abort', dispose);
        owner.dispose();
    };
    options.signal?.addEventListener('abort', dispose, { once: true });
    try {
        const opened = await owner.open({ subscriptionId, resourceId: action.localId,
            actionRead: { request, invalidate: () => { if (current()) observation.invalidate(); } },
            signal: options.signal,
            deliver: () => { if (current()) observation.retire?.(); dispose(); },
        });
        if (!opened.ok || !current()) {
            dispose();
            return { supported: true, result: { ok: false,
                code: opened.ok ? 'plugin_action_generation_retired' : opened.reason } };
        }
        observation.accept({ dispose });
        return { supported: true, result: { ok: true, result: null } };
    } catch {
        dispose();
        return { supported: false, reason: 'error' };
    }
}
