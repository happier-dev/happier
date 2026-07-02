import { describe, expect, it } from 'vitest';

import {
  resolveCodexRolloutSessionStoreColdIdleMs,
  resolveCodexRolloutSessionStoreDetachedGraceMs,
  resolveCodexRolloutSessionStoreMaxRetainedItems,
} from './cachePolicy.js';

describe('codexRolloutSessionStoreCachePolicy', () => {
  it('uses bounded defaults when env values are absent or invalid', () => {
    expect(resolveCodexRolloutSessionStoreDetachedGraceMs({} as NodeJS.ProcessEnv)).toBe(5_000);
    expect(resolveCodexRolloutSessionStoreColdIdleMs({} as NodeJS.ProcessEnv)).toBe(30_000);
    expect(resolveCodexRolloutSessionStoreMaxRetainedItems({} as NodeJS.ProcessEnv)).toBe(10_000);
    expect(resolveCodexRolloutSessionStoreDetachedGraceMs({ HAPPIER_CODEX_ROLLOUT_SESSION_STORE_DETACHED_GRACE_MS: 'abc' } as NodeJS.ProcessEnv)).toBe(5_000);
    expect(resolveCodexRolloutSessionStoreColdIdleMs({ HAPPIER_CODEX_ROLLOUT_SESSION_STORE_COLD_IDLE_MS: '-1' } as NodeJS.ProcessEnv)).toBe(30_000);
    expect(resolveCodexRolloutSessionStoreMaxRetainedItems({
      HAPPIER_CODEX_ROLLOUT_SESSION_STORE_MAX_RETAINED_ITEMS: '0',
    } as NodeJS.ProcessEnv)).toBe(10_000);
  });

  it('reads custom bounded timing from env', () => {
    expect(resolveCodexRolloutSessionStoreDetachedGraceMs({
      HAPPIER_CODEX_ROLLOUT_SESSION_STORE_DETACHED_GRACE_MS: '750',
    } as NodeJS.ProcessEnv)).toBe(750);
    expect(resolveCodexRolloutSessionStoreColdIdleMs({
      HAPPIER_CODEX_ROLLOUT_SESSION_STORE_COLD_IDLE_MS: '120000',
    } as NodeJS.ProcessEnv)).toBe(120_000);
    expect(resolveCodexRolloutSessionStoreMaxRetainedItems({
      HAPPIER_CODEX_ROLLOUT_SESSION_STORE_MAX_RETAINED_ITEMS: '512',
    } as NodeJS.ProcessEnv)).toBe(512);
  });

  it('clamps overly large env values to the configured bounds', () => {
    expect(resolveCodexRolloutSessionStoreDetachedGraceMs({
      HAPPIER_CODEX_ROLLOUT_SESSION_STORE_DETACHED_GRACE_MS: '600000',
    } as NodeJS.ProcessEnv)).toBe(60_000);
    expect(resolveCodexRolloutSessionStoreColdIdleMs({
      HAPPIER_CODEX_ROLLOUT_SESSION_STORE_COLD_IDLE_MS: '900000',
    } as NodeJS.ProcessEnv)).toBe(300_000);
    expect(resolveCodexRolloutSessionStoreMaxRetainedItems({
      HAPPIER_CODEX_ROLLOUT_SESSION_STORE_MAX_RETAINED_ITEMS: '999999',
    } as NodeJS.ProcessEnv)).toBe(100_000);
  });
});
