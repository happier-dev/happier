import {
    flashListChatListHarnessState,
    createFlashListChatListWebElement,
    createFlashListChatListWebScroller,
    FlashListChatListWebElement,
    renderFlashListChatList,
    triggerFlashListChatListContentSizeChange,
    triggerFlashListChatListInitialFill,
    triggerFlashListChatListLoad,
    triggerFlashListChatListScroll,
    triggerFlashListChatListStartReached,
    withRenderedFlashListChatListWebScroller,
    withFlashListChatListWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import * as React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { buildChatListNativeId } from './chatListNativeId';
import { __resetDefaultTranscriptItemHeightCacheForTests } from './measurement/transcriptItemHeightCache';
import { __resetTranscriptWarmPaintCacheForTests } from './paint/transcriptWarmPaintCache';

type TranscriptSelectionContextModule = typeof import('@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext');

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
let renderedFlatListCount = 0;
let renderedFlashListCount = 0;
let renderedToolCallsGroupRowProps: any[] = [];
let flashListRefHandle: any = null;
let transcriptIdsHookCallCount = 0;
let messageViewRenderOverride: ((props: any) => React.ReactElement) | null = null;
const mountedTrees: ReactTestRenderer[] = [];

function getCapturedFlashListProps(): any {
    const props = flashListChatListHarnessState.flashListProps ?? capturedFlashListProps;
    expect(props).toBeTruthy();
    return props;
}

function readOlderHeaderLoading(): boolean {
    return getCapturedFlashListProps().ListHeaderComponent?.props?.isLoadingOlder === true;
}

async function renderTrackedFlashListChatList(element: React.ReactElement) {
    const screen = await renderFlashListChatList(element, {
        flushOptions: { cycles: 0 },
    });
    mountedTrees.push(screen.tree);
    return screen;
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

function renderMockMessageView(props: any): React.ReactElement {
    if (messageViewRenderOverride) return messageViewRenderOverride(props);
    return React.createElement('MessageView');
}

function TranscriptSelectionRowProbe(props: {
    messageId: string;
    selectionContext: Pick<TranscriptSelectionContextModule, 'useTranscriptSelectionActions' | 'useTranscriptSelectionRow'>;
}): React.ReactElement {
    const row = props.selectionContext.useTranscriptSelectionRow(props.messageId);
    const actions = props.selectionContext.useTranscriptSelectionActions();

    return React.createElement('TranscriptSelectionRowProbe', {
        testID: `transcript-selection-row-probe:${props.messageId}`,
        selectionMode: row.isSelectionMode,
        selected: row.isSelected,
        onPress: () => actions.enter(props.messageId),
    });
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
                },
            },
        });
    });
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
        advanceTimersMs: Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) + 1,
        cycles: 1,
        turns: 2,
    });
}

async function mockNoOlderMessages(): Promise<void> {
    const syncMod = await import('@/sync/sync');
    vi.mocked(syncMod.sync.loadOlderMessages).mockResolvedValue({
        loaded: 0,
        hasMore: false,
        status: 'no_more',
    });
}

async function enableNativeViewportTelemetry(): Promise<ReturnType<typeof vi.fn>> {
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
    return telemetrySink;
}

function expectNativeMvcpSkip(
    telemetrySink: ReturnType<typeof vi.fn>,
    reason: string,
    extra: Record<string, unknown> = {},
): void {
    expect(telemetrySink.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
        expect.objectContaining({
            type: 'scroll-write',
            writer: 'mvcp-skip',
            reason,
            mode: 'follow-bottom',
            platform: expect.stringMatching(/^(ios|android)$/),
            listImplementation: 'flash_v2',
            ...extra,
        }),
    ]));
}

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionTranscriptIdsState: string[] | null = null;
let sessionMessagesByIdSnapshot: { messages: any[]; byId: Record<string, any> } = { messages: [], byId: {} };
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
let transcriptTurnsState: any[] = [];
let sessionState: any = null;
let useSessionCallCount = 0;
type SessionViewportTestSnapshot = {
    isPinned: boolean;
    offsetY: number;
    anchor?: {
        kind: 'message' | 'toolGroup' | 'item';
        messageId?: string | null;
        itemId: string;
        itemOffsetPx: number;
        capturedAtMs: number;
    } | null;
    lastUpdatedAt: number;
    source: 'default' | 'observed';
};

let sessionViewportByIdState = new Map<string, SessionViewportTestSnapshot>();
// Stateful deferred-newer marker (plan D6): drains observe the marker clearing after a load settles.
let deferredNewerSessionIdsState = new Set<string>();

// Mirror sync.onSessionViewportChange routing so web capture -> persist tests exercise the real
// observed-vs-live-tail intent contract instead of asserting only the raw emit payload.
function routeSessionViewportChangeIntoTestStore(
    sessionId: string,
    state: { isPinned: boolean; offsetY: number; shouldRestoreViewport?: boolean; anchor?: SessionViewportTestSnapshot['anchor'] },
): void {
    if (!sessionId) return;
    if (state.shouldRestoreViewport !== true) {
        sessionViewportByIdState.set(sessionId, {
            isPinned: true,
            offsetY: 0,
            anchor: null,
            lastUpdatedAt: Date.now(),
            source: 'default',
        });
        return;
    }
    if (state.isPinned === true) {
        const prevViewport = sessionViewportByIdState.get(sessionId);
        if (prevViewport?.source === 'observed' && prevViewport.isPinned === false) {
            return;
        }
        sessionViewportByIdState.set(sessionId, {
            isPinned: true,
            offsetY: 0,
            anchor: null,
            lastUpdatedAt: Date.now(),
            source: 'default',
        });
        return;
    }
    sessionViewportByIdState.set(sessionId, {
        isPinned: false,
        offsetY: state.offsetY,
        anchor: state.anchor ?? null,
        lastUpdatedAt: Date.now(),
        source: 'observed',
    });
}

const settingValues: Record<string, any> = {};
const runtimeMockState = vi.hoisted(() => ({
    platformOs: 'web' as 'web' | 'ios' | 'android',
}));
const reducedMotionMockState = vi.hoisted(() => ({
    preferred: false,
}));
const markdownRuntimeMockState = vi.hoisted(() => ({
    preload: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    ready: true,
}));
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

type SyncTuningMock = Record<string, number | number[] | boolean>;

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
    transcriptItemHeightCacheMaxEntries: 1024,
    transcriptFlashListDrawDistance: 0,
    transcriptMountSettleQuiescentWindowMs: 120,
    transcriptMountSettleDimensionNoiseFloorPx: 1,
    transcriptMountSettleBottomDistanceNoiseFloorPx: 2,
    transcriptInitialFillBudgetMs: 2000,
    transcriptNativeOlderMessagesPageSize: 64,
};

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
    useLayoutState: <T,>(initialValue: T) => React.useState(initialValue),
    useMappingHelper: () => ({
        getMappingKey: (_key: string | number, index: number) => index,
    }),
    useRecyclingState: <T,>(initialValue: T, dependencies: readonly unknown[], onReset?: () => void) => {
        const [state, setState] = React.useState(initialValue);
        React.useEffect(() => {
            setState(initialValue);
            onReset?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
        }, dependencies);
        return [state, setState] as const;
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

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
    useSession: () => {
        useSessionCallCount += 1;
        return sessionState;
    },
    useSessionChatFooterState: () => ({
        controlledByUser: sessionState?.agentState?.controlledByUser === true,
        localControl: null,
        permissionsInUiWhileLocal: false,
    }),
    useSessionTranscriptIds: () => {
        transcriptIdsHookCallCount += 1;
        return {
            ids: sessionTranscriptIdsState ?? (sessionMessagesState.messages ?? []).map((m: any) => m.id),
            isLoaded: sessionMessagesState.isLoaded,
        };
    },
    useSessionMessagesById: () => getSessionMessagesByIdSnapshot(),
    useForkedTranscriptSnapshot: () => null,
    useSessionPendingMessages: () => sessionPendingState,
    useSessionActionDrafts: () => sessionActionDraftsState,
    useSessionLatestThinkingMessageId: () => null,
    useSessionLatestThinkingMessageActivityAtMs: () => null,
    useMessage: (_sessionId: string, messageId: string) =>
        (sessionMessagesState.messages ?? []).find((message: any) => message.id === messageId) ?? null,
    useSetting: (key: string) => settingValues[key],
    getStorage: () => {
        const sessionMessages = {
            messagesById: getSessionMessagesByIdSnapshot(),
            messagesMap: getSessionMessagesByIdSnapshot(),
        };
        return {
            getState: () => ({
                sessionMessages: {
                    [sessionState?.id ?? 'session-1']: sessionMessages,
                    undefined: sessionMessages,
                },
            }),
        };
    },
});
});

vi.mock('@/components/sessions/chatListItems', () => {
    const buildMockChatListItems = ({ includeCommittedMessages, messageIdsOldestFirst, messagesById, pendingMessages, discardedMessages }: any) => {
        const committedLocalIds = new Set<string>();
        const committedMessageIds = includeCommittedMessages === false ? [] : (messageIdsOldestFirst ?? []);
        const items = committedMessageIds.map((id: string) => {
            const m = messagesById?.[id];
            if (typeof m?.localId === 'string' && m.localId.length > 0) {
                committedLocalIds.add(m.localId);
            }
            return { kind: 'message', id, messageId: id, createdAt: m?.createdAt ?? 0, seq: null };
        });
        const pending = (pendingMessages ?? []).filter((pendingMessage: any) =>
            typeof pendingMessage?.localId !== 'string' || pendingMessage.localId.length === 0 || !committedLocalIds.has(pendingMessage.localId)
        );
        if (pending.length > 0 || (discardedMessages ?? []).length > 0) {
            items.push({
                kind: 'pending-queue',
                id: 'pending-queue',
                pendingMessages: pending,
                discardedMessages: discardedMessages ?? [],
            });
        }
        return items;
    };
    const buildMockChatListItemsSignature = (opts: any) => JSON.stringify({
        includeCommittedMessages: opts?.includeCommittedMessages !== false,
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
        discardedCount: (opts?.discardedMessages ?? []).length,
    });
    return {
        buildChatListItems: buildMockChatListItems,
        buildChatListItemsCached: (opts: any) => {
            const signature = buildMockChatListItemsSignature(opts);
            if (opts?.cache?.signature === signature) {
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
    };
});

vi.mock('@/components/sessions/transcript/forkContext/injectForkContextRows', async () => await import('./forkContext/injectForkContextRows'));

vi.mock('@/components/sessions/transcript/forkContext/ForkDividerRow', () => ({
    ForkDividerRow: () => React.createElement('ForkDividerRow'),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter', { testID: 'chat-footer' }),
}));

vi.mock('./MessageView', () => ({
    MessageView: (props: any) => renderMockMessageView(props),
    MessageViewWithSessionCommon: (props: any) => renderMockMessageView(props),
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
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnView'),
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
                ...controller,
                resolve: (input: Parameters<typeof controller.resolve>[0]) => {
                    viewportControllerMockState.resolveInputs.push(input as unknown as Record<string, unknown>);
                    return controller.resolve(input);
                },
            };
        },
    };
});

vi.mock('@/components/sessions/transcript/turnGrouping/buildTranscriptTurns', () => ({
    buildTranscriptTurnsCached: () => ({
        cache: null,
        turns: transcriptTurnsState,
    }),
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: (props: any) => {
        renderedToolCallsGroupRowProps.push(props);
        return React.createElement('ToolCallsGroupRow');
    },
    ToolCallsGroupRowWithSessionCommon: (props: any) => {
        renderedToolCallsGroupRowProps.push(props);
        return React.createElement('ToolCallsGroupRow');
    },
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
    JumpToBottomButton: (props: any) => React.createElement('JumpToBottomButton', props),
}));

vi.mock('@/components/sessions/transcript/scroll/transcriptScrollPinController', async () => await import('./scroll/transcriptScrollPinController'));

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

vi.mock('@/sync/sync', () => ({
    sync: {
        loadOlderMessages: vi.fn(),
        loadNewerMessages: vi.fn(),
        hasDeferredNewerMessages: (sessionId: string) => deferredNewerSessionIdsState.has(sessionId),
        getSyncTuning: () => syncTuningState,
        getSessionViewport: (sessionId: string) => sessionViewportByIdState.get(sessionId) ?? null,
        onSessionViewportChange: (sessionId: string, state: any) => routeSessionViewportChangeIntoTestStore(sessionId, state),
        markSessionLiveTailIntent: (sessionId: string) => routeSessionViewportChangeIntoTestStore(sessionId, { isPinned: true, offsetY: 0 }),
    },
}));

vi.mock('@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId', async () => await import('./thinking/resolveActiveThinkingMessageId'));

vi.mock('@/sync/domains/settings/settings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/settings/settings')>();
    return {
        ...actual,
        settingsDefaults: {},
    };
});

vi.mock('@/agents/registry/registryCore', () => ({
    AGENT_IDS: ['codex'],
    CANONICAL_AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: () => ({
        id: 'codex',
        displayNameKey: 'agents.codex',
        subtitleKey: 'agents.codex.subtitle',
        permissionModeI18nPrefix: 'agentInput.codexPermissionMode',
        availability: { experimental: false },
        connectedServices: null,
        uiConnectedService: { serviceId: null, label: 'Codex', connectRoute: null },
        flavorAliases: ['codex'],
        cli: {
            detectKey: 'codex',
            machineLoginKey: 'codex',
            spawnAgent: 'codex',
            installBanner: { installKind: 'ifAvailable' },
        },
        permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
        sessionModes: { kind: 'none' },
        sessionStorage: { e2ee: true, plain: true },
    }),
    isAgentId: (value: unknown) => value === 'codex',
    resolveAgentIdFromFlavor: () => 'codex',
}));

vi.mock('./chatListNativeId', () => ({
    buildChatListNativeId: (sessionId: string, reactId: string) => `chat-list-${sessionId}-${reactId}`,
}));

vi.mock('@/components/ui/lists/useWebFlashListCrashFallback', () => ({
    useWebFlashListCrashFallback: () => false,
}));

vi.mock('@/components/sessions/transcript/segments/buildTranscriptHotColdSegments', async () => await import('./segments/buildTranscriptHotColdSegments'));

vi.mock('@/components/sessions/transcript/webTranscriptScrollMetrics', async () => await import('./webTranscriptScrollMetrics'));

vi.mock('@/components/sessions/transcript/web/WebTranscriptSplitFooter', async () => await import('./web/WebTranscriptSplitFooter'));

vi.mock('@/components/sessions/transcript/webTranscriptPrependAnchor', async () => await import('./webTranscriptPrependAnchor'));

vi.mock('@/components/sessions/keyboardAvoidance', () => ({
    ComposerKeyboardScrollInset: (props: { testID?: string; onHeightChange?: (height: number) => void }) =>
        React.createElement('ComposerKeyboardScrollInset', {
            ...props,
            testID: props.testID ?? 'transcript-composer-keyboard-inset',
        }),
    ComposerKeyboardFloatingInset: ({ children, testID }: { children: React.ReactNode; testID?: string }) =>
        React.createElement('ComposerKeyboardFloatingInset', {
            testID: testID ?? 'transcript-jump-to-bottom-keyboard-offset',
        }, children),
}));

describe('ChatList (FlashList v2)', () => {
    beforeEach(() => {
        vi.resetModules();
        __resetDefaultTranscriptItemHeightCacheForTests();
        __resetTranscriptWarmPaintCacheForTests();
        runtimeMockState.platformOs = 'web';
        reducedMotionMockState.preferred = false;
        markdownRuntimeMockState.ready = true;
        markdownRuntimeMockState.preload.mockReset();
        markdownRuntimeMockState.preload.mockImplementation(() => Promise.resolve());
        jumpToTranscriptSeqMockState.implementation = null;
        viewportControllerMockState.resolveInputs = [];
        capturedFlashListProps = null;
        flashListChatListHarnessState.flashListProps = null;
        renderedFlatListCount = 0;
        renderedFlashListCount = 0;
        renderedToolCallsGroupRowProps = [];
        flashListRefHandle = null;
        transcriptIdsHookCallCount = 0;
        messageViewRenderOverride = null;
        mountedTrees.length = 0;
        sessionMessagesState = { messages: [], isLoaded: true };
        sessionTranscriptIdsState = null;
        sessionMessagesByIdSnapshot = { messages: [], byId: {} };
        sessionPendingState = { messages: [] };
        sessionActionDraftsState = [];
        transcriptTurnsState = [];
        useSessionCallCount = 0;
        sessionViewportByIdState = new Map();
        deferredNewerSessionIdsState = new Set();
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
            transcriptDerivedItemsCacheMaxSessions: 8,
            transcriptItemHeightCacheMaxEntries: 1024,
            transcriptFlashListDrawDistance: 0,
            transcriptMountSettleQuiescentWindowMs: 120,
            transcriptMountSettleDimensionNoiseFloorPx: 1,
            transcriptMountSettleBottomDistanceNoiseFloorPx: 2,
            transcriptInitialFillBudgetMs: 2000,
            transcriptNativeOlderMessagesPageSize: 64,
        };
        for (const k of Object.keys(settingValues)) delete settingValues[k];
        settingValues.transcriptGroupingMode = 'linear';
        settingValues.transcriptGroupToolCalls = false;
        settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
        settingValues.transcriptListImplementation = 'flash_v2';
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
        const telemetryMod = await import('./scroll/transcriptViewportTelemetry');
        telemetryMod.transcriptViewportTelemetry.configure({ enabled: false, sink: null });
    });

    it('renders the footer without subscribing to the full session object', async () => {
        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.findByTestId('chat-footer')).toBeTruthy();
        expect(useSessionCallCount).toBe(0);
    });

    it('omits maintainVisibleContentPosition on web to avoid FlashList layout crashes', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(renderedFlatListCount).toBe(0);
        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toBeUndefined();
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

        expect(renderedToolCallsGroupRowProps.length).toBeGreaterThan(0);
        expect(renderedToolCallsGroupRowProps.every((props) => (
            props.toolCallsGroupId === 'turn-tools-group' &&
            Array.isArray(props.toolMessageIds) &&
            props.toolMessageIds.length === 200
        ))).toBe(true);
        expect(renderedToolCallsGroupRowProps.some((props) => props.toolMessageIds?.length === 8)).toBe(false);

        await screen.unmount();
    });

    it('does not rerender the virtualized transcript list for committed seq-only session changes', async () => {
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

    it('skips parent-driven transcript work when non-transcript session status changes', async () => {
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
        transcriptIdsHookCallCount = 0;
        renderedFlashListCount = 0;

        await screen.update(<ChatList session={{ ...sessionState, latestTurnStatus: { status: 'running' } }} />);

        expect(transcriptIdsHookCallCount).toBe(0);
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

        expect(screen.getCapturedFlashListProps().keyboardDismissMode).toBe('none');
    });

    it('provides transcript message selection context to rendered message rows', async () => {
        settingValues.transcriptMessageSelectionEnabled = true;
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };
        const selectionContext = await import('@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext');
        messageViewRenderOverride = (props: any) => (
            <TranscriptSelectionRowProbe messageId={props.message.id} selectionContext={selectionContext} />
        );

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps().extraData).toBe(0);
        const initialProbe = screen.findByTestId('transcript-selection-row-probe:u1');
        if (!initialProbe) throw new Error('Expected transcript selection row probe to render');
        expect(initialProbe.props).toMatchObject({
            selectionMode: false,
            selected: false,
        });

        await act(async () => {
            initialProbe.props.onPress();
        });

        expect(screen.getCapturedFlashListProps().extraData).toBe(1);
        const updatedProbe = screen.findByTestId('transcript-selection-row-probe:u1');
        if (!updatedProbe) throw new Error('Expected transcript selection row probe to remain rendered');
        expect(updatedProbe.props).toMatchObject({
            selectionMode: true,
            selected: true,
        });
    });

    it('defers native FlashList bottom pin until mount settle for fresh follow-bottom entries', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            await mockNoOlderMessages();
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
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

            await primeFlashListMetrics(100, 1000, { turns: 2 });

            expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

            await settleNativeFlashListMount(screen);

            expect(flashListRefHandle.scrollToOffset).toHaveBeenCalledWith({
                offset: 900,
                animated: false,
            });
        });
    });

    it('pins default native follow-bottom when first content becomes scrollable', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
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

            await act(async () => {
                getCapturedFlashListProps().onContentSizeChange(0, 1200);
            });
            await screen.settle({ advanceTimersMs: 1, cycles: 1, turns: 2 });

            expect(viewportControllerMockState.resolveInputs).toContainEqual(expect.objectContaining({
                reason: 'content-size-change',
                targetOffsetY: 600,
                type: 'auto-follow',
            }));
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 600,
                animated: false,
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

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9883,
                animated: false,
            });
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                writer: 'native-scroll-to-offset',
                reason: 'content-size-change',
                mode: 'follow-bottom',
                targetOffsetY: 9883,
            }));
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

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9889,
                animated: false,
            });
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                writer: 'native-scroll-to-offset',
                reason: 'content-size-change',
                mode: 'follow-bottom',
                targetOffsetY: 9889,
            }));
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
                getAbsoluteLastScrollOffset: vi.fn(() => 0),
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
                getAbsoluteLastScrollOffset: vi.fn(() => 100),
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

            // Parked inside the threshold: the cooldown elapsing alone never chains
            // another load (E6 anti-burst; re-arm requires a threshold exit -> enter).
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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

        const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        getCapturedFlashListProps();
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await primeFlashListMetrics(600, 1200, { turns: 1 });
        await scrollFlashListTo(100);

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

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
        expect(loadOlderMessagesMock).toHaveBeenCalledWith('session-1');
    });

    it('limits native older-page loads to the configured native page size', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        runtimeMockState.platformOs = 'ios';
        flashListRefHandle = {
            scrollToOffset: vi.fn(),
            scrollToIndex: vi.fn(),
            computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 3 })),
            getAbsoluteLastScrollOffset: vi.fn(() => 100),
            getLayout: vi.fn((index: number) => ({
                x: 0,
                y: index * 120,
                width: 320,
                height: 100,
            })),
        };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                { kind: 'agent-text', id: 'm3', localId: null, createdAt: 3, seq: 3, text: 'three' },
            ],
        };
        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 240,
            transcriptNativeOlderMessagesPageSize: 37,
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
        expect(loadOlderMessagesMock).toHaveBeenCalledWith('session-1', { limit: 37 });
    });

    it('derives FlashList onStartReached threshold from configured backward prefetch pixels', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };
        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 300,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        await primeFlashListMetrics(600, 1200, { turns: 1 });

        expect(getCapturedFlashListProps().onStartReachedThreshold).toBeCloseTo(0.5);
    });

    it('uses configured backward prefetch pixels when web onStartReached fires near the top', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 450,
        });

        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = {
            ...syncTuningState,
            transcriptBackwardPrefetchThresholdPx: 400,
            transcriptWebInitialPinStabilizeMs: 0,
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
                await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                await primeFlashListMetrics(600, 1200);
                await scrollFlashListTo(450);
                loadOlderMessagesMock.mockClear();

                scrollEl.scrollTop = 350;
                await triggerFlashListChatListStartReached();

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
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

    it('keeps the older-load spinner hidden during the proactive prefetch delay', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            let resolveLoadOlder = createMissingLoadOlderResolver();
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
                transcriptOlderLoadSpinnerDelayMs: 300,
                transcriptWebInitialPinStabilizeMs: 0,
            };
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(600, 1200);

            await scrollFlashListTo(100);

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expect(readOlderHeaderLoading()).toBe(false);

            resolveLoadOlder({ loaded: 1, hasMore: true, status: 'loaded' });
            await screen.settle({ cycles: 1, turns: 1 });
        });
    });

    it('shows the older-load spinner after the proactive prefetch delay elapses', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            let resolveLoadOlder = createMissingLoadOlderResolver();
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
                transcriptOlderLoadSpinnerDelayMs: 300,
                transcriptWebInitialPinStabilizeMs: 0,
            };
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(600, 1200);

            await scrollFlashListTo(100);
            await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 300 });

            expect(readOlderHeaderLoading()).toBe(false);
            expect(countVisibleOlderLoadSpinners(screen)).toBeGreaterThan(0);
            expect(countExactTestId(screen, 'transcript-older-load-progress-overlay')).toBe(1);

            resolveLoadOlder({ loaded: 1, hasMore: true, status: 'loaded' });
            await screen.settle({ cycles: 1, turns: 1 });
        });
    });

    it('keeps older-load progress out of scrollable header geometry during prepend loading', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            let resolveLoadOlder = createMissingLoadOlderResolver();
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
                transcriptOlderLoadSpinnerDelayMs: 300,
                transcriptWebInitialPinStabilizeMs: 0,
            };
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(600, 1200);
            const headerBeforeLoad = screen.getCapturedFlashListProps().ListHeaderComponent;

            await scrollFlashListTo(100);
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 300 });

            expect(countVisibleOlderLoadSpinners(screen)).toBeGreaterThan(0);
            expect(countExactTestId(screen, 'transcript-older-load-progress-overlay')).toBe(1);
            expect(screen.getCapturedFlashListProps().ListHeaderComponent).toBe(headerBeforeLoad);

            resolveLoadOlder({ loaded: 1, hasMore: true, status: 'loaded' });
            await screen.settle({ cycles: 1, turns: 1 });

            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
            expect(countExactTestId(screen, 'transcript-older-load-progress-overlay')).toBe(0);
            expect(screen.getCapturedFlashListProps().ListHeaderComponent).toBe(headerBeforeLoad);
        });
    });

    it('shows the older-load spinner after the spinner delay while a user-triggered older load is in flight', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const syncMod = await import('@/sync/sync');
            const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
            let resolveLoadOlder = createMissingLoadOlderResolver();
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
                transcriptOlderLoadSpinnerDelayMs: 300,
                transcriptWebInitialPinStabilizeMs: 0,
            };
            sessionState = { ...sessionState, seq: 25 };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

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

            resolveLoadOlder({ loaded: 1, hasMore: true, status: 'loaded' });
            await screen.settle({ turns: 1 });
            expect(countVisibleOlderLoadSpinners(screen)).toBe(0);
        });
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

                await primeFlashListMetrics(600, 1200);

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

                await primeFlashListMetrics(600, 1200);
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

        await primeFlashListMetrics(600, 1200);
        await scrollFlashListTo(200, { trusted: true, turns: 1 });
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await triggerFlashListChatListStartReached({ turns: 1 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
        expect(readOlderHeaderLoading()).toBe(false);
        expect(countExactTestId(screen, 'transcript-older-loading')).toBe(0);
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

        await primeFlashListMetrics(600, 1200);
        await scrollFlashListTo(200, { trusted: true, turns: 1 });
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await triggerFlashListChatListStartReached({ turns: 1 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
        expect(readOlderHeaderLoading()).toBe(false);
        expect(countExactTestId(screen, 'transcript-older-loading')).toBe(0);
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

                // A trusted user scroll after the prepend commit retargets the pending
                // anchor to the new position, so later growth preserves THAT viewport
                // (G-1 late-RD delta: retargetPendingWebPrependAnchorForUserScroll).
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

        let resolveLoadOlder = createMissingLoadOlderResolver();
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
                resolveLoadOlder({ loaded: 5, hasMore: true, status: 'loaded' });
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

        const originalItemAnchor = createFlashListChatListWebElement('transcript-item-m1', { top: 120, bottom: 220 });
        const originalMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 140, bottom: 190 });
        const programmaticItemAnchor = createFlashListChatListWebElement('transcript-item-m2', { top: 500, bottom: 600 });
        const programmaticMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-m2', { top: 520, bottom: 570 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [originalItemAnchor, originalMessageAnchor, programmaticItemAnchor, programmaticMessageAnchor],
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
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
            ],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                await primeFlashListMetrics(600, 1200);
                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                originalItemAnchor.setRect({ top: 120, bottom: 220 });
                originalMessageAnchor.setRect({ top: 140, bottom: 190 });
                programmaticItemAnchor.setRect({ top: 500, bottom: 600 });
                programmaticMessageAnchor.setRect({ top: 520, bottom: 570 });
                await scrollFlashListTo(100);

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollTop = 300;
                originalItemAnchor.setRect({ top: -80, bottom: 20 });
                originalMessageAnchor.setRect({ top: -60, bottom: -10 });
                programmaticItemAnchor.setRect({ top: 120, bottom: 220 });
                programmaticMessageAnchor.setRect({ top: 140, bottom: 190 });
                await triggerFlashListChatListScroll(
                    300,
                    {
                        contentSize: { height: 1200 },
                        layoutMeasurement: { height: 600 },
                    },
                    { turns: 1 },
                );

                scrollEl.scrollHeight = 1400;
                originalItemAnchor.setRect({ top: 520, bottom: 620 });
                originalMessageAnchor.setRect({ top: 540, bottom: 590 });
                programmaticItemAnchor.setRect({ top: 120, bottom: 220 });
                programmaticMessageAnchor.setRect({ top: 140, bottom: 190 });
                resolveLoadOlder({ loaded: 5, hasMore: true, status: 'loaded' });
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

        let resolveLoadOlder = createMissingLoadOlderResolver();
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
                scrollEl.scrollTop = 100;
                itemAnchor.setRect({ top: 120, bottom: 220 });
                messageAnchor.setRect({ top: 140, bottom: 190 });
                scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
                await scrollFlashListTo(100, { turns: 2 });

                scrollEl.scrollHeight = 1800;
                itemAnchor.setRect({ top: 520, bottom: 620 });
                messageAnchor.setRect({ top: 540, bottom: 590 });
                resolveLoadOlder({ loaded: 5, hasMore: true, status: 'loaded' });
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

        let resolveLoadOlder = createMissingLoadOlderResolver();
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
                resolveLoadOlder({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(scrollEl.scrollTop).toBe(4100);

                visibleAnchor.setRect({ top: 300, bottom: 400 });
                scrollEl.scrollHeight = 5300;
                scrollEl.setQuerySelectorAll('[data-testid]', [visibleAnchor]);
                await primeFlashListMetrics(600, 5300);

                expect(scrollEl.scrollTop).toBe(4280);
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        location: { hostname: 'happier-test.localhost' },
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
            scrollToIndex: vi.fn(() => {
                scrollEl.scrollTop = 3900;
                itemAnchor.setRect({ top: 140, bottom: 440 });
                messageAnchor.setRect({ top: 220, bottom: 280 });
                scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
            }),
        };

        let resolveLoadOlder = createMissingLoadOlderResolver();
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
                resolveLoadOlder({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
                    index: 0,
                    animated: false,
                    viewPosition: 0,
                });
                expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    writer: 'web-scroll-to-index',
                    reason: 'prepend-restore',
                    mode: 'restore-anchor',
                    targetOffsetY: 0,
                }));
                expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                    type: 'scroll-write',
                    writer: 'web-scroll-to-index',
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                }));
                expect(scrollEl.scrollTop).toBe(4000);
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        location: { hostname: 'happier-test.localhost' },
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
            scrollToIndex: vi.fn(() => {
                scrollEl.scrollTop = 3900;
                stableMessageAnchor.setRect({ top: 150, bottom: 210 });
                scrollEl.setQuerySelectorAll('[data-testid]', [stableMessageAnchor]);
            }),
        };

        let resolveLoadOlder = createMissingLoadOlderResolver();
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
                resolveLoadOlder({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
                    index: 0,
                    animated: false,
                    viewPosition: 0,
                });
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
                scrollToIndex: vi.fn(() => {
                    scrollToIndexCalls += 1;
                    scrollEl.scrollTop = 4100;
                    if (scrollToIndexCalls < 2) {
                        scrollEl.setQuerySelectorAll('[data-testid]', []);
                        return;
                    }
                    itemAnchor.setRect({ top: 300, bottom: 600 });
                    messageAnchor.setRect({ top: 360, bottom: 420 });
                    scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
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

                    expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledTimes(2);
                    expect(scrollEl.scrollTop).toBe(4340);
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

    it('uses native bottom-maintenance settings after mount settle without a mid-settle threshold flip', async () => {
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

            expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.autoscrollToBottomThreshold).toBeUndefined();

            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

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
                offset: 180,
                animated: false,
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

    it('partitions native FlashList row measurement pools by coarse transcript shape', async () => {
        runtimeMockState.platformOs = 'ios';
        (syncTuningState as any).transcriptFlashListDrawDistance = 1800;
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'short prompt' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'x'.repeat(700), isThinking: false },
            ],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        const props = screen.getCapturedFlashListProps();

        expect(props.drawDistance).toBe(1800);
        expect(props.estimatedItemSize).toBeUndefined();
        expect(props.overrideItemLayout).toBeUndefined();
        expect(props.initialScrollIndexParams).toBeUndefined();
        expect(props.getItemType?.(props.data[0], 0)).toBe('message:user-short');
        expect(props.getItemType?.(props.data[1], 1)).toBe('message:agent-long');
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
                offset: 700,
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
                offset: 700,
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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
            expect(syncPerformanceTelemetry.snapshot().events.some(
                (event) => event.name === 'ui.sessions.transcript.firstPaint',
            )).toBe(false);

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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 9668,
                animated: false,
            });
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
                advanceTimersMs: Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) + 1,
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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });
            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
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
                advanceTimersMs: Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) + 1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 1947, animated: false });
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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 259,
                animated: false,
            });
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
            let setJumpToSeq: React.Dispatch<React.SetStateAction<number | null>> | null = null;
            const ChatListJumpHarness = () => {
                const [jumpToSeq, updateJumpToSeq] = React.useState<number | null>(null);
                setJumpToSeq = updateJumpToSeq;
                return <ChatList session={{ ...sessionState }} jumpToSeq={jumpToSeq} />;
            };
            const screen = await renderTrackedFlashListChatList(<ChatListJumpHarness />);

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
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });
            scrollToOffset.mockClear();

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

            await act(async () => {
                expect(setJumpToSeq).not.toBeNull();
                setJumpToSeq?.(1);
            });
            await screen.settle({
                advanceTimersMs: 201,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('does not flush a pending native bottom pin at the mount-settle deadline after user drag intent', async () => {
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
            scrollToOffset.mockClear();

            await act(async () => {
                screen.getCapturedFlashListProps().onScrollBeginDrag?.();
                screen.getCapturedFlashListProps().onContentSizeChange?.(400, 1210);
            });

            await screen.settle({
                advanceTimersMs:
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
                    1,
                cycles: 1,
                turns: 2,
            });

            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('keeps native first-paint placeholder on cold remounts when row-shell measurements are warm', async () => {
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
            <ChatList
                session={{ ...sessionState }}
                isWarmKeepAliveInstance
            />,
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

    it('releases the web Markdown runtime placeholder after the list has painted', async () => {
        runtimeMockState.platformOs = 'web';
        markdownRuntimeMockState.ready = false;
        const preloadPromise = new Promise<void>(() => {});
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
        await screen.settle({ turns: 2 });

        expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
    });

    it('releases the web Markdown runtime placeholder from DOM paint metrics when FlashList onLoad is silent', async () => {
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

                    expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(0);
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

    it('uses mount-settle correction without issuing later materialization pins', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            await mockNoOlderMessages();
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

            await primeFlashListMetrics(600, 1200, { turns: 2 });

            expect(scrollToOffset).not.toHaveBeenCalled();

            await settleNativeFlashListMount(screen);

            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 600,
                animated: false,
            });
            const settledAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(settledAutoFollowReasons).not.toContain('initial-open');
            scrollToOffset.mockClear();

            viewportControllerMockState.resolveInputs = [];
            await primeFlashListMetrics(600, 1800, { advanceTimersMs: 1, turns: 4 });

            const contentGrowthAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(contentGrowthAutoFollowReasons).not.toEqual(expect.arrayContaining([
                'content-size-change',
                'initial-open',
                'layout-change',
                'passive-drift',
            ]));
            expect(scrollToOffset).not.toHaveBeenCalled();
        });
    });

    it('rearms native follow-bottom after a no-op drag ends at the bottom before streaming growth', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                getAbsoluteLastScrollOffset: vi.fn(() => 600),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
                getCapturedFlashListProps().onScrollEndDrag?.({});
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
            expect(streamedGrowthAutoFollowReasons).toContain('stream-append');
        });
    });

    it('does not treat native pin callback churn as new transcript activity', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            await mockNoOlderMessages();
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
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

            await primeFlashListMetrics(600, 1200, { turns: 2 });
            await settleNativeFlashListMount(screen);

            viewportControllerMockState.resolveInputs = [];
            scrollToOffset.mockClear();
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportTelemetryMaxEvents: 64,
            };
            await screen.update(<ChatList session={{ ...sessionState }} bottomNotice={null} />);
            await screen.settle({ turns: 2 });

            const autoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => input.reason);
            expect(autoFollowReasons).not.toContain('initial-open');
            expect(scrollToOffset).not.toHaveBeenCalled();
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
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming...' },
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
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming... plus more streamed content' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState, seq: 2 }} />);
            await screen.settle({ turns: 2 });
            await primeFlashListMetrics(600, 1500, { advanceTimersMs: 1, turns: 1 });

            const streamedGrowthAutoFollowReasons = viewportControllerMockState.resolveInputs
                .filter((input) => input.type === 'auto-follow')
                .map((input) => (input as { reason?: unknown }).reason);
            expect(streamedGrowthAutoFollowReasons).toContain('stream-append');
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(getCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
                startRenderingFromBottom: true,
                animateAutoScrollToBottom: false,
            });
        });
    });

    it('issues at most one stream-append follow command per content version while pinned (invariant F)', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionState = { ...sessionState, active: true };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming...' },
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
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'token' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState, seq: 2 }} />);
            await screen.settle({ turns: 2 });
            await primeFlashListMetrics(600, 1500, { advanceTimersMs: 1, turns: 1 });

            const streamAppendCommands = () => viewportControllerMockState.resolveInputs
                .filter((input: any) => input.type === 'auto-follow' && input.reason === 'stream-append');
            expect(streamAppendCommands()).toHaveLength(1);
            expect(scrollToOffset).not.toHaveBeenCalled();

            // A second activity update WITHOUT a remeasure must not re-issue a
            // follow command for the same measured content version.
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...sessionMessagesState.messages,
                    { kind: 'agent-text', id: 'a3', localId: null, createdAt: 4, text: 'token2' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState, seq: 3 }} />);
            await screen.settle({ turns: 2 });
            expect(streamAppendCommands()).toHaveLength(1);

            // The next measured growth is a new content version: exactly one more command.
            await primeFlashListMetrics(600, 1700, { advanceTimersMs: 1, turns: 1 });
            expect(streamAppendCommands()).toHaveLength(2);
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
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming...' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(600, 1200, { turns: 1 });
            await settleNativeFlashListMount(screen);

            // Release follow-bottom with a trusted drag away from the tail.
            await act(async () => {
                getCapturedFlashListProps().onScrollBeginDrag?.({});
            });
            await scrollFlashListTo(100, { trusted: true, turns: 1 });
            scrollToOffset.mockClear();
            viewportControllerMockState.resolveInputs = [];

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    ...sessionMessagesState.messages,
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'token' },
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
            const unpinnedMvcp = getCapturedFlashListProps().maintainVisibleContentPosition;
            expect(unpinnedMvcp).toMatchObject({ startRenderingFromBottom: true });
            expect(unpinnedMvcp).not.toHaveProperty('autoscrollToBottomThreshold');
            expect(unpinnedMvcp).not.toHaveProperty('disabled');
        });
    });

    it('records every native FlashList scroll observation for high-frequency viewport instrumentation', async () => {
        const telemetrySink = await enableNativeViewportTelemetry();
        runtimeMockState.platformOs = 'android';
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });
        telemetrySink.mockClear();

        await scrollFlashListTo(830, { trusted: false, turns: 1 });

        expect(telemetrySink.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'scroll-observed',
                reason: 'observed',
                platform: 'android',
                listImplementation: 'flash_v2',
                mode: 'follow-bottom',
                offsetY: 830,
                layoutHeight: 100,
                contentHeight: 1000,
                distanceFromBottom: 70,
            }),
        ]));
    });

    it('records FlashList layout and content measurements for viewport telemetry', async () => {
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
        runtimeMockState.platformOs = 'android';
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, seq: 1, text: 'stable reply' }],
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(telemetrySink.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'layout-measured',
                reason: 'layout-change',
                platform: 'android',
                listImplementation: 'flash_v2',
                layoutHeight: 100,
            }),
            expect.objectContaining({
                type: 'content-measured',
                reason: 'content-size-change',
                platform: 'android',
                listImplementation: 'flash_v2',
                layoutHeight: 100,
                contentHeight: 1000,
            }),
        ]));
    });

    it('keeps explicit native jump-to-bottom imperative through native bottom maintenance', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            await enableNativeViewportTelemetry();
            runtimeMockState.platformOs = 'ios';
            settingValues.transcriptScrollJumpToBottomEnabled = true;
            settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
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
            await primeFlashListMetrics(100, 1000, { turns: 2 });
            scrollToOffset.mockClear();

            await vi.advanceTimersByTimeAsync(501);
            await scrollFlashListTo(600, { trusted: true, turns: 1 });
            const jumpButton = screen.findByTestId('transcript-jump-to-bottom');
            await act(async () => {
                jumpButton?.props?.onPress?.();
            });

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 900, animated: true });
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

        await scrollFlashListTo(850, { trusted: true, turns: 1 });

        expect(onViewportChange).toHaveBeenLastCalledWith({
            isPinned: false,
            offsetY: 50,
            shouldRestoreViewport: true,
        });
    });

    it('preserves native restore intent during passive scroll updates after the user leaves the tail', async () => {
        runtimeMockState.platformOs = 'ios';
        const onViewportChange = vi.fn();
        const dateNowSpy = vi.spyOn(Date, 'now');
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        try {
            dateNowSpy.mockReturnValue(0);
            const { ChatList } = await import('./ChatList');
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 1 });
            await scrollFlashListTo(850, { trusted: true, turns: 1 });

            onViewportChange.mockClear();
            dateNowSpy.mockReturnValue(1000);
            await scrollFlashListTo(830, { trusted: false, turns: 1 });

            expect(onViewportChange).toHaveBeenLastCalledWith({
                isPinned: false,
                offsetY: 70,
                shouldRestoreViewport: true,
            });
        } finally {
            dateNowSpy.mockRestore();
        }
    });

    it('keeps the native jump button hidden after non-user scroll drift while bottom follow is armed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await triggerFlashListChatListLoad(12, { turns: 1 });
            await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
            flashListRefHandle.scrollToOffset.mockClear();
            await scrollFlashListTo(0, { trusted: false, turns: 1 });
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
            await screen.update(<ChatList session={{ ...sessionState, seq: 2 }} />);
            await screen.settle({ turns: 2 });

            expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
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
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                shouldRestoreViewport: true,
            }));
        });
    });

    it('does not repin recycled native drift before React observes mount settle as stable', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

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
        });
    });

    it('resets native mount settle metrics when the composer inset changes', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
            const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
            globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
            globalThis.cancelAnimationFrame = (() => undefined) as typeof globalThis.cancelAnimationFrame;
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
            };

            try {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                await primeFlashListMetrics(500, 1000, { turns: 4 });
                await triggerFlashListChatListLoad(12, { turns: 1 });
                await screen.settle({ advanceTimersMs: 60, cycles: 1, turns: 1 });
                flashListRefHandle.scrollToOffset.mockClear();

                const composerInset = screen.findByTestId('transcript-composer-keyboard-inset');
                if (!composerInset) {
                    throw new Error('Expected composer inset to render');
                }
                await act(async () => {
                    composerInset.props.onHeightChange?.(100);
                });
                await screen.settle({ advanceTimersMs: 70, cycles: 1, turns: 1 });
                flashListRefHandle.scrollToOffset.mockClear();

                await scrollFlashListTo(350, { trusted: false, turns: 1 });

                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            } finally {
                globalThis.requestAnimationFrame = previousRequestAnimationFrame;
                globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
            }
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

    it('restores during initial fill for an observed unpinned web entry without pinning it', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 480,
                lastUpdatedAt: 1,
                source: 'observed',
            });

            const scrollEl = createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
            });

            syncTuningState = {
                ...syncTuningState,
                transcriptWebInitialPinStabilizeMs: 0,
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
                    await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                    await primeFlashListMetrics(100, 1000, { turns: 2 });

                    expect(scrollEl.scrollTop).toBe(420);
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
                    scrollEl.scrollTop = 500;
                    // A genuine scrollbar-drag / keyboard scroll-up: RNW does not always mark the
                    // synthetic scroll event as trusted and there is no preceding pointer event.
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

                    // Scroll up without any new activity arriving.
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

    it('preserves the stored entry anchor when resetting unpinned session state', async () => {
        const onViewportChange = vi.fn();
        const entryAnchor = {
            kind: 'message' as const,
            messageId: 'm2',
            itemId: 'm2',
            itemOffsetPx: 40,
            capturedAtMs: 1,
        };
        sessionViewportByIdState.set('session-1', {
            isPinned: false,
            offsetY: 100,
            anchor: entryAnchor,
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
        await renderTrackedFlashListChatList(
            <ChatList session={{ ...sessionState }} onViewportChange={onViewportChange} />,
        );

        expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({
            isPinned: false,
            offsetY: 100,
            shouldRestoreViewport: true,
            anchor: entryAnchor,
        }));
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

    it('preserves the native viewport anchor captured before a surviving list changes session id', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptViewportAnchorCaptureDebounceMs: 200,
            };
            flashListRefHandle = {
                scrollToOffset: vi.fn(),
                scrollToIndex: vi.fn(),
                computeVisibleIndices: vi.fn(() => ({ startIndex: 0, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => 100),
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

            routeSession1ViewportChange.mockClear();
            await scrollFlashListTo(400, { trusted: true, turns: 1 });

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                anchor: null,
                source: 'observed',
            });

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'n1', localId: null, createdAt: 1, seq: 1, text: 'alpha' },
                    { kind: 'agent-text', id: 'n2', localId: null, createdAt: 2, seq: 2, text: 'beta' },
                ],
            };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-2' }} onViewportChange={routeSession2ViewportChange} />,
            );

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                anchor: expect.objectContaining({
                    messageId: 'm2',
                    itemId: 'm2',
                    itemOffsetPx: 40,
                }),
                source: 'observed',
            });
            expect(sessionViewportByIdState.get('session-1')?.anchor).not.toEqual(expect.objectContaining({
                messageId: 'n2',
            }));
        });
    });

    it('persists passive native movement after a restored unpinned viewport is applied', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
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
                offset: 700,
                animated: false,
            });

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

    it('ignores recycled native scroll offsets before the next session has measured its transcript', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
            let activeSessionId = 'session-1';
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore(activeSessionId, state);
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
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            onViewportChange.mockClear();
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
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ turns: 1 });
            onViewportChange.mockClear();

            await scrollFlashListTo(400, { trusted: false, turns: 1 });

            expect(sessionViewportByIdState.get('session-2')).toMatchObject({
                isPinned: false,
                offsetY: 200,
                source: 'observed',
            });
            expect(onViewportChange).not.toHaveBeenCalledWith(expect.objectContaining({
                offsetY: 500,
                shouldRestoreViewport: true,
            }));
        });
    });

    it('does not let passive native bottom drift erase a restored unpinned session viewport', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
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
                offset: 700,
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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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

            await triggerFlashListChatListStartReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 340,
                animated: false,
            });
            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                source: 'observed',
            });

            await screen.unmount();
        });
    });

    it('does not rearm native bottom-follow on drag end when no scroll observation arrived before older-page materialization', async () => {
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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
            });

            await triggerFlashListChatListStartReached({ turns: 2 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                getCapturedFlashListProps().onScrollEndDrag?.({});
            });
            expect(getCapturedFlashListProps().maintainVisibleContentPosition).not.toHaveProperty(
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

            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 340,
                animated: false,
            });
            expect(viewportControllerMockState.resolveInputs).not.toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: 'auto-follow',
                }),
            ]));

            await screen.unmount();
        });
    });

    it('does not install a prepend restore while materializing a missing entry anchor', async () => {
        const syncMod = await import('@/sync/sync');
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
                getAbsoluteLastScrollOffset: vi.fn(() => 100),
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
            viewportControllerMockState.resolveInputs = [];

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(scrollToIndex).toHaveBeenCalledWith({
                index: 0,
                animated: false,
                viewOffset: -40,
            });
            expect(viewportControllerMockState.resolveInputs).not.toContainEqual(expect.objectContaining({
                type: 'restore-anchor',
                reason: 'prepend-restore',
            }));

            await screen.unmount();
        });
    });

    it('keeps cold-open writes flowing under the entry phase and closes it once applied (plan B1)', async () => {
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
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'streaming...' },
                ],
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
            await primeFlashListMetrics(600, 1200, { turns: 4 });

            await settleNativeFlashListMount(screen);

            // Cold-open initial/settle pins flow under the entry phase: at least one
            // committed write, zero owner conflicts.
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
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
                    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'token' },
                ],
            };
            await screen.update(<ChatList session={{ ...sessionState, seq: 2 }} />);
            await screen.settle({ turns: 2 });
            await primeFlashListMetrics(600, 1500, { advanceTimersMs: 1, turns: 1 });

            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                reason: 'stream-append',
            }));
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write-rejected',
            }));
        });
    });

    it('suspends older pagination and never opens a prepend transaction while the entry restore phase is open (plan F4/F5)', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
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

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => 100),
                getLayout: vi.fn((index: number) => ({ x: 0, y: 20 + index * 120, width: 320, height: 100 })),
            };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 300,
                anchor: {
                    kind: 'message',
                    messageId: 'm4',
                    itemId: 'm4',
                    itemOffsetPx: 40,
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

            // Entry anchor restore issued and still pending confirmation -> entry phase open.
            expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                index: 1,
                viewOffset: -40,
            }));
            scrollToIndex.mockClear();
            scrollToOffset.mockClear();
            telemetrySink.mockClear();

            // While the entry phase is open the pagination machine is suspended, so no
            // older page can load and no prepend transaction can open (plan F4/F5: the
            // owner conflict is prevented before the seam, not just rejected at it).
            await triggerFlashListChatListStartReached({ turns: 2 });
            await screen.settle({ cycles: 2, turns: 4 });

            expect(loadOlderMessagesMock).not.toHaveBeenCalled();
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                reason: 'prepend-restore',
            }));

            // A conclusive aligned observation confirms the entry restore and closes the
            // phase; the very same suspension then lifts and the next threshold
            // observation loads an older page.
            await triggerFlashListChatListScroll(
                100,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );
            await triggerFlashListChatListScroll(
                100,
                {
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 100 },
                },
                { turns: 1 },
            );
            await screen.settle({ cycles: 2, turns: 4 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            await screen.unmount();
        });
    });
    it('closes the prepend transaction after its single fallback write with no further writes on passive frames', async () => {
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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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
            scrollToIndex.mockClear();

            await triggerFlashListChatListStartReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 340,
                animated: false,
            });

            onViewportChange.mockClear();
            scrollToOffset.mockClear();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(501);
            });
            await triggerFlashListChatListScroll(
                0,
                {
                    contentSize: { height: 2200 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: false,
                },
                { turns: 1 },
            );

            // Invariant D: outcome fallback-restored = exactly ONE write; passive
            // post-restore frames never trigger further prepend writes.
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(scrollToIndex).not.toHaveBeenCalled();

            await screen.unmount();
        });
    });

    it('never spends a second corrective write after the prepend transaction closes (invariant D)', async () => {
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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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

            // The trusted scroll back up to offset 100 reads distance 800; with the
            // recycled-jump suppression deleted (plan B2c) the store keeps the real
            // last observed distance instead of the stale pre-scroll value.
            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 800,
                source: 'observed',
            });

            await triggerFlashListChatListStartReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 340,
                animated: false,
            });
            // The single fallback write is telemetered against the prepend owner…
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                reason: 'prepend-restore',
                targetOffsetY: 340,
            }));

            onViewportChange.mockClear();
            telemetrySink.mockClear();
            scrollToOffset.mockClear();
            visibleRange = { startIndex: 3, endIndex: 3 };
            nativeScrollOffset = 300;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(501);
            });
            await triggerFlashListChatListScroll(
                nativeScrollOffset,
                {
                    contentSize: { height: 2200 },
                    layoutMeasurement: { height: 100 },
                    isTrusted: false,
                },
                { turns: 1 },
            );

            // …and a later misaligned passive frame never spends another write (the
            // 4-attempt correction loop is deleted; outcome is exactly one write).
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(telemetrySink).not.toHaveBeenCalledWith(expect.objectContaining({
                type: 'scroll-write',
                reason: 'prepend-restore',
            }));

            await screen.unmount();
        });
    });

    it('issues at most one prepend fallback write even when content re-measures without a follow-up scroll event', async () => {
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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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

            await triggerFlashListChatListStartReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 340,
                animated: false,
            });

            scrollToOffset.mockClear();
            visibleRange = { startIndex: 3, endIndex: 3 };
            nativeScrollOffset = 300;

            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            // Invariant D: the transaction already closed fallback-restored — a re-measure
            // without a follow-up scroll event never produces a second write.
            expect(scrollToOffset).not.toHaveBeenCalled();

            await screen.unmount();
        });
    });

    it('holds the prepend fallback through the layout-quiet window and closes mvcp-preserved when the correction lands (plan P1)', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };
            syncTuningState = {
                ...syncTuningState,
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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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

            await triggerFlashListChatListStartReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });

            // First post-commit observation is conclusively misaligned (the anchor row moved
            // down by the prepended height while the scroll offset is still stale) — but
            // FlashList's own MVCP correction is still in flight, so the fallback must WAIT.
            // (No `frames` here: advancing to the next timer would fast-forward the quiet
            // window before the simulated correction lands.)
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3 });
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(scrollToIndex).not.toHaveBeenCalled();

            // FlashList's async correction lands between observations: the anchor row is back
            // at its captured viewport offset before the quiet window elapses.
            nativeScrollOffset = 340;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(150);
            });

            // mvcp-preserved: ZERO writes, the transaction closes with the preserved outcome.
            expect(scrollToOffset).not.toHaveBeenCalled();
            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
                type: 'restore-decision',
                reason: 'mvcp-preserved',
            }));
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
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            let visibleRange = { startIndex: 1, endIndex: 1 };
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => visibleRange),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 240,
            };

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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

            await triggerFlashListChatListStartReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 340,
                animated: false,
            });

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

    it('lets a trusted native scroll supersede the closed prepend transaction immediately (LC-R #5)', async () => {
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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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

            await triggerFlashListChatListStartReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} onViewportChange={onViewportChange} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 340,
                animated: false,
            });

            onViewportChange.mockClear();
            telemetrySink.mockClear();
            await act(async () => {
                getCapturedFlashListProps().onScrollBeginDrag?.({});
            });

            visibleIndex = 3;
            nativeScrollOffset = 1970;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(501);
            });
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
                    isTrusted: false,
                },
                { turns: 1 },
            );

            // The transaction closed at its single fallback write; the user's later
            // movement owns the viewport — observations flow normally (no 'pending'
            // holds, no protected-restore retarget machinery).
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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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

            await triggerFlashListChatListStartReached({ turns: 2 });
            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

            resolveLoadOlder({ loaded: 2, hasMore: true, status: 'loaded' });
            await screen.settle({ turns: 3 });

            await act(async () => {
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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
            // writes — MVCP alone holds the position under the finger. The mid-flight
            // retarget heuristic is dead by design.
            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(scrollToOffset).not.toHaveBeenCalled();

            await screen.unmount();
        });
    });

    it('captures a native prepend anchor when older loading starts immediately after drag start', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            syncTuningState = {
                ...syncTuningState,
                transcriptBackwardPrefetchThresholdPx: 500,
            };
            const scrollToIndex = vi.fn();
            const scrollToOffset = vi.fn();
            let nativeScrollOffset = 100;
            const resolveLayoutY = (index: number) => 20 + index * 120;
            flashListRefHandle = {
                scrollToOffset,
                scrollToIndex,
                computeVisibleIndices: vi.fn(() => ({ startIndex: 1, endIndex: 1 })),
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );

            await primeFlashListMetrics(100, 1000, { turns: 4 });
            await act(async () => {
                getCapturedFlashListProps().onScrollBeginDrag?.({});
            });

            scrollToIndex.mockClear();
            nativeScrollOffset = 100;
            await triggerFlashListChatListStartReached({ turns: 2 });
            sessionState = { ...sessionState, seq: 5 };
            await screen.update(
                <ChatList session={{ ...sessionState, id: 'session-1' }} />,
            );
            await screen.settle({ cycles: 2, turns: 4 });
            await triggerFlashListChatListContentSizeChange(320, 2200, { turns: 3, frames: 1 });

            expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 340,
                animated: false,
            });

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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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

            await triggerFlashListChatListStartReached({ turns: 1 });
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

            expect(scrollToIndex).not.toHaveBeenCalled();
            expect(scrollToOffset).toHaveBeenCalledWith({
                offset: 340,
                animated: false,
            });

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
                getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffset),
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
                getCapturedFlashListProps().onScrollBeginDrag?.({});
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
            await triggerFlashListChatListStartReached({ turns: 1 });
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
                getAbsoluteLastScrollOffset: vi.fn(() => 700),
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
                offset: 700,
                animated: false,
            });

            await scrollFlashListTo(700, { trusted: false, turns: 1 });
            onViewportChange.mockClear();
            await vi.advanceTimersByTimeAsync(501);
            await scrollFlashListTo(600, { trusted: false, turns: 1 });
            await vi.advanceTimersByTimeAsync(Number(syncTuningState.transcriptViewportAnchorCaptureDebounceMs) + 1);

            expect(sessionViewportByIdState.get('session-1')).toMatchObject({
                isPinned: false,
                offsetY: 300,
                anchor: null,
                source: 'observed',
            });
            expect(flashListRefHandle.computeVisibleIndices).not.toHaveBeenCalled();
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
        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 800, animated: false });
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
        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 1000, animated: false });
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
                offset: 1055,
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
                offset: 34412,
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
                offset: 35476,
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
                offset: 20676,
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
                offset: 20676,
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
                getAbsoluteLastScrollOffset: vi.fn(() => 400),
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

    it('releases native paint after the mount-settle budget when an unpinned entry restore is not observed', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'android';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionViewportByIdState.set('session-1', {
                isPinned: false,
                offsetY: 355,
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
                offset: 20676,
                animated: false,
            });
            expect(countExactTestId(screen, 'transcript-first-paint-placeholder')).toBe(1);

            await screen.settle({
                advanceTimersMs:
                    Number(syncTuningState.transcriptInitialFillBudgetMs) +
                    Number(syncTuningState.transcriptMountSettleQuiescentWindowMs) * 2 +
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
                offset: 1190,
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
                offset: 2068,
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
                offset: 23190,
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
                offset: 1932,
                animated: false,
            });
            expect(scrollToOffset).toHaveBeenCalledTimes(1);
        });
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

        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
            index: 1,
            animated: false,
            viewOffset: -24,
        }));
        expect(viewportControllerMockState.resolveInputs).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'first-paint',
                sessionId: 'session-1',
                shouldFollowBottom: false,
            }),
        ]));
        expect(telemetrySink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-write',
            writer: 'native-scroll-to-index',
            reason: 'entry-restore',
            mode: 'restore-anchor',
            targetOffsetY: 1,
            nativeMountSettleStable: expect.any(Boolean),
        }));

        flashListRefHandle.scrollToIndex.mockClear();
        flashListRefHandle.scrollToOffset.mockClear();
        await act(async () => {
            getCapturedFlashListProps().onScrollToIndexFailed?.({
                averageItemLength: 100,
                index: 1,
            });
        });
        expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
        // An index failure no longer schedules retries, and content growth never re-issues the
        // entry write (E1 deleted): the transaction confirms via a conclusive observation or
        // closes at its deadline.
        await triggerFlashListChatListContentSizeChange(400, 1200, { turns: 2 });

        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalled();
        expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
    });

    it('materializes an exact native entry anchor before falling back to a nearest loaded row', async () => {
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
                itemOffsetPx: 24,
                capturedAtMs: 1,
            },
            lastUpdatedAt: 1,
            source: 'observed',
        });

        let resolveLoadOlder = createMissingLoadOlderResolver();
        const loadOlderPromise = new Promise<LoadedOlderResult>((resolve) => {
            resolveLoadOlder = (value) => {
                sessionTranscriptIdsState = ['m1', 'm2', 'm3'];
                resolve(value);
            };
        });
        loadOlderMessagesMock.mockImplementation(() => loadOlderPromise);

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalled();

        await act(async () => {
            resolveLoadOlder({ loaded: 1, hasMore: false, status: 'loaded' });
            await Promise.resolve();
            await Promise.resolve();
            screen.tree.update(<ChatList session={{ ...sessionState }} followBottomIntentKey="materialized-anchor" />);
        });
        await screen.settle({ turns: 4 });

        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
            index: 1,
            animated: false,
            viewOffset: -24,
        });
        expect(flashListRefHandle.scrollToIndex).not.toHaveBeenCalledWith(expect.objectContaining({
            index: 0,
            viewOffset: -24,
        }));
    });

    it('restores A from its own unpinned native viewport after switching through many sessions', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            const scrollToOffset = vi.fn();
            flashListRefHandle = { scrollToOffset, scrollToIndex: vi.fn() };
            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'm1', localId: null, createdAt: 1, seq: 1, text: 'one' },
                    { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, seq: 2, text: 'two' },
                ],
            };
            sessionViewportByIdState.set('session-a', {
                isPinned: false,
                offsetY: 200,
                anchor: null,
                lastUpdatedAt: 1,
                source: 'observed',
            });
            sessionViewportByIdState.set('session-b', {
                isPinned: false,
                offsetY: 75,
                anchor: null,
                lastUpdatedAt: 2,
                source: 'observed',
            });
            sessionViewportByIdState.set('session-c', {
                isPinned: false,
                offsetY: 500,
                anchor: null,
                lastUpdatedAt: 3,
                source: 'observed',
            });
            sessionViewportByIdState.set('session-d', {
                isPinned: false,
                offsetY: 25,
                anchor: null,
                lastUpdatedAt: 4,
                source: 'observed',
            });

            const { ChatList } = await import('./ChatList');
            const screen = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: 'session-a' }} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 2 });
            expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 700, animated: false });

            for (const [sessionId, expectedOffset] of [
                ['session-b', 825],
                ['session-c', 400],
                ['session-d', 875],
            ] as const) {
                scrollToOffset.mockClear();
                await screen.update(<ChatList session={{ ...sessionState, id: sessionId }} />);
                await primeFlashListMetrics(100, 1000, { turns: 2 });
                expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: expectedOffset, animated: false });
            }

            scrollToOffset.mockClear();
            await screen.update(<ChatList session={{ ...sessionState, id: 'session-a' }} />);
            await primeFlashListMetrics(100, 1000, { turns: 2 });

            expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 700, animated: false });
            expect(scrollToOffset).not.toHaveBeenCalledWith({ offset: 825, animated: false });
            expect(scrollToOffset).not.toHaveBeenCalledWith({ offset: 400, animated: false });
            expect(scrollToOffset).not.toHaveBeenCalledWith({ offset: 875, animated: false });
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
                getAbsoluteLastScrollOffset: vi.fn(() => 400),
                getLayout: vi.fn((index: number) => ({
                    x: 0,
                    y: index === 1 ? 460 : 620,
                    width: 320,
                    height: 120,
                })),
            };
            let activeSessionId = 'session-a';
            const onViewportChange = vi.fn((state: any) => {
                routeSessionViewportChangeIntoTestStore(activeSessionId, state);
            });
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
            const firstA = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 4 });
            onViewportChange.mockClear();

            await scrollFlashListTo(400, { trusted: true, turns: 1 });
            unmountTrackedFlashListChatList(firstA);

            expect(sessionViewportByIdState.get('session-a')).toMatchObject({
                isPinned: false,
                anchor: expect.objectContaining({
                    messageId: 'session-a-m2',
                    itemId: 'session-a-m2',
                    itemOffsetPx: 60,
                }),
                source: 'observed',
            });

            activeSessionId = 'session-b';
            sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId) };
            const sessionB = await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(100, 1000, { turns: 2 });
            unmountTrackedFlashListChatList(sessionB);

            scrollToOffset.mockClear();
            scrollToIndex.mockClear();
            activeSessionId = 'session-a';
            sessionMessagesState = { isLoaded: true, messages: messagesForSession(activeSessionId, true) };
            await renderTrackedFlashListChatList(
                <ChatList session={{ ...sessionState, id: activeSessionId }} onViewportChange={onViewportChange} />,
            );
            await primeFlashListMetrics(100, 1200, { turns: 4 });

            expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                index: 1,
                animated: false,
                viewOffset: -60,
            }));
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

    it('lets jumpToSeq take priority over a stored viewport anchor', async () => {
        runtimeMockState.platformOs = 'ios';
        syncTuningState = {
            ...syncTuningState,
        };
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
        jumpToTranscriptSeqMockState.implementation = async (params) => {
            params.scrollToIndex(1);
        };

        const { ChatList } = await import('./ChatList');
        await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} jumpToSeq={2} />);
        await primeFlashListMetrics(100, 1000, { turns: 2 });

        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
            index: 1,
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
        expect(releaseJump).not.toBeNull();

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

    it('defers automatic native follow-bottom pins until mount settle is stable', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            runtimeMockState.platformOs = 'ios';
            await mockNoOlderMessages();
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

            expect(scrollToOffset).toHaveBeenCalledWith({ offset: 900, animated: false });
        });
    });

    it('issues a data-resolvable web anchor restore through the seam when the anchor row is not in the DOM', async () => {
        // The legacy render-retry + distance-fallback scaffolding is deleted (plan A5): an
        // anchor that resolves in DATA restores via the seam scroll-to-index exactly once and
        // then confirms or closes at the entry deadline - it never falls back to a distance
        // write that would fight the anchor target.
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
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

                    expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({
                        index: 1,
                        animated: false,
                        viewOffset: -40,
                    }));
                    expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledTimes(1);
                    // No distance fallback write competes with the anchor restore.
                    expect(scroller.scrollTop).toBe(0);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

                    // The anchor row never mounts in the DOM: the deadline closes the
                    // transaction without further writes.
                    await screen.settle({
                        advanceTimersMs: Number(syncTuningState.transcriptInitialFillBudgetMs) + 1,
                        cycles: 1,
                        turns: 2,
                    });
                    expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledTimes(1);
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
                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                    scroller.scrollTop = 550;
                    getCapturedFlashListProps().onWheel?.({ deltaY: -80, stopPropagation: vi.fn() });
                    resolveLoadOlder?.({ loaded: 0, hasMore: false, status: 'no_more' });
                    await screen.settle({ turns: 4 });

                    expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
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

    it('keeps the web hot tail pinned when a pending queue row materializes into the transcript', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
            transcriptWebHotTailItemCount: 2,
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
            messages: [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'ready' }],
        };
        sessionPendingState = {
            messages: [{ id: 'pending-1', localId: 'local-user-1', createdAt: 2, text: 'queued message' }],
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

                sessionMessagesState = {
                    isLoaded: true,
                    messages: [
                        { kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'ready' },
                        { kind: 'user-text', id: 'u1', localId: 'local-user-1', createdAt: 2, text: 'queued message' },
                    ],
                };
                sessionPendingState = { messages: [] };
                await screen.update(<ChatList session={{ ...sessionState }} />);

                scrollEl.scrollHeight = 1400;
                const hotTail = screen.findByTestId('transcript-web-hot-tail');
                if (!hotTail) throw new Error('Expected the web hot tail to stay mounted');
                await act(async () => {
                    hotTail.props.onLayout?.({
                        nativeEvent: { layout: { height: 120, width: 400 } },
                    });
                });
                await screen.settle({ cycles: 1, turns: 1 });

                expect(scrollEl.scrollTop).toBe(1300);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('preserves visual bottom distance when followed web content grows near the bottom', async () => {
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

                expect(scrollEl.scrollTop).toBe(1292);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('rearms web bottom follow when the user scrolls back near the streaming tail', async () => {
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

                    expect(scrollEl.scrollTop).toBe(1250);
                    expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
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
});
