import * as React from 'react';
import { TeamCredentialResourceActivityPageV1Schema } from '@happier-dev/protocol/teams';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen, standardCleanup, teamCapabilitiesFixture, teamCredentialDisplayNameFixture, teamCredentialResourceFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Load real owners after HTTP installation, outside a timed per-case setup.
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { TeamCredentialActivityScreen } = await import('./TeamCredentialActivityScreen');

const TEAM_GET_PATH = '/v1/teams/get';
const CREDENTIAL_GET_PATH = '/v1/teams/credential-resources/get';
const ACTIVITY_LIST_PATH = '/v1/teams/credential-resources/activity/list';

async function addHome(): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
        credentialResourcesEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
    });
    harness.answer(serverId, CREDENTIAL_GET_PATH, {
        body: teamCredentialResourceFixture({ id: 'resource-1' }),
    });
    return serverId;
}

async function renderActivity(serverId: string) {
    return renderScreen(
        <TeamCredentialActivityScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
    );
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderActivity>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    routerPush.mockReset();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
});

afterEach(() => standardCleanup());

describe('TeamCredentialActivityScreen', () => {
    it.each([
        ['audience_changed', 'audienceChanged', teamCredentialDisplayNameFixture('Engineering'), undefined],
        ['external_key_created', 'externalKeyCreated', teamCredentialDisplayNameFixture('Engineering'), '550e8400-e29b-41d4-a716-446655440000'],
    ])('renders only the Home-projected administrative metadata for %s', async (kind, label, subjectDisplayName, externalApiKeyId) => {
        const serverId = await addHome();
        harness.answer(serverId, ACTIVITY_LIST_PATH, {
            body: TeamCredentialResourceActivityPageV1Schema.parse({
                items: [{
                    kind,
                    actorDisplayName: 'Ada Lovelace',
                    subjectDisplayName,
                    ...(externalApiKeyId ? { externalApiKeyId } : {}),
                    createdAt: '2026-09-11T12:00:00.000Z',
                }],
                nextCursor: null,
            }),
        });

        const screen = await renderActivity(serverId);
        await waitForTestId(screen, 'team-credential-activity-row:0');
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('Engineering');
        });

        expect(screen.getTextContent()).toContain(`teams.credentials.activity.kind.${label}`);
        expect(screen.getTextContent()).toContain('Ada Lovelace');
        expect(screen.getTextContent()).toContain('Engineering');
        expect(screen.getTextContent()).not.toContain('secret');
    });

    it.each([
        { status: 400, error: 'invalid_resource_input', message: 'teams.credentials.errors.invalidResourceRead' },
        { status: 400, error: 'resource_corrupt', message: 'teams.credentials.activity.unreadable' },
        { status: 404, error: 'resource_not_found', message: 'teams.credentials.detail.notFound' },
        { status: 403, error: 'resource_forbidden', message: 'teams.credentials.forbidden' },
        { status: 403, error: 'team_authentication_required', message: 'teams.credentials.errors.teamAuthenticationRequired', destination: 'team' },
        { status: 403, error: 'team_forbidden', details: { reason: 'legacy_home_credential' }, message: 'teams.errors.signInOutdated', destination: 'account' },
        { status: 503, error: 'team_authentication_policy_unavailable', message: 'teams.credentials.externalApi.authenticationUnavailable' },
        { status: 503, error: 'feature_disabled', message: 'teams.credentials.errors.featureDisabled' },
    ])('presents the history refusal $error with its own recovery', async ({ status, error, details, message, destination }) => {
        const serverId = await addHome();
        harness.answer(serverId, ACTIVITY_LIST_PATH, { status, body: { error, ...(details ? { details } : {}) } });
        const screen = await renderActivity(serverId);

        await vi.waitFor(() => expect(screen.getTextContent()).toContain(message));
        expect(screen.findByTestId('team-credential-activity-retry')).toBeNull();
        if (destination) {
            await screen.pressByTestIdAsync('team-credential-activity-sign-in');
            expect(routerPush).toHaveBeenCalledWith(destination === 'account'
                ? '/settings/account' : expect.stringContaining(`/teams/team-1/sign-in?serverId=${serverId}`));
        } else {
            expect(screen.findByTestId('team-credential-activity-sign-in')).toBeNull();
        }
    });

    it('refreshes from page one after the Home rejects a history cursor', async () => {
        const serverId = await addHome();
        harness.answer(serverId, ACTIVITY_LIST_PATH, {
            body: TeamCredentialResourceActivityPageV1Schema.parse({
                items: [{
                    kind: 'resource_created', actorDisplayName: null,
                    subjectDisplayName: teamCredentialDisplayNameFixture('Acme Claude'),
                    createdAt: '2026-09-11T12:00:00.000Z',
                }],
                nextCursor: 'expired-activity-page',
            }),
        });
        const screen = await renderActivity(serverId);
        await waitForTestId(screen, 'team-credential-activity-load-more');
        harness.answer(serverId, ACTIVITY_LIST_PATH, { status: 400, body: { error: 'invalid_resource_input' } });
        await screen.pressByTestIdAsync('team-credential-activity-load-more');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('teams.errors.listCursorExpired'));
        expect(screen.findByTestId('team-credential-activity-retry')).toBeNull();

        harness.answer(serverId, ACTIVITY_LIST_PATH, { body: { items: [], nextCursor: null } });
        await screen.pressByTestIdAsync('team-credential-activity-reload');
        await waitForTestId(screen, 'team-credential-activity-empty');
        expect(harness.requestsFor(ACTIVITY_LIST_PATH).at(-1)?.input).not.toHaveProperty('cursor');
    });

    it('keeps the first activity page visible and retries its exact cursor', async () => {
        const serverId = await addHome();
        harness.answer(serverId, ACTIVITY_LIST_PATH, {
            body: TeamCredentialResourceActivityPageV1Schema.parse({
                items: [{
                    kind: 'resource_created',
                    actorDisplayName: 'Ada Lovelace',
                    subjectDisplayName: teamCredentialDisplayNameFixture('Acme Claude'),
                    createdAt: '2026-09-11T12:00:00.000Z',
                }],
                nextCursor: 'activity-page-2',
            }),
        });

        const screen = await renderActivity(serverId);
        await waitForTestId(screen, 'team-credential-activity-load-more');
        harness.answer(serverId, ACTIVITY_LIST_PATH, { status: 503, body: { error: 'unavailable' } });
        await screen.pressByTestIdAsync('team-credential-activity-load-more');
        await waitForTestId(screen, 'team-credential-activity-retry');
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('Acme Claude');
        });

        harness.answer(serverId, ACTIVITY_LIST_PATH, {
            body: TeamCredentialResourceActivityPageV1Schema.parse({
                items: [{
                    kind: 'limits_changed',
                    actorDisplayName: null,
                    subjectDisplayName: teamCredentialDisplayNameFixture('Monthly request limit'),
                    createdAt: '2026-09-11T13:00:00.000Z',
                }],
                nextCursor: null,
            }),
        });
        await screen.pressByTestIdAsync('team-credential-activity-retry');
        await waitForTestId(screen, 'team-credential-activity-row:1');
        expect(harness.requestsFor(ACTIVITY_LIST_PATH).at(-1)?.input).toMatchObject({
            resourceId: 'resource-1',
            cursor: 'activity-page-2',
        });
    });

    it('settles an initial resource-list failure and retries without opening activity early', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIAL_GET_PATH, { status: 503, body: { error: 'unavailable' } });
        harness.answer(serverId, ACTIVITY_LIST_PATH, { body: { items: [], nextCursor: null } });

        const screen = await renderActivity(serverId);
        await waitForTestId(screen, 'team-credential-activity-resource-retry');
        expect(harness.requestsFor(ACTIVITY_LIST_PATH)).toHaveLength(0);

        harness.answer(serverId, CREDENTIAL_GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-1' }),
        });
        await screen.pressByTestIdAsync('team-credential-activity-resource-retry');
        await waitForTestId(screen, 'team-credential-activity-empty');
    });
});
