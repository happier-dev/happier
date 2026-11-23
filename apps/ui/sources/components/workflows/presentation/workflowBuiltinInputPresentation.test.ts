import { describe, expect, it } from 'vitest';

import { resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/builtins/catalog';

import { listWorkflowPersonInputs, resolveWorkflowInputTitle } from './workflowBuiltinInputPresentation';

describe('built-in workflow input presentation', () => {
    it('renders the collaboration copy from the built-in input declarations', () => {
        const panel = resolveBuiltinWorkflowDefinitionV1('plan-with-a-panel')!.definition;
        const opinions = resolveBuiltinWorkflowDefinitionV1('fresh-opinions')!.definition;
        expect(resolveWorkflowInputTitle(panel.inputs.find(input => input.name === 'engines')!)).toBe('Planners');
        expect(resolveWorkflowInputTitle(opinions.inputs.find(input => input.name === 'synthesis')!)).toBe('Summarize the answers');
    });

    it('shows an authored text input even when its name matches the JSON replay binding', () => {
        const inputs = [{ name: 'previousRoundContext', valueType: 'string' as const, required: false }];
        expect(listWorkflowPersonInputs(inputs)).toEqual(inputs);
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
