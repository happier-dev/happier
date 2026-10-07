import { readSessionWorkStatePrimaryItemV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStatePrimary';
import type { SessionWorkflowActivityHeadlineV1, SessionWorkflowRunHeadlineV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';
import type { WorkflowRunStateV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import type {
    AgentInputStatusBadgeEmphasis,
    AgentInputStatusBadgeTone,
} from '@/components/sessions/agentInput/agentInputContracts';

import { isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { resolveWorkflowRunTone } from '@/components/workflows/presentation/workflowPresentation';

import {
    formatWorkflowAgentFraction,
    resolveActiveWorkflowRunHeadlines,
    resolveActiveWorkflowPhasePosition,
} from './sessionWorkflowActivityPresentation';
import {
    formatSessionWorkStateBadgeLabel,
    resolveSessionWorkStateBadgeEmphasis,
    resolveSessionWorkStateBadgeTone,
    SESSION_WORK_STATE_STATUS_BADGE_KEY,
} from './sessionWorkStatePresentation';
import type { SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';

/**
 * UIW2 — the SINGLE compact above-AgentInput badge composer.
 *
 * This is the only seam allowed to build the compact activity badge. It composes the normalized
 * work-state primary item (goal/task/todo) with the workflow activity headline and a few small
 * permission/editability facts. Callers pass narrow, memoizable inputs (snapshots/headline + small
 * booleans), NOT the full `Session`.
 *
 * Critically, goal/task/todo primary selection is delegated to the protocol resolver
 * `readSessionWorkStatePrimaryItemV1`, so this module honors the published identity
 * and never reimplements the work-state priority list. Workflow priority is a
 * UI presentation choice layered ON TOP of normalized contracts — it does not mutate protocol
 * `primaryItemId` semantics, and it never parses Claude-native events.
 */

export type SessionActivityBadgeIconKind = 'goal' | 'task' | 'workflow' | 'permission';

export type SessionActivityStatusBadgePresentation = Readonly<{
    key: string;
    label: string;
    tone: AgentInputStatusBadgeTone;
    emphasis: AgentInputStatusBadgeEmphasis;
    iconKind: SessionActivityBadgeIconKind;
    popoverKind: 'workState';
}>;

/**
 * The managed-Workflow half of the badge's reason to exist.
 *
 * Observed native activity and managed Runs are two different lifecycle
 * contracts, and only the first has a headline. Keeping them as two counts
 * rather than one total is what stops the badge from summing a Claude phase
 * rollup with an admitted Run into a number neither owner reported.
 */
export type SessionManagedWorkflowBadgeSignal = Readonly<{
    /** Managed Runs the canonical Run-state owner does not consider settled. */
    activeCount: number;
    /** Exactly the Runs the server's attention predicate returned. */
    attentionCount: number;
}>;

const NO_MANAGED_WORKFLOW_RUNS: SessionManagedWorkflowBadgeSignal = Object.freeze({
    activeCount: 0,
    attentionCount: 0,
});

/**
 * Project the Session's managed Runs onto that signal.
 *
 * Attention is never re-derived from Run state: an approval can be waiting in
 * an invocation this client has never loaded, so the server predicate is the
 * only owner of "this needs the person". A settled Run can still be in it —
 * unresolved delivery custody is attention without being active.
 */
export function summarizeSessionManagedWorkflowRuns(input: Readonly<{
    runs: readonly Readonly<{ id: string; state: WorkflowRunStateV1 }>[];
    attentionRunIds: ReadonlySet<string>;
}>): SessionManagedWorkflowBadgeSignal {
    let activeCount = 0;
    let attentionCount = 0;
    for (const run of input.runs) {
        if (!isTerminalWorkflowRunState(run.state)) activeCount += 1;
        if (input.attentionRunIds.has(run.id)) attentionCount += 1;
    }
    // One shared empty value, so an idle Session's badge memo keeps its identity.
    return activeCount === 0 && attentionCount === 0
        ? NO_MANAGED_WORKFLOW_RUNS
        : { activeCount, attentionCount };
}

export function shouldRetainSessionActivityStatusBadge(input: Readonly<{
    activeStatusBadgeKey: string | null;
    hasPrimaryWorkStateItem: boolean;
    canShowEmptyGoalControls: boolean;
    hasActiveWorkflowRuns: boolean;
    hasManagedWorkflowRuns: boolean;
}>): boolean {
    if (input.activeStatusBadgeKey !== SESSION_WORK_STATE_STATUS_BADGE_KEY) return false;
    return input.hasPrimaryWorkStateItem
        || input.canShowEmptyGoalControls
        || input.hasActiveWorkflowRuns
        || input.hasManagedWorkflowRuns;
}

type WorkflowComposerTranslate = Readonly<{
    /** `Goal active` — used in the tight goal+workflow combined label. */
    goalActive: () => string;
    /** `Goal: {title}` — combined-label goal prefix when there is room. */
    goalLabel: (params: { title: string }) => string;
    /** `Workflow {fraction} agents` — headline-only fallback. */
    workflowAgentsFallback: (params: { fraction: string }) => string;
    /** `Workflow` — bare label when no fraction is known. */
    workflowBare: () => string;
    /** `{title} {phase} {fraction}` style active-phase label, e.g. `Implement 2/5`. */
    workflowPhaseLabel: (params: { title: string; fraction: string }) => string;
    /** `{count} workflows` plural label. */
    workflowsPlural: (params: { count: number }) => string;
    /** `{count} workflows · {agents} agents` plural with agent total. */
    workflowsPluralWithAgents: (params: { count: number; agents: number }) => string;
    /** Join two compact segments, e.g. `Goal active · 2 workflows`. */
    join: (params: { left: string; right: string }) => string;
    /** `Needs you` — the canonical Workflow attention word, reused verbatim. */
    managedNeedsYou: () => string;
}>;

export type ResolveSessionActivityPresentationInput = Readonly<{
    workStateSnapshot: SessionWorkStateSnapshot | null;
    workflowHeadline: SessionWorkflowActivityHeadlineV1 | null;
    loadedWorkflowRunsById?: ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
    /**
     * Managed Runs this Session started. A managed-only Session has no
     * headline, so without this the badge — and therefore the popover holding
     * the Run's entry point and its approval — never existed.
     */
    managedWorkflowRuns?: SessionManagedWorkflowBadgeSignal;
    permissionBlocked?: boolean;
    /** Mirrors the legacy "show empty goal chip when active" affordance (QA-CHIP-1). */
    activeStatusBadgeKey?: string | null;
    editableGoal: boolean;
    /** Work-state badge label/tone formatter (reuses `sessionWorkStatePresentation`). */
    translateWorkState: Parameters<typeof formatSessionWorkStateBadgeLabel>[1];
    /** Workflow compact-label formatter (i18n strings). */
    translateWorkflow: WorkflowComposerTranslate;
    /** Permission-blocked badge label. */
    permissionBlockedLabel?: string;
}>;

function badgeToneToInputTone(tone: ReturnType<typeof resolveSessionWorkStateBadgeTone>): AgentInputStatusBadgeTone {
    return tone;
}

/** A workflow badge speaks the one work-status tone: healthy is neutral, trouble warns (INT §5.3). */
function workflowRunBadgeTone(status: SessionWorkflowRunHeadlineV1['status']): AgentInputStatusBadgeTone {
    return resolveWorkflowRunTone(status) === 'neutral' ? 'neutral' : 'warning';
}

/** Compact single-workflow label: active phase when detail loaded, else headline counts/title. */
function formatSingleWorkflowLabel(
    run: SessionWorkflowRunHeadlineV1,
    loadedSnapshot: SessionWorkflowRunSnapshotV1 | undefined,
    t: WorkflowComposerTranslate,
): string {
    if (loadedSnapshot) {
        const phase = resolveActiveWorkflowPhasePosition(loadedSnapshot);
        const fraction = formatWorkflowAgentFraction(run);
        if (phase?.title && fraction) {
            return t.workflowPhaseLabel({ title: phase.title, fraction });
        }
        if (fraction) {
            return t.workflowPhaseLabel({ title: run.title, fraction });
        }
    }
    const fraction = formatWorkflowAgentFraction(run);
    return fraction ? t.workflowAgentsFallback({ fraction }) : t.workflowBare();
}

function formatWorkflowSegment(
    activeRuns: readonly SessionWorkflowRunHeadlineV1[],
    primaryRun: SessionWorkflowRunHeadlineV1,
    loadedRunsById: ReadonlyMap<string, SessionWorkflowRunSnapshotV1> | undefined,
    t: WorkflowComposerTranslate,
): string {
    if (activeRuns.length <= 1) {
        return formatSingleWorkflowLabel(primaryRun, loadedRunsById?.get(primaryRun.runId), t);
    }
    const loadedPrimary = loadedRunsById?.get(primaryRun.runId);
    if (loadedPrimary) {
        const phase = resolveActiveWorkflowPhasePosition(loadedPrimary);
        const fraction = formatWorkflowAgentFraction(primaryRun);
        if (phase?.title && fraction) {
            return t.join({
                left: t.workflowsPlural({ count: activeRuns.length }),
                right: t.workflowPhaseLabel({ title: phase.title, fraction }),
            });
        }
    }
    const totalAgents = activeRuns.reduce((sum, run) => sum + run.totalAgents, 0);
    return totalAgents > 0
        ? t.workflowsPluralWithAgents({ count: activeRuns.length, agents: totalAgents })
        : t.workflowsPlural({ count: activeRuns.length });
}

/**
 * The compact managed-Run segment.
 *
 * It borrows the observed vocabulary — `Workflow`, `{n} workflows` — because
 * the person is reading one badge, not two subsystems. What it never borrows
 * is the other contract's numbers: no agent fraction, no phase, because a
 * managed Run reports neither.
 */
function formatManagedWorkflowSegment(
    count: number,
    t: WorkflowComposerTranslate,
): string {
    return count > 1 ? t.workflowsPlural({ count }) : t.workflowBare();
}

/**
 * Resolve the single compact activity badge. Decision order (UIW2):
 *   1. permission/approval blocked.
 *   2. managed Runs the server says need the person.
 *   3. active goal + active observed workflow(s) combined.
 *   4. active observed workflow(s) alone.
 *   5. active managed Run(s), alone or combined with an active goal.
 *   6. canonical work-state primary item (active task/todo/goal, blocked, paused, pending, fallback).
 *   7. recent completed workflow/goal only when not noisy (handled by work-state primary fallback).
 */
export function resolveSessionActivityStatusBadgePresentation(
    input: ResolveSessionActivityPresentationInput,
): SessionActivityStatusBadgePresentation | null {
    // 1. Permission/approval blocked beats everything.
    if (input.permissionBlocked && input.permissionBlockedLabel) {
        return {
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label: input.permissionBlockedLabel,
            tone: 'warning',
            emphasis: 'prominent',
            iconKind: 'permission',
            popoverKind: 'workState',
        };
    }

    const activeRuns = resolveActiveWorkflowRunHeadlines(input.workflowHeadline);
    const primaryRun = activeRuns[0] ?? null;
    const managed = input.managedWorkflowRuns ?? NO_MANAGED_WORKFLOW_RUNS;
    const primaryItem = readSessionWorkStatePrimaryItemV1(input.workStateSnapshot?.items ?? [], input.workStateSnapshot?.primaryItemId);
    const activeGoal = input.workStateSnapshot?.items.find((item) => item.kind === 'goal' && item.status === 'active') ?? null;

    // 2. Managed attention. It is the only workflow signal that is actionable
    // rather than informational, so it outranks progress of either kind.
    if (managed.attentionCount > 0) {
        return {
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label: input.translateWorkflow.join({
                left: formatManagedWorkflowSegment(managed.attentionCount, input.translateWorkflow),
                right: input.translateWorkflow.managedNeedsYou(),
            }),
            tone: 'warning',
            emphasis: 'prominent',
            iconKind: 'workflow',
            popoverKind: 'workState',
        };
    }

    // 3. Active goal + active observed workflow(s) combined.
    if (activeGoal && primaryRun) {
        const workflowSegment = formatWorkflowSegment(activeRuns, primaryRun, input.loadedWorkflowRunsById, input.translateWorkflow);
        return {
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label: input.translateWorkflow.join({
                left: input.translateWorkflow.goalActive(),
                right: workflowSegment,
            }),
            tone: workflowRunBadgeTone(primaryRun.status),
            emphasis: 'quiet',
            iconKind: 'workflow',
            popoverKind: 'workState',
        };
    }

    // 4. Active observed workflow(s) alone (goal alone falls through below).
    if (!activeGoal && primaryRun) {
        return {
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label: formatWorkflowSegment(activeRuns, primaryRun, input.loadedWorkflowRunsById, input.translateWorkflow),
            tone: workflowRunBadgeTone(primaryRun.status),
            emphasis: 'quiet',
            iconKind: 'workflow',
            popoverKind: 'workState',
        };
    }

    // 5. Active managed Run(s). Observed activity keeps the arms above, so a
    // Session with both still reads its native agent's own progress; this arm
    // is what a managed-only Session had instead of no badge at all.
    if (managed.activeCount > 0) {
        const segment = formatManagedWorkflowSegment(managed.activeCount, input.translateWorkflow);
        return {
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label: activeGoal
                ? input.translateWorkflow.join({ left: input.translateWorkflow.goalActive(), right: segment })
                : segment,
            // Running managed work is healthy, so its badge stays neutral.
            tone: 'neutral',
            emphasis: 'quiet',
            iconKind: 'workflow',
            popoverKind: 'workState',
        };
    }

    // 6. Canonical work-state primary item (active goal alone, tasks, todos, blocked, etc).
    if (primaryItem) {
        const label = formatSessionWorkStateBadgeLabel(primaryItem, input.translateWorkState);
        if (label) {
            return {
                key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
                label,
                tone: badgeToneToInputTone(resolveSessionWorkStateBadgeTone(primaryItem)),
                emphasis: resolveSessionWorkStateBadgeEmphasis(primaryItem),
                iconKind: primaryItem.kind === 'goal' ? 'goal' : 'task',
                popoverKind: 'workState',
            };
        }
    }

    // Empty active goal chip affordance (QA-CHIP-1): show "Set goal" when goal editing is available.
    if (input.editableGoal && input.activeStatusBadgeKey === SESSION_WORK_STATE_STATUS_BADGE_KEY) {
        const label = input.translateWorkState('session.workState.goal.title');
        return {
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label,
            tone: 'neutral',
            emphasis: 'quiet',
            iconKind: 'goal',
            popoverKind: 'workState',
        };
    }

    return null;
}
