import { describe, expect, it, vi } from 'vitest';

import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';

describe('waitForTrackedRunnerProcessesExit', () => {
  it('waits until every exact tracked PID is observed dead', async () => {
    const readRunState = vi.fn()
      .mockResolvedValueOnce('servable')
      .mockResolvedValueOnce('servable')
      .mockResolvedValueOnce('dead')
      .mockResolvedValueOnce('zombie');

    await expect(waitForTrackedRunnerProcessesExit({
      runners: [{ pid: 101 }, { pid: 202 }],
      timeoutMs: 50,
      pollIntervalMs: 0,
      readRunState,
    })).resolves.toBe(true);
  });

  it('preserves the host while a tracked PID remains live or unprobeable', async () => {
    await expect(waitForTrackedRunnerProcessesExit({
      runners: [{ pid: 303 }],
      timeoutMs: 0,
      pollIntervalMs: 0,
      readRunState: vi.fn(async () => 'servable' as const),
    })).resolves.toBe(false);
  });
});
