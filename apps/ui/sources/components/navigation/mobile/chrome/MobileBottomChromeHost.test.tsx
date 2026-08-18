import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { findGestureByKind, type TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { buildSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursor';
import {
    publishSessionNavigationCursor,
    resetSessionNavigationCursorForTests,
} from '@/sync/domains/session/navigation/sessionNavigationCursorStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pathState = vi.hoisted(() => ({
    pathname: '/',
}));
const reanimatedSpringState = vi.hoisted(() => ({
    targets: [] as unknown[],
}));
const pathListeners = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
}));
const searchParamsState = vi.hoisted(() => ({
    id: undefined as string | string[] | undefined,
    mobileSurface: undefined as string | string[] | undefined,
    serverId: undefined as string | string[] | undefined,
    sourceSurface: undefined as string | string[] | undefined,
}));
const authState = vi.hoisted(() => ({
    isAuthenticated: true,
}));
const tabState = vi.hoisted(() => ({
    setActiveTab: vi.fn(async () => {}),
}));
const tabBarRenderState = vi.hoisted(() => ({
    renderSpy: vi.fn(),
}));
const settingsState = vi.hoisted(() => ({
    mobileWorkspaceExperienceV1: undefined as 'classic' | 'cockpit' | undefined,
    sessionCockpitSwipeNavigationEnabled: true as boolean,
    sessionLastMobileSurfaceBySessionId: null as Record<string, string> | null,
    embeddedTerminalDockLocation: 'sidebar' as string | null,
}));
const storageListeners = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
}));
const deviceTypeState = vi.hoisted(() => ({
    value: 'phone' as 'phone' | 'tablet' | 'desktop',
}));
const featureState = vi.hoisted(() => ({
    terminalEmbeddedPtyEnabled: true,
    terminalEmbeddedPtyServerId: null as string | null,
    resolvedServerId: 'server-session' as string | null,
}));
const storageMutators = vi.hoisted(() => ({
    setMobileWorkspaceExperience: vi.fn(),
    setSessionLastMobileSurfaceBySessionId: vi.fn(),
}));
const routerState = vi.hoisted(() => ({
    back: vi.fn(),
    navigate: vi.fn(),
    replace: vi.fn(),
}));
const navigationState = vi.hoisted(() => ({
    canGoBack: null as boolean | null,
    goBack: vi.fn(),
}));
const animatedTimingState = vi.hoisted(() => ({
    timings: [] as Array<{
        start: ReturnType<typeof vi.fn>;
        stop: ReturnType<typeof vi.fn>;
        toValue: number;
        finish: (finished?: boolean) => void;
    }>,
}));
const keyboardHeightState = vi.hoisted(() => ({
    value: 0,
}));
const gestureHandlerState = vi.hoisted(() => ({
    gestures: [] as TestGestureChain[],
}));
const platformState = vi.hoisted(() => ({
    // The bottom-chrome band is a native-phone surface, and the lateral swipe only
    // exists there, so this suite runs as a native phone by default.
    os: 'ios' as 'ios' | 'android' | 'web',
}));
const sessionMetadataState = vi.hoisted(() => ({
    bySessionId: {} as Record<string, { name?: string } | null>,
}));
const hapticsState = vi.hoisted(() => ({
    impacts: [] as string[],
    selections: 0,
}));
const reducedMotionState = vi.hoisted(() => ({
    value: false,
}));

const expoRouterMock = createExpoRouterMock({
    pathname: () => pathState.pathname,
    params: () => ({
        id: searchParamsState.id,
        mobileSurface: searchParamsState.mobileSurface,
        serverId: searchParamsState.serverId,
        sourceSurface: searchParamsState.sourceSurface,
    }),
    navigation: {
        canGoBack: () => navigationState.canGoBack,
        goBack: () => navigationState.goBack(),
    },
    router: {
        back: () => routerState.back(),
        navigate: (value: unknown) => routerState.navigate(value),
        replace: (value: unknown) => routerState.replace(value),
    },
});

const expoRouterModule = {
    ...expoRouterMock.module,
    usePathname: () => React.useSyncExternalStore(
        (listener) => {
            pathListeners.listeners.add(listener);
            return () => {
                pathListeners.listeners.delete(listener);
            };
        },
        () => pathState.pathname,
        () => pathState.pathname,
    ),
};

vi.mock('expo-router', () => expoRouterModule);

vi.mock('react-native', async () => {
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
            timing: vi.fn((_value: unknown, config: { toValue: number }) => {
                let complete: ((result: { finished: boolean }) => void) | undefined;
                const timing = {
                    toValue: config.toValue,
                    start: vi.fn((callback?: (result: { finished: boolean }) => void) => {
                        complete = callback;
                    }),
                    stop: vi.fn(),
                    finish: (finished = true) => {
                        complete?.({ finished });
                    },
                };
                animatedTimingState.timings.push(timing);
                return timing;
            }),
            View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
        },
        View: ({ children, ...props }: any) => React.createElement('View', props, children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (values: Record<string, unknown>) => values[platformState.os] ?? values.native ?? values.default,
        },
    });
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock({
        onGestureCreated: (gesture) => {
            gestureHandlerState.gestures.push(gesture);
        },
    });
});

// Reanimated animations run on the UI thread and are opaque to a node test; the shared
// stub collapses `withSpring` to identity, which cannot tell an animated return to rest
// from a snap. Recording the targets keeps that one distinction observable.
vi.mock('react-native-reanimated', async () => {
    const actual = await import('@/dev/reactNativeReanimatedStub');
    return {
        ...actual,
        withSpring: <T,>(value: T): T => {
            reanimatedSpringState.targets.push(value);
            return value;
        },
    };
});

vi.mock('expo-haptics', () => ({
    ImpactFeedbackStyle: { Light: 'light' },
    NotificationFeedbackType: { Error: 'error' },
    impactAsync: (style: string) => {
        hapticsState.impacts.push(style);
        return Promise.resolve();
    },
    notificationAsync: () => Promise.resolve(),
    selectionAsync: () => {
        hapticsState.selections += 1;
        return Promise.resolve();
    },
}));

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
    getCurrentAuth: () => null,
}));

vi.mock('@/hooks/ui/useTabState', () => ({
    useTabState: () => tabState,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeState.value,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string, scope?: { scopeKind?: string; serverId?: string | null }) => {
        if (featureId === 'terminal.embeddedPty') {
            return featureState.terminalEmbeddedPtyEnabled
                && (
                    featureState.terminalEmbeddedPtyServerId == null
                    || (scope?.scopeKind === 'spawn' && scope.serverId === featureState.terminalEmbeddedPtyServerId)
                );
        }
        return false;
    },
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.value,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => keyboardHeightState.value,
}));

vi.mock('@/components/ui/navigation/TabBar', () => ({
    TabBar: (props: Record<string, unknown>) => {
        tabBarRenderState.renderSpy(props);
        return React.createElement('TabBar', props);
    },
}));

vi.mock('./bars/SessionCockpitTabBar', () => ({
    SessionCockpitTabBar: (props: Record<string, unknown>) => React.createElement('SessionCockpitTabBar', props),
}));

// The picker's own surface (rows, scrim, dissolve) is asserted in its own suite; here it
// stands in for "the host mounted the second axis", which is a placement decision.
vi.mock('./lateralSwipe/SessionCockpitLateralPicker', () => ({
    SessionCockpitLateralPicker: () => React.createElement('SessionCockpitLateralPicker'),
}));

const storageMock = createStorageModuleStub({
    useSetting: (key: string) => React.useSyncExternalStore(
        (listener) => {
            storageListeners.listeners.add(listener);
            return () => {
                storageListeners.listeners.delete(listener);
            };
        },
        () => readSettingValue(key),
        () => readSettingValue(key),
    ),
    useLocalSetting: (key: string) => React.useSyncExternalStore(
        (listener) => {
            storageListeners.listeners.add(listener);
            return () => {
                storageListeners.listeners.delete(listener);
            };
        },
        () => readLocalSettingValue(key),
        () => readLocalSettingValue(key),
    ),
    useLocalSettingMutable: (key: string) => {
        if (key === 'sessionLastMobileSurfaceBySessionId') {
            return [
                settingsState.sessionLastMobileSurfaceBySessionId,
                (value: Record<string, string> | null) => {
                    settingsState.sessionLastMobileSurfaceBySessionId = value;
                    storageMutators.setSessionLastMobileSurfaceBySessionId(value);
                    notifyStorageListeners();
                },
            ];
        }
        return [null, vi.fn()];
    },
    useSessionMetadata: (sessionId: string) => sessionMetadataState.bySessionId[sessionId] ?? null,
    useSessionLastMobileSurface: (sessionId: string | null) => {
        if (!sessionId) return null;
        return settingsState.sessionLastMobileSurfaceBySessionId?.[sessionId] ?? null;
    },
    usePersistSessionLastMobileSurface: () => (sessionId: string, surface: string) => {
        const nextValue = {
            ...(settingsState.sessionLastMobileSurfaceBySessionId ?? {}),
            [sessionId]: surface,
        };
        settingsState.sessionLastMobileSurfaceBySessionId = nextValue;
        storageMutators.setSessionLastMobileSurfaceBySessionId(nextValue);
        notifyStorageListeners();
    },
    useSettingMutable: (key: string) => {
        if (key === 'mobileWorkspaceExperienceV1') {
            return [
                settingsState.mobileWorkspaceExperienceV1,
                (value: 'classic' | 'cockpit') => {
                    settingsState.mobileWorkspaceExperienceV1 = value;
                    storageMutators.setMobileWorkspaceExperience(value);
                    notifyStorageListeners();
                },
            ];
        }
        return [readSettingValue(key), vi.fn()];
    },
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => featureState.resolvedServerId,
}));

function readSettingValue(key: string): unknown {
    if (key === 'mobileWorkspaceExperienceV1') {
        return settingsState.mobileWorkspaceExperienceV1;
    }
    if (key === 'sessionCockpitSwipeNavigationEnabled') {
        return settingsState.sessionCockpitSwipeNavigationEnabled;
    }
    return null;
}

function readLocalSettingValue(key: string): unknown {
    if (key === 'sessionLastMobileSurfaceBySessionId') {
        return settingsState.sessionLastMobileSurfaceBySessionId;
    }
    if (key === 'embeddedTerminalDockLocation') {
        return settingsState.embeddedTerminalDockLocation;
    }
    return null;
}

function notifyStorageListeners(): void {
    for (const listener of storageListeners.listeners) {
        listener();
    }
}

function notifyPathListeners(): void {
    for (const listener of pathListeners.listeners) {
        listener();
    }
}

/** Freezes an on-screen session order the way the list surface does when the user leaves it. */
function publishVisibleSessionOrder(sessionIds: readonly string[]): void {
    const cursor = buildSessionNavigationCursor({
        identity: { origin: 'session-list', sourceScopeKey: 'all', storageKind: 'all' },
        items: sessionIds.map((sessionId) => ({ type: 'session', session: { id: sessionId } })),
        nowMs: 1_000,
    });
    if (!cursor) throw new Error('test setup: cursor needs at least two sessions');
    publishSessionNavigationCursor(cursor);
}

function findLateralPanGesture(): TestGestureChain | null {
    for (const gesture of gestureHandlerState.gestures) {
        const pan = findGestureByKind(gesture, 'pan');
        if (pan?.__config.testId === 'session-cockpit-lateral-swipe') return pan;
    }
    return null;
}

async function renderCockpitBandOnSession(sessionId: string) {
    pathState.pathname = `/session/${sessionId}`;
    searchParamsState.id = sessionId;
    settingsState.mobileWorkspaceExperienceV1 = 'cockpit';

    const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
    return renderScreen(<MobileBottomChromeHost />);
}

describe('MobileBottomChromeHost', () => {
    afterEach(() => {
        standardCleanup();
        routerState.replace.mockReset();
        routerState.navigate.mockReset();
        routerState.back.mockReset();
        navigationState.canGoBack = null;
        navigationState.goBack.mockReset();
        animatedTimingState.timings = [];
        tabState.setActiveTab.mockReset();
        tabBarRenderState.renderSpy.mockReset();
        storageMutators.setSessionLastMobileSurfaceBySessionId.mockReset();
        storageMutators.setMobileWorkspaceExperience.mockReset();
        gestureHandlerState.gestures = [];
        storageListeners.listeners.clear();
        pathListeners.listeners.clear();
        pathState.pathname = '/';
        searchParamsState.id = undefined;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.serverId = undefined;
        searchParamsState.sourceSurface = undefined;
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = undefined;
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        settingsState.sessionCockpitSwipeNavigationEnabled = true;
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        featureState.terminalEmbeddedPtyServerId = null;
        featureState.resolvedServerId = 'server-session';
        keyboardHeightState.value = 0;
        platformState.os = 'ios';
        sessionMetadataState.bySessionId = {};
        hapticsState.impacts = [];
        hapticsState.selections = 0;
        reducedMotionState.value = false;
        resetSessionNavigationCursorForTests();
    });

    it('renders the main app tab bar on the root sessions route', async () => {
        pathState.pathname = '/';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('TabBar' as never);
        expect(bar.props.activeTab).toBe('sessions');
    });

    it('offers the new-session action beside the tab bar only on the sessions tab', async () => {
        pathState.pathname = '/';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findByType('TabBar' as never).props.trailingAccessory).toBeTruthy();

        pathState.pathname = '/settings';
        await act(async () => {
            notifyPathListeners();
        });

        expect(screen.tree.findByType('TabBar' as never).props.trailingAccessory).toBeUndefined();
    });

    it('keeps the bar mounted under an overlay route instead of tearing it down', async () => {
        pathState.pathname = '/';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);
        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(1);

        // `/new` is presented OVER the sessions list, not instead of it. Recomputing chrome for the
        // overlay route resolved "no tab, no session" and removed the bar, so closing the composer
        // had to rebuild it afterwards — which read as the bar arriving late rather than never
        // having left. Frozen, it stays mounted behind the composer and needs no re-entry at all.
        pathState.pathname = '/new';
        await act(async () => {
            notifyPathListeners();
        });

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(1);

        pathState.pathname = '/';
        await act(async () => {
            notifyPathListeners();
        });

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(1);
    });

    it('fades the bar out rather than cutting it when chrome genuinely resolves to nothing', async () => {
        pathState.pathname = '/';
        keyboardHeightState.value = 0;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);
        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(1);

        // The keyboard opening is a real teardown, not an overlay: the bar has to leave. It should
        // dissolve the way every bar-to-bar change does rather than vanish between two frames.
        keyboardHeightState.value = 320;
        await act(async () => {
            notifyPathListeners();
        });

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(1);
    });

    it('does not rerender main app tabs for cockpit-only storage updates', async () => {
        pathState.pathname = '/';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const onRender = vi.fn();
        await renderScreen(
            <React.Profiler id="mobile-bottom-chrome" onRender={onRender}>
                <MobileBottomChromeHost />
            </React.Profiler>,
        );

        expect(onRender).toHaveBeenCalledTimes(1);

        settingsState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'git' };
        await act(async () => {
            notifyStorageListeners();
        });

        expect(onRender).toHaveBeenCalledTimes(1);
    });

    it('treats the root route as the sessions tab in legacy active-tab resolution', async () => {
        const { resolveMobileBottomChromeActiveTab } = await import('./MobileBottomChromeHost');

        expect(resolveMobileBottomChromeActiveTab('/')).toBe('sessions');
    });

    it('renders the main app tab bar on authenticated routed main surfaces', async () => {
        pathState.pathname = '/settings';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('TabBar' as never);
        expect(bar.props.activeTab).toBe('settings');
    });

    it('navigates main app tab presses before tab persistence settles', async () => {
        pathState.pathname = '/settings';
        let resolvePersistence: () => void = () => {};
        const persistence = new Promise<void>((resolve) => {
            resolvePersistence = resolve;
        });
        tabState.setActiveTab.mockReturnValueOnce(persistence);

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('TabBar' as never);
        act(() => {
            void bar.props.onTabPress('sessions');
        });

        try {
            expect(tabState.setActiveTab).toHaveBeenCalledWith('sessions');
            expect(routerState.navigate).toHaveBeenCalledWith('/');
            expect(routerState.replace).not.toHaveBeenCalled();
        } finally {
            resolvePersistence();
            await act(async () => {
                await Promise.resolve();
            });
        }
    });

    it('ignores a press on the already selected main app tab', async () => {
        pathState.pathname = '/settings';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('TabBar' as never);
        act(() => {
            void bar.props.onTabPress('settings');
        });

        expect(routerState.navigate).not.toHaveBeenCalled();
        expect(routerState.replace).not.toHaveBeenCalled();
        expect(tabState.setActiveTab).not.toHaveBeenCalled();
    });

    it('resets a selected routed main app tab to its root route when reselected', async () => {
        pathState.pathname = '/settings/session';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('TabBar' as never);
        act(() => {
            void bar.props.onTabPress('settings');
        });

        expect(routerState.navigate).toHaveBeenCalledWith('/settings');
        expect(routerState.replace).not.toHaveBeenCalled();
        expect(tabState.setActiveTab).not.toHaveBeenCalled();
    });

    it('returns to the last routed settings surface after switching away through the main tab bar', async () => {
        pathState.pathname = '/settings/session';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const settingsBar = screen.tree.findByType('TabBar' as never);
        act(() => {
            void settingsBar.props.onTabPress('sessions');
        });

        expect(routerState.navigate).toHaveBeenCalledWith('/');
        expect(tabState.setActiveTab).toHaveBeenCalledWith('sessions');

        pathState.pathname = '/';
        await act(async () => {
            notifyPathListeners();
        });

        routerState.navigate.mockClear();
        tabState.setActiveTab.mockClear();

        const sessionsBar = screen.tree.findByType('TabBar' as never);
        act(() => {
            void sessionsBar.props.onTabPress('settings');
        });

        expect(routerState.navigate).toHaveBeenCalledWith('/settings/session');
        expect(tabState.setActiveTab).not.toHaveBeenCalled();
        expect(routerState.replace).not.toHaveBeenCalled();
    });

    it('does not render chrome on desktop', async () => {
        pathState.pathname = '/';
        deviceTypeState.value = 'desktop';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
    });

    it('renders session cockpit chrome from the global host on session routes', async () => {
        pathState.pathname = '/session/session-1/files';
        searchParamsState.id = 'session-1';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(0);
        const cockpitBar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(cockpitBar.props.sessionId).toBe('session-1');
        expect(cockpitBar.props.activeSurface).toBe('browse');
    });

    it('does not let the transparent full-width chrome layer intercept content outside the floating bar', async () => {
        pathState.pathname = '/session/session-1';
        searchParamsState.id = 'session-1';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const cockpitBar = screen.tree.findByType('SessionCockpitTabBar' as never);
        let currentChromeLayer = cockpitBar.parent;
        while (currentChromeLayer && String(currentChromeLayer.type) !== 'View') {
            currentChromeLayer = currentChromeLayer.parent;
        }
        expect(String(currentChromeLayer?.type)).toBe('View');
        expect(currentChromeLayer?.props.pointerEvents).toBe('box-none');
    });

    it('renders registered session cockpit chrome when the current session path is not a modeled surface route', async () => {
        pathState.pathname = '/session/session-1/file/src%2Findex.ts';
        searchParamsState.id = 'session-1';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const {
            SessionCockpitChromeRegistryProvider,
            useSessionCockpitChromeRegister,
        } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');

        function RegisteredCockpitChrome() {
            const register = useSessionCockpitChromeRegister();
            React.useEffect(() => register({
                sessionId: 'session-1',
                activeSurface: 'browse',
                terminalTabAvailable: true,
                openDetailsTabCount: 2,
                switchSurface: vi.fn(),
            }), [register]);
            return null;
        }

        const screen = await renderScreen(
            <SessionCockpitChromeRegistryProvider>
                <RegisteredCockpitChrome />
                <MobileBottomChromeHost />
            </SessionCockpitChromeRegistryProvider>,
        );

        await act(async () => {
            await Promise.resolve();
        });

        const cockpitBar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(cockpitBar.props.sessionId).toBe('session-1');
        expect(cockpitBar.props.activeSurface).toBe('browse');
        expect(cockpitBar.props.openDetailsTabCount).toBe(2);
    });

    it('shows session cockpit chrome when cockpit mode is enabled while already viewing a session', async () => {
        pathState.pathname = '/session/session-1';
        searchParamsState.id = 'session-1';
        settingsState.mobileWorkspaceExperienceV1 = 'classic';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);

        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        await act(async () => {
            notifyStorageListeners();
        });

        const cockpitBar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(cockpitBar.props.sessionId).toBe('session-1');
        expect(cockpitBar.props.activeSurface).toBe('chat');
    });

    it('falls back to route replacement for cockpit tab presses before the navigator bridge is ready', async () => {
        pathState.pathname = '/session/session-1/files';
        searchParamsState.id = 'session-1';
        searchParamsState.serverId = 'server-session';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const cockpitBar = screen.tree.findByType('SessionCockpitTabBar' as never);
        act(() => {
            cockpitBar.props.onSurfacePress('git');
        });

        expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({
            'session-1': 'git',
        });
        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1/git?serverId=server-session');
    });

    it('keeps cockpit tab switches inside the navigator bridge when it is ready', async () => {
        pathState.pathname = '/session/session-1/file/src%2Findex.ts';
        searchParamsState.id = 'session-1';
        searchParamsState.serverId = 'server-session';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        const switchSurface = vi.fn();

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const {
            SessionCockpitChromeRegistryProvider,
            useSessionCockpitChromeRegister,
        } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');

        function RegisteredCockpitChrome() {
            const register = useSessionCockpitChromeRegister();
            React.useEffect(() => register({
                sessionId: 'session-1',
                activeSurface: 'browse',
                terminalTabAvailable: true,
                openDetailsTabCount: 0,
                switchSurface,
            }), [register]);
            return null;
        }

        const screen = await renderScreen(
            <SessionCockpitChromeRegistryProvider>
                <RegisteredCockpitChrome />
                <MobileBottomChromeHost />
            </SessionCockpitChromeRegistryProvider>,
        );

        await act(async () => {
            await Promise.resolve();
        });

        const cockpitBar = screen.tree.findByType('SessionCockpitTabBar' as never);
        act(() => {
            cockpitBar.props.onSurfacePress('git');
        });

        expect(switchSurface).toHaveBeenCalledWith('git');
        expect(routerState.replace).not.toHaveBeenCalled();
    });

    it('keeps session cockpit chrome mounted when a tab press has incidental vertical movement', async () => {
        pathState.pathname = '/session/session-1/files';
        searchParamsState.id = 'session-1';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        // The band now carries a pan, so this is no longer vacuous: a vertical drag
        // that ends on the bar must leave the cockpit exactly where it was.
        expect(gestureHandlerState.gestures.length).toBeGreaterThan(0);

        const cockpitBar = screen.tree.findByType('SessionCockpitTabBar' as never);
        act(() => {
            cockpitBar.props.onSurfacePress('git');
            for (const gesture of gestureHandlerState.gestures) {
                gesture.__handlers.onEnd?.({ translationX: 0, translationY: 42, velocityX: 0, velocityY: 0 });
            }
        });

        expect(storageMutators.setMobileWorkspaceExperience).not.toHaveBeenCalledWith('classic');
        expect(routerState.navigate).not.toHaveBeenCalled();
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);
    });

    it('hides main app chrome while the software keyboard is visible', async () => {
        pathState.pathname = '/';
        keyboardHeightState.value = 260;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
    });

    it('hides session cockpit chrome while the software keyboard is visible (web has no under-keyboard layer)', async () => {
        pathState.pathname = '/session/session-1';
        searchParamsState.id = 'session-1';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        keyboardHeightState.value = 260;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
    });

    it('shows session cockpit chrome again once the software keyboard closes', async () => {
        pathState.pathname = '/session/session-1';
        searchParamsState.id = 'session-1';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        keyboardHeightState.value = 0;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(0);
        const cockpitBar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(cockpitBar.props.sessionId).toBe('session-1');
        expect(cockpitBar.props.activeSurface).toBe('chat');
    });

    it('keeps both main and cockpit bars in the global host during the route swap animation', async () => {
        vi.useFakeTimers();
        try {
            pathState.pathname = '/';

            const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(1);

            pathState.pathname = '/session/session-1';
            searchParamsState.id = 'session-1';
            await act(async () => {
                notifyPathListeners();
            });

            expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(1);
            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);
            expect(animatedTimingState.timings.find((timing) => timing.toValue === 1)).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows the target chrome immediately when returning to the sessions list', async () => {
        vi.useFakeTimers();
        try {
            pathState.pathname = '/session/session-1/files';

            const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);

            pathState.pathname = '/';
            await act(async () => {
                notifyPathListeners();
            });

            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);
            const bar = screen.tree.findByType('TabBar' as never);
            expect(bar.props.activeTab).toBe('sessions');
        } finally {
            vi.useRealTimers();
        }
    });

    describe('lateral session swipe', () => {
        it('activates only past a horizontal offset wider than the tabs own hit slop', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            await renderCockpitBandOnSession('session-1');

            const pan = findLateralPanGesture();
            expect(pan?.__config.activeOffsetX).toEqual([-12, 12]);
            // Negative insets: the system owns the screen edges (iOS interactive pop,
            // Android system back) and wins that arbitration silently.
            expect(pan?.__config.hitSlop).toEqual({ left: -50, right: 0 });
        });

        it('leaves a short drag to the tab press it actually was', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            const screen = await renderCockpitBandOnSession('session-1');

            const pan = findLateralPanGesture();
            const cockpitBar = screen.tree.findByType('SessionCockpitTabBar' as never);
            act(() => {
                pan?.__handlers.onUpdate?.({ translationX: -6, translationY: 0 });
                pan?.__handlers.onEnd?.({ translationX: -6, translationY: 0, velocityX: 0, velocityY: 0 });
                cockpitBar.props.onSurfacePress('git');
            });

            expect(routerState.navigate).not.toHaveBeenCalled();
            expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({ 'session-1': 'git' });
        });

        it('moves to the next session on a right-to-left drag past the threshold', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            await renderCockpitBandOnSession('session-1');

            const pan = findLateralPanGesture();
            await act(async () => {
                pan?.__handlers.onUpdate?.({ translationX: -90, translationY: 0 });
                pan?.__handlers.onEnd?.({ translationX: -90, translationY: 0, velocityX: -100, velocityY: 0 });
                await Promise.resolve();
            });

            expect(routerState.navigate).toHaveBeenCalledTimes(1);
            expect(String(routerState.navigate.mock.calls[0]?.[0])).toContain('/session/session-2');
            // The haptic marks the threshold crossing at release, not the end of the settle.
            expect(hapticsState.impacts).toHaveLength(1);
        });

        it('moves to the previous session on a left-to-right drag past the threshold', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            await renderCockpitBandOnSession('session-1');

            const pan = findLateralPanGesture();
            await act(async () => {
                pan?.__handlers.onEnd?.({ translationX: 90, translationY: 0, velocityX: 100, velocityY: 0 });
                await Promise.resolve();
            });

            expect(String(routerState.navigate.mock.calls[0]?.[0])).toContain('/session/session-0');
        });

        it('does not navigate when the release is below the threshold', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            await renderCockpitBandOnSession('session-1');

            const pan = findLateralPanGesture();
            await act(async () => {
                pan?.__handlers.onEnd?.({ translationX: -30, translationY: 0, velocityX: -50, velocityY: 0 });
                await Promise.resolve();
            });

            expect(routerState.navigate).not.toHaveBeenCalled();
        });

        it('does not navigate past the end of the captured order', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1']);
            await renderCockpitBandOnSession('session-1');

            const pan = findLateralPanGesture();
            await act(async () => {
                pan?.__handlers.onEnd?.({ translationX: -400, translationY: 0, velocityX: -3000, velocityY: 0 });
                await Promise.resolve();
            });

            expect(routerState.navigate).not.toHaveBeenCalled();
            // An end of the order is a rubber-band, so there is nothing to confirm.
            expect(hapticsState.impacts).toHaveLength(0);
        });

        it('does not exist while the software keyboard is up', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            keyboardHeightState.value = 260;
            await renderCockpitBandOnSession('session-1');

            expect(findLateralPanGesture()).toBeNull();
        });

        it('does not exist without a captured session order', async () => {
            await renderCockpitBandOnSession('session-1');

            expect(findLateralPanGesture()).toBeNull();
        });

        it('does not exist when the setting is off', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            settingsState.sessionCockpitSwipeNavigationEnabled = false;
            await renderCockpitBandOnSession('session-1');

            expect(findLateralPanGesture()).toBeNull();
        });

        it('does not exist on the main tabs, where content scrolls under the band', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            pathState.pathname = '/';

            const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            expect(findLateralPanGesture()).toBeNull();
            // A full-bleed hit target here would swallow taps on the list scrolling
            // under the band, which reserves no in-flow space on the main tabs.
            expect(screen.findAllHostsByTestId('session-cockpit-band-hit-target')).toHaveLength(0);
        });

        it('makes the otherwise-empty band touchable only while the swipe applies', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            const screen = await renderCockpitBandOnSession('session-1');

            expect(screen.findAllHostsByTestId('session-cockpit-band-hit-target')).toHaveLength(1);
        });

        it('does not exist on mobile web, where the browser owns horizontal edge gestures', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            platformState.os = 'web';
            await renderCockpitBandOnSession('session-1');

            expect(findLateralPanGesture()).toBeNull();
        });

        // The non-gesture equivalent is asserted in `CockpitTabBars.test.tsx`, not here.
        // It rides the cockpit tabs, because a tab is the only element in the band a
        // screen reader can focus — and this suite mocks `SessionCockpitTabBar` out, so an
        // assertion placed here would only ever prove where the props were handed over.

        it('does not dissolve the bar it is dragging when the lateral switch lands', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            const screen = await renderCockpitBandOnSession('session-1');

            const pan = findLateralPanGesture();
            await act(async () => {
                pan?.__handlers.onEnd?.({ translationX: -90, translationY: 0, velocityX: -100, velocityY: 0 });
                await Promise.resolve();
            });

            animatedTimingState.timings = [];
            pathState.pathname = '/session/session-2';
            searchParamsState.id = 'session-2';
            await act(async () => {
                notifyPathListeners();
            });

            // No cross-fade was scheduled, and only the destination bar is mounted.
            expect(animatedTimingState.timings).toHaveLength(0);
            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);
            expect(screen.tree.findByType('SessionCockpitTabBar' as never).props.sessionId).toBe('session-2');
        });

        it('settles the committed swipe inward once the destination has painted, instead of snapping it', async () => {
            publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
            await renderCockpitBandOnSession('session-1');

            const pan = findLateralPanGesture();
            await act(async () => {
                pan?.__handlers.onEnd?.({ translationX: -90, translationY: 0, velocityX: -100, velocityY: 0 });
                await Promise.resolve();
            });

            reanimatedSpringState.targets = [];
            pathState.pathname = '/session/session-2';
            searchParamsState.id = 'session-2';
            await act(async () => {
                notifyPathListeners();
            });

            // The destination mounts while progress is still at its extreme, so the
            // return to rest is animated: that inward settle is what covers the session
            // remount. A snap back to 0 here would pop the new session into place.
            expect(reanimatedSpringState.targets).toContain(0);
        });

        describe('picker', () => {
            /** Past horizontal activation, well short of the horizontal commit distance. */
            const STEER_X = -20;
            /** `translationY` is NEGATIVE upward in RNGH; 28 opens, 44 is one row. */
            const upY = (rows: number) => -(28 + rows * 44);

            it('keeps the pan alive once the finger leaves the horizontal, because the second axis is ours', async () => {
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3']);
                await renderCockpitBandOnSession('session-1');

                const pan = findLateralPanGesture();
                // Activation stays horizontal-only, so a tab tap and a vertical intent
                // behave exactly as they did before the second axis existed...
                expect(pan?.__config.activeOffsetX).toEqual([-12, 12]);
                // ...but nothing may KILL the pan on vertical travel any more: the movement
                // that opens the picker is the movement the old bound cancelled on.
                expect(pan?.__config.failOffsetY).toBeUndefined();
            });

            it('mounts the second axis exactly where the pan itself exists', async () => {
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
                const withPan = await renderCockpitBandOnSession('session-1');
                expect(withPan.tree.findAllByType('SessionCockpitLateralPicker' as never)).toHaveLength(1);

                standardCleanup();
                resetSessionNavigationCursorForTests();
                keyboardHeightState.value = 260;
                const withKeyboard = await renderCockpitBandOnSession('session-1');
                expect(withKeyboard.tree.findAllByType('SessionCockpitLateralPicker' as never)).toHaveLength(0);
            });

            it('locks NEXT from a right-to-left drag and keeps it while the finger rises', async () => {
                // The seam neither suite covered: the picker's own tests write `direction`
                // in by hand, and this one mocks the picker component out, so nothing
                // exercised real translationX sign -> the direction the rows are built from.
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4']);
                await renderCockpitBandOnSession('session-2');
                const { useSessionLateralSwipe } = await import(
                    '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'
                );
                const picker = useSessionLateralSwipe().picker;

                const pan = findLateralPanGesture();
                act(() => {
                    pan?.__handlers.onBegin?.({});
                    // Right-to-left is NEXT.
                    pan?.__handlers.onUpdate?.({ translationX: -80, translationY: 0 });
                });
                expect(picker.direction.value).toBe('next');

                act(() => {
                    // Now rise into the picker. The direction must survive the vertical.
                    pan?.__handlers.onUpdate?.({ translationX: -80, translationY: -60 });
                });
                expect(picker.direction.value).toBe('next');
                expect(picker.index.value).toBeGreaterThanOrEqual(1);
            });

            it('never opens on vertical travel alone, so a drag that was never sideways commits nothing', async () => {
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3']);
                await renderCockpitBandOnSession('session-1');

                const pan = findLateralPanGesture();
                await act(async () => {
                    pan?.__handlers.onUpdate?.({ translationX: 0, translationY: upY(3) });
                    pan?.__handlers.onEnd?.({ translationX: 0, translationY: upY(3), velocityX: 0, velocityY: -800 });
                    await Promise.resolve();
                });

                expect(routerState.navigate).not.toHaveBeenCalled();
                expect(hapticsState.selections).toBe(0);
            });

            it('scrubs the selection WITHOUT navigating, then commits it exactly once on release', async () => {
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5']);
                await renderCockpitBandOnSession('session-1');

                const pan = findLateralPanGesture();
                await act(async () => {
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: 0 });
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(0) });
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(1) });
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(2) });
                    await Promise.resolve();
                });

                // A transcript mount is ~400-500ms. Paying it per scrubbed row is what
                // would make this gesture unaffordable, so the scrub must move nothing.
                expect(routerState.navigate).not.toHaveBeenCalled();

                await act(async () => {
                    pan?.__handlers.onEnd?.({ translationX: STEER_X, translationY: upY(2), velocityX: 0, velocityY: 0 });
                    await Promise.resolve();
                });

                expect(routerState.navigate).toHaveBeenCalledTimes(1);
                // Two rows past the immediate neighbour: session-2 -> session-3 -> session-4.
                expect(String(routerState.navigate.mock.calls[0]?.[0])).toContain('/session/session-4');
            });

            it('scrubs the other way too, so the locked direction is the one the finger chose', async () => {
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4']);
                await renderCockpitBandOnSession('session-3');

                const pan = findLateralPanGesture();
                await act(async () => {
                    pan?.__handlers.onUpdate?.({ translationX: -STEER_X, translationY: 0 });
                    pan?.__handlers.onUpdate?.({ translationX: -STEER_X, translationY: upY(1) });
                    pan?.__handlers.onEnd?.({ translationX: -STEER_X, translationY: upY(1), velocityX: 0, velocityY: 0 });
                    await Promise.resolve();
                });

                expect(String(routerState.navigate.mock.calls[0]?.[0])).toContain('/session/session-1');
            });

            it('returns to the immediate neighbour when the finger drops back down', async () => {
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5']);
                await renderCockpitBandOnSession('session-1');

                const pan = findLateralPanGesture();
                await act(async () => {
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: 0 });
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(2) });
                    // ...and back down below the browse threshold, which dissolves the picker.
                    pan?.__handlers.onUpdate?.({ translationX: -90, translationY: 0 });
                    pan?.__handlers.onEnd?.({ translationX: -90, translationY: 0, velocityX: -100, velocityY: 0 });
                    await Promise.resolve();
                });

                expect(routerState.navigate).toHaveBeenCalledTimes(1);
                expect(String(routerState.navigate.mock.calls[0]?.[0])).toContain('/session/session-2');
            });

            it('ticks once per row crossed, and never for the direction lock itself', async () => {
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5']);
                await renderCockpitBandOnSession('session-1');

                const pan = findLateralPanGesture();
                await act(async () => {
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: 0 });
                    await Promise.resolve();
                });
                // Arming the horizontal step is not a selection change; the shipped gesture
                // has no haptic here and must not grow one.
                expect(hapticsState.selections).toBe(0);

                await act(async () => {
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(0.5) });
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(1) });
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(1.5) });
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(2) });
                    await Promise.resolve();
                });

                // Two rows crossed, two ticks — not one per frame.
                expect(hapticsState.selections).toBe(2);
            });

            it('commits nothing when the system claims the gesture mid-scrub', async () => {
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4']);
                await renderCockpitBandOnSession('session-1');

                const pan = findLateralPanGesture();
                await act(async () => {
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(2) });
                    // Android claims its edge strips after the app has already seen the
                    // touch down, and RNGH reports that as an unsuccessful end.
                    pan?.__handlers.onEnd?.({ translationX: STEER_X, translationY: upY(2), velocityX: 0, velocityY: 0 }, false);
                    await Promise.resolve();
                });

                expect(routerState.navigate).not.toHaveBeenCalled();
                expect(hapticsState.impacts).toHaveLength(0);
            });

            it('still selects and commits under reduced motion', async () => {
                reducedMotionState.value = true;
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5']);
                await renderCockpitBandOnSession('session-1');

                const pan = findLateralPanGesture();
                await act(async () => {
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(2) });
                    pan?.__handlers.onEnd?.({ translationX: STEER_X, translationY: upY(2), velocityX: 0, velocityY: 0 });
                    await Promise.resolve();
                });

                // Reduced motion removes travel, never the capability.
                expect(String(routerState.navigate.mock.calls[0]?.[0])).toContain('/session/session-4');
            });

            it('clamps the selection at the last session that way rather than overshooting it', async () => {
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2', 'session-3']);
                await renderCockpitBandOnSession('session-1');

                const pan = findLateralPanGesture();
                await act(async () => {
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(5) });
                    pan?.__handlers.onEnd?.({ translationX: STEER_X, translationY: upY(5), velocityX: 0, velocityY: 0 });
                    await Promise.resolve();
                });

                // Two sessions that way; five rows of finger travel still lands the last.
                expect(routerState.navigate).toHaveBeenCalledTimes(1);
                expect(String(routerState.navigate.mock.calls[0]?.[0])).toContain('/session/session-3');
            });

            it('keeps the picker shut when there is nothing to pick between, so the horizontal rule still decides', async () => {
                publishVisibleSessionOrder(['session-0', 'session-1', 'session-2']);
                await renderCockpitBandOnSession('session-1');

                const pan = findLateralPanGesture();
                await act(async () => {
                    // A long lift over a short sideways drag: with one session that way
                    // there is no list, so this is still a below-threshold release.
                    pan?.__handlers.onUpdate?.({ translationX: STEER_X, translationY: upY(4) });
                    pan?.__handlers.onEnd?.({ translationX: STEER_X, translationY: upY(4), velocityX: 0, velocityY: 0 });
                    await Promise.resolve();
                });

                expect(routerState.navigate).not.toHaveBeenCalled();
                expect(hapticsState.selections).toBe(0);
            });
        });
    });

    it('does not schedule chrome animations while switching within main app tabs', async () => {
        pathState.pathname = '/settings';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        pathState.pathname = '/friends';
        await act(async () => {
            notifyPathListeners();
        });

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(1);
        expect(animatedTimingState.timings).toHaveLength(0);
    });
});
