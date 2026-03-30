import { describe, expect, it } from 'vitest';

import { buildBackendTargetKey } from '@happier-dev/protocol';

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
            supportedSchemaVersion: 6,
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
        expect(migrated.schemaVersion).toBe(6);
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
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: 'yolo',
        });
        expect(migrated.sessionDefaultPermissionModeByTargetKey).not.toHaveProperty(
            buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' }),
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
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'managed-first',
            [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'gemini' })]: 'system-first',
        });
    });

    it('preserves an existing codex backend mode when migrating a pre-v6 payload', () => {
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input: {
                codexBackendMode: 'mcp',
            },
            settings: {
                ...settingsDefaults,
            },
            inputSchemaVersion: 5,
            supportedSchemaVersion: 6,
        });

        expect(migrated.codexBackendMode).toBe('mcp');
    });

    it('normalizes legacy codex backend mode aliases and whitespace when migrating a pre-v6 payload', () => {
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input: {
                codexBackendMode: '  mcp_resume  ',
            },
            settings: {
                ...settingsDefaults,
            },
            inputSchemaVersion: 5,
            supportedSchemaVersion: 6,
        });

        expect(migrated.codexBackendMode).toBe('acp');
    });
});
