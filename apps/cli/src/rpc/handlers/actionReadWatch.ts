import { PluginError } from '@happier-dev/plugin-sdk';
import type { DaemonPluginStructuredMessageActionExecuteRequest } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import type { DaemonPluginStructuredMessageActionExecuteResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginUiResourceWatchOwner } from '@/plugins/runtime/invocation/services/uiResourceWatch';
import { observeContributedActionRead } from '@/plugins/runtime/invocation/services/resourceActions';
import type { InvokeContributedAction } from '@/plugins/runtime/invocation/services/actions';

/** The existing watch lifetime carries a dependency observer admitted by the Action ingress. */
export async function openDaemonActionReadWatch(input: Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    machineId: string;
    callerPluginId: string;
    expectedCallerOccurrenceId: string;
    subscriptionId: string;
    actionRead: DaemonPluginStructuredMessageActionExecuteRequest;
    signal?: AbortSignal;
    execute(request: DaemonPluginStructuredMessageActionExecuteRequest, signal: AbortSignal,
        observation: NonNullable<Parameters<InvokeContributedAction>[0]['readObservation']>): Promise<DaemonPluginStructuredMessageActionExecuteResponse>;
}>): ReturnType<PluginUiResourceWatchOwner['open']> {
    const request = input.actionRead;
    const action = input.registry.contributes.actionsById?.get(request.qualifiedActionId);
    if (request.machineId !== input.machineId || !action || action.pluginId !== input.callerPluginId
        || request.expectedContributorOccurrenceId !== input.expectedCallerOccurrenceId
        || request.requiredReadOnly !== true || request.invocation?.kind !== 'clientPluginAction') {
        throw new PluginError({ code: 'plugin_action_read_observation_invalid', message: 'Action read observation binding is invalid' });
    }
    const owner = input.registry.uiResourceWatches;
    if (!owner) throw new PluginError({ code: 'plugin_action_read_observation_unavailable' });
    const closeOnAbort = () => { void owner.close({ callerPluginId: input.callerPluginId, subscriptionId: input.subscriptionId }); };
    input.signal?.addEventListener('abort', closeOnAbort, { once: true });
    try {
        input.signal?.throwIfAborted();
        const opened = await owner.open({ callerPluginId: input.callerPluginId, subscriptionId: input.subscriptionId,
            resourceId: action.definition.id,
            bindRead: (signal, invalidate, retire) => observeContributedActionRead({ signal, invalidate, retire,
                isCurrent: () => !signal.aborted,
                async invoke(observation, currentSignal) {
                    const result = await input.execute(request, currentSignal, observation);
                    return result.ok ? { status: 'executed', value: result.result }
                        : { status: 'unavailable', code: result.code, message: result.message ?? result.code };
                },
            }),
        });
        input.signal?.throwIfAborted();
        return opened;
    } finally {
        // The request owns admission only; the established subscription owns
        // its later cancellation through next/close and registry retirement.
        input.signal?.removeEventListener('abort', closeOnAbort);
    }
}
