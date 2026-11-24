import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { teamInvitationRowFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
const { captureServerCredentialAccountScopeLifetime, resolveServerCredentialAccountScope } =
    await import('@/sync/domains/scope/serverCredentialAccountScope');
const { teamInvitationsPageKey } = await import('@/sync/ops/teams/teamInvitationOperations');
const { teamInvitationPages } = await import('@/sync/store/teams/teamsSnapshots');

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(async () => { standardCleanup(); await harness.reset(); });

it.each([
    ['teams.invitations.revoke', 'active', true],
    ['teams.invitations.reissue', 'expired', true],
    ['teams.invitations.revoke', 'active', false],
] as const)('names the saved invitation for %s, state %s and readable %s', async (actionId, state, readable) => {
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://invitation-review.test', accountId: 'reviewer' });
    const resolution = await resolveServerCredentialAccountScope(serverId);
    if (resolution.kind !== 'bound') throw new Error('Missing reviewer credentials');
    const binding = captureServerCredentialAccountScopeLifetime(resolution);
    const invitation = teamInvitationRowFixture({ id: '9e9b44d4-2167-4837-adb5-92dc43f3b481', recipientEmailMask: 'r•••@example.test', state });
    const address = { serverId, teamId: invitation.teamId };
    const scope = readable ? binding.scope : { ...binding.scope, accountId: 'other' };
    teamInvitationPages.apply(teamInvitationsPageKey(scope, address, null), binding, { items: [invitation], nextCursor: null });
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ v: 1, teamId: invitation.teamId, invitationId: invitation.id,
        ...(actionId === 'teams.invitations.reissue' ? { recipientEmail: null, requestKey: 'retry-invitation' } : {}) });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="invitation-review" />);
    try {
        await waitForHomeGovernance(() => {
            const text = screen.getTextContent();
            expect(text).not.toContain(invitation.id);
            if (readable) expect(text).toContain(invitation.recipientEmailMask);
            else {
                expect(text).toContain(t('common.unavailable'));
                expect(text).not.toContain(invitation.recipientEmailMask);
            }
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(invitation.id);
    } finally { await screen.unmount(); }
});
