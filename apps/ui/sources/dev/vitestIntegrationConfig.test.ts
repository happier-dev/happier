import { describe, expect, it } from 'vitest';

describe('vitest integration config', () => {
    it('excludes only integration patterns delegated to their dedicated native lane', async () => {
        const module = await import('../../vitest.integration.config');
        const testConfig = (module.default as any)?.test ?? {};

        expect(testConfig.exclude ?? []).toContain(module.NATIVE_LEGEND_INTEGRATION_INCLUDE_GLOB);
        expect(testConfig.exclude ?? []).not.toContain('sources/**/*.integration.test.{ts,tsx}');
        expect(testConfig.exclude ?? []).not.toContain('sources/**/*.real.integration.test.{ts,tsx}');
        expect(testConfig.exclude ?? []).not.toContain('sources/**/*.integration.spec.{ts,tsx}');
    });
});
