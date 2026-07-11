import {
    resolveSessionWorkStatePrimaryItemId,
    type SessionWorkflowActivityHeadlineV1,
    type SessionWorkflowRunHeadlineV1,
    type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import type {
    AgentInputStatusBadgeEmphasis,
    AgentInputStatusBadgeTone,
} from '@/components/sessions/agentInput/agentInputContracts';

import {
    formatWorkflowAgentFraction,
    resolveActiveWorkflowRunHeadlines,
    resolveActiveWorkflowPhasePosition,
    resolveWorkflowRunTone,
} from './sessionWorkflowActivityPresentation';
import {
    formatSessionWorkStateBadgeLabel,
    resolveSessionWorkStateBadgeEmphasis,
    resolveSessionWorkStateBadgeTone,
    SESSION_WORK_STATE_STATUS_BADGE_KEY,
} from './sessionWorkStatePresentation';
import type { SessionWorkStateItem, SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';

/**
 * UIW2 — the SINGLE compact above-AgentInput badge composer.
 *
 * This is the only seam allowed to build the compact activity badge. It composes the normalized
 * work-state primary item (goal/task/todo) with the workflow activity headline and a few small
 * permission/editability facts. Callers pass narrow, memoizable inputs (snapshots/headline + small
 * booleans), NOT the full `Session`.
 *
 * Critically, goal/task/todo primary selection is delegated to the protocol resolver
 * `resolveSessionWorkStatePrimaryItemId` (via the work-state reader), so this module never
 * reimplements the work-state priority list and inherits the G4 stability fix. Workflow priority is a
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

export function shouldRetainSessionActivityStatusBadge(input: Readonly<{
    activeStatusBadgeKey: string | null;
    hasPrimaryWorkStateItem: boolean;
    canShowEmptyGoalControls: boolean;
    hasActiveWorkflowRuns: boolean;
}>): boolean {
    if (input.activeStatusBadgeKey !== SESSION_WORK_STATE_STATUS_BADGE_KEY) return false;
    return input.hasPrimaryWorkStateItem || input.canShowEmptyGoalControls || input.hasActiveWorkflowRuns;
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
}>;

export type ResolveSessionActivityPresentationInput = Readonly<{
    workStateSnapshot: SessionWorkStateSnapshot | null;
    workflowHeadline: SessionWorkflowActivityHeadlineV1 | null;
    loadedWorkflowRunsById?: ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
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

function workflowToneToInputTone(tone: ReturnType<typeof resolveSessionWorkflowRunToneSafe>): AgentInputStatusBadgeTone {
    switch (tone) {
        case 'active':
            return 'active';
        case 'warning':
            return 'warning';
        case 'complete':
            return 'complete';
        default:
            return 'neutral';
    }
}

function resolveSessionWorkflowRunToneSafe(status: SessionWorkflowRunHeadlineV1['status']) {
    return resolveWorkflowRunTone(status);
}

/** Resolve the normalized work-state primary item via the protocol resolver (no UI reimplementation). */
function resolvePrimaryWorkStateItem(snapshot: SessionWorkStateSnapshot | null): SessionWorkStateItem | null {
    if (!snapshot || snapshot.items.length === 0) return null;
    const primaryId = resolveSessionWorkStatePrimaryItemId(
        snapshot.items,
        typeof snapshot.primaryItemId === 'string' ? snapshot.primaryItemId : null,
    );
    if (!primaryId) return null;
    return snapshot.items.find((item) => item.id === primaryId) ?? null;
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
 * Resolve the single compact activity badge. Decision order (UIW2):
 *   1. permission/approval blocked.
 *   2. active goal + active workflow(s) combined.
 *   3. active goal alone.
 *   4. active workflow(s) alone.
 *   5. canonical work-state primary item (active task/todo/goal, blocked, paused, pending, fallback).
 *   6. recent completed workflow/goal only when not noisy (handled by work-state primary fallback).
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
    const primaryItem = resolvePrimaryWorkStateItem(input.workStateSnapshot);
    const activeGoal = input.workStateSnapshot?.items.find((item) => item.kind === 'goal' && item.status === 'active') ?? null;

    // 2. Active goal + active workflow(s) combined.
    if (activeGoal && primaryRun) {
        const workflowSegment = formatWorkflowSegment(activeRuns, primaryRun, input.loadedWorkflowRunsById, input.translateWorkflow);
        return {
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label: input.translateWorkflow.join({
                left: input.translateWorkflow.goalActive(),
                right: workflowSegment,
            }),
            tone: workflowToneToInputTone(resolveSessionWorkflowRunToneSafe(primaryRun.status)),
            emphasis: 'quiet',
            iconKind: 'workflow',
            popoverKind: 'workState',
        };
    }

    // 4. Active workflow(s) alone (3 — goal alone — falls through to work-state primary below).
    if (!activeGoal && primaryRun) {
        return {
            key: SESSION_WORK_STATE_STATUS_BADGE_KEY,
            label: formatWorkflowSegment(activeRuns, primaryRun, input.loadedWorkflowRunsById, input.translateWorkflow),
            tone: workflowToneToInputTone(resolveSessionWorkflowRunToneSafe(primaryRun.status)),
            emphasis: 'quiet',
            iconKind: 'workflow',
            popoverKind: 'workState',
        };
    }

    // 3/5. Canonical work-state primary item (active goal alone, tasks, todos, blocked, etc).
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
