import {
    ActionApprovalRequestCreatedResultSchema,
    ReadWorkspaceSyncFileResultV1Schema,
    ReadWorkspaceSyncFileV1Schema,
    WorkspaceSyncConflictPageRequestV1Schema,
    WorkspaceSyncConflictPageV1Schema,
    WorkspaceSyncRelationshipIdV1Schema,
    WorkspaceSyncLegacyStateInspectionV1Schema,
    WorkspaceSyncStatusV1Schema,
    WorkspaceSyncConflictResolveActionInputV1Schema,
    WorkspaceSyncConflictResolutionResultV1Schema,
    WorkspaceSyncConflictInspectRpcRequestV1Schema,
    WorkspaceSyncConflictInspectRpcResultV1Schema,
    type WorkspaceSyncConflictResolutionV1,
    type WorkspaceSyncConflictResolutionResultV1,
    type WorkspaceSyncConflictInspectRpcRequestV1,
    type WorkspaceSyncConflictInspectRpcResultV1,
    type ReadWorkspaceSyncFileResultV1,
    type ReadWorkspaceSyncFileV1,
    type WorkspaceSyncConflictPageV1,
    type WorkspaceSyncStatusV1,
    type WorkspaceSyncLegacyStateInspectionV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { randomUUID } from '@/platform/randomUUID';

type WorkspaceSyncControllerScope = Readonly<{
    controllerMachineId: string;
    serverId?: string | null;
    signal?: AbortSignal;
}>;

type WorkspaceSyncRelationshipScope = WorkspaceSyncControllerScope & Readonly<{
    relationshipId: string;
}>;

function unsupported(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

function strictRecord(value: unknown, keys: readonly string[], method: string): Readonly<Record<string, unknown>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) unsupported(method);
    const record = value as Readonly<Record<string, unknown>>;
    const actualKeys = Object.keys(record);
    if (actualKeys.length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) {
        unsupported(method);
    }
    return record;
}

async function callWorkspaceSync<R>(
    scope: WorkspaceSyncControllerScope,
    method: string,
    payload: unknown,
): Promise<R> {
    return await machineRpcWithServerScope<R, unknown>({
        machineId: scope.controllerMachineId,
        serverId: scope.serverId,
        method,
        payload,
        ...(scope.signal ? { signal: scope.signal } : {}),
    });
}

function parseStatusEnvelope(raw: unknown, method: string): WorkspaceSyncStatusV1 {
    const record = strictRecord(raw, ['status'], method);
    const parsed = WorkspaceSyncStatusV1Schema.safeParse(record.status);
    return parsed.success ? parsed.data : unsupported(method);
}

function workspaceSyncActionError(errorCode: string, message: string): Error {
    return Object.assign(new Error(message), { code: errorCode });
}

function parseApprovedWorkspaceSyncConflictResult(
    raw: unknown,
    method: string,
    subordinateRpcFailure: unknown,
): WorkspaceSyncConflictResolutionResultV1 {
    const decision = strictRecord(raw, ['ok', 'status', 'execution'], method);
    if (decision.ok !== true || (decision.status !== 'executed' && decision.status !== 'failed')) {
        return unsupported(method);
    }
    const execution = decision.execution;
    if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
        return unsupported(method);
    }
    const executionRecord = execution as Readonly<Record<string, unknown>>;

    if (decision.status === 'failed') {
        if (executionRecord.ok !== false) return unsupported(method);
        const recordedErrorCode = typeof executionRecord.errorCode === 'string'
            && executionRecord.errorCode.trim().length > 0
            ? executionRecord.errorCode.trim()
            : 'approval_execution_failed';
        const subordinateRpcErrorCode = readRpcErrorCode(subordinateRpcFailure);
        // The shared Action executor intentionally normalizes unknown RPC-domain
        // codes to `action_failed`. Preserve the exact typed failure from this
        // synchronous subordinate RPC while the recorded result remains the
        // authority for whether the approved execution succeeded or failed.
        const errorCode = recordedErrorCode === 'action_failed' && subordinateRpcErrorCode
            ? subordinateRpcErrorCode
            : recordedErrorCode;
        const recordedError = typeof executionRecord.error === 'string'
            && executionRecord.error.trim().length > 0
            ? executionRecord.error.trim()
            : errorCode;
        throw workspaceSyncActionError(errorCode, recordedError);
    }

    if (executionRecord.ok !== true) return unsupported(method);
    const parsed = WorkspaceSyncConflictResolutionResultV1Schema.safeParse(executionRecord.result);
    return parsed.success ? parsed.data : unsupported(method);
}

async function runRelationshipCommand(
    scope: WorkspaceSyncRelationshipScope,
    method: string,
): Promise<WorkspaceSyncStatusV1> {
    const payload = WorkspaceSyncRelationshipIdV1Schema.parse({ relationshipId: scope.relationshipId });
    return parseStatusEnvelope(await callWorkspaceSync(scope, method, payload), method);
}

async function runRelationshipLifecycleCommand(
    scope: WorkspaceSyncRelationshipScope,
    method: string,
): Promise<void> {
    const payload = WorkspaceSyncRelationshipIdV1Schema.parse({ relationshipId: scope.relationshipId });
    const record = strictRecord(await callWorkspaceSync(scope, method, payload), ['ok'], method);
    if (record.ok !== true) unsupported(method);
}

export async function listWorkspaceSyncStatuses(
    scope: WorkspaceSyncControllerScope,
): Promise<readonly WorkspaceSyncStatusV1[]> {
    const method = RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST;
    const record = strictRecord(await callWorkspaceSync(scope, method, {}), ['statuses'], method);
    if (!Array.isArray(record.statuses)) unsupported(method);
    const statuses: WorkspaceSyncStatusV1[] = [];
    for (const value of record.statuses) {
        const parsed = WorkspaceSyncStatusV1Schema.safeParse(value);
        if (!parsed.success) unsupported(method);
        statuses.push(parsed.data);
    }
    return statuses;
}

export async function inspectWorkspaceSyncLegacyState(
    scope: WorkspaceSyncControllerScope,
): Promise<WorkspaceSyncLegacyStateInspectionV1> {
    const method = RPC_METHODS.DAEMON_WORKSPACE_SYNC_LEGACY_INSPECT;
    const parsed = WorkspaceSyncLegacyStateInspectionV1Schema.safeParse(
        await callWorkspaceSync(scope, method, {}),
    );
    return parsed.success ? parsed.data : unsupported(method);
}

export async function getWorkspaceSyncStatus(
    scope: WorkspaceSyncRelationshipScope,
): Promise<WorkspaceSyncStatusV1 | null> {
    const method = RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET;
    const payload = WorkspaceSyncRelationshipIdV1Schema.parse({ relationshipId: scope.relationshipId });
    const record = strictRecord(await callWorkspaceSync(scope, method, payload), ['status'], method);
    if (record.status === null) return null;
    const parsed = WorkspaceSyncStatusV1Schema.safeParse(record.status);
    return parsed.success ? parsed.data : unsupported(method);
}

export async function flushWorkspaceSyncRelationship(
    scope: WorkspaceSyncRelationshipScope,
): Promise<WorkspaceSyncStatusV1> {
    return await runRelationshipCommand(scope, RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH);
}

export async function disableWorkspaceSyncRelationship(
    scope: WorkspaceSyncRelationshipScope,
): Promise<void> {
    await runRelationshipLifecycleCommand(scope, RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE);
}

export async function enableWorkspaceSyncRelationship(
    scope: WorkspaceSyncRelationshipScope,
): Promise<void> {
    await runRelationshipLifecycleCommand(scope, RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME);
}

export async function terminatePersistedWorkspaceSyncRelationship(
    scope: WorkspaceSyncRelationshipScope,
): Promise<void> {
    await runRelationshipLifecycleCommand(scope, RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE);
}

export async function listWorkspaceSyncConflicts(
    scope: WorkspaceSyncRelationshipScope & Readonly<{ cursor?: string; limit?: number }>,
): Promise<WorkspaceSyncConflictPageV1> {
    const method = RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST;
    const payload = WorkspaceSyncConflictPageRequestV1Schema.parse({
        relationshipId: scope.relationshipId,
        ...(scope.cursor ? { cursor: scope.cursor } : {}),
        limit: scope.limit ?? 100,
    });
    const parsed = WorkspaceSyncConflictPageV1Schema.safeParse(await callWorkspaceSync(scope, method, payload));
    return parsed.success ? parsed.data : unsupported(method);
}

export async function inspectWorkspaceSyncConflict(
    input: WorkspaceSyncControllerScope & Readonly<{ request: WorkspaceSyncConflictInspectRpcRequestV1 }>,
): Promise<WorkspaceSyncConflictInspectRpcResultV1> {
    const method = RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT;
    const request = WorkspaceSyncConflictInspectRpcRequestV1Schema.parse(input.request);
    const parsed = WorkspaceSyncConflictInspectRpcResultV1Schema.safeParse(await callWorkspaceSync(input, method, request));
    return parsed.success ? parsed.data : unsupported(method);
}

/**
 * Present-user adapter for the workspace conflict resolution Action. The
 * private daemon RPC is subordinate to the confirmed Action receipt.
 */
export async function resolveWorkspaceSyncConflict(
    input: WorkspaceSyncControllerScope & Readonly<{
        request: WorkspaceSyncConflictResolutionV1;
        onPhase?: (phase: 'requesting_approval' | 'applying') => void;
    }>,
): Promise<WorkspaceSyncConflictResolutionResultV1> {
    const method = RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE;
    const actionInput = WorkspaceSyncConflictResolveActionInputV1Schema.parse(input.request);
    if (actionInput.controllerMachineId !== input.controllerMachineId) unsupported(method);
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    let subordinateRpcFailure: unknown = null;
    const executor = createDefaultActionExecutor({
        workspaceSyncConflictResolve: async ({ actionReceiptId, input: approvedInput, signal }) => {
            try {
                const raw = await callWorkspaceSync({ ...input, ...(signal ? { signal } : {}) }, method, {
                    actionReceiptId,
                    actionInput: approvedInput,
                });
                const canonical = WorkspaceSyncConflictResolutionResultV1Schema.safeParse(raw);
                return canonical.success ? canonical.data : unsupported(method);
            } catch (error) {
                subordinateRpcFailure = error;
                throw error;
            }
        },
    });
    input.onPhase?.('requesting_approval');
    const requested = await executor.execute('workspace.sync.conflict.resolve', actionInput, {
        serverId: input.serverId ?? undefined,
        surface: 'ui',
        actionRequestId: randomUUID(),
        signal: input.signal,
    });
    if (!requested.ok) throw Object.assign(new Error(requested.error), { code: requested.errorCode });
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(requested.result);
    if (!approval.success) {
        return WorkspaceSyncConflictResolutionResultV1Schema.parse(requested.result);
    }
    input.onPhase?.('applying');
    const decided = await executor.execute('approval.request.decide', {
        artifactId: approval.data.artifactId,
        decision: 'approve',
    }, { serverId: input.serverId ?? undefined, surface: 'ui', signal: input.signal });
    if (!decided.ok) throw Object.assign(new Error(decided.error), { code: decided.errorCode });
    return parseApprovedWorkspaceSyncConflictResult(decided.result, method, subordinateRpcFailure);
}

export async function readWorkspaceSyncFile(
    input: WorkspaceSyncControllerScope & Readonly<{ request: ReadWorkspaceSyncFileV1 }>,
): Promise<ReadWorkspaceSyncFileResultV1> {
    const method = RPC_METHODS.DAEMON_WORKSPACE_SYNC_FILE_READ;
    const payload = ReadWorkspaceSyncFileV1Schema.parse(input.request);
    const parsed = ReadWorkspaceSyncFileResultV1Schema.safeParse(await callWorkspaceSync(input, method, payload));
    return parsed.success ? parsed.data : unsupported(method);
}
