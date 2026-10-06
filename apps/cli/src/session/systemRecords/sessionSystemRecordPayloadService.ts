import { LegacyHostSessionSystemRecordLookupQuerySchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { getSessionSystemRecordPayloadSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordCatalog';
import type { LegacyHostSessionSystemRecord, SessionSystemRecordKind, SessionSystemRecordContent } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import type { SessionClientPort } from '@/api/session/sessionClientPort';
import {
  openSessionStoredContent,
  sealSessionStoredContent,
  SessionStoredContentError,
  type SessionEncryptionContext,
  type SessionStoredContentCryptoContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionStoredContentCodec';

/**
 * Private host transport retained for the existing Claude workflow bridge.
 * It is intentionally not part of the SDK's author-facing session services.
 */
type SessionSystemRecordsService = Readonly<{
  write(request: Readonly<{
    namespace: LegacyHostSessionSystemRecord['namespace'];
    kind: SessionSystemRecordKind;
    localId: string;
    payload: JsonValue;
  }>): Promise<void>;
  read(request: Readonly<{
    namespace: LegacyHostSessionSystemRecord['namespace'];
    localId: string;
  }>): Promise<Readonly<{
    namespace: LegacyHostSessionSystemRecord['namespace'];
    kind: SessionSystemRecordKind;
    localId: string;
    payload: JsonValue;
  }> | null>;
}>;

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

function requireCanonicalStoredContentContext(
  context: StoredContentContext,
): SessionStoredContentCryptoContext {
  if (context.mode === 'plain') return { mode: 'plain', ctx: null };
  if (!context.ctx) {
    throw new Error('Missing session encryption context for encrypted system record');
  }
  return { mode: 'e2ee', ctx: context.ctx };
}

function sealPayload(context: StoredContentContext, payload: JsonValue): SessionSystemRecordContent {
  return sealSessionStoredContent({
    ...requireCanonicalStoredContentContext(context),
    payload,
  });
}

function openPayload(context: StoredContentContext, content: unknown): unknown {
  try {
    return openSessionStoredContent({
      ...requireCanonicalStoredContentContext(context),
      content,
    });
  } catch (error) {
    if (error instanceof SessionStoredContentError && error.code === 'session_content_mode_mismatch') {
      throw new Error('Session system record content did not match the Session encryption mode');
    }
    throw error;
  }
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
      if (!LegacyHostSessionSystemRecordLookupQuerySchema.safeParse(request).success) {
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
