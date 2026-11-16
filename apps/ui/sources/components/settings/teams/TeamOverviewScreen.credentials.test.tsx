import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialResourceDiscoveryPageV1Schema } from '@happier-dev/protocol/teams';

import { collectRenderedTestIds, createDeferred, renderScreen, standardCleanup, teamCapabilitiesFixture, teamCredentialResourceFixture, teamCredentialViewerFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { t } from '@/text';

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
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
// Load the screen after transport boundaries, outside a test's interaction clock.
const { TeamOverviewScreen } = await import('./TeamOverviewScreen');

const TEAM_GET_PATH = '/v1/teams/get';
const CREDENTIALS_LIST_PATH = '/v1/teams/credential-resources/list';

async function renderOverview(serverId: string) {
    return renderScreen(<TeamOverviewScreen serverId={serverId} teamId="team-1" />);
}

async function addHome(options?: Readonly<{ credentialResourcesEnabled?: boolean }>): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
        credentialResourcesEnabled: options?.credentialResourcesEnabled ?? true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageMembers: true }) }),
    });
    harness.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, {
        body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [], nextCursor: null, failures: [] }),
    });
    return serverId;
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderOverview>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerPush.mockReset();
});

afterEach(() => {
    standardCleanup();
});

describe('TeamOverviewScreen shared-credentials destination', () => {
    it.each([false, true])('counts recipient shares once alongside administered resources (also administered=%s)', async (alsoAdministered) => {
        const serverId = await addHome();
        const resource = teamCredentialResourceFixture();
        const recipient = TeamCredentialResourceCatalogEntryV1Schema.parse({
            id: resource.id, teamId: resource.teamId, displayName: resource.displayName, resourceRevision: 1,
            sourcePresentation: resource.sourcePresentation,
            readiness: { kind: 'available' }, recoveryAction: 'source_owner_action', allowedRoutes: ['brokered'],
            mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
            sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [],
        });
        harness.answer(serverId, CREDENTIALS_LIST_PATH, { body: {
            resources: alsoAdministered ? [resource] : [],
            viewer: teamCredentialViewerFixture({ offerOwnCredential: true }),
        } });
        harness.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, { body:
            TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [recipient], nextCursor: null, failures: [] }),
        });

        const screen = await renderOverview(serverId);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(
            t('teams.overview.summary.credentialsShared', { count: 1 }),
        ));
        screen.pressByTestId('team-overview-credentials');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/credentials`);
    });

    it('offers the destination only once the Home projects resource authority', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: {
                resources: [teamCredentialResourceFixture()],
                viewer: teamCredentialViewerFixture({ manageCredentials: true, offerOwnCredential: true }),
            },
        });

        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-credentials');

        screen.pressByTestId('team-overview-credentials');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/credentials`);
    });

    it('offers the destination to a source-only viewer without exposing manager authority', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: { resources: [], viewer: teamCredentialViewerFixture({ offerOwnCredential: true }) },
        });

        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-members');

        await vi.waitFor(() => {
            expect(harness.requestsFor(CREDENTIALS_LIST_PATH).length).toBeGreaterThan(0);
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-overview-credentials');

        screen.pressByTestId('team-overview-credentials');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/credentials`);
    });

    it('does not claim empty before the recipient read settles or after it fails', async () => {
        const serverId = await addHome();
        harness.answer(serverId, CREDENTIALS_LIST_PATH, {
            body: { resources: [], viewer: teamCredentialViewerFixture({ offerOwnCredential: true }) },
        });
        const held = createDeferred<void>();
        harness.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, {
            respondAfter: held.promise,
            body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [], nextCursor: null, failures: [] }),
        });
        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-credentials');
        expect(screen.getTextContent()).not.toContain(t('teams.overview.summary.credentialsNone'));
        held.resolve();
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('teams.overview.summary.credentialsNone')));

        const { refreshTeamCredentialResourceCatalog } = await import('@/sync/engine/teams/teamsDirectoryEngine');
        harness.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, { dispatchThenFail: true });
        await refreshTeamCredentialResourceCatalog({ serverId, accountId: 'account-ada' }, { serverId, teamId: 'team-1' });
        await vi.waitFor(() => expect(screen.getTextContent()).not.toContain(t('teams.overview.summary.credentialsNone')));
    });

    it('asks nothing at all when the Home has not enabled shared credentials', async () => {
        const serverId = await addHome({ credentialResourcesEnabled: false });

        const screen = await renderOverview(serverId);
        await waitForTestId(screen, 'team-overview-members');

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-overview-credentials');
        expect(harness.requestsFor(CREDENTIALS_LIST_PATH)).toHaveLength(0);
    });
});
