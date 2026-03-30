import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { installCapabilitiesOpsModuleMock, renderScreen } from '@/dev/testkit';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useNewSessionPreflightConfigOptionsState', () => {
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
