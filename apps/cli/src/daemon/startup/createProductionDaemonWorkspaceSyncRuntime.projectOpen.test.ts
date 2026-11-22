import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol';
import { SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/actions/sessionWorkspaceReturnActionIdsV1';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { createDefaultWorkspaceContentPolicyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { deriveWorkspaceSyncRelationshipId } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { startPrivateProjectSyncChannel } from '@/workspaces/activation/privateProjectCheckoutProcess';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import { logger } from '@/ui/logger';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createPlainProjectAccountRefRow, createProjectAccountRowsHttpBoundary, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { openProject } from '@/workspaces/activation/openProject';
import { createProductionDaemonWorkspaceSyncRuntime } from './createProductionDaemonWorkspaceSyncRuntime';
import { acquireWorkspaceSyncTestScmRuntime, createWorkspaceSyncNativeProcessTestBoundary } from './createProductionDaemonWorkspaceSyncRuntime.testkit';

it('routes admitted native Project Open through retained requester custody before host checkout preparation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-project-open-'));
  const serverId = 'srv_native_project_entry';
  await seedTestServerProfile({ id: serverId, homeId: serverId, serverUrl: 'https://native-open.invalid' });
  const native = createWorkspaceSyncNativeProcessTestBoundary();
  const rows: unknown[] = [];
  const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  const post = vi.spyOn(axios, 'post').mockImplementation(createProjectAccountRowsHttpBoundary(rows));
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from('{"sub":"owner"}').toString('base64url'), 'signature'].join('.');
  const credentials = { token, encryption: null };
  const runtime = await createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: directory,
    activeServerDir: join(directory, 'server'), activeServerId: serverId, localMachineId: 'host',
    releaseChannel: 'publicdev', credentials,
    callWorkspaceProjectSource: async () => { throw new Error('An unretained root must not reach the SOURCE transport'); },
  }, { ...native.factories, getProjectSnapshot: () => null, subscribeProjectSnapshot: () => () => {},
    resolveRootOwnershipDirectory: () => join(directory, 'locks') });
  onTestFinished(async () => { await runtime.stop(); get.mockRestore(); post.mockRestore();
    withdrawActiveProjectAccountRowsSnapshot(); await rm(directory, { recursive: true, force: true }); });
  const request: OpenProjectInputV1 = { serverId, machineId: 'host', source: { kind: 'workspace', workspaceId: 'source',
    checkout: { serverId, workspaceId: 'source', machineId: 'host', rootPath: '/selected/source' } },
    materialization: { kind: 'sync', targetPath: '/guest/retained',
      targetManaged: { managedId: 'sandbox', controller: { machineId: 'host', installationId: 'installation' } },
      workspaceAction: { kind: 'relationship', relationshipId: 'relationship', flushBeforeCommit: true } } };
  const context = { signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'host',
      installationId: 'installation', role: 'use', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true } satisfies import('@/api/rpc/types').RpcHandlerContext;
  const projectRuntime = { serverId, serverHttpBaseUrl: 'https://native-open.invalid', machineId: 'host', accountId: 'owner',
    readCredentials: async () => credentials, workspaceSyncAdapter: runtime.handoffAdapter,
    materializeManagedProjectTarget: runtime.materializeManagedProjectTarget };
  await expect(openProject(request, projectRuntime, context)).resolves.toMatchObject({ kind: 'refused', code: 'project_requester_authority_unavailable' });
  await expect(openProject(request, { ...projectRuntime, materializeManagedProjectTarget: undefined }, context))
    .resolves.toMatchObject({ kind: 'refused', code: 'workspace_sync_unavailable' });
  await expect(openProject(request, projectRuntime, { ...context, verifyMachineAdmissionCurrent: async () => false }))
    .resolves.toMatchObject({ kind: 'refused', code: 'machine_access_denied' });
  expect(rows).toEqual([]);
});

it.each(['workspace', 'admitted Source'] as const)('copies a managed %s into a controller workspace through the native source', async entry => {
  const scmRuntime = await acquireWorkspaceSyncTestScmRuntime();
  onTestFinished(async () => { await scmRuntime.release(); });
  const diagnose = vi.spyOn(logger, 'warnLocalFile');
  onTestFinished(() => { diagnose.mockRestore(); });
  const directory = await mkdtemp(join(tmpdir(), 'managed-project-copy-'));
  const serverId = 'srv_native_project_copy';
  const serverHttpBaseUrl = 'https://native-copy.invalid';
  const sourcePath = join(directory, 'guest', 'source');
  const targetPath = join(directory, 'controller', 'copy');
  const home = join(directory, 'guest', 'home');
  await Promise.all([mkdir(sourcePath, { recursive: true }), mkdir(home, { recursive: true }), mkdir(dirname(targetPath))]);
  const bytes = Buffer.from([0, 255, 17, 0, 10]);
  await writeFile(join(sourcePath, 'guest-only.bin'), bytes);
  await seedTestServerProfile({ id: serverId, homeId: serverId, serverUrl: serverHttpBaseUrl });
  const controller = { machineId: 'host', installationId: 'installation' };
  const source: ManagedWorkspaceRefV2 = { v: 2, kind: 'managed', id: 'source', managedId: 'sandbox',
    serverId, rootPath: sourcePath, controller, createdAtMs: 1 };
  const key = { kind: 'workspace-ref', serverId, id: source.id };
  const rows = [{ key, revision: 0, content: { t: 'plain', v: { key, value: source } } }];
  const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (url.endsWith('/v1/machines/host')) return { status: 200, data: { machine: {
      id: 'host', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', homeDir: dirname(targetPath),
        username: 'owner', happyCliVersion: 'test', happyHomeDir: directory }),
      metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
      installationId: controller.installationId, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
    } } };
    return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(createProjectAccountRowsHttpBoundary(rows));
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from('{"sub":"owner"}').toString('base64url'), 'signature'].join('.');
  const credentials = { token, encryption: null };
  const native = createWorkspaceSyncNativeProcessTestBoundary();
  const guestLifetimes: AbortSignal[] = [];
  const workers: Promise<void>[] = [];
  const runtime = await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
    await readProjectAccountRows({ credentials, serverId, publication: 'installed' });
    return await createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: directory,
      activeServerDir: join(directory, 'server'), activeServerId: serverId, localMachineId: 'host',
      releaseChannel: 'publicdev', credentials,
      openManagedWorkspaceTarget: async request => {
        expect(request.workspace).toEqual(source);
        expect(request.requesterAccountId).toBe('owner');
        guestLifetimes.push(request.lifetime);
        return { id: 'managed:sandbox', home, platform: { os: 'linux', arch: 'x64', home },
          exec: async () => { throw new Error('The guest workspace worker owns source reads'); },
          putFile: async () => { throw new Error('Preparing the source does not replace its files'); },
          ensureWorkspaceRuntime: async () => ({ binaryPath: '/guest/happier' }),
          openChannel: (argv, signal) => {
            if (argv[0] === 'sh') {
              expect(argv.slice(-2)).toEqual([dirname(sourcePath), '/guest/happier']);
              const input = new PassThrough();
              const output = new PassThrough();
              const channel = Duplex.from({ readable: output, writable: input });
              channel.once('close', () => { input.destroy(); output.destroy(); });
              const worker = runWorkspaceEffectWorker([], { input, output, signal, currentDirectory: () => dirname(sourcePath) })
                .finally(() => { output.end(); });
              workers.push(worker);
              void worker.catch(error => channel.destroy(error));
              return channel;
            }
            expect(argv).toEqual(['/fixture-agent', 'synchronizer', '--external', '--root', sourcePath]);
            const channel = new PassThrough({ autoDestroy: false });
            signal.addEventListener('abort', () => channel.destroy(), { once: true });
            return channel;
          },
        };
      },
    }, { ...native.factories, resolveRootOwnershipDirectory: () => join(directory, 'locks'),
      launchLocalAgent: async () => {
        const stream = new PassThrough({ autoDestroy: false });
        return { stream, stop: async () => { stream.destroy(); } };
      },
      startManagedSyncChannel: async input => await startPrivateProjectSyncChannel({ ...input,
        configuration: { ...input.configuration, agent: { executablePath: '/fixture-agent' } } }),
    });
  });
  onTestFinished(async () => { await runtime.stop(); await Promise.all(workers); get.mockRestore(); post.mockRestore();
    withdrawActiveProjectAccountRowsSnapshot(); await rm(directory, { recursive: true, force: true }); });
  const contentPolicy = createDefaultWorkspaceContentPolicyV1();
  const checkout = { v: 2, kind: 'managed', serverId, workspaceId: source.id, managedId: source.managedId,
    rootPath: sourcePath, controller } as const;
  const projectSource = { id: 'forge-project', revision: 1, name: 'Repository', createdByAccountId: 'owner', audience: [],
    repository: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.invalid' },
      repository: { nameWithOwner: 'group/repo' }, protocol: 'https' } } satisfies ProjectSourceV1;
  const request: OpenProjectInputV1 = { serverId, machineId: controller.machineId,
    source: entry === 'workspace' ? { kind: 'workspace', workspaceId: source.id, checkout }
      : { kind: 'source', id: projectSource.id, revision: projectSource.revision, selector: projectSource.repository, checkout },
    materialization: { kind: 'sync', targetPath, workspaceAction: { kind: 'copy_once',
      contentPolicy } } };
  const context = { signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', ...controller, role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true } satisfies import('@/api/rpc/types').RpcHandlerContext;
  const projectRuntime = { serverId, serverHttpBaseUrl, machineId: controller.machineId, accountId: 'owner',
    readCredentials: async () => credentials, workspaceSyncAdapter: runtime.handoffAdapter };
  let ingress: import('@/api/rpc/types').RpcHandlerContext = context;
  if (entry === 'admitted Source') {
    const socket = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => socket.close());
    const sourceRead = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, source: projectSource, canManage: true } });
    onTestFinished(() => sourceRead.mockRestore());
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'managed-project-copy',
      target: { kind: 'machine', machineId: controller.machineId }, input: request });
    const authority = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-project-open',
      binding: { accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: serverId,
        accountEncryptionMode: 'plain', actionId: 'projects.open', ...controller, custodianAccountId: 'owner',
        requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        target: envelope.target, workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(envelope.requestId),
          sourceWorkspaceRefId: source.id, source: context.machineAdmission } } });
    const admitted = await admitRequesterAccountActionContext({ authorization: authority, credentials,
      serverId, serverIdentityId: serverId, serverHttpBaseUrl, isCurrent: async () => true });
    if (!admitted) throw new Error('Open must have an admitted Account port');
    onTestFinished(() => admitted.dispose());
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
      serverId, serverIdentityId: serverId, serverHttpBaseUrl, target: authority.binding.target,
      installationId: controller.installationId, privateKey: tweetnacl.sign.keyPair().secretKey, rootAdmitted: true });
    if (!authorization) throw new Error('Open must have an admitted HTTP port');
    ingress = { ...context, callerInputAuthorization: authorization, originalActionEnvelope: envelope };
  }
  const opened = await openProject(request, projectRuntime, ingress);
  expect(opened, JSON.stringify({ opened, diagnostics: diagnose.mock.calls })).toMatchObject({ kind: 'opened', directory: targetPath });
  expect(await readFile(join(targetPath, 'guest-only.bin'))).toEqual(bytes);
  expect(await readFile(join(sourcePath, 'guest-only.bin'))).toEqual(bytes);
  expect(guestLifetimes).toHaveLength(1);
  expect(guestLifetimes[0]?.aborted).toBe(true);
  expect(native.commands.some(command => command.t === 'terminate')).toBe(true);
});

it('uses the fresh Apply requester’s exact workspace row before opening the original guest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-return-custody-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const serverId = 'srv_return_custody';
  const serverHttpBaseUrl = 'https://return-custody.invalid';
  await seedTestServerProfile({ id: serverId, homeId: serverId, serverUrl: serverHttpBaseUrl });
  const socket = await createRequesterCurrentnessSocketHarness();
  onTestFinished(() => socket.close());
  const credentialsFor = (sub: string) => ({
    token: [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub })).toString('base64url'), 'signature'].join('.'),
    encryption: null,
  });
  const installed = credentialsFor('owner');
  const member = credentialsFor('member');
  const controller = { machineId: 'host', installationId: 'installation' };
  const ref: ManagedWorkspaceRefV2 = { v: 2, kind: 'managed', id: 'original', managedId: 'attachment',
    serverId, rootPath: '/guest/original', controller, createdAtMs: 1 };
  const workspace = workspaceAddressFromRefV2(ref);
  const row = createPlainProjectAccountRefRow(ref);
  let memberRows: readonly unknown[] = [];
  const rowReaders: unknown[] = [];
  const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'member' } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    const bearer = config?.headers?.Authorization;
    rowReaders.push(bearer);
    return projectAccountRowsReadHttpResponse(bearer === `Bearer ${installed.token}` ? [row] : memberRows, url, body);
  });
  onTestFinished(() => { get.mockRestore(); post.mockRestore(); });
  const native = createWorkspaceSyncNativeProcessTestBoundary();
  const opened: Array<{ workspace: typeof workspace; requesterAccountId: string }> = [];
  const transportUnavailable = Object.assign(new Error('Fixture transport stopped at guest open'), { code: 'fixture_native_not_connected' });
  const runtime = await createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: directory,
    activeServerDir: join(directory, 'server'), activeServerId: serverId, localMachineId: controller.machineId,
    releaseChannel: 'publicdev', credentials: installed,
    openManagedProjectWorkspace: async request => {
      opened.push({ workspace: request.workspace, requesterAccountId: request.requesterAccountId });
      throw transportUnavailable;
    },
  }, { ...native.factories, getProjectSnapshot: () => null, subscribeProjectSnapshot: () => () => {},
    resolveRootOwnershipDirectory: () => join(directory, 'locks') });
  onTestFinished(() => runtime.stop());
  const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'review-apply',
    target: { kind: 'machine', machineId: controller.machineId },
    input: { sessionId: 'copied', machineId: controller.machineId, returnId: 'review', paths: ['tracked.txt'] } });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-return-apply',
    binding: { accountId: 'member', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: serverId, accountEncryptionMode: 'plain', actionId: SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1,
      ...controller, custodianAccountId: 'owner', requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target } });
  const admitted = await admitRequesterAccountActionContext({ authorization, credentials: member,
    serverId, serverIdentityId: serverId, serverHttpBaseUrl, isCurrent: async () => true });
  if (!admitted) throw new Error('Apply must have an admitted Account port');
  onTestFinished(() => admitted.dispose());
  const context = { signal: new AbortController().signal, callerAuthority: 'present_user',
    callerInputAuthorization: admitted.authorization, originalActionEnvelope: envelope,
    machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', ...controller, role: 'use', encryptionMode: 'plain' },
  } satisfies import('@/api/rpc/types').RpcHandlerContext;
  const apply = runtime.workspaceSync.withManagedReturnTarget;
  if (!apply || workspace.kind !== 'managed') throw new Error('Managed Return Apply must be installed');
  await expect(apply(context, workspace, async () => {})).rejects.toMatchObject({ code: 'workspace_target_unavailable' });
  memberRows = [createPlainProjectAccountRefRow({ ...ref, controller: { ...controller, installationId: 'replaced-installation' } })];
  await expect(apply(context, workspace, async () => {})).rejects.toMatchObject({ code: 'workspace_target_unavailable' });
  expect(opened).toEqual([]);
  memberRows = [row];
  await expect(apply(context, workspace, async () => {})).rejects.toBe(transportUnavailable);
  expect(opened).toEqual([{ workspace, requesterAccountId: 'member' }]);
  expect(rowReaders).toEqual(Array(3).fill(`Bearer ${member.token}`));
});
