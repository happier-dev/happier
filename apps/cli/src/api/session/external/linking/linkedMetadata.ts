import os from 'node:os';

import { getAgentResumeConfig } from '@happier-dev/agents';
import {
  applySessionStateUpdatesToMetadata,
  applyDisplayTitleSessionMetadata,
  applyRuntimeDescriptorSessionMetadata,
  buildProviderSessionIdSessionMetadata,
  clearSessionStateFieldFromMetadata,
  type SessionStateMetadataUpdateV1,
} from '@happier-dev/agents/session/state/metadataWriters';
import { buildLinkedExternalSessionMetadataV1, readNonAuthoritativeLinkedExternalSessionV1FromMetadata, resolveLinkedExternalSessionMetadataV1, normalizeLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { ExternalSessionsAgentId, ExternalSessionsSource, LinkedExternalSessionV1, LinkedExternalSessionQualifiedIdentityV1, RuntimeDescriptorV1, AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import {
  fetchSessionById,
} from '@/session/transport/http/sessionsHttp';
import {
  tryDecryptSessionOwnerMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import {
  ExternalSessionProviderFailureError,
  isExternalSessionProviderFailureError,
} from '@/session/external/providerOps';
import { deepEqual } from '@/utils/deterministicJson';
import {
  hasConnectedServiceBindings,
  readConnectedServiceRuntimeSnapshot,
  type ConnectedServiceRuntimeSnapshot,
} from '@/daemon/connectedServices/connectedServiceRuntimeSnapshot';
import { uniqueSnapshotKey } from './connectedServiceRuntimeSnapshotKey';
import { publishLinkedSessionProject } from './projectPublication';

export function normalizeNullableString(value: unknown): string | null {
  if (value === null) return null;
  const s = String(value ?? '').trim();
  return s.length > 0 ? s : null;
}

function asMetadataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveSessionSummaryTitle(metadata: Readonly<Record<string, unknown>>): string | null {
  const summary = asMetadataRecord(metadata.summary);
  return normalizeNullableString(summary?.text);
}

function resolveExternalRemoteSessionId(metadata: Readonly<Record<string, unknown>>): string | null {
  const externalSession = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  return normalizeNullableString(externalSession?.remoteSessionId);
}

function isMeaningfulSessionTitle(value: unknown, metadata?: Readonly<Record<string, unknown>>): boolean {
  const normalized = normalizeNullableString(value);
  if (!normalized) return false;
  if (normalized.toLowerCase() === 'unknown') return false;
  const remoteSessionId = metadata ? resolveExternalRemoteSessionId(metadata) : null;
  if (remoteSessionId && normalized === remoteSessionId) return false;
  return true;
}

function hasOwnRecordValues(value: Record<string, unknown> | null | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0);
}

function assignIfDifferent(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (deepEqual(target[key], value)) return false;
  target[key] = value;
  return true;
}

const EXISTING_LINK_TOP_LEVEL_CANONICAL_SKIP_KEYS = new Set([
  'tag',
  'path',
  'host',
  'machineId',
  'flavor',
  'externalSessionV1',
  'directSessionV1',
  'summary',
  'name',
]);

function resolveRefreshedExternalSessionMetadata(params: Readonly<{
  currentMetadata: Readonly<Record<string, unknown>>;
  tag: string;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  sessionStateUpdates?: readonly SessionStateMetadataUpdateV1[];
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
  titleHint?: string | null;
  directoryHint?: string | null;
  nowMs: number;
  resolveSourceKey(source: ExternalSessionsSource): string | null;
  expectedCurrentLink: LinkedExternalSessionV1;
}>): Record<string, unknown> | null {
  const currentLinkResolution = resolveLinkedExternalSessionMetadataV1(
    params.currentMetadata,
    'stored',
  );
  if (!currentLinkResolution.ok) {
    throw new ExternalSessionProviderFailureError({
      code: 'conflict',
      message: currentLinkResolution.error,
      operation: 'externalSession.refreshExisting',
    });
  }
  const currentLink = currentLinkResolution.linkedSession;
  const expectedSourceKey = params.resolveSourceKey(
    params.expectedCurrentLink.source,
  );
  if (
    currentLink.agentId !== params.expectedCurrentLink.agentId
    || currentLink.machineId !== params.expectedCurrentLink.machineId
    || currentLink.remoteSessionId
      !== params.expectedCurrentLink.remoteSessionId
    || currentLink.linkedAtMs !== params.expectedCurrentLink.linkedAtMs
    || expectedSourceKey === null
    || params.resolveSourceKey(currentLink.source) !== expectedSourceKey
  ) {
    throw new ExternalSessionProviderFailureError({
      code: 'conflict',
      message: 'linked_session_identity_mismatch',
      operation: 'externalSession.refreshExisting',
    });
  }
  if (
    currentLink.qualifiedIdentity
    && !deepEqual(currentLink.qualifiedIdentity, params.qualifiedIdentity)
  ) {
    throw new ExternalSessionProviderFailureError({
      code: 'agent_unavailable',
      message: 'external_session_qualified_agent_unavailable',
      operation: 'externalSession.writeQualifiedIdentity',
    });
  }
  const titleHint = normalizeNullableString(params.titleHint);
  const directoryHint = normalizeNullableString(params.directoryHint);

  let didChange = false;
  let nextMetadata: Record<string, unknown> = { ...params.currentMetadata };

  const currentTitle =
    (isMeaningfulSessionTitle(resolveSessionSummaryTitle(params.currentMetadata), params.currentMetadata)
      ? resolveSessionSummaryTitle(params.currentMetadata)
      : null) ??
    (isMeaningfulSessionTitle(params.currentMetadata.name, params.currentMetadata) ? normalizeNullableString(params.currentMetadata.name) : null);

  if (titleHint && !currentTitle) {
    Object.assign(
      nextMetadata,
      applyDisplayTitleSessionMetadata(nextMetadata, {
        title: titleHint,
        staleBehavior: 'bump-if-value-changed',
      }),
    );
    didChange = true;
  }

  const currentPath = normalizeNullableString(params.currentMetadata.path);
  if (directoryHint && !currentPath) {
    nextMetadata.path = directoryHint;
    didChange = true;
  }

  const canonicalMetadata = buildExternalSessionMetadata({
    tag: params.tag,
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    qualifiedIdentity: params.qualifiedIdentity,
    runtimeDescriptor: params.runtimeDescriptor,
    sessionStateUpdates: params.sessionStateUpdates,
    vendorMetadata: params.vendorMetadata,
    externalSessionMetadata: params.externalSessionMetadata,
    connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
    directoryHint: currentPath ?? directoryHint,
    nowMs: params.nowMs,
  });

  for (const [key, value] of Object.entries(canonicalMetadata)) {
    if (EXISTING_LINK_TOP_LEVEL_CANONICAL_SKIP_KEYS.has(key)) continue;
    if (assignIfDifferent(nextMetadata, key, value)) {
      didChange = true;
    }
  }

  const currentExternalSession: Record<string, unknown> = { ...currentLink };
  const canonicalExternalSession = asMetadataRecord(canonicalMetadata.externalSessionV1);
  if (canonicalExternalSession) {
    const currentExternalSessionWithoutGeneration = {
      ...currentExternalSession,
    };
    const canonicalExternalSessionWithoutGeneration = {
      ...canonicalExternalSession,
    };
    delete currentExternalSessionWithoutGeneration.linkedAtMs;
    delete canonicalExternalSessionWithoutGeneration.linkedAtMs;
    const nextExternalSessionWithoutGeneration = {
      ...currentExternalSessionWithoutGeneration,
      ...canonicalExternalSessionWithoutGeneration,
    };
    const linkIdentityChanged = !deepEqual(
      currentExternalSessionWithoutGeneration,
      nextExternalSessionWithoutGeneration,
    );
    const currentLinkGeneration =
      typeof currentExternalSession.linkedAtMs === 'number'
      && Number.isSafeInteger(currentExternalSession.linkedAtMs)
      && currentExternalSession.linkedAtMs >= 0
        ? currentExternalSession.linkedAtMs
        : null;
    const nextLinkGeneration = linkIdentityChanged && currentLinkGeneration !== null
      ? Math.max(params.nowMs, currentLinkGeneration + 1)
      : currentLinkGeneration ?? params.nowMs;
    const nextExternalSession: Record<string, unknown> = {
      ...currentExternalSession,
      ...canonicalExternalSession,
      linkedAtMs: nextLinkGeneration,
    };
    if (
      currentLinkGeneration !== null
      && nextLinkGeneration > currentLinkGeneration
    ) {
      delete nextExternalSession.followStatusV1;
      delete nextExternalSession.lastFollowIssueV1;
    }
    if (!deepEqual(currentExternalSession, nextExternalSession)) {
      nextMetadata = buildLinkedExternalSessionMetadataV1(
        nextMetadata,
        nextExternalSession as LinkedExternalSessionV1,
      );
      didChange = true;
    }
    if (
      linkIdentityChanged
      || currentLinkGeneration !== nextLinkGeneration
    ) {
      nextMetadata = clearSessionStateFieldFromMetadata(
        nextMetadata,
        'runtime.externalAgent',
      );
    }
  }

  const snapshot = params.connectedServiceRuntimeSnapshot;
  if (snapshot && hasConnectedServiceBindings(snapshot)) {
    const currentSnapshot = readConnectedServiceRuntimeSnapshot(params.currentMetadata);
    const currentUpdatedAt = currentSnapshot.connectedServicesUpdatedAt;
    const nextUpdatedAt = snapshot.connectedServicesUpdatedAt;
    const isOlderThanCurrent =
      currentSnapshot.connectedServices
      && currentUpdatedAt !== undefined
      && nextUpdatedAt !== undefined
      && nextUpdatedAt < currentUpdatedAt;
    if (!isOlderThanCurrent && uniqueSnapshotKey(currentSnapshot) !== uniqueSnapshotKey(snapshot)) {
      nextMetadata.connectedServices = snapshot.connectedServices;
      if (nextUpdatedAt !== undefined) {
        nextMetadata.connectedServicesUpdatedAt = nextUpdatedAt;
      }
      if (snapshot.connectedServiceMaterializationIdentityV1) {
        nextMetadata.connectedServiceMaterializationIdentityV1 = snapshot.connectedServiceMaterializationIdentityV1;
      }
      didChange = true;
    }
  }

  const compatibilityNormalized = normalizeLinkedExternalSessionMetadataV1(nextMetadata, 'stored') ?? nextMetadata;
  if (!deepEqual(nextMetadata, compatibilityNormalized)) {
    didChange = true;
  }
  return didChange ? compatibilityNormalized : null;
}

export async function refreshExistingExternalSessionMetadataIfNeeded(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  sessionId: string;
  tag: string;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  sessionStateUpdates?: readonly SessionStateMetadataUpdateV1[];
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
  titleHint?: string | null;
  directoryHint?: string | null;
  shouldCommit?: () => boolean;
  signal?: AbortSignal;
  nowMs: number;
  resolveSourceKey(source: ExternalSessionsSource): string | null;
  expectedCurrentLink: LinkedExternalSessionV1;
}>): Promise<void> {
  const hasDisplayRefresh = Boolean(normalizeNullableString(params.titleHint) || normalizeNullableString(params.directoryHint));
  const hasIdentityRefresh = Boolean(
    params.qualifiedIdentity
    || params.runtimeDescriptor
    || params.sessionStateUpdates?.length
    || hasOwnRecordValues(params.vendorMetadata)
    || hasOwnRecordValues(params.externalSessionMetadata)
    || hasConnectedServiceBindings(params.connectedServiceRuntimeSnapshot ?? {}),
  );
  if (!hasDisplayRefresh && !hasIdentityRefresh) {
    return;
  }

  const rawSession = await fetchSessionById({
    reason: 'session-control',
    token: params.credentials.token,
    sessionId: params.sessionId,
  }).catch(() => null);
  if (!rawSession) return;

  const initialMetadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    rawSession,
    accountEncryptionMode: params.accountEncryptionCurrentness.mode,
  });
  const initialMetadataRecord = asMetadataRecord(initialMetadata);
  if (!initialMetadataRecord) return;

  const nextMetadata = resolveRefreshedExternalSessionMetadata({
    currentMetadata: initialMetadataRecord,
    tag: params.tag,
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    qualifiedIdentity: params.qualifiedIdentity,
    runtimeDescriptor: params.runtimeDescriptor,
    sessionStateUpdates: params.sessionStateUpdates,
    vendorMetadata: params.vendorMetadata,
    externalSessionMetadata: params.externalSessionMetadata,
    connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
    titleHint: params.titleHint,
    directoryHint: params.directoryHint,
    nowMs: params.nowMs,
    resolveSourceKey: params.resolveSourceKey,
    expectedCurrentLink: params.expectedCurrentLink,
  });
  if (!nextMetadata) return;
  assertExternalSessionLinkCommitPrecondition(params.shouldCommit);

  const updateMetadata: Parameters<typeof updateSessionMetadataWithRetry>[0]['updater'] = (currentMetadata) => {
    assertExternalSessionLinkCommitPrecondition(params.shouldCommit);
    return resolveRefreshedExternalSessionMetadata({
      currentMetadata,
      tag: params.tag,
      machineId: params.machineId,
      agentId: params.agentId,
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      qualifiedIdentity: params.qualifiedIdentity,
      runtimeDescriptor: params.runtimeDescriptor,
      sessionStateUpdates: params.sessionStateUpdates,
      vendorMetadata: params.vendorMetadata,
      externalSessionMetadata: params.externalSessionMetadata,
      connectedServiceRuntimeSnapshot: params.connectedServiceRuntimeSnapshot,
      titleHint: params.titleHint,
      directoryHint: params.directoryHint,
      nowMs: params.nowMs,
      resolveSourceKey: params.resolveSourceKey,
      expectedCurrentLink: params.expectedCurrentLink,
    }) ?? currentMetadata;
  };
  if (await publishLinkedSessionProject({ credentials: params.credentials,
    accountEncryptionCurrentness: params.accountEncryptionCurrentness, rawSession, metadata: nextMetadata,
    signal: params.signal, assertCurrent: () => assertExternalSessionLinkCommitPrecondition(params.shouldCommit), updateMetadata,
  })) return;
  await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
    accountEncryptionCurrentness: params.accountEncryptionCurrentness,
    updater: updateMetadata,
  }).catch((error: unknown) => {
    if (isExternalSessionProviderFailureError(error)) throw error;
    return undefined;
  });
}

export function assertExternalSessionLinkCommitPrecondition(
  shouldCommit: (() => boolean) | undefined,
): void {
  if (!shouldCommit || shouldCommit()) return;
  throw new ExternalSessionProviderFailureError({
    code: 'cancelled',
    message: 'external_session_link_commit_precondition_failed',
    operation: 'externalSession.linkEnsureCommit',
  });
}

/**
 * Canonical constructor for a linked external session's persisted envelope.
 * Exported so the first-party link guard can assert the real envelope every
 * registered Agent produces, instead of a re-implementation of this order.
 */
export function buildExternalSessionMetadata(params: Readonly<{
  tag: string;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  sessionStateUpdates?: readonly SessionStateMetadataUpdateV1[];
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  connectedServiceRuntimeSnapshot?: ConnectedServiceRuntimeSnapshot;
  titleHint?: string | null;
  directoryHint?: string | null;
  nowMs: number;
}>): Record<string, unknown> {
  const titleHint = normalizeNullableString(params.titleHint);
  const directoryHint = normalizeNullableString(params.directoryHint) ?? '';
  const resume = getAgentResumeConfig(params.agentId);
  const vendorResumeIdField = resume && 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
  const sessionStateRuntimeDescriptor = params.sessionStateUpdates?.find((update) =>
    update.fieldId === 'identity.runtimeDescriptor'
  )?.value as RuntimeDescriptorV1 | null | undefined;
  const runtimeDescriptor = sessionStateRuntimeDescriptor ?? params.runtimeDescriptor ?? null;
  const externalSessionMetadata = applyRuntimeDescriptorSessionMetadata(
    params.externalSessionMetadata ?? {},
    null,
  );
  const vendorMetadata = applyRuntimeDescriptorSessionMetadata(
    params.vendorMetadata ?? {},
    null,
  );
  // Agent-supplied records are laid down FIRST so the host's own identity and
  // custody facts, written last, can never be shadowed by a colliding key.
  const externalSessionV1 = {
    ...applyRuntimeDescriptorSessionMetadata(
      externalSessionMetadata as Record<string, unknown>,
      runtimeDescriptor,
    ),
    v: 1 as const,
    agentId: params.agentId,
    machineId: params.machineId,
    remoteSessionId: params.remoteSessionId,
    source: params.source,
    linkedAtMs: params.nowMs,
    qualifiedIdentity: params.qualifiedIdentity,
  };
  const baseWithoutLink: Record<string, unknown> = {
    ...applyRuntimeDescriptorSessionMetadata(
      vendorMetadata as Record<string, unknown>,
      runtimeDescriptor,
    ),
    tag: params.tag,
    path: directoryHint,
    host: os.hostname(),
    machineId: params.machineId,
    flavor: params.agentId,
    ...(vendorResumeIdField
      ? buildProviderSessionIdSessionMetadata({
        metadataKey: vendorResumeIdField,
        value: params.remoteSessionId,
      })
      : {}),
    ...(hasConnectedServiceBindings(params.connectedServiceRuntimeSnapshot ?? {})
      ? {
        connectedServices: params.connectedServiceRuntimeSnapshot?.connectedServices,
        ...(params.connectedServiceRuntimeSnapshot?.connectedServicesUpdatedAt !== undefined
          ? { connectedServicesUpdatedAt: params.connectedServiceRuntimeSnapshot.connectedServicesUpdatedAt }
          : {}),
        ...(params.connectedServiceRuntimeSnapshot?.connectedServiceMaterializationIdentityV1
          ? {
            connectedServiceMaterializationIdentityV1:
              params.connectedServiceRuntimeSnapshot.connectedServiceMaterializationIdentityV1,
          }
          : {}),
      }
      : {}),
  };
  const base = buildLinkedExternalSessionMetadataV1(baseWithoutLink, externalSessionV1);
  const metadataWithSessionState = params.sessionStateUpdates?.length
    ? applySessionStateUpdatesToMetadata(base, params.sessionStateUpdates)
    : base;
  if (titleHint) {
    return applyDisplayTitleSessionMetadata(metadataWithSessionState, {
      title: titleHint,
      staleBehavior: 'bump-if-value-changed',
    });
  }

  return metadataWithSessionState;
}

