import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';

/**
 * The imperative scroll surface the transcript command writer drives — the subset of the FlashList/FlatList
 * handle the viewport command executor relies on. Optional members reflect methods only some list
 * implementations expose (guarded with `typeof node.x === 'function'` at the call sites).
 */
export type ScrollableChatListRef = Readonly<{
    transcriptViewportCommandSpace?: 'native-inverted' | 'standard';
    scrollToIndex: (params: { index: number; animated?: boolean; viewOffset?: number; viewPosition?: number }) => void;
    scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
    scrollToEnd?: (params?: { animated?: boolean }) => void;
    clearLayoutCacheOnUpdate?: () => void;
    computeVisibleIndices?: () => { startIndex: number; endIndex: number };
    getAbsoluteLastScrollOffset?: () => number;
    getFirstVisibleIndex?: () => number;
    getLayout?: (index: number) => { x: number; y: number; width: number; height: number } | undefined;
}>;

/**
 * The last native index-targeted restore write the command executor issued — retained so the native
 * `onScrollToIndexFailed` fallback can re-target the same restore intent.
 */
export type LastNativeRestoreIndexCommand = Readonly<{
    index: number;
    issuedAtMs: number;
    reason: TranscriptViewportTelemetryScrollReason;
    sessionId: string;
    viewOffset?: number;
}>;
