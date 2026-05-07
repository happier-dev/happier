import {
  applyObservedProgressToDirectSessionAttentionV1,
  buildDirectSessionAttentionV1,
  buildDirectSessionFollowPolicyV1,
  readDirectSessionAttentionV1,
  readDirectSessionFollowPolicyV1,
  type DirectSessionFollowPolicy,
  type DirectSessionObservedProgress,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { Credentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';

export { deriveDirectSessionObservedProgress } from '@happier-dev/protocol';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readCurrentFollowPolicy(metadata: Metadata): DirectSessionFollowPolicy {
  const directSession = asRecord(metadata.directSessionV1);
  return readDirectSessionFollowPolicyV1(directSession?.followPolicyV1)?.policy ?? 'attached_only';
}

export function updateMetadataWithDirectSessionFollowPolicy(
  metadata: Metadata,
  params: Readonly<{
    policy: DirectSessionFollowPolicy;
    updatedAtMs: number;
  }>,
): Metadata {
  const currentDirectSession = asRecord(metadata.directSessionV1);
  if (!currentDirectSession) {
    return metadata;
  }

  const currentPolicy = readCurrentFollowPolicy(metadata);
  const currentFollowPolicy = asRecord(currentDirectSession.followPolicyV1);
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
    directSessionV1: {
      ...currentDirectSession,
      followPolicyV1: buildDirectSessionFollowPolicyV1({
        policy: params.policy,
        updatedAtMs: nextUpdatedAtMs,
      }),
    } as Metadata['directSessionV1'],
  };
}

export function updateMetadataWithDirectSessionObservedProgress(
  metadata: Metadata,
  params: Readonly<{
    observedProgress?: DirectSessionObservedProgress | null;
    lastKnownActivityAtMs?: number | null;
  }>,
): Metadata {
  const currentDirectSession = asRecord(metadata.directSessionV1);
  if (!currentDirectSession) {
    return metadata;
  }

  const currentAttention = readDirectSessionAttentionV1(
    (metadata as { directSessionAttentionV1?: unknown } | null | undefined)?.directSessionAttentionV1,
  );
  const nextAttention = applyObservedProgressToDirectSessionAttentionV1(
    currentAttention,
    params.observedProgress ?? null,
  );
  const nextLastKnownActivityAtMs = typeof params.lastKnownActivityAtMs === 'number'
    && Number.isFinite(params.lastKnownActivityAtMs)
    && params.lastKnownActivityAtMs >= 0
    ? Math.trunc(params.lastKnownActivityAtMs)
    : null;
  const currentLastKnownActivityAtMs = typeof currentDirectSession.lastKnownActivityAtMs === 'number'
    && Number.isFinite(currentDirectSession.lastKnownActivityAtMs)
    ? Math.trunc(currentDirectSession.lastKnownActivityAtMs)
    : null;

  const shouldUpdateAttention = nextAttention !== currentAttention;
  const shouldUpdateLastKnownActivityAtMs = nextLastKnownActivityAtMs !== null
    && nextLastKnownActivityAtMs !== currentLastKnownActivityAtMs;

  if (!shouldUpdateAttention && !shouldUpdateLastKnownActivityAtMs) {
    return metadata;
  }

  return {
    ...metadata,
    directSessionV1: {
      ...currentDirectSession,
      ...(shouldUpdateLastKnownActivityAtMs ? { lastKnownActivityAtMs: nextLastKnownActivityAtMs } : {}),
    } as Metadata['directSessionV1'],
    ...(shouldUpdateAttention && nextAttention
      ? { directSessionAttentionV1: buildDirectSessionAttentionV1(nextAttention) }
      : {}),
  };
}

export function updateMetadataWithDirectSessionBackgroundFollow(
  metadata: Metadata,
  params: Readonly<{
    observedProgress?: DirectSessionObservedProgress | null;
    lastKnownActivityAtMs?: number | null;
  }>,
): Metadata {
  return updateMetadataWithDirectSessionObservedProgress(metadata, params);
}

export async function updateSessionMetadataWithDirectSessionFollowPolicy(params: Readonly<{
  token: string;
  credentials: Credentials;
  sessionId: string;
  rawSession: Readonly<{
    metadata: string;
    metadataVersion: number;
    encryptionMode?: unknown;
    dataEncryptionKey?: unknown;
  }>;
  policy: DirectSessionFollowPolicy;
  updatedAtMs: number;
}>): Promise<void> {
  await updateSessionMetadataWithRetry({
    token: params.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    updater: (currentMetadata) => updateMetadataWithDirectSessionFollowPolicy(currentMetadata as Metadata, {
      policy: params.policy,
      updatedAtMs: params.updatedAtMs,
    }),
  });
}

export async function updateSessionMetadataWithObservedDirectSessionProgress(params: Readonly<{
  token: string;
  credentials: Credentials;
  sessionId: string;
  rawSession: Readonly<{
    metadata: string;
    metadataVersion: number;
    encryptionMode?: unknown;
    dataEncryptionKey?: unknown;
  }>;
  observedProgress?: DirectSessionObservedProgress | null;
  lastKnownActivityAtMs?: number | null;
}>): Promise<void> {
  await updateSessionMetadataWithRetry({
    token: params.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    updater: (currentMetadata) => updateMetadataWithDirectSessionObservedProgress(currentMetadata as Metadata, {
      observedProgress: params.observedProgress ?? null,
      lastKnownActivityAtMs: params.lastKnownActivityAtMs ?? null,
    }),
  });
}

export async function updateSessionMetadataWithDirectSessionBackgroundFollow(params: Readonly<{
  token: string;
  credentials: Credentials;
  sessionId: string;
  rawSession: Readonly<{
    metadata: string;
    metadataVersion: number;
    encryptionMode?: unknown;
    dataEncryptionKey?: unknown;
  }>;
  observedProgress?: DirectSessionObservedProgress | null;
  lastKnownActivityAtMs?: number | null;
}>): Promise<void> {
  await updateSessionMetadataWithObservedDirectSessionProgress(params);
}
