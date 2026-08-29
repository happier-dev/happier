import * as React from 'react';

import type { ExactTurnAutomationPrefill } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import {
    DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
    replaceExactTurnAutomationRowsWithCurrentTurns,
    sanitizeNewSessionAutomationDraft,
    type NewSessionAutomationDraft,
} from '@/sync/domains/automations/automationDraft';
import { createAutomationEditorAutomationId } from '@/sync/domains/automations/automationEditorDraft';

import { useNewSessionPromptStore, type NewSessionPromptStore } from './newSessionPromptStore';

type PersistedAuthoringDraftLike = Readonly<{
    displayText?: string | null;
    automation?: unknown;
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    displayText?: string | null;
    automation?: unknown;
}> | null | undefined;

export function useNewSessionPromptAutomationState(params: Readonly<{
    prompt: string | undefined;
    dataId: string | undefined;
    automationParam: string | undefined;
    automationFeatureEnabled: boolean;
    persistedDraftEntryIntent: string | null | undefined;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    /**
     * Explicit "Use current turn" adoption for the mounted exact-turn binding.
     * Request identity changes only when the user adopts again; the request is
     * applied through this incumbent automation-draft owner and never silently
     * re-fires on later live-turn advances.
     */
    exactTurnRetargetRequest?: ExactTurnAutomationPrefill | null;
    /** Live current parent-turn reader, injected by the owning screen model. */
    readExactTurn?: (sourceSessionId: string) => ExactTurnAutomationPrefill | null;
}>): Readonly<{
    promptStore: NewSessionPromptStore;
    setSessionPrompt: React.Dispatch<React.SetStateAction<string>>;
    automationDraft: NewSessionAutomationDraft;
    setAutomationDraft: React.Dispatch<React.SetStateAction<NewSessionAutomationDraft>>;
    automationRequestedByRoute: boolean;
}> {
    const hydratedSessionPrompt = React.useMemo(() => {
        return params.hydratedTempAuthoringDraft?.displayText || params.prompt || params.hydratedPersistedAuthoringDraft?.displayText || '';
    }, [params.hydratedPersistedAuthoringDraft?.displayText, params.hydratedTempAuthoringDraft?.displayText, params.prompt]);
    // RENDER CHURN: the live text is owned outside the render graph. The composer input
    // subscribes to this store and re-renders per keystroke; the screen model does not.
    const promptStore = useNewSessionPromptStore(() => hydratedSessionPrompt);
    // Once the user edits the prompt, their live text is the single source of truth for this
    // screen instance. Later hydration echoes (debounced auto-persist read-backs, focus-driven
    // draft reloads, or another mounted new-session screen writing the same scope key) must not
    // clobber live typing — re-applying a stale snapshot resets the native input's text,
    // selection, and scroll mid-keystroke. Mirrors hasUserEditedAutomationDraftRef below.
    const hasUserEditedSessionPromptRef = React.useRef(false);
    const setSessionPrompt = React.useCallback<React.Dispatch<React.SetStateAction<string>>>((next) => {
        hasUserEditedSessionPromptRef.current = true;
        promptStore.setPrompt(next);
    }, [promptStore]);
    // Explicit re-entry (a fresh temp-draft handoff or a deep link carrying a prompt) is a
    // deliberate hydration request, not a stale echo — let it apply over live text again.
    const hydrationRequestKey = `${params.dataId ?? ''}\u0000${params.prompt ?? ''}`;
    const lastHydrationRequestKeyRef = React.useRef(hydrationRequestKey);
    if (lastHydrationRequestKeyRef.current !== hydrationRequestKey) {
        lastHydrationRequestKeyRef.current = hydrationRequestKey;
        hasUserEditedSessionPromptRef.current = false;
    }

    const automationRequestedByRoute = React.useMemo(() => {
        if (typeof params.automationParam !== 'string') return false;
        return ['1', 'true', 'yes', 'on'].includes(params.automationParam.trim().toLowerCase());
    }, [params.automationParam]);

    const isForcedAutomationRoute = React.useMemo(() => {
        if (!automationRequestedByRoute) return false;
        if (typeof params.dataId === 'string' && params.dataId.trim().length > 0) return false;
        return true;
    }, [
        automationRequestedByRoute,
        params.dataId,
    ]);

    const shouldIgnorePersistedAutomationDraft = React.useMemo(() => {
        if (automationRequestedByRoute) return false;
        if (typeof params.dataId === 'string' && params.dataId.trim().length > 0) return false;
        return params.persistedDraftEntryIntent === 'automation';
    }, [
        automationRequestedByRoute,
        params.dataId,
        params.persistedDraftEntryIntent,
    ]);

    const initialAutomationDraft = React.useMemo(() => {
        return sanitizeNewSessionAutomationDraft(
            params.hydratedTempAuthoringDraft?.automation
            ?? (shouldIgnorePersistedAutomationDraft ? null : params.hydratedPersistedAuthoringDraft?.automation),
        );
    }, [
        params.hydratedPersistedAuthoringDraft?.automation,
        params.hydratedTempAuthoringDraft?.automation,
        shouldIgnorePersistedAutomationDraft,
    ]);
    const [automationDraft, setAutomationDraftState] = React.useState<NewSessionAutomationDraft>(() => initialAutomationDraft);
    const hasUserEditedAutomationDraftRef = React.useRef(false);
    const setAutomationDraft = React.useCallback<React.Dispatch<React.SetStateAction<NewSessionAutomationDraft>>>((next) => {
        hasUserEditedAutomationDraftRef.current = true;
        setAutomationDraftState(next);
    }, []);

    React.useEffect(() => {
        if (hasUserEditedAutomationDraftRef.current) return;
        setAutomationDraftState(initialAutomationDraft);
    }, [params.hydratedPersistedAuthoringDraft, params.hydratedTempAuthoringDraft, initialAutomationDraft]);

    React.useEffect(() => {
        if (hasUserEditedSessionPromptRef.current) return;
        promptStore.setPrompt(hydratedSessionPrompt);
    }, [hydratedSessionPrompt, promptStore]);

    React.useEffect(() => {
        if (!params.automationFeatureEnabled) return;
        if (!isForcedAutomationRoute) return;
        if (hasUserEditedAutomationDraftRef.current) return;

        setAutomationDraftState({
            ...DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
            pendingAutomationId: createAutomationEditorAutomationId(),
            enabled: true,
        });
    }, [params.automationFeatureEnabled, isForcedAutomationRoute]);

    // Explicit "Use current turn": advance only the exact-turn rows through
    // this incumbent automation-draft owner; every other field, row, and edit
    // survives. Applying through setAutomationDraft marks the draft
    // user-authored, so later hydration echoes can never silently revert the
    // adopted turn back to the stale prefill. The reader is held in a ref so a
    // changing live turn alone can never re-fire this effect.
    const readExactTurnRef = React.useRef(params.readExactTurn);
    readExactTurnRef.current = params.readExactTurn;
    React.useEffect(() => {
        if (!params.exactTurnRetargetRequest) return;
        setAutomationDraft((current) => {
            const replacement = replaceExactTurnAutomationRowsWithCurrentTurns({
                automation: current,
                readExactTurn: (sourceSessionId) => readExactTurnRef.current?.(sourceSessionId) ?? null,
            });
            return replacement.changed ? replacement.automation : current;
        });
    }, [params.exactTurnRetargetRequest, setAutomationDraft]);

    return {
        promptStore,
        setSessionPrompt,
        automationDraft,
        setAutomationDraft,
        automationRequestedByRoute,
    };
}
