import { describe, expect, it } from 'vitest';

import { resolveAutomationsFeature } from './automationsFeature';

describe('resolveAutomationsFeature', () => {
    it('defaults to automations enabled and existing-session target disabled', () => {
        const feature = resolveAutomationsFeature({} as NodeJS.ProcessEnv);

        expect(feature.features?.automations).toEqual({
            enabled: true,
            existingSessionTarget: { enabled: false },
        });
    });

    it('reads existing-session targeting flag from env', () => {
        const feature = resolveAutomationsFeature({
            HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: '1',
        } as NodeJS.ProcessEnv);

        expect(feature.features?.automations).toEqual({
            enabled: true,
            existingSessionTarget: { enabled: true },
        });
    });

    it('does not couple existing-session targeting to automations enablement in the resolver output', () => {
        const feature = resolveAutomationsFeature({
            HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0',
            HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: '1',
        } as NodeJS.ProcessEnv);

        expect(feature.features?.automations).toEqual({
            enabled: false,
            existingSessionTarget: { enabled: true },
        });
    });
});
