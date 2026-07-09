import {
    TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
    TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS,
} from '@/components/sessions/transcript/_constants';

export type TranscriptListShellRenderer = 'flashList';
export type TranscriptListShellDataOrder = 'oldest-first' | 'newest-first';
export type TranscriptListShellKeyboardDismissMode = 'none';
export type TranscriptListShellKeyboardShouldPersistTaps = 'handled';
export type TranscriptListShellFlashListMaintainVisibleContentPosition =
    | Readonly<{
        animateAutoScrollToBottom?: false;
        autoscrollToBottomThreshold?: number;
        startRenderingFromBottom: true;
    }>
    | Readonly<{
        autoscrollToTopThreshold?: number | null;
        minIndexForVisible: number;
    }>;

export type TranscriptListShellFlashListRendererOptions = Readonly<{
    /**
     * Web only: opt the scroll container out of browser-native scroll anchoring
     * (overflow-anchor) so the transcript viewport owners stay the sole anchor
     * authority. Without this, Chrome silently re-anchors scrollTop to a
     * mid-transcript node during FlashList window reallocation with large rows.
     */
    disableBrowserScrollAnchoring?: true;
    drawDistance?: number;
    inverted: boolean;
    keyboardDismissMode: TranscriptListShellKeyboardDismissMode;
    keyboardShouldPersistTaps: TranscriptListShellKeyboardShouldPersistTaps;
    maintainVisibleContentPosition?: TranscriptListShellFlashListMaintainVisibleContentPosition;
    nativeID?: string;
    pauseOffsetCorrection?: boolean;
    scrollEventThrottle: number;
    testID?: string;
}>;

export type TranscriptListShellLegendRendererOptions = Readonly<{
    maintainScrollAtEndThreshold: number;
}>;

type TranscriptListShellStreamingFollowCapability = Readonly<{
    boundedHydration?: never;
    streamingFollow: Readonly<{ kind: 'main' }>;
}>;

type TranscriptListShellBoundedHydrationCapability = Readonly<{
    boundedHydration: Readonly<{ kind: 'readOnly' | 'sidechain' }>;
    streamingFollow?: never;
}>;

type TranscriptListShellMainCapability = TranscriptListShellStreamingFollowCapability & Readonly<{
    catchUpIndicator: true;
    entryRestore: true;
    jumpToSeq: true;
    kind: 'main';
    olderPagination: true;
    selection: true;
}>;

type TranscriptListShellSidechainCapability = TranscriptListShellBoundedHydrationCapability & Readonly<{
    catchUpIndicator: true;
    composerVisible: false;
    initialBottomPin: true;
    jumpToMessage: true;
    kind: 'sidechain';
    localHeightChangeRestore: true;
    nativeOlderLoadEdgeRead: true;
    olderPagination: true;
    prependGrowthRestore: true;
    readOnlyForkContext: false;
    webOlderLoadObservation: true;
}>;

export type TranscriptListShellReadOnlyCapability = TranscriptListShellBoundedHydrationCapability & Readonly<{
    accessKind: 'public';
    bottomNoticeVisible: boolean;
    canApprovePermissions: false;
    canSendMessages: false;
    catchUpIndicator: false;
    composerVisible: false;
    flashListStartsFromBottom: true;
    kind: 'readOnly';
    permissionDisabledReason: 'public';
    toolNavigationDisabled: true;
}>;

export type TranscriptListShellCapability =
    | TranscriptListShellMainCapability
    | TranscriptListShellSidechainCapability
    | TranscriptListShellReadOnlyCapability;

export type TranscriptListShellFrame = Readonly<{
    capability:
        | TranscriptListShellMainCapability
        | TranscriptListShellSidechainCapability
        | TranscriptListShellReadOnlyCapability;
    dataOrder: TranscriptListShellDataOrder;
    renderer: 'flashList';
    rendererOptions: Readonly<{
        flashList: TranscriptListShellFlashListRendererOptions;
        legend: TranscriptListShellLegendRendererOptions;
    }>;
}>;

const TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MIN_PX = 600;
const TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MAX_PX = 1200;
const TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT = 0.1;
const TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE = 'none' as const;
const TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS = 'handled' as const;
const TRANSCRIPT_MAIN_LIST_TEST_ID = 'transcript-chat-list' as const;

function resolveNativeTranscriptListShellDrawDistance(params: Readonly<{
    configuredDrawDistance?: unknown;
    listLayoutHeight?: number;
}>): number {
    const configured = params.configuredDrawDistance;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
        return Math.trunc(configured);
    }

    return Math.min(
        TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MAX_PX,
        Math.max(
            TRANSCRIPT_NATIVE_DRAW_DISTANCE_DEFAULT_MIN_PX,
            Math.ceil(Number.isFinite(params.listLayoutHeight) ? (params.listLayoutHeight ?? 0) : 0),
        ),
    );
}

function resolveLegendMaintainScrollAtEndThreshold(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT;
}

export function resolveMainTranscriptListShellFrame(params: Readonly<{
    configuredDrawDistance?: unknown;
    listLayoutHeight?: number;
    maintainScrollAtEndThreshold?: number;
    maintainVisibleContentPosition?: TranscriptListShellFlashListMaintainVisibleContentPosition;
    nativeID?: string;
    pauseOffsetCorrection?: boolean;
    platformOS: string;
}>): TranscriptListShellFrame {
    const nativeFlashList = params.platformOS !== 'web';
    return {
        capability: {
            catchUpIndicator: true,
            entryRestore: true,
            kind: 'main',
            jumpToSeq: true,
            olderPagination: true,
            selection: true,
            streamingFollow: { kind: 'main' },
        },
        dataOrder: nativeFlashList ? 'newest-first' : 'oldest-first',
        renderer: 'flashList',
        rendererOptions: {
            flashList: {
                disableBrowserScrollAnchoring: nativeFlashList ? undefined : true,
                drawDistance: nativeFlashList
                    ? resolveNativeTranscriptListShellDrawDistance({
                        configuredDrawDistance: params.configuredDrawDistance,
                        listLayoutHeight: params.listLayoutHeight,
                    })
                    : undefined,
                inverted: nativeFlashList,
                keyboardDismissMode: TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE,
                keyboardShouldPersistTaps: TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS,
                maintainVisibleContentPosition: params.maintainVisibleContentPosition,
                nativeID: params.nativeID,
                pauseOffsetCorrection: params.pauseOffsetCorrection === true ? true : undefined,
                scrollEventThrottle:
                    params.platformOS === 'web'
                        ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                        : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
                testID: TRANSCRIPT_MAIN_LIST_TEST_ID,
            },
            legend: {
                maintainScrollAtEndThreshold: resolveLegendMaintainScrollAtEndThreshold(
                    params.maintainScrollAtEndThreshold,
                ),
            },
        },
    };
}

export function resolveReadOnlyTranscriptListShellFrame(params: Readonly<{
    accessKind: 'public';
    bottomNoticeVisible: boolean;
    platformOS: string;
}>): TranscriptListShellFrame {
    const nativeFlashList = params.platformOS !== 'web';
    return {
        capability: {
            accessKind: params.accessKind,
            boundedHydration: { kind: 'readOnly' },
            bottomNoticeVisible: params.bottomNoticeVisible,
            canApprovePermissions: false,
            canSendMessages: false,
            catchUpIndicator: false,
            composerVisible: false,
            flashListStartsFromBottom: true,
            kind: 'readOnly',
            permissionDisabledReason: 'public',
            streamingFollow: undefined,
            toolNavigationDisabled: true,
        },
        dataOrder: nativeFlashList ? 'newest-first' : 'oldest-first',
        renderer: 'flashList',
        rendererOptions: {
            flashList: {
                disableBrowserScrollAnchoring: nativeFlashList ? undefined : true,
                inverted: nativeFlashList,
                keyboardDismissMode: TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE,
                keyboardShouldPersistTaps: TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS,
                maintainVisibleContentPosition: { startRenderingFromBottom: true },
                scrollEventThrottle:
                    params.platformOS === 'web'
                        ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                        : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
            },
            legend: {
                maintainScrollAtEndThreshold: TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT,
            },
        },
    };
}

export function resolveSidechainTranscriptListShellFrame(params: Readonly<{
    platformOS: string;
}>): TranscriptListShellFrame {
    const nativeFlashList = params.platformOS !== 'web';
    return {
        capability: {
            boundedHydration: { kind: 'sidechain' },
            catchUpIndicator: true,
            composerVisible: false,
            initialBottomPin: true,
            jumpToMessage: true,
            kind: 'sidechain',
            localHeightChangeRestore: true,
            nativeOlderLoadEdgeRead: true,
            olderPagination: true,
            prependGrowthRestore: true,
            readOnlyForkContext: false,
            streamingFollow: undefined,
            webOlderLoadObservation: true,
        },
        dataOrder: nativeFlashList ? 'newest-first' : 'oldest-first',
        renderer: 'flashList',
        rendererOptions: {
            flashList: {
                disableBrowserScrollAnchoring: nativeFlashList ? undefined : true,
                inverted: nativeFlashList,
                keyboardDismissMode: TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE,
                keyboardShouldPersistTaps: TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS,
                scrollEventThrottle:
                    params.platformOS === 'web'
                        ? TRANSCRIPT_WEB_FLASH_LIST_SCROLL_EVENT_THROTTLE_MS
                        : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
            },
            legend: {
                maintainScrollAtEndThreshold: TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT,
            },
        },
    };
}
