import { describe, expect, it, vi } from 'vitest';

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/agents')>();
    return {
        ...actual,
        getAllAgentCatalogDefinitions: () => [
            ...actual.getAllAgentCatalogDefinitions(),
            { id: 'acme.review.backend' },
        ],
    };
});

describe('ACCOUNT_RUNTIME_SETTING_DEFINITIONS', () => {
    it('defines peer mediation preferences as account-scoped count-only metadata', async () => {
        vi.resetModules();
        const { ACCOUNT_RUNTIME_SETTING_DEFINITIONS, ACCOUNT_RUNTIME_SETTING_ARTIFACTS } = await import('./accountRuntimeSettingDefinitions');

        expect(ACCOUNT_RUNTIME_SETTING_DEFINITIONS.peerMediationPreferencesV1.storageScope).toBe('account');
        expect(ACCOUNT_RUNTIME_SETTING_DEFINITIONS.peerMediationPreferencesV1.analytics).toEqual(expect.objectContaining({
            privacy: 'count_only',
            valueKind: 'count',
            identityScope: 'person',
        }));

        const parsed = ACCOUNT_RUNTIME_SETTING_ARTIFACTS.shape.peerMediationPreferencesV1.parse({
            v: 1,
            flows: {
                bounded_transfer: { direct: 'enabled' },
            },
            byMachineId: {
                machine_1: {
                    flows: {
                        tcp_tunnel: { direct: 'disabled' },
                    },
                },
            },
        });

        expect(parsed.byMachineId.machine_1?.flows?.tcp_tunnel?.direct).toBe('disabled');
    });

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
