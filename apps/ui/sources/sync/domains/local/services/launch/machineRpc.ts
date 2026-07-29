import {
    DaemonLocalServiceLauncherHistoryClearResponseV1Schema,
    DaemonLocalServiceLauncherLeafRequestV1Schema,
    DaemonLocalServiceLauncherOpenPreviewResponseV1Schema,
    DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema,
    DaemonLocalServiceLauncherSnapshotRequestV1Schema,
    DaemonLocalServiceLauncherSnapshotResponseV1Schema,
    DaemonLocalServiceLauncherStartRequestV1Schema,
    DaemonLocalServiceLauncherStartResponseV1Schema,
} from '@happier-dev/protocol';
import {
    isRpcMethodNotFoundResult,
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
    RPC_METHODS,
} from '@happier-dev/protocol/rpc';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import {
    type LocalServiceLauncherSnapshotClientInput,
    type LocalServiceLauncherSnapshotClientResult,
} from './api';
import type {
    LocalServiceLauncherHistoryClearClientInput,
    LocalServiceLauncherHistoryClearClientResult,
    LocalServiceLauncherLeafTargetClientInput,
    LocalServiceLauncherOpenPreviewClientResult,
    LocalServiceLauncherRegisterPreviewClientResult,
    LocalServiceLauncherStartClientInput,
    LocalServiceLauncherStartClientResult,
} from './types';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRpcUnavailableResult(value: unknown): boolean {
    if (isRpcMethodNotFoundResult(value)) {
        return true;
    }
    if (!isRecord(value)) {
        return false;
    }
    if (value.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
        return true;
    }
    return value.error === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE;
}

export async function fetchLocalServiceLauncherSnapshotViaMachineRpc(
    input: LocalServiceLauncherSnapshotClientInput,
): Promise<LocalServiceLauncherSnapshotClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse({
            machineId: input.machineId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.scope ? { scope: input.scope } : {}),
            // The UI passes the raw repo root through unchanged; ~-expansion + Windows-safe
            // containment happen at the daemon boundary (the canonical single owner).
            ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServiceLauncherSnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success || parsed.data.snapshot.machineId !== input.machineId) {
            return { ok: false, reason: 'invalid_response' };
        }
        return { ok: true, snapshot: parsed.data.snapshot };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}

export async function startLocalServiceLauncherTargetViaMachineRpc(
    input: LocalServiceLauncherStartClientInput,
): Promise<LocalServiceLauncherStartClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServiceLauncherStartRequestV1Schema.parse({
            machineId: input.machineId,
            targetId: input.targetId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            payload,
        });
        if (isRpcUnavailableResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServiceLauncherStartResponseV1Schema.safeParse(raw);
        if (
            !parsed.success
            || parsed.data.machineId !== payload.machineId
            || parsed.data.targetId !== payload.targetId
        ) {
            return { ok: false, reason: 'invalid_response' };
        }
        return { ok: true, response: parsed.data };
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable' };
        }
        return { ok: false, reason: 'request_failed' };
    }
}

// LSV-1 launcher leaves: `openPreview` resolves the target's browser view for a safe
// "open in browser" (Docker-style), `registerPreview` persists a loopback launch target as a
// private preview, and `history.clear` dismisses the launcher feed history. Each rides the shared
// leaf request and the same command-receipted machine-RPC transport as launcher.start.
export async function openLocalServiceLauncherPreviewViaMachineRpc(
    input: LocalServiceLauncherLeafTargetClientInput,
): Promise<LocalServiceLauncherOpenPreviewClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServiceLauncherLeafRequestV1Schema.parse({
            machineId: input.machineId,
            targetId: input.targetId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_OPEN_PREVIEW,
            payload,
        });
        if (isRpcUnavailableResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServiceLauncherOpenPreviewResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable' };
        }
        return { ok: false, reason: 'request_failed' };
    }
}

export async function registerLocalServiceLauncherPreviewViaMachineRpc(
    input: LocalServiceLauncherLeafTargetClientInput,
): Promise<LocalServiceLauncherRegisterPreviewClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServiceLauncherLeafRequestV1Schema.parse({
            machineId: input.machineId,
            targetId: input.targetId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW,
            payload,
        });
        if (isRpcUnavailableResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable' };
        }
        return { ok: false, reason: 'request_failed' };
    }
}

export async function clearLocalServiceLauncherHistoryViaMachineRpc(
    input: LocalServiceLauncherHistoryClearClientInput,
): Promise<LocalServiceLauncherHistoryClearClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServiceLauncherLeafRequestV1Schema.parse({
            machineId: input.machineId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR,
            payload,
        });
        if (isRpcUnavailableResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServiceLauncherHistoryClearResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable' };
        }
        return { ok: false, reason: 'request_failed' };
    }
}
