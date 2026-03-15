import * as React from 'react';
import { InteractionManager, Platform } from 'react-native';

export function useNewSessionDraftAutoPersist(params: Readonly<{
    persistDraftNow: () => void;
}>): void {
    // Persist the current wizard state so it survives remounts and screen navigation
    // Uses debouncing to avoid excessive writes
    const draftSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const persistDraftNowRef = React.useRef(params.persistDraftNow);
    React.useEffect(() => {
        persistDraftNowRef.current = params.persistDraftNow;
    }, [params.persistDraftNow]);

    React.useEffect(() => {
        if (draftSaveTimerRef.current !== null) {
            clearTimeout(draftSaveTimerRef.current);
        }
        const delayMs = Platform.OS === 'web' ? 250 : 900;
        draftSaveTimerRef.current = setTimeout(() => {
            draftSaveTimerRef.current = null;
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
    }, [params.persistDraftNow]);

    // Flush pending work on unmount so fast navigation / modal close doesn't drop draft state.
    React.useEffect(() => {
        return () => {
            if (draftSaveTimerRef.current === null) {
                return;
            }
            clearTimeout(draftSaveTimerRef.current);
            draftSaveTimerRef.current = null;
            persistDraftNowRef.current();
        };
    }, []);
}
