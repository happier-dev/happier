import { describe, expect, it, vi } from 'vitest';

describe('gitlabCliDetection', () => {
    it('checks glab authentication for the detected provider host', async () => {
        const mod = await import('./gitlabCliDetection').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected GitLab CLI detection module');

        const runCommand = vi.fn(async () => ({
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
        }));

        await expect(mod.detectGitlabCliAuth({
            providerBaseUrl: 'https://gitlab.company.test',
            runCommand,
        })).resolves.toEqual({
            kind: 'authenticated',
            command: 'glab',
            host: 'gitlab.company.test',
        });

        expect(runCommand).toHaveBeenCalledWith({
            args: ['auth', 'status', '--hostname', 'gitlab.company.test'],
            timeoutMs: expect.any(Number),
        });
    });
});
