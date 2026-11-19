import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openManagedNativeChannel } from '@happier-dev/cli-common/machines/managed/nativeChannel';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { registerManagedWorkspaceTarget, registerSessionTargetWorkspace, resolveSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createDirectoryRpcActionExecutor } from '@/rpc/handlers/fileSystem/directoryHandlers';
import { registerPathMutationHandlers } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { createReadFileRpcActionExecutor } from '@/rpc/handlers/fileSystem/readFileHandler';

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

  it.each(['daemon.filesystem.listDirectory', 'daemon.filesystem.getDirectoryTree', 'daemon.filesystem.readFile', RPC_METHODS.STAT_FILE] as const)(
    'F7: a stopped provider refusal reaches %s after one channel attempt', async actionId => {
      const lifetime = new AbortController();
      const roles: string[] = [];
      try {
        registerManagedWorkspaceTarget({ workspace: managedWorkspace, target: {
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
          .selectWorkspaceSource(undefined, input);
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
          registerManagedWorkspaceTarget({ workspace: address, target: {
            lifetime: lifetime.signal, holderPath: '/fixture/holder', helperPath: '/fixture/helper',
            openChannel: () => { throw new Error('No holder operation was requested'); },
          } });
          return resolveSessionTargetWorkspace({ workspace: address });
        },
      });
      expect(resolveSessionTargetWorkspace({ workspace })).toBeNull();
      const input = { workspace, rootPath: workspace.rootPath };
      const source = await admission.selectWorkspaceSource(undefined, input);
      expect(source.kind).toBe('target');
      expect(await admission.selectWorkspaceSource(undefined, input)).toBe(source);
      await expect(admission.selectWorkspaceSource({ authorization: { kind: 'session.write', sessionId: 'other' } }, input))
        .rejects.toMatchObject({ code: 'workspace_target_unavailable' });
      expect(restored).toEqual([workspace]);
    } finally { lifetime.abort(); }
  });
});
