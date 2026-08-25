import { describe, expect, it } from 'vitest';

import { detectGitlabCliAuth, resolveGitlabCliHost } from './gitlabCliDetection.js';

type GitlabCliCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

describe('GitLab CLI auth detection', () => {
  it('probes host-specific glab auth status without installing or logging in', async () => {
    const calls: unknown[] = [];
    const result = await detectGitlabCliAuth({
      providerBaseUrl: 'https://code.internal.test',
      runCommand: async (request: Readonly<{
        binPath: string;
        args: readonly string[];
        timeoutMs: number;
      }>): Promise<GitlabCliCommandResult> => {
        calls.push(request);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    });

    expect(result).toEqual({
      kind: 'authenticated',
      source: 'system',
      binPath: 'glab',
      host: 'code.internal.test',
    });
    expect(calls).toEqual([
      {
        binPath: 'glab',
        args: ['auth', 'status', '--hostname', 'code.internal.test'],
        timeoutMs: expect.any(Number),
      },
    ]);
    expect(calls).not.toContainEqual(expect.objectContaining({
      args: expect.arrayContaining(['login']),
    }));
    expect(calls).not.toContainEqual(expect.objectContaining({
      args: expect.arrayContaining(['install']),
    }));
  });

  it('defaults malformed GitLab provider base URLs to gitlab.com', async () => {
    expect(resolveGitlabCliHost('not a url')).toBe('gitlab.com');
  });

  it('does not report a glab probe that never completed as a missing CLI', async () => {
    await expect(detectGitlabCliAuth({
      providerBaseUrl: 'https://gitlab.com',
      runCommand: async () => ({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: null,
      }),
    })).resolves.toEqual({
      kind: 'command-failed',
      host: 'gitlab.com',
    });
  });

  it('does not mine the partial stderr of a glab probe that never completed', async () => {
    await expect(detectGitlabCliAuth({
      providerBaseUrl: 'https://gitlab.com',
      runCommand: async () => ({
        ok: false,
        stdout: '',
        stderr: 'project not found',
        exitCode: null,
      }),
    })).resolves.toEqual({
      kind: 'command-failed',
      host: 'gitlab.com',
    });
  });

  it('does not report a host that wired no command runner as a missing CLI', async () => {
    await expect(detectGitlabCliAuth({
      providerBaseUrl: 'https://gitlab.com',
    })).resolves.toEqual({
      kind: 'command-failed',
      host: 'gitlab.com',
    });
  });

  it('distinguishes missing glab from unauthenticated glab', async () => {
    await expect(detectGitlabCliAuth({
      providerBaseUrl: 'https://gitlab.com',
      runCommand: async () => ({
        ok: false,
        stdout: '',
        stderr: 'spawn glab ENOENT',
        exitCode: null,
      }),
    })).resolves.toEqual({
      kind: 'missing-cli',
      host: 'gitlab.com',
    });

    await expect(detectGitlabCliAuth({
      providerBaseUrl: 'https://gitlab.com',
      runCommand: async () => ({
        ok: false,
        stdout: '',
        stderr: 'not logged in',
        exitCode: 1,
      }),
    })).resolves.toEqual({
      kind: 'missing-auth',
      source: 'system',
      binPath: 'glab',
      host: 'gitlab.com',
    });
  });
});
