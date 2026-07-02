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

const agentCatalogMocks = vi.hoisted(() => {
    const resolveAgentIdFromFlavor = (flavor: unknown) => {
        if (flavor === 'claude') return 'claude';
        if (flavor === 'codex') return 'codex';
        if (flavor === 'pi') return 'pi';
        return null;
    };
    const getAgentCore = (agentId: string) => ({
        id: agentId,
        model: {
            defaultMode: 'default',
            supportsSelection: false,
        },
        resume: {},
        runtimeInput: {
            inFlightSteerSupported: agentId === 'pi',
        },
    });
    return { getAgentCore, resolveAgentIdFromFlavor };
});

vi.mock('@/agents/registry/registryCore', () => ({
    AGENT_IDS: ['claude', 'codex', 'pi'],
    CANONICAL_AGENT_IDS: ['claude', 'codex', 'pi'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: agentCatalogMocks.getAgentCore,
    resolveAgentIdFromFlavor: agentCatalogMocks.resolveAgentIdFromFlavor,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: agentCatalogMocks.getAgentCore,
    isAgentId: (agentId: unknown) => typeof agentId === 'string' && ['claude', 'codex', 'pi'].includes(agentId),
    resolveAgentIdFromFlavor: agentCatalogMocks.resolveAgentIdFromFlavor,
    resolveAgentIdFromSessionMetadata: (metadata: Record<string, unknown> | null | undefined) =>
        agentCatalogMocks.resolveAgentIdFromFlavor(metadata?.flavor),
    buildWakeResumeExtras: ({ session }: { session?: Session | null }) => {
        const connectedServices = session?.metadata?.connectedServices;
        return connectedServices ? { connectedServices } : {};
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
import type { Machine, Session } from './domains/state/storageTypes';
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

function createMachine(params: {
    id: string;
    active?: boolean;
    replacedByMachineId?: string | null;
    replacedAt?: number | null;
}): Machine {
    const now = Date.now();
    return {
        id: params.id,
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: params.active ?? true,
        activeAt: now,
        metadata: {
            host: params.id,
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/tmp/happier',
            homeDir: '/Users/test',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        replacedByMachineId: params.replacedByMachineId ?? null,
        replacedAt: params.replacedAt ?? null,
    };
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
        const connectedServices = {
            v: 1,
            bindingsByServiceId: {
                anthropic: { source: 'connected', selection: 'profile', profileId: 'claude-work' },
            },
        } as const;
        storage.getState().applySessions([{
            ...createPlainSession({ sessionId }),
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'claude',
                connectedServices,
            } as any,
        }]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getMachineEncryption: () => ({}),
        };

        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 37,
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
                initialTranscriptAfterSeq: 36,
                connectedServices,
            }),
        );
    });

    it('wakes the replacement machine when inactive session metadata points at a stale machine', async () => {
        const sessionId = 's_replaced_machine';
        storage.getState().applyMachines([
            createMachine({
                id: 'm-old',
                active: false,
                replacedByMachineId: 'm-new',
                replacedAt: Date.now(),
            }),
            createMachine({ id: 'm-new', active: true }),
        ], true);
        storage.getState().applySessions([{
            ...createPlainSession({ sessionId }),
            metadata: {
                machineId: 'm-old',
                path: '/tmp/project',
                flavor: 'codex',
                codexSessionId: 'codex-1',
            } as any,
        }]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getMachineEncryption: () => ({}),
        };

        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async () => ({
                ok: true,
                id: 'm1',
                seq: 37,
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
                machineId: 'm-new',
                directory: '/tmp/project',
                initialTranscriptAfterSeq: 36,
            }),
        );
    });

    it('rejects submitMessage when the session cannot be hydrated instead of falling back to direct send', async () => {
        const sessionId = 's_missing_pending_submit';
        storage.getState().applySettings({
            ...storage.getState().settings,
            sessionMessageSendMode: 'server_pending',
        }, 1);

        const { sync } = await import('./sync');
        const sendMessageSpy = vi.spyOn(sync, 'sendMessage').mockRejectedValue(new Error('direct fallback should not run'));
        vi.spyOn(apiSocket, 'request').mockRejectedValue(new Error('session unavailable'));

        await expect(sync.submitMessage(sessionId, 'should stay queued')).rejects.toThrow(/session.*not.*available|session.*not.*found/i);

        expect(sendMessageSpy).not.toHaveBeenCalled();
    });
});
