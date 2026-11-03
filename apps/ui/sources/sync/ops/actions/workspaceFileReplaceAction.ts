import { WorkspaceFilesReplaceActionOutputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { DaemonWorkspaceFileReplaceApplyResponseSchema, type DaemonWorkspaceFileReplaceApplyResponse } from '@happier-dev/protocol/machines/workspaceFiles';
import { DaemonLspApplyResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { acknowledgeWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { projectUiAccountRequesterCaller } from './accountActionTransport';

const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });

type MachineWriteContext = Parameters<NonNullable<ActionExecutorDeps['workspaceFilesReplace']>>[1];
type WriteTarget = Readonly<{ machineId: string; rootPath: string }>;

function acknowledgeResult(account: LazyActionAccountContext, input: WriteTarget,
    result: Extract<DaemonWorkspaceFileReplaceApplyResponse, { ok: true }>) {
    if (!account.accountOnlyLifetime.isCurrent()) return;
    acknowledgeWorkspaceFileWrites({ serverId: account.serverId, accountId: account.accountId, machineId: input.machineId, rootPath: input.rootPath },
        result.results.filter(file => file.status === 'replaced' || file.status === 'restored').flatMap(file => file.renameTo
            ? [{ path: file.path, hash: null }, { path: file.renameTo, hash: file.hash ?? null }]
            : [{ path: file.path, hash: file.hash ?? null }]));
}

/** One terminal owner for the immediate invocation and its later approval receipt. */
export async function settleUiWorkspaceFileReplaceResult(account: LazyActionAccountContext, input: WriteTarget,
    result: unknown, requestId: string, signal?: AbortSignal, cancelSignal?: AbortSignal) {
    const output = WorkspaceFilesReplaceActionOutputSchema.safeParse(result);
    if (!output.success) return failure('invalid_action_output');
    let value: unknown = output.data;
    if ('operation' in output.data) {
        const operationId = output.data.operation.operationId;
        let cancellation: Promise<unknown> | undefined;
        const cancel = () => {
            cancellation ??= (async () => {
                const { executeDefaultActionInCapturedAccount } = await import('./defaultActionExecutor');
                return await executeDefaultActionInCapturedAccount(account, 'action.operations.cancel', {
                    serverId: account.serverId, machineId: input.machineId, operationId,
                }, { surface: 'ui', authority: 'present_user', expectedAccountId: account.accountId, signal });
            })().catch(() => undefined);
        };
        cancelSignal?.addEventListener('abort', cancel, { once: true });
        try {
            if (cancelSignal?.aborted) cancel();
            const terminal = await getActionOperation({ serverId: account.serverId, accountId: account.accountId,
                machineId: input.machineId, operationId, waitForTerminal: true, signal,
                rpc: request => machineRpcWithServerScope({ ...request, operationTimeoutMs: null }),
            });
            if (terminal.kind !== 'found' || terminal.operation.operationId !== operationId
                || terminal.operation.actionId !== 'workspace.files.replace'
                || terminal.operation.requestId !== requestId
                || terminal.operation.scope.accountId !== account.accountId
                || terminal.operation.scope.machineId !== input.machineId) return failure('operation_scope_mismatch');
            if (terminal.operation.state === 'failed') return failure(terminal.operation.error?.errorCode ?? 'workspace_file_replace_failed');
            if (terminal.operation.state !== 'succeeded') return failure(terminal.operation.state === 'cancelled' ? 'cancelled' : 'outcome_uncertain');
            value = terminal.operation.result;
        } finally {
            cancelSignal?.removeEventListener('abort', cancel);
            await cancellation;
        }
    }
    const parsed = DaemonWorkspaceFileReplaceApplyResponseSchema.safeParse(value);
    if (!parsed.success) return failure('invalid_action_output');
    if (parsed.data.ok) acknowledgeResult(account, input, parsed.data);
    return parsed.data;
}

/** Immediate and approval-resumed semantic writes share one receipt projection. */
export function settleUiLanguageIntelligenceApplyResult(account: LazyActionAccountContext, input: WriteTarget, value: unknown) {
    const parsed = DaemonLspApplyResponseSchema.safeParse(value);
    if (!parsed.success) return failure('invalid_action_output');
    if ('ok' in parsed.data && parsed.data.ok) acknowledgeResult(account, input, parsed.data);
    return parsed.data;
}

/**
 * An admitted Account write to an exact Machine: the original Account, requested Machine and request id,
 * and the host or mounted-plugin requester invocation the Home verifies. Admission still owns policy.
 */
function admitUiMachineWrite(account: LazyActionAccountContext | undefined, machineId: string, context: MachineWriteContext) {
    context.signal?.throwIfAborted();
    if (!account || account.credentialAuthorityKind !== 'account' || context.externalActionCredential
        || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization) return null;
    account.assertCurrent();
    // These ports receive an already schema-admitted explicit Machine operand.
    // A supplied target narrows it; ordinary mounted callers need no second selection.
    const target = context.externalActionTarget ?? { kind: 'machine' as const, machineId };
    if (target?.kind !== 'machine' || target.machineId !== machineId || !context.actionRequestId
        || context.serverId && !areServerProfileIdentifiersEquivalent(context.serverId, account.serverId)
        || context.runtimeAccountId && context.runtimeAccountId !== account.accountId) return null;
    const invocation = ExternalActionRequesterInvocationV1Schema.safeParse({
        caller: projectUiAccountRequesterCaller(context.actionCaller ?? { kind: 'host' }), surface: context.surface ?? 'rpc',
        authority: context.authority ?? 'account_automation', callerPermissionMode: context.callerPermissionMode,
        callerInputConstraints: context.callerInputConstraints, workspaceWrites: context.workspaceWrites,
        defaultSessionId: context.defaultSessionId,
    });
    if (!invocation.success) return null;
    return { account, target, requestId: context.actionRequestId, invocation: invocation.data };
}

/** Delivery only: Action admission owns policy; the Machine operation owns effects and cancellation. */
export function createUiWorkspaceFileReplaceAction(accountContext?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['workspaceFilesReplace']> {
    return async (input, context) => {
        const admitted = admitUiMachineWrite(accountContext, input.machineId, context);
        if (!admitted) return failure('admission_unavailable');
        const { target } = admitted;
        const invocation = { data: admitted.invocation };
        // User cancellation requests a stop between files. It must not abort
        // admission or the terminal observation and lose an already-written file's inverse.
        const account = admitted.account;
        return await withActionAccountRequestSignal({ accountLifetime: account.accountOnlyLifetime }, undefined, async signal => {
            const execution = await executeOriginalAccountMachineAction({ account, actionId: 'workspace.files.replace', input,
                machineId: input.machineId, machineTarget: target, requestId: context.actionRequestId!,
                actionCaller: admitted.invocation.caller,
                authority: invocation.data.authority, invocation: invocation.data, ...(signal ? { signal } : {}) });
            if (!execution.ok) return execution;
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
            if (approval.success) return approval.data;
            return await settleUiWorkspaceFileReplaceResult(account, input, execution.result, admitted.requestId, signal, context.signal);
        });
    };
}

/**
 * Semantic edits (P7 U7: rename, file rename, one code action) from admitted UI and plugin callers.
 * Their RPC methods require canonical Action admission at the Home, so delivery is the same original-
 * Account Machine Action as replace, never a raw Machine RPC or a host-caller impersonation.
 */
export function createUiLanguageIntelligenceApplyAction(account?: LazyActionAccountContext): NonNullable<ActionExecutorDeps['languageIntelligenceApply']> {
    return async ({ machineId, request, actionId }, context) => {
        const admitted = admitUiMachineWrite(account, machineId, context);
        if (!admitted) return failure('admission_unavailable');
        const input = request.operation.kind === 'codeAction' ? { machineId, ...request }
            : { machineId, rootPath: request.rootPath, path: request.path,
                ...(request.languageId ? { languageId: request.languageId } : {}), files: request.operation.files };
        const live = admitted.account;
        // Like replace: cancellation never abandons the terminal receipt and its inverse edits.
        return await withActionAccountRequestSignal({ accountLifetime: live.accountOnlyLifetime }, undefined, async signal => {
            const execution = await executeOriginalAccountMachineAction({ account: live, actionId, input,
                machineId, machineTarget: admitted.target, requestId: admitted.requestId,
                actionCaller: admitted.invocation.caller,
                authority: admitted.invocation.authority, invocation: admitted.invocation, ...(signal ? { signal } : {}) });
            if (!execution) return failure('admission_unavailable');
            if (!execution.ok) return execution;
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
            if (approval.success) return approval.data;
            return settleUiLanguageIntelligenceApplyResult(live, { machineId, rootPath: request.rootPath }, execution.result);
        });
    };
}
