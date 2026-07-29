export type SessionOpenPlatform = 'native' | 'web';

export type SessionOpenEntryKind = 'bottom' | 'anchored' | 'jump';

export type SessionOpenLatchPhase =
    | 'idle'
    | 'awaiting-data'
    | 'awaiting-layout'
    | 'positioning'
    | 'confirming'
    | 'done'
    | 'disarmed';

export type SessionOpenInitialFillStatus = 'idle' | 'in_progress' | 'done';

export type SessionOpenDisarmReason =
    | 'disposed'
    | 'jump-entry'
    | 'session-switch'
    | 'trusted-user-intent';

export type SessionOpenArmResetPlan = Readonly<{
    entryKind: SessionOpenEntryKind;
    sessionId: string;
    shouldFollowBottom: boolean;
}>;

export type SessionOpenDisposeResetPlan = Readonly<{
    reason: SessionOpenDisarmReason;
    sessionId: string;
}>;

export type SessionOpenLatchEffect =
    | Readonly<{
        plan: SessionOpenArmResetPlan;
        type: 'apply-arm-reset-plan';
    }>
    | Readonly<{
        plan: SessionOpenDisposeResetPlan;
        type: 'apply-dispose-reset-plan';
    }>
    | Readonly<{
        type: 'hold-native-first-paint-placeholder';
    }>
    | Readonly<{
        type: 'release-native-first-paint-placeholder';
    }>
    | Readonly<{
        type: 'request-initial-fill';
    }>
    | Readonly<{
        type: 'request-entry-restore-attempt';
    }>;

export type SessionOpenLatchDecision = Readonly<{
    effects: readonly SessionOpenLatchEffect[];
    phase: SessionOpenLatchPhase;
}>;

export type SessionOpenLatchArmInput = Readonly<{
    entryKind: SessionOpenEntryKind;
    nativeFirstPaintFallbackDelayMs: number;
    nowMs: number;
    platform: SessionOpenPlatform;
    sessionId: string;
    shouldFollowBottom: boolean;
    /**
     * Hard bound on the whole web open phase: past `nowMs + delay`, the phase
     * completes ('done') regardless of fill settlement, ending open-lifecycle
     * authority. A starved settlement (aborted, failed, or hung fill
     * executor) must not leave the open phase live forever. Ignored on native
     * (paint deadline owns that path).
     */
    webOpenPhaseDeadlineDelayMs: number;
}>;

export type SessionOpenHostFacts = Readonly<{
    contentHeight: number;
    isLoaded: boolean;
    isScrollable: boolean;
    itemCount: number;
    layoutHeight: number;
    nowMs: number;
    sessionId: string;
}>;

export type SessionOpenNativeFirstPaintFallbackInput = Readonly<{
    nativeViewportPaintObserved: boolean;
    nowMs: number;
    sessionId: string;
}>;

export type SessionOpenNativeFirstPaintPlaceholderInput = Readonly<{
    firstListPaintObserved: boolean;
    hasOpenEntryRestoreTransaction: boolean;
    isLoaded: boolean;
    isWarmKeepAliveInstance: boolean;
    itemCount: number;
    jumpToSeqActive: boolean;
    lastPinOffsetForIntent: number | null;
    nativeEntryRestorePaintReleased: boolean;
    nativeInitialViewportPendingObservation: boolean;
    nativeMountSettleDeadlineReached: boolean;
    nativeMountSettleStable: boolean;
    nativeViewportPaintObserved: boolean;
    pinThresholdPx: number;
    sessionId: string;
}>;

export type SessionOpenInitialFillSettledInput = Readonly<{
    nowMs: number;
    sessionId: string;
}>;
