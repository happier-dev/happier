import { describe, expect, it } from 'vitest';
import { readGithubStarStatus, starHappierOnGithub } from './githubStar';
import type { GithubCliCommandRunner } from '@/scm/hostingProviders/providers/githubCliDetection';

function processResult(status: number | null, login = 'octocat'): GithubCliCommandRunner {
    return async ({ args }) => {
        if (args[0] === 'auth') return { success: true, stdout: '', stderr: '', exitCode: 0 };
        if (args.includes('user')) return { success: true, stdout: login, stderr: '', exitCode: 0 };
        expect(args).toContain('user/starred/happier-dev/happier');
        return { success: status === 204, stdout: status ? `HTTP/2 ${status}\n` : '', stderr: '', exitCode: status ? 0 : null };
    };
}

describe('GitHub star commands', () => {
    it('distinguishes starred, available and unavailable without returning command output', async () => {
        expect(await readGithubStarStatus(processResult(204))).toEqual({ status: 'starred' });
        expect(await readGithubStarStatus(processResult(404))).toEqual({ status: 'unstarred', login: 'octocat' });
        expect(await readGithubStarStatus(processResult(403))).toEqual({ status: 'web' });
        expect(await readGithubStarStatus(processResult(null))).toEqual({ status: 'unknown' });
    });

    it('stars only the fixed repository and reports permission failures as a web fallback', async () => {
        const put: GithubCliCommandRunner = async (request) => {
            expect(request.args).toEqual(['api', '--hostname', 'github.com', '-i', '-X', 'PUT', 'user/starred/happier-dev/happier']);
            return processResult(204)(request);
        };
        expect(await starHappierOnGithub(put)).toEqual({ status: 'starred' });
        expect(await starHappierOnGithub(processResult(403))).toEqual({ status: 'web' });
    });

    it('offers the browser when an otherwise configured credential is rejected by the identity endpoint', async () => {
        const rejected: GithubCliCommandRunner = async ({ args }) => args[0] === 'auth'
            ? { success: true, stdout: '', stderr: '', exitCode: 0 }
            : { success: false, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)\n', exitCode: 1 };
        expect(await readGithubStarStatus(rejected)).toEqual({ status: 'web' });
    });
});
