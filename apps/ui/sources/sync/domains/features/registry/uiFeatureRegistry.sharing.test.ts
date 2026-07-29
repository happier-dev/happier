import { describe, expect, it } from 'vitest';

import {
    getUiFeatureDefinition,
    shouldTrackUiFeatureEffective,
    shouldTrackUiFeaturePreference,
} from './uiFeatureRegistry';
import { listUiFeatureToggleDefinitions } from './uiFeatureToggles';

const SHARING_RUNTIME_FEATURE_IDS = [
    'sharing.session',
    'sharing.public',
    'sharing.contentKeys',
    'sharing.pendingQueueV2',
    'sharing.pendingDeliveryState',
] as const;

describe('UI sharing feature registry', () => {
    it('registers sharing runtime feature ids as runtime-only UI features', () => {
        for (const featureId of SHARING_RUNTIME_FEATURE_IDS) {
            expect(getUiFeatureDefinition(featureId).settingsToggle).toBeUndefined();
        }
    });

    it('does not expose sharing runtime feature ids as independent settings toggles', () => {
        const toggleIds = new Set(listUiFeatureToggleDefinitions().map((definition) => definition.featureId));

        for (const featureId of SHARING_RUNTIME_FEATURE_IDS) {
            expect(toggleIds.has(featureId)).toBe(false);
            expect(shouldTrackUiFeaturePreference(featureId)).toBe(false);
            expect(shouldTrackUiFeatureEffective(featureId)).toBe(true);
        }
    });
});
