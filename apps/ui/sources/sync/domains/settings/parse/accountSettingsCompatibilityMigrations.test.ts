import { describe, expect, it } from 'vitest';

import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { applyAccountSettingsCompatibilityMigrations } from './accountSettingsCompatibilityMigrations';

describe('applyAccountSettingsCompatibilityMigrations', () => {
    it('migrates legacy language, picker search, compact view, and feature toggle compatibility in one pass', () => {
        const legacyFeatureToggles: Record<string, boolean> = {
            'inbox.friends': true,
            'files.editor': false,
        };
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input: {
                schemaVersion: 2,
                preferredLanguage: 'zh',
                compactSessionView: true,
                compactSessionViewMinimal: true,
                usePickerSearch: true,
                featureToggles: legacyFeatureToggles,
            },
            settings: {
                ...settingsDefaults,
                preferredLanguage: 'zh',
                featureToggles: legacyFeatureToggles,
            },
            inputSchemaVersion: 2,
            supportedSchemaVersion: 7,
        });

        expect(migrated.preferredLanguage).toBe('zh-Hans');
        expect(migrated.sessionListDensity).toBe('narrow');
        expect(migrated.compactSessionView).toBe(true);
        expect(migrated.compactSessionViewMinimal).toBe(true);
        expect(migrated.useMachinePickerSearch).toBe(true);
        expect(migrated.usePathPickerSearch).toBe(true);
        expect(migrated.featureToggles?.['inbox.friends']).toBeUndefined();
        expect(migrated.featureToggles?.['social.friends']).toBe(true);
        expect(migrated.featureToggles?.['files.editor']).toBeUndefined();
        expect(migrated.schemaVersion).toBe(7);
    });

    it('carries the legacy tab-bar blur preference into the generalized glass surface keys', () => {
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input: {
                tabBarBlurEnabled: false,
                tabBarBlurIntensity: 'strong',
            },
            settings: {
                ...settingsDefaults,
            },
            inputSchemaVersion: 7,
            supportedSchemaVersion: 7,
        });

        expect(migrated.glassBlurEnabled).toBe(false);
        expect(migrated.glassBlurIntensity).toBe('strong');
    });

    it('keeps the new glass blur preference when both legacy and new keys are present', () => {
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input: {
                tabBarBlurEnabled: false,
                glassBlurEnabled: true,
            },
            settings: {
                ...settingsDefaults,
                glassBlurEnabled: true,
            },
            inputSchemaVersion: 7,
            supportedSchemaVersion: 7,
        });

        expect(migrated.glassBlurEnabled).toBe(true);
    });

    it('normalizes invalid server selection state to null', () => {
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input: {
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: '   ',
            },
            settings: {
                ...settingsDefaults,
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: '   ',
            },
            inputSchemaVersion: 6,
            supportedSchemaVersion: 6,
        });

        expect(migrated.serverSelectionActiveTargetKind).toBeNull();
        expect(migrated.serverSelectionActiveTargetId).toBeNull();
    });

    it('skips invalid legacy permission modes while migrating per-agent defaults', () => {
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input: {
                sessionDefaultPermissionModeByAgent: {
                    codex: 'bogus-mode',
                    claude: 'yolo',
                },
            },
            settings: {
                ...settingsDefaults,
                sessionDefaultPermissionModeByTargetKey: {},
            },
            inputSchemaVersion: 6,
            supportedSchemaVersion: 6,
        });

        expect(migrated.sessionDefaultPermissionModeByTargetKey).toEqual({
            [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' })]: 'yolo',
        });
        expect(migrated.sessionDefaultPermissionModeByTargetKey).not.toHaveProperty(
            resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
        );
    });

    it('migrates legacy backend CLI source preferences into the canonical target-keyed map', () => {
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input: {
                backendCliSourcePreferenceById: {
                    codex: 'managed-first',
                    gemini: 'system-first',
                    invalid: 'ignored',
                },
            },
            settings: {
                ...settingsDefaults,
                backendCliSourcePreferenceByTargetKey: {},
            },
            inputSchemaVersion: 6,
            supportedSchemaVersion: 6,
        });

        expect(migrated.backendCliSourcePreferenceByTargetKey).toEqual({
            [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: 'managed-first',
            [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })]: 'system-first',
        });
    });

});
