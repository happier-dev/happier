import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionUsage } from '@/sync/store/hooks';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { normalizeRawMessage } from '@/sync/typesRaw';

afterEach(() => {
    standardCleanup();
});

describe('useSessionUsage context snapshot integration', () => {
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
});
