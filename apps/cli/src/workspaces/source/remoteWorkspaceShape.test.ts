import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { openManagedNativeChannel } from '@happier-dev/cli-common/machines/managed/nativeChannel';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { registerManagedWorkspaceTarget, registerSessionTargetWorkspace, resolveSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createDirectoryRpcActionExecutor } from '@/rpc/handlers/fileSystem/directoryHandlers';
import { registerPathMutationHandlers } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { createReadFileRpcActionExecutor } from '@/rpc/handlers/fileSystem/readFileHandler';
import { registerMachineFileBrowserHandlers } from '@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';

import { readWorkspaceSourcePlacement, runWithWorkspaceSourceDemand } from './workspaceSource';

const managedWorkspace = {
  v: 2 as const,
  kind: 'managed' as const,
  workspaceId: 'project-workspace',
  serverId: 'home',
  managedId: 'coder-workspace',
  controller: { machineId: 'controller', installationId: 'controller-installation' },
  rootPath: '/home/coder/project',
};

describe('remote workspace shape contracts', () => {
  it('R1: admission retains the managed workspace address', () => {
    const placement = readWorkspaceSourcePlacement(undefined, {
      rootPath: managedWorkspace.rootPath,
      workspace: managedWorkspace,
    });

    expect(placement).toEqual({ rootPath: managedWorkspace.rootPath, workspace: managedWorkspace });
  });

  const holderPath = resolveSessionHolderExecutablePath();
  const helperPath = resolveProcessCustodySupportExecutable('linux');
  it.skipIf(process.platform !== 'linux' || !holderPath || !helperPath).each(['accepted', 'pre-save'] as const)(
    'F1: each %s folder chooser page opens one channel and one holder that exits on EOF', async selection => {
      const fixture = await mkdtemp(join(tmpdir(), 'guest-folder-chooser-'));
      const controllerRoot = join(fixture, 'controller');
      const rootPath = join(fixture, 'guest');
      const workspace = { ...managedWorkspace, workspaceId: 'chooser-test', rootPath };
      const lifetime = new AbortController();
      const channels: Duplex[] = [];
      const exits: Promise<{ code: number | null; signal: NodeJS.Signals | null }>[] = [];
      const liveHolders = new Set<number>();
      try {
        await mkdir(controllerRoot);
        await writeFile(join(controllerRoot, 'controller-only.txt'), 'controller');
        await mkdir(join(rootPath, 'repo', 'nested', 'leaf'), { recursive: true });
        const registration = { workspace, requesterAccountId: 'owner', target: {
          lifetime: lifetime.signal, holderPath: holderPath!, helperPath: helperPath!,
          openChannel: ([executable, ...args]: readonly string[]) => {
            const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'] });
            const holderIndex = exits.length;
            liveHolders.add(holderIndex);
            exits.push(new Promise((resolve, reject) => {
              child.once('error', reject);
              child.once('close', (code, signal) => {
                liveHolders.delete(holderIndex);
                resolve({ code, signal });
              });
            }));
            const channel = Duplex.from({ readable: child.stdout, writable: child.stdin });
            channels.push(channel);
            return channel;
          },
        } };
        if (selection === 'accepted') expect(registerManagedWorkspaceTarget(registration)).toBe(true);
        const admission = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => workspace.serverId,
          resolveWorkspaceTarget: resolveSessionTargetWorkspace });
        const handlers = new Map<string, RpcHandler>();
        registerMachineFileBrowserHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
          workingDirectory: controllerRoot, effectAdmission: admission,
          deps: { resolveRoots: async () => [{ id: rootPath, path: rootPath, label: 'Controller' }],
            openManagedProjectWorkspace: async request => {
              expect(request.requesterAccountId).toBe('owner');
              expect(request.workspace).toMatchObject({ serverId: workspace.serverId, controller: workspace.controller,
                managedId: workspace.managedId, rootPath });
              return { ...registration.target, lifetime: request.lifetime };
            },
          } });
        const list = handlers.get(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY)!;
        const context = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
          machineAdmission: { ...workspace.controller, actorAccountId: 'owner', custodianAccountId: 'owner',
            role: 'manage' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true };
        const browseInput = (directory: string, installationId = workspace.controller.installationId) => {
          const { workspaceId, ...locator } = workspace;
          const controller = { ...workspace.controller, installationId };
          return selection === 'pre-save' ? { path: { workspace: { ...locator, controller }, directory }, includeFiles: false }
            : { path: directory, workspace: { ...locator, controller, workspaceId }, includeFiles: false };
        };
        for (const [page, [directory, next]] of [['', 'repo'], ['repo', 'nested'], ['repo/nested', 'leaf']].entries()) {
          await expect(list(browseInput(join(rootPath, directory)), context)).resolves.toMatchObject({
            ok: true, entries: [{ name: next, type: 'directory' }],
          });
          expect(channels).toHaveLength(page + 1);
          expect(exits).toHaveLength(page + 1);
          expect(channels[page].writableEnded).toBe(true);
          await expect(exits[page]).resolves.toEqual({ code: 0, signal: null });
          expect(liveHolders.size).toBe(0);
        }
        if (selection === 'accepted') {
          await expect(list(browseInput(rootPath, 'replacement'), context)).rejects.toMatchObject({ code: 'workspace_target_unavailable' });
        } else {
          await expect(list(browseInput(rootPath, 'replacement'), context)).resolves.toMatchObject({ ok: false });
        }
        expect(channels).toHaveLength(3);
      } finally {
        lifetime.abort();
        await Promise.allSettled(exits);
        await rm(fixture, { recursive: true, force: true });
      }
    }, 30_000,
  );

  it.each(['daemon.filesystem.listDirectory', 'daemon.filesystem.getDirectoryTree', 'daemon.filesystem.readFile', RPC_METHODS.STAT_FILE] as const)(
    'F7: a stopped provider refusal reaches %s after one channel attempt', async actionId => {
      const lifetime = new AbortController();
      const roles: string[] = [];
      try {
        registerManagedWorkspaceTarget({ workspace: managedWorkspace, requesterAccountId: 'owner', target: {
          lifetime: lifetime.signal, holderPath: '/fixture/holder', helperPath: '/fixture/helper',
          openChannel: (argv, signal) => openManagedNativeChannel({ resource: {
            contributionRef: { pluginId: 'fixture.coder', localId: 'coder' }, schemaVersion: 1, value: { id: 'guest' },
          } }, async role => {
            roles.push(role);
            throw new PluginError({ code: 'managed_power_required' });
          }, { argv, signal }),
        } });
        const path = actionId === 'daemon.filesystem.readFile' || actionId === RPC_METHODS.STAT_FILE
          ? `${managedWorkspace.rootPath}/README.md` : managedWorkspace.rootPath;
        const input = { workspace: managedWorkspace, rootPath: managedWorkspace.rootPath, path,
          ...(actionId === 'daemon.filesystem.getDirectoryTree' ? { maxDepth: 2 } : {}) };
        const source = await createFilesystemEffectAdmission({ resolveWorkspaceTarget: resolveSessionTargetWorkspace })
          .selectWorkspaceSource({ machineAdmission: { ...managedWorkspace.controller, actorAccountId: 'owner',
            custodianAccountId: 'owner', role: 'manage', encryptionMode: 'plain' } }, input);
        const filesystem = {
          workingDirectory: '/controller', accessPolicy: { kind: 'osUser' as const },
          getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [],
        };
        const result = await runWithWorkspaceSourceDemand(source, async () => {
          if (actionId === RPC_METHODS.STAT_FILE) {
            const handlers = new Map<string, RpcHandler>();
            registerPathMutationHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, filesystem);
            return await handlers.get(RPC_METHODS.STAT_FILE)!({ workspace: managedWorkspace, file: { path } }, { signal: lifetime.signal });
          }
          const executor = actionId === 'daemon.filesystem.readFile' ? createReadFileRpcActionExecutor(filesystem)
            : createDirectoryRpcActionExecutor({ ...filesystem, limits: { listMaxEntries: 100, treeMaxDepth: 3, treeMaxNodes: 100 } });
          const execution = await executor.execute(actionId, input, { surface: 'rpc', authority: 'present_user' });
          return execution.ok ? execution.result : execution;
        });
        expect(result).toMatchObject({ success: false, errorCode: 'managed_power_required' });
        expect(roles).toEqual(['stream']);
      } finally { lifetime.abort(); }
    });

  it('R61-1: a managed request cannot read the controller folder after its Session target ends', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'retired-session-workspace-'));
    const sentinel = join(rootPath, 'controller-only');
    const lifetime = new AbortController();
    const sessionId = 'retired-target-session';
    try {
      await writeFile(sentinel, 'controller bytes');
      registerSessionTargetWorkspace({
        sessionId, lifetime: lifetime.signal, primarySocketPath: join(rootPath, 'holder.sock'),
        workspace: { hostRoot: rootPath, targetRoot: rootPath },
        target: {
          id: `managed:${managedWorkspace.managedId}`, lifetime: lifetime.signal,
          holderPath: '/fixture/holder', helperPath: '/fixture/helper', socketDirectory: rootPath,
          exec: () => { throw new Error('Unexpected guest exec'); },
          openChannel: () => { throw new Error('Unexpected guest channel'); },
        },
      });
      lifetime.abort();

      const admission = createFilesystemEffectAdmission({
        resolveWorkspaceTarget: resolveSessionTargetWorkspace,
        readRetainedSessionWorkspace: async (id: string) => {
          expect(id).toBe(sessionId);
          return { rootPath, requiresManagedTarget: true as const };
        },
      });
      const context = { authorization: { kind: 'session.write', sessionId } };
      const local = await admission.selectWorkspaceSource(undefined, { rootPath });
      await expect(local.readFile(sentinel)).resolves.toEqual(Buffer.from('controller bytes'));
      await expect(async () => {
        const source = await admission.selectWorkspaceSource(context, { rootPath });
        return await source.readFile(sentinel);
      }).rejects.toMatchObject({ code: 'workspace_target_unavailable' });
      await expect(async () => {
        const source = await admission.selectWorkspaceSource(context, { rootPath, workspace: { ...managedWorkspace, rootPath } });
        return await source.readFile(sentinel);
      }).rejects.toMatchObject({ code: 'workspace_target_unavailable' });
    } finally {
      lifetime.abort();
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('R3: the first exact Project demand restores its target without opening an idle channel', async () => {
    const workspace = { ...managedWorkspace, workspaceId: 'cold-project' };
    const lifetime = new AbortController();
    const restored: unknown[] = [];
    try {
      const admission = createFilesystemEffectAdmission({
        resolveWorkspaceTarget: resolveSessionTargetWorkspace,
        restoreManagedWorkspaceTarget: async address => {
          restored.push(address);
          registerManagedWorkspaceTarget({ workspace: address, requesterAccountId: 'owner', target: {
            lifetime: lifetime.signal, holderPath: '/fixture/holder', helperPath: '/fixture/helper',
            openChannel: () => { throw new Error('No holder operation was requested'); },
          } });
          return resolveSessionTargetWorkspace({ workspace: address, requesterAccountId: 'owner' });
        },
      });
      expect(resolveSessionTargetWorkspace({ workspace, requesterAccountId: 'owner' })).toBeNull();
      const input = { workspace, rootPath: workspace.rootPath };
      const owner = { machineAdmission: { ...workspace.controller, actorAccountId: 'owner', custodianAccountId: 'owner',
        role: 'manage', encryptionMode: 'plain' } } as const;
      const source = await admission.selectWorkspaceSource(owner, input);
      expect(source.kind).toBe('target');
      expect(await admission.selectWorkspaceSource(owner, input)).toBe(source);
      await expect(admission.selectWorkspaceSource({ authorization: { kind: 'session.write', sessionId: 'other' } }, input))
        .rejects.toMatchObject({ code: 'workspace_target_unavailable' });
      expect(restored).toEqual([workspace]);
    } finally { lifetime.abort(); }
  });

  it('refuses Files access to a warm managed Project from a different requester Account', async () => {
    const workspace = { ...managedWorkspace, workspaceId: 'warm-account-project' };
    const lifetime = new AbortController();
    try {
      const owner = { machineAdmission: { ...workspace.controller, actorAccountId: 'owner', custodianAccountId: 'owner',
        role: 'manage', encryptionMode: 'plain' } } as const;
      const foreign = { machineAdmission: { ...owner.machineAdmission, actorAccountId: 'other', role: 'use' } } as const;
      registerManagedWorkspaceTarget({ workspace, requesterAccountId: 'owner', target: {
        lifetime: lifetime.signal, holderPath: '/fixture/holder', helperPath: '/fixture/helper',
        openChannel: () => { throw new Error('No holder operation was requested'); },
      } });
      const admission = createFilesystemEffectAdmission({ resolveWorkspaceTarget: resolveSessionTargetWorkspace });
      await expect(admission.selectWorkspaceSource(owner, { workspace })).resolves.toMatchObject({ kind: 'target' });
      const denied = await admission.selectWorkspaceSource(foreign, { workspace })
        .then(source => ({ kind: source.kind }), (error: unknown) => error);
      expect(denied).toMatchObject({ code: 'workspace_target_unavailable' });
    } finally { lifetime.abort(); }
  });
});
