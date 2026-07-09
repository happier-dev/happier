import * as React from 'react';
import { Platform } from 'react-native';
import { sync } from '@/sync/sync';
import type {
    TranscriptViewportTelemetryEvent,
    TranscriptViewportTelemetryObservationReason,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { RestoreDecisionTelemetryParams } from '@/components/sessions/transcript/viewport/telemetryHost/viewportEvents';
import { readNativeAbsoluteScrollOffset } from '@/components/sessions/transcript/viewport/driver/readNativeAbsoluteScrollOffset';
import type {
    TranscriptViewportCommandController,
} from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import type { TranscriptViewportCommandHost } from '@/components/sessions/transcript/viewport/driver/commandHost';
import {
    captureNativeTranscriptViewportAnchor,
} from '@/components/sessions/transcript/viewport/driver/transcriptNativeViewportAnchor';
import {
    captureWebTranscriptPrependAnchor,
    refreshWebTranscriptPrependAnchor,
    type WebTranscriptPrependAnchor,
    type WebTranscriptPrependRestoreResult,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import {
    createNativePrependOwner,
    type NativePrependBeginInput,
    type NativePrependObservationInput,
    type NativePrependOwner,
    type NativePrependOwnerEffect,
} from '@/components/sessions/transcript/viewport/prepend/nativePrependOwner';
import {
    createWebPrependOwner,
    type WebPrependOwner,
    type WebPrependOwnerEffect,
    type WebPrependTelemetryFacts,
} from '@/components/sessions/transcript/viewport/prepend/webPrependOwner';
import {
    resolveTranscriptViewportAnchorDescriptor,
    resolveTranscriptViewportAnchorFocusOffsetPx,
} from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { TranscriptViewportMode } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type {
    TranscriptViewportTransactionOutcome,
} from '@/components/sessions/transcript/viewport/transcriptViewportOwnership';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';

const TRANSCRIPT_WEB_PREPEND_INDEX_RECOVERY_RETRY_MS = 16;

type MutableRef<T> = { current: T };

type TranscriptPrependHostDeps = Readonly<{
    commandHostRef: MutableRef<TranscriptViewportCommandHost | null>;
    currentSessionId: string;
    lastUserScrollIntentAtMsRef: MutableRef<number>;
    listContentHeightRef: MutableRef<number>;
    listDataRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
    itemsRef: MutableRef<readonly ChatTranscriptListItem[]>;
    pinThresholdPx: number;
    preemptEntryRestoreTransaction: () => void;
    recordRestoreDecisionTelemetry: (
        reason: TranscriptViewportTelemetryObservationReason,
        params?: RestoreDecisionTelemetryParams,
    ) => void;
    recordViewportTelemetryEvent: (
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ) => void;
    resolveWebScrollMetrics: () => WebTranscriptScrollMetrics | null;
    viewportCommandController: TranscriptViewportCommandController;
    wantsPinnedRef: MutableRef<boolean>;
    webPrependRestoreOwner: 'app' | 'renderer';
}>;

export type TranscriptPrependHost = Readonly<{
    applyNativeEffects: (effects: readonly NativePrependOwnerEffect[]) => void;
    applyWebEffects: (effects: readonly WebPrependOwnerEffect[]) => void;
    armNativeCommit: (layoutTimeoutMs: number) => void;
    beginNativeTransaction: () => boolean;
    clearWebRestoreWindow: (outcome: TranscriptViewportTransactionOutcome) => void;
    clearWebRangeReserve: () => void;
    getNativeTransactionRevision: () => number;
    hasOpenNativeTransaction: (sessionId?: string) => boolean;
    hasWebRestoreWindow: () => boolean;
    invalidateNativeTransaction: (reason?: 'identity' | 'session-entry' | 'load-empty' | 'jump' | 'dispose' | 'ownership-rejected') => void;
    nativeTelemetryState: (sessionId?: string) => ReturnType<NativePrependOwner['telemetryState']>;
    observeNative: () => void;
    observeWeb: () => void;
    recordCorrectorCorrection: (diffPx: number) => void;
    refreshInFlightWebAnchor: (options?: Readonly<{ userScrolledDuringLoad?: boolean }>) => void;
    retargetPendingWebAnchorForUserScroll: () => void;
    runWebIndexRecovery: () => boolean;
    slots: Readonly<{
        rangeReservePx: number;
    }>;
    telemetryFacts: () => WebPrependTelemetryFacts;
    trustedNativeScroll: NativePrependOwner['trustedScroll'];
    webAfterLoad: (params: Readonly<{
        loadedRowCount: number;
        preservePrependViewport: boolean;
    }>) => void;
    webBeforeLoad: (params: Readonly<{
        preservePrependViewport: boolean;
    }>) => void;
    webClear: (outcome: TranscriptViewportTransactionOutcome) => void;
    captureWebAnchor: () => WebTranscriptPrependAnchor | null;
}>;

export function useTranscriptPrependHost(deps: TranscriptPrependHostDeps): TranscriptPrependHost {
    const [nativeTransactionRevision, bumpNativeTransactionRevision] = React.useReducer(
        (value: number) => value + 1,
        0,
    );
    const nativeOwnerRef = React.useRef<NativePrependOwner | null>(null);
    if (nativeOwnerRef.current === null) {
        nativeOwnerRef.current = createNativePrependOwner();
    }
    const nativeOwner = nativeOwnerRef.current;
    const webOwnerRef = React.useRef<WebPrependOwner | null>(null);
    if (webOwnerRef.current === null) {
        webOwnerRef.current = createWebPrependOwner();
    }
    const webOwner = webOwnerRef.current;
    const { webPrependRestoreOwner } = deps;
    const applyNativeEffectsRef = React.useRef<(effects: readonly NativePrependOwnerEffect[]) => void>(() => {});
    const applyWebEffectsRef = React.useRef<(effects: readonly WebPrependOwnerEffect[]) => void>(() => {});
    const nativeLayoutTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeQuietReobserveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const nativeCorrectorReobserveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const webIndexRecoveryScheduleRef = React.useRef<{ kind: 'raf' | 'timeout'; ids: any[] } | null>(null);
    const webIndexRecoveryRunningRef = React.useRef(false);
    const webRestoreExpiryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    // Tracks the scrollTop written by the most recent growth prepend restore. Reset to null when
    // the user triggers a retarget (scroll ingress), when the prepend window closes or is cleared,
    // and on session load/unload. Used by the layout-effect race guard to detect when the user
    // has voluntarily scrolled away from the last restore landing point before the scroll event
    // fires the retarget (so the stale growth formula cannot drag them back).
    const lastPrependGrowthRestoreScrollTopRef = React.useRef<number | null>(null);
    const runWebIndexRecoveryRef = React.useRef<() => boolean>(() => false);
    const nativeTransactionRevisionRef = React.useRef(nativeTransactionRevision);
    nativeTransactionRevisionRef.current = nativeTransactionRevision;
    const [rangeReservePx, setRangeReservePx] = React.useState(0);

    const clearWebRangeReserve = React.useCallback(() => {
        setRangeReservePx((previous) => previous === 0 ? previous : 0);
    }, []);

    const cancelWebRestoreWindowExpiry = React.useCallback(() => {
        const timeoutId = webRestoreExpiryTimerRef.current;
        if (timeoutId === null) return;
        webRestoreExpiryTimerRef.current = null;
        clearTimeout(timeoutId);
    }, []);

    const cancelScheduledWebIndexRecovery = React.useCallback(() => {
        const scheduledRecovery = webIndexRecoveryScheduleRef.current;
        if (!scheduledRecovery) return;
        webIndexRecoveryScheduleRef.current = null;
        if (scheduledRecovery.kind === 'raf') {
            for (const id of scheduledRecovery.ids) {
                cancelAnimationFrame(id);
            }
            return;
        }
        for (const id of scheduledRecovery.ids) {
            clearTimeout(id);
        }
    }, []);

    const closeWebViewportOwnership = React.useCallback((
        outcome: TranscriptViewportTransactionOutcome,
    ) => {
        if (Platform.OS !== 'web') return;
        if (deps.viewportCommandController.activeOwner() !== 'prepend') return;
        deps.viewportCommandController.closeTransaction('prepend', outcome);
    }, [deps.viewportCommandController]);

    const resolveNativeObservationInput = React.useCallback((sessionId: string): NativePrependObservationInput => {
        const node = deps.listRef.current;
        const absoluteScrollOffset = readNativeAbsoluteScrollOffset(node) ?? Number.NaN;
        return {
            activeOwner: deps.viewportCommandController.activeOwner(),
            nowMs: Date.now(),
            postCommit: {
                absoluteScrollOffset,
                contentHeight: deps.listContentHeightRef.current,
                getLayout: (index: number) => {
                    try {
                        return node?.getLayout?.(index) ?? undefined;
                    } catch {
                        return undefined;
                    }
                },
                items: deps.listDataRef.current,
                layoutHeight: deps.listLayoutHeightRef.current,
            },
            sessionId,
        };
    }, [
        deps.listContentHeightRef,
        deps.listDataRef,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.viewportCommandController,
    ]);

    const applyNativeEffects = React.useCallback((
        effects: readonly NativePrependOwnerEffect[],
    ) => {
        for (const effect of effects) {
            switch (effect.type) {
                case 'preempt-entry-restore-for-prepend':
                    deps.preemptEntryRestoreTransaction();
                    break;
                case 'open-prepend-ownership': {
                    const openResult = deps.viewportCommandController.openTransaction('prepend');
                    if (!openResult.opened) {
                        applyNativeEffectsRef.current(nativeOwner.invalidate({
                            activeOwner: deps.viewportCommandController.activeOwner(),
                            reason: 'ownership-rejected',
                            sessionId: effect.sessionId,
                        }));
                    }
                    break;
                }
                case 'close-prepend-ownership':
                    if (deps.viewportCommandController.activeOwner() === 'prepend') {
                        deps.viewportCommandController.closeTransaction('prepend', effect.outcome);
                    }
                    break;
                case 'execute-command':
                    executeCommandHostInput(deps.commandHostRef, effect.command);
                    break;
                case 'schedule-layout-timeout': {
                    const existing = nativeLayoutTimerRef.current;
                    if (existing != null) clearTimeout(existing);
                    nativeLayoutTimerRef.current = setTimeout(() => {
                        nativeLayoutTimerRef.current = null;
                        applyNativeEffectsRef.current(nativeOwner.runLayoutTimeout(
                            resolveNativeObservationInput(effect.sessionId),
                        ));
                    }, effect.delayMs);
                    break;
                }
                case 'clear-layout-timeout': {
                    const existing = nativeLayoutTimerRef.current;
                    if (existing != null) {
                        nativeLayoutTimerRef.current = null;
                        clearTimeout(existing);
                    }
                    break;
                }
                case 'schedule-quiet-reobserve': {
                    const existing = nativeQuietReobserveTimerRef.current;
                    if (existing != null) clearTimeout(existing);
                    nativeQuietReobserveTimerRef.current = setTimeout(() => {
                        nativeQuietReobserveTimerRef.current = null;
                        applyNativeEffectsRef.current(nativeOwner.runQuietReobserve(
                            resolveNativeObservationInput(effect.sessionId),
                        ));
                    }, effect.delayMs);
                    break;
                }
                case 'clear-quiet-reobserve': {
                    const existing = nativeQuietReobserveTimerRef.current;
                    if (existing != null) {
                        nativeQuietReobserveTimerRef.current = null;
                        clearTimeout(existing);
                    }
                    break;
                }
                case 'schedule-corrector-reobserve': {
                    const existing = nativeCorrectorReobserveTimerRef.current;
                    if (existing != null) clearTimeout(existing);
                    nativeCorrectorReobserveTimerRef.current = setTimeout(() => {
                        nativeCorrectorReobserveTimerRef.current = null;
                        applyNativeEffectsRef.current(nativeOwner.runCorrectorReobserve(
                            resolveNativeObservationInput(effect.sessionId),
                        ));
                    }, effect.delayMs);
                    break;
                }
                case 'clear-corrector-reobserve': {
                    const existing = nativeCorrectorReobserveTimerRef.current;
                    if (existing != null) {
                        nativeCorrectorReobserveTimerRef.current = null;
                        clearTimeout(existing);
                    }
                    break;
                }
                case 'bump-transaction-revision':
                    bumpNativeTransactionRevision();
                    break;
                case 'record-restore-decision-for-session':
                    deps.recordViewportTelemetryEvent({
                        type: 'restore-decision',
                        mode: effect.mode,
                        reason: effect.reason,
                        anchorItemOffsetPx: effect.anchorItemOffsetPx,
                        anchorDeltaPx: effect.anchorDeltaPx,
                        correctorAppliedDiffTotalPx: effect.correctorAppliedDiffTotalPx,
                        correctorEventCount: effect.correctorEventCount,
                    }, { sessionId: effect.sessionId });
                    break;
            }
        }
    }, [
        deps.commandHostRef,
        deps.preemptEntryRestoreTransaction,
        deps.recordViewportTelemetryEvent,
        deps.viewportCommandController,
        nativeOwner,
        resolveNativeObservationInput,
    ]);
    applyNativeEffectsRef.current = applyNativeEffects;

    const restoreWebPrependAnchorThroughViewportCommand = React.useCallback((
        anchor: WebTranscriptPrependAnchor,
    ): WebTranscriptPrependRestoreResult => {
        const commandHost = deps.commandHostRef.current;
        if (!commandHost) {
            return {
                didAdjustScroll: false,
                strategy: 'none',
            };
        }
        return commandHost.restoreWebPrependAnchor({
            anchor,
            sessionId: deps.currentSessionId,
        });
    }, [
        deps.commandHostRef,
        deps.currentSessionId,
    ]);

    const resolveWebRefreshOptions = React.useCallback((strategy: 'anchor' | 'item' | 'growth' | 'none') => {
        if (strategy === 'anchor') {
            return { adoptCurrentAnchorPosition: true, recaptureAnchor: true, recaptureItem: true } as const;
        }
        if (strategy === 'item') {
            return { adoptCurrentAnchorPosition: true, recaptureItem: true } as const;
        }
        return { preserveBaselineMetrics: true } as const;
    }, []);

    const applyWebEffects = React.useCallback((
        effects: readonly WebPrependOwnerEffect[],
    ) => {
        for (const effect of effects) {
            switch (effect.type) {
                case 'execute-web-prepend-restore': {
                    if (webPrependRestoreOwner === 'renderer') {
                        lastPrependGrowthRestoreScrollTopRef.current = null;
                        break;
                    }
                    const preRestoreMetrics = deps.resolveWebScrollMetrics();
                    // Guard: catch the layout-effect race where a markdown remeasure (or any
                    // synchronous DOM size change) fires the layout effect — and therefore
                    // observeWeb() → execute-web-prepend-restore — BEFORE the browser's scroll
                    // event fires the retarget for a user scroll.
                    //
                    // After a growth restore writes to T (e.g. 700), lastPrependGrowthRestoreScrollTopRef
                    // is set to T. If the user then presses PageUp, the DOM scrollTop changes
                    // synchronously (to e.g. 200) but the scroll event — which fires retargetPending
                    // and resets this ref to null — arrives asynchronously. If another layout
                    // effect fires in that window, we would compute target = anchorScrollTop +
                    // (newHeight - anchorScrollHeight) using the stale anchor, producing a target
                    // that drags the user from 200 back to ~720.
                    //
                    // When this ref is non-null, the user is AT the prior restore target. If they
                    // have moved significantly below (lower scrollTop = closer to content top), the
                    // retarget hasn't fired yet and we must not execute the restore. Once retarget
                    // fires it resets this ref to null, disabling the guard until the next restore.
                    const priorRestoreScrollTop = lastPrependGrowthRestoreScrollTopRef.current;
                    const ABOVE_RESTORE_TARGET_LEEWAY_PX = 32;
                    if (
                        preRestoreMetrics &&
                        priorRestoreScrollTop !== null &&
                        preRestoreMetrics.scrollTop < priorRestoreScrollTop - ABOVE_RESTORE_TARGET_LEEWAY_PX
                    ) {
                        applyWebEffectsRef.current(webOwner.clear({
                            outcome: 'abandoned-user-scroll',
                            sessionId: effect.sessionId,
                        }));
                        lastPrependGrowthRestoreScrollTopRef.current = null;
                        break;
                    }
                    const restoreResult = restoreWebPrependAnchorThroughViewportCommand(effect.anchor);
                    const metrics = deps.resolveWebScrollMetrics();
                    if (restoreResult.didAdjustScroll && metrics) {
                        lastPrependGrowthRestoreScrollTopRef.current = metrics.scrollTop;
                    }
                    const refreshedAnchor = metrics
                        ? refreshWebTranscriptPrependAnchor(
                            effect.anchor,
                            metrics,
                            resolveWebRefreshOptions(restoreResult.strategy),
                        )
                        : null;
                    const acceptEffects = webOwner.acceptRestoreResult({
                        currentMetrics: metrics,
                        nowMs: Date.now(),
                        refreshedAnchor,
                        result: restoreResult,
                        sessionId: effect.sessionId,
                    });
                    applyWebEffectsRef.current(acceptEffects);
                    break;
                }
                case 'execute-anchor-recovery':
                    if (webPrependRestoreOwner === 'renderer') break;
                    executeCommandHostInput(deps.commandHostRef, {
                        type: 'restore-anchor',
                        sessionId: effect.sessionId,
                        reason: 'prepend-restore',
                        anchor: effect.anchor,
                        itemOffsetPx: effect.itemOffsetPx,
                        animated: false,
                    });
                    break;
                case 'preempt-entry-restore-for-prepend':
                    deps.preemptEntryRestoreTransaction();
                    break;
                case 'open-prepend-ownership': {
                    if (webPrependRestoreOwner === 'renderer') break;
                    const openResult = deps.viewportCommandController.openTransaction('prepend');
                    if (!openResult.opened) {
                        applyWebEffectsRef.current(webOwner.clear({
                            outcome: 'abandoned-identity',
                            sessionId: effect.sessionId,
                        }));
                    }
                    break;
                }
                case 'close-prepend-ownership':
                    closeWebViewportOwnership(effect.outcome);
                    lastPrependGrowthRestoreScrollTopRef.current = null;
                    break;
                case 'set-web-range-reserve':
                    setRangeReservePx((previous) => previous === effect.reservePx ? previous : effect.reservePx);
                    break;
                case 'clear-web-range-reserve':
                    clearWebRangeReserve();
                    break;
                case 'schedule-web-restore-expiry': {
                    cancelWebRestoreWindowExpiry();
                    const arm = (expiresAtMs: number) => {
                        const delayMs = Math.max(0, Math.ceil(expiresAtMs - Date.now())) + 1;
                        webRestoreExpiryTimerRef.current = setTimeout(() => {
                            webRestoreExpiryTimerRef.current = null;
                            applyWebEffectsRef.current(webOwner.expire({ nowMs: Date.now() }));
                        }, delayMs);
                    };
                    arm(effect.expiresAtMs);
                    break;
                }
                case 'clear-web-restore-expiry':
                    cancelWebRestoreWindowExpiry();
                    break;
                case 'schedule-web-index-recovery': {
                    if (webIndexRecoveryScheduleRef.current) break;
                    const scheduleTimeoutRecovery = (delayMs: number) => {
                        const handle: { kind: 'timeout'; ids: any[] } = { kind: 'timeout', ids: [] };
                        webIndexRecoveryScheduleRef.current = handle;
                        const timeoutId = setTimeout(() => {
                            if (webIndexRecoveryScheduleRef.current !== handle) return;
                            webIndexRecoveryScheduleRef.current = null;
                            webIndexRecoveryRunningRef.current = true;
                            try {
                                runWebIndexRecoveryRef.current();
                            } finally {
                                webIndexRecoveryRunningRef.current = false;
                            }
                        }, delayMs);
                        handle.ids.push(timeoutId);
                    };
                    if (webIndexRecoveryRunningRef.current) {
                        scheduleTimeoutRecovery(TRANSCRIPT_WEB_PREPEND_INDEX_RECOVERY_RETRY_MS);
                        break;
                    }
                    if (typeof requestAnimationFrame === 'function') {
                        const handle: { kind: 'raf'; ids: any[] } = { kind: 'raf', ids: [] };
                        webIndexRecoveryScheduleRef.current = handle;
                        const first = requestAnimationFrame(() => {
                            const second = requestAnimationFrame(() => {
                                if (webIndexRecoveryScheduleRef.current !== handle) return;
                                webIndexRecoveryScheduleRef.current = null;
                                webIndexRecoveryRunningRef.current = true;
                                try {
                                    runWebIndexRecoveryRef.current();
                                } finally {
                                    webIndexRecoveryRunningRef.current = false;
                                }
                            });
                            handle.ids.push(second);
                        });
                        handle.ids.push(first);
                        break;
                    }
                    scheduleTimeoutRecovery(TRANSCRIPT_WEB_PREPEND_INDEX_RECOVERY_RETRY_MS);
                    break;
                }
                case 'clear-web-index-recovery':
                    cancelScheduledWebIndexRecovery();
                    break;
                case 'record-restore-decision':
                    deps.recordRestoreDecisionTelemetry(effect.reason, {
                        mode: effect.mode,
                        programmaticWebWrite: effect.programmaticWebWrite,
                        webTrigger: effect.webTrigger,
                    });
                    break;
            }
        }
    }, [
        cancelScheduledWebIndexRecovery,
        cancelWebRestoreWindowExpiry,
        clearWebRangeReserve,
        closeWebViewportOwnership,
        deps.commandHostRef,
        deps.preemptEntryRestoreTransaction,
        deps.recordRestoreDecisionTelemetry,
        deps.resolveWebScrollMetrics,
        deps.viewportCommandController,
        resolveWebRefreshOptions,
        restoreWebPrependAnchorThroughViewportCommand,
        webPrependRestoreOwner,
        webOwner,
    ]);
    applyWebEffectsRef.current = applyWebEffects;

    const clearWebRestoreWindow = React.useCallback((
        outcome: TranscriptViewportTransactionOutcome,
    ) => {
        if (webPrependRestoreOwner === 'renderer') {
            lastPrependGrowthRestoreScrollTopRef.current = null;
            clearWebRangeReserve();
            return;
        }
        applyWebEffectsRef.current(webOwner.clear({
            outcome,
            sessionId: deps.currentSessionId,
        }));
    }, [clearWebRangeReserve, deps.currentSessionId, webOwner, webPrependRestoreOwner]);

    const captureWebAnchor = React.useCallback(() => {
        if (webPrependRestoreOwner === 'renderer') return null;
        if (Platform.OS !== 'web') return null;
        const metrics = deps.resolveWebScrollMetrics();
        if (!metrics) return null;
        if (!isWebTranscriptScrollable(metrics, 1)) return null;
        if (getWebTranscriptDistanceFromBottom(metrics) <= deps.pinThresholdPx) return null;
        const tuning = sync.getSyncTuning();
        return captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: deps.lastUserScrollIntentAtMsRef.current,
            stabilizeForMs: tuning.transcriptWebInitialPinStabilizeMs,
        });
    }, [
        deps.lastUserScrollIntentAtMsRef,
        deps.pinThresholdPx,
        deps.resolveWebScrollMetrics,
        webPrependRestoreOwner,
    ]);

    const captureNativeAnchor = React.useCallback((): NativePrependBeginInput['capturedAnchor'] => {
        const layoutHeight = deps.listLayoutHeightRef.current;
        const contentHeight = deps.listContentHeightRef.current;
        if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
        if (!Number.isFinite(contentHeight) || contentHeight <= layoutHeight + 1) return null;

        const result = captureNativeTranscriptViewportAnchor({
            ref: deps.listRef.current,
            data: deps.listDataRef.current,
            focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(layoutHeight),
            capturedAtMs: Date.now(),
            resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
        });
        if (result.status !== 'captured') return null;
        if (!Number.isFinite(result.anchor.itemOffsetPx)) return null;
        const anchorItemId = result.anchor.itemId;
        if (typeof anchorItemId !== 'string' || anchorItemId.length === 0) return null;
        return {
            key: { itemId: anchorItemId, messageId: result.anchor.messageId ?? null },
            itemOffsetPx: result.anchor.itemOffsetPx,
            capturedDataLength: deps.listDataRef.current.length,
            capturedFirstItemId: typeof deps.listDataRef.current[0]?.id === 'string'
                ? deps.listDataRef.current[0].id
                : null,
        };
    }, [
        deps.listContentHeightRef,
        deps.listDataRef,
        deps.listLayoutHeightRef,
        deps.listRef,
    ]);

    const beginNativeTransaction = React.useCallback((): boolean => {
        if (Platform.OS === 'web') return false;
        if (deps.wantsPinnedRef.current) return false;

        const buildInput = (): NativePrependBeginInput => ({
            activeOwner: deps.viewportCommandController.activeOwner(),
            capturedAnchor: captureNativeAnchor(),
            contentHeight: deps.listContentHeightRef.current,
            layoutHeight: deps.listLayoutHeightRef.current,
            preservePrependViewport: true,
            sessionId: deps.currentSessionId,
        });

        const firstEffects = nativeOwner.begin(buildInput());
        applyNativeEffectsRef.current(firstEffects);
        if (firstEffects.some((effect) => effect.type === 'preempt-entry-restore-for-prepend')) {
            const secondEffects = nativeOwner.begin(buildInput());
            applyNativeEffectsRef.current(secondEffects);
        }
        return nativeOwner.hasOpenTransaction(deps.currentSessionId);
    }, [
        captureNativeAnchor,
        deps.currentSessionId,
        deps.listContentHeightRef,
        deps.listLayoutHeightRef,
        deps.viewportCommandController,
        deps.wantsPinnedRef,
        nativeOwner,
    ]);

    const armNativeCommit = React.useCallback((layoutTimeoutMs: number) => {
        applyNativeEffectsRef.current(nativeOwner.armCommit({
            layoutTimeoutMs,
            sessionId: deps.currentSessionId,
        }));
    }, [
        deps.currentSessionId,
        nativeOwner,
    ]);

    const invalidateNativeTransaction = React.useCallback((
        reason: 'identity' | 'session-entry' | 'load-empty' | 'jump' | 'dispose' | 'ownership-rejected' = 'session-entry',
    ) => {
        applyNativeEffectsRef.current(nativeOwner.invalidate({
            activeOwner: deps.viewportCommandController.activeOwner(),
            reason,
            sessionId: deps.currentSessionId,
        }));
    }, [
        deps.currentSessionId,
        deps.viewportCommandController,
        nativeOwner,
    ]);

    const observeNative = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        applyNativeEffectsRef.current(nativeOwner.observe(
            resolveNativeObservationInput(deps.currentSessionId),
        ));
    }, [
        deps.currentSessionId,
        nativeOwner,
        resolveNativeObservationInput,
    ]);

    const refreshInFlightWebAnchor = React.useCallback((options?: Readonly<{ userScrolledDuringLoad?: boolean }>) => {
        if (webPrependRestoreOwner === 'renderer') return;
        if (Platform.OS !== 'web') return;
        applyWebEffectsRef.current(webOwner.refreshInFlightForUserScroll({
            anchor: captureWebAnchor(),
            sessionId: deps.currentSessionId,
            userScrolledDuringLoad: options?.userScrolledDuringLoad === true,
        }));
    }, [
        captureWebAnchor,
        deps.currentSessionId,
        webPrependRestoreOwner,
        webOwner,
    ]);

    const retargetPendingWebAnchorForUserScroll = React.useCallback(() => {
        if (webPrependRestoreOwner === 'renderer') {
            lastPrependGrowthRestoreScrollTopRef.current = null;
            return;
        }
        if (Platform.OS !== 'web') return;
        // Reset the layout-effect race guard: the scroll event has now fired, so the user's
        // intentional position is being canonicalized via retarget. Any subsequent growth
        // restore starts fresh — it hasn't dragged the user to a new landing point yet.
        lastPrependGrowthRestoreScrollTopRef.current = null;
        applyWebEffectsRef.current(webOwner.retargetPendingForUserScroll({
            anchor: captureWebAnchor(),
            sessionId: deps.currentSessionId,
        }));
    }, [
        captureWebAnchor,
        deps.currentSessionId,
        webPrependRestoreOwner,
        webOwner,
    ]);

    const runWebIndexRecovery = React.useCallback((): boolean => {
        if (webPrependRestoreOwner === 'renderer') return false;
        if (Platform.OS !== 'web') return false;
        const facts = webOwner.telemetryFacts({ items: deps.itemsRef.current });
        const recoveryIndex = typeof facts.pendingWebPrependAnchorIndex === 'number'
            ? facts.pendingWebPrependAnchorIndex
            : null;
        const recoveryAnchor = recoveryIndex == null
            ? null
            : resolveRestoreAnchorIdentityFromSourceIndex(deps.itemsRef.current, recoveryIndex);
        const effects = webOwner.retryPending({
            currentItemIndex: recoveryIndex,
            items: deps.itemsRef.current,
            nowMs: Date.now(),
            recoveryAnchor,
            sessionId: deps.currentSessionId,
        });
        applyWebEffectsRef.current(effects);
        return effects.some((effect) => (
            effect.type === 'execute-anchor-recovery' ||
            effect.type === 'execute-web-prepend-restore'
        ));
    }, [
        deps.currentSessionId,
        deps.itemsRef,
        webPrependRestoreOwner,
        webOwner,
    ]);
    runWebIndexRecoveryRef.current = runWebIndexRecovery;

    const observeWeb = React.useCallback(() => {
        if (webPrependRestoreOwner === 'renderer') return;
        if (Platform.OS !== 'web') return;
        const effects = webOwner.observePending({
            nowMs: Date.now(),
            sessionId: deps.currentSessionId,
        });
        applyWebEffectsRef.current(effects);
    }, [
        deps.currentSessionId,
        webPrependRestoreOwner,
        webOwner,
    ]);

    React.useEffect(() => {
        if (webPrependRestoreOwner !== 'renderer') return;
        lastPrependGrowthRestoreScrollTopRef.current = null;
        applyWebEffectsRef.current(webOwner.clear({
            outcome: 'abandoned-identity',
            sessionId: deps.currentSessionId,
        }));
        cancelScheduledWebIndexRecovery();
        cancelWebRestoreWindowExpiry();
        clearWebRangeReserve();
    }, [
        cancelScheduledWebIndexRecovery,
        cancelWebRestoreWindowExpiry,
        clearWebRangeReserve,
        deps.currentSessionId,
        webPrependRestoreOwner,
        webOwner,
    ]);

    React.useLayoutEffect(() => {
        observeWeb();
    }, [deps.listContentHeightRef.current, deps.listDataRef.current.length, observeWeb]);

    React.useLayoutEffect(() => {
        observeNative();
    }, [
        deps.currentSessionId,
        deps.listContentHeightRef.current,
        deps.listDataRef.current.length,
        observeNative,
    ]);

    return React.useMemo(() => ({
        applyNativeEffects,
        applyWebEffects,
        armNativeCommit,
        beginNativeTransaction,
        captureWebAnchor,
        clearWebRestoreWindow,
        clearWebRangeReserve,
        getNativeTransactionRevision: () => nativeTransactionRevisionRef.current,
        hasOpenNativeTransaction: (sessionId?: string) => nativeOwner.hasOpenTransaction(sessionId ?? deps.currentSessionId),
        hasWebRestoreWindow: () =>
            Platform.OS === 'web' &&
            webPrependRestoreOwner !== 'renderer' &&
            webOwner.hasRestoreWindow(),
        invalidateNativeTransaction,
        nativeTelemetryState: (sessionId?: string) => nativeOwner.telemetryState(sessionId ?? deps.currentSessionId),
        observeNative,
        observeWeb,
        recordCorrectorCorrection: (diffPx: number) => {
            applyNativeEffectsRef.current(nativeOwner.recordCorrectorCorrection({
                diffPx,
                sessionId: deps.currentSessionId,
            }));
        },
        refreshInFlightWebAnchor,
        retargetPendingWebAnchorForUserScroll,
        runWebIndexRecovery,
        slots: {
            rangeReservePx,
        },
        telemetryFacts: () => webOwner.telemetryFacts({ items: deps.itemsRef.current }),
        trustedNativeScroll: (input) => nativeOwner.trustedScroll(input),
        webAfterLoad: (params) => {
            if (webPrependRestoreOwner === 'renderer') return;
            applyWebEffectsRef.current(webOwner.afterLoad({
                activeOwner: deps.viewportCommandController.activeOwner(),
                loadedRowCount: params.loadedRowCount,
                nowMs: Date.now(),
                preservePrependViewport: params.preservePrependViewport,
                sessionId: deps.currentSessionId,
            }));
        },
        webBeforeLoad: (params) => {
            lastPrependGrowthRestoreScrollTopRef.current = null;
            if (webPrependRestoreOwner === 'renderer') return;
            applyWebEffectsRef.current(webOwner.beforeLoad({
                anchor: params.preservePrependViewport ? captureWebAnchor() : null,
                preservePrependViewport: params.preservePrependViewport,
                sessionId: deps.currentSessionId,
            }));
        },
        webClear: (outcome) => {
            if (webPrependRestoreOwner === 'renderer') {
                lastPrependGrowthRestoreScrollTopRef.current = null;
                clearWebRangeReserve();
                return;
            }
            applyWebEffectsRef.current(webOwner.clear({
                outcome,
                sessionId: deps.currentSessionId,
            }));
        },
    }), [
        applyNativeEffects,
        applyWebEffects,
        armNativeCommit,
        beginNativeTransaction,
        captureWebAnchor,
        clearWebRangeReserve,
        clearWebRestoreWindow,
        deps.currentSessionId,
        deps.itemsRef,
        deps.viewportCommandController,
        invalidateNativeTransaction,
        nativeOwner,
        observeNative,
        observeWeb,
        rangeReservePx,
        refreshInFlightWebAnchor,
        retargetPendingWebAnchorForUserScroll,
        runWebIndexRecovery,
        webPrependRestoreOwner,
        webOwner,
    ]);
}

function resolveRestoreAnchorIdentityFromSourceIndex(
    items: readonly ChatTranscriptListItem[],
    index: number,
) {
    if (!Number.isFinite(index)) return null;
    const item = items[Math.max(0, Math.trunc(index))] as ChatTranscriptListItem | undefined;
    return item ? resolveTranscriptViewportAnchorDescriptor(item) : null;
}

function executeCommandHostInput(
    commandHostRef: MutableRef<TranscriptViewportCommandHost | null>,
    input: Parameters<TranscriptViewportCommandHost['resolve']>[0],
) {
    const commandHost = commandHostRef.current;
    if (!commandHost) return false;
    return commandHost.execute(commandHost.resolve(input));
}
