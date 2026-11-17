import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import {
    getActiveServerId,
    removeServerProfile,
    setActiveServerId,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { createReducer } from '@happier-dev/session-core/reducer';

import { useInstrumentStripModel } from './useInstrumentStripModel';

afterEach(standardCleanup);

describe('instrument strip exact Home usage', () => {
    it('keeps live active-Home usage while refusing a same-id transcript from another Home', async () => {
        const previousState = storage.getState();
        const previousActiveServerId = getActiveServerId();
        const activeHome = await upsertServerProfile({ serverUrl: 'https://instrument-active.example.test' });
        const targetHome = await upsertServerProfile({ serverUrl: 'https://instrument-target.example.test' });
        const sessionId = 'same-session-instrument';
        const liveUsage = {
            inputTokens: 40,
            outputTokens: 10,
            cacheCreation: 0,
            cacheRead: 0,
            contextSize: 50,
            contextSnapshot: {
                v: 1 as const,
                modelId: null,
                usedTokens: 50,
                windowTokens: 200,
                totalProcessedTokens: null,
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
            reducerState.latestUsage = liveUsage;
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [sessionId]: createSessionFixture({ id: sessionId, serverId: activeHome.id, latestUsage: liveUsage }),
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
            const activeHook = await renderHook(() => useInstrumentStripModel({
                sessionId, serverId: activeHome.id, agentId: null, metadata: null,
            }));
            expect(activeHook.getCurrent().context?.usedPct).toBe(25);
            await activeHook.unmount();

            const targetHook = await renderHook(() => useInstrumentStripModel({
                sessionId, serverId: targetHome.id, agentId: null, metadata: null,
            }));
            expect(targetHook.getCurrent().context).toBeNull();
            const targetUsage = {
                ...liveUsage,
                contextSize: 80,
                contextSnapshot: { ...liveUsage.contextSnapshot, usedTokens: 80 },
            };
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        [sessionId]: createSessionFixture({ id: sessionId, serverId: targetHome.id, latestUsage: targetUsage }),
                    },
                }));
            });
            expect(targetHook.getCurrent().context?.usedPct).toBe(40);
            await targetHook.unmount();
        } finally {
            await standardCleanup();
            storage.setState(previousState);
            if (previousActiveServerId) await setActiveServerId(previousActiveServerId, { scope: 'device' });
            await removeServerProfile(activeHome.id);
            await removeServerProfile(targetHome.id);
        }
    });
});
