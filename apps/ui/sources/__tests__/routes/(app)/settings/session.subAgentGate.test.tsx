import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const localSettingsState: LocalSettings = { ...localSettingsDefaults };
let executionRunsEnabled = false;

installSessionSettingsEntryModuleMocks({
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [
                    localSettingsState[key],
                    (next: LocalSettings[K]) => {
                        localSettingsState[key] = next;
                    },
                ] as const,
                useSetting: createUseSettingMock({
                    values: { recentMachinePaths: [] },
                }),
            },
        });
    },
    featureEnabled: () => executionRunsEnabled,
});

vi.mock('@/agents/catalog/catalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/agents/catalog/catalog')>()),
    AGENT_IDS: ['codex'],
    getAgentCore: () => ({ displayNameKey: 'agent.name' }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeLabelForAgentType: () => 'default',
    getPermissionModeOptionsForAgentType: () => [],
}));

vi.mock('./sessionI18n', () => ({
    getPermissionApplyTimingSubtitleKey: () => 'x',
}));

describe('Session settings (Sub-agent gate)', () => {
    afterEach(() => {
        resetSessionSettingsEntryState();
        executionRunsEnabled = false;
    });

    it('does not render the Sub-agent section when execution runs are disabled', async () => {
        executionRunsEnabled = false;
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('subAgentGuidance.settings.rules.groupTitle')).toBeNull();
    });

    it('does not render the Subagents shortcut when execution runs are enabled', async () => {
        executionRunsEnabled = true;
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderSettingsView(React.createElement(SessionSettingsScreen));

        expect(screen.findRowByTitle('subAgentGuidance.settings.rules.groupTitle')).toBeNull();
    });
});
