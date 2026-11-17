import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionListResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { bindDiscussionActionHttpRequestV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { useTeamPagedList } from '@/hooks/teams/useTeamPagedList';
import { getHomeAccountChangeDemandedServerIds, publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { summary } from '@/sync/ops/discussions/discussionRepository.testkit';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { requestHomeDomain } = await import('@/sync/api/home/homeServerActionTransport');
beforeEach(async () => { resetTeamActionClientForTests(); await home.reset(); });
afterEach(async () => { standardCleanup(); await home.reset(); });

it('uses the domain relevance predicate for scoped page refreshes without treating unrelated pushes as inventory changes', async () => {
    const { path, method } = bindDiscussionActionHttpRequestV1('discussion.list', { sharedWithTeamId: 'team-a' });
    const serverId = await home.addHome({ name: 'Discussions', serverUrl: 'https://team-discussion-wakes.test',
        accountId: 'account-a', currentAccount: true, teamsEnabled: true });
    home.answer(serverId, 'GET /v1/discussions', { body: { discussions: [], nextCursor: null } });
    const list = await renderHook(() => useTeamPagedList({ key: serverId, enabled: true,
        accountChange: { serverId, affects: event => event.discussionAffects !== false },
        loadPage: async (_cursor, signal) => {
            // The pager's page loader crosses the real scoped HTTP boundary; the
            // domain-hook case below separately exercises the Action front door.
            const result = await requestHomeDomain({ scope: { serverId, accountId: 'account-a' },
                path, method, input: undefined,
                effect: 'read', signal, schema: DiscussionListResponseV1Schema });
            return !result.ok ? { kind: 'failed', failure: result.failure } : { kind: 'succeeded', value: { items: result.value.discussions,
                nextCursor: result.value.nextCursor } };
        } }));
    await waitForHomeGovernance(() => expect(list.getCurrent().status).toBe('ready'));
    await act(async () => publishHomeAccountChange(serverId, ['unrelated'], { discussionAffects: false }));
    await act(async () => publishHomeAccountChange('another-home', ['changed-discussion'], { discussionAffects: true }));
    expect(home.requestsFor(path)).toHaveLength(1);
    await act(async () => publishHomeAccountChange(serverId, ['changed-discussion'], { discussionAffects: true }));
    await waitForHomeGovernance(() => expect(home.requestsFor(path)).toHaveLength(2));
    expect(getHomeAccountChangeDemandedServerIds()).toContain(serverId);
    await waitForHomeGovernance(() => expect(list.getCurrent().status).toBe('ready'));
    await act(async () => publishHomeAccountChange(serverId));
    await waitForHomeGovernance(() => expect(home.requestsFor(path)).toHaveLength(3));
});

it('pages only the selected Team Discussions through the real list Action and replaces the sequence on Team change', async () => {
    // Load the real Action graph before the render-progress wait starts.
    await import('@/sync/ops/actions/defaultActionExecutor');
    const { useTeamSharedDiscussions } = await import('./useTeamSharedDiscussions');
    const serverId = await home.addHome({ name: 'Discussions', serverUrl: 'https://team-discussions.test',
        accountId: 'account-a', currentAccount: true, teamsEnabled: true });
    const urls: URL[] = [];
    home.answer(serverId, 'GET /v1/discussions', { select: (_input, request) => {
        const url = new URL(request.url);
        urls.push(url);
        const id = `${url.searchParams.get('sharedWithTeamId') ?? 'unscoped'}-${url.searchParams.has('cursor') ? 'second' : 'first'}`;
        const { title: _title, ...row } = summary(id, null, 1);
        return { body: { discussions: [DiscussionSummaryV1Schema.parse({ ...row,
            titleContent: { t: 'plain', v: { v: 1, title: id } } })],
            nextCursor: url.searchParams.has('cursor') ? null : 'next-page' } };
    } });
    const scope = { serverId, accountId: 'account-a' };
    const list = await renderHook(({ teamId }) => useTeamSharedDiscussions({ scope,
        address: { serverId, teamId }, enabled: true }), { initialProps: { teamId: 'team-a' } });
    await waitForHomeGovernance(() => expect(list.getCurrent().rows.map(row => row.id)).toEqual(['team-a-first']));
    await act(async () => list.getCurrent().loadMore());
    expect(list.getCurrent().rows.map(row => row.id)).toEqual(['team-a-first', 'team-a-second']);
    await list.rerender({ teamId: 'team-b' });
    await waitForHomeGovernance(() => expect(list.getCurrent().rows.map(row => row.id)).toEqual(['team-b-first']));
    expect(urls.map(url => [url.searchParams.get('sharedWithTeamId'), url.searchParams.get('cursor')])).toEqual([
        ['team-a', null], ['team-a', 'next-page'], ['team-b', null],
    ]);
    expect(home.requestsFor('/v1/discussions/attention')).toHaveLength(0);
});
