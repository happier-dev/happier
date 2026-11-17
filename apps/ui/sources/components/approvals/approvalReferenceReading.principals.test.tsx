import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { teamMembershipFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { describeApprovalActionFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useApprovalReferenceReading, readApprovalReferenceForConfirmation } = await import('./approvalReferenceReading');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');

describe('approval principal names', () => {
    beforeEach(async () => { standardCleanup(); await harness.reset(); });
    afterEach(() => standardCleanup());

    it('names a Team membership through the exact authorized member read for display and confirmation', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://approval-member.test',
            accountId: 'viewer', serverIdentityId: 'srv_member' });
        const member = teamMembershipFixture({ id: 'membership-ada', teamId: 'team-design' });
        harness.answer(home, '/v1/teams/members/get', { body: member });
        await harness.addHome({ name: 'Focused Home', serverUrl: 'https://other-member.test', accountId: 'other' });
        const row = describeApprovalActionFields({ actionId: 'teams.members.remove',
            actionArgs: { v: 1, teamId: member.teamId, membershipId: member.id } }).rows.find(row => row.path === 'membershipId');
        const reference = row?.kind === 'value' ? row.reference : undefined;
        const hook = await renderHook(() => useApprovalReferenceReading(reference, member.id, home), { flushOptions: { cycles: 25 } });
        await flushHookEffects({ cycles: 25 });
        expect(hook.getCurrent()).toMatchObject({ text: 'Ada', named: true });
        const reads = harness.requestsFor('/v1/teams/members/get').length;
        expect(reads).toBe(1);
        await hook.rerender();
        await flushHookEffects({ cycles: 25 });
        expect(harness.requestsFor('/v1/teams/members/get')).toHaveLength(reads);
        const account = await captureLazyActionAccountContext(home);
        try { expect(await readApprovalReferenceForConfirmation(reference, account)).toMatchObject({ text: 'Ada', named: true }); }
        finally { account.dispose(); }
        expect(harness.requestsFor('/v1/teams/members/get').every(request => request.serverId === home
            && JSON.stringify(request.input) === JSON.stringify({ v: 1, teamId: member.teamId, membershipId: member.id }))).toBe(true);
        await hook.unmount();
    });

    it.each([403, 404])('keeps an unreadable membership literal when its Home refuses the name (%s)', async status => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://unreadable-member.test',
            accountId: 'viewer', serverIdentityId: 'srv_unreadable_member' });
        harness.answer(home, '/v1/teams/members/get', { status, body: { error: status === 403 ? 'forbidden' : 'not_found' } });
        const row = describeApprovalActionFields({ actionId: 'teams.members.remove',
            actionArgs: { v: 1, teamId: 'team-design', membershipId: 'membership-private' } }).rows.find(row => row.path === 'membershipId');
        const reference = row?.kind === 'value' ? row.reference : undefined;
        const hook = await renderHook(() => useApprovalReferenceReading(reference, 'membership-private', home), { flushOptions: { cycles: 25 } });
        await flushHookEffects({ cycles: 25 });
        expect(hook.getCurrent()).toMatchObject({ text: 'membership-private', named: false });
        expect(hook.getCurrent().resolving).not.toBe(true);
        const account = await captureLazyActionAccountContext(home);
        try { expect(await readApprovalReferenceForConfirmation(reference, account)).toMatchObject({ text: 'membership-private', named: false }); }
        finally { account.dispose(); }
        await hook.unmount();
    });

    it.each([
        { reference: { kind: 'account' as const, id: 'recipient' }, subject: { kind: 'account', accountId: 'recipient' },
            summary: { kind: 'account', accountId: 'recipient', name: 'Ada Lovelace', firstName: null, lastName: null,
                username: 'ada', avatarUrl: null }, name: 'Ada Lovelace' },
        { reference: { kind: 'team' as const, id: 'team' }, subject: { kind: 'team', teamId: 'team' },
            summary: { kind: 'team', teamId: 'team', name: 'Design studio' }, name: 'Design studio' },
        { reference: { kind: 'teamModel' as const, id: 'shared-model', teamId: 'team', resourceId: 'resource-model',
            agentTargetKey: 'agent:happier.agent.codex/codex' }, subject: { kind: 'team', teamId: 'team' },
            summary: { kind: 'team', teamId: 'team', name: 'Design studio' }, name: 'shared-model · Design studio' },
        { reference: { kind: 'group' as const, id: 'group', teamId: 'team' }, subject: { kind: 'group', teamId: 'team', groupId: 'group' },
            summary: { kind: 'group', teamId: 'team', groupId: 'group',
                name: { kind: 'available', label: { content: { t: 'plain', v: 'Reviewers' }, recipientEnvelope: null } },
                teamName: 'Design studio' },
            name: 'Reviewers, Design studio' },
    ])('names $reference.kind in the approval Home for display and confirmation', async ({ reference, subject, summary, name }) => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://approval-principal.test',
            accountId: 'viewer', serverIdentityId: 'srv_principal' });
        harness.answer(home, 'POST /v1/session-access/principals/resolve', { body: { v: 1, principals: [summary] } });
        await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused-principal.test', accountId: 'other',
            serverIdentityId: 'srv_other_principal' });
        const hook = await renderHook(() => useApprovalReferenceReading(reference, reference.id, home), { flushOptions: { cycles: 25 } });
        await flushHookEffects({ cycles: 25 });
        expect(hook.getCurrent()).toMatchObject({ text: name, named: true });
        const initialReads = harness.requestsFor('/v1/session-access/principals/resolve').length;
        expect(initialReads).toBe(1);
        await hook.rerender();
        await flushHookEffects({ cycles: 25 });
        expect(harness.requestsFor('/v1/session-access/principals/resolve')).toHaveLength(initialReads);
        const account = await captureLazyActionAccountContext(home);
        try { expect(await readApprovalReferenceForConfirmation(reference, account)).toMatchObject({ text: name, named: true }); }
        finally { account.dispose(); }
        const requests = harness.requestsFor('/v1/session-access/principals/resolve');
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every(request => request.serverId === home && JSON.stringify(request.input) === JSON.stringify({ v: 1, subjects: [subject] }))).toBe(true);
        await hook.unmount();
    });

    it('shows the existing loading presentation until an exact principal name settles, including after remount', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://pending-principal.test',
            accountId: 'viewer', serverIdentityId: 'srv_pending_principal' });
        let release!: () => void;
        const response = new Promise<void>(resolve => { release = resolve; });
        harness.answer(home, 'POST /v1/session-access/principals/resolve', { respondAfter: response,
            body: { v: 1, principals: [{ kind: 'account', accountId: 'recipient', name: 'Ada Lovelace',
                firstName: null, lastName: null, username: 'ada', avatarUrl: null }] } });
        const reference = { kind: 'account' as const, id: 'recipient' };
        const mount = () => renderHook(() => useApprovalReferenceReading(reference, reference.id, home),
            { flushOptions: { cycles: 25 } });
        const first = await mount();
        expect(first.getCurrent()).toMatchObject({ resolving: true });
        expect(first.getCurrent().text).not.toBe(reference.id);
        await first.unmount();
        const remounted = await mount();
        expect(remounted.getCurrent()).toMatchObject({ resolving: true });
        expect(remounted.getCurrent().text).not.toBe(reference.id);
        release();
        await flushHookEffects({ cycles: 25 });
        expect(remounted.getCurrent()).toMatchObject({ text: 'Ada Lovelace', named: true });
        expect(remounted.getCurrent().resolving).not.toBe(true);
        await remounted.unmount();
    });

    it('does no principal discovery for another reference and keeps an undiscoverable Account literal', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://unavailable-principal.test',
            accountId: 'viewer', serverIdentityId: 'srv_unavailable_principal' });
        harness.answer(home, 'POST /v1/session-access/principals/resolve', { body: { v: 1, principals: [] } });
        const unrelated = await renderHook(() => useApprovalReferenceReading({ kind: 'home', id: home }, home, home));
        expect(harness.requestsFor('/v1/session-access/principals/resolve')).toHaveLength(0);
        await unrelated.unmount();
        const hook = await renderHook(() => useApprovalReferenceReading({ kind: 'account', id: 'missing' }, 'missing', home),
            { flushOptions: { cycles: 25 } });
        await flushHookEffects({ cycles: 25 });
        expect(hook.getCurrent()).toMatchObject({ text: 'missing', named: false });
        expect(hook.getCurrent().resolving).not.toBe(true);
        await hook.unmount();
    });
});
