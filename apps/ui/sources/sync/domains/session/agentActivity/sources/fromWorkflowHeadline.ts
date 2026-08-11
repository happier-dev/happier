import {
    buildAgentActivityEntryId,
    fromWorkflowRunStatus,
    type SessionWorkflowActivityHeadlineV1,
    type SessionWorkflowRunHeadlineV1,
} from '@happier-dev/protocol';

import type { AgentActivityHeadlineEntry } from '../types';

/**
 * The OLDER, count-only workflow headline, read as roster entries.
 *
 * This is the §5.2 "new client ← old CLI" path, and it is a first-class case rather than a fallback
 * nobody exercises: the unified headline is published by the Claude activity source only, so a
 * Codex, Gemini or OpenCode session — and any session served by a CLI that predates this program —
 * has no `sessionAgentActivityHeadlineV1` at all.
 *
 * What it can contribute is strictly less, and the limit is structural, not an omission here: the
 * workflow headline carries counts (`totalAgents`, `completedAgents`), never names, so it cannot
 * name a single agent. It therefore yields run entries only, and each one is a full unit of work
 * on this path: nothing else in the roster represents that run, because the headline names none of
 * its agents and a cold open has derived no transcript at all. Marking the run as a container on
 * the strength of `totalAgents` alone is what made a running workflow report `live: 0` on every
 * count surface; `agentActivityGrouping` owns the corrected rule and the reasoning.
 *
 * Its counts are nonetheless carried through as `liveAgentComplement`, because the two questions they
 * were conflated with are different ones. They cannot say WHICH agents a run has, and are therefore
 * useless as containment; they say HOW MANY, which is exactly what a surface needs to call a
 * five-agent workflow five agents instead of one anonymous unit.
 *
 * **What is carried is the run's LIVE complement, not its roster total (RULING-11).** The headline
 * states both `totalAgents` and `completedAgents`, and only the difference answers the question a
 * surface actually asks — *what is running now*. Carrying `totalAgents` alone let the composer chip
 * say "5 agents" about a run whose first three finished ten minutes ago: individually true of the
 * snapshot, and a plain overstatement of the work in flight. Subtracting one producer field from
 * another is reading the producer, not deriving a fraction by summing children (N-USAGE); the
 * per-run progress figure that DOES belong to the reader stays where it already lives, on the run
 * panel's own `completedAgents / totalAgents`.
 *
 * A zero complement is a statement, not an absence: a run that is still `running` with nothing left
 * in flight is the honest window between two phases, and the run itself remains the unit of work
 * that says so.
 *
 * Entry ids come from the same protocol builder the CLI uses, so a run named by both headlines is
 * one entry, not two.
 */

/** Agents this run's producer says are still running. Clamped: no producer may state a negative. */
function resolveLiveAgentComplement(run: SessionWorkflowRunHeadlineV1): number {
    return Math.max(0, run.totalAgents - run.completedAgents);
}

function toWorkflowRunEntry(run: SessionWorkflowRunHeadlineV1): AgentActivityHeadlineEntry {
    return {
        id: buildAgentActivityEntryId({ kind: 'workflow_run', runId: run.runId }),
        kind: 'workflow_run',
        // A run is never joined to a local row: it is the box, not the work.
        handle: null,
        status: fromWorkflowRunStatus(run.status),
        title: run.title,
        // The workflow run headline has no start instant, and inventing one from `updatedAt` is
        // precisely D-8. Absent is the truth.
        startedAtMs: null,
        updatedAtMs: run.updatedAt,
        parentId: null,
        // The one thing this headline CAN say about the run's agents, and the reason it is carried
        // rather than dropped: without it a workflow with five agents in flight is a single nameless
        // unit, and every surface understates it as "1 agent working". It describes how much of the
        // run is RUNNING and is never read as proof that this list contains its members.
        liveAgentComplement: resolveLiveAgentComplement(run),
        runId: run.runId,
        sidechainId: null,
    };
}

export function deriveWorkflowHeadlineAgentActivityEntries(
    headline: SessionWorkflowActivityHeadlineV1 | null | undefined,
): readonly AgentActivityHeadlineEntry[] {
    if (!headline) return [];
    const entries: AgentActivityHeadlineEntry[] = [];
    for (const run of headline.activeRuns) entries.push(toWorkflowRunEntry(run));
    for (const run of headline.recentRuns ?? []) entries.push(toWorkflowRunEntry(run));
    return entries;
}
