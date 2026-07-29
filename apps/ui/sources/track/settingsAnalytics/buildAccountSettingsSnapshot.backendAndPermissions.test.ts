import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';

describe('buildAccountSettingsSnapshot', () => {
    it('tracks backend settings through structured canonical analytics serializers', () => {
        const claudeTargetKey = buildAgentUniverseBackendTargetKey('claude');
        const codexTargetKey = buildAgentUniverseBackendTargetKey('codex');
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            backendEnabledByTargetKey: {
                ...settingsDefaults.backendEnabledByTargetKey,
                [claudeTargetKey]: false,
                [codexTargetKey]: true,
            },
            backendCliSourcePreferenceByTargetKey: {
                [codexTargetKey]: 'managed-first',
                [claudeTargetKey]: 'system-first',
            },
        });

        expect(snapshot.properties[`acct_setting__backendEnabledByTargetKey__${claudeTargetKey}`]).toBe(false);
        expect(snapshot.properties[`acct_setting__backendEnabledByTargetKey__${codexTargetKey}`]).toBe(true);
        expect(snapshot.properties[`acct_setting__backendCliSourcePreferenceByTargetKey__${codexTargetKey}`]).toBe('managed-first');
        expect(snapshot.properties[`acct_setting__backendCliSourcePreferenceByTargetKey__${claudeTargetKey}`]).toBe('system-first');
        expect(snapshot.properties[`acct_setting__backendCliSourcePreferenceByTargetKey__${buildAgentUniverseBackendTargetKey('gemini')}`]).toBe('default');
    });

    it('tracks default permission modes per agent through structured canonical analytics serializers', () => {
        const claudeTargetKey = buildAgentUniverseBackendTargetKey('claude');
        const codexTargetKey = buildAgentUniverseBackendTargetKey('codex');
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            sessionDefaultPermissionModeByTargetKey: {
                ...settingsDefaults.sessionDefaultPermissionModeByTargetKey,
                [claudeTargetKey]: 'safe-yolo',
                [codexTargetKey]: 'read-only',
            },
        });

        expect(snapshot.properties[`acct_setting__sessionDefaultPermissionModeByTargetKey__${claudeTargetKey}`]).toBe('safe-yolo');
        expect(snapshot.properties[`acct_setting__sessionDefaultPermissionModeByTargetKey__${codexTargetKey}`]).toBe('read-only');
        expect(snapshot.properties[`acct_setting__sessionDefaultPermissionModeByTargetKey__${buildAgentUniverseBackendTargetKey('gemini')}`]).toBe('default');
    });
});
