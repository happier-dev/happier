import type { TranscriptJumpTargetRole } from './jump/transcriptJumpTargetTypes';

export type TranscriptViewportMode =
    | 'hydrating'
    | 'follow-bottom'
    | 'restore-anchor'
    | 'restore-distance'
    | 'user-unpinned'
    | 'jump-to-bottom'
    | 'jump-to-seq';

export type TranscriptViewportPlatform = 'web' | 'ios' | 'android' | 'native-other';

export type TranscriptViewportOwner = 'entry' | 'prepend' | 'follow' | 'explicit' | 'idle';

export type TranscriptViewportScrollReason =
    | 'initial-open'
    | 'content-size-change'
    | 'layout-change'
    | 'entry-restore'
    | 'prepend-restore'
    | 'jump-to-bottom'
    | 'jump-to-seq'
    | 'stream-append'
    | 'viewport-resized'
    | 'mount-settle'
    | 'passive-drift';

export type TranscriptViewportAnchorIdentity = Readonly<{
    kind: 'message' | 'toolGroup' | 'item';
    itemId: string;
    messageId?: string | null;
}>;

export type TranscriptViewportEntrySnapshot = Readonly<{
    shouldFollowBottom: boolean;
    distanceFromLiveTailPx: number | null;
    anchor?: TranscriptViewportAnchorIdentity | null;
    anchorItemOffsetPx?: number;
}>;

export type TranscriptViewportRestoreAnchorTarget = Readonly<{
    anchor: TranscriptViewportAnchorIdentity;
    itemIndex?: number | null;
    itemOffsetPx: number;
}>;

export type TranscriptViewportJumpAlignment =
    | Readonly<{ kind: 'center' }>
    | Readonly<{ kind: 'top-with-item-offset'; itemOffsetPx: number }>;

export type TranscriptViewportCommand =
    | Readonly<{ kind: 'none'; sessionId: string; reason: string; mode: TranscriptViewportMode }>
    | Readonly<{ kind: 'pin-bottom'; sessionId: string; reason: TranscriptViewportScrollReason; mode: TranscriptViewportMode; force?: boolean; animated?: boolean; contentHeight?: number; layoutHeight?: number }>
    | Readonly<{ kind: 'restore-distance'; sessionId: string; reason: TranscriptViewportScrollReason; mode: 'restore-distance'; distanceFromLiveTailPx: number; animated?: boolean; contentHeight?: number }>
    | Readonly<{ kind: 'apply-history-correction'; sessionId: string; reason: 'prepend-restore'; mode: 'restore-anchor'; targetDistanceFromHistoryStartPx: number; animated?: boolean }>
    | Readonly<{ kind: 'restore-anchor'; sessionId: string; reason: TranscriptViewportScrollReason; mode: 'restore-anchor'; target: TranscriptViewportRestoreAnchorTarget; animated?: boolean }>
    | Readonly<{ kind: 'restore-visible-anchor'; sessionId: string; reason: Extract<TranscriptViewportScrollReason, 'content-size-change' | 'entry-restore'>; mode: 'restore-anchor'; target: TranscriptViewportRestoreAnchorTarget; animated?: boolean }>
    | Readonly<{ kind: 'jump-to-seq'; sessionId: string; reason: 'jump-to-seq'; mode: 'jump-to-seq'; seq: number; routeMessageId?: string | null; transcriptBlockIndex?: number | null; role?: TranscriptJumpTargetRole | null; align?: TranscriptViewportJumpAlignment; animated?: boolean }>
    | Readonly<{ kind: 'recover-jump-to-seq'; sessionId: string; reason: 'jump-to-seq'; mode: 'jump-to-seq'; failedRenderedIndex: number; averageItemLengthPx: number; animated?: boolean }>;

export type TranscriptViewportControllerInput =
    | Readonly<{
        type: 'first-paint';
        sessionId: string;
        shouldFollowBottom: boolean;
        entrySnapshot?: TranscriptViewportEntrySnapshot | null;
        jumpToSeq?: number | null;
    }>
    | Readonly<{
        type: 'user-scroll';
        sessionId: string;
        distanceFromBottom: number;
        pinThresholdPx: number;
    }>
    | Readonly<{
        type: 'jump-to-bottom';
        sessionId: string;
    }>
    | Readonly<{
        type: 'pin-bottom';
        sessionId: string;
        reason: TranscriptViewportScrollReason;
        mode: TranscriptViewportMode;
        force?: boolean;
        animated?: boolean;
    }>
    | Readonly<{
        type: 'restore-distance';
        sessionId: string;
        reason: TranscriptViewportScrollReason;
        distanceFromLiveTailPx: number;
        animated?: boolean;
        contentHeight?: number;
    }>
    | Readonly<{
        type: 'apply-history-correction';
        sessionId: string;
        reason: 'prepend-restore';
        targetDistanceFromHistoryStartPx: number;
        animated?: boolean;
    }>
    | Readonly<{
        type: 'restore-anchor';
        sessionId: string;
        reason: TranscriptViewportScrollReason;
        anchor: TranscriptViewportAnchorIdentity;
        itemOffsetPx: number;
        animated?: boolean;
    }>
    | Readonly<{
        type: 'restore-visible-anchor';
        sessionId: string;
        reason: Extract<TranscriptViewportScrollReason, 'content-size-change' | 'entry-restore'>;
        anchor: TranscriptViewportAnchorIdentity;
        itemIndex?: number | null;
        itemOffsetPx: number;
        animated?: boolean;
    }>
    | Readonly<{
        type: 'jump-to-seq';
        sessionId: string;
        seq: number;
        routeMessageId?: string | null;
        transcriptBlockIndex?: number | null;
        role?: TranscriptJumpTargetRole | null;
        align?: TranscriptViewportJumpAlignment;
    }>
    | Readonly<{
        type: 'recover-jump-to-seq';
        sessionId: string;
        failedRenderedIndex: number;
        averageItemLengthPx: number;
        animated?: boolean;
    }>;
