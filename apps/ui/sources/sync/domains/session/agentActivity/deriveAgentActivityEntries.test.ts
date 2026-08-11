import { describe, expect, it } from 'vitest';

import {
    buildAgentActivityEntryId,
    type SessionAgentActivityEntryV1,
    type SessionAgentActivityHeadlineV1,
    type SessionWorkflowActivityHeadlineV1,
} from '@happier-dev/protocol';

import { collectAgentActivityGroupingIds } from './agentActivityGrouping';
import { deriveAgentActivityCounts } from './deriveAgentActivityCounts';
import {
    deriveAgentActivityEntries,
    toAgentActivityCountable,
} from './deriveAgentActivityEntries';
import type { AgentActivityLocalEntry } from './types';

const IMPLICIT_RUN_ID = 'implicit:agent-activity';

function headlineEntry(
    overrides: Partial<SessionAgentActivityEntryV1> & Pick<SessionAgentActivityEntryV1, 'entryId' | 'kind'>,
): SessionAgentActivityEntryV1 {
    return {
        title: overrides.entryId,
        status: 'running',
        updatedAt: 1_000,
        ...overrides,
    };
}

function makeHeadline(
    active: readonly SessionAgentActivityEntryV1[],
    recent: readonly SessionAgentActivityEntryV1[] = [],
    truncatedCount = 0,
): SessionAgentActivityHeadlineV1 {
    return {
        v: 1,
        backendId: 'claude',
        updatedAt: 2_000,
        activeEntries: [...active],
        recentEntries: [...recent],
        ...(truncatedCount > 0
            ? { truncated: { reason: 'entry_limit' as const, omittedCount: truncatedCount } }
            : {}),
    };
}

function localEntry(
    overrides: Partial<AgentActivityLocalEntry> & Pick<AgentActivityLocalEntry, 'id'>,
): AgentActivityLocalEntry {
    return {
        kind: 'subagent',
        handle: null,
        status: 'running',
        title: overrides.id,
        ...overrides,
    };
}

/** The agent the CLI attached to the implicit run, as both sides independently see it. */
function subagentSeenByBothSides(toolUseId: string, overrides?: Partial<AgentActivityLocalEntry>) {
    return {
        headline: headlineEntry({
            entryId: buildAgentActivityEntryId({
                kind: 'workflow_agent',
                runId: IMPLICIT_RUN_ID,
                agentId: toolUseId,
            }),
            kind: 'workflow_agent',
            title: 'Review the diff',
            parentId: buildAgentActivityEntryId({ kind: 'workflow_run', runId: IMPLICIT_RUN_ID }),
            runId: IMPLICIT_RUN_ID,
        }),
        local: localEntry({
            id: `subagent_sidechain:${toolUseId}`,
            handle: toolUseId,
            title: 'Review the diff',
            sidechainId: toolUseId,
            subagentId: `subagent_sidechain:${toolUseId}`,
            ...overrides,
        }),
    };
}

describe('deriveAgentActivityEntries', () => {
    describe('the cross-source join', () => {
        // THE keystone. The CLI names this agent `workflow_agent:implicit:agent-activity:toolu_1`;
        // the UI derives the same Task as `subagent_sidechain:toolu_1`. A merge keyed on the entry id
        // alone renders it twice, and nothing else in the system notices.
        it('renders one row for an agent both sources know about', () => {
            const seen = subagentSeenByBothSides('toolu_1');

            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([seen.headline]),
                local: [seen.local],
            });
            expect(merged.entries).toHaveLength(1);
            expect(merged.entries[0]?.provenance).toBe('merged');
            // The headline's id wins, so every surface keys the same agent the same way regardless of
            // which source was available first.
            expect(merged.entries[0]?.id).toBe(seen.headline.entryId);
            expect(merged.entries[0]?.subagentId).toBe('subagent_sidechain:toolu_1');
        });

        it('does not join a run onto a local row that happens to share its id shape', () => {
            const runEntry = headlineEntry({
                entryId: buildAgentActivityEntryId({ kind: 'workflow_run', runId: 'toolu_1' }),
                kind: 'workflow_run',
            });
            const local = localEntry({ id: 'subagent_sidechain:toolu_1', handle: 'toolu_1' });

            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([runEntry]),
                local: [local],
            });

            expect(merged.entries).toHaveLength(2);
            expect(merged.entries.map((entry) => entry.provenance).sort())
                .toEqual(['headline', 'local']);
        });
    });

    describe('INV-1 — the headline owns existence and status', () => {
        it('takes the headline status when the two disagree, and counts the divergence', () => {
            const seen = subagentSeenByBothSides('toolu_1', { status: 'running' });
            const headline = makeHeadline([], [{ ...seen.headline, status: 'failed' }]);

            const merged = deriveAgentActivityEntries({ headline, local: [seen.local] });

            expect(merged.entries).toHaveLength(1);
            expect(merged.entries[0]?.status).toBe('failed');
            expect(merged.diagnostics.statusDivergenceCount).toBe(1);
        });

        // The bounded exception. A permission prompt is on screen; the CLI cannot see it and
        // publishes `running`. Deferring to the headline here would leave the one status that
        // escalates unable to escalate, and the composer would never fill for the case R-7 exists
        // for.
        it('lets a locally observed `waiting` overrule a live headline status', () => {
            const seen = subagentSeenByBothSides('toolu_1', { status: 'waiting' });
            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([{ ...seen.headline, status: 'running' }]),
                local: [seen.local],
            });

            expect(merged.entries[0]?.status).toBe('waiting');
            // Not a producer bug, so it must not pollute the diagnostic that finds producer bugs.
            expect(merged.diagnostics.statusDivergenceCount).toBe(0);
        });

        // A finished agent is not waiting on anybody; painting it as attention sends a person to a
        // row they cannot act on.
        it('does not let `waiting` overrule a terminal headline status', () => {
            const seen = subagentSeenByBothSides('toolu_1', { status: 'waiting' });
            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([], [{ ...seen.headline, status: 'succeeded' }]),
                local: [seen.local],
            });

            expect(merged.entries[0]?.status).toBe('succeeded');
            expect(merged.diagnostics.statusDivergenceCount).toBe(1);
        });

        it('reports no divergence when they agree', () => {
            const seen = subagentSeenByBothSides('toolu_1');
            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([seen.headline]),
                local: [seen.local],
            });
            expect(merged.diagnostics.statusDivergenceCount).toBe(0);
        });

        it('keeps the local detail the headline cannot carry', () => {
            const seen = subagentSeenByBothSides('toolu_1', {
                metaDetail: 'Reading src/index.ts',
                startedAtMs: 500,
                endedAtMs: 900,
            });

            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([seen.headline]),
                local: [seen.local],
            });

            expect(merged.entries[0]?.metaDetail).toBe('Reading src/index.ts');
            expect(merged.entries[0]?.startedAtMs).toBe(500);
            expect(merged.entries[0]?.endedAtMs).toBe(900);
        });

        // Both instants are evidence; the newer one is the one that has not gone stale. Taking the
        // headline's blindly would freeze a live agent's staleness clock at its launch instant.
        it('keeps the later of the two evidence instants', () => {
            const seen = subagentSeenByBothSides('toolu_1', { updatedAtMs: 9_000 });
            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([{ ...seen.headline, updatedAt: 3_000 }]),
                local: [seen.local],
            });
            expect(merged.entries[0]?.updatedAtMs).toBe(9_000);
        });
    });

    describe('INV-2 — neither side is dropped', () => {
        it('renders a headline-only entry as unloaded detail', () => {
            const seen = subagentSeenByBothSides('toolu_1');
            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([seen.headline]),
                local: [],
            });

            expect(merged.entries).toHaveLength(1);
            expect(merged.entries[0]?.provenance).toBe('headline');
            expect(merged.entries[0]?.detailState).toBe('unloaded');
        });

        it('renders a local-only entry as loaded detail', () => {
            const seen = subagentSeenByBothSides('toolu_1');
            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([]),
                local: [seen.local],
            });

            expect(merged.entries).toHaveLength(1);
            expect(merged.entries[0]?.provenance).toBe('local');
            expect(merged.entries[0]?.detailState).toBe('loaded');
            expect(merged.entries[0]?.id).toBe('subagent_sidechain:toolu_1');
        });
    });

    describe('the degrade paths', () => {
        // Codex / Gemini / OpenCode: the publisher is composed for Claude only, so there is no
        // unified headline at all. This must be indistinguishable from today, not an error and not
        // an empty roster.
        it('serves the local roster when no headline exists at all', () => {
            const merged = deriveAgentActivityEntries({
                headline: null,
                workflowHeadline: null,
                local: [localEntry({ id: 'execution_run:run_1', kind: 'execution_run' })],
            });

            expect(merged.entries).toHaveLength(1);
            expect(merged.entries[0]?.provenance).toBe('local');
            expect(merged.headlineSource).toBe('none');
        });

        // New client, old CLI: only the count-only workflow headline is published. It can name runs
        // and never agents, so the roster is the local one and the run rides along for the hosts
        // that render runs.
        it('falls back to the workflow headline when the unified key is absent', () => {
            const workflowHeadline: SessionWorkflowActivityHeadlineV1 = {
                v: 1,
                backendId: 'claude',
                updatedAt: 1_000,
                activeRuns: [{
                    runId: 'toolu_wf_1',
                    title: 'Ship the thing',
                    status: 'active',
                    updatedAt: 1_000,
                    recordRevision: '1-aaaaaaaa',
                    recordUpdatedAt: 1_000,
                    totalAgents: 3,
                    completedAgents: 1,
                }],
            };

            const merged = deriveAgentActivityEntries({
                headline: null,
                workflowHeadline,
                local: [localEntry({ id: 'subagent_sidechain:toolu_1', handle: 'toolu_1' })],
            });

            expect(merged.headlineSource).toBe('workflow');
            // The run is a unit of work here, not a box. Nothing in the count-only headline links
            // its three agents back to it, so no entry in this list speaks for the run — and
            // treating the producer's `totalAgents` as proof of members made a running workflow
            // report `live: 0` on every count surface while both rosters drew it as a live panel
            // (PLAN §4.6: running work is always visible). Membership is decided by what is in the
            // list, and here nothing is; see `agentActivityGrouping`.
            expect(merged.entries.map((entry) => entry.id))
                .toEqual(['subagent_sidechain:toolu_1', 'workflow_run:toolu_wf_1']);
        });

        /**
         * The FIX-1 trade, pinned rather than merely described.
         *
         * On the count-only path nothing links a run to the agents this client derived from the
         * transcript, so BOTH are units of work and both rosters draw them — a run panel beside its
         * own agents, which is double REPRESENTATION and is the deliberate direction of the error:
         * the alternative hid a running workflow entirely.
         *
         * What must not double is what the surfaces SAY. The local rows carry the run they were
         * launched under, so the counts owner attributes them to it and the description stays the
         * producer's: one workflow, three agents — the same sentence as before any of them was
         * derivable. This is the pair; a change that satisfied either half alone would pass one of
         * these assertions and ship the other defect.
         */
        it('draws a count-only run beside its unlinked agents, and still describes them once', () => {
            const workflowHeadline: SessionWorkflowActivityHeadlineV1 = {
                v: 1,
                backendId: 'claude',
                updatedAt: 1_000,
                activeRuns: [{
                    runId: 'toolu_wf_1',
                    title: 'Ship the thing',
                    status: 'active',
                    updatedAt: 1_000,
                    recordRevision: '1-aaaaaaaa',
                    recordUpdatedAt: 1_000,
                    totalAgents: 3,
                    completedAgents: 0,
                }],
            };
            const merged = deriveAgentActivityEntries({
                headline: null,
                workflowHeadline,
                local: [
                    localEntry({ id: 'subagent_sidechain:toolu_1', handle: 'toolu_1', runId: 'toolu_wf_1' }),
                    localEntry({ id: 'subagent_sidechain:toolu_2', handle: 'toolu_2', runId: 'toolu_wf_1' }),
                ],
            });

            // Drawn: nothing names the run as its parent, so it is a unit of work beside its own two
            // agents and a roster shows all three.
            expect(merged.entries.map((entry) => entry.id)).toEqual([
                'subagent_sidechain:toolu_1',
                'subagent_sidechain:toolu_2',
                'workflow_run:toolu_wf_1',
            ]);

            // Said: one workflow of three agents, and no second population beside it.
            expect(deriveAgentActivityCounts(merged.entries.map(toAgentActivityCountable)))
                .toMatchObject({ liveWorkflowRuns: 1, liveWorkflowAgents: 3, liveSubagents: 0 });
        });

        // ...but a run with no members is the only visible unit of that work, and the composer is
        // entitled to say "1 workflow running" about it.
        it('keeps a memberless workflow run as a unit of work', () => {
            const merged = deriveAgentActivityEntries({
                headline: null,
                workflowHeadline: {
                    v: 1,
                    backendId: 'claude',
                    updatedAt: 1_000,
                    activeRuns: [{
                        runId: 'toolu_wf_1',
                        title: 'Ship the thing',
                        status: 'active',
                        updatedAt: 1_000,
                        recordRevision: '1-aaaaaaaa',
                        recordUpdatedAt: 1_000,
                        totalAgents: 0,
                        completedAgents: 0,
                    }],
                },
                local: [],
            });

            expect(merged.entries.map((entry) => entry.id))
                .toEqual(['workflow_run:toolu_wf_1']);
        });

        // Consuming both would double-count: the unified headline is projected from the SAME
        // committed snapshots the workflow headline is, so every run appears in both.
        it('ignores the workflow headline once the unified one exists', () => {
            const runId = 'toolu_wf_1';
            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([headlineEntry({
                    entryId: buildAgentActivityEntryId({ kind: 'workflow_run', runId }),
                    kind: 'workflow_run',
                    runId,
                })]),
                workflowHeadline: {
                    v: 1,
                    backendId: 'claude',
                    updatedAt: 1_000,
                    activeRuns: [{
                        runId,
                        title: 'Ship the thing',
                        status: 'active',
                        updatedAt: 1_000,
                        recordRevision: '1-aaaaaaaa',
                        recordUpdatedAt: 1_000,
                        totalAgents: 3,
                        completedAgents: 1,
                    }],
                },
                local: [],
            });

            expect(merged.headlineSource).toBe('agentActivity');
            expect(merged.entries).toHaveLength(1);
        });
    });

    describe('groupings are not units of work', () => {
        it('keeps a run in the model and marks it a container by its members', () => {
            const runId = IMPLICIT_RUN_ID;
            const runEntryId = buildAgentActivityEntryId({ kind: 'workflow_run', runId });
            const first = subagentSeenByBothSides('toolu_1');
            const second = subagentSeenByBothSides('toolu_2');

            const merged = deriveAgentActivityEntries({
                headline: makeHeadline([
                    headlineEntry({ entryId: runEntryId, kind: 'workflow_run', runId }),
                    first.headline,
                    second.headline,
                ]),
                local: [],
            });

            // The run stays IN the model — it is the row the roster draws the group as.
            expect(merged.entries.map((entry) => entry.id)).toContain(runEntryId);
            // ...and both agents name it as their parent, which is the ONE signal that makes it a
            // container rather than a third unit of work. `collectAgentActivityGroupingIds` reads
            // exactly this list, so a merge that dropped or rewrote `parentId` would let the shared
            // counter report three agents where the roster draws two.
            expect(merged.entries
                .filter((entry) => entry.parentId === runEntryId)
                .map((entry) => entry.id))
                .toEqual([first.headline.entryId, second.headline.entryId]);
            expect([...collectAgentActivityGroupingIds(merged.entries)]).toEqual([runEntryId]);
        });
    });

    /**
     * The producer's bound is a wire fact, not a UI one. Nothing derives an "at least N" phrasing
     * from it any more — the composer states a work state, and the roster shows the rows it has —
     * so the merge exposes no truncation flag for a surface to escalate from.
     */
    it('exposes no truncation flag for a surface to escalate from', () => {
        const merged = deriveAgentActivityEntries({ headline: makeHeadline([], [], 7), local: [] });
        expect(merged).not.toHaveProperty('historyTruncated');
    });
});
