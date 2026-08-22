import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { renderScreen } from '@/dev/testkit';
import { NEW_SESSION_MODEL_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  supported: true as const,
  response: { ok: true as const, result: { availableModels: [{ id: 'model-a', name: 'Model A' }], supportsFreeform: false } },
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
}));

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
  resolveCatalogAgentIdForBackendTarget: (backendTarget: { kind: string; agentId?: string }) =>
    backendTarget.kind === 'builtInAgent' ? (backendTarget.agentId ?? null) : null,
}));

vi.mock('@/agents/registry/compat/customAcp', () => ({
  LEGACY_CUSTOM_ACP_AGENT_ID: 'customAcp',
  resolveAgentLookupCoreConfig: () => ({
    model: {
      supportsSelection: true,
      supportsFreeform: false,
      dynamicProbe: 'probe',
    },
  }),
}));

vi.mock('@/agents/catalog/catalog', () => {
  const isBundled = (value: unknown) => value === 'codex' || value === 'opencode' || value === 'claude';
  return {
    isBundledAgentId: isBundled,
    // Mirrors the real overloaded reader: a bundled id has a core, any other
    // installed Agent id reports no bundled fact rather than a substitute.
    getAgentCore: (id: unknown) => (
      isBundled(id)
        ? { model: { supportsSelection: true, allowedModes: [], defaultMode: 'default', supportsFreeform: false, dynamicProbe: 'probe' } }
        : null
    ),
  };
});

describe('useNewSessionPreflightModelsState', () => {
  it('passes params.cwd through to capabilities.invoke(cli.* probeModels)', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'opencode' },
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

  it('probes a caller-named externally installed Agent under its own id', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'acme-external-agent' },
        runtimeCarrierAgentId: 'acme-external-agent' as never,
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    expect(machineCapabilitiesInvokeMock.mock.calls[0]?.[1]).toMatchObject({
      id: 'cli.acme-external-agent',
      method: 'probeModels',
    });
  });

  it('forwards probeContext.capabilityParams to capabilities.invoke(... probeModels)', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' },
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

  it('returns an idle empty state when no backend target is provided', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightModelsState({
        backendTarget: null as any,
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

    expect(machineCapabilitiesInvokeMock).not.toHaveBeenCalled();
    expect(latest.preflightModels).toBeNull();
    expect(latest.modelOptions).toEqual([]);
    expect(latest.probe.phase).toBe('idle');
  });

  it('uses the extended model-probe timeout for slow provider model discovery', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' },
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
    const options = machineCapabilitiesInvokeMock.mock.calls[0]?.[2];
    expect(NEW_SESSION_MODEL_PROBE_TIMEOUT_MS).toBe(120_000);
    expect(request?.params?.timeoutMs).toBe(NEW_SESSION_MODEL_PROBE_TIMEOUT_MS);
    expect(options?.timeoutMs).toBe(NEW_SESSION_MODEL_PROBE_TIMEOUT_MS);
    const values = (latest?.modelOptions ?? []).map((option: any) => option.value);
    expect(values.slice(0, 2)).toEqual(['default', 'model-a']);
  });

  it('does not synthesize a legacy compat sentinel for configured backend targets without a runtime carrier', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
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

    expect(machineCapabilitiesInvokeMock).not.toHaveBeenCalled();
    expect(latest.preflightModels).toBeNull();
    expect(latest.modelOptions).toEqual([]);
    expect(latest.probe.phase).toBe('idle');
  });

  it('uses the runtime carrier agent id when probing a configured backend target', async () => {
    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
        runtimeCarrierAgentId: 'codex',
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
      id: 'cli.codex',
      method: 'probeModels',
      params: expect.objectContaining({
        cwd: '/repo',
        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
      }),
    });
  });
});
