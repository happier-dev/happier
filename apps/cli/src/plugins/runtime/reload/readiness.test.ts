import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';

import { bootstrapPrimaryAgentRuntimesForReadiness } from './readiness';

describe('primary Agent runtime readiness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues slow primary runtime construction after the starter wait expires', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const registry = {
      agentRuntimesByAgentId: new Map([['acme', {
        agentId: 'acme', pluginId: 'com.acme.agent', hasPrimaryRuntime: true,
        retirementSignal: new AbortController().signal,
        createRuntime: () => gate,
      }]]),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    const readiness = bootstrapPrimaryAgentRuntimesForReadiness({
      registry,
      pluginIds: ['com.acme.agent'],
    });
    let settled = false;
    void readiness.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(60_001);
      expect(settled).toBe(false);
      release();
      await expect(readiness).resolves.toBeUndefined();
    } finally {
      release();
      await readiness.catch(() => undefined);
    }
  });

  it('preserves genuine primary-runtime construction failure', async () => {
    const failure = new Error('Agent runtime construction rejected');
    const registry = {
      agentRuntimesByAgentId: new Map([['acme', {
        agentId: 'acme', pluginId: 'com.acme.agent', hasPrimaryRuntime: true,
        retirementSignal: new AbortController().signal,
        createRuntime: async () => { throw failure; },
      }]]),
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    await expect(bootstrapPrimaryAgentRuntimesForReadiness({
      registry, pluginIds: ['com.acme.agent'],
    })).rejects.toBe(failure);
  });
});
