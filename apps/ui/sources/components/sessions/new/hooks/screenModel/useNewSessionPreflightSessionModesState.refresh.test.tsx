import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicSessionModeProbeCacheForTests } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let call = 0;
const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => {
  call++;
  return {
    supported: true as const,
    response: {
      ok: true as const,
      result: { availableModes: [{ id: `mode${call}`, name: `Mode ${call}` }] },
    },
  };
});

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

describe('useNewSessionPreflightSessionModesState (refresh)', () => {
  it('forces a refresh probe without clearing existing options', async () => {
    vi.resetModules();
    call = 0;
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
        agentType: 'opencode' as any,
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(React.createElement(Harness));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    expect((latest.modeOptions ?? []).some((o: any) => o.id === 'mode1')).toBe(true);

    await act(async () => {
      latest.probe.refresh();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
    expect((latest.modeOptions ?? []).some((o: any) => o.id === 'mode2')).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});

