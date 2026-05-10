import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { buildRepositoryCheckpointRefs } from '../checkpoints/shared.js';
import type { ScmBackendContext } from '../types.js';
import { classifyGitCheckpointCommandFailure } from './commands.js';
import { aliasGitRepositoryCheckpoint } from './alias.js';
import { captureGitRepositoryCheckpoint } from './capture.js';
import { pruneGitRepositoryCheckpointRefs } from './cleanup.js';
import { diffGitRepositoryCheckpoints } from './diff.js';

const execFile = promisify(execFileCallback);
const DAY_MS = 24 * 60 * 60 * 1000;

async function runGit(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd, env: env ? { ...process.env, ...env } : process.env });
    return stdout.trim();
}

async function configureGitRepo(cwd: string): Promise<void> {
    await runGit(cwd, ['config', 'user.email', 'test@example.com']);
    await runGit(cwd, ['config', 'user.name', 'Happier Test']);
}

async function createCommittedRepo(): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'happier-checkpoint-git-'));
    await runGit(repoRoot, ['init']);
    await configureGitRepo(repoRoot);
    await writeFile(join(repoRoot, 'tracked.txt'), 'base\n', 'utf8');
    await runGit(repoRoot, ['add', 'tracked.txt']);
    await runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function makeContext(repoRoot: string): ScmBackendContext {
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

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
    try {
        await runGit(cwd, ['rev-parse', '--verify', ref]);
        return true;
    } catch {
        return false;
    }
}

async function createCheckpointCommit(cwd: string, message: string, committedAtUnix: number): Promise<string> {
    const tree = await runGit(cwd, ['write-tree']);
    return await runGit(cwd, ['commit-tree', tree, '-m', message], {
        GIT_AUTHOR_NAME: 'Happier Checkpoint',
        GIT_AUTHOR_EMAIL: 'checkpoint@happier.dev',
        GIT_COMMITTER_NAME: 'Happier Checkpoint',
        GIT_COMMITTER_EMAIL: 'checkpoint@happier.dev',
        GIT_AUTHOR_DATE: `${committedAtUnix} +0000`,
        GIT_COMMITTER_DATE: `${committedAtUnix} +0000`,
    });
}

describe('captureGitRepositoryCheckpoint', () => {
    it('classifies missing Git and permission command failures as structured unavailable reasons', () => {
        expect(classifyGitCheckpointCommandFailure({
            success: false,
            stdout: '',
            stderr: 'spawn git ENOENT',
            exitCode: -1,
        }, 'fallback')).toMatchObject({ reason: 'missing_git' });

        expect(classifyGitCheckpointCommandFailure({
            success: false,
            stdout: '',
            stderr: 'spawn git EACCES',
            exitCode: -1,
        }, 'fallback')).toMatchObject({ reason: 'permission_denied' });
    });

    it('captures tracked and untracked worktree changes without mutating the real index', async () => {
        const repoRoot = await createCommittedRepo();

        try {
            await writeFile(join(repoRoot, 'staged.txt'), 'staged\n', 'utf8');
            await runGit(repoRoot, ['add', 'staged.txt']);
            const stagedBefore = await runGit(repoRoot, ['diff', '--cached', '--name-status', '-z']);
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed\n', 'utf8');
            await writeFile(join(repoRoot, 'untracked.txt'), 'untracked\n', 'utf8');

            const refs = buildRepositoryCheckpointRefs({ scopeId: 'session-1', turnId: 'turn-1' });
            const result = await captureGitRepositoryCheckpoint({
                context: makeContext(repoRoot),
                checkpointRef: refs.turnFinal!,
            });

            expect(result.success).toBe(true);
            if (!result.success) return;
            expect(result.receipts.map((receipt) => receipt.id)).toContain('checkpoint.captured');
            await expect(runGit(repoRoot, ['rev-parse', refs.turnFinal!.ref])).resolves.toBe(result.commitSha);
            await expect(runGit(repoRoot, ['show', `${result.commitSha}:tracked.txt`])).resolves.toBe('changed');
            await expect(runGit(repoRoot, ['show', `${result.commitSha}:untracked.txt`])).resolves.toBe('untracked');
            await expect(runGit(repoRoot, ['show', `${result.commitSha}:staged.txt`])).resolves.toBe('staged');
            await expect(runGit(repoRoot, ['diff', '--cached', '--name-status', '-z'])).resolves.toBe(stagedBefore);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('emits a finalized receipt when capturing the final turn checkpoint', async () => {
        const repoRoot = await createCommittedRepo();

        try {
            const refs = buildRepositoryCheckpointRefs({ scopeId: 'session-1', turnId: 'turn-1' });
            const result = await captureGitRepositoryCheckpoint({
                context: makeContext(repoRoot),
                checkpointRef: refs.turnFinal!,
            });

            expect(result.success).toBe(true);
            if (!result.success) return;
            expect(result.receipts.map((receipt) => receipt.id)).toEqual([
                'checkpoint.captured',
                'checkpoint.finalized',
            ]);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('captures a repository with no HEAD by seeding an empty temporary index', async () => {
        const repoRoot = await mkdtemp(join(tmpdir(), 'happier-checkpoint-no-head-'));

        try {
            await runGit(repoRoot, ['init']);
            await writeFile(join(repoRoot, 'first.txt'), 'first\n', 'utf8');

            const refs = buildRepositoryCheckpointRefs({ scopeId: 'session-1', messageId: 'message-1' });
            const result = await captureGitRepositoryCheckpoint({
                context: makeContext(repoRoot),
                checkpointRef: refs.messageStart!,
            });

            expect(result.success).toBe(true);
            if (!result.success) return;
            await expect(runGit(repoRoot, ['show', `${result.commitSha}:first.txt`])).resolves.toBe('first');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects forged checkpoint refs outside the Happier hidden namespace', async () => {
        const repoRoot = await createCommittedRepo();

        try {
            const refs = buildRepositoryCheckpointRefs({ scopeId: 'session-1', turnId: 'turn-1' });
            const forgedRef = {
                ...refs.turnFinal!,
                ref: 'refs/heads/owned-by-forged-checkpoint',
            };

            const result = await captureGitRepositoryCheckpoint({
                context: makeContext(repoRoot),
                checkpointRef: forgedRef,
            });

            expect(result.success).toBe(false);
            if (result.success) return;
            expect(result.reason).toBe('capture_failed');
            expect(result.error).toContain('outside the Happier checkpoint namespace');
            await expect(gitRefExists(repoRoot, 'refs/heads/owned-by-forged-checkpoint')).resolves.toBe(false);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
});

describe('aliasGitRepositoryCheckpoint', () => {
    it('copies a message-start ref to turn-start and emits an aliased receipt', async () => {
        const repoRoot = await createCommittedRepo();

        try {
            const refs = buildRepositoryCheckpointRefs({ scopeId: 'session-1', messageId: 'message-1', turnId: 'turn-1' });
            const captured = await captureGitRepositoryCheckpoint({
                context: makeContext(repoRoot),
                checkpointRef: refs.messageStart!,
            });
            expect(captured.success).toBe(true);
            if (!captured.success) return;

            const alias = await aliasGitRepositoryCheckpoint({
                context: makeContext(repoRoot),
                sourceRef: refs.messageStart!,
                targetRef: refs.turnStart!,
            });

            expect(alias.success).toBe(true);
            if (!alias.success) return;
            expect(alias.commitSha).toBe(captured.commitSha);
            expect(alias.receipts).toEqual([{
                id: 'checkpoint.aliased',
                ref: refs.turnStart!.ref,
                commitSha: captured.commitSha,
                phase: 'turn-start',
            }]);
            await expect(runGit(repoRoot, ['rev-parse', refs.turnStart!.ref])).resolves.toBe(captured.commitSha);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('returns unavailable when the message-start source is missing', async () => {
        const repoRoot = await createCommittedRepo();

        try {
            const refs = buildRepositoryCheckpointRefs({ scopeId: 'session-1', messageId: 'message-1', turnId: 'turn-1' });
            const alias = await aliasGitRepositoryCheckpoint({
                context: makeContext(repoRoot),
                sourceRef: refs.messageStart!,
                targetRef: refs.turnStart!,
            });

            expect(alias).toMatchObject({
                success: false,
                kind: 'unavailable',
                reason: 'missing_source',
                receipts: [],
            });
            await expect(gitRefExists(repoRoot, refs.turnStart!.ref)).resolves.toBe(false);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
});

describe('diffGitRepositoryCheckpoints', () => {
    it('diffs turn-start to turn-final without reporting pre-existing uncommitted work', async () => {
        const repoRoot = await createCommittedRepo();

        try {
            await writeFile(join(repoRoot, 'preexisting.txt'), 'preexisting\n', 'utf8');
            const refs = buildRepositoryCheckpointRefs({ scopeId: 'session-1', messageId: 'message-1', turnId: 'turn-1' });
            await captureGitRepositoryCheckpoint({ context: makeContext(repoRoot), checkpointRef: refs.messageStart! });
            const alias = await aliasGitRepositoryCheckpoint({
                context: makeContext(repoRoot),
                sourceRef: refs.messageStart!,
                targetRef: refs.turnStart!,
            });
            expect(alias.success).toBe(true);

            await writeFile(join(repoRoot, 'turn-file.txt'), 'turn\n', 'utf8');
            await captureGitRepositoryCheckpoint({ context: makeContext(repoRoot), checkpointRef: refs.turnFinal! });

            const diff = await diffGitRepositoryCheckpoints({
                context: makeContext(repoRoot),
                baseRef: refs.turnStart!,
                finalRef: refs.turnFinal!,
                baseRefSource: 'turn_start',
                attributionScope: 'unknown',
            });

            expect(diff.success).toBe(true);
            if (!diff.success) return;
            expect(diff.files.map((file) => file.filePath)).toEqual(['turn-file.txt']);
            expect(diff.files[0]).toMatchObject({
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'scm:git',
            });
            expect(diff.receipts.map((receipt) => receipt.id)).toEqual(['checkpoint.diff_computed']);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('maps add modify delete rename and binary checkpoint changes', async () => {
        const repoRoot = await createCommittedRepo();

        try {
            await writeFile(join(repoRoot, 'delete-me.txt'), 'delete\n', 'utf8');
            await writeFile(join(repoRoot, 'rename-me.txt'), 'rename\n', 'utf8');
            await writeFile(join(repoRoot, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
            await runGit(repoRoot, ['add', '.']);
            await runGit(repoRoot, ['commit', '-m', 'fixtures']);

            const refs = buildRepositoryCheckpointRefs({ scopeId: 'session-1', messageId: 'message-1', turnId: 'turn-1' });
            await captureGitRepositoryCheckpoint({ context: makeContext(repoRoot), checkpointRef: refs.messageStart! });
            await aliasGitRepositoryCheckpoint({
                context: makeContext(repoRoot),
                sourceRef: refs.messageStart!,
                targetRef: refs.turnStart!,
            });

            await writeFile(join(repoRoot, 'added.txt'), 'added\n', 'utf8');
            await writeFile(join(repoRoot, 'tracked.txt'), 'modified\n', 'utf8');
            await rm(join(repoRoot, 'delete-me.txt'));
            await runGit(repoRoot, ['mv', 'rename-me.txt', 'renamed.txt']);
            await writeFile(join(repoRoot, 'binary.bin'), Buffer.from([0, 1, 2, 3, 4]));
            await captureGitRepositoryCheckpoint({ context: makeContext(repoRoot), checkpointRef: refs.turnFinal! });

            const diff = await diffGitRepositoryCheckpoints({
                context: makeContext(repoRoot),
                baseRef: refs.turnStart!,
                finalRef: refs.turnFinal!,
                baseRefSource: 'turn_start',
                attributionScope: 'exclusive_worktree',
            });

            expect(diff.success).toBe(true);
            if (!diff.success) return;
            expect(diff.files).toEqual(expect.arrayContaining([
                expect.objectContaining({ filePath: 'added.txt', changeKind: 'added' }),
                expect.objectContaining({ filePath: 'tracked.txt', changeKind: 'modified' }),
                expect.objectContaining({ filePath: 'delete-me.txt', changeKind: 'deleted' }),
                expect.objectContaining({ filePath: 'renamed.txt', previousFilePath: 'rename-me.txt', changeKind: 'renamed' }),
                expect.objectContaining({ filePath: 'binary.bin', changeKind: 'modified', binary: true }),
            ]));
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
});

describe('pruneGitRepositoryCheckpointRefs', () => {
    it('deletes only old refs inside the requested Happier checkpoint namespace', async () => {
        const repoRoot = await createCommittedRepo();

        try {
            const nowMs = Date.UTC(2026, 4, 4);
            const oldUnix = Math.floor((nowMs - (31 * DAY_MS)) / 1000);
            const oldCommit = await createCheckpointCommit(repoRoot, 'old checkpoint', oldUnix);
            const targetRefs = buildRepositoryCheckpointRefs({ scopeId: 'session-cleanup', turnId: 'old' });
            const otherScopeRefs = buildRepositoryCheckpointRefs({ scopeId: 'other-session', turnId: 'old' });
            await runGit(repoRoot, ['update-ref', targetRefs.turnFinal!.ref, oldCommit]);
            await runGit(repoRoot, ['update-ref', otherScopeRefs.turnFinal!.ref, oldCommit]);
            await runGit(repoRoot, ['branch', 'user-branch', oldCommit]);

            const result = await pruneGitRepositoryCheckpointRefs({
                context: makeContext(repoRoot),
                scopeId: 'session-cleanup',
                nowMs,
                maxAgeMs: 30 * DAY_MS,
                maxFinalizedTurns: 100,
            });

            expect(result.success).toBe(true);
            if (!result.success) return;
            expect(result.prunedCount).toBe(1);
            await expect(gitRefExists(repoRoot, targetRefs.turnFinal!.ref)).resolves.toBe(false);
            await expect(gitRefExists(repoRoot, otherScopeRefs.turnFinal!.ref)).resolves.toBe(true);
            await expect(gitRefExists(repoRoot, 'refs/heads/user-branch')).resolves.toBe(true);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
});
