import {
    DaemonLocalServicePreviewOpenOrCreateRequestV1Schema,
    DaemonLocalServicePreviewOpenOrCreateResponseV1Schema,
    DaemonLocalServicePreviewRevokeRequestV1Schema,
    DaemonLocalServicePreviewRevokeResponseV1Schema,
    DaemonLocalServicePreviewSnapshotRequestV1Schema,
    DaemonLocalServicePreviewSnapshotResponseV1Schema,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

import {
    normalizeLocalServicePreviewSnapshotPayload,
    type LocalServicePreviewLifecycleFailureReason,
    type LocalServicePreviewOpenOrCreateClientInput,
    type LocalServicePreviewOpenOrCreateClientResult,
    type LocalServicePreviewRevokeClientInput,
    type LocalServicePreviewRevokeClientResult,
    type LocalServicePreviewSnapshotClientInput,
    type LocalServicePreviewSnapshotClientResult,
} from './api';

// The daemon lifecycle handler throws `local_service_preview_lifecycle_refused:<reasonCode>`
// for an honest domain refusal (wrong machine, unknown inventory entry, non-loopback target).
// Recover that reason code so the executor reports a stable `preview_<reason>` disabled code
// instead of a generic transport failure.
const LIFECYCLE_REFUSAL_PATTERN = /local_service_preview_lifecycle_refused:([\w.-]+)/;

function readLifecycleRefusalReason(value: unknown): string | null {
    const message = value instanceof Error
        ? value.message
        : typeof value === 'string'
            ? value
            : null;
    const match = message ? LIFECYCLE_REFUSAL_PATTERN.exec(message) : null;
    return match ? match[1] : null;
}

function lifecycleFailureFromError(error: unknown): LocalServicePreviewLifecycleFailureReason {
    const refusal = readLifecycleRefusalReason(error);
    if (refusal) {
        return `refused:${refusal}`;
    }
    if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return 'unavailable';
    }
    return 'request_failed';
}

export async function fetchLocalServicePreviewSnapshotViaMachineRpc(
    input: LocalServicePreviewSnapshotClientInput,
): Promise<LocalServicePreviewSnapshotClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServicePreviewSnapshotRequestV1Schema.parse({
            machineId: input.machineId,
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServicePreviewSnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, reason: 'invalid_response' };
        }
        const snapshot = normalizeLocalServicePreviewSnapshotPayload(parsed.data.snapshot, input.machineId);
        return snapshot ? { ok: true, snapshot } : { ok: false, reason: 'invalid_response' };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}

export async function openOrCreateLocalServicePreviewViaMachineRpc(
    input: LocalServicePreviewOpenOrCreateClientInput,
): Promise<LocalServicePreviewOpenOrCreateClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServicePreviewOpenOrCreateRequestV1Schema.parse(input.request);
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return { ok: false, reason: lifecycleFailureFromError(error) };
    }
}

export async function revokeLocalServicePreviewViaMachineRpc(
    input: LocalServicePreviewRevokeClientInput,
): Promise<LocalServicePreviewRevokeClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServicePreviewRevokeRequestV1Schema.parse(input.request);
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE,
            payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServicePreviewRevokeResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return { ok: false, reason: lifecycleFailureFromError(error) };
    }
}
