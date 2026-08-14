import { describe, expect, it } from 'vitest';

import { createVoiceTranscriptLadderMapper } from './transcriptLadder';

describe('voice transcript ladder', () => {
  it('corrects one item when the provider supersedes its own final transcript', () => {
    const ladder = createVoiceTranscriptLadderMapper();
    // Observed on the xAI wire: one spoken utterance produced three
    // `conversation.item.input_audio_transcription.completed` events for the
    // same `item_id`, each superseding the last. All three must land on one
    // transcript row rather than appending three History entries.
    const supersedingFinals = [
      'For seven confirmed.',
      'Fly out loud with exactly these words: voice canary alpha seven confirmed.',
      'Say out loud with exactly these words: voice canary alpha seven confirmed.',
    ] as const;
    const events = supersedingFinals.map((transcript, index) => ladder.map({
      itemId: 'item-user-1',
      eventId: `evt-${index}`,
      role: 'user',
      incoming: transcript,
      mode: 'final',
    }));

    expect(events.every((event) => event !== null)).toBe(true);
    expect(new Set(events.map((event) => event?.itemId))).toEqual(new Set(['item-user-1']));
    expect(events.map((event) => event?.type)).toEqual([
      'voice.transcript.final',
      'voice.transcript.corrected',
      'voice.transcript.corrected',
    ]);
    expect(events.map((event) => event?.revision)).toEqual([1, 2, 3]);
    expect(events.at(-1)?.text).toBe(supersedingFinals[2]);
  });

  it('keeps a repeated identical final from publishing a second revision', () => {
    const ladder = createVoiceTranscriptLadderMapper();
    expect(ladder.map({
      itemId: 'item-1', eventId: 'evt-1', role: 'user', incoming: 'settled', mode: 'final',
    })).toMatchObject({ revision: 1, type: 'voice.transcript.final' });
    expect(ladder.map({
      itemId: 'item-1', eventId: 'evt-2', role: 'user', incoming: 'settled', mode: 'final',
    })).toBeNull();
  });

  it('seals the accumulated deltas when a final carries no text of its own', () => {
    const ladder = createVoiceTranscriptLadderMapper();
    ladder.map({ itemId: 'item-a', eventId: 'evt-1', role: 'assistant', incoming: 'Voice canary ', mode: 'delta' });
    ladder.map({ itemId: 'item-a', eventId: 'evt-2', role: 'assistant', incoming: 'alpha seven.', mode: 'delta' });

    // A textless `done` must not erase the row it completes.
    expect(ladder.map({
      itemId: 'item-a', eventId: 'evt-3', role: 'assistant', incoming: null, mode: 'final',
    })).toMatchObject({ type: 'voice.transcript.final', text: 'Voice canary alpha seven.', revision: 3 });
    // A textless interim event changes nothing at all.
    expect(ladder.map({
      itemId: 'item-b', eventId: 'evt-4', role: 'user', incoming: null, mode: 'updated',
    })).toBeNull();
  });

  it('refuses a late interim observation once the provider has finalized the item', () => {
    const ladder = createVoiceTranscriptLadderMapper();
    ladder.map({ itemId: 'item-a', eventId: 'evt-1', role: 'assistant', incoming: 'Complete sentence.', mode: 'final' });
    expect(ladder.map({
      itemId: 'item-a', eventId: 'evt-2', role: 'assistant', incoming: ' Complete sentence.', mode: 'delta',
    })).toBeNull();
    expect(ladder.map({
      itemId: 'item-a', eventId: 'evt-3', role: 'assistant', incoming: 'Complete', mode: 'updated',
    })).toBeNull();
  });

  it('starts a fresh epoch and drops carried-over items on a new conversation', () => {
    const ladder = createVoiceTranscriptLadderMapper();
    expect(ladder.map({
      itemId: 'item-1', eventId: 'evt-1', role: 'user', incoming: 'first', mode: 'final',
    })).toMatchObject({ epoch: 0, sequence: 1, revision: 1 });
    expect(ladder.beginConversation()).toBe(1);
    expect(ladder.map({
      itemId: 'item-1', eventId: 'evt-2', role: 'user', incoming: 'second', mode: 'updated',
    })).toMatchObject({ epoch: 1, sequence: 1, revision: 1, type: 'voice.transcript.updated' });
  });

  it('bounds retained item state without losing the identity of a later observation', () => {
    const ladder = createVoiceTranscriptLadderMapper({ maxItems: 2 });
    for (const itemId of ['item-1', 'item-2', 'item-3']) {
      ladder.map({ itemId, eventId: `evt-${itemId}`, role: 'user', incoming: 'partial', mode: 'delta' });
    }
    expect(ladder.map({
      itemId: 'item-1', eventId: 'evt-final', role: 'user', incoming: 'final', mode: 'final',
    })).toMatchObject({ itemId: 'item-1', revision: 1, text: 'final' });
  });
});
