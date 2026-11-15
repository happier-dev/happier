import {
    DaemonLocalServiceLauncherHistoryClearResponseV1Schema,
    DaemonLocalServiceLauncherLeafRequestV1Schema,
    DaemonLocalServiceLauncherOpenPreviewResponseV1Schema,
    DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema,
    DaemonLocalServiceLauncherSnapshotRequestV1Schema,
    DaemonLocalServiceLauncherSnapshotResponseV1Schema,
    DaemonLocalServiceLauncherStartRequestV1Schema,
    DaemonLocalServiceLauncherStartResponseV1Schema,
} from '@happier-dev/protocol/local/services/launcher/v1';
import {
    isRpcMethodNotFoundResult,
    RPC_METHODS,
} from '@happier-dev/protocol/rpc';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@happier-dev/protocol/rpcErrors';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { DaemonLocalServiceInventoryWatchRequestV1Schema, DaemonLocalServiceInventoryLauncherWatchResponseV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';

import { readLocalServiceRpcFailure } from '../rpcFailure';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import {
    type LocalServiceLauncherSnapshotClientInput,
    type LocalServiceLauncherSnapshotClientResult,
    type LocalServiceLauncherWatchClientInput,
    type LocalServiceLauncherWatchClientResult,
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

function readRpcFailure(value: unknown): Extract<LocalServiceLauncherSnapshotClientResult, { ok: false }> | null {
    const failure = readLocalServiceRpcFailure(value);
    if (isRpcMethodNotFoundResult(value)) return { ok: false, reason: 'unavailable', ...failure };
    return failure ? { ok: false, reason: 'request_failed', ...failure } : null;
}

/** Reuse the inventory watch, disclosing only the same projection as the launcher read. */
export async function watchLocalServiceLauncherSnapshotViaMachineRpc(
    input: LocalServiceLauncherWatchClientInput,
): Promise<LocalServiceLauncherWatchClientResult> {
    if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
    try {
        const payload = DaemonLocalServiceInventoryWatchRequestV1Schema.parse({ machineId: input.machineId,
            launcherProjection: { targets: input.targets, request: {
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                ...(input.scope ? { scope: input.scope } : {}),
                ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
                ...(input.projection ? { projection: input.projection } : {}),
            } },
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({ machineId: input.machineId,
            serverId: input.serverId, accountId: input.accountId, method: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH,
            payload, ...(input.signal ? { signal: input.signal } : {}),
        });
        const failure = readRpcFailure(raw);
        if (failure) return failure;
        const parsed = DaemonLocalServiceInventoryLauncherWatchResponseV1Schema.safeParse(raw);
        if (!parsed.success) return { ok: false, reason: 'invalid_response' };
        if (!parsed.data.changed) return { ok: true, changed: false };
        return parsed.data.snapshot.machineId === input.machineId
            ? { ok: true, changed: true, snapshot: parsed.data.snapshot }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) { return { ok: false, reason: 'request_failed', ...readLocalServiceRpcFailure(error) }; }
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
            ...(input.projection ? { projection: input.projection } : {}),
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            ...(input.accountId ? { accountId: input.accountId } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            payload,
        });
        const failure = readRpcFailure(raw);
        if (failure) return failure;
        const parsed = DaemonLocalServiceLauncherSnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success || parsed.data.snapshot.machineId !== input.machineId) {
            return { ok: false, reason: 'invalid_response' };
        }
        return { ok: true, snapshot: parsed.data.snapshot };
    } catch (error) {
        return { ok: false, reason: isRpcMethodNotFoundError(error) ? 'unavailable' : 'request_failed',
            ...readLocalServiceRpcFailure(error) };
    }
}

export async function startLocalServiceLauncherTargetViaMachineRpc(
    input: LocalServiceLauncherStartClientInput,
): Promise<LocalServiceLauncherStartClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    let dispatched = false;
    try {
        const payload = DaemonLocalServiceLauncherStartRequestV1Schema.parse({
            machineId: input.machineId,
            targetId: input.targetId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            ...(input.choice ? { choice: input.choice } : {}),
            ...(input.workspace ? { workspace: input.workspace } : {}),
            ...(input.declaration ? { declaration: input.declaration } : {}),
            ...(input.expectedEffectDigest ? { expectedEffectDigest: input.expectedEffectDigest } : {}),
        });
        dispatched = true;
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START,
            payload,
            // Start includes native preparation; its caller owns cancellation,
            // as for Project finite operations, while connection setup stays bounded.
            operationTimeoutMs: null,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        const failure = readRpcFailure(raw);
        if (failure) return failure;
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
        if (isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable', ...readLocalServiceRpcFailure(error) };
        }
        if (isRpcMethodNotAvailableError(error)) return { ok: false, reason: 'request_failed', ...readLocalServiceRpcFailure(error) };
        // A lost acknowledgement cannot prove that native preparation/start did
        // not happen. Only the transport's positive nonacceptance permits failure.
        return { ok: false, reason: dispatched && readRpcRequestDisposition(error) !== 'notSent'
            ? 'outcome_unknown' : 'request_failed', ...readLocalServiceRpcFailure(error) };
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
            signal: input.signal,
        });
        const failure = readRpcFailure(raw);
        if (failure) return failure;
        const parsed = DaemonLocalServiceLauncherOpenPreviewResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        if (isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable', ...readLocalServiceRpcFailure(error) };
        }
        return { ok: false, reason: 'request_failed', ...readLocalServiceRpcFailure(error) };
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
            signal: input.signal,
        });
        const failure = readRpcFailure(raw);
        if (failure) return failure;
        const parsed = DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        if (isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable', ...readLocalServiceRpcFailure(error) };
        }
        return { ok: false, reason: 'request_failed', ...readLocalServiceRpcFailure(error) };
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
            ...(input.scope ? { scope: input.scope } : {}),
            ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
            ...(input.targetId ? { targetId: input.targetId } : {}),
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR,
            payload,
            ...(input.accountId ? { accountId: input.accountId } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        const failure = readRpcFailure(raw);
        if (failure) return failure;
        const parsed = DaemonLocalServiceLauncherHistoryClearResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        if (isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable', ...readLocalServiceRpcFailure(error) };
        }
        return { ok: false, reason: 'request_failed', ...readLocalServiceRpcFailure(error) };
    }
}
