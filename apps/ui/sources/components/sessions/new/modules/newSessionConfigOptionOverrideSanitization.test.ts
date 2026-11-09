import { describe, expect, it } from 'vitest';

import { sanitizeNewSessionConfigOverridesForModelSelection } from './newSessionConfigOptionOverrideSanitization';

describe('sanitizeNewSessionConfigOverridesForModelSelection', () => {
    it('validates scoped intent against the selected descriptor rather than the full raw config catalog', () => {
        const effort = { id: 'effort', name: 'Thinking', type: 'select', currentValue: 'auto',
            options: [{ value: 'auto', name: 'Auto' }, { value: 'ultra', name: 'Ultra' }] };
        const input = { providerId: 'external', configOptions: [effort],
            modelOptions: [
                { value: 'shared-model', modelOptions: [{ ...effort, options: [{ value: 'auto', name: 'Auto' }] }] },
                { value: 'other-model' },
            ], selectedConfigOverrides: { effort: 'ultra' } };
        expect(sanitizeNewSessionConfigOverridesForModelSelection({ ...input, selectedModelId: 'shared-model' })).toEqual({});
        expect(sanitizeNewSessionConfigOverridesForModelSelection({ ...input, selectedModelId: 'other-model' })).toEqual({});
    });

    it('rolls back only the matching rejected standalone draft while retaining scoped and newer intent', () => {
        const effort = { id: 'effort', name: 'Effort', type: 'select', currentValue: 'auto', options: [{ value: 'auto', name: 'Auto' }, { value: 'ultra', name: 'Ultra' }] };
        const input = { providerId: 'external', configOptions: [
            { id: 'provider', name: 'Provider', type: 'select', currentValue: 'codex', options: [{ value: 'codex', name: 'Codex' }, { value: 'gateway', name: 'Gateway' }, { value: 'grok', name: 'Grok' }] }, effort,
        ], modelOptions: [{ value: 'native', modelOptions: [effort] }], selectedModelId: 'native',
        rejectedConfigOptionOverrides: { provider: 'gateway', effort: 'ultra' } };
        expect(sanitizeNewSessionConfigOverridesForModelSelection({ ...input,
            selectedConfigOverrides: { provider: 'gateway', effort: 'ultra' } })).toEqual({ effort: 'ultra' });
        expect(sanitizeNewSessionConfigOverridesForModelSelection({ ...input,
            selectedConfigOverrides: { provider: 'grok', effort: 'ultra' } })).toEqual({ provider: 'grok', effort: 'ultra' });
    });
    it('preserves opaque config ids and empty scalar choices in a new-session draft', () => {
        expect(sanitizeNewSessionConfigOverridesForModelSelection({
            providerId: 'external',
            configOptions: [{ id: ' format ', name: 'Format', type: 'select', currentValue: ' ',
                options: [{ value: '', name: 'Default' }, { value: ' ', name: 'Space' }] }],
            modelOptions: [], selectedModelId: 'default', selectedConfigOverrides: { ' format ': '' },
        })).toEqual({ ' format ': '' });
    });

    it('validates source-model intent against its descriptor when a native model has the same id', () => {
        const option = (value: string) => ({ id: 'reasoning_effort', name: 'Thinking', type: 'select',
            currentValue: value, options: [{ value, name: value }] });
        const input = { providerId: 'codex', configOptions: [],
            modelOptions: [{ value: 'shared-model', modelOptions: [option('high')] }],
            selectedModelId: 'shared-model', selectedModelConfigOptions: [option('max')] };
        expect(sanitizeNewSessionConfigOverridesForModelSelection({ ...input,
            selectedConfigOverrides: { reasoning_effort: 'max' } })).toEqual({ reasoning_effort: 'max' });
        expect(sanitizeNewSessionConfigOverridesForModelSelection({ ...input,
            selectedConfigOverrides: { reasoning_effort: 'high' } })).toEqual({});
        expect(sanitizeNewSessionConfigOverridesForModelSelection({ ...input,
            selectedModelConfigOptions: [], selectedConfigOverrides: { reasoning_effort: 'high' } })).toEqual({});
    });
    it('preserves base model scoped overrides when the selected model is its declared extended-context variant', () => {
        expect(sanitizeNewSessionConfigOverridesForModelSelection({
            providerId: 'claude',
            configOptions: [],
            modelOptions: [{
                value: 'claude-sonnet-4-6',
                extendedContextModelId: 'claude-sonnet-4-6[1m]',
                modelOptions: [{
                    id: 'reasoning_effort',
                    name: 'Reasoning effort',
                    type: 'select',
                    currentValue: 'medium',
                    options: [
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                    ],
                }],
            }],
            selectedModelId: 'claude-sonnet-4-6[1m]',
            selectedConfigOverrides: {
                reasoning_effort: 'high',
            },
        })).toEqual({
            reasoning_effort: 'high',
        });
    });
});
