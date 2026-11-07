import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';

import { renderScreen, standardCleanup, teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit';
import { answerTeamCredentialDiscoveryForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { connectedServicesModuleState, installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';

// P8 / O-COLUMNS-R3: Team-shared rows belong to the All services overview.
installConnectedServicesCommonModuleMocks({ searchParams: { view: 'all' } });
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();

// Load the real runtime after its boundaries, during collection rather than inside a timed hook.
const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getTeamCredentialResourceCatalogSnapshot, resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { storage } = await import('@/sync/domains/state/storage');

beforeEach(async () => {
    connectedServicesModuleState.searchParams = { view: 'all' };
    await home.reset();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
});
afterEach(standardCleanup);

it.each([
    { title: 'shows entitled shared accounts before the recipient has a Machine or a personal service', sourceKind: 'connected_service' },
    { title: 'keeps first-run setup when the recipient is entitled only to Provider resources', sourceKind: 'provider' },
    { title: 'keeps first-run setup when the recipient catalog is empty', sourceKind: 'empty' },
] as const)('$title', async ({ sourceKind }) => {
    const serverId = await home.addHome({ name: 'Home', serverUrl: 'https://qa.example', accountId: 'recipient',
        teamsEnabled: true, credentialResourcesEnabled: true });
    await home.selectHomes([serverId]);
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://qa.example', generation: 0 });
    // Sync has admitted an empty recipient Account; no Machine or personal service is required.
    storage.setState({ profileScope: { serverId, accountId: 'recipient' },
        settingsScope: { serverId, accountId: 'recipient' }, isDataReady: true, machines: {} });
    home.answer(serverId, '/v1/teams/list', { body: { items: [teamSummaryFixture({
        capabilities: teamCapabilitiesFixture({}),
    })], nextCursor: null } });
    const shared = TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: 'shared-claude', teamId: 'team-1', displayName: 'Team Claude', resourceRevision: 0,
        readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
        directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [],
        connectedServiceSelections: [],
        sourcePresentation: sourceKind === 'provider'
            ? { kind: 'provider', provider: { identity: { pluginId: 'happier.provider.openrouter', localId: 'openrouter' }, definitionRevision: 1 } }
            : { kind: 'connected_service', service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } },
    });
    const resources = sourceKind === 'empty' ? [] : [shared];
    answerTeamCredentialDiscoveryForTests(home, serverId, input => ({
        resources: resources.filter(resource => input.teamIds.includes(resource.teamId)), nextCursor: null, failures: [],
    }));
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://qa.example');
    expect(credentials).not.toBeNull();
    const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
    const { router } = await import('expo-router');
    const screen = await renderScreen(<DestinationInstanceContext.Provider value={{ tabId: 'services-overview',
        ref: { kind: 'settings', params: { view: 'all' } }, pathname: '/settings/connected-services',
        focused: true, isFocused: () => true, visible: true, navigation: router,
    }}><InjectedAuthProvider credentials={{ token: credentials!.token }}>
        <ConnectedServicesSettingsView />
    </InjectedAuthProvider></DestinationInstanceContext.Provider>);
    await waitForHomeGovernance(() => expect(getTeamCredentialResourceCatalogSnapshot(
        { serverId, accountId: 'recipient' }, { serverId, teamId: 'team-1' },
    )?.data).toEqual(resources));
    await act(async () => {});
    expect(home.requestsFor(TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1)).not.toHaveLength(0);
    if (sourceKind === 'connected_service') {
        expect(screen.findByTestId('team-credential-catalog-resource:team-1:shared-claude')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Team Claude');
        expect(screen.findByTestId('connected-services-empty')).toBeNull();
    } else {
        expect(screen.findByTestId('team-credential-catalog-resource:team-1:shared-claude')).toBeNull();
        expect(screen.findByTestId('connected-services-empty') ?? screen.findByTestId('connected-services-first-run')).not.toBeNull();
    }
});
