import { describe, expect, it } from 'vitest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol';

import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';

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
        const snapshot = buildAccountSettingsSnapshot(settingsParse({
            ...settingsDefaults,
            featureToggles: { voice: true, sessions: false },
            usePickerSearch: true,
            compactSessionView: true,
            compactSessionViewMinimal: true,
            lastUsedAgent: 'codex',
            lastUsedPermissionMode: 'plan',
            lastUsedModelMode: 'openrouter',
        }));

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
            sessionInactiveResumePolicy: 'manual',
            agentInputEnterToSend: false,
            alwaysShowContextSize: true,
            agentInputHistoryScope: 'global',
            agentInputActionBarLayout: 'scroll',
            agentInputChipDensity: 'icons',
            useEnhancedSessionWizard: true,
            hideInactiveSessions: true,
            showFlavorIcons: false,
            avatarStyle: 'gradient',
            sessionListLayoutV1: 'recent_activity',
            sessionListAttentionPlacementV1: 'top',
            useMachinePickerSearch: true,
            usePathPickerSearch: true,
        });

        expect(snapshot.properties.acct_setting__sessionReplayEnabled).toBe(true);
        expect(snapshot.properties.acct_setting__sessionUseTmux).toBe(true);
        expect(snapshot.properties.acct_setting__useProfiles).toBe(true);
        expect(snapshot.properties.acct_setting__sessionPermissionModeApplyTiming).toBe('next_prompt');
        expect(snapshot.properties.acct_setting__sessionMessageSendMode).toBe('interrupt');
        expect(snapshot.properties.acct_setting__sessionBusySteerSendPolicy).toBe('server_pending');
        expect(snapshot.properties.acct_setting__sessionInactiveResumePolicy).toBe('manual');
        expect(snapshot.properties.acct_setting__agentInputEnterToSend).toBe(false);
        expect(snapshot.properties.acct_setting__alwaysShowContextSize).toBe(true);
        expect(snapshot.properties.acct_setting__agentInputHistoryScope).toBe('global');
        expect(snapshot.properties.acct_setting__agentInputActionBarLayout).toBe('scroll');
        expect(snapshot.properties.acct_setting__agentInputChipDensity).toBe('icons');
        expect(snapshot.properties.acct_setting__useEnhancedSessionWizard).toBe(true);
        expect(snapshot.properties.acct_setting__hideInactiveSessions).toBe(true);
        expect(snapshot.properties).not.toHaveProperty('acct_setting__groupInactiveSessionsByProject');
        expect(snapshot.properties.acct_setting__showFlavorIcons).toBe(false);
        expect(snapshot.properties.acct_setting__avatarStyle).toBe('gradient');
        expect(snapshot.properties.acct_setting__sessionListLayoutV1).toBe('recent_activity');
        expect(snapshot.properties.acct_setting__sessionListAttentionPlacementV1).toBe('top');
        for (const key of ['sessionListActiveGroupingV1', 'sessionListInactiveGroupingV1', 'sessionListSectionModeV1']) {
            expect(snapshot.properties).not.toHaveProperty(`acct_setting__${key}`);
        }
        expect(snapshot.properties.acct_setting__useMachinePickerSearch).toBe(true);
        expect(snapshot.properties.acct_setting__usePathPickerSearch).toBe(true);
    });

    it('does not expose the opaque provider settings subtree to account analytics', () => {
        const snapshot = buildAccountSettingsSnapshot(settingsParse({
            ...settingsDefaults,
            providerSettingsV1: {
                v: 1,
                providers: {
                    codex: { backendMode: 'mcp' },
                    opencode: { serverBaseUrl: 'https://example.com/' },
                },
            },
        }));

        expect(snapshot.properties).not.toHaveProperty('acct_setting__providerSettingsV1');
    });

    it('does not expose transcript storage target identities in account analytics', () => {
        const configuredTargetKey = buildBackendTargetKeyV2({
            kind: 'backend',
            backendId: 'review-bot',
            configuredBackendId: 'review-bot',
        });
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            newSessionDefaultPersistenceModeV1: 'direct',
            newSessionDefaultPersistenceModeByTargetKeyV1: {
                [buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: 'persisted',
                [configuredTargetKey]: 'direct',
            },
        });

        expect(snapshot.properties).not.toHaveProperty('acct_setting__newSessionDefaultPersistenceModeV1');
        expect(Object.keys(snapshot.properties).some((key) => key.startsWith('acct_setting__newSessionDefaultPersistenceModeByTargetKeyV1'))).toBe(false);
    });
});
