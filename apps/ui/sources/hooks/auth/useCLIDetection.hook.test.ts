import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useMachineCapabilitiesCacheMock = vi.fn();

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'kiro'],
    getAgentCore: (agentId: string) => ({
        cli: {
            detectKey: ({
                claude: 'claude',
                codex: 'codex',
                gemini: 'gemini',
                kiro: 'kiro-cli',
            } as Record<string, string>)[agentId] ?? agentId,
        },
    }),
}));

vi.mock('@/sync/domains/state/storage', () => {
    return {
        useMachine: vi.fn(() => ({ id: 'm1', metadata: {} })),
    };
});

vi.mock('@/utils/sessions/machineUtils', () => {
    return {
        isMachineOnline: vi.fn(() => true),
    };
});

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => {
    return {
        useMachineCapabilitiesCache: (...args: any[]) => useMachineCapabilitiesCacheMock(...args),
    };
});

const { useCLIDetection } = await import('./useCLIDetection');

describe('useCLIDetection (hook)', () => {
    function renderHookState(run: () => unknown) {
        let latest: unknown = null;
        let root: renderer.ReactTestRenderer | null = null;
        function Test() {
            latest = run();
            return React.createElement('View');
        }

        act(() => {
            root = renderer.create(React.createElement(Test));
        });

        act(() => {
            root?.unmount();
        });

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

        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

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

        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        expect(latest?.tmux).toBe(null);
    });

    it('keeps timestamp stable when results have no checkedAt values', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1000);

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

            let root: any = null;
            act(() => {
                root = renderer.create(React.createElement(Test));
            });
            expect(latest?.timestamp).toBe(1000);

            vi.setSystemTime(2000);

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

            act(() => {
                root.update(React.createElement(Test));
            });

            expect(latest?.timestamp).toBe(1000);
        } finally {
            vi.useRealTimers();
        }
    });

    it('requests login-status overrides when includeLoginStatus is enabled', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false, includeLoginStatus: true }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.request?.checklistId).toBeDefined();
        expect(firstCall?.request?.overrides).toBeTruthy();
        expect(firstCall?.request?.overrides?.['cli.codex']?.params?.includeLoginStatus).toBe(true);
        expect(firstCall?.request?.overrides?.['cli.kiro']?.params?.includeLoginStatus).toBeUndefined();
        expect(latest?.isDetecting).toBe(true);
        expect(Object.values(latest?.login ?? {}).every((value) => value === null)).toBe(true);
    });

    it('can scope detection to a single provider capability instead of the whole checklist', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        renderHookState(() => useCLIDetection('m1', {
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

    it('uses each provider detect key when scoping detection requests', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        renderHookState(() => useCLIDetection('m1', {
            autoDetect: false,
            agentIds: ['kiro'],
        }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.request?.requests).toEqual([{ id: 'cli.kiro-cli' }]);
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

        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false, includeLoginStatus: true }));

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

        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false, includeLoginStatus: true }));

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

        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        latest?.refresh?.({ bypassCache: true, includeLoginStatusForAgentIds: ['kiro'] });

        expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                overrides: expect.objectContaining({
                    'cli.kiro-cli': {
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

        let root: renderer.ReactTestRenderer | null = null;
        act(() => {
            root = renderer.create(React.createElement(Test, { agentIds: ['codex'] }));
        });

        act(() => {
            root?.update(React.createElement(Test, { agentIds: ['kiro'] }));
        });

        latest?.refresh?.({ bypassCache: true });

        expect(refresh).toHaveBeenLastCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                requests: [{ id: 'cli.kiro-cli', params: { bypassCache: true } }],
            }),
        }));

        act(() => {
            root?.unmount();
        });
    });

    it('reads auth status from the latest capabilities snapshot even when background login-status checks are disabled', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.kiro-cli': {
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

        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

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

        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        expect(latest?.error).toBe('Detection error');
        expect(latest?.timestamp).toBe(0);
    });

    it('forwards server scope to the machine capabilities cache hook', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'loading' },
            refresh: vi.fn(),
        });

        renderHookState(() => useCLIDetection('m1', { autoDetect: false, serverId: 'server-b' }));

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

        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        expect(latest?.resolvedPath?.codex).toBe('/opt/codex/bin/codex');
        expect(latest?.resolvedPath?.claude).toBe('/usr/local/bin/claude');
        expect(latest?.resolvedPath?.gemini).toBe(null);
    });
});
