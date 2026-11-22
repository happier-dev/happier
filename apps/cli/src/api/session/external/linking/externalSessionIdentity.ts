import {
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  resolveExternalHistoryImportV1FromMetadata,
} from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';

import { createCliAccountKvJsonTransport } from '@/api/client/accountKvJsonTransport';
import type { StoredCredentials } from '@/persistence';
import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';
import {
  claimSessionExternalIdentity,
  lookupSessionsByTags,
  type SessionExternalIdentityClaimHttpResult,
} from '@/session/transport/http/sessionsHttp';
import { logger } from '@/utils/logger';

import type { HostExternalSessionFollowTargetResolution } from '@/session/external/privateContract';
import type { ExternalSessionSourceKeyOwner } from '@/plugins/projection/registry/externalSessionSources';

import { normalizeNullableString } from './linkedMetadata';
import { resolveExternalSessionIdentityTag } from './externalSessionTagLookupCandidates';

/**
 * One owner for "which Happier Session is this external conversation".
 *
 * The server records the answer once per Session as `externalIdentityTag`
 * (`resolveExternalSessionIdentityTag`), unique per Account, and
 * `lookup-by-tags` with `matchExternalIdentity` reads it. Every writer that
 * learns an identity (Browse link creation, a hosted Session recording its
 * native resume id, the per-Machine backfill of released rows) records it
 * through `claimExternalSessionIdentity`; every reader asks the indexed lookup.
 * Until this Machine's backfill has finished, `link.ensure` may still prove an
 * indexed absence by the bounded Account scan.
 */

type ExpectedExternalSessionIdentity = Readonly<{
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  source: ExternalSessionsSource;
  resolveSourceKey(source: ExternalSessionsSource): string | null;
}>;

export function metadataProvesExternalHistoryImportIdentity(
  metadata: Readonly<Record<string, unknown>>,
  expected: ExpectedExternalSessionIdentity,
): boolean {
  const resolution = resolveExternalHistoryImportV1FromMetadata(metadata, 'stored');
  if (resolution.state === 'invalid') {
    throw new ExternalSessionProviderFailureError({
      code: 'conflict',
      message: resolution.error,
      operation: 'externalSession.lookupByTags',
    });
  }
  if (resolution.state === 'absent') return false;
  const imported = resolution.historyImport;
  return metadata.machineId === expected.machineId
    && imported.agentId === expected.agentId
    && imported.remoteSessionId === expected.remoteSessionId
    && expected.resolveSourceKey(imported.source) === expected.resolveSourceKey(expected.source);
}

export function metadataProvesConnectedServiceGroup(metadata: Readonly<Record<string, unknown>>, expectedGroupId: string): boolean {
  const linkedSession = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  return linkedSession?.source.kind === 'codexHome'
    && linkedSession.source.home === 'connectedService'
    && normalizeNullableString(linkedSession.source.connectedServiceGroupId) === expectedGroupId;
}

export function metadataProvesExternalSessionIdentity(
  metadata: Readonly<Record<string, unknown>>,
  expected: ExpectedExternalSessionIdentity,
): boolean {
  const linkedSession = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  return linkedSession?.machineId === expected.machineId
    && linkedSession.agentId === expected.agentId
    && linkedSession.remoteSessionId === expected.remoteSessionId
    && expected.resolveSourceKey(linkedSession.source) === expected.resolveSourceKey(expected.source);
}

export function metadataProvesExternalSessionGroupIdentity(
  metadata: Readonly<Record<string, unknown>>,
  expected: Readonly<{ machineId: string; remoteSessionId: string; groupId: string }>,
): boolean {
  const linkedSession = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  return linkedSession?.machineId === expected.machineId
    && linkedSession.remoteSessionId === expected.remoteSessionId
    && linkedSession.source.kind === 'codexHome'
    && linkedSession.source.home === 'connectedService'
    && normalizeNullableString(linkedSession.source.connectedServiceGroupId) === expected.groupId;
}

/**
 * The identity of a native session a Happier-hosted Session runs: the
 * configured Agent source that holds that native id decides the source key, so
 * the tag equals the one Browse computes when it lists the same conversation.
 * Null when no configured source resolves the id.
 */
export async function resolveHostedExternalSessionIdentityTag(params: Readonly<{
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  resolveSourceIdentity(input: Readonly<{
    agentId: ExternalSessionsAgentId;
    remoteSessionId: string;
    signal?: AbortSignal;
  }>): Promise<HostExternalSessionFollowTargetResolution>;
  resolveSourceKeyOwner(
    agentId: ExternalSessionsAgentId,
    source: ExternalSessionsSource,
  ): ExternalSessionSourceKeyOwner | null | Promise<ExternalSessionSourceKeyOwner | null>;
  signal?: AbortSignal;
}>): Promise<string | null> {
  const target = await params.resolveSourceIdentity({
    agentId: params.agentId,
    remoteSessionId: params.remoteSessionId,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (target.status !== 'resolved') return null;
  const owner = await params.resolveSourceKeyOwner(params.agentId, target.source);
  if (!owner) return null;
  return resolveExternalSessionIdentityTag({
    machineId: params.machineId,
    agentId: params.agentId,
    remoteSessionId: target.ref.remoteSessionId,
  }, owner.sourceKey);
}

/** Read only the indexed claim, including a proven absence. The creation tag is not a witness. */
export async function lookupClaimedExternalSessionIdentity(params: Readonly<{
  token: string;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  sourceKey: string;
  signal: AbortSignal;
}>): Promise<{ sessionId: string; externalIdentityTag: string } | null | undefined> {
  const tag = resolveExternalSessionIdentityTag(params, params.sourceKey);
  const lookup = await lookupSessionsByTags({ token: params.token, tags: [tag], matchExternalIdentity: true, signal: params.signal });
  if (lookup.state !== 'available' || !lookup.externalIdentities) return undefined;
  const identity = lookup.externalIdentities.find(row => row.externalIdentityTag === tag);
  return identity ? { sessionId: identity.sessionId, externalIdentityTag: tag } : null;
}

export type ExternalSessionIdentityClaimResult =
  SessionExternalIdentityClaimHttpResult['status'];

/**
 * Records `externalIdentityTag` on `sessionId`. A Session may replace its own
 * identity (`replaced`: it moved to another native thread or Machine, and the
 * old identity no longer resolves to it). Another Session's identity is never
 * taken over: `taken` is a typed answer, logged, never thrown.
 */
export async function claimExternalSessionIdentity(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  externalIdentityTag: string;
  writer: 'link' | 'hosted' | 'backfill';
  signal?: AbortSignal;
}>): Promise<ExternalSessionIdentityClaimResult> {
  const result = await claimSessionExternalIdentity({
    token: params.credentials.token,
    sessionId: params.sessionId,
    externalIdentityTag: params.externalIdentityTag,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (result.status === 'conflict') {
    logger.debug('[externalSessions.identity] claim refused', {
      writer: params.writer,
      sessionId: params.sessionId,
      reason: result.reason,
    });
  }
  return result.status;
}

/**
 * Hosted-Session writer: called for every new native session id the runtime
 * reports, so a Session that moves to another native thread replaces its own
 * identity. Resolves the conversation's identity and records it on the hosted
 * Session; 'unresolved' when no configured Agent source holds the id.
 */
export async function recordHostedExternalSessionIdentity(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  machineId: string;
  agentId: ExternalSessionsAgentId;
  remoteSessionId: string;
  resolveSourceIdentity: Parameters<typeof resolveHostedExternalSessionIdentityTag>[0]['resolveSourceIdentity'];
  resolveSourceKeyOwner: Parameters<typeof resolveHostedExternalSessionIdentityTag>[0]['resolveSourceKeyOwner'];
  signal?: AbortSignal;
}>): Promise<ExternalSessionIdentityClaimResult | 'unresolved'> {
  const externalIdentityTag = await resolveHostedExternalSessionIdentityTag(params);
  if (!externalIdentityTag) {
    logger.debug('[externalSessions.identity] hosted native id has no configured source', {
      sessionId: params.sessionId,
      agentId: params.agentId,
    });
    return 'unresolved';
  }
  return await claimExternalSessionIdentity({
    credentials: params.credentials,
    sessionId: params.sessionId,
    externalIdentityTag,
    writer: 'hosted',
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

/** Per-Account KV record naming the Machines whose released rows are indexed. */
export function externalSessionIdentityBackfillKvKey(machineId: string): string {
  return `external-session-identity-backfill:v1:${machineId}`;
}

type BackfillMarkerV1 = Readonly<{ v: 1; completedAtMs: number }>;

function isBackfillMarker(value: unknown): value is BackfillMarkerV1 {
  return typeof value === 'object' && value !== null && (value as { v?: unknown }).v === 1;
}

function createBackfillMarkerTransport(credentials: StoredCredentials, machineId: string, signal?: AbortSignal) {
  return createCliAccountKvJsonTransport({
    credentials,
    key: externalSessionIdentityBackfillKvKey(machineId),
    ...(signal ? { signal } : {}),
    resolveAuthorizationHeaders: () => ({ Authorization: `Bearer ${credentials.token}` }),
  });
}

/**
 * "Done" is monotonic: once a Machine's backfill has completed, its released
 * rows stay indexed and every later writer claims at write time. Only that
 * positive fact is remembered in-process; a negative is re-read.
 */
const completedBackfills = new Set<string>();

function completionKey(credentials: StoredCredentials, machineId: string): string {
  return JSON.stringify([credentials.token, machineId]);
}

export async function isExternalSessionIdentityBackfillComplete(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  signal?: AbortSignal;
}>): Promise<boolean> {
  const key = completionKey(params.credentials, params.machineId);
  if (completedBackfills.has(key)) return true;
  const read = await createBackfillMarkerTransport(params.credentials, params.machineId, params.signal).read();
  if (!isBackfillMarker(read.value)) return false;
  completedBackfills.add(key);
  return true;
}

export async function markExternalSessionIdentityBackfillComplete(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  nowMs: number;
  signal?: AbortSignal;
}>): Promise<void> {
  const transport = createBackfillMarkerTransport(params.credentials, params.machineId, params.signal);
  const current = await transport.read();
  if (!isBackfillMarker(current.value)) {
    const marker: BackfillMarkerV1 = { v: 1, completedAtMs: params.nowMs };
    const written = await transport.compareAndSet(marker, current.version);
    // A concurrent writer completing the same Machine's backfill is the same fact.
    if (!written.success && !isBackfillMarker(written.value)) {
      throw new Error('External-session identity backfill marker write conflicted');
    }
  }
  completedBackfills.add(completionKey(params.credentials, params.machineId));
}

export function resetExternalSessionIdentityBackfillMemoForTests(): void {
  completedBackfills.clear();
}
