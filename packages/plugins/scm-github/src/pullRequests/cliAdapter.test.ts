import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm';
import { describe, expect, it } from 'vitest';

const provider: ScmHostingProviderRef = {
  id: 'scm.github',
  kind: 'github',
  displayName: 'GitHub',
  baseUrl: 'https://ghe.internal.test',
  nameWithOwner: 'happier-dev/happier',
  urlSafety: { allowedSchemes: ['https:'] },
};

describe('GitHub CLI pull request adapter', () => {
  it('lists pull requests through an authenticated host-specific gh command', async () => {
    const mod = await import('./cliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: unknown[] = [];
    const adapter = mod.createGithubCliAdapter({
      detectAuth: async () => ({
        kind: 'authenticated',
        source: 'system',
        binPath: '/usr/local/bin/gh',
        host: 'ghe.internal.test',
      }),
      runCommand: async (request: unknown) => {
        calls.push(request);
        return {
          ok: true,
          stdout: JSON.stringify([
            {
              number: 9,
              title: 'CLI PR',
              url: 'https://ghe.internal.test/happier-dev/happier/pull/9',
              state: 'OPEN',
              baseRefName: 'main',
              headRefName: 'feature/cli',
            },
          ]),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    await expect(adapter.listPullRequests({
      provider,
      base: 'main',
      head: 'feature/cli',
      state: 'open',
    })).resolves.toEqual([
      expect.objectContaining({
        number: 9,
        title: 'CLI PR',
        baseBranch: 'main',
        headBranch: 'feature/cli',
      }),
    ]);

    expect(calls).toEqual([
      {
        binPath: '/usr/local/bin/gh',
        args: [
          'pr',
          'list',
          '--repo',
          'ghe.internal.test/happier-dev/happier',
          '--state',
          'open',
          '--json',
          expect.stringContaining('headRepository'),
          '--base',
          'main',
          '--head',
          'feature/cli',
        ],
        env: {
          GCM_INTERACTIVE: 'Never',
          GH_PROMPT_DISABLED: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeoutMs: expect.any(Number),
      },
    ]);
  });

  it('uses operation-scoped dep.gh command resolution and runner when constructor deps are absent', async () => {
    const mod = await import('./cliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: Array<Readonly<{ binPath: string; args: readonly string[]; timeoutMs: number }>> = [];
    const adapter = mod.createGithubCliAdapter();
    const input = {
      provider,
      head: 'feature/runtime-cli',
      state: 'open' as const,
      runtimeServices: {
        resolveInstallableCommand: async (request: Readonly<{ capabilityId: string }>) =>
          request.capabilityId === 'dep.gh'
            ? { kind: 'available' as const, source: 'managed' as const, binPath: '/managed/gh/current/bin/gh' }
            : { kind: 'missing' as const },
        runCommand: async (request: Readonly<{ binPath: string; args: readonly string[]; timeoutMs: number }>) => {
          calls.push(request);
          if (request.args[0] === 'auth') {
            return { ok: true, stdout: '', stderr: '', exitCode: 0 };
          }
          return {
            ok: true,
            stdout: JSON.stringify([
              {
                number: 11,
                title: 'Runtime CLI PR',
                url: 'https://ghe.internal.test/happier-dev/happier/pull/11',
                state: 'OPEN',
                baseRefName: 'main',
                headRefName: 'feature/runtime-cli',
              },
            ]),
            stderr: '',
            exitCode: 0,
          };
        },
      },
    };

    await expect(adapter.listPullRequests(input)).resolves.toEqual([
      expect.objectContaining({
        number: 11,
        title: 'Runtime CLI PR',
      }),
    ]);

    expect(calls.map((call) => call.args.slice(0, 4))).toEqual([
      ['auth', 'status', '--hostname', 'ghe.internal.test'],
      ['pr', 'list', '--repo', 'ghe.internal.test/happier-dev/happier'],
    ]);
    expect(calls[0]?.binPath).toBe('/managed/gh/current/bin/gh');
  });

  it('creates pull requests without invoking install or login commands', async () => {
    const mod = await import('./cliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: Array<Readonly<{ args: readonly string[] }>> = [];
    const adapter = mod.createGithubCliAdapter({
      detectAuth: async () => ({
        kind: 'authenticated',
        source: 'managed',
        binPath: '/managed/gh/current/bin/gh',
        host: 'ghe.internal.test',
      }),
      runCommand: async (request: Readonly<{ args: readonly string[] }>) => {
        calls.push(request);
        if (request.args[1] === 'create') {
          return {
            ok: true,
            stdout: 'https://ghe.internal.test/happier-dev/happier/pull/10',
            stderr: '',
            exitCode: 0,
          };
        }
        return {
          ok: true,
          stdout: JSON.stringify({
            number: 10,
            title: 'Created PR',
            url: 'https://ghe.internal.test/happier-dev/happier/pull/10',
            state: 'OPEN',
            baseRefName: 'main',
            headRefName: 'feature/create',
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    await expect(adapter.createPullRequest({
      provider,
      base: 'main',
      head: 'feature/create',
      title: 'Created PR',
      body: 'Created from test',
      draft: true,
    })).resolves.toMatchObject({
      number: 10,
      title: 'Created PR',
    });

    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['pr', 'create'],
      ['pr', 'view'],
    ]);
    expect(calls).not.toContainEqual(expect.objectContaining({
      args: expect.arrayContaining(['login']),
    }));
    expect(calls).not.toContainEqual(expect.objectContaining({
      args: expect.arrayContaining(['install']),
    }));
  });

  it('does not classify incidental author text as an authentication failure', async () => {
    const mod = await import('./cliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createGithubCliAdapter({
      detectAuth: async () => ({
        kind: 'authenticated',
        source: 'system',
        binPath: '/usr/local/bin/gh',
        host: 'ghe.internal.test',
      }),
      runCommand: async () => ({
        ok: false,
        stdout: '',
        stderr: 'could not resolve author field',
        exitCode: 1,
      }),
    });

    await expect(adapter.listPullRequests({
      provider,
      head: 'feature/cli',
    })).rejects.toMatchObject({
      errorCode: 'COMMAND_FAILED',
    });
  });

  it('rejects pull request URL references outside the detected provider repository before running gh', async () => {
    const mod = await import('./cliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: unknown[] = [];
    const adapter = mod.createGithubCliAdapter({
      detectAuth: async () => ({
        kind: 'authenticated',
        source: 'system',
        binPath: '/usr/local/bin/gh',
        host: 'ghe.internal.test',
      }),
      runCommand: async (request: unknown) => {
        calls.push(request);
        return {
          ok: true,
          stdout: '{}',
          stderr: '',
          exitCode: 0,
        };
      },
    });

    await expect(adapter.getPullRequest({
      provider,
      reference: { url: 'https://evil.example.com/happier-dev/happier/pull/9' },
    })).rejects.toMatchObject({
      errorCode: 'COMMAND_FAILED',
    });
    expect(calls).toEqual([]);
  });
});
