import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { dirname, join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { configuration } from '@/configuration';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import { startPrivateProjectSyncChannel } from '@/workspaces/activation/privateProjectCheckoutProcess';
import { isManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createProductionDaemonWorkspaceSyncRuntime } from './createProductionDaemonWorkspaceSyncRuntime';
import { prepareManagedSessionProjectFilesSync } from './prepareManagedSessionProjectFilesSync';
import { acquireWorkspaceSyncTestScmRuntime, createWorkspaceSyncNativeProcessTestBoundary } from './createProductionDaemonWorkspaceSyncRuntime.testkit';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { listRequesterSessionCredentialBindings } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { openProject } from '@/workspaces/activation/openProject';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { connectWorkspaceSyncMachineTunnel } from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import { ProjectAccountRowContentV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createDefaultWorkspaceContentPolicyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

it('refuses another Account before opening managed relationship channels', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-sync-runtime-'));
  const native = createWorkspaceSyncNativeProcessTestBoundary();
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from('{"sub":"owner"}').toString('base64url'), 'signature'].join('.');
  const runtime = await createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: directory,
    activeServerDir: join(directory, 'server'), activeServerId: 'server-1', localMachineId: 'host',
    releaseChannel: 'publicdev', credentials: { token, encryption: null } }, {
      ...native.factories, getProjectSnapshot: () => null, subscribeProjectSnapshot: () => () => {},
      resolveRootOwnershipDirectory: () => join(directory, 'locks'),
    });
  onTestFinished(async () => { await runtime.stop(); await rm(directory, { recursive: true, force: true }); });
  await expect(prepareManagedSessionProjectFilesSync({ runtime: runtime.prepareManagedProjectFilesSync, credentials: { token, encryption: null },
    sourceRootPath: '/host/source', targetRootPath: '/guest/target',
    mode: 'keep_synced', targetManaged: { managedId: 'sandbox', controller: { machineId: 'host', installationId: 'install' } },
    requesterAccountId: 'other' })).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
});

it('persists a requester relationship, flushes native channels, and reopens without replacing guest files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-sync-requester-'));
  const sourceRootPath = join(directory, 'host');
  const targetRootPath = join(directory, 'guest', 'retained-copy');
  const home = join(directory, 'guest-home');
  await Promise.all([mkdir(sourceRootPath, { recursive: true }), mkdir(targetRootPath, { recursive: true }), mkdir(home)]);
  await writeFile(join(targetRootPath, 'guest-only.txt'), 'keep guest changes');
  const selectedBytes = Buffer.from([0, 1, 2, 255, 128, 0, 99, 10]);
  await writeFile(join(sourceRootPath, 'reviewed.bin'), 'source base');
  await writeFile(join(targetRootPath, 'reviewed.bin'), 'original');
  const holderPath = resolveSessionHolderExecutablePath();
  const helperPath = resolveProcessCustodySupportExecutable('linux');
  expect(holderPath).toBeTruthy(); expect(helperPath).toBeTruthy();
  for (const root of [sourceRootPath, targetRootPath]) {
    runScmExecutable(root, 'git', ['init', '-q']);
    await writeFile(join(root, '.gitignore'), 'ignored.env\n');
    runScmExecutable(root, 'git', ['add', 'reviewed.bin', '.gitignore']);
    runScmExecutable(root, 'git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'base']);
    await writeFile(join(root, 'ignored.env'), 'private');
  }
  await writeFile(join(sourceRootPath, 'reviewed.bin'), selectedBytes);
  const scmRuntime = await acquireWorkspaceSyncTestScmRuntime();
  onTestFinished(async () => { await scmRuntime.release(); });
  const credentialsFor = (accountId: string) => ({ token: [Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url'), 'signature'].join('.'), encryption: null });
  const credentials = credentialsFor('requester');
  const installedCredentials = credentialsFor('custodian');
  const serverId = 'srv_managed_sync_home';
  await seedTestServerProfile({ id: serverId, homeId: serverId, serverUrl: 'https://managed-sync.invalid' });
  const rows: unknown[] = [];
  const socket = await createRequesterCurrentnessSocketHarness();
  const observedPolicies: unknown[] = [];
  const http = createProjectAccountRowsHttpBoundary(rows, { beforeMutation: request => {
    for (const mutation of request.mutations) {
      if (mutation.key.kind !== 'relationship-graph' || mutation.content === null) continue;
      const content = ProjectAccountRowContentV1Schema.parse(mutation.content);
      if (content.t === 'plain' && content.v.key.kind === 'relationship-graph' && 'relationships' in content.v.value) {
        for (const relationship of content.v.value.relationships) observedPolicies.push(relationship.contentPolicy);
      }
    }
  } });
  const installedHttp = createProjectAccountRowsHttpBoundary([]);
  const reads: unknown[] = [];
  const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'requester' } };
    if (String(url).endsWith('/v1/machines/host')) return { status: 200, data: { machine: {
      id: 'host', metadata: 'opaque', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
      installationId: 'installation', revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'custodian', displayName: 'Custodian' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
    } } };
    return { status: 200, data: String(url).endsWith('/currentness') ? { mode: 'plain', version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null } : { mode: 'plain', updatedAt: 0 } };
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    reads.push(config?.headers?.Authorization);
    return config?.headers?.Authorization === `Bearer ${installedCredentials.token}` ? installedHttp(url, body) : http(url, body);
  });
  const boundary = createWorkspaceSyncNativeProcessTestBoundary();
  const channels: Duplex[] = [];
  const agentChannels: Duplex[] = [];
  const workers: Promise<void>[] = [];
  let releasedRootWithLiveAgent = false;
  let openingCount = 0;
  let capturedLifetime: AbortSignal | undefined;
  const createRuntime = () => runWithServerHttpBaseUrl('https://managed-sync.invalid', async () => {
    await readProjectAccountRows({ credentials: installedCredentials, serverId, publication: 'installed' });
    return createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: configuration.happyHomeDir,
      activeServerDir: join(directory, 'server'), activeServerId: serverId, localMachineId: 'host',
      releaseChannel: 'publicdev', credentials: installedCredentials, isCurrent: async () => true,
      requesterMachineAdmissionBoundary: { machineId: 'host', daemonToken: installedCredentials.token,
        isHomeCurrent: () => true, readInstallation: () => ({ installationId: 'installation', privateKey: new Uint8Array(64) }) },
      // The existing SOURCE relationship RPC is the remote transport boundary.
      callWorkspaceProjectSource: async () => ({ kind: 'materialized' }),
      openManagedWorkspaceTarget: async request => {
        openingCount++;
        expect(request.requesterAccountId).toBe('requester');
        expect(request.workspace.rootPath).toBe(targetRootPath);
        expect(request.workspace).not.toHaveProperty('machineId');
        capturedLifetime = request.lifetime;
        return { id: 'managed:sandbox', holderPath: holderPath!, helperPath: helperPath!, home, platform: { os: 'linux', arch: 'x64', home },
          exec: async () => { throw new Error('No guest shell effects are needed'); },
          putFile: async () => { throw new Error('Sync uses the existing native transfer sink'); },
          ensureWorkspaceRuntime: async () => ({ binaryPath: '/guest/happier' }),
          openChannel: (argv, signal) => {
            if (argv[0] === holderPath) {
              // The managed target process boundary runs the actual finite holder bridge.
              const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
              const channel = Duplex.from({ readable: child.stdout, writable: child.stdin });
              const stop = () => { child.kill(); };
              signal.addEventListener('abort', stop, { once: true });
              child.once('error', error => channel.destroy(error));
              workers.push(new Promise<void>(resolve => child.once('close', () => {
                signal.removeEventListener('abort', stop); channel.destroy(); resolve();
              })));
              channel.once('close', stop);
              channels.push(channel);
              return channel;
            }
            if (argv[0] === 'sh') {
              expect(argv.slice(-2)).toEqual([dirname(targetRootPath), '/guest/happier']);
              const input = new PassThrough(); const output = new PassThrough();
              const channel = Duplex.from({ readable: output, writable: input });
              channels.push(channel);
              const worker = runWorkspaceEffectWorker([], { input, output, signal,
                currentDirectory: () => dirname(targetRootPath) }).finally(() => {
                  releasedRootWithLiveAgent ||= agentChannels.some(agent => !agent.destroyed);
                  output.end();
                });
              workers.push(worker);
              void worker.catch(error => channel.destroy(error));
              return channel;
            }
            expect(argv).toEqual(['/fixture-agent', 'synchronizer', '--external', '--root', targetRootPath]);
            const channel = new PassThrough({ autoDestroy: false }); channels.push(channel); agentChannels.push(channel);
            signal.addEventListener('abort', () => channel.destroy(), { once: true });
            return channel;
          },
        };
      },
    }, { ...boundary.factories, resolveRootOwnershipDirectory: () => join(directory, 'locks'),
      launchLocalAgent: async () => { const stream = new PassThrough({ autoDestroy: false }); return { stream, stop: async () => { stream.destroy(); } }; },
      // Managed runtime acquisition is the artifact boundary; all framing,
      // bootstrap, Account graph, controller and native filesystem logic stays real.
      startManagedSyncChannel: async input => {
        return await startPrivateProjectSyncChannel({ ...input,
          configuration: { ...input.configuration, agent: { executablePath: '/fixture-agent' } } });
      },
    });
  });
  let runtime = await createRuntime();
  onTestFinished(async () => {
    await runtime.stop();
    await Promise.all(workers);
    await socket.close();
    post.mockRestore(); get.mockRestore(); withdrawActiveProjectAccountRowsSnapshot();
    await rm(directory, { recursive: true, force: true });
  });
  const sourceSignal = new AbortController();
  const request = { sourceRootPath, targetRootPath, mode: 'keep_both_in_sync' as const,
    targetManaged: { managedId: 'sandbox', controller: { machineId: 'host', installationId: 'installation' } },
    runtime: runtime.prepareManagedProjectFilesSync, requesterAccountId: 'requester', credentials,
    bootstrap: { attribution: { serverId, accountId: 'requester', machineId: 'host', installationId: 'installation' },
      savedSecretOperationContext: { serverHttpBaseUrl: 'https://managed-sync.invalid', isCurrent: async () => true,
        machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'custodian', role: 'use' as const } } }, signal: sourceSignal.signal };
  let preparationFailure: unknown;
  const created = await prepareManagedSessionProjectFilesSync(request).catch(error => { preparationFailure = error; return undefined; });
  expect(observedPolicies).toContainEqual(createDefaultWorkspaceContentPolicyV1());
  if (!created) throw preparationFailure;
  expect(await listRequesterSessionCredentialBindings({ happyHomeDir: configuration.happyHomeDir, serverId,
    machineId: 'host', installationId: 'installation', sessionId: created.relationshipId,
    scope: 'workspace_sync_relationship', endpointRole: 'managed_target' })).toMatchObject({ status: 'ready', bindings: [{ sessionId: created.relationshipId }] });
  sourceSignal.abort();
  expect(capturedLifetime?.aborted).toBe(false);
  expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([]);
  const snapshot = await readProjectAccountRows({ credentials, sessionCustody: { serverId, accountId: 'requester',
    serverHttpBaseUrl: 'https://managed-sync.invalid', isCurrent: async () => true }, serverId,
    selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
  expect(snapshot.relationships).toHaveLength(1);
  expect(snapshot.relationships[0]?.contentPolicy).toMatchObject({ selection: 'git_worktree',
    extraIgnorePatterns: [], extraIncludePatterns: [] });
  const target = snapshot.workspaceRefs.find(ref => isManagedWorkspaceRefV2(ref) && ref.rootPath === targetRootPath);
  expect(target).toBeDefined();
  expect(await runtime.workspaceSync.readFileAtTarget!({ relationshipId: created.relationshipId,
    workspaceRefId: target!.id, path: 'guest-only.txt', maxBytes: 1024 })).toMatchObject({ status: 'text', text: 'keep guest changes' });
  await expect(runtime.acquireWorkspaceSyncMachineIngress({ operationId: created.relationshipId,
    sourceMachineId: 'host', targetMachineId: 'host', actorAccountId: 'custodian' }))
    .rejects.toMatchObject({ code: 'peer_unavailable' });
  const ingressReady = runtime.acquireWorkspaceSyncMachineIngress({ operationId: created.relationshipId,
    sourceMachineId: 'host', targetMachineId: 'host', actorAccountId: 'requester' });
  await expect(ingressReady).resolves.toMatchObject({ port: expect.any(Number) });
  const ingress = await ingressReady;
  const agent = await connectWorkspaceSyncMachineTunnel({ localPort: ingress.port, localCapability: ingress.localCapability,
    observedPath: 'direct', close: ingress.close });
  try {
    const received = new Promise<Buffer>(resolve => agent.stream.once('data', resolve));
    agent.stream.write(Buffer.from('native channel'));
    expect((await received).toString()).toBe('native channel');
  } finally { await agent.stop(); }
  const source = snapshot.workspaceRefs.find(ref => ref.rootPath === sourceRootPath)!;
  const projectRequest: OpenProjectInputV1 = { serverId, machineId: 'host', source: { kind: 'workspace', workspaceId: source.id,
    checkout: { serverId, workspaceId: source.id, machineId: 'host', rootPath: sourceRootPath } },
    materialization: { kind: 'sync', targetPath: targetRootPath, targetManaged: request.targetManaged,
      workspaceAction: { kind: 'relationship', relationshipId: created.relationshipId, flushBeforeCommit: true } } };
  const envelope = { v: 1 as const, requestId: 'open-native', target: { kind: 'machine' as const, machineId: 'host' }, input: projectRequest };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-project-child', binding: {
    accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
    custodianAccountId: 'custodian', serverIdentityId: serverId, machineId: 'host', installationId: 'installation',
    actionId: 'projects.open', requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    target: envelope.target } });
  const projectContext = {
    signal: new AbortController().signal, callerAuthority: 'present_user', originalActionEnvelope: envelope,
    callerInputAuthorization: authorization, verifyMachineAdmissionCurrent: async () => true,
    machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'host',
      installationId: 'installation', role: 'use', encryptionMode: 'plain' } } satisfies import('@/api/rpc/types').RpcHandlerContext;
  const opened = await openProject(projectRequest, { serverId, serverHttpBaseUrl: 'https://managed-sync.invalid',
    machineId: 'host', accountId: 'custodian', readCredentials: async () => installedCredentials,
    workspaceSyncAdapter: runtime.handoffAdapter, materializeManagedProjectTarget: runtime.materializeManagedProjectTarget }, projectContext);
  expect(opened).toMatchObject({ kind: 'opened', directory: targetRootPath,
    workspace: { v: 2, kind: 'managed', workspaceId: target!.id, managedId: 'sandbox' } });
  await writeFile(join(targetRootPath, 'reviewed.bin'), selectedBytes);
  const reopened = await prepareManagedSessionProjectFilesSync({ ...request, signal: undefined });
  expect(reopened).toEqual(created);
  expect(openingCount).toBe(1);
  expect(await readFile(join(targetRootPath, 'guest-only.txt'), 'utf8')).toBe('keep guest changes');
  await runtime.stop();
  runtime = await createRuntime();
  const reconnectedReady = runtime.acquireWorkspaceSyncMachineIngress({ operationId: created.relationshipId,
    sourceMachineId: 'host', targetMachineId: 'host', actorAccountId: 'requester' });
  await expect(reconnectedReady).resolves.toMatchObject({ port: expect.any(Number) });
  const reconnected = await reconnectedReady;
  await reconnected.close();
  const recovered = await runtime.workspaceSync.readFileAtTarget({ relationshipId: created.relationshipId,
    workspaceRefId: target!.id, path: 'reviewed.bin', maxBytes: 1024 });
  expect(recovered).toMatchObject({ status: 'binary' });
  expect(openingCount).toBe(2);
  expect(await readFile(join(targetRootPath, 'guest-only.txt'), 'utf8')).toBe('keep guest changes');
  const view = await runtime.workspaceSync.forRequester!({ signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'host',
      installationId: 'installation', role: 'use', encryptionMode: 'plain' } });
  const liveIngressReady = runtime.acquireWorkspaceSyncMachineIngress({ operationId: created.relationshipId,
    sourceMachineId: 'host', targetMachineId: 'host', actorAccountId: 'requester' });
  await expect(liveIngressReady).resolves.toMatchObject({ port: expect.any(Number) });
  const liveIngress = await liveIngressReady;
  const liveAgent = await connectWorkspaceSyncMachineTunnel({ localPort: liveIngress.port, localCapability: liveIngress.localCapability,
    observedPath: 'direct', close: liveIngress.close });
  const echoed = new Promise(resolve => liveAgent.stream.once('data', resolve));
  liveAgent.stream.write(Buffer.from('live during disable')); await echoed;
  const disconnected = new Promise(resolve => liveAgent.stream.once('end', resolve));
  await view.relationshipOwner.setEnabled(created.relationshipId, false);
  await disconnected; liveAgent.stream.end(); await liveAgent.stop();
  expect(releasedRootWithLiveAgent).toBe(false);
  expect(capturedLifetime?.aborted).toBe(true);
  await view.relationshipOwner.setEnabled(created.relationshipId, true);
  expect(openingCount).toBe(3);
  expect(capturedLifetime?.aborted).toBe(false);
  expect(await readFile(join(targetRootPath, 'guest-only.txt'), 'utf8')).toBe('keep guest changes');
  expect(reads.filter(value => value === `Bearer ${credentials.token}`).length).toBeGreaterThan(0);
});
