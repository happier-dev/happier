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
            const asked = listWorkflowPersonInputs(inputs).map((input) => input.name);
            expect(asked.filter((name) => hostBound.includes(name)), id).toEqual([]);
            // Whatever Start needs a person for stays asked.
            expect(asked, id).toEqual(expect.arrayContaining(inputs
                .filter((input) => input.required && input.default === undefined && input.defaultFrom === undefined).map((input) => input.name)));
        }
        // A required input stays askable whatever its name: a form never hides what it needs to start.
        const required = [{ name: 'triggerId', valueType: 'string' as const, required: true }];
        expect(listWorkflowPersonInputs(required)).toEqual(required);
    });

    it('never offers a structured value it cannot present, unless Start needs it (FIN-DESIGN-ACCEPT-9 X2)', () => {
        const optional = { name: 'steps', valueType: 'json' as const, required: false };
        const requiredWithDefault = { name: 'reviewers', valueType: 'json' as const, required: true, default: [] };
        const requiredWithoutDefault = { name: 'reviewers', valueType: 'json' as const, required: true };
        const presented = { name: 'reviewSession', valueType: 'json' as const, required: false, inputType: { hostType: 'session' as const } };
        const titled = { name: 'targets', valueType: 'json' as const, required: false, presentation: { title: 'Targets' } };
        expect(listWorkflowPersonInputs([optional, requiredWithDefault])).toEqual([]);
        expect(listWorkflowPersonInputs([requiredWithoutDefault, presented, titled])).toEqual([requiredWithoutDefault, presented, titled]);
        // Review changes asks for its Reviewers (required, no default) and leaves its Steps to Agents and saved definitions.
        const review = listWorkflowPersonInputs(resolveBuiltinWorkflowDefinitionV1('review-and-converge')!.definition.inputs).map((input) => input.name);
        expect(review).toContain('reviewers');
        expect(review).not.toContain('steps');
    });
});
