import {
  resolveAgentIdFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import { SessionExternalIdentityTagV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import {
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  resolveExternalHistoryImportV1FromMetadata,
} from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';

import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import type { StoredCredentials } from '@/persistence';
import type { ExternalSessionSourceKeyOwner } from '@/plugins/projection/registry/externalSessionSources';
import { logger } from '@/utils/logger';

import {
  readExternalSessionAccountRows,
  type ExternalSessionAccountScanRow,
} from './externalSessionAccountScan';
import {
  claimExternalSessionIdentity,
  isExternalSessionIdentityBackfillComplete,
  markExternalSessionIdentityBackfillComplete,
  metadataProvesExternalHistoryImportIdentity,
  metadataProvesExternalSessionIdentity,
} from './externalSessionIdentity';
import { resolveHostedExternalSessionIdentityProof } from './hostedExternalSessionIdentity';
import { resolveExternalSessionIdentityTag } from './externalSessionTagLookupCandidates';

export type ExternalSessionIdentityBackfillDeps = Readonly<{
  resolveSourceKeyOwner(
    agentId: ExternalSessionsAgentId,
    source: ExternalSessionsSource,
  ): Promise<ExternalSessionSourceKeyOwner | null>;
  /** Identity tag of a native session a hosted Session runs, or null when no configured source holds it. */
  resolveHostedIdentityTag(
    input: Readonly<{ agentId: ExternalSessionsAgentId; remoteSessionId: string; signal?: AbortSignal }>,
  ): Promise<string | null>;
}>;

export type ExternalSessionIdentityBackfillResult =
  | Readonly<{ status: 'already_complete' }>
  | Readonly<{
      status: 'completed';
      rows: number;
      claimed: number;
      alreadyClaimed: number;
      conflicts: number;
      unresolved: number;
    }>;

type RowIdentity =
  | Readonly<{ kind: 'tag'; tag: string }>
  | Readonly<{ kind: 'unresolved' }>
  | null;

function isIdentityTag(value: unknown): value is string {
  return SessionExternalIdentityTagV1Schema.safeParse(value).success;
}

/**
 * Derives the one external conversation a released row proves, with the same
 * proofs `link.ensure`'s Account scan applied, in its classification order:
 * a history import (incl. 0.2 handoff targets), then a live link (the row's
 * stored identity tag — what the scan's tag match compared), then a hosted
 * Session that recorded its native resume id. Only rows of this Machine.
 */
async function deriveRowIdentity(
  row: ExternalSessionAccountScanRow,
  machineId: string,
  deps: ExternalSessionIdentityBackfillDeps,
  signal: AbortSignal | undefined,
): Promise<RowIdentity> {
  const metadata = row.metadata;
  if (!metadata || metadata.machineId !== machineId) return null;

  const historyImport = resolveExternalHistoryImportV1FromMetadata(metadata, 'stored');
  if (historyImport.state === 'invalid') return null;
  if (historyImport.state === 'valid') {
    const imported = historyImport.historyImport;
    const agentId = imported.agentId as ExternalSessionsAgentId;
    const owner = await deps.resolveSourceKeyOwner(agentId, imported.source);
    if (!owner) return { kind: 'unresolved' };
    const expected = {
      machineId,
      agentId,
      remoteSessionId: imported.remoteSessionId,
      source: imported.source,
      resolveSourceKey: owner.resolveSourceKey,
    };
    if (!metadataProvesExternalHistoryImportIdentity(metadata, expected)) return null;
    return {
      kind: 'tag',
      tag: resolveExternalSessionIdentityTag(expected, owner.sourceKey),
    };
  }

  const linked = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  if (linked) {
    if (linked.machineId !== machineId) return null;
    // A legacy-layout link keeps its identity tag in metadata: that exact tag
    // is what the Account scan's tag match compared.
    const storedTag = typeof metadata.tag === 'string' ? metadata.tag.trim() : '';
    if (isIdentityTag(storedTag)) return { kind: 'tag', tag: storedTag };
    // A 0.2 direct handoff target kept its original Happier tag and names the
    // conversation only through its released link record.
    const agentId = linked.agentId as ExternalSessionsAgentId;
    const owner = await deps.resolveSourceKeyOwner(agentId, linked.source);
    if (!owner) return { kind: 'unresolved' };
    const expected = {
      machineId,
      agentId,
      remoteSessionId: linked.remoteSessionId,
      source: linked.source,
      resolveSourceKey: owner.resolveSourceKey,
    };
    if (!metadataProvesExternalSessionIdentity(metadata, expected)) return null;
    return { kind: 'tag', tag: resolveExternalSessionIdentityTag(expected, owner.sourceKey) };
  }

  const agentId = resolveAgentIdFromSessionMetadata(metadata) as ExternalSessionsAgentId | null;
  const remoteSessionId = agentId ? resolveVendorResumeIdFromSessionMetadata(agentId, metadata) : null;
  if (!agentId || !remoteSessionId) return null;
  const hosted = resolveHostedExternalSessionIdentityProof({
    metadata,
    currentStorageState: row.currentStorageState,
    currentStorageStateWasOmitted: row.currentStorageStateWasOmitted,
    expected: { machineId, agentId, remoteSessionId },
  });
  if (hosted.state !== 'matched') return null;
  const tag = await deps.resolveHostedIdentityTag({
    agentId,
    remoteSessionId,
    ...(signal ? { signal } : {}),
  });
  return tag ? { kind: 'tag', tag } : { kind: 'unresolved' };
}

/**
 * One-time, per-Machine backfill of the server's external-identity index.
 *
 * Released rows identify their external conversation only inside encrypted
 * metadata (0.2 handoff targets, legacy-layout links, hosted Sessions that
 * recorded a native resume id). Only a key-holding daemon of the same Machine
 * can read them, so this reads every Account page once, claims each provable
 * identity through the one claim owner (first claimant in listing order wins,
 * as the Account scan's first match did), then records the Machine as done in
 * the per-Account KV. An interrupted run records nothing and reruns at the
 * next daemon start; `link.ensure` keeps its scan fallback until then and
 * never waits for this.
 */
export async function runExternalSessionIdentityBackfill(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  signal?: AbortSignal;
  nowMs?: () => number;
}>, deps: ExternalSessionIdentityBackfillDeps): Promise<ExternalSessionIdentityBackfillResult> {
  if (await isExternalSessionIdentityBackfillComplete({
    credentials: params.credentials,
    machineId: params.machineId,
    ...(params.signal ? { signal: params.signal } : {}),
  })) {
    return { status: 'already_complete' };
  }
  const currentness = await fetchAccountEncryptionCurrentness({
    credentials: params.credentials,
    token: params.credentials.token,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const counts = { rows: 0, claimed: 0, alreadyClaimed: 0, conflicts: 0, unresolved: 0 };
  for await (const row of readExternalSessionAccountRows({
    credentials: params.credentials,
    accountEncryptionMode: currentness.mode,
    ...(params.signal ? { signal: params.signal } : {}),
  })) {
    counts.rows += 1;
    const identity = await deriveRowIdentity(row, params.machineId, deps, params.signal);
    if (!identity) continue;
    if (identity.kind === 'unresolved') {
      counts.unresolved += 1;
      continue;
    }
    const claimed = await claimExternalSessionIdentity({
      credentials: params.credentials,
      sessionId: row.sessionId,
      externalIdentityTag: identity.tag,
      writer: 'backfill',
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (claimed === 'claimed') counts.claimed += 1;
    else if (claimed === 'already_claimed') counts.alreadyClaimed += 1;
    else counts.conflicts += 1;
  }
  await markExternalSessionIdentityBackfillComplete({
    credentials: params.credentials,
    machineId: params.machineId,
    nowMs: (params.nowMs ?? Date.now)(),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  logger.debug('[externalSessions.identity] backfill completed', counts);
  return { status: 'completed', ...counts };
}
