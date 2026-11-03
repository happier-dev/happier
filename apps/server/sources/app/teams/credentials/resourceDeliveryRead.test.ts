import { describe, expect, it } from 'vitest';
import { readTeamCredentialDeliveryConfiguration } from './resourceDeliveryRead';

describe('retained Team delivery configuration', () => {
    it('reads old Team confirmation records as unused and retains disclosure policy', () => {
        const policy = { preferredAllowedModes: ['brokered', 'direct'] };
        expect(readTeamCredentialDeliveryConfiguration(JSON.stringify({ policy,
            experimentalBindingConfirmations: [{ v: 1, connectionId: 'gateway', sourceRevision: 'source-current',
                agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model',
                compatibilityFingerprint: 'compatibility:v1:reviewed', confirmedAt: 1 }],
        }))).toEqual({ success: true, data: { policy } });
        expect(readTeamCredentialDeliveryConfiguration(JSON.stringify({ policy }))).toEqual({ success: true, data: { policy } });
        expect(readTeamCredentialDeliveryConfiguration('brokered_only')).toEqual({ success: true,
            data: { policy: { preferredAllowedModes: ['brokered'] } } });
    });
});
