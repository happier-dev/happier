import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { randomUUID } from '@/platform/randomUUID';
import { PluginError } from '@happier-dev/plugin-sdk';
import { readPluginActionFailureAuthorPayload, readPluginActionFailureHandlerInvocation } from '@happier-dev/protocol/plugins/actions/invocation';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';
import { ActionExecuteResultSchema, actionTargetUnavailable } from '@happier-dev/protocol/actions/actionExecutionResult';
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

type AccountActionRuntimePlacement = Readonly<{
    accountScope: ServerAccountScope;
    action: PluginContributionIdentityV1;
    execution: Extract<PluginActionExecutionV2, { target: 'account' }>;
    input: unknown;
    /** Machine that supplied the mounted declaration. */
    sourceMachineId?: string;
    context: ActionExecutorContext;
}>;

function hasLocalAccountActionPlacement(params: AccountActionRuntimePlacement): boolean {
    const purpose = params.context.invocationServices?.connectedAccountPurposeBinding;
    return params.execution.invokingUi === true || !!(purpose?.managedOperation
        && purpose.identity.pluginId === params.action.pluginId && purpose.identity.localId === params.action.localId
        && readHostReviewedChildOperationV1(params.context, formatQualifiedPluginActionId(params.action), params.input));
}

async function hasNativeAccountActionPlacement(params: AccountActionRuntimePlacement): Promise<boolean> {
    if (params.context.externalActionTarget || params.sourceMachineId) return false;
    const endpointUrl = getServerProfileById(params.accountScope.serverId)?.serverUrl ?? params.accountScope.serverId;
    return await readRuntimeFetchHost(endpointUrl) === 'native';
}

/** Choose the executor before opening any Session operands. */
export async function resolvesAccountActionLocally(params: AccountActionRuntimePlacement): Promise<boolean> {
    return hasLocalAccountActionPlacement(params) || await hasNativeAccountActionPlacement(params);
}

/** The dispatcher places whole Account Actions; provider HTTP and credentials stay together. */
export function executeAccountActionAtRuntimeHost(params: AccountActionRuntimePlacement & Readonly<{
    expectedContributorOccurrenceId?: string;
    /** The mounted declaration admits these operands as a read. */
    readOnly?: boolean;
    signal: AbortSignal;
    /** Produced only after the mounted presenter approved and its gate admitted. */
    confirmedInvocation?: Readonly<{ input: unknown; inputDigest: string }>;
    /** The serving Machine was chosen before Session admission. */
    useSelectedHost?: true;
    executeLocal(): unknown;
}>): unknown {
    // The managed owner already selected this host for the whole operation.
    // Its private exact child proof retains that placement with its custody.
    if (!params.useSelectedHost && hasLocalAccountActionPlacement(params)) return params.executeLocal();
    return executeOnSelectedHost();

    async function executeOnSelectedHost() {
        if (!params.useSelectedHost && await hasNativeAccountActionPlacement(params)) {
            return await params.executeLocal();
        }
        const account = await captureLazyActionAccountContext(params.accountScope.serverId, params.signal);
        try {
            const actionInput = { action: params.action,
                ...(params.input === undefined ? {} : { input: params.input }) };
            const pinnedTarget = params.context.externalActionTarget
                ?? (params.sourceMachineId && !params.readOnly ? { kind: 'machine' as const, machineId: params.sourceMachineId } : undefined);
            const receiver = pinnedTarget && pinnedTarget.kind !== 'machine' ? null
                : await resolveUiAccountActionReceiverMachineId(account, { actionId: ACTION_INVOKE_ACTION_ID_V1, input: actionInput,
                    context: { ...params.context, externalActionTarget: pinnedTarget }, signal: params.signal });
            if (receiver && typeof receiver === 'object') {
                throw new PluginError({ code: receiver.errorCode, message: receiver.error, details: receiver.details });
            }
            const target = pinnedTarget ?? (receiver ? { kind: 'machine' as const, machineId: receiver } : undefined);
            if (!target) {
                const failure = actionTargetUnavailable('own_reachable_machine_absent');
                throw new PluginError({ code: failure.errorCode, message: failure.error, details: failure.details });
            }
            // A declaration supplier can show an Account read without hosting its
            // executable. Bind a different receiver by Action identity, not by the
            // supplier's runtime occurrence.
            const occurrenceId = params.sourceMachineId && !pinnedTarget && receiver !== params.sourceMachineId
                ? undefined : params.expectedContributorOccurrenceId;
            const input = { ...actionInput, ...(occurrenceId === undefined ? {} : { expectedContributorOccurrenceId: occurrenceId }) };
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
                return parsed.success && !parsed.data.ok
                    ? { ...parsed.data, requestId: parsed.data.requestId ?? context.actionRequestId }
                    : { ok: true as const, result: response };
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
                const details = authored.details === undefined ? failure.details : authored.details;
                const failureCause = failure.failureCause ?? authored.failureCause;
                const data = { code: failure.errorCode, message: failure.error, ...authored,
                    ...(details === undefined ? {} : { details }),
                    ...(failure.effectAttempted === undefined ? {} : { effectAttempted: failure.effectAttempted }),
                    ...(failureCause === undefined ? {} : { failureCause }) };
                throw readPluginActionFailureHandlerInvocation({ code: failure.errorCode, message: failure.error, data: failure.details })
                    ? createPluginActionHandlerNotStartedError(data) : new PluginError(data);
            }
            return settled.result;
        } finally { account.dispose(); }
    }
}
