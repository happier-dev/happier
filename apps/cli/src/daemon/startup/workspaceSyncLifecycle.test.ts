import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, createDirectRouteGrantSigningInputV2 } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import tweetnacl from 'tweetnacl';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ProjectAccountRowV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { WorkspaceSyncRelationshipCreateResultV1Schema, WorkspaceSyncRelationshipTerminateActionOutputV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import * as installationStore from '@/daemon/identity/store';
import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { deriveWorkspaceSyncEndpointId } from '@/workspaces/sync/transport/workspaceSyncBrokerProtocol';
import { readWorkspaceSyncFinalReadyFactAtPath, writeWorkspaceSyncFinalReadyFact } from '@/workspaces/sync/workspaceSyncFinalReadyFact';
import { resolveWorkspaceSyncWorkerTarget } from '@/workspaces/sync/workspaceSyncPreparation';
import { createRequesterWorkspaceSyncFixture } from './createRequesterWorkspaceSyncFixture.testkit';
import { composeBindChildSourcePhaseTestRuntime } from './createProductionDaemonWorkspaceSyncRuntime.testkit';

const socketIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: socketIo }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  const { requesterWorkspaceSyncInstallationFilesystemBoundary } = await import('./requesterWorkspaceSyncFilesystem.testkit');
  return requesterWorkspaceSyncInstallationFilesystemBoundary(actual);
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
  return { ...actual, spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) =>
    spawnRequesterWorkspaceSyncProcessBoundary(actual, command, args, options, false) };
});

await import('@/api/api');

it('recovers a Watching Fresh copy on native redial, ends its writer loan on Stop, and settles keep-files retirement', async () => {
  let phase = 'construct the source and target runtimes';
  onTestFailed(() => { console.error(`Workspace Sync lifecycle phase: ${phase}`); });
  const rows: ProjectAccountRowV1[] = [];
  const homeRows = createProjectAccountRowsHttpBoundary(rows);
  let offlineMachine: string | undefined;
  let targetMaterialization: string | undefined;
  const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
    version: 1, createdAt: 1, installationId: 'target-parent-installation', publicKey: 'fixture', privateKey: 'fixture',
  });
  // The two fixture runtimes share a process; only the target reads installation identity for READY restore.
  onTestFinished(() => { identity.mockRestore(); });
  const fixture = await composeBindChildSourcePhaseTestRuntime({
    socketIo, withScmRuntime: true, projectRowsFromHttp: true, separateTargetParent: true, remoteSeed: true,
    loopbackWorkspaceSync: true, workerRunAtMost: 1,
    prepareActiveServerDirectory: async directory => {
      if (basename(dirname(dirname(directory))) === 'target-parent') {
        targetMaterialization = join(directory, 'workspace-sync', 'materialization');
      }
    },
    readAdditionalHttpPostResponse: async (url, body) =>
      url.includes('/v1/account/project-rows/') ? await homeRows(url, body) : undefined,
    handleAdditionalSocketAck: async raw => {
      if (offlineMachine && raw && typeof raw === 'object' && 'method' in raw
        && typeof raw.method === 'string' && raw.method.startsWith(`${offlineMachine}:`)) {
        return { ok: false, error: 'RPC target unavailable', errorCode: 'target_unavailable' };
      }
      return undefined;
    },
  });
  const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: size => new Uint8Array(size) });
  const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.sourceRef.id };
  rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: fixture.sourceRef }) }));
  await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () =>
    readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
  phase = 'install the source WorkspaceRef';
  await fixture.settleProjects();

  const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
  const create = async (operationId: string) => {
    const targetPath = `${fixture.targetPath}-${operationId}`;
    const handler = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)!;
    const result = WorkspaceSyncRelationshipCreateResultV1Schema.parse(await handler({ v: 1, operationId, actionInput: {
      v: 1, sourceWorkspaceRefId: fixture.sourceRef.id, targetMachineId: fixture.targetRef.machineId,
      targetPath, mode: 'keep_synced', contentPolicy, destinationIntent: 'materialize_from_source_workspace', purpose: 'worker_clean_copy',
    } }));
    await fixture.settleProjects();
    const relationship = getActiveProjectAccountRowsSnapshot()?.relationships.find(link => link.relationshipId === result.relationshipId);
    expect(relationship).toMatchObject({ enabled: true, committedAtMs: expect.any(Number) });
    expect(await fixture.parent.workspaceSync.controller.get(result.relationshipId)).toMatchObject({ state: 'watching' });
    expect(await readFile(join(targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    return { result, relationship: relationship!, targetPath };
  };
  const retire = ({ relationship }: Awaited<ReturnType<typeof create>>) =>
    fixture.parent.workspaceSync.relationshipOwner.stop(relationship.relationshipId, undefined, { expectedRelationship: relationship });
  const expectKeptFiles = async ({ relationship, targetPath }: Awaited<ReturnType<typeof create>>) => {
    expect(getActiveProjectAccountRowsSnapshot()?.relationships.some(link => link.relationshipId === relationship.relationshipId)).toBe(false);
    expect(await readFile(join(targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  };

  phase = 'create the Watching copy';
  const watched = await create('watched');
  const ingress = { operationId: watched.relationship.relationshipId, sourceMachineId: fixture.sourceRef.machineId,
    targetMachineId: fixture.targetRef.machineId };
  const endpoint = deriveWorkspaceSyncEndpointId(ingress.operationId, 'beta');
  const openNativeStream = async () => {
    // Drive the Mutagen process boundary with its OPEN_DATA request. Bytes
    // traverse the real broker and target ingress to the rooted-agent fixture.
    const pipe = await fixture.openSourceNativeStream(endpoint);
    const echo = once(pipe.stream, 'data');
    pipe.stream.write('native-cycle');
    expect((await echo)[0]).toEqual(Buffer.from('native-cycle'));
    return pipe;
  };
  phase = 'exchange bytes through the original broker stream';
  const originalStream = await openNativeStream();
  phase = 'restart the target runtime';
  await fixture.restartTargetParent();
  phase = 'observe the original stream close';
  await originalStream.done;
  phase = 'redial the target through the source broker';
  const recoveredStream = await openNativeStream();
  expect(await fixture.parent.workspaceSync.controller.get(ingress.operationId)).toMatchObject({ state: 'watching' });
  phase = 'reload the retained signed READY binding from a committed Worker copy';
  const committedRows = [...rows];
  await fixture.targetParent!.stop();
  await recoveredStream.done;
  const materialization = targetMaterialization!;
  const readyFiles = (await readdir(materialization)).filter(name => name.endsWith('.ready.json'));
  expect(readyFiles).toHaveLength(1);
  const readyPath = join(materialization, readyFiles[0]!);
  const ready = await readWorkspaceSyncFinalReadyFactAtPath(readyPath);
  if (ready?.v !== 1) throw new Error('The original copy has no READY fact');
  // Older signed creation wrote the admitted binding before Home stamped the commit.
  // Replace only the persisted READY record. The Home rows, root and receipt came from Create.
  await writeWorkspaceSyncFinalReadyFact(readyPath, { ...ready, v: 2, requesterCopyCustody: {
    accountServerId: fixture.serverId,
    actorAccountId: 'owner',
    sourceWriter: { machineId: fixture.sourceRef.machineId, installationId: 'parent-installation' },
    sourceWorkspace: { id: fixture.sourceRef.id, machineId: fixture.sourceRef.machineId, rootPath: fixture.sourceRef.rootPath },
    target: { machineId: fixture.targetRef.machineId, installationId: 'target-parent-installation' },
    relationship: { ...watched.relationship, committedAtMs: null },
  } });
  const archivedReady = await readFile(readyPath, 'utf8');
  await fixture.restartTargetParent();
  await fixture.restartSourceParent();
  await fixture.settleProjects();
  const status = await fixture.parent.workspaceSync.controller.get(ingress.operationId);
  expect(status).toMatchObject({ state: 'watching' });
  const current = getActiveProjectAccountRowsSnapshot()!;
  expect(current.relationships).toEqual([watched.relationship]);
  expect(rows).toEqual(committedRows);
  expect(resolveWorkspaceSyncWorkerTarget({ serverId: fixture.serverId, sourceWorkspaceRefId: fixture.sourceRef.id,
    targetMachineId: fixture.targetRef.machineId, workspaceRefs: current.workspaceRefs, relationships: current.relationships,
    relationshipStatuses: [status!],
  })).toMatchObject({ ok: true, target: { id: watched.result.targetWorkspaceRefId } });
  expect(await readFile(readyPath, 'utf8')).toBe(archivedReady);
  const reloadedStream = await openNativeStream();
  const stop = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE)!;
  phase = 'Stop the Watching copy';
  await expect(stop({ relationshipId: ingress.operationId })).resolves.toEqual({ ok: true });
  phase = 'observe the recovered stream close after Stop';
  await reloadedStream.done;
  await expect(fixture.targetParent!.acquireWorkspaceSyncMachineIngress(ingress)).rejects.toMatchObject({ code: 'peer_unavailable' });
  await expectKeptFiles(watched);

  phase = 'remove an idle link';
  const idle = await create('idle');
  await expect(retire(idle)).resolves.toBeUndefined();
  await expectKeptFiles(idle);

  phase = 'remove an idle link while the target is down';
  const offline = await create('offline');
  await fixture.targetParent!.stop();
  offlineMachine = fixture.targetRef.machineId;
  await expect(retire(offline)).resolves.toEqual({ uncheckedMachineIds: [fixture.targetRef.machineId] });
  await expectKeptFiles(offline);
  offlineMachine = undefined;
  await fixture.restartTargetParent();

  phase = 'refuse removal with dependent work';
  const inUse = await create('in-use');
  const worker = fixture.workerAdmissions.get(fixture.targetRef.machineId)!;
  let started!: () => void;
  let finish!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const finishWork = new Promise<void>(resolve => { finish = resolve; });
  const pending = worker.execute({ operationId: 'dependent-work', workspaceRefId: inUse.result.targetWorkspaceRefId,
    relationshipId: inUse.relationship.relationshipId, signal: new AbortController().signal, accept() {},
    run: async ({ phase }) => { phase('running'); started(); await finishWork;
      return { kind: 'process_settled', result: { ok: true, result: {} } }; } });
  try {
    await Promise.race([running, pending.then(() => { throw new Error('Dependent work did not start'); })]);
    await expect(retire(inUse)).rejects.toMatchObject({
      code: 'workspace_sync_relationship_in_use', dependencies: [expect.objectContaining({ operationId: 'dependent-work' })],
    });
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toContainEqual(inUse.relationship);
    expect(await readFile(join(inUse.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  } finally {
    finish();
    await pending;
  }

  phase = 'settle the Fresh-copy runtimes before exercising the shared source';
  await fixture.parent.stop();
  await fixture.targetParent!.stop();
  identity.mockRestore();
  if (process.platform === 'linux') {
    await exerciseSharedSourceLifecycle(value => { phase = value; });
  }
}, 60_000);

async function exerciseSharedSourceLifecycle(setPhase: (value: string) => void) {
  setPhase('construct the shared source and target runtimes');
  const actualSocket = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');
  socketIo.mockImplementation(actualSocket.io);
  const signingKey = tweetnacl.sign.keyPair();
  const setup = await createRequesterWorkspaceSyncFixture({
    role: 'use', isolationOff: true, gitReplica: 'existing', remoteTarget: true, remoteSeed: true,
    originalActionHomeHttp: true, socketIo, allowRelationshipAction: true, allowRelationshipControls: true,
    nativeCarrierHome: {
      resolveTrustRoots: () => [{ keyId: 'shared-home', publicKey: Buffer.from(signingKey.publicKey).toString('base64url') }],
      readTargetMachine: async id => ({ id, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1],
          endpointId: (id === 'target-parent' ? 'b' : 'a').repeat(64), directAddresses: ['127.0.0.1:7777'] } } }),
      mintGrant: async ({ kind, ttlMs, ...binding }) => {
        const now = Date.now();
        const payload = { ...binding, grantId: 'shared-restart-grant', accountId: 'member-a', iat: now, exp: now + ttlMs,
          aud: 'happier-daemon-route-grant' as const, proofKind: kind };
        return { payload, signature: { keyId: 'shared-home', alg: 'Ed25519' as const,
          valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)),
            signingKey.secretKey)).toString('base64url') } };
      },
      admitNativeTunnel: async ({ handshake }) => {
        if (handshake.flow !== 'workspace_sync' || handshake.initiator.kind !== 'machine') {
          throw new Error('Shared Sync carrier sent the wrong handshake');
        }
        return setup.fixture.targetParent!.acquireWorkspaceSyncMachineIngress({
          operationId: handshake.operationId, sourceMachineId: handshake.initiator.machineId,
          targetMachineId: handshake.target.machineId, actorAccountId: handshake.accountId,
        });
      },
    },
  });
  setPhase('create a Keep-updated Git Replica under Use on the shared source');
  runScmExecutable(setup.sourcePath, 'git', ['clone', '-q', '.', setup.targetPath]);
  const created = await setup.executeNativeRelationshipAction();
  expect(created, JSON.stringify({ result: created, refusals: setup.homeActionRefusals })).toMatchObject({ ok: true, result: { created: true } });
  if (!created.ok) throw new Error('The shared Git Replica was refused');
  const { relationshipId } = WorkspaceSyncRelationshipCreateResultV1Schema.parse(created.result);
  const controller = setup.fixture.parent.workspaceSync.controller;
  const endpoint = deriveWorkspaceSyncEndpointId(relationshipId, 'beta');
  const openNativeStream = async () => {
    const pipe = await setup.fixture.openSourceNativeStream(endpoint);
    const echo = once(pipe.stream, 'data');
    pipe.stream.write('shared-native-cycle');
    expect((await echo)[0]).toEqual(Buffer.from('shared-native-cycle'));
    return pipe;
  };
  setPhase('open the first native writer stream under Use');
  const original = await openNativeStream();
  setPhase('read the retained shared target before restart');
  const read = { relationshipId, side: 'beta' as const, path: 'payload.txt', maxBytes: 128 };
  await expect(controller.readFile(read)).resolves.toMatchObject({ status: 'text', text: 'before quiesce' });
  setPhase('redial the restarted target and retain Watching and signed reads under Use');
  await setup.restartTargetParent();
  await original.done;
  const recovered = await openNativeStream();
  expect(await controller.get(relationshipId)).toMatchObject({ state: 'watching' });
  await expect(controller.readFile(read)).resolves.toMatchObject({ status: 'text', text: 'before quiesce' });
  setPhase('Stop the shared link from the person’s target using the CLI');
  const cli = createCliActionExecutorFromCredentials({
    credentials: { ...setup.credentials, credentialProvenance: 'stored_session' },
    externalActionClient: true, serverId: setup.installed.serverId,
    serverIdentityId: setup.installed.homeServerIdentityId, serverApiUrl: setup.installed.serverHttpBaseUrl,
    machineId: setup.fixture.targetRef.machineId,
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'workspace.sync.relationship.terminate': ['cli'] } },
    }) }),
  });
  const control = await cli.execute('workspace.sync.relationship.terminate', {
    relationshipId, controllerMachineId: setup.fixture.targetRef.machineId,
  }, { surface: 'cli', authority: 'present_user' });
  expect(control, JSON.stringify({ result: control, routes: setup.homeActionRoutes, refusals: setup.homeActionRefusals })).toMatchObject({ ok: true });
  if (!control.ok) throw new Error('The shared Sync Stop was refused');
  expect(WorkspaceSyncRelationshipTerminateActionOutputV1Schema.parse(control.result)).toEqual({
    v: 1, relationshipId, terminated: true,
  });
  expect(setup.homeActionRequests.at(-1)?.placement.machineId).toBe(setup.installed.machineId);
  await recovered.done;
  await expect(controller.readFile(read)).rejects.toMatchObject({ code: 'relationship_not_ready' });
  await expect(setup.fixture.targetParent!.acquireWorkspaceSyncMachineIngress({ operationId: relationshipId,
    sourceMachineId: setup.installed.machineId, targetMachineId: setup.fixture.targetRef.machineId,
    actorAccountId: 'member-a',
  })).rejects.toMatchObject({ code: 'peer_unavailable' });
  expect(await readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
}
