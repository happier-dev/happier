import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import { describe, expect, it } from 'vitest';

import { createGitlabCliAdapter } from './gitlabCliAdapter.js';

type CommandCall = Readonly<{
  binPath: string;
  args: readonly string[];
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
}>;

const provider: ScmHostingProviderRef = {
  id: 'scm.gitlab',
  kind: 'gitlab',
  displayName: 'GitLab',
  baseUrl: 'https://code.internal.test',
  nameWithOwner: 'platform/happier/app',
  urlSafety: { allowedSchemes: ['https:'] },
};

function authenticated() {
  return {
    kind: 'authenticated' as const,
    source: 'system' as const,
    binPath: 'glab',
    host: 'code.internal.test',
  };
}

describe('GitLab CLI merge request adapter', () => {
  it('lists merge requests through authenticated host-specific glab command', async () => {
    const calls: CommandCall[] = [];
    const adapter = createGitlabCliAdapter({
      detectAuth: async () => authenticated(),
      runCommand: async (request) => {
        calls.push(request);
        return {
          ok: true,
          stdout: JSON.stringify([
            {
              iid: 9,
              title: 'GitLab MR',
              web_url: 'https://code.internal.test/platform/happier/app/-/merge_requests/9',
              state: 'opened',
              source_branch: 'feature/gitlab',
              target_branch: 'main',
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
      head: 'feature/gitlab',
      state: 'open',
    })).resolves.toEqual([
      expect.objectContaining({
        number: 9,
        title: 'GitLab MR',
        baseBranch: 'main',
        headBranch: 'feature/gitlab',
      }),
    ]);

    expect(calls).toEqual([
      {
        binPath: 'glab',
        args: [
          'mr',
          'list',
          '--repo',
          'https://code.internal.test/platform/happier/app',
          '--state',
          'opened',
          '--output',
          'json',
          '--target-branch',
          'main',
          '--source-branch',
          'feature/gitlab',
        ],
        env: {
          GIT_TERMINAL_PROMPT: '0',
          GLAB_NO_PROMPT: '1',
        },
        timeoutMs: expect.any(Number),
      },
    ]);
  });

  it('uses the operation-scoped GitLab CLI executable service', async () => {
    const calls: Array<Readonly<{
      executable: Readonly<{ kind: 'systemTool'; id: string }>;
      args: readonly string[];
    }>> = [];
    const adapter = createGitlabCliAdapter();

    await expect(adapter.listPullRequests({
      provider,
      head: 'feature/runtime-cli',
      state: 'open',
      runtimeServices: {
        executeCommand: async (request: Readonly<{
          executable: Readonly<{ kind: 'systemTool'; id: string }>;
          args: readonly string[];
        }>) => {
          calls.push(request);
          if (request.args[0] === 'auth') {
            return { ok: true, stdout: '', stderr: '', exitCode: 0 };
          }
          return {
            ok: true,
            stdout: JSON.stringify([{
              iid: 13,
              title: 'Runtime GitLab MR',
              web_url: 'https://code.internal.test/platform/happier/app/-/merge_requests/13',
              state: 'opened',
              source_branch: 'feature/runtime-cli',
              target_branch: 'main',
            }]),
            stderr: '',
            exitCode: 0,
          };
        },
      },
    })).resolves.toEqual([
      expect.objectContaining({ number: 13, title: 'Runtime GitLab MR' }),
    ]);

    expect(calls.map((call) => call.args.slice(0, 4))).toEqual([
      ['auth', 'status', '--hostname', 'code.internal.test'],
      ['mr', 'list', '--repo', 'https://code.internal.test/platform/happier/app'],
    ]);
    expect(calls[0]?.executable).toEqual({ kind: 'systemTool', id: 'gitlab-cli' });
  });

  it('gets a merge request detail by iid and preserves description only from view output', async () => {
    const calls: CommandCall[] = [];
    const adapter = createGitlabCliAdapter({
      detectAuth: async () => authenticated(),
      runCommand: async (request) => {
        calls.push(request);
        return {
          ok: true,
          stdout: JSON.stringify({
            iid: 10,
            title: 'Viewed MR',
            web_url: 'https://code.internal.test/platform/happier/app/-/merge_requests/10',
            state: 'opened',
            source_branch: 'feature/view',
            target_branch: 'main',
            description: 'view body',
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    await expect(adapter.getPullRequest({
      provider,
      reference: { number: 10 },
    })).resolves.toMatchObject({
      number: 10,
      title: 'Viewed MR',
      description: 'view body',
    });

    expect(calls[0]?.args).toEqual([
      'mr',
      'view',
      '10',
      '--repo',
      'https://code.internal.test/platform/happier/app',
      '--output',
      'json',
    ]);
  });

  it('gets a merge request detail from a self-managed GitLab URL under the configured base path', async () => {
    const calls: CommandCall[] = [];
    const pathScopedProvider: ScmHostingProviderRef = {
      ...provider,
      baseUrl: 'https://code.internal.test/gitlab',
    };
    const adapter = createGitlabCliAdapter({
      detectAuth: async () => authenticated(),
      runCommand: async (request) => {
        calls.push(request);
        return {
          ok: true,
          stdout: JSON.stringify({
            iid: 10,
            title: 'Viewed MR',
            web_url: 'https://code.internal.test/gitlab/platform/happier/app/-/merge_requests/10',
            state: 'opened',
            source_branch: 'feature/view',
            target_branch: 'main',
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    await expect(adapter.getPullRequest({
      provider: pathScopedProvider,
      reference: { url: 'https://code.internal.test/gitlab/platform/happier/app/-/merge_requests/10' },
    })).resolves.toMatchObject({
      number: 10,
      title: 'Viewed MR',
    });

    expect(calls[0]?.args).toEqual([
      'mr',
      'view',
      '10',
      '--repo',
      'https://code.internal.test/gitlab/platform/happier/app',
      '--output',
      'json',
    ]);
  });

  it('creates merge requests through glab api with a tempfile description field', async () => {
    const calls: CommandCall[] = [];
    const tempBodies: string[] = [];
    const adapter = createGitlabCliAdapter({
      detectAuth: async () => authenticated(),
      withTempBody: async (body, callback) => {
        tempBodies.push(body);
        return callback('description=@/tmp/gitlab-mr-body/description.md');
      },
      runCommand: async (request) => {
        calls.push(request);
        return {
          ok: true,
          stdout: JSON.stringify({
            iid: 11,
            title: 'Created MR',
            web_url: 'https://code.internal.test/platform/happier/app/-/merge_requests/11',
            state: 'opened',
            source_branch: 'feature/create',
            target_branch: 'main',
            description: 'Created from test',
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
      title: 'Created MR',
      body: 'Created from test',
    })).resolves.toMatchObject({
      number: 11,
      title: 'Created MR',
      description: 'Created from test',
    });

    expect(tempBodies).toEqual(['Created from test']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      'api',
      '--hostname',
      'code.internal.test',
      '--method',
      'POST',
      'projects/platform%2Fhappier%2Fapp/merge_requests',
      '--raw-field',
      'source_branch=feature/create',
      '--raw-field',
      'target_branch=main',
      '--raw-field',
      'title=Created MR',
      '--field',
      'description=@/tmp/gitlab-mr-body/description.md',
    ]);
    expect(calls[0]?.args.join(' ')).not.toContain('Created from test');
  });

  it('views the created merge request when glab api returns only a URL', async () => {
    const calls: CommandCall[] = [];
    const adapter = createGitlabCliAdapter({
      detectAuth: async () => authenticated(),
      withTempBody: async (_body, callback) => callback('description=@/tmp/gitlab-mr-body/description.md'),
      runCommand: async (request) => {
        calls.push(request);
        if (request.args[0] === 'api') {
          return {
            ok: true,
            stdout: 'https://code.internal.test/platform/happier/app/-/merge_requests/12\n',
            stderr: '',
            exitCode: 0,
          };
        }
        return {
          ok: true,
          stdout: JSON.stringify({
            iid: 12,
            title: 'Viewed after create',
            web_url: 'https://code.internal.test/platform/happier/app/-/merge_requests/12',
            state: 'opened',
            source_branch: 'feature/url-only',
            target_branch: 'main',
            description: 'Created from URL-only response',
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    await expect(adapter.createPullRequest({
      provider,
      base: 'main',
      head: 'feature/url-only',
      title: 'Viewed after create',
      body: 'Created from URL-only response',
    })).resolves.toMatchObject({
      number: 12,
      title: 'Viewed after create',
      description: 'Created from URL-only response',
    });

    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['api', '--hostname'],
      ['mr', 'view'],
    ]);
    expect(calls[1]?.args).toEqual([
      'mr',
      'view',
      '12',
      '--repo',
      'https://code.internal.test/platform/happier/app',
      '--output',
      'json',
    ]);
  });

  it('returns typed auth and unavailable errors for missing or unauthenticated glab', async () => {
    await expect(createGitlabCliAdapter({
      detectAuth: async () => ({ kind: 'missing-auth', source: 'system', binPath: 'glab', host: 'gitlab.com' }),
      runCommand: async () => {
        throw new Error('should not run');
      },
    }).listPullRequests({ provider, head: 'feature/auth' })).rejects.toMatchObject({
      errorCode: 'REMOTE_AUTH_REQUIRED',
    });

    await expect(createGitlabCliAdapter({
      detectAuth: async () => ({ kind: 'missing-cli', host: 'gitlab.com' }),
      runCommand: async () => {
        throw new Error('should not run');
      },
    }).createPullRequest({
      provider,
      base: 'main',
      head: 'feature/missing',
      title: 'Missing glab',
    })).rejects.toMatchObject({
      errorCode: 'FEATURE_UNSUPPORTED',
    });
  });

  it('uses glab-cli as the daemon-local PR cache auth profile key', async () => {
    expect(createGitlabCliAdapter().getPullRequestAuthProfileKey({ provider })).toBe('glab-cli');
  });

  it('rejects merge request URL references outside the detected provider repository before running glab', async () => {
    const calls: CommandCall[] = [];
    const adapter = createGitlabCliAdapter({
      detectAuth: async () => authenticated(),
      runCommand: async (request) => {
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
      reference: { url: 'https://evil.example.com/platform/happier/app/-/merge_requests/9' },
    })).rejects.toMatchObject({
      errorCode: 'COMMAND_FAILED',
    });
    expect(calls).toEqual([]);
  });
});
