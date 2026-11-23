import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { TEAM_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

const team = { kind: 'team', teamId: '3d703df7-5a51-4be7-91ec-dc877ae861ab', name: 'Design studio' };
const person = { kind: 'account', accountId: 'f20c797b-449f-4aa6-8b89-01fcfcaed022', name: 'Ada Lovelace',
    firstName: null, lastName: null, username: 'ada', avatarUrl: null };
const sessionId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
const contextAction = 'session.access.context.set';

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(() => standardCleanup());

it.each([
    { name: 'a Session’s primary Team', actionId: contextAction, input: { sessionId, primaryTeamId: team.teamId },
        visible: () => team.name, hidden: team.teamId },
    { name: 'the cleared primary Team choice', actionId: contextAction, input: { sessionId, primaryTeamId: null },
        visible: () => t('session.access.contextChangeSummary'), absent: () => t('session.access.private') },
    { name: 'the initial Team owner', actionId: TEAM_CREATE_ACTION_ID_V1,
        input: { v: 1, name: 'Research team', initialOwnerAccountId: person.accountId, requestKey: 'create-research' },
        visible: () => person.name, hidden: person.accountId },
    { name: 'a cleared Team description', actionId: 'teams.update',
        input: { v: 1, teamId: team.teamId, description: null }, visible: () => `Description ${t('common.none')}` },
    { name: 'a spawned Session’s primary Team', actionId: SESSION_SPAWN_NEW_ACTION_ID_V1,
        input: { executionTarget: { serverId: 'home', machineId: 'workstation' }, directory: { kind: 'managed' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            primaryTeamId: team.teamId }, visible: () => team.name, hidden: team.teamId },
] as const)('shows $name in the real review body', async ({ actionId, input, visible, ...testCase }) => {
    const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://governance-review.test', accountId: 'reviewer' });
    harness.answer(home, 'POST /v1/session-access/principals/resolve', {
        select: input => ({ body: { v: 1, principals: (input as { subjects: { kind: string }[] }).subjects
            .map(subject => subject.kind === 'team' ? team : person) } }),
    });
    const spec = getActionSpec(actionId);
    const actionArgs = spec.inputSchema.parse(input);
    const preview = actionId === contextAction ? { summary: buildApprovalPreviewSummary(spec, actionArgs) } : null;
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={preview} serverId={home} testID="governance-review" />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(visible()));
        if ('absent' in testCase) expect(screen.getTextContent()).not.toContain(testCase.absent());
        if ('hidden' in testCase) expect(screen.getTextContent()).not.toContain(testCase.hidden);
    } finally { await screen.unmount(); }
});

it('keeps the unreadable primary Team identity in Technical details', async () => {
    const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://governance-review.test', accountId: 'reviewer' });
    harness.answer(home, 'POST /v1/session-access/principals/resolve', { body: { v: 1, principals: [] } });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={contextAction}
        actionArgs={{ sessionId, primaryTeamId: team.teamId }} preview={null} serverId={home} testID="governance-review" />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(`${t('session.access.context')} ${t('common.unavailable')}`));
        expect(screen.getTextContent()).not.toContain(team.teamId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(team.teamId);
    } finally { await screen.unmount(); }
});

it.each([{ primaryTeamId: null }, { primaryTeamId: team.teamId }])(
    'shows the committed Team grant after setting primaryTeamId to $primaryTeamId',
    async ({ primaryTeamId }) => {
        const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://governance-review.test', accountId: 'reviewer' });
        harness.answer(home, 'POST /v1/session-access/principals/resolve', { body: { v: 1, principals: [] } });
        const screen = await renderScreen(<ApprovalReviewFacts actionId={contextAction} actionArgs={{ sessionId, primaryTeamId }}
            preview={null} serverId={home} testID="governance-review" status="executed"
            execution={{ ok: true, executedAtMs: 1,
                result: { changed: true, primaryTeamId, teamGrants: [{ teamId: team.teamId, name: team.name, accessLevel: 'edit' }] } }} />);
        try {
            expect(screen.getTextContent()).toContain(`${team.name} — ${t('session.access.edit')}`);
            expect(screen.getTextContent()).not.toContain(t('session.access.private'));
        } finally { await screen.unmount(); }
    },
);
