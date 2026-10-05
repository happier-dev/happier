import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { probeScmExecutableAvailable, runScmCommand } from './runtime';

function initRepo(cwd: string): void {
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
}

describe('runScmCommand output limits', () => {
    it('fails through host executable resolution when the SCM tool is missing', async () => {
        const originalPath = process.env.PATH;
        process.env.PATH = '';
        try {
            const result = await runScmCommand({
                bin: 'git',
                cwd: tmpdir(),
                args: ['--version'],
                timeoutMs: 5000,
            });

            expect(result).toEqual(expect.objectContaining({
                success: false,
                exitCode: -1,
            }));
            expect(result.stderr).toContain('SCM executable not found');
            expect(result.stderr).toContain('dep.git');
        } finally {
            process.env.PATH = originalPath;
        }
    });

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

describe('probeScmExecutableAvailable', () => {
    it('reports an SCM runtime dependency as unavailable when host resolution cannot find it', async () => {
        const originalPath = process.env.PATH;
        process.env.PATH = '';
        try {
            await expect(probeScmExecutableAvailable({ bin: 'git', timeoutMs: 5000 })).resolves.toBe(false);
        } finally {
            process.env.PATH = originalPath;
        }
    });

    it('reports an installed SCM runtime dependency as available without a repository', async () => {
        await expect(probeScmExecutableAvailable({ bin: 'git', timeoutMs: 5000 })).resolves.toBe(true);
    });
});

describe('runScmCommand stdin interaction', () => {
    it.each([
        ['main', 'commit'], ['linked', 'commit'], ['detached', 'commit'], ['main', 'abort'],
    ] as const)('holds Git HEAD/ref locks in %s until the prepared transaction receives %s', async (mode, decision) => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-transaction-'));
        try {
            initRepo(workspace);
            const cwd = mode === 'linked' ? join(workspace, 'linked') : workspace;
            if (mode === 'linked') execFileSync('git', ['worktree', 'add', '-b', 'linked', cwd], { cwd: workspace, stdio: 'pipe' });
            if (mode === 'detached') execFileSync('git', ['checkout', '--detach'], { cwd, stdio: 'pipe' });
            const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
            const parent = git(['rev-parse', 'HEAD']);
            const branch = mode === 'detached' ? null : git(['symbolic-ref', 'HEAD']);
            const headLock = `${resolve(cwd, git(['rev-parse', '--git-path', 'HEAD']))}.lock`;
            const branchLock = branch ? `${resolve(cwd, git(['rev-parse', '--git-path', branch]))}.lock` : null;
            const candidate = git(['commit-tree', 'HEAD^{tree}', '-p', parent, '-m', 'candidate']);
            let prepared = false;
            const result = await runScmCommand({
                bin: 'git', cwd, args: ['update-ref', '--stdin'],
                stdin: `start\nupdate HEAD ${candidate} ${parent}\nprepare\n`,
                stdinInteraction: {
                    readyLine: 'prepare: ok',
                    respond: async () => {
                        prepared = true;
                        if (branch) expect(git(['symbolic-ref', 'HEAD'])).toBe(branch);
                        else expect(() => git(['symbolic-ref', 'HEAD'])).toThrow();
                        expect(git(['rev-parse', 'HEAD'])).toBe(parent);
                        expect(existsSync(headLock)).toBe(true);
                        if (branchLock) expect(existsSync(branchLock)).toBe(true);
                        expect(() => git(['symbolic-ref', 'HEAD', 'refs/heads/other'])).toThrow();
                        expect(() => git(['update-ref', branch ?? 'HEAD', candidate, parent])).toThrow();
                        return `${decision}\n`;
                    },
                },
            });
            expect(prepared).toBe(true);
            expect(result.success).toBe(true);
            expect(result.stdout).toContain(`${decision}: ok`);
            expect(git(['rev-parse', 'HEAD'])).toBe(decision === 'commit' ? candidate : parent);
            expect(existsSync(headLock)).toBe(false);
            if (branchLock) expect(existsSync(branchLock)).toBe(false);
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('releases a prepared Git transaction when the response callback rejects', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-transaction-error-'));
        try {
            initRepo(workspace);
            const parent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
            const result = await runScmCommand({
                bin: 'git', cwd: workspace, args: ['update-ref', '--stdin'],
                stdin: `start\nupdate HEAD ${parent} ${parent}\nprepare\n`,
                stdinInteraction: { readyLine: 'prepare: ok', respond: () => { throw new Error('HEAD identity refused'); } },
            });
            expect(result.success).toBe(false);
            expect(result.stderr).toContain('HEAD identity refused');
            expect(existsSync(join(workspace, '.git', 'HEAD.lock'))).toBe(false);
            expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim()).toBe(parent);
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('never calls the response callback when Git rejects preparation', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-transaction-refusal-'));
        try {
            initRepo(workspace);
            let called = false;
            const result = await runScmCommand({
                bin: 'git', cwd: workspace, args: ['update-ref', '--stdin'],
                stdin: 'start\nupdate HEAD 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000\nprepare\n',
                stdinInteraction: { readyLine: 'prepare: ok', respond: () => { called = true; return 'commit\n'; } },
            });
            expect(result.success).toBe(false);
            expect(called).toBe(false);
            expect(existsSync(join(workspace, '.git', 'HEAD.lock'))).toBe(false);
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    it.each(['timeout', 'cancel'] as const)('releases prepared native locks after %s while the response is pending', async (reason) => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-transaction-interrupted-'));
        try {
            initRepo(workspace);
            const parent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
            const controller = new AbortController();
            let prepared = false;
            const result = await runScmCommand({
                bin: 'git', cwd: workspace, args: ['update-ref', '--stdin'],
                stdin: `start\nupdate HEAD ${parent} ${parent}\nprepare\n`,
                timeoutMs: 1000,
                signal: controller.signal,
                stdinInteraction: {
                    readyLine: 'prepare: ok',
                    respond: () => {
                        prepared = true;
                        expect(existsSync(join(workspace, '.git', 'HEAD.lock'))).toBe(true);
                        if (reason === 'cancel') controller.abort();
                        return new Promise<string>(() => {});
                    },
                },
            });
            expect(prepared).toBe(true);
            expect(result.success).toBe(false);
            if (reason === 'timeout') expect(result.timedOut).toBe(true);
            expect(existsSync(join(workspace, '.git', 'HEAD.lock'))).toBe(false);
            expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim()).toBe(parent);
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });
});
