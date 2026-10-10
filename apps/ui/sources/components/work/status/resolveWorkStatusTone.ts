import { isInProgressAgentActivityStatus, isTerminalAgentActivityStatus, type AgentActivityStatusV1 } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityStatusV1';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { readSessionAwarenessWorkStatusV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { SessionAwarenessPresentationFactsV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { WorkflowInvocationLifecycleV1, WorkflowRunStateV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkerUpdateV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import type { ActionOperationSnapshotV1, ActionOperationStateV1 } from '@happier-dev/protocol/actions/operations/v1';

import {
    HAPPIER_WORK_STATUS_SEMANTIC_TONE,
    type HappierWorkStatusBucket,
    type HappierWorkStatusPresentation,
    type HappierWorkStatusTone,
} from '@happier-dev/plugin-ui/presentation';

import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { t } from '@/text';
import { isMachineRetainedWakeEligibleV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';

/**
 * The shared status presentation is owned by `@happier-dev/plugin-ui/presentation` (plugin authors
 * draw with the same one); these names are this resolver's vocabulary for it, not a second definition.
 * This module owns only the mapping from Happier's own owner facts onto it.
 */
export type WorkStatusBucket = HappierWorkStatusBucket;
export type WorkStatusTone = HappierWorkStatusTone;
export type WorkStatusPresentation = HappierWorkStatusPresentation;

/** The `StatusPill` variant for a tone, where a surface states its word as a badge (ring and tint: `workStatusTreatment`). */
export const WORK_STATUS_PILL_VARIANT = HAPPIER_WORK_STATUS_SEMANTIC_TONE satisfies Record<WorkStatusTone, StatusPillVariant>;

// The approved FIN hold/stop words are presentation inputs until its protocol seam lands.
export type WorkStatusRunState = WorkflowRunStateV1 | 'waiting_for_review' | 'cancel_requested';
export type WorkStatusStepLifecycle = WorkflowInvocationLifecycleV1 | 'waiting_for_review';
export type WorkStatusWorkflowOutcome = 'exhausted' | 'declared' | 'completed_with_failures'
    | 'source_unavailable' | 'target_unavailable';

type WorkflowFacts = Readonly<{
    word: string;
    outcome?: WorkStatusWorkflowOutcome;
    /** Membership supplied by the workflow attention owner, never inferred here. */
    inAttentionWindow?: boolean;
    /** Absent means unknown, not offline. */
    machineReachable?: boolean;
}>;

export type WorkStatusInput =
    | Readonly<{ kind: 'action_operation'; facts: Readonly<{
        state: ActionOperationStateV1;
        observation: 'available' | 'reconnecting' | 'unavailable';
        setupReview?: ActionOperationSnapshotV1['setupReview'];
        word: string;
    }> }>
    | Readonly<{ kind: 'worker_update'; facts: Readonly<{ update: WorkerUpdateV1; word: string }> }>
    | Readonly<{ kind: 'workflow_run'; facts: WorkflowFacts & Readonly<{ state: WorkStatusRunState }> }>
    | Readonly<{ kind: 'workflow_step'; facts: WorkflowFacts & Readonly<{ lifecycle: WorkStatusStepLifecycle }> }>
    | Readonly<{ kind: 'session'; facts: Readonly<{
        word: string;
        awareness: SessionAwarenessPresentationFactsV1;
        /** Settlement is supplied by the Session owner, not inferred from a word. */
        settled?: boolean;
    }> }>
    | Readonly<{ kind: 'machine'; facts: Readonly<{
        word: string; online: boolean; needsYouCount: number; runningSessionCount: number;
        machineId?: string;
        revokedAt?: number | null;
        /** Protected, Home-qualified inventory row; connectivity alone never establishes sleep. */
        managedMachine?: ManagedMachineV1 | null;
    }> }>
    | Readonly<{ kind: 'workflow'; facts: Readonly<{
        word: string; needsYouCount: number; hasActiveRun: boolean;
    }> }>
    /** An execution run, sub-agent or teammate, in the agent-activity vocabulary. */
    | Readonly<{ kind: 'agent_activity'; facts: Readonly<{ status: AgentActivityStatusV1; word: string }> }>;

type StatusShape = Readonly<{ bucket: WorkStatusBucket; tone: WorkStatusTone }>;

const RUN_STATUS: Readonly<Record<WorkStatusRunState, StatusShape>> = {
    queued: { bucket: 'working', tone: 'neutral' },
    claimed: { bucket: 'working', tone: 'neutral' },
    running: { bucket: 'working', tone: 'neutral' },
    pause_requested: { bucket: 'working', tone: 'neutral' },
    cancel_requested: { bucket: 'working', tone: 'neutral' },
    waiting_for_review: { bucket: 'working', tone: 'attention' },
    paused: { bucket: 'idle', tone: 'neutral' },
    interrupted: { bucket: 'idle', tone: 'attention' },
    succeeded: { bucket: 'finished', tone: 'neutral' },
    cancelled: { bucket: 'finished', tone: 'neutral' },
    skipped: { bucket: 'finished', tone: 'neutral' },
    failed: { bucket: 'finished', tone: 'danger' },
    dispatch_failed: { bucket: 'finished', tone: 'danger' },
    expired: { bucket: 'finished', tone: 'attention' },
    missed: { bucket: 'finished', tone: 'attention' },
    outcome_uncertain: { bucket: 'finished', tone: 'attention' },
};

const STEP_STATUS: Readonly<Record<WorkStatusStepLifecycle, StatusShape>> = {
    pending: { bucket: 'working', tone: 'neutral' },
    waiting_for_capacity: { bucket: 'working', tone: 'neutral' },
    admitting: { bucket: 'working', tone: 'neutral' },
    running: { bucket: 'working', tone: 'neutral' },
    cancel_requested: { bucket: 'working', tone: 'neutral' },
    waiting_for_approval: { bucket: 'working', tone: 'attention' },
    waiting_for_review: { bucket: 'working', tone: 'attention' },
    needs_attention: { bucket: 'working', tone: 'attention' },
    outcome_uncertain: { bucket: 'working', tone: 'attention' },
    completed: { bucket: 'finished', tone: 'neutral' },
    cancelled: { bucket: 'finished', tone: 'neutral' },
    skipped: { bucket: 'finished', tone: 'neutral' },
    superseded: { bucket: 'finished', tone: 'neutral' },
    failed: { bucket: 'finished', tone: 'danger' },
};

/** Presentation settlement mirrors the incumbent lifecycle contract; no state is transitioned. */
export function isTerminalWorkflowRunState(state: WorkflowRunStateV1): boolean {
    return isTerminalAutomationRunStateV3(state);
}

export function isTerminalWorkflowInvocationLifecycle(lifecycle: WorkflowInvocationLifecycleV1): boolean {
    return STEP_STATUS[lifecycle].bucket === 'finished';
}

function presentWorkflow(shape: StatusShape, facts: WorkflowFacts): WorkStatusPresentation {
    if (facts.inAttentionWindow === true) return { bucket: 'needs_you', tone: 'attention', word: facts.word };
    const outcome = facts.outcome;
    const terminal = shape.bucket === 'finished' || outcome === 'source_unavailable';
    if (!terminal && facts.machineReachable === false) return { bucket: 'offline', tone: 'neutral', word: facts.word };
    return {
        bucket: terminal ? 'finished' : shape.bucket,
        tone: outcome === 'completed_with_failures' ? 'danger'
            : outcome === 'source_unavailable' || outcome === 'target_unavailable' ? 'attention'
                : shape.tone,
        word: facts.word,
    };
}

/** Maps owner facts into shared presentation. Words and lifecycle decisions stay with their owners. */
export function resolveWorkStatusTone(input: WorkStatusInput): WorkStatusPresentation {
    switch (input.kind) {
        case 'action_operation': {
            const { state, observation, setupReview, word } = input.facts;
            if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
                return { bucket: 'finished', tone: state === 'failed' ? 'danger' : 'neutral', word };
            }
            if (setupReview) return { bucket: 'needs_you', tone: 'attention', word };
            return { bucket: 'working', tone: observation === 'available' ? 'neutral' : 'attention', word };
        }
        case 'worker_update': {
            const { update, word } = input.facts;
            const failed = update.ownerState === 'failed' || update.ownerState === 'dispatch_failed';
            if (update.wake === 'needs_you') return { bucket: 'needs_you', tone: failed ? 'danger' : 'attention', word };
            if (update.wake === 'stalled') return { bucket: 'offline', tone: 'neutral', word };
            if (update.workerKind === 'workflow_run') return presentWorkflow(RUN_STATUS[update.ownerState], { word });
            if (update.ownerState === 'needs_input') return { bucket: 'needs_you', tone: 'attention', word };
            if (update.ownerState === 'stalled') return { bucket: 'offline', tone: 'neutral', word };
            return { bucket: 'finished', tone: failed ? 'danger' : update.ownerState === 'timeout' ? 'attention' : 'neutral', word };
        }
        case 'workflow_run': return presentWorkflow(RUN_STATUS[input.facts.state], input.facts);
        case 'workflow_step': return presentWorkflow(STEP_STATUS[input.facts.lifecycle], input.facts);
        case 'session': {
            const { awareness, settled, word } = input.facts;
            return { ...readSessionAwarenessWorkStatusV1({ awareness, settled }), word };
        }
        case 'machine': {
            const { online, needsYouCount, runningSessionCount, word } = input.facts;
            if (!online) {
                const managed = input.facts.managedMachine;
                if (managed?.creationState === 'active' && managed.archivedAt === undefined
                    && !(typeof input.facts.revokedAt === 'number' && input.facts.revokedAt > 0) && input.facts.machineId
                    && managed.enrolledMachineId === input.facts.machineId) {
                    const observation = managed.observation;
                    if (managed.allocation === 'confirmed-absent' || observation?.availability === 'absent') {
                        return { bucket: 'needs_you', tone: 'attention', word: t('managedPower.resourceAbsent') };
                    }
                    if (observation?.storage === 'lost') return { bucket: 'needs_you', tone: 'attention', word: t('managedPower.volumeLost') };
                    if (!observation || observation.availability !== 'present') return { bucket: 'idle', tone: 'neutral', word: t('status.unknown') };
                    if (observation.power !== 'running' && managed.submittedNativeEffect?.intent === 'start') {
                        return { bucket: 'working', tone: 'neutral', word: t('managedWake.starting', { machine: managed.launch.name }) };
                    }
                    if (observation.storage === 'retained' && (observation.power === 'stopped' || observation.power === 'suspended')) {
                        const retainedWake = managed.wakeOnAcceptedMessage && managed.desired !== 'delete'
                            && managed.submittedNativeEffect?.intent !== 'delete' && !managed.cleanup
                            && isMachineRetainedWakeEligibleV1(managed.retention,
                            managed.reviewedFacts?.retentionCapabilities);
                        return { bucket: 'idle', tone: 'neutral', word: retainedWake ? t('managedPower.asleep')
                            : t(`managedMachines.detail.power.${observation.power}`) };
                    }
                }
                return { bucket: 'offline', tone: 'neutral', word };
            }
            if (needsYouCount > 0) return { bucket: 'needs_you', tone: 'attention', word };
            return { bucket: runningSessionCount > 0 ? 'working' : 'idle', tone: 'neutral', word };
        }
        case 'workflow': {
            const { needsYouCount, hasActiveRun, word } = input.facts;
            if (needsYouCount > 0) return { bucket: 'needs_you', tone: 'attention', word };
            return { bucket: hasActiveRun ? 'working' : 'idle', tone: 'neutral', word };
        }
        case 'agent_activity': {
            // `waiting` is the one status that says a person is the blocker; a terminal status is
            // finished, a failure is danger and a timeout (interrupted, not chosen) is attention, as a
            // worker update's timeout reads; `unknown` claims neither working nor finished.
            const { status, word } = input.facts;
            if (status === 'waiting') return { bucket: 'needs_you', tone: 'attention', word };
            if (isInProgressAgentActivityStatus(status)) return { bucket: 'working', tone: 'neutral', word };
            if (isTerminalAgentActivityStatus(status)) {
                return { bucket: 'finished', tone: status === 'failed' ? 'danger' : status === 'timedOut' ? 'attention' : 'neutral', word };
            }
            return { bucket: 'idle', tone: 'neutral', word };
        }
    }
}
