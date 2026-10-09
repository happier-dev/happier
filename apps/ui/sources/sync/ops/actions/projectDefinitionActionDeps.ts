import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { LazyActionAccountContext } from './actionAccountContext';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { canUsePrivateProjectAccountAction } from '@/sync/api/projects/projectAccountRowsClient';

/** The admitted Action carries bytes to the existing daemon file owner; this adapter never writes files. */
export function createUiProjectDefinitionAction(account?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['projectDefinitionAction']> {
    return async ({ actionId, input, context }) => {
        context.signal?.throwIfAborted();
        account?.assertCurrent();
        const parsed = PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS[actionId].safeParse(input);
        if (!parsed.success) return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
        const request = parsed.data;
        if (account && !areServerProfileIdentifiersEquivalent(account.serverId, request.workspace.serverId)) {
            return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        }
        const spec = getActionSpec(actionId);
        const method = spec.bindings?.rpcMethod;
        if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        if (account && !context.externalActionCredential && !context.externalActionExecutionAuthorization
            && !context.rpcSessionAuthorization && (!context.actionCaller || context.actionCaller.kind === 'host')) {
            if (context.surface !== 'ui' || context.authority !== 'present_user'
                || !context.actionRequestId || !canUsePrivateProjectAccountAction(account, context)) {
                return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
            }
            const execution = await executeOriginalAccountMachineAction({ account, actionId,
                input: { ...request, workspace: { ...request.workspace, serverId: account.serverId } },
                machineId: request.workspace.machineId, requestId: context.actionRequestId, foreignTargetOnly: true,
                ...(context.signal ? { signal: context.signal } : {}) });
            account.assertResultCurrent(spec.sideEffectClass);
            if (execution) return execution.ok ? execution.result : execution;
        }
        const result = await machineRpcWithServerScope({
            serverId: request.workspace.serverId,
            machineId: request.workspace.machineId,
            accountId: account?.accountId ?? context.runtimeAccountId,
            method,
            payload: request,
            ...(context.signal ? { signal: context.signal } : {}),
        });
        account?.assertResultCurrent(spec.sideEffectClass);
        return result;
    };
}
