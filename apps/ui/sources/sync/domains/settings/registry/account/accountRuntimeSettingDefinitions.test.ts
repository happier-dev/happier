import { describe, expect, it, vi } from 'vitest';

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/agents')>();
    return {
        ...actual,
        getAllProviderDefinitions: () => [
            ...actual.getAllProviderDefinitions(),
            { id: 'acme.review.backend' },
        ],
    };
});

describe('ACCOUNT_RUNTIME_SETTING_DEFINITIONS', () => {
    it('accepts execution-run guidance entries for provider-universe built-in backend targets', async () => {
        vi.resetModules();
        const { ACCOUNT_RUNTIME_SETTING_ARTIFACTS } = await import('./accountRuntimeSettingDefinitions');

        const parsed = ACCOUNT_RUNTIME_SETTING_ARTIFACTS.shape.executionRunsGuidanceEntries.safeParse([
            {
                id: 'guidance_1',
                description: 'Prefer the provider-universe backend target',
                enabled: true,
                suggestedBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                suggestedIntent: 'review',
            },
        ]);

        expect(parsed.success).toBe(true);
        expect(parsed.success ? parsed.data : null).toEqual([
            expect.objectContaining({
                suggestedBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                suggestedIntent: 'review',
            }),
        ]);
    });

    it('rejects unknown built-in backend targets that are outside the provider universe', async () => {
        vi.resetModules();
        const { ACCOUNT_RUNTIME_SETTING_ARTIFACTS } = await import('./accountRuntimeSettingDefinitions');

        const parsed = ACCOUNT_RUNTIME_SETTING_ARTIFACTS.shape.executionRunsGuidanceEntries.safeParse([
            {
                id: 'guidance_2',
                description: 'Drop unknown built-in backend targets',
                enabled: true,
                suggestedBackendTarget: { kind: 'backend', backendId: 'not-a-real-agent' },
            },
        ]);

        expect(parsed.success).toBe(false);
    });
});
