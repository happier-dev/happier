import {
  SessionSystemRecordNamespaceSchema,
  getSessionSystemRecordPayloadSchema,
  type SessionSystemRecordContent,
} from '@happier-dev/protocol';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agent-runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import type { SessionClientPort } from '@/api/session/sessionClientPort';
import {
  decryptSessionPayload,
  encryptSessionPayload,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

type SessionSystemRecordsService = AgentSessionHostServices['systemRecords'];

type StoredContentContext = Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
}>;

function parseRegisteredPayload(namespace: string, kind: string, payload: unknown): JsonValue {
  const payloadSchema = getSessionSystemRecordPayloadSchema(namespace, kind);
  if (!payloadSchema) {
    throw new Error(`Invalid session system record namespace/kind: ${namespace}/${kind}`);
  }
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Invalid session system record payload for ${namespace}/${kind}`);
  }
  return parsed.data as JsonValue;
}

function requireBoundSession(session: SessionClientPort): void {
  if (session.sessionId.trim().length === 0) {
    throw new Error('Session system records require a bound session id');
  }
}

function requireStoredContentContext(session: SessionClientPort): StoredContentContext {
  const context = session.getStoredContentEncryptionContext?.();
  if (!context) {
    throw new Error('Session system records require a session storage encryption context');
  }
  return context;
}

function sealPayload(context: StoredContentContext, payload: JsonValue): SessionSystemRecordContent {
  if (context.mode === 'plain') {
    return { t: 'plain', v: payload };
  }
  if (!context.ctx) {
    throw new Error('Missing session encryption context for encrypted system record');
  }
  return {
    t: 'encrypted',
    c: encryptSessionPayload({ ctx: context.ctx, payload }),
  };
}

function openPayload(context: StoredContentContext, content: SessionSystemRecordContent): unknown {
  if (content.t === 'plain') {
    return content.v;
  }
  if (!context.ctx) {
    throw new Error('Missing session encryption context for encrypted system record');
  }
  return decryptSessionPayload({ ctx: context.ctx, ciphertextBase64: content.c });
}

export function createSessionSystemRecordPayloadService(
  session: SessionClientPort,
): SessionSystemRecordsService {
  return Object.freeze({
    async write(request) {
      const payload = parseRegisteredPayload(request.namespace, request.kind, request.payload);
      requireBoundSession(session);
      if (typeof session.upsertSessionSystemRecord !== 'function') {
        throw new Error('Session system records require a session-owned writer');
      }
      const context = requireStoredContentContext(session);
      const content = sealPayload(context, payload);
      await session.upsertSessionSystemRecord({
        namespace: request.namespace,
        kind: request.kind,
        localId: request.localId,
        content,
      });
    },
    async read(request) {
      if (!SessionSystemRecordNamespaceSchema.safeParse(request.namespace).success) {
        throw new Error(`Invalid session system record namespace: ${request.namespace}`);
      }
      requireBoundSession(session);
      if (typeof session.fetchSessionSystemRecord !== 'function') {
        throw new Error('Session system records require a session-owned reader');
      }
      const context = requireStoredContentContext(session);
      const record = await session.fetchSessionSystemRecord({
        namespace: request.namespace,
        localId: request.localId,
      });
      if (!record) return null;
      if (record.namespace !== request.namespace || record.localId !== request.localId) {
        throw new Error('Session system record lookup returned a mismatched record identity');
      }
      const payload = parseRegisteredPayload(
        record.namespace,
        record.kind,
        openPayload(context, record.content),
      );
      return Object.freeze({
        namespace: record.namespace,
        kind: record.kind,
        localId: record.localId,
        payload,
      });
    },
  });
}
