import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runScmCommand } from './runtime';

function initRepo(cwd: string): void {
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
}

describe('runScmCommand output limits', () => {
    it('fails deterministically when command output exceeds configured limit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-runtime-limit-'));
        initRepo(workspace);

        const result = await runScmCommand({
            bin: 'git',
            cwd: workspace,
            args: ['rev-parse', 'HEAD'],
            timeoutMs: 5000,
            maxOutputBytes: 8,
        });

        expect(result.success).toBe(false);
        expect(result.outputLimitExceeded).toBe(true);
        expect(result.stderr.toLowerCase()).toContain('output limit');
    });

    it('succeeds when output remains within configured limit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-runtime-ok-'));
        initRepo(workspace);

        const result = await runScmCommand({
            bin: 'git',
            cwd: workspace,
            args: ['rev-parse', '--is-inside-work-tree'],
            timeoutMs: 5000,
            maxOutputBytes: 1024,
        });

        expect(result.success).toBe(true);
        expect(result.outputLimitExceeded).not.toBe(true);
        expect(result.stdout.trim()).toBe('true');
    });
});
