import { describe, expect, it, vi } from 'vitest';

import { dispatchBridgeLifecycleHookEvent } from './dispatchBridgeLifecycleHookEvent';

describe('dispatchBridgeLifecycleHookEvent', () => {
  it('builds a lifecycle envelope and dispatches through the executable runtime registry', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const resolveRuntimeRegistry = vi.fn().mockResolvedValue({
      hookHandlersByHookId: new Map(),
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
          runtimeTargetKeys: ['agent:claude'],
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
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
          timestampMs: 123,
        }),
      }),
    });
    const dispatchedEvent = dispatchEvent.mock.calls[0]?.[0]?.event;
    expect(dispatchedEvent).not.toHaveProperty('providerId');
    expect(dispatchedEvent).not.toHaveProperty('backendId');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('adds the singular timestamp to the public payload and reaches a real registered handler', async () => {
    const handler = vi.fn(async () => undefined);
    const dispose = vi.fn().mockResolvedValue(undefined);
    const registration = {
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId: 'acme.observer',
      manifestPath: '/plugins/acme.observer/plugin.json',
      daemonEntryPath: '/plugins/acme.observer/daemon.mjs',
      sourceSpec: { kind: 'path' as const, locator: '/plugins/acme.observer', trustPolicy: 'local_trusted' as const, installPolicy: 'link' as const },
      definition: {
        hookApiVersion: 1 as const,
        id: 'executionRun.started' as const,
        category: 'lifecycle' as const,
        scope: 'session' as const,
        executionKind: 'observe' as const,
        handler: { target: 'plugin' as const, exportName: 'observeStart' },
      },
    };
    const resolveRuntimeRegistry = vi.fn().mockResolvedValue({
      hookHandlersByHookId: new Map([['executionRun.started', [{
        pluginId: registration.pluginId,
        hookId: registration.definition.id,
        priority: 0,
        registrationIndex: 0,
        manifestPath: registration.manifestPath,
        daemonEntryPath: registration.daemonEntryPath,
        exportName: 'observeStart',
        registration,
        handler,
      }]]]),
      dispose,
    });

    const result = await dispatchBridgeLifecycleHookEvent({
      happyHomeDir: '/tmp/happy-home',
      event: {
        eventId: 'executionRun.started',
        happySessionId: 'sess_1',
        payload: {
          runId: 'run_1',
          intent: 'review',
          runtimeTargetKeys: ['agent:claude'],
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
      },
    }, { resolveRuntimeRegistry, nowMs: () => 123 });

    expect(result).toMatchObject({ matchedHandlerCount: 1, outcomes: [{ status: 'fulfilled' }] });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      timestampMs: 123,
      payload: expect.objectContaining({ timestampMs: 123 }),
    }), undefined);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
