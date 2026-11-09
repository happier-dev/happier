import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSessionSettingsCommonModuleMocks } from './sessionSettingsViewTestHelpers';
import { createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setPermissionModeApplyTiming = vi.fn();
const setPermissionPromptSurface = vi.fn();
const setDefaultPersistenceMode = vi.fn();
const setDefaultPersistenceModeByTargetKey = vi.fn();

installSessionSettingsCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#666',
                    success: '#0f0',
                },
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: createUseSettingMutableMockFromReader((name) => {
                    if (name === 'sessionPermissionModeApplyTiming') return ['immediate', setPermissionModeApplyTiming];
                    if (name === 'permissionPromptSurface') return ['composer', setPermissionPromptSurface];
                    if (name === 'newSessionDefaultPersistenceModeV1') return ['persisted', setDefaultPersistenceMode];
                    if (name === 'newSessionDefaultPersistenceModeByTargetKeyV1') return [{}, setDefaultPersistenceModeByTargetKey];
                    return [null, vi.fn()];
                }),
                useSettings: () => ({ schemaVersion: 1, opencodeBackendMode: 'server' } as any),
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct',
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['codex', 'opencode'],
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        DEFAULT_AGENT_ID: 'codex',
        resolveAgentIdFromFlavor: (agentId: string) => agentId,
        getAgentCore: (agentId: string) => ({
            displayNameKey: `agent.${agentId}`,
            permissions: {},
            sessionStorage: { direct: true, persisted: true },
            ui: { agentPickerIconName: 'sparkles-outline' },
        }),
        getAgentBehavior: () => ({
            newSession: {
                supportsTranscriptStorageMode: () => true,
            },
        }),
    };
});

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeOptionsForAgentType: () => [],
}));





// Load the real owner after boundaries during collection, outside behavior deadlines.
await import('./PermissionsSettingsView');

describe('PermissionsSettingsView', () => {
    it('does not render new-session shortcut settings', async () => {
        const { PermissionsSettingsView } = await import('./PermissionsSettingsView');
        const screen = await renderSettingsView(React.createElement(PermissionsSettingsView));

        expect(screen.findRowByTitle('settingsSession.sessionCreation.rememberLastProjectSelectionsTitle')).toBeNull();
    });

    it('renders session storage defaults and updates both global and per-agent settings', async () => {
        const { PermissionsSettingsView } = await import('./PermissionsSettingsView');
        const screen = await renderSettingsView(React.createElement(PermissionsSettingsView));
        const choice = (prefix: string) => screen.findAll((node) => node.props?.testIDPrefix === prefix)[0] ?? null;

        const global = choice('settings-permissions-storage-global');
        expect(global?.props.title).toBe('settingsSession.defaultStorage.globalTitle');
        expect(global?.props.value).toBe('persisted');
        global?.props.onChange('direct');
        expect(setDefaultPersistenceMode).toHaveBeenCalledWith('direct');

        const codex = choice('settings-permissions-storage-codex');
        expect(codex?.props.title).toBe('agent.codex');
        // No override yet: the agent follows the global default.
        expect(codex?.props.value).toBe('global');
        codex?.props.onChange('direct');
        expect(setDefaultPersistenceModeByTargetKey).toHaveBeenCalledWith({
            [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' })]: 'direct',
        });

        codex?.props.onChange('global');
        expect(setDefaultPersistenceModeByTargetKey).toHaveBeenCalledWith({});
    });

    it('chooses where prompts appear and when permission changes apply', async () => {
        const { PermissionsSettingsView } = await import('./PermissionsSettingsView');
        const screen = await renderSettingsView(React.createElement(PermissionsSettingsView));
        const choice = (prefix: string) => screen.findAll((node) => node.props?.testIDPrefix === prefix)[0] ?? null;

        expect(choice('settings-permissions-prompt-surface')?.props.value).toBe('composer');
        choice('settings-permissions-prompt-surface')?.props.onChange('transcript');
        expect(setPermissionPromptSurface).toHaveBeenCalledWith('transcript');

        expect(choice('settings-permissions-apply-timing')?.props.value).toBe('immediate');
        choice('settings-permissions-apply-timing')?.props.onChange('next_prompt');
        expect(setPermissionModeApplyTiming).toHaveBeenCalledWith('next_prompt');
    });

    it('does not render prompt personalization controls inside permissions settings', async () => {
        const { PermissionsSettingsView } = await import('./PermissionsSettingsView');
        const screen = await renderSettingsView(React.createElement(PermissionsSettingsView));

        expect(screen.findRowByTitle('settingsSession.promptPersonalization.askAgentToRenameSessionsTitle')).toBeNull();
        expect(screen.findRowByTitle('settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle')).toBeNull();
    });
});
