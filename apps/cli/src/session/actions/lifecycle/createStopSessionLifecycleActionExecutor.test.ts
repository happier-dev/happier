import { describe, expect, it, vi } from 'vitest';

import { createMachineSessionStopLifecycleActionExecutor } from './createStopSessionLifecycleActionExecutor';

describe('createMachineSessionStopLifecycleActionExecutor', () => {
  it.each([
    { status: 'stopped' as const },
    { status: 'requested' as const },
    { status: 'not_found' as const },
    { status: 'incomplete' as const, reason: 'runner_exit_timeout' as const },
  ])('preserves the canonical Stop result $status', async (result) => {
    const stopSession = vi.fn(async () => result);
    const executor = createMachineSessionStopLifecycleActionExecutor({ stopSession: stopSession as never });

    await expect(executor.execute('session.stop', { sessionId: ' session-1 ' })).resolves.toEqual({
      ok: true,
      result,
    });
    expect(stopSession).toHaveBeenCalledWith('session-1');
  });
});
