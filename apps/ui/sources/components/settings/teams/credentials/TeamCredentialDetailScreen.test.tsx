import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_PROTOCOLS_V1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceDiscoveryPageV1Schema } from '@happier-dev/protocol/teams';

import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
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
// Keep cold module transformation outside the interaction timeout on a saturated host.
const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');

const TEAM_GET_PATH = '/v1/teams/get';
const LIST_PATH = '/v1/teams/credential-resources/list';
const GET_PATH = '/v1/teams/credential-resources/get';
const UPDATE_PATH = '/v1/teams/credential-resources/update';
const DELETE_PATH = '/v1/teams/credential-resources/delete';
const PREPARATION_READ_PATH = '/v2/teams/team-1/credential-resources/resource-1/direct-material?view=readiness';
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
    it.each([
        { approved: false, withFailureDetail: false }, { approved: true, withFailureDetail: false },
        { approved: false, withFailureDetail: true }, { approved: true, withFailureDetail: true },
    ])('keeps the typed Test cause and request ID in Details ($approved, detail=$withFailureDetail)', async ({ approved, withFailureDetail }) => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }) });
        harness.answer(serverId, GET_PATH, { body: teamCredentialResourceFixture() });
        harness.answer(serverId, '/v1/teams/credential-resources/test', { body: {
            result: 'needs_attention', code: withFailureDetail ? 'upstream_unavailable' : 'connected_service_credential_reconnect_required', requestId: 'test-request-1106',
            readiness: withFailureDetail ? { kind: 'source_unavailable' } : { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' },
            recovery: 'Reconnect the shared account and try again.',
            ...(withFailureDetail ? { failureDetail: { code: 'source_invalid', stage: 'application_response', httpStatus: 403 } } : {}),
        } });
        if (approved) await harness.requireUiApproval(serverId, 'teams.credentials.test');
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const screen = await renderScreen(<TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />);
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credential-test'));
        await screen.pressByTestIdAsync('team-credential-test');
        if (approved) {
            await vi.waitFor(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
            const artifactId = harness.artifacts(serverId).list()[0]!.id;
            await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true });
        }
        await vi.waitFor(() => {
            const details = screen.findAllByType(SurfaceStateCard).find(row => row.props.testID === 'team-credential-test-result');
            expect(details?.props.diagnosticCode).toBe(withFailureDetail ? 'source_invalid' : 'connected_service_credential_reconnect_required');
            expect(details?.props.diagnosticDetail).toContain('test-request-1106');
            if (withFailureDetail) {
                expect(details?.props.diagnosticDetail).toContain('application_response');
                expect(details?.props.diagnosticDetail).toContain('403');
            }
        });
        expect(screen.getTextContent()).not.toContain('test-request-1106');
        expect(screen.getTextContent()).not.toContain('connected_service_credential_reconnect_required');
        expect(screen.getTextContent()).not.toContain('application_response');
        await screen.pressByTestIdAsync('team-credential-test-result-details-toggle');
        expect(screen.getTextContent()).toContain('test-request-1106');
        expect(screen.getTextContent()).toContain(withFailureDetail ? 'source_invalid' : 'connected_service_credential_reconnect_required');
        if (withFailureDetail) {
            expect(screen.getTextContent()).toContain('application_response');
            expect(screen.getTextContent()).toContain('403');
        }
    });

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
        harness.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, {
            body: TeamCredentialResourceDiscoveryPageV1Schema.parse({
                nextCursor: null,
                failures: [],
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
            }),
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
        harness.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, { body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [], nextCursor: null, failures: [] }) });
        harness.answer(serverId, GET_PATH, { status: 404, body: { error: 'not_found_or_not_visible' } });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-revoked" />,
        );
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('team-credential-not-found'));
        expect(screen.getTextContent()).toContain('teams.credentials.detail.notFound');
    });
    it.each([
        { viewer: 'source owner', recoveryAction: 'retry' as const, rowAction: 'team-credential-test' },
        { viewer: 'source owner', recoveryAction: 'source_owner_action' as const, rowAction: 'team-credential-recovery' },
        { viewer: 'Team manager', recoveryAction: 'select_broker' as const, rowAction: 'team-credential-test' },
    ])('says the state once with the one action the $viewer can take ($recoveryAction)', async ({ viewer, recoveryAction, rowAction }) => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }) });
        const owner = viewer === 'source owner';
        harness.answer(serverId, GET_PATH, { body: teamCredentialResourceFixture({
            custodianAccountId: owner ? 'account-ada' : 'account-other',
            readiness: { kind: 'source_unavailable' }, recoveryAction,
            ...(owner ? {} : { capabilities: {
                manageAudience: true, managePolicy: true, manageLimits: true,
                updateBrokerPlacement: false, narrowDisclosure: false, widenDisclosure: false,
                refreshDirectMaterial: false, disable: true, enable: true, delete: true,
            } }),
        }) });
        const { Item } = await import('@/components/ui/lists/Item');
        const { t } = await import('@/text');
        const screen = await renderScreen(<TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />);
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credential-state'));
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        // Test is the retry and the broker row holds the broker choice, so no banner repeats either.
        expect(ids).not.toContain('team-credential-recovery-notice');
        expect(ids.includes('team-credential-choose-broker')).toBe(owner);
        expect(ids).toContain(rowAction);
        const state = screen.findAllByType(Item).find(row => row.props.testID === 'team-credential-state');
        if (owner) expect(state?.props.subtitle).not.toBe(t('teams.credentials.recovery.ownerHandoff'));
        else expect(state?.props.subtitle).toBe(t('teams.credentials.recovery.ownerHandoff'));
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
                    deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
                    allMembersAllowedRoutes: ['direct'],
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
                    deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] }, allMembersAllowedRoutes: ['direct'],
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
                    allMembersAllowedRoutes: null,
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

    it('checks material-safe source-owner readiness through the gated resource read', async () => {
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
                    deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] }, allMembersAllowedRoutes: ['direct'],
                }),
        });
        harness.answer(serverId, PREPARATION_READ_PATH, {
            body: {
                status: 'not_ready', reason: 'preparation_pending', counts: { pending: 1 },
            },
        });

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON()))
            .toContain('team-credential-preparation-refresh'));
        await screen.pressByTestIdAsync('team-credential-preparation-refresh');

        await vi.waitFor(() => expect(harness.requestsFor(PREPARATION_READ_PATH)).toHaveLength(1));
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
        harness.answer(serverId, DELETE_PATH, { body: { resourceId: 'resource-1', revision: 2 } });
        const confirmation = createDeferred<boolean>();
        modalConfirm.mockImplementationOnce(() => confirmation.promise);

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => expect(screen.findByTestId('team-credential-delete')).toBeTruthy());
        screen.pressByTestId('team-credential-delete');
        await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledOnce());
        harness.answer(serverId, GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-2', enabled: true }),
        });
        await screen.update(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-2" />,
        );
        confirmation.resolve(true);
        await flushHookEffects();

        expect(harness.requestsFor(DELETE_PATH)).toHaveLength(0);
    });

    it('disables a resource directly through the reversible Action default', async () => {
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
        harness.answer(serverId, UPDATE_PATH, { body: { resourceId: 'resource-1', revision: 2 } });
        modalConfirm.mockResolvedValueOnce(false);

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credential-toggle-enabled');
        });
        await screen.pressByTestIdAsync('team-credential-toggle-enabled');

        await vi.waitFor(() => expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(1));
        expect(modalConfirm).not.toHaveBeenCalled();
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

    it.each([
        { approved: false, refreshFails: false },
        { approved: false, refreshFails: true },
        { approved: true, refreshFails: false },
        { approved: true, refreshFails: true },
    ])('settles disable with retained detail read-only (approved=$approved, refreshFails=$refreshFails)', async ({ approved, refreshFails }) => {
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
        if (approved) await harness.requireUiApproval(serverId, 'teams.credentials.update');

        const { TeamCredentialDetailScreen } = await import('./TeamCredentialDetailScreen');
        const screen = await renderScreen(
            <TeamCredentialDetailScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-credential-toggle-enabled');
        });
        const refresh = createDeferred<void>();
        if (approved) {
            modalConfirm.mockClear();
            await screen.pressByTestIdAsync('team-credential-toggle-enabled');
            await vi.waitFor(() => expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(1));
            expect(modalConfirm).not.toHaveBeenCalled();
        }
        harness.answer(serverId, GET_PATH, {
            ...(refreshFails ? { status: 503 } : { body: { ...resource, enabled: false, revision: 4 } }),
            respondAfter: refresh.promise,
        });
        let settled = approved;
        if (approved) {
            const artifactId = harness.artifacts(serverId).list()[0]?.id;
            expect(artifactId).toBeDefined();
            await expect(decideApprovalAsInbox(serverId, artifactId!, 'approve')).resolves.toMatchObject({ ok: true });
        } else {
            const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
            const toggle = screen.findAllByType(RoundButton).find((node) => node.props.testID === 'team-credential-toggle-enabled');
            act(() => { void toggle?.props.onPress().then(() => { settled = true; }); });
        }
        try {
            await vi.waitFor(() => expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(1));
            await vi.waitFor(() => expect(harness.requestsFor(GET_PATH)).toHaveLength(2));
            await vi.waitFor(() => {
                const control = screen.findByTestId('team-credential-toggle-enabled');
                expect(control).not.toBeNull();
                expect(Boolean(control?.props.disabled)).toBe(true);
                expect(settled).toBe(true);
            });
            await screen.pressByTestIdAsync('team-credential-toggle-enabled');
            expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(1);
            expect(harness.requestsFor(UPDATE_PATH)[0]?.input).toMatchObject({
                resourceId: 'resource-1', expectedRevision: 3, enabled: false,
            });
        } finally {
            await act(async () => { refresh.resolve(); });
        }
        if (refreshFails) {
            expect(screen.findByTestId('team-credential-toggle-enabled')?.props.disabled).toBe(true);
            await screen.pressByTestIdAsync('team-credential-toggle-enabled');
            expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(1);
        } else {
            await vi.waitFor(() => expect(screen.findByTestId('team-credential-toggle-enabled')?.props.disabled).toBe(false));
            await screen.pressByTestIdAsync('team-credential-toggle-enabled');
            if (approved) {
                await vi.waitFor(() => expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(2));
            } else {
                await vi.waitFor(() => expect(harness.requestsFor(UPDATE_PATH)).toHaveLength(2));
                expect(harness.requestsFor(UPDATE_PATH)[1]?.input).toMatchObject({ expectedRevision: 4, enabled: true });
            }
        }
    });
});
