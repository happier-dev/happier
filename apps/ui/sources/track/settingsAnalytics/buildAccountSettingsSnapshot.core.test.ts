import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';

describe('buildAccountSettingsSnapshot', () => {
    it('tracks canonical session density and derives compact view flags from it', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            sessionListDensity: 'narrow',
        });

        expect(snapshot.properties.acct_setting__sessionListDensity).toBe('narrow');
        expect(snapshot.properties.derived__compact_session_view).toBe(true);
        expect(snapshot.properties.derived__compact_session_view_minimal).toBe(true);
    });

    it('does not expose legacy compatibility fields or raw feature toggle storage in current-state account analytics', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            featureToggles: { voice: true, sessions: false },
            usePickerSearch: true,
            compactSessionView: true,
            compactSessionViewMinimal: true,
            lastUsedAgent: 'codex',
            lastUsedPermissionMode: 'plan',
            lastUsedModelMode: 'openrouter',
        });

        expect(snapshot.properties).not.toHaveProperty('acct_setting__featureToggles');
        expect(snapshot.properties).not.toHaveProperty('acct_setting__usePickerSearch');
        expect(snapshot.properties).not.toHaveProperty('acct_setting__compactSessionView');
        expect(snapshot.properties).not.toHaveProperty('acct_setting__compactSessionViewMinimal');
        expect(snapshot.properties).not.toHaveProperty('acct_setting__lastUsedAgent');
        expect(snapshot.properties).not.toHaveProperty('acct_setting__lastUsedPermissionMode');
        expect(snapshot.properties).not.toHaveProperty('acct_setting__lastUsedModelMode');
    });

    it('tracks pre-run and feature-adjacent account settings as current-state person properties', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            sessionReplayEnabled: true,
            sessionUseTmux: true,
            useProfiles: true,
            sessionPermissionModeApplyTiming: 'next_prompt',
            sessionMessageSendMode: 'interrupt',
            sessionBusySteerSendPolicy: 'server_pending',
            agentInputEnterToSend: false,
            alwaysShowContextSize: true,
            agentInputHistoryScope: 'global',
            agentInputActionBarLayout: 'scroll',
            agentInputChipDensity: 'icons',
            useEnhancedSessionWizard: true,
            showEnvironmentBadge: false,
            hideInactiveSessions: true,
            groupInactiveSessionsByProject: true,
            showFlavorIcons: false,
            avatarStyle: 'minimal',
            sessionListActiveGroupingV1: 'date',
            sessionListInactiveGroupingV1: 'project',
            useMachinePickerSearch: true,
            usePathPickerSearch: true,
        });

        expect(snapshot.properties.acct_setting__sessionReplayEnabled).toBe(true);
        expect(snapshot.properties.acct_setting__sessionUseTmux).toBe(true);
        expect(snapshot.properties.acct_setting__useProfiles).toBe(true);
        expect(snapshot.properties.acct_setting__sessionPermissionModeApplyTiming).toBe('next_prompt');
        expect(snapshot.properties.acct_setting__sessionMessageSendMode).toBe('interrupt');
        expect(snapshot.properties.acct_setting__sessionBusySteerSendPolicy).toBe('server_pending');
        expect(snapshot.properties.acct_setting__agentInputEnterToSend).toBe(false);
        expect(snapshot.properties.acct_setting__alwaysShowContextSize).toBe(true);
        expect(snapshot.properties.acct_setting__agentInputHistoryScope).toBe('global');
        expect(snapshot.properties.acct_setting__agentInputActionBarLayout).toBe('scroll');
        expect(snapshot.properties.acct_setting__agentInputChipDensity).toBe('icons');
        expect(snapshot.properties.acct_setting__useEnhancedSessionWizard).toBe(true);
        expect(snapshot.properties.acct_setting__showEnvironmentBadge).toBe(false);
        expect(snapshot.properties.acct_setting__hideInactiveSessions).toBe(true);
        expect(snapshot.properties.acct_setting__groupInactiveSessionsByProject).toBe(true);
        expect(snapshot.properties.acct_setting__showFlavorIcons).toBe(false);
        expect(snapshot.properties.acct_setting__avatarStyle).toBe('minimal');
        expect(snapshot.properties.acct_setting__sessionListActiveGroupingV1).toBe('date');
        expect(snapshot.properties.acct_setting__sessionListInactiveGroupingV1).toBe('project');
        expect(snapshot.properties.acct_setting__useMachinePickerSearch).toBe(true);
        expect(snapshot.properties.acct_setting__usePathPickerSearch).toBe(true);
    });

    it('derives provider-owned account settings from canonical provider field definitions', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            codexBackendMode: 'mcp',
            opencodeBackendMode: 'acp',
            opencodeServerBaseUrl: 'https://example.com/',
            claudeRemoteAgentSdkEnabled: false,
            claudeRemoteSettingSourcesV2: ['project'],
            claudeRemoteAdvancedOptionsJson: '{"maxTurns":4}',
        });

        expect(snapshot.properties.acct_setting__codexBackendMode).toBe('mcp');
        expect(snapshot.properties.acct_setting__opencodeBackendMode).toBe('acp');
        expect(snapshot.properties.acct_setting__opencodeServerBaseUrl).toBe(true);
        expect(snapshot.properties.acct_setting__claudeRemoteAgentSdkEnabled).toBe(false);
        expect(snapshot.properties.acct_setting__claudeRemoteSettingSourcesV2).toBe('project');
        expect(snapshot.properties.acct_setting__claudeRemoteAdvancedOptionsJson).toBe(true);
    });
});

