import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { requestServerRoutedTransferToFile } from '../../machines/transfer/serverRoutedTransport';
import { createWorkspaceReplicationBaselineStore } from '../../workspaces/replication/baseline/workspaceReplicationBaselineStore';
import { createWorkspaceReplicationJobStore } from '../../workspaces/replication/jobs/workspaceReplicationJobStore';
import { createWorkspaceReplicationPackIdForDigests } from '../../workspaces/replication/transport/workspaceReplicationPackId';
import { createSessionHandoffPrepareTargetJobStore } from '../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { buildSessionHandoffProviderBundleTransferId } from '../../session/handoff/sessionHandoffProviderBundleTransferPublication';
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
          // `manifestHash` is an internal transport detail (the responder sends a sentinel at open and
          // the real hash at finish). Do not pin it in handoff tests.
          manifestHash: expect.any(String),
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
		      requestPayloadFile: vi.fn(async ({ transferId, destinationPath, endpointCandidates }) => {
		        let publishedPayloadPath = publishedPayloadPaths.get(transferId);
		        if (!publishedPayloadPath) {
		          const authorizationToken = endpointCandidates
		            .map((candidate) => candidate.authorizationToken)
		            .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
		          const scope = authorizationToken ? onDemandScopesByToken.get(authorizationToken) : null;
		          if (scope?.allowTransferId(transferId) === true) {
		            const resolved = await scope.resolvePayloadSourceOnOpen({
		              transferId,
		              requestBody: null,
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

  it('returns not_found from resultGet when prepare-target is still in progress (status should be read via status_get)', async () => {
    vi.resetModules();

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-prepare-job-pending-resultget-'));
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

      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const handoffId = 'handoff_pending_resultget';
      const jobId = 'prepare_pending_resultget';

      await prepareJobStore.write({
        jobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 2,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
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
        },
      });

      const leaseDirectory = join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        jobId,
        'lease',
      );
      const nowMs = Date.now();
      await mkdir(leaseDirectory, { recursive: true });
      await writeFile(
        join(leaseDirectory, 'lease.json'),
        `${JSON.stringify({
          ownerId: 'other_instance',
          acquiredAtMs: nowMs,
          renewedAtMs: nowMs,
          expiresAtMs: nowMs + 60_000,
        })}\n`,
        'utf8',
      );

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      registerHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);
      expect(resultGet).toBeDefined();

      await expect(resultGet!({ handoffId })).resolves.toEqual({ ok: false, errorCode: 'not_found' });
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
        failedAtMs: 2,
        lastErrorMessage: 'Timed out waiting for machine transfer workspace-manifest',
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

      const prepareJobAfterAbort = await prepareJobStore.read(prepareJobId);
      expect(prepareJobAfterAbort?.status.status).toBe('aborted');
      expect(prepareJobAfterAbort?.failedAtMs).toBe(2);
      expect(prepareJobAfterAbort?.lastErrorMessage).toBe('Timed out waiting for machine transfer workspace-manifest');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      vi.doUnmock('@/configuration');
    }
  });

  it('persists terminal abort/commit status when only a persisted source-export exists (no prepare job)', async () => {
    vi.resetModules();

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-terminal-source-export-only-'));
    try {
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'server_test',
        },
      }));

      const { writeJsonAtomic } = await import('@/utils/fs/writeJsonAtomic');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;

      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');
      registerHandlers({ rpcHandlerManager });

      const abort = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT);
      const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      expect(abort).toBeDefined();
      expect(commit).toBeDefined();
      expect(statusGet).toBeDefined();

      const abortHandoffId = 'handoff_source_export_abort_only';
      const abortRecordDir = join(activeServerDir, 'session-handoff', abortHandoffId);
      await mkdir(abortRecordDir, { recursive: true });
      await writeJsonAtomic(join(abortRecordDir, 'source-export.json'), {
        t: 'session_handoff_source_export_v1',
        schemaVersion: 1,
        handoffId: abortHandoffId,
        exportedAtMs: 1,
      });

      await abort!({ handoffId: abortHandoffId, reason: 'user_abort' });
      await expect(statusGet!({ handoffId: abortHandoffId })).resolves.toMatchObject({
        handoffId: abortHandoffId,
        status: { status: 'aborted' },
      });

      const commitHandoffId = 'handoff_source_export_commit_only';
      const commitRecordDir = join(activeServerDir, 'session-handoff', commitHandoffId);
      await mkdir(commitRecordDir, { recursive: true });
      await writeJsonAtomic(join(commitRecordDir, 'source-export.json'), {
        t: 'session_handoff_source_export_v1',
        schemaVersion: 1,
        handoffId: commitHandoffId,
        exportedAtMs: 1,
      });

      await commit!({ handoffId: commitHandoffId, mode: 'source_cleanup' });
      await expect(statusGet!({ handoffId: commitHandoffId })).resolves.toMatchObject({
        handoffId: commitHandoffId,
        status: { status: 'completed' },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      vi.doUnmock('@/configuration');
      vi.resetModules();
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
	    });
	  });

  it('publishes provider bundle + workspace replication transfers without a transferred-bundles handshake transfer when workspace replication metadata is present (V2 handoff start)', async () => {
    vi.resetModules();

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-start-v2-header-only-'));
    const workspaceRoot = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-start-v2-workspace-'));
    const published = await createPublishedDirectPeerPayloadRouter();
    try {
      await mkdir(join(workspaceRoot, 'files'), { recursive: true });
      await writeFile(join(workspaceRoot, 'files', 'a.txt'), 'hello\n', 'utf8');

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
	        targetPath: workspaceRoot,
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
	          path: workspaceRoot,
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
        workspaceReplicationSourceRootPath: workspaceRoot,
      });

      expect(result.handoffMetadataV2).not.toHaveProperty('workspaceReplicationHandoffBackTargetRootPath');

      const publishedTransferIds = published.listPublishedTransferIds();
      // Canonical V2: no transferred-bundles handshake transfer is published under the handoff id.
      expect(publishedTransferIds).not.toContain(String(result.handoffId));
	      // Provider bundle is published out-of-band.
	      expect(publishedTransferIds).toContain(`session-handoff:${result.handoffId}:provider-bundle-file`);

	      // Canonical V2 direct-peer: workspace manifest + blob packs are served on-demand under the
	      // provider-bundle token carrier (no separate manifest publication).
	      expect(publishedTransferIds.some((transferId) => transferId.includes(':workspace-manifest'))).toBe(false);
	      expect(publishedTransferIds.some((transferId) => transferId.includes(':workspace-pack'))).toBe(false);

      const providerBundlePublishCall = published.publishTransfer.mock.calls
        .map((call) => call?.[0])
        .find((input) => String(input?.transferId ?? '').includes(':provider-bundle-file'));
      expect(providerBundlePublishCall).toBeDefined();
      expect(providerBundlePublishCall).toMatchObject({
        payload: {},
        onDemandScope: expect.any(Object),
      });

      // Hardening: reject obviously-invalid pack ids before attempting on-demand open.
      // This prevents extra work/throw paths from making it into resolvePayloadSourceOnOpen.
      expect(
        (providerBundlePublishCall as any).onDemandScope.allowTransferId(
          `session-handoff:${result.handoffId}:workspace-pack-direct:../evil`,
        ),
      ).toBe(false);

      const manifestTransferPublication = result.handoffMetadataV2?.workspaceReplicationManifestTransferPublication;
      expect(manifestTransferPublication).toBeDefined();
      expect(manifestTransferPublication?.endpointCandidates?.length).toBeGreaterThan(0);

      const tempDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-v2-manifest-on-demand-'));
      try {
        const destinationPath = join(tempDir, 'workspace-manifest.txt');
        // Allow the deferred prepare to populate the on-demand scope, then request the manifest.
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            await published.requestPayloadFileWithOpenBody({
              transferId: manifestTransferPublication!.transferId,
              endpointCandidates: manifestTransferPublication!.endpointCandidates!,
              destinationPath,
            });
            break;
          } catch (error) {
            if (attempt === 49) throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          }
        }
        await expect(readFile(destinationPath, 'utf8')).resolves.toContain('HAPPIER_WORKSPACE_REPLICATION_MANIFEST_V1');
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      await published.dispose();
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
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

	  it('acknowledges workspace handoff start (pending) without waiting for source stop/export when negotiatedTransportStrategy is omitted and server-routed fallback is available', async () => {
	    vi.resetModules();

      const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-start-deferred-'));
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'test_session_handoff_start_deferred',
          filesTransferSessionTtlMs: 2_000,
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));

      try {
	    const registered = new Map<string, (params: unknown) => Promise<any>>();
	    type ExportSessionBundle = NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['exportSessionBundle']>;
	    type ExportResult = Awaited<ReturnType<ExportSessionBundle>>;
	    const deferredExport = createDeferred<ExportResult>();
	    const exportSessionBundle = vi.fn<ExportSessionBundle>(async () => {
	      return await deferredExport.promise;
	    });
	    const deferredStop = createDeferred<'already_inactive' | 'stopped'>();
	    const stopSessionForHandoff = vi.fn(async () => await deferredStop.promise);
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
      }),
      exportSessionBundle,
      stopSessionForHandoff,
      machineTransferChannel: {
        onEnvelope: () => () => {},
        sendEnvelope: () => {},
      },
    });

	    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
	    expect(start).toBeDefined();
	    const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
	    expect(statusGet).toBeDefined();

	    let started: any = null;
	    const startPromise = start!({
	      sessionId: 'sess_1',
	      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'create_sibling_copy',
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
      },
      // NOTE: negotiatedTransportStrategy intentionally omitted.
    }).then((value) => {
      started = value;
      return value;
    });

	    try {
	      await vi.waitFor(() => {
	        expect(started).toMatchObject({
	          handoffId: expect.stringMatching(/^handoff_/),
	          status: expect.objectContaining({
	            status: 'pending',
	            phase: 'preparing',
	          }),
	        });
	      }, { timeout: 1000 });

	      // `status.get` must never report "not_found" for an in-flight deferred handoff.
	      await expect(statusGet!({ handoffId: started.handoffId })).resolves.toMatchObject({
	        handoffId: started.handoffId,
	        status: expect.objectContaining({
	          status: 'pending',
	          phase: 'preparing',
	        }),
	      });
	    } finally {
	      // Clean up background work so the test doesn't leak a hanging promise.
	      deferredStop.resolve('already_inactive');
	      deferredExport.resolve({
	        providerBundle: {
	          providerId: 'claude' as const,
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: '/repo',
      });
      await startPromise;
    }

	    await vi.waitFor(() => {
	      expect(stopSessionForHandoff).toHaveBeenCalledWith('sess_1');
	    });
	    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	    }
	  });

	  it('acknowledges workspace handoff start (pending) without waiting for workspace scan when negotiatedTransportStrategy is direct_peer and server-routed fallback is disabled', async () => {
	    vi.resetModules();

	    const registered = new Map<string, (params: unknown) => Promise<any>>();
	    const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
	    const exportSessionBundle = vi.fn(async () => ({
	      providerBundle: {
	        providerId: 'claude' as const,
	        remoteSessionId: 'claude_session_1',
	        transcriptBase64: 'e30K',
	      },
	      targetPath: '/repo',
	    }));
	    const { publishTransfer, requestPayloadFile, dispose } = await createPublishedDirectPeerPayloadRouter();

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
	        exportSessionBundle,
	        stopSessionForHandoff,
	        directPeerTransfer: {
	          publishTransfer,
	          requestPayloadFile,
	          clearPublishedTransfer: vi.fn(),
	        },
	      });

		      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
		      expect(start).toBeDefined();

		      let started: any = null;
		      start!({
		        sessionId: 'sess_direct_peer_only_deferred_scan',
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
		      }).then((value) => {
		        started = value;
		        return value;
		      });

	      let waitError: unknown;
	      try {
	        await vi.waitFor(() => {
	          expect(started).toMatchObject({
	            handoffId: expect.stringMatching(/^handoff_/),
	            status: expect.objectContaining({
	              status: 'pending',
	              phase: 'preparing',
	            }),
	          });
	          expect(started.handoffMetadataV2?.providerBundleTransferPublication?.endpointCandidates?.length).toBeGreaterThan(0);
	          expect(started.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates?.length).toBeGreaterThan(0);
	        }, { timeout: 200 });
	      } catch (error) {
	        waitError = error;
	      }

	      if (waitError) {
	        throw waitError;
	      }
	    } finally {
	      await dispose();
	    }
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

  it('tracks handoff lifecycle state durably across handlers (status_get survives a daemon restart)', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-durable-status-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'test_session_handoff_durable_status',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');

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

      // Simulate a daemon restart: new handler registration should still be able to answer
      // status_get from the persisted job store (not from in-memory StoredHandoffState).
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'test_session_handoff_durable_status',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerHandlersAfterRestart } = await import('./rpcHandlers.sessionHandoff');
      const registeredAfterRestart = new Map<string, (params: unknown) => Promise<any>>();
      registerHandlersAfterRestart({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registeredAfterRestart.set(method, handler);
          },
        } as any,
        // Restarted daemon doesn't need the source stubs to answer durable status_get.
      });
      const statusAfterRestart = registeredAfterRestart.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      expect(statusAfterRestart).toBeDefined();
      const fetchedAfterRestart = await statusAfterRestart!({ handoffId });
      expect(fetchedAfterRestart.status.status).toBe('completed');
      expect(fetchedAfterRestart.status.phase).toBe('finalizing');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('surfaces workspaceReplicationHandoffBackTargetRootPath when session metadata indicates a sync_changes handoff back to the prior source machine', async () => {
    vi.resetModules();

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-start-v2-handoff-back-hint-'));
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

      const exportSessionBundle: ExportSessionBundle = async () => ({
        providerBundle: {
          providerId: 'claude' as const,
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        targetPath: '/home/guest/wsrepl-large-replication-9',
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
          path: '/home/guest/wsrepl-large-replication-9',
          flavor: 'claude',
          claudeSessionId: 'claude_session_1',
          handoffV1: {
            v: 1,
            sourceMachineId: 'machine_target',
            targetMachineId: 'machine_source',
            sourceWorkspaceRootPath: '/repo/./wsrepl-large',
            targetWorkspaceRootPath: '/home/guest/wsrepl-large-replication-9',
          },
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
        sessionId: 'sess_handoff_back_hint',
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

      expect(result.handoffMetadataV2).toMatchObject({
        workspaceReplicationHandoffBackTargetRootPath: '/repo/wsrepl-large',
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when commit is called before the target is ready for cutover (no premature completion/disposal while prepare is pending)', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-commit-not-ready-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'test_session_handoff_commit_not_ready',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));

      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const deferredImport = createDeferred<void>();
      const importSessionBundle = vi.fn(async (_bundle: any, directory: string) => {
        await deferredImport.promise;
        return {
          remoteSessionId: 'claude_session_target',
          directSource: {
            kind: 'claudeConfig',
            configDir: null,
            projectId: null,
          },
          resume: buildClaudeResumePlan({
            directory,
            resume: 'claude_session_target',
            transcriptStorage: 'direct',
          }),
        };
      });

      registerHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
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
        }),
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET);
      const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET);

      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(commit).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_commit_not_ready',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
      });

      const handoffId = started.handoffId;

      const prepareAck = await prepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
      });

      expect(prepareAck).toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'pending',
          phase: 'staging_target',
          jobId: expect.any(String),
        },
      });

      const commitWhilePending = await commit!({ handoffId });
      expect(commitWhilePending).toMatchObject({
        ok: false,
        errorCode: 'not_ready',
        handoffId,
        status: {
          handoffId,
          status: 'pending',
          phase: 'staging_target',
        },
      });

      deferredImport.resolve();

      await vi.waitFor(async () => {
        const ready = await resultGet!({ handoffId });
        expect(ready.status.status).toBe('ready_for_cutover');
      });
      expect(importSessionBundle).toHaveBeenCalledTimes(1);
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('persists a reverse-direction workspace replication baseline on source_cleanup commit (enables handoff back sync_changes)', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-source-cleanup-reverse-baseline-'));
    const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-source-cleanup-reverse-baseline-source-'));
    const reverseSourceRootPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-source-cleanup-reverse-baseline-target-root-'));
    const reverseTargetRootPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-source-cleanup-reverse-baseline-source-mapped-root-'));
    const sourceCleanupWorkspacePayload = Buffer.from('source\n', 'utf8');
    const sourceCleanupWorkspaceDigest = `sha256:${createHash('sha256').update(sourceCleanupWorkspacePayload).digest('hex')}`;
    await writeFile(join(sourcePath, 'README.md'), sourceCleanupWorkspacePayload);

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'test_session_handoff_source_cleanup_reverse_baseline',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));

      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      registerHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
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
	        }),
	      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT);
      expect(start).toBeDefined();
      expect(commit).toBeDefined();

      const started = await start!({
        sessionId: 'sess_source_cleanup_reverse_baseline',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        workspaceTransfer: {
          enabled: true,
          strategy: 'transfer_snapshot',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      });

      await commit!({
        handoffId: started.handoffId,
        mode: 'source_cleanup',
        workspaceReplicationReverseSourceRootPath: reverseSourceRootPath,
        workspaceReplicationReverseTargetRootPath: reverseTargetRootPath,
      });

      const { createWorkspaceReplicationBaselineStore } = await import('../../workspaces/replication/baseline/workspaceReplicationBaselineStore');
      const baselineStore = createWorkspaceReplicationBaselineStore({ activeServerDir });
      const baseline = await baselineStore.load({
        sourceMachineId: 'machine_target',
        sourceWorkspaceRoot: reverseSourceRootPath,
        targetMachineId: 'machine_source',
        targetWorkspaceRoot: reverseTargetRootPath,
        mode: 'one_way_safe',
      });

      expect(baseline).not.toBeNull();
      expect(baseline).toMatchObject({
        manifest: {
          entries: [
            {
              kind: 'file',
              relativePath: 'README.md',
              digest: sourceCleanupWorkspaceDigest,
              sizeBytes: sourceCleanupWorkspacePayload.byteLength,
              executable: false,
            },
          ],
          fingerprint: expect.stringMatching(/^sha256:/),
        },
      });
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(sourcePath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('stops the source session during source_cleanup commit (prevents late source metadata overwrites)', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-source-cleanup-stop-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'test_session_handoff_source_cleanup_stop',
        },
      }));

      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const stopSessionForHandoff =
        vi.fn<(sessionId: string) => Promise<'stopped' | 'already_inactive' | 'failed'>>();
      stopSessionForHandoff.mockResolvedValue('stopped');

      registerHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        stopSessionForHandoff,
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
        }),
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT);
      expect(start).toBeDefined();
      expect(commit).toBeDefined();

      const started = await start!({
        sessionId: 'sess_source_cleanup_stop',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
      });

      // Ignore the initial stop performed during start(); source_cleanup should stop again as a hard
      // guardrail before declaring the handoff done.
      stopSessionForHandoff.mockClear();
      stopSessionForHandoff.mockResolvedValueOnce('already_inactive');

      await commit!({
        handoffId: started.handoffId,
        mode: 'source_cleanup',
      });

      expect(stopSessionForHandoff).toHaveBeenCalledWith('sess_source_cleanup_stop');
    } finally {
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('does not leave prepare-target stuck when another instance held the lease and later releases it', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-lease-release-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'test_session_handoff_lease_release',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      vi.doMock('node:crypto', async () => {
        const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
        return {
          ...actual,
          randomUUID: () => 'fixed_uuid',
        };
      });

      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');

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

      registerHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
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

      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_1',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      });

      const handoffId = started.handoffId;
      expect(handoffId).toBe('handoff_fixed_uuid');

      // Prepare-target job ids are stable per handoff so that multiple daemons contend on the same
      // lease key when resuming after restarts.
      const deterministicJobId = `prepare_${handoffId}`;
      const leaseDirectory = join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        deterministicJobId,
        'lease',
      );

      // Another instance holds a live lease, so this daemon must not keep an in-memory "active job"
      // entry around that prevents resuming once the lease is released.
      const nowMs = Date.now();
      await mkdir(leaseDirectory, { recursive: true });
      await writeFile(
        join(leaseDirectory, 'lease.json'),
        `${JSON.stringify({
          ownerId: 'other_instance',
          acquiredAtMs: nowMs,
          renewedAtMs: nowMs,
          expiresAtMs: nowMs + 60_000,
        })}\n`,
        'utf8',
      );

      const prepared = await prepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
      });
      expect(prepared.status.status).toBe('pending');

      await rm(leaseDirectory, { recursive: true, force: true });

      await prepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
      });

      await vi.waitFor(async () => {
        const ready = await resultGet!({ handoffId });
        expect((ready as any).status?.status).toBe('ready_for_cutover');
      }, { timeout: 2000 });

      expect(importSessionBundle).toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:crypto');
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
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
	          status: 'awaiting_recovery',
	          phase: 'staging_target',
	          jobId: prepareJobId,
	          progress: {
	            updatedAtMs: expect.any(Number),
	            checkpoint: 'stage_target',
	            planned: {},
	            transferred: {},
	            current: {
	              phaseDetail: 'daemon_restart_missing_runner',
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

  it('maps workspace replication checkpoint blob_transfer_completed to the handoff stage_target checkpoint in status_get (timeline parity)', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-status-checkpoint-parity-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'test_status_checkpoint_parity',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');

      const workspaceReplicationJobStore = createWorkspaceReplicationJobStore({ activeServerDir });
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const handoffId = 'handoff_status_checkpoint_parity';
      const prepareJobId = 'prepare_status_checkpoint_parity';
      const workspaceReplicationJobId = 'job_status_checkpoint_parity';
      const nowMs = Date.now();

      await workspaceReplicationJobStore.write({
        jobId: workspaceReplicationJobId,
        createdAtMs: 1,
        updatedAtMs: 1234,
        status: {
          status: 'in_progress',
          phase: 'transfer_missing_blobs_to_target_cas',
          checkpoint: 'blob_transfer_completed',
          progressCounters: {
            plannedFiles: 10,
            plannedBytes: 100,
            transferredFiles: 10,
            transferredBytes: 100,
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
        createdAtMs: nowMs - 1_000,
        updatedAtMs: nowMs,
        workspaceReplicationJobId,
        status: {
          handoffId,
          jobId: prepareJobId,
          status: 'pending',
          phase: 'staging_target',
          progress: {
            updatedAtMs: nowMs,
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
      });

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      expect(statusGet).toBeDefined();

      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId: prepareJobId,
          status: 'pending',
          phase: 'staging_target',
          progress: {
            checkpoint: 'stage_target',
            planned: {
              totalFiles: 10,
              totalBytes: 100,
            },
            transferred: {
              files: 10,
              bytes: 100,
            },
            current: {
              phaseDetail: 'workspace_replication:transfer_missing_blobs_to_target_cas',
            },
          },
        },
      });
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('does not mark a pending prepare-target job as awaiting_recovery when a live lease exists', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-status-live-lease-'));

    try {
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir,
          activeServerId: 'test_status_live_lease',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerHandlers } = await import('./rpcHandlers.sessionHandoff');

      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      const handoffId = 'handoff_status_live_lease';
      const prepareJobId = 'prepare_status_live_lease';

      await prepareJobStore.write({
        jobId: prepareJobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 2,
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

      const leaseDirectory = join(
        activeServerDir,
        'session-handoff',
        'prepare-target-jobs-staging',
        prepareJobId,
        'lease',
      );
      const nowMs = Date.now();
      await mkdir(leaseDirectory, { recursive: true });
      await writeFile(
        join(leaseDirectory, 'lease.json'),
        `${JSON.stringify({
          ownerId: 'other_instance',
          acquiredAtMs: nowMs,
          renewedAtMs: nowMs,
          expiresAtMs: nowMs + 60_000,
        })}\n`,
        'utf8',
      );

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      registerHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
      });

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET);
      expect(statusGet).toBeDefined();

      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          status: 'pending',
          jobId: prepareJobId,
          phase: 'staging_target',
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
	          conflictPolicy: 'replace_existing' as const,
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
	        conflictPolicy: 'replace_existing' as const,
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

  it('normalizes prepare-target targetPath onto the local machine home when the request carries an absolute /.happier/ path from another machine', async () => {
    const os = await import('node:os');
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
        currentTargetManifest: null,
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
              entries: [],
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
        strategy: 'transfer_snapshot' as const,
        conflictPolicy: 'replace_existing' as const,
        includeIgnoredMode: 'exclude' as const,
        ignoredIncludeGlobs: [],
      };
      const started = await start!({
        sessionId: 'sess_adapter_prepare_targetpath_normalization',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer,
      });

      const requestedTargetPath = '/Users/other-user/.happier/wsrepl-qa-fixtures/large-repo';
      let prepared = await prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'persisted',
        targetPath: requestedTargetPath,
        workspaceTransfer,
        ...(started.handoffMetadataV2 ? { handoffMetadataV2: started.handoffMetadataV2 } : {}),
      });

      if (prepared.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          prepared = await resultGet!({ handoffId: started.handoffId });
          expect(prepared.status.status).toBe('ready_for_cutover');
        });
      }

      const expectedTargetPath = `${os.homedir()}/.happier/wsrepl-qa-fixtures/large-repo`;
      expect(prepareTargetWorkspace).toHaveBeenCalledWith(expect.objectContaining({
        targetPath: expectedTargetPath,
      }));
    } finally {
      vi.doUnmock('@/configuration');
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
    const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-handoff-home-'));
    const workspacePath = join(homeDir, 'projects', 'demo');
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'file.txt'), 'hello\n', 'utf8');
    const exportSessionBundle = vi.fn<ExportSessionBundle>(async () => ({
      providerBundle: {
        providerId: 'claude' as const,
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      targetPath: workspacePath,
    } satisfies Awaited<ReturnType<ExportSessionBundle>>));
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
          path: workspacePath,
          homeDir,
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
	            conflictPolicy: 'replace_existing',
	            includeIgnoredMode: 'exclude',
	            ignoredIncludeGlobs: [],
	          },
	        }),
	      ).resolves.toMatchObject({
	        handoffId: expect.stringMatching(/^handoff_/),
	        targetPath: workspacePath,
	        status: expect.objectContaining({
	          status: 'pending',
          phase: 'preparing',
        }),
      });

      expect(exportSessionBundle).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'machine_source',
        path: workspacePath,
      }));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
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
	          conflictPolicy: 'replace_existing',
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

	  it('publishes provider bundle + workspace replication transfers without inline workspace blobs when workspace transfer is enabled (V2 start)', async () => {
	    vi.resetModules();

	    const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-header-only-workspace-'));
	    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-header-only-'));
	    const workspaceBlobDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-header-only-blob-'));
	    const workspaceBlobPayload = Buffer.from('direct-peer-pack\n', 'utf8');
	    const workspaceBlobDigest = `sha256:${createHash('sha256').update(workspaceBlobPayload).digest('hex')}`;
    const workspaceManifestFingerprint = `sha256:${'1'.repeat(64)}`;
	    const workspaceTransfer = {
	      enabled: true as const,
	      strategy: 'sync_changes' as const,
	      conflictPolicy: 'replace_existing' as const,
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
	      const workspaceBlobPath = join(sourcePath, 'README.md');
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
	      // Canonical V2 direct-peer: workspace manifest + blob packs are served on-demand under the
	      // provider-bundle token carrier (no separate manifest publication).
	      expect([...publishedTransferIds].some((transferId) => transferId.includes(':workspace-manifest'))).toBe(false);
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

      // The start handler can acknowledge before the deferred workspace export has finished. Force
      // a manifest request so the background prepare completes before we tear down the temp dirs.
      const manifestTransferId = `session-handoff:${started.handoffId}:workspace-manifest`;
      const manifestDestinationPath = join(workspaceBlobDir, 'workspace-manifest.txt');
      await vi.waitFor(async () => {
        await requestPayloadFile({
          transferId: manifestTransferId,
          endpointCandidates: started.handoffMetadataV2.providerBundleTransferPublication?.endpointCandidates ?? [],
          destinationPath: manifestDestinationPath,
        });
      }, { timeout: 10_000 });
      const manifestText = await readFile(manifestDestinationPath, 'utf8');
      expect(manifestText).toContain('HAPPIER_WORKSPACE_REPLICATION_MANIFEST_V1');
	    } finally {
	      vi.doUnmock('@/configuration');
	      vi.resetModules();
	      await dispose();
	      await rm(sourcePath, { recursive: true, force: true });
	      await rm(workspaceBlobDir, { recursive: true, force: true });
	      await rm(sourceActiveServerDir, { recursive: true, force: true });
	    }
	  });

  it('applies server-routed workspace sync through the replication engine when workspace transfer is enabled', async () => {
    vi.resetModules();

    const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-source-workspace-'));
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-target-'));
    const targetPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-target-workspace-'));
    const baselinePayload = Buffer.from('previous\n', 'utf8');
    const baselineDigest = `sha256:${createHash('sha256').update(baselinePayload).digest('hex')}`;
    const baselineFingerprint = `sha256:${'1'.repeat(64)}`;
    const workspaceBlobPayload = Buffer.from('server-routed-pack\n', 'utf8');
    await writeFile(join(sourcePath, 'README.md'), workspaceBlobPayload);
    await writeFile(join(targetPath, 'README.md'), baselinePayload);
	    const workspaceTransfer = {
	      enabled: true as const,
	      strategy: 'sync_changes' as const,
	      conflictPolicy: 'replace_existing' as const,
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
	      // Start() may acknowledge before the source export finishes, so only require persistence
	      // after prepare has converged.
	      await expect(access(join(sourceActiveServerDir, 'session-handoff', started.handoffId, 'provider-bundle.json'))).resolves.toBeUndefined();
	      await expect(access(join(sourceActiveServerDir, 'session-handoff', started.handoffId, 'workspace-manifest.txt'))).resolves.toBeUndefined();
	      const openEnvelopes = channels.sentEnvelopes
	        .filter((entry) => entry.envelope.kind === 'open')
	        .map((entry) => entry.envelope);
      const openTransferIds = openEnvelopes.map((envelope) => envelope.transferId);
      expect(openTransferIds).not.toContain(`session-handoff:${started.handoffId}`);
      expect(openTransferIds).toContain(`session-handoff:${started.handoffId}:provider-bundle-file`);
      expect(openTransferIds.some((transferId) => transferId.includes(':workspace-manifest'))).toBe(true);
      expect(openTransferIds.some((transferId) => transferId.includes(':workspace-pack:'))).toBe(true);

      const blobPackOpen = openEnvelopes.find((envelope) => envelope.transferId.includes(':workspace-pack:'));
      expect(blobPackOpen && 'openPayloadBase64' in blobPackOpen ? blobPackOpen.openPayloadBase64 : undefined)
        .toEqual(expect.any(String));
      if (blobPackOpen && 'openPayloadBase64' in blobPackOpen && typeof blobPackOpen.openPayloadBase64 === 'string') {
        const decoded = JSON.parse(Buffer.from(blobPackOpen.openPayloadBase64, 'base64').toString('utf8')) as unknown;
        expect(decoded).toBeTruthy();
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
          const record = decoded as Record<string, unknown>;
          expect(record.t).toBe('workspace_replication_blob_pack_v1');
          expect(record.digests).toEqual(expect.any(Array));
        }
      }
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(sourcePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(targetActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('serves server-routed workspace blob packs after a daemon restart (no in-memory source state)', async () => {
    vi.resetModules();

    const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-restart-source-workspace-'));
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-restart-source-'));
    const workspaceBlobPayload = Buffer.from('server-routed-restart-pack\n', 'utf8');
    await writeFile(join(sourcePath, 'README.md'), workspaceBlobPayload);
    const workspaceBlobDigest = `sha256:${createHash('sha256').update(workspaceBlobPayload).digest('hex')}`;

    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'transfer_snapshot' as const,
      conflictPolicy: 'create_sibling_copy' as const,
      includeIgnoredMode: 'include_selected' as const,
      ignoredIncludeGlobs: ['dist/**'],
    };

    const sourceRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const sourceRpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        sourceRegistered.set(method, handler);
      },
    } as any;

    try {
      const channels = createLoopbackMachineTransferChannels();

      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_server_routed_restart_source',
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
        }),
        machineTransferChannel: channels.source,
      });

      const sourceStart = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START);
      expect(sourceStart).toBeDefined();

      const started = await sourceStart!({
        sessionId: 'sess_server_routed_restart_blob_pack',
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

      // Wait for the durable source export artifacts. The restart path must be able to serve
      // provider bundle + manifest + blob packs without relying on in-memory state.
      await vi.waitFor(async () => {
        await access(join(sourceActiveServerDir, 'session-handoff', started.handoffId, 'provider-bundle.json'));
        await access(join(sourceActiveServerDir, 'session-handoff', started.handoffId, 'workspace-manifest.txt'));
        await access(join(sourceActiveServerDir, 'session-handoff', started.handoffId, 'source-export.json'));
      });

      // Simulate a daemon restart by creating a fresh machine-transfer channel and re-registering
      // handlers against the same activeServerDir.
      const restartChannels = createLoopbackMachineTransferChannels();
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_server_routed_restart_source',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        },
      }));
      const { registerMachineSessionHandoffRpcHandlers: registerSourceHandlersAfterRestart } = await import('./rpcHandlers.sessionHandoff');
      registerSourceHandlersAfterRestart({
        rpcHandlerManager: {
          registerHandler: () => {},
        } as any,
        machineTransferChannel: restartChannels.source,
      });

      const digests = [workspaceBlobDigest].sort();
      const packId = createWorkspaceReplicationPackIdForDigests(digests);
      const transferId = `session-handoff:${started.handoffId}:workspace-pack:${packId}`;
      const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-restart-pack-'));
      const destinationPath = join(temporaryDirectory, 'pack.bin');

      try {
        const received = await requestServerRoutedTransferToFile({
          transferId,
          sourceMachineId: 'machine_source',
          machineTransferChannel: restartChannels.target,
          destinationPath,
          openBody: {
            t: 'workspace_replication_blob_pack_v1',
            packId,
            digests,
          },
          timeoutMs: 30_000,
        });

        const payload = await readFile(received.destinationPath);
        expect(payload.includes(workspaceBlobPayload)).toBe(true);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    } finally {
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(sourcePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('acknowledges server-routed workspace handoff start before a large workspace export finishes and lets prepare wait for it', async () => {
    vi.resetModules();

    const previousTransferTimeoutMs = process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '50';

    const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-deferred-workspace-'));
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-deferred-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-deferred-target-'));
    const workspaceBlobPayload = Buffer.from('server-routed-pack\n', 'utf8');
    await writeFile(join(sourcePath, 'README.md'), workspaceBlobPayload);
	    const workspaceTransfer = {
	      enabled: true as const,
	      strategy: 'sync_changes' as const,
	      conflictPolicy: 'replace_existing' as const,
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
          filesTransferSessionTtlMs: 2_000,
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
            filesTransferSessionTtlMs: 2_000,
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

      // Delay export long enough that the default server-routed machine transfer timeout would fire
      // unless the handoff layer passes a larger timeout budget for prepare-time transfers.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 150);
      });

      exportDeferred.resolve({
        providerBundle: {
          providerId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        targetPath: sourcePath,
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
      if (previousTransferTimeoutMs === undefined) {
        delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = previousTransferTimeoutMs;
      }
      vi.doUnmock('@/configuration');
      vi.resetModules();
      await rm(sourcePath, { recursive: true, force: true });
      await rm(sourceActiveServerDir, { recursive: true, force: true });
      await rm(targetActiveServerDir, { recursive: true, force: true });
    }
  });

  it('acknowledges direct-peer workspace handoff start before a large workspace export finishes when server-routed fallback is available', async () => {
    vi.resetModules();

    const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-deferred-workspace-'));
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-deferred-source-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-deferred-target-'));
    const targetPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-deferred-target-workspace-'));
    const workspaceBlobPayload = Buffer.from('direct-peer-deferred-pack\n', 'utf8');
    await writeFile(join(sourcePath, 'README.md'), workspaceBlobPayload);

	    const workspaceTransfer = {
	      enabled: true as const,
	      strategy: 'sync_changes' as const,
	      conflictPolicy: 'replace_existing' as const,
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
      await rm(sourcePath, { recursive: true, force: true });
      await rm(sourceActiveServerDir, { recursive: true, force: true });
      await rm(targetActiveServerDir, { recursive: true, force: true });
      await rm(targetPath, { recursive: true, force: true });
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
	      conflictPolicy: 'replace_existing' as const,
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
	    await expect(access(publishedPayloadSource.filePath)).resolves.toBeUndefined();
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

		  it('fails closed when the persisted source-export record is corrupted (no silent transfer_not_found)', async () => {
	    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-corrupt-source-export-'));
	    const handoffId = 'handoff_corrupt_source_export';
	    const recordDir = join(sourceActiveServerDir, 'session-handoff', handoffId);
	    const recordPath = join(recordDir, 'source-export.json');
	    await mkdir(recordDir, { recursive: true });
	    await writeFile(recordPath, '{not valid json', 'utf8');

	    const channels = createLoopbackMachineTransferChannels();
	    vi.resetModules();
	    vi.doMock('@/configuration', () => ({
	      configuration: {
	        activeServerDir: sourceActiveServerDir,
	        activeServerId: 'test_corrupt_source_export',
	      },
	    }));

	    try {
	      const { registerMachineSessionHandoffRpcHandlers: registerSourceHandlers } = await import('./rpcHandlers.sessionHandoff');
	      registerSourceHandlers({
	        rpcHandlerManager: {
	          registerHandler: () => {},
	        } as any,
	        machineTransferChannel: channels.source,
	      });

	      const transferId = buildSessionHandoffProviderBundleTransferId(handoffId);
	      const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-corrupt-source-export-dest-'));
	      const destinationPath = join(temporaryDirectory, 'provider-bundle.json');
	      try {
	        await expect(requestServerRoutedTransferToFile({
	          transferId,
	          sourceMachineId: 'machine_source',
	          machineTransferChannel: channels.target,
	          destinationPath,
	          timeoutMs: 5_000,
	        })).rejects.toThrow('Machine transfer aborted: internal_error');
	      } finally {
	        await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	      }
	    } finally {
	      vi.doUnmock('@/configuration');
	      vi.resetModules();
	      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	    }
	  }, 30_000);

	  it('surfaces deferred source-export terminal failures as a structured machine transfer abort (no misleading transfer_not_found)', async () => {
	    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-terminal-source-export-'));
	    const handoffId = 'handoff_terminal_source_export';

	    const channels = createLoopbackMachineTransferChannels();
	    vi.resetModules();
	    vi.doMock('@/configuration', () => ({
	      configuration: {
	        activeServerDir: sourceActiveServerDir,
	        activeServerId: 'test_terminal_source_export',
	        filesTransferSessionTtlMs: 50,
	      },
	    }));

	    try {
	      const { createSessionHandoffSourceExportStore } = await import('../../session/handoff/state/sessionHandoffSourceExportStore');
	      const { createSessionHandoffPrepareTargetJobStore } = await import('../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore');
	      const { registerMachineSessionHandoffRpcHandlers: registerSourceHandlers } = await import('./rpcHandlers.sessionHandoff');
	      const { buildSessionHandoffWorkspaceManifestTransferId } = await import(
	        '../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationServerRouted',
	      );

	      registerSourceHandlers({
	        rpcHandlerManager: {
	          registerHandler: () => {},
	        } as any,
	        machineTransferChannel: channels.source,
	      });

	      const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir: sourceActiveServerDir });
	      await sourceExportStore.save({
	        handoffId,
	        sessionId: 'session_test',
	        sourceMachineId: 'machine_source',
	        targetMachineId: 'machine_target',
	        exportedAtMs: Date.now(),
	        workspaceSourceRootPath: '/repo',
	      });

	      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir: sourceActiveServerDir });
	      const jobId = `start_${handoffId}`;
	      await prepareJobStore.write({
	        jobId,
	        handoffId,
	        createdAtMs: Date.now(),
	        updatedAtMs: Date.now(),
	        abortedAtMs: Date.now(),
	        failedAtMs: Date.now(),
	        lastErrorMessage: 'Session is not eligible for handoff: vendor_handoff_id_missing',
	        status: {
	          handoffId,
	          status: 'aborted',
	          phase: 'preparing',
	          jobId,
	          recoveryActions: ['restart_on_source', 'keep_stopped'],
	        },
	      });

	      const transferId = buildSessionHandoffWorkspaceManifestTransferId({ handoffId });
	      const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-terminal-source-export-dest-'));
	      const destinationPath = join(temporaryDirectory, 'workspace-manifest.json');
	      try {
	        await expect(requestServerRoutedTransferToFile({
	          transferId,
	          sourceMachineId: 'machine_source',
	          machineTransferChannel: channels.target,
	          destinationPath,
	          timeoutMs: 2_000,
	        })).rejects.toThrow('Machine transfer aborted: handoff_ineligible:vendor_handoff_id_missing');
	      } finally {
	        await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	      }
	    } finally {
	      vi.doUnmock('@/configuration');
	      vi.resetModules();
	      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	    }
		  }, 30_000);

      it('aborts server-routed workspace blob-pack transfers with workspace_replication_source_error when the persisted manifest cannot be loaded', async () => {
        const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wsrepl-manifest-corrupt-source-export-'));
        const handoffId = 'handoff_wsrepl_manifest_corrupt';

        const channels = createLoopbackMachineTransferChannels();
        vi.resetModules();
        vi.doMock('@/configuration', () => ({
          configuration: {
            activeServerDir: sourceActiveServerDir,
            activeServerId: 'test_wsrepl_manifest_corrupt',
            filesTransferSessionTtlMs: 10 * 60_000,
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          },
        }));

        try {
          const {
            registerMachineSessionHandoffRpcHandlers: registerSourceHandlers,
          } = await import('./rpcHandlers.sessionHandoff');
          const { requestServerRoutedTransferToFile } = await import('../../machines/transfer/serverRoutedTransport');
          const { createSessionHandoffSourceExportStore } = await import('../../session/handoff/state/sessionHandoffSourceExportStore');
          const { createWorkspaceReplicationPackIdForDigests } = await import('@/workspaces/replication/transport/workspaceReplicationPackId');
          const { buildSessionHandoffWorkspaceBlobPackTransferId } = await import(
            '../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationServerRouted',
          );

          registerSourceHandlers({
            rpcHandlerManager: {
              registerHandler: () => {},
            } as any,
            machineTransferChannel: channels.source,
          });

          const digest = `sha256:${'1'.repeat(64)}`;
          const digests = [digest];
          const packId = createWorkspaceReplicationPackIdForDigests(digests);
          const transferId = buildSessionHandoffWorkspaceBlobPackTransferId({ handoffId, packId });

          const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir: sourceActiveServerDir });
          const persistedWorkspaceManifest = await sourceExportStore.writeWorkspaceReplicationManifestFile({
            handoffId,
            manifest: {
              entries: [
                {
                  relativePath: 'README.md',
                  kind: 'file' as const,
                  digest,
                  sizeBytes: 1,
                  executable: false,
                },
              ],
              fingerprint: 'test-fingerprint',
            },
          });
          // Corrupt the manifest file after persisting metadata to force read/parse failures in the responder.
          await writeFile(persistedWorkspaceManifest.filePath, 'not a workspace manifest', 'utf8');

          await sourceExportStore.save({
            handoffId,
            sessionId: 'session_test',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            exportedAtMs: Date.now(),
            workspaceSourceRootPath: '/repo',
            workspaceManifest: persistedWorkspaceManifest,
          });

          const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wsrepl-manifest-corrupt-dest-'));
          const destinationPath = join(temporaryDirectory, 'workspace-pack.bin');
          try {
            await expect(requestServerRoutedTransferToFile({
              transferId,
              sourceMachineId: 'machine_source',
              machineTransferChannel: channels.target,
              destinationPath,
              openBody: {
                t: 'workspace_replication_blob_pack_v1',
                packId,
                digests,
              },
              timeoutMs: 5_000,
            })).rejects.toThrow('Machine transfer aborted: workspace_replication_source_error');
          } finally {
            await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          }
        } finally {
          vi.doUnmock('@/configuration');
          vi.resetModules();
          await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }, 30_000);

      it('aborts server-routed workspace blob-pack transfers with workspace_replication_source_error when the source workspace root cannot supply required blobs', async () => {
        const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wsrepl-missing-blob-source-export-'));
        const sourceRootPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wsrepl-missing-blob-workspace-'));
        const handoffId = 'handoff_wsrepl_missing_blob';

        const channels = createLoopbackMachineTransferChannels();
        vi.resetModules();
        vi.doMock('@/configuration', () => ({
          configuration: {
            activeServerDir: sourceActiveServerDir,
            activeServerId: 'test_wsrepl_missing_blob',
            filesTransferSessionTtlMs: 10 * 60_000,
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          },
        }));

        try {
          const {
            registerMachineSessionHandoffRpcHandlers: registerSourceHandlers,
          } = await import('./rpcHandlers.sessionHandoff');
          const { requestServerRoutedTransferToFile } = await import('../../machines/transfer/serverRoutedTransport');
          const { createSessionHandoffSourceExportStore } = await import('../../session/handoff/state/sessionHandoffSourceExportStore');
          const { createWorkspaceReplicationPackIdForDigests } = await import('@/workspaces/replication/transport/workspaceReplicationPackId');
          const { buildSessionHandoffWorkspaceBlobPackTransferId } = await import(
            '../../session/handoff/workspaceReplicationAdapter/sessionHandoffWorkspaceReplicationServerRouted',
          );

          registerSourceHandlers({
            rpcHandlerManager: {
              registerHandler: () => {},
            } as any,
            machineTransferChannel: channels.source,
          });

          const digest = `sha256:${'2'.repeat(64)}`;
          const digests = [digest];
          const packId = createWorkspaceReplicationPackIdForDigests(digests);
          const transferId = buildSessionHandoffWorkspaceBlobPackTransferId({ handoffId, packId });

          const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir: sourceActiveServerDir });
          const persistedWorkspaceManifest = await sourceExportStore.writeWorkspaceReplicationManifestFile({
            handoffId,
            manifest: {
              entries: [
                {
                  relativePath: 'README.md',
                  kind: 'file' as const,
                  digest,
                  sizeBytes: 1,
                  executable: false,
                },
              ],
              fingerprint: 'test-fingerprint-missing-blob',
            },
          });

          await sourceExportStore.save({
            handoffId,
            sessionId: 'session_test',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            exportedAtMs: Date.now(),
            workspaceSourceRootPath: sourceRootPath,
            workspaceManifest: persistedWorkspaceManifest,
          });

          const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wsrepl-missing-blob-dest-'));
          const destinationPath = join(temporaryDirectory, 'workspace-pack.bin');
          try {
            await expect(requestServerRoutedTransferToFile({
              transferId,
              sourceMachineId: 'machine_source',
              machineTransferChannel: channels.target,
              destinationPath,
              openBody: {
                t: 'workspace_replication_blob_pack_v1',
                packId,
                digests,
              },
              timeoutMs: 5_000,
            })).rejects.toThrow('Machine transfer aborted: workspace_replication_source_error');
          } finally {
            await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          }
        } finally {
          vi.doUnmock('@/configuration');
          vi.resetModules();
          await rm(sourceRootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }, 30_000);

	  it('waits for a deferred source-export record before serving the server-routed provider-bundle transfer (avoids transfer_not_found)', async () => {
	    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wait-source-export-'));
	    const handoffId = 'handoff_wait_source_export';

      const channels = createLoopbackMachineTransferChannels();
      vi.resetModules();
      vi.doMock('@/configuration', () => ({
        configuration: {
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_wait_source_export',
          // Intentionally small: the responder must not clamp its deferred source-export wait to
          // the app↔daemon transfer "session TTL". It must be bounded by the server-routed machine
          // transfer timeout instead, or large exports will abort with `transfer_not_found`.
          filesTransferSessionTtlMs: 30_000,
        },
      }));

      try {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const { createSessionHandoffSourceExportStore } = await import('../../session/handoff/state/sessionHandoffSourceExportStore');
        const { registerMachineSessionHandoffRpcHandlers: registerSourceHandlers } = await import('./rpcHandlers.sessionHandoff');

        registerSourceHandlers({
          rpcHandlerManager: {
            registerHandler: () => {},
          } as any,
          machineTransferChannel: channels.source,
        });

        const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir: sourceActiveServerDir });
        // Regression: deferred export can legitimately take longer than 75s on large repos, but must
        // still complete within the server-routed transfer timeout budget without returning
        // `transfer_not_found` prematurely.
        const scheduledWriteDelayMs = 80_000;
        const writeDeferred = createDeferred<void>();
        setTimeout(() => {
          void (async () => {
            const persistedProviderBundle = await sourceExportStore.writeProviderBundleFile({
              handoffId,
              providerBundle: {
                providerId: 'claude',
                remoteSessionId: 'remote_session_1',
                transcriptBase64: Buffer.from('hello', 'utf8').toString('base64'),
              },
            });
            await sourceExportStore.save({
              handoffId,
              sessionId: 'session_1',
              sourceMachineId: 'machine_source',
              targetMachineId: 'machine_target',
              exportedAtMs: Date.now(),
              workspaceSourceRootPath: '/repo',
              providerBundle: persistedProviderBundle,
            });
          })().then(writeDeferred.resolve, writeDeferred.reject);
        }, scheduledWriteDelayMs);

        const transferId = buildSessionHandoffProviderBundleTransferId(handoffId);
        const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wait-source-export-dest-'));
        const destinationPath = join(temporaryDirectory, 'provider-bundle.json');

        try {
          const transferPromise = requestServerRoutedTransferToFile({
            transferId,
            sourceMachineId: 'machine_source',
            machineTransferChannel: channels.target,
            destinationPath,
            timeoutMs: 90_000,
          });
          // Prevent unhandled rejections if the transfer fails before we reach the `await` below.
          transferPromise.catch(() => undefined);

	          const targetAdvanceMs = scheduledWriteDelayMs + 3_000;
	          // Avoid a single giant advance, which can starve async filesystem work inside timer
	          // callbacks and cause wall-clock test timeouts.
	          for (let advancedMs = 0; advancedMs < targetAdvanceMs; ) {
	            await Promise.resolve();
	            const stepMs = Math.min(5_000, targetAdvanceMs - advancedMs);
	            await vi.advanceTimersByTimeAsync(stepMs);
	            advancedMs += stepMs;
	          }
	          await writeDeferred.promise;
	          // Give the transfer pipeline time to observe the persisted record and complete the
	          // open/ack/chunk handshake deterministically under fake timers.
	          for (let advancedMs = 0; advancedMs < 15_000; ) {
	            await Promise.resolve();
	            const stepMs = Math.min(5_000, 15_000 - advancedMs);
	            await vi.advanceTimersByTimeAsync(stepMs);
	            advancedMs += stepMs;
	          }

	          const received = await transferPromise;
          expect(received.destinationPath).toEqual(destinationPath);
          expect(received.sizeBytes).toBeGreaterThan(0);
          const rawProviderBundle = await readFile(received.destinationPath, 'utf8');
          const parsedProviderBundle = JSON.parse(rawProviderBundle) as { providerId?: unknown };
          expect(parsedProviderBundle.providerId).toEqual('claude');
        } finally {
          await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      } finally {
        vi.doUnmock('@/configuration');
        vi.useRealTimers();
        vi.resetModules();
        await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
	    }, 60_000);
		});
