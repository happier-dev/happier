import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            AppState: {
                                                addEventListener: vi.fn(() => ({ remove: vi.fn() })) as any,
                                            },
                                        }
    );
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/sync/runtime/orchestration/projectManager', () => ({
    projectManager: {
        updateSessions: vi.fn(),
    },
}));

import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import { createReducer } from './reducer/reducer';

const initialStorageState = storage.getState();

function createSession(sessionId: string): Session {
    const now = Date.now();
    return {
        id: sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

describe('sync: voice permission request announcements', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        storage.setState((state) => {
            const messagesById: Record<string, any> = {};
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    s1: {
                        messageIdsOldestFirst: [],
                        messagesById,
                        messagesMap: messagesById,
                        reducerState: createReducer(),
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 0,
                        isLoaded: true,
                    },
                },
            };
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('applies pending permission requests to the loaded transcript when agentStateVersion advances (no voice side effects asserted here)', async () => {
        const { sync } = await import('./sync');

        (sync as any).applySessions([createSession('s1')]);

        (sync as any).applySessions([{
            ...createSession('s1'),
            updatedAt: Date.now() + 1,
            agentStateVersion: 1,
            agentState: {
                requests: {
                    req1: {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 123,
                    },
                },
            },
        } as any]);

        const stateAny: any = storage.getState();
        const messageIds = stateAny?.sessionMessages?.s1?.messageIdsOldestFirst ?? [];
        expect(messageIds.length).toBe(1);

        const msg = stateAny?.sessionMessages?.s1?.messagesMap?.[messageIds[0]] ?? null;
        expect(msg?.kind).toBe('tool-call');
        expect(msg?.tool?.permission?.status).toBe('pending');
    });
});
