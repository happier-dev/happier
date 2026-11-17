import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountDisplayProfileFixture, createDeferred, renderScreen, standardCleanup, teamCredentialResourceFixture, teamGroupFixture, teamMembershipFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import type { TeamSectionContext } from '../teamSectionContext';
import type { TeamCredentialResourceDraft } from './teamCredentialEditorDraft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
    storage: 'real',
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT } = await import('./teamCredentialEditorDraft');
const { TeamCredentialLimitsEditorSection } = await import('./TeamCredentialLimitsEditorSection');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    const serverId = await harness.addHome({ name: 'Limits Home', serverUrl: 'https://credential-limits.test', accountId: 'account-owner', teamsEnabled: true });
    context = { ...context, scope: { serverId, accountId: 'account-owner' }, address: { serverId, teamId: 'team-1' } };
    harness.answer(serverId, '/v1/teams/members/list', { body: { items: [], nextCursor: null } });
    harness.answer(serverId, '/v1/teams/groups/list', { body: { items: [], nextCursor: null } });
});

afterEach(() => standardCleanup());

let context: TeamSectionContext = {
    scope: { serverId: 'server-1', accountId: 'account-owner' },
    address: { serverId: 'server-1', teamId: 'team-1' },
    homeName: 'Limits Home',
    team: teamSummaryFixture(),
    mutationsAvailable: true,
    archived: false,
    canMutate: true,
    approvalPending: false,
    refresh: vi.fn(),
    requestApproval: vi.fn(),
    settleLeave: vi.fn(),
};

const usageCapabilities = {
    inferenceRequests: 'available',
    totalTokens: 'available',
    costUsd: 'unavailable',
    limitCoverage: 'brokered_only',
} as const;

async function mount(initial: TeamCredentialResourceDraft) {
    let latest = initial;
    function ControlledEditor() {
        const [draft, setDraft] = React.useState(initial);
        latest = draft;
        return (
            <TeamCredentialLimitsEditorSection
                context={context}
                resource={teamCredentialResourceFixture({ usageCapabilities })}
                usageCapabilities={usageCapabilities}
                draft={draft}
                busy={false}
                onRequestDraftChange={setDraft}
            />
        );
    }
    return { screen: await renderScreen(<ControlledEditor />), draft: () => latest };
}

describe('TeamCredentialLimitsEditorSection', () => {
    it('names each saved member and group rule in the list and when reopened', async () => {
        const firstPage = createDeferred<void>();
        harness.answer(context.scope.serverId, '/v1/teams/members/list', { body: { items: [
            teamMembershipFixture({ accountId: 'account-ada', account: accountDisplayProfileFixture('Ada') }),
        ], nextCursor: 'page-two' }, respondAfter: firstPage.promise });
        harness.answer(context.scope.serverId, '/v1/teams/groups/list', { body: { items: [teamGroupFixture({ id: 'group-platform', name: 'Platform' })], nextCursor: null } });
        const initial: TeamCredentialResourceDraft = {
            ...EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT,
            limits: [
                { id: 'ada', subjectKind: 'team_member', subjectId: 'account-ada', metric: 'inference_requests', period: 'month', maximum: '10', enabled: true },
                { id: 'maya', subjectKind: 'team_member', subjectId: 'account-maya', metric: 'inference_requests', period: 'month', maximum: '10', enabled: true },
                { id: 'platform', subjectKind: 'team_group', subjectId: 'group-platform', metric: 'inference_requests', period: 'month', maximum: '10', enabled: true },
            ],
        };
        const { screen } = await mount(initial);
        // The second target lives beyond page one; the owning roster must resolve it too.
        await vi.waitFor(() => expect(harness.requestsFor('/v1/teams/members/list')).toHaveLength(1));
        harness.answer(context.scope.serverId, '/v1/teams/members/list', { body: { items: [
            teamMembershipFixture({ id: 'membership-maya', accountId: 'account-maya', account: accountDisplayProfileFixture('Maya') }),
        ], nextCursor: null } });
        firstPage.resolve();
        const rowText = (id: string) => JSON.stringify(screen.findAllByTestId(id)[0]?.props);
        await vi.waitFor(() => expect(rowText('team-credential-limit-edit:ada')).toContain('Ada'));
        await vi.waitFor(() => expect(rowText('team-credential-limit-edit:maya')).toContain('Maya'));
        await vi.waitFor(() => expect(screen.findAllByTestId('team-credential-limit-edit:platform')[0]?.props.title)
            .toContain('Platform'));
        await screen.pressByTestIdAsync('team-credential-limit-edit:maya');
        expect(rowText('team-credential-limit-member-account:account-maya')).toContain('Maya');
        await screen.pressByTestIdAsync('team-credential-limit-cancel');
        await screen.pressByTestIdAsync('team-credential-limit-edit:platform');
        expect(screen.findAllByTestId('team-credential-limit-group:group-platform')[0]?.props.title).toBe('Platform');
    });

    it('keeps a group rule visible when its recipient label is unavailable', async () => {
        harness.answer(context.scope.serverId, '/v1/teams/groups/list', { body: {
            items: [teamGroupFixture({ id: 'group-unavailable', name: { kind: 'unavailable' } })],
            nextCursor: 'later',
        } });
        const initial: TeamCredentialResourceDraft = {
            ...EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT,
            limits: [{
                id: 'unavailable-group',
                subjectKind: 'team_group',
                subjectId: 'group-unavailable',
                metric: 'inference_requests',
                period: 'month',
                maximum: '10',
                enabled: true,
            }],
        };

        const { screen } = await mount(initial);

        await vi.waitFor(() => expect(screen.findAllByTestId('team-credential-limit-edit:unavailable-group')[0]?.props.title)
            .toContain('teams.credentials.limits.unknownSubject'));
        // A known group whose label cannot be opened is not a missing directory
        // row, so it must not consume another page merely to recover text.
        expect(harness.requestsFor('/v1/teams/groups/list')).toHaveLength(1);
    });

    it('edits and removes saved rules through the complete controlled resource draft', async () => {
        const initial = {
            ...EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT,
            limits: [{
                id: 'limit-existing',
                subjectKind: 'resource' as const,
                subjectId: '',
                metric: 'total_tokens' as const,
                period: 'month' as const,
                maximum: 'raw-invalid-value',
                enabled: false,
            }],
        };
        const { screen, draft } = await mount(initial);

        await screen.pressByTestIdAsync('team-credential-limit-edit:limit-existing');
        expect(draft().pendingLimit).toEqual(initial.limits[0]);
        expect(screen.findByTestId('team-credential-limit-maximum')?.props.value).toBe('raw-invalid-value');

        act(() => screen.changeTextByTestId('team-credential-limit-maximum', '250'));
        await screen.pressByTestIdAsync('team-credential-limit-save');
        expect(draft().limits).toEqual([{ ...initial.limits[0], maximum: '250' }]);
        expect(draft().limits[0]?.id).toBe('limit-existing');
        expect(draft().limits[0]?.enabled).toBe(false);

        await screen.pressByTestIdAsync('team-credential-limit-remove:limit-existing');
        expect(draft().limits).toEqual([]);
        expect(draft().name).toBe(initial.name);
        expect(draft().audience).toBe(initial.audience);
    });

    it('retries a failed principal read while preserving saved limits', async () => {
        harness.answer(context.scope.serverId, '/v1/teams/members/list', { status: 503 });
        const initial: TeamCredentialResourceDraft = {
            ...EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT,
            limits: [{ id: 'ada', subjectKind: 'team_member', subjectId: 'account-ada', metric: 'inference_requests', period: 'month', maximum: '10', enabled: true }],
        };
        const { screen, draft } = await mount(initial);
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-limit-members-retry')).not.toBeNull());
        expect(draft()).toEqual(initial);
        harness.answer(context.scope.serverId, '/v1/teams/members/list', { body: { items: [
            teamMembershipFixture({ accountId: 'account-ada', account: accountDisplayProfileFixture('Ada') }),
        ], nextCursor: null } });
        await screen.pressByTestIdAsync('team-credential-limit-members-retry');
        await vi.waitFor(() => expect(screen.findAllByTestId('team-credential-limit-edit:ada')[0]?.props.title).toContain('Ada'));
        expect(draft()).toEqual(initial);
    });

    it('adds a named-member rule with the picker actor Account id and only canonical metrics', async () => {
        const { screen, draft } = await mount(EMPTY_TEAM_CREDENTIAL_RESOURCE_DRAFT);

        await screen.pressByTestIdAsync('team-credential-limit-add');
        expect(screen.findByTestId('team-credential-limit-metric:inference_requests')).not.toBeNull();
        expect(screen.findByTestId('team-credential-limit-metric:total_tokens')).not.toBeNull();
        expect(screen.findByTestId('team-credential-limit-metric:cost_usd')).toBeNull();
        await screen.pressByTestIdAsync('team-credential-limit-subject:team_member');

        const picker = screen.tree.root.findAll((node) => (
            node.props.testID === 'team-credential-limit-member-choose'
            && typeof node.props.onChoose === 'function'
        ))[0];
        expect(picker).toBeDefined();
        act(() => picker!.props.onChoose({
            kind: 'member', id: 'membership-maya', accountId: 'account-maya', name: 'Maya',
        }));
        act(() => screen.changeTextByTestId('team-credential-limit-maximum', '10'));
        await screen.pressByTestIdAsync('team-credential-limit-save');

        expect(draft().limits).toEqual([expect.objectContaining({
            subjectKind: 'team_member',
            subjectId: 'account-maya',
            metric: 'inference_requests',
            maximum: '10',
        })]);
        expect(screen.findAllByTestId('team-credential-limit-edit:new-0')[0]?.props.title).toContain('Maya');
        await screen.pressByTestIdAsync('team-credential-limit-edit:new-0');
        expect(screen.findAllByTestId('team-credential-limit-member-account:account-maya')[0]?.props.title).toBe('Maya');
    });
});
