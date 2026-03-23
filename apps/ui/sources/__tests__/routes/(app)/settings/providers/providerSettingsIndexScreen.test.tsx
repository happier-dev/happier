import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from '../sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSettingsEntryModuleMocks({
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#999',
                },
            },
        });
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'backendEnabledByTargetKey') return {};
                    return undefined;
                },
            },
        });
    },
});

vi.mock('@/components/settings/acpCatalog/AcpCatalogSettingsSections', () => ({
    AcpCatalogSettingsSections: () => React.createElement('AcpCatalogSettingsSections'),
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        AGENT_IDS: ['codex', 'customAcp', 'kiro'],
        getAgentCore: (agentId: string) => ({
            displayNameKey: `agent.${agentId}`,
            availability: { experimental: agentId === 'kiro' },
            ui: { agentPickerIconName: 'code-slash-outline' },
        }),
    };
});

afterEach(() => {
    resetSessionSettingsEntryState();
    standardCleanup();
});

describe('ProviderSettingsIndexScreen', () => {
    it('renders built-in providers without custom ACP and includes ACP backend sections', async () => {
        const Screen = (await import('@/app/(app)/settings/providers')).default;
        const screen = await renderSettingsView(React.createElement(Screen));

        expect(screen.findRowByTitle('agent.codex')).toBeTruthy();
        expect(screen.findRowByTitle('agent.kiro')).toBeTruthy();
        expect(screen.findRowByTitle('agent.customAcp')).toBeFalsy();

        const acpSections = screen.findAllByType('AcpCatalogSettingsSections' as any);
        expect(acpSections).toHaveLength(1);

        await act(async () => {
            screen.pressRowByTitle('agent.codex');
        });

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/providers/codex');
    });
});
