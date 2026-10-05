import * as React from 'react';
import type { SessionInitialTriggerV1 } from '@happier-dev/protocol';

import type { ExactTurnAutomationPrefill } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import {
    replaceExactTurnAutomationRowsWithCurrentTurns,
    sanitizeNewSessionAutomationDraft,
    type NewSessionAutomationDraft,
} from '@/sync/domains/automations/automationDraft';

import { useNewSessionPromptStore, type NewSessionPromptStore } from './newSessionPromptStore';

type PersistedAuthoringDraftLike = Readonly<{
    displayText?: string | null;
    automation?: unknown;
    initialTriggers?: SessionInitialTriggerV1[];
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    displayText?: string | null;
    automation?: unknown;
    initialTriggers?: SessionInitialTriggerV1[];
}> | null | undefined;

const EMPTY_INITIAL_TRIGGERS: SessionInitialTriggerV1[] = [];

export function useNewSessionPromptAutomationState(params: Readonly<{
    prompt: string | undefined;
    dataId: string | undefined;
    automationParam: string | undefined;
    persistedDraftEntryIntent: string | null | undefined;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    initialTriggersDraftKey?: string;
    /**
     * Explicit "Use current turn" adoption for the mounted exact-turn binding.
     * Request identity changes only when the user adopts again; the request is
     * applied through this incumbent automation-draft owner and never silently
     * re-fires on later live-turn advances.
     */
    exactTurnRetargetRequest?: ExactTurnAutomationPrefill | null;
    /** Live current parent-turn reader, injected by the owning screen model. */
    readExactTurn?: (sourceSessionId: string) => ExactTurnAutomationPrefill | null;
    /**
     * Opens the shared Automation editor with this screen's composed draft.
     * Absent while Automations are unavailable, in which case a legacy draft
     * is kept as-is until it can move.
     */
    handOffLegacyAutomation?: ((automation: NewSessionAutomationDraft) => void) | null;
}>): Readonly<{
    promptStore: NewSessionPromptStore;
    setSessionPrompt: React.Dispatch<React.SetStateAction<string>>;
    automationDraft: NewSessionAutomationDraft;
    setAutomationDraft: React.Dispatch<React.SetStateAction<NewSessionAutomationDraft>>;
    automationRequestedByRoute: boolean;
    initialTriggers: SessionInitialTriggerV1[];
    setInitialTriggers: React.Dispatch<React.SetStateAction<SessionInitialTriggerV1[]>>;
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

    const hydratedInitialTriggers = params.hydratedTempAuthoringDraft?.initialTriggers
        ?? params.hydratedPersistedAuthoringDraft?.initialTriggers ?? EMPTY_INITIAL_TRIGGERS;
    const [initialTriggers, setInitialTriggersState] = React.useState(() => hydratedInitialTriggers);
    const hasEditedInitialTriggersRef = React.useRef(false);
    const triggerHydrationKey = `${params.initialTriggersDraftKey ?? ''}\u0000${params.dataId ?? ''}`;
    const lastTriggerHydrationKeyRef = React.useRef(triggerHydrationKey);
    if (lastTriggerHydrationKeyRef.current !== triggerHydrationKey) {
        lastTriggerHydrationKeyRef.current = triggerHydrationKey;
        hasEditedInitialTriggersRef.current = false;
    }
    const setInitialTriggers = React.useCallback<React.Dispatch<React.SetStateAction<SessionInitialTriggerV1[]>>>((next) => {
        hasEditedInitialTriggersRef.current = true;
        setInitialTriggersState(next);
    }, []);
    React.useEffect(() => {
        if (!hasEditedInitialTriggersRef.current) setInitialTriggersState(hydratedInitialTriggers);
    }, [hydratedInitialTriggers, triggerHydrationKey]);

    const automationRequestedByRoute = React.useMemo(() => {
        if (typeof params.automationParam !== 'string') return false;
        return ['1', 'true', 'yes', 'on'].includes(params.automationParam.trim().toLowerCase());
    }, [params.automationParam]);

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

    // New Session does not write Automations. A draft saved before creation
    // moved to the shared Automation editor can still hydrate with an enabled
    // inline Automation, and an old `/new?automation=1` link still asks for
    // one. Either is handed, once, to that editor through the chip's handoff,
    // and this draft continues as an ordinary New Session draft.
    const handOffLegacyAutomationRef = React.useRef(params.handOffLegacyAutomation);
    handOffLegacyAutomationRef.current = params.handOffLegacyAutomation;
    const legacyAutomationHandedOffRef = React.useRef(false);
    const legacyAutomationEntry = params.handOffLegacyAutomation != null
        && (automationDraft.enabled || automationRequestedByRoute);
    React.useEffect(() => {
        if (!legacyAutomationEntry || legacyAutomationHandedOffRef.current) return;
        legacyAutomationHandedOffRef.current = true;
        handOffLegacyAutomationRef.current?.({ ...automationDraft, enabled: true });
        setAutomationDraft((current) => ({ ...current, enabled: false }));
    }, [automationDraft, legacyAutomationEntry, setAutomationDraft]);

    return {
        promptStore,
        setSessionPrompt,
        automationDraft,
        setAutomationDraft,
        automationRequestedByRoute,
        initialTriggers,
        setInitialTriggers,
    };
}
