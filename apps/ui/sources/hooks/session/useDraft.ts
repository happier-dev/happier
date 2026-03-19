import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage } from '@/sync/domains/state/storage';
import { useIsFocused } from '@react-navigation/native';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { clearForkInitialPromptV1, readForkInitialPromptV1 } from '@/sync/domains/sessionFork/forkInitialPromptV1';

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
    const autosaveSkip = useRef<Readonly<{ sessionId: string; value: string }> | null>(null);
    const isFocused = useIsFocused();
    const session = sessionId ? storage.getState().sessions[sessionId] : null;
    const storedDraft = typeof session?.draft === 'string' ? session.draft : null;
    const forkInitialPrompt = readForkInitialPromptV1(session?.metadata as any);
    const forkInitialPromptText = forkInitialPrompt?.text ?? null;

    useEffect(() => {
        latestValue.current = value;
    }, [value]);

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!sessionId) return;
        
        storage.getState().updateSessionDraft(sessionId, draft);
        lastSavedValue.current = draft;
    }, [sessionId]);

    const clearForkInitialPrompt = useCallback((tag: string) => {
        if (!sessionId || !forkInitialPromptText) return;
        fireAndForget(
            sync.patchSessionMetadataWithRetry(sessionId, (metadata) =>
                clearForkInitialPromptV1({ metadata: metadata as any }) as any,
            ),
            { tag },
        );
    }, [forkInitialPromptText, sessionId]);

    // Load draft on mount and when focused. When switching sessions, always sync the composer
    // to the target session (draft or empty) to avoid leaking the previous session's text.
    useEffect(() => {
        if (!sessionId) return;

        const previousSessionId = lastSessionId.current;
        lastSessionId.current = sessionId;
        const didSessionChange = previousSessionId !== null && previousSessionId !== sessionId;

        const currentValue = latestValue.current;

        if (didSessionChange) {
            autosaveSkip.current = { sessionId, value: currentValue };
            if (storedDraft && storedDraft.trim()) {
                onChange(storedDraft);
                lastSavedValue.current = storedDraft;
                clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.sessionChange.storedDraft');
            } else if (forkInitialPromptText) {
                onChange(forkInitialPromptText);
                saveDraft(forkInitialPromptText);
                lastSavedValue.current = forkInitialPromptText;
                clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.sessionChange');
            } else if (currentValue.trim()) {
                onChange('');
                lastSavedValue.current = '';
            } else {
                lastSavedValue.current = '';
            }
            return;
        }

        if (!isFocused) return;

        const externalDraft = storedDraft && storedDraft.trim() ? storedDraft : null;
        if (externalDraft != null && externalDraft === currentValue && lastSavedValue.current !== externalDraft) {
            lastSavedValue.current = externalDraft;
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus.syncedDraft');
        }
        const canAdoptExternalDraft =
            externalDraft != null
                ? !currentValue.trim() || currentValue === lastSavedValue.current
                : false;

        if (externalDraft != null && canAdoptExternalDraft) {
            onChange(externalDraft);
            lastSavedValue.current = externalDraft;
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus.storedDraft');
        } else if (forkInitialPromptText && !currentValue.trim()) {
            onChange(forkInitialPromptText);
            saveDraft(forkInitialPromptText);
            lastSavedValue.current = forkInitialPromptText;
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus');
        } else if (!storedDraft) {
            // Ensure lastSavedValue is empty if there's no draft
            lastSavedValue.current = '';
        }
    }, [clearForkInitialPrompt, forkInitialPromptText, isFocused, onChange, saveDraft, sessionId, storedDraft]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!sessionId) return;

        // Clear any existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }

        // Only save if value has changed
        const skip = autosaveSkip.current;
        if (skip && skip.sessionId === sessionId && skip.value === value) {
            autosaveSkip.current = null;
            return;
        }

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
