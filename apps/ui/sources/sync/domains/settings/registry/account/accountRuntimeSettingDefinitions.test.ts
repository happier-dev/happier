import { ACCOUNT_SETTING_ARTIFACTS } from '@happier-dev/protocol/account/settings/accountSettings';
import { describe, expect, it } from 'vitest';

describe('Account runtime settings analytics presentation', () => {
    it('attaches count-only peer mediation analytics to the canonical Protocol definition without re-declaring persistence', async () => {
        const { ACCOUNT_SETTING_ANALYTICS } = await import('./accountSettingAnalytics');

        expect(ACCOUNT_SETTING_ANALYTICS.peerMediationPreferencesV1).toEqual(expect.objectContaining({
            privacy: 'count_only',
            valueKind: 'count',
            identityScope: 'person',
        }));

        const parsed = ACCOUNT_SETTING_ARTIFACTS.shape.peerMediationPreferencesV1.parse({
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
        expect(ACCOUNT_SETTING_ANALYTICS.peerMediationPreferencesV1).not.toHaveProperty('schema');
        expect(ACCOUNT_SETTING_ANALYTICS.peerMediationPreferencesV1).not.toHaveProperty('default');
        expect(ACCOUNT_SETTING_ANALYTICS.peerMediationPreferencesV1).not.toHaveProperty('storageScope');
    });

    it('excludes transferred execution guidance from preference parsing and analytics', async () => {
        const { ACCOUNT_SETTING_ANALYTICS } = await import('./accountSettingAnalytics');
        const { settingsParse } = await import('../../settings');

        const parsed = settingsParse({ executionRunsGuidanceEntries: [
            {
                id: 'guidance_1',
                description: 'Prefer the provider-universe backend target',
                enabled: true,
                suggestedBackendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
                suggestedIntent: 'review',
            },
        ] });

        expect(parsed).not.toHaveProperty('executionRunsGuidanceEntries');
        expect(ACCOUNT_SETTING_ARTIFACTS.shape).not.toHaveProperty('executionRunsGuidanceEntries');
        expect(ACCOUNT_SETTING_ANALYTICS).not.toHaveProperty('executionRunsGuidanceEntries');
    });
});
