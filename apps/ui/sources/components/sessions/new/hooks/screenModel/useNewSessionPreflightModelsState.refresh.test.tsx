import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import {
    resetDynamicModelProbeCacheForTests,
    DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS,
    DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS,
    DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS,
} from '@/sync/domains/models/dynamicModelProbeCache';

const { capabilityRpc } = vi.hoisted(() => ({ capabilityRpc: vi.fn() }));

type DeferredModelProbeResult = {
        ok: true;
        result: {
            availableModels: Array<{ id: string; name: string }>;
            supportsFreeform: boolean;
        };
    };

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
const probeCache = await import('@/sync/domains/models/dynamicModelProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicModelProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightModelsState (refresh)', () => {
    it('does not probe models for static-only Agents (uses catalog list only)', async () => {
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        capabilityRpc.mockRejectedValue(new Error('unexpected probe call'));

        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'gemini' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            }),
        );

        expect(capabilityRpc).not.toHaveBeenCalled();
        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'gemini-2.5-pro')).toBe(true);
        expect(hook.getCurrent().probe.phase).toBe('idle');
        expect(hook.getCurrent().probe.onRefresh).toBeUndefined();

        await hook.unmount();
    });

    it('forces a refresh probe without clearing existing options', async () => {
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        let call = 0;
        capabilityRpc.mockImplementation(async () => {
            call++;
            return {
                    ok: true as const,
                    result: { availableModels: [{ id: `m${call}`, name: `Model ${call}` }], supportsFreeform: false },
                };
        });

        const hook = await renderHook(
            (props: { cwd: string }) => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: props.cwd,
            }),
            { initialProps: { cwd: '/repo' } },
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(true);
        });

        await act(async () => {
            expect(hook.getCurrent().probe.onRefresh).toBeDefined();
            hook.getCurrent().probe.onRefresh?.();
        });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm2')).toBe(true);
        });

        await hook.unmount();
    });

    it('clears the previous model list while probing a different cwd', async () => {
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        let resolveSecondProbe: ((value: DeferredModelProbeResult) => void) | null = null;
        capabilityRpc
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: { availableModels: [{ id: 'm1', name: 'Model 1' }], supportsFreeform: false },
                }))
            .mockImplementationOnce(() => new Promise<DeferredModelProbeResult>((resolve) => {
                resolveSecondProbe = resolve;
            }));

        const hook = await renderHook(
            (props: { cwd: string }) => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: props.cwd,
            }),
            { initialProps: { cwd: '/repo-a' } },
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(true);
        });

        await hook.rerender({ cwd: '/repo-b' });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
        });
        expect(hook.getCurrent().preflightModels).toBeNull();

        if (!resolveSecondProbe) {
            throw new Error('expected deferred second probe resolver');
        }

        const resolveDeferredSecondProbe = resolveSecondProbe as unknown as (value: DeferredModelProbeResult) => void;

        resolveDeferredSecondProbe({
                ok: true,
                result: { availableModels: [{ id: 'm2', name: 'Model 2' }], supportsFreeform: false },
            });

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm2')).toBe(true);
        });
        await hook.unmount();
    });

    it('uses an expired cached model list as refreshing state while the background probe is pending', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(5_000_000);
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        let resolveProbe: ((value: DeferredModelProbeResult) => void) | null = null;
        capabilityRpc.mockImplementationOnce(() => new Promise<DeferredModelProbeResult>((resolve) => {
            resolveProbe = resolve;
        }));

        const {
            writeDynamicModelProbeCacheSuccess,
        } = await import('@/sync/domains/models/dynamicModelProbeCache');
        const { buildDynamicModelProbeCacheKey } = await import('@/sync/domains/models/dynamicModelProbeCacheKey');
        const cacheKey = buildDynamicModelProbeCacheKey({
            machineId: 'machine-1',
            targetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            serverId: preflight.serverId,
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

        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            }),
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
        });
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'cached-model')).toBe(true);
        expect(hook.getCurrent().probe.phase).toBe('refreshing');

        if (!resolveProbe) {
            throw new Error('expected deferred probe resolver');
        }
        const resolveDeferredProbe = resolveProbe as unknown as (value: DeferredModelProbeResult) => void;
        resolveDeferredProbe({
                ok: true,
                result: {
                    availableModels: [{ id: 'fresh-model', name: 'Fresh Model' }],
                    supportsFreeform: false,
                },
            });

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().modelOptions.some((option) => option.value === 'fresh-model')).toBe(true);
        });

        await hook.unmount();
        vi.useRealTimers();
    });

    it('does not expose a previous backend model list after the backend target changes', async () => {
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        capabilityRpc.mockImplementationOnce(async () => ({
                ok: true as const,
                result: { availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }], supportsFreeform: false },
            }));

        const hook = await renderHook(
            (props: { backendTarget: { kind: 'backend'; backendId: 'codex' | 'gemini' } }) =>
                useNewSessionPreflightModelsState({
                    backendTarget: props.backendTarget,
                    selectedMachineId: 'machine-1',
                    capabilityServerId: preflight.serverId,
                    cwd: '/repo',
                }),
            { initialProps: { backendTarget: { kind: 'backend', backendId: 'codex' } } },
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().preflightModels?.availableModels.map((model) => model.id)).toEqual(['gpt-5.5']);
        });
        expect(hook.getCurrent().preflightModelsTargetKey).toBe('agent:happier.agent.codex/codex');
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'gpt-5.5')).toBe(true);

        await hook.rerender({ backendTarget: { kind: 'backend', backendId: 'gemini' } });

        expect(hook.getCurrent().preflightModels).toBeNull();
        expect(hook.getCurrent().preflightModelsTargetKey).toBeNull();
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'gpt-5.5')).toBe(false);
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'gemini-2.5-pro')).toBe(true);
        expect(capabilityRpc).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });

    it('does not expose a previous dynamic backend model list after switching to another dynamic backend', async () => {
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        capabilityRpc.mockImplementationOnce(async () => ({
                ok: true as const,
                result: {
                    availableModels: [
                        { id: 'gpt-5.5', name: 'GPT 5.5' },
                        { id: 'opencode/big-pickle', name: 'Big Pickle' },
                    ],
                    supportsFreeform: true,
                },
            })).mockImplementationOnce(async () => ({
                ok: true as const,
                result: {
                    availableModels: [
                        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
                    ],
                    supportsFreeform: true,
                },
            }));

        const hook = await renderHook(
            (props: { backendTarget: { kind: 'backend'; backendId: 'codex' | 'opencode' } }) =>
                useNewSessionPreflightModelsState({
                    backendTarget: props.backendTarget,
                    selectedMachineId: 'machine-1',
                    capabilityServerId: preflight.serverId,
                    cwd: '/repo',
                }),
            { initialProps: { backendTarget: { kind: 'backend', backendId: 'codex' } } },
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().preflightModelsTargetKey).toBe('agent:happier.agent.codex/codex');
        });
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'gpt-5.5')).toBe(true);
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'opencode/big-pickle')).toBe(true);

        await hook.rerender({ backendTarget: { kind: 'backend', backendId: 'opencode' } });

        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'gpt-5.5')).toBe(false);
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'opencode/big-pickle')).toBe(false);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().modelOptions.some((option) => option.value === 'gemini-2.5-pro')).toBe(true);
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
        });
    });

    it('keeps trusted static models selectable when capability discovery returns a generic error', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        capabilityRpc
            .mockImplementationOnce(async () => ({ ok: false as const, error: { message: 'Daemon capability unavailable' } }))
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: { availableModels: [{ id: 'm1', name: 'Model 1' }], supportsFreeform: false },
                }));

        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            }),
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().probe.failed).toBe(true);
        });
        expect(hook.getCurrent().preflightModels).toBeNull();
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'default')).toBe(true);
        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(false);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS + 1);
        });

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(true);
            expect(hook.getCurrent().probe.failed).toBe(false);
        });

        await hook.unmount();
        vi.useRealTimers();
    });

    it('keeps a static fallback model list available across detail remounts in the same runtime', async () => {
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        capabilityRpc.mockImplementationOnce(async () => ({
                ok: true as const,
                result: {
                    agentId: 'codex',
                    source: 'static',
                    availableModels: [{ id: 'runtime-only-model', name: 'Runtime Only' }],
                    supportsFreeform: false,
                },
            }));

        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            }),
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().modelOptions.some((option) => option.value === 'runtime-only-model')).toBe(true);
        });
        await hook.unmount();

        const remounted = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            }),
        );

        expect(capabilityRpc).toHaveBeenCalledTimes(1);
        expect(remounted.getCurrent().modelOptions.some((option) => option.value === 'runtime-only-model')).toBe(true);
        await remounted.unmount();
    });

    it('keeps a transient fallback list when a retry returns a less complete static fallback', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(3_000_000);
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        capabilityRpc
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: {
                        agentId: 'codex',
                        source: 'static',
                        availableModels: [{ id: 'runtime-only-model', name: 'Runtime Only' }],
                        supportsFreeform: false,
                    },
                }))
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: {
                        agentId: 'codex',
                        source: 'static',
                        availableModels: [{ id: 'fallback-model', name: 'Fallback Model' }],
                        supportsFreeform: false,
                    },
                }));

        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            }),
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().modelOptions.some((option) => option.value === 'runtime-only-model')).toBe(true);
        });
        await hook.unmount();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS + 1);
        });

        const remounted = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            }),
        );
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
            expect(remounted.getCurrent().probe.phase).toBe('idle');
            expect(remounted.getCurrent().modelOptions.some((option) => option.value === 'runtime-only-model')).toBe(true);
        });
        await remounted.unmount();
        vi.useRealTimers();
    });

    it('auto-retries quickly after a static fallback result so model options appear without manual refresh', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000_000);
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        capabilityRpc
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: {
                        agentId: 'codex',
                        source: 'static',
                        availableModels: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
                        supportsFreeform: false,
                    },
                }))
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: {
                        agentId: 'codex',
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
                }));

        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            }),
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().preflightModels?.availableModels?.[0]).toMatchObject({ id: 'gpt-5.4' });
        });
        expect(hook.getCurrent().preflightModels?.availableModels?.[0]?.modelOptions).toBeUndefined();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS + 1);
        });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().preflightModels?.availableModels?.[0]).toMatchObject({
                id: 'gpt-5.4',
                modelOptions: expect.arrayContaining([expect.objectContaining({ id: 'reasoning_effort' })]),
            });
        });

        await hook.unmount();
        vi.useRealTimers();
    });

    it('ends the fast static-fallback retries for every consumer of the catalog, so opening a picker does not probe again', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(4_000_000);
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();
        capabilityRpc.mockImplementation(async () => ({
            ok: true as const,
            result: { agentId: 'codex', source: 'static', availableModels: [{ id: 'gpt-5.4', name: 'GPT-5.4' }], supportsFreeform: false },
        }));
        const params = {
            backendTarget: { kind: 'backend', backendId: 'codex' },
            selectedMachineId: 'machine-1',
            capabilityServerId: preflight.serverId,
            cwd: '/repo',
        } as const;

        const screen = await renderHook(() => useNewSessionPreflightModelsState(params));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
        });
        for (let retry = 0; retry < 3; retry++) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS + 1);
            });
            await flushHookEffects();
        }
        // The first read plus the bounded fast retries.
        expect(capabilityRpc).toHaveBeenCalledTimes(3);

        // A picker that reads the same catalog while the screen is open joins the settled fallback.
        const picker = await renderHook(() => useNewSessionPreflightModelsState(params));
        await flushHookEffects();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS + 1);
        });
        await flushHookEffects();
        expect(capabilityRpc).toHaveBeenCalledTimes(3);
        expect(picker.getCurrent().modelOptions.some((option) => option.value === 'gpt-5.4')).toBe(true);

        await picker.unmount();
        await screen.unmount();
        vi.useRealTimers();
    });

    it('does not turn an unavailable model probe into a placeholder Default catalog', async () => {
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        capabilityRpc.mockImplementationOnce(async () => ({
                ok: true as const,
                result: {
                    agentId: 'codex',
                    source: 'unavailable',
                    availableModels: [],
                    supportsFreeform: false,
                },
            }));

        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            }),
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().preflightModels).toEqual({
                availableModels: [],
                supportsFreeform: false,
                unavailable: true,
            });
        });
        // The compatibility Default is not evidence that discovery found a selectable model.
        expect(hook.getCurrent().modelOptions).toEqual([]);

        await hook.unmount();
    });

    it('retains the last successful model list and timestamp when a forced refresh reports unavailable', async () => {
        capabilityRpc.mockReset();
        resetDynamicModelProbeCacheForTests();

        capabilityRpc
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: {
                        agentId: 'codex',
                        source: 'dynamic',
                        availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
                        supportsFreeform: false,
                    },
                }))
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: {
                        agentId: 'codex',
                        source: 'unavailable',
                        availableModels: [],
                        supportsFreeform: false,
                    },
                }));

        const hook = await renderHook(
            () => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' },
                selectedMachineId: 'machine-1',
                capabilityServerId: preflight.serverId,
                cwd: '/repo',
            }),
        );

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().modelOptions.some((option) => option.value === 'gpt-5.5')).toBe(true);
        });

        const observedAt = hook.getCurrent().probe.refreshedAt;
        await act(async () => {
            hook.getCurrent().probe.onRefresh?.();
        });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().probe.failed).toBe(true);
        });
        expect(hook.getCurrent().preflightModels).toEqual({
            availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
            supportsFreeform: false,
        });
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'default')).toBe(true);
        expect(hook.getCurrent().modelOptions.some((option) => option.value === 'gpt-5.5')).toBe(true);

        expect(hook.getCurrent().probe.refreshedAt).toBe(observedAt);
        expect(hook.getCurrent().probe.failed).toBe(true);
        await hook.unmount();
    });

    it('revalidates once without adding demand when probeContext identity churns but cached values are stable by content', async () => {
        capabilityRpc.mockReset();

        const cache = await import('@/sync/domains/models/dynamicModelProbeCache');
        const { buildDynamicModelProbeCacheKey } = await import('@/sync/domains/models/dynamicModelProbeCacheKey');
        const { resolveBackendTargetKeyV2 } = await import('@/agents/backendCatalog/backendTargetKeyV2');
        cache.resetDynamicModelProbeCacheForTests();
        const cachedValue = {
            availableModels: [{ id: 'm1', name: 'Model 1' }],
            supportsFreeform: false,
        };
        capabilityRpc.mockResolvedValue({ ok: true, result: cachedValue });
        cache.writeDynamicModelProbeCacheSuccess(buildDynamicModelProbeCacheKey({
            machineId: 'machine-1', targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
            providerConnectionId: null, serverId: preflight.serverId, cwd: '/repo', extraKeySuffixParts: ['appServer'],
        })!, cachedValue);

        const hook = await renderHook(() => useNewSessionPreflightModelsState({
            backendTarget: { kind: 'backend', backendId: 'codex' },
            selectedMachineId: 'machine-1',
            capabilityServerId: preflight.serverId,
            cwd: '/repo',
            probeContext: {
                cacheKeySuffixParts: ['appServer'],
                capabilityParams: { profileId: 'profile-a' },
            },
        }));

        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(true);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().probe.phase).toBe('idle');
            expect(hook.getCurrent().probe.failed).toBe(false);
        });

        await hook.rerender();
        await hook.rerender();
        await flushHookEffects();
        expect(capabilityRpc).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().modelOptions.some((o) => o.value === 'm1')).toBe(true);
        await hook.unmount();
    });
});
