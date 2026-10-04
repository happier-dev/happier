import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRepositoryCheckpointRefs } from './refs';
import { createGitCheckpointRuntimeServices, gitCheckpointAdapter } from './gitCheckpointAdapter';

describe('gitCheckpointAdapter runtime services', () => {
    it('keeps checkpoint mutation implementation host-owned', () => {
        const source = readFileSync(new URL('./gitCheckpointAdapter.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/@happier-dev\/plugins-scm-git\/checkpoints/);
    });

    it('rejects a mismatched installable key before running the Git command', async () => {
        const services = createGitCheckpointRuntimeServices();
        const result = await services.runCommand({
            installableKey: 'dep.sapling',
            command: 'git',
            cwd: process.cwd(),
            args: ['--version'],
            timeoutMs: 5000,
        });

        expect(result).toEqual({
            success: false,
            stdout: '',
            stderr: "Installable 'dep.sapling' does not authorize SCM command 'git'",
            exitCode: -1,
        });
    });

    it('captures checkpoints through host-owned Git runtime services', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'happier-host-checkpoint-'));
        execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'checkpoint@happier.dev'], { cwd: repoRoot });
        execFileSync('git', ['config', 'user.name', 'Happier Checkpoint Test'], { cwd: repoRoot });
        writeFileSync(join(repoRoot, 'README.md'), 'hello\n', 'utf8');
        execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
        execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot, stdio: 'ignore' });
        writeFileSync(join(repoRoot, 'README.md'), 'hello checkpoint\n', 'utf8');

        const refs = buildRepositoryCheckpointRefs({
            scopeId: `session-1:${repoRoot}`,
            turnId: 'turn-1',
        });
        const checkpointRef = refs.turnFinal;
        if (!checkpointRef) throw new Error('Expected turn-final checkpoint ref');

        const result = await gitCheckpointAdapter.capture({
            context: {
                cwd: repoRoot,
                projectKey: `test:${repoRoot}`,
                detection: {
                    isRepo: true,
                    rootPath: repoRoot,
                    mode: '.git',
                },
            },
            checkpointRef,
        });

        expect(result).toEqual(expect.objectContaining({
            success: true,
            checkpointRef,
        }));
    });

    it('retains complete readable checkpoint diffs beyond process output limits', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'happier-checkpoint-large-diff-'));
        try {
        execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        const context = { cwd: repoRoot, projectKey: repoRoot, detection: { isRepo: true, rootPath: repoRoot, mode: '.git' as const } };
        const refs = buildRepositoryCheckpointRefs({ scopeId: `large:${repoRoot}`, messageId: 'message', turnId: 'turn' });
        if (!refs.messageStart || !refs.turnFinal) throw new Error('Missing refs');
        writeFileSync(join(repoRoot, 'large.txt'), 'before\n');
        expect((await gitCheckpointAdapter.capture({ context, checkpointRef: refs.messageStart })).success).toBe(true);
        const content = Array.from({ length: 70000 }, (_, index) => `${index}: ${'content'.repeat(10)}\n`).join('');
        writeFileSync(join(repoRoot, 'large.txt'), content);
        expect((await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal })).success).toBe(true);
        const result = await gitCheckpointAdapter.diff({ context, baseRef: refs.messageStart, finalRef: refs.turnFinal,
            baseRefSource: 'message_start', attributionScope: 'unknown' });
        expect(result.success).toBe(true);
        if (!result.success) throw new Error(result.error);
        expect(result.files[0]?.unifiedDiff).toContain('+69999:');
        expect(result.files[0]?.unifiedDiff?.length).toBeGreaterThan(4 * 1024 * 1024);
        } finally { rmSync(repoRoot, { recursive: true, force: true }); }
    });
});
