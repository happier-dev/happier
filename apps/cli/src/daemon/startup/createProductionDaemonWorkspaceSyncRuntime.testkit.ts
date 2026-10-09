import { join } from 'node:path';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { expect, onTestFinished, vi } from 'vitest';
import axios, { type AxiosRequestConfig } from 'axios';
import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { resolveHomeTargetFromDescriptor, type ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { DevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { registerMachineWorkspaceSyncRpcHandlers } from '@/api/machine/rpcHandlers.workspaceSync';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { WorkspaceSyncTargetPhaseDescriptor } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot,
  type ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import type { MutagenControlCommandV1, MutagenSessionSummaryV1 } from '@/workspaces/sync/transport/workspaceSyncBrokerProtocol';
import type { FiniteTransferMachineTunnel, WorkspaceSyncMachineTunnel, WorkspaceSyncMachineTunnelOpenInput } from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import { createDaemonWorkspaceSyncRuntime, type DaemonWorkspaceSyncRuntime } from './createDaemonWorkspaceSyncRuntime';
import { createProductionDaemonWorkspaceSyncRuntime, type ProductionDaemonWorkspaceSyncFactories } from './createProductionDaemonWorkspaceSyncRuntime';

const contentPolicyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };

// The real daemon-applied registry outlives each workspace fixture. Keep its
// private store valid while the singleton is warm; never shut down or delete a
// serving registry's home between tests. Process/OS temp cleanup owns this home.
let pluginRuntimeHome: Promise<string> | undefined;
let pluginRuntimeDevelopmentRoots: ReturnType<typeof createDaemonPluginDevelopmentRootsOwner> | undefined;

export async function composeBindChildSourcePhaseTestRuntime(options: Readonly<{
  socketIo: Readonly<{
    mockImplementation(implementation: () => ReturnType<typeof createApiSessionSocketStub>): unknown;
    mockReset(): unknown;
  }>;
  sourcePhaseUnavailable?: boolean;
  separateTargetParent?: boolean;
  /** Ordinary D owns the existing target row directly, without a managed Parent route. */
  ordinaryTarget?: boolean;
  /** Real Git worktree plus installed remote-seed ports, without lending Parent Account access. */
  gitWorktreeSeed?: boolean;
  withTargetChildRuntime?: boolean;
  /** Separate installed target custody, exercising per-call keys rather than source Account codecs. */
  targetCredentials?: StoredCredentials;
  withScmRuntime?: boolean;
  /** Failure diagnostics observe real fixture awaits without replacing initialization. */
  onCompositionPhase?: (phase: string) => void;
  /** Exercise the real Account row store through the supplied HTTP boundary. */
  projectRowsFromHttp?: boolean;
  serverId?: string;
  parentServerId?: string;
  managedHomeId?: string;
  homeTarget?: ResolvedHomeTarget;
  parentHomeTarget?: ResolvedHomeTarget;
  readAdditionalHttpResponse?: (url: string, config?: AxiosRequestConfig) => Promise<Readonly<{ status: number; data: unknown }> | undefined>;
  readAdditionalHttpPostResponse?: (url: string, data: unknown, config?: AxiosRequestConfig) => Promise<Readonly<{ status: number; data: unknown }> | undefined>;
  handleAdditionalSocketAck?: (payload: unknown) => Promise<unknown | undefined>;
  callWorkspaceTargetPhase?: (descriptor: WorkspaceSyncTargetPhaseDescriptor, context: RpcHandlerContext) => Promise<unknown>;
  callWorkspaceSeedExport?: (descriptor: Readonly<{ machineId: string;
    request: import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas').WorkspaceSyncSeedExportPrepareV1;
    signal?: AbortSignal }>, context: RpcHandlerContext) => Promise<unknown>;
}>) {
  const { socketIo } = options;
  const selectedContentPolicy = { ...contentPolicyInput,
    selection: options.gitWorktreeSeed ? 'git_worktree' as const : 'all_files' as const };
  const contentPolicy = { ...selectedContentPolicy, policyDigest: computeWorkspaceSyncPolicyDigest(selectedContentPolicy) };
  options.onCompositionPhase?.('filesystem and network fixture');
  if (options.projectRowsFromHttp) withdrawActiveProjectAccountRowsSnapshot();
  const serverId = options.serverId ?? 'srv_bind_child_home';
  const parentServerId = options.parentServerId ?? serverId;
  const managedHomeId = options.managedHomeId ?? serverId;
  const homeServerUrl = 'https://bind-child-home.invalid';
  const defaultHomeDescriptor = options.homeTarget ? undefined : HomeConnectionDescriptorV1Schema.parse({
    v: 1, homeServerIdentityId: managedHomeId, canonicalServerUrl: homeServerUrl,
    revision: 1, endpoints: [{ kind: 'https', url: homeServerUrl }],
  });
  const defaultHomeTarget = defaultHomeDescriptor ? resolveHomeTargetFromDescriptor({ descriptor: defaultHomeDescriptor,
    authority: 'saved_profile', profile: { id: 'server-1', serverUrl: homeServerUrl, webappUrl: homeServerUrl,
      homeConnectionDescriptor: defaultHomeDescriptor },
  }) : undefined;
  // Explicit Home fixtures own their fresh same/foreign observation boundary.
  // Otherwise provide only the actual Home's canonical features response; the
  // fresh observer and all bind admission logic remain production-owned.
  let seedTransferLifecycle: import('@/machines/transfer/directTransferServerLifecycle').DirectTransferServerLifecycle | undefined;
  const nativeFetch = globalThis.fetch;
  const fetchBoundary = options.homeTarget ? undefined : vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const endpoint = new URL(url);
    if (options.gitWorktreeSeed && endpoint.hostname === '127.0.0.1'
      && endpoint.port === String(seedTransferLifecycle?.getState().port)
      && endpoint.pathname.startsWith('/machine-transfers/')) return await nativeFetch(input, init);
    if (!url.endsWith('/v1/features')) throw new Error(`Unexpected Home identity boundary: ${url}`);
    return new Response(JSON.stringify({ features: {}, capabilities: {
      serverIdentity: { serverIdentityId: managedHomeId },
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const credentials = { token: [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url'),
    'fixture-signature',
  ].join('.'), encryption: null };
  const targetCredentials = options.targetCredentials ?? credentials;
  const targetCustodianAccountId = readAccountIdFromToken(targetCredentials.token);
  if (!targetCustodianAccountId) throw new Error('The target fixture requires actual custodian credentials');
  const root = await mkdtemp(join(tmpdir(), 'happier-bind-child-source-phase-'));
  const sourcePath = join(root, 'parent-source');
  const targetPath = join(root, 'parent-target');
  const lockDirectory = join(root, 'root-custody');
  await mkdir(sourcePath);
  await writeFile(join(sourcePath, 'payload.txt'), 'before quiesce');
  if (options.gitWorktreeSeed) {
    const [{ execFile }, { promisify }] = await Promise.all([import('node:child_process'), import('node:util')]);
    const git = promisify(execFile);
    // Git is the real native process boundary. All writes are confined to the
    // fixture's newly created worktree; no repository/global identity changes.
    await git('git', ['-C', sourcePath, 'init']);
    await git('git', ['-C', sourcePath, 'add', 'payload.txt']);
    await git('git', ['-C', sourcePath, '-c', 'user.name=Workspace fixture', '-c', 'user.email=workspace-fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Source workspace fixture']);
  }
  const sourceRef = { id: 'source-parent-ref', serverId, machineId: 'source-parent', rootPath: sourcePath, createdAtMs: 1 };
  const childRef = { id: 'actual-child-ref', serverId, machineId: 'source-child', rootPath: '/child/custom', createdAtMs: 1 };
  const childInstallationId = 'child-installation';
  const targetRef = { id: 'target-parent-ref', serverId,
    machineId: options.ordinaryTarget ? 'target-child' : options.separateTargetParent ? 'target-parent' : sourceRef.machineId,
    rootPath: targetPath, createdAtMs: 1 };
  const targetChildRef = options.ordinaryTarget ? targetRef
    : { id: 'target-child-ref', serverId, machineId: 'target-child', rootPath: '/target/custom', createdAtMs: 1 };
  const targetChildInstallationId = 'target-child-installation';
  const targetParentInstallationId = options.ordinaryTarget ? targetChildInstallationId : 'target-parent-installation';
  const projection: DevcontainerChildProjectionV1 = {
    relation: { managedMachineId: 'managed-source-child', managedMachineKind: 'devcontainer', parentMachineId: sourceRef.machineId },
    observation: { nativeResourceId: 'container-current', user: 'coder', workspaceFolder: childRef.rootPath,
      storage: { kind: 'bind', hostPath: sourcePath, childPath: childRef.rootPath } },
  };
  let nativeProjection = projection;
  const managedChild: ManagedMachineV1 = {
    id: projection.relation.managedMachineId, homeId: managedHomeId, custodianAccountId: 'owner',
    controller: { machineId: sourceRef.machineId, installationId: 'parent-installation' },
    launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {} },
    resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {}, devcontainerObservation: projection.observation },
    allocation: 'bound', creationState: 'active', enrolledMachineId: childRef.machineId,
    desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
  };
  const targetProjection: DevcontainerChildProjectionV1 = {
    relation: { managedMachineId: 'managed-target-child', managedMachineKind: 'devcontainer', parentMachineId: targetRef.machineId },
    observation: { nativeResourceId: 'target-container-current', user: 'coder', workspaceFolder: targetChildRef.rootPath,
      storage: { kind: 'bind', hostPath: targetPath, childPath: targetChildRef.rootPath } },
  };
  let nativeTargetProjection = targetProjection;
  let targetChildRetired = false;
  const managedTargetChild: ManagedMachineV1 = { ...managedChild,
    id: targetProjection.relation.managedMachineId,
    custodianAccountId: targetCustodianAccountId,
    controller: { machineId: targetRef.machineId, installationId: targetParentInstallationId },
    resource: { ...managedChild.resource!, devcontainerObservation: targetProjection.observation },
    enrolledMachineId: targetChildRef.machineId,
  };
  const snapshot: ActiveProjectAccountRowsSnapshot = {
    source: 'network', workspaceRefs: [...new Map([sourceRef, childRef, targetRef,
      ...(options.separateTargetParent ? [targetChildRef] : [])].map(ref => [ref.id, ref])).values()], relationships: [],
    graphRevision: 1, loadedAtMs: 1, organizations: [], rows: [], scopeKey: 'scope-1',
  };
  const handlers = new Map<string, (raw: unknown, context?: RpcHandlerContext) => unknown>();
  const targetParentHandlers = new Map<string, (raw: unknown, context?: RpcHandlerContext) => unknown>();
  const registrar: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      // Network decoding supplies unknown input; the real registered handler owns schema validation.
      handlers.set(method, (raw, context) => handler(raw as Parameters<typeof handler>[0], context));
    },
  };
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const additional = await options.readAdditionalHttpResponse?.(url, config);
    if (additional !== undefined) return additional;
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    const id = url.slice(url.lastIndexOf('/') + 1);
    const currentProjection = id === childRef.machineId ? projection
      : !options.ordinaryTarget && options.separateTargetParent && id === targetChildRef.machineId && !targetChildRetired ? targetProjection : null;
    const installationId = id === sourceRef.machineId ? 'parent-installation'
      : options.separateTargetParent && id === targetRef.machineId ? targetParentInstallationId
      : id === targetChildRef.machineId ? targetChildInstallationId : childInstallationId;
    return { status: 200, data: { machine: { id, active: id !== targetChildRef.machineId || !targetChildRetired,
      installationId, devcontainerChild: currentProjection,
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
      metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/coder', username: 'coder',
        happyCliVersion: 'test', happyHomeDir: '/home/coder/.happier',
        ...(currentProjection ? { devcontainerChild: currentProjection } : {}) }) } } };
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
    const additional = await options.readAdditionalHttpPostResponse?.(url, data, config);
    if (additional !== undefined) return additional;
    if (url.endsWith('/machines/managed/actions/get')) return { status: 200,
      data: options.separateTargetParent && data && typeof data === 'object' && 'managedId' in data
        && data.managedId === managedTargetChild.id ? managedTargetChild : managedChild };
    throw new Error(`Unexpected HTTP boundary: ${url}`);
  });
  socketIo.mockImplementation(() => createApiSessionSocketStub({ emitWithAck: async (_event, payload) => {
    const additional = await options.handleAdditionalSocketAck?.(payload);
    if (additional !== undefined) return additional;
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Invalid RPC boundary');
    }
    const content = { mode: 'plain' as const };
    const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
    if (options.separateTargetParent && payload.method.startsWith(`${targetRef.machineId}:daemon.workspaceSync.`)) {
      const method = payload.method.slice(targetRef.machineId.length + 1);
      const receiver = targetParentHandlers.get(method);
      if (!receiver) throw new Error(`Physical target RPC was not registered: ${method}`);
      // This is the ambient custodian Account's actual network admission to P2,
      // intentionally distinct from the borrower granted only the source child.
      const result = await receiver(decoded.params, { signal: new AbortController().signal,
        callerAuthority: 'present_user', machineAdmission: { actorAccountId: targetCustodianAccountId, custodianAccountId: targetCustodianAccountId,
          machineId: targetRef.machineId, installationId: targetParentInstallationId, role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true });
      return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
    }
    if (options.separateTargetParent && payload.method.startsWith(`${targetChildRef.machineId}:daemon.workspaceSync.`)) {
      // Home refuses the chosen-target first hop: borrower has no current D grant.
      return { ok: false, error: 'Chosen target admission is unavailable', errorCode: RPC_ERROR_CODES.FORBIDDEN };
    }
    if (!payload.method.endsWith('machines.managed.inspect')) throw new Error(`Unexpected native RPC: ${payload.method}`);
    if (!decoded.params || typeof decoded.params !== 'object'
      || !('homeId' in decoded.params) || decoded.params.homeId !== managedHomeId) {
      throw new Error('Native inspection did not use the captured immutable Home');
    }
    const targetInspect = options.separateTargetParent && decoded.params && typeof decoded.params === 'object'
      && 'managedId' in decoded.params && decoded.params.managedId === managedTargetChild.id;
    if (targetInspect && targetChildRetired) throw new Error('The target child container/socket is retired');
    const inspectedRow = targetInspect ? managedTargetChild : managedChild;
    const result = { machine: { ...inspectedRow,
      resource: { ...inspectedRow.resource!, devcontainerObservation: targetInspect ? nativeTargetProjection.observation : nativeProjection.observation },
      observation: { availability: 'present', observedAt: 1 } } };
    return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
  } }));
  const productions: Awaited<ReturnType<typeof createProductionDaemonWorkspaceSyncRuntime>>[] = [];
  const daemonRuntimes: DaemonWorkspaceSyncRuntime[] = [];
  let pluginRuntimeLease: PluginRuntimeRegistryLease | undefined;
  let finishInitialization = () => {};
  const initializationSettled = new Promise<void>(resolve => { finishInitialization = resolve; });
  onTestFinished(async () => {
    // A timed-out test does not cancel its pending constructor. Join that exact
    // initialization before stopping its runtimes or withdrawing its boundaries.
    await initializationSettled;
    try {
      await seedTransferLifecycle?.stop();
      const results = await Promise.allSettled(productions.map(production => production.stop()));
      const failures: unknown[] = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Workspace Sync fixture runtime teardown failed');
    } finally {
      get.mockRestore(); post.mockRestore(); socketIo.mockReset(); fetchBoundary?.mockRestore();
      if (options.projectRowsFromHttp) withdrawActiveProjectAccountRowsSnapshot();
      try {
        await pluginRuntimeLease?.release();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  try {
  if (options.gitWorktreeSeed) {
    const { createDirectTransferServerLifecycle } = await import('@/machines/transfer/directTransferServerLifecycle');
    seedTransferLifecycle = createDirectTransferServerLifecycle({ bindHost: '127.0.0.1', bindPort: 0,
      listenerClasses: ['loopback_http'] });
  }
  if (options.withScmRuntime || options.gitWorktreeSeed) {
    // Real seed materialization acquires the authoritative daemon lease. SCM's
    // canonical owner demands every declared backend and hosting provider, so
    // admit those exact public plugin occurrences, not just Git/Sapling.
    options.onCompositionPhase?.('SCM runtime lease acquisition');
    pluginRuntimeLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => {
        options.onCompositionPhase?.('SCM runtime home');
        const happyHomeDir = await (pluginRuntimeHome ??= mkdtemp(join(tmpdir(), 'happier-bind-child-plugin-runtime-')));
        const developmentRoots = pluginRuntimeDevelopmentRoots ??= createDaemonPluginDevelopmentRootsOwner({
          happyHomeDir,
          // This fixture admits exact bundled source roots lazily. It does not
          // initialize watchers or authorize a development-reload workflow.
          submitObservation: async () => { throw new Error('Development reload is not installed in this fixture'); },
        });
        options.onCompositionPhase?.('SCM contribution registry');
        const contributes = await resolveMergedContributionRegistry({ happyHomeDir });
        const pluginIds = [...new Set([...(contributes.scmHostingProviders ?? []), ...(contributes.scmBackends ?? [])]
          .flatMap(contribution => contribution.pluginId ? [contribution.pluginId] : []))];
        options.onCompositionPhase?.('SCM executable plugin registry');
        return await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, pluginIds,
          resolveDevelopmentSourceAuthority: developmentRoots.resolveDevelopmentSourceAuthority });
      },
    });
  }
  async function compose(machineId: string) {
    const targetMachine = options.separateTargetParent && [targetRef.machineId, targetChildRef.machineId].includes(machineId);
    const machineCredentials = targetMachine ? targetCredentials : credentials;
    const accountServerId = machineId === childRef.machineId ? serverId : parentServerId;
    const localHomeTarget = machineId === childRef.machineId ? options.homeTarget ?? defaultHomeTarget
      : options.parentHomeTarget ?? options.homeTarget ?? defaultHomeTarget;
    if (!localHomeTarget) throw new Error('Workspace Sync fixture requires its captured Home target');
    // Captured local profiles own credentials and daemon state, not Account
    // WorkspaceRef identity. Those refs retain the immutable public Home id.
    const localProfileId = localHomeTarget?.profileId ?? accountServerId;
    const accountSnapshot = options.targetCredentials ? { ...snapshot,
      workspaceRefs: snapshot.workspaceRefs.filter(ref => targetMachine
        ? [targetRef.machineId, targetChildRef.machineId].includes(ref.machineId)
        : [sourceRef.machineId, childRef.machineId].includes(ref.machineId)) } : snapshot;
    const localSnapshot = localHomeTarget || accountServerId === serverId ? accountSnapshot : { ...accountSnapshot,
      workspaceRefs: accountSnapshot.workspaceRefs.map(ref => ({ ...ref, serverId: accountServerId })) };
    const sessions = new Map<string, MutagenSessionSummaryV1>();
    let endSidecar: (() => void) | undefined;
    const command = async (input: MutagenControlCommandV1): Promise<unknown> => {
      if (input.t === 'shutdown') { endSidecar?.(); return null; }
      if (input.t === 'list') return { sessions: [...sessions.values()], nextCursor: null };
      if (input.t === 'create') {
        const endpoint = (value: string) => ({ protocol: 'external' as const, host: value.replace('external://', ''), path: '' as const,
          state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } });
        const session: MutagenSessionSummaryV1 = { identifier: input.session.name, name: input.session.name,
          labels: input.session.labels, alpha: endpoint(input.session.alpha), beta: endpoint(input.session.beta),
          mode: input.session.mode, paused: true, status: 'watching', successfulCycles: 0, conflictCount: 0 };
        sessions.set(session.identifier, session);
        return session;
      }
      const session = sessions.get(input.sessionIdentifier);
      if (input.t === 'terminate') { sessions.delete(input.sessionIdentifier); return null; }
      if (!session) throw new Error(`Mutagen session missing: ${input.sessionIdentifier}`);
      if (input.t === 'get_policy') return { selection: 'all_files', patterns: [], nextCursor: null };
      if (input.t === 'list_conflicts') return { totalCount: 0, shownCount: 0, truncatedCount: 0, conflicts: [], nextCursor: null };
      if (input.t === 'flush') {
        // The sidecar is the genuine OS copy boundary. Paths remain resolved by the real controller/target owners.
        // Ordinary materialization may accept a new row id for these same
        // physical roots. Delegated copy still cannot use a logical child path
        // or require the TARGET row in the SOURCE Account's graph.
        const current = options.projectRowsFromHttp ? getActiveProjectAccountRowsSnapshot() : snapshot;
        const accepted = [...(current?.workspaceRefs ?? []), ...snapshot.workspaceRefs, sourceRef, targetRef];
        const alpha = accepted.find(ref => ref.id === session.labels['external.alpha_workspace_ref_id'] && ref.rootPath === sourcePath);
        const beta = accepted.find(ref => ref.id === session.labels['external.beta_workspace_ref_id'] && ref.rootPath === targetPath);
        if (!alpha || !beta || machineId !== sourceRef.machineId) throw new Error('Copy was dispatched outside the physical source controller');
        await copyFile(join(alpha.rootPath, 'payload.txt'), join(beta.rootPath, 'payload.txt'));
      }
      const next = { ...session, paused: input.t === 'pause' ? true : input.t === 'resume' ? false : session.paused,
        successfulCycles: session.successfulCycles + (input.t === 'flush' ? 1 : 0) };
      sessions.set(next.identifier, next);
      return next;
    };
    const overrides: Partial<ProductionDaemonWorkspaceSyncFactories> = {
      ...(!options.projectRowsFromHttp ? { getProjectSnapshot: () => localSnapshot, subscribeProjectSnapshot: () => () => undefined } : {}),
      resolveRootOwnershipDirectory: () => lockDirectory,
      stopRetainedNativeProcesses: async () => undefined,
      // Retain the real daemon/controller/Mutagen adapter; substitute only artifact and process boundaries.
      createDaemonRuntime: deps => {
        const runtime = createDaemonWorkspaceSyncRuntime({ ...deps,
          resolveInstalledComponentPaths: () => ({ currentPath: '/fixture-engine', resolvedCurrentPath: '/fixture-engine' }),
          resolveArtifactPaths: () => ({ managerPath: '/fixture-engine/manager', agentPath: '/fixture-engine/agent' }),
          assertArtifactPayload: () => ({ engineVersion: '0.18.1', protocolEpoch: 'external-stream-v1' }),
        });
        daemonRuntimes.push(runtime);
        return runtime;
      },
      createBroker: async () => ({ bootstrapDescriptor: new Uint8Array([1]), waitForReady: async () => undefined,
        command, close: async () => undefined }),
      spawnSidecar: async () => {
        const terminated = new Promise<{ type: 'exited'; code: number }>(resolve => { endSidecar = () => resolve({ type: 'exited', code: 0 }); });
        return { pid: process.pid, waitForTermination: async () => await terminated, stop: async () => endSidecar?.() };
      },
      launchLocalAgent: async () => ({ stream: new PassThrough(), stop: async () => undefined }),
    };
    const { requestDirectPeerTransferToFile } = options.gitWorktreeSeed
      ? await import('@/machines/transfer/directPeerTransport') : { requestDirectPeerTransferToFile: undefined };
    async function openSeedTunnel(request: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'file_transfer' }>): Promise<FiniteTransferMachineTunnel>;
    async function openSeedTunnel(request: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'workspace_sync' }>): Promise<WorkspaceSyncMachineTunnel>;
    async function openSeedTunnel(request: WorkspaceSyncMachineTunnelOpenInput): Promise<FiniteTransferMachineTunnel | WorkspaceSyncMachineTunnel> {
      if (request.flow !== 'file_transfer') throw new Error('This seed fixture does not open a Mutagen tunnel');
      expect(request).toMatchObject({ sourceMachineId: targetRef.machineId,
        targetMachineId: sourceRef.machineId, flow: 'file_transfer' });
      if (!seedTransferLifecycle) throw new Error('The source transfer lifecycle is unavailable');
      return { localPort: await seedTransferLifecycle.ensureListening(), observedPath: 'direct', close: async () => undefined };
    }
    const productionInput = { happyHomeDir: join(root, machineId),
      activeServerDir: join(root, machineId, 'servers', localProfileId), activeServerId: localProfileId, localMachineId: machineId,
      releaseChannel: 'publicdev' as const, credentials: machineCredentials,
      ...(localHomeTarget ? { homeTarget: localHomeTarget } : {}),
      ...(options.callWorkspaceTargetPhase ? { callWorkspaceTargetPhase: options.callWorkspaceTargetPhase } : {}),
      ...(options.callWorkspaceSeedExport ? { callWorkspaceSeedExport: options.callWorkspaceSeedExport } : {}),
      ...(requestDirectPeerTransferToFile ? {
        requestDirectTransferPayloadFile: requestDirectPeerTransferToFile,
        // Replace only native tunnel port selection. Publication, listener,
        // on-demand blob authorization and file materialization remain real.
        openMachineCarrierTunnel: openSeedTunnel,
      } : {}) };
    const production = await runWithServerHttpBaseUrl(localHomeTarget.applicationUrl, async () => {
      if (options.projectRowsFromHttp) {
        options.onCompositionPhase?.(`Project row read for ${machineId}`);
        await readProjectAccountRows({ credentials: machineCredentials, serverId: accountServerId });
      }
      options.onCompositionPhase?.(`Production runtime construction for ${machineId}`);
      return await createProductionDaemonWorkspaceSyncRuntime(productionInput, overrides);
    });
    productions.push(production);
    return production;
  }
  const parent = await compose(sourceRef.machineId);
  const registerSeedExport = async (rpcHandlerManager: RpcHandlerRegistrar) => {
    const lifecycle = seedTransferLifecycle;
    if (!lifecycle) return;
    const prepareSourceSeedExport = parent.workspaceSync.prepareSourceSeedExport;
    if (!prepareSourceSeedExport) throw new Error('The source seed owner is unavailable');
    const [{ registerMachineDirectTransferExportRpcHandlers }, { prepareWorkspaceSyncSeedExport }] = await Promise.all([
      import('@/api/machine/rpcHandlers.directTransferExports'), import('@/machines/transfer/prepareWorkspaceSyncSeedExport'),
    ]);
    registerMachineDirectTransferExportRpcHandlers({ rpcHandlerManager, prepareExportSession: async request => {
      if (request.t !== 'workspace_sync_seed_v1') throw new Error('This source fixture only publishes admitted workspace seeds');
      return await prepareWorkspaceSyncSeedExport({ lifecycle, request, prepareSourceSeedExport });
    } });
  };
  await registerSeedExport(registrar);
  registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: registrar, service: parent.workspaceSync });
  const child = await compose(childRef.machineId);
  const targetParent = options.separateTargetParent && !options.ordinaryTarget ? await compose(targetRef.machineId) : undefined;
  const targetChild = options.withTargetChildRuntime ? await compose(targetChildRef.machineId) : undefined;
  if (targetParent) registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) {
    targetParentHandlers.set(method, (raw, context) => handler(raw as Parameters<typeof handler>[0], context));
  } }, service: targetParent.workspaceSync });
  const rootOwner = createWorkspaceRootOwnershipManager({ lockDirectory });
  const callWorkspaceSourcePhase = async (input: Readonly<{ machineId: string; request: unknown; signal?: AbortSignal }>) => {
    if (input.machineId !== sourceRef.machineId) throw new Error('Wrong physical source controller');
    const receiver = handlers.get('daemon.workspaceSync.handoffSourcePhase.v1');
    if (!receiver || options.sourcePhaseUnavailable) throw new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND);
    // Account copy transport fixture; Session causal admission/ordering is covered by the composed Session owner suite.
    return await receiver(input.request, {
      signal: input.signal ?? new AbortController().signal,
      callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: sourceRef.machineId,
        installationId: 'parent-installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true,
    });
  };
  const prepareInput = { operationId: 'bind-child-copy', accountServerId: serverId, action: { kind: 'copy_once' as const, contentPolicy },
    sourceMachineId: childRef.machineId, targetMachineId: targetRef.machineId,
    sourceWorkspaceRefId: childRef.id, targetWorkspaceRefId: targetRef.id,
    sourceRootPath: childRef.rootPath, targetRootPath: targetRef.rootPath, callWorkspaceSourcePhase };
  const probeSource = async () => await rootOwner.tryAcquire({ ownerId: 'source-custody-probe', canonicalRoot: sourcePath, operation: 'handoff' });
  // The real bootstrap may not have created the target yet, or abort may have
  // restored its original absence. Probe its root loan without inventing bytes.
  const probeTarget = async () => await rootOwner.tryAcquire({ ownerId: 'target-custody-probe', canonicalRoot: targetPath,
    operation: 'handoff', deferRootIdentityBinding: true });
  return { child, parent, prepareInput, targetPath, sourcePath, probeSource, probeTarget,
    settleProjects: async () => { await Promise.all(daemonRuntimes.map(runtime => runtime.whenProjectsSettled())); },
    sourceRef, childRef, childInstallationId, targetRef, projection, managedChild, callWorkspaceSourcePhase, parentRpcHandlers: handlers,
    targetParent, targetChild, targetParentRpcHandlers: targetParentHandlers, targetChildRef, targetChildInstallationId, targetProjection, managedTargetChild,
    credentials, targetCredentials, serverId, parentServerId, managedHomeId, controller: managedChild.controller,
    projectRowsFromHttp: options.projectRowsFromHttp === true, registerSeedExport,
    // External enrollment/socket/native boundaries now report the replacement
    // gap; existing parent custody is deliberately not modified by this fact.
    retireTargetChild: () => { targetChildRetired = true; delete managedTargetChild.enrolledMachineId; },
    driftNativeRoot: () => { nativeProjection = { ...projection, observation: { ...projection.observation, nativeResourceId: 'container-replaced' } }; },
    driftTargetNativeRoot: () => { nativeTargetProjection = { ...targetProjection,
      observation: { ...targetProjection.observation, nativeResourceId: 'target-container-replaced' } }; } };
  } finally {
    finishInitialization();
  }
}

/** Real installed RPC consumers; only the Home/socket/OS boundaries are emulated. */
export async function composeInstalledBindTargetTransport(
  fixture: Awaited<ReturnType<typeof composeBindChildSourcePhaseTestRuntime>>,
  options: Readonly<{
    operationId: string;
    onCompletedPrepare?: () => Promise<void>;
    releaseReason?: 'abort' | 'copy_committed';
    originalRoot?: import('@happier-dev/protocol/actions/externalActionApi').ExternalActionExecutionAuthorizationV1;
    sourceRouting?: import('@happier-dev/protocol/socketRpc').WorkspaceSyncSourceRoutingV1;
    installedIdentities?: ReadonlyMap<string, import('@happier-dev/protocol/machines/identity/installationIdentity').MachineInstallationIdentityV1>;
  }>,
) {
  const [api, rpc, authorization, actions, identity, installationStore, crypto, dispatch, socketSchemas] = await Promise.all([
    import('@/api/apiMachine'), import('@/api/rpc/RpcHandlerManager'), import('@/api/machine/machineRpcAuthorization'),
    import('@happier-dev/protocol/actions/externalActionApi'), import('@happier-dev/protocol/machines/identity/installationIdentity'),
    import('@/daemon/identity/store'), import('tweetnacl'), import('@/rpc/handlers/_actionDispatchAdapter'),
    import('@happier-dev/protocol/socketRpc'),
  ]);
  const { API_TOKEN_FULL_GRANT_V1 } = await import('@happier-dev/protocol/auth/apiTokenGrant');
  const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
  if (!fixture.targetChild || !fixture.targetParent && fixture.targetRef.machineId !== fixture.targetChildRef.machineId) {
    throw new Error('Installed target transport requires each actual target runtime');
  }
  const targetCustodian = readAccountIdFromToken(fixture.targetCredentials.token);
  if (!targetCustodian) throw new Error('Installed target transport requires its own custodian credentials');
  const ids = [...new Set([fixture.sourceRef.machineId, fixture.targetChildRef.machineId, fixture.targetRef.machineId])];
  const installed = new Map(ids.map(machineId => {
    const existing = options.installedIdentities?.get(machineId);
    if (existing) return [machineId, existing] as const;
    const keys = crypto.default.sign.keyPair();
    const installationId = machineId === fixture.sourceRef.machineId ? fixture.controller.installationId
      : machineId === fixture.targetChildRef.machineId ? fixture.targetChildInstallationId : fixture.managedTargetChild.controller.installationId;
    return [machineId, { version: 1 as const, createdAt: 1, installationId,
      publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') }];
  }));
  const installedAt = (machineId: string) => {
    const result = installed.get(machineId);
    if (!result) throw new Error(`No installed OS identity for ${machineId}`);
    return result;
  };
  const identityBoundary = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync')
    .mockReturnValue(installedAt(fixture.sourceRef.machineId));
  onTestFinished(() => identityBoundary.mockRestore());
  const sourceAdmission = options.sourceRouting?.sourceContext?.machineAdmission ?? { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
    installationId: fixture.childInstallationId, role: 'use' as const, encryptionMode: 'plain' as const };
  const targetAdmission = { ...sourceAdmission, custodianAccountId: targetCustodian,
    machineId: fixture.targetChildRef.machineId, installationId: fixture.targetChildInstallationId,
    role: sourceAdmission.actorAccountId === targetCustodian ? 'manage' as const : 'use' as const };
  const sourceRouting = socketSchemas.WorkspaceSyncSourceRoutingV1Schema.parse(options.sourceRouting ?? { v: 1, phase: 'prepare', operationId: options.operationId,
    accountServerId: fixture.serverId, sourceMachineId: sourceAdmission.machineId, sourceRootPath: fixture.childRef.rootPath,
    sourceSessionId: 'actual-source-session', sourceContext: { machineAdmission: sourceAdmission,
      callerAuthority: 'account_automation', callerInputConstraints: { models: null, permissionModes: null }, workspaceWrites: 'allow' } });
  // A genuine Home response vector, not a claim that the issuer minted this Root.
  const root = actions.ExternalActionExecutionAuthorizationV1Schema.parse(options.originalRoot ?? { v: 1, token: 'original-source-root', binding: {
    accountId: 'borrower', principalId: 'borrower', credentialId: 'source-pat', grant: API_TOKEN_FULL_GRANT_V1,
    custodianAccountId: 'owner', serverIdentityId: fixture.serverId, machineId: sourceAdmission.machineId,
    installationId: sourceAdmission.installationId, actionId: 'session.handoff', requestId: options.operationId,
    requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: sourceAdmission.machineId },
    handoffAdmission: { sessionId: sourceRouting.sourceSessionId, sourceMachineId: sourceAdmission.machineId,
      sourceInstallationId: sourceAdmission.installationId, targetMachineId: targetAdmission.machineId,
      targetInstallationId: targetAdmission.installationId },
  } });
  const observed = { preflightEndpoint: undefined as import('@happier-dev/protocol/machines/identity/installationIdentity').MachineInstallationPublicIdentityV1 | undefined,
    prepared: false, releaseDestination: undefined as string | undefined, rootRetired: false,
    releaseReasons: [] as string[],
    phaseOutcomes: [] as Array<{ machineId: string; phase: string; result?: unknown; error?: string; errorCode?: string }>,
    rpcDiagnostics: [] as Array<{ machineId: string; message: string; method?: string; error?: string }> };
  let preparedRequestTargetRefId: string | undefined;
  const homeResponse = async (url: string, raw: unknown) => {
    if (!url.endsWith('/admission/verify')) return undefined;
    if (!raw || typeof raw !== 'object' || !('proof' in raw) || !('context' in raw) || !('method' in raw)) throw new Error('Missing installed Home proof');
    const signerMachineId = new URL(url).pathname.split('/')[3]!;
    const signer = installedAt(signerMachineId);
    const accountId = signerMachineId === fixture.sourceRef.machineId ? 'owner' : targetCustodian;
    const seed = 'workspaceSyncSeedRouting' in raw ? socketSchemas.WorkspaceSyncSeedRoutingV1Schema.parse(raw.workspaceSyncSeedRouting) : undefined;
    const b = seed?.sourceWriterTarget ?? ('workspaceSyncSourceWriterTargetRouting' in raw
      ? socketSchemas.WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(raw.workspaceSyncSourceWriterTargetRouting) : undefined);
    if (b?.target.phase === 'release' && signerMachineId === fixture.sourceRef.machineId) {
      throw new Error('Rootless cleanup has no source key-discovery purpose');
    }
    const target = 'workspaceSyncTargetRouting' in raw ? socketSchemas.WorkspaceSyncTargetRoutingV1Schema.parse(raw.workspaceSyncTargetRouting) : undefined;
    const source = 'workspaceSyncSourceRouting' in raw ? socketSchemas.WorkspaceSyncSourceRoutingV1Schema.parse(raw.workspaceSyncSourceRouting) : undefined;
    const original = 'callerInputAuthorization' in raw ? actions.ExternalActionExecutionAuthorizationV1Schema.parse(raw.callerInputAuthorization) : undefined;
    if (original) {
      if (observed.rootRetired) throw new Error('The historical borrower Root was retired');
      expect(original).toEqual(root);
    }
    if (b) {
      expect(b.sourceWriter).toEqual(fixture.controller);
      expect(b.source).toEqual(sourceRouting);
      expect(b.target).toMatchObject({ operationId: options.operationId, accountServerId: fixture.serverId,
        targetMachineId: fixture.targetChildRef.machineId, targetRootPath: fixture.targetChildRef.rootPath });
    } else expect(source).toEqual(sourceRouting);
    const admission = socketSchemas.SocketRpcMachineAdmissionContextV1Schema.parse(raw.context);
    const sourceExecution = 'workspaceSyncSourceExecution' in raw
      ? socketSchemas.WorkspaceSyncSourceExecutionV1Schema.parse(raw.workspaceSyncSourceExecution) : undefined;
    const purpose = { context: admission, method: String(raw.method), ...(original ? { callerInputAuthorization: original } : {}),
      ...(sourceExecution ? { workspaceSyncSourceExecution: sourceExecution } : {}),
      ...(seed ? { workspaceSyncSeedRouting: seed } : b ? { workspaceSyncSourceWriterTargetRouting: b } : {}), ...(source ? { workspaceSyncSourceRouting: source } : {}),
      ...(target ? { workspaceSyncTargetRouting: target } : {}) };
    expect(identity.verifyMachineInstallationProof({ publicKey: signer.publicKey,
      proof: identity.MachineInstallationProofV1Schema.parse(raw.proof), payload: { version: 1,
        machineId: signerMachineId, installationId: signer.installationId, accountId, rpcAdmission: purpose } })).toBe(true);
    const destinationMachineId = String(raw.method).slice(0, String(raw.method).indexOf(':'));
    const destination = installedAt(destinationMachineId);
    return { status: 200, data: { v: 1, ok: true, ...(b?.target.phase !== 'release' && b ? { destinationInstallation: {
      machineId: destinationMachineId, installationId: destination.installationId, installationPublicKey: destination.publicKey } } : {}) } };
  };
  const managers = new Map(ids.map(machineId => {
    const own = installedAt(machineId);
    const accountId = machineId === fixture.sourceRef.machineId ? 'owner' : targetCustodian;
    const credentials = machineId === fixture.sourceRef.machineId ? fixture.credentials : fixture.targetCredentials;
    const manager = new rpc.RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain', logger: (message, fields) => {
      // Observe the real ingress decision without intercepting handlers or
      // decrypting replies through an alternate cipher. Never record carriers.
      const record = fields && typeof fields === 'object' ? fields : {};
      const error = 'error' in record ? record.error : undefined;
      observed.rpcDiagnostics.push({ machineId, message,
        ...('method' in record && typeof record.method === 'string' ? { method: record.method } : {}),
        ...(error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
          ? { error: error.message } : {}) });
    },
      authorizeRequest: request => authorization.authorizeMachineRpcRequest(request, { machineId,
        resolveCustodianAccountId: async () => accountId, resolveInstallationId: () => own.installationId,
        verifyMachineAdmission: admitted => authorization.verifyMachineRpcAdmissionCurrent({ ...admitted,
          ...(admitted.workspaceSyncSeedRouting ? { workspaceSyncSeedReceiver: { machineId, installationId: own.installationId, accountId } }
            : admitted.workspaceSyncTargetRouting ? { workspaceSyncTargetReceiver: { machineId, installationId: own.installationId } }
            : { workspaceSyncSourceWriterTargetReceiver: { machineId, installationId: own.installationId, accountId } }),
          privateKey: own.privateKey, daemonToken: credentials.token, serverHttpBaseUrl: 'https://bind-child-home.invalid' }) }) });
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: manager, service: machineId === fixture.sourceRef.machineId
      ? fixture.parent.workspaceSync : machineId === fixture.targetChildRef.machineId ? fixture.targetChild!.workspaceSync : fixture.targetParent!.workspaceSync });
    return [machineId, manager];
  }));
  const sourceManager = managers.get(fixture.sourceRef.machineId);
  if (!sourceManager) throw new Error('The installed source receiver is unavailable');
  await fixture.registerSeedExport(sourceManager);
  const clients = new Map(ids.map(machineId => {
    const credentials = machineId === fixture.sourceRef.machineId ? fixture.credentials : fixture.targetCredentials;
    const client = runWithServerHttpBaseUrl('https://bind-child-home.invalid', () =>
      new api.ApiMachineClient(credentials.token, { id: machineId, encryptionMode: 'plain', encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }));
    Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string'
        || !('requestId' in raw) || typeof raw.requestId !== 'string' || !('params' in raw)
        || !('workspaceSyncSourceWriterTargetRouting' in raw) && !('workspaceSyncSeedRouting' in raw)) throw new Error('Missing installed TARGET carrier');
      const seed = 'workspaceSyncSeedRouting' in raw ? socketSchemas.WorkspaceSyncSeedRoutingV1Schema.parse(raw.workspaceSyncSeedRouting) : undefined;
      const b = seed?.sourceWriterTarget ?? socketSchemas.WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse('workspaceSyncSourceWriterTargetRouting' in raw ? raw.workspaceSyncSourceWriterTargetRouting : undefined);
      if (b.target.phase !== 'release') {
        if (!('externalActionExecution' in raw)) throw new Error('Effectful target transport did not sign its original Root');
        const signed = actions.ExternalActionMachineRpcExecutionV1Schema.parse(raw.externalActionExecution);
        const { verifyExternalActionMachineRpcRequestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
        expect(signed).toMatchObject({ authorization: root, installationId: installedAt(machineId).installationId });
        expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: signed.effectActionId,
          target: signed.target, installationId: signed.installationId, event: socketSchemas.SOCKET_RPC_EVENTS.CALL,
          method: raw.method, requestId: raw.requestId, params: raw.params,
          ...(seed ? { workspaceSyncSeedRouting: seed } : { workspaceSyncSourceWriterTargetRouting: b }),
          publicKey: new Uint8Array(Buffer.from(installedAt(machineId).publicKey, 'base64url')),
          signature: signed.machineSignature })).toBe(true);
      } else expect(raw).not.toHaveProperty('externalActionExecution');
      const destinationMachineId = raw.method.slice(0, raw.method.indexOf(':'));
      const receiver = managers.get(destinationMachineId);
      if (!receiver) throw new Error('Target transport selected an unknown installed recipient');
      if (observed.rootRetired && (destinationMachineId !== fixture.targetRef.machineId || b.target.phase !== 'release')) {
        throw new Error('Cleanup contacted retired chosen target authority');
      }
      const release = b.target.phase === 'release';
      const admission = seed ? sourceRouting.sourceContext!.machineAdmission : release ? { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.sourceRef.machineId,
        installationId: fixture.controller.installationId, role: 'manage' as const, encryptionMode: 'plain' as const } : targetAdmission;
      const incoming = { ...raw, machineAdmission: admission, callerAuthority: release ? 'present_user' as const : sourceRouting.sourceContext!.callerAuthority,
        ...(!release ? { callerInputAuthorization: root, callerInputConstraints: sourceRouting.sourceContext!.callerInputConstraints } : {}) };
      identityBoundary.mockReturnValue(installedAt(destinationMachineId));
      try {
        if (fixture.projectRowsFromHttp) {
          // These installed recipients are separate daemon processes in the
          // product. Scope this in-process network fixture through the real
          // owner's HTTP reader, never by adding TARGET rows to P1's graph.
          await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
            credentials: destinationMachineId === fixture.sourceRef.machineId ? fixture.credentials : fixture.targetCredentials,
            serverId: fixture.serverId,
          }));
          await fixture.settleProjects();
        }
        const result = await receiver.handleRequest(incoming);
        if (release) observed.releaseDestination = destinationMachineId;
        if (machineId === fixture.sourceRef.machineId && b.target.phase === 'prepare' && options.onCompletedPrepare) {
          expect(typeof result).toBe('string');
          expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
          observed.prepared = true;
          identityBoundary.mockReturnValue(installedAt(machineId));
          await options.onCompletedPrepare();
        }
        return { ok: true, result };
      } finally {
        identityBoundary.mockReturnValue(installedAt(machineId));
        if (fixture.projectRowsFromHttp) {
          await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
            credentials, serverId: fixture.serverId,
          }));
          await fixture.settleProjects();
        }
      }
    } }));
    return [machineId, client];
  }));
  const call = async (descriptor: import('@/workspaces/sync/workspaceSyncTargetAuthority').WorkspaceSyncTargetPhaseDescriptor, context: RpcHandlerContext) => {
    if (descriptor.routing.phase === 'prepare') {
      const { WorkspaceSyncTargetBootstrapPrepareV1Schema } = await import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas');
      const request = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(descriptor.request);
      expect(request.bootstrapOperationId).toBe(options.operationId);
      if (preparedRequestTargetRefId) expect(request.targetWorkspaceRefId).toBe(preparedRequestTargetRefId);
      preparedRequestTargetRefId = request.targetWorkspaceRefId;
    }
    if (descriptor.routing.phase === 'release') {
      const { WorkspaceSyncTargetBootstrapReleaseV1Schema } = await import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas');
      const request = WorkspaceSyncTargetBootstrapReleaseV1Schema.parse(descriptor.request);
      expect(request).toMatchObject({
        // Project preflight can qualify P2's existing row before prepare. The
        // cleanup locator must retain the exact request definition, whether it
        // originally named logical D or that already-qualified physical row.
        bootstrapOperationId: options.operationId, targetWorkspaceRefId: preparedRequestTargetRefId ?? fixture.targetChildRef.id });
      // A failed preparation must reach abort cleanup rather than be masked by
      // the successful-copy fixture's expected commit reason. Success assertions
      // below the public materialization result still require committed cleanup.
      if (request.reason !== 'abort') expect(request.reason).toBe(options.releaseReason ?? 'abort');
      observed.releaseReasons.push(request.reason);
      expect(descriptor.machineId).toBe(fixture.targetRef.machineId);
      expect(descriptor.signal?.aborted).not.toBe(true);
      expect(context.callerInputAuthorization).toBeUndefined();
      expect(context.workspaceSyncTargetRouting).toBeUndefined();
    }
    const machineId = context.machineAdmission?.machineId === fixture.targetChildRef.machineId
      ? fixture.targetChildRef.machineId : fixture.sourceRef.machineId;
    const client = clients.get(machineId)!;
    identityBoundary.mockReturnValue(installedAt(machineId));
    let result: unknown;
    try {
      result = await client.callWorkspaceSyncTargetPhase({ ...descriptor,
        credentials: machineId === fixture.sourceRef.machineId ? fixture.credentials : fixture.targetCredentials,
        context: dispatch.buildActionExecutorContextForRpc({ ...context, serverId: fixture.serverId }) });
      // Observe only the canonical caller's decoded result. Do not decrypt the
      // network acknowledgement through a second codec or record authority bytes.
      observed.phaseOutcomes.push({ machineId, phase: descriptor.routing.phase, result });
    } catch (error) {
      observed.phaseOutcomes.push({ machineId, phase: descriptor.routing.phase,
        ...(error instanceof Error ? { error: error.message } : {}),
        ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? { errorCode: error.code } : {}) });
      if (error instanceof Error) error.message += `; installed RPC diagnostics: ${JSON.stringify(observed.rpcDiagnostics)}`;
      throw error;
    }
    if (machineId === fixture.sourceRef.machineId && descriptor.routing.phase === 'preflight') {
      if (!result || typeof result !== 'object' || !('physicalEndpoint' in result)) throw new Error('The installed preflight did not return its verified recipient');
      observed.preflightEndpoint = identity.MachineInstallationPublicIdentityV1Schema.parse(result.physicalEndpoint);
    }
    return result;
  };
  const sourceContext: RpcHandlerContext = { machineAdmission: sourceAdmission, callerAuthority: 'account_automation', callerInputAuthorization: root,
    callerInputConstraints: sourceRouting.sourceContext!.callerInputConstraints, workspaceSyncSourceRouting: sourceRouting,
    verifyMachineAdmissionCurrent: async () => authorization.verifyMachineRpcAdmissionCurrent({ context: sourceAdmission,
      method: `${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`,
      workspaceSyncSourceRouting: sourceRouting, callerInputAuthorization: root, workspaceSyncSourceReceiver: fixture.controller,
      privateKey: installedAt(fixture.sourceRef.machineId).privateKey, daemonToken: fixture.credentials.token,
      serverHttpBaseUrl: 'https://bind-child-home.invalid' }) };
  return { call, callSeed: async (descriptor: Readonly<{ machineId: string;
    request: import('@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas').WorkspaceSyncSeedExportPrepareV1;
    signal?: AbortSignal }>, context: RpcHandlerContext) => {
      const machineId = fixture.targetRef.machineId;
      const client = clients.get(machineId);
      if (!client) throw new Error('The installed physical target seed sender is unavailable');
      identityBoundary.mockReturnValue(installedAt(machineId));
      let result: unknown;
      try {
        result = await client.callWorkspaceSyncSeedExport({ ...descriptor, credentials: fixture.targetCredentials,
          context: dispatch.buildActionExecutorContextForRpc({ ...context, serverId: fixture.serverId }) });
      } catch (error) {
        observed.phaseOutcomes.push({ machineId, phase: 'seed',
          ...(error instanceof Error ? { error: error.message } : {}),
          ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? { errorCode: error.code } : {}) });
        throw error;
      }
      // Keep finite phase diagnostics without recording transfer authorization
      // tokens, the original Root, or encrypted request/reply material.
      observed.phaseOutcomes.push({ machineId, phase: 'seed', ...(result && typeof result === 'object' ? {
        result: {
          ...('success' in result && typeof result.success === 'boolean' ? { success: result.success } : {}),
          ...('error' in result && typeof result.error === 'string' ? { error: result.error } : {}),
          ...('code' in result && typeof result.code === 'string' ? { code: result.code } : {}),
        },
      } : {}) });
      return result;
    }, homeResponse, sourceContext, sourceRouting, observed,
    withInstalledMachine: async <T>(machineId: string, run: () => Promise<T>): Promise<T> => {
      const previous = installationStore.readInstallationIdentityIfExistsSync();
      identityBoundary.mockReturnValue(installedAt(machineId));
      try { return await run(); } finally { identityBoundary.mockReturnValue(previous); }
    }, retire: () => {
    observed.rootRetired = true; fixture.retireTargetChild();
    Reflect.set(clients.get(fixture.targetChildRef.machineId)!, 'socket', createApiSessionSocketStub({ connected: false }));
  } };
}
