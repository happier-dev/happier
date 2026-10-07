import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_PROTOCOLS_V1 } from '@happier-dev/protocol';

import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    teamCapabilitiesFixture,
    teamCredentialResourceFixture,
    teamCredentialViewerFixture,
    teamSummaryFixture,
} from '@/dev/testkit/fixtures/teamFixtures';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalConfirm = vi.hoisted(() => vi.fn(async () => true));
const routerPush = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm: modalConfirm } }).module;
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.doUnmock('@/sync/domains/state/storage');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');

const TEAM_GET_PATH = '/v1/teams/get';
const LIST_PATH = '/v1/teams/credential-resources/list';
const GET_PATH = '/v1/teams/credential-resources/get';
const ENTITLED_LIST_PATH = '/v1/teams/credential-resources/entitled/list';
const UPDATE_PATH = '/v1/teams/credential-resources/update';
const PREPARATION_LIST_PATH = '/v2/teams/team-1/credential-resources/resource-1/direct-material?view=census';
const ARTIFACT_CREATE_PATH = '/v1/artifacts';

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    modalConfirm.mockReset();
    modalConfirm.mockResolvedValue(true);
    routerPush.mockReset();
});

afterEach(standardCleanup);

describe('TeamCredentialDetailScreen', () => {
    it('renders a deep-linked administration resource that is absent from the first list page', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, LIST_PATH, {
            body: {
                resources: Array.from({ length: 50 }, (_, index) => teamCredentialResourceFixture({
                    id: `resource-${index + 1}`,
                    displayName: `Credential ${index + 1}`,
                })),
                nextCursor: 'page-2',
                viewer: teamCredentialViewerFixture({ manageCredentials: true }),
            },
        });
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-51', displayName: 'Deep-linked credential' }),
        });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-51" />,
        );
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-state')).not.toBeNull());

        expect(screen.getTextContent()).toContain('Deep-linked credential');
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(0);
        expect(harness.requestsFor(GET_PATH)).toHaveLength(1);
    });

    it.each([
        {
            name: 'disabled',
            home: { credentialResourcesExternalApiEnabled: false },
        },
        {
            name: 'missing its deployment capability',
            home: { credentialResourcesExternalApiEnabled: true },
        },
    ])('does not offer External API navigation when the capability is $name', async ({ home }) => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
            ...home,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-1' }),
        });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-state')).not.toBeNull());

        expect(screen.findByTestId('team-credential-open-external-api')).toBeNull();
    });

    it('keeps the External API recovery destination visible when only public HTTPS is unavailable', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
            credentialResourcesExternalApiEnabled: true,
            credentialResourcesExternalApiAvailability: {
                available: false,
                reason: 'home_not_public_https',
            },
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-1' }),
        });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-open-external-api')).not.toBeNull());

        expect(JSON.stringify(screen.tree.toJSON()))
            .toContain('teams.credentials.externalApi.publicHttpsRequired');
        screen.pressByTestId('team-credential-open-external-api');
        expect(routerPush).toHaveBeenCalledWith(
            `/settings/teams/${serverId}/team-1/credentials/resource-1/external-api`,
        );
    });

    it('makes saved Pool broker connection semantics visible to assistive technology', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({
                    brokerPlacement: { kind: 'machine_pool', poolId: 'pool-development' },
                    brokerPresentation: {
                        selectedTarget: null,
                        eligibleTargets: [],
                        selectedPool: {
                            poolId: 'pool-development',
                            displayName: 'Development',
                            availability: 'available',
                            availableMachineCount: 2,
                        },
                        eligiblePools: [],
                    },
                }),
        });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credential-broker'));

        const brokerRow = screen.findAllByTestId('team-credential-broker')[0];
        expect(brokerRow?.props.subtitle).toBe('machinePools.connectionSemantics');
        expect(brokerRow?.props.accessibilityLabel).toContain('machinePools.connectionSemantics');
    });

    it('renders an entitled recipient from the least-privilege catalog and opens exact-Home usage and external keys', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-maya',
            teamsEnabled: true, credentialResourcesEnabled: true,
            credentialResourcesExternalApiEnabled: true,
            credentialResourcesExternalApiAvailability: { available: true, baseUrl: 'https://home-a.example/api/provider-broker/v1', protocols: [...TEAM_CREDENTIAL_EXTERNAL_PROVIDER_PROTOCOLS_V1] },
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ name: 'Acme', capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, LIST_PATH, {
            body: { resources: [], viewer: teamCredentialViewerFixture({ manageCredentials: false }) },
        });
        harness.answer(serverId, ENTITLED_LIST_PATH, {
            body: {
                resources: [{
                    id: 'resource-1', teamId: 'team-1', displayName: 'Acme Provider', resourceRevision: 7,
                    readiness: { kind: 'available' }, recoveryAction: null,
                    mayBroker: true, mayReceiveDirect: true, directMaterialState: 'stale',
                    sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [],
                    sourcePresentation: {
                        kind: 'provider',
                        provider: {
                            identity: { pluginId: 'happier.provider.openrouter', localId: 'openrouter' },
                            definitionRevision: 1,
                        },
                    },
                }],
            },
        });
        harness.answer(serverId, GET_PATH, { status: 404, body: { error: 'not_found_or_not_visible' } });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('team-credential-recipient-source'));

        expect(screen.getTextContent()).toContain('Acme Provider');
        expect(screen.getTextContent()).toContain('teams.credentials.directReadiness.state.sourceChanged');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credential-open-edit');
        screen.pressByTestId('team-credential-recipient-open-usage');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/credentials/resource-1/usage`);
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-open-external-api')).not.toBeNull());
        await screen.pressByTestIdAsync('team-credential-open-external-api');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/credentials/resource-1/external-api`);
    });

    it('treats an absent resource as revoked only after the recipient catalog is current', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-maya',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }) });
        harness.answer(serverId, LIST_PATH, {
            body: { resources: [], viewer: teamCredentialViewerFixture({ manageCredentials: false }) },
        });
        harness.answer(serverId, ENTITLED_LIST_PATH, { body: { resources: [] } });
        harness.answer(serverId, GET_PATH, { status: 404, body: { error: 'not_found_or_not_visible' } });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-revoked" />,
        );
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('team-credential-not-found'));
        expect(screen.getTextContent()).toContain('teams.credentials.detail.notFound');
    });
    it('shows the preparation refresh only to the source owner when direct delivery needs preparation', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({
                    custodianAccountId: 'account-ada',
                    disclosureCeiling: 'direct_allowed',
                    allMembersDeliveryMode: 'direct',
                    readiness: { kind: 'source_unavailable' },
                    recoveryAction: 'source_owner_action',
                }),
        });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('team-credential-preparation-refresh'));

        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({
                    custodianAccountId: 'account-other', source: null,
                    disclosureCeiling: 'direct_allowed', allMembersDeliveryMode: 'direct',
                    readiness: { kind: 'source_unavailable' }, recoveryAction: 'source_owner_action',
                    capabilities: {
                        manageAudience: true, managePolicy: true, manageLimits: true,
                        updateBrokerPlacement: false, narrowDisclosure: false, widenDisclosure: false,
                        refreshDirectMaterial: false, disable: true, enable: true, delete: true,
                    },
                }),
        });
        const { refreshTeamCredentialResource } = await import('@/sync/engine/teams/teamsDirectoryEngine');
        await refreshTeamCredentialResource(
            { serverId, accountId: 'account-ada' }, { serverId, teamId: 'team-1' }, 'resource-1',
        );
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .not.toContain('team-credential-preparation-refresh'));
    });

    it('uses source operation capabilities when manager-only audience and policy fields are masked', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({
                    allMembersDeliveryMode: null,
                    groupGrants: [],
                    memberGrants: [],
                    requestPolicy: null,
                    capabilities: {
                        manageAudience: false, managePolicy: false, manageLimits: false,
                        updateBrokerPlacement: true, narrowDisclosure: true, widenDisclosure: false,
                        refreshDirectMaterial: true, disable: true, enable: false, delete: true,
                    },
                }),
        });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('team-credential-open-edit'));

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-credential-preparation-refresh');
        expect(ids).not.toContain('team-credential-use-policy');
        expect(ids).not.toContain('team-credential-open-request-policy');
    });

    it('does not offer Edit when the Team lifecycle makes the destination read-only', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ archivedAt: 1, capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({
                    capabilities: {
                        manageAudience: false, managePolicy: false, manageLimits: false,
                        updateBrokerPlacement: true, narrowDisclosure: true, widenDisclosure: false,
                        refreshDirectMaterial: false, disable: false, enable: false, delete: false,
                    },
                }),
        });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('team-credential-state'));

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-credential-open-edit');
    });

    it('checks the material-safe source-owner census through the gated resource read', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({
                    disclosureCeiling: 'direct_allowed', allMembersDeliveryMode: 'direct',
                }),
        });
        harness.answer(serverId, PREPARATION_LIST_PATH, {
            body: {
                resourceRevision: 3, sourceOwner: true,
                recipients: [{ recipientAccountId: 'account-maya', readiness: 'preparing' }],
                nextCursor: null,
            },
        });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('team-credential-preparation-refresh'));
        await screen.pressByTestIdAsync('team-credential-preparation-refresh');

        await vi.waitFor(() => expect(harness.requestsFor(PREPARATION_LIST_PATH)).toHaveLength(1));
        // The catalog mounts these strings at `session.access.*`; the old `sessionAccess.*`
        // spelling resolved to nothing and rendered the raw key to the admin.
        expect(JSON.stringify(screen.tree.toJSON())).toContain('session.access.preparationPending(count=1)');
    });

    it('does not apply a late confirmation to a different resource target', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-1', enabled: true }),
        });
        const confirmation = createDeferred<boolean>();
        modalConfirm.mockImplementationOnce(() => confirmation.promise);

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-toggle-enabled')).toBeTruthy());
        screen.pressByTestId('team-credential-toggle-enabled');
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-2', enabled: true }),
        });
        await screen.update(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-2" />,
        );
        confirmation.resolve(true);
        await flushHookEffects();

        expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(0);
    });

    it('does not disable a resource when the person cancels the consequence confirmation', async () => {
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
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({ enabled: true }),
        });
        modalConfirm.mockResolvedValueOnce(false);

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credential-toggle-enabled');
        });
        await screen.pressByTestIdAsync('team-credential-toggle-enabled');

        expect(modalConfirm).toHaveBeenCalledOnce();
        expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(0);
    });

    it('holds Test while this screen already has an unresolved approval', async () => {
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
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({ enabled: true }),
        });
        await harness.requireUiApproval(serverId, 'teams.credentials.test');

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credential-test');
        });
        await screen.pressByTestIdAsync('team-credential-test');
        await vi.waitFor(() => expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(1));

        // The approval this screen is already waiting on owns its custody: a
        // second Test would register another one and orphan the first.
        expect(screen.findByTestId('team-credential-test')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('team-credential-test');
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(1);
    });

    it('disables an active resource through the canonical update Action', async () => {
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
        const resource = teamCredentialResourceFixture({ enabled: true });
        harness.answer(serverId, GET_PATH, { body: resource });
        harness.answer(serverId, UPDATE_PATH, { body: { resourceId: resource.id, revision: 4 } });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credential-toggle-enabled');
        });
        await screen.pressByTestIdAsync('team-credential-toggle-enabled');
        await vi.waitFor(() => expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(1));
        await vi.waitFor(() => expect(harness.requestsFor(GET_PATH)).toHaveLength(2));
        expect(harness.requestsFor(UPDATE_PATH)[0]?.input).toMatchObject({
            resourceId: 'resource-1', expectedRevision: 3, enabled: false,
        });
    });
});
