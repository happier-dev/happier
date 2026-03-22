import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const probeResultState = {
  value: { availableModels: [{ id: 'm1', name: 'Model 1' }], supportsFreeform: false } as {
    availableModels: Array<{ id: string; name: string }>;
    supportsFreeform: boolean;
  },
};

const agentModelCapabilitiesState = {
  supportsSelection: true,
  supportsFreeform: false,
};

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  supported: true as const,
  response: {
    ok: true as const,
    result: probeResultState.value,
  },
}));

type ProbeResponse = Awaited<ReturnType<typeof machineCapabilitiesInvokeMock>>;

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
  return {
    ...actual,
    getAgentCore: () => ({
      model: {
        supportsSelection: agentModelCapabilitiesState.supportsSelection,
        allowedModes: [],
        defaultMode: 'default',
        supportsFreeform: agentModelCapabilitiesState.supportsFreeform,
      }
    }),
  };
});

describe('useNewSessionPreflightModelsState (cache)', () => {
  beforeEach(() => {
    probeResultState.value = {
      availableModels: [{ id: 'm1', name: 'Model 1' }],
      supportsFreeform: false,
    };
    agentModelCapabilitiesState.supportsSelection = true;
    agentModelCapabilitiesState.supportsFreeform = false;
  });

  it('does not re-probe when a fresh result is cached', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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

  it('keeps a freeform-only probe result when the backend supports custom model ids without listing models', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();
    probeResultState.value = {
      availableModels: [],
      supportsFreeform: true,
    };

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    let latestPreflightModels: Readonly<{
      availableModels: ReadonlyArray<Readonly<{ id: string; name: string; description?: string }>>;
      supportsFreeform: boolean;
    }> | null = null;

    function Harness() {
      latestPreflightModels = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      }).preflightModels;
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    expect(latestPreflightModels).toEqual({
      availableModels: [],
      supportsFreeform: true,
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('resets the probe phase to idle when switching to a backend that does not support model selection', async () => {
    vi.resetModules();
    resetDynamicModelProbeCacheForTests();

    let resolveProbe: ((value: ProbeResponse) => void) | undefined;
    machineCapabilitiesInvokeMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveProbe = resolve;
    }));

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    let latestProbePhase: 'idle' | 'loading' | 'refreshing' = 'idle';

    function Harness(props: { agentId: 'codex' | 'opencode' }) {
      latestProbePhase = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'builtInAgent', agentId: props.agentId },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      }).probe.phase;
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness, { agentId: 'codex' }))).tree;

    expect(latestProbePhase).toBe('loading');

    agentModelCapabilitiesState.supportsSelection = false;
    await act(async () => {
      root.update(React.createElement(Harness, { agentId: 'opencode' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(latestProbePhase).toBe('idle');

    if (!resolveProbe) {
      throw new Error('expected deferred probe resolver');
    }

    resolveProbe({
      supported: true,
      response: {
        ok: true,
        result: {
          availableModels: [{ id: 'm1', name: 'Model 1' }],
          supportsFreeform: false,
        },
      },
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      root.unmount();
    });
  });
});
