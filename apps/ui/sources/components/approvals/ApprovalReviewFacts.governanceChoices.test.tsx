import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { TEAM_POLICY_SET_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

beforeEach(async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
});
afterEach(() => { standardCleanup(); setPreferredLanguageFromSettings('en'); });

it('uses the Team settings choices to describe the policy change', async () => {
    const actionId = TEAM_POLICY_SET_ACTION_ID_V1;
    const actionArgs = getActionSpec(actionId).inputSchema.parse({
        v: 1, teamId: 'research', sessionCreationPolicy: 'team_required', reviewCreationPolicy: 'team_default',
        externalSharingPolicy: 'team_admins_only', admissionMode: 'invite_only', defaultSessionHistoryAccess: 'from_membership',
    });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} serverId={null} testID="governance-review" />);
    try {
        const text = screen.getTextContent();
        for (const key of ['teams.settings.option.alwaysShared', 'teams.settings.option.shared', 'teams.settings.option.admins',
            'teams.authentication.policy.admissionInviteOnly', 'teams.settings.option.fromJoining'] as const) {
            expect(text).toContain(t(key));
        }
        for (const code of ['team_required', 'team_default', 'team_admins_only', 'invite_only', 'from_membership']) {
            expect(text).not.toContain(code);
        }
        setPreferredLanguageFromSettings('en');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('teams.settings.option.alwaysShared')));
    } finally { await screen.unmount(); }
});

it.each([
    { actionId: 'home.policy.set', input: { expectedRevision: 1, teamCreationPolicy: 'managed_only',
        authenticationPolicy: { v: 1, admission: 'invitation_only', storagePolicy: 'required_e2ee' } },
        keys: ['homeGovernance.teamCreationManagedOnly', 'homeGovernance.admissionInvitationOnly', 'homeGovernance.signInPolicy.storageRequired'],
        codes: ['managed_only', 'invitation_only', 'required_e2ee'] },
    { actionId: 'teams.members.add', input: { v: 1, teamId: 'research', accountId: 'ada', role: 'admin', historyAccess: 'all_existing' },
        keys: ['teams.role.admin', 'teams.settings.option.earlierToo'], codes: ['all_existing'] },
] as const)('uses the existing settings labels in $actionId', async ({ actionId, input, keys, codes }) => {
    const actionArgs = getActionSpec(actionId).inputSchema.parse(input);
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} serverId={null} testID="governance-review" />);
    try {
        const body = screen.getTextContent();
        for (const key of keys) expect(body).toContain(t(key));
        for (const code of codes) expect(body).not.toContain(code);
    } finally { await screen.unmount(); }
});
