import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFailed, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ProjectAccountRowV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { WorkspaceSyncRelationshipCreateResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { deriveWorkspaceSyncEndpointId } from '@/workspaces/sync/transport/workspaceSyncBrokerProtocol';
import { composeBindChildSourcePhaseTestRuntime } from './createProductionDaemonWorkspaceSyncRuntime.testkit';

const socketIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: socketIo }));

await import('@/api/api');

it('recovers a Watching Fresh copy on native redial, ends its writer loan on Stop, and settles keep-files retirement', async () => {
  let phase = 'construct the source and target runtimes';
  onTestFailed(() => { console.error(`Workspace Sync lifecycle phase: ${phase}`); });
  const rows: ProjectAccountRowV1[] = [];
  const homeRows = createProjectAccountRowsHttpBoundary(rows);
  let offlineMachine: string | undefined;
  const fixture = await composeBindChildSourcePhaseTestRuntime({
    socketIo, withScmRuntime: true, projectRowsFromHttp: true, separateTargetParent: true, remoteSeed: true,
    loopbackWorkspaceSync: true, workerRunAtMost: 1,
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
  const stop = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE)!;
  phase = 'Stop the Watching copy';
  await expect(stop({ relationshipId: ingress.operationId })).resolves.toEqual({ ok: true });
  phase = 'observe the recovered stream close after Stop';
  await recoveredStream.done;
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
}, 60_000);
