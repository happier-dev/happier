import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { resetDynamicSessionModeProbeCacheForTests } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeModesResult = Readonly<{
  provider?: string;
  source?: 'dynamic' | 'static';
  availableModes: Array<{ id: string; name: string; description?: string }>;
}>;

type ProbeResponse = Readonly<{
  supported: true;
  response: Readonly<{
    ok: true;
    result: ProbeModesResult;
  }>;
}>;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any): Promise<ProbeResponse> => ({
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

describe('useNewSessionPreflightSessionModesState (persistence)', () => {
  it('hydrates cached results across module reloads (app restarts)', async () => {
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

    vi.resetModules();

    const { useNewSessionPreflightSessionModesState: useNewSessionPreflightSessionModesState2 } = await import('./useNewSessionPreflightSessionModesState');

    function Harness2() {
      useNewSessionPreflightSessionModesState2({
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root2!: renderer.ReactTestRenderer;
    root2 = (await renderScreen(React.createElement(Harness2))).tree;
    await act(async () => {
      root2.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
  });

  it('does not persist static fallback probe results across module reloads', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    machineCapabilitiesInvokeMock.mockResolvedValue({
      supported: true as const,
      response: {
        ok: true as const,
        result: { source: 'static', availableModes: [{ id: 'plan', name: 'Plan' }] },
      },
    });

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

    vi.resetModules();

    const { useNewSessionPreflightSessionModesState: useNewSessionPreflightSessionModesState2 } = await import('./useNewSessionPreflightSessionModesState');

    function Harness2() {
      useNewSessionPreflightSessionModesState2({
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root2!: renderer.ReactTestRenderer;
    root2 = (await renderScreen(React.createElement(Harness2))).tree;
    await act(async () => {
      root2.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
  });
});
