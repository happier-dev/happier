import { classifyWorkspaceFileRpcUnavailable, queryCodeIntelligenceFallback, type CodeIntelligenceFallbackInput, type CodeIntelligenceFallbackResult } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import { machineWorkspaceFileSearch } from './machineWorkspaceFileSearch';
import {
    DaemonLspSyncRequestSchema, DaemonLspSyncResponseSchema,
    DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema,
    DaemonLspWatchRequestSchema, DaemonLspWatchResponseSchema,
    DaemonLspRestartRequestSchema, DaemonLspRestartResponseSchema,
    DaemonLspApplyRequestSchema, DaemonLspApplyResponseSchema, type DaemonLspApplyRequest, type DaemonLspApplyResponse,
    type LanguageIntelligenceSyncInput, type LanguageIntelligenceSyncResult,
    type LanguageIntelligenceQueryInput, type LanguageIntelligenceQueryResult,
    type LanguageIntelligenceWatchInput, type LanguageIntelligenceWatchResult,
    type LanguageIntelligenceRestartInput, type LanguageIntelligenceRestartResult,
} from '@happier-dev/protocol/machines/languageIntelligence';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { classifyWorkspaceFileRpcError } from './machineWorkspaceFileRpcError';
import { captureLazyActionAccountContext, withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { settleUiLanguageIntelligenceApplyResult } from './actions/workspaceFileReplaceAction';
import { randomUUID } from '@/platform/randomUUID';
import { isActionAccountScopeChangedError } from '@/sync/domains/scope/actionAccountScopeError';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { FilesystemEffectFailureDetailsV1Schema } from '@happier-dev/protocol/actions/filesystemActionFamily';

export type MachineLanguageIntelligenceOptions = Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal;
    /** Releases only this mounted caller's interest, never its durable approval. */
    continuationSignal?: AbortSignal;
    onApprovalPending?: (registration: ActionApprovalContinuation) => void;
}>;
type Unavailable = Extract<LanguageIntelligenceQueryResult, { status: 'unavailable' }>;
async function callLanguageIntelligence<Input, Result>(
    machineId: string, method: string, input: Input,
    requestSchema: Readonly<{ parse: (value: unknown) => Input }>,
    responseSchema: Readonly<{ safeParse: (value: unknown) => { success: true; data: Result } | { success: false } }>,
    options?: MachineLanguageIntelligenceOptions,
): Promise<Result | Unavailable> {
    const payload = requestSchema.parse(input);
    try {
        const response = await machineRpcWithServerScope<unknown, Input>({ machineId, method, payload,
            serverId: options?.serverId ?? null, accountId: options?.accountId ?? null, operationTimeoutMs: null,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        const parsed = responseSchema.safeParse(response);
        return parsed.success ? parsed.data : { status: 'unavailable', reason: 'invalid_response' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { status: 'unavailable', reason: classifyWorkspaceFileRpcError(error) };
    }
}
export function machineLanguageIntelligenceSync(machineId: string, input: LanguageIntelligenceSyncInput, options?: MachineLanguageIntelligenceOptions): Promise<LanguageIntelligenceSyncResult> {
    return callLanguageIntelligence(machineId, RPC_METHODS.DAEMON_LSP_SYNC, input, DaemonLspSyncRequestSchema, DaemonLspSyncResponseSchema, options);
}
export function machineLanguageIntelligenceQuery(machineId: string, input: LanguageIntelligenceQueryInput, options?: MachineLanguageIntelligenceOptions): Promise<LanguageIntelligenceQueryResult> {
    return callLanguageIntelligence(machineId, RPC_METHODS.DAEMON_LSP_QUERY, input, DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema, options);
}
export function machineLanguageIntelligenceWatch(machineId: string, input: LanguageIntelligenceWatchInput, options?: MachineLanguageIntelligenceOptions): Promise<LanguageIntelligenceWatchResult> {
    return callLanguageIntelligence(machineId, RPC_METHODS.DAEMON_LSP_WATCH, input, DaemonLspWatchRequestSchema, DaemonLspWatchResponseSchema, options);
}
export function machineLanguageIntelligenceRestart(machineId: string, input: LanguageIntelligenceRestartInput, options?: MachineLanguageIntelligenceOptions): Promise<LanguageIntelligenceRestartResult> {
    return callLanguageIntelligence(machineId, RPC_METHODS.DAEMON_LSP_RESTART, input, DaemonLspRestartRequestSchema, DaemonLspRestartResponseSchema, options);
}
/** File-page commands and tree rename re-enter the same present-user Action owner. */
export async function machineLanguageIntelligenceApplyAction(machineId: string, input: DaemonLspApplyRequest, options?: MachineLanguageIntelligenceOptions): Promise<DaemonLspApplyResponse | ActionExecuteFailure> {
    const payload = DaemonLspApplyRequestSchema.parse(input);
    const actionId = payload.operation.kind === 'rename' ? 'code.rename.apply' : payload.operation.kind === 'fileRename' ? 'code.file.rename.apply'
        : payload.operation.kind === 'format' ? 'code.format.apply' : payload.operation.kind === 'organizeImports' ? 'code.imports.organize' : 'code.codeAction.apply';
    const target = { machineId, rootPath: payload.rootPath, path: payload.path, ...(payload.languageId ? { languageId: payload.languageId } : {}) };
    const actionInput = payload.operation.kind === 'codeAction' ? { machineId, ...payload }
        : payload.operation.kind === 'format' || payload.operation.kind === 'organizeImports'
            ? { ...target, operation: { kind: 'apply', files: payload.operation.files } } : { ...target, files: payload.operation.files };
    const serverId = options?.serverId ?? captureActiveServerAccountScopeLifetime()?.scope.serverId;
    if (!serverId) return { ok: false, errorCode: 'action_home_not_found', error: 'action_home_not_found' };
    // Like replace: the Home admits the original Account's write to this exact Machine.
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const { executeDefaultActionInCapturedAccount } = await import('./actions/defaultActionExecutor');
        const requestId = randomUUID();
        const execution = await executeDefaultActionInCapturedAccount(account, actionId, actionInput, {
            surface: 'ui', authority: 'present_user', expectedAccountId: options?.accountId ?? account.accountId,
            actionRequestId: requestId,
            externalActionTarget: { kind: 'machine', machineId }, ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (!execution.ok) return execution;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        if (approval.success) {
            if (!options?.onApprovalPending) return { ok: false, errorCode: 'approval_required', error: 'approval_required', details: approval.data };
            return await withActionAccountRequestSignal({ accountLifetime: account.accountOnlyLifetime }, options.continuationSignal, async signal => {
                const resumed = await resumeActionExecutionResult({ result: execution, actionId, actionInput,
                    scope: { serverId: account.serverId, accountId: account.accountId }, requestId, signal,
                    onApprovalPending: options.onApprovalPending!,
                });
                return resumed.ok ? settleUiLanguageIntelligenceApplyResult(account, { machineId, rootPath: payload.rootPath }, resumed.result) : resumed;
            });
        }
        const parsed = DaemonLspApplyResponseSchema.safeParse(execution.result);
        return parsed.success ? parsed.data : { status: 'unavailable', reason: 'invalid_response' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        // A changed Account is refused before dispatch; anything else may have reached the Machine.
        if (isActionAccountScopeChangedError(error)) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
    } finally { account.dispose(); }
}
/** File-page semantic previews read through the same Actions agents use (disk text, hash-guarded). */
export type CodeIntelligencePreviewActionId = 'code.rename.preview' | 'code.file.rename.preview' | 'code.codeActions.list'
    | 'code.format.apply' | 'code.imports.organize';

function projectFilesystemCustodyFailure(failure: ActionExecuteFailure) {
    if (failure.errorCode !== 'filesystem_identity_custody_unavailable') return null;
    const details = FilesystemEffectFailureDetailsV1Schema.safeParse(failure.details);
    return { status: 'error' as const, errorCode: 'filesystem_identity_custody_unavailable' as const,
        ...(details.success ? { details: details.data } : {}) };
}

export async function machineLanguageIntelligencePreviewAction(machineId: string, actionId: CodeIntelligencePreviewActionId,
    input: Readonly<Record<string, unknown>>, options?: MachineLanguageIntelligenceOptions,
): Promise<LanguageIntelligenceQueryResult | Readonly<{ status: 'refused'; errorCode: string }>> {
    const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
    const response = await createDefaultActionExecutor().execute(actionId, { machineId, ...input }, {
        surface: 'ui', authority: 'present_user', ...(options?.serverId ? { serverId: options.serverId } : {}),
        ...(options?.accountId ? { expectedAccountId: options.accountId } : {}), ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) return projectFilesystemCustodyFailure(response)
        ?? { status: 'refused', errorCode: response.errorCode ?? 'failed' };
    const parsed = DaemonLspQueryResponseSchema.safeParse(response.result);
    return parsed.success ? parsed.data : { status: 'unavailable', reason: 'invalid_response' };
}
/** Present-user restart always re-enters the canonical Action admission owner. */
export async function machineLanguageIntelligenceRestartAction(machineId: string, input: LanguageIntelligenceRestartInput, options?: MachineLanguageIntelligenceOptions): Promise<LanguageIntelligenceRestartResult> {
    const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
    const response = await createDefaultActionExecutor().execute('code.restart', { machineId, ...input }, {
        surface: 'ui', authority: 'present_user', ...(options?.serverId ? { serverId: options.serverId } : {}),
        ...(options?.accountId ? { expectedAccountId: options.accountId } : {}), ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) return projectFilesystemCustodyFailure(response)
        ?? { status: 'unavailable', reason: classifyWorkspaceFileRpcUnavailable(response.errorCode) ?? 'session_unavailable' };
    const parsed = DaemonLspRestartResponseSchema.safeParse(response.result);
    return parsed.success ? parsed.data : { status: 'unavailable', reason: 'invalid_response' };
}

export async function machineCodeIntelligenceFallback(
    machineId: string,
    input: CodeIntelligenceFallbackInput,
    options?: Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal }>,
): Promise<CodeIntelligenceFallbackResult> {
    return queryCodeIntelligenceFallback(input, request => machineWorkspaceFileSearch(machineId, request, options));
}
