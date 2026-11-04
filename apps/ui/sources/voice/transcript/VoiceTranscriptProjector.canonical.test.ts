import { createVoiceTranscriptLadderMapper } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { log } from '@/log';
import { z } from 'zod/mini';
import { RawRecordSchema } from '@happier-dev/session-core/raw';
import { SessionMessageRoleSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { persistSessionTranscriptMessage, readStoredSessionMessages } from '@happier-dev/session-core/messages';

import type { PersistSessionTranscriptMessageInput } from "@happier-dev/session-core/messages";
import { normalizeRawMessage, type NormalizedMessage } from "@happier-dev/session-core/raw";
import { createCanonicalVoiceTranscriptProjector, type CanonicalVoiceTranscriptItem } from './canonicalProjector';
import {
  createVoiceTranscriptProjector,
  deriveCanonicalVoiceTranscriptEntryId,
  buildRealtimeConversationRawRecord,
} from './VoiceTranscriptProjector';


type TranscriptRequest = PersistSessionTranscriptMessageInput;
const wireRequests: TranscriptRequest[] = [];
// Retained state belongs to the substituted Home HTTP service, not the projector/store.
const durableRows = new Map<string, TranscriptRequest>();
const acknowledgements = new Map<string, { id: string; seq: number; localId: string; createdAt: number }>();
const wireSchema = z.strictObject({
  content: z.strictObject({ t: z.literal('plain'), v: RawRecordSchema }),
  localId: z.string().check(z.minLength(1)), messageRole: SessionMessageRoleSchema,
});
let beforeAcknowledgement: (request: TranscriptRequest) => void | Promise<void>;
const pendingWriterOperations: Promise<unknown>[] = [];
const requestListeners = new Set<() => void>();

beforeEach(() => {
  wireRequests.length = 0;
  durableRows.clear();
  acknowledgements.clear();
  pendingWriterOperations.length = 0;
  requestListeners.clear();
  beforeAcknowledgement = () => undefined;
  log.clear();
  storage.setState({ sessionMessages: {}, sessions: Object.fromEntries(
    ['carrier', 'one', 'two', 'three', 'released-attempt'].map(id => [id, createSessionFixture({ id })])) });
});

function writeTranscript(input: PersistSessionTranscriptMessageInput) {
  const pending = persistSessionTranscriptMessage({
    sessionEncryptionMode: 'plain',
    request: async (path, init) => {
      const body = wireSchema.parse(JSON.parse(String(init?.body)));
      const sessionId = decodeURIComponent(path.split('/')[3]!);
      const request = { sessionId, localId: body.localId, messageRole: body.messageRole,
        rawRecord: body.content.v, createdAt: 100 };
      wireRequests.push(request);
      for (const listener of requestListeners) listener();
      await beforeAcknowledgement(request);
      const existing = acknowledgements.get(body.localId);
      const acknowledgement = existing ?? { id: 'ack-' + (acknowledgements.size + 1),
        seq: acknowledgements.size + 1, localId: body.localId, createdAt: 100 };
      acknowledgements.set(body.localId, acknowledgement);
      durableRows.set(body.localId, request);
      return Response.json({ didWrite: !existing, didUpdate: !!existing, message: acknowledgement });
    },
  }, input).then(result => {
    storage.getState().applyMessages(input.sessionId, [result.message]);
    return result;
  });
  pendingWriterOperations.push(pending);
  return pending;
}

function persistCanonicalItem(item: CanonicalVoiceTranscriptItem) {
  const localId = deriveCanonicalVoiceTranscriptEntryId({ attemptIdentity: item.attemptIdentity,
    itemId: item.itemId, role: item.role });
  return writeTranscript({ sessionId: 'carrier', localId, createdAt: 100,
    messageRole: item.role === 'user' ? 'user' : 'agent',
    rawRecord: buildRealtimeConversationRawRecord({ id: localId, role: item.role, text: item.text }) });
}

function storedCarrierRows() { return readStoredSessionMessages(storage.getState(), 'carrier'); }
async function settleWrites() { await Promise.allSettled(pendingWriterOperations); }
function waitForTranscriptRequests(count: number) {
  return waitForTestEvent(
    (listener) => {
      requestListeners.add(listener);
      return () => { requestListeners.delete(listener); };
    },
    () => wireRequests.length,
    (length) => length >= count,
  );
}

function event(overrides: Record<string, unknown>) {
  return {
    v: 1 as const,
    type: 'voice.transcript.updated' as const,
    epoch: 1,
    sequence: 1,
    revision: 1,
    eventId: 'event-1',
    itemId: 'item-1',
    role: 'user' as const,
    text: 'hello',
    provenance: 'live' as const,
    ...overrides,
  };
}

describe('canonical voice transcript projector', () => {
  it('replaces cumulative partial corrections and persists one final exactly once', async () => {
    const persistFinal = persistCanonicalItem;
    const projector = createCanonicalVoiceTranscriptProjector({ persistFinal });

    expect(projector.project(event({ text: 'hello wor' })).status).toBe('applied');
    expect(projector.project(event({ sequence: 2, revision: 2, eventId: 'event-2', text: 'hello world' })).status).toBe('applied');
    expect(projector.project(event({
      type: 'voice.transcript.final',
      sequence: 3,
      revision: 3,
      eventId: 'event-3',
      text: 'hello world',
    })).status).toBe('applied');
    expect(projector.project(event({
      type: 'voice.transcript.final',
      sequence: 3,
      revision: 3,
      eventId: 'event-3',
      text: 'hello world',
      provenance: 'replay',
    })).status).toBe('duplicate');

    expect(projector.snapshot()).toEqual([expect.objectContaining({
      itemId: 'item-1',
      text: 'hello world',
      final: true,
      revision: 3,
      announce: 'polite',
    })]);
    await settleWrites();
    expect(wireRequests).toHaveLength(1);
    expect(storedCarrierRows()).toEqual([expect.objectContaining({ text: 'hello world' })]);
  });

  it('assembles assistant deltas while keeping user and assistant items separate', () => {
    const projector = createCanonicalVoiceTranscriptProjector();
    projector.project(event({ role: 'user', itemId: 'user-1', text: 'question' }));
    projector.project(event({
      type: 'voice.transcript.delta',
      role: 'assistant',
      itemId: 'assistant-1',
      eventId: 'assistant-1a',
      sequence: 2,
      text: 'hello ',
    }));
    projector.project(event({
      type: 'voice.transcript.delta',
      role: 'assistant',
      itemId: 'assistant-1',
      eventId: 'assistant-1b',
      sequence: 3,
      revision: 2,
      text: 'world',
    }));

    expect(projector.snapshot().map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'hello world' },
    ]);
  });

  it('rejects live out-of-order, conflicting duplicate, and late-after-final events', () => {
    const diagnostics: string[] = [];
    const projector = createCanonicalVoiceTranscriptProjector({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      maxDiagnostics: 2,
    });
    projector.project(event({ sequence: 2, revision: 2, eventId: 'event-2' }));
    expect(projector.project(event({ sequence: 1, revision: 1, eventId: 'event-1' })).status).toBe('rejected');
    expect(projector.project(event({ sequence: 2, revision: 2, eventId: 'different', text: 'conflict' })).status).toBe('rejected');
    projector.project(event({ type: 'voice.transcript.final', sequence: 3, revision: 3, eventId: 'event-3' }));
    expect(projector.project(event({ sequence: 4, revision: 4, eventId: 'event-4', text: 'late' })).status).toBe('rejected');
    expect(diagnostics).toHaveLength(2);
  });

  it('upserts replay by stable item identity and orders simultaneous items deterministically', () => {
    const projector = createCanonicalVoiceTranscriptProjector();
    projector.project(event({ itemId: 'item-b', sequence: 2, eventId: 'event-b', text: 'B', provenance: 'replay' }));
    projector.project(event({ itemId: 'item-a', sequence: 1, eventId: 'event-a', text: 'A', provenance: 'replay' }));
    expect(projector.snapshot().map((item) => item.itemId)).toEqual(['item-a', 'item-b']);
    expect(projector.project(event({ itemId: 'item-a', sequence: 1, eventId: 'event-a', text: 'A', provenance: 'replay' })).status).toBe('duplicate');
    expect(projector.snapshot()).toHaveLength(2);
  });

  it('deduplicates an identical final replay with a new event id and rejects event-id reuse with different payload', async () => {
    const diagnostics: string[] = [];
    const persistFinal = persistCanonicalItem;
    const projector = createCanonicalVoiceTranscriptProjector({
      persistFinal,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    const final = event({
      type: 'voice.transcript.final',
      sequence: 2,
      revision: 2,
      eventId: 'final-live',
      text: 'stable final',
    });
    expect(projector.project(final).status).toBe('applied');
    expect(projector.project({ ...final, provenance: 'replay', eventId: 'final-replay' }).status).toBe('duplicate');
    expect(projector.project(event({
      itemId: 'other-item',
      eventId: 'final-live',
      sequence: 3,
      text: 'conflicting event id reuse',
    })).status).toBe('rejected');
    expect(diagnostics).toContain('conflicting_duplicate');
    await settleWrites();
    expect(wireRequests).toHaveLength(1);
    expect(storedCarrierRows()).toEqual([expect.objectContaining({ text: 'stable final' })]);
  });

  it('accepts only an explicit higher-revision correction after final and persists the replacement once', async () => {
    const diagnostics: string[] = [];
    const persistFinal = persistCanonicalItem;
    const projector = createCanonicalVoiceTranscriptProjector({
      persistFinal,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    const final = event({
      type: 'voice.transcript.final',
      sequence: 2,
      revision: 2,
      eventId: 'assistant-final',
      itemId: 'assistant-1',
      role: 'assistant',
      text: 'original answer',
    });
    const correction = event({
      type: 'voice.transcript.corrected',
      sequence: 3,
      revision: 3,
      eventId: 'assistant-correction',
      itemId: 'assistant-1',
      role: 'assistant',
      text: 'corrected answer',
    });

    expect(projector.project(final).status).toBe('applied');
    expect(projector.project(correction)).toMatchObject({
      status: 'applied',
      item: { text: 'corrected answer', final: true, revision: 3 },
    });
    expect(projector.project({ ...correction, provenance: 'replay', eventId: 'assistant-correction-replay' }).status).toBe('duplicate');
    expect(projector.project(event({
      type: 'voice.transcript.corrected',
      sequence: 4,
      revision: 1,
      eventId: 'correction-without-final',
      itemId: 'different-item',
      role: 'assistant',
      text: 'must not create a finalized item',
    })).status).toBe('rejected');
    expect(projector.project(event({
      type: 'voice.transcript.final',
      sequence: 5,
      revision: 4,
      eventId: 'ordinary-late-final',
      itemId: 'assistant-1',
      role: 'assistant',
      text: 'must not replace correction',
    })).status).toBe('rejected');
    expect(projector.project(event({
      type: 'voice.transcript.corrected',
      sequence: 2,
      revision: 4,
      eventId: 'out-of-order-correction',
      itemId: 'assistant-1',
      role: 'assistant',
      text: 'must not regress order',
    })).status).toBe('rejected');

    expect(projector.snapshot()).toEqual([
      expect.objectContaining({ itemId: 'assistant-1', text: 'corrected answer', final: true, revision: 3 }),
    ]);
    await settleWrites();
    expect(wireRequests).toHaveLength(2);
    expect(storedCarrierRows()).toEqual([expect.objectContaining({ text: 'corrected answer' })]);
    expect(diagnostics).toEqual(['correction_without_final', 'late_after_final', 'out_of_order']);
  });

  it('keeps earlier finals as correction authority for the active attempt', async () => {
    const diagnostics: string[] = [];
    const persistFinal = persistCanonicalItem;
    const projector = createCanonicalVoiceTranscriptProjector({
      persistFinal,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    expect(projector.project(event({
      type: 'voice.transcript.final',
      sequence: 1,
      revision: 1,
      eventId: 'evicted-final',
      itemId: 'evicted-item',
      role: 'assistant',
      text: 'original answer',
    }))).toMatchObject({ status: 'applied' });
    expect(projector.project(event({
      type: 'voice.transcript.final',
      sequence: 2,
      revision: 1,
      eventId: 'retained-final',
      itemId: 'retained-item',
      text: 'newer item',
    }))).toMatchObject({ status: 'applied' });
    expect(projector.snapshot().map((item) => item.itemId)).toEqual(['evicted-item', 'retained-item']);

    const firstCorrection = event({
      type: 'voice.transcript.corrected',
      sequence: 3,
      revision: 2,
      eventId: 'evicted-correction-1',
      itemId: 'evicted-item',
      role: 'assistant',
      text: 'first correction',
    });
    expect(projector.project(firstCorrection)).toMatchObject({
      status: 'applied',
      item: { itemId: 'evicted-item', text: 'first correction', revision: 2, final: true },
    });
    expect(projector.project({
      ...firstCorrection,
      eventId: 'evicted-correction-1-replay',
      provenance: 'replay',
    })).toMatchObject({ status: 'duplicate' });
    expect(projector.project(event({
      type: 'voice.transcript.corrected',
      sequence: 4,
      revision: 3,
      eventId: 'evicted-correction-2',
      itemId: 'evicted-item',
      role: 'assistant',
      text: 'second correction',
    }))).toMatchObject({
      status: 'applied',
      item: { itemId: 'evicted-item', text: 'second correction', revision: 3, final: true },
    });
    expect(projector.project(event({
      type: 'voice.transcript.final',
      sequence: 5,
      revision: 4,
      eventId: 'late-ordinary-final',
      itemId: 'evicted-item',
      role: 'assistant',
      text: 'must not replace a correction',
    }))).toMatchObject({ status: 'rejected' });

    expect(projector.snapshot().map((item) => item.itemId)).toEqual(['evicted-item', 'retained-item']);
    await settleWrites();
    expect(wireRequests).toHaveLength(4);
    expect(storedCarrierRows().map(row => 'text' in row ? row.text : null)).toEqual(['second correction', 'newer item']);
    expect(diagnostics).toEqual(['late_after_final']);
  });

  it('replaces one persisted canonical row when an explicit correction follows final', async () => {
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
      nowMs: () => 100,
    });

    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        sequence: 1,
        revision: 1,
        eventId: 'assistant-final',
        itemId: 'assistant-1',
        role: 'assistant',
        text: 'original answer',
      }),
    });
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.corrected',
        sequence: 2,
        revision: 2,
        eventId: 'assistant-correction',
        itemId: 'assistant-1',
        role: 'assistant',
        text: 'corrected answer',
      }),
    });

    await projector.settleAdmittedCanonicalPersistence({ conversationSessionId: 'carrier',
      attemptIdentity: projector.canonicalSnapshot('carrier')[0]!.attemptIdentity });
    const messages = storedCarrierRows();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      localId: expect.stringMatching(/^voice-realtime:[^:]+:assistant:assistant-1$/),
      createdAt: 100,
      realID: 'ack-1',
      text: 'corrected answer',
    });
  });

  it('rejects malformed canonical identities before persistence without throwing or colliding', () => {
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
      nowMs: () => 100,
    });

    for (const [index, malformedIdentity] of ['item-\uD800', 'item-\uDC00'].entries()) {
      expect(() => projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        event: event({
          type: 'voice.transcript.final',
          sequence: index + 1,
          revision: 1,
          eventId: `${malformedIdentity}:final`,
          itemId: malformedIdentity,
          role: 'assistant',
          text: 'must remain inert',
        }),
      })).not.toThrow();
    }

    expect(storedCarrierRows()).toEqual([]);
    expect(wireRequests).toEqual([]);
    const encoded = ['item-\uD800', 'item-\uDC00', 'item-\uFFFD'].map((itemId) =>
      deriveCanonicalVoiceTranscriptEntryId({
        attemptIdentity: 'attempt-safe',
        itemId,
        role: 'assistant',
      }));
    expect(new Set(encoded).size).toBe(encoded.length);
  });

  it('keeps persisted turn identities distinct when projector state reloads and upstream ids repeat', async () => {
    const firstRuntimeProjector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
      nowMs: () => 100,
    });
    expect(firstRuntimeProjector.beginCanonicalAttempt('carrier')).toMatchObject({
      epoch: 1,
      attemptIdentity: expect.any(String),
    });
    firstRuntimeProjector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        eventId: 'codex-v3:1:turn-reused:final',
        itemId: 'codex-v3:1:turn-reused',
        role: 'assistant',
        text: 'before reload',
      }),
    });

    const reloadedRuntimeProjector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
      nowMs: () => 200,
    });
    expect(reloadedRuntimeProjector.beginCanonicalAttempt('carrier')).toMatchObject({
      epoch: 1,
      attemptIdentity: expect.any(String),
    });
    reloadedRuntimeProjector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        eventId: 'codex-v3:1:turn-reused:final',
        itemId: 'codex-v3:1:turn-reused',
        role: 'assistant',
        text: 'after reload',
      }),
    });

    await settleWrites();
    const messages = storedCarrierRows();
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.localId)).size).toBe(2);
    expect(messages.map((message) => 'text' in message ? message.text : null)).toEqual([
      'before reload',
      'after reload',
    ]);
  });

  it('invalidates stale epochs and releases the prior attempt state', () => {
    const projector = createCanonicalVoiceTranscriptProjector();
    projector.project(event({ itemId: 'item-1', type: 'voice.transcript.final', eventId: 'e1' }));
    projector.project(event({ itemId: 'item-2', type: 'voice.transcript.final', eventId: 'e2', sequence: 2 }));
    projector.project(event({ itemId: 'item-3', type: 'voice.transcript.final', eventId: 'e3', sequence: 3 }));
    expect(projector.snapshot().map((item) => item.itemId)).toEqual(['item-1', 'item-2', 'item-3']);

    expect(projector.resetEpoch(2)).toBe(true);
    expect(projector.snapshot()).toEqual([]);
    expect(projector.project(event({ epoch: 1, sequence: 4, eventId: 'stale' })).status).toBe('rejected');
    expect(projector.project(event({
      epoch: 2,
      sequence: 1,
      eventId: 'new',
      itemId: 'item-1',
      type: 'voice.transcript.final',
    })).status).toBe('applied');
  });

  it('allocates a fresh persistence identity per host attempt while reconnect events retain it', () => {
    let attemptIdentitySequence = 0;
    const projector = createCanonicalVoiceTranscriptProjector({
      createAttemptIdentity: () => `attempt-${++attemptIdentitySequence}`,
    });

    expect(projector.beginAttempt()).toEqual({
      epoch: 1,
      attemptIdentity: 'attempt-1',
    });
    expect(projector.project(event({
      epoch: 1,
      sequence: 1,
      eventId: 'attempt-1',
      itemId: 'attempt-1',
    })).status).toBe('applied');
    expect(projector.project(event({
      epoch: 1,
      sequence: 1,
      eventId: 'attempt-1-reconnect-replay',
      itemId: 'attempt-1',
      provenance: 'replay',
    })).status).toBe('duplicate');
    expect(projector.snapshot()).toEqual([
      expect.objectContaining({ attemptIdentity: 'attempt-1', itemId: 'attempt-1' }),
    ]);
    expect(projector.beginAttempt()).toEqual({
      epoch: 2,
      attemptIdentity: 'attempt-2',
    });
    expect(projector.snapshot()).toEqual([]);
    expect(projector.project(event({
      epoch: 1,
      sequence: 2,
      eventId: 'stale-attempt',
      itemId: 'stale-attempt',
    })).status).toBe('rejected');
    expect(projector.project(event({
      epoch: 2,
      sequence: 1,
      eventId: 'attempt-2',
      itemId: 'attempt-2',
    })).status).toBe('applied');
    expect(projector.snapshot()).toEqual([
      expect.objectContaining({ attemptIdentity: 'attempt-2', itemId: 'attempt-2' }),
    ]);
  });

  it('keeps partials ephemeral and persists a canonical final under one stable item id', async () => {
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
      nowMs: () => 100,
    });

    projector.projectCanonicalEvent({ conversationSessionId: 'carrier', event: event({ text: 'par' }) });
    expect(storedCarrierRows()).toEqual([]);
    expect(wireRequests).toEqual([]);
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({ type: 'voice.transcript.final', eventId: 'final', sequence: 2, revision: 2, text: 'partial final' }),
    });
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({ type: 'voice.transcript.final', eventId: 'final', sequence: 2, revision: 2, text: 'partial final', provenance: 'replay' }),
    });

    await settleWrites();
    const applied = storedCarrierRows();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      localId: expect.stringMatching(/^voice-realtime:[^:]+:user:item-1$/),
      kind: 'user-text',
      text: 'partial final',
      meta: {
        happier: {
          kind: 'conversation_turn.v1',
          payload: { v: 1 },
          conversationTurnOriginV1: {
            v: 1,
            channel: 'realtime_conversation',
            modality: 'voice',
          },
        },
      },
    });
    expect(projector.canonicalSnapshot('carrier')).toEqual([
      expect.objectContaining({ itemId: 'item-1', text: 'partial final', final: true }),
    ]);
  });

  it('reloads canonical finals through the durable message boundary without duplicating replay or corrections', async () => {
    const persistFinal = writeTranscript;
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      nowMs: () => 100,
      persistFinal,
    });
    const source = {
      pluginId: 'happier.voice.test',
      contributionId: 'openai-realtime',
    };

    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      source,
      event: event({
        type: 'voice.transcript.final',
        eventId: 'user-final',
        itemId: 'user-turn',
        role: 'user',
        text: 'initial question',
      }),
    });
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      source,
      event: event({
        type: 'voice.transcript.final',
        eventId: 'user-final-replay',
        itemId: 'user-turn',
        role: 'user',
        text: 'initial question',
        provenance: 'replay',
      }),
    });
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      source,
      event: event({
        type: 'voice.transcript.final',
        sequence: 2,
        eventId: 'assistant-final',
        itemId: 'assistant-turn',
        role: 'assistant',
        text: 'initial answer',
      }),
    });
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      source,
      event: event({
        type: 'voice.transcript.corrected',
        sequence: 3,
        revision: 2,
        eventId: 'user-correction',
        itemId: 'user-turn',
        role: 'user',
        text: 'corrected question',
      }),
    });

    await waitForTranscriptRequests(3);
    expect(wireRequests).toHaveLength(3);
    await settleWrites();
    expect(storedCarrierRows()).toHaveLength(2);
    expect(durableRows).toHaveLength(2);
    const reloaded = [...durableRows.values()]
      .map((row, index) => normalizeRawMessage(
        `server-${index + 1}`,
        row.localId,
        row.createdAt,
        row.rawRecord,
        { seq: index + 1, messageRole: row.messageRole },
      ))
      .filter((message) => message !== null);

    expect(reloaded).toHaveLength(2);
    const readText = (message: NormalizedMessage): string | null => {
      if (message.role === 'user') return message.content.text;
      if (message.role === 'agent') {
        return message.content.find((entry) => entry.type === 'text')?.text ?? null;
      }
      return null;
    };
    expect(reloaded.map(readText)).toEqual(['corrected question', 'initial answer']);
    expect(reloaded).toEqual(expect.arrayContaining([
      expect.objectContaining({
        localId: expect.stringMatching(/^voice-realtime:[^:]+:user:user-turn$/),
        meta: {
          happier: {
            kind: 'conversation_turn.v1',
            payload: { v: 1 },
            conversationTurnOriginV1: {
              v: 1,
              channel: 'realtime_conversation',
              modality: 'voice',
              source,
            },
          },
        },
      }),
      expect.objectContaining({
        localId: expect.stringMatching(/^voice-realtime:[^:]+:assistant:assistant-turn$/),
        role: 'agent',
      }),
    ]));
  });

  it('commits distinct final rows in canonical event-arrival order when the first persistence attempt is delayed', async () => {
    const firstWrite = createDeferred<void>();
    const committedHistory: Array<Readonly<{
      seq: number;
      input: PersistSessionTranscriptMessageInput;
    }>> = [];
    beforeAcknowledgement = async input => {
      if (input.messageRole === 'user') await firstWrite.promise;
      committedHistory.push({ seq: committedHistory.length + 1, input });
    };
    const persistFinal = writeTranscript;
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal,
    });

    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        eventId: 'user-final',
        itemId: 'user-turn',
        role: 'user',
        text: 'first question',
      }),
    });
    await waitForTranscriptRequests(1);
    expect(wireRequests).toHaveLength(1);
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        sequence: 2,
        eventId: 'assistant-final',
        itemId: 'assistant-turn',
        role: 'assistant',
        text: 'later answer',
      }),
    });

    expect(projector.canonicalSnapshot('carrier').map(({ role, text }) => ({
      role,
      text,
    }))).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'later answer' },
    ]);
    expect(wireRequests).toHaveLength(1);
    expect(committedHistory).toEqual([]);

    firstWrite.resolve();
    await waitForTranscriptRequests(2);
    expect(wireRequests).toHaveLength(2);
    await settleWrites();
    expect(committedHistory).toHaveLength(2);

    expect(committedHistory
      .sort((left, right) => left.seq - right.seq)
      .map(({ input }) => input.messageRole))
      .toEqual(['user', 'agent']);
    await settleWrites();
    expect(storedCarrierRows().map(row => 'text' in row ? row.text : null)).toEqual(['first question', 'later answer']);
  });

  it('settles the persistence tail admitted by an exact canonical projection', async () => {
    const write = createDeferred<void>();
    beforeAcknowledgement = async () => { await write.promise; };
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
    });
    const projected = projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        eventId: 'assistant-final',
        itemId: 'assistant-turn',
        role: 'assistant',
        text: 'answer pending persistence',
      }),
    });
    expect(projected.item).not.toBeNull();
    let settled = false;
    const settlement = projector.settleAdmittedCanonicalPersistence({
      conversationSessionId: 'carrier',
      attemptIdentity: projected.item!.attemptIdentity,
    }).then(() => {
      settled = true;
    });

    await waitForTranscriptRequests(1);
    expect(settled).toBe(false);
    write.resolve();
    await settlement;
    expect(settled).toBe(true);
    expect(storedCarrierRows()).toEqual([expect.objectContaining({ text: 'answer pending persistence' })]);
  });

  it('commits one exact final admitted by A after B owns the canonical snapshot', async () => {
    const persisted = wireRequests;
    const sourceA = Object.freeze({
      pluginId: 'happier.voice.a',
      contributionId: 'realtime-a',
    });
    const sourceB = Object.freeze({
      pluginId: 'happier.voice.b',
      contributionId: 'realtime-b',
    });
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
    });
    const a = projector.beginCanonicalAttempt('carrier');
    const aFinal = event({
      type: 'voice.transcript.final',
      epoch: a.epoch,
      eventId: 'a-final',
      itemId: 'a-turn',
      role: 'user',
      text: 'A admitted before replacement',
    });

    // Admission is synchronous canonical validation and reservation, not an
    // early snapshot mutation or a generic delayed text write.
    const admitted = projector.admitCanonicalPersistenceEvent({
      conversationSessionId: 'carrier',
      event: aFinal,
      source: sourceA,
    });
    expect(admitted).not.toBeNull();
    expect(projector.canonicalSnapshot('carrier')).toEqual([]);
    expect(projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: aFinal,
    })).toMatchObject({ status: 'duplicate', item: null });

    const b = projector.beginCanonicalAttempt('carrier');
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        epoch: b.epoch,
        eventId: 'b-final',
        itemId: 'b-turn',
        role: 'user',
        text: 'B remains the current snapshot',
      }),
      source: sourceB,
    });
    await waitForTranscriptRequests(1);
    expect(persisted).toHaveLength(1);
    await settleWrites();
    expect(projector.canonicalSnapshot('carrier')).toEqual([
      expect.objectContaining({
        attemptIdentity: b.attemptIdentity,
        itemId: 'b-turn',
        text: 'B remains the current snapshot',
      }),
    ]);

    expect(projector.commitAdmittedCanonicalPersistenceEvent(admitted!)).toBe(
      deriveCanonicalVoiceTranscriptEntryId({
        attemptIdentity: a.attemptIdentity,
        itemId: 'a-turn',
        role: 'user',
      }),
    );
    // The opaque admission is single-use: a repeated delayed callback cannot
    // manufacture a second persistence mutation.
    expect(projector.commitAdmittedCanonicalPersistenceEvent(admitted!)).toBeNull();
    await waitForTranscriptRequests(2);
    expect(persisted).toHaveLength(2);
    await settleWrites();
    expect(persisted.map((input) => input.localId)).toEqual(expect.arrayContaining([
      deriveCanonicalVoiceTranscriptEntryId({
        attemptIdentity: a.attemptIdentity,
        itemId: 'a-turn',
        role: 'user',
      }),
      deriveCanonicalVoiceTranscriptEntryId({
        attemptIdentity: b.attemptIdentity,
        itemId: 'b-turn',
        role: 'user',
      }),
    ]));
    expect(persisted.find((input) => input.localId === deriveCanonicalVoiceTranscriptEntryId({
      attemptIdentity: a.attemptIdentity,
      itemId: 'a-turn',
      role: 'user',
    }))?.rawRecord).toMatchObject({
      meta: {
        happier: {
          conversationTurnOriginV1: {
            v: 1,
            channel: 'realtime_conversation',
            modality: 'voice',
            source: sourceA,
          },
        },
      },
    });
    expect(projector.canonicalSnapshot('carrier')).toEqual([
      expect.objectContaining({
        attemptIdentity: b.attemptIdentity,
        itemId: 'b-turn',
        text: 'B remains the current snapshot',
      }),
    ]);
  });

  it('commits one exact correction admitted by A after B owns the canonical snapshot', async () => {
    const persisted = wireRequests;
    const sourceA = Object.freeze({
      pluginId: 'happier.voice.a',
      contributionId: 'realtime-a',
    });
    const sourceB = Object.freeze({
      pluginId: 'happier.voice.b',
      contributionId: 'realtime-b',
    });
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
    });
    const a = projector.beginCanonicalAttempt('carrier');
    const aFinal = event({
      type: 'voice.transcript.final',
      epoch: a.epoch,
      eventId: 'a-final',
      itemId: 'a-turn',
      role: 'user',
      text: 'A persisted before correction',
    });
    expect(projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: aFinal,
      source: sourceA,
    })).toMatchObject({ status: 'applied' });
    await waitForTranscriptRequests(1);
    expect(persisted).toHaveLength(1);
    await settleWrites();

    const aCorrection = event({
      type: 'voice.transcript.corrected',
      epoch: a.epoch,
      sequence: 2,
      revision: 2,
      eventId: 'a-correction',
      itemId: 'a-turn',
      role: 'user',
      text: 'A correction admitted before replacement',
    });
    const admitted = projector.admitCanonicalPersistenceEvent({
      conversationSessionId: 'carrier',
      event: aCorrection,
      source: sourceA,
    });
    expect(admitted).not.toBeNull();
    expect(projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: aCorrection,
    })).toMatchObject({ status: 'duplicate', item: null });

    const b = projector.beginCanonicalAttempt('carrier');
    expect(projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        epoch: b.epoch,
        eventId: 'b-final',
        itemId: 'b-turn',
        role: 'user',
        text: 'B remains the current snapshot',
      }),
      source: sourceB,
    })).toMatchObject({ status: 'applied' });
    await waitForTranscriptRequests(2);
    expect(persisted).toHaveLength(2);
    await settleWrites();

    const aEntryId = deriveCanonicalVoiceTranscriptEntryId({
      attemptIdentity: a.attemptIdentity,
      itemId: 'a-turn',
      role: 'user',
    });
    expect(projector.commitAdmittedCanonicalPersistenceEvent(admitted!)).toBe(aEntryId);
    expect(projector.commitAdmittedCanonicalPersistenceEvent(admitted!)).toBeNull();
    await waitForTranscriptRequests(3);
    expect(persisted).toHaveLength(3);
    await settleWrites();
    expect(persisted.filter((input) => input.localId === aEntryId)).toEqual([
      expect.objectContaining({
        rawRecord: expect.objectContaining({
          content: { type: 'text', text: 'A persisted before correction' },
          meta: expect.objectContaining({
            happier: expect.objectContaining({
              conversationTurnOriginV1: expect.objectContaining({ source: sourceA }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        rawRecord: expect.objectContaining({
          content: { type: 'text', text: 'A correction admitted before replacement' },
          meta: expect.objectContaining({
            happier: expect.objectContaining({
              conversationTurnOriginV1: expect.objectContaining({ source: sourceA }),
            }),
          }),
        }),
      }),
    ]);
    expect(projector.canonicalSnapshot('carrier')).toEqual([
      expect.objectContaining({
        attemptIdentity: b.attemptIdentity,
        itemId: 'b-turn',
        text: 'B remains the current snapshot',
      }),
    ]);
  });

  it('serializes a final and correction both admitted before the acceptance barrier releases', async () => {
    const persisted = wireRequests;
    const source = Object.freeze({
      pluginId: 'happier.voice.pending-chain',
      contributionId: 'realtime-pending-chain',
    });
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
    });
    const attempt = projector.beginCanonicalAttempt('carrier');
    const admittedFinal = projector.admitCanonicalPersistenceEvent({
      conversationSessionId: 'carrier',
      source,
      event: event({
        type: 'voice.transcript.final',
        epoch: attempt.epoch,
        eventId: 'pending-chain-final',
        itemId: 'pending-chain-turn',
        role: 'user',
        text: 'provider final A',
      }),
    });
    const admittedCorrection = projector.admitCanonicalPersistenceEvent({
      conversationSessionId: 'carrier',
      source,
      event: event({
        type: 'voice.transcript.corrected',
        epoch: attempt.epoch,
        sequence: 2,
        revision: 2,
        eventId: 'pending-chain-correction',
        itemId: 'pending-chain-turn',
        role: 'user',
        text: 'provider corrected B before acceptance',
      }),
    });

    expect(admittedFinal).not.toBeNull();
    expect(admittedCorrection).not.toBeNull();
    expect(projector.canonicalSnapshot('carrier')).toEqual([]);
    const entryId = deriveCanonicalVoiceTranscriptEntryId({
      attemptIdentity: attempt.attemptIdentity,
      itemId: 'pending-chain-turn',
      role: 'user',
    });
    expect(projector.commitAdmittedCanonicalPersistenceEvent(admittedFinal!)).toBe(entryId);
    expect(projector.commitAdmittedCanonicalPersistenceEvent(admittedCorrection!)).toBe(entryId);

    await waitForTranscriptRequests(2);
    expect(persisted).toHaveLength(2);
    await settleWrites();
    expect(persisted).toEqual([
      expect.objectContaining({
        rawRecord: expect.objectContaining({
          content: { type: 'text', text: 'provider final A' },
          meta: expect.objectContaining({
            happier: expect.objectContaining({
              conversationTurnOriginV1: expect.objectContaining({ source }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        rawRecord: expect.objectContaining({
          content: { type: 'text', text: 'provider corrected B before acceptance' },
          meta: expect.objectContaining({
            happier: expect.objectContaining({
              conversationTurnOriginV1: expect.objectContaining({ source }),
            }),
          }),
        }),
      }),
    ]);
    expect(projector.canonicalSnapshot('carrier')).toEqual([
      expect.objectContaining({
        text: 'provider corrected B before acceptance',
        revision: 2,
        corrected: true,
      }),
    ]);
  });

  it('releases a canceled exact-final admission without retaining its duplicate reservation', async () => {
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
    });
    const attempt = projector.beginCanonicalAttempt('carrier');
    const final = event({
      type: 'voice.transcript.final',
      epoch: attempt.epoch,
      eventId: 'canceled-final',
      itemId: 'canceled-turn',
      role: 'user',
      text: 'release this reservation',
    });
    const admitted = projector.admitCanonicalPersistenceEvent({
      conversationSessionId: 'carrier',
      event: final,
    });
    expect(admitted).not.toBeNull();
    expect(projector.releaseAdmittedCanonicalPersistenceEvent(admitted!)).toBe(true);
    expect(projector.commitAdmittedCanonicalPersistenceEvent(admitted!)).toBeNull();
    expect(projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: final,
    })).toMatchObject({ status: 'applied' });
    await settleWrites();
    expect(storedCarrierRows()).toEqual([expect.objectContaining({ text: 'release this reservation' })]);
  });

  it('serializes same-row final and correction persistence so the correction cannot be overwritten by a late final', async () => {
    const firstWrite = createDeferred<void>();
    let writeCount = 0;
    beforeAcknowledgement = async () => {
      writeCount += 1;
      if (writeCount === 1) await firstWrite.promise;
    };
    const persistFinal = writeTranscript;
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal,
    });

    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        eventId: 'user-final',
        itemId: 'user-turn',
        role: 'user',
        text: 'initial question',
      }),
    });
    await waitForTranscriptRequests(1);
    expect(wireRequests).toHaveLength(1);
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.corrected',
        sequence: 2,
        revision: 2,
        eventId: 'user-correction',
        itemId: 'user-turn',
        role: 'user',
        text: 'corrected question',
      }),
    });

    expect(wireRequests).toHaveLength(1);
    firstWrite.resolve();
    await waitForTranscriptRequests(2);
    expect(wireRequests).toHaveLength(2);
    await settleWrites();
    expect([...durableRows.values()]).toEqual([
      expect.objectContaining({
        rawRecord: expect.objectContaining({
          content: { type: 'text', text: 'corrected question' },
        }),
      }),
    ]);
  });

  it('settles only the released attempt and cannot retire a newer transcript attempt', async () => {
    const firstWrite = createDeferred<void>();
    let writeCount = 0;
    beforeAcknowledgement = async () => {
      writeCount += 1;
      if (writeCount === 1) await firstWrite.promise;
    };
    const persistFinal = writeTranscript;
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal,
    });
    const firstAttempt = projector.beginCanonicalAttempt('carrier');
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        epoch: firstAttempt.epoch,
        eventId: 'first-attempt-final',
        itemId: 'first-attempt-turn',
        text: 'first attempt',
      }),
    });
    await waitForTranscriptRequests(1);
    expect(wireRequests).toHaveLength(1);

    const secondAttempt = projector.beginCanonicalAttempt('carrier');
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({
        type: 'voice.transcript.final',
        epoch: secondAttempt.epoch,
        eventId: 'second-attempt-final',
        itemId: 'second-attempt-turn',
        text: 'second attempt',
      }),
    });
    await waitForTranscriptRequests(2);
    expect(wireRequests).toHaveLength(2);

    let releaseSettled = false;
    const releaseFirstAttempt = projector.releaseCanonicalConversation(
      'carrier',
      firstAttempt.attemptIdentity,
    ).then((released) => {
      releaseSettled = true;
      return released;
    });
    await Promise.resolve();
    expect(releaseSettled).toBe(false);

    firstWrite.resolve();
    await expect(releaseFirstAttempt).resolves.toBe(false);
    expect(projector.canonicalSnapshot('carrier')).toEqual([
      expect.objectContaining({
        attemptIdentity: secondAttempt.attemptIdentity,
        itemId: 'second-attempt-turn',
      }),
    ]);
    await expect(projector.releaseCanonicalConversation(
      'carrier',
      secondAttempt.attemptIdentity,
    )).resolves.toBe(true);
  });

  it('settles a rejected admitted write without retrying or blocking attempt release', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const write = createDeferred<never>();
    beforeAcknowledgement = async () => {
      await write.promise;
    };
    const persistFinal = writeTranscript;
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal,
    });
    const attempt = projector.beginCanonicalAttempt('carrier');

    try {
      projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        event: event({
          type: 'voice.transcript.final',
          epoch: attempt.epoch,
          eventId: 'rejected-final',
          itemId: 'rejected-turn',
          text: 'cannot persist',
        }),
      });
      await waitForTranscriptRequests(1);
      expect(wireRequests).toHaveLength(1);

      let releaseSettled = false;
      const release = projector.releaseCanonicalConversation(
        'carrier',
        attempt.attemptIdentity,
      ).then((released) => {
        releaseSettled = true;
        return released;
      });
      await Promise.resolve();
      expect(releaseSettled).toBe(false);

      write.reject(new Error('offline'));
      await expect(release).resolves.toBe(true);
      expect(wireRequests).toHaveLength(1);
      expect(durableRows.size).toBe(0);
      expect(storedCarrierRows()).toEqual([]);
      expect(consoleInfo).toHaveBeenCalledWith(
        '[fireAndForget] VoiceTranscriptProjector.persistFinal',
        expect.objectContaining({ message: 'offline' }),
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it('lets a same-row correction proceed after the preceding persistence attempt fails', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let writeCount = 0;
    beforeAcknowledgement = async () => {
      writeCount += 1;
      if (writeCount === 1) throw new Error('offline');
    };
    const persistFinal = writeTranscript;
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal,
    });

    try {
      projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        event: event({
          type: 'voice.transcript.final',
          eventId: 'user-final',
          itemId: 'user-turn',
          role: 'user',
          text: 'initial question',
        }),
      });
      await waitForTranscriptRequests(1);
      expect(wireRequests).toHaveLength(1);
      projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        event: event({
          type: 'voice.transcript.corrected',
          sequence: 2,
          revision: 2,
          eventId: 'user-correction',
          itemId: 'user-turn',
          role: 'user',
          text: 'corrected question',
        }),
      });

      await waitForTranscriptRequests(2);
      expect(wireRequests).toHaveLength(2);
      await settleWrites();
      expect([...durableRows.values()]).toEqual([
        expect.objectContaining({
          rawRecord: expect.objectContaining({
            content: { type: 'text', text: 'corrected question' },
          }),
        }),
      ]);
      expect(storedCarrierRows()).toEqual([expect.objectContaining({ text: 'corrected question' })]);
      expect(consoleInfo).toHaveBeenCalledWith(
        '[fireAndForget] VoiceTranscriptProjector.persistFinal',
        expect.objectContaining({ message: 'offline' }),
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it('keeps an identical authoritative final replay inert after its host write fails without creating a ghost', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let writeCount = 0;
    const firstWrite = createDeferred<never>();
    beforeAcknowledgement = async () => {
      writeCount += 1;
      if (writeCount === 1) await firstWrite.promise;
    };
    const persistFinal = writeTranscript;
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal,
    });
    const final = event({
      type: 'voice.transcript.final',
      eventId: 'user-final',
      itemId: 'user-turn',
      role: 'user',
      text: 'question',
    });

    try {
      expect(projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        event: final,
      }).status).toBe('applied');
      await waitForTranscriptRequests(1);
      expect(wireRequests).toHaveLength(1);
      expect(projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        event: {
          ...final,
          eventId: 'user-final-replay-while-pending',
          provenance: 'replay',
        },
      }).status).toBe('duplicate');
      await Promise.resolve();
      expect(wireRequests).toHaveLength(1);

      firstWrite.reject(new Error('offline'));
      await projector.settleAdmittedCanonicalPersistence({ conversationSessionId: 'carrier',
        attemptIdentity: projector.canonicalSnapshot('carrier')[0]!.attemptIdentity });
      expect(consoleInfo).toHaveBeenCalledWith(
        '[fireAndForget] VoiceTranscriptProjector.persistFinal',
        expect.objectContaining({ message: 'offline' }),
      );
      expect(storedCarrierRows()).toEqual([]);
      expect(durableRows).toHaveLength(0);

      expect(projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        event: {
          ...final,
          eventId: 'user-final-replay',
          provenance: 'replay',
        },
      }).status).toBe('duplicate');
      await projector.settleAdmittedCanonicalPersistence({ conversationSessionId: 'carrier',
        attemptIdentity: projector.canonicalSnapshot('carrier')[0]!.attemptIdentity });

      expect(wireRequests).toHaveLength(1);
      expect(storedCarrierRows()).toEqual([]);
      expect(durableRows).toHaveLength(0);
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it('retains every demanded attempt beyond the former conversation cache count until explicit release', async () => {
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      nowMs: () => 100,
    });
    const attempts = Array.from({ length: 65 }, (_, index) => {
      const id = `demanded-${index}`;
      const attempt = projector.beginCanonicalAttempt(id);
      projector.projectCanonicalEvent({ conversationSessionId: id, event: event({ itemId: id, text: id, epoch: attempt.epoch }) });
      return { id, attempt };
    });
    for (const { id } of attempts) expect(projector.canonicalSnapshot(id)).toEqual([expect.objectContaining({ text: id })]);
    for (const { id, attempt } of attempts) {
      expect(await projector.releaseCanonicalConversation(id, attempt.attemptIdentity)).toBe(true);
      expect(projector.canonicalSnapshot(id)).toEqual([]);
    }
    expect(projector.canonicalProjectorCount()).toBe(0);
  });

  it('keeps accepted content beyond the old pending threshold while its first ACK is delayed', async () => {
    const acknowledgement = createDeferred<void>();
    beforeAcknowledgement = () => acknowledgement.promise;
    const projector = createVoiceTranscriptProjector({ getState: storage.getState, persistFinal: writeTranscript });
    const attempt = projector.beginCanonicalAttempt('carrier');
    try {
      for (let index = 0; index < 501; index += 1) {
        expect(projector.projectCanonicalEvent({ conversationSessionId: 'carrier', event: event({
          type: 'voice.transcript.final', epoch: attempt.epoch, sequence: index + 1,
          eventId: `delayed-${index}`, itemId: `delayed-${index}`, text: `accepted-${index}`,
        }) }).status).toBe('applied');
      }
      await waitForTranscriptRequests(1);
      expect(storedCarrierRows()).toEqual([]);
      expect(projector.canonicalSnapshot('carrier')).toHaveLength(501);
      expect(projector.canonicalSnapshot('carrier')[0]?.text).toBe('accepted-0');
    } finally {
      acknowledgement.resolve();
      await projector.settleAdmittedCanonicalPersistence({ conversationSessionId: 'carrier', attemptIdentity: attempt.attemptIdentity });
    }
    expect(storedCarrierRows()).toHaveLength(501);
    expect(new Set(wireRequests.map(request => request.localId)).size).toBe(501);
    expect(await projector.releaseCanonicalConversation('carrier', attempt.attemptIdentity)).toBe(true);
    expect(projector.canonicalSnapshot('carrier')).toEqual([]);
    expect(storedCarrierRows()).toHaveLength(501);
  });

  it('does not create state or evict an active conversation when reading a missing snapshot', () => {
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
      nowMs: () => 100,
    });
    projector.projectCanonicalEvent({ conversationSessionId: 'one', event: event({ itemId: 'one' }) });
    projector.projectCanonicalEvent({ conversationSessionId: 'two', event: event({ itemId: 'two' }) });

    expect(projector.canonicalSnapshot('missing')).toEqual([]);
    expect(projector.canonicalProjectorCount()).toBe(2);
    expect(projector.canonicalSnapshot('one')).toHaveLength(1);
    expect(projector.canonicalSnapshot('two')).toHaveLength(1);
  });

  it('collapses repeated superseding provider finals for one item onto a single durable row', async () => {
    // Observed on the xAI wire: one spoken utterance produced three
    // `conversation.item.input_audio_transcription.completed` events for the
    // same `item_id`, each superseding the last, and History showed three
    // separate "You" rows. The provider ladder is the canonical owner of that
    // rule, so drive it exactly as the provider leaves do and require the
    // corridor to land one corrected row rather than three appended ones.
    const persistFinal = writeTranscript;
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      nowMs: () => 100,
      persistFinal,
    });

    const ladder = createVoiceTranscriptLadderMapper();
    const supersedingFinals = [
      'For seven confirmed.',
      'Fly out loud with exactly these words: voice canary alpha seven confirmed.',
      'Say out loud with exactly these words: voice canary alpha seven confirmed.',
    ] as const;
    for (const [index, transcript] of supersedingFinals.entries()) {
      const canonical = ladder.map({
        itemId: 'user-item-1',
        eventId: `provider-final-${index}`,
        role: 'user',
        incoming: transcript,
        mode: 'final',
      });
      expect(canonical).not.toBeNull();
      expect(projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        event: canonical!,
      }).status).toBe('applied');
    }

    await waitForTranscriptRequests(3);
    expect(wireRequests).toHaveLength(3);
    await settleWrites();
    expect(new Set(wireRequests.map(request => request.localId)).size).toBe(1);
    expect(storedCarrierRows()).toEqual([expect.objectContaining({ text: supersedingFinals[2] })]);
    expect(durableRows.size).toBe(1);
    expect([...durableRows.values()][0]?.rawRecord).toMatchObject({
      role: 'user',
      content: { type: 'text', text: supersedingFinals[2] },
    });
    expect(projector.canonicalSnapshot('carrier')).toEqual([
      expect.objectContaining({
        itemId: 'user-item-1',
        text: supersedingFinals[2],
        final: true,
        corrected: true,
        revision: 3,
      }),
    ]);
  });

  it('retires attempt-owned canonical transcript subscriptions on release', async () => {
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
    });
    const listener = vi.fn();
    const unsubscribe = projector.subscribeCanonical('released-attempt', listener);

    const firstAttempt = projector.beginCanonicalAttempt('released-attempt');
    projector.projectCanonicalEvent({
      conversationSessionId: 'released-attempt',
      event: event({
        type: 'voice.transcript.final',
        epoch: firstAttempt.epoch,
        eventId: 'first-final',
        itemId: 'first-turn',
        text: 'first attempt',
      }),
    });
    await projector.releaseCanonicalConversation(
      'released-attempt',
      firstAttempt.attemptIdentity,
    );
    projector.projectCanonicalEvent({
      conversationSessionId: 'released-attempt',
      event: event({
        type: 'voice.transcript.final',
        epoch: 2,
        eventId: 'second-final',
        itemId: 'second-turn',
        text: 'new attempt',
      }),
    });

    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});

describe('canonical voice transcript refusals are named', () => {
  beforeEach(() => {
    log.clear();
  });

  function readNamedDrops(): ReadonlyArray<Record<string, unknown>> {
    return log.getLogs()
      .filter((line) => line.startsWith('[voiceRuntimeFailure] '))
      .map((line) => JSON.parse(line.slice('[voiceRuntimeFailure] '.length)) as Record<string, unknown>);
  }

  it('names a projection the canonical owner refuses, once per guard per attempt', async () => {
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal: writeTranscript,
    });
    projector.beginCanonicalAttempt('carrier');
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      source: { pluginId: 'happier.voice.openai', contributionId: 'realtime-openai' },
      event: event({ type: 'voice.transcript.final', text: 'authoritative words' }),
    });

    // A late non-correction after a final is discarded by the canonical owner.
    // Nothing downstream sees it: the conversation keeps running with no row.
    for (const eventId of ['event-late-1', 'event-late-2']) {
      expect(projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        source: { pluginId: 'happier.voice.openai', contributionId: 'realtime-openai' },
        event: event({
          type: 'voice.transcript.final',
          eventId,
          sequence: 5,
          revision: 5,
          text: `superseding ${eventId}`,
        }),
      }).status).toBe('rejected');
    }

    await settleWrites();
    expect(storedCarrierRows()).toEqual([expect.objectContaining({ text: 'authoritative words' })]);
    expect(readNamedDrops()).toEqual([{
      providerId: 'happier.voice.openai/realtime-openai',
      outcome: 'transcript_dropped',
      kind: 'transcript_projection_late_after_final',
      reason: 'voice_transcript_projection_rejected',
    }]);
  });

  it('names an authoritative final that carries no text to write', () => {
    const persistFinal = writeTranscript;
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal,
    });
    projector.beginCanonicalAttempt('carrier');
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      source: { pluginId: 'happier.voice.openai', contributionId: 'realtime-openai' },
      event: event({ type: 'voice.transcript.final', text: '   ' }),
    });

    expect(wireRequests).toEqual([]);
    expect(readNamedDrops()).toEqual([{
      providerId: 'happier.voice.openai/realtime-openai',
      outcome: 'transcript_dropped',
      kind: 'transcript_final_text_empty',
      reason: 'voice_transcript_final_text_empty',
    }]);
  });

  it('names an authoritative final whose only write fails', async () => {
    beforeAcknowledgement = async () => { throw Object.assign(new Error('write rejected'), { code: 'voice_transcript_write_failed' }); };
    const persistFinal = writeTranscript;
    const projector = createVoiceTranscriptProjector({
      getState: storage.getState,
      persistFinal,
    });
    projector.beginCanonicalAttempt('carrier');
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      source: { pluginId: 'happier.voice.openai', contributionId: 'realtime-openai' },
      event: event({ type: 'voice.transcript.final', text: 'authoritative words' }),
    });

    await waitForTestEvent((listener) => log.onChange(listener), readNamedDrops,
      (drops) => drops.some((drop) => drop.kind === 'transcript_persist_failed'));
    expect(readNamedDrops()).toEqual([{
      providerId: 'happier.voice.openai/realtime-openai',
      outcome: 'transcript_dropped',
      kind: 'transcript_persist_failed',
      reason: 'voice_transcript_write_failed',
    }]);
  });
});
