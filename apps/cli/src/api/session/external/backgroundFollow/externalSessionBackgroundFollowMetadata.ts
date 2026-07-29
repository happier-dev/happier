import {
    applyObservedProgressToExternalSessionAttentionV1,
    buildExternalSessionAttentionV1,
    buildExternalSessionFollowPolicyV1,
    buildLinkedExternalSessionMetadataV1,
    readExternalSessionAttentionV1,
    readExternalSessionFollowPolicyV1,
    readLinkedExternalSessionV1FromMetadata,
    resolveLinkedExternalSessionMetadataV1,
    updateLinkedExternalSessionFollowMetadataV1,
    type ExternalSessionFollowIssueV1,
    type ExternalSessionFollowPolicy,
    type ExternalSessionFollowStatusV1,
    type ExternalSessionObservedProgress,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import { readCredentials, type Credentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';

export { deriveExternalSessionObservedProgress } from '@happier-dev/protocol';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function readCurrentFollowPolicy(metadata: Metadata): ExternalSessionFollowPolicy {
    const externalSession = readLinkedExternalSessionV1FromMetadata(metadata);
    return readExternalSessionFollowPolicyV1(externalSession?.followPolicyV1)?.policy ?? 'attached_only';
}

export function updateMetadataWithExternalSessionFollowPolicy(
    metadata: Metadata,
    params: Readonly<{
        policy: ExternalSessionFollowPolicy;
        updatedAtMs: number;
    }>,
): Metadata {
    const resolved = resolveLinkedExternalSessionMetadataV1(metadata);
    if (
        !resolved.ok
        && resolved.error === 'linked_session_reconciliation_required'
    ) {
        throw new Error('linked_session_reconciliation_required');
    }
    if (!resolved.ok) {
        return metadata;
    }
    const currentExternalSession = resolved.linkedSession;

    const currentPolicy = readCurrentFollowPolicy(metadata);
    const currentFollowPolicy = asRecord(currentExternalSession.followPolicyV1);
    const currentUpdatedAtMs = typeof currentFollowPolicy?.updatedAtMs === 'number'
        && Number.isFinite(currentFollowPolicy.updatedAtMs)
        ? Math.trunc(currentFollowPolicy.updatedAtMs)
        : null;
    const nextUpdatedAtMs = Math.max(0, Math.trunc(params.updatedAtMs));

    if (currentPolicy === params.policy && currentUpdatedAtMs === nextUpdatedAtMs) {
        return metadata;
    }

    return updateLinkedExternalSessionFollowMetadataV1(metadata, {
        followPolicyV1: buildExternalSessionFollowPolicyV1({
            policy: params.policy,
            updatedAtMs: nextUpdatedAtMs,
        }),
    }) as Metadata;
}

export function updateMetadataWithExternalSessionFollowStatus(
    metadata: Metadata,
    params: Readonly<{
        followStatusV1: ExternalSessionFollowStatusV1;
        lastFollowIssueV1?: ExternalSessionFollowIssueV1;
    }>,
): Metadata {
    return updateLinkedExternalSessionFollowMetadataV1(metadata, {
        followStatusV1: params.followStatusV1,
        ...(params.lastFollowIssueV1 === undefined
            ? {}
            : { lastFollowIssueV1: params.lastFollowIssueV1 }),
    }) as Metadata;
}

export function updateMetadataWithExternalSessionObservedProgress(
    metadata: Metadata,
    params: Readonly<{
        observedProgress?: ExternalSessionObservedProgress | null;
        lastKnownActivityAtMs?: number | null;
    }>,
): Metadata {
    const currentExternalSession = readLinkedExternalSessionV1FromMetadata(metadata);
    if (!currentExternalSession) {
        return metadata;
    }

    const currentAttention = readExternalSessionAttentionV1(
        (metadata as { externalSessionAttentionV1?: unknown } | null | undefined)?.externalSessionAttentionV1,
    );
    const nextAttention = applyObservedProgressToExternalSessionAttentionV1(
        currentAttention,
        params.observedProgress ?? null,
    );
    const nextLastKnownActivityAtMs = typeof params.lastKnownActivityAtMs === 'number'
        && Number.isFinite(params.lastKnownActivityAtMs)
        && params.lastKnownActivityAtMs >= 0
        ? Math.trunc(params.lastKnownActivityAtMs)
        : null;
    const currentLastKnownActivityAtMs = typeof currentExternalSession.lastKnownActivityAtMs === 'number'
        && Number.isFinite(currentExternalSession.lastKnownActivityAtMs)
        ? Math.trunc(currentExternalSession.lastKnownActivityAtMs)
        : null;

    const shouldUpdateAttention = nextAttention !== currentAttention;
    const shouldUpdateLastKnownActivityAtMs = nextLastKnownActivityAtMs !== null
        && nextLastKnownActivityAtMs !== currentLastKnownActivityAtMs;

    if (!shouldUpdateAttention && !shouldUpdateLastKnownActivityAtMs) {
        return metadata;
    }

    const nextMetadata = buildLinkedExternalSessionMetadataV1(metadata, {
            ...currentExternalSession,
            ...(shouldUpdateLastKnownActivityAtMs ? { lastKnownActivityAtMs: nextLastKnownActivityAtMs } : {}),
        }) as Metadata;
    Object.assign(nextMetadata, {
        ...(shouldUpdateAttention && nextAttention
            ? { externalSessionAttentionV1: buildExternalSessionAttentionV1(nextAttention) }
            : {}),
    });

    return nextMetadata;
}

export async function updateSessionMetadataWithExternalSessionFollowPolicy(params: Readonly<{
    token: string;
    credentials: Credentials;
    sessionId: string;
    rawSession: Readonly<{
        metadata: string;
        metadataVersion: number;
        encryptionMode?: unknown;
        dataEncryptionKey?: unknown;
    }>;
    policy: ExternalSessionFollowPolicy;
    updatedAtMs: number;
}>): Promise<void> {
    await updateSessionMetadataWithRetry({
        token: params.token,
        credentials: params.credentials,
        sessionId: params.sessionId,
        rawSession: params.rawSession,
        updater: (currentMetadata) => updateMetadataWithExternalSessionFollowPolicy(currentMetadata as Metadata, {
            policy: params.policy,
            updatedAtMs: params.updatedAtMs,
        }),
    });
}

export async function updateSessionMetadataWithExternalSessionFollowStatus(params: Readonly<{
    token: string;
    credentials: Credentials;
    sessionId: string;
    rawSession: Readonly<{
        metadata: string;
        metadataVersion: number;
        encryptionMode?: unknown;
        dataEncryptionKey?: unknown;
    }>;
    followStatusV1: ExternalSessionFollowStatusV1;
    lastFollowIssueV1?: ExternalSessionFollowIssueV1;
}>): Promise<void> {
    await updateSessionMetadataWithRetry({
        token: params.token,
        credentials: params.credentials,
        sessionId: params.sessionId,
        rawSession: params.rawSession,
        updater: (currentMetadata) => updateMetadataWithExternalSessionFollowStatus(currentMetadata as Metadata, {
            followStatusV1: params.followStatusV1,
            ...(params.lastFollowIssueV1 === undefined
                ? {}
                : { lastFollowIssueV1: params.lastFollowIssueV1 }),
        }),
    });
}

export async function writeExternalSessionFollowStatus(params: Readonly<{
    sessionId: string;
    followStatusV1: ExternalSessionFollowStatusV1;
    lastFollowIssueV1?: ExternalSessionFollowIssueV1;
}>): Promise<void> {
    const credentials = await readCredentials();
    if (!credentials) {
        throw new Error('Authentication is unavailable while writing external-session follow status.');
    }
    const rawSession = await fetchSessionById({
        token: credentials.token,
        sessionId: params.sessionId,
    });
    if (!rawSession) {
        throw new Error('External session was not found while writing follow status.');
    }

    await updateSessionMetadataWithExternalSessionFollowStatus({
        token: credentials.token,
        credentials,
        sessionId: params.sessionId,
        rawSession,
        followStatusV1: params.followStatusV1,
        ...(params.lastFollowIssueV1 === undefined
            ? {}
            : { lastFollowIssueV1: params.lastFollowIssueV1 }),
    });
}

export async function updateSessionMetadataWithObservedExternalSessionProgress(params: Readonly<{
    token: string;
    credentials: Credentials;
    sessionId: string;
    rawSession: Readonly<{
        metadata: string;
        metadataVersion: number;
        encryptionMode?: unknown;
        dataEncryptionKey?: unknown;
    }>;
    observedProgress?: ExternalSessionObservedProgress | null;
    lastKnownActivityAtMs?: number | null;
}>): Promise<void> {
    await updateSessionMetadataWithRetry({
        token: params.token,
        credentials: params.credentials,
        sessionId: params.sessionId,
        rawSession: params.rawSession,
        updater: (currentMetadata) => updateMetadataWithExternalSessionObservedProgress(currentMetadata as Metadata, {
            observedProgress: params.observedProgress ?? null,
            lastKnownActivityAtMs: params.lastKnownActivityAtMs ?? null,
        }),
    });
}
