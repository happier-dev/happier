import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    collectRenderedTestIds,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    renderScreen,
    standardCleanup,
    teamCapabilitiesFixture,
    teamCredentialResourceFixture,
    teamSummaryFixture,
} from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

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
    const { TeamCredentialActivityScreen } = await import('./TeamCredentialActivityScreen');
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
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
    const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
});

afterEach(() => standardCleanup());

describe('TeamCredentialActivityScreen', () => {
    it.each([
        ['audience_changed', 'audienceChanged'],
        ['external_key_created', 'externalKeyCreated'],
    ])('renders only the Home-projected administrative metadata for %s', async (kind, label) => {
        const serverId = await addHome();
        harness.answer(serverId, ACTIVITY_LIST_PATH, {
            body: {
                items: [{
                    kind,
                    actorDisplayName: 'Ada Lovelace',
                    subjectDisplayName: 'Engineering',
                    createdAt: '2026-09-11T12:00:00.000Z',
                }],
                nextCursor: null,
            },
        });

        const screen = await renderActivity(serverId);
        await waitForTestId(screen, 'team-credential-activity-row:0');

        expect(screen.getTextContent()).toContain(`teams.credentials.activity.kind.${label}`);
        expect(screen.getTextContent()).toContain('Ada Lovelace');
        expect(screen.getTextContent()).toContain('Engineering');
        expect(screen.getTextContent()).not.toContain('secret');
    });

    it('keeps the first activity page visible and retries its exact cursor', async () => {
        const serverId = await addHome();
        harness.answer(serverId, ACTIVITY_LIST_PATH, {
            body: {
                items: [{
                    kind: 'resource_created',
                    actorDisplayName: 'Ada Lovelace',
                    subjectDisplayName: 'Acme Claude',
                    createdAt: '2026-09-11T12:00:00.000Z',
                }],
                nextCursor: 'activity-page-2',
            },
        });

        const screen = await renderActivity(serverId);
        await waitForTestId(screen, 'team-credential-activity-load-more');
        harness.answer(serverId, ACTIVITY_LIST_PATH, { status: 503, body: { error: 'unavailable' } });
        await screen.pressByTestIdAsync('team-credential-activity-load-more');
        await waitForTestId(screen, 'team-credential-activity-retry');
        expect(screen.getTextContent()).toContain('Acme Claude');

        harness.answer(serverId, ACTIVITY_LIST_PATH, {
            body: {
                items: [{
                    kind: 'limits_changed',
                    actorDisplayName: null,
                    subjectDisplayName: 'Monthly request limit',
                    createdAt: '2026-09-11T13:00:00.000Z',
                }],
                nextCursor: null,
            },
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
