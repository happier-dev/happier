import { describe, expect, it, vi } from 'vitest';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { withChannelStateSessionIdentity } from './collectionMigrations.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { sessionPullRequestBindingFixture } from './testkit/sessionPullRequestBindingFixture.js';
import { GITHUB_CHANNEL_PULL_REQUESTS } from '../../scm-github/src/githubChannelContribution.js';
import { archiveSessionPullRequestWatchAfterMerge } from './sessionPullRequestWatchLifecycle.js';

async function fixture() {
    const state = new MemoryCollection();
    const value = sessionPullRequestBindingFixture('merged-pr', 'session-a', 12, 'merged');
    const target = { ...value.payload.target, pullRequestWatch: {
        policy: { mode: 'autoFix', archiveAfterMerge: true },
    } };
    await state.put(withChannelStateSessionIdentity({ ...value, payload: { ...value.payload, target } }, target), { expectedRevision: 'absent' });
    const status = { session: { id: 'session-a', pendingCount: 0, pendingBlockedCount: 0, archivedAt: null },
        awareness: { runtime: 'idle', freshness: 'live', availability: 'complete' }, pendingRequests: [], agentState: { pendingRequestsCount: 0 } };
    const execute = vi.fn(async (action: string) => {
        if (action === 'session.status.get') return status;
        if (action === 'session.archive') return { success: true, sessionId: 'session-a' };
        throw new Error(`Unexpected lifecycle Action ${action}`);
    });
    const services = { actions: { execute }, storage: { account: { collection: (definition: { id: string }) => {
        if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Collection');
        return state;
    } } } } as unknown as PluginAccountActionContext['services'];
    return { state, status, execute, context: { services, signal: new AbortController().signal } };
}
describe('PR watch terminal lifecycle', () => {
    it('archives once at an opted-in merge observation only when all linked PRs are terminal and the Session is provably idle', async () => {
        const input = await fixture();
        await expect(archiveSessionPullRequestWatchAfterMerge({ sessionId: 'session-a', bindingId: 'merged-pr', provider: GITHUB_CHANNEL_PULL_REQUESTS }, input.context))
            .resolves.toEqual({ kind: 'archived' });
        expect(input.execute).toHaveBeenCalledWith('session.archive', { sessionId: 'session-a' }, expect.any(Object));
    });
    it('leaves open or unknown linked PRs, unresolved questions and busy Sessions for explicit Archive', async () => {
        const input = await fixture();
        const other = sessionPullRequestBindingFixture('other-pr', 'session-a', 13);
        await input.state.put(withChannelStateSessionIdentity(other, other.payload.target), { expectedRevision: 'absent' });
        await expect(archiveSessionPullRequestWatchAfterMerge({ sessionId: 'session-a', bindingId: 'merged-pr', provider: GITHUB_CHANNEL_PULL_REQUESTS }, input.context))
            .resolves.toEqual({ kind: 'notEligible' });
        await input.state.delete('other-pr', { expectedRevision: 1 });
        input.status.agentState.pendingRequestsCount = 1;
        await expect(archiveSessionPullRequestWatchAfterMerge({ sessionId: 'session-a', bindingId: 'merged-pr', provider: GITHUB_CHANNEL_PULL_REQUESTS }, input.context))
            .resolves.toEqual({ kind: 'notEligible' });
        input.status.agentState.pendingRequestsCount = 0;
        input.status.awareness.runtime = 'working';
        await expect(archiveSessionPullRequestWatchAfterMerge({ sessionId: 'session-a', bindingId: 'merged-pr', provider: GITHUB_CHANNEL_PULL_REQUESTS }, input.context))
            .resolves.toEqual({ kind: 'notEligible' });
        expect(input.execute.mock.calls.some(([action]) => action === 'session.archive')).toBe(false);
    });
});
