import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { installCapabilitiesOpsModuleMock, renderScreen } from '@/dev/testkit';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS } from '@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useNewSessionPreflightConfigOptionsState', () => {
    it('keeps previous config options visible while a new cwd probe is pending', async () => {
        vi.resetModules();

        const machineCapabilitiesInvokeMock = vi.fn()
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: {
                    ok: true as const,
                    result: {
                        configOptions: [{ id: 'opt1', name: 'Option 1', type: 'boolean', currentValue: true }],
                    },
                },
            }))
            .mockImplementationOnce(async () => new Promise<never>(() => undefined));
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));
        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let cwd = '/repo';
        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd,
            } as any);
            return null;
        }

        const root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await Promise.resolve();
        });
        expect((readLatest().configOptions ?? []).map((option) => option.id)).toEqual(['opt1']);

        cwd = '/repo-2';
        await act(async () => {
            root.update(React.createElement(Harness));
            await Promise.resolve();
        });

        const refreshed = readLatest();
        expect(refreshed.probe.phase).toBe('refreshing');
        expect((refreshed.configOptions ?? []).map((option) => option.id)).toEqual(['opt1']);

        await act(async () => {
            root.unmount();
        });
    });

    it('probes config options for non-Codex providers (provider-agnostic)', async () => {
        vi.resetModules();

        const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: string, _request: unknown) => ({
            supported: true as const,
            response: { ok: true as const, result: { configOptions: [] } },
        }));
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        function Harness() {
            useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            root.unmount();
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        const firstCall = machineCapabilitiesInvokeMock.mock.calls[0] as unknown as [unknown, unknown] | undefined;
        expect(firstCall?.[1]).toMatchObject({
            id: 'cli.opencode',
            method: 'probeConfigOptions',
            params: expect.objectContaining({ timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS, cwd: '/repo' }),
        });
    });

    it('forwards probeContext.capabilityParams to probeConfigOptions', async () => {
        vi.resetModules();

        const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: string, _request: unknown) => ({
            supported: true as const,
            response: { ok: true as const, result: { configOptions: [] } },
        }));
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        const probeContext = {
            cacheKeySuffixParts: ['appServer'],
            capabilityParams: { runtimeKindOverride: 'appServer' },
        };

        function Harness() {
            useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo',
                probeContext,
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            root.unmount();
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        const firstCall = machineCapabilitiesInvokeMock.mock.calls[0] as unknown as [unknown, unknown] | undefined;
        expect(firstCall?.[1]).toMatchObject({
            id: 'cli.codex',
            method: 'probeConfigOptions',
            params: expect.objectContaining({ runtimeKindOverride: 'appServer' }),
        });
    });

    it('treats empty dynamic config options as a successful empty probe result', async () => {
        vi.resetModules();

        const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: string, _request: unknown) => ({
            supported: true as const,
            response: { ok: true as const, result: { configOptions: [], source: 'dynamic' } },
        }));
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo-dynamic-empty',
            } as any);
            return null;
        }

        const root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        expect(readLatest().configOptions).toEqual([]);
        expect(readLatest().unavailable).toBe(false);
        expect(readLatest().probe.refreshedAt).toEqual(expect.any(Number));

        await act(async () => {
            root.unmount();
        });
    });

    it('carries typed unavailable state when config option discovery is unavailable', async () => {
        vi.resetModules();

        const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: string, _request: unknown) => ({
            supported: true as const,
            response: { ok: true as const, result: { configOptions: [], source: 'unavailable' } },
        }));
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            root.unmount();
        });

        expect(readLatest().configOptions).toEqual([]);
        expect(readLatest().unavailable).toBe(true);
    });

    it('keeps config option discovery unavailable fail-closed across a same-scope remount during cooldown', async () => {
        vi.resetModules();

        const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: string, _request: unknown) => ({
            supported: true as const,
            response: { ok: true as const, result: { configOptions: [], source: 'unavailable' } },
        }));
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo-unavailable-remount',
            } as any);
            return null;
        }

        let root!: renderer.ReactTestRenderer;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            root.unmount();
        });

        latest = null;
        root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            root.unmount();
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        expect(readLatest().configOptions).toEqual([]);
        expect(readLatest().unavailable).toBe(true);
    });

    it('retries after an unavailable cooldown elapses so temporarily gated config options can recover', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        vi.resetModules();

        const machineCapabilitiesInvokeMock = vi.fn()
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: { ok: true as const, result: { configOptions: [], source: 'unavailable' } },
            }))
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: {
                    ok: true as const,
                    result: {
                        configOptions: [{
                            id: 'sandbox',
                            name: 'Sandbox',
                            type: 'boolean',
                            currentValue: true,
                        }],
                    },
                },
            }));
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo-unavailable-retry',
            } as any);
            return null;
        }

        const root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await Promise.resolve();
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        expect(readLatest().configOptions).toEqual([]);
        expect(readLatest().unavailable).toBe(true);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS + 1);
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
        expect((readLatest().configOptions ?? []).map((option) => option.id)).toEqual(['sandbox']);
        expect(readLatest().unavailable).toBe(false);

        await act(async () => {
            root.unmount();
        });
        vi.useRealTimers();
    });

    it('replaces previous successful config options when a forced refresh reports unavailable', async () => {
        vi.resetModules();

        const machineCapabilitiesInvokeMock = vi.fn()
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: {
                    ok: true as const,
                    result: {
                        configOptions: [{
                            id: 'sandbox',
                            name: 'Sandbox',
                            type: 'boolean',
                            currentValue: true,
                        }],
                    },
                },
            }))
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: { ok: true as const, result: { configOptions: [], source: 'unavailable' } },
            }));
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        const { resetDynamicConfigOptionsProbeCacheForTests } = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
        resetDynamicConfigOptionsProbeCacheForTests();

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        let latest: ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null = null;
        const readLatest = () => {
            const value = latest as ReturnType<typeof useNewSessionPreflightConfigOptionsState> | null;
            if (!value) throw new Error('Expected preflight config options state to render');
            return value;
        };
        function Harness() {
            latest = useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo-success-to-unavailable',
            } as any);
            return null;
        }

        const root = (await renderScreen(React.createElement(Harness))).tree;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect((readLatest().configOptions ?? []).map((option) => option.id)).toEqual(['sandbox']);
        expect(readLatest().unavailable).toBe(false);

        await act(async () => {
            readLatest().probe.onRefresh?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
        expect(readLatest().configOptions).toEqual([]);
        expect(readLatest().unavailable).toBe(true);

        await act(async () => {
            root.unmount();
        });
    });

    it('does not re-probe when probeContext identity changes but content is stable', async () => {
        vi.resetModules();

        // Intentionally never resolves to avoid setState loops influencing the test outcome.
        const pending = new Promise<never>(() => undefined);
        const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: string, _request: unknown) => pending as never);
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        const { useNewSessionPreflightConfigOptionsState } = await import('./useNewSessionPreflightConfigOptionsState');

        function Harness() {
            const [_tick, setTick] = React.useState(0);
            React.useEffect(() => {
                setTick(1);
            }, []);

            useNewSessionPreflightConfigOptionsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo',
                // Inline object creation simulates callers that don't memoize probeContext.
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
            await new Promise((resolve) => setTimeout(resolve, 0));
            root.unmount();
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    });
});
