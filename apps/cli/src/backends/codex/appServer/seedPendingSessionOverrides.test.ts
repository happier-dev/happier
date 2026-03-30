import { describe, expect, it, vi } from 'vitest';

import { seedCodexAppServerPendingSessionOverrides } from './seedPendingSessionOverrides';

describe('seedCodexAppServerPendingSessionOverrides', () => {
  it('skips seeding a cleared sessionModeOverrideV1 marker (modeId=\"default\")', async () => {
    const runtime = {
      setSessionMode: vi.fn(async (_modeId: string) => {}),
      setSessionModel: vi.fn(async (_modelId: string) => {}),
      setSessionConfigOption: vi.fn(async (_configId: string, _valueId: string) => {}),
    };

    await seedCodexAppServerPendingSessionOverrides({
      metadata: { sessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'default' } } as any,
      runtime,
    });

    expect(runtime.setSessionMode).not.toHaveBeenCalled();
  });
});
