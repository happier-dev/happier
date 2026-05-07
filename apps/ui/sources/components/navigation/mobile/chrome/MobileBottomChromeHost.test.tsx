import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { clearPendingMobileSurfaceTransition } from '@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pathState = vi.hoisted(() => ({
    pathname: '/',
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
    setSessionLastMobileSurfaceBySessionId: vi.fn(),
}));
const routerState = vi.hoisted(() => ({
    back: vi.fn(),
    replace: vi.fn(),
}));
const navigationState = vi.hoisted(() => ({
    canGoBack: null as boolean | null,
    goBack: vi.fn(),
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
        replace: (value: unknown) => routerState.replace(value),
    },
});

vi.mock('expo-router', () => expoRouterMock.module);

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
            timing: vi.fn(() => ({
                start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }),
            })),
            View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
        },
        View: ({ children, ...props }: any) => React.createElement('View', props, children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default },
    });
});

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

vi.mock('@/components/ui/navigation/TabBar', () => ({
    TabBar: (props: Record<string, unknown>) => React.createElement('TabBar', props),
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

describe('MobileBottomChromeHost', () => {
    afterEach(() => {
        clearPendingMobileSurfaceTransition();
        standardCleanup();
        routerState.replace.mockReset();
        routerState.back.mockReset();
        navigationState.canGoBack = null;
        navigationState.goBack.mockReset();
        tabState.setActiveTab.mockReset();
        storageMutators.setSessionLastMobileSurfaceBySessionId.mockReset();
        storageListeners.listeners.clear();
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
    });

    it('renders the animated main app tab bar on the root sessions route', async () => {
        pathState.pathname = '/';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const animatedChrome = screen.tree.findByType('AnimatedView' as never);
        const bar = screen.tree.findByType('TabBar' as never);
        expect(animatedChrome).toBeTruthy();
        expect(bar.props.activeTab).toBe('sessions');
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

    it('routes main app tab presses before tab persistence settles', async () => {
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
            const {
                resolvePendingMobileSurfaceTransitionStackOptions,
            } = await import('@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent');
            expect(tabState.setActiveTab).toHaveBeenCalledWith('sessions');
            expect(routerState.replace).toHaveBeenCalledWith('/');
            expect(resolvePendingMobileSurfaceTransitionStackOptions({
                routeName: 'index',
            })).toEqual({
                animation: 'slide_from_left',
                animationTypeForReplace: 'pop',
            });
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

        expect(routerState.replace).not.toHaveBeenCalled();
        expect(tabState.setActiveTab).not.toHaveBeenCalled();
    });

    it('ignores a press on a selected main app tab while on a nested tab route', async () => {
        pathState.pathname = '/settings/session';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('TabBar' as never);
        act(() => {
            void bar.props.onTabPress('settings');
        });

        expect(routerState.replace).not.toHaveBeenCalled();
        expect(tabState.setActiveTab).not.toHaveBeenCalled();
    });

    it('does not render chrome on desktop', async () => {
        pathState.pathname = '/';
        deviceTypeState.value = 'desktop';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
    });

    it('renders the session cockpit bar by default on phone session routes', async () => {
        pathState.pathname = '/session/session-1/files';
        searchParamsState.id = 'session-1';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.sessionId).toBe('session-1');
        expect(bar.props.activeSurface).toBe('browse');
        expect(bar.props.terminalTabAvailable).toBe(true);
    });

    it('keeps the terminal tab available when the dock setting is missing', async () => {
        pathState.pathname = '/session/session-1/files';
        searchParamsState.id = 'session-1';
        settingsState.embeddedTerminalDockLocation = null;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.terminalTabAvailable).toBe(true);
    });

    it('keeps the cockpit terminal tab available when the viewed session server enables terminal', async () => {
        pathState.pathname = '/session/session-1/files';
        searchParamsState.serverId = 'server-b';
        featureState.terminalEmbeddedPtyServerId = 'server-b';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.terminalTabAvailable).toBe(true);
    });

    it('hides session cockpit chrome when classic mode is explicitly selected', async () => {
        pathState.pathname = '/session/session-1/files';
        searchParamsState.id = 'session-1';
        settingsState.mobileWorkspaceExperienceV1 = 'classic';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
    });

    it('persists selected session cockpit surface and preserves server scope before navigating', async () => {
        pathState.pathname = '/session/session-1';
        searchParamsState.id = 'session-1';
        searchParamsState.serverId = 'server-a';
        settingsState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'terminal' };

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('git');
        });

        const {
            resolvePendingMobileSurfaceTransitionStackOptions,
        } = await import('@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent');
        expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({
            'session-1': 'git',
        });
        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1/git?serverId=server-a');
        expect(resolvePendingMobileSurfaceTransitionStackOptions({
            routeName: 'session/[id]/git',
        })).toEqual({
            animation: 'slide_from_right',
            animationTypeForReplace: 'push',
        });
    });

    it('waits for the sourced details route to collapse before persisting and replacing its source surface', async () => {
        vi.useFakeTimers();
        try {
            pathState.pathname = '/session/session-1/details';
            searchParamsState.id = 'session-1';
            searchParamsState.serverId = 'server-a';
            searchParamsState.sourceSurface = 'browse';
            settingsState.sessionLastMobileSurfaceBySessionId = {
                'session-1': 'browse',
                'session-2': 'chat',
            };

            const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
            await act(async () => {
                bar.props.onSurfacePress('git');
            });

            const {
                resolvePendingMobileSurfaceTransitionStackOptions,
            } = await import('@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent');
            expect(storageMutators.setSessionLastMobileSurfaceBySessionId).not.toHaveBeenCalled();
            expect(routerState.back).toHaveBeenCalledTimes(1);
            expect(routerState.replace).not.toHaveBeenCalled();
            expect(resolvePendingMobileSurfaceTransitionStackOptions({
                routeName: 'session/[id]/git',
            })).toEqual({
                animation: 'slide_from_left',
                animationTypeForReplace: 'pop',
            });

            await act(async () => {
                vi.advanceTimersByTime(99);
            });
            expect(routerState.replace).not.toHaveBeenCalled();
            expect(storageMutators.setSessionLastMobileSurfaceBySessionId).not.toHaveBeenCalled();

            settingsState.sessionLastMobileSurfaceBySessionId = {
                'session-1': 'browse',
                'session-2': 'terminal',
                'session-3': 'git',
            };

            pathState.pathname = '/session/session-1/files';
            searchParamsState.sourceSurface = undefined;
            await act(async () => {
                notifyStorageListeners();
            });

            expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({
                'session-1': 'git',
                'session-2': 'terminal',
                'session-3': 'git',
            });
            expect(routerState.replace).toHaveBeenCalledWith('/session/session-1/git?serverId=server-a');
        } finally {
            vi.useRealTimers();
        }
    });

    it('merges the latest session surface map when the details-collapse fallback timer completes', async () => {
        vi.useFakeTimers();
        try {
            pathState.pathname = '/session/session-1/details';
            searchParamsState.id = 'session-1';
            searchParamsState.serverId = 'server-a';
            searchParamsState.sourceSurface = 'browse';
            settingsState.sessionLastMobileSurfaceBySessionId = {
                'session-1': 'browse',
                'session-2': 'chat',
            };

            const {
                MobileBottomChromeHost,
                SESSION_DETAILS_COLLAPSE_FALLBACK_MS,
            } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
            await act(async () => {
                bar.props.onSurfacePress('git');
            });

            settingsState.sessionLastMobileSurfaceBySessionId = {
                'session-1': 'browse',
                'session-2': 'terminal',
                'session-3': 'git',
            };
            await act(async () => {
                notifyStorageListeners();
            });

            await act(async () => {
                vi.advanceTimersByTime(SESSION_DETAILS_COLLAPSE_FALLBACK_MS);
            });

            expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({
                'session-1': 'git',
                'session-2': 'terminal',
                'session-3': 'git',
            });
            expect(routerState.replace).toHaveBeenCalledWith('/session/session-1/git?serverId=server-a');
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels a pending details-collapse switch when pathname changes to an unrelated route', async () => {
        vi.useFakeTimers();
        try {
            pathState.pathname = '/session/session-1/details';
            searchParamsState.id = 'session-1';
            searchParamsState.serverId = 'server-a';
            searchParamsState.sourceSurface = 'browse';

            const {
                MobileBottomChromeHost,
                SESSION_DETAILS_COLLAPSE_FALLBACK_MS,
            } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
            await act(async () => {
                bar.props.onSurfacePress('git');
            });

            expect(routerState.back).toHaveBeenCalledTimes(1);
            expect(routerState.replace).not.toHaveBeenCalled();
            expect(storageMutators.setSessionLastMobileSurfaceBySessionId).not.toHaveBeenCalled();

            pathState.pathname = '/settings';
            searchParamsState.sourceSurface = undefined;
            await act(async () => {
                settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
                notifyStorageListeners();
            });

            expect(routerState.replace).not.toHaveBeenCalled();
            expect(storageMutators.setSessionLastMobileSurfaceBySessionId).not.toHaveBeenCalled();

            pathState.pathname = '/session/session-1/files';
            await act(async () => {
                notifyStorageListeners();
            });

            await act(async () => {
                vi.advanceTimersByTime(SESSION_DETAILS_COLLAPSE_FALLBACK_MS);
            });

            expect(routerState.replace).not.toHaveBeenCalled();
            expect(storageMutators.setSessionLastMobileSurfaceBySessionId).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps cockpit terminal availability scoped to the viewed session server', async () => {
        pathState.pathname = '/session/session-1/files';
        searchParamsState.serverId = 'server-session';
        featureState.terminalEmbeddedPtyServerId = 'server-session';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.terminalTabAvailable).toBe(true);
    });

    it('falls back to replacing the sourced details route when navigation cannot go back', async () => {
        pathState.pathname = '/session/session-1/details';
        searchParamsState.serverId = 'server-a';
        searchParamsState.sourceSurface = 'git';
        navigationState.canGoBack = false;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('chat');
        });

        expect(routerState.back).not.toHaveBeenCalled();
        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1?serverId=server-a&mobileSurface=chat');
        expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({
            'session-1': 'chat',
        });
    });

    it('hides session cockpit chrome after switching to classic', async () => {
        vi.useFakeTimers();
        try {
            pathState.pathname = '/session/session-1/files';

            const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);

            await act(async () => {
                settingsState.mobileWorkspaceExperienceV1 = 'classic';
                notifyStorageListeners();
            });
            await act(async () => {
                vi.advanceTimersByTime(motionTokens.durationMs.fast);
            });

            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('animates from session cockpit chrome to main app tabs when returning to the sessions list', async () => {
        vi.useFakeTimers();
        try {
            pathState.pathname = '/session/session-1/files';

            const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);

            pathState.pathname = '/';
            await act(async () => {
                settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
                notifyStorageListeners();
            });

            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);
            expect(screen.tree.findAllByType('TabBar' as never)).toHaveLength(0);

            await act(async () => {
                vi.advanceTimersByTime(motionTokens.durationMs.fast);
            });

            expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
            const bar = screen.tree.findByType('TabBar' as never);
            expect(bar.props.activeTab).toBe('sessions');
        } finally {
            vi.useRealTimers();
        }
    });
});
