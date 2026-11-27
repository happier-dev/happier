import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { configuration } from '@/configuration';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import { startPrivateProjectSyncChannel } from '@/workspaces/activation/privateProjectCheckoutProcess';
import { isManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createDefaultWorkspaceContentPolicyV1, computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { openProject } from '@/workspaces/activation/openProject';
import {
  acquireWorkspaceSyncTestScmRuntime,
  createStartedProductionDaemonWorkspaceSyncRuntime as createProductionDaemonWorkspaceSyncRuntime,
  createWorkspaceSyncNativeProcessTestBoundary,
} from './createProductionDaemonWorkspaceSyncRuntime.testkit';

async function setupManagedSessionFixture(serverId: string) {
  const directory = await mkdtemp(join(tmpdir(), 'managed-session-seed-'));
  const sourceRootPath = join(directory, 'host-source');
  const targetRootPath = join(directory, 'guest', 'workspace');
  const home = join(directory, 'guest-home');
  await Promise.all([mkdir(sourceRootPath, { recursive: true }), mkdir(dirname(targetRootPath), { recursive: true }), mkdir(home, { recursive: true })]);
  const binaryPayload = Buffer.from([0, 1, 2, 255, 128, 0, 42, 10]);
  await writeFile(join(sourceRootPath, 'README.md'), 'pf10-source-sentinel\n');
  await writeFile(join(sourceRootPath, 'data.bin'), binaryPayload);
  await writeFile(join(sourceRootPath, '.gitignore'), 'ignored.secret\n');
  runScmExecutable(sourceRootPath, 'git', ['init', '-q']);
  runScmExecutable(sourceRootPath, 'git', ['add', 'README.md', 'data.bin', '.gitignore']);
  runScmExecutable(sourceRootPath, 'git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'base']);
  await writeFile(join(sourceRootPath, 'ignored.secret'), 'must-not-copy\n');

  const scmRuntime = await acquireWorkspaceSyncTestScmRuntime();
  const holderPath = resolveSessionHolderExecutablePath();
  const helperPath = resolveProcessCustodySupportExecutable('linux');
  expect(holderPath).toBeTruthy();
  expect(helperPath).toBeTruthy();

  const serverUrl = `https://${serverId}.invalid`;
  await seedTestServerProfile({ id: serverId, homeId: serverId, serverUrl });
  const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url'), 'signature'].join('.');
  const credentials = { token, encryption: null };
  const rows: unknown[] = [];
  const http = createProjectAccountRowsHttpBoundary(rows);
  const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
    return { status: 200, data: String(url).endsWith('/currentness')
      ? { mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }
      : { mode: 'plain', updatedAt: 0 } };
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(http);

  const boundary = createWorkspaceSyncNativeProcessTestBoundary();
  const channels: Duplex[] = [];
  const workers: Promise<void>[] = [];
  const capturedNetworks: Parameters<typeof startPrivateProjectSyncChannel>[0]['network'][] = [];
  const remoteSourceCalls = vi.fn(async () => {
    throw Object.assign(new Error('Original Project SOURCE envelope is unavailable'), { code: 'peer_unavailable' });
  });
  const seedExportCalls = vi.fn(async () => {
    throw Object.assign(new Error('Workspace seed authority is unavailable'), { code: 'peer_unavailable' });
  });

  const runtime = await runWithServerHttpBaseUrl(serverUrl, async () => {
    await readProjectAccountRows({ credentials, serverId, publication: 'installed' });
    return createProductionDaemonWorkspaceSyncRuntime({
      happyHomeDir: configuration.happyHomeDir,
      activeServerDir: join(directory, 'server'),
      activeServerId: serverId,
      localMachineId: 'host',
      releaseChannel: 'publicdev',
      credentials,
      isCurrent: async () => true,
      callWorkspaceProjectSource: remoteSourceCalls,
      callWorkspaceSeedExport: seedExportCalls,
      openManagedWorkspaceTarget: async request => ({
        id: 'managed:sandbox',
        holderPath: holderPath!,
        helperPath: helperPath!,
        home,
        platform: { os: 'linux', arch: 'x64', home },
        exec: async () => { throw new Error('No guest shell effects are needed'); },
        putFile: async () => { throw new Error('Sync uses the native transfer sink'); },
        ensureWorkspaceRuntime: async () => ({ binaryPath: '/guest/happier' }),
        openChannel: (argv, signal) => {
          if (argv[0] === holderPath) {
            const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
            const channel = Duplex.from({ readable: child.stdout, writable: child.stdin });
            const stop = () => { child.kill(); };
            signal.addEventListener('abort', stop, { once: true });
            child.once('error', error => channel.destroy(error));
            workers.push(new Promise<void>(resolve => child.once('close', () => {
              signal.removeEventListener('abort', stop);
              channel.destroy();
              resolve();
            })));
            channel.once('close', stop);
            channels.push(channel);
            return channel;
          }
          if (argv[0] === 'sh') {
            const input = new PassThrough();
            const output = new PassThrough();
            const channel = Duplex.from({ readable: output, writable: input });
            channels.push(channel);
            const worker = runWorkspaceEffectWorker([], { input, output, signal, currentDirectory: () => dirname(targetRootPath) })
              .finally(() => { output.end(); });
            workers.push(worker);
            void worker.catch(error => channel.destroy(error));
            return channel;
          }
          const channel = new PassThrough({ autoDestroy: false });
          channels.push(channel);
          signal.addEventListener('abort', () => channel.destroy(), { once: true });
          return channel;
        },
      }),
    }, {
      ...boundary.factories,
      resolveRootOwnershipDirectory: () => join(directory, 'locks'),
      launchLocalAgent: async () => {
        const stream = new PassThrough({ autoDestroy: false });
        return { stream, stop: async () => { stream.destroy(); } };
      },
      startManagedSyncChannel: async input => {
        capturedNetworks.push(input.network);
        return startPrivateProjectSyncChannel({
          ...input,
          configuration: { ...input.configuration, agent: { executablePath: '/fixture-agent' } },
        });
      },
    });
  });

  onTestFinished(async () => {
    await runtime.stop();
    await Promise.all(workers);
    post.mockRestore();
    get.mockRestore();
    withdrawActiveProjectAccountRowsSnapshot();
    await scmRuntime.release();
    await rm(directory, { recursive: true, force: true });
  });

  const buildSessionSpawnContext = (requestId: string, withSessionProjectOpenRows = true): RpcHandlerContext => {
    const spawnInput = SessionSpawnNewInputV2Schema.parse({
      executionTarget: { serverId, machineId: 'host' },
      directory: { kind: 'path', path: sourceRootPath },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      sessionPlacement: {
        kind: 'machine',
        target: { serverId, machineId: 'host' },
        projectFilesSource: { target: { serverId, machineId: 'host' }, directory: sourceRootPath },
        projectFiles: { kind: 'copy_once' },
      },
    });
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({
      v: 1, requestId, target: { kind: 'machine', machineId: 'host' }, input: spawnInput,
    });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: 'admitted-session-spawn-root',
      binding: {
        accountId: 'owner',
        custodianAccountId: 'owner',
        authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain',
        serverIdentityId: serverId,
        machineId: 'host',
        installationId: 'installation',
        actionId: 'session.spawn_new',
        requestId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        target: envelope.target,
      },
    });
    return {
      signal: new AbortController().signal,
      callerAuthority: 'present_user',
      originalActionEnvelope: envelope,
      callerInputAuthorization: authorization,
      verifyMachineAdmissionCurrent: async () => true,
      machineAdmission: {
        actorAccountId: 'owner',
        custodianAccountId: 'owner',
        machineId: 'host',
        installationId: 'installation',
        role: 'manage',
        encryptionMode: 'plain',
      },
      ...(withSessionProjectOpenRows ? {
        sessionProjectOpenRows: {
          credentials,
          serverId,
          sessionCustody: { serverId, accountId: 'owner', serverHttpBaseUrl: serverUrl, isCurrent: async () => true },
        },
      } : {}),
    };
  };

  const openThroughProjectOpenRaw = (context: RpcHandlerContext) => async (projectRequest: Parameters<typeof openProject>[0]) =>
    openProject(projectRequest, {
      serverId,
      serverHttpBaseUrl: serverUrl,
      machineId: 'host',
      accountId: 'owner',
      readCredentials: async () => credentials,
      workspaceSyncAdapter: runtime.handoffAdapter,
      materializeManagedProjectTarget: runtime.materializeManagedProjectTarget,
    }, context);

  const openThroughProjectOpen = (context: RpcHandlerContext) => async (projectRequest: Parameters<typeof openProject>[0]) => {
    const result = await openThroughProjectOpenRaw(context)(projectRequest);
    if (result.kind !== 'opened') {
      throw Object.assign(new Error(`openProject returned ${result.kind}: ${JSON.stringify(result)}`), {
        code: result.kind === 'refused' ? result.code : 'indeterminate',
        ...(result.kind === 'refused' && result.failureCause ? { failureCause: result.failureCause } : {}),
        ...(result.kind === 'refused' && result.effectAttempted !== undefined ? { effectAttempted: result.effectAttempted } : {}),
      });
    }
    return result;
  };

  return {
    directory, sourceRootPath, targetRootPath, serverId, serverUrl, credentials, binaryPayload,
    runtime, remoteSourceCalls, seedExportCalls, capturedNetworks,
    buildSessionSpawnContext, openThroughProjectOpen, openThroughProjectOpenRaw,
  };
}

describe('same-Machine managed Session project files through reviewed session.spawn_new projects.open child (PF10)', () => {
  it.each([
    { label: 'contentOnly policy', contentOnly: true as const },
    { label: 'default Fresh Devcontainer policy', contentOnly: false as const },
  ])('seeds a managed target via copy_once ($label) without routing back through remote callWorkspaceSyncProjectSource', async ({ contentOnly }) => {
    const f = await setupManagedSessionFixture(contentOnly ? 'srv_pf10_copy_once_co' : 'srv_pf10_copy_once_def');
    const basePolicy = createDefaultWorkspaceContentPolicyV1();
    const contentPolicy = contentOnly
      ? { ...basePolicy, contentOnly: true as const, policyDigest: computeWorkspaceSyncPolicyDigest({ ...basePolicy, contentOnly: true as const }) }
      : basePolicy;
    const requestId = `spawn-copy-once-${contentOnly ? 'co' : 'def'}-1`;
    const ctx = f.buildSessionSpawnContext(requestId);

    const seeded = await runWithServerHttpBaseUrl(f.serverUrl, () => f.runtime.prepareManagedProjectFilesSeed({
      sourceRootPath: f.sourceRootPath,
      targetRootPath: f.targetRootPath,
      targetManaged: { managedId: 'sandbox', controller: { machineId: 'host', installationId: 'installation' } },
      requesterAccountId: 'owner',
      credentials: f.credentials,
      contentPolicy,
      actionContext: { actionRequestId: requestId },
      openProject: f.openThroughProjectOpen(ctx),
    }));

    expect(f.remoteSourceCalls).not.toHaveBeenCalled();
    expect(f.seedExportCalls).not.toHaveBeenCalled();
    expect(seeded.targetWorkspace).toMatchObject({ v: 2, kind: 'managed', managedId: 'sandbox', rootPath: f.targetRootPath });
    expect(seeded.baseline?.entries.map(entry => entry.relativePath)).toEqual(expect.arrayContaining(['README.md', 'data.bin']));
    expect(await readFile(join(f.targetRootPath, 'README.md'), 'utf8')).toBe('pf10-source-sentinel\n');
    expect(await readFile(join(f.targetRootPath, 'data.bin'))).toEqual(f.binaryPayload);
    await expect(readFile(join(f.targetRootPath, 'ignored.secret'), 'utf8')).rejects.toThrow();
    expect(f.runtime.handoffAdapter.listPrivateExecutions?.() ?? []).toEqual([]);
  });

  it('seeds an empty managed target via create_relationship through the reviewed session.spawn_new projects.open child', async () => {
    const f = await setupManagedSessionFixture('srv_pf10_create_rel');
    const requestId = 'spawn-create-rel-req-1';
    const ctx = f.buildSessionSpawnContext(requestId);
    const contentPolicy = createDefaultWorkspaceContentPolicyV1();

    // Pre-seed the source workspace ref (matching a session_project_files_source attach)
    const initial = await runWithServerHttpBaseUrl(f.serverUrl, () => f.runtime.prepareManagedProjectFilesSeed({
      sourceRootPath: f.sourceRootPath,
      targetRootPath: join(f.directory, 'guest', 'probe-seed'),
      targetManaged: { managedId: 'probe', controller: { machineId: 'host', installationId: 'installation' } },
      requesterAccountId: 'owner',
      credentials: f.credentials,
      contentPolicy: { ...contentPolicy, contentOnly: true, policyDigest: computeWorkspaceSyncPolicyDigest({ ...contentPolicy, contentOnly: true }) },
      actionContext: { actionRequestId: 'probe-seed-req' },
      openProject: f.openThroughProjectOpen(f.buildSessionSpawnContext('probe-seed-req')),
    }));
    expect(initial.targetWorkspace.kind).toBe('managed');

    const snapshot = await runWithServerHttpBaseUrl(f.serverUrl, () => readProjectAccountRows({
      credentials: f.credentials,
      serverId: f.serverId,
      selection: { kinds: ['workspace-ref', 'relationship-graph'] },
    }));
    const sourceRef = snapshot.workspaceRefs.find(ref => !isManagedWorkspaceRefV2(ref) && ref.rootPath === f.sourceRootPath)!;
    expect(sourceRef).toBeDefined();

    const synced = await runWithServerHttpBaseUrl(f.serverUrl, () => f.runtime.prepareManagedProjectFilesSync({
      sourceRootPath: f.sourceRootPath,
      targetRootPath: f.targetRootPath,
      sourceWorkspace: { serverId: f.serverId, workspaceId: sourceRef.id, machineId: 'host', rootPath: f.sourceRootPath },
      mode: 'keep_both_in_sync',
      targetManaged: { managedId: 'sandbox', controller: { machineId: 'host', installationId: 'installation' } },
      requesterAccountId: 'owner',
      credentials: f.credentials,
      contentPolicy,
      actionContext: { actionRequestId: requestId },
      openProject: f.openThroughProjectOpen(ctx),
    }));

    expect(f.remoteSourceCalls).not.toHaveBeenCalled();
    expect(f.seedExportCalls).not.toHaveBeenCalled();
    expect(synced.targetWorkspace).toMatchObject({ v: 2, kind: 'managed', managedId: 'sandbox', rootPath: f.targetRootPath });
    expect(await readFile(join(f.targetRootPath, 'README.md'), 'utf8')).toBe('pf10-source-sentinel\n');
    expect(await readFile(join(f.targetRootPath, 'data.bin'))).toEqual(f.binaryPayload);
    const after = await runWithServerHttpBaseUrl(f.serverUrl, () => readProjectAccountRows({
      credentials: f.credentials,
      serverId: f.serverId,
      selection: { kinds: ['workspace-ref', 'relationship-graph'] },
    }));
    expect(after.relationships).toContainEqual(expect.objectContaining({ relationshipId: synced.relationshipId, mode: 'keep_both_in_sync', enabled: true }));
  });

  it('fails closed to callWorkspaceProjectSource when sessionProjectOpenRows is absent (unverified context)', async () => {
    const f = await setupManagedSessionFixture('srv_pf10_fail_closed');
    const requestId = 'spawn-unverified-req-1';
    const ctxWithoutSessionRows = f.buildSessionSpawnContext(requestId, false);

    await expect(runWithServerHttpBaseUrl(f.serverUrl, () => f.runtime.prepareManagedProjectFilesSeed({
      sourceRootPath: f.sourceRootPath,
      targetRootPath: f.targetRootPath,
      targetManaged: { managedId: 'sandbox', controller: { machineId: 'host', installationId: 'installation' } },
      requesterAccountId: 'owner',
      credentials: f.credentials,
      actionContext: { actionRequestId: requestId },
      openProject: f.openThroughProjectOpen(ctxWithoutSessionRows),
    }))).rejects.toMatchObject({ code: 'peer_unavailable' });
    expect(f.remoteSourceCalls).toHaveBeenCalledTimes(1);
  });

  it('classifies post-effect local copy_once failures as outcomeUnknown without withdrawing the published target', async () => {
    const f = await setupManagedSessionFixture('srv_pf10_post_effect');
    const requestId = 'spawn-post-effect-req-1';
    const ctx = f.buildSessionSpawnContext(requestId);
    const observedResults: Awaited<ReturnType<typeof openProject>>[] = [];
    const commitSpy = vi.spyOn(f.runtime.handoffAdapter, 'commit').mockRejectedValueOnce(new Error('commit interrupted'));
    onTestFinished(() => { commitSpy.mockRestore(); });

    await expect(runWithServerHttpBaseUrl(f.serverUrl, () => f.runtime.prepareManagedProjectFilesSeed({
      sourceRootPath: f.sourceRootPath,
      targetRootPath: f.targetRootPath,
      targetManaged: { managedId: 'sandbox', controller: { machineId: 'host', installationId: 'installation' } },
      requesterAccountId: 'owner',
      credentials: f.credentials,
      actionContext: { actionRequestId: requestId },
      openProject: async req => {
        const result = await f.openThroughProjectOpenRaw(ctx)(req);
        observedResults.push(result);
        return result;
      },
    }))).rejects.toMatchObject({ code: 'indeterminate' });

    expect(observedResults).toEqual([{ kind: 'outcomeUnknown' }]);
    const after = await runWithServerHttpBaseUrl(f.serverUrl, () => readProjectAccountRows({
      credentials: f.credentials,
      serverId: f.serverId,
      selection: { kinds: ['workspace-ref'] },
    }));
    expect(after.workspaceRefs.some(ref => isManagedWorkspaceRefV2(ref) && ref.rootPath === f.targetRootPath)).toBe(true);
  });

  it('enforces per-execution binding and cancellation on local managed prepareSourceSeed', async () => {
    const f = await setupManagedSessionFixture('srv_pf10_seed_binding');
    const requestId = 'spawn-seed-binding-req-1';
    const ctx = f.buildSessionSpawnContext(requestId);
    const contentPolicy = createDefaultWorkspaceContentPolicyV1();

    await runWithServerHttpBaseUrl(f.serverUrl, () => f.runtime.prepareManagedProjectFilesSeed({
      sourceRootPath: f.sourceRootPath,
      targetRootPath: f.targetRootPath,
      targetManaged: { managedId: 'sandbox', controller: { machineId: 'host', installationId: 'installation' } },
      requesterAccountId: 'owner',
      credentials: f.credentials,
      contentPolicy,
      actionContext: { actionRequestId: requestId },
      openProject: f.openThroughProjectOpen(ctx),
    }));

    expect(f.capturedNetworks.length).toBeGreaterThanOrEqual(1);
    const network = f.capturedNetworks[0]!;
    const snapshot = await runWithServerHttpBaseUrl(f.serverUrl, () => readProjectAccountRows({
      credentials: f.credentials,
      serverId: f.serverId,
      selection: { kinds: ['workspace-ref'] },
    }));
    const sourceRef = snapshot.workspaceRefs.find(ref => !isManagedWorkspaceRefV2(ref) && ref.rootPath === f.sourceRootPath)!;

    await expect(network.prepareSourceSeed({
      operationId: requestId,
      sourceMachineId: 'host',
      sourceWorkspaceRefId: 'mismatched-source-ref',
      contentPolicy,
    })).rejects.toMatchObject({ code: 'target_unavailable' });

    await expect(network.prepareSourceSeed({
      operationId: 'mismatched-operation-id',
      sourceMachineId: 'host',
      sourceWorkspaceRefId: sourceRef.id,
      contentPolicy,
    })).rejects.toMatchObject({ code: 'target_unavailable' });

    const aborted = new AbortController();
    aborted.abort(new DOMException('cancelled', 'AbortError'));
    await expect(network.prepareSourceSeed({
      operationId: requestId,
      sourceMachineId: 'host',
      sourceWorkspaceRefId: sourceRef.id,
      contentPolicy,
      signal: aborted.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
