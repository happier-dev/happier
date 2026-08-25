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

/**
 * Out-of-render view of the draft's live text. The new-session composer owns its text in a
 * store rather than screen-model state, so text changes must re-arm the debounce without
 * rendering the owner: `subscribe` delivers the change, `getLength` feeds the large-text
 * delay policy.
 */
export type NewSessionDraftTextSource = Readonly<{
    getLength: () => number;
    subscribe: (listener: () => void) => () => void;
}>;

export function useNewSessionDraftAutoPersist(params: Readonly<{
    persistDraftNow: () => void;
    persistenceEnabled?: boolean;
    draftText?: NewSessionDraftTextSource;
    /** Stable semantic identity for the current draft, independent of text length. */
    draftChangeKey?: string;
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
    const draftTextRef = React.useRef(params.draftText);
    const focused = params.focused ?? true;
    const focusedRef = React.useRef(focused);
    focusedRef.current = focused;
    React.useEffect(() => {
        persistDraftNowRef.current = params.persistDraftNow;
    }, [params.persistDraftNow]);
    React.useEffect(() => {
        persistenceEnabledRef.current = params.persistenceEnabled ?? true;
    }, [params.persistenceEnabled]);
    React.useEffect(() => {
        draftTextRef.current = params.draftText;
    }, [params.draftText]);

    const cancelPendingIdlePersist = React.useCallback(() => {
        const cancelIdlePersist = cancelIdlePersistRef.current;
        if (cancelIdlePersist === null) {
            return;
        }
        cancelIdlePersistRef.current = null;
        cancelIdlePersist();
    }, []);

    const persistAfterCurrentPolicy = React.useCallback((options?: Readonly<{
        allowUnfocused?: boolean;
    }>) => {
        const allowUnfocused = options?.allowUnfocused === true;
        cancelPendingIdlePersist();
        if (!persistenceEnabledRef.current || (!allowUnfocused && !focusedRef.current)) {
            return;
        }
        // Persisting uses synchronous storage under the hood (MMKV). Large web
        // drafts can still be expensive to serialize, so wait for idle time once
        // the large-text debounce has elapsed.
        if (Platform.OS === 'web' && isLargeTextInputValueLength(draftTextRef.current?.getLength() ?? 0)) {
            let cancelCurrentIdlePersist: (() => void) | null = null;
            cancelCurrentIdlePersist = scheduleWebIdlePersist(() => {
                if (cancelIdlePersistRef.current === cancelCurrentIdlePersist) {
                    cancelIdlePersistRef.current = null;
                }
                if (!persistenceEnabledRef.current || (!allowUnfocused && !focusedRef.current)) {
                    return;
                }
                persistDraftNowRef.current();
            });
            cancelIdlePersistRef.current = cancelCurrentIdlePersist;
            return;
        }

        if (Platform.OS === 'web') {
            if (!allowUnfocused && !focusedRef.current) {
                return;
            }
            persistDraftNowRef.current();
            return;
        }

        // Persisting uses synchronous storage under the hood (MMKV), which blocks the JS thread
        // while it serializes. This gets the write off the CURRENT synchronous block — and that
        // is all it does. On the React Native version this app ships, `InteractionManager` is a
        // deprecated stub whose `runAfterInteractions` defers through `setImmediate`, which is
        // shimmed onto `queueMicrotask`: the callback runs at this task's microtask checkpoint,
        // before any timer and without yielding a frame. It does not wait for touches, scrolls or
        // animations, so nothing here protects an in-flight gesture — see the disproof in
        // `@/utils/timing/runAfterInteractionsWithFallback`. Web is handled above because there
        // the persist is already scheduled by the idle/large-draft policy.
        InteractionManager.runAfterInteractions(() => {
            if (!persistenceEnabledRef.current || (!allowUnfocused && !focusedRef.current)) {
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
        if (draftSaveTimerRef.current === null && cancelIdlePersistRef.current === null) {
            return;
        }
        if (draftSaveTimerRef.current !== null) {
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
        }
        persistAfterCurrentPolicy({ allowUnfocused: true });
    }, [focused, persistAfterCurrentPolicy]);

    const armDebouncedPersist = React.useCallback(() => {
        if (draftSaveTimerRef.current !== null) {
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
        }
        cancelPendingIdlePersist();
        if (!focusedRef.current || !persistenceEnabledRef.current) {
            return;
        }
        const delayMs = resolveNewSessionDraftAutoPersistDelayMs({
            platformOS: Platform.OS,
            draftTextLength: draftTextRef.current?.getLength() ?? 0,
        });
        draftSaveTimerRef.current = setTimeout(() => {
            draftSaveTimerRef.current = null;
            if (!focusedRef.current || !persistenceEnabledRef.current) {
                return;
            }
            persistAfterCurrentPolicy();
        }, delayMs);
    }, [cancelPendingIdlePersist, persistAfterCurrentPolicy]);

    const hasSkippedInitialMountPersistRef = React.useRef(false);
    React.useEffect(() => {
        if (!focused) {
            // The blur-flush effect above already flushed any pending debounce; leave an
            // in-flight idle persist alone so the flush completes with the live value.
            return;
        }
        if (!hasSkippedInitialMountPersistRef.current) {
            hasSkippedInitialMountPersistRef.current = true;
            // Hydration/default resolution is not a semantic edit. The draft-change key or
            // live text subscription will arm persistence after the first actual change.
            return;
        }
        armDebouncedPersist();
        return () => {
            if (draftSaveTimerRef.current !== null) {
                clearTimeout(draftSaveTimerRef.current);
            }
        };
    }, [
        armDebouncedPersist,
        focused,
        params.draftChangeKey,
        params.persistenceEnabled,
    ]);

    // Typing re-arms the debounce without rendering this hook's owner: the composer text
    // lives in a store, so a keystroke is a store notification rather than a state update.
    React.useEffect(() => {
        const draftText = params.draftText;
        if (!draftText) {
            return;
        }
        return draftText.subscribe(() => {
            if (!focusedRef.current || !persistenceEnabledRef.current) {
                return;
            }
            armDebouncedPersist();
        });
    }, [armDebouncedPersist, params.draftText]);

    // Flush pending work on unmount so fast navigation / modal close doesn't drop draft state.
    React.useEffect(() => {
        return () => {
            if (draftSaveTimerRef.current === null) {
                return;
            }
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
            persistAfterCurrentPolicy({ allowUnfocused: true });
        };
    }, [persistAfterCurrentPolicy]);
}
