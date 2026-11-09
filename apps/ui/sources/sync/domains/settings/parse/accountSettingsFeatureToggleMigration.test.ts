import { describe, expect, it } from 'vitest';

import { buildUiFeatureExperimentsChange, buildUiFeatureToggleChange, resolveUiFeatureToggleEnabled } from '@happier-dev/protocol/actions/settings/featurePreferenceMutations';
import { applyAccountSettingMutationV1 } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { migrateAccountSettingsFeaturePreferences } from '@happier-dev/protocol/account/settings/accountSettings';

import { settingsParse } from '../settings';
import { normalizeAccountSettingsForServerStorage } from '../accountSettingsNormalization';
import { mergePendingSettingsIntoRawBaseline } from '@/sync/engine/settings/writeback/accountSettingsRawDeltaMerge';
import { migrateAccountFeatureToggles } from './accountSettingsFeatureToggleMigration';

// Observed ../0.2 at 7b37d65ca75e58560f8f3ca850958ac5407d2e75:
// settings.ts writes v8; Features seeds the experimental registry defaults.
const predecessorV8Settings = {
    schemaVersion: 8,
    experiments: true,
    featureToggles: {
        'files.markdownRichEditor': false,
        'files.editor': true,
        'voice': false,
        'voice.agent': false,
        'scm.writeOperations': false,
        'memory.search': false,
        'zen.navigation': true,
    },
};

describe('graduated Rich editor settings migration', () => {
    it('recovers the Rich default from predecessor v8 settings through the loaded-settings reader', () => {
        const settings = settingsParse(predecessorV8Settings);

        expect(settings.schemaVersion).toBe(9);
        expect(resolveUiFeatureToggleEnabled(settings, 'files.markdownRichEditor')).toBe(true);
        expect(settings.featureToggles['scm.writeOperations']).toBe(false);
        expect(predecessorV8Settings.featureToggles['files.markdownRichEditor']).toBe(false);
    });

    it('preserves a later explicit opt-out through reload and current Experiments changes', () => {
        const migrated = settingsParse(predecessorV8Settings);
        const optedOut = settingsParse({ ...migrated, ...buildUiFeatureToggleChange(migrated, 'files.markdownRichEditor', false) });
        const reloaded = settingsParse(JSON.parse(JSON.stringify(optedOut)));
        const experimentsOn = settingsParse({ ...reloaded, ...buildUiFeatureExperimentsChange(reloaded, true) });

        expect(resolveUiFeatureToggleEnabled(reloaded, 'files.markdownRichEditor')).toBe(false);
        expect(resolveUiFeatureToggleEnabled(experimentsOn, 'files.markdownRichEditor')).toBe(false);
        expect(settingsParse(reloaded)).toEqual(reloaded);
    });

    it('persists the migration before applying a new off choice to the retained v8 baseline', () => {
        const migrated = settingsParse(predecessorV8Settings);
        const pendingSettings = buildUiFeatureToggleChange(migrated, 'files.markdownRichEditor', false);
        const persisted = mergePendingSettingsIntoRawBaseline({
            rawBaseline: predecessorV8Settings,
            pendingSettings,
            normalizeForPersistedStorage: raw => {
                const normalized = normalizeAccountSettingsForServerStorage({ raw, mode: 'plain', settingsSecretsKey: null });
                return { value: normalized.value, changed: normalized.secretsChanged };
            },
        }).outgoingRaw;

        expect(persisted.schemaVersion).toBe(9);
        expect(resolveUiFeatureToggleEnabled(settingsParse(persisted), 'files.markdownRichEditor')).toBe(false);

        const actionMutation = applyAccountSettingMutationV1(predecessorV8Settings, {
            operations: [{ op: 'set', key: 'featureToggles', value: pendingSettings.featureToggles }],
        });
        expect(actionMutation.status).toBe('applied');
        if (actionMutation.status !== 'applied') throw new Error('Expected the feature preference mutation to apply');
        expect(actionMutation.raw.schemaVersion).toBe(9);
        expect(resolveUiFeatureToggleEnabled(settingsParse(actionMutation.raw), 'files.markdownRichEditor')).toBe(false);
    });

    it('does not repeat a completed promotion on a later schema upgrade', () => {
        const migrated = migrateAccountSettingsFeaturePreferences({
            schemaVersion: 9,
            featureToggles: { 'files.markdownRichEditor': false, 'files.editor': false },
        });
        expect(migrated.featureToggles).toEqual({ 'files.markdownRichEditor': false, 'files.editor': false });
        expect(migrateAccountFeatureToggles({
            inputSchemaVersion: 9,
            supportedSchemaVersion: 10,
            featureToggles: migrated.featureToggles,
        })).toEqual({ 'files.markdownRichEditor': false, 'files.editor': false });
    });

    it('keeps v7 deliberate editor and split-diff choices when advancing the schema', () => {
        const settings = settingsParse({
            schemaVersion: 7,
            featureToggles: { 'files.editor': false },
            filesDiffPresentationStyle: 'split',
        });

        expect(settings.featureToggles['files.editor']).toBe(false);
        expect(settings.filesDiffPresentationStyle).toBe('split');
    });
});
