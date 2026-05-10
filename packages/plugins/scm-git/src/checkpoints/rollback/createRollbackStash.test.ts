import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { buildRepositoryCheckpointRefs } from '../shared.js';
import { createGitRollbackStash } from './createRollbackStash.js';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFile('git', [...args], { cwd });
    return stdout.trim();
}

async function createRepo(): Promise<string> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'happier-checkpoint-rollback-stash-'));
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await runGit(repoRoot, ['config', 'user.name', 'Happier Test']);
    await writeFile(join(repoRoot, 'tracked.txt'), 'base\n', 'utf8');
    await runGit(repoRoot, ['add', 'tracked.txt']);
    await runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

describe('createGitRollbackStash', () => {
    it('stores a rollback stash backup without mutating the current worktree', async () => {
        const repoRoot = await createRepo();
        try {
            await writeFile(join(repoRoot, 'tracked.txt'), 'changed before rollback\n', 'utf8');
            await writeFile(join(repoRoot, 'untracked.txt'), 'untracked before rollback\n', 'utf8');
            const refs = buildRepositoryCheckpointRefs({
                scopeId: `session-1:${repoRoot}`,
                turnId: 'turn-1',
            });

            const result = await createGitRollbackStash({
                context: {
                    cwd: repoRoot,
                    projectKey: `test:${repoRoot}`,
                    detection: { isRepo: true, rootPath: repoRoot, mode: '.git' },
                },
                request: {
                    v: 1,
                    sessionId: 'session-1',
                    turnId: 'turn-1',
                    cwd: repoRoot,
                    codeMode: 'code_only_with_stash',
                    backupMode: 'happier_checkpoint_and_git_stash',
                    expectedStartRef: refs.turnStart!.ref,
                    expectedFinalRef: refs.turnFinal!.ref,
                    codeOnlyTranscriptDivergenceConfirmed: true,
                },
                rollbackId: 'rollback-1',
            });

            expect(result.success).toBe(true);
            expect(await readFile(join(repoRoot, 'tracked.txt'), 'utf8')).toBe('changed before rollback\n');
            expect(await readFile(join(repoRoot, 'untracked.txt'), 'utf8')).toBe('untracked before rollback\n');
            expect(await runGit(repoRoot, ['stash', 'list'])).toContain('Happier rollback backup');
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });
});
