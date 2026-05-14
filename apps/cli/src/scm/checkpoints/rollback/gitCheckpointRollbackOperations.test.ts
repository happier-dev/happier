import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildGitCheckpointRollbackScopeId } from './gitCheckpointRollbackScope';
import { applyGitCheckpointReversePatch } from './gitCheckpointRollbackOperations';
import { buildRepositoryCheckpointRefs } from '../refs';
import { captureGitRepositoryCheckpoint } from '../gitRepositoryCheckpointOperations';
import type { ScmBackendContext } from '../../types';

function createRepo(): Readonly<{ repoRoot: string; context: ScmBackendContext }> {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-checkpoint-rollback-'));
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'checkpoint@happier.dev'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Happier Checkpoint Test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'tracked.txt'), 'base\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'ignore' });

    return {
        repoRoot,
        context: {
            cwd: repoRoot,
            projectKey: `test:${repoRoot}`,
            detection: {
                isRepo: true,
                rootPath: repoRoot,
                mode: '.git',
            },
        },
    };
}

describe('applyGitCheckpointReversePatch', () => {
    it('refuses to mutate when the current worktree diverged from the expected final checkpoint', async () => {
        const { repoRoot, context } = createRepo();
        const sessionId = 'session-1';
        const turnId = 'turn-1';
        const refs = buildRepositoryCheckpointRefs({
            scopeId: buildGitCheckpointRollbackScopeId({ repoRoot, sessionId }),
            turnId,
        });

        await captureGitRepositoryCheckpoint({ context, checkpointRef: refs.turnStart! });
        writeFileSync(join(repoRoot, 'tracked.txt'), 'changed by turn\n', 'utf8');
        await captureGitRepositoryCheckpoint({ context, checkpointRef: refs.turnFinal! });
        writeFileSync(join(repoRoot, 'untracked-after-final.txt'), 'local work\n', 'utf8');

        const result = await applyGitCheckpointReversePatch({
            context,
            backupCaptured: true,
            request: {
                v: 1,
                sessionId,
                turnId,
                cwd: repoRoot,
                codeMode: 'code_only_without_stash',
                backupMode: 'happier_checkpoint_only',
                expectedStartRef: refs.turnStart!.ref,
                expectedFinalRef: refs.turnFinal!.ref,
                codeOnlyTranscriptDivergenceConfirmed: true,
            },
        });

        expect(result.status).toBe('conflict');
        expect(result.receipts).toEqual(['checkpoint.rollback_conflict']);
        expect(result.diagnostics).toContain('checkpoint_rollback_worktree_diverged');
        expect(readFileSync(join(repoRoot, 'tracked.txt'), 'utf8')).toBe('changed by turn\n');
        expect(readFileSync(join(repoRoot, 'untracked-after-final.txt'), 'utf8')).toBe('local work\n');
    });
});
