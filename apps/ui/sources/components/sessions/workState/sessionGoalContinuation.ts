import { resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import type { SessionTriggerAddRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

/**
 * The Goal control's continuation owner (FIN 04 §5.5, 08 §3.4): one per session, decided by the
 * opened runtime — the agent's own goal mode where it exposes native goal controls, otherwise
 * Happier's Keep going, the built-in attached as this session's When-a-turn-ends trigger.
 */

export const KEEP_GOING_WORKFLOW_SLUG = 'keep-going';
export const KEEP_GOING_WORKFLOW_REF = `builtin:${KEEP_GOING_WORKFLOW_SLUG}` as const;

export type KeepGoingInputs = Readonly<{
    maxRounds: number;
    strikes: number;
    secondOpinion: boolean;
}>;

/** What the built-in declares as its prefilled values (08 §3.1): its definition is the one authority. */
function readKeepGoingDefaults(): KeepGoingInputs {
    const inputs = resolveBuiltinWorkflowDefinitionV1(KEEP_GOING_WORKFLOW_SLUG)?.definition.inputs ?? [];
    const declared = (name: string): unknown => inputs.find((input) => input.name === name)?.default;
    const maxRounds = declared('maxRounds');
    const strikes = declared('strikes');
    const secondOpinion = declared('secondOpinion');
    if (typeof maxRounds !== 'number' || typeof strikes !== 'number' || typeof secondOpinion !== 'boolean') {
        throw new Error('builtin:keep-going no longer declares its prefilled inputs');
    }
    return { maxRounds, strikes, secondOpinion };
}

export const KEEP_GOING_DEFAULT_INPUTS: KeepGoingInputs = readKeepGoingDefaults();

/** The session's Keep going trigger as `session.trigger.list` returns it. */
export type KeepGoingAttachment = Readonly<{
    triggerId: string;
    /** The trigger set's revision, the `expectedRevision` of an update. */
    revision: number;
    enabled: boolean;
    inputs: KeepGoingInputs;
}>;

function readNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function readKeepGoingAttachment(sets: readonly WorkflowTriggerSetV1[]): KeepGoingAttachment | null {
    for (const set of sets) {
        if (set.target?.kind !== 'workflow' || set.target.ref !== KEEP_GOING_WORKFLOW_REF) continue;
        const trigger = set.triggers[0];
        if (!trigger) continue;
        const stored = set.context?.inputs ?? {};
        return {
            triggerId: trigger.id,
            revision: set.revision,
            enabled: set.enabled && trigger.enabled,
            inputs: {
                maxRounds: readNumber(stored.maxRounds, KEEP_GOING_DEFAULT_INPUTS.maxRounds),
                strikes: readNumber(stored.strikes, KEEP_GOING_DEFAULT_INPUTS.strikes),
                secondOpinion: typeof stored.secondOpinion === 'boolean'
                    ? stored.secondOpinion
                    : KEEP_GOING_DEFAULT_INPUTS.secondOpinion,
            },
        };
    }
    return null;
}

/** 08 §3.4's attach: the built-in on every completed turn of this session, with the limits as left. */
export function buildKeepGoingTriggerAddRequest(sessionId: string, inputs: KeepGoingInputs): SessionTriggerAddRequestV1 {
    return {
        sessionId,
        target: { kind: 'workflow', ref: KEEP_GOING_WORKFLOW_REF },
        inputs: { maxRounds: inputs.maxRounds, strikes: inputs.strikes, secondOpinion: inputs.secondOpinion },
        trigger: {
            kind: 'sessionLifecycle',
            enabled: true,
            sourceSessionId: sessionId,
            events: ['parentTurnCompleted'],
            policy: { kind: 'everyMatch' },
        },
    };
}

export function areKeepGoingInputsValid(inputs: KeepGoingInputs): boolean {
    return Number.isSafeInteger(inputs.maxRounds) && inputs.maxRounds > 0
        && Number.isSafeInteger(inputs.strikes) && inputs.strikes > 0;
}

/**
 * Which owner the Goal control shows (X16). With native goals a Keep going trigger that is still
 * attached means the open-time hand-over did not complete: neither owner runs, and the control shows
 * the existing typed failure instead of either row.
 */
export type SessionGoalContinuationOwner =
    | Readonly<{ kind: 'native' }>
    | Readonly<{ kind: 'keepGoing' }>
    | Readonly<{ kind: 'conflict' }>;

export function resolveSessionGoalContinuationOwner(input: Readonly<{
    nativeGoalOwner: boolean;
    attachment: KeepGoingAttachment | null;
}>): SessionGoalContinuationOwner {
    if (!input.nativeGoalOwner) return { kind: 'keepGoing' };
    return input.attachment ? { kind: 'conflict' } : { kind: 'native' };
}

/** What the composer's Goal control knows about its session's continuation (passed by the session host). */
export type SessionGoalContinuationContext = Readonly<{
    sessionId: string;
    /** The machine whose daemon owns this session's triggers; null lets the relay choose. */
    machineId: string | null;
    /** The opened runtime exposes native goal controls (S0-D's per-open signal). */
    nativeGoalOwner: boolean;
    agentLabel: string;
}>;
