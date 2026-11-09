import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';

import { applyAccountSettingsCompatibilityMigrations } from './accountSettingsCompatibilityMigrations';

describe('applyAccountSettingsCompatibilityMigrations', () => {
    it('projects retained legacy tmux overrides without losing known preferences or carrying retired fields', () => {
        const override = { useTmux: true, sessionName: 'retained', isolated: false, tmpDir: null };
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input: { terminalTmuxByMachineId: { 'machine-1': { ...override, retired: { enabled: true } } } },
            settings: { ...settingsDefaults },
            inputSchemaVersion: 2,
            supportedSchemaVersion: settingsDefaults.schemaVersion,
        });

        expect(migrated.sessionTmuxByMachineId).toEqual({ 'machine-1': override });
    });

    it('keeps predecessor voice credential references when retained binding objects contain retired fields', () => {
        const binding = {
            providerId: 'realtime_elevenlabs',
            credentialBindings: {
                account: { api_key: 'personal-secret' },
                byMachineId: { 'machine-1': { api_key: 'machine-secret' } },
            },
        };
        const input = { voice: {
            providerId: 'realtime_elevenlabs',
            adapters: {},
            credentialBindings: [{ ...binding, retired: true,
                credentialBindings: { ...binding.credentialBindings, retired: { enabled: true } } }],
        } };
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input,
            settings: { voice: {}, secrets: [] },
            inputSchemaVersion: 2,
            supportedSchemaVersion: settingsDefaults.schemaVersion,
        });

        expect(migrated.voice).toEqual({ credentialBindings: [binding] });
        expect(migrated.secrets).toEqual([]);
    });

    it('normalizes stored target maps without retaining an abstract configured Agent as executable', () => {
        const stored = {
            'backend:custom-acp': true,
            'agent:happier.agent.custom-acp/custom-acp': true,
            'agent:claude': false,
            'acpBackend:review-agent': true,
        };
        expect(settingsParse({ backendEnabledByTargetKey: stored }).backendEnabledByTargetKey).toEqual({
            'agent:happier.agent.claude/claude': false,
            'agent:happier.agent.custom-acp/custom-acp:definition:review-agent': true,
        });
    });

    it('migrates legacy permission intent only to executable Agent targets', () => {
        const migrated = settingsParse({ lastUsedPermissionMode: 'read-only' });
        expect(migrated.sessionDefaultPermissionModeByTargetKey['agent:happier.agent.claude/claude']).toBe('read-only');
        expect(Object.keys(migrated.sessionDefaultPermissionModeByTargetKey)).not.toContain('agent:happier.agent.custom-acp/custom-acp');
    });
    it('retains sparse defaults and refuses malformed-present legacy boolean aliases', () => {
        const sparseSettings = accountSettingsParse({});
        const expected = {
            sessionListDensity: settingsDefaults.sessionListDensity,
            useMachinePickerSearch: settingsDefaults.useMachinePickerSearch,
            usePathPickerSearch: settingsDefaults.usePathPickerSearch,
            transcriptMessageTimestampDisplayMode: settingsDefaults.transcriptMessageTimestampDisplayMode,
        };
        // safeParse errors are lazy: an error-format callback cannot observe
        // validation that correctly consumes only success. Assert the policy.
        for (const input of [
            {},
            { compactSessionView: 'invalid-compact', compactSessionViewMinimal: 'invalid-minimal',
                usePickerSearch: 'invalid-picker', transcriptMessageTimestampsEnabled: 'invalid-timestamps' },
            { compactSessionViewMinimal: 'invalid-minimal-only' },
            { compactSessionView: undefined, compactSessionViewMinimal: undefined,
                usePickerSearch: undefined, transcriptMessageTimestampsEnabled: undefined },
        ]) {
            expect(applyAccountSettingsCompatibilityMigrations({
                input, settings: sparseSettings,
                inputSchemaVersion: sparseSettings.schemaVersion,
                supportedSchemaVersion: sparseSettings.schemaVersion,
            })).toMatchObject(expected);
            expect(settingsParse(input)).toMatchObject(expected);
        }
    });

    it('preserves false, compact/minimal precedence and current preferences for legacy boolean inputs', () => {
        expect(settingsParse({
            compactSessionView: false,
            compactSessionViewMinimal: true,
            usePickerSearch: false,
            transcriptMessageTimestampsEnabled: false,
        })).toMatchObject({
            sessionListDensity: 'detailed',
            useMachinePickerSearch: false,
            usePathPickerSearch: false,
            transcriptMessageTimestampDisplayMode: settingsDefaults.transcriptMessageTimestampDisplayMode,
        });
        expect(settingsParse({ compactSessionView: true })).toMatchObject({ sessionListDensity: 'cozy' });
        expect(settingsParse({ compactSessionView: true, compactSessionViewMinimal: 'invalid' }))
            .toMatchObject({ sessionListDensity: 'cozy' });
        expect(settingsParse({ compactSessionViewMinimal: true }))
            .toMatchObject({ sessionListDensity: settingsDefaults.sessionListDensity });
        expect(settingsParse({
            sessionListDensity: 'detailed',
            compactSessionView: true,
            compactSessionViewMinimal: true,
            useMachinePickerSearch: false,
            usePickerSearch: true,
            transcriptMessageTimestampDisplayMode: 'never',
            transcriptMessageTimestampsEnabled: true,
        })).toMatchObject({
            sessionListDensity: 'detailed',
            useMachinePickerSearch: false,
            usePathPickerSearch: settingsDefaults.usePathPickerSearch,
            transcriptMessageTimestampDisplayMode: 'never',
        });
        expect(settingsParse({ transcriptMessageTimestampDisplayMode: 'invalid', transcriptMessageTimestampsEnabled: true }))
            .toMatchObject({ transcriptMessageTimestampDisplayMode: settingsDefaults.transcriptMessageTimestampDisplayMode });
    });

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
        expect(migrated).not.toHaveProperty('compactSessionView');
        expect(migrated).not.toHaveProperty('compactSessionViewMinimal');
        expect(migrated.useMachinePickerSearch).toBe(true);
        expect(migrated.usePathPickerSearch).toBe(true);
        expect(migrated.featureToggles?.['inbox.friends']).toBeUndefined();
        expect(migrated.featureToggles?.['social.friends']).toBe(true);
        expect(migrated.featureToggles?.['files.editor']).toBeUndefined();
        expect(migrated.schemaVersion).toBe(settingsDefaults.schemaVersion);
    });

    it('reads the 0.2 compact and picker aliases without overriding explicit current preferences', () => {
        // 0.2 account display registry: the two compact booleans and usePickerSearch.
        const predecessor = { compactSessionView: true, compactSessionViewMinimal: false, usePickerSearch: true };
        const migrated = applyAccountSettingsCompatibilityMigrations({ input: predecessor,
            settings: accountSettingsParse(predecessor), inputSchemaVersion: 8, supportedSchemaVersion: 8 });
        expect(migrated).toMatchObject({ sessionListDensity: 'cozy', useMachinePickerSearch: true, usePathPickerSearch: true });
        expect(migrated).not.toHaveProperty('compactSessionView');
        expect(migrated).not.toHaveProperty('compactSessionViewMinimal');
        const input = { ...predecessor, sessionListDensity: 'detailed', useMachinePickerSearch: false, usePathPickerSearch: false };
        const current = applyAccountSettingsCompatibilityMigrations({ input,
            settings: accountSettingsParse(input), inputSchemaVersion: 8, supportedSchemaVersion: 8 });
        expect(current).toMatchObject({ sessionListDensity: 'detailed', useMachinePickerSearch: false, usePathPickerSearch: false });
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

    it('rekeys Protocol-migrated backend CLI source preferences through the Agent catalog owner', () => {
        const input = {
            backendCliSourcePreferenceById: {
                codex: 'managed-first',
                gemini: 'system-first',
                invalid: 'ignored',
            },
        };
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input,
            settings: accountSettingsParse(input),
            inputSchemaVersion: 6,
            supportedSchemaVersion: 6,
        });

        expect(migrated.backendCliSourcePreferenceByTargetKey).toEqual({
            'agent:happier.agent.codex/codex': 'managed-first',
            'agent:happier.agent.gemini/gemini': 'system-first',
        });
    });

    it('rekeys predecessor target aliases and gives an explicit canonical Agent entry precedence', () => {
        const codexTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
        const input = {
            backendEnabledByTargetKey: {
                'backend:codex': false,
            },
            backendCliSourcePreferenceByTargetKey: {
                'backend:codex': 'managed-first',
                [codexTargetKey]: 'system-first',
            },
            sessionDefaultPermissionModeByTargetKey: {
                'backend:codex': 'read-only',
            },
            newSessionDefaultPersistenceModeByTargetKeyV1: {
                'backend:codex': 'direct',
            },
        };
        const migrated = applyAccountSettingsCompatibilityMigrations({
            input,
            settings: accountSettingsParse(input),
            inputSchemaVersion: 6,
            supportedSchemaVersion: 7,
        });

        expect(migrated.backendEnabledByTargetKey).toEqual({
            [codexTargetKey]: false,
        });
        expect(migrated.backendCliSourcePreferenceByTargetKey).toEqual({
            [codexTargetKey]: 'system-first',
        });
        expect(migrated.sessionDefaultPermissionModeByTargetKey).toEqual({
            [codexTargetKey]: 'read-only',
        });
        expect(migrated.newSessionDefaultPersistenceModeByTargetKeyV1).toEqual({
            [codexTargetKey]: 'direct',
        });
    });

});
