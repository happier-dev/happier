import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    ACCOUNT_SETTING_ANALYTICS,
    ACCOUNT_SETTING_ANALYTICS_ARTIFACTS,
} from './accountSettingAnalytics';

const ACCOUNT_REGISTRY_DIRECTORY = __dirname;

describe('Account setting analytics presentation', () => {
    it('attaches metadata to Protocol definitions without rebuilding persistence artifacts', () => {
        const definition = ACCOUNT_SETTING_ANALYTICS_ARTIFACTS.definitions.sessionListDensity;

        expect(definition.schema).toBe(ACCOUNT_SETTING_DEFINITIONS.sessionListDensity.schema);
        expect(definition.default).toBe(ACCOUNT_SETTING_DEFINITIONS.sessionListDensity.default);
        expect(definition.analytics).toBe(ACCOUNT_SETTING_ANALYTICS.sessionListDensity);
        expect(ACCOUNT_SETTING_ANALYTICS_ARTIFACTS).not.toHaveProperty('shape');
        expect(ACCOUNT_SETTING_ANALYTICS_ARTIFACTS).not.toHaveProperty('defaults');
    });

    it('keeps non-Voice account presentation modules free of schema/default constructors', () => {
        const violations = readdirSync(ACCOUNT_REGISTRY_DIRECTORY)
            .filter((entry) => entry.endsWith('.ts'))
            .filter((entry) => !entry.endsWith('.test.ts'))
            .filter((entry) => /defineSettingDefinitions|buildSettingArtifacts/.test(
                readFileSync(join(ACCOUNT_REGISTRY_DIRECTORY, entry), 'utf8'),
            ))
            .sort();

        expect(violations).toEqual([]);
    });

    it('attaches the Voice telemetry overlay without restoring Voice persistence ownership', () => {
        expect(ACCOUNT_SETTING_ANALYTICS.voice).toMatchObject({
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'person',
        });
        expect(ACCOUNT_SETTING_ANALYTICS.voice?.serializeCurrentProperties).toEqual(expect.any(Function));
        expect(ACCOUNT_SETTING_ANALYTICS_ARTIFACTS.definitions.voice?.schema)
            .toBe(ACCOUNT_SETTING_DEFINITIONS.voice.schema);
        expect(ACCOUNT_SETTING_ANALYTICS_ARTIFACTS.definitions.voice?.default)
            .toBe(ACCOUNT_SETTING_DEFINITIONS.voice.default);
        expect(ACCOUNT_SETTING_ANALYTICS).not.toHaveProperty('voiceSettingsV1');
        expect(ACCOUNT_SETTING_ANALYTICS_ARTIFACTS.definitions).not.toHaveProperty('voiceSettingsV1');
    });
});
