import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { teamCredentialResourceFixture, teamMembershipFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
const { applyTeamCredentialResource, resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');

const resourceId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
const teamId = '299c21a2-4015-40ad-8940-38867c442c2c';
const groupId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
const membershipId = 'f20c797b-449f-4aa6-8b89-01fcfcaed022';
const groupName = 'Release reviewers';
const resourceName = 'Studio credential';

beforeEach(async () => { standardCleanup(); resetTeamsSnapshotsForTests(); await harness.reset(); });
afterEach(async () => { standardCleanup(); resetTeamsSnapshotsForTests(); await harness.reset(); });

it.each(['readable', 'other Account'] as const)('reviews a Team credential audience (%s)', async visibility => {
    const accountId = 'reviewer';
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://credential-review.test', accountId, teamsEnabled: true });
    await harness.selectHomes([serverId]);
    const resource = teamCredentialResourceFixture({ id: resourceId, teamId, displayName: resourceName });
    applyTeamCredentialResource({
        scope: { serverId, accountId: visibility === 'readable' ? accountId : 'other' },
        address: { serverId, teamId },
        resource,
        observedAt: 1,
    });
    const member = teamMembershipFixture({ id: membershipId, teamId });
    harness.answer(serverId, 'POST /v1/teams/members/get', { body: member });
    harness.answer(serverId, 'POST /v1/session-access/principals/resolve', {
        select: input => ({ body: { v: 1, principals: (input as { subjects: { kind: string; teamId?: string; groupId?: string }[] }).subjects
            .filter(subject => subject.kind === 'group' && subject.teamId === teamId && subject.groupId === groupId)
            .map(subject => ({ ...subject, teamName: 'Research', name: {
                kind: 'available', label: { content: { t: 'plain', v: groupName }, recipientEnvelope: null },
            } })) } }),
    });
    const actionId = 'teams.credentials.audience.set';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ resourceId, expectedRevision: 1,
        allMembersAllowedRoutes: null, groupGrants: [{ teamGroupId: groupId, allowedRoutes: ['brokered'] }],
        memberGrants: [{ teamMembershipId: membershipId, allowedRoutes: ['brokered'] }] });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="credential-audience-review" />);
    try {
        await waitForHomeGovernance(() => {
            const text = screen.getTextContent();
            if (visibility === 'readable') {
                expect(text).toContain(resourceName);
                expect(text).toContain(groupName);
                expect(text).toContain('Ada');
            } else {
                expect(text).toContain(t('common.unavailable'));
                expect(text).not.toContain(resourceName);
                expect(text).not.toContain(groupName);
                expect(text).not.toContain('Ada');
            }
            for (const id of [resourceId, groupId, membershipId]) expect(text).not.toContain(id);
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        for (const id of [resourceId, groupId, membershipId]) expect(screen.getTextContent()).toContain(id);
    } finally { await screen.unmount(); }
});
