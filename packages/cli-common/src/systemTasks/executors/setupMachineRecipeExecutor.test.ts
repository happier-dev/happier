import { describe, expect, it, vi } from 'vitest';

import { createSetupMachineRecipeExecutorFromHappierJsonExecutor } from './setupMachineRecipeExecutor.js';

describe('createSetupMachineRecipeExecutorFromHappierJsonExecutor', () => {
  it('uses the service takeover contract for install and start when manual relay takeover is enabled', async () => {
    const runHappierJson = vi.fn(async () => ({ ok: true }));
    const executor = createSetupMachineRecipeExecutorFromHappierJsonExecutor({
      executor: {
        runHappierJson,
        runHappierText: vi.fn(),
      },
      options: {
        takeOverManualRelayRuntime: true,
      },
    });

    await executor.installDaemonService?.();
    await executor.startDaemonService?.();

    expect(runHappierJson).toHaveBeenNthCalledWith(1, ['service', 'install', '--takeover', '--json']);
    expect(runHappierJson).toHaveBeenNthCalledWith(2, ['service', 'start', '--takeover', '--json']);
  });
});
