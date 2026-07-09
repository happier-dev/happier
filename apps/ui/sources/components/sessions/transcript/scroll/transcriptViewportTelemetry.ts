import type {
    TranscriptViewportMode,
    TranscriptViewportOwner,
    TranscriptViewportPlatform,
    TranscriptViewportScrollReason,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

export type { TranscriptViewportMode };
export type TranscriptViewportTelemetryPlatform = TranscriptViewportPlatform;
export type TranscriptViewportTelemetryListImplementation = 'flash_v2' | 'flatlist_legacy' | 'web-fallback';
export type TranscriptViewportTelemetryOwner = TranscriptViewportOwner;

export type TranscriptViewportTelemetryScrollWriter =
    | 'web-dom-bottom'
    | 'web-dom-restore'
    | 'web-scroll-to-index'
    | 'native-scroll-to-offset'
    | 'native-scroll-to-index'
    | 'native-explicit-jump'
    | 'mvcp-skip';

export type TranscriptViewportTelemetrySchedulerAuthorityWriter =
    | TranscriptViewportTelemetryScrollWriter
    | 'automatic-live-tail'
    | 'blank-recovery'
    | 'content-growth'
    | 'deferred-post-scroll'
    | 'hot-tail-carve'
    | 'passive-drift'
    | 'proactive-auto-follow'
    | 'settle-reconfirm'
    | 'web-passive-correction';

export type TranscriptViewportTelemetryScrollReason = TranscriptViewportScrollReason;

export type TranscriptViewportTelemetryObservationReason =
    | TranscriptViewportTelemetryScrollReason
    | 'observed'
    | 'pending'
    | 'restored'
    | 'skipped'
    | 'not-ready'
    | 'missing-anchor'
    | 'invalid-native-offset'
    | 'passive-drift'
    | 'mvcp-preserved'
    | 'fallback-restored'
    | 'abandoned-layout-timeout'
    | 'abandoned-identity'
    | 'abandoned-user-scroll'
    | 'entry-anchor-missing'
    | 'entry-distance-oneshot'
    | 'forward-newer-triggered'
    | 'forward-newer-skipped'
    | 'forward-newer-drained'
    | 'anchor-captured'
    | 'anchor-capture-empty'
    | 'anchor-capture-dropped';

/** N1.1 — FlashList offset-corrector lifecycle, mirrored from the patched vendor hook. */
export type TranscriptViewportTelemetryOffsetCorrectionAction =
    | 'pause-set'
    | 'pause-cleared'
    | 'correction-applied'
    | 'correction-skipped-paused'
    | 'correction-skipped-animation'
    | 'correction-skipped-happier-paused';

export type TranscriptViewportTelemetryOffsetCorrectionSource =
    | 'scroll-to-index'
    | 'initial-scroll-index';

/** N1.2/N1.3 — closed row-kind set (mirrors resolveTranscriptRowItemType outputs; no free-form text). */
export type TranscriptViewportTelemetryRowKind =
    | 'message:agent'
    | 'message:user'
    | 'message:thinking'
    | 'message:tool'
    | 'tool-group'
    | 'tool-group-header'
    | 'tool-group-expand'
    | 'tool-group-tool'
    | 'tool-group-footer'
    | 'pending-action'
    | 'fork-divider'
    | 'turn:tool'
    | 'turn:thinking'
    | 'turn:text';

export type TranscriptViewportTelemetryRowMeasurePhase = 'first' | 'remeasure';

export type TranscriptViewportTelemetryRowViewportRelation = 'above' | 'inside' | 'below' | 'unknown';

export type TranscriptViewportTelemetryListOrientation = 'standard' | 'inverted';

export type TranscriptViewportTelemetryBottomFollowMode = 'following' | 'escaping' | 'released';

export type TranscriptViewportTelemetryMvcpPolicy =
    | 'none'
    | 'disabled'
    | 'default'
    | 'start-rendering-from-bottom'
    | 'autoscroll-threshold';

export type TranscriptViewportTelemetryVisibleWindowSource =
    | 'ref-compute'
    | 'ref-first-index'
    | 'native-hot-edge-slot'
    | 'viewability-callback'
    | 'none';

export type TranscriptViewportTelemetryBlankAreaSource =
    | 'none'
    | 'index-estimate'
    | 'native-blank-area';

export type TranscriptViewportTelemetryNativeBlankWindowSignature =
    | 'empty-visible-window';

export type TranscriptViewportTelemetryVisibleRangeReadStatus =
    | 'ok'
    | 'null'
    | 'threw'
    | 'reversed'
    | 'out-of-range';

export type TranscriptViewportTelemetryTransactionState =
    | 'none'
    | 'open'
    | 'closed';

export type TranscriptViewportTelemetryLayoutCacheClearState =
    | 'idle'
    | 'requested'
    | 'cleared';

export type TranscriptViewportTelemetryLayoutCacheClearReason =
    | 'none'
    | 'row-layout-mutation'
    | 'session-reset'
    | 'transaction-open';

export type TranscriptViewportTelemetryScrollToIndexFailureState =
    | 'none'
    | 'failed';

/**
 * §12 native live-tail carve — why the anchor that opened the edge-slot carve engaged.
 * `turn-floor` = the whole-turn gate (`session.thinking`) held the carve across a transition
 * frame where no single row was detectably mid-stream (thinking→answer / text→tool).
 */
export type TranscriptViewportTelemetryLiveTailAnchorKind =
    | 'streaming-message'
    | 'streaming-tool'
    | 'thinking'
    | 'turn-floor';

/**
 * §12 native live-tail carve pin diagnostics (review R9). The device-QA proof surface for the
 * deterministic pin height (#2) and the single pin owner (#3): each carve pin records the
 * just-measured hot-tail height it compensated for, the anchor that opened the carve, whether the
 * live region owns the bottom, and whether the JS pin was issued or skipped. Correlate against the
 * `mvcpPolicy` field (`start-rendering-from-bottom` = threshold withheld) and `offset-correction`
 * events to PROVE FlashList MVCP is not fighting the JS pin while the live region is active.
 */
export type TranscriptViewportTelemetryLiveTailCarveDiagnostics = Readonly<{
    liveRegionActive?: boolean;
    nativeHotTailHeightPx?: number;
    liveTailAnchorId?: string;
    liveTailAnchorKind?: TranscriptViewportTelemetryLiveTailAnchorKind;
    nativeCarvePinIssued?: boolean;
}>;

export type TranscriptViewportTelemetryWebTrigger = 'scroll' | 'edge-reached' | 'restore' | 'prepend-restore' | 'jump';

export type TranscriptViewportTelemetryPaginationPhase = 'idle' | 'armed' | 'loading' | 'cooldown';

export type TranscriptViewportTelemetryPaginationSuspendReason =
    | 'negative-offset'
    | 'transaction-open'
    | 'fill-not-done';

export type TranscriptViewportTelemetryWebPrependAnchorKind = 'stable' | 'item' | 'none';

type TranscriptViewportTelemetryNativeDiagnostics = Readonly<{
    orientation?: TranscriptViewportTelemetryListOrientation;
    rawOffsetY?: number;
    canonicalOffsetY?: number;
    bottomFollowMode?: TranscriptViewportTelemetryBottomFollowMode;
    dragSessionTrusted?: boolean;
    nativeMomentumActive?: boolean;
    mvcpPolicy?: TranscriptViewportTelemetryMvcpPolicy;
    pauseOffsetCorrection?: boolean;
    isAtRawBottom?: boolean;
    hasVisibleRows?: boolean;
    firstVisibleItemId?: string;
    lastVisibleItemId?: string;
    firstVisibleSourceIndex?: number;
    lastVisibleSourceIndex?: number;
    visibleWindowStale?: boolean;
    lastKnownFirstVisibleItemId?: string;
    lastKnownLastVisibleItemId?: string;
    blankAreaPx?: number;
    visibleWindowSource?: TranscriptViewportTelemetryVisibleWindowSource;
    blankAreaSource?: TranscriptViewportTelemetryBlankAreaSource;
    nativeBlankWindowSignature?: TranscriptViewportTelemetryNativeBlankWindowSignature;
    listDataLength?: number;
    fullItemCount?: number;
    visibleRangeReadStatus?: TranscriptViewportTelemetryVisibleRangeReadStatus;
    visibleRenderedStartIndex?: number;
    visibleRenderedEndIndex?: number;
    firstVisibleRenderedIndex?: number;
    eventContentHeight?: number;
    eventLayoutHeight?: number;
    refContentHeight?: number;
    refLayoutHeight?: number;
    entryRestoreState?: TranscriptViewportTelemetryTransactionState;
    prependState?: TranscriptViewportTelemetryTransactionState;
    layoutCacheClearState?: TranscriptViewportTelemetryLayoutCacheClearState;
    layoutCacheClearReason?: TranscriptViewportTelemetryLayoutCacheClearReason;
    scrollToIndexFailureState?: TranscriptViewportTelemetryScrollToIndexFailureState;
}>;

type TranscriptViewportTelemetryWebDiagnostics = Readonly<{
    trigger?: TranscriptViewportTelemetryWebTrigger;
    domScrollTop?: number;
    domScrollHeight?: number;
    domClientHeight?: number;
    flashListContentHeight?: number;
    flashListLayoutHeight?: number;
    scrollable?: boolean;
    paginationPhase?: TranscriptViewportTelemetryPaginationPhase;
    paginationSuspendedReasons?: readonly TranscriptViewportTelemetryPaginationSuspendReason[];
    coldCount?: number;
    hotCount?: number;
    firstVisibleAnchorTestId?: string;
    pendingWebPrependAnchorKind?: TranscriptViewportTelemetryWebPrependAnchorKind;
    pendingWebPrependAnchorId?: string;
    pendingWebPrependAnchorIndex?: number;
    programmaticWebWrite?: boolean;
}>;

export type TranscriptViewportTelemetryEvent =
    | Readonly<({
        type: 'scroll-write';
        writer: TranscriptViewportTelemetryScrollWriter;
        reason: TranscriptViewportTelemetryScrollReason;
        sessionId: string;
        platform: TranscriptViewportTelemetryPlatform;
        listImplementation: TranscriptViewportTelemetryListImplementation;
        mode: TranscriptViewportMode;
        targetOffsetY?: number;
        previousOffsetY?: number;
        layoutHeight?: number;
        contentHeight?: number;
        distanceFromBottom?: number;
        nativeMountSettleStable?: boolean;
        orientation?: TranscriptViewportTelemetryListOrientation;
        rawOffsetY?: number;
        canonicalOffsetY?: number;
        bottomFollowMode?: TranscriptViewportTelemetryBottomFollowMode;
        dragSessionTrusted?: boolean;
        nativeMomentumActive?: boolean;
        mvcpPolicy?: TranscriptViewportTelemetryMvcpPolicy;
        pauseOffsetCorrection?: boolean;
        schedulerAuthorityWriter?: TranscriptViewportTelemetrySchedulerAuthorityWriter;
        schedulerAuthorityReason?: TranscriptViewportTelemetryScrollReason;
        isAtRawBottom?: boolean;
        hasVisibleRows?: boolean;
        firstVisibleItemId?: string;
        lastVisibleItemId?: string;
        firstVisibleSourceIndex?: number;
        lastVisibleSourceIndex?: number;
        visibleWindowStale?: boolean;
        lastKnownFirstVisibleItemId?: string;
        lastKnownLastVisibleItemId?: string;
        blankAreaPx?: number;
        visibleWindowSource?: TranscriptViewportTelemetryVisibleWindowSource;
        blankAreaSource?: TranscriptViewportTelemetryBlankAreaSource;
        nativeBlankWindowSignature?: TranscriptViewportTelemetryNativeBlankWindowSignature;
        listDataLength?: number;
        fullItemCount?: number;
        visibleRangeReadStatus?: TranscriptViewportTelemetryVisibleRangeReadStatus;
        visibleRenderedStartIndex?: number;
        visibleRenderedEndIndex?: number;
        firstVisibleRenderedIndex?: number;
        eventContentHeight?: number;
        eventLayoutHeight?: number;
        refContentHeight?: number;
        refLayoutHeight?: number;
        entryRestoreState?: TranscriptViewportTelemetryTransactionState;
        prependState?: TranscriptViewportTelemetryTransactionState;
        layoutCacheClearState?: TranscriptViewportTelemetryLayoutCacheClearState;
        layoutCacheClearReason?: TranscriptViewportTelemetryLayoutCacheClearReason;
        scrollToIndexFailureState?: TranscriptViewportTelemetryScrollToIndexFailureState;
        timestampMs: number;
    } & TranscriptViewportTelemetryWebDiagnostics & TranscriptViewportTelemetryLiveTailCarveDiagnostics)>
    | Readonly<({
        type: 'scroll-write-rejected';
        writer: TranscriptViewportTelemetryScrollWriter;
        reason: TranscriptViewportTelemetryScrollReason;
        rejectedOwner: TranscriptViewportTelemetryOwner;
        activeOwner: TranscriptViewportTelemetryOwner;
        sessionId: string;
        platform: TranscriptViewportTelemetryPlatform;
        listImplementation: TranscriptViewportTelemetryListImplementation;
        mode: TranscriptViewportMode;
        targetOffsetY?: number;
        previousOffsetY?: number;
        layoutHeight?: number;
        contentHeight?: number;
        distanceFromBottom?: number;
        nativeMountSettleStable?: boolean;
        orientation?: TranscriptViewportTelemetryListOrientation;
        rawOffsetY?: number;
        canonicalOffsetY?: number;
        bottomFollowMode?: TranscriptViewportTelemetryBottomFollowMode;
        dragSessionTrusted?: boolean;
        nativeMomentumActive?: boolean;
        mvcpPolicy?: TranscriptViewportTelemetryMvcpPolicy;
        pauseOffsetCorrection?: boolean;
        schedulerAuthorityWriter?: TranscriptViewportTelemetrySchedulerAuthorityWriter;
        schedulerAuthorityReason?: TranscriptViewportTelemetryScrollReason;
        isAtRawBottom?: boolean;
        hasVisibleRows?: boolean;
        firstVisibleItemId?: string;
        lastVisibleItemId?: string;
        firstVisibleSourceIndex?: number;
        lastVisibleSourceIndex?: number;
        visibleWindowStale?: boolean;
        lastKnownFirstVisibleItemId?: string;
        lastKnownLastVisibleItemId?: string;
        blankAreaPx?: number;
        visibleWindowSource?: TranscriptViewportTelemetryVisibleWindowSource;
        blankAreaSource?: TranscriptViewportTelemetryBlankAreaSource;
        nativeBlankWindowSignature?: TranscriptViewportTelemetryNativeBlankWindowSignature;
        listDataLength?: number;
        fullItemCount?: number;
        visibleRangeReadStatus?: TranscriptViewportTelemetryVisibleRangeReadStatus;
        visibleRenderedStartIndex?: number;
        visibleRenderedEndIndex?: number;
        firstVisibleRenderedIndex?: number;
        eventContentHeight?: number;
        eventLayoutHeight?: number;
        refContentHeight?: number;
        refLayoutHeight?: number;
        entryRestoreState?: TranscriptViewportTelemetryTransactionState;
        prependState?: TranscriptViewportTelemetryTransactionState;
        layoutCacheClearState?: TranscriptViewportTelemetryLayoutCacheClearState;
        layoutCacheClearReason?: TranscriptViewportTelemetryLayoutCacheClearReason;
        scrollToIndexFailureState?: TranscriptViewportTelemetryScrollToIndexFailureState;
        timestampMs: number;
    } & TranscriptViewportTelemetryWebDiagnostics & TranscriptViewportTelemetryLiveTailCarveDiagnostics)>
    | Readonly<({
        type:
            | 'restore-decision'
            | 'scroll-observed'
            | 'content-measured'
            | 'layout-measured'
            | 'anchor-capture'
            | 'offset-correction'
            | 'row-measured'
            | 'row-mutated'
            | 'visible-window-observed';
        sessionId: string;
        platform: TranscriptViewportTelemetryPlatform;
        listImplementation: TranscriptViewportTelemetryListImplementation;
        mode: TranscriptViewportMode;
        offsetY?: number;
        layoutHeight?: number;
        contentHeight?: number;
        distanceFromBottom?: number;
        anchorIndex?: number;
        anchorItemOffsetPx?: number;
        anchorObservedItemOffsetPx?: number;
        anchorDeltaPx?: number;
        anchorCorrectionAttempt?: number;
        anchorCorrectionTargetOffsetY?: number;
        anchorRestoreViewOffset?: number;
        correctionAction?: TranscriptViewportTelemetryOffsetCorrectionAction;
        correctionSource?: TranscriptViewportTelemetryOffsetCorrectionSource;
        correctionDiffPx?: number;
        /** N2d.1 prepend close diagnostics: corrector coverage over the transaction window. */
        correctorAppliedDiffTotalPx?: number;
        correctorEventCount?: number;
        rowId?: string;
        rowKind?: TranscriptViewportTelemetryRowKind;
        rowHeightPx?: number;
        rowPreviousHeightPx?: number;
        rowDeltaPx?: number;
        rowMeasurePhase?: TranscriptViewportTelemetryRowMeasurePhase;
        rowViewportRelation?: TranscriptViewportTelemetryRowViewportRelation;
        rowContentCount?: number;
        rowPreviousContentCount?: number;
        orientation?: TranscriptViewportTelemetryListOrientation;
        rawOffsetY?: number;
        canonicalOffsetY?: number;
        bottomFollowMode?: TranscriptViewportTelemetryBottomFollowMode;
        dragSessionTrusted?: boolean;
        nativeMomentumActive?: boolean;
        mvcpPolicy?: TranscriptViewportTelemetryMvcpPolicy;
        isAtRawBottom?: boolean;
        hasVisibleRows?: boolean;
        firstVisibleItemId?: string;
        lastVisibleItemId?: string;
        firstVisibleSourceIndex?: number;
        lastVisibleSourceIndex?: number;
        visibleWindowStale?: boolean;
        lastKnownFirstVisibleItemId?: string;
        lastKnownLastVisibleItemId?: string;
        blankAreaPx?: number;
        visibleWindowSource?: TranscriptViewportTelemetryVisibleWindowSource;
        blankAreaSource?: TranscriptViewportTelemetryBlankAreaSource;
        nativeBlankWindowSignature?: TranscriptViewportTelemetryNativeBlankWindowSignature;
        listDataLength?: number;
        fullItemCount?: number;
        visibleRangeReadStatus?: TranscriptViewportTelemetryVisibleRangeReadStatus;
        visibleRenderedStartIndex?: number;
        visibleRenderedEndIndex?: number;
        firstVisibleRenderedIndex?: number;
        eventContentHeight?: number;
        eventLayoutHeight?: number;
        refContentHeight?: number;
        refLayoutHeight?: number;
        entryRestoreState?: TranscriptViewportTelemetryTransactionState;
        prependState?: TranscriptViewportTelemetryTransactionState;
        layoutCacheClearState?: TranscriptViewportTelemetryLayoutCacheClearState;
        layoutCacheClearReason?: TranscriptViewportTelemetryLayoutCacheClearReason;
        scrollToIndexFailureState?: TranscriptViewportTelemetryScrollToIndexFailureState;
        reason?: TranscriptViewportTelemetryObservationReason;
        timestampMs: number;
    } & TranscriptViewportTelemetryWebDiagnostics & TranscriptViewportTelemetryLiveTailCarveDiagnostics)>;

export type TranscriptViewportTelemetrySnapshot = Readonly<{
    events: TranscriptViewportTelemetryEvent[];
    droppedCount: number;
}>;

type SanitizedTranscriptViewportTelemetryRecord = Readonly<{
    event: TranscriptViewportTelemetryEvent;
    rawSessionId: string;
}>;

type TranscriptViewportTelemetryOptions = Readonly<{
    capacity?: number;
    consoleLog?: boolean;
    enabled?: boolean;
    now?: () => number;
    sink?: ((event: TranscriptViewportTelemetryEvent) => void) | null;
}>;

type TranscriptViewportTelemetryDebugOverrideOptions = Readonly<{
    capacity?: unknown;
    consoleLog?: unknown;
    enabled?: unknown;
}>;

type InstallTranscriptViewportTelemetryGlobalOptions = Readonly<{
    isDev?: boolean;
}>;

export type TranscriptViewportTelemetryTuning = Readonly<{
    transcriptViewportTelemetryConsoleLog?: unknown;
    transcriptViewportTelemetryEnabled?: unknown;
    transcriptViewportTelemetryMaxEvents?: unknown;
}>;

const DEFAULT_TRANSCRIPT_VIEWPORT_TELEMETRY_CAPACITY = 512;
const TRANSCRIPT_VIEWPORT_TELEMETRY_GLOBAL_KEY = '__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__';
const TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE_GLOBAL_KEY = '__HAPPIER_TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE__';

const SCROLL_WRITERS = new Set<TranscriptViewportTelemetryScrollWriter>([
    'web-dom-bottom',
    'web-dom-restore',
    'web-scroll-to-index',
    'native-scroll-to-offset',
    'native-scroll-to-index',
    'native-explicit-jump',
    'mvcp-skip',
]);

const SCHEDULER_AUTHORITY_WRITERS = new Set<TranscriptViewportTelemetrySchedulerAuthorityWriter>([
    ...SCROLL_WRITERS,
    'automatic-live-tail',
    'blank-recovery',
    'content-growth',
    'deferred-post-scroll',
    'hot-tail-carve',
    'passive-drift',
    'proactive-auto-follow',
    'settle-reconfirm',
    'web-passive-correction',
]);

const SCROLL_REASONS = new Set<TranscriptViewportTelemetryScrollReason>([
    'initial-open',
    'content-size-change',
    'layout-change',
    'entry-restore',
    'prepend-restore',
    'jump-to-bottom',
    'jump-to-seq',
    'stream-append',
    'viewport-resized',
    'mount-settle',
    'passive-drift',
]);

const OBSERVATION_REASONS = new Set<TranscriptViewportTelemetryObservationReason>([
    ...SCROLL_REASONS,
    'observed',
    'pending',
    'restored',
    'skipped',
    'not-ready',
    'missing-anchor',
    'invalid-native-offset',
    'mvcp-preserved',
    'fallback-restored',
    'abandoned-layout-timeout',
    'abandoned-identity',
    'abandoned-user-scroll',
    'entry-anchor-missing',
    'entry-distance-oneshot',
    'forward-newer-triggered',
    'forward-newer-skipped',
    'forward-newer-drained',
    'anchor-captured',
    'anchor-capture-empty',
    'anchor-capture-dropped',
]);

const OFFSET_CORRECTION_ACTIONS = new Set<TranscriptViewportTelemetryOffsetCorrectionAction>([
    'pause-set',
    'pause-cleared',
    'correction-applied',
    'correction-skipped-paused',
    'correction-skipped-animation',
    'correction-skipped-happier-paused',
]);

const OFFSET_CORRECTION_SOURCES = new Set<TranscriptViewportTelemetryOffsetCorrectionSource>([
    'scroll-to-index',
    'initial-scroll-index',
]);

const ROW_KINDS = new Set<TranscriptViewportTelemetryRowKind>([
    'message:agent',
    'message:user',
    'message:thinking',
    'message:tool',
    'tool-group',
    'tool-group-header',
    'tool-group-expand',
    'tool-group-tool',
    'tool-group-footer',
    'pending-action',
    'fork-divider',
    'turn:tool',
    'turn:thinking',
    'turn:text',
]);

const ROW_MEASURE_PHASES = new Set<TranscriptViewportTelemetryRowMeasurePhase>([
    'first',
    'remeasure',
]);

const ROW_VIEWPORT_RELATIONS = new Set<TranscriptViewportTelemetryRowViewportRelation>([
    'above',
    'inside',
    'below',
    'unknown',
]);

const LIST_ORIENTATIONS = new Set<TranscriptViewportTelemetryListOrientation>([
    'standard',
    'inverted',
]);

const BOTTOM_FOLLOW_MODES = new Set<TranscriptViewportTelemetryBottomFollowMode>([
    'following',
    'escaping',
    'released',
]);

const MVCP_POLICIES = new Set<TranscriptViewportTelemetryMvcpPolicy>([
    'none',
    'disabled',
    'default',
    'start-rendering-from-bottom',
    'autoscroll-threshold',
]);

const VISIBLE_WINDOW_SOURCES = new Set<TranscriptViewportTelemetryVisibleWindowSource>([
    'ref-compute',
    'ref-first-index',
    'native-hot-edge-slot',
    'viewability-callback',
    'none',
]);

const BLANK_AREA_SOURCES = new Set<TranscriptViewportTelemetryBlankAreaSource>([
    'none',
    'index-estimate',
    'native-blank-area',
]);

const NATIVE_BLANK_WINDOW_SIGNATURES = new Set<TranscriptViewportTelemetryNativeBlankWindowSignature>([
    'empty-visible-window',
]);

const VISIBLE_RANGE_READ_STATUSES = new Set<TranscriptViewportTelemetryVisibleRangeReadStatus>([
    'ok',
    'null',
    'threw',
    'reversed',
    'out-of-range',
]);

const TRANSACTION_STATES = new Set<TranscriptViewportTelemetryTransactionState>([
    'none',
    'open',
    'closed',
]);

const LAYOUT_CACHE_CLEAR_STATES = new Set<TranscriptViewportTelemetryLayoutCacheClearState>([
    'idle',
    'requested',
    'cleared',
]);

const LAYOUT_CACHE_CLEAR_REASONS = new Set<TranscriptViewportTelemetryLayoutCacheClearReason>([
    'none',
    'row-layout-mutation',
    'session-reset',
    'transaction-open',
]);

const SCROLL_TO_INDEX_FAILURE_STATES = new Set<TranscriptViewportTelemetryScrollToIndexFailureState>([
    'none',
    'failed',
]);

const LIVE_TAIL_ANCHOR_KINDS = new Set<TranscriptViewportTelemetryLiveTailAnchorKind>([
    'streaming-message',
    'streaming-tool',
    'thinking',
    'turn-floor',
]);

const WEB_TRIGGERS = new Set<TranscriptViewportTelemetryWebTrigger>([
    'scroll',
    'edge-reached',
    'restore',
    'prepend-restore',
    'jump',
]);

const PAGINATION_PHASES = new Set<TranscriptViewportTelemetryPaginationPhase>([
    'idle',
    'armed',
    'loading',
    'cooldown',
]);

const PAGINATION_SUSPENDED_REASONS = new Set<TranscriptViewportTelemetryPaginationSuspendReason>([
    'negative-offset',
    'transaction-open',
    'fill-not-done',
]);

const WEB_PREPEND_ANCHOR_KINDS = new Set<TranscriptViewportTelemetryWebPrependAnchorKind>([
    'stable',
    'item',
    'none',
]);

const OWNERS = new Set<TranscriptViewportTelemetryOwner>([
    'entry',
    'prepend',
    'follow',
    'explicit',
    'idle',
]);

const PLATFORMS = new Set<TranscriptViewportTelemetryPlatform>([
    'web',
    'ios',
    'android',
    'native-other',
]);

const LIST_IMPLEMENTATIONS = new Set<TranscriptViewportTelemetryListImplementation>([
    'flash_v2',
    'flatlist_legacy',
    'web-fallback',
]);

const MODES = new Set<TranscriptViewportMode>([
    'hydrating',
    'follow-bottom',
    'restore-anchor',
    'restore-distance',
    'user-unpinned',
    'jump-to-bottom',
    'jump-to-seq',
]);

function defaultNow(): number {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    if (typeof perf?.now === 'function') {
        return perf.now();
    }
    return Date.now();
}

function readDevFlag(): boolean {
    return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

function normalizeCapacity(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(1, Math.min(100_000, Math.trunc(value)));
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readEnum<T extends string>(value: unknown, values: ReadonlySet<T>): T | null {
    const text = readString(value);
    return text && values.has(text as T) ? text as T : null;
}

function readEnumArray<T extends string>(value: unknown, values: ReadonlySet<T>): readonly T[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const result: T[] = [];
    for (const item of value) {
        const enumValue = readEnum(item, values);
        if (enumValue) result.push(enumValue);
    }
    return result;
}

function isInvalidScrollWriterTelemetryEvent(event: unknown): boolean {
    if (!event || typeof event !== 'object') return false;
    const source = event as Record<string, unknown>;
    if (source.type !== 'scroll-write' && source.type !== 'scroll-write-rejected') return false;
    if (!readString(source.writer) || readEnum(source.writer, SCROLL_WRITERS)) return false;
    if (
        !readString(source.sessionId) ||
        !readEnum(source.platform, PLATFORMS) ||
        !readEnum(source.listImplementation, LIST_IMPLEMENTATIONS) ||
        !readEnum(source.mode, MODES) ||
        !readEnum(source.reason, SCROLL_REASONS)
    ) {
        return false;
    }
    if (source.type === 'scroll-write-rejected') {
        return Boolean(readEnum(source.rejectedOwner, OWNERS) && readEnum(source.activeOwner, OWNERS));
    }
    return true;
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function spreadNumber<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
    return value === undefined ? {} : { [key]: value } as Record<K, number>;
}

function spreadBoolean<K extends string>(key: K, value: unknown): Partial<Record<K, boolean>> {
    return typeof value === 'boolean' ? { [key]: value } as Record<K, boolean> : {};
}

function readNativeDiagnostics(source: Record<string, unknown>): TranscriptViewportTelemetryNativeDiagnostics {
    const orientation = readEnum(source.orientation, LIST_ORIENTATIONS) ?? undefined;
    const bottomFollowMode = readEnum(source.bottomFollowMode, BOTTOM_FOLLOW_MODES) ?? undefined;
    const mvcpPolicy = readEnum(source.mvcpPolicy, MVCP_POLICIES) ?? undefined;
    const visibleWindowSource = readEnum(source.visibleWindowSource, VISIBLE_WINDOW_SOURCES) ?? undefined;
    const blankAreaSource = readEnum(source.blankAreaSource, BLANK_AREA_SOURCES) ?? undefined;
    const nativeBlankWindowSignature =
        readEnum(source.nativeBlankWindowSignature, NATIVE_BLANK_WINDOW_SIGNATURES) ?? undefined;
    const visibleRangeReadStatus =
        readEnum(source.visibleRangeReadStatus, VISIBLE_RANGE_READ_STATUSES) ?? undefined;
    const entryRestoreState = readEnum(source.entryRestoreState, TRANSACTION_STATES) ?? undefined;
    const prependState = readEnum(source.prependState, TRANSACTION_STATES) ?? undefined;
    const layoutCacheClearState =
        readEnum(source.layoutCacheClearState, LAYOUT_CACHE_CLEAR_STATES) ?? undefined;
    const layoutCacheClearReason =
        readEnum(source.layoutCacheClearReason, LAYOUT_CACHE_CLEAR_REASONS) ?? undefined;
    const scrollToIndexFailureState =
        readEnum(source.scrollToIndexFailureState, SCROLL_TO_INDEX_FAILURE_STATES) ?? undefined;
    const firstVisibleItemId = readString(source.firstVisibleItemId) ?? undefined;
    const lastVisibleItemId = readString(source.lastVisibleItemId) ?? undefined;
    const lastKnownFirstVisibleItemId = readString(source.lastKnownFirstVisibleItemId) ?? undefined;
    const lastKnownLastVisibleItemId = readString(source.lastKnownLastVisibleItemId) ?? undefined;
    return {
        ...(orientation ? { orientation } : {}),
        ...spreadNumber('rawOffsetY', readNumber(source.rawOffsetY)),
        ...spreadNumber('canonicalOffsetY', readNumber(source.canonicalOffsetY)),
        ...(bottomFollowMode ? { bottomFollowMode } : {}),
        ...spreadBoolean('dragSessionTrusted', source.dragSessionTrusted),
        ...spreadBoolean('nativeMomentumActive', source.nativeMomentumActive),
        ...(mvcpPolicy ? { mvcpPolicy } : {}),
        ...spreadBoolean('pauseOffsetCorrection', source.pauseOffsetCorrection),
        ...spreadBoolean('isAtRawBottom', source.isAtRawBottom),
        ...spreadBoolean('hasVisibleRows', source.hasVisibleRows),
        ...(firstVisibleItemId ? { firstVisibleItemId } : {}),
        ...(lastVisibleItemId ? { lastVisibleItemId } : {}),
        ...spreadNumber('firstVisibleSourceIndex', readNumber(source.firstVisibleSourceIndex)),
        ...spreadNumber('lastVisibleSourceIndex', readNumber(source.lastVisibleSourceIndex)),
        ...spreadBoolean('visibleWindowStale', source.visibleWindowStale),
        ...(lastKnownFirstVisibleItemId ? { lastKnownFirstVisibleItemId } : {}),
        ...(lastKnownLastVisibleItemId ? { lastKnownLastVisibleItemId } : {}),
        ...spreadNumber('blankAreaPx', readNumber(source.blankAreaPx)),
        ...(visibleWindowSource ? { visibleWindowSource } : {}),
        ...(blankAreaSource ? { blankAreaSource } : {}),
        ...(nativeBlankWindowSignature ? { nativeBlankWindowSignature } : {}),
        ...spreadNumber('listDataLength', readNumber(source.listDataLength)),
        ...spreadNumber('fullItemCount', readNumber(source.fullItemCount)),
        ...(visibleRangeReadStatus ? { visibleRangeReadStatus } : {}),
        ...spreadNumber('visibleRenderedStartIndex', readNumber(source.visibleRenderedStartIndex)),
        ...spreadNumber('visibleRenderedEndIndex', readNumber(source.visibleRenderedEndIndex)),
        ...spreadNumber('firstVisibleRenderedIndex', readNumber(source.firstVisibleRenderedIndex)),
        ...spreadNumber('eventContentHeight', readNumber(source.eventContentHeight)),
        ...spreadNumber('eventLayoutHeight', readNumber(source.eventLayoutHeight)),
        ...spreadNumber('refContentHeight', readNumber(source.refContentHeight)),
        ...spreadNumber('refLayoutHeight', readNumber(source.refLayoutHeight)),
        ...(entryRestoreState ? { entryRestoreState } : {}),
        ...(prependState ? { prependState } : {}),
        ...(layoutCacheClearState ? { layoutCacheClearState } : {}),
        ...(layoutCacheClearReason ? { layoutCacheClearReason } : {}),
        ...(scrollToIndexFailureState ? { scrollToIndexFailureState } : {}),
    };
}

function readLiveTailCarveDiagnostics(
    source: Record<string, unknown>,
): TranscriptViewportTelemetryLiveTailCarveDiagnostics {
    const liveTailAnchorId = readString(source.liveTailAnchorId) ?? undefined;
    const liveTailAnchorKind = readEnum(source.liveTailAnchorKind, LIVE_TAIL_ANCHOR_KINDS) ?? undefined;
    return {
        ...spreadBoolean('liveRegionActive', source.liveRegionActive),
        ...spreadNumber('nativeHotTailHeightPx', readNumber(source.nativeHotTailHeightPx)),
        ...(liveTailAnchorId ? { liveTailAnchorId } : {}),
        ...(liveTailAnchorKind ? { liveTailAnchorKind } : {}),
        ...spreadBoolean('nativeCarvePinIssued', source.nativeCarvePinIssued),
    };
}

function readWebDiagnostics(source: Record<string, unknown>): TranscriptViewportTelemetryWebDiagnostics {
    const trigger = readEnum(source.trigger, WEB_TRIGGERS) ?? undefined;
    const paginationPhase = readEnum(source.paginationPhase, PAGINATION_PHASES) ?? undefined;
    const paginationSuspendedReasons = readEnumArray(source.paginationSuspendedReasons, PAGINATION_SUSPENDED_REASONS);
    const firstVisibleAnchorTestId = readString(source.firstVisibleAnchorTestId) ?? undefined;
    const pendingWebPrependAnchorKind = readEnum(source.pendingWebPrependAnchorKind, WEB_PREPEND_ANCHOR_KINDS) ?? undefined;
    const pendingWebPrependAnchorId = readString(source.pendingWebPrependAnchorId) ?? undefined;
    return {
        ...(trigger ? { trigger } : {}),
        ...spreadNumber('domScrollTop', readNumber(source.domScrollTop)),
        ...spreadNumber('domScrollHeight', readNumber(source.domScrollHeight)),
        ...spreadNumber('domClientHeight', readNumber(source.domClientHeight)),
        ...spreadNumber('flashListContentHeight', readNumber(source.flashListContentHeight)),
        ...spreadNumber('flashListLayoutHeight', readNumber(source.flashListLayoutHeight)),
        ...spreadBoolean('scrollable', source.scrollable),
        ...(paginationPhase ? { paginationPhase } : {}),
        ...(paginationSuspendedReasons ? { paginationSuspendedReasons } : {}),
        ...spreadNumber('coldCount', readNumber(source.coldCount)),
        ...spreadNumber('hotCount', readNumber(source.hotCount)),
        ...(firstVisibleAnchorTestId ? { firstVisibleAnchorTestId } : {}),
        ...(pendingWebPrependAnchorKind ? { pendingWebPrependAnchorKind } : {}),
        ...(pendingWebPrependAnchorId ? { pendingWebPrependAnchorId } : {}),
        ...spreadNumber('pendingWebPrependAnchorIndex', readNumber(source.pendingWebPrependAnchorIndex)),
        ...spreadBoolean('programmaticWebWrite', source.programmaticWebWrite),
    };
}

function readTimestampMs(value: unknown, now: () => number): number {
    const timestamp = readNumber(value);
    return timestamp === undefined ? now() : timestamp;
}

function sanitizeTelemetryEvent(
    event: unknown,
    now: () => number,
    redactSessionId: (sessionId: string) => string,
): SanitizedTranscriptViewportTelemetryRecord | null {
    if (!event || typeof event !== 'object') return null;
    const source = event as Record<string, unknown>;
    const type = source.type;
    const rawSessionId = readString(source.sessionId);
    const platform = readEnum(source.platform, PLATFORMS);
    const listImplementation = readEnum(source.listImplementation, LIST_IMPLEMENTATIONS);
    const mode = readEnum(source.mode, MODES);
    if (!rawSessionId || !platform || !listImplementation || !mode) return null;

    const timestampMs = readTimestampMs(source.timestampMs, now);
    if (type === 'scroll-write' || type === 'scroll-write-rejected') {
        const writer = readEnum(source.writer, SCROLL_WRITERS);
        const reason = readEnum(source.reason, SCROLL_REASONS);
        if (!writer || !reason) return null;
        const sessionId = redactSessionId(rawSessionId);
        const schedulerAuthorityWriter = readEnum(source.schedulerAuthorityWriter, SCHEDULER_AUTHORITY_WRITERS) ?? writer;
        const schedulerAuthorityReason = readEnum(source.schedulerAuthorityReason, SCROLL_REASONS) ?? reason;
        const sharedFields = {
            writer,
            reason,
            schedulerAuthorityWriter,
            schedulerAuthorityReason,
            sessionId,
            platform,
            listImplementation,
            mode,
            targetOffsetY: readNumber(source.targetOffsetY),
            previousOffsetY: readNumber(source.previousOffsetY),
            layoutHeight: readNumber(source.layoutHeight),
            contentHeight: readNumber(source.contentHeight),
            distanceFromBottom: readNumber(source.distanceFromBottom),
            nativeMountSettleStable: typeof source.nativeMountSettleStable === 'boolean'
                ? source.nativeMountSettleStable
                : undefined,
            ...readNativeDiagnostics(source),
            ...readWebDiagnostics(source),
            ...readLiveTailCarveDiagnostics(source),
            timestampMs,
        };
        if (type === 'scroll-write-rejected') {
            const rejectedOwner = readEnum(source.rejectedOwner, OWNERS);
            const activeOwner = readEnum(source.activeOwner, OWNERS);
            if (!rejectedOwner || !activeOwner) return null;
            return {
                event: { type, rejectedOwner, activeOwner, ...sharedFields },
                rawSessionId,
            };
        }
        return {
            event: { type, ...sharedFields },
            rawSessionId,
        };
    }

    if (
        type === 'restore-decision' ||
        type === 'scroll-observed' ||
        type === 'content-measured' ||
        type === 'layout-measured' ||
        type === 'anchor-capture' ||
        type === 'offset-correction' ||
        type === 'row-measured' ||
        type === 'row-mutated' ||
        type === 'visible-window-observed'
    ) {
        const correctionAction = readEnum(source.correctionAction, OFFSET_CORRECTION_ACTIONS) ?? undefined;
        const correctionSource = readEnum(source.correctionSource, OFFSET_CORRECTION_SOURCES) ?? undefined;
        const rowId = readString(source.rowId) ?? undefined;
        const rowKind = readEnum(source.rowKind, ROW_KINDS) ?? undefined;
        const rowHeightPx = readNumber(source.rowHeightPx);
        const rowMeasurePhase = readEnum(source.rowMeasurePhase, ROW_MEASURE_PHASES) ?? undefined;
        const rowViewportRelation = readEnum(source.rowViewportRelation, ROW_VIEWPORT_RELATIONS) ?? undefined;
        // Per-type required fields (N1 evidence events): malformed events are dropped, never
        // partially recorded, so trace analysis can rely on field presence.
        if (type === 'offset-correction' && !correctionAction) return null;
        if (type === 'row-measured' && (!rowId || !rowKind || rowHeightPx === undefined || !rowMeasurePhase)) {
            return null;
        }
        if (type === 'row-mutated' && (!rowId || !rowKind)) return null;
        if (type === 'visible-window-observed' && typeof source.hasVisibleRows !== 'boolean') return null;
        const reason = readEnum(source.reason, OBSERVATION_REASONS) ?? undefined;
        const sessionId = redactSessionId(rawSessionId);
        return {
            event: {
                type,
                sessionId,
                platform,
                listImplementation,
                mode,
                offsetY: readNumber(source.offsetY),
                layoutHeight: readNumber(source.layoutHeight),
                contentHeight: readNumber(source.contentHeight),
                distanceFromBottom: readNumber(source.distanceFromBottom),
                anchorIndex: readNumber(source.anchorIndex),
                anchorItemOffsetPx: readNumber(source.anchorItemOffsetPx),
                anchorObservedItemOffsetPx: readNumber(source.anchorObservedItemOffsetPx),
                anchorDeltaPx: readNumber(source.anchorDeltaPx),
                anchorCorrectionAttempt: readNumber(source.anchorCorrectionAttempt),
                anchorCorrectionTargetOffsetY: readNumber(source.anchorCorrectionTargetOffsetY),
                anchorRestoreViewOffset: readNumber(source.anchorRestoreViewOffset),
                ...(correctionAction ? { correctionAction } : {}),
                ...(correctionSource ? { correctionSource } : {}),
                ...(spreadNumber('correctionDiffPx', readNumber(source.correctionDiffPx))),
                ...(spreadNumber('correctorAppliedDiffTotalPx', readNumber(source.correctorAppliedDiffTotalPx))),
                ...(spreadNumber('correctorEventCount', readNumber(source.correctorEventCount))),
                ...(rowId ? { rowId } : {}),
                ...(rowKind ? { rowKind } : {}),
                ...(spreadNumber('rowHeightPx', rowHeightPx)),
                ...(spreadNumber('rowPreviousHeightPx', readNumber(source.rowPreviousHeightPx))),
                ...(spreadNumber('rowDeltaPx', readNumber(source.rowDeltaPx))),
                ...(rowMeasurePhase ? { rowMeasurePhase } : {}),
                ...(rowViewportRelation ? { rowViewportRelation } : {}),
                ...(spreadNumber('rowContentCount', readNumber(source.rowContentCount))),
                ...(spreadNumber('rowPreviousContentCount', readNumber(source.rowPreviousContentCount))),
                ...readNativeDiagnostics(source),
                ...readWebDiagnostics(source),
                ...readLiveTailCarveDiagnostics(source),
                ...(reason ? { reason } : {}),
                timestampMs,
            },
            rawSessionId,
        };
    }

    return null;
}

export class TranscriptViewportTelemetry {
    private enabled: boolean;
    private consoleLog: boolean;
    private capacity: number;
    private readonly now: () => number;
    private sink: ((event: TranscriptViewportTelemetryEvent) => void) | null;
    private events: TranscriptViewportTelemetryEvent[] = [];
    private rawSessionIds: string[] = [];
    private droppedCount = 0;
    private redactedSessionIds = new Map<string, string>();
    private nextSessionOrdinal = 1;

    constructor(options: TranscriptViewportTelemetryOptions = {}) {
        this.enabled = options.enabled === true;
        this.consoleLog = options.consoleLog === true;
        this.capacity = normalizeCapacity(options.capacity, DEFAULT_TRANSCRIPT_VIEWPORT_TELEMETRY_CAPACITY);
        this.now = options.now ?? defaultNow;
        this.sink = options.sink ?? null;
    }

    configure(options: TranscriptViewportTelemetryOptions): void {
        const wasEnabled = this.enabled;
        this.enabled = options.enabled === true;
        if ('consoleLog' in options) {
            this.consoleLog = options.consoleLog === true;
        }
        this.capacity = normalizeCapacity(options.capacity, this.capacity);
        if ('sink' in options) {
            this.sink = options.sink ?? null;
        }
        if (!this.enabled) {
            this.reset();
            return;
        }
        if (!wasEnabled) {
            this.reset();
        }
        this.trimToCapacity();
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    record(event: unknown): void {
        if (!this.enabled) return;
        const sanitized = sanitizeTelemetryEvent(event, this.now, (sessionId) => this.redactSessionId(sessionId));
        if (!sanitized) {
            if (isInvalidScrollWriterTelemetryEvent(event)) {
                this.droppedCount += 1;
            }
            return;
        }
        this.events.push(sanitized.event);
        this.rawSessionIds.push(sanitized.rawSessionId);
        this.trimToCapacity();
        this.sink?.(sanitized.event);
        if (this.consoleLog) {
            console.log('HAPPIER_TRANSCRIPT_VIEWPORT_EVENT', JSON.stringify(sanitized.event));
        }
    }

    snapshot(): TranscriptViewportTelemetrySnapshot {
        return {
            events: this.events.map((event) => ({ ...event })),
            droppedCount: this.droppedCount,
        };
    }

    reset(): void {
        this.events = [];
        this.rawSessionIds = [];
        this.droppedCount = 0;
        this.redactedSessionIds.clear();
        this.nextSessionOrdinal = 1;
    }

    private redactSessionId(sessionId: string): string {
        const existing = this.redactedSessionIds.get(sessionId);
        if (existing) return existing;
        const redacted = `session:${this.nextSessionOrdinal}`;
        this.nextSessionOrdinal += 1;
        this.redactedSessionIds.set(sessionId, redacted);
        return redacted;
    }

    private trimToCapacity(): void {
        if (this.events.length <= this.capacity) return;
        const overflow = this.events.length - this.capacity;
        this.events = this.events.slice(overflow);
        this.rawSessionIds = this.rawSessionIds.slice(overflow);
        this.droppedCount += overflow;
        this.pruneRedactionsToBufferedRawSessionIds();
    }

    private pruneRedactionsToBufferedRawSessionIds(): void {
        const retainedRawSessionIds = new Set(this.rawSessionIds);
        for (const rawSessionId of this.redactedSessionIds.keys()) {
            if (!retainedRawSessionIds.has(rawSessionId)) {
                this.redactedSessionIds.delete(rawSessionId);
            }
        }
    }
}

export function createTranscriptViewportTelemetry(
    options?: TranscriptViewportTelemetryOptions,
): TranscriptViewportTelemetry {
    return new TranscriptViewportTelemetry(options);
}

export const transcriptViewportTelemetry = createTranscriptViewportTelemetry();

let transcriptViewportTelemetryDebugOverride: TranscriptViewportTelemetryOptions | null = null;

function readTranscriptViewportTelemetryGlobalDebugOverride(): TranscriptViewportTelemetryOptions | null {
    if (!readDevFlag()) return null;
    const target = globalThis as unknown as {
        __HAPPIER_TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE__?: TranscriptViewportTelemetryDebugOverrideOptions;
    };
    const options = target.__HAPPIER_TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE__;
    if (!options || typeof options !== 'object') return null;
    return {
        consoleLog: options.consoleLog === true,
        enabled: options.enabled === true,
        capacity: normalizeCapacity(
            options.capacity,
            DEFAULT_TRANSCRIPT_VIEWPORT_TELEMETRY_CAPACITY,
        ),
    };
}

function resolveTranscriptViewportTelemetryOptionsFromTuning(
    tuning: TranscriptViewportTelemetryTuning,
): TranscriptViewportTelemetryOptions {
    return {
        consoleLog: readDevFlag() && tuning.transcriptViewportTelemetryConsoleLog === true,
        enabled: readDevFlag() && tuning.transcriptViewportTelemetryEnabled === true,
        capacity: normalizeCapacity(
            tuning.transcriptViewportTelemetryMaxEvents,
            DEFAULT_TRANSCRIPT_VIEWPORT_TELEMETRY_CAPACITY,
        ),
    };
}

function mergeTranscriptViewportTelemetryDebugOverride(
    options: TranscriptViewportTelemetryOptions,
): TranscriptViewportTelemetryOptions {
    if (!readDevFlag()) {
        return options;
    }
    const globalDebugOverride = readTranscriptViewportTelemetryGlobalDebugOverride();
    if (globalDebugOverride === null && transcriptViewportTelemetryDebugOverride === null) {
        return options;
    }
    return {
        ...options,
        ...(globalDebugOverride ?? {}),
        ...(transcriptViewportTelemetryDebugOverride ?? {}),
    };
}

export function installTranscriptViewportTelemetryGlobal(
    telemetry: TranscriptViewportTelemetry = transcriptViewportTelemetry,
    options: InstallTranscriptViewportTelemetryGlobalOptions = {},
): void {
    const target = globalThis as unknown as {
        __HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__?: () => TranscriptViewportTelemetrySnapshot;
    };
    const isDev = options.isDev ?? readDevFlag();
    if (!isDev) {
        delete target.__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__;
        return;
    }
    target.__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__ = () => telemetry.snapshot();
}

export function configureTranscriptViewportTelemetryFromTuning(
    tuning: TranscriptViewportTelemetryTuning,
): void {
    transcriptViewportTelemetry.configure(mergeTranscriptViewportTelemetryDebugOverride(
        resolveTranscriptViewportTelemetryOptionsFromTuning(tuning),
    ));
    installTranscriptViewportTelemetryGlobal(transcriptViewportTelemetry);
}

export function configureTranscriptViewportTelemetryDebugOverride(
    options: TranscriptViewportTelemetryDebugOverrideOptions | null,
): void {
    if (!readDevFlag() || options === null) {
        transcriptViewportTelemetryDebugOverride = null;
        delete (globalThis as Record<string, unknown>)[TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE_GLOBAL_KEY];
        if (options === null) {
            transcriptViewportTelemetry.configure({ enabled: false });
            installTranscriptViewportTelemetryGlobal(transcriptViewportTelemetry);
        }
        return;
    }
    transcriptViewportTelemetryDebugOverride = {
        consoleLog: options.consoleLog === true,
        enabled: options.enabled === true,
        capacity: normalizeCapacity(
            options.capacity,
            DEFAULT_TRANSCRIPT_VIEWPORT_TELEMETRY_CAPACITY,
        ),
    };
    (globalThis as Record<string, unknown>)[TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE_GLOBAL_KEY] =
        transcriptViewportTelemetryDebugOverride;
    transcriptViewportTelemetry.configure(transcriptViewportTelemetryDebugOverride);
    installTranscriptViewportTelemetryGlobal(transcriptViewportTelemetry);
}

export function recordTranscriptViewportTelemetryEvent(
    event: unknown,
    tuning: TranscriptViewportTelemetryTuning,
): void {
    configureTranscriptViewportTelemetryFromTuning(tuning);
    transcriptViewportTelemetry.record(event);
}

export function resolveTranscriptViewportTelemetryPlatform(platformOs: string): TranscriptViewportTelemetryPlatform {
    if (platformOs === 'web' || platformOs === 'ios' || platformOs === 'android') {
        return platformOs;
    }
    return 'native-other';
}
