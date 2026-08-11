import { describe, expect, it } from 'vitest';

import {
    buildAgentActivityEntryId,
    type SessionAgentActivityEntryV1,
    type SessionAgentActivityHeadlineV1,
    type SessionBackgroundTaskRecordV1,
    type SessionWorkflowActivityHeadlineV1,
} from '@happier-dev/protocol';

import {
    makeSessionWorkflowActivityHeadline,
    makeSessionWorkflowRunHeadline,
} from '@/dev/testkit/fixtures/sessionWorkflowActivityFixtures';
import {
    deriveAgentActivityCounts,
    deriveAgentActivityEntries,
    toAgentActivityCountable,
    toBackgroundTaskLocalEntry,
    type AgentActivityCounts,
    type AgentActivityLocalEntry,
} from '@/sync/domains/session/agentActivity';
import { hasLiveAgentActivity } from '@/sync/domains/session/agentActivity/deriveAgentActivityCounts';
import { en } from '@/text/translations/en';

import {
    resolveSessionActivityStatusBadgePresentation,
    shouldRetainSessionActivityStatusBadge,
    type ResolveSessionActivityPresentationInput,
    type SessionActivityComposerTranslate,
} from './sessionActivityPresentation';
import { SESSION_WORK_STATE_STATUS_BADGE_KEY } from './sessionWorkStatePresentation';
import type { SessionWorkStateSnapshot } from './sessionWorkStateTypes';

/**
 * RULING-12: ONE magnitude for one piece of work.
 *
 * The composer chip and the live tally — the session-header glyph, the Agents tab badge and the
 * session-list row all read the same `counts.live` — used to state DIFFERENT numbers about the same
 * work. Each side was internally honest: the chip spoke the run's producer-stated live AGENT
 * complement while the tally counted ROSTER UNITS and treated the run itself as one. Three shapes
 * disagreed, and one of them is the FIX-1 invisibility class surviving a layer down:
 *
 * - a count-only run 5/3 said "2 agents" on the chip and `1` in the badge;
 * - the same run with two locally derived members said `3` — the members counted a second time on
 *   top of the complement that already described them;
 * - a run whose named members have all gone terminal said "1 workflow running" beside a badge
 *   reading **0**, a zero printed while a workflow was genuinely running.
 *
 * So this is the whole label matrix, executed through the real chain — the merge, the countable
 * projection, the one counter and the real chip composer — against the LITERAL `en.ts` strings, with
 * the chip sentence and the tally side by side. `chipMagnitude(counts) === counts.live` on every row
 * carries the first and third shapes, where `chipMagnitude` states exactly the numbers the chip
 * prints: a row that disagrees is a user reading 2 in one place and 3 an inch away.
 *
 * It does NOT carry the second one, and that is worth stating rather than discovering. Both sides of
 * that comparison read `liveSubagents`, so a regression that counted a run's own members a second
 * time inflates the chip and the tally together and the cross-check still passes — measured, by
 * deleting the attribution guard: the invariant stayed green while S4 went 2 → 4 and S8 went 4 → 6.
 * The PINNED ROWS are what decide the double count. Neither assertion subsumes the other; keep both.
 *
 * The local sources are their own owners with their own tests, so a plain subagent enters as the
 * `AgentActivityLocalEntry` they produce; the background command goes through the real
 * `toBackgroundTaskLocalEntry` because its kind is what keeps a shell loop from being called an
 * agent. Everything from the merge down is the production path.
 */

const RUN_ID = 'wf1';
const RUN_ENTRY_ID = buildAgentActivityEntryId({ kind: 'workflow_run', runId: RUN_ID });

/** The literal shipped copy, bound the way `resolveSessionActivityComposerTranslate` binds it. */
const TRANSLATE_ACTIVITY: SessionActivityComposerTranslate = {
    workflowsWithAgents: (params) => en.session.agentActivity.composer.workflowsWithAgents(params),
    workflowsRunning: (params) => en.session.agentActivity.composer.workflowsRunning(params),
    subagentsWorking: (params) => en.session.agentActivity.composer.subagentsWorking(params),
    backgroundTasksRunning: (params) => en.session.agentActivity.composer.backgroundTasksRunning(params),
    join: (params) => en.session.workState.workflow.join(params),
};

const TRANSLATE_WORK_STATE: ResolveSessionActivityPresentationInput['translateWorkState'] = (key, params) => {
    switch (key) {
        case 'session.workState.badge.goal':
            return en.session.workState.badge.goal({ title: params?.title ?? '' });
        case 'session.workState.badge.item':
            return en.session.workState.badge.item({ title: params?.title ?? '' });
        case 'session.workState.badge.goalPaused':
            return en.session.workState.badge.goalPaused;
        case 'session.workState.badge.goalBlocked':
            return en.session.workState.badge.goalBlocked;
        case 'session.workState.badge.goalBudgetLimited':
            return en.session.workState.badge.goalBudgetLimited;
        case 'session.workState.badge.goalComplete':
            return en.session.workState.badge.goalComplete;
        case 'session.workState.goal.title':
            return en.session.workState.goal.title;
        default:
            throw new Error(`unexpected work-state key ${key}`);
    }
};

const GOAL_SNAPSHOT: SessionWorkStateSnapshot = {
    v: 1,
    backendId: 'claude',
    updatedAt: 1_000,
    items: [{
        id: 'goal-1',
        kind: 'goal',
        origin: 'happier',
        status: 'active',
        title: 'Ship goals',
        updatedAt: 1_000,
    }],
    primaryItemId: 'goal-1',
};

/** The older, count-only headline: a run states `totalAgents`/`completedAgents` and names nobody. */
function countOnlyHeadline(over: Readonly<{
    totalAgents: number;
    completedAgents: number;
}>): SessionWorkflowActivityHeadlineV1 {
    return makeSessionWorkflowActivityHeadline([
        makeSessionWorkflowRunHeadline({
            runId: RUN_ID,
            title: 'Ship the release',
            status: 'active',
            totalAgents: over.totalAgents,
            completedAgents: over.completedAgents,
        }),
    ]);
}

function workflowAgent(over: Readonly<{
    agentId: string;
    status: SessionAgentActivityEntryV1['status'];
}>): SessionAgentActivityEntryV1 {
    return {
        entryId: buildAgentActivityEntryId({ kind: 'workflow_agent', runId: RUN_ID, agentId: over.agentId }),
        kind: 'workflow_agent',
        title: `Agent ${over.agentId}`,
        status: over.status,
        updatedAt: 2_000,
        runId: RUN_ID,
        parentId: RUN_ENTRY_ID,
    };
}

/** The unified headline: a run that NAMES its members instead of counting them. */
function unifiedHeadline(
    members: readonly SessionAgentActivityEntryV1[],
): SessionAgentActivityHeadlineV1 {
    return {
        v: 1,
        backendId: 'claude',
        updatedAt: 2_000,
        activeEntries: [
            {
                entryId: RUN_ENTRY_ID,
                kind: 'workflow_run',
                title: 'Ship the release',
                status: 'running',
                updatedAt: 2_000,
                runId: RUN_ID,
            },
            ...members.filter((member) => member.status === 'running'),
        ],
        recentEntries: members.filter((member) => member.status !== 'running'),
    };
}

function plainSubagent(over: Readonly<{
    id: string;
    status: AgentActivityLocalEntry['status'];
    runId?: string;
}>): AgentActivityLocalEntry {
    return {
        id: over.id,
        kind: 'subagent',
        handle: over.id,
        status: over.status,
        title: `Subagent ${over.id}`,
        ...(over.runId ? { runId: over.runId } : {}),
    };
}

function backgroundCommand(id: string): AgentActivityLocalEntry {
    const record: SessionBackgroundTaskRecordV1 = {
        v: 1,
        taskId: id,
        kind: 'command',
        status: 'running',
        label: 'yarn test --watch',
        updatedAt: 3_000,
    };
    return toBackgroundTaskLocalEntry({ record, fallbackTitle: 'Background command' });
}

type Scenario = Readonly<{
    id: string;
    what: string;
    headline?: SessionAgentActivityHeadlineV1 | null;
    workflowHeadline?: SessionWorkflowActivityHeadlineV1 | null;
    local?: readonly AgentActivityLocalEntry[];
    workStateSnapshot?: SessionWorkStateSnapshot | null;
    /** The chip sentence, in literal shipped copy. `null` is "no chip at all". */
    chip: string | null;
    /** `counts.live`: the tab badge, the header glyph and the session-list row read this. */
    live: number;
    retained: boolean;
}>;

const SCENARIOS: readonly Scenario[] = [
    {
        id: 'S1',
        what: 'nothing at all',
        chip: null,
        live: 0,
        retained: false,
    },
    {
        id: 'S2',
        what: 'count-only run 5/0, no members',
        workflowHeadline: countOnlyHeadline({ totalAgents: 5, completedAgents: 0 }),
        chip: '1 workflow, 5 agents',
        live: 5,
        retained: true,
    },
    {
        id: 'S3',
        what: 'count-only run 5/3, no members',
        workflowHeadline: countOnlyHeadline({ totalAgents: 5, completedAgents: 3 }),
        chip: '1 workflow, 2 agents',
        live: 2,
        retained: true,
    },
    {
        id: 'S4',
        what: 'count-only run 5/3 plus two derivable members',
        workflowHeadline: countOnlyHeadline({ totalAgents: 5, completedAgents: 3 }),
        local: [
            plainSubagent({ id: 'local-a', status: 'running', runId: RUN_ID }),
            plainSubagent({ id: 'local-b', status: 'running', runId: RUN_ID }),
        ],
        // The members ARE the agents the complement already counts, so they add no second tally.
        chip: '1 workflow, 2 agents',
        live: 2,
        retained: true,
    },
    {
        id: 'S5',
        what: 'count-only run 5/5, still running',
        workflowHeadline: countOnlyHeadline({ totalAgents: 5, completedAgents: 5 }),
        // A run in flight is never zero live work, whatever its complement says.
        chip: '1 workflow running',
        live: 1,
        retained: true,
    },
    {
        id: 'S6',
        what: 'inconsistent count-only run 5/9, clamped',
        workflowHeadline: countOnlyHeadline({ totalAgents: 5, completedAgents: 9 }),
        chip: '1 workflow running',
        live: 1,
        retained: true,
    },
    {
        id: 'S7',
        what: 'three plain subagents, one awaiting approval',
        local: [
            plainSubagent({ id: 'a', status: 'running' }),
            plainSubagent({ id: 'b', status: 'running' }),
            plainSubagent({ id: 'c', status: 'waiting' }),
        ],
        chip: '3 subagents working',
        live: 3,
        retained: true,
    },
    {
        id: 'S8',
        what: 'unified run, 5 named / 3 terminal, plus two plain subagents',
        headline: unifiedHeadline([
            workflowAgent({ agentId: 'wfa-1', status: 'succeeded' }),
            workflowAgent({ agentId: 'wfa-2', status: 'succeeded' }),
            workflowAgent({ agentId: 'wfa-3', status: 'succeeded' }),
            workflowAgent({ agentId: 'wfa-4', status: 'running' }),
            workflowAgent({ agentId: 'wfa-5', status: 'running' }),
        ]),
        local: [
            plainSubagent({ id: 'a', status: 'running' }),
            plainSubagent({ id: 'b', status: 'running' }),
        ],
        chip: '1 workflow, 2 agents · 2 subagents working',
        live: 4,
        retained: true,
    },
    {
        id: 'S9',
        what: 'unified run still running, every named member terminal',
        headline: unifiedHeadline([
            workflowAgent({ agentId: 'wfa-1', status: 'succeeded' }),
            workflowAgent({ agentId: 'wfa-2', status: 'succeeded' }),
        ]),
        // The badge read 0 here while a workflow ran — FIX-1's invisibility class, one layer down.
        chip: '1 workflow running',
        live: 1,
        retained: true,
    },
    {
        id: 'S10',
        what: 'an active goal and three plain subagents',
        local: [
            plainSubagent({ id: 'a', status: 'running' }),
            plainSubagent({ id: 'b', status: 'running' }),
            plainSubagent({ id: 'c', status: 'running' }),
        ],
        workStateSnapshot: GOAL_SNAPSHOT,
        chip: '3 subagents working · Goal: Ship goals',
        live: 3,
        retained: true,
    },
    {
        id: 'S11',
        what: 'an active goal and nothing running',
        workStateSnapshot: GOAL_SNAPSHOT,
        chip: 'Goal: Ship goals',
        live: 0,
        // Retained by the goal, not by activity: there is no live work to speak for.
        retained: true,
    },
    {
        id: 'S12',
        what: 'one background command',
        local: [backgroundCommand('task-1')],
        chip: '1 background command running',
        live: 1,
        retained: true,
    },
    {
        id: 'S13',
        what: 'a failed subagent and nothing else',
        local: [plainSubagent({ id: 'a', status: 'failed' })],
        chip: null,
        live: 0,
        retained: false,
    },
];

function countsFor(scenario: Scenario): AgentActivityCounts {
    const merged = deriveAgentActivityEntries({
        headline: scenario.headline ?? null,
        workflowHeadline: scenario.workflowHeadline ?? null,
        local: scenario.local ?? [],
    });
    return deriveAgentActivityCounts(merged.entries.map(toAgentActivityCountable));
}

function chipFor(scenario: Scenario, counts: AgentActivityCounts): string | null {
    return resolveSessionActivityStatusBadgePresentation({
        workStateSnapshot: scenario.workStateSnapshot ?? null,
        agentActivityCounts: counts,
        editableGoal: false,
        translateWorkState: TRANSLATE_WORK_STATE,
        translateActivity: TRANSLATE_ACTIVITY,
    })?.label ?? null;
}

/**
 * The magnitude the CHIP states, assembled from exactly the numbers it prints.
 *
 * One segment per population: a run segment states its agent complement when the producer named
 * one and otherwise states the runs themselves, plus the loose subagents, plus the headless
 * commands. This is `formatSessionAgentActivityLabel`'s composition read as arithmetic, so
 * comparing it against `counts.live` is comparing what a reader sees on the chip against what the
 * same reader sees on the badge an inch away.
 */
function chipMagnitude(counts: AgentActivityCounts): number {
    const runs = counts.liveWorkflowRuns > 0
        ? (counts.liveWorkflowAgents > 0 ? counts.liveWorkflowAgents : counts.liveWorkflowRuns)
        : 0;
    return runs + counts.liveSubagents + counts.liveBackgroundTasks;
}

describe('RULING-12 — the chip and the live tally state one magnitude', () => {
    for (const scenario of SCENARIOS) {
        it(`${scenario.id}: ${scenario.what}`, () => {
            const counts = countsFor(scenario);

            expect({ chip: chipFor(scenario, counts), live: counts.live })
                .toEqual({ chip: scenario.chip, live: scenario.live });

            expect(shouldRetainSessionActivityStatusBadge({
                activeStatusBadgeKey: SESSION_WORK_STATE_STATUS_BADGE_KEY,
                hasPrimaryWorkStateItem: (scenario.workStateSnapshot?.items.length ?? 0) > 0,
                canShowEmptyGoalControls: false,
                agentActivityCounts: counts,
            })).toBe(scenario.retained);

            // FIX-F1's two answers are now one number by construction: the tally IS the sum of the
            // three populations a surface can name, so "there is live work" and "the tally is
            // non-zero" cannot come apart again the way they did on a run between phases.
            expect(hasLiveAgentActivity(counts)).toBe(counts.live > 0);
        });
    }

    /**
     * The rule itself, not any one row: whatever the chip says about a population, the tally says
     * the same about the same population.
     *
     * Measured against the two regressions it exists to catch, rather than asserted: restoring the
     * flat one-unit-per-run tally reports `S2: chip 5 vs tally 1`, `S3: 2 vs 1`, `S4: 2 vs 1` and
     * `S8: 4 vs 3`; deleting the running-run floor reports `S5/S6/S9: chip 1 vs tally 0`.
     */
    it('never lets the chip and the tally state different magnitudes', () => {
        const disagreements = SCENARIOS
            .map((scenario) => ({ scenario, counts: countsFor(scenario) }))
            .filter(({ counts }) => chipMagnitude(counts) !== counts.live)
            .map(({ counts, scenario }) => `${scenario.id}: chip ${chipMagnitude(counts)} vs tally ${counts.live}`);

        expect(disagreements).toEqual([]);
    });

    /** A run in flight is never zero live work — the badge must not read 0 under a live chip. */
    it('never tallies zero while a chip names live work', () => {
        const silent = SCENARIOS
            .map((scenario) => ({ scenario, counts: countsFor(scenario) }))
            .filter(({ counts, scenario }) => chipFor(scenario, counts) !== null && counts.live === 0)
            .map(({ scenario }) => scenario.id);

        // S11 is a goal chip, not a live-work chip, and states no magnitude at all.
        expect(silent).toEqual(['S11']);
    });
});
