import { describe, expect, it } from 'vitest';

import { buildAgentActivityEntryId, type SessionAgentActivityHeadlineV1 } from '@happier-dev/protocol';

import {
    buildAgentActivityEvidenceIndex,
    readAgentActivityEvidenceIndexFromHeadline,
    resolveAgentActivityEvidenceAtMs,
} from './agentActivityEvidence';

const AGENT_ENTRY_ID = buildAgentActivityEntryId({
    kind: 'workflow_agent',
    runId: 'wf_1',
    agentId: 'a2',
});

describe('agentActivityEvidence', () => {
    it('takes the later instant in either direction', () => {
        const evidenceAtMsById = new Map([[AGENT_ENTRY_ID, 500]]);

        expect(resolveAgentActivityEvidenceAtMs({
            entryId: AGENT_ENTRY_ID,
            recordUpdatedAtMs: 100,
            evidenceAtMsById,
        })).toBe(500);
        expect(resolveAgentActivityEvidenceAtMs({
            entryId: AGENT_ENTRY_ID,
            recordUpdatedAtMs: 900,
            evidenceAtMsById,
        })).toBe(900);
    });

    it('says nothing when it has no evidence, rather than substituting zero', () => {
        // "We have not looked" is not "nothing happened" (4.10): a fabricated instant would make
        // the silence rule call an agent stale on the strength of our own hydration.
        expect(resolveAgentActivityEvidenceAtMs({
            entryId: AGENT_ENTRY_ID,
            recordUpdatedAtMs: null,
            evidenceAtMsById: new Map(),
        })).toBeNull();
        expect(resolveAgentActivityEvidenceAtMs({
            entryId: AGENT_ENTRY_ID,
            recordUpdatedAtMs: 100,
        })).toBe(100);
    });

    it('indexes a headline by the same entry id a durable snapshot row spells', () => {
        const headline: SessionAgentActivityHeadlineV1 = {
            v: 1,
            backendId: 'claude',
            updatedAt: 900,
            activeEntries: [{
                entryId: AGENT_ENTRY_ID,
                kind: 'workflow_agent',
                title: 'editor',
                status: 'running',
                updatedAt: 900,
                runId: 'wf_1',
            }],
            recentEntries: [{
                entryId: buildAgentActivityEntryId({ kind: 'workflow_run', runId: 'wf_1' }),
                kind: 'workflow_run',
                title: 'Investigate',
                status: 'running',
                updatedAt: 400,
            }],
        };

        const index = readAgentActivityEvidenceIndexFromHeadline(headline);

        expect(index.get(AGENT_ENTRY_ID)).toBe(900);
        expect(readAgentActivityEvidenceIndexFromHeadline(null).size).toBe(0);
    });

    it('keeps the newest instant when one entry id appears more than once', () => {
        const index = buildAgentActivityEvidenceIndex([
            { id: AGENT_ENTRY_ID, updatedAtMs: 700 },
            { id: AGENT_ENTRY_ID, updatedAtMs: 200 },
            { id: 'other', updatedAtMs: null },
        ]);

        expect(index.get(AGENT_ENTRY_ID)).toBe(700);
        expect(index.has('other')).toBe(false);
    });
});
