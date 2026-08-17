import { createVoiceTranscriptLadderMapper } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => vi.fn());
vi.mock('@/log', () => ({ log: { log: logSpy, warn: vi.fn(), error: vi.fn() } }));

import type { PersistSessionTranscriptMessageInput } from '@/sync/domains/messages/persistSessionTranscriptMessage';
import { normalizeRawMessage, type NormalizedMessage } from '@/sync/typesRaw';
import { createCanonicalVoiceTranscriptProjector } from './canonicalProjector';
import {
  createVoiceTranscriptProjector,
  deriveCanonicalVoiceTranscriptEntryId,
} from './VoiceTranscriptProjector';

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
  it('replaces cumulative partial corrections and persists one final exactly once', () => {
    const persistFinal = vi.fn();
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
    expect(persistFinal).toHaveBeenCalledTimes(1);
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

  it('deduplicates an identical final replay with a new event id and rejects event-id reuse with different payload', () => {
    const diagnostics: string[] = [];
    const persistFinal = vi.fn();
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
    expect(persistFinal).toHaveBeenCalledTimes(1);
  });

  it('accepts only an explicit higher-revision correction after final and persists the replacement once', () => {
    const diagnostics: string[] = [];
    const persistFinal = vi.fn();
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
    expect(persistFinal).toHaveBeenCalledTimes(2);
    expect(persistFinal).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'corrected answer', revision: 3 }));
    expect(diagnostics).toEqual(['correction_without_final', 'late_after_final', 'out_of_order']);
  });

  it('replaces one persisted canonical row when an explicit correction follows final', () => {
    let messages: any[] = [];
    const projector = createVoiceTranscriptProjector({
      getState: () => ({
        sessionMessages: { carrier: { messages } },
        applyMessagesLoaded: () => undefined,
        applyMessages: (_sessionId, incoming) => {
          for (const message of incoming) {
            const index = messages.findIndex((candidate) => candidate.id === message.id);
            if (index >= 0) messages[index] = message;
            else messages.push(message);
          }
        },
      }),
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

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: expect.stringMatching(/^voice-realtime:[^:]+:assistant:assistant-1$/),
      createdAt: 100,
      content: [expect.objectContaining({ type: 'text', text: 'corrected answer' })],
    });
  });

  it('rejects malformed canonical identities before persistence without throwing or colliding', () => {
    const applied: any[] = [];
    const projector = createVoiceTranscriptProjector({
      getState: () => ({
        sessionMessages: { carrier: { messages: applied } },
        applyMessagesLoaded: () => undefined,
        applyMessages: (_sessionId, messages) => applied.push(...messages),
      }),
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

    expect(applied).toEqual([]);
    const encoded = ['item-\uD800', 'item-\uDC00', 'item-\uFFFD'].map((itemId) =>
      deriveCanonicalVoiceTranscriptEntryId({
        attemptIdentity: 'attempt-safe',
        itemId,
        role: 'assistant',
      }));
    expect(new Set(encoded).size).toBe(encoded.length);
  });

  it('keeps persisted turn identities distinct when projector state reloads and upstream ids repeat', () => {
    let messages: any[] = [];
    const getState = () => ({
      sessionMessages: { carrier: { messages } },
      applyMessagesLoaded: () => undefined,
      applyMessages: (_sessionId: string, incoming: any[]) => {
        for (const message of incoming) {
          const index = messages.findIndex((candidate) => candidate.id === message.id);
          if (index >= 0) messages[index] = message;
          else messages.push(message);
        }
      },
    });
    const firstRuntimeProjector = createVoiceTranscriptProjector({
      getState,
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
      getState,
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

    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
    expect(messages.map((message) => message.content[0]?.text ?? message.content?.text)).toEqual([
      'before reload',
      'after reload',
    ]);
  });

  it('invalidates stale epochs and bounds retained item state', () => {
    const projector = createCanonicalVoiceTranscriptProjector({ maxItems: 2 });
    projector.project(event({ itemId: 'item-1', type: 'voice.transcript.final', eventId: 'e1' }));
    projector.project(event({ itemId: 'item-2', type: 'voice.transcript.final', eventId: 'e2', sequence: 2 }));
    projector.project(event({ itemId: 'item-3', type: 'voice.transcript.final', eventId: 'e3', sequence: 3 }));
    expect(projector.snapshot().map((item) => item.itemId)).toEqual(['item-2', 'item-3']);

    expect(projector.resetEpoch(2)).toBe(true);
    expect(projector.snapshot()).toEqual([]);
    expect(projector.project(event({ epoch: 1, sequence: 4, eventId: 'stale' })).status).toBe('rejected');
    expect(projector.project(event({ epoch: 2, sequence: 1, eventId: 'new', itemId: 'new' })).status).toBe('applied');
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

  it('keeps partials ephemeral and persists a canonical final under one stable item id', () => {
    const applied: any[] = [];
    const projector = createVoiceTranscriptProjector({
      getState: () => ({
        sessionMessages: { carrier: { messages: applied } },
        applyMessagesLoaded: () => undefined,
        applyMessages: (_sessionId, messages) => applied.push(...messages),
      }),
      nowMs: () => 100,
    });

    projector.projectCanonicalEvent({ conversationSessionId: 'carrier', event: event({ text: 'par' }) });
    expect(applied).toEqual([]);
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({ type: 'voice.transcript.final', eventId: 'final', sequence: 2, revision: 2, text: 'partial final' }),
    });
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      event: event({ type: 'voice.transcript.final', eventId: 'final', sequence: 2, revision: 2, text: 'partial final', provenance: 'replay' }),
    });

    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      id: expect.stringMatching(/^voice-realtime:[^:]+:user:item-1$/),
      role: 'user',
      content: { type: 'text', text: 'partial final' },
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
    const durableRows = new Map<string, PersistSessionTranscriptMessageInput>();
    const persistFinal = vi.fn((input: PersistSessionTranscriptMessageInput) => {
      durableRows.set(input.localId, input);
    });
    const projected: any[] = [];
    const projector = createVoiceTranscriptProjector({
      getState: () => ({
        sessionMessages: { carrier: { messages: projected } },
        applyMessagesLoaded: () => undefined,
        applyMessages: (_sessionId, messages) => projected.push(...messages),
      }),
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

    await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(3));
    expect(projected).toEqual([]);
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
    let resolveFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const committedHistory: Array<Readonly<{
      seq: number;
      input: PersistSessionTranscriptMessageInput;
    }>> = [];
    const persistFinal = vi.fn(async (input: PersistSessionTranscriptMessageInput) => {
      if (input.messageRole === 'user') await firstWriteBlocked;
      committedHistory.push({
        seq: committedHistory.length + 1,
        input,
      });
    });
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {} }),
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
    await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(1));
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
    expect(persistFinal).toHaveBeenCalledTimes(1);
    expect(committedHistory).toEqual([]);

    resolveFirstWrite();
    await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(committedHistory).toHaveLength(2));

    expect(committedHistory
      .sort((left, right) => left.seq - right.seq)
      .map(({ input }) => input.messageRole))
      .toEqual(['user', 'agent']);
  });

  it('settles the persistence tail admitted by an exact canonical projection', async () => {
    let resolveWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {} }),
      persistFinal: vi.fn(async () => {
        await writeBlocked;
      }),
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

    await Promise.resolve();
    expect(settled).toBe(false);
    resolveWrite();
    await settlement;
    expect(settled).toBe(true);
  });

  it('commits one exact final admitted by A after B owns the canonical snapshot', async () => {
    const persisted: PersistSessionTranscriptMessageInput[] = [];
    const sourceA = Object.freeze({
      pluginId: 'happier.voice.a',
      contributionId: 'realtime-a',
    });
    const sourceB = Object.freeze({
      pluginId: 'happier.voice.b',
      contributionId: 'realtime-b',
    });
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {} }),
      persistFinal: vi.fn(async (input: PersistSessionTranscriptMessageInput) => {
        persisted.push(input);
      }),
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
    await vi.waitFor(() => expect(persisted).toHaveLength(1));
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
    await vi.waitFor(() => expect(persisted).toHaveLength(2));
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
          conversationTurnOriginV1: { source: sourceA },
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
    const persisted: PersistSessionTranscriptMessageInput[] = [];
    const sourceA = Object.freeze({
      pluginId: 'happier.voice.a',
      contributionId: 'realtime-a',
    });
    const sourceB = Object.freeze({
      pluginId: 'happier.voice.b',
      contributionId: 'realtime-b',
    });
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {} }),
      persistFinal: vi.fn(async (input: PersistSessionTranscriptMessageInput) => {
        persisted.push(input);
      }),
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
    await vi.waitFor(() => expect(persisted).toHaveLength(1));

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
    await vi.waitFor(() => expect(persisted).toHaveLength(2));

    const aEntryId = deriveCanonicalVoiceTranscriptEntryId({
      attemptIdentity: a.attemptIdentity,
      itemId: 'a-turn',
      role: 'user',
    });
    expect(projector.commitAdmittedCanonicalPersistenceEvent(admitted!)).toBe(aEntryId);
    expect(projector.commitAdmittedCanonicalPersistenceEvent(admitted!)).toBeNull();
    await vi.waitFor(() => expect(persisted).toHaveLength(3));
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

  it('releases a canceled exact-final admission without retaining its duplicate reservation', () => {
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {} }),
      persistFinal: vi.fn(),
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
  });

  it('serializes same-row final and correction persistence so the correction cannot be overwritten by a late final', async () => {
    let resolveFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const durableRows = new Map<string, PersistSessionTranscriptMessageInput>();
    let writeCount = 0;
    const persistFinal = vi.fn(async (input: PersistSessionTranscriptMessageInput) => {
      writeCount += 1;
      if (writeCount === 1) await firstWriteBlocked;
      durableRows.set(input.localId, input);
    });
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {} }),
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
    await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(1));
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

    expect(persistFinal).toHaveBeenCalledTimes(1);
    resolveFirstWrite();
    await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect([...durableRows.values()]).toEqual([
        expect.objectContaining({
          rawRecord: expect.objectContaining({
            content: { type: 'text', text: 'corrected question' },
          }),
        }),
      ]);
    });
  });

  it('settles only the released attempt and cannot retire a newer transcript attempt', async () => {
    let resolveFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    let writeCount = 0;
    const persistFinal = vi.fn(async () => {
      writeCount += 1;
      if (writeCount === 1) await firstWriteBlocked;
    });
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {} }),
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
    await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(1));

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
    await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(2));

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

    resolveFirstWrite();
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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let rejectWrite!: (error: Error) => void;
    const persistFinal = vi.fn(async () => {
      await new Promise<never>((_resolve, reject) => {
        rejectWrite = reject;
      });
    });
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {} }),
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
      await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledOnce());

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

      rejectWrite(new Error('offline'));
      await expect(release).resolves.toBe(true);
      expect(persistFinal).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        '[fireAndForget] VoiceTranscriptProjector.persistFinal',
        expect.objectContaining({ message: 'offline' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('lets a same-row correction proceed after the preceding persistence attempt fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const durableRows = new Map<string, PersistSessionTranscriptMessageInput>();
    let writeCount = 0;
    const persistFinal = vi.fn(async (input: PersistSessionTranscriptMessageInput) => {
      writeCount += 1;
      if (writeCount === 1) throw new Error('offline');
      durableRows.set(input.localId, input);
    });
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {} }),
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
      await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(1));
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

      await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect([...durableRows.values()]).toEqual([
        expect.objectContaining({
          rawRecord: expect.objectContaining({
            content: { type: 'text', text: 'corrected question' },
          }),
        }),
      ]));
      expect(consoleError).toHaveBeenCalledWith(
        '[fireAndForget] VoiceTranscriptProjector.persistFinal',
        expect.objectContaining({ message: 'offline' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps an identical authoritative final replay inert after its host write fails without creating a ghost', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const durableRows = new Map<string, PersistSessionTranscriptMessageInput>();
    let writeCount = 0;
    let rejectFirstWrite!: (error: Error) => void;
    const persistFinal = vi.fn(async (input: PersistSessionTranscriptMessageInput) => {
      writeCount += 1;
      if (writeCount === 1) {
        await new Promise<never>((_resolve, reject) => {
          rejectFirstWrite = reject;
        });
      }
      durableRows.set(input.localId, input);
    });
    const projected: unknown[] = [];
    const projector = createVoiceTranscriptProjector({
      getState: () => ({
        sessionMessages: { carrier: { messages: projected } },
        applyMessagesLoaded: () => undefined,
        applyMessages: (_sessionId, messages) => projected.push(...messages),
      }),
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
      await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(1));
      expect(projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        event: {
          ...final,
          eventId: 'user-final-replay-while-pending',
          provenance: 'replay',
        },
      }).status).toBe('duplicate');
      await Promise.resolve();
      expect(persistFinal).toHaveBeenCalledTimes(1);

      rejectFirstWrite(new Error('offline'));
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
        '[fireAndForget] VoiceTranscriptProjector.persistFinal',
        expect.objectContaining({ message: 'offline' }),
      ));
      expect(projected).toEqual([]);
      expect(durableRows).toHaveLength(0);

      expect(projector.projectCanonicalEvent({
        conversationSessionId: 'carrier',
        event: {
          ...final,
          eventId: 'user-final-replay',
          provenance: 'replay',
        },
      }).status).toBe('duplicate');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(persistFinal).toHaveBeenCalledTimes(1);
      expect(projected).toEqual([]);
      expect(durableRows).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('bounds per-conversation canonical projector state with least-recently-used eviction', () => {
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ applyMessages: () => undefined, applyMessagesLoaded: () => undefined }),
      nowMs: () => 100,
      maxCanonicalConversations: 2,
    });
    projector.projectCanonicalEvent({ conversationSessionId: 'one', event: event({ itemId: 'one' }) });
    projector.projectCanonicalEvent({ conversationSessionId: 'two', event: event({ itemId: 'two' }) });
    projector.canonicalSnapshot('one');
    projector.projectCanonicalEvent({ conversationSessionId: 'three', event: event({ itemId: 'three' }) });

    expect(projector.canonicalProjectorCount()).toBe(2);
    expect(projector.canonicalSnapshot('one')).toHaveLength(1);
    expect(projector.canonicalSnapshot('two')).toEqual([]);
    expect(projector.canonicalProjectorCount()).toBe(2);
  });

  it('does not create state or evict an active conversation when reading a missing snapshot', () => {
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ applyMessages: () => undefined, applyMessagesLoaded: () => undefined }),
      nowMs: () => 100,
      maxCanonicalConversations: 2,
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
    const durableRows = new Map<string, PersistSessionTranscriptMessageInput>();
    const persistedLocalIds: string[] = [];
    const persistFinal = vi.fn((input: PersistSessionTranscriptMessageInput) => {
      persistedLocalIds.push(input.localId);
      durableRows.set(input.localId, input);
    });
    const projected: NormalizedMessage[] = [];
    const projector = createVoiceTranscriptProjector({
      getState: () => ({
        sessionMessages: { carrier: { messages: projected } },
        applyMessagesLoaded: () => undefined,
        applyMessages: (_sessionId, messages) => projected.push(...messages),
      }),
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

    await vi.waitFor(() => expect(persistFinal).toHaveBeenCalledTimes(3));
    expect(new Set(persistedLocalIds).size).toBe(1);
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
      getState: () => ({
        sessionMessages: {},
        applyMessages: () => undefined,
        applyMessagesLoaded: () => undefined,
      }),
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
    logSpy.mockClear();
  });

  function readNamedDrops(): ReadonlyArray<Record<string, unknown>> {
    return logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[voiceRuntimeFailure] '))
      .map((line) => JSON.parse(line.slice('[voiceRuntimeFailure] '.length)) as Record<string, unknown>);
  }

  it('names a projection the canonical owner refuses, once per guard per attempt', () => {
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {}, applyMessagesLoaded: () => undefined, applyMessages: () => undefined }),
      persistFinal: () => undefined,
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

    expect(readNamedDrops()).toEqual([{
      providerId: 'happier.voice.openai/realtime-openai',
      outcome: 'transcript_dropped',
      kind: 'transcript_projection_late_after_final',
      reason: 'voice_transcript_projection_rejected',
    }]);
  });

  it('names an authoritative final that carries no text to write', () => {
    const persistFinal = vi.fn();
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {}, applyMessagesLoaded: () => undefined, applyMessages: () => undefined }),
      persistFinal,
    });
    projector.beginCanonicalAttempt('carrier');
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      source: { pluginId: 'happier.voice.openai', contributionId: 'realtime-openai' },
      event: event({ type: 'voice.transcript.final', text: '   ' }),
    });

    expect(persistFinal).not.toHaveBeenCalled();
    expect(readNamedDrops()).toEqual([{
      providerId: 'happier.voice.openai/realtime-openai',
      outcome: 'transcript_dropped',
      kind: 'transcript_final_text_empty',
      reason: 'voice_transcript_final_text_empty',
    }]);
  });

  it('names an authoritative final whose only write fails', async () => {
    const persistFinal = vi.fn(async () => {
      throw Object.assign(new Error('write rejected'), { code: 'voice_transcript_write_failed' });
    });
    const projector = createVoiceTranscriptProjector({
      getState: () => ({ sessionMessages: {}, applyMessagesLoaded: () => undefined, applyMessages: () => undefined }),
      persistFinal,
    });
    projector.beginCanonicalAttempt('carrier');
    projector.projectCanonicalEvent({
      conversationSessionId: 'carrier',
      source: { pluginId: 'happier.voice.openai', contributionId: 'realtime-openai' },
      event: event({ type: 'voice.transcript.final', text: 'authoritative words' }),
    });

    await vi.waitFor(() => expect(readNamedDrops()).toEqual([{
      providerId: 'happier.voice.openai/realtime-openai',
      outcome: 'transcript_dropped',
      kind: 'transcript_persist_failed',
      reason: 'voice_transcript_write_failed',
    }]));
  });
});
