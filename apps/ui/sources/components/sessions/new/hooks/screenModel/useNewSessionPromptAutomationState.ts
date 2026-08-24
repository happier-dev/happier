import * as React from 'react';

import {
    DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
    sanitizeNewSessionAutomationDraft,
    type NewSessionAutomationDraft,
} from '@/sync/domains/automations/automationDraft';

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
    automationEnabledParam: string | undefined;
    automationNameParam: string | undefined;
    automationDescriptionParam: string | undefined;
    automationScheduleKindParam: string | undefined;
    automationEveryMinutesParam: string | undefined;
    automationCronExprParam: string | undefined;
    automationTimezoneParam: string | undefined;
    automationEditIdParam: string | undefined;
    automationFeatureEnabled: boolean;
    persistedDraftEntryIntent: string | null | undefined;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
}>): Readonly<{
    promptStore: NewSessionPromptStore;
    setSessionPrompt: React.Dispatch<React.SetStateAction<string>>;
    hasUserEditedSessionPrompt: () => boolean;
    automationDraft: NewSessionAutomationDraft;
    setAutomationDraft: React.Dispatch<React.SetStateAction<NewSessionAutomationDraft>>;
    automationEditId: string | null;
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
    const hasUserEditedSessionPrompt = React.useCallback(
        () => hasUserEditedSessionPromptRef.current,
        [],
    );
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

    const hasExplicitAutomationSeedParams = React.useMemo(() => {
        return typeof params.automationEnabledParam === 'string'
            || typeof params.automationNameParam === 'string'
            || typeof params.automationDescriptionParam === 'string'
            || typeof params.automationScheduleKindParam === 'string'
            || typeof params.automationEveryMinutesParam === 'string'
            || typeof params.automationCronExprParam === 'string'
            || typeof params.automationTimezoneParam === 'string';
    }, [
        params.automationCronExprParam,
        params.automationDescriptionParam,
        params.automationEnabledParam,
        params.automationEveryMinutesParam,
        params.automationNameParam,
        params.automationScheduleKindParam,
        params.automationTimezoneParam,
    ]);

    const isForcedAutomationRoute = React.useMemo(() => {
        if (!automationRequestedByRoute) return false;
        if (hasExplicitAutomationSeedParams) return false;
        if (typeof params.dataId === 'string' && params.dataId.trim().length > 0) return false;
        if (typeof params.automationEditIdParam === 'string' && params.automationEditIdParam.trim().length > 0) return false;
        return true;
    }, [
        params.automationEditIdParam,
        automationRequestedByRoute,
        params.dataId,
        hasExplicitAutomationSeedParams,
    ]);

    const shouldIgnorePersistedAutomationDraft = React.useMemo(() => {
        if (automationRequestedByRoute) return false;
        if (hasExplicitAutomationSeedParams) return false;
        if (typeof params.dataId === 'string' && params.dataId.trim().length > 0) return false;
        if (typeof params.automationEditIdParam === 'string' && params.automationEditIdParam.trim().length > 0) return false;
        return params.persistedDraftEntryIntent === 'automation';
    }, [
        params.automationEditIdParam,
        automationRequestedByRoute,
        params.dataId,
        hasExplicitAutomationSeedParams,
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

    const automationEditId = React.useMemo(() => {
        if (typeof params.automationEditIdParam !== 'string') {
            return null;
        }
        const trimmed = params.automationEditIdParam.trim();
        return trimmed.length > 0 ? trimmed : null;
    }, [params.automationEditIdParam]);

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
            enabled: true,
        });
    }, [params.automationFeatureEnabled, isForcedAutomationRoute]);

    React.useEffect(() => {
        if (!params.automationFeatureEnabled) return;
        if (!hasExplicitAutomationSeedParams) return;
        if (hasUserEditedAutomationDraftRef.current) return;

        setAutomationDraftState((prev) => {
            const parsed = sanitizeNewSessionAutomationDraft({
                enabled: typeof params.automationEnabledParam === 'string'
                    ? ['1', 'true', 'yes', 'on'].includes(params.automationEnabledParam.trim().toLowerCase())
                    : prev.enabled,
                name: typeof params.automationNameParam === 'string' ? params.automationNameParam : prev.name,
                description: typeof params.automationDescriptionParam === 'string' ? params.automationDescriptionParam : prev.description,
                scheduleKind: typeof params.automationScheduleKindParam === 'string' ? params.automationScheduleKindParam : prev.scheduleKind,
                everyMinutes: typeof params.automationEveryMinutesParam === 'string'
                    ? Number.parseInt(params.automationEveryMinutesParam, 10)
                    : prev.everyMinutes,
                cronExpr: typeof params.automationCronExprParam === 'string' ? params.automationCronExprParam : prev.cronExpr,
                timezone: typeof params.automationTimezoneParam === 'string' ? params.automationTimezoneParam : prev.timezone,
            });

            return { ...prev, ...parsed };
        });
    }, [
        params.automationCronExprParam,
        params.automationDescriptionParam,
        params.automationEnabledParam,
        params.automationEveryMinutesParam,
        params.automationFeatureEnabled,
        hasExplicitAutomationSeedParams,
        params.automationNameParam,
        params.automationScheduleKindParam,
        params.automationTimezoneParam,
    ]);

    return {
        promptStore,
        setSessionPrompt,
        hasUserEditedSessionPrompt,
        automationDraft,
        setAutomationDraft,
        automationEditId,
        automationRequestedByRoute,
    };
}
