import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { teamCredentialResourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { applyTeamCredentialResource } from '@/sync/store/teams/teamsSnapshots';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
const { ActionConfirmationReviewFacts } = await import('./ActionConfirmationReview');

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(standardCleanup);

it.each([
    { readable: true, confirmation: false },
    { readable: false, confirmation: false },
    { readable: true, confirmation: true },
    { readable: false, confirmation: true },
])('reads the credential label from the viewer projection (%o)', async ({ readable, confirmation }) => {
    const accountId = 'credential-reviewer';
    const serverId = await harness.addHome({ name: 'Credential Home', serverUrl: 'https://credential-review.test', accountId, currentAccount: true });
    const resourceId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
    const credentialName = 'Studio model access';
    const resource = teamCredentialResourceFixture({ id: resourceId, displayName: credentialName });
    applyTeamCredentialResource({ scope: { serverId, accountId: readable ? accountId : 'unrelated-account' },
        address: { serverId, teamId: resource.teamId }, resource, observedAt: 1 });
    const actionId = 'teams.credentials.get';
    const props = { actionId, actionArgs: getActionSpec(actionId).inputSchema.parse({ resourceId }), preview: null,
        serverId, testID: 'credential-review' };
    const screen = await renderScreen(confirmation ? <ActionConfirmationReviewFacts {...props} />
        : <ApprovalReviewFacts {...props} status="open" />);
    try {
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain(readable ? credentialName : t('common.unavailable'));
            expect(screen.getTextContent()).not.toContain(resourceId);
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(resourceId);
    } finally { await screen.unmount(); }
});
