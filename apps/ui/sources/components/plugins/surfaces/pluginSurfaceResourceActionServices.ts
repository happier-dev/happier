import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceInvocationOptionsV1, PluginResourceContextV1 } from '@happier-dev/plugin-sdk/resources';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginUiClientExecutableRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { randomUUID } from '@/platform/randomUUID';
import { logPluginSurfaceDiagnostic } from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';
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
            resourceActionInvocation: undefined,
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
        callerSignal: AbortSignal | undefined,
        readObservation?: DispatchPluginSurfaceActionInput['readObservation'],
    ) => {
        assertCurrent();
        const actionRequestId = randomUUID();
        const result = await dispatchPluginSurfaceAction({
            actionRequestId,
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
        const requestId = result.ok ? actionRequestId : result.requestId ?? actionRequestId;
        const aborted = !result.ok && (result.reason === 'plugin_action_aborted' || result.reason === 'plugin_ui_invocation_aborted');
        let abortSource: string | undefined;
        if (aborted) {
            // Merged signals carry the reason of the signal that fired first.
            // Report only the matching owner; the reason value can contain plugin data.
            const causedAbort = (source: AbortSignal | undefined) =>
                signal.aborted && source?.aborted === true && source.reason === signal.reason;
            abortSource = causedAbort(registration.lifecycle.signal) ? 'resource_registration'
                : causedAbort(controller.signal) ? 'account_lifetime'
                : causedAbort(input.signal) ? accountLifetime.isCurrent() ? 'resource_demand' : 'account_lifetime'
                : causedAbort(callerSignal) ? 'resource_action_caller'
                : signal.aborted ? 'action_observation'
                : 'action_execution';
            logPluginSurfaceDiagnostic({ pluginId: registration.contribution.pluginId,
                contributionId: registration.contribution.localId, surfaceId: null },
            { kind: 'resource_action_aborted', code: result.reason, requestId, abortSource });
        }
        const details = { requestId, ...(abortSource === undefined ? {} : { abortSource }) };
        // Once the Resource retires, the abort is diagnostic only.
        assertCurrent();
        return { result, details };
    };
    const services: Pick<PluginDynamicResourceInvocationOptionsV1, 'readAction' | 'observeAction'> = {
        async readAction(action, value, options) {
            const cancellation = mergeAbortSignals([lifetime.signal, options?.signal]);
            try {
                const { result, details } = await dispatch(action, value, cancellation.signal, options?.signal);
                return result.ok ? { ok: true, result: result.result }
                    : { ok: false, errorCode: result.reason, error: result.message ?? result.reason,
                        details: {
                            ...details,
                            ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
                            ...(result.remediation === undefined ? {} : { remediation: result.remediation }),
                        } };
            } finally { cancellation.dispose(); }
        },
        async observeAction(action, value, invalidate, options) {
            const cancellation = mergeAbortSignals([lifetime.signal, options?.signal]);
            try {
                const subscription = await observePluginSurfaceActionRead({
                    signal: cancellation.signal, isCurrent, invalidate, retire: input.retireObservation,
                    async invoke(observation, signal) {
                        const { result, details } = await dispatch(action, value, signal, options?.signal, observation);
                        if (!result.ok) throw new PluginError({ code: result.reason, message: result.message, details });
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
