import { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createScmCapabilities } from '@happier-dev/protocol/scm';
import { ScmPullRequestSummarySchema } from '@happier-dev/protocol/scm/pullRequests';
import { createScmNetworkTestHarness, scmNetworkSnapshot } from '@/hooks/session/sourceControl/scmNetworkTestHarness';

const harness = await createScmNetworkTestHarness();
const { renderHook, standardCleanup } = await import('@/dev/testkit');
const { useGitPullRequestDiscovery } = await import('./useGitPullRequestDiscovery');
const { scmStatusSync } = await import('@/scm/scmStatusSync');
const { createSessionGitPullRequest } = await import('./createSessionGitPullRequest');
const snapshot = { ...scmNetworkSnapshot,
    capabilities: createScmCapabilities({ readPullRequestStatus: true }),
    hostingProvider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/repo' },
};
const listRequests = () => harness.network.requests.filter(request => request.method === RPC_METHODS.SCM_PULL_REQUEST_LIST);
const pullRequest = ScmPullRequestSummarySchema.parse({ provider: snapshot.hostingProvider,
    number: 42, title: 'Discovered PR', url: 'https://github.com/acme/repo/pull/42', headBranch: 'main', baseBranch: 'dev', state: 'open' });

describe('presented Git pane PR discovery', () => {
    beforeEach(async () => {
        await harness.reset();
        harness.network.setRpcResponder(async request => request.method === RPC_METHODS.SCM_PULL_REQUEST_LIST
            ? { success: true, pullRequests: [] }
            : { success: true, snapshot });
    });
    afterEach(() => { standardCleanup(); scmStatusSync.stop('s1', harness.serverId); });
    afterAll(() => harness.dispose());

    it('reads once per presented branch, never per snapshot refresh, and re-reads on push or explicit Refresh', async () => {
        const input = { sessionId: 's1', serverId: harness.serverId, snapshot, machineReachable: true, lastPushedAt: null as number | null };
        const hook = await renderHook(useGitPullRequestDiscovery, { initialProps: input });
        expect(listRequests()).toHaveLength(1);
        for (let index = 0; index < 5; index++) {
            await hook.rerender({ ...input, snapshot: { ...snapshot, fetchedAt: index + 10 } });
        }
        expect(listRequests()).toHaveLength(1);
        const changed = { ...input, snapshot: { ...snapshot, branch: { ...snapshot.branch, head: 'next' } } };
        await hook.rerender(changed);
        expect(listRequests()).toHaveLength(2);
        expect(listRequests()[1]?.payload).toMatchObject({ head: 'next', state: 'open' });
        await hook.rerender({ ...changed, lastPushedAt: 1234 });
        expect(listRequests()).toHaveLength(3);
        await act(async () => { await hook.getCurrent()(); });
        expect(listRequests()).toHaveLength(4);
        await hook.unmount();
        expect(listRequests()).toHaveLength(4);
    });

    it('stays cold without a reachable supported branch', async () => {
        const input = { sessionId: 's1', serverId: harness.serverId, snapshot, machineReachable: false, lastPushedAt: null };
        const hook = await renderHook(useGitPullRequestDiscovery, { initialProps: input });
        expect(listRequests()).toHaveLength(0);
        await hook.rerender({ ...input, machineReachable: true });
        expect(listRequests()).toHaveLength(1);
    });

    it('publishes a discovered PR despite a recent automatic snapshot refresh', async () => {
        let discovered = false;
        harness.network.setRpcResponder(async request => {
            if (request.method === RPC_METHODS.SCM_PULL_REQUEST_LIST) {
                discovered = true;
                return { success: true, pullRequests: [pullRequest] };
            }
            return { success: true, snapshot: { ...snapshot, pullRequestStatus: {
                provider: snapshot.hostingProvider, headBranch: 'main', baseBranch: 'dev',
                authState: 'authenticated', checkedAt: 1, openPullRequest: discovered ? pullRequest : null,
            } } };
        });
        await scmStatusSync.invalidateFromAutoRefreshAndAwait('s1', harness.serverId);
        await renderHook(useGitPullRequestDiscovery, { initialProps: {
            sessionId: 's1', serverId: harness.serverId, snapshot, machineReachable: true, lastPushedAt: null,
        } });
        await vi.waitFor(() => expect(harness.storage.getState().getSessionProjectScmSnapshot('s1', harness.serverId)?.pullRequestStatus?.openPullRequest).toEqual(pullRequest));
        expect(listRequests()).toHaveLength(1);
    });

    it('publishes the created PR to the snapshot used by the plugin-disabled generic card', async () => {
        harness.network.setRpcResponder(async request => request.method === RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE
            ? { success: true, reused: false, pullRequest, nextAction: { kind: 'none' } }
            : { success: true, snapshot: { ...snapshot, pullRequestStatus: {
                provider: snapshot.hostingProvider, headBranch: 'main', baseBranch: 'dev',
                authState: 'authenticated', checkedAt: 1, openPullRequest: pullRequest,
            } } });
        const outcome = await createSessionGitPullRequest({ state: harness.storage.getState(), sessionId: 's1', serverId: harness.serverId,
            machineReachable: true, draftSupported: true, request: { base: 'dev', head: 'main', title: 'PR', body: '', draft: false } });
        expect(outcome).toMatchObject({ kind: 'created', pullRequest });
        expect(harness.storage.getState().getSessionProjectScmSnapshot('s1', harness.serverId)?.pullRequestStatus?.openPullRequest).toEqual(pullRequest);
    });
});
