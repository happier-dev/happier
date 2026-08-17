import { describe, expect, it } from 'vitest';

import type { SessionAgentActivityHeadlineV1 } from '@happier-dev/protocol';

import { deriveAgentActivityEntries } from './deriveAgentActivityEntries';
import type { AgentActivityLocalEntry } from './types';

function headline(
    entries: Readonly<{
        active?: SessionAgentActivityHeadlineV1['activeEntries'];
        recent?: SessionAgentActivityHeadlineV1['activeEntries'];
    }>,
): SessionAgentActivityHeadlineV1 {
    return {
        v: 1,
        backendId: 'claude',
        updatedAt: 5_000,
        activeEntries: entries.active ?? [],
        ...(entries.recent ? { recentEntries: entries.recent } : {}),
    };
}

function local(overrides: Partial<AgentActivityLocalEntry> = {}): AgentActivityLocalEntry {
    return {
        id: 'subagent:local-1',
        kind: 'subagent',
        handle: 'toolu_1',
        status: 'running',
        title: 'Local title',
        metaDetail: null,
        startedAtMs: 1_000,
        updatedAtMs: 1_500,
        endedAtMs: null,
        runId: null,
        sidechainId: 'toolu_1',
        subagentId: 'subagent:local-1',
        ...overrides,
    };
}

describe('deriveAgentActivityEntries', () => {
    it('joins a local entry to its headline entry on the provider handle, not on the entry id', () => {
        const merged = deriveAgentActivityEntries({
            headline: headline({
                active: [{
                    entryId: 'workflow_agent:wf_1:toolu_1',
                    kind: 'workflow_agent',
                    title: 'Published title',
                    status: 'running',
                    updatedAt: 4_000,
                    parentId: 'workflow_run:wf_1',
                    runId: 'wf_1',
                }],
            }),
            local: [local()],
        });

        // One row, not two: the ids differ and only the handle can join them.
        expect(merged.entries).toHaveLength(1);
        expect(merged.entries[0]).toMatchObject({
            id: 'workflow_agent:wf_1:toolu_1',
            provenance: 'merged',
            detailState: 'loaded',
            // The headline owns kind and containment; the live local title wins.
            kind: 'workflow_agent',
            parentId: 'workflow_run:wf_1',
            title: 'Local title',
            subagentId: 'subagent:local-1',
        });
    });

    it('lets the headline overrule a local status and counts the disagreement instead of hiding it', () => {
        const merged = deriveAgentActivityEntries({
            headline: headline({
                recent: [{
                    entryId: 'workflow_agent:wf_1:toolu_1',
                    kind: 'workflow_agent',
                    title: 'Published title',
                    status: 'succeeded',
                    updatedAt: 4_000,
                }],
            }),
            local: [local({ status: 'running' })],
        });

        expect(merged.entries[0]?.status).toBe('succeeded');
        expect(merged.diagnostics.statusDivergenceCount).toBe(1);
        expect(merged.diagnostics.statusDivergences).toEqual([{
            entryId: 'workflow_agent:wf_1:toolu_1',
            headlineStatus: 'succeeded',
            localStatus: 'running',
        }]);
    });

    it('lets a locally observed waiting beat a non-terminal headline status without counting it as divergence', () => {
        const merged = deriveAgentActivityEntries({
            headline: headline({
                active: [{
                    entryId: 'workflow_agent:wf_1:toolu_1',
                    kind: 'workflow_agent',
                    title: 'Published title',
                    status: 'running',
                    updatedAt: 4_000,
                }],
            }),
            local: [local({ status: 'waiting' })],
        });

        expect(merged.entries[0]?.status).toBe('waiting');
        // A designed resolution, not a producer bug: counting it would bury the signal the
        // diagnostic exists to surface.
        expect(merged.diagnostics.statusDivergenceCount).toBe(0);
    });

    it('never lets a locally observed waiting overrule a TERMINAL headline status', () => {
        const merged = deriveAgentActivityEntries({
            headline: headline({
                recent: [{
                    entryId: 'workflow_agent:wf_1:toolu_1',
                    kind: 'workflow_agent',
                    title: 'Published title',
                    status: 'cancelled',
                    updatedAt: 4_000,
                }],
            }),
            local: [local({ status: 'waiting' })],
        });

        expect(merged.entries[0]?.status).toBe('cancelled');
        expect(merged.diagnostics.statusDivergenceCount).toBe(1);
    });

    it('keeps a locally known entry the headline does not mention, marked as local', () => {
        const merged = deriveAgentActivityEntries({
            headline: headline({ active: [] }),
            local: [local()],
        });

        expect(merged.entries).toHaveLength(1);
        expect(merged.entries[0]).toMatchObject({
            id: 'subagent:local-1',
            provenance: 'local',
            detailState: 'loaded',
            // Only the publisher knows containment; a local row never invents a parent.
            parentId: null,
        });
    });

    it('keeps a headline entry with no local detail, as an unloaded row rather than dropping it', () => {
        const merged = deriveAgentActivityEntries({
            headline: headline({
                active: [{
                    entryId: 'workflow_run:wf_1',
                    kind: 'workflow_run',
                    title: 'Published run',
                    status: 'running',
                    updatedAt: 4_000,
                    runId: 'wf_1',
                }],
            }),
            local: [],
        });

        expect(merged.entries).toHaveLength(1);
        expect(merged.entries[0]).toMatchObject({
            id: 'workflow_run:wf_1',
            provenance: 'headline',
            detailState: 'unloaded',
            title: 'Published run',
            status: 'running',
            metaDetail: null,
            // The headline carries no terminal instant; borrowing `updatedAt` for one would be a
            // synthesised finish.
            endedAtMs: null,
            subagentId: null,
        });
    });

    it('treats a headline that reports nothing as a tombstone rather than keeping the last status', () => {
        const withEntries = deriveAgentActivityEntries({
            headline: headline({
                active: [{
                    entryId: 'workflow_run:wf_1',
                    kind: 'workflow_run',
                    title: 'Published run',
                    status: 'running',
                    updatedAt: 4_000,
                }],
            }),
            local: [],
        });
        expect(withEntries.entries).toHaveLength(1);

        const afterRemoval = deriveAgentActivityEntries({
            headline: headline({ active: [] }),
            local: [],
        });
        expect(afterRemoval.entries).toEqual([]);
        expect(afterRemoval.evidenceAtMsById.size).toBe(0);
    });

    it('never joins one headline entry to two local rows sharing a handle', () => {
        const merged = deriveAgentActivityEntries({
            headline: headline({
                active: [{
                    entryId: 'workflow_agent:wf_1:toolu_1',
                    kind: 'workflow_agent',
                    title: 'Published title',
                    status: 'running',
                    updatedAt: 4_000,
                }],
            }),
            local: [
                local({ id: 'subagent:local-1' }),
                local({ id: 'subagent:local-2', subagentId: 'subagent:local-2' }),
            ],
        });

        expect(merged.entries.map((entry) => entry.provenance)).toEqual(['merged', 'local']);
        expect(merged.entries.map((entry) => entry.id))
            .toEqual(['workflow_agent:wf_1:toolu_1', 'subagent:local-2']);
    });

    it('indexes the LATER evidence instant per entry and never puts it on the row', () => {
        const merged = deriveAgentActivityEntries({
            headline: headline({
                active: [{
                    entryId: 'workflow_agent:wf_1:toolu_1',
                    kind: 'workflow_agent',
                    title: 'Published title',
                    status: 'running',
                    updatedAt: 9_000,
                }],
            }),
            local: [local({ updatedAtMs: 1_500 })],
        });

        expect(merged.evidenceAtMsById.get('workflow_agent:wf_1:toolu_1')).toBe(9_000);
        // Freshness must not participate in row identity — see `agentActivityEvidence`.
        expect(merged.entries[0]).not.toHaveProperty('updatedAtMs');
    });

    it('prefers the local evidence instant when it is the newer of the two', () => {
        const merged = deriveAgentActivityEntries({
            headline: headline({
                active: [{
                    entryId: 'workflow_agent:wf_1:toolu_1',
                    kind: 'workflow_agent',
                    title: 'Published title',
                    status: 'running',
                    updatedAt: 4_000,
                }],
            }),
            local: [local({ updatedAtMs: 12_000 })],
        });

        expect(merged.evidenceAtMsById.get('workflow_agent:wf_1:toolu_1')).toBe(12_000);
    });
});
