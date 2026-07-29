import { describe, expect, it, vi } from 'vitest';

import { createAgentRuntimeBridgeEffectPump } from './agentRuntimeBridgeEffectPump';

describe('createAgentRuntimeBridgeEffectPump', () => {
  it('keeps pumping around one active effect and deduplicates its retained redelivery', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runFirst = vi.fn(async () => await first);
    const runSecond = vi.fn(async () => undefined);
    const pump = createAgentRuntimeBridgeEffectPump({ maxActive: 2 });

    expect(pump.admit('effect-1', runFirst)).toBe('started');
    expect(pump.admit('effect-1', runFirst)).toBe('duplicate');
    expect(pump.admit('effect-2', runSecond)).toBe('started');
    await vi.waitFor(() => expect(runSecond).toHaveBeenCalledOnce());
    expect(runFirst).toHaveBeenCalledOnce();

    releaseFirst();
    await pump.whenIdle();
  });

  it('fails closed before exceeding its active-effect bound', async () => {
    const never = new Promise<void>(() => undefined);
    const pump = createAgentRuntimeBridgeEffectPump({ maxActive: 1 });
    expect(pump.admit('effect-1', async () => await never)).toBe('started');
    expect(pump.admit('effect-2', async () => undefined)).toBe('overflow');
  });

  it('cancels one held effect without blocking a later distinct effect', async () => {
    const firstAborted = vi.fn();
    const second = vi.fn(async () => undefined);
    const pump = createAgentRuntimeBridgeEffectPump({ maxActive: 2 });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    expect(pump.admit('effect-held', async (signal) => {
      markStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          firstAborted();
          resolve();
        }, { once: true });
      });
    })).toBe('started');
    await started;
    expect(pump.cancel('effect-held')).toBe(true);
    expect(pump.admit('effect-distinct', second)).toBe('started');

    await pump.whenIdle();
    expect(firstAborted).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
