import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import {
    resetDynamicModelProbeCacheForTests,
    DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS,
    DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS,
    DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { installCapabilitiesOpsModuleMock } from '@/dev/testkit/mocks/capabilities';
import { getModelOptionsForAgentType } from '@/sync/domains/models/modelOptions';

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
    it('does not probe models for static-only providers (uses catalog list only)', async () => {
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicModelProbeCacheForTests();
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        machineCapabilitiesInvokeMock.mockRejectedValue(new Error('unexpected probe call'));

        const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'qwen' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo',
            }),
        );

        expect(machineCapabilitiesInvokeMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().modelOptions.map((o) => o.value)).toEqual(
            getModelOptionsForAgentType('qwen').map((o) => o.value),
        );
        expect(hook.getCurrent().probe.phase).toBe('idle');
        expect(hook.getCurrent().probe.onRefresh).toBeUndefined();

        await hook.unmount();
    });

    it('probes models for Claude, which resolves its list at runtime', async () => {
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicModelProbeCacheForTests();
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        machineCapabilitiesInvokeMock.mockImplementation(async () => ({
            supported: true as const,
            response: {
                ok: true as const,
                result: { availableModels: [{ id: 'claude-opus-9', name: 'Opus 9' }], supportsFreeform: true },
            },
        }));

        const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo',
            }),
        );

        await flushHookEffects();

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'claude-opus-9')).toBe(true);
        expect(hook.getCurrent().probe.onRefresh).toBeDefined();

        await hook.unmount();
    });

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
            expect(hook.getCurrent().probe.onRefresh).toBeDefined();
            hook.getCurrent().probe.onRefresh?.();
        });
        await flushHookEffects();

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

        await flushHookEffects();

        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm2')).toBe(true);
        await hook.unmount();
    });

    it('uses an expired cached model list as refreshing state while the background probe is pending', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(5_000_000);
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicModelProbeCacheForTests();
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        let resolveProbe: ((value: DeferredModelProbeResult) => void) | null = null;
        machineCapabilitiesInvokeMock.mockImplementationOnce(() => new Promise<DeferredModelProbeResult>((resolve) => {
            resolveProbe = resolve;
        }));

        const {
            writeDynamicModelProbeCacheSuccess,
        } = await import('@/sync/domains/models/dynamicModelProbeCache');
        const { buildDynamicModelProbeCacheKey } = await import('@/sync/domains/models/dynamicModelProbeCacheKey');
        const cacheKey = buildDynamicModelProbeCacheKey({
            machineId: 'machine-1',
            targetKey: 'agent:codex',
            serverId: 'server-1',
            cwd: '/repo',
        });
        if (!cacheKey) {
            throw new Error('expected dynamic model cache key');
        }
        writeDynamicModelProbeCacheSuccess(
            cacheKey,
            {
                availableModels: [{ id: 'cached-model', name: 'Cached Model' }],
                supportsFreeform: false,
            },
            Date.now() - DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS - 1,
        );

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
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'cached-model')).toBe(true);
        expect(hook.getCurrent().probe.phase).toBe('refreshing');

        if (!resolveProbe) {
            throw new Error('expected deferred probe resolver');
        }
        const resolveDeferredProbe = resolveProbe as unknown as (value: DeferredModelProbeResult) => void;
        resolveDeferredProbe({
            supported: true,
            response: {
                ok: true,
                result: {
                    availableModels: [{ id: 'fresh-model', name: 'Fresh Model' }],
                    supportsFreeform: false,
                },
            },
        });

        await flushHookEffects();
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'fresh-model')).toBe(true);

        await hook.unmount();
        vi.useRealTimers();
    });

    it('does not expose a previous backend model list after the backend target changes', async () => {
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicModelProbeCacheForTests();
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        machineCapabilitiesInvokeMock.mockImplementationOnce(async () => ({
            supported: true as const,
            response: {
                ok: true as const,
                result: { availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }], supportsFreeform: false },
            },
        }));

        const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
        const hook = await renderHook(
            (props: { backendTarget: { kind: 'builtInAgent'; agentId: 'codex' | 'qwen' } }) =>
                useNewSessionPreflightModelsState({
                    backendTarget: props.backendTarget,
                    selectedMachineId: 'machine-1',
                    capabilityServerId: 'server-1',
                    cwd: '/repo',
                }),
            { initialProps: { backendTarget: { kind: 'builtInAgent', agentId: 'codex' } } },
        );

        expect(hook.getCurrent().preflightModels?.availableModels.map((model) => model.id)).toEqual(['gpt-5.5']);
        expect(hook.getCurrent().preflightModelsTargetKey).toBe('agent:codex');
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'gpt-5.5')).toBe(true);

        await hook.rerender({ backendTarget: { kind: 'builtInAgent', agentId: 'qwen' } });

        expect(hook.getCurrent().preflightModels).toBeNull();
        expect(hook.getCurrent().preflightModelsTargetKey).toBeNull();
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'gpt-5.5')).toBe(false);
        expect(hook.getCurrent().modelOptions.map((option) => option.value)).toEqual(
            getModelOptionsForAgentType('qwen').map((option) => option.value),
        );
        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);

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

    it('keeps a static fallback model list available across detail remounts in the same runtime', async () => {
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicModelProbeCacheForTests();
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        machineCapabilitiesInvokeMock.mockImplementationOnce(async () => ({
            supported: true as const,
            response: {
                ok: true as const,
                result: {
                    provider: 'codex',
                    source: 'static',
                    availableModels: [{ id: 'runtime-only-model', name: 'Runtime Only' }],
                    supportsFreeform: false,
                },
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
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'runtime-only-model')).toBe(true);
        await hook.unmount();

        const remounted = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo',
            }),
        );

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
        expect(remounted.getCurrent().modelOptions.some((option) => option.value === 'runtime-only-model')).toBe(true);
        await remounted.unmount();
    });

    it('keeps a transient fallback list when a retry returns a less complete static fallback', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(3_000_000);
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicModelProbeCacheForTests();
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        machineCapabilitiesInvokeMock
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: {
                    ok: true as const,
                    result: {
                        provider: 'codex',
                        source: 'static',
                        availableModels: [{ id: 'runtime-only-model', name: 'Runtime Only' }],
                        supportsFreeform: false,
                    },
                },
            }))
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: {
                    ok: true as const,
                    result: {
                        provider: 'codex',
                        source: 'static',
                        availableModels: [{ id: 'fallback-model', name: 'Fallback Model' }],
                        supportsFreeform: false,
                    },
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

        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'runtime-only-model')).toBe(true);
        await hook.unmount();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS + 1);
        });

        const remounted = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                cwd: '/repo',
            }),
        );
        await flushHookEffects();

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
        expect(remounted.getCurrent().modelOptions.some((option) => option.value === 'runtime-only-model')).toBe(true);
        await remounted.unmount();
        vi.useRealTimers();
    });

    it('auto-retries quickly after a static fallback result so model options appear without manual refresh', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000_000);
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();
        resetDynamicModelProbeCacheForTests();
        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));

        machineCapabilitiesInvokeMock
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: {
                    ok: true as const,
                    result: {
                        provider: 'codex',
                        source: 'static',
                        availableModels: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
                        supportsFreeform: false,
                    },
                },
            }))
            .mockImplementationOnce(async () => ({
                supported: true as const,
                response: {
                    ok: true as const,
                    result: {
                        provider: 'codex',
                        source: 'dynamic',
                        availableModels: [{
                            id: 'gpt-5.4',
                            name: 'GPT-5.4',
                            modelOptions: [{
                                id: 'reasoning_effort',
                                name: 'Thinking',
                                type: 'select',
                                currentValue: 'medium',
                                options: [
                                    { value: 'medium', name: 'Medium' },
                                    { value: 'high', name: 'High' },
                                ],
                            }],
                        }],
                        supportsFreeform: false,
                    },
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
        expect(hook.getCurrent().preflightModels?.availableModels?.[0]).toMatchObject({ id: 'gpt-5.4' });
        expect(hook.getCurrent().preflightModels?.availableModels?.[0]?.modelOptions).toBeUndefined();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS + 1);
        });
        await flushHookEffects();

        expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().preflightModels?.availableModels?.[0]).toMatchObject({
            id: 'gpt-5.4',
            modelOptions: expect.arrayContaining([expect.objectContaining({ id: 'reasoning_effort' })]),
        });

        await hook.unmount();
        vi.useRealTimers();
    });

    it('does not enter a render loop when probeContext identity churns but cached values are stable by content', async () => {
        vi.resetModules();
        machineCapabilitiesInvokeMock.mockReset();

        vi.doMock('@/sync/ops/capabilities', installCapabilitiesOpsModuleMock({
            machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
        }));
        machineCapabilitiesInvokeMock.mockRejectedValue(new Error('unexpected probe call'));

        let readCall = 0;
        const cachedValue = {
            availableModels: [{ id: 'm1', name: 'Model 1' }],
            supportsFreeform: false,
        };
        vi.doMock('@/sync/domains/models/dynamicModelProbeCache', async () => {
            const actual = await vi.importActual<typeof import('@/sync/domains/models/dynamicModelProbeCache')>(
                '@/sync/domains/models/dynamicModelProbeCache',
            );
            return {
                ...actual,
                readDynamicModelProbeCache: (_key: string) => {
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

        const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

        const hook = await renderHook(() => useNewSessionPreflightModelsState({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            cwd: '/repo',
            probeContext: {
                cacheKeySuffixParts: ['appServer'],
                capabilityParams: { runtimeKindOverride: 'appServer' },
            },
        } as any));

        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(true);
        expect(readCall).toBe(1);

        await hook.rerender();
        expect(readCall).toBe(1);
        await hook.unmount();
    });
});
