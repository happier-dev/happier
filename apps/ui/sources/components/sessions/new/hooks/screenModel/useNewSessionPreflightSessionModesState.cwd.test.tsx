import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import * as React from 'react';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { resetDynamicSessionModeProbeCacheForTests } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capabilityRpc = vi.fn(async (_machineId: any, _request: any, _options: any) => ({
    ok: true as const,
    result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
  }));

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const probeCache = await import('@/sync/domains/sessionModes/dynamicSessionModeProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicSessionModeProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightSessionModesState (cwd)', () => {
  it('keeps previous mode options visible while a new cwd probe is pending', async () => {

    capabilityRpc.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    capabilityRpc
      .mockImplementationOnce(async () => ({ ok: true as const, result: { availableModes: [{ id: 'plan', name: 'Plan' }] } }))
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
        capabilityServerId: preflight.serverId,
        cwd,
      });
      return null;
    }

    const screen = await renderScreen(React.createElement(Harness));
    const root = screen.tree;
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(readLatest().preflightModes).not.toBeNull();
    });
    expect(readLatest().modeOptions.map((option) => option.id)).toEqual(['plan']);

    cwd = '/repo-2';
    await screen.update(React.createElement(Harness));

    const refreshed = readLatest();
    expect(refreshed.probe.phase).toBe('refreshing');
    expect(refreshed.modeOptions.map((option) => option.id)).toEqual(['plan']);

    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(capabilityRpc).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      root.unmount();
    });
  });

  it('passes params.cwd through to capabilities.invoke(cli.* probeModes)', async () => {

    capabilityRpc.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    const captured: any[] = [];
    capabilityRpc.mockImplementationOnce(async (_machineId: any, request: any, _options: any) => {
      captured.push(request);
      return { ok: true as const, result: { availableModes: [{ id: 'plan', name: 'Plan' }] } };
    });

    function Harness() {
      useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'opencode' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(captured.length).toBeGreaterThan(0);
    });
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

    capabilityRpc.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    let latest: any = null;
	    function Harness() {
	      latest = useNewSessionPreflightSessionModesState({
	        backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
	        selectedMachineId: 'machine-1',
	        capabilityServerId: preflight.serverId,
	        cwd: '/repo',
	      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root.unmount();
    });

    expect(capabilityRpc).not.toHaveBeenCalled();
    expect(latest.preflightModes).toBeNull();
    expect(latest.modeOptions).toEqual([]);
    expect(latest.probe.phase).toBe('idle');
  });

  it('probes Codex appServer modes through the generic preflight path', async () => {

    capabilityRpc.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    let latest: any = null;
    function Harness() {
      latest = useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(latest.preflightModes).not.toBeNull();
    });
    await act(async () => {
      root.unmount();
    });

    expect(capabilityRpc).toHaveBeenCalledTimes(1);
    expect(capabilityRpc.mock.calls[0]?.[1]).toMatchObject({
      id: 'cli.codex',
      method: 'probeModes',
      params: expect.objectContaining({ cwd: '/repo' }),
    });
    expect((latest?.modeOptions ?? []).map((option: any) => option.id)).toEqual(['plan']);
  });

  it('does not expose the synthetic Default mode when preflight mode discovery is unavailable', async () => {

    capabilityRpc.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    capabilityRpc.mockImplementationOnce(async () => ({
        ok: true as const,
        result: { availableModes: [], source: 'unavailable' },
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
        capabilityServerId: preflight.serverId,
        cwd: '/repo-unavailable',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(readLatest().preflightModes?.unavailable).toBe(true);
    });
    await act(async () => {
      root.unmount();
    });

    expect(readLatest().preflightModes).toEqual({
      availableModes: [],
      unavailable: true,
    });
    expect(readLatest().modeOptions).toEqual([]);
  });

  it('keeps mode discovery unavailable fail-closed across a same-scope remount during cooldown', async () => {

    capabilityRpc.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    capabilityRpc.mockImplementationOnce(async () => ({
        ok: true as const,
        result: { availableModes: [], source: 'unavailable' },
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
        capabilityServerId: preflight.serverId,
        cwd: '/repo-unavailable-remount',
      });
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(readLatest().preflightModes?.unavailable).toBe(true);
    });
    await act(async () => {
      root.unmount();
    });

    latest = null;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root.unmount();
    });

    expect(capabilityRpc).toHaveBeenCalledTimes(1);
    expect(readLatest().preflightModes).toEqual({
      availableModes: [],
      unavailable: true,
    });
    expect(readLatest().modeOptions).toEqual([]);
  });

  it('replaces a previous successful mode list when a forced refresh reports unavailable', async () => {

    capabilityRpc.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    capabilityRpc
      .mockImplementationOnce(async () => ({
          ok: true as const,
          result: { availableModes: [{ id: 'plan', name: 'Plan' }] },
        }))
      .mockImplementationOnce(async () => ({
          ok: true as const,
          result: { availableModes: [], source: 'unavailable' },
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
        capabilityServerId: preflight.serverId,
        cwd: '/repo-success-to-unavailable',
      });
      return null;
    }

    const root = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(readLatest().preflightModes).not.toBeNull();
    });
    expect(readLatest().modeOptions.map((option) => option.id)).toEqual(['plan']);

    await act(async () => {
      readLatest().probe.onRefresh?.();
    });

    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(readLatest().preflightModes?.unavailable).toBe(true);
    });
    expect(capabilityRpc).toHaveBeenCalledTimes(2);
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

    capabilityRpc.mockClear();
    resetDynamicSessionModeProbeCacheForTests();

    const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');

    const captured: any[] = [];
    capabilityRpc.mockImplementationOnce(async (_machineId: any, request: any, _options: any) => {
      captured.push(request);
      return { ok: true as const, result: { availableModes: [{ id: 'plan', name: 'Plan' }] } };
    });

    function Harness() {
      useNewSessionPreflightSessionModesState({
        backendTarget: { kind: 'backend', backendId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: preflight.serverId,
        cwd: '/repo',
        probeContext: {
          cacheKeySuffixParts: ['appServer'],
          capabilityParams: { profileId: 'profile-a' },
        },
      } as any);
      return null;
    }

    let root!: renderer.ReactTestRenderer;
    root = (await renderScreen(React.createElement(Harness))).tree;
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(captured.length).toBe(1);
    });
    await act(async () => {
      root.unmount();
    });

    expect(captured.length).toBe(1);
    expect(captured[0]).toMatchObject({
      id: 'cli.codex',
      method: 'probeModes',
      params: expect.objectContaining({ profileId: 'profile-a' }),
    });
  });
});
