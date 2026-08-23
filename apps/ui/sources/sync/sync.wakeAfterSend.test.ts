import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const ensureSessionRuntimeForPendingInputSpy = vi.hoisted(() => vi.fn(async (_options: unknown) => ({ type: 'success' as const })));
const getServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: getServerFeaturesSnapshotMock,
}));
vi.mock('@/sync/ops', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops')>();
    return {
        ...actual,
        ensureSessionRuntimeForPendingInput: ensureSessionRuntimeForPendingInputSpy,
    };
});

import { storage } from './domains/state/storage';
import type { Machine, Session } from './domains/state/storageTypes';
import { getActiveServerSnapshot } from './domains/server/serverRuntime';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerAccountScope } from './domains/scope/activeServerAccountScope';
import { readPersistedSessionViewport } from './domains/state/sessionViewportPersistence';

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

function tokenForSub(sub: string): string {
    const payload = globalThis.btoa(JSON.stringify({ sub }))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    return `e30.${payload}.signature`;
}

describe('sync.sendMessage wake-after-send', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        storage.getState().activateProfileScope({
            serverId: getActiveServerSnapshot().serverId,
            accountId: 'sync-wake-after-send-test-account',
        });
        appStateAddListener.mockClear();
        ensureSessionRuntimeForPendingInputSpy.mockClear();
        getServerFeaturesSnapshotMock.mockReset();
    });

    afterEach(() => {
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
            emitWithAck: vi.fn(async (_event, payload: any) => ({
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

    it('wakes the daemon with the current session authoring snapshot after sending a message via the server commit path', async () => {
        const sessionId = 's_test';
        const connectedServices = {
            v: 1 as const,
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected' as const,
                    selection: 'group' as const,
                    groupId: 'claude-group',
                    profileId: 'profile-2',
                },
            },
        };
        const session = createPlainSession({ sessionId });
        storage.getState().applySessions([{
            ...session,
            permissionMode: 'yolo',
            permissionModeUpdatedAt: 200,
            modelMode: 'claude-sonnet-4-5',
            modelModeUpdatedAt: 150,
            metadata: {
                ...session.metadata,
                permissionMode: 'default',
                permissionModeUpdatedAt: 100,
                sessionModeOverrideV1: {
                    v: 1,
                    updatedAt: 250,
                    modeId: 'plan',
                },
                modelOverrideV1: {
                    v: 1,
                    updatedAt: 150,
                    modelId: 'claude-sonnet-4-5',
                },
                connectedServices,
            } as any,
        }]);

        const { sync } = await import('./sync');
        // Boundary fixture: install the machine-encryption reader normally created by authenticated Sync setup.
        (sync as any).encryption = {
            getMachineEncryption: () => ({}),
        };

        vi.spyOn(apiSocket, 'sessionRPC').mockRejectedValue(createRpcMethodNotAvailableError());
        sync.setMessageTransport({
            emitWithAck: vi.fn(async (_event, payload: any) => ({
                ok: true,
                id: 'm1',
                seq: 37,
                localId: payload.localId,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello');

        expect(ensureSessionRuntimeForPendingInputSpy).toHaveBeenCalledTimes(1);
        expect(ensureSessionRuntimeForPendingInputSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                machineId: 'm1',
                directory: '/tmp/project',
                initialTranscriptAfterSeq: 36,
                connectedServices,
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 200,
                agentModeId: 'plan',
                agentModeUpdatedAt: 250,
                modelId: 'claude-sonnet-4-5',
                modelUpdatedAt: 150,
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
            emitWithAck: vi.fn(async (_event, payload: any) => ({
                ok: true,
                id: 'm1',
                seq: 37,
                localId: payload.localId,
                didWrite: true,
            })) as any,
            send: vi.fn(),
        });

        await sync.sendMessage(sessionId, 'hello');

        expect(ensureSessionRuntimeForPendingInputSpy).toHaveBeenCalledTimes(1);
        expect(ensureSessionRuntimeForPendingInputSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                machineId: 'm-new',
                directory: '/tmp/project',
                initialTranscriptAfterSeq: 36,
            }),
        );
    });

    it('uses the canonical pending wake after action acknowledgement without direct execution authorization', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    compatibility: { pendingInput: { currentPendingInputProtocolVersion: 1 } },
                    session: { pendingInput: { protocolVersion: 1 } },
                },
                features: {
                    sharing: {
                        pendingQueueV2: { enabled: true },
                        pendingDeliveryState: { enabled: true },
                    },
                },
            },
        });
        const sessionId = 's_pending_submit_wake';
        storage.getState().applyMachines([createMachine({ id: 'm1', active: true })], true);
        storage.getState().applySessions([{
            ...createPlainSession({ sessionId }),
            seq: 12,
            active: false,
            pendingVersion: 0,
            pendingCount: 0,
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'codex',
                codexSessionId: 'codex-1',
            } as any,
        }]);

        const { sync } = await import('./sync');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: tokenForSub('sync-wake-after-send-test-account'),
            secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url'),
        });
        (sync as any).encryption = {
            getSessionEncryption: () => null,
            getMachineEncryption: () => ({}),
        };

        vi.spyOn(apiSocket, 'request').mockImplementation(async (_path, init) => {
            const current = storage.getState().sessions[sessionId];
            storage.getState().applySessions([{
                ...current,
                seq: 30,
            }]);
            const requestBody = JSON.parse(String(init?.body ?? '{}')) as {
                localId?: unknown;
                content?: unknown;
                requestedAction?: unknown;
            };
            if (requestBody.requestedAction) {
                return Response.json({
                    requestedAction: requestBody.requestedAction,
                    pending: { localId: requestBody.localId },
                });
            }
            return Response.json({
                didWrite: true,
                pending: {
                    localId: requestBody.localId,
                    content: requestBody.content,
                    status: 'queued',
                    position: 0,
                    createdAt: 1,
                    updatedAt: 1,
                    discardedAt: null,
                    discardedReason: null,
                    authorAccountId: 'sync-wake-after-send-test-account',
                },
                pendingCount: 1,
                pendingVersion: 1,
            });
        });

        await sync.submitMessage(sessionId, 'hello pending');

        expect(apiSocket.request).toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending`,
            expect.objectContaining({ method: 'POST' }),
        );
        await vi.waitFor(() => expect(ensureSessionRuntimeForPendingInputSpy).toHaveBeenCalledTimes(1));
        expect(ensureSessionRuntimeForPendingInputSpy).toHaveBeenCalledWith({
            sessionId,
            machineId: 'm1',
            directory: '/tmp/project',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'codex-1',
            codexBackendMode: 'appServer',
            initialTranscriptAfterSeq: 12,
        });
    });

    it('rejects submitMessage pending intent on old CLI without direct delivery', async () => {
        const sessionId = 's_pending_submit_old_cli';
        storage.getState().applySettings({
            ...storage.getState().settings,
            sessionMessageSendMode: 'server_pending',
        }, 1);
        storage.getState().applySessions([{
            ...createPlainSession({ sessionId }),
            active: true,
            pendingVersion: 0,
            pendingCount: 0,
            metadata: {
                machineId: 'm1',
                path: '/tmp/project',
                flavor: 'codex',
                codexSessionId: 'codex-1',
                version: '0.0.1',
            } as any,
        }]);

        const { sync } = await import('./sync');
        (sync as any).encryption = {
            getSessionEncryption: () => null,
            getMachineEncryption: () => ({}),
        };
        const emitWithAck = vi.fn(async () => ({
            ok: true,
            id: 'm1',
            seq: 37,
            localId: null,
            didWrite: true,
        })) as any;
        const send = vi.fn();
        sync.setMessageTransport({ emitWithAck, send });
        const requestSpy = vi.spyOn(apiSocket, 'request').mockResolvedValue(new Response(null, { status: 204 }));

        await expect(sync.submitMessage(sessionId, 'legacy pending')).rejects.toThrow(/pending queue/i);

        expect(emitWithAck).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(requestSpy).not.toHaveBeenCalledWith(
            `/v2/sessions/${sessionId}/pending`,
            expect.anything(),
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
