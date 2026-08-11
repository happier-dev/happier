import {
    buildAgentActivityEntryId,
    parseAgentActivityEntryId,
    type SessionAgentActivityHeadlineV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { makeSessionWorkflowRunSnapshot } from '@/dev/testkit';
import {
    deriveAgentActivityEntries,
    type AgentActivityLocalEntry,
} from '@/sync/domains/session/agentActivity';

import { buildWorkflowActivityRows, groupWorkflowAgentsByPhase } from './sessionWorkflowActivityPresentation';

/**
 * The parity lock between the two ends of one agent's identity.
 *
 * `deriveAgentActivityEntries` unions the headline the CLI publishes with what this client derives,
 * and it unions them BY ID. So a producer and a consumer that spell one agent differently do not
 * error, do not warn and do not fail a schema — they render that agent TWICE. This file exists
 * because that happened: the transcript card and the work-state popover keyed a workflow agent
 * `wf_1:agent:a1` from a template here, while the headline and the roster keyed the same agent
 * `workflow_agent:wf_1:a1` through the protocol owner.
 *
 * Both assertions below compare the two sides against EACH OTHER rather than against a string. A
 * test that pinned today's literal would pass the day a producer and a consumer changed together in
 * different directions, which is the only way this defect ever appears. The literal itself is
 * pinned once, at the owner, in `packages/protocol/…/agentActivityEntryId.test.ts`.
 *
 * The CLI half is `apps/cli/…/activity/agentActivityHeadlineProjection.ts`, which calls
 * `buildAgentActivityEntryId({ kind: 'workflow_agent', runId, agentId })` for every agent in a
 * committed snapshot — the same call this file makes. `apps/ui` cannot import it, so the shared
 * builder is what the two sides are compared through.
 */

// Both components genuinely carry the separator in production (PLAN wave 7): the CLI synthesizes
// the run id `implicit:agent-activity`, and a workflow journal falls back to the agent id
// `workflow-agent:1`. Using them here is what makes this a test of the escaping contract rather
// than of a happy-path string.
const RUN_ID = 'implicit:agent-activity';
const AGENT_ID = 'workflow-agent:1';

function snapshotWithOneAgent(phased: boolean) {
    return makeSessionWorkflowRunSnapshot({
        runId: RUN_ID,
        agents: [{ id: AGENT_ID, title: 'Explore', status: 'active', updatedAt: 1_000 }],
        ...(phased
            ? { phases: [{ id: 'p1', title: 'Research', order: 1, agentIds: [AGENT_ID] }] }
            : {}),
    });
}

describe('workflow agent row id <-> agent-activity entry id', () => {
    it('spells a workflow agent the way the headline spells it, on both row paths', () => {
        const expected = buildAgentActivityEntryId({
            kind: 'workflow_agent',
            runId: RUN_ID,
            agentId: AGENT_ID,
        });

        // The unphased path builds its rows in a different branch from the phased one, and that
        // branch used to mint the id a second time. Asserting both is what stops one of them
        // drifting on its own.
        const unphased = buildWorkflowActivityRows(snapshotWithOneAgent(false));
        const unphasedRow = unphased.find((row) => row.kind === 'agent');
        expect(unphasedRow?.rowId).toBe(expected);
        expect(unphasedRow?.kind === 'agent' ? unphasedRow.agent.rowId : null).toBe(expected);

        const phasedGroups = groupWorkflowAgentsByPhase(snapshotWithOneAgent(true));
        expect(phasedGroups[0]?.agents[0]?.rowId).toBe(expected);

        // The round trip is the half that would catch both sides moving together onto a scheme that
        // cannot be read back — the ambiguity the escaping exists to prevent.
        expect(parseAgentActivityEntryId(expected)).toEqual({
            kind: 'workflow_agent',
            runId: RUN_ID,
            agentId: AGENT_ID,
        });
    });

    it('merges the published entry and the transcript row into ONE row, not two', () => {
        const runEntryId = buildAgentActivityEntryId({ kind: 'workflow_run', runId: RUN_ID });
        const agentEntryId = buildAgentActivityEntryId({
            kind: 'workflow_agent',
            runId: RUN_ID,
            agentId: AGENT_ID,
        });
        const headline: SessionAgentActivityHeadlineV1 = {
            v: 1,
            backendId: 'claude',
            updatedAt: 2_000,
            activeEntries: [
                {
                    entryId: runEntryId,
                    kind: 'workflow_run',
                    title: 'Run',
                    status: 'running',
                    updatedAt: 1_000,
                    runId: RUN_ID,
                },
                {
                    entryId: agentEntryId,
                    kind: 'workflow_agent',
                    title: 'Explore',
                    status: 'running',
                    updatedAt: 1_000,
                    runId: RUN_ID,
                    parentId: runEntryId,
                },
            ],
        };

        const row = buildWorkflowActivityRows(snapshotWithOneAgent(false)).find(
            (candidate) => candidate.kind === 'agent',
        );
        // `handle: null` is the real shape, not a convenience: a workflow agent reaches a host from
        // a committed snapshot, which carries no sidechain or tool id, so the entry id is the ONLY
        // key the two sides can be joined on. Giving it a handle here would let the join succeed
        // through the back door and the test would stop discriminating.
        const local: AgentActivityLocalEntry = {
            id: row?.kind === 'agent' ? row.rowId : 'missing-row',
            kind: 'workflow_agent',
            handle: null,
            status: 'running',
            title: 'Explore',
        };

        const merged = deriveAgentActivityEntries({ headline, local: [local] });
        const agentEntries = merged.entries.filter((entry) => entry.kind === 'workflow_agent');

        expect(agentEntries).toHaveLength(1);
        expect(agentEntries[0]?.id).toBe(agentEntryId);
        expect(agentEntries[0]?.provenance).toBe('merged');
    });
});
