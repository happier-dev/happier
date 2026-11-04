import { describe, expect, it } from 'vitest';

import {
  VoiceAgentOutputEventV1Schema,
  createVoiceAgentOutputTurnV1,
  ingestVoiceAgentOutputEventV1,
  resolveVoiceAgentOutputSpeechSegmentLength,
} from './outputEvents.js';

describe('VoiceAgentOutputEventV1', () => {
  it('retains the receiving final-text and sequence wire boundaries without a cumulative quota', () => {
    const event = { v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 4095, text: 'x'.repeat(65_536) } as const;
    expect(VoiceAgentOutputEventV1Schema.safeParse(event).success).toBe(true);
    expect(VoiceAgentOutputEventV1Schema.safeParse({ ...event, seq: 4096 }).success).toBe(false);
    expect(VoiceAgentOutputEventV1Schema.safeParse({ ...event, text: `${event.text}x` }).success).toBe(false);
  });

  it.each([
    ['Run this:\n```ts\nconst a = 1;\n```\nThen restart.', 'Run this:\nThen restart.'],
    ['## Summary\n- **Fixed** the `parser` bug\n> _really_ fixed', 'Summary\nFixed the parser bug\nreally fixed'],
    ['See [the docs](https://example.com/a/b) and ![diagram](x.png).', 'See the docs and diagram.'],
    ['Open https://www.github.com/happier-dev/happier/pull/1 now.', 'Open github.com now.'],
    ['Set max_retry_count to 2 * 3, 2*3, 2 *3, and 2* 3.', 'Set max_retry_count to 2 * 3, 2*3, 2 *3, and 2* 3.'],
    ['Use *.ts and file* and **/*.ts and *test.ts, with max_retry_count and 2*3.', 'Use *.ts and file* and **/*.ts and *test.ts, with max_retry_count and 2*3.'],
    ['Read **file.ts** with *file.ts*.', 'Read file.ts with file.ts.'],
    ['See [`parser`](https://example.test/docs), [**`value`**](u), [***`nested`***](u), and ![`diagram`](i). Literal `[x](url)`.',
      'See parser, value, nested, and diagram. Literal [x](url).'],
    ['Code `left [x` out](u) **done**.', 'Code left [x out](u) done.'],
    ['Call `f(*args, **kwargs)`, `__init__`, `~~value~~`, `max`_retry_count, and `https://example.test/a`. After `x` # keep. Then **done**.',
      'Call f(*args, **kwargs), __init__, ~~value~~, max_retry_count, and https://example.test/a. After x # keep. Then done.'],
    ['```\nls -la\n```', ''],
    ['Before.\n~~~py\nprint(1)\n~~~\nAfter.', 'Before.\nAfter.'],
    ['Example:\n````md\n```ts\nconst a = 1;\n```\n````\nThat is all.', 'Example:\nThat is all.'],
    ['First part.\n- - -\nSecond part.', 'First part.\nSecond part.'],
  ])('derives speakable prose while preserving final source text: %s', (text, spoken) => {
    const result = ingestVoiceAgentOutputEventV1(createVoiceAgentOutputTurnV1('turn-1'), {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 0, text,
    });
    expect(result.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text)).toEqual(spoken ? [spoken] : []);
    expect(result.effects.at(-1)).toEqual({ kind: 'persist_final', text });
  });

  it('keeps fence context across speech events and ignores replayed segments', () => {
    const deltas = ['**Before.**\n``', '``md\n```ts\nconst a = 1;\n', '```\n', '````\nSee [docs](https://example.test).'];
    let state = createVoiceAgentOutputTurnV1('turn-1');
    const spoken: string[] = [];
    for (const text of deltas) {
      const event = { v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: state.nextSeq,
        segmentId: `segment-${state.nextSeq}`, text } as const;
      const result = ingestVoiceAgentOutputEventV1(state, event);
      state = result.state;
      spoken.push(...result.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text));
      expect(ingestVoiceAgentOutputEventV1(state, event).effects).toEqual([]);
    }
    expect(spoken.join(' ').replace(/\s+/gu, ' ').trim()).toBe('Before. See docs.');
    const text = deltas.join('');
    expect(ingestVoiceAgentOutputEventV1(state, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: state.nextSeq, text,
    }).effects).toEqual([{ kind: 'persist_final', text }]);
  });

  it.each(['**', '*', '__', '_', '~~'])('normalizes %s emphasis across real speech segment boundaries while emitting the first sentence', marker => {
    const text = `${marker}Hello. World.${marker} Use *.ts and **/*.ts and file* with max_retry_count and 2 * 3.`;
    let remaining = text;
    let state = createVoiceAgentOutputTurnV1('turn-1');
    const spoken: string[] = [];
    const firstLength = resolveVoiceAgentOutputSpeechSegmentLength(remaining, { force: false, firstSegment: true });
    expect(firstLength).toBeGreaterThan(0);
    for (const length of [firstLength, remaining.length - firstLength]) {
      const result = ingestVoiceAgentOutputEventV1(state, {
        v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: state.nextSeq,
        segmentId: `segment-${state.nextSeq}`, text: remaining.slice(0, length),
      });
      state = result.state;
      remaining = remaining.slice(length);
      spoken.push(...result.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text));
      if (spoken.length === 1) expect(spoken[0]).toBe('Hello.');
    }
    const final = ingestVoiceAgentOutputEventV1(state, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: state.nextSeq, text,
    });
    spoken.push(...final.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text));
    expect(spoken.join(' ').replace(/\s+/gu, ' ').trim())
      .toBe('Hello. World. Use *.ts and **/*.ts and file* with max_retry_count and 2 * 3.');
    expect(final.effects.at(-1)).toEqual({ kind: 'persist_final', text });
  });

  it.each([true, false])('never speaks code split by the wire envelope (closed: %s)', closed => {
    const text = `Before.\n~~~sh\n${'secret();\n'.repeat(3_000)}${closed ? '~~~\nAfter.' : ''}`;
    let remaining = text;
    let state = createVoiceAgentOutputTurnV1('turn-1');
    const spoken: string[] = [];
    while (remaining) {
      const length = resolveVoiceAgentOutputSpeechSegmentLength(remaining, { force: true, firstSegment: state.nextSeq === 0 });
      const result = ingestVoiceAgentOutputEventV1(state, {
        v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: state.nextSeq,
        segmentId: `segment-${state.nextSeq}`, text: remaining.slice(0, length),
      });
      state = result.state;
      spoken.push(...result.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text));
      remaining = remaining.slice(length);
    }
    expect(spoken.join(' ').replace(/\s+/gu, ' ').trim()).toBe(closed ? 'Before. After.' : 'Before.');
    expect(ingestVoiceAgentOutputEventV1(state, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: state.nextSeq, text,
    }).effects).toEqual([{ kind: 'persist_final', text }]);
  });

  it('keeps words intact when a semantic segment needs more than one wire event', () => {
    const text = 'word '.repeat(5_000);
    const length = resolveVoiceAgentOutputSpeechSegmentLength(text, {
      force: true, firstSegment: true, targetChars: 20_000,
    });
    expect(/\s$/u.test(text.slice(0, length))).toBe(true);
    expect(/^word /u.test(text.slice(length))).toBe(true);
  });

  it.each([
    ['](https://example.test/docs). Then continue.', 'Ready first. See the parser documentation. Then continue.'],
    ['', 'Ready first. See [the parser documentation'],
    ['] remains literal.', 'Ready first. See [the parser documentation] remains literal.'],
  ])('retains only an undecidable link candidate across events and flushes literal text: %s', (tail, expected) => {
    let state = createVoiceAgentOutputTurnV1('turn-1');
    let spoken = '';
    for (const text of ['Ready first. See [the parser documentation', tail].filter(Boolean)) {
      const result = ingestVoiceAgentOutputEventV1(state, {
        v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: state.nextSeq,
        segmentId: `segment-${state.nextSeq}`, text,
      });
      state = result.state;
      spoken += result.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text).join('');
      if (state.nextSeq === 1) expect(spoken).toBe('Ready first. See ');
    }
    const text = `Ready first. See [the parser documentation${tail}`;
    const result = ingestVoiceAgentOutputEventV1(state, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: state.nextSeq, text,
    });
    spoken += result.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text).join('');
    expect(spoken.trim()).toBe(expected);
    expect(result.effects.at(-1)).toEqual({ kind: 'persist_final', text });
    expect(result.state.speechTextState).toBeNull();
  });

  it('normalizes a link label crossing the actual wire envelope without leaking its destination', () => {
    const label = 'a'.repeat(17_000);
    const text = `Ready first. See [${label}](https://example.test/docs). Then continue.`;
    let remaining = text;
    let state = createVoiceAgentOutputTurnV1('turn-1');
    let spoken = '';
    while (remaining) {
      const length = resolveVoiceAgentOutputSpeechSegmentLength(remaining, { force: true, firstSegment: state.nextSeq === 0 });
      const event = { v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: state.nextSeq,
        segmentId: `segment-${state.nextSeq}`, text: remaining.slice(0, length) } as const;
      expect(VoiceAgentOutputEventV1Schema.safeParse(event).success).toBe(true);
      const result = ingestVoiceAgentOutputEventV1(state, event);
      state = result.state;
      spoken += result.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text).join('');
      remaining = remaining.slice(length);
    }
    expect(state.nextSeq).toBeGreaterThan(1);
    expect(spoken).toBe(`Ready first. See ${label}. Then continue.`);
  });

  it('discards an undecidable link on cancellation', () => {
    let result = ingestVoiceAgentOutputEventV1(createVoiceAgentOutputTurnV1('turn-1'), {
      v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: 0, segmentId: 'first', text: 'Ready. [unfinished',
    });
    result = ingestVoiceAgentOutputEventV1(result.state, { v: 1, kind: 'turn_cancelled', turnId: 'turn-1', seq: 1 });
    expect(result.effects).toEqual([{ kind: 'cancel_turn' }]);
    expect(result.state.speechTextState).toBeNull();
    expect(ingestVoiceAgentOutputEventV1(result.state, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 2, text: 'Ready. [unfinished](url)',
    }).effects).toEqual([]);

  });

  it.each([
    { count: 300, text: 'Working', channel: 'status' },
    { count: 20, text: 'x'.repeat(16_384), channel: 'speech' },
  ])('admits valid $channel events beyond the retired cumulative budget and executes a late effect once', ({ count, text, channel }) => {
    let state = createVoiceAgentOutputTurnV1('turn-1');
    for (let index = 0; index < count; index += 1) {
      state = ingestVoiceAgentOutputEventV1(state, channel === 'status'
        ? { v: 1, kind: 'display_status', turnId: 'turn-1', seq: state.nextSeq, statusId: `status-${index}`, text }
        : { v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: state.nextSeq, segmentId: `segment-${index}`, text }).state;
    }
    const action = { t: 'sendSessionMessage', args: { message: 'Do it' } } as const;
    const event = { v: 1, kind: 'side_effect', turnId: 'turn-1', seq: state.nextSeq,
      effectId: 'late-effect', action } as const;
    const result = ingestVoiceAgentOutputEventV1(state, event);
    expect(result.effects).toEqual([{ kind: 'execute_side_effect', effectId: 'late-effect', action }]);
    expect(ingestVoiceAgentOutputEventV1(result.state, event).effects).toEqual([]);
    const final = ingestVoiceAgentOutputEventV1(result.state, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: result.state.nextSeq, text: 'Done',
    });
    expect(final.effects.at(-1)).toEqual({ kind: 'persist_final', text: 'Done' });
  });

  it('packs a large semantic segment into accepted wire events without dropping text or splitting Unicode', () => {
    const text = `${'x'.repeat(16_383)}😀${'y'.repeat(5_000)}`;
    let remaining = text;
    let spoken = '';
    let state = createVoiceAgentOutputTurnV1('turn-1');
    while (remaining) {
      const length = resolveVoiceAgentOutputSpeechSegmentLength(remaining, {
        force: true, firstSegment: !spoken, targetChars: 20_000,
      });
      const segment = remaining.slice(0, length);
      expect(segment).not.toMatch(/[\ud800-\udbff]$|^[\udc00-\udfff]/u);
      const result = ingestVoiceAgentOutputEventV1(state, {
        v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: state.nextSeq,
        segmentId: `segment-${state.nextSeq}`, text: segment,
      });
      state = result.state;
      spoken += result.effects.filter((effect) => effect.kind === 'speak').map((effect) => effect.text).join('');
      remaining = remaining.slice(length);
    }
    expect(spoken).toBe(text);
    expect(ingestVoiceAgentOutputEventV1(state, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: state.nextSeq, text,
    }).effects).toEqual([{ kind: 'persist_final', text }]);
  });

  it('preserves identifier punctuation when a wire event starts inside the identifier', () => {
    const text = `${'x'.repeat(16_381)}max_retry_count and file* with 2 * 3 and *.ts.`;
    let remaining = text;
    let spoken = '';
    let state = createVoiceAgentOutputTurnV1('turn-1');
    while (remaining) {
      const length = resolveVoiceAgentOutputSpeechSegmentLength(remaining, { force: true, firstSegment: state.nextSeq === 0 });
      const result = ingestVoiceAgentOutputEventV1(state, {
        v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: state.nextSeq,
        segmentId: `segment-${state.nextSeq}`, text: remaining.slice(0, length),
      });
      state = result.state;
      spoken += result.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text).join('');
      remaining = remaining.slice(length);
    }
    expect(spoken).toBe(text);
  });

  it('does not speak emphasis delimiters crossing the wire hard cut', () => {
    const text = `**${'a'.repeat(16_381)}**`;
    let remaining = text;
    let spoken = '';
    let state = createVoiceAgentOutputTurnV1('turn-1');
    while (remaining) {
      const length = resolveVoiceAgentOutputSpeechSegmentLength(remaining, { force: true, firstSegment: state.nextSeq === 0 });
      const result = ingestVoiceAgentOutputEventV1(state, {
        v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: state.nextSeq,
        segmentId: `segment-${state.nextSeq}`, text: remaining.slice(0, length),
      });
      state = result.state;
      spoken += result.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text).join('');
      remaining = remaining.slice(length);
    }
    expect(spoken).toBe('a'.repeat(16_381));
  });

  it.each([
    ['sentence', 'Call `f(*args, **kwargs). Still code` and **done**.', 'Call f(*args, **kwargs). Still code and done.'],
    ['wire', `${'a'.repeat(16_383)}\`\`f(*args, \`literal\`, **kwargs)\`\` then **done**.`, `${'a'.repeat(16_383)}f(*args, \`literal\`, **kwargs) then done.`],
  ])('preserves inline code across supported %s cuts', (boundary, text, expected) => {
    let remaining = text;
    let state = createVoiceAgentOutputTurnV1('turn-1');
    let spoken = '';
    while (remaining) {
      const length = resolveVoiceAgentOutputSpeechSegmentLength(remaining, {
        force: boundary === 'wire' || state.nextSeq !== 0, firstSegment: state.nextSeq === 0,
      });
      expect(length).toBeGreaterThan(0);
      const result = ingestVoiceAgentOutputEventV1(state, {
        v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: state.nextSeq,
        segmentId: `segment-${state.nextSeq}`, text: remaining.slice(0, length),
      });
      state = result.state;
      spoken += result.effects.filter(effect => effect.kind === 'speak').map(effect => effect.text).join('');
      if (state.nextSeq === 1 && boundary === 'sentence') expect(spoken).toBe('Call f(*args, **kwargs).');
      remaining = remaining.slice(length);
    }
    expect(spoken).toBe(expected);
  });

  it('accepts the four provider-neutral output channels and rejects unbounded identifiers/text', () => {
    const events = [
      { v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: 0, segmentId: 'seg-1', text: 'Hello' },
      { v: 1, kind: 'display_status', turnId: 'turn-1', seq: 1, statusId: 'status-1', text: 'Checking…' },
      { v: 1, kind: 'side_effect', turnId: 'turn-1', seq: 2, effectId: 'effect-1', action: { t: 'sendSessionMessage', args: { message: 'Do it' } } },
      { v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 3, text: 'Hello' },
    ];

    for (const event of events) expect(VoiceAgentOutputEventV1Schema.safeParse(event).success).toBe(true);
    expect(VoiceAgentOutputEventV1Schema.safeParse({ ...events[0], segmentId: 'x'.repeat(129) }).success).toBe(false);
    expect(VoiceAgentOutputEventV1Schema.safeParse({ ...events[1], text: 'x'.repeat(1025) }).success).toBe(false);
    expect(VoiceAgentOutputEventV1Schema.safeParse({ ...events[3], text: 'x'.repeat(65_537) }).success).toBe(false);
    expect(VoiceAgentOutputEventV1Schema.safeParse({ ...events[3], seq: 4_095 }).success).toBe(true);
    expect(VoiceAgentOutputEventV1Schema.safeParse({ ...events[3], seq: 4_096 }).success).toBe(false);
  });

  it('routes each channel once, deduplicates stable ids, and never turns status into speech or transcript', () => {
    let state = createVoiceAgentOutputTurnV1('turn-1');
    const speech = { v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: 0, segmentId: 'seg-1', text: 'Hello' } as const;
    const status = { v: 1, kind: 'display_status', turnId: 'turn-1', seq: 1, statusId: 'status-1', text: 'Working' } as const;
    const final = { v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 2, text: 'Hello world' } as const;

    let result = ingestVoiceAgentOutputEventV1(state, speech);
    state = result.state;
    expect(result.effects).toEqual([{ kind: 'speak', segmentId: 'seg-1', text: 'Hello' }]);
    result = ingestVoiceAgentOutputEventV1(state, speech);
    expect(result.effects).toEqual([]);

    result = ingestVoiceAgentOutputEventV1(state, status);
    state = result.state;
    expect(result.effects).toEqual([{ kind: 'display_status', statusId: 'status-1', text: 'Working' }]);
    result = ingestVoiceAgentOutputEventV1(state, final);
    expect(result.effects).toEqual([{ kind: 'persist_final', text: 'Hello world' }]);
  });

  it('derives one fallback speech segment only when a final arrives before any speech', () => {
    const event = { v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 0, text: 'Only final' } as const;
    const result = ingestVoiceAgentOutputEventV1(createVoiceAgentOutputTurnV1('turn-1'), event);
    expect(result.effects).toEqual([
      { kind: 'speak', segmentId: 'turn-1:final', text: 'Only final' },
      { kind: 'persist_final', text: 'Only final' },
    ]);
  });

  it('makes cancellation terminal and fails closed on another turn or non-monotonic sequence', () => {
    let state = createVoiceAgentOutputTurnV1('turn-1');
    let result = ingestVoiceAgentOutputEventV1(state, {
      v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: 0, segmentId: 'seg-1', text: 'Hello',
    });
    state = result.state;
    result = ingestVoiceAgentOutputEventV1(state, { v: 1, kind: 'turn_cancelled', turnId: 'turn-1', seq: 1 });
    state = result.state;
    expect(result.effects).toEqual([{ kind: 'cancel_turn' }]);
    expect(ingestVoiceAgentOutputEventV1(state, { v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 2, text: 'Late' }).effects).toEqual([]);
    expect(() => ingestVoiceAgentOutputEventV1(createVoiceAgentOutputTurnV1('turn-1'), {
      v: 1, kind: 'turn_final', turnId: 'other', seq: 0, text: 'Wrong',
    })).toThrow('voice_output_turn_mismatch');
    expect(() => ingestVoiceAgentOutputEventV1(state, {
      v: 1, kind: 'speech_segment', turnId: 'turn-1', seq: 0, segmentId: 'seg-2', text: 'Old',
    })).not.toThrow();
  });

  it('makes finalization terminal so replayed finals and late side effects cannot double-persist or execute', () => {
    let result = ingestVoiceAgentOutputEventV1(createVoiceAgentOutputTurnV1('turn-1'), {
      v: 1, kind: 'side_effect', turnId: 'turn-1', seq: 0, effectId: 'effect-1',
      action: { t: 'sendSessionMessage', args: { message: 'Do it' } },
    });
    expect(result.effects).toHaveLength(1);
    result = ingestVoiceAgentOutputEventV1(result.state, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 1, text: 'Done',
    });
    expect(result.effects).toEqual([
      { kind: 'speak', segmentId: 'turn-1:final', text: 'Done' },
      { kind: 'persist_final', text: 'Done' },
    ]);
    const finalized = result.state;
    expect(ingestVoiceAgentOutputEventV1(finalized, {
      v: 1, kind: 'turn_final', turnId: 'turn-1', seq: 1, text: 'Done',
    }).effects).toEqual([]);
    expect(ingestVoiceAgentOutputEventV1(finalized, {
      v: 1, kind: 'side_effect', turnId: 'turn-1', seq: 2, effectId: 'effect-late',
      action: { t: 'sendSessionMessage', args: { message: 'Run twice' } },
    }).effects).toEqual([]);
  });

});
