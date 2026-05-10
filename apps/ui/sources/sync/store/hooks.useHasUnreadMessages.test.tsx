import { afterEach, describe, expect, it } from 'vitest';

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
});
