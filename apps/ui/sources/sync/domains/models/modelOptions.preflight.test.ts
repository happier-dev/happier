import { describe, expect, it } from 'vitest';

import { getModelOptionsForAgentTypeOrPreflight } from './modelOptions';

describe('modelOptions preflight', () => {
    it('prefers preflight model list and always includes Default first', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'opencode',
            preflight: {
                availableModels: [
                    { id: 'model-a', name: 'Model A' },
                    { id: 'default', name: 'Default (Agent)' },
                    { id: 'model-b', name: 'Model B', description: 'desc' },
                    { id: 'model-a', name: 'Model A (dup)' },
                ],
                supportsFreeform: false,
            },
        });

        expect(out[0]).toEqual({ value: 'default', label: 'Default', description: '' });
        expect(out.some((o) => o.value === 'model-a')).toBe(true);
        expect(out.some((o) => o.value === 'model-b' && o.description === 'desc')).toBe(true);
        expect(out.filter((o) => o.value === 'model-a')).toHaveLength(1);
        expect(out.filter((o) => o.value === 'default')).toHaveLength(1);
    });

    it('drops malformed preflight entries and still keeps Default first', () => {
        const out = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'opencode',
            preflight: {
                availableModels: [
                    { id: 'default', name: 'Default (Agent)' },
                    { id: 'valid-1', name: 'Valid 1' },
                    { id: '', name: 'Invalid empty id' },
                    { id: 'valid-2', name: 'Valid 2', description: 'desc-2' },
                    { id: 123 as unknown as string, name: 'Invalid non-string id' },
                    { id: 'missing-name', name: undefined as unknown as string },
                ],
                supportsFreeform: true,
            },
        });

        expect(out[0]).toEqual({ value: 'default', label: 'Default', description: '' });
        expect(out.some((opt) => opt.value === 'valid-1')).toBe(true);
        expect(out.some((opt) => opt.value === 'valid-2' && opt.description === 'desc-2')).toBe(true);
        expect(out.some((opt) => opt.value === '' && opt.label === 'Invalid empty id')).toBe(true);
        expect(out.some((opt) => opt.value === 'missing-name')).toBe(false);
    });
});
