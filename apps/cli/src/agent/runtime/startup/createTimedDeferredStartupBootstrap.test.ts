import { describe, expect, it, vi } from 'vitest';

import type { DeferredStartupBootstrapResult } from './deferredStartupTypes';
import { createStartupTiming } from './startupTiming';
import { createTimedDeferredStartupBootstrap } from './createTimedDeferredStartupBootstrap';

const { loggerDebug } = vi.hoisted(() => ({
  loggerDebug: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: loggerDebug,
  },
}));

describe('createTimedDeferredStartupBootstrap', () => {
  it('dedupes background start and exposes a shared vendor-spawn timing hook', async () => {
    let nowMs = 0;
    const timing = createStartupTiming({ enabled: true, nowMs: () => nowMs });
    const start = vi.fn(async () => {
      nowMs = 25;
    });

    const bootstrap = {
      api: {
        push: () => ({
          sendToAllDevices: vi.fn(),
          sendToAllDevicesAsync: vi.fn(async () => undefined),
        }),
      },
      session: {} as never,
      machineId: 'machine-1',
      metadata: {} as never,
      attachedToExistingSession: false,
      reconnectionHandle: null,
      start,
    } satisfies DeferredStartupBootstrapResult;

    const wrapped = createTimedDeferredStartupBootstrap({
      bootstrap,
      timing,
      logPrefix: '[test-startup]',
    });

    wrapped.markVendorSpawnInvoked();
    nowMs = 5;
    await Promise.all([wrapped.start?.(), wrapped.start?.()]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(loggerDebug).toHaveBeenCalledWith(expect.stringContaining('[test-startup]'));
    expect(loggerDebug).toHaveBeenCalledWith(expect.stringContaining('vendor_spawn_invoked=0ms'));
  });
});
