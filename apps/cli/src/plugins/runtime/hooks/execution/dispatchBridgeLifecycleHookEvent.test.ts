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
      eventId: 'executionRun.started',
      matchedHandlerCount: 0,
      outcomes: [],
    });

    await dispatchBridgeLifecycleHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'executionRun.started',
        happySessionId: 'sess_1',
        agentId: 'claude',
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
        eventId: 'executionRun.started',
        category: 'lifecycle',
        scope: 'session',
        happySessionId: 'sess_1',
        agentId: 'claude',
        timestampMs: 123,
        payload: expect.objectContaining({
          runId: 'run_1',
          intent: 'review',
        }),
      }),
    });
    const dispatchedEvent = dispatchEvent.mock.calls[0]?.[0]?.event;
    expect(dispatchedEvent).not.toHaveProperty('providerId');
    expect(dispatchedEvent).not.toHaveProperty('backendId');
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
