export type TranscriptTargetWindowState = Readonly<{
    isWindowMode: boolean;
    windowId: string | null;
    targetSeq: number | null;
    windowMinSeq: number | null;
    windowMaxSeq: number | null;
    olderCursor: number | null;
    newerCursor: number | null;
    hasMoreOlder: boolean | null;
    hasMoreNewer: boolean | null;
    activatedAtMs: number | null;
}>;

export type TranscriptTargetWindowDisplayItem = Readonly<{
    id: string;
    seq?: number | null;
}>;

export type TranscriptWindowGapDescriptor = Readonly<{
    direction: 'older' | 'newer';
    id: string;
}>;

export type TranscriptWindowGapItem = TranscriptWindowGapDescriptor & Readonly<{
    kind: 'transcript-window-gap';
}>;

export type TranscriptTargetWindowDisplayResult<TItem extends TranscriptTargetWindowDisplayItem> = Readonly<{
    mode: 'tail' | 'window';
    items: readonly TItem[];
    windowId: string | null;
    targetSeq: number | null;
    targetPresent: boolean | null;
    omittedBeforeCount: number;
    omittedAfterCount: number;
}>;
