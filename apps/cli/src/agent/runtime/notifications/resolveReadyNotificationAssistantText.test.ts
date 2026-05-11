import { describe, expect, it } from 'vitest';

import { createTurnAssistantTextSnapshotStore } from '@/api/session/turns/assistantTextSnapshotStore';
import { resolveReadyNotificationAssistantText } from './resolveReadyNotificationAssistantText';

describe('resolveReadyNotificationAssistantText', () => {
  it('returns null when assistant preview text is disabled', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: null, startedAtMs: 100 });
    store.observe({ text: 'Snapshot answer', source: 'committed' });

    expect(resolveReadyNotificationAssistantText({
      includeAssistantPreviewText: false,
      explicitAssistantText: 'Explicit answer',
      snapshotStore: store,
      turnToken: 'turn-1',
      startSeqExclusive: null,
    })).toBeNull();
  });

  it('prefers trusted explicit text over the snapshot', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: null, startedAtMs: 100 });
    store.observe({ text: 'Snapshot answer', source: 'committed' });

    expect(resolveReadyNotificationAssistantText({
      includeAssistantPreviewText: true,
      explicitAssistantText: '  Explicit\n\nanswer  ',
      snapshotStore: store,
      turnToken: 'turn-1',
      startSeqExclusive: null,
    })).toBe('Explicit answer');
  });

  it('falls back to the current turn snapshot', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: 3, startedAtMs: 100 });
    store.observe({ text: 'Snapshot answer', source: 'committed', seq: 4 });

    expect(resolveReadyNotificationAssistantText({
      includeAssistantPreviewText: true,
      snapshotStore: store,
      turnToken: 'turn-1',
      startSeqExclusive: 3,
    })).toBe('Snapshot answer');
  });
});
