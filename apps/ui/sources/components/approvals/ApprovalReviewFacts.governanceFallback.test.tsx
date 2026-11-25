import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { renderScreen } from '@/dev/testkit';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

const teamId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
const accountId = 'f20c797b-449f-4aa6-8b89-01fcfcaed022';
const sessionId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';

it.each([
    { id: 'teams.archive', input: { v: 1, teamId }, exact: teamId },
    { id: 'teams.members.remove', input: { v: 1, teamId, membershipId: accountId }, exact: accountId },
    { id: 'home.accounts.disable', input: { accountId }, exact: accountId },
    { id: 'session.access.grant.remove', input: { sessionId, subject: { kind: 'account', accountId } }, exact: accountId },
] as const)('keeps an unreadable principal of $id in Technical details', async ({ id, input, exact }) => {
    const actionArgs = getActionSpec(id).inputSchema.parse(input);
    const screen = await renderScreen(<ApprovalReviewFacts actionId={id} actionArgs={actionArgs}
        preview={null} serverId={null} testID="governance-fallback" />);
    try {
        expect(screen.getTextContent()).toContain('—');
        expect(screen.getTextContent()).not.toContain(exact);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(exact);
    } finally { await screen.unmount(); }
});
