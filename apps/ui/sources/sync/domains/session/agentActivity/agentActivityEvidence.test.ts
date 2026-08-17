import { describe, expect, it } from 'vitest';

import {
    buildAgentActivityEvidenceIndex,
    resolveAgentActivityEvidenceAtMs,
} from './agentActivityEvidence';

describe('buildAgentActivityEvidenceIndex', () => {
    it('keeps the later of two observations for one entry', () => {
        const index = buildAgentActivityEvidenceIndex([
            { id: 'workflow_agent:wf_1:a1', updatedAtMs: 4_000 },
            { id: 'workflow_agent:wf_1:a1', updatedAtMs: 9_000 },
            { id: 'workflow_agent:wf_1:a1', updatedAtMs: 1_000 },
        ]);

        expect(index.get('workflow_agent:wf_1:a1')).toBe(9_000);
    });

    it('never fabricates an instant for an entry nothing was observed about', () => {
        const index = buildAgentActivityEvidenceIndex([
            { id: 'workflow_run:wf_1', updatedAtMs: null },
            { id: 'workflow_run:wf_2' },
            { id: 'workflow_run:wf_3', updatedAtMs: Number.NaN },
        ]);

        expect(index.size).toBe(0);
        expect(resolveAgentActivityEvidenceAtMs({
            entryId: 'workflow_run:wf_1',
            evidenceAtMsById: index,
        })).toBeNull();
    });
});

describe('resolveAgentActivityEvidenceAtMs', () => {
    it('takes the later of the index and a durable record the caller holds', () => {
        const index = buildAgentActivityEvidenceIndex([{ id: 'workflow_run:wf_1', updatedAtMs: 4_000 }]);

        expect(resolveAgentActivityEvidenceAtMs({
            entryId: 'workflow_run:wf_1',
            evidenceAtMsById: index,
            recordUpdatedAtMs: 9_000,
        })).toBe(9_000);
        expect(resolveAgentActivityEvidenceAtMs({
            entryId: 'workflow_run:wf_1',
            evidenceAtMsById: index,
            recordUpdatedAtMs: 1_000,
        })).toBe(4_000);
    });

    it('answers with whichever side has evidence when the other has none', () => {
        const index = buildAgentActivityEvidenceIndex([{ id: 'workflow_run:wf_1', updatedAtMs: 4_000 }]);

        expect(resolveAgentActivityEvidenceAtMs({
            entryId: 'workflow_run:wf_1',
            evidenceAtMsById: index,
            recordUpdatedAtMs: null,
        })).toBe(4_000);
        expect(resolveAgentActivityEvidenceAtMs({
            entryId: 'workflow_run:unknown',
            evidenceAtMsById: index,
            recordUpdatedAtMs: 7_000,
        })).toBe(7_000);
    });
});
