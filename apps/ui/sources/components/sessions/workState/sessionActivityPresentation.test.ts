import { describe, expect, it } from 'vitest';

import {
    resolveSessionActivityStatusBadgePresentation,
    shouldRetainSessionActivityStatusBadge,
} from './sessionActivityPresentation';
import type { SessionWorkStateItem, SessionWorkStateSnapshot } from './sessionWorkStateTypes';
import type { AgentActivityCounts } from '@/sync/domains/session/agentActivity/deriveAgentActivityCounts';

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

const translateActivity = {
    // Plural-aware, like the real locale entries: the singular is the state a fanning-out run is
    // seen in first, so a double that always said "agents" would not discriminate.
    workflowsWithAgents: ({ workflows, agents }: { workflows: number; agents: number }) =>
        `${workflows} ${workflows === 1 ? 'workflow' : 'workflows'}, ${agents} ${agents === 1 ? 'agent' : 'agents'}`,
    workflowsRunning: ({ count }: { count: number }) => (count === 1 ? '1 workflow running' : `${count} workflows running`),
    subagentsWorking: ({ count }: { count: number }) => (count === 1 ? '1 subagent working' : `${count} subagents working`),
    backgroundTasksRunning: ({ count }: { count: number }) => (count === 1 ? '1 background command running' : `${count} background commands running`),
    join: ({ left, right }: { left: string; right: string }) => `${left} · ${right}`,
};

const NO_ACTIVITY: AgentActivityCounts = {
    live: 0,
    failed: 0,
    total: 0,
    liveWorkflowRuns: 0,
    liveWorkflowAgents: 0,
    liveSubagents: 0,
    liveBackgroundTasks: 0,
};

function counts(over: Partial<AgentActivityCounts>): AgentActivityCounts {
    return { ...NO_ACTIVITY, ...over };
}

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

function resolve(input: Partial<Parameters<typeof resolveSessionActivityStatusBadgePresentation>[0]>) {
    return resolveSessionActivityStatusBadgePresentation({
        workStateSnapshot: null,
        agentActivityCounts: NO_ACTIVITY,
        editableGoal: false,
        translateWorkState,
        translateActivity,
        ...input,
    });
}

describe('resolveSessionActivityStatusBadgePresentation', () => {
    it('returns null when there is nothing to show', () => {
        expect(resolve({})).toBeNull();
    });

    /**
     * RULING-10. A five-agent workflow is a five-agent workflow, said out loud.
     *
     * Collapsing every kind into one noun reported this as "1 agent working" — the run counted as a
     * single anonymous unit and the producer's own statement of its size thrown away. The
     * pre-program composer said "1 workflow, 5 agents", and it was right to.
     */
    it('states the run AND the agent complement its producer gave it', () => {
        const result = resolve({
            agentActivityCounts: counts({ live: 1, total: 1, liveWorkflowRuns: 1, liveWorkflowAgents: 5 }),
        });
        expect(result?.label).toBe('1 workflow, 5 agents');
        expect(result?.iconKind).toBe('agent');
        expect(result?.tone).toBe('active');
        expect(result?.emphasis).toBe('quiet');
    });

    /**
     * The flip, gone at the root rather than suppressed.
     *
     * The noun used to be keyed on whether member agents happened to be LOCALLY DERIVABLE — a
     * property of the reader, not of the work — so the chip changed word and glyph mid-run while the
     * same run carried on. Keyed on the producer's description instead, the two states are the same
     * sentence: the run is the stable unit, and nothing about it moves when this client catches up.
     */
    it('never changes its noun, its glyph or its figure while one run is in flight', () => {
        const beforeFanOut = resolve({
            agentActivityCounts: counts({ live: 1, total: 1, liveWorkflowRuns: 1, liveWorkflowAgents: 5 }),
        });
        // Same run, members now derivable: they are attributed to it, so nothing is added beside it.
        const afterFanOut = resolve({
            agentActivityCounts: counts({ live: 6, total: 6, liveWorkflowRuns: 1, liveWorkflowAgents: 5 }),
        });

        expect(beforeFanOut?.label).toBe('1 workflow, 5 agents');
        expect(afterFanOut?.label).toBe('1 workflow, 5 agents');
        expect(beforeFanOut?.iconKind).toBe('agent');
        expect(afterFanOut?.iconKind).toBe('agent');
    });

    it('names a run that states no agents as a run, not as one agent', () => {
        expect(resolve({ agentActivityCounts: counts({ live: 1, total: 1, liveWorkflowRuns: 1 }) })?.label)
            .toBe('1 workflow running');
    });

    /**
     * The chip appears when there is live work to NAME, not when a unit tally is non-zero.
     *
     * A run whose named agents have all finished is still running, and it is a container in the unit
     * tally, so `live` is 0 while the workflow works. Gating on the number would blank the chip
     * between two phases of the same run — the §4.6 invisibility class this program keeps rediscovering.
     */
    it('keeps naming a run that is between phases, when no unit is live', () => {
        expect(resolve({
            agentActivityCounts: counts({ live: 0, total: 2, liveWorkflowRuns: 1, liveWorkflowAgents: 2 }),
        })?.label).toBe('1 workflow, 2 agents');
    });

    it('names plain subagents as subagents', () => {
        expect(resolve({ agentActivityCounts: counts({ live: 3, total: 4, liveSubagents: 3 }) })?.label)
            .toBe('3 subagents working');
    });

    it('keeps a shell command out of the agent nouns entirely', () => {
        expect(resolve({ agentActivityCounts: counts({ live: 4, total: 4, liveBackgroundTasks: 4 }) }))
            .toMatchObject({ label: '4 background commands running', iconKind: 'agent' });
    });

    /**
     * A mixed set composes instead of collapsing, and the reader is never asked to add anything up:
     * each population is named once, in its own words, and a run's agents never appear again as
     * loose subagents.
     */
    it('composes a mixed set honestly, with nothing counted twice', () => {
        expect(resolve({
            agentActivityCounts: counts({
                live: 4,
                total: 4,
                liveWorkflowRuns: 2,
                liveWorkflowAgents: 9,
                liveSubagents: 2,
                liveBackgroundTasks: 1,
            }),
        })?.label).toBe('2 workflows, 9 agents · 2 subagents working · 1 background command running');
    });

    /**
     * A named goal must not go silent for the whole time work runs, and it must not push the live
     * count off a single truncating line either. The count leads, the goal trails in exactly the
     * wording the idle chip uses, so the two states read as one continuous sentence.
     */
    it('keeps the goal name while work runs, behind the count', () => {
        const result = resolve({
            workStateSnapshot: workState([workStateItem({ id: 'g', kind: 'goal', status: 'active', title: 'Ship goals' })]),
            agentActivityCounts: counts({ live: 2, total: 2, liveSubagents: 2 }),
        });
        expect(result?.label).toBe('2 subagents working · Goal: Ship goals');
        expect(result?.iconKind).toBe('agent');
    });

    /**
     * R-12: the word is what carries a state to a screen reader, and this chip is the only composer
     * carrier of live agent activity. A static surface name here overrides the visible label in
     * `AgentInputStatusBadge` (`accessibilityLabel ?? label`) and silences it.
     */
    it('announces the live state, not the name of the surface', () => {
        expect(resolve({ agentActivityCounts: counts({ live: 5, total: 5, liveSubagents: 5 }) })?.accessibilityLabel)
            .toBe('5 subagents working');
        expect(resolve({
            workStateSnapshot: workState([workStateItem({ id: 'g', kind: 'goal', status: 'active', title: 'Ship goals' })]),
        })?.accessibilityLabel).toBe('Goal: Ship goals');
    });

    /**
     * The composer never announces a success and never announces a failure: a failed subagent is
     * handled by the main agent and there is nothing here for a person to press. With nothing live,
     * the chip falls through to the work state, and with no work state it is absent entirely — no
     * placeholder, no reserved space.
     */
    it('makes no claim at all about work that only failed', () => {
        expect(resolve({ agentActivityCounts: counts({ live: 0, failed: 2, total: 2 }) })).toBeNull();
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

    it('names a plan item with the plan-item icon, never the background-command noun', () => {
        const result = resolve({
            workStateSnapshot: workState([workStateItem({ id: 'task:1', kind: 'task', status: 'active', title: 'Wire the reader' })]),
        });
        expect(result?.iconKind).toBe('planItem');
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
    function retain(over: Partial<Parameters<typeof shouldRetainSessionActivityStatusBadge>[0]> = {}): boolean {
        return shouldRetainSessionActivityStatusBadge({
            activeStatusBadgeKey: 'work-state',
            hasPrimaryWorkStateItem: false,
            canShowEmptyGoalControls: false,
            agentActivityCounts: NO_ACTIVITY,
            ...over,
        });
    }

    it('keeps the activity popover open for activity-only sessions with no work-state item', () => {
        expect(retain({ agentActivityCounts: counts({ live: 3, total: 3, liveSubagents: 3 }) })).toBe(true);
    });

    it('closes the activity popover when no represented activity remains', () => {
        expect(retain()).toBe(false);
    });

    /**
     * FIX-F1, the reproduced defect.
     *
     * A unified-headline run still `running` whose named members have all gone terminal: the unit
     * tally is 0 because the run is a container, but the chip is still on screen naming the
     * workflow. Keyed on the tally, this effect cleared the open popover key and force-closed the
     * work-state popover out from under the reader at the exact moment the last member finished —
     * while the chip stayed put and the run carried on.
     */
    it('keeps the popover open on a run whose named agents have all finished', () => {
        const betweenPhases = counts({ live: 0, total: 2, liveWorkflowRuns: 1 });
        expect(resolve({ agentActivityCounts: betweenPhases })?.label).toBe('1 workflow running');
        expect(retain({ agentActivityCounts: betweenPhases })).toBe(true);
    });

    /**
     * The contract that makes the two gates one: the chip is drawn exactly when the popover behind
     * it is retained, across every shape of tally. Any future divergence — a gate reading `live`, a
     * segment added to the label without a population — fails here rather than on a device.
     */
    it('is retained exactly when the chip has something to name', () => {
        const cases: Partial<AgentActivityCounts>[] = [
            {},
            { live: 3, failed: 2, total: 5 },
            { failed: 4, total: 4 },
            { live: 0, total: 2, liveWorkflowRuns: 1 },
            { live: 2, total: 3, liveWorkflowRuns: 1, liveWorkflowAgents: 2 },
            { live: 3, total: 3, liveSubagents: 3 },
            { live: 1, total: 1, liveBackgroundTasks: 1 },
            { live: 6, total: 8, liveWorkflowRuns: 2, liveWorkflowAgents: 3, liveSubagents: 2, liveBackgroundTasks: 1 },
        ];
        for (const over of cases) {
            const value = counts(over);
            expect([JSON.stringify(over), retain({ agentActivityCounts: value })])
                .toEqual([JSON.stringify(over), resolve({ agentActivityCounts: value })?.label != null]);
        }
    });
});
