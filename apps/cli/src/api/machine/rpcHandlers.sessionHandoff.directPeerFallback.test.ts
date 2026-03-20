import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { MachineTransferReceiveEnvelope, SessionHandoffResumePlan } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { requestTypedDirectPeerTransferPayload } from '../../machines/transfer/directPeerTransport';
import { createEncryptedTransferChunkEnvelope } from '../../machines/transfer/transferChunkEncryption';
import { registerMachineSessionHandoffRpcHandlers } from './rpcHandlers.sessionHandoff';
import { createSessionHandoffTransferredBundlesCodec } from '../../session/handoff/transfer/sessionHandoffTransferredBundles';
import type { SessionHandoffTransferredBundles } from '../../session/handoff/transfer/sessionHandoffTransferredBundles';

describe('rpcHandlers (session handoff direct-peer fallback)', () => {
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

    function expectOpenEnvelopeWithRecipient(sendEnvelope: ReturnType<typeof vi.fn>, transferId: string): string {
        expect(sendEnvelope).toHaveBeenCalledWith({
            targetMachineId: 'machine_source',
            envelope: expect.objectContaining({
                transferId,
                kind: 'open',
                manifestHash: transferId,
                recipientPublicKeyBase64: expect.any(String),
            }),
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
        const requestPayload = vi.fn(async () => {
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
            importWorkspaceBundle: async () => ({ targetPath: '/repo-target' }),
            machineTransferChannel: {
                onEnvelope(listener) {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                sendEnvelope,
            },
            directPeerTransfer: {
                publishTransfer: vi.fn(() => []),
                requestPayload,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
        expect(prepare).toBeDefined();

        const preparePromise = prepare!({
            handoffId: 'handoff_direct_peer_expired_candidates',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer?token=test-token',
                    expiresAt: Date.now() - 1,
                },
            ],
        });

        const recipientPublicKeyBase64 = expectOpenEnvelopeWithRecipient(
            sendEnvelope,
            'session-handoff:handoff_direct_peer_expired_candidates',
        );
        expect(requestPayload).not.toHaveBeenCalled();

        const serverRoutedPayload = Buffer.from(JSON.stringify({
            providerBundle: {
                providerId: 'claude',
                remoteSessionId: 'claude_session_source',
                transcriptBase64: 'e30K',
            },
        }), 'utf8');
        for (const listener of listeners) {
            listener({
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                envelope: {
                    transferId: 'session-handoff:handoff_direct_peer_expired_candidates',
                    kind: 'chunk',
                    sequence: 0,
                    ...createEncryptedTransferChunkEnvelope({
                        transferId: 'session-handoff:handoff_direct_peer_expired_candidates',
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
                    transferId: 'session-handoff:handoff_direct_peer_expired_candidates',
                    kind: 'finish',
                    manifestHash: computeManifestHash(serverRoutedPayload),
                },
            });
        }

        await expect(preparePromise).resolves.toMatchObject({
            handoffId: 'handoff_direct_peer_expired_candidates',
            status: expect.objectContaining({
                transportStrategy: 'server_routed_stream',
            }),
            remoteSessionId: 'claude_session_target',
        });
    });

    it('returns a transport error when all direct-peer endpoint candidates are expired and no server-routed fallback channel is available', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const requestPayload = vi.fn(async () => {
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
                requestPayload,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
        expect(prepare).toBeDefined();

        await expect(prepare!({
            handoffId: 'handoff_direct_peer_expired_candidates_no_fallback',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer?token=test-token',
                    expiresAt: Date.now() - 1,
                },
            ],
        })).resolves.toEqual({
            ok: false,
            errorCode: 'direct_peer_transfer_unavailable',
            error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
        });

        expect(requestPayload).not.toHaveBeenCalled();
    });

    it('returns a transport error when direct-peer transfer fails and no server-routed fallback channel is available', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const requestPayload = vi.fn(async () => {
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
                requestPayload,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
        expect(prepare).toBeDefined();

        await expect(prepare!({
            handoffId: 'handoff_direct_peer_failed_no_fallback',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer?token=test-token',
                    expiresAt: Date.now() + 30_000,
                },
            ],
        })).resolves.toEqual({
            ok: false,
            errorCode: 'direct_peer_transfer_unavailable',
            error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
        });

        expect(requestPayload).toHaveBeenCalledTimes(1);
    });

    it('suppresses an immediate retry after a direct-peer transport failure for the same source machine and endpoint set', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const requestPayload = vi.fn(async (_input: Readonly<{
            transferId: string;
            endpointCandidates: readonly {
                kind: 'http' | 'https' | 'tcp';
                url: string;
                expiresAt: number;
            }[];
        }>): Promise<SessionHandoffTransferredBundles> => {
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
                requestPayload,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
        expect(prepare).toBeDefined();

        await expect(prepare!({
            handoffId: 'handoff_direct_peer_cached_retry_a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer?token=test-token',
                    expiresAt: Date.now() + 30_000,
                },
            ],
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
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer?token=test-token',
                    expiresAt: Date.now() + 30_000,
                },
            ],
        })).resolves.toEqual({
            ok: false,
            errorCode: 'direct_peer_transfer_unavailable',
            error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
        });

        expect(requestPayload).toHaveBeenCalledTimes(1);
    });

  it('fails closed instead of silently server-routing when the direct-peer transfer payload is invalid', async () => {
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const requestPayload = vi.fn(async () => {
            throw new Error('Invalid session handoff transfer payload');
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
                requestPayload,
                clearPublishedTransfer: vi.fn(),
            },
        });

        const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
        expect(prepare).toBeDefined();

        await expect(prepare!({
            handoffId: 'handoff_direct_peer_invalid_payload',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            targetPath: '/repo',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer?token=test-token',
                    expiresAt: Date.now() + 30_000,
                },
            ],
        })).rejects.toThrow('Invalid session handoff transfer payload');

    expect(requestPayload).toHaveBeenCalledTimes(1);
    expect(sendEnvelope).not.toHaveBeenCalled();
  });

  it('fails closed instead of probing later candidates when a direct-peer candidate returns malformed json', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const requestPayload = vi.fn(async () => {
      return await requestTypedDirectPeerTransferPayload({
        transferId: 'handoff_direct_peer_invalid_json_payload',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/candidate-1?token=test-token',
            expiresAt: Date.now() + 30_000,
          },
          {
            kind: 'http',
            url: 'http://127.0.0.1:46002/session-handoffs/direct-transfer/candidate-2?token=test-token',
            expiresAt: Date.now() + 30_000,
          },
        ],
        fetchFn: async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes('candidate-1')) {
            return new Response('{"handoffId":', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }

          return new Response(JSON.stringify({
            handoffId: 'handoff_direct_peer_invalid_json_payload',
            providerBundle: {
              providerId: 'claude',
              remoteSessionId: 'claude_session_source',
              transcriptBase64: 'e30K',
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        codec: createSessionHandoffTransferredBundlesCodec({
          mapDecodeError: ({ transferId }) => new Error(`Invalid direct peer transfer response for ${transferId}`),
        }),
      });
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
        requestPayload,
        clearPublishedTransfer: vi.fn(),
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    await expect(prepare!({
      handoffId: 'handoff_direct_peer_invalid_json_payload',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/candidate-1?token=test-token',
          expiresAt: Date.now() + 30_000,
        },
        {
          kind: 'http',
          url: 'http://127.0.0.1:46002/session-handoffs/direct-transfer/candidate-2?token=test-token',
          expiresAt: Date.now() + 30_000,
        },
      ],
    })).rejects.toThrow('Invalid direct peer transfer response for handoff_direct_peer_invalid_json_payload');

    expect(requestPayload).toHaveBeenCalledTimes(1);
    expect(sendEnvelope).not.toHaveBeenCalled();
  });
});
