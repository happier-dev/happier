import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const isTauriDesktopMock = vi.hoisted(() => vi.fn(() => true));
const isDesktopOverlayWindowContextMock = vi.hoisted(() => vi.fn(() => false));
const sessionsState = vi.hoisted(() => ({
    value: [
        {
            id: 'session-web-1',
            seq: 2,
            lastViewedSessionSeq: 0,
            active: true,
            presence: 'online',
            thinking: false,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            metadata: {
                summary: { text: 'Desktop overlay web runtime', updatedAt: 1 },
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
                sessionId: 'session-web-1',
                serverId: 'server-1',
            },
        ],
    } as Record<string, ReadonlyArray<{ type: 'session'; sessionId: string; serverId: string }>>,
}));
const localSettingsState = vi.hoisted(() => ({
    value: {
        activitySurfacesEnabled: true,
        desktopOverlayEnabled: true,
        desktopOverlayVisibilityMode: 'always_when_enabled',
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
const routerPushMock = vi.hoisted(() => vi.fn());

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
        sessionMessages: {},
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
            throw new Error('DesktopActivityOverlayRuntime.web should not use useAllSessions');
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
    };
});

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries', () => ({
    useConnectedServiceQuotaSummaries: () => ({
        summaries: [],
        isRefreshing: false,
        hasConnectedProfiles: false,
    }),
}));

describe('DesktopActivityOverlayRuntime.web', () => {
    beforeEach(() => {
        isTauriDesktopMock.mockReturnValue(true);
        isDesktopOverlayWindowContextMock.mockReturnValue(false);
        syncDesktopActivityOverlayMock.mockImplementation(async () => {});
        listenDesktopActivityOverlayInteractionMock.mockImplementation(async () => () => {});
        setDesktopActivityOverlayExpandedMock.mockImplementation(async () => {});
        sessionsState.value = [
            {
                id: 'session-web-1',
                serverId: 'server-1',
                seq: 2,
                lastViewedSessionSeq: 0,
                active: true,
                presence: 'online',
                thinking: false,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                metadata: {
                    summary: { text: 'Desktop overlay web runtime', updatedAt: 1 },
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
                    sessionId: 'session-web-1',
                    serverId: 'server-1',
                },
            ],
        };
    });

    afterEach(() => {
        isTauriDesktopMock.mockReset();
        isDesktopOverlayWindowContextMock.mockReset();
        syncDesktopActivityOverlayMock.mockReset();
        listenDesktopActivityOverlayInteractionMock.mockReset();
        setDesktopActivityOverlayExpandedMock.mockReset();
        routerPushMock.mockReset();
    });

    it('runs the real desktop overlay runtime when the web bundle is hosted inside Tauri', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime.web');
        const screen = await renderScreen(<DesktopActivityOverlayRuntime />);

        expect(screen.tree.toJSON()).toBeNull();
        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            visible: true,
            model: expect.objectContaining({
                visible: true,
            }),
        }));
        expect(listenDesktopActivityOverlayInteractionMock).toHaveBeenCalledTimes(1);
    });

    it('stays inert when the web bundle is not running inside Tauri', async () => {
        isTauriDesktopMock.mockReturnValue(false);
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime.web');
        const screen = await renderScreen(<DesktopActivityOverlayRuntime />);

        expect(screen.tree.toJSON()).toBeNull();
        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        expect(listenDesktopActivityOverlayInteractionMock).not.toHaveBeenCalled();
    });
});
