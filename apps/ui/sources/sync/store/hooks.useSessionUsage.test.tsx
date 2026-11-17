import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionUsage } from '@/sync/store/hooks';
import { createReducer, reducer } from "@happier-dev/session-core/reducer";
import { normalizeRawMessage } from "@happier-dev/session-core/raw";
import {
    getActiveServerId,
    removeServerProfile,
    setActiveServerId,
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';

afterEach(() => {
    standardCleanup();
});

describe('useSessionUsage context snapshot integration', () => {
    it('reads persisted usage from the exact Home without requiring a supplied Session', async () => {
        const previousState = storage.getState();
        const previousActiveServerId = getActiveServerId();
        const activeHome = await upsertServerProfile({ serverUrl: 'https://usage-bare-active.example.test' });
        const targetHome = await upsertServerProfile({ serverUrl: 'https://usage-bare-target.example.test' });
        const sessionId = 'exact-home-persisted-usage';
        const latestUsage = {
            inputTokens: 30, outputTokens: 10, cacheCreation: 0, cacheRead: 0,
            contextSize: 40, timestamp: 1_000,
        };
        try {
            await setActiveServerId(activeHome.id, { scope: 'device' });
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: createSessionFixture({ id: sessionId, serverId: targetHome.id, latestUsage }),
                },
            }));
            const hook = await renderHook(() => useSessionUsage(sessionId, { serverId: targetHome.id }));
            expect(hook.getCurrent()).toEqual(latestUsage);
            await hook.unmount();
        } finally {
            await standardCleanup();
            storage.setState(previousState);
            if (previousActiveServerId) await setActiveServerId(previousActiveServerId, { scope: 'device' });
            await removeServerProfile(activeHome.id);
            await removeServerProfile(targetHome.id);
        }
    });

    it('exposes a canonical snapshot from a raw token_count transcript record', async () => {
        const previousState = storage.getState();
        const contextSnapshot = {
            v: 1 as const,
            modelId: 'gpt-5.4',
            usedTokens: 42_000,
            windowTokens: 258_400,
            totalProcessedTokens: 120_000,
            baselineTokens: 12_000,
            isAutoCompactEnabled: null,
            categories: null,
            observedAtMs: 1_000,
            source: 'provider_turn' as const,
        };

        try {
            const normalized = normalizeRawMessage('usage-1', null, 1_000, {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'token_count',
                        input_tokens: 700,
                        output_tokens: 250,
                        contextSnapshot,
                    },
                },
            });
            expect(normalized?.role).toBe('agent');
            if (!normalized) throw new Error('token_count normalization failed');

            const reducerState = createReducer();
            reducer(reducerState, [normalized]);
            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    'session-1': {
                        messageIdsOldestFirst: [],
                        messagesById: {},
                        messagesMap: {},
                        reducerState,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 1,
                        isLoaded: true,
                    },
                },
            }));

            const hook = await renderHook(() => useSessionUsage('session-1'));

            expect(hook.getCurrent()).toMatchObject({
                contextSnapshot,
                contextSnapshotStale: false,
            });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('falls back to the session snapshot before transcript reducer state is available', async () => {
        const previousState = storage.getState();
        const sessionId = 'session-fallback';
        const latestUsage = {
            inputTokens: 700,
            outputTokens: 250,
            cacheCreation: 0,
            cacheRead: 200,
            contextSize: 1_200,
            contextWindowTokens: 258_400,
            contextSnapshot: {
                v: 1 as const,
                modelId: 'gpt-5.4',
                usedTokens: 1_200,
                windowTokens: 258_400,
                totalProcessedTokens: 1_150,
                baselineTokens: null,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: 1_000,
                source: 'provider_turn' as const,
            },
            contextSnapshotStale: false,
            timestamp: 1_000,
        };

        try {
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: createSessionFixture({ id: sessionId, latestUsage }),
                },
            }));

            const hook = await renderHook(() => useSessionUsage(sessionId));

            expect(hook.getCurrent()).toEqual(latestUsage);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('refuses same-id reducer and fallback usage from another Home for an exact Session', async () => {
        const previousState = storage.getState();
        const previousActiveServerId = getActiveServerId();
        const activeHome = await upsertServerProfile({ serverUrl: 'https://usage-active.example.test' });
        const targetHome = await upsertServerProfile({ serverUrl: 'https://usage-target.example.test' });
        const sessionId = 'same-session';
        const wrongHomeUsage = {
            inputTokens: 11,
            outputTokens: 12,
            cacheCreation: 0,
            cacheRead: 0,
            contextSize: 23,
            contextSnapshot: {
                v: 1 as const,
                modelId: 'wrong-home',
                usedTokens: 23,
                windowTokens: 100,
                totalProcessedTokens: 23,
                baselineTokens: null,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: 1_000,
                source: 'provider_turn' as const,
            },
            contextSnapshotStale: false,
            timestamp: 1_000,
        };

        try {
            await setActiveServerId(activeHome.id, { scope: 'device' });
            const reducerState = createReducer();
            reducerState.latestUsage = wrongHomeUsage;
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: createSessionFixture({
                        id: sessionId,
                        serverId: activeHome.id,
                        latestUsage: wrongHomeUsage,
                    }),
                },
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        messageIdsOldestFirst: [], messagesById: {}, messagesMap: {}, reducerState,
                        latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 1, isLoaded: true,
                    },
                },
            }));
            const exactSession = createSessionFixture({ id: sessionId, serverId: targetHome.id, latestUsage: null });

            const hook = await renderHook(() => useSessionUsage(sessionId, {
                serverId: targetHome.id,
                session: exactSession,
            }));

            expect(hook.getCurrent()).toBeNull();
            await hook.unmount();
        } finally {
            storage.setState(previousState);
            if (previousActiveServerId) await setActiveServerId(previousActiveServerId, { scope: 'device' });
            await removeServerProfile(activeHome.id);
            await removeServerProfile(targetHome.id);
        }
    });

    it('uses the live reducer only on the exact active Home and otherwise keeps the supplied Session fallback', async () => {
        const previousState = storage.getState();
        const previousActiveServerId = getActiveServerId();
        const activeHome = await upsertServerProfile({ serverUrl: 'https://usage-current.example.test' });
        const activeHomeIdentity = 'srv_usage_current_home_identity';
        await setServerProfileIdentityForUrl(activeHome.serverUrl, activeHomeIdentity);
        const otherHome = await upsertServerProfile({ serverUrl: 'https://usage-other.example.test' });
        const sessionId = 'same-session-live';
        const fallbackUsage = {
            inputTokens: 30,
            outputTokens: 10,
            cacheCreation: 0,
            cacheRead: 0,
            contextSize: 40,
            contextSnapshot: {
                v: 1 as const,
                modelId: 'fallback',
                usedTokens: 40,
                windowTokens: 100,
                totalProcessedTokens: 40,
                baselineTokens: null,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: 1_000,
                source: 'provider_turn' as const,
            },
            contextSnapshotStale: false,
            timestamp: 1_000,
        };
        const liveUsage = {
            ...fallbackUsage,
            contextSize: 70,
            contextSnapshot: { ...fallbackUsage.contextSnapshot, modelId: 'live', usedTokens: 70 },
            timestamp: 2_000,
        };

        try {
            await setActiveServerId(activeHome.id, { scope: 'device' });
            const reducerState = createReducer();
            reducerState.latestUsage = liveUsage;
            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        messageIdsOldestFirst: [], messagesById: {}, messagesMap: {}, reducerState,
                        latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 1, isLoaded: true,
                    },
                },
            }));
            const activeSession = createSessionFixture({ id: sessionId, serverId: activeHome.id, latestUsage: fallbackUsage });
            const otherSession = createSessionFixture({ id: sessionId, serverId: otherHome.id, latestUsage: fallbackUsage });

            const activeHook = await renderHook(() => useSessionUsage(sessionId, {
                serverId: activeHomeIdentity,
                session: activeSession,
            }));
            expect(activeHook.getCurrent()).toEqual(liveUsage);
            await activeHook.unmount();

            const otherHook = await renderHook(() => useSessionUsage(sessionId, {
                serverId: otherHome.id,
                session: otherSession,
            }));
            expect(otherHook.getCurrent()).toEqual(fallbackUsage);
            await otherHook.unmount();
        } finally {
            storage.setState(previousState);
            if (previousActiveServerId) await setActiveServerId(previousActiveServerId, { scope: 'device' });
            await removeServerProfile(activeHome.id);
            await removeServerProfile(otherHome.id);
        }
    });
});
