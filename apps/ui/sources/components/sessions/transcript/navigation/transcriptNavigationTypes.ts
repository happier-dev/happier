import type {
    TranscriptJumpResult,
    TranscriptJumpScope,
    TranscriptJumpTarget,
} from '../viewport/jump/transcriptJumpTargetTypes';
import type { TranscriptTurnEndFact } from '../markers/transcriptMarkers';

export type TranscriptNavigationRole = 'user' | 'assistant' | 'tool' | 'system' | 'unknown';

export type TranscriptNavigationEntryKind =
    | 'user-turn'
    | 'pinned-user'
    | 'pinned-assistant'
    | 'pinned-tool'
    | 'deep-link-target';

export type TranscriptNavigationDerivationMode = 'all' | 'pinned';

/** What a turn did between your prompt and its answer, known only when its rows are loaded. */
export type TranscriptNavigationApprovalOutcome = 'allowed' | 'denied' | 'pending';

export type TranscriptNavigationTurnApproval = Readonly<{
    outcome: TranscriptNavigationApprovalOutcome;
    /** What was asked, in the tool's own words ("yarn test settings"). */
    label: string | null;
}>;

export type TranscriptNavigationTurnFacts = Readonly<{
    toolCount: number;
    failedCount: number;
    approvals: readonly TranscriptNavigationTurnApproval[];
    /** A tool of this turn is still running. */
    running: boolean;
    /** The turn's last tool failed: the turn ended in failure rather than recovering from one. */
    lastToolFailed: boolean;
    /** The last moment a row of this turn was written or finished; null when unknown. */
    endedAtMs: number | null;
}>;

/** A tool row's navigation-relevant facts, copied from the loaded tool call. */
export type TranscriptNavigationToolFacts = Readonly<{
    state: 'running' | 'completed' | 'error' | 'unavailable';
    permission: TranscriptNavigationApprovalOutcome | null;
    label: string | null;
    completedAtMs: number | null;
}>;
export type TranscriptNavigationFallbackLabelKind = 'pinned-assistant' | 'pinned-tool' | 'pinned-message';
export type TranscriptNavigationPreviewSource = Readonly<{ messageId: string | null; preview: string | null }>;

export type TranscriptNavigationEntry = Readonly<{
    id: string;
    sessionId: string;
    seq: number | null;
    routeMessageId: string | null;
    transcriptBlockIndex: number | null;
    kind: TranscriptNavigationEntryKind;
    role: TranscriptNavigationRole;
    label: string;
    fallbackLabelKind?: TranscriptNavigationFallbackLabelKind | null;
    promptPreview: string | null;
    responsePreview: string | null;
    /** Loaded text is read by the preview leaf; remote history retains its supplied preview. */
    responsePreviewSources?: readonly TranscriptNavigationPreviewSource[];
    labelMessageId?: string;
    createdAtMs: number | null;
    pinned: boolean;
    pinnedAtMs: number | null;
    loaded: boolean;
    /**
     * What happened in the turn. Absent when its rows are not loaded (a remote history row carries
     * only role and text): unknown is never shown as zero.
     */
    facts?: TranscriptNavigationTurnFacts | null;
    /** Recorded lifecycle duration, available independently of the message window. */
    settledDurationMs?: number;
}>;

/**
 * One transcript row as the navigation derivation sees it. Rows sourced from the remote history
 * page carry `loaded: false`: they anchor a turn the transcript window does not currently hold.
 */
export type TranscriptNavigationLoadedMessage = Readonly<{
    sessionId: string;
    messageId: string;
    routeMessageId: string | null;
    seq: number | null;
    transcriptBlockIndex: number | null;
    role: TranscriptNavigationRole;
    text: string | null;
    createdAtMs: number | null;
    loaded?: boolean;
    /** Ancestor context has its own sequence space. */
    isForeignContext?: boolean;
    /** Present on loaded tool rows only. */
    tool?: TranscriptNavigationToolFacts | null;
    /**
     * Set by the row builders, which already normalized every field (including the clamped text
     * preview). Derivation then reuses the row as-is instead of re-running markdown stripping on
     * every pass.
     */
    preNormalized?: true;
}>;

export type TranscriptNavigationPin = Readonly<{
    version: 1;
    sessionId: string;
    seq: number;
    transcriptBlockIndex: number | null;
    routeMessageId: string | null;
    role: TranscriptNavigationRole;
    pinnedAtMs: number;
    label: string | null;
}>;

export type DeriveTranscriptNavigationEntriesParams = Readonly<{
    sessionId: string;
    mode: TranscriptNavigationDerivationMode;
    loadedMessages: readonly TranscriptNavigationLoadedMessage[];
    /** Rows recovered from the remote history page; merged with `loadedMessages` by row identity. */
    remoteMessages: readonly TranscriptNavigationLoadedMessage[];
    pins: readonly TranscriptNavigationPin[];
    turnEnds?: readonly TranscriptTurnEndFact[];
    previousEntries?: readonly TranscriptNavigationEntry[] | null;
}>;

/**
 * Outcome of a navigation entry press as observed by the navigation UI.
 * Hosts return their existing `TranscriptJumpResult` (or a promise of it); the
 * navigation components only read `status`. `not-found` (and promise rejection)
 * renders an inline error with a retry affordance; `aborted` clears silently;
 * every other status is treated as success. Void-returning handlers remain
 * supported and render no transient state.
 */
export type TranscriptNavigationEntryJumpOutcome = Readonly<{
    status: TranscriptJumpResult['status'];
}>;

export type TranscriptNavigationEntryPressResult =
    | void
    | TranscriptNavigationEntryJumpOutcome
    | Promise<TranscriptNavigationEntryJumpOutcome | void>;

export type TranscriptNavigationEntryPressHandler = (entry: TranscriptNavigationEntry) => TranscriptNavigationEntryPressResult;

/** `return` is the "Back to <time>" jump, which must not record a new return target. */
export type TranscriptNavigationJumpSource = 'rail' | 'panel' | 'return';

export type TranscriptNavigationJumpRequest = Readonly<{
    align: 'top' | 'center';
    scope: TranscriptJumpScope;
    source: TranscriptNavigationJumpSource;
    target: TranscriptJumpTarget;
}>;
