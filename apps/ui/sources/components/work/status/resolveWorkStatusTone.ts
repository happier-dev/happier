import { isInProgressAgentActivityStatus, isTerminalAgentActivityStatus, type AgentActivityStatusV1 } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityStatusV1';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { readSessionAwarenessWorkStatusV1, readSessionManagedSessionsPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { SessionAwarenessPresentationFactsV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';
import type { SessionManagedSessionsV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { resolveFollowDeliveryV1, type InboxItemAttentionTypeV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { WorkflowInvocationLifecycleV1, WorkflowRunStateV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { classifyWorkerUpdateEventV1, composeSessionWorkerUpdateHeadlineV1, type WorkerUpdateHeadlineFactsV1, type WorkerUpdateV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import type { ActionOperationSnapshotV1, ActionOperationStateV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { PluginWorkItemCategoryV1 } from '@happier-dev/protocol/plugins/contributions/workItems';

import {
    HAPPIER_WORK_STATUS_BUCKETS,
    HAPPIER_WORK_STATUS_SEMANTIC_TONE,
    joinHappierFacts,
    type HappierWorkStatusBucket,
    type HappierWorkStatusPresentation,
    type HappierWorkStatusTone,
} from '@happier-dev/plugin-ui/presentation';

import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { t } from '@/text';
import { resolveManagedMachineWakeStateV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { isManagedMachineResourceAbsent, managedCreationState } from '@/components/settings/machines/managed/managedCreationPresentation';
import type { ExternalSessionRuntimePresentation } from '@/components/sessions/presentation/externalSessionRuntimePresentation';
import { inboxItemViewV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { readWorkStatusPresentationRank } from './workStatusRank';
export { readWorkStatusPresentationRank } from './workStatusRank';

/**
 * The shared status presentation is owned by `@happier-dev/plugin-ui/presentation` (plugin authors
 * draw with the same one); these names are this resolver's vocabulary for it, not a second definition.
 * This module owns only the mapping from Happier's own owner facts onto it.
 */
export type WorkStatusBucket = HappierWorkStatusBucket;
export type WorkStatusTone = HappierWorkStatusTone;
export type WorkStatusPresentation = HappierWorkStatusPresentation;

/** Attention placement and navigation use the same admitted actionable item type. */
export function isWorkStatusNeedsYou(status: WorkStatusPresentation): boolean {
    return status.bucket === 'needs_you' && status.attentionType !== null && inboxItemViewV1(status.attentionType) === 'needs_you';
}

/** The `StatusPill` variant for a tone, where a surface states its word as a badge (ring and tint: `workStatusTreatment`). */
export const WORK_STATUS_PILL_VARIANT = HAPPIER_WORK_STATUS_SEMANTIC_TONE satisfies Record<WorkStatusTone, StatusPillVariant>;

/**
 * The state word of a worker update, as its card heads it: "<worker> finished its turn" (lab
 * `cards-T1`/`T2`). Lower-case and descriptive, because it continues the worker's name. The source
 * outcome distinguishes failure from a current request. A workflow state with no card word of its
 * own keeps the run owner's word.
 */
export function describeWorkerUpdateState(update: Pick<WorkerUpdateV1, 'workerKind' | 'ownerState' | 'wake'>): string {
    const event = classifyWorkerUpdateEventV1(update);
    if (event === 'needs_you') return t('sessionWork.workerUpdate.state.needsYou');
    if (event === 'stalled') return t('sessionWork.workerUpdate.state.stalled');
    switch (update.ownerState) {
        case 'needs_input': return t('sessionWork.workerUpdate.state.needsYou');
        case 'stalled': return t('sessionWork.workerUpdate.state.stalled');
        case 'settled': return t('sessionWork.workerUpdate.state.settled');
        case 'published': return t('sessionWork.workerUpdate.state.published');
        case 'succeeded': return t('sessionWork.workerUpdate.state.finished');
        case 'failed': return t('sessionWork.workerUpdate.state.failed');
        case 'cancelled': return t('sessionWork.workerUpdate.state.stopped');
        case 'timeout': return t('sessionWork.workerUpdate.state.timedOut');
        default: return t(`workflows.runState.${update.ownerState}`);
    }
}

/** Cards and rows state the same outcome once, retaining an authored summary when it adds a fact. */
export function describeWorkerUpdateHeadline(
    update: WorkerUpdateHeadlineFactsV1,
    options: Readonly<{ title?: string; stateWord?: string }> = {},
): string {
    const state = options.stateWord ?? describeWorkerUpdateState(update);
    const headline = update.headline.trim();
    // Native pre-fix reports embedded identity and an enum. Match the known identity,
    // not arbitrary plugin-authored text that happens to end with a status word.
    const nativeDefault = update.workerKind === 'session' && (
        headline === composeSessionWorkerUpdateHeadlineV1(update)
        || headline === `${options.title ?? update.workerId} · ${update.ownerState}`
        || headline === `${update.workerId} · ${update.ownerState}`
    );
    return joinHappierFacts(state, nativeDefault || headline === options.title ? null : headline);
}

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
    /** Exact owner-private failure occurrence acknowledgement, projected by the Run owner. */
    failureUnseen?: boolean;
    /** Invocation attention remains actionable after failure acknowledgement. */
    invocationAttentionRequired?: boolean;
    /** Absent means unknown, not offline. */
    machineReachable?: boolean;
    machineName?: string | null;
    workflowCustodyState?: WorkflowRunSummaryV1['workflowCustodyState'];
}>;

export type WorkStatusInput =
    | Readonly<{ kind: 'task'; facts: Readonly<{
        category: PluginWorkItemCategoryV1 | null;
        word?: string;
        /** Already classified by the same canonical owner; shared column priority selects the visible work. */
        linkedStatuses: readonly WorkStatusPresentation[];
    }> }>
    | Readonly<{ kind: 'action_operation'; facts: Readonly<{
        state: ActionOperationStateV1;
        observation: 'available' | 'reconnecting' | 'unavailable';
        setupReview?: ActionOperationSnapshotV1['setupReview'];
        word: string;
    }> }>
    | Readonly<{ kind: 'worker_update'; facts: Readonly<{
        update: WorkerUpdateV1;
        /** A needs-you notice the transcript has moved past: told in the past tense, no longer asking. */
        earlier?: boolean;
    }> }>
    | Readonly<{ kind: 'workflow_run'; facts: WorkflowFacts & Readonly<{ state: WorkStatusRunState; cancelRequested?: boolean }> }>
    | Readonly<{ kind: 'workflow_step'; facts: WorkflowFacts & Readonly<{ lifecycle: WorkStatusStepLifecycle; runStopPending?: boolean }> }>
    | Readonly<{ kind: 'session'; facts: Readonly<{
        word: string;
        archiving?: boolean;
        awareness: SessionAwarenessPresentationFactsV1;
        viewer?: Pick<SessionViewerProjectionV1, 'attention'> | null;
        attentionType?: InboxItemAttentionTypeV1 | null;
        requestFollowEvent?: Extract<import('@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1').FollowEventV1, { kind: 'needs_you' }>;
        currentRequest?: import('@/sync/domains/session/pending/listPendingSessionRequests').SessionPendingRequest;
        currentRequestRef?: import('@/components/ui/lists/collection/collectionRequestRef').CollectionSessionRequestIdentity | null;
        /** Settlement is supplied by the Session owner, not inferred from a word. */
        settled?: boolean;
    }> }>
    | Readonly<{ kind: 'session_reports'; facts: Readonly<{
        reports: SessionManagedSessionsV1;
        word: string;
    }> }>
    | Readonly<{ kind: 'machine'; facts: Readonly<{
        word: string; online: boolean | null; needsYouCount: number; runningSessionCount: number;
        machineId?: string;
        revokedAt?: number | null;
        /** Protected, Home-qualified inventory row; connectivity alone never establishes sleep. */
        managedMachine?: ManagedMachineV1 | null;
    }> }>
    | Readonly<{ kind: 'workflow'; facts: Readonly<{
        word: string; needsYouCount: number; hasActiveRun: boolean;
        lastRunStatus?: WorkStatusPresentation | null;
    }> }>
    | Readonly<{ kind: 'external_agent'; facts: Readonly<{
        externalAgent: ExternalSessionRuntimePresentation['externalAgent'];
        word: string;
    }> }>
    | Readonly<{ kind: 'discussion'; facts: Readonly<{
        attentionReason: 'draft_waiting' | 'approval_pending' | 'mentioned' | null;
        attentionType: InboxItemAttentionTypeV1 | null;
        word?: string;
    }> }>
    /** An execution run, sub-agent or teammate, in the agent-activity vocabulary. */
    | Readonly<{ kind: 'agent_activity'; facts: Readonly<{ status: AgentActivityStatusV1; isActive?: boolean; word: string }> }>;

type StatusShape = Readonly<{ bucket: WorkStatusBucket; tone: WorkStatusTone }>;

/** Native lifecycle overrides connectivity; callers may retain only this rendered result. */
export function resolveManagedMachineWorkStatus(facts: Pick<Extract<WorkStatusInput, { kind: 'machine' }>['facts'],
    'online' | 'managedMachine' | 'machineId' | 'revokedAt'>): WorkStatusPresentation | null {
    const managed = facts.managedMachine;
    const hasManagedOwner = managed?.creationState === 'active' && managed.archivedAt === undefined
        && !(typeof facts.revokedAt === 'number' && facts.revokedAt > 0) && facts.machineId
        && managed.enrolledMachineId === facts.machineId;
    if (!hasManagedOwner) return null;
    // Native removal settles the resource even while a retained heartbeat describes its former daemon.
    if (isManagedMachineResourceAbsent(managed)) {
        return workStatus('resource_absent', { bucket: 'needs_you', tone: 'attention' }, t('managedPower.resourceAbsent'), 'blocked');
    }
    const lifecycle = managedCreationState(managed);
    if (lifecycle.kind === 'stopPending') return workStatus('stopping', { bucket: 'working', tone: 'neutral' }, t('managedPower.stopPending'));
    if (lifecycle.kind === 'cleanupUnknown') return workStatus('cleanup_unknown', { bucket: 'needs_you', tone: 'attention' }, t('managedMachines.cleanup.unknownCause'), 'blocked');
    if (!facts.online) {
        const observation = managed.observation;
        if (observation?.storage === 'lost') return workStatus('storage_lost', { bucket: 'needs_you', tone: 'attention' }, t('managedPower.volumeLost'), 'blocked');
        if (!observation || observation.availability !== 'present') return workStatus('unknown', { bucket: 'idle', tone: 'neutral' }, t('status.unknown'));
        const wakeState = resolveManagedMachineWakeStateV1(managed, facts.machineId);
        if (wakeState === 'starting') {
            return workStatus('starting', { bucket: 'working', tone: 'neutral' }, t('managedWake.starting', { machine: managed.launch.name }));
        }
        if (observation.storage === 'retained' && (observation.power === 'stopped' || observation.power === 'suspended')) {
            return workStatus(observation.power, { bucket: 'idle', tone: 'neutral' }, wakeState === 'asleep' ? t('managedPower.asleep')
                : t(`managedMachines.detail.power.${observation.power}`));
        }
    }
    return null;
}

/** Semantic tokens only; the shared status renderer owns their drawing. */
function statusGlyph(state: string, bucket: WorkStatusBucket, tone: WorkStatusTone): WorkStatusPresentation['glyph'] {
    if (tone === 'danger') return 'failure';
    if (state === 'permission_required') return 'review';
    if (state === 'usage_limited') return 'waiting';
    if (state === 'stopped' || state === 'cancelled') return 'pause';
    if (state === 'mentioned') return 'mention';
    if (state === 'unread') return 'new';
    if (state === 'locked' || state === 'access_pending') return 'denied';
    if (state === 'content_unavailable' || state === 'recoverable_unservable') return 'unavailable';
    if (bucket === 'needs_you') return 'attention';
    if (bucket === 'working') return 'refresh';
    if (bucket === 'offline') return 'unavailable';
    if (bucket === 'finished') return 'check';
    return undefined;
}

function workStatus(state: string, shape: StatusShape, word: string,
    attentionType: InboxItemAttentionTypeV1 | null = null): WorkStatusPresentation {
    const glyph = shape.tone !== 'danger' && attentionType === 'approval'
        ? 'review' : statusGlyph(state, shape.bucket, shape.tone);
    return { state, bucket: shape.bucket, tone: shape.tone, word, attentionType, ...(glyph ? { glyph } : {}) };
}

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

type WorkflowRunStopFacts = Readonly<{
    state: WorkStatusRunState;
    workflowCustodyState?: WorkflowRunSummaryV1['workflowCustodyState'];
    cancelRequested?: boolean;
    machineReachable?: boolean;
}>;

/** Cancellation acceptance does not prove that the Run's physical work stopped. */
export function isWorkflowRunStopPending(facts: WorkflowRunStopFacts): boolean {
    if (facts.state === 'cancel_requested') return true;
    return facts.state === 'cancelled'
        ? facts.workflowCustodyState === 'pending'
        : !isTerminalWorkflowRunState(facts.state) && facts.cancelRequested === true;
}

/** An unreachable Machine cannot currently carry out the accepted Stop. */
export function isWorkflowRunStopping(facts: WorkflowRunStopFacts): boolean {
    return facts.machineReachable !== false && isWorkflowRunStopPending(facts);
}

function presentWorkflowStop(facts: WorkflowFacts): WorkStatusPresentation {
    return facts.machineReachable === false
        ? workStatus('disconnected', { bucket: 'offline', tone: 'neutral' }, facts.machineName
            ? t('workflows.run.stopWhenMachineReconnects', { machine: facts.machineName })
            : t('workflows.run.stopWhenMachineReconnectsUnknown'))
        : workStatus('stopping', { bucket: 'working', tone: 'neutral' }, t('workflows.run.stopping'));
}

export function isTerminalWorkflowInvocationLifecycle(lifecycle: WorkflowInvocationLifecycleV1): boolean {
    return STEP_STATUS[lifecycle].bucket === 'finished';
}

function presentWorkflow(state: string, shape: StatusShape, facts: WorkflowFacts): WorkStatusPresentation {
    if (facts.failureUnseen === true) return workStatus(state,
        { bucket: facts.inAttentionWindow === true ? 'needs_you' : shape.bucket, tone: 'danger' }, facts.word,
        facts.invocationAttentionRequired === true ? 'decision' : 'update');
    if (facts.inAttentionWindow === true) return workStatus(state,
        { bucket: 'needs_you', tone: 'attention' }, facts.word, 'decision');
    const outcome = facts.outcome;
    const terminal = shape.bucket === 'finished' || outcome === 'source_unavailable';
    if (!terminal && facts.machineReachable === false) return workStatus('disconnected', { bucket: 'offline', tone: 'neutral' }, facts.word);
    return workStatus(state, {
        bucket: terminal ? 'finished' : shape.bucket,
        tone: outcome === 'completed_with_failures' ? 'danger'
            : outcome === 'source_unavailable' || outcome === 'target_unavailable' ? 'attention'
                : facts.failureUnseen === false && shape.tone === 'danger' ? 'neutral' : shape.tone,
    }, facts.word);
}

/** Maps owner facts into shared presentation. Words and lifecycle decisions stay with their owners. */
export function resolveWorkStatusTone(input: WorkStatusInput): WorkStatusPresentation {
    switch (input.kind) {
        case 'task': {
            for (const bucket of HAPPIER_WORK_STATUS_BUCKETS) {
                const linked = input.facts.linkedStatuses.find(status => status.bucket === bucket);
                if (linked) return linked;
            }
            const category = input.facts.category;
            const bucket = category === 'started' ? 'working'
                : category === 'completed' || category === 'canceled' ? 'finished' : 'idle';
            return workStatus(category ?? 'unknown', { bucket, tone: 'neutral' }, input.facts.word
                ?? (category === null ? t('common.unknown') : t(`workStatus.buckets.${bucket}`)));
        }
        case 'action_operation': {
            const { state, observation, setupReview, word } = input.facts;
            if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
                return workStatus(state, { bucket: 'finished', tone: state === 'failed' ? 'danger' : 'neutral' }, word);
            }
            if (setupReview) return workStatus(state, { bucket: 'needs_you', tone: 'attention' }, word, 'approval');
            return workStatus(state, { bucket: 'working', tone: observation === 'available' ? 'neutral' : 'attention' }, word);
        }
        case 'worker_update': {
            const { update } = input.facts;
            const word = describeWorkerUpdateState(update);
            const event = classifyWorkerUpdateEventV1(update);
            const asksNow = event === 'needs_you';
            if (input.facts.earlier && asksNow && update.ownerState !== 'failed' && update.ownerState !== 'dispatch_failed') {
                return workStatus(update.ownerState, { bucket: 'finished', tone: 'neutral' }, t('sessionWork.workerUpdate.state.neededYou'));
            }
            const failed = update.ownerState === 'failed' || update.ownerState === 'dispatch_failed';
            if (asksNow) return workStatus(update.ownerState, { bucket: 'needs_you', tone: 'attention' }, word, 'decision');
            if (event === 'stalled') return workStatus('disconnected', { bucket: 'offline', tone: 'neutral' }, word);
            if (update.workerKind === 'workflow_run') return presentWorkflow(update.ownerState, RUN_STATUS[update.ownerState], { word });
            if (update.ownerState === 'needs_input') return workStatus(update.ownerState, { bucket: 'needs_you', tone: 'attention' }, word, 'decision');
            if (update.ownerState === 'stalled') return workStatus('disconnected', { bucket: 'offline', tone: 'neutral' }, word);
            return workStatus(update.ownerState, { bucket: 'finished', tone: failed ? 'danger' : update.ownerState === 'timeout' ? 'attention' : 'neutral' }, word);
        }
        case 'workflow_run': {
            const facts = input.facts;
            if (isWorkflowRunStopPending(facts)) return presentWorkflowStop(facts);
            // A stopped Run cannot still ask for a hold answer. A retained
            // attention window can lag the parent's terminal observation.
            return presentWorkflow(facts.state, RUN_STATUS[facts.state], facts.state === 'cancelled'
                ? { ...facts, inAttentionWindow: false } : facts);
        }
        case 'workflow_step': {
            const facts = input.facts;
            if (facts.lifecycle === 'cancel_requested'
                || facts.runStopPending === true && !isTerminalWorkflowInvocationLifecycle(facts.lifecycle)) {
                return presentWorkflowStop(facts);
            }
            return presentWorkflow(facts.lifecycle, STEP_STATUS[facts.lifecycle], facts);
        }
        case 'session': {
            const { awareness, viewer, settled, word, archiving, requestFollowEvent } = input.facts;
            const attentionType = input.facts.attentionType ?? null;
            const status = readSessionAwarenessWorkStatusV1({ awareness: { ...awareness, viewer, archiving }, settled });
            const actionable = attentionType !== null && inboxItemViewV1(attentionType) === 'needs_you';
            const quietRequest = requestFollowEvent && !resolveFollowDeliveryV1({ policies: [{ preset: 'important' }], event: requestFollowEvent }).person.push;
            return workStatus(status.state, {
                bucket: actionable ? 'needs_you' : status.bucket === 'needs_you' ? 'idle' : status.bucket,
                tone: status.tone === 'attention' && (!actionable || quietRequest) ? 'neutral' : status.tone,
            }, word, attentionType);
        }
        case 'session_reports': {
            const { reports, word } = input.facts;
            const status = readSessionManagedSessionsPresentationV1(reports);
            const attentionType = reports.needsYou > 0
                ? status.state === 'permission_required' ? 'approval' : 'decision' : null;
            return workStatus(status.state ?? 'waiting', status, word, attentionType);
        }
        case 'machine': {
            const { online, needsYouCount, runningSessionCount, word } = input.facts;
            const managed = resolveManagedMachineWorkStatus(input.facts);
            if (managed) return managed;
            if (!online) {
                return workStatus(online === null ? 'unknown' : 'disconnected', { bucket: online === null ? 'idle' : 'offline', tone: 'neutral' }, word);
            }
            if (needsYouCount > 0) return workStatus('action_required', { bucket: 'needs_you', tone: 'attention' }, word, 'decision');
            return workStatus(runningSessionCount > 0 ? 'thinking' : 'waiting', { bucket: runningSessionCount > 0 ? 'working' : 'idle', tone: 'neutral' }, word);
        }
        case 'workflow': {
            const { needsYouCount, hasActiveRun, word, lastRunStatus } = input.facts;
            const aggregate = needsYouCount > 0
                ? workStatus('action_required', { bucket: 'needs_you', tone: 'attention' }, word, 'decision')
                : workStatus(hasActiveRun ? 'running' : 'waiting', { bucket: hasActiveRun ? 'working' : 'idle', tone: 'neutral' }, word);
            if (!lastRunStatus || readWorkStatusPresentationRank(lastRunStatus) <= readWorkStatusPresentationRank(aggregate)) return aggregate;
            return needsYouCount > 0
                ? { ...lastRunStatus, bucket: 'needs_you', attentionType: aggregate.attentionType }
                : lastRunStatus;
        }
        case 'external_agent': {
            const { externalAgent, word } = input.facts;
            const indicator = externalAgent.indicator;
            return workStatus(externalAgent.state, {
                bucket: indicator === 'working' ? 'working' : indicator === 'action' ? 'needs_you' : indicator === 'ready' ? 'finished' : 'idle',
                tone: indicator === 'action' ? 'attention' : 'neutral',
            }, word);
        }
        case 'discussion': {
            const { attentionReason, attentionType } = input.facts;
            const actionable = attentionType !== null && inboxItemViewV1(attentionType) === 'needs_you';
            const word = input.facts.word ?? (attentionReason === 'draft_waiting' ? t('session.collaboration.discussion.home.draftWaiting')
                : attentionReason === 'approval_pending' ? t('session.collaboration.discussion.home.approvalPending')
                    : attentionReason === 'mentioned' ? t('session.collaboration.discussion.mentioned') : '');
            return workStatus(attentionReason ?? 'waiting', {
                bucket: actionable ? 'needs_you' : 'idle', tone: actionable ? 'attention' : 'neutral',
            }, word, attentionType);
        }
        case 'agent_activity': {
            // `waiting` is the one status that says a person is the blocker; a terminal status is
            // finished, a failure is danger and a timeout (interrupted, not chosen) is attention, as a
            // worker update's timeout reads; `unknown` claims neither working nor finished.
            const { status, isActive, word } = input.facts;
            if (status === 'waiting') return workStatus(status, { bucket: 'needs_you', tone: 'attention' }, word, 'decision');
            if (status === 'running' && isActive === false) return workStatus(status, { bucket: 'idle', tone: 'neutral' }, word);
            if (isInProgressAgentActivityStatus(status)) return workStatus(status, { bucket: 'working', tone: 'neutral' }, word);
            if (isTerminalAgentActivityStatus(status)) {
                return workStatus(status, { bucket: 'finished', tone: status === 'failed' ? 'danger' : status === 'timedOut' ? 'attention' : 'neutral' }, word);
            }
            return workStatus(status, { bucket: 'idle', tone: 'neutral' }, word);
        }
    }
}
