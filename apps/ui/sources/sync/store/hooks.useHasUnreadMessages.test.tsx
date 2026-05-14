import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useHasUnreadMessages } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

describe('useHasUnreadMessages', () => {
    it('returns true for linked direct sessions with newer observed external progress', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    'direct-session-1': {
                        id: 'direct-session-1',
                        seq: 0,
                        createdAt: 1,
                        updatedAt: 2,
                        active: true,
                        activeAt: 2,
                        metadataVersion: 1,
                        metadata: {
                            path: '',
                            machineId: 'machine-1',
                            externalSessionV1: {
                                v: 1,
                                providerId: 'claude',
                                machineId: 'machine-1',
                                remoteSessionId: 'remote-1',
                                source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: null },
                                linkedAtMs: 1,
                            },
                            externalSessionAttentionV1: {
                                v: 1,
                                observedProgressToken: '20:msg-2',
                                viewedProgressToken: '10:msg-1',
                                observedAtMs: 20,
                                viewedAtMs: 10,
                            },
                        },
                        agentState: null,
                        agentStateVersion: 0,
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                    } as any,
                },
            }));

            const hook = await renderHook(() => useHasUnreadMessages('direct-session-1'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(true);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('falls back to cache-only renderables when the full session record is absent', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {},
                sessionListRenderables: {
                    ...state.sessionListRenderables,
                    'direct-session-cache-only': {
                        id: 'direct-session-cache-only',
                        seq: 0,
                        createdAt: 1,
                        updatedAt: 2,
                        active: false,
                        activeAt: 2,
                        archivedAt: null,
                        metadataVersion: 1,
                        agentStateVersion: 0,
                        metadata: {
                            path: '/tmp/direct',
                            host: 'localhost',
                            externalSessionV1: {
                                v: 1,
                                providerId: 'claude',
                            },
                        },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 'online',
                        hasUnreadMessages: true,
                    } as any,
                },
            }));

            const hook = await renderHook(() => useHasUnreadMessages('direct-session-cache-only'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(true);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps the session-list activity label stable while streaming timestamps stay in the same display bucket', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    s1: {
                        id: 's1',
                        createdAt: 1,
                    },
                },
                sessionMessages: {
                    s1: {
                        latestThinkingMessageActivityAtMs: 60_000,
                    },
                },
                sessionPending: {},
                sessionListRenderables: {},
                isDataReady: true,
            } as never));

            const { useSessionListActivityTimeLabel } = await import('./hooks');
            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionListActivityTimeLabel('s1');
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initial = hook.getCurrent();

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionMessages: {
                        s1: {
                            latestThinkingMessageActivityAtMs: 60_500,
                        },
                    },
                } as never));
            });

            expect(hook.getCurrent()).toBe(initial);
            expect(renderCount).toBe(1);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
