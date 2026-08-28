import * as React from 'react';
import { Platform } from 'react-native';
import type { SessionViewportAnchorSnapshot } from '@/sync/sync';
import {
    captureNativeTranscriptViewportAnchor,
} from '@/components/sessions/transcript/viewport/driver/transcriptNativeViewportAnchor';
import {
    resolveTranscriptViewportAnchorDescriptor,
    resolveTranscriptViewportAnchorFocusOffsetPx,
} from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import {
    captureWebTranscriptViewportAnchor,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { TranscriptRendererNativePhysicalViewportCapture } from '@/components/sessions/transcript/viewport/shell/renderer/types';
import type {
    TranscriptViewportTelemetryEvent,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptViewportMode } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type {
    ChatTranscriptListItem,
    TranscriptViewportChangeState,
} from '@/components/sessions/transcript/chatListTypes';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptExitSnapshotSelection } from '@/components/sessions/transcript/viewport/lifecycle/transcriptSameSessionHandoff';

type MutableRef<T> = { current: T };

export type ViewportAnchorCaptureAttempt = Readonly<{
    anchor: SessionViewportAnchorSnapshot | null;
    /**
     * Distance captured from the same fire-time geometry observation as `anchor`.
     * `null` means web geometry was unavailable and no stale scheduled
     * distance may be persisted; `undefined` keeps the scheduled event distance.
     */
    fireTimeOffsetY?: number | null;
    /** Machine-readable cause for an empty capture, surfaced in telemetry. */
    failureStatus?: string;
    /**
     * True when the failure is transient (live geometry existed but no row was
     * measurable/anchorable yet — row-measurement churn); false for structural
     * failures (no geometry, missing list methods) where retrying cannot help.
     */
    retryWorthy: boolean;
    /** One renderer-owned Fabric observation is still completing for this generation. */
    pending?: boolean;
}>;

export type ScheduledViewportAnchorCapture = {
    captureAnchor: (
        onNativePhysicalComplete?: (attempt: ViewportAnchorCaptureAttempt) => void,
    ) => ViewportAnchorCaptureAttempt;
    dueAtMs: number;
    emit: ((state: TranscriptViewportChangeState) => void) | undefined;
    /** Remaining fire-time retries after an EMPTY capture (row-measurement churn). */
    emptyCaptureRetriesRemaining: number;
    generation: number;
    sessionId: string;
    state: TranscriptViewportChangeState;
    timeoutId: ReturnType<typeof setTimeout>;
    wantsPinned: boolean;
};

/**
 * A capture that fires mid row-measurement churn (streaming sessions re-measure
 * constantly) legitimately finds no measurable anchor row. Retrying on the
 * debounce cadence lets a quiescent gap still produce a durable identity before
 * the offset-only fallback persists (live clamp-to-tail defect, 2026-07-13).
 */
const EMPTY_CAPTURE_RETRY_LIMIT = 3;

type ViewportAnchorCaptureHostDeps = Readonly<{
    cancelScheduledViewportAnchorCapture: () => void;
    currentSessionIdRef: MutableRef<string>;
    debounceMs: number;
    emitViewportChange: ((nextState: TranscriptViewportChangeState) => void) | undefined;
    isEntryViewportCommandActive: () => boolean;
    listDataRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
    pinThresholdPx: number;
    readCurrentNativeDistanceFromBottom: () => number | null;
    recordViewportTelemetryEvent: (
        event: Readonly<Record<string, unknown> & {
            mode: TranscriptViewportMode;
            type: TranscriptViewportTelemetryEvent['type'];
        }>,
        options?: Readonly<{ sessionId?: string }>,
    ) => void;
    resolveWebScrollMetrics: () => WebTranscriptScrollMetrics | null;
    scheduledViewportAnchorCaptureRef: MutableRef<ScheduledViewportAnchorCapture | null>;
    shouldSuppressGenericViewportStateForProtectedJumpSeq: () => boolean;
    viewportAnchorCaptureGenerationRef: MutableRef<number>;
    wantsPinnedRef: MutableRef<boolean>;
}>;

/**
 * Detachment truth for unforgeable input (wheel / takeover keyboard): when live geometry shows
 * the viewport beyond the pin threshold, the input itself schedules the debounced anchor
 * capture. Scroll-frame genuineness classification can starve for whole detaches in giant-row
 * sessions (layout churn on nearly every frame breaks both the eager and sustained paths), so
 * capture persistence must not depend on it (live A->B->A RED 2026-07-11).
 */
export function resolveDetachedInputAnchorCaptureState(
    metrics: WebTranscriptScrollMetrics | null,
    pinThresholdPx: number,
): Readonly<{ isPinned: false; offsetY: number; shouldRestoreViewport: true }> | null {
    if (!metrics) return null;
    const offsetY = Math.max(0, Math.round(metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop));
    if (offsetY <= Math.max(0, pinThresholdPx)) return null;
    return {
        isPinned: false,
        offsetY,
        shouldRestoreViewport: true,
    };
}

export function useTranscriptViewportAnchorCaptureHost(deps: ViewportAnchorCaptureHostDeps) {
    const captureCurrentViewportAnchor = React.useCallback((
        observedWebMetrics?: WebTranscriptScrollMetrics,
        options?: Readonly<{ allowStalePinnedIntent?: boolean }>,
        onNativePhysicalComplete?: (attempt: ViewportAnchorCaptureAttempt) => void,
    ): ViewportAnchorCaptureAttempt => {
        if (deps.wantsPinnedRef.current && options?.allowStalePinnedIntent !== true) {
            return { anchor: null, failureStatus: 'wants_pinned', retryWorthy: false };
        }

        const capturedAtMs = Date.now();
        if (Platform.OS === 'web' || observedWebMetrics !== undefined) {
            const metrics = observedWebMetrics ?? deps.resolveWebScrollMetrics();
            if (!metrics) {
                return {
                    anchor: null,
                    failureStatus: 'no_web_metrics',
                    fireTimeOffsetY: null,
                    retryWorthy: false,
                };
            }
            const fireTimeOffsetY = Math.max(
                0,
                Math.round(metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop),
            );
            const anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
            if (!anchor) {
                return {
                    anchor: null,
                    failureStatus: 'web_anchor_unresolved',
                    fireTimeOffsetY,
                    retryWorthy: true,
                };
            }
            return {
                anchor: {
                    ...anchor,
                    capturedAtMs,
                },
                fireTimeOffsetY,
                retryWorthy: false,
            };
        }

        const listRef = deps.listRef.current;
        const observeNativePhysicalViewport = listRef?.observeNativePhysicalViewport;
        const resolveNativePhysicalCapture = (
            capture: TranscriptRendererNativePhysicalViewportCapture | null,
        ): ViewportAnchorCaptureAttempt => {
            if (!capture) {
                return {
                    anchor: null,
                    failureStatus: 'native_physical_unavailable',
                    fireTimeOffsetY: null,
                    retryWorthy: false,
                };
            }
            const itemIndex = capture.itemIndex;
            const item = Number.isInteger(itemIndex) && itemIndex >= 0
                ? deps.listDataRef.current[itemIndex]
                : undefined;
            const descriptor = item === undefined
                ? null
                : resolveTranscriptViewportAnchorDescriptor(item);
            if (
                capture.dataKey !== deps.currentSessionIdRef.current
                || descriptor == null
                || descriptor.itemId !== capture.itemKey
                || !Number.isFinite(capture.capturedAtMs)
                || !Number.isFinite(capture.itemOffsetPx)
                || !Number.isFinite(capture.offsetY)
            ) {
                return {
                    anchor: null,
                    failureStatus: 'native_physical_identity_mismatch',
                    fireTimeOffsetY: null,
                    retryWorthy: false,
                };
            }
            return {
                anchor: {
                    ...descriptor,
                    capturedAtMs: capture.capturedAtMs,
                    itemOffsetPx: capture.itemOffsetPx,
                },
                fireTimeOffsetY: Math.max(0, capture.offsetY),
                retryWorthy: false,
            };
        };
        if (typeof observeNativePhysicalViewport === 'function') {
            const observation = observeNativePhysicalViewport({
                focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(
                    deps.listLayoutHeightRef.current,
                ),
                onComplete: onNativePhysicalComplete
                    ? (capture) => onNativePhysicalComplete(
                        deps.listRef.current === listRef
                            ? resolveNativePhysicalCapture(capture)
                            : {
                                anchor: null,
                                failureStatus: 'native_physical_renderer_changed',
                                fireTimeOffsetY: null,
                                retryWorthy: false,
                            },
                    )
                    : undefined,
            });
            if (observation.status === 'captured') {
                return resolveNativePhysicalCapture(observation.capture);
            }
            if (observation.status === 'pending') {
                return {
                    anchor: null,
                    failureStatus: 'native_physical_pending',
                    fireTimeOffsetY: null,
                    pending: true,
                    retryWorthy: false,
                };
            }
            return {
                anchor: null,
                failureStatus: 'native_physical_unavailable',
                fireTimeOffsetY: null,
                retryWorthy: false,
            };
        }

        const result = captureNativeTranscriptViewportAnchor({
            ref: listRef,
            data: deps.listDataRef.current,
            focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(deps.listLayoutHeightRef.current),
            capturedAtMs,
            resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
        });
        const fireTimeOffsetY = deps.readCurrentNativeDistanceFromBottom();
        if (result.status === 'captured') {
            return {
                anchor: result.anchor,
                fireTimeOffsetY: fireTimeOffsetY ?? undefined,
                retryWorthy: false,
            };
        }
        return {
            anchor: null,
            fireTimeOffsetY: fireTimeOffsetY ?? undefined,
            failureStatus: result.status === 'methods_unavailable'
                ? `methods_unavailable:${result.missingMethods.join(',')}`
                : result.status,
            retryWorthy:
                result.status === 'no_measurable_items' ||
                result.status === 'no_anchorable_item' ||
                result.status === 'no_visible_indices',
        };
    }, [
        deps.listDataRef,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.readCurrentNativeDistanceFromBottom,
        deps.resolveWebScrollMetrics,
        deps.wantsPinnedRef,
    ]);

    const emitViewportAnchorCapture = React.useCallback((
        state: TranscriptViewportChangeState,
        generation: number,
        wantsPinned: boolean,
        emit: ((nextState: TranscriptViewportChangeState) => void) | undefined,
        captureAnchor: (
            onNativePhysicalComplete?: (attempt: ViewportAnchorCaptureAttempt) => void,
        ) => ViewportAnchorCaptureAttempt,
        sessionId: string,
        options?: Readonly<{
            allowEmptyCaptureRetry?: boolean;
            onNativePhysicalComplete?: (attempt: ViewportAnchorCaptureAttempt) => void;
        }>,
    ): 'dropped' | 'emitted' | 'pending' | 'retry' => {
        const recordCaptureOutcome = (
            reason: 'anchor-captured' | 'anchor-capture-empty' | 'anchor-capture-dropped',
            anchorItemOffsetPx?: number,
            captureFailureStatus?: string,
            distanceFromBottom: number | undefined = state.offsetY,
        ) => {
            deps.recordViewportTelemetryEvent({
                type: 'anchor-capture',
                mode: 'user-unpinned',
                reason,
                distanceFromBottom,
                anchorItemOffsetPx,
                captureFailureStatus,
            }, { sessionId });
        };
        if (deps.viewportAnchorCaptureGenerationRef.current !== generation) {
            recordCaptureOutcome('anchor-capture-dropped');
            return 'dropped';
        }
        if (sessionId !== deps.currentSessionIdRef.current) {
            recordCaptureOutcome('anchor-capture-dropped');
            return 'dropped';
        }
        if (deps.shouldSuppressGenericViewportStateForProtectedJumpSeq()) {
            recordCaptureOutcome('anchor-capture-dropped');
            return 'dropped';
        }
        if (state.shouldRestoreViewport !== true || state.isPinned === true || wantsPinned) {
            recordCaptureOutcome('anchor-capture-dropped');
            return 'dropped';
        }
        // Fire-time truth outranks schedule-time state (S-G, 2026-07-11): a descent to the
        // tail keeps rescheduling detached-input captures with descent-time offsets, and the
        // debounce can fire AFTER the user re-pinned (live-tail intent already deleted the
        // persisted record). Persisting the stale schedule-time snapshot re-created the
        // detached record and the next session entry restored the mid-descent position.
        if (deps.wantsPinnedRef.current) {
            recordCaptureOutcome('anchor-capture-dropped');
            return 'dropped';
        }

        const attempt = captureAnchor(options?.onNativePhysicalComplete);
        if (attempt.pending) return 'pending';
        const anchor = attempt.anchor;
        const fireTimeState = attempt.fireTimeOffsetY === null
            ? null
            : typeof attempt.fireTimeOffsetY === 'number'
                ? { ...state, offsetY: attempt.fireTimeOffsetY }
                : state;
        recordCaptureOutcome(
            anchor ? 'anchor-captured' : 'anchor-capture-empty',
            anchor?.itemOffsetPx,
            attempt.failureStatus,
            fireTimeState && typeof fireTimeState.offsetY === 'number'
                ? fireTimeState.offsetY
                : undefined,
        );
        if (!anchor && attempt.retryWorthy && options?.allowEmptyCaptureRetry === true) {
            return 'retry';
        }
        // No live web geometry means there is no coherent identity+distance
        // observation to persist. Preserve the prior durable record.
        if (fireTimeState === null) return 'dropped';
        // Additive persistence: an omitted anchor field preserves the stored identity in
        // sync; an explicit null would clear a good anchor a previous capture persisted.
        emit?.(anchor ? { ...fireTimeState, anchor } : { ...fireTimeState });
        return 'emitted';
    }, [
        deps.currentSessionIdRef,
        deps.recordViewportTelemetryEvent,
        deps.shouldSuppressGenericViewportStateForProtectedJumpSeq,
        deps.viewportAnchorCaptureGenerationRef,
        deps.wantsPinnedRef,
    ]);

    const schedule = React.useCallback((
        state: TranscriptViewportChangeState,
        options?: Readonly<{ suppressAnchorCapture?: boolean }>,
    ) => {
        if (deps.shouldSuppressGenericViewportStateForProtectedJumpSeq()) return;
        if (options?.suppressAnchorCapture === true) return;

        if (state.shouldRestoreViewport !== true || state.isPinned === true) {
            deps.viewportAnchorCaptureGenerationRef.current += 1;
            deps.cancelScheduledViewportAnchorCapture();
            return;
        }

        const captureAnchor = (
            onNativePhysicalComplete?: (attempt: ViewportAnchorCaptureAttempt) => void,
        ) => captureCurrentViewportAnchor(undefined, undefined, onNativePhysicalComplete);
        const dueAtMs = Date.now() + deps.debounceMs;
        const emit = deps.emitViewportChange;
        const generation = deps.viewportAnchorCaptureGenerationRef.current;
        const sessionId = deps.currentSessionIdRef.current;
        const wantsPinned = deps.wantsPinnedRef.current;
        const existing = deps.scheduledViewportAnchorCaptureRef.current;
        if (existing && existing.generation === generation && existing.sessionId === sessionId) {
            existing.captureAnchor = captureAnchor;
            existing.dueAtMs = dueAtMs;
            existing.emit = emit;
            existing.state = state;
            existing.wantsPinned = wantsPinned;
            return;
        }
        deps.cancelScheduledViewportAnchorCapture();
        const armTimeout = (delayMs: number): ReturnType<typeof setTimeout> => {
            const timeoutId = setTimeout(() => {
                const scheduled = deps.scheduledViewportAnchorCaptureRef.current;
                if (!scheduled || scheduled.timeoutId !== timeoutId) return;
                const remainingMs = scheduled.dueAtMs - Date.now();
                if (remainingMs > 0) {
                    scheduled.timeoutId = armTimeout(remainingMs);
                    return;
                }
                deps.scheduledViewportAnchorCaptureRef.current = null;
                const completeNativePhysicalCapture = (attempt: ViewportAnchorCaptureAttempt) => {
                    emitViewportAnchorCapture(
                        scheduled.state,
                        scheduled.generation,
                        scheduled.wantsPinned,
                        scheduled.emit,
                        () => attempt,
                        scheduled.sessionId,
                    );
                };
                const verdict = emitViewportAnchorCapture(
                    scheduled.state,
                    scheduled.generation,
                    scheduled.wantsPinned,
                    scheduled.emit,
                    scheduled.captureAnchor,
                    scheduled.sessionId,
                    {
                        allowEmptyCaptureRetry: scheduled.emptyCaptureRetriesRemaining > 0,
                        onNativePhysicalComplete: completeNativePhysicalCapture,
                    },
                );
                if (verdict !== 'retry') return;
                const retried: ScheduledViewportAnchorCapture = {
                    ...scheduled,
                    dueAtMs: Date.now() + deps.debounceMs,
                    emptyCaptureRetriesRemaining: scheduled.emptyCaptureRetriesRemaining - 1,
                };
                deps.scheduledViewportAnchorCaptureRef.current = retried;
                retried.timeoutId = armTimeout(deps.debounceMs);
            }, Math.max(0, delayMs));
            return timeoutId;
        };
        const timeoutId = armTimeout(deps.debounceMs);
        deps.scheduledViewportAnchorCaptureRef.current = {
            captureAnchor,
            dueAtMs,
            emit,
            emptyCaptureRetriesRemaining: EMPTY_CAPTURE_RETRY_LIMIT,
            generation,
            sessionId,
            state,
            timeoutId,
            wantsPinned,
        };
    }, [
        captureCurrentViewportAnchor,
        deps.cancelScheduledViewportAnchorCapture,
        deps.currentSessionIdRef,
        deps.debounceMs,
        deps.emitViewportChange,
        deps.scheduledViewportAnchorCaptureRef,
        deps.shouldSuppressGenericViewportStateForProtectedJumpSeq,
        deps.viewportAnchorCaptureGenerationRef,
        deps.wantsPinnedRef,
        emitViewportAnchorCapture,
    ]);

    // External (untrusted/layout-caused) movement inside the debounce window must re-debounce
    // the pending capture, never destroy it: the capture callback reads fresh geometry at fire
    // time, so once movement quiesces the settled truth is exactly what should be captured.
    // Hard invalidation here left shallow detaches with NO persisted anchor/offset whenever a
    // trailing Legend estimate-correction scroll landed within the window (live A->B->A RED:
    // re-entry then restored distance-oneshot(0) = live tail).
    const defer = React.useCallback(() => {
        const scheduled = deps.scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        scheduled.dueAtMs = Date.now() + deps.debounceMs;
    }, [deps.debounceMs, deps.scheduledViewportAnchorCaptureRef]);

    const flush = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
        const scheduled = deps.scheduledViewportAnchorCaptureRef.current;
        if (!scheduled) return;
        deps.scheduledViewportAnchorCaptureRef.current = null;
        clearTimeout(scheduled.timeoutId);
        if (scheduled.generation !== deps.viewportAnchorCaptureGenerationRef.current) return;
        if (scheduled.sessionId !== deps.currentSessionIdRef.current) return;
        if (deps.shouldSuppressGenericViewportStateForProtectedJumpSeq()) {
            deps.recordViewportTelemetryEvent({
                type: 'anchor-capture',
                mode: 'user-unpinned',
                reason: 'anchor-capture-dropped',
                distanceFromBottom: typeof scheduled.state.offsetY === 'number' ? scheduled.state.offsetY : undefined,
            }, { sessionId: scheduled.sessionId });
            return;
        }
        if (scheduled.state.shouldRestoreViewport !== true || scheduled.state.isPinned === true || scheduled.wantsPinned) {
            return;
        }
        // Fire-time truth (S-G): a re-pinned viewport never persists a pending detached
        // capture at flush/exit — live-tail intent already owns the persisted state.
        if (deps.wantsPinnedRef.current) {
            return;
        }
        const flushAttempt = scheduled.captureAnchor();
        const anchor = flushAttempt.anchor;
        const fireTimeState = flushAttempt.fireTimeOffsetY === null
            ? null
            : typeof flushAttempt.fireTimeOffsetY === 'number'
                ? { ...scheduled.state, offsetY: flushAttempt.fireTimeOffsetY }
                : scheduled.state;
        deps.recordViewportTelemetryEvent({
            type: 'anchor-capture',
            mode: 'user-unpinned',
            reason: anchor ? 'anchor-captured' : 'anchor-capture-empty',
            distanceFromBottom: fireTimeState && typeof fireTimeState.offsetY === 'number'
                ? fireTimeState.offsetY
                : undefined,
            anchorItemOffsetPx: anchor?.itemOffsetPx,
            captureFailureStatus: flushAttempt.failureStatus,
        }, { sessionId: scheduled.sessionId });
        if (fireTimeState === null) return;
        const emit = scheduled.emit;
        // Exit is final (no retry budget): persist additively so an empty capture keeps
        // the previously stored identity instead of clearing it with an explicit null.
        const nextState = anchor ? { ...fireTimeState, anchor } : { ...fireTimeState };
        if (options?.deferEmit === true) {
            queueMicrotask(() => {
                emit?.(nextState);
            });
            return;
        }
        emit?.(nextState);
    }, [
        deps.currentSessionIdRef,
        deps.recordViewportTelemetryEvent,
        deps.scheduledViewportAnchorCaptureRef,
        deps.shouldSuppressGenericViewportStateForProtectedJumpSeq,
        deps.viewportAnchorCaptureGenerationRef,
        deps.wantsPinnedRef,
    ]);

    // Session exit is the canonical persistence choke point for the detached viewport truth:
    // per-event web genuineness classification can miss an entire shallow detach (live A->B->A
    // RED 2026-07-11: no qualifying observation was ever produced, nothing was scheduled, and
    // re-entry restored the live tail). Exit replaces any pending observation with one
    // fire-time physical snapshot.
    const captureAtExit = React.useCallback((
        options?: Readonly<{ deferEmit?: boolean }>,
    ): TranscriptExitSnapshotSelection | null => {
        if (deps.shouldSuppressGenericViewportStateForProtectedJumpSeq()) return null;
        if (
            deps.isEntryViewportCommandActive()
            || deps.listRef.current?.hasActiveEntryPlacement?.() === true
        ) {
            // The entry owner may still be displaying estimate-phase geometry. Preserve its
            // durable intent and prevent a pending generic capture from publishing after the
            // app backgrounds. Explicit jump promotion remains selected before this physical
            // capture choke point.
            deps.cancelScheduledViewportAnchorCapture();
            return null;
        }
        const sessionId = deps.currentSessionIdRef.current;
        const emit = deps.emitViewportChange;
        const selectPinnedExit = (): TranscriptExitSnapshotSelection => {
            const state: TranscriptViewportChangeState = {
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            };
            if (options?.deferEmit === true) {
                queueMicrotask(() => {
                    emit?.(state);
                });
            } else {
                emit?.(state);
            }
            return {
                source: 'physical-exit',
                viewport: {
                    anchor: null,
                    capturedAtMs: Date.now(),
                    isPinned: true,
                    offsetY: 0,
                    shouldRestoreViewport: false,
                },
            };
        };
        deps.cancelScheduledViewportAnchorCapture();
        if (Platform.OS === 'web') {
            if (deps.listRef.current?.hasLiveWebHold?.({ kind: 'end' }) === true) {
                // The renderer's held-end transaction is the authoritative web tail intent.
                // During keyed teardown, browser geometry can transiently reflect a partially
                // dismantled virtual window; persisting that offset as a user detach poisons the
                // next open even though no transcript input occurred.
                return selectPinnedExit();
            }
            if (deps.listRef.current?.hasLiveWebHold?.({ kind: 'item' }) === true) {
                // A keyed hold is the detached twin of held-end: it already names the durable
                // viewport the renderer is preserving. Teardown geometry is not a new reader
                // decision and must not replace that identity with a partially dismantled window.
                return null;
            }
        }
        const metrics = Platform.OS === 'web' ? deps.resolveWebScrollMetrics() : null;
        const nativePhysicalAttempt = Platform.OS !== 'web'
            && typeof deps.listRef.current?.observeNativePhysicalViewport === 'function'
            ? captureCurrentViewportAnchor(
                undefined,
                { allowStalePinnedIntent: true },
            )
            : null;
        const offsetY = nativePhysicalAttempt
            ? nativePhysicalAttempt.fireTimeOffsetY
            : metrics
                ? Math.max(0, Math.round(metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop))
                : deps.readCurrentNativeDistanceFromBottom();
        // Exit has one physical-state owner on both platforms. It replaces any scheduled
        // observation with the fire-time geometry: within the canonical pin threshold is
        // live-tail intent; beyond it is detached identity+distance. Without geometry, keep
        // the prior durable state unchanged.
        if (typeof offsetY !== 'number' || !Number.isFinite(offsetY)) return null;
        if (offsetY <= Math.max(0, deps.pinThresholdPx)) {
            return selectPinnedExit();
        }
        const exitAttempt = nativePhysicalAttempt ?? captureCurrentViewportAnchor(
            metrics ?? undefined,
            { allowStalePinnedIntent: true },
        );
        const anchor = exitAttempt.anchor;
        deps.recordViewportTelemetryEvent({
            type: 'anchor-capture',
            mode: 'user-unpinned',
            reason: anchor ? 'anchor-captured' : 'anchor-capture-empty',
            distanceFromBottom: offsetY,
            anchorItemOffsetPx: anchor?.itemOffsetPx,
            captureFailureStatus: exitAttempt.failureStatus,
        }, { sessionId });
        // Detached persistence is atomic. Without identity from the same observation as
        // distance, preserve the complete prior durable viewport and return no handoff.
        if (!anchor && nativePhysicalAttempt) return null;
        const state = anchor
            ? {
                anchor,
                isPinned: false,
                offsetY,
                shouldRestoreViewport: true,
            }
            : {
                isPinned: false,
                offsetY,
                shouldRestoreViewport: true,
            };
        if (options?.deferEmit === true) {
            queueMicrotask(() => {
                emit?.(state);
            });
        } else {
            emit?.(state);
        }
        if (!anchor) return null;
        return {
            source: 'physical-exit',
            viewport: {
                anchor,
                capturedAtMs: anchor.capturedAtMs,
                isPinned: false,
                offsetY,
                shouldRestoreViewport: true,
            },
        };
    }, [
        captureCurrentViewportAnchor,
        deps.cancelScheduledViewportAnchorCapture,
        deps.currentSessionIdRef,
        deps.emitViewportChange,
        deps.isEntryViewportCommandActive,
        deps.listRef,
        deps.pinThresholdPx,
        deps.readCurrentNativeDistanceFromBottom,
        deps.recordViewportTelemetryEvent,
        deps.resolveWebScrollMetrics,
        deps.shouldSuppressGenericViewportStateForProtectedJumpSeq,
    ]);

    return React.useMemo(() => ({
        captureAtExit,
        defer,
        flush,
        schedule,
    }), [
        captureAtExit,
        defer,
        flush,
        schedule,
    ]);
}
