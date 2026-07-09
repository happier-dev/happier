import * as React from 'react';
import type { EntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import type { SessionEntryViewportRefValue } from '@/components/sessions/transcript/viewport/entryRestore/host/useTranscriptSessionEntryLifecycle';

type MutableRef<T> = { current: T };

type NativeEntryRestorePaintReleaseTimeout = {
    issuedAtMs: number;
    sessionId: string;
    timeoutId: ReturnType<typeof setTimeout>;
} | null;

const TRANSCRIPT_NATIVE_ENTRY_RESTORE_PAINT_RELEASE_DELAY_MS = 32;

export function useTranscriptNativeEntryRestorePaintRelease(params: Readonly<{
    currentSessionIdRef: MutableRef<string>;
    entryRestoreOwner: EntryRestoreOwner;
    nativeEntryRestorePaintReleaseTimeoutRef: MutableRef<NativeEntryRestorePaintReleaseTimeout>;
    nativeViewportPaintObservedRef: MutableRef<boolean>;
    platformOS: string;
    readViewportContentMetrics(): Readonly<{ contentHeight: number; layoutHeight: number }> | null;
    sessionActive: boolean;
    sessionEntryViewportRef: MutableRef<SessionEntryViewportRefValue>;
    sessionId: string;
}>) {
    const {
        currentSessionIdRef,
        entryRestoreOwner,
        nativeEntryRestorePaintReleaseTimeoutRef,
        nativeViewportPaintObservedRef,
        platformOS,
        readViewportContentMetrics,
        sessionActive,
        sessionEntryViewportRef,
        sessionId,
    } = params;

    const [nativeEntryRestorePaintReleaseState, setNativeEntryRestorePaintReleaseState] = React.useState<{
        released: boolean;
        sessionId: string;
    }>(() => ({
        released: false,
        sessionId,
    }));
    const nativeEntryRestorePaintReleasedRef = React.useRef<{
        released: boolean;
        sessionId: string;
    }>({
        released: false,
        sessionId,
    });
    const nativeEntryRestorePaintReleased =
        nativeEntryRestorePaintReleaseState.sessionId === sessionId &&
        nativeEntryRestorePaintReleaseState.released;

    const updateNativeEntryRestorePaintReleased = React.useCallback((released: boolean) => {
        if (platformOS === 'web') return;
        const nextState = {
            released,
            sessionId,
        };
        nativeEntryRestorePaintReleasedRef.current = nextState;
        setNativeEntryRestorePaintReleaseState(nextState);
    }, [platformOS, sessionId]);

    const releaseNativePaintForIssuedEntryRestore = React.useCallback(() => {
        if (platformOS === 'web') return false;
        if (nativeViewportPaintObservedRef.current) return false;
        if (
            nativeEntryRestorePaintReleasedRef.current.sessionId === sessionId &&
            nativeEntryRestorePaintReleasedRef.current.released
        ) {
            return false;
        }
        const contentMetrics = readViewportContentMetrics();
        if (!contentMetrics || contentMetrics.contentHeight <= 0) return false;
        if (sessionEntryViewportRef.current?.sessionId !== sessionId) return false;
        if (sessionEntryViewportRef.current.shouldFollowBottom !== false) return false;
        if (!entryRestoreOwner.hasOpenTransaction(sessionId)) return false;
        updateNativeEntryRestorePaintReleased(true);
        return true;
    }, [
        entryRestoreOwner,
        nativeViewportPaintObservedRef,
        platformOS,
        readViewportContentMetrics,
        sessionEntryViewportRef,
        sessionId,
        updateNativeEntryRestorePaintReleased,
    ]);

    const scheduleNativePaintReleaseForEntryRestore = React.useCallback((options?: Readonly<{ force?: boolean }>) => {
        if (platformOS === 'web') return;
        if (options?.force !== true && sessionActive) return;
        if (nativeViewportPaintObservedRef.current) return;
        if (
            nativeEntryRestorePaintReleasedRef.current.sessionId === sessionId &&
            nativeEntryRestorePaintReleasedRef.current.released
        ) {
            return;
        }
        if (sessionEntryViewportRef.current?.sessionId !== sessionId) return;
        if (sessionEntryViewportRef.current.shouldFollowBottom !== false) return;
        const paintReleaseHandle = entryRestoreOwner.nativePaintReleaseHandle({ sessionId });
        if (!paintReleaseHandle) return;
        const existing = nativeEntryRestorePaintReleaseTimeoutRef.current;
        if (
            existing?.sessionId === sessionId &&
            existing.issuedAtMs === paintReleaseHandle.issuedAtMs
        ) {
            return;
        }
        if (existing) {
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            clearTimeout(existing.timeoutId);
        }
        const handle = {
            issuedAtMs: paintReleaseHandle.issuedAtMs,
            sessionId,
            timeoutId: null as unknown as ReturnType<typeof setTimeout>,
        };
        handle.timeoutId = setTimeout(() => {
            if (nativeEntryRestorePaintReleaseTimeoutRef.current !== handle) return;
            nativeEntryRestorePaintReleaseTimeoutRef.current = null;
            if (currentSessionIdRef.current !== handle.sessionId) return;
            if (!entryRestoreOwner.matchesNativePaintReleaseHandle({
                issuedAtMs: handle.issuedAtMs,
                sessionId: handle.sessionId,
            })) return;
            releaseNativePaintForIssuedEntryRestore();
        }, TRANSCRIPT_NATIVE_ENTRY_RESTORE_PAINT_RELEASE_DELAY_MS);
        nativeEntryRestorePaintReleaseTimeoutRef.current = handle;
    }, [
        currentSessionIdRef,
        entryRestoreOwner,
        nativeEntryRestorePaintReleaseTimeoutRef,
        nativeViewportPaintObservedRef,
        platformOS,
        releaseNativePaintForIssuedEntryRestore,
        sessionActive,
        sessionEntryViewportRef,
        sessionId,
    ]);

    return {
        nativeEntryRestorePaintReleased,
        releaseNativePaintForIssuedEntryRestore,
        scheduleNativePaintReleaseForEntryRestore,
        updateNativeEntryRestorePaintReleased,
    };
}
