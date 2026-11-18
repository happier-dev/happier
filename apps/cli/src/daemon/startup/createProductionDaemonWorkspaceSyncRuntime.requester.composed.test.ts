import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { readAgentIsolationMemberBindingForAccount } from '@/daemon/agentIsolation/memberBindings';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { spawnSessionHolderChild } from '@/subprocess/supervision/sessionHolder';
import { registerSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { scanWorkspaceManifest } from '@/scm/workspace/workspaceExportPackaging/scanWorkspaceManifest';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import tweetnacl from 'tweetnacl';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineUpdateOperationProtocolCapabilitiesResponseV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, createDirectRouteGrantSigningInputV2 } from '@happier-dev/protocol';
import { ProjectAccountRowV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRefRow } from '@/workspaces/projectAccountRows.testkit';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { sealExternalActionRequesterAccountContextV1, sealSessionRequesterHandoffWorkspaceCaptureRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { encodeStoredCredentials } from '@/persistence';
import { dispatchOriginalAccountAction, prepareExternalActionHandoffPreflightAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createWorkspaceSyncRelationshipCredentialCustody } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { recoverPrivateWorkspaceSyncExecutions } from './recoverPrivateWorkspaceSyncExecutions';
import { workspaceCheckoutNativeBoundary as native } from '@/workspaces/activation/workspaceCheckoutNative.testkit';
import { createRequesterWorkspaceSyncFixture } from './createRequesterWorkspaceSyncFixture.testkit';
import { registerMachineWorkspaceSyncRpcHandlers, resolvePrivateWorkspaceSyncTargetExecution } from '@/api/machine/rpcHandlers.workspaceSync';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncSourceWriterTargetRoutingV1Schema, SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { WorkspaceSyncRelationshipCreateResultV1Schema, WorkspaceSyncRelationshipsListRpcResultV1Schema, SessionHandoffWorkspaceCaptureResultV3Schema, WorkspaceSyncTargetBootstrapPrepareV1Schema, WorkspaceSyncTargetBootstrapPrepareResultV1Schema, WorkspaceSyncTargetBootstrapReleaseV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { deriveWorkspaceSyncEndpointId } from '@/workspaces/sync/transport/workspaceSyncBrokerProtocol';
import { computeWorkspaceSyncRootFingerprint } from '@/workspaces/sync/workspaceSyncTargetBootstrap';

const socketIo = vi.hoisted(() => vi.fn());
const executionBoundary = vi.hoisted(() => ({ member: true, returnPromotionFailureRoot: '',
  recovery: undefined as undefined | { pending: boolean; root: string; calls: number } }));
vi.mock('socket.io-client', () => ({ io: socketIo }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const { requesterWorkspaceSyncInstallationFilesystemBoundary } = await import('./requesterWorkspaceSyncFilesystem.testkit');
  return { ...requesterWorkspaceSyncInstallationFilesystemBoundary(actual),
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => executionBoundary.recovery
      && String(path).endsWith('/happier-process-custody') ? true : actual.existsSync(path) };
});
// Only OS accounts, filesystem traversal and fork/exec are substituted. The
// installed receiver, requester Account admission, common native preparation,
// framed worker, controller and Account-row transaction all remain real.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  const { workspaceCheckoutFilesystemBoundary, workspaceCheckoutNativeBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
  const filesystem = workspaceCheckoutFilesystemBoundary(actual);
  return { ...filesystem, rename: (...args: Parameters<typeof actual.rename>) => {
    if (executionBoundary.returnPromotionFailureRoot && workspaceCheckoutNativeBoundary.identity.getStore() === 'member'
      && String(args[1]).startsWith(executionBoundary.returnPromotionFailureRoot + '/')) {
      throw Object.assign(new Error('Native return promotion denied'), { code: 'EACCES' });
    }
    return filesystem.rename(...args);
  } };
});
vi.mock('../../../../../packages/cli-common/src/process/execFileWithDeadline', async original => {
  const actual = await original<typeof import('../../../../../packages/cli-common/src/process/execFileWithDeadline')>();
  const { requesterWorkspaceSyncExecBoundary } = await import('./requesterWorkspaceSyncProcess.testkit');
  return { ...actual, execFileWithDeadline: (...args: Parameters<typeof actual.execFileWithDeadline>) =>
    requesterWorkspaceSyncExecBoundary(actual, args) };
});
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { spawnRequesterWorkspaceSyncProcessBoundary } = await import('./requesterWorkspaceSyncProcess.testkit');
  return { ...actual, spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
    if (executionBoundary.recovery && (args[0] === 'workspace-confined-inspect' || args[0] === 'workspace-confined-recover')) {
      const recovery = executionBoundary.recovery;
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
        stderr: new PassThrough(), kill: () => true });
      let input: { operationId: string; recoveryDirectory: string } | undefined;
      child.stdin.on('data', (bytes: Buffer) => {
        if (!input) {
          input = JSON.parse(bytes.toString()) as typeof input;
          child.stdout.write(JSON.stringify({ v: 1, t: 'workspace-confined-prepared' }) + '\n');
        } else {
          const request = input;
          void (async () => {
            const result = args[0] === 'workspace-confined-inspect'
              ? { status: 'recovery_record', operationId: request.operationId, rootPath: recovery.root }
              : recovery.pending ? { status: 'recovery_needed', recoveryPath: join(recovery.root, 'displaced') }
                : { status: 'settled' };
            if (args[0] === 'workspace-confined-recover') {
              recovery.calls++;
              if (!recovery.pending) await rm(join(request.recoveryDirectory, `workspace-recovery-${request.operationId}.json`));
            }
            child.stdout.end(JSON.stringify({ v: 1, t: 'workspace-confined-result', ...result }) + '\n');
            child.stderr.end(); child.emit('close', 0, null);
          })().catch(error => child.emit('error', error));
        }
      });
      // The native process/pipe ABI is the substituted OS boundary.
      return child as unknown as ReturnType<typeof actual.spawn>;
    }
    return spawnRequesterWorkspaceSyncProcessBoundary(actual, command, args, options, executionBoundary.member);
  } };
});
// Native and HTTP boundaries stay installed until every fixture's onTestFinished cleanup settles.
beforeEach(() => { native.reset(); vi.restoreAllMocks(); executionBoundary.recovery = undefined; executionBoundary.returnPromotionFailureRoot = ''; });

it.skipIf(process.platform !== 'linux')('captures only a retained Session into the requester member and releases SOURCE custody after failed TARGET preparation', async () => {
  executionBoundary.member = true;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'use', socketIo });
  const directory = await mkdtemp(join(tmpdir(), 'native-return-capture-'));
  const guestRoot = join(directory, 'guest');
  await mkdir(guestRoot);
  runScmExecutable(guestRoot, 'git', ['init', '-q']);
  await writeFile(join(guestRoot, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(guestRoot, 'ignored.txt'), 'sandbox-only ignored bytes');
  await writeFile(join(guestRoot, 'returned.txt'), 'sandbox bytes');
  runScmExecutable(guestRoot, 'git', ['add', 'returned.txt']);
  runScmExecutable(guestRoot, 'git', ['-c', 'user.name=Return fixture', '-c', 'user.email=return-fixture@example.test', 'commit', '-qm', 'base']);
  const baseline = await scanWorkspaceManifest({ workspaceRoot: guestRoot, safeFilterPolicy: { excludeAdministrativePaths: true } });
  const holderPath = resolveSessionHolderExecutablePath()!;
  const helperPath = resolveProcessCustodySupportExecutable('linux')!;
  const lifetime = new AbortController();
  const sessionId = 'native-return-session';
  const target = { id: sessionId, holderPath, helperPath, socketDirectory: directory,
    exec: (command: string) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes.toString(); });
      child.stderr.on('data', bytes => { stderr += bytes.toString(); });
      child.once('error', reject); child.once('close', status => resolve({ status: status ?? 1, stdout, stderr }));
    }),
    openChannel: (argv: readonly string[]) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
      const channel = Duplex.from({ readable: child.stdout, writable: child.stdin });
      child.once('close', () => channel.destroy()); return channel;
    },
  };
  const primarySocketPath = join(directory, 'holder.sock');
  const agent = spawnSessionHolderChild({ executablePath: holderPath, socketPath: primarySocketPath,
    command: 'sleep', args: ['600'], cwd: guestRoot, target });
  await new Promise<void>((resolve, reject) => { agent.once('spawn', resolve); agent.once('error', reject); });
  registerSessionTargetWorkspace({ sessionId, lifetime: lifetime.signal, primarySocketPath, target,
    workspace: { hostRoot: setup.sourcePath, targetRoot: guestRoot }, baseline });
  onTestFinished(async () => { lifetime.abort(); await agent.terminateGroup({ graceMs: 100 }); await rm(directory, { recursive: true, force: true }); });
  const context: RpcHandlerContext = { signal: lifetime.signal, callerAuthority: 'present_user',
    callerInputAuthorization: setup.account.authorization, verifyMachineAdmissionCurrent: async () => true,
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: setup.installed.machineId,
      installationId: setup.installed.installation.installationId, role: 'use', encryptionMode: 'plain' } };
  const captured = await setup.fixture.parent.workspaceSync.captureSessionWorkspaceReturn!({ sessionId }, context);
  expect(captured.workspace.rootPath.startsWith(setup.member.workspaceRoot + '/')).toBe(true);
  expect(captured.baseline).toEqual(baseline);
  expect(captured.excludedPaths).toContain('ignored.txt');
  expect(await native.identity.run('member', () => readFile(join(captured.workspace.rootPath, 'returned.txt'), 'utf8'))).toBe('sandbox bytes');
  await expect(native.identity.run('member', () => readFile(join(captured.workspace.rootPath, 'ignored.txt'))))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await expect(setup.fixture.parent.workspaceSync.captureSessionWorkspaceReturn!({ sessionId: 'unretained' }, context))
    .rejects.toMatchObject({ code: 'workspace_source_operation_unavailable' });
  expect(await agent.request({ op: 'status' })).toMatchObject({ ok: true, exit: null });
  const retained = setup.fixture.parent.handoffAdapter.listPrivateExecutions?.().find(value => value.input.sourceWorkspaceRefId === captured.workspace.workspaceId);
  expect(retained).toBeDefined();
  // An independently selected destination cannot borrow this capture's native
  // checkout. The ordinary SOURCE failure path must settle its native loan
  // before closing the temporary source worker and rolling back its stage.
  await expect(setup.fixture.parent.handoffAdapter.prepare({ ...retained!.input,
    targetWorkspaceRefId: setup.targetRef.id, targetRootPath: setup.targetPath }))
    .rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
  expect(setup.fixture.parent.handoffAdapter.resolvePrivateExecution?.({ operationId: retained!.input.operationId })).toBeNull();
  await expect(native.identity.run('member', () => readFile(join(captured.workspace.rootPath, 'returned.txt'))))
    .rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readProjectAccountRows({ credentials: setup.credentials, serverId: setup.installed.homeServerIdentityId,
    selection: { kinds: ['workspace-ref'] } })).workspaceRefs.some(ref => ref.id === captured.workspace.workspaceId)).toBe(false);
  // A real member filesystem refusal after bytes arrived must roll back the
  // materializer's stage and release the existing capture, before publication.
  const rootsBeforeFailure = await native.identity.run('member', () => readdir(setup.member.workspaceRoot));
  executionBoundary.returnPromotionFailureRoot = setup.member.workspaceRoot;
  await expect(setup.fixture.parent.workspaceSync.captureSessionWorkspaceReturn!({ sessionId }, context))
    .rejects.toMatchObject({ code: 'EACCES' });
  executionBoundary.returnPromotionFailureRoot = '';
  expect(setup.fixture.parent.handoffAdapter.listPrivateExecutions?.().filter(value => value.execution.onSourceRootReleased)).toEqual([]);
  expect(await native.identity.run('member', () => readdir(setup.member.workspaceRoot))).toEqual(rootsBeforeFailure);
}, 240_000); // The existing native composition lane's budget covers two worker preparations.

it.skipIf(process.platform !== 'linux').each(['requester', 'installed'] as const)('settles the normal SOURCE list after %s lifecycle Actions through two daemon compositions', async owner => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', sourceCustodianAccountId: 'member-a',
    remoteTarget: true, socketIo });
  const created = WorkspaceSyncRelationshipCreateResultV1Schema.parse(owner === 'installed'
    ? await setup.fixture.parent.workspaceSync.relationshipOwner.create(setup.request)
    : await setup.rpc.handleRequest({
    method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
    params: setup.request, callerAuthority: 'present_user', callerInputAuthorization: setup.authorization,
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'member-a', machineId: setup.installed.machineId,
      installationId: setup.installed.installation.installationId, role: 'manage', encryptionMode: 'plain' },
  }));
  // The installed Account has consumed the creation push before the next
  // requester Action, as on the loaded controller in REPLAY84.
  await readProjectAccountRows({ credentials: setup.installed.bootstrap.credentials,
    serverId: setup.installed.serverId, publication: 'installed' });
  // Both daemon compositions participate: SOURCE owns the installed/native
  // list and retained requester graph; TARGET receives the physical phases.
  expect(setup.fixture.targetParent).toBeDefined();
  const admission = { actorAccountId: 'member-a', custodianAccountId: 'member-a', machineId: setup.installed.machineId,
    installationId: setup.installed.installation.installationId, role: 'manage' as const, encryptionMode: 'plain' as const };
  const list = async () => WorkspaceSyncRelationshipsListRpcResultV1Schema.parse(await setup.rpc.handleRequest({
    method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST}`,
    params: { workspaceRefId: setup.sourceRef.id }, callerAuthority: 'present_user', machineAdmission: admission,
  }, undefined, 'authenticated_home_socket'));
  const invoke = async (method: string, params: { relationshipId: string }) => {
    if (owner === 'installed') {
      if (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE) return setup.fixture.parent.workspaceSync.relationshipOwner.stop(params.relationshipId);
      return setup.fixture.parent.workspaceSync.relationshipOwner.setEnabled(params.relationshipId, method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME);
    }
    const actionId = method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE ? 'workspace.sync.relationship.terminate'
      : method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE ? 'workspace.sync.relationship.disable' : 'workspace.sync.relationship.enable';
    const envelope = { v: 1 as const, requestId: `lifecycle-${actionId}`, target: setup.wire.binding.target,
      input: { controllerMachineId: setup.installed.machineId, relationshipId: params.relationshipId } };
    const wire = setup.adoptHomeAuthorization({ ...setup.wire, token: `root-${actionId}`, binding: { ...setup.wire.binding,
      actionId, requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
    // The UI seals each Action's own root for its RPC. Reusing the creation
    // authorization or invoking a bare handler exercises a different owner.
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: wire,
      purpose: { kind: 'machine_rpc', method, params }, credentials: encodeStoredCredentials(setup.credentials),
      installationPublicKey: Buffer.from(setup.installed.installation.publicKey, 'base64url'), randomBytes: tweetnacl.randomBytes });
    return setup.rpc.handleRequest({ method: `${setup.installed.machineId}:${method}`, params,
      callerAuthority: 'present_user', callerInputAuthorization: authorization, machineAdmission: admission });
  };
  const lifecycle = async (method: string) => {
    const before = setup.requesterRowRequests.length;
    const result = await invoke(method, { relationshipId: created.relationshipId });
    if (owner === 'requester') expect(result).toEqual({ ok: true });
    if (owner !== 'installed') return;
    const requests = setup.requesterRowRequests.slice(before);
    const mutationIndex = requests.findIndex(event => event.path.endsWith('/mutate'));
    expect(mutationIndex).toBeGreaterThanOrEqual(0);
    const postWriteReads = requests.slice(mutationIndex + 1).filter(event =>
      event.path.endsWith('/list') || event.path.endsWith('/read'));
    expect(postWriteReads, `${owner} lifecycle must reconcile its acknowledged rows`).toHaveLength(0);
  };
  expect((await list()).relationships).toEqual([expect.objectContaining({ definition: expect.objectContaining({
    relationshipId: created.relationshipId, enabled: true }) })]);
  await lifecycle(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE);
  const paused = await list();
  await lifecycle(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME);
  const resumed = await list();
  await lifecycle(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE);
  expect(setup.rows.find(row => row.key.kind === 'relationship-graph')?.content).toMatchObject({
    t: 'plain', v: { value: { relationships: [] } },
  });
  expect((await list()).relationships).toEqual([]);
  expect(paused.relationships).toEqual([expect.objectContaining({ definition: expect.objectContaining({ enabled: false }) })]);
  expect(resumed.relationships).toEqual([expect.objectContaining({ definition: expect.objectContaining({ enabled: true }) })]);
  expect(await setup.fixture.parentManagedWorkspaceSync!.list()).toEqual([]);
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
});

it.skipIf(process.platform !== 'linux')('lists the requester Account graph before native capture with one ingress projection and no idle reads', async () => {
  executionBoundary.member = true;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'use', socketIo });
  const { rows, request, installed, account } = setup;
  const remoteSource = { ...setup.sourceRef, id: 'requester-remote-source', machineId: 'own-remote-controller', rootPath: '/accepted/remote-source' };
  rows.push(createPlainProjectAccountRefRow(remoteSource), ProjectAccountRowV1Schema.parse({
    key: { kind: 'relationship-graph' }, revision: 1, content: { t: 'plain', v: {
      key: { kind: 'relationship-graph' }, value: { relationships: [{ v: 1, relationshipId: 'requester-remote-link',
        controllerMachineId: remoteSource.machineId, alphaWorkspaceRefId: remoteSource.id,
        betaWorkspaceRefId: setup.sourceRef.id, mode: 'keep_both_in_sync', contentPolicy: request.actionInput.contentPolicy,
        enabled: true, createdAtMs: 1, updatedAtMs: 1 }] },
    } },
  }));
  const before = setup.requesterProjectionReads();
  const scoped = await setup.fixture.parent.workspaceSync.forRequester?.({ signal: new AbortController().signal,
    callerAuthority: 'present_user', callerInputAuthorization: account.authorization,
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: installed.machineId,
      installationId: installed.installation.installationId, role: 'use', encryptionMode: 'plain' } });
  if (!scoped) throw new Error('Requester Sync owner is unavailable');
  const inventory = await scoped.controller.listRelationships({ workspaceRefId: setup.sourceRef.id });
  expect(inventory.discoveryAvailable).toBe(true);
  expect(inventory.remoteRelationships.map(value => value.definition.relationshipId)).toEqual(['requester-remote-link']);
  expect(setup.requesterProjectionReads() - before).toBe(1);
  await Promise.resolve();
  expect(setup.requesterProjectionReads() - before).toBe(1);
  expect(setup.requesterRowRequests.filter(event => event.path.endsWith('/mutate'))).toEqual([]);
  expect(native.phases).toEqual([]);
});

it.skipIf(process.platform !== 'linux')('offers cold member Sync roots without preparing before Add Machine admission', async () => {
  executionBoundary.member = true;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'use', cold: true, socketIo });
  const read = () => setup.rpc.handleRequest({
    method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST}`,
    params: { requesterAvailability: true }, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: setup.installed.machineId,
      installationId: setup.installed.installation.installationId, role: 'use', encryptionMode: 'plain' },
  }, undefined, 'authenticated_home_socket');
  const raw = await read();
  expect(raw).toMatchObject({ requesterAvailability: { kind: 'available' } });
  const result = WorkspaceSyncRelationshipsListRpcResultV1Schema.parse(raw);
  expect(result).toMatchObject({ requesterAvailability: { kind: 'available', preparation: 'member_not_prepared',
    homeDir: setup.member.home, workspaceRoot: setup.member.workspaceRoot } });
  expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir: configuration.activeServerDir,
      homeServerIdentityId: setup.member.homeServerIdentityId, ...setup.member.requester }, 'member-a')).toBeNull();
  // The sibling warm journey asserts completed linking. This regression owns
  // cold admission: native preparation must run even if a later target phase refuses.
  await setup.rpc.handleRequest({ method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
    params: setup.request, callerAuthority: 'present_user', callerInputAuthorization: setup.authorization,
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: setup.installed.machineId,
      installationId: setup.installed.installation.installationId, role: 'use', encryptionMode: 'plain' } });
  expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir: configuration.activeServerDir,
      homeServerIdentityId: setup.member.homeServerIdentityId, ...setup.member.requester }, 'member-a')).toMatchObject({ uid: 2401 });
  const warm = WorkspaceSyncRelationshipsListRpcResultV1Schema.parse(await read());
  expect(warm.requesterAvailability).toEqual({ kind: 'available', homeDir: setup.member.home,
    workspaceRoot: setup.member.workspaceRoot });
  const ownerRaw = await setup.rpc.handleRequest({
    method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST}`,
    params: { requesterAvailability: true }, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: setup.installed.machineId,
      installationId: setup.installed.installation.installationId, role: 'manage', encryptionMode: 'plain' },
  }, undefined, 'authenticated_home_socket');
  expect(ownerRaw).toMatchObject({ requesterAvailability: { kind: 'available' } });
  const owner = WorkspaceSyncRelationshipsListRpcResultV1Schema.parse(ownerRaw);
  expect(owner.requesterAvailability?.kind).toBe('available');
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
  setup.installed.retire();
  expect(await setup.rpc.handleRequest({
    method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST}`,
    params: { requesterAvailability: true }, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: setup.installed.machineId,
      installationId: setup.installed.installation.installationId, role: 'use', encryptionMode: 'plain' },
  })).toMatchObject({ errorCode: 'RPC_FORBIDDEN', effectAttempted: false });
});

it.skipIf(process.platform !== 'linux').each(['use', 'manage'] as const)('enforces %s Sync admission through requester Account rows and filesystem authority', async role => {
  executionBoundary.member = role === 'use';
  const setup = await createRequesterWorkspaceSyncFixture({ role, socketIo });

  const { installed, fixture, member, rows, custodianRows, custodianRef, custodianBefore,
    sourcePath, targetPath, request, account, authorization, rpc } = setup;
  // The owner seam keeps the genuine admitted Account carrier. Public relay
  // route admission is exercised separately once its declaration is enabled.
  const readsBeforeAvailability = setup.memberReads();
  const requesterContext = { signal: new AbortController().signal,
    callerAuthority: 'present_user' as const, callerInputAuthorization: account.authorization,
    verifyMachineAdmissionCurrent: async () => installed.isHomeCurrent(),
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester',
      machineId: installed.machineId, installationId: installed.installation.installationId, role, encryptionMode: 'plain' as const } };
  const scoped = await fixture.parent.workspaceSync.forRequester?.(requesterContext, { includeAvailability: true });
  if (!scoped) throw new Error('Requester Sync owner is unavailable');
  expect(setup.memberReads() - readsBeforeAvailability).toBe(role === 'use' ? 1 : 0);
  const readsAfterAvailability = setup.requesterProjectionReads();
  await Promise.resolve();
  expect(setup.memberReads() - readsBeforeAvailability).toBe(role === 'use' ? 1 : 0);
  expect(setup.requesterProjectionReads()).toBe(readsAfterAvailability);
  expect(scoped.requesterAvailability).toEqual(role === 'use'
    ? { kind: 'available', homeDir: member.home, workspaceRoot: member.workspaceRoot }
    : { kind: 'available', homeDir: expect.any(String), workspaceRoot: null });
  const invoke = async (input: typeof request.actionInput) => {
    const fresh = await setup.prepareInvocation({ ...request, actionInput: input });
    return rpc.handleRequest({ method: `${installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
      params: fresh.request, callerAuthority: 'present_user', callerInputAuthorization: fresh.authorization,
      originalActionEnvelope: fresh.envelope, machineAdmission: requesterContext.machineAdmission });
  };
  expect(await invoke({ ...request.actionInput, sourceWorkspaceRefId: custodianRef.id }))
    .toMatchObject({ errorCode: 'workspace_ref_not_ready' });
  if (role === 'use') {
    const refused = await invoke({ ...request.actionInput, targetPath: custodianRef.rootPath });
    expect(refused).toMatchObject({ code: 'workspace_private_checkout_review_required' });
  }
  expect(await native.identity.run('member', () => readdir(targetPath))).toEqual([]);
  const readsBeforeCreate = setup.requesterProjectionReads();
  const rowRequestsBeforeCreate = setup.requesterRowRequests.length;
  const authorityReadsBeforeCreate = setup.requesterMachineAuthorityReads.length;
  const created = await rpc.handleRequest({ method: `${installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
    params: request, callerAuthority: 'present_user', callerInputAuthorization: authorization,
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: installed.machineId,
      installationId: installed.installation.installationId, role, encryptionMode: 'plain' } });
  if (role === 'use') {
    // Can-use materializes through Project Open; direct relationship creation
    // retains the destination's Manage requirement (OWNER-RULINGS 2026-11-14).
    expect(created).toMatchObject({ errorCode: 'workspace_sync_unavailable',
      failureCause: { errorCode: 'machine_manage_required' } });
    expect(await native.identity.run('member', () => readdir(targetPath))).toEqual([]);
    expect((await scoped.controller.listRelationships({})).relationships).toEqual([]);
    expect(custodianRows).toEqual(custodianBefore);
    await expect(realpath(sourcePath)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(realpath(targetPath)).rejects.toMatchObject({ code: 'EACCES' });
    return;
  }
  expect(created).toMatchObject({ v: 1, created: true, sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: fixture.targetRef.id });
  const createRowRequests = setup.requesterRowRequests.slice(rowRequestsBeforeCreate);
  const writeAttempts = createRowRequests.filter(event => event.path.endsWith('/mutate')).length;
  // One ingress projection plus the canonical writer's current snapshot for
  // each CAS attempt; subsequent phases use the admitted native capture.
  expect(writeAttempts).toBeGreaterThan(0);
  expect(setup.requesterProjectionReads() - readsBeforeCreate).toBe(writeAttempts + 1);
  expect(setup.requesterMachineAuthorityReads.slice(authorityReadsBeforeCreate)).toEqual([]);
  expect(rows.some(row => row.key.kind === 'relationship-graph')).toBe(true);
  expect(custodianRows).toEqual(custodianBefore);
  expect(await native.identity.run('member', () => readFile(join(sourcePath, 'payload.txt'), 'utf8'))).toBe('before quiesce');
  expect(await native.identity.run('member', () => readFile(join(targetPath, 'payload.txt'), 'utf8'))).toBe('before quiesce');
  expect(authorization.binding.accountId).toBe('member-a');
  const readsBeforeNextCreate = setup.requesterProjectionReads();
  const next = await fixture.parent.workspaceSync.forRequester?.(requesterContext);
  if (!next) throw new Error('Requester Sync owner is unavailable');
  await expect(next.relationshipOwner.create({ ...request, operationId: 'next-foreign-source', actionInput: {
    ...request.actionInput, sourceWorkspaceRefId: custodianRef.id } })).rejects.toMatchObject({ code: 'workspace_ref_not_ready' });
  expect(setup.requesterProjectionReads() - readsBeforeNextCreate).toBe(1);
});

it.skipIf(process.platform !== 'linux')('recovers a native source whose accepted target is on another Machine', async () => {
  executionBoundary.member = true;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'use', socketIo });
  const { installed, fixture, identity, rows, credentials, sourceRef, targetRef } = setup;
  const relationshipId = 'native-source-recovery';
  const remoteTarget = { ...targetRef, machineId: 'remote-target', rootPath: '/accepted/remote-target' };
  rows.splice(1, 1, createPlainProjectAccountRefRow(remoteTarget));
  rows.push(ProjectAccountRowV1Schema.parse({ key: { kind: 'relationship-graph' }, revision: 1,
    content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships: [{
      v: 1, relationshipId, controllerMachineId: installed.machineId,
      alphaWorkspaceRefId: sourceRef.id, betaWorkspaceRefId: remoteTarget.id, mode: 'keep_both_in_sync',
      contentPolicy: setup.request.actionInput.contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1,
    }] } } } }));
  const happyHomeDir = join(installed.directory, 'recovery-custody');
  const { homeServerIdentityId: _homeServerIdentityId, ...executionIdentity } = identity;
  await createWorkspaceSyncRelationshipCredentialCustody({ happyHomeDir, relationshipId,
    attribution: identity.requester, executionIdentity, credentials,
    homeServerIdentityId: installed.homeServerIdentityId,
    machineAdmission: { custodianAccountId: 'requester', role: 'use' } });
  expect(await recoverPrivateWorkspaceSyncExecutions({ happyHomeDir, relationshipId,
    localProfileId: installed.serverId, serverId: installed.homeServerIdentityId,
    serverHttpBaseUrl: installed.serverHttpBaseUrl,
    boundary: { machineId: installed.machineId, daemonToken: installed.bootstrap.credentials.token,
      isHomeCurrent: installed.isHomeCurrent, readInstallation: () => installed.installation },
    adapter: fixture.parent.handoffAdapter, readProjectRows: readProjectAccountRows,
    privateCheckout: { prepareNativeOperation: input => installed.machine.prepareNativeOperation(input) },
  })).toBe(true);
  const recovered = fixture.parent.handoffAdapter.resolvePrivateExecution?.({ relationshipId });
  expect(recovered?.execution.nativeSync).toBeDefined();
  expect(recovered?.input).toMatchObject({ sourceMachineId: installed.machineId,
    sourceWorkspaceRefId: sourceRef.id, sourceRootPath: sourceRef.rootPath,
    targetMachineId: remoteTarget.machineId, targetRootPath: remoteTarget.rootPath });
});

it.skipIf(process.platform !== 'linux').each(['manage', 'use'] as const)('materializes an accepted destination on another Machine from the shared %s source controller', async role => {
  executionBoundary.member = role === 'use';
  const setup = await createRequesterWorkspaceSyncFixture({ role, socketIo, remoteTarget: true });

  expect(await readdir(setup.targetPath)).toEqual([]);
  const result = await setup.rpc.handleRequest({ method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
    params: setup.request, callerAuthority: 'present_user', callerInputAuthorization: setup.authorization,
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: setup.installed.machineId,
      installationId: setup.installed.installation.installationId, role, encryptionMode: 'plain' } });
  expect(result).toMatchObject({ v: 1, created: true, sourceWorkspaceRefId: setup.sourceRef.id, targetWorkspaceRefId: setup.targetRef.id });
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});

it.skipIf(process.platform !== 'linux')('preserves the primary Sync refusal when prepared target cleanup also refuses', async () => {
  const relationshipWarning = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
  onTestFinished(() => { relationshipWarning.mockRestore(); });
  executionBoundary.member = false;
  const refusals: string[] = [];
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo, remoteTarget: true,
    afterTargetRpcResponse: ({ method }) => {
      if (method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`)) {
        refusals.push('primary');
        throw Object.assign(new Error('The prepared target acknowledgement was lost'), { code: 'relationship_not_ready' });
      }
    },
    readTargetRpcResponse: ({ method }) => {
      if (method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`) && !refusals.includes('cleanup')) {
        refusals.push('cleanup');
        return { error: 'The target cleanup transport is unavailable', errorCode: 'target_unavailable', effectAttempted: false };
      }
    } });

  const result = await setup.rpc.handleRequest({ method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
    params: setup.request, callerAuthority: 'present_user', callerInputAuthorization: setup.authorization,
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: setup.installed.machineId,
      installationId: setup.installed.installation.installationId, role: 'manage', encryptionMode: 'plain' } });
  expect(refusals).toContain('primary');
  expect(refusals).toContain('cleanup');
  expect(result).toMatchObject({ errorCode: 'relationship_not_ready' });
  expect(relationshipWarning).toHaveBeenCalledWith('[Workspace Sync] Relationship create failed', expect.objectContaining({
    method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE,
    errors: expect.arrayContaining([expect.objectContaining({ code: 'target_unavailable' })]),
  }));
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});

it.skipIf(process.platform !== 'linux')('preserves the encrypted original Action envelope for normal requester Sync creation', async () => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo, accountMode: 'e2ee' });

  const result = await setup.rpc.handleRequest({ method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
    params: setup.request, callerAuthority: 'present_user', callerInputAuthorization: setup.authorization,
    originalActionEnvelope: setup.envelope,
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: setup.installed.machineId,
      installationId: setup.installed.installation.installationId, role: 'manage', encryptionMode: 'e2ee' } });
  expect(result).toMatchObject({ v: 1, created: true, sourceWorkspaceRefId: setup.sourceRef.id, targetWorkspaceRefId: setup.targetRef.id });
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  expect(setup.rows.every(row => row.content?.t === 'encrypted')).toBe(true);
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});


/** Model Home's real exclusion of the originating daemon socket (forwardRpcCall self-call). */
function rejectSelfCalls(setup: Awaited<ReturnType<typeof createRequesterWorkspaceSyncFixture>>): string[] {
  const rejected: string[] = [];
  Reflect.set(setup.installed.machine, 'socket', createApiSessionSocketStub({ connected: true,
    emitWithAck: async (event, payload) => {
      if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
        return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse({ v: 1, result: 'success', revision: 1 });
      }
      if (event === 'rpc-call' && payload && typeof payload === 'object' && 'method' in payload
        && typeof payload.method === 'string' && payload.method.startsWith(`${setup.installed.machineId}:`)
        && payload.method !== `${setup.installed.machineId}:${RPC_METHODS.CAPABILITIES_DESCRIBE}`) {
        rejected.push(payload.method);
        return { ok: false, error: 'Cannot call RPC on the same socket' };
      }
      return resolveApiSessionSocketDefaultAck(event, payload);
    } }));
  return rejected;
}

// Owner ruling 2026-11-14: Can use reaches only its own member folder through Project
// Open; a same-Machine worker copy through relationship.create needs Manage.
it.skipIf(process.platform !== 'linux')('refuses a Can use same-Machine worker copy through relationship.create with the typed Manage cause', async () => {
  executionBoundary.member = true;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'use', socketIo, remoteTarget: false,
    targetCustodianAccountId: 'member-a', workerCleanCopy: true, originalActionHomeHttp: true });
  await setup.prepareActionIngress();
  const target = setup.envelope.target;
  if (!target) throw new Error('Native relationship envelope has no target');
  const result = await dispatchOriginalAccountAction({ actionId: 'workspace.sync.relationship.create',
    input: setup.request.actionInput, requestId: setup.request.operationId, target, credentials: setup.credentials,
    serverHttpBaseUrl: setup.installed.serverHttpBaseUrl, serverIdentityId: setup.installed.homeServerIdentityId,
    authority: 'present_user', invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' } },
    onRequesterSessionCredentialDisclosure: () => true });
  expect(result, JSON.stringify({ result, diagnostics: setup.rpcDiagnostics }))
    .toMatchObject({ ok: false, errorCode: 'machine_manage_required' });
  expect(setup.approvalArtifacts.size).toBe(0);
  expect(await readdir(setup.targetPath).catch(() => [])).not.toContain('payload.txt');
});

it.skipIf(process.platform !== 'linux').each([
  { role: 'manage' as const, remoteTarget: false },
  { role: 'manage' as const, remoteTarget: true },
  { role: 'use' as const, remoteTarget: true },
])('executes native exact-copy review through SOURCE and TARGET without creating an approval Artifact ($role, remote $remoteTarget)', async ({ role, remoteTarget }) => {
  executionBoundary.member = role === 'use';
  const setup = await createRequesterWorkspaceSyncFixture({ role, socketIo,
    remoteTarget, targetCustodianAccountId: role === 'manage' ? 'requester' : 'member-a',
    workerCleanCopy: true, originalActionHomeHttp: true });
  const rejectedSelfCalls = remoteTarget ? [] : rejectSelfCalls(setup);
  const result = await setup.executeNativeRelationshipAction();
  expect(result, JSON.stringify({ result, rejectedSelfCalls, diagnostics: setup.rpcDiagnostics, target: setup.targetRpcDiagnostics }))
    .toMatchObject({ ok: true, result: { created: true } });
  expect(setup.approvalArtifacts.size).toBe(0);
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});

it.skipIf(process.platform !== 'linux')('executes local exact-copy native review under Allow without creating an approval Artifact', async () => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo,
    workerCleanCopy: true, allowRelationshipAction: true, originalActionHomeHttp: true });
  const rejectedSelfCalls = rejectSelfCalls(setup);

  const preflight = vi.spyOn(setup.installed.machine, 'preflightWorkspaceSyncRelationshipTarget');
  const result = await setup.executeNativeRelationshipAction();
  const preflightResults = await Promise.all(preflight.mock.results.map(async call => {
    try { return await call.value; }
    catch (error) { return error instanceof Error ? { message: error.message, stack: error.stack } : String(error); }
  }));
  expect(result, JSON.stringify({ result, rejectedSelfCalls, preflightResults, diagnostics: setup.rpcDiagnostics,
    approvalArtifactIds: [...setup.approvalArtifacts.keys()] })).toMatchObject({ ok: true, result: { created: true } });
  expect(setup.homeActionRequests).toHaveLength(2);
  expect(setup.approvalArtifacts.size).toBe(0);
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});

it.skipIf(process.platform !== 'linux')('retains and executes an exact-copy approval Artifact for the Home-signed API host', async () => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo,
    workerCleanCopy: true, originalActionHomeHttp: true });
  await setup.prepareActionIngress();
  const result = await dispatchOriginalAccountAction({ actionId: 'workspace.sync.relationship.create',
    input: setup.request.actionInput, requestId: setup.request.operationId, target: setup.envelope.target,
    credentials: setup.credentials, serverHttpBaseUrl: setup.installed.serverHttpBaseUrl,
    serverIdentityId: setup.installed.homeServerIdentityId, authority: 'present_user',
    invocation: { surface: 'api', authority: 'present_user', caller: { kind: 'host' } },
    onRequesterSessionCredentialDisclosure: () => true });
  expect(result, JSON.stringify({ result, diagnostics: setup.rpcDiagnostics }))
    .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: expect.any(String) } });
  expect(setup.approvalArtifacts.size).toBe(1);
  expect([...setup.approvalArtifacts.values()]).toEqual([expect.objectContaining({ ownerAccountId: 'member-a' })]);
  expect(await readdir(setup.targetPath)).toEqual([]);
  const decision = await setup.executeApprovalDecision([...setup.approvalArtifacts.keys()][0]!, {
    request: setup.request, envelope: setup.envelope, authorization: setup.authorization });
  expect(decision, JSON.stringify({ decision, diagnostics: setup.rpcDiagnostics }))
    .toMatchObject({ ok: true, result: { execution: { ok: true, result: { created: true } } } });
  expect(setup.approvalArtifacts.size).toBe(1);
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});

it.skipIf(process.platform !== 'linux').each([undefined, 'not-an-approved-artifact'])(
  'refuses an unadmitted requester proof before dispatching to a shared Manage destination (receipt %s)', async receiptId => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo, remoteTarget: true,
    targetCustodianAccountId: 'requester', workerCleanCopy: true });

  const machineAdmission = { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: setup.installed.machineId,
    installationId: setup.installed.installation.installationId, role: 'manage' as const, encryptionMode: setup.sourceResourceMode };
  const fresh = await setup.prepareInvocation({ ...setup.request,
    targetReplacementApproval: { v: 1, consequences: ['delete_target_only_files_during_exact_mirror'],
      serverId: setup.installed.homeServerIdentityId, machineId: setup.targetRef.machineId,
      canonicalRoot: setup.targetPath, rootFingerprint: '0'.repeat(64), operationId: setup.request.operationId },
    ...(receiptId ? { targetReplacementApprovalReceiptId: receiptId } : {}) });
  const result = await setup.rpc.handleRequest({ method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
    params: fresh.request, callerAuthority: 'present_user', callerInputAuthorization: fresh.authorization,
    originalActionEnvelope: fresh.envelope, machineAdmission });
  expect(result).toMatchObject({ errorCode: 'approval_stale' });
  expect(await readdir(setup.targetPath)).toEqual([]);
  expect(setup.rows.some(row => row.key.kind === 'relationship-graph')).toBe(false);
  expect(setup.requesterRowRequests.filter(event => event.path.endsWith('/mutate'))).toEqual([]);
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});

it.skipIf(process.platform !== 'linux')('refuses another Account executing receipt before staging or dispatching requester Sync', async () => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo, remoteTarget: true,
    targetCustodianAccountId: 'requester', workerCleanCopy: true });

  const approval = { v: 1 as const, consequences: ['delete_target_only_files_during_exact_mirror'] as const,
    serverId: setup.installed.homeServerIdentityId, machineId: setup.targetRef.machineId,
    canonicalRoot: setup.targetPath, rootFingerprint: '0'.repeat(64), operationId: setup.request.operationId };
  const receiptId = 'c41e1eac-3c99-4b12-8e83-31aecf8bb013';
  const fresh = await setup.prepareInvocation({ ...setup.request, targetReplacementApproval: approval,
    targetReplacementApprovalReceiptId: receiptId });
  const receipt = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', actionId: 'workspace.sync.relationship.create',
    actionArgs: fresh.request.actionInput, summary: 'Approved exact copy', createdAtMs: 1, updatedAtMs: 2,
    createdBy: { surface: 'cli' }, decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
    handoffTargetReplacementApproval: approval, executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui',
      caller: { kind: 'host' }, accountId: 'requester', serverId: setup.installed.serverId,
      serverIdentityId: setup.installed.homeServerIdentityId, machineId: setup.installed.machineId,
      actionId: 'workspace.sync.relationship.create', requestId: setup.request.operationId } });
  // HTTP persistence boundary: B can read a granted A Artifact. Read access
  // cannot turn A's executing consent into B's Action receipt.
  setup.approvalArtifacts.set(receiptId, { id: receiptId, ownerAccountId: 'requester', access: 'view',
    encryptionMode: 'plain', publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(receipt)),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(receipt) }),
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2 });
  const result = await setup.rpc.handleRequest({ method: `${setup.installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
    params: fresh.request, callerAuthority: 'present_user', callerInputAuthorization: fresh.authorization,
    originalActionEnvelope: fresh.envelope, machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'requester',
      machineId: setup.installed.machineId, installationId: setup.installed.installation.installationId,
      role: 'manage', encryptionMode: 'plain' } });
  expect(result).toMatchObject({ errorCode: 'approval_stale' });
  expect(setup.requesterRowRequests.filter(event => event.path.endsWith('/mutate'))).toEqual([]);
  expect(setup.targetRpcDiagnostics).toEqual([]);
  expect(await readdir(setup.targetPath)).toEqual([]);
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});

it.skipIf(process.platform !== 'linux')('preflights the shared Manage destination through the source Action before creating its worker copy', async () => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo, remoteTarget: true,
    targetCustodianAccountId: 'requester', workerCleanCopy: true, accountMode: 'e2ee', targetResourceMode: 'e2ee', originalActionHomeHttp: true });

  const result = await setup.executeNativeRelationshipAction();
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { created: true } });
  expect(setup.approvalArtifacts.size).toBe(0);
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});


it.skipIf(process.platform !== 'linux').each([true, false])(
  'settles retained TARGET recovery before normal requester readiness (pending journal=%s)', async pending => {
    executionBoundary.member = false;
    const recovery = { pending, root: '', calls: 0 };
    executionBoundary.recovery = recovery;
    const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo, remoteTarget: true,
      targetCustodianAccountId: 'requester', workerCleanCopy: true, originalActionHomeHttp: true,
      prepareActiveServerDirectory: async directory => {
        if (!directory.includes('/target-parent/')) return;
        const resolution = join(directory, 'workspace-sync', 'resolution');
        await mkdir(resolution, { recursive: true, mode: 0o700 });
        // The native helper owns this opaque record's payload; the real discovery
        // and recovery owners consume its pipe response through the OS adapter.
        await writeFile(join(resolution, 'workspace-recovery-pending.json'), 'native journal');
      } });
    recovery.root = setup.targetPath;

    const result = await setup.executeNativeRelationshipAction();
    expect(result, JSON.stringify(result)).toMatchObject(pending
      ? { ok: false, failureCause: { phase: 'rpc.handler', errorCode: 'workspace_sync_recovery_needed' } }
      : { ok: true, result: { created: true } });
    expect(recovery.calls).toBe(1);
    expect(setup.custodianRows).toEqual(setup.custodianBefore);
    if (pending) expect(await readdir(setup.targetPath)).toEqual([]);
    else expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  });

it.skipIf(process.platform !== 'linux').each([
  { sourceCustodianAccountId: 'member-a', accountMode: 'plain' as const },
  { sourceCustodianAccountId: 'requester', accountMode: 'plain' as const },
  { sourceCustodianAccountId: 'member-a', accountMode: 'e2ee' as const },
])(
  'creates a same-Machine distinct-root Sync through its owner Action ($sourceCustodianAccountId/$accountMode)', async ({ sourceCustodianAccountId, accountMode }) => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', sourceCustodianAccountId, socketIo,
    accountMode, targetResourceMode: accountMode, allowRelationshipAction: true });
  const rejectedSelfCalls: string[] = [];
  // Model Home's real exclusion of the originating daemon socket.
  Reflect.set(setup.installed.machine, 'socket', createApiSessionSocketStub({ connected: true,
    emitWithAck: async (event, payload) => {
      if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
        return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse({ v: 1, result: 'success', revision: 1 });
      }
      if (event === 'rpc-call' && payload && typeof payload === 'object' && 'method' in payload
        && typeof payload.method === 'string' && payload.method.startsWith(`${setup.installed.machineId}:`)
        && payload.method !== `${setup.installed.machineId}:${RPC_METHODS.CAPABILITIES_DESCRIBE}`) {
        rejectedSelfCalls.push(payload.method);
        return { ok: false, error: 'Cannot call RPC on the same socket' };
      }
      return resolveApiSessionSocketDefaultAck(event, payload);
    } }));
  await setup.prepareActionIngress();
  const result = await setup.executeRelationshipAction();
  expect(result, JSON.stringify({ result, rejectedSelfCalls })).toMatchObject({ ok: true, result: { created: true } });
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  if (sourceCustodianAccountId !== 'member-a') expect(setup.custodianRows).toEqual(setup.custodianBefore);
  const secondPath = `${setup.targetPath}-second`;
  const second = await setup.prepareInvocation({ ...setup.request, operationId: `${setup.request.operationId}-second`,
    actionInput: { ...setup.request.actionInput, targetPath: secondPath } });
  expect(await setup.executeRelationshipAction(second)).toMatchObject({ ok: true, result: { created: true } });
  expect(await readFile(join(secondPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
});

it.skipIf(process.platform !== 'linux')('restores requester target custody through the controller reconnect after target daemon restart', async () => {
  executionBoundary.member = false;
  const signingKey = tweetnacl.sign.keyPair();
  let holdTunnel = false;
  let releaseTunnel!: () => void;
  const tunnelRelease = new Promise<void>(resolve => { releaseTunnel = resolve; });
  let tunnelOpened!: () => void;
  const tunnelOpening = new Promise<void>(resolve => { tunnelOpened = resolve; });
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', sourceCustodianAccountId: 'member-a',
    remoteTarget: true, targetCustodianAccountId: 'target-owner', remoteSeed: true, socketIo, allowRelationshipAction: true,
    nativeCarrierHome: {
      // Home HTTP and native tunnel opening are external process/network boundaries.
      resolveTrustRoots: () => [{ keyId: 'reconnect-home', publicKey: Buffer.from(signingKey.publicKey).toString('base64url') }],
      readTargetMachine: async id => ({ id, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1],
          endpointId: (id === 'target-parent' ? 'b' : 'a').repeat(64), directAddresses: ['127.0.0.1:7777'] } } }),
      mintGrant: async request => {
        const { kind, ttlMs, ...binding } = request;
        const now = Date.now();
        const payload = { ...binding, grantId: 'reconnect-grant', accountId: 'member-a', iat: now, exp: now + ttlMs,
          aud: 'happier-daemon-route-grant' as const, proofKind: kind };
        return { payload, signature: { keyId: 'reconnect-home', alg: 'Ed25519' as const,
          valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)),
            signingKey.secretKey)).toString('base64url') } };
      },
      admitNativeTunnel: async ({ handshake }) => {
        const target = setup.fixture.targetParent;
        if (!target || handshake.flow !== 'workspace_sync' || handshake.initiator.kind !== 'machine') {
          throw new Error('Target native boundary is unavailable');
        }
        const ingress = await target.acquireWorkspaceSyncMachineIngress({ operationId: handshake.operationId,
          sourceMachineId: handshake.initiator.machineId, targetMachineId: handshake.target.machineId,
          actorAccountId: handshake.accountId });
        if (holdTunnel) {
          tunnelOpened();
          await tunnelRelease;
        }
        return ingress;
      },
    } });
  const targetBefore = [...setup.targetAccountRows];
  const created = await setup.executeRelationshipAction();
  expect(created).toMatchObject({ ok: true, result: { created: true } });
  if (!created.ok) throw new Error('Sync creation failed');
  const { relationshipId } = WorkspaceSyncRelationshipCreateResultV1Schema.parse(created.result);
  await setup.restartTargetParent();
  const unclaimed = await setup.fixture.probeTarget();
  expect(unclaimed).not.toHaveProperty('kind');
  if (!('kind' in unclaimed)) await unclaimed.release();
  const controller = setup.fixture.parentManagedWorkspaceSync;
  if (!(controller instanceof WorkspaceSyncController)) throw new Error('Source controller is unavailable');
  const definition = (await controller.listRelationships({})).relationships.find(item => item.definition.relationshipId === relationshipId)?.definition;
  if (!definition) throw new Error('Created Sync relationship is unavailable');
  holdTunnel = true;
  const opening = controller.openExternalStream({ endpointId: deriveWorkspaceSyncEndpointId(relationshipId, 'beta') });
  await tunnelOpening;
  // A normal Account graph refresh can settle while the network acknowledges
  // the retained target ingress. Identical intent must keep its live custody.
  try { await controller.rehydrateFromSettings([definition]); }
  finally { releaseTunnel(); }
  const stream = await opening;
  try {
    const recovered = await setup.fixture.probeTarget();
    if (!('kind' in recovered)) await recovered.release();
    expect(recovered).toMatchObject({ kind: 'overlap' });
    expect(setup.targetAccountRows).toEqual(targetBefore);
  } finally {
    stream.destroy();
    await setup.fixture.parent.workspaceSync.relationshipOwner.stop(relationshipId);
  }
});

it.skipIf(process.platform !== 'linux').each([false, true])(
  're-enables Sync after Disable through setEnabled (remoteTarget=%s)', async remoteTarget => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', sourceCustodianAccountId: 'member-a',
    remoteTarget, socketIo, allowRelationshipAction: true });
  const created = await setup.executeRelationshipAction();
  expect(created).toMatchObject({ ok: true, result: { created: true } });
  if (!created.ok) throw new Error('Sync creation failed');
  const { relationshipId } = WorkspaceSyncRelationshipCreateResultV1Schema.parse(created.result);
  await readProjectAccountRows({ credentials: setup.installed.bootstrap.credentials,
    serverId: setup.installed.serverId, publication: 'installed' });
  const owner = setup.fixture.parent.workspaceSync.relationshipOwner;
  await owner.setEnabled(relationshipId, false);
  await writeFile(join(setup.targetPath, 'payload.txt'), 'edited while disabled');
  await expect(owner.setEnabled(relationshipId, true)).resolves.toBeUndefined();
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('edited while disabled');
  await owner.stop(relationshipId);
  expect(await setup.fixture.parentManagedWorkspaceSync!.list()).toEqual([]);
});

// SEC-FORKC-1114E R4: a member-placed Manage requester's same-Machine relationship write is
// admitted at the in-process preflight before any in-process prepare can write the destination.
it.skipIf(process.platform !== 'linux')('admits a Manage member same-Machine worker copy at preflight before the in-process prepare', async () => {
  executionBoundary.member = true;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo, remoteTarget: false,
    targetCustodianAccountId: 'requester', workerCleanCopy: true, originalActionHomeHttp: true });
  const rejectedSelfCalls = rejectSelfCalls(setup);
  const manager = Reflect.get(setup.installed.machine, 'rpcHandlerManager') as { invokeLocal: (...args: never[]) => Promise<unknown> };
  const targetPhases: Array<Readonly<{ method: string; role: unknown }>> = [];
  const invokeLocal = manager.invokeLocal.bind(manager);
  vi.spyOn(manager, 'invokeLocal').mockImplementation(async (method: string, params: unknown, options?: { rpcContext?: RpcHandlerContext }) => {
    if (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT || method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE) {
      targetPhases.push({ method, role: options?.rpcContext?.machineAdmission?.role });
    }
    return invokeLocal(method as never, params as never, options as never);
  });
  // Its own relationship identity; the live link is stopped so later rows start clean.
  const result = await setup.executeNativeRelationshipAction(await setup.prepareInvocation({
    ...setup.request, operationId: 'member-sync-manage-member' }));
  expect(result, JSON.stringify({ result, rejectedSelfCalls, targetPhases, diagnostics: setup.rpcDiagnostics }))
    .toMatchObject({ ok: true, result: { created: true } });
  expect(targetPhases[0]).toEqual({ method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, role: 'manage' });
  expect(targetPhases.findIndex(phase => phase.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE)).toBeGreaterThan(0);
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  if (!result.ok) throw new Error('Sync creation failed');
  const binding = setup.authorization.binding;
  const requester = await setup.fixture.parent.workspaceSync.forRequester!({ signal: new AbortController().signal,
    callerAuthority: 'present_user', verifyMachineAdmissionCurrent: async () => true, callerInputAuthorization: setup.authorization,
    machineAdmission: { actorAccountId: binding.accountId, custodianAccountId: binding.custodianAccountId,
      machineId: setup.installed.machineId, installationId: setup.installed.installation.installationId,
      role: 'manage', encryptionMode: 'plain' } });
  await requester.relationshipOwner.stop(WorkspaceSyncRelationshipCreateResultV1Schema.parse(result.result).relationshipId);
});

// SEC-FORKC-1114E R3: a retained requester retires its same-Machine worker copy; the in-process
// copy phases carry the current reviewed retirement, and only the requester's own retirement removes it.
it.skipIf(process.platform !== 'linux').each([true, false])(
  'retires a same-Machine worker copy through the retained requester (own retirement=%s)', async ownRetirement => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo, remoteTarget: false,
    targetCustodianAccountId: 'requester', workerCleanCopy: true, originalActionHomeHttp: true });
  const rejectedSelfCalls = rejectSelfCalls(setup);
  // Only a copy this Sync created is removable: let the in-process prepare create the destination.
  await rm(setup.targetPath, { recursive: true });
  // Its own relationship identity: later rows reuse the fixture's default operation id.
  const created = await setup.executeNativeRelationshipAction(await setup.prepareInvocation({
    ...setup.request, operationId: `member-sync-retire-${ownRetirement}` }));
  expect(created, JSON.stringify({ created, rejectedSelfCalls })).toMatchObject({ ok: true, result: { created: true } });
  if (!created.ok) throw new Error('Sync creation failed');
  const { relationshipId } = WorkspaceSyncRelationshipCreateResultV1Schema.parse(created.result);
  const retained = setup.fixture.parent.handoffAdapter.resolvePrivateExecution?.({ relationshipId });
  const expectedRelationship = retained?.execution.getSnapshot?.()?.relationships
    .find(relationship => relationship.relationshipId === relationshipId);
  if (!expectedRelationship) throw new Error('Retained requester relationship is unavailable');
  const binding = setup.authorization.binding;
  const actionInput = { workspace: { serverId: setup.installed.homeServerIdentityId, refId: expectedRelationship.alphaWorkspaceRefId },
    machineId: setup.installed.machineId, expectedRelationship,
    removeTargetCopy: { workspaceRefId: expectedRelationship.betaWorkspaceRefId,
      rootFingerprint: await computeWorkspaceSyncRootFingerprint(setup.targetPath) } };
  const retirement = setup.adoptHomeAuthorization({ v: 1, token: `retire-root-${ownRetirement}`, binding: { ...binding,
    accountId: ownRetirement ? binding.accountId : 'foreign-account', actionId: 'projects.worker.copy.retire',
    requestId: 'retire-receipt' } });
  const requester = await setup.fixture.parent.workspaceSync.forRequester!({ signal: new AbortController().signal,
    callerAuthority: 'present_user', verifyMachineAdmissionCurrent: async () => true, callerInputAuthorization: retirement,
    machineAdmission: { actorAccountId: binding.accountId, custodianAccountId: binding.custodianAccountId,
      machineId: setup.installed.machineId, installationId: setup.installed.installation.installationId,
      role: 'manage', encryptionMode: 'plain' } });
  const stop = requester.relationshipOwner.stop(relationshipId, undefined, { expectedRelationship,
    removeTargetCopy: actionInput.removeTargetCopy, approval: { actionReceiptId: 'retire-receipt', actionInput } });
  if (ownRetirement) {
    await expect(stop).resolves.toBeUndefined();
    await expect(readdir(setup.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    await expect(stop).rejects.toMatchObject({ code: 'forbidden' });
    expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  }
});

// HANDOFF-MEMBER-CAPTURE-1114 (owner ruling 2026-11-15): a Can use requester's handoff
// copy into another person's separate-users Machine runs inside their own member
// capture; Manage keeps today's native placement.
it.skipIf(process.platform !== 'linux').each([
  ['use', 'before-effects refusals'], ['use', 'retained custody'], ['manage', 'native control'],
] as const)(
  'captures a %s handoff copy at the TARGET owner (%s)', async (role, scenario) => {
  executionBoundary.member = role === 'use';
  const sourceKey = tweetnacl.sign.keyPair();
  const setup: Awaited<ReturnType<typeof createRequesterWorkspaceSyncFixture>> = await createRequesterWorkspaceSyncFixture({ role, socketIo,
    readHomePost: async (_url, body) => {
      const mint = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
      if (!mint.success || !mint.data.handoffPreflight) return undefined;
      // Authenticated Home is the boundary: its admitted peer projection is
      // consumed by the real handoff authorization producer and RPC ingress.
      expect(mint.data.handoffPreflight.authorization).toEqual(root);
      return { status: 200, data: setup.adoptHomeAuthorization({ ...root, token: 'handoff-target-preflight', binding: {
        ...root.binding, machineId: setup.installed.machineId, installationId: setup.installed.installation.installationId,
        custodianAccountId: 'requester', target: mint.data.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(mint.data.envelope),
        handoffPreflight: { rootRequestId: root.binding.requestId, rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest },
      } }) };
    } });
  const { installed, fixture, targetPath, custodianRef } = setup;
  const home = installed.homeServerIdentityId;
  const admission = { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: installed.machineId,
    installationId: installed.installation.installationId, role, encryptionMode: 'plain' as const };
  const root = setup.adoptHomeAuthorization({ v: 1, token: 'handoff-root', binding: {
    accountId: 'member-a', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
    custodianAccountId: 'member-a', serverIdentityId: home, machineId: 'member-source', installationId: 'member-source-installation',
    actionId: 'session.handoff', requestId: 'handoff-copy', requestEnvelopeDigest: 'A'.repeat(43),
    target: { kind: 'machine', machineId: 'member-source' },
    handoffAdmission: { sessionId: 'moved-session', sourceMachineId: 'member-source', sourceInstallationId: 'member-source-installation',
      targetMachineId: installed.machineId, targetInstallationId: installed.installation.installationId } } });
  // The installed fixture first starts before Sync composition. Rebind its
  // public receiver once the actual runtime is available, as production does.
  installed.machine.setRPCHandlers({ spawnSession: async () => { throw new Error('No Session spawn expected'); },
    stopSession: async () => true, requestShutdown() {} });
  const action = { kind: 'copy_once' as const, contentPolicy: setup.request.actionInput.contentPolicy };
  const capture = async (input: Partial<Readonly<{ operationId: string; targetPath: string; release: true }>> = {}) => {
    const request = sealSessionRequesterHandoffWorkspaceCaptureRpcRequestV1({
      request: { kind: 'requester_session_handoff_workspace_capture_v1', input: {
        sessionId: 'moved-session', sourceMachineId: 'member-source', targetMachineId: installed.machineId,
        operationId: 'handoff-copy', accountServerId: home, sourceRootPath: '/member/workspace', targetPath,
        workspaceAction: action, ...input }, requesterBootstrap: {
        v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials(setup.credentials) } },
      installationId: installed.installation.installationId,
      installationPublicKey: Buffer.from(installed.installation.publicKey, 'base64url'), randomBytes: tweetnacl.randomBytes });
    const authorization = await prepareExternalActionHandoffPreflightAuthorization({ authorization: root, input: request,
      machineId: installed.machineId, sourceMachineId: 'member-source', sourceInstallationId: 'member-source-installation',
      privateKey: Buffer.from(sourceKey.secretKey).toString('base64url'), serverHttpBaseUrl: installed.serverHttpBaseUrl });
    if (!authorization) throw new Error('The actual handoff peer authorization producer refused the capture');
    return SessionHandoffWorkspaceCaptureResultV3Schema.parse(readMachineActionRpcResult(await installed.invoke(
      RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3, request,
      { actorAccountId: admission.actorAccountId, role, callerAuthority: 'present_user', callerInputAuthorization: authorization })));
  };
  if (role === 'manage') {
    expect(await capture()).toEqual({ ok: true, capture: 'not_required' });
    expect(fixture.parent.handoffAdapter.resolvePrivateExecution?.({ operationId: 'handoff-copy' })).toBeNull();
    return;
  }
  const admissionReadsBeforeCapture = setup.requesterAdmissionReads.length;
  const captured = await capture();
  const captureAdmissionReads = setup.requesterAdmissionReads.slice(admissionReadsBeforeCapture);
  expect(captureAdmissionReads.filter(path => path === '/v1/account/profile')).toHaveLength(1);
  expect(captureAdmissionReads.filter(path => path === '/v2/account/settings')).toHaveLength(1);
  expect(captured).toMatchObject({ ok: true, capture: 'member', targetRootPath: targetPath, targetWorkspaceRefId: setup.targetRef.id });
  if (!captured.ok || captured.capture !== 'member') throw new Error('Member capture is unavailable');
  const retainedCapture = fixture.parent.handoffAdapter.resolvePrivateExecution?.({ operationId: 'handoff-copy' });
  if (!retainedCapture?.execution.nativeSync) throw new Error('The actual retained member capture is unavailable');
  expect(await retainedCapture.execution.accountRowsCustody.isCurrent()).toBe(true);
  await expect(retainedCapture.execution.assertTransferCurrent()).resolves.toBeUndefined();
  let releaseTarget: (() => Promise<unknown>) | undefined;
  try {
  if (scenario === 'before-effects refusals') {
  // Both endpoint rows exist in the requester's Account after the capture.
  const persisted = await readProjectAccountRows({ credentials: setup.credentials, serverId: home,
    selection: { kinds: ['workspace-ref'] } });
  expect(persisted.workspaceRefs).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: captured.sourceWorkspaceRefId, machineId: 'member-source', rootPath: '/member/workspace' }),
    expect.objectContaining({ id: setup.targetRef.id, machineId: installed.machineId, rootPath: targetPath }),
  ]));

  }

  // Both scenarios use the installed ingress and the same retained member owner.
  let borrowerGrantCurrent = true;
  const ingress = new RpcHandlerManager({ scopePrefix: installed.machineId, localMachineId: installed.machineId,
    encryptionMode: 'plain', logger: () => {},
    authorizeRequest: incoming => authorizeMachineRpcRequest(incoming, { machineId: installed.machineId,
      resolveInstallationId: () => installed.installation.installationId,
      resolveCustodianAccountId: async () => 'requester', resolveHomeServerIdentityId: async () => home,
      // Home's current admission is the network boundary.
      verifyMachineAdmission: async incoming => incoming.context.machineId === 'member-source' || borrowerGrantCurrent,
      resolvePrivateWorkspaceSyncTargetExecution: input => resolvePrivateWorkspaceSyncTargetExecution(fixture.parent.handoffAdapter, input) }) });
  registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: ingress, service: fixture.parent.workspaceSync });
  const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
    sourceWriter: { machineId: 'member-source', installationId: 'member-source-installation' },
    source: { v: 1, phase: 'prepare', operationId: 'handoff-copy', accountServerId: home, sourceMachineId: 'member-source',
      sourceRootPath: '/member/workspace', sourceSessionId: 'moved-session', sourceContext: { machineAdmission: {
        actorAccountId: 'member-a', custodianAccountId: 'member-a', machineId: 'member-source',
        installationId: 'member-source-installation', role: 'manage', encryptionMode: 'plain' },
      callerAuthority: 'present_user', workspaceWrites: 'allow' } },
    target: { v: 1, phase: 'preflight', operationId: 'handoff-copy', accountServerId: home,
      targetMachineId: installed.machineId, targetRootPath: targetPath } });
  await native.identity.run('member', async () => writeFile(join(targetPath, 'existing.txt'), 'member-reviewed target bytes'));
  const retainedNative = retainedCapture.execution.nativeSync;
  if (scenario === 'before-effects refusals') {
  const hostNative = vi.spyOn(fixture.parent.workspaceSync, 'preflightHandoffTargetReplacement');
  const fingerprint = await native.identity.run('member', async () => computeWorkspaceSyncRootFingerprint(targetPath));
  const preflight = await ingress.handleRequest({
    method: `${installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
    params: { v: 1, operationId: 'handoff-copy', serverId: home, machineId: installed.machineId, targetPath,
      destinationIntent: 'materialize_from_source_workspace' },
    callerAuthority: 'present_user', machineAdmission: admission, callerInputAuthorization: root,
    workspaceSyncSourceWriterTargetRouting: routing });
  expect(preflight).toMatchObject({ type: 'approval_required', approval: {
    machineId: installed.machineId, canonicalRoot: targetPath, serverId: home, operationId: 'handoff-copy',
    rootFingerprint: fingerprint, consequences: ['replace_nonempty_workspace_target'],
  } });
  expect(await native.identity.run('member', () => readFile(join(targetPath, 'existing.txt'), 'utf8')))
    .toBe('member-reviewed target bytes');
  const loan = await retainedNative.acquireLocalRoot({ ownerId: 'member-preflight-no-loan', canonicalRoot: targetPath, operation: 'sync' });
  expect(loan).not.toHaveProperty('kind');
  if (!('kind' in loan)) await loan.release();
  expect(hostNative).not.toHaveBeenCalled();
  // The member folder stays the member's: the host cannot read it.
  await expect(realpath(targetPath)).rejects.toMatchObject({ code: 'EACCES' });
  }

  // The same real member owner admits target custody only under the SOURCE's
  // exact write ceiling, then retains it for terminal cleanup.
  const prepareRequest = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse({ v: 1,
    bootstrapOperationId: 'handoff-copy', owner: { kind: 'copy_once', operation: {
      v: 1, operationId: 'handoff-copy', controllerMachineId: 'member-source',
      alphaWorkspaceRefId: captured.sourceWorkspaceRefId, betaWorkspaceRefId: captured.targetWorkspaceRefId,
      contentPolicy: action.contentPolicy } }, targetWorkspaceRefId: captured.targetWorkspaceRefId,
    endpointRole: 'beta', policyDigest: action.contentPolicy.policyDigest, createIfMissing: true,
    targetBootstrap: 'use_existing' });
  const prepareRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...routing,
    target: { ...routing.target, phase: 'prepare' } });
  const prepare = async (selectedRouting = prepareRouting, authorization = root, request = prepareRequest, receivingAdmission = admission) => {
    const result = await ingress.handleRequest({
    method: `${installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`,
    params: request, callerAuthority: authorization.binding.sessionActionOrigin ? 'account_automation' : 'present_user',
    machineAdmission: receivingAdmission, callerInputAuthorization: authorization,
    ...(authorization.binding.sessionActionOrigin ? { sessionActionOrigin: authorization.binding.sessionActionOrigin } : {}),
    workspaceSyncSourceWriterTargetRouting: selectedRouting });
    const prepared = WorkspaceSyncTargetBootstrapPrepareResultV1Schema.safeParse(result);
    if (prepared.success && prepared.data.state === 'ready') releaseTarget = () => release(
      WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...selectedRouting,
        target: { ...selectedRouting.target, phase: 'release' } }),
      { ...releaseRequest, bootstrapOperationId: request.bootstrapOperationId, targetWorkspaceRefId: request.targetWorkspaceRefId });
    return result;
  };
  const probe = async () => retainedNative.acquireLocalRoot({ ownerId: 'member-target-custody-probe',
    canonicalRoot: targetPath, operation: 'sync' });
  const releaseRequest = WorkspaceSyncTargetBootstrapReleaseV1Schema.parse({ v: 1,
    bootstrapOperationId: 'handoff-copy', targetWorkspaceRefId: captured.targetWorkspaceRefId, reason: 'abort' });
  const releaseRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...prepareRouting,
    target: { ...prepareRouting.target, phase: 'release' } });
  const release = (selectedRouting = releaseRouting, request = releaseRequest) => ingress.handleRequest({
    method: `${installed.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`,
    params: request, callerAuthority: 'present_user',
    // Home authenticates the SOURCE writer's own socket; retained target custody
    // supplies the original borrower, without a fresh borrower grant or Root.
    machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'member-a',
      ...selectedRouting.sourceWriter, role: 'manage', encryptionMode: 'plain' },
    workspaceSyncSourceWriterTargetRouting: selectedRouting });
  releaseTarget = () => release();
  if (scenario === 'before-effects refusals') {
  for (const rejected of [
    { request: { ...prepareRequest, targetWorkspaceRefId: 'another-target' },
      refusal: { errorCode: 'agent_isolation_unavailable', effectAttempted: false } },
    { routing: WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...prepareRouting,
      target: { ...prepareRouting.target, targetRootPath: '/another/target' } }),
      refusal: { errorCode: 'agent_isolation_unavailable', effectAttempted: false } },
    { routing: WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...prepareRouting,
      sourceWriter: { machineId: 'other-source', installationId: 'other-installation' } }),
      refusal: { code: 'bootstrap_definition_conflict' } },
    { admission: { ...admission, actorAccountId: 'another-borrower' },
      refusal: { errorCode: 'RPC_FORBIDDEN', effectAttempted: false } },
  ]) {
    expect(await prepare(rejected.routing, root, rejected.request, rejected.admission))
      .toMatchObject(rejected.refusal);
    const available = await probe();
    expect(available).not.toHaveProperty('kind');
    if (!('kind' in available)) await available.release();
  }
  const deniedRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...prepareRouting,
    source: { ...prepareRouting.source, sourceContext: { ...prepareRouting.source.sourceContext, workspaceWrites: 'deny' } } });
  const deniedPrepare = await prepare(deniedRouting);
  expect(deniedPrepare).toMatchObject({ code: 'workspace_write_denied' });
  const deniedOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
    caller: { kind: 'session', sessionId: 'moved-session', starterDepth: 0, turnDepth: 0 },
    sourceTurnId: 'handoff-source-turn', requestId: 'handoff-copy', callerPermissionMode: 'read-only', workspaceWrites: 'deny' });
  const originAuthorization = setup.adoptHomeAuthorization({ ...root, token: 'handoff-origin-denied', binding: {
    ...root.binding, sessionActionOrigin: deniedOrigin,
    sessionActionSource: { machineId: 'member-source', installationId: 'member-source-installation' } } });
  const { workspaceWrites: _explicitCeiling, ...originSourceContext } = prepareRouting.source.sourceContext;
  const deniedOriginRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...prepareRouting,
    source: { ...prepareRouting.source, sourceContext: { ...originSourceContext,
      callerAuthority: 'account_automation', sessionActionOrigin: deniedOrigin } } });
  expect(await prepare(deniedOriginRouting, originAuthorization)).toMatchObject({ code: 'workspace_write_denied' });
  const unacquired = await probe();
  expect(unacquired).not.toHaveProperty('kind');
  if (!('kind' in unacquired)) await unacquired.release();
  expect(await native.identity.run('member', () => readFile(join(targetPath, 'existing.txt'), 'utf8')))
    .toBe('member-reviewed target bytes');

  } else {
  expect(await prepare()).toMatchObject({ state: 'ready', created: false });
  expect(await probe()).toMatchObject({ kind: 'overlap' });
  for (const substituted of [
    { ...releaseRouting, sourceWriter: { machineId: 'other-source', installationId: 'other-installation' } },
    { ...releaseRouting, source: { ...releaseRouting.source, sourceRootPath: '/another/source' } },
    { ...releaseRouting, source: { ...releaseRouting.source, sourceContext: {
      ...releaseRouting.source.sourceContext, workspaceWrites: 'deny' } } },
    { ...releaseRouting, source: { ...releaseRouting.source, sourceContext: {
      ...releaseRouting.source.sourceContext, machineAdmission: {
        ...releaseRouting.source.sourceContext.machineAdmission, actorAccountId: 'another-borrower' } } } },
  ]) {
    expect(await release(WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(substituted)))
      .toMatchObject({ code: 'bootstrap_definition_conflict' });
    expect(await probe()).toMatchObject({ kind: 'overlap' });
  }
  const unknownOperation = 'never-prepared-handoff';
  expect(await release(WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...releaseRouting,
    target: { ...releaseRouting.target, operationId: unknownOperation } }),
    { ...releaseRequest, bootstrapOperationId: unknownOperation })).toEqual({ ok: true, released: false });
  expect(await probe()).toMatchObject({ kind: 'overlap' });
  borrowerGrantCurrent = false;
  expect(await prepare()).toHaveProperty('errorCode');
  expect(await probe()).toMatchObject({ kind: 'overlap' });
  expect(await release()).toEqual({ ok: true, released: true });
  expect(await release()).toEqual({ ok: true, released: false });
  const released = await probe();
  expect(released).not.toHaveProperty('kind');
  if (!('kind' in released)) await released.release();
  expect(await native.identity.run('member', () => readFile(join(targetPath, 'existing.txt'), 'utf8')))
    .toBe('member-reviewed target bytes');
  borrowerGrantCurrent = true;
  }

  // The SOURCE's terminal call releases the capture and the admitted bootstrap.
  expect(await capture({ release: true })).toEqual({ ok: true, capture: 'released' });
  expect(fixture.parent.handoffAdapter.resolvePrivateExecution?.({ operationId: 'handoff-copy' })).toBeNull();
  expect(await retainedCapture.execution.accountRowsCustody.isCurrent()).toBe(false);
  await expect(retainedCapture.execution.assertTransferCurrent()).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
  expect(await native.identity.run('member', () => readFile(join(targetPath, 'existing.txt'), 'utf8')))
    .toBe('member-reviewed target bytes');

  if (scenario === 'before-effects refusals') {
  // The positive capture passes before testing a path outside the member's own folder.
  // The lifecycle boundary owns refusal; the checkout owner tests its exact diagnostic.
  await expect(capture({ operationId: 'handoff-arbitrary', targetPath: custodianRef.rootPath }))
    .resolves.toMatchObject({ ok: false });
  expect(fixture.parent.handoffAdapter.resolvePrivateExecution?.({ operationId: 'handoff-arbitrary' })).toBeNull();
  expect(await native.identity.run('member', () => readFile(join(targetPath, 'existing.txt'), 'utf8')))
    .toBe('member-reviewed target bytes');
  }
  } finally { await releaseTarget?.(); await capture({ release: true }); }
});
