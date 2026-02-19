import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  supported: true as const,
  response: { ok: true as const, result: { availableModels: [], supportsFreeform: false } },
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

describe('useNewSessionPreflightModelsState', () => {
  it('passes params.cwd through to capabilities.invoke(cli.* probeModels)', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        agentType: 'opencode' as any,
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    await act(async () => {
      renderer.create(React.createElement(Harness));
      await Promise.resolve();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    const request = machineCapabilitiesInvokeMock.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      id: 'cli.opencode',
      method: 'probeModels',
      params: expect.objectContaining({ cwd: '/repo' }),
    });
  });

  it('uses a long enough timeout for slow ACP providers', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        agentType: 'codex' as any,
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    await act(async () => {
      renderer.create(React.createElement(Harness));
      await Promise.resolve();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    const request = machineCapabilitiesInvokeMock.mock.calls[0]?.[1];
    expect(request?.params?.timeoutMs).toBe(15_000);
  });
});
