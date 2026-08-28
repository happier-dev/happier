import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { renderScreen } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let translationPrefix = 'en';
const sessionMetadataState = vi.hoisted(() => ({
    metadata: { flavor: 'codex' } as Record<string, unknown> | null,
    metadataLayoutVersion: 0,
    ownerMetadataView: null as Record<string, unknown> | null,
    accessLevel: null as 'view' | 'edit' | 'admin' | null,
}));
const scmState = vi.hoisted(() => ({
    status: null as Record<string, unknown> | null,
}));
const badgeSettingsState = vi.hoisted(() => ({
    gitBadgeMode: 'changedFiles' as 'changedFiles' | 'diffLines' | 'off',
    openTabs: true,
}));
const cockpitPinsState = vi.hoisted(() => ({
    value: [] as string[],
    set: vi.fn(),
}));
const reachableMachineState = vi.hoisted(() => ({
    target: null as { machineId: string; basePath: string } | null,
}));
type LateralTarget = { sessionId: string; title: string; position: number; total: number } | null;
const lateralNavigationState = vi.hoisted(() => ({
    previous: null as LateralTarget,
    next: null as LateralTarget,
    navigate: vi.fn(),
}));

// What the readout SAYS is proven in its own suite, against real shared values. Here the
// contract is where it hangs, so it is stood in for by a locatable marker.
vi.mock('../lateralSwipe/SessionCockpitLateralReadout', () => ({
    SessionCockpitLateralReadout: (props: Record<string, unknown>) =>
        React.createElement('View', { ...props, testID: 'session-cockpit-lateral-readout-slot' }),
}));

// The bar's contract here is PLACEMENT: given navigable neighbours, expose named actions on
// focusable elements. Resolving those neighbours reaches auth, routing and the session store,
// and is proven in `useSessionCockpitLateralNavigation`'s own suite.
vi.mock('../lateralSwipe/useSessionCockpitLateralNavigation', () => ({
    useSessionCockpitLateralNavigation: () => ({
        previous: lateralNavigationState.previous,
        next: lateralNavigationState.next,
        anchorSessionKey: 'sess_1',
        availableCount: () => 0,
        resolveTargets: () => [],
        navigate: lateralNavigationState.navigate,
    }),
}));

installNavigationCommonModuleMocks({
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
    storage: async () => ({
        useSessionMetadata: () => sessionMetadataState.metadata,
        useSession: () => ({
            id: 'sess_1',
            metadata: sessionMetadataState.metadata,
            metadataLayoutVersion: sessionMetadataState.metadataLayoutVersion,
            ownerMetadataView: sessionMetadataState.ownerMetadataView,
            accessLevel: sessionMetadataState.accessLevel,
        }),
        useSessionProjectScmStatus: () => scmState.status,
        useSetting: (key: string) => {
            if (key === 'tabBarGitBadgeMode') return badgeSettingsState.gitBadgeMode;
            if (key === 'tabBarOpenTabsBadgeEnabled') return badgeSettingsState.openTabs;
            if (key === 'tabBarShowLabels') return true;
            if (key === 'tabBarSize') return 'regular';
            return undefined;
        },
        useLocalSettingMutable: (key: string) => key === 'sessionCockpitPinnedSurfaceIds'
            ? [cockpitPinsState.value, cockpitPinsState.set]
            : [null, vi.fn()],
    }),
});

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

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionReachableMachineTarget: () => reachableMachineState.target,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
    useLayoutMaxWidth: () => 960,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 960 }),
}));

describe('cockpit tab bars', () => {
    afterEach(() => {
        translationPrefix = 'en';
        sessionMetadataState.metadata = { flavor: 'codex' };
        sessionMetadataState.metadataLayoutVersion = 0;
        sessionMetadataState.ownerMetadataView = null;
        sessionMetadataState.accessLevel = null;
        scmState.status = null;
        badgeSettingsState.gitBadgeMode = 'changedFiles';
        badgeSettingsState.openTabs = true;
        cockpitPinsState.value = [];
        cockpitPinsState.set.mockClear();
        reachableMachineState.target = null;
        lateralNavigationState.previous = null;
        lateralNavigationState.next = null;
        lateralNavigationState.navigate.mockClear();
    });

    it('offers the lateral step as an accessibility action on every cockpit tab', async () => {
        // The band's own container is `pointerEvents="box-none"` and is not an accessibility
        // element, so actions placed there never reach the VoiceOver rotor or the TalkBack
        // context menu. A tab is the only focusable thing in the band, so the actions ride
        // the tabs — the same shape `SessionItem` uses for its row actions.
        lateralNavigationState.previous = { sessionId: 'sess_0', title: 'Previous', position: 1, total: 3 };
        lateralNavigationState.next = { sessionId: 'sess_2', title: 'Next', position: 3, total: 3 };

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

        const tabs = screen.tree.root.findAll((node) => (
            typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('session-cockpit-tab-')
            && Array.isArray(node.props?.accessibilityActions)
        ));
        expect(tabs.length).toBeGreaterThan(0);
        for (const tab of tabs) {
            expect((tab.props.accessibilityActions as Array<{ name: string }>).map((action) => action.name))
                .toEqual(['previousSession', 'nextSession']);
            // An action is only operable if the element carrying it is also named.
            expect(typeof tab.props.accessibilityLabel).toBe('string');
        }

        act(() => {
            tabs[0]!.props.onAccessibilityAction({ nativeEvent: { actionName: 'nextSession' } });
        });
        expect(lateralNavigationState.navigate).toHaveBeenCalledWith('next');
    });

    it('mounts the lateral readout inside the capsule rather than beside the band', async () => {
        // The capsule IS the readout for this gesture: the picker column above deliberately
        // starts one entry out because the nearest session is named here. An unmounted
        // readout therefore does not just lose a label, it hides the first reachable
        // session entirely.
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                serverId="server_a"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        const readouts = screen.findAllHostsByTestId('session-cockpit-lateral-readout-slot');
        expect(readouts).toHaveLength(1);
        // Scoped like the picker column, so the capsule and the row descending into it can
        // never resolve to two different sessions on a multi-server order.
        expect(readouts[0]!.props.sessionId).toBe('sess_1');
        expect(readouts[0]!.props.serverId).toBe('server_a');
    });

    it('offers no lateral accessibility action when there is no neighbour to step to', async () => {
        lateralNavigationState.previous = null;
        lateralNavigationState.next = null;

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
        if (Array.isArray(style)) {
            return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
        }
        if (style && typeof style === 'object') {
            return style as Record<string, unknown>;
        }
        return {};
    }

    it('uses the session agent name and icon for the chat tab', async () => {
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
        scmState.status = { isDirty: true, modifiedCount: 3, linesAdded: 42, linesRemoved: 8 };
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
        scmState.status = { isDirty: true, modifiedCount: 3, linesAdded: 42, linesRemoved: 8 };
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
        scmState.status = { isDirty: true, modifiedCount: 3, linesAdded: 42, linesRemoved: 8 };
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
        scmState.status = { isDirty: false, modifiedCount: 0, linesAdded: 0, linesRemoved: 0 };
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

    it('renders Browser and Services as first-class session cockpit tabs', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const pressed: string[] = [];

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
        const menu = screen.tree.findByType('DropdownMenu' as never);
        expect(menu.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'services', title: 'en:localServices.inventory.title' }),
        ]));

        await act(async () => {
            menu.props.onSelect('services');
        });

        expect(pressed).toEqual(['services']);
    });

    it('keeps the bounded inline set and exposes remaining built-ins through More', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={2}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-chat')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-browse')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-git')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-tabs')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-navigation')).toBeNull();
        expect(screen.findByTestId('session-cockpit-tab-browser')).toBeNull();
        expect(screen.findByTestId('session-cockpit-tab-services')).toBeNull();
        expect(screen.findByTestId('session-cockpit-tab-terminal')).toBeNull();
        expect(screen.tree.findByType('DropdownMenu' as never).props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'navigation' }),
            expect.objectContaining({ id: 'browser' }),
            expect.objectContaining({ id: 'services' }),
            expect.objectContaining({ id: 'terminal' }),
        ]));
    });

    it('discovers admitted plugin tabs in More and applies the host-owned persisted pin order', async () => {
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

        const menu = screen.tree.findByType('DropdownMenu' as never);
        expect(menu.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'plugin:acme.review:review-panel', title: 'Review' }),
        ]));
        expect(screen.findByTestId('session-cockpit-tab-plugin:acme.review:review-panel')).toBeNull();

        cockpitPinsState.value = ['plugin:acme.review:review-panel'];
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
            const pinTestID = 'session-cockpit-pin:plugin:acme.review:review-panel';
            const pin = screen.findByTestId(pinTestID);
            const minimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

            expect(minimumTargetSize).toBe(48);
            expect(pin?.props).toEqual(expect.objectContaining({
                accessibilityRole: 'checkbox',
                accessibilityLabel: 'en:projects.actions.pin',
                accessibilityState: expect.objectContaining({ checked: false }),
                // The shared IconButton owns the minimum target with a real press
                // frame; RNW cannot turn Pressable hitSlop into a physical target.
                hitSlop: 0,
            }));
            const restingStyle = typeof pin?.props.style === 'function'
                ? pin.props.style({ pressed: false })
                : pin?.props.style;
            expect(flattenStyle(restingStyle)).toEqual(expect.objectContaining({
                width: 28,
                height: minimumTargetSize,
                marginHorizontal: 0,
                marginVertical: -(minimumTargetSize - 28) / 2,
            }));
            expect(flattenStyle(screen.findByTestId(`${pinTestID}-surface`)?.props.style)).toEqual(
                expect.objectContaining({ width: 28, height: 28 }),
            );

            const stopPropagation = vi.fn();
            await act(async () => {
                pin?.props.onPress?.({ stopPropagation });
            });
            expect(stopPropagation).toHaveBeenCalledTimes(1);
            expect(cockpitPinsState.set).toHaveBeenCalledWith(['plugin:acme.review:review-panel']);
            expect(onSurfacePress).not.toHaveBeenCalled();

            await act(async () => {
                pin?.props.onFocus?.();
            });
            const focusedPinSurface = screen.findByTestId(`${pinTestID}-surface`);
            const focusedStyle = focusedPinSurface?.props.style;
            expect(flattenStyle(focusedStyle)).toEqual(expect.objectContaining({ borderWidth: 1 }));

            cockpitPinsState.value = ['plugin:acme.review:review-panel'];
            await screen.update(renderBar());
            const pinnedControl = screen.findByTestId(pinTestID);
            expect(pinnedControl?.props.accessibilityLabel).toBe('en:projects.actions.unpin');
            expect(pinnedControl?.props.accessibilityState?.checked).toBe(true);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('offers the transcript navigation surface as a session cockpit tab', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const pressed: string[] = [];

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
        expect(screen.getTextContent()).toContain('fr:common.tabs');
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
        expect(screen.getTextContent()).toContain('fr:common.tabs');
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
