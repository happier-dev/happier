import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { AppState, type AppStateStatus } from 'react-native';

import {
    type AgentInputTextSelection,
    type AgentInputLocalUiStateV1,
    agentInputDraftOwnerKey,
    clearAgentInputLocalUiState,
    flushAgentInputLocalUiState,
    isAgentInputLocalUiStateTextBasisApplicable,
    patchAgentInputLocalUiState,
    readAgentInputLocalUiState,
    type AgentInputDraftOwner,
} from '@/sync/domains/input/draftValues/agentInputLocalUiStateStore';
import { structuredInputMentionSurvivesText } from '@/components/sessions/agentInput/structuredInputMentions';
import {
    type ComposerStructuredInputMention,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';
import { existingSessionDraftSemanticValues } from '@/sync/domains/input/drafts/existingSessionDraftSemanticValues';
import {
    subscribeSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import {
    areServerAccountScopesEqual,
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useAgentInputComposerDraftGarbageCollection } from './useAgentInputComposerDraftGarbageCollection';
import { useWebLifecycleFlush } from './useWebLifecycleFlush';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type SessionAgentInputComposerPersistence = Readonly<{
    expanded: boolean;
    setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
    clearTransientInputState: () => void;
    captureTransientInputState: () => AgentInputLocalUiStateV1 | null;
    restoreTransientInputState: (state: AgentInputLocalUiStateV1 | null) => void;
    inputPersistence: Readonly<{
        initialScrollY?: number;
        initialSelection?: AgentInputTextSelection;
        restoreToken: string;
        onScrollYChange: (scrollY: number) => void;
        onSelectionChangePersist: (selection: AgentInputTextSelection, textLength: number) => void;
    }>;
    structuredInputPersistence: Readonly<{
        mentions: readonly ComposerStructuredInputMention[];
        onMentionsChange: (mentions: readonly ComposerStructuredInputMention[]) => void;
    }>;
}>;

export type UseSessionAgentInputComposerPersistenceParams = Readonly<{
    sessionId: string | null | undefined;
    text?: string;
    textLength?: number;
    fontScale?: number;
}>;

const SESSION_AGENT_INPUT_SCROLL_SELECTION_PERSISTENCE_DEBOUNCE_MS = 150;
const SESSION_AGENT_INPUT_STRUCTURED_MENTION_PERSISTENCE_DEBOUNCE_MS = 250;

function normalizeSessionId(sessionId: string | null | undefined): string | null {
    if (typeof sessionId !== 'string') return null;
    const trimmed = sessionId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function createSessionDraftOwner(sessionId: string | null | undefined): AgentInputDraftOwner | null {
    const normalizedSessionId = normalizeSessionId(sessionId);
    return normalizedSessionId ? { kind: 'session', sessionId: normalizedSessionId } : null;
}

function areOwnersEqual(
    left: AgentInputDraftOwner | null,
    right: AgentInputDraftOwner | null,
): boolean {
    if (!left || !right) return left === right;
    if (left.kind !== right.kind) return false;
    if (left.kind === 'session') {
        return right.kind === 'session' && left.sessionId === right.sessionId;
    }
    return right.kind === 'newSession' && left.flowId === right.flowId;
}

function areNullableScopesEqual(
    left: ServerAccountScope | null,
    right: ServerAccountScope | null,
): boolean {
    if (!left || !right) return left === right;
    return areServerAccountScopesEqual(left, right);
}

function useStableServerAccountScope(scope: ServerAccountScope | null): ServerAccountScope | null {
    const stableScopeRef = React.useRef<ServerAccountScope | null>(scope);
    if (!areNullableScopesEqual(stableScopeRef.current, scope)) {
        stableScopeRef.current = scope;
    }
    return stableScopeRef.current;
}

function readExpanded(
    scope: ServerAccountScope | null,
    owner: AgentInputDraftOwner | null,
): boolean {
    if (!owner) return false;
    return readAgentInputLocalUiState(scope, owner)?.expanded === true;
}

function readInputState(
    scope: ServerAccountScope | null,
    owner: AgentInputDraftOwner | null,
    options: Readonly<{ textLength?: number; fontScale?: number }>,
) {
    if (!owner) return null;
    return readAgentInputLocalUiState(scope, owner, options);
}

function filterMentionsForText(
    mentions: readonly ComposerStructuredInputMention[],
    text: string | undefined,
): readonly ComposerStructuredInputMention[] {
    if (typeof text !== 'string') return mentions;
    // The composer owns the rule; this module used to carry its own copy of it, which is one
    // rule with two owners the moment either side changes.
    return mentions.filter((mention) => structuredInputMentionSurvivesText(text, mention));
}

function areMentionListsEqual(
    left: readonly ComposerStructuredInputMention[],
    right: readonly ComposerStructuredInputMention[],
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function readStructuredMentions(
    scope: ServerAccountScope | null,
    owner: AgentInputDraftOwner | null,
    text: string | undefined,
): readonly ComposerStructuredInputMention[] {
    if (!scope || !owner || owner.kind !== 'session') return [];
    return filterMentionsForText(
        existingSessionDraftSemanticValues.read(scope, owner.sessionId, 'structuredInput.mentions') ?? [],
        text,
    );
}

type ScopedComposerPersistenceState = Readonly<{
    owner: AgentInputDraftOwner | null;
    scope: ServerAccountScope | null;
    text: string | undefined;
    textLength: number | undefined;
    fontScale: number | undefined;
    expanded: boolean;
    inputState: ReturnType<typeof readInputState>;
    structuredInputMentions: readonly ComposerStructuredInputMention[];
}>;

function readScopedComposerPersistenceState(
    scope: ServerAccountScope | null,
    owner: AgentInputDraftOwner | null,
    options: Readonly<{
        text?: string;
        textLength?: number;
        fontScale?: number;
    }>,
): ScopedComposerPersistenceState {
    return {
        owner,
        scope,
        text: options.text,
        textLength: options.textLength,
        fontScale: options.fontScale,
        expanded: readExpanded(scope, owner),
        inputState: readInputState(scope, owner, {
            textLength: options.textLength,
            fontScale: options.fontScale,
        }),
        structuredInputMentions: readStructuredMentions(scope, owner, options.text),
    };
}

function isScopedComposerPersistenceStateCurrent(
    state: ScopedComposerPersistenceState,
    scope: ServerAccountScope | null,
    owner: AgentInputDraftOwner | null,
    options: Readonly<{
        text?: string;
        textLength?: number;
        fontScale?: number;
    }>,
): boolean {
    return areOwnersEqual(state.owner, owner)
        && areNullableScopesEqual(state.scope, scope)
        && state.text === options.text
        && state.textLength === options.textLength
        && state.fontScale === options.fontScale;
}

/**
 * Identifies a restore GENERATION: it changes only when the composer adopts a
 * different owner/scope, when the persisted basis becomes applicable to the
 * live text (the draft finishing its async load on session open), or after an
 * explicit transient-state restore. It must never churn on self-originated
 * persist writes (selection/scroll patches made while the user types):
 * consumers re-apply persisted selection/scroll when this token changes, and
 * echoing our own writes back as "restores" drags the user's live caret to a
 * stale position mid-typing (web composer incident, 2026-07-22).
 */
function buildRestoreToken(
    owner: AgentInputDraftOwner | null,
    scope: ServerAccountScope | null,
    restoreEpoch: number,
    restoreBasisAdopted: boolean,
): string {
    const ownerKey = agentInputDraftOwnerKey(owner) ?? 'none';
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : 'none';
    return `${ownerKey}:${scopeKey}:${restoreEpoch}:${restoreBasisAdopted ? 'adopted' : 'pending'}`;
}

export function useSessionAgentInputComposerPersistence({
    sessionId,
    text,
    textLength,
    fontScale,
}: UseSessionAgentInputComposerPersistenceParams): SessionAgentInputComposerPersistence {
    const scope = useStableServerAccountScope(useActiveServerAccountScope());
    useAgentInputComposerDraftGarbageCollection(scope);
    const isFocused = useIsFocused();
    const owner = React.useMemo(() => createSessionDraftOwner(sessionId), [sessionId]);
    const subscribeToSemanticDraft = React.useCallback((listener: () => void) => {
        if (!scope || owner?.kind !== 'session') return () => undefined;
        return subscribeSessionDraft(scope, { kind: 'session', sessionId: owner.sessionId }, listener);
    }, [owner, scope]);
    const readStructuredMentionsSignature = React.useCallback(() => {
        if (!scope || owner?.kind !== 'session') return 'disabled';
        return JSON.stringify(
            existingSessionDraftSemanticValues.read(scope, owner.sessionId, 'structuredInput.mentions') ?? [],
        );
    }, [owner, scope]);
    React.useSyncExternalStore(
        subscribeToSemanticDraft,
        readStructuredMentionsSignature,
        readStructuredMentionsSignature,
    );
    const inputStateReadOptions = React.useMemo(() => ({ textLength, fontScale }), [fontScale, textLength]);
    const scopedStateReadOptions = React.useMemo(() => ({ text, textLength, fontScale }), [fontScale, text, textLength]);
    const previousOwnerRef = React.useRef<Readonly<{
        owner: AgentInputDraftOwner | null;
        scope: ServerAccountScope | null;
    }> | null>(null);
    const [scopedState, setScopedState] = React.useState(() =>
        readScopedComposerPersistenceState(scope, owner, scopedStateReadOptions),
    );
    // Bumped only by explicit restores (e.g. send-failure transient-state
    // rollback) so consumers re-apply the restored selection/scroll exactly
    // once. Self-originated persist writes must not touch it — see
    // buildRestoreToken.
    const [restoreEpoch, setRestoreEpoch] = React.useState(0);
    const currentScopedState = isScopedComposerPersistenceStateCurrent(scopedState, scope, owner, scopedStateReadOptions)
        ? scopedState
        : readScopedComposerPersistenceState(scope, owner, scopedStateReadOptions);
    const expanded = currentScopedState.expanded;
    const inputState = currentScopedState.inputState;
    const structuredInputMentions = readStructuredMentions(scope, owner, text);
    // One-way latch per owner/scope: flips when the persisted basis first
    // becomes applicable to the live text (draft adopted after an async load on
    // session open), so restoreToken changes exactly once at the moment the
    // withheld scroll/selection payload becomes deliverable. Self-originated
    // persists keep the basis applicable and never flip it back.
    const restoreOwnerScopeKey = `${agentInputDraftOwnerKey(owner) ?? 'none'}:${scope ? serverAccountScopeKeySuffix(scope) : 'none'}`;
    const restoreBasisLatchRef = React.useRef<Readonly<{ key: string; adopted: boolean }>>({
        key: restoreOwnerScopeKey,
        adopted: false,
    });
    if (restoreBasisLatchRef.current.key !== restoreOwnerScopeKey) {
        restoreBasisLatchRef.current = { key: restoreOwnerScopeKey, adopted: false };
    }
    if (
        !restoreBasisLatchRef.current.adopted
        && isAgentInputLocalUiStateTextBasisApplicable(inputState, textLength)
    ) {
        restoreBasisLatchRef.current = { key: restoreOwnerScopeKey, adopted: true };
    }
    const restoreBasisAdopted = restoreBasisLatchRef.current.adopted;
    const setScopedStateFromStore = React.useCallback((
        nextScope: ServerAccountScope | null,
        nextOwner: AgentInputDraftOwner | null,
        nextOptions: Readonly<{
            text?: string;
            textLength?: number;
            fontScale?: number;
        }>,
    ) => {
        setScopedState(readScopedComposerPersistenceState(nextScope, nextOwner, nextOptions));
    }, []);
    const setScopedStateWithExpanded = React.useCallback((nextExpanded: boolean) => {
        setScopedState((current) => {
            const base = isScopedComposerPersistenceStateCurrent(current, scope, owner, scopedStateReadOptions)
                ? current
                : readScopedComposerPersistenceState(scope, owner, scopedStateReadOptions);
            return {
                ...base,
                expanded: nextExpanded,
            };
        });
    }, [owner, scope, scopedStateReadOptions]);
    const setScopedStateWithInputState = React.useCallback(() => {
        setScopedState((current) => {
            const base = isScopedComposerPersistenceStateCurrent(current, scope, owner, scopedStateReadOptions)
                ? current
                : readScopedComposerPersistenceState(scope, owner, scopedStateReadOptions);
            return {
                ...base,
                inputState: readInputState(scope, owner, inputStateReadOptions),
            };
        });
    }, [inputStateReadOptions, owner, scope, scopedStateReadOptions]);
    const pendingFlushScopeRef = React.useRef<ServerAccountScope | null | undefined>(undefined);
    const pendingFlushTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingStructuredFlushTargetRef = React.useRef<Readonly<{
        scope: ServerAccountScope;
        sessionId: string;
    }> | null>(null);
    const pendingStructuredFlushTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const flushPendingUiState = React.useCallback((targetScope?: ServerAccountScope | null) => {
        if (pendingFlushTimeoutRef.current) {
            clearTimeout(pendingFlushTimeoutRef.current);
            pendingFlushTimeoutRef.current = null;
        }
        const scopeToFlush = typeof targetScope === 'undefined'
            ? pendingFlushScopeRef.current
            : targetScope;
        if (typeof scopeToFlush === 'undefined') return;
        flushAgentInputLocalUiState(scopeToFlush);
        if (pendingFlushScopeRef.current === scopeToFlush) {
            pendingFlushScopeRef.current = undefined;
        }
    }, []);

    const flushPendingStructuredInput = React.useCallback((target?: Readonly<{
        scope: ServerAccountScope;
        sessionId: string;
    }> | null) => {
        if (pendingStructuredFlushTimeoutRef.current) {
            clearTimeout(pendingStructuredFlushTimeoutRef.current);
            pendingStructuredFlushTimeoutRef.current = null;
        }
        const targetToFlush = typeof target === 'undefined'
            ? pendingStructuredFlushTargetRef.current
            : target;
        if (!targetToFlush) return;
        fireAndForget(
            existingSessionDraftSemanticValues.flush(targetToFlush.scope, targetToFlush.sessionId),
            { tag: 'useSessionAgentInputComposerPersistence.flushSemanticDraft' },
        );
        if (pendingStructuredFlushTargetRef.current === targetToFlush) {
            pendingStructuredFlushTargetRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        const previous = previousOwnerRef.current;
        if (
            previous
            && (!areOwnersEqual(previous.owner, owner) || !areNullableScopesEqual(previous.scope, scope))
        ) {
            flushPendingUiState(previous.scope);
            flushPendingStructuredInput(
                previous.scope && previous.owner?.kind === 'session'
                    ? { scope: previous.scope, sessionId: previous.owner.sessionId }
                    : null,
            );
        }

        previousOwnerRef.current = { owner, scope };

        if (!owner) {
            setScopedStateFromStore(scope, owner, scopedStateReadOptions);
            return;
        }

        if (!isFocused) return;
        setScopedStateFromStore(scope, owner, scopedStateReadOptions);
        const mentions = readStructuredMentions(scope, owner, text);
        if (scope && owner.kind === 'session') {
            const persistedMentions = existingSessionDraftSemanticValues.read(scope, owner.sessionId, 'structuredInput.mentions') ?? [];
            if (!areMentionListsEqual(mentions, persistedMentions)) {
                existingSessionDraftSemanticValues.write(scope, owner.sessionId, 'structuredInput.mentions', mentions);
                flushPendingStructuredInput({ scope, sessionId: owner.sessionId });
            }
        }
    }, [flushPendingStructuredInput, flushPendingUiState, isFocused, owner, scope, scopedStateReadOptions, setScopedStateFromStore, text]);

    React.useEffect(() => {
        const flushForBackground = () => {
            flushPendingUiState(scope);
            flushPendingStructuredInput(
                scope && owner?.kind === 'session' ? { scope, sessionId: owner.sessionId } : null,
            );
        };

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                flushForBackground();
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);
        return () => {
            subscription.remove();
        };
    }, [flushPendingStructuredInput, flushPendingUiState, owner, scope]);

    const flushForWebLifecycle = React.useCallback(() => {
        flushPendingUiState(scope);
        flushPendingStructuredInput(
            scope && owner?.kind === 'session' ? { scope, sessionId: owner.sessionId } : null,
        );
    }, [flushPendingStructuredInput, flushPendingUiState, owner, scope]);
    useWebLifecycleFlush(true, flushForWebLifecycle);

    React.useEffect(() => {
        return () => {
            const previous = previousOwnerRef.current;
            if (previous) {
                flushPendingUiState(previous.scope);
                flushPendingStructuredInput(
                    previous.scope && previous.owner?.kind === 'session'
                        ? { scope: previous.scope, sessionId: previous.owner.sessionId }
                        : null,
                );
            }
        };
    }, [flushPendingStructuredInput, flushPendingUiState]);

    const scheduleUiStateFlush = React.useCallback((targetScope: ServerAccountScope | null) => {
        pendingFlushScopeRef.current = targetScope;
        if (pendingFlushTimeoutRef.current) {
            clearTimeout(pendingFlushTimeoutRef.current);
        }
        pendingFlushTimeoutRef.current = setTimeout(() => {
            flushPendingUiState(targetScope);
        }, SESSION_AGENT_INPUT_SCROLL_SELECTION_PERSISTENCE_DEBOUNCE_MS);
    }, [flushPendingUiState]);

    const scheduleStructuredInputFlush = React.useCallback((target: Readonly<{
        scope: ServerAccountScope;
        sessionId: string;
    }>) => {
        pendingStructuredFlushTargetRef.current = target;
        if (pendingStructuredFlushTimeoutRef.current) {
            clearTimeout(pendingStructuredFlushTimeoutRef.current);
        }
        pendingStructuredFlushTimeoutRef.current = setTimeout(() => {
            flushPendingStructuredInput(target);
        }, SESSION_AGENT_INPUT_STRUCTURED_MENTION_PERSISTENCE_DEBOUNCE_MS);
    }, [flushPendingStructuredInput]);

    const setExpanded = React.useCallback<React.Dispatch<React.SetStateAction<boolean>>>((nextValue) => {
        const currentExpanded = readExpanded(scope, owner);
        const resolvedValue = typeof nextValue === 'function'
            ? nextValue(currentExpanded)
            : nextValue;
        const nextExpanded = resolvedValue === true;
        if (owner) {
            patchAgentInputLocalUiState(scope, owner, { expanded: nextExpanded });
        }
        setScopedStateWithExpanded(nextExpanded);
    }, [owner, scope, setScopedStateWithExpanded]);

    const onScrollYChange = React.useCallback((scrollY: number) => {
        if (!owner) return;
        patchAgentInputLocalUiState(scope, owner, {
            scrollY,
            textLength,
            fontScale,
        }, { flush: false });
        setScopedStateWithInputState();
        scheduleUiStateFlush(scope);
    }, [fontScale, owner, scheduleUiStateFlush, scope, setScopedStateWithInputState, textLength]);

    const onSelectionChangePersist = React.useCallback((selection: AgentInputTextSelection, nextTextLength: number) => {
        if (!owner) return;
        patchAgentInputLocalUiState(scope, owner, {
            selection,
            textLength: nextTextLength,
            fontScale,
        }, { flush: false });
        setScopedState((current) => {
            const base = isScopedComposerPersistenceStateCurrent(current, scope, owner, scopedStateReadOptions)
                ? current
                : readScopedComposerPersistenceState(scope, owner, scopedStateReadOptions);
            return {
                ...base,
                inputState: readInputState(scope, owner, {
                    textLength: nextTextLength,
                    fontScale,
                }),
            };
        });
        scheduleUiStateFlush(scope);
    }, [fontScale, owner, scheduleUiStateFlush, scope, scopedStateReadOptions]);

    const clearTransientInputState = React.useCallback(() => {
        if (!owner) return;

        flushPendingUiState(scope);
        const shouldKeepExpanded = readExpanded(scope, owner);
        clearAgentInputLocalUiState(scope, owner, { flush: false });
        if (shouldKeepExpanded) {
            patchAgentInputLocalUiState(scope, owner, { expanded: true }, { flush: false });
        }
        flushAgentInputLocalUiState(scope);

        const activeOwner = previousOwnerRef.current;
        if (
            activeOwner
            && areOwnersEqual(activeOwner.owner, owner)
            && areNullableScopesEqual(activeOwner.scope, scope)
        ) {
            setScopedState((current) => {
                const base = isScopedComposerPersistenceStateCurrent(current, scope, owner, scopedStateReadOptions)
                    ? current
                    : readScopedComposerPersistenceState(scope, owner, scopedStateReadOptions);
                return {
                    ...base,
                    expanded: shouldKeepExpanded,
                    inputState: readInputState(scope, owner, inputStateReadOptions),
                };
            });
        }
    }, [flushPendingUiState, inputStateReadOptions, owner, scope, scopedStateReadOptions]);

    const captureTransientInputState = React.useCallback(() => {
        if (!owner) return null;
        flushPendingUiState(scope);
        return readInputState(scope, owner, inputStateReadOptions);
    }, [flushPendingUiState, inputStateReadOptions, owner, scope]);

    const restoreTransientInputState = React.useCallback((state: AgentInputLocalUiStateV1 | null) => {
        if (!owner || !state) return;
        patchAgentInputLocalUiState(scope, owner, {
            ...(typeof state.expanded === 'boolean' ? { expanded: state.expanded } : {}),
            ...(typeof state.scrollY === 'number' ? { scrollY: state.scrollY } : {}),
            ...(state.selection ? { selection: state.selection } : {}),
            ...(typeof state.textLength === 'number' ? { textLength: state.textLength } : {}),
            ...(typeof state.fontScale === 'number' ? { fontScale: state.fontScale } : {}),
        });
        setScopedState((current) => {
            const base = isScopedComposerPersistenceStateCurrent(current, scope, owner, scopedStateReadOptions)
                ? current
                : readScopedComposerPersistenceState(scope, owner, scopedStateReadOptions);
            return {
                ...base,
                expanded: state.expanded === true,
                inputState: readInputState(scope, owner, inputStateReadOptions),
            };
        });
        setRestoreEpoch((epoch) => epoch + 1);
    }, [inputStateReadOptions, owner, scope, scopedStateReadOptions]);

    const onStructuredMentionsChange = React.useCallback((mentions: readonly ComposerStructuredInputMention[]) => {
        if (!scope || !owner || owner.kind !== 'session') return;
        const nextMentions = [...mentions];
        existingSessionDraftSemanticValues.write(scope, owner.sessionId, 'structuredInput.mentions', nextMentions);
        scheduleStructuredInputFlush({ scope, sessionId: owner.sessionId });
    }, [owner, scheduleStructuredInputFlush, scope]);

    const inputPersistence = React.useMemo(() => ({
        ...(typeof inputState?.scrollY === 'number' ? { initialScrollY: inputState.scrollY } : {}),
        ...(inputState?.selection ? { initialSelection: inputState.selection } : {}),
        restoreToken: buildRestoreToken(owner, scope, restoreEpoch, restoreBasisAdopted),
        onScrollYChange,
        onSelectionChangePersist,
    }), [inputState, onScrollYChange, onSelectionChangePersist, owner, restoreBasisAdopted, restoreEpoch, scope]);

    const structuredInputPersistence = React.useMemo(() => ({
        mentions: structuredInputMentions,
        onMentionsChange: onStructuredMentionsChange,
    }), [onStructuredMentionsChange, structuredInputMentions]);

    return React.useMemo(() => ({
        expanded,
        setExpanded,
        clearTransientInputState,
        captureTransientInputState,
        restoreTransientInputState,
        inputPersistence,
        structuredInputPersistence,
    }), [
        captureTransientInputState,
        clearTransientInputState,
        expanded,
        inputPersistence,
        restoreTransientInputState,
        setExpanded,
        structuredInputPersistence,
    ]);
}
