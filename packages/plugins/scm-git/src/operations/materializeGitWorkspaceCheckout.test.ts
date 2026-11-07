import { execFile as execFileCallback } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { buildWorktreeRelativePath, normalizeWorktreeDisplayName } from '@happier-dev/plugin-sdk/scm';

import { inspectGitCheckoutIdentity } from '../checkoutIdentity.js';
import {
    createRealGitScmBackendRuntimeServices,
    runWithGitScmCommandRunner,
    runWithRealGitScmRuntime,
} from '../testkit/scmRuntime.test-support.js';
import {
    createGitWorkspaceCheckoutAtDefaultPath,
    materializeGitWorkspaceCheckoutAtPath,
    prepareGitReviewWorkspace,
} from './materializeGitWorkspaceCheckout.js';

const execFile = promisify(execFileCallback);

async function makeTempDir(prefix: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), prefix));
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd });
    return stdout.trim();
}

async function configureGitRepo(cwd: string): Promise<void> {
    await runGit(cwd, ['config', 'user.email', 'test@example.com']);
    await runGit(cwd, ['config', 'user.name', 'Happier Test']);
}

async function writeTrackedFile(cwd: string, relativePath: string, contents: string): Promise<void> {
    await writeFile(join(cwd, relativePath), contents, 'utf8');
    await runGit(cwd, ['add', relativePath]);
}

describe('materializeGitWorkspaceCheckout', { timeout: 20_000 }, () => {
    it('admits only the first fetch URL when another configured URL names the approved base repository', async () => {
        const root = await makeTempDir('git-source-fetch-multiple-urls-');
        const repoRoot = join(root, 'source');
        const base = join(root, 'base.git');
        const fork = join(root, 'fork.git');
        try {
            await mkdir(repoRoot);
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await writeTrackedFile(repoRoot, 'compose.yaml', 'approved H');
            await runGit(repoRoot, ['commit', '-m', 'H']);
            const approved = await runGit(repoRoot, ['rev-parse', 'HEAD']);
            await writeTrackedFile(repoRoot, 'compose.yaml', 'base B');
            await runGit(repoRoot, ['commit', '-m', 'B']);
            const advancedBase = await runGit(repoRoot, ['rev-parse', 'HEAD']);
            await runGit(repoRoot, ['init', '--bare', base]);
            await runGit(repoRoot, ['init', '--bare', fork]);
            await runGit(repoRoot, ['push', base, `${advancedBase}:refs/pull/7/head`]);
            await runGit(repoRoot, ['push', fork, `${approved}:refs/pull/7/head`]);
            const baseUrl = 'https://github.example.test/base/project.git';
            const forkUrl = 'https://github.example.test/fork/project.git';
            await runGit(repoRoot, ['config', `url.${pathToFileURL(base).href}.insteadOf`, baseUrl]);
            await runGit(repoRoot, ['config', `url.${pathToFileURL(fork).href}.insteadOf`, forkUrl]);
            await runGit(repoRoot, ['remote', 'add', 'origin', forkUrl]);
            await runGit(repoRoot, ['remote', 'set-url', '--add', 'origin', baseUrl]);
            await expect(runWithRealGitScmRuntime(() => prepareGitReviewWorkspace({ repoRoot,
                sourceTip: { repository: { kind: 'github', deployment: 'https://github.example.test', repository: 'base/project' },
                    cloneUrl: baseUrl, branch: 'approved-preview', sourceHeadSha: approved, fetchRef: 'refs/pull/7/head' },
            }))).rejects.toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND });
            await runGit(repoRoot, ['config', '--unset-all', 'remote.origin.url']);
            await runGit(repoRoot, ['config', '--add', 'remote.origin.url', baseUrl]);
            const runtime = createRealGitScmBackendRuntimeServices();
            let interleaved = false;
            await expect(runWithGitScmCommandRunner(async input => {
                const result = await runtime.runCommand(input);
                if (input.args[0] === 'fetch' && !interleaved) {
                    interleaved = true;
                    // A separate real fetch overwrites shared FETCH_HEAD with H
                    // while this invocation must still refuse the base's B.
                    await runGit(repoRoot, ['fetch', fork, 'refs/pull/7/head']);
                }
                return result;
            }, () => prepareGitReviewWorkspace({ repoRoot,
                sourceTip: { repository: { kind: 'github', deployment: 'https://github.example.test', repository: 'base/project' },
                    cloneUrl: baseUrl, branch: 'approved-preview', sourceHeadSha: approved, fetchRef: 'refs/pull/7/head' },
            }))).rejects.toMatchObject({ code: 'approval_stale' });
            expect(interleaved).toBe(true);
            expect(await runGit(repoRoot, ['rev-parse', 'HEAD'])).toBe(advancedBase);
            expect(await runGit(repoRoot, ['for-each-ref', '--format=%(refname)', 'refs/happier/source-fetch'])).toBe('');
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it.each(['refs/remotes/origin', 'refs/company'])('materializes an existing branch fetched only into %s', async (destination) => {
        const root = await makeTempDir('git-materialize-remote-tracking-');
        const repoRoot = join(root, 'source');
        const targetPath = join(root, 'worktrees', 'feature');
        try {
            await mkdir(repoRoot);
            await runGit(repoRoot, ['init', '-b', 'main']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['commit', '--allow-empty', '-m', 'initial']);
            await runGit(repoRoot, ['remote', 'add', 'origin', repoRoot]);
            await runGit(repoRoot, ['config', 'remote.origin.fetch', `+refs/heads/*:${destination}/*`]);
            await runGit(repoRoot, ['update-ref', 'refs/heads/feature', 'HEAD']);
            await runGit(repoRoot, ['fetch', 'origin']);
            await runGit(repoRoot, ['update-ref', '-d', 'refs/heads/feature']);
            await expect(runGit(repoRoot, ['show-ref', '--verify', 'refs/heads/feature'])).rejects.toThrow();

            const runtime = createRealGitScmBackendRuntimeServices();
            let fetchConfigReads = 0;
            const result = await runWithGitScmCommandRunner(async (input) => {
                if (input.args[0] === 'config') fetchConfigReads += 1;
                return await runtime.runCommand(input);
            }, () => materializeGitWorkspaceCheckoutAtPath({
                repoRoot, targetPath, displayName: 'feature', baseRef: null, branchMode: 'existing',
            }));

            expect(result).toMatchObject({ branchName: 'feature', reused: false });
            expect(await realpath(result.targetPath)).toBe(await realpath(targetPath));
            await expect(runGit(targetPath, ['branch', '--show-current'])).resolves.toBe('feature');
            await expect(runGit(targetPath, ['rev-parse', '--symbolic-full-name', '@{upstream}'])).resolves.toBe(`${destination}/feature`);
            await expect(runGit(targetPath, ['rev-parse', 'HEAD'])).resolves.toBe(await runGit(repoRoot, ['rev-parse', `${destination}/feature`]));
            await expect(runGit(repoRoot, ['branch', '--show-current'])).resolves.toBe('main');
            // Extra config discovery belongs only to the nonstandard-namespace miss.
            expect(fetchConfigReads).toBe(destination === 'refs/company' ? 1 : 0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('refuses a tag shadowing a remote-only branch before effects but admits the exact local branch', async () => {
        const root = await makeTempDir('git-materialize-tag-shadow-');
        const repoRoot = join(root, 'source');
        const targetPath = join(root, 'worktrees', 'feature');
        const populatedTarget = join(root, 'populated');
        try {
            await mkdir(repoRoot);
            await runGit(repoRoot, ['init', '-b', 'main']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['commit', '--allow-empty', '-m', 'tag tip']);
            await runGit(repoRoot, ['tag', 'feature']);
            await runGit(repoRoot, ['commit', '--allow-empty', '-m', 'remote tip']);
            const remoteHead = await runGit(repoRoot, ['rev-parse', 'HEAD']);
            await runGit(repoRoot, ['remote', 'add', 'origin', repoRoot]);
            await runGit(repoRoot, ['update-ref', 'refs/remotes/origin/feature', remoteHead]);
            const worktreesBefore = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
            await mkdir(populatedTarget);
            await writeFile(join(populatedTarget, 'keep.txt'), 'preserved\n');

            for (const path of [targetPath, populatedTarget]) {
                await expect(runWithRealGitScmRuntime(() => materializeGitWorkspaceCheckoutAtPath({
                    repoRoot, targetPath: path, displayName: 'feature', baseRef: null, branchMode: 'existing',
                }))).rejects.toMatchObject({ code: 'ref_unavailable' });
            }
            await expect(access(join(root, 'worktrees'))).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(access(`${populatedTarget}.happier-materialize-tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(readFile(join(populatedTarget, 'keep.txt'), 'utf8')).resolves.toBe('preserved\n');
            await expect(runGit(repoRoot, ['worktree', 'list', '--porcelain'])).resolves.toBe(worktreesBefore);
            await expect(runGit(repoRoot, ['show-ref', '--verify', 'refs/heads/feature'])).rejects.toThrow();

            // An exact local branch takes precedence over its same-named tag in Git.
            await runGit(repoRoot, ['update-ref', 'refs/heads/feature', remoteHead]);
            const result = await runWithRealGitScmRuntime(() => materializeGitWorkspaceCheckoutAtPath({
                repoRoot, targetPath, displayName: 'feature', baseRef: null, branchMode: 'existing',
            }));
            expect(result).toMatchObject({ branchName: 'feature', reused: false });
            await expect(runGit(targetPath, ['branch', '--show-current'])).resolves.toBe('feature');
            await expect(runGit(targetPath, ['rev-parse', 'HEAD'])).resolves.toBe(remoteHead);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('refuses missing branches even with a configured remote before creating the target parent', async () => {
        const root = await makeTempDir('git-materialize-unavailable-remote-');
        const repoRoot = join(root, 'source');
        try {
            await mkdir(repoRoot);
            await runGit(repoRoot, ['init', '-b', 'main']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['commit', '--allow-empty', '-m', 'initial']);
            await runGit(repoRoot, ['remote', 'add', 'origin', repoRoot]);
            for (const displayName of ['feature', 'unconfigured/absent']) {
                const targetPath = join(root, displayName, 'checkout');
                await expect(runWithRealGitScmRuntime(() => materializeGitWorkspaceCheckoutAtPath({
                    repoRoot, targetPath, displayName, baseRef: null, branchMode: 'existing',
                }))).rejects.toMatchObject({ code: 'ref_unavailable' });
                await expect(access(join(root, displayName))).rejects.toMatchObject({ code: 'ENOENT' });
            }
            expect((await runGit(repoRoot, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('leaves ambiguous remote branches to native worktree add', async () => {
        const root = await makeTempDir('git-materialize-ambiguous-remote-');
        const repoRoot = join(root, 'source');
        const targetPath = join(root, 'worktrees', 'feature');
        try {
            await mkdir(repoRoot);
            await runGit(repoRoot, ['init', '-b', 'main']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['commit', '--allow-empty', '-m', 'initial']);
            for (const remote of ['origin', 'upstream']) {
                await runGit(repoRoot, ['remote', 'add', remote, repoRoot]);
                await runGit(repoRoot, ['update-ref', `refs/remotes/${remote}/feature`, 'HEAD']);
            }

            await expect(runWithRealGitScmRuntime(() => materializeGitWorkspaceCheckoutAtPath({
                repoRoot, targetPath, displayName: 'feature', baseRef: null, branchMode: 'existing',
            }))).rejects.not.toMatchObject({ code: 'ref_unavailable' });
            await expect(access(join(root, 'worktrees'))).resolves.toBeUndefined();
            await expect(access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('classifies a selected root without the provider-authorized source remote as a remote mismatch', async () => {
        const selectedRoot = await makeTempDir('git-review-workspace-remote-mismatch-');

        try {
            await runGit(selectedRoot, ['init']);
            await configureGitRepo(selectedRoot);
            await runGit(selectedRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(selectedRoot, 'README.md', 'main\n');
            await runGit(selectedRoot, ['commit', '-m', 'initial']);
            await runGit(selectedRoot, ['remote', 'add', 'origin', 'https://forge.example/target/repository.git']);

            await expect(runWithRealGitScmRuntime(() => prepareGitReviewWorkspace({
                repoRoot: selectedRoot,
                sourceTip: {
                    repository: {
                        kind: 'github',
                        deployment: 'https://forge.example',
                        repository: 'contributor/repository',
                    },
                    cloneUrl: 'https://forge.example/contributor/repository.git',
                    branch: 'feature/auth',
                    sourceHeadSha: '0123456789abcdef0123456789abcdef01234567',
                    fetchRef: 'refs/heads/feature/auth',
                },
            }))).rejects.toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND });
        } finally {
            await rm(selectedRoot, { recursive: true, force: true });
        }
    });

    it('never matches a configured remote whose deployment port differs from the authorized clone URL', async () => {
        const selectedRoot = await makeTempDir('git-review-workspace-port-mismatch-');

        try {
            await runGit(selectedRoot, ['init']);
            await configureGitRepo(selectedRoot);
            await runGit(selectedRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(selectedRoot, 'README.md', 'main\n');
            await runGit(selectedRoot, ['commit', '-m', 'initial']);
            await runGit(selectedRoot, [
                'remote', 'add', 'origin', 'https://gitlab.example.test:8443/team/repository.git',
            ]);

            await expect(runWithRealGitScmRuntime(() => prepareGitReviewWorkspace({
                repoRoot: selectedRoot,
                sourceTip: {
                    repository: {
                        kind: 'gitlab',
                        deployment: 'https://gitlab.example.test:9443',
                        repository: 'team/repository',
                    },
                    // Same host and same path — only the deployment port differs, and two ports
                    // on one host are two deployments.
                    cloneUrl: 'https://gitlab.example.test:9443/team/repository.git',
                    branch: 'feature/auth',
                    sourceHeadSha: '0123456789abcdef0123456789abcdef01234567',
                    fetchRef: 'refs/heads/feature/auth',
                },
            }))).rejects.toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND });
        } finally {
            await rm(selectedRoot, { recursive: true, force: true });
        }
    });

    it('materializes from a self-managed remote whose custom port matches the authorized clone URL', async () => {
        const remoteRoot = await makeTempDir('git-review-workspace-ported-remote-');
        const authorRoot = await makeTempDir('git-review-workspace-ported-author-');
        const selectedRoot = await makeTempDir('git-review-workspace-ported-selected-');
        const sourceUrl = 'https://gitlab.example.test:8443/gitlab/team/repository.git';

        try {
            await runGit(remoteRoot, ['init', '--bare']);
            await runGit(authorRoot, ['init']);
            await configureGitRepo(authorRoot);
            await runGit(authorRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(authorRoot, 'README.md', 'main\n');
            await runGit(authorRoot, ['commit', '-m', 'initial']);
            await runGit(authorRoot, ['remote', 'add', 'origin', remoteRoot]);
            await runGit(authorRoot, ['push', 'origin', 'main']);
            await runGit(authorRoot, ['switch', '-c', 'feature/auth']);
            await writeTrackedFile(authorRoot, 'feature.txt', 'feature\n');
            await runGit(authorRoot, ['commit', '-m', 'feature']);
            const sourceHeadSha = await runGit(authorRoot, ['rev-parse', 'HEAD']);
            await runGit(authorRoot, ['push', 'origin', 'feature/auth']);

            await runGit(selectedRoot, ['init']);
            await configureGitRepo(selectedRoot);
            await runGit(selectedRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(selectedRoot, 'README.md', 'main\n');
            await runGit(selectedRoot, ['commit', '-m', 'selected-initial']);
            await runGit(selectedRoot, ['remote', 'add', 'origin', sourceUrl]);
            await runGit(selectedRoot, ['config', `url.file://${remoteRoot}.insteadOf`, sourceUrl]);

            const prepared = await runWithRealGitScmRuntime(() => prepareGitReviewWorkspace({
                repoRoot: selectedRoot,
                sourceTip: {
                    repository: {
                        kind: 'gitlab',
                        deployment: 'https://gitlab.example.test:8443/gitlab',
                        repository: 'team/repository',
                    },
                    cloneUrl: sourceUrl,
                    branch: 'feature/auth',
                    sourceHeadSha,
                    fetchRef: 'refs/heads/feature/auth',
                },
            }));

            expect(prepared).toMatchObject({
                branchName: 'feature/auth',
                created: true,
                currentness: { kind: 'currentAtObservedHead' },
            });
            await expect(runGit(prepared.targetPath, ['rev-parse', 'HEAD'])).resolves.toBe(sourceHeadSha);
        } finally {
            await rm(remoteRoot, { recursive: true, force: true });
            await rm(authorRoot, { recursive: true, force: true });
            await rm(selectedRoot, { recursive: true, force: true });
        }
    });

    it('fetches the provider-authorized source tip into a linked worktree without switching the selected root', async () => {
        const remoteRoot = await makeTempDir('git-review-workspace-remote-');
        const authorRoot = await makeTempDir('git-review-workspace-author-');
        const selectedRoot = await makeTempDir('git-review-workspace-selected-');
        const sourceUrl = 'https://forge.example/contributor/repository.git';

        try {
            await runGit(remoteRoot, ['init', '--bare']);
            await runGit(authorRoot, ['init']);
            await configureGitRepo(authorRoot);
            await runGit(authorRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(authorRoot, 'README.md', 'main\n');
            await runGit(authorRoot, ['commit', '-m', 'initial']);
            await runGit(authorRoot, ['remote', 'add', 'origin', remoteRoot]);
            await runGit(authorRoot, ['push', 'origin', 'main']);
            await runGit(authorRoot, ['switch', '-c', 'feature/auth']);
            await writeTrackedFile(authorRoot, 'feature.txt', 'feature\n');
            await runGit(authorRoot, ['commit', '-m', 'feature']);
            const sourceHeadSha = await runGit(authorRoot, ['rev-parse', 'HEAD']);
            await runGit(authorRoot, ['push', 'origin', 'feature/auth']);

            await runGit(selectedRoot, ['init']);
            await configureGitRepo(selectedRoot);
            await runGit(selectedRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(selectedRoot, 'README.md', 'main\n');
            await runGit(selectedRoot, ['commit', '-m', 'selected-initial']);
            const selectedHeadBefore = await runGit(selectedRoot, ['rev-parse', 'HEAD']);
            await runGit(selectedRoot, ['remote', 'add', 'fork', sourceUrl]);
            await runGit(selectedRoot, ['config', `url.file://${remoteRoot}.insteadOf`, sourceUrl]);

            const prepared = await runWithRealGitScmRuntime(() => prepareGitReviewWorkspace({
                repoRoot: selectedRoot,
                sourceTip: {
                    repository: {
                        kind: 'github',
                        deployment: 'https://forge.example',
                        repository: 'contributor/repository',
                    },
                    cloneUrl: sourceUrl,
                    branch: 'feature/auth',
                    sourceHeadSha,
                    fetchRef: 'refs/heads/feature/auth',
                },
            }));

            expect(prepared).toMatchObject({
                branchName: 'feature/auth',
                created: true,
                currentness: { kind: 'currentAtObservedHead' },
            });
            expect(await realpath(prepared.targetPath)).not.toBe(await realpath(selectedRoot));
            await expect(runGit(prepared.targetPath, ['rev-parse', 'HEAD'])).resolves.toBe(sourceHeadSha);
            await expect(runGit(selectedRoot, ['rev-parse', 'HEAD'])).resolves.toBe(selectedHeadBefore);
            await expect(runGit(selectedRoot, ['branch', '--show-current'])).resolves.toBe('main');
        } finally {
            await rm(remoteRoot, { recursive: true, force: true });
            await rm(authorRoot, { recursive: true, force: true });
            await rm(selectedRoot, { recursive: true, force: true });
        }
    });

    it('rejects forbidden names and materializes the same nested target predicted by the UI policy', async () => {
        const repoRoot = await makeTempDir('git-materialize-forbidden-name-repo-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            await expect(runWithRealGitScmRuntime(() => createGitWorkspaceCheckoutAtDefaultPath({
                repoRoot,
                displayName: 'feature/@',
                baseRef: 'main',
                branchMode: 'new',
            }))).rejects.toThrow('Invalid Git worktree name');
            await expect(runWithRealGitScmRuntime(() => createGitWorkspaceCheckoutAtDefaultPath({
                repoRoot,
                displayName: 'feature.lock',
                baseRef: 'main',
                branchMode: 'new',
            }))).rejects.toThrow('Invalid Git worktree name');
            await expect(runGit(repoRoot, ['worktree', 'list', '--porcelain'])).resolves.not.toContain('.dev/worktree');

            const displayName = ' feature\\ auth..fix / nested ';
            const previewName = normalizeWorktreeDisplayName(displayName);
            const previewPath = join(repoRoot, ...buildWorktreeRelativePath(previewName).split('/'));
            const checkout = await runWithRealGitScmRuntime(() => createGitWorkspaceCheckoutAtDefaultPath({
                repoRoot,
                displayName,
                baseRef: 'main',
                branchMode: 'new',
            }));
            expect(await realpath(checkout.targetPath)).toBe(await realpath(previewPath));
            expect(checkout.branchName).toBe('feature/auth-fix/nested');
            await expect(runGit(previewPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe(checkout.branchName);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('registers a linked worktree into a pre-populated target path without replacing imported files', async () => {
        const repoRoot = await makeTempDir('git-materialize-populated-repo-');
        const targetRoot = join(repoRoot, '.worktrees', 'feature-auth');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            await mkdir(targetRoot, { recursive: true });
            await writeFile(join(targetRoot, 'README.md'), 'imported\n', 'utf8');
            await writeFile(join(targetRoot, 'notes.txt'), 'transferred\n', 'utf8');

            const materializedCheckout = await runWithRealGitScmRuntime(() => materializeGitWorkspaceCheckoutAtPath({
                repoRoot,
                targetPath: targetRoot,
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
            }));

            expect(materializedCheckout).toEqual({
                targetPath: targetRoot,
                branchName: 'feature-auth',
                reused: false,
            });
            await expect(runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).resolves.toBe('feature-auth');
            await expect(runGit(targetRoot, ['rev-parse', '--git-common-dir'])).resolves.toBe(await realpath(join(repoRoot, '.git')));
            await expect(readFile(join(targetRoot, 'README.md'), 'utf8')).resolves.toBe('imported\n');
            await expect(readFile(join(targetRoot, 'notes.txt'), 'utf8')).resolves.toBe('transferred\n');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('reuses a restored matching linked worktree at the default git-owned path instead of creating a suffixed checkout', async () => {
        const repoRoot = await makeTempDir('git-materialize-create-restored-repo-');
        const originalWorktreeRoot = await makeTempDir('git-materialize-create-restored-original-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature/auth']);
            await runGit(repoRoot, ['worktree', 'add', originalWorktreeRoot, 'feature/auth']);

            const restoredRoot = join(repoRoot, '.dev', 'worktree', 'feature', 'auth');
            await mkdir(join(repoRoot, '.dev', 'worktree', 'feature'), { recursive: true });
            await cp(originalWorktreeRoot, restoredRoot, { recursive: true });

            const createdCheckout = await runWithRealGitScmRuntime(() => createGitWorkspaceCheckoutAtDefaultPath({
                repoRoot,
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'new',
            }));
            const restoredIdentity = await runWithRealGitScmRuntime(() => inspectGitCheckoutIdentity({ cwd: restoredRoot }));

            expect(createdCheckout).toEqual({
                targetPath: restoredIdentity?.registeredWorktreePath,
                branchName: 'feature/auth',
                reused: true,
            });
            expect(restoredIdentity).toEqual(expect.objectContaining({
                branchName: 'feature/auth',
                registeredWorktreePath: createdCheckout.targetPath,
            }));
            await expect(runGit(repoRoot, ['worktree', 'list', '--porcelain'])).resolves.not.toContain(
                `worktree ${join(repoRoot, '.dev', 'worktree', 'feature', 'auth-2')}`,
            );
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(originalWorktreeRoot, { recursive: true, force: true });
        }
    });

    it('rejoins one matching default-path worktree when identical creation requests race', async () => {
        const repoRoot = await makeTempDir('git-materialize-concurrent-rejoin-repo-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);

            const [first, second] = await runWithRealGitScmRuntime(async () => await Promise.all([
                createGitWorkspaceCheckoutAtDefaultPath({
                    repoRoot, displayName: 'workflow-run-1-root-1', baseRef: 'HEAD', branchMode: 'new',
                }),
                createGitWorkspaceCheckoutAtDefaultPath({
                    repoRoot, displayName: 'workflow-run-1-root-1', baseRef: 'HEAD', branchMode: 'new',
                }),
            ]));

            expect(await realpath(second.targetPath)).toBe(await realpath(first.targetPath));
            expect(second.branchName).toBe(first.branchName);
            expect([first.reused, second.reused].sort()).toEqual([false, true]);
            await expect(runGit(repoRoot, ['branch', '--list', 'workflow-run-1-root-1-2'])).resolves.toBe('');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('reuses the worktree that already holds an existing branch at a non-default path', async () => {
        const repoRoot = await makeTempDir('git-materialize-existing-branch-repo-');
        const existingWorktreeRoot = await makeTempDir('git-materialize-existing-branch-worktree-');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature/auth']);
            await runGit(repoRoot, ['worktree', 'add', existingWorktreeRoot, 'feature/auth']);

            const materialized = await runWithRealGitScmRuntime(() => createGitWorkspaceCheckoutAtDefaultPath({
                repoRoot,
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'existing',
            }));

            expect(await realpath(materialized.targetPath)).toBe(await realpath(existingWorktreeRoot));
            expect(materialized).toMatchObject({
                branchName: 'feature/auth',
                reused: true,
            });
            await expect(runGit(repoRoot, ['branch', '--list', 'feature/auth-2']))
                .resolves.toBe('');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(existingWorktreeRoot, { recursive: true, force: true });
        }
    });

    it('returns the rebound registered worktree path when explicit materialization repairs a restored checkout', async () => {
        const repoRoot = await makeTempDir('git-materialize-realize-restored-repo-');
        const originalWorktreeRoot = await makeTempDir('git-materialize-realize-restored-original-');
        const restoredRoot = join(repoRoot, '.worktrees', 'feature-auth');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature-auth']);
            await runGit(repoRoot, ['worktree', 'add', originalWorktreeRoot, 'feature-auth']);

            await mkdir(join(repoRoot, '.worktrees'), { recursive: true });
            await cp(originalWorktreeRoot, restoredRoot, { recursive: true });

            const materializedCheckout = await runWithRealGitScmRuntime(() => materializeGitWorkspaceCheckoutAtPath({
                repoRoot,
                targetPath: restoredRoot,
                displayName: 'feature-auth',
                baseRef: 'main',
                branchMode: 'new',
            }));
            const restoredIdentity = await runWithRealGitScmRuntime(() => inspectGitCheckoutIdentity({ cwd: restoredRoot }));

            expect(materializedCheckout).toEqual({
                targetPath: restoredIdentity?.registeredWorktreePath,
                branchName: 'feature-auth',
                reused: true,
            });
            expect(restoredIdentity).toEqual(expect.objectContaining({
                branchName: 'feature-auth',
                registeredWorktreePath: materializedCheckout.targetPath,
            }));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(originalWorktreeRoot, { recursive: true, force: true });
        }
    });

    it('restores an existing branch at its exact path when Git still has a stale linked-worktree registration', async () => {
        const repoRoot = await makeTempDir('git-materialize-stale-registration-repo-');
        const targetRoot = join(repoRoot, '.worktrees', 'feature-auth');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['branch', 'feature-auth']);
            await runGit(repoRoot, ['worktree', 'add', targetRoot, 'feature-auth']);
            await rm(targetRoot, { recursive: true, force: true });

            const staleRegistration = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
            expect(staleRegistration).toContain('branch refs/heads/feature-auth');
            expect(staleRegistration).toContain('prunable gitdir file points to non-existent location');

            const materialized = await runWithRealGitScmRuntime(() => materializeGitWorkspaceCheckoutAtPath({
                repoRoot,
                targetPath: targetRoot,
                displayName: 'feature-auth',
                baseRef: null,
                branchMode: 'existing',
            }));
            const identity = await runWithRealGitScmRuntime(() => inspectGitCheckoutIdentity({ cwd: targetRoot }));

            expect(materialized).toEqual({
                targetPath: await realpath(targetRoot),
                branchName: 'feature-auth',
                reused: false,
            });
            expect(identity).toEqual(expect.objectContaining({
                branchName: 'feature-auth',
                registeredWorktreePath: await realpath(targetRoot),
            }));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('creates a new branch at a path whose earlier linked worktree was deleted by hand', async () => {
        const repoRoot = await makeTempDir('git-materialize-stale-path-repo-');
        const targetRoot = join(await makeTempDir('git-materialize-stale-path-target-'), 'prepared');

        try {
            await runGit(repoRoot, ['init']);
            await configureGitRepo(repoRoot);
            await runGit(repoRoot, ['branch', '-M', 'main']);
            await writeTrackedFile(repoRoot, 'README.md', 'main\n');
            await runGit(repoRoot, ['commit', '-m', 'initial']);
            await runGit(repoRoot, ['worktree', 'add', '-b', 'earlier-prepare', targetRoot]);
            await rm(targetRoot, { recursive: true, force: true });
            expect(await runGit(repoRoot, ['worktree', 'list', '--porcelain']))
                .toContain('prunable gitdir file points to non-existent location');

            const materialized = await runWithRealGitScmRuntime(() => materializeGitWorkspaceCheckoutAtPath({
                repoRoot,
                targetPath: targetRoot,
                displayName: 'next-prepare',
                baseRef: null,
                branchMode: 'new',
            }));
            const identity = await runWithRealGitScmRuntime(() => inspectGitCheckoutIdentity({ cwd: targetRoot }));

            expect(materialized).toMatchObject({ branchName: 'next-prepare', reused: false });
            expect(identity).toEqual(expect.objectContaining({
                branchName: 'next-prepare',
                registeredWorktreePath: await realpath(targetRoot),
            }));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(join(targetRoot, '..'), { recursive: true, force: true });
        }
    });
});
