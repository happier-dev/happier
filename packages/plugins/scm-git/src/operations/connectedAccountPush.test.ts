import { describe, expect, it, vi } from 'vitest';
import { runWithBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { runGitPushWithConnectedAccount } from './connectedAccountPush.js';
import type { ScmExecResult } from '../runtime.js';

const sourceUrl = 'https://github.com/happier-dev/project.git';

const { runScmCommand, registry } = vi.hoisted(() => ({
  runScmCommand: vi.fn<(input: { args: readonly string[] }) => Promise<ScmExecResult>>(),
  registry: {

  detectRemote: ({ remoteName, remoteUrl }: { remoteName: string | null; remoteUrl: string }) => ({
    kind: 'resolved' as const,
    providerId: 'github',
    provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: remoteUrl.endsWith('/project.git') ? 'happier-dev/project' : undefined, urlSafety: { allowedSchemes: ['https:'] }, remoteName },
  }),
  getRepositoryClone: () => ({ resolveCloneAuthentication: async () => ({ kind: 'available' as const, authorizationHeader: 'Basic test' }) }),
  },
}));

vi.mock('../runtime.js', () => ({ runScmCommand }));
vi.mock('./pullRequestStatusProjection.js', () => ({ resolveDefaultPullRequestStatusProjectionRegistry: async () => registry }));

describe('connected-account push target', () => {
  it('pushes only to the clone source URL and bypasses guest pre-push hooks', async () => {
    runScmCommand.mockResolvedValue({ success: true, stdout: `${sourceUrl}\n`, stderr: '', exitCode: 0 });
    let transported: { repositories: readonly { url: string; authorizationHeader: string }[]; command: { args: readonly string[] } } | undefined;
    const response = await runWithBackendRuntimeServices({
      repositoryTransport: { requiresConnectedAccount: true, run: async input => {
        transported = input;
        return { success: true, stdout: '', stderr: '', exitCode: 0 };
      } },
    }, () => runGitPushWithConnectedAccount({ remote: 'origin', command: { bin: 'git', cwd: '/tmp/project', args: ['push', '--no-verify', 'origin', 'main'], timeoutMs: 30_000, env: {}, signal: new AbortController().signal } }));
    expect(response.success).toBe(true);
    expect(runScmCommand).toHaveBeenCalledWith(expect.objectContaining({ args: ['remote', 'get-url', 'origin'] }));
    expect(transported?.repositories).toEqual([{ url: sourceUrl, authorizationHeader: 'Basic test' }]);
    expect(transported?.command.args).toEqual(['push', '--no-verify', sourceUrl, 'main']);
  });
});
