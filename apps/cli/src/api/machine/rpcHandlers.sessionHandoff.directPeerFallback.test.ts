import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import os from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import type { MachineTransferReceiveEnvelope, SessionHandoffResumePlan, TransferEndpointCandidate } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createEncryptedTransferChunkEnvelope } from '../../machines/transfer/transferChunkEncryption';
import { registerMachineSessionHandoffRpcHandlers } from './rpcHandlers.sessionHandoff';

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
            resume: params.resume,
            transcriptStorage: params.transcriptStorage,
            approvedNewDirectoryCreation: true,
        };
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

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
        const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
        expect(prepare).toBeDefined();
        expect(resultGet).toBeDefined();

        const providerBundleTransferId = 'session-handoff:handoff_direct_peer_expired_candidates:provider-bundle-file';
        const serverRoutedPayload = Buffer.from(JSON.stringify({
            providerId: 'claude',
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
                providerBundleTransferPublication: {
                    transferId: providerBundleTransferId,
                    sizeBytes: serverRoutedPayload.byteLength,
                    manifestHash: computeManifestHash(serverRoutedPayload),
                    endpointCandidates: [expiredCandidate],
                },
            },
        });

        const recipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(
            sendEnvelope,
            providerBundleTransferId,
        );
        expect(requestPayloadFile).not.toHaveBeenCalled();

        for (const listener of listeners) {
            listener({
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                envelope: {
                    transferId: providerBundleTransferId,
                    kind: 'chunk',
                    sequence: 0,
                    ...createEncryptedTransferChunkEnvelope({
                        transferId: providerBundleTransferId,
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
                    transferId: providerBundleTransferId,
                    kind: 'finish',
                    manifestHash: computeManifestHash(serverRoutedPayload),
                },
            });
        }

        const prepared = await preparePromise;
        expect(prepared).toMatchObject({
            handoffId: 'handoff_direct_peer_expired_candidates',
            status: expect.objectContaining({
                transportStrategy: 'server_routed_stream',
            }),
        });

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

    it('returns a transport error when all direct-peer endpoint candidates are expired and no server-routed fallback channel is available', async () => {
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

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
        expect(prepare).toBeDefined();

        const providerBundleTransferId = 'session-handoff:handoff_direct_peer_expired_candidates_no_fallback:provider-bundle-file';
        const expiredCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer',
            expiresAt: Date.now() - 1,
        });

        await expect(prepare!({
            handoffId: 'handoff_direct_peer_expired_candidates_no_fallback',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [expiredCandidate],
            handoffMetadataV2: {
                providerBundleTransferPublication: {
                    transferId: providerBundleTransferId,
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [expiredCandidate],
                },
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'direct_peer_transfer_unavailable',
            error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
        });

        expect(requestPayloadFile).not.toHaveBeenCalled();
    });

    it('treats a legacy requestPayload-only direct-peer adapter as unavailable when no server-routed fallback channel is available', async () => {
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

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
        expect(prepare).toBeDefined();

        const providerBundleTransferId = 'session-handoff:handoff_direct_peer_legacy_only_adapter:provider-bundle-file';
        const endpointCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer_legacy_only_adapter',
            expiresAt: Date.now() + 30_000,
        });

        await expect(prepare!({
            handoffId: 'handoff_direct_peer_legacy_only_adapter',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                providerBundleTransferPublication: {
                    transferId: providerBundleTransferId,
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [endpointCandidate],
                },
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'direct_peer_transfer_unavailable',
            error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
        });

        expect(legacyRequestPayload).not.toHaveBeenCalled();
    });

    it('returns a transport error when direct-peer transfer fails and no server-routed fallback channel is available', async () => {
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

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
        expect(prepare).toBeDefined();

        const providerBundleTransferId = 'session-handoff:handoff_direct_peer_failed_no_fallback:provider-bundle-file';
        const endpointCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer',
            expiresAt: Date.now() + 30_000,
        });

        await expect(prepare!({
            handoffId: 'handoff_direct_peer_failed_no_fallback',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                providerBundleTransferPublication: {
                    transferId: providerBundleTransferId,
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [endpointCandidate],
                },
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'direct_peer_transfer_unavailable',
            error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
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

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
        expect(prepare).toBeDefined();

        const endpointCandidate = buildDirectPeerEndpointCandidate({
            transferId: 'handoff_direct_peer',
            expiresAt: Date.now() + 30_000,
        });

        await expect(prepare!({
            handoffId: 'handoff_direct_peer_cached_retry_a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                providerBundleTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_cached_retry_a:provider-bundle-file',
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [endpointCandidate],
                },
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'direct_peer_transfer_unavailable',
            error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
        });

        await expect(prepare!({
            handoffId: 'handoff_direct_peer_cached_retry_b',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [endpointCandidate],
            handoffMetadataV2: {
                providerBundleTransferPublication: {
                    transferId: 'session-handoff:handoff_direct_peer_cached_retry_b:provider-bundle-file',
                    sizeBytes: 0,
                    manifestHash: `sha256:${'0'.repeat(64)}`,
                    endpointCandidates: [endpointCandidate],
                },
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'direct_peer_transfer_unavailable',
            error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
        });

        expect(requestPayloadFile).toHaveBeenCalledTimes(1);
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
            const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
            expect(prepare).toBeDefined();

            const providerBundleTransferId = 'session-handoff:handoff_direct_peer_invalid_payload:provider-bundle-file';
            const endpointCandidate = buildDirectPeerEndpointCandidate({
                transferId: 'handoff_direct_peer',
                expiresAt: Date.now() + 30_000,
            });

            await expect(prepare!({
                handoffId: 'handoff_direct_peer_invalid_payload',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                negotiatedTransportStrategy: 'direct_peer',
                sourceSessionStorageMode: 'persisted',
                targetPath: '/repo',
                endpointCandidates: [endpointCandidate],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: providerBundleTransferId,
                        sizeBytes: 0,
                        manifestHash: `sha256:${'0'.repeat(64)}`,
                        endpointCandidates: [endpointCandidate],
                    },
                },
            })).rejects.toThrow('Invalid session handoff transfer payload');

            expect(requestPayloadFile).toHaveBeenCalledTimes(1);
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
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      expect(prepare).toBeDefined();

      const providerBundleTransferId = 'session-handoff:handoff_direct_peer_invalid_json_payload:provider-bundle-file';
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

      await expect(prepare!({
        handoffId: 'handoff_direct_peer_invalid_json_payload',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        endpointCandidates,
        handoffMetadataV2: {
          providerBundleTransferPublication: {
            transferId: providerBundleTransferId,
            sizeBytes: 0,
            manifestHash: `sha256:${'0'.repeat(64)}`,
            endpointCandidates,
          },
        },
      })).rejects.toThrow('Invalid session handoff transfer payload');

      expect(requestPayloadFile).toHaveBeenCalledTimes(1);
      expect(sendEnvelope).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });
});
