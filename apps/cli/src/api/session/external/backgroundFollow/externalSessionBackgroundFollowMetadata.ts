import {
    applyObservedProgressToExternalSessionAttentionV1,
    buildExternalSessionAttentionV1,
    buildExternalSessionFollowPolicyV1,
    readExternalSessionAttentionV1,
    readExternalSessionFollowPolicyV1,
    type ExternalSessionFollowPolicy,
    type ExternalSessionObservedProgress,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { Credentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';

export { deriveExternalSessionObservedProgress } from '@happier-dev/protocol';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function readCurrentFollowPolicy(metadata: Metadata): ExternalSessionFollowPolicy {
    const externalSession = asRecord(metadata.externalSessionV1);
    return readExternalSessionFollowPolicyV1(externalSession?.followPolicyV1)?.policy ?? 'attached_only';
}

export function updateMetadataWithExternalSessionFollowPolicy(
    metadata: Metadata,
    params: Readonly<{
        policy: ExternalSessionFollowPolicy;
        updatedAtMs: number;
    }>,
): Metadata {
    const currentExternalSession = asRecord(metadata.externalSessionV1);
    if (!currentExternalSession) {
        return metadata;
    }

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

    return {
        ...metadata,
        externalSessionV1: {
            ...currentExternalSession,
            followPolicyV1: buildExternalSessionFollowPolicyV1({
                policy: params.policy,
                updatedAtMs: nextUpdatedAtMs,
            }),
        } as Metadata['externalSessionV1'],
    };
}

export function updateMetadataWithExternalSessionObservedProgress(
    metadata: Metadata,
    params: Readonly<{
        observedProgress?: ExternalSessionObservedProgress | null;
        lastKnownActivityAtMs?: number | null;
    }>,
): Metadata {
    const currentExternalSession = asRecord(metadata.externalSessionV1);
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

    const nextMetadata: Metadata = {
        ...metadata,
        externalSessionV1: {
            ...currentExternalSession,
            ...(shouldUpdateLastKnownActivityAtMs ? { lastKnownActivityAtMs: nextLastKnownActivityAtMs } : {}),
        } as Metadata['externalSessionV1'],
        ...(shouldUpdateAttention && nextAttention
            ? { externalSessionAttentionV1: buildExternalSessionAttentionV1(nextAttention) }
            : {}),
    };

    return nextMetadata;
}

// Keep the legacy helper name available for dist snapshot compatibility.
// Older background-follow modules can still be loaded from cached CLI snapshots.
export function updateMetadataWithExternalSessionBackgroundFollow(
    metadata: Metadata,
    params: Readonly<{
        observedProgress?: ExternalSessionObservedProgress | null;
        lastKnownActivityAtMs?: number | null;
    }>,
): Metadata {
    return updateMetadataWithExternalSessionObservedProgress(metadata, params);
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

// Keep the legacy async updater export available for cached snapshot callers.
export async function updateSessionMetadataWithExternalSessionBackgroundFollow(params: Readonly<{
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
    await updateSessionMetadataWithObservedExternalSessionProgress(params);
}
