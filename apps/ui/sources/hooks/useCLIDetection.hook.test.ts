import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useMachineCapabilitiesCacheMock = vi.fn();

vi.mock('@/sync/storage', () => {
    return {
        useMachine: vi.fn(() => ({ id: 'm1', metadata: {} })),
    };
});

vi.mock('@/utils/machineUtils', () => {
    return {
        isMachineOnline: vi.fn(() => true),
    };
});

vi.mock('@/hooks/useMachineCapabilitiesCache', () => {
    return {
        useMachineCapabilitiesCache: (...args: any[]) => useMachineCapabilitiesCacheMock(...args),
    };
});

describe('useCLIDetection (hook)', () => {
    function renderHookState(run: () => unknown) {
        let latest: unknown = null;
        function Test() {
            latest = run();
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
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

        const { useCLIDetection } = await import('./useCLIDetection');

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

        const { useCLIDetection } = await import('./useCLIDetection');

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

            const { useCLIDetection } = await import('./useCLIDetection');

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

        const { useCLIDetection } = await import('./useCLIDetection');
        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false, includeLoginStatus: true }));

        const firstCall = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0];
        expect(firstCall?.request?.checklistId).toBeDefined();
        expect(firstCall?.request?.overrides).toBeTruthy();
        expect(latest?.isDetecting).toBe(true);
        expect(Object.values(latest?.login ?? {}).every((value) => value === null)).toBe(true);
    });

    it('exposes an error marker when cache status is error and no snapshot exists', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { status: 'error' },
            refresh: vi.fn(),
        });

        const { useCLIDetection } = await import('./useCLIDetection');
        const latest = renderHookState(() => useCLIDetection('m1', { autoDetect: false }));

        expect(latest?.error).toBe('Detection error');
        expect(latest?.timestamp).toBe(0);
    });
});
