import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalAbsolutePathsEqual } from '@happier-dev/plugin-sdk/fs';
import type { ScmWorktreeEnrichmentEntry } from '@happier-dev/plugin-sdk/scm';
import { inspectGitCheckoutIdentity, resolveGitAdminPath } from '../checkoutIdentity.js';
import { runScmCommand } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { parseGitStatusPorcelainShortZ } from '../statusParser.js';
import { parseGitWorktreeListPorcelain } from '../worktreeListParser.js';

type Retention = NonNullable<ScmWorktreeEnrichmentEntry['retention']>;

/** Storage discovery uses the same orphan proof as retirement, without repairing registration. */
export async function resolveGitRetainedWorktreeRepository(path: string): Promise<string | null> {
    try {
        const contents = await readFile(join(path, '.git'), 'utf8');
        const admin = resolveGitAdminPath(path, contents.trim());
        if (!admin) return null;
        const common = dirname(dirname(admin));
        if (await inspectGitOrphanWorktree(path, common) === null) return null;
        const listed = await runScmCommand({ bin: 'git', cwd: common,
            args: ['worktree', 'list', '--porcelain', '-z'], env: buildScmNonInteractiveEnv() });
        if (!listed.success) return null;
        for (const worktree of parseGitWorktreeListPorcelain({ worktreesOutput: listed.stdout, currentWorktreePath: null })) {
            const identity = await inspectGitCheckoutIdentity({ cwd: worktree.path });
            if (identity && canonicalAbsolutePathsEqual(identity.gitDirPath, common)
                && canonicalAbsolutePathsEqual(identity.commonDirPath, common)
                && canonicalAbsolutePathsEqual(identity.worktreePath, worktree.path)) return worktree.path;
        }
        return null;
    } catch { return null; }
}

/** A missing registration is proved by the original Git back-reference, never a directory name. */
export async function inspectGitOrphanWorktree(path: string, commonDirPath: string, backReferenceBasePath = path): Promise<string | null> {
    try {
        const leaf = join(path, '.git');
        const info = await lstat(leaf);
        if (!info.isFile() || info.isSymbolicLink()) return null;
        const contents = await readFile(leaf, 'utf8');
        const admin = resolveGitAdminPath(backReferenceBasePath, contents.trim());
        if (!admin) return null;
        if (!basename(admin) || !canonicalAbsolutePathsEqual(dirname(admin), join(commonDirPath, 'worktrees'))
            || canonicalAbsolutePathsEqual(admin, join(commonDirPath, 'worktrees'))) return null;
        try { await lstat(admin); return null; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
        const registered = await runScmCommand({ bin: 'git', cwd: commonDirPath,
            args: ['worktree', 'list', '--porcelain', '-z'], env: buildScmNonInteractiveEnv() });
        if (!registered.success || parseGitWorktreeListPorcelain({ worktreesOutput: registered.stdout, currentWorktreePath: null })
            .some(worktree => canonicalAbsolutePathsEqual(worktree.path, path)
                || canonicalAbsolutePathsEqual(worktree.path, backReferenceBasePath))) return null;
        return contents;
    } catch { return null; }
}

/** Rename/discard proof shared by every SCM retention effect; a registered linked checkout stays on Git's path. */
export async function readGitRetentionKind(path: string, repositoryPath: string, backReferenceBasePath = path): Promise<'main' | 'common' | 'orphan' | null> {
    const [repository, identity] = await Promise.all([
        inspectGitCheckoutIdentity({ cwd: repositoryPath }), inspectGitCheckoutIdentity({ cwd: path }),
    ]);
    if (repository && identity && canonicalAbsolutePathsEqual(identity.gitDirPath, identity.commonDirPath)
        && canonicalAbsolutePathsEqual(identity.worktreePath, path)
        && canonicalAbsolutePathsEqual(repository.commonDirPath, identity.commonDirPath)) return 'main';
    const common = await runScmCommand({ bin: 'git', cwd: repositoryPath,
        args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], env: buildScmNonInteractiveEnv() });
    if (common.success && canonicalAbsolutePathsEqual(common.stdout.trim(), path)) return 'common';
    return repository && await inspectGitOrphanWorktree(path, repository.commonDirPath, backReferenceBasePath) !== null ? 'orphan' : null;
}

/** Failure to read any loss fact leaves the main checkout unreviewable. No network/fetch is performed. */
export async function readGitRetentionFacts(path: string, repositoryPath: string): Promise<Retention | undefined> {
    const repository = await inspectGitCheckoutIdentity({ cwd: repositoryPath });
    if (!repository) return undefined;
    const backReference = await inspectGitOrphanWorktree(path, repository.commonDirPath);
    if (backReference !== null) return { kind: 'orphan', commonDirPath: repository.commonDirPath,
        fingerprint: `sha256:${createHash('sha256').update(backReference).digest('hex')}` };
    const identity = await inspectGitCheckoutIdentity({ cwd: path });
    if (!identity || !canonicalAbsolutePathsEqual(identity.gitDirPath, identity.commonDirPath)
        || !canonicalAbsolutePathsEqual(identity.commonDirPath, repository.commonDirPath)
        || !canonicalAbsolutePathsEqual(identity.worktreePath, path)) return undefined;
    const command = (cwd: string, args: string[]) => runScmCommand({ bin: 'git', cwd, args, env: buildScmNonInteractiveEnv() });
    const [branches, refs, stashes, listed] = await Promise.all([
        command(path, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream)', 'refs/heads']),
        command(path, ['for-each-ref', '--format=%(refname)%00%(objectname)']),
        command(path, ['stash', 'list', '--format=%gd%x00%H']),
        command(path, ['worktree', 'list', '--porcelain', '-z']),
    ]);
    if (![branches, refs, stashes, listed].every(result => result.success)) return undefined;
    const losses: NonNullable<Retention['losses']> = { unpushedBranches: [], stashes: [], changes: [], dependentWorktrees: [] };
    for (const line of branches.stdout.split('\n').filter(Boolean)) {
        const [ref, oid, upstream] = line.split('\0');
        if (!ref || !oid) return undefined;
        const upstreamExists = upstream ? await command(path, ['rev-parse', '--verify', upstream]) : null;
        const ahead = await command(path, upstreamExists?.success
            ? ['rev-list', '--count', `${upstream}..${oid}`] : ['rev-list', '--count', oid, '--not', '--remotes']);
        if (!ahead.success || !/^\d+$/u.test(ahead.stdout.trim())) return undefined;
        const count = Number(ahead.stdout.trim());
        if (count) losses.unpushedBranches.push({ name: ref.slice('refs/heads/'.length), ahead: count });
    }
    for (const line of stashes.stdout.split('\n').filter(Boolean)) {
        const [name, oid] = line.split('\0');
        if (!name || !oid) return undefined;
        losses.stashes.push({ name, oid });
    }
    const statuses: string[] = [];
    for (const worktree of parseGitWorktreeListPorcelain({ worktreesOutput: listed.stdout, currentWorktreePath: null })) {
        if (!canonicalAbsolutePathsEqual(worktree.path, path)) losses.dependentWorktrees.push(worktree.path);
        // Missing/prunable dependents still appear in confirmation; they have no readable working files.
        try { await lstat(worktree.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return undefined; }
        const status = await command(worktree.path, ['status', '--porcelain', '-z', '--untracked-files=all']);
        if (!status.success) return undefined;
        statuses.push(worktree.path, status.stdout);
        for (const change of parseGitStatusPorcelainShortZ(status.stdout)) {
            losses.changes.push({ path: change.path, untracked: change.isUntracked, worktreePath: worktree.path });
        }
    }
    losses.dependentWorktrees.sort();
    return { kind: 'main', commonDirPath: identity.commonDirPath, losses,
        fingerprint: `sha256:${createHash('sha256').update(JSON.stringify([refs.stdout, stashes.stdout, listed.stdout, statuses])).digest('hex')}` };
}
