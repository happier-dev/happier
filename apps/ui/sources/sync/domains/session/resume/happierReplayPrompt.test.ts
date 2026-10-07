import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { resolveHappierReplayConfig } from './happierReplayPrompt';

describe('resolveHappierReplayConfig', () => {
  it('retains selected positive integer character and aggregate count budgets', () => {
    const cfg = resolveHappierReplayConfig({
      ...settingsDefaults,
      sessionReplayEnabled: true,
      sessionReplayRecentMessagesCount: 620,
      sessionReplayMaxSeedChars: 10,
    });

    expect(cfg.enabled).toBe(true);
    expect(cfg.recentMessagesCount).toBe(620);
    expect(cfg.maxSeedChars).toBe(10);
  });

  it('forwards selected positive budgets below and above the old bounds unchanged', () => {
    for (const stored of [1, 500, 512 * 1024]) {
      expect(resolveHappierReplayConfig({
        ...settingsDefaults,
        sessionReplayEnabled: true,
        sessionReplayMaxSeedChars: stored,
      }).maxSeedChars).toBe(stored);
    }
  });

  it('falls back for invalid selected budgets rather than rounding or clamping them', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const resolved = resolveHappierReplayConfig({
        ...settingsDefaults,
        sessionReplayRecentMessagesCount: invalid,
        sessionReplayMaxSeedChars: invalid,
      });
      expect(resolved.recentMessagesCount).toBe(settingsDefaults.sessionReplayRecentMessagesCount);
      expect(resolved.maxSeedChars).toBe(settingsDefaults.sessionReplayMaxSeedChars);
    }
  });
});
