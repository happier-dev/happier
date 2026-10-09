import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { statSync } from 'node:fs';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerFileSystemHandlers } from './fileSystem';
import { executeFilesystemMutationAction, type FilesystemMutationDeps } from './fileSystem/pathMutationHandlers';
import { FILESYSTEM_MUTATION_ACTION_IDS } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { accountSettingsParse } from '@happier-dev/protocol';
import type { RpcActionExecutor } from './_actionDispatchAdapter';

type Handler = (data: any) => Promise<any>;

afterEach(() => {
  vi.doUnmock('fs/promises');
  vi.resetModules();
});

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

function createMutationExecutor(
  deps: FilesystemMutationDeps,
  options?: Readonly<{ requireApproval?: true; approvalsCreate?: Parameters<typeof createActionExecutor>[0]['approvalsCreate'] }>,
): RpcActionExecutor {
  const { executor } = createCliActionExecutorHarness({
    token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: options?.requireApproval ? {} : {
        'daemon.filesystem.createDirectory': ['rpc'], 'daemon.filesystem.rename': ['rpc'],
        'daemon.filesystem.delete': ['rpc'], 'daemon.filesystem.copy': ['rpc'],
      } },
    }) }),
  }, {
    filesystemActionExecute: request => {
      const actionId = FILESYSTEM_MUTATION_ACTION_IDS.find(id => id === request.actionId);
      if (!actionId) return Promise.resolve({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' });
      return executeFilesystemMutationAction({ ...deps, actionId, input: request.input });
    },
    ...(options?.approvalsCreate ? { approvalsCreate: options.approvalsCreate } : {}),
  });
  return {
    execute: (actionId, input, context) => executor.execute(actionId, input, {
      ...context, serverId: 'home', runtimeAccountId: 'account', actionRequestId: 'filesystem-request',
      externalActionTarget: { kind: 'machine', machineId: 'machine' },
    }),
  };
}

function mutationDeps(workingDirectory: string): FilesystemMutationDeps {
  return { workingDirectory, accessPolicy: { kind: 'osUser' },
    getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [] };
}

describe('filesystem path mutations', () => {
  it('replaces an overwritten directory entry and keeps that destination intact when the next staged copy is invalid', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-copy-replace-'));
    const bytes = Buffer.from([0, 255, 128, 10]);
    mkdirSync(join(workspace, 'source', '~'), { recursive: true });
    mkdirSync(join(workspace, 'source', 'deep'));
    mkdirSync(join(workspace, 'destination'));
    writeFileSync(join(workspace, 'source', 'binary'), bytes);
    writeFileSync(join(workspace, 'source', '~', 'binary'), bytes);
    for (const name of ['.git', 'node_modules', '.hidden']) {
      mkdirSync(join(workspace, 'source', name));
      writeFileSync(join(workspace, 'source', name, 'binary-child'), bytes);
    }
    writeFileSync(join(workspace, 'target.bin'), bytes);
    writeFileSync(join(workspace, 'destination', 'old-sentinel'), 'must not merge');
    symlinkSync('~/binary', join(workspace, 'source', 'literal-link'));
    symlinkSync('../../target.bin', join(workspace, 'source', 'deep', 'link'));
    try {
      const copy = (from: string) => executeFilesystemMutationAction({ ...mutationDeps(workspace),
        actionId: 'daemon.filesystem.copy', input: { rootPath: workspace,
          from, to: 'destination', overwrite: true, recursive: true },
      });
      await expect(copy('source')).resolves.toEqual({ success: true });
      expect(existsSync(join(workspace, 'destination', 'old-sentinel'))).toBe(false);
      expect(readFileSync(join(workspace, 'destination', 'binary'))).toEqual(bytes);
      for (const name of ['.git', 'node_modules', '.hidden']) {
        expect(readFileSync(join(workspace, 'destination', name, 'binary-child'))).toEqual(bytes);
      }
      expect(readlinkSync(join(workspace, 'destination', 'literal-link'))).toBe('~/binary');
      await expect(copy('source/deep')).resolves.toMatchObject({ success: false });
      expect(readFileSync(join(workspace, 'destination', 'binary'))).toEqual(bytes);
      expect(readFileSync(join(workspace, 'destination', 'literal-link'))).toEqual(bytes);
      expect(readFileSync(join(workspace, 'source', 'binary'))).toEqual(bytes);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it('preserves literal copied links and refuses links whose prospective target escapes the declared root', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-copy-links-'));
    const bytes = Buffer.from([0, 255, 128, 10]);
    mkdirSync(join(workspace, 'source', 'deep'), { recursive: true });
    mkdirSync(join(workspace, 'source', '~'));
    writeFileSync(join(workspace, 'source', '~', 'binary'), bytes);
    writeFileSync(join(workspace, 'target.bin'), bytes);
    symlinkSync('~/binary', join(workspace, 'source', 'literal-link'));
    symlinkSync('../../target.bin', join(workspace, 'source', 'deep', 'escaping-after-copy'));
    try {
      await expect(executeFilesystemMutationAction({ ...mutationDeps(workspace),
        actionId: 'daemon.filesystem.copy', input: { rootPath: workspace,
          from: 'source/deep/escaping-after-copy', to: 'copied-link', overwrite: false, recursive: false },
      })).resolves.toMatchObject({ success: false });
      expect(existsSync(join(workspace, 'copied-link'))).toBe(false);
      await expect(executeFilesystemMutationAction({ ...mutationDeps(workspace),
        actionId: 'daemon.filesystem.copy', input: { rootPath: workspace,
          from: 'source/literal-link', to: 'copied/literal-link', overwrite: false, recursive: false },
      })).resolves.toEqual({ success: true });
      expect(readlinkSync(join(workspace, 'copied', 'literal-link'))).toBe('~/binary');
      expect(readFileSync(join(workspace, 'source', 'literal-link'))).toEqual(bytes);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it('copies binary files into missing destination parents through the canonical local effect owner', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-copy-missing-parents-'));
    const bytes = Buffer.from([0, 255, 128, 10]);
    writeFileSync(join(workspace, 'source.bin'), bytes);
    try {
      await expect(executeFilesystemMutationAction({ ...mutationDeps(workspace),
        actionId: 'daemon.filesystem.copy', input: { rootPath: workspace, from: 'source.bin',
          to: 'missing/deep/copy.bin', overwrite: false, recursive: false },
      })).resolves.toEqual({ success: true });
      expect(readFileSync(join(workspace, 'missing', 'deep', 'copy.bin'))).toEqual(bytes);
      expect(readFileSync(join(workspace, 'source.bin'))).toEqual(bytes);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it('requires the current full owner for semantic RPCs and leaves effects untouched while canonical approval is pending', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-live-owner-'));
    const mgr = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    let owner: RpcActionExecutor | null = null;
    const requests: unknown[] = [];
    const registration = registerFileSystemHandlers(mgr, workspace, {
      mutationMachineId: 'machine', resolveMutationActionExecutor: () => owner,
    });
    const input = { rootPath: workspace, path: 'pending' };
    try {
      await expect(mgr.invokeLocal('daemon.filesystem.createDirectory', input)).resolves.toMatchObject({
        ok: false, errorCode: 'filesystem_action_owner_unavailable',
      });
      expect(existsSync(join(workspace, 'pending'))).toBe(false);
      owner = createMutationExecutor(mutationDeps(workspace), { requireApproval: true,
        // Approval Artifact persistence is the genuine external boundary.
        approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'approval' }; },
      });
      await expect(mgr.invokeLocal('daemon.filesystem.createDirectory', input)).resolves.toMatchObject({
        kind: 'approval_request_created', artifactId: 'approval', actionId: 'daemon.filesystem.createDirectory',
      });
      expect(requests).toEqual([expect.objectContaining({ actionArgs: input })]);
      expect(existsSync(join(workspace, 'pending'))).toBe(false);
      owner = null;
      await expect(mgr.invokeLocal('daemon.filesystem.createDirectory', input)).resolves.toMatchObject({
        ok: false, errorCode: 'filesystem_action_owner_unavailable',
      });
      await expect(mgr.invokeLocal(RPC_METHODS.CREATE_DIRECTORY, { path: 'legacy' })).resolves.toEqual({ success: true });
      expect(existsSync(join(workspace, 'pending'))).toBe(false);
      expect(existsSync(join(workspace, 'legacy'))).toBe(true);
    } finally {
      await registration.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('uses the supplied Action executor authority for every registered mutation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-action-dispatch-'));
    const executorRoot = mkdtempSync(join(tmpdir(), 'happier-files-executor-root-'));
    const mgr = createRpcHandlerManager();
    const registration = registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace, {
      actionExecutor: {
        async execute(actionId, input) {
          const mutationId = FILESYSTEM_MUTATION_ACTION_IDS.find((id) => id === actionId);
          if (!mutationId) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return {
            ok: true,
            result: await executeFilesystemMutationAction({
              actionId: mutationId, input, workingDirectory: executorRoot,
              accessPolicy: { kind: 'restrictedRoots', roots: [executorRoot] },
              getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [],
            }),
          };
        },
      },
    });
    try {
      writeFileSync(join(workspace, 'source'), 'retain');
      const requests = [
        ['daemon.filesystem.createDirectory', { rootPath: workspace, path: 'denied' }],
        ['daemon.filesystem.rename', { rootPath: workspace, from: 'source', to: 'renamed', overwrite: false }],
        ['daemon.filesystem.delete', { rootPath: workspace, path: 'source', recursive: false }],
        ['daemon.filesystem.copy', { rootPath: workspace, from: 'source', to: 'copy', overwrite: false, recursive: false }],
      ] as const;
      for (const [method, input] of requests) {
        const handler = mgr.handlers.get(method);
        if (!handler) throw new Error(`expected ${method} Action handler`);
        await expect(handler(input)).resolves.toMatchObject({ success: false, errorCode: 'access_denied' });
      }
      expect(readFileSync(join(workspace, 'source'), 'utf8')).toBe('retain');
      expect(existsSync(join(workspace, 'denied'))).toBe(false);
      expect(existsSync(join(workspace, 'renamed'))).toBe(false);
      expect(existsSync(join(workspace, 'copy'))).toBe(false);
    } finally {
      await registration.dispose();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(executorRoot, { recursive: true, force: true });
    }
  });

  it('dispatches registered mutation Actions to the real filesystem with strict captured roots', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-actions-'));
    const outside = mkdtempSync(join(tmpdir(), 'happier-files-outside-'));
    const mgr = createRpcHandlerManager();
    const registration = registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace, {
      actionExecutor: createMutationExecutor(mutationDeps(workspace)),
    });
    const invoke = async (method: string, input: unknown) => {
      const handler = mgr.handlers.get(method);
      if (!handler) throw new Error(`expected ${method} Action handler`);
      return await handler(input);
    };
    try {
      await expect(invoke('daemon.filesystem.createDirectory', { rootPath: workspace, path: 'nested' })).resolves.toEqual({ success: true });
      const bytes = Buffer.from([0, 255, 128, 10]);
      writeFileSync(join(workspace, 'source.bin'), bytes);
      writeFileSync(join(workspace, 'destination.bin'), 'retain');
      await expect(invoke('daemon.filesystem.rename', {
        rootPath: workspace, from: 'source.bin', to: 'destination.bin', overwrite: false,
      })).resolves.toMatchObject({ success: false });
      expect(readFileSync(join(workspace, 'destination.bin'), 'utf8')).toBe('retain');
      await expect(invoke('daemon.filesystem.copy', {
        rootPath: workspace, from: 'source.bin', to: 'nested/copy.bin', overwrite: false, recursive: false,
      })).resolves.toEqual({ success: true });
      expect(readFileSync(join(workspace, 'nested/copy.bin'))).toEqual(bytes);
      await expect(invoke('daemon.filesystem.delete', { rootPath: workspace, path: 'nested', recursive: false })).resolves.toMatchObject({ success: false });
      await expect(invoke('daemon.filesystem.delete', { rootPath: workspace, path: 'nested', recursive: true })).resolves.toEqual({ success: true });
      expect(existsSync(join(workspace, 'nested'))).toBe(false);
      await expect(invoke('daemon.filesystem.copy', {
        rootPath: workspace, from: 'source.bin', to: join(outside, 'leak.bin'), overwrite: false, recursive: false,
      })).resolves.toMatchObject({ success: false });
      await expect(invoke('daemon.filesystem.copy', {
        rootPath: workspace, from: '.', to: 'root-copy', overwrite: false, recursive: true,
      })).resolves.toMatchObject({ success: false });
      await expect(invoke('daemon.filesystem.delete', { rootPath: workspace, path: '.', recursive: true })).resolves.toMatchObject({ success: false });
      expect(existsSync(join(outside, 'leak.bin'))).toBe(false);
      await expect(invoke('daemon.filesystem.createDirectory', {
        rootPath: workspace, path: 'invalid', unauthorized: true,
      })).resolves.toMatchObject({ success: false });
      await expect(invoke('daemon.filesystem.rename', {
        rootPath: workspace, from: 'source.bin', to: 'missing-flag.bin',
      })).resolves.toMatchObject({ success: false });
      await expect(invoke('copyPath', {
        from: 'source.bin', to: 'missing-root.bin', overwrite: false, recursive: false,
      })).resolves.toMatchObject({ success: false, errorCode: 'invalid_input' });
      expect(existsSync(join(workspace, 'missing-root.bin'))).toBe(false);
      expect(existsSync(join(workspace, 'invalid'))).toBe(false);
      expect(existsSync(join(workspace, 'source.bin'))).toBe(true);
      const unrootedRequests = [
        ['daemon.filesystem.createDirectory', { path: 'implicit-root' }],
        ['daemon.filesystem.rename', { from: 'source.bin', to: 'implicit-root.bin', overwrite: false }],
        ['daemon.filesystem.delete', { path: 'source.bin', recursive: false }],
        ['daemon.filesystem.copy', { from: 'source.bin', to: 'implicit-copy.bin', overwrite: false, recursive: false }],
      ] as const;
      for (const [method, input] of unrootedRequests) {
        await expect(invoke(method, input)).resolves.toMatchObject({ success: false, errorCode: 'invalid_input' });
      }
      expect(existsSync(join(workspace, 'implicit-root'))).toBe(false);
      expect(existsSync(join(workspace, 'implicit-root.bin'))).toBe(false);
      expect(existsSync(join(workspace, 'implicit-copy.bin'))).toBe(false);
      expect(readFileSync(join(workspace, 'source.bin'))).toEqual(bytes);
      // Incumbent methods translate historical missing-root/choice fields only
      // at the alias seam, while keeping the same mutation owner.
      await expect(invoke(RPC_METHODS.CREATE_DIRECTORY, { path: 'legacy' })).resolves.toEqual({ success: true });
      await expect(invoke(RPC_METHODS.RENAME_PATH, { from: 'source.bin', to: 'legacy/source.bin' })).resolves.toEqual({ success: true });
      expect(readFileSync(join(workspace, 'legacy/source.bin'))).toEqual(bytes);
      await expect(invoke(RPC_METHODS.DELETE_PATH, { path: 'legacy/source.bin' })).resolves.toEqual({ success: true });
      expect(existsSync(join(workspace, 'legacy/source.bin'))).toBe(false);
    } finally {
      await registration.dispose();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not destroy an overwrite destination when the rename source is missing or contains it', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-rename-safe-'));
    const mgr = createRpcHandlerManager();
    const registration = registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);
    try {
      mkdirSync(join(workspace, 'parent'));
      writeFileSync(join(workspace, 'parent/source.bin'), 'retain');
      const rename = mgr.handlers.get(RPC_METHODS.RENAME_PATH);
      if (!rename) throw new Error('expected rename handler');
      await expect(rename({ from: 'missing', to: 'parent', overwrite: true })).resolves.toMatchObject({ success: false });
      expect(readFileSync(join(workspace, 'parent/source.bin'), 'utf8')).toBe('retain');
      await expect(rename({ from: 'parent/source.bin', to: 'parent', overwrite: true })).resolves.toMatchObject({ success: false });
      expect(readFileSync(join(workspace, 'parent/source.bin'), 'utf8')).toBe('retain');
    } finally {
      await registration.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each(['osUser', 'restrictedRoots'] as const)('preserves incumbent alias %s admission without weakening semantic roots', async kind => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-legacy-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'happier-files-legacy-outside-'));
    const mgr = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    const registration = registerFileSystemHandlers(mgr, workspace, {
      accessPolicy: kind === 'osUser' ? { kind } : { kind, roots: [workspace, outside] },
      actionExecutor: createMutationExecutor({ ...mutationDeps(workspace),
        accessPolicy: kind === 'osUser' ? { kind } : { kind, roots: [workspace, outside] } }),
    });
    const invoke = (method: string, input: unknown) => mgr.invokeLocal(method, input);
    try {
      const nested = join(outside, 'nested');
      await expect(invoke('daemon.filesystem.createDirectory', { rootPath: workspace, path: nested })).resolves.toMatchObject({ success: false });
      await expect(invoke(RPC_METHODS.CREATE_DIRECTORY, { path: nested })).resolves.toEqual({ success: true });
      await expect(invoke(RPC_METHODS.CREATE_DIRECTORY, { rootPath: workspace, path: join(outside, 'rooted-alias') })).resolves.toMatchObject({ success: false });
      await expect(invoke(RPC_METHODS.CREATE_DIRECTORY, { path: join(outside, 'spoofed-scope'), incumbentPolicyScope: true })).resolves.toMatchObject({ success: false, errorCode: 'invalid_input' });
      expect(existsSync(join(outside, 'rooted-alias'))).toBe(false);
      expect(existsSync(join(outside, 'spoofed-scope'))).toBe(false);
      const bytes = Buffer.from([255, 0, 128]);
      const source = join(nested, 'source.bin');
      const destination = join(workspace, 'moved.bin');
      writeFileSync(source, bytes);
      if (kind === 'restrictedRoots') {
        const unauthorized = join(tmpdir(), `happier-files-unadmitted-${basename(workspace)}`, 'denied.bin');
        await expect(invoke(RPC_METHODS.RENAME_PATH, { from: source, to: unauthorized })).resolves.toMatchObject({ success: false, errorCode: 'access_denied' });
        expect(readFileSync(source)).toEqual(bytes);
        expect(existsSync(unauthorized)).toBe(false);
      }
      await expect(invoke('daemon.filesystem.rename', { rootPath: workspace, from: source, to: destination, overwrite: false })).resolves.toMatchObject({ success: false });
      await expect(invoke(RPC_METHODS.RENAME_PATH, { from: source, to: destination })).resolves.toEqual({ success: true });
      expect(readFileSync(destination)).toEqual(bytes);
      await expect(invoke(RPC_METHODS.DELETE_PATH, { path: nested, recursive: true })).resolves.toEqual({ success: true });
      expect(existsSync(nested)).toBe(false);
      if (kind === 'restrictedRoots') {
        await expect(invoke(RPC_METHODS.DELETE_PATH, { path: outside, recursive: true })).resolves.toMatchObject({ success: false, errorCode: 'root_refused' });
      }
    } finally {
      await registration.dispose();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses copy through nested symlinks outside the declared root and requires explicit recursion', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-copy-confined-'));
    const outside = mkdtempSync(join(tmpdir(), 'happier-files-copy-outside-'));
    const mgr = createRpcHandlerManager();
    const registration = registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace, {
      actionExecutor: createMutationExecutor(mutationDeps(workspace)),
    });
    try {
      mkdirSync(join(workspace, 'source'));
      writeFileSync(join(workspace, 'source/file.bin'), Buffer.from([0, 255]));
      writeFileSync(join(outside, 'secret'), 'private');
      symlinkSync(outside, join(workspace, 'source/outside'), 'junction');
      const copy = mgr.handlers.get('copyPath');
      if (!copy) throw new Error('expected copy Action handler');
      await expect(copy({ rootPath: workspace, from: 'source', to: 'copy', overwrite: false, recursive: false })).resolves.toMatchObject({ success: false });
      await expect(copy({ rootPath: workspace, from: 'source', to: 'copy', overwrite: false, recursive: true })).resolves.toMatchObject({ success: false });
      expect(existsSync(join(workspace, 'copy/outside'))).toBe(false);
    } finally {
      await registration.dispose();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('copies directory bytes recursively and refuses overwrite conflicts through the registered Action', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-copy-tree-'));
    const mgr = createRpcHandlerManager();
    const registration = registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace, {
      actionExecutor: createMutationExecutor(mutationDeps(workspace)),
    });
    try {
      mkdirSync(join(workspace, 'source/nested'), { recursive: true });
      const bytes = Buffer.from([255, 0, 254, 128]);
      writeFileSync(join(workspace, 'source/nested/binary'), bytes);
      const copy = mgr.handlers.get('copyPath');
      if (!copy) throw new Error('expected copy Action handler');
      const input = { rootPath: workspace, from: 'source', to: 'copy', overwrite: false, recursive: true };
      await expect(copy(input)).resolves.toEqual({ success: true });
      expect(readFileSync(join(workspace, 'copy/nested/binary'))).toEqual(bytes);
      writeFileSync(join(workspace, 'copy/nested/binary'), 'retain');
      await expect(copy(input)).resolves.toMatchObject({ success: false });
      expect(readFileSync(join(workspace, 'copy/nested/binary'), 'utf8')).toBe('retain');
      await expect(copy({ ...input, overwrite: true })).resolves.toEqual({ success: true });
      expect(readFileSync(join(workspace, 'copy/nested/binary'))).toEqual(bytes);
    } finally {
      await registration.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('admits the declared root under both source and destination policies and protects configured roots', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-action-policy-'));
    const readOnly = mkdtempSync(join(tmpdir(), 'happier-files-action-readonly-'));
    const mgr = createRpcHandlerManager();
    const registration = registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace, {
      accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
      getAdditionalAllowedReadDirs: () => [readOnly],
      actionExecutor: createMutationExecutor({ ...mutationDeps(workspace),
        accessPolicy: { kind: 'restrictedRoots', roots: [workspace] }, getAdditionalAllowedReadDirs: () => [readOnly] }),
    });
    try {
      writeFileSync(join(readOnly, 'source'), 'private');
      const copy = mgr.handlers.get('copyPath');
      const remove = mgr.handlers.get(RPC_METHODS.DELETE_PATH);
      if (!copy || !remove) throw new Error('expected mutation Action handlers');
      await expect(copy({ rootPath: readOnly, from: 'source', to: 'copy', overwrite: false, recursive: false })).resolves.toMatchObject({ success: false });
      expect(existsSync(join(readOnly, 'copy'))).toBe(false);
      await expect(copy({ rootPath: workspace, from: join(readOnly, 'source'), to: 'copy', overwrite: false, recursive: false })).resolves.toMatchObject({ success: false });
      expect(existsSync(join(workspace, 'copy'))).toBe(false);
      await expect(remove({ rootPath: workspace, path: '.', recursive: true })).resolves.toMatchObject({ success: false, errorCode: 'root_refused' });
      expect(readFileSync(join(readOnly, 'source'), 'utf8')).toBe('private');
    } finally {
      await registration.dispose();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(readOnly, { recursive: true, force: true });
    }
  });

  it('statFile returns exists=false for missing paths', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');

      const result = await statFile({ path: 'missing.txt' });
      expect(result).toMatchObject({ success: true, exists: false });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('statFile returns file metadata for existing files', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      writeFileSync(join(workspace, 'file.txt'), 'hello\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');

      const result = await statFile({ path: 'file.txt' });
      expect(result).toMatchObject({ success: true, exists: true, kind: 'file' });
      expect(typeof result.sizeBytes).toBe('number');
      expect(typeof result.modifiedMs).toBe('number');
      expect(result.contentHash).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('statFile preserves high-precision mtime for snapshot revision consumers', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      writeFileSync(join(workspace, 'file.txt'), 'hello\n', 'utf8');
      const statMock = vi.fn(async () => ({
        isDirectory: () => false,
        isFile: () => true,
        size: 5,
        mtime: new Date(100),
        mtimeMs: 100.125,
      }));
      vi.resetModules();
      vi.doMock('fs/promises', async (importOriginal) => {
        const original = await importOriginal<typeof import('fs/promises')>();
        return { ...original, stat: statMock };
      });
      const { registerFileSystemHandlers: registerHandlersWithPreciseStat } = await import('./fileSystem');
      const mgr = createRpcHandlerManager();
      registerHandlersWithPreciseStat(mgr as unknown as RpcHandlerManager, workspace);

      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');

      await expect(statFile({ path: 'file.txt', includeContentHash: true })).resolves.toEqual({
        success: true,
        exists: true,
        kind: 'file',
        sizeBytes: 6,
        modifiedMs: 100.125,
        contentHash: expect.any(String),
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('statFile reports an exact content hash for an equal-size edit', async () => {
    // The exact failure a size+mtime revision cannot see: a rewrite that keeps
    // the length and puts the modification time back. The opt-in content hash
    // names those bytes; changedMs remains metadata for older consumers.
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      const filePath = join(workspace, 'file.txt');
      // A modification time set from one Date on both writes, so the two stats
      // report it identically rather than merely closely.
      const pinnedModified = new Date(1_700_000_000_000);
      writeFileSync(filePath, 'hello', 'utf8');
      utimesSync(filePath, pinnedModified, pinnedModified);

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);
      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');

      const before = await statFile({ path: 'file.txt', includeContentHash: true });

      writeFileSync(filePath, 'world', 'utf8');
      utimesSync(filePath, pinnedModified, pinnedModified);
      const after = await statFile({ path: 'file.txt', includeContentHash: true });

      expect(after.sizeBytes).toBe(before.sizeBytes);
      expect(after.modifiedMs).toBe(before.modifiedMs);
      expect(typeof before.changedMs).toBe('number');
      expect(after.changedMs).toBeGreaterThan(before.changedMs);
      expect(typeof before.contentHash).toBe('string');
      expect(typeof after.contentHash).toBe('string');
      expect(after.contentHash).not.toBe(before.contentHash);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('statFile hashes bytes when every timestamp collides', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      const filePath = join(workspace, 'file.txt');
      const pinnedModified = new Date(1_700_000_000_000);
      writeFileSync(filePath, 'hello', 'utf8');
      utimesSync(filePath, pinnedModified, pinnedModified);

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);
      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');
      const before = await statFile({ path: 'file.txt', includeContentHash: true });

      writeFileSync(filePath, 'world', 'utf8');
      utimesSync(filePath, pinnedModified, pinnedModified);
      const after = await statFile({ path: 'file.txt', includeContentHash: true });

      expect(after.sizeBytes).toBe(before.sizeBytes);
      expect(after.modifiedMs).toBe(before.modifiedMs);
      expect(after.contentHash).not.toBe(before.contentHash);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('does not hash a file that grows beyond the inline ceiling during the read', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      writeFileSync(join(workspace, 'file.txt'), 'hello', 'utf8');
      const boundedRead = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
        buffer.fill(0x61, offset, offset + length);
        return { bytesRead: length };
      });
      const openMock = vi.fn(async () => ({
        read: boundedRead,
        close: vi.fn(async () => undefined),
      }));
      vi.resetModules();
      vi.doMock('fs/promises', async (importOriginal) => {
        const original = await importOriginal<typeof import('fs/promises')>();
        return { ...original, open: openMock };
      });
      const { registerFileSystemHandlers: registerHandlersWithBoundedRead } = await import('./fileSystem');
      const mgr = createRpcHandlerManager();
      registerHandlersWithBoundedRead(mgr as unknown as RpcHandlerManager, workspace);

      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');
      const result = await statFile({ path: 'file.txt', includeContentHash: true });

      // The mocked read fills the existing cap plus one byte, representing a
      // growth race. The response must omit a digest for that oversized buffer.
      expect(boundedRead).toHaveBeenCalledWith(expect.any(Buffer), 0, expect.any(Number), 0);
      expect(result).toMatchObject({ success: true, exists: true, kind: 'file', sizeBytes: 5 });
      expect(result.contentHash).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renamePath creates parent dirs and supports overwriting', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-rename-'));
    try {
      writeFileSync(join(workspace, 'from.txt'), 'hello\n', 'utf8');
      writeFileSync(join(workspace, 'from2.txt'), 'hello2\n', 'utf8');
      writeFileSync(join(workspace, 'to.txt'), 'old\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

      const renamePath = mgr.handlers.get(RPC_METHODS.RENAME_PATH);
      if (!renamePath) throw new Error('expected renamePath handler');

      const noOverwrite = await renamePath({ from: 'from.txt', to: 'to.txt', overwrite: false });
      expect(noOverwrite).toMatchObject({ success: false });

      const overwrite = await renamePath({ from: 'from.txt', to: 'to.txt', overwrite: true });
      expect(overwrite).toMatchObject({ success: true });

      const nestedRename = await renamePath({ from: 'from2.txt', to: 'nested/to.txt', overwrite: false });
      expect(nestedRename).toMatchObject({ success: true });
      expect(statSync(join(workspace, 'nested', 'to.txt')).isFile()).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('deletePath refuses to delete directories without recursive=true', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-delete-'));
    try {
      mkdirSync(join(workspace, 'dir'), { recursive: true });
      writeFileSync(join(workspace, 'dir', 'file.txt'), 'hello\n', { encoding: 'utf8', flag: 'w' });

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

      const deletePath = mgr.handlers.get(RPC_METHODS.DELETE_PATH);
      if (!deletePath) throw new Error('expected deletePath handler');

      const refused = await deletePath({ path: 'dir', recursive: false });
      expect(refused).toMatchObject({ success: false });

      const removed = await deletePath({ path: 'dir', recursive: true });
      expect(removed).toMatchObject({ success: true });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('deletePath refuses to delete the workspace root', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-delete-root-'));
    try {
      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

      const deletePath = mgr.handlers.get(RPC_METHODS.DELETE_PATH);
      if (!deletePath) throw new Error('expected deletePath handler');

      const result = await deletePath({ path: '.', recursive: true });
      expect(result).toMatchObject({ success: false });
      expect(String(result.error ?? '')).toContain('working directory root');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
