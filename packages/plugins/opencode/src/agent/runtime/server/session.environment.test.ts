import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';

const { createStartupDeferredRuntime } = vi.hoisted(() => ({
  createStartupDeferredRuntime: vi.fn(),
}));

vi.mock('./startupDeferredSessionRuntime.js', () => ({
  createOpenCodeStartupDeferredSessionRuntime: createStartupDeferredRuntime,
}));

import { createOpenCodeServerSessionRuntime } from './session.js';

function createRuntimeFixture(): SessionRuntimeV1 {
  return {
    identity: { read: () => ({ providerSessionId: null }) },
    events: { subscribe: () => () => undefined },
    send: async () => ({ status: 'accepted' }),
    dispose: async () => undefined,
  };
}

describe('createOpenCodeServerSessionRuntime environment isolation', () => {
  beforeEach(() => {
    createStartupDeferredRuntime.mockReset();
    createStartupDeferredRuntime.mockReturnValue(createRuntimeFixture());
  });

  it('clears ambient provider credentials before constructing the OpenCode runtime', async () => {
    const ctx = {
      env: {
        list: () => ({
          OPENAI_API_KEY: 'ambient-key',
          KEEP_AMBIENT: 'visible',
        }),
      },
    } as unknown as PluginContextV1;

    await createOpenCodeServerSessionRuntime({
      ctx,
      sessionParams: {
        cwd: '/tmp/opencode-project',
        sessionId: 'happy-session-1',
        isolation: {
          env: {
            XDG_CONFIG_HOME: '/tmp/happier-opencode-config',
          },
          unsetEnvKeys: ['openai_api_key'],
        },
      } as CreateSessionRuntimeParamsV1,
    });

    expect(createStartupDeferredRuntime).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        KEEP_AMBIENT: 'visible',
        XDG_CONFIG_HOME: '/tmp/happier-opencode-config',
      },
    }));
  });
});
