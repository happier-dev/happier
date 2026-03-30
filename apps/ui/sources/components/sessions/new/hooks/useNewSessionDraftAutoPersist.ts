import * as React from 'react';
import { InteractionManager, Platform } from 'react-native';

export function useNewSessionDraftAutoPersist(params: Readonly<{
    persistDraftNow: () => void;
    persistenceEnabled?: boolean;
}>): void {
    // Persist the current wizard state so it survives remounts and screen navigation
    // Uses debouncing to avoid excessive writes
    const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const persistDraftNowRef = React.useRef(params.persistDraftNow);
    const persistenceEnabledRef = React.useRef(params.persistenceEnabled ?? true);
    React.useEffect(() => {
        persistDraftNowRef.current = params.persistDraftNow;
    }, [params.persistDraftNow]);
    React.useEffect(() => {
        persistenceEnabledRef.current = params.persistenceEnabled ?? true;
    }, [params.persistenceEnabled]);

    React.useEffect(() => {
        if (draftSaveTimerRef.current !== null) {
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
        }
        if ((params.persistenceEnabled ?? true) !== true) {
            return;
        }
        const delayMs = Platform.OS === 'web' ? 250 : 900;
        draftSaveTimerRef.current = setTimeout(() => {
            draftSaveTimerRef.current = null;
            if (!persistenceEnabledRef.current) {
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
        }, delayMs);
        return () => {
            if (draftSaveTimerRef.current !== null) {
                clearTimeout(draftSaveTimerRef.current);
            }
        };
    }, [params.persistDraftNow, params.persistenceEnabled]);

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
            persistDraftNowRef.current();
        };
    }, []);
}
