import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/protocol';
import { WorkflowRunAcceptedContextV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { deriveWorkflowReplacementId } from '@happier-dev/protocol/workflows';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

import {
    buildWorkflowPlanReviewSeed,
    deriveWorkflowPlanRunId,
    readWorkflowPlanResult,
} from './workflowPlanReview';

const run = createWorkflowRunSummaryFixture({ id: 'plan-run-1', origin: { kind: 'direct' }, state: 'waiting_for_review', revision: 3 });
const acceptedContext = WorkflowRunAcceptedContextV1Schema.parse({
    startedBy: 'user',
    frozenChildren: {},
    source: { kind: 'inline' }, inputs: { planningTopic: 'release' }, machineId: 'machine-1',
    metadata: { title: 'Planning workflow', description: 'The previous plan run' },
    executionTarget: { kind: 'session' },
    materializedLeaves: [{ sourceKey: '$root', blockId: 'step-1', kind: 'step', selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'detached_run' } }],
    workspaceTarget: { project: { machineId: 'machine-1', directory: 'C:\\work\\project', checkoutRootPath: 'C:\\work\\project' } },
    origin: { kind: 'direct' },
});

describe('workflow plan review', () => {
    it('uses the existing admission identity for rejoin and gives a new attempt its own Run', () => {
        const id = deriveWorkflowPlanRunId(run.id, 'held-attempt-1');
        expect(id).toBe(deriveWorkflowReplacementId(['workflow.review.plan_run', run.id, 'held-attempt-1']));
        expect(deriveWorkflowPlanRunId(run.id, 'held-attempt-1')).toBe(id);
        expect(deriveWorkflowPlanRunId(run.id, 'held-attempt-2')).not.toBe(id);
        expect(deriveWorkflowPlanRunId('another-plan-run', 'held-attempt-1')).not.toBe(id);
    });

    it('gives a changed proposal a stable own id independent of object key order', () => {
        const proposal = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'step', id: 'a',
            document: { text: 'Implement A', references: [], attachments: [] }, input: [] }] });
        const id = deriveWorkflowPlanRunId(run.id, 'held-attempt-1', proposal);
        expect(id).not.toBe(deriveWorkflowPlanRunId(run.id, 'held-attempt-1'));
        expect(deriveWorkflowPlanRunId(run.id, 'held-attempt-1', { blocks: proposal.blocks, defaults: proposal.defaults,
            inputs: proposal.inputs, version: 1 })).toBe(id);
        const changed = WorkflowDefinitionV1Schema.parse({ ...proposal, blocks: [{ kind: 'step', id: 'a',
            document: { text: 'Implement B', references: [], attachments: [] }, input: [] }] });
        expect(deriveWorkflowPlanRunId(run.id, 'held-attempt-1', changed)).not.toBe(id);
    });

    it('detects a Plan from its shown value without a built-in or step identity', () => {
        expect(readWorkflowPlanResult({ document: 'A plan', proposal: { blocks: ['Implement it'] } })).toEqual({ document: 'A plan', proposal: { blocks: ['Implement it'] } });
        expect(readWorkflowPlanResult({ document: 'Document only' })).toEqual({ document: 'Document only' });
        expect(readWorkflowPlanResult({ document: 1 })).toBeNull();
        expect(readWorkflowPlanResult(['A plan'])).toBeNull();
    });

    it('seeds the new proposal without pinning the old run graph, metadata or input names', () => {
        const proposal = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [{ name: 'task', valueType: 'string', required: false, default: 'implement' }], defaults: {}, blocks: [{ kind: 'step', id: 'step-1', document: { text: 'Implement the proposal', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] });
        const before = structuredClone(proposal);
        const seed = buildWorkflowPlanReviewSeed({ value: { document: 'Release plan' }, proposal, run, acceptedContext });
        expect(seed.definition).toEqual(proposal);
        expect(seed).toMatchObject({ name: 'Implement the proposal', project: acceptedContext.workspaceTarget.project, executionTarget: acceptedContext.executionTarget, inputs: {}, sourceRunId: run.id });
        expect(seed.description).toBeUndefined();
        expect(seed.supersededRunId).toBeUndefined();
        expect(seed.reasonCode).toBeUndefined();
        expect(proposal).toEqual(before);
        expect(acceptedContext.inputs).toEqual({ planningTopic: 'release' });
    });

    it('opens invalid proposals as a one-step Agent draft preserving the complete plan document', () => {
        const value: JsonValue = { document: 'First line\n\nSecond line with all the instructions.', proposal: { blocks: [] } };
        const before = structuredClone(value);
        const seed = buildWorkflowPlanReviewSeed({ value, proposal: null, run, acceptedContext });
        expect(seed.definition.blocks).toHaveLength(1);
        expect(seed.definition.blocks[0]).toMatchObject({ kind: 'step', document: { text: value.document, references: [], attachments: [] }, input: [], result: { kind: 'text' } });
        expect(seed.inputs).toEqual({});
        expect(seed.name).toBe('First line');
        expect(value).toEqual(before);
    });
});
