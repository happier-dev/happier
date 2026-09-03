import {
    flashListChatListHarnessState,
    createFlashListChatListWebElement,
    createFlashListChatListWebScroller,
    FlashListChatListWebElement,
    renderFlashListChatList,
    triggerFlashListChatListContentSizeChange as triggerFlashListChatListContentSizeChangeRaw,
    triggerFlashListChatListEndReached,
    triggerFlashListChatListInitialFill as triggerFlashListChatListInitialFillRaw,
    triggerFlashListChatListLoad,
    triggerFlashListChatListScroll as triggerFlashListChatListScrollRaw,
    triggerFlashListChatListStartReached,
    withRenderedFlashListChatListWebScroller,
    withFlashListChatListWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import { assertWebWregDiagnostics } from '@/dev/testkit/transcript/viewportTelemetryAssertions';
import * as React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';

import { buildChatListNativeId } from './chatListNativeId';
import type { ChatListProps } from './chatListTypes';
import { __resetDefaultTranscriptItemHeightCacheForTests } from './measurement/transcriptItemHeightCache';
import type { TranscriptNavigationEntry } from './navigation/transcriptNavigationTypes';
import { __resetTranscriptWarmPaintCacheForTests } from './paint/transcriptWarmPaintCache';
import { fromNativeInvertedCanonicalOffset } from './viewport/driver/nativeInvertedRawScroll';
import { useTranscriptSelectionRow } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
let renderedFlatListCount = 0;
let renderedFlashListCount = 0;
let flashListRefHandle: any = null;
let renderedMessageViewProps: any[] = [];
let renderedToolCallsGroupRowProps: any[] = [];
let renderedToolGroupUnitHeaderProps: any[] = [];
let renderedToolGroupUnitToolProps: any[] = [];
let linearItemsCacheBuildCalls: Array<{ cacheHit: boolean; cacheProvided: boolean; signature: string }> = [];
let turnsCacheBuildCalls: Array<{ cacheHit: boolean; cacheProvided: boolean; signature: string }> = [];
let requireSelectionProviderForRenderedMessages = false;
let flashListTestLayoutHeight = 0;
let flashListTestContentHeight = 0;
const mountedTrees: ReactTestRenderer[] = [];

function getCapturedFlashListProps(): any {
    const props = flashListChatListHarnessState.flashListProps ?? capturedFlashListProps;
    expect(props).toBeTruthy();
    return props;
}

async function renderTrackedFlashListChatList(element: React.ReactElement) {
    const screen = await renderFlashListChatList(element, {
        flushOptions: { cycles: 0 },
    });
    mountedTrees.push(screen.tree);
    return screen;
}

async function resetTranscriptSingletonStateForTests(): Promise<void> {
    const { clearTargetWindowRequestEpochs } = await import('@/sync/engine/sessions/fetchAndApplyTargetWindowMessages');
    clearTargetWindowRequestEpochs();

    const {
        clearTranscriptNavigationVisibilityStore,
        transcriptNavigationVisibilityStore,
    } = await import('./viewport/visibility/transcriptNavigationVisibilityStore');
    transcriptNavigationVisibilityStore.set(null);
    clearTranscriptNavigationVisibilityStore('session-1');
    clearTranscriptNavigationVisibilityStore('session-2');

    const { transcriptNavigationPaneStore } = await import('./navigation/transcriptNavigationPaneStore');
    transcriptNavigationPaneStore.set('session-1', null);
    transcriptNavigationPaneStore.set('session-2', null);
}

function unmountTrackedFlashListChatList(screen: { tree: ReactTestRenderer }): void {
    act(() => {
        screen.tree.unmount();
    });
    const index = mountedTrees.indexOf(screen.tree);
    if (index >= 0) {
        mountedTrees.splice(index, 1);
    }
}

function expectScreenHasTestId(screen: { findByTestId: (testID: string) => unknown }, testID: string): void {
    expect(screen.findByTestId(testID)).toBeTruthy();
}

function countExactTestId(screen: { findAll: (predicate: (node: any) => boolean) => unknown[] }, testID: string): number {
    return screen.findAll((node) => typeof node.type === 'string' && node.props?.testID === testID).length;
}

function countAnyTestId(screen: { findAll: (predicate: (node: any) => boolean) => unknown[] }, testID: string): number {
    return screen.findAll((node) => node.props?.testID === testID).length;
}

function countVisibleOlderLoadSpinners(screen: { findAll: (predicate: (node: any) => boolean) => unknown[] }): number {
    return screen.findAll((node) => node.props?.accessibilityRole === 'progressbar').length;
}

function createNavigationEntry(
    overrides: Partial<TranscriptNavigationEntry> & Pick<TranscriptNavigationEntry, 'id' | 'seq'>,
): TranscriptNavigationEntry {
    return {
        sessionId: 'session-1',
        routeMessageId: null,
        transcriptBlockIndex: null,
        kind: 'pinned-assistant',
        role: 'assistant',
        label: overrides.id,
        promptPreview: null,
        responsePreview: null,
        createdAtMs: null,
        pinned: true,
        pinnedAtMs: 1,
        loaded: true,
        ...overrides,
    };
}

type FlashListFlushOptions = {
    turns?: number;
    frames?: number;
    advanceTimersMs?: number;
};

type LoadedOlderResult = { loaded: number; hasMore: boolean; status: 'loaded' };

function createMissingLoadOlderResolver(): (value: LoadedOlderResult) => void {
    return () => {
        throw new Error('loadOlder promise resolver was not captured');
    };
}

async function primeFlashListMetrics(
    layoutHeight: number,
    contentHeight: number,
    options: FlashListFlushOptions = {},
): Promise<void> {
    await triggerFlashListChatListInitialFill({
        layoutHeight,
        contentHeight,
        flushOptions: {
            turns: options.turns ?? 1,
            frames: options.frames,
            advanceTimersMs: options.advanceTimersMs,
        },
    });
}

async function scrollFlashListTo(contentOffsetY: number, options: FlashListFlushOptions & { trusted?: boolean } = {}): Promise<void> {
    await triggerFlashListChatListScroll(
        contentOffsetY,
        options.trusted === false ? {} : { isTrusted: true },
        {
            turns: options.turns ?? 1,
            frames: options.frames,
            advanceTimersMs: options.advanceTimersMs,
        },
    );
}

function readEventDimension(extras: Record<string, unknown>, key: 'contentSize' | 'layoutMeasurement'): number | null {
    const value = extras[key];
    if (!value || typeof value !== 'object' || !('height' in value)) return null;
    const height = (value as { height?: unknown }).height;
    return typeof height === 'number' && Number.isFinite(height) ? height : null;
}

function shouldMapCanonicalNativeFlashListOffsets(): boolean {
    return runtimeMockState.platformOs !== 'web' && settingValues.transcriptListImplementation !== 'flatlist_legacy';
}

function toNativeFlashListRawScrollOffset(canonicalOffsetY: number, extras: Record<string, unknown>): number {
    if (!shouldMapCanonicalNativeFlashListOffsets()) return canonicalOffsetY;
    if (canonicalOffsetY < 0) return canonicalOffsetY;
    const contentHeight = readEventDimension(extras, 'contentSize') ?? flashListTestContentHeight;
    const layoutHeight = readEventDimension(extras, 'layoutMeasurement') ?? flashListTestLayoutHeight;
    const maxOffset = Math.max(0, contentHeight - layoutHeight);
    if (layoutHeight <= 0 || contentHeight <= 0 || canonicalOffsetY > maxOffset) return canonicalOffsetY;
    return fromNativeInvertedCanonicalOffset({
        canonicalOffsetY,
        contentHeight,
        layoutHeight,
    });
}

function nativeRawOffsetForCanonicalOffset(canonicalOffsetY: number): number {
    return toNativeFlashListRawScrollOffset(canonicalOffsetY, {
        contentSize: { height: flashListTestContentHeight },
        layoutMeasurement: { height: flashListTestLayoutHeight },
    });
}

function expectNoNonBottomScrollToIndexWrites(scrollToIndex: ReturnType<typeof vi.fn>): void {
    expect(scrollToIndex.mock.calls.filter(([command]) => command?.index !== 0)).toEqual([]);
}

async function triggerFlashListChatListInitialFill(
    options: Parameters<typeof triggerFlashListChatListInitialFillRaw>[0] = {},
): Promise<void> {
    flashListTestLayoutHeight = options.layoutHeight ?? 800;
    flashListTestContentHeight = options.contentHeight ?? 200;
    await triggerFlashListChatListInitialFillRaw(options);
}

async function triggerFlashListChatListContentSizeChange(
    contentWidth: number,
    contentHeight: number,
    flushOptions: Parameters<typeof triggerFlashListChatListContentSizeChangeRaw>[2] = {},
): Promise<void> {
    flashListTestContentHeight = contentHeight;
    await triggerFlashListChatListContentSizeChangeRaw(contentWidth, contentHeight, flushOptions);
}

async function triggerFlashListChatListScroll(
    offsetY: number,
    nativeEventExtras: Record<string, unknown> = {},
    flushOptions: FlashListFlushOptions = {},
): Promise<void> {
    const layoutHeight = readEventDimension(nativeEventExtras, 'layoutMeasurement');
    const contentHeight = readEventDimension(nativeEventExtras, 'contentSize');
    if (layoutHeight !== null) flashListTestLayoutHeight = layoutHeight;
    if (contentHeight !== null) flashListTestContentHeight = contentHeight;
    await triggerFlashListChatListScrollRaw(
        toNativeFlashListRawScrollOffset(offsetY, nativeEventExtras),
        nativeEventExtras,
        flushOptions,
    );
}

async function withWebFlashListFakeTimers<T>(now: number, run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ now: new Date(now) });
    try {
        return await run();
    } finally {
        vi.useRealTimers();
    }
}

async function settleNativeFlashListMount(screen: { settle: (options?: FlashListFlushOptions & { cycles?: number }) => Promise<void> }): Promise<void> {
    await triggerFlashListChatListLoad(12, { turns: 1 });
    await screen.settle({
        advanceTimersMs: syncTuningState.transcriptMountSettleQuiescentWindowMs + 1,
        cycles: 1,
        turns: 2,
    });
}

function findTranscriptItemShell(screen: { findByTestId: (testID: string) => any }, itemId: string) {
    return screen.findByTestId(`transcript-item-${itemId}`);
}

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

function readStyleProp(style: unknown, prop: string): unknown {
    if (Array.isArray(style)) {
        for (let index = style.length - 1; index >= 0; index -= 1) {
            const value = readStyleProp(style[index], prop);
            if (value !== undefined) return value;
        }
        return undefined;
    }
    if (style && typeof style === 'object' && prop in style) {
        return (style as Record<string, unknown>)[prop];
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

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionTranscriptIdsState: string[] | null = null;
let sessionMessagesByIdSnapshot: { messages: any[]; byId: Record<string, any> } = { messages: [], byId: {} };
let sessionMessagesStoreRevisionState = 0;
let sessionMessagesStoreListenersState = new Set<() => void>();

function subscribeSessionMessagesStoreForTest(listener: () => void): () => void {
    sessionMessagesStoreListenersState.add(listener);
    return () => {
        sessionMessagesStoreListenersState.delete(listener);
    };
}

function publishSessionMessagesStateForTest(
    state: { messages: any[]; isLoaded: boolean },
): void {
    sessionMessagesState = state;
    sessionMessagesStoreRevisionState += 1;
    for (const listener of sessionMessagesStoreListenersState) {
        listener();
    }
}

function useSessionMessagesStoreRevisionForTest(): void {
    React.useSyncExternalStore(
        subscribeSessionMessagesStoreForTest,
        () => sessionMessagesStoreRevisionState,
        () => sessionMessagesStoreRevisionState,
    );
}

function getSessionMessagesByIdSnapshot(): Record<string, any> {
    if (sessionMessagesByIdSnapshot.messages === sessionMessagesState.messages) {
        return sessionMessagesByIdSnapshot.byId;
    }
    sessionMessagesByIdSnapshot = {
        messages: sessionMessagesState.messages,
        byId: Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
    };
    return sessionMessagesByIdSnapshot.byId;
}
let sessionPendingState: { messages: any[] } = { messages: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;
let transcriptTurnsState: any[] = [];
type SessionViewportTestSnapshot = {
    isPinned: boolean;
    offsetY: number;
    anchor?: {
        kind: 'message' | 'toolGroup' | 'item';
        messageId?: string | null;
        seq?: number | null;
        itemId: string;
        itemOffsetPx: number;
        capturedAtMs: number;
    } | null;
    lastUpdatedAt: number;
    source: 'default' | 'observed';
};
type CanonicalSessionViewportSync = Readonly<{
    getSessionViewport: (sessionId: string) => SessionViewportTestSnapshot | null;
    markSessionLiveTailIntent: (sessionId: string) => void;
    onSessionViewportChange: (
        sessionId: string,
        state: Readonly<{
            isPinned: boolean;
            offsetY?: number;
            shouldPersistViewport?: boolean;
            shouldRestoreViewport?: boolean;
            anchor?: SessionViewportTestSnapshot['anchor'];
        }>,
    ) => void;
}>;
let canonicalSessionViewportSync: CanonicalSessionViewportSync | null = null;
let sessionViewportTestNamespace = 0;
const pendingSessionViewportSeeds = new Map<string, SessionViewportTestSnapshot>();

function qualifySessionViewportTestId(sessionId: string): string {
    return `chat-list-host-${sessionViewportTestNamespace}:${sessionId}`;
}

function requireCanonicalSessionViewportSync(): CanonicalSessionViewportSync {
    if (!canonicalSessionViewportSync) {
        throw new Error('Canonical sync viewport owner was not initialized');
    }
    return canonicalSessionViewportSync;
}

function seedCanonicalSessionViewport(sessionId: string, snapshot: SessionViewportTestSnapshot): void {
    const qualifiedSessionId = qualifySessionViewportTestId(sessionId);
    if (!canonicalSessionViewportSync) {
        pendingSessionViewportSeeds.set(qualifiedSessionId, snapshot);
        return;
    }
    if (snapshot.source === 'default' || snapshot.isPinned) {
        canonicalSessionViewportSync.markSessionLiveTailIntent(qualifiedSessionId);
        return;
    }
    canonicalSessionViewportSync.onSessionViewportChange(qualifiedSessionId, {
        isPinned: false,
        offsetY: snapshot.offsetY,
        shouldRestoreViewport: true,
        anchor: snapshot.anchor,
    });
}

const sessionViewportByIdState = {
    get(sessionId: string): SessionViewportTestSnapshot | null {
        const qualifiedSessionId = qualifySessionViewportTestId(sessionId);
        return canonicalSessionViewportSync?.getSessionViewport(qualifiedSessionId)
            ?? pendingSessionViewportSeeds.get(qualifiedSessionId)
            ?? null;
    },
    set(sessionId: string, snapshot: SessionViewportTestSnapshot): void {
        seedCanonicalSessionViewport(sessionId, snapshot);
    },
};

function resetCanonicalSessionViewportTestState(): void {
    sessionViewportTestNamespace += 1;
    pendingSessionViewportSeeds.clear();
}
type SessionTargetWindowTestState = Readonly<{
    isWindowMode: boolean;
    windowId: string | null;
    targetSeq: number | null;
    windowMinSeq: number | null;
    windowMaxSeq: number | null;
    olderCursor: number | null;
    newerCursor: number | null;
    hasMoreOlder: boolean | null;
    hasMoreNewer: boolean | null;
    activatedAtMs: number | null;
}>;
const inactiveSessionTargetWindowState: SessionTargetWindowTestState = {
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
};
let sessionTargetWindowStateByIdState = new Map<string, SessionTargetWindowTestState>();
let sessionTargetWindowStateListenersByIdState = new Map<string, Set<() => void>>();

function setSessionTargetWindowStateForTest(
    sessionId: string,
    state: SessionTargetWindowTestState,
): void {
    sessionTargetWindowStateByIdState.set(sessionId, state);
    for (const listener of sessionTargetWindowStateListenersByIdState.get(sessionId) ?? []) {
        listener();
    }
}

function subscribeSessionTargetWindowStateForTest(
    sessionId: string,
    listener: () => void,
): () => void {
    let listeners = sessionTargetWindowStateListenersByIdState.get(sessionId);
    if (!listeners) {
        listeners = new Set();
        sessionTargetWindowStateListenersByIdState.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) {
            sessionTargetWindowStateListenersByIdState.delete(sessionId);
        }
    };
}

function createScrollRelativeTranscriptItemElement(
    scroller: ReturnType<typeof createFlashListChatListWebScroller>,
    itemId: string,
    contentTop: number,
    height: number,
): FlashListChatListWebElement {
    const element = createFlashListChatListWebElement(`transcript-item-${itemId}`, {
        top: contentTop - scroller.scrollTop,
        bottom: contentTop + height - scroller.scrollTop,
    });
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            top: contentTop - scroller.scrollTop,
            bottom: contentTop + height - scroller.scrollTop,
            left: 0,
            right: 320,
            width: 320,
            height,
            x: 0,
            y: contentTop - scroller.scrollTop,
            toJSON: () => ({}),
        }),
    });
    return element;
}

let deferredNewerSessionIdsState = new Set<string>();
let catchingUpNewerState = false;
const maybeDrainDeferredNewerMessagesMock = vi.hoisted(() => vi.fn());

const settingValues: Record<string, any> = {};
const runtimeMockState = vi.hoisted(() => ({
    headerHeight: 0,
    platformOs: 'web' as 'web' | 'ios' | 'android',
    safeAreaTop: 0,
}));
const reducedMotionMockState = vi.hoisted(() => ({
    preferred: false,
}));
const markdownRuntimeMockState = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
    preload: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    ready: true,
}));
function setMarkdownRuntimeReady(ready: boolean): void {
    markdownRuntimeMockState.ready = ready;
    for (const listener of markdownRuntimeMockState.listeners) {
        listener();
    }
}
type JumpToTranscriptSeqMockParams = Readonly<{
    getIndex: () => number | null;
    scrollToIndex: (index: number) => void;
}>;
const jumpToTranscriptSeqMockState = vi.hoisted(() => ({
    implementation: null as null | ((params: JumpToTranscriptSeqMockParams) => Promise<void> | void),
}));
const viewportControllerMockState = vi.hoisted(() => ({
    resolveInputs: [] as Array<Record<string, unknown>>,
}));

type SyncTuningMock = {
    transcriptForwardPrefetchThresholdPx: number;
    transcriptBackwardPrefetchThresholdPx: number;
    transcriptFlashListEstimatedItemSize: number;
    transcriptWebHotTailItemCount: number;
    transcriptWebInitialPinStabilizeMs: number;
    transcriptWebInitialPinRetryIntervalMs: number;
    transcriptWebInitialPinRetryMilestonesMs: readonly number[];
    transcriptOlderLoadCooldownMs: number;
    transcriptOlderLoadSpinnerDelayMs: number;
    transcriptViewportAnchorCaptureDebounceMs: number;
    transcriptViewportAnchorOlderLookupMaxLoads: number;
    transcriptDerivedItemsCacheMaxSessions: number;
    transcriptMaxTurnEntriesPerListItem: number;
    transcriptItemHeightCacheMaxEntries: number;
    transcriptFlashListDrawDistance: number;
    transcriptMountSettleQuiescentWindowMs: number;
    transcriptMountSettleDimensionNoiseFloorPx: number;
    transcriptMountSettleBottomDistanceNoiseFloorPx: number;
    transcriptInitialFillBudgetMs: number;
    transcriptNativeHotTailItemCount?: number;
    transcriptViewportTelemetryEnabled?: boolean;
    transcriptViewportTelemetryMaxEvents?: number;
    transcriptNativeOlderMessagesPageSize?: number;
    transcriptLegendListSpikeSurface?: 'off' | 'flashList';
};

let syncTuningState: SyncTuningMock = {
    transcriptForwardPrefetchThresholdPx: 0,
    transcriptBackwardPrefetchThresholdPx: 0,
    transcriptFlashListEstimatedItemSize: 120,
    transcriptWebHotTailItemCount: 2,
    transcriptWebInitialPinStabilizeMs: 3000,
    transcriptWebInitialPinRetryIntervalMs: 250,
    transcriptWebInitialPinRetryMilestonesMs: [16, 50, 100, 200, 400, 800],
    transcriptOlderLoadCooldownMs: 250,
    transcriptOlderLoadSpinnerDelayMs: 300,
    transcriptViewportAnchorCaptureDebounceMs: 200,
    transcriptViewportAnchorOlderLookupMaxLoads: 6,
    transcriptDerivedItemsCacheMaxSessions: 8,
    transcriptMaxTurnEntriesPerListItem: 8,
    transcriptItemHeightCacheMaxEntries: 1024,
    transcriptFlashListDrawDistance: 0,
    transcriptMountSettleQuiescentWindowMs: 120,
    transcriptMountSettleDimensionNoiseFloorPx: 1,
    transcriptMountSettleBottomDistanceNoiseFloorPx: 2,
    transcriptInitialFillBudgetMs: 2000,
    transcriptNativeHotTailItemCount: 0,
    // This suite is the FlashList regression lane; pin the escape hatch now that the
    // production web-main default is the Legend renderer.
    transcriptLegendListSpikeSurface: 'flashList',
};

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

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        renderedFlashListCount++;
        capturedFlashListProps = props;
        flashListChatListHarnessState.flashListProps = props;
        if (typeof ref === 'function') {
            ref(flashListRefHandle);
        } else if (ref && typeof ref === 'object') {
            ref.current = flashListRefHandle;
        }
        const data = Array.isArray(props.data) ? props.data : [];
        const header =
            props.ListHeaderComponent
                ? (typeof props.ListHeaderComponent === 'function'
                    ? props.ListHeaderComponent()
                    : props.ListHeaderComponent)
                : null;
        const footer =
            props.ListFooterComponent
                ? (typeof props.ListFooterComponent === 'function'
                    ? props.ListFooterComponent()
                    : props.ListFooterComponent)
                : null;

        return React.createElement(
            'FlashList',
            { ...props, testID: 'flash-list' },
            header,
            data.map((item: any, index: number) => {
                const key =
                    typeof props.keyExtractor === 'function'
                        ? props.keyExtractor(item, index)
                        : (item?.id ?? String(index));
                const child = typeof props.renderItem === 'function' ? props.renderItem({ item, index }) : null;
                return React.createElement('FlashListItem', { key }, child);
            }),
            footer,
        );
    }),
    LayoutCommitObserver: ({ children, onCommitLayoutEffect }: any) => {
        React.useLayoutEffect(() => {
            onCommitLayoutEffect?.();
        });
        return React.createElement(React.Fragment, null, children);
    },
    useLayoutState: (initialState: any) => {
        const [state, setState] = React.useState(() => (
            typeof initialState === 'function' ? initialState() : initialState
        ));
        return [state, setState];
    },
    useRecyclingState: (initialState: any, deps: React.DependencyList, onReset?: () => void) => {
        const [state, setState] = React.useState(() => (
            typeof initialState === 'function' ? initialState() : initialState
        ));
        React.useLayoutEffect(() => {
            setState(typeof initialState === 'function' ? initialState() : initialState);
            onReset?.();
        }, deps);
        return [state, setState];
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Dimensions: {
                                        get: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
                                    },
                                    Platform: {
                                        get OS() {
                                                        return runtimeMockState.platformOs;
                                                    },
                                        select: (values: any) => values?.[runtimeMockState.platformOs] ?? values?.default,
                                    },
                                    Easing: {
                                        bezier: () => (t: number) => t,
                                        linear: (t: number) => t,
                                    },
                                    View: (props: any) => React.createElement('View', props, props.children),
                                    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                                    ActivityIndicator: () => React.createElement('ActivityIndicator'),
                                    FlatList: (_props: any) => {
                                            renderedFlatListCount++;
                                            return React.createElement('FlatList');
                                        },
                                }
    );
});

// ChatListInternal reads session-screen navigation focus for the S-E reveal
// revalidation; keep this host suite navigation-context-free.
vi.mock('@/components/sessions/shell/useSessionScreenIsFocused', () => ({
    useSessionScreenIsFocused: () => true,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => runtimeMockState.headerHeight,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: runtimeMockState.safeAreaTop, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
    useSession: () => sessionState,
    useSessionChatFooterState: () => sessionState
        ? {
            controlledByUser: sessionState.agentState?.controlledByUser === true,
            localControl: null,
            permissionsInUiWhileLocal: false,
        }
        : null,
    useSessionTranscriptIds: () => {
        useSessionMessagesStoreRevisionForTest();
        return {
            ids: sessionTranscriptIdsState ?? (sessionMessagesState.messages ?? []).map((m: any) => m.id),
            isLoaded: sessionMessagesState.isLoaded,
        };
    },
    useSessionMessagesById: () => getSessionMessagesByIdSnapshot(),
    useSessionMessagesReducerState: () => null,
    useSessionForkSupportSource: () => null,
    useSessionWorkspacePath: () => null,
    useForkedTranscriptSnapshot: () => null,
    useSessionPendingMessages: () => sessionPendingState,
    useSessionActionDrafts: () => sessionActionDraftsState,
    useSessionLatestThinkingMessageId: () => null,
    useSessionLatestThinkingMessageActivityAtMs: () => null,
    useMessage: (_sessionId: string, messageId: string) =>
        (sessionMessagesState.messages ?? []).find((message: any) => message.id === messageId) ?? null,
    useSetting: (key: string) => settingValues[key],
    getStorage: () => ({
        getState: () => ({
            sessionMessages: {
                [sessionState?.id ?? 'session-1']: {
                    messagesById: getSessionMessagesByIdSnapshot(),
                    messagesMap: getSessionMessagesByIdSnapshot(),
                },
            },
        }),
    }),
});
});

function buildMockChatListItems(opts: any): any[] {
    const items =
        opts?.includeCommittedMessages === false
            ? []
            : (opts?.messageIdsOldestFirst ?? []).map((id: string) => {
                const m = opts?.messagesById?.[id];
                if (opts?.groupConsecutiveToolCalls === true && m?.kind === 'tool-call') {
                    return {
                        kind: 'tool-calls-group',
                        id: `toolCalls:linear:${id}`,
                        toolMessageIds: [id],
                        createdAt: m?.createdAt ?? 0,
                    };
                }
                return {
                    kind: 'message',
                    id,
                    messageId: id,
                    createdAt: m?.createdAt ?? 0,
                    seq: typeof m?.seq === 'number' && Number.isFinite(m.seq) ? Math.trunc(m.seq) : null,
                };
            });

    if ((opts?.pendingMessages ?? []).length > 0 || (opts?.discardedMessages ?? []).length > 0) {
        items.push({
            kind: 'pending-queue',
            id: 'pending-queue',
            pendingMessages: opts?.pendingMessages ?? [],
            discardedMessages: opts?.discardedMessages ?? [],
        });
    }

    for (const draft of opts?.actionDrafts ?? []) {
        items.push({
            kind: 'action-draft',
            id: `draft:${draft.id}`,
            draft,
        });
    }

    return items;
}

function buildMockLinearItemsSignature(opts: any): string {
    return JSON.stringify({
        actionDraftIds: (opts?.actionDrafts ?? []).map((draft: any) => draft.id),
        discardedCount: (opts?.discardedMessages ?? []).length,
        groupConsecutiveToolCalls: opts?.groupConsecutiveToolCalls === true,
        messageKeys: (opts?.messageIdsOldestFirst ?? []).map((id: string) => {
            const message = opts?.messagesById?.[id];
            return [
                id,
                message?.kind ?? 'missing',
                message?.seq ?? null,
                message?.createdAt ?? null,
                message?.text ?? null,
            ];
        }),
        pendingCount: (opts?.pendingMessages ?? []).length,
    });
}

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: buildMockChatListItems,
    buildChatListItemsCached: (opts: any) => {
        const signature = buildMockLinearItemsSignature(opts);
        const cacheProvided = opts?.cache != null;
        const cacheHit = opts?.cache?.signature === signature;
        linearItemsCacheBuildCalls.push({ cacheHit, cacheProvided, signature });
        if (cacheHit) {
            return {
                cache: opts.cache,
                items: opts.cache.items,
            };
        }

        const items = buildMockChatListItems(opts);
        return {
            cache: { signature, items },
            items,
        };
    },
}));

vi.mock('@/components/sessions/transcript/forkContext/ForkDividerRow', () => ({
    ForkDividerRow: () => React.createElement('ForkDividerRow'),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter', { testID: 'chat-footer' }),
}));

vi.mock('./MessageView', () => ({
    MessageView: (props: any) => {
        renderedMessageViewProps.push(props);
        if (requireSelectionProviderForRenderedMessages && typeof props.message?.id === 'string') {
            useTranscriptSelectionRow(props.message.id);
        }
        return React.createElement('MessageView', props);
    },
    MessageViewWithSessionCommon: (props: any) => {
        renderedMessageViewProps.push(props);
        if (requireSelectionProviderForRenderedMessages && typeof props.message?.id === 'string') {
            useTranscriptSelectionRow(props.message.id);
        }
        return React.createElement('MessageViewWithSessionCommon', props);
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
    TranscriptMotionProvider: ({ children }: any) => React.createElement('TranscriptMotionProvider', null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
    resolveTranscriptMotionConfig: () => ({}),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: ({ children }: any) => React.createElement('TranscriptEnterWrapper', null, children),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionMockState.preferred,
}));

vi.mock('@/components/markdown/enriched/preloadEnrichedMarkdownRuntime', () => ({
    isEnrichedMarkdownRuntimePreloaded: () => markdownRuntimeMockState.ready,
    preloadEnrichedMarkdownRuntime: markdownRuntimeMockState.preload,
    useEnrichedMarkdownRuntimeStatus: () => React.useSyncExternalStore(
        (listener) => {
            markdownRuntimeMockState.listeners.add(listener);
            return () => {
                markdownRuntimeMockState.listeners.delete(listener);
            };
        },
        () => markdownRuntimeMockState.ready ? 'ready' : 'pending',
        () => markdownRuntimeMockState.ready ? 'ready' : 'pending',
    ),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/utils/sessions/jumpToTranscriptSeq', () => ({
    jumpToTranscriptSeq: vi.fn(async (params: JumpToTranscriptSeqMockParams) => {
        if (jumpToTranscriptSeqMockState.implementation) {
            await jumpToTranscriptSeqMockState.implementation(params);
            return;
        }
        const index = params.getIndex();
        if (index != null) params.scrollToIndex(index);
    }),
}));

vi.mock('@/components/sessions/transcript/viewport/createTranscriptViewportController', async () => {
    const actual = await vi.importActual<typeof import('@/components/sessions/transcript/viewport/createTranscriptViewportController')>(
        '@/components/sessions/transcript/viewport/createTranscriptViewportController',
    );
    return {
        ...actual,
        createTranscriptViewportController: () => {
            const controller = actual.createTranscriptViewportController();
            return {
                getMode: controller.getMode,
                resolve: (input: Parameters<typeof controller.resolve>[0]) => {
                    viewportControllerMockState.resolveInputs.push(input as unknown as Record<string, unknown>);
                    return controller.resolve(input);
                },
            };
        },
    };
});

function buildMockTurnsSignature(opts: any): string {
    return JSON.stringify({
        groupToolCalls: opts?.groupToolCalls === true,
        ids: opts?.messageIdsOldestFirst ?? [],
        strategy: opts?.toolCallsGroupStrategy ?? null,
        turnIds: transcriptTurnsState.map((turn) => turn.id),
    });
}

vi.mock('@/components/sessions/transcript/turnGrouping/buildTranscriptTurns', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/transcript/turnGrouping/buildTranscriptTurns')>();
    return {
        isTranscriptTurnsBuildCacheComplete: actual.isTranscriptTurnsBuildCacheComplete,
        buildTranscriptTurnsCached: (opts: any) => {
            const signature = buildMockTurnsSignature(opts);
            const cacheProvided = opts?.cache != null;
            const cacheHit = opts?.cache?.signature === signature;
            turnsCacheBuildCalls.push({ cacheHit, cacheProvided, signature });
            if (cacheHit) return opts.cache;
            return {
                signature,
                turns: transcriptTurnsState,
            };
        },
    };
});

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: (props: any) => {
        renderedToolCallsGroupRowProps.push(props);
        return React.createElement('ToolCallsGroupRow', props);
    },
    ToolCallsGroupRowWithSessionCommon: (props: any) => {
        renderedToolCallsGroupRowProps.push(props);
        return React.createElement('ToolCallsGroupRowWithSessionCommon', props);
    },
}));

// N2c per-unit rows: tool groups render as header/expand/tool/footer unit rows.
vi.mock('@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitHeaderRow', () => ({
    ToolCallsGroupUnitHeaderRow: (props: any) => {
        renderedToolGroupUnitHeaderProps.push(props);
        return React.createElement('ToolCallsGroupUnitHeaderRow', props);
    },
    ToolCallsGroupUnitHeaderRowWithSessionCommon: (props: any) => {
        renderedToolGroupUnitHeaderProps.push(props);
        return React.createElement('ToolCallsGroupUnitHeaderRowWithSessionCommon', props);
    },
}));

vi.mock('@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitToolRow', () => ({
    ToolCallsGroupUnitToolRow: (props: any) => {
        renderedToolGroupUnitToolProps.push(props);
        return React.createElement('ToolCallsGroupUnitToolRow', props);
    },
    ToolCallsGroupUnitToolRowWithSessionCommon: (props: any) => {
        renderedToolGroupUnitToolProps.push(props);
        return React.createElement('ToolCallsGroupUnitToolRowWithSessionCommon', props);
    },
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
    JumpToBottomButton: (props: any) => React.createElement('JumpToBottomButton', props),
}));

vi.mock('@/components/sessions/transcript/scroll/transcriptBottomFollowMode', async () => await import('./scroll/transcriptBottomFollowMode'));

vi.mock('@/encryption/hex', () => ({
    decodeHex: () => new Uint8Array(),
    encodeHex: () => '',
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: any) => p,
}));

// Route host emissions through the real sync/persistence owner. Session ids are qualified per
// test so the canonical singleton remains isolated without copying its state machine here.
function routeSessionViewportChangeIntoTestStore(
    sessionId: string,
    state: Parameters<NonNullable<ChatListProps['onViewportChange']>>[0],
): void {
    requireCanonicalSessionViewportSync().onSessionViewportChange(
        qualifySessionViewportTestId(sessionId),
        state,
    );
}

vi.mock('@/sync/sync', async () => {
    const loadNewerMessages = vi.fn();
    return (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
        loadOlderMessages: vi.fn(),
        loadTargetWindowMessages: vi.fn(),
        loadNewerMessages,
        hasDeferredNewerMessages: (sessionId: string) => deferredNewerSessionIdsState.has(sessionId),
        getSyncTuning: () => syncTuningState,
        maybeDrainDeferredNewerMessages: maybeDrainDeferredNewerMessagesMock,
        getSessionViewport: (sessionId: string) => sessionViewportByIdState.get(sessionId) ?? null,
        getSessionTargetWindowState: (sessionId: string) =>
            sessionTargetWindowStateByIdState.get(sessionId) ?? inactiveSessionTargetWindowState,
        subscribeSessionTargetWindowState: subscribeSessionTargetWindowStateForTest,
        onSessionViewportChange: (sessionId: string, state: any) => routeSessionViewportChangeIntoTestStore(sessionId, state),
        markSessionLiveTailIntent: (sessionId: string) =>
            requireCanonicalSessionViewportSync().markSessionLiveTailIntent(qualifySessionViewportTestId(sessionId)),
    });
});

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useSessionCatchingUpNewer: () => catchingUpNewerState,
    };
});

vi.mock('@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId', async () => await import('./thinking/resolveActiveThinkingMessageId'));

vi.mock('@/sync/domains/settings/settings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/settings/settings')>();
    return {
        ...actual,
        settingsDefaults: {},
    };
});

vi.mock('./chatListNativeId', () => ({
    buildChatListNativeId: (sessionId: string, reactId: string) => `chat-list-${sessionId}-${reactId}`,
}));

vi.mock('@/components/sessions/transcript/segments/buildTranscriptHotColdSegments', async () => await import('./segments/buildTranscriptHotColdSegments'));

vi.mock('@/components/sessions/transcript/webTranscriptScrollMetrics', async () => await import('./webTranscriptScrollMetrics'));

vi.mock('@/components/sessions/transcript/web/WebTranscriptSplitFooter', async () => await import('./web/WebTranscriptSplitFooter'));

vi.mock('@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor', async () => await import('./viewport/prepend/webTranscriptPrependAnchor'));

vi.mock('@/components/sessions/keyboardAvoidance', () => ({
    ComposerKeyboardScrollInset: (props: { testID?: string; onHeightChange?: (height: number) => void }) =>
        React.createElement('ComposerKeyboardScrollInset', {
            testID: props.testID ?? 'transcript-composer-keyboard-inset',
            onHeightChange: props.onHeightChange,
        }),
    ComposerKeyboardFloatingInset: ({ children, testID }: { children: React.ReactNode; testID?: string }) =>
        React.createElement('ComposerKeyboardFloatingInset', {
            testID: testID ?? 'transcript-jump-to-bottom-keyboard-offset',
        }, children),
}));

describe('ChatList (FlashList v2)', () => {
    beforeAll(async () => {
        const actual = await vi.importActual<typeof import('@/sync/sync')>('@/sync/sync');
        canonicalSessionViewportSync = actual.sync;
        for (const [qualifiedSessionId, snapshot] of pendingSessionViewportSeeds) {
            if (snapshot.source === 'default' || snapshot.isPinned) {
                canonicalSessionViewportSync.markSessionLiveTailIntent(qualifiedSessionId);
            } else {
                canonicalSessionViewportSync.onSessionViewportChange(qualifiedSessionId, {
                    isPinned: false,
                    offsetY: snapshot.offsetY,
                    shouldRestoreViewport: true,
                    anchor: snapshot.anchor,
                });
            }
        }
        pendingSessionViewportSeeds.clear();
    });

    beforeEach(async () => {
        const syncMod = await import('@/sync/sync');
        vi.mocked(syncMod.sync.loadOlderMessages).mockReset();
        vi.mocked(syncMod.sync.loadNewerMessages).mockReset();
        vi.mocked(
            (syncMod.sync as unknown as { loadTargetWindowMessages: ReturnType<typeof vi.fn> }).loadTargetWindowMessages,
        ).mockReset();
        await resetTranscriptSingletonStateForTests();
        __resetDefaultTranscriptItemHeightCacheForTests();
        __resetTranscriptWarmPaintCacheForTests();
        runtimeMockState.platformOs = 'web';
        capturedFlashListProps = null;
        flashListChatListHarnessState.flashListProps = null;
        renderedFlatListCount = 0;
        renderedFlashListCount = 0;
        renderedMessageViewProps = [];
        renderedToolCallsGroupRowProps = [];
        renderedToolGroupUnitHeaderProps = [];
        renderedToolGroupUnitToolProps = [];
        linearItemsCacheBuildCalls = [];
        turnsCacheBuildCalls = [];
        flashListRefHandle = null;
        mountedTrees.length = 0;
        sessionMessagesState = { messages: [], isLoaded: true };
        sessionTranscriptIdsState = null;
        sessionMessagesByIdSnapshot = { messages: [], byId: {} };
        sessionMessagesStoreRevisionState = 0;
        sessionMessagesStoreListenersState = new Set();
        sessionPendingState = { messages: [] };
        sessionActionDraftsState = [];
        transcriptTurnsState = [];
        resetCanonicalSessionViewportTestState();
        sessionTargetWindowStateByIdState = new Map();
        sessionTargetWindowStateListenersByIdState = new Map();
        deferredNewerSessionIdsState = new Set();
        catchingUpNewerState = false;
        maybeDrainDeferredNewerMessagesMock.mockReset();
        runtimeMockState.headerHeight = 0;
        runtimeMockState.safeAreaTop = 0;
        reducedMotionMockState.preferred = false;
        markdownRuntimeMockState.ready = true;
        markdownRuntimeMockState.listeners.clear();
        markdownRuntimeMockState.preload.mockReset();
        markdownRuntimeMockState.preload.mockImplementation(() => Promise.resolve());
        jumpToTranscriptSeqMockState.implementation = null;
        viewportControllerMockState.resolveInputs = [];
        sessionState = {
            id: 'session-1',
            seq: 0,
            metadata: null,
            accessLevel: null,
            canApprovePermissions: true,
            agentState: null,
        };
        syncTuningState = {
            transcriptForwardPrefetchThresholdPx: 0,
            transcriptBackwardPrefetchThresholdPx: 0,
            transcriptFlashListEstimatedItemSize: 120,
            transcriptWebHotTailItemCount: 2,
            transcriptWebInitialPinStabilizeMs: 3000,
            transcriptWebInitialPinRetryIntervalMs: 250,
            transcriptWebInitialPinRetryMilestonesMs: [16, 50, 100, 200, 400, 800],
            transcriptOlderLoadCooldownMs: 250,
            transcriptOlderLoadSpinnerDelayMs: 300,
            transcriptViewportAnchorCaptureDebounceMs: 200,
            transcriptViewportAnchorOlderLookupMaxLoads: 6,
            transcriptNativeOlderMessagesPageSize: 64,
            transcriptDerivedItemsCacheMaxSessions: 8,
            transcriptMaxTurnEntriesPerListItem: 8,
            transcriptItemHeightCacheMaxEntries: 1024,
            transcriptFlashListDrawDistance: 0,
            transcriptMountSettleQuiescentWindowMs: 120,
            transcriptMountSettleDimensionNoiseFloorPx: 1,
            transcriptMountSettleBottomDistanceNoiseFloorPx: 2,
            transcriptInitialFillBudgetMs: 2000,
            // FlashList regression lane: pin the escape hatch (web-main default is Legend).
            transcriptLegendListSpikeSurface: 'flashList',
        };
        for (const k of Object.keys(settingValues)) delete settingValues[k];
        settingValues.transcriptGroupingMode = 'linear';
        settingValues.transcriptGroupToolCalls = false;
        settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
        settingValues.transcriptListImplementation = 'flash_v2';
        requireSelectionProviderForRenderedMessages = false;
    });

    afterEach(async () => {
        // Prevent initial-pin stabilization timeouts from leaking across tests and mutating later
        // tests' mocked DOM scroll containers (especially when fake timers are advanced).
        for (const tree of mountedTrees) {
            act(() => {
                tree.unmount();
            });
        }
        mountedTrees.length = 0;
        try {
            vi.useRealTimers();
        } catch {
            // no-op
        }
        await resetTranscriptSingletonStateForTests();
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        telemetryMod.transcriptViewportTelemetry.configure({ enabled: false, sink: null });
    });

    it('omits maintainVisibleContentPosition on web to avoid FlashList layout crashes', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 800,
            scrollTop: 400,
        });

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                expect(renderedFlatListCount).toBe(0);
                expect(screen.getCapturedFlashListProps()).not.toBeNull();
                expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toBeUndefined();
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {},
            },
        );
    });

    it('updates transcript navigation visibility from the renderer visible index window', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                {
                    kind: 'user-text',
                    id: 'u1',
                    localId: 'u1',
                    createdAt: 1,
                    text: 'Install dependencies',
                    seq: 7,
                    transcriptBlockIndex: 0,
                },
                {
                    kind: 'agent-text',
                    id: 'a1',
                    localId: 'a1',
                    createdAt: 2,
                    text: 'Dependencies are installed',
                    seq: 7,
                    transcriptBlockIndex: 1,
                    isThinking: false,
                },
                {
                    kind: 'user-text',
                    id: 'u2',
                    localId: 'u2',
                    createdAt: 3,
                    text: 'Run tests',
                    seq: 12,
                    transcriptBlockIndex: 0,
                },
            ],
        };
        const visibleUserAnchor = createFlashListChatListWebElement(
            'transcript-anchor-message-u1',
            { top: 120, bottom: 180 },
        );
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 900,
            scrollTop: 100,
            testNodes: [visibleUserAnchor],
        });
        // Navigation visibility is derived from the renderer's visible index
        // window, not from measured DOM anchor rows.
        flashListRefHandle = {
            ...flashListRefHandle,
            computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 0 })),
        };
        const { getTranscriptNavigationVisibilityStore } = await import('./viewport/visibility/transcriptNavigationVisibilityStore');
        const transcriptNavigationVisibilityStore = getTranscriptNavigationVisibilityStore('session-1');
        const unsubscribe = transcriptNavigationVisibilityStore.subscribe(vi.fn());
        await act(async () => {
            transcriptNavigationVisibilityStore.set(null);
        });

        try {
            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.triggerInitialFill({
                        layoutHeight: 400,
                        layoutWidth: 1000,
                        contentHeight: 900,
                        flushOptions: { turns: 1 },
                    });
                    await scrollFlashListTo(100, { trusted: false, turns: 2 });

                    expect(transcriptNavigationVisibilityStore.get()).toEqual({
                        currentAnchorId: 'session-1:user-turn:7',
                        visibleAnchorIds: ['session-1:user-turn:7'],
                    });
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            );
        } finally {
            unsubscribe();
        }

        await act(async () => {
            transcriptNavigationVisibilityStore.set(null);
        });
    });

    it('updates current navigation anchor from a mounted rail subscription during web scroll', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                {
                    kind: 'user-text',
                    id: 'u1',
                    localId: 'u1',
                    createdAt: 1,
                    text: 'Install dependencies',
                    seq: 7,
                    transcriptBlockIndex: 0,
                },
                {
                    kind: 'agent-text',
                    id: 'a1',
                    localId: 'a1',
                    createdAt: 2,
                    text: 'Dependencies are installed',
                    seq: 7,
                    transcriptBlockIndex: 1,
                    isThinking: false,
                },
                {
                    kind: 'user-text',
                    id: 'u2',
                    localId: 'u2',
                    createdAt: 3,
                    text: 'Run tests',
                    seq: 12,
                    transcriptBlockIndex: 0,
                },
            ],
        };
        const visibleUserAnchor = createFlashListChatListWebElement(
            'transcript-anchor-message-u1',
            { top: 120, bottom: 180 },
        );
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 900,
            scrollTop: 100,
            testNodes: [visibleUserAnchor],
        });
        // Navigation visibility is derived from the renderer's visible index
        // window, not from measured DOM anchor rows.
        flashListRefHandle = {
            ...flashListRefHandle,
            computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 0 })),
        };
        const { getTranscriptNavigationVisibilityStore } = await import('./viewport/visibility/transcriptNavigationVisibilityStore');
        const transcriptNavigationVisibilityStore = getTranscriptNavigationVisibilityStore('session-1');
        await act(async () => {
            transcriptNavigationVisibilityStore.set(null);
        });

        try {
            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.triggerInitialFill({
                        layoutHeight: 400,
                        layoutWidth: 1000,
                        contentHeight: 900,
                        flushOptions: { turns: 2 },
                    });
                    await screen.settle({ turns: 2 });

                    expect(transcriptNavigationVisibilityStore.subscriberCount()).toBeGreaterThan(0);
                    await scrollFlashListTo(100, { trusted: false, turns: 2, frames: 1 });

                    expect(transcriptNavigationVisibilityStore.get()).toEqual({
                        currentAnchorId: 'session-1:user-turn:7',
                        visibleAnchorIds: ['session-1:user-turn:7'],
                    });
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            );
        } finally {
            await act(async () => {
                transcriptNavigationVisibilityStore.set(null);
            });
        }
    });

    it('projects one oversized semantic tool-call group without arbitrary chunking', async () => {
        const toolMessageIds = Array.from({ length: 200 }, (_, index) => `tool-${index + 1}`);
        runtimeMockState.platformOs = 'ios';
        syncTuningState = {
            ...syncTuningState,
            transcriptMaxTurnEntriesPerListItem: 8,
        };
        settingValues.transcriptGroupingMode = 'turns';
        settingValues.transcriptGroupToolCalls = true;
        settingValues.transcriptTurnToolCallsGroupStrategy = 'all_tools_in_turn';
        settingValues.toolViewTimelineChromeMode = 'activity_feed';
        transcriptTurnsState = [{
            id: 'turn-tools',
            userMessageId: null,
            content: [{
                kind: 'tool_calls',
                id: 'turn-tools-group',
                toolMessageIds,
            }],
        }];
        sessionMessagesState = {
            isLoaded: true,
            messages: toolMessageIds.map((id, index) => ({
                kind: 'tool-call',
                id,
                localId: null,
                createdAt: index + 1,
                seq: index + 1,
                tool: { name: 'shell' },
            })),
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await screen.settle();

        // N2c per-unit rows: ONE semantic group = ONE header..footer span carrying the
        // full 200-tool membership — never whole-card rows, never every-N chunking.
        expect(renderedToolCallsGroupRowProps.length).toBe(0);
        expect(renderedToolGroupUnitHeaderProps.length).toBeGreaterThan(0);
        expect(renderedToolGroupUnitHeaderProps.every((props) => (
            props.groupId === 'turn-tools-group' &&
            Array.isArray(props.toolMessages) &&
            props.toolMessages.length === 200
        ))).toBe(true);
        const headerGroupIds = new Set(renderedToolGroupUnitHeaderProps.map((props) => props.groupId));
        expect(headerGroupIds.size).toBe(1);

        await screen.unmount();
    });

    describe('stable virtualization units for tool groups (N2c)', () => {
        const groupId = 'toolCalls:turn-tools:t-base';

        function buildToolMessages(ids: string[]) {
            return ids.map((id, index) => ({
                kind: 'tool-call',
                id,
                localId: null,
                createdAt: index + 1,
                seq: index + 1,
                tool: { name: 'shell' },
            }));
        }

        function configureToolTurn(toolIds: string[], options?: { platform?: 'ios' | 'web'; previewCount?: number; readerMessage?: boolean }) {
            runtimeMockState.platformOs = options?.platform ?? 'ios';
            settingValues.transcriptGroupingMode = 'turns';
            settingValues.transcriptGroupToolCalls = true;
            settingValues.toolViewTimelineChromeMode = 'activity_feed';
            settingValues.transcriptToolCallsCollapsedPreviewCount = options?.previewCount ?? 10;
            transcriptTurnsState = [
                {
                    id: 'turn-tools',
                    userMessageId: null,
                    content: [{ kind: 'tool_calls', id: groupId, toolMessageIds: toolIds }],
                },
                ...(options?.readerMessage === true
                    ? [{ id: 'turn-reader', userMessageId: 'reader', content: [] }]
                    : []),
            ];
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...buildToolMessages(toolIds),
                    ...(options?.readerMessage === true
                        ? [{ kind: 'agent-text', id: 'reader', localId: null, createdAt: toolIds.length + 1, seq: toolIds.length + 1, text: 'reader anchor' }]
                        : []),
                ],
            };
        }

        function listDataIds(): string[] {
            return (getCapturedFlashListProps()?.data ?? []).map((item: any) => item.id);
        }

        it('turns a prepend that merges into the visible group into BETWEEN-row insertion with stable keys', async () => {
            configureToolTurn(['t2', 't3']);

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await screen.settle();

            const beforeIds = listDataIds();
            expect(beforeIds).toContain(`${groupId}#tool:t2`);
            expect(beforeIds).not.toContain(`${groupId}#tool:t1`);

            // Prepend t1 merging into the same (sticky-id) group — sticky remap itself is
            // covered by buildTranscriptTurns tests; here the group keeps its id.
            configureToolTurn(['t1', 't2', 't3']);
            await screen.update(<ChatList session={{ ...sessionState, seq: 1 }} />);
            await screen.settle();

            const afterIds = listDataIds();
            // Every previously-rendered row id/key survives unchanged, in the same order.
            expect(afterIds.filter((id) => beforeIds.includes(id))).toEqual(beforeIds);
            // Native FlashList renders newest-first, so the older merged tool is inserted
            // after the newer tool rows and immediately before the group header.
            const t1Index = afterIds.indexOf(`${groupId}#tool:t1`);
            expect(t1Index).toBeLessThan(afterIds.indexOf(`${groupId}#header`));
            expect(t1Index).toBeGreaterThan(afterIds.indexOf(`${groupId}#tool:t2`));
            // Per-unit rows stay single-content rows (the N1 row-mutated instrument
            // counts 1 per unit, so intra-row growth cannot fire for tool groups).
            const { resolveTranscriptRowContentCount } = await import('./scroll/transcriptRowEvidence');
            for (const item of getCapturedFlashListProps()?.data ?? []) {
                if (typeof item?.kind === 'string' && item.kind.startsWith('tool-group-')) {
                    expect(resolveTranscriptRowContentCount(item)).toBe(1);
                }
            }

            await screen.unmount();
        });

        it('appends a streamed tool as a new row before the footer with existing keys stable', async () => {
            configureToolTurn(['t1', 't2']);

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await screen.settle();

            const beforeIds = listDataIds();

            configureToolTurn(['t1', 't2', 't3']);
            await screen.update(<ChatList session={{ ...sessionState, seq: 1 }} />);
            await screen.settle();

            const afterIds = listDataIds();
            expect(afterIds.filter((id) => beforeIds.includes(id))).toEqual(beforeIds);
            const newToolIndex = afterIds.indexOf(`${groupId}#tool:t3`);
            expect(newToolIndex).toBeLessThan(afterIds.indexOf(`${groupId}#tool:t2`));
            expect(afterIds[newToolIndex - 1]).toBe(`${groupId}#footer`);

            await screen.unmount();
        });

        it('round-trips expansion as list-row insertion/removal with per-group anchor keying preserved', async () => {
            // 40 tools exceed the auto-expand limit (max(32, preview*4, maxTurnEntries*4)),
            // so the group genuinely starts collapsed.
            const toolIds = Array.from({ length: 40 }, (_, index) => `t${index + 1}`);
            configureToolTurn(toolIds, { previewCount: 1 });

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await screen.settle();

            const collapsedIds = listDataIds();
            expect(collapsedIds).toEqual(expect.arrayContaining([
                `${groupId}#header`,
                `${groupId}#expand`,
                `${groupId}#tool:t40`,
                `${groupId}#footer`,
            ]));
            expect(collapsedIds).not.toContain(`${groupId}#tool:t1`);

            const headerProps = renderedToolGroupUnitHeaderProps.at(-1);
            expect(typeof headerProps?.setExpanded).toBe('function');
            await act(async () => {
                headerProps.setExpanded(true);
            });
            await screen.settle();

            const expandedIds = listDataIds();
            expect(expandedIds).toEqual(expect.arrayContaining([
                `${groupId}#header`,
                ...toolIds.map((id) => `${groupId}#tool:${id}`),
                `${groupId}#footer`,
            ]));
            expect(expandedIds).not.toContain(`${groupId}#expand`);
            // The preview-tail row keeps the SAME key across the toggle.
            expect(expandedIds).toContain(`${groupId}#tool:t40`);

            const expandedHeaderProps = renderedToolGroupUnitHeaderProps.at(-1);
            expect(expandedHeaderProps?.expanded).toBe(true);
            await act(async () => {
                expandedHeaderProps.setExpanded(false);
            });
            await screen.settle();

            expect(listDataIds()).toEqual(collapsedIds);

            await screen.unmount();
        });

        it('preserves the web reading anchor when expanding a tool group above the viewport (WREG.5)', async () => {
            const toolIds = Array.from({ length: 40 }, (_, index) => `t${index + 1}`);
            configureToolTurn(toolIds, { platform: 'web', previewCount: 1, readerMessage: true });
            syncTuningState = {
                ...syncTuningState,
                transcriptWebInitialPinStabilizeMs: 0,
            };

            const readerItem = createFlashListChatListWebElement('transcript-item-reader', { top: 120, bottom: 220 });
            const readerAnchor = createFlashListChatListWebElement('transcript-anchor-message-reader', { top: 140, bottom: 190 });
            readerAnchor.parentElement = readerItem;
            const scrollEl = Object.assign(
                createFlashListChatListWebScroller({
                    clientHeight: 400,
                    scrollHeight: 1200,
                    scrollTop: 480,
                    testNodes: [readerItem, readerAnchor],
                }),
                {
                    scrollTo: ({ top }: { top: number }) => {
                        scrollEl.scrollTop = top;
                    },
                },
            );

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const syncMod = await import('@/sync/sync');
                    const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();
                    await primeFlashListMetrics(400, 1200, { turns: 1 });
                    await act(async () => {
                        getCapturedFlashListProps()?.onWheel?.({ deltaY: -320, stopPropagation: vi.fn() });
                    });
                    scrollEl.scrollTop = 480;
                    await scrollFlashListTo(480, { trusted: true, turns: 1 });
                    loadOlderMessagesMock.mockClear();
                    const viewportBeforeToggle = sessionViewportByIdState.get('session-1');

                    const headerProps = renderedToolGroupUnitHeaderProps.at(-1);
                    expect(headerProps?.expanded).toBe(false);
                    expect(typeof headerProps?.setExpanded).toBe('function');

                    await act(async () => {
                        headerProps.setExpanded(true);
                        readerItem.setRect({ top: 300, bottom: 400 });
                        readerAnchor.setRect({ top: 320, bottom: 370 });
                        scrollEl.scrollHeight = 1380;
                    });
                    await screen.settle({ turns: 2, frames: 1 });

                    expect(scrollEl.scrollTop).toBe(660);
                    expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                    expect(sessionViewportByIdState.get('session-1')).toEqual(viewportBeforeToggle);

                    await screen.unmount();
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    HTMLElement: FlashListChatListWebElement,
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });

        it('keeps web bottom pinned when expanding the bottom tool group while live-tail pinned (WREG.5)', async () => {
            const toolIds = Array.from({ length: 40 }, (_, index) => `t${index + 1}`);
            configureToolTurn(toolIds, { platform: 'web', previewCount: 1 });
            syncTuningState = {
                ...syncTuningState,
                transcriptWebInitialPinStabilizeMs: 0,
            };

            const scrollEl = Object.assign(
                createFlashListChatListWebScroller({
                    clientHeight: 100,
                    scrollHeight: 1000,
                    scrollTop: 900,
                }),
                {
                    scrollTo: ({ top }: { top: number }) => {
                        scrollEl.scrollTop = top;
                    },
                },
            );

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const syncMod = await import('@/sync/sync');
                    const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();
                    await primeFlashListMetrics(100, 1000, { turns: 1 });
                    await scrollFlashListTo(900, { trusted: false, turns: 1 });
                    loadOlderMessagesMock.mockClear();

                    const headerProps = renderedToolGroupUnitHeaderProps.at(-1);
                    expect(headerProps?.expanded).toBe(false);
                    expect(typeof headerProps?.setExpanded).toBe('function');

                    await act(async () => {
                        headerProps.setExpanded(true);
                        scrollEl.scrollHeight = 1300;
                    });
                    await triggerFlashListChatListContentSizeChange(400, 1300, { turns: 2, frames: 1 });

                    expect(scrollEl.scrollTop).toBe(1200);
                    expect(loadOlderMessagesMock).not.toHaveBeenCalled();

                    await screen.unmount();
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('provides message selection context for transcript rows', async () => {
        requireSelectionProviderForRenderedMessages = true;
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'reply' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect(renderedMessageViewProps.map((messageProps) => messageProps.message?.id)).toEqual(['u1', 'a1']);
    });

    it('skips virtualized transcript rerenders for committed seq-only session changes', async () => {
        sessionState = {
            ...sessionState,
            seq: 1,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'reply' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await screen.settle({ cycles: 2, turns: 2 });
        renderedFlashListCount = 0;

        await screen.update(<ChatList session={{ ...sessionState, seq: 2 }} />);

        expect(renderedFlashListCount).toBe(0);
    });

    it('skips virtualized transcript rerenders when non-transcript session status changes', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'reply' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await screen.settle({ cycles: 2, turns: 2 });
        renderedFlashListCount = 0;

        await screen.update(<ChatList session={{ ...sessionState, latestTurnStatus: { status: 'running' } }} />);
        expect(renderedFlashListCount).toBe(0);
    });

    it('throttles web FlashList scroll events above one frame to reduce scroll-render churn', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps().scrollEventThrottle).toBe(32);
    });

    it('keeps one-frame native FlashList scroll events for viewport maintenance', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps().scrollEventThrottle).toBe(16);
    });

    it('keeps drag scrolling from dismissing the keyboard on iOS', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(renderedFlatListCount).toBe(0);
        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect(screen.getCapturedFlashListProps().keyboardShouldPersistTaps).toBe('handled');
        expect(screen.getCapturedFlashListProps().keyboardDismissMode).toBe('none');
    });

    it('defers native FlashList bottom pin until mount settle for fresh follow-bottom entries', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(600)),
            };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 2 });

            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

            await settleNativeFlashListMount(screen);

            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
            });
        });
    });

    it('pins default native follow-bottom when first content becomes scrollable after mount settle', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const syncMod = await import('@/sync/sync');
            vi.mocked(syncMod.sync.loadOlderMessages).mockResolvedValue({
                loaded: 0,
                hasMore: false,
                status: 'no_more',
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 600, { turns: 2 });
            expect(scrollToOffset).not.toHaveBeenCalled();

            await settleNativeFlashListMount(screen);
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            await triggerFlashListChatListContentSizeChange(0, 1200, { frames: 1, turns: 2 });

            expect(viewportControllerMockState.resolveInputs.filter((input) => input.type === 'auto-follow')).toEqual([]);
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
            });
        });
    });

    it('pins native follow-bottom after short initial content materializes into a long transcript', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 32,
                sink: telemetrySink,
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 32,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(727, 993, { turns: 2 });
            await settleNativeFlashListMount(screen);
            await triggerFlashListChatListScroll(
                136,
                {
                    contentSize: { height: 863 },
                    layoutMeasurement: { height: 727 },
                },
                { turns: 2 },
            );
            scrollToOffset.mockClear();
            telemetrySink.mockClear();

            await triggerFlashListChatListContentSizeChange(400, 10610, { frames: 1, turns: 2 });

            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                writer: 'native-scroll-to-offset',
                reason: 'content-size-change',
            }));
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
            });
        });
    });

    it('pins native follow-bottom when long content materializes before the bottom observation arrives', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 32,
                sink: telemetrySink,
            });
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 32,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(727, 999, { turns: 2 });
            await settleNativeFlashListMount(screen);
            scrollToOffset.mockClear();
            telemetrySink.mockClear();

            await triggerFlashListChatListContentSizeChange(400, 10616, { frames: 1, turns: 2 });

            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                writer: 'native-scroll-to-offset',
                reason: 'content-size-change',
            }));
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
            });
        });
    });

    it('does not load older native pages from a stale follow-bottom near-top observation', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 2 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(0)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index * 120,
                    width: 320,
                    height: 100,
                })),
            };
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(500, 2000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ turns: 2 });
            loadOlderMessagesMock.mockClear();

            await triggerFlashListChatListScroll(
                0,
                {
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                    isTrusted: false,
                },
                { turns: 2 },
            );

            expect(loadOlderMessagesMock).not.toHaveBeenCalled();

            await triggerFlashListChatListStartReached({ turns: 2 });

            expect(loadOlderMessagesMock).not.toHaveBeenCalled();
        });
    });

    it('ignores a native onStartReached misfire after the user unpins away from the top', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 8, endIndex: 10 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(900)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index * 120,
                    width: 320,
                    height: 100,
                })),
            };
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(500, 2000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ turns: 2 });
            loadOlderMessagesMock.mockClear();

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                    isTrusted: true,
                },
                { turns: 2 },
            );

            expect(loadOlderMessagesMock).not.toHaveBeenCalled();

            await triggerFlashListChatListStartReached({ turns: 2 });

            expect(loadOlderMessagesMock).not.toHaveBeenCalled();
        });
    });

    it('does not auto-chain native older-page prefetches without a fresh top-edge user action', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 3 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(100)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index * 120,
                    width: 320,
                    height: 100,
                })),
            };
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
                transcriptOlderLoadCooldownMs: 2500,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(500, 2000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ turns: 2 });
            loadOlderMessagesMock.mockClear();

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                    isTrusted: true,
                },
                { turns: 2 },
            );
            await triggerFlashListChatListScroll(
                100,
                {
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                    isTrusted: true,
                },
                { turns: 2 },
            );

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(2499);
            });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(1);
            });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
        });
    });

    it('cancels chained native older-page prefetch when the restored viewport is no longer near the top edge', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            let nativeScrollOffset = 100;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 3 })),
                getAbsoluteLastScrollOffset: vi.fn(() => (
                    nativeScrollOffset == null
                        ? null
                        : nativeRawOffsetForCanonicalOffset(nativeScrollOffset)
                )),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index * 120,
                    width: 320,
                    height: 100,
                })),
            };
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
                transcriptOlderLoadCooldownMs: 2500,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(500, 2000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ turns: 2 });
            loadOlderMessagesMock.mockClear();

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                    isTrusted: true,
                },
                { turns: 2 },
            );
            await triggerFlashListChatListScroll(
                100,
                {
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                    isTrusted: true,
                },
                { turns: 2 },
            );

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            nativeScrollOffset = 1500;

            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await screen.settle({ turns: 2 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
        });
    });

    it('cancels chained native older-page prefetch when live geometry becomes unavailable', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            let nativeScrollOffset: number | null = 100;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 3 })),
                getAbsoluteLastScrollOffset: vi.fn(() => (
                    nativeScrollOffset == null
                        ? null
                        : nativeRawOffsetForCanonicalOffset(nativeScrollOffset)
                )),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index * 120,
                    width: 320,
                    height: 100,
                })),
            };
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
                transcriptOlderLoadCooldownMs: 2500,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(500, 2000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ turns: 2 });
            loadOlderMessagesMock.mockClear();

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                    isTrusted: true,
                },
                { turns: 2 },
            );
            await triggerFlashListChatListScroll(
                100,
                {
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                    isTrusted: true,
                },
                { turns: 2 },
            );

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            nativeScrollOffset = null;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await screen.settle({ turns: 2 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
        });
    });

    it('records every native FlashList scroll observation for high-frequency viewport instrumentation', async () => {
        runtimeMockState.platformOs = 'ios';
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 32,
            sink: telemetrySink,
        });
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 32,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });
        telemetrySink.mockClear();

        await scrollFlashListTo(830, { trusted: false, turns: 1 });

        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-observed',
            reason: 'observed',
            platform: 'ios',
            listImplementation: 'flash_v2',
            mode: 'follow-bottom',
            offsetY: 830,
            layoutHeight: 100,
            contentHeight: 1000,
            distanceFromBottom: 70,
        }));
    });

    it('ignores impossible negative native FlashList observations after reaching bottom', async () => {
        runtimeMockState.platformOs = 'ios';
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 32,
            sink: telemetrySink,
        });
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 32,
        };
        const onViewportChange = vi.fn((state: any) => {
            routeSessionViewportChangeIntoTestStore('session-1', state);
        });
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(
            <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
        );
        await primeFlashListMetrics(682, 24578, { turns: 2 });
        await scrollFlashListTo(23896, { trusted: false, turns: 1 });

        expect(sessionViewportByIdState.get('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
        });

        onViewportChange.mockClear();
        telemetrySink.mockClear();
        await scrollFlashListTo(-972759, { trusted: false, turns: 1 });

        expect(sessionViewportByIdState.get('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
        });
        expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
            isPinned: false,
            shouldRestoreViewport: true,
        }));
        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-observed',
            reason: 'invalid-native-offset',
            platform: 'ios',
            listImplementation: 'flash_v2',
            rawOffsetY: -972759,
            offsetY: 996655,
            layoutHeight: 682,
            contentHeight: 24578,
            distanceFromBottom: 0,
        }));
    });

    it('drops native invalid-offset observations without a recovery repin (B5)', async () => {
        runtimeMockState.platformOs = 'ios';
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 32,
            sink: telemetrySink,
        });
        const scrollToOffset = vi.fn();
        flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 32,
        };
        const onViewportChange = vi.fn((state: any) => {
            routeSessionViewportChangeIntoTestStore('session-1', state);
        });
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(
            <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
        );
        await primeFlashListMetrics(682, 24578, { turns: 2 });
        await scrollFlashListTo(23896, { trusted: false, turns: 1 });
        expect(sessionViewportByIdState.get('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
        });

        onViewportChange.mockClear();
        scrollToOffset.mockClear();
        await scrollFlashListTo(-972759, { trusted: false, turns: 1 });
        await Promise.resolve();
        await Promise.resolve();
        await screen.settle({ turns: 1 });

        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-observed',
            reason: 'invalid-native-offset',
            mode: 'follow-bottom',
            rawOffsetY: -972759,
            offsetY: 996655,
        }));
        // B5: invalid observations are dropped only — no recovery repin side effect.
        expect(scrollToOffset).not.toHaveBeenCalled();

        scrollToOffset.mockClear();
        await scrollFlashListTo(-1787, { trusted: false, turns: 1 });
        await scrollFlashListTo(473, { trusted: false, turns: 1 });
        await screen.settle({ turns: 1 });

        expect(scrollToOffset).not.toHaveBeenCalled();
        expect(sessionViewportByIdState.get('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
        });
        expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
            isPinned: false,
            shouldRestoreViewport: true,
        }));
    });

    it('issues one native distance restore and spends at most one conclusive-misalignment correction', async () => {
        // Plan invariant C (transcript-viewport-single-owner-unification): one entry transaction,
        // one one-shot distance write, plus at most ONE correction driven by a CONCLUSIVE
        // misaligned observation. Shrunken/stale content frames are inconclusive and never
        // re-issue writes (evidence E1 deleted).
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 657,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(667, 35736, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 657,
                animated: false,
            });
            scrollToOffset.mockClear();

            // Content shrink (or stale layout frame) never re-issues the restore.
            await triggerFlashListChatListContentSizeChange(400, 33818, { turns: 2 });
            expect(scrollToOffset).not.toHaveBeenCalled();

            // An observation with a content basis below the issued one is inconclusive.
            await triggerFlashListChatListScroll(
                33018,
                {
                    contentSize: { height: 33818 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).not.toHaveBeenCalled();

            // Content growth alone never re-issues either (E1).
            await triggerFlashListChatListContentSizeChange(400, 36800, { turns: 2 });
            expect(scrollToOffset).not.toHaveBeenCalled();

            // A conclusive misaligned observation at the grown basis spends the single correction.
            await triggerFlashListChatListScroll(
                34000,
                {
                    contentSize: { height: 36800 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).toHaveBeenCalledTimes(1);
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 657,
                animated: false,
            });
            scrollToOffset.mockClear();

            // The correction budget is spent: further misaligned observations hold without writing.
            await triggerFlashListChatListScroll(
                33800,
                {
                    contentSize: { height: 36800 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).not.toHaveBeenCalled();

            // An aligned observation confirms and closes the transaction; nothing writes after.
            await triggerFlashListChatListScroll(
                35476,
                {
                    contentSize: { height: 36800 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 38000, { turns: 2 });
            await screen.settle({
                advanceTimersMs: 401,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('holds the native distance restore without timer re-issues when no observation arrives', async () => {
        // Plan invariant C: the entry-restore transaction never re-issues on a timer — a missing
        // native observation leaves it pending until confirm or the entry deadline closes it.
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 355,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(727, 21758, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 355,
                animated: false,
            });
            scrollToOffset.mockClear();

            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).not.toHaveBeenCalled();

            await triggerFlashListChatListScroll(
                20676,
                {
                    contentSize: { height: 21758 },
                    layoutMeasurement: { height: 727 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: 401,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('keeps the entry-restore transaction open through generic transcript touch movement', async () => {
        // Touch noise without a real scroll escape must not preempt the entry transaction: a
        // later aligned observation still confirms it (touch-escape semantics, plan A2).
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 64,
                sink: telemetrySink,
            });
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 355,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(727, 21758, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 355,
                animated: false,
            });
            scrollToOffset.mockClear();
            telemetrySink.mockClear();

            await act(async () => {
                screen.getCapturedFlashListProps().onTouchMove?.({});
            });
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).not.toHaveBeenCalled();

            // The transaction survived the touch noise: the aligned observation confirms it.
            await triggerFlashListChatListScroll(
                20676,
                {
                    contentSize: { height: 21758 },
                    layoutMeasurement: { height: 727 },
                },
                { turns: 1 },
            );
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'restore-decision',
                reason: 'restored',
            }));
        });
    });

    it('releases native paint after the mount-settle budget when an unpinned entry restore is not observed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 355,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };
            const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
            syncPerformanceTelemetry.configure({
                enabled: true,
                slowThresholdMs: 1_000_000,
                flushIntervalMs: 60_000,
            });
            syncPerformanceTelemetry.reset();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(727, 21758, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 355,
                animated: false,
            });
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
            expect(syncPerformanceTelemetry.snapshot().events.find(
                (event) => event.name === 'ui.sessions.transcript.stablePaint',
            )).toEqual(expect.objectContaining({
                fields: expect.objectContaining({
                    native: 1,
                    nativeMountSettleDeadlineReached: 1,
                    nativeViewportObserved: 0,
                    web: 0,
                }),
            }));

            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        });
    });

    it('releases native paint after the mount-settle budget even when active content keeps changing', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionState = { ...sessionState, active: true };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 355,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'streaming' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(727, 21758, { turns: 2 });
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            for (const contentHeight of [21812, 21896, 21940]) {
                await triggerFlashListChatListContentSizeChange(400, contentHeight, {
                    advanceTimersMs: Math.floor(syncTuningState.transcriptMountSettleQuiescentWindowMs / 2),
                    turns: 1,
                });
                expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);
            }

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('treats stale smaller content metrics as inconclusive and corrects only on a conclusive misalignment', async () => {
        // Only conclusive aligned|misaligned observations reach the entry transaction (Lane A
        // review contract): a stale-content frame neither confirms nor burns the correction.
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 390,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(682, 2262, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 390,
                animated: false,
            });
            scrollToOffset.mockClear();

            // Stale frame: content basis below the issued one — inconclusive, no write.
            await triggerFlashListChatListScroll(
                1190,
                {
                    contentSize: { height: 2135 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).not.toHaveBeenCalled();

            // Content growth alone never re-issues (E1 deleted).
            await triggerFlashListChatListContentSizeChange(400, 3140, { turns: 2 });
            expect(scrollToOffset).not.toHaveBeenCalled();

            // The conclusive misaligned observation at the grown basis drives the single correction.
            await triggerFlashListChatListScroll(
                1500,
                {
                    contentSize: { height: 3140 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 390,
                animated: false,
            });
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                2068,
                {
                    contentSize: { height: 3140 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: 401,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('confirms the one-shot native distance restore and never reapplies on content growth or shrink', async () => {
        // Plan §6 deletion (protected-entry-restore content-change reapply, evidence E1): after
        // the aligned observation confirms the entry transaction, content-height churn in either
        // direction must never re-issue entry writes.
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 8059,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(728, 31977, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 8059,
                animated: false,
            });
            scrollToOffset.mockClear();

            // The aligned observation confirms the transaction.
            await triggerFlashListChatListScroll(
                23190,
                {
                    contentSize: { height: 31977 },
                    layoutMeasurement: { height: 728 },
                },
                { turns: 1 },
            );

            // Growth after confirmation: zero entry writes.
            await triggerFlashListChatListContentSizeChange(400, 47469, { turns: 2 });
            expect(scrollToOffset).not.toHaveBeenCalled();

            await triggerFlashListChatListScroll(
                38682,
                {
                    contentSize: { height: 47469 },
                    layoutMeasurement: { height: 728 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).not.toHaveBeenCalled();

            // Shrink after confirmation: still zero entry writes.
            await triggerFlashListChatListContentSizeChange(400, 43026, { turns: 2 });
            await screen.settle({
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('uses the canonical scroll content basis for one-shot distance restores with composer inset', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 391,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            const inset = screen.findByTestId('transcript-composer-keyboard-inset') as {
                props?: { onHeightChange?: (height: number) => void };
            };
            await act(async () => {
                inset.props?.onHeightChange?.(134);
            });

            await primeFlashListMetrics(682, 2128, { turns: 2 });

            // The one-shot distance target is computed on the canonical scroll-event content
            // basis (A6): the composer inset added into the measured ref is subtracted again.
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 391,
                animated: false,
            });
            scrollToOffset.mockClear();

            // The scroll-event observation on the same basis confirms the restore.
            await triggerFlashListChatListScroll(
                1055,
                {
                    contentSize: { height: 2128 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );

            // Content growth after confirmation never re-issues the entry restore (E1 deleted).
            await triggerFlashListChatListContentSizeChange(400, 3006, { turns: 2 });
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).not.toHaveBeenCalled();

            await triggerFlashListChatListScroll(
                1933,
                {
                    contentSize: { height: 3006 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: 401,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('materializes older pages before issuing a native distance restore deeper than the loaded window', async () => {
        // Wiring-layer extension of resolveEntryRestoreTarget (F2 ledger note): a remembered
        // distance deeper than the loaded window runs bounded materialization FIRST - the
        // one-shot write happens exactly once, at the full target, never at a clamped one.
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 429,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            let resolveLoadOlder = createMissingLoadOlderResolver();
            const loadOlderPromise = new Promise<LoadedOlderResult>((resolve) => {
                resolveLoadOlder = (value) => {
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'user-text', id: 'u0', localId: null, createdAt: 0, seq: 0, text: 'zero' },
                            ...sessionMessagesState.messages,
                        ],
                    };
                    resolve(value);
                };
            });
            loadOlderMessagesMock.mockImplementation(() => {
                // Later lookups stay in flight until the content remeasures; the first page is
                // resolved explicitly below.
                if (loadOlderMessagesMock.mock.calls.length > 1) {
                    return new Promise<LoadedOlderResult>(() => {});
                }
                return loadOlderPromise;
            });

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(682, 942, { turns: 2 });

            // Deeper-than-window distance: no clamped write, materialization runs instead.
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                resolveLoadOlder({ loaded: 1, hasMore: true, status: 'loaded' });
                await Promise.resolve();
                await Promise.resolve();
                screen.tree.update(<ChatList session={{ ...sessionState }} />);
            });
            await triggerFlashListChatListContentSizeChange(400, 3043, { turns: 2 });
            await screen.settle({
                advanceTimersMs: 401,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 429,
                animated: false,
            });
            expect(scrollToOffset).toHaveBeenCalledTimes(1);
        });
    });

    it('preserves a native unpinned session after many intervening session opens without leaking another viewport', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const syncMod = await import('@/sync/sync');
            vi.mocked(syncMod.sync.loadOlderMessages).mockResolvedValue({
                loaded: 0,
                hasMore: false,
                status: 'no_more',
            });
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 128,
                sink: telemetrySink,
            });
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 0;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index * 500,
                    width: 320,
                    height: 500,
                })),
            };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 128,
            };
            let activeSessionId = 'session-a';
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore(activeSessionId, state);
            });
            const messagesForSession = (sessionId: string) => [
                { kind: 'user-text', id: `${sessionId}-u1`, localId: null, createdAt: 1, seq: 1, text: `${sessionId} user` },
                { kind: 'agent-text', id: `${sessionId}-a1`, localId: null, createdAt: 2, seq: 2, text: `${sessionId} agent` },
            ];

            const { ChatList } = await import('./ChatList');

            sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId) };
            const firstA = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 4 });
            scrollToOffset.mockClear();
            onViewportChange.mockClear();

            nativeScrollOffset = 400;
            await scrollFlashListTo(400, { trusted: true, turns: 1 });

            expect(sessionViewportByIdState.get('session-a')).toMatchObject({
                isPinned: false,
                offsetY: 500,
                source: 'observed',
            });
            unmountTrackedFlashListChatList(firstA);

            for (let index = 0; index < 15; index += 1) {
                activeSessionId = `session-intervening-${index}`;
                sessionViewportByIdState.set(activeSessionId, {
                    isPinned: index % 3 === 0,
                    offsetY: index % 3 === 0 ? 0 : 120 + index,
                    anchor: null,
                    lastUpdatedAt: index + 1,
                    source: index % 3 === 0 ? 'default' : 'observed',
                });
                sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId) };
                const interveningScreen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
                );
                await primeFlashListMetrics(100, 1000, { turns: 2 });
                unmountTrackedFlashListChatList(interveningScreen);
            }

            scrollToOffset.mockClear();
            telemetrySink.mockClear();
            activeSessionId = 'session-a';
            sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId) };
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 4 });

            expect(sessionViewportByIdState.get('session-a')).toMatchObject({
                isPinned: false,
                offsetY: 500,
                source: 'observed',
            });
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                sessionId: expect.stringMatching(/^session-intervening-/),
            }));
        });
    });

    it('keeps a debounced A-session anchor capture out of B-session memory across a switch (A3 session guard)', async () => {
        // Plan A3: the debounced viewport anchor capture is session-guarded. On session exit it
        // flushes synchronously against the still-mounted A list (deferred emit through A's
        // handler); after B-entry no capture may run against B's refs or write into A/B memory
        // with the other session's content.
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 2 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(400)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index === 1 ? 460 : 620,
                    width: 320,
                    height: 120,
                })),
            };
            const makeViewportHandler = (sessionId: string) =>
                vi.fn((state: any) => routeSessionViewportChangeIntoTestStore(sessionId, state));
            const handlerA = makeViewportHandler('session-a');
            const handlerB = makeViewportHandler('session-b');
            const messagesForSession = (sessionId: string) => [
                { kind: 'user-text' as const, id: `${sessionId}-m1`, localId: null, createdAt: 1, seq: 1, text: `${sessionId} one` },
                { kind: 'agent-text' as const, id: `${sessionId}-m2`, localId: null, createdAt: 2, seq: 2, text: `${sessionId} two` },
                { kind: 'agent-text' as const, id: `${sessionId}-m3`, localId: null, createdAt: 3, seq: 3, text: `${sessionId} three` },
            ];

            const { ChatList } = await import('./ChatList');
            sessionMessagesState = { isLoaded: true, messages: messagesForSession('session-a') };
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-a' }} onViewportChange={handlerA} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 4 });
            handlerA.mockClear();

            // Schedules the debounced anchor capture for session A (debounce 200ms).
            await scrollFlashListTo(400, { trusted: true, turns: 1 });

            // Switch to B BEFORE the debounce elapses.
            sessionMessagesState = { isLoaded: true, messages: messagesForSession('session-b') };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-b' }} onViewportChange={handlerB} />,
            );
            await screen.settle({ cycles: 1, turns: 2, advanceTimersMs: 250 });

            // The exit flush persisted A's capture into A's memory, anchored on A's items.
            expect(sessionViewportByIdState.get('session-a')).toMatchObject({
                isPinned: false,
                offsetY: 500,
                source: 'observed',
                anchor: expect.objectContaining({
                    itemId: 'session-a-m2',
                }),
            });
            // Nothing wrote A's capture into B's memory after B-entry.
            const storedB = sessionViewportByIdState.get('session-b');
            expect(storedB?.anchor?.itemId?.startsWith('session-a')).not.toBe(true);
            expect(handlerB).not.toHaveBeenCalledWith(expect.objectContaining({
                anchor: expect.objectContaining({ itemId: expect.stringContaining('session-a') }),
            }));
        });
    });


    it('restores the captured native anchor for an active unpinned session after tail growth while away', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            const scrollToIndex = vi.fn();
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 2 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(400)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index === 1 ? 460 : 620,
                    width: 320,
                    height: 120,
                })),
            };
            let activeSessionId = 'session-a';
            const makeViewportHandler = (sessionId: string) => vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore(sessionId, state);
            });
            const handlerA = makeViewportHandler('session-a');
            const handlerB = makeViewportHandler('session-b');
            const messagesForSession = (sessionId: string, includeTailGrowth = false) => [
                { kind: 'user-text', id: `${sessionId}-m1`, localId: null, createdAt: 1, seq: 1, text: `${sessionId} one` },
                { kind: 'agent-text', id: `${sessionId}-m2`, localId: null, createdAt: 2, seq: 2, text: `${sessionId} two` },
                { kind: 'agent-text', id: `${sessionId}-m3`, localId: null, createdAt: 3, seq: 3, text: `${sessionId} three` },
                ...(includeTailGrowth
                    ? [{ kind: 'agent-text' as const, id: `${sessionId}-m4`, localId: null, createdAt: 4, seq: 4, text: `${sessionId} streamed while away` }]
                    : []),
            ];

            const { ChatList } = await import('./ChatList');
            sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId) };
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={handlerA} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 4 });
            handlerA.mockClear();

            await scrollFlashListTo(400, { trusted: true, turns: 1 });

            activeSessionId = 'session-b';
            sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId) };
            await screen.update(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={handlerB} />,
            );
            await Promise.resolve();
            expect(sessionViewportByIdState.get('session-a')).toMatchObject({
                isPinned: false,
                anchor: expect.objectContaining({
                    messageId: 'session-a-m2',
                    itemId: 'session-a-m2',
                }),
                source: 'observed',
            });

            await primeFlashListMetrics(100, 1000, { turns: 2 });

            scrollToOffset.mockClear();
            scrollToIndex.mockClear();
            activeSessionId = 'session-a';
            sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId, true) };
            await screen.update(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={handlerA} />,
            );
            await primeFlashListMetrics(100, 1200, { turns: 4 });

            // The captured anchor has a nonzero saved pixel offset, so the slice path
            // cannot restore it precisely without a write. Fall back to the exact
            // anchor write and keep the full loaded window.
            expect((flashListChatListHarnessState.flashListProps?.data ?? []).map((item: any) => item.id))
                .toEqual(['session-a-m4', 'session-a-m3', 'session-a-m2', 'session-a-m1']);
            expect(scrollToIndex).toHaveBeenCalledWith({
                animated: false,
                index: 2,
                viewOffset: 40,
            });
            expect(scrollToOffset).not.toHaveBeenCalledWith(expect.objectContaining({
                offset: 0,
            }));
            expect(sessionViewportByIdState.get('session-a')).toMatchObject({
                isPinned: false,
                anchor: expect.objectContaining({
                    messageId: 'session-a-m2',
                    itemId: 'session-a-m2',
                }),
                source: 'observed',
            });
        });
    });

    it('defaults native FlashList drawDistance to about one viewport height clamped to [600, 1200]px (plan C4)', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        // Unmeasured viewport clamps to the 600px floor…
        expect(screen.getCapturedFlashListProps().drawDistance).toBe(600);

        // …a phone-sized viewport uses ~1x its height…
        await primeFlashListMetrics(800, 4000, { turns: 2 });
        expect(screen.getCapturedFlashListProps().drawDistance).toBe(800);

        // …and tall viewports clamp to the 1200px ceiling.
        await primeFlashListMetrics(2000, 8000, { turns: 2 });
        expect(screen.getCapturedFlashListProps().drawDistance).toBe(1200);
    });

    it('passes configured native FlashList drawDistance without affecting web', async () => {
        syncTuningState = { ...syncTuningState, transcriptFlashListDrawDistance: 1600 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        runtimeMockState.platformOs = 'web';
        const webScreen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        expect(webScreen.getCapturedFlashListProps().drawDistance).toBeUndefined();
        unmountTrackedFlashListChatList(webScreen);

        runtimeMockState.platformOs = 'ios';
        const nativeScreen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        expect(nativeScreen.getCapturedFlashListProps().drawDistance).toBe(1600);
    });

    it('keeps native first-paint placeholder until FlashList mount settle', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await triggerFlashListChatListLoad(12, { turns: 1 });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await primeFlashListMetrics(100, 1000, { turns: 2 });
            await settleNativeFlashListMount(screen);

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('records native FlashList first-paint telemetry when onLoad fires', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        const { markSessionOpenRequestedForSessionUiTelemetry } = await import('@/sync/runtime/performance/sessionUiTelemetry');
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        markSessionOpenRequestedForSessionUiTelemetry({
            sessionId: 'session-1',
            source: 'navigate-hook',
        });

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        await triggerFlashListChatListLoad(12, { turns: 1 });

        const firstPaintEvent = syncPerformanceTelemetry
            .snapshot()
            .events.find((event) => event.name === 'ui.sessions.transcript.firstPaint');

        expect(firstPaintEvent).toBeTruthy();
        expect(firstPaintEvent?.fields).toMatchObject({
            committedMessages: 1,
            items: 1,
            native: 1,
            web: 0,
        });
        const openToFirstPaintEvent = syncPerformanceTelemetry
            .snapshot()
            .events.find((event) => event.name === 'ui.sessions.transcript.openToFirstPaint');

        expect(openToFirstPaintEvent).toBeTruthy();
        expect(openToFirstPaintEvent?.fields).toMatchObject({
            committedMessages: 1,
            items: 1,
            native: 1,
            sourceNavigateHook: 1,
            web: 0,
        });
        expect(JSON.stringify(openToFirstPaintEvent)).not.toContain('session-1');

        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('records native stable-paint telemetry only after the first-paint placeholder releases', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };
            const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
            const { markSessionOpenRequestedForSessionUiTelemetry } = await import('@/sync/runtime/performance/sessionUiTelemetry');
            syncPerformanceTelemetry.configure({
                enabled: true,
                slowThresholdMs: 1_000_000,
                flushIntervalMs: 60_000,
            });
            syncPerformanceTelemetry.reset();
            markSessionOpenRequestedForSessionUiTelemetry({
                sessionId: 'session-1',
                source: 'navigate-hook',
            });

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await triggerFlashListChatListLoad(12, { turns: 1 });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);
            expect(syncPerformanceTelemetry.snapshot().events.some(
                (event) => event.name === 'ui.sessions.transcript.firstPaint',
            )).toBe(true);
            expect(syncPerformanceTelemetry.snapshot().events.some(
                (event) => event.name === 'ui.sessions.transcript.stablePaint',
            )).toBe(false);

            await primeFlashListMetrics(100, 1000, { turns: 2 });
            await settleNativeFlashListMount(screen);

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
            const stablePaintEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((event) => event.name === 'ui.sessions.transcript.stablePaint');

            expect(stablePaintEvent).toBeTruthy();
            expect(stablePaintEvent?.fields).toMatchObject({
                committedMessages: 1,
                firstListPaintObserved: 1,
                items: 1,
                native: 1,
                nativeMountSettleStable: 1,
                routeHydrationPending: 0,
                web: 0,
            });
            const openToStablePaintEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((event) => event.name === 'ui.sessions.transcript.openToStablePaint');

            expect(openToStablePaintEvent).toBeTruthy();
            expect(openToStablePaintEvent?.fields).toMatchObject({
                committedMessages: 1,
                distanceFromBottom: 0,
                items: 1,
                native: 1,
                sourceNavigateHook: 1,
                web: 0,
            });
            expect(JSON.stringify(openToStablePaintEvent)).not.toContain('session-1');

            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        });
    });

    it('releases native first-paint placeholder after an unpinned entry restore paints without requiring user scroll', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(100, 1000, { turns: 4 });

            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 200,
                animated: false,
            });
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ turns: 2 });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('releases native first-paint placeholder from layout commit after an unpinned entry restore when FlashList onLoad is silent', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(100, 1000, { turns: 4 });

            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 200,
                animated: false,
            });
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await screen.settle({
                advanceTimersMs: 33,
                cycles: 1,
                turns: 2,
            });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('lets native warm stable-paint cache reveal a warm remount without waiting for a viewport observation', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };
            const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
            syncPerformanceTelemetry.configure({
                enabled: true,
                slowThresholdMs: 1_000_000,
                flushIntervalMs: 60_000,
            });
            syncPerformanceTelemetry.reset();

            const { ChatList } = await import('./ChatList');
            const first = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(countExactTestId(first, 'transcript-first-paint-placeholder')).toBe(1);

            await primeFlashListMetrics(100, 1000, { turns: 2 });
            await settleNativeFlashListMount(first);

            expect(countExactTestId(first, 'transcript-first-paint-placeholder')).toBe(0);
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 2 },
            );
            expect(syncPerformanceTelemetry.snapshot().events.some(
                (event) => event.name === 'ui.sessions.transcript.stablePaint',
            )).toBe(true);

            unmountTrackedFlashListChatList(first);
            const warm = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(countExactTestId(warm, 'transcript-first-paint-placeholder')).toBe(0);

            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        });
    });

    it('records native stable-paint telemetry when mount-settle releases without FlashList onLoad', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };
            const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
            syncPerformanceTelemetry.configure({
                enabled: true,
                slowThresholdMs: 1_000_000,
                flushIntervalMs: 60_000,
            });
            syncPerformanceTelemetry.reset();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(100, 1000, { turns: 2 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
            expect(syncPerformanceTelemetry.snapshot().events.some(
                (event) => event.name === 'ui.sessions.transcript.firstPaint',
            )).toBe(true);

            const stablePaintEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((event) => event.name === 'ui.sessions.transcript.stablePaint');

            expect(stablePaintEvent).toBeTruthy();
            expect(stablePaintEvent?.fields).toMatchObject({
                firstListPaintObserved: 0,
                native: 1,
                nativeMountSettleDeadlineReached: 1,
                web: 0,
            });

            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        });
    });

    it('does not record native paint telemetry from a pre-settle bottom observation when FlashList onLoad is silent', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };
            const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
            const { markSessionRouteEnteredForSessionUiTelemetry } = await import('@/sync/runtime/performance/sessionUiTelemetry');
            syncPerformanceTelemetry.configure({
                enabled: true,
                slowThresholdMs: 1_000_000,
                flushIntervalMs: 60_000,
            });
            syncPerformanceTelemetry.reset();
            markSessionRouteEnteredForSessionUiTelemetry({ sessionId: 'session-1' });

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 682.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 6243, { turns: 1 });

            expect(syncPerformanceTelemetry.snapshot().events.some(
                (event) => event.name === 'ui.sessions.transcript.firstPaint',
            )).toBe(false);
            expect(syncPerformanceTelemetry.snapshot().events.some(
                (event) => event.name === 'ui.sessions.transcript.stablePaint',
            )).toBe(false);

            await triggerFlashListChatListScroll(
                5427.333333333333,
                {
                    contentSize: { height: 6109 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);
            const snapshot = syncPerformanceTelemetry.snapshot();
            expect(snapshot.events.find((event) => event.name === 'ui.sessions.transcript.firstPaint')).toBeFalsy();
            expect(snapshot.events.find((event) => event.name === 'ui.sessions.transcript.stablePaint')).toBeFalsy();
            expect(snapshot.events.find((event) => event.name === 'ui.sessions.transcript.openToFirstPaint')).toBeFalsy();
            expect(snapshot.events.find((event) => event.name === 'ui.sessions.transcript.openToStablePaint')).toBeFalsy();

            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        });
    });

    it('keeps native first-paint placeholder through a pre-settle bottom observation when content can still grow', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };
            const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
            syncPerformanceTelemetry.configure({
                enabled: true,
                slowThresholdMs: 1_000_000,
                flushIntervalMs: 60_000,
            });
            syncPerformanceTelemetry.reset();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 764.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 5848, { turns: 1 });
            await triggerFlashListChatListScroll(
                4950,
                {
                    contentSize: { height: 5714 },
                    layoutMeasurement: { height: 764 },
                },
                { turns: 1 },
            );

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);
            expect(syncPerformanceTelemetry.snapshot().events.some(
                (event) => event.name === 'ui.sessions.transcript.firstPaint',
            )).toBe(false);
            expect(syncPerformanceTelemetry.snapshot().events.some(
                (event) => event.name === 'ui.sessions.transcript.stablePaint',
            )).toBe(false);

            await triggerFlashListChatListContentSizeChange(400, 11913, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });
            await triggerFlashListChatListScroll(
                11015,
                {
                    contentSize: { height: 11779 },
                    layoutMeasurement: { height: 764 },
                },
                { turns: 1 },
            );

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
            expect(syncPerformanceTelemetry.snapshot().events.find(
                (event) => event.name === 'ui.sessions.transcript.stablePaint',
            )).toEqual(expect.objectContaining({
                fields: expect.objectContaining({
                    distanceFromBottom: 0,
                    native: 1,
                    nativeMountSettleDeadlineReached: 1,
                    nativeViewportObserved: 0,
                    web: 0,
                }),
            }));

            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        });
    });

    it('releases native first-paint placeholder after the mount-settle budget when FlashList never stabilizes', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await triggerFlashListChatListLoad(12, { turns: 1 });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('releases native first-paint placeholder after the mount-settle budget when FlashList onLoad never fires', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('flushes a pending native bottom pin at the mount-settle deadline without replaying recycled same-content drift', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
            scrollToOffset.mockClear();

            await scrollFlashListTo(300, { trusted: false, turns: 1 });
            await triggerFlashListChatListContentSizeChange(400, 1200, { turns: 2 });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('releases native first-paint placeholder at the mount-settle deadline without waiting for a bottom observation', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
        });
    });

    it('keeps recycled passive native mount observations outside replayable mount-settle corrections', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 32,
                sink: telemetrySink,
            });
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 32,
            };
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: {
                        layout: {
                            height: 682,
                            width: 400,
                        },
                    },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 9431, { turns: 1 });
            await triggerFlashListChatListScroll(
                4440.666666666667,
                {
                    contentSize: { height: 9153 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 8019, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            await triggerFlashListChatListScroll(
                3028.6666666666665,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                7059,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                3028.6666666666665,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({ turns: 2 });

            const autoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(autoFollowReasons).toEqual([]);
            expect(autoFollowReasons).not.toEqual(expect.arrayContaining([
                'content-size-change',
                'initial-open',
                'layout-change',
                'passive-drift',
            ]));
            expect(scrollToOffset).not.toHaveBeenCalled();

            const automaticNativeWrites = telemetrySink.mock.calls
                .map(([event]) => event)
                .filter((event) =>
                    event.type === 'scroll-write' &&
                    event.writer === 'native-scroll-to-offset' &&
                    ['content-size-change', 'initial-open', 'mount-settle', 'passive-drift', 'stream-append'].includes(event.reason)
                );
            expect(automaticNativeWrites).toEqual([]);
        });
    });

    it('cancels a delayed native mount-settle retry when bottom is observed before the throttle fires', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 667.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 12415, { turns: 1 });
            await triggerFlashListChatListScroll(
                6078.666666666667,
                {
                    contentSize: { height: 12283 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 10336, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                1,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).not.toHaveBeenCalled();
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                9537.333333333334,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: syncTuningState.transcriptMountSettleQuiescentWindowMs + 1,
                turns: 2,
            });
            await screen.update(<ChatList session={{ ...sessionState }} />);
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                4000,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );

            await triggerFlashListChatListScroll(
                9537.333333333334,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await screen.settle({ turns: 2 });

            await act(async () => {
                vi.advanceTimersByTime(201);
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('does not replay delayed native mount-settle after visual bottom is observed with native content metrics', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 727.6190795898438, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 2675, { turns: 1 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({
                advanceTimersMs: syncTuningState.transcriptMountSettleQuiescentWindowMs + 1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                1817.5238037109375,
                {
                    contentSize: { height: 2545 },
                    layoutMeasurement: { height: 727 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 2680, { turns: 1 });
            await triggerFlashListChatListScroll(
                1820.1904296875,
                {
                    contentSize: { height: 2547 },
                    layoutMeasurement: { height: 727 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('cancels a queued native mount-settle retry when bottom is observed before the microtask runs', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).not.toHaveBeenCalled();
            scrollToOffset.mockClear();

            await act(async () => {
                const props = getCapturedFlashListProps();
                props.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 300 },
                        contentSize: { height: 1200 },
                        layoutMeasurement: { height: 600 },
                    },
                });
                props.onScroll?.({
                    nativeEvent: {
                        contentOffset: { y: 600 },
                        contentSize: { height: 1200 },
                        layoutMeasurement: { height: 600 },
                    },
                });
            });
            await screen.settle({ turns: 2 });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('treats clamped native bottom observations as confirming pending mount-settle pins', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 682.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 942, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                133,
                {
                    contentSize: { height: 815 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                12,
                {
                    contentSize: { height: 815 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                133,
                {
                    contentSize: { height: 815 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({ turns: 2 });

            vi.advanceTimersByTime(201);
            await Promise.resolve();
            await Promise.resolve();

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('does not run a delayed native mount-settle retry after same-session jumpToSeq starts', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 667.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 12415, { turns: 1 });
            await triggerFlashListChatListScroll(
                6078.666666666667,
                {
                    contentSize: { height: 12283 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 10336, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                1,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).not.toHaveBeenCalled();
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                9537.333333333334,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: syncTuningState.transcriptMountSettleQuiescentWindowMs + 1,
                turns: 2,
            });
            await screen.update(<ChatList session={{ ...sessionState }} />);
            scrollToOffset.mockClear();

            await triggerFlashListChatListScroll(
                4000,
                {
                    contentSize: { height: 10204 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );

            await act(async () => {
                screen.tree.update(<ChatList session={{ ...sessionState }} jumpToSeq={1} />);
            });
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('shows native first-paint placeholder when row-shell measurements are warm on a cold remount', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const cold = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(countExactTestId(cold, 'transcript-first-paint-placeholder')).toBe(1);

        await fireTranscriptItemShellLayout(findTranscriptItemShell(cold, 'a1'), 148);
        unmountTrackedFlashListChatList(cold);

        const warm = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(readStyleMinHeight(findTranscriptItemShell(warm, 'a1').props.style)).toBe(148);
        expect(countExactTestId(warm, 'transcript-first-paint-placeholder')).toBe(1);
    });

    it('lets a warm keep-alive instance bypass a pending native viewport observation', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(
            <ChatList session={{ ...sessionState }} isWarmKeepAliveInstance={true} />,
        );

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
    });

    it('omits first-paint placeholder for web FlashList', async () => {
        runtimeMockState.platformOs = 'web';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
    });

    it('records web first and stable paint telemetry from dimensions when FlashList onLoad does not refire', async () => {
        runtimeMockState.platformOs = 'web';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        await primeFlashListMetrics(640, 1600, { turns: 2 });
        await screen.settle({ turns: 2 });

        const events = syncPerformanceTelemetry.snapshot().events;
        const firstPaintEvent = events.find((event) => event.name === 'ui.sessions.transcript.firstPaint');
        const stablePaintEvent = events.find((event) => event.name === 'ui.sessions.transcript.stablePaint');

        expect(firstPaintEvent?.fields).toMatchObject({
            committedMessages: 1,
            items: 1,
            native: 0,
            web: 1,
        });
        expect(stablePaintEvent?.fields).toMatchObject({
            committedMessages: 1,
            contentHeight: 1600,
            distanceFromBottom: 0,
            firstListPaintObserved: 1,
            items: 1,
            layoutHeight: 640,
            native: 0,
            web: 1,
        });

        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('records web first and stable paint telemetry from DOM metrics when FlashList dimensions are absent', async () => {
        runtimeMockState.platformOs = 'web';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };
        const scrollEl: any = {
            scrollHeight: 1600,
            clientHeight: 640,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 960,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle({ turns: 3 });
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );

        const events = syncPerformanceTelemetry.snapshot().events;
        const firstPaintEvent = events.find((event) => event.name === 'ui.sessions.transcript.firstPaint');
        const stablePaintEvent = events.find((event) => event.name === 'ui.sessions.transcript.stablePaint');

        expect(firstPaintEvent?.fields).toMatchObject({
            committedMessages: 1,
            items: 1,
            native: 0,
            web: 1,
        });
        expect(stablePaintEvent?.fields).toMatchObject({
            committedMessages: 1,
            contentHeight: 1600,
            distanceFromBottom: 0,
            firstListPaintObserved: 1,
            items: 1,
            layoutHeight: 640,
            native: 0,
            web: 1,
        });

        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('does not retry web stable paint while telemetry is disabled', async () => {
        await withWebFlashListFakeTimers(1_000, async () => {
            runtimeMockState.platformOs = 'web';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };
            let currentScrollTop = 0;
            const scrollEl: any = {
                scrollHeight: 1600,
                clientHeight: 640,
                scrollWidth: 0,
                clientWidth: 0,
                querySelectorAll: () => [],
                parentElement: null,
                contains: () => false,
                isConnected: true,
            };
            Object.defineProperty(scrollEl, 'scrollTop', {
                get: () => currentScrollTop,
                set: (_value: number) => {},
            });
            const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(640, 1600, { turns: 1 });
                    await screen.settle({ turns: 2 });

                    const renderCountAfterInitialPaint = renderedFlashListCount;

                    await screen.settle({ advanceTimersMs: 80, cycles: 1, turns: 2 });

                    expect(renderedFlashListCount).toBe(renderCountAfterInitialPaint);
                    expect(syncPerformanceTelemetry.snapshot().events).toEqual([]);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            );
        });
    });

    it('does not retry web stable paint after telemetry is already recorded', async () => {
        await withWebFlashListFakeTimers(1_000, async () => {
            runtimeMockState.platformOs = 'web';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };
            let currentScrollTop = 960;
            const scrollEl: any = {
                scrollHeight: 1600,
                clientHeight: 640,
                scrollWidth: 0,
                clientWidth: 0,
                querySelectorAll: () => [],
                parentElement: null,
                contains: () => false,
                isConnected: true,
            };
            Object.defineProperty(scrollEl, 'scrollTop', {
                get: () => currentScrollTop,
                set: (value: number) => {
                    currentScrollTop = value;
                },
            });
            const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
            syncPerformanceTelemetry.configure({
                enabled: true,
                slowThresholdMs: 1_000_000,
                flushIntervalMs: 60_000,
            });
            syncPerformanceTelemetry.reset();

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle({ turns: 3 });

                    expect(syncPerformanceTelemetry
                        .snapshot()
                        .events.some((event) => event.name === 'ui.sessions.transcript.stablePaint')).toBe(true);

                    scrollEl.clientHeight = 0;
                    scrollEl.scrollHeight = 0;
                    sessionState = { ...sessionState, seq: 2 };
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                            { kind: 'user-text', id: 'u2', localId: null, createdAt: 2, text: 'again' },
                        ],
                    };
                    await screen.update(<ChatList session={{ ...sessionState }} />);
                    await screen.settle({ turns: 2 });

                    const renderCountAfterRecordedAwayRender = renderedFlashListCount;

                    await screen.settle({ advanceTimersMs: 80, cycles: 1, turns: 2 });

                    expect(renderedFlashListCount).toBe(renderCountAfterRecordedAwayRender);
                    expect(syncPerformanceTelemetry
                        .snapshot()
                        .events.filter((event) => event.name === 'ui.sessions.transcript.stablePaint')).toHaveLength(1);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            );

            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        });
    });

    it('waits for web follow-bottom distance before recording stable paint telemetry', async () => {
        await withWebFlashListFakeTimers(1_000, async () => {
            runtimeMockState.platformOs = 'web';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };
            let currentScrollTop = 0;
            let allowScrollWrites = false;
            const scrollEl: any = {
                scrollHeight: 1600,
                clientHeight: 640,
                scrollWidth: 0,
                clientWidth: 0,
                querySelectorAll: () => [],
                parentElement: null,
                contains: () => false,
                isConnected: true,
            };
            Object.defineProperty(scrollEl, 'scrollTop', {
                get: () => currentScrollTop,
                set: (value: number) => {
                    if (allowScrollWrites) {
                        currentScrollTop = value;
                    }
                },
            });
            const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
            syncPerformanceTelemetry.configure({
                enabled: true,
                slowThresholdMs: 1_000_000,
                flushIntervalMs: 60_000,
            });
            syncPerformanceTelemetry.reset();

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(640, 1600, { turns: 1 });
                    await screen.settle({ turns: 2 });

                    expect(syncPerformanceTelemetry
                        .snapshot()
                        .events.some((event) => event.name === 'ui.sessions.transcript.firstPaint')).toBe(true);
                    expect(syncPerformanceTelemetry
                        .snapshot()
                        .events.some((event) => event.name === 'ui.sessions.transcript.stablePaint')).toBe(false);

                    allowScrollWrites = true;
                    scrollEl.scrollTop = 960;
                    await screen.settle({ advanceTimersMs: 40, cycles: 1, turns: 2 });
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            );

            const stablePaintEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((event) => event.name === 'ui.sessions.transcript.stablePaint');

            expect(stablePaintEvent?.fields).toMatchObject({
                committedMessages: 1,
                contentHeight: 1600,
                distanceFromBottom: 0,
                firstListPaintObserved: 1,
                layoutHeight: 640,
                native: 0,
                web: 1,
            });

            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        });
    });

    it('keeps the web Markdown runtime placeholder after list paint until the runtime becomes ready', async () => {
        runtimeMockState.platformOs = 'web';
        markdownRuntimeMockState.ready = false;
        let resolvePreload: (() => void) | null = null;
        const preloadPromise = new Promise<void>((resolve) => {
            resolvePreload = () => {
                setMarkdownRuntimeReady(true);
                resolve();
            };
        });
        markdownRuntimeMockState.preload.mockImplementation(() => preloadPromise);
        sessionMessagesState = {
            isLoaded: true,
            messages: [{
                kind: 'agent-text',
                id: 'a1',
                localId: null,
                createdAt: 1,
                text: '## Forensics\n\n`session-id` details',
            }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

        await triggerFlashListChatListLoad(12, { turns: 1 });
        await screen.settle({ turns: 1 });

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

        expect(resolvePreload).not.toBeNull();
        await act(async () => {
            resolvePreload?.();
        });
        await screen.settle({ turns: 1 });

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
    });

    it('keeps the web Markdown runtime placeholder while pending when FlashList onLoad is silent', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'web';
            markdownRuntimeMockState.ready = false;
            const preloadPromise = new Promise<void>(() => {});
            markdownRuntimeMockState.preload.mockImplementation(() => preloadPromise);
            const scrollEl: any = {
                scrollHeight: 0,
                clientHeight: 0,
                scrollWidth: 0,
                clientWidth: 0,
                scrollTop: 0,
                querySelectorAll: () => [],
                parentElement: null,
                contains: () => false,
                isConnected: true,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{
                    kind: 'agent-text',
                    id: 'a1',
                    localId: null,
                    createdAt: 1,
                    text: '## Forensics\n\n`session-id` details',
                }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                    expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

                    scrollEl.scrollHeight = 1600;
                    scrollEl.clientHeight = 640;
                    scrollEl.scrollTop = 960;
                    await primeFlashListMetrics(640, 1600, { turns: 1 });
                    await screen.settle({ turns: 3, advanceTimersMs: 32, cycles: 1 });

                    expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            );
        });
    });

    it('keeps web transcripts covered while cached session route hydration is pending', async () => {
        runtimeMockState.platformOs = 'web';
        markdownRuntimeMockState.ready = true;
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'cached reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(
            <ChatList session={{ ...sessionState }} routeHydrationPending={true} />,
        );

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

        await act(async () => {
            screen.tree.update(
                <ChatList session={{ ...sessionState }} routeHydrationPending={false} />,
            );
        });
        await screen.settle({ turns: 1 });

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
    });

    it('uses a skeleton-only first-paint placeholder when motion is allowed', async () => {
        runtimeMockState.platformOs = 'ios';
        reducedMotionMockState.preferred = false;
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);
        expect(countAnyTestId(screen, 'transcript-first-paint-placeholder:spinner')).toBe(0);
    });

    it('centers first-paint placeholder rows inside the transcript content width', async () => {
        runtimeMockState.platformOs = 'ios';
        reducedMotionMockState.preferred = false;
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        const rows = screen.findByTestId('transcript-first-paint-placeholder:rows') as {
            props?: { style?: unknown };
        };

        expect(readStyleProp(rows.props?.style, 'width')).toBe('100%');
        expect(readStyleProp(rows.props?.style, 'alignSelf')).toBe('center');
        expect(readStyleProp(rows.props?.style, 'maxWidth')).toEqual(expect.any(Number));
    });

    it('uses static first-paint placeholder for reduced motion', async () => {
        runtimeMockState.platformOs = 'ios';
        reducedMotionMockState.preferred = true;
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);
        expect(countAnyTestId(screen, 'transcript-first-paint-placeholder:spinner')).toBe(0);
    });

    it('keeps the cached measured row-shell minHeight applied after layout (sticky adopt-on-measure)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const first = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await fireTranscriptItemShellLayout(findTranscriptItemShell(first, 'a1'), 148);
        unmountTrackedFlashListChatList(first);

        const second = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        const secondShell = findTranscriptItemShell(second, 'a1');

        expect(readStyleMinHeight(secondShell.props.style)).toBe(148);
        expect(second.getCapturedFlashListProps().estimatedItemSize).toBeUndefined();
        expect(second.getCapturedFlashListProps().overrideItemLayout).toBeUndefined();

        // N2a.2 sticky measured heights: the adopted measured hint is never released after
        // layout (the apply-then-release path is gone); a larger measurement is adopted into
        // the cache and becomes the authoritative hint on the next mount.
        await fireTranscriptItemShellLayout(secondShell, 172);
        await second.settle({ turns: 1 });

        expect(readStyleMinHeight(findTranscriptItemShell(second, 'a1').props.style)).toBe(148);
        unmountTrackedFlashListChatList(second);

        const third = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(readStyleMinHeight(findTranscriptItemShell(third, 'a1').props.style)).toBe(172);
    });

    it('keys cached row-shell heights by transcript layout width bucket', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const narrow = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await triggerFlashListChatListInitialFill({
            contentHeight: 1200,
            layoutHeight: 600,
            layoutWidth: 320,
            flushOptions: { turns: 1 },
        });
        await fireTranscriptItemShellLayout(findTranscriptItemShell(narrow, 'a1'), 148);
        unmountTrackedFlashListChatList(narrow);

        const wide = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await triggerFlashListChatListInitialFill({
            contentHeight: 1200,
            layoutHeight: 600,
            layoutWidth: 768,
            flushOptions: { turns: 1 },
        });

        expect(readStyleMinHeight(findTranscriptItemShell(wide, 'a1').props.style)).toBeUndefined();
        unmountTrackedFlashListChatList(wide);

        const narrowAgain = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await triggerFlashListChatListInitialFill({
            contentHeight: 1200,
            layoutHeight: 600,
            layoutWidth: 320,
            flushOptions: { turns: 1 },
        });

        expect(readStyleMinHeight(findTranscriptItemShell(narrowAgain, 'a1').props.style)).toBe(148);
    });

    it('does not cache active streaming rows as stable row-shell heights', async () => {
        sessionState = {
            ...sessionState,
            active: true,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'streaming reply' }],
        };

        const { ChatList } = await import('./ChatList');
        const first = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await fireTranscriptItemShellLayout(findTranscriptItemShell(first, 'a1'), 180);
        unmountTrackedFlashListChatList(first);

        const second = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        // An active streaming row's measured height is never persisted to the cross-mount STABLE cache.
        // On a fresh mount it carries at most the small first-frame floor (issue #2) — never the stale
        // measured 180, which would mis-reserve a row whose new content differs.
        const reserved = readStyleMinHeight(findTranscriptItemShell(second, 'a1').props.style);
        expect(reserved === undefined || reserved < 180).toBe(true);
    });

    it('does not cache running tool-call rows as stable row-shell heights when they are not latest activity', async () => {
        sessionState = {
            ...sessionState,
            active: true,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                {
                    kind: 'tool-call',
                    id: 'tool-1',
                    localId: null,
                    createdAt: 1,
                    seq: 1,
                    tool: { id: 'tool-1', name: 'shell', state: 'running', input: { command: 'pwd' } },
                },
                { kind: 'agent-text', id: 'a-latest', localId: null, createdAt: 2, seq: 2, text: 'still working' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        const first = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await fireTranscriptItemShellLayout(findTranscriptItemShell(first, 'tool-1'), 220);
        unmountTrackedFlashListChatList(first);

        const second = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(readStyleMinHeight(findTranscriptItemShell(second, 'tool-1').props.style)).toBeUndefined();
    });

    it('reuses module-level linear derived items on cold A-to-B-to-A remounts', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'a-user', localId: null, createdAt: 1, text: 'session a' }],
        };

        const { ChatList } = await import('./ChatList');
        const firstA = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);
        unmountTrackedFlashListChatList(firstA);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'b-user', localId: null, createdAt: 1, text: 'session b' }],
        };
        const firstB = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-b' }} />);
        unmountTrackedFlashListChatList(firstB);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'a-user', localId: null, createdAt: 1, text: 'session a' }],
        };
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);

        expect(linearItemsCacheBuildCalls.at(-1)).toMatchObject({
            cacheProvided: true,
            cacheHit: true,
        });
    });

    it('reuses module-level turn derived items on cold A-to-B-to-A remounts', async () => {
        settingValues.transcriptGroupingMode = 'turns';
        const sessionATurn = { id: 'turn:a', userMessageId: 'a-user', content: [{ kind: 'message', messageId: 'a-user' }] };
        const sessionBTurn = { id: 'turn:b', userMessageId: 'b-user', content: [{ kind: 'message', messageId: 'b-user' }] };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'a-user', localId: null, createdAt: 1, text: 'session a' }],
        };
        transcriptTurnsState = [sessionATurn];

        const { ChatList } = await import('./ChatList');
        const firstA = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);
        unmountTrackedFlashListChatList(firstA);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'b-user', localId: null, createdAt: 1, text: 'session b' }],
        };
        transcriptTurnsState = [sessionBTurn];
        const firstB = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-b' }} />);
        unmountTrackedFlashListChatList(firstB);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'a-user', localId: null, createdAt: 1, text: 'session a' }],
        };
        transcriptTurnsState = [sessionATurn];
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);

        expect(turnsCacheBuildCalls.at(-1)).toMatchObject({
            cacheProvided: true,
            cacheHit: true,
        });
    });

    it('invalidates module-level linear derived items when a session structure changes', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'before' }],
        };

        const { ChatList } = await import('./ChatList');
        const first = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);
        unmountTrackedFlashListChatList(first);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'after' }],
        };
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-a' }} />);

        expect(linearItemsCacheBuildCalls).toEqual(expect.arrayContaining([expect.objectContaining({
            cacheProvided: true,
            cacheHit: false,
        })]));
    });

    it('uses bounded coarse FlashList item types for divergent transcript row shapes', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u-short', localId: null, createdAt: 1, text: 'short' },
                { kind: 'user-text', id: 'u-long', localId: null, createdAt: 2, text: 'long '.repeat(120) },
                { kind: 'agent-text', id: 'a-short', localId: null, createdAt: 3, text: 'short reply' },
                { kind: 'agent-text', id: 'a-long', localId: null, createdAt: 4, text: 'long reply '.repeat(120) },
                { kind: 'agent-text', id: 'a-thinking', localId: null, createdAt: 5, text: 'thinking', isThinking: true },
                { kind: 'tool-call', id: 'tool-1', localId: null, createdAt: 6, tool: { name: 'shell' }, children: [] },
            ],
        };
        transcriptTurnsState = [{
            id: 'turn:tool',
            userMessageId: 'u-short',
            content: [{ kind: 'tool_calls', id: 'turn-tool-group', toolMessageIds: ['tool-1'] }],
        }];

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        const getItemType = screen.getCapturedFlashListProps().getItemType;

        expect(typeof getItemType).toBe('function');

        const samples = [
            { kind: 'message', id: 'u-short', messageId: 'u-short', createdAt: 1, seq: null },
            { kind: 'message', id: 'u-long', messageId: 'u-long', createdAt: 2, seq: null },
            { kind: 'message', id: 'a-short', messageId: 'a-short', createdAt: 3, seq: null },
            { kind: 'message', id: 'a-long', messageId: 'a-long', createdAt: 4, seq: null },
            { kind: 'message', id: 'a-thinking', messageId: 'a-thinking', createdAt: 5, seq: null },
            { kind: 'message', id: 'tool-1', messageId: 'tool-1', createdAt: 6, seq: null },
            { kind: 'tool-calls-group', id: 'toolCalls:linear:tool-1', toolMessageIds: ['tool-1'], createdAt: 6 },
            { kind: 'turn', id: 'turn:tool', turn: transcriptTurnsState[0] },
            { kind: 'pending-queue', id: 'pending-queue', pendingMessages: [{}], discardedMessages: [] },
            { kind: 'action-draft', id: 'draft:1', draft: { id: 'draft-1' } },
            { kind: 'fork-divider', id: 'fork:1', parentSessionId: 'parent', childSessionId: 'child', parentCutoffSeqInclusive: 2 },
        ];
        const types = samples.map((sample, index) => getItemType(sample, index));

        // C1 (T2): the recycle type is SHAPE-only, never SIZE-based. A row keeps one stable type as
        // its text streams (no mid-stream remount), so short/long collapse to a single type.
        expect(types[0]).toBe(types[1]); // user-text: size-stable
        expect(types[2]).toBe(types[3]); // agent-text: size-stable
        // Genuinely distinct shapes still get distinct recycle types.
        expect(types[0]).not.toBe(types[2]); // user vs agent
        expect(types[4]).not.toBe(types[2]); // thinking is a distinct shell shape
        expect(types[5]).not.toBe(types[2]); // tool message vs agent text
        expect(types[6]).not.toBe(types[5]); // tool-calls-group vs tool message
        expect(types[10]).not.toBe(types[9]); // fork-divider vs action-draft
        expect(new Set(types).size).toBeLessThanOrEqual(12);
    });

    it('loads older messages when scrolled near the top (without requiring onStartReached)', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 256,
        };

        const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        getCapturedFlashListProps();
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await primeFlashListMetrics(600, 1200, { turns: 1 });
        await scrollFlashListTo(100);

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    });

    it('uses live web scroll metrics without reading React Native Web contentOffset getters', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 100,
            testId: 'transcript-chat-list',
        });
        let contentOffsetYReadCount = 0;
        const contentOffset = {};
        Object.defineProperty(contentOffset, 'y', {
            configurable: true,
            get: () => {
                contentOffsetYReadCount += 1;
                return 100;
            },
        });

        const { ChatList } = await import('./ChatList');
        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await act(async () => {
                    screen.getCapturedFlashListProps().onScroll?.({
                        nativeEvent: { contentOffset, isTrusted: true },
                    });
                });
                await screen.settle({ turns: 1 });
            },
            { initialFill: { layoutHeight: 600, contentHeight: 1200, flushOptions: { turns: 1 } } },
        );

        expect(contentOffsetYReadCount).toBe(0);
    });

    it('does not scan web transcript anchors for disabled viewport telemetry diagnostics', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptViewportTelemetryEnabled: false,
        };
        const anchor = createFlashListChatListWebElement('transcript-item-u1', { top: 10, bottom: 40 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 100,
            testId: 'transcript-chat-list',
            testNodes: [anchor],
        });
        const querySelectorAll = vi.spyOn(scrollEl, 'querySelectorAll');

        const { ChatList } = await import('./ChatList');
        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await act(async () => {
                    screen.getCapturedFlashListProps().onScroll?.({
                        nativeEvent: { target: scrollEl, isTrusted: true },
                    });
                });
                await screen.settle({ turns: 1 });
            },
            { initialFill: { layoutHeight: 600, contentHeight: 1200, flushOptions: { turns: 1 } } },
        );

        expect(querySelectorAll).not.toHaveBeenCalledWith('[data-testid]');
    });

    it('keeps web viewport diagnostics without scanning rendered row test ids', async () => {
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 32,
            sink: telemetrySink,
        });
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 32,
        };
        const anchor = createFlashListChatListWebElement('transcript-item-u1', { top: 10, bottom: 40 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 100,
            testId: 'transcript-chat-list',
            testNodes: [anchor],
        });
        const querySelectorAll = vi.spyOn(scrollEl, 'querySelectorAll');

        const { ChatList } = await import('./ChatList');
        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                telemetrySink.mockClear();
                await act(async () => {
                    screen.getCapturedFlashListProps().onScroll?.({
                        nativeEvent: { target: scrollEl, isTrusted: true },
                    });
                });
                await screen.settle({ turns: 1 });
            },
            { initialFill: { layoutHeight: 600, contentHeight: 1200, flushOptions: { turns: 1 } } },
        );

        expect(querySelectorAll).not.toHaveBeenCalledWith('[data-testid]');
        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-observed',
            domScrollTop: 600,
            domScrollHeight: 1200,
            domClientHeight: 600,
        }));
    });

    it('loads older from an exact web edge using live DOM metrics when FlashList height is stale', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 2000,
            scrollTop: 0,
            testId: 'transcript-chat-list',
        });

        const { ChatList } = await import('./ChatList');
        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await triggerFlashListChatListInitialFill({
                    layoutHeight: 600,
                    contentHeight: 600,
                    flushOptions: { turns: 1 },
                });
                scrollEl.scrollTop = 0;

                await act(async () => {
                    screen.getCapturedFlashListProps().onScroll?.({
                        nativeEvent: { target: scrollEl, isTrusted: true },
                    });
                });
                await screen.settle({ turns: 1 });
                // A genuine-top web frame (live DOM scrollTop === 0) is classified 'edge-reached',
                // so the older page loads from the scroll observation itself — it no longer waits
                // for the FlashList onStartReached nudge.
                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                // The redundant onStartReached edge nudge does not double-load within the cooldown.
                await triggerFlashListChatListStartReached({ turns: 1 });
            },
            {
                dom: {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    HTMLElement: FlashListChatListWebElement,
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
                initialFill: false,
            },
        );

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    });

    it('requires a threshold exit and re-entry before chaining another older-page prefetch (anti-burst)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadCooldownMs: 2500,
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1800, { turns: 1 });
            await scrollFlashListTo(100, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // Parked inside the threshold: neither further scrolls nor the cooldown elapsing
            // chain another load (E6 anti-burst).
            await vi.advanceTimersByTimeAsync(500);
            await scrollFlashListTo(90, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await scrollFlashListTo(80, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // An observed threshold exit -> re-enter re-arms exactly one more load.
            await scrollFlashListTo(900, { turns: 1 });
            await scrollFlashListTo(100, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(2);

            // Leaving the threshold again does not load on the cooldown alone.
            await scrollFlashListTo(900, { turns: 1 });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(2);
        });
    });

    it('re-arms a parked-inside web viewport from a genuine-top frame after cooldown (edge-reached classification)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadCooldownMs: 2500,
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1800, { turns: 1 });

            // Park inside the threshold (a tall top row keeps the offset off zero): one load fires.
            await scrollFlashListTo(100, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // Cooldown elapses while still parked inside, with NO observed threshold exit.
            // A further mid-band scroll must NOT chain another load (anti-burst).
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await scrollFlashListTo(80, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // Reaching the genuine top (offset 0) is classified 'edge-reached', which satisfies the
            // machine's exact-edge re-arm and loads exactly one more older page — independent of any
            // threshold exit and of the top row's kind/height.
            await scrollFlashListTo(0, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(2);

            // A mid-band frame after the genuine-top re-arm still does not widen the band: no extra load
            // without a fresh exit -> re-enter or another genuine-top frame.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await scrollFlashListTo(120, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(2);
        });
    });

    it('re-arms a parked-inside web viewport from a near-top fractional frame after cooldown (EPSILON classification)', async () => {
        // EPSILON secondary cause: the web scroll element reports `scrollTop` as an integer-rounded
        // (dpr=1) or sub-pixel-residue (Retina) value, so a viewport resting at the genuine top is
        // rarely EXACTLY 0 — it commonly settles at ~1. The pre-EPSILON classifier required
        // `effectiveScrollOffset === 0`, so a near-top frame (offset 1) was misclassified 'scroll',
        // the machine suspended it, and the parked-inside viewport never re-armed. With the
        // genuine-top epsilon, the same near-top frame classifies 'edge-reached' and re-arms.
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadCooldownMs: 2500,
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1800, { turns: 1 });

            // Park inside the threshold (a tall top row keeps the offset off zero): one load fires.
            await scrollFlashListTo(100, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // Cooldown elapses while still parked inside, with NO observed threshold exit.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await scrollFlashListTo(80, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // Reaching the genuine top reports a near-top fractional offset (1), NOT exactly 0. The
            // EPSILON classifier marks it 'edge-reached', satisfying the machine's exact-edge re-arm
            // and loading exactly one more older page. (Pre-EPSILON this stayed at 1.)
            await scrollFlashListTo(1, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(2);

            // A frame just past the epsilon band (mid-band) after the re-arm does not widen the band:
            // no extra load without a fresh exit -> re-enter or another genuine-top frame.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await scrollFlashListTo(120, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(2);
        });
    });

    it('renders the §13 catch-up overlay whenever catching up, regardless of pin state', async () => {
        // §13 wiring gate: `useSessionCatchingUpNewer(sessionId)` with NO pin gate. The signal is
        // catch-up-only (resume / deferred-newer drain / socket-reconnect bracket it in sync; normal
        // realtime live streaming never does), so it cannot nag during ordinary pinned streaming.
        // Reopening a background-working session restores the user PINNED at the live tail while sync
        // silently catches up — exactly the scenario the overlay exists for — so a `!isPinned` gate
        // would suppress it in its primary case. The overlay therefore shows whenever the signal is
        // true, pinned or not.
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };
        syncTuningState = { ...syncTuningState, transcriptOlderLoadSpinnerDelayMs: 0 };

        const sessionId = sessionState.id;

        // Case 1: catching up AND pinned-following the live tail (reopen of an actively-working
        // session) -> overlay SHOWN. The pin must NOT suppress the catch-up surface.
        catchingUpNewerState = true;
        sessionViewportByIdState.set(sessionId, {
            isPinned: true,
            offsetY: 0,
            anchor: null,
            lastUpdatedAt: Date.now(),
            source: 'observed',
        });
        const { ChatList } = await import('./ChatList');
        const pinnedScreen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(600, 1800, { turns: 1 });
        expect(pinnedScreen.findByTestId('transcript-catch-up-progress-overlay')).toBeTruthy();

        // Case 2: catching up AND unpinned (scrolled-up reopen/resume) -> overlay shown.
        catchingUpNewerState = true;
        sessionViewportByIdState.set(sessionId, {
            isPinned: false,
            offsetY: 400,
            anchor: null,
            lastUpdatedAt: Date.now(),
            source: 'observed',
        });
        const unpinnedScreen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(600, 1800, { turns: 1 });
        expect(unpinnedScreen.findByTestId('transcript-catch-up-progress-overlay')).toBeTruthy();

        // Case 3: NOT catching up -> overlay hidden (idle), regardless of pin state. Confirms the
        // signal — not the pin — is the sole gate (spinner-delay is set to 0 so a true signal would
        // surface immediately).
        catchingUpNewerState = false;
        const idleScreen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(600, 1800, { turns: 1 });
        expect(idleScreen.findByTestId('transcript-catch-up-progress-overlay')).toBeNull();
    });

    it('re-arms older-load from a genuine-top frame when the TOP row is a tool group (row-kind-independent)', async () => {
        // Regression for the user's exact scenario: the genuine-top re-arm must not depend on the
        // top visible row being a simple message. A tall tool-calls-group at the top keeps the
        // viewport parked inside the threshold (the offset never settles to zero until the genuine
        // top is reached) and `onStartReached` does NOT fire. The continuous web scroll observation,
        // classifying the genuine-top frame (scrollTop 0) as 'edge-reached', must still re-arm the
        // machine — proving the fix is row-kind-independent.
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            settingValues.transcriptGroupingMode = 'linear';
            settingValues.transcriptGroupToolCalls = true;
            settingValues.toolViewTimelineChromeMode = 'activity_feed';
            // Oldest-first: a tool-call lands at the top, so the first (top) list item is a tool group.
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'tool-call', id: 'tool-top', localId: null, createdAt: 1, seq: 1, tool: { name: 'shell' }, children: [] },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'reply' },
                ],
            };

            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadCooldownMs: 2500,
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1800, { turns: 1 });

            // The TOP (oldest, first) visible row is a tool group, not a message — this is the load-
            // bearing fixture difference from the simple-message genuine-top test.
            const topItem = getCapturedFlashListProps().data?.[0];
            expect(typeof topItem?.kind).toBe('string');
            expect(topItem.kind).toMatch(/^tool-/);

            // The redundant onStartReached edge callback is never invoked in this flow; the scroll path
            // alone must re-arm. Assert it stays untouched so the load below is attributable to the
            // genuine-top scroll classification, not the edge callback.
            const onStartReachedSpy = vi.fn(getCapturedFlashListProps().onStartReached);

            // Park inside the threshold (the tall tool group keeps the offset off zero): one load fires.
            await scrollFlashListTo(100, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // Cooldown elapses while parked inside, with NO observed threshold exit; a mid-band scroll
            // must NOT chain another load (anti-burst).
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2500);
            });
            await scrollFlashListTo(80, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // Reaching the genuine top (scrollTop 0) re-arms via the 'edge-reached' classification and
            // loads exactly one more older page — even though the top row is a tool group and
            // onStartReached never fired.
            await scrollFlashListTo(0, { turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(2);
            expect(onStartReachedSpy).not.toHaveBeenCalled();
        });
    });

    it('loads older messages near the top even when onScroll is not marked isTrusted (web)', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

        const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        getCapturedFlashListProps();

        await primeFlashListMetrics(600, 1200, { turns: 1 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await scrollFlashListTo(100, { trusted: false });

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    });

    it('keeps web older-page loading on the default sync page path even when a native page limit is configured', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptNativeOlderMessagesPageSize: 37,
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(600, 1200, { turns: 1 });
        await scrollFlashListTo(100, { trusted: false });

        expect(loadOlderMessagesMock).toHaveBeenCalledWith('session-1');
    });

    it('limits native older-page loads to the configured native page size', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 3 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(100)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index * 120,
                    width: 320,
                    height: 100,
                })),
            };
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
                transcriptNativeOlderMessagesPageSize: 37,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(500, 2000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ turns: 2 });
            loadOlderMessagesMock.mockClear();

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                    isTrusted: true,
                },
                { turns: 2 },
            );
            await triggerFlashListChatListScroll(
                100,
                {
                    contentSize: { height: 2000 },
                    layoutMeasurement: { height: 500 },
                    isTrusted: true,
                },
                { turns: 2 },
            );

            expect(loadOlderMessagesMock).toHaveBeenCalledWith('session-1', { limit: 37 });
        });
    });

    it('loads native older pages from untrusted iOS scroll events after drag intent reaches the top', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 3 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(100)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index * 120,
                    width: 320,
                    height: 100,
                })),
            };
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
                transcriptNativeOlderMessagesPageSize: 37,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(500, 6000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ turns: 2 });
            loadOlderMessagesMock.mockClear();

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            await triggerFlashListChatListScroll(
                3000,
                {
                    contentSize: { height: 6000 },
                    layoutMeasurement: { height: 500 },
                },
                { turns: 2 },
            );
            await triggerFlashListChatListScroll(
                100,
                {
                    contentSize: { height: 6000 },
                    layoutMeasurement: { height: 500 },
                },
                { turns: 2 },
            );

            expect(loadOlderMessagesMock).toHaveBeenCalledWith('session-1', { limit: 37 });
        });
    });

    it('does not prefetch older messages while pinned at the bottom even when the top threshold is large', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

        const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        await primeFlashListMetrics(600, 1200, { turns: 2, frames: 2 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await scrollFlashListTo(600);

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
    });

    it('keeps the older-load spinner hidden for fast proactive prefetch', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            let resolveLoadOlder: (value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void = () => {
                throw new Error('loadOlderMessages was not invoked');
            };
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadSpinnerDelayMs: 500,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await scrollFlashListTo(100);

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);

            await act(async () => {
                resolveLoadOlder({ loaded: 1, hasMore: true, status: 'loaded' });
            });
            await screen.settle({ turns: 2 });
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
        });
    });

    it('shows the older-load spinner when proactive prefetch is slow', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            let resolveLoadOlder: (value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void = () => {
                throw new Error('loadOlderMessages was not invoked');
            };
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadSpinnerDelayMs: 500,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await scrollFlashListTo(100);

            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);

            await screen.settle({ advanceTimersMs: 300, cycles: 1, turns: 1 });

            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);

            await screen.settle({ advanceTimersMs: 200, cycles: 1, turns: 1 });

            expect(countVisibleOlderLoadSpinners(screen)).toBeGreaterThan(0);

            await act(async () => {
                resolveLoadOlder({ loaded: 1, hasMore: false, status: 'loaded' });
            });
            await screen.settle({ turns: 2 });
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
        });
    });

    it('keeps older-load progress out of scrollable header geometry during prepend loading', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            let resolveLoadOlder: (value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void = () => {
                throw new Error('loadOlderMessages was not invoked');
            };
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadSpinnerDelayMs: 500,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            const headerBeforeLoad = screen.getCapturedFlashListProps().ListHeaderComponent;

            await scrollFlashListTo(100);
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            await screen.settle({ advanceTimersMs: 500, cycles: 1, turns: 1 });

            expect(countVisibleOlderLoadSpinners(screen)).toBeGreaterThan(0);
            expect(countExactTestId(screen, 'transcript-older-load-progress-overlay')).toBe(1);
            expect(screen.getCapturedFlashListProps().ListHeaderComponent).toBe(headerBeforeLoad);

            await act(async () => {
                resolveLoadOlder({ loaded: 1, hasMore: false, status: 'loaded' });
            });
            await screen.settle({ turns: 2 });

            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
            expect(countExactTestId(screen, 'transcript-older-load-progress-overlay')).toBe(0);
            expect(screen.getCapturedFlashListProps().ListHeaderComponent).toBe(headerBeforeLoad);
        });
    });

    it('shows the older-load spinner after the spinner delay while a user-triggered older load is in flight', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            let resolveLoadOlder: (value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void = () => {
                throw new Error('loadOlderMessages was not invoked');
            };
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();

            syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await scrollFlashListTo(100);

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);

            // Invariant H: the indicator becomes visible after the configured spinner delay
            // while the user-triggered load is still in flight.
            await screen.settle({ advanceTimersMs: 300, cycles: 1, turns: 1 });

            expect(countVisibleOlderLoadSpinners(screen)).toBeGreaterThan(0);

            await act(async () => {
                resolveLoadOlder({ loaded: 1, hasMore: false, status: 'loaded' });
            });
            await screen.settle({ turns: 2 });
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
        });
    });

    it('does not stall the web initial fill when requestAnimationFrame is starved (plan D5, evidence E10)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const originalRaf = (globalThis as any).requestAnimationFrame;
            // Background-tab starvation: rAF callbacks never fire.
            (globalThis as any).requestAnimationFrame = () => 1;
            try {
                const syncMod = await import('@/sync/sync');
                const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
                loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' as const });
                loadOlderMessagesMock.mockClear();
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
                };

                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                // Under-filled content: the fill loop must reach its loadOlder step even though
                // the rAF-backed visual-update wait never resolves (timer fallback races it).
                await primeFlashListMetrics(600, 100, { turns: 2 });
                await screen.settle({ advanceTimersMs: 251, cycles: 1, turns: 3 });

                expect(loadOlderMessagesMock).toHaveBeenCalled();
            } finally {
                (globalThis as any).requestAnimationFrame = originalRaf;
            }
        });
    });

    it('waits for web scroll metrics to settle before prefetching older messages during initial fill', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        const scrollEl: any = {
            scrollHeight: 100,
            clientHeight: 400,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 0,
            querySelectorAll: () => [],
            parentElement: null,
            isConnected: true,
        };

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                expect(capturedFlashListProps).toBeTruthy();

                scrollEl.scrollHeight = 1600;
                await triggerFlashListChatListInitialFill({
                    layoutHeight: 100,
                    contentHeight: 100,
                    flushOptions: { turns: 3 },
                });

                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                expect(screen.getCapturedFlashListProps()).toBeTruthy();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
                useImmediateAnimationFrame: false,
            },
        );
    });

    it('does not measure transcript navigation visibility when the web rail is hidden and no consumer is subscribed', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                {
                    kind: 'user-text',
                    id: 'u1',
                    localId: 'u1',
                    createdAt: 1,
                    text: 'Install dependencies',
                    seq: 7,
                    transcriptBlockIndex: 0,
                },
                {
                    kind: 'user-text',
                    id: 'u2',
                    localId: 'u2',
                    createdAt: 2,
                    text: 'Run tests',
                    seq: 12,
                    transcriptBlockIndex: 0,
                },
            ],
        };
        const visibleUserAnchor = createFlashListChatListWebElement(
            'transcript-anchor-message-u1',
            { top: 120, bottom: 180 },
        );
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 900,
            scrollTop: 100,
            testNodes: [visibleUserAnchor],
        });
        const querySelector = vi.spyOn(scrollEl, 'querySelector');
        const querySelectorAll = vi.spyOn(scrollEl, 'querySelectorAll');

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.triggerInitialFill({
                    layoutHeight: 400,
                    layoutWidth: 400,
                    contentHeight: 900,
                    flushOptions: { turns: 1 },
                });
                await scrollFlashListTo(100, { trusted: false, turns: 2 });

                expect(querySelector.mock.calls.some(([selector]) => String(selector).includes('transcript-anchor-message-'))).toBe(false);
                expect(querySelectorAll).not.toHaveBeenCalledWith(expect.stringContaining('transcript-anchor-message-'));
                expect(querySelectorAll).not.toHaveBeenCalledWith('[data-testid]');
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('ignores a web onStartReached misfire while the transcript is still pinned at the bottom', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1600,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 1000,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200, { turns: 1 });

                await scrollFlashListTo(600);

                loadOlderMessagesMock.mockClear();

                await triggerFlashListChatListStartReached();

                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('ignores a web onStartReached event outside the configured older prefetch threshold', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 60,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 40 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200, { turns: 1 });
                expect(getCapturedFlashListProps().onStartReachedThreshold).toBeCloseTo(40 / 600, 4);
                await scrollFlashListTo(60);

                loadOlderMessagesMock.mockClear();

                await triggerFlashListChatListStartReached();

                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('ignores web onStartReached when live scroll metrics are unavailable for prepend anchoring', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 40 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        getCapturedFlashListProps();

        await primeFlashListMetrics(600, 1200, { turns: 1 });
        await scrollFlashListTo(200, { trusted: true, turns: 1 });
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await triggerFlashListChatListStartReached({ turns: 1 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
        expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
    });

    it('ignores native onStartReached when native scroll metrics are unavailable for prepend anchoring', async () => {
        runtimeMockState.platformOs = 'ios';
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
        };
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 40 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        getCapturedFlashListProps();

        await primeFlashListMetrics(600, 1200, { turns: 1 });
        await scrollFlashListTo(200, { trusted: true, turns: 1 });
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await triggerFlashListChatListStartReached({ turns: 1 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
        expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
    });

    it('preserves the web viewport when older messages prepend above the current scroll position', async () => {
        const syncMod = await import('@/sync/sync');
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 16,
            sink: telemetrySink,
        });

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockImplementation(async () => {
            scrollEl.scrollHeight = 1800;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });
        loadOlderMessagesMock.mockClear();

        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 16,
        };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);

                scrollEl.scrollHeight = 1200;
                loadOlderMessagesMock.mockClear();

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 3 });

                expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
                expect(scrollEl.scrollTop).toBe(700);
                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    writer: 'web-dom-restore',
                    reason: 'prepend-restore',
                    mode: 'restore-anchor',
                    previousOffsetY: 100,
                    targetOffsetY: 700,
                    layoutHeight: 600,
                    contentHeight: 1800,
                }));
                // Plan E2: the web prepend window opens with a 'pending' restore decision at
                // capture and every restore outcome is telemetered. With no anchor rows in the
                // DOM, the growth fallback restored the viewport (mode 'restore-distance').
                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'restore-decision',
                    mode: 'restore-anchor',
                    reason: 'pending',
                }));
                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'restore-decision',
                    mode: 'restore-distance',
                    reason: 'restored',
                }));
                assertWebWregDiagnostics(telemetrySink.mock.calls.map(([event]) => event));
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('closes the web prepend owner when the restore window expires so older pages can load again', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

            const scrollEl: any = {
                scrollHeight: 1200,
                clientHeight: 600,
                scrollWidth: 0,
                clientWidth: 0,
                scrollTop: 600,
                querySelectorAll: () => [],
                parentElement: null,
                contains: () => false,
                isConnected: true,
            };

            loadOlderMessagesMock.mockImplementation(async () => {
                scrollEl.scrollHeight += 600;
                return { loaded: 5, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadCooldownMs: 20,
                transcriptWebInitialPinStabilizeMs: 20,
            };
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    getCapturedFlashListProps();

                    await primeFlashListMetrics(600, 1200);
                    scrollEl.scrollHeight = 1200;

                    // First exact-edge load opens the web prepend owner and restores by the
                    // growth fallback because the original anchor is virtualized out of the DOM.
                    scrollEl.scrollTop = 100;
                    await scrollFlashListTo(100, { turns: 3 });
                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
                    expect(scrollEl.scrollTop).toBe(700);

                    // Expire and dispose the restore window. Pagination must not stay suspended
                    // by a stale viewport owner after the pending anchor is cleared.
                    await vi.advanceTimersByTimeAsync(25);
                    await triggerFlashListChatListContentSizeChange(320, scrollEl.scrollHeight, {
                        turns: 3,
                        frames: 1,
                    });

                    scrollEl.scrollTop = 1000;
                    await scrollFlashListTo(1000, { turns: 1 });
                    await vi.advanceTimersByTimeAsync(25);
                    await screen.settle({ cycles: 1, turns: 2 });

                    scrollEl.scrollTop = 100;
                    await scrollFlashListTo(100, { turns: 3 });

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(2);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            );
        });
    });

    it('closes the web prepend owner on expiry even without a later layout callback', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

            const scrollEl: any = {
                scrollHeight: 1200,
                clientHeight: 600,
                scrollWidth: 0,
                clientWidth: 0,
                scrollTop: 600,
                querySelectorAll: () => [],
                parentElement: null,
                contains: () => false,
                isConnected: true,
            };

            loadOlderMessagesMock.mockImplementation(async () => {
                scrollEl.scrollHeight += 600;
                return { loaded: 5, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 800,
                transcriptOlderLoadCooldownMs: 20,
                transcriptWebInitialPinStabilizeMs: 20,
            };
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    getCapturedFlashListProps();

                    await primeFlashListMetrics(600, 1200);
                    scrollEl.scrollHeight = 1200;

                    scrollEl.scrollTop = 100;
                    await scrollFlashListTo(100, { turns: 3 });
                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
                    expect(scrollEl.scrollTop).toBe(700);

                    await vi.advanceTimersByTimeAsync(25);
                    await screen.settle({ cycles: 1, turns: 2 });

                    scrollEl.scrollTop = 1000;
                    await scrollFlashListTo(1000, { turns: 1 });
                    await vi.advanceTimersByTimeAsync(25);
                    await screen.settle({ cycles: 1, turns: 2 });

                    scrollEl.scrollTop = 100;
                    await scrollFlashListTo(100, { turns: 3 });

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(2);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            );
        });
    });

    it('reserves the web scroll range when prepend measurement temporarily shrinks content height', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockImplementation(async () => {
            scrollEl.scrollHeight = 900;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);
                scrollEl.scrollHeight = 1200;
                loadOlderMessagesMock.mockClear();

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 3 });

                expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
                const reserve = screen.findByTestId('transcript-web-prepend-range-reserve') as { props?: { style?: unknown } };
                expect(reserve).toBeTruthy();
                expect(reserve.props?.style).toEqual(expect.objectContaining({ height: 300 }));
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('restores a web session to its preserved reading position after prepend and A-to-B-to-A switching', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            let activeSessionId = 'session-a';
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore(activeSessionId, state);
            });

        const messagesForSession = (sessionId: string, includeOlder = false) => [
            ...(includeOlder
                ? [
                    { kind: 'user-text' as const, id: `${sessionId}-m1`, localId: null, createdAt: 1, seq: 1, text: `${sessionId} one` },
                    { kind: 'agent-text' as const, id: `${sessionId}-m2`, localId: null, createdAt: 2, seq: 2, text: `${sessionId} two` },
                ]
                : []),
            { kind: 'user-text' as const, id: `${sessionId}-m3`, localId: null, createdAt: 3, seq: 3, text: `${sessionId} three` },
            { kind: 'agent-text' as const, id: `${sessionId}-m4`, localId: null, createdAt: 4, seq: 4, text: `${sessionId} four` },
            { kind: 'agent-text' as const, id: `${sessionId}-m5`, localId: null, createdAt: 5, seq: 5, text: `${sessionId} five` },
        ];

        const itemAnchor = createFlashListChatListWebElement('transcript-item-session-a-m3', { top: 120, bottom: 220 });
        const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-session-a-m3', { top: 140, bottom: 190 });
        messageAnchor.parentElement = itemAnchor;
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [itemAnchor, messageAnchor],
        });

        let resolveLoadOlder = createMissingLoadOlderResolver();
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 5 };
        sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId) };

        const { ChatList } = await import('./ChatList');
        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            async (screen) => {
                await primeFlashListMetrics(600, 1200);
                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 2 });
                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 1800;
                itemAnchor.setRect({ top: 720, bottom: 820 });
                messageAnchor.setRect({ top: 740, bottom: 790 });
                sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId, true) };
                resolveLoadOlder({ loaded: 2, hasMore: true, status: 'loaded' });
                sessionState = { ...sessionState, seq: 7 };
                await screen.update(
                    <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
                );
                await screen.settle({ turns: 3 });

                const prependRestoreInputs = viewportControllerMockState.resolveInputs.filter((input) => (
                    input.type === 'restore-web-prepend-anchor'
                ));
                expect(prependRestoreInputs).toEqual(expect.arrayContaining([expect.objectContaining({
                    anchor: expect.objectContaining({
                        anchorTestId: 'transcript-anchor-message-session-a-m3',
                        anchorTop: 140,
                        itemTestId: 'transcript-item-session-a-m3',
                        itemTop: 120,
                        metrics: expect.objectContaining({
                            scrollTop: 100,
                            scrollHeight: 1200,
                            clientHeight: 600,
                        }),
                    }),
                })]));
                expect(viewportControllerMockState.resolveInputs).not.toContainEqual(expect.objectContaining({
                    reason: 'prepend-restore',
                    type: 'scroll-offset',
                }));
                expect(scrollEl.scrollTop).toBe(700);

                await screen.settle({ advanceTimersMs: 250, cycles: 1, turns: 2 });
                expect(sessionViewportByIdState.get('session-a')).toMatchObject({
                    isPinned: false,
                    source: 'observed',
                });
                expect(sessionViewportByIdState.get('session-a')?.offsetY).toBe(500);
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            },
        );

        activeSessionId = 'session-b';
        sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId) };
        const sessionBScroller = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
        });
            await withFlashListChatListWebScrollerDom(
            sessionBScroller,
            async () => {
                const screenB = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
                );
                await primeFlashListMetrics(600, 1200);
                await screenB.settle({ turns: 1 });
                unmountTrackedFlashListChatList(screenB);
            },
            {
                document: { getElementById: vi.fn(() => sessionBScroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );

            activeSessionId = 'session-a';
            sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId, true) };
            const restoredScroller = createFlashListChatListWebScroller({
                clientHeight: 600,
                scrollHeight: 1800,
                scrollTop: 1200,
                testNodes: [itemAnchor, messageAnchor],
            });
            itemAnchor.setRect({ top: 720, bottom: 820 });
            messageAnchor.setRect({ top: 740, bottom: 790 });
            await withFlashListChatListWebScrollerDom(
                restoredScroller,
                async () => {
                    const restored = await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
                    );
                    // One-shot distance restores wait for the initial-fill barrier (plan A1).
                    await primeFlashListMetrics(600, 1800, { turns: 2 });
                    await restored.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(restoredScroller.scrollTop).toBe(700);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => restoredScroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('continues preserving the web viewport if content grows again after the prepend commit', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockImplementation(async () => {
            scrollEl.scrollHeight = 1400;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);

                scrollEl.scrollHeight = 1200;
                loadOlderMessagesMock.mockClear();

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 3 });

                expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
                expect(scrollEl.scrollTop).toBe(300);

                scrollEl.scrollHeight = 1800;
                await primeFlashListMetrics(600, 1800);

                expect(scrollEl.scrollTop).toBe(700);
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('continues preserving the web viewport if the user scrolls again after the prepend commit', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockImplementation(async () => {
            scrollEl.scrollHeight = 1400;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);
                scrollEl.scrollHeight = 1200;
                loadOlderMessagesMock.mockClear();

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 3 });

                expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
                expect(scrollEl.scrollTop).toBe(300);

                scrollEl.scrollTop = 260;
                await scrollFlashListTo(260, { turns: 2 });

                scrollEl.scrollHeight = 1800;
                await primeFlashListMetrics(600, 1800);

                expect(scrollEl.scrollTop).toBe(660);
                await screen.unmount();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('preserves the web viewport when the user keeps scrolling upward while older messages are still loading', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                await triggerFlashListChatListStartReached();

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollTop = 60;
                await scrollFlashListTo(60);

                scrollEl.scrollHeight = 1400;
                resolveLoadOlder?.({ loaded: 5, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(scrollEl.scrollTop).toBe(260);
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('keeps the original in-flight web prepend anchor through non-trusted scroll events', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const originalAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 120, bottom: 180 });
        const programmaticAnchor = createFlashListChatListWebElement('transcript-anchor-message-m2', { top: 120, bottom: 180 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [originalAnchor],
        });

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                await primeFlashListMetrics(600, 1200);
                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                scrollEl.setQuerySelectorAll('[data-testid]', [originalAnchor]);
                await scrollFlashListTo(100);
                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollTop = 300;
                scrollEl.setQuerySelectorAll('[data-testid]', [programmaticAnchor]);
                await scrollFlashListTo(300, { trusted: false, turns: 2 });

                scrollEl.scrollHeight = 1400;
                originalAnchor.setRect({ top: 520, bottom: 580 });
                programmaticAnchor.setRect({ top: 120, bottom: 180 });
                scrollEl.setQuerySelectorAll('[data-testid]', [originalAnchor, programmaticAnchor]);
                resolveLoadOlder?.({ loaded: 5, hasMore: true, status: 'loaded' });
                await screen.settle({ turns: 4 });

                expect(scrollEl.scrollTop).toBe(700);
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('protects the web viewport when the user scrolls during an unprotected initial-fill older request', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const itemAnchor = createFlashListChatListWebElement('transcript-item-u1', { top: 120, bottom: 220 });
        const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 140, bottom: 190 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 200,
            scrollTop: 0,
            testNodes: [],
        });

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                await screen.triggerInitialFill({
                    layoutHeight: 600,
                    contentHeight: 200,
                    flushOptions: { turns: 2 },
                });

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 1200;
                scrollEl.scrollTop = 150;
                itemAnchor.setRect({ top: 120, bottom: 220 });
                messageAnchor.setRect({ top: 140, bottom: 190 });
                scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
                // Real user scrolls emit a stream of frames. The first frame here coincides with
                // the content-height change (churn — carries no single-frame release authority by
                // design); the second frame lands on a stable height and carries the user intent.
                await scrollFlashListTo(150, { turns: 2 });
                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 2 });

                scrollEl.scrollHeight = 1800;
                itemAnchor.setRect({ top: 520, bottom: 620 });
                messageAnchor.setRect({ top: 540, bottom: 590 });
                resolveLoadOlder?.({ loaded: 5, hasMore: true, status: 'loaded' });
                await screen.settle({ turns: 4 });

                expect(scrollEl.scrollTop).toBe(500);
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('keeps tracking the original web prepend anchor when it is temporarily unmounted during a large prepend', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const visibleAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 120, bottom: 220 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [visibleAnchor],
        });

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');

        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await primeFlashListMetrics(600, 1200);

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 5200;
                scrollEl.setQuerySelectorAll('[data-testid]', []);
                resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(scrollEl.scrollTop).toBe(100);

                visibleAnchor.setRect({ top: 300, bottom: 400 });
                scrollEl.scrollHeight = 5300;
                scrollEl.setQuerySelectorAll('[data-testid]', [visibleAnchor]);
                await primeFlashListMetrics(600, 5300);

                expect(scrollEl.scrollTop).toBe(280);
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            },
        );
    });

    it('materializes the exact keyed web prepend row after grow-collapse commits without applying gross height growth', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            const itemAnchor = createFlashListChatListWebElement('transcript-item-u1', { top: 40, bottom: 340 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 600,
                scrollHeight: 96_369,
                scrollTop: 95_000,
                testNodes: [itemAnchor, messageAnchor],
            });

            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(({ index }: { index: number }) => {
                    if (index !== 0 || scrollEl.scrollHeight !== 77_542) return;
                    itemAnchor.setRect({ top: 300, bottom: 600 });
                    messageAnchor.setRect({ top: 360, bottom: 420 });
                    scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
                }),
                getLayout: vi.fn(),
            };

            let resolveLoadOlder = createMissingLoadOlderResolver();
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise<LoadedOlderResult>((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();

            syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');

            await withRenderedFlashListChatListWebScroller(
                scrollEl,
                <ChatList session={{ ...sessionState }} />,
                async (screen) => {
                    await primeFlashListMetrics(600, 96_369);
                    await scrollFlashListTo(95_000);

                    scrollEl.scrollTop = 0;
                    await scrollFlashListTo(0);

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                    scrollEl.scrollHeight = 147_708;
                    scrollEl.setQuerySelectorAll('[data-testid]', []);
                    resolveLoadOlder({ loaded: 50, hasMore: true, status: 'loaded' });
                    await screen.settle({ cycles: 1, turns: 4, frames: 0 });

                    // The live failure moved 53,189px. This fixture's corresponding gross
                    // scroll-height growth is 51,339px; either write replaces the keyed viewport.
                    expect(scrollEl.scrollTop).toBe(0);
                    expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                        index: 0,
                        animated: false,
                    }));

                    scrollEl.scrollHeight = 142_795;
                    await primeFlashListMetrics(600, 142_795, { turns: 1 });
                    expect(scrollEl.scrollTop).toBe(0);

                    scrollEl.scrollHeight = 77_542;
                    await primeFlashListMetrics(600, 77_542, { turns: 1 });

                    await screen.settle({ cycles: 2, turns: 6, frames: 6, advanceTimersMs: 20 });

                    expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                        index: 0,
                        animated: false,
                    }));
                    expect(viewportControllerMockState.resolveInputs).toContainEqual(expect.objectContaining({
                        type: 'restore-visible-anchor',
                        reason: 'prepend-restore',
                        anchor: expect.objectContaining({
                            itemId: 'u1',
                            messageId: 'u1',
                        }),
                        itemOffsetPx: 40,
                    }));
                    expect(scrollEl.scrollTop).toBe(240);
                },
                {
                    initialFill: false,
                    dom: {
                        HTMLElement: FlashListChatListWebElement,
                        document: { getElementById: vi.fn(() => scrollEl) },
                        window: {
                            getComputedStyle: vi.fn(() => ({
                                overflowY: 'auto',
                                overflowX: 'hidden',
                                overflow: 'auto',
                            })),
                        },
                    },
                },
            );
        });
    });

    it('recovers the captured web prepend item when scrollHeight growth overshoots the original viewport anchor', async () => {
        const syncMod = await import('@/sync/sync');
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 16,
            sink: telemetrySink,
        });

        const itemAnchor = createFlashListChatListWebElement('transcript-item-u1', { top: 40, bottom: 340 });
        const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [itemAnchor, messageAnchor],
        });

        flashListRefHandle = {
            scrollToOffset: vi.fn(),
            scrollToIndex: vi.fn(),
            getLayout: vi.fn((index: number) => {
                if (index !== 0) return undefined;
                scrollEl.scrollTop = 3900;
                itemAnchor.setRect({ top: 140, bottom: 440 });
                messageAnchor.setRect({ top: 220, bottom: 280 });
                scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
                return { x: 0, y: 3900, width: 0, height: 300 };
            }),
        };

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 16,
        };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');

        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await primeFlashListMetrics(600, 1200);

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 5200;
                scrollEl.setQuerySelectorAll('[data-testid]', []);
                resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                    index: 0,
                    animated: false,
                    viewOffset: 40,
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    writer: 'web-dom-restore',
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    writer: 'web-dom-restore',
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                }));
                // The test renderer cannot materialize a recycler row in response to
                // scrollToIndex; the command is the observable owner boundary here. It must
                // not fall back to applying the gross scroll-height delta directly.
                expect(scrollEl.scrollTop).toBe(100);
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            },
        );
    });

    it('keeps retrying web prepend index recovery until the original anchor remounts', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            const itemAnchor = createFlashListChatListWebElement('transcript-item-u1', { top: 40, bottom: 340 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 600,
                scrollHeight: 1200,
                scrollTop: 600,
                testNodes: [itemAnchor, messageAnchor],
            });

            let scrollToIndexCalls = 0;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getLayout: vi.fn((index: number) => {
                    if (index !== 0) return undefined;
                    scrollToIndexCalls += 1;
                    scrollEl.scrollTop = 4100;
                    if (scrollToIndexCalls < 2) {
                        scrollEl.setQuerySelectorAll('[data-testid]', []);
                        return { x: 0, y: 4100, width: 0, height: 300 };
                    }
                    itemAnchor.setRect({ top: 300, bottom: 600 });
                    messageAnchor.setRect({ top: 360, bottom: 420 });
                    scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
                    return { x: 0, y: 4100, width: 0, height: 300 };
                }),
            };

            let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();

            syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');

            await withRenderedFlashListChatListWebScroller(
                scrollEl,
                <ChatList session={{ ...sessionState }} />,
                async (screen) => {
                    await primeFlashListMetrics(600, 1200);

                    await scrollFlashListTo(600);

                    scrollEl.scrollTop = 100;
                    await scrollFlashListTo(100);

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                    scrollEl.scrollHeight = 5200;
                    scrollEl.setQuerySelectorAll('[data-testid]', []);
                    resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
                    await screen.settle({ cycles: 2, turns: 6, frames: 6, advanceTimersMs: 20 });

                    expect(flashListRefHandle.scrollToIndex.mock.calls.length).toBeGreaterThan(1);
                    expect(flashListRefHandle.scrollToIndex.mock.calls.every(([command]: [any]) => (
                        command.index === 0 && command.animated === false && command.viewOffset === 40
                    ))).toBe(true);
                },
                {
                    initialFill: false,
                    dom: {
                        HTMLElement: FlashListChatListWebElement,
                        document: { getElementById: vi.fn(() => scrollEl) },
                        window: {
                            getComputedStyle: vi.fn(() => ({
                                overflowY: 'auto',
                                overflowX: 'hidden',
                                overflow: 'auto',
                            })),
                        },
                    },
                },
            );
        });
    });

    it('keeps the original web prepend anchor through non-trusted restore scroll events', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            const itemAnchor = createFlashListChatListWebElement('transcript-item-u1', { top: 40, bottom: 340 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
            const newlyPrependedToolGroup = createFlashListChatListWebElement(
                'transcript-item-toolCalls:turn:new',
                { top: 68, bottom: 247 },
            );
            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 600,
                scrollHeight: 1200,
                scrollTop: 600,
                testNodes: [itemAnchor, messageAnchor],
            });

            let scrollToIndexCalls = 0;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getLayout: vi.fn((index: number) => {
                    if (index !== 0) return undefined;
                    scrollToIndexCalls += 1;
                    scrollEl.scrollTop = 4100;
                    if (scrollToIndexCalls < 3) {
                        scrollEl.setQuerySelectorAll('[data-testid]', [newlyPrependedToolGroup]);
                        return { x: 0, y: 4100, width: 0, height: 300 };
                    }
                    itemAnchor.setRect({ top: 300, bottom: 600 });
                    messageAnchor.setRect({ top: 360, bottom: 420 });
                    scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
                    return { x: 0, y: 4100, width: 0, height: 300 };
                }),
            };

            let resolveLoadOlder = createMissingLoadOlderResolver();
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise<LoadedOlderResult>((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();

            syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');

            await withRenderedFlashListChatListWebScroller(
                scrollEl,
                <ChatList session={{ ...sessionState }} />,
                async (screen) => {
                    await primeFlashListMetrics(600, 1200);

                    await scrollFlashListTo(600);

                    scrollEl.scrollTop = 100;
                    await scrollFlashListTo(100);

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                    scrollEl.scrollHeight = 5200;
                    scrollEl.setQuerySelectorAll('[data-testid]', []);
                    resolveLoadOlder({ loaded: 50, hasMore: true, status: 'loaded' });
                    await screen.settle({ cycles: 1, turns: 4, frames: 0 });

                    expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                        index: 0,
                        animated: false,
                        viewOffset: 40,
                    }));
                    const commandCountBeforeRestoreEcho = flashListRefHandle.scrollToIndex.mock.calls.length;

                    await triggerFlashListChatListScroll(
                        4100,
                        {
                            contentSize: { height: 5200 },
                            layoutMeasurement: { height: 600 },
                        },
                        { turns: 2 },
                    );

                    await screen.settle({ cycles: 2, turns: 6, frames: 6, advanceTimersMs: 20 });

                    expect(flashListRefHandle.scrollToIndex.mock.calls.length).toBeGreaterThan(commandCountBeforeRestoreEcho);
                    expect(flashListRefHandle.scrollToIndex).toHaveBeenLastCalledWith(expect.objectContaining({
                        index: 0,
                        animated: false,
                        viewOffset: 40,
                    }));
                },
                {
                    initialFill: false,
                    dom: {
                        HTMLElement: FlashListChatListWebElement,
                        document: { getElementById: vi.fn(() => scrollEl) },
                        window: {
                            getComputedStyle: vi.fn(() => ({
                                overflowY: 'auto',
                                overflowX: 'hidden',
                                overflow: 'auto',
                            })),
                        },
                    },
                },
            );
        });
    });

    it('recovers by stable anchor identity when the captured turn wrapper id changes across the prepend', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const staleItemAnchor = createFlashListChatListWebElement('transcript-item-turn:stale', { top: 20, bottom: 360 });
        const stableMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [staleItemAnchor, stableMessageAnchor],
        });

        flashListRefHandle = {
            scrollToOffset: vi.fn(),
            scrollToIndex: vi.fn(),
            getLayout: vi.fn((index: number) => {
                if (index !== 0) return undefined;
                scrollEl.scrollTop = 3900;
                stableMessageAnchor.setRect({ top: 150, bottom: 210 });
                scrollEl.setQuerySelectorAll('[data-testid]', [stableMessageAnchor]);
                return { x: 0, y: 3900, width: 0, height: 300 };
            }),
        };

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');

        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await primeFlashListMetrics(600, 1200);
                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 5200;
                scrollEl.setQuerySelectorAll('[data-testid]', []);
                resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                    index: 0,
                    animated: false,
                }));
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            },
        );
    });

    it('uses native bottom-maintenance settings after mount settle without treating threshold zero as disabled', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(screen.getCapturedFlashListProps()).not.toBeNull();
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.startRenderingFromBottom).toBe(true);
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.autoscrollToTopThreshold).toBeUndefined();
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.animateAutoScrollToBottom).toBeUndefined();
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.autoscrollToBottomThreshold).toBeUndefined();

            await primeFlashListMetrics(600, 1200, { turns: 4 });

            // Cold-open deadlock fix: the MVCP bottom-autoscroll threshold arms from the real
            // viewport height as soon as the viewport is laid out (first paint, following, no open
            // transaction), decoupled from the content mount-settle window. It is the clamped
            // ratio (72 / 600), never a pretend-disabled threshold of 0.
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.autoscrollToBottomThreshold).toBe(72 / 600);

            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

            // After mount settle the same armed threshold stays in place (idempotent, still > 0).
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.autoscrollToBottomThreshold).toBe(72 / 600);
        });
    });

    it('omits native bottom maintenance for unpinned entry restores', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 420,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toBeUndefined();

            await primeFlashListMetrics(600, 1200, { turns: 2 });

            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 420,
                animated: false,
            });
        });
    });

    it('defers the initial native viewport pin until mount settle and keeps real streamed growth on native bottom maintenance', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'long markdown' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();

            await settleNativeFlashListMount(screen);

            expect(scrollToOffset).not.toHaveBeenCalled();
            const settledAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(settledAutoFollowReasons).not.toContain('initial-open');
            scrollToOffset.mockClear();

            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

            scrollToOffset.mockClear();

            viewportControllerMockState.resolveInputs = [];
            await primeFlashListMetrics(600, 1800, { advanceTimersMs: 1, turns: 1 });

            const remeasureAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(remeasureAutoFollowReasons).not.toContain('initial-open');
            expect(remeasureAutoFollowReasons).not.toContain('content-size-change');
            expect(scrollToOffset).not.toHaveBeenCalled();

            sessionState = {
                ...sessionState,
                active: true,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'long markdown' },
                    { kind: 'assistant-text', id: 'a2', localId: null, createdAt: 3, text: 'streamed token' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState }} />);
            await screen.settle({ turns: 2 });
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            await primeFlashListMetrics(600, 1900, { advanceTimersMs: 1, turns: 1 });
            const streamedGrowthAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(streamedGrowthAutoFollowReasons).not.toContain('stream-append');
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(getCapturedFlashListProps().maintainVisibleContentPosition).toEqual(expect.objectContaining({
                startRenderingFromBottom: true,
                animateAutoScrollToBottom: false,
            }));
        });
    });

    it('keeps native FlashList pinned for same-message streamed growth through native bottom maintenance', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionState = {
                ...sessionState,
                active: true,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming...' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await settleNativeFlashListMount(screen);
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming... plus more streamed content' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState }} />);
            await screen.settle({ turns: 2 });
            await primeFlashListMetrics(600, 1500, { advanceTimersMs: 1, turns: 1 });

            const streamedGrowthAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(streamedGrowthAutoFollowReasons).not.toContain('stream-append');
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
                animateAutoScrollToBottom: false,
            });
        });
    });

    it('keeps streamed native growth on FlashList bottom maintenance without JS stream-append commands', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionState = { ...sessionState, active: true };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming...' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await settleNativeFlashListMount(screen);
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...sessionMessagesState.messages,
                    { kind: 'assistant-text', id: 'a2', localId: null, createdAt: 3, text: 'token' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState, seq: 2 }} />);
            await screen.settle({ turns: 2 });
            await primeFlashListMetrics(600, 1500, { advanceTimersMs: 1, turns: 1 });

            const streamAppendCommands = () => viewportControllerMockState.resolveInputs
                .filter((input: any) => input.type === 'auto-follow' && input.reason === 'stream-append');
            expect(streamAppendCommands()).toHaveLength(0);
            expect(scrollToOffset).not.toHaveBeenCalled();

            // A second activity update WITHOUT a remeasure must not re-issue a
            // follow command for the same measured content version.
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...sessionMessagesState.messages,
                    { kind: 'assistant-text', id: 'a3', localId: null, createdAt: 4, text: 'token2' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState, seq: 3 }} />);
            await screen.settle({ turns: 2 });
            expect(streamAppendCommands()).toHaveLength(0);

            // The next measured growth is still maintained by FlashList bottom maintenance.
            await primeFlashListMetrics(600, 1700, { advanceTimersMs: 1, turns: 1 });
            expect(streamAppendCommands()).toHaveLength(0);
            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('issues zero follow writes for streamed growth while unpinned (invariant F)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionState = { ...sessionState, active: true };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming...' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await settleNativeFlashListMount(screen);

            // Release follow-bottom with a trusted drag away from the tail.
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            await scrollFlashListTo(100, { trusted: true, turns: 1 });
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...sessionMessagesState.messages,
                    { kind: 'assistant-text', id: 'a2', localId: null, createdAt: 3, text: 'token' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState, seq: 2 }} />);
            await screen.settle({ turns: 2 });
            await primeFlashListMetrics(600, 1500, { advanceTimersMs: 1, turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(viewportControllerMockState.resolveInputs
                .filter((input: any) => input.type === 'auto-follow')).toHaveLength(0);
            // Unpinned: no bottom autoscroll threshold, so growth cannot pull the reader down —
            // but MVCP offset correction stays armed for prepend position preservation (plan P1).
            const unpinnedMvcp = screen.getCapturedFlashListProps().maintainVisibleContentPosition;
            expect(unpinnedMvcp).toMatchObject({ startRenderingFromBottom: true });
            expect(unpinnedMvcp).not.toHaveProperty('autoscrollToBottomThreshold');
            expect(unpinnedMvcp).not.toHaveProperty('disabled');
        });
    });

    it('rearms native follow-bottom after a no-op drag ends at the bottom before streaming growth', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(600)),
            };
            sessionState = {
                ...sessionState,
                active: true,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming...' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await settleNativeFlashListMount(screen);
            viewportControllerMockState.resolveInputs = [];

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
                screen.getCapturedFlashListProps().onScrollEndDrag?.({});
            });

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming... plus more streamed content' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState }} />);
            await screen.settle({ turns: 2 });
            await primeFlashListMetrics(600, 1500, { advanceTimersMs: 1, turns: 1 });

            const streamedGrowthAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(streamedGrowthAutoFollowReasons).not.toContain('stream-append');
        });
    });

    it('does not treat native pin callback churn as new transcript activity', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'long markdown' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await settleNativeFlashListMount(screen);

            viewportControllerMockState.resolveInputs = [];
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            await act(async () => {
                screen.tree.update(<ChatList session={{ ...sessionState }} />);
            });
            await screen.settle({ turns: 2 });

            const autoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(autoFollowReasons).not.toContain('initial-open');
        });
    });

    it('does not re-render native FlashList for post-fill content-size updates', async () => {
        runtimeMockState.platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        await primeFlashListMetrics(600, 1200, { turns: 4 });
        const rendersAfterInitialFill = renderedFlashListCount;

        await act(async () => {
            screen.getCapturedFlashListProps().onContentSizeChange?.(400, 1210);
        });
        await screen.settle({ cycles: 1, turns: 1 });

        expect(renderedFlashListCount).toBe(rendersAfterInitialFill);
    });

    it('releases native bottom follow on the first drag away from the tail', async () => {
        runtimeMockState.platformOs = 'ios';
        const onViewportChange = vi.fn();
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(
            <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
        );

        await primeFlashListMetrics(100, 1000, { turns: 1 });
        onViewportChange.mockClear();

        await scrollFlashListTo(800, { trusted: true, turns: 1 });

        expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
            isPinned: false,
            offsetY: 100,
            shouldPersistViewport: false,
            shouldRestoreViewport: true,
        }));
    });

    it('keeps the native jump button hidden after non-user scroll drift while bottom follow is armed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
            flashListRefHandle.scrollToOffset.mockClear();
            onViewportChange.mockClear();
            await scrollFlashListTo(0, { trusted: false, turns: 1 });

            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                shouldRestoreViewport: true,
            }));
            await screen.settle({ advanceTimersMs: 1, cycles: 1, turns: 1 });
            // Passive drift while following never schedules a JS repin write
            // (plan B2/E8: MVCP owns bottom maintenance; zero writes on drift frames).
            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState }} />);
            await screen.settle({ turns: 2 });

            expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
        });
    });

    it('does not treat firstListPaint as stable settle for passive native drift', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            flashListRefHandle.scrollToOffset.mockClear();
            onViewportChange.mockClear();

            await scrollFlashListTo(0, { trusted: false, turns: 1 });

            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                shouldRestoreViewport: true,
            }));
        });
    });

    it('never releases native bottom follow from an untrusted observation, even with recent local intent (plan B6 trusted-gate)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

            // A static touch (tap-shaped: no vertical travel) records local user intent
            // without releasing follow through the gesture path.
            await act(async () => {
                screen.getCapturedFlashListProps().onTouchStart?.({ nativeEvent: { pageY: 300 } });
                screen.getCapturedFlashListProps().onTouchMove?.({ nativeEvent: { pageY: 300 } });
                screen.getCapturedFlashListProps().onTouchEnd?.();
            });
            onViewportChange.mockClear();

            // Untrusted (height-churn) observation moving away past the release threshold:
            // only trusted scrolls or explicit commands may release follow (H2 defect).
            await scrollFlashListTo(700, { trusted: false, turns: 1 });

            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                shouldRestoreViewport: true,
            }));

            // The mode stays 'following': later streamed growth is still bottom-followed
            // (no jump-to-bottom affordance for a user who never scrolled away).
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState }} />);
            await screen.settle({ turns: 2 });

            expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
        });
    });

    it('marks live-tail when a trusted post-drag fling settles at the bottom (plan B8)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            let nativeScrollOffset = 900;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

            // Drag away from the bottom and lift the finger far from it.
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 300;
            await scrollFlashListTo(300, { trusted: true, turns: 1 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollEndDrag?.({});
            });
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                source: 'observed',
            });

            // Momentum carries the fling to the bottom on untrusted frames.
            nativeScrollOffset = 850;
            await scrollFlashListTo(850, { trusted: false, turns: 1 });
            nativeScrollOffset = 900;
            await scrollFlashListTo(900, { trusted: false, turns: 1 });

            onViewportChange.mockClear();
            await act(async () => {
                screen.getCapturedFlashListProps().onMomentumScrollEnd?.({});
            });

            // Trusted arrival at the bottom re-arms follow and marks live-tail
            // (mode and emission agree within one observation window).
            expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            }));
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: true,
                offsetY: 0,
                source: 'default',
            });
        });
    });

    it('emits live-tail when a drag ends at the bottom (plan B8)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            let nativeScrollOffset = 900;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

            // Escape, then drag back down and release AT the bottom.
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 300;
            await scrollFlashListTo(300, { trusted: true, turns: 1 });
            nativeScrollOffset = 880;
            await scrollFlashListTo(880, { trusted: true, turns: 1 });

            onViewportChange.mockClear();
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollEndDrag?.({});
            });

            expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                shouldRestoreViewport: false,
            }));
            expect(onViewportChange).toHaveBeenCalledTimes(1);

            await act(async () => {
                screen.getCapturedFlashListProps().onMomentumScrollEnd?.({});
            });

            expect(onViewportChange).toHaveBeenCalledTimes(1);
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: true,
                offsetY: 0,
                source: 'default',
            });
        });
    });

    it('routes deferred-newer geometry into sync and emits live-tail on bottom return (plan D6)', async () => {
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptForwardPrefetchThresholdPx: 300,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 128,
            };
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 128,
                sink: telemetrySink,
            });
            let nativeScrollOffset = 900;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
            maybeDrainDeferredNewerMessagesMock.mockClear();

            // Escape away from the bottom. ChatList owns reporting the geometry, not deciding
            // whether sync should fetch.
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 300;
            await scrollFlashListTo(300, { trusted: true, turns: 1 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollEndDrag?.({});
            });
            expect(maybeDrainDeferredNewerMessagesMock).toHaveBeenCalledWith('session-1', {
                isPinned: false,
                distanceFromBottomPx: 600,
            });

            // Approaching the bottom routes updated geometry into the sync owner.
            nativeScrollOffset = 750;
            await scrollFlashListTo(750, { trusted: true, turns: 1 });
            expect(maybeDrainDeferredNewerMessagesMock).toHaveBeenLastCalledWith('session-1', {
                isPinned: false,
                distanceFromBottomPx: 150,
            });

            // Reaching the bottom emits live-tail so catch-up resolves tail-reset.
            onViewportChange.mockClear();
            nativeScrollOffset = 900;
            await scrollFlashListTo(900, { trusted: true, turns: 1 });
            expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                offsetY: 0,
                shouldPersistViewport: false,
                shouldRestoreViewport: false,
            }));
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: true,
                offsetY: 0,
                source: 'default',
            });
            expect(maybeDrainDeferredNewerMessagesMock).toHaveBeenLastCalledWith('session-1', {
                isPinned: true,
                distanceFromBottomPx: 0,
            });
        });
    });

    it('does not repin recycled native drift before React observes mount settle as stable', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(682, 1810, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await triggerFlashListChatListScroll(
                1128,
                {
                    contentSize: { height: 1810 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 35663, { turns: 1 });
            await triggerFlashListChatListScroll(
                34980,
                {
                    contentSize: { height: 35663 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            vi.setSystemTime(new Date(350));
            flashListRefHandle.scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs.splice(0);

            await triggerFlashListChatListScroll(
                1012,
                {
                    contentSize: { height: 35433 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({ turns: 2 });

            expect(viewportControllerMockState.resolveInputs).not.toContainEqual(expect.objectContaining({
                reason: 'passive-drift',
                type: 'auto-follow',
            }));
            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

            await screen.settle({
                advanceTimersMs: syncTuningState.transcriptMountSettleQuiescentWindowMs + 1,
                cycles: 1,
                turns: 2,
            });

            expect(viewportControllerMockState.resolveInputs).not.toContainEqual(expect.objectContaining({
                reason: 'mount-settle',
                type: 'auto-follow',
            }));
            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('does not replay native mount-settle after recycled bottom-then-wrong observations', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await act(async () => {
                getCapturedFlashListProps().onLayout?.({
                    nativeEvent: { layout: { height: 682.3333129882812, width: 400 } },
                });
            });
            await triggerFlashListChatListContentSizeChange(400, 9431, { turns: 1 });
            await triggerFlashListChatListScroll(
                4440.666666666667,
                {
                    contentSize: { height: 9153 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListContentSizeChange(400, 8019, { turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            await triggerFlashListChatListScroll(
                3028.6666666666665,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                7059,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                3028.6666666666665,
                {
                    contentSize: { height: 7741 },
                    layoutMeasurement: { height: 682 },
                },
                { turns: 1 },
            );
            await screen.settle({ turns: 2 });

            expect(viewportControllerMockState.resolveInputs).not.toContainEqual(expect.objectContaining({
                reason: 'mount-settle',
                type: 'auto-follow',
            }));
            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('ignores passive native drift after quiescent settle without new committed activity', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
            await scrollFlashListTo(900, { trusted: false, turns: 1 });
            flashListRefHandle.scrollToOffset.mockClear();
            onViewportChange.mockClear();
            viewportControllerMockState.resolveInputs = [];

            await scrollFlashListTo(0, { trusted: false, turns: 1 });

            await screen.settle({ advanceTimersMs: 1, cycles: 1, turns: 1 });
            expect(viewportControllerMockState.resolveInputs).not.toContainEqual(expect.objectContaining({
                reason: 'passive-drift',
                type: 'auto-follow',
            }));
            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            // Drift frames while following emit nothing at all (plan B1/E8).
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                shouldRestoreViewport: true,
            }));
        });
    });

    it('memoizes maintainVisibleContentPosition to avoid prop churn (FlashList)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} bottomNotice={null} />);

        const first = screen.getCapturedFlashListProps().maintainVisibleContentPosition;
        expect(first).toBeUndefined();

        await screen.update(<ChatList session={{ ...sessionState }} bottomNotice={null} />);

        const second = screen.getCapturedFlashListProps().maintainVisibleContentPosition;
        expect(second).toBe(first);

        // Unmount handled by afterEach to ensure stabilization timers are cancelled.
    });

    it('renders ListHeaderComponent above items and ChatFooter as ListFooterComponent (non-inverted FlashList)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        const flashListProps = screen.getCapturedFlashListProps();
        const headerEl = flashListProps.ListHeaderComponent;
        const footerEl = flashListProps.ListFooterComponent;

        // The header stays geometry-stable; older-loading progress is rendered as overlay chrome.
        expect(headerEl).toBeTruthy();
        expect(headerEl?.props?.isLoadingOlder).toBeUndefined();
        // The footer can be wrapped by the web hot-tail split, but it must still render ChatFooter.
        expect(footerEl).toBeTruthy();
        expectScreenHasTestId(screen, 'chat-footer');

        // Render sanity: FlashList still mounts in tree.
        expectScreenHasTestId(screen, 'flash-list');
    });

    it('extends the transcript footer with the composer keyboard inset', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expectScreenHasTestId(screen, 'chat-footer');
        expectScreenHasTestId(screen, 'transcript-composer-keyboard-inset');
    });

    it('does not reserve header chrome space inside the transcript list header', async () => {
        runtimeMockState.headerHeight = 88;
        runtimeMockState.safeAreaTop = 20;
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        const duplicatedChromeSpacerHeight = runtimeMockState.headerHeight + runtimeMockState.safeAreaTop + 32;
        const duplicatedChromeSpacers = screen.findAll((node) => {
            const style = node.props?.style;
            if (Array.isArray(style)) {
                return style.some((entry) => entry?.height === duplicatedChromeSpacerHeight);
            }
            return style?.height === duplicatedChromeSpacerHeight;
        });
        expect(duplicatedChromeSpacers).toHaveLength(0);
    });

    it('keeps a compact top gutter before the first transcript row', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        const compactTopGutters = screen.findAll((node) => node.props?.style?.height === 12);
        expect(compactTopGutters.length).toBeGreaterThanOrEqual(1);
    });

    it('renders only cold history inside the web FlashList data and moves the live tail into the footer', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'one' },
                { kind: 'user-text', id: 'u2', localId: null, createdAt: 2, text: 'two' },
                { kind: 'user-text', id: 'u3', localId: null, createdAt: 3, text: 'three' },
                { kind: 'user-text', id: 'u4', localId: null, createdAt: 4, text: 'four' },
            ],
        };
        syncTuningState = { ...syncTuningState, transcriptWebHotTailItemCount: 2 };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect((screen.getCapturedFlashListProps().data ?? []).map((item: any) => item.id)).toEqual(['u1', 'u2']);
        expectScreenHasTestId(screen, 'transcript-web-hot-tail');
        expectScreenHasTestId(screen, 'transcript-web-hot-tail-item-u3');
        expectScreenHasTestId(screen, 'transcript-web-hot-tail-item-u4');
        expectScreenHasTestId(screen, 'chat-footer');
    });

    it('keeps web hot-tail jump targets out of the RN-web scrollToIndex path', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        const hotTailTarget = createFlashListChatListWebElement('transcript-web-hot-tail-item-u4', {
            top: 800,
            bottom: 900,
        });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 100,
            scrollHeight: 1000,
            scrollTop: 0,
            testNodes: [hotTailTarget],
        });
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'user-text', id: 'u2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                { kind: 'user-text', id: 'u3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                { kind: 'user-text', id: 'u4', localId: null, createdAt: 4, seq: 4, text: 'four' },
            ],
        };
        syncTuningState = { ...syncTuningState, transcriptWebHotTailItemCount: 2 };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} jumpToSeq={4} />);
                await primeFlashListMetrics(100, 1000, { turns: 2 });
                await screen.settle();

                expect((screen.getCapturedFlashListProps().data ?? []).map((item: any) => item.id)).toEqual(['u1', 'u2']);
                expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('pins via DOM scroll on web without calling scrollToOffset when DOM pinning is possible', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        const scrollEl: any = {
            scrollHeight: 1000,
            clientHeight: 100,
            scrollTop: 0,
            scrollTo: vi.fn(() => {
                throw new Error('should not call scrollTo (RNW overrides scrollTo signature)');
            }),
            querySelectorAll: () => [],
            parentElement: null,
        };

        const fakeDocument: any = { getElementById: vi.fn(() => scrollEl) };
        const fakeWindow: any = { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) };
        (globalThis as any).document = fakeDocument;
        (globalThis as any).window = fakeWindow;

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                expect((scrollEl as any).scrollTop).toBeGreaterThan(0);
                expect(scrollEl.scrollTo).not.toHaveBeenCalled();
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('does not fall back to scrollToOffset on web when DOM pinning is unavailable (prevents mount jitter)', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            null,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => null) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('continues initial web stabilization for delayed DOM height growth', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const scrollEl = Object.assign(
                createFlashListChatListWebScroller({
                    clientHeight: 100,
                    scrollHeight: 1000,
                    scrollTop: 0,
                }),
                {
                    scrollTo: ({ top }: { top: number }) => {
                        const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                        scrollEl.scrollTop = Math.max(0, Math.min(top, maxScrollTop));
                    },
                },
            );

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2 });
                    await screen.settle();

                    expect(scrollEl.scrollTop).toBe(900);

                    // After the entry transaction confirms, delayed DOM height growth flows
                    // through the content-size event and the FOLLOW owner keeps the bottom
                    // (single-owner model: the entry loop never re-pins).
                    scrollEl.scrollHeight = 1400;
                    await triggerFlashListChatListContentSizeChange(400, 1400, { turns: 2, frames: 1 });
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(1300);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('reconfirms web cold-open bottom from live DOM metrics after retry-time height growth', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptWebInitialPinStabilizeMs: 1_500,
                transcriptWebInitialPinRetryIntervalMs: 250,
                transcriptWebInitialPinRetryMilestonesMs: [],
            };
            const scrollEl = Object.assign(
                createFlashListChatListWebScroller({
                    clientHeight: 100,
                    scrollHeight: 1000,
                    scrollTop: 0,
                }),
                {
                    scrollTo: ({ top }: { top: number }) => {
                        const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                        scrollEl.scrollTop = Math.max(0, Math.min(top, maxScrollTop));
                    },
                },
            );

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2 });
                    await screen.settle();
                    expect(scrollEl.scrollTop).toBe(900);

                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 300 });
                    scrollEl.scrollHeight = 1008;
                    await screen.settle({ cycles: 2, turns: 2, advanceTimersMs: 1_500 });

                    expect(scrollEl.scrollTop).toBe(908);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('uses configured early initial web stabilization milestones to issue a late first pin', async () => {
        // The milestone cadence survives as the OBSERVATION schedule of the web entry
        // transaction (plan A5): when the DOM scroller is not resolvable at mount, the first
        // pin write is issued at the configured milestone and confirms there - no unbounded
        // bottom-stability polling afterwards.
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptWebInitialPinStabilizeMs: 1500,
                transcriptWebInitialPinRetryIntervalMs: 2000,
                transcriptWebInitialPinRetryMilestonesMs: [700],
            };
            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
            });
            let scrollerAvailable = false;

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    // No scroller yet: no transaction, no write.
                    expect(scrollEl.scrollTop).toBe(0);

                    scrollerAvailable = true;
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 600 });
                    expect(scrollEl.scrollTop).toBe(0);

                    // Crossing the 700ms milestone issues the first pin, which confirms.
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 150 });
                    expect(scrollEl.scrollTop).toBe(900);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => (scrollerAvailable ? scrollEl : null)) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('uses the short stabilization fallback when tuning is malformed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptWebInitialPinStabilizeMs: Number.NaN,
            };
            const scrollEl = Object.assign(
                createFlashListChatListWebScroller({
                    clientHeight: 100,
                    scrollHeight: 1000,
                    scrollTop: 0,
                }),
                {
                    scrollTo: ({ top }: { top: number }) => {
                        const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                        scrollEl.scrollTop = Math.max(0, Math.min(top, maxScrollTop));
                    },
                },
            );

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    expect(scrollEl.scrollTop).toBe(900);

                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 1600 });
                    scrollEl.scrollHeight = 1400;
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(900);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('keeps the settled web bottom unchanged during initial stabilization retries', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const scrollEl: any = {
                scrollHeight: 1000,
                clientHeight: 100,
                scrollTop: 0,
                querySelectorAll: () => [],
                parentElement: null,
            };

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    expect(scrollEl.scrollTop).toBe(1000);
                    scrollEl.scrollTop = 1000;

                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(1000);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('restores an observed unpinned session on entry without auto-pinning it', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 420,
                lastUpdatedAt: 1,
                source: 'observed',
            });

            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
            });

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    // The one-shot distance restore waits for the initial-fill barrier (plan A1);
                    // priming layout/content lets the fill settle as it does in production.
                    await primeFlashListMetrics(100, 1000, { turns: 2 });
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(480);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('persists an observed unpinned snapshot when a real web scroll-up collapses the ref-based distance to zero', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            // Route the emit through the real sync viewport routing (as SessionView does) so this test
            // exercises the full web capture -> persist -> restore contract end to end.
            const onViewportChange = vi.fn((state: any) => routeSessionViewportChangeIntoTestStore('session-1', state));
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            // The live DOM scroller reports a genuine reading position above the tail
            // (scrollTop 500 of a 1100 max), so the true distance from bottom is 600.
            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1200,
                scrollTop: 500,
            });

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    // The web hot/cold split can leave the FlashList content height collapsed to the
                    // layout height while the tail renders in the footer, so the ref-based distance
                    // computation yields 0 even though the user has scrolled up.
                    await primeFlashListMetrics(100, 100, { turns: 1 });
                    onViewportChange.mockClear();

                    // The real DOM scroller is at a genuine mid-transcript reading position even though
                    // FlashList's collapsed hot/cold content reports its own scroll offset as 0.
                    // A genuine scrollbar-drag / keyboard scroll-up: RNW does not always mark the
                    // synthetic scroll event as trusted and there is no preceding pointer event.
                    // Untrusted movement carries release authority only when SUSTAINED (consecutive
                    // same-direction frames, matching the continuous frame stream a real drag
                    // emits) — a single untrusted frame can be a renderer-internal adjustment
                    // (Legend) and must not release.
                    scrollEl.scrollTop = 900;
                    await scrollFlashListTo(0, { trusted: false, turns: 1 });
                    scrollEl.scrollTop = 700;
                    await scrollFlashListTo(0, { trusted: false, turns: 1 });
                    scrollEl.scrollTop = 500;
                    await scrollFlashListTo(0, { trusted: false, turns: 1 });

                    // The user released bottom-follow: the stored intent must be an observed
                    // restore snapshot with the true distance from bottom, not a live-tail re-pin.
                    expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                        isPinned: false,
                        offsetY: 600,
                        shouldRestoreViewport: true,
                    }));

                    const stored = sessionViewportByIdState.get('session-1');
                    expect(stored).toMatchObject({ source: 'observed', isPinned: false, offsetY: 600 });
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );

            // Returning to the session after a switch restores the saved reading position from the
            // observed snapshot the web scroll-up just produced (not the bottom).
            const restoredScrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1200,
                scrollTop: 1100,
            });
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

            await withFlashListChatListWebScrollerDom(
                restoredScrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    // One-shot distance restores wait for the initial-fill barrier (plan A1).
                    await primeFlashListMetrics(100, 1200, { turns: 2 });
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(restoredScrollEl.scrollTop).toBe(500);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => restoredScrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('keeps web bottom follow stable from live DOM metrics when FlashList content height is stale', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 600,
                scrollHeight: 1800,
                scrollTop: 1200,
            });

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                    // FlashList can report a collapsed content height while the real DOM scroller
                    // is at the visual bottom because the hot/cold tail renders outside the main
                    // measured body. Bottom-follow must therefore use one consistent DOM metric set.
                    await primeFlashListMetrics(600, 600, { turns: 1 });

                    scrollEl.scrollHeight = 2200;
                    await triggerFlashListChatListContentSizeChange(400, 700, { turns: 2, frames: 1 });

                    expect(scrollEl.scrollTop).toBe(1600);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('packages scheduler authority fields on web bottom-follow telemetry snapshots', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 64,
                sink: telemetrySink,
            });
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 600,
                scrollHeight: 1800,
                scrollTop: 1200,
            });

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(600, 600, { turns: 1 });
                    telemetrySink.mockClear();

                    scrollEl.scrollHeight = 2200;
                    await triggerFlashListChatListContentSizeChange(400, 700, { turns: 2, frames: 1 });

                    const bottomWrite = telemetrySink.mock.calls
                        .map(([event]) => event)
                        .find((event) => event?.type === 'scroll-write' && event.reason === 'content-size-change');
                    expect(bottomWrite).toMatchObject({
                        writer: 'web-dom-bottom',
                        schedulerAuthorityWriter: 'content-growth',
                        schedulerAuthorityReason: 'content-size-change',
                    });
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('reconfirms a web bottom entry restore after late content height settle through the scheduler', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };
            sessionViewportByIdState.set('session-1', {
                anchor: null,
                isPinned: true,
                lastUpdatedAt: 1,
                offsetY: 0,
                source: 'observed',
            });

            const initialContentHeight = 11_548;
            const settledContentHeight = 11_556;
            const clientHeight = 334;
            const initialBottom = initialContentHeight - clientHeight;
            const settledBottom = settledContentHeight - clientHeight;
            const scrollEl = createFlashListChatListWebScroller({
                clientHeight,
                scrollHeight: initialContentHeight,
                scrollTop: initialBottom,
            });

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(clientHeight, initialContentHeight, { turns: 2 });
                    await screen.settle({ cycles: 1, turns: 2, advanceTimersMs: 50 });
                    expect(scrollEl.scrollTop).toBe(initialBottom);

                    scrollEl.scrollHeight = settledContentHeight;
                    scrollEl.scrollTop = initialBottom;
                    await scrollFlashListTo(initialBottom, { trusted: false, turns: 2 });
                    await screen.settle({ cycles: 1, turns: 2, advanceTimersMs: 50 });

                    expect(scrollEl.scrollTop).toBe(settledBottom);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('shows the jump-to-bottom affordance on web when unpinned even without new activity', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            settingValues.transcriptScrollJumpToBottomEnabled = true;
            settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1200,
                scrollTop: 500,
            });

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 100, { turns: 1 });

                    // Scroll up without any new activity arriving. Untrusted movement releases
                    // only when SUSTAINED (consecutive same-direction frames, the shape a real
                    // drag emits); a single untrusted frame can be a renderer-internal adjustment.
                    scrollEl.scrollTop = 900;
                    await scrollFlashListTo(0, { trusted: false, turns: 1 });
                    scrollEl.scrollTop = 700;
                    await scrollFlashListTo(0, { trusted: false, turns: 1 });
                    scrollEl.scrollTop = 500;
                    await scrollFlashListTo(0, { trusted: false, turns: 1 });

                    // Even with newActivityCount === 0, an unpinned web transcript should expose the
                    // jump-to-bottom affordance so the user can return to the live tail.
                    expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('shows the jump-to-bottom affordance after a web jumpToSeq lands far from bottom before a DOM anchor is available', async () => {
        const messages = Array.from({ length: 360 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const contentHeight = 30_000;
        const clientHeight = 500;
        const targetScrollTop = 3_800;
        const scroller = createFlashListChatListWebScroller({
            clientHeight,
            scrollHeight: contentHeight,
            scrollTop: contentHeight - clientHeight,
            testNodes: [],
        });
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                index === 300
                    ? { x: 0, y: targetScrollTop + 200, width: 320, height: 100 }
                    : undefined
            )),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 360 };
        settingValues.transcriptScrollJumpToBottomEnabled = true;
        settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 2,
        };

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={301} />,
                );
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2 });
                await screen.settle({ turns: 4 });

                expect(scroller.scrollTop).toBe(targetScrollTop);
                expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
            },
            {
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('restores a materialized session-switch anchor after tail growth while away', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 100,
                anchor: {
                    kind: 'message',
                    messageId: 'm2',
                    itemId: 'm2',
                    itemOffsetPx: 40,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'new tail while hidden' },
                ],
            };

            const itemAnchor = createFlashListChatListWebElement('transcript-item-m2', { top: 160, bottom: 260 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m2', { top: 170, bottom: 220 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1200,
                scrollTop: 0,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1200, { turns: 2, frames: 1 });
                    await screen.settle({ turns: 1 });

                    expect(scroller.scrollTop).toBe(120);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('does not persist synthetic opening observations before stored-anchor restoration settles', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const syncMod = await import('@/sync/sync');
            vi.mocked(syncMod.sync.loadOlderMessages)
                .mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' as const });
            const onViewportChange = vi.fn();
            const storedAnchor = {
                kind: 'message' as const,
                messageId: 'm2',
                itemId: 'm2',
                itemOffsetPx: 40,
                capturedAtMs: 1,
            };
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 100,
                anchor: storedAnchor,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };

            const itemAnchor = createFlashListChatListWebElement('transcript-item-m2', { top: 160, bottom: 260 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m2', { top: 170, bottom: 220 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1200,
                scrollTop: 0,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    await primeFlashListMetrics(100, 1200, { turns: 2, frames: 1 });

                    expect(onViewportChange).not.toHaveBeenCalled();
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('captures a viewport anchor on scroll settle without capturing every scroll frame', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const onViewportChange = vi.fn();
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorCaptureDebounceMs: 125,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const itemAnchor = createFlashListChatListWebElement('transcript-item-m1', { top: 80, bottom: 180 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 90, bottom: 150 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 500,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    await primeFlashListMetrics(100, 1000, { turns: 1 });

                    onViewportChange.mockClear();
                    scroller.scrollTop = 500;
                    await scrollFlashListTo(500, { trusted: true, turns: 1 });
                    scroller.scrollTop = 520;
                    await scrollFlashListTo(520, { trusted: true, turns: 1 });

                    expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                        anchor: expect.anything(),
                    }));

                    await act(async () => {
                        vi.advanceTimersByTime(124);
                    });

                    expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                        anchor: expect.anything(),
                    }));

                    await act(async () => {
                        vi.advanceTimersByTime(1);
                    });

                    expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                        anchor: expect.objectContaining({
                            kind: 'message',
                            messageId: 'm1',
                            itemId: 'm1',
                            itemOffsetPx: 80,
                        }),
                        shouldRestoreViewport: true,
                    }));
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('issues a data-resolvable web anchor restore through the seam when the anchor row is not in the DOM', async () => {
        // When the anchor is in listData bounds but not yet in the DOM (FlashList has not
        // rendered it into view), scrollToIndex is called to bring it into the render window.
        // The useLayoutEffect retry then finds it via direct DOM lookup once listContentHeight
        // changes. If the row never mounts (deadline fires), no distance write competes with
        // the anchor target — the transaction simply closes.
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getLayout: vi.fn((index: number) => (
                    index === 1 ? { x: 0, y: 160, width: 0, height: 100 } : undefined
                )),
            };
            syncTuningState = {
                ...syncTuningState,
                transcriptWebHotTailItemCount: 0,
            };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 300,
                anchor: {
                    kind: 'message',
                    messageId: 'm2',
                    itemId: 'm2',
                    itemOffsetPx: 40,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2 });

                    // scrollToIndex is called to bring the unrendered anchor row into view.
                    // No scroll-top write occurs because the anchor is still not in the DOM.
                    expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                        index: 1,
                        animated: false,
                    }));
                    expect(scroller.scrollTop).toBe(0);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

                    // The anchor row never mounts in the DOM: the deadline closes the
                    // transaction without a distance write competing with the anchor target.
                    await screen.settle({
                        advanceTimersMs: syncTuningState.transcriptInitialFillBudgetMs + 1,
                        cycles: 1,
                        turns: 2,
                    });
                    expect(scroller.scrollTop).toBe(0);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('forces the final viewport anchor capture when the session unmounts before scroll settle', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const onViewportChange = vi.fn();
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const itemAnchor = createFlashListChatListWebElement('transcript-item-m1', { top: 70, bottom: 170 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 80, bottom: 140 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 500,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    await primeFlashListMetrics(100, 1000, { turns: 1 });

                    onViewportChange.mockClear();
                    scroller.scrollTop = 500;
                    await scrollFlashListTo(500, { trusted: true, turns: 1 });
                    await screen.unmount();

                    expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                        anchor: expect.objectContaining({
                            messageId: 'm1',
                            itemId: 'm1',
                            itemOffsetPx: 70,
                        }),
                        shouldRestoreViewport: true,
                    }));
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('hands an uncaptured viewport to a same-session structural replacement before its first entry decision', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorCaptureDebounceMs: 200,
                transcriptWebHotTailItemCount: 0,
            };
            const scrollToIndex = vi.fn();
            flashListRefHandle = {
                scrollToIndex,
                scrollToOffset: vi.fn(),
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'snapshot X' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'viewport Y' },
                ],
            };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 700,
                anchor: {
                    kind: 'message',
                    messageId: 'm1',
                    itemId: 'm1',
                    itemOffsetPx: 40,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });

            const itemX = createFlashListChatListWebElement('transcript-item-m1', { top: 70, bottom: 170 });
            const messageX = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 80, bottom: 140 });
            messageX.parentElement = itemX;
            const itemY = createFlashListChatListWebElement('transcript-item-m2', { top: 55, bottom: 155 });
            const messageY = createFlashListChatListWebElement('transcript-anchor-message-m2', { top: 65, bottom: 125 });
            messageY.parentElement = itemY;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1_400,
                scrollTop: 600,
                testNodes: [itemX, messageX],
            });
            const routeViewportChange: NonNullable<ChatListProps['onViewportChange']> = (state) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            };
            const { ChatList } = await import('./ChatList');
            const { TranscriptSameSessionHandoffProvider } =
                await import('./viewport/lifecycle/transcriptSameSessionHandoff');

            function ClassicTranscriptParent() {
                return <ChatList session={{ ...sessionState }} onViewportChange={routeViewportChange} />;
            }

            function CockpitTranscriptParent() {
                return React.createElement(
                    'CockpitTranscriptShape',
                    { testID: 'same-session-cockpit-shape' },
                    <ChatList session={{ ...sessionState }} onViewportChange={routeViewportChange} />,
                );
            }

            function SessionRoute(props: Readonly<{ experience: 'classic' | 'cockpit' }>) {
                return (
                    <TranscriptSameSessionHandoffProvider
                        desiredExperience={props.experience}
                        sessionId="session-1"
                    >
                        {(experience) => (
                            experience === 'classic'
                                ? <ClassicTranscriptParent />
                                : <CockpitTranscriptParent />
                        )}
                    </TranscriptSameSessionHandoffProvider>
                );
            }

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const screen = await renderTrackedFlashListChatList(
                        <SessionRoute experience="classic" />,
                    );
                    await primeFlashListMetrics(100, 1_400, { turns: 2 });
                    await screen.settle({ turns: 2 });

                    scrollToIndex.mockClear();
                    scroller.setQuerySelectorAll('[data-testid]', [itemY, messageY]);
                    scroller.scrollTop = 500;
                    vi.setSystemTime(new Date(100));
                    await scrollFlashListTo(500, { trusted: true, turns: 1 });

                    expect(sessionViewportByIdState.get('session-1')?.anchor).toMatchObject({
                        messageId: 'm1',
                        itemId: 'm1',
                    });

                    vi.setSystemTime(new Date(200));
                    await screen.update(<SessionRoute experience="cockpit" />);
                    await screen.settle({ turns: 2 });
                    scroller.scrollHeight = 1_401;
                    await triggerFlashListChatListContentSizeChange(400, 1_401, { turns: 2 });

                    expect({
                        capturedAnchor: sessionViewportByIdState.get('session-1')?.anchor,
                        firstEntryIndexCommand: scrollToIndex.mock.calls[0]?.[0] ?? null,
                        scrollTop: scroller.scrollTop,
                    }).toMatchObject({
                        capturedAnchor: {
                            messageId: 'm2',
                            itemId: 'm2',
                            itemOffsetPx: 55,
                        },
                        firstEntryIndexCommand: null,
                        scrollTop: 500,
                    });
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('forces the final viewport anchor capture before a surviving list changes session id', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const onViewportChange = vi.fn();
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorCaptureDebounceMs: 200,
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const itemAnchor = createFlashListChatListWebElement('transcript-item-m1', { top: 70, bottom: 170 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 80, bottom: 140 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 500,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    await primeFlashListMetrics(100, 1000, { turns: 1 });

                    onViewportChange.mockClear();
                    scroller.scrollTop = 500;
                    await scrollFlashListTo(500, { trusted: true, turns: 1 });
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [{ kind: 'user-text', id: 'n1', localId: null, createdAt: 2, seq: 1, text: 'next' }],
                    };
                    await screen.update(
                        <ChatList
                            session={{ ...sessionState, id: 'session-2' }}
                            onViewportChange={onViewportChange}
                        />,
                    );

                    expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                        anchor: expect.objectContaining({
                            messageId: 'm1',
                            itemId: 'm1',
                            itemOffsetPx: 70,
                        }),
                        shouldRestoreViewport: true,
                    }));
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('captures the exact native A viewport at the production keyed session unmount before its list ref clears', async () => {
        // Production reachability is the keyed TranscriptMessageSelectionBoundary:
        // switching session ids unmounts A. The renderer ref-clear must classify A
        // before clearing its physical handle; B owns a separate ChatListInternal.
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorCaptureDebounceMs: 200,
            };
            let nativeScrollOffset = 900;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index === 1 ? 820 : 700,
                    width: 320,
                    height: 100,
                })),
            };
            const routeSession1ViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            const routeSession2ViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-2', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };
            sessionViewportByIdState.set('session-1', {
                isPinned: true,
                offsetY: 0,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'default',
            });

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList
                    session={{ ...sessionState, id: 'session-1' }}
                    onViewportChange={routeSession1ViewportChange}
                />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 1 });

            routeSession1ViewportChange.mockClear();
            nativeScrollOffset = 100;

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'n1', localId: null, createdAt: 1, seq: 1, text: 'alpha' },
                    { kind: 'agent-text', id: 'n2', localId: null, createdAt: 2, seq: 2, text: 'beta' },
                ],
            };
            await screen.update(
                <ChatList
                    session={{ ...sessionState, id: 'session-2' }}
                    onViewportChange={routeSession2ViewportChange}
                />,
            );
            await Promise.resolve();

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                anchor: expect.objectContaining({
                    messageId: 'm1',
                    itemId: 'm1',
                    itemOffsetPx: 20,
                }),
                offsetY: 800,
                source: 'observed',
            });
            expect(sessionViewportByIdState.get('session-1')?.anchor).not.toEqual(expect.objectContaining({
                messageId: 'n2',
            }));
        });
    });

    it('captures a message anchor when a trusted fling settles into a dwell on untrusted momentum frames (plan P2)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorCaptureDebounceMs: 200,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 64,
                sink: telemetrySink,
            });
            let nativeScrollOffset = 100;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index === 1 ? 140 : 20,
                    width: 320,
                    height: 100,
                })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 1 });

            // Trusted drag away from the bottom, then a fling: every post-release frame is
            // an untrusted momentum frame (the field shape for "scroll up and read").
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 150;
            await scrollFlashListTo(150, { trusted: true, turns: 1 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollEndDrag?.({});
                screen.getCapturedFlashListProps().onMomentumScrollBegin?.({});
            });
            nativeScrollOffset = 120;
            await scrollFlashListTo(120, { trusted: false, turns: 1 });
            nativeScrollOffset = 800;
            await scrollFlashListTo(100, { trusted: false, turns: 1 });
            await act(async () => {
                screen.getCapturedFlashListProps().onMomentumScrollEnd?.({});
            });

            // Dwell past the capture debounce: the momentum frames carry the drag's user
            // attribution, so the dwelled position must capture a message anchor.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(250);
            });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                anchor: expect.objectContaining({
                    messageId: expect.any(String),
                    itemOffsetPx: expect.any(Number),
                }),
            });
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'anchor-capture',
                reason: 'anchor-captured',
                orientation: 'inverted',
            }));

            await screen.unmount();
        });
    });

    it('keeps a scheduled anchor capture alive through untrusted churn frames (plan P2)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorCaptureDebounceMs: 200,
            };
            let nativeScrollOffset = 100;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index === 1 ? 140 : 20,
                    width: 320,
                    height: 100,
                })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 1 });

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 150;
            await scrollFlashListTo(150, { trusted: true, turns: 1 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollEndDrag?.({});
            });

            // An unattributable churn frame (no drag, no momentum: streaming re-measure)
            // arrives before the debounce elapses. It must not destroy the pending capture.
            nativeScrollOffset = 120;
            await scrollFlashListTo(120, { trusted: false, turns: 1 });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(450);
            });

            // The deferred capture fires after the churn quiesces and persists a REAL anchor.
            // (The previous `anchor: null` expectation was false-green: the churn frame hard-
            // invalidated the pending capture and the store's null came from the never-captured
            // default, not from a surviving capture — fixed 2026-07-11 with capture deferral.)
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                anchor: expect.objectContaining({ itemId: expect.any(String) }),
            });

            await screen.unmount();
        });
    });

    it('persists live-tail intent on session exit when the viewport sits at the bottom (plan P3)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            let nativeScrollOffset = 100;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index === 1 ? 140 : 20,
                    width: 320,
                    height: 100,
                })),
            };
            const routeSession1ViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            const routeSession2ViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-2', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={routeSession1ViewportChange} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 1 });

            // Release with a trusted drag away from the bottom: stored viewport becomes
            // observed/unpinned (the field precondition for catch-up/restore poisoning).
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 400;
            await scrollFlashListTo(400, { trusted: true, turns: 1 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollEndDrag?.({});
            });
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                source: 'observed',
            });

            // A PASSIVE return to the very bottom (untrusted frame, e.g. content settle or a
            // swallowed momentum tail): the B8 arrival emission cannot fire (untrusted), so
            // without the exit flush the stored viewport would stay unpinned.
            nativeScrollOffset = 900;
            await scrollFlashListTo(900, { trusted: false, turns: 1 });

            // Navigate away: the exit flush must persist live-tail intent deterministically.
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'n1', localId: null, createdAt: 1, seq: 1, text: 'alpha' },
                ],
            };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-2' }} onViewportChange={routeSession2ViewportChange} />,
            );
            await screen.settle({ turns: 2 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: true,
                offsetY: 0,
                source: 'default',
            });

            await screen.unmount();
        });
    });

    it('publishes only the fire-time detached snapshot when the native ref detaches after layout exit', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            let exiting = false;
            let exitReadCount = 0;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 0 })),
                getAbsoluteLastScrollOffset: vi.fn(() => {
                    if (!exiting) return nativeRawOffsetForCanonicalOffset(900);
                    // Layout-exit classification + anchor/distance capture can still read A.
                    // The later passive cleanup sees the renderer boundary already detached.
                    return exitReadCount++ < 3
                        ? nativeRawOffsetForCanonicalOffset(100)
                        : Number.NaN;
                }),
                getLayout: vi.fn(() => ({
                    x: 0,
                    y: 820,
                    width: 320,
                    height: 100,
                })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };
            sessionViewportByIdState.set('session-1', {
                isPinned: true,
                offsetY: 0,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'default',
            });

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 1 });
            onViewportChange.mockClear();

            exiting = true;
            await screen.unmount();
            await Promise.resolve();

            expect(onViewportChange).toHaveBeenCalledWith({
                anchor: expect.objectContaining({
                    itemId: 'm2',
                    itemOffsetPx: 20,
                    messageId: 'm2',
                }),
                isPinned: false,
                offsetY: 800,
                shouldRestoreViewport: true,
            });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                shouldRestoreViewport: false,
            }));
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                anchor: expect.objectContaining({
                    itemId: 'm2',
                    itemOffsetPx: 20,
                    messageId: 'm2',
                }),
                isPinned: false,
                offsetY: 800,
                source: 'observed',
            });
        });
    });

    it('persists live-tail intent on unmount at the bottom even when the live offset read is gone (plan P3 fallback)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            let nativeScrollOffset = 100;
            let listRefDetached = false;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 1 })),
                // Real navigation detaches the list ref before the passive unmount cleanup
                // runs: the live offset read is unavailable at exit-flush time.
                getAbsoluteLastScrollOffset: vi.fn(() => (
                    listRefDetached ? Number.NaN : nativeRawOffsetForCanonicalOffset(nativeScrollOffset)
                )),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index === 1 ? 140 : 20,
                    width: 320,
                    height: 100,
                })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 1 });

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 400;
            await scrollFlashListTo(400, { trusted: true, turns: 1 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollEndDrag?.({});
            });
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                source: 'observed',
            });

            // Trusted return to the very bottom, then unmount with the ref already detached:
            // the fallback (last observed distance) must still persist live-tail.
            nativeScrollOffset = 900;
            await scrollFlashListTo(900, { trusted: true, turns: 1 });
            listRefDetached = true;
            await screen.unmount();

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: true,
                offsetY: 0,
                source: 'default',
            });
        });
    });

    it('telemeters a skipped entry-restore decision when a session switch disposes an open transaction (audit: never silent)', async () => {
        // Plan §4 "every outcome telemetered": an entry-restore transaction left open when the
        // user navigates to another session must close with an attributable outcome for the
        // EXITING session, mirroring the prepend disposal path — never a silent ref drop.
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 64,
                sink: telemetrySink,
            });
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 355,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await primeFlashListMetrics(727, 21758, { turns: 2 });

            // The distance one-shot was issued and no observation confirmed it: the
            // transaction is OPEN at switch time.
            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 355, animated: false });
            const entryWriteEvent = telemetrySink.mock.calls
                .map(([event]) => event)
                .find((event) => event?.type === 'scroll-write' && event.reason === 'entry-restore');
            expect(entryWriteEvent).toBeTruthy();
            telemetrySink.mockClear();

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'n1', localId: null, createdAt: 1, seq: 1, text: 'alpha' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState, id: 'session-2' }} />);
            await screen.settle({ turns: 2 });

            const disposalDecision = telemetrySink.mock.calls
                .map(([event]) => event)
                .find((event) =>
                    event?.type === 'restore-decision' &&
                    event.reason === 'skipped' &&
                    event.sessionId === entryWriteEvent.sessionId);
            expect(disposalDecision).toMatchObject({
                orientation: 'inverted',
            });

            await screen.unmount();
        });
    });

    it('telemeters a skipped entry-restore decision when unmount disposes an open transaction (audit: never silent)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 64,
                sink: telemetrySink,
            });
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 355,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await primeFlashListMetrics(727, 21758, { turns: 2 });

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 355, animated: false });
            const entryWriteEvent = telemetrySink.mock.calls
                .map(([event]) => event)
                .find((event) => event?.type === 'scroll-write' && event.reason === 'entry-restore');
            expect(entryWriteEvent).toBeTruthy();
            telemetrySink.mockClear();

            await screen.unmount();

            const disposalDecision = telemetrySink.mock.calls
                .map(([event]) => event)
                .find((event) =>
                    event?.type === 'restore-decision' &&
                    event.reason === 'skipped' &&
                    event.sessionId === entryWriteEvent.sessionId);
            expect(disposalDecision).toMatchObject({
                orientation: 'inverted',
            });
        });
    });

    it('ends a follow-bottom entry at the true bottom after late content settle (plan P3 one-shot re-confirm)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 900;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex: vi.fn(),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 1 });
            await settleNativeFlashListMount(screen);
            // The entry pin target is observed at the bottom (the on-device sequence):
            // the initial viewport is applied and the settle re-confirm arms.
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );
            scrollToOffset.mockClear();

            // Late content settle AFTER the entry applied: rows re-measure taller while the
            // scroll offset stays where the entry pin left it — the viewport now sits 600px
            // above the true bottom while the mode machine still says 'following'.
            await triggerFlashListChatListContentSizeChange(320, 1600, { turns: 2 });
            nativeScrollOffset = 900;
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 1600 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );

            // In the canonical inverted path, the re-confirm is owned by FlashList bottom
            // maintenance rather than a derived standard-space scrollToOffset(max) write.
            expect(scrollToOffset).not.toHaveBeenCalled();

            // The re-confirm is one-shot: further churn frames never spend another write.
            scrollToOffset.mockClear();
            await triggerFlashListChatListContentSizeChange(320, 1700, { turns: 2 });
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 1700 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).not.toHaveBeenCalledWith({ offset: 1600, animated: false });

            await screen.unmount();
        });
    });

    it('keeps follow-bottom and re-pins through an untouched streaming burst with a stale offset (plan P3 no-touch escape)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 900;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex: vi.fn(),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionState = { ...sessionState, active: true };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 1 });
            await settleNativeFlashListMount(screen);
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );
            scrollToOffset.mockClear();

            // Streaming burst with NO touch: new committed activity + a large growth while
            // the scroll offset is still stale. The offset-escape heuristic must not release
            // follow (B6: no touch attribution => no release)...
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...sessionMessagesState.messages,
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'burst' },
                ],
            };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1', seq: 2 }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ turns: 2 });
            await triggerFlashListChatListContentSizeChange(320, 1600, { turns: 2 });

            // ...and the entry settle path must preserve follow-bottom without a JS
            // standard-space scrollToOffset(max) write.
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 1600 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );

            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: true,
            });

            await screen.unmount();
        });
    });

    it('ignores recycled native scroll offsets before the next session has measured its transcript', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            let activeSessionId = 'session-1';
            const onSession1ViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            const onSession2ViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-2', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onSession1ViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            onSession1ViewportChange.mockClear();
            await scrollFlashListTo(400, { trusted: true, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 500,
                source: 'observed',
            });

            sessionViewportByIdState.set('session-2', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            activeSessionId = 'session-2';
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'b1', localId: null, createdAt: 1, seq: 1, text: 'alpha' },
                    { kind: 'agent-text', id: 'b2', localId: null, createdAt: 2, seq: 2, text: 'beta' },
                ],
            };

            await screen.update(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onSession2ViewportChange} />,
            );
            await screen.settle({ turns: 1 });
            onSession2ViewportChange.mockClear();

            await scrollFlashListTo(400, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-2')).toMatchObject({
                isPinned: false,
                offsetY: 200,
                source: 'observed',
            });
            expect(onSession2ViewportChange).not.toHaveBeenCalled();
        });
    });

    it('does not let passive native bottom drift erase a restored unpinned session viewport', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            let activeSessionId = 'session-1';
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore(activeSessionId, state);
            });
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 200,
                animated: false,
            });

            onViewportChange.mockClear();
            await scrollFlashListTo(900, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 200,
                source: 'observed',
            });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                shouldRestoreViewport: false,
            }));
        });
    });

    it('keeps native unpinned restore visibly unpinned when the first passive observation lands off target', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            settingValues.transcriptScrollJumpToBottomEnabled = true;
            settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
            settingValues.transcriptScrollJumpToBottomRevealViewportRatio = 0.5;
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 200,
                animated: false,
            });
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            onViewportChange.mockClear();
            await scrollFlashListTo(0, { trusted: false, turns: 1 });
            await screen.settle({
                advanceTimersMs:
                    syncTuningState.transcriptInitialFillBudgetMs +
                    syncTuningState.transcriptMountSettleQuiescentWindowMs * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
            expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 200,
                source: 'observed',
            });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                offsetY: 900,
                shouldRestoreViewport: true,
            }));
        });
    });

    it('preserves passive native movement near the bottom after the user leaves the tail', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn();
            const dateNowSpy = vi.spyOn(Date, 'now');
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            try {
                dateNowSpy.mockReturnValue(0);
                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
                );

                await primeFlashListMetrics(100, 1000, { turns: 4 });
                await scrollFlashListTo(800, { trusted: true, turns: 1 });

                onViewportChange.mockClear();
                dateNowSpy.mockReturnValue(1000);
                await scrollFlashListTo(780, { trusted: false, turns: 1 });

                expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                    isPinned: false,
                    offsetY: 120,
                    shouldRestoreViewport: true,
                }));
            } finally {
                dateNowSpy.mockRestore();
            }
        });
    });

    it('persists passive native movement after a restored unpinned viewport is applied', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 1 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 200,
                animated: false,
            });
            flashListRefHandle.computeVisibleIndices.mockClear();

            await scrollFlashListTo(700, { trusted: false, turns: 1 });
            onViewportChange.mockClear();
            await vi.advanceTimersByTimeAsync(501);
            await scrollFlashListTo(600, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 300,
                source: 'observed',
            });
            expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                isPinned: false,
                offsetY: 300,
                shouldRestoreViewport: true,
            }));
        });
    });

    it('preserves the native visible anchor when older messages prepend above an unpinned reader', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            onViewportChange.mockClear();
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });

            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                source: 'observed',
            });
            scrollToIndex.mockClear();

            await triggerFlashListChatListEndReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                source: 'observed',
            });

            await screen.unmount();
        });
    });

    it('uses the exact target window without installing a prepend restore for a missing durable entry anchor', async () => {
        type TargetWindowSyncMock = {
            loadTargetWindowMessages: ReturnType<typeof vi.fn>;
        };
        const syncMod = await import('@/sync/sync');
        const loadTargetWindowMessagesMock = vi.mocked(
            (syncMod.sync as unknown as TargetWindowSyncMock).loadTargetWindowMessages,
        );
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorOlderLookupMaxLoads: 1,
            };
            const scrollToIndex = vi.fn();
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(100)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: 20 + index * 120, width: 320, height: 100 })),
            };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 300,
                anchor: {
                    kind: 'message',
                    messageId: 'm1',
                    itemId: 'm1',
                    itemOffsetPx: 40,
                    seq: 1,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadTargetWindowMessagesMock.mockImplementation(async (sessionId: string, target: { kind: 'seq'; seq: number }) => {
                expect(sessionId).toBe('session-1');
                expect(target).toEqual({ kind: 'seq', seq: 1 });
                publishSessionMessagesStateForTest({
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                });
                setSessionTargetWindowStateForTest(sessionId, {
                    isWindowMode: true,
                    windowId: 'target:session-1:1',
                    targetSeq: target.seq,
                    windowMinSeq: 1,
                    windowMaxSeq: 5,
                    olderCursor: null,
                    newerCursor: 5,
                    hasMoreOlder: false,
                    hasMoreNewer: false,
                    activatedAtMs: 1,
                });
                return {
                    status: 'loaded',
                    targetPresent: true,
                };
            });
            loadTargetWindowMessagesMock.mockClear();
            loadOlderMessagesMock.mockClear();
            viewportControllerMockState.resolveInputs = [];

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            expect(loadTargetWindowMessagesMock).toHaveBeenCalledWith(
                'session-1',
                { kind: 'seq', seq: 1 },
                { direction: 'initial' },
            );
            expect(loadTargetWindowMessagesMock).toHaveBeenCalledTimes(1);
            expect(loadOlderMessagesMock).not.toHaveBeenCalled();

            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(scrollToIndex).toHaveBeenCalledWith({
                index: 4,
                animated: false,
                viewOffset: -40,
            });
            expect(viewportControllerMockState.resolveInputs).not.toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: 'restore-anchor',
                    reason: 'prepend-restore',
                }),
            ]));

            await screen.unmount();
        });
    });

    it('captures a native prepend anchor when older loading starts after the first drag observation', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 500,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });

            scrollToIndex.mockClear();
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListEndReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(scrollToOffset).not.toHaveBeenCalled();

            await screen.unmount();
        });
    });

    it('does not rearm native bottom-follow on drag end when no scroll observation arrived before an older-edge nudge', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 500,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });

            await triggerFlashListChatListEndReached({ turns: 2 });
            expect(loadOlderMessagesMock).not.toHaveBeenCalled();

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollEndDrag?.({});
            });
            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).not.toHaveProperty(
                'autoscrollToBottomThreshold',
            );

            scrollToIndex.mockClear();
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(viewportControllerMockState.resolveInputs).not.toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: 'auto-follow',
                }),
            ]));

            await screen.unmount();
        });
    });

    it('keeps the original native prepend anchor when passive scroll events fire while older messages load', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            let visibleIndex = 1;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: visibleIndex, endIndex: visibleIndex })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            let resolveLoadOlder = createMissingLoadOlderResolver();
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            nativeScrollOffset = 100;
            visibleIndex = 1;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            scrollToIndex.mockClear();

            await triggerFlashListChatListEndReached({ turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            visibleIndex = 0;
            nativeScrollOffset = 200;
            await vi.advanceTimersByTimeAsync(501);
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    ...sessionMessagesState.messages,
                ],
            };
            resolveLoadOlder({ loaded: 2, hasMore: true, status: 'loaded' });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(scrollToOffset).not.toHaveBeenCalled();

            await screen.unmount();
        });
    });

    it('keeps an inverted older-page append write-free across later passive frames', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 800,
                source: 'observed',
            });

            await triggerFlashListChatListEndReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(scrollToOffset).not.toHaveBeenCalled();

            onViewportChange.mockClear();
            scrollToOffset.mockClear();
            await vi.advanceTimersByTimeAsync(501);
            await triggerFlashListChatListScroll(
                0,
                {
                    contentSize: { height: 2200 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );

            // Inverted older history appends at the rendered data end, so the
            // standard prepend fallback writer is never involved.
            expect(scrollToOffset).not.toHaveBeenCalled();
            expectNoNonBottomScrollToIndexWrites(scrollToIndex);

            await screen.unmount();
        });
    });

    it('never spends a corrective prepend write for an inverted older-page append', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 64,
                sink: telemetrySink,
            });
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            let visibleRange = { startIndex: 1, endIndex: 1 };
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => visibleRange),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 800,
                source: 'observed',
            });

            await triggerFlashListChatListEndReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(scrollToOffset).not.toHaveBeenCalled();

            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                reason: 'prepend-restore',
            }));

            onViewportChange.mockClear();
            telemetrySink.mockClear();
            scrollToOffset.mockClear();
            visibleRange = { startIndex: 3, endIndex: 3 };
            nativeScrollOffset = 300;
            await vi.advanceTimersByTimeAsync(501);
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 2200 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );

            // A later passive frame still never opens the old standard prepend writer.
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                reason: 'prepend-restore',
            }));

            await screen.unmount();
        });
    });

    it('keeps inverted older-page append write-free even when content re-measures without a follow-up scroll event', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            let visibleRange = { startIndex: 1, endIndex: 1 };
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => visibleRange),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            await triggerFlashListChatListEndReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(scrollToOffset).not.toHaveBeenCalled();

            scrollToOffset.mockClear();
            visibleRange = { startIndex: 3, endIndex: 3 };
            nativeScrollOffset = 300;

            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            // A re-measure without a follow-up scroll event still never creates a
            // standard prepend write for inverted older-page append.
            expect(scrollToOffset).not.toHaveBeenCalled();

            await screen.unmount();
        });
    });

    it('keeps inverted older-page append write-free through the layout-quiet window', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 64,
                sink: telemetrySink,
            });
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            await triggerFlashListChatListEndReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });

            // First post-commit observation: under inverted native the older page appended
            // at the rendered data end, so the old prepend fallback path must stay idle.
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3 });
            expect(scrollToOffset).not.toHaveBeenCalled();
            expectNoNonBottomScrollToIndexWrites(scrollToIndex);

            // A later offset observation still must not spend a standard prepend write.
            nativeScrollOffset = 340;
            await vi.advanceTimersByTimeAsync(150);

            expect(scrollToOffset).not.toHaveBeenCalled();
            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                reason: 'prepend-restore',
            }));

            await screen.unmount();
        });
    });

    it('does not create a prepend write for an inverted older-page append after the offset-correction bridge removal', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 64,
                sink: telemetrySink,
            });
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            await triggerFlashListChatListEndReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });

            // First post-commit observation: anchor moved down by the prepended 240px while
            // the scroll-offset reading is stale → misaligned, quiet gate waiting.
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3 });
            expect(scrollToOffset).not.toHaveBeenCalled();

            // Exhaust the quiet window and any pending observation timers.
            await vi.advanceTimersByTimeAsync(300);
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });
            await vi.advanceTimersByTimeAsync(300);

            // The deleted vendor corrector bridge is irrelevant for the inverted append path:
            // zero standard prepend writes, and no synthetic mvcp-preserved close is required.
            expect(scrollToOffset).not.toHaveBeenCalled();
            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                reason: 'prepend-restore',
            }));

            await screen.unmount();
        });
    });

    it('requires a threshold exit and re-entry before loading another older page after a prepend restore', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            let visibleRange = { startIndex: 1, endIndex: 1 };
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => visibleRange),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                if (loadOlderMessagesMock.mock.calls.length === 1) {
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                            ...sessionMessagesState.messages,
                        ],
                    };
                    return { loaded: 2, hasMore: true, status: 'loaded' as const };
                }
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm-1', localId: null, createdAt: -1, seq: -1, text: 'minus one' },
                        { kind: 'agent-text', id: 'm0', localId: null, createdAt: 0, seq: 0, text: 'zero' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            await triggerFlashListChatListEndReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(scrollToOffset).not.toHaveBeenCalled();

            visibleRange = { startIndex: 3, endIndex: 3 };
            nativeScrollOffset = 340;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 2200 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );
            await vi.advanceTimersByTimeAsync(251);
            await screen.settle({ cycles: 1, turns: 4 });

            // Sitting outside the threshold after the restore: cooldown elapsing alone never
            // chains another load (E6 anti-burst).
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            // Re-entering the threshold after the observed exit re-arms exactly one more load.
            nativeScrollOffset = 10;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 2200 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            await screen.settle({ cycles: 1, turns: 4 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(2);

            await screen.unmount();
        });
    });

    it('cancels pending native prepend restore when a trusted user scroll continues after the restore command', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 800,
                source: 'observed',
            });

            await triggerFlashListChatListEndReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(scrollToOffset).not.toHaveBeenCalled();

            onViewportChange.mockClear();
            scrollToOffset.mockClear();
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            await vi.advanceTimersByTimeAsync(501);
            nativeScrollOffset = 200;
            await triggerFlashListChatListScroll(
                200,
                {
                    contentSize: { height: 2200 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 1900,
                source: 'observed',
            });
            expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                offsetY: 1900,
                shouldRestoreViewport: true,
            }));
            expect(scrollToOffset).not.toHaveBeenCalled();

            await screen.unmount();
        });
    });

    it('lets a trusted native scroll supersede pending prepend restore before alignment', async () => {
        const syncMod = await import('@/sync/sync');
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 64,
                sink: telemetrySink,
            });
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            let visibleIndex = 1;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: visibleIndex, endIndex: visibleIndex })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            await triggerFlashListChatListEndReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(scrollToOffset).not.toHaveBeenCalled();

            onViewportChange.mockClear();
            telemetrySink.mockClear();
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });

            visibleIndex = 3;
            nativeScrollOffset = 1970;
            await vi.advanceTimersByTimeAsync(501);
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 2200 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            onViewportChange.mockClear();
            telemetrySink.mockClear();
            await triggerFlashListChatListScroll(
                1950,
                {
                    contentSize: { height: 2200 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 150,
                source: 'observed',
            });
            expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                offsetY: 150,
                shouldRestoreViewport: true,
            }));
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-observed',
                reason: 'pending',
                offsetY: 1950,
                distanceFromBottom: 150,
            }));

            await screen.unmount();
        });
    });

    it('reaches the bottom from one explicit jump under content churn with a single bounded re-confirm (plan B7 field trace)', async () => {
        // Field trace (H2/B7): jump write computed against a churning content height
        // (15558 -> 14505 -> 13019 -> 14799) landed at ~93% with restore-decision skips
        // firing afterwards. Contract: one tap -> validated bottom write (scrollToEnd),
        // entry restore preempted before the write, at most ONE explicit re-confirm on
        // churn, zero non-explicit restore writes, final dfb = 0 live-tail emission.
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            const scrollToIndex = vi.fn();
            const scrollToEnd = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex, scrollToEnd };
            const onViewportChange = vi.fn();
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 657,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(667, 35736, { turns: 2 });

            // Entry restore issued its one-shot distance write; transaction is still open.
            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 657, animated: false });
            scrollToOffset.mockClear();

            // Inconclusive observation keeps the transaction open and reveals the affordance.
            await triggerFlashListChatListScroll(
                33018,
                {
                    contentSize: { height: 33818 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );

            const jumpButton = screen.findByTestId('transcript-jump-to-bottom');
            expect(jumpButton).toBeTruthy();
            await act(async () => {
                jumpButton?.props.onPress();
            });

            // Continuous bottom placement is renderer-owned on this FlashList surface. The
            // host commits the explicit live-tail intent without a competing JS offset write.
            expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            }));
            expect(scrollToOffset).not.toHaveBeenCalled();

            // Content churn after the jump: the entry transaction was preempted, so a
            // conclusive misaligned observation must NOT spend an entry correction; the
            // explicit phase spends its single bounded re-confirm instead.
            await triggerFlashListChatListContentSizeChange(400, 34505, { turns: 1 });
            await triggerFlashListChatListScroll(
                20000,
                {
                    contentSize: { height: 34505 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).not.toHaveBeenCalled();

            // Further churn frames never write again (bounded re-confirm, not a loop).
            await triggerFlashListChatListContentSizeChange(400, 34799, { turns: 1 });
            await triggerFlashListChatListScroll(
                21000,
                {
                    contentSize: { height: 34799 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).not.toHaveBeenCalled();

            // Bottom arrival emits live-tail (mode and emission agree).
            onViewportChange.mockClear();
            await triggerFlashListChatListScroll(
                34132,
                {
                    contentSize: { height: 34799 },
                    layoutMeasurement: { height: 667 },
                },
                { turns: 1 },
            );
            expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                offsetY: 0,
                shouldPersistViewport: false,
                shouldRestoreViewport: false,
            }));
        });
    });

    it('closes an open prepend transaction when the user jumps to bottom (plan B7 explicit preempt)', async () => {
        const syncMod = await import('@/sync/sync');
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 128,
            };
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 128,
                sink: telemetrySink,
            });
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            const scrollToEnd = vi.fn();
            let nativeScrollOffset = 100;
            let layoutReady = true;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                scrollToEnd,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => (
                    layoutReady ? { x: 0, y: resolveLayoutY(index), width: 320, height: 100 } : undefined
                )),
            };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };
            loadOlderMessagesMock.mockImplementation(async () => {
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ...sessionMessagesState.messages,
                    ],
                };
                return { loaded: 2, hasMore: true, status: 'loaded' as const };
            });
            loadOlderMessagesMock.mockClear();

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            // Prepend lands and commits, but its single observation window stays open
            // (anchor layout not ready after the prepend re-render).
            await triggerFlashListChatListEndReached({ turns: 2 });
            layoutReady = false;
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });
            expect(scrollToOffset).not.toHaveBeenCalled();

            telemetrySink.mockClear();
            const jumpButton = screen.findByTestId('transcript-jump-to-bottom');
            expect(jumpButton).toBeTruthy();
            await act(async () => {
                jumpButton?.props.onPress();
            });

            // There is no standard prepend transaction in the inverted append path; the
            // jump remains an explicit owner write and must not create a prepend restore.
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                reason: 'jump-to-bottom',
                writer: 'native-explicit-jump',
            }));

            // After the jump, the late-arriving layout must never produce a prepend
            // restore write nor an owner-conflict rejection.
            layoutReady = true;
            await triggerFlashListChatListContentSizeChange(320, 2210, { turns: 2 });
            await triggerFlashListChatListScroll(
                2110,
                {
                    contentSize: { height: 2210 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write-rejected',
            }));
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                reason: 'prepend-restore',
            }));

            await screen.unmount();
        });
    });

    it('clears the web prepend restore window when the user jumps to bottom so the stale anchor does not re-assert on subsequent content growth', async () => {
        const syncMod = await import('@/sync/sync');
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockImplementation(async () => {
            scrollEl.scrollHeight = 1800;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });
        loadOlderMessagesMock.mockClear();

        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 64,
            sink: telemetrySink,
        });

        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 800,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 64,
        };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                // Prime follow mode at bottom.
                await primeFlashListMetrics(600, 1200);
                scrollEl.scrollHeight = 1200;
                loadOlderMessagesMock.mockClear();

                // Prime follow mode: scroll to 600 (bottom) so the lifecycle arms follow.
                await scrollFlashListTo(600);

                // Now scroll up to trigger the older-message load. The anchor is captured
                // at scrollTop=100 before the load fires.
                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 3 });
                expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
                // Growth restore: 100 + (1800 - 1200) = 700.
                expect(scrollEl.scrollTop).toBe(700);

                // JTB is visible: dfb = 1800 - 600 - 700 = 500 > threshold.
                const jumpButton = screen.findByTestId('transcript-jump-to-bottom');
                expect(jumpButton).toBeTruthy();
                telemetrySink.mockClear();
                await act(async () => {
                    jumpButton?.props.onPress();
                });
                // The web pin-bottom command writes targetScrollTop = scrollHeight (not
                // scrollHeight - clientHeight); real browsers clamp, the test mock does not.
                expect(scrollEl.scrollTop).toBe(1800);

                // Simulate content growing substantially (another older-message page arriving).
                // Without Fix 1, the stale anchor fires a growth restore:
                //   target = 100 + (3600 - 1200) = 2500, remaining = 2500 - 1800 = 700 → writes.
                // With Fix 1, JTB clears the anchor so observePending() → [] → no restore.
                scrollEl.scrollHeight = 3600;
                await triggerFlashListChatListContentSizeChange(0, 3600, { turns: 2 });

                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    reason: 'prepend-restore',
                }));
                // scrollTop must NOT be the stale growth target.
                expect(scrollEl.scrollTop).not.toBe(2500);

                await screen.unmount();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('does not drag the viewport back when the user scrolled above the last prepend restore target before the scroll event fires (race with layout effect)', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockImplementation(async () => {
            scrollEl.scrollHeight = 1800;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                // Prime follow mode at bottom.
                await primeFlashListMetrics(600, 1200);
                scrollEl.scrollHeight = 1200;
                loadOlderMessagesMock.mockClear();
                await scrollFlashListTo(600);

                // Trigger first prepend load: anchor captured at scrollTop=100, scrollHeight=1200.
                // Restore writes to 100 + (1800 - 1200) = 700.
                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 3 });
                expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
                expect(scrollEl.scrollTop).toBe(700);

                // Simulate the browser race: user presses PageUp so scrollTop changes
                // synchronously in the DOM BEFORE the scroll event fires. In the browser,
                // the layout effect (triggered by a markdown remeasure) fires BEFORE the
                // scroll event, so observeWeb() sees the stale anchor and tries to drag back.
                // Reproduce by setting scrollTop directly without firing a scroll ingress.
                scrollEl.scrollTop = 200;

                // Content height changes slightly (e.g., markdown row expansion).
                // This triggers the layout effect via listContentHeightRef, but no scroll event.
                scrollEl.scrollHeight = 1820;
                await triggerFlashListChatListContentSizeChange(0, 1820, { turns: 2 });

                // Without Fix 2: growth restore fires — target = 100 + (1820 - 1200) = 720,
                //   remaining = 720 - 200 = 520 → writes to 720 (drags user back).
                // With Fix 2: guard detects scrollTop(200) < lastRestoreTarget(700) - 32,
                //   clears the anchor → no restore → scrollTop stays at 200.
                expect(scrollEl.scrollTop).toBe(200);

                await screen.unmount();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('abandons the prepend transaction when the user scrolls before prepended rows materialize (MVCP holds, zero writes)', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                getLayout: vi.fn((index: number) => ({ x: 0, y: resolveLayoutY(index), width: 320, height: 100 })),
            };
            let resolveLoadOlder = createMissingLoadOlderResolver();
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                    { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                    { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 800;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );
            nativeScrollOffset = 100;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            await triggerFlashListChatListEndReached({ turns: 2 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            resolveLoadOlder({ loaded: 2, hasMore: true, status: 'loaded' });
            await screen.settle({ turns: 3 });

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            nativeScrollOffset = 120;
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    ...sessionMessagesState.messages,
                ],
            };
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            // LC-R #5: a trusted user scroll preempts the in-flight transaction with ZERO
            // writes — MVCP alone holds the position under the finger.
            expectNoNonBottomScrollToIndexWrites(scrollToIndex);
            expect(scrollToOffset).not.toHaveBeenCalled();

            await screen.unmount();
        });
    });

    it('does not let passive native bottom observations erase an active unpinned reader viewport', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            let resolveLoadOlder = createMissingLoadOlderResolver();
            loadOlderMessagesMock.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveLoadOlder = resolve;
                    }),
            );
            loadOlderMessagesMock.mockClear();
            let nativeScrollOffset = 0;
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(nativeScrollOffset)),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 1 })),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index * 100,
                    width: 320,
                    height: 100,
                })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            await triggerFlashListChatListScroll(
                800,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: true,
                },
                { turns: 1 },
            );

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });

            nativeScrollOffset = 100;
            await triggerFlashListChatListEndReached({ turns: 1 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            onViewportChange.mockClear();

            nativeScrollOffset = 900;
            await triggerFlashListChatListScroll(
                900,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                shouldRestoreViewport: false,
            }));

            resolveLoadOlder({ loaded: 0, hasMore: true, status: 'loaded' });
            await screen.unmount();
        });
    });

    it('does not capture stale native anchors for passive unpinned movement', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 0 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(700)),
                getLayout: vi.fn(() => ({ x: 0, y: 720, width: 320, height: 80 })),
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 200,
                animated: false,
            });

            await scrollFlashListTo(700, { trusted: false, turns: 1 });
            onViewportChange.mockClear();
            await vi.advanceTimersByTimeAsync(501);
            await scrollFlashListTo(600, { trusted: false, turns: 1 });
            await vi.advanceTimersByTimeAsync(syncTuningState.transcriptViewportAnchorCaptureDebounceMs + 1);

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 300,
                anchor: null,
                source: 'observed',
            });
            expect(onViewportChange.mock.calls.every(([state]) => state.anchor == null)).toBe(true);
        });
    });

    it('does not let delayed passive native bottom drift erase a newly unpinned session viewport', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            onViewportChange.mockClear();
            await scrollFlashListTo(800, { trusted: true, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });

            onViewportChange.mockClear();
            await vi.advanceTimersByTimeAsync(501);
            await scrollFlashListTo(900, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                isPinned: true,
                shouldRestoreViewport: false,
            }));
        });
    });

        it('corrects the native distance restore once on a conclusive misalignment instead of timer retries', async () => {
            // Plan invariant C: content growth before the restore is observed never re-issues
            // by timer; only a conclusive misaligned observation spends the single correction.
            await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 100,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 2 });
            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 100, animated: false });
            scrollToOffset.mockClear();

            // Content growth alone: no write (E1 deleted).
            await triggerFlashListChatListContentSizeChange(400, 1200, { turns: 2 });
            expect(scrollToOffset).not.toHaveBeenCalled();
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).not.toHaveBeenCalled();

            // A conclusive misaligned observation at the grown basis drives the correction.
            await triggerFlashListChatListScroll(
                600,
                {
                    contentSize: { height: 1200 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );
            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 100, animated: false });
            scrollToOffset.mockClear();

            // Confirmed at the corrected target; nothing writes afterwards.
            await triggerFlashListChatListScroll(
                1000,
                {
                    contentSize: { height: 1200 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );
            await screen.settle({
                advanceTimersMs: 401,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).not.toHaveBeenCalled();
            });
        });

        it('defers automatic native follow-bottom pins until mount settle is stable', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                syncTuningState = {
                    ...syncTuningState,
                    transcriptNativeHotTailItemCount: 2,
                };
                const scrollToOffset = vi.fn();
                flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    ],
                };

                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState, id: 'session-1' }} />,
                );

                await primeFlashListMetrics(100, 1000, { turns: 4 });
                expect(scrollToOffset).not.toHaveBeenCalled();
                await settleNativeFlashListMount(screen);

                expect(scrollToOffset).not.toHaveBeenCalled();
            });
        });

        it('uses native drag intent to release bottom follow when scroll events are not trusted', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

            onViewportChange.mockClear();
            screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
            await scrollFlashListTo(800, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 100,
                source: 'observed',
            });
            expect(onViewportChange).toHaveBeenLastCalledWith(expect.objectContaining({
                isPinned: false,
                offsetY: 100,
                shouldRestoreViewport: true,
            }));
        });
    });

    it('scrolls to a data-resolved anchor and applies the single DOM correction after the row mounts', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getLayout: vi.fn((index: number) => (
                    index === 1 ? { x: 0, y: 160, width: 0, height: 100 } : undefined
                )),
            };
            syncTuningState = { ...syncTuningState, transcriptWebHotTailItemCount: 0 };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 300,
                anchor: {
                    kind: 'message',
                    messageId: 'm2',
                    itemId: 'm2',
                    itemOffsetPx: 40,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                ],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2 });

                    // Anchor is not yet in the FlashList render window. scrollToIndex is called
                    // to bring it into view; the retry (via listContentHeight useLayoutEffect)
                    // will find the anchor via direct DOM lookup once FlashList renders the row.
                    expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                        index: 1,
                        animated: false,
                    }));
                    expect(scroller.scrollTop).toBe(0);
                    expect(loadOlderMessagesMock).not.toHaveBeenCalled();

                    const itemAnchor = createFlashListChatListWebElement('transcript-item-m2', { top: 160, bottom: 260 });
                    const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m2', { top: 170, bottom: 220 });
                    messageAnchor.parentElement = itemAnchor;
                    scroller.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);

                    await primeFlashListMetrics(100, 1001, { turns: 2, frames: 1 });
                    await screen.settle({ turns: 1, runOnlyPendingTimers: true });

                    // Direct DOM lookup on the retry: resolves to item anchor (transcript-item-m2,
                    // top=160), then delta = 160 - itemOffsetPx(40) = 120.
                    expect(scroller.scrollTop).toBe(120);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('resolves anchor indexes by message id across message, tool-group, and turn rows', async () => {
        const cases: Array<{
            label: string;
            configure: () => void;
            expectedIndex: number;
            messageId: string;
        }> = [
            {
                label: 'message',
                expectedIndex: 1,
                messageId: 'm2',
                configure: () => {
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                        ],
                    };
                },
            },
            {
                // N2c: the anchor resolves to the exact tool unit row (header is index 0).
                label: 'tool-group',
                expectedIndex: 1,
                messageId: 'tool-1',
                configure: () => {
                    settingValues.transcriptGroupToolCalls = true;
                    settingValues.toolViewTimelineChromeMode = 'activity_feed';
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'tool-call', id: 'tool-1', localId: null, createdAt: 1, seq: 1, tool: { name: 'shell' } },
                        ],
                    };
                },
            },
            {
                // N2c decomposition: msg:m1 (0), group header (1), tool unit (2), footer (3).
                label: 'turn',
                expectedIndex: 2,
                messageId: 'tool-2',
                configure: () => {
                    settingValues.transcriptGroupingMode = 'turns';
                    transcriptTurnsState = [{
                        id: 'turn-1',
                        userMessageId: 'm1',
                        content: [{ kind: 'tool_calls', id: 'turn-tools', toolMessageIds: ['tool-2'] }],
                    }];
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                            { kind: 'tool-call', id: 'tool-2', localId: null, createdAt: 2, seq: 2, tool: { name: 'shell' } },
                        ],
                    };
                },
            },
            {
                // N2c: tool-5 is hidden behind the collapsed preview tail — the anchor
                // falls back to the containing group HEADER unit (index 0).
                label: 'projected oversized turn tool group',
                expectedIndex: 0,
                messageId: 'tool-5',
                configure: () => {
                    const toolMessageIds = Array.from({ length: 10 }, (_, index) => `tool-${index + 1}`);
                    syncTuningState = {
                        ...syncTuningState,
                        transcriptMaxTurnEntriesPerListItem: 4,
                    };
                    settingValues.transcriptGroupingMode = 'turns';
                    transcriptTurnsState = [{
                        id: 'turn-tools',
                        userMessageId: null,
                        content: [{
                            kind: 'tool_calls',
                            id: 'turn-tools-group',
                            toolMessageIds,
                        }],
                    }];
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: toolMessageIds.map((id, index) => ({
                            kind: 'tool-call',
                            id,
                            localId: null,
                            createdAt: index + 1,
                            seq: index + 1,
                            tool: { name: 'shell' },
                        })),
                    };
                },
            },
        ];

        for (const testCase of cases) {
            runtimeMockState.platformOs = 'ios';
            renderedFlashListCount = 0;
            renderedMessageViewProps = [];
            renderedToolCallsGroupRowProps = [];
        renderedToolGroupUnitHeaderProps = [];
        renderedToolGroupUnitToolProps = [];
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            resetCanonicalSessionViewportTestState();
            settingValues.transcriptGroupingMode = 'linear';
            settingValues.transcriptGroupToolCalls = false;
            settingValues.toolViewTimelineChromeMode = 'cards';
            syncTuningState = {
                ...syncTuningState,
                transcriptMaxTurnEntriesPerListItem: 8,
            };
            transcriptTurnsState = [];
            testCase.configure();
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 999,
                anchor: {
                    kind: 'message',
                    messageId: testCase.messageId,
                    itemId: 'stale-row-id',
                    itemOffsetPx: 0,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(100, 1000, { turns: 2 });

            // N2b.2: the anchored entry resolves the SAME row the old write targeted, but
            // lands write-free with the data window starting at that row.
            expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
            const data: any[] = flashListChatListHarnessState.flashListProps?.data ?? [];
            const head = data[0];
            const headOwnsAnchor =
                (head?.kind === 'message' && head.messageId === testCase.messageId) ||
                (head?.kind === 'tool-group-tool' && head.toolMessageId === testCase.messageId) ||
                ((head?.kind === 'tool-group-header' || head?.kind === 'tool-calls-group') &&
                    Array.isArray(head.toolMessageIds) && head.toolMessageIds.includes(testCase.messageId));
            expect({ label: testCase.label, headId: head?.id, headOwnsAnchor }).toEqual({
                label: testCase.label,
                headId: head?.id,
                headOwnsAnchor: true,
            });
            await screen.unmount();
        }
    });

    it('records native entry-anchor restore through the viewport executor', async () => {
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        const telemetrySink = vi.fn();
        telemetryMod.transcriptViewportTelemetry.configure({
            enabled: true,
            capacity: 16,
            sink: telemetrySink,
        });
        syncTuningState = {
            ...syncTuningState,
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 16,
        };
        runtimeMockState.platformOs = 'ios';
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 999,
            anchor: {
                kind: 'message',
                messageId: 'm2',
                itemId: 'm2',
                itemOffsetPx: 24,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        // Nonzero saved anchor offsets are not compatible with write-free slicing:
        // the restore must preserve the offset by issuing the exact anchor write.
        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
            animated: false,
            index: 0,
            viewOffset: -24,
        });
        expect((flashListChatListHarnessState.flashListProps?.data ?? []).map((item: any) => item.id)).toEqual(['m2', 'm1']);
        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'restore-decision',
            reason: 'pending',
            mode: 'restore-anchor',
        }));
        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-write',
            reason: 'entry-restore',
            writer: 'native-scroll-to-index',
            targetOffsetY: 0,
        }));

        // Content growth never issues another entry write (E1): the transaction can
        // confirm via a conclusive observation or close at its deadline.
        flashListRefHandle.scrollToIndex.mockClear();
        flashListRefHandle.scrollToOffset.mockClear();
        await triggerFlashListChatListContentSizeChange(400, 1200, { turns: 2 });

        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
    });

    it('does not materialize an anchor omitted from the canonical transcript-id projection', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockClear();
        runtimeMockState.platformOs = 'ios';
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
            ],
        };
        sessionTranscriptIdsState = ['m1', 'm3'];
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 999,
            anchor: {
                kind: 'message',
                messageId: 'm2',
                itemId: 'm2',
                itemOffsetPx: 0,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalled();

        // The transcript-id projection is authoritative for committed membership. A message
        // object outside it must not be resurrected through a consumer-owned pagination path.
        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        expect((flashListChatListHarnessState.flashListProps?.data ?? []).map((item: any) => item.id)).toEqual(['m3', 'm1']);
        await screen.unmount();
    });

    it('falls back to the nearest earlier materialized row after older lookup confirms an anchored turn message disappeared', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' as const });
        loadOlderMessagesMock.mockClear();
        runtimeMockState.platformOs = 'ios';
        settingValues.transcriptGroupingMode = 'turns';
        transcriptTurnsState = [
            { id: 'turn-1', userMessageId: 'm1', content: [] },
            { id: 'turn-3', userMessageId: 'm3', content: [] },
        ];
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
            ],
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 999,
            anchor: {
                kind: 'message',
                messageId: 'm2',
                itemId: 'stale-turn-id',
                itemOffsetPx: 24,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        expect((flashListChatListHarnessState.flashListProps?.data ?? []).map((item: any) => item.id)).toEqual([
            'msg:m3',
            'msg:m1',
        ]);
        await screen.unmount();
    });

    it('restores a hydrated web anchor by durable seq when anchor ids are runtime-stale', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' as const });
        loadOlderMessagesMock.mockClear();
        flashListRefHandle = {
            scrollToOffset: vi.fn(),
            scrollToIndex: vi.fn(),
            getLayout: vi.fn((index: number) => (
                index === 1 ? { x: 0, y: 160, width: 0, height: 100 } : undefined
            )),
        };
        syncTuningState = { ...syncTuningState, transcriptWebHotTailItemCount: 0 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'new-runtime-m2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
            ],
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 300,
            anchor: {
                kind: 'message',
                messageId: 'server-m2',
                itemId: 'old-runtime-m2',
                seq: 2,
                itemOffsetPx: 40,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 100,
            scrollHeight: 1000,
            scrollTop: 0,
            testNodes: [],
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await primeFlashListMetrics(100, 1000, { turns: 2 });

                // Anchor is not yet in the FlashList render window. scrollToIndex is called to
                // bring the index-resolved item into view regardless of stale runtime ids.
                expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                    index: 1,
                    animated: false,
                }));
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                expect(scroller.scrollTop).toBe(0);
                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                await screen.unmount();
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('lets jumpToSeq take priority over a stored viewport anchor', async () => {
        runtimeMockState.platformOs = 'ios';
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 400,
            anchor: {
                kind: 'message',
                messageId: 'm1',
                itemId: 'm1',
                itemOffsetPx: 20,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} jumpToSeq={2} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
            index: 0,
            animated: true,
            viewPosition: 0.5,
        });
        expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'jump-to-seq',
                sessionId: 'session-1',
                seq: 2,
            }),
        ]));
        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalledWith(expect.objectContaining({
            viewOffset: 20,
        }));
    });

    it('retries a web jumpToSeq deep link after list layout is measurable', async () => {
        const messages = Array.from({ length: 360 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const maxScrollTop = 17600;
        const targetScrollTop = 11850;
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 18000,
            scrollTop: maxScrollTop,
            testNodes: [],
        });
        let layoutReady = false;
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                layoutReady && index === 300
                    ? { x: 0, y: 12000, width: 320, height: 100 }
                    : undefined
            )),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 2,
        };

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState, seq: 360 }} jumpToSeq={301} />,
                );
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                expect(scroller.scrollTop).toBe(maxScrollTop);

                layoutReady = true;
                await primeFlashListMetrics(400, 18000, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                expect(flashListRefHandle.getLayout).toHaveBeenCalledWith(300);
                // Unmounted targets nudge the renderer to re-anchor its window at the target
                // index (recycler can pin its window to the stale measured range after data
                // replacement); the DOM write below remains the offset owner.
                expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({ animated: false, index: 300 });
                expect(scroller.scrollTop).toBe(targetScrollTop);
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('materializes a target window and then scrolls the direct web jumpToSeq target after the window renders', async () => {
        type TargetWindowSyncMock = {
            loadTargetWindowMessages: ReturnType<typeof vi.fn>;
        };
        const syncMod = await import('@/sync/sync');
        const loadTargetWindowMessagesMock = vi.mocked(
            (syncMod.sync as unknown as TargetWindowSyncMock).loadTargetWindowMessages,
        );
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        const sparseMessages = [
            ...Array.from({ length: 10 }, (_, index) => {
                const seq = 303 + index;
                return {
                    kind: 'agent-text' as const,
                    id: `m${seq}`,
                    localId: null,
                    createdAt: seq,
                    seq,
                    text: `sparse older ${seq}`,
                };
            }),
            ...Array.from({ length: 16 }, (_, index) => {
                const seq = 437 + index;
                return {
                    kind: 'agent-text' as const,
                    id: `m${seq}`,
                    localId: null,
                    createdAt: seq,
                    seq,
                    text: `tail ${seq}`,
                };
            }),
        ];
        const targetWindowMessages = Array.from({ length: 10 }, (_, index) => {
            const seq = 327 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `target window ${seq}`,
            };
        });
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 12000,
            scrollTop: 11600,
            testNodes: [],
        });
        const targetItemAnchor = createScrollRelativeTranscriptItemElement(scroller, 'm331', 600, 100);
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => {
                const item = (flashListChatListHarnessState.flashListProps?.data ?? [])[index] as { id?: string } | undefined;
                return item?.id === 'm331'
                    ? { x: 0, y: 600, width: 320, height: 100 }
                    : undefined;
            }),
        };
        sessionMessagesState = {
            isLoaded: false,
            messages: sparseMessages,
        };
        sessionState = { ...sessionState, seq: 452 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 0,
        };
        loadTargetWindowMessagesMock.mockImplementation(async (sessionId: string, target: { kind: 'seq'; seq: number }) => {
            expect(sessionId).toBe('session-1');
            expect(target).toEqual({ kind: 'seq', seq: 331 });
            publishSessionMessagesStateForTest({
                isLoaded: true,
                messages: [
                    ...sparseMessages.slice(0, 10),
                    ...targetWindowMessages,
                    ...sparseMessages.slice(10),
                ],
            });
            scroller.setQuerySelectorAll('[data-testid]', [targetItemAnchor]);
            setSessionTargetWindowStateForTest(sessionId, {
                isWindowMode: true,
                windowId: 'target:session-1:331',
                targetSeq: 331,
                windowMinSeq: 327,
                windowMaxSeq: 336,
                olderCursor: 327,
                newerCursor: 336,
                hasMoreOlder: true,
                hasMoreNewer: true,
                activatedAtMs: 1,
            });
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
        loadOlderMessagesMock.mockResolvedValue({ loaded: 10, hasMore: true, status: 'loaded' as const });
        loadTargetWindowMessagesMock.mockClear();
        loadOlderMessagesMock.mockClear();
        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={331} />,
                );
                await primeFlashListMetrics(400, 12000, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                expect(loadTargetWindowMessagesMock).toHaveBeenCalledWith(
                    'session-1',
                    { kind: 'seq', seq: 331 },
                    expect.objectContaining({ direction: 'initial' }),
                );
                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                await screen.settle({ turns: 2 });

                const renderedIds = (flashListChatListHarnessState.flashListProps?.data ?? [])
                    .map((item: any) => item.id);
                expect(renderedIds).toContain('m331');
                expect(renderedIds).not.toContain('m303');
                expect(renderedIds).not.toContain('m437');
                const targetIndex = renderedIds.indexOf('m331');
                expect(targetIndex).toBeGreaterThanOrEqual(0);
                expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        type: 'jump-to-seq',
                        sessionId: 'session-1',
                        seq: 331,
                    }),
                ]));
                expect(scroller.scrollTop).toBe(450);
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('panel loaded-row jump lands at the exact loaded index when the row is mounted', async () => {
        // Rendered-window truth on web is DOM mount presence: a MOUNTED loaded row takes the
        // direct scroll path with an exact rect landing (unmounted loaded rows route through
        // target-window materialization instead — see the nav host wiring suite).
        const messages = Array.from({ length: 20 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const targetItemAnchor = createFlashListChatListWebElement('transcript-item-m11', { top: 150, bottom: 250 });
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 2000,
            scrollTop: 1600,
            testNodes: [targetItemAnchor],
        });
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                index === 10 ? { x: 0, y: 1000, width: 320, height: 100 } : undefined
            )),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 20 };

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const { transcriptNavigationPaneStore } = await import('./navigation/transcriptNavigationPaneStore');
                await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} />,
                );
                await primeFlashListMetrics(400, 2000, { turns: 2 });

                const result = await transcriptNavigationPaneStore.get('session-1').onEntryPress?.(
                    createNavigationEntry({ id: 'pin-m11', seq: 11, loaded: true }),
                );
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                expect(result).toEqual({ status: 'scrolled', target: { kind: 'seq', seq: 11 } });
                // Mounted target: exact rect landing (viewport-relative top 150 at scrollTop
                // 1600 → content top 1750; align top-with-offset for a pinned entry).
                expect(scroller.scrollTop).toBeGreaterThan(0);
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('panel far jump activates a target window and then lands from the materialized window', async () => {
        type TargetWindowSyncMock = {
            loadTargetWindowMessages: ReturnType<typeof vi.fn>;
        };
        const syncMod = await import('@/sync/sync');
        const loadTargetWindowMessagesMock = vi.mocked(
            (syncMod.sync as unknown as TargetWindowSyncMock).loadTargetWindowMessages,
        );
        const sparseMessages = Array.from({ length: 16 }, (_, index) => {
            const seq = 437 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `tail ${seq}`,
            };
        });
        const targetWindowMessages = Array.from({ length: 10 }, (_, index) => {
            const seq = 327 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `target window ${seq}`,
            };
        });
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 12000,
            scrollTop: 11600,
            testNodes: [],
        });
        const targetItemAnchor = createScrollRelativeTranscriptItemElement(scroller, 'm331', 600, 100);
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => {
                const item = (flashListChatListHarnessState.flashListProps?.data ?? [])[index] as { id?: string } | undefined;
                return item?.id === 'm331'
                    ? { x: 0, y: 600, width: 320, height: 100 }
                    : undefined;
            }),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: sparseMessages,
        };
        sessionState = { ...sessionState, seq: 452 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 0,
        };
        loadTargetWindowMessagesMock.mockImplementation(async (sessionId: string, target: { kind: 'seq'; seq: number }) => {
            expect(sessionId).toBe('session-1');
            expect(target).toEqual({ kind: 'seq', seq: 331 });
            publishSessionMessagesStateForTest({
                isLoaded: true,
                messages: targetWindowMessages,
            });
            scroller.setQuerySelectorAll('[data-testid]', [targetItemAnchor]);
            setSessionTargetWindowStateForTest(sessionId, {
                isWindowMode: true,
                windowId: 'target:session-1:331',
                targetSeq: 331,
                windowMinSeq: 327,
                windowMaxSeq: 336,
                olderCursor: 327,
                newerCursor: 336,
                hasMoreOlder: true,
                hasMoreNewer: true,
                activatedAtMs: 1,
            });
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

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const { transcriptNavigationPaneStore } = await import('./navigation/transcriptNavigationPaneStore');
                await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} />,
                );
                await primeFlashListMetrics(400, 12000, { turns: 2 });
                const entry = createNavigationEntry({ id: 'pin-m331', seq: 331, loaded: false });

                let activationPromise: Promise<unknown> | undefined;
                await act(async () => {
                    activationPromise = Promise.resolve(
                        transcriptNavigationPaneStore.get('session-1').onEntryPress?.(entry),
                    );
                    await Promise.resolve();
                    await Promise.resolve();
                });
                let activation: unknown;
                await act(async () => {
                    activation = await activationPromise;
                });
                expect(sessionTargetWindowStateByIdState.get('session-1')).toMatchObject({
                    isWindowMode: true,
                    targetSeq: 331,
                });

                const renderedIds = (flashListChatListHarnessState.flashListProps?.data ?? [])
                    .map((item: any) => item.id);
                const targetIndex = renderedIds.indexOf('m331');
                expect(targetIndex).toBeGreaterThanOrEqual(0);
                expect(activation).toEqual({
                    status: 'window-rendered',
                    target: { kind: 'seq', seq: 331 },
                    windowId: 'target:session-1:331',
                });
                expect(scroller.scrollTop).toBe(450);
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('panel press while a target window is active can replace it with a different far window', async () => {
        type TargetWindowSyncMock = {
            loadTargetWindowMessages: ReturnType<typeof vi.fn>;
        };
        const syncMod = await import('@/sync/sync');
        const loadTargetWindowMessagesMock = vi.mocked(
            (syncMod.sync as unknown as TargetWindowSyncMock).loadTargetWindowMessages,
        );
        const activeWindowMessages = Array.from({ length: 10 }, (_, index) => {
            const seq = 327 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `active window ${seq}`,
            };
        });
        const replacementWindowMessages = Array.from({ length: 8 }, (_, index) => {
            const seq = 498 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `replacement window ${seq}`,
            };
        });
        sessionTargetWindowStateByIdState.set('session-1', {
            isWindowMode: true,
            windowId: 'target:session-1:331',
            targetSeq: 331,
            windowMinSeq: 327,
            windowMaxSeq: 336,
            olderCursor: 327,
            newerCursor: 336,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 1,
        });
        sessionMessagesState = {
            isLoaded: true,
            messages: activeWindowMessages,
        };
        sessionState = { ...sessionState, seq: 520 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 0,
        };
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 12000,
            scrollTop: 11600,
            testNodes: [],
        });
        const replacementItemAnchor = createScrollRelativeTranscriptItemElement(scroller, 'm501', 600, 100);
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => {
                const item = (flashListChatListHarnessState.flashListProps?.data ?? [])[index] as { id?: string } | undefined;
                return item?.id === 'm501'
                    ? { x: 0, y: 600, width: 320, height: 100 }
                    : undefined;
            }),
        };
        loadTargetWindowMessagesMock.mockImplementation(async (sessionId: string, target: { kind: 'seq'; seq: number }) => {
            expect(sessionId).toBe('session-1');
            expect(target).toEqual({ kind: 'seq', seq: 501 });
            publishSessionMessagesStateForTest({
                isLoaded: true,
                messages: replacementWindowMessages,
            });
            scroller.setQuerySelectorAll('[data-testid]', [replacementItemAnchor]);
            setSessionTargetWindowStateForTest(sessionId, {
                isWindowMode: true,
                windowId: 'target:session-1:501',
                targetSeq: 501,
                windowMinSeq: 498,
                windowMaxSeq: 505,
                olderCursor: 498,
                newerCursor: 505,
                hasMoreOlder: true,
                hasMoreNewer: true,
                activatedAtMs: 2,
            });
            return {
                status: 'loaded',
                windowId: 'target:session-1:501',
                targetSeq: 501,
                targetPresent: true,
                rawSeqs: replacementWindowMessages.map((message) => message.seq),
                appliedSeqs: replacementWindowMessages.map((message) => message.seq),
                olderCursor: 498,
                newerCursor: 505,
                hasMoreOlder: true,
                hasMoreNewer: true,
            };
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const { transcriptNavigationPaneStore } = await import('./navigation/transcriptNavigationPaneStore');
                await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} />,
                );
                await primeFlashListMetrics(400, 12000, { turns: 2 });

                let resultPromise: Promise<unknown> | undefined;
                await act(async () => {
                    resultPromise = Promise.resolve(
                        transcriptNavigationPaneStore.get('session-1').onEntryPress?.(
                            createNavigationEntry({ id: 'pin-m501', seq: 501, loaded: false }),
                        ),
                    );
                    await Promise.resolve();
                    await Promise.resolve();
                });
                let result: unknown;
                await act(async () => {
                    result = await resultPromise;
                });

                expect(loadTargetWindowMessagesMock).toHaveBeenCalledWith(
                    'session-1',
                    { kind: 'seq', seq: 501 },
                    expect.objectContaining({ direction: 'newer' }),
                );
                const renderedIds = (flashListChatListHarnessState.flashListProps?.data ?? []).map((item: any) => item.id);
                const replacementIds = new Set(replacementWindowMessages.map((message) => message.id));
                expect(renderedIds).toContain('m501');
                expect(renderedIds.length).toBeGreaterThan(0);
                expect(renderedIds.some((id: string) => activeWindowMessages.some((message) => message.id === id))).toBe(false);
                expect(result).toEqual({
                    status: 'window-rendered',
                    target: { kind: 'seq', seq: 501 },
                    windowId: 'target:session-1:501',
                });
                expect(scroller.scrollTop).toBe(450);
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('panel jump returns not-found only for a genuinely absent target', async () => {
        const messages = Array.from({ length: 20 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 2000,
            scrollTop: 1600,
            testNodes: [],
        });
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn(),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 20 };

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const { transcriptNavigationPaneStore } = await import('./navigation/transcriptNavigationPaneStore');
                await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} />,
                );
                await primeFlashListMetrics(400, 2000, { turns: 2 });

                const result = await transcriptNavigationPaneStore.get('session-1').onEntryPress?.(
                    createNavigationEntry({ id: 'pin-m999', seq: 999, loaded: true }),
                );

                expect(result).toEqual({ status: 'not-found', reason: 'unavailable' });
                expect(flashListRefHandle.getLayout).not.toHaveBeenCalled();
                expect(scroller.scrollTop).toBe(1600);
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('recognizes a direct web jumpToSeq target retained in the target-window projection', async () => {
        type TargetWindowSyncMock = {
            loadTargetWindowMessages: ReturnType<typeof vi.fn>;
        };
        const syncMod = await import('@/sync/sync');
        const loadTargetWindowMessagesMock = vi.mocked(
            (syncMod.sync as unknown as TargetWindowSyncMock).loadTargetWindowMessages,
        );
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        const sparseMessages = Array.from({ length: 16 }, (_, index) => {
            const seq = 437 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `tail ${seq}`,
            };
        });
        const targetWindowMessages = Array.from({ length: 150 }, (_, index) => {
            const seq = 182 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `target window ${seq}`,
            };
        });
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 12000,
            scrollTop: 11600,
            testNodes: [],
        });
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn(),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: sparseMessages,
        };
        sessionState = { ...sessionState, seq: 452 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 24,
        };
        loadTargetWindowMessagesMock.mockImplementation(async (sessionId: string, target: { kind: 'seq'; seq: number }) => {
            expect(sessionId).toBe('session-1');
            expect(target).toEqual({ kind: 'seq', seq: 331 });
            sessionTargetWindowStateByIdState.set(sessionId, {
                isWindowMode: true,
                windowId: 'target:session-1:331',
                targetSeq: 331,
                windowMinSeq: 182,
                windowMaxSeq: 331,
                olderCursor: 182,
                newerCursor: 331,
                hasMoreOlder: true,
                hasMoreNewer: true,
                activatedAtMs: 1,
            });
            sessionMessagesState = {
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
                olderCursor: 182,
                newerCursor: 331,
                hasMoreOlder: true,
                hasMoreNewer: true,
            };
        });
        loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: true, status: 'loaded' as const });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const forceRerenderEditPendingMessage = vi.fn();
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={331} />,
                );
                await primeFlashListMetrics(400, 12000, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                expect(loadTargetWindowMessagesMock).toHaveBeenCalledWith(
                    'session-1',
                    { kind: 'seq', seq: 331 },
                    expect.objectContaining({ direction: 'older' }),
                );

                const hotTailTarget = createFlashListChatListWebElement('transcript-web-hot-tail-item-m331', {
                    top: 900,
                    bottom: 1000,
                });
                scroller.setQuerySelectorAll('[data-testid]', [hotTailTarget]);
                await act(async () => {
                    screen.tree.update(
                        <ChatList
                            session={{ ...sessionState }}
                            jumpToSeq={331}
                            onEditPendingMessage={forceRerenderEditPendingMessage}
                        />,
                    );
                });
                await screen.settle({ turns: 2 });

                const renderedIds = (flashListChatListHarnessState.flashListProps?.data ?? [])
                    .map((item: any) => item.id);
                expect(renderedIds).toContain('m331');
                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('does not replay a stale distance write when a target-window anchor is renderer-owned', async () => {
        // J6-OFFSET regression: anchor seq=330 is item 148 of the 150-item target window
        // (seqs 182–331). On web, FlashList puts the last `transcriptWebHotTailItemCount`
        // items in webFooterItems outside listData. With hotTailItemCount=24, items 126–149
        // (seqs 308–331) are NOT in listData, so sourceIndexToRenderedIndex returns null for
        // the anchor and normalizedIndex(148) >= listData.length(126).
        //
        // The old (buggy) path: performWebDomVisibleAnchorRestoreCommand falls through to
        // FlashList's stale getLayout(148) which returns a capture-window y (~10240px) that
        // replays the capture-window scrollTop (10260) into a larger restored window (27794),
        // landing rows 182–186 instead of ~299–331.
        //
        // The fix: webDom.ts detects normalizedIndex >= listData.length → returns not_found;
        // applyEntryRestoreOwnerEffects falls back to distance restore using the persisted
        // offsetY (distance-from-bottom, invariant across window sizes).
        //
        // offsetY=8596 is chosen so that sh-lh-offsetY = anchorLayoutY - Math.trunc(itemOffsetPx)
        // = 18419, matching the anchor's correct position in the restored window (demonstrating
        // that when dfb is stable across windows, distance restore is exact).
        const targetWindowMessages = Array.from({ length: 150 }, (_, index) => {
            const seq = 182 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `target window ${seq}`,
            };
        });
        const persistedItemOffsetPx = -19.8;
        const anchorLayoutY = 18_400;
        // dfb = sh - lh - (anchorLayoutY - Math.trunc(persistedItemOffsetPx)) = 27794-779-18419
        const persistedOffsetY = 8_596;
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 779,
            scrollHeight: 27_794,
            scrollTop: 10_260,
            testNodes: [],
        });
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn(() => undefined),
        };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 24,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: targetWindowMessages,
        };
        sessionState = { ...sessionState, seq: 452 };
        sessionTargetWindowStateByIdState.set('session-1', {
            isWindowMode: true,
            windowId: 'target:session-1:331',
            targetSeq: 331,
            windowMinSeq: 182,
            windowMaxSeq: 331,
            olderCursor: 182,
            newerCursor: 331,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 1,
        });
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: persistedOffsetY,
            anchor: {
                kind: 'message',
                messageId: 'm330',
                itemId: 'msg:7taf0ye67un',
                itemOffsetPx: persistedItemOffsetPx,
                seq: 330,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await primeFlashListMetrics(779, 27_794, { turns: 2 });

                // Target-window positioning is renderer-owned; the host must not replay the
                // capture-window distance through the DOM or the FlashList imperative seam.
                expect(scroller.scrollTop).toBe(10_260);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                await screen.unmount();
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('scrolls a data-resolved direct web jumpToSeq target even when the target row is virtualized out of the DOM', async () => {
        type TargetWindowSyncMock = {
            loadTargetWindowMessages: ReturnType<typeof vi.fn>;
        };
        const syncMod = await import('@/sync/sync');
        const loadTargetWindowMessagesMock = vi.mocked(
            (syncMod.sync as unknown as TargetWindowSyncMock).loadTargetWindowMessages,
        );
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        const targetWindowMessages = Array.from({ length: 10 }, (_, index) => {
            const seq = 327 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `target window ${seq}`,
            };
        });
        const messages = [
            ...Array.from({ length: 34 }, (_, index) => {
                const seq = 303 + index;
                return {
                    kind: 'agent-text' as const,
                    id: `m${seq}`,
                    localId: null,
                    createdAt: seq,
                    seq,
                    text: `loaded ${seq}`,
                };
            }),
            ...Array.from({ length: 16 }, (_, index) => {
                const seq = 437 + index;
                return {
                    kind: 'agent-text' as const,
                    id: `m${seq}`,
                    localId: null,
                    createdAt: seq,
                    seq,
                    text: `tail ${seq}`,
                };
            }),
        ];
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 12000,
            scrollTop: 0,
            testNodes: [],
        });
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => {
                const item = (flashListChatListHarnessState.flashListProps?.data ?? [])[index] as { id?: string } | undefined;
                return item?.id === 'm331'
                    ? { x: 0, y: 12000, width: 320, height: 100 }
                    : undefined;
            }),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 452 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 0,
        };
        loadTargetWindowMessagesMock.mockImplementation(async (sessionId: string, target: { kind: 'seq'; seq: number }) => {
            expect(sessionId).toBe('session-1');
            expect(target).toEqual({ kind: 'seq', seq: 331 });
            sessionTargetWindowStateByIdState.set(sessionId, {
                isWindowMode: true,
                windowId: 'target:session-1:331',
                targetSeq: 331,
                windowMinSeq: 327,
                windowMaxSeq: 336,
                olderCursor: 327,
                newerCursor: 336,
                hasMoreOlder: true,
                hasMoreNewer: true,
                activatedAtMs: 1,
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [...messages],
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
        loadOlderMessagesMock.mockResolvedValue({ loaded: 10, hasMore: true, status: 'loaded' as const });
        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={331} />,
                );
                await primeFlashListMetrics(400, 12000, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                const renderedIds = (flashListChatListHarnessState.flashListProps?.data ?? [])
                    .map((item: any) => item.id);
                const targetIndex = renderedIds.indexOf('m331');
                expect(targetIndex).toBeGreaterThanOrEqual(0);
                expect(loadTargetWindowMessagesMock).toHaveBeenCalledWith(
                    'session-1',
                    { kind: 'seq', seq: 331 },
                    { direction: 'initial' },
                );
                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        type: 'jump-to-seq',
                        sessionId: 'session-1',
                        seq: 331,
                    }),
                ]));
                expect(scroller.scrollTop).toBe(11600);
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('renders a target window when a data-present direct web jumpToSeq produces no mounted target or scroll movement', async () => {
        type TargetWindowSyncMock = {
            loadTargetWindowMessages: ReturnType<typeof vi.fn>;
        };
        const syncMod = await import('@/sync/sync');
        const loadTargetWindowMessagesMock = vi.mocked(
            (syncMod.sync as unknown as TargetWindowSyncMock).loadTargetWindowMessages,
        );
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        const messages = Array.from({ length: 150 }, (_, index) => {
            const seq = 303 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `loaded ${seq}`,
            };
        });
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 12000,
            scrollTop: 11600,
            testNodes: [],
        });
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => {
                const item = (flashListChatListHarnessState.flashListProps?.data ?? [])[index] as { id?: string } | undefined;
                return item?.id === 'm331'
                    ? { x: 0, y: 11750, width: 320, height: 100 }
                    : undefined;
            }),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 452 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 24,
        };
        loadTargetWindowMessagesMock.mockImplementation(async (sessionId: string, target: { kind: 'seq'; seq: number }) => {
            expect(sessionId).toBe('session-1');
            expect(target).toEqual({ kind: 'seq', seq: 331 });
            return {
                status: 'loaded',
                windowId: 'target:session-1:331',
                targetSeq: 331,
                targetPresent: true,
                rawSeqs: [331],
                appliedSeqs: [331],
                olderCursor: 331,
                newerCursor: 331,
                hasMoreOlder: true,
                hasMoreNewer: true,
            };
        });
        loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: true, status: 'loaded' as const });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={331} />,
                );
                await primeFlashListMetrics(400, 12000, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                const renderedIds = (flashListChatListHarnessState.flashListProps?.data ?? [])
                    .map((item: any) => item.id);
                expect(renderedIds).toContain('m331');
                expect(flashListRefHandle.getLayout).toHaveBeenCalledWith(renderedIds.indexOf('m331'));
                expect(scroller.scrollTop).toBe(11600);
                expect(loadTargetWindowMessagesMock).toHaveBeenCalledWith(
                    'session-1',
                    { kind: 'seq', seq: 331 },
                    expect.objectContaining({ direction: 'initial' }),
                );
                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('uses web DOM metrics to run a direct jumpToSeq target-window route before FlashList metrics arrive', async () => {
        type TargetWindowSyncMock = {
            loadTargetWindowMessages: ReturnType<typeof vi.fn>;
        };
        const syncMod = await import('@/sync/sync');
        const loadTargetWindowMessagesMock = vi.mocked(
            (syncMod.sync as unknown as TargetWindowSyncMock).loadTargetWindowMessages,
        );
        const sparseMessages = [
            ...Array.from({ length: 10 }, (_, index) => {
                const seq = 303 + index;
                return {
                    kind: 'agent-text' as const,
                    id: `m${seq}`,
                    localId: null,
                    createdAt: seq,
                    seq,
                    text: `sparse older ${seq}`,
                };
            }),
            ...Array.from({ length: 16 }, (_, index) => {
                const seq = 437 + index;
                return {
                    kind: 'agent-text' as const,
                    id: `m${seq}`,
                    localId: null,
                    createdAt: seq,
                    seq,
                    text: `tail ${seq}`,
                };
            }),
        ];
        const targetWindowMessages = Array.from({ length: 10 }, (_, index) => {
            const seq = 327 + index;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `target window ${seq}`,
            };
        });
        const scroller = createFlashListChatListWebScroller({
            clientHeight: 400,
            scrollHeight: 12000,
            scrollTop: 0,
            testNodes: [],
        });
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn(),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: sparseMessages,
        };
        sessionState = { ...sessionState, seq: 452 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 0,
        };
        loadTargetWindowMessagesMock.mockImplementation(async (sessionId: string, target: { kind: 'seq'; seq: number }) => {
            sessionTargetWindowStateByIdState.set(sessionId, {
                isWindowMode: true,
                windowId: 'target:session-1:331',
                targetSeq: target.seq,
                windowMinSeq: 327,
                windowMaxSeq: 336,
                olderCursor: 327,
                newerCursor: 336,
                hasMoreOlder: true,
                hasMoreNewer: true,
                activatedAtMs: 1,
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...sparseMessages.slice(0, 10),
                    ...targetWindowMessages,
                    ...sparseMessages.slice(10),
                ],
            };
            return {
                status: 'loaded',
                windowId: 'target:session-1:331',
                targetSeq: target.seq,
                targetPresent: true,
                rawSeqs: targetWindowMessages.map((message) => message.seq),
                appliedSeqs: targetWindowMessages.map((message) => message.seq),
                olderCursor: 327,
                newerCursor: 336,
                hasMoreOlder: true,
                hasMoreNewer: true,
            };
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={331} />,
                );
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                expect(loadTargetWindowMessagesMock).toHaveBeenCalledWith(
                    'session-1',
                    { kind: 'seq', seq: 331 },
                    expect.objectContaining({ direction: 'initial' }),
                );
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('promotes a web jumpToSeq landing into session viewport state before returning without the route param', async () => {
        const messages = Array.from({ length: 360 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const maxScrollTop = 17600;
        const targetScrollTop = 11850;
        const contentHeight = 18000;
        const clientHeight = 400;
        const expectedDistanceFromBottom = contentHeight - clientHeight - targetScrollTop;
        const targetItemAnchor = createFlashListChatListWebElement('transcript-item-m301', { top: 160, bottom: 260 });
        const targetMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m301', { top: 180, bottom: 230 });
        targetMessageAnchor.parentElement = targetItemAnchor;
        const scroller = createFlashListChatListWebScroller({
            clientHeight,
            scrollHeight: contentHeight,
            scrollTop: maxScrollTop,
            testNodes: [],
        });
        let layoutReady = false;
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                layoutReady && index === 300
                    ? { x: 0, y: 12000, width: 320, height: 100 }
                : undefined
            )),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 360 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 2,
        };
        const onViewportChange = vi.fn((state: any) => {
            routeSessionViewportChangeIntoTestStore('session-1', state);
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={301} onViewportChange={onViewportChange} />,
                );
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                expect(scroller.scrollTop).toBe(maxScrollTop);

                layoutReady = true;
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                await screen.settle({ turns: 2 });
                expect(flashListRefHandle.getLayout).toHaveBeenCalledWith(300);
                expect(scroller.scrollTop).toBe(targetScrollTop);

                scroller.setQuerySelectorAll('[data-testid]', [targetItemAnchor, targetMessageAnchor]);
                sessionViewportByIdState.set('session-1', {
                    isPinned: false,
                    offsetY: 7315,
                    anchor: null,
                    lastUpdatedAt: 1,
                    source: 'observed',
                });
                await triggerFlashListChatListScroll(
                    targetScrollTop,
                    {
                        contentSize: { height: contentHeight },
                        layoutMeasurement: { height: clientHeight },
                    },
                    { turns: 2 },
                );
                await screen.settle({ turns: 2 });

                expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                    isPinned: false,
                    offsetY: expectedDistanceFromBottom,
                    source: 'observed',
                    anchor: expect.objectContaining({
                        kind: 'message',
                        messageId: 'm301',
                        itemId: 'm301',
                        itemOffsetPx: 160,
                    }),
                });

                sessionMessagesState = {
                    isLoaded: true,
                    messages: [{ kind: 'agent-text', id: 'b1', localId: null, createdAt: 1, seq: 1, text: 'other session' }],
                };
                await act(async () => {
                    screen.tree.update(<ChatList session={{ ...sessionState, id: 'session-2', seq: 1 }} onViewportChange={vi.fn()} />);
                });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                await screen.settle({ turns: 2 });

                scroller.scrollTop = maxScrollTop;
                const staleScrollDelta = maxScrollTop - targetScrollTop;
                targetItemAnchor.setRect({ top: 160 - staleScrollDelta, bottom: 260 - staleScrollDelta });
                targetMessageAnchor.setRect({ top: 180 - staleScrollDelta, bottom: 230 - staleScrollDelta });
                sessionMessagesState = {
                    isLoaded: true,
                    messages,
                };
                viewportControllerMockState.resolveInputs = [];
                await act(async () => {
                    screen.tree.update(<ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />);
                });
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2, frames: 1 });
                await screen.settle({ turns: 4 });

                expect(scroller.scrollTop).toBe(targetScrollTop);
                expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        anchor: expect.objectContaining({
                            itemId: 'm301',
                            messageId: 'm301',
                        }),
                        itemOffsetPx: 160,
                        sessionId: 'session-1',
                        type: 'restore-visible-anchor',
                    }),
                ]));
                expect(viewportControllerMockState.resolveInputs).not.toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        distanceFromLiveTailPx: 7315,
                        sessionId: 'session-1',
                        type: 'restore-distance',
                    }),
                ]));
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('restores an in-app route-jump return to the durable loaded anchor instead of the active window edge', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 10, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        const messages = Array.from({ length: 360 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const contentHeight = 18000;
        const clientHeight = 400;
        const maxScrollTop = contentHeight - clientHeight;
        const targetScrollTop = 11850;
        const staleScrollDelta = maxScrollTop - targetScrollTop;
        const targetItemAnchor = createFlashListChatListWebElement('transcript-item-m301', {
            top: 160 - staleScrollDelta,
            bottom: 260 - staleScrollDelta,
        });
        const targetMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m301', {
            top: 180 - staleScrollDelta,
            bottom: 230 - staleScrollDelta,
        });
        targetMessageAnchor.parentElement = targetItemAnchor;
        const scroller = createFlashListChatListWebScroller({
            clientHeight,
            scrollHeight: contentHeight,
            scrollTop: maxScrollTop,
            testNodes: [targetItemAnchor, targetMessageAnchor],
        });
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                index === 300 ? { x: 0, y: 12000, width: 320, height: 100 } : undefined
            )),
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: contentHeight - clientHeight - targetScrollTop,
            anchor: {
                kind: 'message',
                messageId: 'm301',
                itemId: 'm301',
                itemOffsetPx: 160,
                seq: 301,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });
        sessionTargetWindowStateByIdState.set('session-1', {
            isWindowMode: true,
            windowId: 'target:session-1:331',
            targetSeq: 331,
            windowMinSeq: 327,
            windowMaxSeq: 336,
            olderCursor: 327,
            newerCursor: 336,
            hasMoreOlder: true,
            hasMoreNewer: true,
            activatedAtMs: 1,
        });
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'b1', localId: null, createdAt: 1, seq: 1, text: 'other session' }],
        };
        sessionState = { ...sessionState, seq: 360 };
        const onViewportChange = vi.fn((state: any) => {
            routeSessionViewportChangeIntoTestStore('session-1', state);
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState, id: 'session-2', seq: 1 }} onViewportChange={vi.fn()} />,
                );
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 1 });

                sessionMessagesState = { isLoaded: true, messages };
                viewportControllerMockState.resolveInputs = [];
                await act(async () => {
                    screen.tree.update(<ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />);
                });
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2, frames: 1 });
                await screen.settle({ turns: 4 });

                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                expect(scroller.scrollTop).toBe(targetScrollTop);
                expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        anchor: expect.objectContaining({
                            itemId: 'm301',
                            messageId: 'm301',
                        }),
                        itemOffsetPx: 160,
                        sessionId: 'session-1',
                        type: 'restore-visible-anchor',
                    }),
                ]));
                expect(viewportControllerMockState.resolveInputs).not.toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        anchor: expect.objectContaining({
                            itemId: 'm327',
                            messageId: 'm327',
                        }),
                        sessionId: 'session-1',
                        type: 'restore-visible-anchor',
                    }),
                ]));
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('re-arms same-session no-query entry from the available jump viewport anchor instead of tail', async () => {
        const messages = Array.from({ length: 360 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const contentHeight = 18000;
        const clientHeight = 400;
        const maxScrollTop = contentHeight - clientHeight;
        const targetScrollTop = 11850;
        const targetItemAnchor = createFlashListChatListWebElement('transcript-item-m301', { top: 160, bottom: 260 });
        const targetMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m301', { top: 180, bottom: 230 });
        targetMessageAnchor.parentElement = targetItemAnchor;
        const scroller = createFlashListChatListWebScroller({
            clientHeight,
            scrollHeight: contentHeight,
            scrollTop: maxScrollTop,
            testNodes: [],
        });
        let layoutReady = false;
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                layoutReady && index === 300
                    ? { x: 0, y: 12000, width: 320, height: 100 }
                    : undefined
            )),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 360 };
        const onViewportChange = vi.fn((state: any) => {
            routeSessionViewportChangeIntoTestStore('session-1', state);
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={301} onViewportChange={onViewportChange} />,
                );
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                layoutReady = true;
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2 });
                await screen.settle({ turns: 2 });
                expect(scroller.scrollTop).toBe(targetScrollTop);

                scroller.setQuerySelectorAll('[data-testid]', [targetItemAnchor, targetMessageAnchor]);
                await triggerFlashListChatListScroll(
                    targetScrollTop,
                    {
                        contentSize: { height: contentHeight },
                        layoutMeasurement: { height: clientHeight },
                    },
                    { turns: 2 },
                );
                expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                    isPinned: false,
                    anchor: expect.objectContaining({
                        itemId: 'm301',
                        messageId: 'm301',
                    }),
                    source: 'observed',
                });

                const staleScrollDelta = maxScrollTop - targetScrollTop;
                scroller.scrollTop = maxScrollTop;
                targetItemAnchor.setRect({ top: 160 - staleScrollDelta, bottom: 260 - staleScrollDelta });
                targetMessageAnchor.setRect({ top: 180 - staleScrollDelta, bottom: 230 - staleScrollDelta });
                viewportControllerMockState.resolveInputs = [];
                await act(async () => {
                    screen.tree.update(<ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />);
                });
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2, frames: 1 });
                await screen.settle({ turns: 4 });

                expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        anchor: expect.objectContaining({
                            itemId: 'm301',
                            messageId: 'm301',
                        }),
                        sessionId: 'session-1',
                        type: 'restore-visible-anchor',
                    }),
                ]));
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('normalizes visible web tool-group header anchors through the live row before persistence', async () => {
        await withWebFlashListFakeTimers(1_000, async () => {
            runtimeMockState.platformOs = 'web';
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorCaptureDebounceMs: 0,
            };
            const contentHeight = 1200;
            const clientHeight = 400;
            const scrollTop = 480;
            const toolGroupItem = createFlashListChatListWebElement('transcript-item-toolCalls:linear:runtime-t2', { top: 110, bottom: 260 });
            const toolGroupAnchor = createFlashListChatListWebElement('transcript-anchor-tool-group-rotated-runtime-id', { top: 120, bottom: 220 });
            toolGroupAnchor.parentElement = toolGroupItem;
            const scroller = createFlashListChatListWebScroller({
                clientHeight,
                scrollHeight: contentHeight,
                scrollTop: 0,
                testNodes: [toolGroupItem, toolGroupAnchor],
            });
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'tool-call', id: 'runtime-t1', localId: null, createdAt: 1, seq: 41, tool: { name: 'shell' } },
                    { kind: 'tool-call', id: 'runtime-t2', localId: null, createdAt: 2, seq: 42, tool: { name: 'shell' } },
                ],
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
                    );
                    await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2 });

                    scroller.scrollTop = scrollTop;
                    await triggerFlashListChatListScroll(
                        scrollTop,
                        {
                            contentSize: { height: contentHeight },
                            layoutMeasurement: { height: clientHeight },
                            isTrusted: true,
                        },
                        { turns: 2 },
                    );
                    await act(async () => {
                        await vi.advanceTimersByTimeAsync(0);
                    });
                    await screen.settle({ turns: 2 });

                    expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                        isPinned: false,
                        offsetY: contentHeight - clientHeight - scrollTop,
                        source: 'observed',
                        anchor: expect.objectContaining({
                            kind: 'toolGroup',
                            messageId: 'runtime-t2',
                            seq: 42,
                        }),
                    });
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('keeps a promoted web jumpToSeq landing when a later programmatic web observation reports another middle viewport', async () => {
        const messages = Array.from({ length: 360 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const contentHeight = 30000;
        const clientHeight = 400;
        const maxScrollTop = contentHeight - clientHeight;
        const targetScrollTop = 8225;
        const wrongScrollTopFirst = 9300;
        const wrongScrollTopSecond = 10400;
        const expectedDistanceFromBottom = contentHeight - clientHeight - targetScrollTop;
        const targetItemAnchor = createFlashListChatListWebElement('transcript-item-m301', { top: 160, bottom: 260 });
        const targetMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m301', { top: 180, bottom: 230 });
        targetMessageAnchor.parentElement = targetItemAnchor;
        const wrongItemAnchor = createFlashListChatListWebElement('transcript-item-m325', { top: 160, bottom: 260 });
        const wrongMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m325', { top: 180, bottom: 230 });
        wrongMessageAnchor.parentElement = wrongItemAnchor;
        const scroller = createFlashListChatListWebScroller({
            clientHeight,
            scrollHeight: contentHeight,
            scrollTop: maxScrollTop,
            testNodes: [],
        });
        let layoutReady = false;
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                layoutReady && index === 300
                    ? { x: 0, y: targetScrollTop + 150, width: 320, height: 100 }
                    : undefined
            )),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 360 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 2,
        };
        const onViewportChange = vi.fn((state: any) => {
            routeSessionViewportChangeIntoTestStore('session-1', state);
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={301} onViewportChange={onViewportChange} />,
                );
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                expect(scroller.scrollTop).toBe(maxScrollTop);

                layoutReady = true;
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                await screen.settle({ turns: 2 });
                expect(flashListRefHandle.getLayout).toHaveBeenCalledWith(300);
                expect(scroller.scrollTop).toBe(targetScrollTop);

                scroller.setQuerySelectorAll('[data-testid]', [targetItemAnchor, targetMessageAnchor]);
                await triggerFlashListChatListScroll(
                    targetScrollTop,
                    {
                        contentSize: { height: contentHeight },
                        layoutMeasurement: { height: clientHeight },
                    },
                    { turns: 2 },
                );
                await screen.settle({ turns: 2 });
                expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                    isPinned: false,
                    offsetY: expectedDistanceFromBottom,
                    source: 'observed',
                    anchor: expect.objectContaining({
                        kind: 'message',
                        messageId: 'm301',
                        itemId: 'm301',
                        itemOffsetPx: 160,
                    }),
                });

                scroller.setQuerySelectorAll('[data-testid]', [wrongItemAnchor, wrongMessageAnchor]);
                scroller.scrollTop = wrongScrollTopFirst;
                await triggerFlashListChatListScroll(
                    wrongScrollTopFirst,
                    {
                        contentSize: { height: contentHeight },
                        layoutMeasurement: { height: clientHeight },
                        isTrusted: false,
                    },
                    { turns: 2 },
                );
                scroller.scrollTop = wrongScrollTopSecond;
                await triggerFlashListChatListScroll(
                    wrongScrollTopSecond,
                    {
                        contentSize: { height: contentHeight },
                        layoutMeasurement: { height: clientHeight },
                        isTrusted: false,
                    },
                    { turns: 2 },
                );
                await screen.settle({ turns: 2 });

                expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                    isPinned: false,
                    offsetY: expectedDistanceFromBottom,
                    source: 'observed',
                    anchor: expect.objectContaining({
                        kind: 'message',
                        messageId: 'm301',
                        itemId: 'm301',
                        itemOffsetPx: 160,
                    }),
                });
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('lets genuine web movement replace a protected web jumpToSeq landing', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const messages = Array.from({ length: 360 }, (_, index) => {
                const seq = index + 1;
                return {
                    kind: 'agent-text' as const,
                    id: `m${seq}`,
                    localId: null,
                    createdAt: seq,
                    seq,
                    text: `message ${seq}`,
                };
            });
            const contentHeight = 30000;
            const clientHeight = 400;
            const maxScrollTop = contentHeight - clientHeight;
            const targetScrollTop = 8225;
            const userScrollPrimingTop = 8000;
            const userScrollTop = 7600;
            const expectedUserDistanceFromBottom = contentHeight - clientHeight - userScrollTop;
            const targetItemAnchor = createFlashListChatListWebElement('transcript-item-m301', { top: 160, bottom: 260 });
            const targetMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m301', { top: 180, bottom: 230 });
            targetMessageAnchor.parentElement = targetItemAnchor;
            const userItemAnchor = createFlashListChatListWebElement('transcript-item-m325', { top: 160, bottom: 260 });
            const userMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m325', { top: 180, bottom: 230 });
            userMessageAnchor.parentElement = userItemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight,
                scrollHeight: contentHeight,
                scrollTop: maxScrollTop,
                testNodes: [],
            });
            let layoutReady = false;
            flashListRefHandle = {
                scrollToIndex: vi.fn(),
                scrollToOffset: vi.fn(),
                getLayout: vi.fn((index: number) => (
                    layoutReady && index === 300
                        ? { x: 0, y: targetScrollTop + 150, width: 320, height: 100 }
                        : undefined
                )),
            };
            sessionMessagesState = {
                isLoaded: true,
                messages,
            };
            sessionState = { ...sessionState, seq: 360 };
            syncTuningState = {
                ...syncTuningState,
                transcriptWebHotTailItemCount: 2,
                transcriptViewportAnchorCaptureDebounceMs: 0,
            };
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore('session-1', state);
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} jumpToSeq={301} onViewportChange={onViewportChange} />,
                    );
                    await act(async () => {
                        await Promise.resolve();
                        await Promise.resolve();
                    });
                    expect(scroller.scrollTop).toBe(maxScrollTop);

                    layoutReady = true;
                    await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2 });
                    await act(async () => {
                        await Promise.resolve();
                        await Promise.resolve();
                    });
                    await screen.settle({ turns: 2 });

                    scroller.setQuerySelectorAll('[data-testid]', [targetItemAnchor, targetMessageAnchor]);
                    await triggerFlashListChatListScroll(
                        targetScrollTop,
                        {
                            contentSize: { height: contentHeight },
                            layoutMeasurement: { height: clientHeight },
                            isTrusted: false,
                        },
                        { turns: 2 },
                    );
                    await screen.settle({ turns: 2 });
                    expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                        isPinned: false,
                        anchor: expect.objectContaining({
                            messageId: 'm301',
                            itemId: 'm301',
                        }),
                    });

                    vi.setSystemTime(new Date(1_000));
                    scroller.setQuerySelectorAll('[data-testid]', [userItemAnchor, userMessageAnchor]);
                    scroller.scrollTop = userScrollPrimingTop;
                    await triggerFlashListChatListScroll(
                        userScrollPrimingTop,
                        {
                            contentSize: { height: contentHeight },
                            layoutMeasurement: { height: clientHeight },
                            isTrusted: true,
                        },
                        { turns: 2 },
                    );
                    scroller.scrollTop = userScrollTop;
                    await triggerFlashListChatListScroll(
                        userScrollTop,
                        {
                            contentSize: { height: contentHeight },
                            layoutMeasurement: { height: clientHeight },
                            isTrusted: true,
                        },
                        { turns: 2 },
                    );
                    await act(async () => {
                        await vi.advanceTimersByTimeAsync(syncTuningState.transcriptViewportAnchorCaptureDebounceMs);
                    });
                    await screen.settle({ turns: 2 });

                    expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                        isPinned: false,
                        offsetY: expectedUserDistanceFromBottom,
                        source: 'observed',
                        anchor: expect.objectContaining({
                            kind: 'message',
                            messageId: 'm325',
                            itemId: 'm325',
                            itemOffsetPx: 160,
                        }),
                    });
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('flushes a successful web jumpToSeq landing on session switch when no scroll echo fires', async () => {
        const messages = Array.from({ length: 360 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const targetScrollTop = 11870;
        const contentHeight = 18000;
        const clientHeight = 400;
        const expectedDistanceFromBottom = contentHeight - clientHeight - targetScrollTop;
        const targetItemAnchor = createFlashListChatListWebElement('transcript-item-m301', { top: 160, bottom: 240 });
        const targetMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m301', { top: 180, bottom: 230 });
        targetMessageAnchor.parentElement = targetItemAnchor;
        const scroller = createFlashListChatListWebScroller({
            clientHeight,
            scrollHeight: contentHeight,
            scrollTop: targetScrollTop,
            testNodes: [targetItemAnchor, targetMessageAnchor],
        });
        let layoutReady = false;
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                layoutReady && index === 300
                    ? { x: 0, y: 12000, width: 320, height: 100 }
                    : undefined
            )),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 360 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 2,
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 7315,
            anchor: null,
            lastUpdatedAt: 1,
            source: 'observed',
        });
        const onViewportChange = vi.fn((state: any) => {
            routeSessionViewportChangeIntoTestStore('session-1', state);
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={301} onViewportChange={onViewportChange} />,
                );
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                layoutReady = true;
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                expect(scroller.scrollTop).toBe(targetScrollTop);

                sessionMessagesState = {
                    isLoaded: true,
                    messages: [{ kind: 'agent-text', id: 'b1', localId: null, createdAt: 1, seq: 1, text: 'other session' }],
                };
                await act(async () => {
                    screen.tree.update(<ChatList session={{ ...sessionState, id: 'session-2', seq: 1 }} onViewportChange={vi.fn()} />);
                });
                await screen.settle({ turns: 2 });

                expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                    isPinned: false,
                    offsetY: expectedDistanceFromBottom,
                    source: 'observed',
                    anchor: expect.objectContaining({
                        kind: 'message',
                        messageId: 'm301',
                        itemId: 'm301',
                        itemOffsetPx: 160,
                    }),
                });
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('promotes a web jumpToSeq landing using a mounted near-target anchor when the requested seq is not mounted', async () => {
        const messages = Array.from({ length: 360 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const targetScrollTop = 1834;
        const contentHeight = 9722;
        const clientHeight = 400;
        const maxScrollTop = contentHeight - clientHeight;
        const expectedDistanceFromBottom = contentHeight - clientHeight - targetScrollTop;
        const landedItemAnchor = createFlashListChatListWebElement('transcript-item-m330', { top: 160, bottom: 260 });
        const landedMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m330', { top: 180, bottom: 230 });
        landedMessageAnchor.parentElement = landedItemAnchor;
        const scroller = createFlashListChatListWebScroller({
            clientHeight,
            scrollHeight: contentHeight,
            scrollTop: maxScrollTop,
            testNodes: [],
        });
        let layoutReady = false;
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                layoutReady && index === 330
                    ? { x: 0, y: targetScrollTop + 150, width: 320, height: 100 }
                    : undefined
            )),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 360 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 2,
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 7109,
            anchor: {
                kind: 'message',
                messageId: 'm317',
                itemId: 'm317',
                itemOffsetPx: 40,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });
        const onViewportChange = vi.fn((state: any) => {
            routeSessionViewportChangeIntoTestStore('session-1', state);
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={331} onViewportChange={onViewportChange} />,
                );
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                expect(scroller.scrollTop).toBe(maxScrollTop);

                layoutReady = true;
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                await screen.settle({ turns: 2 });
                expect(flashListRefHandle.getLayout).toHaveBeenCalledWith(330);
                expect(scroller.scrollTop).toBe(targetScrollTop);

                scroller.setQuerySelectorAll('[data-testid]', [landedItemAnchor, landedMessageAnchor]);
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [{ kind: 'agent-text', id: 'b1', localId: null, createdAt: 1, seq: 1, text: 'other session' }],
                };
                await act(async () => {
                    screen.tree.update(<ChatList session={{ ...sessionState, id: 'session-2', seq: 1 }} onViewportChange={vi.fn()} />);
                });
                await screen.settle({ turns: 2 });

                expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                    isPinned: false,
                    offsetY: expectedDistanceFromBottom,
                    source: 'observed',
                    anchor: expect.objectContaining({
                        kind: 'message',
                        messageId: 'm330',
                        itemId: 'm330',
                        itemOffsetPx: 160,
                    }),
                });

                scroller.scrollTop = maxScrollTop;
                const staleScrollDelta = maxScrollTop - targetScrollTop;
                landedItemAnchor.setRect({ top: 160 - staleScrollDelta, bottom: 260 - staleScrollDelta });
                landedMessageAnchor.setRect({ top: 180 - staleScrollDelta, bottom: 230 - staleScrollDelta });
                sessionMessagesState = {
                    isLoaded: true,
                    messages,
                };
                viewportControllerMockState.resolveInputs = [];
                await act(async () => {
                    screen.tree.update(<ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />);
                });
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2, frames: 1 });
                await screen.settle({ turns: 4 });

                expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        anchor: expect.objectContaining({
                            itemId: 'm330',
                            messageId: 'm330',
                        }),
                        itemOffsetPx: 160,
                        sessionId: 'session-1',
                        type: 'restore-visible-anchor',
                    }),
                ]));
                expect(viewportControllerMockState.resolveInputs).not.toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        distanceFromLiveTailPx: 7109,
                        sessionId: 'session-1',
                        type: 'restore-distance',
                    }),
                ]));
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('persists a target-not-mounted web jumpToSeq landing before clearing pending promotion on session switch', async () => {
        const messages = Array.from({ length: 360 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const targetScrollTop = 0;
        const contentHeight = 18000;
        const clientHeight = 400;
        const maxScrollTop = contentHeight - clientHeight;
        const expectedDistanceFromBottom = contentHeight - clientHeight - targetScrollTop;
        const scroller = createFlashListChatListWebScroller({
            clientHeight,
            scrollHeight: contentHeight,
            scrollTop: maxScrollTop,
            testNodes: [],
        });
        let layoutReady = false;
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                layoutReady && index === 300
                    ? { x: 0, y: 0, width: 320, height: 100 }
                    : undefined
            )),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 360 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 2,
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: true,
            offsetY: 0,
            anchor: null,
            lastUpdatedAt: 1,
            source: 'default',
        });
        const onViewportChange = vi.fn((state: any) => {
            routeSessionViewportChangeIntoTestStore('session-1', state);
        });

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState }} jumpToSeq={301} onViewportChange={onViewportChange} />,
                );
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                expect(scroller.scrollTop).toBe(maxScrollTop);

                layoutReady = true;
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                await screen.settle({ turns: 2 });
                expect(flashListRefHandle.getLayout).toHaveBeenCalledWith(300);
                expect(scroller.scrollTop).toBe(targetScrollTop);

                sessionMessagesState = {
                    isLoaded: true,
                    messages: [{ kind: 'agent-text', id: 'b1', localId: null, createdAt: 1, seq: 1, text: 'other session' }],
                };
                await act(async () => {
                    screen.tree.update(<ChatList session={{ ...sessionState, id: 'session-2', seq: 1 }} onViewportChange={vi.fn()} />);
                });
                await screen.settle({ turns: 2 });

                expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                    isPinned: false,
                    offsetY: expectedDistanceFromBottom,
                    source: 'observed',
                    anchor: null,
                });

                sessionMessagesState = {
                    isLoaded: true,
                    messages,
                };
                viewportControllerMockState.resolveInputs = [];
                await act(async () => {
                    screen.tree.update(<ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />);
                });
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2, frames: 1 });
                await screen.settle({ turns: 4 });

                expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        distanceFromLiveTailPx: expectedDistanceFromBottom,
                        sessionId: 'session-1',
                        type: 'restore-distance',
                    }),
                ]));
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => scroller) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('flushes a target-not-mounted web jumpToSeq landing before unmount detaches the DOM', async () => {
        const messages = Array.from({ length: 360 }, (_, index) => {
            const seq = index + 1;
            return {
                kind: 'agent-text' as const,
                id: `m${seq}`,
                localId: null,
                createdAt: seq,
                seq,
                text: `message ${seq}`,
            };
        });
        const targetScrollTop = 0;
        const contentHeight = 18000;
        const clientHeight = 400;
        const maxScrollTop = contentHeight - clientHeight;
        const expectedDistanceFromBottom = contentHeight - clientHeight - targetScrollTop;
        const scroller = createFlashListChatListWebScroller({
            clientHeight,
            scrollHeight: contentHeight,
            scrollTop: maxScrollTop,
            testNodes: [],
        });
        let layoutReady = false;
        let domStillMounted = true;
        flashListRefHandle = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            getLayout: vi.fn((index: number) => (
                layoutReady && index === 300
                    ? { x: 0, y: 0, width: 320, height: 100 }
                    : undefined
            )),
        };
        sessionMessagesState = {
            isLoaded: true,
            messages,
        };
        sessionState = { ...sessionState, seq: 360 };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebHotTailItemCount: 2,
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: true,
            offsetY: 0,
            anchor: null,
            lastUpdatedAt: 1,
            source: 'default',
        });
        const onViewportChange = vi.fn((state: any) => {
            routeSessionViewportChangeIntoTestStore('session-1', state);
        });

        function DetachDomAfterChatListLayoutCleanup() {
            React.useLayoutEffect(() => () => {
                domStillMounted = false;
            }, []);
            return null;
        }

        await withFlashListChatListWebScrollerDom(
            scroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <>
                        <ChatList session={{ ...sessionState }} jumpToSeq={301} onViewportChange={onViewportChange} />
                        <DetachDomAfterChatListLayoutCleanup />
                    </>,
                );
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                expect(scroller.scrollTop).toBe(maxScrollTop);

                layoutReady = true;
                await primeFlashListMetrics(clientHeight, contentHeight, { turns: 2 });
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });
                await screen.settle({ turns: 2 });
                expect(flashListRefHandle.getLayout).toHaveBeenCalledWith(300);
                expect(scroller.scrollTop).toBe(targetScrollTop);

                unmountTrackedFlashListChatList(screen);
                await act(async () => {
                    await Promise.resolve();
                });

                expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                    isPinned: false,
                    offsetY: expectedDistanceFromBottom,
                    source: 'observed',
                    anchor: null,
                });
            },
            {
                HTMLElement: FlashListChatListWebElement,
                document: { getElementById: vi.fn(() => (domStillMounted ? scroller : null)) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('ignores stale async jump commands after the session identity changes', async () => {
        runtimeMockState.platformOs = 'ios';
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };

        let releaseJump: (() => void) | null = null;
        jumpToTranscriptSeqMockState.implementation = async (params) => {
            await new Promise<void>((resolve) => {
                releaseJump = resolve;
            });
            params.scrollToIndex(1);
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(
            <ChatList session={{ ...sessionState, id: 'session-1' }} jumpToSeq={2} />,
        );
        await act(async () => {
            await Promise.resolve();
        });
        expect(releaseJump).toBeNull();
        flashListRefHandle.scrollToIndex.mockClear();

        sessionState = { ...sessionState, id: 'session-2' };
        await act(async () => {
            screen.tree.update(<ChatList session={{ ...sessionState }} />);
        });

        await act(async () => {
            releaseJump?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
    });

    it('falls back to distance without older lookup when a missing anchor has no durable seq', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 150,
                anchor: {
                    kind: 'message',
                    messageId: 'missing',
                    itemId: 'missing',
                    itemOffsetPx: 20,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2, frames: 1 });
                    await screen.settle({ turns: 4 });

                    expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                    expect(scroller.scrollTop).toBe(750);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('uses configured zero older lookup budget before falling back to distance restore', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 0, hasMore: false, status: 'no_more' as const });
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorOlderLookupMaxLoads: 0,
            };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 150,
                anchor: {
                    kind: 'message',
                    messageId: 'missing',
                    itemId: 'missing',
                    itemOffsetPx: 20,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2, frames: 1 });

                    expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                    expect(scroller.scrollTop).toBe(750);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('materializes older pages before restoring a web distance deeper than the current window', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 600,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 300,
                scrollTop: 0,
                testNodes: [],
            });

            let resolveLoadOlder = createMissingLoadOlderResolver();
            const loadOlderPromise = new Promise<LoadedOlderResult>((resolve) => {
                resolveLoadOlder = (value) => {
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'user-text', id: 'm0', localId: null, createdAt: 0, seq: 0, text: 'zero' },
                            { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        ],
                    };
                    scroller.scrollHeight = 900;
                    resolve(value);
                };
            });
            loadOlderMessagesMock.mockImplementation(() => loadOlderPromise);

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 300, { turns: 2, frames: 1 });

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
                    expect(scroller.scrollTop).toBe(0);

                    await act(async () => {
                        resolveLoadOlder({ loaded: 1, hasMore: true, status: 'loaded' });
                        await Promise.resolve();
                        await Promise.resolve();
                        screen.tree.update(<ChatList session={{ ...sessionState }} />);
                    });
                    await triggerFlashListChatListContentSizeChange(100, 900, { turns: 2, frames: 1 });
                    await screen.settle({ turns: 4, frames: 1 });

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
                    expect(scroller.scrollTop).toBe(200);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('keeps bounded materializing web distance restores until the saved distance is reachable', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 1000,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' }],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 300,
                scrollTop: 0,
                testNodes: [],
            });
            const materializedHeights = [700, 1000, 1400];
            loadOlderMessagesMock.mockImplementation(async () => {
                const callIndex = loadOlderMessagesMock.mock.calls.length;
                const nextHeight = materializedHeights[Math.min(callIndex - 1, materializedHeights.length - 1)] ?? 1400;
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: `m${-callIndex}`, localId: null, createdAt: -callIndex, seq: -callIndex, text: `older ${callIndex}` },
                        ...sessionMessagesState.messages,
                    ],
                };
                scroller.scrollHeight = nextHeight;
                return { loaded: 1, hasMore: callIndex < materializedHeights.length, status: 'loaded' as const };
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 300, { turns: 2, frames: 1 });

                    for (let index = 0; index < materializedHeights.length; index += 1) {
                        await act(async () => {
                            await Promise.resolve();
                            await Promise.resolve();
                            screen.tree.update(<ChatList session={{ ...sessionState }} />);
                        });
                        await triggerFlashListChatListContentSizeChange(100, materializedHeights[index]!, { turns: 2, frames: 1 });
                        await screen.settle({ turns: 4, frames: 1 });
                    }

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(3);
                    expect(scroller.scrollTop).toBe(300);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('does not apply anchor lookup fallback after the user scrolls during lookup', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockClear();

        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'no_more' }) => void) | null = null;
            const loadOlderPromise = new Promise<{ loaded: number; hasMore: boolean; status: 'no_more' }>((resolve) => {
                resolveLoadOlder = resolve;
            });
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 150,
                anchor: {
                    kind: 'message',
                    messageId: 'missing',
                    itemId: 'missing',
                    itemOffsetPx: 20,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [],
            });
            loadOlderMessagesMock.mockImplementation(() => loadOlderPromise);

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2, frames: 1 });
                    expect(loadOlderMessagesMock).not.toHaveBeenCalled();

                    scroller.scrollTop = 550;
                    getCapturedFlashListProps().onWheel?.({ deltaY: -80, stopPropagation: vi.fn() });
                    resolveLoadOlder?.({ loaded: 0, hasMore: false, status: 'no_more' });
                    await screen.settle({ turns: 4 });

                    expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                    expect(scroller.scrollTop).toBe(550);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('does not let initial web pin retry override an anchor restore', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 100,
                anchor: {
                    kind: 'message',
                    messageId: 'm1',
                    itemId: 'm1',
                    itemOffsetPx: 30,
                    capturedAtMs: 1,
                },
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' }],
            };
            const itemAnchor = createFlashListChatListWebElement('transcript-item-m1', { top: 120, bottom: 220 });
            const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 130, bottom: 180 });
            messageAnchor.parentElement = itemAnchor;
            const scroller = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
                testNodes: [itemAnchor, messageAnchor],
            });

            await withFlashListChatListWebScrollerDom(
                scroller,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await primeFlashListMetrics(100, 1000, { turns: 2, frames: 1 });
                    expect(scroller.scrollTop).toBe(90);

                    scroller.scrollHeight = 1400;
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 3000 });

                    expect(scroller.scrollTop).toBe(90);
                },
                {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scroller) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('does not restore a stale entry viewport after bottom follow is rearmed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 420,
                lastUpdatedAt: 1,
                source: 'observed',
            });

            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 100,
                scrollTop: 0,
            });

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(
                        <ChatList session={{ ...sessionState }} followBottomIntentKey={0} />,
                    );
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    await screen.update(<ChatList session={{ ...sessionState }} followBottomIntentKey={1} />);

                    scrollEl.scrollHeight = 1000;
                    await primeFlashListMetrics(100, 1000, { turns: 2, frames: 1 });

                    expect(scrollEl.scrollTop).toBe(900);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('does not re-pin during the initial web stabilize window after the user scrolls away from bottom', async () => {
        await withWebFlashListFakeTimers(250, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

            const scrollEl: any = {
                scrollHeight: 1000,
                clientHeight: 100,
                scrollTop: 0,
                scrollTo: ({ top }: { top: number }) => {
                    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                    scrollEl.scrollTop = Math.max(0, Math.min(top, maxScrollTop));
                },
                querySelectorAll: () => [],
                parentElement: null,
            };

            const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    // Initial stabilization pins to bottom.
                    expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);

                    // User scrolls away slightly from bottom.
                    scrollEl.scrollTop = 900;
                    await act(async () => {
                        getCapturedFlashListProps()?.onWheel?.({ deltaY: -80, stopPropagation: vi.fn() });
                    });

                    // Even though stabilization retries are scheduled, we must not fight the user's scroll.
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(900);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('cancels scheduled bottom pin when thinking expansion changes locally', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'agent-text', id: 't1', localId: null, createdAt: 1, text: 'thinking', isThinking: true },
                ],
            };
            settingValues.sessionThinkingDisplayMode = 'inline';
            settingValues.sessionThinkingInlinePresentation = 'summary';

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await screen.settle();

            await primeFlashListMetrics(100, 1000, { turns: 1 });
            scrollToOffset.mockClear();

            await act(async () => {
                getCapturedFlashListProps()?.onScrollBeginDrag?.();
                getCapturedFlashListProps()?.onContentSizeChange?.(0, 1200);
            });

            const thinkingProps = renderedMessageViewProps.find((props) => props?.message?.id === 't1');
            expect(typeof thinkingProps?.onThinkingExpandedChange).toBe('function');

            await act(async () => {
                thinkingProps.onThinkingExpandedChange(true);
            });

            await screen.settle({ advanceTimersMs: 300, turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('cancels scheduled bottom pin when tool group expansion changes locally', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };

            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'tool-call', id: 'tool-1', localId: null, createdAt: 1, tool: { name: 'shell' } }],
            };
            settingValues.transcriptGroupingMode = 'linear';
            settingValues.transcriptGroupToolCalls = true;
            settingValues.toolViewTimelineChromeMode = 'activity_feed';

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await screen.settle();
            getCapturedFlashListProps();

            // N2c: the group renders as unit rows; expansion is driven by the header
            // unit's setExpanded adapter (same anchor-message-id keyed state).
            const headerUnitProps = renderedToolGroupUnitHeaderProps[0];
            expect(typeof headerUnitProps?.setExpanded).toBe('function');

            await primeFlashListMetrics(100, 1000, { turns: 1 });
            scrollToOffset.mockClear();

            await act(async () => {
                getCapturedFlashListProps()?.onScrollBeginDrag?.();
                getCapturedFlashListProps()?.onContentSizeChange?.(0, 1200);
            });

            await act(async () => {
                headerUnitProps.setExpanded(true);
            });

            await screen.settle({ advanceTimersMs: 300, turns: 1 });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('re-pins to the bottom for passive mount-time web scroll drift while follow mode is still desired', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

            const scrollEl: any = {
                scrollHeight: 1000,
                clientHeight: 100,
                scrollTop: 0,
                scrollTo: ({ top }: { top: number }) => {
                    const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                    scrollEl.scrollTop = Math.max(0, Math.min(top, max));
                },
                querySelectorAll: () => [],
                parentElement: null,
            };

            const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    // The initial mount pin puts us at the bottom.
                    expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);

                    await act(async () => {
                        // Establish scroll metrics used by FlashList distance-from-bottom math.
                        await primeFlashListMetrics(100, 1000, { turns: 1 });

                        // First, we're at the bottom (distanceFromBottom = 0).
                        await scrollFlashListTo(900, { trusted: false, turns: 1 });

                        // FlashList/web can apply a programmatic scroll adjustment during mount (no wheel/touch intent).
                        // Simulate being nudged away from bottom by ~400px.
                        scrollEl.scrollTop = 492;
                        await scrollFlashListTo(492, { trusted: false, turns: 1 });
                    });

                    // Passive mount-time drift should be corrected back to the visual bottom while follow mode remains desired.
                    expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('keeps bottom follow when passive web scroll drift occurs without user intent', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const scrollEl = Object.assign(
            createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
            }),
            {
                scrollTo: ({ top }: { top: number }) => {
                    scrollEl.scrollTop = top;
                },
            },
        );

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                expect(getCapturedFlashListProps()).not.toBeNull();
                flashListRefHandle.scrollToOffset.mockClear();

                await act(async () => {
                    // Establish scroll metrics used by onScroll distance-from-bottom math.
                    await primeFlashListMetrics(100, 1000, { turns: 1 });
                    // Simulate a passive drift away from the bottom without any user gesture or new activity.
                    scrollEl.scrollTop = 0;
                    await scrollFlashListTo(0, { trusted: false, turns: 2 });
                });

                expect(scrollEl.scrollTop).toBe(900);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('keeps the visual bottom pinned when existing web content remeasures without user activity', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const scrollEl = Object.assign(
            createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 900,
            }),
            {
                scrollTo: ({ top }: { top: number }) => {
                    scrollEl.scrollTop = top;
                },
            },
        );

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                flashListRefHandle.scrollToOffset.mockClear();

                await primeFlashListMetrics(100, 1000, { turns: 1 });
                await scrollFlashListTo(900, { trusted: false, turns: 1 });

                scrollEl.scrollHeight = 1400;

                await primeFlashListMetrics(100, 1400, { turns: 1 });
                await scrollFlashListTo(900, { trusted: false, turns: 2 });

                expect(scrollEl.scrollTop).toBe(1300);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('uses near-bottom distance to authorize followed web growth, then lands at the live tail', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const scrollEl = Object.assign(
            createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 892,
            }),
            {
                scrollTo: ({ top }: { top: number }) => {
                    scrollEl.scrollTop = top;
                },
            },
        );

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                flashListRefHandle.scrollToOffset.mockClear();

                await primeFlashListMetrics(100, 1000, { turns: 1 });
                scrollEl.scrollTop = 892;
                await scrollFlashListTo(892, { trusted: false, turns: 1 });

                scrollEl.scrollHeight = 1400;

                await primeFlashListMetrics(100, 1400, { turns: 1 });

                expect(scrollEl.scrollTop).toBe(1300);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('rearms renderer-owned web bottom follow near the streaming tail without a competing host write', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            syncTuningState = {
                ...syncTuningState,
                transcriptWebInitialPinStabilizeMs: 0,
            };

            const scrollEl = Object.assign(
                createFlashListChatListWebScroller({
                    clientHeight: 100,
                    scrollHeight: 1000,
                    scrollTop: 900,
                }),
                {
                    scrollTo: ({ top }: { top: number }) => {
                        const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                        scrollEl.scrollTop = Math.max(0, Math.min(top, max));
                    },
                },
            );

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    flashListRefHandle.scrollToOffset.mockClear();

                    await primeFlashListMetrics(100, 1000, { turns: 1 });
                    scrollEl.scrollTop = 900;
                    await scrollFlashListTo(900, { trusted: false, turns: 1 });

                    await act(async () => {
                        getCapturedFlashListProps()?.onWheel?.({ deltaY: -320, stopPropagation: vi.fn() });
                    });
                    scrollEl.scrollTop = 600;
                    await scrollFlashListTo(600, { trusted: true, turns: 1 });

                    await act(async () => {
                        getCapturedFlashListProps()?.onWheel?.({ deltaY: 250, stopPropagation: vi.fn() });
                    });
                    scrollEl.scrollTop = 850;
                    await scrollFlashListTo(850, { trusted: true, turns: 1 });

                    scrollEl.scrollHeight = 1400;
                    await primeFlashListMetrics(100, 1400, { turns: 1 });
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 300 });

                    expect(scrollEl.scrollTop).toBe(850);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('drains deferred newer pages once from live web DOM bottom metrics, not stale FlashList height (WREG.6)', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptForwardPrefetchThresholdPx: 240,
            transcriptBackwardPrefetchThresholdPx: 120,
            transcriptWebHotTailItemCount: 1,
            transcriptWebInitialPinStabilizeMs: 0,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'hot tail' },
            ],
        };
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 100,
            scrollHeight: 3000,
            scrollTop: 2650,
        });

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const syncMod = await import('@/sync/sync');
                const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();
                // FlashList reports a stale cold-list height, while the DOM scroller
                // carries the real hot/cold document height. WREG.6 requires the web path
                // to drain newer pages from the live DOM bottom distance.
                await primeFlashListMetrics(100, 400, { turns: 1 });
                loadOlderMessagesMock.mockClear();
                maybeDrainDeferredNewerMessagesMock.mockClear();

                scrollEl.scrollTop = 2720;
                await triggerFlashListChatListScroll(
                    0,
                    {
                        contentSize: { height: 400 },
                        layoutMeasurement: { height: 100 },
                    },
                    { turns: 2 },
                );
                await screen.settle({ turns: 2 });

                expect(maybeDrainDeferredNewerMessagesMock).toHaveBeenCalledWith('session-1', {
                    isPinned: false,
                    distanceFromBottomPx: 180,
                });
                expect(loadOlderMessagesMock).not.toHaveBeenCalled();

                scrollEl.scrollTop = 2800;
                await triggerFlashListChatListScroll(
                    0,
                    {
                        contentSize: { height: 400 },
                        layoutMeasurement: { height: 100 },
                    },
                    { turns: 2 },
                );
                await screen.settle({ turns: 2 });

                expect(maybeDrainDeferredNewerMessagesMock).toHaveBeenLastCalledWith('session-1', {
                    isPinned: false,
                    distanceFromBottomPx: 100,
                });
                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('defers web newer-page loading while intentionally unpinned until bottom approach (WREG.6)', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptForwardPrefetchThresholdPx: 240,
            transcriptWebInitialPinStabilizeMs: 0,
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 1200,
            anchor: null,
            lastUpdatedAt: 1,
            source: 'observed',
        });
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
            ],
        };
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 100,
            scrollHeight: 3000,
            scrollTop: 1400,
        });

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();
                await primeFlashListMetrics(100, 3000, { turns: 1 });
                maybeDrainDeferredNewerMessagesMock.mockClear();

                await triggerFlashListChatListScroll(
                    1400,
                    {
                        contentSize: { height: 3000 },
                        layoutMeasurement: { height: 100 },
                        isTrusted: true,
                    },
                    { turns: 2 },
                );
                await screen.settle({ turns: 2 });

                expect(maybeDrainDeferredNewerMessagesMock).toHaveBeenCalledWith('session-1', {
                    isPinned: false,
                    distanceFromBottomPx: 1200,
                });

                scrollEl.scrollTop = 2720;
                await triggerFlashListChatListScroll(
                    2720,
                    {
                        contentSize: { height: 3000 },
                        layoutMeasurement: { height: 100 },
                        isTrusted: true,
                    },
                    { turns: 2 },
                );
                await screen.settle({ turns: 2 });

                expect(maybeDrainDeferredNewerMessagesMock).toHaveBeenLastCalledWith('session-1', {
                    isPinned: false,
                    distanceFromBottomPx: 180,
                });
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('pins using the current session nativeID when multiple transcript lists exist in the DOM (web)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const wrongScroller = createFlashListChatListWebScroller({
            clientHeight: 500,
            scrollHeight: 2000,
            scrollTop: 111,
        });
        const rightScroller = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 3000,
            scrollTop: 0,
        });
        const rightScrollerBottom = Math.max(0, rightScroller.scrollHeight - rightScroller.clientHeight);
        const currentSessionNativeIdPrefix = buildChatListNativeId(sessionState.id, '');

        await withFlashListChatListWebScrollerDom(
            wrongScroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                // If DOM pinning accidentally targets the first `[data-testid="transcript-chat-list"]` in the
                // document, it would pin the wrong scroller. We must always pin the current session's list.
                expect(wrongScroller.scrollTop).toBe(111);
                expect(rightScroller.scrollTop).toBe(rightScrollerBottom);
            },
            {
                document: {
                    querySelector: () => wrongScroller,
                    getElementById: (id: string) => (id.startsWith(currentSessionNativeIdPrefix) ? rightScroller : null),
                },
                window: { getComputedStyle: () => ({ overflowY: 'auto' }) },
            },
        );
    });

    describe('slice-from-anchor entry restore (N2b.2: anchored entry = zero writes)', () => {
        type SliceHarnessMockState = {
            layoutAvailable: boolean;
            absoluteScrollOffset: number;
        };

        function installSliceFlashListRefHandle(state: SliceHarnessMockState) {
            const scrollToOffset = vi.fn();
            const scrollToIndex = vi.fn();
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 2 })),
                getAbsoluteLastScrollOffset: vi.fn(() => state.absoluteScrollOffset),
                getLayout: vi.fn((index: number) => {
                    if (!state.layoutAvailable) return undefined;
                    // MVCP-faithful layout mock: when the withheld row reveals above the
                    // window, the previously rendered rows keep their VISUAL position
                    // (FlashList's corrector holds the anchor) — the revealed row takes
                    // the space above.
                    const data = flashListChatListHarnessState.flashListProps?.data ?? [];
                    const base = data[0]?.id === 'm4' ? -240 : 0;
                    return { x: 0, y: base + index * 120, width: 320, height: 120 };
                }),
            };
            return { scrollToOffset, scrollToIndex };
        }

        function configureViewportTelemetrySink(telemetryMod: any) {
            const telemetrySink = vi.fn();
            telemetryMod.transcriptViewportTelemetry.configure({
                enabled: true,
                capacity: 256,
                sink: telemetrySink,
            });
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryEnabled: true,
                transcriptViewportTelemetryMaxEvents: 256,
            };
            return telemetrySink;
        }

        function listDataIds(): string[] {
            return (getCapturedFlashListProps()?.data ?? []).map((item: any) => item.id);
        }

        function committedScrollWriteEvents(telemetrySink: ReturnType<typeof vi.fn>): any[] {
            return telemetrySink.mock.calls
                .map(([event]: any[]) => event)
                .filter((event: any) => event?.type === 'scroll-write' && event.writer !== 'mvcp-skip');
        }

        const sliceMessages = [
            { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
            { kind: 'agent-text', id: 'm2', localId: null, realID: 'srv-m2', createdAt: 2, seq: 2, text: 'two' },
            { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
            { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
        ];

        it('builds the initial window at the captured anchor, lands write-free, confirms by observation, then reveals older rows as a prepend', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
                const telemetrySink = configureViewportTelemetrySink(telemetryMod);
                const mockState: SliceHarnessMockState = { layoutAvailable: false, absoluteScrollOffset: 0 };
                const { scrollToOffset, scrollToIndex } = installSliceFlashListRefHandle(mockState);
                sessionViewportByIdState.set('session-1', {
                    isPinned: false,
                    offsetY: 400,
                    anchor: { kind: 'message', messageId: 'm2', itemId: 'm2', itemOffsetPx: 0, capturedAtMs: 1 },
                    lastUpdatedAt: 1,
                    source: 'observed',
                });
                sessionMessagesState = { isLoaded: true, messages: sliceMessages };
                sessionState = { ...sessionState, active: true, thinking: true };

                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await primeFlashListMetrics(800, 1000, { turns: 2 });

                // The inverted data window starts at the anchor row visually and withholds
                // newer rows until the entry transaction confirms: m2 then older m1.
                expect(listDataIds()).toEqual(['m2', 'm1']);
                expect(scrollToOffset).not.toHaveBeenCalled();
                expect(scrollToIndex).not.toHaveBeenCalled();
                // Per-entry-mode list config: no startRenderingFromBottom for anchored entries.
                expect(getCapturedFlashListProps().maintainVisibleContentPosition).toBeUndefined();

                // The anchor row becomes measurable: the transaction confirms via observation only.
                mockState.layoutAvailable = true;
                await triggerFlashListChatListContentSizeChange(800, 1000, { frames: 1, turns: 2 });

                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'restore-decision',
                    reason: 'restored',
                    mode: 'restore-anchor',
                }));

                // After the entry transaction closes, the withheld newer rows reveal in
                // inverted rendered order. The fake layout models FlashList's corrector:
                // the two inserted rows are already covered, so the reveal is zero-write.
                await triggerFlashListChatListContentSizeChange(800, 1120, { frames: 1, turns: 2 });
                expect(listDataIds()).toEqual(['m4', 'm3', 'm2', 'm1']);
                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'restore-decision',
                    reason: 'mvcp-preserved',
                }));

                expect(committedScrollWriteEvents(telemetrySink)).toEqual([]);
                expect(scrollToOffset).not.toHaveBeenCalled();
                expect(scrollToIndex).not.toHaveBeenCalled();
            });
        });

        it('does not re-arm entry restore after a trusted released-reader scroll and message-boundary recarve', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
                const telemetrySink = configureViewportTelemetrySink(telemetryMod);
                const mockState: SliceHarnessMockState = { layoutAvailable: false, absoluteScrollOffset: 0 };
                const { scrollToOffset, scrollToIndex } = installSliceFlashListRefHandle(mockState);
                sessionViewportByIdState.set('session-1', {
                    isPinned: false,
                    offsetY: 400,
                    anchor: { kind: 'message', messageId: 'm2', itemId: 'm2', itemOffsetPx: 40, capturedAtMs: 1 },
                    lastUpdatedAt: 1,
                    source: 'observed',
                });
                sessionMessagesState = { isLoaded: true, messages: sliceMessages };

                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await primeFlashListMetrics(800, 1000, { turns: 2 });
                scrollToOffset.mockClear();
                scrollToIndex.mockClear();
                telemetrySink.mockClear();

                await act(async () => {
                    screen.getCapturedFlashListProps().onScrollBeginDrag?.({});
                });
                mockState.absoluteScrollOffset = 180;
                await triggerFlashListChatListScroll(
                    180,
                    {
                        contentSize: { height: 1000 },
                        layoutMeasurement: { height: 800 },
                        isTrusted: true,
                    },
                    { turns: 1 },
                );

                scrollToOffset.mockClear();
                scrollToIndex.mockClear();
                telemetrySink.mockClear();

                mockState.layoutAvailable = true;
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        ...sliceMessages,
                        { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                    ],
                };
                sessionState = { ...sessionState, seq: 5 };
                await screen.update(<ChatList session={{ ...sessionState, id: 'session-1' }} />);
                await screen.settle({ cycles: 2, turns: 4 });
                await triggerFlashListChatListContentSizeChange(800, 1120, { frames: 1, turns: 2 });

                expect(scrollToOffset).not.toHaveBeenCalled();
                expectNoNonBottomScrollToIndexWrites(scrollToIndex);
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    reason: 'entry-restore',
                }));

                await screen.unmount();
            });
        });

        it('session-switch preempts an open native prepend transaction before stale fallback can scroll the next session', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
                const telemetrySink = configureViewportTelemetrySink(telemetryMod);
                let entryLayoutAvailable = false;
                let revealedLayoutAvailable = false;
                let absoluteScrollOffset = 0;
                const scrollToOffset = vi.fn();
                const scrollToIndex = vi.fn();
                flashListRefHandle = {
                    scrollToOffset,
                    scrollToIndex,
                    computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 2 })),
                    getAbsoluteLastScrollOffset: vi.fn(() => absoluteScrollOffset),
                    getLayout: vi.fn((index: number) => {
                        const data = flashListChatListHarnessState.flashListProps?.data ?? [];
                        const hasRevealedRows = data[0]?.id === 'm4';
                        if (hasRevealedRows ? !revealedLayoutAvailable : !entryLayoutAvailable) {
                            return undefined;
                        }
                        const base = hasRevealedRows ? -240 : 0;
                        return { x: 0, y: base + index * 120, width: 320, height: 120 };
                    }),
                };
                const routeSession1ViewportChange = vi.fn((state: any) => {
                    routeSessionViewportChangeIntoTestStore('session-1', state);
                });
                const routeSession2ViewportChange = vi.fn((state: any) => {
                    routeSessionViewportChangeIntoTestStore('session-2', state);
                });
                sessionViewportByIdState.set('session-1', {
                    isPinned: false,
                    offsetY: 400,
                    anchor: { kind: 'message', messageId: 'm2', itemId: 'm2', itemOffsetPx: 0, capturedAtMs: 1 },
                    lastUpdatedAt: 1,
                    source: 'observed',
                });
                sessionMessagesState = { isLoaded: true, messages: sliceMessages };

                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={routeSession1ViewportChange} />,
                );
                await primeFlashListMetrics(800, 1000, { turns: 2 });
                expect(listDataIds()).toEqual(['m2', 'm1']);

                entryLayoutAvailable = true;
                await triggerFlashListChatListContentSizeChange(800, 1000, { frames: 1, turns: 2 });
                const session1TelemetryId = telemetrySink.mock.calls
                    .map(([event]: any[]) => event)
                    .find((event: any) =>
                        event?.type === 'restore-decision' &&
                        event.reason === 'restored' &&
                        event.mode === 'restore-anchor'
                    )?.sessionId;
                expect(session1TelemetryId).toEqual(expect.any(String));

                telemetrySink.mockClear();
                scrollToOffset.mockClear();
                scrollToIndex.mockClear();
                routeSession1ViewportChange.mockClear();

                await triggerFlashListChatListContentSizeChange(800, 1120, { frames: 1, turns: 2 });
                expect(listDataIds()).toEqual(['m4', 'm3', 'm2', 'm1']);
                expect(scrollToOffset).not.toHaveBeenCalled();
                expect(scrollToIndex).not.toHaveBeenCalled();
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'restore-decision',
                    reason: 'fallback-restored',
                }));

                telemetrySink.mockClear();
                sessionMessagesState = {
                    isLoaded: true,
                    messages: sliceMessages.map((message) => ({
                        ...message,
                        text: `session 2 ${message.text}`,
                    })),
                };
                sessionState = { ...sessionState, id: 'session-2', seq: 4 };
                await screen.update(
                    <ChatList session={{ ...sessionState }} onViewportChange={routeSession2ViewportChange} />,
                );
                await screen.settle({ cycles: 2, turns: 4 });

                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'restore-decision',
                    reason: 'abandoned-identity',
                    sessionId: session1TelemetryId,
                }));

                telemetrySink.mockClear();
                scrollToOffset.mockClear();
                scrollToIndex.mockClear();
                routeSession1ViewportChange.mockClear();
                routeSession2ViewportChange.mockClear();

                revealedLayoutAvailable = true;
                absoluteScrollOffset = 120;
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(1_000);
                });
                await triggerFlashListChatListContentSizeChange(800, 1240, { frames: 1, turns: 2 });
                await triggerFlashListChatListScroll(
                    absoluteScrollOffset,
                    {
                        contentSize: { height: 1240 },
                        layoutMeasurement: { height: 800 },
                    },
                    { turns: 1 },
                );
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(1_000);
                });
                await screen.settle({ cycles: 2, turns: 4 });

                expect(scrollToOffset).not.toHaveBeenCalled();
                expect(scrollToIndex).not.toHaveBeenCalled();
                expect(routeSession1ViewportChange).not.toHaveBeenCalled();
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    reason: 'prepend-restore',
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write-rejected',
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'restore-decision',
                    reason: 'fallback-restored',
                    sessionId: session1TelemetryId,
                }));

                await screen.unmount();
            });
        });

        it('slices from a hydrated persisted anchor carrying the server message id (restart-simulated entry)', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const mockState: SliceHarnessMockState = { layoutAvailable: false, absoluteScrollOffset: 0 };
                const { scrollToOffset, scrollToIndex } = installSliceFlashListRefHandle(mockState);
                // Restart-simulated: the hydrated anchor carries the SERVER id (realID) + seq —
                // rendered ids are runtime-local and never match across restarts.
                sessionViewportByIdState.set('session-1', {
                    isPinned: false,
                    offsetY: 400,
                    anchor: { kind: 'message', messageId: 'srv-m2', itemId: 'srv-m2', itemOffsetPx: 0, capturedAtMs: 1, seq: 2 } as any,
                    lastUpdatedAt: 1,
                    source: 'observed',
                });
                sessionMessagesState = { isLoaded: true, messages: sliceMessages };

                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await primeFlashListMetrics(800, 1000, { turns: 2 });

                expect(listDataIds()).toEqual(['m2', 'm1']);
                expect(scrollToOffset).not.toHaveBeenCalled();
                expect(scrollToIndex).not.toHaveBeenCalled();
            });
        });

        it('keeps the degraded write pipeline for anchors that stay unresolvable after bounded materialization', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const syncMod = await import('@/sync/sync');
                vi.mocked(syncMod.sync.loadOlderMessages).mockResolvedValue({
                    loaded: 0,
                    hasMore: false,
                    status: 'no_more',
                });
                const mockState: SliceHarnessMockState = { layoutAvailable: true, absoluteScrollOffset: 0 };
                const { scrollToOffset } = installSliceFlashListRefHandle(mockState);
                sessionViewportByIdState.set('session-1', {
                    isPinned: false,
                    offsetY: 400,
                    anchor: { kind: 'message', messageId: 'gone-m9', itemId: 'gone-m9', itemOffsetPx: 60, capturedAtMs: 1 },
                    lastUpdatedAt: 1,
                    source: 'observed',
                });
                sessionMessagesState = { isLoaded: true, messages: sliceMessages };

                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await primeFlashListMetrics(100, 1000, { turns: 4 });

                // Identity unfindable within the bounded budget: the existing distance
                // one-shot still issues exactly once (degraded fallback unchanged).
                expect(listDataIds()).toEqual(['m4', 'm3', 'm2', 'm1']);
                expect(scrollToOffset).toHaveBeenCalledWith({ offset: 400, animated: false });
                expect(scrollToOffset).toHaveBeenCalledTimes(1);
            });
        });

        it('keeps an under-filled sliced window write-free and pending until scrollable metrics settle', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const syncMod = await import('@/sync/sync');
                vi.mocked(syncMod.sync.loadOlderMessages).mockClear();
                const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
                const telemetrySink = configureViewportTelemetrySink(telemetryMod);
                const mockState: SliceHarnessMockState = { layoutAvailable: false, absoluteScrollOffset: 0 };
                const { scrollToOffset, scrollToIndex } = installSliceFlashListRefHandle(mockState);
                sessionViewportByIdState.set('session-1', {
                    isPinned: false,
                    offsetY: 100,
                    anchor: { kind: 'message', messageId: 'm2', itemId: 'm2', itemOffsetPx: 0, capturedAtMs: 1 },
                    lastUpdatedAt: 1,
                    source: 'observed',
                });
                sessionMessagesState = { isLoaded: true, messages: sliceMessages };

                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                // Under-filled: content fits the viewport; nothing can scroll.
                await primeFlashListMetrics(800, 300, { turns: 2 });

                expect(listDataIds()).toEqual(['m2', 'm1']);
                // The slice decides what to fill: no initial-fill network loads for the
                // sliced window (FlashList #2050 under-fill writes avoided by construction).
                expect(syncMod.sync.loadOlderMessages).not.toHaveBeenCalled();

                mockState.layoutAvailable = true;
                await triggerFlashListChatListContentSizeChange(800, 300, { frames: 1, turns: 2 });

                expect(scrollToOffset).not.toHaveBeenCalled();
                expect(scrollToIndex).not.toHaveBeenCalled();
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'restore-decision',
                    reason: 'restored',
                    mode: 'restore-anchor',
                }));

                await triggerFlashListChatListContentSizeChange(800, 1000, { frames: 1, turns: 2 });

                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'restore-decision',
                    reason: 'restored',
                    mode: 'restore-anchor',
                }));
            });
        });

        it('closes the empty-transcript anchored entry through the existing no-target path with zero writes', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const syncMod = await import('@/sync/sync');
                vi.mocked(syncMod.sync.loadOlderMessages).mockResolvedValue({
                    loaded: 0,
                    hasMore: false,
                    status: 'no_more',
                });
                const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
                const telemetrySink = configureViewportTelemetrySink(telemetryMod);
                const mockState: SliceHarnessMockState = { layoutAvailable: true, absoluteScrollOffset: 0 };
                const { scrollToOffset, scrollToIndex } = installSliceFlashListRefHandle(mockState);
                sessionViewportByIdState.set('session-1', {
                    isPinned: false,
                    offsetY: 400,
                    anchor: { kind: 'message', messageId: 'm2', itemId: 'm2', itemOffsetPx: 0, capturedAtMs: 1 },
                    lastUpdatedAt: 1,
                    source: 'observed',
                });
                sessionMessagesState = { isLoaded: true, messages: [] };

                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await primeFlashListMetrics(800, 0, { turns: 4 });
                await screen.settle({ advanceTimersMs: 50, cycles: 1, turns: 2 });

                expect(scrollToOffset).not.toHaveBeenCalled();
                expect(scrollToIndex).not.toHaveBeenCalled();
                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'restore-decision',
                    reason: 'skipped',
                }));
            });
        });
    });

    describe('viewport write ownership (single-owner wiring)', () => {
        it('keeps cold-open follow-bottom under FlashList bottom maintenance without owner conflicts (plan B1)', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
                const telemetrySink = vi.fn();
                telemetryMod.transcriptViewportTelemetry.configure({
                    enabled: true,
                    capacity: 64,
                    sink: telemetrySink,
                });
                const scrollToOffset = vi.fn();
                flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
                syncTuningState = {
                    ...syncTuningState,
                    transcriptViewportTelemetryEnabled: true,
                    transcriptViewportTelemetryMaxEvents: 64,
                };
                sessionState = { ...sessionState, active: true };
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                        { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming...' },
                    ],
                };

                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await primeFlashListMetrics(600, 1200, { turns: 4 });

                await settleNativeFlashListMount(screen);

                // Cold-open initial/settle pins are owned by FlashList bottom maintenance in
                // canonical inverted mode: no JS write is needed, and there are no owner conflicts.
                expect(getCapturedFlashListProps().maintainVisibleContentPosition).toEqual(expect.objectContaining({
                    startRenderingFromBottom: true,
                    animateAutoScrollToBottom: false,
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    reason: expect.stringMatching(/^(initial-open|mount-settle)$/),
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write-rejected',
                    reason: 'initial-open',
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write-rejected',
                    reason: 'mount-settle',
                }));
                telemetrySink.mockClear();

                // After the phase closes, streaming growth flows as the follow owner.
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        ...sessionMessagesState.messages,
                        { kind: 'assistant-text', id: 'a2', localId: null, createdAt: 3, text: 'token' },
                    ],
                };
                await screen.update(<ChatList session={{ ...sessionState, seq: 2 }} />);
                await screen.settle({ turns: 2 });
                await primeFlashListMetrics(600, 1500, { advanceTimersMs: 1, turns: 1 });

                expect(getCapturedFlashListProps().maintainVisibleContentPosition).toEqual(expect.objectContaining({
                    startRenderingFromBottom: true,
                    animateAutoScrollToBottom: false,
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    reason: 'stream-append',
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write-rejected',
                }));
            });
        });

        it('does not let native hot-tail height force a stream-append write before the session-open latch authorizes positioning', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
                const telemetrySink = vi.fn();
                telemetryMod.transcriptViewportTelemetry.configure({
                    enabled: true,
                    capacity: 64,
                    sink: telemetrySink,
                });
                const scrollToOffset = vi.fn();
                flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
                syncTuningState = {
                    ...syncTuningState,
                    transcriptNativeHotTailItemCount: 4,
                    transcriptViewportTelemetryEnabled: true,
                    transcriptViewportTelemetryMaxEvents: 64,
                };
                sessionState = { ...sessionState, active: true, thinking: true };
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                        {
                            kind: 'agent-text',
                            id: 'a1',
                            localId: null,
                            createdAt: 2,
                            meta: streamingAssistantMeta(),
                            text: 'streaming...',
                        },
                    ],
                };

                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await primeFlashListMetrics(600, 1200, { turns: 1 });

                const hotTailRows = screen.findByTestId('transcript-native-hot-tail-rows') as {
                    props?: { onLayout?: (event: unknown) => void };
                } | null;
                expect(hotTailRows).toBeTruthy();

                await act(async () => {
                    hotTailRows?.props?.onLayout?.({
                        nativeEvent: {
                            layout: {
                                height: 480,
                                width: 400,
                            },
                        },
                    });
                });
                await screen.settle({ turns: 2 });

                expect(scrollToOffset).not.toHaveBeenCalled();
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    reason: 'stream-append',
                }));
                expect(viewportControllerMockState.resolveInputs
                    .filter((input) => input.type === 'auto-follow')
                    .map((input) => input.reason)).not.toContain('stream-append');
                expect(getCapturedFlashListProps().maintainVisibleContentPosition).toEqual(expect.objectContaining({
                    startRenderingFromBottom: true,
                }));
            });
        });

        it('never re-issues the confirmed entry restore on content growth (no write, no owner conflict)', async () => {
            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
                const telemetrySink = vi.fn();
                telemetryMod.transcriptViewportTelemetry.configure({
                    enabled: true,
                    capacity: 64,
                    sink: telemetrySink,
                });
                const scrollToOffset = vi.fn();
                flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
                syncTuningState = {
                    ...syncTuningState,
                    transcriptViewportTelemetryEnabled: true,
                    transcriptViewportTelemetryMaxEvents: 64,
                };
                sessionViewportByIdState.set('session-1', {
                    isPinned: false,
                    offsetY: 500,
                    anchor: null,
                    lastUpdatedAt: 1,
                    source: 'observed',
                });
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'two' },
                    ],
                };

                const { ChatList } = await import('./ChatList');
                await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState, id: 'session-1' }} />);
                await primeFlashListMetrics(100, 1000, { turns: 4 });

                // While the entry phase is open, the entry-restore write executes through the seam.
                expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 500, animated: false });

                // A non-trusted observation at the restore target confirms it and ends the entry phase.
                await scrollFlashListTo(400, { trusted: false, turns: 1 });

                scrollToOffset.mockClear();
                telemetrySink.mockClear();

                // Content growth used to re-issue the protected entry restore (evidence E1).
                // With the entry-restore transaction the reapply path is structurally gone:
                // no entry write is even attempted, so there is nothing for the owner gate to
                // reject - zero writes, zero owner conflicts.
                await triggerFlashListChatListContentSizeChange(320, 2000, { turns: 2, frames: 1 });

                expect(scrollToOffset).not.toHaveBeenCalled();
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    reason: 'entry-restore',
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write-rejected',
                    reason: 'entry-restore',
                }));
            });
        });

        it('suspends older pagination and never opens a prepend transaction while the entry restore phase is open', async () => {
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

            await withWebFlashListFakeTimers(0, async () => {
                runtimeMockState.platformOs = 'ios';
                const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
                const telemetrySink = vi.fn();
                telemetryMod.transcriptViewportTelemetry.configure({
                    enabled: true,
                    capacity: 64,
                    sink: telemetrySink,
                });
                const scrollToIndex = vi.fn();
                const scrollToOffset = vi.fn();
                // Anchor-stable layout mock (N2b.2): rows keep their VISUAL position as the
                // window grows above (m4 is the entry anchor and stays at the raw scroll
                // offset for a saved itemOffsetPx=0), matching
                // what FlashList's MVCP/corrector guarantees across prepends.
                let layoutAvailable = false;
                flashListRefHandle = {
                    scrollToOffset,
                    scrollToIndex,
                    computeVisibleIndices: vi.fn(() => {
                        const data = flashListChatListHarnessState.flashListProps?.data ?? [];
                        const anchorIndex = data.findIndex((item: any) => item.id === 'm4');
                        return { startIndex: anchorIndex, endIndex: anchorIndex };
                    }),
                    getAbsoluteLastScrollOffset: vi.fn(() => nativeRawOffsetForCanonicalOffset(100)),
                    getLayout: vi.fn((index: number) => {
                        if (!layoutAvailable) return undefined;
                        const data = flashListChatListHarnessState.flashListProps?.data ?? [];
                        const anchorIndex = data.findIndex((item: any) => item.id === 'm4');
                        const base = anchorIndex >= 0 ? 100 - anchorIndex * 120 : 100;
                        return { x: 0, y: base + index * 120, width: 320, height: 100 };
                    }),
                };
                syncTuningState = {
                    ...syncTuningState,
                    transcriptViewportTelemetryEnabled: true,
                    transcriptViewportTelemetryMaxEvents: 64,
                };
                sessionViewportByIdState.set('session-1', {
                    isPinned: false,
                    offsetY: 300,
                    anchor: {
                        kind: 'message',
                        messageId: 'm4',
                        itemId: 'm4',
                        itemOffsetPx: 0,
                        capturedAtMs: 1,
                    },
                    lastUpdatedAt: 1,
                    source: 'observed',
                });
                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'user-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
                        { kind: 'agent-text', id: 'm4', localId: null, createdAt: 4, seq: 4, text: 'four' },
                        { kind: 'agent-text', id: 'm5', localId: null, createdAt: 5, seq: 5, text: 'five' },
                    ],
                };
                loadOlderMessagesMock.mockImplementation(async () => {
                    sessionMessagesState = {
                        isLoaded: true,
                        messages: [
                            { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                            ...sessionMessagesState.messages,
                        ],
                    };
                    return { loaded: 2, hasMore: true, status: 'loaded' as const };
                });
                loadOlderMessagesMock.mockClear();

                syncTuningState = {
                    ...syncTuningState,
                    transcriptBackwardPrefetchThresholdPx: 240,
                };

                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(
                    <ChatList session={{ ...sessionState, id: 'session-1' }} />,
                );
                await primeFlashListMetrics(100, 1000, { turns: 4 });

                // N2b.2: the inverted anchored entry slices the window at the anchor (no write) and
                // the observe-only transaction stays open while the anchor is unmeasurable.
                expect(scrollToIndex).not.toHaveBeenCalled();
                expect((getCapturedFlashListProps()?.data ?? []).map((item: any) => item.id)).toEqual(['m4', 'm3']);
                telemetrySink.mockClear();

                // While the entry phase is open the pagination machine is suspended, so no
                // older page can load and no prepend transaction can open (plan F4/F5: the
                // owner conflict is prevented before the seam, not just rejected at it).
                // Under inverted native the visual older edge is FlashList's end edge.
                await triggerFlashListChatListEndReached({ turns: 2 });
                await screen.settle({ cycles: 2, turns: 4 });

                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                expect(scrollToOffset).not.toHaveBeenCalled();
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    reason: 'prepend-restore',
                }));

                // This broad ownership test stops at the open-entry invariant. The
                // dedicated inverted suite drives the full slice close/reveal cycle.
                expect((getCapturedFlashListProps()?.data ?? []).map((item: any) => item.id)).toEqual(['m4', 'm3']);
                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                expect(scrollToIndex).not.toHaveBeenCalled();
                expect(scrollToOffset).not.toHaveBeenCalled();
            });
        });
    });
});
