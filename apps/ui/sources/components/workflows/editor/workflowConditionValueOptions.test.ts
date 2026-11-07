import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { listWorkflowConditionValueOptions } from './workflowConditionValueOptions';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const step = (id: string): WorkflowStep => ({ kind: 'step', id, name: id,
    document: { text: id, references: [], attachments: [] }, input: [], result: { kind: 'text' } });

describe('workflow prompt reference scope', () => {
    it('offers prior results and inputs while explaining later and sibling-lane results', () => {
        const draft = { ...createWorkflowEditorDraft({ draftId: 'scope', name: 'Release', blocks: [
            step('gather'), { kind: 'parallel' as const, id: 'lanes', branches: [
                { id: 'docs', blocks: [step('write'), step('publish')] },
                { id: 'tests', blocks: [step('test')] },
            ] }, step('ship'),
        ] }), inputs: [{ name: 'version', valueType: 'string' as const, required: true }] };
        const options = listWorkflowConditionValueOptions(draft, 'publish', undefined, { includeUnavailable: true });
        expect(options).toEqual(expect.arrayContaining([
            expect.objectContaining({ reference: { kind: 'result', producer: { blockId: 'gather', scope: { kind: 'outer', levels: 1 } }, path: [] } }),
            expect.objectContaining({ reference: { kind: 'result', producer: { blockId: 'write', scope: { kind: 'current' } }, path: [] } }),
            expect.objectContaining({ reference: { kind: 'input', name: 'version' } }),
            expect.objectContaining({ reference: expect.objectContaining({ producer: expect.objectContaining({ blockId: 'test' }) }), unavailableReason: 'another_lane' }),
            expect.objectContaining({ reference: expect.objectContaining({ producer: expect.objectContaining({ blockId: 'ship' }) }), unavailableReason: 'runs_later' }),
        ]));
        const ordinary = listWorkflowConditionValueOptions(draft, 'publish');
        expect(ordinary.some(option => option.unavailableReason !== undefined)).toBe(false);
        expect(options.some(option => option.reference.kind === 'result' && option.reference.producer.blockId === 'publish')).toBe(false);
    });
});
