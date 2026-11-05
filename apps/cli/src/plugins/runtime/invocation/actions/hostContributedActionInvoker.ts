import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { arePluginMachineExecutionOriginsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { resolvePluginInvocationCallerExecutionOrigin } from '../services/actionCaller';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/plugin-sdk/host/registration';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';

import type { InvokeContributedAction } from '../services/actions';
import type {
    RevalidatePluginActionCallerOccurrence,
    RevalidatePluginActionCallerMaterialization,
} from '../services/actionCaller';

/**
 * Adapts the canonical ActionExecutor's `action.invoke` hook to the committed
 * plugin target dispatcher. Target selection and target currentness remain
 * there; this adapter revalidates the host-stamped caller before handoff.
 */
export function createHostContributedActionInvoker(params: Readonly<{
    invokeContributedAction: InvokeContributedAction;
    revalidatePluginActionCallerMaterialization: RevalidatePluginActionCallerMaterialization;
    revalidatePluginActionCallerOccurrence: RevalidatePluginActionCallerOccurrence;
    resolveCurrentPluginExecutionOrigin?(
        pluginId: string, signal?: AbortSignal,
    ): Promise<import('@happier-dev/protocol').PluginMachineExecutionOriginV1 | null>;
}>): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
    return async ({ action, input, context, requiredDangerLevel, signal }) => {
        const caller = context.actionCaller;
        if (
            caller?.kind !== 'plugin'
            || !caller.contributionLocalId
            || !caller.occurrenceId
            || !caller.sourceCustody
        ) {
            return {
                ok: false,
                errorCode: 'plugin_action_caller_unavailable',
                error: 'Plugin contributed action calls require current host-stamped caller provenance',
            };
        }
        const callerMaterialization = caller.materialization;
        const callerOccurrenceId = caller.occurrenceId;
        const invocationSignal = signal ?? context.signal ?? new AbortController().signal;
        const resolveCurrentOrigin = params.resolveCurrentPluginExecutionOrigin
            ? (currentSignal?: AbortSignal) => params.resolveCurrentPluginExecutionOrigin!(caller.pluginId, currentSignal)
            : undefined;
        const parsedInput = input === undefined
            ? undefined
            : StrictJsonValueSchema.safeParse(input);
        if (parsedInput !== undefined && !parsedInput.success) {
            return {
                ok: false,
                errorCode: 'invalid_parameters',
                error: 'invalid_parameters',
            };
        }
        const isCallerCurrent = async (): Promise<boolean> => {
            try {
                if (callerMaterialization !== undefined
                    && !await params.revalidatePluginActionCallerMaterialization(
                        callerMaterialization,
                    )) return false;
                return await params.revalidatePluginActionCallerOccurrence({
                        pluginId: caller.pluginId,
                        occurrenceId: callerOccurrenceId,
                    });
            } catch {
                return false;
            }
        };
        const callerNoLongerCurrent = () => ({
            ok: false as const,
            errorCode: 'plugin_action_caller_unavailable',
            error: 'Plugin contributed action caller is no longer current',
        });
        if (!await isCallerCurrent()) {
            return callerNoLongerCurrent();
        }
        const executionOrigin = await resolvePluginInvocationCallerExecutionOrigin(caller, resolveCurrentOrigin, invocationSignal);
        if (executionOrigin === null) return callerNoLongerCurrent();
        const result = await params.invokeContributedAction({
            action,
            ...(requiredDangerLevel ? { requiredDangerLevel } : {}),
            ...(parsedInput === undefined ? { input: undefined } : { input: parsedInput.data }),
            surface: 'plugin',
            ...(caller.originSurface ? { originSurface: caller.originSurface } : {}),
            initiatingActionCaller: caller,
            approvalContext: context,
            ...(context.contributedActionExecutionOrigin ? {
                captureExecutionOrigin: true as const,
                ...(context.contributedActionExecutionOrigin.expectedExecutionOrigin === undefined ? {} : {
                    expectedExecutionOrigin: context.contributedActionExecutionOrigin.expectedExecutionOrigin }),
                ...(context.contributedActionExecutionOrigin.expectedExecutionRouting === undefined ? {} : {
                    expectedExecutionRouting: context.contributedActionExecutionOrigin.expectedExecutionRouting }),
            } : {}),
            caller: {
                kind: 'plugin',
                pluginId: caller.pluginId,
                contribution: {
                    id: caller.contributionLocalId,
                    qualifiedId: caller.contributionQualifiedId ?? buildQualifiedPluginContributionKey(
                        createPluginContributionIdentity({
                            pluginId: caller.pluginId,
                            localId: caller.contributionLocalId,
                        }),
                    ),
                },
                occurrenceId: callerOccurrenceId,
                sourceCustody: caller.sourceCustody,
                ...(callerMaterialization ? { materialization: callerMaterialization } : {}),
                ...(executionOrigin === undefined ? {} : { executionOrigin }),
                ...(caller.originSurface ? { originSurface: caller.originSurface } : {}),
            },
            ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}),
            signal: invocationSignal,
        });
        if (!await isCallerCurrent()) {
            return callerNoLongerCurrent();
        }
        if (executionOrigin !== undefined) {
            const current = await resolvePluginInvocationCallerExecutionOrigin(caller, resolveCurrentOrigin, invocationSignal);
            if (!current || !arePluginMachineExecutionOriginsEqual(executionOrigin, current)) return callerNoLongerCurrent();
        }
        if (result.status === 'executed') {
            if (result.executionOrigin) context.contributedActionExecutionOrigin?.onExecuted(result.executionOrigin);
            return { ok: true, result: result.value };
        }
        const failure = { code: result.code, message: result.message,
            ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
            ...readPluginActionFailureAuthorPayload(result.data) };
        const error = result.actionHandlerInvocation === 'notStarted'
            ? createPluginActionHandlerNotStartedError(failure) : new PluginError(failure);
        return {
            ok: false,
            errorCode: result.code,
            error: result.message,
            ...(error.data.failureCause ? { failureCause: error.data.failureCause } : {}),
            details: error.data,
        };
    };
}
