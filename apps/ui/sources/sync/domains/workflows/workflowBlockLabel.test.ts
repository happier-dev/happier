import { describe, expect, it } from 'vitest';

import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { workflowStepPromptLabel } from '@happier-dev/protocol/workflows';
import { workflowBlockReferenceLabel, workflowDefinitionPromptTitle } from './workflowBlockLabel';
import { t } from '@/text';

const AGENT_TARGET = {
    kind: 'agent' as const,
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

describe('workflowBlockLabel', () => {
    it('names document blocks by their human kind rather than opaque ids or a clipped prompt', () => {
        expect(workflowBlockReferenceLabel({ kind: 'step', id: 'action-1', document: {
            text: 'Check the supplied goal and most recent turn. Return progress with evidence rather than guessing.',
            references: [], attachments: [],
        }, input: [], result: { kind: 'text' } })).toBe(t('workflows.editor.addStep'));
        expect(workflowBlockReferenceLabel({ kind: 'if', id: 'condition-2', when: { kind: 'exists', value: { kind: 'literal', value: true } }, then: [], otherwise: [] }))
            .toBe(t('workflows.editor.addIf'));
        expect(workflowBlockReferenceLabel({ kind: 'loop', id: 'loop-1', body: [], repetition: { kind: 'count', count: { kind: 'literal', value: 2 } } }))
            .toBe(t('workflows.editor.addLoop'));
    });
    it('derives a frozen definition title only from its first authored prompt in reading order', () => {
        const step = {
            kind: 'step' as const,
            id: 'analyze',
            document: { text: '\n  Review the release changes  \nmore detail', references: [], attachments: [] },
            input: [],
            result: { kind: 'text' as const },
        };
        const definition: WorkflowDefinitionV1 = {
            version: 1,
            inputs: [],
            defaults: { agentTarget: AGENT_TARGET },
            blocks: [{
                kind: 'parallel',
                id: 'parallel',
                failurePolicy: 'fail_stop',
                branches: [{
                    id: 'first',
                    blocks: [step],
                }],
            }],
        };

        expect(workflowDefinitionPromptTitle(definition)).toBe('Review the release changes');
        expect(workflowStepPromptLabel(step)).toBe('Review the release changes');
    });
});
