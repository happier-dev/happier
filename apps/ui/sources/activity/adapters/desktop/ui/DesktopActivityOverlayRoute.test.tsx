// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

import type {
    DesktopActivityOverlayPointer,
    DesktopActivityOverlayPresent,
    DesktopActivityOverlayWindowStatePayload,
} from '../runtime/desktopActivityOverlayBridge';
import { resolveDesktopActivityOverlayCardActionInstanceTestID } from './shared/desktopActivityOverlaySelectors.mjs';

const isDesktopHostMock = vi.hoisted(() => vi.fn(() => true));
const isDesktopActivityOverlayWindowContextMock = vi.hoisted(() => vi.fn(() => true));
const getDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<() => Promise<DesktopActivityOverlayWindowStatePayload | null>>(),
);
const listenDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<(handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) => Promise<() => void>>(async () => () => {}),
);
const presentDesktopActivityOverlayMock = vi.hoisted(() => vi.fn<(payload: DesktopActivityOverlayPresent) => Promise<void>>(async () => {}));
const pointer = vi.hoisted(() => ({ handler: null as ((event: DesktopActivityOverlayPointer) => void) | null }));
const presentation = vi.hoisted(() => ({ handler: null as ((request: { state: 'rest' | 'open' | 'pinned'; focus: boolean }) => void) | null }));
const emitDesktopActivityOverlayInteractionMock = vi.hoisted(
    () => vi.fn<(payload: { actionIdentifier: string; data: Record<string, unknown> }) => Promise<void>>(async () => {}),
);
const executeDesktopActivityOverlayInteractionWithResultMock = vi.hoisted(
    () => vi.fn<(payload: { actionIdentifier: string; data: Record<string, unknown> }) => Promise<{ requestId: string; ok: boolean; result?: unknown }>>(
        async () => ({ requestId: 'test-request', ok: true }),
    ),
);

// The Agent mark reads the machine-scoped Agent catalog (plugins, sync scope); this render test only needs
// its presence, so it draws a named leaf instead of loading that graph.
vi.mock('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon', () => ({
    SessionAgentCatalogIdentityIcon: (props: Record<string, unknown>) => React.createElement('SessionAgentCatalogIdentityIcon', props),
}));
// The overlay is a web view: Bot faces draw through the web raster, and Skia is the native boundary.
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// The browser recycler is the platform boundary; keep the real overlay list, rows and actions.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({
        refHandle: { getScrollableNode: vi.fn(() => ({ clientWidth: 480, clientHeight: 320 })) },
        resolveState: () => ({ contentLength: 0, listen: () => () => {} }),
    });
});
vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/utils/platform/desktopHost', () => ({
    desktopHostKind: () => null,
    isDesktopHost: () => isDesktopHostMock(),
}));
// The OS preference is the environment boundary; everything under it stays real.
const reducedMotion = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({ useReducedMotionPreference: () => reducedMotion.value }));
const setDesktopGlassPanelShapeMock = vi.hoisted(() => vi.fn(async (_radius: number | null, _frame?: unknown) => {}));
vi.mock('@/utils/platform/desktopGlassMaterial', () => ({
    setDesktopGlassPanelShape: setDesktopGlassPanelShapeMock,
}));
vi.mock('../runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => isDesktopActivityOverlayWindowContextMock(),
}));
// The overlay ↔ main window action channel (N4 M6) is the IPC boundary for the pinned Session draft:
// the watch answers with that Session's own draft, and every write is recorded.
const draftIpc = vi.hoisted(() => ({
    drafts: {} as Record<string, string>,
    writes: [] as Array<{ sessionId: string; text: string; expectedRevision: number }>,
    nextWriteError: null as string | null,
}));
vi.mock('../runtime/desktopActivityOverlayActions', () => ({
    watchDesktopActivityOverlaySessionDraft: async (
        target: { sessionId: string },
        onSnapshot: (snapshot: { revision: number; text: string } | null) => void,
    ) => {
        onSnapshot({ revision: 1, text: draftIpc.drafts[target.sessionId] ?? '' });
        return async () => {};
    },
    executeDesktopActivityOverlayAction: async (input: { request: { input: {
        ref: { sessionId: string }; transaction: { expectedRevision: number; operations: Array<{ text: string }> } } } }) => {
        const { ref, transaction } = input.request.input;
        draftIpc.writes.push({ sessionId: ref.sessionId, text: transaction.operations[0]!.text, expectedRevision: transaction.expectedRevision });
        if (draftIpc.nextWriteError) {
            const errorCode = draftIpc.nextWriteError;
            draftIpc.nextWriteError = null;
            return { ok: false, errorCode, error: errorCode };
        }
        draftIpc.drafts[ref.sessionId] = transaction.operations[0]!.text;
        return { ok: true, result: { status: 'applied', revision: transaction.expectedRevision + 1 } };
    },
}));
// The Tauri IPC bridge is the boundary: window state in, `present` and interactions out, pointer events in.
const keyboardWanted = vi.hoisted(() => ({ calls: [] as boolean[] }));
const alertError = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: alertError } }).module;
});

vi.mock('../runtime/desktopActivityOverlayBridge', () => ({
    getDesktopActivityOverlayWindowState: () => getDesktopActivityOverlayWindowStateMock(),
    listenDesktopActivityOverlayWindowState: (handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        listenDesktopActivityOverlayWindowStateMock(handler),
    presentDesktopActivityOverlay: (payload: DesktopActivityOverlayPresent) => presentDesktopActivityOverlayMock(payload),
    listenDesktopActivityOverlayPointer: async (handler: (event: DesktopActivityOverlayPointer) => void) => {
        pointer.handler = handler;
        return () => { pointer.handler = null; };
    },
    enterDesktopActivityOverlayPointer: async () => {},
    setDesktopActivityOverlayKeyboardWanted: async (wanted: boolean) => { keyboardWanted.calls.push(wanted); },
    listenDesktopActivityOverlayPresentation: async (handler: (request: { state: 'rest' | 'open' | 'pinned'; focus: boolean }) => void) => {
        presentation.handler = handler;
        return () => { presentation.handler = null; };
    },
    emitDesktopActivityOverlayInteraction: (payload: { actionIdentifier: string; data: Record<string, unknown> }) =>
        emitDesktopActivityOverlayInteractionMock(payload),
    executeDesktopActivityOverlayInteractionWithResult: (payload: { actionIdentifier: string; data: Record<string, unknown> }) =>
        executeDesktopActivityOverlayInteractionWithResultMock(payload),
}));

type OverlayModel = DesktopActivityOverlayWindowStatePayload['model'];

function createWindowState(
    overrides: Partial<DesktopActivityOverlayWindowStatePayload> = {},
    expanded: Partial<OverlayModel['expanded']> = {},
): DesktopActivityOverlayWindowStatePayload {
    const model: OverlayModel = {
        visible: true,
        generatedAt: 1,
        collapsed: {
            title: 'Needs you',
            statusText: null,
            defaultTarget: 'open-primary-session',
            sessionCount: 2,
            primaryCardKind: 'session_overview',
            activity: 'needsYou',
        },
        expanded: {
            title: 'Active sessions',
            rows: [{
                sessionId: 'session-1', serverId: 'server-1', title: 'Session One', subtitle: 'Repo',
                statusText: 'Needs attention', previewText: null,
            }],
            cards: [{
                id: 'session-overview-1', kind: 'session_overview', sessionId: 'session-1', serverId: 'server-1',
                title: 'Session One', subtitle: 'Repo', statusText: 'Needs attention', previewText: null,
                attentionState: 'permission_required', active: true, updatedAt: 1,
            }],
            ...expanded,
        },
    } as unknown as OverlayModel;
    return {
        visible: true,
        model,
        policy: {
            enabled: true, visibilityMode: 'attention_only', alwaysOnTop: true, hoverExpandDelayMs: 500, dock: 'top', idle: 'tip',
            botConversationPresentation: 'overlay', quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
        },
        ...overrides,
    };
}

async function renderRoute(state: DesktopActivityOverlayWindowStatePayload, options: Parameters<typeof renderScreen>[1] = {}) {
    getDesktopActivityOverlayWindowStateMock.mockResolvedValue(state);
    const { DesktopActivityOverlayRoute } = await import('./DesktopActivityOverlayRoute');
    const screen = await renderScreen(<DesktopActivityOverlayRoute />, options);
    await flushHookEffects();
    return screen;
}

function notchForm(screen: Awaited<ReturnType<typeof renderRoute>>): string | undefined {
    return screen.findByTestId('desktop-activity-overlay-notch-body')?.props['data-notch-form'];
}

async function openFromKeyboard(screen: Awaited<ReturnType<typeof renderRoute>>) {
    await act(async () => {
        invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-collapsed'), 'onKeyDownCapture',
            keyEvent('Enter'), 'desktop-activity-overlay-collapsed');
        screen.pressByTestId('desktop-activity-overlay-collapsed');
    });
    await flushHookEffects();
}

/**
 * Records which host node the island focuses. `react-test-renderer` resolves host refs through
 * `createNodeMock`, so this is how a renderer test observes programmatic focus transfer.
 */
function createFocusRecorder() {
    const focusedTestIds: string[] = [];
    return {
        focusedTestIds,
        createNodeMock: (element: Parameters<NonNullable<NonNullable<Parameters<typeof renderScreen>[1]>['createNodeMock']>>[0]) => ({
            focus: () => {
                const testID = typeof element.props === 'object' && element.props !== null && 'testID' in element.props
                    ? element.props.testID : undefined;
                focusedTestIds.push(String(testID ?? element.type));
            },
        }),
    };
}

function keyEvent(key: string) {
    return { key, nativeEvent: { key } };
}

describe('DesktopActivityOverlayRoute', () => {
    // The route's first import transforms the whole island graph once; later imports reuse it.
    beforeAll(async () => { await import('./DesktopActivityOverlayRoute'); }, 240_000);

    beforeEach(() => {
        vi.resetModules();
        isDesktopHostMock.mockReturnValue(true);
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(true);
        listenDesktopActivityOverlayWindowStateMock.mockImplementation(async () => () => {});
        executeDesktopActivityOverlayInteractionWithResultMock.mockImplementation(async () => ({ requestId: 'test-request', ok: true }));
    });

    afterEach(() => {
        draftIpc.nextWriteError = null;
        getDesktopActivityOverlayWindowStateMock.mockReset();
        listenDesktopActivityOverlayWindowStateMock.mockReset();
        reducedMotion.value = false;
        presentDesktopActivityOverlayMock.mockReset();
        emitDesktopActivityOverlayInteractionMock.mockReset();
        executeDesktopActivityOverlayInteractionWithResultMock.mockReset();
        pointer.handler = null;
        presentation.handler = null;
        vi.useRealTimers();
    });

    it('renders a loading placeholder before the overlay state arrives', async () => {
        getDesktopActivityOverlayWindowStateMock.mockImplementation(() => new Promise(() => {}));
        const { DesktopActivityOverlayRoute } = await import('./DesktopActivityOverlayRoute');
        const screen = await renderScreen(<DesktopActivityOverlayRoute />);
        expect(screen.findByTestId('desktop-activity-overlay-loading')).toBeTruthy();
    });

    it('renders hidden state and reads nothing outside the overlay window', async () => {
        isDesktopActivityOverlayWindowContextMock.mockReturnValue(false);
        const screen = await renderRoute(createWindowState());
        expect(screen.findByTestId('desktop-activity-overlay-hidden')).toBeTruthy();
        expect(getDesktopActivityOverlayWindowStateMock).not.toHaveBeenCalled();
    });

    it('rests as the tip when nothing needs you, and as nothing when When idle is Hidden', async () => {
        const tip = await renderRoute(createWindowState({ visible: false }));
        expect(notchForm(tip)).toBe('tip');
        await tip.unmount();

        vi.resetModules();
        const base = createWindowState({ visible: false });
        const hidden = await renderRoute({ ...base, policy: { ...base.policy, idle: 'hidden' } });
        expect(hidden.findByTestId('desktop-activity-overlay-hidden')).toBeTruthy();
        expect(hidden.findByTestId('desktop-activity-overlay-notch-body')).toBeNull();
        // Hidden orders the window out through the one presentation command.
        expect(presentDesktopActivityOverlayMock).toHaveBeenLastCalledWith(expect.objectContaining({ surface: 'hidden', settled: true }));
    });

    it('grows the tip into the standard island after the policy dwell, and only then', async () => {
        vi.useFakeTimers();
        const screen = await renderRoute(createWindowState({ visible: false }));
        expect(notchForm(screen)).toBe('tip');

        // A pass shorter than the dwell never grows it.
        await act(async () => { pointer.handler?.({ kind: 'enter' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        await act(async () => { pointer.handler?.({ kind: 'leave' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(notchForm(screen)).toBe('tip');

        await act(async () => { pointer.handler?.({ kind: 'enter' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(notchForm(screen)).toBe('standard');
    });

    it('opens a collapsed island after one hover dwell and cancels short crossings', async () => {
        vi.useFakeTimers();
        const screen = await renderRoute(createWindowState());
        expect(notchForm(screen)).toBe('standard');

        await act(async () => { pointer.handler?.({ kind: 'enter' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        await act(async () => { pointer.handler?.({ kind: 'leave' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(notchForm(screen)).toBe('standard');

        await act(async () => { pointer.handler?.({ kind: 'enter' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(499); });
        expect(notchForm(screen)).toBe('standard');
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(notchForm(screen)).toBe('open');
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded', data: { expanded: true },
        });
    });

    it('opens on a click, tells native the new extent before moving, and acquires detail demand', async () => {
        const screen = await renderRoute(createWindowState());
        expect(notchForm(screen)).toBe('standard');
        presentDesktopActivityOverlayMock.mockClear();

        await act(async () => { screen.pressByTestId('desktop-activity-overlay-collapsed'); });
        await flushHookEffects();

        expect(notchForm(screen)).toBe('open');
        expect(presentDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            surface: 'expanded', engaged: true, settled: false,
        }));
        expect(emitDesktopActivityOverlayInteractionMock).toHaveBeenCalledWith({
            actionIdentifier: 'overlay-set-expanded',
            data: { expanded: true },
        });
    });

    it('balances detail demand once for Action opens, native closes and repeated presentation requests', async () => {
        vi.useFakeTimers();
        const screen = await renderRoute(createWindowState());
        const demand = () => emitDesktopActivityOverlayInteractionMock.mock.calls
            .map(([call]) => call).filter(call => call.actionIdentifier === 'overlay-set-expanded').map(call => call.data);
        expect(demand()).toEqual([]);
        await act(async () => { presentation.handler?.({ state: 'open', focus: false }); });
        expect(demand()).toEqual([{ expanded: true }]);
        await act(async () => { presentation.handler?.({ state: 'open', focus: false }); });
        expect(demand()).toHaveLength(1);
        await act(async () => { pointer.handler?.({ kind: 'outsidePress' }); });
        expect(demand()).toEqual([{ expanded: true }, { expanded: false }]);
        await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
        await act(async () => { presentation.handler?.({ state: 'open', focus: false }); });
        expect(demand().slice(2)).toEqual([{ expanded: true }, { expanded: true, target: null }]);
        await act(async () => { pointer.handler?.({ kind: 'enter' }); pointer.handler?.({ kind: 'leave' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
        expect(notchForm(screen)).toBe('standard');
        expect(demand().slice(4)).toEqual([{ expanded: false }]);
        await act(async () => { presentation.handler?.({ state: 'rest', focus: false }); });
        expect(demand()).toHaveLength(5);
    });

    it('collapses an open island after the pointer has been gone the leave delay, unless an ask card holds it', async () => {
        vi.useFakeTimers();
        const screen = await renderRoute(createWindowState());
        await act(async () => { screen.pressByTestId('desktop-activity-overlay-collapsed'); });
        await act(async () => { pointer.handler?.({ kind: 'enter' }); pointer.handler?.({ kind: 'leave' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
        expect(notchForm(screen)).toBe('standard');
        await screen.unmount();

        vi.resetModules();
        const asking = await renderRoute(createWindowState({}, {
            rows: [],
            cards: [{
                id: 'permission-1', kind: 'permission_request', requestId: 'permission-1', sessionId: 'session-1',
                serverId: 'server-1', title: 'Edit src/auth/middleware.ts', summary: null, toolLabel: 'Claude asks',
                questionText: null, count: 1, openActionIdentifier: 'open-session:session-1', allowActionIdentifier: 'approve-permission',
            }],
        } as Partial<OverlayModel['expanded']>));
        await act(async () => { asking.pressByTestId('desktop-activity-overlay-collapsed'); });
        await act(async () => { pointer.handler?.({ kind: 'enter' }); pointer.handler?.({ kind: 'leave' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(notchForm(asking)).toBe('open');
    });

    it('keeps the opened list open while its pin is on, and lets it collapse again once unpinned', async () => {
        vi.useFakeTimers();
        const screen = await renderRoute(createWindowState());
        await act(async () => { screen.pressByTestId('desktop-activity-overlay-collapsed'); });
        await act(async () => { screen.pressByTestId('desktop-activity-overlay-pin'); });
        await act(async () => { pointer.handler?.({ kind: 'enter' }); pointer.handler?.({ kind: 'leave' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(notchForm(screen)).toBe('open');

        await act(async () => { screen.pressByTestId('desktop-activity-overlay-pin'); });
        await act(async () => { pointer.handler?.({ kind: 'enter' }); pointer.handler?.({ kind: 'leave' }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
        expect(notchForm(screen)).toBe('standard');
    });

    it('keeps approval choices until the result succeeds, preserving them and the error on failure', async () => {
        const response = createDeferred<{ requestId: string; ok: boolean; error?: string }>();
        executeDesktopActivityOverlayInteractionWithResultMock.mockReturnValueOnce(response.promise);
        const screen = await renderRoute(createWindowState({}, {
            rows: [],
            cards: [{
                id: 'permission-1', kind: 'permission_request', requestId: 'permission-1', sessionId: 'session-1',
                serverId: null, title: 'Edit src/auth/middleware.ts', summary: 'Approval is required before continuing.',
                toolLabel: 'Claude asks', questionText: null, count: 1, openActionIdentifier: 'open-session:session-1',
                allowActionIdentifier: 'approve-permission',
                actions: [{ id: 'allow', label: 'Allow', actionIdentifier: 'approve-permission', data: { requestId: 'permission-1', sessionId: 'session-1', decision: 'allow' }, tone: 'primary' }],
            }],
        } as Partial<OverlayModel['expanded']>));
        await act(async () => { screen.pressByTestId('desktop-activity-overlay-collapsed'); });
        await act(async () => {
            screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-1', 'allow'));
        });
        expect(executeDesktopActivityOverlayInteractionWithResultMock).toHaveBeenCalledWith({
            actionIdentifier: 'approve-permission',
            data: { requestId: 'permission-1', sessionId: 'session-1', decision: 'allow' },
        });
        expect(screen.findByTestId('desktop-activity-overlay-card-answered-permission-1')).toBeNull();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-1', 'allow'))).toBeTruthy();
        await act(async () => { response.resolve({ requestId: 'r', ok: false, error: 'Approval could not be delivered' }); });
        expect(screen.findByTestId('desktop-activity-overlay-card-answered-permission-1')).toBeNull();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-1', 'allow'))).toBeTruthy();
        expect(alertError).toHaveBeenCalledWith('common.error', 'Approval could not be delivered');

        await act(async () => { screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-1', 'allow')); });
        expect(screen.findByTestId('desktop-activity-overlay-card-answered-permission-1')).toBeTruthy();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-1', 'allow'))).toBeNull();
    });

    it('takes the keyboard when Other opens its answer field, and not for an answer chip', async () => {
        keyboardWanted.calls = [];
        const question = {
            id: 'question:q-1', kind: 'user_question', requestId: 'q-1', sessionId: 'session-1', serverId: 'server-1',
            title: 'Which target?', summary: 'Which target?', toolLabel: 'Ask', questionText: 'Which target?', count: 1,
            openActionIdentifier: 'open-session:session-1',
            actions: [
                { id: 'prod', label: 'Production', actionIdentifier: 'answer', data: {}, tone: 'secondary' },
                { id: 'other', label: 'Other', actionIdentifier: 'answer', data: {}, tone: 'secondary', inputKind: 'inline_text' },
            ],
        };
        const screen = await renderRoute(createWindowState({}, { cards: [question] } as Partial<OverlayModel['expanded']>));
        await act(async () => { screen.pressByTestId('desktop-activity-overlay-collapsed'); });
        await flushHookEffects();
        expect(keyboardWanted.calls).toEqual([]);

        await act(async () => { screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(question.id, 'other')); });
        await flushHookEffects();
        expect(keyboardWanted.calls).toEqual([true]);
        expect(screen.findByTestId(`desktop-activity-overlay-question-other-input-${question.id}`)).toBeTruthy();
    });

    it('moves focus in only for a keyboard open and gives it back to the island on Escape', async () => {
        const focus = createFocusRecorder();
        const screen = await renderRoute(createWindowState(), { createNodeMock: focus.createNodeMock });

        await act(async () => { screen.pressByTestId('desktop-activity-overlay-collapsed'); });
        await flushHookEffects();
        expect(focus.focusedTestIds).toEqual([]);

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-expanded'), 'onKeyDown',
                keyEvent('Escape'), 'desktop-activity-overlay-expanded');
        });
        await flushHookEffects();
        expect(focus.focusedTestIds).toEqual(['desktop-activity-overlay-collapsed']);

        await openFromKeyboard(screen);
        expect(focus.focusedTestIds.at(-1)).toBe('desktop-activity-overlay-session-row-session-1');
    });

    describe('the island material', () => {
        const flat = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) ?? {};
        const cameraState = () => createWindowState({
            placementDiagnostics: {
                displayContext: {
                    isMacos: true, isBuiltinDisplay: true, hasPhysicalNotch: true, safeAreaTop: 32,
                    physicalNotchSize: { width: 184, height: 32 },
                    screenFrame: { x: 0, y: 0, width: 1512, height: 982 },
                    visibleFrame: { x: 0, y: 32, width: 1512, height: 950 },
                },
            } as DesktopActivityOverlayWindowStatePayload['placementDiagnostics'],
        });

        it('paints the ink glass paint with no window material behind it, solid', async () => {
            const screen = await renderRoute(createWindowState());
            const paint = flat(screen.findByTestId('desktop-activity-overlay-notch-body')?.props.style).backgroundColor;
            expect(String(paint).toUpperCase()).toBe('#0C0B0B');
        });

        it('holds the black row only against the camera block', async () => {
            const docked = await renderRoute(createWindowState());
            expect(docked.findByTestId('desktop-activity-overlay-notch-seam')).toBeNull();
            await docked.unmount();
            vi.resetModules();
            const camera = await renderRoute(cameraState());
            expect(camera.findByTestId('desktop-activity-overlay-notch-seam')).not.toBeNull();
        });

        it('adds the foot band and bottom-left seam only once the panel is open', async () => {
            const screen = await renderRoute(createWindowState());
            expect(screen.findByTestId('desktop-activity-overlay-notch-foot')).toBeNull();
            expect(screen.findByTestId('desktop-activity-overlay-notch-rim')).toBeNull();
            await act(async () => { screen.pressByTestId('desktop-activity-overlay-collapsed'); });
            await flushHookEffects();
            expect(flat(screen.findByTestId('desktop-activity-overlay-notch-foot')?.props.style).height).toBe(32);
            expect(screen.findByTestId('desktop-activity-overlay-notch-rim')).not.toBeNull();
        });

        it('tells native where the material stands, with the resting frame', async () => {
            // Reduced motion places the shape at once, so the open panel's frame is a resting one.
            setDesktopGlassPanelShapeMock.mockClear();
            reducedMotion.value = true;
            const screen = await renderRoute(createWindowState());
            await act(async () => { screen.pressByTestId('desktop-activity-overlay-collapsed'); });
            await flushHookEffects();
            expect(setDesktopGlassPanelShapeMock).toHaveBeenLastCalledWith(expect.any(Number), {
                x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number),
            });

            // Once it moves, the material hides until the next resting frame, and says so only once.
            reducedMotion.value = false;
            setDesktopGlassPanelShapeMock.mockClear();
            await act(async () => {
                screen.findByTestId('desktop-activity-overlay-expanded-scroll')?.props.onContentSizeChange(464, 240);
            });
            await flushHookEffects();
            expect(setDesktopGlassPanelShapeMock.mock.calls).toEqual([[null]]);
        });
    });

    it('wraps the camera block with content-sized wings on a MacBook camera notch', async () => {
        const screen = await renderRoute(createWindowState({
            placementDiagnostics: {
                displayContext: {
                    isMacos: true, isBuiltinDisplay: true, hasPhysicalNotch: true, safeAreaTop: 32,
                    physicalNotchSize: { width: 184, height: 32 },
                    screenFrame: { x: 0, y: 0, width: 1512, height: 982 },
                    visibleFrame: { x: 0, y: 32, width: 1512, height: 950 },
                },
            } as DesktopActivityOverlayWindowStatePayload['placementDiagnostics'],
        }));
        expect(screen.findByTestId('desktop-activity-overlay-camera-gap')?.props.style).toEqual({ width: 184 });
    });

    it('stays still at rest: no renders, no presents and no timers while nothing happens', async () => {
        vi.useFakeTimers();
        const intervals = vi.spyOn(globalThis, 'setInterval');
        const commits = vi.fn();
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState({ visible: false }));
        const { DesktopActivityOverlayRoute } = await import('./DesktopActivityOverlayRoute');
        await renderScreen(<React.Profiler id="notch" onRender={commits}><DesktopActivityOverlayRoute /></React.Profiler>);
        await flushHookEffects();
        const settledCommits = commits.mock.calls.length;
        const settledPresents = presentDesktopActivityOverlayMock.mock.calls.length;

        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

        expect(commits.mock.calls.length - settledCommits).toBe(0);
        expect(presentDesktopActivityOverlayMock.mock.calls.length - settledPresents).toBe(0);
        expect(intervals).not.toHaveBeenCalled();
    });

    it('forces the web document background transparent only while the overlay window route is mounted', async () => {
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState());

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
            const screen = await renderRoute(createWindowState());

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
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createWindowState());

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
            const screen = await renderRoute(createWindowState());

            expect(existingStyleElement.textContent).toContain('#expo-root');
            expect(existingStyleElement.textContent).toContain('#root > div > div > div');
            expect(existingStyleElement.textContent).not.toContain('#root *, #app *, #expo-root *');

            await screen.unmount();

            expect(removeSpy).not.toHaveBeenCalled();
        } finally {
            (globalThis as { document?: Document }).document = originalDocument;
        }
    });

    describe('Bots in the notch', () => {
        const NOW = Date.now();
        function face(sessionId: string, name: string, activity: 'needsYou' | 'working' | 'quiet') {
            return { serverId: 'server-1', sessionId, face: { seed: sessionId, face: null }, name, activity,
                currentLine: activity === 'needsYou' ? 'Wants to edit .github/quarantine.json' : 'Drafting the release notes',
                meaningfulActivityAt: NOW - 6 * 60_000, live: true, agentId: null, machineId: null };
        }
        const flake = face('bot-flake', 'Flake hunter', 'needsYou');
        const release = face('bot-release', 'Release captain', 'working');
        function withBots(policy: Partial<DesktopActivityOverlayWindowStatePayload['policy']> = {}, pinned: typeof flake | null = flake) {
            const base = createWindowState();
            const model = {
                ...base.model,
                faces: { faces: [flake, release], overflowCount: 0 },
                conversation: pinned ? { serverId: pinned.serverId, accountId: 'account-1', sessionId: pinned.sessionId,
                    reply: { state: 'ready', text: 'sync/reconnect.test.ts failed 3 of 40 runs.' }, refreshing: false, reachable: true } : null,
            } as unknown as OverlayModel;
            return { ...base, model, policy: { ...base.policy, ...policy } };
        }
        function emitted(actionIdentifier: string) {
            return emitDesktopActivityOverlayInteractionMock.mock.calls.map(([call]) => call)
                .filter((call) => call.actionIdentifier === actionIdentifier).map((call) => call.data);
        }

        it('pins the island on a face, asks main for that Bot in the overlay, and releases it on Back', async () => {
            const screen = await renderRoute(withBots());
            expect(screen.findByTestId('desktop-activity-overlay-face-bot-flake')).toBeTruthy();

            await act(async () => { screen.pressByTestId('desktop-activity-overlay-face-bot-flake'); });
            await flushHookEffects();

            expect(emitted('session.open')).toEqual([{ sessionId: 'bot-flake', serverId: 'server-1', presentation: 'overlay' }]);
            expect(notchForm(screen)).toBe('open');
            expect(screen.findByTestId('desktop-activity-overlay-conversation')).toBeTruthy();

            await act(async () => { screen.pressByTestId('desktop-activity-overlay-conversation-back'); });
            await flushHookEffects();

            // Back returns to the list, still open, and main drops the pinned target and its transcript demand.
            expect(notchForm(screen)).toBe('open');
            expect(screen.findByTestId('desktop-activity-overlay-conversation')).toBeNull();
            expect(emitted('overlay-set-expanded')).toContainEqual({ expanded: true, target: null });
        });

        it('applies desktop.notch.set from main and releases the target when an outside press collapses it', async () => {
            const screen = await renderRoute(withBots());
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
            await flushHookEffects();
            expect(screen.findByTestId('desktop-activity-overlay-conversation')).toBeTruthy();

            await act(async () => { pointer.handler?.({ kind: 'outsidePress' }); });
            await flushHookEffects();
            expect(notchForm(screen)).toBe('standard');
            expect(emitted('overlay-set-expanded')).toContainEqual({ expanded: false, target: null });
        });

        it('opens a Bot in its window when Open Bot conversations says so, and offers both places on right-click', async () => {
            const screen = await renderRoute(withBots({ botConversationPresentation: 'window' }, null));
            await act(async () => { screen.pressByTestId('desktop-activity-overlay-face-bot-release'); });
            await flushHookEffects();
            expect(emitted('session.open')).toEqual([{ sessionId: 'bot-release', serverId: 'server-1', presentation: 'window' }]);
            expect(notchForm(screen)).toBe('standard');
        });

        it('keeps the pinned panel when the window was not opened, and steps back once it is', async () => {
            const screen = await renderRoute(withBots());
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
            await flushHookEffects();

            executeDesktopActivityOverlayInteractionWithResultMock.mockResolvedValueOnce({ requestId: 'r', ok: true, result: { status: 'cancelled' } });
            await act(async () => { screen.pressByTestId('desktop-activity-overlay-conversation-extract'); });
            await flushHookEffects();
            expect(executeDesktopActivityOverlayInteractionWithResultMock).toHaveBeenLastCalledWith({
                actionIdentifier: 'session.open', data: { sessionId: 'bot-flake', serverId: 'server-1', presentation: 'window' } });
            expect(screen.findByTestId('desktop-activity-overlay-conversation')).toBeTruthy();
            expect(screen.findByTestId('desktop-activity-overlay-conversation-extract-failed')).toBeTruthy();

            executeDesktopActivityOverlayInteractionWithResultMock.mockResolvedValueOnce({ requestId: 'r', ok: true, result: { status: 'opened', windowId: 'w' } });
            await act(async () => { screen.pressByTestId('desktop-activity-overlay-conversation-extract'); });
            await flushHookEffects();
            expect(notchForm(screen)).toBe('standard');
            expect(emitted('overlay-set-expanded')).toContainEqual({ expanded: false, target: null });
        });

        it('flies the panel to the opened window, keeping the flight layer inside the presented envelope', async () => {
            const base = withBots();
            // Native's applied frame (N2 flight seam): the overlay window's logical screen origin.
            const state = { ...base, frame: { dock: 'top' as const, growth: { x: null, y: 'down' as const }, anchorOffset: { x: 0, y: 0 },
                screenOrigin: { x: 600, y: 0, scaleFactor: 2 } } };
            const screen = await renderRoute(state, {
                // Host layout is the platform boundary: the open panel measures at (8, 40) in the overlay window.
                // The face raster's canvas keeps the renderer's default (no node).
                createNodeMock: (element) => (element.type === 'canvas' ? null : {
                    focus: () => {},
                    measureLayout: (_container: unknown, onSuccess: (x: number, y: number, w: number, h: number) => void) => onSuccess(8, 40, 464, 300),
                }),
            });
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
            await flushHookEffects();
            presentDesktopActivityOverlayMock.mockClear();

            executeDesktopActivityOverlayInteractionWithResultMock.mockResolvedValueOnce({ requestId: 'r', ok: true,
                result: { status: 'opened', windowId: 'w', rect: { x: 200, y: 300, width: 480, height: 640 } } });
            await act(async () => { screen.pressByTestId('desktop-activity-overlay-conversation-extract'); });
            await flushHookEffects();

            // The envelope covers both the panel's take-off rect (608, 40) and the window (200, 300), unsettled while it flies.
            expect(presentDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
                settled: false,
                extent: expect.objectContaining({ screenBounds: { x: 200, y: 40, width: 872, height: 900 } }),
            }));
            expect(screen.findByTestId('desktop-activity-overlay-extract-flight')).toBeTruthy();
            expect(notchForm(screen)).toBe('standard');
        });

        it('re-renders only the conversation while the person types or the pinned reply changes', async () => {
            draftIpc.drafts = {};
            draftIpc.writes = [];
            let pushState: ((payload: DesktopActivityOverlayWindowStatePayload) => void) | null = null;
            listenDesktopActivityOverlayWindowStateMock.mockImplementation(async (handler) => {
                pushState = handler;
                return () => { pushState = null; };
            });
            const state = withBots();
            const screen = await renderRoute(state);
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
            await flushHookEffects();
            const type = async (text: string) => {
                await act(async () => {
                    invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-quick-reply-input'), 'onChangeText', text);
                });
                await flushHookEffects();
            };
            // The first character makes the draft dirty: that fact belongs to the island (Esc holds).
            await type('Q');
            // The island's own render output: its shape element keeps its props while the island does not render.
            const island = screen.findByTestId('desktop-activity-overlay-notch-body')?.props;

            await type('Quarantine it');
            expect(screen.findByTestId('desktop-activity-overlay-quick-reply-input')?.props.value).toBe('Quarantine it');
            expect(screen.findByTestId('desktop-activity-overlay-notch-body')?.props).toBe(island);

            const conversation = (state.model as unknown as { conversation: Record<string, unknown> }).conversation;
            await act(async () => {
                pushState?.({ ...state, model: { ...state.model,
                    conversation: { ...conversation, reply: { state: 'ready', text: 'Quarantined; filing the wait fix next.' } } } as typeof state.model });
            });
            await flushHookEffects();
            expect(screen.findByTestId('desktop-activity-overlay-conversation-reply')?.props.children).toBe('Quarantined; filing the wait fix next.');
            expect(screen.findByTestId('desktop-activity-overlay-notch-body')?.props).toBe(island);
        });

        it('keeps a refused reply after closing the panel and offers Retry before sending it', async () => {
            draftIpc.drafts = { 'bot-flake': '' };
            draftIpc.writes = [];
            const screen = await renderRoute(withBots());
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
            await flushHookEffects();
            draftIpc.nextWriteError = 'target_unavailable';
            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-quick-reply-input'), 'onChangeText', 'Keep the full reply');
            });
            await flushHookEffects();
            expect(screen.findByTestId('desktop-activity-overlay-conversation-draft-failed')).toBeTruthy();
            await act(async () => { screen.pressByTestId('desktop-activity-overlay-conversation-back'); });
            await flushHookEffects();
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
            await flushHookEffects();
            expect(screen.findByTestId('desktop-activity-overlay-quick-reply-input')?.props.value).toBe('Keep the full reply');
            expect(draftIpc.writes).toHaveLength(1);
            await act(async () => { screen.pressByTestId('desktop-activity-overlay-conversation-draft-retry'); });
            await flushHookEffects();
            expect(draftIpc.drafts['bot-flake']).toBe('Keep the full reply');
            expect(screen.findByTestId('desktop-activity-overlay-conversation-draft-failed')).toBeNull();
            await act(async () => { screen.pressByTestId('desktop-activity-overlay-quick-reply-send'); });
            await flushHookEffects();
            expect(executeDesktopActivityOverlayInteractionWithResultMock).toHaveBeenLastCalledWith({
                actionIdentifier: 'session.message.send',
                data: { sessionId: 'bot-flake', serverId: 'server-1', message: 'Keep the full reply' },
            });
            expect(screen.findByTestId('desktop-activity-overlay-quick-reply-input')?.props.value).toBe('');
        });

        it('holds Escape while the pinned reply has typed text, and collapses once it is empty', async () => {
            draftIpc.drafts = { 'bot-flake': '' };
            draftIpc.writes = [];
            const screen = await renderRoute(withBots());
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
            await flushHookEffects();
            const escape = async () => {
                await act(async () => {
                    invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-expanded'), 'onKeyDown',
                        keyEvent('Escape'), 'desktop-activity-overlay-expanded');
                });
                await flushHookEffects();
            };

            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-quick-reply-input'), 'onChangeText', 'draft');
            });
            await flushHookEffects();
            await escape();
            expect(screen.findByTestId('desktop-activity-overlay-conversation')).toBeTruthy();
            expect(screen.findByTestId('desktop-activity-overlay-quick-reply-input')?.props.value).toBe('draft');

            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-quick-reply-input'), 'onChangeText', '');
            });
            await flushHookEffects();
            await escape();
            expect(notchForm(screen)).toBe('standard');
        });

        it('takes the keyboard only when the person goes to type, never because the island opened', async () => {
            draftIpc.drafts = { 'bot-flake': '' };
            draftIpc.writes = [];
            keyboardWanted.calls = [];
            const screen = await renderRoute(withBots());
            // An agent's desktop.notch.set pins the island: the person's editor keeps the keyboard.
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: true }); });
            await flushHookEffects();
            expect(keyboardWanted.calls).toEqual([]);

            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-quick-reply-input-shell'), 'onMouseDown', { stopPropagation: () => {} });
            });
            await flushHookEffects();
            expect(keyboardWanted.calls).toEqual([true]);
        });

        it.each([true, false])('uses the pinned Home for its context and fallback name (face present: %s)', async (hasFace) => {
            draftIpc.drafts = { 'bot-flake': '' };
            draftIpc.writes = [];
            const base = withBots();
            const asking = {
                ...base,
                model: { ...base.model, faces: { faces: hasFace ? base.model.faces.faces : [], overflowCount: 0 }, expanded: { ...base.model.expanded,
                    rows: [
                        { sessionId: 'bot-flake', serverId: 'another-home', title: 'Wrong Home name', subtitle: 'wrong · machine', statusText: 'Needs you', previewText: null },
                        { sessionId: 'bot-flake', serverId: 'server-1', title: 'Flake hunter', subtitle: 'happier · devbox', statusText: 'Needs you', previewText: null },
                    ],
                    cards: [{
                        id: 'permission:rq-1', kind: 'permission_request', requestId: 'rq-1', sessionId: 'bot-flake', serverId: 'server-1',
                        title: 'Edit a file', summary: 'Edit', toolLabel: 'Edit', questionText: null, count: 1, risk: 'low',
                        openActionIdentifier: 'open-session:bot-flake', allowActionIdentifier: 'a', denyActionIdentifier: 'd',
                        actions: [{ id: 'allow', label: 'Allow once', actionIdentifier: 'a', data: {}, tone: 'primary' }],
                    }] } },
            } as typeof base;
            const screen = await renderRoute(asking);
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
            await flushHookEffects();

            expect(screen.findByTestId('desktop-activity-overlay-conversation-state')).toBeNull();
            expect(screen.findByTestId('desktop-activity-overlay-conversation-context')).toBeTruthy();
            expect(screen.getTextContent()).toContain('happier · devbox');
            expect(screen.getTextContent()).toContain('Flake hunter');
            expect(screen.getTextContent()).not.toContain('Wrong Home name');
            expect(screen.getTextContent()).not.toContain('wrong · machine');
        });

        it('goes back to how a pinned Bot is once it no longer asks', async () => {
            draftIpc.drafts = { 'bot-flake': '' };
            draftIpc.writes = [];
            const screen = await renderRoute(withBots());
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
            await flushHookEffects();

            expect(screen.findByTestId('desktop-activity-overlay-conversation-state')).toBeTruthy();
            expect(screen.findByTestId('desktop-activity-overlay-conversation-context')).toBeNull();
        });

        it('binds the reply field to the pinned Session\'s own draft and never carries it to another Bot', async () => {
            draftIpc.drafts = { 'bot-flake': 'Quarantine it' };
            draftIpc.writes = [];
            const screen = await renderRoute(withBots());
            await act(async () => { presentation.handler?.({ state: 'pinned', focus: false }); });
            await flushHookEffects();
            // The field opens on that Session's draft, as the window and main composers show it.
            expect(screen.findByTestId('desktop-activity-overlay-quick-reply-input')?.props.value).toBe('Quarantine it');

            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-quick-reply-input'), 'onChangeText', 'Quarantine it for a week');
            });
            await flushHookEffects();
            expect(draftIpc.writes).toEqual([{ sessionId: 'bot-flake', text: 'Quarantine it for a week', expectedRevision: 1 }]);

            // Switching Bots is never blocked by typed text, and writes nothing to the other Bot.
            await act(async () => { screen.pressByTestId('desktop-activity-overlay-face-bot-release'); });
            await flushHookEffects();
            expect(emitted('session.open')).toEqual([{ sessionId: 'bot-release', serverId: 'server-1', presentation: 'overlay' }]);
            expect(draftIpc.writes.every((write) => write.sessionId === 'bot-flake')).toBe(true);
        });
    });
});
