import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';

import { flushHookEffects, type FlushHookEffectsOptions } from '../hooks/flushHookEffects';
import { createCapturingLegendListMock, type LegendListMockState } from '../mocks/legendList';
import { createReactNativeWebMock } from '../mocks/reactNative';
import { createLiveStorageStoreMock, createStorageModuleMock, createStorageStoreModuleMock } from '../mocks/storage';
import { renderScreen, type RenderScreenResult } from '../render/renderScreen';
import type { RenderWithAppProvidersOptions } from '../render/renderWithAppProviders';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createReducer } from '@/sync/reducer/reducer';
import { createInactiveSessionMessagesWindowState } from '@/sync/runtime/sessionMessagesWindowState';
import { loadSyncTuning, type SyncTuning } from '@/sync/runtime/syncTuning';

export type ChatListHarness = RenderScreenResult & Readonly<{
    findMessageRow: (testID: string) => ReactTestInstance | null;
    listMessageRows: (prefix?: string) => ReactTestInstance[];
    settle: (options?: FlushHookEffectsOptions) => Promise<void>;
}>;

type SessionMessagesState = {
    messages: any[];
    isLoaded: boolean;
};

type SessionPendingState = {
    messages: any[];
    discarded: any[];
    isLoaded: boolean;
};

type SyncTuningState = SyncTuning;

type ChatListHarnessState = {
    legendListProps: any | null;
    legendListRefHandle: unknown;
    /** Stateful Legend geometry feed consumed by the capturing Legend mock's getState(). */
    legendListState: Partial<LegendListMockState> | null;
    platformOs: 'web' | 'ios';
    /** Session screen navigation focus fed to the shared useSessionScreenIsFocused mock. */
    sessionScreenIsFocused: boolean;
    sessionMessagesState: SessionMessagesState;
    sessionPendingState: SessionPendingState;
    sessionActionDraftsState: any[];
    /** Feeds state.sessionCatchUpNewerInFlight for the harness session (catch-up overlay tests). */
    sessionCatchingUpNewer: boolean;
    sessionState: any;
    settingValues: Record<string, any>;
    syncTuningState: SyncTuningState;
    activeServerAccountScope: ServerAccountScope | null;
};

type ChatListHarnessDomInstallerOptions = {
    document?: Record<string, unknown>;
    HTMLElement?: unknown;
    window?: Record<string, unknown>;
    useImmediateAnimationFrame?: boolean;
};

export class ChatListHarnessWebElement {
    public scrollTop = 0;
    public scrollHeight = 0;
    public clientHeight = 0;
    public scrollWidth = 0;
    public clientWidth = 0;
    public isConnected = true;
    public parentElement: ChatListHarnessWebElement | null = null;

    private rect: { top: number; bottom: number };
    private readonly nodesBySelector = new Map<string, ChatListHarnessWebElement[]>();

    constructor(
        private readonly testId: string | null,
        rect: { top: number; bottom: number },
    ) {
        this.rect = rect;
    }

    getAttribute(name: string) {
        return name === 'data-testid' ? this.testId : null;
    }

    getBoundingClientRect() {
        return {
            top: this.rect.top,
            bottom: this.rect.bottom,
            left: 0,
            right: 0,
            width: 0,
            height: this.rect.bottom - this.rect.top,
            x: 0,
            y: this.rect.top,
            toJSON: () => ({}),
        };
    }

    querySelectorAll(selector: string) {
        return this.nodesBySelector.get(selector) ?? [];
    }

    querySelector(selector: string) {
        const testId = parseDataTestIdAttributeSelector(selector);
        if (testId == null) return this.nodesBySelector.get(selector)?.[0] ?? null;
        return this.nodesBySelector.get('[data-testid]')?.find((node) => node.getAttribute('data-testid') === testId) ?? null;
    }

    setQuerySelectorAll(selector: string, nodes: ChatListHarnessWebElement[]) {
        this.nodesBySelector.set(selector, nodes);
    }

    contains(node: unknown) {
        return node === this;
    }

    setRect(rect: { top: number; bottom: number }) {
        this.rect = rect;
    }
}
function parseDataTestIdAttributeSelector(selector: string): string | null {
    const match = selector.match(/^\[data-testid="((?:\\.|[^"\\])*)"\]$/);
    if (!match) return null;
    return match[1]
        .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_value, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\(.)/g, '$1');
}

export function createChatListHarnessWebElement(
    testId: string | null,
    rect: { top: number; bottom: number },
) {
    return new ChatListHarnessWebElement(testId, rect);
}

export type ChatListHarnessWebScroller = ChatListHarnessWebElement & {
    scrollTop: number;
};

export function createChatListHarnessWebScroller(
    options: Readonly<{
        clientHeight?: number;
        clientWidth?: number;
        rect?: { top: number; bottom: number };
        scrollHeight?: number;
        scrollTop?: number;
        scrollWidth?: number;
        testId?: string | null;
        testNodes?: ChatListHarnessWebElement[];
    }> = {},
): ChatListHarnessWebScroller {
    const scroller = createChatListHarnessWebElement(
        options.testId ?? null,
        options.rect ?? { top: 0, bottom: options.clientHeight ?? 0 },
    ) as ChatListHarnessWebScroller;

    scroller.scrollHeight = options.scrollHeight ?? 0;
    scroller.clientHeight = options.clientHeight ?? 0;
    scroller.scrollWidth = options.scrollWidth ?? 0;
    scroller.clientWidth = options.clientWidth ?? 0;

    let scrollTopValue = 0;
    Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        enumerable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
            const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            scrollTopValue = Math.max(0, Math.min(value, maxScrollTop));
        },
    });
    scroller.scrollTop = options.scrollTop ?? 0;
    scroller.setQuerySelectorAll('[data-testid]', options.testNodes ?? []);

    return scroller;
}

const sessionScreenFocusListeners = new Set<() => void>();

/** Flips the harness session-screen focus and notifies mounted useSessionScreenIsFocused consumers. */
export function setChatListHarnessSessionScreenFocused(focused: boolean): void {
    chatListHarnessState.sessionScreenIsFocused = focused;
    for (const listener of [...sessionScreenFocusListeners]) listener();
}

export function subscribeChatListHarnessSessionScreenFocus(listener: () => void): () => void {
    sessionScreenFocusListeners.add(listener);
    return () => sessionScreenFocusListeners.delete(listener);
}

export const chatListHarnessState: ChatListHarnessState = {
    legendListProps: null,
    legendListRefHandle: null,
    legendListState: null,
    platformOs: 'web',
    sessionScreenIsFocused: true,
    sessionMessagesState: { messages: [], isLoaded: true },
    sessionPendingState: { messages: [], discarded: [], isLoaded: true },
    sessionActionDraftsState: [],
    sessionCatchingUpNewer: false,
    sessionState: null,
    settingValues: {},
    syncTuningState: loadSyncTuning(),
    activeServerAccountScope: null,
};

function createChatListHarnessMessagesSnapshot() {
    const sessionId = String(chatListHarnessState.sessionState?.id ?? 'session-1');
    const messagesById = Object.fromEntries(
        (chatListHarnessState.sessionMessagesState.messages ?? []).map((message: any) => [message.id, message]),
    );

    return {
        profileScope: chatListHarnessState.activeServerAccountScope,
        sessionCatchUpNewerInFlight: chatListHarnessState.sessionCatchingUpNewer ? { [sessionId]: 1 } : {},
        sessionMessages: {
            [sessionId]: {
                messageIdsOldestFirst: Object.keys(messagesById),
                messagesById,
                messagesMap: messagesById,
                reducerState: createReducer(),
                reducerVersion: 0,
                latestThinkingMessageId: null,
                latestThinkingMessageActivityAtMs: null,
                latestReadyEventSeq: null,
                latestReadyEventAt: null,
                messagesVersion: 0,
                lastAppliedAgentStateVersion: null,
                isLoaded: chatListHarnessState.sessionMessagesState.isLoaded,
            },
        },
    };
}

export function resetChatListHarness(
    options: Readonly<{
        platformOs?: 'web' | 'ios';
        syncTuningState?: Partial<SyncTuningState>;
    }> = {},
) {
    chatListHarnessState.legendListProps = null;
    chatListHarnessState.legendListRefHandle = null;
    chatListHarnessState.legendListState = null;
    chatListHarnessState.platformOs = options.platformOs ?? 'web';
    chatListHarnessState.sessionScreenIsFocused = true;
    chatListHarnessState.sessionMessagesState = { messages: [], isLoaded: true };
    chatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
    chatListHarnessState.sessionActionDraftsState = [];
    chatListHarnessState.sessionCatchingUpNewer = false;
    chatListHarnessState.activeServerAccountScope = null;
    chatListHarnessState.sessionState = {
        id: 'session-1',
        seq: 0,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
        agentState: null,
    };
    chatListHarnessState.syncTuningState = {
        ...loadSyncTuning(),
        transcriptForwardPrefetchThresholdPx: 0,
        transcriptBackwardPrefetchThresholdPx: 0,
        transcriptEstimatedItemSizePx: 120,
        ...(options.syncTuningState ?? {}),
    };

    for (const key of Object.keys(chatListHarnessState.settingValues)) {
        delete chatListHarnessState.settingValues[key];
    }

    chatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
    chatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    chatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    chatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    chatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    chatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;
    chatListHarnessState.settingValues.transcriptMotionPreset = 'off';
    chatListHarnessState.settingValues.transcriptAnimateNewItemsEnabled = false;
    chatListHarnessState.settingValues.transcriptAnimateToolExpandCollapseEnabled = false;
    chatListHarnessState.settingValues.transcriptAnimateThinkingEnabled = false;
}

export function buildChatListHarnessItems({
    messageIdsOldestFirst,
    messagesById,
    pendingMessages,
    actionDrafts,
}: {
    actionDrafts?: any[];
    messageIdsOldestFirst?: string[];
    messagesById?: Record<string, any>;
    pendingMessages?: any[];
}) {
    const items: any[] = (messageIdsOldestFirst ?? []).flatMap((id) => {
        const message = messagesById?.[id];
        if (!message) {
            return [];
        }

        return [{
            kind: 'message',
            id: message.id,
            messageId: message.id,
            createdAt: message.createdAt ?? 0,
            seq: null,
        }];
    });

    if ((pendingMessages ?? []).length > 0) {
        items.push({
            kind: 'pending-queue',
            id: 'pending-queue',
            pendingMessages,
            discardedMessages: [],
        });
    }

    for (const draft of actionDrafts ?? []) {
        items.push({
            kind: 'action-draft',
            id: `draft:${draft.id}`,
            draft,
        });
    }

    return items;
}

export function createChatListHarnessItemsModuleMock(
    buildChatListItems: (options: {
        actionDrafts?: any[];
        messageIdsOldestFirst?: string[];
        messagesById?: Record<string, any>;
        pendingMessages?: any[];
    }) => any[] = buildChatListHarnessItems,
) {
    return {
        buildChatListItems,
        buildChatListItemsCached: (options: any) => ({
            cache: null,
            items: buildChatListItems(options),
        }),
    };
}

export function createLegendChatListModuleMock(
    options: Readonly<{ renderItems?: boolean }> = {},
) {
    const legendListMock = createCapturingLegendListMock({
        renderItems: options.renderItems,
        resolveState: () => chatListHarnessState.legendListState,
    });
    const LegendList = React.forwardRef<any, any>((props, ref) => {
        const element = (legendListMock.module.LegendList as any).render?.(props, ref)
            ?? React.createElement(legendListMock.module.LegendList as any, { ...props, ref });
        chatListHarnessState.legendListProps = legendListMock.state.props;
        chatListHarnessState.legendListRefHandle = legendListMock.state.refHandle;
        return element;
    });
    return { LegendList };
}

export function requireCapturedLegendListProps(): any {
    const props = chatListHarnessState.legendListProps;
    if (!props) throw new Error('Expected the Legend-primary ChatList harness to capture Legend props');
    return props;
}

export async function createChatListHarnessReactNativeMock(
    options: Readonly<{
        overrides?: Record<string, unknown>;
        platformOs?: 'web' | 'ios';
    }> = {},
) {
    const platformOs = options.platformOs ?? chatListHarnessState.platformOs;

    return createReactNativeWebMock({
        Platform: {
            OS: platformOs,
            select: (values: Record<string, unknown>) => values?.[platformOs] ?? values?.default,
        },
        View: (props: any) => React.createElement('View', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        ActivityIndicator: () => React.createElement('ActivityIndicator'),
        FlatList: () => React.createElement('FlatList'),
        ...(options.overrides ?? {}),
    });
}

export async function createChatListHarnessStorageMock(
    importOriginal: <T>() => Promise<T>,
    overrides: Partial<typeof import('@/sync/domains/state/storage')> = {},
) {
    const readMessages = () => chatListHarnessState.sessionMessagesState.messages ?? [];
    let cachedMessagesForIds: readonly any[] | null = null;
    let cachedMessageIds: string[] = [];
    let cachedMessagesForMap: readonly any[] | null = null;
    let cachedMessagesById: Record<string, any> = {};
    const readMessageIds = () => {
        const messages = readMessages();
        if (cachedMessagesForIds === messages) return cachedMessageIds;
        cachedMessagesForIds = messages;
        cachedMessageIds = messages.map((message: any) => message.id);
        return cachedMessageIds;
    };
    const readMessagesById = () => {
        const messages = readMessages();
        if (cachedMessagesForMap === messages) return cachedMessagesById;
        cachedMessagesForMap = messages;
        cachedMessagesById = Object.fromEntries(messages.map((message: any) => [message.id, message]));
        return cachedMessagesById;
    };

    return createStorageModuleMock({
        importOriginal,
        overrides: {
            storage: createLiveStorageStoreMock(() => createChatListHarnessMessagesSnapshot()),
            useSession: () => chatListHarnessState.sessionState,
            useSessionTranscriptIds: () => {
                return {
                    ids: readMessageIds(),
                    isLoaded: chatListHarnessState.sessionMessagesState.isLoaded,
                };
            },
            useSessionMessagesById: () => readMessagesById(),
            useSessionMessagesReducerState: () => createReducer(),
            useSessionForkSupportSource: () => null,
            useSessionWorkspacePath: () => null,
            useForkedTranscriptSnapshot: () => null,
            useSessionPendingMessages: () => chatListHarnessState.sessionPendingState,
            useSessionActionDrafts: () => chatListHarnessState.sessionActionDraftsState,
            useSessionLatestThinkingMessageId: () => null,
            useSessionLatestThinkingMessageActivityAtMs: () => null,
            useMessage: (_sessionId: string, messageId: string) =>
                readMessages().find((message: any) => message.id === messageId) ?? null,
            useSetting: (key: string) => chatListHarnessState.settingValues[key],
            getStorage: () => createLiveStorageStoreMock(() => createChatListHarnessMessagesSnapshot()),
            ...overrides,
        },
    });
}

export async function createChatListHarnessStorageStoreMock(
    importOriginal: <T>() => Promise<T>,
    overrides: Partial<typeof import('@/sync/domains/state/storageStore')> = {},
) {
    return createStorageStoreModuleMock({
        importOriginal,
        overrides: {
            getStorage: () => createLiveStorageStoreMock(() => createChatListHarnessMessagesSnapshot()),
            ...overrides,
        },
    });
}

export function createChatListHarnessSyncModuleMock(
    overrides: Partial<Record<string, unknown>> = {},
) {
    // C6/D3: faithful stand-in for the sync-owned reactive drain (the data layer owns the threshold
    // + in-flight dedupe + fetch; the list supplies geometry only). Mirrors the real decision against
    // the boundary-mocked loadNewerMessages so the catch-up contract is still exercised end-to-end
    // through ChatList without loading the heavy sync module. The in-flight guard mirrors the real
    // loadNewerMessages dedupe (sessionMessagesLoadingNewerByKey).
    const inFlightSessions = new Set<string>();
    const hasDeferredNewerMessages = (overrides.hasDeferredNewerMessages as ((id: string) => boolean) | undefined)
        ?? (() => false);
    const loadNewerMessages = (overrides.loadNewerMessages as ((id: string) => Promise<unknown>) | undefined)
        ?? (async () => undefined);
    const maybeDrainDeferredNewerMessages = (
        sessionId: string,
        viewport: Readonly<{ isPinned: boolean; distanceFromBottomPx: number }>,
    ): void => {
        if (!sessionId || hasDeferredNewerMessages(sessionId) !== true) return;
        const thresholdPx = chatListHarnessState.syncTuningState.transcriptForwardPrefetchThresholdPx;
        const nearBottom = viewport.isPinned || viewport.distanceFromBottomPx <= thresholdPx;
        if (!nearBottom || inFlightSessions.has(sessionId)) return;
        inFlightSessions.add(sessionId);
        void Promise.resolve(loadNewerMessages(sessionId)).catch(() => {}).finally(() => {
            inFlightSessions.delete(sessionId);
        });
    };
    const inactiveSessionMessagesWindowState = createInactiveSessionMessagesWindowState();
    return {
        sync: {
            loadOlderMessages: async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const }),
            loadNewerMessages,
            hasDeferredNewerMessages,
            getSyncTuning: () => chatListHarnessState.syncTuningState,
            // Stable identity: ChatList consumes this through useSyncExternalStore.
            getSessionTargetWindowState: () => inactiveSessionMessagesWindowState,
            subscribeSessionTargetWindowState: () => () => undefined,
            markSessionLiveTailIntent: () => undefined,
            maybeDrainDeferredNewerMessages,
            ...overrides,
        },
    };
}

export async function triggerLegendChatListScroll(
    offsetY: number,
    nativeEventExtras: Record<string, unknown> = {},
    flushOptions: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedLegendListProps = requireCapturedLegendListProps();
    await act(async () => {
        capturedLegendListProps.onScroll?.({
            nativeEvent: {
                contentOffset: { y: offsetY },
                ...nativeEventExtras,
            },
        });
    });
    await flushHookEffects(flushOptions);
}

export async function triggerLegendChatListWheel(
    deltaY: number,
    flushOptions: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedLegendListProps = requireCapturedLegendListProps();
    await act(async () => {
        capturedLegendListProps.onWheel?.({ deltaY });
    });
    await flushHookEffects(flushOptions);
}

export async function triggerLegendChatListStartReached(
    flushOptions: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedLegendListProps = requireCapturedLegendListProps();
    await act(async () => {
        await capturedLegendListProps.onStartReached?.();
    });
    await flushHookEffects(flushOptions);
}

export async function triggerLegendChatListEndReached(
    flushOptions: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedLegendListProps = requireCapturedLegendListProps();
    await act(async () => {
        await capturedLegendListProps.onEndReached?.();
    });
    await flushHookEffects(flushOptions);
}

/**
 * Drives the composed host's layout + synthesized content-size chain on the Legend axis:
 * fires the identity-host onLayout (listLayoutHeight) and seeds the stateful Legend mock
 * geometry (contentLength/scrollLength) so the adapter's synthesized onContentSizeChange and
 * at-end reads observe it.
 */
export async function triggerLegendChatListInitialFill(
    screen: ChatListHarness,
    options: Readonly<{
        contentHeight?: number;
        flushOptions?: FlushHookEffectsOptions;
        layoutHeight?: number;
        layoutWidth?: number;
        state?: Partial<LegendListMockState>;
    }> = {},
): Promise<void> {
    const layoutHeight = options.layoutHeight ?? 800;
    const contentHeight = options.contentHeight ?? 200;
    chatListHarnessState.legendListState = {
        contentLength: contentHeight,
        scrollLength: layoutHeight,
        ...(options.state ?? {}),
    };
    const identityHost = screen.findByTestId('transcript-chat-list');
    await act(async () => {
        identityHost?.props.onLayout?.({
            nativeEvent: {
                layout: {
                    height: layoutHeight,
                    width: options.layoutWidth ?? 400,
                },
            },
        });
    });
    await flushHookEffects(options.flushOptions);
}

export async function withChatListHarnessWebScrollerDom<T>(
    scrollerElement: unknown,
    run: () => Promise<T>,
    options: ChatListHarnessDomInstallerOptions = {},
): Promise<T> {
    const previousDocument = (globalThis as any).document;
    const previousHTMLElement = (globalThis as any).HTMLElement;
    const previousWindow = (globalThis as any).window;
    const previousRequestAnimationFrame = (globalThis as any).requestAnimationFrame;
    const previousCancelAnimationFrame = (globalThis as any).cancelAnimationFrame;

    (globalThis as any).document = {
        querySelector: () => scrollerElement,
        getElementById: () => ({ querySelectorAll: () => [scrollerElement] }),
        ...(options.document ?? {}),
    };
    (globalThis as any).window = {
        getComputedStyle: () => ({ overflowY: 'auto' }),
        ...(options.window ?? {}),
    };
    if ('HTMLElement' in options) {
        (globalThis as any).HTMLElement = options.HTMLElement;
    }

    if (options.useImmediateAnimationFrame !== false) {
        // Timeout-based shim: the Legend adapter's bounded settle monitor re-schedules itself
        // via rAF, so a synchronous shim would recurse unboundedly.
        (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => (
            setTimeout(() => callback(Date.now()), 0) as unknown as number
        );
        (globalThis as any).cancelAnimationFrame = (handle: number) => {
            clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
        };
    }

    try {
        return await run();
    } finally {
        (globalThis as any).document = previousDocument;
        (globalThis as any).HTMLElement = previousHTMLElement;
        (globalThis as any).window = previousWindow;
        (globalThis as any).requestAnimationFrame = previousRequestAnimationFrame;
        (globalThis as any).cancelAnimationFrame = previousCancelAnimationFrame;
    }
}

export async function withRenderedChatListHarnessWebScroller<T>(
    scrollerElement: unknown,
    element: React.ReactElement,
    run: (screen: ChatListHarness) => Promise<T>,
    options: Readonly<{
        dom?: ChatListHarnessDomInstallerOptions;
        render?: RenderWithAppProvidersOptions;
    }> = {},
): Promise<T> {
    return withChatListHarnessWebScrollerDom(
        scrollerElement,
        async () => {
            const screen = await renderChatList(element, options.render ?? {});
            return run(screen);
        },
        options.dom ?? {},
    );
}

export async function renderChatListHarnessSession(
    options: Parameters<typeof renderScreen>[1] = {},
): Promise<ChatListHarness> {
    const { ChatList } = await import('@/components/sessions/transcript/ChatList');
    return renderChatList(
        React.createElement(ChatList, {
            session: { ...chatListHarnessState.sessionState },
        }),
        options,
    );
}

export async function renderChatList(
    element: React.ReactElement,
    options: RenderWithAppProvidersOptions = {},
): Promise<ChatListHarness> {
    const screen = await renderScreen(element, options);

    return {
        ...screen,
        findMessageRow: (testID) => screen.findByTestId(testID),
        listMessageRows: (prefix = 'session.') => screen.findAll((node) => (
            typeof node.props?.testID === 'string' && node.props.testID.startsWith(prefix)
        )),
        settle: async (flushOptions) => {
            await flushHookEffects(flushOptions);
        },
    };
}
