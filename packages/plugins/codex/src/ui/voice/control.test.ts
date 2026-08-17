import { describe, expect, it } from 'vitest';
import { VoiceTranscriptCanonicalEventV1Schema } from '@happier-dev/protocol';

import { createCodexV3ControlDecoder } from './control.js';

function asAttemptDecoder(
  decoder: ReturnType<typeof createCodexV3ControlDecoder>,
): ReturnType<typeof createCodexV3ControlDecoder> & Readonly<{
  markStarted(): void;
  finalize(): void;
}> {
  return decoder as ReturnType<typeof createCodexV3ControlDecoder> & Readonly<{
    markStarted(): void;
    finalize(): void;
  }>;
}

describe('Codex V3 oai-events decoder', () => {
  it('maps a pinned authoritative final to one attempt-namespaced positive revision', () => {
    const decode = createCodexV3ControlDecoder({ attemptId: 12 });

    const decoded = decode({
      type: 'turn.done',
      turn: {
        id: 'turn-opaque-1',
        role: 'assistant',
        transcript: '  Finished.\n',
      },
    });
    expect(decoded).toEqual([
      {
        type: 'transcript',
        event: {
          type: 'voice.transcript.final',
          v: 1,
          epoch: 1,
          sequence: 1,
          revision: 1,
          eventId: 'codex-v3:12:turn-opaque-1:final',
          itemId: 'codex-v3:12:turn-opaque-1',
          role: 'assistant',
          text: '  Finished.\n',
          provenance: 'live',
        },
      },
    ]);
    expect(VoiceTranscriptCanonicalEventV1Schema.safeParse(
      decoded[0]?.type === 'transcript' ? decoded[0].event : null,
    ).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', ' \t\n'],
  ])('rejects a %s authoritative final without suppressing attempt unavailability', (_label, transcript) => {
    const diagnostics: string[] = [];
    const attempt = asAttemptDecoder(createCodexV3ControlDecoder({
      attemptId: 13,
      diagnostic: (code) => diagnostics.push(code),
    }));
    const final = {
      type: 'turn.done',
      turn: {
        id: 'turn-empty-final',
        role: 'assistant',
        transcript,
      },
    } as const;

    attempt.markStarted();
    expect(attempt(final)).toEqual([]);
    expect(attempt(final)).toEqual([]);
    attempt.finalize();

    expect(diagnostics).toEqual([
      'codex_v3_malformed_turn_done',
      'codex_v3_conversational_transcript_unavailable',
    ]);
  });

  it('makes a duplicate authoritative final inert', () => {
    const decode = createCodexV3ControlDecoder({ attemptId: 9 });
    const final = {
      type: 'turn.done',
      turn: { id: 'same-turn', role: 'user', transcript: 'Hello' },
    } as const;

    expect(decode(final)).toHaveLength(1);
    expect(decode(final)).toEqual([]);
    expect(createCodexV3ControlDecoder({ attemptId: 10 })(final)).toEqual([
      expect.objectContaining({
        type: 'transcript',
        event: expect.objectContaining({ itemId: 'codex-v3:10:same-turn' }),
      }),
    ]);
  });

  it('keeps nondelegated and delegated events inert without a second transcript or turn producer', () => {
    const decode = createCodexV3ControlDecoder({ attemptId: 1 });

    expect(decode({
      type: 'input_transcript.added',
      item: { id: 'input-1', type: 'input_transcript', text: 'partial' },
    })).toEqual([]);
    expect(decode({
      type: 'delegation.created',
      item: {
        id: 'delegation-1',
        type: 'delegation',
        target: 'client',
        content: [{ type: 'input_text', text: 'code this' }],
      },
    })).toEqual([]);
    expect(decode({
      type: 'thread/realtime/transcript/done',
      threadId: 'thread-1',
      role: 'assistant',
      text: 'fallback',
    })).toEqual([]);
  });

  it('ignores unknown bounded event types and known malformed finals', () => {
    const diagnostics: string[] = [];
    const decode = createCodexV3ControlDecoder({
      attemptId: 1,
      diagnostic: (code) => diagnostics.push(code),
    });

    expect(decode({ type: 'provider.future.event', payload: 'bounded' })).toEqual([]);
    expect(decode({
      type: 'turn.done',
      turn: { id: '', role: 'assistant', transcript: 'missing identity' },
    })).toEqual([]);
    expect(decode({
      type: 'turn.done',
      turn: { id: 'turn-1', role: 'tool', transcript: 'wrong role' },
    })).toEqual([]);
    expect(decode({
      type: 'turn.done',
      turn: { id: 'turn-1', role: 'assistant' },
    })).toEqual([]);
    expect(diagnostics).toEqual([
      'codex_v3_unknown_control_event',
      'codex_v3_malformed_turn_done',
    ]);
  });

  it('bounds sanitized diagnostics to once per code for an attempt', () => {
    const diagnostics: string[] = [];
    const decode = createCodexV3ControlDecoder({
      attemptId: 2,
      diagnostic: (code) => diagnostics.push(code),
    });

    for (let index = 0; index < 100; index += 1) {
      expect(decode({ type: 'provider.future.event', index })).toEqual([]);
      expect(decode({
        type: 'turn.done',
        turn: { id: 'turn-1', role: 'assistant' },
      })).toEqual([]);
      expect(decode({ missingType: true })).toEqual([]);
    }

    expect(diagnostics).toEqual([
      'codex_v3_unknown_control_event',
      'codex_v3_malformed_turn_done',
      'codex_v3_malformed_control_event',
    ]);

    const nextAttemptDiagnostics: string[] = [];
    const decodeNextAttempt = createCodexV3ControlDecoder({
      attemptId: 3,
      diagnostic: (code) => nextAttemptDiagnostics.push(code),
    });
    expect(decodeNextAttempt({ type: 'provider.future.event' })).toEqual([]);
    expect(nextAttemptDiagnostics).toEqual(['codex_v3_unknown_control_event']);
  });

  it('bounds opaque identity and transcript before canonical projection', () => {
    const decode = createCodexV3ControlDecoder({ attemptId: 1 });

    expect(decode({
      type: 'turn.done',
      turn: {
        id: '\0'.repeat(192),
        role: 'assistant',
        transcript: '\0'.repeat(64 * 1024),
      },
    })).toEqual([
      expect.objectContaining({
        type: 'transcript',
        event: expect.objectContaining({
          text: '\0'.repeat(64 * 1024),
        }),
      }),
    ]);
    expect(decode({
      type: 'turn.done',
      turn: { id: `turn-${'x'.repeat(193)}`, role: 'assistant', transcript: 'too long id' },
    })).toEqual([]);
    expect(decode({
      type: 'turn.done',
      turn: { id: ' turn-with-space ', role: 'assistant', transcript: 'not normalized' },
    })).toEqual([]);
    expect(decode({
      type: 'turn.done',
      turn: { id: 'turn-1', role: 'assistant', transcript: 'x'.repeat(64 * 1024 + 1) },
    })).toEqual([]);
  });

  it('reports whole-attempt transcript unavailability once when a started attempt terminates with no authoritative final', () => {
    const diagnostics: string[] = [];
    const attempt = asAttemptDecoder(createCodexV3ControlDecoder({
      attemptId: 20,
      diagnostic: (code) => diagnostics.push(code),
    }));

    attempt.markStarted();
    attempt.finalize();
    attempt.finalize();

    expect(diagnostics).toEqual(['codex_v3_conversational_transcript_unavailable']);
  });

  it('reports malformed-final diagnostics and whole-attempt unavailability without inventing a transcript item', () => {
    const diagnostics: string[] = [];
    const attempt = asAttemptDecoder(createCodexV3ControlDecoder({
      attemptId: 21,
      diagnostic: (code) => diagnostics.push(code),
    }));

    attempt.markStarted();
    expect(attempt({
      type: 'turn.done',
      turn: { id: '', role: 'assistant', transcript: 'missing identity' },
    })).toEqual([]);
    attempt.finalize();

    expect(diagnostics).toEqual([
      'codex_v3_malformed_turn_done',
      'codex_v3_conversational_transcript_unavailable',
    ]);
  });

  it('makes unpaired-surrogate turn identities inert without suppressing whole-attempt unavailability', () => {
    for (const malformedTurnId of ['turn-\uD800', 'turn-\uDC00']) {
      const diagnostics: string[] = [];
      const attempt = asAttemptDecoder(createCodexV3ControlDecoder({
        attemptId: 21,
        diagnostic: (code) => diagnostics.push(code),
      }));

      attempt.markStarted();
      expect(() => attempt({
        type: 'turn.done',
        turn: {
          id: malformedTurnId,
          role: 'assistant',
          transcript: 'must not become an invented final',
        },
      })).not.toThrow();
      expect(attempt({
        type: 'turn.done',
        turn: {
          id: malformedTurnId,
          role: 'assistant',
          transcript: 'must not become an invented final',
        },
      })).toEqual([]);
      attempt.finalize();

      expect(diagnostics).toEqual([
        'codex_v3_malformed_turn_done',
        'codex_v3_conversational_transcript_unavailable',
      ]);
    }
  });

  it('does not report transcript unavailability when the attempt accepted an authoritative final', () => {
    const diagnostics: string[] = [];
    const attempt = asAttemptDecoder(createCodexV3ControlDecoder({
      attemptId: 22,
      diagnostic: (code) => diagnostics.push(code),
    }));

    attempt.markStarted();
    expect(attempt({
      type: 'turn.done',
      turn: { id: 'turn-22', role: 'assistant', transcript: 'Finished.' },
    })).toHaveLength(1);
    attempt.finalize();

    expect(diagnostics).toEqual([]);
  });

  it('keeps abort before upstream start inert but reports End Voice after a started zero-final attempt', () => {
    const beforeStartDiagnostics: string[] = [];
    const beforeStart = asAttemptDecoder(createCodexV3ControlDecoder({
      attemptId: 23,
      diagnostic: (code) => beforeStartDiagnostics.push(code),
    }));
    beforeStart.finalize();
    expect(beforeStartDiagnostics).toEqual([]);

    const afterStartDiagnostics: string[] = [];
    const afterStart = asAttemptDecoder(createCodexV3ControlDecoder({
      attemptId: 24,
      diagnostic: (code) => afterStartDiagnostics.push(code),
    }));
    afterStart.markStarted();
    afterStart.finalize();
    expect(afterStartDiagnostics).toEqual([
      'codex_v3_conversational_transcript_unavailable',
    ]);
  });
});
