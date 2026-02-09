import { describe, expect, it, vi } from 'vitest';

describe('modelOptions i18n', () => {
    it('uses translation lookup for default option labels', async () => {
        vi.resetModules();
        vi.doMock('@/text', () => ({
            t: (key: string) => `tx:${key}`,
        }));

        const { getModelOptionsForAgentType } = await import('./modelOptions');
        const options = getModelOptionsForAgentType('gemini');
        const defaultOption = options.find((opt) => opt.value === 'default');

        expect(defaultOption?.label).toBe('tx:agentInput.permissionMode.default');
    });
});
