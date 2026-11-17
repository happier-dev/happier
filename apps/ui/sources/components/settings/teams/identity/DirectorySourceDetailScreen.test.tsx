import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamDirectoryGroupV1Schema, TeamDirectoryGroupPageV1Schema, TeamDirectoryPeoplePageV1Schema, TeamGroupsPageV1Schema, type TeamGroupV1, TeamDirectorySourceRemovalPreflightV1Schema, TeamDirectorySourceRemoveResultV1Schema, TeamExternalGroupBindingV1Schema, type TeamDirectoryGroupV1 } from '@happier-dev/protocol/teams';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { collectRenderedTestIds, createDeferred, renderScreen, standardCleanup, teamCapabilitiesFixture, teamSummaryFixture, teamDirectorySourceFixture, teamGroupFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const routerBack = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const announce = vi.hoisted(() => vi.fn());
const openedUrl = vi.hoisted(() => vi.fn(async () => true));
const focusedItems = vi.hoisted(() => [] as string[]);
const scrollToIndex = vi.hoisted(() => vi.fn());
const virtualWindow = vi.hoisted(() => ({ enabled: false }));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { back: routerBack }, params: () => routeParams.current }).module);
vi.mock('react-native', async () => {
    const { createReactNativeWebMock, createFocusablePressableMock } = await import('@/dev/testkit/mocks/reactNative');
    const native = await createReactNativeWebMock();
    return { ...native, Platform: { ...native.Platform, get OS() { return platform.OS; } },
        AccessibilityInfo: { ...native.AccessibilityInfo, announceForAccessibility: announce },
        Pressable: createFocusablePressableMock(() => {}, props => { if (typeof props.testID === 'string') focusedItems.push(props.testID); }) };
});
// Legend is the native layout/recycling boundary; the app's list adapter and reveal owner stay real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const original = await importOriginal<typeof import('@legendapp/list/react-native')>();
    const ReactModule = await import('react');
    const { state: { refHandle } } = (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock();
    return { ...original, LegendList: ReactModule.forwardRef((props: Readonly<{ data: readonly { key: string; element: React.ReactElement }[]; renderItem: (info: { item: { key: string; element: React.ReactElement }; index: number }) => React.ReactNode; ListHeaderComponent?: React.ReactNode; ListFooterComponent?: React.ReactNode }>, ref) => {
        const [visibleKey, setVisibleKey] = ReactModule.useState<string | null>(null);
        const data = ReactModule.useRef(props.data);
        data.current = props.data;
        ReactModule.useImperativeHandle(ref, () => ({ ...refHandle, scrollToIndex: async (params: { index: number }) => { scrollToIndex(params); if (virtualWindow.enabled) setVisibleKey(data.current[params.index]?.key ?? null); } }), []);
        return ReactModule.createElement('LegendList', props, props.ListHeaderComponent, ...props.data.flatMap((item, index) => virtualWindow.enabled && item.key !== (visibleKey ?? props.data[0]?.key) ? [] : [ReactModule.createElement(ReactModule.Fragment, { key: item.key }, props.renderItem({ item, index }))]), props.ListFooterComponent);
    }) };
});
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openedUrl }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { DirectorySourceDetailScreen } = await import('./DirectorySourceDetailScreen');
const { DIRECTORY_SOURCE_SETTINGS } = await import('./directorySettings');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { reactNativeWebAppState } = await import('@/dev/testkit/mocks/reactNative');
const { Modal } = await import('@/modal');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { installBrowserRuntimeForTests } = await import('@/dev/testkit/harness/browserRuntimeHarness');
let serverId: string;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | null = null;
function requestsAt(path: string) {
    return harness.requests.filter(request => new URL(request.path, request.serverUrl).pathname === path);
}
const sourcePath = '/v1/teams/team-1/directory-sources/source-1';
const groupsPath = `${sourcePath}/groups`;
const nativeGroupsPath = '/v1/teams/groups/list';
const bindingPath = '/v1/teams/team-1/external-group-bindings';
const portalPath = '/v1/teams/identity/workos/admin-portal-link/create';
const impact = { teamMembershipsRemoved: 0, groupMembershipsRemoved: 0, groupContributionsRemoved: 0, directoryCreatedGroupsRetained: 0, nativeMembershipsPreserved: 0, nativeGroupContributionsPreserved: 0 };
function directoryGroup(id = 'external-group-1', mapping: TeamDirectoryGroupV1['mapping'] = { state: 'unbound' }): TeamDirectoryGroupV1 {
    return TeamDirectoryGroupV1Schema.parse({ v: 1, id, sourceId: 'source-1', externalGroupId: `external-${id}`, displayName: 'Engineering', state: 'active', memberCount: 4, boundAccountCount: 4, unboundPeopleCount: 0, mapping, lastCompleteObservationAt: null, sourceLabel: 'Example directory' });
}
function answerGroups(items = [directoryGroup()]) { harness.answer(serverId, groupsPath, { body: TeamDirectoryGroupPageV1Schema.parse({ items, nextCursor: null }) }); }
function answerNativeGroups(items: TeamGroupV1[] = []) { harness.answer(serverId, nativeGroupsPath, { body: TeamGroupsPageV1Schema.parse({ items, nextCursor: null }) }); }
function answerTeam(capabilities = { manageAuthentication: true, manageGroups: true }, archivedAt: number | null = null) {
    harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ archivedAt, capabilities: teamCapabilitiesFixture(capabilities) }) });
}
async function renderDetail(readyId = 'team-directory-source-status') {
    const screen = await renderScreen(<DirectorySourceDetailScreen serverId={serverId} teamId="team-1" sourceId="source-1" />);
    await waitForHomeGovernance(() => expect(screen.findByTestId(readyId), screen.getTextContent()).not.toBeNull());
    return screen;
}
async function wakeTeams() { await act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1])); }
function textOf(screen: Awaited<ReturnType<typeof renderDetail>>, id: string) {
    const node = screen.findHostByTestId(id);
    const text = (value: import('react-test-renderer').ReactTestInstance | string): string => typeof value === 'string' ? value : value.children.map(text).join('');
    return node ? text(node) : '';
}
beforeEach(async () => {
    standardCleanup();
    platform.OS = 'ios';
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    serverId = await harness.addHome({ name: 'Identity Home', serverUrl: 'https://identity-home.example', accountId: 'account-1', teamsEnabled: true });
    await harness.selectHomes([serverId]);
    answerTeam();
    harness.answer(serverId, sourcePath, { body: teamDirectorySourceFixture({ allowedActions: ['teams.directory.sources.sync', 'teams.directory.sources.pause', 'teams.directory.sources.remove'] }) });
    harness.answer(serverId, `${sourcePath}/people`, { body: TeamDirectoryPeoplePageV1Schema.parse({ items: [], nextCursor: null }) });
    answerGroups();
    answerNativeGroups([]);
    harness.answer(serverId, `${sourcePath}/sync`, { body: { v: 1, status: 'requested', source: teamDirectorySourceFixture() } });
    harness.answer(serverId, `${sourcePath}/removal-impact`, { body: TeamDirectorySourceRemovalPreflightV1Schema.parse({ v: 1, status: 'allowed', sourceId: 'source-1', sourceLabel: 'Example directory', impact }) });
    harness.answer(serverId, `DELETE ${sourcePath}`, { body: TeamDirectorySourceRemoveResultV1Schema.parse({ v: 1, status: 'removed', impact }) });
    harness.answer(serverId, portalPath, { body: { url: 'https://setup.example.test/dsync' } });
    routeParams.current = {};
    virtualWindow.enabled = false;
    focusedItems.length = 0;
    scrollToIndex.mockClear();
    announce.mockClear();
    routerBack.mockReset();
    openedUrl.mockReset().mockResolvedValue(true);
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
});
afterEach(async () => {
    standardCleanup();
    if (browser) {
        await harness.reset();
        browser.restore();
        browser = null;
    }
});

describe('DirectorySourceDetailScreen through real Home governance', () => {
    it.each([
        ['remove', 'team-directory-source-remove'],
        ['searchGroups', 'directory-groups-search'],
    ] as const)('reveals the virtual %s search anchor after the source read settles', async (setting, controlId) => {
        const anchor = DIRECTORY_SOURCE_SETTINGS.settings[setting].anchor;
        routeParams.current = { setting: anchor };
        virtualWindow.enabled = true;
        const held = createDeferred<void>();
        harness.answer(serverId, sourcePath, { body: teamDirectorySourceFixture({ allowedActions: ['teams.directory.sources.remove'] }), respondAfter: held.promise });
        answerGroups(Array.from({ length: 30 }, (_, index) => directoryGroup(`external-group-${index}`)));
        const screen = await renderDetail('team-directory-source-loading');
        expect(screen.findByTestId(controlId)).toBeNull();
        expect(scrollToIndex).not.toHaveBeenCalled();
        await act(async () => held.resolve());
        await waitForHomeGovernance(() => expect(screen.findByTestId(controlId)).not.toBeNull());
        expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ animated: false }));
        expect(screen.findByTestId(`setting-reveal.${anchor}`)).not.toBeNull();
        scrollToIndex.mockClear();
        answerGroups([directoryGroup('new-group')]);
        await wakeTeams();
        await waitForHomeGovernance(() => expect(requestsAt(groupsPath).length).toBeGreaterThan(1));
        expect(scrollToIndex).not.toHaveBeenCalled();
    });
    it('explains a denied Group search without loading or exposing Groups', async () => {
        routeParams.current = { setting: DIRECTORY_SOURCE_SETTINGS.settings.searchGroups.anchor };
        answerTeam({ manageAuthentication: true, manageGroups: false });
        const screen = await renderDetail();
        expect(screen.findByTestId('directory-groups-forbidden')).not.toBeNull();
        await waitForHomeGovernance(() => expect(screen.findByTestId(`setting-reveal.${DIRECTORY_SOURCE_SETTINGS.sectionRefs.groups.id}`)).not.toBeNull());
        expect(screen.findByTestId('directory-groups-search')).toBeNull();
        expect(requestsAt(groupsPath)).toHaveLength(0);
        expect(requestsAt(nativeGroupsPath)).toHaveLength(0);
    });
    it('uses directory-projected mapping names and respects a withheld target name', async () => {
        const name = teamGroupFixture({ name: 'Platform Engineering' }).name;
        answerGroups([directoryGroup('external-group-1', { state: 'bound', mode: 'native_target', bindingId: 'binding-1', teamGroupId: 'opaque-group', teamGroupName: name })]);
        const screen = await renderDetail();
        await waitForHomeGovernance(() => expect(textOf(screen, 'directory-group:external-group-1')).toContain('identityAdministration.mappedTo: Platform Engineering'));
        answerGroups([directoryGroup('external-group-1', { state: 'bound', mode: 'native_target', bindingId: 'binding-1', teamGroupId: 'opaque-group', teamGroupName: null })]);
        answerNativeGroups([teamGroupFixture({ id: 'opaque-group', name: 'Retained hidden name' })]);
        await wakeTeams();
        await waitForHomeGovernance(() => expect(textOf(screen, 'directory-group:external-group-1')).toContain('identityAdministration.mappedTo: identityAdministration.mappedGroupNotVisible'));
        expect(textOf(screen, 'directory-group:external-group-1')).not.toContain('Retained hidden name');
    });
    it('opens a full directory page of mapping labels without point-reading every Group', async () => {
        answerGroups(Array.from({ length: 50 }, (_, index) => directoryGroup(`external-group-${index}`, { state: 'bound', mode: 'native_target', bindingId: `binding-${index}`, teamGroupId: `group-${index}`, teamGroupName: teamGroupFixture({ name: `Team Group ${index}` }).name })));
        const screen = await renderDetail();
        await waitForHomeGovernance(() => expect(textOf(screen, 'directory-group:external-group-49')).toContain('identityAdministration.mappedTo: Team Group 49'));
        expect(requestsAt('/v1/teams/groups/get')).toHaveLength(0);
    });
    it('disables source and mapping writes for an archived Team', async () => {
        answerTeam({ manageAuthentication: true, manageGroups: true }, 1);
        const screen = await renderDetail();
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group:external-group-1')).not.toBeNull());
        for (const id of ['team-directory-source-sync', 'team-directory-source-remove', 'directory-group:external-group-1']) expect(screen.findByTestId(id)?.props.disabled).toBe(true);
    });
    it.each(['source', 'groups'])('blocks mapping writes during the authoritative %s refresh', async reader => {
        const screen = await renderDetail();
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group:external-group-1')).not.toBeNull());
        const held = createDeferred<void>();
        harness.answer(serverId, reader === 'source' ? sourcePath : groupsPath, { body: reader === 'source' ? teamDirectorySourceFixture({ allowedActions: ['teams.directory.sources.sync', 'teams.directory.sources.remove'] }) : TeamDirectoryGroupPageV1Schema.parse({ items: [directoryGroup()], nextCursor: null }), respondAfter: held.promise });
        await wakeTeams();
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group:external-group-1')?.props.disabled).toBe(true));
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-source-sync')?.props.disabled).toBe(reader === 'source'));
        await act(async () => held.resolve());
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group:external-group-1')?.props.disabled).toBe(false));
    });
    it('keeps its Team notice through a delayed source read and a paused result', async () => {
        answerTeam({ manageAuthentication: true, manageGroups: true }, 1);
        const held = createDeferred<void>();
        const source = teamDirectorySourceFixture({ state: 'paused', allowedActions: ['teams.directory.sources.resume'] });
        harness.answer(serverId, sourcePath, { body: source, respondAfter: held.promise });
        const screen = await renderDetail('team-directory-source-loading');
        expect(screen.findByTestId('team-archived')).not.toBeNull();
        await act(async () => held.resolve());
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-source-status')).not.toBeNull());
        expect(screen.getTextContent()).toContain('teams.authentication.directory.state.paused');
        expect(screen.findByTestId('team-archived')).not.toBeNull();
    });
    it('keeps Team notices when the source read fails', async () => {
        answerTeam({ manageAuthentication: true, manageGroups: true }, 1);
        harness.answer(serverId, sourcePath, { status: 503, body: { error: 'home_unreachable' } });
        const screen = await renderDetail('team-directory-source-unavailable');
        expect(screen.findByTestId('team-archived')).not.toBeNull();
    });
    it('keeps Team notices when authentication administration is forbidden', async () => {
        routeParams.current = { setting: DIRECTORY_SOURCE_SETTINGS.settings.searchGroups.anchor };
        answerTeam({ manageAuthentication: false, manageGroups: false }, 1);
        const screen = await renderDetail('team-directory-source-forbidden');
        await waitForHomeGovernance(() => expect(screen.findByTestId(`setting-reveal.${DIRECTORY_SOURCE_SETTINGS.sectionRefs.actions.id}`)).not.toBeNull());
        expect(screen.findByTestId('team-archived')).not.toBeNull();
        expect(requestsAt(sourcePath)).toHaveLength(0);
    });
    it('keeps source administration available to an authentication-only manager without reading Groups', async () => {
        answerTeam({ manageAuthentication: true, manageGroups: false });
        const screen = await renderDetail();
        expect(screen.findByTestId('directory-groups-search')).toBeNull();
        expect(requestsAt(groupsPath)).toHaveLength(0);
        expect(requestsAt(nativeGroupsPath)).toHaveLength(0);
        for (const id of ['team-directory-source-sync', 'team-directory-source-pause', 'team-directory-source-remove']) {
            expect(screen.findByTestId(id)?.props.disabled).toBe(false);
        }
        await screen.pressByTestIdAsync('team-directory-source-sync');
        await waitForHomeGovernance(() => expect(requestsAt(`${sourcePath}/sync`)).toHaveLength(1));
    });
    it('does not substitute Group administration for authentication authority', async () => {
        answerTeam({ manageAuthentication: false, manageGroups: true });
        const screen = await renderDetail('team-directory-source-forbidden');
        expect(screen.findByTestId('directory-groups-search')).toBeNull();
        expect(requestsAt(groupsPath)).toHaveLength(0);
    });
    it('presents and announces the canonical typed source and sync failures', async () => {
        harness.answer(serverId, sourcePath, { body: teamDirectorySourceFixture({ state: 'needs_attention', allowedActions: ['teams.directory.sources.sync'], error: { code: 'directory_source_permission_lost', retryable: false } }) });
        harness.answer(serverId, `${sourcePath}/sync`, { status: 429, body: { error: 'directory_sync_rate_limited' } });
        const screen = await renderDetail();
        expect(textOf(screen, 'team-directory-source-error')).toContain('identityAdministration.errorNeedsAttention');
        await screen.pressByTestIdAsync('team-directory-source-sync');
        await waitForHomeGovernance(() => expect(textOf(screen, 'team-directory-source-action-error')).toBe('identityAdministration.errorRateLimited'));
        expect(announce).toHaveBeenCalledWith('identityAdministration.errorRateLimited');
        harness.answer(serverId, `${sourcePath}/sync`, { status: 409, body: { error: 'directory_sync_needs_attention' } });
        await screen.pressByTestIdAsync('team-directory-source-sync');
        await waitForHomeGovernance(() => expect(textOf(screen, 'team-directory-source-action-error')).toBe('identityAdministration.errorSyncPaused'));
    });
    it('uses Sync as Retry and restores its ordinary label after recovery', async () => {
        harness.answer(serverId, sourcePath, { body: teamDirectorySourceFixture({ state: 'needs_attention', allowedActions: ['teams.directory.sources.sync'], error: { code: 'directory_source_permission_lost', retryable: false } }) });
        const screen = await renderDetail();
        expect(textOf(screen, 'team-directory-source-sync')).toBe('common.retry');
        harness.answer(serverId, sourcePath, { body: teamDirectorySourceFixture({ allowedActions: ['teams.directory.sources.sync'] }) });
        await screen.pressByTestIdAsync('team-directory-source-sync');
        await waitForHomeGovernance(() => expect(textOf(screen, 'team-directory-source-sync')).toBe('teams.authentication.directory.actions.sync'));
    });
    it('refreshes mounted Groups from the exact Home Team change', async () => {
        const screen = await renderDetail();
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group:external-group-1')).not.toBeNull());
        answerGroups([directoryGroup('new-group')]);
        await act(async () => { publishHomeAccountChange('another-home', [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); publishHomeAccountChange(serverId, ['home-governance']); });
        expect(screen.findByTestId('directory-group:new-group')).toBeNull();
        await wakeTeams();
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group:new-group')).not.toBeNull());
    });
    it.each([false, true])('opens source-bound WorkOS recovery and refreshes on native return (Ask=%s)', async ask => {
        harness.answer(serverId, sourcePath, { body: teamDirectorySourceFixture({ workosAdminPortalConnectionId: 'connection-1', state: 'needs_attention' }) });
        if (ask) await harness.requireUiApproval(serverId, 'teams.identity.workos.adminPortalLink.create');
        const screen = await renderDetail();
        await screen.pressByTestIdAsync('team-directory-source-open-workos');
        await waitForHomeGovernance(() => expect(openedUrl).toHaveBeenCalledWith('https://setup.example.test/dsync'));
        expect(requestsAt(portalPath)[0]?.input).toEqual({ v: 1, teamId: 'team-1', connectionId: 'connection-1', directorySourceId: 'source-1', intent: 'dsync' });
        const before = requestsAt(sourcePath).length;
        await act(async () => reactNativeWebAppState.emit('active'));
        await waitForHomeGovernance(() => expect(requestsAt(sourcePath).length).toBeGreaterThan(before));
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });
    it('removes a source once after real preflight and native Ask', async () => {
        await harness.requireUiApproval(serverId, 'teams.directory.sources.remove');
        const screen = await renderDetail();
        await screen.pressByTestIdAsync('team-directory-source-remove');
        await waitForHomeGovernance(() => expect(routerBack).toHaveBeenCalledOnce());
        expect(requestsAt(`${sourcePath}/removal-impact`)).toHaveLength(1);
        expect(requestsAt(sourcePath).filter(request => request.method === 'DELETE')).toHaveLength(1);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });
    it.each([true, false])('settles mapping through native Ask and leaves it recoverable (accepted=%s)', async accepted => {
        await harness.requireUiApproval(serverId, 'teams.externalGroupBindings.set');
        vi.mocked(Modal.confirm).mockResolvedValue(accepted);
        harness.answer(serverId, `PUT ${bindingPath}`, { body: TeamExternalGroupBindingV1Schema.parse({ v: 1, id: 'binding-1', teamId: 'team-1', owner: { kind: 'directory_source', directorySourceId: 'source-1' }, externalGroupId: 'external-external-group-1', mode: 'directory_created', target: { teamGroupId: 'team-group-1', name: teamGroupFixture().name, archivedAt: null } }) });
        const screen = await renderDetail();
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group:external-group-1')).not.toBeNull());
        await screen.pressByTestIdAsync('directory-group:external-group-1');
        await screen.pressByTestIdAsync('directory-group-map-create');
        await waitForHomeGovernance(() => expect(Modal.confirm).toHaveBeenCalled());
        if (accepted) {
            await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group-map-create')).toBeNull());
            expect(requestsAt(groupsPath).length).toBeGreaterThan(1);
        } else {
            await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group-mapping-failure')).not.toBeNull());
            expect(requestsAt(bindingPath)).toHaveLength(0);
            expect(screen.findByTestId('directory-group:external-group-1')?.props.disabled).toBe(false);
        }
    });
    it('opens the chooser beside its Group and returns focus on Escape', async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://identity-ui.example' });
        platform.OS = 'web';
        await harness.switchAccount(serverId, 'account-1');
        answerGroups(Array.from({ length: 30 }, (_, index) => directoryGroup(`external-group-${index}`)));
        answerNativeGroups([teamGroupFixture({ name: 'Platform Engineering' })]);
        const screen = await renderDetail('directory-group:external-group-0');
        await screen.pressByTestIdAsync('directory-group:external-group-0');
        const order = collectRenderedTestIds(screen.tree.toJSON());
        expect(order.indexOf('directory-group:external-group-0')).toBeLessThan(order.indexOf('directory-group-map-create'));
        expect(order.indexOf('directory-group-map-create')).toBeLessThan(order.indexOf('directory-group:external-group-1'));
        expect(screen.findByTestId('directory-group:external-group-0')?.props.accessibilityState?.expanded).toBe(true);
        expect(focusedItems).toContain('directory-group-map-create');
        expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: expect.any(Number), animated: false }));
        await act(async () => screen.findByTestId('directory-group-map-create')?.props.onKeyDown({ key: 'Escape' }));
        expect(screen.findByTestId('directory-group-map-create')).toBeNull();
        expect(focusedItems.at(-1)).toBe('directory-group:external-group-0');
    });
    it('shows existing Groups directly and closes the chooser with Cancel', async () => {
        answerNativeGroups([teamGroupFixture({ id: 'team-group-1', name: 'Platform Engineering' })]);
        const screen = await renderDetail();
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group:external-group-1')).not.toBeNull());
        await screen.pressByTestIdAsync('directory-group:external-group-1');
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group-native-target:team-group-1')).not.toBeNull());
        expect(screen.findByTestId('directory-group-map-existing')).toBeNull();
        await screen.pressByTestIdAsync('directory-group-chooser-cancel');
        expect(screen.findByTestId('directory-group-chooser-cancel')).toBeNull();
    });
    it('retains unavailable native Groups as disabled targets and retries their reader', async () => {
        answerNativeGroups([teamGroupFixture({ id: 'retained-group', name: 'Retained Group' })]);
        const screen = await renderDetail();
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group:external-group-1')).not.toBeNull());
        await screen.pressByTestIdAsync('directory-group:external-group-1');
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-group-native-target:retained-group')).not.toBeNull());
        await screen.pressByTestIdAsync('directory-group-chooser-cancel');
        harness.answer(serverId, nativeGroupsPath, { status: 503, body: { error: 'home_unreachable' } });
        await wakeTeams();
        await screen.pressByTestIdAsync('directory-group:external-group-1');
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-native-groups-error')).not.toBeNull());
        expect(screen.findByTestId('directory-native-groups-empty')).toBeNull();
        expect(screen.findByTestId('directory-group-native-target:retained-group')?.props.disabled).toBe(true);
        answerNativeGroups([teamGroupFixture({ id: 'retained-group' })]);
        await screen.pressByTestIdAsync('directory-native-groups-retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-native-groups-error')).toBeNull());
        const recoveredTarget = screen.findByTestId('directory-group-native-target:retained-group');
        expect(recoveredTarget).not.toBeNull();
        expect(recoveredTarget?.props.disabled).not.toBe(true);
    });
});
