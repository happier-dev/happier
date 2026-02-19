import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  supported: true as const,
  response: {
    ok: true as const,
    result: { availableModels: [{ id: 'm1', name: 'Model 1' }], supportsFreeform: false },
  },
}));

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

describe('useNewSessionPreflightModelsState (persistence)', () => {
  it('hydrates cached results across module reloads (app restarts)', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    function Harness() {
      useNewSessionPreflightModelsState({
        agentType: 'codex' as any,
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root1!: renderer.ReactTestRenderer;
    await act(async () => {
      root1 = renderer.create(React.createElement(Harness));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      root1.unmount();
    });

    // Simulate app restart: module registry cleared, in-memory cache gone, MMKV/localStorage remains.
    vi.resetModules();

    const { useNewSessionPreflightModelsState: useNewSessionPreflightModelsState2 } = await import('./useNewSessionPreflightModelsState');

    function Harness2() {
      useNewSessionPreflightModelsState2({
        agentType: 'codex' as any,
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root2!: renderer.ReactTestRenderer;
    await act(async () => {
      root2 = renderer.create(React.createElement(Harness2));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      root2.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
  });
});

