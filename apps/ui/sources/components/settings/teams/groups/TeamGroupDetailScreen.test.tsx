import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { projectPrivateLabelForRecipientV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPrivateLabelClient } from '@/sync/ops/privateLabels/privateLabelClient';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { accountDisplayProfileFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { teamCapabilitiesFixture, teamGroupFixture, teamGroupMemberFixture, teamMembershipFixture, teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const groupRouterPush = vi.hoisted(() => vi.fn());

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

const GROUP_DETAIL_RENDERED_ROW_WINDOW = 20;
const groupDetailLegendListState = vi.hoisted(() => ({
    mock: null as { state: { props: Record<string, unknown> | null; reset: () => void } } | null,
    get props(): Record<string, unknown> | null {
        return this.mock?.state.props ?? null;
    },
}));

// The canonical list adapter remains real; only its third-party recycler is a
// boundary here so a large roster proves that the screen mounts a bounded
// virtual window instead of every account row.
//
// It is a *partial* replacement: `@legendapp/list/section-list`, reached through
// the same canonical barrel, imports `internal` from this module, so dropping
// the original exports would make the barrel unimportable rather than mocking
// the recycler.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const mock = createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(),
        renderItemLimit: GROUP_DETAIL_RENDERED_ROW_WINDOW,
    });
    groupDetailLegendListState.mock = mock;
    return mock.module;
});

// App-bundled plugin bytes are a generated build boundary (absent on synchronized targets);
// the Agent marks on the members' defaults rows read brand marks from it.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: Object.freeze([]),
    BUNDLED_PLUGIN_BRAND_MARKS: Object.freeze([]),
    BUNDLED_PLUGIN_PACKAGED_RESOURCES: Object.freeze([]),
}));

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: groupRouterPush, back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
        usePathname: () => '/settings/teams',
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        // Every destructive Group action is confirmed; these cases are about
        // what happens after the manager says yes — and, for the removal
        // dialog, about what they were actually asked.
        return createModalModuleMock({ confirmResult: true }).module;
    },
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.doUnmock('@/sync/domains/state/storage');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
// Load the real screen graph during collection, after installing boundaries.
// Cold transformation must finish before a test owns a mounted React act scope.
const { TeamGroupDetailScreen } = await import('./TeamGroupDetailScreen');

const TEAM_GET_PATH = '/v1/teams/get';
const GROUP_GET_PATH = '/v1/teams/groups/get';
const GROUP_UPDATE_PATH = '/v1/teams/groups/update';
const GROUP_MEMBERS_LIST_PATH = '/v1/teams/groups/members/list';
const GROUP_MEMBER_ADD_PATH = '/v1/teams/groups/members/add';
const GROUP_MEMBER_REMOVE_PATH = '/v1/teams/groups/members/remove';
const TEAM_MEMBERS_LIST_PATH = '/v1/teams/members/list';
const GROUP_RESTORE_PATH = '/v1/teams/groups/restore';
const ARTIFACT_CREATE_PATH = '/v1/artifacts';

const MANAGED_GROUP_CAPABILITIES = {
    updateMetadata: true,
    archive: true,
    restore: true,
    manageNativeMembers: true,
};

async function renderGroupDetail(serverId: string) {
    return renderScreen(
        <TeamGroupDetailScreen serverId={serverId} teamId="team-1" groupId="group-1" />,
    );
}

async function addManagedHome(): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-ada',
        teamsEnabled: true,
    });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, TEAM_GET_PATH, {
        body: teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageGroups: true }),
        }),
    });
    return serverId;
}

/** Opens a roster row's ⋯ menu unless it is already open (a closing menu can keep its last items). */
async function openRowMenu(
    screen: Awaited<ReturnType<typeof renderGroupDetail>>,
    accountId: string,
): Promise<void> {
    const open = screen.findAllByTestId(`team-group-member-actions:${accountId}`)
        .some((node) => node.props.accessibilityState?.expanded === true);
    if (!open) await screen.pressByTestIdAsync(`team-group-member-actions:${accountId}`);
}

/** A menu entry runs once its menu has closed, so callers wait on its effect. */
async function removeFromGroupThroughMenu(
    screen: Awaited<ReturnType<typeof renderGroupDetail>>,
    accountId: string,
): Promise<void> {
    await openRowMenu(screen, accountId);
    await screen.pressByTestIdAsync('remove-from-group');
}

async function waitForTestId(
    screen: Awaited<ReturnType<typeof renderGroupDetail>>,
    testID: string,
): Promise<void> {
    await vi.waitFor(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(testID);
    });
}

// A roster row's ⋯ menu opens in a Popover, which measures against the web window.
let restorePopoverGlobals: (() => void) | null = null;
beforeEach(async () => {
    restorePopoverGlobals = withPopoverWebGlobals();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    await harness.reset();
    await harness.selectHomes([]);
    groupRouterPush.mockReset();
    groupDetailLegendListState.mock?.state.reset();
});

afterEach(() => {
    restorePopoverGlobals?.();
    restorePopoverGlobals = null;
    standardCleanup();
});

describe('TeamGroupDetailScreen', () => {
    it('opens an E2EE description for the real editor and header, then clears it with explicit null', async () => {
        const secret = new Uint8Array(32).fill(52);
        const credentials = { token: createAccountTokenForTests('account-ada'), secret: encodeBase64(secret, 'base64url') };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        if (!encryption) throw new Error('E2EE fixture needs actual key material');
        const serverId = await harness.addHome({ name: 'Description Home', serverUrl: 'https://description-detail.example',
            accountId: 'account-ada', teamsEnabled: true, accountEncryptionMode: 'e2ee', credentials });
        harness.answer(serverId, 'GET /v1/account/encryption/currentness', { body: createLegacyAccountEncryptionCurrentnessFixture({ secret }) });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, TEAM_GET_PATH, { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageGroups: true }) }) });
        harness.answer(serverId, '/v1/account/private-labels/recipient-census', { body: { contentEncryptionMode: 'e2ee',
            recipients: [{ account: { kind: 'account', accountId: 'account-ada', firstName: null, lastName: null, username: null, avatarUrl: null },
                readiness: { status: 'available', contentPublicKey: encodeBase64(encryption.contentDataKey),
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey) }, envelopeStatus: 'missing' }] } });
        const description = await createPrivateLabelClient({ serverId, accountId: 'account-ada' }).seal({
            owner: { kind: 'team', teamId: 'team-1' }, binding: { entity: 'team_group', field: 'description', id: 'group-1' },
            value: 'Private Group context' });
        if (!description) throw new Error('Description sealing failed');
        expect(JSON.stringify(description)).not.toContain('Private Group context');
        const group = teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES, description: { kind: 'available',
            label: projectPrivateLabelForRecipientV1({ stored: description, recipientAccountId: 'account-ada' }) } });
        harness.answer(serverId, GROUP_GET_PATH, { body: group });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, GROUP_UPDATE_PATH, { body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES }) });
        const screen = await renderGroupDetail(serverId);
        await vi.waitFor(() => expect(screen.findByTestId('team-group-description')?.props.value).toBe('Private Group context'));
        expect(screen.getTextContent()).toContain('Private Group context');
        act(() => screen.changeTextByTestId('team-group-description', ''));
        await screen.pressByTestIdAsync('team-group-save');
        await vi.waitFor(() => expect(harness.requestsFor(GROUP_UPDATE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(GROUP_UPDATE_PATH)[0]!.input).toMatchObject({ description: null });
        expect(harness.requestsFor(GROUP_UPDATE_PATH)[0]!.input).not.toHaveProperty('name');
    });

    it('promotes a readable legacy description on a normal name save without rewriting on read', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, '/v1/account/private-labels/recipient-census', { body: { contentEncryptionMode: 'plain', recipients: [] } });
        const group = teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES, description: { kind: 'available',
            label: { content: { t: 'plain', v: 'Retained context' }, recipientEnvelope: null, legacyPlaintext: true } } });
        harness.answer(serverId, GROUP_GET_PATH, { body: group });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, GROUP_UPDATE_PATH, { body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES,
            name: 'Renamed', description: 'Retained context' }) });
        const screen = await renderGroupDetail(serverId);
        await vi.waitFor(() => expect(screen.findByTestId('team-group-description')?.props.value).toBe('Retained context'));
        expect(harness.requestsFor(GROUP_UPDATE_PATH)).toHaveLength(0);
        act(() => screen.changeTextByTestId('team-group-name', 'Renamed'));
        await screen.pressByTestIdAsync('team-group-save');
        await vi.waitFor(() => expect(harness.requestsFor(GROUP_UPDATE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(GROUP_UPDATE_PATH)[0]!.input).toMatchObject({
            description: { content: { t: 'plain', v: 'Retained context' }, recipients: [] } });
        expect(harness.requestsFor(GROUP_UPDATE_PATH)[0]!.input).not.toHaveProperty('description.legacyPlaintext');
    });

    it('keeps an unavailable description visible and omits it from an unrelated name save', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, '/v1/account/private-labels/recipient-census', { body: { contentEncryptionMode: 'plain', recipients: [] } });
        const group = teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES, description: { kind: 'unavailable' } });
        harness.answer(serverId, GROUP_GET_PATH, { body: group });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, GROUP_UPDATE_PATH, { body: { ...group, name: teamGroupFixture({ name: 'Renamed' }).name } });
        const screen = await renderGroupDetail(serverId);
        await vi.waitFor(() => expect(screen.findByTestId('team-group-name')?.props.value).toBe('Developers'));
        expect(screen.findByTestId('team-group-description')?.props.editable).toBe(false);
        expect(screen.findByTestId('team-group-description')?.props.placeholder).toBe('common.unavailable');
        act(() => screen.changeTextByTestId('team-group-name', 'Renamed'));
        await screen.pressByTestIdAsync('team-group-save');
        await vi.waitFor(() => expect(harness.requestsFor(GROUP_UPDATE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(GROUP_UPDATE_PATH)[0]!.input).not.toHaveProperty('description');
    });

    it('UX keeps dirty Group metadata when navigation is canceled', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, { body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES }) });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-name');
        act(() => screen.changeTextByTestId('team-group-name', 'Unfinished'));
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockImplementation((_title, _message, buttons) => {
            buttons?.find((button) => button.style === 'cancel')?.onPress?.();
        });
        const { runGuardedNavigation } = await import('@/utils/navigation/runGuardedNavigation');
        const leave = vi.fn();
        let departed: boolean | undefined;
        await act(async () => { departed = await runGuardedNavigation(leave); });
        expect(departed).toBe(false);
        expect(leave).not.toHaveBeenCalled();
        expect(screen.findByTestId('team-group-name')?.props.value).toBe('Unfinished');
        expect(harness.requestsFor(GROUP_UPDATE_PATH)).toHaveLength(0);
    });

    it('promotes a retained raw Group name when its description is normally saved', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, '/v1/account/private-labels/recipient-census', {
            body: { contentEncryptionMode: 'plain', recipients: [] },
        });
        const group = teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES,
            name: { kind: 'available', label: { content: { t: 'plain', v: 'Retained Group' },
                recipientEnvelope: null, legacyPlaintext: true } } });
        harness.answer(serverId, GROUP_GET_PATH, { body: group });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, GROUP_UPDATE_PATH, { body: teamGroupFixture({
            capabilities: MANAGED_GROUP_CAPABILITIES, name: 'Retained Group', description: 'Updated description' }) });
        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-description');
        await vi.waitFor(() => expect(screen.findByTestId('team-group-name')?.props.value).toBe('Retained Group'));
        await act(async () => screen.changeTextByTestId('team-group-description', 'Updated description'));
        await act(async () => screen.pressByTestId('team-group-save'));
        await vi.waitFor(() => expect(harness.requestsFor(GROUP_UPDATE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(GROUP_UPDATE_PATH)[0]?.input).toMatchObject({
            name: { content: { t: 'plain', v: 'Retained Group' }, recipients: [] },
            description: { content: { t: 'plain', v: 'Updated description' }, recipients: [] },
        });
    });

    it('starts only one metadata save when pressed twice before React renders busy state', async () => {
        let releaseUpdate = (): void => {};
        const respondAfter = new Promise<void>((resolve) => { releaseUpdate = resolve; });
        const serverId = await addManagedHome();
        harness.answer(serverId, '/v1/account/private-labels/recipient-census', {
            body: { contentEncryptionMode: 'plain', recipients: [] },
        });
        const group = teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES });
        harness.answer(serverId, GROUP_GET_PATH, { body: group });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, GROUP_UPDATE_PATH, { body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES, name: 'Edited Group' }), respondAfter });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-save');
        act(() => {
            screen.changeTextByTestId('team-group-name', 'Edited Group');
        });
        act(() => {
            screen.pressByTestId('team-group-save');
            screen.pressByTestId('team-group-save');
        });

        await vi.waitFor(() => expect(harness.requestsFor(GROUP_UPDATE_PATH)).toHaveLength(1));
        await act(async () => releaseUpdate());
    });

    it('renders a large Group roster as bounded chunks in the canonical virtualized list', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES, memberCount: 1_000 }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: {
                items: Array.from({ length: 1_000 }, (_, index) => teamGroupMemberFixture({
                    accountId: `account-${index}`,
                    membershipId: `membership-${index}`,
                })),
                nextCursor: null,
            },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-member:account-0');

        // The canonical adapter forwards the surface identity as `data-testid`
        // on web and `testID` on native; either proves it reached the recycler.
        expect(groupDetailLegendListState.props?.['data-testid']
            ?? groupDetailLegendListState.props?.testID)
            .toBe('team-group-detail-virtualized-list');
        expect(groupDetailLegendListState.props?.maintainVisibleContentPosition).toBe(true);
        const data = groupDetailLegendListState.props?.data as readonly unknown[];
        expect(data.length).toBeLessThan(1_000);
        const keyExtractor = groupDetailLegendListState.props?.keyExtractor as (item: unknown) => string;
        expect(data.map(keyExtractor)).toEqual(expect.arrayContaining([
            'members:membership-0',
            'members:membership-12',
            'members:membership-996',
        ]));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-member:account-999');
    });

    it('keeps a large accumulated add-candidate roster inside the same bounded virtual window', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES, memberCount: 0 }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, TEAM_MEMBERS_LIST_PATH, {
            body: {
                items: Array.from({ length: 1_000 }, (_, index) => teamMembershipFixture({
                    id: `candidate-membership-${index}`,
                    accountId: `candidate-account-${index}`,
                })),
                nextCursor: null,
            },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-add-member');
        act(() => screen.pressByTestId('team-group-add-member'));
        await waitForTestId(screen, 'team-group-candidate:candidate-account-0');

        const data = groupDetailLegendListState.props?.data as readonly unknown[];
        const keyExtractor = groupDetailLegendListState.props?.keyExtractor as (item: unknown) => string;
        expect(data.length).toBeLessThan(1_000);
        expect(data.map(keyExtractor)).toEqual(expect.arrayContaining([
            'candidates:candidate-membership-0',
            'candidates:candidate-membership-12',
            'candidates:candidate-membership-996',
        ]));
        expect(collectRenderedTestIds(screen.tree.toJSON()))
            .not.toContain('team-group-candidate:candidate-account-999');
    });

    it('reserves one loading row per known member while the first roster page is in flight', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ memberCount: 1, capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        let releaseRoster!: () => void;
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [], nextCursor: null },
            respondAfter: new Promise<void>((resolve) => { releaseRoster = resolve; }),
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-members-loading-skeleton:0');
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('team-group-members-loading-skeleton:1');
        releaseRoster();
    });

    it('offers retry for a transient Group-detail read failure', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, { status: 503, body: { error: 'unavailable' } });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-unavailable-action');
        expect(screen.getTextContent()).toContain('teams.errors.loadFailed');

        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        await screen.pressByTestIdAsync('team-group-unavailable-action');
        await waitForTestId(screen, 'team-group-save');
    });

    it('does not mislabel an authoritative Group-detail refusal as retryable offline', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, { status: 403, body: { error: 'forbidden' } });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-unavailable');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-unavailable-action');
        expect(screen.getTextContent()).toContain('teams.errors.forbidden');
    });

    it('opens the person when a roster row is pressed, and keeps removal in its menu', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [teamGroupMemberFixture({ membershipId: 'membership-ada' })], nextCursor: null },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-member:account-ada');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-group-save');

        // Every person row opens the person; a press never removes anyone.
        await screen.pressByTestIdAsync('team-group-member:account-ada');
        expect(groupRouterPush).toHaveBeenCalledWith(
            `/settings/teams/${encodeURIComponent(serverId)}/team-1/members/membership-ada?groupId=group-1&accountId=account-ada`,
        );
        expect(harness.requestsFor(GROUP_MEMBER_REMOVE_PATH)).toHaveLength(0);
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('open-member-detail');
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-group-member-actions:account-ada');
    });

    it('refreshes the rendered point detail when another client publishes a Teams AccountChange', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ name: 'Before', memberCount: 1, capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [teamGroupMemberFixture()], nextCursor: null },
        });

        const screen = await renderGroupDetail(serverId);
        await vi.waitFor(() => {
            // The count is a fact on the Group's page header.
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-group-member-count');
            expect(screen.getTextContent()).toContain('teams.groups.memberCount(count=1)');
        });
        const requestsBefore = harness.requestsFor(GROUP_GET_PATH).length;

        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({
                name: 'After',
                memberCount: 2,
                capabilities: { ...MANAGED_GROUP_CAPABILITIES, manageNativeMembers: false },
            }),
        });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1} = await import('@happier-dev/protocol/changes');
        await act(async () => {
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });

        await vi.waitFor(() => {
            expect(harness.requestsFor(GROUP_GET_PATH).length).toBeGreaterThan(requestsBefore);
            // The count is a fact on the Group's page header.
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-group-member-count');
            expect(screen.getTextContent()).toContain('teams.groups.memberCount(count=2)');
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-add-member');
        });
    });

    it('navigates each external contribution to its exact canonical source owner', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: {
                items: [teamGroupMemberFixture({
                    contributions: {
                        native: false,
                        external: [
                            {
                                bindingId: 'binding-okta',
                                label: 'Okta',
                                owner: { kind: 'directory_source', directorySourceId: 'source-okta' },
                            },
                            {
                                bindingId: 'binding-sso',
                                label: 'Acme SSO',
                                owner: { kind: 'identity_connection', teamIdentityConnectionId: 'connection-acme' },
                            },
                        ],
                    },
                })],
                nextCursor: null,
            },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-member:account-ada');

        await openRowMenu(screen, 'account-ada');
        await screen.pressByTestIdAsync('open-external-source:binding-okta');
        await vi.waitFor(() => expect(groupRouterPush).toHaveBeenLastCalledWith(
            `/settings/teams/${encodeURIComponent(serverId)}/team-1/authentication/directory/source-okta`,
        ));
        await openRowMenu(screen, 'account-ada');
        await screen.pressByTestIdAsync('open-external-source:binding-sso');
        await vi.waitFor(() => expect(groupRouterPush).toHaveBeenLastCalledWith(
            `/settings/teams/${encodeURIComponent(serverId)}/team-1/authentication/connection-acme`,
        ));
    });

    it('opens the exact source owner of directory-created Group metadata', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({
                capabilities: MANAGED_GROUP_CAPABILITIES,
                management: {
                    kind: 'directory_created',
                    bindingId: 'binding-okta',
                    label: 'Okta',
                    owner: { kind: 'directory_source', directorySourceId: 'source-okta' },
                },
            }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [], nextCursor: null },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-managed-by');
        await screen.pressByTestIdAsync('team-group-managed-by');

        expect(groupRouterPush).toHaveBeenCalledWith(
            `/settings/teams/${encodeURIComponent(serverId)}/team-1/authentication/directory/source-okta`,
        );
    });

    it('sends the Group its own history intent, not the Team horizon', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES, memberCount: 0 }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, TEAM_MEMBERS_LIST_PATH, {
            body: {
                items: [teamMembershipFixture({
                    id: 'membership-grace',
                    accountId: 'account-grace',
                    account: accountDisplayProfileFixture('Grace'),
                    // The Team horizon this person already holds is deliberately
                    // the opposite of the Group choice made below.
                    historyAccess: 'all_existing',
                })],
                nextCursor: null,
            },
        });
        harness.answer(serverId, GROUP_MEMBER_ADD_PATH, {
            body: {
                status: 'added',
                member: teamGroupMemberFixture({
                    accountId: 'account-grace',
                    membershipId: 'membership-grace',
                    account: accountDisplayProfileFixture('Grace'),
                }),
            },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-add-member');
        act(() => screen.pressByTestId('team-group-add-member'));
        await waitForTestId(screen, 'team-group-history:all_existing');
        // The Group's own history choice has to be committed before the add
        // reads it, or the add carries the default rather than the selection.
        act(() => screen.pressByTestId('team-group-history:all_existing'));
        await waitForTestId(screen, 'team-group-candidate:account-grace');
        await screen.pressByTestIdAsync('team-group-candidate:account-grace');

        await vi.waitFor(() => {
            expect(harness.requestsFor(GROUP_MEMBER_ADD_PATH)).toHaveLength(1);
        });
        expect(harness.requestsFor(GROUP_MEMBER_ADD_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            groupId: 'group-1',
            accountId: 'account-grace',
            historyAccess: 'all_existing',
        });
        expect(groupRouterPush).toHaveBeenCalledWith(
            `/settings/teams/${encodeURIComponent(serverId)}/team-1/members/membership-grace`
            + '?groupId=group-1&accountId=account-grace&prepareHistory=1',
        );
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
    });

    it('shows the add in flight on the chosen person until the Home answers', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES, memberCount: 0 }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, TEAM_MEMBERS_LIST_PATH, {
            body: {
                items: [teamMembershipFixture({ id: 'membership-grace', accountId: 'account-grace',
                    account: accountDisplayProfileFixture('Grace') })],
                nextCursor: null,
            },
        });
        let release!: () => void;
        harness.answer(serverId, GROUP_MEMBER_ADD_PATH, {
            respondAfter: new Promise<void>((resolve) => { release = resolve; }),
            body: { status: 'added', member: teamGroupMemberFixture({ accountId: 'account-grace',
                membershipId: 'membership-grace', account: accountDisplayProfileFixture('Grace') }) },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-add-member');
        act(() => screen.pressByTestId('team-group-add-member'));
        await waitForTestId(screen, 'team-group-candidate:account-grace');
        const press = screen.pressByTestIdAsync('team-group-candidate:account-grace');
        await vi.waitFor(() => {
            expect(harness.requestsFor(GROUP_MEMBER_ADD_PATH)).toHaveLength(1);
        });
        // The pressed person stays in view, marked in progress, and the section's add stays where it was.
        const pending = () => screen.tree.root.findAll((node) =>
            node.props.testID === 'team-group-candidate:account-grace' && node.props.loading === true);
        await vi.waitFor(() => expect(pending().length).toBeGreaterThan(0));
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-group-add-member');
        release();
        await press;
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-candidate:account-grace');
        });
    });

    it('presents Group history as a radio group and explains a failed candidate load with retry', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES, memberCount: 0 }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, TEAM_MEMBERS_LIST_PATH, { status: 503, body: { error: 'unavailable' } });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-add-member');
        act(() => screen.pressByTestId('team-group-add-member'));

        await waitForTestId(screen, 'team-group-history:from_membership');
        const selected = screen.findByTestId('team-group-history:from_membership');
        expect([selected?.props.accessibilityRole, selected?.props.role]).toContain('radio');
        expect(selected?.props.accessibilityState).toMatchObject({ checked: true });

        let ancestor = selected?.parent ?? null;
        while (ancestor
            && ancestor.props.accessibilityRole !== 'radiogroup'
            && ancestor.props.role !== 'radiogroup') {
            ancestor = ancestor.parent;
        }
        expect(ancestor).not.toBeNull();
        expect(ancestor?.props.accessibilityLabel ?? ancestor?.props['aria-label']).toBe('teams.history.label');
        // The horizon this choice mints is the Group's own, so both options name the
        // Group. The generic Team wording describes a different, broader audience.
        const historyText = screen.getTextContent();
        expect(historyText).toContain('teams.history.fromMembership');
        expect(historyText).toContain('teams.history.allExistingGroup');

        await waitForTestId(screen, 'team-group-candidates-retry');
        expect(screen.getTextContent()).toContain('teams.errors.loadFailed');
    });

    it('routes a native removal through the approval owner when a source still contributes', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: {
                items: [teamGroupMemberFixture({
                    contributions: {
                        native: true,
                        external: [{
                            bindingId: 'binding-okta',
                            label: 'Okta',
                            owner: { kind: 'directory_source', directorySourceId: 'source-okta' },
                        }],
                    },
                })],
                nextCursor: null,
            },
        });
        harness.answer(serverId, GROUP_MEMBER_REMOVE_PATH, {
            body: {
                status: 'contribution_removed',
                member: teamGroupMemberFixture({
                    contributions: {
                        native: false,
                        external: [{
                            bindingId: 'binding-okta',
                            label: 'Okta',
                            owner: { kind: 'directory_source', directorySourceId: 'source-okta' },
                        }],
                    },
                }),
            },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-member:account-ada');
        await removeFromGroupThroughMenu(screen, 'account-ada');

        await vi.waitFor(() => {
            expect(harness.requestsFor(GROUP_MEMBER_REMOVE_PATH)).toHaveLength(1);
        });
        expect(harness.requestsFor(GROUP_MEMBER_REMOVE_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            groupId: 'group-1',
            accountId: 'account-ada',
        });
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
    });

    it('confirms a native Group removal and preserves membership when canceled', async () => {
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        // The confirmed operation is `teams.groups.members.remove` for one
        // Account. The archive copy promises retained membership and a
        // restoration that this operation does not have, and it names neither
        // the person nor the Group.
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ name: 'Developers', capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [teamGroupMemberFixture()], nextCursor: null },
        });
        harness.answer(serverId, GROUP_MEMBER_REMOVE_PATH, {
            body: {
                status: 'removed',
                member: teamGroupMemberFixture({ contributions: { native: false, external: [] } }),
            },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-member:account-ada');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        await removeFromGroupThroughMenu(screen, 'account-ada');
        await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledTimes(1));
        expect(harness.requestsFor(GROUP_MEMBER_REMOVE_PATH)).toHaveLength(0);
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-group-member:account-ada');
        await removeFromGroupThroughMenu(screen, 'account-ada');

        await vi.waitFor(() => {
            expect(harness.requestsFor(GROUP_MEMBER_REMOVE_PATH)).toHaveLength(1);
        });
        expect(Modal.confirm).toHaveBeenCalledTimes(2);
    });

    it('keeps an unfinished Group description while a remote rename lands, and reconciles deliberately', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ name: 'Before', capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [teamGroupMemberFixture()], nextCursor: null },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-description');
        act(() => screen.changeTextByTestId('team-group-description', 'Owns the build'));

        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ name: 'After', capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1} = await import('@happier-dev/protocol/changes');
        await act(async () => {
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });

        // The Home's rename arrived; the unfinished draft is still the person's.
        await waitForTestId(screen, 'team-group-identity-conflict');
        expect(screen.findByTestId('team-group-description')?.props.value).toBe('Owns the build');
        expect(screen.findByTestId('team-group-save')?.props.disabled).toBe(true);

        await screen.pressByTestIdAsync('team-group-identity-conflict');
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-identity-conflict');
        });
        expect(screen.findByTestId('team-group-description')?.props.value).toBe('Owns the build');
    });

    it('adopts the published Group values into a pristine editor', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ name: 'Before', capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [teamGroupMemberFixture()], nextCursor: null },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-name');
        expect(screen.findByTestId('team-group-name')?.props.value).toBe('Before');

        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ name: 'After', capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1} = await import('@happier-dev/protocol/changes');
        await act(async () => {
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });

        await vi.waitFor(() => {
            expect(screen.findByTestId('team-group-name')?.props.value).toBe('After');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-identity-conflict');
    });

    it('names a failed Group refresh with its own retry and withholds Group writes until it answers', async () => {
        // The Team read succeeded; this Group's own point read did not. The
        // retained Group stays on screen, but presenting last-known
        // capabilities as current is what lets a manager act on them.
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [teamGroupMemberFixture()], nextCursor: null },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-member:account-ada');
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-stale');
        // While the Group is current the row offers its roster change in its menu;
        // this is the control that makes the withheld assertion below discriminating.
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-group-member-actions:account-ada');

        harness.answer(serverId, GROUP_GET_PATH, { status: 503, body: { error: 'unavailable' } });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1} = await import('@happier-dev/protocol/changes');
        await act(async () => {
            publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        });

        await waitForTestId(screen, 'team-group-stale-retry');
        // Retained, not discarded.
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-group-member:account-ada');
        expect(screen.findByTestId('team-group-archive')?.props.disabled).toBe(true);
        // The row still opens the person (a read), but its roster change is
        // withheld: the menu that carried it is gone while the Group is not current.
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-member-actions:account-ada');

        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES }),
        });
        await screen.pressByTestIdAsync('team-group-stale-retry');
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-stale-retry');
        });
        // The Group answered again, so its own writes come back. The point
        // read has to land first, so this waits for the Group's own answer
        // rather than for one render tick.
        await vi.waitFor(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('team-group-archive');
            expect(screen.findAllByTestId('team-group-archive')
                .find((node) => typeof node.props?.onPress === 'function')).toBeDefined();
        }, { timeout: 10_000 });
    });

    it('routes an externally supplied member native contribution through approval', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({
                capabilities: MANAGED_GROUP_CAPABILITIES,
                management: {
                    kind: 'directory_created',
                    bindingId: 'binding-okta',
                    label: 'Okta',
                    owner: { kind: 'directory_source', directorySourceId: 'source-okta' },
                },
            }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: {
                items: [teamGroupMemberFixture({
                    contributions: {
                        native: false,
                        external: [{
                            bindingId: 'binding-okta',
                            label: 'Okta',
                            owner: { kind: 'directory_source', directorySourceId: 'source-okta' },
                        }],
                    },
                })],
                nextCursor: null,
            },
        });
        harness.answer(serverId, GROUP_MEMBER_ADD_PATH, {
            body: { status: 'contribution_added', member: teamGroupMemberFixture() },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-member:account-ada');
        await openRowMenu(screen, 'account-ada');
        await screen.pressByTestIdAsync('add-to-group');

        // A directory-created Group still accepts native roster edits, so an
        // external-only row offers an add, never a read-only row.
        await vi.waitFor(() => {
            expect(harness.requestsFor(GROUP_MEMBER_ADD_PATH)).toHaveLength(1);
        });
        expect(harness.requestsFor(GROUP_MEMBER_REMOVE_PATH)).toHaveLength(0);
        expect(harness.requestsFor(GROUP_MEMBER_ADD_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            groupId: 'group-1',
            accountId: 'account-ada',
            historyAccess: 'from_membership',
        });
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
    });

    /**
     * KNOWN FAILING — a real defect in this screen, not in this case.
     *
     * The observed cursor sequence is `[null]`: pressing the candidate picker's
     * load-more issues no roster request at all, so a Team member who is not on
     * the first page cannot be added to a Group. That contradicts child 04 §11.5
     * and the screen's own comment below the picker.
     *
     * Already ruled out: `useTeamPagedList` is correct, including when its
     * `loadMore` is captured at render time and fired without being awaited —
     * exactly how this row calls it. See the matching case in
     * `hooks/teams/useTeamPagedList.test.ts`. The fault is therefore in this
     * screen's wiring of that callback, not in the paging owner.
     *
     * An earlier version of this case waited for the second page's row to
     * appear, which a plain re-read of the first page also satisfies; it
     * reported success while the bug was present. Assert the request, not the row.
     */
    it('reaches a Team member who is not on the roster page it first read', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES, memberCount: 0 }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, TEAM_MEMBERS_LIST_PATH, {
            body: {
                items: [teamMembershipFixture({
                    id: 'membership-first',
                    accountId: 'account-first',
                    account: accountDisplayProfileFixture('First'),
                })],
                nextCursor: 'cursor-2',
            },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-add-member');
        act(() => screen.pressByTestId('team-group-add-member'));
        await waitForTestId(screen, 'team-group-candidates-load-more');

        harness.answer(serverId, TEAM_MEMBERS_LIST_PATH, {
            body: {
                items: [teamMembershipFixture({
                    id: 'membership-later',
                    accountId: 'account-later',
                    account: accountDisplayProfileFixture('Later'),
                })],
                nextCursor: null,
            },
        });
        await screen.pressByTestIdAsync('team-group-candidates-load-more');

        // The paging request itself is the contract. Waiting for a row named
        // "Later" would also be satisfied by a plain re-read of the first page,
        // which is exactly the bug this case exists to catch.
        await vi.waitFor(() => {
            // Asserting the whole cursor sequence makes a failure self-describing:
            // it shows both how many roster pages were asked for and what each
            // one continued from.
            expect(harness.requestsFor(TEAM_MEMBERS_LIST_PATH)
                .map((call) => (call.input as { cursor?: string }).cursor ?? null))
                .toEqual([null, 'cursor-2']);
        });
        // A continuation appends, so the member from the first page is still
        // reachable alongside the one that needed the second.
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-group-candidate:account-later');
        expect(ids).toContain('team-group-candidate:account-first');
    });

    it('offers Group name and description only where the Home says metadata is editable', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({
                capabilities: { ...MANAGED_GROUP_CAPABILITIES, updateMetadata: false },
                management: {
                    kind: 'directory_created',
                    bindingId: 'binding-okta',
                    label: 'Okta',
                    owner: { kind: 'directory_source', directorySourceId: 'source-okta' },
                },
            }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [teamGroupMemberFixture()], nextCursor: null },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-member:account-ada');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        // Metadata authority is the Home's own decision; it is never inferred
        // from the roster capability that is still granted here.
        expect(ids).not.toContain('team-group-name');
        expect(ids).toContain('team-group-add-member');
    });

    it('keeps an archived Group read-only except for restoring it', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({
                capabilities: MANAGED_GROUP_CAPABILITIES,
                archivedAt: 1_700_000_000_000,
            }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [teamGroupMemberFixture()], nextCursor: null },
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-archived');

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('team-group-restore');
        expect(ids).not.toContain('team-group-archive');
        expect(ids).not.toContain('team-group-add-member');
    });

    it('does not call an archived Group empty "yet": its banner already says why no one is in it', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({
                capabilities: MANAGED_GROUP_CAPABILITIES,
                archivedAt: 1_700_000_000_000,
                memberCount: 0,
            }),
        });
        // An archived Group has no effective members; the Home answers an empty roster.
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-archived');
        await waitForTestId(screen, 'team-group-restore');
        await vi.waitFor(() => {
            expect(harness.requestsFor(GROUP_MEMBERS_LIST_PATH).length).toBeGreaterThan(0);
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-members-loading');
        });

        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('team-group-members-empty');
        expect(screen.getTextContent()).not.toContain('No members in this Group yet');
        // Its header says the kept members come back, not that it has none.
        expect(screen.getTextContent()).toContain('teams.groups.archivedMemberCount');
        expect(screen.getTextContent()).not.toContain('teams.groups.memberCount(count=0)');
    });

    it('withholds a second Group restore while its shared UI confirmation is unresolved', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, TEAM_GET_PATH, {
            body: teamSummaryFixture({
                capabilities: teamCapabilitiesFixture({ manageGroups: true }),
                archivedAt: 1_700_000_000_000,
            }),
        });
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({
                capabilities: MANAGED_GROUP_CAPABILITIES,
                archivedAt: 1_700_000_000_000,
            }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, {
            body: { items: [teamGroupMemberFixture()], nextCursor: null },
        });
        // A present user's saved Ask preference uses the shared local dialog,
        // not a durable approval Artifact (docs/actions.md, UI confirmation).
        await harness.requireUiApproval(serverId, 'teams.groups.restore');
        harness.answer(serverId, GROUP_RESTORE_PATH, {
            body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES }),
        });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-restore');
        // Restore is legitimate *because* the Group is archived, so it is offered
        // before anything is pending: what follows must be approval custody, not
        // the archived-parent rule withdrawing a valid feature.
        expect(screen.findByTestId('team-group-restore')?.props.disabled).not.toBe(true);

        const { Modal } = await import('@/modal');
        let confirmRestore!: (confirmed: boolean) => void;
        vi.mocked(Modal.confirm).mockClear().mockImplementationOnce(() => new Promise<boolean>((resolve) => {
            confirmRestore = resolve;
        }));
        act(() => screen.pressByTestId('team-group-restore'));
        await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledTimes(1));
        expect(harness.requestsFor(GROUP_RESTORE_PATH)).toHaveLength(0);
        expect(screen.findByTestId('team-group-restore')?.props.disabled).toBe(true);
        act(() => screen.pressByTestId('team-group-restore'));
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        await act(async () => confirmRestore(true));
        await vi.waitFor(() => expect(harness.requestsFor(GROUP_RESTORE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(ARTIFACT_CREATE_PATH)).toHaveLength(0);
    });
});

describe('TeamGroupDetailScreen defaults for members', () => {
    const TEAM_POLICY_PATH = '/v1/teams/policy/set';

    async function claudeTargetKey(): Promise<string> {
        const { getResolvedAgentCatalogEntries } = await import('@/agents/backendCatalog/agentCatalogProjection');
        return getResolvedAgentCatalogEntries({ enabledAgentIds: ['claude'] })
            .find((entry) => entry.agentId === 'claude')!.backendTargetKey!;
    }

    it('saves this Group\'s member defaults as its own patch, leaving the Team and other Groups alone', async () => {
        const key = await claudeTargetKey();
        const serverId = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada', teamsEnabled: true,
        });
        await harness.selectHomes([serverId]);
        const team = teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageGroups: true }),
            policy: teamPolicyFixture({ managedDefaults: {
                team: { permissionModeByAgentTargetKey: { [key]: 'default' } },
                groups: { 'group-2': { permissionModeByAgentTargetKey: { [key]: 'yolo' } } },
            } }),
        });
        harness.answer(serverId, TEAM_GET_PATH, { body: team });
        harness.answer(serverId, GROUP_GET_PATH, { body: teamGroupFixture({ capabilities: MANAGED_GROUP_CAPABILITIES }) });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, TEAM_POLICY_PATH, { body: team });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-member-defaults-agent:claude:header');
        await screen.pressByTestIdAsync('team-group-member-defaults-agent:claude:header');
        await waitForTestId(screen, 'team-group-member-defaults-agent:claude:permission');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const menu = screen.findAllByType(DropdownMenu).find((node) =>
            node.props.itemTrigger?.itemProps?.testID === 'team-group-member-defaults-agent:claude:permission');
        await act(async () => menu?.props.onSelect('read-only'));

        await vi.waitFor(() => expect(harness.requestsFor(TEAM_POLICY_PATH)).toHaveLength(1));
        expect(harness.requestsFor(TEAM_POLICY_PATH)[0]?.input).toEqual({
            v: 1,
            teamId: 'team-1',
            managedGroupDefaults: { teamGroupId: 'group-1', defaults: { permissionModeByAgentTargetKey: { [key]: 'read-only' } } },
        });
    });

    it('shows a Group\'s defaults read-only, with the reason, to someone who cannot manage that Group', async () => {
        const serverId = await addManagedHome();
        harness.answer(serverId, GROUP_GET_PATH, {
            body: teamGroupFixture({ capabilities: { ...MANAGED_GROUP_CAPABILITIES, manageNativeMembers: false } }),
        });
        harness.answer(serverId, GROUP_MEMBERS_LIST_PATH, { body: { items: [], nextCursor: null } });

        const screen = await renderGroupDetail(serverId);
        await waitForTestId(screen, 'team-group-member-defaults-machine');
        expect(screen.getTextContent()).toContain('teams.settings.memberDefaults.readOnlyGroup');
        const { MachineSelector } = await import('@/components/sessions/new/components/MachineSelector');
        expect(screen.findAllByType(MachineSelector)).toHaveLength(0);
    });
});
