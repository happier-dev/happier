import { describe, expect, it } from 'vitest';

import { createLegacyVoiceOutputAdapter } from './legacyVoiceOutputAdapter';
import type { VoiceAgentOutputEventV1 } from '@happier-dev/protocol';

describe('createLegacyVoiceOutputAdapter', () => {
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
