import { describe, expect, it } from 'vitest';

import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';
import {
    makeSessionWorkflowActivityHeadline,
    makeSessionWorkflowRunHeadline,
    makeSessionWorkflowRunSnapshot,
} from '@/dev/testkit';

import {
    resolveSessionActivityStatusBadgePresentation,
    shouldRetainSessionActivityStatusBadge,
} from './sessionActivityPresentation';
import type { SessionWorkStateItem, SessionWorkStateSnapshot } from '@/sync/domains/session/workState/sessionWorkStateTypes';

// Minimal i18n-shaped translate doubles (no real i18n needed for pure resolver tests).
const translateWorkState = ((key: string, params?: { title: string }) => {
    if (key === 'session.workState.goal.title') return 'Set goal';
    if (key === 'session.workState.badge.goal') return `Goal: ${params?.title ?? ''}`;
    if (key === 'session.workState.badge.item') return params?.title ?? '';
    if (key === 'session.workState.badge.goalPaused') return 'Goal paused';
    if (key === 'session.workState.badge.goalBlocked') return 'Goal blocked';
    if (key === 'session.workState.badge.goalBudgetLimited') return 'Goal limited';
    if (key === 'session.workState.badge.goalComplete') return 'Goal complete';
    return key;
}) as Parameters<typeof resolveSessionActivityStatusBadgePresentation>[0]['translateWorkState'];

const translateWorkflow = {
    goalActive: () => 'Goal active',
    goalLabel: ({ title }: { title: string }) => `Goal: ${title}`,
    workflowAgentsFallback: ({ fraction }: { fraction: string }) => `Workflow ${fraction} agents`,
    workflowBare: () => 'Workflow',
    workflowPhaseLabel: ({ title, fraction }: { title: string; fraction: string }) => `${title} ${fraction}`,
    workflowsPlural: ({ count }: { count: number }) => `${count} workflows`,
    workflowsPluralWithAgents: ({ count, agents }: { count: number; agents: number }) => `${count} workflows · ${agents} agents`,
    join: ({ left, right }: { left: string; right: string }) => `${left} · ${right}`,
};

function workStateItem(over: Partial<SessionWorkStateItem> & { id: string; kind: SessionWorkStateItem['kind']; status: SessionWorkStateItem['status'] }): SessionWorkStateItem {
    return {
        origin: 'vendor',
        title: over.title ?? over.id,
        updatedAt: over.updatedAt ?? 1,
        ...over,
    };
}

function workState(items: SessionWorkStateItem[], primaryItemId?: string | null): SessionWorkStateSnapshot {
    return {
        v: 1,
        backendId: 'claude',
        updatedAt: 1,
        items,
        ...(primaryItemId !== undefined ? { primaryItemId } : {}),
    };
}

const runHeadline = makeSessionWorkflowRunHeadline;
const headline = makeSessionWorkflowActivityHeadline;

function loadedSnapshot(over: Partial<SessionWorkflowRunSnapshotV1> & { runId: string }): SessionWorkflowRunSnapshotV1 {
    return makeSessionWorkflowRunSnapshot({ title: 'Implement', ...over });
}

function resolve(input: Partial<Parameters<typeof resolveSessionActivityStatusBadgePresentation>[0]>) {
    return resolveSessionActivityStatusBadgePresentation({
        workStateSnapshot: null,
        workflowHeadline: null,
        editableGoal: false,
        translateWorkState,
        translateWorkflow,
        ...input,
    });
}

describe('resolveSessionActivityStatusBadgePresentation', () => {
    it('returns null when there is nothing to show', () => {
        expect(resolve({})).toBeNull();
    });

    it('permission blocked beats workflow and work state', () => {
        const result = resolve({
            permissionBlocked: true,
            permissionBlockedLabel: 'Needs review',
            workflowHeadline: headline([runHeadline({ runId: 'a', totalAgents: 3, completedAgents: 1 })]),
            workStateSnapshot: workState([workStateItem({ id: 'g', kind: 'goal', status: 'active', title: 'Ship' })]),
        });
        expect(result?.iconKind).toBe('permission');
        expect(result?.label).toBe('Needs review');
        expect(result?.tone).toBe('warning');
    });

    it('active goal + active workflow produces a combined workflow-icon badge', () => {
        const result = resolve({
            workStateSnapshot: workState([workStateItem({ id: 'g', kind: 'goal', status: 'active', title: 'Ship goals' })]),
            workflowHeadline: headline([runHeadline({ runId: 'a', totalAgents: 5, completedAgents: 2 })]),
        });
        expect(result?.iconKind).toBe('workflow');
        // Goal active · Workflow 2/5 agents (headline-only fallback)
        expect(result?.label).toContain('Goal active');
        expect(result?.label).toContain('2/5');
    });

    it('active workflow alone uses the workflow segment', () => {
        const result = resolve({
            workflowHeadline: headline([runHeadline({ runId: 'a', totalAgents: 4, completedAgents: 1 })]),
        });
        expect(result?.iconKind).toBe('workflow');
        expect(result?.label).toBe('Workflow 1/4 agents');
    });

    it('uses the active phase label when run detail is loaded', () => {
        const snap = loadedSnapshot({
            runId: 'a',
            title: 'Implement',
            totalAgents: 5,
            completedAgents: 2,
            phases: [
                { id: 'p1', title: 'Research', order: 1, agentIds: ['x'] },
                { id: 'p2', title: 'Implement', order: 2, agentIds: ['y'] },
            ],
            agents: [
                { id: 'x', title: 'web', status: 'complete', updatedAt: 1 },
                { id: 'y', title: 'edit', status: 'active', updatedAt: 1 },
            ],
        });
        const result = resolve({
            workflowHeadline: headline([runHeadline({ runId: 'a', totalAgents: 5, completedAgents: 2 })]),
            loadedWorkflowRunsById: new Map([['a', snap]]),
        });
        // Active phase is "Implement" (first phase with a non-complete agent) → "Implement 2/5".
        expect(result?.label).toBe('Implement 2/5');
    });

    it('multiple active workflows produce a plural summary that does not hide secondary runs', () => {
        const result = resolve({
            workflowHeadline: headline([
                runHeadline({ runId: 'a', totalAgents: 3, completedAgents: 1, updatedAt: 5 }),
                runHeadline({ runId: 'b', totalAgents: 4, completedAgents: 0, updatedAt: 4 }),
            ]),
        });
        expect(result?.label).toBe('2 workflows · 7 agents');
    });

    it('keeps the compact badge anchored to the stable primary run across updatedAt churn', () => {
        const primarySnapshot = loadedSnapshot({
            runId: 'a',
            totalAgents: 2,
            completedAgents: 1,
            phases: [{ id: 'p1', title: 'Verify', order: 1, agentIds: ['agent-a'] }],
            agents: [{ id: 'agent-a', title: 'check', status: 'active', updatedAt: 1 }],
        });
        const result = resolve({
            workflowHeadline: headline([
                runHeadline({ runId: 'a', totalAgents: 2, completedAgents: 1, updatedAt: 1 }),
                runHeadline({ runId: 'b', totalAgents: 2, completedAgents: 0, updatedAt: 999 }),
            ]),
            loadedWorkflowRunsById: new Map([['a', primarySnapshot]]),
        });

        expect(result?.label).toBe('2 workflows · Verify 1/2');
    });

    it('falls back to the work-state primary item for active goal alone', () => {
        const result = resolve({
            workStateSnapshot: workState([workStateItem({ id: 'g', kind: 'goal', status: 'active', title: 'Ship goals' })]),
        });
        expect(result?.iconKind).toBe('goal');
        expect(result?.label).toBe('Goal: Ship goals');
    });

    it('a completed task primary id does not pin over an active goal (G4 inheritance)', () => {
        const result = resolve({
            workStateSnapshot: workState([
                workStateItem({ id: 'task:done', kind: 'task', status: 'complete', title: 'Done task' }),
                workStateItem({ id: 'goal:1', kind: 'goal', status: 'active', title: 'Active goal' }),
            ], 'task:done'),
        });
        // Protocol primary resolver must yield the active goal, not the stale completed task.
        expect(result?.iconKind).toBe('goal');
        expect(result?.label).toBe('Goal: Active goal');
    });

    it('completed workflow does not hide an active goal', () => {
        const result = resolve({
            workStateSnapshot: workState([workStateItem({ id: 'g', kind: 'goal', status: 'active', title: 'Ship' })]),
            workflowHeadline: headline([runHeadline({ runId: 'a', status: 'complete', totalAgents: 2, completedAgents: 2 })]),
        });
        // Terminal run is not "active" → no combined workflow badge; active goal wins.
        expect(result?.iconKind).toBe('goal');
        expect(result?.label).toBe('Goal: Ship');
    });

    it('shows the empty "Set goal" chip when goal editing is available (QA-CHIP-1)', () => {
        const result = resolve({
            editableGoal: true,
            activeStatusBadgeKey: 'work-state',
        });
        expect(result?.iconKind).toBe('goal');
        expect(result?.label).toBe('Set goal');
    });
});

describe('shouldRetainSessionActivityStatusBadge', () => {
    it('keeps the activity popover open for workflow-only sessions with no work-state item', () => {
        expect(shouldRetainSessionActivityStatusBadge({
            activeStatusBadgeKey: 'work-state',
            hasPrimaryWorkStateItem: false,
            canShowEmptyGoalControls: false,
            hasActiveWorkflowRuns: true,
        })).toBe(true);
    });

    it('closes the activity popover when no represented activity remains', () => {
        expect(shouldRetainSessionActivityStatusBadge({
            activeStatusBadgeKey: 'work-state',
            hasPrimaryWorkStateItem: false,
            canShowEmptyGoalControls: false,
            hasActiveWorkflowRuns: false,
        })).toBe(false);
    });
});
