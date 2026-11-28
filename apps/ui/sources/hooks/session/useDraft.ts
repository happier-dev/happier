import { useEffect, useRef, useCallback, useMemo, useLayoutEffect, useSyncExternalStore } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { sync } from '@/sync/sync';
import { followSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { clearForkInitialPromptV1, readForkInitialPromptV1 } from '@/sync/domains/sessionFork/forkInitialPromptV1';
import {
    clearSessionInitialPromptV1,
    readSessionInitialPromptV1,
    type SessionInitialPromptV1,
} from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';
import type { ComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';
import { containsLikelyNonWhitespace, isLargeTextInputValueLength } from '@/components/ui/forms/largeTextInputPolicy';
import { useWebLifecycleFlush } from './useWebLifecycleFlush';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    flushSessionDraft,
    getSessionComposerDraftSnapshot,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

const ALWAYS_PRESENTED = Object.freeze({ get: () => true, subscribe: () => () => {} });

interface UseDraftOptions {
    /** Exact route credential authority. A missing or retired lifetime is local-only. */
    accountLifetime: ServerAccountScopeLifetime | null;
    /** The authenticated frame keeps the same Account/document while replacing its Session child. */
    retainProjectionOnAccountRetirement?: boolean;
    /** Exact Session projection selected by the route owner. */
    session: Session | null;
    autoSaveInterval?: number; // in milliseconds, default 2000
    /** Whether this composer may hydrate and take custody of its draft (its own draft read is admitted). */
    active: boolean;
    /**
     * Whether its surface is presented, followed by subscription: custody resumes when the surface is shown
     * again without rendering the composer for the hide or the show. Absent means always presented.
     */
    presented?: Readonly<{ get: () => boolean; subscribe: (listener: () => void) => () => void }>;
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

const UNREADABLE_RETAINED_SESSION_DRAFT = Symbol('unreadableRetainedSessionDraft');

function readSessionComposerSnapshot(scope: ServerAccountScopeLifetime['scope'], sessionId: string) {
    const snapshot = getSessionComposerDraftSnapshot(scope, { kind: 'session', sessionId });
    return snapshot?.targetKind === 'session' ? snapshot : null;
}

/**
 * Binds one Session's live composer text (`textStore`) to its canonical draft replica. The text
 * store is the composer's live value; this owner adopts, seeds, persists, restores and clears it.
 * Ordinary repository text changes reach the text store without rendering this hook's host.
 */
export function useDraft(
    sessionId: string | null | undefined,
    textStore: ComposerTextStore,
    options: UseDraftOptions,
) {
    const { autoSaveInterval = 2000 } = options;
    const onChange = textStore.setPrompt;
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSavedValue = useRef<string>('');
    const lastSessionId = useRef<string | null>(null);
    const latestValue = useRef<string>(textStore.getPrompt());
    const autosaveSkip = useRef<Readonly<{ sessionId: string; value: string }> | null>(null);
    const active = options.active;
    const presented = options.presented ?? ALWAYS_PRESENTED;
    const accountLifetime = options.accountLifetime;
    const draftScope = accountLifetime?.isCurrent() === true ? accountLifetime.scope : null;
    const isDraftOwnerCurrent = useCallback(() => (
        accountLifetime !== null && accountLifetime.isCurrent()
    ), [accountLifetime]);
    const resolvedSessionId = normalizeSessionId(sessionId);
    const session = resolvedSessionId ? options.session : null;
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
            sessionInitialPrompt.source ? JSON.stringify(sessionInitialPrompt.source) : '',
            sessionInitialPrompt.text,
        ].join('\u0000');
    }, [resolvedSessionId, sessionInitialPrompt]);
    const activeSessionInitialPrompt = sessionInitialPromptKey && consumedSessionInitialPromptKeyRef.current !== sessionInitialPromptKey
        ? sessionInitialPrompt
        : null;

    // An unconsumed seed must be reconciled when a previously unavailable draft
    // becomes readable. Live text edits (including an accepted send's clear)
    // are delivered to the composer text store by the repository adoption below.
    const hasPendingDraftSeed = Boolean(forkInitialPromptText || activeSessionInitialPrompt);
    const subscribeDraftSeedReadiness = useCallback((listener: () => void) => (
        hasPendingDraftSeed && resolvedSessionId && draftScope
            ? subscribeSessionDraft(draftScope, { kind: 'session', sessionId: resolvedSessionId }, listener)
            : () => undefined
    ), [draftScope, hasPendingDraftSeed, resolvedSessionId]);
    const readDraftSeedTrigger = useCallback((): string | typeof UNREADABLE_RETAINED_SESSION_DRAFT | null => {
        if (!hasPendingDraftSeed || !resolvedSessionId || !draftScope) return null;
        const snapshot = readSessionComposerSnapshot(draftScope, resolvedSessionId);
        if (!snapshot && getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: resolvedSessionId })) {
            return UNREADABLE_RETAINED_SESSION_DRAFT;
        }
        const stored = snapshot?.composer.text.value;
        return typeof stored === 'string' && stored !== textStore.getPrompt() ? stored : null;
    }, [draftScope, hasPendingDraftSeed, resolvedSessionId, textStore]);
    const draftSeedTrigger = useSyncExternalStore(subscribeDraftSeedReadiness, readDraftSeedTrigger, readDraftSeedTrigger);

    // Exact hydration follows the active composer rather than the one-shot session-visible
    // callback. That makes a warm session retry as soon as its account scope becomes available,
    // while Sync remains the only owner of transport readiness, decryption, and reconciliation.
    useEffect(() => {
        if (!active || !draftScope || !accountLifetime || !resolvedSessionId) return;
        return followSignal(presented, (isPresented) => {
            if (!isPresented || !isDraftOwnerCurrent()) return;
            fireAndForget(sync.materializeExistingSessionDraft(resolvedSessionId, accountLifetime, 'held'), {
                tag: 'useDraft.materializeExistingSessionDraft',
            });
        });
    }, [accountLifetime, active, draftScope, isDraftOwnerCurrent, presented, resolvedSessionId]);

    // Credential replacement retires repository authority synchronously. Account switches
    // clear their projection; the authenticated frame retains its same-Account document
    // while replacing the Session child. Neither can write through the retired lifetime.
    useLayoutEffect(() => {
        if (!accountLifetime) return;
        const retirement = accountLifetime.onRetire(() => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
                saveTimeoutRef.current = null;
            }
            if (options.retainProjectionOnAccountRetirement) return;
            latestValue.current = '';
            lastSavedValue.current = '';
            lastSessionId.current = null;
            autosaveSkip.current = null;
            onChange('');
        });
        return () => retirement.dispose();
    }, [accountLifetime, onChange, options.retainProjectionOnAccountRetirement]);

    const saveDraftForSession = useCallback((targetSessionId: string, draft: string) => {
        if (!draftScope || !isDraftOwnerCurrent()) return;
        writeExistingSessionDraft({
            scope: draftScope,
            sessionId: targetSessionId,
            patch: { text: draft },
            materializationIntent: 'userEdit',
        });
        if (lastSessionId.current === targetSessionId) {
            lastSavedValue.current = draft;
        }
    }, [draftScope, isDraftOwnerCurrent]);

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!resolvedSessionId) return;
        saveDraftForSession(resolvedSessionId, draft);
    }, [resolvedSessionId, saveDraftForSession]);

    const flushDraftForSession = useCallback((targetSessionId: string) => {
        if (!draftScope || !isDraftOwnerCurrent()) return;
        fireAndForget(
            flushSessionDraft({
                scope: draftScope,
                address: { kind: 'session', sessionId: targetSessionId },
            }),
            { tag: 'useDraft.flushSessionDraft' },
        );
    }, [draftScope, isDraftOwnerCurrent]);

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
        if (!resolvedSessionId || !forkInitialPromptText || !draftScope || !isDraftOwnerCurrent()) return;
        fireAndForget(
            sync.patchSessionMetadataWithRetry(resolvedSessionId, (metadata) =>
                clearForkInitialPromptV1({ metadata }),
                {
                    serverId: draftScope.serverId,
                    ...(accountLifetime ? { accountLifetime } : {}),
                },
            ),
            { tag },
        );
    }, [accountLifetime, draftScope, forkInitialPromptText, isDraftOwnerCurrent, resolvedSessionId]);

    const clearSessionInitialPrompt = useCallback((tag: string) => {
        if (!resolvedSessionId || !sessionInitialPromptKey || !draftScope || !isDraftOwnerCurrent()) return;
        consumedSessionInitialPromptKeyRef.current = sessionInitialPromptKey;
        fireAndForget(
            sync.patchSessionMetadataWithRetry(resolvedSessionId, (metadata) =>
                clearSessionInitialPromptV1({ metadata }),
                {
                    serverId: draftScope.serverId,
                    ...(accountLifetime ? { accountLifetime } : {}),
                },
            ),
            { tag },
        );
    }, [accountLifetime, draftScope, isDraftOwnerCurrent, resolvedSessionId, sessionInitialPromptKey]);

    const composeSessionInitialPromptText = useCallback((baseText: string, prompt: SessionInitialPromptV1): string => {
        if (prompt.mode === 'replace') return prompt.text;
        const trimmedBase = baseText.trimEnd();
        if (!trimmedBase) return prompt.text;
        return `${trimmedBase}\n\n${prompt.text}`;
    }, []);

    const adoptPersistedDraftText = useCallback((draft: string) => {
        // The replica already holds the live text (a load re-run on refocus, or a remote value equal
        // to it): there is nothing to adopt, and a debounced flush of that text must stay scheduled.
        if (latestValue.current === draft) {
            lastSavedValue.current = draft;
            return;
        }
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
        }
        latestValue.current = draft;
        onChange(draft);
        lastSavedValue.current = draft;
        if (resolvedSessionId) autosaveSkip.current = { sessionId: resolvedSessionId, value: draft };
    }, [onChange, resolvedSessionId]);

    const persistSeededDraftText = useCallback((draft: string, prompt?: SessionInitialPromptV1 | null) => {
        if (latestValue.current !== draft) {
            latestValue.current = draft;
            onChange(draft);
        }
        if (draftScope && resolvedSessionId && isDraftOwnerCurrent()) {
            writeExistingSessionDraft({
                scope: draftScope,
                sessionId: resolvedSessionId,
                patch: {
                    text: draft,
                    ...(prompt?.source ? { sessionDiscussionSelectionSourceV1: prompt.source } : {}),
                },
                materializationIntent: 'seeded',
            });
        } else {
            saveDraft(draft);
        }
        lastSavedValue.current = draft;
    }, [draftScope, isDraftOwnerCurrent, onChange, resolvedSessionId, saveDraft]);

    // Load draft on mount and when focused. When switching sessions, always sync the composer
    // to the target session (draft or empty) to avoid leaking the previous session's text.
    useEffect(() => {
        if (!resolvedSessionId) return;

        const currentStoredSnapshot = draftScope && isDraftOwnerCurrent()
            ? readSessionComposerSnapshot(draftScope, resolvedSessionId)
            : null;
        const currentStoredDraft = currentStoredSnapshot?.composer.text.value ?? null;
        const hasUnreadableRetainedDraft = draftScope && isDraftOwnerCurrent() && !currentStoredSnapshot
            && getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: resolvedSessionId }) !== null;

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
            if (hasUnreadableRetainedDraft) {
                adoptPersistedDraftText('');
                return;
            }
            autosaveSkip.current = { sessionId: resolvedSessionId, value: currentValue };
            const baseStoredDraft = currentStoredDraft && currentStoredDraft.trim() ? currentStoredDraft : null;
            const baseText = baseStoredDraft ?? forkInitialPromptText ?? null;
            const nextDraft = baseText !== null && activeSessionInitialPrompt
                ? composeSessionInitialPromptText(baseText, activeSessionInitialPrompt)
                : baseText ?? (activeSessionInitialPrompt ? composeSessionInitialPromptText('', activeSessionInitialPrompt) : null);

            if (nextDraft !== null) {
                if (activeSessionInitialPrompt || baseStoredDraft === null) {
                    persistSeededDraftText(nextDraft, activeSessionInitialPrompt);
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
        // Custody resumes each time the surface is presented, reading the draft and text as they are then.
        const adoptPresentedDraft = () => {
            const currentStoredSnapshot = draftScope && isDraftOwnerCurrent()
                ? readSessionComposerSnapshot(draftScope, resolvedSessionId)
                : null;
            const currentStoredDraft = currentStoredSnapshot?.composer.text.value ?? null;
            const hasUnreadableRetainedDraft = draftScope && isDraftOwnerCurrent() && !currentStoredSnapshot
                && getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: resolvedSessionId }) !== null;
            const currentValue = latestValue.current;
            if (hasUnreadableRetainedDraft) return;

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
                    persistSeededDraftText(nextDraft, activeSessionInitialPrompt);
                } else {
                    adoptPersistedDraftText(nextDraft);
                }
                clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus.storedDraft');
                clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus.storedDraft');
            } else if (forkInitialPromptText && !currentValue.trim()) {
                const nextDraft = activeSessionInitialPrompt
                    ? composeSessionInitialPromptText(forkInitialPromptText, activeSessionInitialPrompt)
                    : forkInitialPromptText;
                persistSeededDraftText(nextDraft, activeSessionInitialPrompt);
                clearForkInitialPrompt('useDraft.consumeForkInitialPrompt.focus');
                clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus.forkPrompt');
            } else if (activeSessionInitialPrompt && canAdoptWithoutExternalDraft) {
                const nextDraft = composeSessionInitialPromptText(currentValue, activeSessionInitialPrompt);
                persistSeededDraftText(nextDraft, activeSessionInitialPrompt);
                clearSessionInitialPrompt('useDraft.consumeSessionInitialPrompt.focus');
            } else if (!currentStoredDraft) {
                // Ensure lastSavedValue is empty if there's no draft
                lastSavedValue.current = '';
            }
        };
        return followSignal(presented, (isPresented) => { if (isPresented) adoptPresentedDraft(); });
    }, [active, activeSessionInitialPrompt, adoptPersistedDraftText, presented, clearForkInitialPrompt, clearSessionInitialPrompt, composeSessionInitialPromptText, draftScope, flushDraftForSession, forkInitialPromptText, isDraftOwnerCurrent, onChange, persistSeededDraftText, resolvedSessionId, saveDraftForSession, draftSeedTrigger]);

    useEffect(() => {
        if (!draftScope || !resolvedSessionId || !isDraftOwnerCurrent()) return;
        let previousSnapshot = readSessionComposerSnapshot(draftScope, resolvedSessionId);
        return subscribeSessionDraft(draftScope, { kind: 'session', sessionId: resolvedSessionId }, () => {
            if (!isDraftOwnerCurrent()) return;
            const nextSnapshot = readSessionComposerSnapshot(draftScope, resolvedSessionId);
            const repositoryDraftWasRemoved = previousSnapshot !== null && nextSnapshot === null
                && getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: resolvedSessionId }) === null;
            previousSnapshot = nextSnapshot;
            if (nextSnapshot === null && !repositoryDraftWasRemoved) return;

            const next = nextSnapshot?.composer.text.value ?? '';
            if (next === latestValue.current) {
                lastSavedValue.current = next;
                return;
            }
            // Pending/conflicted edits stay materialized in the repository. This guard only
            // protects a caller-owned edit that has not yet reached that canonical replica.
            if (repositoryDraftWasRemoved && latestValue.current !== lastSavedValue.current) return;
            adoptPersistedDraftText(next);
        });
    }, [adoptPersistedDraftText, draftScope, isDraftOwnerCurrent, resolvedSessionId]);

    // Auto-save with smart debouncing
    const autosaveValue = useCallback((value: string) => {
        if (!resolvedSessionId) return;

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
    }, [resolvedSessionId, saveDraft, scheduleDraftFlush]);

    // This owner's own operations update `latestValue` before writing the text store. Any other
    // writer (a Composer transaction applied through the document owner) is adopted here,
    // synchronously, and persisted like an edit.
    useLayoutEffect(() => textStore.subscribe(() => {
        const next = textStore.getPrompt();
        if (next === latestValue.current) return;
        latestValue.current = next;
        autosaveValue(next);
    }), [autosaveValue, textStore]);

    // A persistence target that becomes available (the exact Account scope binding) or changes
    // receives the text typed before it.
    useEffect(() => {
        autosaveValue(latestValue.current);
    }, [autosaveValue]);

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
            const targetDraft = draftScope && isDraftOwnerCurrent()
                ? getSessionComposerDraftSnapshot(draftScope, { kind: 'session', sessionId: targetSessionId })
                    ?.composer.text.value
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
    }, [draftScope, flushDraftForSession, isDraftOwnerCurrent, onChange, saveDraftForSession]);

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
            const targetDraft = draftScope && isDraftOwnerCurrent()
                ? getSessionComposerDraftSnapshot(draftScope, { kind: 'session', sessionId: targetSessionId })
                    ?.composer.text.value
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
    }, [draftScope, isDraftOwnerCurrent, onChange, saveDraftForSession]);

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
