import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installCapabilitiesOpsModuleMock } from '@/dev/testkit/mocks/capabilities';
import {
    resetDynamicSessionModeProbeCacheForTests,
    DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS,
} from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';

const machineCapabilitiesInvokeMock = vi.fn();

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

        await act(async () => {
            hook.getCurrent().probe.onRefresh();
            await Promise.resolve();
        });

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
            vi.advanceTimersByTime(DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS + 1);
            await vi.runOnlyPendingTimersAsync();
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(true);

        await hook.unmount();
        vi.useRealTimers();
    });
});

