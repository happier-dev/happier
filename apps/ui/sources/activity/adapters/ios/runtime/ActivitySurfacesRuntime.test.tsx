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

const dataReadyState = vi.hoisted(() => ({
    value: true,
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
    liveActivitiesStrategy: 'dynamic_primary' | 'pinned_primary' | 'session_specific';
    liveActivitiesMaxConcurrent: 1 | 2 | 4;
    liveActivitiesIncludeThinking: boolean;
    activitySurfaceTapTarget: 'open_session' | 'open_sessions';
}> = {}) {
    return {
        activitySurfacesEnabled: true,
        iosLiveActivitiesEnabled: true,
        iosWidgetsEnabled: true,
        liveActivitiesMode: 'focused' as const,
        liveActivitiesStrategy: 'dynamic_primary' as const,
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
        useIsDataReady: () => dataReadyState.value,
    });
});

vi.mock('./iosActivityWidgetModules', () => ({
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
        dataReadyState.value = true;
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

    it('ends existing live activity instances when the store is ready but there are no eligible sessions', async () => {
        const existingUpdate = vi.fn(async () => {});
        const existingEnd = vi.fn(async () => {});
        liveActivityInstances.push({
            update: existingUpdate,
            end: existingEnd,
        });
        sessionsState.value = [];
        dataReadyState.value = true;

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(existingEnd).toHaveBeenCalledTimes(1);
        expect(liveActivityStart).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('keeps existing live activities alive while the store is not hydrated and there is nothing to reconcile yet', async () => {
        const existingUpdate = vi.fn(async () => {});
        const existingEnd = vi.fn(async () => {});
        liveActivityInstances.push({
            update: existingUpdate,
            end: existingEnd,
        });
        sessionsState.value = [];
        dataReadyState.value = false;

        const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
        const screen = await renderScreen(React.createElement(ActivitySurfacesRuntime));

        await act(async () => {});

        expect(existingEnd).not.toHaveBeenCalled();
        expect(liveActivityStart).not.toHaveBeenCalled();

        await act(async () => {
            screen.tree.unmount();
        });
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
});
