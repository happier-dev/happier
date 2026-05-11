import { describe, expect, it } from 'vitest';

import { createTurnAssistantTextSnapshotStore } from './assistantTextSnapshotStore';

describe('TurnAssistantTextSnapshotStore', () => {
  it('normalizes and clamps root assistant text for the active turn', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 12 });

    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: 10, startedAtMs: 100 });
    store.observe({
      text: '  The branch\n\nis ready for review  ',
      source: 'streaming',
      localId: 'assistant-1',
      provider: 'codex',
      observedAtMs: 125,
    });

    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })).toMatchObject({
      text: 'The branch i',
      normalizedText: 'The branch i',
      turnToken: 'turn-1',
      startSeqExclusive: 10,
      seq: null,
      localId: 'assistant-1',
      sidechainId: null,
      provider: 'codex',
      source: 'streaming',
    });
  });

  it('clears previous-turn text and rejects stale sequenced observations', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });

    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: 5, startedAtMs: 100 });
    store.observe({
      text: 'Previous answer',
      source: 'committed',
      seq: 6,
      provider: 'opencode',
    });

    store.beginTurn({ turnToken: 'turn-2', startSeqExclusive: 6, startedAtMs: 200 });
    store.observe({
      text: 'Stale echo',
      source: 'socket',
      seq: 6,
      provider: 'opencode',
    });

    expect(store.getSnapshotAfter({ turnToken: 'turn-2', startSeqExclusive: 6 })).toBeNull();
  });

  it('ignores empty and sidechain assistant text for parent ready notifications', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });

    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: null, startedAtMs: 100 });
    store.observe({ text: '   ', source: 'streaming' });
    store.observe({ text: 'Nested answer', source: 'committed', sidechainId: 'task-1' });

    expect(store.getCurrentTurnSnapshot()).toBeNull();
  });

  it('uses the turn token as the guard for unsequenced text', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });

    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: 20, startedAtMs: 100 });
    store.observe({ text: 'Wrong turn', source: 'streaming', turnToken: 'turn-2' });
    store.observe({ text: 'Current live answer', source: 'streaming', turnToken: 'turn-1' });

    expect(store.getSnapshotAfter({ turnToken: 'turn-1', startSeqExclusive: 20 })?.normalizedText)
      .toBe('Current live answer');
  });

  it('does not attribute late unsequenced committed text to the next active turn', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });

    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: 1, startedAtMs: 100 });
    store.beginTurn({ turnToken: 'turn-2', startSeqExclusive: 2, startedAtMs: 200 });
    store.observe({
      text: 'Late previous answer',
      source: 'committed',
      localId: 'previous-commit',
    });

    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-2' })).toBeNull();
  });

  it('clears only the current snapshot while keeping the active turn open', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });

    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: 10, startedAtMs: 100 });
    store.observe({
      text: 'Stale streamed text',
      source: 'ephemeral',
      localId: 'segment-stale',
      provider: 'codex',
    });
    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })?.normalizedText)
      .toBe('Stale streamed text');

    store.clearSnapshot({ turnToken: 'turn-1', reason: 'media_only_commit' });
    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })).toBeNull();

    store.observe({
      text: 'Ready after media',
      source: 'streaming',
      localId: 'segment-final',
      provider: 'codex',
    });

    expect(store.getCurrentTurnSnapshot({ turnToken: 'turn-1' })).toMatchObject({
      normalizedText: 'Ready after media',
      source: 'streaming',
      localId: 'segment-final',
    });
  });
});
