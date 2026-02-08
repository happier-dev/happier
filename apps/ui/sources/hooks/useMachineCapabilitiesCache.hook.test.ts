import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import type { CapabilitiesDetectRequest } from '@/sync/capabilitiesProtocol';
import { flushHookEffects } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMachineCapabilitiesCache (hook)', () => {
    const newSessionRequest = (): CapabilitiesDetectRequest => ({ checklistId: CHECKLIST_IDS.NEW_SESSION });

    it('does not leave the cache stuck in loading when detection throws', async () => {
        vi.resetModules();

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect: vi.fn(async () => {
                    throw new Error('boom');
                }),
            };
        });

        const { prefetchMachineCapabilities, useMachineCapabilitiesCache } = await import('./useMachineCapabilitiesCache');

        await expect(prefetchMachineCapabilities({
            machineId: 'm1',
            request: newSessionRequest(),
            timeoutMs: 1,
        })).resolves.toBeUndefined();

        let latest: any = null;
        function Test() {
            latest = useMachineCapabilitiesCache({
                machineId: 'm1',
                enabled: false,
                request: newSessionRequest(),
                timeoutMs: 1,
            }).state;
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(latest?.status).toBe('error');
    });

    it('keeps refresh stable when request identity changes and uses latest request', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn(async (_machineId: string, _request: CapabilitiesDetectRequest) => {
            return { supported: true, response: { protocolVersion: 1, results: {} } };
        });

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect,
            };
        });

        const { useMachineCapabilitiesCache } = await import('./useMachineCapabilitiesCache');

        const requestA = newSessionRequest();
        const requestB = newSessionRequest();

        let latestRefresh: null | (() => void) = null;

        function Test({ request }: { request: CapabilitiesDetectRequest }) {
            const { refresh } = useMachineCapabilitiesCache({
                machineId: 'm1',
                enabled: false,
                request,
                timeoutMs: 1,
            });
            latestRefresh = refresh;
            return React.createElement('View');
        }

        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(React.createElement(Test, { request: requestA }));
        });
        const refreshA = latestRefresh!;

        act(() => {
            tree!.update(React.createElement(Test, { request: requestB }));
        });
        const refreshB = latestRefresh!;

        expect(refreshB).toBe(refreshA);

        await act(async () => {
            refreshA();
            await flushHookEffects();
        });

        expect(machineCapabilitiesDetect).toHaveBeenCalled();
        expect(machineCapabilitiesDetect.mock.calls[0][1]).toBe(requestB);
    });

    it('uses a longer default timeout for machine-details detection', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn(async (_machineId: string, _request: CapabilitiesDetectRequest, _opts: { timeoutMs?: number }) => {
            return { supported: true, response: { protocolVersion: 1, results: {} } };
        });

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect,
            };
        });

        const { prefetchMachineCapabilities } = await import('./useMachineCapabilitiesCache');

        await prefetchMachineCapabilities({
            machineId: 'm1',
            request: { checklistId: CHECKLIST_IDS.MACHINE_DETAILS },
        });

        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);
        const opts = machineCapabilitiesDetect.mock.calls[0][2];
        expect(typeof opts?.timeoutMs).toBe('number');
        expect(opts.timeoutMs).toBeGreaterThanOrEqual(8000);
    });

    it('exposes the latest snapshot after a prefetch', async () => {
        vi.resetModules();

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect: vi.fn(async () => {
                    return {
                        supported: true,
                        response: {
                            protocolVersion: 1,
                            results: {
                                'cli.gemini': { ok: true, checkedAt: 1, data: { available: true } },
                            },
                        },
                    };
                }),
            };
        });

        const { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities } = await import('./useMachineCapabilitiesCache');

        expect(getMachineCapabilitiesSnapshot('m1')).toBeNull();

        await prefetchMachineCapabilities({
            machineId: 'm1',
            request: newSessionRequest(),
        });

        expect(getMachineCapabilitiesSnapshot('m1')?.response.results).toEqual({
            'cli.gemini': { ok: true, checkedAt: 1, data: { available: true } },
        });
    });

    it('prefetchMachineCapabilitiesIfStale only fetches when stale or missing', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn(async () => {
            return { supported: true, response: { protocolVersion: 1, results: {} } };
        });

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect,
            };
        });

        const { prefetchMachineCapabilitiesIfStale } = await import('./useMachineCapabilitiesCache');

        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: 60_000,
            request: newSessionRequest(),
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);

        // Fresh cache entry: should be a no-op.
        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: 60_000,
            request: newSessionRequest(),
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);

        // Force staleness: should fetch again.
        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: -1,
            request: newSessionRequest(),
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(2);
    });

    it('does not refetch when cache age is exactly the stale threshold', async () => {
        vi.resetModules();
        vi.useFakeTimers();

        try {
            vi.setSystemTime(1_000_000);
            const machineCapabilitiesDetect = vi.fn(async () => {
                return { supported: true, response: { protocolVersion: 1, results: {} } };
            });

            vi.doMock('@/sync/ops', () => {
                return {
                    machineCapabilitiesDetect,
                };
            });

            const { prefetchMachineCapabilitiesIfStale } = await import('./useMachineCapabilitiesCache');
            const staleMs = 60_000;

            await prefetchMachineCapabilitiesIfStale({
                machineId: 'm1',
                staleMs,
                request: newSessionRequest(),
                timeoutMs: 1,
            });
            expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);

            vi.setSystemTime(1_000_000 + staleMs);
            await prefetchMachineCapabilitiesIfStale({
                machineId: 'm1',
                staleMs,
                request: newSessionRequest(),
                timeoutMs: 1,
            });
            expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
