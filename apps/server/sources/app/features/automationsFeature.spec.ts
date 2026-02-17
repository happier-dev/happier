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

    it('enables existing-session targeting only when automations are enabled', () => {
        const feature = resolveAutomationsFeature({
            HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: '1',
        } as NodeJS.ProcessEnv);

        expect(feature.automations).toEqual({
            existingSessionTarget: true,
            enabled: true,
        });

        const disabled = resolveAutomationsFeature({
            HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0',
            HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: '1',
        } as NodeJS.ProcessEnv);

        expect(disabled.automations).toEqual({
            enabled: false,
            existingSessionTarget: false,
        });
    });

    it('hard-disables automations when build policy denies the feature', () => {
        const feature = resolveAutomationsFeature({
            HAPPIER_BUILD_FEATURES_DENY: 'automations',
            HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
            HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: '1',
        } as NodeJS.ProcessEnv);

        expect(feature.automations).toEqual({
            enabled: false,
            existingSessionTarget: false,
        });
    });

    it('hard-disables existing-session targeting when build policy denies the sub-feature', () => {
        const feature = resolveAutomationsFeature({
            HAPPIER_BUILD_FEATURES_DENY: 'automations.existingSessionTarget',
            HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
            HAPPIER_FEATURE_AUTOMATIONS__EXISTING_SESSION_TARGET: '1',
        } as NodeJS.ProcessEnv);

        expect(feature.automations).toEqual({
            enabled: true,
            existingSessionTarget: false,
        });
    });
});
