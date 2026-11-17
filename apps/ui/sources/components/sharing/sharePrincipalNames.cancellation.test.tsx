import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { teamMembershipFixture } from '@/dev/testkit/fixtures/teamFixtures';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useApprovalPrincipalName } = await import('@/components/approvals/approvalPrincipalReading');

beforeEach(async () => { installHomeGovernanceBoundaries(homes); await homes.reset(); });
afterEach(async () => { await homes.reset(); });

describe('mounted principal name cancellation', () => {
    it('settles a pending membership name read when its approval row unmounts', async () => {
        const serverId = await homes.addHome({ name: 'Approval Home', serverUrl: 'https://approval-cancel.test',
            accountId: 'viewer', currentAccount: true });
        const member = teamMembershipFixture({ id: 'membership-ada', teamId: 'team-design' });
        homes.answer(serverId, '/v1/teams/members/get', { body: member });
        const hook = await renderHook((id: string) => useApprovalPrincipalName({ kind: 'teamMembership',
            teamId: member.teamId, id }, serverId), { initialProps: member.id, flushOptions: { cycles: 25 } });
        await flushHookEffects({ cycles: 25 });
        expect(hook.getCurrent()).toMatchObject({ name: 'Ada', resolving: false });

        const response = createDeferred<void>();
        let pendingSignal: AbortSignal | null | undefined;
        homes.answer(serverId, '/v1/teams/members/get', { body: { ...member, id: 'membership-pending' },
            respondAfter: response.promise, select: (_input, request) => { pendingSignal = request.signal; return undefined; } });
        await hook.rerender('membership-pending');
        await flushHookEffects({ cycles: 25 });
        expect(pendingSignal?.aborted).toBe(false);
        expect(hook.getCurrent()).toMatchObject({ name: null, resolving: true });
        await hook.unmount();
        expect(pendingSignal?.aborted).toBe(true);
        response.resolve();
        await flushHookEffects({ cycles: 25, turns: 1 });
    });

    it('settles an active rejected membership read as unavailable and reads a successor', async () => {
        const serverId = await homes.addHome({ name: 'Approval Home', serverUrl: 'https://approval-read-failure.test',
            accountId: 'viewer', currentAccount: true });
        const member = teamMembershipFixture({ id: 'membership-ada', teamId: 'team-design' });
        homes.answer(serverId, '/v1/teams/members/get', { select: () => {
            throw new DOMException('The name transport stopped its read', 'AbortError');
        } });
        const hook = await renderHook((id: string) => useApprovalPrincipalName({ kind: 'teamMembership',
            teamId: member.teamId, id }, serverId), { initialProps: 'membership-unavailable', flushOptions: { cycles: 25 } });
        await flushHookEffects({ cycles: 25, turns: 1 });
        expect(hook.getCurrent()).toMatchObject({ name: null, resolving: false });
        homes.answer(serverId, '/v1/teams/members/get', { body: member });
        await hook.rerender(member.id);
        await flushHookEffects({ cycles: 25 });
        expect(hook.getCurrent()).toMatchObject({ name: 'Ada', resolving: false });
        await hook.unmount();
    });
});
