import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceDiscoveryPageV1Schema } from '@happier-dev/protocol/teams';

import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { createDeferred } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { accountDisplayProfileFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    teamCapabilitiesFixture,
    teamCredentialResourceFixture,
    teamMembershipFixture,
    teamSummaryFixture,
} from '@/dev/testkit/fixtures/teamFixtures';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clipboardSet = vi.hoisted(() => vi.fn(async () => true));
const modalConfirm = vi.hoisted(() => vi.fn<typeof import('@/modal')['Modal']['confirm']>(async () => true));
const modalAlert = vi.hoisted(() => vi.fn<typeof import('@/modal')['Modal']['alert']>());
const routerReplace = vi.hoisted(() => vi.fn());
const navigationState = vi.hoisted(() => ({
    dispatch: vi.fn(),
    setOptions: vi.fn(),
    preventRemove: false,
    onPreventRemove: null as null | ((event: { data: { action: unknown } }) => void),
}));
vi.mock('expo-clipboard', () => ({
    setStringAsync: clipboardSet,
    getStringAsync: vi.fn(async () => ''),
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({
        navigation: {
            dispatch: navigationState.dispatch,
            setOptions: navigationState.setOptions,
        },
        usePreventRemove: (
            preventRemove: boolean,
            callback: (event: { data: { action: unknown } }) => void,
        ) => {
            navigationState.preventRemove = preventRemove;
            navigationState.onPreventRemove = callback;
        },
    });
});

installSettingsViewCommonModuleMocks({
    // This suite exercises Expo clipboard and native navigation; the shared
    // settings harness otherwise defaults to browser clipboard/navigation.
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: routerReplace }),
        useNavigation: () => ({ dispatch: navigationState.dispatch, setOptions: navigationState.setOptions }),
        useLocalSearchParams: () => ({}),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: modalConfirm,
                alert: modalAlert,
            },
        }).module;
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// The composed Action path must observe the real store.
vi.doUnmock('@/sync/domains/state/storage');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
// Load the real screen after transport boundaries, before timed test execution.
const { TeamCredentialExternalApiScreen } = await import('./TeamCredentialExternalApiScreen');
const { TeamCredentialAudiencePicker } = await import('./TeamCredentialAudiencePicker');

const TEAM_GET_PATH = '/v1/teams/get';
const CREDENTIAL_GET_PATH = '/v1/teams/credential-resources/get';
const EXTERNAL_KEYS_LIST_PATH = '/v1/teams/credential-resources/external-keys/list';
const EXTERNAL_KEY_CREATE_PATH = '/v1/teams/credential-resources/external-keys/create';
const EXTERNAL_KEY_AUTHORIZE_PATH = '/v1/teams/credential-resources/external-keys/authorize';
const EXTERNAL_KEY_REVOKE_PATH = '/v1/teams/credential-resources/external-keys/revoke';
const EXTERNAL_KEY_REVOKE_ALL_PATH = '/v1/teams/credential-resources/external-keys/revoke-all';
const PRIVATE_LABEL_RECIPIENT_CENSUS_PATH = '/v1/account/private-labels/recipient-census';
const MEMBERS_LIST_PATH = '/v1/teams/members/list';
const ACCOUNT_SETTINGS_V2_PATH = '/v2/account/settings';
const ARTIFACT_CREATE_PATH = '/v1/artifacts';
const CREATED_KEY_ID = '550e8400-e29b-41d4-a716-446655440000';
const CREATED_TOKEN = `hapek_v1_${CREATED_KEY_ID}_${'a'.repeat(43)}`;

function key(keyId: string, resourceId: string, label: string) {
    return {
        keyId,
        resourceId,
        teamMembershipId: 'membership-1',
        label: { content: { t: 'plain' as const, v: label }, recipientEnvelope: null },
        displayPrefix: `hapek_v1_${keyId.slice(0, 8)}`,
        createdAt: '2026-09-07T10:00:00.000Z',
        lastUsedAt: null,
        expiresAt: null,
        authenticationStatus: 'satisfied' as 'satisfied' | 'authentication_required' | 'unavailable',
        canAuthorize: false,
    };
}

async function addManagedHome(initialKeys: readonly ReturnType<typeof key>[] = []): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A', serverUrl: 'https://private-home.example', publicServerUrl: 'https://external-api-approval.example', accountId: 'account-ada',
        teamsEnabled: true, credentialResourcesEnabled: true,
        credentialResourcesExternalApiEnabled: true,
        credentialResourcesExternalApiAvailability: {
            available: true,
            baseUrl: 'https://external-api-approval.example/prefix/api/provider-broker/v1',
            protocols: ['openai_responses', 'openai_chat_completions', 'anthropic_messages'],
        },
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
    });
    harness.answer(serverId, CREDENTIAL_GET_PATH, {
        body: teamCredentialResourceFixture({ id: 'resource-1' }),
    });
    harness.answer(serverId, MEMBERS_LIST_PATH, {
        body: {
            items: [teamMembershipFixture({
                id: 'membership-1',
                accountId: 'account-ada',
                account: accountDisplayProfileFixture('Ada'),
            })],
            nextCursor: null,
        },
    });
    harness.answer(serverId, EXTERNAL_KEYS_LIST_PATH, { body: { keys: initialKeys } });
    harness.answer(serverId, PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, {
        body: { contentEncryptionMode: 'plain', recipients: [] },
    });
    harness.answer(serverId, ACCOUNT_SETTINGS_V2_PATH, {
        body: {
            content: { t: 'plain', v: {} },
            version: 1,
        },
    });
    return serverId;
}

async function chooseMember(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    member: Readonly<{ id?: string; accountId?: string; name?: string }> = {},
): Promise<void> {
    await waitForHomeGovernance(() => expect(screen.findAllByType(TeamCredentialAudiencePicker).find(node => node.props.testID === 'team-credential-external-assignee')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('team-credential-external-assignee');
    const { Modal } = await import('@/modal');
    const picker = vi.mocked(Modal.show).mock.calls.find(([modal]) => modal.chrome?.testID === 'team-credential-audience-picker:modal')?.[0];
    if (!picker) throw new Error('external_key_assignee_picker_missing');
    await act(async () => {
        (picker.props?.onChoose as (principal: { kind: 'member'; id: string; accountId: string; name: string }) => void)({
            kind: 'member',
            id: member.id ?? 'membership-1',
            accountId: member.accountId ?? 'account-ada',
            name: member.name ?? 'Ada',
        });
    });
}

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    clipboardSet.mockReset();
    clipboardSet.mockResolvedValue(true);
    await harness.reset();
    await harness.selectHomes([]);
    clipboardSet.mockClear();
    modalConfirm.mockReset();
    modalConfirm.mockResolvedValue(true);
    modalAlert.mockReset();
    routerReplace.mockReset();
    navigationState.dispatch.mockReset();
    navigationState.setOptions.mockReset();
    navigationState.preventRemove = false;
    navigationState.onPreventRemove = null;
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.show).mockClear();
});

afterEach(() => standardCleanup());

describe('TeamCredentialExternalApiScreen', () => {
    it('keeps previously observed key summaries on return until the Home withdraws access', async () => {
        const serverId = await addManagedHome([key(CREATED_KEY_ID, 'resource-1', 'My CLI')]);
        const row = `team-credential-external-key:${CREATED_KEY_ID}`;
        const page = () => <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />;
        const initial = await renderScreen(page());
        await waitForHomeGovernance(() => expect(initial.findByTestId(row)).not.toBeNull());
        await initial.unmount();

        const fresh = createDeferred<void>();
        harness.answer(serverId, EXTERNAL_KEYS_LIST_PATH, {
            status: 403, body: { error: 'forbidden' }, respondAfter: fresh.promise,
        });
        const returned = await renderScreen(page());
        await waitForHomeGovernance(() => expect(harness.requestsFor(EXTERNAL_KEYS_LIST_PATH)).toHaveLength(2));
        expect(returned.findByTestId(row)).not.toBeNull();
        expect(returned.findByTestId('team-credential-external-loading')).toBeNull();
        expect(returned.findAllByTestId(`team-credential-external-revoke:${CREATED_KEY_ID}`)[0]?.props.disabled).toBe(true);
        await act(async () => fresh.resolve());
        await waitForHomeGovernance(() => expect(returned.findByTestId(row)).toBeNull());
        await returned.unmount();
    });

    it('lets an entitled assignee authorize their pending key without exposing manager controls or revealing its bearer again', async () => {
        const pendingKey = { ...key(CREATED_KEY_ID, 'resource-1', 'My CLI'), authenticationStatus: 'authentication_required' as const, canAuthorize: true };
        const serverId = await addManagedHome([pendingKey]);
        harness.answer(serverId, TEAM_GET_PATH, { body: teamSummaryFixture({ viewerRole: 'member', capabilities: teamCapabilitiesFixture({}) }) });
        harness.answer(serverId, CREDENTIAL_GET_PATH, { status: 404, body: { error: 'not_found_or_not_visible' } });
        harness.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, { body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ nextCursor: null, failures: [], resources: [{
            id: 'resource-1', teamId: 'team-1', displayName: { content: { t: 'plain', v: 'Acme Provider' }, recipientEnvelope: null }, resourceRevision: 7,
            readiness: { kind: 'available' }, recoveryAction: null,
            mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
            sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [],
            sourcePresentation: { kind: 'provider', provider: {
                identity: { pluginId: 'happier.provider.openrouter', localId: 'openrouter' }, definitionRevision: 1,
            } },
        }] }) });
        harness.answer(serverId, EXTERNAL_KEY_AUTHORIZE_PATH, { status: 403, body: { error: 'team_authentication_required' } });
        const screen = await renderScreen(<TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />);

        await waitForHomeGovernance(() => expect(screen.findByTestId(`team-credential-external-authorize:${CREATED_KEY_ID}`)).not.toBeNull());
        expect(screen.findByTestId('team-credential-external-create')).toBeNull();
        expect(screen.findByTestId(`team-credential-external-revoke:${CREATED_KEY_ID}`)).toBeNull();
        expect(screen.findByTestId(`team-credential-external-replace:${CREATED_KEY_ID}`)).toBeNull();
        expect(harness.requestsFor(MEMBERS_LIST_PATH)).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('teams.unavailable.updateRequired');
        await screen.pressByTestIdAsync(`team-credential-external-authorize:${CREATED_KEY_ID}`);
        await waitForHomeGovernance(() => expect(harness.requestsFor(EXTERNAL_KEY_AUTHORIZE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(EXTERNAL_KEY_AUTHORIZE_PATH)[0]?.input).toEqual({ resourceId: 'resource-1', keyId: CREATED_KEY_ID });
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('teams.credentials.errors.teamAuthenticationRequired'));
        expect(screen.findByTestId(`team-credential-external-key:${CREATED_KEY_ID}`)).not.toBeNull();
        harness.answer(serverId, EXTERNAL_KEY_AUTHORIZE_PATH, { body: { key: { ...pendingKey, authenticationStatus: 'satisfied', canAuthorize: true } } });
        await screen.pressByTestIdAsync(`team-credential-external-authorize:${CREATED_KEY_ID}`);
        await waitForHomeGovernance(() => expect(screen.findByTestId(`team-credential-external-authorize:${CREATED_KEY_ID}`)).toBeNull());
        expect(screen.findByTestId(`team-credential-external-key:${CREATED_KEY_ID}`)).not.toBeNull();
        expect(screen.findByTestId('team-credential-external-value:token')).toBeNull();
    });

    it('keeps another member’s pending qualification visible to a manager without offering authorization on their behalf', async () => {
        const pendingKey = { ...key(CREATED_KEY_ID, 'resource-1', 'Maya CLI'), teamMembershipId: 'membership-maya', authenticationStatus: 'authentication_required' as const };
        const serverId = await addManagedHome([pendingKey]);
        harness.answer(serverId, MEMBERS_LIST_PATH, { body: { items: [teamMembershipFixture({
            id: 'membership-maya', accountId: 'account-maya', account: accountDisplayProfileFixture('Maya'),
        })], nextCursor: null } });
        const screen = await renderScreen(<TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId(`team-credential-external-key:${CREATED_KEY_ID}`)).not.toBeNull());
        expect(screen.getTextContent()).toContain('teams.credentials.externalApi.authenticationRequired');
        expect(screen.findByTestId(`team-credential-external-authorize:${CREATED_KEY_ID}`)).toBeNull();
        expect(screen.findByTestId(`team-credential-external-revoke:${CREATED_KEY_ID}`)).not.toBeNull();
    });

    it('discloses the Home readability, bearer authority, and incomplete terminal accounting before key creation', async () => {
        const serverId = await addManagedHome();

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-empty')).not.toBeNull());
        expect(screen.getTextContent()).toContain('teams.credentials.externalApi.homeDisclosure');
        expect(screen.getTextContent()).toContain('teams.credentials.externalApi.bearerDisclosure');
        expect(screen.getTextContent()).toContain('teams.credentials.externalApi.usageDisclosure');
    });

    it('keeps an initial key-list failure distinct from an empty snapshot and blocks creation until retry succeeds', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, EXTERNAL_KEYS_LIST_PATH, { status: 503, body: { error: 'unavailable' } });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-retry')).not.toBeNull());
        expect(screen.findByTestId('team-credential-external-empty')).toBeNull();
        expect(screen.findHostByTestId('team-credential-external-assignee')?.props.disabled).toBe(true);
        expect(screen.findHostByTestId('team-credential-external-create')?.props.disabled).toBe(true);
        expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)).toHaveLength(0);

        harness.answer(serverId, EXTERNAL_KEYS_LIST_PATH, { body: { keys: [] } });
        await screen.pressByTestIdAsync('team-credential-external-retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-empty')).not.toBeNull());
        act(() => screen.changeTextByTestId('team-credential-external-label', 'CI runner'));
        await chooseMember(screen);
        expect(screen.findHostByTestId('team-credential-external-create')?.props.disabled).not.toBe(true);
    });

    it.each([
        {
            name: 'missing deployment projection',
            availability: undefined,
            expected: 'teams.credentials.externalApi.unavailable',
        },
        {
            name: 'malformed deployment projection',
            availability: { available: true, baseUrl: 'not-a-url', protocols: [] },
            expected: 'teams.credentials.externalApi.unavailable',
        },
        {
            name: 'HTTP deployment projection',
            availability: {
                available: true,
                baseUrl: 'http://home.example.test/api/provider-broker/v1',
                protocols: ['openai_responses', 'openai_chat_completions', 'anthropic_messages'],
            },
            expected: 'teams.credentials.externalApi.unavailable',
        },
        {
            name: 'server-declared non-HTTPS deployment',
            availability: { available: false as const, reason: 'home_not_public_https' as const },
            expected: 'teams.credentials.externalApi.publicHttpsRequired',
        },
    ])('keeps External API visible but prevents key reads for $name', async ({ availability, expected }) => {
        const serverId = await harness.addHome({
            name: 'Home A',
            serverUrl: 'https://private-home.example',
            publicServerUrl: 'https://generic-profile-url.example',
            accountId: 'account-ada',
            teamsEnabled: true,
            credentialResourcesEnabled: true,
            credentialResourcesExternalApiEnabled: true,
            ...(availability ? { credentialResourcesExternalApiAvailability: availability } : {}),
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, CREDENTIAL_GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-1' }),
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-unavailable')).not.toBeNull());
        expect(screen.getTextContent()).toContain(expected);
        expect(screen.getTextContent()).not.toContain('generic-profile-url.example/api/provider-broker/v1');
        expect(harness.requestsFor(EXTERNAL_KEYS_LIST_PATH)).toHaveLength(0);
    });

    it('fails a direct route closed before disclosing deployment recovery to a viewer who cannot manage the resource', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://private-home.example', accountId: 'account-ada',
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
        harness.answer(serverId, CREDENTIAL_GET_PATH, {
            body: teamCredentialResourceFixture({
                id: 'resource-1',
                capabilities: {
                    manageAudience: false, managePolicy: false, manageLimits: false,
                    updateBrokerPlacement: false, narrowDisclosure: false, widenDisclosure: false,
                    refreshDirectMaterial: false, disable: false, enable: false, delete: false,
                },
            }),
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-forbidden')).not.toBeNull());
        expect(screen.getTextContent()).not.toContain('teams.credentials.externalApi.publicHttpsRequired');
        expect(harness.requestsFor(EXTERNAL_KEYS_LIST_PATH)).toHaveLength(0);
    });

    it('creates with an expiry and reveals independently copyable Home configuration without losing an uncopied key', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: { ...key(CREATED_KEY_ID, 'resource-1', 'CI runner'), expiresAt: '2026-10-07T10:00:00.000Z' } },
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-assignee')).not.toBeNull());
        act(() => screen.changeTextByTestId('team-credential-external-label', 'CI runner'));
        await chooseMember(screen);
        await screen.pressByTestIdAsync('team-credential-external-expiry:30d');
        await screen.pressByTestIdAsync('team-credential-external-create');

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:token')).not.toBeNull());
        expect(screen.getTextContent()).toContain('https://external-api-approval.example/prefix/api/provider-broker/v1');
        expect(screen.getTextContent()).toContain(CREATED_TOKEN);
        expect(screen.getTextContent()).toContain('OPENAI_BASE_URL=https://external-api-approval.example/prefix/api/provider-broker/v1');
        expect(screen.getTextContent()).toContain('ANTHROPIC_BASE_URL=https://external-api-approval.example/prefix/api/provider-broker/v1');
        expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)[0]?.input).toMatchObject({
            teamMembershipId: 'membership-1',
            keyId: expect.any(String),
            label: { content: { t: 'plain', v: 'CI runner' }, recipients: [] },
            expiresAt: expect.any(String),
        });

        modalConfirm.mockResolvedValueOnce(false);
        await screen.pressByTestIdAsync('team-credential-external-value:base-url');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:base-url')?.props.accessibilityLabel).toContain('common.copied'));
        await screen.pressByTestIdAsync('team-credential-external-reveal-done');
        expect(screen.findByTestId('team-credential-external-value:token')).not.toBeNull();
        await screen.pressByTestIdAsync('team-credential-external-value:token');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:token')?.props.accessibilityLabel).toContain('common.copied'));
        expect(clipboardSet).toHaveBeenLastCalledWith(CREATED_TOKEN);
        await screen.pressByTestIdAsync('team-credential-external-reveal-done');
        expect(screen.findByTestId('team-credential-external-value:token')).toBeNull();
        expect(screen.getTextContent()).toContain('teams.credentials.externalApi.assignLabel');
        expect(screen.getTextContent()).toContain('Ada');
        expect(navigationState.preventRemove).toBe(false);
    });

    it('honors disabled clipboard admission and keeps the one-time bearer uncopied until a copy succeeds', async () => {
        const serverId = await addManagedHome();
        await harness.setActionPolicy(serverId, 'clipboard.write', 'ui', 'off');
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: key(CREATED_KEY_ID, 'resource-1', 'CI runner') },
        });
        const { Modal } = await import('@/modal');
        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-assignee')).not.toBeNull());
        act(() => screen.changeTextByTestId('team-credential-external-label', 'CI runner'));
        await chooseMember(screen);
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:token')).not.toBeNull());

        await screen.pressByTestIdAsync('team-credential-external-value:token');
        expect(clipboardSet).not.toHaveBeenCalled();
        expect(Modal.alertAsync).toHaveBeenCalled();
        expect(screen.findByTestId('team-credential-external-value:token')?.props.accessibilityLabel).toContain('common.copy');
        modalConfirm.mockResolvedValueOnce(false);
        await screen.pressByTestIdAsync('team-credential-external-reveal-done');
        expect(screen.getTextContent()).toContain(CREATED_TOKEN);

        await harness.setActionPolicy(serverId, 'clipboard.write', 'ui', 'allowed');
        await screen.pressByTestIdAsync('team-credential-external-value:token');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:token')?.props.accessibilityLabel).toContain('common.copied'));
        expect(clipboardSet).toHaveBeenLastCalledWith(CREATED_TOKEN);
        await screen.pressByTestIdAsync('team-credential-external-reveal-done');
        expect(screen.getTextContent()).not.toContain(CREATED_TOKEN);
        expect(JSON.stringify(harness.requests.filter(request => request.path !== EXTERNAL_KEY_CREATE_PATH)))
            .not.toContain(CREATED_TOKEN);
    });

    it('copies a bearer after local Ask confirmation without retaining it in approval history', async () => {
        const serverId = await addManagedHome();
        await harness.requireUiApproval(serverId, 'clipboard.write');
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: key(CREATED_KEY_ID, 'resource-1', 'CI runner') },
        });
        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-assignee')).not.toBeNull());
        act(() => screen.changeTextByTestId('team-credential-external-label', 'CI runner'));
        await chooseMember(screen);
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:token')).not.toBeNull());

        const confirmation = createDeferred<boolean>();
        modalConfirm.mockClear().mockReturnValueOnce(confirmation.promise);
        const copy = screen.pressByTestIdAsync('team-credential-external-value:token');
        await waitForHomeGovernance(() => expect(modalConfirm).toHaveBeenCalledOnce());
        expect(clipboardSet).not.toHaveBeenCalled();
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        await act(async () => confirmation.resolve(true));
        await copy;
        expect(clipboardSet).toHaveBeenLastCalledWith(CREATED_TOKEN);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(JSON.stringify(harness.requests.filter(request => request.path !== EXTERNAL_KEY_CREATE_PATH)))
            .not.toContain(CREATED_TOKEN);
        await screen.pressByTestIdAsync('team-credential-external-reveal-done');
        expect(screen.getTextContent()).not.toContain(CREATED_TOKEN);
    });

    // The creation answer is the only copy of a bearer. Creating another key
    // on the same mounted screen is the same loss as leaving it, so it asks the
    // same one reveal-loss question before anything is sent.
    it('keeps an uncopied bearer when another creation is declined and replaces it only after the loss is accepted', async () => {
        const oldKey = key('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'resource-1', 'Old runner');
        const serverId = await addManagedHome([oldKey]);
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: key(CREATED_KEY_ID, 'resource-1', 'CI runner') },
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-assignee')).not.toBeNull());
        act(() => screen.changeTextByTestId('team-credential-external-label', 'CI runner'));
        await chooseMember(screen);
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(CREATED_TOKEN));
        expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)).toHaveLength(1);

        // The Home mints v4 key ids; the bearer grammar rejects any other.
        const secondKeyId = '7ba7b810-9dad-41d1-80b4-00c04fd430c8';
        const secondToken = `hapek_v1_${secondKeyId}_${'b'.repeat(43)}`;
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: secondToken, key: key(secondKeyId, 'resource-1', 'Old runner') },
        });
        await screen.pressByTestIdAsync(`team-credential-external-replace:${oldKey.keyId}`);
        modalConfirm.mockResolvedValueOnce(false);
        await screen.pressByTestIdAsync('team-credential-external-create');
        expect(modalConfirm).toHaveBeenCalledWith(
            'teams.credentials.externalApi.revealDismiss.title',
            'teams.credentials.externalApi.revealDismiss.body',
            expect.anything(),
        );
        expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)).toHaveLength(1);
        expect(screen.getTextContent()).toContain(CREATED_TOKEN);

        modalConfirm.mockResolvedValueOnce(true);
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(secondToken));
        expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)).toHaveLength(2);
        expect(screen.getTextContent()).not.toContain(CREATED_TOKEN);

        // A copied bearer needs no local reveal-loss decision. The create
        // Action still owns its independently configured confirmation.
        await screen.pressByTestIdAsync('team-credential-external-value:token');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:token')?.props.accessibilityLabel).toContain('common.copied'));
        modalConfirm.mockClear();
        act(() => screen.changeTextByTestId('team-credential-external-label', 'Third runner'));
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)).toHaveLength(3));
        expect(modalConfirm.mock.calls.filter(([title]) => title === 'teams.credentials.externalApi.revealDismiss.title')).toHaveLength(0);
    });

    it.each(['label', 'member', 'expiry', 'replacement'] as const)('guards an unsaved %s before navigation without creating a credential', async (field) => {
        const oldKey = key('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'resource-1', 'Old runner');
        const serverId = await addManagedHome([oldKey]);
        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-assignee')).not.toBeNull());
        expect(navigationState.preventRemove).toBe(false);
        if (field === 'label') act(() => screen.changeTextByTestId('team-credential-external-label', 'Unsaved runner'));
        else if (field === 'member') await chooseMember(screen);
        else if (field === 'expiry') await screen.pressByTestIdAsync('team-credential-external-expiry:30d');
        else await screen.pressByTestIdAsync(`team-credential-external-replace:${oldKey.keyId}`);

        expect(navigationState.preventRemove).toBe(true);
        const action = { type: 'GO_BACK' };
        await act(async () => {
            navigationState.onPreventRemove?.({ data: { action } });
            await Promise.resolve();
        });
        const buttons = modalAlert.mock.lastCall?.[2];
        expect(buttons).toHaveLength(2);
        await act(async () => { await buttons?.find(button => button.style === 'cancel')?.onPress?.(); });
        expect(navigationState.dispatch).not.toHaveBeenCalled();
        expect(navigationState.preventRemove).toBe(true);
        await act(async () => {
            navigationState.onPreventRemove?.({ data: { action } });
            await Promise.resolve();
        });
        await act(async () => { await modalAlert.mock.lastCall?.[2]?.find(button => button.style === 'destructive')?.onPress?.(); });
        await waitForHomeGovernance(() => expect(navigationState.dispatch).toHaveBeenCalledWith(action));
        expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)).toHaveLength(0);
        expect(modalConfirm).not.toHaveBeenCalled();
    });

    it('uses one reveal-loss confirmation for native/browser navigation removal and keeps the bearer when canceled', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: key(CREATED_KEY_ID, 'resource-1', 'CI runner') },
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-assignee')).not.toBeNull());
        act(() => screen.changeTextByTestId('team-credential-external-label', 'CI runner'));
        await chooseMember(screen);
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('team-credential-external-value:token')).not.toBeNull();
            expect(navigationState.preventRemove).toBe(true);
            expect(navigationState.setOptions).toHaveBeenCalledWith({ gestureEnabled: false });
        });

        modalConfirm.mockResolvedValueOnce(false);
        await act(async () => {
            navigationState.onPreventRemove?.({ data: { action: { type: 'GO_BACK' } } });
            await Promise.resolve();
        });
        expect(navigationState.dispatch).not.toHaveBeenCalled();
        expect(screen.findByTestId('team-credential-external-value:token')).not.toBeNull();

        modalConfirm.mockResolvedValueOnce(true);
        await act(async () => {
            navigationState.onPreventRemove?.({ data: { action: { type: 'REPLACE', payload: { target: 'resource-2' } } } });
            await Promise.resolve();
            await Promise.resolve();
        });
        await waitForHomeGovernance(() => expect(navigationState.dispatch).toHaveBeenCalledWith({
            type: 'REPLACE',
            payload: { target: 'resource-2' },
        }));
    });

    it('restores the prior exact route when a mounted target replacement would discard an uncopied bearer', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: key(CREATED_KEY_ID, 'resource-1', 'CI runner') },
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-assignee')).not.toBeNull());
        act(() => screen.changeTextByTestId('team-credential-external-label', 'CI runner'));
        await chooseMember(screen);
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:token')).not.toBeNull());

        modalConfirm.mockResolvedValueOnce(false);
        harness.answer(serverId, CREDENTIAL_GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-2' }),
        });
        await screen.update(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-2" />,
        );

        await waitForHomeGovernance(() => expect(routerReplace).toHaveBeenCalledWith(
            `/settings/teams/${serverId}/team-1/credentials/resource-1/external-api`,
        ));
        // The router spy records replacement; render the route it restored.
        harness.answer(serverId, CREDENTIAL_GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-1' }),
        });
        await screen.update(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:token')).not.toBeNull());
        expect(screen.getTextContent()).toContain(CREATED_TOKEN);
    });

    it('loads only the newly accepted resource after a mounted target replacement discards an uncopied bearer', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: key(CREATED_KEY_ID, 'resource-1', 'CI runner') },
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-assignee')).not.toBeNull());
        act(() => screen.changeTextByTestId('team-credential-external-label', 'CI runner'));
        await chooseMember(screen);
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:token')).not.toBeNull());

        harness.answer(serverId, CREDENTIAL_GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-2' }),
        });
        harness.answer(serverId, EXTERNAL_KEYS_LIST_PATH, { body: { keys: [] } });
        const listRequestsBeforeReplacement = harness.requestsFor(EXTERNAL_KEYS_LIST_PATH).length;
        modalConfirm.mockResolvedValueOnce(true);
        await screen.update(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-2" />,
        );

        await waitForHomeGovernance(() => expect(harness.requestsFor(EXTERNAL_KEYS_LIST_PATH)).toHaveLength(
            listRequestsBeforeReplacement + 1,
        ));
        expect(harness.requestsFor(EXTERNAL_KEYS_LIST_PATH).at(-1)?.input).toMatchObject({ resourceId: 'resource-2' });
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-empty')).not.toBeNull());
        expect(screen.findByTestId('team-credential-external-value:token')).toBeNull();
    });

    it('creates a replacement before optionally revoking the old key and preserves the old key on either failure', async () => {
        const oldKey = key('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'resource-1', 'Old runner');
        const serverId = await addManagedHome([oldKey]);
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, { status: 503, body: { error: 'unavailable' } });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId(`team-credential-external-key:${oldKey.keyId}`)).not.toBeNull());
        await screen.pressByTestIdAsync(`team-credential-external-replace:${oldKey.keyId}`);
        await screen.pressByTestIdAsync('team-credential-external-create');
        expect(screen.findByTestId(`team-credential-external-key:${oldKey.keyId}`)).not.toBeNull();
        expect(harness.requestsFor(EXTERNAL_KEY_REVOKE_PATH)).toHaveLength(0);

        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: key(CREATED_KEY_ID, 'resource-1', 'Old runner') },
        });
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-replace-revoke-old')).not.toBeNull());
        expect(screen.findByTestId(`team-credential-external-key:${oldKey.keyId}`)).not.toBeNull();

        harness.answer(serverId, EXTERNAL_KEY_REVOKE_PATH, { status: 503, body: { error: 'unavailable' } });
        await screen.pressByTestIdAsync('team-credential-external-replace-revoke-old');
        expect(screen.findByTestId(`team-credential-external-key:${oldKey.keyId}`)).not.toBeNull();

        harness.answer(serverId, EXTERNAL_KEY_REVOKE_PATH, { body: { keyId: oldKey.keyId, revoked: true } });
        await screen.pressByTestIdAsync('team-credential-external-replace-revoke-old');
        await waitForHomeGovernance(() => expect(screen.findByTestId(`team-credential-external-key:${oldKey.keyId}`)).toBeNull());
    });

    it('shows which key a staged replacement targets and lets it be cleared before creating', async () => {
        const oldKey = key('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'resource-1', 'Old runner');
        const serverId = await addManagedHome([oldKey]);
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: key(CREATED_KEY_ID, 'resource-1', 'Old runner') },
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId(`team-credential-external-key:${oldKey.keyId}`)).not.toBeNull());

        // Replace stages a target. Before this it was invisible state that silently
        // changed what the next Create offered to revoke.
        expect(screen.findByTestId('team-credential-external-replace-staged')).toBeNull();
        await screen.pressByTestIdAsync(`team-credential-external-replace:${oldKey.keyId}`);
        expect(screen.findByTestId('team-credential-external-replace-staged')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Old runner');

        // Clearing it must actually unstage: the created key offers no revoke-old row.
        await screen.pressByTestIdAsync('team-credential-external-replace-staged');
        expect(screen.findByTestId('team-credential-external-replace-staged')).toBeNull();
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-reveal-done')).not.toBeNull());
        expect(screen.findByTestId('team-credential-external-replace-revoke-old')).toBeNull();
        expect(screen.findByTestId(`team-credential-external-key:${oldKey.keyId}`)).not.toBeNull();
    });

    // Own-UI Ask is local confirmation (docs/actions.md); protocol approval-policy
    // tests retain coverage of live-only custody for non-UI approval requests.
    it('shows the bearer once after local Ask confirmation without creating an approval Artifact', async () => {
        const serverId = await addManagedHome();
        await harness.requireUiApproval(serverId, 'teams.credentials.externalKeys.create');
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: key(CREATED_KEY_ID, 'resource-1', 'CI runner') },
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-assignee')).not.toBeNull());
        act(() => screen.changeTextByTestId('team-credential-external-label', 'CI runner'));
        await chooseMember(screen);
        const confirmation = createDeferred<boolean>();
        modalConfirm.mockClear().mockReturnValueOnce(confirmation.promise);
        await screen.pressByTestIdAsync('team-credential-external-create');

        await waitForHomeGovernance(() => expect(modalConfirm).toHaveBeenCalledOnce());
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)).toHaveLength(0);
        expect(screen.findByTestId('team-credential-external-value:token')).toBeNull();

        await act(async () => confirmation.resolve(true));

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-value:token')).not.toBeNull());
        expect(screen.getTextContent()).toContain(CREATED_TOKEN);
        expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)[0]?.input).toMatchObject({
            teamMembershipId: 'membership-1',
            keyId: expect.any(String),
            label: { content: { t: 'plain', v: 'CI runner' }, recipients: [] },
        });
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(JSON.stringify(harness.requests.filter(request => request.path !== EXTERNAL_KEY_CREATE_PATH)))
            .not.toContain(CREATED_TOKEN);
    });

    it('keeps a declined local Ask confirmation from reaching the Home or revealing a bearer', async () => {
        const serverId = await addManagedHome();
        await harness.requireUiApproval(serverId, 'teams.credentials.externalKeys.create');
        harness.answer(serverId, EXTERNAL_KEY_CREATE_PATH, {
            body: { token: CREATED_TOKEN, key: key(CREATED_KEY_ID, 'resource-1', 'CI runner') },
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-assignee')).not.toBeNull());
        act(() => screen.changeTextByTestId('team-credential-external-label', 'CI runner'));
        await chooseMember(screen);
        modalConfirm.mockClear().mockResolvedValueOnce(false);
        await screen.pressByTestIdAsync('team-credential-external-create');
        await waitForHomeGovernance(() => expect(modalConfirm).toHaveBeenCalledOnce());

        await waitForHomeGovernance(() => expect(
            screen.findHostByTestId('team-credential-external-create')?.props.disabled,
        ).toBe(false));
        expect(harness.requestsFor(EXTERNAL_KEY_CREATE_PATH)).toHaveLength(0);
        expect(screen.findByTestId('team-credential-external-value:token')).toBeNull();
        expect(screen.getTextContent()).not.toContain(CREATED_TOKEN);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });

    it.each([
        {
            label: 'one key',
            actionId: 'teams.credentials.externalKeys.revoke' as const,
            expectedInput: { resourceId: 'resource-1', keyId: CREATED_KEY_ID },
            result: { keyId: CREATED_KEY_ID, revoked: true },
            pressId: `team-credential-external-revoke:${CREATED_KEY_ID}`,
            mutationPath: EXTERNAL_KEY_REVOKE_PATH,
        },
        {
            label: 'all keys',
            actionId: 'teams.credentials.externalKeys.revokeAll' as const,
            expectedInput: { resourceId: 'resource-1' },
            result: { resourceId: 'resource-1', revokedCount: 1 },
            pressId: 'team-credential-external-revoke-all',
            mutationPath: EXTERNAL_KEY_REVOKE_ALL_PATH,
        },
    ])('revokes $label after local Ask confirmation without redispatching', async (scenario) => {
        const existing = key(CREATED_KEY_ID, 'resource-1', 'CI runner');
        const serverId = await addManagedHome([existing]);
        await harness.requireUiApproval(serverId, scenario.actionId);
        harness.answer(serverId, scenario.mutationPath, { body: scenario.result });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId(`team-credential-external-key:${CREATED_KEY_ID}`)).not.toBeNull());
        const confirmation = createDeferred<boolean>();
        modalConfirm.mockClear().mockReturnValueOnce(confirmation.promise);
        await screen.pressByTestIdAsync(scenario.pressId);
        await waitForHomeGovernance(() => expect(modalConfirm).toHaveBeenCalledOnce());
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
        expect(screen.findHostByTestId(`team-credential-external-revoke:${CREATED_KEY_ID}`)?.props.disabled).toBe(true);
        expect(harness.requestsFor(scenario.mutationPath)).toHaveLength(0);

        // The Home list refresh must describe the committed state.
        harness.answer(serverId, EXTERNAL_KEYS_LIST_PATH, { body: { keys: [] } });
        await act(async () => confirmation.resolve(true));

        await waitForHomeGovernance(() => expect(screen.findByTestId(`team-credential-external-key:${CREATED_KEY_ID}`)).toBeNull());
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-approval')).toBeNull());
        expect(harness.requestsFor(scenario.mutationPath)).toHaveLength(1);
        expect(harness.requestsFor(scenario.mutationPath)[0]?.input).toMatchObject(scenario.expectedInput);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });

    it('settles an initial resource-list failure and retries before reading keys', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://private-home-a.example', publicServerUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
            credentialResourcesExternalApiEnabled: true,
            credentialResourcesExternalApiAvailability: {
                available: true,
                baseUrl: 'https://home-a.example/api/provider-broker/v1',
                protocols: ['openai_responses', 'openai_chat_completions', 'anthropic_messages'],
            },
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, CREDENTIAL_GET_PATH, { status: 503, body: { error: 'unavailable' } });
        harness.answer(serverId, EXTERNAL_KEYS_LIST_PATH, { body: { keys: [] } });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => {
            expect(screen.findByTestId('team-credential-external-resource-retry')).not.toBeNull();
        });
        expect(harness.requestsFor(EXTERNAL_KEYS_LIST_PATH)).toHaveLength(0);

        harness.answer(serverId, CREDENTIAL_GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-1' }),
        });
        await screen.pressByTestIdAsync('team-credential-external-resource-retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-credential-external-empty')).not.toBeNull());
    });

    it('does not let an older resource response overwrite a newly selected target', async () => {
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://private-home-a.example', publicServerUrl: 'https://home-a.example', accountId: 'account-ada',
            teamsEnabled: true, credentialResourcesEnabled: true,
            credentialResourcesExternalApiEnabled: true,
            credentialResourcesExternalApiAvailability: {
                available: true,
                baseUrl: 'https://home-a.example/api/provider-broker/v1',
                protocols: ['openai_responses', 'openai_chat_completions', 'anthropic_messages'],
            },
        });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }),
        });
        harness.answer(serverId, CREDENTIAL_GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-1', displayName: 'First' }),
        });

        let releaseFirst!: () => void;
        const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
        harness.answer(serverId, EXTERNAL_KEYS_LIST_PATH, {
            respondAfter: firstPending,
            body: { keys: [key('550e8400-e29b-41d4-a716-446655440000', 'resource-1', 'Old target')] },
        });

        const screen = await renderScreen(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-1" />,
        );
        await waitForHomeGovernance(() => expect(harness.requestsFor(EXTERNAL_KEYS_LIST_PATH)).toHaveLength(1));

        harness.answer(serverId, EXTERNAL_KEYS_LIST_PATH, {
            body: { keys: [key('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'resource-2', 'Current target')] },
        });
        harness.answer(serverId, CREDENTIAL_GET_PATH, {
            body: teamCredentialResourceFixture({ id: 'resource-2', displayName: 'Second' }),
        });
        await screen.update(
            <TeamCredentialExternalApiScreen serverId={serverId} teamId="team-1" resourceId="resource-2" />,
        );
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(
                'team-credential-external-key:6ba7b810-9dad-11d1-80b4-00c04fd430c8',
            );
        });

        releaseFirst();
        await waitForHomeGovernance(() => {
            expect(screen.getTextContent()).toContain('Current target');
            expect(screen.getTextContent()).not.toContain('Old target');
        });
    });
});
