import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { teamDirectorySourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
const { captureServerCredentialAccountScopeLifetime, resolveServerCredentialAccountScope } =
    await import('@/sync/domains/scope/serverCredentialAccountScope');
const { managedIdentityQueryKey } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
const { teamDirectorySourcePages } = await import('@/sync/store/teams/teamsSnapshots');

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(async () => { standardCleanup(); await harness.reset(); });

it.each(['active', 'paused', 'other Account'] as const)('reviews a directory sync against the scoped source name (%s)', async state => {
    const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://directory-review.test', accountId: 'reviewer' });
    const resolution = await resolveServerCredentialAccountScope(home);
    if (resolution.kind !== 'bound') throw new Error('Missing reviewer credentials');
    const binding = captureServerCredentialAccountScopeLifetime(resolution);
    const source = teamDirectorySourceFixture({ id: '9e9b44d4-2167-4837-adb5-92dc43f3b481', displayName: 'Research directory',
        state: state === 'paused' ? 'paused' : 'active' });
    const scope = state === 'other Account' ? { ...binding.scope, accountId: 'other' } : binding.scope;
    teamDirectorySourcePages.apply(managedIdentityQueryKey(scope, source.teamId), binding, { items: [source], nextCursor: null });
    const actionId = 'teams.directory.sources.sync';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ v: 1, teamId: source.teamId, sourceId: source.id });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={home} testID="directory-review" />);
    try {
        await waitForHomeGovernance(() => {
            const text = screen.getTextContent();
            expect(text).not.toContain(source.id);
            if (state === 'other Account') {
                expect(text).not.toContain(source.displayName);
                expect(text).toContain(t('common.unavailable'));
            } else expect(text).toContain(source.displayName);
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(source.id);
    } finally { await screen.unmount(); }
});

it('labels the owners and admins roster filter', async () => {
    const actionId = 'teams.members.list';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ v: 1, teamId: 'research-team', filter: 'owners_admins', query: 'Ada' });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={null} testID="member-roster-review" />);
    try {
        const text = screen.getTextContent();
        expect(text).toContain(t('teams.members.filterOwnersAndAdmins'));
        expect(text).toContain('Ada');
        expect(text).not.toContain('owners_admins');
    } finally { await screen.unmount(); }
});
