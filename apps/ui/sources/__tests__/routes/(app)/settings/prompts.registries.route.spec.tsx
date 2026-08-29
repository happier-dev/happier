import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useFeatureEnabledMock = vi.hoisted(() => vi.fn());
const machinePromptRegistriesListAdaptersMock = vi.hoisted(() => vi.fn());
const machinePromptRegistriesListSourcesMock = vi.hoisted(() => vi.fn());
const machinePromptRegistriesScanSourceMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledMock(featureId),
}));

vi.mock('@/sync/ops/machinePromptRegistries', () => ({
    machinePromptRegistriesListAdapters: (...args: unknown[]) => machinePromptRegistriesListAdaptersMock(...args),
    machinePromptRegistriesListSources: (...args: unknown[]) => machinePromptRegistriesListSourcesMock(...args),
    machinePromptRegistriesScanSource: (...args: unknown[]) => machinePromptRegistriesScanSourceMock(...args),
}));

describe('Prompt registries route', () => {
    beforeEach(() => {
        vi.resetModules();
        useFeatureEnabledMock.mockReset();
        machinePromptRegistriesListAdaptersMock.mockReset();
        machinePromptRegistriesListSourcesMock.mockReset();
        machinePromptRegistriesScanSourceMock.mockReset();

        useFeatureEnabledMock.mockReturnValue(true);
        machinePromptRegistriesListAdaptersMock.mockResolvedValue({ ok: true, adapters: [] });
        machinePromptRegistriesListSourcesMock.mockResolvedValue({ ok: true, sources: [] });
        machinePromptRegistriesScanSourceMock.mockResolvedValue({ ok: true, items: [] });
    });

    it('renders the prompt registries screen when the feature is enabled', async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');

        vi.doMock('expo-router', () => createExpoRouterMock().module);
        vi.doMock('@/text', () => createTextModuleMock({ translate: (key: string) => key }));
        vi.doMock('@/modal', () => createModalModuleMock().module);
        vi.doMock('react-native', () => createReactNativeWebMock());
        vi.doMock('react-native-unistyles', () => createUnistylesMock());
        vi.doMock('@/sync/domains/state/storage', async (importOriginal) => {
            const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
            return createStorageModuleStub({
                importOriginal,
                useAllMachines: () => [{ id: 'machine-1', metadata: { displayName: 'Machine One', host: 'machine-one' } }],
                useSettingMutable: (key: string) => {
                    if (key === 'promptRegistrySourcesV1') {
                        return [{ v: 1, sources: [] }, vi.fn()] as const;
                    }
                    return [null, vi.fn()] as const;
                },
            });
        });

        const { default: PromptRegistriesRoute } = await import('@/app/(app)/settings/prompts/registries');

        const screen = await renderSettingsView(React.createElement(PromptRegistriesRoute));
        expect(screen.findByTestId('promptRegistries.addGitSource')).toBeTruthy();
    });
});
