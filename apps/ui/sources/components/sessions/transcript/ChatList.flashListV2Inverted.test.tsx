import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flashListChatListHarnessState,
    renderFlashListChatList,
    resetFlashListChatListHarness,
    standardCleanup,
} from '@/dev/testkit';
import { transcriptViewportTelemetry } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptViewportTelemetryEvent } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import { assertScenario } from '@/dev/testkit/transcript/viewportTelemetryAssertions';
import type { SyncTuning } from '@/sync/runtime/syncTuning';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * N3.4 — component suite for the inverted FlashList pilot
 * (`transcriptListImplementation: 'flash_v2_inverted'`).
 *
 * Canonical semantics under test (see the N3.1/N3.2 design note in
 * `.project/plans/transcript-native-stability-program.ledger.md`):
 * - FlashList/RN inverted exposes the visual bottom at raw list-start (`0`),
 *   while canonical transcript offsets still grow toward the newest/live-tail end,
 * - all internal observation/command offsets stay in that physical scroll space,
 * - follow-bottom / cold-open / anchored-entry / older-page commits are write-free,
 * - jump-to-bottom = single explicit list-start command, never scrollToEnd,
 * - maintainVisibleContentPosition uses startRenderingFromBottom plus a bottom
 *   autoscroll threshold while following, and no threshold while released.
 */

const platformMockState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' }));
const sessionViewportMockState = vi.hoisted(() => ({
    byId: new Map<string, unknown>(),
}));
const deferredNewerMockState = vi.hoisted(() => ({
    sessionIds: new Set<string>(),
}));
const targetWindowMockState = vi.hoisted(() => ({
    inactive: {
        isWindowMode: false,
        windowId: null,
        targetSeq: null,
        windowMinSeq: null,
        windowMaxSeq: null,
        olderCursor: null,
        newerCursor: null,
        hasMoreOlder: null,
        hasMoreNewer: null,
        activatedAtMs: null,
    },
    bySessionId: new Map<string, any>(),
    loadTargetWindowMessages: vi.fn(),
    markSessionLiveTailIntent: vi.fn(),
}));
const pinHudMockState = vi.hoisted(() => ({
    renderCount: 0,
}));
const renderedMessageViewProps: any[] = [];

installTranscriptCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
            overrides: {
                Platform: {
                    get OS() {
                        return platformMockState.os;
                    },
                    select: (values: Record<string, unknown>) =>
                        values?.[platformMockState.os] ?? values?.default,
                },
            },
        }),
    storage: async (importOriginal) => {
        const { createFlashListChatListStorageMock } = await import('@/dev/testkit/harness/chatListHarness');
        const liveMessages = () => flashListChatListHarnessState.sessionMessagesState.messages ?? [];
        const liveMessagesById = () =>
            Object.fromEntries(liveMessages().map((message: any) => [message.id, message]));
        // The harness storage mock freezes its message snapshot at module-mock factory
        // time; these live overrides let tests grow the transcript mid-test (older
        // pagination, slice reveal) exactly like the sibling flash_v2 suite does.
        return createFlashListChatListStorageMock(importOriginal, {
            useSessionTranscriptIds: () => ({
                ids: liveMessages().map((message: any) => message.id),
                isLoaded: flashListChatListHarnessState.sessionMessagesState.isLoaded,
            }),
            useSessionMessagesById: () => liveMessagesById(),
            useMessage: (_sessionId: string, messageId: string) =>
                liveMessages().find((message: any) => message.id === messageId) ?? null,
            getStorage: () => ({
                getState: () => ({
                    sessionMessages: {
                        [flashListChatListHarnessState.sessionState?.id ?? 'session-1']: {
                            messagesById: liveMessagesById(),
                            messagesMap: liveMessagesById(),
                        },
                    },
                }),
            }),
            // Boundary-fixture cast: getStorage returns the same minimal live store shape
            // the sibling flash_v2 suite mocks, not the full storage store type.
        } as any);
    },
});

// The FlashListCompat module mock binds the ref handle once at factory time, so the
// whole file shares one stable handle; tests steer measured behavior via this state.
const listRefMockState = {
    absoluteScrollOffset: 0,
    layoutAvailable: true,
    rowHeightPx: 120,
    // Corrector-faithful prepend simulation: when the rendered data head matches this
    // id, every previously rendered row keeps its VISUAL position (FlashList's offset
    // corrector holds the anchor) by shifting the layout base up by `correctorShiftPx`.
    correctorHoldFirstDataId: null as string | null,
    correctorShiftPx: 0,
    visibleRange: null as { startIndex: number; endIndex: number } | null,
};

function capturedListData(): any[] {
    return flashListChatListHarnessState.flashListProps?.data ?? [];
}

const fileFlashListRefHandle = {
    scrollToOffset: vi.fn(),
    scrollToIndex: vi.fn(),
    scrollToEnd: vi.fn(),
    clearLayoutCacheOnUpdate: vi.fn(),
    computeVisibleIndices: vi.fn(() => ({
        startIndex: listRefMockState.visibleRange?.startIndex ?? 0,
        endIndex: listRefMockState.visibleRange?.endIndex ?? Math.max(0, capturedListData().length - 1),
    })),
    getAbsoluteLastScrollOffset: vi.fn(() => listRefMockState.absoluteScrollOffset),
    getLayout: vi.fn((index: number) => {
        if (!listRefMockState.layoutAvailable) return undefined;
        const base =
            listRefMockState.correctorHoldFirstDataId != null &&
            capturedListData()[0]?.id === listRefMockState.correctorHoldFirstDataId
                ? -listRefMockState.correctorShiftPx
                : 0;
        return {
            x: 0,
            y: base + index * listRefMockState.rowHeightPx,
            width: 320,
            height: listRefMockState.rowHeightPx,
        };
    }),
};

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListModuleMock()
);

vi.mock('./_debug/TranscriptPinHud', () => ({
    TranscriptPinHud: () => {
        pinHudMockState.renderCount += 1;
        return React.createElement('TranscriptPinHud', { testID: 'transcript-pin-hud' });
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/sessions/chatListItems', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock()
);

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', async () => {
    const { useTranscriptRowLayoutMutation } = await import('@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext');
    function MockMessageView(props: any, name: string) {
        const notifyRowLayoutMutation = useTranscriptRowLayoutMutation();
        renderedMessageViewProps.push(props);
        return React.createElement(name, {
            ...props,
            testID: `mock-message-view-${props?.message?.id ?? 'unknown'}`,
            onPress: () => notifyRowLayoutMutation({
                reason: 'expand',
                sourceId: props?.message?.id ?? 'unknown',
            }),
        });
    }
    return {
        MessageView: (props: any) => MockMessageView(props, 'MessageView'),
        MessageViewWithSessionCommon: (props: any) => MockMessageView(props, 'MessageViewWithSessionCommon'),
    };
});

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
    TranscriptMotionProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
    resolveTranscriptMotionConfig: () => ({ preset: 'off', animateThinkingEnabled: false }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
    JumpToBottomButton: (props: any) => React.createElement('JumpToBottomButton', props),
}));

vi.mock('@/components/sessions/keyboardAvoidance', () => ({
    ComposerKeyboardScrollInset: (props: { testID?: string }) =>
        React.createElement('ComposerKeyboardScrollInset', {
            testID: props.testID ?? 'transcript-composer-keyboard-inset',
        }),
    ComposerKeyboardFloatingInset: ({ children, testID }: { children: React.ReactNode; testID?: string }) =>
        React.createElement('ComposerKeyboardFloatingInset', {
            testID: testID ?? 'transcript-jump-to-bottom-keyboard-offset',
        }, children),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: any) => p,
}));

vi.mock('@/sync/sync', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
        loadOlderMessages: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
        loadTargetWindowMessages: targetWindowMockState.loadTargetWindowMessages,
        loadNewerMessages: vi.fn(async () => undefined),
        hasDeferredNewerMessages: (sessionId: string) => deferredNewerMockState.sessionIds.has(sessionId),
        getSessionViewport: (sessionId: string) => sessionViewportMockState.byId.get(sessionId) ?? null,
        getSessionTargetWindowState: (sessionId: string) =>
            targetWindowMockState.bySessionId.get(sessionId) ?? targetWindowMockState.inactive,
        onSessionViewportChange: () => {},
        markSessionLiveTailIntent: (sessionId: string) => {
            targetWindowMockState.bySessionId.set(sessionId, targetWindowMockState.inactive);
            targetWindowMockState.markSessionLiveTailIntent(sessionId);
        },
    })
);

const OLDEST_FIRST_MESSAGES = [
    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
];

/** A streaming assistant-text segment meta — the live-tail anchor signal the carve gates on. */
function streamingAssistantMeta() {
    return {
        happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant' as const,
            segmentState: 'streaming' as const,
            segmentLocalId: null,
            updatedAtMs: 0,
        },
    };
}

let transcriptHarnessRenderRevision = 0;

function forceTranscriptHarnessRender() {
    // Production committed-message changes re-render ChatList through storage subscriptions
    // (`useSessionTranscriptIds` / `useSessionMessagesById`). This file overrides those hooks
    // with non-reactive reads, so message-state mutations use a harness-only prop change.
    // Do not use session.seq here: per-message seq bumps are intentionally render-irrelevant
    // for the transcript shell memo signature.
    transcriptHarnessRenderRevision += 1;
    const revision = transcriptHarnessRenderRevision;
    return () => {
        void revision;
    };
}

function renderHarnessSession() {
    return {
        ...flashListChatListHarnessState.sessionState,
    };
}

/**
 * Flag the newest committed agent-text row as actively streaming (opens the native carve).
 * A genuinely streaming turn is, by the runtime contract, an ACTIVE session — `session.active`
 * is true throughout. The carve's streaming-message anchor is gated on `sessionActive` (so a
 * STALE `streaming` flag left on an IDLE session by an interrupted turn fails closed), so the
 * helper sets `active: true` to model the real live-streaming case it represents.
 */
function markNewestAgentMessageStreaming(id: string): void {
    flashListChatListHarnessState.sessionState = {
        ...flashListChatListHarnessState.sessionState,
        active: true,
    };
    flashListChatListHarnessState.sessionMessagesState = {
        isLoaded: true,
        messages: flashListChatListHarnessState.sessionMessagesState.messages.map((message: any) =>
            message.id === id ? { ...message, kind: 'agent-text', meta: streamingAssistantMeta() } : message),
    };
}

/** Drive the edge-slot rows onLayout (the live-tail measurement that the synchronized pin reads). */
async function measureNativeHotTailRows(
    screen: Awaited<ReturnType<typeof renderFlashListChatList>>,
    height: number,
): Promise<void> {
    const rows = screen.findByTestId('transcript-native-hot-tail-rows');
    await act(async () => {
        rows?.props?.onLayout?.({ nativeEvent: { layout: { height } } });
    });
    await screen.settle({ cycles: 1, turns: 1 });
}

function carvePinWrites(telemetrySink: ReturnType<typeof vi.fn>): any[] {
    return committedScrollWrites(telemetrySink).filter((event: any) => event.liveRegionActive === true);
}

let previousRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
let previousCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;

function applyTranscriptSettings(implementation: string): void {
    flashListChatListHarnessState.settingValues.transcriptListImplementation = implementation;
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 72;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomAnimateScroll = false;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomRevealViewportRatio = 0.75;
}

function configureHarness(options: Readonly<{
    platformOs?: 'ios' | 'web';
    implementation?: string;
    syncTuningState?: Partial<SyncTuning>;
}> = {}): void {
    const platformOs = options.platformOs ?? 'ios';
    platformMockState.os = platformOs;
    resetFlashListChatListHarness({
        flashListRefHandle: fileFlashListRefHandle,
        platformOs,
        syncTuningState: {
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 256,
            ...(options.syncTuningState ?? {}),
        },
    });
    applyTranscriptSettings(options.implementation ?? 'flash_v2_inverted');
    flashListChatListHarnessState.sessionMessagesState = {
        messages: OLDEST_FIRST_MESSAGES.map((message) => ({ ...message })),
        isLoaded: true,
    };
    flashListChatListHarnessState.sessionState = {
        ...flashListChatListHarnessState.sessionState,
        id: 'session-1',
        seq: 0,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
    };
    targetWindowMockState.bySessionId.clear();
    targetWindowMockState.loadTargetWindowMessages.mockReset();
    targetWindowMockState.loadTargetWindowMessages.mockResolvedValue(null);
    targetWindowMockState.markSessionLiveTailIntent.mockReset();
}

function configureTelemetrySink(): ReturnType<typeof vi.fn> {
    const telemetrySink = vi.fn();
    transcriptViewportTelemetry.configure({
        enabled: true,
        capacity: 256,
        sink: telemetrySink,
    });
    return telemetrySink;
}

function sinkEvents(telemetrySink: ReturnType<typeof vi.fn>): TranscriptViewportTelemetryEvent[] {
    return telemetrySink.mock.calls.map(([event]: any[]) => event);
}

function committedScrollWrites(telemetrySink: ReturnType<typeof vi.fn>): any[] {
    return sinkEvents(telemetrySink).filter(
        (event: any) => event?.type === 'scroll-write' && event.writer !== 'mvcp-skip',
    );
}

function lastScrollObserved(telemetrySink: ReturnType<typeof vi.fn>): any {
    const observations = sinkEvents(telemetrySink).filter((event: any) => event?.type === 'scroll-observed');
    return observations[observations.length - 1];
}

function visibleWindowEvents(telemetrySink: ReturnType<typeof vi.fn>): any[] {
    return sinkEvents(telemetrySink).filter((event: any) => event?.type === 'visible-window-observed');
}

function listDataIds(screen: Awaited<ReturnType<typeof renderFlashListChatList>>): string[] {
    return (screen.requireCapturedFlashListProps().data ?? []).map((item: any) => item.id);
}

/**
 * Pre-order (DOM) list of the message ids of the carved hot-tail rows under the `-rows` wrapper.
 * `findAll` walks the tree depth-first in render order, so this is the on-screen top→bottom DOM
 * order of the edge-slot rows.
 */
function hotTailRowDomOrder(rows: { findAll: (predicate: (node: any) => boolean) => any[] }): string[] {
    const prefix = 'transcript-native-hot-tail-item-';
    return rows
        .findAll((node: any) =>
            typeof node?.type === 'string'
            && typeof node?.props?.testID === 'string'
            && node.props.testID.startsWith(prefix))
        .map((node: any) => String(node.props.testID).slice(prefix.length));
}

function findTranscriptItemShell(screen: { findByTestId: (testID: string) => any }, itemId: string) {
    return screen.findByTestId(`transcript-item-${itemId}`);
}

/** Reads the reserved row-shell `minHeight` (the C1 measurement reservation), flattening style arrays. */
function readStyleMinHeight(style: unknown): number | undefined {
    if (Array.isArray(style)) {
        for (const entry of style) {
            const value = readStyleMinHeight(entry);
            if (value !== undefined) return value;
        }
        return undefined;
    }
    if (style && typeof style === 'object' && 'minHeight' in style) {
        const value = (style as { minHeight?: unknown }).minHeight;
        return typeof value === 'number' ? value : undefined;
    }
    return undefined;
}

async function fireTranscriptItemShellLayout(
    shell: { props: { onLayout?: (event: unknown) => void } },
    height: number,
): Promise<void> {
    await act(async () => {
        shell.props.onLayout?.({
            nativeEvent: {
                layout: {
                    height,
                    width: 400,
                },
            },
        });
    });
}

async function renderInvertedChatList() {
    const { ChatList } = await import('./ChatList');
    return renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} />,
    );
}

async function renderInvertedChatListWithViewportChange(
    onViewportChange: (state: Readonly<{ isPinned: boolean; offsetY?: number; shouldRestoreViewport?: boolean }>) => void,
) {
    const { ChatList } = await import('./ChatList');
    return renderFlashListChatList(
        <ChatList session={flashListChatListHarnessState.sessionState} onViewportChange={onViewportChange} />,
    );
}

async function settleNativeMount(screen: Awaited<ReturnType<typeof renderFlashListChatList>>): Promise<void> {
    await screen.triggerLoad(12, { turns: 1 });
    await screen.settle({ advanceTimersMs: 200, cycles: 1, turns: 2 });
}

async function coldOpenAtBottom(
    screen: Awaited<ReturnType<typeof renderFlashListChatList>>,
    dims: Readonly<{ layoutHeight: number; contentHeight: number }>,
): Promise<void> {
    listRefMockState.absoluteScrollOffset = 0;
    await screen.triggerInitialFill({
        layoutHeight: dims.layoutHeight,
        contentHeight: dims.contentHeight,
        contentWidth: 0,
        flushOptions: { cycles: 1, turns: 1 },
    });
    await settleNativeMount(screen);
}

async function scrollRaw(
    screen: Awaited<ReturnType<typeof renderFlashListChatList>>,
    rawOffsetY: number,
    dims: Readonly<{ layoutHeight: number; contentHeight: number }>,
    extras: Record<string, unknown> = {},
): Promise<void> {
    listRefMockState.absoluteScrollOffset = rawOffsetY;
    await screen.triggerScroll(rawOffsetY, {
        contentSize: { height: dims.contentHeight, width: 0 },
        layoutMeasurement: { height: dims.layoutHeight, width: 0 },
        ...extras,
    }, { cycles: 1, turns: 1 });
}

/** Trusted drag away from the bottom: releases follow under the B9 escape semantics. */
async function releaseFollowByDrag(
    screen: Awaited<ReturnType<typeof renderFlashListChatList>>,
    rawOffsetY: number,
    dims: Readonly<{ layoutHeight: number; contentHeight: number }>,
): Promise<void> {
    const flashListProps = screen.requireCapturedFlashListProps();
    await act(async () => {
        flashListProps.onScrollBeginDrag?.({});
    });
    await scrollRaw(screen, rawOffsetY, dims, { isTrusted: true });
    await act(async () => {
        flashListProps.onScrollEndDrag?.({});
    });
    await screen.settle({ cycles: 1, turns: 1 });
}

beforeEach(() => {
    vi.useFakeTimers({ now: new Date(0) });
    resetTranscriptCommonModuleMockState();
    previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
    fileFlashListRefHandle.scrollToOffset.mockClear();
    fileFlashListRefHandle.scrollToIndex.mockClear();
    fileFlashListRefHandle.scrollToEnd.mockClear();
    fileFlashListRefHandle.clearLayoutCacheOnUpdate.mockClear();
    listRefMockState.absoluteScrollOffset = 0;
    listRefMockState.layoutAvailable = true;
    listRefMockState.rowHeightPx = 120;
    listRefMockState.correctorHoldFirstDataId = null;
    listRefMockState.correctorShiftPx = 0;
    listRefMockState.visibleRange = null;
    pinHudMockState.renderCount = 0;
    renderedMessageViewProps.length = 0;
    transcriptHarnessRenderRevision = 0;
    sessionViewportMockState.byId.clear();
    deferredNewerMockState.sessionIds.clear();
    configureHarness();
});

afterEach(() => {
    transcriptViewportTelemetry.configure({ enabled: false, sink: null });
    globalThis.requestAnimationFrame = previousRequestAnimationFrame as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previousCancelAnimationFrame as typeof globalThis.cancelAnimationFrame;
    vi.useRealTimers();
    resetTranscriptCommonModuleMockState();
    standardCleanup();
});

describe('ChatList (FlashList v2 inverted pilot)', () => {
    describe('presentation resolution', () => {
        it('does not mount the diagnostic pin HUD by default in native FlashList v2', async () => {
            await renderInvertedChatList();

            expect(pinHudMockState.renderCount).toBe(0);
        });

        it('renders the inverted FlashList with newest-first data and inverted-safe MVCP in every state', async () => {
            const dims = { layoutHeight: 500, contentHeight: 2000 };
            const observedMvcpValues: unknown[] = [];
            const screen = await renderInvertedChatList();
            observedMvcpValues.push(screen.requireCapturedFlashListProps().maintainVisibleContentPosition);

            await coldOpenAtBottom(screen, dims);

            const props = screen.requireCapturedFlashListProps();
            expect(props.inverted).toBe(true);
            // Newest-first reversal of the oldest-first transcript at the list boundary.
            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            // While following, native physical bottom maintenance owns the live tail.
            expect(props.maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
                autoscrollToBottomThreshold: 72 / 500,
                animateAutoScrollToBottom: false,
            });
            observedMvcpValues.push(props.maintainVisibleContentPosition);

            // Released (reading): MVCP keeps correction armed without bottom autoscroll.
            await releaseFollowByDrag(screen, 1000, dims);
            const releasedMvcp = screen.requireCapturedFlashListProps().maintainVisibleContentPosition;
            expect(releasedMvcp).toEqual({ startRenderingFromBottom: true });
            observedMvcpValues.push(releasedMvcp);

            for (const mvcp of observedMvcpValues) {
                expect(mvcp).not.toEqual({ disabled: true });
            }
        });

        it('resolves STANDARD presentation on web even with the inverted setting on (native-only pilot)', async () => {
            configureHarness({ platformOs: 'web', implementation: 'flash_v2_inverted' });
            const screen = await renderInvertedChatList();
            await screen.triggerInitialFill({
                layoutHeight: 500,
                contentHeight: 2000,
                contentWidth: 0,
                flushOptions: { cycles: 1, turns: 1 },
            });

            const props = screen.requireCapturedFlashListProps();
            expect(props.inverted).toBeUndefined();
            // Web keeps the hot/cold split: the FlashList holds the cold OLDEST-FIRST
            // window (hot tail of 2 renders in the footer) — order must stay canonical.
            expect(listDataIds(screen)).toEqual(['m1', 'm2']);
        });

        it('resolves native flash_v2 to the canonical inverted presentation', async () => {
            configureHarness({ platformOs: 'ios', implementation: 'flash_v2' });
            const dims = { layoutHeight: 500, contentHeight: 2000 };
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);

            const props = screen.requireCapturedFlashListProps();
            expect(props.inverted).toBe(true);
            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            expect(props.maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
            });
            expect(props.maintainVisibleContentPosition).not.toHaveProperty('disabled');
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
        });
    });

    describe('cold open follow-bottom (zero writes)', () => {
        it('arms the MVCP autoscroll threshold at first paint without waiting for content mount-settle (cold-open deadlock fix)', async () => {
            // Inverted follow-bottom cold opens have no JS bottom-pin authority (the JS pin
            // is a deliberate no-op on inverted), so the MVCP autoscroll threshold is the
            // ONLY bottom-pin. On a tall session whose rows measure late, the content-height
            // mount-settle window never converges. The threshold must therefore arm at first
            // paint — when the viewport layout is observed and the entry transaction closes —
            // not after a mount-settle that may never happen.
            const screen = await renderInvertedChatList();

            // First paint only: layout observed + content size reported. We intentionally do
            // NOT run settleNativeMount (no timer-advanced quiescent mount-settle window).
            listRefMockState.absoluteScrollOffset = 0;
            await screen.triggerInitialFill({
                layoutHeight: 500,
                contentHeight: 2000,
                contentWidth: 0,
                flushOptions: { cycles: 1, turns: 1 },
            });

            const props = screen.requireCapturedFlashListProps();
            expect(props.inverted).toBe(true);
            // Threshold armed = entry viewport transaction closed (single-owner rule) AND
            // following on a positive viewport height. This is the observable cold-open fix.
            expect(props.maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
                autoscrollToBottomThreshold: 72 / 500,
                animateAutoScrollToBottom: false,
            });
        });

        it('keeps structural-clear drift write-free while the session-open latch owns positioning', async () => {
            // NQA-F3 / REVIEW-C1 contract: the session-open latch is the single owner of cold
            // positioning during structural clearLayoutCacheOnUpdate drift. An untrusted
            // off-bottom frame inside that latch window must stay write-free here; issuing a
            // second scrollToIndex(0) would create a competing structural-clear writer.
            const screen = await renderInvertedChatList();

            // First paint only — no settleNativeMount, so the mount-settle window stays active
            // (matches the cold-open deadlock-fix setup above).
            listRefMockState.absoluteScrollOffset = 0;
            await screen.triggerInitialFill({
                layoutHeight: 500,
                contentHeight: 2000,
                contentWidth: 0,
                flushOptions: { cycles: 1, turns: 1 },
            });
            fileFlashListRefHandle.scrollToIndex.mockClear();

            // The yank: an untrusted scroll frame observes the list far off the bottom while
            // still following with no user intent — the post-clear re-stack seen on device.
            await scrollRaw(screen, 900, { layoutHeight: 500, contentHeight: 2000 });

            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        });

        it('does not re-pin a settled inverted follow-bottom list on a passive off-bottom drift frame', async () => {
            // Guard the mount-settle gate: once the cold-open window has settled, MVCP owns
            // bottom maintenance and a passive height-churn drift frame must stay write-free
            // (no scrollToIndex). Only the active mount window re-pins.
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });
            fileFlashListRefHandle.scrollToIndex.mockClear();

            await scrollRaw(screen, 900, { layoutHeight: 500, contentHeight: 2000 });

            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        });

        it('lands at the bottom with zero JS scroll writes — native list start is the newest visual edge', async () => {
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });

            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToEnd).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
        });

        it('keeps streaming appends JS-write-free while following at the inverted visual bottom', async () => {
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });
            telemetrySink.mockClear();
            fileFlashListRefHandle.scrollToOffset.mockClear();
            fileFlashListRefHandle.scrollToEnd.mockClear();
            fileFlashListRefHandle.scrollToIndex.mockClear();
            fileFlashListRefHandle.clearLayoutCacheOnUpdate.mockClear();

            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...flashListChatListHarnessState.sessionMessagesState.messages,
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            const { ChatList } = await import('./ChatList');
            await screen.update(
                <ChatList
                    session={renderHarnessSession()}
                    onEditPendingMessage={forceTranscriptHarnessRender()}
                />,
            );
            listRefMockState.absoluteScrollOffset = 0;
            await screen.triggerContentSizeChange(0, 2120, { cycles: 2, turns: 2, frames: 1 });

            expect(listDataIds(screen)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
                autoscrollToBottomThreshold: 72 / 500,
            });
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToEnd).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
            expect(visibleWindowEvents(telemetrySink)).toContainEqual(expect.objectContaining({
                orientation: 'inverted',
                rawOffsetY: 0,
                distanceFromBottom: 0,
                mvcpPolicy: 'autoscroll-threshold',
                hasVisibleRows: true,
            }));
        });

        it('keeps same-message streaming growth coherent without globally clearing FlashList layout cache per token', async () => {
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });
            await fireTranscriptItemShellLayout(findTranscriptItemShell(screen, 'm4'), 120);
            telemetrySink.mockClear();
            renderedMessageViewProps.length = 0;
            fileFlashListRefHandle.scrollToOffset.mockClear();
            fileFlashListRefHandle.scrollToEnd.mockClear();
            fileFlashListRefHandle.scrollToIndex.mockClear();
            fileFlashListRefHandle.clearLayoutCacheOnUpdate.mockClear();

            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: flashListChatListHarnessState.sessionMessagesState.messages.map((message: any) =>
                    message.id === 'm4'
                        ? {
                            ...message,
                            text: [
                                message.text,
                                '',
                                'streamed paragraph',
                                '',
                                '- streamed list item',
                            ].join('\n'),
                        }
                        : message
                ),
            };
            const { ChatList } = await import('./ChatList');
            await screen.update(
                <ChatList
                    session={renderHarnessSession()}
                    onEditPendingMessage={forceTranscriptHarnessRender()}
                />,
            );
            await fireTranscriptItemShellLayout(findTranscriptItemShell(screen, 'm4'), 260);
            // The live iOS failure class reports transient no-visible samples while the
            // rendered transcript is still at the visual bottom. Same-message growth must keep
            // ownership pinned, but telemetry must report stale row evidence separately
            // from real current visibility.
            listRefMockState.visibleRange = { startIndex: 1, endIndex: 0 };
            listRefMockState.absoluteScrollOffset = 0;
            await screen.triggerContentSizeChange(0, 2140, { cycles: 2, turns: 2, frames: 1 });

            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            const latestM4Props = renderedMessageViewProps
                .filter((props) => props?.message?.id === 'm4')
                .at(-1);
            expect(latestM4Props?.message?.text).toContain('streamed paragraph');
            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
                autoscrollToBottomThreshold: 72 / 500,
            });
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            expect(fileFlashListRefHandle.clearLayoutCacheOnUpdate).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToEnd).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
            expect(visibleWindowEvents(telemetrySink)).toContainEqual(expect.objectContaining({
                orientation: 'inverted',
                rawOffsetY: 0,
                distanceFromBottom: 0,
                mvcpPolicy: 'autoscroll-threshold',
                hasVisibleRows: false,
                visibleWindowStale: true,
                lastKnownFirstVisibleItemId: 'm4',
                lastKnownLastVisibleItemId: 'm1',
            }));
        });

        it('invalidates layout for a tool-progress signature change above a streaming row', async () => {
            configureHarness();
            flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
            flashListChatListHarnessState.settingValues.transcriptGroupToolCalls = true;
            flashListChatListHarnessState.settingValues.toolViewTimelineChromeMode = 'activity_feed';
            flashListChatListHarnessState.settingValues.transcriptToolCallsCollapsedPreviewCount = 10;
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                active: true,
                seq: 1,
            };
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'run a command' },
                    {
                        kind: 'tool-call',
                        id: 'tool-1',
                        localId: null,
                        createdAt: 2,
                        seq: 2,
                        tool: { id: 'tool-1', name: 'shell', state: 'running', input: { command: 'pwd' } },
                    },
                    { kind: 'agent-text', id: 'stream-1', localId: null, createdAt: 3, seq: 3, text: 'Stream Chunk 1' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderFlashListChatList(
                <ChatList session={flashListChatListHarnessState.sessionState} />,
            );
            const toolRowId = listDataIds(screen).find((id) => id.includes('#tool:tool-1'));
            expect(toolRowId).toBeTruthy();
            await fireTranscriptItemShellLayout(findTranscriptItemShell(screen, toolRowId!), 44);
            fileFlashListRefHandle.clearLayoutCacheOnUpdate.mockClear();

            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: flashListChatListHarnessState.sessionMessagesState.messages.map((message: any) =>
                    message.id === 'tool-1'
                        ? {
                            ...message,
                            tool: {
                                ...message.tool,
                                state: 'completed',
                                result: { tool_use_result: 'ok' },
                            },
                        }
                        : message
                ),
            };

            await screen.update(
                <ChatList
                    session={renderHarnessSession()}
                    onEditPendingMessage={forceTranscriptHarnessRender()}
                />,
            );

            expect(fileFlashListRefHandle.clearLayoutCacheOnUpdate).toHaveBeenCalledTimes(1);
        });

        it('invalidates FlashList layout cache without forcing list-wide extraData churn for row layout mutations', async () => {
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });
            const previousExtraData = screen.requireCapturedFlashListProps().extraData;
            fileFlashListRefHandle.clearLayoutCacheOnUpdate.mockClear();

            const renderedNewestMessage = screen.findByTestId('mock-message-view-m4');
            expect(renderedNewestMessage).not.toBeNull();
            await act(async () => {
                renderedNewestMessage?.props.onPress?.();
            });
            await screen.settle({ cycles: 1, turns: 1 });

            const nextExtraData = screen.requireCapturedFlashListProps().extraData;
            expect(fileFlashListRefHandle.clearLayoutCacheOnUpdate).toHaveBeenCalledTimes(1);
            expect(nextExtraData).toBe(previousExtraData);
            expect(nextExtraData).toMatchObject({ selectionVersion: expect.any(Number) });
            expect(nextExtraData).not.toHaveProperty('rowLayoutMutationVersion');
        });

        it('emits native exact-bottom visible-window telemetry after first paint', async () => {
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });

            const visibleEvents = visibleWindowEvents(telemetrySink);
            expect(visibleEvents.length).toBeGreaterThan(0);
            expect(visibleEvents[visibleEvents.length - 1]).toMatchObject({
                orientation: 'inverted',
                rawOffsetY: 0,
                canonicalOffsetY: 1500,
                distanceFromBottom: 0,
                contentHeight: 2000,
                layoutHeight: 500,
                bottomFollowMode: 'following',
                nativeMomentumActive: false,
                // Cold-open deadlock fix: the inverted follow-bottom entry now arms the MVCP
                // autoscroll threshold at first paint (the only inverted bottom-pin authority)
                // instead of stalling on 'start-rendering-from-bottom' until a content mount-settle
                // that may never converge.
                mvcpPolicy: 'autoscroll-threshold',
                isAtRawBottom: true,
                hasVisibleRows: true,
                firstVisibleItemId: 'm4',
                lastVisibleItemId: 'm1',
                firstVisibleSourceIndex: 0,
                lastVisibleSourceIndex: 3,
                blankAreaPx: 0,
                visibleWindowSource: 'ref-compute',
                blankAreaSource: 'none',
            });
        });

        it('does not install native viewability collection while viewport telemetry is disabled and no navigation anchors exist', async () => {
            configureHarness({
                syncTuningState: {
                    transcriptViewportTelemetryEnabled: false,
                },
            });
            flashListChatListHarnessState.sessionMessagesState = {
                messages: [],
                isLoaded: true,
            };
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });

            const props = screen.requireCapturedFlashListProps();
            expect(props.onViewableItemsChanged).toBeUndefined();
            expect(props.viewabilityConfig).toBeUndefined();
        });

        it('keeps native navigation visibility detached while viewport telemetry is disabled and navigation facts have no subscribers', async () => {
            configureHarness({
                syncTuningState: {
                    transcriptViewportTelemetryEnabled: false,
                },
            });
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });

            const props = screen.requireCapturedFlashListProps();
            expect(props.onViewableItemsChanged).toBeUndefined();
            expect(props.viewabilityConfig).toBeUndefined();
        });

        it('keeps native navigation visibility attached while viewport telemetry is disabled when navigation facts are subscribed', async () => {
            configureHarness({
                syncTuningState: {
                    transcriptViewportTelemetryEnabled: false,
                },
            });
            const { getTranscriptNavigationVisibilityStore } = await import('./viewport/visibility/transcriptNavigationVisibilityStore');
            const unsubscribe = getTranscriptNavigationVisibilityStore('session-1').subscribe(vi.fn());
            try {
                const screen = await renderInvertedChatList();
                await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });

                const props = screen.requireCapturedFlashListProps();
                expect(typeof props.onViewableItemsChanged).toBe('function');
                expect(props.viewabilityConfig).toEqual({ itemVisiblePercentThreshold: 1 });
            } finally {
                unsubscribe();
            }
        });

        it('does not compute visible source-range diagnostics while viewport telemetry is disabled', async () => {
            configureHarness({
                syncTuningState: {
                    transcriptViewportTelemetryEnabled: false,
                },
            });
            const screen = await renderInvertedChatList();
            fileFlashListRefHandle.computeVisibleIndices.mockClear();

            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });

            expect(fileFlashListRefHandle.computeVisibleIndices).not.toHaveBeenCalled();
        });

        it('distinguishes visual bottom with no visible rows from bottom with rendered rows', async () => {
            listRefMockState.visibleRange = { startIndex: 1, endIndex: 0 };
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });

            const visibleEvents = visibleWindowEvents(telemetrySink);
            expect(visibleEvents.length).toBeGreaterThan(0);
            expect(visibleEvents[visibleEvents.length - 1]).toMatchObject({
                orientation: 'inverted',
                rawOffsetY: 0,
                canonicalOffsetY: 1500,
                distanceFromBottom: 0,
                isAtRawBottom: true,
                hasVisibleRows: false,
                blankAreaPx: 500,
                visibleWindowSource: 'ref-compute',
                blankAreaSource: 'index-estimate',
            });
            expect(visibleEvents[visibleEvents.length - 1]).not.toHaveProperty('firstVisibleItemId');
            expect(visibleEvents[visibleEvents.length - 1]).not.toHaveProperty('lastVisibleItemId');
        });

        it('classifies a native blank-window frame while a reader scrolls up from bottom', async () => {
            const dims = { layoutHeight: 500, contentHeight: 2000 };
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            telemetrySink.mockClear();

            const flashListProps = screen.requireCapturedFlashListProps();
            await act(async () => {
                flashListProps.onScrollBeginDrag?.({});
            });
            await screen.settle({ cycles: 1, turns: 1 });

            listRefMockState.visibleRange = { startIndex: 3, endIndex: 1 };
            await scrollRaw(screen, 640, dims, { isTrusted: true });

            const visibleEvents = visibleWindowEvents(telemetrySink);
            expect(visibleEvents.length).toBeGreaterThan(0);
            expect(visibleEvents[visibleEvents.length - 1]).toMatchObject({
                orientation: 'inverted',
                rawOffsetY: 640,
                canonicalOffsetY: 860,
                distanceFromBottom: 640,
                contentHeight: 2000,
                layoutHeight: 500,
                eventContentHeight: 2000,
                eventLayoutHeight: 500,
                refContentHeight: 2000,
                refLayoutHeight: 500,
                bottomFollowMode: 'escaping',
                dragSessionTrusted: true,
                nativeMomentumActive: false,
                mvcpPolicy: 'start-rendering-from-bottom',
                hasVisibleRows: false,
                visibleWindowSource: 'ref-compute',
                visibleWindowStale: true,
                blankAreaPx: 500,
                blankAreaSource: 'index-estimate',
                nativeBlankWindowSignature: 'empty-visible-window',
                listDataLength: 4,
                fullItemCount: 4,
                coldCount: 4,
                hotCount: 0,
                visibleRangeReadStatus: 'reversed',
                visibleRenderedStartIndex: 3,
                visibleRenderedEndIndex: 1,
                firstVisibleRenderedIndex: 3,
                entryRestoreState: 'none',
                prependState: 'none',
                layoutCacheClearState: 'idle',
                layoutCacheClearReason: 'none',
                scrollToIndexFailureState: 'none',
            });
        });
    });

    describe('scroll observation mapping (raw -> canonical)', () => {
        const dims = { layoutHeight: 500, contentHeight: 2000 };

        it('maps raw list start to canonical bottom (pinned, no jump button)', async () => {
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            telemetrySink.mockClear();

            await scrollRaw(screen, 0, dims);

            expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
            const observed = lastScrollObserved(telemetrySink);
            expect(observed).toMatchObject({
                offsetY: 1500,
                rawOffsetY: 0,
                distanceFromBottom: 0,
            });
        });

        it('treats raw negative bottom bounce as invalid without pretending it is a normal older-edge observation', async () => {
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            telemetrySink.mockClear();

            const flashListProps = screen.requireCapturedFlashListProps();
            await act(async () => {
                flashListProps.onScrollBeginDrag?.({});
            });
            await screen.settle({ cycles: 1, turns: 1 });
            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({ startRenderingFromBottom: true });

            listRefMockState.visibleRange = { startIndex: 1, endIndex: 0 };
            await scrollRaw(screen, -20, dims, { isTrusted: true });
            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({ startRenderingFromBottom: true });

            const observed = lastScrollObserved(telemetrySink);
            expect(observed).toMatchObject({
                orientation: 'inverted',
                mode: 'follow-bottom',
                reason: 'invalid-native-offset',
                rawOffsetY: -20,
                canonicalOffsetY: 1520,
                offsetY: 1520,
                distanceFromBottom: 0,
                isAtRawBottom: false,
                mvcpPolicy: 'start-rendering-from-bottom',
            });
            const visibleEvents = visibleWindowEvents(telemetrySink);
            expect(visibleEvents[visibleEvents.length - 1]).toMatchObject({
                hasVisibleRows: false,
                visibleWindowStale: true,
                mvcpPolicy: 'start-rendering-from-bottom',
                rawOffsetY: -20,
                lastKnownFirstVisibleItemId: 'm4',
                lastKnownLastVisibleItemId: 'm1',
                blankAreaPx: 500,
            });
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
        });

        it('drops bottom maintenance immediately during a bottom drag, then releases on trusted away movement', async () => {
            const onViewportChange = vi.fn();
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatListWithViewportChange(onViewportChange);
            await coldOpenAtBottom(screen, dims);
            telemetrySink.mockClear();
            onViewportChange.mockClear();

            const flashListProps = screen.requireCapturedFlashListProps();
            await act(async () => {
                flashListProps.onScrollBeginDrag?.({});
            });
            await screen.settle({ cycles: 1, turns: 1 });

            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({ startRenderingFromBottom: true });

            await scrollRaw(screen, 40, dims, { isTrusted: true });

            expect(lastScrollObserved(telemetrySink)).toMatchObject({
                orientation: 'inverted',
                rawOffsetY: 40,
                distanceFromBottom: 40,
                bottomFollowMode: 'escaping',
            });
            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({ startRenderingFromBottom: true });
            expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
            expect(committedScrollWrites(telemetrySink)).toEqual([]);

            await scrollRaw(screen, 420, dims, { isTrusted: true });

            expect(lastScrollObserved(telemetrySink)).toMatchObject({
                orientation: 'inverted',
                rawOffsetY: 420,
                distanceFromBottom: 420,
            });
            expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                isPinned: false,
                shouldRestoreViewport: true,
            }));
            expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
        });

        it('releases follow on an inverted away-touch before the first scroll frame', async () => {
            const onViewportChange = vi.fn();
            const screen = await renderInvertedChatListWithViewportChange(onViewportChange);
            await coldOpenAtBottom(screen, dims);
            onViewportChange.mockClear();

            const flashListProps = screen.requireCapturedFlashListProps();
            await act(async () => {
                flashListProps.onScrollBeginDrag?.({});
            });
            await screen.settle({ cycles: 1, turns: 1 });
            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({ startRenderingFromBottom: true });

            const overrideProps = screen.requireCapturedFlashListProps().overrideProps as {
                onTouchMove?: (event: unknown) => void;
                onTouchStart?: (event: unknown) => void;
            };
            await act(async () => {
                overrideProps.onTouchStart?.({ nativeEvent: { pageY: 240 } });
                // In inverted mode, dragging the finger down is the away-from-bottom
                // escape direction. This must unlock MVCP before the first scroll frame;
                // otherwise an active streaming session can keep raw offset glued at 0.
                overrideProps.onTouchMove?.({ nativeEvent: { pageY: 280 } });
            });
            await screen.settle({ cycles: 1, turns: 1 });

            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({ startRenderingFromBottom: true });
            await act(async () => {
                screen.requireCapturedFlashListProps().onScrollEndDrag?.({});
            });
            await screen.settle({ cycles: 1, turns: 1 });
            await scrollRaw(screen, 0, dims, { isTrusted: false });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                shouldRestoreViewport: false,
            }));
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
        });

        it('does not re-pin from an untrusted stale bottom frame after an away drag', async () => {
            const onViewportChange = vi.fn();
            const screen = await renderInvertedChatListWithViewportChange(onViewportChange);
            await coldOpenAtBottom(screen, dims);

            await releaseFollowByDrag(screen, 1000, dims);
            expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
            onViewportChange.mockClear();

            await scrollRaw(screen, 0, dims, { isTrusted: false });

            expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                shouldRestoreViewport: false,
            }));
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
        });

        it('maps a large raw offset to visual distance from bottom', async () => {
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            telemetrySink.mockClear();

            await releaseFollowByDrag(screen, 1000, dims);

            // Released: jump-to-bottom reveals (dfb 1000 >= reveal threshold 375).
            expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
            const observed = lastScrollObserved(telemetrySink);
            expect(observed).toMatchObject({
                offsetY: 500,
                rawOffsetY: 1000,
                distanceFromBottom: 1000,
            });
            // Released state also surfaces in MVCP (no longer following).
            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({ startRenderingFromBottom: true });
        });

        it('re-arrives at the bottom when raw offset returns within the pin threshold', async () => {
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);

            await releaseFollowByDrag(screen, 1000, dims);
            expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);

            await act(async () => {
                vi.setSystemTime(new Date(Date.now() + 600));
            });
            // Raw 40 = 40px from the visual bottom (< pin threshold 72): arrival.
            await scrollRaw(screen, 40, dims, { isTrusted: true });
            expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
        });
    });

    describe('deferred newer catchup at the inverted live tail', () => {
        const dims = { layoutHeight: 500, contentHeight: 2000 };

        it('drains deferred newer once when a released reader returns at drag end before momentum settles', async () => {
            configureHarness({
                syncTuningState: {
                    transcriptForwardPrefetchThresholdPx: 300,
                },
            });
            const syncMod = await import('@/sync/sync');
            const loadNewerMessagesMock = vi.mocked(syncMod.sync.loadNewerMessages);
            const effectOrder: string[] = [];
            deferredNewerMockState.sessionIds.add('session-1');
            loadNewerMessagesMock.mockImplementation(async () => {
                effectOrder.push('drain-deferred-newer');
                deferredNewerMockState.sessionIds.delete('session-1');
                return { loaded: 1, hasMore: false, status: 'no_more' };
            });
            loadNewerMessagesMock.mockClear();

            const onViewportChange = vi.fn((state) => {
                if (state.isPinned === true && state.shouldRestoreViewport === false) {
                    effectOrder.push('viewport-pinned');
                }
            });
            const screen = await renderInvertedChatListWithViewportChange(onViewportChange);
            await coldOpenAtBottom(screen, dims);

            await releaseFollowByDrag(screen, 600, dims);
            expect(loadNewerMessagesMock).not.toHaveBeenCalled();

            const flashListProps = screen.requireCapturedFlashListProps();
            await act(async () => {
                flashListProps.onScrollBeginDrag?.({});
            });
            listRefMockState.absoluteScrollOffset = 40;
            onViewportChange.mockClear();
            loadNewerMessagesMock.mockClear();
            effectOrder.length = 0;
            await act(async () => {
                flashListProps.onScrollEndDrag?.({});
                flashListProps.onMomentumScrollBegin?.({});
            });

            expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            }));
            expect(loadNewerMessagesMock).toHaveBeenCalledTimes(1);
            expect(effectOrder).toEqual(['viewport-pinned', 'drain-deferred-newer']);

            onViewportChange.mockClear();
            loadNewerMessagesMock.mockClear();
            effectOrder.length = 0;
            await act(async () => {
                flashListProps.onMomentumScrollEnd?.({});
            });
            await screen.settle({ cycles: 1, turns: 2 });

            expect(onViewportChange).not.toHaveBeenCalled();
            expect(loadNewerMessagesMock).not.toHaveBeenCalled();
            expect(effectOrder).toEqual([]);
        });

        it('does not drain deferred newer when a near-bottom drag began already following', async () => {
            configureHarness({
                syncTuningState: {
                    transcriptForwardPrefetchThresholdPx: 300,
                },
            });
            const syncMod = await import('@/sync/sync');
            const loadNewerMessagesMock = vi.mocked(syncMod.sync.loadNewerMessages);
            deferredNewerMockState.sessionIds.add('session-1');
            loadNewerMessagesMock.mockClear();

            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);

            const flashListProps = screen.requireCapturedFlashListProps();
            await act(async () => {
                flashListProps.onScrollBeginDrag?.({});
            });
            listRefMockState.absoluteScrollOffset = 40;
            await act(async () => {
                flashListProps.onScrollEndDrag?.({});
                flashListProps.onMomentumScrollBegin?.({});
                flashListProps.onMomentumScrollEnd?.({});
            });
            await screen.settle({ cycles: 1, turns: 2 });

            expect(loadNewerMessagesMock).not.toHaveBeenCalled();
        });

        it('drains deferred newer pages exactly once on bottom approach and emits live-tail', async () => {
            configureHarness({
                syncTuningState: {
                    transcriptForwardPrefetchThresholdPx: 300,
                },
            });
            configureTelemetrySink();
            const syncMod = await import('@/sync/sync');
            const loadNewerMessagesMock = vi.mocked(syncMod.sync.loadNewerMessages);
            deferredNewerMockState.sessionIds.add('session-1');
            let resolveLoadNewer: (value: { loaded: number; hasMore: boolean; status: 'no_more' }) => void = () => {
                throw new Error('loadNewerMessages resolver was not captured');
            };
            loadNewerMessagesMock.mockImplementation(() => new Promise((resolve) => {
                resolveLoadNewer = (value) => {
                    deferredNewerMockState.sessionIds.delete('session-1');
                    resolve(value);
                };
            }));
            loadNewerMessagesMock.mockClear();

            const onViewportChange = vi.fn();
            const screen = await renderInvertedChatListWithViewportChange(onViewportChange);
            await coldOpenAtBottom(screen, dims);

            // Leave the inverted live tail. Distance is maxOffset - rawOffset.
            await releaseFollowByDrag(screen, 600, dims);
            expect(loadNewerMessagesMock).not.toHaveBeenCalled();

            // Approaching visual bottom inside the forward threshold routes geometry into the
            // sync-owned drain, which fetches once; in-flight loads are never duplicated (C6/D3 —
            // the list supplies geometry only).
            await scrollRaw(screen, 250, dims, { isTrusted: true });
            expect(loadNewerMessagesMock).toHaveBeenCalledTimes(1);

            await scrollRaw(screen, 240, dims, { isTrusted: true });
            expect(loadNewerMessagesMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                resolveLoadNewer({ loaded: 2, hasMore: false, status: 'no_more' });
            });
            await screen.settle({ cycles: 1, turns: 2 });

            onViewportChange.mockClear();
            await act(async () => {
                vi.setSystemTime(new Date(Date.now() + 600));
            });
            await scrollRaw(screen, 0, dims, { isTrusted: true });

            expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            }));
            expect(loadNewerMessagesMock).toHaveBeenCalledTimes(1);
        });

        it('emits lifecycle pinned viewport before draining when a settled native scroll returns to the live tail', async () => {
            configureHarness({
                syncTuningState: {
                    transcriptForwardPrefetchThresholdPx: 300,
                },
            });
            const syncMod = await import('@/sync/sync');
            const loadNewerMessagesMock = vi.mocked(syncMod.sync.loadNewerMessages);
            const effectOrder: string[] = [];
            deferredNewerMockState.sessionIds.add('session-1');
            loadNewerMessagesMock.mockImplementation(async () => {
                effectOrder.push('drain-deferred-newer');
                deferredNewerMockState.sessionIds.delete('session-1');
                return { loaded: 1, hasMore: false, status: 'no_more' };
            });
            loadNewerMessagesMock.mockClear();

            const onViewportChange = vi.fn((state) => {
                if (state.isPinned === true && state.shouldRestoreViewport === false) {
                    effectOrder.push(`viewport-pinned:${state.offsetY}`);
                }
            });
            const screen = await renderInvertedChatListWithViewportChange(onViewportChange);
            await coldOpenAtBottom(screen, dims);

            await releaseFollowByDrag(screen, 600, dims);
            const flashListProps = screen.requireCapturedFlashListProps();
            await act(async () => {
                flashListProps.onMomentumScrollEnd?.({});
            });
            await screen.settle({ cycles: 1, turns: 2 });
            expect(loadNewerMessagesMock).not.toHaveBeenCalled();

            onViewportChange.mockClear();
            loadNewerMessagesMock.mockClear();
            effectOrder.length = 0;
            await act(async () => {
                vi.setSystemTime(new Date(Date.now() + 600));
            });
            await scrollRaw(screen, 40, dims, { isTrusted: true });

            expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            }));
            expect(loadNewerMessagesMock).toHaveBeenCalledTimes(1);
            expect(effectOrder).toEqual(['viewport-pinned:0', 'drain-deferred-newer']);
        });
    });

    describe('jump-to-bottom (explicit owner)', () => {
        it('issues exactly one list-start scrollToIndex write and never scrollToOffset/scrollToEnd', async () => {
            const dims = { layoutHeight: 500, contentHeight: 2000 };
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            await releaseFollowByDrag(screen, 1000, dims);

            fileFlashListRefHandle.scrollToOffset.mockClear();
            fileFlashListRefHandle.scrollToIndex.mockClear();
            telemetrySink.mockClear();

            const jumpButtons = screen.findAllByTestId('transcript-jump-to-bottom');
            expect(jumpButtons.length).toBeGreaterThan(0);
            await act(async () => {
                jumpButtons[0]!.props.onPress?.();
            });
            await screen.settle({ cycles: 1, turns: 1 });

            // Device-proven: an inverted FlashList IGNORES scrollToOffset({offset: 0}) (the list does
            // not move to raw 0). The user-facing bottom command must target the newest row at list
            // start via scrollToIndex(0). Never reuse observed-offset max math (scrollToEnd) for Jump.
            expect(fileFlashListRefHandle.scrollToEnd).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToIndex).toHaveBeenCalledTimes(1);
            expect(fileFlashListRefHandle.scrollToIndex).toHaveBeenCalledWith({ index: 0, animated: false });
            const writes = committedScrollWrites(telemetrySink);
            expect(writes).toHaveLength(1);
            expect(writes[0]).toMatchObject({
                writer: 'native-explicit-jump',
                reason: 'jump-to-bottom',
                targetOffsetY: 0,
            });
        });

        it('does not issue a stale explicit bottom write when the native list is already at bottom', async () => {
            const dims = { layoutHeight: 500, contentHeight: 2000 };
            const telemetrySink = configureTelemetrySink();
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            await releaseFollowByDrag(screen, 1000, dims);

            const jumpButtons = screen.findAllByTestId('transcript-jump-to-bottom');
            expect(jumpButtons.length).toBeGreaterThan(0);

            // Stale affordance case: the visible button reflects the previous released state,
            // but the native list has already rubber-banded back to exact visual bottom before
            // the tap is delivered. Re-issuing scrollToIndex(0, viewOffset) here creates the
            // visible jump-up-then-back bounce this test prevents.
            listRefMockState.absoluteScrollOffset = 0;
            fileFlashListRefHandle.scrollToOffset.mockClear();
            fileFlashListRefHandle.scrollToEnd.mockClear();
            fileFlashListRefHandle.scrollToIndex.mockClear();
            telemetrySink.mockClear();

            await act(async () => {
                jumpButtons[0]!.props.onPress?.();
            });
            await screen.settle({ cycles: 1, turns: 1 });

            expect(fileFlashListRefHandle.scrollToEnd).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
        });
    });

    describe('native target-window mode', () => {
        function messagesForSeqRange(startSeq: number, count: number, label: string) {
            return Array.from({ length: count }, (_, index) => {
                const seq = startSeq + index;
                return {
                    kind: 'agent-text' as const,
                    id: `m${seq}`,
                    localId: null,
                    createdAt: seq,
                    seq,
                    text: `${label} ${seq}`,
                };
            });
        }

        function activateWindowState(
            sessionId: string,
            targetSeq: number,
            messages: readonly { seq: number }[],
            options: Readonly<{ hasMoreOlder?: boolean; hasMoreNewer?: boolean }> = {},
        ): void {
            targetWindowMockState.bySessionId.set(sessionId, {
                isWindowMode: true,
                windowId: `target:${sessionId}:${targetSeq}`,
                targetSeq,
                windowMinSeq: messages[0]?.seq ?? targetSeq,
                windowMaxSeq: messages[messages.length - 1]?.seq ?? targetSeq,
                olderCursor: messages[0]?.seq ?? targetSeq,
                newerCursor: messages[messages.length - 1]?.seq ?? targetSeq,
                hasMoreOlder: options.hasMoreOlder ?? true,
                hasMoreNewer: options.hasMoreNewer ?? true,
                activatedAtMs: 1,
            });
        }

        it('activates native window mode for a far jump', async () => {
            const targetWindowMessages = messagesForSeqRange(327, 10, 'target window');
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: messagesForSeqRange(437, 16, 'tail'),
            };
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                seq: 452,
            };
            targetWindowMockState.loadTargetWindowMessages.mockImplementation(async (
                sessionId: string,
                target: { kind: 'seq'; seq: number },
                options: { direction?: string } = {},
            ) => {
                expect(sessionId).toBe('session-1');
                expect(target).toEqual({ kind: 'seq', seq: 331 });
                expect(options.direction).toBe('older');
                activateWindowState(sessionId, target.seq, targetWindowMessages);
                flashListChatListHarnessState.sessionMessagesState = {
                    isLoaded: true,
                    messages: targetWindowMessages,
                };
                return {
                    status: 'loaded',
                    windowId: 'target:session-1:331',
                    targetSeq: 331,
                    targetPresent: true,
                    rawSeqs: targetWindowMessages.map((message) => message.seq),
                    appliedSeqs: targetWindowMessages.map((message) => message.seq),
                    olderCursor: 327,
                    newerCursor: 336,
                    hasMoreOlder: true,
                    hasMoreNewer: true,
                };
            });

            const { ChatList } = await import('./ChatList');
            const screen = await renderFlashListChatList(
                <ChatList session={flashListChatListHarnessState.sessionState} jumpToSeq={331} />,
            );
            await screen.triggerInitialFill({
                layoutHeight: 500,
                contentHeight: 2000,
                flushOptions: { cycles: 1, turns: 2 },
            });
            await screen.settle({ cycles: 1, turns: 3 });

            expect(targetWindowMockState.loadTargetWindowMessages).toHaveBeenCalledTimes(1);
            expect(targetWindowMockState.bySessionId.get('session-1')).toMatchObject({
                isWindowMode: true,
                targetSeq: 331,
                windowMinSeq: 327,
                windowMaxSeq: 336,
            });
        });

        it('aligns an active native target window through the explicit jump command path', async () => {
            const targetWindowMessages = messagesForSeqRange(327, 10, 'target window');
            activateWindowState('session-1', 331, targetWindowMessages);
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: targetWindowMessages,
            };
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                seq: 452,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderFlashListChatList(
                <ChatList session={flashListChatListHarnessState.sessionState} jumpToSeq={331} />,
            );
            await screen.triggerInitialFill({
                layoutHeight: 500,
                contentHeight: 2000,
                flushOptions: { cycles: 1, turns: 2 },
            });
            await screen.settle({ cycles: 1, turns: 2 });

            expect(targetWindowMockState.loadTargetWindowMessages).not.toHaveBeenCalled();
            expect(listDataIds(screen)).toEqual([
                'transcript-window-gap:target:session-1:331:newer',
                'm336', 'm335', 'm334', 'm333', 'm332', 'm331', 'm330', 'm329', 'm328', 'm327',
                'transcript-window-gap:target:session-1:331:older',
            ]);
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToEnd).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
                index: 6,
                animated: true,
                viewPosition: 0.5,
            });
        });

        it('exits native window mode on jump-to-bottom', async () => {
            const dims = { layoutHeight: 500, contentHeight: 2000 };
            const targetWindowMessages = messagesForSeqRange(327, 10, 'target window');
            activateWindowState('session-1', 331, targetWindowMessages);
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: targetWindowMessages,
            };
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            await releaseFollowByDrag(screen, 1000, dims);

            const jumpButtons = screen.findAllByTestId('transcript-jump-to-bottom');
            expect(jumpButtons.length).toBeGreaterThan(0);
            await act(async () => {
                jumpButtons[0]!.props.onPress?.();
            });
            await screen.settle({ cycles: 1, turns: 1 });

            expect(targetWindowMockState.markSessionLiveTailIntent).toHaveBeenCalledWith('session-1');
            expect(targetWindowMockState.bySessionId.get('session-1')).toMatchObject({
                isWindowMode: false,
            });
        });

        it('renders the next session outside window mode after a session switch', async () => {
            const targetWindowMessages = messagesForSeqRange(327, 10, 'target window');
            activateWindowState('session-1', 331, targetWindowMessages);
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: targetWindowMessages,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderFlashListChatList(
                <ChatList session={flashListChatListHarnessState.sessionState} />,
            );
            await screen.triggerInitialFill({
                layoutHeight: 500,
                contentHeight: 2000,
                flushOptions: { cycles: 1, turns: 2 },
            });
            expect(listDataIds(screen)).toEqual([
                'transcript-window-gap:target:session-1:331:newer',
                'm336', 'm335', 'm334', 'm333', 'm332', 'm331', 'm330', 'm329', 'm328', 'm327',
                'transcript-window-gap:target:session-1:331:older',
            ]);

            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: OLDEST_FIRST_MESSAGES.map((message) => ({ ...message, id: `s2-${message.id}` })),
            };
            await act(async () => {
                screen.tree.update(
                    <ChatList
                        session={{
                            ...flashListChatListHarnessState.sessionState,
                            id: 'session-2',
                            seq: 4,
                        }}
                    />,
                );
            });
            await screen.settle({ cycles: 1, turns: 2 });

            expect(targetWindowMockState.bySessionId.get('session-2')).toBeUndefined();
            expect(listDataIds(screen)).toEqual(['s2-m4', 's2-m3', 's2-m2', 's2-m1']);
        });
    });

    describe('older pagination at the older edge', () => {
        const dims = { layoutHeight: 500, contentHeight: 2000 };

        async function installOlderPageLoad(): Promise<ReturnType<typeof vi.mocked<(typeof import('@/sync/sync'))['sync']['loadOlderMessages']>>> {
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockImplementation(async () => {
                flashListChatListHarnessState.sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm0a', localId: null, createdAt: 0.1, seq: -2, text: 'older a' },
                        { kind: 'agent-text', id: 'm0b', localId: null, createdAt: 0.2, seq: -1, text: 'older b' },
                        ...flashListChatListHarnessState.sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: false, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();
            return loadOlderMessagesMock;
        }

        it('triggers the older load when the raw offset approaches the physical older edge', async () => {
            configureHarness({ syncTuningState: { transcriptBackwardPrefetchThresholdPx: 240 } });
            const loadOlderMessagesMock = await installOlderPageLoad();

            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            expect(loadOlderMessagesMock).not.toHaveBeenCalled();

            // Release follow first (raw 1000 = 1000px from the visual bottom).
            await releaseFollowByDrag(screen, 1000, dims);
            expect(loadOlderMessagesMock).not.toHaveBeenCalled();

            // Raw 1400 is 100px from the older-history edge and maps to
            // canonical offset 100, which is inside the threshold but not exact zero.
            await scrollRaw(screen, 1400, dims);
            await screen.settle({ cycles: 2, turns: 4 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
        });

        it('feeds the missed-event nudge through onEndReached and self-gates by canonical offset', async () => {
            configureHarness({ syncTuningState: { transcriptBackwardPrefetchThresholdPx: 240 } });
            const loadOlderMessagesMock = await installOlderPageLoad();

            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            await releaseFollowByDrag(screen, 1000, dims);
            loadOlderMessagesMock.mockClear();

            const props = screen.requireCapturedFlashListProps();
            // Both edge callbacks route to the same nudge under inverted (FlashList #1785
            // family: the OLDER edge is the data END, observed by onEndReached).
            expect(typeof props.onStartReached).toBe('function');
            expect(typeof props.onEndReached).toBe('function');

            // Nudge from the NEWEST edge (visual bottom/raw 0) is far from the older threshold.
            listRefMockState.absoluteScrollOffset = 0;
            await act(async () => {
                props.onStartReached?.();
            });
            await screen.settle({ cycles: 2, turns: 2 });
            expect(loadOlderMessagesMock).not.toHaveBeenCalled();

            // Nudge from the OLDER edge (raw max): loads once.
            listRefMockState.absoluteScrollOffset = 1500;
            await act(async () => {
                props.onEndReached?.();
            });
            await screen.settle({ cycles: 2, turns: 4 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
        });

        it('does not treat the inverted visual bottom as the older edge after a bottom command', async () => {
            configureHarness({ syncTuningState: { transcriptBackwardPrefetchThresholdPx: 240 } });
            const loadOlderMessagesMock = await installOlderPageLoad();

            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            await releaseFollowByDrag(screen, 1000, dims);
            loadOlderMessagesMock.mockClear();

            const props = screen.requireCapturedFlashListProps();

            // Inverted visual bottom is the list-start command target. It must not be
            // interpreted as the older-history edge by scroll observations or edge callbacks.
            await scrollRaw(screen, 0, dims);
            await act(async () => {
                props.onStartReached?.();
            });
            await screen.settle({ cycles: 2, turns: 2 });
            expect(loadOlderMessagesMock).not.toHaveBeenCalled();

            // The older-history edge is the opposite end of the inverted scroller.
            listRefMockState.absoluteScrollOffset = 1500;
            await act(async () => {
                props.onEndReached?.();
            });
            await screen.settle({ cycles: 2, turns: 4 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
        });

        it('does not let a visual-bottom edge callback load older from a stale older-edge offset', async () => {
            configureHarness({ syncTuningState: { transcriptBackwardPrefetchThresholdPx: 240 } });
            const loadOlderMessagesMock = await installOlderPageLoad();

            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            await releaseFollowByDrag(screen, 1000, dims);
            loadOlderMessagesMock.mockClear();

            const props = screen.requireCapturedFlashListProps();

            // FlashList can dispatch the data-start callback while its ref still
            // reports the previous absolute offset. In inverted mode data-start is
            // visual bottom, so older pagination must be gated by callback edge
            // ownership, not inferred only from a potentially stale ref offset.
            listRefMockState.absoluteScrollOffset = 1500;
            await act(async () => {
                props.onStartReached?.();
            });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(loadOlderMessagesMock).not.toHaveBeenCalled();

            await act(async () => {
                props.onEndReached?.();
            });
            await screen.settle({ cycles: 2, turns: 4 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
        });

        it('commits the older page as a data-end append without a prepend transaction or writes', async () => {
            configureHarness({ syncTuningState: { transcriptBackwardPrefetchThresholdPx: 240 } });
            const telemetrySink = configureTelemetrySink();
            const loadOlderMessagesMock = await installOlderPageLoad();
            listRefMockState.rowHeightPx = 500;

            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            await releaseFollowByDrag(screen, 1000, dims);
            telemetrySink.mockClear();
            fileFlashListRefHandle.scrollToOffset.mockClear();
            fileFlashListRefHandle.scrollToIndex.mockClear();

            await scrollRaw(screen, 1400, dims);
            await screen.settle({ cycles: 2, turns: 4 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // The store grew: re-render the host so the new page reaches the list
            // (mock storage hooks are not reactive; the sibling suite drives this the
            // same way), then let the content commit feed the prepend observation.
            const { ChatList } = await import('./ChatList');
            await screen.update(
                <ChatList
                    session={renderHarnessSession()}
                    onEditPendingMessage={forceTranscriptHarnessRender()}
                />,
            );
            // In inverted data terms the older page APPENDS at the data end: every
            // previously rendered row keeps its index, layout, and raw offset.
            await screen.triggerContentSizeChange(0, 3000, { cycles: 2, turns: 2, frames: 1 });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0b', 'm0a']);
            expect(sinkEvents(telemetrySink)).not.toContainEqual(expect.objectContaining({
                type: 'restore-decision',
                mode: 'restore-anchor',
                orientation: 'inverted',
            }));
            // Zero writes by construction: older history appends at the inverted
            // data end, so the standard prepend transaction is not involved.
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            expect(committedScrollWrites(telemetrySink).filter((event) => event.reason === 'entry-restore')).toEqual([]);
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        });

        it('does not spend a prepend fallback write for an inverted older-page append with transient shifted layouts', async () => {
            configureHarness({ syncTuningState: { transcriptBackwardPrefetchThresholdPx: 240 } });
            const telemetrySink = configureTelemetrySink();
            const loadOlderMessagesMock = await installOlderPageLoad();
            listRefMockState.rowHeightPx = 500;

            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, dims);
            await releaseFollowByDrag(screen, 1000, dims);
            telemetrySink.mockClear();
            fileFlashListRefHandle.scrollToOffset.mockClear();
            fileFlashListRefHandle.scrollToIndex.mockClear();

            await scrollRaw(screen, 1400, dims);
            await screen.settle({ cycles: 2, turns: 4 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // Android live QA observed this exact class: the older page appends at the
            // inverted data end, but the post-commit anchor observation can report a
            // shifted layout. That transient must not activate the standard prepend
            // fallback; the commit is append-by-construction in inverted mode.
            listRefMockState.correctorHoldFirstDataId = 'm4';
            listRefMockState.correctorShiftPx = 240;

            const { ChatList } = await import('./ChatList');
            await screen.update(
                <ChatList
                    session={renderHarnessSession()}
                    onEditPendingMessage={forceTranscriptHarnessRender()}
                />,
            );
            await screen.triggerContentSizeChange(0, 3000, { cycles: 2, turns: 2, frames: 1 });
            await screen.settle({ advanceTimersMs: 500, cycles: 2, turns: 4 });

            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0b', 'm0a']);
            expect(sinkEvents(telemetrySink)).not.toContainEqual(expect.objectContaining({
                type: 'restore-decision',
                reason: 'fallback-restored',
                orientation: 'inverted',
            }));
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            expect(committedScrollWrites(telemetrySink).filter((event) => event.reason === 'entry-restore')).toEqual([]);
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        });
    });

    describe('anchored entry (slice-from-anchor, N2b.2 under inverted)', () => {
        it('keeps a persisted-anchor entry pending while content metrics are still under-filled even if the anchor row is visible', async () => {
            const telemetrySink = configureTelemetrySink();
            sessionViewportMockState.byId.set('session-1', {
                isPinned: false,
                offsetY: 400,
                anchor: { kind: 'message', messageId: 'm2', itemId: 'm2', itemOffsetPx: 0, capturedAtMs: 1 },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            listRefMockState.visibleRange = { startIndex: 0, endIndex: 0 };

            const screen = await renderInvertedChatList();
            await screen.triggerInitialFill({
                layoutHeight: 800,
                contentHeight: 600,
                contentWidth: 0,
                flushOptions: { cycles: 1, turns: 2 },
            });

            // Non-follow regression guard (cold-open deadlock fix scope): a shouldFollowBottom:false
            // restore entry must STILL hold the entry viewport transaction open at first paint —
            // the bottom autoscroll threshold must NOT arm until the remembered anchor restores.
            // The first-paint early-close only applies to inverted follow-bottom, never to restore
            // entries. Either no native MVCP props yet (undefined) or the bare
            // startRenderingFromBottom object satisfies "threshold not armed"; only an armed
            // autoscrollToBottomThreshold would be a leak of the follow-bottom early-close.
            const restoreEntryMvcp = screen.requireCapturedFlashListProps().maintainVisibleContentPosition;
            expect(restoreEntryMvcp == null || !('autoscrollToBottomThreshold' in restoreEntryMvcp)).toBe(true);

            await screen.triggerContentSizeChange(0, 600, { cycles: 2, turns: 2, frames: 1 });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(sinkEvents(telemetrySink)).not.toContainEqual(expect.objectContaining({
                type: 'restore-decision',
                reason: 'restored',
                mode: 'restore-anchor',
            }));
            expect(committedScrollWrites(telemetrySink)).toEqual([]);

            await screen.triggerContentSizeChange(0, 1000, { cycles: 2, turns: 2, frames: 1 });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'restore-decision',
                reason: 'restored',
                mode: 'restore-anchor',
            }));
            expect(committedScrollWrites(telemetrySink).filter((event) => event.reason === 'entry-restore')).toEqual([]);
        });

        it('keeps a persisted-anchor entry pending until the durable anchor row is actually visible', async () => {
            const telemetrySink = configureTelemetrySink();
            sessionViewportMockState.byId.set('session-1', {
                isPinned: false,
                offsetY: 400,
                anchor: { kind: 'message', messageId: 'm2', itemId: 'm2', itemOffsetPx: 0, capturedAtMs: 1 },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            listRefMockState.visibleRange = { startIndex: 1, endIndex: 1 };
            listRefMockState.correctorHoldFirstDataId = 'm4';
            listRefMockState.correctorShiftPx = 240;

            const screen = await renderInvertedChatList();
            await screen.triggerInitialFill({
                layoutHeight: 800,
                contentHeight: 1000,
                contentWidth: 0,
                flushOptions: { cycles: 1, turns: 2 },
            });

            expect(listDataIds(screen)).toEqual(['m2', 'm1']);
            await screen.triggerContentSizeChange(0, 1000, { cycles: 2, turns: 2, frames: 1 });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(sinkEvents(telemetrySink)).not.toContainEqual(expect.objectContaining({
                type: 'restore-decision',
                reason: 'restored',
                mode: 'restore-anchor',
            }));
            expect(listDataIds(screen)).toEqual(['m2', 'm1']);
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            fileFlashListRefHandle.scrollToOffset.mockClear();
            fileFlashListRefHandle.scrollToIndex.mockClear();

            listRefMockState.correctorHoldFirstDataId = null;
            listRefMockState.correctorShiftPx = 0;
            listRefMockState.visibleRange = { startIndex: 0, endIndex: 0 };
            await screen.triggerContentSizeChange(0, 1000, { cycles: 2, turns: 2, frames: 1 });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'restore-decision',
                reason: 'restored',
                mode: 'restore-anchor',
            }));
            expect(committedScrollWrites(telemetrySink).filter((event) => event.reason === 'entry-restore')).toEqual([]);
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        });

        it('falls back to a precise anchor write when the saved offset is incompatible with write-free slice', async () => {
            const telemetrySink = configureTelemetrySink();
            sessionViewportMockState.byId.set('session-1', {
                isPinned: false,
                offsetY: 400,
                anchor: { kind: 'message', messageId: 'm2', itemId: 'm2', itemOffsetPx: 60, capturedAtMs: 1 },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            listRefMockState.correctorHoldFirstDataId = 'm4';
            listRefMockState.correctorShiftPx = 180;
            listRefMockState.visibleRange = { startIndex: 2, endIndex: 2 };

            const screen = await renderInvertedChatList();
            await screen.triggerInitialFill({
                layoutHeight: 800,
                contentHeight: 1000,
                contentWidth: 0,
                flushOptions: { cycles: 1, turns: 2 },
            });
            await scrollRaw(screen, 0, { layoutHeight: 800, contentHeight: 1000 });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            expect(fileFlashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
                animated: false,
                index: 2,
                viewOffset: -60,
            });
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'restore-decision',
                reason: 'restored',
                mode: 'restore-anchor',
            }));
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
        });

        it('confirms a visible slice-entry anchor from raw list coordinates, not canonical offset coordinates', async () => {
            const telemetrySink = configureTelemetrySink();
            sessionViewportMockState.byId.set('session-1', {
                isPinned: false,
                offsetY: 400,
                anchor: { kind: 'message', messageId: 'm2', itemId: 'm2', itemOffsetPx: 0, capturedAtMs: 1 },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            listRefMockState.layoutAvailable = false;
            listRefMockState.visibleRange = { startIndex: 0, endIndex: 0 };

            const screen = await renderInvertedChatList();
            await screen.triggerInitialFill({
                layoutHeight: 800,
                contentHeight: 1000,
                contentWidth: 0,
                flushOptions: { cycles: 1, turns: 2 },
            });
            await screen.triggerContentSizeChange(0, 1000, { cycles: 2, turns: 2, frames: 1 });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(sinkEvents(telemetrySink)).not.toContainEqual(expect.objectContaining({
                type: 'restore-decision',
                reason: 'restored',
                mode: 'restore-anchor',
            }));

            listRefMockState.layoutAvailable = true;
            await scrollRaw(screen, 0, { layoutHeight: 800, contentHeight: 1000 });

            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'restore-decision',
                reason: 'restored',
                mode: 'restore-anchor',
            }));
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        });

        it('renders the [anchor..oldest] window write-free, then reveals the withheld NEWER rows as a prepend-observed commit', async () => {
            const telemetrySink = configureTelemetrySink();
            sessionViewportMockState.byId.set('session-1', {
                isPinned: false,
                offsetY: 400,
                anchor: { kind: 'message', messageId: 'm2', itemId: 'm2', itemOffsetPx: 0, capturedAtMs: 1 },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            // Unmeasured at entry: the observe-only transaction stays open (inconclusive)
            // until layout becomes available.
            listRefMockState.layoutAvailable = false;
            // Corrector-faithful reveal: when the withheld NEWER rows insert at the data
            // start (rendered head 'm4'), previously rendered rows keep their VISUAL
            // position (2 revealed rows x 120px held by the corrector).
            listRefMockState.correctorHoldFirstDataId = 'm4';
            listRefMockState.correctorShiftPx = 240;

            const screen = await renderInvertedChatList();
            await screen.triggerInitialFill({
                layoutHeight: 800,
                contentHeight: 1000,
                contentWidth: 0,
                flushOptions: { cycles: 1, turns: 2 },
            });

            // Inverted slice bounds: withhold NEWER rows — the rendered window is
            // [anchor..oldest] with the anchor at rendered index 0. The entry is
            // observe-only: it never uses a raw-offset write to place that anchor.
            expect(listDataIds(screen)).toEqual(['m2', 'm1']);
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
            // Entry transaction open: MVCP stays default-enabled (no props).
            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toBeUndefined();

            // The anchor row becomes measurable: confirmation is observation-only.
            listRefMockState.layoutAvailable = true;
            await screen.triggerContentSizeChange(0, 1000, { cycles: 2, turns: 2, frames: 1 });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'restore-decision',
                reason: 'restored',
                mode: 'restore-anchor',
            }));

            // Reveal: the withheld NEWER rows insert at the data start and the prepend
            // transaction closes mvcp-preserved (corrector-covered, zero writes).
            await screen.triggerContentSizeChange(0, 1240, { cycles: 2, turns: 2, frames: 1 });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                reason: 'mvcp-preserved',
            }));

            // Invariant B: anchored entry = 0 writes, reveal included.
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
            assertScenario(sinkEvents(telemetrySink), 'warm-reopen');
        });
    });

    describe('under-filled session (content < viewport)', () => {
        it('commits an under-filled data-end older append without a prepend transaction or write', async () => {
            const telemetrySink = configureTelemetrySink();
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockResolvedValue({
                loaded: 0,
                hasMore: false,
                status: 'no_more',
            });

            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 800, contentHeight: 300 });
            telemetrySink.mockClear();
            fileFlashListRefHandle.scrollToOffset.mockClear();
            fileFlashListRefHandle.scrollToIndex.mockClear();

            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm0a', localId: null, createdAt: 0.1, seq: -2, text: 'older a' },
                    { kind: 'agent-text', id: 'm0b', localId: null, createdAt: 0.2, seq: -1, text: 'older b' },
                    ...flashListChatListHarnessState.sessionMessagesState.messages,
                ],
            };
            const { ChatList } = await import('./ChatList');
            await screen.update(
                <ChatList
                    session={renderHarnessSession()}
                    onEditPendingMessage={forceTranscriptHarnessRender()}
                />,
            );
            await screen.triggerContentSizeChange(0, 520, { cycles: 2, turns: 2, frames: 1 });
            await screen.settle({ cycles: 2, turns: 2 });

            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0b', 'm0a']);
            expect(sinkEvents(telemetrySink)).not.toContainEqual(expect.objectContaining({
                type: 'restore-decision',
                mode: 'restore-anchor',
                orientation: 'inverted',
            }));
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        });

        it('issues no writes and no pagination storm', async () => {
            const telemetrySink = configureTelemetrySink();
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockImplementation(async () => ({
                loaded: 0,
                hasMore: false,
                status: 'no_more' as const,
            }));
            loadOlderMessagesMock.mockClear();

            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 800, contentHeight: 300 });

            // Under-filled inverted content renders at the visual bottom by construction;
            // no MVCP-dependent write may be issued (FlashList #2050 family).
            expect(fileFlashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(fileFlashListRefHandle.scrollToEnd).not.toHaveBeenCalled();
            expect(committedScrollWrites(telemetrySink)).toEqual([]);
            // One terminal fill probe is allowed; a storm is not.
            expect(loadOlderMessagesMock.mock.calls.length).toBeLessThanOrEqual(1);
            expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
        });
    });

    describe('warm reopen at the inverted exact bottom (I-13: reopen is not blank)', () => {
        // The product owner's I-13: reopening a session that was sitting at the exact (inverted)
        // bottom rendered a blank under-fill until rows re-measured a frame later. C1 cures it at
        // the source: stable rows reserve their last measured height from the cross-session warm
        // cache, so the FIRST paint on reopen already occupies real height — never a blank gap.
        // This proves the cure on the INVERTED path the user actually runs (the flash_v2 suite
        // proves the equivalent warm-remount reservation on the non-inverted path).
        it('reserves cached row heights on a warm remount so the inverted bottom paints rows instead of a blank under-fill', async () => {
            const first = await renderInvertedChatList();
            // Measure the newest stable agent rows → populate the cross-session warm height cache.
            await fireTranscriptItemShellLayout(findTranscriptItemShell(first, 'm4'), 132);
            await fireTranscriptItemShellLayout(findTranscriptItemShell(first, 'm3'), 96);
            await act(async () => {
                first.tree.unmount();
            });

            // Warm-reopen the SAME session (a fresh mount over the warm cache).
            const warm = await renderInvertedChatList();

            // The reopened inverted list still pins to the visual bottom (newest)…
            expect(warm.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({
                startRenderingFromBottom: true,
            });
            // …and the newest rows reserve their cached measured height on the FIRST paint, so the
            // exact-bottom reopen renders rows at real height instead of underfilling to blank
            // (I-13) — no fresh onLayout required before the viewport is filled.
            expect(readStyleMinHeight(findTranscriptItemShell(warm, 'm4').props.style)).toBe(132);
            expect(readStyleMinHeight(findTranscriptItemShell(warm, 'm3').props.style)).toBe(96);

            await act(async () => {
                warm.tree.unmount();
            });
        });
    });

    describe('native hot/cold streaming split (Phase 1, flag-gated)', () => {
        it('flag OFF (default 0) keeps EVERY row in the recycler — identical to today', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 0 } });
            const screen = await renderInvertedChatList();

            // The full inverted (newest-first) array is the FlashList data; nothing is carved out.
            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);

            await act(async () => {
                screen.tree.unmount();
            });
        });

        it('flag ON (count 1) but idle carves NOTHING — live-tail-only keeps every row in the recycler', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            const screen = await renderInvertedChatList();

            // liveTailOnly: the native edge-slot carve engages ONLY while a row is actively streaming
            // (activeThinkingMessageId). With nothing streaming there is NO carve — every row stays in
            // the recycler and no detached edge-slot block renders at the bottom (the device-reported
            // idle "orphan"). The carve-while-streaming segmentation (live tail from the streaming row
            // to the end, bounded) is covered by buildTranscriptHotColdSegments.test.ts.
            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);

            await act(async () => {
                screen.tree.unmount();
            });
        });

        it('carves the actively-streaming live row out of the recycler (text streaming)', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            markNewestAgentMessageStreaming('m4');
            const screen = await renderInvertedChatList();

            // m4 streams → carved into the inverted edge slot; older committed rows stay in the
            // recycler (cold). The cold list keeps at least one row and never holds the live row.
            expect(listDataIds(screen)).toEqual(['m3', 'm2', 'm1']);
            expect(screen.findByTestId('transcript-native-hot-tail')).not.toBeNull();
            expect(screen.findByTestId('transcript-native-hot-tail-item-m4')).not.toBeNull();

            await act(async () => { screen.tree.unmount(); });
        });

        it('carves an in-flight (running) tool-call row of an ACTIVE session without any thinking pulse (R2 positive control)', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            // Newest row is a running tool call (no streaming text, no thinking) on an ACTIVE session —
            // a genuine live tail, so it carves. The running-tool anchor is scoped to session.active
            // (R2): an idle session with the same stale running tool must NOT carve (next test).
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                active: true,
            };
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...OLDEST_FIRST_MESSAGES.slice(0, 3).map((message) => ({ ...message })),
                    { kind: 'tool-call', id: 'm4', localId: null, createdAt: 4, seq: 4, tool: { state: 'running' } },
                ],
            };
            const screen = await renderInvertedChatList();

            expect(screen.findByTestId('transcript-native-hot-tail')).not.toBeNull();
            expect(listDataIds(screen)).toEqual(['m3', 'm2', 'm1']);

            await act(async () => { screen.tree.unmount(); });
        });

        it('does NOT carve an idle session whose trailing tool is stuck in `running` (R2 orphan fix)', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            // The orphan repro: a tool left `running` after a disconnect/missed-completion while the
            // session is otherwise idle (active:false, thinking:false). The running-tool anchor must be
            // scoped to the genuinely-active region — an idle stuck tool yields NO anchor → NO carve,
            // so the trailing rows are not permanently detached into the edge slot.
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                active: false,
                thinking: false,
            };
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...OLDEST_FIRST_MESSAGES.slice(0, 3).map((message) => ({ ...message })),
                    { kind: 'tool-call', id: 'm4', localId: null, createdAt: 4, seq: 4, tool: { state: 'running' } },
                ],
            };
            const screen = await renderInvertedChatList();

            // Every row stays in the recycler; no detached edge-slot block at the bottom.
            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);

            await act(async () => { screen.tree.unmount(); });
        });

        it('engages the carve via the whole-turn floor for legacy/no-segment-meta streaming text (Gemini case, R5)', async () => {
            const telemetrySink = configureTelemetrySink();
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            // Legacy / Gemini path: assistant text carries NO `segmentState` meta (the default
            // OLDEST_FIRST_MESSAGES are bare agent-text), so no row is detectably mid-stream. A REAL
            // streaming turn is both `active` AND `thinking` — the whole-turn floor (gated on
            // sessionActive like the streaming-message + running-tool anchors) anchors the carve at the
            // newest committed row (m4) instead of leaving the growing answer in the recycler.
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                active: true,
                thinking: true,
            };
            const screen = await renderInvertedChatList();

            // The carve engages and the newest committed row (m4) is the carved live row.
            expect(screen.findByTestId('transcript-native-hot-tail-item-m4')).not.toBeNull();
            expect(listDataIds(screen)).toEqual(['m3', 'm2', 'm1']);

            // Provenance proof: the carve pin stamps the whole-turn-floor anchor at m4 (NOT a
            // streaming-message/tool anchor — there is no segment meta), so QA can see the legacy
            // path engaged through the floor, not a per-row stream signal.
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });
            telemetrySink.mockClear();
            await measureNativeHotTailRows(screen, 180);

            const pins = carvePinWrites(telemetrySink);
            expect(pins.length).toBeGreaterThan(0);
            expect(pins[pins.length - 1]).toMatchObject({
                liveRegionActive: true,
                liveTailAnchorKind: 'turn-floor',
                liveTailAnchorId: 'm4',
            });

            await act(async () => { screen.tree.unmount(); });
        });

        it('recomputes the anchor when a row flips streaming -> complete (memo freshness, R5)', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            // m4 streams → carve engages on m4.
            markNewestAgentMessageStreaming('m4');
            const screen = await renderInvertedChatList();
            expect(screen.findByTestId('transcript-native-hot-tail-item-m4')).not.toBeNull();
            expect(listDataIds(screen)).toEqual(['m3', 'm2', 'm1']);

            // The segment finalizes (streaming -> complete) and nothing else is live (idle). The carve
            // memo MUST recompute the anchor off the flipped segmentState — a stale memo would keep m4
            // detached in the edge slot forever (the silent-staleness regression this pins).
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: flashListChatListHarnessState.sessionMessagesState.messages.map((message: any) =>
                    message.id === 'm4'
                        ? { ...message, kind: 'agent-text', meta: undefined }
                        : message),
            };
            const { ChatList } = await import('./ChatList');
            await screen.update(
                <ChatList
                    session={renderHarnessSession()}
                    onEditPendingMessage={forceTranscriptHarnessRender()}
                />,
            );

            // Anchor recomputed to null → no carve → every row back in the recycler.
            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);

            await act(async () => { screen.tree.unmount(); });
        });

        it('keeps the carve across the whole active turn — the thinking→answer transition does not collapse it', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            // The transition frame of a REAL active turn: session is `active` AND `thinking` spans the
            // whole turn, but the thinking pulse has cleared (no activeThinkingMessageId) and the newest
            // committed row is not yet flagged streaming. Without the whole-turn floor the carve would
            // collapse here (the device repro). The floor is gated on sessionActive (FIX 1), so a
            // genuinely-active turn still carves.
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                active: true,
                thinking: true,
            };
            const screen = await renderInvertedChatList();

            // The whole-turn floor anchors the carve at the latest committed row — carve stays engaged.
            expect(screen.findByTestId('transcript-native-hot-tail')).not.toBeNull();
            expect(listDataIds(screen)).toEqual(['m3', 'm2', 'm1']);

            await act(async () => { screen.tree.unmount(); });
        });

        it('does NOT carve via the whole-turn floor when the session is not active (thinking && !active is not a live turn)', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            // The orphan-prone state: `session.thinking` is stale-true but `session.active` is false
            // (e.g. a debounced thinking grace flag lingering after the turn ended, or a thinking flag
            // left set across a disconnect). A `thinking && !active` state is NOT a live turn — the
            // whole-turn floor must fail closed on sessionActive just like the streaming-message and
            // running-tool anchors, so no trailing block is detached into the edge slot (FIX 1).
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                active: false,
                thinking: true,
            };
            const screen = await renderInvertedChatList();

            // No anchor → no carve → every row stays in the recycler.
            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);

            await act(async () => { screen.tree.unmount(); });
        });

        it('does NOT carve while idle with the flag on even when session.thinking is false (no orphan)', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            // No streaming row, no thinking pulse, session.thinking false → no anchor → no carve.
            const screen = await renderInvertedChatList();

            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);

            await act(async () => { screen.tree.unmount(); });
        });

        it('engages the native carve for flash_v2 because native FlashList is canonically inverted', async () => {
            configureHarness({
                implementation: 'flash_v2',
                syncTuningState: { transcriptNativeHotTailItemCount: 1 },
            });
            markNewestAgentMessageStreaming('m4');
            const screen = await renderInvertedChatList();

            expect(listDataIds(screen)).toEqual(['m3', 'm2', 'm1']);
            expect(screen.findByTestId('transcript-native-hot-tail')).not.toBeNull();
            expect(screen.findByTestId('transcript-native-hot-tail-item-m4')).not.toBeNull();

            await act(async () => { screen.tree.unmount(); });
        });

        it('withholds the MVCP bottom autoscroll threshold while the carve owns the bottom (single pin owner #3)', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            markNewestAgentMessageStreaming('m4');
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });

            // Carve active + following → startRenderingFromBottom ONLY (no threshold). MVCP keeps only
            // prepend/top offset correction, so it cannot fight the JS force-pin at the live tail.
            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({
                startRenderingFromBottom: true,
            });

            await act(async () => { screen.tree.unmount(); });
        });

        it('pins deterministically to the freshly-measured hot-tail height in one event (#2) and records the proof telemetry (#4)', async () => {
            const telemetrySink = configureTelemetrySink();
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            markNewestAgentMessageStreaming('m4');
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });
            fileFlashListRefHandle.scrollToIndex.mockClear();
            telemetrySink.mockClear();

            // The live row grew → the edge slot reports its new rendered height. The pin issued from
            // THIS same event reads exactly that height for the inverted bottom inset (composerInset is
            // 0 in the harness), so the newest row lands above the composer with no overlap.
            await measureNativeHotTailRows(screen, 220);

            expect(fileFlashListRefHandle.scrollToIndex).toHaveBeenCalledWith(
                expect.objectContaining({ index: 0, viewOffset: -220 }),
            );

            // #4 proof surface: the carve pin stamps the deterministic height + anchor + single-owner
            // MVCP policy so device QA can prove FlashList MVCP is not fighting the JS pin.
            const pins = carvePinWrites(telemetrySink);
            expect(pins.length).toBeGreaterThan(0);
            expect(pins[pins.length - 1]).toMatchObject({
                liveRegionActive: true,
                nativeHotTailHeightPx: 220,
                nativeCarvePinIssued: true,
                liveTailAnchorId: 'm4',
                liveTailAnchorKind: 'streaming-message',
                mvcpPolicy: 'start-rendering-from-bottom',
            });

            await act(async () => { screen.tree.unmount(); });
        });

        it('does not yank a scrolled-up reader when the live row grows (records the skip for QA)', async () => {
            const telemetrySink = configureTelemetrySink();
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            markNewestAgentMessageStreaming('m4');
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });
            await releaseFollowByDrag(screen, 1200, { layoutHeight: 500, contentHeight: 2000 });
            // NQA-F4: carve-active release must keep native MVCP stable; only FlashList's JS
            // applyOffsetCorrection is paused so the ScrollAnchor/native prop never unmounts.
            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({
                startRenderingFromBottom: true,
            });
            expect(screen.requireCapturedFlashListProps().happierPauseOffsetCorrection).toBe(true);
            fileFlashListRefHandle.scrollToIndex.mockClear();
            telemetrySink.mockClear();

            await measureNativeHotTailRows(screen, 260);

            // Released reader: the carve issues NO bottom pin (no yank) and records the skip.
            expect(fileFlashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
            const skips = sinkEvents(telemetrySink).filter(
                (event: any) => event?.type === 'scroll-observed' && event.nativeCarvePinIssued === false,
            );
            expect(skips.length).toBeGreaterThan(0);
            expect(skips[skips.length - 1]).toMatchObject({
                liveRegionActive: true,
                nativeHotTailHeightPx: 260,
                nativeCarvePinIssued: false,
            });

            await act(async () => { screen.tree.unmount(); });
        });

        it('keeps MVCP offset-correction ARMED for a released reader during an active turn when the carve is not growing (§3a prepend-preservation)', async () => {
            // §3a regression: an active turn ALONE (sessionState.active, carve not growing) must NOT
            // disable MVCP. The prior {disabled:true} superset fired for the whole active turn and
            // killed applyOffsetCorrection, so an older-page prepend lost reading position (Invariant
            // C; inverted older-load has no fallback writer). Only the carve actively growing
            // (liveRegionActive, covered above) withholds correction.
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 1 } });
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                active: true,
            };
            const screen = await renderInvertedChatList();
            await coldOpenAtBottom(screen, { layoutHeight: 500, contentHeight: 2000 });
            await releaseFollowByDrag(screen, 1200, { layoutHeight: 500, contentHeight: 2000 });

            expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({
                startRenderingFromBottom: true,
            });

            await act(async () => { screen.tree.unmount(); });
        });

        // §12 issue (A): multi-row hot-tail BOTTOM ORDERING. A complex turn carves >1 row into the
        // inverted edge slot. Before the fix the host fed the ORIENTED (newest-first) hot slice with
        // startIndex 0; the edge slot's nested scaleY(-1) transforms compose to an order-preserving
        // translation, so newest-on-top in DOM rendered the rows REVERSED at the visual bottom.
        describe('multi-row hot-tail ordering (§12 issue A)', () => {
            it('carves a multi-row live region and renders it CANONICAL oldest->newest in DOM (newest at the visual bottom, not reversed)', async () => {
                configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 4 } });
                // Stream from an EARLIER row (m2) so the live region is [m2, m3, m4] = 3 hot rows.
                // (markNewestAgentMessageStreaming marks any id + sets the session active.)
                markNewestAgentMessageStreaming('m2');
                const screen = await renderInvertedChatList();

                // The cold recycler holds only the older rows (newest-first); the live region is carved.
                expect(listDataIds(screen)).toEqual(['m1']);
                expect(screen.findByTestId('transcript-native-hot-tail')).not.toBeNull();

                // DOM order of the carved rows is CANONICAL oldest->newest (m2, m3, m4). Under the edge
                // slot's order-preserving scaleY(-1) translation this places m4 (newest) at the visual
                // bottom, just above the composer — the multi-row reversal fix. A reversed (pre-fix)
                // render would read ['m4', 'm3', 'm2'] here.
                const rows = screen.findByTestId('transcript-native-hot-tail-rows');
                expect(rows).not.toBeNull();
                expect(hotTailRowDomOrder(rows!)).toEqual(['m2', 'm3', 'm4']);

                await act(async () => { screen.tree.unmount(); });
            });

            it('hands the multi-row hot tail the per-row DISPLAY index it has in displayItems, so the older-neighbor lookup resolves the chronologically-previous row', async () => {
                configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 4 } });
                markNewestAgentMessageStreaming('m2');
                renderedMessageViewProps.length = 0;
                const screen = await renderInvertedChatList();

                // displayItems is newest-first: [m4(0), m3(1), m2(2), m1(3)]. The host resolves a row's
                // older neighbor as displayItems[displayIndex + 1] under inversion. For the lookup to be
                // correct, each carved row must render at its displayItems index — m2->2, m3->1, m4->0.
                // We prove the pairing held by asserting every carved message row rendered (the host
                // would otherwise throw / mis-resolve), the live region membership is exact, and the
                // newest row is the visual-bottom DOM row (display index 0). The display-index formula
                // itself is unit-pinned in TranscriptHotTail.test.tsx; here we pin the host wiring.
                const carvedIds = new Set(
                    renderedMessageViewProps.map((props: any) => props?.message?.id).filter(Boolean),
                );
                expect(carvedIds.has('m2')).toBe(true);
                expect(carvedIds.has('m3')).toBe(true);
                expect(carvedIds.has('m4')).toBe(true);
                const rows = screen.findByTestId('transcript-native-hot-tail-rows');
                expect(hotTailRowDomOrder(rows!)).toEqual(['m2', 'm3', 'm4']);

                await act(async () => { screen.tree.unmount(); });
            });
        });

        // §12 issue (C): a STALE `segmentState:'streaming'` left on a far-back row by an interrupted
        // turn must NOT engage the carve on an IDLE session. The streaming-MESSAGE anchor is gated on
        // session.active (defense-in-depth, mirroring the running-tool R2 gate), so an idle session
        // fails closed regardless of the stale marker.
        it('does NOT carve an idle session that still carries a stale streaming segment flag (issue C)', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 4 } });
            // Stale streaming flag on m2 (interrupted turn) but the session is idle (active:false).
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: flashListChatListHarnessState.sessionMessagesState.messages.map((message: any) =>
                    message.id === 'm2' ? { ...message, kind: 'agent-text', meta: streamingAssistantMeta() } : message),
            };
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                active: false,
                thinking: false,
            };
            const screen = await renderInvertedChatList();

            // Fail closed: every row stays in the recycler, no detached edge-slot block at the bottom.
            expect(listDataIds(screen)).toEqual(['m4', 'm3', 'm2', 'm1']);
            expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);

            await act(async () => { screen.tree.unmount(); });
        });

        it('still carves the SAME stale streaming row once the session is active again (issue C positive control)', async () => {
            configureHarness({ syncTuningState: { transcriptNativeHotTailItemCount: 4 } });
            flashListChatListHarnessState.sessionMessagesState = {
                isLoaded: true,
                messages: flashListChatListHarnessState.sessionMessagesState.messages.map((message: any) =>
                    message.id === 'm2' ? { ...message, kind: 'agent-text', meta: streamingAssistantMeta() } : message),
            };
            flashListChatListHarnessState.sessionState = {
                ...flashListChatListHarnessState.sessionState,
                active: true,
            };
            const screen = await renderInvertedChatList();

            // Active + streaming m2 → carve engages on the live region [m2, m3, m4].
            expect(listDataIds(screen)).toEqual(['m1']);
            expect(screen.findByTestId('transcript-native-hot-tail')).not.toBeNull();

            await act(async () => { screen.tree.unmount(); });
        });
    });
});
