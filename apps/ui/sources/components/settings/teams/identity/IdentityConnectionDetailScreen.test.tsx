import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamIdentityConnectionV1 } from '@happier-dev/protocol/teams';
import { HomeIdentityConnectionV1Schema, HomeIdentityConnectionListResultV1Schema } from '@happier-dev/protocol/home';
import { TeamIdentityConnectionListResultV1Schema, TeamGroupsPageV1Schema } from '@happier-dev/protocol/teams';
import { homeDomainActionTransportV1, homeDomainActionOutputSchemaV1, type HomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { teamCapabilitiesFixture, teamSummaryFixture, teamIdentityConnectionFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { t } from '@/text';
const routerReplaceMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());
const announceMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
const appStateChangeMock = vi.hoisted(() => ({ current: null as null | ((state: string) => void) }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { replace: routerReplaceMock, push: routerPushMock } }).module);
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    return { ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
        NavigationContext: ReactModule.createContext({}),
        useFocusEffect: (effect: () => void | (() => void)) => ReactModule.useEffect(effect, [effect]),
    };
});
vi.mock('react-native', async () => {
    const native = await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock();
    return { ...native, AppState: { ...native.AppState, addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
        appStateChangeMock.current = listener; return { remove: vi.fn() };
    }) } };
});
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({ announceAccessibilityMessage: announceMock }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({ BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [], BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [] }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { IdentityConnectionDetailContent, IdentityConnectionDetailScreen } = await import('./IdentityConnectionDetailScreen');
const { Modal } = await import('@/modal');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
let serverId: string;
let connection: TeamIdentityConnectionV1;
let readOnly = false;
// Resource routes bind this suite's exact Team at the HTTP boundary.
const path = (actionId: HomeDomainActionIdV1) => homeDomainActionTransportV1(actionId).path.replace(':teamId', 'team-1');
const listPath = path('teams.identity.connections.list');
const updatePath = path('teams.identity.connections.settings.update');
const consumePath = path('teams.identity.connections.test.consume');
const groupsPath = path('teams.groups.list');
const bindingPath = path('teams.externalGroupBindings.list');
function answer(actionId: HomeDomainActionIdV1, value: unknown) {
    harness.answer(serverId, path(actionId), { body: homeDomainActionOutputSchemaV1(actionId).parse(value) });
}
function serveConnection() {
    harness.answer(serverId, listPath, { select: () => ({ body: TeamIdentityConnectionListResultV1Schema.parse({
        items: [connection], eligibleProviders: [], memberSignInUrl: null,
        admissionModeApplicability: { v: 1, modes: { invite_only: { status: 'available' }, provisioned: { status: 'available' }, jit: { status: 'available' } } },
    }) }) });
}
async function publishConnection() {
    const reads = harness.requestsFor(listPath).length;
    await act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]));
    await waitForHomeGovernance(() => expect(harness.requestsFor(listPath).length).toBeGreaterThan(reads));
}
async function renderDetail(testReturn?: Readonly<{ purpose: 'identity_connection_test'; resultHandle: string | null; error: string | null }>) {
    harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ archivedAt: readOnly ? 1 : null,
        capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) }) });
    const screen = await renderScreen(<IdentityConnectionDetailScreen serverId={serverId} teamId="team-1" connectionId="connection-1" testReturn={testReturn} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('identity-connection-status')
        ?? screen.findByTestId('identity-workos-setup-steps') ?? screen.findByTestId('identity-workos-current-connection')).not.toBeNull());
    return screen;
}
function workos(overrides: Partial<TeamIdentityConnectionV1> = {}) {
    connection = teamIdentityConnectionFixture({ provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' },
        externalReference: { v: 1, kind: 'workos_sso', organizationId: 'organization-1', connectionId: null },
        settings: { v: 1, kind: 'workos_sso' }, lastObservation: null, enabled: false, firstEnabledAt: null,
        state: 'setting_up', ...overrides });
}
beforeEach(async () => {
    standardCleanup();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    serverId = await harness.addHome({ name: 'Identity Home', serverUrl: 'https://identity-home.example', accountId: 'account-1', teamsEnabled: true });
    await harness.selectHomes([serverId]);
    connection = teamIdentityConnectionFixture(); readOnly = false; serveConnection();
    answer('identity.providers.list', { items: [], unreadableCount: 0 });
    answer('teams.externalGroupBindings.list', { items: [], nextCursor: null });
    answer('teams.groups.list', { items: [], nextCursor: null });
    routerReplaceMock.mockReset(); routerPushMock.mockReset(); announceMock.mockReset();
    openExternalUrlMock.mockReset().mockResolvedValue(true); appStateChangeMock.current = null;
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true); vi.mocked(Modal.alertAsync).mockClear();
});

describe('IdentityConnectionDetailScreen test return', () => {
    it('keeps a failed mapping read distinct from an empty mapping list', async () => {
        harness.answer(serverId, bindingPath, { status: 503, body: { error: 'home_unreachable' } });
        const screen = await renderDetail();
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-group-bindings-retry')).not.toBeNull());
        expect(screen.getTextContent()).not.toContain(t('identityAdministration.unmapped'));
    });

    it('loads native Groups only for the open mapping chooser and distinguishes loading, empty, and retryable failure', async () => {
        const held = createDeferred<void>();
        harness.answer(serverId, groupsPath, { body: TeamGroupsPageV1Schema.parse({ items: [], nextCursor: null }), respondAfter: held.promise });
        const screen = await renderDetail();
        expect(harness.requestsFor(groupsPath)).toHaveLength(0);
        await screen.pressByTestIdAsync('identity-group-map-existing');
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-group-native-loading')).not.toBeNull());
        await act(async () => held.resolve());
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-group-native-empty')).not.toBeNull());
        harness.answer(serverId, groupsPath, { status: 503, body: { error: 'home_unreachable' } });
        await publishConnection();
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-group-native-error')).not.toBeNull());
        harness.answer(serverId, groupsPath, { body: TeamGroupsPageV1Schema.parse({ items: [], nextCursor: null }) });
        const reads = harness.requestsFor(groupsPath).length;
        await screen.pressByTestIdAsync('identity-group-native-retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-group-native-empty')).not.toBeNull());
        expect(harness.requestsFor(groupsPath)).toHaveLength(reads + 1);
    });

    it('gives every Team identity restriction field its translated accessible name', async () => {
        const screen = await renderDetail();

        expect(screen.findByTestId('identity-settings-allowed-users')?.props.accessibilityLabel)
            .toBe(t('teams.authentication.detail.allowedUsers'));
        expect(screen.findByTestId('identity-settings-allowed-domains')?.props.accessibilityLabel)
            .toBe(t('teams.authentication.detail.allowedDomains'));
        expect(screen.findByTestId('identity-settings-groups-any')?.props.accessibilityLabel)
            .toBe(t('identityAdministration.groupsAny'));
        expect(screen.findByTestId('identity-settings-groups-all')?.props.accessibilityLabel)
            .toBe(t('identityAdministration.groupsAll'));

        connection = {
            ...connection,
            provider: { id: 'provider-github', kind: 'github_app_identity', displayName: 'GitHub' },
            externalReference: { v: 1, kind: 'github_app_identity', installationId: 'installation-1' },
            settings: { v: 1, kind: 'github_app_identity', organizationLogin: 'example' },
            lastObservation: { v: 1, kind: 'github_app_identity' },
        };
        await publishConnection();
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-settings-organization')).not.toBeNull());

        expect(screen.findByTestId('identity-settings-organization')?.props.accessibilityLabel)
            .toBe(t('teams.authentication.detail.organization'));
    });

    it('presents WorkOS provider, strategy, and status values without exposing raw wire enums', async () => {
        connection = {
            ...connection,
            provider: { id: 'provider-workos', kind: 'workos_sso', displayName: 'Acme SSO' },
            externalReference: {
                v: 1,
                kind: 'workos_sso',
                organizationId: 'organization-1',
                connectionId: null,
            },
            settings: { v: 1, kind: 'workos_sso' },
            allowedActions: ['teams.identity.workos.reconcile'],
            lastObservation: {
                v: 1,
                kind: 'workos_sso',
                presentation: {
                    displayName: 'Ok',
                    strategy: 'SAML',
                    status: 'active',
                    lastCheckedAt: 1,
                },
            },
        };
        answer('teams.identity.workos.reconcile', {
                connection, outcome: 'selection_required',
                candidates: [
                    { connectionId: 'candidate-1', displayName: 'Primary', strategy: 'SAML', status: 'active' },
                    { connectionId: 'candidate-2', displayName: 'Backup', strategy: 'SAML', status: 'active' },
                ],
        });
        const screen = await renderDetail();

        expect(screen.findByTestId('identity-connection-provider')).toBeNull();
        expect(screen.getTextContent()).toContain(t('identityAdministration.providerWorkosSso'));
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-workos-current-connection')!, 'Text',
            `Ok · ${t('identityAdministration.workosStrategySaml')} · ${t('identityAdministration.active')}`)).toBeDefined();

        await screen.pressByTestIdAsync('team-identity-workos-reconcile');
        const candidate = screen.findByTestId('identity-workos-candidate:candidate-1');
        expect(findTestInstanceByTypeContainingText(candidate!, 'Text',
            `${t('identityAdministration.workosStrategySaml')} · ${t('identityAdministration.active')}`)).toBeDefined();
        expect(screen.getTextContent()).not.toContain('SAML · active');
    });

    it('explains a blocked removal through each typed blocker and labels the sole-login count truthfully', async () => {
        connection = {
            ...connection,
            allowedActions: ['teams.identity.connections.remove'],
        };
        answer('teams.identity.connections.remove.preview', {
                v: 1, canRemove: false,
                connection: connection,
                impact: { linkedAccounts: 3, accountsRequiringAlternateLogin: 2, directorySources: 1, externalGroupBindings: 0, managedMemberships: 0 },
                blockers: ['account_would_lose_login', 'directory_source_in_use'],
        });
        const { Modal } = await import('@/modal');
        const { identityAdministrationFailureMessage, identityAdministrationFailureRecoveryLabel } = await import('@/components/settings/identity/identityAdministrationFailure');
        const screen = await renderDetail();

        await screen.pressByTestIdAsync('team-identity-remove');

        expect(harness.requestsFor(path('teams.identity.connections.remove.preview'))).toHaveLength(1);
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(Modal.alertAsync).toHaveBeenCalledTimes(1);
        const body = String(vi.mocked(Modal.alertAsync).mock.calls[0]?.[1]);
        // Each blocker leads with its own count when the preview carries one,
        // then names where it is resolved; zero counts never appear.
        expect(body).toContain(t('identityAdministration.removeBlockedAlternateLogins', { count: 2 }));
        expect(body).toContain(identityAdministrationFailureRecoveryLabel('alternate_login'));
        expect(body).toContain(t('identityAdministration.removeBlockedDirectories', { count: 1 }));
        expect(body).toContain(identityAdministrationFailureRecoveryLabel('directory'));
        expect(body).not.toContain(t('identityAdministration.removeBlockedGroups', { count: 0 }));
        expect(body).not.toContain(identityAdministrationFailureMessage('account_would_lose_login'));
        expect(body).not.toContain(t('identityAdministration.needsTest'));
    });

    it('does not consume or refresh when the callback has no result handle', async () => {
        await renderDetail({ purpose: 'identity_connection_test', resultHandle: null, error: null });
        await waitForHomeGovernance(() => expect(routerReplaceMock).toHaveBeenCalledOnce());
        expect(harness.requestsFor(consumePath)).toHaveLength(0);
        expect(harness.requestsFor(listPath)).toHaveLength(1);
    });

    it('shows the sanitized diagnostics the consumed result carried', async () => {
        answer('teams.identity.connections.test.consume', { connection, diagnostics: {
            subjectPresent: true, loginAvailable: true, emailAvailable: true, emailVerified: false,
            groups: { state: 'complete', count: 2 }, eligibility: { status: 'ineligible', rules: [{ kind: 'email_domains', matched: false }] },
            mappedGroups: [{ id: 'group-1', name: { kind: 'available', label: { content: { t: 'plain', v: 'Engineering' }, recipientEnvelope: null } } }],
        } });
        const screen = await renderDetail({ purpose: 'identity_connection_test', resultHandle: 'result-1', error: null });
        await waitForHomeGovernance(() => expect(findTestInstanceByTypeContainingText(screen.findByTestId('identity-test-diagnostics:mappedGroups')!, 'Text', 'Engineering')).toBeDefined());
        expect(screen.findByTestId('identity-test-diagnostics:rule:email_domains')).not.toBeNull();
        expect(harness.requestsFor(consumePath)).toHaveLength(1);
        expect(harness.requestsFor(listPath).length).toBeGreaterThan(1);
    });

    it('applies returned diagnostics after native Ask confirmation without replaying the consume mutation', async () => {
        await harness.requireUiApproval(serverId, 'teams.identity.connections.test.consume');
        answer('teams.identity.connections.test.consume', { connection, diagnostics: {
            subjectPresent: true, loginAvailable: true, emailAvailable: true, emailVerified: true,
            groups: { state: 'complete', count: 0 }, eligibility: { status: 'eligible', rules: [] }, mappedGroups: [],
        } });
        const screen = await renderDetail({ purpose: 'identity_connection_test', resultHandle: 'result-1', error: null });
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-test-diagnostics:subject')).not.toBeNull());
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(harness.requestsFor(consumePath)).toHaveLength(1);
        expect(harness.requestsFor(listPath).length).toBeGreaterThan(1);
    });

    it('does not publish a refresh when the Home refuses the result', async () => {
        harness.answer(serverId, consumePath, { status: 403, body: { error: 'team_forbidden' } });
        await renderDetail({ purpose: 'identity_connection_test', resultHandle: 'result-1', error: null });
        await waitForHomeGovernance(() => expect(routerReplaceMock).toHaveBeenCalledOnce());
        expect(harness.requestsFor(consumePath)).toHaveLength(1);
        expect(harness.requestsFor(listPath)).toHaveLength(1);
    });

    it('shows a busy return state and blocks mutations while a test result is being consumed', async () => {
        connection.allowedActions = ['teams.identity.connections.test.start', 'teams.identity.connections.disable'];
        const held = createDeferred<void>();
        harness.answer(serverId, consumePath, { body: { connection }, respondAfter: held.promise });
        const screen = await renderDetail({ purpose: 'identity_connection_test', resultHandle: 'result-1', error: null });
        await waitForHomeGovernance(() => expect(harness.requestsFor(consumePath)).toHaveLength(1));
        expect(screen.findByTestId('identity-connection-test-status')?.props.accessibilityState?.busy).toBe(true);
        expect(screen.findByTestId('team-identity-test')?.props.disabled).toBe(true);
        expect(screen.findByTestId('team-identity-disable')?.props.disabled).toBe(true);
        await act(async () => held.resolve());
        await waitForHomeGovernance(() => expect(routerReplaceMock).toHaveBeenCalledOnce());
    });

    it('opens the exact Team test URL after native Ask confirmation through the immediate completion', async () => {
        connection.allowedActions = ['teams.identity.connections.test.start'];
        await harness.requireUiApproval(serverId, 'teams.identity.connections.test.start');
        answer('teams.identity.connections.test.start', { authorizeUrl: 'https://id.example/approved', attemptId: 'attempt-1' });
        const screen = await renderDetail();
        await screen.pressByTestIdAsync('team-identity-test');
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://id.example/approved');
    });

    it('opens and marks the WorkOS portal after native Ask confirmation and refreshes on return', async () => {
        workos({ externalReference: { v: 1, kind: 'workos_sso', organizationId: null, connectionId: null }, allowedActions: ['teams.identity.workos.adminPortalLink.create'] });
        await harness.requireUiApproval(serverId, 'teams.identity.workos.adminPortalLink.create');
        answer('teams.identity.workos.adminPortalLink.create', { url: 'https://workos.example/approved' });
        const screen = await renderDetail();
        await screen.pressByTestIdAsync('team-identity-workos-sso');
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://workos.example/approved');
        const reads = harness.requestsFor(listPath).length;
        await act(async () => appStateChangeMock.current?.('active'));
        await waitForHomeGovernance(() => expect(harness.requestsFor(listPath).length).toBeGreaterThan(reads));
    });

    it('hands Directory Sync setup to the directory journey instead of opening a second portal return flow', async () => {
        connection = {
            ...connection,
            provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'organization-1', connectionId: 'workos-connection-a' },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            allowedActions: ['teams.identity.workos.adminPortalLink.create'],
        };
        const screen = await renderDetail();

        await screen.pressByTestIdAsync('team-identity-workos-directory');

        expect(routerPushMock).toHaveBeenCalledWith(
            `/settings/teams/${serverId}/team-1/authentication/directory`,
        );
        expect(harness.requestsFor(updatePath)).toHaveLength(0);
        expect(openExternalUrlMock).not.toHaveBeenCalled();
    });

    it('requires reloading and reapplying a preserved draft before saving against a refreshed revision', async () => {
        connection.allowedActions = ['teams.identity.connections.settings.update'];
        harness.answer(serverId, updatePath, { status: 409, body: { error: 'identity_connection_conflict' } });
        const screen = await renderDetail();
        await act(async () => {
            screen.changeTextByTestId('identity-settings-allowed-users', 'alice@example.com');
        });

        await act(async () => {
            connection = { ...connection, revision: 2 };
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });
        expect(screen.findByTestId('identity-settings-save')?.props.disabled).toBe(true);
        expect(harness.requestsFor(updatePath)).toHaveLength(0);

        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-settings-reload-conflict')).not.toBeNull());
        await screen.pressByTestIdAsync('identity-settings-reload-conflict');
        expect(screen.findByTestId('identity-settings-allowed-users')?.props.value).toBe('');
        expect(screen.findByTestId('identity-settings-save')?.props.disabled).toBe(true);
        await act(async () => {
            screen.changeTextByTestId('identity-settings-allowed-users', 'alice@example.com');
        });
        await screen.pressByTestIdAsync('identity-settings-save');

        expect(harness.requestsFor(updatePath)[0]?.input).toMatchObject({
            expectedRevision: 2,
            settings: expect.objectContaining({
                kind: 'oidc',
                allowedUsers: ['alice@example.com'],
            }),
        });
    });

    it('refreshes a server CAS conflict and waits for the newer connection revision before retry', async () => {
        connection.allowedActions = ['teams.identity.connections.settings.update'];
        harness.answer(serverId, updatePath, { status: 409, body: { error: 'identity_connection_conflict' } });
        const screen = await renderDetail();
        await act(async () => screen.changeTextByTestId('identity-settings-allowed-users', 'alice@example.com'));
        const reads = harness.requestsFor(listPath).length;
        await screen.pressByTestIdAsync('identity-settings-save');
        await waitForHomeGovernance(() => expect(harness.requestsFor(listPath).length).toBeGreaterThan(reads));
        expect(screen.findByTestId('identity-settings-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('identity-settings-reload-conflict')).toBeNull();
        await screen.pressByTestIdAsync('identity-settings-refresh-conflict');
        connection = teamIdentityConnectionFixture({ ...connection, revision: 2 });
        await publishConnection();
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-settings-reload-conflict')).not.toBeNull());
        expect(screen.findByTestId('identity-settings-refresh-conflict')).toBeNull();
        answer('teams.identity.connections.settings.update', { connection: { ...connection, revision: 3 } });
        await screen.pressByTestIdAsync('identity-settings-reload-conflict');
        expect(screen.findByTestId('identity-settings-allowed-users')?.props.value).toBe('');
        await act(async () => screen.changeTextByTestId('identity-settings-allowed-users', 'alice@example.com'));
        await screen.pressByTestIdAsync('identity-settings-save');
        expect(harness.requestsFor(updatePath).at(-1)?.input).toMatchObject({ expectedRevision: 2, settings: { allowedUsers: ['alice@example.com'] } });
    });

    it('refreshes the authoritative projection when a lifecycle CAS loses', async () => {
        connection.allowedActions = ['teams.identity.connections.disable'];
        harness.answer(serverId, path('teams.identity.connections.disable'), { status: 409, body: { error: 'identity_connection_conflict' } });
        const screen = await renderDetail();
        const reads = harness.requestsFor(listPath).length;
        await screen.pressByTestIdAsync('team-identity-disable');
        await waitForHomeGovernance(() => expect(harness.requestsFor(listPath).length).toBeGreaterThan(reads));
        expect(screen.findByTestId('identity-connection-failure')).not.toBeNull();
    });

    it('disables every connection mutation when the Team is read-only', async () => {
        readOnly = true;
        connection = {
            ...connection,
            allowedActions: [
                'teams.identity.connections.settings.update',
                'teams.identity.connections.test.start',
                'teams.identity.connections.enable',
                'teams.identity.workos.adminPortalLink.create',
                'teams.identity.workos.reconcile',
                'teams.identity.connections.remove',
            ],
        };
        const screen = await renderDetail();

        expect(screen.findByTestId('identity-settings-allowed-users')?.props.editable).toBe(false);
        expect(screen.findByTestId('identity-external-group-id')?.props.editable).toBe(false);
        for (const testID of [
            'identity-settings-save',
            'identity-group-map-create',
            'identity-group-map-existing',
            'team-identity-test',
            'team-identity-enable',
            'team-identity-remove',
        ]) {
            expect(screen.findByTestId(testID)?.props.disabled).toBe(true);
        }
    });

    it('disables the WorkOS setup step and connection controls when the Team is read-only', async () => {
        readOnly = true;
        connection = {
            ...connection,
            provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: null, connectionId: null },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            enabled: false,
            firstEnabledAt: null,
            state: 'setting_up',
            allowedActions: ['teams.identity.workos.adminPortalLink.create', 'teams.identity.connections.remove'],
        };
        const screen = await renderDetail();

        for (const testID of ['team-identity-workos-sso', 'team-identity-workos-directory', 'team-identity-remove']) {
            expect(screen.findByTestId(testID)?.props.disabled).toBe(true);
        }
    });

    it('blocks stale allowed actions while the authoritative connection projection refreshes', async () => {
        connection.allowedActions = ['teams.identity.connections.settings.update', 'teams.identity.connections.test.start', 'teams.identity.connections.disable'];
        const screen = await renderDetail();
        const held = createDeferred<void>();
        harness.answer(serverId, listPath, { body: TeamIdentityConnectionListResultV1Schema.parse({ items: [connection], eligibleProviders: [], memberSignInUrl: null,
            admissionModeApplicability: { v: 1, modes: { invite_only: { status: 'available' }, provisioned: { status: 'available' }, jit: { status: 'available' } } } }), respondAfter: held.promise });
        await act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]));
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-identity-test')?.props.disabled).toBe(true));
        expect(screen.findByTestId('identity-settings-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('team-identity-disable')?.props.disabled).toBe(true);
        await act(async () => held.resolve());
    });

    it('opens the shared editor for the Team-owned provider attached to this connection', async () => {
        const provider = (await import('@/dev/testkit/fixtures/homeGovernanceFixtures')).managedIdentityProviderFixture({ owner: { kind: 'team', teamId: 'team-1' }, id: 'provider-1' });
        answer('identity.providers.list', { items: [provider], unreadableCount: 0 });
        const screen = await renderDetail();
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-identity-provider-edit')).not.toBeNull());
        await screen.pressByTestIdAsync('team-identity-provider-edit');
        expect(routerPushMock).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/connection-1/edit?providerId=provider-1`);
    });

    it('puts the only setup action on the current WorkOS step and keeps later steps inert', async () => {
        connection = {
            ...connection,
            provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'organization-1', connectionId: null },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            enabled: false,
            firstEnabledAt: null,
            state: 'connected',
            allowedActions: [
                'teams.identity.workos.reconcile',
                'teams.identity.workos.adminPortalLink.create',
                'teams.identity.connections.test.start',
                'teams.identity.connections.enable',
            ],
        };
        answer('teams.identity.workos.reconcile', { outcome: 'setting_up', connection });
        const screen = await renderDetail();

        // Step 1 is done: the portal stays reachable as a quiet reopen, not as the next step.
        expect(screen.findByTestId('team-identity-workos-sso')).not.toBeNull();
        // Steps 3 and 4 are upcoming: neither offers its action yet.
        expect(screen.findByTestId('team-identity-test')).toBeNull();
        expect(screen.findByTestId('team-identity-enable')).toBeNull();

        await screen.pressByTestIdAsync('team-identity-workos-reconcile');
        expect(harness.requestsFor(path('teams.identity.workos.reconcile'))[0]?.input).toMatchObject({ connectionId: 'connection-1' });
    });

    it('chooses a WorkOS connection through one named primary action, never through a draft candidate', async () => {
        // Choosing a candidate permanently fixes the provider namespace for
        // every future identity under this binding, so the commit is the
        // explicit "Use <name>" action, not a tap on a row.
        connection = {
            ...connection,
            provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'organization-1', connectionId: null },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            enabled: false,
            firstEnabledAt: null,
            allowedActions: ['teams.identity.workos.reconcile', 'teams.identity.workos.connection.set'],
        };
        answer('teams.identity.workos.reconcile', {
                connection, outcome: 'selection_required',
                candidates: [
                    { connectionId: 'workos-connection-a', displayName: 'Acme SAML', strategy: 'saml', status: 'active' },
                    { connectionId: 'workos-connection-b', displayName: 'Acme OIDC', strategy: 'oidc', status: 'draft' },
                ],
        });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        const screen = await renderDetail();

        await screen.pressByTestIdAsync('team-identity-workos-reconcile');

        expect(announceMock).toHaveBeenCalledWith(t('identityAdministration.workosChooseConnection'));
        const candidate = screen.findByTestId('identity-workos-candidate:workos-connection-a');
        expect(candidate?.props.role).toBe('radio');
        expect(candidate?.props['aria-checked']).toBe(false);
        expect(screen.findByTestId('identity-workos-candidate:workos-connection-b')?.props.disabled).toBe(true);
        // Nothing is committed until a candidate is chosen.
        expect(screen.findByTestId('team-identity-workos-use')?.props.disabled).toBe(true);

        answer('teams.identity.workos.connection.set', { connection });
        await screen.pressByTestIdAsync('identity-workos-candidate:workos-connection-a');
        expect(harness.requestsFor(path('teams.identity.workos.connection.set'))).toHaveLength(0);
        expect(screen.findByTestId('identity-workos-candidate:workos-connection-a')?.props['aria-checked']).toBe(true);

        await screen.pressByTestIdAsync('team-identity-workos-use');
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(harness.requestsFor(path('teams.identity.workos.connection.set'))[0]?.input).toMatchObject({ connectionId: 'connection-1', workosConnectionId: 'workos-connection-a' });
    });

    it('names the Teams that accept a Home sign-in connection, and says so when none do', async () => {
        const render = async (teamsUsingIt?: { teamId: string; name: string }[]) => {
            const homeConnection = HomeIdentityConnectionV1Schema.parse({ ...connection, teamId: null,
                provider: { id: 'provider-workos', kind: 'workos_sso', displayName: 'Northwind' },
                externalReference: { v: 1, kind: 'workos_sso', organizationId: 'organization-1', connectionId: 'workos-connection-1' },
                settings: { v: 1, kind: 'workos_sso' }, lastObservation: null, ...(teamsUsingIt ? { teamsUsingIt } : {}) });
            harness.answer(serverId, path('home.identity.connections.list'), { body: HomeIdentityConnectionListResultV1Schema.parse({
                items: [homeConnection], eligibleProviders: [],
            }) });
            const screen = await renderScreen(<IdentityConnectionDetailContent scope={{ serverId, accountId: 'account-1' }} teamId={null} connectionId="connection-1" mutationsAvailable />);
            await waitForHomeGovernance(() => expect(screen.findByTestId('identity-workos-current-connection')).not.toBeNull());
            return screen;
        };
        const used = await render([{ teamId: 'platform', name: 'Platform' }, { teamId: 'design', name: 'Design' }]);
        expect(findTestInstanceByTypeContainingText(used.findByTestId('identity-connection-teams-using-it')!, 'Text', 'Platform, Design')).toBeDefined();
        await used.unmount();
        const unused = await render([]);
        expect(findTestInstanceByTypeContainingText(unused.findByTestId('identity-connection-teams-using-it')!, 'Text', t('identityAdministration.homeTeamsUsingItNone'))).toBeDefined();
        await unused.unmount();
        const unknown = await render(undefined);
        expect(unknown.findByTestId('identity-connection-teams-using-it')).toBeNull();
    });


});
