import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import type { ActionOperationProgressUpdate } from '@/daemon/actionOperations/actionOperationTypes';

import { materializeManagedWorkspaceSyncSeed, type ManagedWorkspaceSyncSeedTarget } from './materializeManagedWorkspaceSyncSeed';

const execFile = promisify(execFileCallback);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'managed-workspace-seed-'));
  directories.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  // Only the provider's command/file transport is substituted. Every selection,
  // Git export and materialization step runs through the real workspace owners.
  const target: ManagedWorkspaceSyncSeedTarget = {
    exec: async (command, signal) => {
      try {
        const result = await execFile('/bin/sh', ['-c', command], { signal, env: { ...process.env, PATH: '/usr/bin:/bin' } });
        return { status: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const result = error as Error & { code?: number; stdout?: string; stderr?: string };
        return { status: typeof result.code === 'number' ? result.code : 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      }
    },
    putFile: async (path, bytes) => { await writeFile(path, bytes); },
  };
  return { root, source, target, targetPath: join(root, 'guest', 'project'), signal: new AbortController().signal };
}

describe.skipIf(process.platform === 'win32')('managed target workspace seed', () => {
  it('copies a chosen folder with binary files, executable files and contained links', async () => {
    const f = await fixture();
    await mkdir(join(f.source, 'nested'));
    await writeFile(join(f.source, 'nested', 'uncommitted.bin'), Buffer.from([0, 255, 1]));
    await writeFile(join(f.source, 'run'), '#!/bin/sh\nexit 0\n');
    await chmod(join(f.source, 'run'), 0o755);
    await symlink('nested/uncommitted.bin', join(f.source, 'link'));
    const progress: ActionOperationProgressUpdate[] = [];
    const target = { ...f.target, putFile: async (...args: Parameters<typeof f.target.putFile>) => {
      expect(progress.at(-1)?.phase).toBe('project_files_copy');
      await f.target.putFile(...args);
    } };
    const result = await materializeManagedWorkspaceSyncSeed({ ...f, sourcePath: f.source, activeServerDir: f.root,
      target, onProgress: event => { progress.push(event); }, registry: createScmBackendRegistry([]) });
    expect(progress.map(event => event.phase)).toEqual(['project_files_copy']);
    expect(result).toMatchObject({ targetRoot: f.targetPath, outcome: 'copied' });
    expect(result.baseline).toMatchObject({ entries: expect.arrayContaining([
      expect.objectContaining({ relativePath: 'nested/uncommitted.bin', kind: 'file', sizeBytes: 3 }),
    ]) });
    expect(await readFile(join(result.targetRoot, 'nested', 'uncommitted.bin'))).toEqual(Buffer.from([0, 255, 1]));
    expect((await lstat(join(result.targetRoot, 'run'))).mode & 0o111).not.toBe(0);
    expect(await readlink(join(result.targetRoot, 'link'))).toBe('nested/uncommitted.bin');
  });

  it('keeps the existing shared target work even when the host folder has changed', async () => {
    const f = await fixture();
    await mkdir(f.targetPath, { recursive: true });
    await writeFile(join(f.targetPath, 'agent.txt'), 'agent edit');
    await writeFile(join(f.source, 'agent.txt'), 'host version');
    const progress: ActionOperationProgressUpdate[] = [];
    expect(await materializeManagedWorkspaceSyncSeed({ ...f, sourcePath: f.source, activeServerDir: f.root,
      onProgress: event => { progress.push(event); }, registry: createScmBackendRegistry([]) }))
      .toMatchObject({ targetRoot: f.targetPath, outcome: 'reused' });
    expect(progress).toEqual([]);
    expect(await readFile(join(f.targetPath, 'agent.txt'), 'utf8')).toBe('agent edit');
  });

  it('copies a chosen folder from a nested Git cwd with the whole repository mapping', async () => {
    const f = await fixture();
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'managed-seed-nested-' });
    directories.push(repository.rootPath);
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime!, registration,
    })]);
    const result = await materializeManagedWorkspaceSyncSeed({ ...f, sourcePath: repository.nestedPath,
      activeServerDir: f.root, registry });
    expect(result.workspace).toEqual({ hostRoot: repository.rootPath, targetRoot: f.targetPath });
    expect(result.targetRoot).toBe(join(f.targetPath, 'nested'));
    expect(await readFile(join(f.targetPath, 'tracked.txt'), 'utf8')).toBe('base\n');
  });

  it('reconstructs linked-worktree Git independently and includes dirty and untracked files', async () => {
    const f = await fixture();
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'managed-seed-git-' });
    directories.push(repository.rootPath);
    runScmExecutable(repository.rootPath, 'git', ['worktree', 'add', '-b', 'sandbox-work', f.source]);
    await writeFile(join(f.source, 'tracked.txt'), 'dirty worktree\n');
    await writeFile(join(f.source, 'sentinel.txt'), 'untracked sentinel\n');
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime!, registration,
    })]);
    const result = await materializeManagedWorkspaceSyncSeed({ ...f, sourcePath: f.source, activeServerDir: f.root, registry });
    expect(await readFile(join(result.targetRoot, 'sentinel.txt'), 'utf8')).toBe('untracked sentinel\n');
    expect(await readFile(join(result.targetRoot, 'tracked.txt'), 'utf8')).toBe('dirty worktree\n');
    expect((await lstat(join(result.targetRoot, '.git'))).isDirectory()).toBe(true);
    expect(runScmExecutable(result.targetRoot, 'git', ['rev-parse', 'HEAD'])).toBe(repository.headCommit);
    expect(runScmExecutable(result.targetRoot, 'git', ['status', '--porcelain'])).toContain('M tracked.txt');
    expect(runScmExecutable(result.targetRoot, 'git', ['status', '--porcelain'])).toContain('?? sentinel.txt');
    await writeFile(join(result.targetRoot, 'tracked.txt'), 'guest edit\n');
    expect(await readFile(join(f.source, 'tracked.txt'), 'utf8')).toBe('dirty worktree\n');
  });

  it('reports a typed copy failure without publishing a partial target root', async () => {
    const f = await fixture();
    await writeFile(join(f.source, 'sentinel.txt'), 'copy');
    const target = { ...f.target, putFile: async () => { throw new Error('provider file transfer failed'); } };
    await expect(materializeManagedWorkspaceSyncSeed({ ...f, target, sourcePath: f.source, activeServerDir: f.root,
      registry: createScmBackendRegistry([]) })).rejects.toMatchObject({ code: 'project_files_copy_failed' });
    await expect(lstat(f.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
