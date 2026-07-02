import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

describe('activate', () => {
  it('registers the CodeRabbit review-only execution-run backend engine', async () => {
    const registerBackendEngine = vi.fn();

    activate({ registerBackendEngine });

    expect(registerBackendEngine).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'coderabbit',
      create: expect.any(Function),
    }));

    const registration = registerBackendEngine.mock.calls[0]?.[0] as {
      create: (ctx: PluginContextV1) => Promise<{
        runtimeCore?: {
          createSessionRuntime: (params: unknown) => Promise<unknown>;
          createExecutionRunBackend: (params: unknown) => unknown;
        };
      }> | {
        runtimeCore?: {
          createSessionRuntime: (params: unknown) => Promise<unknown>;
          createExecutionRunBackend: (params: unknown) => unknown;
        };
      };
    };
    const engine = await registration.create({} as PluginContextV1);

    await expect(engine.runtimeCore?.createSessionRuntime({ cwd: '/tmp/repo' })).rejects.toThrow(/review-only/i);
    expect(engine.runtimeCore?.createExecutionRunBackend({ cwd: '/tmp/repo' })).toMatchObject({
      readResumeSupport: expect.any(Function),
      provisionSession: expect.any(Function),
      sendPrompt: expect.any(Function),
      cancel: expect.any(Function),
      subscribeMessages: expect.any(Function),
      dispose: expect.any(Function),
    });
  });
});
