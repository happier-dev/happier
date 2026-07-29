import { describe, expect, it } from 'vitest';

import { mergeVoiceSurfaceTranscriptEntries } from './mergeVoiceSurfaceTranscriptEntries';

describe('mergeVoiceSurfaceTranscriptEntries', () => {
  it('preserves interrupted generated text and surfaces the interrupted state', () => {
    const entries = mergeVoiceSurfaceTranscriptEntries([{
      id: 'assistant-interrupted',
      createdAt: 1,
      kind: 'assistant',
      text: 'The complete generated response',
      interrupted: true,
    }], []);

    expect(entries[0]).toMatchObject({
      text: 'The complete generated response',
      transcriptState: 'interrupted',
    });
  });

  it('shows partial text provisionally and replaces it in place when finalized/corrected', () => {
    const partial = mergeVoiceSurfaceTranscriptEntries([], [{
      epoch: 1,
      attemptIdentity: 'attempt-1',
      itemId: 'item-1',
      role: 'assistant',
      text: 'Hel',
      final: false,
      corrected: false,
      revision: 1,
      firstSequence: 1,
      lastSequence: 1,
      provenance: 'live',
      announce: 'none',
    }]);
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ text: 'Hel', transcriptState: 'partial', announce: false });
    expect(partial[0]?.announcementId).toBe('voice-realtime:attempt-1:assistant:item-1:1');

    const corrected = mergeVoiceSurfaceTranscriptEntries([{ ...partial[0]!, text: 'Hello', transcriptState: 'final' }], [{
      epoch: 1,
      attemptIdentity: 'attempt-1',
      itemId: 'item-1',
      role: 'assistant',
      text: 'Hello!',
      final: true,
      corrected: true,
      revision: 3,
      firstSequence: 1,
      lastSequence: 3,
      provenance: 'live',
      announce: 'polite',
    }]);
    expect(corrected).toHaveLength(1);
    expect(corrected[0]).toMatchObject({ text: 'Hello!', transcriptState: 'corrected', announce: true });
    expect(corrected[0]?.announcementId).toBe('voice-realtime:attempt-1:assistant:item-1:3');
  });

  it('dedupes replay by stable canonical item id', () => {
    const first = mergeVoiceSurfaceTranscriptEntries([], [{
      epoch: 2,
      attemptIdentity: 'attempt-2',
      itemId: 'same',
      role: 'user',
      text: 'Hello',
      final: true,
      corrected: false,
      revision: 1,
      firstSequence: 4,
      lastSequence: 4,
      provenance: 'replay',
      announce: 'polite',
    }]);
    expect(mergeVoiceSurfaceTranscriptEntries(first, [{
      epoch: 2,
      attemptIdentity: 'attempt-2',
      itemId: 'same',
      role: 'user',
      text: 'Hello',
      final: true,
      corrected: false,
      revision: 1,
      firstSequence: 4,
      lastSequence: 4,
      provenance: 'replay',
      announce: 'polite',
    }])).toHaveLength(1);
  });

  it('merges a persisted final with its live canonical item by restart-safe attempt identity', () => {
    const canonical = {
      epoch: 1,
      attemptIdentity: 'attempt-after-reload',
      itemId: 'same-upstream-id',
      role: 'assistant' as const,
      text: 'Hello after reload',
      final: true,
      corrected: false,
      revision: 1,
      firstSequence: 1,
      lastSequence: 1,
      provenance: 'live' as const,
      announce: 'polite' as const,
    };
    const persistedId = 'voice-realtime:attempt-after-reload:assistant:same-upstream-id';

    const merged = mergeVoiceSurfaceTranscriptEntries([{
      id: persistedId,
      createdAt: 1,
      kind: 'assistant',
      text: canonical.text,
      interrupted: false,
    }], [canonical]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: persistedId,
      text: canonical.text,
      transcriptState: 'final',
    });
  });
});
