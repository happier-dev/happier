import { describe, expect, it } from 'vitest';
import { FEATURE_CATALOG, FEATURE_IDS, isFeatureServerRepresented, type FeatureId } from '@happier-dev/protocol/features/catalog';

// The server registry's feature family is the one list of Home feature keys; reading it here (it
// imports only the protocol and its own two modules) makes a new server key without a label fail
// this suite, with no second checked-in list to drift.
import { FEATURE_SERVER_CONFIG } from '../../../../../../server/sources/app/features/catalog/featureServerConfig';

import {
    homeFeatureDescriptionKey,
    homeFeatureSettingDescriptionKey,
    homeFeatureSettingTitleKey,
    homeFeatureTitleKey,
} from './homeFeatureLabels';
import { HOME_COMMON_FEATURE_IDS } from './homeFeatureRows';
import { homeFeatureTranslations } from '@/text/translations/homeFeatureTranslations';

/**
 * The console never shows a raw feature id (plan §3.8 "Labels"): every server feature, every
 * client feature a server feature can be blocked by, and every Advanced family carries a label.
 * A feature added to the catalog without one fails here rather than rendering its id.
 */
const SERVER_FEATURES = FEATURE_IDS.filter(isFeatureServerRepresented);

function hasGroupLabel(family: string): boolean {
    const node = (homeFeatureTranslations.en as Record<string, unknown>)[family];
    return typeof node === 'object' && node !== null && typeof (node as Record<string, unknown>).group === 'string';
}

describe('home feature labels', () => {
    it('labels every server feature and every dependency that can block one', () => {
        const blockers = new Set<FeatureId>(SERVER_FEATURES.flatMap((id) => FEATURE_CATALOG[id].dependencies));
        const missing = [...SERVER_FEATURES, ...blockers].filter(
            (id) => homeFeatureTitleKey(id) === null || homeFeatureDescriptionKey(id) === null,
        );
        expect(missing).toEqual([]);
    });

    it('labels every Advanced family that holds more than one feature', () => {
        const common = new Set<FeatureId>(HOME_COMMON_FEATURE_IDS);
        const sizes = new Map<string, number>();
        for (const id of SERVER_FEATURES) {
            if (common.has(id)) continue;
            const family = id.split('.')[0]!;
            sizes.set(family, (sizes.get(family) ?? 0) + 1);
        }
        const unlabelled = [...sizes].filter(([family, size]) => size > 1 && !hasGroupLabel(family)).map(([family]) => family);
        expect(unlabelled).toEqual([]);
    });

    it('labels every limit and mode key the server declares in the features section', () => {
        const isSwitch = (entry: (typeof FEATURE_SERVER_CONFIG)[number]) =>
            entry.type === 'boolean' && entry.featureId !== undefined && entry.key.endsWith('__ENABLED');
        const settingKeys = FEATURE_SERVER_CONFIG
            .filter((entry) => entry.section === 'features' && !isSwitch(entry))
            .map((entry) => entry.key);
        expect(settingKeys.length).toBeGreaterThan(0);
        const missing = settingKeys.filter(
            (key) => homeFeatureSettingTitleKey(key) === null || homeFeatureSettingDescriptionKey(key) === null,
        );
        expect(missing).toEqual([]);
    });
});
