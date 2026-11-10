import { join } from 'node:path';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import tweetnacl from 'tweetnacl';
import { beforeEach, expect, it, vi } from 'vitest';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineUpdateOperationProtocolCapabilitiesResponseV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ProjectAccountRowV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRefRow } from '@/workspaces/projectAccountRows.testkit';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodeStoredCredentials } from '@/persistence';
import { createWorkspaceSyncRelationshipCredentialCustody } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { recoverPrivateWorkspaceSyncExecutions } from './recoverPrivateWorkspaceSyncExecutions';
import { workspaceCheckoutNativeBoundary as native } from '@/workspaces/activation/workspaceCheckoutNative.testkit';
import { createRequesterWorkspaceSyncFixture } from './createRequesterWorkspaceSyncFixture.testkit';
import { registerMachineWorkspaceSyncRpcHandlers } from '@/api/machine/rpcHandlers.workspaceSync';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { WorkspaceSyncRelationshipCreateResultV1Schema, WorkspaceSyncRelationshipsListRpcResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

const socketIo = vi.hoisted(() => vi.fn());
const executionBoundary = vi.hoisted(() => ({ member: true, recovery: undefined as undefined | { pending: boolean; root: string; calls: number } }));
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
  const { workspaceCheckoutFilesystemBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
  return workspaceCheckoutFilesystemBoundary(actual);
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
beforeEach(() => { native.reset(); vi.restoreAllMocks(); executionBoundary.recovery = undefined; });

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

it.skipIf(process.platform !== 'linux').each(['use', 'manage'] as const)('materializes an empty accepted target for %s Sync through requester Account rows and filesystem authority', async role => {
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
  expect(created).toMatchObject({ v: 1, created: true, sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: fixture.targetRef.id });
  const createRowRequests = setup.requesterRowRequests.slice(rowRequestsBeforeCreate);
  const writeAttempts = createRowRequests.filter(event => event.path.endsWith('/mutate')).length;
  // One ingress projection plus the canonical writer's current snapshot for
  // each CAS attempt; subsequent phases use the admitted native capture.
  expect(writeAttempts).toBeGreaterThan(0);
  expect(setup.requesterProjectionReads() - readsBeforeCreate).toBe(writeAttempts + 1);
  expect(setup.requesterMachineAuthorityReads.slice(authorityReadsBeforeCreate)).toEqual([]);
  expect(scoped.requesterAvailability).toEqual(role === 'use'
    ? { kind: 'available', homeDir: member.home, workspaceRoot: member.workspaceRoot }
    : { kind: 'available', homeDir: expect.any(String), workspaceRoot: null });
  expect(rows.some(row => row.key.kind === 'relationship-graph')).toBe(true);
  expect(custodianRows).toEqual(custodianBefore);
  if (role === 'use') {
    await expect(realpath(sourcePath)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(realpath(targetPath)).rejects.toMatchObject({ code: 'EACCES' });
  }
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
  expect(setup.rpcDiagnostics).toContainEqual({ message: 'Sync handler failure', data: expect.arrayContaining([
    expect.objectContaining({ errors: expect.arrayContaining([expect.objectContaining({ code: 'target_unavailable' })]) }),
  ]) });
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


it.skipIf(process.platform !== 'linux')('executes a local exact-copy destination approval under Allow through the requester receipt owner', async () => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo,
    workerCleanCopy: true, allowRelationshipAction: true });

  const preflight = vi.spyOn(setup.installed.machine, 'preflightWorkspaceSyncRelationshipTarget');
  const result = await setup.executeRelationshipAction();
  const preflightResults = await Promise.all(preflight.mock.results.map(async call => {
    try { return await call.value; }
    catch (error) { return error instanceof Error ? { message: error.message, stack: error.stack } : String(error); }
  }));
  expect(result, JSON.stringify({ result, preflightResults, diagnostics: setup.rpcDiagnostics,
    approvalArtifactIds: [...setup.approvalArtifacts.keys()] })).toMatchObject({ ok: true, result: { created: true } });
  // Exact mirroring has a destination consequence even when ordinary Action
  // approval is waived. The Action owner persists that consent before SOURCE
  // validates its executing receipt; TARGET never invents another decision.
  expect(setup.approvalArtifacts.size).toBe(1);
  expect([...setup.approvalArtifacts.values()].every(row => row.ownerAccountId === 'member-a')).toBe(true);
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});

it.skipIf(process.platform !== 'linux')('refuses an unapproved requester receipt before dispatching to a shared Manage destination', async () => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo, remoteTarget: true,
    targetCustodianAccountId: 'requester', workerCleanCopy: true });

  const machineAdmission = { actorAccountId: 'member-a', custodianAccountId: 'requester', machineId: setup.installed.machineId,
    installationId: setup.installed.installation.installationId, role: 'manage' as const, encryptionMode: setup.sourceResourceMode };
  const fresh = await setup.prepareInvocation({ ...setup.request,
    targetReplacementApproval: { v: 1, consequences: ['delete_target_only_files_during_exact_mirror'],
      serverId: setup.installed.homeServerIdentityId, machineId: setup.targetRef.machineId,
      canonicalRoot: setup.targetPath, rootFingerprint: '0'.repeat(64), operationId: setup.request.operationId },
    targetReplacementApprovalReceiptId: 'not-an-approved-artifact' });
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
    targetCustodianAccountId: 'requester', workerCleanCopy: true, accountMode: 'e2ee', targetResourceMode: 'e2ee' });

  const result = await setup.executeRelationshipAction();
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { created: true } });
  expect(setup.approvalArtifacts.size).toBeGreaterThan(0);
  expect([...setup.approvalArtifacts.values()].every(row => row.ownerAccountId === 'member-a')).toBe(true);
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  expect(setup.custodianRows).toEqual(setup.custodianBefore);
});


it.skipIf(process.platform !== 'linux').each([true, false])(
  'settles retained TARGET recovery before normal requester readiness (pending journal=%s)', async pending => {
    executionBoundary.member = false;
    const recovery = { pending, root: '', calls: 0 };
    executionBoundary.recovery = recovery;
    const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo, remoteTarget: true,
      targetCustodianAccountId: 'requester', workerCleanCopy: true,
      prepareActiveServerDirectory: async directory => {
        if (!directory.includes('/target-parent/')) return;
        const resolution = join(directory, 'workspace-sync', 'resolution');
        await mkdir(resolution, { recursive: true, mode: 0o700 });
        // The native helper owns this opaque record's payload; the real discovery
        // and recovery owners consume its pipe response through the OS adapter.
        await writeFile(join(resolution, 'workspace-recovery-pending.json'), 'native journal');
      } });
    recovery.root = setup.targetPath;

    const result = await setup.executeRelationshipAction();
    expect(result, JSON.stringify(result)).toMatchObject(pending
      ? { ok: false, failureCause: { phase: 'rpc.handler', errorCode: 'workspace_sync_recovery_needed' } }
      : { ok: true, result: { created: true } });
    expect(recovery.calls).toBe(1);
    expect(setup.custodianRows).toEqual(setup.custodianBefore);
    if (pending) expect(await readdir(setup.targetPath)).toEqual([]);
    else expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  });

it.skipIf(process.platform !== 'linux').each(['member-a', 'requester'])(
  'creates a same-Machine distinct-root Sync through its owner Action (custodian=%s)', async sourceCustodianAccountId => {
  executionBoundary.member = false;
  const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', sourceCustodianAccountId, socketIo, allowRelationshipAction: true });
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
  const result = await setup.executeRelationshipAction();
  expect(result, JSON.stringify({ result, rejectedSelfCalls })).toMatchObject({ ok: true, result: { created: true } });
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  if (sourceCustodianAccountId !== 'member-a') expect(setup.custodianRows).toEqual(setup.custodianBefore);
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
