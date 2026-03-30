import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
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

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            Platform: {
                                OS: 'web',
                            },
                            AppState: {
                                addEventListener: appStateAddListener as any,
                            },
                        }
    );
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

const resumeSessionSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ type: 'success' as const })));
vi.mock('@/sync/ops', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops')>();
    return {
        ...actual,
        resumeSession: (...args: unknown[]) => resumeSessionSpy(...args),
    };
});

import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const initialStorageState = storage.getState();

function createPlainSession(params: { sessionId: string }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: false,
        activeAt: now,
        metadata: {
            machineId: 'm1',
            path: '/tmp/project',
            flavor: 'codex',
            codexSessionId: 'codex-1',
        } as any,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        encryptionMode: 'plain',
    } as any;
}

function createRpcMethodNotAvailableError(): RpcError {
    return new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
}

describe('sync.sendMessage wake-after-send', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        kvStore.clear();
        appStateAddListener.mockClear();
        resumeSessionSpy.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('wakes the daemon after sending a message via the server commit path', async () => {
        const sessionId = 's_test';
        storage.getState().applySessions([createPlainSession({ sessionId })]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getMachineEncryption: () => ({}),
        };

        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 1,
                localId: null,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello');

        expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
        expect(resumeSessionSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                machineId: 'm1',
                directory: '/tmp/project',
            }),
        );
    });
});
