import { PluginError } from '@happier-dev/plugin-sdk';
import { ActionExecuteResultSchema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';

import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiAccountAction, resolveUiAccountActionFallbackMachineId } from '@/sync/ops/actions/accountActionDeps';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { readRuntimeFetchHost } from '@/utils/system/runtimeFetch';

/** The dispatcher places whole Account Actions; provider HTTP and credentials stay together. */
export function executeAccountActionAtRuntimeHost(params: Readonly<{
    accountScope: ServerAccountScope;
    action: PluginContributionIdentityV1;
    input: unknown;
    context: ActionExecutorContext;
    signal: AbortSignal;
    executeLocal(): unknown;
}>): unknown {
    const machineId = resolveUiAccountActionFallbackMachineId(params.accountScope);
    if (!machineId) return params.executeLocal();
    return executeOnSelectedHost();

    async function executeOnSelectedHost() {
        const endpointUrl = getServerProfileById(params.accountScope.serverId)?.serverUrl ?? params.accountScope.serverId;
        if (await readRuntimeFetchHost(endpointUrl) === 'native') return await params.executeLocal();
        const account = await captureLazyActionAccountContext(params.accountScope.serverId, params.signal);
        try {
            const response = await createUiAccountAction({ account })({
                actionId: 'action.invoke', input: { action: params.action, input: params.input }, signal: params.signal,
                context: { ...params.context, serverId: account.serverId,
                    ...(account.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
                    runtimeAccountId: params.accountScope.accountId,
                    externalActionTarget: { kind: 'machine', machineId },
                    actionCaller: params.context.actionCaller ?? { kind: 'host' } },
            });
            // The Account carrier already unwraps successful execution results.
            // Recognize its refusals; the plugin runtime owns payload validation.
            const parsed = ActionExecuteResultSchema.safeParse(response);
            if (parsed.success && !parsed.data.ok) {
                const failure = parsed.data;
                throw new PluginError({ code: failure.errorCode, message: failure.error,
                    failureCause: failure.failureCause ?? projectActionFailureCauseV1({ code: failure.errorCode }, 'dispatch') });
            }
            return response;
        } finally { account.dispose(); }
    }
}
