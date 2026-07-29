import type {
    TranscriptJumpResult,
    TranscriptJumpScope,
    TranscriptJumpTarget,
} from '../viewport/jump/transcriptJumpTargetTypes';

export type TranscriptNavigationRole = 'user' | 'assistant' | 'tool' | 'system' | 'unknown';

export type TranscriptNavigationEntryKind =
    | 'user-turn'
    | 'pinned-user'
    | 'pinned-assistant'
    | 'pinned-tool'
    | 'deep-link-target';

export type TranscriptNavigationDerivationMode = 'all' | 'pinned';
export type TranscriptNavigationFallbackLabelKind = 'pinned-assistant' | 'pinned-tool' | 'pinned-message';

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
    createdAtMs: number | null;
    pinned: boolean;
    pinnedAtMs: number | null;
    loaded: boolean;
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

export type TranscriptNavigationJumpSource = 'rail' | 'panel';

export type TranscriptNavigationJumpRequest = Readonly<{
    align: 'top' | 'center';
    scope: TranscriptJumpScope;
    source: TranscriptNavigationJumpSource;
    target: TranscriptJumpTarget;
}>;
