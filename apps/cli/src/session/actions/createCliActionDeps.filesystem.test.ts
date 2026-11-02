import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { createCliActionDeps } from './createCliActionDeps';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { executeFilesystemMutationAction } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { FILESYSTEM_MUTATION_ACTION_IDS } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import * as persistence from '@/persistence';
import * as serverProfiles from '@/server/serverProfiles';
import { configuration } from '@/configuration';
import { ApiMachineClient } from '@/api/apiMachine';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { accountSettingsParse, API_TOKEN_FULL_GRANT_V1, decodePlainArtifactStoredContent, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import * as childProcess from 'node:child_process';
import { PassThrough } from 'node:stream';
import { basename, dirname } from 'node:path';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { EventEmitter } from 'node:events';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createSocketIoManagerStub } from '@/testkit/backends/apiSessionSocketHarness';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import * as irohNative from '@happier-dev/iroh-native/node';
import tweetnacl from 'tweetnacl';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { DirectRouteGrantRequestV2Schema, DirectRouteGrantPayloadV2Schema, createDirectRouteGrantSigningInputV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { createPreparedFilesystemTransferActionExecutor, projectPreparedFilesystemActionResult } from '@/machines/transfer/createPreparedFilesystemTransferActionExecutor';
import { createPreparedFilesystemTransferClient } from '@/machines/transfer/preparedFilesystemTransferClient';
import { createActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const copySocketBoundary = vi.hoisted(() => ({ create: vi.fn() }));
const nativeProcessBoundary = vi.hoisted(() => ({
  spawn: vi.fn<(command: string, args?: readonly string[], options?: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess | undefined>(),
}));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => nativeProcessBoundary.spawn(...args) ?? actual.spawn(...args) };
});
vi.mock('socket.io-client', async importOriginal => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return { ...actual, io: (...args: Parameters<typeof actual.io>) => copySocketBoundary.create(...args) ?? actual.io(...args) };
});

function bindCurrentFilesystemOwner(client: ApiMachineClient, executor: ReturnType<typeof createActionExecutor>): void {
  client.setRPCHandlers({
    // Unused process-lifecycle boundaries; filesystem execution remains real.
    spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'Unavailable' } as const),
    stopSession: async () => true, requestShutdown: () => {},
  }, { externalActionIngressOwner: { currentServerId: 'home', executor,
    resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-test' }) } });
}

function createReviewedFilesystemExecutor(
  params: Parameters<typeof createCliActionDeps>[0],
  overrides?: Parameters<typeof createCliActionExecutorHarness>[1],
) {
  return createCliActionExecutorHarness({ ...params,
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
        'daemon.filesystem.createDirectory': ['rpc'], 'daemon.filesystem.rename': ['rpc'],
        'daemon.filesystem.delete': ['rpc'], 'daemon.filesystem.copy': ['rpc'],
      } },
    }) }),
  }, overrides).executor;
}

describe('exact-machine filesystem Actions', () => {
  it('carries the Agent Session Machine through approval replay to the real filesystem owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-agent-filesystem-owner-'));
    const rootPath = join(directory, '.dev', 'worktree', 'accepted');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const ownerSettings = createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
      v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.writeFile': ['rpc'] },
    } }) });
    const owner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.test', pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: ownerSettings,
      filesystemActionExecute: client.createFilesystemActionExecutor('home') });
    bindCurrentFilesystemOwner(client, owner);
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-test', localMachineId: 'machine-test', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine-test', resolveCustodianAccountId: async () => 'daemon-owner',
        resolveInstallationId: () => 'installation', verifyMachineAdmission: async () => true,
      }) });
    const registration = registerFileSystemHandlers(manager, directory, { mutationMachineId: 'machine-test',
      actionExecutor: { execute: (actionId, input, context) => owner.execute(actionId, input, {
        ...context, serverId: 'home', externalActionTarget: { kind: 'machine', machineId: 'machine-test' },
      }) } });
    const approval: { request: ApprovalRequest | null } = { request: null };
    let invokes = 0;
    const callerSettings = createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
      v: 1, actions: { 'daemon.filesystem.writeFile': { approvalRequiredSurfaces: ['agent'] } },
    } }) });
    const caller = createActionExecutor({ ...createCliActionDeps({ token, sessionId: 'session-test', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.test', actionsSettingsProvider: callerSettings,
      machineActionDirectTargetTransport: { machineId: 'machine-test', invoke: (method, params) => {
        invokes += 1;
        return manager.handleRequest({ method: `machine-test:${method}`, params,
          callerAuthority: 'account_automation', machineAdmission: { actorAccountId: 'daemon-owner',
            custodianAccountId: 'daemon-owner', machineId: 'machine-test', installationId: 'installation',
            role: 'use', encryptionMode: 'plain' } });
      } },
    }),
    approvalsCreate: async ({ request: value }) => { approval.request = value; return { artifactId: 'filesystem-approval' }; },
    approvalsGet: async () => approval.request,
    approvalsUpdate: async ({ request: value }) => { approval.request = value; return { ok: true as const }; },
    isApprovalExecutionOriginCurrent: async () => true,
    });
    const bridge = (machineId?: string) => createActionToolExecutorBridge({ surface: 'agent',
      ...(machineId ? { defaultSessionMachineId: machineId } : {}), actionsSettings: callerSettings.getActionsSettings(),
      executor: { execute: (actionId, input, context) => caller.execute(actionId, input, {
        ...context, serverId: 'home', runtimeAccountId: 'daemon-owner', actionCaller: { kind: 'host' },
      }) } });
    try {
      const sourcePath = join(directory, 'source');
      await mkdir(sourcePath);
      childProcess.execFileSync('git', ['init', sourcePath], { stdio: 'ignore' });
      childProcess.execFileSync('git', ['-C', sourcePath, '-c', 'user.name=Filesystem test', '-c', 'user.email=filesystem@example.test',
        'commit', '--allow-empty', '-m', 'Initial'], { stdio: 'ignore' });
      childProcess.execFileSync('git', ['-C', sourcePath, 'worktree', 'add', '--detach', rootPath], { stdio: 'ignore' });
      await writeFile(join(rootPath, 'README'), 'agent-readable');

      expect(await bridge('machine-test').executeActionByToolName('action_execute', {
        actionId: 'daemon.filesystem.readFile', input: { rootPath, path: 'README' },
      }, 'session-test', { actionRequestId: 'agent-read' })).toEqual({ ok: true, result: {
        success: true, content: Buffer.from('agent-readable').toString('base64'),
      } });
      expect(await bridge('machine-test').executeActionByToolName('action_execute', {
        actionId: 'daemon.filesystem.writeFile', input: { rootPath, path: 'approved', content: Buffer.from('approved').toString('base64') },
      }, 'session-test', { actionRequestId: 'agent-write' })).toMatchObject({ ok: true, result: {
        kind: 'approval_request_created', artifactId: 'filesystem-approval',
      } });
      await expect(stat(join(rootPath, 'approved'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (!approval.request) throw new Error('Missing filesystem approval');
      approval.request = { ...approval.request, status: 'approved', updatedAtMs: approval.request.updatedAtMs + 1,
        decision: { kind: 'approve', decidedAtMs: approval.request.updatedAtMs + 1 } };
      registerApprovalRpcHandlers({ rpcHandlerManager: manager, actionExecutor: caller });
      expect(await manager.handleRequest({
        method: `machine-test:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`,
        params: { artifactId: 'filesystem-approval' }, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'daemon-owner', custodianAccountId: 'daemon-owner',
          machineId: 'machine-test', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      })).toMatchObject({ ok: true, result: { status: 'executed' } });
      expect(await readFile(join(rootPath, 'approved'), 'utf8')).toBe('approved');

      const beforeMiswire = invokes;
      expect(await bridge().executeActionByToolName('action_execute', {
        actionId: 'daemon.filesystem.readFile', input: { rootPath, path: 'README' },
      }, 'session-test', { actionRequestId: 'agent-miswire' })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
      expect(invokes).toBe(beforeMiswire);
    } finally {
      await registration.dispose(); await client.shutdown(); await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads an admitted worktree and refuses outside paths through CLI deps and the full Machine filesystem owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-rooted-action-owner-'));
    const rootPath = join(directory, '.dev', 'worktree', 'accepted');
    const bytes = Buffer.from([0, 255, 128, 10]);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const settings = createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
      v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.writeFile': ['rpc'],
        'daemon.filesystem.createDirectory': ['rpc'], 'daemon.filesystem.rename': ['rpc'], 'daemon.filesystem.delete': ['rpc'] },
    } }) });
    const owner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.test', pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: settings,
      filesystemActionExecute: client.createFilesystemActionExecutor('home') });
    bindCurrentFilesystemOwner(client, owner);
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-test', localMachineId: 'machine-test', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine-test', resolveCustodianAccountId: async () => 'daemon-owner',
        resolveInstallationId: () => 'installation', verifyMachineAdmission: async () => true,
      }) });
    const registration = registerFileSystemHandlers(manager, directory, { mutationMachineId: 'machine-test',
      actionExecutor: { execute: (actionId, input, context) => owner.execute(actionId, input, {
        ...context, serverId: 'home', externalActionTarget: { kind: 'machine', machineId: 'machine-test' },
      }) } });
    const caller = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://home.test', pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: settings,
      machineActionDirectTargetTransport: { machineId: 'machine-test',
        // Only the cross-process transport/Home admission lookup is substituted.
        invoke: (method, params) => manager.handleRequest({ method: `machine-test:${method}`, params,
          callerAuthority: 'account_automation', machineAdmission: { actorAccountId: 'daemon-owner',
            custodianAccountId: 'daemon-owner', machineId: 'machine-test', installationId: 'installation',
            role: 'use', encryptionMode: 'plain' } }) } });
    const context = { surface: 'rpc' as const, serverId: 'home', runtimeAccountId: 'daemon-owner', authority: 'account_automation' as const,
      externalActionTarget: { kind: 'machine' as const, machineId: 'machine-test' } };
    try {
      const sourcePath = join(directory, 'source');
      await mkdir(sourcePath);
      childProcess.execFileSync('git', ['init', sourcePath], { stdio: 'ignore' });
      childProcess.execFileSync('git', ['-C', sourcePath, '-c', 'user.name=Filesystem test', '-c', 'user.email=filesystem@example.test',
        'commit', '--allow-empty', '-m', 'Initial'], { stdio: 'ignore' });
      childProcess.execFileSync('git', ['-C', sourcePath, 'worktree', 'add', '--detach', rootPath], { stdio: 'ignore' });
      await writeFile(join(rootPath, 'README'), bytes);
      await writeFile(join(directory, 'outside'), 'private outside bytes');
      for (const path of ['README', join(rootPath, 'README')]) {
        expect(await caller.execute('daemon.filesystem.readFile', { rootPath, path }, context))
          .toEqual({ ok: true, result: { success: true, content: bytes.toString('base64') } });
      }
      expect(await caller.execute('daemon.filesystem.readFile', { rootPath, path: join(directory, 'outside') }, context))
        .toMatchObject({ ok: true, result: { success: false, error: expect.any(String) } });
      expect(await caller.execute('daemon.filesystem.listDirectory', { rootPath, path: '.' }, context))
        .toMatchObject({ ok: true, result: { success: true, entries: expect.arrayContaining([expect.objectContaining({ name: 'README', type: 'file' })]) } });
      expect(await caller.execute('daemon.filesystem.getDirectoryTree', { rootPath, path: '.', maxDepth: 1 }, context))
        .toMatchObject({ ok: true, result: { success: true, tree: { children: expect.arrayContaining([expect.objectContaining({ name: 'README' })]) } } });
      expect(await caller.execute('daemon.filesystem.writeFile', { rootPath, path: 'binary', content: bytes.toString('base64') }, context))
        .toMatchObject({ ok: true, result: { success: true, hash: createHash('sha256').update(bytes).digest('hex') } });
      expect(await readFile(join(rootPath, 'binary'))).toEqual(bytes);
      expect(await caller.execute('daemon.filesystem.createDirectory', { rootPath, path: 'folder' }, context))
        .toEqual({ ok: true, result: { success: true } });
      expect(await caller.execute('daemon.filesystem.rename', { rootPath, from: 'binary', to: 'folder/moved', overwrite: false }, context))
        .toEqual({ ok: true, result: { success: true } });
      expect(await readFile(join(rootPath, 'folder/moved'))).toEqual(bytes);
      expect(await caller.execute('daemon.filesystem.delete', { rootPath, path: 'folder', recursive: true }, context))
        .toEqual({ ok: true, result: { success: true } });
      await expect(stat(join(rootPath, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const actionId of ['daemon.filesystem.listDirectory', 'daemon.filesystem.getDirectoryTree'] as const) {
        expect(await caller.execute(actionId, { rootPath, path: directory,
          ...(actionId === 'daemon.filesystem.getDirectoryTree' ? { maxDepth: 1 } : {}) }, context))
          .toMatchObject({ ok: true, result: { success: false, error: expect.any(String) } });
      }
      expect(await caller.execute('daemon.filesystem.writeFile', { rootPath, path: join(directory, 'outside'),
        content: bytes.toString('base64') }, context)).toMatchObject({ ok: true, result: { success: false, error: expect.any(String) } });
      expect(await readFile(join(directory, 'outside'), 'utf8')).toBe('private outside bytes');
    } finally { await registration.dispose(); await client.shutdown(); await rm(directory, { recursive: true, force: true }); }
  });
  it('projects a real prepared upload through the ApiMachine factory and full Action terminal output boundary', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-upload-full-owner-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-one' })).toString('base64url')}.signature`;
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
    const client = new ApiMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined, { directPeerServerLifecycle: lifecycle });
    const owner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null, serverId: 'home',
      serverHttpBaseUrl: 'http://localhost:1', pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
        v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.upload': ['rpc'] },
      } }) }), filesystemActionExecute: client.createFilesystemActionExecutor('home') });
    bindCurrentFilesystemOwner(client, owner);
    const scope = { accountId: 'account-one', machineId: 'machine-test' };
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'full-upload', resolveAction: actionId => {
      const spec = getActionSpec(ActionIdSchema.parse(actionId));
      return { actionId, title: spec.title, operation: spec.operation };
    } });
    const bytes = Buffer.from([0, 255, 128, 10]);
    try {
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const transfer = createPreparedFilesystemTransferClient({
        openMachineTunnel: async () => ({ localPort: await lifecycle.ensureListening(), observedPath: 'direct', close: async () => {} }),
        executeAction: async (actionId, input, context) => runner.observe({ actionId, input, scope,
          execute: operation => owner.execute(actionId, input, { ...context, ...operation, surface: 'rpc', runtimeAccountId: scope.accountId }) }),
      });
      expect(await transfer.upload({ targetMachineId: scope.machineId, serverId: 'home', rootPath, path: 'destination.bin',
        sourcePath: join(rootPath, 'source.bin'), source: { sourceId: 'full-source', sizeBytes: bytes.length }, overwrite: false }))
        .toMatchObject({ success: true, status: 'completed' });
      expect(await readFile(join(rootPath, 'destination.bin'))).toEqual(bytes);
      const observation = await createActionOperationRpcHandlers({ store, runner, machineId: scope.machineId,
        resolveAccountId: async () => scope.accountId }).get({ operationId: 'full-upload', waitForTerminal: true });
      expect(observation).toMatchObject({ operation: { state: 'succeeded' } });
    } finally { await client.shutdown(); await lifecycle.stop(); await rm(rootPath, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== 'linux')('retains actual local-copy recovery custody and the runner uncertain observation when native commit loses its terminal result', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-copy-unknown-owner-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const child = new childProcess.ChildProcess();
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    child.stdin = stdin; child.stdout = stdout; child.stderr = stderr; child.kill = () => true;
    let writes = 0;
    stdin.on('data', () => {
      if (++writes === 1) stdout.write('{"v":1,"t":"workspace-confined-prepared"}\n');
      else { stdout.end(); stderr.end(); queueMicrotask(() => child.emit('close', 1, null)); }
    });
    // Replace only the native apply process; real admission, source capture,
    // complete manifest/blob staging, the factory and runner remain in use.
    nativeProcessBoundary.spawn.mockImplementation((_command, args) =>
      args?.[0] === 'workspace-confined-apply' ? child : undefined);
    const owner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'http://localhost:1', pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.copy': ['rpc'] } },
      }) }), filesystemActionExecute: client.createFilesystemActionExecutor('home'),
    });
    bindCurrentFilesystemOwner(client, owner);
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'native-copy-unknown',
      resolveAction: actionId => ({ actionId, title: 'Copy', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const scope = { accountId: 'daemon-owner', machineId: 'machine-test' };
    let retainedCustody: string | undefined;
    try {
      const bytes = Buffer.from([0, 255, 128]);
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const result = await runner.observe({ actionId: 'daemon.filesystem.copy', scope,
        input: { rootPath, from: 'source.bin', to: 'copy.bin', overwrite: false, recursive: false },
        execute: context => owner.execute('daemon.filesystem.copy', {
          rootPath, from: 'source.bin', to: 'copy.bin', overwrite: false, recursive: false,
        }, { ...context, surface: 'rpc', serverId: 'home', runtimeAccountId: scope.accountId,
          externalActionTarget: { kind: 'machine', machineId: scope.machineId } }),
      });
      if (!result.ok) retainedCustody = /private recovery custody is retained at (.+)$/u.exec(result.error)?.[1];
      expect(result).toMatchObject({ ok: false, errorCode: 'indeterminate' });
      expect(store.get(scope, 'native-copy-unknown')).toMatchObject({ observation: { kind: 'outcome_uncertain', code: 'indeterminate' } });
      expect(store.get(scope, 'native-copy-unknown')).not.toHaveProperty('settledAt');
      expect(retainedCustody).toBeDefined();
      if (retainedCustody) await expect(readFile(join(retainedCustody, 'stage', 'entry'))).resolves.toEqual(bytes);
      await expect(stat(join(rootPath, 'copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(rootPath, 'source.bin'))).toEqual(bytes);
    } finally {
      nativeProcessBoundary.spawn.mockReset(); await client.shutdown();
      if (retainedCustody && dirname(retainedCustody) === tmpdir() && basename(retainedCustody).startsWith('filesystem-copy-')) {
        await rm(retainedCustody, { recursive: true, force: true });
      }
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux').each(['cancel', 'retire'] as const)('refuses local copy after staging and before native commit when the admitted host invocation becomes %s', async mode => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-copy-cancel-owner-'));
    const client = new ApiMachineClient('owner-token', { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const controller = new AbortController();
    const child = new childProcess.ChildProcess();
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
    child.stdin = stdin; child.stdout = stdout; child.stderr = stderr; child.kill = () => true;
    let prepared = false;
    let retirement: Promise<void> | undefined;
    stdin.on('data', () => {
      if (!prepared) {
        prepared = true;
        if (mode === 'cancel') {
          controller.abort();
          stdout.write('{"v":1,"t":"workspace-confined-prepared"}\n');
        } else {
          // Hold the real native admission boundary until the containing
          // host's canonical shutdown has actually retired its owner.
          retirement = client.shutdown();
          void retirement.then(() => stdout.write('{"v":1,"t":"workspace-confined-prepared"}\n'),
            error => child.emit('error', error));
        }
      }
      else { stdout.end(); stderr.end(); queueMicrotask(() => child.emit('close', 1, null)); }
    });
    nativeProcessBoundary.spawn.mockImplementation((_command, args) =>
      args?.[0] === 'workspace-confined-apply' ? child : undefined);
    bindCurrentFilesystemOwner(client, createActionExecutor(createCliActionDeps({ token: 'owner-token', sessionId: '', mode: 'plain', ctx: null })));
    try {
      await writeFile(join(rootPath, 'source.bin'), Buffer.from([0, 255, 128]));
      await writeFile(join(rootPath, 'destination.bin'), 'incumbent');
      const result = await client.createFilesystemActionExecutor('home')({ actionId: 'daemon.filesystem.copy',
        input: { rootPath, from: 'source.bin', to: 'destination.bin', overwrite: true, recursive: false },
        context: { serverId: 'home', signal: controller.signal, runtimeAccountId: 'owner',
          externalActionTarget: { kind: 'machine', machineId: 'machine-test' } },
      });
      if (retirement) await retirement;
      expect(result, JSON.stringify(result)).toMatchObject({ success: false, errorCode: mode === 'cancel' ? 'cancelled' : 'filesystem_action_owner_unavailable' });
      expect(prepared).toBe(true);
      expect(await readFile(join(rootPath, 'destination.bin'), 'utf8')).toBe('incumbent');
    } finally { nativeProcessBoundary.spawn.mockReset(); await (retirement ?? client.shutdown()); await rm(rootPath, { recursive: true, force: true }); }
  });

  it('does not substitute the host transport for an external requester whose signed Machine admission is unavailable', async () => {
    let sent = false;
    const deps = createCliActionDeps({ token: 'host-account', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async () => {
        sent = true;
        return { success: true };
      } },
    });
    await expect(deps.filesystemActionExecute!({ actionId: 'daemon.filesystem.delete',
      input: { rootPath: '/selected/workspace', path: 'entry', recursive: false },
      context: { surface: 'api', authority: 'account_automation',
        externalActionTarget: { kind: 'machine', machineId: 'machine' },
        externalActionCredential: { accountId: 'external-requester', principalId: 'principal',
          credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 },
      },
    })).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(sent).toBe(false);
  });

  it('keeps a foreign requester closed at the full factory while admitted owner-local effects retain their Account identity', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-requester-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const requesterAccounts: Array<string | undefined> = [];
    const requesterCredentials: unknown[] = [];
    const localEffects = client.createFilesystemActionExecutor('home');
    const fullOwner = createCliActionExecutor({ token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'http://localhost:1', pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.copy': ['rpc', 'cli'] } },
      }) }),
      filesystemActionExecute: async request => {
        requesterAccounts.push(request.context.runtimeAccountId);
        requesterCredentials.push(request.context.externalActionCredential);
        return await localEffects(request);
      },
    });
    bindCurrentFilesystemOwner(client, fullOwner);
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-test', localMachineId: 'machine-test', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine-test', resolveCustodianAccountId: async () => 'daemon-owner',
        resolveInstallationId: () => 'installation',
        // The Home's current Machine-admission lookup is the network boundary.
        verifyMachineAdmission: async () => true,
      }),
    });
    const registration = registerFileSystemHandlers(manager, rootPath, { actionExecutor: fullOwner, mutationMachineId: 'machine-test' });
    try {
      const bytes = Buffer.from([0, 255, 128]);
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const admittedRequest = { method: 'machine-test:daemon.filesystem.copy',
        params: { rootPath, from: 'source.bin', to: 'copy.bin', overwrite: false, recursive: false },
        callerAuthority: 'account_automation', machineAdmission: { actorAccountId: 'verified-requester',
          custodianAccountId: 'daemon-owner', machineId: 'machine-test', installationId: 'installation',
          role: 'use', encryptionMode: 'plain' },
      } satisfies Parameters<typeof manager.handleRequest>[0];
      expect(await manager.handleRequest({ ...admittedRequest, params: {
        ...admittedRequest.params, to: 'spoof-copy.bin', surface: 'rpc', runtimeAccountId: 'daemon-owner',
      } })).toMatchObject({ success: false, errorCode: 'invalid_input' });
      await expect(stat(join(rootPath, 'spoof-copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await manager.handleRequest(admittedRequest)).toMatchObject({
        ok: false, errorCode: 'filesystem_requester_account_authority_unavailable',
      });
      expect(requesterAccounts).toEqual([]);
      await expect(stat(join(rootPath, 'copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await manager.handleRequest({ ...admittedRequest,
        machineAdmission: { ...admittedRequest.machineAdmission, actorAccountId: 'daemon-owner' },
      })).toEqual({ success: true });
      expect(requesterAccounts).toEqual(['daemon-owner']);
      expect(requesterCredentials).toEqual([undefined]);
      expect(await readFile(join(rootPath, 'copy.bin'))).toEqual(bytes);
      expect(await readFile(join(rootPath, 'source.bin'))).toEqual(bytes);
      expect(await fullOwner.execute('daemon.filesystem.copy', {
        rootPath, from: 'source.bin', to: 'terminal-copy.bin', overwrite: false, recursive: false,
      }, { surface: 'cli', runtimeAccountId: 'not-the-terminal-owner',
        externalActionTarget: { kind: 'machine', machineId: 'machine-test' },
      })).toEqual({ ok: true, result: { success: true } });
      expect(requesterAccounts).toEqual(['daemon-owner', 'daemon-owner']);
      expect(await readFile(join(rootPath, 'terminal-copy.bin'))).toEqual(bytes);
    } finally {
      await registration.dispose();
      await client.shutdown();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('does not borrow the daemon Account waiver or approval store for an admitted foreign requester without its Account authority', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-foreign-policy-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'daemon-owner' })).toString('base64url')}.signature`;
    const client = new ApiMachineClient(token, { id: 'machine-test', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const fullOwner = createCliActionExecutor({ token, credentials: { token, encryption: null },
      sessionId: '', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'http://localhost:1',
      pluginActionExecutionOwner: 'current_process', filesystemActionExecute: client.createFilesystemActionExecutor('home'),
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey: resolveAccountSettingsScopeKeyForToken(token),
        accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {},
          approvalWaivedSurfaces: { 'daemon.filesystem.copy': ['rpc', 'api'] } } }),
      }),
    });
    bindCurrentFilesystemOwner(client, fullOwner);
    const manager = new RpcHandlerManager({ scopePrefix: 'machine-test', localMachineId: 'machine-test', encryptionMode: 'plain',
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine-test', resolveCustodianAccountId: async () => 'daemon-owner', resolveInstallationId: () => 'installation',
        // Only the current Home admission lookup is a replaced network boundary.
        verifyMachineAdmission: async () => true,
      }),
    });
    const registration = registerFileSystemHandlers(manager, rootPath, { actionExecutor: fullOwner, mutationMachineId: 'machine-test' });
    const reads = vi.spyOn(axios, 'get');
    const writes = vi.spyOn(axios, 'post');
    try {
      const bytes = Buffer.from([0, 255, 128]);
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const result = await manager.handleRequest({ method: 'machine-test:daemon.filesystem.copy',
        params: { rootPath, from: 'source.bin', to: 'foreign-copy.bin', overwrite: false, recursive: false },
        callerAuthority: 'account_automation', machineAdmission: { actorAccountId: 'verified-requester',
          custodianAccountId: 'daemon-owner', machineId: 'machine-test', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      });
      expect(result).toMatchObject({ ok: false });
      expect(await fullOwner.prepare('daemon.filesystem.copy', {
        rootPath, from: 'source.bin', to: 'foreign-copy.bin', overwrite: false, recursive: false,
      }, { surface: 'rpc', runtimeAccountId: 'verified-requester', authority: 'account_automation',
        externalActionTarget: { kind: 'machine', machineId: 'machine-test' },
      })).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'filesystem_requester_account_authority_unavailable' } });
      const externalRequesterContext = { surface: 'api' as const, authority: 'account_automation' as const,
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine-test' },
        externalActionCredential: { accountId: 'verified-requester', principalId: 'principal',
          credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 },
      };
      const externalInput = { rootPath, from: 'source.bin', to: 'foreign-api-copy.bin', overwrite: false, recursive: false };
      expect(await fullOwner.prepare('daemon.filesystem.copy', externalInput, externalRequesterContext))
        .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'filesystem_requester_account_authority_unavailable' } });
      expect(await fullOwner.execute('daemon.filesystem.copy', externalInput, externalRequesterContext))
        .toMatchObject({ ok: false, errorCode: 'filesystem_requester_account_authority_unavailable' });
      await expect(stat(join(rootPath, 'foreign-copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(rootPath, 'foreign-api-copy.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(rootPath, 'source.bin'))).toEqual(bytes);
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore(); writes.mockRestore();
      await registration.dispose(); await client.shutdown(); await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('refuses generic MCP transfers without concrete byte custody before contacting the machine', async () => {
    // The credentialed public front door refuses absent custody before
    // approval/admission. The lower protocol executor does not own a driver.
    const requests = vi.spyOn(axios, 'request');
    const reads = vi.spyOn(axios, 'get');
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials: { token: 'admitted-caller', encryption: null },
        pluginActionExecutionOwner: 'current_process' });
      const input = { rootPath: '/workspace', path: 'file', destination: { destinationId: 'arbitrary' }, asZip: false };
      const context = { surface: 'mcp' as const, authority: 'account_automation' as const,
        externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
      expect(await executor.execute('daemon.filesystem.download', input, context))
        .toMatchObject({ ok: false, errorCode: 'filesystem_transfer_custody_required' });
      expect(await executor.prepare('daemon.filesystem.download', input, context))
        .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'filesystem_transfer_custody_required' } });
      expect(requests).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
    } finally {
      requests.mockRestore();
      reads.mockRestore();
    }
  });
  it('admits qualified MCP copy through canonical disabled-surface policy before any endpoint call', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-one' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const } satisfies persistence.StoredCredentials;
    const stored = vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
    const profiles = vi.spyOn(serverProfiles, 'getServerProfile').mockImplementation(async id => ({
      id, name: id, serverUrl: `https://${id}.example.test`, webappUrl: `https://${id}.example.test`, createdAt: 0, updatedAt: 0, lastUsedAt: 0,
    }));
    const requests = vi.spyOn(axios, 'request');
    const reads = vi.spyOn(axios, 'get');
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'destination', serverApiUrl: 'https://destination.example.test',
        serverIdentityId: 'destination-identity', machineId: 'destination-machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
          v: 1, actions: { 'daemon.filesystem.copy': { disabledSurfaces: ['mcp'] } },
        } }) }),
      });
      const input = { kind: 'target_copy', source: { serverId: 'source', machineId: 'source-machine', rootPath: '/source', path: 'binary' },
        destination: { serverId: 'destination', machineId: 'destination-machine', rootPath: '/destination', path: 'binary' }, overwrite: false, recursive: false };
      const context = { surface: 'mcp' as const, serverId: 'destination', externalActionTarget: { kind: 'machine' as const, machineId: 'destination-machine' } };
      expect(await executor.execute('daemon.filesystem.copy', input, context)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
      expect(await executor.prepare('daemon.filesystem.copy', input, context)).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
      expect(requests).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { stored.mockRestore(); profiles.mockRestore(); requests.mockRestore(); reads.mockRestore(); network.mockRestore(); }
  });

  it('does not borrow replaced exact Home credentials when a prepared concrete copy invocation resumes', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-one' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const } satisfies persistence.StoredCredentials;
    let sourceCredentials = credentials;
    const stored = vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockImplementation(async id => id === 'source' ? sourceCredentials : credentials);
    const profiles = vi.spyOn(serverProfiles, 'getServerProfile').mockImplementation(async id => ({
      id, name: id, serverUrl: `https://${id}.example.test`, webappUrl: `https://${id}.example.test`, createdAt: 0, updatedAt: 0, lastUsedAt: 0,
    }));
    const requests = vi.spyOn(axios, 'request'); const reads = vi.spyOn(axios, 'get'); const network = vi.spyOn(globalThis, 'fetch');
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'destination', serverApiUrl: 'https://destination.example.test',
        serverIdentityId: 'destination-identity', machineId: 'destination-machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
          v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.copy': ['mcp'] },
        } }) }),
      });
      const input = { kind: 'target_copy', source: { serverId: 'source', machineId: 'source-machine', rootPath: '/source', path: 'binary' },
        destination: { serverId: 'destination', machineId: 'destination-machine', rootPath: '/destination', path: 'binary' }, overwrite: false, recursive: false };
      const prepared = await executor.prepare('daemon.filesystem.copy', input, { surface: 'mcp', serverId: 'destination',
        externalActionTarget: { kind: 'machine', machineId: 'destination-machine' } });
      expect(prepared.kind).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('Copy admission did not produce a concrete invocation');
      sourceCredentials = { ...credentials, token: `header.${Buffer.from(JSON.stringify({ sub: 'account-two' })).toString('base64url')}.signature` };
      expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
      expect(requests).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { stored.mockRestore(); profiles.mockRestore(); requests.mockRestore(); reads.mockRestore(); network.mockRestore(); }
  });

  it('refuses PAT address-only copy without an admitted mounted operation before source or destination effects', async () => {
    const credentials = { token: 'api-token', encryption: null, credentialProvenance: 'api_token' as const } satisfies persistence.StoredCredentials;
    const requests = vi.spyOn(axios, 'request'); const reads = vi.spyOn(axios, 'get'); const network = vi.spyOn(globalThis, 'fetch');
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, pluginActionExecutionOwner: 'current_process' });
      const input = { kind: 'target_copy', source: { serverId: 'source', machineId: 'source-machine', rootPath: '/source', path: 'binary' },
        destination: { serverId: 'destination', machineId: 'destination-machine', rootPath: '/destination', path: 'binary' }, overwrite: false, recursive: false };
      expect(await executor.execute('daemon.filesystem.copy', input, { surface: 'mcp' })).toMatchObject({ ok: false, errorCode: 'filesystem_transfer_custody_required' });
      expect(await executor.prepare('daemon.filesystem.copy', input, { surface: 'agent' })).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'filesystem_transfer_custody_required' } });
      expect(requests).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { requests.mockRestore(); reads.mockRestore(); network.mockRestore(); }
  });
  it('holds concrete copy custody through a real blocking approval and refuses a replaced source Account before effects', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-one' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const } satisfies persistence.StoredCredentials;
    let sourceCredentials = credentials;
    const stored = vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockImplementation(async id => id === 'source' ? sourceCredentials : credentials);
    const profiles = vi.spyOn(serverProfiles, 'getServerProfile').mockImplementation(async id => ({
      id, name: id, serverUrl: `https://${id}.example.test`, webappUrl: `https://${id}.example.test`, createdAt: 0, updatedAt: 0, lastUsedAt: 0,
    }));
    let artifact: Readonly<Record<string, unknown>> | undefined;
    const paths: string[] = [];
    const eligibility = vi.spyOn(axios, 'request').mockImplementation(async config => {
      const parsed = new URL(String(config.url)); paths.push(parsed.pathname);
      expect(config.method).toBe('POST');
      expect(parsed.href).toBe('https://destination.example.test/v1/auth/api-tokens/list');
      expect(config.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      return { status: 200, data: { tokens: [] } };
    });
    const reads = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'account-one' } };
      if (artifact && path === `/v1/artifacts/${artifact.id}`) return { status: 200, data: artifact };
      throw new Error(`Unexpected admission HTTP read: ${path}`);
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, wire) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      const input = readCarrierMutation(wire);
      if (path === '/v1/artifacts') {
        artifact = { ...input, ownerAccountId: 'account-one', access: 'owner', encryptionMode: 'plain',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
      }
      if (artifact && path === `/v1/artifacts/${artifact.id}`) {
        const headerVersion = Number(artifact.headerVersion) + 1; const bodyVersion = Number(artifact.bodyVersion) + 1;
        artifact = { ...artifact, ...input, headerVersion, bodyVersion };
        return { status: 200, data: { success: true, headerVersion, bodyVersion } };
      }
      throw new Error(`Unexpected admission HTTP write: ${path}`);
    });
    const networkPaths: string[] = [];
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const parsed = new URL(String(url)); networkPaths.push(parsed.pathname);
      if (parsed.origin === 'https://destination.example.test' && parsed.pathname === '/v1/features') {
        return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_destination' } } });
      }
      throw new Error(`Unexpected copy network effect: ${parsed.pathname}`);
    });
    const socket = new EventEmitter();
    const networkSocket = Object.assign(socket, { io: createSocketIoManagerStub(), connected: false,
      connect: () => { networkSocket.connected = true; socket.emit('connect'); return networkSocket; },
      disconnect: () => { networkSocket.connected = false; return networkSocket; }, close: () => networkSocket });
    copySocketBoundary.create.mockReturnValue(networkSocket);
    const coordinator = getSharedBlockingApprovalCoordinator();
    const controller = new AbortController();
    let pending: Promise<unknown> | undefined;
    let settled: unknown;
    let artifactId: string | undefined;
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'destination', serverApiUrl: 'https://destination.example.test',
        serverIdentityId: 'srv_destination', machineId: 'destination-machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
          v: 1, actions: { 'daemon.filesystem.copy': { approvalRequiredSurfaces: ['mcp'] } },
        } }) }),
      });
      const input = { kind: 'target_copy', source: { serverId: 'source', machineId: 'source-machine', rootPath: '/source', path: 'binary' },
        destination: { serverId: 'destination', machineId: 'destination-machine', rootPath: '/destination', path: 'binary' }, overwrite: false, recursive: false };
      pending = executor.execute('daemon.filesystem.copy', input, { surface: 'mcp', actionRequestId: 'held-copy', signal: controller.signal, serverId: 'destination',
        externalActionTarget: { kind: 'machine', machineId: 'destination-machine' } }).then(result => { settled = result; return result; });
      await vi.waitFor(() => {
        expect(artifact, JSON.stringify(settled)).toBeDefined(); artifactId = String(artifact?.id);
        expect(coordinator.getLiveWaiterCount(artifactId)).toBe(1);
      });
      if (!artifact || !artifactId) throw new Error('Actual approval Artifact was not created');
      const content = decodePlainArtifactStoredContent(String(artifact.body));
      if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('Approval body is unavailable');
      const request = StoredApprovalRequestSchema.parse(JSON.parse(content.body));
      expect(request.actionId).toBe('daemon.filesystem.copy');
      expect(paths.every(path => path === '/v1/account/encryption' || path === '/v1/account/profile' || path === '/v1/auth/api-tokens/list' || path.startsWith('/v1/artifacts'))).toBe(true);
      sourceCredentials = { ...credentials, token: `header.${Buffer.from(JSON.stringify({ sub: 'account-two' })).toString('base64url')}.signature` };
      expect(await coordinator.resolveBlockingDecision({ artifactId, request, decision: 'approve', decisionAuthority: 'present_user' })).toEqual({ resolved: true });
      const result = await pending;
      expect(result, JSON.stringify({ result, paths, networkPaths,
        origin: request.v === 2 ? request.executionOriginV1 : null })).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
      expect(paths.every(path => path === '/v1/account/encryption' || path === '/v1/account/profile' || path === '/v1/auth/api-tokens/list' || path.startsWith('/v1/artifacts'))).toBe(true);
      expect(networkPaths.every(path => path === '/v1/features')).toBe(true);
    } finally {
      controller.abort(); if (artifactId) coordinator.cancelApproval(artifactId);
      await pending?.catch(() => undefined);
      copySocketBoundary.create.mockReset(); stored.mockRestore(); profiles.mockRestore(); eligibility.mockRestore(); reads.mockRestore(); writes.mockRestore(); network.mockRestore();
    }
  });
  it.each(['mcp', 'agent'] as const)('uses captured Account-JWT exact Home RPC without a per-Home daemon for admitted %s copy', async surface => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-one' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const } satisfies persistence.StoredCredentials;
    const stored = vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
    const profiles = vi.spyOn(serverProfiles, 'getServerProfile').mockImplementation(async id => ({
      id, name: id, serverUrl: `https://${id}.example.test`, webappUrl: `https://${id}.example.test`, createdAt: 0, updatedAt: 0, lastUsedAt: 0,
    }));
    const requests = vi.spyOn(axios, 'request');
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      expect(String(url)).toBe('https://source.example.test/v1/machines/source-machine');
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
      return { data: { machine: { id: 'source-machine', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        revokedAt: null, replacedByMachineId: null } } };
    });
    const socket = new EventEmitter();
    const io = createSocketIoManagerStub();
    const rpcRequests: unknown[] = [];
    const networkSocket = Object.assign(socket, { io, connected: false,
      connect: () => { networkSocket.connected = true; socket.emit('connect'); return networkSocket; },
      disconnect: () => { networkSocket.connected = false; return networkSocket; }, close: () => networkSocket,
      emitWithAck: async (_event: string, request: Readonly<{ method: string; params: unknown }>) => {
        expect(request.method).toBe('source-machine:daemon.filesystem.download');
        const opened = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.params, request.method);
        rpcRequests.push(opened.params);
        return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' },
          { ok: false, errorCode: 'filesystem_requester_account_authority_unavailable', error: 'Requester authority unavailable' }, opened.callId) };
      },
    });
    // Socket.IO is the actual network boundary; transport, codec, exact target
    // lookup, policy and the byte-client admission remain real.
    copySocketBoundary.create.mockReturnValue(networkSocket);
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'destination', serverApiUrl: 'https://destination.example.test',
        serverIdentityId: 'destination-identity', machineId: 'destination-machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
          v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.copy': [surface] },
        } }) }),
      });
      const input = { kind: 'target_copy', source: { serverId: 'source', machineId: 'source-machine', rootPath: '/source', path: 'binary' },
        destination: { serverId: 'destination', machineId: 'destination-machine', rootPath: '/destination', path: 'binary' }, overwrite: false, recursive: false };
      const result = await executor.execute('daemon.filesystem.copy', input, { surface, authority: 'account_automation', actionRequestId: 'copy-request',
        serverId: 'destination', externalActionTarget: { kind: 'machine', machineId: 'destination-machine' } });
      expect(result).toMatchObject({ ok: false });
      expect(rpcRequests).toEqual([{ v: 1, kind: 'targeted_action_rpc', target: { kind: 'machine', machineId: 'source-machine' },
        input: { rootPath: '/source', path: 'binary', asZip: false, format: 'entry_tree', destination: { destinationId: expect.any(String) } } }]);
      expect(copySocketBoundary.create.mock.calls[0]?.[0]).toBe('https://source.example.test');
      expect(copySocketBoundary.create.mock.calls[0]?.[1]).toMatchObject({ auth: { token: credentials.token, authorityCeiling: 'account_automation' } });
      expect(requests).not.toHaveBeenCalled();
    } finally { copySocketBoundary.create.mockReset(); stored.mockRestore(); profiles.mockRestore(); requests.mockRestore(); reads.mockRestore(); }
  });
  it.each([
    { surface: 'mcp' as const, approval: false, prepare: true, portableHomeIds: true },
    { surface: 'agent' as const, approval: false, prepare: false, portableHomeIds: false },
    { surface: 'mcp' as const, approval: true, prepare: false, portableHomeIds: true },
  ])('captures each Home credential once for public $surface binary copy despite saved-file replacement (blocking approval=$approval, portable Home IDs=$portableHomeIds)', async ({ surface, approval, prepare, portableHomeIds }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-public-copy-'));
    const sourceCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'source-account' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const } satisfies persistence.StoredCredentials;
    const destinationCredentials = { ...sourceCredentials, token: `header.${Buffer.from(JSON.stringify({ sub: 'destination-account' })).toString('base64url')}.signature` };
    for (const [serverId, credentials] of [['source', sourceCredentials], ['destination', destinationCredentials]] as const) {
      await serverProfiles.adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: serverId, createIfMissing: true, observation: 'exact',
        descriptor: { v: 1, homeServerIdentityId: `srv_${serverId}`, canonicalServerUrl: `https://${serverId}.example.test`,
          revision: 1, endpoints: [{ kind: 'https', url: `https://${serverId}.example.test` }] } });
      await persistence.writeStoredCredentialsForServerId(serverId, credentials);
    }
    // Observe actual OS credential reads while keeping the profile, decoder,
    // transfer orchestration and receiving filesystem owners real.
    const credentialReads = vi.spyOn(fsPromises, 'readFile');
    const readHomes = () => credentialReads.mock.calls.flatMap(([path]) => {
      if (String(path) === join(configuration.serversDir, 'source', 'access.key')) return ['source'];
      if (String(path) === join(configuration.serversDir, 'destination', 'access.key')) return ['destination'];
      return [];
    });
    let credentialsReplaced = false;
    const replaceCredentials = async () => {
      if (credentialsReplaced) return;
      credentialsReplaced = true;
      for (const [serverId, credentials] of [['source', sourceCredentials], ['destination', destinationCredentials]] as const) {
        await persistence.writeStoredCredentialsForServerId(serverId, { ...credentials,
          token: `header.${Buffer.from(JSON.stringify({ sub: `${serverId}-replacement-account` })).toString('base64url')}.signature` });
      }
    };
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback port');
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const lifecycle = createDirectTransferServerLifecycle({ bindPort: address.port, listenerClasses: ['loopback_http'] });
    const effect = createPreparedFilesystemTransferActionExecutor({ lifecycle, workingDirectory: directory, accessPolicy: { kind: 'restrictedRoots', roots: [directory] } });
    const store = createActionOperationStore(); let sequence = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `public-copy-${++sequence}`,
      resolveAction: id => {
        const spec = getActionSpec(ActionIdSchema.parse(id));
        return { actionId: spec.id, title: spec.title, operation: spec.operation };
      } });
    const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const endpointId = 'b'.repeat(64);
    const home = (url: string) => new URL(url).hostname.split('.')[0];
    const account = (id: string) => id === 'source' ? 'source-account' : 'destination-account';
    const token = (id: string) => id === 'source' ? sourceCredentials.token : destinationCredentials.token;
    const methods: string[] = [];
    let artifact: Readonly<Record<string, unknown>> | undefined;
    const eligibility = vi.spyOn(axios, 'request').mockImplementation(async config => {
      expect(config.method).toBe('POST');
      expect(config.url).toBe('https://destination.example.test/v1/auth/api-tokens/list');
      expect(config.headers).toMatchObject({ Authorization: `Bearer ${destinationCredentials.token}` });
      return { status: 200, data: { tokens: [] } };
    });
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const parsed = new URL(String(url)); const id = home(parsed.href);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token(id)}` });
      if (parsed.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (artifact && parsed.pathname === `/v1/artifacts/${artifact.id}`) return { status: 200, data: artifact };
      // Approval publication first reads its deterministic id to join an
      // existing request; the HTTP owner returns 404 before its first create.
      if (!artifact && parsed.pathname.startsWith('/v1/artifacts/')) return { status: 404, data: { error: 'Artifact not found' } };
      if (parsed.pathname === '/v1/account/profile') return { status: 200, data: { id: account(id) } };
      if (parsed.pathname === '/v1/machines') return { status: 200, data: [{ id: `${id}-machine`, active: true, kind: 'persistent',
        revokedAt: null, replacedByMachineId: null, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId } } }] };
      expect(parsed.pathname).toBe(`/v1/machines/${id}-machine`);
      return { status: 200, data: { machine: { id: `${id}-machine`, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        revokedAt: null, replacedByMachineId: null } } };
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, value, options) => {
      const parsed = new URL(String(url)); const id = home(parsed.href);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token(id)}` });
      if (parsed.pathname === '/v1/artifacts') {
        const input = readCarrierMutation(value);
        artifact = { ...input, ownerAccountId: account(id), access: 'owner', encryptionMode: 'plain',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
      }
      if (artifact && parsed.pathname === `/v1/artifacts/${artifact.id}`) {
        const input = readCarrierMutation(value);
        const headerVersion = Number(artifact.headerVersion) + 1; const bodyVersion = Number(artifact.bodyVersion) + 1;
        artifact = { ...artifact, ...input, headerVersion, bodyVersion };
        return { status: 200, data: { success: true, headerVersion, bodyVersion } };
      }
      expect(parsed.pathname).toBe('/v1/machines/peer/mediation/route-grants');
      const { kind, ttlMs, ...binding } = DirectRouteGrantRequestV2Schema.parse(value);
      const now = Date.now();
      const payload = DirectRouteGrantPayloadV2Schema.parse({ ...binding, accountId: account(id), grantId: `${id}-grant`,
        iat: now, exp: now + ttlMs, aud: 'happier-daemon-route-grant', proofKind: kind });
      return { status: 200, data: { ok: true, grant: { payload, signature: { alg: 'Ed25519', keyId: 'home-key',
        valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), signingKey.secretKey)).toString('base64url') } } } };
    });
    const nativeFetch = globalThis.fetch;
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/features') return Response.json({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: `srv_${home(parsed.href)}` },
      } });
      if (parsed.pathname === '/v1/features/authenticated') {
        expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token(home(parsed.href))}` });
        return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: `srv_${home(parsed.href)}` }, machines: { peerMediation: { grantSigningKeys: [{ keyId: 'home-key',
          publicKey: Buffer.from(signingKey.publicKey).toString('base64url') }] } } } });
      }
      return await nativeFetch(url, init);
    });
    const unavailableNative = async (): Promise<never> => { throw new Error('Unexpected native transport operation'); };
    const native = {
      getAvailability: () => { throw new Error('Unexpected native availability read'); },
      startHomeAcceptor: unavailableNative, stopHomeAcceptor: unavailableNative, ensureHomeTunnel: unavailableNative,
      releaseHomeTunnel: unavailableNative, getTunnelStatus: unavailableNative,
      startMachineAcceptor: unavailableNative, stopMachineAcceptor: unavailableNative, getMachineAcceptorStatus: unavailableNative,
      startMachineHttpTunnel: unavailableNative, getMachineTunnelStatus: unavailableNative,
      createEndpoint: vi.fn(async (request: unknown) => { expect(request).not.toHaveProperty('keyPath'); return {
        endpointHandle: 'client', endpointId: 'a'.repeat(64), relayPolicy: 'automatic', relayMode: 'disabled', capProfile: 'machineBulk', relayUrls: [],
      } as const; }),
      getEndpointStatus: async () => ({ endpointHandle: 'client', endpointId: 'a'.repeat(64), active: true, relayUrls: [], directAddresses: [], capProfile: 'machineBulk', relayPolicy: 'automatic', relayMode: 'disabled' } as const),
      startMachineTunnel: async () => ({ machineTunnelId: `tunnel-${sequence}`, endpointHandle: 'client', localPort: await lifecycle.ensureListening(),
        connectionActive: true, remoteEndpointId: endpointId, observedPath: 'direct', startedAtMs: Date.now(), lastErrorCode: null } as const),
      stopMachineTunnel: vi.fn(async () => {}), shutdownEndpoint: vi.fn(async () => {}),
    } satisfies Extract<ReturnType<typeof irohNative.loadIrohNodeNative>, { available: true }>['native'];
    // Only the native SDK boundary is substituted; signed grant/proof checks,
    // finite runtime custody, HTTP encryption and both prepared records are real.
    const nativeBoundary = vi.spyOn(irohNative, 'loadIrohNodeNative').mockReturnValue({ available: true, native, addonPath: '/test/iroh.node' });
    copySocketBoundary.create.mockImplementation((url: string, options: Readonly<{ auth: Readonly<{ token: string }> }>) => {
      const id = home(url); expect(options.auth.token).toBe(token(id));
      const socket = new EventEmitter();
      const connected = Object.assign(socket, { io: createSocketIoManagerStub(), connected: false,
        connect: () => { connected.connected = true; socket.emit('connect'); return connected; },
        disconnect: () => { connected.connected = false; return connected; }, close: () => connected,
        emitWithAck: async (_event: string, request: Readonly<{ method: string; params: unknown }>) => {
          const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.params, request.method);
          const admitted = TargetedActionRpcRequestV1Schema.parse(decoded.params);
          const actionId = id === 'source' ? 'daemon.filesystem.download' : 'daemon.filesystem.copy';
          expect(admitted.target).toEqual({ kind: 'machine', machineId: `${id}-machine` });
          expect(request.method).toBe(`${id}-machine:${getActionSpec(actionId).bindings?.rpcMethod}`); methods.push(actionId);
          if (!approval && !prepare) await replaceCredentials();
          const result = await runner.observe({ actionId, scope: { accountId: account(id), machineId: `${id}-machine` },
            execute: context => effect({ actionId, input: admitted.input, context: { ...context, runtimeAccountId: account(id), serverId: id,
              externalActionTarget: { kind: 'machine', machineId: `${id}-machine` } } }).then(projectPreparedFilesystemActionResult) });
          return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result.ok ? result.result : result, decoded.callId) };
        } });
      return connected;
    });
    const controller = new AbortController();
    const coordinator = getSharedBlockingApprovalCoordinator();
    let pending: Promise<unknown> | undefined;
    let settled: unknown;
    let artifactId: string | undefined;
    try {
      const bytes = Buffer.from([0, 255, 128, 10]); await writeFile(join(directory, 'source.bin'), bytes);
      const executor = createCliActionExecutorFromCredentials({ credentials: destinationCredentials,
        readCredentials: () => persistence.readStoredCredentialsForServerId('destination'), serverId: 'destination', serverApiUrl: 'https://destination.example.test',
        serverIdentityId: 'srv_destination', machineId: 'destination-machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ actionsSettingsV1: {
          v: 1, actions: approval ? { 'daemon.filesystem.copy': { approvalRequiredSurfaces: [surface] } } : {},
          ...(approval ? {} : { approvalWaivedSurfaces: { 'daemon.filesystem.copy': [surface] } }),
        } }) }) });
      const input = { kind: 'prepared_transfer', source: { kind: 'file', serverId: portableHomeIds ? 'srv_source' : 'source', machineId: 'source-machine', rootPath: directory, path: 'source.bin',
        sourceId: 'actual-file', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        destination: { serverId: portableHomeIds ? 'srv_destination' : 'destination', machineId: 'destination-machine', rootPath: directory, path: 'copied.bin' }, overwrite: false, recursive: false };
      const context = { surface, authority: 'account_automation' as const, serverId: portableHomeIds ? 'srv_destination' : 'destination',
        actionRequestId: 'public-binary-copy', signal: controller.signal,
        externalActionTarget: { kind: 'machine' as const, machineId: 'destination-machine' } };
      expect(await executor.execute('daemon.filesystem.copy', { ...input,
        destination: { ...input.destination, serverId: 'srv_foreign' } }, context))
        .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      expect(await executor.execute('daemon.filesystem.copy', input, { ...context, serverId: 'srv_foreign' }))
        .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      credentialReads.mockClear();
      if (prepare) {
        const prepared = await executor.prepare('daemon.filesystem.copy', input, context);
        expect(prepared.kind).toBe('ready');
        if (prepared.kind !== 'ready') throw new Error('Copy admission did not produce a concrete invocation');
        await replaceCredentials();
        pending = prepared.invocation.run();
      } else {
        pending = executor.execute('daemon.filesystem.copy', input, context).then(result => { settled = result; return result; });
      }
      if (approval) {
        await vi.waitFor(() => {
          expect(artifact, JSON.stringify(settled)).toBeDefined(); artifactId = String(artifact?.id);
          expect(coordinator.getLiveWaiterCount(artifactId)).toBe(1);
        });
        expect(methods).toEqual([]); expect(native.createEndpoint).not.toHaveBeenCalled();
        if (!artifact || !artifactId) throw new Error('Actual blocking copy Artifact is unavailable');
        const content = decodePlainArtifactStoredContent(String(artifact.body));
        if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') throw new Error('Approval body is unavailable');
        const request = StoredApprovalRequestSchema.parse(JSON.parse(content.body));
        await replaceCredentials();
        expect(await coordinator.resolveBlockingDecision({ artifactId, request, decision: 'approve', decisionAuthority: 'present_user' })).toEqual({ resolved: true });
      }
      const result = await pending;
      expect(readHomes().sort(), JSON.stringify(result)).toEqual(['destination', 'source']);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { success: true, status: 'completed' } });
      expect(await readFile(join(directory, 'copied.bin'))).toEqual(bytes);
      expect(credentialsReplaced).toBe(true);
      expect(methods).toEqual(['daemon.filesystem.download', 'daemon.filesystem.copy']);
      expect(native.shutdownEndpoint).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort(); if (artifactId) coordinator.cancelApproval(artifactId); await pending?.catch(() => undefined);
      copySocketBoundary.create.mockReset(); credentialReads.mockRestore(); eligibility.mockRestore(); reads.mockRestore(); writes.mockRestore(); network.mockRestore(); nativeBoundary.mockRestore();
      await lifecycle.stop(); await rm(directory, { recursive: true, force: true });
    }
  });
  it('fails closed on a predecessor method table without falling back to the unrooted alias', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-predecessor-'));
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    // The observed predecessor only has renamePath and does not consume rootPath.
    manager.registerHandler('renamePath', async ({ from, to }: { from: string; to: string }) => {
      await rename(join(rootPath, from), join(rootPath, to));
      return { success: true };
    });
    try {
      const bytes = Buffer.from([0, 255, 128]);
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const executor = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: (method, request, options) => manager.invokeLocal(method, request, options) },
      });
      expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.rename'), {
        rootPath, from: 'source.bin', to: 'moved.bin', overwrite: false,
      }, {
        surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'machine' },
      })).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
      expect(await readFile(join(rootPath, 'source.bin'))).toEqual(bytes);
      await expect(stat(join(rootPath, 'moved.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('reaches the registered daemon filesystem owner without redispatching the full executor', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-filesystem-deps-'));
    const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    const machineOwner = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null }, {
      filesystemActionExecute: request => {
        const actionId = FILESYSTEM_MUTATION_ACTION_IDS.find(id => id === request.actionId);
        if (!actionId) return Promise.resolve({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' });
        return executeFilesystemMutationAction({ actionId, input: request.input, workingDirectory: rootPath,
          accessPolicy: { kind: 'osUser' }, getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [] });
      },
    });
    const registration = registerFileSystemHandlers(manager, rootPath, { mutationMachineId: 'machine', actionExecutor: {
      execute: (actionId, input, context) => machineOwner.execute(actionId, input, {
        ...context, serverId: 'home', externalActionTarget: { kind: 'machine', machineId: 'machine' },
      }),
    } });
    try {
      const bytes = Buffer.from([0, 128, 255, 10]);
      await writeFile(join(rootPath, 'source.bin'), bytes);
      const executor = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: (method, request, options) =>
          manager.invokeLocal(method, request, options) },
      });
      expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.copy'), {
        rootPath, from: 'source.bin', to: 'copy.bin', overwrite: false, recursive: false,
      }, {
        surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'machine' },
      })).toEqual({ ok: true, result: { success: true } });
      expect(await readFile(join(rootPath, 'copy.bin'))).toEqual(bytes);
      expect(await readFile(join(rootPath, 'source.bin'))).toEqual(bytes);
    } finally {
      await registration.dispose();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.each([
    { success: false, error: 'Destination already exists' },
    { success: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND },
  ] as const)('preserves the declared root and domain failure through the admitted machine transport: %j', async result => {
    const calls: Array<Readonly<{ method: string; request: unknown }>> = [];
    const executor = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (method, request) => {
        calls.push({ method, request });
        return result;
      } },
    });
    const input = { rootPath: '/selected/workspace', from: 'source.bin', to: 'target.bin', overwrite: false };
    expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.rename'), input, {
      surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'machine' },
    })).toEqual({ ok: true, result });
    expect(calls).toEqual([{ method: 'daemon.filesystem.rename', request: input }]);
  });

  it('refuses to reuse an admitted transport for another machine', async () => {
    let sent = false;
    const executor = createReviewedFilesystemExecutor({ token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'admitted', invoke: async () => { sent = true; return { success: true }; } },
    });
    expect(await executor.execute(ActionIdSchema.parse('daemon.filesystem.createDirectory'), { rootPath: '/selected/workspace', path: 'new' }, {
      surface: 'rpc', authority: 'account_automation', externalActionTarget: { kind: 'machine', machineId: 'different' },
    })).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(sent).toBe(false);
  });
});
