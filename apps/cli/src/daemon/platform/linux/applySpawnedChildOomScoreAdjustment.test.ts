import { describe, expect, it, vi } from 'vitest';

import { applySpawnedChildOomScoreAdjustment, resolveSpawnedChildOomScoreAdjustmentValue } from './applySpawnedChildOomScoreAdjustment';

describe('resolveSpawnedChildOomScoreAdjustmentValue', () => {
  it('returns null when env is unset', () => {
    expect(resolveSpawnedChildOomScoreAdjustmentValue({})).toBeNull();
  });

  it('returns null when the env value is zero', () => {
    expect(resolveSpawnedChildOomScoreAdjustmentValue({
      HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '0',
    })).toBeNull();
  });

  it('clamps values to the supported linux range', () => {
    expect(resolveSpawnedChildOomScoreAdjustmentValue({
      HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '5000',
    })).toBe(1000);
  });
});

describe('applySpawnedChildOomScoreAdjustment', () => {
  it('writes a linux child oom score adjustment when enabled', async () => {
    const writeFile = vi.fn(async () => {});

    const applied = await applySpawnedChildOomScoreAdjustment({
      pid: 4242,
      platform: 'linux',
      env: { HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '321' },
      writeFile,
      logDebug: vi.fn(),
    });

    expect(applied).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/proc/4242/oom_score_adj', '321\n', 'utf8');
  });

  it('is a no-op outside linux', async () => {
    const writeFile = vi.fn(async () => {});

    const applied = await applySpawnedChildOomScoreAdjustment({
      pid: 4242,
      platform: 'darwin',
      env: { HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '600' },
      writeFile,
      logDebug: vi.fn(),
    });

    expect(applied).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('returns false when writing oom_score_adj fails', async () => {
    const writeFile = vi.fn(async () => {
      throw new Error('permission denied');
    });
    const logDebug = vi.fn();

    const applied = await applySpawnedChildOomScoreAdjustment({
      pid: 4242,
      platform: 'linux',
      env: { HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '250' },
      writeFile,
      logDebug,
    });

    expect(applied).toBe(false);
    expect(logDebug).toHaveBeenCalled();
  });
});
