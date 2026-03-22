import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicSessionModeProbeCacheForTests } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  supported: true as const,
  response: {
    ok: true as const,
    result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
  },
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
  return {
    ...actual,
    getAgentCore: () => ({ sessionModes: { kind: 'acpAgentModes' } }),
  };
});

describe('useNewSessionPreflightSessionModesState (cache)', () => {
  it('does not re-probe when a fresh result is cached', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    function Harness() {
      useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root1!: renderer.ReactTestRenderer;
    root1 = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root1.unmount();
    });

    let root2!: renderer.ReactTestRenderer;
    root2 = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root2.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
  });
});
