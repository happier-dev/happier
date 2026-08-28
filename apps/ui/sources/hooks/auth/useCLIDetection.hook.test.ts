import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAuthHookCommonModuleMocks } from './authHookTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useMachineCapabilitiesCacheMock = vi.fn();
const storageState = vi.hoisted(() => ({
    useMachine: vi.fn<() => unknown>(() => ({ id: 'm1', metadata: {}, active: true, daemonStateVersion: 42 })),
    useMachineCliDetectionTarget: vi.fn(() => ({ daemonStateVersion: 42, isOnline: true })),
    isMachineOnline: vi.fn(() => true),
}));
const agentsPackageState = vi.hoisted(() => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'kiro'],
    CANONICAL_AGENT_IDS: ['claude', 'codex', 'gemini', 'kiro'],
    AGENT_LOCAL_CLI_CONFIG: {
        claude: { detectKey: 'claude' },
        codex: { detectKey: 'codex' },
        gemini: { detectKey: 'gemini' },
        kiro: { detectKey: 'kiro-cli' },
    },
    isAgentCliAuthBackgroundCheckSafe: (agentId: string) => agentId !== 'kiro',
}));

function resolvePackageDetectKey(agentId: string): string {
    const entry = (agentsPackageState.AGENT_LOCAL_CLI_CONFIG as Record<string, { detectKey: string }>)[agentId];
    return entry?.detectKey ?? agentId;
}

installAuthHookCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useMachine: storageState.useMachine,
            useMachineCliDetectionTarget: storageState.useMachineCliDetectionTarget,
        });
    },
});

vi.mock('@happier-dev/agents', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@happier-dev/agents')>()),
    ...agentsPackageState,
    resolveAgentStateRequestCoverageOptions: () => ({}),
    isAgentStateRequestCoveredByCompletedRequests: () => false,
    getAgentLocalCliConfig: (agentId: string) => ({
        agentId,
        detectKey: resolvePackageDetectKey(agentId),
        machineLoginKey: agentId,
        supportKind: 'login_terminal',
        loginLaunch: null,
    }),
}));

vi.mock('@/utils/sessions/machineUtils', () => {
    return {
        isMachineOnline: storageState.isMachineOnline,
    };
});

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => {
    return {
        useMachineCapabilitiesCache: (...args: any[]) => useMachineCapabilitiesCacheMock(...args),
    };
});

const { useCLIDetection } = await import('./useCLIDetection');

describe('useCLIDetection (hook)', () => {
    beforeEach(() => {
        agentsPackageState.AGENT_LOCAL_CLI_CONFIG.codex.detectKey = 'codex';
        storageState.useMachine.mockClear();
        storageState.useMachine.mockReturnValue({ id: 'm1', metadata: {}, daemonStateVersion: 42 });
        storageState.useMachineCliDetectionTarget.mockClear();
        storageState.useMachineCliDetectionTarget.mockReturnValue({ daemonStateVersion: 42, isOnline: true });
        storageState.isMachineOnline.mockClear();
        storageState.isMachineOnline.mockReturnValue(true);
    });

    async function renderHookState(run: () => unknown) {
        let latest: unknown = null;
        function Test() {
            latest = run();
            return React.createElement('View');
        }

        const screen = await renderScreen(React.createElement(Test));
        await screen.unmount();

        return latest as any;
    }

    it('includes tmux availability from capabilities results when present', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.claude': { ok: true, checkedAt: 1, data: { available: true } },
                            'cli.codex': { ok: true, checkedAt: 1, data: { available: true } },
                            'cli.gemini': { ok: true, checkedAt: 1, data: { available: true } },
                            'tool.tmux': { ok: true, checkedAt: 1, data: { available: true } },
                        },
                    },
                },
            },
            refresh: vi.fn(),
        });

        const latest = await renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        expect(latest?.tmux).toBe(true);
    });

    it('treats missing tmux field as unknown (null) for older daemons', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.claude': { ok: true, checkedAt: 1, data: { available: true } },
                            'cli.codex': { ok: true, checkedAt: 1, data: { available: true } },
                            'cli.gemini': { ok: true, checkedAt: 1, data: { available: true } },
                        },
                    },
                },
            },
            refresh: vi.fn(),
        });

        const latest = await renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        expect(latest?.tmux).toBe(null);
    });

    it('keeps timestamp stable when results have no checkedAt values', async () => {
        const dateNowSpy = vi.spyOn(Date, 'now');
        try {
            dateNowSpy.mockReturnValueOnce(1000);

            useMachineCapabilitiesCacheMock.mockReturnValueOnce({
                state: {
                    status: 'loaded',
                    snapshot: {
                        response: {
                            protocolVersion: 1,
                            results: {},
                        },
                    },
                },
                refresh: vi.fn(),
            });

            let latest: any = null;
            function Test() {
                latest = useCLIDetection('m1', { autoDetect: false });
                return React.createElement('View');
            }

            const screen = await renderScreen(React.createElement(Test));
            expect(latest?.timestamp).toBe(1000);

            dateNowSpy.mockReturnValueOnce(2000);

            useMachineCapabilitiesCacheMock.mockReturnValueOnce({
                state: {
                    status: 'loaded',
                    snapshot: {
                        response: {
                            protocolVersion: 1,
                            results: {},
                        },
                    },
                },
                refresh: vi.fn(),
            });

            await screen.update(React.createElement(Test));

            expect(latest?.timestamp).toBe(1000);
        } finally {
            dateNowSpy.mockRestore();
        }
    });

    it('keeps refresh callback referentially stable across capability cache updates', async () => {
        const baseRefresh = vi.fn();

        useMachineCapabilitiesCacheMock.mockReturnValueOnce({
            state: { status: 'loading' },
            refresh: baseRefresh,
        });

        let latest: any = null;
        function Test() {
            latest = useCLIDetection('m1', { autoDetect: false });
            return React.createElement('View');
        }

        const screen = await renderScreen(React.createElement(Test));
        const refreshRef = latest?.refresh;
        expect(typeof refreshRef).toBe('function');

        useMachineCapabilitiesCacheMock.mockReturnValueOnce({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.claude': { ok: true, checkedAt: 1, data: { available: true } },
                        },
                    },
                },
            },
            refresh: baseRefresh,
        });

        await screen.update(React.createElement(Test));

        expect(latest?.refresh).toBe(refreshRef);
        await screen.unmount();
    });

    it('requests login-status overrides when includeLoginStatus is enabled', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        const latest = await renderHookState(() => useCLIDetection('m1', { autoDetect: false, includeLoginStatus: true }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.request?.checklistId).toBeDefined();
        expect(firstCall?.request?.overrides).toBeTruthy();
        expect(firstCall?.request?.overrides?.['cli.codex']?.params?.includeLoginStatus).toBe(true);
        expect(firstCall?.request?.overrides?.['cli.kiro']?.params?.includeLoginStatus).toBeUndefined();
        expect(latest?.isDetecting).toBe(true);
        expect(Object.values(latest?.login ?? {}).every((value) => value === null)).toBe(true);
    });

    it('treats an explicit empty login-status scope as fail-closed', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        await renderHookState(() => useCLIDetection('m1', {
            autoDetect: false,
            includeLoginStatus: true,
            includeLoginStatusForAgentIds: [],
            agentIds: ['codex'],
        }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.request?.requests).toEqual([{ id: 'cli.codex' }]);
    });

    it('uses canonical provider ids for scoped CLI requests even when the binary detect key differs', async () => {
        agentsPackageState.AGENT_LOCAL_CLI_CONFIG.codex.detectKey = 'codex-alt';

        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        await renderHookState(() => useCLIDetection('m1', {
            autoDetect: false,
            agentIds: ['codex'],
        }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.request?.requests).toEqual([
            {
                id: 'cli.codex',
            },
        ]);
    });

    it('can scope detection to a single provider capability instead of the whole checklist', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        await renderHookState(() => useCLIDetection('m1', {
            autoDetect: false,
            includeLoginStatus: true,
            agentIds: ['codex'],
        }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.request?.checklistId).toBeUndefined();
        expect(firstCall?.request?.requests).toEqual([
            {
                id: 'cli.codex',
                params: {
                    includeLoginStatus: true,
                },
            },
        ]);
        expect(firstCall?.request?.overrides).toBeUndefined();
    });

    it('can scope detection and read results for a projected native agent id', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.acme.native': {
                                ok: true,
                                checkedAt: 123,
                                data: {
                                    available: true,
                                    resolvedPath: '/opt/acme/bin/acme',
                                    resolvedCommand: "'/opt/acme/bin/acme'",
                                    resolutionSource: 'system',
                                },
                            },
                        },
                    },
                },
            },
            refresh: vi.fn(),
        });

        const latest = await renderHookState(() => useCLIDetection('m1', {
            autoDetect: false,
            agentIds: ['acme.native'],
        }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.request?.requests).toEqual([{ id: 'cli.acme.native' }]);
        expect(latest.available['acme.native']).toBe(true);
        expect(latest.resolvedCommand['acme.native']).toBe("'/opt/acme/bin/acme'");
    });

    it('scopes the capability cache entry by daemon state version', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        await renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.cacheKeySalt).toBe(42);
    });

    it('uses the narrow CLI detection target for daemon version and online state', async () => {
        storageState.useMachine.mockReturnValue({ id: 'm1', metadata: {}, active: false, daemonStateVersion: 1 });
        storageState.useMachineCliDetectionTarget.mockReturnValue({ daemonStateVersion: 77, isOnline: true });
        storageState.isMachineOnline.mockReturnValue(false);
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        await renderHookState(() => useCLIDetection('m1'));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.enabled).toBe(true);
        expect(firstCall?.cacheKeySalt).toBe(77);
    });

    it('uses the canonical provider id when scoping detection requests', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        await renderHookState(() => useCLIDetection('m1', {
            autoDetect: false,
            agentIds: ['kiro'],
        }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.request?.requests).toEqual([{ id: 'cli.kiro' }]);
    });

    it('returns structured auth status details when the capability payload includes them', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.codex': {
                                ok: true,
                                checkedAt: 123,
                                data: {
                                    available: true,
                                    isLoggedIn: true,
                                    authStatus: {
                                        state: 'logged_in',
                                        accountLabel: 'alice@example.com',
                                        method: 'oauth_cli',
                                        source: 'command',
                                        checkedAt: 123,
                                    },
                                },
                            },
                        },
                    },
                },
            },
            refresh: vi.fn(),
        });

        const latest = await renderHookState(() => useCLIDetection('m1', { autoDetect: false, includeLoginStatus: true }));

        expect(latest?.authStatus?.codex).toMatchObject({
            state: 'logged_in',
            accountLabel: 'alice@example.com',
            method: 'oauth_cli',
            source: 'command',
        });
    });

    it('can force a fresh login-status probe through refresh({ bypassCache: true })', async () => {
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh,
        });

        const latest = await renderHookState(() => useCLIDetection('m1', { autoDetect: false, includeLoginStatus: true }));

        latest?.refresh?.({ bypassCache: true });

        expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                overrides: expect.objectContaining({
                    'cli.codex': expect.objectContaining({
                        params: expect.objectContaining({
                            includeLoginStatus: true,
                            bypassCache: true,
                        }),
                    }),
                }),
            }),
        }));
    });

    it('can force a fresh manual login-status probe for Kiro without enabling background checks', async () => {
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh,
        });

        const latest = await renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        latest?.refresh?.({ bypassCache: true, includeLoginStatusForAgentIds: ['kiro'] });

        expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                overrides: expect.objectContaining({
                    'cli.kiro': {
                        params: {
                            includeLoginStatus: true,
                            bypassCache: true,
                        },
                    },
                    'cli.codex': {
                        params: {
                            bypassCache: true,
                        },
                    },
                }),
            }),
        }));
    });

    it('refreshes using the latest scoped agent ids after the hook rerenders', async () => {
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh,
        });

        let latest: any = null;
        function Test(props: { agentIds: readonly ('codex' | 'kiro')[] }) {
            latest = useCLIDetection('m1', { autoDetect: false, agentIds: props.agentIds });
            return React.createElement('View');
        }

        const screen = await renderScreen(React.createElement(Test, { agentIds: ['codex'] }));

        await screen.update(React.createElement(Test, { agentIds: ['kiro'] }));

        latest?.refresh?.({ bypassCache: true });

        expect(refresh).toHaveBeenLastCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                requests: [{ id: 'cli.kiro', params: { bypassCache: true } }],
            }),
        }));

        await screen.unmount();
    });

    it('reads auth status from the latest capabilities snapshot even when background login-status checks are disabled', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.kiro': {
                                ok: true,
                                checkedAt: 123,
                                data: {
                                    available: true,
                                    isLoggedIn: false,
                                    authStatus: {
                                        state: 'logged_out',
                                        source: 'command',
                                        reason: 'missing_credentials',
                                        checkedAt: 123,
                                    },
                                },
                            },
                        },
                    },
                },
            },
            refresh: vi.fn(),
        });

        const latest = await renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        expect(latest?.login?.kiro).toBe(false);
        expect(latest?.authStatus?.kiro).toMatchObject({
            state: 'logged_out',
            source: 'command',
            reason: 'missing_credentials',
        });
    });

    it('exposes an error marker when cache status is error and no snapshot exists', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'error' },
            refresh: vi.fn(),
        });

        const latest = await renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        expect(latest?.error).toBe('Detection error');
        expect(latest?.timestamp).toBe(0);
    });

    it('keeps the last known availability while refreshing when the cache has no snapshot', async () => {
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValueOnce({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.claude': { ok: true, checkedAt: 10, data: { available: true } },
                            'cli.codex': { ok: true, checkedAt: 10, data: { available: false } },
                            'cli.gemini': { ok: true, checkedAt: 10, data: { available: true } },
                        },
                    },
                },
            },
            refresh,
        });

        let latest: any = null;
        function Test() {
            latest = useCLIDetection('m1', { autoDetect: false });
            return React.createElement('View');
        }

        const screen = await renderScreen(React.createElement(Test));
        expect(latest?.available?.claude).toBe(true);
        expect(latest?.available?.codex).toBe(false);
        expect(latest?.isDetecting).toBe(false);
        const initialTimestamp = latest?.timestamp;

        useMachineCapabilitiesCacheMock.mockReturnValueOnce({
            state: { status: 'loading' },
            refresh,
        });

        await screen.update(React.createElement(Test));

        expect(latest?.available?.claude).toBe(true);
        expect(latest?.available?.codex).toBe(false);
        expect(latest?.isDetecting).toBe(true);
        expect(latest?.timestamp).toBe(initialTimestamp);

        await screen.unmount();
    });

    it('forwards server scope to the machine capabilities cache hook', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        await renderHookState(() => useCLIDetection('m1', { autoDetect: false, serverId: 'server-b' }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.serverId).toBe('server-b');
    });

    it('preserves resolvedPath from CLI capability data', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.codex': {
                                ok: true,
                                checkedAt: 123,
                                data: {
                                    available: true,
                                    resolvedPath: '/opt/codex/bin/codex',
                                    version: '1.2.3',
                                },
                            },
                            'cli.claude': {
                                ok: true,
                                checkedAt: 123,
                                data: {
                                    available: true,
                                    resolvedPath: '/usr/local/bin/claude',
                                },
                            },
                        },
                    },
                },
            },
            refresh: vi.fn(),
        });

        const latest = await renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        expect(latest?.resolvedPath?.codex).toBe('/opt/codex/bin/codex');
        expect(latest?.resolvedPath?.claude).toBe('/usr/local/bin/claude');
        expect(latest?.resolvedPath?.gemini).toBe(null);
    });
});
