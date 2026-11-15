import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import type {
  SessionPermissionMediationRecordIdentityV1 as TransportIdentity,
  SessionPermissionMediationRecordStored,
  SessionPermissionRemoteGrantRecordV1,
  SessionPermissionRemoteSettlementRecordV1,
  SessionSystemRecordContent,
} from '@happier-dev/protocol';
import { SessionPermissionMediationRecordStoredSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { SessionPermissionRemoteGrantRecordV1Schema, SessionPermissionRemoteSettlementRecordV1Schema } from '@happier-dev/protocol/sessions/permissions/mediationRecordsV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

import type { SessionClientPort } from '@/api/session/sessionClientPort';
import {
  openSessionStoredContent,
  sealSessionStoredContent,
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';

/** Native request-scoped answers have one row per human command, even when a tool reuses its request id. */
export type PermissionMediationRecordIdentity = TransportIdentity & Readonly<{ responseKey?: string }>;

function transportIdentity(identity: PermissionMediationRecordIdentity): TransportIdentity {
  return {
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    requestId: identity.responseKey === undefined ? identity.requestId : `native-response:${computeCanonicalDomainSeparatedDigest(
      'happier.native-permission-response.v1', [identity.requestId, identity.responseKey],
    )}`,
  };
}

/**
 * The host-only authority seam for remote permission mediation records.
 *
 * It is deliberately not wired to the plugin System Records transport: that
 * transport cannot authenticate a caller-selected plugin namespace. The
 * concrete daemon-to-server port below is fixed to these host-owned rows and
 * exposes no generic record CRUD to a plugin or action caller.
 */
export type PermissionMediationRecordWrite =
  | Readonly<{
      kind: 'remote_settlement.v1';
      record: SessionPermissionRemoteSettlementRecordV1;
    }>
  | Readonly<{
      kind: 'remote_grant.v1';
      record: SessionPermissionRemoteGrantRecordV1;
    }>;

export type PermissionMediationStoredRecord =
  | Readonly<{
      identity: PermissionMediationRecordIdentity;
      kind: 'remote_settlement.v1';
      record: SessionPermissionRemoteSettlementRecordV1;
      revision: string;
    }>
  | Readonly<{
      identity: PermissionMediationRecordIdentity;
      kind: 'remote_grant.v1';
      record: SessionPermissionRemoteGrantRecordV1;
      revision: string;
    }>;

export type PermissionMediationRecordStore = Readonly<{
  /**
   * Reads the one durable remote decision associated with the exact causal
   * Session/turn/request identity. This remains a domain lookup rather than
   * a generic System Records read.
   */
  read(params: Readonly<{
    identity: PermissionMediationRecordIdentity;
    signal?: AbortSignal;
  }>): Promise<
    | Readonly<{ status: 'found'; stored: PermissionMediationStoredRecord }>
    | Readonly<{ status: 'absent' }>
    | Readonly<{ status: 'unavailable' }>
  >;

  /**
   * Atomically claims one terminal remote decision for the exact causal
   * identity.
   *
   * `expected absent` is scoped to that tuple at the domain owner; it is not
   * a generic upsert and it does not make row addressing public.
   */
  createExpectedAbsent(params: Readonly<{
    identity: PermissionMediationRecordIdentity;
    signal?: AbortSignal;
  }> & PermissionMediationRecordWrite): Promise<
    | Readonly<{ status: 'created'; stored: PermissionMediationStoredRecord }>
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'unavailable' }>
  >;

  /** Enumerates the fixed mediation record family for restart hydration. */
  list(params: Readonly<{
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<
    | Readonly<{
        status: 'ready';
        records: readonly PermissionMediationStoredRecord[];
        nextCursor: string | null;
        hasNext: boolean;
      }>
    | Readonly<{ status: 'unavailable' }>
  >;

  /**
   * Deletes one already-opened inactive record by its exact revision. The
   * caller owns the decrypted classification; this fixed operation is not a
   * generic System Records delete.
   */
  pruneInactive(params: Readonly<{
    identity: PermissionMediationRecordIdentity;
    expectedRevision: string;
    signal?: AbortSignal;
  }>): Promise<
    | Readonly<{ status: 'pruned' }>
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'unavailable' }>
  >;

  /** CAS is used solely to append a durable grant revocation. */
  compareAndSet(params: Readonly<{
    identity: PermissionMediationRecordIdentity;
    expectedRevision: string;
    signal?: AbortSignal;
  }> & PermissionMediationRecordWrite): Promise<
    | Readonly<{ status: 'updated'; stored: PermissionMediationStoredRecord }>
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'unavailable' }>
  >;
}>;

type StoredContentContext = SessionStoredContentCryptoContext;

function storedContentContext(session: SessionClientPort): StoredContentContext | null {
  const context = session.getStoredContentEncryptionContext?.();
  if (!context) return null;
  if (context.mode === 'plain') return { mode: 'plain', ctx: null };
  return context.ctx ? { mode: 'e2ee', ctx: context.ctx } : null;
}

function parseRecord(kind: PermissionMediationRecordWrite['kind'], value: unknown): PermissionMediationRecordWrite['record'] | null {
  const parsed = kind === 'remote_settlement.v1'
    ? SessionPermissionRemoteSettlementRecordV1Schema.safeParse(value)
    : SessionPermissionRemoteGrantRecordV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function sealRecord(
  context: StoredContentContext,
  write: PermissionMediationRecordWrite,
): SessionSystemRecordContent | null {
  const record = parseRecord(write.kind, write.record);
  if (!record) return null;
  try {
    return sealSessionStoredContent({ ...context, payload: record });
  } catch {
    return null;
  }
}

function openStoredRecord(
  context: StoredContentContext,
  raw: unknown,
  expectedIdentity?: PermissionMediationRecordIdentity,
): PermissionMediationStoredRecord | null {
  const parsed = createStoredReadSchema(SessionPermissionMediationRecordStoredSchema).safeParse(raw);
  if (!parsed.success) return null;
  const stored = openMediationRecordPayload(context, parsed.data);
  if (!stored || (expectedIdentity && !sameIdentity(stored.identity, expectedIdentity))) return null;
  return stored;
}

function sameIdentity(
  left: PermissionMediationRecordIdentity,
  right: PermissionMediationRecordIdentity,
): boolean {
  return left.sessionId === right.sessionId
    && left.turnId === right.turnId
    && left.requestId === right.requestId
    && left.responseKey === right.responseKey;
}

function recordMatchesIdentity(
  record: PermissionMediationRecordWrite['record'],
  identity: PermissionMediationRecordIdentity,
): boolean {
  return record.turnId === identity.turnId && record.requestId === identity.requestId
    && (identity.responseKey === undefined || record.idempotencyKey === identity.responseKey);
}

function openMediationRecordPayload(
  context: StoredContentContext,
  raw: SessionPermissionMediationRecordStored,
): PermissionMediationStoredRecord | null {
  let payload: unknown;
  try {
    payload = openSessionStoredContent({ ...context, content: raw.content });
  } catch {
    return null;
  }
  const opened = readRecordPayload(raw.kind, payload);
  if (!opened) return null;
  const identity: PermissionMediationRecordIdentity = {
    sessionId: raw.sessionId, turnId: opened.record.turnId, requestId: opened.record.requestId,
    ...(raw.requestId !== opened.record.requestId ? { responseKey: opened.record.idempotencyKey } : {}),
  };
  const address = transportIdentity(identity);
  if (raw.turnId !== address.turnId || raw.requestId !== address.requestId) return null;
  return { ...opened, identity, revision: raw.revision };
}

function readRecordPayload(kind: PermissionMediationRecordWrite['kind'], payload: unknown): PermissionMediationRecordWrite | null {
  if (kind === 'remote_settlement.v1') {
    const parsed = createStoredReadSchema(SessionPermissionRemoteSettlementRecordV1Schema).safeParse(payload);
    return parsed.success ? { kind, record: parsed.data } : null;
  }
  const parsed = createStoredReadSchema(SessionPermissionRemoteGrantRecordV1Schema).safeParse(payload);
  return parsed.success ? { kind, record: parsed.data } : null;
}

function isConflict(error: unknown): boolean {
  const record = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : null;
  if (record?.code === 'permission_mediation_record_conflict') return true;
  const response = record?.response && typeof record.response === 'object'
    ? record.response as Record<string, unknown>
    : null;
  return response?.status === 409;
}

/**
 * Binds the narrow host-owned HTTP transport to one session.  It intentionally
 * has no generic System Records fallback: unavailable storage must leave
 * remote mediation unavailable rather than silently moving authority local.
 */
export function createPermissionMediationRecordStore(
  session: SessionClientPort,
): PermissionMediationRecordStore | null {
  if (
    typeof session.readPermissionMediationRecord !== 'function'
    || typeof session.writePermissionMediationRecord !== 'function'
    || typeof session.listPermissionMediationRecords !== 'function'
    || typeof session.prunePermissionMediationRecord !== 'function'
    || !storedContentContext(session)
  ) {
    return null;
  }

  return Object.freeze({
    async read(params) {
      const context = storedContentContext(session);
      if (!context || params.identity.sessionId !== session.sessionId) return { status: 'unavailable' };
      try {
        const raw = await session.readPermissionMediationRecord?.({
          identity: transportIdentity(params.identity),
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!raw) return { status: 'absent' };
        const stored = openStoredRecord(context, raw, params.identity);
        return stored ? { status: 'found', stored } : { status: 'unavailable' };
      } catch {
        return { status: 'unavailable' };
      }
    },

    async createExpectedAbsent(params) {
      const context = storedContentContext(session);
      if (
        !context
        || params.identity.sessionId !== session.sessionId
        || !recordMatchesIdentity(params.record, params.identity)
      ) return { status: 'unavailable' };
      const content = sealRecord(context, params);
      if (!content) return { status: 'unavailable' };
      try {
        const raw = await session.writePermissionMediationRecord?.({
          identity: transportIdentity(params.identity),
          request: { kind: params.kind, content, expectedRevision: null },
          ...(params.signal ? { signal: params.signal } : {}),
        });
        const stored = openStoredRecord(context, raw, params.identity);
        return stored ? { status: 'created', stored } : { status: 'unavailable' };
      } catch (error) {
        return isConflict(error) ? { status: 'conflict' } : { status: 'unavailable' };
      }
    },

    async list(params) {
      const context = storedContentContext(session);
      if (!context) return { status: 'unavailable' };
      try {
        const page = await session.listPermissionMediationRecords?.({
          query: {
            limit: Math.min(500, Math.max(1, Math.floor(params.limit ?? 500))),
            ...(params.cursor ? { cursor: params.cursor } : {}),
          },
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!page) return { status: 'unavailable' };
        const records: PermissionMediationStoredRecord[] = [];
        for (const raw of page.records) {
          const stored = openStoredRecord(context, raw);
          if (!stored || stored.identity.sessionId !== session.sessionId) return { status: 'unavailable' };
          records.push(stored);
        }
        return {
          status: 'ready',
          records,
          nextCursor: page.nextCursor,
          hasNext: page.hasNext,
        };
      } catch {
        return { status: 'unavailable' };
      }
    },

    async pruneInactive(params) {
      if (!storedContentContext(session) || params.identity.sessionId !== session.sessionId) {
        return { status: 'unavailable' };
      }
      try {
        await session.prunePermissionMediationRecord?.({
          identity: transportIdentity(params.identity),
          request: { expectedRevision: params.expectedRevision },
          ...(params.signal ? { signal: params.signal } : {}),
        });
        return { status: 'pruned' };
      } catch (error) {
        return isConflict(error) ? { status: 'conflict' } : { status: 'unavailable' };
      }
    },

    async compareAndSet(params) {
      const context = storedContentContext(session);
      if (
        !context
        || params.identity.sessionId !== session.sessionId
        || !recordMatchesIdentity(params.record, params.identity)
      ) return { status: 'unavailable' };
      const content = sealRecord(context, params);
      if (!content) return { status: 'unavailable' };
      try {
        const raw = await session.writePermissionMediationRecord?.({
          identity: transportIdentity(params.identity),
          request: {
            kind: params.kind,
            content,
            expectedRevision: params.expectedRevision,
          },
          ...(params.signal ? { signal: params.signal } : {}),
        });
        const stored = openStoredRecord(context, raw, params.identity);
        return stored ? { status: 'updated', stored } : { status: 'unavailable' };
      } catch (error) {
        return isConflict(error) ? { status: 'conflict' } : { status: 'unavailable' };
      }
    },
  });
}
