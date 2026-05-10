import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { buildRepositoryCheckpointRefs } from '../shared.js';
import { captureGitRepositoryCheckpoint } from '../capture.js';
import { applyGitCheckpointReversePatch } from './applyReversePatch.js';
import { createGitRollbackBackup } from './createRollbackBackup.js';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd });
    return stdout.trim();
}

async function createRepo(): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'happier-checkpoint-rollback-'));
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await runGit(repoRoot, ['config', 'user.name', 'Happier Test']);
    await writeFile(join(repoRoot, 'tracked.txt'), 'base\n', 'utf8');
    await runGit(repoRoot, ['add', 'tracked.txt']);
    await runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function makeContext(repoRoot: string) {
    return {
        cwd: repoRoot,
        projectKey: `test:${repoRoot}`,
        detection: { isRepo: true, rootPath: repoRoot, mode: '.git' as const },
    };
}

function checkpointScopeId(sessionId: string, repoRoot: string): string {
    return `${sessionId}:${repoRoot}`;
}

function makeRollbackRequest(input: Readonly<{
    sessionId?: string;
    turnId?: string;
    cwd: string;
    expectedStartRef: string;
    expectedFinalRef: string;
}>) {
    return {
        v: 1,
        sessionId: input.sessionId ?? 'session-1',
        turnId: input.turnId ?? 'turn-1',
        cwd: input.cwd,
        codeMode: 'conversation_and_code_without_stash',
        backupMode: 'happier_checkpoint_only',
        expectedStartRef: input.expectedStartRef,
        expectedFinalRef: input.expectedFinalRef,
    } as const;
}

describe('applyGitCheckpointReversePatch', () => {
    it('applies a simple modified-file rollback after a backup checkpoint is captured', async () => {
        const repoRoot = await createRepo();
        try {
            const context = makeContext(repoRoot);
            const refs = buildRepositoryCheckpointRefs({ scopeId: checkpointScopeId('session-1', repoRoot), turnId: 'turn-1' });
            const start = await captureGitRepositoryCheckpoint({ context, checkpointRef: refs.turnStart! });
            expect(start.success).toBe(true);

            await writeFile(join(repoRoot, 'tracked.txt'), 'changed by turn\n', 'utf8');
            const final = await captureGitRepositoryCheckpoint({ context, checkpointRef: refs.turnFinal! });
            expect(final.success).toBe(true);

            const backup = await createGitRollbackBackup({
                context,
                request: makeRollbackRequest({
                    cwd: repoRoot,
                    expectedStartRef: refs.turnStart!.ref,
                    expectedFinalRef: refs.turnFinal!.ref,
                }),
                rollbackId: 'rollback-1',
            });
            expect(backup.success).toBe(true);

            const result = await applyGitCheckpointReversePatch({
                context,
                request: makeRollbackRequest({
                    cwd: repoRoot,
                    expectedStartRef: refs.turnStart!.ref,
                    expectedFinalRef: refs.turnFinal!.ref,
                }),
                backupCaptured: backup.success,
            });

            expect(result.status).toBe('applied');
            expect(backup.success ? backup.backupCheckpointRef : '').toContain(refs.encodedScope);
            expect(await readFile(join(repoRoot, 'tracked.txt'), 'utf8')).toBe('base\n');
            expect(await runGit(repoRoot, ['diff', '--', 'tracked.txt'])).toBe('');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('refuses to mutate when reverse patch preflight conflicts', async () => {
        const repoRoot = await createRepo();
        try {
            const context = makeContext(repoRoot);
            const refs = buildRepositoryCheckpointRefs({ scopeId: checkpointScopeId('session-1', repoRoot), turnId: 'turn-1' });
            const start = await captureGitRepositoryCheckpoint({ context, checkpointRef: refs.turnStart! });
            expect(start.success).toBe(true);
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed by turn\n', 'utf8');
            const final = await captureGitRepositoryCheckpoint({ context, checkpointRef: refs.turnFinal! });
            expect(final.success).toBe(true);
            await writeFile(join(repoRoot, 'tracked.txt'), 'user diverged\n', 'utf8');

            const result = await applyGitCheckpointReversePatch({
                context,
                request: makeRollbackRequest({
                    cwd: repoRoot,
                    expectedStartRef: refs.turnStart!.ref,
                    expectedFinalRef: refs.turnFinal!.ref,
                }),
                backupCaptured: true,
            });

            expect(result.status).toBe('conflict');
            expect(await readFile(join(repoRoot, 'tracked.txt'), 'utf8')).toBe('user diverged\n');
            expect(result.receipts).toContain('checkpoint.rollback_conflict');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('refuses to mutate before backup capture succeeds', async () => {
        const repoRoot = await createRepo();
        try {
            const context = makeContext(repoRoot);
            const refs = buildRepositoryCheckpointRefs({ scopeId: checkpointScopeId('session-1', repoRoot), turnId: 'turn-1' });
            await captureGitRepositoryCheckpoint({ context, checkpointRef: refs.turnStart! });
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed by turn\n', 'utf8');
            await captureGitRepositoryCheckpoint({ context, checkpointRef: refs.turnFinal! });

            const result = await applyGitCheckpointReversePatch({
                context,
                request: makeRollbackRequest({
                    cwd: repoRoot,
                    expectedStartRef: refs.turnStart!.ref,
                    expectedFinalRef: refs.turnFinal!.ref,
                }),
                backupCaptured: false,
            });

            expect(result.status).toBe('aborted');
            expect(await readFile(join(repoRoot, 'tracked.txt'), 'utf8')).toBe('changed by turn\n');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('refuses refs outside the requested session and turn before mutating', async () => {
        const repoRoot = await createRepo();
        try {
            const context = makeContext(repoRoot);
            const requestedRefs = buildRepositoryCheckpointRefs({ scopeId: checkpointScopeId('session-1', repoRoot), turnId: 'turn-1' });
            const otherSessionRefs = buildRepositoryCheckpointRefs({ scopeId: checkpointScopeId('session-2', repoRoot), turnId: 'turn-1' });
            await captureGitRepositoryCheckpoint({ context, checkpointRef: requestedRefs.turnStart! });
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed by turn\n', 'utf8');
            await captureGitRepositoryCheckpoint({ context, checkpointRef: requestedRefs.turnFinal! });

            const result = await applyGitCheckpointReversePatch({
                context,
                request: {
                    v: 1,
                    sessionId: 'session-1',
                    turnId: 'turn-1',
                    cwd: repoRoot,
                    codeMode: 'conversation_and_code_without_stash',
                    backupMode: 'happier_checkpoint_only',
                    expectedStartRef: requestedRefs.turnStart!.ref,
                    expectedFinalRef: otherSessionRefs.turnFinal!.ref,
                },
                backupCaptured: true,
            });

            expect(result.status).toBe('unavailable');
            expect(result.diagnostics).toContain('checkpoint_ref_scope_mismatch');
            expect(await readFile(join(repoRoot, 'tracked.txt'), 'utf8')).toBe('changed by turn\n');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it('refuses cwd outside the resolved session worktree before mutating', async () => {
        const repoRoot = await createRepo();
        const otherRoot = await createRepo();
        try {
            const context = makeContext(repoRoot);
            const refs = buildRepositoryCheckpointRefs({ scopeId: checkpointScopeId('session-1', repoRoot), turnId: 'turn-1' });
            await captureGitRepositoryCheckpoint({ context, checkpointRef: refs.turnStart! });
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed by turn\n', 'utf8');
            await captureGitRepositoryCheckpoint({ context, checkpointRef: refs.turnFinal! });

            const result = await applyGitCheckpointReversePatch({
                context,
                request: {
                    v: 1,
                    sessionId: 'session-1',
                    turnId: 'turn-1',
                    cwd: otherRoot,
                    codeMode: 'conversation_and_code_without_stash',
                    backupMode: 'happier_checkpoint_only',
                    expectedStartRef: refs.turnStart!.ref,
                    expectedFinalRef: refs.turnFinal!.ref,
                },
                backupCaptured: true,
            });

            expect(result.status).toBe('unavailable');
            expect(result.diagnostics).toContain('checkpoint_rollback_worktree_mismatch');
            expect(await readFile(join(repoRoot, 'tracked.txt'), 'utf8')).toBe('changed by turn\n');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
            await rm(otherRoot, { recursive: true, force: true });
        }
    });
});
