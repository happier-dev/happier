import { describe, expect, it } from 'vitest';

import { resolveAutomationsFeature } from './automationsFeature';

describe('resolveAutomationsFeature', () => {
    it('defaults to automations enabled and existing-session target disabled', () => {
        const feature = resolveAutomationsFeature({} as NodeJS.ProcessEnv);

        expect(feature.automations).toEqual({
            enabled: true,
            existingSessionTarget: false,
        });
    });

    it('reads env overrides', () => {
        const feature = resolveAutomationsFeature({
            HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0',
            HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: '1',
        } as NodeJS.ProcessEnv);

        expect(feature.automations).toEqual({
            enabled: false,
            existingSessionTarget: true,
        });
    });
});
