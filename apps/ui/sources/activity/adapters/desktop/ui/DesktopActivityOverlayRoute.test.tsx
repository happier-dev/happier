import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    findTestInstanceByTypeContainingText,
    flushHookEffects,
    pressTestInstance,
    renderScreen,
} from '@/dev/testkit';

import type { DesktopActivityOverlayWindowStatePayload } from '../runtime/desktopActivityOverlayBridge';

const isTauriDesktopMock = vi.hoisted(() => vi.fn(() => true));
const isDesktopActivityOverlayWindowContextMock = vi.hoisted(() => vi.fn(() => true));
const getDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<() => Promise<DesktopActivityOverlayWindowStatePayload | null>>(),
);
const listenDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<(handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) => Promise<() => void>>(async () => () => {}),
);
const setDesktopActivityOverlayExpandedMock = vi.hoisted(
    () => vi.fn<(expanded: boolean) => Promise<void>>(async () => {}),
);
const emitDesktopActivityOverlayInteractionMock = vi.hoisted(
    () => vi.fn<(payload: { actionIdentifier: string; data: Record<string, unknown> }) => Promise<void>>(async () => {}),
);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopMock(),
}));

vi.mock('../runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => isDesktopActivityOverlayWindowContextMock(),
}));

vi.mock('../runtime/desktopActivityOverlayBridge', () => ({
    getDesktopActivityOverlayWindowState: () => getDesktopActivityOverlayWindowStateMock(),
    listenDesktopActivityOverlayWindowState: (handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        listenDesktopActivityOverlayWindowStateMock(handler),
    setDesktopActivityOverlayExpanded: (expanded: boolean) => setDesktopActivityOverlayExpandedMock(expanded),
    emitDesktopActivityOverlayInteraction: (payload: { actionIdentifier: string; data: Record<string, unknown> }) =>
        emitDesktopActivityOverlayInteractionMock(payload),
}));

function createWindowState(
    overrides: Partial<DesktopActivityOverlayWindowStatePayload> = {},
): DesktopActivityOverlayWindowStatePayload {
    return {
        visible: true,
        expanded: false,
        model: {
            visible: true,
            isExpanded: false,
            generatedAt: Date.now(),
            collapsed: {
                title: 'Session One',
                subtitle: 'Repo',
                statusText: 'Needs attention',
                previewText: null,
                defaultTarget: 'open-primary-session',
                sessionCount: 2,
                attentionCount: 1,
            },
            expanded: {
                title: 'Active sessions',
                rows: [
                    {
                        sessionId: 'session-1',
                        title: 'Session One',
                        subtitle: 'Repo',
                        statusText: 'Needs attention',
                        route: '/session/session-1',
                        target: 'open-session:session-1',
                        attentionState: 'permission_required',
                    },
                ],
            },
            window: {
                collapsed: { width: 340, height: 72 },
                expanded: { width: 420, height: 220 },
            },
        },
        policy: {
            enabled: true,
            visibilityMode: 'attention_only',
            showWhenRunning: true,
            showWhenAttentionRequired: true,
            showWhenReady: true,
            alwaysOnTop: true,
            autoHideEnabled: true,
            autoHideDelayMs: 6000,
            expandedBehavior: 'click',
            interactiveCollapsed: true,
            clickAction: 'expand_overlay',
            density: 'compact',
            compactStyle: 'pill',
            showSessionCount: true,
            showPreviewText: false,
            placementMode: 'anchored',
            anchor: 'top_center',
            offsetX: 0,
            offsetY: 0,
            enableDragReposition: false,
            lockPosition: true,
        },
        window: {
            collapsed: { width: 340, height: 72 },
            expanded: { width: 420, height: 220 },
        },
        ...overrides,
    };
}

async function renderRoute() {
    const { DesktopActivityOverlayRoute } = await import('./DesktopActivityOverlayRoute');
    const screen = await renderScreen(<DesktopActivityOverlayRoute />);
    await flushHookEffects();
    return screen;
}

describe('DesktopActivityOverlayRoute', () => {
    afterEach(() => {
        isTauriDesktopMock.mockReset();
        isDesktopActivityOverlayWindowContextMock.mockReset();
        getDesktopActivityOverlayWindowStateMock.mockReset();
        listenDesktopActivityOverlayWindowStateMock.mockReset();
        setDesktopActivityOverlayExpandedMock.mockReset();
        emitDesktopActivityOverlayInteractionMock.mockReset();
    });

    it('renders a loading placeholder before the overlay state arrives', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockImplementation(() => new Promise(() => {}));
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const { DesktopActivityOverlayRoute } = await import('./DesktopActivityOverlayRoute');
        const screen = await renderScreen(<DesktopActivityOverlayRoute />);

        expect(screen.findByTestId('desktop-activity-overlay-loading')).toBeTruthy();
    });

    it('renders the hidden container when the overlay window state is not visible', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({ visible: false }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        expect(screen.findByTestId('desktop-activity-overlay-hidden')).toBeTruthy();
    });

    it('expands the collapsed overlay when the click action is set to expand', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState(),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        screen.pressByTestId('desktop-activity-overlay-collapsed');

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(true);
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded',
            data: { expanded: true },
        });
    });

    it('expands the collapsed overlay on hover when the expanded behavior is set to hover', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                policy: {
                    ...createWindowState().policy,
                    expandedBehavior: 'hover',
                },
            }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();
        const collapsed = screen.findByTestId('desktop-activity-overlay-collapsed');
        expect(collapsed).toBeTruthy();

        await act(async () => {
            collapsed?.props.onHoverIn?.();
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(true);
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded',
            data: { expanded: true },
        });
    });

    it('does not expand the collapsed overlay on click when expand behavior is hover', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                policy: {
                    ...createWindowState().policy,
                    expandedBehavior: 'hover',
                },
            }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        screen.pressByTestId('desktop-activity-overlay-collapsed');

        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
        expect(emitDesktopActivityOverlayInteractionMock).not.toHaveBeenCalled();
    });

    it('keeps the collapsed overlay non-interactive when that setting is disabled', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                policy: {
                    ...createWindowState().policy,
                    interactiveCollapsed: false,
                },
            }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();
        const collapsed = screen.findByTestId('desktop-activity-overlay-collapsed');
        expect(collapsed).toBeTruthy();

        screen.pressByTestId('desktop-activity-overlay-collapsed');
        await act(async () => {
            collapsed?.props.onHoverIn?.();
        });

        expect(collapsed?.props.disabled).toBe(true);
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
        expect(emitDesktopActivityOverlayInteractionMock).not.toHaveBeenCalled();
    });

    it('opens the primary session directly when the collapsed click action is configured for it', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                model: {
                    ...createWindowState().model,
                    collapsed: {
                        ...createWindowState().model.collapsed,
                        defaultTarget: 'open-session:session-1',
                    },
                },
                policy: {
                    ...createWindowState().policy,
                    clickAction: 'open_primary_session',
                },
            }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        screen.pressByTestId('desktop-activity-overlay-collapsed');

        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'open-session:session-1',
            data: { primarySessionId: 'session-1' },
        });
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
    });

    it('opens the primary session target even when the shared default target resolves to inbox', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                model: {
                    ...createWindowState().model,
                    collapsed: {
                        ...createWindowState().model.collapsed,
                        defaultTarget: 'open-inbox',
                    },
                },
                policy: {
                    ...createWindowState().policy,
                    clickAction: 'open_primary_session',
                },
            }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        screen.pressByTestId('desktop-activity-overlay-collapsed');

        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'open-session:session-1',
            data: { primarySessionId: 'session-1' },
        });
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
    });

    it('opens the inbox directly when the collapsed click action is configured for the sessions list', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                policy: {
                    ...createWindowState().policy,
                    clickAction: 'open_sessions',
                },
            }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        screen.pressByTestId('desktop-activity-overlay-collapsed');

        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'open-inbox',
            data: {},
        });
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
    });

    it('re-renders when the overlay window listener publishes a new expanded state', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({ expanded: false }),
        );

        let windowStateHandler: ((payload: DesktopActivityOverlayWindowStatePayload) => void) | null = null;
        listenDesktopActivityOverlayWindowStateMock.mockImplementation(async (handler) => {
            windowStateHandler = handler;
            return () => {};
        });

        const screen = await renderRoute();

        expect(screen.findByTestId('desktop-activity-overlay-collapsed')).toBeTruthy();

        await act(async () => {
            windowStateHandler?.(createWindowState({ expanded: true }));
        });

        expect(screen.findByTestId('desktop-activity-overlay-collapsed')).toBeNull();
        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.close')).toBeTruthy();
    });

    it('routes expanded overlay actions through the shared interaction bridge', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({ expanded: true }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        await act(async () => {
            pressTestInstance(
                findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.close'),
                'expanded overlay close action',
            );
        });
        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded',
            data: { expanded: false },
        });

        emitDesktopActivityOverlayInteractionMock.mockClear();

        await act(async () => {
            pressTestInstance(
                findTestInstanceByTypeContainingText(screen, 'Pressable', 'Session One'),
                'expanded overlay session row',
            );
        });
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'open-session:session-1',
            data: { sessionId: 'session-1' },
        });

        emitDesktopActivityOverlayInteractionMock.mockClear();

        await act(async () => {
            pressTestInstance(
                findTestInstanceByTypeContainingText(screen, 'Pressable', ['common.open', 'tabs.inbox']),
                'expanded overlay inbox action',
            );
        });
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'open-inbox',
            data: {},
        });
    });

    it('renders hidden state and skips bridge sync when not in overlay window context', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(false);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState());
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        expect(screen.findByTestId('desktop-activity-overlay-hidden')).toBeTruthy();
        expect(screen.findByTestId('desktop-activity-overlay-loading')).toBeNull();
        expect(getDesktopActivityOverlayWindowStateMock).not.toHaveBeenCalled();
        expect(listenDesktopActivityOverlayWindowStateMock).not.toHaveBeenCalled();
    });
});
