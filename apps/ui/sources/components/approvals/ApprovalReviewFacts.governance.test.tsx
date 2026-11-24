import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { TEAM_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { accountDisplayProfileFixture, homeAccountDetailFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
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
const ownerInput = { v: 1, name: 'Research team', initialOwnerAccountId: person.accountId, requestKey: 'create-research' };
const homeAccount = homeAccountDetailFixture(person.accountId, { profile: accountDisplayProfileFixture(person.name, { username: 'ada' }) });

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(() => {
    setPreferredLanguageFromSettings('en');
    standardCleanup();
});

it.each([
    { name: 'a Session’s primary Team', actionId: contextAction, input: { sessionId, primaryTeamId: team.teamId },
        visible: () => team.name, hidden: team.teamId },
    { name: 'the cleared primary Team choice', actionId: contextAction, input: { sessionId, primaryTeamId: null },
        visible: () => t('session.access.contextChangeSummary'), absent: () => t('session.access.private') },
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

it.each([
    { viewer: 'unrelated Home admin', related: false, admin: true, name: person.name },
    { viewer: 'unrelated Home member', related: false, admin: false, name: null },
    { viewer: 'related Home admin requester', related: true, admin: true, name: person.name },
    { viewer: 'related Home member', related: true, admin: false, name: null },
])('presents the initial Team owner to a $viewer using that viewer’s read authority', async ({ related, admin, name }) => {
    const home = await harness.addHome({ name: 'Managed Home', serverUrl: 'https://governance-review.test', accountId: 'reviewer' });
    harness.answer(home, 'POST /v1/session-access/principals/resolve', { body: { v: 1, principals: related ? [person] : [] } });
    harness.answer(home, 'POST /v1/home/accounts/get', {
        select: input => {
            if (!admin) return { status: 403, body: { error: 'home_governance_forbidden' } };
            return (input as { accountId?: string }).accountId === person.accountId
                ? { body: homeAccount } : { status: 404, body: { error: 'home_account_not_found' } };
        },
    });
    const actionArgs = getActionSpec(TEAM_CREATE_ACTION_ID_V1).inputSchema.parse(ownerInput);
    const screen = await renderScreen(<ApprovalReviewFacts actionId={TEAM_CREATE_ACTION_ID_V1} actionArgs={actionArgs}
        preview={null} serverId={home} testID="governance-review" />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(name ?? t('common.unavailable')));
        if (name === null) expect(screen.getTextContent()).not.toContain(person.name);
        expect(screen.getTextContent()).not.toContain(person.accountId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(person.accountId);
    } finally { await screen.unmount(); }
});

it.each([
    { actionId: 'home.accounts.role.set', input: { accountId: person.accountId, homeRole: 'admin' } },
    { actionId: 'teams.members.add', input: { v: 1, teamId: team.teamId,
        accountId: person.accountId, role: 'member', historyAccess: 'from_membership' } },
] as const)('names an unrelated Home Account in a $actionId review', async ({ actionId, input }) => {
    const home = await harness.addHome({ name: 'Managed Home', serverUrl: 'https://governance-review.test', accountId: 'reviewer' });
    harness.answer(home, 'POST /v1/session-access/principals/resolve', { body: { v: 1, principals: [] } });
    harness.answer(home, 'POST /v1/home/accounts/get', { body: homeAccount });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId}
        actionArgs={getActionSpec(actionId).inputSchema.parse(input)} preview={null} serverId={home} testID="governance-review" />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(person.name));
        expect(screen.getTextContent()).not.toContain(person.accountId);
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

const retainedTeamGrant = { teamId: team.teamId, name: team.name, accessLevel: 'edit' };

it.each([
    { scenario: 'set with a direct Team grant', primaryTeamId: team.teamId, grants: [retainedTeamGrant], readable: true,
        summary: 'Now in Design studio' },
    { scenario: 'clear with a kept grant', primaryTeamId: null, grants: [retainedTeamGrant], readable: true,
        summary: 'Team cleared' },
    { scenario: 'clear with no direct Team grants', primaryTeamId: null, grants: [], readable: true,
        summary: 'Team cleared' },
    { scenario: 'set to an unreadable Team with no direct Team grants', primaryTeamId: team.teamId, grants: [], readable: false,
        summary: 'Now in Unavailable' },
    { scenario: 'set without the grant projection', primaryTeamId: team.teamId, grants: undefined, readable: true, summary: null },
    { scenario: 'clear with a malformed grant projection', primaryTeamId: null, grants: [{ ...retainedTeamGrant, accessLevel: 'invalid' }],
        readable: true, summary: null },
    { scenario: 'an executed receipt without results', primaryTeamId: null, grants: undefined, readable: true, summary: null, receiptOnly: true },
    { scenario: 'set to a named Team in French', primaryTeamId: team.teamId, grants: [], readable: true,
        summary: 'Désormais dans Design studio', language: 'fr' },
    { scenario: 'clear with a kept grant in French', primaryTeamId: null, grants: [retainedTeamGrant], readable: true,
        summary: 'Équipe principale désélectionnée', language: 'fr' },
] as const)('shows the settled Team summary with the committed access for $scenario', async testCase => {
    const { primaryTeamId, grants, readable, summary } = testCase;
    if ('language' in testCase) {
        await preloadTranslations(testCase.language);
        setPreferredLanguageFromSettings(testCase.language);
    }
    const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://governance-review.test', accountId: 'reviewer' });
    harness.answer(home, 'POST /v1/session-access/principals/resolve', { body: { v: 1, principals: readable ? [team] : [] } });
    const request = { actionId: contextAction, actionArgs: { sessionId, primaryTeamId }, status: 'executed' as const,
        execution: 'receiptOnly' in testCase ? undefined : { ok: true as const, executedAtMs: 1,
            result: { changed: true, primaryTeamId, ...(grants === undefined ? {} : { teamGrants: grants }) } } };
    const screen = await renderScreen(<ApprovalReviewFacts {...request} preview={null} serverId={home} testID="governance-review" />);
    try {
        if (summary === null) {
            expect(screen.findByTestId('governance-review.preview')).toBeNull();
        } else {
            const access = grants?.length ? `${team.name} — ${t('session.access.edit')}` : t('session.access.noDirectTeamGrants');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(`${summary}\n${access}`));
            expect(screen.getTextContent()).not.toContain(t('session.access.private'));
            expect(screen.getTextContent()).not.toContain(team.teamId);
        }
    } finally { await screen.unmount(); }
});
