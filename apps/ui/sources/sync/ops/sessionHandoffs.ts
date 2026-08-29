import {
    SessionHandoffStartResponseSchema,
    SessionHandoffStatusSchema,
    type SessionHandoffStartResponse,
    type SessionHandoffStatus,
    type SessionHandoffStorageMode,
    type SessionHandoffTransportStrategy,
    type SessionHandoffWorkspaceTransfer,
    type HandoffWorkspaceActionV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readMachineControlTargetForSession } from './sessionMachineTarget';
import { readSessionOwnerMetadataView } from '../domains/session/readSessionOwnerMetadataView';
import { storage } from '../domains/state/storage';

/** UI-side request/status adapter. The daemon owns all handoff phases, retries and recovery. */
type HandoffErrorResult = Readonly<{ ok: false; errorCode: string; errorMessage: string; handoffId?: string; status?: SessionHandoffStatus; recovery?: unknown }>;

export type StartSessionHandoffOptions = Readonly<{
    sessionId: string; sourceMachineId?: string | null; targetMachineId: string; targetPath?: string; serverId?: string | null;
    sessionStorageMode: SessionHandoffStorageMode; targetSessionStorageMode?: SessionHandoffStorageMode;
    preferredTransportStrategies?: readonly SessionHandoffTransportStrategy[]; negotiatedTransportStrategy?: SessionHandoffTransportStrategy;
    workspaceTransfer?: SessionHandoffWorkspaceTransfer; sourceStartRetry?: unknown;
    workspaceAction?: HandoffWorkspaceActionV1;
}>;
export type StartSessionHandoffResult = Readonly<{ ok: true; handoffId: string; status: SessionHandoffStartResponse['status'] | SessionHandoffStatus; endpointCandidates?: SessionHandoffStartResponse['endpointCandidates']; handoffMetadataV2?: NonNullable<SessionHandoffStartResponse['handoffMetadataV2']> }> | HandoffErrorResult;
export type CompleteSessionHandoffOptions = StartSessionHandoffOptions & Readonly<{ sourceMetadata?: unknown; targetPrepareRetry?: unknown }>;
export type CompleteSessionHandoffResult = Readonly<{ ok: true; handoffId: string; status: SessionHandoffStatus }> | HandoffErrorResult;
export type PerformSessionHandoffRecoveryActionResult = Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>;

function normalizeId(value: unknown): string { return typeof value === 'string' ? value.trim() : String(value ?? '').trim(); }

function readError(raw: unknown): HandoffErrorResult | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record.ok !== false && typeof record.error !== 'string') return null;
    const status = SessionHandoffStatusSchema.safeParse(record.status);
    const handoffId = normalizeId(record.handoffId) || (status.success ? status.data.handoffId : '');
    return { ok: false, errorCode: normalizeId(record.errorCode) || 'UNEXPECTED', errorMessage: normalizeId(record.error) || normalizeId(record.errorMessage) || 'Session handoff failed', ...(handoffId ? { handoffId } : {}), ...(status.success ? { status: status.data } : {}), ...(record.recovery !== undefined ? { recovery: record.recovery } : {}) };
}

function resolveSourceMachineId(options: Readonly<{ sessionId: string; sourceMachineId?: string | null }>): string | null {
    return normalizeId(options.sourceMachineId) || normalizeId(readMachineControlTargetForSession(options.sessionId)?.machineId) || null;
}

function readSessionStorageMode(sessionId: string, fallback: SessionHandoffStorageMode): SessionHandoffStorageMode {
    const session = storage.getState().sessions?.[sessionId];
    const metadata = session ? readSessionOwnerMetadataView(session) : null;
    const value = (metadata as Record<string, unknown> | null)?.transcriptStorage;
    return value === 'direct' || value === 'persisted' ? value : fallback;
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
            payload: { sessionId: options.sessionId, targetMachineId: normalizeId(options.targetMachineId), ...(options.targetPath ? { targetPath: options.targetPath } : {}), ...(options.targetSessionStorageMode ? { targetSessionStorageMode: options.targetSessionStorageMode } : {}), ...(options.workspaceAction ? { workspaceAction: options.workspaceAction } : {}) },
            serverId: normalizeId(options.serverId) || null,
        });
    } catch (error) {
        return { ok: false, errorCode: 'UNEXPECTED', error: error instanceof Error ? error.message : 'Failed to start session handoff' };
    }
}

export function normalizeSessionHandoffStartResponse(raw: unknown): unknown { return unwrap(raw); }
export function normalizePrepareTargetResponseCandidate(raw: unknown): Record<string, unknown> | null { return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null; }

export async function startSessionHandoff(options: StartSessionHandoffOptions): Promise<StartSessionHandoffResult> {
    const raw = unwrap(await requestCoordinator(options));
    const error = readError(raw); if (error) return error;
    const parsed = SessionHandoffStartResponseSchema.safeParse(raw);
    if (parsed.success) return { ok: true, handoffId: parsed.data.handoffId, status: parsed.data.status, endpointCandidates: parsed.data.endpointCandidates, ...(parsed.data.handoffMetadataV2 ? { handoffMetadataV2: parsed.data.handoffMetadataV2 } : {}) };
    const status = SessionHandoffStatusSchema.safeParse((raw as Record<string, unknown> | null)?.status);
    const handoffId = normalizeId((raw as Record<string, unknown> | null)?.handoffId) || (status.success ? status.data.handoffId : '');
    return handoffId && status.success ? { ok: true, handoffId, status: status.data } : { ok: false, errorCode: 'UNEXPECTED', errorMessage: 'Unsupported session handoff response from daemon' };
}

export async function startSessionHandoffOnSourceWithRetry(options: StartSessionHandoffOptions, _retryOptions?: unknown): Promise<StartSessionHandoffResult> { return await startSessionHandoff(options); }

export async function completeSessionHandoff(options: CompleteSessionHandoffOptions): Promise<CompleteSessionHandoffResult> {
    const result = await startSessionHandoff({ ...options, sessionStorageMode: readSessionStorageMode(options.sessionId, options.sessionStorageMode) });
    if (!result.ok) return result;
    const status = SessionHandoffStatusSchema.safeParse(result.status);
    return status.success ? { ok: true, handoffId: result.handoffId, status: status.data } : { ok: false, errorCode: 'UNEXPECTED', errorMessage: 'Unsupported session handoff status from daemon' };
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

export async function performSessionHandoffRecoveryAction(params: Readonly<{ action: 'keep_stopped' | 'restart_on_source' | 'retry_source_cleanup'; recovery: unknown }>): Promise<PerformSessionHandoffRecoveryActionResult> {
    return params.action === 'keep_stopped' ? { ok: true } : { ok: false, error: 'Session handoff recovery must be retried from the source machine' };
}
