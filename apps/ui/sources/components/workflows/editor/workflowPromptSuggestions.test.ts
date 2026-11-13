import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { createWorkflowPromptSuggestions, resolveWorkflowPromptReferenceStates } from './workflowPromptSuggestions';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

describe('workflow prompt picker', () => {
    it('projects the validator’s moved and removed producer facts onto the same prompt token', () => {
        const previous: WorkflowStep = { kind: 'step', id: 'analyze', name: 'Analysis',
            document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' } };
        const step: WorkflowStep = { kind: 'step', id: 'review',
            document: { text: 'Review @analysis', references: [{ kind: 'happier.workflowInput', ref: 'workflowInput:0', token: '@analysis' }], attachments: [] },
            input: [{ kind: 'result', producer: { blockId: 'analyze', scope: { kind: 'current' } }, path: [] }], result: { kind: 'text' } };
        const statesFor = (blocks: WorkflowStep[]) => {
            const draft = createWorkflowEditorDraft({ draftId: 'token-state', blocks });
            return resolveWorkflowPromptReferenceStates(step, validateWorkflowEditorDraft(draft).issues);
        };
        expect(statesFor([previous, step])).toBeUndefined();
        expect(statesFor([step, previous])?.get('workflowInput:0')).toBe('unavailable');
        expect(statesFor([step])?.get('workflowInput:0')).toBe('removed');
    });
    /** Only a reference mention carries an open ref; skill and vendor mentions do not. */
    const refOf = (input: Readonly<object> | undefined) => input && 'ref' in input ? input.ref : undefined;
    it('binds a prior result on selection and reuses the same binding for another token', async () => {
        const previous: WorkflowStep = { kind: 'step', id: 'analyze', name: 'Analysis',
            document: { text: 'Analyze', references: [], attachments: [] }, input: [], result: { kind: 'text' } };
        const step: WorkflowStep = { ...previous, id: 'review', name: 'Review', input: [] };
        const draft = createWorkflowEditorDraft({ draftId: 'tokens', blocks: [previous, step] });
        const change = vi.fn();
        const suggestions = createWorkflowPromptSuggestions({ draft, step, query: '@', onChangeInput: change });
        const result = suggestions.find(row => refOf(row.structuredInput) === 'workflowInput:0');
        expect(result?.label).toContain('Analysis');
        expect(result?.structuredInput?.kind).toBe('happier.workflowInput');
        expect(change).not.toHaveBeenCalled();
        await expect(result?.selectionEffect?.()).resolves.toEqual({ ok: true });
        const binding = { kind: 'result', producer: { blockId: 'analyze', scope: { kind: 'current' } }, path: [] } satisfies WorkflowValueReference;
        expect(change).toHaveBeenCalledWith([binding]);
        change.mockClear();
        const existing = createWorkflowPromptSuggestions({ draft, step: { ...step, input: [binding] }, query: '@analysis', onChangeInput: change });
        expect(refOf(existing[0]?.structuredInput)).toBe('workflowInput:0');
        await existing[0]?.selectionEffect?.();
        expect(change).not.toHaveBeenCalled();
    });
});
