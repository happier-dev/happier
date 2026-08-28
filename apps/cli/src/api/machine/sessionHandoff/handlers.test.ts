import { execFile as execFileCallback } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  SessionHandoffResumePlan,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';
import {
  sealSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createEncryptedTransferChunkEnvelope } from '../../../machines/transfer/transferChunkEncryption';
import type { DirectPeerOnDemandTransferScope } from '../../../machines/transfer/directPeerTransport';
import { requestServerRoutedTransferToFile } from '../../../machines/transfer/serverRoutedTransport';
import { createWorkspaceReplicationBaselineStore } from '../../../workspaces/replication/baseline/workspaceReplicationBaselineStore';
import { createWorkspaceReplicationJobStore } from '../../../workspaces/replication/jobs/workspaceReplicationJobStore';
import { createWorkspaceReplicationPackIdForDigests } from '../../../workspaces/replication/transport/workspaceReplicationPackId';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveDefaultScmBackendRegistry } from '../../../scm/scmBackendCatalog';
import type { ScmBackendRegistry } from '../../../scm/registry';
import { createSessionHandoffPrepareTargetJobStore } from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { readSessionHandoffAgentBundleFile } from '../../../session/handoff/agentBundle/file';
import { buildSessionHandoffAgentBundleTransferId } from '../../../session/handoff/agentBundle/transferPublication';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import { readWorkspaceReplicationManifestFromFile } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/manifestFile';
import { createSessionHandoffWorkspaceReplicationAdapter } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';
import { registerMachineSessionHandoffRpcHandlers as registerMachineSessionHandoffRpcHandlersImpl } from './handlers';
import type { SessionHandoffRuntimeConfig } from './runtimeConfig';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

type ExportSessionBundle = NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlersImpl>[0]['exportSessionBundle']>;
type DirectPeerRequestPayloadFile = NonNullable<
  NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['directPeerTransfer']>['requestPayloadFile']
>;
type DirectPeerPublishTransfer = NonNullable<
  NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['directPeerTransfer']>['publishTransfer']
>;
type DirectPeerPublishPayload = Parameters<DirectPeerPublishTransfer>[0]['payload'];
type DirectPeerPublishPayloadSource = Parameters<DirectPeerPublishTransfer>[0]['payloadSource'];
type DirectPeerPublishPayloadHasWorkspaceBundle = 'workspaceBundle' extends keyof DirectPeerPublishPayload ? true : false;
type DirectPeerPublishPayloadHasAgentBundle = 'agentBundle' extends keyof DirectPeerPublishPayload ? true : false;
type LoopbackListener = (payload: MachineTransferReceiveEnvelope) => void;
const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFile('git', [...args], { cwd });
}

async function configureGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ['config', 'user.email', 'test@example.com']);
  await runGit(cwd, ['config', 'user.name', 'Happier Test']);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type IsolatedProcessHome = Readonly<{
  homeDir: string;
  restore: () => void;
}>;

async function createIsolatedProcessHome(prefix: string): Promise<IsolatedProcessHome> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const homeDir = await mkdtemp(join(os.tmpdir(), prefix));
  let restored = false;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  return {
    homeDir,
    restore: () => {
      if (restored) return;
      restored = true;
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    },
  };
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

type RegisterSessionHandoffHandlersInput = Parameters<typeof registerMachineSessionHandoffRpcHandlersImpl>[0];
type SessionHandoffWorkspaceReplicationAdapter = ReturnType<
  typeof createSessionHandoffWorkspaceReplicationAdapter
>;
type SessionHandoffRuntimeConfigInput = Pick<SessionHandoffRuntimeConfig, 'activeServerDir'>
  & Partial<SessionHandoffRuntimeConfig>
  & Readonly<Record<string, unknown>>;

function createRuntimeConfig(input: SessionHandoffRuntimeConfigInput): SessionHandoffRuntimeConfig {
  return {
    workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
    workspaceReplicationBlobPackMaxBlobs: 64,
    workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
    ...input,
  };
}

const defaultTestActiveServerDir = join(
  os.tmpdir(),
  `happier-session-handoff-handler-suite-${process.pid}-${Date.now()}`,
);
let defaultTestCaseActiveServerDir = defaultTestActiveServerDir;
let defaultTestCaseIndex = 0;
let testPluginRuntimeRegistry:
  | Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>
  | null = null;
let testScmRegistry: ScmBackendRegistry | null = null;

function registerMachineSessionHandoffRpcHandlers(input: RegisterSessionHandoffHandlersInput): void {
  registerMachineSessionHandoffRpcHandlersImpl({
    ...input,
    runtimeConfig: input.runtimeConfig ?? createRuntimeConfig({ activeServerDir: defaultTestCaseActiveServerDir }),
    runtimeDependencies: {
      ...input.runtimeDependencies,
      workspaceReplicationAdapter: input.runtimeDependencies?.workspaceReplicationAdapter
        ?? createWorkspaceReplicationAdapterForTest({}),
    },
  });
}

beforeEach(() => {
  defaultTestCaseIndex += 1;
  defaultTestCaseActiveServerDir = join(defaultTestActiveServerDir, `case-${defaultTestCaseIndex}`);
});

beforeAll(async () => {
  testPluginRuntimeRegistry = await resolveExecutablePluginRuntimeRegistry({
    pluginIds: ['happier.scm.backend.git'],
  });
  testScmRegistry = await resolveDefaultScmBackendRegistry({
    pluginRuntimeRegistry: testPluginRuntimeRegistry,
  });
});

afterAll(async () => {
  await testPluginRuntimeRegistry?.dispose();
  await rm(defaultTestActiveServerDir, { recursive: true, force: true });
});

function createRegisterHandlers(input: SessionHandoffRuntimeConfigInput) {
  const runtimeConfig = createRuntimeConfig(input);

  return (params: RegisterSessionHandoffHandlersInput): void => {
    registerMachineSessionHandoffRpcHandlers({
      ...params,
      runtimeConfig,
    });
  };
}

function createWorkspaceReplicationAdapterForTest(
  overrides: Partial<SessionHandoffWorkspaceReplicationAdapter>,
): SessionHandoffWorkspaceReplicationAdapter {
  const adapter = createSessionHandoffWorkspaceReplicationAdapter();
  const scmRegistry = testScmRegistry;
  if (!scmRegistry) {
    throw new Error('Expected the test daemon-applied SCM registry to be initialized');
  }
  return {
    ...adapter,
    createState: (input) => adapter.createState({ ...input, scmRegistry }),
    prepareTargetWorkspace: (input) => adapter.prepareTargetWorkspace({ ...input, scmRegistry }),
    prepareSourceWorkspaceTransfer: (input) => adapter.prepareSourceWorkspaceTransfer({
      ...input,
      scmRegistry,
    }),
    ...overrides,
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
      expectTypeOf<DirectPeerPublishPayloadHasAgentBundle>().toEqualTypeOf<false>();
    });

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
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
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
		        if (!payloadSource) {
		          throw new Error(`Expected a direct-peer payload source for ${transferId}`);
		        }
            if (payloadSource.kind === 'file') {
		          publishedPayloadPaths.set(transferId, payloadSource.filePath);
            } else if (!onDemandScope) {
		          throw new Error(`Expected a file-backed direct-peer payload source for ${transferId}`);
            }
		        const authorizationToken = `${transferId}-token`;
		        if (onDemandScope) {
		          onDemandScopesByToken.set(authorizationToken, onDemandScope);
		        }
		        return [buildDirectPeerEndpointCandidate({ transferId, authorizationToken })];
		      }),
		      requestPayloadFile: vi.fn(async ({ transferId, destinationPath, endpointCandidates, openBody }) => {
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
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3)).toBe(true);
    expect(registered.has('daemon.sessionHandoff.prepareTarget.resume')).toBe(false);
  });

  it('fails closed when the persisted prepare-target job record is missing (resultGet uses job store only)', async () => {

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-prepare-job-missing-'));
    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'server_test',
          workspaceReplicationBlobPackTargetBytes: 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 1024,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 1024 * 1024,
        });

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
          agentBundle: {
            agentId: 'claude',
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

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
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
    }
  });

  it('returns not_found from resultGet when prepare-target is still in progress (status should be read via status_get)', async () => {

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-prepare-job-pending-resultget-'));
    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'server_test',
          workspaceReplicationBlobPackTargetBytes: 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 1024,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 1024 * 1024,
        });

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
            applied: {},
            remaining: {},
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

      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(resultGet).toBeDefined();

      await expect(resultGet!({ handoffId })).resolves.toEqual({ ok: false, errorCode: 'not_found' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('propagates handoff abort to the underlying workspace replication engine job (cancelRequestedAtMs)', async () => {

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-abort-wsrepl-'));
    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'server_test',
        });

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

      registerHandlers({ rpcHandlerManager });

      const abort = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3);
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
    }
  });

  it('persists terminal abort/commit status when only a persisted source-export exists (no prepare job)', async () => {

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-terminal-source-export-only-'));
    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'server_test',
        });

      const { writeJsonAtomic } = await import('@/utils/fs/writeJsonAtomic');

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;

      registerHandlers({ rpcHandlerManager });

      const abort = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3);
      const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
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
    }
  });

  it('uses the configured activeServerDir in the default handoff exporter', async () => {

    const exportSessionHandoffState = vi.fn(async () => ({
      agentBundle: {
        agentId: 'claude' as const,
        remoteSessionId: 'claude_session_1',
        transcriptBase64: 'e30K',
      },
      targetPath: '/repo',
    }));

    const runtimeConfig = createRuntimeConfig({
      activeServerDir: '/tmp/happier-active-server',
    });
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager,
      runtimeConfig,
      runtimeDependencies: { exportSessionHandoffState },
      loadSessionMetadata: async () => ({
        machineId: 'machine_source',
        path: '/repo',
        flavor: 'claude',
        claudeSessionId: 'claude_session_1',
      }),
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-start-v2-header-only-'));
    const workspaceRoot = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-start-v2-workspace-'));
    const published = await createPublishedDirectPeerPayloadRouter();
    try {
      await mkdir(join(workspaceRoot, 'files'), { recursive: true });
      await mkdir(join(workspaceRoot, '.happier', 'uploads', 'generated', 'sess-v2', 'msg-v2'), { recursive: true });
      await writeFile(join(workspaceRoot, 'files', 'a.txt'), 'hello\n', 'utf8');
      await writeFile(join(workspaceRoot, '.gitignore'), '.happier/uploads/**\n', 'utf8');
      await writeFile(
        join(workspaceRoot, '.happier', 'uploads', 'generated', 'sess-v2', 'msg-v2', 'handoff-image.png'),
        'handoff media\n',
        'utf8',
      );
      await writeFile(
        join(workspaceRoot, '.happier', 'uploads', 'generated', 'sess-v2', 'msg-v2', 'unreferenced.png'),
        'unreferenced media\n',
        'utf8',
      );
      await runGit(workspaceRoot, ['init']);
      await configureGitRepo(workspaceRoot);
      await runGit(workspaceRoot, ['add', 'files/a.txt', '.gitignore']);
      await runGit(workspaceRoot, ['commit', '-m', 'initial']);
      const transcriptBase64 = Buffer.from(`${JSON.stringify({
        meta: {
          happierMedia: {
            kind: 'session_media.v1',
            payload: {
              media: [{
                id: 'media-1',
                role: 'output',
                category: 'generated',
                mediaKind: 'image',
                mimeType: 'image/png',
                name: 'handoff-image.png',
                path: '.happier/uploads/generated/sess-v2/msg-v2/handoff-image.png',
                sizeBytes: 14,
                origin: { source: 'provider-generated' },
              }],
            },
          },
        },
      })}\n`, 'utf8').toString('base64');

      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'server_test',
          happyHomeDir: activeServerDir,
          workspaceReplicationBlobPackTargetBytes: 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 1024,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 1024 * 1024,
        });

      const { createScmWorkspaceIntegrationWorkspaceExportArtifacts } = await import('@/scm/workspace/workspaceExportArtifacts');

	      const exportSessionBundle: ExportSessionBundle = async () => ({
	        agentBundle: {
	          agentId: 'claude' as const,
	          remoteSessionId: 'claude_session_1',
	          transcriptBase64,
	        },
	        targetPath: workspaceRoot,
	      });
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

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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

      const agentBundlePublishCall = published.publishTransfer.mock.calls
        .map((call) => call?.[0])
        .find((input) => String(input?.transferId ?? '').includes(':provider-bundle-file'));
      expect(agentBundlePublishCall).toBeDefined();
      expect(agentBundlePublishCall).toMatchObject({
        payload: {},
        onDemandScope: expect.any(Object),
      });

      // Hardening: reject obviously-invalid pack ids before attempting on-demand open.
      // This prevents extra work/throw paths from making it into resolvePayloadSourceOnOpen.
      expect(
        (agentBundlePublishCall as any).onDemandScope.allowTransferId(
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
        const onDemandManifest = await readWorkspaceReplicationManifestFromFile({
          transferId: manifestTransferPublication!.transferId,
          filePath: destinationPath,
        });
        const manifestPaths = onDemandManifest.entries.map((entry) => entry.relativePath);
        expect(manifestPaths).toContain('.happier/uploads/generated/sess-v2/msg-v2/handoff-image.png');
        expect(manifestPaths).not.toContain('.happier/uploads/generated/sess-v2/msg-v2/unreferenced.png');
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      await published.dispose();
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('returns missing_handoff_metadata_v2 for direct-peer prepare payloads that omit handoffMetadataV2 (no transferred-bundles fallback)', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const channels = createLoopbackMachineTransferChannels();
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
        machineTransferChannel: channels.target,
	      directPeerTransfer: {
	        publishTransfer: vi.fn(() => []),
	        requestPayloadFile: vi.fn(),
	        clearPublishedTransfer: vi.fn(),
	      },
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
    const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
    const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
    expect(prepare).toBeDefined();
    expect(statusGet).toBeDefined();
    expect(resultGet).toBeDefined();

    await expect(prepare!({
      handoffId: 'handoff_missing_handoff_metadata_v2',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo-target',
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
      agentBundle: {
        agentId: 'claude' as const,
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
          externalSessionV1: {
            v: 1,
            agentId: 'claude',
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
	      targetPath: '/repo-source-current',
	      handoffMetadataV2: expect.objectContaining({
	        agentBundleTransferPublication: expect.objectContaining({
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
	    expect(result.endpointCandidates.length).toBeGreaterThan(0);
		    expect(exportSessionBundle).toHaveBeenCalledWith(
		      expect.objectContaining({
		        machineId: 'machine_target',
	        path: '/repo-source-current',
        homeDir: '/Users/target',
        portableMetadataVersion: 'v2',
        claudeSessionId: 'sess-handoff-direct',
	        externalSessionV1: expect.objectContaining({
	          remoteSessionId: 'sess-handoff-direct',
	        }),
	      }),
	    );
	  });

  it('loads layout-v1 owner metadata through the default remote handoff loader', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-owner-metadata-'));
    const secret = new Uint8Array(32).fill(17);
    const credentials = {
      token: 'token-layout-v1',
      encryption: {
        type: 'legacy' as const,
        secret,
      },
    };
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        machineId: 'machine_source',
        path: '/private/worktree',
        homeDir: '/Users/private',
        happyHomeDir: '/Users/private/.happier',
        happyLibDir: '/Users/private/.happier/lib',
        happyToolsDir: '/Users/private/.happier/tools',
        workspaceId: 'workspace-private',
        workspaceLocationId: 'location-private',
        workspaceCheckoutId: 'checkout-private',
        flavor: 'claude',
      },
      nativeSession: {
        claudeSessionId: 'claude-session-private',
      },
      handoff: {
        handoffV1: {
          v: 1,
          sourceMachineId: 'machine_previous',
          targetMachineId: 'machine_source',
          agentId: 'claude',
          sessionStorageBefore: 'direct',
          sessionStorageAfter: 'persisted',
          transportStrategy: 'direct_peer',
          completedAtMs: 10,
          sourceWorkspaceRootPath: '/previous/worktree',
          targetWorkspaceRootPath: '/private/worktree',
        },
      },
    });
    const rawSession = {
      id: 'session-layout-v1',
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      encryptionMode: 'plain' as const,
      metadata: JSON.stringify({
        v: 1,
        summary: {
          text: 'Shared title only',
          updatedAt: 1,
        },
      }),
      metadataVersion: 1,
      metadataLayoutVersion: 1,
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'legacy', secret },
        ownerMetadata,
        randomBytes: (length) => new Uint8Array(length).fill(23),
      }),
      dataEncryptionKey: null,
    } satisfies RawSessionRecord;
    const exportSessionBundle = vi.fn(async (metadata: Record<string, unknown>) => ({
      agentBundle: {
        agentId: 'claude' as const,
        remoteSessionId: String(metadata.claudeSessionId),
        transcriptBase64: 'e30K',
      },
      targetPath: String(metadata.path),
    }));
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const persistenceModule = await import('../../../persistence');
    const sessionsHttpModule = await import('@/session/transport/http/sessionsHttp');
    const readCredentialsSpy = vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    const fetchSessionByIdSpy = vi.spyOn(sessionsHttpModule, 'fetchSessionById').mockResolvedValue(rawSession);

    try {
      registerMachineSessionHandoffRpcHandlers({
        // Boundary fixture: this test only needs to capture registered RPC handlers.
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        runtimeConfig: createRuntimeConfig({ activeServerDir }),
        exportSessionBundle,
        stopSessionForHandoff: async () => 'already_inactive',
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      expect(start).toBeDefined();

      await start!({
        sessionId: rawSession.id,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      });

      expect(readCredentialsSpy).toHaveBeenCalledOnce();
      expect(fetchSessionByIdSpy).toHaveBeenCalledWith({
        token: credentials.token,
        sessionId: rawSession.id,
      });
      expect(exportSessionBundle).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'machine_source',
        path: '/private/worktree',
        homeDir: '/Users/private',
        happyHomeDir: '/Users/private/.happier',
        happyLibDir: '/Users/private/.happier/lib',
        happyToolsDir: '/Users/private/.happier/tools',
        workspaceId: 'workspace-private',
        workspaceLocationId: 'location-private',
        workspaceCheckoutId: 'checkout-private',
        claudeSessionId: 'claude-session-private',
        handoffV1: expect.objectContaining({
          sourceMachineId: 'machine_previous',
          targetMachineId: 'machine_source',
          targetWorkspaceRootPath: '/private/worktree',
        }),
      }));
    } finally {
      readCredentialsSpy.mockRestore();
      fetchSessionByIdSpy.mockRestore();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('stops an active source session before exporting handoff state', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn(async () => ({
      agentBundle: {
        agentId: 'claude' as const,
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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

  it('stops an active direct-peer fallback source before exporting its provider bundle', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn(async () => ({
      agentBundle: {
        agentId: 'claude' as const,
        remoteSessionId: 'claude_session_direct_peer_active',
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
        claudeSessionId: 'claude_session_direct_peer_active',
      }),
      exportSessionBundle,
      stopSessionForHandoff,
      machineTransferChannel: {
        onEnvelope: () => () => {},
        sendEnvelope: () => {},
      },
      directPeerTransfer: {
        publishTransfer: vi.fn(async ({ transferId }) => [
          buildDirectPeerEndpointCandidate({ transferId }),
        ]),
        requestPayloadFile: vi.fn(),
        clearPublishedTransfer: vi.fn(),
      },
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
    expect(start).toBeDefined();

    const started = await start!({
      sessionId: 'sess_direct_peer_active',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'direct_peer',
    });

    expect(started).toMatchObject({
      handoffId: expect.stringMatching(/^handoff_/),
      handoffMetadataV2: {
        agentBundleTransferPublication: {
          sizeBytes: expect.any(Number),
          manifestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
    expect(stopSessionForHandoff).toHaveBeenCalledWith('sess_direct_peer_active');
    expect(stopSessionForHandoff.mock.invocationCallOrder[0]).toBeLessThan(
      exportSessionBundle.mock.invocationCallOrder[0]!,
    );
  });

  it('does not export a direct-peer fallback provider bundle when active-source stop fails', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn(async () => ({
      agentBundle: {
        agentId: 'claude' as const,
        remoteSessionId: 'claude_session_direct_peer_stop_failed',
        transcriptBase64: 'e30K',
      },
      targetPath: '/repo',
    }));
    const stopSessionForHandoff = vi.fn(async () => 'failed' as const);
    const clearPublishedTransfer = vi.fn();
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
        claudeSessionId: 'claude_session_direct_peer_stop_failed',
      }),
      exportSessionBundle,
      stopSessionForHandoff,
      machineTransferChannel: {
        onEnvelope: () => () => {},
        sendEnvelope: () => {},
      },
      directPeerTransfer: {
        publishTransfer: vi.fn(async ({ transferId }) => [
          buildDirectPeerEndpointCandidate({ transferId }),
        ]),
        requestPayloadFile: vi.fn(),
        clearPublishedTransfer,
      },
    });

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
    expect(start).toBeDefined();

    await expect(start!({
      sessionId: 'sess_direct_peer_stop_failed',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      negotiatedTransportStrategy: 'direct_peer',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'source_stop_failed',
      error: 'Failed to stop the active source session before handoff cutover',
    });

    expect(stopSessionForHandoff).toHaveBeenCalledWith('sess_direct_peer_stop_failed');
    expect(exportSessionBundle).not.toHaveBeenCalled();
    expect(clearPublishedTransfer).not.toHaveBeenCalled();
  });

	  it('acknowledges workspace handoff start (pending) without waiting for source stop/export when negotiatedTransportStrategy is omitted and server-routed fallback is available', async () => {

      const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-start-deferred-'));
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'test_session_handoff_start_deferred',
          filesTransferSessionTtlMs: 2_000,
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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

	    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
	    expect(start).toBeDefined();
	    const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
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
	        agentBundle: {
	          agentId: 'claude' as const,
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
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	    }
	  });

		  it('acknowledges workspace handoff start (pending) without waiting for workspace scan when negotiatedTransportStrategy is direct_peer and server-routed fallback is disabled', async () => {

	    const registered = new Map<string, (params: unknown) => Promise<any>>();
	    const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
	    const exportSessionBundle = vi.fn(async () => ({
	      agentBundle: {
	        agentId: 'claude' as const,
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

			      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
	          expect(started.handoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates?.length).toBeGreaterThan(0);
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

		  it('acknowledges workspace handoff start (pending) with direct-peer endpoint candidates when server-routed fallback exists and the deferred export finishes within the fast-path budget', async () => {

        const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-fast-path-source-'));
		    const registered = new Map<string, (params: unknown) => Promise<any>>();
		    const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
		    const exportSessionBundle = vi.fn(async () => ({
		      agentBundle: {
		        agentId: 'claude' as const,
		        remoteSessionId: 'claude_session_1',
		        transcriptBase64: 'e30K',
		      },
		      targetPath: sourcePath,
		    }));
		    const { publishTransfer, requestPayloadFile, dispose } = await createPublishedDirectPeerPayloadRouter();
		    const channels = createLoopbackMachineTransferChannels();
        await writeFile(join(sourcePath, 'README.md'), 'direct-peer-fast-path\n', 'utf8');

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
		          path: sourcePath,
		          flavor: 'claude',
		          claudeSessionId: 'claude_session_1',
		        }),
		        exportSessionBundle,
		        stopSessionForHandoff,
		        machineTransferChannel: channels.source,
		        directPeerTransfer: {
		          publishTransfer,
		          requestPayloadFile,
		          clearPublishedTransfer: vi.fn(),
		        },
		      });

		      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
		      expect(start).toBeDefined();

		      let started: any = null;
		      start!({
		        sessionId: 'sess_direct_peer_deferred_scan_with_server_routed_max_bytes_configured',
		        sourceMachineId: 'machine_source',
		        targetMachineId: 'machine_target',
		        sessionStorageMode: 'persisted',
		        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
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

		      await vi.waitFor(() => {
		        expect(started).toMatchObject({
		          handoffId: expect.stringMatching(/^handoff_/),
		          status: expect.objectContaining({
		            status: 'pending',
		            phase: 'preparing',
		          }),
		        });
		        expect(started.endpointCandidates.length).toBeGreaterThan(0);
		        expect(started.handoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates?.length).toBeGreaterThan(0);
		        expect(started.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates?.length).toBeGreaterThan(0);
		      }, { timeout: 200 });
		    } finally {
		      await dispose();
          await rm(sourcePath, { recursive: true, force: true });
		    }
		  });

      it('persists published direct-peer endpoint candidates into the durable source-export record during deferred start', async () => {

        const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-source-export-diagnostics-workspace-'));
        const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-source-export-diagnostics-'));
        const registered = new Map<string, (params: unknown) => Promise<any>>();
        const stopSessionForHandoff = vi.fn(async () => 'already_inactive' as const);
        const exportSessionBundle = vi.fn(async () => ({
          agentBundle: {
            agentId: 'claude' as const,
            remoteSessionId: 'claude_session_1',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
        }));
        const { publishTransfer, requestPayloadFile, dispose } = await createPublishedDirectPeerPayloadRouter();
        const channels = createLoopbackMachineTransferChannels();

        await writeFile(join(sourcePath, 'README.md'), 'source-export-diagnostics\n', 'utf8');

        try {
          const registerHandlers = createRegisterHandlers({
                activeServerDir: sourceActiveServerDir,
                activeServerId: 'test_direct_peer_source_export_diagnostics',
              });

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
            exportSessionBundle,
            stopSessionForHandoff,
            machineTransferChannel: channels.source,
            directPeerTransfer: {
              publishTransfer,
              requestPayloadFile,
              clearPublishedTransfer: vi.fn(),
            },
          });

          const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
          expect(start).toBeDefined();

          const started = await start!({
            sessionId: 'sess_direct_peer_source_export_diagnostics',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            negotiatedTransportStrategy: 'direct_peer',
            workspaceTransfer: {
              enabled: true,
              strategy: 'sync_changes',
              conflictPolicy: 'replace_existing',
              includeIgnoredMode: 'exclude',
              ignoredIncludeGlobs: [],
            },
          });

          expect(started).toMatchObject({
            handoffId: expect.stringMatching(/^handoff_/),
            status: expect.objectContaining({
              status: 'pending',
              phase: 'preparing',
            }),
          });

          const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir: sourceActiveServerDir });

          await vi.waitFor(async () => {
            const record = await sourceExportStore.load(started.handoffId);
            expect(record?.agentBundle?.endpointCandidates?.length).toBeGreaterThan(0);
            expect(record?.workspaceManifest?.endpointCandidates?.length).toBeGreaterThan(0);
          });
      } finally {
        await dispose();
        await rm(sourcePath, { recursive: true, force: true });
        await rm(sourceActiveServerDir, { recursive: true, force: true });
      }
      });

  it('keeps direct-peer prepare-target on the direct-peer path when the source export already persisted endpoint candidates', async () => {

    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-source-export-target-'));
    const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-source-export-workspace-'));
    const targetPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-source-export-target-workspace-'));
    const handoffId = 'handoff_direct_peer_source_export_candidates';
    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'sync_changes' as const,
      conflictPolicy: 'replace_existing' as const,
      includeIgnoredMode: 'exclude' as const,
      ignoredIncludeGlobs: [] as readonly string[],
    };

    try {
      const registerTargetHandlers = createRegisterHandlers({
            activeServerDir: targetActiveServerDir,
            activeServerId: 'test_direct_peer_source_export_candidates_target',
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;
      const channels = createLoopbackMachineTransferChannels();

      const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir: targetActiveServerDir });
      const agentBundleFilePath = join(targetActiveServerDir, 'session-handoff', handoffId, 'provider-bundle.json');
      const workspaceManifestFilePath = join(targetActiveServerDir, 'session-handoff', handoffId, 'workspace-manifest.txt');
      const sourceExportDirectory = join(targetActiveServerDir, 'session-handoff', handoffId);
      const agentBundle = {
        agentId: 'claude' as const,
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      };
      const workspaceManifest = {
        entries: [
          {
            kind: 'file' as const,
            relativePath: 'README.md',
            digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
            sizeBytes: 6,
            executable: false,
          },
        ],
        fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
      };
      await writeFile(join(sourcePath, 'README.md'), 'hello\n', 'utf8');

      await mkdir(sourceExportDirectory, { recursive: true });
      await writeFile(agentBundleFilePath, JSON.stringify(agentBundle), 'utf8');
      await writeFile(
        workspaceManifestFilePath,
        [
          'HAPPIER_WORKSPACE_REPLICATION_MANIFEST_V1',
          JSON.stringify({ manifestFingerprint: workspaceManifest.fingerprint }),
          JSON.stringify(workspaceManifest.entries[0]),
          '',
        ].join('\n'),
        'utf8',
      );
      await sourceExportStore.save({
        handoffId,
        sessionId: 'sess_direct_peer_source_export_candidates',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        exportedAtMs: Date.now(),
        workspaceSourceRootPath: sourcePath,
        agentBundle: {
          transferId: buildSessionHandoffAgentBundleTransferId(handoffId),
          filePath: agentBundleFilePath,
          sizeBytes: Buffer.byteLength(JSON.stringify(agentBundle), 'utf8'),
          manifestHash: `sha256:${'a'.repeat(64)}`,
          endpointCandidates: [
            buildDirectPeerEndpointCandidate({
              transferId: buildSessionHandoffAgentBundleTransferId(handoffId),
            }),
          ],
        },
        workspaceManifest: {
          transferId: `session-handoff:${handoffId}:workspace-manifest`,
          filePath: workspaceManifestFilePath,
          sizeBytes: Buffer.byteLength([
            'HAPPIER_WORKSPACE_REPLICATION_MANIFEST_V1',
            JSON.stringify({ manifestFingerprint: workspaceManifest.fingerprint }),
            JSON.stringify(workspaceManifest.entries[0]),
            '',
          ].join('\n'), 'utf8'),
          manifestHash: `sha256:${'b'.repeat(64)}`,
          entriesCount: workspaceManifest.entries.length,
          fileDigestsCount: workspaceManifest.entries.filter((entry) => entry.kind === 'file').length,
          endpointCandidates: [
            buildDirectPeerEndpointCandidate({
              transferId: `session-handoff:${handoffId}:workspace-manifest`,
            }),
          ],
        },
      });

      registerTargetHandlers({
        rpcHandlerManager,
        importSessionBundle: async (_agentBundle: unknown, directory: string) => ({
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
        }),
        machineTransferChannel: channels.target,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile: vi.fn(),
          clearPublishedTransfer: vi.fn(),
        },
      });

      const targetPrepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const targetStatusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      expect(targetPrepare).toBeDefined();
      expect(targetStatusGet).toBeDefined();

      const prepareResultPromise = targetPrepare!({
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath,
        workspaceTransfer,
        endpointCandidates: [],
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: buildSessionHandoffAgentBundleTransferId(handoffId),
            sizeBytes: Buffer.byteLength(JSON.stringify(agentBundle), 'utf8'),
            manifestHash: `sha256:${'a'.repeat(64)}`,
          },
          workspaceReplicationSourceRootPath: sourcePath,
          workspaceReplicationManifestTransferPublication: {
            transferId: `session-handoff:${handoffId}:workspace-manifest`,
          },
        },
      });

      const prepareResult = await prepareResultPromise;
      if ('ok' in prepareResult && prepareResult.ok === false) {
        throw new Error(`unexpected prepare failure: ${prepareResult.errorCode}:${prepareResult.error}`);
      }

      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({ activeServerDir: targetActiveServerDir });
      let latest = prepareResult;
      await vi.waitFor(async () => {
        latest = await targetStatusGet!({ handoffId });
        expect(latest.status.status).not.toBe('pending');
      }, { timeout: 15_000 });

      expect(latest.status.transportStrategy).toBe('direct_peer');
      if (latest.status.jobId) {
        const jobRecord = await prepareJobStore.read(latest.status.jobId);
        expect(jobRecord?.lastErrorMessage ?? '').not.toMatch(/server-routed.*4096/i);
      }
    } finally {
      await rm(sourcePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(targetActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30_000);

  it('fails closed when stopping the active source session for handoff cutover fails', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const exportSessionBundle = vi.fn(async () => ({
      agentBundle: {
        agentId: 'claude' as const,
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'test_session_handoff_durable_status',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_1',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3);
      const status = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);

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
          agentId: 'claude',
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
      const registerHandlersAfterRestart = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'test_session_handoff_durable_status',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });
      const registeredAfterRestart = new Map<string, (params: unknown) => Promise<any>>();
      registerHandlersAfterRestart({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registeredAfterRestart.set(method, handler);
          },
        } as any,
        // Restarted daemon doesn't need the source stubs to answer durable status_get.
      });
      const statusAfterRestart = registeredAfterRestart.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      expect(statusAfterRestart).toBeDefined();
      const fetchedAfterRestart = await statusAfterRestart!({ handoffId });
      expect(fetchedAfterRestart.status.status).toBe('completed');
      expect(fetchedAfterRestart.status.phase).toBe('finalizing');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('persists local handoff-back metadata for the resumed remote session during sync_changes prepare-target', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-local-metadata-'));
    const savePreparedTargetLocalMetadata = vi.fn(async () => {});

    try {
      const runtimeConfig = createRuntimeConfig({
          activeServerDir,
          activeServerId: 'test_session_handoff_local_metadata',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });
      const prepareTargetWorkspace = vi.fn(async (_params: any) => ({
        importedWorkspace: {
          targetPath: '/repo/source-current',
        },
        currentTargetManifest: {
          entries: [],
        },
        sourceOffer: null,
      }));
      const workspaceReplicationAdapter = createWorkspaceReplicationAdapterForTest({
          createReplicationTransfers: () => ({}) as any,
          createState: vi.fn(async () => ({ workspaceReplicationMetadata: undefined })),
          prepareSourceWorkspaceTransfer: vi.fn(async () => ({
            handoffMetadataV2: {
              workspaceReplicationSourceRootPath: '/repo/source-current',
              workspaceReplicationManifestTransferPublication: {
                transferId: 'session-handoff:test:workspace-manifest',
              },
            },
            workspaceReplicationMetadata: {
              sourceRootPath: '/repo/source-current',
              manifest: {
                entries: [],
              },
            },
          })),
          prepareTargetWorkspace,
          persistBaselineFromManifest: vi.fn(async () => {}),
        });

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        runtimeConfig,
        runtimeDependencies: { workspaceReplicationAdapter },
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: '/repo/source-current',
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
          handoffV1: {
            v: 1,
            sourceMachineId: 'machine_target',
            targetMachineId: 'machine_source',
            sourceWorkspaceRootPath: '/repo/original-source-root',
            targetWorkspaceRootPath: '/repo/source-current',
          },
        }),
        exportSessionBundle: async () => ({
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo/source-current',
        }),
        importSessionBundle: async (_bundle: any, directory: string) => ({
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
        }),
        savePreparedTargetLocalMetadata: savePreparedTargetLocalMetadata as any,
      } as any);

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_local_handoff_back',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'direct',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      });
      expect(started.handoffMetadataV2).toMatchObject({
        workspaceReplicationHandoffBackTargetRootPath: '/repo/original-source-root',
      });

      let prepared = await prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'direct',
        targetPath: '/repo/source-current',
        handoffMetadataV2: {
          workspaceReplicationSourceRootPath: '/repo/source-current',
          workspaceReplicationHandoffBackTargetRootPath: '/repo/original-source-root',
          workspaceReplicationManifestTransferPublication: {
            transferId: 'session-handoff:test:workspace-manifest',
          },
        },
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      });
      if (prepared.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          prepared = await resultGet!({ handoffId: started.handoffId });
          expect(prepared.status.status).toBe('ready_for_cutover');
        });
      }
      await vi.waitFor(() => {
        expect(savePreparedTargetLocalMetadata).toHaveBeenCalledTimes(1);
      });

      expect(savePreparedTargetLocalMetadata).toHaveBeenCalledWith({
        remoteSessionId: 'claude_session_target',
        exportMetadataOverlay: {
          handoffV1: expect.objectContaining({
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            agentId: 'claude',
            sessionStorageBefore: 'direct',
            sessionStorageAfter: 'direct',
            transportStrategy: 'server_routed_stream',
            sourceWorkspaceRootPath: '/repo/original-source-root',
            targetWorkspaceRootPath: '/repo/source-current',
          }),
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('persists local handoff metadata from workspaceReplicationSourceRootPath when sync_changes has no explicit handoff-back target root yet', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-local-metadata-fallback-'));
    const savePreparedTargetLocalMetadata = vi.fn(async () => {});

    try {
      const runtimeConfig = createRuntimeConfig({
          activeServerDir,
          activeServerId: 'test_session_handoff_local_metadata_fallback',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });
      const prepareTargetWorkspace = vi.fn(async (_params: any) => ({
        importedWorkspace: {
          targetPath: '/repo/target-current',
        },
        currentTargetManifest: {
          entries: [],
        },
        sourceOffer: null,
      }));
      const workspaceReplicationAdapter = createWorkspaceReplicationAdapterForTest({
          createReplicationTransfers: () => ({}) as any,
          createState: vi.fn(async () => ({ workspaceReplicationMetadata: undefined })),
          prepareSourceWorkspaceTransfer: vi.fn(async () => ({
            handoffMetadataV2: {
              workspaceReplicationSourceRootPath: '/repo/original-source-root',
              workspaceReplicationManifestTransferPublication: {
                transferId: 'session-handoff:test:workspace-manifest',
              },
            },
            workspaceReplicationMetadata: {
              sourceRootPath: '/repo/original-source-root',
              manifest: {
                entries: [],
              },
            },
          })),
          prepareTargetWorkspace,
          persistBaselineFromManifest: vi.fn(async () => {}),
        });

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;

      registerMachineSessionHandoffRpcHandlers({
        rpcHandlerManager,
        runtimeConfig,
        runtimeDependencies: { workspaceReplicationAdapter },
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: '/repo/original-source-root',
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle: async () => ({
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo/original-source-root',
        }),
        importSessionBundle: async (_bundle: any, directory: string) => ({
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
        }),
        savePreparedTargetLocalMetadata: savePreparedTargetLocalMetadata as any,
      } as any);

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_local_handoff_first_round',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'direct',
        preferredTransportStrategies: ['server_routed_stream'],
        negotiatedTransportStrategy: 'server_routed_stream',
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      });
      expect(started.handoffMetadataV2).not.toHaveProperty('workspaceReplicationHandoffBackTargetRootPath');
      expect(started.handoffMetadataV2).toMatchObject({
        workspaceReplicationSourceRootPath: '/repo/original-source-root',
      });

      let prepared = await prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'server_routed_stream',
        sourceSessionStorageMode: 'direct',
        targetPath: '/repo/target-current',
        handoffMetadataV2: {
          workspaceReplicationSourceRootPath: '/repo/original-source-root',
          workspaceReplicationManifestTransferPublication: {
            transferId: 'session-handoff:test:workspace-manifest',
          },
        },
        workspaceTransfer: {
          enabled: true,
          strategy: 'sync_changes',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
      });
      if (prepared.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          prepared = await resultGet!({ handoffId: started.handoffId });
          expect(prepared.status.status).toBe('ready_for_cutover');
        });
      }
      await vi.waitFor(() => {
        expect(savePreparedTargetLocalMetadata).toHaveBeenCalledTimes(1);
      });

      expect(savePreparedTargetLocalMetadata).toHaveBeenCalledWith({
        remoteSessionId: 'claude_session_target',
        exportMetadataOverlay: {
          handoffV1: expect.objectContaining({
            sourceWorkspaceRootPath: '/repo/original-source-root',
            targetWorkspaceRootPath: '/repo/target-current',
          }),
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('surfaces a Windows workspaceReplicationHandoffBackTargetRootPath when session metadata indicates a sync_changes handoff back', async () => {

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-start-v2-handoff-back-hint-'));
    const published = await createPublishedDirectPeerPayloadRouter();
    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'server_test',
          workspaceReplicationBlobPackTargetBytes: 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 1024,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 1024 * 1024,
        });

      const exportSessionBundle: ExportSessionBundle = async () => ({
        agentBundle: {
          agentId: 'claude' as const,
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
            sourceWorkspaceRootPath: 'C:\\Users\\alice\\projects\\.\\demo',
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

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
        workspaceReplicationHandoffBackTargetRootPath: 'C:\\Users\\alice\\projects\\demo',
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('surfaces workspaceReplicationHandoffBackTargetRootPath from workspaceReplicationSourceRootPath when handoffV1 metadata is unavailable for a sync_changes handoff back', async () => {

    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-start-v2-handoff-back-fallback-'));
    const published = await createPublishedDirectPeerPayloadRouter();
    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'server_test',
          workspaceReplicationBlobPackTargetBytes: 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 1024,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 1024 * 1024,
        });

      const exportSessionBundle: ExportSessionBundle = async () => ({
        agentBundle: {
          agentId: 'claude' as const,
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

      registerHandlers({
        rpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: '/home/guest/wsrepl-large-replication-9',
          flavor: 'claude',
          claudeSessionId: 'claude_session_1',
          workspaceReplicationSourceRootPath: '/repo/./wsrepl-large',
        }),
        exportSessionBundle,
        directPeerTransfer: {
          publishTransfer: published.publishTransfer,
          requestPayloadFile: published.requestPayloadFile as any,
          clearPublishedTransfer: vi.fn(),
        },
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      expect(start).toBeDefined();

      const result = await start!({
        sessionId: 'sess_handoff_back_hint_fallback',
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
      await rm(activeServerDir, { recursive: true }).catch(() => undefined);
    }
  });

  it('releases the session-operation claim after terminal abort and commit', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-operation-release-'));

    try {
      const registered = new Map<string, (params: unknown) => Promise<any>>();
      createRegisterHandlers({
        activeServerDir,
        activeServerId: 'test_session_handoff_operation_release',
      })({
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
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_1',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
        importSessionBundle: async (_bundle: any, directory: string) => ({
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
        }),
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3);
      const abort = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();
      expect(commit).toBeDefined();
      expect(abort).toBeDefined();

      const startRequest = {
        sessionId: 'sess_operation_release',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      } as const;

      const first = await start!(startRequest);
      expect(first.handoffId).toEqual(expect.any(String));
      await expect(abort!({
        handoffId: first.handoffId,
        reason: 'user_abort',
      })).resolves.toMatchObject({
        handoffId: first.handoffId,
        status: { status: 'aborted' },
      });

      const second = await start!(startRequest);
      expect(second.handoffId).toEqual(expect.any(String));
      expect(second.handoffId).not.toBe(first.handoffId);

      let ready = await prepare!({
        handoffId: second.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
      });
      if (ready.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          ready = await resultGet!({ handoffId: second.handoffId });
          expect(ready.status.status).toBe('ready_for_cutover');
        });
      }
      await expect(commit!({ handoffId: second.handoffId })).resolves.toMatchObject({
        handoffId: second.handoffId,
        status: { status: 'completed' },
      });

      const third = await start!(startRequest);
      expect(third.handoffId).toEqual(expect.any(String));
      expect(third.handoffId).not.toBe(second.handoffId);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when commit is called before the target is ready for cutover (no premature completion/disposal while prepare is pending)', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-commit-not-ready-'));

    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'test_session_handoff_commit_not_ready',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);

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
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'test_session_handoff_source_cleanup_reverse_baseline',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
	        }),
	      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3);
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

      // start() can acknowledge before the durable source-export record has been rewritten with
      // workspace manifest metadata. Wait for the canonical durable record, not just file presence.
      const { createSessionHandoffSourceExportStore } = await import('../../../session/handoff/state/sessionHandoffSourceExportStore');
      const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir });
      await vi.waitFor(async () => {
        const persisted = await sourceExportStore.load(started.handoffId);
        expect(persisted?.agentBundle).toBeDefined();
        expect(persisted?.workspaceManifest).toBeDefined();
        expect(persisted?.workspaceSourceRootPath).toBe(sourcePath);
      }, { timeout: 10_000 });

      await commit!({
        handoffId: started.handoffId,
        mode: 'source_cleanup',
        workspaceReplicationReverseSourceRootPath: reverseSourceRootPath,
        workspaceReplicationReverseTargetRootPath: reverseTargetRootPath,
      });

      const { createWorkspaceReplicationBaselineStore } = await import('../../../workspaces/replication/baseline/workspaceReplicationBaselineStore');
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
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(sourcePath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('stops the source session during source_cleanup commit (prevents late source metadata overwrites)', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-source-cleanup-stop-'));

    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'test_session_handoff_source_cleanup_stop',
        });

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
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3);
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
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed instead of leaving prepare-target pending when a lease has no persisted owner job', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-lease-release-'));
    const agentBundlePayload = Buffer.from(JSON.stringify({
      agentId: 'claude',
      remoteSessionId: 'claude_session_1',
      transcriptBase64: 'e30K',
    }), 'utf8');
    const directPeerPayload = await createDirectPeerRequestPayloadFile({
      payload: agentBundlePayload,
    });

    try {
      const runtimeConfig = createRuntimeConfig({
          activeServerDir,
          activeServerId: 'test_session_handoff_lease_release',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });
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

      registerMachineSessionHandoffRpcHandlers({
        runtimeConfig,
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            registered.set(method, handler);
          },
        } as any,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile: directPeerPayload.requestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        },
        importSessionBundle,
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);

      expect(prepare).toBeDefined();

      const handoffId = 'handoff_lease_release';
      const agentBundleTransferId = buildSessionHandoffAgentBundleTransferId(handoffId);
      const endpointCandidates = [buildDirectPeerEndpointCandidate({
        transferId: agentBundleTransferId,
      })];
      const prepareRequest = {
        handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer' as const,
        allowServerRoutedFallback: false,
        sourceSessionStorageMode: 'persisted' as const,
        targetPath: '/repo',
        endpointCandidates,
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: agentBundleTransferId,
            sizeBytes: agentBundlePayload.byteLength,
            manifestHash: `sha256:${createHash('sha256').update(agentBundlePayload).digest('hex')}`,
            endpointCandidates,
          },
        },
      };

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

      const prepared = await prepare!(prepareRequest);
      expect(prepared.status.status).toBe('pending');

      await rm(leaseDirectory, { recursive: true, force: true });

      await expect(prepare!(prepareRequest)).resolves.toMatchObject({
        handoffId,
        status: {
          handoffId,
          jobId: deterministicJobId,
          status: 'reconciliation_required',
          progress: {
            current: {
              phaseDetail: 'daemon_restart_reconciliation_required',
            },
            resumable: true,
          },
        },
      });
      expect(importSessionBundle).not.toHaveBeenCalled();
    } finally {
      await directPeerPayload.dispose();
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('surfaces workspace replication engine progress in status_get while prepare-target is pending', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-status-progress-'));

    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'test_status_progress',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      expect(statusGet).toBeDefined();

	      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
	        handoffId,
	        status: {
	          handoffId,
	          status: 'pending',
	          phase: 'staging_target',
	          jobId: prepareJobId,
          progress: {
            updatedAtMs: expect.any(Number),
            checkpoint: 'transfer_blobs',
            planned: {},
            transferred: {},
            applied: {},
            remaining: {},
            current: {
              phaseDetail: 'workspace_replication:transfer_missing_blobs_to_target_cas',
            },
            resumable: false,
          },
	        },
	      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('maps workspace replication checkpoint blob_transfer_completed to the handoff stage_target checkpoint in status_get (timeline parity)', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-status-checkpoint-parity-'));

    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'test_status_checkpoint_parity',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
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
            applied: {
              files: 0,
              bytes: 0,
            },
            remaining: {
              files: 0,
              bytes: 0,
            },
            current: {
              phaseDetail: 'workspace_replication:transfer_missing_blobs_to_target_cas',
            },
          },
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('does not mark a pending prepare-target job as awaiting_recovery when a live lease exists', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-status-live-lease-'));

    try {
      const registerHandlers = createRegisterHandlers({
          activeServerDir,
          activeServerId: 'test_status_live_lease',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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

      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
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
          agentBundle: {
            agentId: 'claude',
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

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
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
	          agentId: 'claude',
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
    const workspaceReplicationAdapter = createWorkspaceReplicationAdapterForTest({
      createReplicationTransfers: () => ({}) as any,
      createState,
      resolveSourceOffer,
      prepareSourceWorkspaceTransfer,
    });
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

	    const runtimeConfig = createRuntimeConfig({
	        activeServerDir: '/tmp/happier-adapter-seam',
	        happyHomeDir: '/tmp/happier-adapter-seam-home',
	        activeServerId: 'test_adapter_seam',
        workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
        workspaceReplicationBlobPackMaxBlobs: 64,
	        workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
	      });
	    try {
      registerMachineSessionHandoffRpcHandlers({
        runtimeDependencies: { workspaceReplicationAdapter },
        rpcHandlerManager,
        runtimeConfig,
        loadSessionMetadata: async () => ({
        machineId: 'machine_source',
        path: sourcePath,
        homeDir: '/Users/tester',
        flavor: 'claude',
        claudeSessionId: 'claude_session_1',
      }),
      exportSessionBundle: async () => ({
        agentBundle: {
          agentId: 'claude',
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
	          workspaceIntegrationMetadata: {
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

	      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
      expect(prepareSourceWorkspaceTransfer).toHaveBeenCalledWith(expect.objectContaining({
        activeServerDir: '/tmp/happier-adapter-seam',
        handoffId: started.handoffId,
        negotiatedTransportStrategy: 'server_routed_stream',
        agentBundle: expect.objectContaining({
          agentId: 'claude',
          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        }),
        sourceRootPath: sourcePath,
        workspaceTransfer: expect.objectContaining({
          enabled: true,
          strategy: 'sync_changes',
        }),
      }));
      expect(createState).not.toHaveBeenCalled();
    } finally {
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
	    const workspaceReplicationAdapter = createWorkspaceReplicationAdapterForTest({
	      createReplicationTransfers: () => ({}) as any,
	      createState,
	      resolveSourceOffer,
	      prepareSourceWorkspaceTransfer,
	      prepareTargetWorkspace,
	    });
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

	    try {
      registerMachineSessionHandoffRpcHandlers({
        runtimeDependencies: { workspaceReplicationAdapter },
        rpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          homeDir: '/Users/tester',
          flavor: 'claude',
          claudeSessionId: 'claude_session_1',
        }),
        exportSessionBundle: async () => ({
          agentBundle: {
            agentId: 'claude',
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
	            workspaceIntegrationMetadata: {
	              scmBackendId: 'git',
	            },
	          },
	          blobProvider: {
	            getBlobFilePath: () => `${sourcePath}/README.md`,
	          },
		        }),
	        importSessionBundle,
	      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
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
	          agentId: 'claude',
	          remoteSessionId: 'claude_session_1',
          transcriptBase64: 'e30K',
        },
        '/repo-adapter-target',
        'persisted',
      );

      const { createSessionHandoffPrepareTargetJobStore } = await import('@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore');
      const prepareJobStore = createSessionHandoffPrepareTargetJobStore({
        activeServerDir: defaultTestCaseActiveServerDir,
      });
      const persisted = await prepareJobStore.findByHandoffId(started.handoffId);
      expect(persisted?.workspaceReplicationJobId).toBe('job_wsrepl_1');
    } finally {
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
        currentTargetManifest: { entries: [] },
        sourceOffer: null,
      };
    });
    const workspaceReplicationAdapter = createWorkspaceReplicationAdapterForTest({
      createReplicationTransfers: () => ({}) as any,
      createState,
      resolveSourceOffer,
      prepareSourceWorkspaceTransfer,
      prepareTargetWorkspace,
    });
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

    try {
      registerMachineSessionHandoffRpcHandlers({
        runtimeDependencies: { workspaceReplicationAdapter },
        rpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          homeDir: '/Users/tester',
          flavor: 'claude',
          claudeSessionId: 'claude_session_1',
        }),
        exportSessionBundle: async () => ({
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_1',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
          workspaceExportArtifacts: {
            manifest: {
              entries: [],
              fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
            },
            workspaceIntegrationMetadata: {
              scmBackendId: 'git',
            },
          },
          blobProvider: {
            getBlobFilePath: () => `${sourcePath}/README.md`,
          },
        }),
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
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
    }
  });

  it('prefers workspaceReplicationHandoffBackTargetRootPath over the rebased source targetPath during sync_changes prepare-target', async () => {
    const sourcePath = '/Users/tester/projects/demo';
    const handoffBackTargetRootPath = '/repo/original-source-root';
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const createState = vi.fn(async () => ({
      workspaceReplicationMetadata: undefined,
    }));
    const resolveSourceOffer = vi.fn(async () => null);
    const prepareSourceWorkspaceTransfer = vi.fn(async () => ({
      handoffMetadataV2: {
        workspaceReplicationSourceRootPath: sourcePath,
        workspaceReplicationHandoffBackTargetRootPath: handoffBackTargetRootPath,
        workspaceReplicationManifestTransferPublication: {
          transferId: 'session-handoff:test:workspace-manifest',
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
          targetPath: handoffBackTargetRootPath,
        },
        currentTargetManifest: { entries: [] },
        sourceOffer: null,
      };
    });
    const workspaceReplicationAdapter = createWorkspaceReplicationAdapterForTest({
      createReplicationTransfers: () => ({}) as any,
      createState,
      resolveSourceOffer,
      prepareSourceWorkspaceTransfer,
      prepareTargetWorkspace,
    });
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig',
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: handoffBackTargetRootPath,
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
        runtimeDependencies: { workspaceReplicationAdapter },
        rpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          homeDir: '/Users/tester',
          flavor: 'claude',
          claudeSessionId: 'claude_session_1',
          handoffV1: {
            v: 1,
            sourceMachineId: 'machine_target',
            targetMachineId: 'machine_source',
            sourceWorkspaceRootPath: handoffBackTargetRootPath,
            targetWorkspaceRootPath: sourcePath,
          },
        }),
        exportSessionBundle: async () => ({
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_1',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
          workspaceExportArtifacts: {
            manifest: {
              entries: [],
              fingerprint: 'sha256:6586b45e062c5c7104d24f2da5812c0d824533c575715c87e0377fc2e0c959cc',
            },
            workspaceIntegrationMetadata: {
              scmBackendId: 'git',
            },
          },
          blobProvider: {
            getBlobFilePath: () => `${sourcePath}/README.md`,
          },
        }),
        importSessionBundle,
      });

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const workspaceTransfer = {
        enabled: true as const,
        strategy: 'sync_changes' as const,
        conflictPolicy: 'replace_existing' as const,
        includeIgnoredMode: 'exclude' as const,
        ignoredIncludeGlobs: [],
      };
      const started = await start!({
        sessionId: 'sess_adapter_prepare_targetpath_handoff_back',
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
        targetPath: '/Users/other-user/Documents/demo',
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
        targetPath: handoffBackTargetRootPath,
      }));
    } finally {
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
        agentBundle: {
          agentId: 'claude',
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
    const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
    expect(start).toBeDefined();

    await expect(start!({ targetMachineId: 'machine_target' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
    });
  });

  it('returns pending and then awaiting_recovery for direct-peer prepare payloads that omit endpoint candidates', async () => {
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

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
    const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
    expect(prepare).toBeDefined();
    expect(statusGet).toBeDefined();

    const prepared = await prepare!({
      handoffId: 'handoff_missing_transfer_source',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      handoffMetadataV2: {
        agentBundleTransferPublication: {
          transferId: 'session-handoff:handoff_missing_transfer_source:provider-bundle-file',
          sizeBytes: 0,
          manifestHash: `sha256:${'0'.repeat(64)}`,
          // Intentionally omit endpointCandidates so the direct-peer prepare settles into awaiting_recovery.
          },
        },
    });

    expect(prepared).toMatchObject({
      handoffId: 'handoff_missing_transfer_source',
      status: expect.objectContaining({
        status: 'pending',
        transportStrategy: 'direct_peer',
      }),
    });

    await vi.waitFor(async () => {
      await expect(statusGet!({ handoffId: 'handoff_missing_transfer_source' })).resolves.toMatchObject({
        handoffId: 'handoff_missing_transfer_source',
        status: expect.objectContaining({
          status: 'awaiting_recovery',
          transportStrategy: 'direct_peer',
        }),
      });
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
        agentBundle: {
          agentId: 'claude',
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
        agentBundle: {
          agentId: 'claude',
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
        agentBundle: {
          agentId: 'codex',
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
      agentBundle: {
        agentId: 'claude' as const,
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
      agentBundle: {
        agentId: 'claude' as const,
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
      agentBundle: {
        agentId: 'claude' as const,
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

	      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
      agentBundle: {
        agentId: 'claude' as const,
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

	    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
      const registerHandlers = createRegisterHandlers({
          activeServerDir: sourceActiveServerDir,
          happyHomeDir: sourceActiveServerDir,
          activeServerId: 'test_direct_peer_header_only',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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
          agentBundle: {
            agentId: 'claude' as const,
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
            workspaceIntegrationMetadata: {
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

      const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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

      const agentBundlePublishCall = publishTransfer.mock.calls.find(
        ([call]) => call.transferId === `session-handoff:${started.handoffId}:provider-bundle-file`,
      )?.[0];
      expect(agentBundlePublishCall?.payloadSource?.kind).toBe('file');
      if (!agentBundlePublishCall?.payloadSource || agentBundlePublishCall.payloadSource.kind !== 'file') {
        throw new Error('Expected file-backed provider bundle publication');
      }
      const agentBundleContents = await readFile(agentBundlePublishCall.payloadSource.filePath, 'utf8');
      expect(agentBundleContents).not.toContain(workspaceBlobPayload.toString('utf8'));

      expect(started.handoffMetadataV2).toEqual(expect.objectContaining({
        agentBundleTransferPublication: expect.objectContaining({
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
          endpointCandidates: started.handoffMetadataV2.agentBundleTransferPublication?.endpointCandidates ?? [],
          destinationPath: manifestDestinationPath,
        });
      }, { timeout: 10_000 });
      const manifestText = await readFile(manifestDestinationPath, 'utf8');
      expect(manifestText).toContain('HAPPIER_WORKSPACE_REPLICATION_MANIFEST_V1');
	    } finally {
	      await dispose();
	      await rm(sourcePath, { recursive: true, force: true });
	      await rm(workspaceBlobDir, { recursive: true, force: true });
	      await rm(sourceActiveServerDir, { recursive: true, force: true });
	    }
	  });

  it('applies server-routed workspace sync through the replication engine when workspace transfer is enabled', async () => {

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

      const registerSourceHandlers = createRegisterHandlers({
            activeServerDir: sourceActiveServerDir,
            activeServerId: 'test_server_routed_source',
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });

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
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
        }),
        machineTransferChannel: channels.source,
	      });

	      const registerTargetHandlers = createRegisterHandlers({
	            activeServerDir: targetActiveServerDir,
	            activeServerId: 'test_server_routed_target',
	            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
	            workspaceReplicationBlobPackMaxBlobs: 64,
	            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
	          });

	      registerTargetHandlers({
	        rpcHandlerManager: targetRpcHandlerManager,
	        importSessionBundle,
	        machineTransferChannel: channels.target,
	      });

      const sourceStart = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const targetPrepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
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
          const next = await resultGet!({ handoffId: started.handoffId });
          if (next && typeof next === 'object' && 'ok' in next && next.ok === false) {
            throw new Error(`prepare-target result not ready (${String((next as any).errorCode ?? 'unknown')})`);
          }
          ready = next;
          expect(ready.status.status).toBe('ready_for_cutover');
        }, { timeout: 10_000 });
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
	          agentId: 'claude',
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
      if (process.env.HAPPIER_DEBUG_KEEP_HANDOFF_TMP !== '1') {
        await rm(sourcePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        await rm(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        await rm(targetActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
  });

  it('serves server-routed workspace blob packs after a daemon restart (no in-memory source state)', async () => {

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

      const registerSourceHandlers = createRegisterHandlers({
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_server_routed_restart_source',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
        }),
        machineTransferChannel: channels.source,
      });

      const sourceStart = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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
      const registerSourceHandlersAfterRestart = createRegisterHandlers({
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_server_routed_restart_source',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });
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
      await rm(sourcePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('acknowledges server-routed workspace handoff start before a large workspace export finishes and lets prepare wait for it', async () => {

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
      agentBundle: {
        agentId: 'claude';
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

    const isolatedHome = await createIsolatedProcessHome('happier-session-handoff-server-routed-deferred-home-');

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
      const registerSourceHandlers = createRegisterHandlers({
            activeServerDir: sourceActiveServerDir,
            activeServerId: 'test_server_routed_deferred_source',
            filesTransferSessionTtlMs: 2_000,
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });

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

      const registerTargetHandlers = createRegisterHandlers({
            activeServerDir: targetActiveServerDir,
            activeServerId: 'test_server_routed_deferred_target',
            filesTransferSessionTtlMs: 2_000,
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });

      registerTargetHandlers({
        rpcHandlerManager: targetRpcHandlerManager,
        importSessionBundle,
        machineTransferChannel: channels.target,
      });

      const sourceStart = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const targetPrepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
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
        agentBundle: {
          agentId: 'claude',
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
      expect(importedDirectory).toBe(join(isolatedHome.homeDir, 'repo-target'));
      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          agentId: 'claude',
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
      isolatedHome.restore();
      if (process.env.HAPPIER_DEBUG_KEEP_HANDOFF_TMP !== '1') {
        await rm(sourcePath, { recursive: true, force: true });
        await rm(sourceActiveServerDir, { recursive: true, force: true });
        await rm(targetActiveServerDir, { recursive: true, force: true });
        await rm(isolatedHome.homeDir, { recursive: true, force: true });
      }
    }
  });

  it('waits for a truthful provider-bundle commitment before keeping deferred prepare-target on direct-peer', async () => {

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
      agentBundle: {
        agentId: 'claude';
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
    const published = await createPublishedDirectPeerPayloadRouter();
    const exportSessionBundle = vi.fn(async () => await exportDeferred.promise);
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

    const isolatedHome = await createIsolatedProcessHome('happier-session-handoff-direct-peer-deferred-home-');

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

      const registerSourceHandlers = createRegisterHandlers({
            activeServerDir: sourceActiveServerDir,
            activeServerId: 'test_direct_peer_deferred_source',
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });

      registerSourceHandlers({
        rpcHandlerManager: sourceRpcHandlerManager,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          homeDir: '/Users/tester',
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle,
        machineTransferChannel: channels.source,
        directPeerTransfer: {
          publishTransfer: published.publishTransfer,
          requestPayloadFile: published.requestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        } as any,
      });

      const registerTargetHandlers = createRegisterHandlers({
            activeServerDir: targetActiveServerDir,
            activeServerId: 'test_direct_peer_deferred_target',
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });

      registerTargetHandlers({
        rpcHandlerManager: targetRpcHandlerManager,
        importSessionBundle,
        machineTransferChannel: channels.target,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile: published.requestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        } as any,
      });

      const sourceStart = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const targetPrepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
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
        expect(exportSessionBundle).toHaveBeenCalledOnce();
      });
      expect(started).toBeNull();

      exportDeferred.resolve({
        agentBundle: {
          agentId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        targetPath: sourcePath,
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
        expect(started.endpointCandidates.length).toBeGreaterThan(0);
        expect(started.handoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates?.length).toBeGreaterThan(0);
        expect(started.handoffMetadataV2?.agentBundleTransferPublication?.sizeBytes).toBeGreaterThan(2);
        expect(started.handoffMetadataV2?.agentBundleTransferPublication?.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(started.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates?.length).toBeGreaterThan(0);
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

      let ready = prepareAck;
      await vi.waitFor(async () => {
        const next = await resultGet!({ handoffId: started.handoffId });
        if (next && typeof next === 'object' && 'ok' in next && next.ok === false) {
          throw new Error(`prepare-target result not ready (${String((next as any).errorCode ?? 'unknown')})`);
        }
        ready = next;
        expect(ready.status.status).toBe('ready_for_cutover');
      }, { timeout: 10_000 });

      expect(ready.status.transportStrategy).toBe('direct_peer');
      expect(ready.resume.directory).toBe(join(isolatedHome.homeDir, 'repo-target'));

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
          agentId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        ready.resume.directory,
        'persisted',
      );
    } finally {
      await published.dispose();
      isolatedHome.restore();
      if (process.env.HAPPIER_DEBUG_KEEP_HANDOFF_TMP !== '1') {
        await rm(sourcePath, { recursive: true, force: true });
        await rm(sourceActiveServerDir, { recursive: true, force: true });
        await rm(targetActiveServerDir, { recursive: true, force: true });
        await rm(targetPath, { recursive: true, force: true });
        await rm(isolatedHome.homeDir, { recursive: true, force: true });
      }
    }
  });

  it('passes the prepare-time transfer timeout through direct-peer provider-bundle and manifest requests', async () => {

    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-timeout-target-'));
    const targetPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-timeout-target-workspace-'));
    const agentBundleTransferId = buildSessionHandoffAgentBundleTransferId('handoff_direct_peer_timeout_passthrough');
    const manifestTransferId = 'session-handoff:handoff_direct_peer_timeout_passthrough:workspace-manifest';
    const workspaceManifestFingerprint = `sha256:${'0'.repeat(64)}`;
    try {
      const registerTargetHandlers = createRegisterHandlers({
            activeServerDir: targetActiveServerDir,
            activeServerId: 'test_direct_peer_timeout_passthrough',
            filesTransferSessionTtlMs: 2_000,
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;
      const requestPayloadFile = vi.fn(async (input: Readonly<{
        transferId: string;
        endpointCandidates: readonly TransferEndpointCandidate[];
        destinationPath: string;
      }>) => {
        const timeoutMs = (input as Record<string, unknown>).timeoutMs;
        expect(timeoutMs).toBe(2_000);
        if (input.transferId === agentBundleTransferId) {
          await writeFile(
            input.destinationPath,
            JSON.stringify({
              agentId: 'claude',
              remoteSessionId: 'claude_session_source',
              transcriptBase64: 'e30K',
            }),
            'utf8',
          );
          return { destinationPath: input.destinationPath };
        }
        if (input.transferId === manifestTransferId) {
          await writeFile(
            input.destinationPath,
            JSON.stringify({
              entries: [],
              fingerprint: workspaceManifestFingerprint,
            }),
            'utf8',
          );
          return { destinationPath: input.destinationPath };
        }
        throw new Error(`Unexpected direct-peer transfer request: ${input.transferId}`);
      });

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

      registerTargetHandlers({
        rpcHandlerManager,
        importSessionBundle,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile: requestPayloadFile as DirectPeerRequestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        },
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      expect(prepare).toBeDefined();

      const result = await prepare!({
        handoffId: 'handoff_direct_peer_timeout_passthrough',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath,
        endpointCandidates: [
          buildDirectPeerEndpointCandidate({ transferId: agentBundleTransferId }),
        ],
        workspaceTransfer: {
          enabled: true,
          strategy: 'transfer_snapshot',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: agentBundleTransferId,
            sizeBytes: 64,
            manifestHash: `sha256:${'1'.repeat(64)}`,
            endpointCandidates: [
              buildDirectPeerEndpointCandidate({ transferId: agentBundleTransferId }),
            ],
          },
          workspaceReplicationSourceRootPath: '/repo',
          workspaceReplicationManifestTransferPublication: {
            transferId: manifestTransferId,
            endpointCandidates: [
              buildDirectPeerEndpointCandidate({
                transferId: manifestTransferId,
              }),
            ],
          },
        },
      });

      expect(result).toBeDefined();
      await vi.waitFor(() => {
        expect(requestPayloadFile).toHaveBeenCalledTimes(2);
      });
      expect(
        requestPayloadFile.mock.calls.map(([input]) => input.transferId).sort(),
      ).toEqual([manifestTransferId, agentBundleTransferId].sort());
    } finally {
      await rm(targetActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('does not wait for a target-local source-export record before issuing direct-peer prepare requests when request metadata already includes endpoint candidates', async () => {

    const previousTransferTimeoutMs = process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
    process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = '500';

    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-remote-target-'));
    const targetPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-remote-target-workspace-'));
    const agentBundleTransferId = buildSessionHandoffAgentBundleTransferId('handoff_direct_peer_remote_target');
    const manifestTransferId = 'session-handoff:handoff_direct_peer_remote_target:workspace-manifest';
    const workspaceManifestFingerprint = `sha256:${'9'.repeat(64)}`;

    try {
      const registerTargetHandlers = createRegisterHandlers({
            activeServerDir: targetActiveServerDir,
            activeServerId: 'test_direct_peer_remote_target',
            filesTransferSessionTtlMs: 2_000,
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });

      const registered = new Map<string, (params: unknown) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;
      const channels = createLoopbackMachineTransferChannels();

      const requestPayloadFile = vi.fn(async (input: Readonly<{
        transferId: string;
        endpointCandidates: readonly TransferEndpointCandidate[];
        destinationPath: string;
      }>) => {
        const timeoutMs = (input as Record<string, unknown>).timeoutMs;
        expect(timeoutMs).toBe(2_000);
        if (input.transferId === agentBundleTransferId) {
          await writeFile(
            input.destinationPath,
            JSON.stringify({
              agentId: 'claude',
              remoteSessionId: 'claude_session_source',
              transcriptBase64: 'e30K',
            }),
            'utf8',
          );
          return { destinationPath: input.destinationPath };
        }
        if (input.transferId === manifestTransferId) {
          await writeFile(
            input.destinationPath,
            JSON.stringify({
              entries: [],
              fingerprint: workspaceManifestFingerprint,
            }),
            'utf8',
          );
          return { destinationPath: input.destinationPath };
        }
        throw new Error(`Unexpected direct-peer transfer request: ${input.transferId}`);
      });

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

      registerTargetHandlers({
        rpcHandlerManager,
        importSessionBundle,
        machineTransferChannel: channels.target,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile: requestPayloadFile as DirectPeerRequestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        },
      });

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      expect(prepare).toBeDefined();
      expect(statusGet).toBeDefined();

      const prepared = await prepare!({
        handoffId: 'handoff_direct_peer_remote_target',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath,
        endpointCandidates: [
          buildDirectPeerEndpointCandidate({ transferId: agentBundleTransferId }),
        ],
        workspaceTransfer: {
          enabled: true,
          strategy: 'transfer_snapshot',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'exclude',
          ignoredIncludeGlobs: [],
        },
        handoffMetadataV2: {
          agentBundleTransferPublication: {
            transferId: agentBundleTransferId,
            sizeBytes: 64,
            manifestHash: `sha256:${'1'.repeat(64)}`,
            endpointCandidates: [
              buildDirectPeerEndpointCandidate({ transferId: agentBundleTransferId }),
            ],
          },
          workspaceReplicationSourceRootPath: '/repo',
          workspaceReplicationManifestTransferPublication: {
            transferId: manifestTransferId,
            endpointCandidates: [
              buildDirectPeerEndpointCandidate({
                transferId: manifestTransferId,
              }),
            ],
          },
        },
      });

      await vi.waitFor(() => {
        expect(requestPayloadFile).toHaveBeenCalledTimes(2);
      }, { timeout: 5_000 });
      expect(
        requestPayloadFile.mock.calls.map(([input]) => input.transferId).sort(),
      ).toEqual([manifestTransferId, agentBundleTransferId].sort());

      let latest = prepared;
      await vi.waitFor(async () => {
        latest = await statusGet!({ handoffId: 'handoff_direct_peer_remote_target' });
        expect(latest.status.status).not.toBe('pending');
      }, { timeout: 5_000 });
      expect(latest.status.status).not.toBe('pending');
    } finally {
      if (previousTransferTimeoutMs === undefined) {
        delete process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS = previousTransferTimeoutMs;
      }
      await rm(targetActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

      const registerSourceHandlers = createRegisterHandlers({
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_server_routed_unavailable_source',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: '/repo',
        }),
        machineTransferChannel: channels.source,
      });

      const registerTargetHandlers = createRegisterHandlers({
          activeServerDir: targetActiveServerDir,
          activeServerId: 'test_server_routed_unavailable_target',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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

      const start = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const statusGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
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

      const registerSourceHandlers = createRegisterHandlers({
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_provider_timeout_source',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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
          agentBundle: {
            agentId: 'claude',
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

      const registerTargetHandlers = createRegisterHandlers({
          activeServerDir: targetActiveServerDir,
          activeServerId: 'test_provider_timeout_target',
          workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
          workspaceReplicationBlobPackMaxBlobs: 64,
          workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
        });

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

      const start = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const statusGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
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

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
    const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
    expect(prepare).toBeDefined();
    expect(statusGet).toBeDefined();

    await expect(prepare!({
      handoffId: 'handoff_server_routed_legacy_inline_fallback',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'server_routed_stream',
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      workspaceManifestHash: 'sha256:legacy-inline-workspace',
      transferredPayload: {
        agentBundle: {
          agentId: 'claude',
          remoteSessionId: 'claude_session_inline',
          transcriptBase64: 'e30K',
        },
      },
      agentBundle: {
        agentId: 'claude',
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

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
    const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
    expect(prepare).toBeDefined();
    expect(statusGet).toBeDefined();

    const handoffId = 'handoff_invalid_server_routed_inline_fallback';
    const agentBundleTransferId = `session-handoff:${handoffId}:provider-bundle-file`;
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
      agentBundleTransferId,
    );

    const malformedServerRoutedPayload = Buffer.from('{"providerId":', 'utf8');

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
          transferId: agentBundleTransferId,
          kind: 'finish',
          manifestHash: `sha256:${createHash('sha256').update(malformedServerRoutedPayload).digest('hex')}`,
        },
      });
    }

    const prepared = await preparePromise;
    expect(prepared).toMatchObject({
      handoffId,
      status: expect.objectContaining({
        status: 'pending',
        transportStrategy: 'server_routed_stream',
      }),
    });

    await vi.waitFor(async () => {
      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: expect.objectContaining({
          status: 'awaiting_recovery',
          phase: 'staging_target',
        }),
      });
    });

    expect(importSessionBundle).not.toHaveBeenCalled();
  });

  it('fails closed when the server-routed transfer payload does not satisfy the canonical handoff schemas', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const importSessionBundle = vi.fn(async () => {
      throw new Error('Invalid Claude session handoff bundle');
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
    });

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
    const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
    const resultGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
    expect(prepare).toBeDefined();
    expect(statusGet).toBeDefined();
    expect(resultGet).toBeDefined();

    const handoffId = 'handoff_invalid_server_routed';
    const agentBundleTransferId = `session-handoff:${handoffId}:provider-bundle-file`;
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
      agentBundleTransferId,
    );

    const dispatchEnvelope = (payload: MachineTransferReceiveEnvelope) => {
      for (const listener of listeners) {
        listener(payload);
      }
    };
    // Missing transcriptBase64 (required).
    const invalidServerRoutedPayload = Buffer.from(JSON.stringify({
      agentId: 'claude',
      remoteSessionId: 'claude_session_source',
    }), 'utf8');

    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: agentBundleTransferId,
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: agentBundleTransferId,
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
        transferId: agentBundleTransferId,
        kind: 'finish',
        manifestHash: `sha256:${createHash('sha256').update(invalidServerRoutedPayload).digest('hex')}`,
      },
    });

    const prepared = await preparePromise;
    expect(prepared).toMatchObject({
      handoffId,
      status: expect.objectContaining({
        status: 'pending',
        transportStrategy: 'server_routed_stream',
      }),
    });

    await vi.waitFor(async () => {
      await expect(statusGet!({ handoffId })).resolves.toMatchObject({
        handoffId,
        status: expect.objectContaining({
          status: 'awaiting_recovery',
          transportStrategy: 'server_routed_stream',
        }),
      });
    });

    expect(importSessionBundle).toHaveBeenCalledTimes(1);
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

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
    expect(prepare).toBeDefined();

    const handoffId = 'handoff_invalid_server_routed_workspace_manifest_format';
    const agentBundleTransferId = `session-handoff:${handoffId}:provider-bundle-file`;
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

    const providerRecipientPublicKeyBase64 = await expectOpenEnvelopeWithRecipient(sendEnvelope, agentBundleTransferId);

    // Provide a valid provider bundle so the prepare flow reaches manifest fetch.
    const agentBundlePayload = Buffer.from(JSON.stringify({
      agentId: 'claude',
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
        transferId: agentBundleTransferId,
        kind: 'chunk',
        sequence: 0,
        ...createEncryptedTransferChunkEnvelope({
          transferId: agentBundleTransferId,
          sequence: 0,
          payload: agentBundlePayload,
          recipientPublicKeyBase64: providerRecipientPublicKeyBase64,
          randomBytes: (length) => new Uint8Array(length).fill(11),
        }),
      },
    });
    dispatchEnvelope({
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      envelope: {
        transferId: agentBundleTransferId,
        kind: 'finish',
        manifestHash: `sha256:${createHash('sha256').update(agentBundlePayload).digest('hex')}`,
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

	    const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
	    expect(statusGet).toBeDefined();

	    // Depending on whether the prepare job completes within the fast-path window, the handler may:
	    // - throw immediately (fast-path completion), or
	    // - return {status:'pending'} and require the caller to poll status_get.
	    let prepared: any | null = null;
	    let prepareError: unknown = null;
	    try {
	      prepared = await preparePromise;
	    } catch (error) {
	      prepareError = error;
	    }

	    if (prepareError) {
	      expect(String((prepareError as any)?.message ?? prepareError)).toMatch(/workspace replication manifest/i);
	    } else {
	      expect(prepared?.status?.status).toBe('pending');
	    }

	    await vi.waitFor(async () => {
	      const latest = await statusGet!({ handoffId });
	      expect(latest?.status?.status).toBe('awaiting_recovery');
	    }, { timeout: 2000 });

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
        agentBundle: {
          agentId: 'claude',
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
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
    expect(started.endpointCandidates.length).toBeGreaterThan(0);
    expect(started.endpointCandidates).toEqual(
      started.handoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates,
    );
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
        agentId: 'claude',
        remoteSessionId: 'claude_session_source',
        transcriptBase64: 'e30K',
      },
      '/repo',
      'persisted',
    );

	    const commit = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3);
	    expect(commit).toBeDefined();
	    await commit!({ handoffId: started.handoffId });
	    await expect(access(publishedPayloadSource.filePath)).resolves.toBeUndefined();
	  });

  it('acknowledges deferred cross-daemon direct-peer start without workspace transfer and prepares via direct-peer only', async () => {

    const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-cross-daemon-no-workspace-source-'));
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-cross-daemon-no-workspace-source-server-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-cross-daemon-no-workspace-target-server-'));
    const targetPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-cross-daemon-no-workspace-target-workspace-'));

    const sourceRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const targetRegistered = new Map<string, (params: unknown) => Promise<any>>();
    const published = await createPublishedDirectPeerPayloadRouter();
    const transferChannels = createLoopbackMachineTransferChannels();
    const importSessionBundle = vi.fn(async () => ({
      remoteSessionId: 'claude_session_target',
      directSource: {
        kind: 'claudeConfig' as const,
        configDir: null,
        projectId: null,
      },
      resume: buildClaudeResumePlan({
        directory: targetPath,
        resume: 'claude_session_target',
        transcriptStorage: 'persisted',
      }),
    }));
    const serverRoutedTransferSpy = vi.spyOn(
      await import('../../../machines/transfer/serverRoutedTransport'),
      'requestServerRoutedTransferToFile',
    );

    try {
      const registerSourceHandlers = createRegisterHandlers({
            activeServerDir: sourceActiveServerDir,
            activeServerId: 'test_direct_peer_cross_daemon_no_workspace_source',
          });
      registerSourceHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            sourceRegistered.set(method, handler);
          },
        } as any,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle: async () => ({
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
        }),
        directPeerTransfer: {
          publishTransfer: published.publishTransfer,
          requestPayloadFile: published.requestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        } as any,
        machineTransferChannel: transferChannels.source,
      });

      const registerTargetHandlers = createRegisterHandlers({
            activeServerDir: targetActiveServerDir,
            activeServerId: 'test_direct_peer_cross_daemon_no_workspace_target',
          });
      registerTargetHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            targetRegistered.set(method, handler);
          },
        } as any,
        importSessionBundle,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile: published.requestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        } as any,
        machineTransferChannel: transferChannels.target,
      });

      const start = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_direct_peer_cross_daemon_prepare_no_workspace',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        negotiatedTransportStrategy: 'direct_peer',
      });

      expect(started.status.status).toBe('pending');
      expect(started.endpointCandidates.length).toBeGreaterThan(0);
      expect(started.handoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates?.length ?? 0).toBeGreaterThan(0);
      expect(started.handoffMetadataV2?.workspaceReplicationManifestTransferPublication).toBeUndefined();
      expect(started.handoffMetadataV2?.workspaceReplicationSourceRootPath).toBeUndefined();

      let prepared = await prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        allowServerRoutedFallback: false,
        sourceSessionStorageMode: 'persisted',
        targetPath,
        endpointCandidates: started.endpointCandidates,
        ...(started.handoffMetadataV2 ? { handoffMetadataV2: started.handoffMetadataV2 } : {}),
      });

      if (prepared.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          prepared = await resultGet!({ handoffId: started.handoffId });
          expect(prepared.status.status).toBe('ready_for_cutover');
        }, { timeout: 10_000 });
      }

      expect(prepared.status.transportStrategy).toBe('direct_peer');
      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          agentId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        prepared.resume.directory,
        'persisted',
      );
      expect(published.requestPayloadFile).toHaveBeenCalled();
      expect(serverRoutedTransferSpy).not.toHaveBeenCalled();
    } finally {
      serverRoutedTransferSpy.mockRestore();
      await published.dispose();
      await rm(sourcePath, { recursive: true, force: true }).catch(() => undefined);
      await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('completes a non-deferred cross-daemon direct-peer workspace prepare without server-routed fallback', async () => {

    const sourcePath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-cross-daemon-source-'));
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-cross-daemon-source-server-'));
    const targetActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-cross-daemon-target-server-'));
    const targetPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-direct-peer-cross-daemon-target-workspace-'));
    await writeFile(join(sourcePath, 'README.md'), 'cross-daemon direct-peer\n', 'utf8');

    const workspaceTransfer = {
      enabled: true as const,
      strategy: 'sync_changes' as const,
      conflictPolicy: 'replace_existing' as const,
      includeIgnoredMode: 'exclude' as const,
      ignoredIncludeGlobs: [],
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
    const published = await createPublishedDirectPeerPayloadRouter();

    try {
      const registerSourceHandlers = createRegisterHandlers({
            activeServerDir: sourceActiveServerDir,
            activeServerId: 'test_direct_peer_cross_daemon_source',
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });
      registerSourceHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            sourceRegistered.set(method, handler);
          },
        } as any,
        loadSessionMetadata: async () => ({
          machineId: 'machine_source',
          path: sourcePath,
          flavor: 'claude',
          claudeSessionId: 'claude_session_source',
        }),
        exportSessionBundle: async () => ({
          agentBundle: {
            agentId: 'claude',
            remoteSessionId: 'claude_session_source',
            transcriptBase64: 'e30K',
          },
          targetPath: sourcePath,
        }),
        directPeerTransfer: {
          publishTransfer: published.publishTransfer,
          requestPayloadFile: published.requestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        } as any,
      });

      const registerTargetHandlers = createRegisterHandlers({
            activeServerDir: targetActiveServerDir,
            activeServerId: 'test_direct_peer_cross_daemon_target',
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });
      registerTargetHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<any>) => {
            targetRegistered.set(method, handler);
          },
        } as any,
        importSessionBundle,
        directPeerTransfer: {
          publishTransfer: vi.fn(() => []),
          requestPayloadFile: published.requestPayloadFile,
          clearPublishedTransfer: vi.fn(),
        } as any,
      });

      const start = sourceRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
      const prepare = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const resultGet = targetRegistered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3);
      expect(start).toBeDefined();
      expect(prepare).toBeDefined();
      expect(resultGet).toBeDefined();

      const started = await start!({
        sessionId: 'sess_direct_peer_cross_daemon_prepare',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        sessionStorageMode: 'persisted',
        preferredTransportStrategies: ['direct_peer'],
        negotiatedTransportStrategy: 'direct_peer',
        workspaceTransfer,
      });

      expect(started.endpointCandidates.length).toBeGreaterThan(0);
      expect(started.handoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates?.length ?? 0).toBeGreaterThan(0);
      expect(started.handoffMetadataV2?.workspaceReplicationManifestTransferPublication?.endpointCandidates?.length ?? 0).toBeGreaterThan(0);

      let prepared = await prepare!({
        handoffId: started.handoffId,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        allowServerRoutedFallback: false,
        sourceSessionStorageMode: 'persisted',
        targetPath,
        endpointCandidates: started.endpointCandidates,
        workspaceTransfer,
        ...(started.handoffMetadataV2 ? { handoffMetadataV2: started.handoffMetadataV2 } : {}),
      });

      if (prepared.status.status !== 'ready_for_cutover') {
        await vi.waitFor(async () => {
          prepared = await resultGet!({ handoffId: started.handoffId });
          expect(prepared.status.status).toBe('ready_for_cutover');
        }, { timeout: 10_000 });
      }

      expect(prepared.status.transportStrategy).toBe('direct_peer');
      expect(importSessionBundle).toHaveBeenCalledWith(
        {
          agentId: 'claude',
          remoteSessionId: 'claude_session_source',
          transcriptBase64: 'e30K',
        },
        prepared.resume.directory,
        'persisted',
      );
    } finally {
      await published.dispose();
      await rm(sourcePath, { recursive: true, force: true }).catch(() => undefined);
      await rm(sourceActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetActiveServerDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when a source export carries conflicting canonical and deployed-compat agent identities', async () => {
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
        agentBundle: {
          agentId: 'codex',
          providerId: 'claude',
          remoteSessionId: 'thread_legacy',
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

    const start = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3);
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

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      expect(prepare).toBeDefined();
      expect(statusGet).toBeDefined();

      const prepared = await prepare!({
        handoffId: 'handoff_invalid_direct_peer_payload',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          agentBundleTransferPublication: {
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
      });

      expect(prepared).toMatchObject({
        handoffId: 'handoff_invalid_direct_peer_payload',
        status: expect.objectContaining({
          status: 'pending',
          transportStrategy: 'direct_peer',
        }),
      });

      await vi.waitFor(async () => {
        await expect(statusGet!({ handoffId: 'handoff_invalid_direct_peer_payload' })).resolves.toMatchObject({
          handoffId: 'handoff_invalid_direct_peer_payload',
          status: expect.objectContaining({
            status: 'awaiting_recovery',
            transportStrategy: 'direct_peer',
          }),
        });
      });

      expect(importSessionBundle).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it('fails closed when provider-specific direct-peer bundle validation rejects the payload', async () => {
    const registered = new Map<string, (params: unknown) => Promise<any>>();
    const { requestPayloadFile, dispose } = await createDirectPeerRequestPayloadFile({
      payload: Buffer.from(JSON.stringify({
        agentId: 'claude',
        remoteSessionId: 'claude_session_source',
      }), 'utf8'),
    });
    const importSessionBundle = vi.fn(async () => {
      throw new Error('Invalid Claude session handoff bundle');
    });
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

      const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
      const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
      expect(prepare).toBeDefined();
      expect(statusGet).toBeDefined();

      const prepared = await prepare!({
        handoffId: 'handoff_invalid_direct_peer_workspace_artifacts',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        negotiatedTransportStrategy: 'direct_peer',
        sourceSessionStorageMode: 'persisted',
        targetPath: '/repo',
        handoffMetadataV2: {
          agentBundleTransferPublication: {
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
      });

      expect(prepared).toMatchObject({
        handoffId: 'handoff_invalid_direct_peer_workspace_artifacts',
        status: expect.objectContaining({
          status: 'pending',
          transportStrategy: 'direct_peer',
        }),
      });

      await vi.waitFor(async () => {
        await expect(statusGet!({ handoffId: 'handoff_invalid_direct_peer_workspace_artifacts' })).resolves.toMatchObject({
          handoffId: 'handoff_invalid_direct_peer_workspace_artifacts',
          status: expect.objectContaining({
            status: 'awaiting_recovery',
            transportStrategy: 'direct_peer',
          }),
        });
      });

      expect(importSessionBundle).toHaveBeenCalledTimes(1);
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

    const prepare = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3);
    const statusGet = registered.get(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3);
    expect(prepare).toBeDefined();
    expect(statusGet).toBeDefined();

    const prepared = await prepare!({
      handoffId: 'handoff_direct_peer_forbidden_fallback',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      negotiatedTransportStrategy: 'direct_peer',
      allowServerRoutedFallback: false,
      sourceSessionStorageMode: 'persisted',
      targetPath: '/repo',
      handoffMetadataV2: {
        agentBundleTransferPublication: {
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
    });

    expect(prepared).toMatchObject({
      handoffId: 'handoff_direct_peer_forbidden_fallback',
      status: expect.objectContaining({
        status: 'pending',
        transportStrategy: 'direct_peer',
      }),
    });

    await vi.waitFor(async () => {
      await expect(statusGet!({ handoffId: 'handoff_direct_peer_forbidden_fallback' })).resolves.toMatchObject({
        handoffId: 'handoff_direct_peer_forbidden_fallback',
        status: expect.objectContaining({
          status: 'awaiting_recovery',
          transportStrategy: 'direct_peer',
        }),
      });
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
	    const registerSourceHandlers = createRegisterHandlers({
	        activeServerDir: sourceActiveServerDir,
	        activeServerId: 'test_corrupt_source_export',
	      });

	    try {
	      registerSourceHandlers({
	        rpcHandlerManager: {
	          registerHandler: () => {},
	        } as any,
	        machineTransferChannel: channels.source,
	      });

	      const transferId = buildSessionHandoffAgentBundleTransferId(handoffId);
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
	      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	    }
	  }, 30_000);

	  it('surfaces deferred source-export terminal failures as a structured machine transfer abort (no misleading transfer_not_found)', async () => {
	    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-terminal-source-export-'));
	    const handoffId = 'handoff_terminal_source_export';

	    const channels = createLoopbackMachineTransferChannels();
	    const registerSourceHandlers = createRegisterHandlers({
	        activeServerDir: sourceActiveServerDir,
	        activeServerId: 'test_terminal_source_export',
	        filesTransferSessionTtlMs: 50,
	      });

	    try {
	      const { createSessionHandoffSourceExportStore } = await import('../../../session/handoff/state/sessionHandoffSourceExportStore');
	      const { createSessionHandoffPrepareTargetJobStore } = await import('../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore');
	      const { buildSessionHandoffWorkspaceManifestTransferId } = await import(
	        '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted',
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
	      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	    }
		  }, 30_000);

      it('aborts server-routed workspace blob-pack transfers with workspace_replication_source_error when the persisted manifest cannot be loaded', async () => {
        const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wsrepl-manifest-corrupt-source-export-'));
        const handoffId = 'handoff_wsrepl_manifest_corrupt';

        const channels = createLoopbackMachineTransferChannels();
        const registerSourceHandlers = createRegisterHandlers({
            activeServerDir: sourceActiveServerDir,
            activeServerId: 'test_wsrepl_manifest_corrupt',
            filesTransferSessionTtlMs: 10 * 60_000,
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });

        try {
          const { requestServerRoutedTransferToFile } = await import('../../../machines/transfer/serverRoutedTransport');
          const { createSessionHandoffSourceExportStore } = await import('../../../session/handoff/state/sessionHandoffSourceExportStore');
          const { createWorkspaceReplicationPackIdForDigests } = await import('@/workspaces/replication/transport/workspaceReplicationPackId');
          const { buildSessionHandoffWorkspaceBlobPackTransferId } = await import(
            '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted',
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
          await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }, 30_000);

      it('aborts server-routed workspace blob-pack transfers with workspace_replication_source_error when the source workspace root cannot supply required blobs', async () => {
        const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wsrepl-missing-blob-source-export-'));
        const sourceRootPath = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wsrepl-missing-blob-workspace-'));
        const handoffId = 'handoff_wsrepl_missing_blob';

        const channels = createLoopbackMachineTransferChannels();
        const registerSourceHandlers = createRegisterHandlers({
            activeServerDir: sourceActiveServerDir,
            activeServerId: 'test_wsrepl_missing_blob',
            filesTransferSessionTtlMs: 10 * 60_000,
            workspaceReplicationBlobPackTargetBytes: 4 * 1024 * 1024,
            workspaceReplicationBlobPackMaxBlobs: 64,
            workspaceReplicationBlobPackMaxSingleBlobBytes: 16 * 1024 * 1024,
          });

        try {
          const { requestServerRoutedTransferToFile } = await import('../../../machines/transfer/serverRoutedTransport');
          const { createSessionHandoffSourceExportStore } = await import('../../../session/handoff/state/sessionHandoffSourceExportStore');
          const { createWorkspaceReplicationPackIdForDigests } = await import('@/workspaces/replication/transport/workspaceReplicationPackId');
          const { buildSessionHandoffWorkspaceBlobPackTransferId } = await import(
            '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted',
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
          await rm(sourceRootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }, 30_000);

	  it('waits for a deferred source-export record before serving the server-routed provider-bundle transfer (avoids transfer_not_found)', async () => {
	    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-wait-source-export-'));
	    const handoffId = 'handoff_wait_source_export';

      const channels = createLoopbackMachineTransferChannels();
      const registerSourceHandlers = createRegisterHandlers({
          activeServerDir: sourceActiveServerDir,
          activeServerId: 'test_wait_source_export',
          // Intentionally small: the responder must not clamp its deferred source-export wait to
          // the app↔daemon transfer "session TTL". It must be bounded by the server-routed machine
          // transfer timeout instead, or large exports will abort with `transfer_not_found`.
          filesTransferSessionTtlMs: 30_000,
        });

      try {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const { createSessionHandoffSourceExportStore } = await import('../../../session/handoff/state/sessionHandoffSourceExportStore');
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
            const persistedAgentBundle = await sourceExportStore.writeAgentBundleFile({
              handoffId,
              agentBundle: {
                agentId: 'claude',
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
              agentBundle: persistedAgentBundle,
            });
          })().then(writeDeferred.resolve, writeDeferred.reject);
        }, scheduledWriteDelayMs);

        const transferId = buildSessionHandoffAgentBundleTransferId(handoffId);
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
          const parsedAgentBundle = await readSessionHandoffAgentBundleFile(received.destinationPath);
          expect(parsedAgentBundle.agentId).toEqual('claude');
        } finally {
          await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      } finally {
        vi.useRealTimers();
        await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
	    }, 60_000);

  it('serves a persisted binary artifact through the server-routed transfer without source file references', async () => {
    const sourceActiveServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-binary-'));
    const sourceDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-source-'));
    const targetDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-server-routed-target-'));
    const handoffId = 'handoff_server_routed_binary';
    const sourcePath = join(sourceDirectory, 'rollout.jsonl');
    const sourceContents = Buffer.alloc(5 * 1024 * 1024, 0x62);

    try {
      await writeFile(sourcePath, sourceContents);
      const channels = createLoopbackMachineTransferChannels();
      const registerSourceHandlers = createRegisterHandlers({
        activeServerDir: sourceActiveServerDir,
        activeServerId: 'test_server_routed_binary',
      });
      registerSourceHandlers({
        rpcHandlerManager: {
          registerHandler: () => {},
        } as any,
        machineTransferChannel: channels.source,
      });

      const sourceExportStore = createSessionHandoffSourceExportStore({ activeServerDir: sourceActiveServerDir });
      const persistedAgentBundle = await sourceExportStore.writeAgentBundleFile({
        handoffId,
        agentBundle: {
          agentId: 'codex',
          remoteSessionId: 'remote-session-large',
          files: [{
            relativePath: 'sessions/rollout.jsonl',
            contentFile: {
              t: 'happier.handoff.file.v1',
              filePath: sourcePath,
              offsetBytes: 0,
              sizeBytes: sourceContents.length,
            },
          }],
        },
      });
      await sourceExportStore.save({
        handoffId,
        sessionId: 'session_test',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        exportedAtMs: Date.now(),
        workspaceSourceRootPath: '/repo',
        agentBundle: persistedAgentBundle,
      });

      const destinationPath = join(targetDirectory, 'agent-bundle.bin');
      const received = await requestServerRoutedTransferToFile({
        transferId: buildSessionHandoffAgentBundleTransferId(handoffId),
        sourceMachineId: 'machine_source',
        machineTransferChannel: channels.target,
        destinationPath,
        timeoutMs: 30_000,
      });

      expect(received.sizeBytes).toBe(persistedAgentBundle.sizeBytes);
      expect(received.sizeBytes).toBeGreaterThan(sourceContents.length);
      expect(received.sizeBytes).toBeLessThan(sourceContents.length + 64 * 1024);

      await rm(sourceDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

      const transferredBundle = await readSessionHandoffAgentBundleFile(destinationPath);
      const contentFile = (transferredBundle.files as Array<{ contentFile?: {
        filePath: string;
        offsetBytes: number;
        sizeBytes: number;
      } }>)[0]?.contentFile;
      expect(contentFile).toEqual(expect.objectContaining({
        filePath: destinationPath,
        sizeBytes: sourceContents.length,
      }));
      if (!contentFile) throw new Error('Expected a materialized handoff file');

      const transferredArtifact = await open(destinationPath, 'r');
      try {
        const sample = Buffer.alloc(64);
        const { bytesRead } = await transferredArtifact.read(sample, 0, sample.length, contentFile.offsetBytes);
        expect(bytesRead).toBe(sample.length);
        expect(sample.equals(sourceContents.subarray(0, sample.length))).toBe(true);
      } finally {
        await transferredArtifact.close();
      }
    } finally {
      await rm(targetDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(sourceDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(sourceActiveServerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60_000);
		});
