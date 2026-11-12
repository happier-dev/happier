import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { randomUUID } from '@/platform/randomUUID';
import { PluginError } from '@happier-dev/plugin-sdk';
import { readPluginActionFailureAuthorPayload, readPluginActionFailureHandlerInvocation } from '@happier-dev/protocol/plugins/actions/invocation';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';
import { ActionExecuteResultSchema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginActionExecutionV2 } from '@happier-dev/protocol/plugins/actions/v2';

import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiAccountAction, resolveUiAccountActionReceiverMachineId } from '@/sync/ops/actions/accountActionDeps';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { readRuntimeFetchHost } from '@/utils/system/runtimeFetch';

/** The dispatcher places whole Account Actions; provider HTTP and credentials stay together. */
export function executeAccountActionAtRuntimeHost(params: Readonly<{
    accountScope: ServerAccountScope;
    action: PluginContributionIdentityV1;
    execution: Extract<PluginActionExecutionV2, { target: 'account' }>;
    input: unknown;
    context: ActionExecutorContext;
    signal: AbortSignal;
    /** Produced only after the mounted presenter approved and its gate admitted. */
    confirmedInvocation?: Readonly<{ input: unknown; inputDigest: string }>;
    executeLocal(): unknown;
}>): unknown {
    if (params.execution.invokingUi) return params.executeLocal();
    return executeOnSelectedHost();

    async function executeOnSelectedHost() {
        const endpointUrl = getServerProfileById(params.accountScope.serverId)?.serverUrl ?? params.accountScope.serverId;
        if (!params.context.externalActionTarget && await readRuntimeFetchHost(endpointUrl) === 'native') {
            return await params.executeLocal();
        }
        const account = await captureLazyActionAccountContext(params.accountScope.serverId, params.signal);
        try {
            const input = { action: params.action, ...(params.input === undefined ? {} : { input: params.input }) };
            const fallbackMachineId = params.context.externalActionTarget ? null
                : await resolveUiAccountActionReceiverMachineId(account, { actionId: ACTION_INVOKE_ACTION_ID_V1, input,
                    context: params.context, signal: params.signal });
            const target = params.context.externalActionTarget
                ?? (fallbackMachineId ? { kind: 'machine' as const, machineId: fallbackMachineId } : undefined);
            if (!target) throw new PluginError({ code: 'target_unavailable', message: 'target_unavailable' });
            const requestId = params.context.actionRequestId ?? randomUUID();
            const confirmation = params.confirmedInvocation && sameStrictJsonValue(params.confirmedInvocation.input, input)
                ? { actionId: ACTION_INVOKE_ACTION_ID_V1, inputDigest: params.confirmedInvocation.inputDigest, requestId,
                    accountId: params.accountScope.accountId, serverId: account.serverIdentityId ?? account.serverId, target } : undefined;
            const response = await createUiAccountAction({ account })({
                actionId: ACTION_INVOKE_ACTION_ID_V1, input, signal: params.signal,
                context: { ...params.context, presentUserConfirmation: confirmation, actionRequestId: requestId, serverId: account.serverId,
                    ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
                    runtimeAccountId: params.accountScope.accountId,
                    externalActionTarget: target,
                    actionCaller: params.context.actionCaller ?? { kind: 'host' } },
            });
            // The Account carrier already unwraps successful execution results.
            // Recognize its refusals; the plugin runtime owns payload validation.
            const parsed = ActionExecuteResultSchema.safeParse(response);
            if (parsed.success && !parsed.data.ok) {
                const failure = parsed.data;
                const data = { code: failure.errorCode, message: failure.error,
                    ...readPluginActionFailureAuthorPayload(failure.details),
                    failureCause: failure.failureCause ?? projectActionFailureCauseV1({ code: failure.errorCode }, 'dispatch') };
                throw readPluginActionFailureHandlerInvocation({ code: failure.errorCode, message: failure.error, data: failure.details })
                    ? createPluginActionHandlerNotStartedError(data) : new PluginError(data);
            }
            return response;
        } finally { account.dispose(); }
    }
}
