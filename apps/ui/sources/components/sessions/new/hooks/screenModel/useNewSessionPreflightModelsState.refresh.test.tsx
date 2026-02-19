import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let call = 0;
const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => {
  call++;
  return {
    supported: true as const,
    response: {
      ok: true as const,
      result: { availableModels: [{ id: `m${call}`, name: `Model ${call}` }], supportsFreeform: false },
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
    getAgentCore: () => ({ model: { supportsSelection: true, allowedModes: [], defaultMode: 'default', supportsFreeform: false } }),
  };
});

describe('useNewSessionPreflightModelsState (refresh)', () => {
  it('forces a refresh probe without clearing existing options', async () => {
    vi.resetModules();
    call = 0;
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightModelsState({
        agentType: 'codex' as any,
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
    expect((latest.modelOptions ?? []).some((o: any) => o.value === 'm1')).toBe(true);

    await act(async () => {
      latest.probe.refresh();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
    expect((latest.modelOptions ?? []).some((o: any) => o.value === 'm2')).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});

