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
    const actual = await vi.importActual<any>('react-native');
    return {
        ...actual,
        Platform: { ...(actual?.Platform ?? {}), OS: 'web' },
        AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) as any },
    };
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sendTextMessage = vi.hoisted(() => vi.fn());
vi.mock('@/realtime/RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => 's1',
    getVoiceSession: () => ({ sendTextMessage }),
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
        sendTextMessage.mockClear();
        storage.setState((state) => ({
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                s1: {
                    messages: [],
                    messagesMap: {},
                    reducerState: createReducer(),
                    isLoaded: true,
                },
            },
        }));
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('announces newly-seen permission requests when agentStateVersion increases for the visible session', async () => {
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

        expect(sendTextMessage).toHaveBeenCalledTimes(1);
        expect(String(sendTextMessage.mock.calls[0]?.[0] ?? '')).toMatch(/Bash/);
    });
});

