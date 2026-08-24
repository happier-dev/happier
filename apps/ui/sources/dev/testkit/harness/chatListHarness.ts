import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';

import { flushHookEffects, type FlushHookEffectsOptions } from '../hooks/flushHookEffects';
import { createCapturingFlashListMock } from '../mocks/flashList';
import { createCapturingLegendListMock } from '../mocks/legendList';
import { createReactNativeWebMock } from '../mocks/reactNative';
import { createStorageModuleMock, createStorageStoreMock, createStorageStoreModuleMock } from '../mocks/storage';
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

type FlashListMappingKey = string | number | bigint;

type FlashListLayoutStateSetter<T> = (
    newValue: T | ((previousValue: T) => T),
    skipParentLayout?: boolean,
) => void;

type FlashListLayoutStateInitialValue<T> = T | (() => T);

type FlashListChatListHarnessState = {
    flashListProps: any | null;
    flashListRefHandle: unknown;
    flashListRenderCount: number;
    legendListProps: any | null;
    legendListPropsHistory: any[];
    legendListRefHandle: unknown;
    platformOs: 'web' | 'ios';
    /** Session screen navigation focus fed to the shared useSessionScreenIsFocused mock. */
    sessionScreenIsFocused: boolean;
    sessionMessagesState: SessionMessagesState;
    sessionPendingState: SessionPendingState;
    sessionActionDraftsState: any[];
    sessionState: any;
    settingValues: Record<string, any>;
    syncTuningState: SyncTuningState;
    activeServerAccountScope: ServerAccountScope | null;
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
    public readonly nodeType = 1;
    public parentElement: FlashListChatListWebElement | null = null;

    private readonly attributes = new Map<string, string>();
    private rect: { top: number; bottom: number };
    private readonly nodesBySelector = new Map<string, FlashListChatListWebElement[]>();

    constructor(
        private readonly testId: string | null,
        rect: { top: number; bottom: number },
    ) {
        this.rect = rect;
    }

    getAttribute(name: string) {
        if (name === 'data-testid') return this.testId;
        return this.attributes.get(name) ?? null;
    }

    hasAttribute(name: string) {
        return this.getAttribute(name) !== null;
    }

    setAttribute(name: string, value: string) {
        this.attributes.set(name, String(value));
    }

    removeAttribute(name: string) {
        this.attributes.delete(name);
    }

    get parentNode() {
        return this.parentElement;
    }

    focus(_options?: FocusOptions) {
        const installedDocument = Reflect.get(globalThis, 'document') as
            | { activeElement: unknown }
            | undefined;
        if (installedDocument && typeof installedDocument === 'object') {
            installedDocument.activeElement = this;
        }
    }

    blur() {
        const installedDocument = Reflect.get(globalThis, 'document') as
            | { activeElement: unknown; body?: unknown }
            | undefined;
        if (installedDocument?.activeElement === this) {
            installedDocument.activeElement = installedDocument.body ?? null;
        }
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

function parseDataTestIdAttributeSelector(selector: string): string | null {
    const match = selector.match(/^\[data-testid="((?:\\.|[^"\\])*)"\]$/);
    if (!match) return null;
    return match[1]
        .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_value, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\(.)/g, '$1');
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

type FlashListChatListWebEvent = Readonly<{ type: string }> & Record<string, unknown>;
type FlashListChatListWebEventListener =
    | ((event: FlashListChatListWebEvent) => void)
    | Readonly<{ handleEvent: (event: FlashListChatListWebEvent) => void }>;

type FlashListChatListWebEventListenerRegistration = Readonly<{
    capture: boolean;
    listener: FlashListChatListWebEventListener;
}>;

type FlashListChatListWebDocumentBoundary = {
    activeElement: unknown;
    readonly body: FlashListChatListWebElement;
    readonly documentElement: FlashListChatListWebElement;
    readonly nodeType: 9;
    readonly parentNode: null;
    readonly querySelector: () => unknown;
    readonly getElementById: () => Readonly<{ querySelectorAll: () => unknown[] }>;
    readonly addEventListener: (
        type: string,
        listener: FlashListChatListWebEventListener,
        options?: boolean | Readonly<{ capture?: boolean }>,
    ) => void;
    readonly removeEventListener: (
        type: string,
        listener: FlashListChatListWebEventListener,
        options?: boolean | Readonly<{ capture?: boolean }>,
    ) => void;
    readonly dispatchEvent: (event: FlashListChatListWebEvent) => boolean;
};

function readFlashListChatListWebEventListenerOptions(
    options?: boolean | Readonly<{ capture?: boolean }>,
): boolean {
    if (typeof options === 'boolean') return options;
    return options?.capture === true;
}

function createFlashListChatListWebDocument(scrollerElement: unknown): FlashListChatListWebDocumentBoundary {
    const listeners = new Map<string, FlashListChatListWebEventListenerRegistration[]>();
    const documentElement = createFlashListChatListWebElement(null, { top: 0, bottom: 0 });
    const body = createFlashListChatListWebElement(null, { top: 0, bottom: 0 });
    body.parentElement = documentElement;

    const documentBoundary: FlashListChatListWebDocumentBoundary = {
        activeElement: body,
        body,
        documentElement,
        nodeType: 9,
        parentNode: null,
        querySelector: () => scrollerElement,
        getElementById: () => ({ querySelectorAll: () => [scrollerElement] }),
        addEventListener(
            type: string,
            listener: FlashListChatListWebEventListener,
            options?: boolean | Readonly<{ capture?: boolean }>,
        ) {
            const capture = readFlashListChatListWebEventListenerOptions(options);
            const registrations = listeners.get(type) ?? [];
            if (
                registrations.some(
                    (entry) => entry.listener === listener && entry.capture === capture,
                )
            ) {
                return;
            }
            registrations.push({ listener, capture });
            listeners.set(type, registrations);
        },
        removeEventListener(
            type: string,
            listener: FlashListChatListWebEventListener,
            options?: boolean | Readonly<{ capture?: boolean }>,
        ) {
            const capture = readFlashListChatListWebEventListenerOptions(options);
            const registrations = listeners.get(type);
            if (!registrations) return;
            const remaining = registrations.filter(
                (entry) => entry.listener !== listener || entry.capture !== capture,
            );
            if (remaining.length > 0) listeners.set(type, remaining);
            else listeners.delete(type);
        },
        dispatchEvent(event: FlashListChatListWebEvent) {
            const registrations = [...(listeners.get(event.type) ?? [])];
            for (const registration of registrations) {
                if (typeof registration.listener === 'function') {
                    registration.listener(event);
                } else {
                    registration.listener.handleEvent(event);
                }
            }
            return event.defaultPrevented !== true;
        },
    };
    return documentBoundary;
}

const sessionScreenFocusListeners = new Set<() => void>();

/** Flips the harness session-screen focus and notifies mounted useSessionScreenIsFocused consumers. */
export function setChatListHarnessSessionScreenFocused(focused: boolean): void {
    flashListChatListHarnessState.sessionScreenIsFocused = focused;
    for (const listener of [...sessionScreenFocusListeners]) listener();
}

export function subscribeChatListHarnessSessionScreenFocus(listener: () => void): () => void {
    sessionScreenFocusListeners.add(listener);
    return () => sessionScreenFocusListeners.delete(listener);
}

export const flashListChatListHarnessState: FlashListChatListHarnessState = {
    flashListProps: null,
    flashListRefHandle: {
        scrollToOffset: () => {},
        scrollToIndex: () => {},
    },
    flashListRenderCount: 0,
    legendListProps: null,
    legendListPropsHistory: [],
    legendListRefHandle: null,
    platformOs: 'web',
    sessionScreenIsFocused: true,
    sessionMessagesState: { messages: [], isLoaded: true },
    sessionPendingState: { messages: [], discarded: [], isLoaded: true },
    sessionActionDraftsState: [],
    sessionState: null,
    settingValues: {},
    syncTuningState: loadSyncTuning(),
    activeServerAccountScope: null,
};

function createFlashListChatListMessagesSnapshot() {
    const sessionId = String(flashListChatListHarnessState.sessionState?.id ?? 'session-1');
    const messagesById = Object.fromEntries(
        (flashListChatListHarnessState.sessionMessagesState.messages ?? []).map((message: any) => [message.id, message]),
    );

    return {
        profileScope: flashListChatListHarnessState.activeServerAccountScope,
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
    flashListChatListHarnessState.flashListRenderCount = 0;
    flashListChatListHarnessState.legendListProps = null;
    flashListChatListHarnessState.legendListPropsHistory = [];
    flashListChatListHarnessState.legendListRefHandle = null;
    flashListChatListHarnessState.platformOs = options.platformOs ?? 'web';
    flashListChatListHarnessState.sessionScreenIsFocused = true;
    flashListChatListHarnessState.sessionMessagesState = { messages: [], isLoaded: true };
    flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
    flashListChatListHarnessState.sessionActionDraftsState = [];
    flashListChatListHarnessState.activeServerAccountScope = null;
    flashListChatListHarnessState.sessionState = {
        id: 'session-1',
        seq: 0,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
        agentState: null,
    };
    flashListChatListHarnessState.syncTuningState = {
        ...loadSyncTuning(),
        transcriptForwardPrefetchThresholdPx: 0,
        transcriptBackwardPrefetchThresholdPx: 0,
        transcriptFlashListEstimatedItemSize: 120,
        transcriptWebHotTailItemCount: 2,
        // The native hot/cold carve ships DEFAULT-ON (syncTuning default 4), which replaces the
        // flag=0 inverted "zero-writes" design with an authoritative force-pin. Pin it OFF in the
        // harness BASE so the flag=0-invariant inverted tests (write-free streaming, older-pagination,
        // anchored-entry) stay deterministic; carve behavior is covered by explicit flag>0 tests +
        // segments/webHotColdSplit/TranscriptHotTail. Tests opt into the carve via syncTuningState.
        transcriptNativeHotTailItemCount: 0,
        transcriptWebInitialPinStabilizeMs: 3000,
        transcriptWebInitialPinRetryIntervalMs: 250,
        // The ChatList harness suites are the FlashList regression lane. The production
        // web-main default is now the Legend renderer; pin the FlashList escape hatch so
        // these suites keep exercising the FlashList path deterministically. Legend-path
        // suites opt in via syncTuningState overrides ('off' or a surface value).
        transcriptLegendListSpikeSurface: 'flashList',
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

export function resetLegendChatListHarness(
    options: Parameters<typeof resetFlashListChatListHarness>[0] = {},
): void {
    resetFlashListChatListHarness({
        ...options,
        syncTuningState: {
            ...options.syncTuningState,
            transcriptLegendListSpikeSurface: 'off',
        },
    });
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

function resolveFlashListChatListInitialStateValue<T>(initialState: FlashListLayoutStateInitialValue<T>): T {
    return typeof initialState === 'function'
        ? (initialState as () => T)()
        : initialState;
}

function useFlashListChatListLayoutState<T>(
    initialState: FlashListLayoutStateInitialValue<T>,
): [T, FlashListLayoutStateSetter<T>] {
    const [state, setState] = React.useState<T>(() => resolveFlashListChatListInitialStateValue(initialState));
    const setLayoutState = React.useCallback<FlashListLayoutStateSetter<T>>((newValue) => {
        setState((previousValue) => (
            typeof newValue === 'function'
                ? (newValue as (previousValue: T) => T)(previousValue)
                : newValue
        ));
    }, []);

    return [state, setLayoutState];
}

function useFlashListChatListRecyclingState<T>(
    initialState: FlashListLayoutStateInitialValue<T>,
    deps: React.DependencyList,
    onReset?: () => void,
): [T, FlashListLayoutStateSetter<T>] {
    const valueRef = React.useRef<T>(resolveFlashListChatListInitialStateValue(initialState));
    const [, setCounter] = useFlashListChatListLayoutState(0);

    React.useMemo(() => {
        valueRef.current = resolveFlashListChatListInitialStateValue(initialState);
        onReset?.();
    }, deps);

    const setRecyclingState = React.useCallback<FlashListLayoutStateSetter<T>>((newValue) => {
        const nextValue = typeof newValue === 'function'
            ? (newValue as (previousValue: T) => T)(valueRef.current)
            : newValue;

        if (Object.is(nextValue, valueRef.current)) return;
        valueRef.current = nextValue;
        setCounter((previousValue) => previousValue + 1, true);
    }, [setCounter]);

    return [valueRef.current, setRecyclingState];
}

function useFlashListChatListMappingHelper() {
    return React.useMemo(() => ({
        getMappingKey: (_itemKey: FlashListMappingKey, index: number) => index,
    }), []);
}

const FlashListChatListLayoutCommitObserver = React.memo(function FlashListChatListLayoutCommitObserver(
    props: Readonly<{ children: React.ReactNode; onCommitLayoutEffect?: () => void }>,
) {
    React.useLayoutEffect(() => {
        props.onCommitLayoutEffect?.();
    });

    return React.createElement(React.Fragment, null, props.children);
});

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
            flashListChatListHarnessState.flashListRenderCount += 1;
            const element = (flashListMock.module.FlashList as any).render?.(props, ref)
                ?? React.createElement(flashListMock.module.FlashList as any, { ...props, ref });
            flashListChatListHarnessState.flashListProps = flashListMock.state.props;
            return element;
        }),
        LayoutCommitObserver: FlashListChatListLayoutCommitObserver,
        useLayoutState: useFlashListChatListLayoutState,
        useMappingHelper: useFlashListChatListMappingHelper,
        useRecyclingState: useFlashListChatListRecyclingState,
    };
}

export function createLegendChatListModuleMock(
    options: Readonly<{ renderItems?: boolean }> = {},
) {
    const legendListMock = createCapturingLegendListMock({ renderItems: options.renderItems });
    const LegendList = React.forwardRef<any, any>((props, ref) => {
        const element = (legendListMock.module.LegendList as any).render?.(props, ref)
            ?? React.createElement(legendListMock.module.LegendList as any, { ...props, ref });
        flashListChatListHarnessState.legendListProps = legendListMock.state.props;
        flashListChatListHarnessState.legendListPropsHistory.push(legendListMock.state.props);
        flashListChatListHarnessState.legendListRefHandle = legendListMock.state.refHandle;
        return element;
    });
    return { LegendList };
}

export function requireCapturedLegendListProps(): any {
    const props = flashListChatListHarnessState.legendListProps;
    if (!props) throw new Error('Expected the Legend-primary ChatList harness to capture Legend props');
    return props;
}

export async function createFlashListChatListReactNativeMock(
    options: Readonly<{
        overrides?: Record<string, unknown>;
        platformOs?: 'web' | 'ios';
        trackFlashListRender?: () => void;
    }> = {},
) {
    if (options.platformOs) {
        flashListChatListHarnessState.platformOs = options.platformOs;
    }
    const platform = {
        get OS() {
            return flashListChatListHarnessState.platformOs;
        },
        select: (values: Record<string, unknown>) => {
            const platformOs = flashListChatListHarnessState.platformOs;
            return values?.[platformOs] ?? values?.default;
        },
    };

    return createReactNativeWebMock({
        Platform: platform,
        View: (props: any) => React.createElement('View', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        ActivityIndicator: () => React.createElement('ActivityIndicator'),
        FlatList: () => {
            options.trackFlashListRender?.();
            return React.createElement('FlatList');
        },
        ...(options.overrides ?? {}),
    });
}

export async function createFlashListChatListStorageMock(
    importOriginal: <T>() => Promise<T>,
    overrides: Partial<typeof import('@/sync/domains/state/storage')> = {},
) {
    const readMessages = () => flashListChatListHarnessState.sessionMessagesState.messages ?? [];
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
            storage: createStorageStoreMock(createFlashListChatListMessagesSnapshot()),
            useSession: () => flashListChatListHarnessState.sessionState,
            useSessionTranscriptIds: () => {
                return {
                    ids: readMessageIds(),
                    isLoaded: flashListChatListHarnessState.sessionMessagesState.isLoaded,
                    hasRetainedContent: false,
                };
            },
            useSessionMessagesById: () => readMessagesById(),
            useSessionMessagesReducerState: () => createReducer(),
            useSessionForkSupportSource: () => null,
            useSessionWorkspacePath: () => null,
            useForkedTranscriptSnapshot: () => null,
            useSessionPendingMessages: () => flashListChatListHarnessState.sessionPendingState,
            useSessionActionDrafts: () => flashListChatListHarnessState.sessionActionDraftsState,
            useSessionLatestThinkingMessageId: () => null,
            useSessionLatestThinkingMessageActivityAtMs: () => null,
            useMessage: (_sessionId: string, messageId: string) =>
                readMessages().find((message: any) => message.id === messageId) ?? null,
            useSetting: (key: string) => flashListChatListHarnessState.settingValues[key],
            getStorage: () => createStorageStoreMock(createFlashListChatListMessagesSnapshot()),
            ...overrides,
        },
    });
}

export async function createFlashListChatListStorageStoreMock(
    importOriginal: <T>() => Promise<T>,
    overrides: Partial<typeof import('@/sync/domains/state/storageStore')> = {},
) {
    return createStorageStoreModuleMock({
        importOriginal,
        overrides: {
            getStorage: () => createStorageStoreMock(createFlashListChatListMessagesSnapshot()),
            ...overrides,
        },
    });
}

export function createFlashListChatListSyncModuleMock(
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
        const thresholdPx = flashListChatListHarnessState.syncTuningState.transcriptForwardPrefetchThresholdPx;
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
            getSyncTuning: () => flashListChatListHarnessState.syncTuningState,
            // Stable identity: ChatList consumes this through useSyncExternalStore.
            getSessionTargetWindowState: () => inactiveSessionMessagesWindowState,
            subscribeSessionTargetWindowState: () => () => undefined,
            markSessionLiveTailIntent: () => undefined,
            maybeDrainDeferredNewerMessages,
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

export async function triggerFlashListChatListLoad(
    elapsedTimeInMs = 0,
    flushOptions: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedFlashListProps = requireCapturedFlashListProps();
    await act(async () => {
        capturedFlashListProps.onLoad?.({ elapsedTimeInMs });
    });
    await flushHookEffects(flushOptions);
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

export async function triggerFlashListChatListEndReached(
    flushOptions: FlushHookEffectsOptions = {},
): Promise<void> {
    const capturedFlashListProps = requireCapturedFlashListProps();
    await act(async () => {
        await capturedFlashListProps.onEndReached?.();
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
        ...createFlashListChatListWebDocument(scrollerElement),
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

export async function renderFlashListChatListSession(
    options: Parameters<typeof renderScreen>[1] = {},
): Promise<FlashListChatListHarness> {
    const { ChatList } = await import('@/components/sessions/transcript/ChatList');
    return renderFlashListChatList(
        React.createElement(ChatList, {
            session: { ...flashListChatListHarnessState.sessionState },
        }),
        options,
    );
}

export type FlashListChatListHarness = ChatListHarness & Readonly<{
    getCapturedFlashListProps: typeof getCapturedFlashListProps;
    requireCapturedFlashListProps: typeof requireCapturedFlashListProps;
    triggerContentSizeChange: typeof triggerFlashListChatListContentSizeChange;
    triggerInitialFill: typeof triggerFlashListChatListInitialFill;
    triggerLoad: typeof triggerFlashListChatListLoad;
	triggerPointerDown: typeof triggerFlashListChatListPointerDown;
	triggerScroll: typeof triggerFlashListChatListScroll;
	triggerEndReached: typeof triggerFlashListChatListEndReached;
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
        triggerLoad: triggerFlashListChatListLoad,
        triggerPointerDown: triggerFlashListChatListPointerDown,
        triggerScroll: triggerFlashListChatListScroll,
        triggerEndReached: triggerFlashListChatListEndReached,
        triggerStartReached: triggerFlashListChatListStartReached,
    };
}
