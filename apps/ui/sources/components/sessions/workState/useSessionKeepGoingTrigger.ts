import * as React from 'react';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { getStorage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { createWorkflowTriggerChangeSelector, createWorkflowTriggerSetSelector, EMPTY_WORKFLOW_TRIGGER_CHANGE_SIGNAL } from '@/sync/store/domains/automations';

import { resolveWorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import {
    addWorkflowTrigger,
    listWorkflowTriggerSets,
    removeWorkflowTrigger,
    updateWorkflowTrigger,
} from '@/sync/domains/workflows/workflowTriggerActions';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';

import {
    KEEP_GOING_DEFAULT_INPUTS,
    areKeepGoingInputsValid,
    buildKeepGoingTriggerAddRequest,
    readKeepGoingAttachment,
    type KeepGoingAttachment,
    type KeepGoingInputs,
} from './sessionGoalContinuation';

/** Where the Goal control acts: the session, and the machine whose daemon owns its triggers. */
export type SessionGoalContinuationTarget = Readonly<{
    sessionId: string;
    machineId: string | null;
}>;

export type SessionKeepGoingTrigger = Readonly<{
    phase: 'idle' | 'loading' | 'loaded' | 'failed';
    attachment: KeepGoingAttachment | null;
    /** The fields as the person left them: the attachment's inputs, or the built-in's prefilled values. */
    inputs: Readonly<{ maxRounds: number | undefined; strikes: number | undefined; secondOpinion: boolean }>;
    /** The switch value: a pending change shows what was asked until the owner answers. */
    on: boolean;
    busy: boolean;
    /** The owner's typed refusal of the last write, worded by the workflow problem owner. */
    error: string | null;
    setOn: (on: boolean) => void;
    setInputs: (patch: Partial<Readonly<{ maxRounds: number | undefined; strikes: number | undefined; secondOpinion: boolean }>>) => void;
}>;

const EMPTY_TRIGGER_SETS: readonly WorkflowTriggerSetV1[] = [];
const selectNoSets = () => EMPTY_TRIGGER_SETS;
const selectNoChanges = () => EMPTY_WORKFLOW_TRIGGER_CHANGE_SIGNAL;

/**
 * The open Goal control consumes the canonical Automation trigger projection and its change signal.
 * Session-trigger Actions own reads and writes; only unsaved inputs and pending writes stay local.
 */
export function useSessionKeepGoingTrigger(params: Readonly<{
    target: SessionGoalContinuationTarget | null;
    enabled: boolean;
}>): SessionKeepGoingTrigger {
    const sessionId = params.target?.sessionId ?? null;
    const machineId = params.target?.machineId ?? null;
    const accountLifetime = useActiveServerAccountScopeLifetime();
    const selector = React.useMemo(() => createWorkflowTriggerSetSelector(`session:${sessionId}`), [sessionId]);
    const sets = getStorage()(params.enabled ? selector : selectNoSets);
    const changeSelector = React.useMemo(() => createWorkflowTriggerChangeSelector(sessionId), [sessionId]);
    const changeSignal = getStorage()(params.enabled ? changeSelector : selectNoChanges);
    const attachment = React.useMemo(() => readKeepGoingAttachment(sets, sessionId), [sets, sessionId]);
    const readAttachment = React.useCallback(() => readKeepGoingAttachment(selector(getStorage().getState()), sessionId), [selector, sessionId]);
    const [phase, setPhase] = React.useState<SessionKeepGoingTrigger['phase']>('idle');
    const [draftInputs, setDraftInputs] = React.useState<Partial<SessionKeepGoingTrigger['inputs']> | null>(null);
    const draftInputsRef = React.useRef<Partial<SessionKeepGoingTrigger['inputs']> | null>(null);
    const replaceDraft = React.useCallback((draft: Partial<SessionKeepGoingTrigger['inputs']> | null) => {
        draftInputsRef.current = draft;
        setDraftInputs(draft);
    }, []);
    const inputs = React.useMemo(() => ({ ...(attachment?.inputs ?? KEEP_GOING_DEFAULT_INPUTS), ...draftInputs }), [attachment?.inputs, draftInputs]);
    const [pendingOn, setPendingOn] = React.useState<boolean | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    // Field writes are serialized: one in flight, and only the newest waiting value follows it.
    const inputWriteRef = React.useRef({ inFlight: false, queued: false });

    const options = React.useMemo(() => ({
        accountLifetime,
        context: machineId ? { externalActionTarget: { kind: 'machine' as const, machineId } } : {},
    }), [accountLifetime, machineId]);

    React.useEffect(() => {
        replaceDraft(null);
    }, [accountLifetime, params.enabled, replaceDraft, sessionId]);

    React.useEffect(() => {
        if (!params.enabled || !sessionId || !accountLifetime) return;
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        setPhase(current => current === 'loaded' ? current : 'loading');
        listWorkflowTriggerSets({ lifetimeSession: { sessionId } }, { ...options, signal: controller.signal })
            .then(() => {
                if (!controller.signal.aborted) setPhase('loaded');
            })
            .catch(() => {
                if (!controller.signal.aborted) setPhase('failed');
            });
        return () => { controller.abort(); retirement.dispose(); };
    }, [accountLifetime, changeSignal, options, params.enabled, sessionId]);

    const fail = React.useCallback((cause: unknown) => {
        setError(resolveWorkflowProblemPresentation(cause).message);
    }, []);

    const acknowledgeInputs = React.useCallback((written: KeepGoingInputs) => {
        const draft = draftInputsRef.current;
        if (!draft) return;
        const remaining = { ...draft };
        for (const key of Object.keys(draft) as (keyof KeepGoingInputs)[]) {
            if (Object.is(draft[key], written[key])) delete remaining[key];
        }
        replaceDraft(Object.keys(remaining).length ? remaining : null);
    }, [replaceDraft]);

    const setOn = React.useCallback((on: boolean) => {
        if (!sessionId || busy) return;
        const current = readAttachment();
        const complete = {
            maxRounds: inputs.maxRounds ?? Number.NaN,
            strikes: inputs.strikes ?? Number.NaN,
            secondOpinion: inputs.secondOpinion,
        };
        if (on && !areKeepGoingInputsValid(complete)) return;
        setError(null);
        setPendingOn(on);
        setBusy(true);
        const write = (async () => {
            if (!on) return current ? removeWorkflowTrigger({ automationId: current.automationId, triggerId: current.triggerId }, options) : undefined;
            if (current) return updateWorkflowTrigger({
                automationId: current.automationId,
                triggerId: current.triggerId,
                expectedRevision: current.revision,
                patch: { enabled: true, inputs: complete },
            }, options);
            const serverId = resolvePortableServerIdentityForRoutingId(accountLifetime?.scope.serverId);
            if (serverId === null) throw new WorkflowActionError({ message: 'source_unavailable', rawCode: 'source_unavailable' });
            return addWorkflowTrigger(buildKeepGoingTriggerAddRequest({ sessionId, serverId }, complete), options);
        })();
        void write
            .then(() => {
                if (on) acknowledgeInputs(complete);
            })
            .catch(fail)
            .finally(() => {
                setPendingOn(null);
                setBusy(false);
            });
    }, [accountLifetime, acknowledgeInputs, busy, fail, inputs, options, readAttachment, sessionId]);

    const writeInputs = React.useCallback(() => {
        const queue = inputWriteRef.current;
        if (queue.inFlight) {
            queue.queued = true;
            return;
        }
        const current = readAttachment();
        const draft = draftInputsRef.current;
        if (!sessionId || !current?.enabled || !draft) return;
        const inputs = { ...current.inputs, ...draft };
        const next = {
            maxRounds: inputs.maxRounds ?? Number.NaN,
            strikes: inputs.strikes ?? Number.NaN,
            secondOpinion: inputs.secondOpinion,
        };
        // Incomplete fields stay visible as drafts until the person repairs them.
        if (!areKeepGoingInputsValid(next)) return;
        queue.inFlight = true;
        void updateWorkflowTrigger({
            automationId: current.automationId,
            triggerId: current.triggerId,
            expectedRevision: current.revision,
            patch: { inputs: next },
        }, options)
            .then(() => acknowledgeInputs(next))
            .catch(fail)
            .finally(() => {
                queue.inFlight = false;
                if (queue.queued) {
                    queue.queued = false;
                    writeInputs();
                }
            });
    }, [acknowledgeInputs, fail, options, readAttachment, sessionId]);

    const setInputs = React.useCallback<SessionKeepGoingTrigger['setInputs']>((patch) => {
        replaceDraft({ ...draftInputsRef.current, ...patch });
        writeInputs();
    }, [replaceDraft, writeInputs]);

    return {
        phase,
        attachment,
        inputs,
        on: pendingOn ?? attachment?.enabled === true,
        busy,
        error,
        setOn,
        setInputs,
    };
}
