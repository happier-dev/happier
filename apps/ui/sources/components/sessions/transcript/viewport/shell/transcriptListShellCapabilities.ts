import {
    TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
    TRANSCRIPT_WEB_SCROLL_EVENT_THROTTLE_MS,
} from '@/components/sessions/transcript/_constants';

export type TranscriptListShellRenderer = 'legendList';
export type TranscriptListShellDataOrder = 'oldest-first' | 'newest-first';
export type TranscriptListShellKeyboardDismissMode = 'none';
export type TranscriptListShellKeyboardShouldPersistTaps = 'handled';
export type TranscriptListShellRendererOptions = Readonly<{
    browserScrollAnchoring: 'disabled' | 'native';
    continuousFollow: Readonly<{ endThresholdRatio: number }>;
    identity: Readonly<{ nativeID?: string; testID?: string }>;
    initialPlacement: Readonly<{ atEnd: boolean }>;
    interaction: Readonly<{
        keyboardDismissMode: TranscriptListShellKeyboardDismissMode;
        keyboardShouldPersistTaps: TranscriptListShellKeyboardShouldPersistTaps;
        scrollEventThrottle: number;
    }>;
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
    kind: 'readOnly';
    /** A shared transcript is served page by page, so it walks older pages like any other. */
    olderPagination: true;
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
    platform: 'native' | 'web';
    renderer: TranscriptListShellRenderer;
    rendererOptions: TranscriptListShellRendererOptions;
}>;

const TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT = 0.1;
const TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE = 'none' as const;
const TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS = 'handled' as const;
const TRANSCRIPT_MAIN_LIST_TEST_ID = 'transcript-chat-list' as const;

function resolveLegendMaintainScrollAtEndThreshold(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT;
}

export function resolveMainTranscriptListShellFrame(params: Readonly<{
    legendInitialScrollAtEnd?: boolean;
    maintainScrollAtEndThreshold?: number;
    nativeID?: string;
    platformOS: string;
}>): TranscriptListShellFrame {
    const isNative = params.platformOS !== 'web';
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
        dataOrder: isNative ? 'newest-first' : 'oldest-first',
        platform: isNative ? 'native' : 'web',
        renderer: 'legendList',
        rendererOptions: {
            browserScrollAnchoring: isNative ? 'native' : 'disabled',
            continuousFollow: {
                endThresholdRatio: resolveLegendMaintainScrollAtEndThreshold(
                    params.maintainScrollAtEndThreshold,
                ),
            },
            identity: {
                nativeID: params.nativeID,
                testID: TRANSCRIPT_MAIN_LIST_TEST_ID,
            },
            initialPlacement: { atEnd: params.legendInitialScrollAtEnd !== false },
            interaction: {
                keyboardDismissMode: TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE,
                keyboardShouldPersistTaps: TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS,
                scrollEventThrottle:
                    params.platformOS === 'web'
                        ? TRANSCRIPT_WEB_SCROLL_EVENT_THROTTLE_MS
                        : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
            },
        },
    };
}

export function resolveReadOnlyTranscriptListShellFrame(params: Readonly<{
    accessKind: 'public';
    bottomNoticeVisible: boolean;
    platformOS: string;
}>): TranscriptListShellFrame {
    const isNative = params.platformOS !== 'web';
    return {
        capability: {
            accessKind: params.accessKind,
            boundedHydration: { kind: 'readOnly' },
            bottomNoticeVisible: params.bottomNoticeVisible,
            canApprovePermissions: false,
            canSendMessages: false,
            catchUpIndicator: false,
            composerVisible: false,
            kind: 'readOnly',
            olderPagination: true,
            permissionDisabledReason: 'public',
            streamingFollow: undefined,
            toolNavigationDisabled: true,
        },
        dataOrder: isNative ? 'newest-first' : 'oldest-first',
        platform: isNative ? 'native' : 'web',
        renderer: 'legendList',
        rendererOptions: {
            browserScrollAnchoring: isNative ? 'native' : 'disabled',
            continuousFollow: {
                endThresholdRatio: TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT,
            },
            identity: {},
            initialPlacement: { atEnd: true },
            interaction: {
                keyboardDismissMode: TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE,
                keyboardShouldPersistTaps: TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS,
                scrollEventThrottle:
                    params.platformOS === 'web'
                        ? TRANSCRIPT_WEB_SCROLL_EVENT_THROTTLE_MS
                        : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
            },
        },
    };
}

export function resolveSidechainTranscriptListShellFrame(params: Readonly<{
    platformOS: string;
}>): TranscriptListShellFrame {
    const isNative = params.platformOS !== 'web';
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
        dataOrder: isNative ? 'newest-first' : 'oldest-first',
        platform: isNative ? 'native' : 'web',
        renderer: 'legendList',
        rendererOptions: {
            browserScrollAnchoring: isNative ? 'native' : 'disabled',
            continuousFollow: {
                endThresholdRatio: TRANSCRIPT_LEGEND_MAINTAIN_SCROLL_AT_END_THRESHOLD_DEFAULT,
            },
            identity: {},
            initialPlacement: { atEnd: true },
            interaction: {
                keyboardDismissMode: TRANSCRIPT_LIST_SHELL_KEYBOARD_DISMISS_MODE,
                keyboardShouldPersistTaps: TRANSCRIPT_LIST_SHELL_KEYBOARD_SHOULD_PERSIST_TAPS,
                scrollEventThrottle:
                    params.platformOS === 'web'
                        ? TRANSCRIPT_WEB_SCROLL_EVENT_THROTTLE_MS
                        : TRANSCRIPT_NATIVE_SCROLL_EVENT_THROTTLE_MS,
            },
        },
    };
}
