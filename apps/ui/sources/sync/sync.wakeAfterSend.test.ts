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
        getAllKeys() {
            return [...kvStore.keys()];
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

vi.mock('@/voice/registry/generatedBundledVoiceEntries', () => ({
    BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES: Object.freeze([]),
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
        cli: {
            spawnAgent: agentId,
        },
        permissions: {
            promptProtocol: agentId === 'codex' ? 'codexDecision' : 'claude',
        },
        sessionStorage: {
            server: true,
            direct: true,
        },
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
    resolveAgentIdFromSessionMetadata: (metadata: Record<string, unknown> | null | undefined) =>
        agentCatalogMocks.resolveAgentIdFromFlavor(metadata?.flavor),
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

const resumeSessionSpy = vi.hoisted(() =>
    vi.fn<(..._args: unknown[]) => Promise<unknown>>(async () => ({ type: 'success' as const })),
);
vi.mock('@/sync/ops', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops')>();
    return {
        ...actual,
        resumeSession: (...args: unknown[]) => resumeSessionSpy(...args),
    };
});

import { storage } from './domains/state/storage';
import type { Machine, Session } from './domains/state/storageTypes';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { getActiveServerAccountScope } from './domains/scope/activeServerAccountScope';
import { readPersistedSessionViewport } from './domains/state/sessionViewportPersistence';
import { currentPendingEnqueueAck } from './engine/pending/pendingQueueV2.testHelpers';

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
        storage.getState().activateProfileScope({
            serverId: getActiveServerSnapshot().serverId,
            accountId: 'wake-after-send-account',
        });
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({
            serverId: getActiveServerSnapshot().serverId,
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {},
                    capabilities: {
                        compatibility: {
                            v: 1,
                            sessionSync: {
                                v: 1,
                                enforcement: 'observe',
                                minimumSessionSyncProtocolVersion: 2,
                                currentSessionSyncProtocolVersion: 2,
                                declarationTransport: 'headers-v1',
                            },
                            pendingInput: { currentPendingInputProtocolVersion: 1 },
                        },
                    },
                }),
            },
        });
        storage.getState().applySettings(settingsParse({
            ...storage.getState().settings,
            codexBackendMode: 'appServer',
        }), 1);
        kvStore.clear();
        appStateAddListener.mockClear();
        resumeSessionSpy.mockClear();
    });

    afterEach(() => {
        resetServerFeaturesClientForTests();
        vi.restoreAllMocks();
    });

    it('clears detached restore state before the first optimistic mutation for an own send without SessionView', async () => {
        const sessionId = 's_cross_mount_own_send';
        storage.getState().applySessions([createPlainSession({ sessionId })]);

        const { sync } = await import('./sync');
        sync.onSessionViewportChange(sessionId, {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: {
                kind: 'message',
                messageId: 'message-1',
                seq: 1,
                itemId: 'msg:message-1',
                itemOffsetPx: 12,
                capturedAtMs: 1_000,
            },
        });
        expect(readPersistedSessionViewport(sessionId, getActiveServerAccountScope())).toMatchObject({
            isPinned: false,
            offsetY: 420,
        });

        const markLiveTailIntent = vi.spyOn(sync, 'markSessionLiveTailIntent');
        const originalMarkOptimisticThinking = storage.getState().markSessionOptimisticThinking;
        const markOptimisticThinking = vi
            .spyOn(storage.getState(), 'markSessionOptimisticThinking')
            .mockImplementation((candidateSessionId) => {
                expect(candidateSessionId).toBe(sessionId);
                expect(markLiveTailIntent).toHaveBeenCalledTimes(1);
                expect(sync.getSessionViewport(sessionId)).toMatchObject({
                    isPinned: true,
                    offsetY: 0,
                    source: 'default',
                    anchor: null,
                });
                expect(readPersistedSessionViewport(sessionId, getActiveServerAccountScope())).toBeNull();
                originalMarkOptimisticThinking(candidateSessionId);
            });

        sync.setMessageTransport({
            // Boundary fixture: this transport only needs to acknowledge the accepted submit.
            emitWithAck: vi.fn(async (_event: string, payload: { localId: string }) => ({
                ok: true,
                id: 'message-1',
                seq: 1,
                localId: payload.localId,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'first prompt before SessionView mounts');

        expect(markLiveTailIntent).toHaveBeenCalledTimes(1);
        expect(markLiveTailIntent.mock.invocationCallOrder[0]).toBeLessThan(
            markOptimisticThinking.mock.invocationCallOrder[0]!,
        );
    });

    it('wakes the daemon after sending a message via the server commit path', async () => {
        const sessionId = 's_test';
        const connectedServices = {
            v: 1,
            bindingsByServiceId: {
                openai: { source: 'connected', selection: 'profile', profileId: 'openai-work' },
            },
        } as const;
        const runtimeDescriptorV1 = {
            v: 1,
            agentId: 'codex',
            agent: {
                backendMode: 'appServer',
                providerSessionId: 'codex-1',
            },
        } as const;
        storage.getState().applySessions([{
            ...createPlainSession({ sessionId }),
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'codex',
                codexSessionId: 'codex-1',
                connectedServices,
                connectedServicesUpdatedAt: 12345,
                runtimeDescriptorV1,
            } as any,
        }]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getMachineEncryption: () => ({}),
        };

        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async (_event: string, payload: { localId: string }) => ({
                ok: true,
                id: 'm1',
                seq: 37,
                localId: payload.localId,
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
                connectedServicesUpdatedAt: 12345,
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    agent: {
                        backendMode: 'appServer',
                        providerSessionId: 'codex-1',
                    },
                },
                resume: 'codex-1',
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
            emitWithAck: vi.fn(async (_event: string, payload: { localId: string }) => ({
                ok: true,
                id: 'm1',
                seq: 37,
                localId: payload.localId,
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

    it('rejects direct sends to inactive replay forks that cannot resume before creating local or server state', async () => {
        const sessionId = 's_consumed_replay_fork';
        storage.getState().applySessions([{
            ...createPlainSession({ sessionId }),
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'claude',
                claudeSessionId: '',
                forkV1: {
                    v: 1,
                    parentSessionId: 'parent-session',
                    parentCutoffSeqInclusive: 7,
                    createdAtMs: 1000,
                    strategy: 'replay',
                    providerHint: { providerId: 'claude' },
                },
                replaySeedV1: {
                    v: 1,
                    seedText: '',
                    sourceSessionId: 'parent-session',
                    sourceCutoffSeqInclusive: 7,
                    createdAtMs: 1000,
                    appliedToLocalId: 'local-1',
                    appliedAtMs: 2000,
                },
            } as any,
        }]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getMachineEncryption: () => ({}),
        };

        const rpcSpy = vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 37,
            localId: null,
            didWrite: true,
        }));
        sync.setMessageTransport({
            emitWithAck: emitWithAck as any,
            send: vi.fn(),
        });

        await expect(sync.sendMessage(sessionId, 'do not strand me')).rejects.toMatchObject({
            code: 'SESSION_NOT_RESUMABLE',
        });

        expect(rpcSpy).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(resumeSessionSpy).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]).toBeUndefined();
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

    it('rejects submitMessage when pending enqueue succeeds but wake fails', async () => {
        const sessionId = 's_pending_submit_wake_failed';
        storage.getState().applySettings({
            ...storage.getState().settings,
            sessionMessageSendMode: 'server_pending',
        }, 1);
        storage.getState().applyMachines([createMachine({ id: 'm1', active: true })], true);
        storage.getState().applySessions([{
            ...createPlainSession({ sessionId }),
            pendingVersion: 2,
        }]);
        resumeSessionSpy.mockResolvedValueOnce({
            type: 'error',
            errorCode: 'DAEMON_RPC_UNAVAILABLE',
            errorMessage: 'Daemon RPC is not available',
        });

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
            getMachineEncryption: () => ({}),
        };
        vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) =>
            currentPendingEnqueueAck(init));

        await expect(sync.submitMessage(sessionId, 'should report wake failure')).rejects.toThrow('Daemon RPC is not available');
        expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
    });

    it('routes force-immediate submitMessage through durable enqueue with send-now action ownership', async () => {
        const sessionId = 's_force_immediate_submit';
        storage.getState().applySettings({
            ...storage.getState().settings,
            sessionMessageSendMode: 'agent_queue',
        }, 1);
        storage.getState().applySessions([{
            ...createPlainSession({ sessionId }),
            active: true,
            pendingVersion: 2,
            thinking: false,
            thinkingAt: 0,
        }]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
            getMachineEncryption: () => ({}),
        };
        const pendingPost = vi.spyOn(apiSocket, 'request').mockResolvedValue(new Response('{}', { status: 200 }));
        const sessionRpc = vi.spyOn(apiSocket, 'sessionRPC');
        const directSend = vi.spyOn(sync, 'sendMessage');

        await expect(sync.submitMessage(sessionId, 'durable now', undefined, undefined, {
            callerSurface: 'sync_submit_message',
            forceImmediate: true,
        })).resolves.toBeUndefined();

        expect(pendingPost).toHaveBeenCalledTimes(1);
        const localId = storage.getState().sessionPending[sessionId]?.messages[0]?.localId;
        expect(localId).toEqual(expect.any(String));
        expect(pendingPost).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending`,
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"requestedAction":{"v":1,"kind":"send_now"}'),
            }),
        );
        expect(sessionRpc).not.toHaveBeenCalled();
        expect(directSend).not.toHaveBeenCalled();
    });
});
