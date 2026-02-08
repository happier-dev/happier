import { describe, expect, it } from 'vitest';

describe('vitest integration config', () => {
    it('does not exclude integration patterns inherited from unit config', async () => {
        const module = await import('../../vitest.integration.config');
        const testConfig = (module.default as any)?.test ?? {};

        expect(testConfig.exclude ?? []).toEqual([]);
    });
});
