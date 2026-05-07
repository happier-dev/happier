import { describe, expect, it, vi } from 'vitest';

describe('githubCliDetection', () => {
    it('reports authenticated GitHub CLI when auth status succeeds for the provider host', async () => {
        const mod = await import('./githubCliDetection').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitHub CLI detection module');

        const runCommand = vi.fn(async () => ({
            success: true,
            stdout: 'Logged in to github.com account octocat\n',
            stderr: '',
            exitCode: 0,
        }));

        await expect(mod.detectGithubCliAuth({
            providerBaseUrl: 'https://github.com',
            runCommand,
        })).resolves.toEqual({
            kind: 'authenticated',
            command: 'gh',
            host: 'github.com',
        });
    });

    it('reports missing GitHub CLI auth when auth status fails', async () => {
        const mod = await import('./githubCliDetection').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitHub CLI detection module');

        const runCommand = vi.fn(async () => ({
            success: false,
            stdout: '',
            stderr: 'not logged in\n',
            exitCode: 1,
        }));

        await expect(mod.detectGithubCliAuth({
            providerBaseUrl: 'https://github.com',
            runCommand,
        })).resolves.toEqual({
            kind: 'missing-auth',
            command: 'gh',
            host: 'github.com',
        });
    });

    it('runs GitHub CLI commands through the managed gh binary when it is installed', async () => {
        vi.resetModules();
        const runCliCommandBestEffort = vi.fn(async () => ({
            ok: true,
            stdout: 'ok\n',
            stderr: '',
            exitCode: 0,
        }));
        vi.doMock('@/capabilities/cliAuth/shared', () => ({ runCliCommandBestEffort }));
        vi.doMock('@/capabilities/deps/gh', () => ({
            resolveGithubCliCommandPath: () => '/managed/tools/gh/current/bin/gh',
        }));

        const mod = await import('./githubCliDetection');
        await expect(mod.runGithubCliCommand({ args: ['auth', 'status'], timeoutMs: 1000 })).resolves.toMatchObject({
            success: true,
            stdout: 'ok\n',
        });

        expect(runCliCommandBestEffort).toHaveBeenCalledWith({
            resolvedPath: '/managed/tools/gh/current/bin/gh',
            args: ['auth', 'status'],
            timeoutMs: 1000,
        });
    });
});
