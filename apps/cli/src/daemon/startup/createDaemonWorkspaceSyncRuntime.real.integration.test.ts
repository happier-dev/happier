import {
  ActionApprovalRequestCreatedResultSchema,
  ApprovalRequestSchema,
  deriveWorkspaceSyncConflictAsidePaths,
  WorkspaceSyncConflictResolutionResultV1Schema,
  createActionExecutor,
  type ActionExecutorDeps,
  type ApprovalRequest,
  type WorkspaceSyncConflictResolveActionInputV1,
  type WorkspaceSyncConflictResolutionResultV1,
  type WorkspaceSyncEntryExpectationV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  MUTAGEN_ENGINE_VERSION,
  assertMutagenEngineArtifactPayload,
  ensureInstalledFirstPartyComponent,
  resolveMutagenEngineArtifactPaths,
  resolveMutagenEngineArtifactTarget,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyCapturedWorkspaceSyncEntryAtRoot, captureWorkspaceSyncEntryAtRoot, recoverWorkspaceSyncEntryReplacementAtRoot } from '@/workspaces/sync/workspaceSyncConflicts';
import { observeWorkspaceSyncEntryAtRoot } from '@/workspaces/sync/workspaceSyncFileRead';
import {
  discoverNativeConfinedWorkspaceSyncRecovery,
  runNativeConfinedWorkspaceSyncApply,
  runNativeConfinedWorkspaceSyncRecover,
} from '@/workspaces/sync/workspaceSyncNativeConfinedFileSystem';
import {
  registerMachineWorkspaceSyncRpcHandlers,
  type MachineWorkspaceSyncRpcService,
} from '@/api/machine/rpcHandlers.workspaceSync';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { createWorkspaceSyncTargetAuthority } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import type {
  FiniteTransferMachineTunnel,
  WorkspaceSyncMachineTunnel,
  WorkspaceSyncMachineTunnelOpen,
  WorkspaceSyncMachineTunnelOpenInput,
} from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import type { WorkspaceSyncSidecarProcess } from '@/workspaces/sync/workspaceSyncSidecarLifecycle';
import { createWorkspaceSyncPeerIdentityValidator } from '@/workspaces/sync/transport/workspaceSyncPeerIdentity';
import { computeWorkspaceSyncPolicyDigest } from '@/workspaces/sync/workspaceSyncTypes';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { prepareWorkspaceSyncBetween } from '@/workspaces/sync/workspaceSyncPreparation';
import { createWorkspaceSyncConflictResolutionAuthorizer } from './createProductionDaemonWorkspaceSyncRuntime';
import type {
  WorkspaceSyncPersistentModeV1,
  WorkspaceSyncRelationshipV1,
} from '@/workspaces/sync/workspaceSyncTypes';
import { createDaemonWorkspaceSyncBroker } from './createDaemonWorkspaceSyncBroker';
import { createDaemonWorkspaceSyncRuntime, type DaemonWorkspaceSyncRuntime, type DaemonWorkspaceSyncRuntimeDependencies } from './createDaemonWorkspaceSyncRuntime';
import {
  launchWorkspaceSyncLocalAgent,
  spawnWorkspaceSyncSidecar,
} from './workspaceSyncNativeProcessLaunchers';

const managerPath = process.env.HAPPIER_MUTAGEN_LIVE_MANAGER_BIN;
const agentPath = process.env.HAPPIER_MUTAGEN_LIVE_AGENT_BIN;
const custodyPath = process.env.HAPPIER_PROCESS_CUSTODY_LIVE_BIN;
const runInstalledArtifactIntegration = process.env.HAPPIER_RUN_MUTAGEN_INSTALLED_ARTIFACT_INTEGRATION === '1';
const runPerformanceAcceptance = process.env.HAPPIER_RUN_WORKSPACE_SYNC_PERFORMANCE === '1';
const performanceFileSizeBytes = Number.parseInt(
  process.env.HAPPIER_WORKSPACE_SYNC_PERFORMANCE_FILE_BYTES ?? String(1024 ** 3),
  10,
);
const performanceDeltaBytes = 4 * 1024;

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

async function writeDeterministicFile(path: string, sizeBytes: number): Promise<void> {
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  for (let index = 0; index < chunk.length; index += 1) chunk[index] = index % 251;
  const handle = await open(path, 'w');
  try {
    let offset = 0;
    while (offset < sizeBytes) {
      const length = Math.min(chunk.length, sizeBytes - offset);
      await handle.write(chunk, 0, length, offset);
      offset += length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function applyDeterministicDelta(
  path: string,
  sizeBytes: number,
): Promise<Readonly<{ offset: number; bytes: Buffer }>> {
  const delta = Buffer.alloc(performanceDeltaBytes, 0xa7);
  const offset = Math.max(0, Math.floor(sizeBytes / 2) - Math.floor(delta.length / 2));
  const handle = await open(path, 'r+');
  try {
    await handle.write(delta, 0, delta.length, offset);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { offset, bytes: delta };
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveDigest, rejectDigest) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolveDigest);
    stream.once('error', rejectDigest);
  });
  return hash.digest('hex');
}

async function waitForFileDigest(
  path: string,
  expectedSizeBytes: number,
  expectedDigest: string,
  description: string,
  deadlineMs = 20 * 60_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastSize = -1;
  let lastDigest = '';
  while (Date.now() < deadline) {
    const metadata = await stat(path).catch(() => null);
    lastSize = metadata?.size ?? -1;
    if (lastSize === expectedSizeBytes) {
      lastDigest = await digestFile(path);
      if (lastDigest === expectedDigest) return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${description}; size=${lastSize}; digest=${lastDigest}`);
}

async function waitForFileRegion(
  path: string,
  offset: number,
  expected: Buffer,
  description: string,
  deadlineMs = 20 * 60_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  const observed = Buffer.alloc(expected.length);
  while (Date.now() < deadline) {
    const handle = await open(path, 'r').catch(() => null);
    if (handle) {
      try {
        const { bytesRead } = await handle.read(observed, 0, observed.length, offset);
        if (bytesRead === expected.length && observed.equals(expected)) return;
      } finally {
        await handle.close();
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function recordPerformanceMeasurement(measurement: Readonly<Record<string, string | number>>): void {
  console.info(`[workspace-sync-performance] ${JSON.stringify(measurement)}`);
}

/**
 * The source-built lane fails closed: when the live lane runs without the
 * three source-built executables the suite must fail, never silently skip.
 */
async function requireLiveBinaries(): Promise<{
  manager: string;
  agent: string;
  custody: string;
}> {
  if (!managerPath || !agentPath || !custodyPath) {
    throw new Error(
      'live binaries must be supplied for the source-built integration lane: set '
      + 'HAPPIER_MUTAGEN_LIVE_MANAGER_BIN, HAPPIER_MUTAGEN_LIVE_AGENT_BIN, and '
      + 'HAPPIER_PROCESS_CUSTODY_LIVE_BIN to freshly built executables',
    );
  }
  const verified = {
    manager: resolve(managerPath),
    agent: resolve(agentPath),
    custody: resolve(custodyPath),
  };
  await Promise.all([
    access(verified.manager),
    access(verified.agent),
    access(verified.custody),
  ]);
  return verified;
}

async function acquireInstalledArtifactBinaries(homeDir: string): Promise<Readonly<{
  manager: string;
  agent: string;
  custody: string;
  targetTriple: string;
}>> {
  if (!custodyPath) {
    throw new Error(
      `installed Mutagen ${MUTAGEN_ENGINE_VERSION} integration requires HAPPIER_PROCESS_CUSTODY_LIVE_BIN`,
    );
  }
  const custody = resolve(custodyPath);
  await access(custody);
  const targetTriple = resolveMutagenEngineArtifactTarget();
  const processEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir };
  const validatePayload = (payloadRoot: string) => assertMutagenEngineArtifactPayload({
    payloadRoot,
    targetTriple,
    engineVersion: MUTAGEN_ENGINE_VERSION,
  });
  const installed = await ensureInstalledFirstPartyComponent({
    componentId: 'mutagen-engine',
    channel: 'stable',
    versionId: MUTAGEN_ENGINE_VERSION,
    processEnv,
    validatePayload,
  });
  const payloadRoot = installed.resolvedCurrentPath ?? installed.currentPath;
  await validatePayload(payloadRoot);
  const artifactPaths = resolveMutagenEngineArtifactPaths(payloadRoot, targetTriple);
  await Promise.all([access(artifactPaths.managerPath), access(artifactPaths.agentPath)]);
  return {
    manager: artifactPaths.managerPath,
    agent: artifactPaths.agentPath,
    custody,
    targetTriple,
  };
}

type ObservedContent = string | null;

async function waitFor(
  path: string,
  predicate: (content: ObservedContent) => boolean,
  description: string,
  deadlineMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let last: ObservedContent = null;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    last = await readFile(path, 'utf8').then(
      (content) => content as ObservedContent,
      (error: unknown) => {
        lastError = error;
        return null;
      },
    );
    if (predicate(last)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(
    `Timed out waiting for ${description} at ${path}; last=${JSON.stringify(last)}`
    + (lastError instanceof Error ? `; lastError=${lastError.message}` : ''),
  );
}

function waitForContents(path: string, expected: string, description = 'synchronized contents'): Promise<void> {
  return waitFor(path, (content) => content === expected, description);
}

function waitForAbsent(path: string, description: string, deadlineMs = 30_000): Promise<void> {
  return waitFor(path, (content) => content === null, description, deadlineMs);
}

/** Bounded negative window: no relationship exists that could still propagate. */
async function assertStillAbsent(path: string, windowMs = 1_500): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await waitForAbsent(path, 'file to stay absent during the finite-copy window', windowMs);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  await expect(access(path)).rejects.toThrow();
}

const contentPolicy = Object.freeze({
  v: 1 as const,
  selection: 'all_files' as const,
  extraIgnorePatterns: [] as const,
  extraIncludePatterns: [] as const,
});

function liveRelationship(input: Readonly<{
  relationshipId: string;
  mode: WorkspaceSyncPersistentModeV1;
}>): WorkspaceSyncRelationshipV1 {
  return {
    v: 1,
    relationshipId: input.relationshipId,
    controllerMachineId: 'local-machine',
    alphaWorkspaceRefId: 'alpha-ref',
    betaWorkspaceRefId: 'beta-ref',
    mode: input.mode,
    contentPolicy: {
      ...contentPolicy,
      policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicy),
    },
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

type LiveConflictApprovalAuthority = Readonly<{
  assertAuthorized: ReturnType<typeof createWorkspaceSyncConflictResolutionAuthorizer>;
  approvalsCreate: NonNullable<ActionExecutorDeps['approvalsCreate']>;
  approvalsGet: NonNullable<ActionExecutorDeps['approvalsGet']>;
  approvalsUpdate: NonNullable<ActionExecutorDeps['approvalsUpdate']>;
}>;

function createLiveConflictApprovalAuthority(artifactDirectory: string): LiveConflictApprovalAuthority {
  let nextArtifactId = 1;
  const artifactPath = (artifactId: string): string => {
    if (!/^[A-Za-z0-9._-]+$/.test(artifactId)) throw new Error('Invalid live approval artifact id');
    return join(artifactDirectory, `${artifactId}.json`);
  };
  const approvalsGet: NonNullable<ActionExecutorDeps['approvalsGet']> = async ({ artifactId }) => {
    try {
      const raw = await readFile(artifactPath(artifactId), 'utf8');
      return ApprovalRequestSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const persist = async (artifactId: string, request: ApprovalRequest): Promise<void> => {
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(artifactPath(artifactId), `${JSON.stringify(ApprovalRequestSchema.parse(request))}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  };
  const authority: LiveConflictApprovalAuthority = {
    approvalsCreate: async ({ request }) => {
      const artifactId = `live-conflict-approval-${nextArtifactId++}`;
      await persist(artifactId, request);
      return { artifactId };
    },
    approvalsGet,
    approvalsUpdate: async ({ artifactId, request }) => {
      await persist(artifactId, request);
      return { ok: true };
    },
    assertAuthorized: createWorkspaceSyncConflictResolutionAuthorizer({
      approvalsGet,
      serverId: 'server-1',
    }),
  };
  return authority;
}

describe('workspace sync conflict Action persistence fixture', () => {
  it('reopens the approved receipt from disk at the destructive execution boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hwsa-'));
    const artifactDirectory = join(root, 'approval-artifacts');
    const authority = createLiveConflictApprovalAuthority(artifactDirectory);
    const actionInput: WorkspaceSyncConflictResolveActionInputV1 = {
      controllerMachineId: 'local-machine',
      hubWorkspaceRefId: 'alpha-ref',
      path: 'conflicted.txt',
      source: { workspaceRefId: 'alpha-ref', expected: { kind: 'file', digest: 'a'.repeat(40), executable: false, size: 1 } },
      targets: [{ workspaceRefId: 'beta-ref', expected: { kind: 'file', digest: 'b'.repeat(40), executable: false, size: 1 } }],
      relationshipIds: ['relationship-1'],
      strategy: 'use_source',
    };
    let executedReceiptId: string | null = null;
    try {
      const workspaceSyncConflictResolve: NonNullable<
        ActionExecutorDeps['workspaceSyncConflictResolve']
      > = async ({ actionReceiptId, input }) => {
        const reopenedAuthority = createLiveConflictApprovalAuthority(artifactDirectory);
        await reopenedAuthority.assertAuthorized(actionReceiptId, input);
        executedReceiptId = actionReceiptId;
        return { endpoints: [{ workspaceRefId: 'beta-ref', status: 'applied' as const }] };
      };
      const executor = createActionExecutor({
        workspaceSyncConflictResolve,
        isActionApprovalRequired: () => false,
        approvalsCreate: authority.approvalsCreate,
        approvalsGet: authority.approvalsGet,
        approvalsUpdate: authority.approvalsUpdate,
        isApprovalExecutionOriginCurrent: async () => true,
      } as unknown as ActionExecutorDeps);

      const requested = await executor.execute('workspace.sync.conflict.resolve', actionInput, {
        surface: 'ui',
        authority: 'present_user',
        serverId: 'server-1',
        defaultSessionMachineId: actionInput.controllerMachineId,
        actionRequestId: 'persisted-conflict-request',
      });
      const approvalRequest = requested.ok
        ? ActionApprovalRequestCreatedResultSchema.safeParse(requested.result)
        : null;
      expect(approvalRequest?.success).toBe(true);
      if (!approvalRequest?.success) throw new Error('Workspace conflict Action did not request approval');

      const decided = await executor.execute('approval.request.decide', {
        artifactId: approvalRequest.data.artifactId,
        decision: 'approve',
      }, {
        surface: 'ui',
        authority: 'present_user',
        serverId: 'server-1',
      });
      expect(decided).toMatchObject({
        ok: true,
        result: { ok: true, status: 'executed', execution: { ok: true } },
      });
      expect(executedReceiptId).toBe(approvalRequest.data.artifactId);
      await expect(authority.approvalsGet({
        artifactId: approvalRequest.data.artifactId,
        serverId: 'server-1',
      })).resolves.toMatchObject({ status: 'executed', execution: { ok: true } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function resolveConflictThroughApprovedAction(
  runtime: DaemonWorkspaceSyncRuntime,
  approvalAuthority: LiveConflictApprovalAuthority,
  actionInput: WorkspaceSyncConflictResolveActionInputV1,
): Promise<WorkspaceSyncConflictResolutionResultV1> {
  const handlers = new Map<string, (raw: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
  const rpcHandlerManager = {
    registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
      handlers.set(method, async (raw, context) => await handler(raw as TRequest, context));
    },
  } satisfies RpcHandlerRegistrar;
  const unavailableTargetOperation = async (): Promise<never> => {
    throw new Error('Unexpected target operation in local conflict Action test');
  };
  const service: MachineWorkspaceSyncRpcService = {
    controller: runtime.managedWorkspaceSync,
    prepareBetween: unavailableTargetOperation,
    relationshipOwner: {
      create: unavailableTargetOperation,
      setEnabled: async () => undefined,
      stop: async () => undefined,
    },
    stageConflictResolutionAtTarget: unavailableTargetOperation,
    applyStagedConflictResolutionAtTarget: unavailableTargetOperation,
    recoverConflictResolutionAtTarget: unavailableTargetOperation,
    readFileAtTarget: unavailableTargetOperation,
    observeEntryAtTarget: unavailableTargetOperation,
    preflightHandoffTargetReplacement: unavailableTargetOperation,
    prepareBootstrapAtTarget: unavailableTargetOperation,
    releaseBootstrapAtTarget: unavailableTargetOperation,
    inspectRetiredState: async () => ({ status: 'absent' }),
    assertConflictResolutionAuthorized: approvalAuthority.assertAuthorized,
  };
  registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager, service });
  const conflictResolve = handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE);
  if (!conflictResolve) throw new Error('Workspace conflict resolution RPC was not registered');

  const executor = createActionExecutor({
    workspaceSyncConflictResolve: async ({ actionReceiptId, input }: Parameters<NonNullable<ActionExecutorDeps['workspaceSyncConflictResolve']>>[0]) => await conflictResolve({
      actionReceiptId,
      actionInput: input,
    }) as WorkspaceSyncConflictResolutionResultV1,
    isActionApprovalRequired: () => false,
    approvalsCreate: approvalAuthority.approvalsCreate,
    approvalsGet: approvalAuthority.approvalsGet,
    approvalsUpdate: approvalAuthority.approvalsUpdate,
    isApprovalExecutionOriginCurrent: async () => true,
  } as unknown as ActionExecutorDeps);

  const requested = await executor.execute('workspace.sync.conflict.resolve', actionInput, {
    surface: 'ui',
    authority: 'present_user',
    serverId: 'server-1',
    defaultSessionMachineId: actionInput.controllerMachineId,
    actionRequestId: 'live-conflict-request',
  });
  const approvalRequest = requested.ok
    ? ActionApprovalRequestCreatedResultSchema.safeParse(requested.result)
    : null;
  if (!approvalRequest?.success) {
    throw new Error(`Workspace conflict Action did not request approval: ${JSON.stringify(requested)}`);
  }
  const decided = await executor.execute('approval.request.decide', {
    artifactId: approvalRequest.data.artifactId,
    decision: 'approve',
  }, {
    surface: 'ui',
    authority: 'present_user',
    serverId: 'server-1',
  });
  const decision = decided.ok && decided.result !== null && typeof decided.result === 'object'
    ? decided.result as Record<string, unknown>
    : null;
  if (!decision || decision.ok !== true || decision.status !== 'executed') {
    throw new Error(`Workspace conflict Action approval did not execute: ${JSON.stringify(decided)}`);
  }
  const execution = decision.execution && typeof decision.execution === 'object'
    ? decision.execution as Record<string, unknown>
    : null;
  const result = execution?.result && typeof execution.result === 'object'
    ? execution.result as Record<string, unknown>
    : null;
  const endpoints = Array.isArray(result?.endpoints) ? result.endpoints : null;
  if (!endpoints || endpoints.length !== actionInput.targets.length || endpoints.some((endpoint) => (
    !endpoint || typeof endpoint !== 'object' || !('status' in endpoint)
    || (endpoint.status !== 'applied' && endpoint.status !== 'applied_paused')
  ))) {
    throw new Error(`Workspace conflict Action did not apply reviewed content: ${JSON.stringify(decided)}`);
  }
  return WorkspaceSyncConflictResolutionResultV1Schema.parse(result);
}

async function startLiveRuntime(input: Readonly<{
  root: string;
  binaries: Readonly<{ manager: string; agent: string; custody: string }>;
  relationship: WorkspaceSyncRelationshipV1 | null;
  relationships?: readonly WorkspaceSyncRelationshipV1[];
  remote?: Readonly<{
    localMachineId: string;
    endpointMachineIds: Readonly<{ alpha: string; beta: string; gamma: string }>;
    prepareRelationshipTarget: DaemonWorkspaceSyncRuntimeDependencies['prepareRelationshipTarget'];
    recoverConflictResolutionAtTarget: NonNullable<DaemonWorkspaceSyncRuntimeDependencies['recoverConflictResolutionAtTarget']>;
    openMachineCarrierTunnel: WorkspaceSyncMachineTunnelOpen;
  }>;
  conflictApprovalAuthority?: LiveConflictApprovalAuthority;
  onSidecarSpawned?: (process: WorkspaceSyncSidecarProcess) => void | Promise<void>;
}>): Promise<DaemonWorkspaceSyncRuntime> {
  const alphaRoot = join(input.root, 'alpha');
  const betaRoot = join(input.root, 'beta');
  const gammaRoot = join(input.root, 'gamma');
  const dataRoot = join(input.root, 'daemon');
  await Promise.all([
    mkdir(alphaRoot, { recursive: true }),
    mkdir(betaRoot, { recursive: true }),
    ...(input.relationships ? [mkdir(gammaRoot, { recursive: true })] : []),
  ]);
  const activeRelationships = input.relationships ?? (input.relationship ? [input.relationship] : []);
  const refs = [
    { id: 'alpha-ref', serverId: 'server-1', machineId: input.remote?.endpointMachineIds.alpha ?? 'local-machine', rootPath: alphaRoot, createdAtMs: 1 },
    { id: 'beta-ref', serverId: 'server-1', machineId: input.remote?.endpointMachineIds.beta ?? 'local-machine', rootPath: betaRoot, createdAtMs: 1 },
    ...(input.relationships
      ? [{ id: 'gamma-ref', serverId: 'server-1', machineId: input.remote?.endpointMachineIds.gamma ?? 'local-machine', rootPath: gammaRoot, createdAtMs: 1 }]
      : []),
  ];
  const snapshot = {
    source: 'network' as const,
    workspaceRefs: refs,
    relationships: activeRelationships,
    graphRevision: 1, organizations: [], rows: [],
    loadedAtMs: 1,
    scopeKey: activeRelationships[0]?.relationshipId ?? 'live-copy-once',
  };
  const workspaceRefs = new Map(refs.map(({ id, serverId, machineId, rootPath }) => [id, { serverId, machineId, rootPath }] as const));
  const rootOwnershipManager = createWorkspaceRootOwnershipManager({
    lockDirectory: join(dataRoot, 'root-ownership'),
  });
  const conflictApprovalAuthority = input.conflictApprovalAuthority
    ?? createLiveConflictApprovalAuthority(join(dataRoot, 'approval-artifacts'));
  const resolutionMaterialDirectory = join(dataRoot, 'resolution-material');
  const stagedResolutions = new Map<string, Readonly<{
    targetRoot: string;
    targetExpected: WorkspaceSyncEntryExpectationV1;
    selectedExpectation: WorkspaceSyncEntryExpectationV1;
    materialPath: string | null;
  }>>();
  const requireLocalConflictEndpoint = (workspaceRefId: string, machineId: string): string => {
    const endpoint = workspaceRefs.get(workspaceRefId);
    if (!endpoint || endpoint.machineId !== machineId) {
      throw Object.assign(new Error('Workspace sync conflict endpoint is unavailable'), { code: 'peer_unavailable' });
    }
    return endpoint.rootPath;
  };

  const peerIdentityEvents: string[] = [];
  const runtime = createDaemonWorkspaceSyncRuntime({
    daemonDataRoot: dataRoot,
    localServerId: 'server-1',
    localMachineId: input.remote?.localMachineId ?? 'local-machine',
    releaseChannel: 'publicdev',
    resolveWorkspaceRef: (id) => workspaceRefs.get(id) ?? null,
    rootOwnershipManager,
    // Single-daemon cases start with their roots prepared; the three-machine
    // case calls each spoke's real target authority before manager admission.
    prepareRelationshipTarget: input.remote?.prepareRelationshipTarget ?? (async () => undefined),
    ...(input.remote ? { openMachineCarrierTunnel: input.remote.openMachineCarrierTunnel } : {}),
    bootstrap: async () => ({ release: async () => undefined }),
    observeEntryAtTarget: async (request) => await observeWorkspaceSyncEntryAtRoot({
      rootPath: requireLocalConflictEndpoint(request.targetWorkspaceRefId, request.targetMachineId),
      relativePath: request.path,
    }),
    stageConflictResolutionAtTarget: async (request) => {
      await conflictApprovalAuthority.assertAuthorized(request.actionReceiptId, request.actionInput);
      const sourceRoot = requireLocalConflictEndpoint(request.sourceWorkspaceRefId, request.sourceMachineId);
      const targetRoot = requireLocalConflictEndpoint(request.targetWorkspaceRefId, request.targetMachineId);
      const captured = await captureWorkspaceSyncEntryAtRoot({
        rootPath: sourceRoot,
        relativePath: request.actionInput.path,
        expected: request.sourceExpected,
        captureDirectory: resolutionMaterialDirectory,
        operationId: request.operationId,
      });
      stagedResolutions.set(request.operationId, {
        targetRoot,
        targetExpected: request.targetExpected,
        selectedExpectation: captured.expectation,
        materialPath: captured.materialPath,
      });
    },
    applyStagedConflictResolutionAtTarget: async (request) => {
      await conflictApprovalAuthority.assertAuthorized(request.actionReceiptId, request.actionInput);
      const staged = stagedResolutions.get(request.operationId);
      const targetRoot = requireLocalConflictEndpoint(request.targetWorkspaceRefId, request.targetMachineId);
      if (!staged || staged.targetRoot !== targetRoot) {
        throw Object.assign(new Error('Reviewed workspace resolution was not staged'), { code: 'conflict_changed' });
      }
      return await applyCapturedWorkspaceSyncEntryAtRoot({
        rootPath: targetRoot,
        relativePath: request.path,
        expectedDestination: staged.targetExpected,
        selectedExpectation: staged.selectedExpectation,
        materialPath: staged.materialPath,
        recoveryDirectory: resolutionMaterialDirectory,
        operationId: request.operationId,
      }, {
        runNativeConfinedApply: async (nativeInput) => await runNativeConfinedWorkspaceSyncApply(nativeInput, {
          resolveExecutable: () => input.binaries.custody,
        }),
      });
    },
    recoverConflictResolutionAtTarget: async (request) => {
      if (input.remote && request.targetMachineId !== input.remote.localMachineId) {
        return await input.remote.recoverConflictResolutionAtTarget(request);
      }
      const targetRoot = requireLocalConflictEndpoint(request.targetWorkspaceRefId, request.targetMachineId);
      await mkdir(resolutionMaterialDirectory, { recursive: true });
      const records = await discoverNativeConfinedWorkspaceSyncRecovery(
        { recoveryDirectory: resolutionMaterialDirectory },
        { resolveExecutable: () => input.binaries.custody },
      );
      for (const record of records.filter((candidate) => candidate.rootPath === targetRoot)) {
        const result = await recoverWorkspaceSyncEntryReplacementAtRoot({
          rootPath: targetRoot,
          recoveryDirectory: resolutionMaterialDirectory,
          operationId: record.operationId,
        }, {
          runNativeConfinedRecover: async (nativeInput) => await runNativeConfinedWorkspaceSyncRecover(nativeInput, {
            resolveExecutable: () => input.binaries.custody,
          }),
        });
        if (result.status === 'recovery_needed') return result;
      }
      return { status: 'settled' as const };
    },
    assertConflictResolutionAuthorized: conflictApprovalAuthority.assertAuthorized,
    createBroker: async (brokerInput) => {
      const validator = createWorkspaceSyncPeerIdentityValidator({
        resolveExecutable: () => input.binaries.custody,
      });
      return await createDaemonWorkspaceSyncBroker({
        ...brokerInput,
        openExternalStream: async (context) => await brokerInput.openExternalStream(context).catch((error: unknown) => {
          peerIdentityEvents.push(`open:${error instanceof Error ? error.message : String(error)}:${typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'untyped'}`);
          throw error;
        }),
        peerIdentityValidator: {
          setExpectedSidecarPid: (pid) => {
            peerIdentityEvents.push(`expected:${pid}`);
            validator.setExpectedSidecarPid(pid);
          },
          validate: async (context) => {
            peerIdentityEvents.push(`validate:${context.kind}:${context.sidecarPid ?? 'none'}`);
            const accepted = await validator.validate(context);
            peerIdentityEvents.push(`validated:${context.kind}:${accepted}`);
            return accepted;
          },
        },
      });
    },
    spawnSidecar: async (request) => {
      const process = await spawnWorkspaceSyncSidecar(request);
      await input.onSidecarSpawned?.(process);
      return process;
    },
    launchLocalAgent: launchWorkspaceSyncLocalAgent,
    getProjectSnapshot: () => snapshot,
    subscribeProjectSnapshot: () => () => undefined,
    resolveInstalledComponentPaths: () => ({
      currentPath: input.binaries.manager,
      resolvedCurrentPath: null,
    }),
    resolveArtifactPaths: () => ({
      managerPath: input.binaries.manager,
      agentPath: input.binaries.agent,
    }),
    assertArtifactPayload: () => ({
      engineVersion: 'source-built-live-test',
      protocolEpoch: 'external-stream-v1',
    }),
    resolveDataLayout: () => ({
      rootDir: join(dataRoot, 'mutagen'),
      dataDir: join(dataRoot, 'mutagen', 'data'),
      brokerDir: join(dataRoot, 'mutagen', 'broker'),
    }),
  });

  await runtime.start().catch((error: unknown) => {
    throw new Error(`Live workspace sync startup failed; peer identity events=${peerIdentityEvents.join(',')}`, {
      cause: error,
    });
  });
  return runtime;
}

async function withLiveRuntime(
  input: Readonly<{
    binaries: Readonly<{ manager: string; agent: string; custody: string }>;
    relationship: WorkspaceSyncRelationshipV1 | null;
    prepareRoots?: (roots: Readonly<{ alphaRoot: string; betaRoot: string }>) => Promise<void>;
  }>,
  run: (context: Readonly<{
    runtime: DaemonWorkspaceSyncRuntime;
    alphaRoot: string;
    betaRoot: string;
    root: string;
    conflictApprovalAuthority: LiveConflictApprovalAuthority;
  }>) => Promise<void>,
): Promise<void> {
  // The per-stream broker endpoint also appends a UUID; keep the canonical
  // fixture root below macOS's Unix-domain socket path limit.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hwsl-')));
  let runtime: DaemonWorkspaceSyncRuntime | null = null;
  try {
    const alphaRoot = join(root, 'alpha');
    const betaRoot = join(root, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    await input.prepareRoots?.({ alphaRoot, betaRoot });
    const conflictApprovalAuthority = createLiveConflictApprovalAuthority(join(root, 'approval-artifacts'));
    runtime = await startLiveRuntime({
      root,
      binaries: input.binaries,
      relationship: input.relationship,
      conflictApprovalAuthority,
    });
    await run({
      runtime,
      root,
      alphaRoot,
      betaRoot,
      conflictApprovalAuthority,
    });
  } finally {
    await runtime?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(runInstalledArtifactIntegration)(
  'daemon workspace sync runtime with source-built Mutagen processes',
  { timeout: 150_000 },
  () => {
    it.skipIf(!runPerformanceAcceptance)(
      'records a verified large initial local copy and 4 KiB delta through the real managed process corridor',
      async () => {
        if (!Number.isSafeInteger(performanceFileSizeBytes) || performanceFileSizeBytes < performanceDeltaBytes) {
          throw new Error(`Invalid HAPPIER_WORKSPACE_SYNC_PERFORMANCE_FILE_BYTES=${performanceFileSizeBytes}`);
        }
        const binaries = await requireLiveBinaries();
        let initialWriteMs = 0;
        let initialCopyStartedAt = 0n;
        let initialDigest = '';
        await withLiveRuntime(
          {
            binaries,
            relationship: liveRelationship({ relationshipId: 'live-local-performance', mode: 'keep_synced' }),
            prepareRoots: async ({ alphaRoot }) => {
              const initialWriteStartedAt = process.hrtime.bigint();
              await writeDeterministicFile(join(alphaRoot, 'performance.bin'), performanceFileSizeBytes);
              initialWriteMs = elapsedMs(initialWriteStartedAt);
              initialDigest = await digestFile(join(alphaRoot, 'performance.bin'));
              initialCopyStartedAt = process.hrtime.bigint();
            },
          },
          async ({ alphaRoot, betaRoot }) => {
            const sourcePath = join(alphaRoot, 'performance.bin');
            const targetPath = join(betaRoot, 'performance.bin');
            await waitForFileDigest(targetPath, performanceFileSizeBytes, initialDigest, 'local initial performance copy');
            const initialCopyMs = elapsedMs(initialCopyStartedAt);

            const deltaStartedAt = process.hrtime.bigint();
            const delta = await applyDeterministicDelta(sourcePath, performanceFileSizeBytes);
            await waitForFileRegion(targetPath, delta.offset, delta.bytes, 'local 4 KiB delta region');
            const deltaMs = elapsedMs(deltaStartedAt);
            const deltaDigest = await digestFile(sourcePath);
            await waitForFileDigest(targetPath, performanceFileSizeBytes, deltaDigest, 'local 4 KiB delta');

            recordPerformanceMeasurement({
              topology: 'local',
              fileBytes: performanceFileSizeBytes,
              deltaBytes: performanceDeltaBytes,
              initialWriteMs,
              initialCopyMs,
              deltaMs,
            });
          },
        );
      },
      30 * 60_000,
    );

    it('moves non-empty bytes in both directions through the real manager, authenticated OS broker, controller, and rooted agents', async () => {
      const binaries = await requireLiveBinaries();
      await withLiveRuntime(
        { binaries, relationship: liveRelationship({ relationshipId: 'live-local-byte-path', mode: 'keep_both_in_sync' }) },
        async ({ runtime, alphaRoot, betaRoot }) => {
          await writeFile(join(alphaRoot, 'alpha-to-beta.txt'), 'non-empty alpha payload\n');
          await runtime.managedWorkspaceSync.flush('live-local-byte-path');
          await waitForContents(join(betaRoot, 'alpha-to-beta.txt'), 'non-empty alpha payload\n');

          await writeFile(join(betaRoot, 'beta-to-alpha.txt'), 'non-empty beta payload\n');
          await waitForContents(join(alphaRoot, 'beta-to-alpha.txt'), 'non-empty beta payload\n');

          const status = await runtime.managedWorkspaceSync.get('live-local-byte-path');
          expect(status).toMatchObject({
            relationshipId: 'live-local-byte-path',
            mode: 'keep_both_in_sync',
          });
        },
      );
    });

    it('keeps the second real link running after the first shared-hub link terminates and after restart', async () => {
      const binaries = await requireLiveBinaries();
      const root = await realpath(await mkdtemp(join(tmpdir(), 'hwsl-')));
      const alphaRoot = join(root, 'alpha');
      const betaRoot = join(root, 'beta');
      const gammaRoot = join(root, 'gamma');
      const first = liveRelationship({ relationshipId: 'live-hub-beta', mode: 'keep_both_in_sync' });
      const second = {
        ...liveRelationship({ relationshipId: 'live-hub-gamma', mode: 'keep_both_in_sync' }),
        betaWorkspaceRefId: 'gamma-ref',
      };
      let runtime: DaemonWorkspaceSyncRuntime | null = null;
      try {
        runtime = await startLiveRuntime({ root, binaries, relationship: null, relationships: [first, second] });
        await writeFile(join(alphaRoot, 'shared.txt'), 'initial hub contents\n');
        await Promise.all([
          waitForContents(join(betaRoot, 'shared.txt'), 'initial hub contents\n'),
          waitForContents(join(gammaRoot, 'shared.txt'), 'initial hub contents\n'),
        ]);
        await Promise.all([
          writeFile(join(betaRoot, 'from-beta.txt'), 'beta edit\n'),
          writeFile(join(gammaRoot, 'from-gamma.txt'), 'gamma edit\n'),
        ]);
        await Promise.all([
          waitForContents(join(alphaRoot, 'from-beta.txt'), 'beta edit\n'),
          waitForContents(join(alphaRoot, 'from-gamma.txt'), 'gamma edit\n'),
        ]);
        await rename(join(alphaRoot, 'shared.txt'), join(alphaRoot, 'renamed.txt'));
        await waitForContents(join(gammaRoot, 'renamed.txt'), 'initial hub contents\n');

        await runtime.managedWorkspaceSync.pause(first.relationshipId);
        await writeFile(join(alphaRoot, 'offline-return.txt'), 'hub changed while beta was offline\n');
        await waitForContents(join(gammaRoot, 'offline-return.txt'), 'hub changed while beta was offline\n');
        await assertStillAbsent(join(betaRoot, 'offline-return.txt'));
        await runtime.managedWorkspaceSync.resume(first.relationshipId);
        await waitForContents(join(betaRoot, 'offline-return.txt'), 'hub changed while beta was offline\n');

        await writeFile(join(alphaRoot, 'three-versions.txt'), 'common version\n');
        await Promise.all([
          waitForContents(join(betaRoot, 'three-versions.txt'), 'common version\n'),
          waitForContents(join(gammaRoot, 'three-versions.txt'), 'common version\n'),
        ]);
        await Promise.all([
          runtime.managedWorkspaceSync.pause(first.relationshipId),
          runtime.managedWorkspaceSync.pause(second.relationshipId),
        ]);
        await Promise.all([
          writeFile(join(alphaRoot, 'three-versions.txt'), 'hub version\n'),
          writeFile(join(betaRoot, 'three-versions.txt'), 'beta version\n'),
          writeFile(join(gammaRoot, 'three-versions.txt'), 'gamma version\n'),
        ]);
        await Promise.all([
          runtime.managedWorkspaceSync.resume(first.relationshipId),
          runtime.managedWorkspaceSync.resume(second.relationshipId),
        ]);
        await Promise.all([
          runtime.managedWorkspaceSync.flush(first.relationshipId),
          runtime.managedWorkspaceSync.flush(second.relationshipId),
        ]);
        for (const relationship of [first, second]) {
          const conflicts = await runtime.managedWorkspaceSync.listConflicts({
            relationshipId: relationship.relationshipId,
            limit: 100,
          });
          expect(conflicts.status).toBe('page');
          if (conflicts.status !== 'page') throw new Error('conflict cursor invalidated on initial page');
          expect(conflicts.conflicts.some((entry) => entry.path === 'three-versions.txt')).toBe(true);
        }
        await Promise.all([
          waitForContents(join(alphaRoot, 'three-versions.txt'), 'hub version\n'),
          waitForContents(join(betaRoot, 'three-versions.txt'), 'beta version\n'),
          waitForContents(join(gammaRoot, 'three-versions.txt'), 'gamma version\n'),
        ]);

        await Promise.all([
          writeFile(join(alphaRoot, 'delete-modify.txt'), 'common delete/modify version\n'),
          writeFile(join(alphaRoot, 'structure'), 'common structural version\n'),
        ]);
        await Promise.all([
          waitForContents(join(betaRoot, 'delete-modify.txt'), 'common delete/modify version\n'),
          waitForContents(join(gammaRoot, 'delete-modify.txt'), 'common delete/modify version\n'),
          waitForContents(join(betaRoot, 'structure'), 'common structural version\n'),
          waitForContents(join(gammaRoot, 'structure'), 'common structural version\n'),
        ]);
        await runtime.managedWorkspaceSync.pause(first.relationshipId);
        await rm(join(betaRoot, 'delete-modify.txt'));
        await rm(join(betaRoot, 'structure'));
        await mkdir(join(betaRoot, 'structure'));
        await writeFile(join(betaRoot, 'structure', 'child.txt'), 'beta directory version\n');
        await Promise.all([
          writeFile(join(alphaRoot, 'delete-modify.txt'), 'hub modified version\n'),
          writeFile(join(alphaRoot, 'structure'), 'hub file version\n'),
        ]);
        await Promise.all([
          waitForContents(join(gammaRoot, 'delete-modify.txt'), 'hub modified version\n'),
          waitForContents(join(gammaRoot, 'structure'), 'hub file version\n'),
        ]);
        await runtime.managedWorkspaceSync.resume(first.relationshipId);
        await runtime.managedWorkspaceSync.flush(first.relationshipId);
        const betaConflicts = await runtime.managedWorkspaceSync.listConflicts({
          relationshipId: first.relationshipId,
          limit: 100,
        });
        expect(betaConflicts.status).toBe('page');
        if (betaConflicts.status !== 'page') throw new Error('conflict cursor invalidated on initial page');
        // Mutagen reconciles this delete/modify pair by retaining the modified
        // contents; it does not report a synthetic delete/modify conflict.
        expect(betaConflicts.conflicts.some((entry) => entry.path === 'delete-modify.txt')).toBe(false);
        expect(betaConflicts.conflicts.some((entry) => entry.path === 'structure' || entry.path.startsWith('structure/'))).toBe(true);
        await waitForContents(join(alphaRoot, 'delete-modify.txt'), 'hub modified version\n');
        await waitForContents(join(betaRoot, 'delete-modify.txt'), 'hub modified version\n');
        await waitForContents(join(betaRoot, 'structure', 'child.txt'), 'beta directory version\n');

        await runtime.managedWorkspaceSync.terminate(first.relationshipId);
        await writeFile(join(alphaRoot, 'after-first-stopped.txt'), 'second link remains live\n');
        await waitForContents(join(gammaRoot, 'after-first-stopped.txt'), 'second link remains live\n');
        expect(await stat(join(betaRoot, 'after-first-stopped.txt')).catch(() => null)).toBeNull();

        await runtime.stop();
        runtime = await startLiveRuntime({ root, binaries, relationship: null, relationships: [second] });
        await writeFile(join(gammaRoot, 'after-restart.txt'), 'restarted spoke edit\n');
        await waitForContents(join(alphaRoot, 'after-restart.txt'), 'restarted spoke edit\n');
      } finally {
        await runtime?.stop().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });

    it('runs two hub-to-spoke sessions through separate target authorities and rooted agents', async () => {
      const binaries = await requireLiveBinaries();
      const root = await realpath(await mkdtemp(join(tmpdir(), 'hwsm-')));
      const alphaRoot = join(root, 'alpha');
      const betaRoot = join(root, 'beta');
      const gammaRoot = join(root, 'gamma');
      const machineIds = { alpha: 'machine-a', beta: 'machine-b', gamma: 'machine-c' };
      const first = { ...liveRelationship({ relationshipId: 'remote-hub-beta', mode: 'keep_both_in_sync' }), controllerMachineId: machineIds.alpha };
      const second = {
        ...liveRelationship({ relationshipId: 'remote-hub-gamma', mode: 'keep_both_in_sync' }),
        controllerMachineId: machineIds.alpha,
        betaWorkspaceRefId: 'gamma-ref',
      };
      const relationships = [first, second];
      const targetAgents: Array<Awaited<ReturnType<typeof launchWorkspaceSyncLocalAgent>>> = [];
      await Promise.all([alphaRoot, betaRoot, gammaRoot].map(async (path) => await mkdir(path, { recursive: true })));
      const snapshot = {
        source: 'network' as const,

        workspaceRefs: [
          { id: 'alpha-ref', serverId: 'server-1', machineId: machineIds.alpha, rootPath: alphaRoot, createdAtMs: 1 },
          { id: 'beta-ref', serverId: 'server-1', machineId: machineIds.beta, rootPath: betaRoot, createdAtMs: 1 },
          { id: 'gamma-ref', serverId: 'server-1', machineId: machineIds.gamma, rootPath: gammaRoot, createdAtMs: 1 },
        ],
        relationships: relationships,
        graphRevision: 1, organizations: [], rows: [],
        loadedAtMs: 1,
        scopeKey: 'account-1',
      };
      const createTarget = async (machineId: string) => {
        const home = join(root, machineId);
        const dataDirectory = join(home, 'mutagen', 'data');
        await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
        return createWorkspaceSyncTargetAuthority({
          localServerId: 'server-1',
          localMachineId: machineId,
          getProjectSnapshot: () => snapshot,
          callMachineRpc: async () => { throw new Error('Cross-machine bootstrap RPC was not expected at this local authority'); },
          bootstrap: {
            materializationDirectory: join(home, 'bootstrap'),
            rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(home, 'root-ownership') }),
          },
          resolutionMaterialDirectory: join(home, 'resolution-material'),
          openRootedAgent: async (request) => {
            const agent = await launchWorkspaceSyncLocalAgent({
              executablePath: binaries.agent,
              args: ['synchronizer', '--external', '--root', request.canonicalRoot],
              dataDirectory,
              ...(request.signal ? { signal: request.signal } : {}),
            });
            targetAgents.push(agent);
            return agent;
          },
        });
      };
      const targets = new Map([
        [machineIds.beta, await createTarget(machineIds.beta)],
        [machineIds.gamma, await createTarget(machineIds.gamma)],
      ]);
      const requireTarget = (machineId: string) => {
        const target = targets.get(machineId);
        if (!target) throw new Error(`No target authority for ${machineId}`);
        return target;
      };
      async function openMachineCarrierTunnel(
        request: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'file_transfer' }>,
      ): Promise<FiniteTransferMachineTunnel>;
      async function openMachineCarrierTunnel(
        request: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'workspace_sync' }>,
      ): Promise<WorkspaceSyncMachineTunnel>;
      async function openMachineCarrierTunnel(
        request: WorkspaceSyncMachineTunnelOpenInput,
      ): Promise<FiniteTransferMachineTunnel | WorkspaceSyncMachineTunnel> {
        if (request.flow !== 'workspace_sync') throw new Error('No finite transfer is expected for empty existing targets');
        const ingress = await requireTarget(request.targetMachineId).acquireWorkspaceSyncMachineIngress({
          operationId: request.operationId,
          sourceMachineId: request.sourceMachineId,
          targetMachineId: request.targetMachineId,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        return { localPort: ingress.port, localCapability: ingress.localCapability, observedPath: 'direct', close: ingress.close };
      }
      let runtime: DaemonWorkspaceSyncRuntime | null = null;
      try {
        runtime = await startLiveRuntime({
          root,
          binaries,
          relationship: null,
          relationships,
          remote: {
            localMachineId: machineIds.alpha,
            endpointMachineIds: machineIds,
            prepareRelationshipTarget: async (definition) => {
              const targetMachineId = definition.betaWorkspaceRefId === 'beta-ref' ? machineIds.beta : machineIds.gamma;
              const targetAuthority = requireTarget(targetMachineId);
              await targetAuthority.prepareBootstrapHere({
                v: 1,
                bootstrapOperationId: definition.relationshipId,
                owner: { kind: 'relationship', relationshipId: definition.relationshipId },
                transientRelationship: definition,
                targetWorkspaceRefId: definition.betaWorkspaceRefId,
                endpointRole: 'beta',
                policyDigest: definition.contentPolicy.policyDigest,
                createIfMissing: true,
                targetBootstrap: 'use_existing',
              });
              await targetAuthority.releaseBootstrapHere({
                v: 1,
                bootstrapOperationId: definition.relationshipId,
                targetWorkspaceRefId: definition.betaWorkspaceRefId,
                reason: 'relationship_committed',
              });
            },
            recoverConflictResolutionAtTarget: async (request) => await requireTarget(request.targetMachineId)
              .recoverConflictResolutionHere(request, request.signal),
            openMachineCarrierTunnel,
          },
        });
        await expect(requireTarget(machineIds.beta).acquireWorkspaceSyncMachineIngress({
          operationId: second.relationshipId,
          sourceMachineId: machineIds.alpha,
          targetMachineId: machineIds.beta,
        })).rejects.toMatchObject({ code: 'peer_unavailable' });
        await writeFile(join(alphaRoot, 'hub.txt'), 'hub bytes\n');
        try {
          await Promise.all(relationships.map(async (relationship) => await runtime!.managedWorkspaceSync.flush(relationship.relationshipId)));
        } catch (error) {
          const statuses = await Promise.all(relationships.map(async (relationship) => await runtime!.managedWorkspaceSync.get(relationship.relationshipId)));
          throw new Error(`Remote hub flush failed: ${JSON.stringify(statuses)}`, { cause: error });
        }
        await Promise.all([
          waitForContents(join(betaRoot, 'hub.txt'), 'hub bytes\n'),
          waitForContents(join(gammaRoot, 'hub.txt'), 'hub bytes\n'),
        ]);
        await Promise.all([
          writeFile(join(betaRoot, 'beta.txt'), 'beta bytes\n'),
          writeFile(join(gammaRoot, 'gamma.txt'), 'gamma bytes\n'),
        ]);
        await Promise.all([
          waitForContents(join(alphaRoot, 'beta.txt'), 'beta bytes\n'),
          waitForContents(join(alphaRoot, 'gamma.txt'), 'gamma bytes\n'),
        ]);
        const offlineBeta = requireTarget(machineIds.beta);
        targets.delete(machineIds.beta);
        await offlineBeta.releaseAllRetainedBootstraps();
        const betaCustody = createWorkspaceRootOwnershipManager({ lockDirectory: join(root, machineIds.beta, 'root-ownership') });
        const releasedBeta = await betaCustody.tryAcquire({ ownerId: 'offline-beta-probe', canonicalRoot: betaRoot, operation: 'handoff' });
        expect(releasedBeta).not.toHaveProperty('kind');
        if (!('kind' in releasedBeta)) await releasedBeta.release();
        const gammaCustody = createWorkspaceRootOwnershipManager({ lockDirectory: join(root, machineIds.gamma, 'root-ownership') });
        const retainedGamma = await gammaCustody.tryAcquire({ ownerId: 'online-gamma-probe', canonicalRoot: gammaRoot, operation: 'handoff' });
        if (!('kind' in retainedGamma)) await retainedGamma.release();
        expect(retainedGamma).toMatchObject({ kind: 'overlap' });
        await Promise.all([
          writeFile(join(alphaRoot, 'offline.txt'), 'hub while beta offline\n'),
          writeFile(join(betaRoot, 'beta-offline.txt'), 'beta while its daemon is offline\n'),
        ]);
        await waitForContents(join(gammaRoot, 'offline.txt'), 'hub while beta offline\n');
        await assertStillAbsent(join(betaRoot, 'offline.txt'));
        targets.set(machineIds.beta, await createTarget(machineIds.beta));
        try {
          await Promise.all([
            waitForContents(join(betaRoot, 'offline.txt'), 'hub while beta offline\n'),
            waitForContents(join(alphaRoot, 'beta-offline.txt'), 'beta while its daemon is offline\n'),
          ]);
        } catch (error) {
          const current = await runtime.managedWorkspaceSync.get(first.relationshipId);
          throw new Error(`Remote beta reconnect failed: ${JSON.stringify(current)}`, { cause: error });
        }

        await writeFile(join(alphaRoot, 'three-versions.txt'), 'common bytes\n');
        await Promise.all([
          waitForContents(join(betaRoot, 'three-versions.txt'), 'common bytes\n'),
          waitForContents(join(gammaRoot, 'three-versions.txt'), 'common bytes\n'),
        ]);
        await Promise.all([
          runtime.managedWorkspaceSync.pause(first.relationshipId),
          runtime.managedWorkspaceSync.pause(second.relationshipId),
        ]);
        await Promise.all([
          writeFile(join(alphaRoot, 'three-versions.txt'), 'hub version\n'),
          writeFile(join(betaRoot, 'three-versions.txt'), 'beta version\n'),
          writeFile(join(gammaRoot, 'three-versions.txt'), 'gamma version\n'),
        ]);
        await Promise.all([
          runtime.managedWorkspaceSync.resume(first.relationshipId),
          runtime.managedWorkspaceSync.resume(second.relationshipId),
        ]);
        await Promise.all([
          runtime.managedWorkspaceSync.flush(first.relationshipId),
          runtime.managedWorkspaceSync.flush(second.relationshipId),
        ]);
        for (const relationship of relationships) {
          const conflicts = await runtime.managedWorkspaceSync.listConflicts({ relationshipId: relationship.relationshipId, limit: 100 });
          expect(conflicts.status).toBe('page');
          if (conflicts.status !== 'page') throw new Error('conflict cursor invalidated on initial page');
          expect(conflicts.conflicts.some((entry) => entry.path === 'three-versions.txt')).toBe(true);
        }
        expect(targetAgents.length).toBeGreaterThanOrEqual(2);

        await runtime.managedWorkspaceSync.terminate(first.relationshipId);
        await writeFile(join(alphaRoot, 'after-first-stopped.txt'), 'second remote link remains live\n');
        await waitForContents(join(gammaRoot, 'after-first-stopped.txt'), 'second remote link remains live\n');
        await assertStillAbsent(join(betaRoot, 'after-first-stopped.txt'));
      } finally {
        await runtime?.stop().catch(() => undefined);
        await Promise.all([...targets.values()].map(async (target) => await target.releaseAllRetainedBootstraps().catch(() => undefined)));
        await rm(root, { recursive: true, force: true });
      }
    });

    it('prewarms and finally transfers a linked spoke Session path through the real hub before target reading', async () => {
      const binaries = await requireLiveBinaries();
      const root = await realpath(await mkdtemp(join(tmpdir(), 'hwsh-')));
      const hubRoot = join(root, 'alpha');
      const targetRoot = join(root, 'beta');
      const sourceRoot = join(root, 'gamma');
      const sourceHub = {
        ...liveRelationship({ relationshipId: 'source-hub', mode: 'keep_both_in_sync' }),
        betaWorkspaceRefId: 'gamma-ref',
      };
      const hubTarget = liveRelationship({ relationshipId: 'hub-target', mode: 'keep_synced' });
      const relationships = [sourceHub, hubTarget];
      let runtime: DaemonWorkspaceSyncRuntime | null = null;
      try {
        runtime = await startLiveRuntime({ root, binaries, relationship: null, relationships });
        const workspaceRefs = [
          { id: 'alpha-ref', serverId: 'server-1', machineId: 'local-machine', rootPath: hubRoot, createdAtMs: 1 },
          { id: 'beta-ref', serverId: 'server-1', machineId: 'local-machine', rootPath: targetRoot, createdAtMs: 1 },
          { id: 'gamma-ref', serverId: 'server-1', machineId: 'local-machine', rootPath: sourceRoot, createdAtMs: 1 },
        ];
        const adapter = createWorkspaceSyncHandoffAdapter({
          sync: runtime.managedWorkspaceSync,
          bootstrap: async () => ({ release: async () => undefined }),
          prepareBetween: async (request, signal) => await prepareWorkspaceSyncBetween({
            ...request,
            readCurrent: async () => ({ workspaceRefs, relationships }),
            flush: async (relationshipId, flushSignal) => await runtime!.managedWorkspaceSync.flush(relationshipId, flushSignal),
            ...(signal ? { signal } : {}),
          }),
        });
        const handoff = {
          operationId: 'linked-spoke-handoff',
          action: { kind: 'linked_workspace' as const },
          sourceMachineId: 'local-machine',
          targetMachineId: 'local-machine',
          sourceWorkspaceRefId: 'gamma-ref',
          targetWorkspaceRefId: 'beta-ref',
          sourceRootPath: sourceRoot,
          targetRootPath: targetRoot,
        };
        const prepared = await adapter.prepare(handoff);
        expect(prepared.traversed?.map(({ relationshipId }) => relationshipId)).toEqual(['source-hub', 'hub-target']);

        const relativeSessionPath = join('packages', 'app');
        await mkdir(join(sourceRoot, relativeSessionPath), { recursive: true });
        await writeFile(join(sourceRoot, relativeSessionPath, 'handoff.txt'), 'final source Session edit\n');
        const finalized = await adapter.finalize({ operationId: handoff.operationId, prepared });
        expect(finalized.traversed?.map(({ relationshipId }) => relationshipId)).toEqual(['source-hub', 'hub-target']);
        await waitForContents(join(targetRoot, relativeSessionPath, 'handoff.txt'), 'final source Session edit\n');
        const targetReader = await readFile(join(targetRoot, relativeSessionPath, 'handoff.txt'), 'utf8');
        expect(targetReader).toBe('final source Session edit\n');
        expect(relationships).toHaveLength(2);
        await adapter.commit({ operationId: handoff.operationId, prepared });

        await runtime.managedWorkspaceSync.pause('hub-target');
        await writeFile(join(sourceRoot, relativeSessionPath, 'retry.txt'), 'retry after blocked link\n');
        const blocked = await prepareWorkspaceSyncBetween({
          sourceWorkspaceRefId: 'gamma-ref', targetWorkspaceRefId: 'beta-ref',
          readCurrent: async () => ({ workspaceRefs, relationships }),
          flush: async (relationshipId) => await runtime!.managedWorkspaceSync.flush(relationshipId),
        });
        expect(blocked).toMatchObject({
          ok: false,
          completed: [{ relationshipId: 'source-hub' }],
          blockedRelationshipId: 'hub-target',
        });
        await runtime.managedWorkspaceSync.resume('hub-target');
        const retried = await prepareWorkspaceSyncBetween({
          sourceWorkspaceRefId: 'gamma-ref', targetWorkspaceRefId: 'beta-ref',
          readCurrent: async () => ({ workspaceRefs, relationships }),
          flush: async (relationshipId) => await runtime!.managedWorkspaceSync.flush(relationshipId),
        });
        expect(retried).toMatchObject({
          ok: true,
          traversed: [{ relationshipId: 'source-hub' }, { relationshipId: 'hub-target' }],
        });
        await waitForContents(join(targetRoot, relativeSessionPath, 'retry.txt'), 'retry after blocked link\n');
      } finally {
        await runtime?.stop().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });

    it('copy_once materializes alpha bytes on beta, completes the flush, and leaves no persistent relationship or session', async () => {
      const binaries = await requireLiveBinaries();
      await withLiveRuntime(
        { binaries, relationship: null },
        async ({ runtime, alphaRoot, betaRoot }) => {
          await writeFile(join(alphaRoot, 'alpha-to-beta.txt'), 'non-empty copy_once payload\n');

          const status = await runtime.managedWorkspaceSync.copyOnce({
            v: 1,
            operationId: 'live-copy-once-mode',
            controllerMachineId: 'local-machine',
            alphaWorkspaceRefId: 'alpha-ref',
            betaWorkspaceRefId: 'beta-ref',
            contentPolicy: {
              ...contentPolicy,
              policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicy),
            },
          });

          // The observed result names the ephemeral operation and the completed flush.
          expect(status).toMatchObject({
            relationshipId: 'live-copy-once-mode',
            mode: 'copy_once',
          });
          expect(typeof status.lastCycleObservedAtMs).toBe('number');

          // The initial copy reached the target.
          await waitForContents(join(betaRoot, 'alpha-to-beta.txt'), 'non-empty copy_once payload\n');

          // The engine holds no session afterwards: a surviving session would
          // fail this list with relationship_definition_conflict, so an empty
          // list is an engine observation, not a registration check.
          await expect(runtime.managedWorkspaceSync.list()).resolves.toEqual([]);
          await expect(runtime.managedWorkspaceSync.get('live-copy-once-mode')).resolves.toBeNull();

          // The copy is finite: later source changes have no session to ride.
          await writeFile(join(alphaRoot, 'after-copy.txt'), 'written after copy_once completed\n');
          await assertStillAbsent(join(betaRoot, 'after-copy.txt'));
        },
      );
    });

    it('keep_synced (one-way-safe) preserves target-only files and installs an approved target version upstream', async () => {
      const binaries = await requireLiveBinaries();
      await withLiveRuntime(
        { binaries, relationship: liveRelationship({ relationshipId: 'live-keep-synced-mode', mode: 'keep_synced' }) },
        async ({ runtime, alphaRoot, betaRoot, conflictApprovalAuthority }) => {
          await writeFile(join(alphaRoot, 'notes.txt'), 'keep_synced v1\n');
          await waitForContents(join(betaRoot, 'notes.txt'), 'keep_synced v1\n');

          // A target-only file appears, then a later source cycle completes;
          // one-way-safe must retain the non-conflicting target-only path.
          await writeFile(join(betaRoot, 'beta-only.txt'), 'target-only content\n');
          await writeFile(join(alphaRoot, 'notes.txt'), 'keep_synced v2\n');
          await waitForContents(join(betaRoot, 'notes.txt'), 'keep_synced v2\n');
          await waitForContents(join(betaRoot, 'beta-only.txt'), 'target-only content\n', 'target-only file to remain');

          // Deleting an unmodified source path propagates to the target.
          await rm(join(alphaRoot, 'notes.txt'));
          await waitForAbsent(join(betaRoot, 'notes.txt'), 'source deletion to propagate');

          await writeFile(join(alphaRoot, 'reviewed.txt'), 'common version\n');
          await waitForContents(join(betaRoot, 'reviewed.txt'), 'common version\n');
          await writeFile(join(alphaRoot, 'reviewed.txt'), 'alpha losing edit\n');
          await writeFile(join(betaRoot, 'reviewed.txt'), 'beta reviewed edit\n');
          await runtime.managedWorkspaceSync.flush('live-keep-synced-mode');
          const conflicts = await runtime.managedWorkspaceSync.listConflicts({
            relationshipId: 'live-keep-synced-mode', limit: 100,
          });
          if (conflicts.status !== 'page' || !conflicts.conflicts.some((entry) => entry.path === 'reviewed.txt')) {
            throw new Error('One-way divergence did not produce a reviewable conflict');
          }
          const [betaReviewed, alphaLosing] = await Promise.all([
            observeWorkspaceSyncEntryAtRoot({ rootPath: betaRoot, relativePath: 'reviewed.txt' }),
            observeWorkspaceSyncEntryAtRoot({ rootPath: alphaRoot, relativePath: 'reviewed.txt' }),
          ]);
          await resolveConflictThroughApprovedAction(runtime, conflictApprovalAuthority, {
            controllerMachineId: 'local-machine',
            hubWorkspaceRefId: 'alpha-ref',
            path: 'reviewed.txt',
            source: { workspaceRefId: 'beta-ref', expected: betaReviewed },
            targets: [{ workspaceRefId: 'alpha-ref', expected: alphaLosing }],
            relationshipIds: ['live-keep-synced-mode'],
            strategy: 'use_source',
          });
          await waitForContents(join(alphaRoot, 'reviewed.txt'), 'beta reviewed edit\n', 'approved target version upstream');
          await waitForContents(join(betaRoot, 'reviewed.txt'), 'beta reviewed edit\n', 'reviewed target version retained');

          const status = await runtime.managedWorkspaceSync.get('live-keep-synced-mode');
          expect(status).toMatchObject({
            relationshipId: 'live-keep-synced-mode',
            mode: 'keep_synced',
          });
        },
      );
    });

    it('mirror_exactly (one-way-replica) removes the explicit target-only file and propagates later source edits and deletion', async () => {
      const binaries = await requireLiveBinaries();
      await withLiveRuntime(
        { binaries, relationship: liveRelationship({ relationshipId: 'live-mirror-exactly-mode', mode: 'mirror_exactly' }) },
        async ({ runtime, alphaRoot, betaRoot }) => {
          await writeFile(join(alphaRoot, 'report.txt'), 'mirror v1\n');
          await waitForContents(join(betaRoot, 'report.txt'), 'mirror v1\n');

          // The destructive half of the mode: an explicit target-only file is
          // removed once a reconciliation cycle completes.
          await writeFile(join(betaRoot, 'target-only.txt'), 'doomed target-only content\n');
          await runtime.managedWorkspaceSync.flush('live-mirror-exactly-mode');
          await waitForAbsent(join(betaRoot, 'target-only.txt'), 'explicit target-only file removal');

          // Later source edits and deletions keep the target an exact replica.
          await writeFile(join(alphaRoot, 'report.txt'), 'mirror v2\n');
          await waitForContents(join(betaRoot, 'report.txt'), 'mirror v2\n');
          await rm(join(alphaRoot, 'report.txt'));
          await waitForAbsent(join(betaRoot, 'report.txt'), 'replica source deletion');

          const status = await runtime.managedWorkspaceSync.get('live-mirror-exactly-mode');
          expect(status).toMatchObject({
            relationshipId: 'live-mirror-exactly-mode',
            mode: 'mirror_exactly',
          });
        },
      );
    });

    it('keep_both_in_sync (two-way-safe) reconciles both directions and resolves a divergent edit through the conflict owner', async () => {
      const binaries = await requireLiveBinaries();
      await withLiveRuntime(
        { binaries, relationship: liveRelationship({ relationshipId: 'live-two-way-mode', mode: 'keep_both_in_sync' }) },
        async ({ runtime, alphaRoot, betaRoot, conflictApprovalAuthority }) => {
          await writeFile(join(alphaRoot, 'shared.txt'), 'two-way alpha seed\n');
          await waitForContents(join(betaRoot, 'shared.txt'), 'two-way alpha seed\n');

          await writeFile(join(betaRoot, 'beta-to-alpha.txt'), 'non-empty beta payload\n');
          await waitForContents(join(alphaRoot, 'beta-to-alpha.txt'), 'non-empty beta payload\n');

          // Divergent edits must be reported by the engine-derived projection,
          // then resolved through the same controller and guarded filesystem
          // mutation owner used below the authenticated target authority.
          await writeFile(join(alphaRoot, 'conflicted.txt'), 'alpha divergent edit\n');
          await writeFile(join(betaRoot, 'conflicted.txt'), 'beta divergent edit\n');
          await runtime.managedWorkspaceSync.flush('live-two-way-mode');

          const conflicts = await runtime.managedWorkspaceSync.listConflicts({
            relationshipId: 'live-two-way-mode',
            limit: 100,
          });
          expect(conflicts.status).toBe('page');
          if (conflicts.status !== 'page') throw new Error('conflict cursor invalidated on initial page');
          expect(conflicts.totalCount).toBeGreaterThanOrEqual(1);
          expect(conflicts.conflicts.some((entry) => entry.path.includes('conflicted.txt'))).toBe(true);

          const status = await runtime.managedWorkspaceSync.get('live-two-way-mode');
          expect(status).toMatchObject({
            relationshipId: 'live-two-way-mode',
            mode: 'keep_both_in_sync',
          });
          expect(status?.conflictCount).toBeGreaterThanOrEqual(1);
          expect(status?.state).toBe('conflicted');

          const conflict = conflicts.conflicts.find((entry) => entry.path.includes('conflicted.txt'))!;
          if (conflict.beta.kind === 'unsupported') {
            throw new Error('regular-file conflict unexpectedly reported as unsupported');
          }
          const [alphaExpected, betaExpected] = await Promise.all([
            observeWorkspaceSyncEntryAtRoot({ rootPath: alphaRoot, relativePath: conflict.path }),
            observeWorkspaceSyncEntryAtRoot({ rootPath: betaRoot, relativePath: conflict.path }),
          ]);
          await resolveConflictThroughApprovedAction(runtime, conflictApprovalAuthority, {
            controllerMachineId: 'local-machine',
            hubWorkspaceRefId: 'alpha-ref',
            path: conflict.path,
            source: { workspaceRefId: 'alpha-ref', expected: alphaExpected },
            targets: [{ workspaceRefId: 'beta-ref', expected: betaExpected }],
            relationshipIds: ['live-two-way-mode'],
            strategy: 'use_source',
          });
          await waitForContents(join(betaRoot, 'conflicted.txt'), 'alpha divergent edit\n', 'resolved alpha conflict');

          const resolvedConflicts = await runtime.managedWorkspaceSync.listConflicts({
            relationshipId: 'live-two-way-mode',
            limit: 100,
          });
          if (resolvedConflicts.status !== 'page') throw new Error('conflict cursor invalidated on initial page');
          expect(resolvedConflicts.conflicts.some((entry) => entry.path.includes('conflicted.txt'))).toBe(false);

          // Exercise the opposite direction through the same approved Action.
          await writeFile(join(alphaRoot, 'conflicted-beta.txt'), 'alpha losing edit\n');
          await writeFile(join(betaRoot, 'conflicted-beta.txt'), 'beta winning edit\n');
          await runtime.managedWorkspaceSync.flush('live-two-way-mode');

          const betaWinningConflicts = await runtime.managedWorkspaceSync.listConflicts({
            relationshipId: 'live-two-way-mode',
            limit: 100,
          });
          if (betaWinningConflicts.status !== 'page') throw new Error('conflict cursor invalidated on beta-winning page');
          const betaWinningConflict = betaWinningConflicts.conflicts.find((entry) => entry.path.includes('conflicted-beta.txt'));
          expect(betaWinningConflict).toBeDefined();
          if (!betaWinningConflict || betaWinningConflict.alpha.kind === 'unsupported') {
            throw new Error('regular-file conflict unexpectedly reported as unsupported');
          }
          const [betaWinningExpected, alphaLosingExpected] = await Promise.all([
            observeWorkspaceSyncEntryAtRoot({ rootPath: betaRoot, relativePath: betaWinningConflict.path }),
            observeWorkspaceSyncEntryAtRoot({ rootPath: alphaRoot, relativePath: betaWinningConflict.path }),
          ]);
          await resolveConflictThroughApprovedAction(runtime, conflictApprovalAuthority, {
            controllerMachineId: 'local-machine',
            hubWorkspaceRefId: 'alpha-ref',
            path: betaWinningConflict.path,
            source: { workspaceRefId: 'beta-ref', expected: betaWinningExpected },
            targets: [{ workspaceRefId: 'alpha-ref', expected: alphaLosingExpected }],
            relationshipIds: ['live-two-way-mode'],
            strategy: 'use_source',
          });
          await waitForContents(join(alphaRoot, 'conflicted-beta.txt'), 'beta winning edit\n', 'resolved beta conflict');

          const betaResolvedConflicts = await runtime.managedWorkspaceSync.listConflicts({
            relationshipId: 'live-two-way-mode',
            limit: 100,
          });
          if (betaResolvedConflicts.status !== 'page') throw new Error('conflict cursor invalidated after beta resolution');
          expect(betaResolvedConflicts.conflicts.some((entry) => entry.path.includes('conflicted-beta.txt'))).toBe(false);
        },
      );
    });

    it('keeps the displaced hub file beside the chosen spoke file and propagates both through the real two-way engine', async () => {
      const binaries = await requireLiveBinaries();
      const relationshipId = 'live-two-way-keep-both';
      await withLiveRuntime(
        { binaries, relationship: liveRelationship({ relationshipId, mode: 'keep_both_in_sync' }) },
        async ({ runtime, alphaRoot, betaRoot, conflictApprovalAuthority }) => {
          const path = 'reviewed.txt';
          await writeFile(join(alphaRoot, path), 'shared baseline\n');
          await waitForContents(join(betaRoot, path), 'shared baseline\n');
          await runtime.managedWorkspaceSync.pause(relationshipId);
          await Promise.all([
            writeFile(join(alphaRoot, path), 'preserved hub version\n'),
            writeFile(join(betaRoot, path), 'chosen spoke version\n'),
          ]);
          const displacedBeforeSync = await observeWorkspaceSyncEntryAtRoot({ rootPath: alphaRoot, relativePath: path });
          if (displacedBeforeSync.kind !== 'file') throw new Error('The hub version was not a regular file');
          const [occupiedAsidePath, alternateAsidePath] = deriveWorkspaceSyncConflictAsidePaths(path, displacedBeforeSync);
          await writeFile(join(alphaRoot, occupiedAsidePath), 'unrelated existing aside\n');
          await runtime.managedWorkspaceSync.resume(relationshipId);
          await runtime.managedWorkspaceSync.flush(relationshipId);
          await waitForContents(join(betaRoot, occupiedAsidePath), 'unrelated existing aside\n');
          const page = await runtime.managedWorkspaceSync.listConflicts({ relationshipId, limit: 100 });
          expect(page.status).toBe('page');
          if (page.status !== 'page') throw new Error('conflict cursor invalidated on initial page');
          expect(page.conflicts.some((entry) => entry.path === path)).toBe(true);

          const inspection = await runtime.managedWorkspaceSync.inspectConflict({ workspaceRefId: 'alpha-ref', path });
          expect(inspection.preservationOptions).toContainEqual({
            status: 'name_conflict',
            source: { workspaceRefId: 'alpha-ref', expected: displacedBeforeSync },
            proposed: { workspaceRefId: 'alpha-ref', path: occupiedAsidePath },
          });
          const alternative = inspection.preservationOptions?.find((option) => (
            option.status === 'available' && option.source.workspaceRefId === 'alpha-ref'
          ));
          if (!alternative || alternative.status !== 'available') {
            throw new Error(`The current hub version has no reviewed preservation option: ${JSON.stringify(inspection.preservationOptions)}`);
          }
          expect(alternative.destination.path).toBe(alternateAsidePath);
          expect(alternative.consequence.propagatingToWorkspaceRefIds).toContain('beta-ref');
          const [chosen, displaced] = await Promise.all([
            observeWorkspaceSyncEntryAtRoot({ rootPath: betaRoot, relativePath: path }),
            observeWorkspaceSyncEntryAtRoot({ rootPath: alphaRoot, relativePath: path }),
          ]);
          const result = await resolveConflictThroughApprovedAction(runtime, conflictApprovalAuthority, {
            controllerMachineId: 'local-machine',
            hubWorkspaceRefId: 'alpha-ref',
            path,
            source: { workspaceRefId: 'beta-ref', expected: chosen },
            targets: [{ workspaceRefId: 'alpha-ref', expected: displaced }],
            relationshipIds: [relationshipId],
            strategy: 'keep_both',
            alternatives: [{
              source: alternative.source,
              destination: alternative.destination,
              consequence: alternative.consequence,
            }],
          });
          expect(result).toEqual({
            endpoints: [{ workspaceRefId: 'alpha-ref', status: 'applied' }],
            preserved: [{
              alternativeIndex: 0,
              sourceWorkspaceRefId: 'alpha-ref',
              destinationWorkspaceRefId: 'alpha-ref',
              path: alternative.destination.path,
              propagatingToWorkspaceRefIds: ['beta-ref'],
              outcome: { status: 'preserved' },
            }],
          });
          await Promise.all([
            waitForContents(join(alphaRoot, path), 'chosen spoke version\n'),
            waitForContents(join(betaRoot, path), 'chosen spoke version\n'),
            waitForContents(join(alphaRoot, occupiedAsidePath), 'unrelated existing aside\n'),
            waitForContents(join(betaRoot, occupiedAsidePath), 'unrelated existing aside\n'),
            waitForContents(join(alphaRoot, alternative.destination.path), 'preserved hub version\n'),
            waitForContents(join(betaRoot, alternative.destination.path), 'preserved hub version\n'),
          ]);
        },
      );
    });

    it('preserves a target-only file upstream before exact mirroring removes the original', async () => {
      const binaries = await requireLiveBinaries();
      const relationshipId = 'live-exact-replica-keep-both';
      await withLiveRuntime(
        { binaries, relationship: liveRelationship({ relationshipId, mode: 'mirror_exactly' }) },
        async ({ runtime, alphaRoot, betaRoot, conflictApprovalAuthority }) => {
          const path = 'target-only.txt';
          await writeFile(join(alphaRoot, 'baseline.txt'), 'replica ready\n');
          await waitForContents(join(betaRoot, 'baseline.txt'), 'replica ready\n');
          await runtime.managedWorkspaceSync.pause(relationshipId);
          await writeFile(join(betaRoot, path), 'target-authored bytes\n');
          const inspection = await runtime.managedWorkspaceSync.inspectConflict({ workspaceRefId: 'beta-ref', path });
          const alternative = inspection.preservationOptions?.find((option) => (
            option.status === 'available' && option.source.workspaceRefId === 'beta-ref'
          ));
          if (!alternative || alternative.status !== 'available') {
            throw new Error(`Target-only version has no reviewed upstream preservation option: ${JSON.stringify(inspection)}`);
          }
          expect(alternative.destination.workspaceRefId).toBe('alpha-ref');
          expect(alternative.consequence.propagatingToWorkspaceRefIds).not.toContain('beta-ref');
          expect(alternative.consequence.unverifiedPropagationToWorkspaceRefIds).toContain('beta-ref');
          const [hubMissing, targetOnly] = await Promise.all([
            observeWorkspaceSyncEntryAtRoot({ rootPath: alphaRoot, relativePath: path }),
            observeWorkspaceSyncEntryAtRoot({ rootPath: betaRoot, relativePath: path }),
          ]);
          expect(hubMissing).toEqual({ kind: 'missing' });
          expect(targetOnly.kind).toBe('file');
          const result = await resolveConflictThroughApprovedAction(runtime, conflictApprovalAuthority, {
            controllerMachineId: 'local-machine',
            hubWorkspaceRefId: 'alpha-ref',
            path,
            source: { workspaceRefId: 'alpha-ref', expected: hubMissing },
            targets: [{ workspaceRefId: 'beta-ref', expected: targetOnly }],
            relationshipIds: [relationshipId],
            strategy: 'keep_both',
            alternatives: [{
              source: alternative.source,
              destination: alternative.destination,
              consequence: alternative.consequence,
            }],
          });
          expect(result).toEqual({
            endpoints: [{ workspaceRefId: 'beta-ref', status: 'applied_paused' }],
            preserved: [{
              alternativeIndex: 0,
              sourceWorkspaceRefId: 'beta-ref',
              destinationWorkspaceRefId: 'alpha-ref',
              path: alternative.destination.path,
              propagatingToWorkspaceRefIds: [],
              unverifiedPropagationToWorkspaceRefIds: ['beta-ref'],
              outcome: { status: 'preserved' },
            }],
          });
          await runtime.managedWorkspaceSync.resume(relationshipId);
          await runtime.managedWorkspaceSync.flush(relationshipId);
          await Promise.all([
            waitForAbsent(join(betaRoot, path), 'exact replica original removal'),
            waitForContents(join(alphaRoot, alternative.destination.path), 'target-authored bytes\n'),
            waitForContents(join(betaRoot, alternative.destination.path), 'target-authored bytes\n'),
          ]);
        },
      );
    });

    it('rehydrates the persisted relationship after a full daemon runtime restart without creating another session', async () => {
      const binaries = await requireLiveBinaries();
      const root = await realpath(await mkdtemp(join(tmpdir(), 'hwsl-')));
      const relationship = liveRelationship({ relationshipId: 'live-restart-rehydrate', mode: 'keep_both_in_sync' });
      let runtime: DaemonWorkspaceSyncRuntime | null = null;
      try {
        const alphaRoot = join(root, 'alpha');
        const betaRoot = join(root, 'beta');
        await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);

        runtime = await startLiveRuntime({ root, binaries, relationship });
        await writeFile(join(alphaRoot, 'before-restart.txt'), 'persisted before restart\n');
        await waitForContents(join(betaRoot, 'before-restart.txt'), 'persisted before restart\n');
        await runtime.stop();
        runtime = null;

        runtime = await startLiveRuntime({ root, binaries, relationship });
        const relationships = await runtime.managedWorkspaceSync.list();
        expect(relationships).toHaveLength(1);
        expect(relationships[0]).toMatchObject({
          relationshipId: 'live-restart-rehydrate',
          mode: 'keep_both_in_sync',
        });

        await writeFile(join(betaRoot, 'after-restart.txt'), 'persisted after restart\n');
        await waitForContents(join(alphaRoot, 'after-restart.txt'), 'persisted after restart\n');
      } finally {
        await runtime?.stop().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });

    it('reconciles the persisted relationship after an unexpected real sidecar termination', async () => {
      const binaries = await requireLiveBinaries();
      const root = await realpath(await mkdtemp(join(tmpdir(), 'hwsl-')));
      const relationship = liveRelationship({ relationshipId: 'live-sidecar-restart', mode: 'keep_both_in_sync' });
      const spawned: WorkspaceSyncSidecarProcess[] = [];
      let runtime: DaemonWorkspaceSyncRuntime | null = null;
      try {
        const alphaRoot = join(root, 'alpha');
        const betaRoot = join(root, 'beta');
        await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
        runtime = await startLiveRuntime({
          root,
          binaries,
          relationship,
          onSidecarSpawned: (process) => {
            spawned.push(process);
          },
        });

        await writeFile(join(alphaRoot, 'before-sidecar-restart.txt'), 'before sidecar restart\n');
        await waitForContents(join(betaRoot, 'before-sidecar-restart.txt'), 'before sidecar restart\n');
        expect(spawned).toHaveLength(1);

        await spawned[0]!.stop();
        const deadline = Date.now() + 20_000;
        while (spawned.length < 2 && Date.now() < deadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        }
        expect(spawned.length).toBeGreaterThanOrEqual(2);

        await expect(runtime.managedWorkspaceSync.list()).resolves.toEqual([
          expect.objectContaining({
            relationshipId: 'live-sidecar-restart',
            mode: 'keep_both_in_sync',
          }),
        ]);
        await writeFile(join(betaRoot, 'after-sidecar-restart.txt'), 'after sidecar restart\n');
        await waitForContents(join(alphaRoot, 'after-sidecar-restart.txt'), 'after sidecar restart\n');
      } finally {
        await runtime?.stop().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });

  },
);

describe.skipIf(!runInstalledArtifactIntegration)(
  `daemon workspace sync runtime with acquired Mutagen ${MUTAGEN_ENGINE_VERSION}`,
  { timeout: 10 * 60_000 },
  () => {
    it('uses the validated installed manager and rooted agent for authenticated LIST and non-empty bidirectional bytes', async () => {
      const installedHome = await realpath(await mkdtemp(join(tmpdir(), 'happier-mutagen-installed-real-')));
      try {
        const binaries = await acquireInstalledArtifactBinaries(installedHome);
        await withLiveRuntime(
          {
            binaries,
            relationship: liveRelationship({
              relationshipId: 'live-installed-artifact-byte-path',
              mode: 'keep_both_in_sync',
            }),
          },
          async ({ runtime, alphaRoot, betaRoot }) => {
            await expect(runtime.managedWorkspaceSync.list()).resolves.toEqual([
              expect.objectContaining({
                relationshipId: 'live-installed-artifact-byte-path',
                mode: 'keep_both_in_sync',
              }),
            ]);

            await writeFile(join(alphaRoot, 'installed-alpha-to-beta.txt'), 'installed alpha payload\n');
            await waitForContents(
              join(betaRoot, 'installed-alpha-to-beta.txt'),
              'installed alpha payload\n',
              'installed artifact alpha-to-beta bytes',
            );

            await writeFile(join(betaRoot, 'installed-beta-to-alpha.txt'), 'installed beta payload\n');
            await waitForContents(
              join(alphaRoot, 'installed-beta-to-alpha.txt'),
              'installed beta payload\n',
              'installed artifact beta-to-alpha bytes',
            );
          },
        );
      } catch (error) {
        const target = (() => {
          try {
            return resolveMutagenEngineArtifactTarget();
          } catch {
            return `${process.platform}-${process.arch}`;
          }
        })();
        throw new Error(
          `Installed Mutagen ${MUTAGEN_ENGINE_VERSION} (${target}) failed the authenticated manager/rooted-agent byte corridor`,
          { cause: error },
        );
      } finally {
        await rm(installedHome, { recursive: true, force: true });
      }
    });
  },
);
