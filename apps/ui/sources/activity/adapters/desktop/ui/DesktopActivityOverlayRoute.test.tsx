import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

import type { DesktopActivityOverlayWindowStatePayload } from '../runtime/desktopActivityOverlayBridge';
import { resolveDesktopActivityOverlayCardActionInstanceTestID } from './shared/desktopActivityOverlaySelectors.mjs';

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
                statusText: 'Needs attention',
                defaultTarget: 'open-primary-session',
                sessionCount: 2,
                primaryCardKind: 'session_overview',
            },
            expanded: {
                title: 'Active sessions',
                rows: [
                    {
                        sessionId: 'session-1',
                        title: 'Session One',
                        subtitle: 'Repo',
                        statusText: 'Needs attention',
                        previewText: null,
                    },
                ],
                cards: [
                    {
                        id: 'session-overview-1',
                        kind: 'session_overview',
                        sessionId: 'session-1',
                        title: 'Session One',
                        subtitle: 'Repo',
                        statusText: 'Needs attention',
                        previewText: null,
                        attentionState: 'permission_required',
                        active: true,
                        updatedAt: 1,
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
            presentationMode: 'automatic',
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
        vi.useRealTimers();
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
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState({ visible: false }));
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        expect(screen.findByTestId('desktop-activity-overlay-hidden')).toBeTruthy();
    });

    it('always expands the collapsed overlay on press, even when legacy interaction knobs disagree', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                policy: {
                    ...createWindowState().policy,
                    expandedBehavior: 'hover',
                    interactiveCollapsed: false,
                    clickAction: 'open_sessions',
                },
            }),
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

    it('only auto-expands after a sustained hover in notch mode', async () => {
        vi.useFakeTimers();
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                policy: {
                    ...createWindowState().policy,
                    presentationMode: 'notch_integrated',
                    expandedBehavior: 'click',
                },
            }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();
        const collapsedSurface = screen.findByTestId('desktop-activity-overlay-collapsed');

        await act(async () => {
            invokeTestInstanceHandler(
                collapsedSurface,
                'onHoverIn',
                undefined,
                'desktop-activity-overlay-collapsed',
            );
            await vi.advanceTimersByTimeAsync(999);
        });
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();

        await act(async () => {
            invokeTestInstanceHandler(
                collapsedSurface,
                'onHoverOut',
                undefined,
                'desktop-activity-overlay-collapsed',
            );
            await vi.advanceTimersByTimeAsync(2);
        });
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();

        await act(async () => {
            invokeTestInstanceHandler(
                collapsedSurface,
                'onHoverIn',
                undefined,
                'desktop-activity-overlay-collapsed',
            );
            await vi.advanceTimersByTimeAsync(1_000);
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(true);
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded',
            data: { expanded: true },
        });
    });

    it('re-renders when the overlay window listener publishes a new expanded state', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState({ expanded: false }));

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
        expect(screen.findByTestId('desktop-activity-overlay-expanded')).toBeTruthy();
        expect(screen.findByTestId('desktop-activity-overlay-expanded-action-collapse')).toBeNull();
    });

    it('routes expanded overlay surface and row actions through the shared interaction bridge', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState({ expanded: true }));
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        await act(async () => {
            screen.pressByTestId('desktop-activity-overlay-expanded');
        });
        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded',
            data: { expanded: false },
        });

        emitDesktopActivityOverlayInteractionMock.mockClear();

        await act(async () => {
            screen.pressByTestId('desktop-activity-overlay-session-row-session-1');
        });
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'open-session:session-1',
            data: { sessionId: 'session-1' },
        });
    });

    it('routes direct expanded card actions through the shared interaction bridge', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            ...createWindowState({ expanded: true }),
            model: {
                ...createWindowState({ expanded: true }).model,
                collapsed: {
                    ...createWindowState({ expanded: true }).model.collapsed,
                    title: 'Permission required',
                    primaryCardKind: 'permission_request',
                },
                expanded: {
                    ...createWindowState({ expanded: true }).model.expanded,
                    rows: [],
                    cards: [
                        {
                            id: 'permission-1',
                            kind: 'permission_request',
                            requestId: 'permission-1',
                            sessionId: 'session-1',
                            title: 'Edit src/auth/middleware.ts',
                            summary: 'Approval is required before continuing.',
                            toolLabel: 'Claude asks',
                            questionText: null,
                            count: 1,
                            openActionIdentifier: 'open-session:session-1',
                            allowActionIdentifier: 'approve-permission',
                        },
                    ],
                },
            } as unknown as DesktopActivityOverlayWindowStatePayload['model'],
        });
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        await act(async () => {
            screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-1', 'allow'));
        });

        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'approve-permission',
            data: { requestId: 'permission-1', sessionId: 'session-1' },
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

    it('forces the web document background transparent only while the overlay window route is mounted', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState());
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const originalDocument = (globalThis as { document?: Document }).document;
        const fakeRoot = {
            style: {
                backgroundColor: 'rgb(255, 255, 255)',
                margin: '12px',
                padding: '12px',
            },
        };
        const fakeDocument = {
            createElement: () => ({
                id: '',
                nodeName: 'STYLE',
                textContent: '',
                remove: () => {},
            }),
            getElementById: (id: string) => (id === 'root' ? fakeRoot : null),
            head: { appendChild: () => {} },
            documentElement: {
                style: {
                    backgroundColor: 'rgb(255, 255, 255)',
                    background: 'rgb(255, 255, 255)',
                },
            },
            body: {
                style: {
                    backgroundColor: 'rgb(255, 255, 255)',
                    background: 'rgb(255, 255, 255)',
                    margin: '8px',
                    padding: '8px',
                    overflow: 'scroll',
                },
            },
        } as unknown as Document;

        (globalThis as { document?: Document }).document = fakeDocument;

        try {
            const screen = await renderRoute();

            expect(fakeDocument.documentElement.style.backgroundColor).toBe('transparent');
            expect(fakeDocument.body.style.backgroundColor).toBe('transparent');
            expect(fakeDocument.body.style.margin).toBe('0px');
            expect(fakeDocument.body.style.padding).toBe('0px');
            expect(fakeDocument.body.style.overflow).toBe('hidden');
            expect(fakeRoot.style.backgroundColor).toBe('transparent');
            expect(fakeRoot.style.margin).toBe('0px');
            expect(fakeRoot.style.padding).toBe('0px');

            await screen.unmount();

            expect(fakeDocument.documentElement.style.backgroundColor).toBe('rgb(255, 255, 255)');
            expect(fakeDocument.body.style.backgroundColor).toBe('rgb(255, 255, 255)');
            expect(fakeDocument.body.style.margin).toBe('8px');
            expect(fakeDocument.body.style.padding).toBe('8px');
            expect(fakeDocument.body.style.overflow).toBe('scroll');
            expect(fakeRoot.style.backgroundColor).toBe('rgb(255, 255, 255)');
            expect(fakeRoot.style.margin).toBe('12px');
            expect(fakeRoot.style.padding).toBe('12px');
        } finally {
            (globalThis as { document?: Document }).document = originalDocument;
        }
    });

    it('keeps the injected transparency stylesheet up to date when it already exists', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState());
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const originalDocument = (globalThis as { document?: Document }).document;
        const removeSpy = vi.fn();
        const existingStyleElement = {
            id: 'desktop-activity-overlay-transparent-style',
            nodeName: 'STYLE',
            textContent: '/* stale */',
            remove: removeSpy,
        };
        const fakeDocument = {
            createElement: () => {
                throw new Error('createElement should not be called when the style element already exists');
            },
            getElementById: (id: string) => (id === 'desktop-activity-overlay-transparent-style' ? existingStyleElement : null),
            head: { appendChild: () => {} },
            documentElement: {
                style: {
                    backgroundColor: 'rgb(255, 255, 255)',
                    background: 'rgb(255, 255, 255)',
                },
            },
            body: {
                style: {
                    backgroundColor: 'rgb(255, 255, 255)',
                    background: 'rgb(255, 255, 255)',
                    margin: '8px',
                    padding: '8px',
                    overflow: 'scroll',
                },
            },
        } as unknown as Document;

        (globalThis as { document?: Document }).document = fakeDocument;

        try {
            const screen = await renderRoute();

            expect(existingStyleElement.textContent).toContain('#expo-root');
            expect(existingStyleElement.textContent).toContain('#root > div > div > div');

            await screen.unmount();

            expect(removeSpy).not.toHaveBeenCalled();
        } finally {
            (globalThis as { document?: Document }).document = originalDocument;
        }
    });

    it('uses native host mode to resolve notch-integrated chrome while presentation mode stays automatic', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                expanded: true,
                placementDiagnostics: {
                    monitorSource: 'primary',
                    effectiveMonitor: { x: 0, y: 0, width: 1512, height: 982 },
                    anchor: 'top_center',
                    placementMode: 'anchored',
                    requestedHostMode: 'floating',
                    hostMode: 'notch_integrated',
                    displayContext: null,
                    effectiveOffsetX: 0,
                    effectiveOffsetY: 0,
                    computedPosition: { x: 576, y: 0 },
                },
                policy: {
                    ...createWindowState().policy,
                    presentationMode: 'automatic',
                    compactStyle: 'panel',
                },
            }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        expect(screen.findByTestId('desktop-activity-overlay-expanded-notch')).toBeTruthy();
    });

    it('keeps automatic chrome floating when host diagnostics are unavailable', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                placementDiagnostics: null,
            }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        expect(screen.findByTestId('desktop-activity-overlay-collapsed-floating')).toBeTruthy();
    });
});
