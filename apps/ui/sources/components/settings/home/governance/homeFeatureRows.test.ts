import { describe, expect, it } from 'vitest';

import { featureDecisionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';

import { homeSettingEntryFixture, homeSettingsProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';

import { buildSettingHref, type SettingRef } from '@/components/settings/catalog/settingDeclarations';

import { homeAdministrationFeaturesPath } from './homeAdministrationRoutes';
import { HOME_COMMON_FEATURE_IDS, homeFeatureRowState } from './homeFeatureRows';
import { HOME_FEATURE_SETTINGS, homeFeatureKeyHref } from './homeFeatureSettings';

describe('homeFeatureRowState', () => {
    it('says the deployment decides, with no control, when a feature without a Home switch is off on the server', () => {
        // Live: Happier voice has no Home key and is off because the deployment does not provide the
        // voice service. Neither the owner nor the Happier build is what turns it on.
        const state = homeFeatureRowState(null, featureDecisionFixture('voice.happierVoice', {
            state: 'disabled',
            blockedBy: 'server',
            blockerCode: 'feature_disabled',
        }));
        expect(state).toEqual({ kind: 'unavailable', switchable: false });
    });

    it('keeps an owner switch on a server-unavailable feature switchable', () => {
        const state = homeFeatureRowState(
            {
                key: 'HAPPIER_FEATURE_VOICE__ENABLED',
                value: true,
                source: 'default',
                fixed: false,
                editable: 'home',
                apply: 'live',
                declaration: { type: 'boolean', section: 'features', family: 'voice', featureId: 'voice', default: true },
            },
            featureDecisionFixture('voice', { state: 'disabled', blockedBy: 'server', blockerCode: 'feature_disabled' }),
        );
        expect(state).toEqual({ kind: 'unavailable', switchable: true });
    });

    it('reports an always-on feature without a Home switch as the build\'s to turn off', () => {
        expect(homeFeatureRowState(null, featureDecisionFixture('sharing.session'))).toEqual({ kind: 'noHomeSwitch', on: true });
    });
});

describe('homeFeatureKeyHref', () => {
    // Any declared feature outside the Common ten: its family is rendered as a disclosure on Features.
    const featureId = (Object.keys(HOME_FEATURE_SETTINGS.settings) as FeatureId[])
        .find((id) => !(HOME_COMMON_FEATURE_IDS as readonly FeatureId[]).includes(id) && id.includes('.'))!;
    const family = featureId.split('.')[0]!;
    const limit = homeSettingEntryFixture('HAPPIER_FEATURE_FAMILY__SOME_LIMIT', {
        declaration: { type: 'int', section: 'features', family },
    });
    const familySwitch = homeSettingEntryFixture('HAPPIER_FEATURE_FAMILY__ENABLED', {
        value: true,
        declaration: { type: 'boolean', section: 'features', family, featureId, default: true },
    });

    it('leads a feature family\'s limit to that family on Features, opened through one of its switches', () => {
        const settings = homeSettingsProjectionFixture({ entries: [familySwitch, limit] });
        expect(homeFeatureKeyHref('home-1', settings, limit.key)).toBe(buildSettingHref(
            homeAdministrationFeaturesPath('home-1'),
            (HOME_FEATURE_SETTINGS.settings as Readonly<Record<string, SettingRef>>)[featureId]!,
        ));
    });

    it('leads to the Features page when the family shows no switch, and nowhere for a key Features does not render', () => {
        expect(homeFeatureKeyHref('home-1', homeSettingsProjectionFixture({ entries: [limit] }), limit.key))
            .toBe(homeAdministrationFeaturesPath('home-1'));
        expect(homeFeatureKeyHref('home-1', homeSettingsProjectionFixture({ entries: [familySwitch] }), 'METRICS_PORT')).toBeNull();
        expect(homeFeatureKeyHref('home-1', null, limit.key)).toBeNull();
    });
});
