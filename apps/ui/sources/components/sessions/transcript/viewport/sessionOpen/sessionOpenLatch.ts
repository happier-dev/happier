import type {
    SessionOpenArmResetPlan,
    SessionOpenDisarmReason,
    SessionOpenDisposeResetPlan,
    SessionOpenEntryKind,
    SessionOpenHostFacts,
    SessionOpenInitialFillSettledInput,
    SessionOpenInitialFillStatus,
    SessionOpenInitialBottomPositionOwner,
    SessionOpenLatchArmInput,
    SessionOpenLatchDecision,
    SessionOpenLatchEffect,
    SessionOpenLatchPhase,
    SessionOpenNativeFirstPaintFallbackInput,
    SessionOpenNativeFirstPaintPlaceholderInput,
    SessionOpenPlatform,
} from './types';

type ArmedState = Readonly<{
    entryKind: SessionOpenEntryKind;
    firstPaintFallbackDeadlineAtMs: number | null;
    initialBottomPositionOwner: SessionOpenInitialBottomPositionOwner;
    platform: SessionOpenPlatform;
    sessionId: string;
    shouldFollowBottom: boolean;
    webInitialPinRetryDelaysMs: readonly number[];
    webInitialPinRetryIndex: number;
    webInitialPinStabilizeMs: number;
}>;

export type SessionOpenLatch = Readonly<{
    arm(input: SessionOpenLatchArmInput): SessionOpenLatchDecision;
    disarm(input: Readonly<{ reason: SessionOpenDisarmReason; sessionId: string }>): SessionOpenLatchDecision;
    disarmedReason(): SessionOpenDisarmReason | null;
    hasAutoExpandedToolCallsGroups(sessionId: string): boolean;
    hasNativeInitialViewportApplied(sessionId: string): boolean;
    initialFillStatus(): SessionOpenInitialFillStatus;
    isEntrySliceDegraded(sessionId: string): boolean;
    markAutoExpandedToolCallsGroups(sessionId: string): void;
    markEntrySliceDegraded(sessionId: string): void;
    markInitialFillInProgress(sessionId: string): boolean;
    markNativeInitialViewportApplied(sessionId: string): Readonly<{ wasApplied: boolean }>;
    onHostFacts(facts: SessionOpenHostFacts): SessionOpenLatchDecision;
    onInitialFillSettled(input: SessionOpenInitialFillSettledInput): SessionOpenLatchDecision;
    onNativeFirstPaintFallbackDeadline(input: SessionOpenNativeFirstPaintFallbackInput): SessionOpenLatchDecision;
    phase(): SessionOpenLatchPhase;
    resetNativeInitialViewport(sessionId: string): void;
    shouldShowNativeFirstPaintPlaceholder(input: SessionOpenNativeFirstPaintPlaceholderInput): boolean;
}>;

export function createSessionOpenLatch(): SessionOpenLatch {
    let armed: ArmedState | null = null;
    let phase: SessionOpenLatchPhase = 'idle';
    let disarmedReason: SessionOpenDisarmReason | null = null;
    let initialFillStatus: SessionOpenInitialFillStatus = 'idle';
    let autoExpandedToolCallsGroupsSessionId: string | null = null;
    let entrySliceDegradedSessionId: string | null = null;
    let nativeInitialViewportAppliedSession: Readonly<{ sessionId: string; applied: boolean }> | null = null;
    let nativeFirstPaintFallbackReleased = false;
    let requestedInitialPin = false;
    let requestedInitialPositioning = false;
    let requestedInitialFill = false;

    const decision = (effects: readonly SessionOpenLatchEffect[] = []): SessionOpenLatchDecision => ({
        effects,
        phase,
    });

    const disposeCurrent = (reason: SessionOpenDisarmReason): SessionOpenLatchEffect[] => {
        if (!armed) return [];
        const plan: SessionOpenDisposeResetPlan = {
            reason,
            sessionId: armed.sessionId,
        };
        clearSessionState();
        phase = 'disarmed';
        disarmedReason = reason;
        return [{ plan, type: 'apply-dispose-reset-plan' }];
    };

    const clearSessionState = () => {
        initialFillStatus = 'idle';
        autoExpandedToolCallsGroupsSessionId = null;
        entrySliceDegradedSessionId = null;
        nativeFirstPaintFallbackReleased = false;
        requestedInitialPin = false;
        requestedInitialPositioning = false;
        requestedInitialFill = false;
    };

    const takeNextWebRetryEffect = (nowMs: number): SessionOpenLatchEffect | null => {
        if (!armed || armed.platform !== 'web') return null;
        if (armed.initialBottomPositionOwner === 'renderer') return null;
        const retryDelayMs = normalizeRetryDelay(armed.webInitialPinRetryDelaysMs[armed.webInitialPinRetryIndex]);
        if (retryDelayMs === null) return null;
        armed = {
            ...armed,
            webInitialPinRetryIndex: armed.webInitialPinRetryIndex + 1,
        };
        return {
            deadlineAtMs: nowMs + retryDelayMs,
            type: 'schedule-web-initial-pin-retry',
        };
    };

    const isSameArmRequest = (input: SessionOpenLatchArmInput): boolean => (
        armed?.sessionId === input.sessionId &&
        armed.entryKind === input.entryKind &&
        armed.initialBottomPositionOwner === (input.initialBottomPositionOwner ?? 'app') &&
        armed.platform === input.platform &&
        armed.shouldFollowBottom === input.shouldFollowBottom
    );

    return {
        arm(input) {
            if (isSameArmRequest(input)) return decision();

            const effects: SessionOpenLatchEffect[] = [];
            if (armed && armed.sessionId !== input.sessionId) {
                effects.push(...disposeCurrent('session-switch'));
            }

            clearSessionState();
            armed = {
                entryKind: input.entryKind,
                firstPaintFallbackDeadlineAtMs: input.platform === 'native'
                    ? input.nowMs + Math.max(0, Math.trunc(input.nativeFirstPaintFallbackDelayMs))
                    : null,
                initialBottomPositionOwner: input.initialBottomPositionOwner ?? 'app',
                platform: input.platform,
                sessionId: input.sessionId,
                shouldFollowBottom: input.shouldFollowBottom,
                webInitialPinRetryDelaysMs: input.webInitialPinRetryDelaysMs,
                webInitialPinRetryIndex: 0,
                webInitialPinStabilizeMs: Math.max(0, Math.trunc(input.webInitialPinStabilizeMs)),
            };
            disarmedReason = input.entryKind === 'jump' ? 'jump-entry' : null;
            phase = input.entryKind === 'jump' ? 'disarmed' : 'awaiting-data';
            if (input.platform === 'native') {
                nativeInitialViewportAppliedSession = { sessionId: input.sessionId, applied: false };
            }

            const plan: SessionOpenArmResetPlan = {
                entryKind: input.entryKind,
                sessionId: input.sessionId,
                shouldFollowBottom: input.shouldFollowBottom,
            };
            effects.push({ plan, type: 'apply-arm-reset-plan' });
            effects.push({ type: 'hold-native-first-paint-placeholder' });
            return decision(effects);
        },
        disarm(input) {
            if (!armed || armed.sessionId !== input.sessionId) return decision();
            return decision(disposeCurrent(input.reason));
        },
        disarmedReason: () => disarmedReason,
        hasAutoExpandedToolCallsGroups(sessionId) {
            return autoExpandedToolCallsGroupsSessionId === sessionId;
        },
        hasNativeInitialViewportApplied(sessionId) {
            return nativeInitialViewportAppliedSession?.sessionId === sessionId &&
                nativeInitialViewportAppliedSession.applied === true;
        },
        initialFillStatus: () => initialFillStatus,
        isEntrySliceDegraded(sessionId) {
            return entrySliceDegradedSessionId === sessionId;
        },
        markAutoExpandedToolCallsGroups(sessionId) {
            autoExpandedToolCallsGroupsSessionId = sessionId;
        },
        markEntrySliceDegraded(sessionId) {
            entrySliceDegradedSessionId = sessionId;
        },
        markInitialFillInProgress(sessionId) {
            if (!armed || armed.sessionId !== sessionId) return false;
            if (initialFillStatus !== 'idle') return false;
            initialFillStatus = 'in_progress';
            return true;
        },
        markNativeInitialViewportApplied(sessionId) {
            const wasApplied = nativeInitialViewportAppliedSession?.sessionId === sessionId &&
                nativeInitialViewportAppliedSession.applied === true;
            nativeInitialViewportAppliedSession = { sessionId, applied: true };
            return { wasApplied };
        },
        onHostFacts(facts) {
            if (!armed || armed.sessionId !== facts.sessionId) return decision();
            if (phase === 'disarmed' || phase === 'done') return decision();
            if (!facts.isLoaded || facts.itemCount <= 0) {
                phase = 'awaiting-data';
                return decision();
            }
            if (facts.layoutHeight <= 0 || facts.contentHeight <= 0) {
                phase = 'awaiting-layout';
                if (
                    armed.entryKind !== 'bottom' ||
                    requestedInitialPin ||
                    armed.initialBottomPositionOwner === 'renderer'
                ) return decision();
                return decision([
                    { reason: 'initial-open', type: 'request-initial-pin' },
                    takeNextWebRetryEffect(facts.nowMs),
                ].filter((effect): effect is SessionOpenLatchEffect => effect !== null));
            }
            phase = phase === 'idle' || phase === 'awaiting-data' || phase === 'awaiting-layout'
                ? 'positioning'
                : phase;

            const effects: SessionOpenLatchEffect[] = [];
            if (armed.entryKind === 'bottom' && !requestedInitialPositioning) {
                requestedInitialPositioning = true;
                if (!requestedInitialPin && armed.initialBottomPositionOwner === 'app') {
                    requestedInitialPin = true;
                    effects.push({ reason: 'initial-open', type: 'request-initial-pin' });
                }
                if (armed.platform === 'web' && armed.initialBottomPositionOwner === 'app') {
                    effects.push({ deadlineMs: armed.webInitialPinStabilizeMs, type: 'begin-web-bottom-entry' });
                    const retryEffect = takeNextWebRetryEffect(facts.nowMs);
                    if (retryEffect) effects.push(retryEffect);
                }
            }

            if (
                armed.entryKind === 'bottom' &&
                initialFillStatus === 'idle' &&
                !requestedInitialFill &&
                !facts.isScrollable &&
                !facts.hasEntrySliceWindow
            ) {
                requestedInitialFill = true;
                effects.push({ type: 'request-initial-fill' });
            } else if (
                armed.entryKind === 'bottom' &&
                initialFillStatus === 'idle' &&
                !requestedInitialFill &&
                facts.isScrollable &&
                !facts.hasEntrySliceWindow
            ) {
                // Already scrollable at the first measured facts: there is nothing for the
                // initial fill to do. Settle the status immediately so fill-gated consumers
                // (older pagination's 'fill-not-done' suspension) unblock. Renderers that
                // measure content synchronously (Legend web) hit this branch; renderers that
                // measure late (FlashList) go through request-initial-fill above instead.
                initialFillStatus = 'done';
            }

            if (
                armed.entryKind === 'anchored' &&
                initialFillStatus === 'idle' &&
                !facts.hasEntrySliceWindow
            ) {
                initialFillStatus = 'done';
                phase = 'confirming';
                effects.push({ type: 'request-entry-restore-attempt' });
            }

            return decision(effects);
        },
        onInitialFillSettled(input) {
            if (!armed || armed.sessionId !== input.sessionId) return decision();
            initialFillStatus = 'done';
            phase = armed.entryKind === 'anchored' ? 'confirming' : 'done';
            return decision(armed.entryKind === 'anchored'
                ? [{ type: 'request-entry-restore-attempt' }]
                : []);
        },
        onNativeFirstPaintFallbackDeadline(input) {
            if (!armed || armed.sessionId !== input.sessionId) return decision();
            if (armed.firstPaintFallbackDeadlineAtMs === null) return decision();
            if (nativeFirstPaintFallbackReleased || input.nativeViewportPaintObserved) return decision();
            if (input.nowMs < armed.firstPaintFallbackDeadlineAtMs) return decision();
            nativeFirstPaintFallbackReleased = true;
            return decision([{ type: 'release-native-first-paint-placeholder' }]);
        },
        phase: () => phase,
        resetNativeInitialViewport(sessionId) {
            nativeInitialViewportAppliedSession = { sessionId, applied: false };
        },
        shouldShowNativeFirstPaintPlaceholder(input) {
            if (!input.isLoaded || input.itemCount <= 0) return false;
            if (input.jumpToSeqActive) return false;
            const followsBottom = armed?.sessionId === input.sessionId
                ? armed.shouldFollowBottom
                : true;
            const warmFirstPaintDistanceAppearsOffBottom =
                followsBottom &&
                typeof input.lastPinOffsetForIntent === 'number' &&
                Number.isFinite(input.lastPinOffsetForIntent) &&
                input.lastPinOffsetForIntent > input.pinThresholdPx;
            if (input.isWarmKeepAliveInstance && !warmFirstPaintDistanceAppearsOffBottom) return false;

            const holdForMountSettle =
                followsBottom &&
                !input.nativeMountSettleStable &&
                !input.nativeMountSettleDeadlineReached;
            const holdForPendingViewport =
                !input.nativeMountSettleDeadlineReached &&
                input.nativeInitialViewportPendingObservation &&
                (followsBottom || input.hasOpenEntryRestoreTransaction);
            return !input.nativeViewportPaintObserved &&
                !input.nativeEntryRestorePaintReleased &&
                (
                    (
                        !input.nativeMountSettleStable &&
                        !input.nativeMountSettleDeadlineReached &&
                        (!input.firstListPaintObserved || holdForMountSettle)
                    ) ||
                    holdForPendingViewport
                );
        },
    };
}

function normalizeRetryDelay(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
}
