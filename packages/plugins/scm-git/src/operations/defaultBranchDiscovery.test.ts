import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { createGithubScmHostingProviderAdapter } from '../../../scm-github/src/adapter.js';
import { createGithubRestAdapter } from '../../../scm-github/src/pullRequests/restAdapter.js';
import { createGithubRepositoryRestAdapter } from '../../../scm-github/src/repositoryProvisioning/githubRepositoryRestAdapter.js';
import { defaultPrStatusCache } from '../hostingProviders/prStatusCache.js';
import { getGitSnapshot } from '../repository.js';
import { runWithGitScmCommandRunner } from '../testkit/scmRuntime.test-support.js';
import { createGitPullRequestReadOperations } from './pullRequestReadOperations.js';
import { resolveSourceControlPullRequestViewModel } from '../../../../../apps/ui/sources/components/workspaces/scm/update/resolveSourceControlPullRequestViewModel.js';

describe('default branch discovery without a remote HEAD', () => {
    afterEach(() => defaultPrStatusCache.clear());

    it.each([
        { remoteHeads: '', metadataAvailable: true, hasPullRequest: false },
        { remoteHeads: 'origin/HEAD\torigin/release\n', metadataAvailable: true, hasPullRequest: false },
        { remoteHeads: '', metadataAvailable: false, hasPullRequest: false },
        { remoteHeads: '', metadataAvailable: true, hasPullRequest: true },
    ])('uses provider metadata only behind remote HEAD precedence (%j)', async ({ remoteHeads, metadataAvailable, hasPullRequest }) => {
        const root = await mkdtemp(join(tmpdir(), 'scm-default-branch-'));
        const requests: string[] = [];
        let head = 'topic';
        let remoteHeadRefs = remoteHeads;
        // Git execution and GitHub HTTP are the only substituted system boundaries.
        const fetcher = async (url: string) => {
            requests.push(url);
            if (!url.includes('/pulls?') && !metadataAvailable) return new Response('{}', { status: 503 });
            const pullRequests = hasPullRequest && !new URL(url).searchParams.has('base') ? [{
                number: 54, title: 'Branch PR', html_url: 'https://github.com/acme/repo/pull/54', state: 'open',
                base: { ref: 'release' }, head: { ref: 'topic' },
            }] : [];
            return new Response(JSON.stringify(url.includes('/pulls?') ? pullRequests : {
                full_name: 'acme/repo', name: 'repo', html_url: 'https://github.com/acme/repo',
                clone_url: 'https://github.com/acme/repo.git', private: false, default_branch: 'main',
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        const resolveToken = async () => ({ kind: 'available' as const, token: 'fixture-token', profileKey: 'fixture' });
        const registry = createScmHostingProviderRegistry({
            providers: [{ id: 'github', pluginId: 'happier.scm.github', kind: 'github', displayName: 'GitHub', capabilities: [] }],
            runtimeRegistrations: [{ pluginId: 'happier.scm.github', occurrenceId: 'default-branch-test',
                registration: { id: 'github', adapter: {
                    routing: createGithubScmHostingProviderAdapter(),
                    pullRequests: createGithubRestAdapter({ fetcher, resolveToken }),
                    repositoryPublishing: createGithubRepositoryRestAdapter({ fetcher, resolveToken }),
                } } }],
        });
        const context = { cwd: root, projectKey: `test:${root}`, detection: { isRepo: true, rootPath: root, mode: '.git' as const } };
        try {
            await runWithGitScmCommandRunner(async ({ args }) => {
                const stdout = args[0] === 'status'
                    ? `# branch.oid aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0# branch.head ${head}\0# branch.upstream origin/${head}\0# branch.ab +0 -0\0`
                    : args[0] === 'remote' ? 'origin\thttps://github.com/acme/repo.git (fetch)\norigin\thttps://github.com/acme/repo.git (push)\n'
                    : args[0] === 'for-each-ref' ? remoteHeadRefs : '';
                return { success: true, stdout, stderr: '', exitCode: 0 };
            }, async () => {
                const read = () => getGitSnapshot({ context, resolveHostingProviderRegistry: async () => registry });
                const initial = await read();
                expect(initial.snapshot?.pullRequestStatus?.baseBranch).toBe(remoteHeads ? 'release' : null);
                expect(requests).toHaveLength(0);
                const operations = createGitPullRequestReadOperations({ registry });
                expect(await operations.list({ context, request: { head: 'topic', state: 'open' } })).toMatchObject({ success: true });
                const snapshot = (await read()).snapshot!;
                const expectedBase = remoteHeads ? 'release' : metadataAvailable ? 'main' : null;
                expect(snapshot.repo.defaultBranch ?? null).toBe(expectedBase);
                expect(snapshot.pullRequestStatus?.baseBranch).toBe(expectedBase);
                expect(resolveSourceControlPullRequestViewModel({ snapshot })).toMatchObject({
                    kind: hasPullRequest ? 'existing' : 'create',
                    primaryAction: hasPullRequest ? { kind: 'open-url' } : expectedBase ? { kind: 'open-or-reuse' } : null,
                });
                if (hasPullRequest) expect(snapshot.pullRequestStatus?.openPullRequest).toMatchObject({ number: 54, baseBranch: 'release' });
                for (let index = 0; index < 5; index++) await read();
                head = 'next';
                expect((await read()).snapshot?.repo.defaultBranch ?? null).toBe(expectedBase);
                if (!remoteHeads) {
                    remoteHeadRefs = 'origin/HEAD\torigin/release\n';
                    expect((await read()).snapshot?.repo.defaultBranch).toBe('release');
                }
                expect(requests.filter(url => url.includes('/pulls?'))).toHaveLength(1);
                expect(new URL(requests.find(url => url.includes('/pulls?'))!).searchParams.has('base')).toBe(false);
                expect(requests.filter(url => !url.includes('/pulls?'))).toHaveLength(remoteHeads ? 0 : 1);
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
