import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { resolveHappierReplayConfig } from './happierReplayPrompt';

describe('resolveHappierReplayConfig', () => {
  it('returns a bounded recentMessagesCount and maxSeedChars budget', () => {
    const cfg = resolveHappierReplayConfig({
      ...settingsDefaults,
      sessionReplayEnabled: true,
      sessionReplayRecentMessagesCount: 10_000,
      sessionReplayMaxSeedChars: 10,
    });

    expect(cfg.enabled).toBe(true);
    expect(cfg.recentMessagesCount).toBe(500);
    expect((cfg as any).maxSeedChars).toBe(500);
  });
});

