import * as React from 'react';
import { AppState, InteractionManager, Platform } from 'react-native';

import {
    TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS,
    WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT,
} from '@/components/ui/forms/largeTextInputPolicy';

const NEW_SESSION_DRAFT_AUTOPERSIST_DELAY_MS = {
    native: 3000,
    web: 250,
} as const;

type RequestIdleCallback = (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions,
) => number;

type CancelIdleCallback = (handle: number) => void;

function isLargeWebDraftTextLength(length: number | undefined): boolean {
    return typeof length === 'number'
        && Number.isFinite(length)
        && length > WEB_TEXTAREA_AUTOSIZE_VALUE_LENGTH_LIMIT;
}

function resolveNewSessionDraftAutoPersistDelayMs(params: Readonly<{
    draftTextLength?: number;
}>): number {
    if (Platform.OS === 'web' && isLargeWebDraftTextLength(params.draftTextLength)) {
        return Math.max(
            TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS,
            NEW_SESSION_DRAFT_AUTOPERSIST_DELAY_MS.web,
        );
    }
    return Platform.OS === 'web'
        ? NEW_SESSION_DRAFT_AUTOPERSIST_DELAY_MS.web
        : NEW_SESSION_DRAFT_AUTOPERSIST_DELAY_MS.native;
}

function scheduleWebIdlePersist(callback: () => void): () => void {
    let cancelled = false;
    const runIfCurrent = () => {
        if (cancelled) return;
        callback();
    };
    const idleGlobal = globalThis as typeof globalThis & {
        requestIdleCallback?: RequestIdleCallback;
        cancelIdleCallback?: CancelIdleCallback;
    };
    if (typeof idleGlobal.requestIdleCallback === 'function') {
        const idleHandle = idleGlobal.requestIdleCallback(() => {
            runIfCurrent();
        }, { timeout: TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS });
        return () => {
            cancelled = true;
            idleGlobal.cancelIdleCallback?.(idleHandle);
        };
    }
    const timeoutHandle = setTimeout(runIfCurrent, 0);
    return () => {
        cancelled = true;
        clearTimeout(timeoutHandle);
    };
}

/**
 * Out-of-render view of the draft's live text. The new-session composer owns its text in a
 * store rather than screen-model state, so text changes must re-arm the debounce without
 * rendering the owner: `subscribe` delivers the change, `getLength` feeds the large-web-text
 * delay policy.
 */
export type NewSessionDraftTextSource = Readonly<{
    getLength: () => number;
    subscribe: (listener: () => void) => () => void;
}>;

export function useNewSessionDraftAutoPersist(params: Readonly<{
    /** Stage the live semantic draft into the local repository before any delayed flush. */
    stageDraftNow?: () => void;
    persistDraftNow: () => void;
    persistenceEnabled?: boolean;
    draftText?: NewSessionDraftTextSource;
    /** Stable semantic identity for the current draft, independent of text length. */
    draftChangeKey?: string;
    /** Untouched new-session routes must not create a materialized draft merely by mounting. */
    persistOnMount?: boolean;
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
    const stageDraftNowRef = React.useRef(params.stageDraftNow);
    const persistenceEnabledRef = React.useRef(params.persistenceEnabled ?? true);
    const draftTextRef = React.useRef(params.draftText);
    const focused = params.focused ?? true;
    const focusedRef = React.useRef(focused);
    React.useEffect(() => {
        persistDraftNowRef.current = params.persistDraftNow;
    }, [params.persistDraftNow]);
    React.useEffect(() => {
        stageDraftNowRef.current = params.stageDraftNow;
    }, [params.stageDraftNow]);
    React.useEffect(() => {
        persistenceEnabledRef.current = params.persistenceEnabled ?? true;
    }, [params.persistenceEnabled]);
    React.useEffect(() => {
        draftTextRef.current = params.draftText;
    }, [params.draftText]);
    React.useEffect(() => {
        focusedRef.current = focused;
    }, [focused]);

    const cancelPendingIdlePersist = React.useCallback(() => {
        cancelIdlePersistRef.current?.();
        cancelIdlePersistRef.current = null;
    }, []);

    const persistAfterCurrentPolicy = React.useCallback(() => {
        cancelPendingIdlePersist();
        if (!persistenceEnabledRef.current) {
            return;
        }
        if (Platform.OS === 'web' && isLargeWebDraftTextLength(draftTextRef.current?.getLength())) {
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
        // Persisting uses synchronous storage under the hood (MMKV), which can block the JS thread on iOS.
        // Run after interactions so taps/animations stay responsive.
        if (Platform.OS === 'web') {
            persistDraftNowRef.current();
        } else {
            InteractionManager.runAfterInteractions(() => {
                persistDraftNowRef.current();
            });
        }
    }, [cancelPendingIdlePersist]);

    const flushPendingPersistImmediately = React.useCallback(() => {
        const hasPendingTimer = draftSaveTimerRef.current !== null;
        const hasPendingIdlePersist = cancelIdlePersistRef.current !== null;
        if (!hasPendingTimer && !hasPendingIdlePersist) {
            return;
        }
        if (draftSaveTimerRef.current !== null) {
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
        }
        cancelPendingIdlePersist();
        if (!persistenceEnabledRef.current) {
            return;
        }
        // App/web lifecycle boundaries cannot wait for interactions or browser idle time:
        // the runtime may be suspended before either callback receives another turn.
        persistDraftNowRef.current();
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

    const armDebouncedPersist = React.useCallback(() => {
        cancelPendingIdlePersist();
        if (draftSaveTimerRef.current !== null) {
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
        }
        if (!focusedRef.current) {
            return;
        }
        if (!persistenceEnabledRef.current) {
            return;
        }
        const delayMs = resolveNewSessionDraftAutoPersistDelayMs({
            draftTextLength: draftTextRef.current?.getLength(),
        });
        draftSaveTimerRef.current = setTimeout(() => {
            draftSaveTimerRef.current = null;
            persistAfterCurrentPolicy();
        }, delayMs);
    }, [cancelPendingIdlePersist, persistAfterCurrentPolicy]);

    const hasAppliedInitialSchedulingPolicyRef = React.useRef(false);
    const previousDraftChangeKeyRef = React.useRef(params.draftChangeKey);
    React.useEffect(() => {
        if (!focused) {
            // The blur-flush effect above already flushed any pending debounce; leave an
            // in-flight idle persist alone so the flush completes with the live value.
            return;
        }
        if (!hasAppliedInitialSchedulingPolicyRef.current) {
            hasAppliedInitialSchedulingPolicyRef.current = true;
            previousDraftChangeKeyRef.current = params.draftChangeKey;
            if (params.persistOnMount === false) {
                return;
            }
        } else if (previousDraftChangeKeyRef.current !== params.draftChangeKey) {
            previousDraftChangeKeyRef.current = params.draftChangeKey;
            if (persistenceEnabledRef.current) {
                stageDraftNowRef.current?.();
            }
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
        params.persistOnMount,
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
            if (focusedRef.current && persistenceEnabledRef.current) {
                stageDraftNowRef.current?.();
            }
            armDebouncedPersist();
        });
    }, [armDebouncedPersist, params.draftText]);

    React.useEffect(() => {
        const appStateSubscription = AppState.addEventListener('change', (nextState) => {
            if (nextState !== 'active') {
                flushPendingPersistImmediately();
            }
        });

        const flushWhenWebPageHides = () => {
            flushPendingPersistImmediately();
        };
        const flushWhenWebDocumentHides = () => {
            if (document.visibilityState === 'hidden') {
                flushPendingPersistImmediately();
            }
        };
        if (Platform.OS === 'web' && typeof document !== 'undefined' && typeof window !== 'undefined') {
            document.addEventListener('visibilitychange', flushWhenWebDocumentHides);
            window.addEventListener('pagehide', flushWhenWebPageHides);
        }

        return () => {
            appStateSubscription.remove();
            if (Platform.OS === 'web' && typeof document !== 'undefined' && typeof window !== 'undefined') {
                document.removeEventListener('visibilitychange', flushWhenWebDocumentHides);
                window.removeEventListener('pagehide', flushWhenWebPageHides);
            }
        };
    }, [flushPendingPersistImmediately]);

    // Flush pending work on unmount so fast navigation / modal close doesn't drop draft state.
    React.useEffect(() => {
        return () => {
            if (draftSaveTimerRef.current === null) {
                return;
            }
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
            if (!persistenceEnabledRef.current) {
                return;
            }
            persistAfterCurrentPolicy();
        };
    }, [persistAfterCurrentPolicy]);
}
