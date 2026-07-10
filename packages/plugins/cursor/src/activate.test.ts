import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

describe('activate', () => {
  it('registers the Cursor backend engine through the plugin API', async () => {
    const registerAgentRuntime = vi.fn();

    activate({ registerAgentRuntime });

    expect(registerAgentRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'cursor',
      create: expect.any(Function),
    }));
    const backendRegistration = registerAgentRuntime.mock.calls[0]?.[0] as Readonly<{
      create: (ctx: unknown) => Promise<unknown>;
    }>;
    const pluginContext = {
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
    await expect(backendRegistration.create(pluginContext)).resolves.toEqual(expect.objectContaining({
      runtimeCore: expect.any(Object),
    }));
    expect(pluginContext.logger.debug).toHaveBeenCalledWith('[plugins/cursor] Creating backend engine');
    expect(pluginContext.logger.info).not.toHaveBeenCalled();
  });
});
