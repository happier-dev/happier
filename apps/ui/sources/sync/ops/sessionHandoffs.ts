import {
    SessionHandoffStartResponseSchema,
    SessionHandoffActionResultV1Schema,
    SessionHandoffStatusSchema,
    HandoffTargetReplacementPreflightResultV1Schema,
    type SessionHandoffStartResponse,
    type SessionHandoffActionResultV1,
    type SessionHandoffStatus,
    type SessionHandoffStorageMode,
    type HandoffWorkspaceActionV1,
    type HandoffTargetReplacementApprovalV1,
    type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readMachineControlTargetForSession } from './sessionMachineTarget';

/** UI-side request/status adapter. The daemon owns all handoff phases, retries and recovery. */
type HandoffErrorResult = Readonly<{ ok: false; errorCode: string; errorMessage: string; handoffId?: string; status?: SessionHandoffStatus; recovery?: unknown }>;

/**
 * Source transcript storage is deliberately absent: the source daemon derives it
 * from the owner metadata it loads, before it stops or exports anything, so the
 * client neither proves nor stamps that authority on the request.
 */
export type StartSessionHandoffOptions = Readonly<{
    sessionId: string; sourceMachineId?: string | null; targetMachineId: string; targetPath?: string; serverId?: string | null;
    targetSessionStorageMode?: SessionHandoffStorageMode;
    workspaceAction?: HandoffWorkspaceActionV1;
    actionRequestId?: string | null;
    handoffTargetReplacementApproval?: HandoffTargetReplacementApprovalV1 | null;
    handoffTargetReplacementApprovalReceiptId?: string | null;
    handoffTargetReplacementApprovalActionInput?: unknown;
    signal?: AbortSignal;
}>;
export type StartSessionHandoffResult = Readonly<{ ok: true; result: SessionHandoffActionResultV1 }> | HandoffErrorResult;

export type PreflightWorkspaceDestinationReplacementOptions = Readonly<{
    targetMachineId: string;
    targetPath: string;
    serverId: string;
    operationId: string;
    workspaceAction: HandoffWorkspaceActionV1;
    /** Explicit for callers whose mode is not expressed as a handoff workspace action. */
    activatesExactMirror?: boolean;
    /** Present for direct Project linking, which has no Session and no handoff workspace action. */
    destinationIntent?: 'use_existing' | 'materialize_from_source_workspace';
    signal?: AbortSignal;
}>;

type SessionHandoffTargetReplacementApprovalPreflightResult = Awaited<ReturnType<NonNullable<
    ActionExecutorDeps['sessionHandoffTargetReplacementApprovalPreflight']
>>>;

function normalizeId(value: unknown): string { return typeof value === 'string' ? value.trim() : String(value ?? '').trim(); }

function readError(raw: unknown): HandoffErrorResult | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.ok !== false && typeof record.error !== 'string') return null;
    const status = SessionHandoffStatusSchema.safeParse(record.status);
    const handoffId = normalizeId(record.handoffId) || (status.success ? status.data.handoffId : '');
    const errorCode = normalizeId(record.errorCode)
        || normalizeId(record.code)
        || (normalizeId(record.error).includes('workspace_sync_update_required') ? 'workspace_sync_update_required' : '')
        || 'UNEXPECTED';
    return { ok: false, errorCode, errorMessage: normalizeId(record.error) || normalizeId(record.errorMessage) || errorCode, ...(handoffId ? { handoffId } : {}), ...(status.success ? { status: status.data } : {}), ...(record.recovery !== undefined ? { recovery: record.recovery } : {}) };
}

function resolveSourceMachineId(options: Pick<StartSessionHandoffOptions, 'sessionId' | 'sourceMachineId' | 'serverId'>): string | null {
    const serverId = normalizeId(options.serverId);
    return normalizeId(options.sourceMachineId) || normalizeId(readMachineControlTargetForSession(serverId
        ? { sessionId: options.sessionId, serverId }
        : options.sessionId)?.machineId) || null;
}

function unwrap(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const record = raw as Record<string, unknown>;
    return record.ok === true && 'result' in record ? record.result : raw;
}

async function requestCoordinator(options: StartSessionHandoffOptions): Promise<unknown> {
    const machineId = resolveSourceMachineId(options);
    if (!machineId) return { ok: false, errorCode: 'machine_not_found', error: 'No reachable source machine target found for session handoff' };
    try {
        return await machineRpcWithServerScope<unknown, unknown>({
            machineId, method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
            payload: {
                sessionId: options.sessionId,
                targetMachineId: normalizeId(options.targetMachineId),
                ...(options.targetPath ? { targetPath: options.targetPath } : {}),
                ...(options.targetSessionStorageMode ? { targetSessionStorageMode: options.targetSessionStorageMode } : {}),
                ...(options.workspaceAction ? { workspaceAction: options.workspaceAction } : {}),
                ...(normalizeId(options.actionRequestId) ? { actionRequestId: normalizeId(options.actionRequestId) } : {}),
                ...(options.handoffTargetReplacementApproval
                    ? { handoffTargetReplacementApproval: options.handoffTargetReplacementApproval }
                    : {}),
                ...(normalizeId(options.handoffTargetReplacementApprovalReceiptId) ? {
                    handoffTargetReplacementApprovalReceiptId: normalizeId(options.handoffTargetReplacementApprovalReceiptId),
                    handoffTargetReplacementApprovalActionInput: options.handoffTargetReplacementApprovalActionInput,
                } : {}),
                ...(normalizeId(options.serverId) ? { accountServerId: normalizeId(options.serverId) } : {}),
            },
            serverId: normalizeId(options.serverId) || null,
            ...(options.signal ? { signal: options.signal } : {}),
        });
    } catch (error) {
        if (options.workspaceAction && options.workspaceAction.kind !== 'none'
            && (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error))) {
            return {
                ok: false,
                errorCode: 'workspace_sync_update_required',
                error: 'Workspace sync requires a newer daemon',
            };
        }
        return { ok: false, errorCode: 'UNEXPECTED', error: error instanceof Error ? error.message : 'Failed to start session handoff' };
    }
}

export function normalizeSessionHandoffStartResponse(raw: unknown): unknown { return unwrap(raw); }
export function normalizePrepareTargetResponseCandidate(raw: unknown): Record<string, unknown> | null { return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null; }

/**
 * Target-daemon inspection used by the Action approval corridor before a
 * destination-choosing operation starts. Handoff expresses its destination
 * through a workspace action; direct Project linking has no Session and states
 * its destination intent and mode explicitly.
 */
export async function preflightWorkspaceDestinationReplacement(
    options: PreflightWorkspaceDestinationReplacementOptions,
): Promise<SessionHandoffTargetReplacementApprovalPreflightResult> {
    const handoffChoosesDestination = options.workspaceAction.kind === 'copy_once'
        || options.workspaceAction.kind === 'create_relationship';
    if (!handoffChoosesDestination && options.destinationIntent === undefined) {
        return { type: 'not_required' };
    }
    const machineId = normalizeId(options.targetMachineId);
    const targetPath = normalizeId(options.targetPath);
    const serverId = normalizeId(options.serverId);
    const operationId = normalizeId(options.operationId);
    if (!machineId || !targetPath || !serverId || !operationId) {
        return { type: 'error', result: { ok: false, errorCode: 'invalid_input', error: 'invalid_input' } };
    }
    try {
        return HandoffTargetReplacementPreflightResultV1Schema.parse(await machineRpcWithServerScope({
            machineId,
            serverId,
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
            payload: {
                v: 1,
                serverId,
                machineId,
                operationId,
                targetPath,
                ...((options.activatesExactMirror
                    ?? (options.workspaceAction.kind === 'create_relationship'
                        && options.workspaceAction.mode === 'mirror_exactly'))
                    ? { activatesExactMirror: true }
                    : {}),
                ...(options.destinationIntent ? { destinationIntent: options.destinationIntent } : {}),
            },
            ...(options.signal ? { signal: options.signal } : {}),
        }));
    } catch {
        const errorCode = options.signal?.aborted ? 'cancelled' : 'target_unavailable';
        return { type: 'error', result: { ok: false, errorCode, error: errorCode } };
    }
}

export async function startSessionHandoff(options: StartSessionHandoffOptions): Promise<StartSessionHandoffResult> {
    const raw = unwrap(await requestCoordinator(options));
    const error = readError(raw); if (error) return error;
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const status = SessionHandoffStatusSchema.safeParse(record?.status);
    const handoffId = normalizeId(record?.handoffId) || (status.success ? status.data.handoffId : '');
    const terminalResult = SessionHandoffActionResultV1Schema.safeParse({
        handoffId,
        ...(status.success ? { status: status.data } : {}),
        ...(record && Object.prototype.hasOwnProperty.call(record, 'workspace') ? { workspace: record.workspace } : {}),
        ...(record && Object.prototype.hasOwnProperty.call(record, 'warning') ? { warning: record.warning } : {}),
    });
    if (terminalResult.success) return { ok: true, result: terminalResult.data };

    // Retain parsing of the richer start response only to distinguish a
    // genuinely valid predecessor response from malformed daemon output.
    const legacyStart = SessionHandoffStartResponseSchema.safeParse(raw);
    if (legacyStart.success) {
        if (options.workspaceAction && options.workspaceAction.kind !== 'none') {
            return {
                ok: false,
                errorCode: 'workspace_sync_update_required',
                errorMessage: 'Workspace sync requires a newer daemon',
            };
        }
        return {
            ok: true,
            result: {
                handoffId: legacyStart.data.handoffId,
                status: legacyStart.data.status,
                workspace: { kind: 'none' },
            },
        };
    }
    return { ok: false, errorCode: 'UNEXPECTED', errorMessage: 'Unsupported session handoff response from daemon' };
}

export async function getSessionHandoffStatus(params: Readonly<{ machineId: string; handoffId: string; serverId?: string | null }>): Promise<Readonly<{ ok: true; status: SessionHandoffStatus }> | HandoffErrorResult> {
    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({ machineId: params.machineId, method: RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3, payload: { handoffId: params.handoffId }, serverId: normalizeId(params.serverId) || null });
        const error = readError(raw); if (error) return error;
        const status = SessionHandoffStatusSchema.safeParse((raw as Record<string, unknown> | null)?.status ?? raw);
        return status.success ? { ok: true, status: status.data } : { ok: false, errorCode: 'UNEXPECTED', errorMessage: 'Unsupported session handoff status from daemon' };
    } catch (error) { return { ok: false, errorCode: 'UNEXPECTED', errorMessage: error instanceof Error ? error.message : 'Failed to read session handoff status' }; }
}

export async function cancelSessionHandoff(params: Readonly<{ machineId: string; handoffId: string; reason?: string; serverId?: string | null }>): Promise<Readonly<{ ok: true; status?: SessionHandoffStatus }> | HandoffErrorResult> {
    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({ machineId: params.machineId, method: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3, payload: { handoffId: params.handoffId, reason: params.reason ?? 'user_cancelled' }, serverId: normalizeId(params.serverId) || null });
        const error = readError(raw); if (error) return error;
        const status = SessionHandoffStatusSchema.safeParse((raw as Record<string, unknown> | null)?.status);
        return { ok: true, ...(status.success ? { status: status.data } : {}) };
    } catch (error) { return { ok: false, errorCode: 'UNEXPECTED', errorMessage: error instanceof Error ? error.message : 'Failed to cancel session handoff' }; }
}
