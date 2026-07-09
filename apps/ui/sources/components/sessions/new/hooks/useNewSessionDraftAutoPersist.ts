import * as React from 'react';
import { InteractionManager, Platform } from 'react-native';

import {
    TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS,
    isLargeTextInputValueLength,
} from '@/components/ui/forms/largeTextInputPolicy';

const WEB_NEW_SESSION_DRAFT_AUTOPERSIST_DELAY_MS = 250;
const NATIVE_NEW_SESSION_DRAFT_AUTOPERSIST_DELAY_MS = 900;

type RequestIdleCallback = typeof globalThis.requestIdleCallback;
type CancelIdleCallback = typeof globalThis.cancelIdleCallback;

function scheduleWebIdlePersist(callback: () => void): () => void {
    let cancelled = false;
    const requestIdleCallback = globalThis.requestIdleCallback as RequestIdleCallback | undefined;
    const cancelIdleCallback = globalThis.cancelIdleCallback as CancelIdleCallback | undefined;
    if (requestIdleCallback && cancelIdleCallback) {
        const idleHandle = requestIdleCallback(() => {
            if (cancelled) {
                return;
            }
            callback();
        });
        return () => {
            cancelled = true;
            cancelIdleCallback(idleHandle);
        };
    }

    const timeoutHandle = setTimeout(() => {
        if (cancelled) {
            return;
        }
        callback();
    }, 0);
    return () => {
        cancelled = true;
        clearTimeout(timeoutHandle);
    };
}

export function resolveNewSessionDraftAutoPersistDelayMs(params: Readonly<{
    platformOS: string;
    draftTextLength?: number | null;
}>): number {
    const baseDelayMs = params.platformOS === 'web'
        ? WEB_NEW_SESSION_DRAFT_AUTOPERSIST_DELAY_MS
        : NATIVE_NEW_SESSION_DRAFT_AUTOPERSIST_DELAY_MS;
    return isLargeTextInputValueLength(params.draftTextLength ?? 0)
        ? Math.max(baseDelayMs, TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS)
        : baseDelayMs;
}

export function useNewSessionDraftAutoPersist(params: Readonly<{
    persistDraftNow: () => void;
    persistenceEnabled?: boolean;
    draftTextLength?: number | null;
    /**
     * Whether the owning screen is currently focused. Only the focused screen instance may
     * auto-persist: an unfocused instance's draft state is stale relative to whichever
     * focused instance is editing the same scoped draft key, and persisting it would
     * clobber live typing there. On losing focus any pending persist is flushed once so
     * navigating away does not drop recent edits.
     */
    focused?: boolean;
}>): void {
    // Persist the current wizard state so it survives remounts and screen navigation
    // Uses debouncing to avoid excessive writes
    const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelIdlePersistRef = React.useRef<(() => void) | null>(null);
    const persistDraftNowRef = React.useRef(params.persistDraftNow);
    const persistenceEnabledRef = React.useRef(params.persistenceEnabled ?? true);
    const draftTextLengthRef = React.useRef(params.draftTextLength ?? 0);
    const focused = params.focused ?? true;
    React.useEffect(() => {
        persistDraftNowRef.current = params.persistDraftNow;
    }, [params.persistDraftNow]);
    React.useEffect(() => {
        persistenceEnabledRef.current = params.persistenceEnabled ?? true;
    }, [params.persistenceEnabled]);
    React.useEffect(() => {
        draftTextLengthRef.current = params.draftTextLength ?? 0;
    }, [params.draftTextLength]);

    const cancelPendingIdlePersist = React.useCallback(() => {
        const cancelIdlePersist = cancelIdlePersistRef.current;
        if (cancelIdlePersist === null) {
            return;
        }
        cancelIdlePersistRef.current = null;
        cancelIdlePersist();
    }, []);

    const persistAfterCurrentPolicy = React.useCallback(() => {
        cancelPendingIdlePersist();
        if (!persistenceEnabledRef.current) {
            return;
        }
        // Persisting uses synchronous storage under the hood (MMKV). Large web
        // drafts can still be expensive to serialize, so wait for idle time once
        // the large-text debounce has elapsed.
        if (Platform.OS === 'web' && isLargeTextInputValueLength(draftTextLengthRef.current)) {
            let cancelCurrentIdlePersist: (() => void) | null = null;
            cancelCurrentIdlePersist = scheduleWebIdlePersist(() => {
                if (cancelIdlePersistRef.current === cancelCurrentIdlePersist) {
                    cancelIdlePersistRef.current = null;
                }
                if (!persistenceEnabledRef.current) {
                    return;
                }
                persistDraftNowRef.current();
            });
            cancelIdlePersistRef.current = cancelCurrentIdlePersist;
            return;
        }

        if (Platform.OS === 'web') {
            persistDraftNowRef.current();
            return;
        }

        // Persisting uses synchronous storage under the hood (MMKV), which can block the JS thread on iOS.
        // Run after interactions so taps/animations stay responsive.
        InteractionManager.runAfterInteractions(() => {
            if (!persistenceEnabledRef.current) {
                return;
            }
            persistDraftNowRef.current();
        });
    }, [cancelPendingIdlePersist]);

    // Losing focus flushes any pending persist once: navigation away must not drop the
    // last few seconds of typing, and an unfocused instance must never persist later.
    // Declared before the scheduling effect so it observes the pending timer before the
    // scheduling effect clears it for the unfocused state.
    const wasFocusedRef = React.useRef(focused);
    React.useEffect(() => {
        const wasFocused = wasFocusedRef.current;
        wasFocusedRef.current = focused;
        if (!wasFocused || focused) {
            return;
        }
        if (draftSaveTimerRef.current === null) {
            return;
        }
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
        persistAfterCurrentPolicy();
    }, [focused, persistAfterCurrentPolicy]);

    React.useEffect(() => {
        if (!focused) {
            // The blur-flush effect above already flushed any pending debounce; leave an
            // in-flight idle persist alone so the flush completes with the live value.
            return;
        }
        if (draftSaveTimerRef.current !== null) {
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
        }
        cancelPendingIdlePersist();
        if ((params.persistenceEnabled ?? true) !== true) {
            return;
        }
        const delayMs = resolveNewSessionDraftAutoPersistDelayMs({
            platformOS: Platform.OS,
            draftTextLength: params.draftTextLength,
        });
        draftSaveTimerRef.current = setTimeout(() => {
            draftSaveTimerRef.current = null;
            persistAfterCurrentPolicy();
        }, delayMs);
        return () => {
            if (draftSaveTimerRef.current !== null) {
                clearTimeout(draftSaveTimerRef.current);
            }
        };
    }, [
        cancelPendingIdlePersist,
        focused,
        params.draftTextLength,
        params.persistenceEnabled,
        persistAfterCurrentPolicy,
    ]);

    // Flush pending work on unmount so fast navigation / modal close doesn't drop draft state.
    React.useEffect(() => {
        return () => {
            if (draftSaveTimerRef.current === null) {
                return;
            }
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
            persistAfterCurrentPolicy();
        };
    }, [persistAfterCurrentPolicy]);
}
