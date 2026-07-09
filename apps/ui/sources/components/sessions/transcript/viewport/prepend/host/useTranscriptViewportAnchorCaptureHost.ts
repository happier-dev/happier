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
import type {
    TranscriptViewportTelemetryEvent,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type { TranscriptViewportMode } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type {
    ChatTranscriptListItem,
    TranscriptViewportChangeState,
} from '@/components/sessions/transcript/chatListTypes';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

type MutableRef<T> = { current: T };

type ScheduledViewportAnchorCapture = {
    captureAnchor: () => SessionViewportAnchorSnapshot | null;
    dueAtMs: number;
    emit: ((state: TranscriptViewportChangeState) => void) | undefined;
    generation: number;
    sessionId: string;
    state: TranscriptViewportChangeState;
    timeoutId: ReturnType<typeof setTimeout>;
    wantsPinned: boolean;
};

type ViewportAnchorCaptureHostDeps = Readonly<{
    cancelScheduledViewportAnchorCapture: () => void;
    currentSessionIdRef: MutableRef<string>;
    debounceMs: number;
    emitViewportChange: ((nextState: TranscriptViewportChangeState) => void) | undefined;
    listDataRef: MutableRef<readonly ChatTranscriptListItem[]>;
    listLayoutHeightRef: MutableRef<number>;
    listRef: MutableRef<ScrollableChatListRef | null>;
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

export function useTranscriptViewportAnchorCaptureHost(deps: ViewportAnchorCaptureHostDeps) {
    const captureCurrentViewportAnchor = React.useCallback((): SessionViewportAnchorSnapshot | null => {
        if (deps.wantsPinnedRef.current) return null;

        const capturedAtMs = Date.now();
        if (Platform.OS === 'web') {
            const metrics = deps.resolveWebScrollMetrics();
            if (!metrics) return null;
            const anchor = captureWebTranscriptViewportAnchor({ container: metrics.element });
            if (!anchor) return null;
            return {
                ...anchor,
                capturedAtMs,
            };
        }

        const result = captureNativeTranscriptViewportAnchor({
            ref: deps.listRef.current,
            data: deps.listDataRef.current,
            focusOffsetPx: resolveTranscriptViewportAnchorFocusOffsetPx(deps.listLayoutHeightRef.current),
            capturedAtMs,
            resolveAnchor: (item) => resolveTranscriptViewportAnchorDescriptor(item),
        });
        return result.status === 'captured' ? result.anchor : null;
    }, [
        deps.listDataRef,
        deps.listLayoutHeightRef,
        deps.listRef,
        deps.resolveWebScrollMetrics,
        deps.wantsPinnedRef,
    ]);

    const emitViewportAnchorCapture = React.useCallback((
        state: TranscriptViewportChangeState,
        generation: number,
        wantsPinned: boolean,
        emit: ((nextState: TranscriptViewportChangeState) => void) | undefined,
        captureAnchor: () => SessionViewportAnchorSnapshot | null,
        sessionId: string,
    ) => {
        const recordCaptureOutcome = (
            reason: 'anchor-captured' | 'anchor-capture-empty' | 'anchor-capture-dropped',
            anchorItemOffsetPx?: number,
        ) => {
            deps.recordViewportTelemetryEvent({
                type: 'anchor-capture',
                mode: 'user-unpinned',
                reason,
                distanceFromBottom: typeof state.offsetY === 'number' ? state.offsetY : undefined,
                anchorItemOffsetPx,
            }, { sessionId });
        };
        if (deps.viewportAnchorCaptureGenerationRef.current !== generation) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }
        if (sessionId !== deps.currentSessionIdRef.current) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }
        if (deps.shouldSuppressGenericViewportStateForProtectedJumpSeq()) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }
        if (state.shouldRestoreViewport !== true || state.isPinned === true || wantsPinned) {
            recordCaptureOutcome('anchor-capture-dropped');
            return;
        }

        const anchor = captureAnchor();
        recordCaptureOutcome(
            anchor ? 'anchor-captured' : 'anchor-capture-empty',
            anchor?.itemOffsetPx,
        );
        emit?.({
            ...state,
            anchor,
        });
    }, [
        deps.currentSessionIdRef,
        deps.recordViewportTelemetryEvent,
        deps.shouldSuppressGenericViewportStateForProtectedJumpSeq,
        deps.viewportAnchorCaptureGenerationRef,
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

        const captureAnchor = captureCurrentViewportAnchor;
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
                emitViewportAnchorCapture(
                    scheduled.state,
                    scheduled.generation,
                    scheduled.wantsPinned,
                    scheduled.emit,
                    scheduled.captureAnchor,
                    scheduled.sessionId,
                );
            }, Math.max(0, delayMs));
            return timeoutId;
        };
        const timeoutId = armTimeout(deps.debounceMs);
        deps.scheduledViewportAnchorCaptureRef.current = { captureAnchor, dueAtMs, emit, generation, sessionId, state, timeoutId, wantsPinned };
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
        const anchor = scheduled.captureAnchor();
        deps.recordViewportTelemetryEvent({
            type: 'anchor-capture',
            mode: 'user-unpinned',
            reason: anchor ? 'anchor-captured' : 'anchor-capture-empty',
            distanceFromBottom: typeof scheduled.state.offsetY === 'number' ? scheduled.state.offsetY : undefined,
            anchorItemOffsetPx: anchor?.itemOffsetPx,
        }, { sessionId: scheduled.sessionId });
        const emit = scheduled.emit;
        const state = scheduled.state;
        if (options?.deferEmit === true) {
            queueMicrotask(() => {
                emit?.({ ...state, anchor });
            });
            return;
        }
        emit?.({ ...state, anchor });
    }, [
        deps.currentSessionIdRef,
        deps.recordViewportTelemetryEvent,
        deps.scheduledViewportAnchorCaptureRef,
        deps.shouldSuppressGenericViewportStateForProtectedJumpSeq,
        deps.viewportAnchorCaptureGenerationRef,
    ]);

    return React.useMemo(() => ({
        flush,
        schedule,
    }), [
        flush,
        schedule,
    ]);
}
