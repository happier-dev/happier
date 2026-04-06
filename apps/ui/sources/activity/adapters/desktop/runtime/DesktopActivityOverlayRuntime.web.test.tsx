import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

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
    ],
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

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopMock(),
}));

vi.mock('./isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => isDesktopOverlayWindowContextMock(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useAllSessions: () => sessionsState.value,
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

vi.mock('expo-router', () => ({
    router: {
        push: (value: unknown) => routerPushMock(value),
    },
}));

describe('DesktopActivityOverlayRuntime.web', () => {
    beforeEach(() => {
        isTauriDesktopMock.mockReturnValue(true);
        isDesktopOverlayWindowContextMock.mockReturnValue(false);
        syncDesktopActivityOverlayMock.mockImplementation(async () => {});
        listenDesktopActivityOverlayInteractionMock.mockImplementation(async () => () => {});
        setDesktopActivityOverlayExpandedMock.mockImplementation(async () => {});
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
