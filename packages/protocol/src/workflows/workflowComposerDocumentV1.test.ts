import { describe, expect, it } from 'vitest';
import { formatInlineReferenceTokenV1, scanInlineReferenceTokensV1 } from '../runtime/input/inlineReferenceTokenV1.js';
import { MENTION_KIND_V1 } from '../runtime/input/mentionRefV1.js';
import type { WorkflowStep } from './workflowV1.js';
import { removeWorkflowStepInputV1 } from './workflowComposerDocumentV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';

describe('workflow prompt input bindings', () => {
    it('reindexes surviving tokens and leaves a removed binding invalid even after another input is added', () => {
        const references = ['Topic', 'Version'].map((label, index) => {
            const reference = { kind: MENTION_KIND_V1.workflowInput, ref: `workflowInput:${index}`, label };
            return { ...reference, token: formatInlineReferenceTokenV1(reference) };
        });
        const step: WorkflowStep = {
            kind: 'step', id: 'write', input: [{ kind: 'literal', value: 'topic' }, { kind: 'literal', value: 'version' }],
            document: { text: references.map(reference => reference.token).join(' and '), references, attachments: [] },
            result: { kind: 'text' },
        };
        const removed = removeWorkflowStepInputV1(step, 0);
        expect(removed.input).toEqual([{ kind: 'literal', value: 'version' }]);
        expect(removed.document.references[1]).toMatchObject({ label: 'Version', ref: 'workflowInput:0' });
        expect(scanInlineReferenceTokensV1(removed.document.text)).toMatchObject(removed.document.references.map(({ label, ref }) => ({ label, ref })));
        const validation = validateWorkflowDefinition({ version: 1, inputs: [], defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
            blocks: [{ ...removed, input: [...removed.input, { kind: 'literal', value: 'another value' }] }] });
        expect(validation.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'invalid_input', path: '/blocks/0/document/references/0/ref' }),
        ]));
    });
});
