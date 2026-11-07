import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGitBackend } from '../backend.js';
import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import { createScmBackendRegistry } from '@/scm/registry';
import { readStorageWorktrees } from '@/daemon/resources/readStorageWorktrees';
import { createStorageWorktreeOperations } from '@/storage/worktrees/storageWorktreeOperations';
import { withGitWorktreeMutation } from './worktreeMutationQueue.js';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';

const fixtures: string[] = [];
let disposeNative: (() => Promise<void>) | undefined;
beforeAll(async () => { disposeNative = await createProcessCustodyFixture({ repoRoot: resolve('../../..') }); });
afterAll(async () => { await disposeNative?.(); });
beforeAll(() => console.info('Worktree fixture runtime:', process.platform, process.version,
    execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-retention-')));
    fixtures.push(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Worktree fixture');
    git(root, 'config', 'user.email', 'worktree@example.invalid');
    await writeFile(join(root, '.gitignore'), '.dev/\ntrash/\n');
    await writeFile(join(root, 'file'), 'original');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'initial');
    const path = join(root, '.dev', 'worktree', 'feature');
    git(root, 'worktree', 'add', '-b', 'feature', path);
    const targetPath = join(root, 'trash', 'entry', 'payload');
    await mkdir(join(root, 'trash', 'entry'), { recursive: true });
    const context = { cwd: root, projectKey: root, detection: { isRepo: true, rootPath: root, mode: '.git' as const } };
    return { root, path, targetPath, context, backend: createGitBackend() };
}
afterEach(async () => { for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('worktree retention through the Git backend', () => {
    it('proves registration-gone orphans, renames without rewriting their back-reference, and restores exactly', async () => {
        const f = await fixture();
        const adminPath = git(f.path, 'rev-parse', '--absolute-git-dir');
        await writeFile(join(f.path, '.git'), `gitdir: ${relative(f.path, adminPath)}\n`);
        f.targetPath = join(f.root, 'trash', 'entry', 'nested', 'payload');
        await mkdir(join(f.root, 'trash', 'entry', 'nested'));
        const backReference = await readFile(join(f.path, '.git'));
        await writeFile(join(f.path, 'file'), 'orphan changes');
        await rm(join(f.root, '.git', 'worktrees', 'feature'), { recursive: true });
        await runWithRealGitScmRuntime(async () => {
            const values = await f.backend.worktreesEnrichment!({ context: f.context, request: { worktreePaths: [f.path] } });
            expect(values.worktrees?.find(value => value.path === f.path)).toMatchObject({ retention: { kind: 'orphan' } });
            const request = { worktreePath: f.path, targetPath: f.targetPath, entryId: 'entry' };
            expect(await f.backend.worktreeRetire!({ context: f.context, request })).toMatchObject({ success: true });
            expect(await readFile(join(f.targetPath, '.git'))).toEqual(backReference);
            expect(await readFile(join(f.targetPath, 'file'), 'utf8')).toBe('orphan changes');
            expect(git(f.root, 'worktree', 'list', '--porcelain')).not.toContain(f.targetPath);
            expect(await f.backend.worktreeReinstate!({ context: f.context,
                request: { ...request, worktreePath: f.targetPath, targetPath: f.path } })).toMatchObject({ success: true });
            expect(await readFile(join(f.path, '.git'))).toEqual(backReference);
            expect(await readFile(join(f.path, 'file'), 'utf8')).toBe('orphan changes');
            expect(git(f.root, 'worktree', 'list', '--porcelain')).not.toContain(f.path);
            const refusal = new Error('changed since review');
            await expect(f.backend.worktreeRetire!({ context: { ...f.context,
                beforeFilesystemMutation: async () => { throw refusal; } }, request })).rejects.toBe(refusal);
            expect(await readFile(join(f.path, '.git'))).toEqual(backReference);
            expect(await f.backend.worktreeRetire!({ context: f.context, request })).toMatchObject({ success: true });
            const owner = createStorageWorktreeOperations({ happyHomeDir: join(f.root, 'home'), registry: createScmBackendRegistry([f.backend]) });
            const removal = { repositoryRoot: f.root, worktreePath: f.targetPath, retentionKind: 'orphan' as const,
                retainedSourcePath: f.path, beforeEffect: async () => {} };
            await owner.remove(removal);
            await expect(lstat(f.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });
    it('reports repository-wide loss facts and retains a dirty main checkout with its branches, stash and dependent worktrees', async () => {
        const f = await fixture();
        const trashRoot = await realpath(await mkdtemp(join(tmpdir(), 'happier-main-trash-')));
        fixtures.push(trashRoot);
        const targetPath = join(trashRoot, 'payload');
        await writeFile(join(f.root, 'file'), 'stash bytes'); git(f.root, 'stash', 'push', '-m', 'retain this stash');
        await writeFile(join(f.root, 'file'), 'pending changes');
        await writeFile(join(f.root, 'untracked'), 'untracked bytes');
        git(f.root, 'branch', 'local-only');
        const before = { status: git(f.root, 'status', '--porcelain'), refs: git(f.root, 'show-ref'), stash: git(f.root, 'stash', 'list') };
        await runWithRealGitScmRuntime(async () => {
            const values = await readStorageWorktrees({ cwds: [f.root], registry: createScmBackendRegistry([f.backend]) });
            expect(values.find(value => value.path === f.root)?.facts?.retention).toMatchObject({ kind: 'main',
                losses: { unpushedBranches: expect.arrayContaining([expect.objectContaining({ name: 'local-only', ahead: 1 })]),
                    stashes: [expect.objectContaining({ name: 'stash@{0}' })],
                    changes: expect.arrayContaining([expect.objectContaining({ path: 'file', untracked: false }),
                        expect.objectContaining({ path: 'untracked', untracked: true })]),
                    dependentWorktrees: expect.arrayContaining([f.path]) } });
            expect(await f.backend.worktreeRetire!({ context: f.context,
                request: { worktreePath: f.root, targetPath, entryId: 'main-entry' } })).toMatchObject({ success: true });
            expect(await readFile(join(targetPath, 'file'), 'utf8')).toBe('pending changes');
            const context = { ...f.context, cwd: targetPath, projectKey: targetPath,
                detection: { ...f.context.detection, rootPath: targetPath } };
            expect(await f.backend.worktreeReinstate!({ context,
                request: { worktreePath: targetPath, targetPath: f.root, entryId: 'main-entry' } })).toMatchObject({ success: true });
            expect({ status: git(f.root, 'status', '--porcelain'), refs: git(f.root, 'show-ref'), stash: git(f.root, 'stash', 'list') }).toEqual(before);
            expect(git(f.path, 'branch', '--show-current')).toBe('feature');
            expect(await readFile(join(f.root, 'untracked'), 'utf8')).toBe('untracked bytes');
        });
    });
    it('retains the common Git directory independently and empties a reviewed main checkout through the same SCM lifecycle', async () => {
        const f = await fixture();
        const trashRoot = await realpath(await mkdtemp(join(tmpdir(), 'happier-common-trash-'))); fixtures.push(trashRoot);
        const common = join(f.root, '.git'); const payload = join(trashRoot, 'payload');
        const head = await readFile(join(common, 'HEAD'));
        const owner = createStorageWorktreeOperations({ happyHomeDir: join(trashRoot, 'home'), registry: createScmBackendRegistry([f.backend]) });
        await runWithRealGitScmRuntime(async () => {
            await owner.retire({ repositoryRoot: f.root, worktreePath: common, targetPath: payload, entryId: 'common', retentionKind: 'common' });
            await expect(lstat(common)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await readFile(join(f.root, 'file'), 'utf8')).toBe('original');
            await owner.reinstate({ repositoryRoot: f.root, worktreePath: payload, targetPath: common, entryId: 'common', retentionKind: 'common' });
            expect(await readFile(join(common, 'HEAD'))).toEqual(head);
            expect(git(f.path, 'branch', '--show-current')).toBe('feature');
            await owner.retire({ repositoryRoot: f.root, worktreePath: f.root, targetPath: payload, entryId: 'main', retentionKind: 'main' });
            await owner.remove({ repositoryRoot: f.root, worktreePath: payload, retentionKind: 'main', beforeEffect: async () => {} });
            await expect(lstat(payload)).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });
    it('completes interrupted owner bookkeeping only after the trusted Trash identity guard', async () => {
        const f = await fixture();
        const owner = createStorageWorktreeOperations({ happyHomeDir: join(f.root, 'home'), registry: createScmBackendRegistry([f.backend]) });
        await runWithRealGitScmRuntime(async () => {
            git(f.root, 'worktree', 'move', '--', f.path, f.targetPath);
            await expect(owner.retire({ repositoryRoot: f.root, worktreePath: f.path, targetPath: f.targetPath, entryId: 'entry' })).rejects.toThrow();
            const identity = await lstat(f.targetPath);
            const retainedGuard = async () => {
                const current = await lstat(f.targetPath);
                expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino]);
                await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
            };
            await owner.retire({ repositoryRoot: f.root, worktreePath: f.path, targetPath: f.targetPath, entryId: 'entry', beforeEffect: retainedGuard });
            expect(git(f.root, 'worktree', 'list', '--porcelain')).toContain('locked happier-trash:entry');
            git(f.root, 'worktree', 'unlock', '--', f.targetPath);
            git(f.root, 'worktree', 'move', '--', f.targetPath, f.path);
            const restoredGuard = async () => {
                const current = await lstat(f.path);
                expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino]);
                await expect(lstat(f.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
            };
            await expect(owner.reinstate({ repositoryRoot: f.root, worktreePath: f.targetPath, targetPath: f.path, entryId: 'entry' })).rejects.toThrow();
            await owner.reinstate({ repositoryRoot: f.root, worktreePath: f.targetPath, targetPath: f.path, entryId: 'entry', beforeEffect: restoredGuard });
            expect(git(f.path, 'status', '--porcelain')).toBe('');
            git(f.root, 'worktree', 'lock', '--reason', 'different-entry', '--', f.path);
            await expect(owner.reinstate({ repositoryRoot: f.root, worktreePath: f.targetPath, targetPath: f.path,
                entryId: 'entry', beforeEffect: restoredGuard })).rejects.toThrow();
            await owner.remove({ repositoryRoot: f.root, worktreePath: f.path });
            await expect(owner.remove({ repositoryRoot: f.root, worktreePath: f.path })).rejects.toThrow();
            await owner.remove({ repositoryRoot: f.root, worktreePath: f.path, beforeEffect: async () => {
                await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
            } });
            expect(git(f.root, 'worktree', 'list', '--porcelain')).not.toContain(f.path);
            expect(git(f.root, 'show-ref', '--verify', 'refs/heads/feature')).toContain('refs/heads/feature');
        });
    });
    it('serializes one shared repository while allowing an unrelated repository to proceed', async () => {
        const f = await fixture(); const other = await fixture();
        let release!: () => void; let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const active = new Promise<void>(resolve => { entered = resolve; });
        const events: string[] = [];
        const start = performance.now();
        const first = withGitWorktreeMutation(f.root, async () => { events.push('first'); entered(); await gate; events.push('released'); });
        await active;
        const linked = withGitWorktreeMutation(f.path, async () => { events.push('linked'); });
        try {
            await withGitWorktreeMutation(other.root, async () => { events.push('other'); });
            expect(events).toEqual(['first', 'other']);
        } finally { release(); }
        await Promise.all([first, linked]);
        expect(events).toEqual(['first', 'other', 'released', 'linked']);
        console.info('Worktree repository queue discriminator elapsed ms:', Math.round(performance.now() - start));
    });
    it('supplies live storage facts and preserves the pre-effect refusal, while an approved dirty removal keeps its branch', async () => {
        const f = await fixture();
        const registry = createScmBackendRegistry([f.backend]);
        const owner = createStorageWorktreeOperations({ happyHomeDir: join(f.root, 'home'), registry });
        await writeFile(join(f.path, 'file'), 'dirty');
        await runWithRealGitScmRuntime(async () => {
            const values = await readStorageWorktrees({ cwds: [f.path], registry });
            const value = values.find(w => w.path === f.path);
            expect(value).toMatchObject({ repositoryRoot: f.root, isMain: false, retentionSupported: true,
                pullRequestState: null, facts: { changeCount: 1, ahead: 1, upstream: null, upstreamGone: false, hasSubmodules: false } });
            expect(value?.fingerprint).toMatch(/^sha256:/u);
            const refused = new Error('facts changed');
            await expect(owner.remove({ repositoryRoot: f.root, worktreePath: f.path,
                beforeEffect: async () => { throw refused; } })).rejects.toBe(refused);
            expect(git(f.path, 'branch', '--show-current')).toBe('feature');
            await owner.remove({ repositoryRoot: f.root, worktreePath: f.path, beforeEffect: async () => {} });
            await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(git(f.root, 'show-ref', '--verify', 'refs/heads/feature')).toContain('refs/heads/feature');
        });
    });
    it('reads ignored paths through the canonical backend without reporting tracked or ordinary untracked files', async () => {
        const f = await fixture();
        await mkdir(join(f.root, 'ignored'), { recursive: true });
        await writeFile(join(f.root, 'ignored', 'data'), 'ignored');
        await writeFile(join(f.root, '.gitignore'), '.dev/\ntrash/\nignored/\n');
        await writeFile(join(f.root, 'untracked'), 'visible');
        await runWithRealGitScmRuntime(async () => {
            const result = await f.backend.ignoredPaths?.({ context: f.context, request: { cwd: f.root } });
            expect(result).toMatchObject({ success: true });
            expect(result?.paths).toContain('ignored/');
            expect(result?.paths).not.toContain('untracked');
            expect(result?.paths).not.toContain('file');
        });
    });
    it('reads ignored paths without waiting behind an in-flight worktree mutation of the same repository', async () => {
        const f = await fixture();
        let release!: () => void; let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const active = new Promise<void>(resolve => { entered = resolve; });
        const mutation = withGitWorktreeMutation(f.root, async () => { entered(); await gate; });
        await active;
        try {
            await runWithRealGitScmRuntime(async () => {
                // A read-only `ls-files` writes nothing to the shared admin directory. The mutation
                // stays held for the whole test, so a queued read can only lose this race.
                const read = f.backend.ignoredPaths?.({ context: f.context, request: { cwd: f.root } });
                const winner = await Promise.race([read?.then(() => 'read'),
                    new Promise(resolve => setTimeout(() => resolve('queued'), 10_000))]);
                expect(winner).toBe('read');
                await expect(read).resolves.toMatchObject({ success: true });
            });
        } finally { release(); await mutation; }
    }, 30_000);
    it('keeps a retired worktree registered across prune, restores its files and branch, then discards a locked payload', async () => {
        const f = await fixture();
        await runWithRealGitScmRuntime(async () => {
            expect(await f.backend.worktreeRetire?.({ context: f.context, request: { worktreePath: f.path, targetPath: f.targetPath, entryId: 'entry' } })).toMatchObject({ success: true });
            git(f.root, 'worktree', 'prune', '--expire', 'now');
            expect(git(f.root, 'worktree', 'list', '--porcelain')).toContain('locked happier-trash:entry');
            expect(await f.backend.worktreeReinstate?.({ context: f.context, request: { worktreePath: f.targetPath, targetPath: f.path, entryId: 'entry' } })).toMatchObject({ success: true });
            expect(git(f.path, 'status', '--porcelain')).toBe('');
            expect(git(f.path, 'branch', '--show-current')).toBe('feature');
            expect(await f.backend.worktreeRetire?.({ context: f.context, request: { worktreePath: f.path, targetPath: f.targetPath, entryId: 'entry' } })).toMatchObject({ success: true });
            expect(await f.backend.worktreeRemove({ context: f.context, request: { worktreePath: f.targetPath, confirmed: true, authorizationToken: 'remove-worktree' } })).toMatchObject({ success: true });
            await expect(lstat(f.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(git(f.root, 'worktree', 'list', '--porcelain')).not.toContain(f.targetPath);
            expect(git(f.root, 'show-ref', '--verify', 'refs/heads/feature')).toContain('refs/heads/feature');
        });
    });
    it('refuses an occupied restore path and preserves the retired lock', async () => {
        const f = await fixture();
        await runWithRealGitScmRuntime(async () => {
            expect(await f.backend.worktreeRetire?.({ context: f.context, request: { worktreePath: f.path, targetPath: f.targetPath, entryId: 'entry' } })).toMatchObject({ success: true });
            await mkdir(f.path, { recursive: true });
            expect(await f.backend.worktreeReinstate?.({ context: f.context, request: { worktreePath: f.targetPath, targetPath: f.path, entryId: 'entry' } })).toMatchObject({ success: false });
            expect(git(f.root, 'worktree', 'list', '--porcelain')).toContain('locked happier-trash:entry');
        });
    });
    it('preserves a destination occupied during final host revalidation instead of moving into its child', async () => {
        const f = await fixture();
        await runWithRealGitScmRuntime(async () => {
            expect(await f.backend.worktreeRetire?.({ context: f.context, request: { worktreePath: f.path, targetPath: f.targetPath, entryId: 'entry' } }))
                .toMatchObject({ success: true });
            const context = { ...f.context, beforeFilesystemMutation: async () => {
                await mkdir(f.path, { recursive: true }); await writeFile(join(f.path, 'occupied'), 'preserve');
            } };
            expect(await f.backend.worktreeReinstate?.({ context, request: { worktreePath: f.targetPath, targetPath: f.path, entryId: 'entry' } }))
                .toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
            expect(git(f.root, 'worktree', 'list', '--porcelain')).toContain('locked happier-trash:entry');
            expect(git(f.targetPath, 'branch', '--show-current')).toBe('feature');
        });
    });
    it('removes an empty locked worktree registration and preserves the branch', async () => {
        const f = await fixture();
        git(f.path, 'rm', '.gitignore', 'file'); git(f.path, 'commit', '-m', 'empty');
        git(f.root, 'worktree', 'lock', '--reason', 'kept-by-user', '--', f.path);
        await runWithRealGitScmRuntime(async () => {
            expect(await f.backend.worktreeRemove({ context: f.context, request: { worktreePath: f.path, confirmed: true, authorizationToken: 'remove-worktree' } }))
                .toMatchObject({ success: true });
            await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(git(f.root, 'worktree', 'list', '--porcelain')).not.toContain(f.path);
            expect(git(f.root, 'show-ref', '--verify', 'refs/heads/feature')).toContain('refs/heads/feature');
        });
    });
    it('refuses retaining submodule worktrees while explicit deletion remains supported', async () => {
        const f = await fixture();
        git(f.path, 'update-index', '--add', '--cacheinfo', `160000,${git(f.root, 'rev-parse', 'HEAD')},submodule`);
        git(f.path, 'commit', '-m', 'submodule');
        await runWithRealGitScmRuntime(async () => {
            expect(await f.backend.worktreeRetire?.({ context: f.context, request: { worktreePath: f.path, targetPath: f.targetPath, entryId: 'entry' } }))
                .toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
            expect(await f.backend.worktreeRemove({ context: f.context, request: { worktreePath: f.path, confirmed: true, authorizationToken: 'remove-worktree' } }))
                .toMatchObject({ success: true });
            await expect(lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(git(f.root, 'show-ref', '--verify', 'refs/heads/feature')).toContain('refs/heads/feature');
        });
    });
    it('refuses moving a parent while another registered worktree is nested inside it', async () => {
        const f = await fixture();
        const nested = join(f.path, 'nested');
        git(f.root, 'worktree', 'add', '-b', 'nested', nested);
        await runWithRealGitScmRuntime(async () => {
            expect(await f.backend.worktreeRetire?.({ context: f.context, request: { worktreePath: f.path, targetPath: f.targetPath, entryId: 'entry' } }))
                .toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
            expect(await f.backend.worktreeRemove({ context: f.context, request: { worktreePath: f.path, confirmed: true, authorizationToken: 'remove-worktree' } }))
                .toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
            expect(git(nested, 'branch', '--show-current')).toBe('nested');
        });
    });
});
