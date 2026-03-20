import { access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
  MachineTransferReceiveEnvelope,
  SessionHandoffResumePlan,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createEncryptedTransferChunkEnvelope } from '../../machines/transfer/transferChunkEncryption';
import type { SessionHandoffTransferredBundles } from '../../session/handoff/transfer/sessionHandoffTransferredBundles';
import { registerMachineSessionHandoffRpcHandlers } from './rpcHandlers.sessionHandoff';

type ExportSessionBundle = NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['exportSessionBundle']>;
type DirectPeerRequestPayload = NonNullable<
  NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['directPeerTransfer']>['requestPayload']
>;
type DirectPeerPublishTransfer = NonNullable<
  NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['directPeerTransfer']>['publishTransfer']
>;
type DirectPeerPublishPayload = Parameters<DirectPeerPublishTransfer>[0]['payload'];
type DirectPeerPublishPayloadSource = Parameters<DirectPeerPublishTransfer>[0]['payloadSource'];
type DirectPeerPublishPayloadHasWorkspaceBundle = 'workspaceBundle' extends keyof DirectPeerPublishPayload ? true : false;
type DirectPeerPublishProviderBundle = DirectPeerPublishPayload['providerBundle'];

describe('rpcHandlers (session handoff)', () => {
  it('keeps direct-peer publish input canonical inside the handoff RPC layer', () => {
    expectTypeOf<DirectPeerPublishPayload>().toEqualTypeOf<SessionHandoffTransferredBundles>();
    expectTypeOf<DirectPeerPublishPayloadSource>().toMatchTypeOf<
      | {
          kind: 'buffer';
        }
      | {
          kind: 'file';
        }
      | undefined
    >();
    expectTypeOf<DirectPeerPublishPayloadHasWorkspaceBundle>().toEqualTypeOf<false>();
    expectTypeOf<DirectPeerPublishProviderBundle>().not.toHaveProperty('codexBackendMode');
  });

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

  function expectOpenEnvelopeWithRecipient(
    sendEnvelope: ReturnType<typeof vi.fn>,
    transferId: string,
  ): string {
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

  function buildCodexResumePlan(params: Readonly<{
    directory: string;
    resume: string;
    transcriptStorage: 'direct' | 'persisted';
  }>): SessionHandoffResumePlan {
    return {
      directory: params.directory,
      agent: 'codex',
      resume: params.resume,
      transcriptStorage: params.transcriptStorage,
      approvedNewDirectoryCreation: true,
    };
  }

  it('registers daemon.sessionHandoff.* handlers', () => {
    const registered = new Map<string, unknown>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: unknown) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({ rpcHandlerManager });

    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_START)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET)).toBe(true);
  });

  it('uses the configured activeServerDir in the default handoff exporter', async () => {
    vi.resetModules();

    const exportSessionHandoffState = vi.fn(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      targetPath: '/repo',
    }));

    vi.doMock('@/configuration', () => ({
      configuration: {
        activeServerDir: '/tmp/happier-active-server',
      },
    }));
    vi.doMock('../../session/handoff/exportSessionHandoffState', () => ({
      exportSessionHandoffState,
    }));

    const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');

    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerHandlers({
      rpcHandlerManager,
      loadSessionMetadata: async () => ({
        machineId: 'machine_source',
        path: '/repo',
        flavor: 'claude',
        claudeSessionId: 'claude_session_1',
      }),
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    await start!({
      sessionId: 'sess_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
    });

    expect(exportSessionHandoffState).toHaveBeenCalledWith({
      metadata: {
        machineId: 'machine_source',
        path: '/repo',
        flavor: 'claude',
        claudeSessionId: 'claude_session_1',
      },
      activeServerDir: '/tmp/happier-active-server',
      workspaceTransfer: undefined,
    });
  });

  it('stops an active source session before exporting handoff state', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      targetPath: '/repo',
    }));
    const stopSessionForHandoff = vi.fn(async () => 'stopped' as const);
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
      exportSessionBundle,
      stopSessionForHandoff,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    const result = await start!({
      sessionId: 'sess_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
    });

    expect(result).toMatchObject({
      handoffId: expect.stringMatching(/^handoff_/),
      status: expect.objectContaining({
        recoveryActions: ['restart_on_source', 'keep_stopped'],
      }),
    });
    expect(stopSessionForHandoff).toHaveBeenCalledWith('sess_1');
    expect(stopSessionForHandoff.mock.invocationCallOrder[0]).toBeLessThan(
      exportSessionBundle.mock.invocationCallOrder[0]!,
    );
  });

  it('fails closed when stopping the active source session for handoff cutover fails', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      targetPath: '/repo',
    }));
    const stopSessionForHandoff = vi.fn(async () => 'failed' as const);
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
      exportSessionBundle,
      stopSessionForHandoff,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    await expect(
      start!({
        sessionId: 'sess_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'source_stop_failed',
      error: 'Failed to stop the active source session before handoff cutover',
    });

    expect(stopSessionForHandoff).toHaveBeenCalledWith('sess_1');
    expect(exportSessionBundle).not.toHaveBeenCalled();
  });

  it('returns recovery-capable start failure details when export fails after the active source session has already been stopped', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn(async () => {
      throw new Error('export failed');
    });
    const stopSessionForHandoff = vi.fn(async () => 'stopped' as const);
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
      exportSessionBundle,
      stopSessionForHandoff,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    const result = await start!({
      sessionId: 'sess_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'source_export_failed',
      error: 'export failed',
      handoffId: expect.stringMatching(/^handoff_/),
      status: {
        handoffId: expect.stringMatching(/^handoff_/),
        status: 'awaiting_recovery',
        phase: 'preparing',
        recoveryActions: ['restart_on_source', 'keep_stopped'],
      },
    });
    expect(stopSessionForHandoff).toHaveBeenCalledWith('sess_1');
    expect(stopSessionForHandoff.mock.invocationCallOrder[0]).toBeLessThan(
      exportSessionBundle.mock.invocationCallOrder[0]!,
    );
  });

  it('tracks handoff lifecycle state in memory across handlers', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_1',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: '/repo-copy',
        resume: 'claude_session_1',
        transcriptStorage: 'direct',
      }),
    }));
    const importWorkspaceBundle = vi.fn(async () => ({
      targetPath: '/repo-copy',
    }));
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
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: '/repo',
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobContentsByDigest: new Map([
            ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ]),
        },
      }),
      importSessionBundle,
      importWorkspaceBundle,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT);
    const status = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);

    expect(start).toBeDefined();
    expect(prepare).toBeDefined();
    expect(commit).toBeDefined();
    expect(status).toBeDefined();

    const started = await start!({
      sessionId: 'sess_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
    });

    expect(started.handoffId).toEqual(expect.any(String));
    expect(started.status.status).toBe('pending');
    expect(started.status.phase).toBe('preparing');
    expect(started.endpointCandidates).toEqual([]);
    expect(started.targetPath).toBe('/repo');

    const handoffId = started.handoffId;

    const prepared = await prepare!({
      handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    expect(prepared.status.status).toBe('ready_for_cutover');
    expect(prepared.status.transportStrategy).toBe('direct_peer');
    expect(prepared.remoteSessionId).toBe('claude_session_1');
    expect(importWorkspaceBundle).toHaveBeenCalledWith({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
      targetPath: '/repo',
      workspaceTransfer: undefined,
    });
    expect(importSessionBundle).toHaveBeenCalledWith(
      {
        providerId: 'claude',
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      '/repo-copy',
      'persisted',
    );
    expect(prepared.resume).toEqual({
      directory: '/repo-copy',
      agent: 'claude',
      resume: 'claude_session_1',
      transcriptStorage: 'direct',
      approvedNewDirectoryCreation: true,
    });

    const committed = await commit!({ handoffId });
    expect(committed.status.status).toBe('completed');
    expect(committed.status.phase).toBe('finalizing');

    const fetched = await status!({ handoffId });
    expect(fetched.status.status).toBe('completed');
    expect(fetched.status.phase).toBe('finalizing');
  });

  it('reuses stored source-export transferred bundles when preparing on the same daemon without re-sending inline payloads', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_1',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: '/repo-copy',
        resume: 'claude_session_1',
        transcriptStorage: 'persisted',
      }),
    }));
    const importWorkspaceBundle = vi.fn(async () => ({
      targetPath: '/repo-copy',
    }));
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
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: '/repo',
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobContentsByDigest: new Map([
            ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ]),
        },
      }),
      importSessionBundle,
      importWorkspaceBundle,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(start).toBeDefined();
    expect(prepare).toBeDefined();

    const started = await start!({
      sessionId: 'sess_same_daemon_prepare',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['server_routed_stream'],
      negotiatedTransportStrategy: 'server_routed_stream',
    });

    const prepared = await prepare!({
      handoffId: started.handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    expect(prepared.status.status).toBe('ready_for_cutover');
    expect(prepared.status.transportStrategy).toBe('server_routed_stream');
    expect(importWorkspaceBundle).toHaveBeenCalledWith({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
      targetPath: '/repo',
      workspaceTransfer: undefined,
    });
    expect(importSessionBundle).toHaveBeenCalledWith(
      {
        providerId: 'claude',
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      '/repo-copy',
      'persisted',
    );
  });

  it('reuses stored canonical workspace artifacts before prepare-time import', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_1',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: '/repo-copy',
        resume: 'claude_session_1',
        transcriptStorage: 'direct',
      }),
    }));
    const importWorkspaceBundle = vi.fn(async () => ({
      targetPath: '/repo-copy',
    }));
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
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: '/repo',
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobContentsByDigest: new Map([
            ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ]),
        },
      }),
      importSessionBundle,
      importWorkspaceBundle,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(start).toBeDefined();
    expect(prepare).toBeDefined();

    const started = await start!({
      sessionId: 'sess_legacy_start_bundle',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'direct_peer',
    });

    expect(started.endpointCandidates).toEqual([]);
    expect(started.targetPath).toBe('/repo');

    await prepare!({
      handoffId: started.handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    expect(importWorkspaceBundle).toHaveBeenCalledWith({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
      targetPath: '/repo',
      workspaceTransfer: undefined,
    });
  });

  it('persists canonical workspace replication artifacts across repeated target preparation retries', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_1',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: '/repo-copy',
        resume: 'claude_session_1',
        transcriptStorage: 'direct',
      }),
    }));
    const importWorkspaceBundle = vi.fn(async () => ({
      targetPath: '/repo-copy',
    }));
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
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: '/repo',
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobContentsByDigest: new Map([
            ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ]),
        },
      }),
      importSessionBundle,
      importWorkspaceBundle,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(start).toBeDefined();
    expect(prepare).toBeDefined();

    const started = await start!({
      sessionId: 'sess_retry',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer'],
      negotiatedTransportStrategy: 'direct_peer',
    });

    await prepare!({
      handoffId: started.handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    importWorkspaceBundle.mockClear();

    await prepare!({
      handoffId: started.handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    expect(importWorkspaceBundle).toHaveBeenCalledWith({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
      targetPath: '/repo',
      workspaceTransfer: undefined,
    });
  });

  it('reuses the stored canonical transferred bundles on a repeated direct-peer prepare retry after the first target import', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const requestPayload = vi.fn(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file' as const,
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
    }));
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      importSessionBundle,
      importWorkspaceBundle,
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayload,
        clearPublishedTransfer: vi.fn(),
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    await prepare!({
      handoffId: 'handoff_direct_peer_retry',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer_retry?token=test-token',
          expiresAt: Date.now() + 30_000,
        },
      ],
      allowServerRoutedFallback: false,
    });

    requestPayload.mockClear();
    importWorkspaceBundle.mockClear();
    importSessionBundle.mockClear();

    const retried = await prepare!({
      handoffId: 'handoff_direct_peer_retry',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer_retry?token=test-token',
          expiresAt: Date.now() - 1,
        },
      ],
      allowServerRoutedFallback: false,
    });

    expect(retried.status.status).toBe('ready_for_cutover');
    expect(retried.status.transportStrategy).toBe('direct_peer');
    expect(requestPayload).not.toHaveBeenCalled();
    expect(importWorkspaceBundle).toHaveBeenCalledWith({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
      targetPath: '/repo',
      workspaceTransfer: undefined,
    });
    expect(importSessionBundle).toHaveBeenCalledWith(
      {
        providerId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      '/repo-target',
      'persisted',
    );
  });

  it('marks the handoff awaiting recovery and reuses stored canonical bundles after a target import failure', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const requestPayload = vi.fn(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file' as const,
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
    }));
    const importSessionBundle = vi.fn()
      .mockRejectedValueOnce(new Error('session import failed'))
      .mockResolvedValueOnce({
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
      });
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      importSessionBundle,
      importWorkspaceBundle,
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayload,
        clearPublishedTransfer: vi.fn(),
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    const status = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
    expect(prepare).toBeDefined();
    expect(status).toBeDefined();

    await expect(prepare!({
      handoffId: 'handoff_direct_peer_retry_after_failure',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer_retry_after_failure?token=test-token',
          expiresAt: Date.now() + 30_000,
        },
      ],
      allowServerRoutedFallback: false,
    })).rejects.toThrow('session import failed');

    await expect(status!({
      handoffId: 'handoff_direct_peer_retry_after_failure',
    })).resolves.toEqual({
      handoffId: 'handoff_direct_peer_retry_after_failure',
      status: {
        handoffId: 'handoff_direct_peer_retry_after_failure',
        status: 'awaiting_recovery',
        phase: 'staging_target',
        transportStrategy: 'direct_peer',
        recoveryActions: [],
      },
    });

    requestPayload.mockClear();
    importWorkspaceBundle.mockClear();
    importSessionBundle.mockClear();

    const retried = await prepare!({
      handoffId: 'handoff_direct_peer_retry_after_failure',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer_retry_after_failure?token=test-token',
          expiresAt: Date.now() - 1,
        },
      ],
      allowServerRoutedFallback: false,
    });

    expect(retried.status.status).toBe('ready_for_cutover');
    expect(retried.status.transportStrategy).toBe('direct_peer');
    expect(requestPayload).not.toHaveBeenCalled();
    expect(importWorkspaceBundle).toHaveBeenCalledWith({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
      targetPath: '/repo',
      workspaceTransfer: undefined,
    });
  });

  it('returns invalid_request for malformed payloads', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({ rpcHandlerManager });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    await expect(start!({ targetMachineId: 'machine_target' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
    });
  });

  it('returns direct_peer_transfer_unavailable for direct-peer prepare payloads that omit endpoint candidates', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayload: vi.fn(),
        clearPublishedTransfer: vi.fn(),
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    await expect(prepare!({
      handoffId: 'handoff_missing_transfer_source',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'direct_peer_transfer_unavailable',
      error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
    });
  });

  it('omits inline bundles from the start response when server-routed transport is already negotiated', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
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
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: '/repo',
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobContentsByDigest: new Map([
            ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ]),
        },
      }),
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    const started = await start!({
      sessionId: 'sess_1',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'server_routed_stream',
    });

    expect(started).toMatchObject({
      handoffId: expect.any(String),
      targetPath: '/repo',
    });
    expect(started.transferredPayload).toBeUndefined();
    expect(started.workspaceBundle).toBeUndefined();
  });

  it('keeps start responses canonical when direct-peer transport is negotiated but unavailable locally', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
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
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: '/repo',
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobContentsByDigest: new Map([
            ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ]),
        },
      }),
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    const started = await start!({
      sessionId: 'sess_direct_peer_without_registry',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'direct_peer',
    });

    expect(started.endpointCandidates).toEqual([]);
    expect(started.targetPath).toBe('/repo');
    expect(started.transferredPayload).toBeUndefined();
  });

  it('keeps codex start responses canonical without inline transferred bundles', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
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
        flavor: 'codex',
        codexSessionId: 'thread_123',
      }),
      exportSessionBundle: async () => ({
        providerBundle: {
          providerId: 'codex',
          remoteSessionId: 'thread_123',
          affinity: {
            backendMode: 'appServer',
          },
          files: [
            {
              relativePath: 'sessions/2026/03/08/rollout-thread_123.jsonl',
              contentBase64: 'e30K',
            },
          ],
        },
        targetPath: '/repo',
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobContentsByDigest: new Map([
            ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ]),
        },
      }),
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    const started = await start!({
      sessionId: 'sess_codex_inline_canonical',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer'],
      negotiatedTransportStrategy: 'direct_peer',
    });

    expect(started.endpointCandidates).toEqual([]);
    expect(started.targetPath).toBe('/repo');
    expect(started.transferredPayload).toBeUndefined();
  });

  it('rejects workspace transfer from an unsafe source path before exporting bundles', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn<ExportSessionBundle>(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      targetPath: '/Users/tester',
    } satisfies Awaited<ReturnType<ExportSessionBundle>>));
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      loadSessionMetadata: async () => ({
        machineId: 'machine_source',
        path: '/Users/tester',
        homeDir: '/Users/tester',
        flavor: 'claude',
        claudeSessionId: 'claude_session_1',
      }),
      exportSessionBundle,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    await expect(
      start!({
        sessionId: 'sess_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        workspaceTransfer: {
          enabled: true,
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsafe_workspace_transfer_path',
      error: 'Workspace transfer is unavailable for this source path',
      reasonCode: 'path_is_home_directory',
    });

    expect(exportSessionBundle).not.toHaveBeenCalled();
  });

  it('rejects workspace transfer from an unsafe source path before exporting bundles when session metadata is missing homeDir', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn<ExportSessionBundle>(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      targetPath: os.homedir(),
    } satisfies Awaited<ReturnType<ExportSessionBundle>>));
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      loadSessionMetadata: async () => ({
        machineId: 'machine_source',
        path: os.homedir(),
        flavor: 'claude',
        claudeSessionId: 'claude_session_1',
      }),
      exportSessionBundle,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    await expect(
      start!({
        sessionId: 'sess_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        workspaceTransfer: {
          enabled: true,
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsafe_workspace_transfer_path',
      error: 'Workspace transfer is unavailable for this source path',
      reasonCode: 'path_is_home_directory',
    });

    expect(exportSessionBundle).not.toHaveBeenCalled();
  });

  it('starts handoff successfully when handoff requests the sync-changes workspace strategy', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn<ExportSessionBundle>(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      targetPath: '/Users/tester/projects/demo',
    } satisfies Awaited<ReturnType<ExportSessionBundle>>));
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      loadSessionMetadata: async () => ({
        machineId: 'machine_source',
        path: '/Users/tester/projects/demo',
        homeDir: '/Users/tester',
        flavor: 'claude',
        claudeSessionId: 'claude_session_1',
      }),
      exportSessionBundle,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    await expect(
      start!({
        sessionId: 'sess_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'create_sibling_copy',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      }),
    ).resolves.toMatchObject({
      handoffId: expect.stringMatching(/^handoff_/),
      targetPath: '/Users/tester/projects/demo',
      status: expect.objectContaining({
        status: 'pending',
        phase: 'preparing',
      }),
    });

    expect(exportSessionBundle).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine_source',
      path: '/Users/tester/projects/demo',
    }), {
      enabled: true,
      strategy: 'sync_changes',
      conflictPolicy: 'create_sibling_copy',
      includeIgnoredMode: 'exclude',
      ignoredIncludeGlobs: [],
    });
  });

  it('prepares the target from the fetched direct-peer payload even when the target daemon has no local handoff state', async () => {
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
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      importSessionBundle,
      importWorkspaceBundle: async () => ({ targetPath: '/repo-target' }),
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayload: vi.fn(async () => ({
          providerBundle: {
            providerId: 'claude' as const,
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          workspaceExportArtifacts: {
            manifest: {
              entries: [
                {
                  relativePath: 'README.md',
                  kind: 'file' as const,
                  digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                  sizeBytes: 6,
                  executable: false,
                },
              ],
              fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
            },
            blobContentsByDigest: new Map([
              ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
            ]),
          },
        })),
        clearPublishedTransfer: vi.fn(),
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    const prepared = await prepare!({
      handoffId: 'handoff_cross_machine',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_cross_machine?token=test-token',
          expiresAt: Date.now() + 30_000,
        },
      ],
    });

    expect(prepared).toEqual({
      handoffId: 'handoff_cross_machine',
      status: {
        handoffId: 'handoff_cross_machine',
        status: 'ready_for_cutover',
        phase: 'staging_target',
        transportStrategy: 'direct_peer',
        recoveryActions: [],
      },
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: {
        directory: '/repo-target',
        agent: 'claude',
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
        approvedNewDirectoryCreation: true,
      },
    });
    expect(importSessionBundle).toHaveBeenCalledWith(
      {
        providerId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      '/repo-target',
      'persisted',
    );
  });

  it('loads handoff bundles from the source machine over the transfer channel for server-routed prepare', async () => {
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
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
      importWorkspaceBundle,
      machineTransferChannel: {
        onEnvelope(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sendEnvelope,
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    const preparePromise = prepare!({
      handoffId: 'handoff_server_routed',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    const recipientPublicKeyBase64 = expectOpenEnvelopeWithRecipient(
      sendEnvelope,
      'session-handoff:handoff_server_routed',
    );

    const dispatchEnvelope = (payload: MachineTransferReceiveEnvelope) => {
      for (const listener of listeners) {
        listener(payload);
      }
    };
    expect(listeners.size).toBeGreaterThan(0);
    const serverRoutedPayload = Buffer.from(
      JSON.stringify({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        workspaceArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobs: [
            {
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              contentBase64: 'aGVsbG8K',
            },
          ],
        },
      }),
    );
    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: 'session-handoff:handoff_server_routed',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'session-handoff:handoff_server_routed',
          sequence: 0,
          payload: serverRoutedPayload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(3),
        }),
      },
    });
    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: 'session-handoff:handoff_server_routed',
        kind: 'finish',
        manifestHash: `sha256:${createHash('sha256').update(serverRoutedPayload).digest('hex')}`,
      },
    });

    const prepared = await preparePromise;

    expect(prepared.status.transportStrategy).toBe('server_routed_stream');
    expect(importWorkspaceBundle).toHaveBeenCalledWith({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
      targetPath: '/repo',
      workspaceTransfer: undefined,
    });
    expect(importSessionBundle).toHaveBeenCalledWith(
      {
        providerId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      '/repo-target',
      'persisted',
    );
  });

  it('loads the fetched server-routed transfer payload during prepare', async () => {
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
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
      importWorkspaceBundle,
      machineTransferChannel: {
        onEnvelope(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sendEnvelope,
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    const preparePromise = prepare!({
      handoffId: 'handoff_server_routed_prefers_transport',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    const recipientPublicKeyBase64 = expectOpenEnvelopeWithRecipient(
      sendEnvelope,
      'session-handoff:handoff_server_routed_prefers_transport',
    );

    const dispatchEnvelope = (payload: MachineTransferReceiveEnvelope) => {
      for (const listener of listeners) {
        listener(payload);
      }
    };
    const serverRoutedPayload = Buffer.from(
      JSON.stringify({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        workspaceArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobs: [
            {
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              contentBase64: 'aGVsbG8K',
            },
          ],
        },
      }),
    );

    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: 'session-handoff:handoff_server_routed_prefers_transport',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'session-handoff:handoff_server_routed_prefers_transport',
          sequence: 0,
          payload: serverRoutedPayload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(5),
        }),
      },
    });
    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: 'session-handoff:handoff_server_routed_prefers_transport',
        kind: 'finish',
        manifestHash: `sha256:${createHash('sha256').update(serverRoutedPayload).digest('hex')}`,
      },
    });

    await preparePromise;

    expect(importWorkspaceBundle).toHaveBeenCalledWith({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
      targetPath: '/repo',
      workspaceTransfer: undefined,
    });
    expect(importSessionBundle).toHaveBeenCalledWith(
      {
        providerId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      '/repo-target',
      'persisted',
    );
  });

  it('fails closed when the server-routed transfer is unavailable during prepare', async () => {
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
    const listeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      importSessionBundle,
      importWorkspaceBundle,
      machineTransferChannel: {
        onEnvelope(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sendEnvelope(payload) {
          if (payload.envelope.kind !== 'open') {
            return;
          }

          for (const listener of listeners) {
            listener({
              sourceMachineId: payload.targetMachineId,
              targetMachineId: 'machine_target',
              envelope: {
                transferId: payload.envelope.transferId,
                kind: 'abort',
                reason: `transfer_not_found:${payload.envelope.transferId}`,
              },
            });
          }
        },
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    await expect(prepare!({
      handoffId: 'handoff_server_routed_inline_fallback',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    })).rejects.toThrow(
      'Machine transfer aborted: transfer_not_found:session-handoff:handoff_server_routed_inline_fallback',
    );
    expect(importWorkspaceBundle).not.toHaveBeenCalled();
    expect(importSessionBundle).not.toHaveBeenCalled();
  });

  it('does not reuse legacy workspace-bundle-only inline payloads as server-routed fallback state', async () => {
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
    const listeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      importSessionBundle,
      importWorkspaceBundle,
      machineTransferChannel: {
        onEnvelope(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sendEnvelope(payload) {
          if (payload.envelope.kind !== 'open') {
            return;
          }

          for (const listener of listeners) {
            listener({
              sourceMachineId: payload.targetMachineId,
              targetMachineId: 'machine_target',
              envelope: {
                transferId: payload.envelope.transferId,
                kind: 'abort',
                reason: `transfer_not_found:${payload.envelope.transferId}`,
              },
            });
          }
        },
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    await expect(prepare!({
      handoffId: 'handoff_server_routed_legacy_inline_fallback',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'claude_session_inline',
        transcriptBase64: 'e30K',
      },
      workspaceBundle: {
        manifestHash: 'sha256:legacy-inline-workspace',
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file',
            contentBase64: 'aGVsbG8K',
          },
        ],
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
    });

    expect(importWorkspaceBundle).not.toHaveBeenCalled();
    expect(importSessionBundle).not.toHaveBeenCalled();
  });

  it('fails closed when server-routed prepare receives a malformed transfer payload', async () => {
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
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
      importWorkspaceBundle,
      machineTransferChannel: {
        onEnvelope(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sendEnvelope,
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    const preparePromise = prepare!({
      handoffId: 'handoff_invalid_server_routed_inline_fallback',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    const recipientPublicKeyBase64 = expectOpenEnvelopeWithRecipient(
      sendEnvelope,
      'session-handoff:handoff_invalid_server_routed_inline_fallback',
    );

    const malformedServerRoutedPayload = Buffer.from('{"providerBundle":', 'utf8');

    for (const listener of listeners) {
      listener({
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        envelope: {
          transferId: 'session-handoff:handoff_invalid_server_routed_inline_fallback',
          kind: 'chunk',
          sequence: 0,
          ...createEncryptedTransferChunkEnvelope({
            transferId: 'session-handoff:handoff_invalid_server_routed_inline_fallback',
            sequence: 0,
            payload: malformedServerRoutedPayload,
            recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(7),
          }),
        },
      });
      listener({
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        envelope: {
          transferId: 'session-handoff:handoff_invalid_server_routed_inline_fallback',
          kind: 'finish',
          manifestHash: `sha256:${createHash('sha256').update(malformedServerRoutedPayload).digest('hex')}`,
        },
      });
    }

    await expect(preparePromise).rejects.toThrow('Invalid session handoff transfer payload');
    expect(importWorkspaceBundle).not.toHaveBeenCalled();
    expect(importSessionBundle).not.toHaveBeenCalled();
  });

  it('fails closed when the server-routed transfer payload does not satisfy the canonical handoff schemas', async () => {
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
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
      importWorkspaceBundle,
      machineTransferChannel: {
        onEnvelope(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sendEnvelope,
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    const preparePromise = prepare!({
      handoffId: 'handoff_invalid_server_routed',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    const recipientPublicKeyBase64 = expectOpenEnvelopeWithRecipient(
      sendEnvelope,
      'session-handoff:handoff_invalid_server_routed',
    );

    const dispatchEnvelope = (payload: MachineTransferReceiveEnvelope) => {
      for (const listener of listeners) {
        listener(payload);
      }
    };
    const invalidServerRoutedPayload = Buffer.from(
      JSON.stringify({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
        },
      }),
    );

    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: 'session-handoff:handoff_invalid_server_routed',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'session-handoff:handoff_invalid_server_routed',
          sequence: 0,
          payload: invalidServerRoutedPayload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(9),
        }),
      },
    });
    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: 'session-handoff:handoff_invalid_server_routed',
        kind: 'finish',
        manifestHash: `sha256:${createHash('sha256').update(invalidServerRoutedPayload).digest('hex')}`,
      },
    });

    await expect(preparePromise).rejects.toThrow('Invalid session handoff transfer payload');
    expect(importWorkspaceBundle).not.toHaveBeenCalled();
    expect(importSessionBundle).not.toHaveBeenCalled();
  });

  it('fails closed when the server-routed transfer payload omits blob content required by workspace artifacts', async () => {
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
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
      importWorkspaceBundle,
      machineTransferChannel: {
        onEnvelope(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sendEnvelope,
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    const preparePromise = prepare!({
      handoffId: 'handoff_invalid_server_routed_workspace_artifacts',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    const recipientPublicKeyBase64 = expectOpenEnvelopeWithRecipient(
      sendEnvelope,
      'session-handoff:handoff_invalid_server_routed_workspace_artifacts',
    );

    const dispatchEnvelope = (payload: MachineTransferReceiveEnvelope) => {
      for (const listener of listeners) {
        listener(payload);
      }
    };
    const invalidServerRoutedPayload = Buffer.from(
      JSON.stringify({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        workspaceArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:blob_missing',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:manifest_missing_blob',
          },
          blobs: [],
        },
      }),
    );

    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: 'session-handoff:handoff_invalid_server_routed_workspace_artifacts',
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: 'session-handoff:handoff_invalid_server_routed_workspace_artifacts',
          sequence: 0,
          payload: invalidServerRoutedPayload,
          recipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(11),
        }),
      },
    });
    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: 'session-handoff:handoff_invalid_server_routed_workspace_artifacts',
        kind: 'finish',
        manifestHash: `sha256:${createHash('sha256').update(invalidServerRoutedPayload).digest('hex')}`,
      },
    });

    await expect(preparePromise).rejects.toThrow('Invalid session handoff transfer payload');
    expect(importWorkspaceBundle).not.toHaveBeenCalled();
    expect(importSessionBundle).not.toHaveBeenCalled();
  });

  it('publishes direct-peer endpoint candidates on start and reuses same-daemon transferred bundles before re-requesting them', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const requestPayload = vi.fn(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file' as const,
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
    }));
    const publishTransfer = vi.fn(
      (_params: Readonly<{
        transferId: string;
        payload: SessionHandoffTransferredBundles;
        payloadSource?: DirectPeerPublishPayloadSource;
      }>): readonly TransferEndpointCandidate[] => [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer?token=test-token',
          expiresAt: Date.now() + 30_000,
        },
      ],
    );
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
        claudeSessionId: 'claude_session_source',
      }),
      exportSessionBundle: async () => ({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        targetPath: '/repo',
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file' as const,
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobContentsByDigest: new Map([
            ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ]),
        },
      }),
      importSessionBundle,
      importWorkspaceBundle: async () => ({ targetPath: '/repo-target' }),
      directPeerTransfer: {
        publishTransfer,
        requestPayload,
        clearPublishedTransfer: vi.fn(),
      },
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(start).toBeDefined();
    expect(prepare).toBeDefined();

    const started = await start!({
      sessionId: 'sess_direct_peer',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer'],
      negotiatedTransportStrategy: 'direct_peer',
    });

    expect(publishTransfer).toHaveBeenCalledWith({
      transferId: started.handoffId,
      payload: {
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
                sizeBytes: 6,
                executable: false,
              },
            ],
            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
          },
          blobContentsByDigest: new Map([
            ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
          ]),
        },
      },
      payloadSource: expect.objectContaining({
        kind: 'file',
        sizeBytes: expect.any(Number),
        manifestHash: expect.stringMatching(/^sha256:/),
      }),
    });
    const publishedPayloadSource = publishTransfer.mock.calls[0]?.[0]?.payloadSource;
    expect(publishedPayloadSource?.kind).toBe('file');
    if (publishedPayloadSource?.kind !== 'file') {
      throw new Error('Expected a file-backed direct-peer payload source');
    }
    await expect(access(publishedPayloadSource.filePath)).resolves.toBeUndefined();
    expect(started.endpointCandidates).toEqual([
      {
        kind: 'http',
        url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer?token=test-token',
        expiresAt: expect.any(Number),
      },
    ]);
    expect(started.transferredPayload).toBeUndefined();

    const prepared = await prepare!({
      handoffId: started.handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: started.endpointCandidates,
    });

    expect(requestPayload).not.toHaveBeenCalled();
    expect(prepared.status.transportStrategy).toBe('direct_peer');
    expect(importSessionBundle).toHaveBeenCalledWith(
      {
        providerId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      '/repo-target',
      'persisted',
    );

    const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT);
    expect(commit).toBeDefined();
    await commit!({ handoffId: started.handoffId });
    await expect(access(publishedPayloadSource.filePath)).rejects.toThrow();
  });

  it('fails closed when a source export leaks a legacy codex backend field instead of canonical affinity', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const publishTransfer = vi.fn(
      (_params: Readonly<{ transferId: string; payload: SessionHandoffTransferredBundles }>): readonly TransferEndpointCandidate[] => [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_codex_legacy_provider?token=test-token',
          expiresAt: Date.now() + 30_000,
        },
      ],
    );
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
        flavor: 'codex',
        codexSessionId: 'thread_legacy',
      }),
      exportSessionBundle: async () => ({
        providerBundle: {
          providerId: 'codex',
          remoteSessionId: 'thread_legacy',
          codexBackendMode: 'appServer',
          files: [
            {
              relativePath: 'sessions/2026/03/08/rollout-thread_legacy.jsonl',
              contentBase64: 'e30K',
            },
          ],
        },
        targetPath: '/repo',
      }),
      directPeerTransfer: {
        publishTransfer,
        clearPublishedTransfer: vi.fn(),
      },
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    await expect(start!({
      sessionId: 'sess_codex_legacy_provider',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer'],
      negotiatedTransportStrategy: 'direct_peer',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'source_export_failed',
      error: 'Invalid session handoff transfer payload',
    });

    expect(publishTransfer).not.toHaveBeenCalled();
  });

  it('prefers the fetched direct-peer transfer payload during target preparation', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const requestPayload = vi.fn(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file' as const,
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
    }));
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      importSessionBundle,
      importWorkspaceBundle,
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayload,
        clearPublishedTransfer: vi.fn(),
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    await prepare!({
      handoffId: 'handoff_direct_peer_artifacts',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer_artifacts?token=test-token',
          expiresAt: Date.now() + 30_000,
        },
      ],
    });

    expect(importWorkspaceBundle).toHaveBeenCalledWith({
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
        },
        blobContentsByDigest: new Map([
          ['sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03', Buffer.from('hello\n', 'utf8')],
        ]),
      },
      targetPath: '/repo',
      workspaceTransfer: undefined,
    });
    expect(importSessionBundle).toHaveBeenCalledWith(
      {
        providerId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      '/repo-target',
      'persisted',
    );
  });

  it('fails closed when the direct-peer transfer payload does not satisfy the canonical handoff schemas', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const invalidDirectPeerPayload: unknown = {
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'claude_session_source',
      },
    };
    const requestPayload: DirectPeerRequestPayload = vi.fn(async () => invalidDirectPeerPayload as never);
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      importSessionBundle,
      importWorkspaceBundle,
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayload,
        clearPublishedTransfer: vi.fn(),
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    await expect(prepare!({
      handoffId: 'handoff_invalid_direct_peer_payload',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_invalid_direct_peer_payload?token=test-token',
          expiresAt: Date.now() + 30_000,
        },
      ],
    })).rejects.toThrow('Invalid session handoff transfer payload');

    expect(importWorkspaceBundle).not.toHaveBeenCalled();
    expect(importSessionBundle).not.toHaveBeenCalled();
  });

  it('fails closed when the direct-peer transfer payload omits blob content required by workspace artifacts', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const requestPayload: DirectPeerRequestPayload = vi.fn(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      workspaceExportArtifacts: {
        manifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file' as const,
              digest: 'sha256:blob_missing',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:manifest_missing_blob',
        },
        blobContentsByDigest: new Map(),
      },
    }));
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      importSessionBundle,
      importWorkspaceBundle,
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayload,
        clearPublishedTransfer: vi.fn(),
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    await expect(prepare!({
      handoffId: 'handoff_invalid_direct_peer_workspace_artifacts',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_invalid_direct_peer_workspace_artifacts?token=test-token',
          expiresAt: Date.now() + 30_000,
        },
      ],
    })).rejects.toThrow('Invalid session handoff transfer payload');

    expect(importWorkspaceBundle).not.toHaveBeenCalled();
    expect(importSessionBundle).not.toHaveBeenCalled();
  });

  it('returns a transport error instead of server-routed fallback when direct-peer transfer fails and fallback is forbidden', async () => {
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
      machineTransferChannel: {
        onEnvelope: () => () => {},
        sendEnvelope: vi.fn(),
      },
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayload,
        clearPublishedTransfer: vi.fn(),
      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    await expect(
      prepare!({
        handoffId: 'handoff_direct_peer_forbidden_fallback',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        allowServerRoutedFallback: false,
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        endpointCandidates: [
          {
            kind: 'http',
            url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_direct_peer?token=test-token',
            expiresAt: Date.now() + 30_000,
          },
        ],
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'direct_peer_transfer_unavailable',
      error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
    });

    expect(requestPayload).toHaveBeenCalledTimes(1);
  });
});
