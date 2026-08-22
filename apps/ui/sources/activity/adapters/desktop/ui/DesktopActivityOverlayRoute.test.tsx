import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

import type { DesktopActivityOverlayWindowStatePayload } from '../runtime/desktopActivityOverlayBridge';
import { resolveDesktopActivityOverlayCardActionInstanceTestID } from './shared/desktopActivityOverlaySelectors.mjs';

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

const isDesktopHostMock = vi.hoisted(() => vi.fn(() => true));
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
const setDesktopActivityOverlayInputLockedMock = vi.hoisted(
    () => vi.fn<(locked: boolean) => Promise<void>>(async () => {}),
);
const applyDesktopActivityOverlayDragDeltaMock = vi.hoisted(
    () => vi.fn<(deltaX: number, deltaY: number) => Promise<void>>(async () => {}),
);
const releaseDesktopActivityOverlayDragVelocityMock = vi.hoisted(
    () => vi.fn<(payload: {
        pointerId: number | string;
        vx: number;
        vy: number;
        sampleWindowMs: number;
    }) => Promise<void>>(async () => {}),
);
const emitDesktopActivityOverlayInteractionMock = vi.hoisted(
    () => vi.fn<(payload: { actionIdentifier: string; data: Record<string, unknown> }) => Promise<void>>(async () => {}),
);
const executeDesktopActivityOverlayInteractionWithResultMock = vi.hoisted(
    () => vi.fn<(payload: { actionIdentifier: string; data: Record<string, unknown> }) => Promise<{ requestId: string; ok: boolean; errorCode?: string; error?: string }>>(
        async () => ({ requestId: 'test-request', ok: true }),
    ),
);
const showDesktopMainWindowMock = vi.hoisted(
    () => vi.fn<() => Promise<void>>(async () => {}),
);
const serverFetchMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const localSettingsState = vi.hoisted(() => ({
    petsCompanionSizeScale: 1,
    petsDismissedCompanionTrayItemKeys: [] as string[],
}));
const applyLocalSettingsMock = vi.hoisted(() => vi.fn());

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
    TextInput: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: (...args: unknown[]) => serverFetchMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            ...actual,
            useLocalSettings: () => ({
                ...localSettingsDefaults,
                petsCompanionSizeScale: localSettingsState.petsCompanionSizeScale,
                petsDismissedCompanionTrayItemKeys: localSettingsState.petsDismissedCompanionTrayItemKeys,
            }),
        },
    });
});

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => applyLocalSettingsMock,
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => isDesktopHostMock(),
}));

vi.mock('../runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => isDesktopActivityOverlayWindowContextMock(),
}));

vi.mock('../runtime/desktopActivityOverlayBridge', () => ({
    getDesktopActivityOverlayWindowState: () => getDesktopActivityOverlayWindowStateMock(),
    listenDesktopActivityOverlayWindowState: (handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        listenDesktopActivityOverlayWindowStateMock(handler),
    setDesktopActivityOverlayExpanded: (expanded: boolean) => setDesktopActivityOverlayExpandedMock(expanded),
    setDesktopActivityOverlayInputLocked: (locked: boolean) => setDesktopActivityOverlayInputLockedMock(locked),
    applyDesktopActivityOverlayDragDelta: (deltaX: number, deltaY: number) =>
        applyDesktopActivityOverlayDragDeltaMock(deltaX, deltaY),
    releaseDesktopActivityOverlayDragVelocity: (payload: {
        pointerId: number | string;
        vx: number;
        vy: number;
        sampleWindowMs: number;
    }) => releaseDesktopActivityOverlayDragVelocityMock(payload),
    emitDesktopActivityOverlayInteraction: (payload: { actionIdentifier: string; data: Record<string, unknown> }) =>
        emitDesktopActivityOverlayInteractionMock(payload),
    executeDesktopActivityOverlayInteractionWithResult: (payload: { actionIdentifier: string; data: Record<string, unknown> }) =>
        executeDesktopActivityOverlayInteractionWithResultMock(payload),
    showDesktopMainWindow: () => showDesktopMainWindowMock(),
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
                        serverId: 'server-1',
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
                        serverId: 'server-1',
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
            hoverExpandDelayMs: 500,
            expandedBehavior: 'click',
            interactiveCollapsed: true,
            presentationMode: 'automatic',
            clickAction: 'expand_overlay',
            density: 'compact',
            compactStyle: 'pill',
            showSessionCount: true,
            showPreviewText: false,
            quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
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
    beforeEach(() => {
        localSettingsState.petsCompanionSizeScale = 1;
        localSettingsState.petsDismissedCompanionTrayItemKeys = [];
        executeDesktopActivityOverlayInteractionWithResultMock.mockImplementation(
            async () => ({ requestId: 'test-request', ok: true }),
        );
    });

    afterEach(() => {
        isDesktopHostMock.mockReset();
        isDesktopActivityOverlayWindowContextMock.mockReset();
        getDesktopActivityOverlayWindowStateMock.mockReset();
        listenDesktopActivityOverlayWindowStateMock.mockReset();
        setDesktopActivityOverlayExpandedMock.mockReset();
        setDesktopActivityOverlayInputLockedMock.mockReset();
        applyDesktopActivityOverlayDragDeltaMock.mockReset();
        releaseDesktopActivityOverlayDragVelocityMock.mockReset();
        emitDesktopActivityOverlayInteractionMock.mockReset();
        executeDesktopActivityOverlayInteractionWithResultMock.mockReset();
        showDesktopMainWindowMock.mockReset();
        applyLocalSettingsMock.mockReset();
        serverFetchMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
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

    it('keeps notch chrome on the in-flight open progress when the route expands', async () => {
        vi.useFakeTimers();
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        const initialState = createWindowState({
            policy: {
                ...createWindowState().policy,
                presentationMode: 'notch_integrated',
            },
        });
        let stateListener: ((payload: DesktopActivityOverlayWindowStatePayload) => void) | null = null;
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(initialState);
        listenDesktopActivityOverlayWindowStateMock.mockImplementation(async (handler) => {
            stateListener = handler;
            return () => {};
        });

        const screen = await renderRoute();

        expect(screen.findByTestId('desktop-activity-overlay-collapsed')).toBeTruthy();

        await act(async () => {
            stateListener?.({
                ...initialState,
                expanded: true,
                model: {
                    ...initialState.model,
                    isExpanded: true,
                },
            });
        });

        const expandedStyle = flattenStyle(screen.findByTestId('desktop-activity-overlay-expanded')?.props.style);
        expect(expandedStyle).toEqual(expect.objectContaining({
            borderTopLeftRadius: 6,
            borderTopRightRadius: 6,
            borderBottomLeftRadius: 14,
            borderBottomRightRadius: 14,
        }));
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
            data: { expanded: true, reason: 'click' },
        });
    });

    it('leaves collapsed notch hover to native hit-testing in notch mode', async () => {
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

        expect(collapsedSurface?.props.onHoverIn).toBeUndefined();
        expect(collapsedSurface?.props.onHoverOut).toBeUndefined();
    });

    it('only auto-expands after a sustained hover in floating hover mode', async () => {
        vi.useFakeTimers();
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                policy: {
                    ...createWindowState().policy,
                    presentationMode: 'floating_overlay',
                    expandedBehavior: 'hover',
                    hoverExpandDelayMs: 500,
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
            await vi.advanceTimersByTimeAsync(499);
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
            await vi.advanceTimersByTimeAsync(500);
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(true);
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded',
            data: { expanded: true, reason: 'hover' },
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

    it('disposes a late-resolving overlay window state listener after unmount', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState({ expanded: false }));
        let resolveSubscription: (dispose: () => void) => void = () => {
            throw new Error('Expected deferred window-state subscription to capture its resolver.');
        };
        const deferredSubscription = new Promise<() => void>((resolve) => {
            resolveSubscription = resolve;
        });
        const disposeMock = vi.fn();
        listenDesktopActivityOverlayWindowStateMock.mockImplementation(() => deferredSubscription);

        const screen = await renderRoute();

        await screen.unmount();
        resolveSubscription(disposeMock);

        await act(async () => {
            await Promise.resolve();
        });

        expect(disposeMock).toHaveBeenCalledTimes(1);
    });

    it('reconciles native window state when the overlay window misses an expanded-state event', async () => {
        vi.useFakeTimers();
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock
            .mockResolvedValueOnce(createWindowState({ expanded: false }))
            .mockResolvedValue(createWindowState({ expanded: true }));
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        expect(screen.findByTestId('desktop-activity-overlay-collapsed')).toBeTruthy();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });

        expect(getDesktopActivityOverlayWindowStateMock.mock.calls.length).toBeGreaterThan(1);
        expect(screen.findByTestId('desktop-activity-overlay-collapsed')).toBeNull();
        expect(screen.findByTestId('desktop-activity-overlay-expanded')).toBeTruthy();
    });

    it('keeps expanded surface clicks inside the island without collapsing and routes row actions through the bridge', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState({ expanded: true }));
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        await act(async () => {
            screen.pressByTestId('desktop-activity-overlay-expanded');
        });
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
        expect(emitDesktopActivityOverlayInteractionMock).not.toHaveBeenCalled();

        emitDesktopActivityOverlayInteractionMock.mockClear();

        await act(async () => {
            screen.pressByTestId('desktop-activity-overlay-session-row-session-1');
        });
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'open-session:session-1?serverId=server-1',
            data: { sessionId: 'session-1', serverId: 'server-1' },
        });
    });

    it('collapses an expanded non-blocking island after hover leaves and cancels when hover returns', async () => {
        vi.useFakeTimers();
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState({ expanded: true }));
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();
        const expandedSurface = screen.findByTestId('desktop-activity-overlay-expanded');

        await act(async () => {
            invokeTestInstanceHandler(
                expandedSurface,
                'onHoverIn',
                undefined,
                'desktop-activity-overlay-expanded',
            );
        });
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-surface-engaged',
            data: { engaged: true },
        });

        emitDesktopActivityOverlayInteractionMock.mockClear();

        await act(async () => {
            invokeTestInstanceHandler(
                expandedSurface,
                'onHoverOut',
                undefined,
                'desktop-activity-overlay-expanded',
            );
            await vi.advanceTimersByTimeAsync(1_499);
        });
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();

        await act(async () => {
            invokeTestInstanceHandler(
                expandedSurface,
                'onHoverIn',
                undefined,
                'desktop-activity-overlay-expanded',
            );
            await vi.advanceTimersByTimeAsync(2);
        });
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();

        await act(async () => {
            invokeTestInstanceHandler(
                expandedSurface,
                'onHoverOut',
                undefined,
                'desktop-activity-overlay-expanded',
            );
            await vi.advanceTimersByTimeAsync(1_500);
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-surface-engaged',
            data: { engaged: false },
        });
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded',
            data: { expanded: false, reason: 'outside_hover' },
        });
    });

    it('does not hover-collapse an expanded island while a permission or question card is actionable', async () => {
        vi.useFakeTimers();
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
        const expandedSurface = screen.findByTestId('desktop-activity-overlay-expanded');

        await act(async () => {
            invokeTestInstanceHandler(
                expandedSurface,
                'onHoverOut',
                undefined,
                'desktop-activity-overlay-expanded',
            );
            await vi.advanceTimersByTimeAsync(2_000);
        });

        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalled();
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-surface-engaged',
            data: { engaged: false },
        });
        expect(emitDesktopActivityOverlayInteractionMock).not.toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded',
            data: { expanded: false, reason: 'outside_hover' },
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
            data: { requestId: 'permission-1', sessionId: 'session-1', decision: 'allow' },
        });
    });

    it('sends quick reply phrase chips through the shared interaction bridge', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            ...createWindowState({ expanded: true }),
            model: {
                ...createWindowState({ expanded: true }).model,
                expanded: {
                    ...createWindowState({ expanded: true }).model.expanded,
                    quickReply: {
                        targetSessionId: 'session-1',
                        serverId: 'server-1',
                        phrases: ['Continue', 'Explain'],
                    },
                },
            } as DesktopActivityOverlayWindowStatePayload['model'],
        });
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        await act(async () => {
            screen.pressByTestId('desktop-activity-overlay-quick-reply-phrase-Continue');
            await Promise.resolve();
        });

        expect(executeDesktopActivityOverlayInteractionWithResultMock).toHaveBeenCalledWith({
            actionIdentifier: 'session.message.send',
            data: {
                sessionId: 'session-1',
                serverId: 'server-1',
                message: 'Continue',
            },
        });
    });

    it('sends custom quick reply drafts and keeps empty drafts local', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            ...createWindowState({ expanded: true }),
            model: {
                ...createWindowState({ expanded: true }).model,
                expanded: {
                    ...createWindowState({ expanded: true }).model.expanded,
                    quickReply: {
                        targetSessionId: 'session-1',
                        serverId: 'server-1',
                        phrases: ['Continue'],
                    },
                },
            } as DesktopActivityOverlayWindowStatePayload['model'],
        });
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();
        const inputShell = screen.findByTestId('desktop-activity-overlay-quick-reply-input-shell');
        const input = screen.findByTestId('desktop-activity-overlay-quick-reply-input');
        const sendButton = screen.findByTestId('desktop-activity-overlay-quick-reply-send');
        const inputShellStyle = flattenStyle(inputShell?.props.style);
        const inputStyle = flattenStyle(input?.props.style);
        const sendButtonStyle = flattenStyle(sendButton?.props.style);

        expect(inputShellStyle.position).toBe('relative');
        expect(inputStyle.paddingRight).toBeGreaterThan(36);
        expect(sendButtonStyle.position).toBe('absolute');
        expect(sendButtonStyle.right).toBeGreaterThanOrEqual(3);
        expect(sendButtonStyle.top).toBeGreaterThan(0);
        expect(sendButtonStyle.width).toBeLessThanOrEqual(28);
        expect(sendButtonStyle.width).toBe(sendButtonStyle.height);
        expect(sendButtonStyle.borderRadius).toBe((sendButtonStyle.width as number) / 2);
        expect(screen.root.findAll((node) => node.props?.name === 'arrow-up')).toHaveLength(1);

        await act(async () => {
            screen.pressByTestId('desktop-activity-overlay-quick-reply-send');
            await Promise.resolve();
        });
        expect(executeDesktopActivityOverlayInteractionWithResultMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ actionIdentifier: 'session.message.send' }),
        );

        await act(async () => {
            screen.changeTextByTestId('desktop-activity-overlay-quick-reply-input', '  Looks good  ');
        });
        const stopPropagation = vi.fn();
        await act(async () => {
            invokeTestInstanceHandler(inputShell, 'onPress', { stopPropagation });
            invokeTestInstanceHandler(input, 'onPress', { stopPropagation });
            invokeTestInstanceHandler(input, 'onPressIn', { stopPropagation });
        });
        expect(stopPropagation).toHaveBeenCalled();
        expect(emitDesktopActivityOverlayInteractionMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ actionIdentifier: 'session.open' }),
        );

        await act(async () => {
            screen.pressByTestId('desktop-activity-overlay-quick-reply-send');
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(executeDesktopActivityOverlayInteractionWithResultMock).toHaveBeenCalledWith({
            actionIdentifier: 'session.message.send',
            data: {
                sessionId: 'session-1',
                serverId: 'server-1',
                message: 'Looks good',
            },
        });
        expect(screen.findByTestId('desktop-activity-overlay-quick-reply-input')?.props.value).toBe('');
    });

    it('shows quick reply send failures and preserves the typed draft', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        executeDesktopActivityOverlayInteractionWithResultMock.mockResolvedValue({
            requestId: 'quick-reply-request-1',
            ok: false,
            errorCode: 'action_failed',
            error: 'action_failed',
        });
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            ...createWindowState({ expanded: true }),
            model: {
                ...createWindowState({ expanded: true }).model,
                expanded: {
                    ...createWindowState({ expanded: true }).model.expanded,
                    quickReply: {
                        targetSessionId: 'session-1',
                        serverId: 'server-1',
                        phrases: ['Continue'],
                    },
                },
            } as DesktopActivityOverlayWindowStatePayload['model'],
        });
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        await act(async () => {
            screen.changeTextByTestId('desktop-activity-overlay-quick-reply-input', 'Please retry');
        });
        await act(async () => {
            screen.pressByTestId('desktop-activity-overlay-quick-reply-send');
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(screen.findByTestId('desktop-activity-overlay-quick-reply-error')).toBeTruthy();
        expect(screen.findByTestId('desktop-activity-overlay-quick-reply-input')?.props.value).toBe('Please retry');
        expect(executeDesktopActivityOverlayInteractionWithResultMock).toHaveBeenCalledWith({
            actionIdentifier: 'session.message.send',
            data: {
                sessionId: 'session-1',
                serverId: 'server-1',
                message: 'Please retry',
            },
        });
    });

    it('keeps quick reply drafts local when the target lacks server scope', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            ...createWindowState({ expanded: true }),
            model: {
                ...createWindowState({ expanded: true }).model,
                expanded: {
                    ...createWindowState({ expanded: true }).model.expanded,
                    quickReply: {
                        targetSessionId: 'session-1',
                        serverId: null,
                        phrases: ['Continue'],
                    },
                },
            } as DesktopActivityOverlayWindowStatePayload['model'],
        });
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        await act(async () => {
            screen.changeTextByTestId('desktop-activity-overlay-quick-reply-input', 'Keep this reply');
        });
        await act(async () => {
            screen.pressByTestId('desktop-activity-overlay-quick-reply-send');
            await Promise.resolve();
        });

        expect(screen.findByTestId('desktop-activity-overlay-quick-reply-input')?.props.value).toBe('Keep this reply');
        expect(screen.findByTestId('desktop-activity-overlay-quick-reply-no-target')).toBeTruthy();
        expect(executeDesktopActivityOverlayInteractionWithResultMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ actionIdentifier: 'session.message.send' }),
        );
    });

    it('preserves a dirty quick reply draft when its target session disappears', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        let stateListener: ((payload: DesktopActivityOverlayWindowStatePayload) => void) | null = null;
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            ...createWindowState({ expanded: true }),
            model: {
                ...createWindowState({ expanded: true }).model,
                expanded: {
                    ...createWindowState({ expanded: true }).model.expanded,
                    quickReply: {
                        targetSessionId: 'session-1',
                        serverId: null,
                        phrases: ['Continue'],
                    },
                },
            } as DesktopActivityOverlayWindowStatePayload['model'],
        });
        listenDesktopActivityOverlayWindowStateMock.mockImplementation(async (handler) => {
            stateListener = handler;
            return () => {};
        });

        const screen = await renderRoute();

        await act(async () => {
            screen.changeTextByTestId('desktop-activity-overlay-quick-reply-input', 'Keep this reply');
        });
        await act(async () => {
            stateListener?.({
                ...createWindowState({ expanded: true }),
                model: {
                    ...createWindowState({ expanded: true }).model,
                    expanded: {
                        ...createWindowState({ expanded: true }).model.expanded,
                        rows: [],
                        cards: [],
                        quickReply: null,
                    },
                } as DesktopActivityOverlayWindowStatePayload['model'],
            });
            await Promise.resolve();
        });

        expect(screen.findByTestId('desktop-activity-overlay-quick-reply-input')?.props.value).toBe('Keep this reply');
        expect(screen.findByTestId('desktop-activity-overlay-quick-reply-no-target')).toBeTruthy();

        executeDesktopActivityOverlayInteractionWithResultMock.mockClear();
        await act(async () => {
            screen.pressByTestId('desktop-activity-overlay-quick-reply-send');
            await Promise.resolve();
        });

        expect(executeDesktopActivityOverlayInteractionWithResultMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ actionIdentifier: 'session.message.send' }),
        );
    });

    it('keeps the expanded island open and native-locked while quick reply is focused or dirty', async () => {
        vi.useFakeTimers();
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            ...createWindowState({ expanded: true }),
            model: {
                ...createWindowState({ expanded: true }).model,
                expanded: {
                    ...createWindowState({ expanded: true }).model.expanded,
                    quickReply: {
                        targetSessionId: 'session-1',
                        serverId: null,
                        phrases: ['Continue'],
                    },
                },
            } as DesktopActivityOverlayWindowStatePayload['model'],
        });
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();
        const input = screen.findByTestId('desktop-activity-overlay-quick-reply-input');

        await act(async () => {
            invokeTestInstanceHandler(input, 'onFocus', undefined, 'desktop-activity-overlay-quick-reply-input');
            await vi.advanceTimersByTimeAsync(1_600);
        });

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-activity-overlay-expanded'),
                'onHoverOut',
                undefined,
                'desktop-activity-overlay-expanded',
            );
            await vi.advanceTimersByTimeAsync(1_600);
        });

        expect(setDesktopActivityOverlayInputLockedMock).toHaveBeenCalledWith(true);
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalledWith(false);

        await act(async () => {
            invokeTestInstanceHandler(input, 'onBlur', undefined, 'desktop-activity-overlay-quick-reply-input');
            screen.changeTextByTestId('desktop-activity-overlay-quick-reply-input', 'keep this draft');
            await vi.advanceTimersByTimeAsync(1_600);
        });

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-activity-overlay-expanded'),
                'onHoverOut',
                undefined,
                'desktop-activity-overlay-expanded',
            );
            await vi.advanceTimersByTimeAsync(1_600);
        });

        expect(setDesktopActivityOverlayInputLockedMock).toHaveBeenCalledWith(true);
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-input-locked',
            data: { locked: true },
        });
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-surface-engaged',
            data: { engaged: false },
        });
        expect(setDesktopActivityOverlayInputLockedMock).not.toHaveBeenLastCalledWith(false);
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalledWith(false);
    });

    it('renews the native quick reply input lock while the composer stays locked', async () => {
        vi.useFakeTimers();
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            ...createWindowState({ expanded: true }),
            model: {
                ...createWindowState({ expanded: true }).model,
                expanded: {
                    ...createWindowState({ expanded: true }).model.expanded,
                    quickReply: {
                        targetSessionId: 'session-1',
                        serverId: null,
                        phrases: ['Continue'],
                    },
                },
            } as DesktopActivityOverlayWindowStatePayload['model'],
        });
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-activity-overlay-quick-reply-input'),
                'onFocus',
                undefined,
                'desktop-activity-overlay-quick-reply-input',
            );
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(
            setDesktopActivityOverlayInputLockedMock.mock.calls.filter(([locked]) => locked === true),
        ).toHaveLength(2);
    });

    it('closes from Escape only when the quick reply draft is clean', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({
            ...createWindowState({ expanded: true }),
            model: {
                ...createWindowState({ expanded: true }).model,
                expanded: {
                    ...createWindowState({ expanded: true }).model.expanded,
                    quickReply: {
                        targetSessionId: 'session-1',
                        serverId: null,
                        phrases: ['Continue'],
                    },
                },
            } as DesktopActivityOverlayWindowStatePayload['model'],
        });
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();
        const input = screen.findByTestId('desktop-activity-overlay-quick-reply-input');

        await act(async () => {
            screen.changeTextByTestId('desktop-activity-overlay-quick-reply-input', 'draft');
            invokeTestInstanceHandler(
                input,
                'onKeyPress',
                { nativeEvent: { key: 'Escape' } },
                'desktop-activity-overlay-quick-reply-input',
            );
        });
        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalledWith(false);

        await act(async () => {
            screen.changeTextByTestId('desktop-activity-overlay-quick-reply-input', '');
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-activity-overlay-quick-reply-input'),
                'onKeyPress',
                { nativeEvent: { key: 'Escape' } },
                'desktop-activity-overlay-quick-reply-input',
            );
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded',
            data: { expanded: false, reason: 'keyboard_escape' },
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
            expect(existingStyleElement.textContent).not.toContain('#root *, #app *, #expo-root *');

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
        const motionFrames = screen.tree.root.findAllByType('Animated.View' as never);
        expect(motionFrames.length).toBeGreaterThan(0);
        expect(flattenStyle(motionFrames[0]?.props.style)).not.toHaveProperty('transform');
    });

    it('passes native physical notch width into the collapsed camera spacer', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(
            createWindowState({
                placementDiagnostics: {
                    monitorSource: 'primary',
                    effectiveMonitor: { x: 0, y: 0, width: 1512, height: 982 },
                    anchor: 'top_center',
                    placementMode: 'anchored',
                    requestedHostMode: 'floating',
                    hostMode: 'notch_integrated',
                    displayContext: {
                        isMacos: true,
                        isBuiltinDisplay: true,
                        hasPhysicalNotch: true,
                        safeAreaTop: 38,
                        physicalNotchSize: { width: 228, height: 38 },
                        screenFrame: { x: 0, y: 0, width: 1512, height: 982 },
                        visibleFrame: { x: 0, y: 38, width: 1512, height: 944 },
                    },
                    effectiveOffsetX: 0,
                    effectiveOffsetY: 0,
                    computedPosition: { x: 644, y: 0 },
                },
                policy: {
                    ...createWindowState().policy,
                    presentationMode: 'automatic',
                    compactStyle: 'pill',
                },
            }),
        );
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});

        const screen = await renderRoute();

        expect(flattenStyle(screen.findByTestId('desktop-activity-overlay-camera-spacer')?.props.style)).toEqual(
            expect.objectContaining({ minWidth: 79.8 }),
        );
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
