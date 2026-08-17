import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
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
    mobileSurface: undefined as string | string[] | undefined,
    worktreeId: undefined as string | string[] | undefined,
    activeRootPath: undefined as string | string[] | undefined,
    serverId: undefined as string | string[] | undefined,
    sourceSurface: undefined as string | string[] | undefined,
}));

const authState = vi.hoisted(() => ({
    isAuthenticated: true,
}));

const tabState = vi.hoisted(() => ({
    activeTab: 'sessions' as const,
    setActiveTab: vi.fn(async () => {}),
}));

const settingsState = vi.hoisted(() => ({
    mobileWorkspaceExperienceV1: 'classic' as 'classic' | 'cockpit',
    sessionLastMobileSurfaceBySessionId: null as Record<string, string> | null,
    projectLastMobileSurfaceByWorkspaceRefId: null as Record<string, string> | null,
    embeddedTerminalDockLocation: 'sidebar' as string | null,
}));
const storageListeners = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
}));
const deviceTypeState = vi.hoisted(() => ({
    value: 'phone' as 'phone' | 'tablet' | 'desktop',
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
const featureState = vi.hoisted(() => ({
    terminalEmbeddedPtyEnabled: true,
}));
const storageMutators = vi.hoisted(() => ({
    setSessionLastMobileSurfaceBySessionId: vi.fn(),
    setProjectLastMobileSurfaceByWorkspaceRefId: vi.fn(),
    setMobileWorkspaceExperience: vi.fn(),
}));
const cockpitRegistrationState = vi.hoisted(() => ({
    registration: null as null | {
        sessionId: string;
        activeSurface: string;
        terminalTabAvailable: boolean;
        openDetailsTabCount: number;
        switchSurface: ReturnType<typeof vi.fn>;
    },
    setBottomChromeHeight: vi.fn(),
    dismissingSessionId: null as string | null,
}));
const cockpitRegistrationListeners = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
}));
const routerState = vi.hoisted(() => ({
    back: vi.fn(),
    navigate: vi.fn(),
    replace: vi.fn(),
}));
const animatedTimingState = vi.hoisted(() => ({
    timings: [] as Array<{
        start: ReturnType<typeof vi.fn>;
        stop: ReturnType<typeof vi.fn>;
        toValue: number;
        finish: (finished?: boolean) => void;
    }>,
}));

const expoRouterMock = createExpoRouterMock({
    pathname: () => pathState.pathname,
    params: () => ({
        mobileSurface: searchParamsState.mobileSurface,
        worktreeId: searchParamsState.worktreeId,
        activeRootPath: searchParamsState.activeRootPath,
        serverId: searchParamsState.serverId,
        sourceSurface: searchParamsState.sourceSurface,
    }),
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

vi.mock('./MainAppTabStateProvider', () => ({
    useMainAppTabState: () => tabState,
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
        if (key === 'projectLastMobileSurfaceByWorkspaceRefId') {
            return [
                settingsState.projectLastMobileSurfaceByWorkspaceRefId,
                (value: Record<string, string> | null) => {
                    settingsState.projectLastMobileSurfaceByWorkspaceRefId = value;
                    storageMutators.setProjectLastMobileSurfaceByWorkspaceRefId(value);
                    notifyStorageListeners();
                },
            ];
        }
        return [null, vi.fn()];
    },
    useSessionLastMobileSurface: (sessionId: string | null) => React.useSyncExternalStore(
        (listener) => {
            storageListeners.listeners.add(listener);
            return () => {
                storageListeners.listeners.delete(listener);
            };
        },
        () => sessionId ? settingsState.sessionLastMobileSurfaceBySessionId?.[sessionId] ?? null : null,
        () => sessionId ? settingsState.sessionLastMobileSurfaceBySessionId?.[sessionId] ?? null : null,
    ),
    usePersistSessionLastMobileSurface: () => (sessionId: string, surface: string) => {
        settingsState.sessionLastMobileSurfaceBySessionId = {
            ...(settingsState.sessionLastMobileSurfaceBySessionId ?? {}),
            [sessionId]: surface,
        };
        storageMutators.setSessionLastMobileSurfaceBySessionId(settingsState.sessionLastMobileSurfaceBySessionId);
        notifyStorageListeners();
    },
    useProjectLastMobileSurface: (workspaceRefId: string | null) => React.useSyncExternalStore(
        (listener) => {
            storageListeners.listeners.add(listener);
            return () => {
                storageListeners.listeners.delete(listener);
            };
        },
        () => workspaceRefId ? settingsState.projectLastMobileSurfaceByWorkspaceRefId?.[workspaceRefId] ?? null : null,
        () => workspaceRefId ? settingsState.projectLastMobileSurfaceByWorkspaceRefId?.[workspaceRefId] ?? null : null,
    ),
    usePersistProjectLastMobileSurface: () => (workspaceRefId: string, surface: string) => {
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = {
            ...(settingsState.projectLastMobileSurfaceByWorkspaceRefId ?? {}),
            [workspaceRefId]: surface,
        };
        storageMutators.setProjectLastMobileSurfaceByWorkspaceRefId(settingsState.projectLastMobileSurfaceByWorkspaceRefId);
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

vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    useSessionCockpitChromeRegistration: () => React.useSyncExternalStore(
        (listener) => {
            cockpitRegistrationListeners.listeners.add(listener);
            return () => cockpitRegistrationListeners.listeners.delete(listener);
        },
        () => cockpitRegistrationState.registration,
        () => cockpitRegistrationState.registration,
    ),
    useSessionCockpitBottomChromeHeightSetter: () => cockpitRegistrationState.setBottomChromeHeight,
    useSessionCockpitDismissingSessionId: () => cockpitRegistrationState.dismissingSessionId ?? null,
}));

function readSettingValue(key: string): unknown {
    if (key === 'mobileWorkspaceExperienceV1') {
        return settingsState.mobileWorkspaceExperienceV1;
    }
    return null;
}

function readLocalSettingValue(key: string): unknown {
    if (key === 'mobileWorkspaceExperienceV1') {
        throw new Error('mobileWorkspaceExperienceV1 must use synced account settings');
    }
    if (key === 'sessionLastMobileSurfaceBySessionId') {
        return settingsState.sessionLastMobileSurfaceBySessionId;
    }
    if (key === 'projectLastMobileSurfaceByWorkspaceRefId') {
        return settingsState.projectLastMobileSurfaceByWorkspaceRefId;
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

function notifyCockpitRegistrationListeners(): void {
    for (const listener of cockpitRegistrationListeners.listeners) {
        listener();
    }
}

function flattenTestStyle(style: unknown): Record<string, unknown> {
    const flattened: Record<string, unknown> = {};
    const visit = (value: unknown) => {
        if (!value) {
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item);
            }
            return;
        }
        if (typeof value === 'object') {
            Object.assign(flattened, value as Record<string, unknown>);
        }
    };
    visit(style);
    return flattened;
}

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeState.value,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => keyboardHeightState.value,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'terminal.embeddedPty') {
            return featureState.terminalEmbeddedPtyEnabled;
        }
        return false;
    },
}));

vi.mock('./bars/MainAppTabBar', () => ({
    MainAppTabBar: (props: Record<string, unknown>) => React.createElement('MainAppTabBar', props),
}));

vi.mock('./bars/SessionCockpitTabBar', () => ({
    SessionCockpitTabBar: (props: Record<string, unknown>) => React.createElement('SessionCockpitTabBar', props),
}));

vi.mock('./bars/ProjectCockpitTabBar', () => ({
    ProjectCockpitTabBar: (props: Record<string, unknown>) => React.createElement('ProjectCockpitTabBar', props),
}));

describe('MobileBottomChromeHost', () => {
    afterEach(() => {
        routerState.replace.mockReset();
        routerState.navigate.mockReset();
        routerState.back.mockReset();
        storageMutators.setSessionLastMobileSurfaceBySessionId.mockReset();
        storageMutators.setProjectLastMobileSurfaceByWorkspaceRefId.mockReset();
        storageMutators.setMobileWorkspaceExperience.mockReset();
        cockpitRegistrationState.registration = null;
        cockpitRegistrationListeners.listeners.clear();
        cockpitRegistrationState.setBottomChromeHeight.mockReset();
        animatedTimingState.timings = [];
        storageListeners.listeners.clear();
        pathListeners.listeners.clear();
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        tabState.activeTab = 'sessions';
        tabState.setActiveTab.mockReset();
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;
        searchParamsState.activeRootPath = undefined;
        searchParamsState.serverId = undefined;
        searchParamsState.sourceSurface = undefined;
        keyboardHeightState.value = 0;
        gestureHandlerState.gestures = [];
        cockpitRegistrationState.dismissingSessionId = null;
    });

    it('renders the main app tab bar on the authenticated home route', async () => {
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('MainAppTabBar' as never);
        expect(bar.props.activeTab).toBe('sessions');
    });

    it('reports the rendered bottom chrome height to the session cockpit registry', async () => {
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);
        const layoutView = screen.tree.findAllByType('View' as never)
            .find((node) => typeof node.props.onLayout === 'function');

        expect(layoutView).toBeTruthy();
        await act(async () => {
            layoutView?.props.onLayout({ nativeEvent: { layout: { height: 42.2 } } });
        });

        expect(cockpitRegistrationState.setBottomChromeHeight).toHaveBeenCalledWith(42.2);
    });

    it('ignores a press on the already selected main app tab', async () => {
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        deviceTypeState.value = 'phone';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('MainAppTabBar' as never);
        act(() => {
            void bar.props.onTabPress('sessions');
        });

        expect(tabState.setActiveTab).not.toHaveBeenCalled();
        expect(routerState.navigate).not.toHaveBeenCalled();
        expect(routerState.replace).not.toHaveBeenCalled();
    });

    it('renders the main app tab bar on route-owned settings surfaces', async () => {
        pathState.pathname = '/settings/session';
        authState.isAuthenticated = true;
        tabState.activeTab = 'sessions';
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        deviceTypeState.value = 'phone';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('MainAppTabBar' as never);
        expect(bar.props.activeTab).toBe('settings');
    });

    it('navigates from route-owned settings surfaces back to state-owned main tabs', async () => {
        pathState.pathname = '/settings/session';
        authState.isAuthenticated = true;
        tabState.activeTab = 'sessions';
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        deviceTypeState.value = 'phone';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('MainAppTabBar' as never);
        act(() => {
            void bar.props.onTabPress('sessions');
        });

        expect(tabState.setActiveTab).toHaveBeenCalledWith('sessions');
        expect(routerState.navigate).toHaveBeenCalledWith('/');
        expect(routerState.replace).not.toHaveBeenCalled();
    });

    it('returns to the last routed settings surface after switching away through the main tab bar', async () => {
        pathState.pathname = '/settings/session';
        authState.isAuthenticated = true;
        tabState.activeTab = 'sessions';
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        deviceTypeState.value = 'phone';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const settingsBar = screen.tree.findByType('MainAppTabBar' as never);
        act(() => {
            void settingsBar.props.onTabPress('sessions');
        });

        expect(routerState.navigate).toHaveBeenCalledWith('/');

        pathState.pathname = '/';
        tabState.activeTab = 'sessions';
        await act(async () => {
            notifyPathListeners();
        });

        routerState.navigate.mockClear();
        tabState.setActiveTab.mockClear();

        const sessionsBar = screen.tree.findByType('MainAppTabBar' as never);
        act(() => {
            void sessionsBar.props.onTabPress('settings');
        });

        expect(routerState.navigate).toHaveBeenCalledWith('/settings/session');
        expect(tabState.setActiveTab).not.toHaveBeenCalled();
        expect(routerState.replace).not.toHaveBeenCalled();
    });

    it('resets route-owned settings to settings home when the selected settings tab is pressed again', async () => {
        pathState.pathname = '/settings/session';
        authState.isAuthenticated = true;
        tabState.activeTab = 'sessions';
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        deviceTypeState.value = 'phone';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('MainAppTabBar' as never);
        act(() => {
            void bar.props.onTabPress('settings');
        });

        expect(routerState.navigate).toHaveBeenCalledWith('/settings');
        expect(tabState.setActiveTab).not.toHaveBeenCalled();
        expect(routerState.replace).not.toHaveBeenCalled();
    });

    it('does not render the main app tab bar on desktop even on the authenticated home route', async () => {
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'desktop';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(0);
    });

    it('renders the session cockpit bar on cockpit-enabled session routes', async () => {
        pathState.pathname = '/session/session-1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.sessionId).toBe('session-1');
        expect(bar.props.activeSurface).toBe('browse');
        expect(bar.props.terminalTabAvailable).toBe(true);
    });

    it('renders registered session cockpit chrome when the current session path is not a modeled surface route', async () => {
        pathState.pathname = '/session/session-1/file/src%2Findex.ts';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;
        cockpitRegistrationState.registration = {
            sessionId: 'session-1',
            activeSurface: 'browse',
            terminalTabAvailable: true,
            openDetailsTabCount: 2,
            switchSurface: vi.fn(),
        };

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.sessionId).toBe('session-1');
        expect(bar.props.activeSurface).toBe('browse');
        expect(bar.props.openDetailsTabCount).toBe(2);
    });

    it('shows session cockpit chrome when cockpit mode is enabled while already viewing a session', async () => {
        pathState.pathname = '/session/session-1';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);

        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        await act(async () => {
            notifyStorageListeners();
        });

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.sessionId).toBe('session-1');
        expect(bar.props.activeSurface).toBe('chat');
    });

    it('does not render session cockpit chrome for session history routes', async () => {
        pathState.pathname = '/session/archived';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(0);
    });

    it('renders the project cockpit bar on cockpit-enabled project routes', async () => {
        pathState.pathname = '/projects/wr_1/git';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('ProjectCockpitTabBar' as never);
        expect(bar.props.workspaceRefId).toBe('wr_1');
        expect(bar.props.activeSurface).toBe('git');
    });

    it('keeps main app bottom chrome mounted while the software keyboard is visible on phone', async () => {
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        keyboardHeightState.value = 280;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(1);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(0);
    });

    it('keeps session cockpit bottom chrome mounted while the software keyboard is visible on phone', async () => {
        pathState.pathname = '/session/session-1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        keyboardHeightState.value = 280;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);
        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(0);
    });

    it('keeps project cockpit bottom chrome mounted while the software keyboard is visible on phone', async () => {
        pathState.pathname = '/projects/wr_1/git';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        keyboardHeightState.value = 280;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(1);
    });

    it('hides bottom chrome on non-home routes', async () => {
        pathState.pathname = '/session/s_123';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(0);
    });

    it('passes terminal availability through to the session cockpit bar', async () => {
        pathState.pathname = '/session/session-1';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'bottom';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = false;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.terminalTabAvailable).toBe(false);
    });

    it('persists the selected session cockpit surface before navigating', async () => {
        pathState.pathname = '/session/session-1';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'terminal' };
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('chat');
        });

        expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({
            'session-1': 'chat',
        });
        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1?mobileSurface=chat');
    });

    it('canonicalizes legacy session fullscreen routes even when the navigator bridge is ready', async () => {
        const switchSurface = vi.fn();
        pathState.pathname = '/session/session-1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        cockpitRegistrationState.registration = {
            sessionId: 'session-1',
            activeSurface: 'browse',
            terminalTabAvailable: true,
            openDetailsTabCount: 0,
            switchSurface,
        };

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('git');
        });

        expect(switchSurface).toHaveBeenCalledWith('git');
        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1/git');
    });

    it('updates the outer route hint when the registered nested navigator reports a Back-selected surface', async () => {
        pathState.pathname = '/session/session-1/git';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        cockpitRegistrationState.registration = {
            sessionId: 'session-1',
            activeSurface: 'git',
            terminalTabAvailable: true,
            openDetailsTabCount: 0,
            switchSurface: vi.fn(),
        };

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);
        expect(routerState.replace).not.toHaveBeenCalled();

        const priorRegistration = cockpitRegistrationState.registration;
        if (!priorRegistration) {
            throw new Error('test fixture must retain the initial cockpit registration');
        }
        cockpitRegistrationState.registration = {
            ...priorRegistration,
            activeSurface: 'chat',
        };
        await act(async () => {
            notifyCockpitRegistrationListeners();
        });

        expect(screen.tree.findByType('SessionCockpitTabBar' as never).props.activeSurface).toBe('chat');
        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1?mobileSurface=chat');
    });

    it('keeps session cockpit chrome mounted when a tab press has incidental vertical movement', async () => {
        pathState.pathname = '/session/session-1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('git');
            for (const gesture of gestureHandlerState.gestures) {
                gesture.handlers.onEnd?.({ translationY: 42, velocityY: 0 });
            }
        });

        expect(storageMutators.setMobileWorkspaceExperience).not.toHaveBeenCalledWith('classic');
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);
    });

    it('keeps both main and cockpit bars in the global host during the route swap animation', async () => {
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(1);

        pathState.pathname = '/session/session-1/files';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        await act(async () => {
            notifyStorageListeners();
        });

        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(1);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);
        expect(animatedTimingState.timings.find((timing) => timing.toValue === 1)).toBeTruthy();
    });

    it('keeps the outgoing route-swap chrome inert and below the current chrome', async () => {
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        pathState.pathname = '/session/session-1/files';
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        await act(async () => {
            notifyStorageListeners();
        });

        const outgoingChrome = screen.tree.findAllByType('AnimatedView' as never)
            .find((node) => node.findAllByType('MainAppTabBar' as never).length > 0);
        expect(outgoingChrome).toBeTruthy();
        expect(outgoingChrome?.props.pointerEvents).toBe('none');
        expect(outgoingChrome?.props.accessibilityElementsHidden).toBe(true);
        expect(outgoingChrome?.props.importantForAccessibility).toBe('no-hide-descendants');
        expect(flattenTestStyle(outgoingChrome?.props.style)).toMatchObject({
            pointerEvents: 'none',
            zIndex: 0,
        });

        const currentChromeWrapper = screen.tree.findAllByType('View' as never)
            .find((node) => (
                node.findAllByType('SessionCockpitTabBar' as never).length === 1
                && node.findAllByType('MainAppTabBar' as never).length === 0
            ));
        expect(currentChromeWrapper).toBeTruthy();
        expect(flattenTestStyle(currentChromeWrapper?.props.style)).toMatchObject({
            position: 'relative',
            zIndex: 1,
        });
    });

    it('shows the target main app chrome immediately when returning from a session cockpit route', async () => {
        pathState.pathname = '/session/session-1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);

        pathState.pathname = '/';
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        await act(async () => {
            notifyStorageListeners();
        });

        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);
        const bar = screen.tree.findByType('MainAppTabBar' as never);
        expect(bar.props.activeTab).toBe('sessions');
    });

    it('preserves the scoped server id when navigating between session cockpit tabs', async () => {
        pathState.pathname = '/session/session-1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;
        searchParamsState.serverId = 'server-b';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('git');
        });

        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1/git?serverId=server-b');
    });

    it('falls back to direct route replacement from sourced details when the navigator bridge is not ready', async () => {
        vi.useFakeTimers();
        try {
            pathState.pathname = '/session/session-1/details';
            authState.isAuthenticated = true;
            settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
            settingsState.sessionLastMobileSurfaceBySessionId = null;
            settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
            settingsState.embeddedTerminalDockLocation = 'sidebar';
            deviceTypeState.value = 'phone';
            featureState.terminalEmbeddedPtyEnabled = true;
            searchParamsState.mobileSurface = undefined;
            searchParamsState.worktreeId = undefined;
            searchParamsState.serverId = 'server-b';
            searchParamsState.sourceSurface = 'browse';

            const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
            await act(async () => {
                bar.props.onSurfacePress('git');
            });

            expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({
                'session-1': 'git',
            });
            expect(routerState.back).not.toHaveBeenCalled();
            expect(routerState.replace).toHaveBeenCalledWith('/session/session-1/git?serverId=server-b');

            await act(async () => {
                vi.runOnlyPendingTimers();
            });

            pathState.pathname = '/session/session-1/files';
            searchParamsState.sourceSurface = undefined;
            await act(async () => {
                settingsState.projectLastMobileSurfaceByWorkspaceRefId = {};
                notifyStorageListeners();
            });

            expect(routerState.replace).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('routes root session surface changes through an explicit mobile-surface hint', async () => {
        pathState.pathname = '/session/session-1/terminal';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'terminal' };
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('chat');
        });

        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1?mobileSurface=chat');
    });

    it('keeps the selected root session surface active when the route remounts with the mobile-surface hint', async () => {
        pathState.pathname = '/session/session-1';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'terminal' };
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = 'chat';
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.activeSurface).toBe('chat');
    });

    it('routes root project surface changes through an explicit mobile-surface hint', async () => {
        pathState.pathname = '/projects/wr_1/terminal';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = { wr_1: 'terminal' };
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('ProjectCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('overview');
        });

        expect(routerState.replace).toHaveBeenCalledWith('/projects/wr_1?mobileSurface=overview');
    });

    it('preserves the active root path when project cockpit tab presses happen before worktree canonicalization', async () => {
        pathState.pathname = '/projects/wr_1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = { wr_1: 'browse' };
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;
        searchParamsState.activeRootPath = '/repo/.worktrees/feature-auth';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('ProjectCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('services');
        });

        expect(routerState.replace).toHaveBeenCalledWith(
            '/projects/wr_1?activeRootPath=%2Frepo%2F.worktrees%2Ffeature-auth&mobileSurface=services',
        );
    });

    it('keeps the selected root project surface active when the route remounts with the mobile-surface hint', async () => {
        pathState.pathname = '/projects/wr_1';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = { wr_1: 'terminal' };
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = 'overview';
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('ProjectCockpitTabBar' as never);
        expect(bar.props.activeSurface).toBe('overview');
    });

    it('hides project cockpit chrome after the mobile workspace experience switches back to classic', async () => {
        pathState.pathname = '/projects/wr_1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = { wr_1: 'browse' };
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(1);

        await act(async () => {
            settingsState.mobileWorkspaceExperienceV1 = 'classic';
            notifyStorageListeners();
        });

        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(0);
    });
});
