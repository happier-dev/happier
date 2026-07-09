import { describe, expect, it } from 'vitest';

import { sanitizeNewSessionConfigOverridesForModelSelection } from './newSessionConfigOptionOverrideSanitization';

describe('sanitizeNewSessionConfigOverridesForModelSelection', () => {
    it('preserves base model scoped overrides when the selected model is an effective bracket variant', () => {
        expect(sanitizeNewSessionConfigOverridesForModelSelection({
            providerId: 'claude',
            configOptions: [],
            modelOptions: [{
                value: 'claude-sonnet-4-6',
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
