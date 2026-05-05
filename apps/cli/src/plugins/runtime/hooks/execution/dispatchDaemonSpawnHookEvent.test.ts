import { describe, expect, it, vi } from 'vitest';

import { dispatchDaemonSpawnHookEvent } from './dispatchDaemonSpawnHookEvent';

describe('dispatchDaemonSpawnHookEvent', () => {
  it('builds a spawn hook envelope and disposes the executable runtime registry after dispatch', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const resolveRuntimeRegistry = vi.fn().mockResolvedValue({
      hookHandlersByHookId: new Map(),
      readHookEventEnvelopeV1: vi.fn(),
      dispose,
    });
    const dispatchEvent = vi.fn().mockResolvedValue({
      eventId: 'spawn.augmentEnv',
      matchedHandlerCount: 0,
      outcomes: [],
    });

    await dispatchDaemonSpawnHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'spawn.augmentEnv',
        backendId: 'codex',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
        },
        cwd: '/repo',
        payload: {
          runtimeSelection: {
            codexBackendMode: 'mcp',
          },
        },
      },
    }, {
      resolveRuntimeRegistry,
      dispatchEvent,
      nowMs: () => 123,
    });

    expect(resolveRuntimeRegistry).toHaveBeenCalledWith({ happyHomeDir: '/tmp/happy-home' });
    expect(dispatchEvent).toHaveBeenCalledWith({
      runtimeRegistry: expect.objectContaining({
        hookHandlersByHookId: expect.any(Map),
      }),
      event: expect.objectContaining({
        hookVersion: 1,
        eventId: 'spawn.augmentEnv',
        category: 'augmentation',
        scope: 'daemon',
        backendId: 'codex',
        backendTarget: 'backend:codex',
        cwd: '/repo',
        timestampMs: 123,
        payload: expect.objectContaining({
          runtimeSelection: {
            codexBackendMode: 'mcp',
          },
        }),
      }),
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
