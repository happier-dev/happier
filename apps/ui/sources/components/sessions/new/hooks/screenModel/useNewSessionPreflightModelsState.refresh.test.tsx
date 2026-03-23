import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { renderScreen } from '@/dev/testkit';


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
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    expect((latest.modelOptions ?? []).some((o: any) => o.value === 'm1')).toBe(true);

    await act(async () => {
      latest.probe.onRefresh?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
    expect((latest.modelOptions ?? []).some((o: any) => o.value === 'm2')).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps the previous Codex model list visible while probing a different cwd', async () => {
    vi.resetModules();
    call = 0;
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    let resolveSecondProbe: (value: Awaited<ReturnType<typeof machineCapabilitiesInvokeMock>>) => void = () => {
      throw new Error('expected deferred second probe resolver');
    };
    machineCapabilitiesInvokeMock
      .mockImplementationOnce(async () => {
        call++;
        return {
          supported: true as const,
          response: {
            ok: true as const,
            result: { availableModels: [{ id: `m${call}`, name: `Model ${call}` }], supportsFreeform: false },
          },
        };
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecondProbe = resolve as any;
      }));

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    let latest: any = null;
    function Harness(props: { cwd: string }) {
      latest = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: props.cwd,
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness, { cwd: '/repo-a' }))).tree;

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    expect((latest.modelOptions ?? []).some((o: any) => o.value === 'm1')).toBe(true);

    await act(async () => {
      root.update(React.createElement(Harness, { cwd: '/repo-b' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
    // The core contract: don't flash back to an empty/default-only list while the new probe is in flight.
    expect((latest.modelOptions ?? []).some((o: any) => o.value === 'm1')).toBe(true);

    resolveSecondProbe({
      supported: true,
      response: {
        ok: true,
        result: { availableModels: [{ id: 'm2', name: 'Model 2' }], supportsFreeform: false },
      },
    } as any);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect((latest.modelOptions ?? []).some((o: any) => o.value === 'm2')).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
