import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fetchSpy = vi.fn();

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Text: 'Text',
            TextInput: 'TextInput',
            Platform: {
                OS: 'web',
                select: (options: any) => (options && 'default' in options ? options.default : undefined),
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSettingMutable: () => [false, vi.fn()],
            useSetting: (key: string) => {
                if (key === 'serverSelectionGroups') return [];
                if (key === 'serverSelectionActiveTargetKind') return null;
                if (key === 'serverSelectionActiveTargetId') return null;
                if (key === 'experiments') return false;
                if (key === 'featureToggles') return {};
                if (key === 'useProfiles') return false;
                if (key === 'sessionUseTmux') return false;
                return null;
            },
            useEntitlement: () => false,
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useProfile: () => ({ id: 'prof_1', firstName: '', connectedServices: [] }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => true),
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: any) => React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/icons/SafeIonicons', () => ({
    SafeIonicons: 'SafeIonicons',
}));

afterEach(() => {
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
});

describe('PluginMarketplaceSettingsScreen', () => {
    it('loads curated descriptors from a catalog URL and keeps them descriptor-only', async () => {
        vi.stubGlobal('fetch', fetchSpy);
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://catalog.example.test/plugins.json',
                title: 'Curated plugins',
                description: 'Descriptor-only plugin discovery',
                entries: [
                    {
                        id: 'sample-plugin',
                        displayName: 'Sample Plugin',
                        description: 'Shows descriptor metadata',
                        version: '1.2.3',
                        source: {
                            kind: 'archive',
                            locator: 'https://catalog.example.test/sample-plugin.tgz',
                            trustPolicy: 'local_trusted',
                            installPolicy: 'managed_install',
                        },
                    },
                    {
                        id: 'lightweight',
                        displayName: 'Lightweight Descriptor',
                        version: '0.0.1',
                    },
                ],
            }),
        } as any);

        const { PluginMarketplaceSettingsScreen } = await import('./PluginMarketplaceSettingsScreen');
        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSettingsScreen));

        await act(async () => {
            screen.changeTextByTestId('settings.plugins.marketplace.catalogUrl', 'https://catalog.example.test/plugins.json');
        });
        await act(async () => {
            await screen.pressByTestIdAsync('settings.plugins.marketplace.loadCatalog');
        });

        expect(fetchSpy).toHaveBeenCalledWith('https://catalog.example.test/plugins.json', expect.objectContaining({
            headers: expect.objectContaining({
                accept: 'application/json',
            }),
        }));

        const sampleRow = screen.findRow('settings.plugins.marketplace.entry.sample-plugin');
        const lightweightRow = screen.findRow('settings.plugins.marketplace.entry.lightweight');

        expect(sampleRow).toBeTruthy();
        expect(sampleRow?.props.title).toBe('Sample Plugin');
        expect(sampleRow?.props.subtitle).toBe('Shows descriptor metadata');
        expect(sampleRow?.props.onPress).toBeUndefined();

        expect(lightweightRow).toBeTruthy();
        expect(lightweightRow?.props.title).toBe('Lightweight Descriptor');
        expect(lightweightRow?.props.subtitle).toBeNull();
    });

    it('clears the previously loaded catalog when a reload fails', async () => {
        vi.stubGlobal('fetch', fetchSpy);
        fetchSpy
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    t: 'happier_plugin_marketplace_catalog_v1',
                    schemaVersion: 1,
                    sourceUrl: 'https://catalog.example.test/plugins.json',
                    title: 'Curated plugins',
                    description: 'Descriptor-only plugin discovery',
                    entries: [
                        {
                            id: 'sample-plugin',
                            displayName: 'Sample Plugin',
                            description: 'Shows descriptor metadata',
                            version: '1.2.3',
                        },
                    ],
                }),
            } as any)
            .mockRejectedValueOnce(new Error('Catalog unavailable'));

        const { PluginMarketplaceSettingsScreen } = await import('./PluginMarketplaceSettingsScreen');
        const screen = await renderSettingsView(React.createElement(PluginMarketplaceSettingsScreen));

        await act(async () => {
            screen.changeTextByTestId('settings.plugins.marketplace.catalogUrl', 'https://catalog.example.test/plugins.json');
        });
        await act(async () => {
            await screen.pressByTestIdAsync('settings.plugins.marketplace.loadCatalog');
        });

        const loadedRow = screen.findRow('settings.plugins.marketplace.entry.sample-plugin');
        expect(loadedRow).toBeTruthy();
        expect(loadedRow?.props.title).toBe('Sample Plugin');

        await act(async () => {
            screen.changeTextByTestId('settings.plugins.marketplace.catalogUrl', 'https://catalog.example.test/broken.json');
        });
        await act(async () => {
            await screen.pressByTestIdAsync('settings.plugins.marketplace.loadCatalog');
        });

        expect(screen.findRow('settings.plugins.marketplace.entry.sample-plugin')).toBeNull();
        const errorRow = screen
            .findAllByType('Item' as never)
            .find((node) => node.props?.subtitle === 'Catalog unavailable');
        expect(errorRow).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('Curated plugins');
        expect(screen.getTextContent()).not.toContain('https://catalog.example.test/plugins.json');
    });
});
