import { describe, expect, it, vi } from 'vitest';
import { runWithBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { runGitPushWithConnectedAccount } from './connectedAccountPush.js';
import type { ScmExecResult } from '../runtime.js';

const sourceUrl = 'https://github.com/happier-dev/project.git';
const source = {
    provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'happier-dev/project', cloneUrl: sourceUrl },
    protocol: 'https' as const,
};

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
    it('compares the effective push destination with the host-recorded clone source and keeps the remote name', async () => {
        runScmCommand.mockImplementation(async ({ args }) => args[2] === '--push'
            ? { success: true, stdout: `${sourceUrl}\n`, stderr: '', exitCode: 0 }
            : { success: true, stdout: '', stderr: '', exitCode: 0 });
        let transported: { repositories: readonly { url: string; authorizationHeader: string }[]; command: { args: readonly string[] } } | undefined;
        const response = await runWithBackendRuntimeServices({
            projectFilesSource: source,
            repositoryTransport: { requiresConnectedAccount: true, run: async input => {
                transported = input;
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            } },
        }, () => runGitPushWithConnectedAccount({ remote: 'origin', command: { bin: 'git', cwd: '/tmp/project', args: ['push', '--no-verify', 'origin', 'main'], timeoutMs: 30_000, env: {}, signal: new AbortController().signal } }));
        expect(response.success).toBe(true);
        expect(runScmCommand).toHaveBeenCalledWith(expect.objectContaining({ args: ['remote', 'get-url', '--push', '--all', 'origin'] }));
        expect(transported?.repositories).toEqual([{ url: sourceUrl, authorizationHeader: 'Basic test' }]);
        expect(transported?.command.args).toEqual(['push', '--no-verify', 'origin', 'main']);
    });

    it('refuses a guest-rewritten destination before obtaining a credentialed transport', async () => {
        runScmCommand.mockResolvedValue({ success: true, stdout: 'https://other.example/attacker.git\n', stderr: '', exitCode: 0 });
        const transport = vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }));
        const response = await runWithBackendRuntimeServices({
            projectFilesSource: source,
            repositoryTransport: { requiresConnectedAccount: true, run: transport },
        }, () => runGitPushWithConnectedAccount({ remote: 'origin', command: { bin: 'git', cwd: '/tmp/project', args: ['push', '--no-verify', 'origin', 'main'], timeoutMs: 30_000, env: {}, signal: new AbortController().signal } }));
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.SCM_SOURCE_CHANGED);
        expect(transport).not.toHaveBeenCalled();
    });

    it('refuses pushurl fan-out even when one URL is the recorded source', async () => {
        runScmCommand.mockResolvedValue({ success: true, stdout: `${sourceUrl}\nhttps://other.example/attacker.git\n`, stderr: '', exitCode: 0 });
        const transport = vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }));
        const response = await runWithBackendRuntimeServices({
            projectFilesSource: source,
            repositoryTransport: { requiresConnectedAccount: true, run: transport },
        }, () => runGitPushWithConnectedAccount({ remote: 'origin', command: { bin: 'git', cwd: '/tmp/project', args: ['push', '--no-verify', 'origin', 'main'], timeoutMs: 30_000, env: {}, signal: new AbortController().signal } }));
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.SCM_SOURCE_CHANGED);
        expect(transport).not.toHaveBeenCalled();
    });
});
