import {
    DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema,
    DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema,
    DaemonLocalServicePublicPreviewCreateRequestV1Schema,
    DaemonLocalServicePublicPreviewCreateResponseV1Schema,
    DaemonLocalServicePublicPreviewRevokeRequestV1Schema,
    DaemonLocalServicePublicPreviewRevokeResponseV1Schema,
    DaemonLocalServicePublicPreviewStatusRequestV1Schema,
    DaemonLocalServicePublicPreviewStatusResponseV1Schema,
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
    isPublicPreviewCopyUrlResponseForRequest,
    isPublicPreviewCreateResponseForRequest,
    isPublicPreviewRevokeResponseForRequest,
    isPublicPreviewSnapshotForRequest,
    type LocalServicePublicPreviewCopyUrlClientInput,
    type LocalServicePublicPreviewCopyUrlClientResult,
    type LocalServicePublicPreviewCreateClientInput,
    type LocalServicePublicPreviewCreateClientResult,
    type LocalServicePublicPreviewRevokeClientInput,
    type LocalServicePublicPreviewRevokeClientResult,
    type LocalServicePublicPreviewStatusClientInput,
    type LocalServicePublicPreviewStatusClientResult,
} from './api';

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
    return value.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || value.error === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE;
}

function failureFromError(error: unknown): LocalServicePublicPreviewStatusClientResult {
    if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return { ok: false, reason: 'unavailable' };
    }
    return { ok: false, reason: 'request_failed' };
}

export async function fetchLocalServicePublicPreviewStatusViaMachineRpc(
    input: LocalServicePublicPreviewStatusClientInput,
): Promise<LocalServicePublicPreviewStatusClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServicePublicPreviewStatusRequestV1Schema.parse(input.request);
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
            payload,
        });
        if (isRpcUnavailableResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServicePublicPreviewStatusResponseV1Schema.safeParse(raw);
        return parsed.success && isPublicPreviewSnapshotForRequest(parsed.data.snapshot, payload)
            ? { ok: true, snapshot: parsed.data.snapshot }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return failureFromError(error);
    }
}

export async function createLocalServicePublicPreviewExposureViaMachineRpc(
    input: LocalServicePublicPreviewCreateClientInput,
): Promise<LocalServicePublicPreviewCreateClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServicePublicPreviewCreateRequestV1Schema.parse(input.request);
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
            payload,
        });
        if (isRpcUnavailableResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServicePublicPreviewCreateResponseV1Schema.safeParse(raw);
        return parsed.success && isPublicPreviewCreateResponseForRequest(parsed.data, payload)
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable' };
        }
        return { ok: false, reason: 'request_failed' };
    }
}

export async function revokeLocalServicePublicPreviewExposureViaMachineRpc(
    input: LocalServicePublicPreviewRevokeClientInput,
): Promise<LocalServicePublicPreviewRevokeClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServicePublicPreviewRevokeRequestV1Schema.parse(input.request);
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE,
            payload,
        });
        if (isRpcUnavailableResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServicePublicPreviewRevokeResponseV1Schema.safeParse(raw);
        return parsed.success && isPublicPreviewRevokeResponseForRequest(parsed.data, payload)
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable' };
        }
        return { ok: false, reason: 'request_failed' };
    }
}

export async function copyLocalServicePublicPreviewUrlViaMachineRpc(
    input: LocalServicePublicPreviewCopyUrlClientInput,
): Promise<LocalServicePublicPreviewCopyUrlClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema.parse(input.request);
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: payload.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL,
            payload,
        });
        if (isRpcUnavailableResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema.safeParse(raw);
        return parsed.success && isPublicPreviewCopyUrlResponseForRequest(parsed.data, payload)
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
            return { ok: false, reason: 'unavailable' };
        }
        return { ok: false, reason: 'request_failed' };
    }
}
