import { describe, expect, it } from 'vitest';

import { createLegacyVoiceOutputAdapter } from './legacyVoiceOutputAdapter';
import { createVoiceAgentOutputTurnV1, ingestVoiceAgentOutputEventV1, VOICE_OUTPUT_INCOMPLETE_TEXT, type VoiceAgentOutputEventV1 } from '@happier-dev/protocol';

describe('createLegacyVoiceOutputAdapter', () => {
  it.each([
    { text: '你好🙂'.repeat(15_000), actionCount: 1, incomplete: true },
    { text: 'word '.repeat(9_000), actionCount: 230, incomplete: true },
    { text: 'word '.repeat(12_800), actionCount: 1, incomplete: false },
  ])('keeps predecessor speech, actions and final within the receiving Protocol budget ($actionCount actions)', ({ text, actionCount, incomplete }) => {
    const adapter = createLegacyVoiceOutputAdapter({ streamId: 'stream-budget' });
    const events = [
      ...adapter.ingest(0, { t: 'delta', textDelta: text }),
      ...adapter.ingest(1, {
        t: 'done', assistantText: text,
        actions: Array.from({ length: actionCount }, () => ({ t: 'teleportVoiceAgentToSessionRoot', args: { sessionId: 's1' } })),
      }),
    ];
    let state = createVoiceAgentOutputTurnV1('stream-budget');
    for (const event of events) state = ingestVoiceAgentOutputEventV1(state, event).state;
    const speech = events.filter((event) => event.kind === 'speech_segment').map((event) => event.text).join('');
    const final = events.at(-1);
    expect(state.terminal).toBe('final');
    expect(final?.kind).toBe('turn_final');
    if (final?.kind !== 'turn_final') throw new Error('missing final');
    expect(final.text.startsWith(speech.trimEnd())).toBe(true);
    expect(final.text.endsWith(VOICE_OUTPUT_INCOMPLETE_TEXT)).toBe(incomplete);
    expect(speech.length).toBeGreaterThan(text.length / 4);
    expect(text.startsWith(speech)).toBe(true);
    if (!incomplete) expect(speech).toBe(text);
  });

  it('uses the same early semantic first-sentence boundary as the daemon producer', () => {
    const adapter = createLegacyVoiceOutputAdapter({ streamId: 'stream-1' });
    expect(adapter.ingest(0, { t: 'delta', textDelta: 'Open index.' })).toEqual([]);
    expect(adapter.ingest(1, { t: 'delta', textDelta: 'ts at 10:30. Next' })).toEqual([
      { v: 1, kind: 'speech_segment', turnId: 'stream-1', seq: 0, segmentId: 'stream-1:legacy:segment:0', text: 'Open index.ts at 10:30.' },
    ]);
  });
  it('maps legacy delta/done/actions into one ordered provider-neutral event stream', () => {
    const adapter = createLegacyVoiceOutputAdapter({ streamId: 'stream-1' });
    expect(adapter.ingest(0, { t: 'delta', textDelta: 'Hello ' })).toEqual([]);
    expect(adapter.ingest(1, {
      t: 'done',
      assistantText: 'Hello world',
      actions: [{ t: 'sendSessionMessage', args: { message: 'Do it' } }],
    })).toEqual([
      { v: 1, kind: 'speech_segment', turnId: 'stream-1', seq: 0, segmentId: 'stream-1:legacy:segment:0', text: 'Hello ' },
      {
        v: 1,
        kind: 'side_effect',
        turnId: 'stream-1',
        seq: 1,
        effectId: 'stream-1:legacy:1:0',
        action: { t: 'sendSessionMessage', args: { message: 'Do it' } },
      },
      { v: 1, kind: 'turn_final', turnId: 'stream-1', seq: 2, text: 'Hello world' },
    ]);
  });

  it('deduplicates a replayed source cursor and makes cancellation terminal', () => {
    const adapter = createLegacyVoiceOutputAdapter({ streamId: 'stream-1' });
    expect(adapter.ingest(0, { t: 'delta', textDelta: 'Hello' })).toEqual([]);
    expect(adapter.ingest(0, { t: 'delta', textDelta: 'Hello' })).toEqual([]);
    expect(adapter.ingest(1, { t: 'cancelled' })).toEqual([
      { v: 1, kind: 'turn_cancelled', turnId: 'stream-1', seq: 0 },
    ]);
    expect(adapter.ingest(2, { t: 'done', assistantText: 'Late' })).toEqual([]);
  });

  it('does not turn errors into speech, status, transcript, or side effects', () => {
    const adapter = createLegacyVoiceOutputAdapter({ streamId: 'stream-1' });
    expect(adapter.ingest(0, { t: 'error', error: 'private provider body' })).toEqual([]);
  });

  it('coalesces many legacy token events below the output budget and bounds replay memory', () => {
    const adapter = createLegacyVoiceOutputAdapter({ streamId: 'stream-1' });
    const emitted: VoiceAgentOutputEventV1[] = [];
    for (let cursor = 0; cursor < 1_000; cursor += 1) {
      emitted.push(...adapter.ingest(cursor, { t: 'delta', textDelta: 'x' }));
    }
    emitted.push(...adapter.ingest(1_000, { t: 'done', assistantText: 'x'.repeat(1_000) }));
    expect(emitted.filter((event) => event.kind === 'speech_segment').length).toBeLessThan(10);
    expect(emitted.filter((event) => event.kind === 'speech_segment').map((event) => event.text).join('')).toBe('x'.repeat(1_000));
    expect(emitted.at(-1)).toMatchObject({ kind: 'turn_final', text: 'x'.repeat(1_000) });
  });
});
