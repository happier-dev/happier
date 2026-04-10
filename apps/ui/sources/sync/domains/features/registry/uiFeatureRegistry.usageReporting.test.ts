import { describe, expect, it } from 'vitest';

import { getUiFeatureDefinition } from './uiFeatureRegistry';

describe('uiFeatureRegistry usage reporting', () => {
    it('registers usage reporting as a shipped settings feature', () => {
        const usageReporting = getUiFeatureDefinition('usage.reporting');

        expect(usageReporting.settingsToggle?.showInSettings).toBe(true);
        expect(usageReporting.settingsToggle?.isExperimental).toBe(false);
        expect(usageReporting.settingsToggle?.defaultEnabled).toBe(true);
        expect(usageReporting.settingsToggle?.titleKey).toBe('settingsFeatures.expUsageReporting');
        expect(usageReporting.settingsToggle?.subtitleKey).toBe('settingsFeatures.expUsageReportingSubtitle');
    });
});
