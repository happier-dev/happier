import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

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
    BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS: Object.freeze([]),
    BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS: Object.freeze([]),
}));

// Socket.IO is the daemon boundary; scoped Home admission and RPC serialization stay real.
const machineRpcSpy = vi.hoisted(() =>
    vi.fn<(..._args: unknown[]) => Promise<unknown>>(async () => ({ type: 'success' as const })),
);
vi.mock('socket.io-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    const { RPC_METHODS, RPC_ERROR_CODES } = await import('@happier-dev/protocol/rpc');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
    return {
        ...actual,
        io: (serverUrl: string, options: { auth?: { token?: string } }) => {
            const { socket } = createSocketIoBoundaryStub();
            socket.emitWithAck.mockImplementation(async (event, payload) => {
                if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object') {
                    return { v: 1, ok: true, admittedSessionIds: [] };
                }
                const request = payload as { method: string; params: unknown };
                const separator = request.method.indexOf(':');
                const method = request.method.slice(separator + 1);
                if (method !== RPC_METHODS.SPAWN_HAPPY_SESSION
                    && method !== RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                    return { ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
                }
                return { ok: true, result: await machineRpcSpy({
                    machineId: request.method.slice(0, separator),
                    payload: request.params,
                    serverUrl,
                    token: options.auth?.token,
                }) };
            });
            return socket;
        },
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
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { getActiveServerAccountScope } from './domains/scope/activeServerAccountScope';
import {
    captureActiveServerAccountScopeLifetime,
    retireActiveServerAccountScopeLifetime,
} from './domains/scope/activeServerAccountScope';
import { readPersistedSessionViewport } from './domains/state/sessionViewportPersistence';
import { activatePendingQueueScope, currentPendingEnqueueAck } from './engine/pending/pendingQueueV2.testHelpers';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { loadPendingOutboxForSession } from '@/sync/domains/state/pendingOutboxPersistence';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import type { SessionSubmitPort } from '@/sync/domains/session/input/types';
import { recordMachineRequestFailed, recordMachineRequestSucceeded, clearMachineRequestReachabilityForTest } from '@/sync/domains/machines/reachability/machineReachability';

// Sync initializes native Markdown bindings, but these transport tests never render them.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown rendering in Sync test'); },
}));

const initialStorageState = storage.getState();

function createPlainSession(params: { sessionId: string }): Session {
    const now = Date.now();
    return createSessionFixture({
        id: params.sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: false,
        activeAt: now,
        metadata: {
            machineId: 'm1',
            path: '/tmp/project',
            host: 'test.local',
            homeDir: '/Users/test',
            flavor: 'codex',
            codexSessionId: 'codex-1',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        encryptionMode: 'plain',
    });
}

function createMachine(params: {
    id: string;
    active?: boolean;
    replacedByMachineId?: string | null;
    replacedAt?: number | null;
}): Machine {
    const now = Date.now();
    return createMachineFixture({
        id: params.id,
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: params.active ?? true,
        storageMode: 'plain',
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
    });
}

function createRpcMethodNotAvailableError(): RpcError {
    return new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
}

describe('sync.sendMessage wake-after-send', () => {
    it('uses exact Account request reachability in the real Sync submit port', async () => {
        const { sync } = await import('./syncEngine');
        // Test-only access to the incumbent factory; its production caller is submitMessage.
        const submitOwner = sync as unknown as { createSessionSubmitPort(): SessionSubmitPort };
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime).not.toBeNull();
        if (!accountLifetime) throw new Error('Missing test Account lifetime');
        const machine = createMachine({ id: 'submit-reachability' });
        storage.setState({ machines: { [machine.id]: machine } });
        const port = submitOwner.createSessionSubmitPort();
        const options = { serverId: accountLifetime.scope.serverId, accountLifetime };
        try {
            expect(port.isMachineReachable?.(machine.id, options)).toBe(true);
            recordMachineRequestFailed({ ...accountLifetime.scope, machineId: machine.id });
            expect(port.isMachineReachable?.(machine.id, options)).toBe(false);
            storage.setState({ machines: { [machine.id]: { ...machine, activeAt: Date.now() + 1 } } });
            expect(port.isMachineReachable?.(machine.id, options)).toBe(false);
            recordMachineRequestSucceeded({ ...accountLifetime.scope, machineId: machine.id });
            expect(port.isMachineReachable?.(machine.id, options)).toBe(true);
        } finally { clearMachineRequestReachabilityForTest(); }
    });
    beforeEach(async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        storage.setState(initialStorageState, true);
        kvStore.clear();
        const activeScope = {
            serverId: getActiveServerSnapshot().serverId,
            accountId: 'wake-after-send-account',
        };
        // App entry loads the Sync implementation before applying the selected Home.
        await loadSyncSingletonForTests();
        const { sync } = await import('./syncEngine');
        await activatePendingQueueScope(activeScope);
        // These direct Sync tests bypass restore; bind its applied transport and Account.
        Reflect.set(sync, 'appliedServerTarget', getActiveServerSnapshot());
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        Reflect.set(sync, 'serverID', activeScope.accountId);
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({
            serverId: getActiveServerSnapshot().serverId,
            snapshot: {
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: {},
                    capabilities: {
                        session: {
                            runtimeActivity: { protocolVersion: 2 },
                            pendingInput: { protocolVersion: 1 },
                        },
                    },
                }),
            },
        });
        storage.getState().applySettings(settingsParse({
            ...storage.getState().settings,
            codexBackendMode: 'appServer',
        }), 1);
        appStateAddListener.mockClear();
        machineRpcSpy.mockReset();
        machineRpcSpy.mockResolvedValue({ type: 'success' });
        const token = `e30.${Buffer.from(JSON.stringify({ sub: activeScope.accountId })).toString('base64url')}.signature`;
        Reflect.set(sync, 'credentials', { token });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/auth/ping') return Response.json({});
            const machineRow = (machine: Machine) => ({
                ...createPlainMachineRowFixture({ id: machine.id, accountId: activeScope.accountId }),
                active: machine.active,
                activeAt: machine.activeAt,
                revokedAt: machine.revokedAt ?? null,
                replacedByMachineId: machine.replacedByMachineId ?? null,
            });
            if (path === '/v1/machines') {
                const machines = Object.values(storage.getState().machines);
                return Response.json((machines.length > 0 ? machines : [createMachine({ id: 'm1' })]).map(machineRow));
            }
            // Exact Machine reads answer from the same Home rows as the census, so a replaced Machine reads as replaced.
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body, id => {
                const machine = storage.getState().machines[id];
                return machine ? machineRow(machine) : createPlainMachineRowFixture({ id, accountId: activeScope.accountId });
            });
            const machineResponse = createPlainMachineReadHttpResponseFixture(path, init, activeScope.accountId);
            if (machineResponse) return machineResponse;
            return Response.json({}, { status: 404 });
        });
    });

    afterEach(async () => {
        const { sync } = await import('./sync');
        sync.disconnectServer();
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        resetRuntimeFetch();
        vi.unstubAllGlobals();
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
        // The committed prompt starts a real background daemon wake. Observe its
        // boundary before cleanup so it cannot complete in the next test's scope.
        await vi.waitFor(() => expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ sessionId }),
        })));
    });

    it('holds the user-request lease for the whole send, so a tab hidden mid-send tears down only after the send settles', async () => {
        const sessionId = 's_lease';
        storage.getState().applySessions([{ ...createPlainSession({ sessionId }),
            metadata: { machineId: 'm1', path: '/tmp/project', flavor: 'codex' } as any }]);
        const { sync } = await import('./sync');
        const { userRequestLeaseOwner } = await import('@/sync/runtime/connectivity/userRequestLease');
        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        const teardown = vi.fn();
        let deferredAtHide: boolean | null = null;
        sync.setMessageTransport({
            emitWithAck: vi.fn(async (_event: string, payload: { localId: string }) => {
                // The tab is hidden while the send is on the wire (a routine background report).
                deferredAtHide = userRequestLeaseOwner.deferRoutineTeardown(teardown);
                expect(teardown).not.toHaveBeenCalled();
                return { ok: true, id: 'm1', seq: 37, localId: payload.localId, didWrite: true };
            }) as any,
            send: vi.fn(),
        });
        try {
            await sync.sendMessage(sessionId, 'hello');
            expect(deferredAtHide).toBe(true);
            expect(teardown).toHaveBeenCalledTimes(1);
        } finally {
            userRequestLeaseOwner.cancelDeferredRoutineTeardown();
        }
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

        await vi.waitFor(() => expect(machineRpcSpy).toHaveBeenCalledTimes(1));
        expect(machineRpcSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                machineId: 'm1',
                payload: expect.objectContaining({
                    sessionId,
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

        await vi.waitFor(() => expect(machineRpcSpy).toHaveBeenCalledTimes(1));
        expect(machineRpcSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                machineId: 'm-new',
                payload: expect.objectContaining({
                    sessionId,
                    directory: '/tmp/project',
                    initialTranscriptAfterSeq: 36,
                }),
            }),
        );
    });

    it('threads exact Account authority into post-commit wake and rejects a replaced exact target', async () => {
        const sessionId = 's_exact_wake';
        const activeServerId = getActiveServerSnapshot().serverId;
        const exactSession: Session = {
            ...createPlainSession({ sessionId }),
            serverId: activeServerId,
            metadata: {
                machineId: 'm-exact',
                path: '/exact/project',
                flavor: 'codex',
                codexSessionId: 'codex-exact',
            } as any,
        };
        storage.getState().applyMachines([
            createMachine({ id: 'm-exact', active: false }),
            createMachine({ id: 'm-ambient', active: true }),
        ], true);
        storage.getState().applySessions([exactSession]);
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime).not.toBeNull();

        const { sync } = await import('./sync');
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

        await sync.sendMessage(sessionId, 'hello', undefined, undefined, {
            serverId: activeServerId,
            accountLifetime: accountLifetime!,
            session: exactSession,
        });

        await vi.waitFor(() => expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm-exact',
            serverUrl: getActiveServerSnapshot().serverUrl,
            token: `e30.${Buffer.from(JSON.stringify({ sub: accountLifetime!.scope.accountId })).toString('base64url')}.signature`,
            payload: expect.objectContaining({ sessionId, directory: '/exact/project' }),
        })));
        const callsBeforeReplacement = machineRpcSpy.mock.calls.length;
        storage.getState().applyMachines([
            createMachine({ id: 'm-exact', active: false, replacedByMachineId: 'm-ambient' }),
            createMachine({ id: 'm-ambient', active: true }),
        ], true);
        const { getPendingQueueWakeResumeOptions } = await import('./domains/pending/pendingQueueWake');
        const { ensureSessionRuntimeForPendingInput } = await import('./ops/sessions');
        const resumeOptions = getPendingQueueWakeResumeOptions({ sessionId, session: exactSession, resumeCapabilityOptions: {},
            resumeTargetOverride: { machineId: 'm-exact', directory: '/exact/project' } });
        if (!resumeOptions) throw new Error('Expected a resumable exact Session');
        await expect(ensureSessionRuntimeForPendingInput({ ...resumeOptions,
            serverId: activeServerId, accountLifetime: accountLifetime!,
        })).resolves.toMatchObject({ type: 'error' });
        expect(machineRpcSpy).toHaveBeenCalledTimes(callsBeforeReplacement);
        retireActiveServerAccountScopeLifetime();
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
        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]).toBeUndefined();
    });

    it('rejects submitMessage when the session cannot be hydrated instead of falling back to direct send', async () => {
        const sessionId = 's_missing_pending_submit';
        storage.getState().applySettings({
            ...storage.getState().settings,
            sessionMessageSendMode: 'server_pending',
        }, 1);

        const { sync } = await import('./sync');
        sync.resetMessageTransport();
        const emitWithAck = vi.spyOn(apiSocket, 'emitWithAck');
        const send = vi.spyOn(apiSocket, 'send');
        const requestSpy = vi.spyOn(apiSocket, 'request').mockRejectedValue(new Error('session unavailable'));

        await expect(sync.submitMessage(sessionId, 'should stay queued')).rejects.toThrowError(new Error('request_failed'));

        expect(requestSpy).toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(storage.getState().sessionPending[sessionId]).toBeUndefined();
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
        machineRpcSpy.mockResolvedValueOnce({
            type: 'error',
            errorCode: 'DAEMON_RPC_UNAVAILABLE',
            errorMessage: 'Daemon RPC is not available',
        });

        const { sync } = await import('./sync');
        vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) =>
            currentPendingEnqueueAck(init));

        await expect(sync.submitMessage(sessionId, 'should report wake failure')).rejects.toThrow('Daemon RPC is not available');
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects an unsupported Voice submit to a resolver-confirmed remote target before persistence or active transport', async () => {
        const sessionId = 's_remote_voice_old_pending';
        const remoteServerId = 'remote-voice-old-pending';
        const remoteSession: Session = {
            ...createPlainSession({ sessionId }),
            serverId: remoteServerId,
            active: true,
            pendingVersion: 2,
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                host: 'test-host',
                flavor: 'codex',
                version: '0.0.1',
                codexSessionId: 'codex-1',
            },
        };
        storage.getState().applySessions([remoteSession]);

        const { sync } = await import('./sync');
        expect(resolvePreferredServerIdForSessionId(sessionId)).toBe(remoteServerId);
        expect(sync.isSessionTargetRemoteToActiveServer(sessionId)).toBe(true);

        const directSend = vi.spyOn(sync, 'sendMessage').mockRejectedValue(
            new Error('active direct transport must not run'),
        );
        const pendingPost = vi.spyOn(apiSocket, 'request').mockRejectedValue(
            new Error('Pending POST must not run'),
        );

        await expect(sync.submitMessage(sessionId, 'do not misroute', undefined, undefined, {
            callerSurface: 'voice_turn',
            forceImmediate: true,
            hostAdmissionOrigin: 'voice',
        })).rejects.toMatchObject({
            code: 'session_input_target_update_required',
        });

        expect(directSend).not.toHaveBeenCalled();
        expect(pendingPost).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]).toBeUndefined();
    });

    it('keeps the exact Account lifetime through submitMessage and reports acknowledged custody after retirement', async () => {
        const sessionId = 's_submit_exact_retirement';
        storage.getState().applySessions([{ ...createPlainSession({ sessionId }), active: true, pendingVersion: 2 }]);
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime).not.toBeNull();
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `e30.${Buffer.from(JSON.stringify({ sub: accountLifetime!.scope.accountId })).toString('base64url')}.signature`,
        });
        const { sync } = await import('./sync');
        const onOutboundHandoff = vi.fn();
        // Exact Account requests resolve their own authenticated HTTP transport.
        let didAcknowledgeEnqueue = false;
        setRuntimeFetch(async (url, init) => {
            if (String(url).endsWith('/v1/auth/ping')) {
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            expect(init?.method).toBe('POST');
            const response = currentPendingEnqueueAck(init);
            didAcknowledgeEnqueue = true;
            retireActiveServerAccountScopeLifetime();
            return response;
        });

        await expect(sync.submitMessage(sessionId, 'review draft', undefined, undefined, {
            accountLifetime: accountLifetime!, onOutboundHandoff,
        })).rejects.toMatchObject({ code: 'session_account_scope_retired' });
        expect(didAcknowledgeEnqueue).toBe(true);
        expect(onOutboundHandoff).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('accepted');
    });

    it('cancels pending Composer preparation before enqueue when the sending view retires, then permits retry', async () => {
        const sessionId = 's_composer_view_cancellation';
        storage.getState().applySessions([{ ...createPlainSession({ sessionId }), active: true, pendingVersion: 2 }]);
        const attachment = {
            v: 1, instanceId: 'issue-42', attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42', value: {}, presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const controller = new AbortController();
        let requestSignal: AbortSignal | undefined;
        const rpc = vi.spyOn(apiSocket, 'sessionRPC').mockImplementation(async (_id, method, _payload, options) => {
            if (method !== SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1) return { ok: true };
            requestSignal = options?.signal;
            return new Promise((_resolve, reject) => requestSignal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
        });
        const request = vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) => currentPendingEnqueueAck(init));
        const { sync } = await import('./sync');
        const input = { happierStructuredInputV1: { v: 1, composerAttachments: [attachment] } };
        const submit = sync.enqueuePendingMessage(sessionId, 'queue', undefined, input, { localId: 'cancelled-composer', signal: controller.signal });
        const settlement = submit.catch(error => error);
        await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
        controller.abort();
        expect(requestSignal?.aborted).toBe(true);
        await expect(settlement).resolves.toMatchObject({ name: 'AbortError' });
        expect(request).not.toHaveBeenCalled();
        rpc.mockImplementation(async (_id, method) => method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1
            ? { ok: true, text: 'queue', structuredInput: input.happierStructuredInputV1, stagedMediaHandles: [] } : { ok: true });
        await expect(sync.enqueuePendingMessage(sessionId, 'queue', undefined, input, { localId: 'cancelled-composer', signal: new AbortController().signal }))
            .resolves.toMatchObject({ accepted: true });
    });

    it('retires background Composer settlement on a Home credential change while preserving accepted Pending custody', async () => {
        const sessionId = 's_composer_settlement_retirement';
        storage.getState().applySessions([{ ...createPlainSession({ sessionId }), active: true, pendingVersion: 2 }]);
        const attachment = {
            v: 1, instanceId: 'issue-42', attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42', value: {}, presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const structuredInput = { v: 1, composerAttachments: [attachment] };
        let settlementIssued = false;
        let settlementSignal: AbortSignal | undefined;
        vi.spyOn(apiSocket, 'sessionRPC').mockImplementation(async (_id, method, _payload, options) => {
            if (method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1)
                return { ok: true, text: 'queue', structuredInput, stagedMediaHandles: [] };
            settlementIssued = true;
            settlementSignal = options?.signal;
            return new Promise((_resolve, reject) => settlementSignal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
        });
        vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) => currentPendingEnqueueAck(init));
        const { sync } = await import('./sync');
        const submit = sync.enqueuePendingMessage(sessionId, 'queue', undefined, { happierStructuredInputV1: structuredInput }, { localId: 'settlement-local' });
        await vi.waitFor(() => expect(settlementIssued).toBe(true));
        const active = getActiveServerSnapshot();
        expect(await TokenStorage.setCredentialsForServerUrl(active.serverUrl, { serverId: active.serverId }, {
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'replacement-account' })).toString('base64url')}.signature`,
        })).toBe(true);
        expect(settlementSignal?.aborted).toBe(true);
        await expect(submit).resolves.toMatchObject({ accepted: true });
    });

    it.each([
        [true, null], [false, null], [true, 'prepare'], [true, 'enqueue'],
    ] as const)('prepares typed Queue attachments and fences settlement (reachable=%s, retiredAt=%s)', async (reachable, retiredAt) => {
        const sessionId = `s_typed_queue_${reachable}_${retiredAt}`;
        storage.getState().applySessions([{ ...createPlainSession({ sessionId }), active: true, pendingVersion: 2 }]);
        const attachment = {
            v: 1, instanceId: 'issue-42', attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42', value: { issueId: 42 }, presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const preparedAttachment = { ...attachment, value: { issueId: 42, prepared: true } };
        const sessionMediaMetadata = {
            key: 'happier' as const,
            envelope: { kind: 'session_media.v1' as const, payload: { media: [{
                id: 'media-42', role: 'input' as const, category: 'attachment' as const,
                mediaKind: 'image' as const, mimeType: 'image/png' as const, name: 'issue.png',
                path: '.happier/uploads/issue.png', sizeBytes: 42, sha256: 'a'.repeat(64),
                origin: { source: 'user-upload' as const },
            }] } },
        };
        const stagedMediaHandle = {
            v: 1 as const, id: 'stage-42', executionTarget: { serverId: getActiveServerSnapshot().serverId, machineId: 'm1' },
            owner: attachment.attachment, mediaKind: 'image' as const, mimeType: 'image/png', name: 'issue.png',
            sizeBytes: 42, sha256: 'a'.repeat(64),
        };
        const cleanup = { workingDirectory: '/tmp/project', createdWorkspaceRelativePaths: ['.happier/uploads/issue.png'] };
        const retireOwner = () => storage.getState().activateProfileScope({
            serverId: getActiveServerSnapshot().serverId, accountId: 'replacement-account',
        });
        const events: string[] = [];
        let acceptedFact: unknown;
        vi.spyOn(apiSocket, 'sessionRPC').mockImplementation(async (_id, method) => {
            if (method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1) {
                events.push('prepare');
                if (!reachable) throw new Error('daemon unavailable');
                if (retiredAt === 'prepare') retireOwner();
                return { ok: true, text: 'prepared queue', structuredInput: { v: 1, composerAttachments: [preparedAttachment] },
                    stagedMediaHandles: [stagedMediaHandle], sessionMediaMetadata, sessionMediaCleanup: cleanup };
            }
            events.push(method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1 ? 'abandoned' : 'accepted');
            return { ok: true };
        });
        const rpc = vi.mocked(apiSocket.sessionRPC);
        vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) => {
            events.push('enqueue');
            const body = JSON.parse(String(init?.body));
            expect(body.content.v.content.text).toBe('prepared queue');
            expect(body.content.v.meta.happierStructuredInputV1.composerAttachments).toEqual([preparedAttachment]);
            // Preserve the general envelope while placing admitted media in its reserved slot.
            expect(body.content.v.meta.happier).toEqual({ kind: 'context.v1', payload: {} });
            expect(body.content.v.meta.happierMedia).toEqual(sessionMediaMetadata.envelope);
            if (retiredAt === 'enqueue') retireOwner();
            return currentPendingEnqueueAck(init);
        });
        const { sync } = await import('./sync');
        const submit = sync.enqueuePendingMessage(sessionId, 'queue', undefined, {
            happierStructuredInputV1: { v: 1, composerAttachments: [attachment] },
            happier: { kind: 'context.v1', payload: {} },
        }, { localId: 'typed-local', requestedAction: { v: 1, kind: 'enqueue' } });
        if (!reachable) {
            await expect(submit).rejects.toThrow('daemon unavailable');
            expect(events).toEqual(['prepare']);
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
            expect(await loadPendingOutboxForSession(sessionId, getActiveServerAccountScope()!)).toEqual([]);
            return;
        }
        if (retiredAt === 'prepare') {
            await expect(submit).rejects.toMatchObject({ code: 'session_account_scope_retired' });
            expect(events).toEqual(['prepare']);
            return;
        }
        await expect(submit).resolves.toMatchObject({ accepted: true, localId: 'typed-local' });
        acceptedFact = rpc.mock.calls.find((call) => call[1] === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1)?.[2];
        if (retiredAt === 'enqueue') {
            expect(events).toEqual(['prepare', 'enqueue']);
            expect(acceptedFact).toBeUndefined();
            return;
        }
        expect(events).toEqual(['prepare', 'enqueue', 'accepted']);
        expect(acceptedFact).toEqual({ sessionId, localId: 'typed-local', structuredInput: { v: 1, composerAttachments: [preparedAttachment] },
            stagedMediaHandles: [stagedMediaHandle], sessionMediaMetadata: { ...sessionMediaMetadata, key: 'happierMedia' } });
    });

    it('abandons prepared media when invalid caller metadata prevents pending custody', async () => {
        const sessionId = 's_typed_queue_invalid_meta';
        storage.getState().applySessions([{ ...createPlainSession({ sessionId }), active: true, pendingVersion: 2 }]);
        const attachment = {
            v: 1, instanceId: 'issue-42', attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42', value: {}, presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const cleanup = { workingDirectory: '/tmp/project', createdWorkspaceRelativePaths: ['.happier/uploads/prepared.png'] };
        const rpc = vi.spyOn(apiSocket, 'sessionRPC').mockImplementation(async (_id, method) => (
            method === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1
                ? { ok: true, text: 'prepared', structuredInput: { v: 1, composerAttachments: [attachment] },
                    stagedMediaHandles: [], sessionMediaCleanup: cleanup }
                : { ok: true }
        ));
        const request = vi.spyOn(apiSocket, 'request');
        const { sync } = await import('./sync');
        await expect(sync.enqueuePendingMessage(sessionId, 'queue', undefined, {
            happierStructuredInputV1: { v: 1, composerAttachments: [attachment] }, displayText: 42,
        }, { localId: 'invalid-meta' })).rejects.toThrow('projection is invalid');
        expect(request).not.toHaveBeenCalled();
        expect(rpc.mock.calls.find((call) => call[1] === SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1)?.[2]).toMatchObject({
            sessionId, localId: 'invalid-meta', sessionMediaCleanup: cleanup,
        });
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
        const pendingPost = vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) =>
            currentPendingEnqueueAck(init));
        const sessionRpc = vi.spyOn(apiSocket, 'sessionRPC');
        const directSend = vi.spyOn(sync, 'sendMessage');

        const submitResult = await sync.submitMessage(sessionId, 'durable now', undefined, undefined, {
            callerSurface: 'sync_submit_message',
            forceImmediate: true,
            hostAdmissionOrigin: 'voice',
        });

        expect(pendingPost).toHaveBeenCalledTimes(1);
        const localId = storage.getState().sessionPending[sessionId]?.messages[0]?.localId;
        expect(localId).toEqual(expect.any(String));
        expect(submitResult).toMatchObject({ persistence: 'pending', localId });
        const [pendingPath, pendingInit] = pendingPost.mock.calls[0]!;
        expect(pendingPath).toBe(`/v2/sessions/${sessionId}/pending`);
        expect(pendingInit).toMatchObject({ method: 'POST' });
        const pendingRequest = JSON.parse(String(pendingInit?.body ?? 'null')) as {
            requestedAction?: unknown;
            content?: { t?: unknown; v?: { meta?: unknown } };
        };
        expect(pendingRequest.requestedAction).toEqual({ v: 1, kind: 'send_now' });
        expect(pendingRequest.content).toMatchObject({
            t: 'plain',
            v: {
                meta: {
                    happierProvenanceV1: { v: 1, kind: 'voice' },
                    happierInputRequestV1: {
                        v: 1,
                        producer: 'voiceInput',
                        caller: { kind: 'host' },
                        permission: {},
                    },
                },
            },
        });
        expect(sessionRpc).not.toHaveBeenCalled();
        expect(directSend).not.toHaveBeenCalled();
    });
});
