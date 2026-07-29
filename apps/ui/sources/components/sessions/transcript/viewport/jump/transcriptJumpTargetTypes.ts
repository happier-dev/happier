export type TranscriptJumpTargetRole = 'user' | 'assistant' | 'tool' | 'system' | 'unknown';

/** One explicit target-navigation lifecycle shared by the host, landing adapter, and renderer. */
export type TranscriptExplicitJumpOperationId = symbol;

export type TranscriptJumpTarget =
    | { kind: 'seq'; seq: number }
    | {
        kind: 'route-message-id';
        routeMessageId: string;
        seqHint?: number | null;
        transcriptBlockIndex?: number | null;
        role?: TranscriptJumpTargetRole | null;
    };

export type TranscriptJumpScope =
    | { kind: 'main'; sessionId: string }
    | { kind: 'sidechain'; sessionId: string; sidechainId: string };

export type TranscriptJumpNotFoundReason = 'invalid-target' | 'unsupported' | 'unavailable' | 'exhausted';

export type TranscriptJumpResult =
    | { status: 'scrolled'; target: TranscriptJumpTarget }
    | { status: 'window-rendered'; target: TranscriptJumpTarget; windowId: string }
    | { status: 'resolved-only'; target: TranscriptJumpTarget; routeMessageId: string; seq: number | null }
    | { status: 'not-found'; reason: TranscriptJumpNotFoundReason }
    | { status: 'aborted' };

export type TranscriptJumpTargetIndexResult =
    | { status: 'found'; index: number; seq: number | null; routeMessageId: string | null }
    | {
        status: 'unresolved';
        direction: 'older' | 'newer';
        targetSeq: number;
        nearestIndex: number;
        nearestSeq: number;
    }
    | { status: 'nearest'; index: number; seq: number; targetSeq: number }
    | { status: 'not-found'; reason: TranscriptJumpNotFoundReason };

export type TranscriptJumpStrategy =
    | {
        status: 'scroll-mounted';
        target: TranscriptJumpTarget;
        index: number;
        seq: number | null;
        routeMessageId: string | null;
    }
    | {
        status: 'page-nearby';
        target: TranscriptJumpTarget;
        direction: 'older' | 'newer';
        targetSeq: number;
        nearestIndex: number;
        nearestSeq: number;
    }
    | {
        status: 'render-target-window';
        target: TranscriptJumpTarget;
        direction: 'older' | 'newer' | null;
        targetSeq: number;
    }
    | { status: 'resolved-only'; target: TranscriptJumpTarget; routeMessageId: string; seq: number | null }
    | { status: 'deferred'; target: TranscriptJumpTarget; reason: 'sidechain-executor-unavailable' }
    | { status: 'not-found'; target: TranscriptJumpTarget; reason: TranscriptJumpNotFoundReason }
    | { status: 'aborted'; target: TranscriptJumpTarget };
