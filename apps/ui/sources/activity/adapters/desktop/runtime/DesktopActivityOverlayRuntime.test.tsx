import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';

const isTauriDesktopMock = vi.hoisted(() => vi.fn(() => true));
const isDesktopOverlayWindowContextMock = vi.hoisted(() => vi.fn(() => false));
const sessionsState = vi.hoisted(() => ({
    value: [
        {
            id: 'session-1',
            serverId: 'server-1',
            createdAt: 1,
            updatedAt: 1_000,
            seq: 4,
            lastViewedSessionSeq: 2,
            active: true,
            activeAt: 950,
            archivedAt: null,
            presence: 'online',
            thinking: false,
            thinkingAt: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            meaningfulActivityAt: 1_000,
            lastRuntimeIssue: null,
            lastTurnCompletedAt: null,
            pendingVersion: 1,
            pendingCount: 1,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 950,
            agentStateVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {
                    'permission-1': {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 950,
                    },
                },
            },
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
const settingsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
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
const emitDesktopActivityOverlayInteractionResultMock = vi.hoisted(
    () => vi.fn<(payload: { requestId: string; ok: boolean; errorCode?: string; error?: string }) => Promise<void>>(async () => {}),
);
const actionExecutorExecuteMock = vi.hoisted(
    () => vi.fn<(actionId: string, input: unknown, context: unknown) => Promise<{ ok: boolean; result?: unknown; errorCode?: string; error?: string }>>(async () => ({ ok: true, result: { ok: true } })),
);
const desktopActivityOverlayQaSyncOverrideKey = '__HAPPIER_DESKTOP_ACTIVITY_OVERLAY_QA_SYNC_OVERRIDE__';

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
        sessionMessages: {},
        sessionListRenderables: {},
        sessionListIndexByServerId: sessionListIndexState.value,
        concurrentSessionListCacheByServerId: {},
        localSettings: localSettingsState.value,
        settings: settingsState.value,
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
        useSettings: () => settingsState.value,
    });
});

vi.mock('./useDesktopActivityOverlaySource', () => ({
    useDesktopActivityOverlaySource: () => ({
        isDataReady: true,
        sessionsById: Object.fromEntries(
            sessionsState.value.map((session) => [session.id, session]),
        ),
        sessionListRenderablesById: {},
        sessionListIndexByServerId: sessionListIndexState.value,
        concurrentSessionListCacheByServerId: {},
        sessionMessagesById: {},
        serverProfilesById: {
            'server-1': {
                id: 'server-1',
                name: 'Server 1',
                serverUrl: 'https://server.example.test',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
                source: 'manual',
            },
            'server-2': {
                id: 'server-2',
                name: 'Server 2',
                serverUrl: 'https://server-two.example.test',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
                source: 'manual',
            },
        },
        activeServer: {
            serverId: 'server-1',
            serverUrl: 'https://server.example.test',
            generation: 1,
        },
        quotaSummaries: [],
    }),
}));

vi.mock('./desktopActivityOverlayBridge', async () => {
    const actual = await vi.importActual<typeof import('./desktopActivityOverlayBridge')>('./desktopActivityOverlayBridge');
    return {
        ...actual,
        syncDesktopActivityOverlay: (payload: unknown) => syncDesktopActivityOverlayMock(payload),
        listenDesktopActivityOverlayInteraction: (handler: (payload: unknown) => void) => listenDesktopActivityOverlayInteractionMock(handler),
        setDesktopActivityOverlayExpanded: (expanded: boolean) => setDesktopActivityOverlayExpandedMock(expanded),
        showDesktopMainWindow: () => showDesktopMainWindowMock(),
        emitDesktopActivityOverlayInteractionResult: (payload: { requestId: string; ok: boolean; errorCode?: string; error?: string }) =>
            emitDesktopActivityOverlayInteractionResultMock(payload),
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
        const now = Date.now();
        isTauriDesktopMock.mockReturnValue(true);
        isDesktopOverlayWindowContextMock.mockReturnValue(false);
        syncDesktopActivityOverlayMock.mockImplementation(async () => {});
        listenDesktopActivityOverlayInteractionMock.mockImplementation(async () => () => {});
        setDesktopActivityOverlayExpandedMock.mockImplementation(async () => {});
        showDesktopMainWindowMock.mockImplementation(async () => {});
        emitDesktopActivityOverlayInteractionResultMock.mockImplementation(async () => {});
        actionExecutorExecuteMock.mockImplementation(async () => ({ ok: true, result: { ok: true } }));

        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-1',
                createdAt: 1,
                updatedAt: now,
                seq: 4,
                lastViewedSessionSeq: 2,
                active: true,
                activeAt: now - 50,
                archivedAt: null,
                presence: 'online',
                thinking: false,
                thinkingAt: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                meaningfulActivityAt: now,
                lastRuntimeIssue: null,
                lastTurnCompletedAt: null,
                pendingVersion: 1,
                pendingCount: 1,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: now - 50,
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        'permission-1': {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: {},
                            createdAt: now - 50,
                        },
                    },
                },
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
        settingsState.value = {
        };
    });

    afterEach(() => {
        delete (globalThis as unknown as Record<string, unknown>)[desktopActivityOverlayQaSyncOverrideKey];
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
        settingsState.value = {
        };
        syncDesktopActivityOverlayMock.mockReset();
        listenDesktopActivityOverlayInteractionMock.mockReset();
        setDesktopActivityOverlayExpandedMock.mockReset();
        showDesktopMainWindowMock.mockReset();
        emitDesktopActivityOverlayInteractionResultMock.mockReset();
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
                expanded: expect.objectContaining({
                    cards: expect.arrayContaining([
                        expect.objectContaining({ sessionId: 'session-1' }),
                    ]),
                }),
            }),
        }));
        expect(listenDesktopActivityOverlayInteractionMock).toHaveBeenCalledTimes(1);
    }, 120_000);

    it('skips native sync when the stable activity overview fingerprint is unchanged', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledTimes(1);

        syncDesktopActivityOverlayMock.mockClear();
        localSettingsState.value = {
            ...localSettingsState.value,
        };

        await act(async () => {
            screen.tree.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
    }, 120_000);

    it('synchronizes disabled desktop overlay policy even when the stable overview fingerprint is unchanged', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledTimes(1);

        syncDesktopActivityOverlayMock.mockClear();
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayEnabled: false,
        };

        await act(async () => {
            screen.tree.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            visible: false,
            model: expect.objectContaining({
                visible: false,
            }),
        }));
    }, 120_000);

    it('does not use pet desktop overlay settings to host the activity overlay', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayEnabled: false,
            desktopPetOverlayEnabledOverride: 'enabled',
            desktopPetOverlayVisibilityModeOverride: 'alwaysWhenEnabled',
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            visible: false,
            policy: expect.objectContaining({
                enabled: false,
            }),
            model: expect.objectContaining({
                visible: false,
            }),
        }));
    }, 120_000);

    it('honors the pinned MCP QA sync payload instead of overwriting it with live rows', async () => {
        const qaPayload = {
            visible: true,
            expanded: true,
            model: {
                visible: true,
                isExpanded: true,
                generatedAt: 1,
                collapsed: {
                    title: 'Quota update',
                    statusText: 'Usage summary',
                    defaultTarget: 'open-inbox',
                    sessionCount: null,
                    primaryCardKind: 'quota_summary',
                },
                expanded: {
                    title: 'Usage',
                    rows: [],
                    cards: [
                        {
                            id: 'qa-quota-summary',
                            kind: 'quota_summary',
                            title: '5h left today',
                            summary: '7% remaining in the rolling window.',
                        },
                    ],
                },
                window: {
                    collapsed: { width: 336, height: 68 },
                    expanded: { width: 408, height: 232 },
                },
            },
            policy: localSettingsState.value,
            window: {
                collapsed: { width: 336, height: 68 },
                expanded: { width: 408, height: 232 },
            },
        };
        (globalThis as unknown as Record<string, unknown>)[desktopActivityOverlayQaSyncOverrideKey] = {
            payload: qaPayload,
            expiresAt: Date.now() + 30_000,
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            expanded: true,
            model: expect.objectContaining({
                expanded: expect.objectContaining({
                    cards: [expect.objectContaining({ kind: 'quota_summary' })],
                }),
            }),
        }));
        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalledWith(expect.objectContaining({
            model: expect.objectContaining({
                expanded: expect.objectContaining({
                    cards: [expect.objectContaining({ kind: 'session_overview' })],
                }),
            }),
        }));
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
                    rows: [expect.objectContaining({ sessionId: 'session-1' })],
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
                data: {
                    serverId: 'server-1',
                    sessionId: 'session-1',
                },
            });
        });

        expect(showDesktopMainWindowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1?serverId=server-1');
        expect(showDesktopMainWindowMock.mock.invocationCallOrder[0]).toBeLessThan(
            routerPushMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('executes direct permission, user-action, and quick-reply overlay interactions through the canonical action executor', async () => {
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
                    serverId: 'server-1',
                    requestId: 'permission-1',
                    decision: 'allow',
                },
            });
            handler?.({
                actionIdentifier: 'session.user_action.answer',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    requestId: 'question-1',
                    answers: [
                        {
                            question: 'Which deployment target?',
                            answer: 'Production',
                        },
                    ],
                },
            });
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    message: 'Continue',
                },
            });
        });

        const permissionCall = actionExecutorExecuteMock.mock.calls.find(([actionId]) => actionId === 'session.permission.respond');
        expect(permissionCall?.[1]).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            requestId: 'permission-1',
            decision: 'allow',
        }));
        expect(permissionCall?.[1]).not.toHaveProperty('serverId');
        expect(permissionCall?.[2]).toEqual(
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        const userActionCall = actionExecutorExecuteMock.mock.calls.find(([actionId]) => actionId === 'session.user_action.answer');
        expect(userActionCall?.[1]).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            requestId: 'question-1',
            answers: [
                {
                    question: 'Which deployment target?',
                    answer: 'Production',
                },
            ],
        }));
        expect(userActionCall?.[1]).not.toHaveProperty('serverId');
        expect(userActionCall?.[2]).toEqual(
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        const quickReplyCall = actionExecutorExecuteMock.mock.calls.find(([actionId]) => actionId === 'session.message.send');
        expect(quickReplyCall?.[1]).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            message: 'Continue',
        }));
        expect(quickReplyCall?.[1]).not.toHaveProperty('serverId');
        expect(quickReplyCall?.[2]).toEqual(
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('opens the session instead of executing a direct action when the payload lacks verified server scope', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    message: 'Continue',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
        expect(showDesktopMainWindowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1?serverId=server-1');
        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('does not preserve legacy permission notification action execution in the desktop overlay', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    requestId: 'permission-1',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
    });

    it('acknowledges downstream direct action failure back to the overlay request', async () => {
        actionExecutorExecuteMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'action_failed',
            error: 'action_failed',
        });
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { requestId?: string; actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                requestId: 'quick-reply-request-1',
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    message: 'Continue',
                },
            });
            await Promise.resolve();
        });

        expect(actionExecutorExecuteMock).toHaveBeenCalledWith(
            'session.message.send',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'Continue',
            }),
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        expect(actionExecutorExecuteMock.mock.calls[0]?.[1]).not.toHaveProperty('serverId');
        expect(emitDesktopActivityOverlayInteractionResultMock).toHaveBeenCalledWith({
            requestId: 'quick-reply-request-1',
            ok: false,
            errorCode: 'action_failed',
            error: 'action_failed',
        });
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

    it('uses the latest shared tap target for overlay interactions after mount', async () => {
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

    it('validates direct actions against the latest selected session server scope after mount', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));
        const now = Date.now();

        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-2',
                createdAt: 1,
                updatedAt: now,
                seq: 5,
                lastViewedSessionSeq: 2,
                active: true,
                activeAt: now - 50,
                archivedAt: null,
                presence: 'online',
                thinking: false,
                thinkingAt: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                meaningfulActivityAt: now,
                lastRuntimeIssue: null,
                lastTurnCompletedAt: null,
                pendingVersion: 1,
                pendingCount: 1,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: now - 50,
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        'permission-1': {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: {},
                            createdAt: now - 50,
                        },
                    },
                },
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 2 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];
        sessionListIndexState.value = {
            'server-2': [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-2',
                },
            ],
        };

        await act(async () => {
            screen.tree.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls.at(-1)?.[0] as
            | ((payload: { requestId?: string; actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                requestId: 'quick-reply-request-2',
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-2',
                    message: 'Continue',
                },
            });
            await Promise.resolve();
        });

        expect(actionExecutorExecuteMock).toHaveBeenCalledWith(
            'session.message.send',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'Continue',
            }),
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-2',
            }),
        );
        expect(actionExecutorExecuteMock.mock.calls[0]?.[1]).not.toHaveProperty('serverId');
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('auto-collapses the overlay after the configured auto-hide delay', async () => {
        vi.useFakeTimers();
        sessionsState.value = sessionsState.value.map((session) => ({
            ...session,
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 4,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingRequestObservedAt: null,
            agentState: null,
        }));
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayVisibilityMode: 'active_sessions',
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

    it('pauses runtime auto-collapse while the overlay window reports input locked', async () => {
        vi.useFakeTimers();
        sessionsState.value = sessionsState.value.map((session) => ({
            ...session,
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 4,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingRequestObservedAt: null,
            agentState: null,
        }));
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayVisibilityMode: 'active_sessions',
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
            handler?.({
                actionIdentifier: 'overlay-input-locked',
                data: { locked: true },
            });
            await vi.advanceTimersByTimeAsync(1500);
        });

        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalledWith(false);

        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-input-locked',
                data: { locked: false },
            });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1200);
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('pauses runtime auto-collapse while the expanded surface reports pointer engagement', async () => {
        vi.useFakeTimers();
        sessionsState.value = sessionsState.value.map((session) => ({
            ...session,
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 4,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingRequestObservedAt: null,
            agentState: null,
        }));
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayVisibilityMode: 'active_sessions',
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
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-surface-engaged',
                data: { engaged: true },
            });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
        });

        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalledWith(false);

        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-surface-engaged',
                data: { engaged: false },
            });
        });
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1200);
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('pauses runtime auto-collapse while blocking action cards are visible', async () => {
        vi.useFakeTimers();
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayAutoHideEnabled: true,
            desktopOverlayAutoHideDelayMs: 1200,
        };
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
                agentState: {
                    requests: {
                        'permission-1': {
                            tool: 'Bash',
                            arguments: {
                                command: 'npm test',
                            },
                            createdAt: 100,
                        },
                    },
                },
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 1 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];

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
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
        });

        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalledWith(false);
    });

    it('opens the session instead of executing a direct action when the payload carries an unsafe server URL', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverUrl: 'http://localhost:3000',
                    message: 'Continue',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
        expect(showDesktopMainWindowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1?serverId=server-1');
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
