import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import type { ScmBackendContext } from './types.js';
import { createGitBackend } from './backend.js';
import { detectGitRepo, getGitSnapshot } from './repository.js';
import { createRealGitScmBackendRuntimeServices, runWithGitScmCommandRunner, runWithRealGitScmRuntime } from './testkit/scmRuntime.test-support.js';

import { gitDiffFile } from './operations/readOperations.js';
import { runScmCommand as runHostScmCommand } from '../../../../apps/cli/src/scm/runtime';
import { createScmBackendRegistry } from '../../../../apps/cli/src/scm/registry';
import { runScmRoute } from '../../../../apps/cli/src/scm/rpc/dispatch';

const readSnapshot = (input: Parameters<typeof getGitSnapshot>[0]) => runWithRealGitScmRuntime(() => getGitSnapshot(input));
const readFileDiff = (input: Parameters<typeof gitDiffFile>[0]) => runWithRealGitScmRuntime(() => gitDiffFile(input));

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd });
    return stdout.trim();
}

async function makeTempDir(prefix: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), prefix));
}

async function initRepoWithCommit(prefix: string): Promise<string> {
    const repoRoot = await makeTempDir(prefix);
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await runGit(repoRoot, ['config', 'user.name', 'Happier Test']);
    await runGit(repoRoot, ['branch', '-M', 'main']);
    await writeFile(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
    await runGit(repoRoot, ['add', 'README.md']);
    await runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function buildContext(repoRoot: string): ScmBackendContext {
    return {
        cwd: repoRoot,
        projectKey: `test:${repoRoot}`,
        detection: {
            isRepo: true,
            rootPath: repoRoot,
            mode: '.git',
        },
    };
}

describe('Git repository worktree status enrichment', () => {
    const cleanups: Array<() => Promise<void>> = [];

    beforeEach(() => {
        cleanups.length = 0;
    });

    afterEach(async () => {
        await Promise.all(cleanups.map((cleanup) => cleanup().catch(() => undefined)));
    });

    it.each([false, true])('reads one-file snapshot metadata without repeated Git processes (linked worktree: %s)', async (linked) => {
        const repoRoot = await initRepoWithCommit('git-snapshot-process-count-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        const worktreeRoot = linked ? await makeTempDir('git-snapshot-process-linked-') : repoRoot;
        if (linked) {
            cleanups.push(() => rm(worktreeRoot, { recursive: true, force: true }));
            await runGit(repoRoot, ['worktree', 'add', '-b', 'linked', worktreeRoot]);
        }
        await writeFile(join(worktreeRoot, 'README.md'), 'changed\n');
        const observedCommands: string[][] = [];
        const response = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(async (input) => {
            observedCommands.push([...input.args]);
            return runHostScmCommand({ ...input, bin: input.command, args: [...input.args] });
        }, async () => {
            const detection = await detectGitRepo({ cwd: worktreeRoot });
            return getGitSnapshot({ context: { cwd: worktreeRoot, detection, projectKey: `test:${worktreeRoot}` },
                request: { operationStateVersion: 1 } });
        }));
        expect(response).toMatchObject({ success: true, snapshot: { operationState: null,
            entries: [{ path: 'README.md', stats: { pendingAdded: 1, pendingRemoved: 1 } }],
            branch: { head: linked ? 'linked' : 'main' } } });
        expect(response.snapshot?.repo.worktrees.find(worktree => worktree.branch === 'main')?.isMain).toBe(true);
        // Real plugin → SDK → CLI process execution, including repository detection.
        expect(observedCommands).toHaveLength(linked ? 9 : 8);
    });

    it.each([false, true])('reads repository facts without scanning the working copy (linked worktree: %s)', async (linked) => {
        const repoRoot = await initRepoWithCommit('git-snapshot-facts-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        const worktreeRoot = linked ? await makeTempDir('git-snapshot-facts-linked-') : repoRoot;
        if (linked) {
            cleanups.push(() => rm(worktreeRoot, { recursive: true, force: true }));
            await runGit(repoRoot, ['worktree', 'add', '-b', 'linked', worktreeRoot]);
        }
        await writeFile(join(worktreeRoot, 'README.md'), 'changed\n');
        await writeFile(join(worktreeRoot, 'untracked.txt'), 'new\n');
        const observedCommands: string[][] = [];
        const read = (detail?: 'facts') => runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(async (input) => {
            observedCommands.push([...input.args]);
            return runHostScmCommand({ ...input, bin: input.command, args: [...input.args] });
        }, async () => {
            const detection = await detectGitRepo({ cwd: worktreeRoot });
            return getGitSnapshot({ context: { cwd: worktreeRoot, detection, projectKey: `test:${worktreeRoot}` },
                request: { operationStateVersion: 1, ...(detail ? { detail } : {}) } });
        }));
        const full = await read();
        observedCommands.length = 0;
        const facts = await read('facts');
        expect(facts).toMatchObject({ success: true, snapshot: { detail: 'facts', entries: [],
            repo: { rootPath: full.snapshot?.repo.rootPath, worktrees: full.snapshot?.repo.worktrees },
            branch: { head: full.snapshot?.branch.head, headOid: full.snapshot?.branch.headOid, ahead: 0, behind: 0 } } });
        // No working-copy scan: no status walk, no numstat, no untracked reads.
        expect(observedCommands.filter(args => args[0] === 'status' || args[0] === 'diff' || args.includes('--numstat'))).toEqual([]);
    });

    it.each(['HEAD', 'symbolic-ref', 'upstream', 'ahead-behind'] as const)('reports interrupted %s facts instead of inventing branch state', async (probe) => {
        const repoRoot = await initRepoWithCommit('git-snapshot-facts-interrupted-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await runGit(repoRoot, ['branch', 'upstream']);
        await runGit(repoRoot, ['branch', '--set-upstream-to=upstream', 'main']);
        const originalCommand = createRealGitScmBackendRuntimeServices().runCommand;
        for (const interruption of [
            { exitCode: 1, timedOut: true, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT },
            { exitCode: 1, outputLimitExceeded: true, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_OUTPUT_LIMIT_EXCEEDED },
            { exitCode: -1, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_OUTCOME_UNKNOWN },
        ]) {
            const response = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(async (input) => {
                const interrupted = probe === 'HEAD' ? input.args.includes('HEAD^{commit}')
                    : probe === 'symbolic-ref' ? input.args[0] === 'symbolic-ref'
                        : probe === 'upstream' ? input.args[0] === 'rev-parse' && input.args.includes('@{upstream}')
                            : input.args[0] === 'rev-list';
                return interrupted ? { success: false, stdout: '', stderr: 'probe interrupted', ...interruption }
                    : originalCommand(input);
            }, () => getGitSnapshot({ context: buildContext(repoRoot), request: { detail: 'facts' } })));
            expect(response).toEqual({ success: false, errorCode: interruption.errorCode, error: 'probe interrupted' });
        }
    });

    it.each(['unborn', 'detached', 'no-upstream', 'upstream'] as const)('preserves genuine %s repository facts', async (state) => {
        const repoRoot = state === 'unborn' ? await makeTempDir('git-snapshot-facts-unborn-')
            : await initRepoWithCommit('git-snapshot-facts-state-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        if (state === 'unborn') {
            await runGit(repoRoot, ['init']);
            await runGit(repoRoot, ['branch', '-M', 'main']);
        } else if (state === 'detached') await runGit(repoRoot, ['checkout', '--detach']);
        else if (state === 'upstream') {
            await runGit(repoRoot, ['branch', 'upstream']);
            await runGit(repoRoot, ['branch', '--set-upstream-to=upstream', 'main']);
            await writeFile(join(repoRoot, 'README.md'), 'ahead\n');
            await runGit(repoRoot, ['commit', '-am', 'ahead']);
        }
        const response = await readSnapshot({ context: buildContext(repoRoot), request: { detail: 'facts' } });
        expect(response).toMatchObject({ success: true, snapshot: { detail: 'facts', entries: [], branch: {
            head: state === 'detached' ? null : 'main',
            ...(state === 'unborn' ? {} : { headOid: await runGit(repoRoot, ['rev-parse', 'HEAD']) }),
            upstream: state === 'upstream' ? 'upstream' : null,
            ahead: state === 'upstream' ? 1 : 0, behind: 0,
        } } });
        if (state === 'unborn') expect(response.snapshot?.branch.headOid).toBeUndefined();
    });

    it.each(([['merge', false], ['rebase', false], ['merge', true]] as const).filter(([, newlineCheckout]) => !newlineCheckout || process.platform !== 'win32'))('keeps in-progress %s facts when reading snapshot metadata in batches (newline checkout: %s)', async (operation, newlineCheckout) => {
        const repoRoot = await initRepoWithCommit(`git-snapshot-operation-${newlineCheckout ? '\n' : ''}`);
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await runGit(repoRoot, ['checkout', '-b', 'feature']);
        await writeFile(join(repoRoot, 'README.md'), 'feature\n');
        await runGit(repoRoot, ['commit', '-am', 'feature']);
        await runGit(repoRoot, ['checkout', 'main']);
        await writeFile(join(repoRoot, 'README.md'), 'main\n');
        await runGit(repoRoot, ['commit', '-am', 'main']);
        let checkoutRoot = repoRoot;
        if (newlineCheckout) {
            checkoutRoot = await makeTempDir('git-snapshot-operation-linked-');
            cleanups.push(() => rm(checkoutRoot, { recursive: true, force: true }));
            await runGit(repoRoot, ['worktree', 'add', '-b', 'operation', checkoutRoot]);
            expect(await runGit(checkoutRoot, ['rev-parse', '--git-path', 'MERGE_HEAD'])).toContain('\n');
        }
        if (operation === 'rebase') await runGit(checkoutRoot, ['checkout', 'feature']);
        await expect(runGit(checkoutRoot, operation === 'merge' ? ['merge', 'feature'] : ['rebase', 'main'])).rejects.toThrow();
        const response = await readSnapshot({ context: buildContext(checkoutRoot), request: { operationStateVersion: 1 } });
        expect(response).toMatchObject({ success: true, snapshot: { hasConflicts: true, operationState: {
            kind: operation, canContinue: false, canAbort: true, unresolvedCount: 1,
            conflicts: [{ path: 'README.md', kind: 'both_modified' }],
        } } });
        expect(response.snapshot?.operationState?.headOid).toBe(await runGit(checkoutRoot, ['rev-parse', 'HEAD']));
        expect(response.snapshot?.operationState?.baseOid).toBeTruthy();
        if (operation === 'rebase') expect(response.snapshot?.operationState?.replayCommit).toBeTruthy();
    });

    it.each([false, true])('requires hosting runtime services only when the repository has a remote ($0)', async (hasRemote) => {
        const repoRoot = await initRepoWithCommit('git-snap-hosting-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'README.md'), 'changed\n');
        if (hasRemote) await runGit(repoRoot, ['remote', 'add', 'origin', 'https://example.test/repo.git']);

        // Install only the real OS/Git boundary. Hosting runtime services are
        // genuinely absent; no internal registry or resolver is replaced.
        const pending = runWithGitScmCommandRunner(
            createRealGitScmBackendRuntimeServices().runCommand,
            () => getGitSnapshot({ context: buildContext(repoRoot) }),
        );
        if (hasRemote) {
            await expect(pending).rejects.toThrow(/host-injected SCM hosting provider registry/);
            return;
        }
        const response = await pending;
        expect(response).toMatchObject({
            success: true,
            snapshot: {
                entries: [{ path: 'README.md', stats: { pendingAdded: 1, pendingRemoved: 1 } }],
                totals: { pendingFiles: 1, pendingAdded: 1, pendingRemoved: 1 },
                hostingProvider: null,
                pullRequestStatus: { provider: null, headBranch: 'main', baseBranch: null, openPullRequest: null, authState: 'unsupported' },
            },
        });
    });

    it.each(['included', 'pending'] as const)('marks tracked statistics incomplete when %s numstat fails', async (area) => {
        const repoRoot = await initRepoWithCommit('git-snap-failed-stats-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'other.txt'), 'original\n');
        await runGit(repoRoot, ['add', 'other.txt']);
        await runGit(repoRoot, ['commit', '-m', 'add other']);
        await writeFile(join(repoRoot, 'README.md'), 'staged\n');
        await runGit(repoRoot, ['add', 'README.md']);
        await writeFile(join(repoRoot, 'README.md'), 'pending\n');
        await writeFile(join(repoRoot, 'new.txt'), 'new\n');
        await writeFile(join(repoRoot, 'other.txt'), 'other\n');
        if (area === 'pending') await runGit(repoRoot, ['add', 'other.txt']);
        const originalCommand = createRealGitScmBackendRuntimeServices().runCommand;
        const command = vi.fn<typeof originalCommand>((input) => {
            if (input.args.includes('--numstat') && input.args.includes('--cached') === (area === 'included')) {
                return Promise.resolve({ success: false, stdout: '', stderr: 'diff failed', exitCode: 1 });
            }
            return originalCommand(input);
        });
        const response = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(command, () => getGitSnapshot({ context: buildContext(repoRoot) })));
        expect(response.success).toBe(true);
        expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'README.md')?.stats.isComplete).toBe(false);
        expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'new.txt')?.stats.isComplete).toBeUndefined();
        expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'other.txt')?.stats.isComplete).toBeUndefined();
        expect.soft(response.snapshot?.totals.isComplete).toBe(false);
    });

    it('counts untracked text lines without inventing a trailing line or classifying skipped text as binary', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-untracked-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'one.txt'), 'hello\n');
        await writeFile(join(repoRoot, 'large.txt'), 'x'.repeat(5_000_001));
        const response = await readSnapshot({ context: buildContext(repoRoot) });
        expect(response.success).toBe(true);
        expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'one.txt')?.stats.pendingAdded).toBe(1);
        expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'large.txt')?.stats.isBinary).toBe(false);
        expect.soft(response.snapshot?.entries.find((entry) => entry.path === 'large.txt')?.stats).toMatchObject({ isComplete: false });
        expect.soft(response.snapshot?.totals).toMatchObject({ isComplete: false });
    });

    it('uses porcelain untracked paths without a second repository enumeration', async () => {
        const repoRoot = await initRepoWithCommit('git-snap-enumeration-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'new.txt'), 'hello');
        const command = vi.fn(createRealGitScmBackendRuntimeServices().runCommand);
        const response = await runWithRealGitScmRuntime(() => runWithGitScmCommandRunner(command, () => getGitSnapshot({ context: buildContext(repoRoot) })));
        expect(response.snapshot?.entries.find((entry) => entry.path === 'new.txt')?.stats.pendingAdded).toBe(1);
        expect(command.mock.calls.filter(([input]) => input.args[0] === 'ls-files')).toHaveLength(0);
    });

    it('keeps included-only diffs empty for untracked files and reads both areas in an unborn repository', async () => {
        const repoRoot = await makeTempDir('git-diff-unborn-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await runGit(repoRoot, ['init']);
        await writeFile(join(repoRoot, 'new.txt'), 'hello\n');
        const context = buildContext(repoRoot);
        expect.soft(await readFileDiff({ context, request: { path: 'new.txt', area: 'included' } })).toEqual({ success: true, diff: '' });
        expect.soft(await readFileDiff({ context, request: { path: 'new.txt', area: 'both' } })).toMatchObject({ success: true, diff: expect.stringContaining('+hello') });
        await runGit(repoRoot, ['add', 'new.txt']);
        await writeFile(join(repoRoot, 'new.txt'), 'latest\n');
        expect.soft(await readFileDiff({ context, request: { path: 'new.txt', area: 'both' } })).toMatchObject({ success: true, diff: expect.stringContaining('+latest') });
    });

    it.each(['file\tname.txt', 'file\nname.txt', 'café.txt', 'literal[1].txt'])('reads actual untracked filenames %j', async (path) => {
        if (process.platform === 'win32' && /[\t\n]/.test(path)) return;
        const repoRoot = await initRepoWithCommit('git-diff-literal-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, path), 'hello\n');
        expect(await readFileDiff({ context: buildContext(repoRoot), request: { path, area: 'pending' } })).toMatchObject({ success: true, diff: expect.stringContaining('+hello') });
    });

    it('enriches status snapshots only when includeWorktreeStatus is true', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-snap-enrich-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');
        const canonicalRoot = await realpath(repoRoot);

        const backend = createGitBackend();
        const context = buildContext(repoRoot);

        const lightResponse = await runWithRealGitScmRuntime(() => backend.statusSnapshot({
            context,
            request: {},
        }));
        expect(lightResponse.success).toBe(true);
        const lightWorktree = lightResponse.snapshot?.repo.worktrees.find((worktree) => worktree.path === canonicalRoot);
        expect(lightWorktree?.changeCount).toBeUndefined();
        expect(lightWorktree?.lastActivityAt).toBeUndefined();

        const enrichedResponse = await runWithRealGitScmRuntime(() => backend.statusSnapshot({
            context,
            request: { includeWorktreeStatus: true },
        }));
        expect(enrichedResponse.success).toBe(true);
        const enrichedWorktree = enrichedResponse.snapshot?.repo.worktrees.find((worktree) => worktree.path === canonicalRoot);
        expect(enrichedWorktree?.changeCount).toBeGreaterThanOrEqual(1);
        expect(enrichedWorktree?.lastActivityAt).toBeGreaterThan(0);
    });

    it('dedicated enrichment validates requested paths against registered realpath worktrees', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-path-enrich-');
        cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
        await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');
        const canonicalRoot = await realpath(repoRoot);
        const symlinkDir = await makeTempDir('git-plugin-path-enrich-link-');
        cleanups.push(() => rm(symlinkDir, { recursive: true, force: true }));
        const symlinkPath = join(symlinkDir, 'repo-link');
        await symlink(canonicalRoot, symlinkPath, 'dir');

        const backend = createGitBackend() as ReturnType<typeof createGitBackend> & {
            worktreesEnrichment?: (input: {
                context: ScmBackendContext;
                request: { worktreePaths: string[] };
            }) => Promise<{ success: boolean; worktrees?: Array<{ path: string; changeCount?: number; lastActivityAt?: number }> }>;
        };

        expect(typeof backend.worktreesEnrichment).toBe('function');
        if (typeof backend.worktreesEnrichment !== 'function') return;

        const response = await runWithRealGitScmRuntime(() => backend.worktreesEnrichment!({
            context: buildContext(canonicalRoot),
            request: { worktreePaths: [symlinkPath, '/etc'] },
        }));

        expect(response.success).toBe(true);
        expect(response.worktrees).toHaveLength(1);
        expect(response.worktrees?.[0]?.path).toBe(canonicalRoot);
        expect(response.worktrees?.[0]?.changeCount).toBeGreaterThanOrEqual(1);
        expect(response.worktrees?.[0]?.lastActivityAt).toBeGreaterThan(0);
    });
});

describe('Git repository detection', () => {
    it('detects a nested checkout and reads a diff using one repository probe', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-detect-once-');
        try {
            const cwd = join(repoRoot, 'nested');
            await mkdir(cwd);
            await writeFile(join(repoRoot, 'README.md'), 'changed\n', 'utf8');
            const command = vi.fn(createRealGitScmBackendRuntimeServices().runCommand);
            await runWithGitScmCommandRunner(command, async () => {
                const detection = await detectGitRepo({ cwd });
                expect(detection).toEqual({ isRepo: true, rootPath: await realpath(repoRoot), mode: '.git' });
                const response = await gitDiffFile({
                    context: { cwd, projectKey: `test:${repoRoot}`, detection },
                    request: { path: 'README.md', area: 'pending' },
                });
                expect(response).toMatchObject({ success: true, diff: expect.stringContaining('+changed') });
            });
            expect(command.mock.calls.filter(([input]) => input.args[0] === 'rev-parse'
                && input.args.some((arg) => arg === '--is-inside-work-tree' || arg === '--show-toplevel'))).toHaveLength(1);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves bare repository detection when there is no worktree root', async () => {
        const repoRoot = await makeTempDir('git-plugin-detect-bare-');
        try {
            await runGit(repoRoot, ['init', '--bare']);
            expect(await runWithRealGitScmRuntime(() => detectGitRepo({ cwd: repoRoot })))
                .toEqual({ isRepo: true, rootPath: null, mode: '.git' });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('reports a real ownership refusal as unavailable even when git itself is healthy', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-detect-ownership-');
        const realCommand = createRealGitScmBackendRuntimeServices().runCommand;
        try {
            const refusedProbe = await realCommand({
                command: 'git',
                installableKey: 'git',
                cwd: repoRoot,
                args: ['-c', 'safe.directory=', 'rev-parse', '--is-inside-work-tree'],
                env: { LC_ALL: 'C', LANGUAGE: 'C', GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' },
            });
            expect(refusedProbe).toMatchObject({ success: false, exitCode: 128 });
            expect(refusedProbe.stderr).toContain('dubious ownership');
            const detection = runWithGitScmCommandRunner(
                (input) => realCommand({
                    ...input,
                    // Git's protected safe.directory allowlist still applies to its forced-owner test flag.
                    args: ['-c', 'safe.directory=', ...input.args],
                    env: { ...input.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' },
                }),
                () => runScmRoute({
                    request: { cwd: repoRoot }, workingDirectory: repoRoot,
                    registry: createScmBackendRegistry([createGitBackend()]),
                    onNonRepository: () => ({ success: true }),
                    runWithBackend: async () => ({ success: true }),
                }),
            );
            await expect(detection).resolves.toMatchObject({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
                error: 'git_dubious_ownership',
            });
            expect(await runWithRealGitScmRuntime(() => detectGitRepo({ cwd: repoRoot }))).toMatchObject({
                isRepo: true,
                mode: '.git',
                rootPath: await realpath(repoRoot),
            });
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    // F-SCM-1. `git rev-parse --is-inside-work-tree` exits non-zero for a directory that is not a
    // repository AND for a git that cannot run at all, so the exit code alone cannot tell a real
    // negative from a broken tool. Reported live: a `git` that failed every invocation made the
    // session source-control pane say "This directory is not under source control" about a healthy
    // repository, and it stayed wrong after `git` came back.
    it('refuses to answer when git fails every invocation, instead of reporting "not a repository"', async () => {
        const detection = runWithGitScmCommandRunner(
            async () => ({
                success: false,
                stdout: '',
                stderr: 'fatal: broken git\n',
                exitCode: 128,
            }),
            () => detectGitRepo({ cwd: '/tmp/happier-scm-detect-broken-git' }),
        );

        await expect(detection).rejects.toMatchObject({
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        });
    });

    it('still reports a real non-repository as one when git itself is healthy', async () => {
        const detection = await runWithGitScmCommandRunner(
            async (input) => (
                input.args[0] === '--version'
                    ? { success: true, stdout: 'git version 2.49.0\n', stderr: '', exitCode: 0 }
                    : {
                        success: false,
                        stdout: '',
                        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
                        exitCode: 128,
                    }
            ),
            () => detectGitRepo({ cwd: '/tmp/happier-scm-detect-plain-folder' }),
        );

        expect(detection).toEqual({ isRepo: false, rootPath: null, mode: null });
    });

    it('refuses to answer when the probe is cut short even though the binary works', async () => {
        const detection = runWithGitScmCommandRunner(
            async (input) => (
                input.args[0] === '--version'
                    ? { success: true, stdout: 'git version 2.49.0\n', stderr: '', exitCode: 0 }
                    : { success: false, stdout: '', stderr: '', exitCode: -1, timedOut: true }
            ),
            () => detectGitRepo({ cwd: '/tmp/happier-scm-detect-stalled' }),
        );

        await expect(detection).rejects.toMatchObject({
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        });
    });

    it('detects a real repository against the real git binary', async () => {
        const repoRoot = await initRepoWithCommit('git-plugin-detect-real-');
        try {
            const detection = await runWithRealGitScmRuntime(() => detectGitRepo({ cwd: repoRoot }));
            expect(detection.isRepo).toBe(true);
            expect(detection.mode).toBe('.git');
            expect(detection.rootPath).toBe(await realpath(repoRoot));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
});
