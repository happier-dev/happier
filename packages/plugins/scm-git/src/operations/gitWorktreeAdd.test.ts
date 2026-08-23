import { describe, expect, it } from 'vitest';

import {
    runWithGitScmCommandRunner,
    type GitScmCommandRunner,
} from '../testkit/scmRuntime.test-support.js';
import {
    GIT_WORKTREE_NAME_ATTEMPT_LIMIT,
    buildGitWorktreeAddArgs,
    gitWorktreeNameForAttempt,
    isGitWorktreeAlreadyExistsFailure,
    runGitWorktreeAdd,
} from './gitWorktreeAdd.js';

describe('the one git worktree add owner', () => {
    it('passes the worktree path after `--` so a dash-leading name is never read as an option', () => {
        expect(buildGitWorktreeAddArgs({
            branchName: 'feature/auth',
            worktreePath: '.dev/worktree/feature/auth',
            branchMode: 'new',
            baseRef: 'abc123',
        })).toEqual([
            'worktree', 'add', '-b', 'feature/auth', '--', '.dev/worktree/feature/auth', 'abc123',
        ]);
    });

    it('creates no branch and takes no base ref when the branch already exists', () => {
        expect(buildGitWorktreeAddArgs({
            branchName: 'feature/auth',
            worktreePath: '.dev/worktree/feature/auth',
            branchMode: 'existing',
            baseRef: 'abc123',
        })).toEqual(['worktree', 'add', '--', '.dev/worktree/feature/auth', 'feature/auth']);
    });

    it('omits an absent base ref rather than passing an empty argument', () => {
        expect(buildGitWorktreeAddArgs({
            branchName: 'feature',
            worktreePath: '/repo/.dev/worktree/feature',
            branchMode: 'new',
            baseRef: null,
        })).toEqual(['worktree', 'add', '-b', 'feature', '--', '/repo/.dev/worktree/feature']);
    });

    it('runs the add from the repository root so a relative path resolves against the repository', async () => {
        const calls: unknown[] = [];
        const runner: GitScmCommandRunner = async (input) => {
            calls.push(input);
            return { success: true, stdout: '', stderr: '', exitCode: 0 };
        };

        await runWithGitScmCommandRunner(runner, async () => await runGitWorktreeAdd({
            repoRoot: '/repo',
            worktreePath: '.dev/worktree/feature',
            branchName: 'feature',
            branchMode: 'new',
            baseRef: 'abc123',
        }));

        expect(calls).toEqual([expect.objectContaining({
            command: 'git',
            cwd: '/repo',
            args: ['worktree', 'add', '-b', 'feature', '--', '.dev/worktree/feature', 'abc123'],
        })]);
    });

    it('classifies both callers` collision shapes: a raw git message and a thrown Error, in either case', () => {
        expect(isGitWorktreeAlreadyExistsFailure('fatal: \'.dev/worktree/x\' already exists')).toBe(true);
        expect(isGitWorktreeAlreadyExistsFailure(new Error("branch 'x' already exists"))).toBe(true);
        expect(isGitWorktreeAlreadyExistsFailure(new Error('Branch Already Exists'))).toBe(true);
        expect(isGitWorktreeAlreadyExistsFailure('fatal: not a git repository')).toBe(false);
        expect(isGitWorktreeAlreadyExistsFailure(undefined)).toBe(false);
        expect(isGitWorktreeAlreadyExistsFailure(null)).toBe(false);
    });

    it('names the first attempt exactly as requested and suffixes only the retries', () => {
        expect(GIT_WORKTREE_NAME_ATTEMPT_LIMIT).toBe(4);
        expect([1, 2, 3, 4].map((attempt) => gitWorktreeNameForAttempt('feature', attempt)))
            .toEqual(['feature', 'feature-2', 'feature-3', 'feature-4']);
    });
});
