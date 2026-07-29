import { describe, expect, it } from 'vitest';

import { getUiFeatureDefinition } from './uiFeatureRegistry';

describe('provider feature registry', () => {
    it('registers server-owned provider gates without creating competing local settings toggles', () => {
        for (const featureId of [
            'providers',
            'providers.localDiscovery',
            'providers.localModelManagement',
        ] as const) {
            expect(getUiFeatureDefinition(featureId).settingsToggle).toBeUndefined();
        }
    });
});
