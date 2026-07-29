import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicSessionModeProbeCacheForTests } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';
import { renderScreen } from '@/dev/testkit';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
  supported: true as const,
  response: {
    ok: true as const,
    result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
  },
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
  resolveAgentLookupCoreConfig: (agentId: string) => ({
    sessionModes: { kind: agentId === 'codex' ? 'acpPolicyPresets' : 'acpAgentModes' },
  }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
  isAgentId: (value: unknown) => value === 'codex' || value === 'opencode' || value === 'claude',
  getAgentCore: (agentId: string) => ({
    sessionModes: { kind: agentId === 'codex' ? 'acpPolicyPresets' : 'acpAgentModes' },
  }),
}));

describe('useNewSessionPreflightSessionModesState (cwd)', () => {
  it('keeps previous mode options visible while a new cwd probe is pending', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    machineCapabilitiesInvokeMock
      .mockImplementationOnce(async () => ({
        supported: true as const,
        response: { ok: true as const, result: { availableModes: [{ id: 'plan', name: 'Plan' }] } },
      }))
      .mockImplementationOnce(async () => new Promise<never>(() => undefined));

    let cwd = '/repo';
    let latest: ReturnType<typeof useNewSessionPreflightSessionModesState> | null = null;
    const readLatest = () => {
      const value = latest as ReturnType<typeof useNewSessionPreflightSessionModesState> | null;
      if (!value) throw new Error('Expected preflight session modes state to render');
      return value;
    };
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd,
      });
      return null;
    }

    const root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      await Promise.resolve();
    });
    expect(readLatest().modeOptions.map((option) => option.id)).toEqual(['default', 'plan']);

    cwd = '/repo-2';
    await act(async () => {
      root.update(React.createElement(Harness));
      await Promise.resolve();
    });

    const refreshed = readLatest();
    expect(refreshed.probe.phase).toBe('refreshing');
    expect(refreshed.modeOptions.map((option) => option.id)).toEqual(['default', 'plan']);

    await act(async () => {
      root.unmount();
    });
  });

  it('passes params.cwd through to capabilities.invoke(cli.* probeModes)', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    const captured: any[] = [];
    machineCapabilitiesInvokeMock.mockImplementationOnce(async (_machineId: any, request: any, _options: any) => {
      captured.push(request);
      return {
        supported: true as const,
        response: { ok: true as const, result: { availableModes: [{ id: 'plan', name: 'Plan' }] } },
      };
    });

    function Harness() {
      useNewSessionPreflightSessionModesState({
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

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toMatchObject({
      id: 'cli.opencode',
      method: 'probeModes',
      params: expect.objectContaining({ timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS, cwd: '/repo' }),
    });
  });

  it('does not synthesize a legacy compat sentinel for configured backend mode probes without a runtime carrier', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    let latest: any = null;
	    function Harness() {
	      latest = useNewSessionPreflightSessionModesState({
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
    expect(latest.preflightModes).toBeNull();
    expect(latest.modeOptions).toEqual([]);
    expect(latest.probe.phase).toBe('idle');
  });

  it('probes Codex appServer modes through the generic preflight path', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
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
    expect(machineCapabilitiesInvokeMock.mock.calls[0]?.[1]).toMatchObject({
      id: 'cli.codex',
      method: 'probeModes',
      params: expect.objectContaining({ cwd: '/repo' }),
    });
    expect((latest?.modeOptions ?? []).map((option: any) => option.id)).toEqual(['default', 'plan']);
  });

  it('does not expose the synthetic Default mode when preflight mode discovery is unavailable', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    machineCapabilitiesInvokeMock.mockImplementationOnce(async () => ({
      supported: true as const,
      response: {
        ok: true as const,
        result: { availableModes: [], source: 'unavailable' },
      },
    }));

    let latest: ReturnType<typeof useNewSessionPreflightSessionModesState> | null = null;
    const readLatest = () => {
      const value = latest as ReturnType<typeof useNewSessionPreflightSessionModesState> | null;
      if (!value) throw new Error('Expected preflight session modes state to render');
      return value;
    };
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo-unavailable',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      await Promise.resolve();
      root.unmount();
    });

    expect(readLatest().preflightModes).toEqual({
      availableModes: [],
      unavailable: true,
    });
    expect(readLatest().modeOptions).toEqual([]);
  });

  it('keeps mode discovery unavailable fail-closed across a same-scope remount during cooldown', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    machineCapabilitiesInvokeMock.mockImplementationOnce(async () => ({
      supported: true as const,
      response: {
        ok: true as const,
        result: { availableModes: [], source: 'unavailable' },
      },
    }));

    let latest: ReturnType<typeof useNewSessionPreflightSessionModesState> | null = null;
    const readLatest = () => {
      const value = latest as ReturnType<typeof useNewSessionPreflightSessionModesState> | null;
      if (!value) throw new Error('Expected preflight session modes state to render');
      return value;
    };
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo-unavailable-remount',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      await Promise.resolve();
      root.unmount();
    });

    latest = null;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      await Promise.resolve();
      root.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    expect(readLatest().preflightModes).toEqual({
      availableModes: [],
      unavailable: true,
    });
    expect(readLatest().modeOptions).toEqual([]);
  });

  it('replaces a previous successful mode list when a forced refresh reports unavailable', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    machineCapabilitiesInvokeMock
      .mockImplementationOnce(async () => ({
        supported: true as const,
        response: {
          ok: true as const,
          result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
        },
      }))
      .mockImplementationOnce(async () => ({
        supported: true as const,
        response: {
          ok: true as const,
          result: { availableModes: [], source: 'unavailable' },
        },
      }));

    let latest: ReturnType<typeof useNewSessionPreflightSessionModesState> | null = null;
    const readLatest = () => {
      const value = latest as ReturnType<typeof useNewSessionPreflightSessionModesState> | null;
      if (!value) throw new Error('Expected preflight session modes state to render');
      return value;
    };
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo-success-to-unavailable',
      });
      return null;
    }

    const root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      await Promise.resolve();
    });
    expect(readLatest().modeOptions.map((option) => option.id)).toEqual(['default', 'plan']);

    await act(async () => {
      readLatest().probe.onRefresh?.();
      await Promise.resolve();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
    expect(readLatest().preflightModes).toEqual({
      availableModes: [],
      unavailable: true,
    });
    expect(readLatest().modeOptions).toEqual([]);

    await act(async () => {
      root.unmount();
    });
  });

  it('forwards probeContext.capabilityParams to capabilities.invoke(cli.* probeModes)', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    const captured: any[] = [];
    machineCapabilitiesInvokeMock.mockImplementationOnce(async (_machineId: any, request: any, _options: any) => {
      captured.push(request);
      return {
        supported: true as const,
        response: { ok: true as const, result: { availableModes: [{ id: 'plan', name: 'Plan' }] } },
      };
    });

    function Harness() {
      useNewSessionPreflightSessionModesState({
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

    expect(captured.length).toBe(1);
    expect(captured[0]).toMatchObject({
      id: 'cli.codex',
      method: 'probeModes',
      params: expect.objectContaining({ runtimeKindOverride: 'appServer' }),
    });
  });
});
