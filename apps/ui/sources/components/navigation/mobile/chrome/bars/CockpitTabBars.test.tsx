import * as React from 'react';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { MetadataSchema } from '@happier-dev/session-core/state';

import { renderScreen as renderRealScreen } from '@/dev/testkit/render/renderScreen';
import { createMachineFixture, createSessionFixture, standardCleanup } from '@/dev/testkit';
import type { ScmStatus } from '@/sync/domains/state/storageTypes';
import { getUiListsModalMockRef, installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import type { NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A pin is written through the declared Settings Action; its admission (writer) is the boundary.
const settingWrites = vi.hoisted(() => ({ calls: [] as Array<{ address: unknown; value: unknown }> }));
vi.mock('@/components/settings/catalog/useSettingActionWriter', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/settings/catalog/useSettingActionWriter')>(),
    useSettingActionWriter: () => async (address: unknown, value: unknown) => {
        settingWrites.calls.push({ address, value });
        return { ok: true, result: {} };
    },
}));

let translationPrefix = 'en';
let fixtureSessionServerId: string | undefined;
const sessionMetadataState = vi.hoisted(() => ({
    metadata: { flavor: 'codex' } as Record<string, unknown> | null,
    metadataLayoutVersion: 0,
    ownerMetadataView: undefined as Record<string, unknown> | null | undefined,
    accessLevel: null as 'view' | 'edit' | 'admin' | null,
}));
const collaborationAdmissionState = vi.hoisted(() => ({ state: 'unavailable' as 'loading' | 'available' | 'unavailable' }));
const scmState = vi.hoisted(() => ({
    status: null as Pick<ScmStatus, 'isDirty' | 'changedFileCount' | 'linesAdded' | 'linesRemoved'> | null,
}));
const badgeSettingsState = vi.hoisted(() => ({
    gitBadgeMode: 'changedFiles' as 'changedFiles' | 'diffLines' | 'off',
    openTabs: true,
}));
const cockpitPinsState = vi.hoisted(() => ({
    value: null as string[] | null,
}));
// The canonical stored shape the fixture seeds into local settings.
const surfacePlacementsState: { value: NonNullable<LocalSettings['navigationSurfacePlacementsV1']> } = vi.hoisted(() => ({ value: {} }));
// The bar's width decides what fits; 800 is wide enough for everything, 390 is an iPhone.
const windowState = vi.hoisted(() => ({ width: 800 }));
const swipeSettingsState = vi.hoisted(() => ({ always: false, swipe: true }));
const reachableMachineState = vi.hoisted(() => ({
    target: null as { machineId: string; basePath: string } | null,
}));
installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Animated: {
                Value: class {
                    _value: number;
                    constructor(value: number) {
                        this._value = value;
                    }
                    setValue(value: number) {
                        this._value = value;
                    }
                    interpolate(config: Record<string, unknown>) {
                        return { __type: 'interpolate', value: this._value, config };
                    }
                },
                timing: vi.fn(() => ({
                    start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }),
                })),
                View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
            },
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            useWindowDimensions: () => ({ width: windowState.width, height: 844, scale: 3, fontScale: 1 }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => `${translationPrefix}:${key}`,
            translateLoose: (key: string) => `${translationPrefix}:${key}`,
            getPreferredLanguage: () => translationPrefix,
        });
    },
});

function readSessionRoute(node: React.ReactNode): { sessionId: string; serverId?: string } | null {
    if (!React.isValidElement<Record<string, unknown>>(node)) return null;
    if (typeof node.props.sessionId === 'string') return {
        sessionId: node.props.sessionId,
        ...(typeof node.props.serverId === 'string' ? { serverId: node.props.serverId } : {}),
    };
    for (const child of React.Children.toArray(node.props.children as React.ReactNode)) {
        const route = readSessionRoute(child);
        if (route) return route;
    }
    return null;
}

async function seedCockpitState(element: React.ReactNode) {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const route = readSessionRoute(element);
    storage.setState({ settings: { ...storage.getState().settings,
        tabBarGitBadgeMode: badgeSettingsState.gitBadgeMode, tabBarOpenTabsBadgeEnabled: badgeSettingsState.openTabs,
        tabBarShowLabels: true, tabBarSize: 'regular',
        sessionCockpitSwipeAlwaysSessionsEnabled: swipeSettingsState.always,
        sessionCockpitSwipeNavigationEnabled: swipeSettingsState.swipe,
    }, isDataReady: true });
    storage.setState({ localSettings: { ...storage.getState().localSettings,
        navigationSurfacePlacementsV1: { ...(cockpitPinsState.value === null ? {} : { sessionTabBar: {
            orderedIds: cockpitPinsState.value, placements: Object.fromEntries([...new Set(['browse', 'git', 'companion', 'terminal', ...cockpitPinsState.value])]
                .map(id => [id, cockpitPinsState.value!.includes(id) ? 'pinned' as const : 'overflow' as const])) }, }), ...surfacePlacementsState.value } } });
    if (route) {
        // These are producer fixture payloads; the presentation owner and store readers remain real.
        const target = reachableMachineState.target ?? { machineId: 'machine-1', basePath: '/repo' };
        const serverId = fixtureSessionServerId ?? route.serverId;
        const metadata = sessionMetadataState.metadataLayoutVersion === 1
            ? parseDecryptedSessionMetadata(sessionMetadataState.metadata, 1)
            : sessionMetadataState.metadata === null ? null : MetadataSchema.parse({
            ...createSessionFixture().metadata,
            machineId: target.machineId, path: target.basePath,
            ...sessionMetadataState.metadata,
        });
        const ownerMetadataView = sessionMetadataState.ownerMetadataView === null ? null
            : sessionMetadataState.metadataLayoutVersion === 1 || sessionMetadataState.ownerMetadataView !== undefined
                ? MetadataSchema.parse({
                    ...createSessionFixture().metadata, machineId: target.machineId, path: target.basePath,
                    ...sessionMetadataState.ownerMetadataView,
                })
                : undefined;
        const session = createSessionFixture({ id: route.sessionId, serverId,
            metadata, metadataLayoutVersion: sessionMetadataState.metadataLayoutVersion, ownerMetadataView,
            ...(sessionMetadataState.accessLevel ? { accessLevel: sessionMetadataState.accessLevel } : {}),
        });
        const machine = createMachineFixture({ id: target.machineId, active: true, activeAt: Date.now() });
        storage.setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine },
            machineListByServerId: serverId ? { [serverId]: [machine] } : {},
        });
        const status = scmState.status ? { branch: 'main', includedCount: 0, lastUpdatedAt: 1,
            includedLinesAdded: 0, includedLinesRemoved: 0,
            pendingLinesAdded: scmState.status.linesAdded, pendingLinesRemoved: scmState.status.linesRemoved,
            linesChanged: scmState.status.linesAdded + scmState.status.linesRemoved, ...scmState.status } : null;
        storage.getState().updateSessionProjectScmStatus(route.sessionId, status, serverId);
    }
}

async function renderScreen(element: React.ReactElement) {
    await seedCockpitState(element);
    const screen = await renderRealScreen(element);
    return { ...screen, update: async (next: React.ReactElement) => {
        await act(async () => { await seedCockpitState(next); });
        return screen.update(next);
    } };
}

async function projectPages() {
    const { resolveProjectPageCatalog } = await import('@/components/projects/detail/projectPageCatalog');
    return resolveProjectPageCatalog({ target: { kind: 'project', workspaceRefId: 'workspace-a', serverId: 'home' } });
}

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, any>) => React.createElement(
        'DropdownMenu',
        props,
        typeof props.trigger === 'function'
            ? props.trigger({ open: props.open, toggle: () => props.onOpenChange(!props.open) })
            : props.trigger,
        ...(props.items ?? []).map((item: Record<string, any>) => item.rightElement),
    ),
}));

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon', () => ({
    SessionAgentCatalogIdentityIcon: (props: Record<string, unknown>) =>
        React.createElement('SessionAgentCatalogIdentityIcon', props),
}));

vi.mock('@/hooks/session/useSessionCollaborationAvailability', () => ({
    useSessionCollaborationDestinationAvailabilityState: () => collaborationAdmissionState.state,
    useSessionCollaborationDestinationEntryAdmitted: () => collaborationAdmissionState.state === 'available',
}));

vi.mock('@/components/sessions/board/useSessionBoardFeatureEnabled', () => ({
    useSessionBoardFeatureEnabled: () => false,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: (target: { serverId?: string | null }) => target.serverId ?? null,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
    useLayoutMaxWidth: () => 960,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 960 }),
}));

// Prepare the module after the canonical boundary options are installed. Module transformation
// belongs to suite setup, so a saturated host does not count it against a behavior assertion.
const { SessionCockpitTabBar: SessionBarSubject, SessionPhonePageStrip } = await import('./SessionCockpitTabBar');
const { resolveSessionCockpitMobileCatalog } = await import('@/components/workspaceCockpit/session/sessionCockpitMobileCatalog');
function MountedSessionCockpitTabBar(props: Omit<React.ComponentProps<typeof SessionBarSubject>, 'catalog'>) {
    const catalog = React.useMemo(() => resolveSessionCockpitMobileCatalog({
        terminalTabAvailable: props.terminalTabAvailable, pluginPlacements: props.pluginPlacements,
        sessionSharingAvailable: collaborationAdmissionState.state === 'available',
        // The Browser feature decision is the catalog's producer input (`useAppRightSidebarTabInputs`); admitted here.
        browserFeatureEnabled: true,
    }), [props.terminalTabAvailable, props.pluginPlacements, collaborationAdmissionState.state]);
    return <SessionBarSubject {...props} catalog={catalog} />;
}
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

describe('cockpit tab bars', () => {
    let initialStorageState: ReturnType<typeof import('@/sync/domains/state/storageStore').storage.getState>;
    beforeEach(async () => { initialStorageState = (await import('@/sync/domains/state/storageStore')).storage.getState(); });
    afterEach(async () => {
        standardCleanup();
        (await import('@/sync/domains/state/storageStore')).storage.setState(initialStorageState, true);
        translationPrefix = 'en';
        sessionMetadataState.metadata = { flavor: 'codex' };
        sessionMetadataState.metadataLayoutVersion = 0;
        sessionMetadataState.ownerMetadataView = undefined;
        sessionMetadataState.accessLevel = null;
        scmState.status = null;
        badgeSettingsState.gitBadgeMode = 'changedFiles';
        badgeSettingsState.openTabs = true;
        cockpitPinsState.value = null;
        surfacePlacementsState.value = {};
        windowState.width = 800;
        swipeSettingsState.always = false;
        swipeSettingsState.swipe = true;
        reachableMachineState.target = null;
        fixtureSessionServerId = undefined;
        collaborationAdmissionState.state = 'unavailable';
    });

    it('keeps the bottom-mode page strip idle on Session updates and mounts top pages when requested', async () => {
        const props = { sessionId: 'sess_1', serverId: 'srv_1', activeSurface: 'chat' as const,
            openDetailsTabCount: 1, onSurfacePress: vi.fn(),
            catalog: resolveSessionCockpitMobileCatalog({ terminalTabAvailable: true }),
        };
        await seedCockpitState(<SessionPhonePageStrip {...props} />);
        const { storage } = await import('@/sync/domains/state/storageStore');
        const commits = vi.fn();
        const screen = await renderRealScreen(<React.Profiler id="page-strip" onRender={commits}>
            <SessionPhonePageStrip {...props} />
        </React.Profiler>);
        commits.mockClear();
        await act(async () => {
            const session = storage.getState().sessions.sess_1!;
            storage.getState().applySessions([{ ...session, updatedAt: session.updatedAt + 1,
                metadata: session.metadata ? { ...session.metadata, name: 'Changed session' } : null }]);
        });
        expect(commits).not.toHaveBeenCalled();
        await act(async () => storage.getState().applyLocalSettings({ navigationSurfacePlacementsV1: {
            pageTabs: { session: 'top' }, sessionTabBar: { orderedIds: [], placements: { tabs: 'pinned' } },
        } }));
        expect(commits).toHaveBeenCalled();
        expect(screen.tree.toJSON()).not.toBeNull();
    });

    it('uses the shared Session projection for native top mode with one bottom More', async () => {
        const { SystemMobileBottomChrome } = await import('../SystemMobileBottomChrome');
        const { SystemTabBar } = await import('../SystemTabBar');
        const onSurfacePress = vi.fn();
        const props = { sessionId: 'sess_1', serverId: 'srv_1', activeSurface: 'chat' as const,
            terminalTabAvailable: true, openDetailsTabCount: 0, onSurfacePress,
            catalog: resolveSessionCockpitMobileCatalog({ terminalTabAvailable: true }),
        };
        await seedCockpitState(<SessionBarSubject {...props} />);
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.setState(state => ({ localSettings: { ...state.localSettings,
            // Open files kept on the bar is a page, so Top draws a strip (Chat alone keeps its bottom slot).
            navigationSurfacePlacementsV1: { pageTabs: { session: 'top' }, sessionTabBar: { orderedIds: [], placements: { tabs: 'pinned' } } },
        } }));
        const screen = await renderRealScreen(<SystemMobileBottomChrome model={{ kind: 'sessionCockpit', props }} hidden={false} />);
        const native = screen.findByType(SystemTabBar);
        expect(native.props.items.map((item: { id: string }) => item.id)).toEqual(['browse', 'git', 'companion', 'terminal', 'more']);
        await act(async () => native.props.onPress('more'));
        expect(screen.findByType(DropdownMenu).props.open).toBe(true);
        // Open files is on the top strip, so the one bottom More does not repeat it.
        expect(screen.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).not.toContain('tabs');
        expect(screen.findByType(DropdownMenu).props.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'customize' })]));
        await act(async () => native.props.onPress('browse'));
        expect(onSurfacePress).toHaveBeenCalledWith('browse');
    });

    it('publishes no Session chrome commit for an unrelated Session arrival', async () => {
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="session-navigation" onRender={() => { commits++; }}>
            <MountedSessionCockpitTabBar sessionId="sess_1" serverId="srv_1" activeSurface="chat"
                terminalTabAvailable openDetailsTabCount={0} onSurfacePress={() => {}} />
        </React.Profiler>);
        const before = commits;
        const { storage } = await import('@/sync/domains/state/storageStore');
        await act(async () => storage.setState(state => ({ sessions: { ...state.sessions,
            unrelated: createSessionFixture({ id: 'unrelated', serverId: 'srv_1' }),
        } })));
        expect(commits - before).toBe(0);
        expect(screen.findHostByTestId('session-cockpit-tab-chat')).not.toBeNull();
    });

    it('never publishes Collaboration in the Cockpit catalog while admission is loading or refused', async () => {
        collaborationAdmissionState.state = 'loading';
        const bar = () => <MountedSessionCockpitTabBar sessionId="sess_1" serverId="srv_1" activeSurface="chat"
            terminalTabAvailable={false} openDetailsTabCount={0} onSurfacePress={() => {}} />;
        const screen = await renderScreen(bar());
        const catalogIds = () => screen.tree.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id);
        expect(catalogIds()).not.toContain('collaboration');

        collaborationAdmissionState.state = 'unavailable';
        await screen.update(bar());
        expect(catalogIds()).not.toContain('collaboration');
    });

    it('previews current phone-bar placements through inert controls without mounting session detail or writing preferences', async () => {
        const { SessionAgentCatalogIdentityIcon } = await import('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon');
        const onSurfacePress = vi.fn();
        const screen = await renderScreen(<MountedSessionCockpitTabBar sessionId="preview-session" activeSurface="chat"
            terminalTabAvailable openDetailsTabCount={0} onSurfacePress={onSurfacePress} />);
        const modal = getUiListsModalMockRef().current;
        modal.spies.show.mockClear();
        settingWrites.calls = [];
        await act(async () => { screen.tree.findByType(DropdownMenu).props.onSelect('customize'); });
        await vi.waitFor(() => expect(modal.spies.show).toHaveBeenCalled());
        const config = modal.spies.show.mock.calls.at(-1)?.[0];
        // The one Session Customize carries the bar preview on its phone list.
        const renderPreview = config.props.phone?.[0]?.renderPreview as ((preferences: NavigationPlacementPreferences) => React.ReactElement) | undefined;
        expect(renderPreview).toBeTypeOf('function');
        if (!renderPreview) throw new Error('Expected the phone-bar placement preview');
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
        try {
            const preview = await renderRealScreen(renderPreview({ orderedIds: [], placements: {} }));
            expect(preview.findHostByTestId('session-cockpit-preview-tab-git')).not.toBeNull();
            await preview.update(renderPreview({ orderedIds: ['terminal', 'browse'], placements: { git: 'hidden', tabs: 'overflow' } }));
            expect(preview.findHostByTestId('session-cockpit-preview-tab-git')).toBeNull();
            expect(preview.findHostByTestId('session-cockpit-preview-tab-terminal')).not.toBeNull();
            expect(preview.findHostByTestId('session-cockpit-preview-tab-tabs')).toBeNull();
            expect(preview.findHostByTestId('session-cockpit-preview-more')).not.toBeNull();
            expect(preview.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(0);
            expect(preview.findAll(node => node.type === DropdownMenu)).toHaveLength(0);
            await act(async () => { preview.pressByTestId('session-cockpit-preview-tab-terminal'); preview.pressByTestId('session-cockpit-preview-more'); });
            expect(onSurfacePress).not.toHaveBeenCalled();
            expect(settingWrites.calls).toEqual([]);
            expect(fetch).not.toHaveBeenCalled();
        } finally { fetch.mockRestore(); }
    });

    it('forwards the route Home to every session-scoped cockpit read', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        fixtureSessionServerId = 'home-a';
        scmState.status = { isDirty: true, changedFileCount: 3, linesAdded: 42, linesRemoved: 8 };
        const bar = () => (
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                serverId="home-b"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />
        );
        const screen = await renderScreen(bar());
        // A same-id live carrier from another Home cannot supply this route's identity or SCM.
        expect(screen.findHostByTestId('session-cockpit-tab-chat-agent-icon')?.props.agentId).toBe('');
        expect(screen.findHostByTestId('session-cockpit-tab-chat-agent-icon')?.props.machineId).toBeNull();
        expect(screen.findHostByTestId('session-cockpit-tab-git-badge')).toBeNull();

        fixtureSessionServerId = 'home-b';
        await screen.update(bar());
        expect(screen.findHostByTestId('session-cockpit-tab-chat-agent-icon')?.props).toMatchObject({
            agentId: 'codex', machineId: 'machine-1', serverId: 'home-b',
        });
        expect(screen.findHostByTestId('session-cockpit-tab-git-badge')).not.toBeNull();
        expect(screen.getTextContent()).toContain('3');
    });

    it('puts the Project pages on the bar in order, the rest behind More with their selected state (D44)', async () => {
        const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const navigate = vi.fn();
        const screen = await renderScreen(<ProjectCockpitTabBar
            pages={await projectPages()}
            workspaceRefId="workspace-a" activeSurface="context" terminalTabAvailable={true} onSurfacePress={navigate}
        />);
        const tablists = screen.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'tablist');
        expect(tablists).toHaveLength(1);
        const pages = ['overview', 'code', 'changes', 'scripts', 'services', 'context'];
        const onBar = pages.filter((page) => screen.findHostByTestId(`project-cockpit-tab-${page}`) !== null);
        // The bar holds a prefix of the pages; whatever does not fit is reachable from More.
        expect(onBar).toEqual(pages.slice(0, onBar.length));
        const menu = screen.root.findByType(DropdownMenu);
        const behindMore = menu.props.items.map((item: { id: string }) => item.id);
        expect([...onBar, ...behindMore.filter((id: string) => pages.includes(id))]).toEqual(pages);
        expect(behindMore).toEqual(expect.arrayContaining(['browser', 'terminal', 'tabs']));
        expect(behindMore).not.toContain('browse');
        if (!onBar.includes('context')) {
            expect(menu.props.selectedId).toBe('context');
            expect(screen.findHostByTestId('project-cockpit-tab-more')?.props.accessibilityState?.selected ?? true).toBe(true);
        }
        await act(async () => { menu.props.onSelect('code'); });
        expect(navigate).toHaveBeenCalledWith('code');
        await act(async () => { screen.findHostByTestId('project-cockpit-tab-overview')?.props.onPress(); });
        expect(navigate).toHaveBeenCalledWith('overview');
    });

    it('offers the switcher as accessibility actions on every cockpit tab', async () => {
        // The band's own container is `pointerEvents="box-none"` and is not an accessibility
        // element, so actions placed there never reach the VoiceOver rotor or the TalkBack
        // context menu. A tab is the only focusable thing in the band, so the actions ride
        // the tabs — the same shape `SessionItem` uses for its row actions.
        const controls = { dock: vi.fn(), step: vi.fn(() => true) };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const { SessionSwitcherBandContext } = await import('../lateralSwipe/SessionSwitcherBand');
        const screen = await renderScreen(
            <SessionSwitcherBandContext.Provider value={controls}>
                <MountedSessionCockpitTabBar
                    sessionId="sess_1"
                    activeSurface="chat"
                    terminalTabAvailable={true}
                    openDetailsTabCount={0}
                    onSurfacePress={() => {}}
                />
            </SessionSwitcherBandContext.Provider>,
        );

        const tabs = screen.tree.root.findAll((node) => (
            typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('session-cockpit-tab-')
            && Array.isArray(node.props?.accessibilityActions)
        ));
        expect(tabs.length).toBeGreaterThan(0);
        for (const tab of tabs) {
            expect((tab.props.accessibilityActions as Array<{ name: string }>).map((action) => action.name))
                .toEqual(['switchSession', 'previousSession', 'nextSession']);
            // An action is only operable if the element carrying it is also named.
            expect(typeof tab.props.accessibilityLabel).toBe('string');
        }

        act(() => {
            tabs[0]!.props.onAccessibilityAction({ nativeEvent: { actionName: 'nextSession' } });
        });
        expect(controls.step).toHaveBeenCalledWith('next');
        act(() => {
            tabs[0]!.props.onAccessibilityAction({ nativeEvent: { actionName: 'switchSession' } });
        });
        expect(controls.dock).toHaveBeenCalledTimes(1);
    });

    it('offers no band action where no switcher wraps the bar', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        const tabsWithActions = screen.tree.root.findAll((node) => (
            typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('session-cockpit-tab-')
            && node.props?.accessibilityActions !== undefined
        ));
        expect(tabsWithActions).toHaveLength(0);
    });

    function createMobilePluginPlacement() {
        const binding = normalizePluginUiDestinationBindingV1({
            pluginId: 'acme.review',
            destinationId: 'review-panel',
            rendererId: 'review-renderer',
            container: 'rightSidebarTab',
            target: { kind: 'session', sessionIdPath: '/session/id' },
        });
        if (!binding) throw new Error('fixture must use an admitted mobile Session binding');
        return {
            id: 'surfacePlacement:acme.review:review-panel',
            pluginId: 'acme.review',
            occurrenceId: 'acme-review-occurrence',
            contributionKind: 'surfacePlacement' as const,
            descriptorId: 'review-panel',
            binding,
            target: binding.target,
            renderer: { kind: 'host' as const, rendererId: 'review-renderer' },
            display: { developerFallback: 'Review' },
            availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
            headerActions: [],
        };
    }

    function flattenStyle(style: unknown): Record<string, unknown> {
        if (typeof style === 'function') return flattenStyle(style({ pressed: false, hovered: false, focused: false, selected: false, busy: false, disabled: false }));
        if (Array.isArray(style)) {
            return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
        }
        if (style && typeof style === 'object') {
            return style as Record<string, unknown>;
        }
        return {};
    }

    it('uses the session agent name and icon for the chat tab', async () => {
        // Agent identity remains Session-readable while its private machine target is unavailable.
        sessionMetadataState.ownerMetadataView = null;
        sessionMetadataState.metadata = { flavor: 'codex' };
        translationPrefix = 'en';
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('en:agentInput.agent.codex');
        const icon = screen.findHostByTestId('session-cockpit-tab-chat-agent-icon');
        expect(icon?.type).toBe('SessionAgentCatalogIdentityIcon');
        expect(icon?.props).toMatchObject({
            agentId: 'codex',
            machineId: null,
            serverId: null,
        });
    });

    it('uses strict shared Agent presentation for a layout1 owner', async () => {
        sessionMetadataState.metadataLayoutVersion = 1;
        sessionMetadataState.metadata = {
            v: 1,
            agentPresentation: { agentId: 'opencode' },
        };
        sessionMetadataState.ownerMetadataView = {
            flavor: 'claude',
        };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-tab-chat-agent-icon')?.props.agentId).toBe('opencode');
    });

    it('uses only strict shared Agent presentation for a layout1 participant', async () => {
        sessionMetadataState.metadataLayoutVersion = 1;
        sessionMetadataState.accessLevel = 'view';
        sessionMetadataState.metadata = {
            v: 1,
            agentPresentation: { agentId: 'claude' },
        };
        sessionMetadataState.ownerMetadataView = null;
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-tab-chat-agent-icon')?.props.agentId).toBe('claude');
    });

    it('names no Agent on the chat tab when the session Agent is unreadable', async () => {
        // A shared owner that publishes no Agent presentation leaves the chrome
        // with no Agent to name. Falling back to the product default would put
        // Claude's name and mark on another Agent's session.
        sessionMetadataState.metadataLayoutVersion = 1;
        sessionMetadataState.metadata = { v: 1 };
        translationPrefix = 'en';
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).not.toContain('en:agentInput.agent.claude');
        expect(screen.findHostByTestId('session-cockpit-tab-chat-agent-icon')?.props.agentId).not.toBe('claude');
        // With no Agent to name, the tab names its pane instead of a raw placeholder.
        expect(screen.getTextContent()).toContain('en:phoneNav.rail.chatPane');
        expect(screen.getTextContent()).not.toContain('Unknown Backend');
    });

    it('renders an external Agent through the machine-scoped catalog identity owner', async () => {
        sessionMetadataState.metadataLayoutVersion = 1;
        sessionMetadataState.metadata = {
            v: 1,
            agentPresentation: { agentId: 'acme.plugin/ultracode' },
        };
        reachableMachineState.target = { machineId: 'machine_external', basePath: '/repo' };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                serverId="server_external"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findAllByType('AgentIcon' as never)).toHaveLength(0);
        expect(screen.findHostByTestId('session-cockpit-tab-chat-agent-icon')?.props).toMatchObject({
            agentId: 'acme.plugin/ultracode',
            machineId: 'machine_external',
            serverId: 'server_external',
        });
    });

    it('shows a changed-files count badge by default when the session is dirty', async () => {
        scmState.status = { isDirty: true, changedFileCount: 3, linesAdded: 42, linesRemoved: 8 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-tab-git-badge')).not.toBeNull();
        const content = screen.getTextContent();
        expect(content).toContain('3');
        expect(content).not.toContain('+42');
    });

    it('shows the added/removed line chip when git badge mode is diffLines', async () => {
        badgeSettingsState.gitBadgeMode = 'diffLines';
        scmState.status = { isDirty: true, changedFileCount: 3, linesAdded: 42, linesRemoved: 8 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        const content = screen.getTextContent();
        expect(content).toContain('+42');
        expect(content).toContain('8');
    });

    it('hides the git badge when git badge mode is off', async () => {
        badgeSettingsState.gitBadgeMode = 'off';
        scmState.status = { isDirty: true, changedFileCount: 3, linesAdded: 42, linesRemoved: 8 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-tab-git-badge')).toBeNull();
    });

    it('omits the git badge for a clean working tree', async () => {
        scmState.status = { isDirty: false, changedFileCount: 0, linesAdded: 0, linesRemoved: 0 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-tab-git-badge')).toBeNull();
    });

    it('hides the open-tab count badge when disabled in settings', async () => {
        badgeSettingsState.openTabs = false;
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="tabs"
                terminalTabAvailable={false}
                openDetailsTabCount={4}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-tab-tabs-badge')).toBeNull();
    });

    it('shows an open-tab count badge on the tabs surface', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        cockpitPinsState.value = ['browse', 'git', 'tabs'];

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="tabs"
                terminalTabAvailable={false}
                openDetailsTabCount={4}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-tab-tabs-badge')).not.toBeNull();
        expect(screen.getTextContent()).toContain('4');
    });

    it('marks Collaboration in More with the rail\'s mention dot, and only for an unread mention', async () => {
        collaborationAdmissionState.state = 'available';
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const store = getStorage();
        const publish = (reasons: string[]) => store.setState((state) => ({
            ...state,
            sessionListRowsByServerId: {
                ...state.sessionListRowsByServerId,
                srv_1: {
                    sess_1: {
                        viewer: { readState: { state: 'tracking' }, attention: { needsAttention: reasons.length > 0, reasons } },
                    } as never,
                },
            },
        }));
        try {
            publish(['mentioned']);
            const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
            const screen = await renderScreen(
                <MountedSessionCockpitTabBar
                    sessionId="sess_1"
                    serverId="srv_1"
                    activeSurface="chat"
                    terminalTabAvailable={false}
                    openDetailsTabCount={0}
                    onSurfacePress={() => {}}
                />,
            );
            expect(screen.tree.findByType(DropdownMenu).props.items).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'collaboration' }),
            ]));
            await act(async () => { screen.tree.findByType(DropdownMenu).props.onOpenChange(true); });
            expect(screen.findHostByTestId('session-cockpit-more-fact:collaboration')).not.toBeNull();

            // Plain unread discussion stays quiet here, as on the desktop rail.
            await act(async () => { publish(['unread_discussion']); });
            expect(screen.findHostByTestId('session-cockpit-more-fact:collaboration')).toBeNull();
        } finally {
            collaborationAdmissionState.state = 'unavailable';
        }
    });

    it('renders Browser and Services as first-class session cockpit tabs', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const pressed: string[] = [];
        cockpitPinsState.value = ['browse', 'browser'];

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="browser"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={(surface) => pressed.push(surface)}
            />,
        );

        const browserTab = screen.findHostByTestId('session-cockpit-tab-browser');
        const servicesTab = screen.findHostByTestId('session-cockpit-tab-services');
        expect(browserTab?.props.role).toBe('tab');
        expect(browserTab?.props.accessibilityLabel).toBe('en:browserSurface.title');
        expect(browserTab?.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
        expect(servicesTab).toBeNull();
        const menu = screen.tree.findByType(DropdownMenu);
        expect(menu.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'services', title: 'en:localServices.inventory.title' }),
        ]));

        await act(async () => {
            menu.props.onSelect('services');
        });

        expect(pressed).toEqual(['services']);
    });

    it('opens Browser from More when it is not kept on the bar (native More → Browser)', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const pressed: string[] = [];
        cockpitPinsState.value = ['browse'];

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={(surface) => pressed.push(surface)}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-tab-browser')).toBeNull();
        const menu = screen.tree.findByType(DropdownMenu);
        expect(menu.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'browser', title: 'en:browserSurface.title' }),
        ]));
        await act(async () => {
            menu.props.onSelect('browser');
        });
        expect(pressed).toEqual(['browser']);
    });

    it('puts Chat and the default tools on the bar and lists the rest, pinnable, in the shared More', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        windowState.width = 390;

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={2}
                onSurfacePress={() => {}}
            />,
        );

        for (const id of ['chat', 'browse', 'git', 'companion', 'terminal']) {
            expect(screen.findHostByTestId(`session-cockpit-tab-${id}`)).toBeTruthy();
        }
        expect(screen.findHostByTestId('session-cockpit-tab-tabs')).toBeNull();
        expect(screen.tree.findAllByType('GestureHandlerScrollView' as never)).toHaveLength(0);
        const items = screen.tree.findByType(DropdownMenu).props.items as readonly Record<string, unknown>[];
        // One More presentation for every detail kind (orchestrator ruling 11-04): what is behind More,
        // pages before companions, never a second copy of the bar, then Customize.
        expect(items.map((item) => item.id)).toEqual(expect.arrayContaining(['tabs', 'navigation', 'browser', 'services', 'customize']));
        expect(items.map((item) => item.id)).not.toContain('git');
        expect(items.map((item) => item.id)).not.toContain('browse');
        expect(items.find((item) => item.id === 'tabs')?.category).toBe('pages');
        expect(items.find((item) => item.id === 'navigation')?.category).toBe('companions');
        expect(screen.tree.findByType(DropdownMenu).props.popoverPhonePresentation).toBeUndefined();
        // Every tool behind More can be pinned, not only plugins.
        await act(async () => { screen.tree.findByType(DropdownMenu).props.onOpenChange(true); });
        expect(screen.findHostByTestId('session-cockpit-pin:navigation')?.props.accessibilityState?.checked).toBe(false);
    });

    it('renders shared placement ordering and omits hidden tools from the bar and More', async () => {
        surfacePlacementsState.value = { sessionTabBar: {
            orderedIds: ['terminal', 'browse', 'git'],
            placements: { git: 'hidden', companion: 'overflow', tabs: 'hidden' },
        } };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const screen = await renderScreen(<MountedSessionCockpitTabBar sessionId="sess_1" activeSurface="chat"
            terminalTabAvailable={true} openDetailsTabCount={0} onSurfacePress={() => {}} />);
        expect(screen.findHostByTestId('session-cockpit-tab-terminal')).toBeTruthy();
        expect(screen.findHostByTestId('session-cockpit-tab-git')).toBeNull();
        expect(screen.findHostByTestId('session-cockpit-tab-companion')).toBeNull();
        const tabs = screen.findAll((node) => typeof node.type === 'string' && /^session-cockpit-tab-(chat|terminal|browse)$/.test(node.props.testID ?? ''))
            .map((node) => node.props.testID as string);
        expect([...new Set(tabs)]).toEqual(['session-cockpit-tab-chat', 'session-cockpit-tab-terminal', 'session-cockpit-tab-browse']);
        const items = screen.tree.findByType(DropdownMenu).props.items as readonly Record<string, unknown>[];
        expect(items.map((item) => item.id)).not.toContain('git');
        expect(items.map((item) => item.id)).not.toContain('tabs');
        expect(items.map((item) => item.id)).toContain('customize');
    });

    it('scrolls a bar of more tools than fit, and hands the horizontal axis to it', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const { useCockpitBarScrolls } = await import('./cockpitBarScrollState');
        const observed: boolean[] = [];
        const Probe = () => { observed.push(useCockpitBarScrolls()); return null; };
        windowState.width = 390;
        cockpitPinsState.value = ['browse', 'git', 'companion', 'terminal', 'tabs', 'navigation', 'browser'];
        const bar = () => (
            <>
                <MountedSessionCockpitTabBar sessionId="sess_1" activeSurface="chat" terminalTabAvailable={true}
                    openDetailsTabCount={0} onSurfacePress={() => {}} />
                <Probe />
            </>
        );

        const screen = await renderScreen(bar());
        expect(screen.tree.findAllByType('GestureHandlerScrollView' as never)).toHaveLength(1);
        expect(screen.findHostByTestId('session-cockpit-tab-browser')).toBeTruthy();
        expect(observed.at(-1)).toBe(true);

        // "Always swipe between sessions": the bar keeps what fits; the rest wait in More, labelled.
        swipeSettingsState.always = true;
        await screen.update(bar());
        expect(screen.tree.findAllByType('GestureHandlerScrollView' as never)).toHaveLength(0);
        expect(screen.findHostByTestId('session-cockpit-tab-tabs')).toBeTruthy();
        expect(screen.findHostByTestId('session-cockpit-tab-navigation')).toBeNull();
        const items = screen.tree.findByType(DropdownMenu).props.items as readonly Record<string, unknown>[];
        expect(items.find((item) => item.id === 'navigation')).toEqual(expect.objectContaining({
            category: 'companions',
            subtitle: 'en:phoneNav.bar.heldInMore',
        }));
        expect(observed.at(-1)).toBe(false);
    });

    it('shows a tool opened from More in the More slot, selected', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        windowState.width = 390;
        const screen = await renderScreen(
            <MountedSessionCockpitTabBar sessionId="sess_1" activeSurface="services" terminalTabAvailable={true}
                openDetailsTabCount={0} onSurfacePress={() => {}} />,
        );
        const more = screen.findHostByTestId('session-cockpit-tab-more');
        expect(more?.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
        expect(more?.props.accessibilityLabel).not.toBe('en:common.more');
        expect(screen.findHostByTestId('session-cockpit-tab-services')).toBeNull();
    });

    it('discovers admitted plugin tabs in More and puts a pinned one on the bar', async () => {
        const placement = createMobilePluginPlacement();
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const renderBar = () => (
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                pluginPlacements={[placement]}
                onSurfacePress={() => {}}
            />
        );
        const screen = await renderScreen(renderBar());

        const menu = screen.tree.findByType(DropdownMenu);
        expect(menu.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'plugin:acme.review:review-panel', title: 'Review' }),
        ]));
        expect(screen.findHostByTestId('session-cockpit-tab-plugin:acme.review:review-panel')).toBeNull();

        cockpitPinsState.value = ['browse', 'plugin:acme.review:review-panel'];
        await screen.update(renderBar());

        expect(screen.findHostByTestId('session-cockpit-tab-plugin:acme.review:review-panel')).toBeTruthy();
    });

    it('renders plugin pinning as a focusable Android-minimum effective target with explicit toggle state', async () => {
        const { Platform } = await import('react-native');
        settingWrites.calls = [];
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });

        try {
            const placement = createMobilePluginPlacement();
            const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
            const onSurfacePress = vi.fn();
            const renderBar = () => (
                <MountedSessionCockpitTabBar
                    sessionId="sess_1"
                    activeSurface="chat"
                    terminalTabAvailable={false}
                    openDetailsTabCount={0}
                    pluginPlacements={[placement]}
                    onSurfacePress={onSurfacePress}
                />
            );
            const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
            const screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>{renderBar()}</HappierUiPlatformProvider>);
            await act(async () => { screen.tree.findByType(DropdownMenu).props.onOpenChange(true); });
            const pinTestID = 'session-cockpit-pin:plugin:acme.review:review-panel';
            const pin = screen.findHostByTestId(pinTestID);
            const minimumTargetSize = 48;
            expect(pin?.props).toEqual(expect.objectContaining({
                accessibilityRole: 'checkbox',
                accessibilityLabel: 'en:phoneNav.bar.keepOnBar',
                accessibilityState: expect.objectContaining({ checked: false }),
            }));
            // Drawn at the IconButton's design square; the 48dp Android target is its hit area.
            const targetFrame = flattenStyle(pin?.props.style);
            const area = await layoutHitArea(() => screen.findHostByTestId(pinTestID), { width: Number(targetFrame.width), height: Number(targetFrame.height) });
            expect(area.height).toBeGreaterThanOrEqual(minimumTargetSize);
            expect(area.width).toBeGreaterThanOrEqual(24);

            const stopPropagation = vi.fn();
            await act(async () => {
                pin?.props.onPress?.({ stopPropagation });
            });
            expect(stopPropagation).toHaveBeenCalledTimes(1);
            // The pin asks the declared Settings Action to store the placement, starting from the host defaults.
            await vi.waitFor(() => expect(settingWrites.calls).toEqual([{
                address: { anchor: 'appearance.navigationPlacements' },
                value: expect.objectContaining({
                    sessionTabBar: expect.objectContaining({
                        placements: expect.objectContaining({ 'plugin:acme.review:review-panel': 'pinned' }),
                    }),
                }),
            }]));
            expect(onSurfacePress).not.toHaveBeenCalled();

            await act(async () => {
                screen.findHostByTestId(pinTestID)?.props.onFocus?.();
            });
            expect(screen.findHostByTestId(`${pinTestID}-tooltip`)).not.toBeNull();
            await act(async () => { screen.findHostByTestId(pinTestID)?.props.onBlur?.(); });
            expect(screen.findHostByTestId(`${pinTestID}-tooltip`)).toBeNull();

            cockpitPinsState.value = ['plugin:acme.review:review-panel'];
            await screen.update(renderBar());
            // Pinned, it moves to the bar and leaves More (the shared More lists only what is behind it).
            expect(screen.findHostByTestId('session-cockpit-tab-plugin:acme.review:review-panel')).toBeTruthy();
            expect(screen.findHostByTestId(pinTestID)).toBeNull();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('offers the transcript navigation surface as a session cockpit tab', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const pressed: string[] = [];
        cockpitPinsState.value = ['navigation'];

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="navigation"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={(surface) => pressed.push(surface)}
            />,
        );

        const navigationTab = screen.findHostByTestId('session-cockpit-tab-navigation');
        expect(navigationTab?.props.role).toBe('tab');
        expect(navigationTab?.props.accessibilityLabel).toBe('en:session.transcriptNavigation.title');
        expect(navigationTab?.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));

        await act(async () => {
            navigationTab?.props.onPress();
        });

        expect(pressed).toEqual(['navigation']);
    });

    it('never offers the desktop-only agents tab as a session cockpit surface', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-tab-agents')).toBeNull();
    });

    it('does not render a session cockpit active pill overlay', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-active-pill')).toBeNull();
    });

    it('does not render a project cockpit active pill overlay', async () => {
        const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');

        const screen = await renderScreen(
            <ProjectCockpitTabBar
                pages={await projectPages()}
                workspaceRefId="wr_1"
                activeSurface="terminal"
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('project-cockpit-active-pill')).toBeNull();
    });

    it('refreshes session tab labels when the language changes and the bar rerenders', async () => {
        translationPrefix = 'en';
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('en:common.files');

        translationPrefix = 'fr';
        await act(async () => {
            await screen.update(
                <MountedSessionCockpitTabBar
                    sessionId="sess_1"
                    activeSurface="chat"
                    terminalTabAvailable={true}
                    openDetailsTabCount={0}
                    onSurfacePress={() => {}}
                />,
            );
        });

        expect(screen.getTextContent()).toContain('fr:common.files');
        expect(screen.getTextContent()).toContain('fr:sessionBoard.companion.title');
        expect(screen.getTextContent()).toContain('fr:session.rightPanel.tabs.git');
        expect(screen.getTextContent()).not.toContain('fr:common.details');
    });

    it('refreshes project page labels when the language changes and the bar rerenders', async () => {
        translationPrefix = 'en';
        const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');

        const screen = await renderScreen(
            <ProjectCockpitTabBar
                pages={await projectPages()}
                workspaceRefId="wr_1"
                activeSurface="overview"
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('en:projects.pages.overview');

        translationPrefix = 'fr';
        await act(async () => {
            await screen.update(
                <ProjectCockpitTabBar
                    pages={await projectPages()}
                    workspaceRefId="wr_1"
                    activeSurface="overview"
                    onSurfacePress={() => {}}
                />,
            );
        });

        expect(screen.getTextContent()).toContain('fr:projects.pages.overview');
        expect(screen.getTextContent()).not.toContain('en:projects.pages.overview');
    });

    it('exposes the selected state on the active cockpit tab', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <MountedSessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findHostByTestId('session-cockpit-tab-git')?.props.role).toBe('tab');
        expect(screen.findHostByTestId('session-cockpit-tab-git')?.props.accessibilityLabel).toBe('en:session.rightPanel.tabs.git');
        expect(screen.findHostByTestId('session-cockpit-tab-browse')?.props.accessibilityLabel).toBe('en:common.files');
        expect(screen.findHostByTestId('session-cockpit-tab-git')?.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
        expect(screen.findHostByTestId('session-cockpit-tab-browse')?.props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
    }, 120_000);
it('projects addressed Discussion phone choices without reading shared desktop companion choices', async () => {
    const { DiscussionCockpitTabBar } = await import('./DiscussionCockpitTabBar');
    surfacePlacementsState.value = { workspaceRail: { orderedIds: [], placements: { discussionParticipants: 'hidden' } },
        detailPages: { discussion: { phone: { items: { orderedIds: [], placements: { discussionAgents: 'hidden', discussionDetails: 'overflow' } } } } } };
    const selected: string[] = [];
    const screen = await renderScreen(<DiscussionCockpitTabBar discussionId="thread" activeSurface="chat"
        onSurfacePress={surface => selected.push(surface)} />);
    expect(screen.findHostByTestId('discussion-cockpit-tab-chat')).not.toBeNull();
    expect(screen.findHostByTestId('discussion-cockpit-tab-participants')).not.toBeNull();
    expect(screen.findHostByTestId('discussion-cockpit-tab-agents')).toBeNull();
    expect(screen.findHostByTestId('discussion-cockpit-tab-details')).toBeNull();
    await act(async () => { screen.pressByTestId('discussion-cockpit-tab-more'); });
    expect(screen.tree.findByType(DropdownMenu).props.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'discussionDetails' }),
    ]));
    await act(async () => { screen.tree.findByType(DropdownMenu).props.onSelect('discussionDetails'); });
    expect(selected).toEqual(['details']);
    expect(surfacePlacementsState.value.workspaceRail?.placements).toEqual({ discussionParticipants: 'hidden' });
    await screen.unmount();
});
// One bar rule (owner 11-06): Bar items that do not fit scroll; nothing moves to More on its own, and
// items placed in More stay there. Every detail bar takes it from the shared presentation.
it('scrolls a Project bar whose pinned pages do not fit, and keeps More to what was placed there', async () => {
    const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');
    const { useCockpitBarScrolls } = await import('./cockpitBarScrollState');
    const observed: boolean[] = [];
    const Probe = () => { observed.push(useCockpitBarScrolls()); return null; };
    const pages = ['overview', 'code', 'changes', 'scripts', 'services', 'context'];
    const bar = async () => <>
        <ProjectCockpitTabBar pages={await projectPages()} workspaceRefId="workspace-a" activeSurface="overview"
            terminalTabAvailable={true} onSurfacePress={() => {}} />
        <Probe />
    </>;
    windowState.width = 300;
    const narrow = await renderScreen(await bar());
    expect(pages.filter(page => narrow.findHostByTestId(`project-cockpit-tab-${page}`) === null)).toEqual([]);
    expect(narrow.tree.findAllByType('GestureHandlerScrollView' as never)).toHaveLength(1);
    const behindMore = narrow.tree.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id);
    expect(behindMore.filter((id: string) => pages.includes(id))).toEqual([]);
    expect(observed.at(-1)).toBe(true);
    await narrow.unmount();

    windowState.width = 800;
    const wide = await renderScreen(await bar());
    expect(wide.tree.findAllByType('GestureHandlerScrollView' as never)).toHaveLength(0);
    expect(pages.filter(page => wide.findHostByTestId(`project-cockpit-tab-${page}`) === null)).toEqual([]);
    expect(observed.at(-1)).toBe(false);
    await wide.unmount();
});
// TL-E / UI refinements 11-07: long-pressing a tab opens the one placement menu, for every bar.
it('opens the placement menu from a long-pressed Project tab and writes the choice', async () => {
    const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');
    const screen = await renderScreen(<ProjectCockpitTabBar pages={await projectPages()} workspaceRefId="workspace-a"
        activeSurface="overview" terminalTabAvailable={true} onSurfacePress={() => {}} />);
    const tabMenu = () => screen.tree.findAllByType(DropdownMenu).find(menu => menu.props.testID === 'project-cockpit-tab-menu');
    expect(tabMenu()).toBeUndefined();
    await act(async () => { screen.findHostByTestId('project-cockpit-tab-code')?.props.onLongPress(); });
    expect(tabMenu()?.props.open).toBe(true);
    expect(tabMenu()?.props.items.map((item: { id: string }) => item.id)).toEqual(['pinned', 'overflow', 'hidden', 'customize']);
    await act(async () => { await tabMenu()?.props.onSelect('overflow'); });
    expect(JSON.stringify(settingWrites.calls.at(-1)?.value)).toContain('"code":"overflow"');
    expect(tabMenu()).toBeUndefined();
    // The Project's primary page cannot leave the bar: its menu only offers Customize.
    await act(async () => { screen.findHostByTestId('project-cockpit-tab-overview')?.props.onLongPress(); });
    expect(tabMenu()?.props.items.map((item: { id: string }) => item.id)).toEqual(['customize']);
    await screen.unmount();
});
// FIN N4: inside a page's own bottom bar a phone bar folds to its More, and nothing it showed is lost.
it('folds a phone bar to one More that lists every item, showing the selected one', async () => {
    const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');
    const { CockpitBarFoldedContext } = await import('../pageBarChromeFold');
    const screen = await renderScreen(<CockpitBarFoldedContext.Provider value={true}>
        <ProjectCockpitTabBar pages={await projectPages()} workspaceRefId="workspace-a"
            activeSurface="code" terminalTabAvailable={true} onSurfacePress={() => {}} />
    </CockpitBarFoldedContext.Provider>);
    expect(screen.findHostByTestId('project-cockpit-tab-code')).toBeNull();
    expect(screen.findHostByTestId('project-cockpit-tab-more')?.props.accessibilityLabel).toContain('code');
    const items = screen.tree.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id);
    expect(items).toEqual(expect.arrayContaining(['overview', 'code', 'changes', 'scripts', 'services', 'context', 'customize']));
    await screen.unmount();
});
it('keeps every pinned Discussion entry on a narrow bar, scrolling, beside one permanent More', async () => {
    const { DiscussionCockpitTabBar } = await import('./DiscussionCockpitTabBar');
    windowState.width = 260;
    const props = { discussionId: 'thread', activeSurface: 'details' as const, onSurfacePress: vi.fn() };
    const screen = await renderScreen(<DiscussionCockpitTabBar {...props} />);
    expect(screen.findHostByTestId('discussion-cockpit-tab-chat')).not.toBeNull();
    expect(screen.findHostByTestId('discussion-cockpit-tab-details')).not.toBeNull();
    expect(screen.tree.findAllByType('GestureHandlerScrollView' as never)).toHaveLength(1);
    expect(screen.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'discussion-cockpit-tab-more')).toHaveLength(1);
    expect(screen.tree.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).not.toContain('discussionDetails');
    await screen.unmount();
});
it('keeps Discussion Chat in its bottom slot without a page strip when Top has only Chat', async () => {
    const { DiscussionCockpitTabBar, useDiscussionPhoneNavigation } = await import('./DiscussionCockpitTabBar');
    surfacePlacementsState.value = { pageTabs: { discussion: 'top' } };
    const props = { discussionId: 'thread', activeSurface: 'chat' as const, onSurfacePress: vi.fn() };
    let topPageIds: readonly string[] = [];
    function DiscussionPhone() {
        topPageIds = useDiscussionPhoneNavigation(props).topPages.map(item => item.id);
        return <DiscussionCockpitTabBar {...props} />;
    }
    const screen = await renderScreen(<DiscussionPhone />);
    expect(topPageIds).toEqual([]);
    expect(screen.findHostByTestId('discussion-cockpit-tab-chat')).not.toBeNull();
    expect(screen.findHostByTestId('discussion-cockpit-tab-participants')).not.toBeNull();
    expect(screen.findHostByTestId('discussion-cockpit-tab-agents')).not.toBeNull();
    expect(screen.findHostByTestId('discussion-cockpit-tab-details')).not.toBeNull();
    expect(screen.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'discussion-cockpit-tab-more')).toHaveLength(1);
    await screen.unmount();
});

});
