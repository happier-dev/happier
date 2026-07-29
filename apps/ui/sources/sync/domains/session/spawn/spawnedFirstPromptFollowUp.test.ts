import { describe, expect, it } from 'vitest';

import {
  resolveSpawnedFirstPromptFollowUp,
} from './spawnedFirstPromptFollowUp';

describe('resolveSpawnedFirstPromptFollowUp', () => {
  it('uses the caller-owned first-turn local id and preserves message meta', () => {
    const resolved = resolveSpawnedFirstPromptFollowUp({
      sessionId: 'session-1',
      fallbackLocalId: 'first-turn-local',
      initialMessageText: '  Start here  ',
      metaOverrides: { model: 'gpt-5' },
    });

    expect(resolved).toEqual({
      initialMessageText: 'Start here',
      messageLocalId: 'first-turn-local',
      metaOverrides: {
        model: 'gpt-5',
      },
      optimisticDeliveryStatus: 'queued',
    });
  });

  it('keeps the normal first-turn local id when spawn did not carry the first prompt', () => {
    const resolved = resolveSpawnedFirstPromptFollowUp({
      sessionId: 'session-1',
      fallbackLocalId: 'first-turn-local',
      initialMessageText: 'Start here',
      metaOverrides: null,
    });

    expect(resolved).toEqual({
      initialMessageText: 'Start here',
      messageLocalId: 'first-turn-local',
      metaOverrides: undefined,
      optimisticDeliveryStatus: 'queued',
    });
  });

  it('returns an empty follow-up without message meta when there is no first prompt text', () => {
    const resolved = resolveSpawnedFirstPromptFollowUp({
      sessionId: 'session-1',
      fallbackLocalId: 'first-turn-local',
      initialMessageText: '   ',
      metaOverrides: { source: 'custom' },
    });

    expect(resolved).toEqual({
      initialMessageText: '',
      messageLocalId: 'first-turn-local',
      metaOverrides: undefined,
      optimisticDeliveryStatus: 'queued',
    });
  });
});
