import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RpcHandler } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { confineWorkspaceTargetPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem/registerFileSystemHandlers';
import { registerWorkspaceFileSearchHandler } from '@/rpc/handlers/workspaceFileSearch';
import { registerWorkspaceFileListHandler } from '@/rpc/handlers/workspaceFileList';
import { createFilesystemEffectRpcRegistrar } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { runScmCommand } from '@/scm/runtime';
import { createWriteFileRpcActionExecutor } from '@/rpc/handlers/fileSystem/writeFileHandler';
import { executeFilesystemMutationAction } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createHash } from 'node:crypto';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { resolveWorkspaceFileUploadTarget } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';
import { localWorkspaceSource } from './localWorkspaceSource';
import { replaceUnboundWorkspaceSource, runWithWorkspaceSource, type WorkspaceChildProcess, type WorkspaceSource } from './workspaceSource';
import { listDirectoryEntries } from '@/rpc/handlers/fileSystem/directoryListing/listDirectoryEntries';
import { run as runDifftastic } from '@/integrations/difftastic/index';

/** Guard: a consumer reached outside a captured source must fail, never read this Machine's disk. */
const unboundSource = new Proxy({ kind: 'target', id: 'unbound' } as WorkspaceSource, {
  get: (target, key) => key in target ? Reflect.get(target, key)
    : () => { throw Object.assign(new Error('workspace source is not bound'), { code: 'workspace_source_unbound' }); },
});

/**
 * A container stand-in: it presents the SAME absolute paths as this Machine's
 * workspace (`visibleRoot`) but its bytes live elsewhere (`backingRoot`), the
 * way a Session's execution target does. Every operation is confined to the
 * target root with the target's own link facts through the path policy owner.
 */
function createFakeTargetSource(visibleRoot: string, backingRoot: string) {
  const calls: string[] = [];
  const disposed: string[] = [];
  const toBacking = (path: string) => {
    const rest = relative(visibleRoot, path);
    if (rest === '..' || rest.startsWith(`..${sep}`)) throw Object.assign(new Error('outside target'), { code: 'EACCES' });
    return join(backingRoot, rest);
  };
  const fromBacking = (path: string) => {
    const rest = relative(backingRoot, path);
    return rest === '..' || rest.startsWith(`..${sep}`) ? resolve('/__outside_target__', path) : join(visibleRoot, rest);
  };
  const facts = {
    realpath: async (path: string) => fromBacking(await fs.realpath(toBacking(path))),
    readlink: async (path: string) => {
      const target = await fs.readlink(toBacking(path));
      return fromBacking(resolve(toBacking(path), '..', target));
    },
  };
  const confined = async (path: string) => {
    const result = await confineWorkspaceTargetPath({ targetPath: path, rootPath: visibleRoot, facts, platform: process.platform });
    if (!result.valid) throw Object.assign(new Error(result.error), { code: 'access_denied' });
    return toBacking(result.resolvedPath);
  };
  const fakeChild = (stdout: string): WorkspaceChildProcess => {
    const child = new EventEmitter() as unknown as WorkspaceChildProcess & EventEmitter;
    const out = new PassThrough();
    const err = new PassThrough();
    Object.assign(child, { stdin: new PassThrough(), stdout: out, stderr: err, terminateTree: async () => undefined });
    setImmediate(() => { out.end(stdout); err.end(); setImmediate(() => child.emit('close', 0, null)); });
    return child;
  };
  const source: WorkspaceSource = {
    kind: 'target',
    id: 'target:fake',
    stat: async path => { calls.push('stat'); return await fs.stat(await confined(path)); },
    lstat: async path => { calls.push('lstat'); return await fs.lstat(await confined(path)); },
    readdir: async path => { calls.push('readdir'); return await fs.readdir(await confined(path), { withFileTypes: true }); },
    realpath: async path => facts.realpath(path),
    readlink: async path => facts.readlink(path),
    readFile: async path => { calls.push('readFile'); return await fs.readFile(await confined(path)); },
    open: async path => { calls.push('open'); return await fs.open(await confined(path), 'r'); },
    writeFile: async (path, bytes) => { await fs.writeFile(await confined(path), bytes); },
    mkdir: async (path, options) => { calls.push('mkdir'); await fs.mkdir(await confined(path), options); },
    rmdir: async path => { await fs.rmdir(await confined(path)); },
    rename: async (from, to) => { calls.push('rename'); await fs.rename(await confined(from), await confined(to)); },
    rm: async (path, options) => { calls.push('rm'); await fs.rm(await confined(path), options); },
    copyFile: async (from, to) => { await fs.copyFile(await confined(from), await confined(to)); },
    symlink: async (linkTarget, path) => { await fs.symlink(linkTarget, await confined(path)); },
    // Synchronous like the interface: lexical confinement to the backing root.
    openWrite: (path, options) => { calls.push('openWrite'); return localWorkspaceSource.openWrite(toBacking(path), options); },
    replaceFile: (async (input: Parameters<WorkspaceSource['replaceFile']>[0]) => {
      calls.push('replaceFile');
      const destPath = await confined(input.destPath);
      // The holder executes the same guarded replace inside the target.
      return await localWorkspaceSource.replaceFile({ ...input, destPath } as never);
    }) as WorkspaceSource['replaceFile'],
    resolveExecutable: async command => `/target/bin/${command}`,
    spawn: request => {
      calls.push(`spawn:${request.command}:${request.cwd}`);
      if (request.command === 'difft') return fakeChild('target-difft-output');
      if (request.command !== 'rg') return fakeChild('target-scm-output');
      return fakeChild(request.args.includes('--files')
        ? 'target-only.txt\n'
        : [
          { type: 'begin', data: { path: { text: 'target-only.txt' } } },
          { type: 'match', data: { path: { text: 'target-only.txt' }, lines: { text: 'TARGET\n' }, line_number: 1,
            submatches: [{ match: { text: 'TARGET' }, start: 0, end: 6 }] } },
          { type: 'end', data: { path: { text: 'target-only.txt' }, binary_offset: null } },
          { type: 'summary', data: {} },
        ].map(record => JSON.stringify(record)).join('\n') + '\n');
    },
    // The target's own rg takes operands directly.
    toolLaunch: async request => ({ command: request.tool === 'ripgrep' ? 'rg' : 'difft', args: [...request.args, ...(request.paths ?? [])] }),
    watchTree: () => { calls.push('watchTree'); return () => { disposed.push('watchTree'); }; },
    watchFile: (path) => { calls.push(`watchFile:${path}`); return () => { disposed.push('watchFile'); }; },
  };
  return { source, calls, disposed };
}

describe('workspace source consumers', () => {
  let visibleRoot: string;
  let backingRoot: string;
  let outside: string;

  let restoreUnbound: () => void = () => undefined;
  afterEach(() => restoreUnbound());

  beforeEach(async () => {
    restoreUnbound = replaceUnboundWorkspaceSource(unboundSource);
    visibleRoot = await fs.mkdtemp(join(tmpdir(), 'ws-source-local-'));
    backingRoot = await fs.mkdtemp(join(tmpdir(), 'ws-source-target-'));
    outside = await fs.mkdtemp(join(tmpdir(), 'ws-source-outside-'));
    await fs.writeFile(join(visibleRoot, 'same.txt'), 'LOCAL');
    await fs.writeFile(join(visibleRoot, 'local-only.txt'), 'L');
    await fs.writeFile(join(backingRoot, 'same.txt'), 'TARGET');
    await fs.writeFile(join(backingRoot, 'target-only.txt'), 'T');
    await fs.writeFile(join(outside, 'secret.txt'), 'SECRET');
  });
  afterEach(async () => {
    await Promise.all([visibleRoot, backingRoot, outside].map(path => fs.rm(path, { recursive: true, force: true })));
  });

  const ownerContext = (): RpcHandlerContext => ({ signal: new AbortController().signal, callerAuthority: 'present_user',
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true });

  function registerSelected(source: WorkspaceSource) {
    const handlers = new Map<string, RpcHandler>();
    const registrar = { registerHandler: (method: string, handler: RpcHandler) => { handlers.set(method, handler as RpcHandler); } };
    const admission = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
      resolveWorkspaceTarget: placement => placement.rootPath === visibleRoot ? source : null,
    });
    const filesystem = registerFileSystemHandlers(registrar, visibleRoot, {
      effectAdmission: admission, accessPolicy: { kind: 'restrictedRoots', roots: [visibleRoot] },
    });
    const admitted = createFilesystemEffectRpcRegistrar(registrar, admission);
    registerWorkspaceFileSearchHandler(admitted, visibleRoot, { accessPolicy: { kind: 'restrictedRoots', roots: [visibleRoot] } });
    registerWorkspaceFileListHandler(admitted, visibleRoot, { accessPolicy: { kind: 'restrictedRoots', roots: [visibleRoot] } });
    const call = (method: string, input: unknown) => handlers.get(method)!(input, ownerContext());
    // Admitted Actions bind the same selection before reaching their effect owners.
    const deps = { workingDirectory: visibleRoot, accessPolicy: { kind: 'restrictedRoots' as const, roots: [visibleRoot] },
      getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [] };
    const action = async <T>(input: unknown, effect: () => Promise<T>) =>
      runWithWorkspaceSource(await admission.selectWorkspaceSource(undefined, input), effect);
    const write = (input: Record<string, unknown>) => action(input, async () =>
      (await createWriteFileRpcActionExecutor(deps).execute('daemon.filesystem.writeFile', input, ownerContext())));
    const mutate = (actionId: 'daemon.filesystem.createDirectory' | 'daemon.filesystem.rename' | 'daemon.filesystem.delete', input: Record<string, unknown>) =>
      action(input, () => executeFilesystemMutationAction({ ...deps, actionId, input }));
    return { call, write, mutate, dispose: () => filesystem.dispose() };
  }

  it('routes every admitted file panel operation to the source chosen at admission (same path, different content)', async () => {
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    const { call, write, dispose } = registerSelected(target.source);
    try {
      const read = await call('daemon.filesystem.readFile', { rootPath: visibleRoot, path: join(visibleRoot, 'same.txt') }) as { success: boolean; content: string };
      expect(Buffer.from(read.content, 'base64').toString()).toBe('TARGET');

      const ranged = await call('daemon.filesystem.readFile', { rootPath: visibleRoot, path: join(visibleRoot, 'same.txt'), offset: 0, length: 3 }) as { content: string };
      expect(Buffer.from(ranged.content, 'base64').toString()).toBe('TAR');

      const listed = await call(RPC_METHODS.LIST_DIRECTORY, { rootPath: visibleRoot, path: visibleRoot }) as { entries: Array<{ name: string }> };
      expect(listed.entries.map(entry => entry.name).sort()).toEqual(['same.txt', 'target-only.txt']);

      const tree = await call('daemon.filesystem.getDirectoryTree', { rootPath: visibleRoot, path: visibleRoot, maxDepth: 1 }) as { tree: { children: Array<{ name: string }> } };
      expect(tree.tree.children.map(child => child.name).sort()).toEqual(['same.txt', 'target-only.txt']);

      const written = await write({ rootPath: visibleRoot, path: join(visibleRoot, 'new.txt'),
        content: Buffer.from('WRITTEN').toString('base64'), expectedHash: null });
      expect(written).toMatchObject({ ok: true, result: { success: true } });
      await expect(fs.readFile(join(backingRoot, 'new.txt'), 'utf8')).resolves.toBe('WRITTEN');
      await expect(fs.stat(join(visibleRoot, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

      const search = await call(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, { rootPath: visibleRoot, query: 'TARGET' }) as { ok: boolean; files: Array<{ path: string }> };
      expect(search).toMatchObject({ ok: true, files: [{ path: 'target-only.txt' }] });

      const files = await call(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST, { rootPath: visibleRoot }) as { ok: boolean; files?: unknown };
      expect(JSON.stringify(files)).toContain('target-only.txt');
      expect(target.calls).toContain(`spawn:rg:${visibleRoot}`);
    } finally { await dispose(); }
  });

  it('routes path mutations to the selected source and leaves this Machine untouched', async () => {
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    const { mutate, dispose } = registerSelected(target.source);
    try {
      expect(await mutate('daemon.filesystem.createDirectory', { rootPath: visibleRoot, path: join(visibleRoot, 'made') })).toMatchObject({ success: true });
      expect(await mutate('daemon.filesystem.rename', { rootPath: visibleRoot, from: join(visibleRoot, 'same.txt'),
        to: join(visibleRoot, 'renamed.txt'), overwrite: false })).toMatchObject({ success: true });
      expect(await mutate('daemon.filesystem.delete', { rootPath: visibleRoot, path: join(visibleRoot, 'target-only.txt'), recursive: false })).toMatchObject({ success: true });
      expect((await fs.readdir(backingRoot)).sort()).toEqual(['made', 'renamed.txt']);
      expect((await fs.readdir(visibleRoot)).sort()).toEqual(['local-only.txt', 'same.txt']);
    } finally { await dispose(); }
  });

  it('refuses link and dot-dot escapes from the target root with the target link facts', async () => {
    await fs.symlink(outside, join(backingRoot, 'escape'));
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    const { call, dispose } = registerSelected(target.source);
    try {
      const viaLink = await call('daemon.filesystem.readFile', { rootPath: visibleRoot, path: join(visibleRoot, 'escape', 'secret.txt') }) as { success: boolean; content?: string };
      expect(viaLink.success).toBe(false);
      const viaDots = await call('daemon.filesystem.readFile', { rootPath: visibleRoot, path: join(visibleRoot, '..', relative(resolve(visibleRoot, '..'), outside), 'secret.txt') }) as { success: boolean };
      expect(viaDots.success).toBe(false);
    } finally { await dispose(); }
  });

  it('preserves the target bytes when a guarded write conflicts', async () => {
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    const { write, dispose } = registerSelected(target.source);
    try {
      const result = await write({ rootPath: visibleRoot, path: join(visibleRoot, 'same.txt'),
        content: Buffer.from('CLOBBER').toString('base64'), expectedHash: 'f'.repeat(64) });
      expect(result).toMatchObject({ ok: true, result: { success: false, errorCode: 'hash_mismatch' } });
      await expect(fs.readFile(join(backingRoot, 'same.txt'), 'utf8')).resolves.toBe('TARGET');
      expect(target.calls).toContain('replaceFile');
    } finally { await dispose(); }
  });

  it('runs SCM commands through the selected source with the cwd interpreted in the target', async () => {
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    const result = await runWithWorkspaceSource(target.source, () => runScmCommand({ bin: 'git', cwd: visibleRoot, args: ['status'] }));
    expect(result).toMatchObject({ success: true, stdout: 'target-scm-output' });
    expect(target.calls).toContain(`spawn:/target/bin/git:${visibleRoot}`);
  });

  it('runs git push in a target with the target\'s own Git: no host config inspection or host-file reads', async () => {
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    await runWithWorkspaceSource(target.source, () => runScmCommand({ bin: 'git', cwd: visibleRoot, args: ['push', 'origin', 'main'] }));
    // The host push transport would inspect Git config origins (reported by the guest) and read those host files.
    expect(target.calls.filter(call => call.startsWith('spawn:'))).toEqual([`spawn:/target/bin/git:${visibleRoot}`]);
  });

  it('keeps today\'s local behaviour when no target is selected', async () => {
    const { call, dispose } = registerSelected(createFakeTargetSource(visibleRoot, backingRoot).source);
    const other = await fs.mkdtemp(join(tmpdir(), 'ws-source-other-'));
    try {
      await fs.writeFile(join(other, 'same.txt'), 'OTHER-LOCAL');
      const handlers = new Map<string, RpcHandler>();
      registerFileSystemHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler); } }, other, {
        effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home', resolveWorkspaceTarget: () => null }),
      });
      const read = await handlers.get('daemon.filesystem.readFile')!({ rootPath: other, path: join(other, 'same.txt') },
        ownerContext()) as { content: string };
      expect(Buffer.from(read.content, 'base64').toString()).toBe('OTHER-LOCAL');
      void call;
    } finally { await dispose(); await fs.rm(other, { recursive: true, force: true }); }
  });

  it('publishes an upload into the source admitted at init, even when finalize arrives in another request', async () => {
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    const resolved = runWithWorkspaceSource(target.source, () => resolveWorkspaceFileUploadTarget({ workingDirectory: visibleRoot,
      path: join(visibleRoot, 'uploaded.txt'), sizeBytes: 8, overwrite: false,
      accessPolicy: { kind: 'restrictedRoots', roots: [visibleRoot] } }));
    if (!resolved.success) throw new Error(resolved.error);
    const staged = join(outside, 'staged-upload');
    await fs.writeFile(staged, 'UPLOADED');
    const result = await resolved.target.finalizeUpload({ uploadId: 'u1', tempPath: staged, sizeBytes: 8,
      sha256: createHash('sha256').update('UPLOADED').digest('hex') } as never);
    expect(result).toMatchObject({ success: true });
    await expect(fs.readFile(join(backingRoot, 'uploaded.txt'), 'utf8')).resolves.toBe('UPLOADED');
    await expect(fs.stat(join(visibleRoot, 'uploaded.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('downloads the target bytes for the same path', async () => {
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    const result = await runWithWorkspaceSource(target.source, () => resolveWorkspaceFileDownloadSource({ workingDirectory: visibleRoot,
      path: join(visibleRoot, 'same.txt'), asZip: false, accessPolicy: { kind: 'restrictedRoots', roots: [visibleRoot] } }));
    if (!result.success) throw new Error(result.error);
    const source = result.source as { filePath: string; deleteFileOnClose: boolean };
    try {
      await expect(fs.readFile(source.filePath, 'utf8')).resolves.toBe('TARGET');
      expect(source.deleteFileOnClose).toBe(true);
    } finally { await fs.rm(source.filePath, { force: true }); }
  });

  it('fails a consumer reached outside a captured source instead of reading this Machine', async () => {
    await expect(listDirectoryEntries({ directoryPath: visibleRoot, includeFiles: true, maxEntries: null, statConcurrency: 4 }))
      .rejects.toMatchObject({ code: 'workspace_source_unbound' });
  });

  it('copies inside the target with install semantics and leaves this Machine untouched', async () => {
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    await fs.mkdir(join(backingRoot, 'dir', 'nested'), { recursive: true });
    await fs.writeFile(join(backingRoot, 'dir', 'nested', 'deep.txt'), 'DEEP');
    const { mutate, dispose } = registerSelected(target.source);
    try {
      const copy = (input: Record<string, unknown>) => mutate('daemon.filesystem.copy' as never, input);
      expect(await copy({ rootPath: visibleRoot, from: join(visibleRoot, 'dir'), to: join(visibleRoot, 'dir-copy'), overwrite: false, recursive: true }))
        .toMatchObject({ success: true });
      expect(await copy({ rootPath: visibleRoot, from: join(visibleRoot, 'target-only.txt'), to: join(visibleRoot, 'same.txt'), overwrite: true, recursive: false }))
        .toMatchObject({ success: true });
      await expect(fs.readFile(join(backingRoot, 'dir-copy', 'nested', 'deep.txt'), 'utf8')).resolves.toBe('DEEP');
      await expect(fs.readFile(join(backingRoot, 'same.txt'), 'utf8')).resolves.toBe('T');
      expect((await fs.readdir(backingRoot)).filter(name => name.includes('happier-'))).toEqual([]);
      expect((await fs.readdir(visibleRoot)).sort()).toEqual(['local-only.txt', 'same.txt']);
    } finally { await dispose(); }
  });

  it('downloads a target folder as a ZIP of the target entries', async () => {
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    const result = await runWithWorkspaceSource(target.source, () => resolveWorkspaceFileDownloadSource({ workingDirectory: visibleRoot,
      path: visibleRoot, asZip: true, accessPolicy: { kind: 'restrictedRoots', roots: [visibleRoot] } }));
    if (!result.success) throw new Error(result.error);
    const zip = result.source as { filePath: string };
    try {
      const bytes = (await fs.readFile(zip.filePath)).toString('latin1');
      expect(bytes).toContain('target-only.txt');
      expect(bytes).not.toContain('local-only.txt');
    } finally { await fs.rm(zip.filePath, { force: true }); }
  });

  it('runs difftastic in the target', async () => {
    const target = createFakeTargetSource(visibleRoot, backingRoot);
    const diff = await runWithWorkspaceSource(target.source, () => runDifftastic(['a', 'b'], { cwd: visibleRoot }));
    expect(diff).toMatchObject({ exitCode: 0, stdout: 'target-difft-output' });
    expect(target.calls).toContain(`spawn:difft:${visibleRoot}`);
  });

  describe('Machine members in a target Session', () => {
    const memberContext = (authorization?: unknown): RpcHandlerContext => ({ signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true,
      ...(authorization ? { authorization: authorization as never } : {}) });
    function registerForMember(resolveWorkspaceTarget: Parameters<typeof createFilesystemEffectAdmission>[0] extends infer P
      ? P extends { resolveWorkspaceTarget?: infer R } ? R : never : never) {
      const handlers = new Map<string, RpcHandler>();
      const filesystem = registerFileSystemHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler); } }, visibleRoot, {
        effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home', resolveWorkspaceTarget }),
        accessPolicy: { kind: 'restrictedRoots', roots: [visibleRoot] } });
      return { handlers, dispose: () => filesystem.dispose() };
    }

    it('serves a member whose Session access was admitted, confined to the target workspace', async () => {
      const target = createFakeTargetSource(visibleRoot, backingRoot);
      const { handlers, dispose } = registerForMember(placement => placement.sessionId === 'target-session' ? target.source : null);
      try {
        const read = await handlers.get('daemon.filesystem.readFile')!({ rootPath: visibleRoot, path: join(visibleRoot, 'same.txt') },
          memberContext({ kind: 'session.write', sessionId: 'target-session' })) as { success: boolean; content?: string };
        expect(read.success).toBe(true);
        expect(Buffer.from(read.content!, 'base64').toString()).toBe('TARGET');
        await fs.symlink(outside, join(backingRoot, 'escape'));
        const escaped = await handlers.get('daemon.filesystem.readFile')!({ rootPath: visibleRoot, path: join(visibleRoot, 'escape', 'secret.txt') },
          memberContext({ kind: 'session.write', sessionId: 'target-session' })) as { success: boolean };
        expect(escaped.success).toBe(false);
      } finally { await dispose(); }
    });

    it('refuses a member without admitted Session access, and keeps this Machine\'s disk refused', async () => {
      const target = createFakeTargetSource(visibleRoot, backingRoot);
      const { handlers, dispose } = registerForMember(placement => placement.rootPath === visibleRoot ? target.source : null);
      try {
        expect(await handlers.get('daemon.filesystem.readFile')!({ rootPath: visibleRoot, path: join(visibleRoot, 'same.txt') }, memberContext()))
          .toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
      } finally { await dispose(); }
      const local = registerForMember(() => null);
      try {
        expect(await local.handlers.get('daemon.filesystem.readFile')!({ rootPath: visibleRoot, path: join(visibleRoot, 'same.txt') },
          memberContext({ kind: 'session.write', sessionId: 'target-session' })))
          .toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
      } finally { await local.dispose(); }
    });

    it('places and admits an Action whose Session origin rides only its execution authorization', async () => {
      const target = createFakeTargetSource(visibleRoot, backingRoot);
      const admission = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
        resolveWorkspaceTarget: placement => placement.sessionId === 'target-session' ? target.source : null });
      const machine = { kind: 'machine' as const, machineId: 'machine' };
      const externalActionExecutionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-root', binding: {
        accountId: 'member', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', machineId: 'machine', installationId: 'installation', serverIdentityId: 'home',
        actionId: 'daemon.filesystem.readFile', requestId: 'member-request', target: machine,
        sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'target-session', starterDepth: 0, turnDepth: 0 },
          sourceTurnId: 'turn', requestId: 'member-request', callerPermissionMode: 'default' },
        sessionActionSource: { machineId: 'machine', installationId: 'installation' },
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'member-request', target: machine, input: {} }),
      } });
      const context = { externalActionExecutionAuthorization, signal: new AbortController().signal };
      const source = await admission.selectWorkspaceSource(context, { rootPath: join(tmpdir(), 'not-the-session-root') });
      expect(source).toBe(target.source);
      expect(await admission.action(context, { kind: 'unknown', reason: 'session_requester_unavailable' }, source)).toBeNull();
    });
  });
});
