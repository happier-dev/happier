import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { resetDynamicModelProbeCacheForTests, DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS } from '@/sync/domains/models/dynamicModelProbeCache';
import { installCapabilitiesOpsModuleMock } from '@/dev/testkit/mocks/capabilities';

const machineCapabilitiesInvokeMock = vi.fn();
type DeferredModelProbeResult = {
    supported: true;
    response: {
        ok: true;
        result: {
            availableModels: Array<{ id: string; name: string }>;
            supportsFreeform: boolean;
        };
    };
};

describe('useNewSessionPreflightModelsState (refresh)', () => {
    it('forces a refresh probe without clearing existing options', async () => {
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicModelProbeCacheForTests();
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
                    result: { availableModels: [{ id: `m${call}`, name: `Model ${call}` }], supportsFreeform: false },
                },
            };
        });

        const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
        const hook = await renderHook(
            (props: { cwd: string }) => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: props.cwd,
            }),
            { initialProps: { cwd: '/repo' } },
        );

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(true);

        await act(async () => {
            hook.getCurrent().probe.onRefresh();
            await Promise.resolve();
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm2')).toBe(true);

        await hook.unmount();
    });

    it('keeps the previous model list visible while probing a different cwd', async () => {
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicModelProbeCacheForTests();
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        let resolveSecondProbe: ((value: DeferredModelProbeResult) => void) | null = null;
        machineCapabilitiesInvokeMock
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: {
                    ok: true as const,
                    result: { availableModels: [{ id: 'm1', name: 'Model 1' }], supportsFreeform: false },
                },
            }))
            .mockImplementationOnce(() => new Promise<DeferredModelProbeResult>((resolve) => {
                resolveSecondProbe = resolve;
            }));

        const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
        const hook = await renderHook(
            (props: { cwd: string }) => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: props.cwd,
            }),
            { initialProps: { cwd: '/repo-a' } },
        );

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(true);

        await hook.rerender({ cwd: '/repo-b' });
        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(true);

        if (!resolveSecondProbe) {
            throw new Error('expected deferred second probe resolver');
        }

        const resolveDeferredSecondProbe = resolveSecondProbe as unknown as (value: DeferredModelProbeResult) => void;

        resolveDeferredSecondProbe({
            supported: true,
            response: {
                ok: true,
                result: { availableModels: [{ id: 'm2', name: 'Model 2' }], supportsFreeform: false },
            },
        });

        await act(async () => {
            await Promise.resolve();
        });

        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm2')).toBe(true);
        await hook.unmount();
    });

    it('retries after an error cooldown elapses so transient capability errors do not permanently hide model options', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicModelProbeCacheForTests();
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
                    result: { availableModels: [{ id: 'm1', name: 'Model 1' }], supportsFreeform: false },
                },
            }));

        const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo',
            }),
        );

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(false);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS + 1);
        });

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(true);

        await hook.unmount();
        vi.useRealTimers();
    });
});
