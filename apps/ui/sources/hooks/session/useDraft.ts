import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage } from '@/sync/domains/state/storage';
import { useIsFocused } from '@react-navigation/native';

interface UseDraftOptions {
    autoSaveInterval?: number; // in milliseconds, default 2000
}

export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    options: UseDraftOptions = {}
) {
    const { autoSaveInterval = 2000 } = options;
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedValue = useRef<string>('');
    const lastSessionId = useRef<string | null>(null);
    const latestValue = useRef<string>(value);
    const isFocused = useIsFocused();

    useEffect(() => {
        latestValue.current = value;
    }, [value]);

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!sessionId) return;
        
        storage.getState().updateSessionDraft(sessionId, draft);
        lastSavedValue.current = draft;
    }, [sessionId]);

    // Load draft on mount and when focused. When switching sessions, always sync the composer
    // to the target session (draft or empty) to avoid leaking the previous session's text.
    useEffect(() => {
        if (!sessionId || !isFocused) return;

        const previousSessionId = lastSessionId.current;
        lastSessionId.current = sessionId;
        const didSessionChange = previousSessionId !== null && previousSessionId !== sessionId;

        const session = storage.getState().sessions[sessionId];
        const draft = typeof session?.draft === 'string' ? session.draft : null;
        const currentValue = latestValue.current;

        if (didSessionChange) {
            if (draft && draft.trim()) {
                onChange(draft);
                lastSavedValue.current = draft;
            } else if (currentValue.trim()) {
                onChange('');
                lastSavedValue.current = '';
            } else {
                lastSavedValue.current = '';
            }
            return;
        }

        if (draft && draft.trim() && !currentValue.trim()) {
            onChange(draft);
            lastSavedValue.current = draft;
        } else if (!draft) {
            // Ensure lastSavedValue is empty if there's no draft
            lastSavedValue.current = '';
        }
    }, [sessionId, isFocused, onChange]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!sessionId) return;

        // Clear any existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }

        // Only save if value has changed
        if (value !== lastSavedValue.current) {
            const wasEmpty = !lastSavedValue.current.trim();
            const isEmpty = !value.trim();

            if (wasEmpty !== isEmpty) {
                // State transition: empty <-> non-empty
                // Save immediately for instant feedback
                saveDraft(value);
            } else if (!isEmpty) {
                // Text is being modified (non-empty to non-empty)
                // Debounce to avoid excessive saves
                saveTimeoutRef.current = setTimeout(() => {
                    saveDraft(value);
                }, autoSaveInterval);
            }
            // If both are empty, no need to save
        }

        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, [value, sessionId, autoSaveInterval, saveDraft]);

    // Save on app state change (background/inactive)
    useEffect(() => {
        if (!sessionId) return;

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                if (value !== lastSavedValue.current) {
                    saveDraft(value);
                }
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
        };
    }, [sessionId, value, saveDraft]);

    // Save on unmount
    useEffect(() => {
        return () => {
            if (sessionId && value !== lastSavedValue.current) {
                saveDraft(value);
            }
        };
    }, [sessionId, value, saveDraft]);

    // Clear draft (used after message is sent)
    const clearDraft = useCallback(() => {
        if (!sessionId) return;
        
        storage.getState().updateSessionDraft(sessionId, null);
        lastSavedValue.current = '';
    }, [sessionId]);

    return {
        clearDraft
    };
}
