export type TranscriptViewportMode =
    | 'hydrating'
    | 'follow-bottom'
    | 'restore-anchor'
    | 'restore-distance'
    | 'user-unpinned'
    | 'jump-to-bottom'
    | 'jump-to-seq';

export type TranscriptViewportPlatform = 'web' | 'ios' | 'android' | 'native-other';

/** Phase-ownership model (plan §4): exactly one owner may issue viewport commands at a time. */
export type TranscriptViewportOwner = 'entry' | 'prepend' | 'follow' | 'explicit' | 'idle';
export type TranscriptViewportListImplementation = 'flash_v2' | 'flatlist' | 'web-fallback';

export type TranscriptViewportScrollReason =
    | 'initial-open'
    | 'content-size-change'
    | 'layout-change'
    | 'entry-restore'
    | 'prepend-restore'
    | 'jump-to-bottom'
    | 'jump-to-seq'
    | 'stream-append'
    | 'mount-settle'
    | 'passive-drift';

export type TranscriptViewportEntrySnapshot = Readonly<{
    shouldFollowBottom: boolean;
    offsetY: number;
    anchorIndex?: number | null;
    anchorViewOffset?: number;
}>;

export type TranscriptViewportCommand =
    | Readonly<{ kind: 'none'; sessionId: string; reason: string; mode: TranscriptViewportMode }>
    | Readonly<{ kind: 'pin-bottom'; sessionId: string; reason: TranscriptViewportScrollReason; mode: TranscriptViewportMode; force?: boolean; animated?: boolean }>
    | Readonly<{ kind: 'scroll-offset'; sessionId: string; reason: TranscriptViewportScrollReason; mode: TranscriptViewportMode; offsetY: number; animated?: boolean }>
    | Readonly<{ kind: 'restore-offset'; sessionId: string; reason: TranscriptViewportScrollReason; mode: 'restore-distance'; offsetY: number; animated?: boolean; contentHeight?: number }>
    | Readonly<{ kind: 'restore-index'; sessionId: string; reason: TranscriptViewportScrollReason; mode: 'restore-anchor'; index: number; viewOffset?: number; animated?: boolean }>
    | Readonly<{ kind: 'jump-to-seq'; sessionId: string; reason: 'jump-to-seq'; mode: 'jump-to-seq'; seq: number; index?: number; animated?: boolean }>
    | Readonly<{ kind: 'skip-native-js-pin'; sessionId: string; reason: TranscriptViewportScrollReason; mode: 'follow-bottom'; skipReason: 'mvcp-only'; targetOffsetY?: number }>;

export type TranscriptViewportControllerInput =
    | Readonly<{
        type: 'first-paint';
        sessionId: string;
        shouldFollowBottom: boolean;
        entrySnapshot?: TranscriptViewportEntrySnapshot | null;
        jumpToSeq?: number | null;
        platform: TranscriptViewportPlatform;
        listImplementation: TranscriptViewportListImplementation;
    }>
    | Readonly<{
        type: 'user-scroll';
        sessionId: string;
        distanceFromBottom: number;
        pinThresholdPx: number;
    }>
    | Readonly<{
        type: 'auto-follow';
        sessionId: string;
        distanceFromBottom: number;
        pinThresholdPx: number;
        recentUserIntent: boolean;
        wantsPinned: boolean;
        reason: TranscriptViewportScrollReason;
        targetOffsetY?: number | null;
        skipNativeJsPin?: boolean;
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
        type: 'scroll-offset';
        sessionId: string;
        reason: TranscriptViewportScrollReason;
        mode: TranscriptViewportMode;
        offsetY: number;
        animated?: boolean;
    }>
    | Readonly<{
        type: 'restore-anchor';
        sessionId: string;
        reason: TranscriptViewportScrollReason;
        index: number;
        viewOffset?: number;
        animated?: boolean;
    }>
    | Readonly<{
        type: 'jump-to-seq';
        sessionId: string;
        seq: number;
        index?: number | null;
    }>;
