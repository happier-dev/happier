import * as React from 'react';

import type { TranscriptJumpResult } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';

/**
 * Canonical jump-landing highlight timing (spec: 1200-1800ms total, subtle wash, fade out).
 * The store owns expiry: a highlight is set when a transcript jump lands and is
 * automatically cleared after the full duration. Consumers render the wash and
 * run the fade inside that window.
 */
export const TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS = 1400;
export const TRANSCRIPT_JUMP_HIGHLIGHT_FADE_MS = 450;

export type TranscriptJumpHighlightRowIdentity = Readonly<{
    sessionId: string;
    routeMessageId?: string | null;
    seq?: number | null;
}>;

export type ActiveTranscriptJumpHighlight = Readonly<{
    sessionId: string;
    routeMessageId: string | null;
    seq: number | null;
    token: number;
}>;

export type TranscriptJumpLandedResult = Extract<TranscriptJumpResult, { status: 'scrolled' | 'window-rendered' }>;

function normalizeSessionId(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRouteMessageId(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = Math.trunc(value);
    return normalized >= 0 ? normalized : null;
}

let activeHighlight: ActiveTranscriptJumpHighlight | null = null;
let nextToken = 1;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
    for (const listener of listeners) {
        listener();
    }
}

function cancelExpiryTimer(): void {
    if (expiryTimer != null) {
        clearTimeout(expiryTimer);
        expiryTimer = null;
    }
}

export function subscribeToTranscriptJumpHighlight(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function readActiveTranscriptJumpHighlight(): ActiveTranscriptJumpHighlight | null {
    return activeHighlight;
}

export function clearTranscriptJumpHighlight(): void {
    cancelExpiryTimer();
    if (activeHighlight == null) return;
    activeHighlight = null;
    notifyListeners();
}

export function setTranscriptJumpHighlight(identity: TranscriptJumpHighlightRowIdentity): void {
    const sessionId = normalizeSessionId(identity.sessionId);
    const routeMessageId = normalizeRouteMessageId(identity.routeMessageId);
    const seq = normalizeSeq(identity.seq);
    if (!sessionId || (routeMessageId == null && seq == null)) return;

    cancelExpiryTimer();
    activeHighlight = {
        sessionId,
        routeMessageId,
        seq,
        token: nextToken,
    };
    nextToken += 1;
    const expiringToken = activeHighlight.token;
    expiryTimer = setTimeout(() => {
        expiryTimer = null;
        if (activeHighlight?.token !== expiringToken) return;
        activeHighlight = null;
        notifyListeners();
    }, TRANSCRIPT_JUMP_HIGHLIGHT_DURATION_MS);
    notifyListeners();
}

/**
 * Maps a successful unified-jump result (`onJumpLanded` seam) onto the highlight store.
 * routeMessageId is the primary row identity; seq (or seqHint) is the fallback.
 */
export function applyTranscriptJumpHighlightForJumpResult(
    sessionId: string,
    result: TranscriptJumpLandedResult,
): void {
    const target = result.target;
    if (target.kind === 'seq') {
        setTranscriptJumpHighlight({ sessionId, routeMessageId: null, seq: target.seq });
        return;
    }
    setTranscriptJumpHighlight({
        sessionId,
        routeMessageId: target.routeMessageId,
        seq: target.seqHint ?? null,
    });
}

export function isTranscriptJumpHighlightActiveForRow(
    active: ActiveTranscriptJumpHighlight,
    row: TranscriptJumpHighlightRowIdentity,
): boolean {
    if (active.sessionId !== normalizeSessionId(row.sessionId)) return false;
    const rowRouteMessageId = normalizeRouteMessageId(row.routeMessageId);
    const rowSeq = normalizeSeq(row.seq);
    if (active.routeMessageId != null && rowRouteMessageId != null) {
        return active.routeMessageId === rowRouteMessageId;
    }
    if (active.seq != null && rowSeq != null) {
        return active.seq === rowSeq;
    }
    return false;
}

/**
 * Per-row subscription. Returns the active highlight token when this row is the
 * jump target, otherwise null. Snapshot is a primitive so only the target row
 * re-renders when the highlight changes (useSyncExternalStore bail-out).
 */
export function useTranscriptJumpHighlight(row: TranscriptJumpHighlightRowIdentity): number | null {
    const { sessionId, routeMessageId = null, seq = null } = row;
    const getSnapshot = React.useCallback(() => {
        const active = activeHighlight;
        if (active == null) return null;
        return isTranscriptJumpHighlightActiveForRow(active, { sessionId, routeMessageId, seq })
            ? active.token
            : null;
    }, [sessionId, routeMessageId, seq]);
    return React.useSyncExternalStore(subscribeToTranscriptJumpHighlight, getSnapshot, getSnapshot);
}
