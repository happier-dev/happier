import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));
installSettingsViewCommonModuleMocks({
    storage: async (importOriginal) => await importOriginal(),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ params: () => routeParams.value, navigation: { setOptions: () => undefined } }).module;
    },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { TeamAuthenticationSettingsScreen } = await import('./TeamAuthenticationSettingsScreen');
const { IdentityConnectionDetailScreen } = await import('./IdentityConnectionDetailScreen');
const { DirectorySyncSettingsScreen } = await import('./DirectorySyncSettingsScreen');
const { t } = await import('@/text');

beforeEach(async () => {
    standardCleanup();
    routeParams.value = {};
    const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
    resetTeamsSnapshotsForTests();
    await harness.reset();
});
afterEach(() => standardCleanup());

describe('Team identity settings search', () => {
    it.each([
        ['authentication', 'teams.authentication.acceptedMethods', 'teams.authentication.accepted'],
        ['connection', 'teams.identityConnection.disable', 'teams.identityConnection.actions'],
        ['directory', 'teams.directory.workosSetup', 'teams.directory.actions'],
    ] as const)('reveals the %s access state without reading denied identity data', async (surface, anchor, section) => {
        const serverId = await harness.addHome({
            name: 'Denied identity Home', serverUrl: 'https://denied-identity.example', accountId: 'identity-viewer', teamsEnabled: true,
        });
        harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageAuthentication: false }) }) });
        routeParams.value = { setting: anchor };
        const screen = await renderScreen(surface === 'authentication'
            ? <TeamAuthenticationSettingsScreen serverId={serverId} teamId="team-1" />
            : surface === 'connection'
                ? <IdentityConnectionDetailScreen serverId={serverId} teamId="team-1" connectionId="connection-1" />
                : <DirectorySyncSettingsScreen serverId={serverId} teamId="team-1" />);

        // The denied state is asserted by its owner's identity, not its wording.
        const forbiddenTitle = t('teams.errors.forbidden');
        await waitForHomeGovernance(() => (surface === 'authentication'
            ? expect(screen.findByTestId('team-authentication-forbidden')).not.toBeNull()
            : expect(screen.findAllByProps({ title: forbiddenTitle }).length).toBeGreaterThan(0)));
        // First establish that the destination exists; a missing anchor should
        // fail here rather than consuming the runner's whole reveal wait.
        expect(screen.findAllByProps({ nativeID: `setting-section-${section}` }).length).toBeGreaterThan(0);
        await waitForHomeGovernance(() => expect(screen.findByTestId(`setting-reveal.${section}`)).not.toBeNull());
        expect(harness.requests.some((request) => request.path.includes('/identity') || request.path.includes('/directory'))).toBe(false);
    });
});
