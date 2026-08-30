import { useEffect, useRef, useCallback, useMemo, useSyncExternalStore, useLayoutEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
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
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    captureSessionDraftCurrentness,
    areSessionDraftCurrentnessCapturesEqual,
    clearSessionDraftCurrentness,
    flushSessionDraft,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
    type SessionDraftCurrentness,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

interface UseDraftOptions {
    autoSaveInterval?: number; // in milliseconds, default 2000
    active?: boolean;
}

export type SessionDraftTextSnapshot = Readonly<{
    sessionId: string;
    text: string;
    scope?: ServerAccountScope;
    currentness?: SessionDraftCurrentness;
}>;

export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    options: UseDraftOptions = {}
) {
    const { autoSaveInterval = 2000 } = options;
    const scope = useActiveServerAccountScope();
    const address = useMemo(() => sessionId ? { kind: 'session' as const, sessionId } : null, [sessionId]);
    const subscribeToDraft = useCallback((listener: () => void) => {
        if (!scope || !address) return () => undefined;
        return subscribeSessionDraft(scope, address, listener);
    }, [address, scope]);
    const readDraftSnapshot = useCallback(() => {
        if (!scope || !address) return null;
        return getSessionDraftSnapshot(scope, address);
    }, [address, scope]);
    const draftSnapshot = useSyncExternalStore(subscribeToDraft, readDraftSnapshot, readDraftSnapshot);
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedValue = useRef<string>('');
    const lastSessionId = useRef<string | null>(null);
    const lastSessionScope = useRef<ServerAccountScope | null>(null);
    const latestValue = useRef<string>(value);
    const autosaveSkip = useRef<Readonly<{ sessionId: string; value: string }> | null>(null);
    const routeFocused = useIsFocused();
    const active = options.active ?? routeFocused;
    const session = sessionId ? storage.getState().sessions[sessionId] : null;
    const storedDraft = draftSnapshot?.document.composer.text.value ?? null;
    const forkInitialPrompt = readForkInitialPromptV1(session?.metadata);
    const forkInitialPromptText = forkInitialPrompt?.text ?? null;
    const sessionInitialPrompt = readSessionInitialPromptV1(session?.metadata);
    const consumedSessionInitialPromptKeyRef = useRef<string | null>(null);
    const sessionInitialPromptKey = useMemo(() => {
        if (!sessionId || !sessionInitialPrompt) return null;
        return [
            sessionId,
            sessionInitialPrompt.mode,
            String(sessionInitialPrompt.createdAtMs),
            sessionInitialPrompt.sourceSessionId ?? '',
            (sessionInitialPrompt.sourceMessageIds ?? []).join(','),
            sessionInitialPrompt.text,
        ].join('\u0000');
    }, [sessionId, sessionInitialPrompt]);
    const activeSessionInitialPrompt = sessionInitialPromptKey && consumedSessionInitialPromptKeyRef.current !== sessionInitialPromptKey
        ? sessionInitialPrompt
        : null;

    // The composer owns exact draft hydration because it is the consumer that reacts to both
    // account-scope readiness and surface visibility. Sync still owns transport readiness,
    // decryption, and repository reconciliation. This effect therefore retries naturally when
    // a warm session renders before its account scope is available, instead of relying on the
    // one-shot session-visible notification that may have already fired.
    useEffect(() => {
        if (!active || !scope || !sessionId) return;
        fireAndForget(sync.materializeExistingSessionDraft(sessionId), {
            tag: 'useDraft.materializeExistingSessionDraft',
        });
    }, [active, scope, sessionId]);

    // A render that React later abandons must not become the imperative draft authority. Sync
    // controlled values only after commit; input handlers and draft lifecycle operations update
    // this ref synchronously when they take custody.
    useLayoutEffect(() => {
        latestValue.current = value;
    }, [value]);

    const saveDraftForSession = useCallback((targetScope: ServerAccountScope | null, targetSessionId: string, draft: string) => {
        if (!targetScope) return;
        writeExistingSessionDraft({
            scope: targetScope,
            sessionId: targetSessionId,
            patch: { text: draft },
        });
        if (lastSessionId.current === targetSessionId) {
            lastSavedValue.current = draft;
        }
    }, []);

    const flushDraftForSession = useCallback((targetScope: ServerAccountScope | null, targetSessionId: string) => {
        if (!targetScope) return;
        fireAndForget(
            flushSessionDraft({
                scope: targetScope,
                address: { kind: 'session', sessionId: targetSessionId },
            }),
            { tag: 'useDraft.flushSessionDraft' },
        );
    }, []);

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!scope || !sessionId) return;
        saveDraftForSession(scope, sessionId, draft);
    }, [saveDraftForSession, scope, sessionId]);

    const flushLatestDraftIfChanged = useCallback(() => {
        if (!sessionId) return;
        const currentValue = latestValue.current;
        const hasScheduledFlush = saveTimeoutRef.current !== null;
        const hasUnpublishedValue = currentValue !== lastSavedValue.current;
        if (!hasScheduledFlush && !hasUnpublishedValue) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        if (hasUnpublishedValue) saveDraft(currentValue);
        flushDraftForSession(scope, sessionId);
    }, [flushDraftForSession, saveDraft, scope, sessionId]);

    const scheduleDraftFlush = useCallback((previousDraft: string, draft: string) => {
        if (!scope || !sessionId) return;
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        const wasEmpty = !containsLikelyNonWhitespace(previousDraft);
        const isEmpty = !containsLikelyNonWhitespace(draft);
        const shouldDebounceForLargeDraft = isLargeTextInputValueLength(draft.length);
        if ((wasEmpty !== isEmpty && !shouldDebounceForLargeDraft) || isEmpty) {
            flushDraftForSession(scope, sessionId);
            return;
        }
        saveTimeoutRef.current = setTimeout(() => {
            saveTimeoutRef.current = null;
            flushDraftForSession(scope, sessionId);
        }, autoSaveInterval);
    }, [autoSaveInterval, flushDraftForSession, scope, sessionId]);

    const setDraftValue = useCallback((nextValueOrUpdater: string | ((currentValue: string) => string)) => {
        const nextValue = typeof nextValueOrUpdater === 'function'
            ? nextValueOrUpdater(latestValue.current)
            : nextValueOrUpdater;
        const previousSavedValue = lastSavedValue.current;
        latestValue.current = nextValue;
        onChange(nextValue);
        if (nextValue === previousSavedValue) return;

        // Publish into the local canonical replica in the input event. Waiting for a passive
        // autosave effect leaves a window where an acknowledgement of an earlier prefix can
        // render before React commits the latest keystrokes and replace the live textarea.
        saveDraft(nextValue);
        scheduleDraftFlush(previousSavedValue, nextValue);
    }, [onChange, saveDraft, scheduleDraftFlush]);

    const clearForkInitialPrompt = useCallback((tag: string) => {
        if (!sessionId || !forkInitialPromptText) return;
        fireAndForget(
            sync.patchSessionMetadataWithRetry(sessionId, (metadata) =>
                clearForkInitialPromptV1({ metadata }),
            ),
            { tag },
        );
    }, [forkInitialPromptText, sessionId]);

    const clearSessionInitialPrompt = useCallback((tag: string) => {
        if (!sessionId || !sessionInitialPromptKey) return;
        consumedSessionInitialPromptKeyRef.current = sessionInitialPromptKey;
        fireAndForget(
            sync.patchSessionMetadataWithRetry(sessionId, (metadata) =>
                clearSessionInitialPromptV1({ metadata }),
            ),
            { tag },
        );
    }, [sessionId, sessionInitialPromptKey]);

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
        if (!sessionId) return;

        // Passive effects can be delayed across several fast input commits. Always reconcile
        // against the repository's current snapshot instead of the snapshot captured by the
        // render that scheduled this effect; adopting that older snapshot rolls the composer
        // back to a prefix the user has already advanced beyond.
        const currentStoredDraft = readDraftSnapshot()?.document.composer.text.value ?? null;

        const previousSessionId = lastSessionId.current;
        const previousScope = lastSessionScope.current;
        lastSessionId.current = sessionId;
        lastSessionScope.current = scope;
        const didSessionChange = previousSessionId !== null && previousSessionId !== sessionId;

        const currentValue = latestValue.current;

        if (didSessionChange) {
            if (previousSessionId && currentValue !== lastSavedValue.current) {
                saveDraftForSession(previousScope, previousSessionId, currentValue);
                flushDraftForSession(previousScope, previousSessionId);
            }
            autosaveSkip.current = { sessionId, value: currentValue };
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
    }, [active, activeSessionInitialPrompt, adoptPersistedDraftText, clearForkInitialPrompt, clearSessionInitialPrompt, composeSessionInitialPromptText, flushDraftForSession, forkInitialPromptText, onChange, persistSeededDraftText, readDraftSnapshot, saveDraftForSession, scope, sessionId, storedDraft]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!scope || !sessionId) return;

        // A later input/lifecycle operation can supersede this committed render before passive
        // effects run. In that case its value is historical and must never be written back over
        // the canonical replica (notably after an outbound handoff clears the composer).
        if (value !== latestValue.current) return;

        // Only save if value has changed
        const skip = autosaveSkip.current;
        if (skip && skip.sessionId === sessionId && skip.value === value) {
            autosaveSkip.current = null;
            return;
        }

        if (value !== lastSavedValue.current) {
            const previousSavedValue = lastSavedValue.current;
            saveDraft(value);
            scheduleDraftFlush(previousSavedValue, value);
        }
    }, [value, sessionId, scope, saveDraft, scheduleDraftFlush]);

    // The debounce belongs to the mounted session, not to an individual render. Clearing it on
    // every value-effect cleanup can cancel the timer scheduled synchronously by setDraftValue.
    useEffect(() => () => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }
    }, [scope, sessionId]);

    // Save on app state change (background/inactive)
    useEffect(() => {
        if (!sessionId) return;

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                flushLatestDraftIfChanged();
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
        };
    }, [flushLatestDraftIfChanged, sessionId]);

    useWebLifecycleFlush(Boolean(sessionId), flushLatestDraftIfChanged);

    // Save on unmount only; session changes are handled explicitly above so they do not race with clearDraft().
    useEffect(() => {
        return () => {
            const currentSessionId = lastSessionId.current;
            const currentScope = lastSessionScope.current;
            const currentValue = latestValue.current;
            if (currentSessionId && currentValue !== lastSavedValue.current) {
                saveDraftForSession(currentScope, currentSessionId, currentValue);
            }
            if (currentSessionId) flushDraftForSession(currentScope, currentSessionId);
        };
    }, [flushDraftForSession, saveDraftForSession]);

    // Clear draft (used after message is sent)
    const clearDraft = useCallback(() => {
        if (!sessionId) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        saveDraftForSession(scope, sessionId, '');
        flushDraftForSession(scope, sessionId);
        latestValue.current = '';
        lastSavedValue.current = '';
    }, [flushDraftForSession, saveDraftForSession, scope, sessionId]);

    const clearDraftForSessionIfCurrentValueMatches = useCallback((snapshot: SessionDraftTextSnapshot) => {
        const targetSessionId = snapshot.sessionId.trim();
        if (!targetSessionId) return false;

        if (lastSessionId.current !== targetSessionId) {
            if (!scope) return false;
            const targetDraft = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: targetSessionId })?.document.composer.text.value ?? '';
            if (targetDraft !== snapshot.text) return false;
            saveDraftForSession(scope, targetSessionId, '');
            flushDraftForSession(scope, targetSessionId);
            return true;
        }

        if (latestValue.current !== snapshot.text) {
            if (latestValue.current !== lastSavedValue.current) {
                saveDraftForSession(scope, targetSessionId, latestValue.current);
            }
            return false;
        }

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        saveDraftForSession(scope, targetSessionId, '');
        flushDraftForSession(scope, targetSessionId);
        onChange('');
        latestValue.current = '';
        lastSavedValue.current = '';
        autosaveSkip.current = { sessionId: targetSessionId, value: '' };
        return true;
    }, [flushDraftForSession, onChange, saveDraftForSession, scope]);

    const clearDraftIfCurrentValueMatches = useCallback((expectedValue: string) => {
        if (!sessionId) return false;
        return clearDraftForSessionIfCurrentValueMatches({
            sessionId,
            text: expectedValue,
        });
    }, [clearDraftForSessionIfCurrentValueMatches, sessionId]);

    const restoreDraft = useCallback((draft: string) => {
        if (!sessionId) return;

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        onChange(draft);
        saveDraftForSession(scope, sessionId, draft);
        latestValue.current = draft;
        lastSavedValue.current = draft;
        autosaveSkip.current = { sessionId, value: draft };
    }, [onChange, saveDraftForSession, scope, sessionId]);

    const restoreComposerSnapshot = useCallback((snapshot: SessionDraftTextSnapshot) => {
        const targetSessionId = snapshot.sessionId.trim();
        if (!targetSessionId) return;

        if (lastSessionId.current !== targetSessionId) {
            saveDraftForSession(scope, targetSessionId, snapshot.text);
            return;
        }

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        onChange(snapshot.text);
        saveDraftForSession(scope, targetSessionId, snapshot.text);
        latestValue.current = snapshot.text;
        lastSavedValue.current = snapshot.text;
        autosaveSkip.current = { sessionId: targetSessionId, value: snapshot.text };
    }, [onChange, saveDraftForSession, scope]);

    const restoreDraftForSessionIfCurrentValueMatches = useCallback((
        snapshot: SessionDraftTextSnapshot,
        expectedCurrentValue: string,
    ) => {
        const targetSessionId = snapshot.sessionId.trim();
        if (!targetSessionId) return false;

        if (lastSessionId.current !== targetSessionId) {
            if (!scope) return false;
            const currentValue = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: targetSessionId })?.document.composer.text.value ?? '';
            if (currentValue !== expectedCurrentValue) return false;
            saveDraftForSession(scope, targetSessionId, snapshot.text);
            return true;
        }

        if (latestValue.current !== expectedCurrentValue) {
            if (latestValue.current !== lastSavedValue.current) {
                saveDraftForSession(scope, targetSessionId, latestValue.current);
            }
            return false;
        }

        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }

        onChange(snapshot.text);
        saveDraftForSession(scope, targetSessionId, snapshot.text);
        latestValue.current = snapshot.text;
        lastSavedValue.current = snapshot.text;
        autosaveSkip.current = { sessionId: targetSessionId, value: snapshot.text };
        return true;
    }, [onChange, saveDraftForSession, scope]);

    const captureDraftForOutboundHandoff = useCallback((fieldIds?: readonly string[]): SessionDraftTextSnapshot | null => {
        if (!scope || !address || !sessionId) return null;
        return {
            sessionId,
            text: latestValue.current,
            scope,
            currentness: captureSessionDraftCurrentness({ scope, address, fieldIds }),
        };
    }, [address, scope, sessionId]);

    const clearDraftCurrentness = useCallback((snapshot: SessionDraftTextSnapshot): boolean => {
        if (!snapshot.scope || !snapshot.currentness) return false;
        const targetSessionId = snapshot.sessionId.trim();
        if (!targetSessionId) return false;
        const targetAddress = { kind: 'session' as const, sessionId: targetSessionId };
        if (lastSessionId.current === targetSessionId && latestValue.current !== snapshot.text) {
            saveDraftForSession(snapshot.scope, targetSessionId, latestValue.current);
        }
        const beforeClear = captureSessionDraftCurrentness({
            scope: snapshot.scope,
            address: targetAddress,
        });
        fireAndForget(
            clearSessionDraftCurrentness({
                scope: snapshot.scope,
                address: targetAddress,
                currentness: snapshot.currentness,
            }),
            { tag: 'useDraft.clearDraftCurrentness' },
        );
        const afterClear = captureSessionDraftCurrentness({
            scope: snapshot.scope,
            address: targetAddress,
        });
        const didClear = !areSessionDraftCurrentnessCapturesEqual(beforeClear, afterClear);
        if (lastSessionId.current === targetSessionId) {
            const remainingText = getSessionDraftSnapshot(snapshot.scope, targetAddress)?.document.composer.text.value ?? '';
            onChange(remainingText);
            latestValue.current = remainingText;
            lastSavedValue.current = remainingText;
            autosaveSkip.current = { sessionId: targetSessionId, value: remainingText };
        }
        return didClear;
    }, [onChange, saveDraftForSession]);

    return {
        clearDraft,
        clearDraftIfCurrentValueMatches,
        clearDraftForSessionIfCurrentValueMatches,
        setDraftValue,
        restoreDraftForSessionIfCurrentValueMatches,
        restoreDraft,
        restoreComposerSnapshot,
        captureDraftForOutboundHandoff,
        clearDraftCurrentness,
        draftSnapshot,
        draftScope: scope,
    };
}
