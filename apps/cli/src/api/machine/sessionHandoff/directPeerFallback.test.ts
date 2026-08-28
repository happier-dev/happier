import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import os from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import type { MachineTransferReceiveEnvelope, SessionHandoffResumePlan, TransferEndpointCandidate } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { MachineTransferChannel } from '../../../machines/transfer/serverRoutedTransport';
import { createEncryptedTransferChunkEnvelope } from '../../../machines/transfer/transferChunkEncryption';
import { disposeTransferPayloadSource } from '../../../machines/transfer/transferPayloadSource';
import { createScmBackendRegistry } from '@/scm/registry';
import { createSessionHandoffWorkspaceReplicationAdapter } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';
import { registerMachineSessionHandoffRpcHandlers as registerMachineSessionHandoffRpcHandlersImpl } from './handlers';
import { createWorkspaceReplicationManifestPayloadSource } from '../../../workspaces/replication/transport/workspaceReplicationManifestTransferV1';

type RegisterSessionHandoffHandlersInput = Parameters<typeof registerMachineSessionHandoffRpcHandlersImpl>[0];
type SessionHandoffWorkspaceReplicationAdapter = ReturnType<
    typeof createSessionHandoffWorkspaceReplicationAdapter
>;

const scmRegistry = createScmBackendRegistry([]);

function createWorkspaceReplicationAdapterForTest(): SessionHandoffWorkspaceReplicationAdapter {
    const adapter = createSessionHandoffWorkspaceReplicationAdapter();
    return {
        ...adapter,
        createState: (input) => adapter.createState({ ...input, scmRegistry }),
        prepareTargetWorkspace: (input) => adapter.prepareTargetWorkspace({ ...input, scmRegistry }),
        prepareSourceWorkspaceTransfer: (input) => adapter.prepareSourceWorkspaceTransfer({
            ...input,
            scmRegistry,
        }),
    };
}

function registerMachineSessionHandoffRpcHandlers(input: RegisterSessionHandoffHandlersInput): void {
    registerMachineSessionHandoffRpcHandlersImpl({
        ...input,
        runtimeDependencies: {
            ...input.runtimeDependencies,
            workspaceReplicationAdapter: input.runtimeDependencies?.workspaceReplicationAdapter
                ?? createWorkspaceReplicationAdapterForTest(),
        },
    });
}

describe('rpcHandlers (session handoff direct-peer fallback)', () => {
    function buildDirectPeerEndpointCandidate(params: Readonly<{
        transferId: string;
        expiresAt: number;
        port?: number;
        authorizationToken?: string;
    }>): TransferEndpointCandidate {
        const port = params.port ?? 46001;
        const transferPathKey = Buffer.from(params.transferId, 'utf8').toString('base64url');
        return {
            kind: 'http',
            url: `http://127.0.0.1:${port}/machine-transfers/direct/${transferPathKey}`,
            authorizationToken: params.authorizationToken ?? 'test-token',
            expiresAt: params.expiresAt,
        };
    }

    async function createDirectPeerRequestPayloadFile(params: Readonly<{
        payload: Buffer;
    }>): Promise<Readonly<{
        requestPayloadFile: ReturnType<typeof vi.fn>;
        dispose: () => Promise<void>;
    }>> {
        const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-fallback-'));
        const payloadFilePath = join(temporaryDirectory, 'payload.bin');
        await writeFile(payloadFilePath, params.payload);
        return {
            requestPayloadFile: vi.fn(async ({ destinationPath }: Readonly<{ destinationPath: string }>) => {
                await copyFile(payloadFilePath, destinationPath);
                return { destinationPath };
            }),
            dispose: async () => {
                await rm(temporaryDirectory, { recursive: true, force: true });
            },
        };
    }

    function computeManifestHash(payload: Uint8Array): string {
        return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    }

function buildClaudeResumePlan(params: Readonly<{
        directory: string;
        resume: string;
        transcriptStorage: 'direct' | 'persisted';
    }>): SessionHandoffResumePlan {
        return {
            directory: params.directory,
            agent: 'claude',
            agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            },
            resume: params.resume,
            transcriptStorage: params.transcriptStorage,
            approvedNewDirectoryCreation: true,
    };
}

function requireFileTransferPayloadSourcePath(
    source: Awaited<ReturnType<typeof createWorkspaceReplicationManifestPayloadSource>>,
    context: string,
): string {
    if (source.kind !== 'file') {
        throw new Error(`Expected file transfer payload source for ${context}`);
    }
    return source.filePath;
}

    async function expectOpenEnvelopeWithRecipient(
        sendEnvelope: ReturnType<typeof vi.fn>,
        transferId: string,
    ): Promise<string> {
        await vi.waitFor(() => {
            expect(sendEnvelope).toHaveBeenCalledWith({
                targetMachineId: 'machine_source',
                envelope: expect.objectContaining({
                    transferId,
                    kind: 'open',
                    manifestHash: expect.any(String),
                    recipientPublicKeyBase64: expect.any(String),
                }),
            });
        });
        const openEnvelope = sendEnvelope.mock.calls[0]?.[0]?.envelope;
        if (
            !openEnvelope
            || openEnvelope.kind !== 'open'
            || typeof openEnvelope.recipientPublicKeyBase64 !== 'string'
        ) {
            throw new Error('Expected open envelope with recipient public key');
        }
        return openEnvelope.recipientPublicKeyBase64;
    }

    it('falls back to server-routed transfer when all direct-peer endpoint candidates are expired', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const importSessionBundle = vi.fn(async () => ({
            remoteSessionId: 'claude_session_target',
            directSource: {
                kind: 'claudeConfig',
                configDir: null,
                projectId: null,
            },
            resume: buildClaudeResumePlan({
                directory: '/repo-target',
                resume: 'claude_session_target',
                transcriptStorage: 'persisted',
            }),
        }));
        const requestPayloadFile = vi.fn(async () => {
            throw new Error('direct peer request should not run for expired candidates');
        });
        const sendEnvelope = vi.fn();
        const listeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
        const rpcHandlerManager = {
            registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                registered.set(method, handler);
            },
        } as any;

        registerMachineSessionHandoffRpcHandlers({
            rpcHandlerManager,
            importSessionBundle,
            machineTransferChannel: {
                onEnvelope(listener) {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                sendEnvelope,
            },
            directPeerTransfer: {
                publishTransfer: vi.fn(() => []),
                requestPayloadFile,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
        const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
        expect(prepare).toBeDefined();
        expect(resultGet).toBeDefined();

        const agentBundleTransferId = 'session-handoff:handoff_direct_peer_expired_candidates:provider-bundle-file';
        const serverRoutedPayload = Buffer.from(JSON.stringify({
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
        }), 'utf8');
        const expiredCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer',
            expiresAt: Date.now() - 1,
        });

        const preparePromise = prepare!({
            handoffId: 'handoff_direct_peer_expired_candidates',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [expiredCandidate],
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: agentBundleTransferId,
                    sizeBytes: serverRoutedPayload.byteLength,
                    manifestHash: computeManifestHash(serverRoutedPayload),
                    endpointCandidates: [expiredCandidate],
                },
            },
        });

        const recipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(
            sendEnvelope,
            agentBundleTransferId,
        );
        expect(requestPayloadFile).not.toHaveBeenCalled();

        for (const listener of listeners) {
            listener({
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                envelope: {
                    transferId: agentBundleTransferId,
                    kind: 'chunk',
                    sequence: 0,
                    ...createEncryptedTransferChunkEnvelope({
                        transferId: agentBundleTransferId,
                        sequence: 0,
                        payload: serverRoutedPayload,
                        recipientPublicKeyBase64,
                        randomBytes: (length) => new Uint8Array(length).fill(13),
                    }),
                },
            });
            listener({
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                envelope: {
                    transferId: agentBundleTransferId,
                    kind: 'finish',
                    manifestHash: computeManifestHash(serverRoutedPayload),
                },
            });
        }

        const prepared = await preparePromise;
        expect(prepared).toMatchObject({
            handoffId: 'handoff_direct_peer_expired_candidates',
        });

        // PREPARE_TARGET may return its initial pending snapshot while the background
        // job persists the server-routed fallback; RESULT_GET owns the final assertion.
        let ready = prepared;
        if (ready.status.status !== 'ready_for_cutover') {
            await vi.waitFor(async () => {
                ready = await resultGet!({
                    handoffId: 'handoff_direct_peer_expired_candidates',
                });
                expect(ready.status.status).toBe('ready_for_cutover');
            });
        }

        expect(ready).toMatchObject({
            handoffId: 'handoff_direct_peer_expired_candidates',
            status: expect.objectContaining({
                transportStrategy: 'server_routed_stream',
            }),
            remoteSessionId: 'claude_session_target',
        });
    });

    it('returns pending and then awaiting_recovery when all direct-peer endpoint candidates are expired and no server-routed fallback channel is available', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const requestPayloadFile = vi.fn(async () => {
            throw new Error('direct peer request should not run for expired candidates');
        });
        const rpcHandlerManager = {
            registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                registered.set(method, handler);
            },
        } as any;

        registerMachineSessionHandoffRpcHandlers({
            rpcHandlerManager,
            directPeerTransfer: {
                publishTransfer: vi.fn(() => []),
                requestPayloadFile,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
        const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
        expect(prepare).toBeDefined();
        expect(resultGet).toBeDefined();

        const agentBundleTransferId = 'session-handoff:handoff_direct_peer_expired_candidates_no_fallback:provider-bundle-file';
        const expiredCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer',
            expiresAt: Date.now() - 1,
        });

        const prepareResult = await prepare!({
            handoffId: 'handoff_direct_peer_expired_candidates_no_fallback',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [expiredCandidate],
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: agentBundleTransferId,
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [expiredCandidate],
                },
            },
        });

        expect(prepareResult).toMatchObject({
            handoffId: 'handoff_direct_peer_expired_candidates_no_fallback',
            status: expect.objectContaining({
                status: 'pending',
                transportStrategy: 'direct_peer',
            }),
        });

        await vi.waitFor(async () => {
            await expect(resultGet!({
                handoffId: 'handoff_direct_peer_expired_candidates_no_fallback',
            })).resolves.toEqual({
                ok: false,
                errorCode: 'direct_peer_transfer_unavailable',
                error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
            });
        });

        expect(requestPayloadFile).not.toHaveBeenCalled();
    });

    it('returns pending and then awaiting_recovery when a legacy requestPayload-only direct-peer adapter has no server-routed fallback channel', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const legacyRequestPayload = vi.fn(async () => {
            throw new Error('legacy typed payload path should not be used');
        });
        const rpcHandlerManager = {
            registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                registered.set(method, handler);
            },
        } as any;

        const legacyOnlyDirectPeerTransfer = {
            publishTransfer: vi.fn(() => []),
            requestPayload: legacyRequestPayload,
            clearPublishedTransfer: vi.fn(),
        };

        registerMachineSessionHandoffRpcHandlers({
            rpcHandlerManager,
            directPeerTransfer: legacyOnlyDirectPeerTransfer,
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
        const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
        expect(prepare).toBeDefined();
        expect(resultGet).toBeDefined();

        const agentBundleTransferId = 'session-handoff:handoff_direct_peer_legacy_only_adapter:provider-bundle-file';
        const endpointCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer_legacy_only_adapter',
            expiresAt: Date.now() + 30_000,
        });

        const prepareResult = await prepare!({
            handoffId: 'handoff_direct_peer_legacy_only_adapter',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: agentBundleTransferId,
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [endpointCandidate],
                },
            },
        });

        expect(prepareResult).toMatchObject({
            handoffId: 'handoff_direct_peer_legacy_only_adapter',
            status: expect.objectContaining({
                status: 'pending',
                transportStrategy: 'direct_peer',
            }),
        });

        await vi.waitFor(async () => {
            await expect(resultGet!({
                handoffId: 'handoff_direct_peer_legacy_only_adapter',
            })).resolves.toEqual({
                ok: false,
                errorCode: 'direct_peer_transfer_unavailable',
                error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
            });
        });

        expect(legacyRequestPayload).not.toHaveBeenCalled();
    });

    it('returns pending and then awaiting_recovery when direct-peer transfer fails and no server-routed fallback channel is available', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const requestPayloadFile = vi.fn(async () => {
            throw new Error('direct peer unavailable');
        });
        const rpcHandlerManager = {
            registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                registered.set(method, handler);
            },
        } as any;

        registerMachineSessionHandoffRpcHandlers({
            rpcHandlerManager,
            directPeerTransfer: {
                publishTransfer: vi.fn(() => []),
                requestPayloadFile,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
        const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
        expect(prepare).toBeDefined();
        expect(resultGet).toBeDefined();

        const agentBundleTransferId = 'session-handoff:handoff_direct_peer_failed_no_fallback:provider-bundle-file';
        const endpointCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer',
            expiresAt: Date.now() + 30_000,
        });

        const prepareResult = await prepare!({
            handoffId: 'handoff_direct_peer_failed_no_fallback',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: agentBundleTransferId,
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [endpointCandidate],
                },
            },
        });

        expect(prepareResult).toMatchObject({
            handoffId: 'handoff_direct_peer_failed_no_fallback',
            status: expect.objectContaining({
                status: 'pending',
                transportStrategy: 'direct_peer',
            }),
        });

        await vi.waitFor(async () => {
            await expect(resultGet!({
                handoffId: 'handoff_direct_peer_failed_no_fallback',
            })).resolves.toEqual({
                ok: false,
                errorCode: 'direct_peer_transfer_unavailable',
                error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
            });
        });

        expect(requestPayloadFile).toHaveBeenCalledTimes(1);
    });

    it('suppresses an immediate retry after a direct-peer transport failure for the same source machine and endpoint set', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const requestPayloadFile = vi.fn(async () => {
            throw new Error('direct peer unavailable');
        });
        const rpcHandlerManager = {
            registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                registered.set(method, handler);
            },
        } as any;

        registerMachineSessionHandoffRpcHandlers({
            rpcHandlerManager,
            directPeerTransfer: {
                publishTransfer: vi.fn(() => []),
                requestPayloadFile,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
        const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
        expect(prepare).toBeDefined();
        expect(resultGet).toBeDefined();

        const endpointCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer',
            expiresAt: Date.now() + 30_000,
        });

        const firstPrepareResult = await prepare!({
            handoffId: 'handoff_direct_peer_cached_retry_a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_cached_retry_a:provider-bundle-file',
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [endpointCandidate],
                },
            },
        });

        expect(firstPrepareResult).toMatchObject({
            handoffId: 'handoff_direct_peer_cached_retry_a',
            status: expect.objectContaining({
                status: 'pending',
                transportStrategy: 'direct_peer',
            }),
        });

        const secondPrepareResult = await prepare!({
            handoffId: 'handoff_direct_peer_cached_retry_b',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_cached_retry_b:provider-bundle-file',
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [endpointCandidate],
                },
            },
        });

        expect(secondPrepareResult).toMatchObject({
            handoffId: 'handoff_direct_peer_cached_retry_b',
            status: expect.objectContaining({
                status: 'pending',
                transportStrategy: 'direct_peer',
            }),
        });

        await vi.waitFor(async () => {
            await expect(resultGet!({
                handoffId: 'handoff_direct_peer_cached_retry_a',
            })).resolves.toEqual({
                ok: false,
                errorCode: 'direct_peer_transfer_unavailable',
                error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
            });
        });

        expect(requestPayloadFile).toHaveBeenCalledTimes(1);
    });

    it('retries a cached-unavailable direct-peer route after a new handoff start for the same machine pair', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const requestPayloadFile = vi.fn(async () => {
            throw new Error('direct peer unavailable');
        });
        const rpcHandlerManager = {
            registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                registered.set(method, handler);
            },
        } as any;

        registerMachineSessionHandoffRpcHandlers({
            rpcHandlerManager,
            loadSessionMetadata: async () => ({
                machineId: 'machine_source',
                path: '/repo',
                flavor: 'claude',
                claudeSessionId: 'claude_session_1',
            }),
            exportSessionBundle: async () => ({
                agentBundle: {
                    agentId: 'claude',
                    remoteSessionId: 'claude_session_1',
                    transcriptBase64: 'e30K',
                },
                targetPath: '/repo',
            }),
            directPeerTransfer: {
                publishTransfer: vi.fn(() => []),
                requestPayloadFile,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
        const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
        expect(start).toBeDefined();
        expect(prepare).toBeDefined();
        expect(resultGet).toBeDefined();

        const endpointCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer_route_cache_reset',
            expiresAt: Date.now() + 30_000,
        });

        const firstPrepareResult = await prepare!({
            handoffId: 'handoff_direct_peer_route_cache_reset_a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_route_cache_reset_a:provider-bundle-file',
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [endpointCandidate],
                },
            },
        });

        expect(firstPrepareResult).toMatchObject({
            handoffId: 'handoff_direct_peer_route_cache_reset_a',
            status: expect.objectContaining({
                status: 'pending',
                transportStrategy: 'direct_peer',
            }),
        });

        await start!({
            sessionId: 'sess_route_cache_reset',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer'],
            negotiatedTransportStrategy: 'direct_peer',
        });

        const secondPrepareResult = await prepare!({
            handoffId: 'handoff_direct_peer_route_cache_reset_b',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_route_cache_reset_b:provider-bundle-file',
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [endpointCandidate],
                },
            },
        });

        expect(secondPrepareResult).toMatchObject({
            handoffId: 'handoff_direct_peer_route_cache_reset_b',
            status: expect.objectContaining({
                status: 'pending',
                transportStrategy: 'direct_peer',
            }),
        });

        await vi.waitFor(async () => {
            await expect(resultGet!({
                handoffId: 'handoff_direct_peer_route_cache_reset_a',
            })).resolves.toEqual({
                ok: false,
                errorCode: 'direct_peer_transfer_unavailable',
                error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
            });
        });

        expect(requestPayloadFile).toHaveBeenCalledTimes(2);
    });

    it('does not reuse a cached direct-peer failure across handoffs when the machine transfer channel has no server id', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const agentBundlePayload = Buffer.from(JSON.stringify({
            agentId: 'claude',
            remoteSessionId: 'claude_session_target',
            transcriptBase64: 'e30K',
        }), 'utf8');
        let requestCount = 0;
        const requestPayloadFile = vi.fn(async ({ destinationPath }: Readonly<{ destinationPath: string }>) => {
            requestCount += 1;
            if (requestCount === 1) {
                throw new Error('direct peer unavailable');
            }
            await writeFile(destinationPath, agentBundlePayload);
            return { destinationPath };
        });
        const rpcHandlerManager = {
            registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                registered.set(method, handler);
            },
        } as any;

        registerMachineSessionHandoffRpcHandlers({
            rpcHandlerManager,
            machineTransferChannel: {
                onEnvelope: () => () => {},
                sendEnvelope: vi.fn(),
            },
            loadSessionMetadata: async () => ({
                machineId: 'machine_source',
                path: '/repo',
                flavor: 'claude',
                claudeSessionId: 'claude_session_1',
            }),
            exportSessionBundle: async () => ({
                agentBundle: {
                    agentId: 'claude',
                    remoteSessionId: 'claude_session_target',
                    transcriptBase64: 'e30K',
                },
                targetPath: '/repo-target',
            }),
            importSessionBundle: async () => ({
                remoteSessionId: 'claude_session_target',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: buildClaudeResumePlan({
                    directory: '/repo-target',
                    resume: 'claude_session_target',
                    transcriptStorage: 'persisted',
                }),
            }),
            directPeerTransfer: {
                publishTransfer: vi.fn(() => []),
                requestPayloadFile,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
        const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
        expect(prepare).toBeDefined();
        expect(resultGet).toBeDefined();

        const endpointCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer_unknown_server',
            expiresAt: Date.now() + 30_000,
        });

        const firstPrepareResult = await prepare!({
            handoffId: 'handoff_direct_peer_unknown_server_a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            allowServerRoutedFallback: false,
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_unknown_server_a:provider-bundle-file',
                    sizeBytes: agentBundlePayload.byteLength,
                    manifestHash: computeManifestHash(agentBundlePayload),
                    endpointCandidates: [endpointCandidate],
                },
            },
        });

        expect(firstPrepareResult).toMatchObject({
            handoffId: 'handoff_direct_peer_unknown_server_a',
            status: expect.objectContaining({
                status: 'pending',
                transportStrategy: 'direct_peer',
            }),
        });

        await vi.waitFor(async () => {
            await expect(resultGet!({
                handoffId: 'handoff_direct_peer_unknown_server_a',
            })).resolves.toEqual({
                ok: false,
                errorCode: 'direct_peer_transfer_unavailable',
                error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
            });
        });

        const secondPrepareResult = await prepare!({
            handoffId: 'handoff_direct_peer_unknown_server_b',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            allowServerRoutedFallback: false,
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_unknown_server_b:provider-bundle-file',
                    sizeBytes: agentBundlePayload.byteLength,
                    manifestHash: computeManifestHash(agentBundlePayload),
                    endpointCandidates: [endpointCandidate],
                },
            },
        });

        expect(secondPrepareResult).toMatchObject({
            handoffId: 'handoff_direct_peer_unknown_server_b',
            status: expect.objectContaining({
                transportStrategy: 'direct_peer',
            }),
        });

        await vi.waitFor(async () => {
            expect(requestCount).toBe(2);
        });
        let ready = secondPrepareResult;
        if (!('status' in ready) || ready.status.status !== 'ready_for_cutover') {
            await vi.waitFor(async () => {
                const next = await resultGet!({
                    handoffId: 'handoff_direct_peer_unknown_server_b',
                });
                expect(next).toMatchObject({
                    handoffId: 'handoff_direct_peer_unknown_server_b',
                    status: expect.objectContaining({
                        status: 'ready_for_cutover',
                        transportStrategy: 'direct_peer',
                    }),
                });
                ready = next;
            });
        }

        expect(ready).toMatchObject({
            handoffId: 'handoff_direct_peer_unknown_server_b',
            status: expect.objectContaining({
                status: 'ready_for_cutover',
                transportStrategy: 'direct_peer',
            }),
        });
    });

    it('retries a cached-unavailable direct-peer route after a fresh prepare-target request for the same machine pair', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const agentBundlePayload = Buffer.from(JSON.stringify({
            agentId: 'claude',
            remoteSessionId: 'claude_session_target',
            transcriptBase64: 'e30K',
        }), 'utf8');
        const requestPayloadFile = vi.fn(async () => {
            throw new Error('direct peer unavailable');
        });
        const rpcHandlerManager = {
            registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                registered.set(method, handler);
            },
        } as any;

        registerMachineSessionHandoffRpcHandlers({
            rpcHandlerManager,
            loadSessionMetadata: async () => ({
                machineId: 'machine_source',
                path: '/repo',
                flavor: 'claude',
                claudeSessionId: 'claude_session_1',
            }),
            exportSessionBundle: async () => ({
                agentBundle: {
                    agentId: 'claude',
                    remoteSessionId: 'claude_session_target',
                    transcriptBase64: 'e30K',
                },
                targetPath: '/repo-target',
            }),
            importSessionBundle: async () => ({
                remoteSessionId: 'claude_session_target',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: buildClaudeResumePlan({
                    directory: '/repo-target-prepare-retry',
                    resume: 'claude_session_target',
                    transcriptStorage: 'persisted',
                }),
            }),
            directPeerTransfer: {
                publishTransfer: vi.fn(() => []),
                requestPayloadFile,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
        const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
        expect(prepare).toBeDefined();
        expect(resultGet).toBeDefined();

        const agentBundleTransferId = 'session-handoff:handoff_direct_peer_prepare_retry_a:provider-bundle-file';
        const endpointCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer_prepare_retry',
            expiresAt: Date.now() + 30_000,
        });

        const expectPendingOrTerminalFailure = async (handoffId: string, result: unknown) => {
            if (
                result
                && typeof result === 'object'
                && !Array.isArray(result)
                && typeof (result as { handoffId?: unknown }).handoffId === 'string'
            ) {
                expect(result).toMatchObject({
                    handoffId,
                    status: expect.objectContaining({
                        status: 'pending',
                        transportStrategy: 'direct_peer',
                    }),
                });
                await vi.waitFor(async () => {
                    await expect(resultGet!({ handoffId })).resolves.toEqual({
                        ok: false,
                        errorCode: 'direct_peer_transfer_unavailable',
                        error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
                    });
                }, {
                    // `sync_changes` direct-peer prepares now spend the full workspace retry budget
                    // before failing closed into the durable recovery state.
                    timeout: 10_000,
                });
                return;
            }

            expect(result).toEqual({
                ok: false,
                errorCode: 'direct_peer_transfer_unavailable',
                error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
            });
        };

        await expectPendingOrTerminalFailure('handoff_direct_peer_prepare_retry_a', await prepare!({
            handoffId: 'handoff_direct_peer_prepare_retry_a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo-prepare-retry',
            endpointCandidates: [endpointCandidate],
            workspaceTransfer: {
                enabled: true,
                strategy: 'sync_changes',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            },
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: agentBundleTransferId,
                    sizeBytes: agentBundlePayload.byteLength,
                    manifestHash: computeManifestHash(agentBundlePayload),
                    endpointCandidates: [endpointCandidate],
                },
                workspaceReplicationSourceRootPath: '/repo-prepare-retry',
                workspaceReplicationManifestTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_prepare_retry_a:workspace-manifest',
                    endpointCandidates: [endpointCandidate],
                },
            },
        }));

        await expectPendingOrTerminalFailure('handoff_direct_peer_prepare_retry_b', await prepare!({
            handoffId: 'handoff_direct_peer_prepare_retry_b',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            workspaceTransfer: {
                enabled: true,
                strategy: 'sync_changes',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            },
            handoffMetadataV2: {
                agentBundleTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_prepare_retry_b:provider-bundle-file',
                    sizeBytes: agentBundlePayload.byteLength,
                    manifestHash: computeManifestHash(agentBundlePayload),
                    endpointCandidates: [endpointCandidate],
                },
                workspaceReplicationSourceRootPath: '/repo',
                workspaceReplicationManifestTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_prepare_retry_b:workspace-manifest',
                    endpointCandidates: [endpointCandidate],
                },
            },
        }));

        expect(requestPayloadFile.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('recovers a direct-peer handoff when the provider bundle and workspace manifest are briefly unavailable during prepare-target', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const agentBundleTransferId = 'session-handoff:handoff_direct_peer_prepare_retry_ready:provider-bundle-file';
        const workspaceManifestTransferId = 'session-handoff:handoff_direct_peer_prepare_retry_ready:workspace-manifest';
        const agentBundlePayload = Buffer.from(JSON.stringify({
            agentId: 'claude',
            remoteSessionId: 'claude_session_target',
            transcriptBase64: 'e30K',
        }), 'utf8');
        const workspaceManifestSource = await createWorkspaceReplicationManifestPayloadSource({
            manifest: {
                entries: [],
                fingerprint: `sha256:${'b'.repeat(64)}`,
            },
        });
        try {
            const requestAttemptsByTransferId = new Map<string, number>();
            const requestPayloadFile = vi.fn(async (input: Readonly<{
                transferId: string;
                endpointCandidates: readonly TransferEndpointCandidate[];
                destinationPath: string;
            }>) => {
                const attemptNumber = (requestAttemptsByTransferId.get(input.transferId) ?? 0) + 1;
                requestAttemptsByTransferId.set(input.transferId, attemptNumber);
                if (attemptNumber === 1) {
                    throw new Error('Direct peer transfer unavailable');
                }

                if (input.transferId === agentBundleTransferId) {
                    await writeFile(input.destinationPath, agentBundlePayload);
                    return { destinationPath: input.destinationPath };
                }
                if (input.transferId === workspaceManifestTransferId) {
                    await copyFile(
                        requireFileTransferPayloadSourcePath(workspaceManifestSource, 'retry-ready workspace manifest'),
                        input.destinationPath,
                    );
                    return { destinationPath: input.destinationPath };
                }
                throw new Error(`Unexpected direct peer transfer: ${input.transferId}`);
            });
            const agentBundleEndpointCandidate = buildDirectPeerEndpointCandidate({
                transferId: agentBundleTransferId,
                expiresAt: Date.now() + 30_000,
            });
            const workspaceManifestEndpointCandidate = buildDirectPeerEndpointCandidate({
                transferId: workspaceManifestTransferId,
                expiresAt: Date.now() + 30_000,
            });
            const rpcHandlerManager = {
                registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                    registered.set(method, handler);
                },
            } as any;

            registerMachineSessionHandoffRpcHandlers({
                rpcHandlerManager,
                loadSessionMetadata: async () => ({
                    machineId: 'machine_source',
                    path: '/repo',
                    flavor: 'claude',
                    claudeSessionId: 'claude_session_1',
                }),
                exportSessionBundle: async () => ({
                    agentBundle: {
                        agentId: 'claude',
                        remoteSessionId: 'claude_session_target',
                        transcriptBase64: 'e30K',
                    },
                    targetPath: '/repo-prepare-retry-three',
                }),
                importSessionBundle: async () => ({
                    remoteSessionId: 'claude_session_target',
                    directSource: {
                        kind: 'claudeConfig',
                        configDir: null,
                        projectId: null,
                    },
                    resume: buildClaudeResumePlan({
                    directory: '/repo-target-prepare-retry-ready',
                        resume: 'claude_session_target',
                        transcriptStorage: 'persisted',
                    }),
                }),
                directPeerTransfer: {
                    publishTransfer: vi.fn(() => []),
                    requestPayloadFile,
                    clearPublishedTransfer: vi.fn(),
                },
            });

            const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
            expect(prepare).toBeDefined();

            const prepared = await prepare!({
                handoffId: 'handoff_direct_peer_prepare_retry_ready',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                negotiatedTransportStrategy: 'direct_peer',
                sourceSessionStorageMode: 'persisted',
                targetPath: '/repo-prepare-retry-ready',
                endpointCandidates: [agentBundleEndpointCandidate],
                workspaceTransfer: {
                    enabled: true,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
                handoffMetadataV2: {
                    agentBundleTransferPublication: {
                        transferId: agentBundleTransferId,
                        sizeBytes: agentBundlePayload.byteLength,
                        manifestHash: computeManifestHash(agentBundlePayload),
                        endpointCandidates: [agentBundleEndpointCandidate],
                    },
                    workspaceReplicationSourceRootPath: '/repo-prepare-retry-ready',
                    workspaceReplicationManifestTransferPublication: {
                        transferId: workspaceManifestTransferId,
                        endpointCandidates: [workspaceManifestEndpointCandidate],
                    },
                },
            });

            expect(prepared).toMatchObject({
                handoffId: 'handoff_direct_peer_prepare_retry_ready',
                status: expect.objectContaining({
                    transportStrategy: 'direct_peer',
                }),
            });

            await vi.waitFor(() => {
                expect(requestAttemptsByTransferId.get(agentBundleTransferId)).toBe(2);
                expect(requestAttemptsByTransferId.get(workspaceManifestTransferId)).toBe(2);
            });
        } finally {
            await disposeTransferPayloadSource(workspaceManifestSource);
        }
    });

    it('keeps retrying workspace direct-peer requests through a second transient failure before succeeding', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const agentBundleTransferId = 'session-handoff:handoff_direct_peer_prepare_retry_three_attempts:provider-bundle-file';
        const workspaceManifestTransferId = 'session-handoff:handoff_direct_peer_prepare_retry_three_attempts:workspace-manifest';
        const agentBundlePayload = Buffer.from(JSON.stringify({
            agentId: 'claude',
            remoteSessionId: 'claude_session_target',
            transcriptBase64: 'e30K',
        }), 'utf8');
        const workspaceManifestSource = await createWorkspaceReplicationManifestPayloadSource({
            manifest: {
                entries: [],
                fingerprint: `sha256:${'c'.repeat(64)}`,
            },
        });
        try {
            const requestAttemptsByTransferId = new Map<string, number>();
            const requestPayloadFile = vi.fn(async (input: Readonly<{
                transferId: string;
                endpointCandidates: readonly TransferEndpointCandidate[];
                destinationPath: string;
            }>) => {
                const attemptNumber = (requestAttemptsByTransferId.get(input.transferId) ?? 0) + 1;
                requestAttemptsByTransferId.set(input.transferId, attemptNumber);
                if (attemptNumber < 3) {
                    throw new Error('Direct peer transfer unavailable');
                }

                if (input.transferId === agentBundleTransferId) {
                    await writeFile(input.destinationPath, agentBundlePayload);
                    return { destinationPath: input.destinationPath };
                }
                if (input.transferId === workspaceManifestTransferId) {
                    await copyFile(
                        requireFileTransferPayloadSourcePath(workspaceManifestSource, 'retry-three workspace manifest'),
                        input.destinationPath,
                    );
                    return { destinationPath: input.destinationPath };
                }
                throw new Error(`Unexpected direct peer transfer: ${input.transferId}`);
            });
            const agentBundleEndpointCandidate = buildDirectPeerEndpointCandidate({
                transferId: agentBundleTransferId,
                expiresAt: Date.now() + 30_000,
            });
            const workspaceManifestEndpointCandidate = buildDirectPeerEndpointCandidate({
                transferId: workspaceManifestTransferId,
                expiresAt: Date.now() + 30_000,
            });
            const rpcHandlerManager = {
                registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                    registered.set(method, handler);
                },
            } as any;

            registerMachineSessionHandoffRpcHandlers({
                rpcHandlerManager,
                importSessionBundle: async () => ({
                    remoteSessionId: 'claude_session_target',
                    directSource: {
                        kind: 'claudeConfig',
                        configDir: null,
                        projectId: null,
                    },
                    resume: buildClaudeResumePlan({
                        directory: '/repo-target-prepare-retry-three',
                        resume: 'claude_session_target',
                        transcriptStorage: 'persisted',
                    }),
                }),
                directPeerTransfer: {
                    publishTransfer: vi.fn(() => []),
                    requestPayloadFile,
                    clearPublishedTransfer: vi.fn(),
                },
            });

            const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
            const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
            expect(prepare).toBeDefined();
            expect(resultGet).toBeDefined();

            const result = await prepare!({
                handoffId: 'handoff_direct_peer_prepare_retry_three_attempts',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                negotiatedTransportStrategy: 'direct_peer',
                sourceSessionStorageMode: 'persisted',
                targetPath: '/repo-prepare-retry-three',
                endpointCandidates: [agentBundleEndpointCandidate],
                workspaceTransfer: {
                    enabled: true,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
                handoffMetadataV2: {
                    agentBundleTransferPublication: {
                        transferId: agentBundleTransferId,
                        sizeBytes: agentBundlePayload.byteLength,
                        manifestHash: computeManifestHash(agentBundlePayload),
                        endpointCandidates: [agentBundleEndpointCandidate],
                    },
                    workspaceReplicationSourceRootPath: '/repo-prepare-retry-three',
                    workspaceReplicationManifestTransferPublication: {
                        transferId: workspaceManifestTransferId,
                        endpointCandidates: [workspaceManifestEndpointCandidate],
                    },
                },
            });

            expect(result).toMatchObject({
                handoffId: 'handoff_direct_peer_prepare_retry_three_attempts',
                status: expect.objectContaining({
                    status: 'pending',
                    transportStrategy: 'direct_peer',
                }),
            });

            await vi.waitFor(async () => {
                const ready = await resultGet!({
                    handoffId: 'handoff_direct_peer_prepare_retry_three_attempts',
                });
                expect(ready).toMatchObject({
                    handoffId: 'handoff_direct_peer_prepare_retry_three_attempts',
                    status: expect.objectContaining({
                        status: 'ready_for_cutover',
                        transportStrategy: 'direct_peer',
                    }),
                    resume: expect.objectContaining({
                        resume: 'claude_session_target',
                    }),
                });
            }, { timeout: 5_000 });
            expect(requestAttemptsByTransferId.get(agentBundleTransferId)).toBe(3);
            expect(requestAttemptsByTransferId.get(workspaceManifestTransferId)).toBe(3);
        } finally {
            await disposeTransferPayloadSource(workspaceManifestSource);
        }
    });

    it('keeps retrying workspace direct-peer requests through a sixth transient failure before succeeding', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const agentBundleTransferId = 'session-handoff:handoff_direct_peer_prepare_retry_four_attempts:provider-bundle-file';
        const workspaceManifestTransferId = 'session-handoff:handoff_direct_peer_prepare_retry_four_attempts:workspace-manifest';
        const agentBundlePayload = Buffer.from(JSON.stringify({
            agentId: 'claude',
            remoteSessionId: 'claude_session_target',
            transcriptBase64: 'e30K',
        }), 'utf8');
        const workspaceManifestSource = await createWorkspaceReplicationManifestPayloadSource({
            manifest: {
                entries: [],
                fingerprint: `sha256:${'d'.repeat(64)}`,
            },
        });
        try {
            const requestAttemptsByTransferId = new Map<string, number>();
            const requestPayloadFile = vi.fn(async (input: Readonly<{
                transferId: string;
                endpointCandidates: readonly TransferEndpointCandidate[];
                destinationPath: string;
            }>) => {
                const attemptNumber = (requestAttemptsByTransferId.get(input.transferId) ?? 0) + 1;
                requestAttemptsByTransferId.set(input.transferId, attemptNumber);
                if (attemptNumber < 7) {
                    throw new Error('Direct peer transfer unavailable');
                }

                if (input.transferId === agentBundleTransferId) {
                    await writeFile(input.destinationPath, agentBundlePayload);
                    return { destinationPath: input.destinationPath };
                }
                if (input.transferId === workspaceManifestTransferId) {
                    await copyFile(
                        requireFileTransferPayloadSourcePath(workspaceManifestSource, 'retry-six workspace manifest'),
                        input.destinationPath,
                    );
                    return { destinationPath: input.destinationPath };
                }
                throw new Error(`Unexpected direct peer transfer: ${input.transferId}`);
            });
            const agentBundleEndpointCandidate = buildDirectPeerEndpointCandidate({
                transferId: agentBundleTransferId,
                expiresAt: Date.now() + 30_000,
            });
            const workspaceManifestEndpointCandidate = buildDirectPeerEndpointCandidate({
                transferId: workspaceManifestTransferId,
                expiresAt: Date.now() + 30_000,
            });
            const rpcHandlerManager = {
                registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                    registered.set(method, handler);
                },
            } as any;

            registerMachineSessionHandoffRpcHandlers({
                rpcHandlerManager,
                importSessionBundle: async () => ({
                    remoteSessionId: 'claude_session_target',
                    directSource: {
                        kind: 'claudeConfig',
                        configDir: null,
                        projectId: null,
                    },
                    resume: buildClaudeResumePlan({
                        directory: '/repo-target-prepare-retry-six',
                        resume: 'claude_session_target',
                        transcriptStorage: 'persisted',
                    }),
                }),
                directPeerTransfer: {
                    publishTransfer: vi.fn(() => []),
                    requestPayloadFile,
                    clearPublishedTransfer: vi.fn(),
                },
            });

            const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
            const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
            expect(prepare).toBeDefined();
            expect(resultGet).toBeDefined();

            const result = await prepare!({
                handoffId: 'handoff_direct_peer_prepare_retry_six_attempts',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                negotiatedTransportStrategy: 'direct_peer',
                sourceSessionStorageMode: 'persisted',
                targetPath: '/repo-prepare-retry-six',
                endpointCandidates: [agentBundleEndpointCandidate],
                workspaceTransfer: {
                    enabled: true,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
                handoffMetadataV2: {
                    agentBundleTransferPublication: {
                        transferId: agentBundleTransferId,
                        sizeBytes: agentBundlePayload.byteLength,
                        manifestHash: computeManifestHash(agentBundlePayload),
                        endpointCandidates: [agentBundleEndpointCandidate],
                    },
                    workspaceReplicationSourceRootPath: '/repo-prepare-retry-six',
                    workspaceReplicationManifestTransferPublication: {
                        transferId: workspaceManifestTransferId,
                        endpointCandidates: [workspaceManifestEndpointCandidate],
                    },
                },
            });

            expect(result).toMatchObject({
                handoffId: 'handoff_direct_peer_prepare_retry_six_attempts',
                status: expect.objectContaining({
                    status: 'pending',
                    transportStrategy: 'direct_peer',
                }),
            });

            await vi.waitFor(() => {
                expect(requestAttemptsByTransferId.get(agentBundleTransferId)).toBe(7);
            }, { timeout: 10_000 });

            await vi.waitFor(async () => {
                const ready = await resultGet!({
                    handoffId: 'handoff_direct_peer_prepare_retry_six_attempts',
                });
                expect(ready).toMatchObject({
                    handoffId: 'handoff_direct_peer_prepare_retry_six_attempts',
                    status: expect.objectContaining({
                        status: 'ready_for_cutover',
                        transportStrategy: 'direct_peer',
                    }),
                    resume: expect.objectContaining({
                        resume: 'claude_session_target',
                    }),
                });
            }, { timeout: 20_000 });

            expect(requestAttemptsByTransferId.get(agentBundleTransferId)).toBe(7);
            expect(requestAttemptsByTransferId.get(workspaceManifestTransferId)).toBe(7);
        } finally {
            await disposeTransferPayloadSource(workspaceManifestSource);
        }
    });

    it('waits for a workspace direct-peer requestPayloadFile handle to become available before failing prepare-target', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const agentBundleTransferId = 'session-handoff:handoff_direct_peer_request_payload_handle_late:provider-bundle-file';
        const workspaceManifestTransferId = 'session-handoff:handoff_direct_peer_request_payload_handle_late:workspace-manifest';
        const agentBundlePayload = Buffer.from(JSON.stringify({
            agentId: 'claude',
            remoteSessionId: 'claude_session_target',
            transcriptBase64: 'e30K',
        }), 'utf8');
        const workspaceManifestSource = await createWorkspaceReplicationManifestPayloadSource({
            manifest: {
                entries: [],
                fingerprint: `sha256:${'e'.repeat(64)}`,
            },
        });
        try {
            const requestAttemptsByTransferId = new Map<string, number>();
            let requestPayloadFileAccessCount = 0;
            const directPeerTransfer = {
                publishTransfer: vi.fn(() => []),
                clearPublishedTransfer: vi.fn(),
            };
            Object.defineProperty(directPeerTransfer, 'requestPayloadFile', {
                configurable: true,
                enumerable: true,
                get() {
                    requestPayloadFileAccessCount += 1;
                    if (requestPayloadFileAccessCount < 4) {
                        return undefined;
                    }
                    return vi.fn(async (input: Readonly<{
                        transferId: string;
                        endpointCandidates: readonly TransferEndpointCandidate[];
                        destinationPath: string;
                    }>) => {
                        const attemptNumber = (requestAttemptsByTransferId.get(input.transferId) ?? 0) + 1;
                        requestAttemptsByTransferId.set(input.transferId, attemptNumber);
                        if (input.transferId === agentBundleTransferId) {
                            await writeFile(input.destinationPath, agentBundlePayload);
                            return { destinationPath: input.destinationPath };
                        }
                        if (input.transferId === workspaceManifestTransferId) {
                    await copyFile(
                        requireFileTransferPayloadSourcePath(workspaceManifestSource, 'delayed-handle workspace manifest'),
                        input.destinationPath,
                    );
                            return { destinationPath: input.destinationPath };
                        }
                        throw new Error(`Unexpected direct peer transfer: ${input.transferId}`);
                    });
                },
            });

            const agentBundleEndpointCandidate = buildDirectPeerEndpointCandidate({
                transferId: agentBundleTransferId,
                expiresAt: Date.now() + 30_000,
            });
            const workspaceManifestEndpointCandidate = buildDirectPeerEndpointCandidate({
                transferId: workspaceManifestTransferId,
                expiresAt: Date.now() + 30_000,
            });
            const rpcHandlerManager = {
                registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                    registered.set(method, handler);
                },
            } as any;

            registerMachineSessionHandoffRpcHandlers({
                rpcHandlerManager,
                importSessionBundle: async () => ({
                    remoteSessionId: 'claude_session_target',
                    directSource: {
                        kind: 'claudeConfig',
                        configDir: null,
                        projectId: null,
                    },
                    resume: buildClaudeResumePlan({
                        directory: '/repo-target-request-handle',
                        resume: 'claude_session_target',
                        transcriptStorage: 'persisted',
                    }),
                }),
                directPeerTransfer,
            });

            const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
            const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
            expect(prepare).toBeDefined();
            expect(resultGet).toBeDefined();

            const result = await prepare!({
                handoffId: 'handoff_direct_peer_request_payload_handle_late',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                negotiatedTransportStrategy: 'direct_peer',
                sourceSessionStorageMode: 'persisted',
                targetPath: '/repo-request-handle',
                endpointCandidates: [agentBundleEndpointCandidate],
                workspaceTransfer: {
                    enabled: true,
                    strategy: 'sync_changes',
                    conflictPolicy: 'replace_existing',
                    includeIgnoredMode: 'exclude',
                    ignoredIncludeGlobs: [],
                },
                handoffMetadataV2: {
                    agentBundleTransferPublication: {
                        transferId: agentBundleTransferId,
                        sizeBytes: agentBundlePayload.byteLength,
                        manifestHash: computeManifestHash(agentBundlePayload),
                        endpointCandidates: [agentBundleEndpointCandidate],
                    },
                    workspaceReplicationSourceRootPath: '/repo-request-handle',
                    workspaceReplicationManifestTransferPublication: {
                        transferId: workspaceManifestTransferId,
                        endpointCandidates: [workspaceManifestEndpointCandidate],
                    },
                },
            });

            expect(result).toMatchObject({
                handoffId: 'handoff_direct_peer_request_payload_handle_late',
                status: expect.objectContaining({
                    status: 'pending',
                    transportStrategy: 'direct_peer',
                }),
            });

            await vi.waitFor(async () => {
                const ready = await resultGet!({
                    handoffId: 'handoff_direct_peer_request_payload_handle_late',
                });
                expect(ready).toMatchObject({
                    handoffId: 'handoff_direct_peer_request_payload_handle_late',
                    status: expect.objectContaining({
                        status: 'ready_for_cutover',
                        transportStrategy: 'direct_peer',
                    }),
                    resume: expect.objectContaining({
                        resume: 'claude_session_target',
                    }),
                });
            }, { timeout: 15_000 });

            expect(requestPayloadFileAccessCount).toBeGreaterThanOrEqual(4);
            expect(requestAttemptsByTransferId.get(agentBundleTransferId)).toBeGreaterThanOrEqual(1);
            expect(requestAttemptsByTransferId.get(workspaceManifestTransferId)).toBeGreaterThanOrEqual(1);
        } finally {
            await disposeTransferPayloadSource(workspaceManifestSource);
        }
    });

  it('fails closed instead of silently server-routing when the direct-peer transfer payload is invalid', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const { requestPayloadFile, dispose } = await createDirectPeerRequestPayloadFile({
            payload: Buffer.from('{', 'utf8'),
        });
        const sendEnvelope = vi.fn();
        const listeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
        const rpcHandlerManager = {
            registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
                registered.set(method, handler);
            },
        } as any;

        registerMachineSessionHandoffRpcHandlers({
            rpcHandlerManager,
            machineTransferChannel: {
                onEnvelope(listener) {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                sendEnvelope,
            },
            directPeerTransfer: {
                publishTransfer: vi.fn(() => []),
                requestPayloadFile,
                clearPublishedTransfer: vi.fn(),
            },
        });

    try {
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      expect(prepare).toBeDefined();

            const agentBundleTransferId = 'session-handoff:handoff_direct_peer_invalid_payload:provider-bundle-file';
            const endpointCandidate = buildDirectPeerEndpointCandidate({
                transferId: 'handoff_direct_peer',
                expiresAt: Date.now() + 30_000,
            });

      const prepareResult = await prepare!({
        handoffId: 'handoff_direct_peer_invalid_payload',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        endpointCandidates: [endpointCandidate],
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: agentBundleTransferId,
            sizeBytes: 0,
            manifestHash: `sha256:${'0'.repeat(64)}`,
            endpointCandidates: [endpointCandidate],
          },
        },
      }).catch((error) => error);

      if (prepareResult instanceof Error) {
        expect(prepareResult.message).toContain('Invalid session handoff transfer payload');
      } else {
        expect(prepareResult).toMatchObject({
          handoffId: 'handoff_direct_peer_invalid_payload',
          status: expect.objectContaining({
            status: 'pending',
            transportStrategy: 'direct_peer',
          }),
        });
      }

      expect(requestPayloadFile).toHaveBeenCalledTimes(1);
      expect(requestPayloadFile).toHaveBeenCalledWith(expect.objectContaining({
        transferId: agentBundleTransferId,
        expectedSizeBytes: 0,
        expectedManifestHash: `sha256:${'0'.repeat(64)}`,
      }));
      expect(sendEnvelope).not.toHaveBeenCalled();
        } finally {
            await dispose();
        }
  });

  it('fails closed instead of probing later candidates when a direct-peer candidate returns an invalid file-backed payload', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const { requestPayloadFile, dispose } = await createDirectPeerRequestPayloadFile({
      payload: Buffer.from('{', 'utf8'),
    });
    const sendEnvelope = vi.fn();
    const listeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      machineTransferChannel: {
        onEnvelope(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sendEnvelope,
      },
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayloadFile,
        clearPublishedTransfer: vi.fn(),
      },
    });

    try {
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const agentBundleTransferId = 'session-handoff:handoff_direct_peer_invalid_json_payload:provider-bundle-file';
      const endpointCandidates = [
        buildDirectPeerEndpointCandidate({
          transferId: 'candidate-1',
          port: 46001,
          expiresAt: Date.now() + 30_000,
        }),
        buildDirectPeerEndpointCandidate({
          transferId: 'candidate-2',
          port: 46002,
          expiresAt: Date.now() + 30_000,
        }),
      ];

      const prepareResult = await prepare!({
        handoffId: 'handoff_direct_peer_invalid_json_payload',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        endpointCandidates,
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: agentBundleTransferId,
            sizeBytes: 0,
            manifestHash: `sha256:${'0'.repeat(64)}`,
            endpointCandidates,
          },
        },
      }).catch((error) => error);

      if (prepareResult instanceof Error) {
        expect(prepareResult.message).toContain('Invalid session handoff transfer payload');
      } else {
        expect(prepareResult).toMatchObject({
          handoffId: 'handoff_direct_peer_invalid_json_payload',
          status: expect.objectContaining({
            status: 'pending',
            transportStrategy: 'direct_peer',
          }),
        });
      }

      expect(requestPayloadFile).toHaveBeenCalledTimes(1);
      expect(sendEnvelope).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('does not reuse direct-peer route-unavailable cache state across different server ids', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;
    const machineTransferChannel = {
      serverId: 'server_a',
      onEnvelope: () => () => {},
      sendEnvelope: vi.fn(),
    } as MachineTransferChannel & { serverId: string };
    const agentBundlePayload = Buffer.from(JSON.stringify({
      agentId: 'claude',
      remoteSessionId: 'claude_session_source',
      transcriptBase64: 'e30K',
    }), 'utf8');
    const requestPayloadFile = vi.fn(async ({ destinationPath }: Readonly<{ destinationPath: string }>) => {
      if (machineTransferChannel.serverId === 'server_a') {
        throw new Error('direct peer unavailable on server_a');
      }
      await writeFile(destinationPath, agentBundlePayload);
      return { destinationPath };
    });

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      machineTransferChannel,
      importSessionBundle: vi.fn(async () => ({
        remoteSessionId: 'claude_session_target',
        directSource: {
          kind: 'claudeConfig',
          configDir: null,
          projectId: null,
        },
        resume: buildClaudeResumePlan({
          directory: '/repo-target',
          resume: 'claude_session_target',
          transcriptStorage: 'persisted',
        }),
      })),
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayloadFile,
        clearPublishedTransfer: vi.fn(),
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
    const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
    expect(prepare).toBeDefined();
    expect(resultGet).toBeDefined();

    const agentBundleTransferId = 'session-handoff:handoff_direct_peer_server_scoped_cache:provider-bundle-file';
    const endpointCandidate = buildDirectPeerEndpointCandidate({
      transferId: 'handoff_direct_peer_server_scoped_cache',
      expiresAt: Date.now() + 30_000,
    });

    const firstPrepare = await prepare!({
      handoffId: 'handoff_direct_peer_server_scoped_cache_server_a',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      allowServerRoutedFallback: false,
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [endpointCandidate],
      handoffMetadataV2: {
        agentBundleTransferPublication: {
          transferId: agentBundleTransferId,
          sizeBytes: agentBundlePayload.byteLength,
          manifestHash: computeManifestHash(agentBundlePayload),
          endpointCandidates: [endpointCandidate],
        },
      },
    });

    expect(firstPrepare).toMatchObject({
      handoffId: 'handoff_direct_peer_server_scoped_cache_server_a',
      status: expect.objectContaining({
        status: 'pending',
        transportStrategy: 'direct_peer',
      }),
    });

    await vi.waitFor(async () => {
      await expect(resultGet!({
        handoffId: 'handoff_direct_peer_server_scoped_cache_server_a',
      })).resolves.toEqual({
        ok: false,
        errorCode: 'direct_peer_transfer_unavailable',
        error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
      });
    });

    machineTransferChannel.serverId = 'server_b';

    const secondPrepare = await prepare!({
      handoffId: 'handoff_direct_peer_server_scoped_cache_server_b',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      allowServerRoutedFallback: false,
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [endpointCandidate],
      handoffMetadataV2: {
        agentBundleTransferPublication: {
          transferId: agentBundleTransferId,
          sizeBytes: agentBundlePayload.byteLength,
          manifestHash: computeManifestHash(agentBundlePayload),
          endpointCandidates: [endpointCandidate],
        },
      },
    });

    let ready = secondPrepare;
    if (!('status' in ready) || ready.status.status !== 'ready_for_cutover') {
      await vi.waitFor(async () => {
        const next = await resultGet!({
          handoffId: 'handoff_direct_peer_server_scoped_cache_server_b',
        });
        expect(next).toMatchObject({
          handoffId: 'handoff_direct_peer_server_scoped_cache_server_b',
          status: expect.objectContaining({
            status: 'ready_for_cutover',
          }),
        });
        ready = next;
      });
    }

    expect(ready).toMatchObject({
      handoffId: 'handoff_direct_peer_server_scoped_cache_server_b',
      status: expect.objectContaining({
        status: 'ready_for_cutover',
        transportStrategy: 'direct_peer',
      }),
      remoteSessionId: 'claude_session_target',
    });
    expect(requestPayloadFile).toHaveBeenCalledTimes(2);
  });
});
