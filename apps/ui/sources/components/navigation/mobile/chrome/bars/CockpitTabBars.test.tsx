import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { MetadataSchema } from '@happier-dev/session-core/state';

import { renderScreen as renderRealScreen } from '@/dev/testkit/render/renderScreen';
import { createMachineFixture, createSessionFixture, standardCleanup } from '@/dev/testkit';
import type { ScmStatus } from '@/sync/domains/state/storageTypes';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let translationPrefix = 'en';
let fixtureSessionServerId: string | undefined;
const sessionMetadataState = vi.hoisted(() => ({
    metadata: { flavor: 'codex' } as Record<string, unknown> | null,
    metadataLayoutVersion: 0,
    ownerMetadataView: undefined as Record<string, unknown> | null | undefined,
    accessLevel: null as 'view' | 'edit' | 'admin' | null,
}));
const collaborationAdmissionState = vi.hoisted(() => ({ admitted: false }));
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
const surfacePlacementsState = vi.hoisted(() => ({
    value: {} as Record<string, { orderedIds: string[]; placements: Record<string, 'pinned' | 'overflow' | 'hidden'> }>,
}));
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
        sessionCockpitBarSurfaceIds: cockpitPinsState.value,
        navigationSurfacePlacementsV1: surfacePlacementsState.value } });
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
    useSessionCollaborationDestinationAdmitted: () => collaborationAdmissionState.admitted,
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
const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
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
    });

    it('forwards the route Home to every session-scoped cockpit read', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        fixtureSessionServerId = 'home-a';
        scmState.status = { isDirty: true, changedFileCount: 3, linesAdded: 42, linesRemoved: 8 };
        const bar = () => (
            <SessionCockpitTabBar
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
        expect(screen.findByTestId('session-cockpit-tab-chat-agent-icon')?.props.agentId).toBe('');
        expect(screen.findByTestId('session-cockpit-tab-chat-agent-icon')?.props.machineId).toBeNull();
        expect(screen.findByTestId('session-cockpit-tab-git-badge')).toBeNull();

        fixtureSessionServerId = 'home-b';
        await screen.update(bar());
        expect(screen.findByTestId('session-cockpit-tab-chat-agent-icon')?.props).toMatchObject({
            agentId: 'codex', machineId: 'machine-1', serverId: 'home-b',
        });
        expect(screen.findByTestId('session-cockpit-tab-git-badge')).not.toBeNull();
        expect(screen.getTextContent()).toContain('3');
    });

    it('groups Project tabs into one tablist while preserving selection and navigation', async () => {
        const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');
        const navigate = vi.fn();
        const screen = await renderScreen(<ProjectCockpitTabBar
            workspaceRefId="workspace-a" activeSurface="git" onSurfacePress={navigate}
        />);
        const tablists = screen.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'tablist');
        expect(tablists).toHaveLength(1);
        const tabs = tablists[0].findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'tab');
        expect(tabs).toHaveLength(7);
        expect(screen.findByTestId('project-cockpit-tab-git')?.props.accessibilityState.selected).toBe(true);
        await act(async () => { screen.findByTestId('project-cockpit-tab-browse')?.props.onPress(); });
        expect(navigate).toHaveBeenCalledWith('browse');
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
                <SessionCockpitTabBar
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
            <SessionCockpitTabBar
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
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('en:agentInput.agent.codex');
        const icon = screen.findByTestId('session-cockpit-tab-chat-agent-icon');
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
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-chat-agent-icon')?.props.agentId).toBe('opencode');
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
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-chat-agent-icon')?.props.agentId).toBe('claude');
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
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).not.toContain('en:agentInput.agent.claude');
        expect(screen.findByTestId('session-cockpit-tab-chat-agent-icon')?.props.agentId).not.toBe('claude');
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
            <SessionCockpitTabBar
                sessionId="sess_1"
                serverId="server_external"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findAllByType('AgentIcon' as never)).toHaveLength(0);
        expect(screen.findByTestId('session-cockpit-tab-chat-agent-icon')?.props).toMatchObject({
            agentId: 'acme.plugin/ultracode',
            machineId: 'machine_external',
            serverId: 'server_external',
        });
    });

    it('shows a changed-files count badge by default when the session is dirty', async () => {
        scmState.status = { isDirty: true, changedFileCount: 3, linesAdded: 42, linesRemoved: 8 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-git-badge')).not.toBeNull();
        const content = screen.getTextContent();
        expect(content).toContain('3');
        expect(content).not.toContain('+42');
    });

    it('shows the added/removed line chip when git badge mode is diffLines', async () => {
        badgeSettingsState.gitBadgeMode = 'diffLines';
        scmState.status = { isDirty: true, changedFileCount: 3, linesAdded: 42, linesRemoved: 8 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
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
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-git-badge')).toBeNull();
    });

    it('omits the git badge for a clean working tree', async () => {
        scmState.status = { isDirty: false, changedFileCount: 0, linesAdded: 0, linesRemoved: 0 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-git-badge')).toBeNull();
    });

    it('hides the open-tab count badge when disabled in settings', async () => {
        badgeSettingsState.openTabs = false;
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="tabs"
                terminalTabAvailable={false}
                openDetailsTabCount={4}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-tabs-badge')).toBeNull();
    });

    it('shows an open-tab count badge on the tabs surface', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        cockpitPinsState.value = ['browse', 'git', 'tabs'];

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="tabs"
                terminalTabAvailable={false}
                openDetailsTabCount={4}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-tabs-badge')).not.toBeNull();
        expect(screen.getTextContent()).toContain('4');
    });

    it('marks Collaboration in More with the rail\'s mention dot, and only for an unread mention', async () => {
        collaborationAdmissionState.admitted = true;
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
                <SessionCockpitTabBar
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
            collaborationAdmissionState.admitted = false;
        }
    });

    it('renders Browser and Services as first-class session cockpit tabs', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const pressed: string[] = [];
        cockpitPinsState.value = ['browse', 'browser'];

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="browser"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={(surface) => pressed.push(surface)}
            />,
        );

        const browserTab = screen.findByTestId('session-cockpit-tab-browser');
        const servicesTab = screen.findByTestId('session-cockpit-tab-services');
        expect(browserTab?.props.accessibilityRole).toBe('tab');
        expect(browserTab?.props.accessibilityLabel).toBe('en:browserSurface.title');
        expect(browserTab?.props.accessibilityState).toEqual({ selected: true });
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

    it('puts Chat and the default tools on the bar and lists every tool, pinnable, in More', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        windowState.width = 390;

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={2}
                onSurfacePress={() => {}}
            />,
        );

        for (const id of ['chat', 'browse', 'git', 'companion', 'terminal']) {
            expect(screen.findByTestId(`session-cockpit-tab-${id}`)).toBeTruthy();
        }
        expect(screen.findByTestId('session-cockpit-tab-tabs')).toBeNull();
        expect(screen.tree.findAllByType('GestureHandlerScrollView' as never)).toHaveLength(0);
        const items = screen.tree.findByType(DropdownMenu).props.items as readonly Record<string, unknown>[];
        expect(items.map((item) => item.id)).toEqual(expect.arrayContaining(['browse', 'git', 'tabs', 'navigation', 'browser', 'services']));
        expect(items.find((item) => item.id === 'git')?.category).toBe('en:phoneNav.bar.onTheBar');
        expect(items.find((item) => item.id === 'tabs')?.category).toBe('en:phoneNav.bar.more');
        // Every tool can be pinned, not only plugins.
        await act(async () => { screen.tree.findByType(DropdownMenu).props.onOpenChange(true); });
        expect(screen.findByTestId('session-cockpit-pin:navigation')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-pin:git')?.props.accessibilityState?.checked).toBe(true);
    });

    it('renders shared placement ordering and omits hidden tools from the bar and More', async () => {
        surfacePlacementsState.value = { sessionTabBar: {
            orderedIds: ['terminal', 'browse', 'git'],
            placements: { git: 'hidden', companion: 'overflow', tabs: 'hidden' },
        } };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const screen = await renderScreen(<SessionCockpitTabBar sessionId="sess_1" activeSurface="chat"
            terminalTabAvailable={true} openDetailsTabCount={0} onSurfacePress={() => {}} />);
        expect(screen.findByTestId('session-cockpit-tab-terminal')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-git')).toBeNull();
        expect(screen.findByTestId('session-cockpit-tab-companion')).toBeNull();
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
                <SessionCockpitTabBar sessionId="sess_1" activeSurface="chat" terminalTabAvailable={true}
                    openDetailsTabCount={0} onSurfacePress={() => {}} />
                <Probe />
            </>
        );

        const screen = await renderScreen(bar());
        expect(screen.tree.findAllByType('GestureHandlerScrollView' as never)).toHaveLength(1);
        expect(screen.findByTestId('session-cockpit-tab-browser')).toBeTruthy();
        expect(observed.at(-1)).toBe(true);

        // "Always swipe between sessions": the bar keeps what fits; the rest wait in More, labelled.
        swipeSettingsState.always = true;
        await screen.update(bar());
        expect(screen.tree.findAllByType('GestureHandlerScrollView' as never)).toHaveLength(0);
        expect(screen.findByTestId('session-cockpit-tab-tabs')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-navigation')).toBeNull();
        const items = screen.tree.findByType(DropdownMenu).props.items as readonly Record<string, unknown>[];
        expect(items.find((item) => item.id === 'navigation')).toEqual(expect.objectContaining({
            category: 'en:phoneNav.bar.onTheBar',
            subtitle: 'en:phoneNav.bar.heldInMore',
        }));
        expect(observed.at(-1)).toBe(false);
    });

    it('shows a tool opened from More in the More slot, selected', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        windowState.width = 390;
        const screen = await renderScreen(
            <SessionCockpitTabBar sessionId="sess_1" activeSurface="services" terminalTabAvailable={true}
                openDetailsTabCount={0} onSurfacePress={() => {}} />,
        );
        const more = screen.findByTestId('session-cockpit-tab-more');
        expect(more?.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
        expect(more?.props.accessibilityLabel).not.toBe('en:common.more');
        expect(screen.findByTestId('session-cockpit-tab-services')).toBeNull();
    });

    it('discovers admitted plugin tabs in More and puts a pinned one on the bar', async () => {
        const placement = createMobilePluginPlacement();
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const renderBar = () => (
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                pluginPlacements={[placement]}
                projectionGeneration={4}
                onSurfacePress={() => {}}
            />
        );
        const screen = await renderScreen(renderBar());

        const menu = screen.tree.findByType(DropdownMenu);
        expect(menu.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'plugin:acme.review:review-panel', title: 'Review' }),
        ]));
        expect(screen.findByTestId('session-cockpit-tab-plugin:acme.review:review-panel')).toBeNull();

        cockpitPinsState.value = ['browse', 'plugin:acme.review:review-panel'];
        await screen.update(renderBar());

        expect(screen.findByTestId('session-cockpit-tab-plugin:acme.review:review-panel')).toBeTruthy();
    });

    it('renders plugin pinning as a focusable Android-minimum effective target with explicit toggle state', async () => {
        const { Platform } = await import('react-native');
        const { resolveMinimumInteractiveTargetSize } = await import('@/components/ui/interactiveTargetSize');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });

        try {
            const placement = createMobilePluginPlacement();
            const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
            const onSurfacePress = vi.fn();
            const renderBar = () => (
                <SessionCockpitTabBar
                    sessionId="sess_1"
                    activeSurface="chat"
                    terminalTabAvailable={false}
                    openDetailsTabCount={0}
                    pluginPlacements={[placement]}
                    projectionGeneration={4}
                    onSurfacePress={onSurfacePress}
                />
            );
            const screen = await renderScreen(renderBar());
            await act(async () => { screen.tree.findByType(DropdownMenu).props.onOpenChange(true); });
            const pinTestID = 'session-cockpit-pin:plugin:acme.review:review-panel';
            const pin = screen.findByTestId(pinTestID);
            const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

            expect(minimumTargetSize).toBe(48);
            expect(pin?.props).toEqual(expect.objectContaining({
                accessibilityRole: 'checkbox',
                accessibilityLabel: 'en:phoneNav.bar.keepOnBar',
                accessibilityState: expect.objectContaining({ checked: false }),
                // The shared IconButton owns the minimum target with a real press
                // frame; RNW cannot turn Pressable hitSlop into a physical target.
                hitSlop: 0,
            }));
            const targetFrame = flattenStyle(pin?.props.style);
            expect(targetFrame.width).toBeGreaterThanOrEqual(minimumTargetSize);
            expect(targetFrame.height).toBeGreaterThanOrEqual(minimumTargetSize);

            const stopPropagation = vi.fn();
            await act(async () => {
                pin?.props.onPress?.({ stopPropagation });
            });
            expect(stopPropagation).toHaveBeenCalledTimes(1);
            // The first change starts from the host defaults, then adds the plugin at the end.
            expect((await import('@/sync/domains/state/storageStore')).storage.getState().localSettings.navigationSurfacePlacementsV1)
                .toMatchObject({
                    sessionTabBar: { placements: { 'plugin:acme.review:review-panel': 'pinned' } },
                });
            expect(onSurfacePress).not.toHaveBeenCalled();

            await act(async () => {
                screen.findByTestId(pinTestID)?.props.onFocus?.();
            });
            expect(screen.findByTestId(`${pinTestID}-tooltip`)).not.toBeNull();
            await act(async () => { screen.findByTestId(pinTestID)?.props.onBlur?.(); });
            expect(screen.findByTestId(`${pinTestID}-tooltip`)).toBeNull();

            cockpitPinsState.value = ['plugin:acme.review:review-panel'];
            await screen.update(renderBar());
            const pinnedControl = screen.findByTestId(pinTestID);
            expect(pinnedControl?.props.accessibilityLabel).toBe('en:phoneNav.bar.removeFromBar');
            expect(pinnedControl?.props.accessibilityState?.checked).toBe(true);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('offers the transcript navigation surface as a session cockpit tab', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const pressed: string[] = [];
        cockpitPinsState.value = ['navigation'];

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="navigation"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={(surface) => pressed.push(surface)}
            />,
        );

        const navigationTab = screen.findByTestId('session-cockpit-tab-navigation');
        expect(navigationTab?.props.accessibilityRole).toBe('tab');
        expect(navigationTab?.props.accessibilityLabel).toBe('en:session.transcriptNavigation.title');
        expect(navigationTab?.props.accessibilityState).toEqual({ selected: true });

        await act(async () => {
            navigationTab?.props.onPress();
        });

        expect(pressed).toEqual(['navigation']);
    });

    it('never offers the desktop-only agents tab as a session cockpit surface', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-agents')).toBeNull();
    });

    it('does not render a session cockpit active pill overlay', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-active-pill')).toBeNull();
    });

    it('does not render a project cockpit active pill overlay', async () => {
        const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');

        const screen = await renderScreen(
            <ProjectCockpitTabBar
                workspaceRefId="wr_1"
                activeSurface="terminal"
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('project-cockpit-active-pill')).toBeNull();
    });

    it('refreshes session tab labels when the language changes and the bar rerenders', async () => {
        translationPrefix = 'en';
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
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
                <SessionCockpitTabBar
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

    it('refreshes project tab labels when the language changes and the bar rerenders', async () => {
        translationPrefix = 'en';
        const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');

        const screen = await renderScreen(
            <ProjectCockpitTabBar
                workspaceRefId="wr_1"
                activeSurface="overview"
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('en:common.files');

        translationPrefix = 'fr';
        await act(async () => {
            await screen.update(
                <ProjectCockpitTabBar
                    workspaceRefId="wr_1"
                    activeSurface="overview"
                    onSurfacePress={() => {}}
                />,
            );
        });

        expect(screen.getTextContent()).toContain('fr:common.files');
        expect(screen.getTextContent()).toContain('fr:phoneNav.bar.openFiles');
        expect(screen.getTextContent()).toContain('fr:session.rightPanel.tabs.git');
        expect(screen.getTextContent()).not.toContain('fr:common.details');
    });

    it('exposes the selected state on the active cockpit tab', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-git')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('session-cockpit-tab-git')?.props.accessibilityLabel).toBe('en:session.rightPanel.tabs.git');
        expect(screen.findByTestId('session-cockpit-tab-browse')?.props.accessibilityLabel).toBe('en:common.files');
        expect(screen.findByTestId('session-cockpit-tab-git')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findByTestId('session-cockpit-tab-browse')?.props.accessibilityState).toEqual({ selected: false });
    }, 120_000);
});
