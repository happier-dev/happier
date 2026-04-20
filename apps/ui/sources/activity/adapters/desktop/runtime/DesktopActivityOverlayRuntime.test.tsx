import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const isTauriDesktopMock = vi.hoisted(() => vi.fn(() => true));
const isDesktopOverlayWindowContextMock = vi.hoisted(() => vi.fn(() => false));
const sessionsState = vi.hoisted(() => ({
    value: [
        {
            id: 'session-1',
            seq: 4,
            lastViewedSessionSeq: 2,
            active: true,
            presence: 'online',
            thinking: false,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            metadata: {
                summary: { text: 'Primary session', updatedAt: 1 },
                path: '/Users/tester/project',
                host: 'tester.local',
                homeDir: '/Users/tester',
            },
        },
    ] as Array<Record<string, unknown>>,
}));
const sessionListIndexState = vi.hoisted(() => ({
    value: {
        'server-1': [
            {
                type: 'session',
                sessionId: 'session-1',
                serverId: 'server-1',
            },
        ],
    } as Record<string, ReadonlyArray<{ type: 'session'; sessionId: string; serverId: string }>>,
}));
const localSettingsState = vi.hoisted(() => ({
    value: {
        activitySurfacesEnabled: true,
        iosLiveActivitiesEnabled: true,
        iosWidgetsEnabled: true,
        desktopOverlayEnabled: true,
        desktopOverlayVisibilityMode: 'attention_only',
    } as Record<string, unknown>,
}));

const syncDesktopActivityOverlayMock = vi.hoisted(
    () => vi.fn<(payload: unknown) => Promise<void>>(async () => {}),
);
const listenDesktopActivityOverlayInteractionMock = vi.hoisted(
    () => vi.fn<(handler: (payload: unknown) => void) => Promise<() => void>>(async () => () => {}),
);
const setDesktopActivityOverlayExpandedMock = vi.hoisted(
    () => vi.fn<(expanded: boolean) => Promise<void>>(async () => {}),
);
const showDesktopMainWindowMock = vi.hoisted(
    () => vi.fn<() => Promise<void>>(async () => {}),
);
const routerPushMock = vi.hoisted(() => vi.fn());
const actionExecutorExecuteMock = vi.hoisted(
    () => vi.fn<(actionId: string, input: unknown, context: unknown) => Promise<{ ok: true; result: unknown }>>(async () => ({ ok: true, result: { ok: true } })),
);

const expoRouterMock = createExpoRouterMock({
    router: {
        push: (value: unknown) => routerPushMock(value),
    },
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopMock(),
}));

vi.mock('./isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => isDesktopOverlayWindowContextMock(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const storageState = () => ({
        isDataReady: true,
        sessions: Object.fromEntries(
            sessionsState.value.map((session) => [session.id, session]),
        ),
        sessionListIndexByServerId: sessionListIndexState.value,
        sessionListRenderables: {},
        concurrentSessionListCacheByServerId: {},
        localSettings: localSettingsState.value,
    });
    const storage = Object.assign(
        ((selector?: (state: ReturnType<typeof storageState>) => unknown) =>
            typeof selector === 'function' ? selector(storageState()) : storageState()),
        {
            getState: () => storageState(),
            getInitialState: () => storageState(),
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    );
    return createStorageModuleStub({
        storage,
        useAllSessions: () => {
            throw new Error('DesktopActivityOverlayRuntime should not use useAllSessions');
        },
        useLocalSettings: () => localSettingsState.value,
    });
});

vi.mock('./desktopActivityOverlayBridge', async () => {
    const actual = await vi.importActual<typeof import('./desktopActivityOverlayBridge')>('./desktopActivityOverlayBridge');
    return {
        ...actual,
        syncDesktopActivityOverlay: (payload: unknown) => syncDesktopActivityOverlayMock(payload),
        listenDesktopActivityOverlayInteraction: (handler: (payload: unknown) => void) => listenDesktopActivityOverlayInteractionMock(handler),
        setDesktopActivityOverlayExpanded: (expanded: boolean) => setDesktopActivityOverlayExpandedMock(expanded),
        showDesktopMainWindow: () => showDesktopMainWindowMock(),
    };
});

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: (actionId: string, input: unknown, context: unknown) => actionExecutorExecuteMock(actionId, input, context),
    }),
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries', () => ({
    useConnectedServiceQuotaSummaries: () => ({
        summaries: [],
        isRefreshing: false,
        hasConnectedProfiles: false,
    }),
}));

describe('DesktopActivityOverlayRuntime', () => {
    beforeEach(() => {
        isTauriDesktopMock.mockReturnValue(true);
        isDesktopOverlayWindowContextMock.mockReturnValue(false);
        syncDesktopActivityOverlayMock.mockImplementation(async () => {});
        listenDesktopActivityOverlayInteractionMock.mockImplementation(async () => () => {});
        setDesktopActivityOverlayExpandedMock.mockImplementation(async () => {});
        showDesktopMainWindowMock.mockImplementation(async () => {});
        actionExecutorExecuteMock.mockImplementation(async () => ({ ok: true, result: { ok: true } }));

        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-1',
                seq: 4,
                lastViewedSessionSeq: 2,
                active: true,
                presence: 'online',
                thinking: false,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 1 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];
        sessionListIndexState.value = {
            'server-1': [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                },
            ],
        };
        localSettingsState.value = {
            activitySurfacesEnabled: true,
            iosLiveActivitiesEnabled: true,
            iosWidgetsEnabled: true,
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'attention_only',
        };
    });

    afterEach(() => {
        isTauriDesktopMock.mockReset();
        isDesktopOverlayWindowContextMock.mockReset();
        sessionsState.value = [];
        sessionListIndexState.value = {
            'server-1': [],
        };
        localSettingsState.value = {
            activitySurfacesEnabled: true,
            iosLiveActivitiesEnabled: true,
            iosWidgetsEnabled: true,
            desktopOverlayEnabled: true,
        };
        syncDesktopActivityOverlayMock.mockReset();
        listenDesktopActivityOverlayInteractionMock.mockReset();
        setDesktopActivityOverlayExpandedMock.mockReset();
        showDesktopMainWindowMock.mockReset();
        routerPushMock.mockReset();
        actionExecutorExecuteMock.mockReset();
        vi.useRealTimers();
    });

    it('synchronizes overlay state when running on tauri desktop', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            visible: true,
            model: expect.objectContaining({
                visible: true,
            }),
        }));
        expect(listenDesktopActivityOverlayInteractionMock).toHaveBeenCalledTimes(1);
    }, 120_000);

    it('uses the desktop overlay selection path instead of widget mode when choosing visible sessions', async () => {
        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-1',
                seq: 4,
                lastViewedSessionSeq: 2,
                active: true,
                presence: 'online',
                thinking: false,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 1 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
            {
                id: 'session-2',
                serverId: 'server-1',
                seq: 5,
                lastViewedSessionSeq: 1,
                active: false,
                presence: 1,
                thinking: false,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 1,
                metadata: {
                    summary: { text: 'Question session', updatedAt: 2 },
                    path: '/Users/tester/project-two',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];
        sessionListIndexState.value = {
            'server-1': [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                },
                {
                    type: 'session',
                    sessionId: 'session-2',
                    serverId: 'server-1',
                },
            ],
        };
        localSettingsState.value = {
            ...localSettingsState.value,
            widgetsPresetMode: 'attention',
            desktopOverlayVisibilityMode: 'active_sessions',
            desktopOverlayShowWhenRunning: true,
            desktopOverlayShowWhenAttentionRequired: true,
            desktopOverlayShowWhenReady: true,
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            model: expect.objectContaining({
                expanded: expect.objectContaining({
                    rows: expect.arrayContaining([
                        expect.objectContaining({ sessionId: 'session-1' }),
                        expect.objectContaining({ sessionId: 'session-2' }),
                    ]),
                }),
            }),
        }));
    });

    it('does not synchronize when not running on tauri', async () => {
        isTauriDesktopMock.mockReturnValue(false);
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        expect(listenDesktopActivityOverlayInteractionMock).not.toHaveBeenCalled();
    });

    it('does not synchronize when rendering inside the overlay window context', async () => {
        isDesktopOverlayWindowContextMock.mockReturnValue(true);
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        expect(listenDesktopActivityOverlayInteractionMock).not.toHaveBeenCalled();
    });

    it('routes overlay interactions to the selected session and collapses afterward', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'open-session:session-1',
            });
        });

        expect(showDesktopMainWindowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1');
        expect(showDesktopMainWindowMock.mock.invocationCallOrder[0]).toBeLessThan(
            routerPushMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('executes direct permission and user-action overlay interactions through the canonical action executor', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.permission.respond',
                data: {
                    sessionId: 'session-1',
                    requestId: 'permission-1',
                    decision: 'allow',
                },
            });
            handler?.({
                actionIdentifier: 'session.user_action.answer',
                data: {
                    sessionId: 'session-1',
                    requestId: 'question-1',
                    answers: [
                        {
                            question: 'Which deployment target?',
                            answer: 'Production',
                        },
                    ],
                },
            });
        });

        expect(actionExecutorExecuteMock).toHaveBeenCalledWith(
            'session.permission.respond',
            expect.objectContaining({
                sessionId: 'session-1',
                requestId: 'permission-1',
                decision: 'allow',
            }),
            expect.objectContaining({
                surface: 'desktop_overlay',
                defaultSessionId: 'session-1',
            }),
        );
        expect(actionExecutorExecuteMock).toHaveBeenCalledWith(
            'session.user_action.answer',
            expect.objectContaining({
                sessionId: 'session-1',
                requestId: 'question-1',
                answers: [
                    {
                        question: 'Which deployment target?',
                        answer: 'Production',
                    },
                ],
            }),
            expect.objectContaining({
                surface: 'desktop_overlay',
                defaultSessionId: 'session-1',
            }),
        );
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('uses the canonical shared default target when the interaction has no explicit action identifier', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            activitySurfaceTapTarget: 'open_sessions',
        };
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: ' ',
                data: {
                    primarySessionId: 'session-1',
                },
            });
        });

        expect(routerPushMock).toHaveBeenCalledWith('/inbox');
    });

    it('refreshes the overlay interaction listener when the shared tap target changes after mount', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(listenDesktopActivityOverlayInteractionMock).toHaveBeenCalledTimes(1);

        localSettingsState.value = {
            ...localSettingsState.value,
            activitySurfaceTapTarget: 'open_sessions',
        };

        await act(async () => {
            screen.tree.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls.at(-1)?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: ' ',
                data: {
                    primarySessionId: 'session-1',
                },
            });
        });

        expect(routerPushMock).toHaveBeenCalledWith('/inbox');
    });

    it('auto-collapses the overlay after the configured auto-hide delay', async () => {
        vi.useFakeTimers();
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayAutoHideEnabled: true,
            desktopOverlayAutoHideDelayMs: 1200,
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-set-expanded',
                data: { expanded: true },
            });
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(true);

        await act(async () => {
            await Promise.resolve();
            await vi.runOnlyPendingTimersAsync();
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('disposes a late-resolving interaction listener when runtime unmounts before subscription resolves', async () => {
        let resolveSubscription: (dispose: () => void) => void = () => {
            throw new Error('Expected deferred interaction subscription to capture its resolver.');
        };
        let capturedResolver = false;
        const deferredSubscription = new Promise<() => void>((resolve) => {
            resolveSubscription = resolve;
            capturedResolver = true;
        });
        const disposeMock = vi.fn();
        listenDesktopActivityOverlayInteractionMock.mockImplementation(
            () => deferredSubscription,
        );

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const rendered = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        await act(async () => {
            rendered.tree.unmount();
        });

        if (!capturedResolver) {
            throw new Error('Expected deferred interaction subscription to capture its resolver.');
        }

        resolveSubscription(disposeMock);

        await act(async () => {
            await Promise.resolve();
        });

        expect(disposeMock).toHaveBeenCalledTimes(1);
    });
});
