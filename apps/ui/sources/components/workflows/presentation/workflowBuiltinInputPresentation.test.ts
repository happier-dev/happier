import { describe, expect, it } from 'vitest';

import { resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/builtins/catalog';

import { listWorkflowPersonInputs, resolveWorkflowBuiltinInputPresentation } from './workflowBuiltinInputPresentation';

describe('built-in workflow input presentation', () => {
    it('gives collaboration inputs human-readable labels through the shared presentation owner', () => {
        const inputsByWorkflow = {
            'builtin:parallel-implementations': ['request', 'first', 'second', 'third'],
            'builtin:fresh-opinions': ['question', 'participants', 'synthesis', 'synthesizer', 'previousRoundContext'],
            'builtin:answer-and-review': ['question', 'answerer', 'reviewer'],
            'builtin:debate': ['question', 'participants', 'rounds', 'digestAuthor', 'previousRoundContext'],
            'builtin:plan-with-a-panel': ['request', 'engines', 'participants', 'previousRoundContext'],
            'builtin:review-and-converge': ['engines', 'maxRounds', 'apply', 'reviewSession', 'useJudge', 'focus'],
        };

        for (const [workflow, inputs] of Object.entries(inputsByWorkflow)) {
            const presentation = resolveWorkflowBuiltinInputPresentation(workflow);
            expect(presentation, workflow).toBeDefined();
            for (const input of inputs) {
                expect(presentation?.[input]?.title, `${workflow}.${input}`).toEqual(expect.any(String));
                expect(presentation?.[input]?.title.trim(), `${workflow}.${input}`).not.toBe('');
                expect(presentation?.[input]?.title, `${workflow}.${input}`).not.toBe(input);
                expect(presentation?.[input]?.title, `${workflow}.${input}`).not.toContain('workflows.builtins.');
            }
        }
    });

    it('keeps authored workflows outside built-in localization', () => {
        expect(resolveWorkflowBuiltinInputPresentation('plugin:example/custom')).toBeUndefined();
        expect(resolveWorkflowBuiltinInputPresentation(null)).toBeUndefined();
    });
    it('never asks a person for an input the host binds, for any built-in', () => {
        const hostBound = ['triggerId', 'diffFingerprint', 'previousRoundContext'];
        for (const id of ['keep-going', 'review-and-converge', 'plan-with-a-panel', 'open-a-pull-request']) {
            const inputs = resolveBuiltinWorkflowDefinitionV1(id)!.definition.inputs;
            expect(listWorkflowPersonInputs(inputs).map((input) => input.name), id)
                .toEqual(inputs.map((input) => input.name).filter((name) => !hostBound.includes(name)));
        }
        // A required input stays askable whatever its name: a form never hides what it needs to start.
        const required = [{ name: 'triggerId', valueType: 'string' as const, required: true }];
        expect(listWorkflowPersonInputs(required)).toEqual(required);
    });
});
