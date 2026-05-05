import { describe, expect, it, vi } from 'vitest';

import { dispatchBridgeLifecycleHookEvent } from './dispatchBridgeLifecycleHookEvent';

describe('dispatchBridgeLifecycleHookEvent', () => {
  it('builds a lifecycle envelope and dispatches through the executable runtime registry', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const resolveRuntimeRegistry = vi.fn().mockResolvedValue({
      hookHandlersByHookId: new Map(),
      readHookEventEnvelopeV1: vi.fn(),
      dispose,
    });
    const dispatchEvent = vi.fn().mockResolvedValue({
      eventId: 'execution_run.start',
      matchedHandlerCount: 0,
      outcomes: [],
    });

    await dispatchBridgeLifecycleHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'execution_run.start',
        happySessionId: 'sess_1',
        backendId: 'claude',
        payload: {
          runId: 'run_1',
          intent: 'review',
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
        eventId: 'execution_run.start',
        category: 'lifecycle',
        scope: 'session',
        happySessionId: 'sess_1',
        backendId: 'claude',
        timestampMs: 123,
        payload: expect.objectContaining({
          runId: 'run_1',
          intent: 'review',
        }),
      }),
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
