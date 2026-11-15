import {
    DaemonLocalServicePreviewOpenOrCreateRequestV1Schema,
    DaemonLocalServicePreviewOpenOrCreateResponseV1Schema,
    DaemonLocalServicePreviewRevokeRequestV1Schema,
    DaemonLocalServicePreviewRevokeResponseV1Schema,
    DaemonLocalServicePreviewSnapshotRequestV1Schema,
    DaemonLocalServicePreviewSnapshotResponseV1Schema,
    type LocalServicePreviewSnapshotV1,
} from '@happier-dev/protocol/local/services/preview/v1';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@happier-dev/protocol/rpcErrors';

import { readLocalServiceRpcFailure } from '../rpcFailure';

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
import type { LocalServicePreviewSnapshot } from './store';

/** One admitted read supplies the Action DTO and the existing pane projection. */
export type LocalServicePreviewSnapshotRpcResult =
    | Readonly<{ ok: true; protocolSnapshot: LocalServicePreviewSnapshotV1; snapshot: LocalServicePreviewSnapshot }>
    | Extract<LocalServicePreviewSnapshotClientResult, { ok: false }>;

// Typed daemon refusals and legacy uncoded RPC errors retain this message. Read
// both returned payloads and transport exceptions through the same presentation
// projection instead of sending honest refusals to the success DTO parser.
const LIFECYCLE_REFUSAL_PATTERN = /local_service_preview_lifecycle_refused:([\w.-]+)/;

function readLifecycleRefusalReason(value: unknown): string | null {
    const message = value instanceof Error
        ? value.message
        : typeof value === 'string'
            ? value
            : value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
                ? value.error
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
): Promise<LocalServicePreviewSnapshotRpcResult> {
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
            accountId: input.accountId,
            payload,
            signal: input.signal,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable', ...readLocalServiceRpcFailure(raw) };
        }
        const failure = readLocalServiceRpcFailure(raw);
        if (failure) return { ok: false, reason: 'request_failed', ...failure };
        const parsed = DaemonLocalServicePreviewSnapshotResponseV1Schema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, reason: 'invalid_response' };
        }
        const snapshot = normalizeLocalServicePreviewSnapshotPayload(parsed.data.snapshot, input.machineId);
        return snapshot ? { ok: true, snapshot, protocolSnapshot: parsed.data.snapshot } : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return { ok: false, reason: 'request_failed', ...readLocalServiceRpcFailure(error) };
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
            signal: input.signal,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable', ...readLocalServiceRpcFailure(raw) };
        }
        const refusal = readLifecycleRefusalReason(raw);
        if (refusal) return { ok: false, reason: `refused:${refusal}`, ...readLocalServiceRpcFailure(raw) };
        const failure = readLocalServiceRpcFailure(raw);
        if (failure) return { ok: false, reason: 'request_failed', ...failure };
        const parsed = DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return { ok: false, reason: lifecycleFailureFromError(error), ...readLocalServiceRpcFailure(error) };
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
            signal: input.signal,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable', ...readLocalServiceRpcFailure(raw) };
        }
        const refusal = readLifecycleRefusalReason(raw);
        if (refusal) return { ok: false, reason: `refused:${refusal}`, ...readLocalServiceRpcFailure(raw) };
        const failure = readLocalServiceRpcFailure(raw);
        if (failure) return { ok: false, reason: 'request_failed', ...failure };
        const parsed = DaemonLocalServicePreviewRevokeResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return { ok: false, reason: lifecycleFailureFromError(error), ...readLocalServiceRpcFailure(error) };
    }
}
