import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pathState = vi.hoisted(() => ({
    pathname: '/',
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
    gestures: [] as Array<{
        kind: string;
        config: Record<string, unknown>;
        handlers: {
            onEnd?: (event: { translationY: number; velocityY: number }) => void;
        };
    }>,
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
        Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
    });
});

vi.mock('react-native-gesture-handler', () => {
    function createGesture(kind: string) {
        const gesture = {
            kind,
            config: {} as Record<string, unknown>,
            handlers: {} as {
                onEnd?: (event: { translationY: number; velocityY: number }) => void;
            },
            minDistance(value: number) {
                gesture.config.minDistance = value;
                return gesture;
            },
            activeOffsetY(value: readonly [number, number]) {
                gesture.config.activeOffsetY = value;
                return gesture;
            },
            onEnd(handler: (event: { translationY: number; velocityY: number }) => void) {
                gesture.handlers.onEnd = handler;
                return gesture;
            },
        };
        gestureHandlerState.gestures.push(gesture);
        return gesture;
    }

    return {
        Gesture: {
            Pan: () => createGesture('pan'),
        },
        GestureDetector: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('GestureDetector', props, props.children),
    };
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
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
    useReducedMotionPreference: () => false,
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
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        featureState.terminalEmbeddedPtyServerId = null;
        featureState.resolvedServerId = 'server-session';
        keyboardHeightState.value = 0;
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

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const cockpitBar = screen.tree.findByType('SessionCockpitTabBar' as never);
        act(() => {
            cockpitBar.props.onSurfacePress('git');
            for (const gesture of gestureHandlerState.gestures) {
                gesture.handlers.onEnd?.({ translationY: 42, velocityY: 0 });
            }
        });

        expect(storageMutators.setMobileWorkspaceExperience).not.toHaveBeenCalledWith('classic');
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

    it('keeps session cockpit chrome mounted while the software keyboard is visible', async () => {
        pathState.pathname = '/session/session-1';
        searchParamsState.id = 'session-1';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        keyboardHeightState.value = 260;

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
