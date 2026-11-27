import { RPC_METHODS, type GithubStarResult } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    detectGithubCliAuth,
    resolveGithubCliTimeoutMs,
    runGithubCliCommand,
    type GithubCliCommandRunner,
} from '@/scm/hostingProviders/providers/githubCliDetection';
import { resolveExistingGhManagedBinPath, resolveSystemGhBinPath } from '@/capabilities/deps/gh';

const repository = 'user/starred/happier-dev/happier';
const api = ['api', '--hostname', 'github.com'];

async function readRepositoryStatus(run: GithubCliCommandRunner, method: 'GET' | 'PUT'): Promise<number | null> {
    const result = await run({
        args: [...api, '-i', '-X', method, repository],
        timeoutMs: resolveGithubCliTimeoutMs(),
    });
    const status = /^HTTP\/\S+\s+(\d{3})\b/m.exec(result.stdout)?.[1];
    return status ? Number(status) : null;
}

export async function readGithubStarStatus(run = runGithubCliCommand): Promise<GithubStarResult> {
    if (run === runGithubCliCommand && !resolveSystemGhBinPath() && !resolveExistingGhManagedBinPath()) return { status: 'web' };
    const auth = await detectGithubCliAuth({
        providerBaseUrl: 'https://github.com',
        runCommand: async (request) => {
            const result = await run(request);
            if (!result.success && result.exitCode === null) throw new Error('GitHub authentication status unavailable');
            return result;
        },
    }).catch(() => null);
    if (!auth) return { status: 'unknown' };
    if (auth.kind === 'missing-auth') return { status: 'web' };
    const identity = await run({ args: [...api, 'user', '--jq', '.login'], timeoutMs: resolveGithubCliTimeoutMs() });
    if (!identity.success && identity.exitCode !== null && /^gh: [^\r\n]+ \(HTTP (401|403)\)\s*$/m.test(identity.stderr)) {
        return { status: 'web' };
    }
    const login = identity.stdout.trim();
    if (!identity.success || !/^[\da-zA-Z-]{1,39}$/.test(login)) return { status: 'unknown' };
    const status = await readRepositoryStatus(run, 'GET');
    if (status === 204) return { status: 'starred' };
    if (status === 404) return { status: 'unstarred', login };
    if (status === 401 || status === 403) return { status: 'web' };
    return { status: 'unknown' };
}

export async function starHappierOnGithub(run = runGithubCliCommand): Promise<GithubStarResult> {
    const status = await readRepositoryStatus(run, 'PUT');
    if (status === 204) return { status: 'starred' };
    if (status === 401 || status === 403) return { status: 'web' };
    return { status: 'unknown' };
}

export function registerGithubStarHandlers(rpc: RpcHandlerRegistrar): void {
    rpc.registerHandler(RPC_METHODS.GITHUB_STAR_STATUS, () => readGithubStarStatus());
    rpc.registerHandler(RPC_METHODS.GITHUB_STAR, () => starHappierOnGithub());
}
