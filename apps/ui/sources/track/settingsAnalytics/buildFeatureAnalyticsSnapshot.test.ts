import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { buildFeatureAnalyticsSnapshot } from './buildFeatureAnalyticsSnapshot';

describe('buildFeatureAnalyticsSnapshot', () => {
    it('tracks both preference and effective state for settings-toggle features', () => {
        const snapshot = buildFeatureAnalyticsSnapshot({
            settings: {
                ...settingsDefaults,
                experiments: true,
                featureToggles: { voice: true },
            },
            mainSelectionSnapshot: {
                status: 'ready',
                serverIds: [],
                snapshotsByServerId: {},
            },
        });

        expect(snapshot.properties.feature_pref__voice).toBe(true);
        expect(snapshot.properties.feature_effective__voice).toBe(true);
    });

    it('tracks effective state for server-represented features without a preference toggle', () => {
        const snapshot = buildFeatureAnalyticsSnapshot({
            settings: settingsDefaults,
            mainSelectionSnapshot: {
                status: 'ready',
                serverIds: [],
                snapshotsByServerId: {},
            },
        });

        expect(snapshot.properties).toHaveProperty('feature_effective__voice.happierVoice');
        expect(snapshot.properties).not.toHaveProperty('feature_pref__voice.happierVoice');
    });
});
