import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const setAcpSettingsSpy = vi.fn();
const modalConfirmSpy = vi.fn(async () => true);
const settingsState: { value: AcpCatalogSettingsV1 } = {
    value: {
        v: 2,
        backends: [],
    },
};

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    AppState: {
        currentState: 'active',
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
    Platform: {
        OS: 'web',
        select: <T,>(options: { default?: T; web?: T }) => options.web ?? options.default ?? null,
    },
    Dimensions: { get: () => ({ width: 1440, height: 900 }) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => {
            const theme = {
                colors: {
                    text: '#fff',
                    textSecondary: '#999',
                    textDestructive: '#f00',
                    success: '#0f0',
                    divider: '#333',
                    input: { background: '#111', text: '#fff', placeholder: '#777' },
                    groupped: { background: '#111', sectionTitle: '#999' },
                    surface: '#222',
                    button: {
                        primary: { background: '#08f', tint: '#fff' },
                        secondary: { background: '#222', tint: '#fff' },
                    },
                    accent: { purple: '#a0f', blue: '#00f', indigo: '#44f', green: '#0f0', orange: '#f80' },
                },
            };
            return typeof factory === 'function' ? factory(theme) : factory;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#fff',
                textSecondary: '#999',
                textDestructive: '#f00',
                success: '#0f0',
                divider: '#333',
                input: { background: '#111', text: '#fff', placeholder: '#777' },
                groupped: { background: '#111', sectionTitle: '#999' },
                surface: '#222',
                button: {
                    primary: { background: '#08f', tint: '#fff' },
                    secondary: { background: '#222', tint: '#fff' },
                },
                accent: { purple: '#a0f', blue: '#00f', indigo: '#44f', green: '#0f0', orange: '#f80' },
            },
        },
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.subtitle ?? null, props.rightElement ?? null),
}));

vi.mock('@/modal', () => ({
    Modal: { show: vi.fn(), alert: vi.fn(), confirm: modalConfirmSpy },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? { key, params } : key),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => {
        if (key === 'acpCatalogSettingsV1') {
            return [settingsState.value, setAcpSettingsSpy];
        }
        if (key === 'secrets') return [[], vi.fn()];
        return [null, vi.fn()];
    },
}));

describe('AcpCatalogSettingsScreen', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
        setAcpSettingsSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalConfirmSpy.mockResolvedValue(true);
        settingsState.value = {
            v: 2,
            backends: [
                {
                    id: 'custom-kiro',
                    name: 'custom-kiro',
                    title: 'Custom Kiro',
                    description: 'ACP backend',
                    command: 'kiro-cli',
                    args: ['acp', '--agent', 'spec'],
                    env: {},
                    transportProfile: 'kiro',
                    defaultMode: 'plan',
                    defaultModel: 'sonnet',
                    capabilities: {
                        supportsLoadSession: true,
                        supportsModes: 'yes',
                        supportsModels: 'yes',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'yes',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };
    });

    function findByTestId(tree: ReactTestRenderer, testID: string) {
        return tree.root.findAll((node) => node.props?.testID === testID)[0] ?? null;
    }

    it('renders built-in and configured backends and routes backend actions to the backend editor', async () => {
        const { AcpCatalogSettingsScreen } = await import('./AcpCatalogSettingsScreen');
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(AcpCatalogSettingsScreen));
        });

        const builtInKiroRow = findByTestId(tree, 'settings.acpCatalog.builtIn.kiro');
        const builtInCustomAcpRow = findByTestId(tree, 'settings.acpCatalog.builtIn.customAcp');
        const backendRow = findByTestId(tree, 'settings.acpCatalog.backend.custom-kiro');
        const addBackendRow = findByTestId(tree, 'settings.acpCatalog.addBackend');
        const addPresetRow = findByTestId(tree, 'settings.acpCatalog.addPreset');
        const emptyBackendsRow = findByTestId(tree, 'settings.acpCatalog.backends.empty');
        const groups = tree.root.findAllByType('ItemGroup' as any);
        const untitledGroups = groups.filter((group) => group.props.title === undefined);

        expect(builtInKiroRow).toBeTruthy();
        expect(builtInCustomAcpRow).toBeNull();
        expect(backendRow).toBeTruthy();
        expect(backendRow?.props.title).toBe('Custom Kiro');
        expect(addBackendRow).toBeTruthy();
        expect(addPresetRow).toBeNull();
        expect(emptyBackendsRow).toBeNull();
        expect(untitledGroups).toHaveLength(1);

        await act(async () => {
            addBackendRow!.props.onPress();
        });
        await act(async () => {
            backendRow!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenNthCalledWith(1, '/(app)/settings/acp-backend');
        expect(routerPushSpy).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                pathname: '/(app)/settings/acp-backend',
                params: { backendId: 'custom-kiro' },
            }),
        );
    });

    it('shows only the add backend row inside the titled custom backends group when no configured backends exist', async () => {
        settingsState.value = {
            v: 2,
            backends: [],
        };

        const { AcpCatalogSettingsScreen } = await import('./AcpCatalogSettingsScreen');
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(AcpCatalogSettingsScreen));
        });

        const addBackendRow = findByTestId(tree, 'settings.acpCatalog.addBackend');
        const emptyBackendsRow = findByTestId(tree, 'settings.acpCatalog.backends.empty');
        const backendRows = tree.root.findAll((node) => node.props?.testID?.startsWith?.('settings.acpCatalog.backend.'));
        const groups = tree.root.findAllByType('ItemGroup' as any);
        const customBackendsGroup = groups.find((group) => group.props.title === 'settings.acpCatalogBackends') ?? null;
        const untitledGroups = groups.filter((group) => group.props.title === undefined);

        expect(addBackendRow).toBeTruthy();
        expect(emptyBackendsRow).toBeNull();
        expect(backendRows).toHaveLength(0);
        expect(customBackendsGroup).toBeTruthy();
        expect(untitledGroups).toHaveLength(0);
    });
});
