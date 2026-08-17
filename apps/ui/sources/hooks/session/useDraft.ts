import { useEffect, useRef, useCallback, useMemo } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage } from '@/sync/domains/state/storage';
import { useIsFocused } from '@react-navigation/native';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { clearForkInitialPromptV1, readForkInitialPromptV1 } from '@/sync/domains/sessionFork/forkInitialPromptV1';
import {
    clearSessionInitialPromptV1,
    readSessionInitialPromptV1,
    type SessionInitialPromptV1,
} from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';
import type { SessionComposerTextMutationToken } from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import { containsLikelyNonWhitespace, isLargeTextInputValueLength } from '@/components/ui/forms/largeTextInputPolicy';
import { useWebLifecycleFlush } from './useWebLifecycleFlush';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

interface UseDraftOptions {
    autoSaveInterval?: number; // in milliseconds, default 2000
    /**
     * The existing Session composer may advance its semantic revision as soon
     * as visible text changes. The debounced persistence write receives the
     * returned token so that one edit cannot advance the same revision twice.
     */
    onTextMutation?: (input: Readonly<{
        sessionId: string;
        text: string;
    }>) => SessionComposerTextMutationToken | null;
}

export type SessionDraftTextSnapshot = Readonly<{
    sessionId: string;
    text: string;
}>;

function normalizeSessionId(sessionId: string | null | undefined): string | null {
    const normalizedSessionId = String(sessionId ?? '').trim();
    return normalizedSessionId.length > 0 ? normalizedSessionId : null;
}

export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    options: UseDraftOptions = {}
) {
    const { autoSaveInterval = 2000 } = options;
    const onTextMutation = options.onTextMutation;
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedValue = useRef<string>('');
    const lastSessionId = useRef<string | null>(null);
    const latestValue = useRef<string>(value);
    const autosaveSkip = useRef<Readonly<{ sessionId: string; value: string }> | null>(null);
    const textMutationTokensBySessionIdRef = useRef(new Map<string, Readonly<{
        text: string;
        token: SessionComposerTextMutationToken;
    }>>());
    const isFocused = useIsFocused();
    const resolvedSessionId = normalizeSessionId(sessionId);
    const session = resolvedSessionId ? storage.getState().sessions[resolvedSessionId] : null;
    const storedDraft = typeof session?.draft === 'string' ? session.draft : null;
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const forkInitialPrompt = readForkInitialPromptV1(ownerMetadata);
    const forkInitialPromptText = forkInitialPrompt?.text ?? null;
    const sessionInitialPrompt = readSessionInitialPromptV1(ownerMetadata);
    const consumedSessionInitialPromptKeyRef = useRef<string | null>(null);
    const sessionInitialPromptKey = useMemo(() => {
        if (!resolvedSessionId || !sessionInitialPrompt) return null;
        return [
            resolvedSessionId,
            sessionInitialPrompt.mode,
            String(sessionInitialPrompt.createdAtMs),
            sessionInitialPrompt.sourceSessionId ?? '',
            (sessionInitialPrompt.sourceMessageIds ?? []).join(','),
            sessionInitialPrompt.text,
        ].join('\u0000');
    }, [resolvedSessionId, sessionInitialPrompt]);
    const activeSessionInitialPrompt = sessionInitialPromptKey && consumedSessionInitialPromptKeyRef.current !== sessionInitialPromptKey
        ? sessionInitialPrompt
        : null;

    latestValue.current = value;

    const recordVisibleTextMutation = useCallback((targetSessionId: string, text: string) => {
        const token = onTextMutation?.({ sessionId: targetSessionId, text }) ?? null;
        if (token) {
            textMutationTokensBySessionIdRef.current.set(targetSessionId, { text, token });
        } else {
            textMutationTokensBySessionIdRef.current.delete(targetSessionId);
        }
    }, [onTextMutation]);

    const saveDraftForSession = useCallback((targetSessionId: string, draft: string) => {
        const textMutation = textMutationTokensBySessionIdRef.current.get(targetSessionId);
        if (textMutation?.text === draft) {
            storage.getState().updateSessionDraft(targetSessionId, draft, {
                composerTextMutationToken: textMutation.token,
            });
            textMutationTokensBySessionIdRef.current.delete(targetSessionId);
        } else {
            storage.getState().updateSessionDraft(targetSessionId, draft);
        }
        if (lastSessionId.current === targetSessionId) {
            lastSavedValue.current = draft;
        }
    }, []);

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!resolvedSessionId) return;
        saveDraftForSession(resolvedSessionId, draft);
    }, [resolvedSessionId, saveDraftForSession]);

    const flushLatestDraftIfChanged = useCallback(() => {
        if (!resolvedSessionId) return;
        const currentValue = latestValue.current;
        if (currentValue === lastSavedValue.current) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        saveDraft(currentValue);
    }, [resolvedSessionId, saveDraft]);

    const setDraftValue = useCallback((nextValueOrUpdater: string | ((currentValue: string) => string)) => {
        const nextValue = typeof nextValueOrUpdater === 'function'
            ? nextValueOrUpdater(latestValue.current)
            : nextValueOrUpdater;
        if (nextValue !== latestValue.current && resolvedSessionId) {
            recordVisibleTextMutation(resolvedSessionId, nextValue);
        }
        latestValue.current = nextValue;
        onChange(nextValue);
    }, [onChange, recordVisibleTextMutation, resolvedSessionId]);

    const clearForkInitialPrompt = useCallback((tag: string) => {
        if (!resolvedSessionId || !forkInitialPromptText) return;
        fireAndForget(
            sync.patchSessionMetadataWithRetry(resolvedSessionId, (metadata) =>
                clearForkInitialPromptV1({ metadata }),
            ),
            { tag },
        );
    }, [forkInitialPromptText, resolvedSessionId]);

    const clearSessionInitialPrompt = useCallback((tag: string) => {
        if (!resolvedSessionId || !sessionInitialPromptKey) return;
        consumedSessionInitialPromptKeyRef.current = sessionInitialPromptKey;
        fireAndForget(
            sync.patchSessionMetadataWithRetry(resolvedSessionId, (metadata) =>
                clearSessionInitialPromptV1({ metadata }),
            ),
            { tag },
        );
    }, [resolvedSessionId, sessionInitialPromptKey]);

    const composeSessionInitialPromptText = useCallback((baseText: string, prompt: SessionInitialPromptV1): string => {
        if (prompt.mode === 'replace') return prompt.text;
        const trimmedBase = baseText.trimEnd();
        if (!trimmedBase) return prompt.text;
        return `${trimmedBase}\n\n${prompt.text}`;
    }, []);

    const adoptDraftText = useCallback((draft: string) => {
        if (resolvedSessionId && latestValue.current !== draft) {
            recordVisibleTextMutation(resolvedSessionId, draft);
        }
        latestValue.current = draft;
        onChange(draft);
        saveDraft(draft);
        lastSavedValue.current = draft;
    }, [onChange, recordVisibleTextMutation, resolvedSessionId, saveDraft]);

    // Load draft on mount and when focused. When switching sessions, always sync the composer
    // to the target session (draft or empty) to avoid leaking the previous session's text.
    useEffect(() => {
        if (!resolvedSessionId) return;

        const previousSessionId = lastSessionId.current;
        lastSessionId.current = resolvedSessionId;
        const didSessionChange = previousSessionId !== null && previousSessionId !== resolvedSessionId;

        const currentValue = latestValue.current;

        if (didSessionChange) {
            if (previousSessionId && currentValue !== lastSavedValue.current) {
                saveDraftForSession(previousSessionId, currentValue);
            }
            autosaveSkip.current = { sessionId: resolvedSessionId, value: currentValue };
            const baseStoredDraft = storedDraft && storedDraft.trim() ? storedDraft : null;
            const baseText = baseStoredDraft ?? forkInitialPromptText ?? null;
            const nextDraft = baseText !== null && activeSessionInitialPrompt
                ? composeSessionInitialPromptText(baseText, activeSessionInitialPrompt)
                : baseText ?? (activeSessionInitialPrompt ? composeSessionInitialPromptText('', activeSessionInitialPrompt) : null);

            if (nextDraft !== null) {
                adoptDraftText(nextDraft);
                if (baseStoredDraft !== null) {
                    clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.sessionChange.storedDraft');
            } else if (forkInitialPromptText) {
                    clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.sessionChange');
                }
                clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.sessionChange');
            } else if (currentValue.trim()) {
                recordVisibleTextMutation(resolvedSessionId, '');
                latestValue.current = '';
                onChange('');
                lastSavedValue.current = '';
            } else {
                lastSavedValue.current = '';
            }
            return;
        }

        if (!isFocused) return;

        const externalDraft = storedDraft && storedDraft.trim() ? storedDraft : null;
        if (externalDraft != null && externalDraft === currentValue && lastSavedValue.current !== externalDraft && !activeSessionInitialPrompt) {
            lastSavedValue.current = externalDraft;
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus.syncedDraft');
        }
        const canAdoptExternalDraft =
            externalDraft != null
                ? currentValue === lastSavedValue.current || (!currentValue.trim() && !lastSavedValue.current.trim())
                : false;
        const canAdoptWithoutExternalDraft = currentValue === lastSavedValue.current || !currentValue.trim();

        if (externalDraft != null && canAdoptExternalDraft) {
            const nextDraft = activeSessionInitialPrompt
                ? composeSessionInitialPromptText(externalDraft, activeSessionInitialPrompt)
                : externalDraft;
            adoptDraftText(nextDraft);
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus.storedDraft');
            clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus.storedDraft');
        } else if (forkInitialPromptText && !currentValue.trim()) {
            const nextDraft = activeSessionInitialPrompt
                ? composeSessionInitialPromptText(forkInitialPromptText, activeSessionInitialPrompt)
                : forkInitialPromptText;
            adoptDraftText(nextDraft);
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus');
            clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus.forkPrompt');
        } else if (activeSessionInitialPrompt && canAdoptWithoutExternalDraft) {
            const nextDraft = composeSessionInitialPromptText(currentValue, activeSessionInitialPrompt);
            adoptDraftText(nextDraft);
            clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus');
        } else if (!storedDraft) {
            // Ensure lastSavedValue is empty if there's no draft
            lastSavedValue.current = '';
        }
    }, [activeSessionInitialPrompt, adoptDraftText, clearForkInitialPrompt, clearSessionInitialPrompt, composeSessionInitialPromptText, forkInitialPromptText, isFocused, onChange, recordVisibleTextMutation, resolvedSessionId, saveDraftForSession, storedDraft]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!resolvedSessionId) return;

        // Clear any existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }

        // Only save if value has changed
        const skip = autosaveSkip.current;
        if (skip && skip.sessionId === resolvedSessionId && skip.value === value) {
            autosaveSkip.current = null;
            return;
        }

        if (value !== lastSavedValue.current) {
            const wasEmpty = !containsLikelyNonWhitespace(lastSavedValue.current);
            const isEmpty = !containsLikelyNonWhitespace(value);
            const shouldDebounceForLargeDraft = isLargeTextInputValueLength(value.length);

            if (wasEmpty !== isEmpty && !shouldDebounceForLargeDraft) {
                // State transition: empty <-> non-empty
                // Save immediately for instant feedback on normal-sized drafts.
                saveDraft(value);
            } else if (!isEmpty) {
                // Text is being modified (or is too large for synchronous first-transition persistence).
                // Debounce to avoid excessive synchronous storage writes while the composer is active.
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
    }, [autoSaveInterval, resolvedSessionId, saveDraft, value]);

    // Save on app state change (background/inactive)
    useEffect(() => {
        if (!resolvedSessionId) return;

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                flushLatestDraftIfChanged();
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
        };
    }, [flushLatestDraftIfChanged, resolvedSessionId]);

    useWebLifecycleFlush(Boolean(resolvedSessionId), flushLatestDraftIfChanged);

    // Save on unmount only; session changes are handled explicitly above so they do not race with clearDraft().
    useEffect(() => {
        return () => {
            const currentSessionId = lastSessionId.current;
            const currentValue = latestValue.current;
            if (currentSessionId && currentValue !== lastSavedValue.current) {
                saveDraftForSession(currentSessionId, currentValue);
            }
        };
    }, [saveDraftForSession]);

    // Clear draft (used after message is sent)
    const clearDraft = useCallback(() => {
        if (!resolvedSessionId) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        if (latestValue.current !== '') {
            recordVisibleTextMutation(resolvedSessionId, '');
        }
        saveDraftForSession(resolvedSessionId, '');
        latestValue.current = '';
        lastSavedValue.current = '';
    }, [recordVisibleTextMutation, resolvedSessionId, saveDraftForSession]);

    const clearDraftForSessionIfCurrentValueMatches = useCallback((snapshot: SessionDraftTextSnapshot) => {
        const targetSessionId = normalizeSessionId(snapshot.sessionId);
        if (!targetSessionId) return false;

        if (lastSessionId.current !== targetSessionId) {
            const targetDraft = storage.getState().sessions[targetSessionId]?.draft;
            if (targetDraft !== snapshot.text) return false;
            storage.getState().updateSessionDraft(targetSessionId, null);
            return true;
        }

        if (latestValue.current !== snapshot.text) {
            if (latestValue.current !== lastSavedValue.current) {
                saveDraftForSession(targetSessionId, latestValue.current);
            }
            return false;
        }

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        if (latestValue.current !== '') {
            recordVisibleTextMutation(targetSessionId, '');
        }
        saveDraftForSession(targetSessionId, '');
        onChange('');
        latestValue.current = '';
        lastSavedValue.current = '';
        autosaveSkip.current = { sessionId: targetSessionId, value: '' };
        return true;
    }, [onChange, recordVisibleTextMutation, saveDraftForSession]);

    const clearDraftIfCurrentValueMatches = useCallback((expectedValue: string) => {
        if (!resolvedSessionId) return false;
        return clearDraftForSessionIfCurrentValueMatches({
            sessionId: resolvedSessionId,
            text: expectedValue,
        });
    }, [clearDraftForSessionIfCurrentValueMatches, resolvedSessionId]);

    // The current-value owner is also the handoff-clear owner. Callers that
    // need to compare an accepted snapshot must observe this value rather than
    // a rendered or persisted projection that can lag a local edit.
    const readLatestDraftValue = useCallback(() => latestValue.current, []);

    const restoreDraft = useCallback((draft: string) => {
        if (!resolvedSessionId) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        if (latestValue.current !== draft) {
            recordVisibleTextMutation(resolvedSessionId, draft);
        }
        onChange(draft);
        saveDraftForSession(resolvedSessionId, draft);
        latestValue.current = draft;
        lastSavedValue.current = draft;
        autosaveSkip.current = { sessionId: resolvedSessionId, value: draft };
    }, [onChange, recordVisibleTextMutation, resolvedSessionId, saveDraftForSession]);

    const restoreComposerSnapshot = useCallback((snapshot: SessionDraftTextSnapshot) => {
        const targetSessionId = normalizeSessionId(snapshot.sessionId);
        if (!targetSessionId) return;

        if (lastSessionId.current !== targetSessionId) {
            saveDraftForSession(targetSessionId, snapshot.text);
            return;
        }

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        if (latestValue.current !== snapshot.text) {
            recordVisibleTextMutation(targetSessionId, snapshot.text);
        }
        onChange(snapshot.text);
        saveDraftForSession(targetSessionId, snapshot.text);
        latestValue.current = snapshot.text;
        lastSavedValue.current = snapshot.text;
        autosaveSkip.current = { sessionId: targetSessionId, value: snapshot.text };
    }, [onChange, recordVisibleTextMutation, saveDraftForSession]);

    const restoreDraftForSessionIfCurrentValueMatches = useCallback((
        snapshot: SessionDraftTextSnapshot,
        expectedCurrentValue: string,
    ) => {
        const targetSessionId = normalizeSessionId(snapshot.sessionId);
        if (!targetSessionId) return false;

        if (lastSessionId.current !== targetSessionId) {
            const targetDraft = storage.getState().sessions[targetSessionId]?.draft;
            const currentDraft = typeof targetDraft === 'string' ? targetDraft : '';
            if (currentDraft !== expectedCurrentValue) return false;
            saveDraftForSession(targetSessionId, snapshot.text);
            return true;
        }

        if (latestValue.current !== expectedCurrentValue) {
            if (latestValue.current !== lastSavedValue.current) {
                saveDraftForSession(targetSessionId, latestValue.current);
            }
            return false;
        }

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        if (latestValue.current !== snapshot.text) {
            recordVisibleTextMutation(targetSessionId, snapshot.text);
        }
        onChange(snapshot.text);
        saveDraftForSession(targetSessionId, snapshot.text);
        latestValue.current = snapshot.text;
        lastSavedValue.current = snapshot.text;
        autosaveSkip.current = { sessionId: targetSessionId, value: snapshot.text };
        return true;
    }, [onChange, recordVisibleTextMutation, saveDraftForSession]);

    return {
        clearDraft,
        clearDraftIfCurrentValueMatches,
        clearDraftForSessionIfCurrentValueMatches,
        readLatestDraftValue,
        setDraftValue,
        restoreDraft,
        restoreComposerSnapshot,
        restoreDraftForSessionIfCurrentValueMatches,
    };
}
