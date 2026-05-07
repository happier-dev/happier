import { describe, expect, it, vi } from 'vitest';

import { createLocalTurnLifecycleController } from './createLocalTurnLifecycleController';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createLocalTurnLifecycleController', () => {
  it('treats idle lifecycle as immediately safe for remote handoff', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });

    await expect(lifecycle.waitForSafeRemoteHandoff()).resolves.toMatchObject({
      active: false,
      terminal: false,
      lastTerminalReason: null,
    });

    lifecycle.dispose();
  });

  it('waits while a local turn is active and resolves on terminal completion', async () => {
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    lifecycle.observe({ type: 'turn_started', providerTurnId: 'turn-1', source: 'test' });

    let resolved = false;
    const waiting = lifecycle.waitForSafeRemoteHandoff().then((snapshot) => {
      resolved = true;
      return snapshot;
    });

    await flushMicrotasks();
    expect(resolved).toBe(false);

    lifecycle.observe({
      type: 'turn_terminal',
      providerTurnId: 'turn-1',
      reason: 'completed',
      source: 'test',
    });

    await expect(waiting).resolves.toMatchObject({
      active: false,
      terminal: true,
      providerTurnId: 'turn-1',
      lastTerminalReason: 'completed',
    });

    lifecycle.dispose();
  });

  it('settles completion candidates only after quiescence and cancels them on continuation', async () => {
    vi.useFakeTimers();
    const lifecycle = createLocalTurnLifecycleController({ completionQuiescenceMs: 500 });
    lifecycle.observe({ type: 'turn_started', providerTurnId: 'turn-1', source: 'test' });

    let resolved = false;
    const waiting = lifecycle.waitForSafeRemoteHandoff().then((snapshot) => {
      resolved = true;
      return snapshot;
    });

    lifecycle.observe({ type: 'completion_candidate', providerTurnId: 'turn-1', source: 'first-stop' });
    await vi.advanceTimersByTimeAsync(499);
    await flushMicrotasks();
    expect(resolved).toBe(false);

    lifecycle.observe({ type: 'continuation_detected', providerTurnId: 'turn-1', source: 'stop-feedback' });
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(resolved).toBe(false);

    lifecycle.observe({ type: 'completion_candidate', providerTurnId: 'turn-1', source: 'final-stop' });
    await vi.advanceTimersByTimeAsync(500);

    await expect(waiting).resolves.toMatchObject({
      active: false,
      terminal: true,
      providerTurnId: 'turn-1',
      lastTerminalReason: 'completed',
    });

    lifecycle.dispose();
    vi.useRealTimers();
  });

  it('treats aborted and process-exited terminal events as safe handoff boundaries', async () => {
    const aborted = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    aborted.observe({ type: 'turn_started', providerTurnId: 'turn-a', source: 'test' });
    const abortedWait = aborted.waitForSafeRemoteHandoff();
    aborted.observe({ type: 'turn_terminal', providerTurnId: 'turn-a', reason: 'aborted', source: 'test' });
    await expect(abortedWait).resolves.toMatchObject({ lastTerminalReason: 'aborted' });
    aborted.dispose();

    const exited = createLocalTurnLifecycleController({ completionQuiescenceMs: 0 });
    exited.observe({ type: 'turn_started', providerTurnId: 'turn-b', source: 'test' });
    const exitedWait = exited.waitForSafeRemoteHandoff();
    exited.observe({ type: 'turn_terminal', providerTurnId: 'turn-b', reason: 'process-exited', source: 'test' });
    await expect(exitedWait).resolves.toMatchObject({ lastTerminalReason: 'process-exited' });
    exited.dispose();
  });
});
