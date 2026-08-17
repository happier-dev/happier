import { describe, expect, it } from 'vitest';

import { listUiFeatureToggleDefinitions } from './uiFeatureToggles';

describe('UI Channels feature registry', () => {
    it('does not expose the retired channel bridge experimental toggle', () => {
        const toggleIds = new Set<string>(listUiFeatureToggleDefinitions().map((definition) => definition.featureId));

        expect(toggleIds.has('channelBridges')).toBe(false);
    });
});
