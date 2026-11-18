import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { randomUUID } from '@/platform/randomUUID';
import { PluginError } from '@happier-dev/plugin-sdk';
import { readPluginActionFailureAuthorPayload, readPluginActionFailureHandlerInvocation } from '@happier-dev/protocol/plugins/actions/invocation';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';
import { ActionExecuteResultSchema, projectActionFailureCauseV1, actionTargetUnavailable } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginActionExecutionV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiAccountAction, resolveUiAccountActionReceiverMachineId } from '@/sync/ops/actions/accountActionDeps';
import { confirmOwnUiRefusal } from '@/sync/ops/actions/executeMachineActionAtDaemon';
import { bindPresentUserActionConfirmation } from '@/sync/ops/actions/presentUserConfirmation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { readRuntimeFetchHost } from '@/utils/system/runtimeFetch';

/** The dispatcher places whole Account Actions; provider HTTP and credentials stay together. */
export function executeAccountActionAtRuntimeHost(params: Readonly<{
    accountScope: ServerAccountScope;
    action: PluginContributionIdentityV1;
    execution: Extract<PluginActionExecutionV2, { target: 'account' }>;
    input: unknown;
    /** Selected Machine declaration; no browser executable is required there. */
    sourceMachineId?: string;
    expectedContributorOccurrenceId?: string;
    context: ActionExecutorContext;
    signal: AbortSignal;
    /** Produced only after the mounted presenter approved and its gate admitted. */
    confirmedInvocation?: Readonly<{ input: unknown; inputDigest: string }>;
    executeLocal(): unknown;
}>): unknown {
    const purpose = params.context.invocationServices?.connectedAccountPurposeBinding;
    // The managed owner already selected this host for the whole operation.
    // Its private exact child proof retains that placement with its custody.
    if (purpose?.managedOperation && purpose.identity.pluginId === params.action.pluginId
        && purpose.identity.localId === params.action.localId && readHostReviewedChildOperationV1(params.context,
        formatQualifiedPluginActionId(params.action), params.input)) return params.executeLocal();
    if (params.execution.invokingUi) return params.executeLocal();
    return executeOnSelectedHost();

    async function executeOnSelectedHost() {
        const endpointUrl = getServerProfileById(params.accountScope.serverId)?.serverUrl ?? params.accountScope.serverId;
        if (!params.context.externalActionTarget && !params.sourceMachineId && await readRuntimeFetchHost(endpointUrl) === 'native') {
            return await params.executeLocal();
        }
        const account = await captureLazyActionAccountContext(params.accountScope.serverId, params.signal);
        try {
            const input = { action: params.action,
                ...(params.expectedContributorOccurrenceId === undefined ? {} : { expectedContributorOccurrenceId: params.expectedContributorOccurrenceId }),
                ...(params.input === undefined ? {} : { input: params.input }) };
            const fallbackMachineId = params.context.externalActionTarget ? null
                : params.sourceMachineId ?? await resolveUiAccountActionReceiverMachineId(account, { actionId: ACTION_INVOKE_ACTION_ID_V1, input,
                    context: params.context, signal: params.signal });
            if (typeof fallbackMachineId === 'object' && fallbackMachineId !== null) {
                throw new PluginError({ code: fallbackMachineId.errorCode, message: fallbackMachineId.error, data: fallbackMachineId.details });
            }
            const target = params.context.externalActionTarget
                ?? (fallbackMachineId ? { kind: 'machine' as const, machineId: fallbackMachineId } : undefined);
            if (!target) {
                const failure = actionTargetUnavailable('own_reachable_machine_absent');
                throw new PluginError({ code: failure.errorCode, message: failure.error, data: failure.details });
            }
            const requestId = params.context.actionRequestId ?? randomUUID();
            const confirmation = params.confirmedInvocation && sameStrictJsonValue(params.confirmedInvocation.input, input)
                ? { actionId: ACTION_INVOKE_ACTION_ID_V1, inputDigest: params.confirmedInvocation.inputDigest, requestId,
                    accountId: params.accountScope.accountId, serverId: account.serverIdentityId ?? account.serverId, target } : undefined;
            const context: ActionExecutorContext = {
                ...params.context, presentUserConfirmation: confirmation, actionRequestId: requestId, serverId: account.serverId,
                ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
                runtimeAccountId: params.accountScope.accountId, externalActionTarget: target,
                actionCaller: params.context.actionCaller ?? { kind: 'host' }, signal: params.signal,
            };
            const execute = createUiAccountAction({ account });
            // The Account carrier already unwraps successful execution results.
            // Recognize its refusals; the plugin runtime owns payload validation.
            const dispatch = async (context: ActionExecutorContext) => {
                const response = await execute({ actionId: ACTION_INVOKE_ACTION_ID_V1, input, signal: params.signal, context });
                const parsed = ActionExecuteResultSchema.safeParse(response);
                return parsed.success && !parsed.data.ok ? parsed.data : { ok: true as const, result: response };
            };
            const result = await dispatch(context);
            // Present the receiver's exact review before projecting it into an author error.
            // A UI-local reconstruction can describe the same operation with a different digest.
            const settled = !result.ok && result.errorCode === 'action_interactive_review_required'
                ? await confirmOwnUiRefusal(ACTION_INVOKE_ACTION_ID_V1, input, context, result,
                    async request => (await import('@/sync/ops/actions/actionConfirmationPresenter'))
                        .createActionConfirmationPresenter(account)(request),
                    (reviewedInput, reviewDigest) => sameStrictJsonValue(reviewedInput, input)
                        ? dispatch(bindPresentUserActionConfirmation(ACTION_INVOKE_ACTION_ID_V1, input,
                            { ...context, actionRequestId: randomUUID() }, reviewDigest))
                        : Promise.resolve(result))
                : result;
            if (!settled.ok) {
                const failure = settled;
                const authored = readPluginActionFailureAuthorPayload(failure.details);
                const data = { code: failure.errorCode, message: failure.error, ...authored,
                    ...(failure.effectAttempted === undefined ? {} : { effectAttempted: failure.effectAttempted }),
                    failureCause: failure.failureCause ?? authored.failureCause
                        ?? projectActionFailureCauseV1({ code: failure.errorCode }, 'dispatch') };
                throw readPluginActionFailureHandlerInvocation({ code: failure.errorCode, message: failure.error, data: failure.details })
                    ? createPluginActionHandlerNotStartedError(data) : new PluginError(data);
            }
            return settled.result;
        } finally { account.dispose(); }
    }
}
