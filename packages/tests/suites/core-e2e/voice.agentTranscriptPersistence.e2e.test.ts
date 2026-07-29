import { randomBytes, randomUUID } from 'node:crypto';

import type { VoiceTranscriptCanonicalEventV1 } from '@happier-dev/protocol';
import { afterAll, describe, expect, it } from 'vitest';

import { decryptTranscriptReplayCore } from '../../../../apps/cli/src/session/replay/decryptTranscriptReplayCore';
import { extractMemoryIndexableTranscriptItem } from '../../../../apps/cli/src/daemon/memory/transcript/extractIndexableItem';
import { extractSemanticTranscriptItem } from '../../../../apps/cli/src/session/services/transcript/extractSemanticTranscriptItem';
import {
  persistSessionTranscriptMessage,
  type PersistedSessionTranscriptMessage,
  type PersistSessionTranscriptMessageInput,
} from '../../../../apps/ui/sources/sync/domains/messages/persistSessionTranscriptMessage';
import { createVoiceTranscriptProjector } from '../../../../apps/ui/sources/voice/transcript/VoiceTranscriptProjector';
import { deriveBoxPublicKeyFromSeed } from '../../../protocol/src/crypto/boxBundle';
import {
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '../../../protocol/src/crypto/encryptedDataKeyEnvelopeV1';
import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { createRunDirs } from '../../src/testkit/runDir';
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector, type CapturedEvent } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type SessionEncryptionMode = 'plain' | 'e2ee';

type StoredTranscriptRow = Readonly<{
  id: string;
  seq: number;
  localId: string | null;
  messageRole: 'user' | 'agent' | 'event' | 'unknown' | null;
  content:
    | Readonly<{ t: 'plain'; v: unknown }>
    | Readonly<{ t: 'encrypted'; c: string }>;
  createdAt: number;
}>;

type PersistInvocation = Readonly<{
  input: PersistSessionTranscriptMessageInput;
  result: Promise<PersistedSessionTranscriptMessage>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStoredTranscriptRows(value: unknown): StoredTranscriptRow[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error('Invalid transcript response');
  }

  return value.messages.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`Invalid transcript row ${index}`);
    const content = candidate.content;
    if (!isRecord(content)) throw new Error(`Invalid transcript content ${index}`);
    const parsedContent = content.t === 'plain'
      ? { t: 'plain' as const, v: content.v }
      : content.t === 'encrypted' && typeof content.c === 'string'
        ? { t: 'encrypted' as const, c: content.c }
        : null;
    const messageRole = candidate.messageRole;
    const parsedMessageRole = messageRole === null
      || messageRole === 'user'
      || messageRole === 'agent'
      || messageRole === 'event'
      || messageRole === 'unknown'
      ? messageRole
      : undefined;

    if (
      typeof candidate.id !== 'string'
      || typeof candidate.seq !== 'number'
      || !Number.isFinite(candidate.seq)
      || !(candidate.localId === null || typeof candidate.localId === 'string')
      || parsedMessageRole === undefined
      || !parsedContent
      || typeof candidate.createdAt !== 'number'
      || !Number.isFinite(candidate.createdAt)
    ) {
      throw new Error(`Invalid transcript row ${index}`);
    }

    return {
      id: candidate.id,
      seq: candidate.seq,
      localId: candidate.localId,
      messageRole: parsedMessageRole,
      content: parsedContent,
      createdAt: candidate.createdAt,
    };
  });
}

function hasMessageUpdate(
  events: readonly CapturedEvent[],
  updateType: 'new-message' | 'message-updated',
  localId: string,
): boolean {
  return events.some((event) => {
    if (event.kind !== 'update') return false;
    const body = isRecord(event.payload?.body) ? event.payload.body : null;
    const message = isRecord(body?.message) ? body.message : null;
    return body?.t === updateType && message?.localId === localId;
  });
}

function hasSessionDeletedUpdate(events: readonly CapturedEvent[], sessionId: string): boolean {
  return events.some((event) => {
    if (event.kind !== 'update') return false;
    const body = isRecord(event.payload?.body) ? event.payload.body : null;
    return body?.t === 'delete-session' && (body.sid === sessionId || body.sessionId === sessionId);
  });
}

function buildFinalEvent(params: Readonly<{
  sequence: number;
  revision: number;
  itemId: string;
  role: 'user' | 'assistant';
  text: string;
  type?: 'voice.transcript.final' | 'voice.transcript.corrected';
}>): VoiceTranscriptCanonicalEventV1 {
  return {
    v: 1,
    type: params.type ?? 'voice.transcript.final',
    epoch: 1,
    sequence: params.sequence,
    revision: params.revision,
    eventId: `${params.itemId}:${params.revision}:${randomUUID()}`,
    itemId: params.itemId,
    role: params.role,
    text: params.text,
    provenance: 'live',
  };
}

async function createCarrierSession(params: Readonly<{
  baseUrl: string;
  token: string;
  mode: SessionEncryptionMode;
  encryptedDataKeyEnvelope: Uint8Array | null;
}>): Promise<string> {
  if (params.mode === 'e2ee' && params.encryptedDataKeyEnvelope === null) {
    throw new Error('E2EE carrier session requires a sealed data-key envelope');
  }
  const tag = `voice-agent-transcript-${params.mode}-${randomUUID()}`;
  const response = await fetchJson<{
    session?: Readonly<{ id?: unknown; encryptionMode?: unknown }>;
  }>(`${params.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag,
      encryptionMode: params.mode,
      metadata: params.mode === 'plain'
        ? JSON.stringify({ v: 1, tag })
        : Buffer.from(JSON.stringify({ v: 1, tag }), 'utf8').toString('base64'),
      agentState: null,
      dataEncryptionKey: params.mode === 'plain'
        ? null
        : Buffer.from(params.encryptedDataKeyEnvelope).toString('base64'),
    }),
    timeoutMs: 20_000,
  });
  const sessionId = response.data?.session?.id;
  expect(response.status).toBe(200);
  expect(response.data?.session?.encryptionMode).toBe(params.mode);
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error(`Failed to create ${params.mode} carrier session`);
  }
  return sessionId;
}
async function fetchStoredTranscriptRows(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<StoredTranscriptRow[]> {
  const response = await fetchJson<unknown>(
    `${params.baseUrl}/v1/sessions/${params.sessionId}/messages?afterSeq=0&limit=50`,
    {
      headers: { Authorization: `Bearer ${params.token}` },
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  return parseStoredTranscriptRows(response.data).sort((left, right) => left.seq - right.seq);
}

describe('core e2e: Agent-backed Voice transcript canonical persistence', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it.each<SessionEncryptionMode>(['plain', 'e2ee'])(
    'persists, ACKs, reloads, indexes, corrects, and deletes %s Voice finals through canonical owners',
    async (mode) => {
      if (!server) {
        server = await startServerLight({
          testDir: run.testDir('voice-agent-transcript-persistence'),
          extraEnv: {
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
          },
        });
      }
      const auth = await createTestAuth(server.baseUrl);
      const otherAuth = await createTestAuth(server.baseUrl);
      const dataKey = new Uint8Array(randomBytes(32));
      const encryptedDataKeyEnvelope = mode === 'e2ee'
        ? sealEncryptedDataKeyEnvelopeV1({
            dataKey,
            recipientPublicKey: deriveBoxPublicKeyFromSeed(auth.accountSigningSeed),
            randomBytes: (length) => new Uint8Array(randomBytes(length)),
          })
        : null;
      const sessionId = await createCarrierSession({
        baseUrl: server.baseUrl,
        token: auth.token,
        mode,
        encryptedDataKeyEnvelope,
      });
      const ownerSession = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      if (mode === 'e2ee') {
        const storedEnvelopeBase64 = ownerSession.dataEncryptionKey;
        expect(typeof storedEnvelopeBase64).toBe('string');
        const storedEnvelope = new Uint8Array(Buffer.from(String(storedEnvelopeBase64), 'base64'));
        expect(storedEnvelope).toEqual(encryptedDataKeyEnvelope);
        expect(openEncryptedDataKeyEnvelopeV1({
          envelope: storedEnvelope,
          recipientSecretKeyOrSeed: auth.accountSigningSeed,
        })).toEqual(dataKey);
        expect(openEncryptedDataKeyEnvelopeV1({
          envelope: storedEnvelope,
          recipientSecretKeyOrSeed: otherAuth.accountSigningSeed,
        })).toBeNull();
      } else {
        expect(ownerSession.dataEncryptionKey).toBeNull();
      }
      const otherAccountSession = await fetchJson<unknown>(
        `${server.baseUrl}/v2/sessions/${sessionId}`,
        {
          headers: { Authorization: `Bearer ${otherAuth.token}` },
          timeoutMs: 20_000,
        },
      );
      expect(otherAccountSession.status).toBe(404);
      const { socket: agentSocket } = await createMachineBoundSessionScopedSocketCollector({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
      });
      const socket = createUserScopedSocketCollector(server.baseUrl, auth.token);
      const persistInvocations: PersistInvocation[] = [];

      const request = async (path: string, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${auth.token}`);
        return await fetch(`${server!.baseUrl}${path}`, { ...init, headers });
      };
      const projector = createVoiceTranscriptProjector({
        getState: () => ({
          applyMessages: () => {
            throw new Error('Canonical Voice finals must not create optimistic transcript ghosts');
          },
        }),
        persistFinal: (input) => {
          const result = persistSessionTranscriptMessage({
            request,
            sessionEncryptionMode: mode,
            ...(mode === 'e2ee'
              ? { encryptRawRecord: async (rawRecord) => encryptDataKeyBase64(rawRecord, dataKey) }
              : {}),
          }, input);
          persistInvocations.push({ input, result });
          return result;
        },
      });

      try {
        agentSocket.connect();
        await waitFor(() => agentSocket.isConnected(), { timeoutMs: 20_000 });
        agentSocket.emit('session-alive', {
          sid: sessionId,
          time: Date.now(),
          thinking: false,
        });
        await waitFor(async () => {
          const session = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
          return session.active === true;
        }, { timeoutMs: 20_000, context: `Agent-backed ${mode} Voice carrier active` });

        socket.connect();
        await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });
        expect(projector.beginCanonicalAttempt(sessionId)).toBe(1);

        expect(projector.projectCanonicalEvent({
          conversationSessionId: sessionId,
          event: buildFinalEvent({
            sequence: 1,
            revision: 1,
            itemId: 'spoken-question',
            role: 'user',
            text: 'initial spoken orchard question',
          }),
        }).status).toBe('applied');
        expect(projector.projectCanonicalEvent({
          conversationSessionId: sessionId,
          event: buildFinalEvent({
            sequence: 2,
            revision: 1,
            itemId: 'spoken-answer',
            role: 'assistant',
            text: 'the orchard answer',
          }),
        }).status).toBe('applied');

        await waitFor(() => persistInvocations.length === 2, { timeoutMs: 20_000 });
        const [initialUserWrite, initialAssistantWrite] = await Promise.all(
          persistInvocations.slice(0, 2).map((invocation) => invocation.result),
        );
        const userLocalId = persistInvocations[0]!.input.localId;
        const assistantLocalId = persistInvocations[1]!.input.localId;

        expect(initialUserWrite).toMatchObject({
          didWrite: true,
          didUpdate: false,
          message: {
            id: expect.any(String),
            seq: expect.any(Number),
            localId: userLocalId,
            role: 'user',
          },
        });
        expect(initialAssistantWrite).toMatchObject({
          didWrite: true,
          didUpdate: false,
          message: {
            id: expect.any(String),
            seq: expect.any(Number),
            localId: assistantLocalId,
            role: 'agent',
          },
        });
        expect(initialUserWrite.message.id).not.toBe(userLocalId);
        expect(initialAssistantWrite.message.id).not.toBe(assistantLocalId);
        expect(initialUserWrite.message.seq).toBeLessThan(initialAssistantWrite.message.seq);

        await waitFor(
          () => hasMessageUpdate(socket.getEvents(), 'new-message', userLocalId)
            && hasMessageUpdate(socket.getEvents(), 'new-message', assistantLocalId),
          { timeoutMs: 20_000 },
        );

        socket.disconnect();
        await waitFor(() => !socket.isConnected(), { timeoutMs: 20_000 });
        socket.connect();
        await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });

        expect(projector.projectCanonicalEvent({
          conversationSessionId: sessionId,
          event: buildFinalEvent({
            type: 'voice.transcript.corrected',
            sequence: 3,
            revision: 2,
            itemId: 'spoken-question',
            role: 'user',
            text: 'corrected spoken orchard question',
          }),
        }).status).toBe('applied');

        await waitFor(() => persistInvocations.length === 3, { timeoutMs: 20_000 });
        const correctedUserWrite = await persistInvocations[2]!.result;
        expect(persistInvocations[2]!.input.localId).toBe(userLocalId);
        expect(correctedUserWrite).toMatchObject({
          didWrite: false,
          didUpdate: true,
          message: {
            id: initialUserWrite.message.id,
            seq: initialUserWrite.message.seq,
            localId: userLocalId,
            role: 'user',
          },
        });
        await waitFor(
          () => hasMessageUpdate(socket.getEvents(), 'message-updated', userLocalId),
          { timeoutMs: 20_000 },
        );

        const storedRows = await fetchStoredTranscriptRows({
          baseUrl: server.baseUrl,
          token: auth.token,
          sessionId,
        });
        expect(storedRows).toHaveLength(2);
        expect(storedRows.map((row) => row.localId)).toEqual([userLocalId, assistantLocalId]);
        expect(storedRows.map((row) => row.seq)).toEqual([
          initialUserWrite.message.seq,
          initialAssistantWrite.message.seq,
        ]);
        if (mode === 'e2ee') {
          expect(storedRows.every((row) => row.content.t === 'encrypted')).toBe(true);
          expect(JSON.stringify(storedRows)).not.toContain('orchard');
        } else {
          expect(storedRows.every((row) => row.content.t === 'plain')).toBe(true);
        }

        const decryptedRows = storedRows.map((row) => {
          const decrypted = row.content.t === 'plain'
            ? row.content.v
            : decryptDataKeyBase64(row.content.c, dataKey);
          if (!isRecord(decrypted)) throw new Error(`Failed to decrypt row ${row.id}`);
          return { row, decrypted };
        });
        expect(decryptedRows.map(({ decrypted }) => {
          const content = isRecord(decrypted.content) ? decrypted.content : null;
          if (decrypted.role === 'user') return content?.text;
          const data = isRecord(content?.data) ? content.data : null;
          const message = isRecord(data?.message) ? data.message : null;
          const blocks = Array.isArray(message?.content) ? message.content : [];
          const firstBlock = isRecord(blocks[0]) ? blocks[0] : null;
          return firstBlock?.text;
        })).toEqual([
          'corrected spoken orchard question',
          'the orchard answer',
        ]);

        const otherAccountTranscript = await fetchJson<unknown>(
          `${server.baseUrl}/v1/sessions/${sessionId}/messages?afterSeq=0&limit=50`,
          {
            headers: { Authorization: `Bearer ${otherAuth.token}` },
            timeoutMs: 20_000,
          },
        );
        expect(otherAccountTranscript.status).toBe(404);

        const semanticExport = storedRows.map((row, index) => extractSemanticTranscriptItem({
          row,
          index,
          ctx: {
            encryptionKey: dataKey,
            encryptionVariant: mode === 'e2ee' ? 'dataKey' : 'legacy',
          },
          options: {
            mode: 'transcript',
            transcriptRoles: ['user', 'assistant'],
          },
        }).item);
        expect(semanticExport).toEqual([
          expect.objectContaining({
            id: initialUserWrite.message.id,
            seq: initialUserWrite.message.seq,
            text: 'corrected spoken orchard question',
            origin: {
              v: 1,
              channel: 'realtime_conversation',
              modality: 'voice',
            },
          }),
          expect.objectContaining({
            id: initialAssistantWrite.message.id,
            seq: initialAssistantWrite.message.seq,
            text: 'the orchard answer',
            origin: {
              v: 1,
              channel: 'realtime_conversation',
              modality: 'voice',
            },
          }),
        ]);

        const searchableItems = storedRows.map((row, index) => extractMemoryIndexableTranscriptItem({
          sessionId,
          row,
          index,
          ctx: {
            encryptionKey: dataKey,
            encryptionVariant: mode === 'e2ee' ? 'dataKey' : 'legacy',
          },
        }));
        expect(searchableItems).toEqual([
          expect.objectContaining({
            id: initialUserWrite.message.id,
            seq: initialUserWrite.message.seq,
            role: 'user',
            text: 'corrected spoken orchard question',
          }),
          expect.objectContaining({
            id: initialAssistantWrite.message.id,
            seq: initialAssistantWrite.message.seq,
            role: 'assistant',
            text: 'the orchard answer',
          }),
        ]);

        expect(decryptTranscriptReplayCore({
          rows: storedRows,
          ...(mode === 'e2ee'
            ? { encryptionKey: dataKey, encryptionVariant: 'dataKey' as const }
            : {}),
        }).dialog).toEqual([]);

        const deleteResponse = await fetchJson<Readonly<{ success?: unknown }>>(
          `${server.baseUrl}/v1/sessions/${sessionId}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${auth.token}` },
            timeoutMs: 20_000,
          },
        );
        expect(deleteResponse.status).toBe(200);
        expect(deleteResponse.data?.success).toBe(true);
        await waitFor(
          () => hasSessionDeletedUpdate(socket.getEvents(), sessionId),
          { timeoutMs: 20_000 },
        );
        const deletedTranscriptResponse = await fetchJson<unknown>(
          `${server.baseUrl}/v1/sessions/${sessionId}/messages?afterSeq=0&limit=50`,
          {
            headers: { Authorization: `Bearer ${auth.token}` },
            timeoutMs: 20_000,
          },
        );
        expect(deletedTranscriptResponse.status).toBe(404);
      } finally {
        projector.releaseCanonicalConversation(sessionId);
        agentSocket.close();
        socket.close();
      }
    },
    180_000,
  );
});
