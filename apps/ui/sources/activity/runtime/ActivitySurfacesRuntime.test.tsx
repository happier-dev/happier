import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit';

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'web' | 'android',
}));

const sessionsState = vi.hoisted(() => ({
    value: [] as ReturnType<typeof createSessionFixture>[],
}));

function createFeatureToggleState(overrides: Partial<{
    liveActivities: boolean;
    widgets: boolean;
}> = {}) {
    return {
        experiments: true,
        featureToggles: {
            'app.ui.liveActivities': overrides.liveActivities ?? true,
            'app.ui.homeScreenWidgets': overrides.widgets ?? true,
        },
    };
}

function createLocalSettingsState(overrides: Partial<{
    activitySurfacesEnabled: boolean;
    iosLiveActivitiesEnabled: boolean;
    iosWidgetsEnabled: boolean;
    liveActivitiesMode: 'focused' | 'attention' | 'running';
    liveActivitiesMaxConcurrent: 1 | 2 | 4;
    liveActivitiesIncludeThinking: boolean;
    activitySurfaceTapTarget: 'open_session' | 'open_sessions';
}> = {}) {
    return {
        activitySurfacesEnabled: true,
        iosLiveActivitiesEnabled: true,
        iosWidgetsEnabled: true,
        liveActivitiesMode: 'focused' as const,
        liveActivitiesMaxConcurrent: 1 as const,
        liveActivitiesIncludeThinking: true,
        activitySurfaceTapTarget: 'open_session' as const,
        ...overrides,
    };
}

const settingsState = vi.hoisted(() => ({
    value: createFeatureToggleState(),
}));

const localSettingsState = vi.hoisted(() => ({
    value: createLocalSettingsState(),
}));

const widgetInteractionsState = vi.hoisted(() => ({
    listener: null as null | ((event: { source: string; target: string; timestamp: number; type: string }) => void),
}));

const focusWidgetUpdateSnapshot = vi.hoisted(() => vi.fn());
const sessionsWidgetUpdateSnapshot = vi.hoisted(() => vi.fn());
const liveActivityInstances = vi.hoisted(() => [] as Array<{
    update: (props: unknown) => Promise<void>;
    end: (dismissalPolicy?: unknown, props?: unknown, contentDate?: Date) => Promise<void>;
}>);
const liveActivityStart = vi.hoisted(() =>
    vi.fn(() => {
        const instance = {
            update: liveActivityUpdate,
            end: liveActivityEnd,
        };
        liveActivityInstances.push(instance);
        return instance;
    }),
);
const liveActivityUpdate = vi.hoisted(() => vi.fn(async () => {}));
const liveActivityEnd = vi.hoisted(() => vi.fn(async () => {}));
const liveActivityGetInstances = vi.hoisted(() => vi.fn(() => liveActivityInstances));
const addUserInteractionListener = vi.hoisted(() =>
    vi.fn((listener: typeof widgetInteractionsState.listener) => {
        widgetInteractionsState.listener = listener;
        return { remove: vi.fn() };
    }),
);
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
        },
    });
});

vi.mock('expo-router', () => ({
    router: {
        push: routerPush,
    },
}));

vi.mock('expo-widgets', () => ({
    addUserInteractionListener,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useAllSessions: () => sessionsState.value,
        useSettings: () => settingsState.value,
        useLocalSettings: () => localSettingsState.value,
    });
});

vi.mock('@/activity/widgets/widgetModules', () => ({
    HappierFocusWidget: {
        updateSnapshot: focusWidgetUpdateSnapshot,
    },
    HappierSessionsWidget: {
        updateSnapshot: sessionsWidgetUpdateSnapshot,
    },
    HappierFocusLiveActivity: {
        start: liveActivityStart,
        getInstances: liveActivityGetInstances,
    },
}));

describe('ActivitySurfacesRuntime', () => {
    afterEach(() => {
        platformState.os = 'ios';
        sessionsState.value = [];
        settingsState.value = createFeatureToggleState();
        localSettingsState.value = createLocalSettingsState();
        widgetInteractionsState.listener = null;
        focusWidgetUpdateSnapshot.mockClear();
        sessionsWidgetUpdateSnapshot.mockClear();
        liveActivityStart.mockClear();
        liveActivityUpdate.mockClear();
        liveActivityEnd.mockClear();
        liveActivityGetInstances.mockClear();
        liveActivityInstances.length = 0;
        addUserInteractionListener.mockClear();
        routerPush.mockClear();
    });

    it('pushes the shared snapshot into the focus and sessions widgets and starts the focused live activity', async () => {
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
            createSessionFixture({
                id: 'unread',
                seq: 5,
                lastViewedSessionSeq: 2,
                metadata: {
                    path: '/Users/tester/project/unread',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Unread work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(focusWidgetUpdateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            primary: expect.objectContaining({
                sessionId: 'permission',
                title: 'Permission work',
                attentionState: 'permission_required',
            }),
            sessions: expect.arrayContaining([
                expect.objectContaining({ sessionId: 'permission' }),
                expect.objectContaining({ sessionId: 'unread' }),
            ]),
        }));
        expect(sessionsWidgetUpdateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            counts: expect.objectContaining({
                permissionRequired: 1,
                unread: 1,
                totalAttention: 2,
            }),
        }));
        expect(liveActivityStart).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'permission',
                title: 'Permission work',
                defaultTarget: 'open-session:permission',
            }),
            '/session/permission',
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('starts multiple live activities when the configured mode and cap allow it', async () => {
        localSettingsState.value = createLocalSettingsState({
            liveActivitiesMode: 'attention',
            liveActivitiesMaxConcurrent: 2,
            liveActivitiesIncludeThinking: false,
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                seq: 10,
                lastViewedSessionSeq: 10,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 3 },
                },
            }),
            createSessionFixture({
                id: 'action',
                seq: 9,
                lastViewedSessionSeq: 9,
                active: true,
                presence: 'online',
                pendingUserActionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/action',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Action work', updatedAt: 2 },
                },
            }),
            createSessionFixture({
                id: 'thinking',
                seq: 8,
                lastViewedSessionSeq: 8,
                active: true,
                presence: 'online',
                thinking: true,
                metadata: {
                    path: '/Users/tester/project/thinking',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Thinking work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(liveActivityStart).toHaveBeenCalledTimes(2);
        expect(liveActivityStart).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ sessionId: 'permission' }),
            '/session/permission',
        );
        expect(liveActivityStart).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ sessionId: 'action' }),
            '/session/action',
        );

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('reuses existing live activity instances on first mount instead of ending and restarting them', async () => {
        const existingUpdate = vi.fn(async () => {});
        const existingEnd = vi.fn(async () => {});
        liveActivityInstances.push({
            update: existingUpdate,
            end: existingEnd,
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(existingUpdate).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'permission',
        }));
        expect(liveActivityStart).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('clears widget snapshots and does not start live activities when the activity-surface features are disabled', async () => {
        settingsState.value = createFeatureToggleState({
            liveActivities: false,
            widgets: false,
        });
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(focusWidgetUpdateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            counts: expect.objectContaining({
                unread: 0,
                permissionRequired: 0,
                actionRequired: 0,
                queuedInput: 0,
                thinking: 0,
                totalAttention: 0,
            }),
            primary: null,
            sessions: [],
        }));
        expect(sessionsWidgetUpdateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            counts: expect.objectContaining({
                unread: 0,
                permissionRequired: 0,
                actionRequired: 0,
                queuedInput: 0,
                thinking: 0,
                totalAttention: 0,
            }),
            primary: null,
            sessions: [],
        }));
        expect(liveActivityStart).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('clears widget state and ends live activities when the runtime unmounts', async () => {
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(liveActivityStart).toHaveBeenCalledTimes(1);

        await act(async () => {
            screen.tree.unmount();
            await Promise.resolve();
        });

        expect(focusWidgetUpdateSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
            counts: expect.objectContaining({
                unread: 0,
                permissionRequired: 0,
                actionRequired: 0,
                queuedInput: 0,
                thinking: 0,
                totalAttention: 0,
            }),
            primary: null,
            sessions: [],
        }));
        expect(sessionsWidgetUpdateSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
            counts: expect.objectContaining({
                unread: 0,
                permissionRequired: 0,
                actionRequired: 0,
                queuedInput: 0,
                thinking: 0,
                totalAttention: 0,
            }),
            primary: null,
            sessions: [],
        }));
        expect(liveActivityEnd).toHaveBeenCalled();
    });

    it('routes user interactions from widgets back into the app', async () => {
        sessionsState.value = [
            createSessionFixture({
                id: 'permission',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Permission work', updatedAt: 1 },
                },
            }),
        ];

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(widgetInteractionsState.listener).toBeInstanceOf(Function);

        await act(async () => {
            widgetInteractionsState.listener?.({
                source: 'HappierFocusWidget',
                target: 'open-primary-session',
                timestamp: 123,
                type: 'ExpoWidgetsUserInteraction',
            });
            widgetInteractionsState.listener?.({
                source: 'HappierSessionsWidget',
                target: 'open-session:permission',
                timestamp: 456,
                type: 'ExpoWidgetsUserInteraction',
            });
            widgetInteractionsState.listener?.({
                source: 'HappierSessionsWidget',
                target: 'open-inbox',
                timestamp: 789,
                type: 'ExpoWidgetsUserInteraction',
            });
        });

        expect(routerPush).toHaveBeenCalledWith('/session/permission');
        expect(routerPush).toHaveBeenCalledWith('/inbox');

        await act(async () => {
            screen.tree.unmount();
        });
    });
});
