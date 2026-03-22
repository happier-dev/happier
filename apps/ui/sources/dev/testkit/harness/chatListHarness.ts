import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';

import { flushHookEffects, type FlushHookEffectsOptions } from '../hooks/flushHookEffects';
import { createCapturingFlashListMock } from '../mocks/flashList';
import { createReactNativeWebMock } from '../mocks/reactNative';
import { createStorageModuleMock, createStorageStoreMock } from '../mocks/storage';
import { renderScreen, type RenderScreenResult } from '../render/renderScreen';
import type { RenderWithAppProvidersOptions } from '../render/renderWithAppProviders';
import { createReducer } from '@/sync/reducer/reducer';
import { mergeTranscriptCommittedAndDraftMessages } from '@/sync/domains/messages/mergeTranscriptCommittedAndDraftMessages';

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

type SyncTuningState = {
    transcriptForwardPrefetchThresholdPx: number;
    transcriptBackwardPrefetchThresholdPx: number;
    transcriptFlashListEstimatedItemSize: number;
    transcriptWebHotTailItemCount: number;
    transcriptWebInitialPinStabilizeMs: number;
    transcriptWebInitialPinRetryIntervalMs: number;
};

type FlashListChatListHarnessState = {
    flashListProps: any | null;
    flashListRefHandle: unknown;
    platformOs: 'web' | 'ios';
    sessionMessagesState: SessionMessagesState;
    sessionPendingState: SessionPendingState;
    sessionActionDraftsState: any[];
    sessionState: any;
    settingValues: Record<string, any>;
    syncTuningState: SyncTuningState;
};

type FlashListDomInstallerOptions = {
    document?: Record<string, unknown>;
    HTMLElement?: unknown;
    window?: Record<string, unknown>;
    useImmediateAnimationFrame?: boolean;
};

export class FlashListChatListWebElement {
    public scrollTop = 0;
    public scrollHeight = 0;
    public clientHeight = 0;
    public scrollWidth = 0;
    public clientWidth = 0;
    public isConnected = true;
    public parentElement: FlashListChatListWebElement | null = null;

    private rect: { top: number; bottom: number };
    private readonly nodesBySelector = new Map<string, FlashListChatListWebElement[]>();

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

    setQuerySelectorAll(selector: string, nodes: FlashListChatListWebElement[]) {
        this.nodesBySelector.set(selector, nodes);
    }

    contains(node: unknown) {
        return node === this;
    }

    setRect(rect: { top: number; bottom: number }) {
        this.rect = rect;
    }
}

export function createFlashListChatListWebElement(
    testId: string | null,
    rect: { top: number; bottom: number },
) {
    return new FlashListChatListWebElement(testId, rect);
}

export type FlashListChatListWebScroller = FlashListChatListWebElement & {
    scrollTop: number;
};

export function createFlashListChatListWebScroller(
    options: Readonly<{
        clientHeight?: number;
        clientWidth?: number;
        rect?: { top: number; bottom: number };
        scrollHeight?: number;
        scrollTop?: number;
        scrollWidth?: number;
        testId?: string | null;
        testNodes?: FlashListChatListWebElement[];
    }> = {},
): FlashListChatListWebScroller {
    const scroller = createFlashListChatListWebElement(
        options.testId ?? null,
        options.rect ?? { top: 0, bottom: options.clientHeight ?? 0 },
    ) as FlashListChatListWebScroller;

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

type LegacyChatListHarnessState = {
    capturedFlatListProps: any | null;
    sessionMessagesState: SessionMessagesState;
    sessionPendingState: SessionPendingState;
    sessionActionDraftsState: any[];
    sessionTranscriptDraftMessagesState: any[];
    sessionState: any;
    settingValues: Record<string, any>;
    flatListRefValue: any;
};

export const legacyChatListHarnessState: LegacyChatListHarnessState = {
    capturedFlatListProps: null,
    sessionMessagesState: { messages: [], isLoaded: true },
    sessionPendingState: { messages: [], discarded: [], isLoaded: true },
    sessionActionDraftsState: [],
    sessionTranscriptDraftMessagesState: [],
    sessionState: null,
    settingValues: {},
    flatListRefValue: null,
};

export const flashListChatListHarnessState: FlashListChatListHarnessState = {
    flashListProps: null,
    flashListRefHandle: {
        scrollToOffset: () => {},
        scrollToIndex: () => {},
    },
    platformOs: 'web',
    sessionMessagesState: { messages: [], isLoaded: true },
    sessionPendingState: { messages: [], discarded: [], isLoaded: true },
    sessionActionDraftsState: [],
    sessionState: null,
    settingValues: {},
    syncTuningState: {
        transcriptForwardPrefetchThresholdPx: 0,
        transcriptBackwardPrefetchThresholdPx: 0,
        transcriptFlashListEstimatedItemSize: 120,
        transcriptWebHotTailItemCount: 2,
        transcriptWebInitialPinStabilizeMs: 3000,
        transcriptWebInitialPinRetryIntervalMs: 250,
    },
};

function createFlashListChatListMessagesSnapshot() {
    const sessionId = String(flashListChatListHarnessState.sessionState?.id ?? 'session-1');
    const messagesById = Object.fromEntries(
        (flashListChatListHarnessState.sessionMessagesState.messages ?? []).map((message: any) => [message.id, message]),
    );

    return {
        sessionMessages: {
            [sessionId]: {
                messageIdsOldestFirst: Object.keys(messagesById),
                messagesById,
                messagesMap: messagesById,
                draftsByLocalId: {},
                reducerState: createReducer(),
                reducerVersion: 0,
                latestThinkingMessageId: null,
                latestThinkingMessageActivityAtMs: null,
                messagesVersion: 0,
                isLoaded: flashListChatListHarnessState.sessionMessagesState.isLoaded,
            },
        },
    };
}

export function resetFlashListChatListHarness(
    options: Readonly<{
        flashListRefHandle?: unknown;
        platformOs?: 'web' | 'ios';
        syncTuningState?: Partial<SyncTuningState>;
    }> = {},
) {
    flashListChatListHarnessState.flashListProps = null;
    flashListChatListHarnessState.flashListRefHandle = options.flashListRefHandle ?? {
        scrollToOffset: () => {},
        scrollToIndex: () => {},
    };
    flashListChatListHarnessState.platformOs = options.platformOs ?? 'web';
    flashListChatListHarnessState.sessionMessagesState = { messages: [], isLoaded: true };
    flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
    flashListChatListHarnessState.sessionActionDraftsState = [];
    flashListChatListHarnessState.sessionState = {
        id: 'session-1',
        seq: 0,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
        agentState: null,
    };
    flashListChatListHarnessState.syncTuningState = {
        transcriptForwardPrefetchThresholdPx: 0,
        transcriptBackwardPrefetchThresholdPx: 0,
        transcriptFlashListEstimatedItemSize: 120,
        transcriptWebHotTailItemCount: 2,
        transcriptWebInitialPinStabilizeMs: 3000,
        transcriptWebInitialPinRetryIntervalMs: 250,
        ...(options.syncTuningState ?? {}),
    };

    for (const key of Object.keys(flashListChatListHarnessState.settingValues)) {
        delete flashListChatListHarnessState.settingValues[key];
    }

    flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
    flashListChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    flashListChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;
    flashListChatListHarnessState.settingValues.transcriptMotionPreset = 'off';
    flashListChatListHarnessState.settingValues.transcriptAnimateNewItemsEnabled = false;
    flashListChatListHarnessState.settingValues.transcriptAnimateToolExpandCollapseEnabled = false;
    flashListChatListHarnessState.settingValues.transcriptAnimateThinkingEnabled = false;
}

export function buildFlashListChatListItems({
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

export function createFlashListChatListItemsModuleMock(
    buildChatListItems: (options: {
        actionDrafts?: any[];
        messageIdsOldestFirst?: string[];
        messagesById?: Record<string, any>;
        pendingMessages?: any[];
    }) => any[] = buildFlashListChatListItems,
) {
    return {
        buildChatListItems,
        buildChatListItemsCached: (options: any) => ({
            cache: null,
            items: buildChatListItems(options),
        }),
    };
}

export async function createFlashListChatListModuleMock(
    options: Readonly<{
        refHandle?: unknown;
        renderItems?: boolean;
    }> = {},
) {
    const flashListMock = createCapturingFlashListMock({
        renderItems: options.renderItems,
        refHandle: options.refHandle ?? flashListChatListHarnessState.flashListRefHandle,
    });

    return {
        FlashList: React.forwardRef<any, any>((props, ref) => {
            const element = (flashListMock.module.FlashList as any).render?.(props, ref)
                ?? React.createElement(flashListMock.module.FlashList as any, { ...props, ref });
            flashListChatListHarnessState.flashListProps = flashListMock.state.props;
            return element;
        }),
    };
}

export async function createFlashListChatListReactNativeMock(
    options: Readonly<{
        overrides?: Record<string, unknown>;
        platformOs?: 'web' | 'ios';
        trackFlatListRender?: () => void;
    }> = {},
) {
    const platformOs = options.platformOs ?? flashListChatListHarnessState.platformOs;

    return createReactNativeWebMock({
        Platform: {
            OS: platformOs,
            select: (values: Record<string, unknown>) => values?.[platformOs] ?? values?.default,
        },
        View: (props: any) => React.createElement('View', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        ActivityIndicator: () => React.createElement('ActivityIndicator'),
        FlatList: () => {
            options.trackFlatListRender?.();
            return React.createElement('FlatList');
        },
        ...(options.overrides ?? {}),
    });
}

export async function createFlashListChatListStorageMock(
    importOriginal: <T>() => Promise<T>,
    overrides: Partial<typeof import('@/sync/domains/state/storage')> = {},
) {
    const sessionState = flashListChatListHarnessState.sessionState;
    const messages = flashListChatListHarnessState.sessionMessagesState.messages ?? [];
    const messagesById = Object.fromEntries(messages.map((message: any) => [message.id, message]));

    return createStorageModuleMock({
        importOriginal,
        overrides: {
            storage: createStorageStoreMock(createFlashListChatListMessagesSnapshot()),
            useSession: () => flashListChatListHarnessState.sessionState,
            useSessionTranscriptIds: () => ({
                ids: messages.map((message: any) => message.id),
                isLoaded: flashListChatListHarnessState.sessionMessagesState.isLoaded,
            }),
            useSessionMessagesById: () => messagesById,
            useForkedTranscriptSnapshot: () => null,
            useSessionPendingMessages: () => flashListChatListHarnessState.sessionPendingState,
            useSessionActionDrafts: () => flashListChatListHarnessState.sessionActionDraftsState,
            useSessionLatestThinkingMessageId: () => null,
            useSessionLatestThinkingMessageActivityAtMs: () => null,
            useMessage: (_sessionId: string, messageId: string) =>
                messages.find((message: any) => message.id === messageId) ?? null,
            useSetting: (key: string) => flashListChatListHarnessState.settingValues[key],
            getStorage: () => createStorageStoreMock(createFlashListChatListMessagesSnapshot()),
            ...overrides,
        },
    });
}

export function createFlashListChatListSyncModuleMock(
    overrides: Partial<Record<string, unknown>> = {},
) {
    return {
        sync: {
            loadOlderMessages: async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const }),
            loadNewerMessages: async () => undefined,
            hasDeferredNewerMessages: () => false,
            getSyncTuning: () => flashListChatListHarnessState.syncTuningState,
            ...overrides,
        },
    };
}

export function getCapturedFlashListProps() {
    return flashListChatListHarnessState.flashListProps;
}

export function requireCapturedFlashListProps() {
    const capturedFlashListProps = getCapturedFlashListProps();
    if (!capturedFlashListProps) {
        throw new Error('Expected the FlashList ChatList harness to capture FlashList props');
    }
    return capturedFlashListProps;
}

export async function triggerFlashListChatListInitialFill(
    options: Readonly<{
        contentHeight?: number;
        contentWidth?: number;
        flushOptions?: FlushHookEffectsOptions;
        layoutHeight?: number;
        layoutWidth?: number;
    }> = {},
): Promise<void> {
    const capturedFlashListProps = requireCapturedFlashListProps();
    await act(async () => {
        capturedFlashListProps.onLayout?.({
            nativeEvent: {
                layout: {
                    height: options.layoutHeight ?? 800,
                    width: options.layoutWidth ?? 400,
                },
            },
        });
        capturedFlashListProps.onContentSizeChange?.(
            options.contentWidth ?? 400,
            options.contentHeight ?? 200,
        );
    });
    await flushHookEffects(options.flushOptions);
}

export async function triggerFlashListChatListContentSizeChange(
    contentWidth: number,
    contentHeight: number,
    flushOptions: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedFlashListProps = requireCapturedFlashListProps();
    await act(async () => {
        capturedFlashListProps.onContentSizeChange?.(contentWidth, contentHeight);
    });
    await flushHookEffects(flushOptions);
}

export async function triggerFlashListChatListScroll(
    offsetY: number,
    nativeEventExtras: Record<string, unknown> = {},
    flushOptions: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedFlashListProps = requireCapturedFlashListProps();
    await act(async () => {
        capturedFlashListProps.onScroll?.({
            nativeEvent: {
                contentOffset: { y: offsetY },
                ...nativeEventExtras,
            },
        });
    });
    await flushHookEffects(flushOptions);
}

export async function triggerFlashListChatListPointerDown(
    event: Record<string, unknown> = {},
    flushOptions: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedFlashListProps = requireCapturedFlashListProps();
    await act(async () => {
        capturedFlashListProps.onPointerDown?.(event);
    });
    await flushHookEffects(flushOptions);
}

export async function triggerFlashListChatListStartReached(
    flushOptions: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedFlashListProps = requireCapturedFlashListProps();
    await act(async () => {
        await capturedFlashListProps.onStartReached?.();
    });
    await flushHookEffects(flushOptions);
}

export async function withFlashListChatListWebScrollerDom<T>(
    scrollerElement: unknown,
    run: () => Promise<T>,
    options: FlashListDomInstallerOptions = {},
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
        (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => {
            callback(0);
            return 1;
        };
        (globalThis as any).cancelAnimationFrame = () => {};
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

export async function withRenderedFlashListChatListWebScroller<T>(
    scrollerElement: unknown,
    element: React.ReactElement,
    run: (screen: FlashListChatListHarness) => Promise<T>,
    options: Readonly<{
        dom?: FlashListDomInstallerOptions;
        initialFill?: Parameters<typeof triggerFlashListChatListInitialFill>[0] | false;
        render?: RenderWithAppProvidersOptions;
    }> = {},
): Promise<T> {
    return withFlashListChatListWebScrollerDom(
        scrollerElement,
        async () => {
            const screen = await renderFlashListChatList(element, options.render ?? {});
            if (options.initialFill !== false) {
                await screen.triggerInitialFill(options.initialFill ?? {});
            }
            return run(screen);
        },
        options.dom ?? {},
    );
}

function createLegacyChatListMessagesSnapshot() {
    const sessionId = String(legacyChatListHarnessState.sessionState?.id ?? 'session-1');
    const allMessages = [
        ...(legacyChatListHarnessState.sessionMessagesState.messages ?? []),
        ...(legacyChatListHarnessState.sessionTranscriptDraftMessagesState ?? []),
    ];
    const messagesById = Object.fromEntries(
        allMessages.map((message: any) => [message.id, message]),
    );
    const messageIdsOldestFirst = allMessages.map((message: any) => message.id);

    return {
        sessionMessages: {
            [sessionId]: {
                messageIdsOldestFirst,
                messagesById,
                messagesMap: messagesById,
                draftsByLocalId: {},
                reducerState: createReducer(),
                reducerVersion: 0,
                latestThinkingMessageId: null,
                latestThinkingMessageActivityAtMs: null,
                messagesVersion: 0,
                isLoaded: legacyChatListHarnessState.sessionMessagesState.isLoaded,
            },
        },
    };
}

export function resetLegacyChatListHarness(options: {
    platformOs?: 'web' | 'ios';
    flatListRefValue?: any;
} = {}) {
    legacyChatListHarnessState.capturedFlatListProps = null;
    legacyChatListHarnessState.sessionMessagesState = { messages: [], isLoaded: true };
    legacyChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
    legacyChatListHarnessState.sessionActionDraftsState = [];
    legacyChatListHarnessState.sessionTranscriptDraftMessagesState = [];
    legacyChatListHarnessState.sessionState = {
        id: 'session-1',
        seq: 0,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
        agentState: null,
    };
    legacyChatListHarnessState.flatListRefValue = options.flatListRefValue ?? null;

    for (const key of Object.keys(legacyChatListHarnessState.settingValues)) {
        delete legacyChatListHarnessState.settingValues[key];
    }

    legacyChatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
    legacyChatListHarnessState.settingValues.transcriptGroupToolCalls = false;
    legacyChatListHarnessState.settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
    legacyChatListHarnessState.settingValues.transcriptListImplementation = 'flatlist_legacy';
    legacyChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    legacyChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 72;
    legacyChatListHarnessState.settingValues.transcriptScrollJumpToBottomEnabled = true;
    legacyChatListHarnessState.settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
    legacyChatListHarnessState.settingValues.transcriptScrollJumpToBottomAnimateScroll = false;
    legacyChatListHarnessState.settingValues.transcriptMotionPreset = 'off';
    legacyChatListHarnessState.settingValues.transcriptAnimateNewItemsEnabled = false;

    return options.platformOs ?? 'web';
}

export function buildLegacyChatListItems({
    messageIdsOldestFirst,
    messagesById,
    pendingMessages,
    actionDrafts,
}: {
    messageIdsOldestFirst?: string[];
    messagesById?: Record<string, any>;
    pendingMessages?: any[];
    actionDrafts?: any[];
}) {
    const items: any[] = [];
    for (const id of messageIdsOldestFirst ?? []) {
        const message = messagesById?.[id];
        if (!message) continue;
        items.push({
            kind: 'message',
            id: message.id,
            messageId: message.id,
            createdAt: message.createdAt,
            seq: null,
        });
    }
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

export function createLegacyChatListItemsModuleMock(
    buildChatListItems: (options: {
        actionDrafts?: any[];
        messageIdsOldestFirst?: string[];
        messagesById?: Record<string, any>;
        pendingMessages?: any[];
    }) => any[] = buildLegacyChatListItems,
) {
    return {
        buildChatListItems,
        buildChatListItemsCached: (options: any) => ({
            cache: null,
            items: buildChatListItems(options),
        }),
    };
}

export async function createLegacyChatListReactNativeMock(options: {
    platformOs?: 'web' | 'ios';
} = {}) {
    const platformOs = options.platformOs ?? 'web';

    return createReactNativeWebMock({
        Platform: {
            OS: platformOs,
            select: (values: Record<string, unknown>) =>
                values?.[platformOs] ?? values?.default,
        },
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        ActivityIndicator: () => React.createElement('ActivityIndicator'),
        FlatList: (props: any) => {
            legacyChatListHarnessState.capturedFlatListProps = props;
            if (typeof props.ref === 'function') {
                props.ref(legacyChatListHarnessState.flatListRefValue);
            } else if (props.ref && typeof props.ref === 'object') {
                props.ref.current = legacyChatListHarnessState.flatListRefValue;
            }
            const children: any[] = [];
            if (props.ListHeaderComponent) children.push(props.ListHeaderComponent);
            if (Array.isArray(props.data) && typeof props.renderItem === 'function') {
                for (const item of props.data) {
                    children.push(props.renderItem({ item }));
                }
            }
            if (props.ListFooterComponent) children.push(props.ListFooterComponent);
            return React.createElement('FlatList', null, ...children);
        },
    });
}

export async function createLegacyChatListStorageMock(
    importOriginal: <T>() => Promise<T>,
) {
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            storage: createStorageStoreMock(createLegacyChatListMessagesSnapshot()),
            useSession: () => legacyChatListHarnessState.sessionState,
            useSessionTranscriptIds: () => {
                const committedMessages = legacyChatListHarnessState.sessionMessagesState.messages ?? [];
                const merged = mergeTranscriptCommittedAndDraftMessages({
                    committedIds: committedMessages.map((message: any) => message.id),
                    committedMessagesById: Object.fromEntries(committedMessages.map((message: any) => [message.id, message])),
                    draftMessages: (legacyChatListHarnessState.sessionTranscriptDraftMessagesState ?? []).filter((message: any) => message?.kind === 'agent-text'),
                });
                return {
                    ids: merged.ids,
                    isLoaded: legacyChatListHarnessState.sessionMessagesState.isLoaded,
                };
            },
            useSessionMessagesById: () => {
                const committedMessages = legacyChatListHarnessState.sessionMessagesState.messages ?? [];
                return mergeTranscriptCommittedAndDraftMessages({
                    committedIds: committedMessages.map((message: any) => message.id),
                    committedMessagesById: Object.fromEntries(committedMessages.map((message: any) => [message.id, message])),
                    draftMessages: (legacyChatListHarnessState.sessionTranscriptDraftMessagesState ?? []).filter((message: any) => message?.kind === 'agent-text'),
                }).messagesById;
            },
            useForkedTranscriptSnapshot: () => null,
            useSessionPendingMessages: () => legacyChatListHarnessState.sessionPendingState,
            useSessionActionDrafts: () => legacyChatListHarnessState.sessionActionDraftsState,
            useSessionTranscriptDraftMessages: () => legacyChatListHarnessState.sessionTranscriptDraftMessagesState,
            useSessionLatestThinkingMessageId: () => null,
            useSessionLatestThinkingMessageActivityAtMs: () => null,
            useMessage: (_sessionId: string, messageId: string) =>
                [
                    ...(legacyChatListHarnessState.sessionMessagesState.messages ?? []),
                    ...(legacyChatListHarnessState.sessionTranscriptDraftMessagesState ?? []),
                ].find((message: any) => message.id === messageId) ?? null,
            useSetting: (key: string) => legacyChatListHarnessState.settingValues[key],
            getStorage: () => createStorageStoreMock(createLegacyChatListMessagesSnapshot()),
        },
    });
}

export function getCapturedFlatListProps() {
    return legacyChatListHarnessState.capturedFlatListProps;
}

export function requireCapturedFlatListProps() {
    const capturedFlatListProps = getCapturedFlatListProps();
    if (!capturedFlatListProps) {
        throw new Error('Expected the legacy ChatList harness to capture FlatList props');
    }
    return capturedFlatListProps;
}

export async function flushLegacyChatListEffects(
    options: FlushHookEffectsOptions = {},
): Promise<void> {
    await flushHookEffects({
        cycles: options.cycles ?? 2,
        turns: options.turns ?? 1,
        advanceTimersMs: options.advanceTimersMs,
        runAllTimers: options.runAllTimers,
        frames: options.frames,
    });
}

export async function triggerLegacyChatListScroll(
    offsetY: number,
    options: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedFlatListProps = requireCapturedFlatListProps();
    await act(async () => {
        capturedFlatListProps.onScroll?.({
            nativeEvent: {
                contentOffset: { y: offsetY },
            },
        });
    });
    await flushLegacyChatListEffects(options);
}

export async function triggerLegacyChatListInitialFill(
    options: Readonly<{
        contentHeight?: number;
        contentWidth?: number;
        flushOptions?: FlushHookEffectsOptions;
        layoutHeight?: number;
        layoutWidth?: number;
    }> = {},
): Promise<void> {
    const capturedFlatListProps = requireCapturedFlatListProps();
    await act(async () => {
        capturedFlatListProps.onLayout?.({
            nativeEvent: {
                layout: {
                    height: options.layoutHeight ?? 800,
                    width: options.layoutWidth ?? 400,
                },
            },
        });
        capturedFlatListProps.onContentSizeChange?.(
            options.contentWidth ?? 400,
            options.contentHeight ?? 200,
        );
    });
    await flushLegacyChatListEffects(options.flushOptions);
}

export async function triggerLegacyChatListEndReached(
    options: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedFlatListProps = requireCapturedFlatListProps();
    await act(async () => {
        capturedFlatListProps.onEndReached?.();
    });
    await flushLegacyChatListEffects(options);
}

export async function renderLegacyChatList(
    options: Parameters<typeof renderScreen>[1] = {},
): Promise<RenderScreenResult> {
    const { ChatList } = await import('@/components/sessions/transcript/ChatList');
    return renderScreen(
        React.createElement(ChatList, {
            session: { ...legacyChatListHarnessState.sessionState },
        }),
        options,
    );
}

export type FlashListChatListHarness = ChatListHarness & Readonly<{
    getCapturedFlashListProps: typeof getCapturedFlashListProps;
    requireCapturedFlashListProps: typeof requireCapturedFlashListProps;
    triggerContentSizeChange: typeof triggerFlashListChatListContentSizeChange;
    triggerInitialFill: typeof triggerFlashListChatListInitialFill;
    triggerPointerDown: typeof triggerFlashListChatListPointerDown;
    triggerScroll: typeof triggerFlashListChatListScroll;
    triggerStartReached: typeof triggerFlashListChatListStartReached;
}>;

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

export async function renderFlashListChatList(
    element: React.ReactElement,
    options: RenderWithAppProvidersOptions = {},
): Promise<FlashListChatListHarness> {
    const screen = await renderChatList(element, options);

    return {
        ...screen,
        getCapturedFlashListProps,
        requireCapturedFlashListProps,
        triggerContentSizeChange: triggerFlashListChatListContentSizeChange,
        triggerInitialFill: triggerFlashListChatListInitialFill,
        triggerPointerDown: triggerFlashListChatListPointerDown,
        triggerScroll: triggerFlashListChatListScroll,
        triggerStartReached: triggerFlashListChatListStartReached,
    };
}
