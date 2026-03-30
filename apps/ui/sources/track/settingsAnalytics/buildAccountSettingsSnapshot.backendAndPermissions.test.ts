import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';

describe('buildAccountSettingsSnapshot', () => {
    it('tracks backend settings through structured canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            backendEnabledByTargetKey: {
                ...settingsDefaults.backendEnabledByTargetKey,
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: false,
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: true,
            },
            backendCliSourcePreferenceById: {
                codex: 'managed-first',
                claude: 'system-first',
            },
        });

        expect(snapshot.properties['acct_setting__backendEnabledByTargetKey__agent:claude']).toBe(false);
        expect(snapshot.properties['acct_setting__backendEnabledByTargetKey__agent:codex']).toBe(true);
        expect(snapshot.properties.acct_setting__backendCliSourcePreferenceById__codex).toBe('managed-first');
        expect(snapshot.properties.acct_setting__backendCliSourcePreferenceById__claude).toBe('system-first');
        expect(snapshot.properties.acct_setting__backendCliSourcePreferenceById__gemini).toBe('default');
    });

    it('tracks default permission modes per agent through structured canonical analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            sessionDefaultPermissionModeByTargetKey: {
                ...settingsDefaults.sessionDefaultPermissionModeByTargetKey,
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: 'safe-yolo',
                [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' })]: 'read-only',
            },
        });

        expect(snapshot.properties['acct_setting__sessionDefaultPermissionModeByTargetKey__agent:claude']).toBe('safe-yolo');
        expect(snapshot.properties['acct_setting__sessionDefaultPermissionModeByTargetKey__agent:codex']).toBe('read-only');
        expect(snapshot.properties['acct_setting__sessionDefaultPermissionModeByTargetKey__agent:gemini']).toBe('default');
    });
});

