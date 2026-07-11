import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm';
import { describe, expect, it } from 'vitest';

const provider: ScmHostingProviderRef = {
  id: 'scm.github',
  kind: 'github',
  displayName: 'GitHub',
  baseUrl: 'https://ghe.internal.test',
  urlSafety: { allowedSchemes: ['https:'] },
};

const publicGithubProvider: ScmHostingProviderRef = {
  id: 'scm.github',
  kind: 'github',
  displayName: 'GitHub',
  baseUrl: 'https://github.com',
  urlSafety: { allowedSchemes: ['https:'] },
};

describe('GitHub CLI repository provisioning adapter', () => {
  it('creates repositories with non-mutating gh arguments', async () => {
    const mod = await import('./githubRepositoryCliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: Array<Readonly<{ args: readonly string[] }>> = [];
    const adapter = mod.createGithubRepositoryCliAdapter({
      detectAuth: async () => ({
        kind: 'authenticated',
        source: 'system',
        binPath: '/usr/local/bin/gh',
        host: 'ghe.internal.test',
      }),
      runCommand: async (request: Readonly<{ args: readonly string[] }>) => {
        calls.push(request);
        return {
          ok: true,
          stdout: 'https://ghe.internal.test/happier-dev/happier',
          stderr: '',
          exitCode: 0,
        };
      },
    });

    await expect(adapter.createRepository({
      provider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
      description: '  Created by test  ',
    })).resolves.toMatchObject({
      nameWithOwner: 'happier-dev/happier',
      webUrl: 'https://ghe.internal.test/happier-dev/happier',
      visibility: 'private',
    });

    expect(calls).toEqual([
      expect.objectContaining({
        args: [
          'repo',
          'create',
          'ghe.internal.test/happier-dev/happier',
          '--private',
          '--description',
          'Created by test',
        ],
      }),
    ]);
    const forbiddenLocalGitMutationFlags = [
      ['--', 'source'].join(''),
      ['--', 'remote'].join(''),
      ['--', 'push'].join(''),
      ['--', 'confirm'].join(''),
    ];
    expect(calls.flatMap((call) => call.args)).not.toEqual(expect.arrayContaining(
      forbiddenLocalGitMutationFlags,
    ));
  });

  it('host-qualifies Enterprise repository creation and uses operation-scoped dep.gh services', async () => {
    const mod = await import('./githubRepositoryCliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: Array<Readonly<{ binPath: string; args: readonly string[] }>> = [];
    const adapter = mod.createGithubRepositoryCliAdapter();

    await expect(adapter.createRepository({
      provider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'public',
      runtimeServices: {
        resolveInstallableCommand: async () => ({
          kind: 'available',
          source: 'managed',
          binPath: '/managed/gh/current/bin/gh',
        }),
        runCommand: async (request: Readonly<{ binPath: string; args: readonly string[] }>) => {
          calls.push(request);
          if (request.args[0] === 'auth') {
            return { ok: true, stdout: '', stderr: '', exitCode: 0 };
          }
          return {
            ok: true,
            stdout: 'https://ghe.internal.test/happier-dev/happier',
            stderr: '',
            exitCode: 0,
          };
        },
      },
    })).resolves.toMatchObject({
      webUrl: 'https://ghe.internal.test/happier-dev/happier',
    });

    expect(calls.map((call) => call.args.slice(0, 4))).toEqual([
      ['auth', 'status', '--hostname', 'ghe.internal.test'],
      ['repo', 'create', 'ghe.internal.test/happier-dev/happier', '--public'],
    ]);
    expect(calls[0]?.binPath).toBe('/managed/gh/current/bin/gh');
  });

  it('keeps github.com repository creation selectors unqualified by host', async () => {
    const mod = await import('./githubRepositoryCliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: Array<Readonly<{ args: readonly string[] }>> = [];
    const adapter = mod.createGithubRepositoryCliAdapter({
      detectAuth: async () => ({
        kind: 'authenticated',
        source: 'system',
        binPath: '/usr/local/bin/gh',
        host: 'github.com',
      }),
      runCommand: async (request: Readonly<{ args: readonly string[] }>) => {
        calls.push(request);
        return {
          ok: true,
          stdout: 'https://github.com/happier-dev/happier',
          stderr: '',
          exitCode: 0,
        };
      },
    });

    await expect(adapter.createRepository({
      provider: publicGithubProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'public',
    })).resolves.toMatchObject({
      nameWithOwner: 'happier-dev/happier',
      webUrl: 'https://github.com/happier-dev/happier',
      visibility: 'public',
    });

    expect(calls[0]?.args.slice(0, 4)).toEqual([
      'repo',
      'create',
      'happier-dev/happier',
      '--public',
    ]);
  });

  it('describes repositories with gh repo view', async () => {
    const mod = await import('./githubRepositoryCliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: Array<Readonly<{ args: readonly string[] }>> = [];
    const adapter = mod.createGithubRepositoryCliAdapter({
      detectAuth: async () => ({
        kind: 'authenticated',
        source: 'managed',
        binPath: '/managed/gh/current/bin/gh',
        host: 'ghe.internal.test',
      }),
      runCommand: async (request: Readonly<{ args: readonly string[] }>) => {
        calls.push(request);
        return {
          ok: true,
          stdout: JSON.stringify({
            nameWithOwner: 'happier-dev/happier',
            url: 'https://ghe.internal.test/happier-dev/happier',
            sshUrl: 'git@ghe.internal.test:happier-dev/happier.git',
            defaultBranchRef: { name: 'main' },
            visibility: 'PUBLIC',
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    await expect(adapter.getRepository({
      provider,
      owner: 'happier-dev',
      repositoryName: 'happier',
    })).resolves.toMatchObject({
      nameWithOwner: 'happier-dev/happier',
      webUrl: 'https://ghe.internal.test/happier-dev/happier',
      sshUrl: 'git@ghe.internal.test:happier-dev/happier.git',
      visibility: 'public',
      defaultBranch: 'main',
    });
    expect(calls[0]?.args).toEqual([
      'repo',
      'view',
      'ghe.internal.test/happier-dev/happier',
      '--json',
      'nameWithOwner,url,sshUrl,defaultBranchRef,visibility',
    ]);
  });

  it('returns null for gh not-found responses', async () => {
    const mod = await import('./githubRepositoryCliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createGithubRepositoryCliAdapter({
      detectAuth: async () => ({
        kind: 'authenticated',
        source: 'system',
        binPath: '/usr/local/bin/gh',
        host: 'ghe.internal.test',
      }),
      runCommand: async () => ({
        ok: false,
        stdout: '',
        stderr: 'HTTP 404: Not Found',
        exitCode: 1,
      }),
    });

    await expect(adapter.getRepository({
      provider,
      owner: 'happier-dev',
      repositoryName: 'missing',
    })).resolves.toBeNull();
  });

  it('does not classify incidental author text as an authentication failure', async () => {
    const mod = await import('./githubRepositoryCliAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createGithubRepositoryCliAdapter({
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

    await expect(adapter.describePublishTargets({
      provider,
      defaultRepositoryName: 'happier',
    })).rejects.toMatchObject({
      errorCode: 'COMMAND_FAILED',
    });
  });
});
