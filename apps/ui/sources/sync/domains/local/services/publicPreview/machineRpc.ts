import {
    DaemonLocalServicePublicPreviewCopyUrlRequestV1Schema,
    DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema,
    DaemonLocalServicePublicPreviewCreateRequestV1Schema,
    DaemonLocalServicePublicPreviewCreateResponseV1Schema,
    DaemonLocalServicePublicPreviewRevokeRequestV1Schema,
    DaemonLocalServicePublicPreviewRevokeResponseV1Schema,
    DaemonLocalServicePublicPreviewStatusRequestV1Schema,
    DaemonLocalServicePublicPreviewStatusResponseV1Schema,
} from '@happier-dev/protocol/local/services/public/v1';
import {
    isRpcMethodNotFoundResult,
    RPC_METHODS,
} from '@happier-dev/protocol/rpc';
import {
    isRpcMethodNotFoundError,
    readRpcErrorCode,
} from '@happier-dev/protocol/rpcErrors';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

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
    type LocalServicePublicPreviewFailureReason,
} from './api';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRpcFailureReason(value: unknown): LocalServicePublicPreviewFailureReason | null {
    if (isRpcMethodNotFoundResult(value)) {
        return 'unavailable';
    }
    if (!isRecord(value)) {
        return null;
    }
    if (value.errorCode === 'public_preview_disabled') return 'feature_disabled';
    return typeof value.error === 'string' || typeof value.errorCode === 'string' ? 'request_failed' : null;
}

function failureFromError(error: unknown): Extract<LocalServicePublicPreviewStatusClientResult, { ok: false }> {
    if (readRpcErrorCode(error) === 'public_preview_disabled') return { ok: false, reason: 'feature_disabled' };
    if (isRpcMethodNotFoundError(error)) {
        return { ok: false, reason: 'unavailable' };
    }
    return { ok: false, reason: 'request_failed' };
}

/** One feature-admission and failure-envelope boundary for every public-preview operation. */
async function callPublicPreviewRpc(
    input: Pick<LocalServicePublicPreviewStatusClientInput, 'serverId' | 'signal'>,
    method: string,
    payload: Readonly<{ machineId: string }>,
): Promise<Readonly<{ ok: true; raw: unknown }> | Extract<LocalServicePublicPreviewStatusClientResult, { ok: false }>> {
    if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
    const features = await getServerFeaturesSnapshot({ serverId: input.serverId ?? undefined, signal: input.signal });
    if (features.status !== 'ready') return { ok: false, reason: 'unavailable' };
    const enabled = readServerEnabledBit(features.features, 'localServices.publicPreview') === true;
    if (!enabled) {
        return { ok: false, reason: 'feature_disabled' };
    }
    if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
    const raw = await machineRpcWithServerScope<unknown, typeof payload>({
        machineId: payload.machineId, serverId: input.serverId, method, payload, signal: input.signal,
    });
    const reason = readRpcFailureReason(raw);
    return reason ? { ok: false, reason } : { ok: true, raw };
}

export async function fetchLocalServicePublicPreviewStatusViaMachineRpc(
    input: LocalServicePublicPreviewStatusClientInput,
): Promise<LocalServicePublicPreviewStatusClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonLocalServicePublicPreviewStatusRequestV1Schema.parse(input.request);
        const result = await callPublicPreviewRpc(input, RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS, payload);
        if (!result.ok) return result;
        const parsed = DaemonLocalServicePublicPreviewStatusResponseV1Schema.safeParse(result.raw);
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
        const result = await callPublicPreviewRpc(input, RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE, payload);
        if (!result.ok) return result;
        const parsed = DaemonLocalServicePublicPreviewCreateResponseV1Schema.safeParse(result.raw);
        return parsed.success && isPublicPreviewCreateResponseForRequest(parsed.data, payload)
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return failureFromError(error);
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
        const result = await callPublicPreviewRpc(input, RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE, payload);
        if (!result.ok) return result;
        const parsed = DaemonLocalServicePublicPreviewRevokeResponseV1Schema.safeParse(result.raw);
        return parsed.success && isPublicPreviewRevokeResponseForRequest(parsed.data, payload)
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return failureFromError(error);
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
        const result = await callPublicPreviewRpc(input, RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_COPY_URL, payload);
        if (!result.ok) return result;
        const parsed = DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema.safeParse(result.raw);
        return parsed.success && isPublicPreviewCopyUrlResponseForRequest(parsed.data, payload)
            ? { ok: true, response: parsed.data }
            : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return failureFromError(error);
    }
}
