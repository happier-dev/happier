import { describe, expect, it } from 'vitest';

import {
  resolvePendingDrainTimeoutMs,
  resolveScenarioWaitMs,
  resolveSessionActiveWaitMs,
  waitForSessionActiveBestEffort,
} from '../../src/testkit/providers/harness';

describe('providers harness: resolveSessionActiveWaitMs', () => {
  it('defaults to provider global wait when unset', () => {
    expect(resolveSessionActiveWaitMs(undefined)).toBe(240_000);
  });

  it('inherits larger global wait values up to 240s', () => {
    expect(resolveSessionActiveWaitMs('120000')).toBe(120_000);
    expect(resolveSessionActiveWaitMs('360000')).toBe(240_000);
  });
});

describe('providers harness: resolveScenarioWaitMs', () => {
  it('defaults to global wait when scenario wait is unset', () => {
    expect(resolveScenarioWaitMs({ scenarioWaitMs: undefined, globalWaitMsRaw: '240000' })).toBe(240_000);
  });

  it('applies scenario-specific wait and clamps upper bound', () => {
    expect(resolveScenarioWaitMs({ scenarioWaitMs: 600_000, globalWaitMsRaw: '120000' })).toBe(600_000);
    expect(resolveScenarioWaitMs({ scenarioWaitMs: 9_999_999, globalWaitMsRaw: '120000' })).toBe(3_600_000);
  });
});

describe('providers harness: resolvePendingDrainTimeoutMs', () => {
  it('uses a longer timeout for codex', () => {
    expect(resolvePendingDrainTimeoutMs({ providerId: 'codex', scenarioMeta: {} })).toBe(180_000);
  });

  it('uses long timeout for claude agent sdk mode', () => {
    expect(resolvePendingDrainTimeoutMs({
      providerId: 'claude',
      scenarioMeta: { claudeRemoteAgentSdkEnabled: true },
    })).toBe(300_000);
  });

  it('uses default timeout for other providers', () => {
    expect(resolvePendingDrainTimeoutMs({ providerId: 'kilo', scenarioMeta: {} })).toBe(60_000);
  });
});

describe('providers harness: waitForSessionActiveBestEffort', () => {
  it('skips waiting when yolo is disabled', async () => {
    let called = 0;
    await waitForSessionActiveBestEffort({
      yolo: false,
      wait: async () => {
        called += 1;
      },
    });
    expect(called).toBe(0);
  });

  it('swallows wait errors when yolo is enabled', async () => {
    await expect(
      waitForSessionActiveBestEffort({
        yolo: true,
        wait: async () => {
          throw new Error('session inactive');
        },
      }),
    ).resolves.toBeUndefined();
  });
});
