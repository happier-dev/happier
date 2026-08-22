import type {
  SessionPermissionMediationRecordIdentityV1,
  SessionPermissionMediationRecordStored,
  SessionPermissionRemoteGrantRecordV1,
  SessionPermissionRemoteSettlementRecordV1,
  SessionSystemRecordContent,
} from '@happier-dev/protocol';
import {
  SessionPermissionMediationRecordStoredSchema,
  SessionPermissionRemoteGrantRecordV1Schema,
  SessionPermissionRemoteSettlementRecordV1Schema,
} from '@happier-dev/protocol';

import type { SessionClientPort } from '@/api/session/sessionClientPort';
import {
  decryptSessionPayload,
  encryptSessionPayload,
  type SessionEncryptionContext,
} from '@/session/transport/encryption/sessionEncryptionContext';

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
      identity: SessionPermissionMediationRecordIdentityV1;
      kind: 'remote_settlement.v1';
      record: SessionPermissionRemoteSettlementRecordV1;
      revision: string;
    }>
  | Readonly<{
      identity: SessionPermissionMediationRecordIdentityV1;
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
    identity: SessionPermissionMediationRecordIdentityV1;
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
    identity: SessionPermissionMediationRecordIdentityV1;
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
    identity: SessionPermissionMediationRecordIdentityV1;
    expectedRevision: string;
    signal?: AbortSignal;
  }>): Promise<
    | Readonly<{ status: 'pruned' }>
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'unavailable' }>
  >;

  /** CAS is used solely to append a durable grant revocation. */
  compareAndSet(params: Readonly<{
    identity: SessionPermissionMediationRecordIdentityV1;
    expectedRevision: string;
    signal?: AbortSignal;
  }> & PermissionMediationRecordWrite): Promise<
    | Readonly<{ status: 'updated'; stored: PermissionMediationStoredRecord }>
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'unavailable' }>
  >;
}>;

type StoredContentContext = Readonly<
  | { mode: 'plain' }
  | { mode: 'e2ee'; ctx: SessionEncryptionContext }
>;

function storedContentContext(session: SessionClientPort): StoredContentContext | null {
  const context = session.getStoredContentEncryptionContext?.();
  if (!context) return null;
  if (context.mode === 'plain') return { mode: 'plain' };
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
  if (context.mode === 'plain') return { t: 'plain', v: record };
  try {
    return { t: 'encrypted', c: encryptSessionPayload({ ctx: context.ctx, payload: record }) };
  } catch {
    return null;
  }
}

function openStoredRecord(
  context: StoredContentContext,
  raw: unknown,
  expectedIdentity?: SessionPermissionMediationRecordIdentityV1,
): PermissionMediationStoredRecord | null {
  const parsed = SessionPermissionMediationRecordStoredSchema.safeParse(raw);
  if (!parsed.success) return null;
  const identity = {
    sessionId: parsed.data.sessionId,
    turnId: parsed.data.turnId,
    requestId: parsed.data.requestId,
  } satisfies SessionPermissionMediationRecordIdentityV1;
  if (expectedIdentity && !sameIdentity(identity, expectedIdentity)) return null;
  return openMediationRecordPayload(context, parsed.data, identity);
}

function sameIdentity(
  left: SessionPermissionMediationRecordIdentityV1,
  right: SessionPermissionMediationRecordIdentityV1,
): boolean {
  return left.sessionId === right.sessionId
    && left.turnId === right.turnId
    && left.requestId === right.requestId;
}

function recordMatchesIdentity(
  record: PermissionMediationRecordWrite['record'],
  identity: SessionPermissionMediationRecordIdentityV1,
): boolean {
  return record.turnId === identity.turnId && record.requestId === identity.requestId;
}

function openMediationRecordPayload(
  context: StoredContentContext,
  raw: SessionPermissionMediationRecordStored,
  identity: SessionPermissionMediationRecordIdentityV1,
): PermissionMediationStoredRecord | null {
  let payload: unknown;
  try {
    if (context.mode === 'plain') {
      if (raw.content.t !== 'plain') return null;
      payload = raw.content.v;
    } else {
      if (raw.content.t !== 'encrypted') return null;
      payload = decryptSessionPayload({
        ctx: context.ctx,
        ciphertextBase64: raw.content.c,
      });
    }
  } catch {
    return null;
  }
  if (raw.kind === 'remote_settlement.v1') {
    const record = SessionPermissionRemoteSettlementRecordV1Schema.safeParse(payload);
    if (!record.success || !recordMatchesIdentity(record.data, identity)) return null;
    return {
      identity,
      kind: 'remote_settlement.v1',
      record: record.data,
      revision: raw.revision,
    };
  }
  const record = SessionPermissionRemoteGrantRecordV1Schema.safeParse(payload);
  if (!record.success || !recordMatchesIdentity(record.data, identity)) return null;
  return {
    identity,
    kind: 'remote_grant.v1',
    record: record.data,
    revision: raw.revision,
  };
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
          identity: params.identity,
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
          identity: params.identity,
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
          identity: params.identity,
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
          identity: params.identity,
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
