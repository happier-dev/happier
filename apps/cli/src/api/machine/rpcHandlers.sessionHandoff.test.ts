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
import type { DirectPeerOnDemandTransferScope } from '../../machines/transfer/directPeerTransport';
import { createWorkspaceReplicationBaselineStore } from '../../workspaces/replication/baseline/workspaceReplicationBaselineStore';
import { createWorkspaceReplicationJobStore } from '../../workspaces/replication/jobs/workspaceReplicationJobStore';
import { createSessionHandoffPrepareTargetJobStore } from '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { registerMachineSessionHandoffRpcHandlers } from './rpcHandlers.sessionHandoff';

type ExportSessionBundle = NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['exportSessionBundle']>;
type DirectPeerRequestPayloadFile = NonNullable<
  NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['directPeerTransfer']>['requestPayloadFile']
>;
type DirectPeerPublishTransfer = NonNullable<
  NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['directPeerTransfer']>['publishTransfer']
>;
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
      expectTypeOf<DirectPeerPublishPayload>().toEqualTypeOf<Readonly<Record<never, never>>>();
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
    const openEnvelope = sendEnvelope.mock.calls
      .map((call) => call?.[0]?.envelope)
      .find((envelope) => envelope?.kind === 'open' && envelope.transferId === transferId);
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

  function buildDirectPeerEndpointCandidate(params: Readonly<{
    transferId: string;
    port?: number;
    authorizationToken?: string;
    expiresAt?: number;
  }>): TransferEndpointCandidate {
    const port = params.port ?? 46001;
    const expiresAt = params.expiresAt ?? Date.now() + 30_000;
    const transferPathKey = Buffer.from(params.transferId, 'utf8').toString('base64url');
    return {
      kind: 'http',
      url: `http://127.0.0.1:${port}/machine-transfers/direct/${transferPathKey}`,
      authorizationToken: params.authorizationToken ?? 'test-token',
      expiresAt,
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
	    requestPayloadFileWithOpenBody: (input: Readonly<{
	      transferId: string;
	      endpointCandidates: readonly TransferEndpointCandidate[];
	      destinationPath: string;
	      openBody?: unknown;
	    }>) => Promise<Readonly<{ destinationPath: string }>>;
	    dispose: () => Promise<void>;
	    listPublishedTransferIds: () => readonly string[];
	  }>> {
	    const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-published-'));
	    const publishedPayloadPaths = new Map<string, string>();
	    const onDemandScopesByToken = new Map<string, DirectPeerOnDemandTransferScope>();

	    return {
	      publishTransfer: vi.fn(({ transferId, payloadSource, onDemandScope }) => {
	        if (!payloadSource || payloadSource.kind !== 'file') {
	          throw new Error(`Expected a file-backed direct-peer payload source for ${transferId}`);
	        }
	        publishedPayloadPaths.set(transferId, payloadSource.filePath);
	        const authorizationToken = `${transferId}-token`;
	        if (onDemandScope) {
	          onDemandScopesByToken.set(authorizationToken, onDemandScope);
	        }
	        return [buildDirectPeerEndpointCandidate({ transferId, authorizationToken })];
	      }),
	      requestPayloadFile: vi.fn(async ({ transferId, destinationPath }) => {
	        const publishedPayloadPath = publishedPayloadPaths.get(transferId);
	        if (!publishedPayloadPath) {
	          throw new Error(`Missing published direct-peer payload for ${transferId}`);
	        }
	        await copyFile(publishedPayloadPath, destinationPath);
	        return { destinationPath };
	      }),
	      requestPayloadFileWithOpenBody: async ({ transferId, destinationPath, endpointCandidates, openBody }) => {
	        let publishedPayloadPath = publishedPayloadPaths.get(transferId);
	        if (!publishedPayloadPath) {
	          const authorizationToken = endpointCandidates
	            .map((candidate) => candidate.authorizationToken)
	            .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
	          const scope = authorizationToken ? onDemandScopesByToken.get(authorizationToken) : null;
	          if (scope?.allowTransferId(transferId) === true) {
	            const resolved = await scope.resolvePayloadSourceOnOpen({
	              transferId,
	              requestBody: openBody ?? null,
	            });
	            if (!resolved || resolved.kind !== 'file') {
	              throw new Error(`Expected on-demand file-backed direct-peer payload source for ${transferId}`);
	            }
	            publishedPayloadPath = resolved.filePath;
	            publishedPayloadPaths.set(transferId, resolved.filePath);
	          }
	        }
	        if (!publishedPayloadPath) {
	          throw new Error(`Missing published direct-peer payload for ${transferId}`);
	        }
	        await copyFile(publishedPayloadPath, destinationPath);
	        return { destinationPath };
	      },
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

  it('fails closed when the persisted prepare-target job record is missing (resultGet uses job store only)', async () => {
    vi.resetModules();

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-prepare-job-missing-'));
    try {
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'server_test',
          workspaceReplicationBlobPackTargetBytes: 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 1024,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 1024 * 1024,
        },
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
	          },
	        }),
        importSessionBundle: async () => ({
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
	        }),
	      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_job_missing',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
      });

      let ready = await prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
      });
      if (ready.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          ready = await resultGet!({ handoffId: started.handoffId });
          expect(ready.status.status).toBe('ready_for_cutover');
        });
      }

      const prepareJobId = ready.status.jobId;
      expect(prepareJobId).toBeTypeOf('string');

      await rm(join(activeServerDir, 'session-handoff', 'prepare-target-jobs', `${prepareJobId}.json`), { force: true });

      await expect(resultGet!({ handoffId: started.handoffId })).resolves.toEqual({ ok: false, errorCode: 'not_found' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      vi.doUnmock('@/configuration');
    }
  });

  it('propagates handoff abort to the underlying workspace replication engine job (cancelRequestedAtMs)', async () => {
    vi.resetModules();

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-abort-wsrepl-'));
    try {
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'server_test',
        },
      }));

      const { createWorkspaceReplicationJobStore } = await import('@/workspaces/replication/jobs/workspaceReplicationJobStore');
      const jobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      await jobStore.write({
        schemaVersion: 1,
        jobId: 'job_wsrepl_1',
        createdAtMs: 1,
        updatedAtMs: 1,
        status: {
          status: 'in_progress',
          phase: 'planning',
          checkpoint: 'job_created',
          progressCounters: {
            plannedFiles: 0,
            plannedBytes: 0,
            transferredFiles: 0,
            transferredBytes: 0,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      const { writeJsonAtomic } = await import('@/utils/fs/writeJsonAtomic');
      const prepareJobId = 'prepare_job_1';
      const handoffId = 'handoff_abort_1';
      const prepareJobPath = join(activeServerDir, 'session-handoff', 'prepare-target-jobs', `${prepareJobId}.json`);
      await writeJsonAtomic(prepareJobPath, {
        schemaVersion: 1,
        jobId: prepareJobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 1,
        status: {
          handoffId,
          status: 'pending',
          phase: 'preparing',
          jobId: prepareJobId,
          recoveryActions: [],
        },
        workspaceReplicationJobId: 'job_wsrepl_1',
      });

      const { createSessionHandoffPrepareTargetJobStore } = await import('@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore');
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const persisted = await prepareJobStore.findByHandoffId(handoffId);
      expect(persisted?.workspaceReplicationJobId).toBe('job_wsrepl_1');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;

      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');
      registerHandlers({ rpcHandlerManager });

      const abort = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT);
      expect(abort).toBeDefined();

      await abort!({ handoffId, reason: 'user_abort' });

      const updated = await jobStore.read('job_wsrepl_1');
      expect(updated?.cancelRequestedAtMs).toBeTypeOf('number');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      vi.doUnmock('@/configuration');
    }
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

  it('publishes provider bundle + workspace replication transfers without a transferred-bundles handshake transfer when workspace replication metadata is present (V2 handoff start)', async () => {
    vi.resetModules();

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-start-v2-header-only-'));
    const published = await createPublishedDirectPeerPayloadRouter();
    try {
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'server_test',
          workspaceReplicationBlobPackTargetBytes: 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 1024,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 1024 * 1024,
        },
      }));

      const { createScmSourceControllerWorkspaceExportArtifacts } = await import('@/scm/sourceController/workspaceExportArtifacts');

      const exportSessionBundle: ExportSessionBundle = async () => ({
        providerBundle: {
          providerId: 'claude' as const,
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: '/repo',
	        workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts({
	          manifest: {
	            entries: [],
	            fingerprint: 'sha256:fp',
	          },
	        }),
	      });

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;

      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');
      registerHandlers({
        rpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: '/repo',
          flavor: 'claude',
          claudeSessionId: 'claude_session_1',
          portableMetadataVersion: 'v2',
        }),
        exportSessionBundle,
        directPeerTransfer: {
          publishTransfer: published.publishTransfer,
          requestPayloadFile: published.requestPayloadFile as any,
          clearPublishedTransfer: vi.fn(),
        },
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      expect(start).toBeDefined();

      const result = await start!({
        sessionId: 'sess_v2_header_only',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
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

      // Canonical V2: no inline/base64 bulk bytes inside the handoff start response.
      // Provider bundle bytes and workspace replication payloads are always transferred out-of-band.
      const rawResponse = JSON.stringify(result);
      expect(rawResponse).not.toContain('transcriptBase64');
      expect(rawResponse).not.toContain('contentBase64');

      expect(result.handoffMetadataV2).toMatchObject({
        workspaceReplicationSourceRootPath: '/repo',
      });

      const publishedTransferIds = published.listPublishedTransferIds();
      // Canonical V2: no transferred-bundles handshake transfer is published under the handoff id.
      expect(publishedTransferIds).not.toContain(String(result.handoffId));
      // Provider bundle + workspace manifest + blob packs are published out-of-band.
      expect(publishedTransferIds).toContain(`session-handoff:${result.handoffId}:provider-bundle-file`);
      expect(publishedTransferIds.some((transferId) => transferId.includes(':workspace-manifest'))).toBe(true);
      // Direct-peer blob packs must be resolved on-demand from the manifest token carrier, not pre-published up front.
      expect(publishedTransferIds.some((transferId) => transferId.includes(':workspace-pack'))).toBe(false);

      const manifestPublishCall = published.publishTransfer.mock.calls
        .map((call) => call?.[0])
        .find((input) => String(input?.transferId ?? '').includes(':workspace-manifest'));
      expect(manifestPublishCall).toBeDefined();
      expect(manifestPublishCall).toMatchObject({
        payload: {},
        onDemandScope: expect.any(Object),
      });
    } finally {
      await published.dispose();
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      vi.doUnmock('@/configuration');
    }
  });

  it('returns missing_handoff_metadata_v2 for direct-peer prepare payloads that omit handoffMetadataV2 (no transferred-bundles fallback)', async () => {
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
	      directPeerTransfer: {
	        publishTransfer: vi.fn(() => []),
	        requestPayloadFile: vi.fn(),
	        clearPublishedTransfer: vi.fn(),
	      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    await expect(prepare!({
      handoffId: 'handoff_missing_handoff_metadata_v2',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo-target',
      allowServerRoutedFallback: false,
      // Intentionally omit handoffMetadataV2 to prove we do not fall back to any transferred-bundles handshake.
    })).resolves.toEqual({
      ok: false,
      errorCode: 'missing_handoff_metadata_v2',
      error: 'Handoff metadata V2 is required to prepare the target',
    });

	    expect(importSessionBundle).not.toHaveBeenCalled();
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
      buildDirectPeerEndpointCandidate({ transferId: 'handoff_back' }),
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
      endpointCandidates: [],
      targetPath: '/repo-source-current',
      handoffMetadataV2: expect.objectContaining({
        providerBundleTransferPublication: expect.objectContaining({
          endpointCandidates: [
            expect.objectContaining({
              kind: 'http',
              url: buildDirectPeerEndpointCandidate({ transferId: 'handoff_back' }).url,
              expiresAt: expect.any(Number),
            }),
          ],
        }),
      }),
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
	    const importSessionBundle = vi.fn(async (_bundle: any, directory: string) => ({
	      remoteSessionId: 'claude_session_1',
	      directSource: {
	        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory,
        resume: 'claude_session_1',
	        transcriptStorage: 'direct',
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
        claudeSessionId: 'claude_session_1',
      }),
      exportSessionBundle: async () => ({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: '/repo',
	      }),
	      importSessionBundle,
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
	    expect(importSessionBundle).toHaveBeenCalledWith(
	      {
	        providerId: 'claude',
	        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      '/repo',
      'persisted',
    );
    expect(ready.resume).toEqual({
      directory: '/repo',
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

  it('surfaces workspace replication engine progress in status_get while prepare-target is pending', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-status-progress-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'test_status_progress',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');

      const workspaceReplicationJobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const handoffId = 'handoff_status_progress';
      const prepareJobId = 'prepare_status_progress';
      const workspaceReplicationJobId = 'job_status_progress';

      await workspaceReplicationJobStore.write({
        jobId: workspaceReplicationJobId,
        createdAtMs: 1,
        updatedAtMs: 1234,
        status: {
          status: 'in_progress',
          phase: 'transfer_missing_blobs_to_target_cas',
          checkpoint: 'blob_transfer_started',
          progressCounters: {
            plannedFiles: 10,
            plannedBytes: 100,
            transferredFiles: 3,
            transferredBytes: 30,
            appliedFiles: 0,
            appliedBytes: 0,
          },
          warnings: [],
          blockingDivergenceCandidates: [],
        },
      });

      await prepareJobStore.write({
        jobId: prepareJobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 2,
        workspaceReplicationJobId,
        status: {
          handoffId,
          jobId: prepareJobId,
          status: 'pending',
          phase: 'staging_target',
          progress: {
            updatedAtMs: 2,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
          recoveryActions: [],
        },
      });

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      registerHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
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
      });

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      expect(statusGet).toBeDefined();

      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'pending',
          phase: 'staging_target',
          jobId: prepareJobId,
          progress: {
            updatedAtMs: 1234,
            checkpoint: 'transfer_blobs',
            planned: {
              totalFiles: 10,
              totalBytes: 100,
            },
            transferred: {
              files: 3,
              bytes: 30,
            },
            current: {
              phaseDetail: expect.stringContaining('workspace_replication'),
            },
            resumable: false,
          },
        },
      });
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('reuses stored source-export payload sources when preparing on the same daemon (no inline payloads)', async () => {
    const exportDirectory = await mkdtemp(`${os.tmpdir()}/happier-handoff-export-`);
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const importSessionBundle = vi.fn(async (_bundle: any, directory: string) => ({
      remoteSessionId: 'claude_session_1',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory,
        resume: 'claude_session_1',
        transcriptStorage: 'persisted',
      }),
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
	          },
	          blobProvider: {
	            getBlobFilePath: () => `${exportDirectory}/README.md`,
	          },
	        }),
	        importSessionBundle,
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
	      expect(importSessionBundle).toHaveBeenCalledWith(
	        {
	          providerId: 'claude',
	          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        '/repo',
        'persisted',
      );
    } finally {
      await rm(exportDirectory, { recursive: true, force: true });
    }
  });

  it('delegates source-side workspace transfer preparation to the adapter seam when starting a handoff', async () => {
    const sourcePath = '/Users/tester/projects/demo';
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const createState = vi.fn(async () => ({
      workspaceReplicationMetadata: undefined,
    }));
    const resolveSourceOffer = vi.fn(async () => null);
    const prepareSourceWorkspaceTransfer = vi.fn(async () => ({
      handoffMetadataV2: {
        workspaceReplicationSourceRootPath: sourcePath,
        workspaceReplicationManifestTransferPublication: {
          transferId: 'session-handoff:test:workspace-manifest',
        },
      },
    }));
    const createSessionHandoffWorkspaceReplicationAdapter = vi.fn(() => ({
      createReplicationTransfers: () => ({}) as any,
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
	          sourceControllerMetadata: {
	            scmBackendId: 'git',
	          },
	        },
	        blobProvider: {
	          getBlobFilePath: () => `${sourcePath}/README.md`,
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
    }
  });

  it('delegates target-side workspace preparation to the adapter seam during prepare-target', async () => {
    const sourcePath = '/Users/tester/projects/demo';
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const createState = vi.fn(async () => ({
      workspaceReplicationMetadata: undefined,
    }));
    const resolveSourceOffer = vi.fn(async () => null);
    const prepareSourceWorkspaceTransfer = vi.fn(async () => ({
      handoffMetadataV2: {
        workspaceReplicationSourceRootPath: sourcePath,
        workspaceReplicationManifestTransferPublication: {
          transferId: `session-handoff:test:workspace-manifest`,
        },
      },
      workspaceReplicationMetadata: {
        sourceRootPath: sourcePath,
        manifest: {
          entries: [],
        },
      },
    }));
    const prepareTargetWorkspace = vi.fn(async (params: any) => {
      await params.onWorkspaceReplicationJobStarted?.('job_wsrepl_1');
      return {
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
      };
	    });
	    const createSessionHandoffWorkspaceReplicationAdapter = vi.fn(() => ({
	      createReplicationTransfers: () => ({}) as any,
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
	            sourceControllerMetadata: {
	              scmBackendId: 'git',
	            },
	          },
	          blobProvider: {
	            getBlobFilePath: () => `${sourcePath}/README.md`,
	          },
		        }),
	        importSessionBundle,
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
        ...(started.handoffMetadataV2 ? { handoffMetadataV2: started.handoffMetadataV2 } : {}),
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
	        assertCanContinue: expect.any(Function),
	        onWorkspaceReplicationJobStarted: expect.any(Function),
	        metadata: expect.objectContaining({
	          sourceRootPath: sourcePath,
	          manifest: expect.any(Object),
	        }),
	      }));
	      expect(importSessionBundle).toHaveBeenCalledWith(
	        {
	          providerId: 'claude',
	          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        '/repo-adapter-target',
        'persisted',
      );

      const { configuration } = await import('@/configuration');
      const { createSessionHandoffPrepareTargetJobStore } = await import('@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore');
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({
        activeServerDir: configuration.activeServerDir,
      });
      const persisted = await prepareJobStore.findByHandoffId(started.handoffId);
      expect(persisted?.workspaceReplicationJobId).toBe('job_wsrepl_1');
    } finally {
      vi.doUnmock('../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter');
      vi.resetModules();
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
	            entries: [],
	            fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
	          },
	        },
	      }),
	      importSessionBundle,
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
	    await prepare!({
	      handoffId: started.handoffId,
	      sourceMachineId: 'machine_source',
	      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

	    await resultGet!({ handoffId: started.handoffId });
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
      handoffMetadataV2: {
        providerBundleTransferPublication: {
          transferId: 'session-handoff:handoff_missing_transfer_source:provider-bundle-file',
          sizeBytes: 0,
          manifestHash: `sha256:${'0'.repeat(64)}`,
          // Intentionally omit endpointCandidates to force `direct_peer_transfer_unavailable`.
        },
      },
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

  it('keeps codex start responses canonical without inline payloads', async () => {
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
    const targetPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-target-workspace-'));
    const sourceBlobDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-source-blob-'));
    const baselinePayload = Buffer.from('previous\n', 'utf8');
    const baselineDigest = `sha256:${createHash('sha256').update(baselinePayload).digest('hex')}`;
    const baselineFingerprint = `sha256:${'1'.repeat(64)}`;
    await writeFile(join(targetPath, 'README.md'), baselinePayload);
    const directPeerWorkspacePayload = Buffer.from('direct-peer-pack\n', 'utf8');
    const directPeerWorkspaceDigest = `sha256:${createHash('sha256').update(directPeerWorkspacePayload).digest('hex')}`;
    const directPeerManifestFingerprint = `sha256:${'1'.repeat(64)}`;
    await writeFile(join(sourceBlobDir, 'README.md'), directPeerWorkspacePayload);
    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'sync_changes' as const,
      conflictPolicy: 'create_sibling_copy' as const,
      includeIgnoredMode: 'include_selected' as const,
      ignoredIncludeGlobs: ['dist/**'],
    };
    const sourceRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const targetRegistered = new Map<string, (params: unknown) => Promise<any>>();
	    const { publishTransfer, requestPayloadFile, requestPayloadFileWithOpenBody, dispose, listPublishedTransferIds } =
	      await createPublishedDirectPeerPayloadRouter();
      const requestPayloadFileWithOpenBodySpy = vi.fn(
        async (input: Parameters<typeof requestPayloadFileWithOpenBody>[0]) =>
          await requestPayloadFileWithOpenBody(input),
      );
	    const importSessionBundle = vi.fn(async (_bundle: unknown, directory: string) => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory,
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
      }),
    }));
	    const loadCurrentTargetManifest = vi.fn(async () => ({
      entries: [
        {
          relativePath: 'README.md',
          kind: 'file' as const,
          digest: baselineDigest,
          sizeBytes: baselinePayload.byteLength,
          executable: false,
        },
      ],
      fingerprint: baselineFingerprint,
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
      const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir: targetActiveServerDir });
      await baselineStore.save({
        scope: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRoot: sourcePath,
          targetMachineId: 'machine_target',
          targetWorkspaceRoot: targetPath,
          mode: 'one_way_safe',
        },
        baseline: {
          manifestFingerprint: baselineFingerprint,
          manifest: await loadCurrentTargetManifest(),
          savedAtMs: 0,
        },
      });

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
            sourceControllerMetadata: {
              scmBackendId: 'git',
            },
          },
          blobProvider: {
            getBlobFilePath: (digest: string) => (digest === directPeerWorkspaceDigest ? join(sourceBlobDir, 'README.md') : null),
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
	      vi.doMock('@/workspaces/replication/transport/workspaceReplicationTransfers', () => ({
	        createWorkspaceReplicationTransfers: () => ({
          publishDirectPeerSourceOffer: () => [],
          requestDirectPeerSourceOffer: async () => {
            throw new Error('Unexpected direct-peer source-offer request');
          },
          requestServerRoutedSourceOffer: async () => {
            throw new Error('Unexpected server-routed source-offer request');
          },
          publishDirectPeerBlobPack: () => [],
	          requestDirectPeerBlobPackToFile: async ({ transferId, endpointCandidates, destinationPath, openBody }: Readonly<{
	            transferId: string;
	            endpointCandidates: readonly TransferEndpointCandidate[];
	            destinationPath: string;
	            openBody?: unknown;
	          }>) => ({
	            destinationPath: (await requestPayloadFileWithOpenBodySpy({
	              transferId,
	              endpointCandidates,
	              destinationPath,
	              ...(openBody !== undefined ? { openBody } : {}),
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

      if (!started.handoffMetadataV2) {
        throw new Error('Expected start() to return handoffMetadataV2');
      }
      // Normalize to plain JSON and validate against the protocol schema (prepare-target request is strict).
      const normalizedMetadata = JSON.parse(JSON.stringify(started.handoffMetadataV2));
      const { SessionHandoffMetadataV2Schema } = await import('@happier-dev/protocol');
      const metadataParsed = SessionHandoffMetadataV2Schema.safeParse(normalizedMetadata);
      if (!metadataParsed.success) {
        throw new Error(`Invalid decoded handoffMetadataV2 fixture: ${metadataParsed.error.message}`);
      }
      const handoffMetadataV2: unknown = metadataParsed.data;
      expect(handoffMetadataV2).toBeDefined();

      const prepared = await prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath,
        workspaceTransfer,
        endpointCandidates: started.endpointCandidates,
        handoffMetadataV2,
      });
      if ('ok' in prepared && prepared.ok === false) {
        throw new Error(`unexpected prepare failure: ${prepared.errorCode}:${prepared.error}`);
      }

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
          directory: expect.any(String),
          agent: 'claude',
          resume: 'claude_session_target',
          transcriptStorage: 'persisted',
          approvedNewDirectoryCreation: true,
        },
      });
      await expect(resultGet!({ handoffId: started.handoffId })).resolves.toEqual(ready);
      const requestedTransferIds = [
        ...requestPayloadFile.mock.calls.map(([call]) => call.transferId),
        ...requestPayloadFileWithOpenBodySpy.mock.calls.map(([call]) => call.transferId),
      ];
      expect(requestedTransferIds).not.toContain(started.handoffId);
      expect(requestedTransferIds).toContain(`session-handoff:${started.handoffId}:provider-bundle-file`);
      expect(requestedTransferIds.some((transferId) => transferId.includes(':workspace-manifest'))).toBe(true);
      expect(requestedTransferIds.some((transferId) => transferId.includes('workspace-pack'))).toBe(true);
      const publishedTransferIds = listPublishedTransferIds();
      expect(publishedTransferIds).not.toContain(started.handoffId);
      expect(publishedTransferIds).toContain(`session-handoff:${started.handoffId}:provider-bundle-file`);
      expect(publishedTransferIds.some((transferId) => transferId.includes(':workspace-manifest'))).toBe(true);
      // Direct-peer blob packs are resolved on demand (they are not pre-published via publishTransfer).
      const publishedWorkspacePackCalls = publishTransfer.mock.calls.filter(
        ([call]) => typeof call.transferId === 'string' && call.transferId.includes('workspace-pack'),
      );
      expect(publishedWorkspacePackCalls).toHaveLength(0);
      expect(
        requestPayloadFileWithOpenBodySpy.mock.calls.some(
          ([call]) => typeof call.transferId === 'string' && call.transferId.includes('workspace-pack'),
        ),
      ).toBe(true);
	      // Runtime owns manifest loading; the handler must not fall back to legacy workspace import paths.
	      const { createWorkspaceReplicationJobStore } = await import('@/workspaces/replication/jobs/workspaceReplicationJobStore');
	      const workspaceReplicationJobStore = createWorkspaceReplicationJobStore({ activeServerDir: targetActiveServerDir });
      await expect(
        workspaceReplicationJobStore.findByCorrelationId(`session_handoff_workspace_prepare_target:${started.handoffId}`),
	      ).resolves.toMatchObject({
	        status: {
	          status: 'completed',
	          checkpoint: 'baseline_committed',
	        },
	      });
	      const importedDirectory = ready.resume.directory;
      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        importedDirectory,
        'persisted',
      );
    } finally {
      vi.doUnmock('@/workspaces/replication/transport/workspaceReplicationTransfers');
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await dispose();
      await rm(sourceBlobDir, { recursive: true, force: true });
      await rm(sourceActiveServerDir, { recursive: true, force: true });
      await rm(targetActiveServerDir, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
    }
  });

  it('publishes provider bundle + workspace replication transfers without inline workspace blobs when workspace transfer is enabled (V2 start)', async () => {
    vi.resetModules();

    const sourcePath = '/Users/tester/projects/direct-peer-header-only';
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-header-only-'));
    const workspaceBlobDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-header-only-blob-'));
    const workspaceBlobPayload = Buffer.from('direct-peer-pack\n', 'utf8');
    const workspaceBlobDigest = `sha256:${createHash('sha256').update(workspaceBlobPayload).digest('hex')}`;
    const workspaceManifestFingerprint = `sha256:${'1'.repeat(64)}`;
    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'sync_changes' as const,
      conflictPolicy: 'create_sibling_copy' as const,
      includeIgnoredMode: 'include_selected' as const,
      ignoredIncludeGlobs: ['dist/**'],
    };

    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const { publishTransfer, requestPayloadFile, dispose } = await createPublishedDirectPeerPayloadRouter();

    try {
      const workspaceBlobPath = join(workspaceBlobDir, 'README.md');
      await writeFile(workspaceBlobPath, workspaceBlobPayload);
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_direct_peer_header_only',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');

      registerHandlers({
        rpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          homeDir: '/Users/tester',
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
                  digest: workspaceBlobDigest,
                  sizeBytes: workspaceBlobPayload.byteLength,
                  executable: false,
                },
              ],
              fingerprint: workspaceManifestFingerprint,
            },
            sourceControllerMetadata: {
              scmBackendId: 'git',
            },
          },
          blobProvider: {
            getBlobFilePath: (digest: string) => (digest === workspaceBlobDigest ? workspaceBlobPath : null),
          },
        }),
        directPeerTransfer: {
          publishTransfer,
          requestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        },
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      expect(start).toBeDefined();

      const started = await start!({
        sessionId: 'sess_direct_peer_header_only',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
        workspaceTransfer,
      });

      if ('ok' in started && started.ok === false) {
        throw new Error(`unexpected start failure: ${started.errorCode}:${started.error}`);
      }

      const publishedTransferIds = new Set(publishTransfer.mock.calls.map(([call]) => String(call.transferId)));
      expect(publishedTransferIds.has(started.handoffId)).toBe(false);
      expect(publishedTransferIds.has(`session-handoff:${started.handoffId}:provider-bundle-file`)).toBe(true);
      expect([...publishedTransferIds].some((transferId) => transferId.includes(':workspace-manifest'))).toBe(true);
      expect([...publishedTransferIds].some((transferId) => transferId.includes('workspace-pack'))).toBe(false);

      const providerBundlePublishCall = publishTransfer.mock.calls.find(
        ([call]) => call.transferId === `session-handoff:${started.handoffId}:provider-bundle-file`,
      )?.[0];
      expect(providerBundlePublishCall?.payloadSource?.kind).toBe('file');
      if (!providerBundlePublishCall?.payloadSource || providerBundlePublishCall.payloadSource.kind !== 'file') {
        throw new Error('Expected file-backed provider bundle publication');
      }
      const providerBundleContents = await readFile(providerBundlePublishCall.payloadSource.filePath, 'utf8');
      expect(providerBundleContents).not.toContain(workspaceBlobPayload.toString('utf8'));

      expect(started.handoffMetadataV2).toEqual(expect.objectContaining({
        providerBundleTransferPublication: expect.objectContaining({
          transferId: `session-handoff:${started.handoffId}:provider-bundle-file`,
          endpointCandidates: expect.any(Array),
        }),
        workspaceReplicationSourceRootPath: sourcePath,
        workspaceReplicationManifestTransferPublication: expect.objectContaining({
          transferId: `session-handoff:${started.handoffId}:workspace-manifest`,
        }),
      }));
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await dispose();
      await rm(workspaceBlobDir, { recursive: true, force: true });
      await rm(sourceActiveServerDir, { recursive: true, force: true });
    }
  });

  it('applies server-routed workspace sync through the replication engine when workspace transfer is enabled', async () => {
    vi.resetModules();

    const sourcePath = '/Users/tester/projects/server-routed';
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-target-'));
    const targetPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-target-workspace-'));
    const sourceBlobDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-source-blob-'));
    const baselinePayload = Buffer.from('previous\n', 'utf8');
    const baselineDigest = `sha256:${createHash('sha256').update(baselinePayload).digest('hex')}`;
    const baselineFingerprint = `sha256:${'1'.repeat(64)}`;
    const workspaceBlobPayload = Buffer.from('server-routed-pack\n', 'utf8');
    const workspaceBlobDigest = `sha256:${createHash('sha256').update(workspaceBlobPayload).digest('hex')}`;
    await writeFile(join(sourceBlobDir, 'README.md'), workspaceBlobPayload);
    await writeFile(join(targetPath, 'README.md'), baselinePayload);
    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'sync_changes' as const,
      conflictPolicy: 'create_sibling_copy' as const,
      includeIgnoredMode: 'include_selected' as const,
      ignoredIncludeGlobs: ['dist/**'],
    };
    const sourceRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const targetRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const importSessionBundle = vi.fn(async (_bundle: unknown, directory: string) => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory,
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
	      }),
	    }));
	    const loadCurrentTargetManifest = vi.fn(async () => ({
      entries: [
        {
          relativePath: 'README.md',
          kind: 'file' as const,
          digest: baselineDigest,
          sizeBytes: baselinePayload.byteLength,
          executable: false,
        },
      ],
      fingerprint: baselineFingerprint,
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
      const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir: targetActiveServerDir });
      await baselineStore.save({
        scope: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRoot: sourcePath,
          targetMachineId: 'machine_target',
          targetWorkspaceRoot: targetPath,
          mode: 'one_way_safe',
        },
        baseline: {
          manifestFingerprint: baselineFingerprint,
          manifest: await loadCurrentTargetManifest(),
          savedAtMs: 0,
        },
      });

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
                  digest: workspaceBlobDigest,
                  sizeBytes: workspaceBlobPayload.byteLength,
                  executable: false,
                },
              ],
              fingerprint: 'sha256:0f17985b1cd57fb85b266f9106da8e3feec58da8fe9b31f6d9e4e83079a996f0',
            },
            sourceControllerMetadata: {
              scmBackendId: 'git',
            },
          },
          blobProvider: {
            getBlobFilePath: (digest: string) => {
              if (digest !== workspaceBlobDigest) {
                return null;
              }
              return join(sourceBlobDir, 'README.md');
            },
          },
        }),
        machineTransferChannel: channels.source,
	      });

	      vi.resetModules();
	      vi.doUnmock('../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter');
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
        targetPath,
        workspaceTransfer,
        ...(started.handoffMetadataV2 ? { handoffMetadataV2: started.handoffMetadataV2 } : {}),
      });

      const prepared = await preparePromise;
      if ('ok' in prepared && prepared.ok === false) {
        throw new Error(`unexpected prepare failure: ${prepared.errorCode}:${prepared.error}`);
      }
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
	      // Runtime owns manifest loading; the handler must not fall back to legacy workspace import paths.
	      const { createWorkspaceReplicationJobStore } = await import('@/workspaces/replication/jobs/workspaceReplicationJobStore');
	      const workspaceReplicationJobStore = createWorkspaceReplicationJobStore({ activeServerDir: targetActiveServerDir });
      await expect(
        workspaceReplicationJobStore.findByCorrelationId(`session_handoff_workspace_prepare_target:${started.handoffId}`),
      ).resolves.toMatchObject({
        status: {
          status: 'completed',
          checkpoint: 'baseline_committed',
        },
      });
	      const importedDirectory = ready.resume.directory;
      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        importedDirectory,
        'persisted',
      );
      const openTransferIds = channels.sentEnvelopes
        .filter((entry) => entry.envelope.kind === 'open')
        .map((entry) => entry.envelope.transferId);
      expect(openTransferIds).not.toContain(`session-handoff:${started.handoffId}`);
      expect(openTransferIds).toContain(`session-handoff:${started.handoffId}:provider-bundle-file`);
      expect(openTransferIds.some((transferId) => transferId.includes(':workspace-manifest'))).toBe(true);
      expect(openTransferIds.some((transferId) => transferId.includes(':workspace-pack:'))).toBe(true);
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(sourceBlobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(targetActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('acknowledges server-routed workspace handoff start before a large workspace export finishes and lets prepare wait for it', async () => {
    vi.resetModules();

    const sourcePath = '/Users/tester/projects/server-routed-deferred';
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-deferred-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-deferred-target-'));
    const sourceBlobDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-deferred-source-blob-'));
    const workspaceBlobPayload = Buffer.from('server-routed-pack\n', 'utf8');
    const workspaceBlobDigest = `sha256:${createHash('sha256').update(workspaceBlobPayload).digest('hex')}`;
    await writeFile(join(sourceBlobDir, 'README.md'), workspaceBlobPayload);
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
        sourceControllerMetadata: {
          scmBackendId: 'git';
        };
      };
      blobProvider?: {
        getBlobFilePath: (digest: string) => string | null;
      };
    }>>();
    const importSessionBundle = vi.fn(async (_bundle: unknown, directory: string) => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory,
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
      }),
	    }));
	    const loadCurrentTargetManifest = vi.fn(async () => ({
	      entries: [],
	      fingerprint: `sha256:${'0'.repeat(64)}`,
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
      const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir: targetActiveServerDir });
      await baselineStore.save({
        scope: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRoot: sourcePath,
          targetMachineId: 'machine_target',
          targetWorkspaceRoot: '/repo-target',
          mode: 'one_way_safe',
        },
        baseline: {
          manifestFingerprint: `sha256:${'0'.repeat(64)}`,
          manifest: await loadCurrentTargetManifest(),
          savedAtMs: 0,
        },
      });
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
	      vi.doUnmock('../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter');
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
        ...(started.handoffMetadataV2 ? { handoffMetadataV2: started.handoffMetadataV2 } : {}),
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
                digest: workspaceBlobDigest,
                sizeBytes: workspaceBlobPayload.byteLength,
                executable: false,
              },
            ],
            fingerprint: 'sha256:0f17985b1cd57fb85b266f9106da8e3feec58da8fe9b31f6d9e4e83079a996f0',
          },
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
        blobProvider: {
          getBlobFilePath: (digest: string) => (digest === workspaceBlobDigest ? join(sourceBlobDir, 'README.md') : null),
        },
      });

      let ready = prepareAck;
      const { createSessionHandoffPrepareTargetJobStore } = await import('@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore');
      const prepareTargetJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir: targetActiveServerDir });
      await vi.waitFor(async () => {
        const next = await resultGet!({ handoffId: started.handoffId });
        if (next && typeof next === 'object' && 'ok' in next && next.ok === false) {
          const record = await prepareTargetJobStore.read(prepareAck.status.jobId ?? 'missing_job_id');
          if (record?.status.status === 'awaiting_recovery' && record.lastErrorMessage) {
            throw new Error(`prepare-target failed: ${record.lastErrorMessage}`);
          }
          // Result-get is allowed to fail closed as not_found until the async prepare job persists a result.
          throw new Error(`prepare-target result not ready (${String((next as any).errorCode ?? 'unknown')})`);
        }
        ready = next;
        expect(ready.status.status).toBe('ready_for_cutover');
      }, { timeout: 10_000 });

      expect(ready.status.transportStrategy).toBe('server_routed_stream');
      const { createWorkspaceReplicationJobStore } = await import('@/workspaces/replication/jobs/workspaceReplicationJobStore');
      const workspaceReplicationJobStore = createWorkspaceReplicationJobStore({ activeServerDir: targetActiveServerDir });
      await expect(
        workspaceReplicationJobStore.findByCorrelationId(`session_handoff_workspace_prepare_target:${started.handoffId}`),
      ).resolves.toMatchObject({
        status: {
          status: 'completed',
          checkpoint: 'baseline_committed',
        },
      });
      const importedDirectory = ready.resume.directory;
      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        importedDirectory,
        'persisted',
      );

      await startedPromise;
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(sourceActiveServerDir, { recursive: true, force: true });
      await rm(targetActiveServerDir, { recursive: true, force: true });
      await rm(sourceBlobDir, { recursive: true, force: true });
    }
  });

  it('acknowledges direct-peer workspace handoff start before a large workspace export finishes when server-routed fallback is available', async () => {
    vi.resetModules();

    const sourcePath = '/Users/tester/projects/direct-peer-deferred';
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-deferred-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-deferred-target-'));
    const targetPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-deferred-target-workspace-'));
    const sourceBlobDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-deferred-source-blob-'));
    const workspaceBlobPayload = Buffer.from('direct-peer-deferred-pack\n', 'utf8');
    const workspaceBlobDigest = `sha256:${createHash('sha256').update(workspaceBlobPayload).digest('hex')}`;
    await writeFile(join(sourceBlobDir, 'README.md'), workspaceBlobPayload);

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
        sourceControllerMetadata: {
          scmBackendId: 'git';
        };
      };
      blobProvider?: {
        getBlobFilePath: (digest: string) => string | null;
      };
    }>>();

    const importSessionBundle = vi.fn(async (_bundle: unknown, directory: string) => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory,
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
      }),
    }));

    const loadCurrentTargetManifest = vi.fn(async () => ({
      entries: [],
      fingerprint: `sha256:${'0'.repeat(64)}`,
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
      const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir: targetActiveServerDir });
      await baselineStore.save({
        scope: {
          sourceMachineId: 'machine_source',
          sourceWorkspaceRoot: sourcePath,
          targetMachineId: 'machine_target',
          targetWorkspaceRoot: '/repo-target',
          mode: 'one_way_safe',
        },
        baseline: {
          manifestFingerprint: `sha256:${'0'.repeat(64)}`,
          manifest: await loadCurrentTargetManifest(),
          savedAtMs: 0,
        },
      });

      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_direct_peer_deferred_source',
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
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile: vi.fn(async () => {
            throw new Error('direct peer request should not be needed in deferred-start fallback');
          }),
          clearPublishedTransfer: vi.fn(),
        } as any,
      });

      vi.resetModules();
      vi.doUnmock('../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationAdapter');
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: targetActiveServerDir,
          activeServerId: 'test_direct_peer_deferred_target',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerTargetHandlers } = await import('./rpcHandlers.sessionHandoff');

      registerTargetHandlers({
        rpcHandlerManager: targetRpcHandlerManager,
        importSessionBundle,
        machineTransferChannel: channels.target,
      });

      const sourceStart = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const targetPrepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const resultGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(sourceStart).toBeDefined();
      expect(targetPrepare).toBeDefined();
      expect(resultGet).toBeDefined();

      let started: any = null;
      sourceStart!({
        sessionId: 'sess_direct_peer_replication_prepare_deferred',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        negotiatedTransportStrategy: 'direct_peer',
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
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo-target',
        workspaceTransfer,
        ...(started.handoffMetadataV2 ? { handoffMetadataV2: started.handoffMetadataV2 } : {}),
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
                digest: workspaceBlobDigest,
                sizeBytes: workspaceBlobPayload.byteLength,
                executable: false,
              },
            ],
            fingerprint: 'sha256:0f17985b1cd57fb85b266f9106da8e3feec58da8fe9b31f6d9e4e83079a996f0',
          },
          sourceControllerMetadata: {
            scmBackendId: 'git',
          },
        },
        blobProvider: {
          getBlobFilePath: (digest: string) => (digest === workspaceBlobDigest ? join(sourceBlobDir, 'README.md') : null),
        },
      });

      let ready = prepareAck;
      await vi.waitFor(async () => {
        const next = await resultGet!({ handoffId: started.handoffId });
        if (next && typeof next === 'object' && 'ok' in next && next.ok === false) {
          throw new Error(`prepare-target result not ready (${String((next as any).errorCode ?? 'unknown')})`);
        }
        ready = next;
        expect(ready.status.status).toBe('ready_for_cutover');
      }, { timeout: 10_000 });

      // Since start was deferred (no direct-peer publication yet), prepare must transparently fall back to server-routed.
      expect(ready.status.transportStrategy).toBe('server_routed_stream');

      // Ensure the replication engine actually ran on the target.
      const { createWorkspaceReplicationJobStore } = await import('@/workspaces/replication/jobs/workspaceReplicationJobStore');
      const workspaceReplicationJobStore = createWorkspaceReplicationJobStore({ activeServerDir: targetActiveServerDir });
      await expect(
        workspaceReplicationJobStore.findByCorrelationId(`session_handoff_workspace_prepare_target:${started.handoffId}`),
      ).resolves.toMatchObject({
        status: {
          status: 'completed',
          checkpoint: 'baseline_committed',
        },
      });

      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        ready.resume.directory,
        'persisted',
      );
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(sourceActiveServerDir, { recursive: true, force: true });
      await rm(targetActiveServerDir, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
      await rm(sourceBlobDir, { recursive: true, force: true });
    }
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
	      registerTargetHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            targetRegistered.set(method, handler);
          },
	        } as any,
	        importSessionBundle,
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
	      registerTargetHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            targetRegistered.set(method, handler);
          },
	        } as any,
	        importSessionBundle,
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
	    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

	    registerMachineSessionHandoffRpcHandlers({
	      rpcHandlerManager,
	      importSessionBundle,
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
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    const handoffId = 'handoff_invalid_server_routed_inline_fallback';
    const providerBundleTransferId = `session-handoff:${handoffId}:provider-bundle-file`;
    const preparePromise = prepare!({
      handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    const recipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(
      sendEnvelope,
      providerBundleTransferId,
    );

    const malformedServerRoutedPayload = Buffer.from('{"providerId":', 'utf8');

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
          transferId: providerBundleTransferId,
          kind: 'finish',
          manifestHash: `sha256:${createHash('sha256').update(malformedServerRoutedPayload).digest('hex')}`,
        },
      });
    }

	    await expect(preparePromise).rejects.toThrow();
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
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    const handoffId = 'handoff_invalid_server_routed';
    const providerBundleTransferId = `session-handoff:${handoffId}:provider-bundle-file`;
    const preparePromise = prepare!({
      handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
    });

    const recipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(
      sendEnvelope,
      providerBundleTransferId,
    );

    const dispatchEnvelope = (payload: MachineTransferReceiveEnvelope) => {
      for (const listener of listeners) {
        listener(payload);
      }
    };
    // Missing transcriptBase64 (required).
    const invalidServerRoutedPayload = Buffer.from(JSON.stringify({
      providerId: 'claude',
      remoteSessionId: 'claude_session_source',
    }), 'utf8');

    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: providerBundleTransferId,
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: providerBundleTransferId,
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
        transferId: providerBundleTransferId,
        kind: 'finish',
        manifestHash: `sha256:${createHash('sha256').update(invalidServerRoutedPayload).digest('hex')}`,
      },
    });

	    await expect(preparePromise).rejects.toThrow();
	    expect(importSessionBundle).not.toHaveBeenCalled();
	  });

  it('fails closed when the server-routed workspace replication manifest payload uses the legacy non-streaming format', async () => {
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
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
    expect(prepare).toBeDefined();

    const handoffId = 'handoff_invalid_server_routed_workspace_manifest_format';
    const providerBundleTransferId = `session-handoff:${handoffId}:provider-bundle-file`;
    const manifestTransferId = `session-handoff:${handoffId}:workspace-manifest`;
    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'sync_changes' as const,
      conflictPolicy: 'create_sibling_copy' as const,
      includeIgnoredMode: 'include_selected' as const,
      ignoredIncludeGlobs: ['dist/**'],
    };
    const preparePromise = prepare!({
      handoffId,
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      workspaceTransfer,
      handoffMetadataV2: {
        workspaceReplicationSourceRootPath: '/repo',
        workspaceReplicationManifestTransferPublication: {
          transferId: manifestTransferId,
        },
      },
    });

    const providerRecipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(sendEnvelope, providerBundleTransferId);

    // Provide a valid provider bundle so the prepare flow reaches manifest fetch.
    const providerBundlePayload = Buffer.from(JSON.stringify({
      providerId: 'claude',
      remoteSessionId: 'claude_session_source',
      transcriptBase64: 'e30K',
    }), 'utf8');

    const dispatchEnvelope = (payload: MachineTransferReceiveEnvelope) => {
      for (const listener of listeners) {
        listener(payload);
      }
    };
    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: providerBundleTransferId,
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: providerBundleTransferId,
          sequence: 0,
          payload: providerBundlePayload,
          recipientPublicKeyBase64: providerRecipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(11),
        }),
      },
    });
    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: providerBundleTransferId,
        kind: 'finish',
        manifestHash: `sha256:${createHash('sha256').update(providerBundlePayload).digest('hex')}`,
      },
    });

    // Now respond to the workspace manifest request with legacy whole-buffer JSON.
    const manifestRecipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(sendEnvelope, manifestTransferId);
    const legacyManifestPayload = Buffer.from(JSON.stringify({
      entries: [],
      fingerprint: 'sha256:manifest_legacy',
    }), 'utf8');

    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: manifestTransferId,
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: manifestTransferId,
          sequence: 0,
          payload: legacyManifestPayload,
          recipientPublicKeyBase64: manifestRecipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(12),
        }),
      },
    });
    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: manifestTransferId,
        kind: 'finish',
        manifestHash: `sha256:${createHash('sha256').update(legacyManifestPayload).digest('hex')}`,
      },
    });

	    await expect(preparePromise).rejects.toThrow(/workspace replication manifest/i);
	    expect(importSessionBundle).not.toHaveBeenCalled();
	  });

  it('publishes direct-peer endpoint candidates on start and reuses same-daemon payload sources before re-requesting them', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const requestPayloadFile = vi.fn(async () => {
      throw new Error('same-daemon prepare should reuse stored payload source');
    });
    const publishTransfer = vi.fn(
      (_params: Readonly<{
        transferId: string;
        payload: Readonly<Record<never, never>>;
        payloadSource?: DirectPeerPublishPayloadSource;
      }>): readonly TransferEndpointCandidate[] => [
        buildDirectPeerEndpointCandidate({ transferId: 'handoff_direct_peer' }),
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
        },
	      }),
	      importSessionBundle,
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
    const publishedPayloadSource = publishTransfer.mock.calls[0]?.[0]?.payloadSource;
    expect(publishedPayloadSource?.kind).toBe('file');
    if (publishedPayloadSource?.kind !== 'file') {
      throw new Error('Expected a file-backed direct-peer payload source');
    }
    await expect(access(publishedPayloadSource.filePath)).resolves.toBeUndefined();
    expect(started.endpointCandidates).toEqual([]);
    expect(started.handoffMetadataV2?.providerBundleTransferPublication?.endpointCandidates?.length ?? 0).toBeGreaterThan(0);
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
	    expect(importSessionBundle).toHaveBeenCalledWith(
      {
        providerId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      '/repo',
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
      ({ transferId }: Readonly<{ transferId: string; payload: Readonly<Record<never, never>> }>): readonly TransferEndpointCandidate[] => [
        buildDirectPeerEndpointCandidate({
          transferId,
          authorizationToken: 'test-token',
          port: 46001,
        }),
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

  it('fails closed when the direct-peer provider bundle payload is malformed', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const { requestPayloadFile, dispose } = await createDirectPeerRequestPayloadFile({
      payload: Buffer.from('{"providerId":', 'utf8'),
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
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    try {
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        importSessionBundle,
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
        handoffMetadataV2: {
          providerBundleTransferPublication: {
            transferId: 'session-handoff:handoff_invalid_direct_peer_payload:provider-bundle-file',
            sizeBytes: 0,
            manifestHash: `sha256:${'0'.repeat(64)}`,
            endpointCandidates: [
              {
                ...buildDirectPeerEndpointCandidate({
                  transferId: 'session-handoff:handoff_invalid_direct_peer_payload:provider-bundle-file',
                  authorizationToken: 'test-token',
                  port: 46001,
                }),
              },
            ],
          },
        },
        endpointCandidates: [
          {
            ...buildDirectPeerEndpointCandidate({
              transferId: 'session-handoff:handoff_invalid_direct_peer_payload:provider-bundle-file',
              authorizationToken: 'test-token',
              port: 46001,
            }),
          },
        ],
      })).rejects.toThrow();

      expect(importSessionBundle).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('fails closed when the direct-peer provider bundle payload fails schema validation', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const { requestPayloadFile, dispose } = await createDirectPeerRequestPayloadFile({
      payload: Buffer.from(JSON.stringify({
        providerId: 'claude',
        remoteSessionId: 'claude_session_source',
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
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    try {
      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        importSessionBundle,
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
        handoffMetadataV2: {
          providerBundleTransferPublication: {
            transferId: 'session-handoff:handoff_invalid_direct_peer_workspace_artifacts:provider-bundle-file',
            sizeBytes: 0,
            manifestHash: `sha256:${'0'.repeat(64)}`,
            endpointCandidates: [
              {
                kind: 'http',
                url: buildDirectPeerEndpointCandidate({ transferId: 'handoff_invalid_direct_peer_workspace_artifacts' }).url,
                authorizationToken: 'test-token',
                expiresAt: Date.now() + 30_000,
              },
            ],
          },
        },
        endpointCandidates: [
          {
            kind: 'http',
            url: buildDirectPeerEndpointCandidate({ transferId: 'handoff_invalid_direct_peer_workspace_artifacts' }).url,
            authorizationToken: 'test-token',
            expiresAt: Date.now() + 30_000,
          },
        ],
      })).rejects.toThrow();

      expect(importSessionBundle).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('fails closed when direct-peer transfer fails and fallback is forbidden', async () => {
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

    await expect(prepare!({
      handoffId: 'handoff_direct_peer_forbidden_fallback',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      allowServerRoutedFallback: false,
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      handoffMetadataV2: {
        providerBundleTransferPublication: {
          transferId: 'session-handoff:handoff_direct_peer_forbidden_fallback:provider-bundle-file',
          sizeBytes: 0,
          manifestHash: `sha256:${'0'.repeat(64)}`,
          endpointCandidates: [
            {
              kind: 'http',
              url: buildDirectPeerEndpointCandidate({ transferId: 'handoff_direct_peer_forbidden_fallback' }).url,
              authorizationToken: 'test-token',
              expiresAt: Date.now() + 30_000,
            },
          ],
        },
      },
      endpointCandidates: [
        {
          kind: 'http',
          url: buildDirectPeerEndpointCandidate({ transferId: 'handoff_direct_peer' }).url,
          authorizationToken: 'test-token',
          expiresAt: Date.now() + 30_000,
        },
      ],
    })).resolves.toEqual({
      ok: false,
      errorCode: 'direct_peer_transfer_unavailable',
      error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
    });

    expect(requestPayloadFile).toHaveBeenCalledTimes(1);
  });
});
