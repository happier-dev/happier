import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';
import type { CapabilitiesDetectRequest } from '@/sync/api/capabilities/capabilitiesProtocol';
import { flushHookEffects } from './serverFeatureHookHarness.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const activeServerIdRef = vi.hoisted(() => ({ current: 'server-a' }));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: activeServerIdRef.current,
        serverUrl: 'https://example.test',
        kind: 'stack',
        generation: 1,
    }),
}));

describe('useMachineCapabilitiesCache (hook)', () => {
    const newSessionRequest = (): CapabilitiesDetectRequest => ({ checklistId: CHECKLIST_IDS.NEW_SESSION });

    it('extends the detect timeout when cli login status overrides are requested', async () => {
        vi.resetModules();

        const { resolveMachineCapabilitiesTimeoutMs } = await import('./useMachineCapabilitiesCache');

        expect(resolveMachineCapabilitiesTimeoutMs({
            checklistId: CHECKLIST_IDS.NEW_SESSION,
            overrides: {
                'cli.codex': {
                    params: {
                        includeLoginStatus: true,
                    },
                },
            },
        }, 2_500)).toBe(20_000);
    });

    it('scopes cache entries by active server when serverId is omitted', async () => {
        vi.resetModules();

        activeServerIdRef.current = 'server-a';

        const machineCapabilitiesDetect = vi.fn(async () => {
            return { supported: true, response: { protocolVersion: 1, results: {} } };
        });

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect,
            };
        });

        const {
            prefetchMachineCapabilities,
            getMachineCapabilitiesCacheState,
        } = await import('./useMachineCapabilitiesCache');

        await prefetchMachineCapabilities({
            machineId: 'm1',
            request: newSessionRequest(),
            timeoutMs: 1,
        });

        expect(getMachineCapabilitiesCacheState('m1', 'server-a')?.status).toBe('loaded');

        activeServerIdRef.current = 'server-b';
        await prefetchMachineCapabilities({
            machineId: 'm1',
            request: newSessionRequest(),
            timeoutMs: 1,
        });

        expect(getMachineCapabilitiesCacheState('m1', 'server-a')?.status).toBe('loaded');
        expect(getMachineCapabilitiesCacheState('m1', 'server-b')?.status).toBe('loaded');
    });

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

    it('dedupes concurrent prefetches for the same machine+request', async () => {
        vi.resetModules();

        type DetectResponse = {
            supported: true;
            response: { protocolVersion: 1; results: Record<string, unknown> };
        };
        const resolvers: Array<(value: DetectResponse) => void> = [];
        const machineCapabilitiesDetect = vi.fn(async () => {
            return await new Promise((resolve) => {
                resolvers.push(resolve as (value: DetectResponse) => void);
            });
        });

        vi.doMock('@/sync/ops', () => {
            return { machineCapabilitiesDetect };
        });

        const { prefetchMachineCapabilities } = await import('./useMachineCapabilitiesCache');

        const request = newSessionRequest();
        const p1 = prefetchMachineCapabilities({ machineId: 'm1', request, timeoutMs: 10_000 });
        const p2 = prefetchMachineCapabilities({ machineId: 'm1', request, timeoutMs: 10_000 });

        // Flush the queued fetch start (serialized per machine cache key).
        await Promise.resolve();

        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);
        expect(resolvers).toHaveLength(1);

        resolvers[0]!({ supported: true, response: { protocolVersion: 1, results: {} } });
        await expect(Promise.all([p1, p2])).resolves.toBeDefined();
    });

    it('refetches when a later request needs a capability missing from the cached snapshot', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn()
            .mockResolvedValueOnce({
                supported: true,
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.claude': { ok: true, data: { available: true } },
                    },
                },
            })
            .mockResolvedValueOnce({
                supported: true,
                response: {
                    protocolVersion: 1,
                    results: {
                        'tool.executionRuns': { ok: true, data: { backends: { codex: { available: true, intents: ['delegate'] } } } },
                    },
                },
            });

        vi.doMock('@/sync/ops', () => ({
            machineCapabilitiesDetect,
        }));

        const { prefetchMachineCapabilities, useMachineCapabilitiesCache } = await import('./useMachineCapabilitiesCache');

        await prefetchMachineCapabilities({
            machineId: 'm1',
            request: { requests: [{ id: 'cli.claude' }] as any },
            timeoutMs: 1,
        });

        let latestState: {
            status: string;
            snapshot?: {
                response: {
                    results: Record<string, unknown>;
                };
            };
        } | null = null;

        function Test() {
            latestState = useMachineCapabilitiesCache({
                machineId: 'm1',
                enabled: true,
                request: { requests: [{ id: 'tool.executionRuns' }] as any },
                timeoutMs: 1,
            }).state;
            return React.createElement('View');
        }

        await act(async () => {
            renderer.create(React.createElement(Test));
            await flushHookEffects();
        });

        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(2);
        expect(machineCapabilitiesDetect.mock.calls[1]?.[1]).toEqual({ requests: [{ id: 'tool.executionRuns' }] });
        expect(latestState).toMatchObject({ status: 'loaded' });
        expect(latestState).toEqual(expect.objectContaining({
            snapshot: expect.objectContaining({
                response: expect.objectContaining({
                    results: expect.objectContaining({
                        'tool.executionRuns': expect.anything(),
                    }),
                }),
            }),
        }));
    });

    it('retries error states after a short backoff even when staleMs is large', async () => {
        vi.resetModules();
        vi.useFakeTimers();
        process.env.EXPO_PUBLIC_HAPPIER_MACHINE_CAPABILITIES_ERROR_BACKOFF_MS = '1000';

        try {
            vi.setSystemTime(1_000_000);
            const machineCapabilitiesDetect = vi.fn(async () => {
                throw new Error('boom');
            });

            vi.doMock('@/sync/ops', () => {
                return { machineCapabilitiesDetect };
            });

            const { prefetchMachineCapabilitiesIfStale } = await import('./useMachineCapabilitiesCache');

            await prefetchMachineCapabilitiesIfStale({
                machineId: 'm1',
                staleMs: 24 * 60 * 60 * 1000,
                request: newSessionRequest(),
                timeoutMs: 1,
            });
            expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);

            vi.setSystemTime(1_000_000 + 999);
            await prefetchMachineCapabilitiesIfStale({
                machineId: 'm1',
                staleMs: 24 * 60 * 60 * 1000,
                request: newSessionRequest(),
                timeoutMs: 1,
            });
            expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);

            vi.setSystemTime(1_000_000 + 1000);
            await prefetchMachineCapabilitiesIfStale({
                machineId: 'm1',
                staleMs: 24 * 60 * 60 * 1000,
                request: newSessionRequest(),
                timeoutMs: 1,
            });
            expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
            delete process.env.EXPO_PUBLIC_HAPPIER_MACHINE_CAPABILITIES_ERROR_BACKOFF_MS;
        }
    });

    it('retries immediately after a server-switch-abort detect result', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn()
            .mockResolvedValueOnce({ supported: false, reason: 'server-switch-abort' })
            .mockResolvedValueOnce({ supported: true, response: { protocolVersion: 1, results: {} } });

        vi.doMock('@/sync/ops', () => {
            return { machineCapabilitiesDetect };
        });

        const { prefetchMachineCapabilitiesIfStale, useMachineCapabilitiesCache } = await import('./useMachineCapabilitiesCache');

        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: 24 * 60 * 60 * 1000,
            request: newSessionRequest(),
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);

        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: 24 * 60 * 60 * 1000,
            request: newSessionRequest(),
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(2);

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

        expect(latest?.status).toBe('loaded');
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
        expect(opts.timeoutMs).toBeGreaterThanOrEqual(12_000);
    });

    it('uses a longer default timeout for execution-runs detection', async () => {
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
            request: { requests: [{ id: 'tool.executionRuns' }] },
        });

        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);
        const opts = machineCapabilitiesDetect.mock.calls[0][2];
        expect(typeof opts?.timeoutMs).toBe('number');
        expect(opts.timeoutMs).toBeGreaterThanOrEqual(12_000);
    });

    it('uses a longer default timeout for cli login-status detection', async () => {
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
            request: {
                checklistId: CHECKLIST_IDS.NEW_SESSION,
                overrides: {
                    'cli.codex': {
                        params: {
                            includeLoginStatus: true,
                        },
                    },
                },
            },
        });

        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);
        const opts = machineCapabilitiesDetect.mock.calls[0][2];
        expect(typeof opts?.timeoutMs).toBe('number');
        expect(opts.timeoutMs).toBeGreaterThanOrEqual(20_000);
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

    it('isolates snapshot cache entries by server id for the same machine id', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn(async () => {
            const call = machineCapabilitiesDetect.mock.calls.length;
            if (call === 1) {
                return {
                    supported: true,
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.codex': { ok: true, checkedAt: 1, data: { version: 'server-a' } },
                        },
                    },
                };
            }
            return {
                supported: true,
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.codex': { ok: true, checkedAt: 2, data: { version: 'server-b' } },
                    },
                },
            };
        });

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect,
            };
        });

        const { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities } = await import('./useMachineCapabilitiesCache');

        await prefetchMachineCapabilities({
            machineId: 'm1',
            serverId: 'server-a',
            request: newSessionRequest(),
        });
        await prefetchMachineCapabilities({
            machineId: 'm1',
            serverId: 'server-b',
            request: newSessionRequest(),
        });

        expect(getMachineCapabilitiesSnapshot('m1', 'server-a')?.response.results['cli.codex']).toEqual({
            ok: true,
            checkedAt: 1,
            data: { version: 'server-a' },
        });
        expect(getMachineCapabilitiesSnapshot('m1', 'server-b')?.response.results['cli.codex']).toEqual({
            ok: true,
            checkedAt: 2,
            data: { version: 'server-b' },
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

    it('refetches a fresh cache entry when login-status data was not included in the cached snapshot', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn(async (_machineId: string, request: CapabilitiesDetectRequest) => {
            const wantsLoginStatus = Boolean(request.overrides?.['cli.codex']?.params?.includeLoginStatus);
            return {
                supported: true,
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.codex': wantsLoginStatus
                            ? {
                                ok: true,
                                checkedAt: 2,
                                data: {
                                    available: true,
                                    isLoggedIn: false,
                                    authStatus: {
                                        state: 'logged_out',
                                        reason: 'missing_credentials',
                                        checkedAt: 2,
                                    },
                                },
                            }
                            : {
                                ok: true,
                                checkedAt: 1,
                                data: {
                                    available: true,
                                },
                            },
                    },
                },
            };
        });

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect,
            };
        });

        const { prefetchMachineCapabilitiesIfStale, getMachineCapabilitiesSnapshot } = await import('./useMachineCapabilitiesCache');

        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: 60_000,
            request: newSessionRequest(),
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);
        expect(getMachineCapabilitiesSnapshot('m1')?.response.results['cli.codex']).toEqual({
            ok: true,
            checkedAt: 1,
            data: { available: true },
        });

        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: 60_000,
            request: {
                checklistId: CHECKLIST_IDS.NEW_SESSION,
                overrides: {
                    'cli.codex': {
                        params: {
                            includeLoginStatus: true,
                        },
                    },
                },
            },
            timeoutMs: 1,
        });

        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(2);
        expect(getMachineCapabilitiesSnapshot('m1')?.response.results['cli.codex']).toEqual({
            ok: true,
            checkedAt: 2,
            data: {
                available: true,
                isLoggedIn: false,
                authStatus: {
                    state: 'logged_out',
                    reason: 'missing_credentials',
                    checkedAt: 2,
                },
            },
        });
    });

    it('preserves latest-version freshness when a dep cache merge reuses an older version-check payload', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi
            .fn()
            .mockResolvedValueOnce({
                supported: true,
                response: {
                    protocolVersion: 1,
                    results: {
                        [CODEX_ACP_DEP_ID]: {
                            ok: true,
                            checkedAt: 1,
                            data: {
                                installed: true,
                                installDir: '/tmp',
                                binPath: '/tmp/codex-acp',
                                installedVersion: '1.0.0',
                                sourceKind: 'github_release_binary',
                                lastInstallLogPath: null,
                                lastBackgroundUpdateCheckAtMs: null,
                                latestVersionCheck: {
                                    ok: true,
                                    latestVersion: '1.0.1',
                                    label: 'v1.0.1',
                                },
                            },
                        },
                    },
                },
            })
            .mockResolvedValueOnce({
                supported: true,
                response: {
                    protocolVersion: 1,
                    results: {
                        [CODEX_ACP_DEP_ID]: {
                            ok: true,
                            checkedAt: 2,
                            data: {
                                installed: true,
                                installDir: '/tmp',
                                binPath: '/tmp/codex-acp',
                                installedVersion: '1.0.0',
                                sourceKind: 'github_release_binary',
                                lastInstallLogPath: null,
                                lastBackgroundUpdateCheckAtMs: null,
                            },
                        },
                    },
                },
            });

        vi.doMock('@/sync/ops', () => ({
            machineCapabilitiesDetect,
        }));

        const { getMachineCapabilitiesSnapshot, prefetchMachineCapabilities } = await import('./useMachineCapabilitiesCache');

        await prefetchMachineCapabilities({
            machineId: 'm1',
            request: {
                requests: [{ id: CODEX_ACP_DEP_ID, params: { includeLatestVersion: true, onlyIfInstalled: true } }],
            },
            timeoutMs: 1,
        });
        await prefetchMachineCapabilities({
            machineId: 'm1',
            request: {
                requests: [{ id: CODEX_ACP_DEP_ID, params: { onlyIfInstalled: true } }],
            },
            timeoutMs: 1,
        });

        expect(getMachineCapabilitiesSnapshot('m1')?.response.results[CODEX_ACP_DEP_ID]).toEqual({
            ok: true,
            checkedAt: 2,
            data: {
                installed: true,
                installDir: '/tmp',
                binPath: '/tmp/codex-acp',
                installedVersion: '1.0.0',
                sourceKind: 'github_release_binary',
                lastInstallLogPath: null,
                lastBackgroundUpdateCheckAtMs: null,
                latestVersionCheck: {
                    ok: true,
                    latestVersion: '1.0.1',
                    label: 'v1.0.1',
                    checkedAt: 1,
                },
            },
        });
    });

    it('does not refetch a fresh cache entry when login-status data is already present', async () => {
        vi.resetModules();

        const machineCapabilitiesDetect = vi.fn(async () => {
            return {
                supported: true,
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.codex': {
                            ok: true,
                            checkedAt: 2,
                            data: {
                                available: true,
                                isLoggedIn: false,
                                authStatus: {
                                    state: 'logged_out',
                                    reason: 'missing_credentials',
                                    checkedAt: 2,
                                },
                            },
                        },
                    },
                },
            };
        });

        vi.doMock('@/sync/ops', () => {
            return {
                machineCapabilitiesDetect,
            };
        });

        const { prefetchMachineCapabilitiesIfStale } = await import('./useMachineCapabilitiesCache');

        const requestWithLoginStatus: CapabilitiesDetectRequest = {
            checklistId: CHECKLIST_IDS.NEW_SESSION,
            overrides: {
                'cli.codex': {
                    params: {
                        includeLoginStatus: true,
                    },
                },
            },
        };

        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: 60_000,
            request: requestWithLoginStatus,
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);

        await prefetchMachineCapabilitiesIfStale({
            machineId: 'm1',
            staleMs: 60_000,
            request: requestWithLoginStatus,
            timeoutMs: 1,
        });
        expect(machineCapabilitiesDetect).toHaveBeenCalledTimes(1);
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
