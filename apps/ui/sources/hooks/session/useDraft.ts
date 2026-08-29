import { useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
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
import { containsLikelyNonWhitespace, isLargeTextInputValueLength } from '@/components/ui/forms/largeTextInputPolicy';
import { useWebLifecycleFlush } from './useWebLifecycleFlush';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import {
    flushSessionDraft,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

interface UseDraftOptions {
    autoSaveInterval?: number; // in milliseconds, default 2000
    active?: boolean;
    /**
     * The existing Session composer may advance its semantic revision as soon
     * as visible text changes. The debounced persistence write receives the
     * returned token so that one edit cannot advance the same revision twice.
     */
    onTextMutation?: (input: Readonly<{
        sessionId: string;
        text: string;
    }>) => unknown;
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
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedValue = useRef<string>('');
    const lastSessionId = useRef<string | null>(null);
    const latestValue = useRef<string>(value);
    const autosaveSkip = useRef<Readonly<{ sessionId: string; value: string }> | null>(null);
    const routeFocused = useIsFocused();
    const active = options.active ?? routeFocused;
    const draftScope = useActiveServerAccountScope();
    const resolvedSessionId = normalizeSessionId(sessionId);
    const session = resolvedSessionId ? storage.getState().sessions[resolvedSessionId] : null;
    const repositoryDraft = resolvedSessionId && draftScope
        ? getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: resolvedSessionId })
        : null;
    const storedDraft = typeof repositoryDraft?.document.composer.text.value === 'string'
        ? repositoryDraft.document.composer.text.value
        : null;
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

    // Do not let a render that React later abandons become the imperative draft authority.
    // Input handlers and draft lifecycle operations update this ref synchronously; controlled
    // values are reconciled only once their render commits.
    useLayoutEffect(() => {
        latestValue.current = value;
    }, [value]);

    const saveDraftForSession = useCallback((targetSessionId: string, draft: string) => {
        if (!draftScope) return;
        writeExistingSessionDraft({
            scope: draftScope,
            sessionId: targetSessionId,
            patch: { text: draft },
            materializationIntent: 'userEdit',
        });
        if (lastSessionId.current === targetSessionId) {
            lastSavedValue.current = draft;
        }
    }, [draftScope]);

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!resolvedSessionId) return;
        saveDraftForSession(resolvedSessionId, draft);
    }, [resolvedSessionId, saveDraftForSession]);

    const flushDraftForSession = useCallback((targetSessionId: string) => {
        if (!draftScope) return;
        fireAndForget(
            flushSessionDraft({
                scope: draftScope,
                address: { kind: 'session', sessionId: targetSessionId },
            }),
            { tag: 'useDraft.flushSessionDraft' },
        );
    }, [draftScope]);

    const flushLatestDraftIfChanged = useCallback(() => {
        if (!resolvedSessionId) return;
        const currentValue = latestValue.current;
        const hasScheduledFlush = saveTimeoutRef.current !== null;
        const hasUnpublishedValue = currentValue !== lastSavedValue.current;
        if (!hasScheduledFlush && !hasUnpublishedValue) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        if (hasUnpublishedValue) saveDraft(currentValue);
        flushDraftForSession(resolvedSessionId);
    }, [flushDraftForSession, resolvedSessionId, saveDraft]);

    const scheduleDraftFlush = useCallback((previousDraft: string, draft: string) => {
        if (!resolvedSessionId) return;
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        const wasEmpty = !containsLikelyNonWhitespace(previousDraft);
        const isEmpty = !containsLikelyNonWhitespace(draft);
        const shouldDebounceForLargeDraft = isLargeTextInputValueLength(draft.length);
        if ((wasEmpty !== isEmpty && !shouldDebounceForLargeDraft) || isEmpty) {
            flushDraftForSession(resolvedSessionId);
            return;
        }
        saveTimeoutRef.current = setTimeout(() => {
            saveTimeoutRef.current = null;
            flushDraftForSession(resolvedSessionId);
        }, autoSaveInterval);
    }, [autoSaveInterval, flushDraftForSession, resolvedSessionId]);

    const setDraftValue = useCallback((nextValueOrUpdater: string | ((currentValue: string) => string)) => {
        const nextValue = typeof nextValueOrUpdater === 'function'
            ? nextValueOrUpdater(latestValue.current)
            : nextValueOrUpdater;
        const previousSavedValue = lastSavedValue.current;
        latestValue.current = nextValue;
        onChange(nextValue);
        if (nextValue === previousSavedValue) return;

        saveDraft(nextValue);
        scheduleDraftFlush(previousSavedValue, nextValue);
    }, [onChange, saveDraft, scheduleDraftFlush]);

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

    const adoptPersistedDraftText = useCallback((draft: string) => {
        if (latestValue.current !== draft) {
            latestValue.current = draft;
            onChange(draft);
        }
        lastSavedValue.current = draft;
    }, [onChange]);

    const persistSeededDraftText = useCallback((draft: string) => {
        if (latestValue.current !== draft) {
            latestValue.current = draft;
            onChange(draft);
        }
        saveDraft(draft);
        lastSavedValue.current = draft;
    }, [onChange, saveDraft]);

    // Load draft on mount and when focused. When switching sessions, always sync the composer
    // to the target session (draft or empty) to avoid leaking the previous session's text.
    useEffect(() => {
        if (!resolvedSessionId) return;

        const currentStoredDraft = draftScope
            ? getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: resolvedSessionId })
                ?.document.composer.text.value ?? null
            : null;

        const previousSessionId = lastSessionId.current;
        lastSessionId.current = resolvedSessionId;
        const didSessionChange = previousSessionId !== null && previousSessionId !== resolvedSessionId;

        const currentValue = latestValue.current;

        if (didSessionChange) {
            if (previousSessionId && currentValue !== lastSavedValue.current) {
                saveDraftForSession(previousSessionId, currentValue);
            }
            if (previousSessionId) {
                flushDraftForSession(previousSessionId);
            }
            autosaveSkip.current = { sessionId: resolvedSessionId, value: currentValue };
            const baseStoredDraft = currentStoredDraft && currentStoredDraft.trim() ? currentStoredDraft : null;
            const baseText = baseStoredDraft ?? forkInitialPromptText ?? null;
            const nextDraft = baseText !== null && activeSessionInitialPrompt
                ? composeSessionInitialPromptText(baseText, activeSessionInitialPrompt)
                : baseText ?? (activeSessionInitialPrompt ? composeSessionInitialPromptText('', activeSessionInitialPrompt) : null);

            if (nextDraft !== null) {
                if (activeSessionInitialPrompt || baseStoredDraft === null) {
                    persistSeededDraftText(nextDraft);
                } else {
                    adoptPersistedDraftText(nextDraft);
                }
                if (baseStoredDraft !== null) {
                    clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.sessionChange.storedDraft');
            } else if (forkInitialPromptText) {
                    clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.sessionChange');
                }
                clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.sessionChange');
            } else if (currentValue.trim()) {
                latestValue.current = '';
                onChange('');
                lastSavedValue.current = '';
            } else {
                lastSavedValue.current = '';
            }
            return;
        }

        if (!active) return;

        const externalDraft = currentStoredDraft && currentStoredDraft.trim() ? currentStoredDraft : null;
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
            if (activeSessionInitialPrompt) {
                persistSeededDraftText(nextDraft);
            } else {
                adoptPersistedDraftText(nextDraft);
            }
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus.storedDraft');
            clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus.storedDraft');
        } else if (forkInitialPromptText && !currentValue.trim()) {
            const nextDraft = activeSessionInitialPrompt
                ? composeSessionInitialPromptText(forkInitialPromptText, activeSessionInitialPrompt)
                : forkInitialPromptText;
            persistSeededDraftText(nextDraft);
            clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus');
            clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus.forkPrompt');
        } else if (activeSessionInitialPrompt && canAdoptWithoutExternalDraft) {
            const nextDraft = composeSessionInitialPromptText(currentValue, activeSessionInitialPrompt);
            persistSeededDraftText(nextDraft);
            clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus');
        } else if (!currentStoredDraft) {
            // Ensure lastSavedValue is empty if there's no draft
            lastSavedValue.current = '';
        }
    }, [active, activeSessionInitialPrompt, adoptPersistedDraftText, clearForkInitialPrompt, clearSessionInitialPrompt, composeSessionInitialPromptText, draftScope, flushDraftForSession, forkInitialPromptText, onChange, persistSeededDraftText, resolvedSessionId, saveDraftForSession, storedDraft]);

    useEffect(() => {
        if (!draftScope || !resolvedSessionId) return;
        return subscribeSessionDraft(draftScope, { kind: 'session', sessionId: resolvedSessionId }, () => {
            const next = getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: resolvedSessionId })
                ?.document.composer.text.value;
            if (typeof next !== 'string' || next === latestValue.current) return;
            latestValue.current = next;
            lastSavedValue.current = next;
            onChange(next);
        });
    }, [draftScope, onChange, resolvedSessionId]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!resolvedSessionId) return;

        // A later input/lifecycle operation can supersede this committed render before passive
        // effects run. Its closed-over value is then historical and must not be persisted back
        // over the canonical replica after an outbound handoff clear.
        if (value !== latestValue.current) return;

        // Only save if value has changed
        const skip = autosaveSkip.current;
        if (skip && skip.sessionId === resolvedSessionId && skip.value === value) {
            autosaveSkip.current = null;
            return;
        }

        if (value !== lastSavedValue.current) {
            const previousSavedValue = lastSavedValue.current;
            saveDraft(value);
            scheduleDraftFlush(previousSavedValue, value);
        }
    }, [resolvedSessionId, saveDraft, scheduleDraftFlush, value]);

    useEffect(() => () => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }
    }, [draftScope, resolvedSessionId]);

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
            if (currentSessionId) flushDraftForSession(currentSessionId);
        };
    }, [flushDraftForSession, saveDraftForSession]);

    // Clear draft (used after message is sent)
    const clearDraft = useCallback(() => {
        if (!resolvedSessionId) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        saveDraftForSession(resolvedSessionId, '');
        flushDraftForSession(resolvedSessionId);
        latestValue.current = '';
        lastSavedValue.current = '';
    }, [flushDraftForSession, resolvedSessionId, saveDraftForSession]);

    const clearDraftForSessionIfCurrentValueMatches = useCallback((snapshot: SessionDraftTextSnapshot) => {
        const targetSessionId = normalizeSessionId(snapshot.sessionId);
        if (!targetSessionId) return false;

        if (lastSessionId.current !== targetSessionId) {
            const targetDraft = draftScope
                ? getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: targetSessionId })
                    ?.document.composer.text.value
                : undefined;
            if (targetDraft !== snapshot.text) return false;
            saveDraftForSession(targetSessionId, '');
            flushDraftForSession(targetSessionId);
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

        saveDraftForSession(targetSessionId, '');
        flushDraftForSession(targetSessionId);
        onChange('');
        latestValue.current = '';
        lastSavedValue.current = '';
        autosaveSkip.current = { sessionId: targetSessionId, value: '' };
        return true;
    }, [draftScope, flushDraftForSession, onChange, saveDraftForSession]);

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

        onChange(draft);
        saveDraftForSession(resolvedSessionId, draft);
        latestValue.current = draft;
        lastSavedValue.current = draft;
        autosaveSkip.current = { sessionId: resolvedSessionId, value: draft };
    }, [onChange, resolvedSessionId, saveDraftForSession]);

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

        onChange(snapshot.text);
        saveDraftForSession(targetSessionId, snapshot.text);
        latestValue.current = snapshot.text;
        lastSavedValue.current = snapshot.text;
        autosaveSkip.current = { sessionId: targetSessionId, value: snapshot.text };
    }, [onChange, saveDraftForSession]);

    const restoreDraftForSessionIfCurrentValueMatches = useCallback((
        snapshot: SessionDraftTextSnapshot,
        expectedCurrentValue: string,
    ) => {
        const targetSessionId = normalizeSessionId(snapshot.sessionId);
        if (!targetSessionId) return false;

        if (lastSessionId.current !== targetSessionId) {
            const targetDraft = draftScope
                ? getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: targetSessionId })
                    ?.document.composer.text.value
                : undefined;
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

        onChange(snapshot.text);
        saveDraftForSession(targetSessionId, snapshot.text);
        latestValue.current = snapshot.text;
        lastSavedValue.current = snapshot.text;
        autosaveSkip.current = { sessionId: targetSessionId, value: snapshot.text };
        return true;
    }, [draftScope, onChange, saveDraftForSession]);

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
