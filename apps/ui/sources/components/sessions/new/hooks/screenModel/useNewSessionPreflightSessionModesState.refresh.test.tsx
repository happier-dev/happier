import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { installCapabilitiesOpsModuleMock } from '@/dev/testkit/mocks/capabilities';
import {
    resetDynamicSessionModeProbeCacheForTests,
    DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS,
} from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';

const machineCapabilitiesInvokeMock = vi.fn();

function assertRefreshFn(value: unknown): asserts value is () => void {
    if (typeof value !== 'function') {
        throw new Error('Expected probe.onRefresh to be a function');
    }
}

describe('useNewSessionPreflightSessionModesState (refresh)', () => {
    it('forces a refresh probe without clearing existing options', async () => {
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicSessionModeProbeCacheForTests();
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        let call = 0;
        machineCapabilitiesInvokeMock.mockImplementation(async () => {
            call++;
            return {
                supported: true as const,
                response: {
                    ok: true as const,
                    result: { availableModes: [{ id: `mode${call}`, name: `Mode ${call}` }] },
                },
            };
        });

        const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');
        const hook = await renderHook(() => useNewSessionPreflightSessionModesState({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            cwd: '/repo',
        }));

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(true);

        const onRefresh = hook.getCurrent().probe?.onRefresh;
        assertRefreshFn(onRefresh);

        await act(async () => {
            onRefresh();
        });
        await flushHookEffects();

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode2')).toBe(true);

        await hook.unmount();
    });

    it('retries after an error cooldown elapses so transient capability errors do not permanently hide session modes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicSessionModeProbeCacheForTests();
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        machineCapabilitiesInvokeMock
            .mockImplementationOnce(async () => ({
                supported: false as const,
                reason: 'error' as const,
            }))
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: {
                    ok: true as const,
                    result: { availableModes: [{ id: 'mode1', name: 'Mode 1' }] },
                },
            }));

        const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');
        const hook = await renderHook(() => useNewSessionPreflightSessionModesState({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            cwd: '/repo',
        }));

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(false);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS + 1);
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(true);

        await hook.unmount();
        vi.useRealTimers();
    });

    it('does not enter a render loop when probeContext identity churns but cached values are stable by content', async () => {
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicSessionModeProbeCacheForTests();

        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));
        machineCapabilitiesInvokeMock.mockRejectedValue(new Error('unexpected probe call'));

        let readCall = 0;
        const cachedValue = {
            availableModes: [{ id: 'mode1', name: 'Mode 1' }],
        };
        vi.doMock('@/sync/domains/sessionModes/dynamicSessionModeProbeCache', async () => {
            const actual = await vi.importActual<typeof import('@/sync/domains/sessionModes/dynamicSessionModeProbeCache')>(
                '@/sync/domains/sessionModes/dynamicSessionModeProbeCache',
            );
            return {
                ...actual,
                readDynamicSessionModeProbeCache: (_key: string) => {
                    readCall++;
                    return {
                        kind: 'success' as const,
                        updatedAt: 123,
                        expiresAt: Date.now() + 60_000,
                        value: cachedValue,
                    };
                },
            };
        });

        const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');
        const hook = await renderHook(() => useNewSessionPreflightSessionModesState({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            cwd: '/repo',
            probeContext: {
                cacheKeySuffixParts: ['appServer'],
                capabilityParams: { runtimeKindOverride: 'appServer' },
            },
        } as any));

        expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(true);
        expect(readCall).toBe(1);

        await hook.rerender();
        expect(readCall).toBe(1);
        await hook.unmount();
    });
});
