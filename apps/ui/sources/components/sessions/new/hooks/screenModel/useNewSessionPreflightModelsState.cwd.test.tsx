import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { renderScreen } from '@/dev/testkit';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  supported: true as const,
  response: { ok: true as const, result: { availableModels: [{ id: 'model-a', name: 'Model A' }], supportsFreeform: false } },
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
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    const request = machineCapabilitiesInvokeMock.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      id: 'cli.opencode',
      method: 'probeModels',
      params: expect.objectContaining({ cwd: '/repo' }),
    });
  });

  it('forwards probeContext.capabilityParams to capabilities.invoke(... probeModels)', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
        probeContext: {
          cacheKeySuffixParts: ['appServer'],
          capabilityParams: { runtimeKindOverride: 'appServer' },
        },
      } as any);
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    const request = machineCapabilitiesInvokeMock.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      id: 'cli.codex',
      method: 'probeModels',
      params: expect.objectContaining({
        cwd: '/repo',
        runtimeKindOverride: 'appServer',
      }),
    });
  });

  it('uses a long enough timeout for slow ACP providers', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

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
    await act(async () => {
      root.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    const request = machineCapabilitiesInvokeMock.mock.calls[0]?.[1];
    expect(request?.params?.timeoutMs).toBe(NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS);
    const values = (latest?.modelOptions ?? []).map((option: any) => option.value);
    expect(values.slice(0, 2)).toEqual(['default', 'model-a']);
  });

  it('uses cli.customAcp and forwards configured preset backendTarget', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    const request = machineCapabilitiesInvokeMock.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      id: 'cli.customAcp',
      method: 'probeModels',
      params: expect.objectContaining({
        cwd: '/repo',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      }),
    });
  });
});
