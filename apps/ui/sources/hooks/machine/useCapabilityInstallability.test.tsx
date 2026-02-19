import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { resetCapabilityInstallabilityCacheForTests, useCapabilityInstallability } from './useCapabilityInstallability';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops', () => ({
  machineCapabilitiesInvoke: (...args: unknown[]) => machineCapabilitiesInvokeSpy(...args),
}));

async function flushEffects(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function renderInstallability(params: { machineId: string; serverId: string; capabilityId: string }): { unmount: () => void } {
  function Test() {
    useCapabilityInstallability({
      machineId: params.machineId,
      serverId: params.serverId,
      capabilityId: params.capabilityId as any,
      timeoutMs: 500,
    });
    return React.createElement('View');
  }

  let root!: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(React.createElement(Test));
  });

  return {
    unmount: () => {
      act(() => root.unmount());
    },
  };
}

describe('useCapabilityInstallability', () => {
  beforeEach(async () => {
    machineCapabilitiesInvokeSpy.mockReset();
    machineCapabilitiesInvokeSpy.mockResolvedValue({
      supported: true,
      response: { ok: true },
    });

    resetCapabilityInstallabilityCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('caches installability results and avoids re-invoking within TTL', async () => {
    const first = renderInstallability({ machineId: 'm1', serverId: 'server-a', capabilityId: 'cli.opencode' });
    await act(async () => {
      await flushEffects();
    });
    first.unmount();

    expect(machineCapabilitiesInvokeSpy).toHaveBeenCalledTimes(1);

    const second = renderInstallability({ machineId: 'm1', serverId: 'server-a', capabilityId: 'cli.opencode' });
    await act(async () => {
      await flushEffects();
    });
    second.unmount();

    expect(machineCapabilitiesInvokeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not share cached results across different capabilities', async () => {
    const first = renderInstallability({ machineId: 'm1', serverId: 'server-a', capabilityId: 'cli.opencode' });
    await act(async () => {
      await flushEffects();
    });
    first.unmount();

    const second = renderInstallability({ machineId: 'm1', serverId: 'server-a', capabilityId: 'cli.codex' });
    await act(async () => {
      await flushEffects();
    });
    second.unmount();

    expect(machineCapabilitiesInvokeSpy).toHaveBeenCalledTimes(2);
  });
});
