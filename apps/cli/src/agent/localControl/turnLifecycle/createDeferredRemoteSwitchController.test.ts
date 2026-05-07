import { describe, expect, it } from 'vitest';

import { createDeferredRemoteSwitchController } from './createDeferredRemoteSwitchController';
import { createLocalTurnLifecycleController } from './createLocalTurnLifecycleController';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createDeferredRemoteSwitchController', () => {
  it('switches immediately when a queued message arrives while lifecycle is idle', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    const switchSources: string[] = [];
    const modes: string[] = [];
    const controller = createDeferredRemoteSwitchController({
      lifecycle,
      providerLabel: 'test',
      requestSwitchToRemote: async (source) => {
        switchSources.push(source);
        return true;
      },
      onQueuedMessageMode: (mode: { permissionMode: string }) => {
        modes.push(mode.permissionMode);
      },
    });

    controller.onQueuedMessage('hello', { permissionMode: 'default' });
    await flushMicrotasks();

    expect(modes).toEqual(['default']);
    expect(switchSources).toEqual(['queued_message']);

    controller.dispose();
    lifecycle.dispose();
  });

  it('defers queued-message switches until an active local turn reaches a terminal boundary', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    lifecycle.observe({ type: 'turn_started', providerTurnId: 'turn-1', source: 'test' });
    const switchSources: string[] = [];
    const controller = createDeferredRemoteSwitchController({
      lifecycle,
      providerLabel: 'test',
      requestSwitchToRemote: async (source) => {
        switchSources.push(source);
        return true;
      },
    });

    controller.onQueuedMessage('first', { permissionMode: 'default' });
    controller.onQueuedMessage('second', { permissionMode: 'default' });
    await flushMicrotasks();
    expect(switchSources).toEqual([]);

    lifecycle.observe({
      type: 'turn_terminal',
      providerTurnId: 'turn-1',
      reason: 'completed',
      source: 'test',
    });
    await flushMicrotasks();

    expect(switchSources).toEqual(['queued_message']);

    controller.dispose();
    lifecycle.dispose();
  });

  it('routes isolate queue arrivals through the same deferred switch path', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    lifecycle.observe({ type: 'turn_started', providerTurnId: 'turn-1', source: 'test' });
    const switchSources: string[] = [];
    const controller = createDeferredRemoteSwitchController({
      lifecycle,
      providerLabel: 'test',
      requestSwitchToRemote: async (source) => {
        switchSources.push(source);
        return true;
      },
    });

    controller.onQueuedMessage('/clear', { permissionMode: 'read-only' });
    await flushMicrotasks();
    expect(switchSources).toEqual([]);

    lifecycle.observe({
      type: 'turn_terminal',
      providerTurnId: 'turn-1',
      reason: 'aborted',
      source: 'test',
    });
    await flushMicrotasks();

    expect(switchSources).toEqual(['queued_message']);

    controller.dispose();
    lifecycle.dispose();
  });

  it('defers explicit remote switch requests while active and coalesces with queued messages', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    lifecycle.observe({ type: 'turn_started', providerTurnId: 'turn-1', source: 'test' });
    const switchSources: string[] = [];
    const controller = createDeferredRemoteSwitchController({
      lifecycle,
      providerLabel: 'test',
      requestSwitchToRemote: async (source) => {
        switchSources.push(source);
        return true;
      },
    });

    const requestPromise = controller.requestRemoteSwitch('rpc_switch');
    controller.onQueuedMessage('hello', { permissionMode: 'default' });
    await flushMicrotasks();
    expect(switchSources).toEqual([]);

    lifecycle.observe({
      type: 'turn_terminal',
      providerTurnId: 'turn-1',
      reason: 'process-exited',
      source: 'test',
    });

    await expect(requestPromise).resolves.toBe(true);
    await flushMicrotasks();
    expect(switchSources).toEqual(['rpc_switch']);

    controller.dispose();
    lifecycle.dispose();
  });
});
