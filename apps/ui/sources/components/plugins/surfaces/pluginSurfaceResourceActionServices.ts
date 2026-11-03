import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceInvocationOptionsV1, PluginResourceContextV1 } from '@happier-dev/plugin-sdk/resources';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginUiClientExecutableRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { dispatchPluginSurfaceAction, type DispatchPluginSurfaceActionInput } from './pluginSurfaceActionDispatch';
import { observePluginSurfaceActionRead } from './pluginSurfaceActionReadObservation';

/** Binds the canonical Action dispatcher to one admitted dynamic Resource demand. */
export function createPluginSurfaceResourceActionServices(input: Readonly<{
    registration: PluginUiClientExecutableRegistration;
    sourceCustody: PluginSourceCustodyV1;
    context: PluginResourceContextV1;
    signal: AbortSignal;
    isCurrent(): boolean;
    retireObservation(): void;
    resolveContributedAction: NonNullable<DispatchPluginSurfaceActionInput['resolveContributedAction']>;
    contributedAction?: DispatchPluginSurfaceActionInput['contributedAction'];
    hostAction?: DispatchPluginSurfaceActionInput['hostAction'];
}>) {
    const { registration } = input;
    const accountLifetime = registration.accountLifetime;
    if (!accountLifetime) throw new PluginError({ code: 'plugin_resource_scope_unavailable' });
    const controller = new AbortController();
    const lifetime = mergeAbortSignals([input.signal, registration.lifecycle.signal, controller.signal]);
    const retirement = accountLifetime.onRetire(() => controller.abort());
    const hostAction: NonNullable<DispatchPluginSurfaceActionInput['hostAction']> = {
        execute: input.hostAction?.execute ?? createFrontDoorActionExecute(),
        context: {
            ...input.hostAction?.context,
            serverId: accountLifetime.scope.serverId,
            expectedAccountId: accountLifetime.scope.accountId,
            defaultSessionId: input.context.kind === 'session' ? input.context.sessionId : undefined,
            sessionTargetsV1: undefined,
        },
    };
    const isCurrent = () => !lifetime.signal.aborted && input.isCurrent()
        && registration.lifecycle.isCurrent() && accountLifetime.isCurrent();
    const assertCurrent = () => {
        if (!isCurrent()) throw new PluginError({ code: 'plugin_resource_aborted' });
    };
    const dispatch = async (
        action: Parameters<PluginDynamicResourceInvocationOptionsV1['readAction']>[0],
        value: Parameters<PluginDynamicResourceInvocationOptionsV1['readAction']>[1],
        signal: AbortSignal,
        readObservation?: DispatchPluginSurfaceActionInput['readObservation'],
    ) => {
        assertCurrent();
        const result = await dispatchPluginSurfaceAction({
            callerPluginId: registration.contribution.pluginId,
            resourceCaller: { pluginId: registration.contribution.pluginId, serverId: accountLifetime.scope.serverId,
                contributionLocalId: registration.contribution.localId, occurrenceId: registration.occurrenceId,
                sourceCustody: input.sourceCustody,
                ...(registration.pluginVersion ? { pluginVersion: registration.pluginVersion } : {}),
                ...(input.context.kind === 'session' ? { sessionId: input.context.sessionId } : {}) },
            requiredReadOnly: true, ...(readObservation ? { readObservation } : {}),
            action, input: value,
            clientAction: { ...(input.context.kind === 'session' ? { sessionId: input.context.sessionId } : {}) },
            ...(input.contributedAction ? { contributedAction: input.contributedAction } : {}),
            hostAction,
            resolveContributedAction: input.resolveContributedAction,
            invocationSurface: 'plugin', originSurface: 'ui', signal, isCurrent,
        });
        assertCurrent();
        return result;
    };
    const services: Pick<PluginDynamicResourceInvocationOptionsV1, 'readAction' | 'observeAction'> = {
        async readAction(action, value, options) {
            const cancellation = mergeAbortSignals([lifetime.signal, options?.signal]);
            try {
                const result = await dispatch(action, value, cancellation.signal);
                return result.ok ? { ok: true, result: result.result }
                    : { ok: false, errorCode: result.reason, error: result.message ?? result.reason,
                        ...(result.retryable === undefined && result.remediation === undefined ? {} : { details: {
                            ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
                            ...(result.remediation === undefined ? {} : { remediation: result.remediation }),
                        } }) };
            } finally { cancellation.dispose(); }
        },
        async observeAction(action, value, invalidate, options) {
            const cancellation = mergeAbortSignals([lifetime.signal, options?.signal]);
            try {
                const subscription = await observePluginSurfaceActionRead({
                    signal: cancellation.signal, isCurrent, invalidate, retire: input.retireObservation,
                    async invoke(observation, signal) {
                        const result = await dispatch(action, value, signal, observation);
                        if (!result.ok) throw new PluginError({ code: result.reason, message: result.message });
                        return result.result;
                    },
                });
                return Object.freeze({ dispose() {
                    try { return subscription.dispose(); } finally { cancellation.dispose(); }
                } });
            } catch (error) { cancellation.dispose(); throw error; }
        },
    };
    return Object.freeze({ ...services, dispose() { controller.abort(); retirement.dispose(); lifetime.dispose(); } });
}
