import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicSessionModeProbeCacheForTests } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let resolveProbe: null | (() => void) = null;
const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => {
  await new Promise<void>((resolve) => {
    resolveProbe = resolve;
  });
  return {
    supported: true as const,
    response: {
      ok: true as const,
      result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
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

describe('useNewSessionPreflightSessionModesState (loading placeholder)', () => {
  it('returns a default option while probing so the UI can show a loading state', async () => {
    vi.resetModules();
    resolveProbe = null;
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
    expect(latest.probe.phase).toBe('loading');
    expect((latest.modeOptions ?? []).map((o: any) => o.id)).toEqual(['default']);

    await act(async () => {
      resolveProbe?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect((latest.modeOptions ?? []).some((o: any) => o.id === 'plan')).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});

