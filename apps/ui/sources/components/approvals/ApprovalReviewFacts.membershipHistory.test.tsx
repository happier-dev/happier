import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { TEAM_MEMBERSHIP_HISTORY_ACTION_IDS_V1 } from '@happier-dev/protocol/teams/membershipHistoryPreparationV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { teamMembershipFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

const teamId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
const groupId = 'f20c797b-449f-4aa6-8b89-01fcfcaed022';
const membershipId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
const accountId = '299c21a2-4015-40ad-8940-38867c442c2c';
const account = { name: 'Ada Lovelace', firstName: null, lastName: null, username: 'ada', avatarUrl: null };

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(async () => { standardCleanup(); await harness.reset(); });

const cases = TEAM_MEMBERSHIP_HISTORY_ACTION_IDS_V1.flatMap(actionId => ([
    { actionId, state: 'Team membership', target: { kind: 'team', teamMembershipId: membershipId }, id: membershipId, name: account.name },
    { actionId, state: 'readable Group', target: { kind: 'group', teamGroupId: groupId, accountId }, id: groupId, name: 'Release reviewers' },
    { actionId, state: 'unreadable Group', target: { kind: 'group', teamGroupId: groupId, accountId }, id: groupId, name: null },
] as const));

it.each(cases)('reads $state in $actionId', async ({ actionId, state, target, id, name }) => {
    const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://membership-review.test', accountId: 'reviewer', teamsEnabled: true });
    await harness.selectHomes([home]);
    harness.answer(home, 'POST /v1/session-access/principals/resolve', {
        select: input => ({ body: { v: 1, principals: (input as { subjects: { kind: string }[] }).subjects.flatMap(subject => {
            if (subject.kind === 'team') return [{ ...subject, teamId, name: 'Research' }];
            if (subject.kind === 'account') return [{ ...subject, accountId, ...account }];
            return state === 'readable Group' ? [{ ...subject, teamId, groupId, teamName: 'Research',
                name: { kind: 'available', label: { content: { t: 'plain', v: name }, recipientEnvelope: null } } }] : [];
        }) } }),
    });
    harness.answer(home, 'POST /v1/teams/members/get', { body: teamMembershipFixture({
        id: membershipId, teamId, accountId, account,
    }) });
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ teamId, target, recipientAccountId: accountId });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={home} testID="history-review" />);
    try {
        await waitForHomeGovernance(() => {
            const text = screen.getTextContent();
            expect(text).toContain(name ?? t('common.unavailable'));
            expect(text).toContain(account.name);
            expect(text).not.toContain(id);
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(id);
    } finally { await screen.unmount(); }
});
