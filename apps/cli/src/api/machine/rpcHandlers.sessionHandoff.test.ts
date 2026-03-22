import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  SessionHandoffResumePlan,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createEncryptedTransferChunkEnvelope } from '../../machines/transfer/transferChunkEncryption';
import type { SessionHandoffTransferredBundles } from '../../session/handoff/transfer/sessionHandoffTransferredBundles';
import {
  createSessionHandoffTransferredBundlesPayloadSource,
  sessionHandoffTransferredBundlesCodec,
} from '../../session/handoff/transfer/sessionHandoffTransferredBundles';
import { registerMachineSessionHandoffRpcHandlers } from './rpcHandlers.sessionHandoff';

type ExportSessionBundle = NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['exportSessionBundle']>;
type DirectPeerRequestPayloadFile = NonNullable<
  NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['directPeerTransfer']>['requestPayloadFile']
>;
type DirectPeerPublishTransfer = NonNullable<
  NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['directPeerTransfer']>['publishTransfer']
>;
type ImportWorkspaceBundleInput = Parameters<
  NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['importWorkspaceBundle']>
>[0];
type DirectPeerPublishPayload = Parameters<DirectPeerPublishTransfer>[0]['payload'];
type DirectPeerPublishPayloadSource = Parameters<DirectPeerPublishTransfer>[0]['payloadSource'];
type DirectPeerPublishPayloadHasWorkspaceBundle = 'workspaceBundle' extends keyof DirectPeerPublishPayload ? true : false;
type DirectPeerPublishPayloadHasProviderBundle = 'providerBundle' extends keyof DirectPeerPublishPayload ? true : false;
type LoopbackListener = (payload: MachineTransferReceiveEnvelope) => void;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createLegacyTransferredPayloadBuffer(params: Readonly<{
  providerBundle: {
    providerId: 'claude';
    remoteSessionId: string;
    transcriptBase64: string;
  };
  workspaceExportArtifacts?: Readonly<{
    manifest: Readonly<{
      entries: readonly Readonly<{
        relativePath: string;
        kind: 'file';
        digest: string;
        sizeBytes: number;
        executable: boolean;
      }>[];
      fingerprint: string;
    }>;
    blobContentsByDigest?: ReadonlyMap<string, Buffer>;
  }>;
}>): Buffer {
  return Buffer.from(JSON.stringify({
    providerBundle: params.providerBundle,
    ...(params.workspaceExportArtifacts
      ? {
          workspaceArtifacts: {
            manifest: params.workspaceExportArtifacts.manifest,
            blobs: [...(params.workspaceExportArtifacts.blobContentsByDigest ?? new Map()).entries()].map(
              ([digest, content]) => ({
                digest,
                contentBase64: Buffer.from(content).toString('base64'),
              }),
            ),
          },
        }
      : {}),
  }), 'utf8');
}

function createLoopbackMachineTransferChannels() {
  const listenersByMachine = new Map<string, Set<LoopbackListener>>();
  const sentEnvelopes: MachineTransferSendEnvelope[] = [];

  function createChannel(machineId: string) {
    return {
      onEnvelope(listener: LoopbackListener) {
        const listeners = listenersByMachine.get(machineId) ?? new Set<LoopbackListener>();
        listeners.add(listener);
        listenersByMachine.set(machineId, listeners);
        return () => {
          listeners.delete(listener);
        };
      },
      sendEnvelope(payload: MachineTransferSendEnvelope) {
        sentEnvelopes.push(payload);
        for (const listener of listenersByMachine.get(payload.targetMachineId) ?? []) {
          listener({
            sourceMachineId: machineId,
            targetMachineId: payload.targetMachineId,
            envelope: payload.envelope,
          });
        }
      },
    };
  }

  return {
    source: createChannel('machine_source'),
    target: createChannel('machine_target'),
    sentEnvelopes,
  };
}

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
    expectTypeOf<DirectPeerPublishPayloadHasProviderBundle>().toEqualTypeOf<false>();
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
          manifestHash: transferId,
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

  async function createDirectPeerRequestPayloadFile(params: Readonly<{
    payload: Buffer;
  }>): Promise<Readonly<{
    requestPayloadFile: ReturnType<typeof vi.fn<DirectPeerRequestPayloadFile>>;
    dispose: () => Promise<void>;
  }>> {
    const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-test-'));
    const payloadFilePath = join(temporaryDirectory, 'payload.bin');
    await writeFile(payloadFilePath, params.payload);
    return {
      requestPayloadFile: vi.fn(async ({ destinationPath }) => {
        await copyFile(payloadFilePath, destinationPath);
        return { destinationPath };
      }),
      dispose: async () => {
        await rm(temporaryDirectory, { recursive: true, force: true });
      },
    };
  }

  async function createPublishedDirectPeerPayloadRouter(): Promise<Readonly<{
    publishTransfer: ReturnType<typeof vi.fn<DirectPeerPublishTransfer>>;
    requestPayloadFile: ReturnType<typeof vi.fn<DirectPeerRequestPayloadFile>>;
    dispose: () => Promise<void>;
    listPublishedTransferIds: () => readonly string[];
  }>> {
    const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-published-'));
    const publishedPayloadPaths = new Map<string, string>();

    return {
      publishTransfer: vi.fn(({ transferId, payloadSource }) => {
        if (!payloadSource || payloadSource.kind !== 'file') {
          throw new Error(`Expected a file-backed direct-peer payload source for ${transferId}`);
        }
        publishedPayloadPaths.set(transferId, payloadSource.filePath);
        return [
          {
            kind: 'http' as const,
            url: `http://127.0.0.1:46001/session-handoffs/direct-transfer/${encodeURIComponent(transferId)}?token=${encodeURIComponent(`${transferId}-token`)}`,
            expiresAt: Date.now() + 30_000,
          },
        ];
      }),
      requestPayloadFile: vi.fn(async ({ transferId, destinationPath }) => {
        const publishedPayloadPath = publishedPayloadPaths.get(transferId);
        if (!publishedPayloadPath) {
          throw new Error(`Missing published direct-peer payload for ${transferId}`);
        }
        await copyFile(publishedPayloadPath, destinationPath);
        return { destinationPath };
      }),
      dispose: async () => {
        await rm(temporaryDirectory, { recursive: true, force: true });
      },
      listPublishedTransferIds: () => [...publishedPayloadPaths.keys()],
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
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET)).toBe(true);
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

  it('prefers live local runtime metadata without overwriting newer portable remote metadata when starting a handoff back', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn(async (metadata: Record<string, unknown>) => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: String(metadata.claudeSessionId),
        transcriptBase64: 'e30K',
      },
      targetPath: String(metadata.path),
    }));
    const publishTransfer = vi.fn(() => [
      {
        kind: 'http' as const,
        url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_back?token=test-token',
        expiresAt: Date.now() + 30_000,
      },
    ]);
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const registerParams = {
      rpcHandlerManager,
      loadSessionMetadata: async () => ({
        machineId: 'machine_source',
        path: '/repo-source-stale',
        homeDir: '/Users/source',
        flavor: 'claude',
        portableMetadataVersion: 'v2',
      }),
      exportSessionBundle,
      directPeerTransfer: {
        publishTransfer,
        clearPublishedTransfer: vi.fn(),
      },
      // Test-only forward-compat fixture: runtime will learn this hook in the green step.
      loadLocalSessionMetadata: async () => ({
        exportMetadata: {
          machineId: 'machine_target',
          path: '/repo-source-current',
          homeDir: '/Users/target',
          flavor: 'claude',
        },
        runtimeLocalMetadata: {
          claudeSessionId: 'sess-handoff-direct',
          directSessionV1: {
            v: 1,
            providerId: 'claude',
            machineId: 'machine_target',
            remoteSessionId: 'sess-handoff-direct',
            source: {
              kind: 'claudeConfig',
              configDir: '/tmp/claude-config',
              projectId: 'proj-handoff-direct',
            },
            linkedAtMs: 1,
          },
        },
      }),
    } as any;

    registerMachineSessionHandoffRpcHandlers(registerParams);

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    expect(start).toBeDefined();

    const result = await start!({
      sessionId: 'sess_handoff_back',
      sourceMachineId: 'machine_target',
      targetMachineId: 'machine_source',
      sessionStorageMode: 'direct',
      preferredTransportStrategies: ['direct_peer'],
      negotiatedTransportStrategy: 'direct_peer',
      workspaceTransfer: {
        enabled: true,
        strategy: 'sync_changes',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
    });

    expect(result).toMatchObject({
      handoffId: expect.any(String),
      status: expect.objectContaining({
        status: 'pending',
        phase: 'preparing',
      }),
      endpointCandidates: [
        {
          kind: 'http',
          url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_back?token=test-token',
          expiresAt: expect.any(Number),
        },
      ],
      targetPath: '/repo-source-current',
    });
    expect(exportSessionBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'machine_target',
        path: '/repo-source-current',
        homeDir: '/Users/target',
        portableMetadataVersion: 'v2',
        claudeSessionId: 'sess-handoff-direct',
        directSessionV1: expect.objectContaining({
          remoteSessionId: 'sess-handoff-direct',
        }),
      }),
      expect.objectContaining({
        enabled: true,
        strategy: 'sync_changes',
      }),
    );
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
    const importWorkspaceBundle = vi.fn(async (_params: ImportWorkspaceBundleInput) => ({
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
    const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
    const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT);
    const status = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);

    expect(start).toBeDefined();
    expect(prepare).toBeDefined();
    expect(resultGet).toBeDefined();
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

    let ready = prepared;
    if (ready.status.status !== 'ready_for_cutover') {
      await vi.waitFor(async () => {
        ready = await resultGet!({ handoffId });
        expect(ready.status.status).toBe('ready_for_cutover');
      });
    }
    expect(ready.status.transportStrategy).toBe('direct_peer');
    expect(ready.remoteSessionId).toBe('claude_session_1');
    await expect(resultGet!({ handoffId })).resolves.toEqual(ready);
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
        blobContentsByDigest: new Map(),
      },
      blobProvider: expect.objectContaining({
        getBlobFilePath: expect.any(Function),
      }),
      assertCanContinue: expect.any(Function),
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
    expect(ready.resume).toEqual({
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
    const exportDirectory = await mkdtemp(`${os.tmpdir()}/happier-handoff-export-`);
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
    const importWorkspaceBundle = vi.fn(async (_params: ImportWorkspaceBundleInput) => ({
      targetPath: '/repo-copy',
    }));
    await writeFile(`${exportDirectory}/README.md`, 'hello\n');
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    try {
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
            blobContentsByDigest: new Map(),
          },
          blobProvider: {
            getBlobFilePath: () => `${exportDirectory}/README.md`,
          },
        }),
        importSessionBundle,
        importWorkspaceBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

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

      let ready = prepared;
      if (ready.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          ready = await resultGet!({ handoffId: started.handoffId });
          expect(ready.status.status).toBe('ready_for_cutover');
        });
      }
      expect(ready.status.transportStrategy).toBe('server_routed_stream');
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
          blobContentsByDigest: new Map(),
        },
        blobProvider: expect.objectContaining({
          getBlobFilePath: expect.any(Function),
        }),
        assertCanContinue: expect.any(Function),
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
      const sameDaemonWorkspaceImport =
        (importWorkspaceBundle.mock.calls as unknown as readonly [ImportWorkspaceBundleInput][])[0]?.[0];
      expect(sameDaemonWorkspaceImport?.workspaceExportArtifacts?.blobContentsByDigest.size).toBe(0);
      expect(sameDaemonWorkspaceImport?.blobProvider).toEqual(expect.objectContaining({
        getBlobFilePath: expect.any(Function),
      }));
    } finally {
      await rm(exportDirectory, { recursive: true, force: true });
    }
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
    const importWorkspaceBundle = vi.fn(async (_params: ImportWorkspaceBundleInput) => ({
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
    const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
    expect(start).toBeDefined();
    expect(prepare).toBeDefined();
    expect(resultGet).toBeDefined();

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
        blobContentsByDigest: new Map(),
      },
      blobProvider: expect.objectContaining({
        getBlobFilePath: expect.any(Function),
      }),
      assertCanContinue: expect.any(Function),
      targetPath: '/repo',
      workspaceTransfer: undefined,
    });
    const storedCanonicalImport =
      (importWorkspaceBundle.mock.calls as unknown as readonly [ImportWorkspaceBundleInput][])[0]?.[0];
    expect(storedCanonicalImport?.workspaceExportArtifacts?.blobContentsByDigest.size).toBe(0);
    expect(storedCanonicalImport?.blobProvider).toEqual(expect.objectContaining({
      getBlobFilePath: expect.any(Function),
    }));
  });

  it('applies same-daemon workspace sync through the replication engine when workspace transfer is enabled', async () => {
    const sourcePath = '/Users/tester/projects/demo';
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: '/repo-synced',
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
      }),
    }));
    const importWorkspaceBundle = vi.fn(async (_params: ImportWorkspaceBundleInput) => ({
      targetPath: '/repo-legacy',
    }));
    const loadCurrentTargetManifest = vi.fn(async () => ({
      entries: [
        {
          relativePath: 'README.md',
          kind: 'file' as const,
          digest: 'sha256:previous',
          sizeBytes: 5,
          executable: false,
        },
      ],
      fingerprint: 'sha256:previous',
    }));
    const applyWorkspaceReplicationPlan = vi.fn(async () => ({
      targetPath: '/repo-synced',
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
        path: sourcePath,
        homeDir: '/Users/tester',
        flavor: 'claude',
        claudeSessionId: 'claude_session_1',
      }),
      exportSessionBundle: async () => ({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: sourcePath,
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
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
      }),
      importSessionBundle,
      importWorkspaceBundle,
      loadCurrentTargetManifest,
      applyWorkspaceReplicationPlan,
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
    expect(start).toBeDefined();
    expect(prepare).toBeDefined();
    expect(resultGet).toBeDefined();

    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'sync_changes' as const,
      conflictPolicy: 'create_sibling_copy' as const,
      includeIgnoredMode: 'include_selected' as const,
      ignoredIncludeGlobs: ['dist/**'],
    };
    const started = await start!({
      sessionId: 'sess_same_daemon_replication_prepare',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['server_routed_stream'],
      negotiatedTransportStrategy: 'server_routed_stream',
      workspaceTransfer,
    });
    expect(started).toHaveProperty('handoffId');

    const prepared = await prepare!({
      handoffId: started.handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo-target',
      workspaceTransfer,
    });

    let ready = prepared;
    if (ready.status.status !== 'ready_for_cutover') {
      await vi.waitFor(async () => {
        ready = await resultGet!({ handoffId: started.handoffId });
        expect(ready.status.status).toBe('ready_for_cutover');
      });
    }
    expect(ready.status.transportStrategy).toBe('server_routed_stream');
    expect(loadCurrentTargetManifest).toHaveBeenCalledWith({
      targetPath: '/repo-target',
      workspaceTransfer,
    });
    expect(applyWorkspaceReplicationPlan).toHaveBeenCalledWith({
      activeServerDir: expect.any(String),
      assertCanContinue: expect.any(Function),
      sourceOffer: {
        offerId: expect.any(String),
        relationshipId: expect.any(String),
        directionId: expect.any(String),
        sourceFingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
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
        blobIndex: [
          {
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            sizeBytes: 6,
          },
        ],
        sourceControllerMetadata: {
          scmBackendId: 'git',
        },
      },
      targetPath: '/repo-target',
      strategy: 'sync_changes',
      conflictPolicy: 'create_sibling_copy',
      currentTargetManifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file',
            digest: 'sha256:previous',
            sizeBytes: 5,
            executable: false,
          },
        ],
        fingerprint: 'sha256:previous',
      },
    });
    expect(importWorkspaceBundle).not.toHaveBeenCalled();
    expect(importSessionBundle).toHaveBeenCalledWith(
      {
        providerId: 'claude',
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      '/repo-synced',
      'persisted',
    );
  });

  it('delegates source-side workspace transfer preparation to the adapter seam when starting a handoff', async () => {
    const sourcePath = '/Users/tester/projects/demo';
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const transferredPayloadSource = await createSessionHandoffTransferredBundlesPayloadSource({});
    const createState = vi.fn(async () => ({
      workspaceReplicationMetadata: undefined,
    }));
    const resolveSourceOffer = vi.fn(async () => null);
    const prepareSourceWorkspaceTransfer = vi.fn(async () => ({
      transferredBundles: {} satisfies SessionHandoffTransferredBundles,
      transferredPayloadSource,
      storedTransferredPayload: {
        transferredBundles: {} satisfies SessionHandoffTransferredBundles,
      },
      includeWorkspaceBlobPayloads: true,
    }));
    const createSessionHandoffWorkspaceReplicationAdapter = vi.fn(() => ({
      createState,
      resolveSourceOffer,
      prepareSourceWorkspaceTransfer,
    }));
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    vi.resetModules();
    vi.doMock('@/configuration', () => ({
      configuration: {
        activeServerDir: '/tmp/happier-adapter-seam',
        activeServerId: 'test_adapter_seam',
        workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
        workspaceReplicationBlobPackMaxBlobs: 64,
        workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
      },
    }));
    vi.doMock('../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter', () => ({
      createSessionHandoffWorkspaceReplicationAdapter,
    }));

    try {
      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');
      registerHandlers({
        rpcHandlerManager,
        loadSessionMetadata: async () => ({
        machineId: 'machine_source',
        path: sourcePath,
        homeDir: '/Users/tester',
        flavor: 'claude',
        claudeSessionId: 'claude_session_1',
      }),
      exportSessionBundle: async () => ({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: sourcePath,
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
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
      }),
      importSessionBundle: async () => ({
        remoteSessionId: 'claude_session_target',
        directSource: {
          kind: 'claudeConfig',
            configDir: null,
            projectId: null,
          },
          resume: buildClaudeResumePlan({
            directory: '/repo-seam',
            resume: 'claude_session_target',
            transcriptStorage: 'persisted',
          }),
        }),
        importWorkspaceBundle: async () => ({ targetPath: '/repo-seam' }),
        loadCurrentTargetManifest: async () => ({
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file' as const,
              digest: 'sha256:previous',
              sizeBytes: 5,
              executable: false,
            },
          ],
          fingerprint: 'sha256:previous',
        }),
        applyWorkspaceReplicationPlan: async () => ({
          targetPath: '/repo-seam',
        }),
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      expect(start).toBeDefined();

      const started = await start!({
        sessionId: 'sess_adapter_seam',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer: {
          enabled: true as const,
          strategy: 'sync_changes' as const,
          conflictPolicy: 'create_sibling_copy' as const,
          includeIgnoredMode: 'include_selected' as const,
          ignoredIncludeGlobs: ['dist/**'],
        },
      });

      expect(started).toHaveProperty('handoffId');
      expect(createSessionHandoffWorkspaceReplicationAdapter).toHaveBeenCalledTimes(1);
      expect(prepareSourceWorkspaceTransfer).toHaveBeenCalledWith(expect.objectContaining({
        activeServerDir: '/tmp/happier-adapter-seam',
        handoffId: started.handoffId,
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceRootPath: sourcePath,
        workspaceTransfer: expect.objectContaining({
          enabled: true,
          strategy: 'sync_changes',
        }),
      }));
      expect(createState).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@/configuration');
      vi.doUnmock('../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter');
      vi.resetModules();
      await transferredPayloadSource.dispose?.();
    }
  });

  it('delegates target-side workspace preparation to the adapter seam during prepare-target', async () => {
    const sourcePath = '/Users/tester/projects/demo';
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const transferredPayloadSource = await createSessionHandoffTransferredBundlesPayloadSource({});
    const createState = vi.fn(async () => ({
      workspaceReplicationMetadata: undefined,
    }));
    const resolveSourceOffer = vi.fn(async () => null);
    const prepareSourceWorkspaceTransfer = vi.fn(async () => ({
      transferredBundles: {} satisfies SessionHandoffTransferredBundles,
      transferredPayloadSource,
      storedTransferredPayload: {
        transferredBundles: {} satisfies SessionHandoffTransferredBundles,
      },
      includeWorkspaceBlobPayloads: true,
    }));
    const prepareTargetWorkspace = vi.fn(async () => ({
      importedWorkspace: {
        targetPath: '/repo-adapter-target',
      },
      currentTargetManifest: {
        entries: [
          {
            relativePath: 'README.md',
            kind: 'file' as const,
            digest: 'sha256:previous',
            sizeBytes: 5,
            executable: false,
          },
        ],
        fingerprint: 'sha256:previous',
      },
      sourceOffer: null,
    }));
    const createSessionHandoffWorkspaceReplicationAdapter = vi.fn(() => ({
      createState,
      resolveSourceOffer,
      prepareSourceWorkspaceTransfer,
      prepareTargetWorkspace,
    }));
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: '/repo-adapter-target',
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
      }),
    }));
    const importWorkspaceBundle = vi.fn(async (_params: ImportWorkspaceBundleInput) => ({
      targetPath: '/repo-legacy',
    }));
    const loadCurrentTargetManifest = vi.fn(async () => ({
      entries: [],
    }));
    const applyWorkspaceReplicationPlan = vi.fn(async () => ({
      targetPath: '/repo-synced',
    }));
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    vi.resetModules();
    vi.doMock('../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter', () => ({
      createSessionHandoffWorkspaceReplicationAdapter,
      resolveSessionHandoffWorkspaceReplicationSourceOffer: resolveSourceOffer,
    }));

    try {
      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');
      registerHandlers({
        rpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          homeDir: '/Users/tester',
          flavor: 'claude',
          claudeSessionId: 'claude_session_1',
        }),
        exportSessionBundle: async () => ({
          providerBundle: {
            providerId: 'claude',
            remoteSessionId: 'claude_session_1',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
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
            sourceControllerMetadata: {
              scmBackendId: 'git',
            },
          },
        }),
        importSessionBundle,
        importWorkspaceBundle,
        loadCurrentTargetManifest,
        applyWorkspaceReplicationPlan,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const workspaceTransfer = {
        enabled: true as const,
        strategy: 'sync_changes' as const,
        conflictPolicy: 'create_sibling_copy' as const,
        includeIgnoredMode: 'include_selected' as const,
        ignoredIncludeGlobs: ['dist/**'],
      };
      const started = await start!({
        sessionId: 'sess_adapter_prepare_seam',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
      });

      let prepared = await prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo-target',
        workspaceTransfer,
      });

      if (prepared.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          prepared = await resultGet!({ handoffId: started.handoffId });
          expect(prepared.status.status).toBe('ready_for_cutover');
        });
      }

      expect(prepareTargetWorkspace).toHaveBeenCalledWith(expect.objectContaining({
        activeServerDir: expect.any(String),
        actualTransportStrategy: 'server_routed_stream',
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        targetPath: '/repo-target',
        workspaceTransfer,
        importWorkspaceBundle: expect.any(Function),
        loadCurrentTargetManifest: expect.any(Function),
        applyWorkspaceReplicationPlan: expect.any(Function),
        assertCanContinue: expect.any(Function),
      }));
      expect(importWorkspaceBundle).not.toHaveBeenCalled();
      expect(loadCurrentTargetManifest).not.toHaveBeenCalled();
      expect(applyWorkspaceReplicationPlan).not.toHaveBeenCalled();
      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        '/repo-adapter-target',
        'persisted',
      );
    } finally {
      vi.doUnmock('../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter');
      vi.resetModules();
      await transferredPayloadSource.dispose?.();
    }
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
    const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
    expect(start).toBeDefined();
    expect(prepare).toBeDefined();
    expect(resultGet).toBeDefined();

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

    await resultGet!({ handoffId: started.handoffId });
    importWorkspaceBundle.mockClear();

    await prepare!({
      handoffId: started.handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    await resultGet!({ handoffId: started.handoffId });
    expect(importWorkspaceBundle).not.toHaveBeenCalled();
  });

  it('reuses the stored canonical transferred bundles on a repeated direct-peer prepare retry after the first target import', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const directPeerPayload = createLegacyTransferredPayloadBuffer({
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
    });
    const { requestPayloadFile, dispose } = await createDirectPeerRequestPayloadFile({
      payload: directPeerPayload,
    });
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: '/repo-synced',
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

    try {
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        importSessionBundle,
        importWorkspaceBundle,
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

      await resultGet!({ handoffId: 'handoff_direct_peer_retry' });
      requestPayloadFile.mockClear();
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

      let ready = retried;
      if (!ready.status || ready.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          ready = await resultGet!({ handoffId: 'handoff_direct_peer_retry' });
          expect(ready.status.status).toBe('ready_for_cutover');
        });
      }
      expect(ready.status.transportStrategy).toBe('direct_peer');
      expect(requestPayloadFile).not.toHaveBeenCalled();
      expect(importWorkspaceBundle).not.toHaveBeenCalled();
      expect(importSessionBundle).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('marks the handoff awaiting recovery and reuses stored canonical bundles after a target import failure', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const directPeerPayload = createLegacyTransferredPayloadBuffer({
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
    });
    const { requestPayloadFile, dispose } = await createDirectPeerRequestPayloadFile({
      payload: directPeerPayload,
    });
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

    try {
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        importSessionBundle,
        importWorkspaceBundle,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        },
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      const status = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();
      expect(status).toBeDefined();

      let failedAttempt:
        | Awaited<ReturnType<NonNullable<typeof prepare>>>
        | null = null;
      let firstAttemptError: unknown;
      try {
        failedAttempt = await prepare!({
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
        });
      } catch (error) {
        firstAttemptError = error;
      }
      if (firstAttemptError) {
        expect(firstAttemptError).toBeInstanceOf(Error);
        expect((firstAttemptError as Error).message).toBe('session import failed');
      }

      if (!failedAttempt || failedAttempt.status.status !== 'awaiting_recovery') {
        await vi.waitFor(async () => {
          const currentStatus = await status!({ handoffId: 'handoff_direct_peer_retry_after_failure' });
          expect(currentStatus.status.status).toBe('awaiting_recovery');
          failedAttempt = currentStatus;
        });
      }
      expect(failedAttempt?.status.transportStrategy).toBe('direct_peer');

      await expect(status!({
        handoffId: 'handoff_direct_peer_retry_after_failure',
      })).resolves.toEqual({
        handoffId: 'handoff_direct_peer_retry_after_failure',
        status: {
          handoffId: 'handoff_direct_peer_retry_after_failure',
          jobId: expect.any(String),
          status: 'awaiting_recovery',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          recoveryActions: [],
          progress: expect.objectContaining({
            checkpoint: 'stage_target',
            current: expect.objectContaining({
              phaseDetail: 'importing_session',
            }),
          }),
        },
      });

      requestPayloadFile.mockClear();
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

      let ready = retried;
      if (!ready.status || ready.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          ready = await resultGet!({ handoffId: 'handoff_direct_peer_retry_after_failure' });
          expect(ready.status?.status).toBe('ready_for_cutover');
        });
      }
      expect(ready.status.transportStrategy).toBe('direct_peer');
      expect(requestPayloadFile).not.toHaveBeenCalled();
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
        assertCanContinue: expect.any(Function),
        targetPath: '/repo',
        workspaceTransfer: undefined,
      });
    } finally {
      await dispose();
    }
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
        requestPayloadFile: vi.fn(),
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

  it('rejects workspace transfer before exporting bundles when ignored globs are provided without include_selected mode', async () => {
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
          ignoredIncludeGlobs: ['dist/**'],
        },
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_workspace_transfer_strategy',
      error: 'Workspace transfer ignoredIncludeGlobs require includeIgnoredMode=include_selected',
      reasonCode: 'ignored_globs_require_include_selected',
    });

    expect(exportSessionBundle).not.toHaveBeenCalled();
  });

  it('applies direct-peer workspace sync through the replication engine even when the target daemon has no local handoff state', async () => {
    vi.resetModules();

    const sourcePath = '/Users/tester/projects/direct-peer';
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-target-'));
    const directPeerWorkspacePayload = Buffer.from('direct-peer-pack\n', 'utf8');
    const directPeerWorkspaceDigest = `sha256:${createHash('sha256').update(directPeerWorkspacePayload).digest('hex')}`;
    const directPeerManifestFingerprint = `sha256:${'1'.repeat(64)}`;
    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'sync_changes' as const,
      conflictPolicy: 'create_sibling_copy' as const,
      includeIgnoredMode: 'include_selected' as const,
      ignoredIncludeGlobs: ['dist/**'],
    };
    const sourceRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const targetRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const { publishTransfer, requestPayloadFile, dispose, listPublishedTransferIds } =
      await createPublishedDirectPeerPayloadRouter();
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: '/repo-synced',
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
      }),
    }));
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
    const loadCurrentTargetManifest = vi.fn(async () => ({
      entries: [
        {
          relativePath: 'README.md',
          kind: 'file' as const,
          digest: 'sha256:previous',
          sizeBytes: 5,
          executable: false,
        },
      ],
      fingerprint: 'sha256:previous',
    }));
    const applyWorkspaceReplicationPlan = vi.fn(async () => ({
      targetPath: '/repo-synced',
    }));
    const sourceRpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        sourceRegistered.set(method, handler);
      },
    } as any;
    const targetRpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        targetRegistered.set(method, handler);
      },
    } as any;

    try {
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_direct_peer_source',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerSourceHandlers } = await import('./rpcHandlers.sessionHandoff');

      registerSourceHandlers({
        rpcHandlerManager: sourceRpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle: async () => ({
          providerBundle: {
            providerId: 'claude' as const,
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
          workspaceExportArtifacts: {
            manifest: {
              entries: [
                {
                  relativePath: 'README.md',
                  kind: 'file' as const,
                  digest: directPeerWorkspaceDigest,
                  sizeBytes: directPeerWorkspacePayload.byteLength,
                  executable: false,
                },
              ],
              fingerprint: directPeerManifestFingerprint,
            },
            blobContentsByDigest: new Map([
              [directPeerWorkspaceDigest, directPeerWorkspacePayload],
            ]),
            sourceControllerMetadata: {
              scmBackendId: 'git',
            },
          },
        }),
        directPeerTransfer: {
          publishTransfer,
          requestPayloadFile: vi.fn(async () => {
            throw new Error('source daemon should not request direct-peer payload files during start');
          }),
          clearPublishedTransfer: vi.fn(),
        },
      });

      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: targetActiveServerDir,
          activeServerId: 'test_direct_peer_target',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      vi.doMock('../../workspaces/replication/transport/workspaceReplicationTransfers', () => ({
        createWorkspaceReplicationTransfers: () => ({
          publishDirectPeerSourceOffer: () => [],
          requestDirectPeerSourceOffer: async () => {
            throw new Error('Unexpected direct-peer source-offer request');
          },
          requestServerRoutedSourceOffer: async () => {
            throw new Error('Unexpected server-routed source-offer request');
          },
          publishDirectPeerBlobPack: () => [],
          requestDirectPeerBlobPackToFile: async ({ transferId, destinationPath }: Readonly<{
            transferId: string;
            destinationPath: string;
          }>) => ({
            destinationPath: (await requestPayloadFile({
              transferId,
              endpointCandidates: [],
              destinationPath,
            })).destinationPath,
            manifestHash: `sha256:${'2'.repeat(64)}`,
            sizeBytes: 0,
          }),
          requestServerRoutedBlobPackToFile: async () => {
            throw new Error('Unexpected server-routed blob-pack request');
          },
        }),
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerTargetHandlers } = await import('./rpcHandlers.sessionHandoff');

      registerTargetHandlers({
        rpcHandlerManager: targetRpcHandlerManager,
        importSessionBundle,
        importWorkspaceBundle,
        loadCurrentTargetManifest,
        applyWorkspaceReplicationPlan,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        },
      });

      const start = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_direct_peer_workspace_replication',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
        workspaceTransfer,
      });
      expect(started).toMatchObject({
        handoffId: expect.any(String),
        status: expect.objectContaining({
          status: 'pending',
        }),
      });

      const prepared = await prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo-target',
        workspaceTransfer,
        endpointCandidates: started.endpointCandidates,
      });

      let ready = prepared;
      if (ready.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          ready = await resultGet!({ handoffId: started.handoffId });
          expect(ready.status.status).toBe('ready_for_cutover');
        });
      }
      expect(ready).toMatchObject({
        handoffId: started.handoffId,
        status: {
          handoffId: started.handoffId,
          jobId: expect.any(String),
          status: 'ready_for_cutover',
          phase: 'staging_target',
          transportStrategy: 'direct_peer',
          recoveryActions: [],
          progress: expect.objectContaining({
            checkpoint: 'import_session',
            current: expect.objectContaining({
              phaseDetail: 'ready_for_cutover',
            }),
          }),
        },
        remoteSessionId: 'claude_session_target',
        directSource: {
          kind: 'claudeConfig',
          configDir: null,
          projectId: null,
        },
        resume: {
          directory: '/repo-synced',
          agent: 'claude',
          resume: 'claude_session_target',
          transcriptStorage: 'persisted',
          approvedNewDirectoryCreation: true,
        },
      });
      await expect(resultGet!({ handoffId: started.handoffId })).resolves.toEqual(ready);
      const requestedTransferIds = requestPayloadFile.mock.calls.map(([call]) => call.transferId);
      expect(requestedTransferIds).toContain(started.handoffId);
      expect(requestedTransferIds).toContain(`session-handoff:${started.handoffId}:provider-bundle-file`);
      expect(requestedTransferIds.some((transferId) => transferId.includes(':workspace-pack:'))).toBe(true);
      const publishedTransferIds = listPublishedTransferIds();
      expect(publishedTransferIds).toContain(started.handoffId);
      expect(publishedTransferIds).toContain(`session-handoff:${started.handoffId}:provider-bundle-file`);
      expect(publishedTransferIds.some((transferId) => transferId.includes(':workspace-pack:'))).toBe(true);
      const publishedWorkspacePackCalls = publishTransfer.mock.calls.filter(
        ([call]) => typeof call.transferId === 'string' && call.transferId.includes(':workspace-pack:'),
      );
      expect(publishedWorkspacePackCalls.length).toBeGreaterThan(0);
      for (const [call] of publishedWorkspacePackCalls) {
        expect(call.payload).toEqual({});
      }
      expect(loadCurrentTargetManifest).toHaveBeenCalledWith({
        targetPath: '/repo-target',
        workspaceTransfer,
      });
      expect(applyWorkspaceReplicationPlan).toHaveBeenCalledWith({
        activeServerDir: targetActiveServerDir,
        assertCanContinue: expect.any(Function),
        sourceOffer: {
          offerId: expect.any(String),
          relationshipId: expect.any(String),
          directionId: expect.any(String),
          sourceFingerprint: expect.any(String),
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: directPeerWorkspaceDigest,
                sizeBytes: directPeerWorkspacePayload.byteLength,
                executable: false,
              },
            ],
            fingerprint: expect.any(String),
          },
          blobIndex: [
            {
              digest: directPeerWorkspaceDigest,
              sizeBytes: directPeerWorkspacePayload.byteLength,
            },
          ],
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
        targetPath: '/repo-target',
        strategy: 'sync_changes',
        conflictPolicy: 'create_sibling_copy',
        currentTargetManifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:previous',
              sizeBytes: 5,
              executable: false,
            },
          ],
          fingerprint: 'sha256:previous',
        },
      });
      expect(importWorkspaceBundle).not.toHaveBeenCalled();
      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        '/repo-synced',
        'persisted',
      );
    } finally {
      vi.doUnmock('../../workspaces/replication/transport/workspaceReplicationTransfers');
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await dispose();
      await rm(sourceActiveServerDir, { recursive: true, force: true });
      await rm(targetActiveServerDir, { recursive: true, force: true });
    }
  });

  it('applies server-routed workspace sync through the replication engine when workspace transfer is enabled', async () => {
    vi.resetModules();

    const sourcePath = '/Users/tester/projects/server-routed';
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-target-'));
    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'sync_changes' as const,
      conflictPolicy: 'create_sibling_copy' as const,
      includeIgnoredMode: 'include_selected' as const,
      ignoredIncludeGlobs: ['dist/**'],
    };
    const sourceRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const targetRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: '/repo-synced',
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
      }),
    }));
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-legacy' }));
    const loadCurrentTargetManifest = vi.fn(async () => ({
      entries: [
        {
          relativePath: 'README.md',
          kind: 'file' as const,
          digest: 'sha256:previous',
          sizeBytes: 5,
          executable: false,
        },
      ],
      fingerprint: 'sha256:previous',
    }));
    const applyWorkspaceReplicationPlan = vi.fn(async () => ({
      targetPath: '/repo-synced',
    }));
    const channels = createLoopbackMachineTransferChannels();
    const sourceRpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        sourceRegistered.set(method, handler);
      },
    } as any;
    const targetRpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        targetRegistered.set(method, handler);
      },
    } as any;
    try {
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_server_routed_source',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerSourceHandlers } = await import('./rpcHandlers.sessionHandoff');

      registerSourceHandlers({
        rpcHandlerManager: sourceRpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          homeDir: '/Users/tester',
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle: async () => ({
          providerBundle: {
            providerId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
          workspaceExportArtifacts: {
            manifest: {
              entries: [
                {
                  relativePath: 'README.md',
                  kind: 'file',
                  digest: 'sha256:be224639187f439ccf43515d94acc2300663a6bfba09afd1e950e22e1b552bd8',
                  sizeBytes: 19,
                  executable: false,
                },
              ],
              fingerprint: 'sha256:0f17985b1cd57fb85b266f9106da8e3feec58da8fe9b31f6d9e4e83079a996f0',
            },
            blobContentsByDigest: new Map([
              ['sha256:be224639187f439ccf43515d94acc2300663a6bfba09afd1e950e22e1b552bd8', Buffer.from('server-routed-pack\n', 'utf8')],
            ]),
            sourceControllerMetadata: {
              scmBackendId: 'git',
            },
          },
        }),
        machineTransferChannel: channels.source,
      });

      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: targetActiveServerDir,
          activeServerId: 'test_server_routed_target',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerTargetHandlers } = await import('./rpcHandlers.sessionHandoff');

      registerTargetHandlers({
        rpcHandlerManager: targetRpcHandlerManager,
        importSessionBundle,
        importWorkspaceBundle,
        loadCurrentTargetManifest,
        applyWorkspaceReplicationPlan,
        machineTransferChannel: channels.target,
      });

      const sourceStart = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const targetPrepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(sourceStart).toBeDefined();
      expect(targetPrepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await sourceStart!({
        sessionId: 'sess_server_routed_replication_prepare',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
      });
      if ('ok' in started && started.ok === false) {
        throw new Error(`unexpected start failure: ${started.errorCode}:${started.error}`);
      }

      const preparePromise = targetPrepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo-target',
        workspaceTransfer,
      });

      const prepared = await preparePromise;
      let ready = prepared;
      if (ready.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          ready = await resultGet!({ handoffId: started.handoffId });
          expect(ready.status.status).toBe('ready_for_cutover');
        });
      }
      expect(ready.status.transportStrategy).toBe('server_routed_stream');
      expect(ready.status.workspacePreflightSummary).toEqual({
        addedPathsCount: 0,
        changedPathsCount: 1,
        removedPathsCount: 0,
        totalBytes: 19,
      });
      expect(ready.status.progress).toEqual(expect.objectContaining({
        checkpoint: 'import_session',
        planned: {
          totalFiles: 1,
          totalBytes: 19,
          added: 0,
          changed: 1,
          removed: 0,
        },
        transferred: {
          files: 1,
          bytes: 19,
          blobs: 1,
        },
        current: expect.objectContaining({
          phaseDetail: 'ready_for_cutover',
        }),
        resumable: false,
      }));
      expect(loadCurrentTargetManifest).toHaveBeenCalledWith({
        targetPath: '/repo-target',
        workspaceTransfer,
      });
      expect(applyWorkspaceReplicationPlan).toHaveBeenCalledWith({
        activeServerDir: targetActiveServerDir,
        assertCanContinue: expect.any(Function),
        sourceOffer: {
          offerId: expect.any(String),
          relationshipId: expect.any(String),
          directionId: expect.any(String),
          sourceFingerprint: expect.any(String),
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:be224639187f439ccf43515d94acc2300663a6bfba09afd1e950e22e1b552bd8',
                sizeBytes: 19,
                executable: false,
              },
            ],
            fingerprint: expect.any(String),
          },
          blobIndex: [
            {
              digest: 'sha256:be224639187f439ccf43515d94acc2300663a6bfba09afd1e950e22e1b552bd8',
              sizeBytes: 19,
            },
          ],
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
        targetPath: '/repo-target',
        strategy: 'sync_changes',
        conflictPolicy: 'create_sibling_copy',
        currentTargetManifest: {
          entries: [
            {
              relativePath: 'README.md',
              kind: 'file',
              digest: 'sha256:previous',
              sizeBytes: 5,
              executable: false,
            },
          ],
          fingerprint: 'sha256:previous',
        },
      });
      expect(importWorkspaceBundle).not.toHaveBeenCalled();
      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        '/repo-synced',
        'persisted',
      );
      const openTransferIds = channels.sentEnvelopes
        .filter((entry) => entry.envelope.kind === 'open')
        .map((entry) => entry.envelope.transferId);
      expect(openTransferIds).toContain(`session-handoff:${started.handoffId}`);
      expect(openTransferIds).toContain(`session-handoff:${started.handoffId}:provider-bundle-file`);
      expect(openTransferIds.some((transferId) => transferId.includes(':workspace-offer:'))).toBe(true);
      expect(openTransferIds.some((transferId) => transferId.includes(':workspace-pack:'))).toBe(true);
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(targetActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('acknowledges server-routed workspace handoff start before a large workspace export finishes and lets prepare wait for it', async () => {
    vi.resetModules();

    const sourcePath = '/Users/tester/projects/server-routed-deferred';
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-deferred-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-deferred-target-'));
    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'sync_changes' as const,
      conflictPolicy: 'create_sibling_copy' as const,
      includeIgnoredMode: 'include_selected' as const,
      ignoredIncludeGlobs: ['dist/**'],
    };
    const sourceRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const targetRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const exportDeferred = createDeferred<Readonly<{
      providerBundle: {
        providerId: 'claude';
        remoteSessionId: string;
        transcriptBase64: string;
      };
      targetPath: string;
      workspaceExportArtifacts: {
        manifest: {
          entries: Array<{
            relativePath: string;
            kind: 'file';
            digest: string;
            sizeBytes: number;
            executable: false;
          }>;
          fingerprint: string;
        };
        blobContentsByDigest: Map<string, Buffer>;
        sourceControllerMetadata: {
          scmBackendId: 'git';
        };
      };
    }>>();
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: '/repo-synced',
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
      }),
    }));
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-legacy' }));
    const loadCurrentTargetManifest = vi.fn(async () => ({
      entries: [],
      fingerprint: 'sha256:target-empty',
    }));
    const applyWorkspaceReplicationPlan = vi.fn(async () => ({
      targetPath: '/repo-synced',
    }));
    const channels = createLoopbackMachineTransferChannels();
    const sourceRpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        sourceRegistered.set(method, handler);
      },
    } as any;
    const targetRpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        targetRegistered.set(method, handler);
      },
    } as any;

    try {
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_server_routed_deferred_source',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerSourceHandlers } = await import('./rpcHandlers.sessionHandoff');

      registerSourceHandlers({
        rpcHandlerManager: sourceRpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          homeDir: '/Users/tester',
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle: vi.fn(async () => await exportDeferred.promise),
        machineTransferChannel: channels.source,
      });

      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: targetActiveServerDir,
          activeServerId: 'test_server_routed_deferred_target',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerTargetHandlers } = await import('./rpcHandlers.sessionHandoff');

      registerTargetHandlers({
        rpcHandlerManager: targetRpcHandlerManager,
        importSessionBundle,
        importWorkspaceBundle,
        loadCurrentTargetManifest,
        applyWorkspaceReplicationPlan,
        machineTransferChannel: channels.target,
      });

      const sourceStart = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const targetPrepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(sourceStart).toBeDefined();
      expect(targetPrepare).toBeDefined();
      expect(resultGet).toBeDefined();

      let started: any = null;
      const startedPromise = sourceStart!({
        sessionId: 'sess_server_routed_replication_prepare_deferred',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
      }).then((result) => {
        started = result;
        return result;
      });

      await vi.waitFor(() => {
        expect(started).toMatchObject({
          handoffId: expect.stringMatching(/^handoff_/),
          status: expect.objectContaining({
            status: 'pending',
            phase: 'preparing',
          }),
          targetPath: sourcePath,
        });
      });

      const prepareAck = await targetPrepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo-target',
        workspaceTransfer,
      });

      expect(prepareAck).toMatchObject({
        handoffId: started.handoffId,
        status: expect.objectContaining({
          status: 'pending',
          phase: 'staging_target',
        }),
      });

      exportDeferred.resolve({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        targetPath: sourcePath,
        workspaceExportArtifacts: {
          manifest: {
            entries: [
              {
                relativePath: 'README.md',
                kind: 'file',
                digest: 'sha256:be224639187f439ccf43515d94acc2300663a6bfba09afd1e950e22e1b552bd8',
                sizeBytes: 19,
                executable: false,
              },
            ],
            fingerprint: 'sha256:0f17985b1cd57fb85b266f9106da8e3feec58da8fe9b31f6d9e4e83079a996f0',
          },
          blobContentsByDigest: new Map([
            ['sha256:be224639187f439ccf43515d94acc2300663a6bfba09afd1e950e22e1b552bd8', Buffer.from('server-routed-pack\n', 'utf8')],
          ]),
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
      });

      let ready = prepareAck;
      await vi.waitFor(async () => {
        ready = await resultGet!({ handoffId: started.handoffId });
        expect(ready.status.status).toBe('ready_for_cutover');
      });

      expect(ready.status.transportStrategy).toBe('server_routed_stream');
      expect(applyWorkspaceReplicationPlan).toHaveBeenCalledWith(expect.objectContaining({
        targetPath: '/repo-target',
        strategy: 'sync_changes',
      }));
      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        '/repo-synced',
        'persisted',
      );

      await startedPromise;
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(sourceActiveServerDir, { recursive: true, force: true });
      await rm(targetActiveServerDir, { recursive: true, force: true });
    }
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

    const recipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(
      sendEnvelope,
      'session-handoff:handoff_server_routed_prefers_transport',
    );

    const dispatchEnvelope = (payload: MachineTransferReceiveEnvelope) => {
      for (const listener of listeners) {
        listener(payload);
      }
    };
    const serverRoutedPayload = createLegacyTransferredPayloadBuffer({
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
    });

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
      assertCanContinue: expect.any(Function),
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

  it('returns pending and then awaiting_recovery when the server-routed transfer is unavailable during prepare', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '5';
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-unavailable-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-unavailable-target-'));

    try {
      const channels = createLoopbackMachineTransferChannels();
      let droppedTransferId: string | null = null;
      const targetChannel = {
        onEnvelope: channels.target.onEnvelope,
        sendEnvelope(payload: MachineTransferSendEnvelope) {
          if (
            payload.envelope.kind === 'open'
            && droppedTransferId
            && payload.envelope.transferId === droppedTransferId
          ) {
            return;
          }
          channels.target.sendEnvelope(payload);
        },
      };

      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_server_routed_unavailable_source',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerSourceHandlers } = await import('./rpcHandlers.sessionHandoff');

      const sourceRegistered = new Map<string, (params: unknown) => Promise<any>>();
      registerSourceHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            sourceRegistered.set(method, handler);
          },
        } as any,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: '/repo',
          homeDir: '/Users/tester',
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
        }),
        machineTransferChannel: channels.source,
      });

      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: targetActiveServerDir,
          activeServerId: 'test_server_routed_unavailable_target',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerTargetHandlers } = await import('./rpcHandlers.sessionHandoff');

      const targetRegistered = new Map<string, (params: unknown) => Promise<any>>();
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
      registerTargetHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            targetRegistered.set(method, handler);
          },
        } as any,
        importSessionBundle,
        importWorkspaceBundle,
        machineTransferChannel: targetChannel,
      });

      const start = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const statusGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(statusGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_server_routed_prepare_unavailable',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
      });
      droppedTransferId = `session-handoff:${started.handoffId}`;

      await expect(prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo-target',
      })).resolves.toMatchObject({
        handoffId: started.handoffId,
        status: {
          handoffId: started.handoffId,
          status: 'pending',
          phase: 'staging_target',
          jobId: expect.any(String),
        },
      });

      await vi.waitFor(async () => {
        await expect(statusGet!({ handoffId: started.handoffId })).resolves.toMatchObject({
          handoffId: started.handoffId,
          status: {
            handoffId: started.handoffId,
            status: 'awaiting_recovery',
            phase: 'staging_target',
            jobId: expect.any(String),
          },
        });
      });
      expect(importWorkspaceBundle).not.toHaveBeenCalled();
      expect(importSessionBundle).not.toHaveBeenCalled();
    } finally {
      delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(targetActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('returns pending and then awaiting_recovery when the provider bundle fetch stalls during server-routed prepare', async () => {
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '5';
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-provider-timeout-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-provider-timeout-target-'));

    try {
      const channels = createLoopbackMachineTransferChannels();
      let droppedTransferId: string | null = null;
      const targetChannel = {
        onEnvelope: channels.target.onEnvelope,
        sendEnvelope(payload: MachineTransferSendEnvelope) {
          if (
            payload.envelope.kind === 'open'
            && droppedTransferId
            && payload.envelope.transferId === droppedTransferId
          ) {
            return;
          }
          channels.target.sendEnvelope(payload);
        },
      };

      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_provider_timeout_source',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerSourceHandlers } = await import('./rpcHandlers.sessionHandoff');

      const sourceRegistered = new Map<string, (params: unknown) => Promise<any>>();
      registerSourceHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            sourceRegistered.set(method, handler);
          },
        } as any,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: '/repo',
          homeDir: '/Users/tester',
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
        machineTransferChannel: channels.source,
      });

      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: targetActiveServerDir,
          activeServerId: 'test_provider_timeout_target',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerTargetHandlers } = await import('./rpcHandlers.sessionHandoff');

      const targetRegistered = new Map<string, (params: unknown) => Promise<any>>();
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
      registerTargetHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            targetRegistered.set(method, handler);
          },
        } as any,
        importSessionBundle,
        importWorkspaceBundle,
        machineTransferChannel: targetChannel,
      });

      const start = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const statusGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(statusGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_server_routed_provider_timeout',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
      });
      droppedTransferId = `session-handoff:${started.handoffId}:provider-bundle-file`;

      await expect(prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo-target',
      })).resolves.toMatchObject({
        handoffId: started.handoffId,
        status: {
          handoffId: started.handoffId,
          status: 'pending',
          phase: 'staging_target',
          jobId: expect.any(String),
        },
      });

      await vi.waitFor(async () => {
        await expect(statusGet!({ handoffId: started.handoffId })).resolves.toMatchObject({
          handoffId: started.handoffId,
          status: {
            handoffId: started.handoffId,
            status: 'awaiting_recovery',
            phase: 'staging_target',
            jobId: expect.any(String),
          },
        });
      });
      expect(importWorkspaceBundle).not.toHaveBeenCalled();
      expect(importSessionBundle).not.toHaveBeenCalled();
    } finally {
      delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(targetActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('returns invalid_request for legacy inline prepare-target transfer fields', async () => {
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
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      importSessionBundle,
      importWorkspaceBundle,
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
      workspaceManifestHash: 'sha256:legacy-inline-workspace',
      transferredPayload: {
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_inline',
          transcriptBase64: 'e30K',
        },
      },
      providerBundle: {
        providerId: 'claude',
        remoteSessionId: 'claude_session_inline',
        transcriptBase64: 'e30K',
      },
      workspaceArtifacts: {
        manifest: {
          entries: [],
        },
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

    const recipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(
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

    const recipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(
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

    const recipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(
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
    const requestPayloadFile = vi.fn(async () => {
      throw new Error('same-daemon prepare should reuse stored payload source');
    });
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
    const importWorkspaceBundle = vi.fn(async () => ({ targetPath: '/repo-target' }));
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
      importWorkspaceBundle,
      directPeerTransfer: {
        publishTransfer,
        requestPayloadFile,
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

    expect(publishTransfer).toHaveBeenNthCalledWith(1, {
      transferId: `session-handoff:${started.handoffId}:provider-bundle-file`,
      payload: {},
      payloadSource: expect.objectContaining({
        kind: 'file',
        sizeBytes: expect.any(Number),
        manifestHash: expect.stringMatching(/^sha256:/),
      }),
    });
    expect(publishTransfer).toHaveBeenNthCalledWith(2, {
      transferId: started.handoffId,
      payload: {
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
    const publishedPayloadSource = publishTransfer.mock.calls[1]?.[0]?.payloadSource;
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

    expect(requestPayloadFile).not.toHaveBeenCalled();
    expect(prepared.status.transportStrategy).toBe('direct_peer');
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
        blobContentsByDigest: new Map(),
      },
      blobProvider: expect.objectContaining({
        getBlobFilePath: expect.any(Function),
      }),
      assertCanContinue: expect.any(Function),
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
    const directPeerPayload = createLegacyTransferredPayloadBuffer({
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
    });
    const { requestPayloadFile, dispose } = await createDirectPeerRequestPayloadFile({
      payload: directPeerPayload,
    });
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

    try {
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        importSessionBundle,
        importWorkspaceBundle,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile,
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
        assertCanContinue: expect.any(Function),
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
    } finally {
      await dispose();
    }
  });

  it('fails closed when the direct-peer transfer payload does not satisfy the canonical handoff schemas', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const { requestPayloadFile, dispose } = await createDirectPeerRequestPayloadFile({
      payload: Buffer.from(JSON.stringify({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
        },
      }), 'utf8'),
    });
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

    try {
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        importSessionBundle,
        importWorkspaceBundle,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile,
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
    } finally {
      await dispose();
    }
  });

  it('fails closed when the direct-peer transfer payload omits blob content required by workspace artifacts', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const directPeerPayload = createLegacyTransferredPayloadBuffer({
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
              digest: 'sha256:blob_missing',
              sizeBytes: 6,
              executable: false,
            },
          ],
          fingerprint: 'sha256:manifest_missing_blob',
        },
        blobContentsByDigest: new Map(),
      },
    });
    const { requestPayloadFile, dispose } = await createDirectPeerRequestPayloadFile({
      payload: directPeerPayload,
    });
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

    try {
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        importSessionBundle,
        importWorkspaceBundle,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile,
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
    } finally {
      await dispose();
    }
  });

  it('returns a transport error instead of server-routed fallback when direct-peer transfer fails and fallback is forbidden', async () => {
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
      machineTransferChannel: {
        onEnvelope: () => () => {},
        sendEnvelope: vi.fn(),
      },
      directPeerTransfer: {
        publishTransfer: vi.fn(() => []),
        requestPayloadFile,
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

    expect(requestPayloadFile).toHaveBeenCalledTimes(1);
  });
});
