import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const eraseKnownPlugin = vi.hoisted(() => vi.fn(async (_pluginId: string) => {}));
const eraseOrphanedPlugin = vi.hoisted(() => vi.fn(async () => {}));
const retire = vi.hoisted(() => vi.fn());
const createRecoveryController = vi.hoisted(() => vi.fn(() => {
    let retired = false;
    return {
        eraseKnownPlugin: async (pluginId: string) => {
            if (!retired) await eraseKnownPlugin(pluginId);
        },
        eraseOrphanedPlugin: async () => {
            if (!retired) await eraseOrphanedPlugin();
        },
        retire: () => {
            retired = true;
            retire();
        },
        isPending: () => false,
    };
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/icons/Icon', () => ({ Icon: 'Icon' }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('./pluginAccountDataEraseRecoveryController', () => ({
    createPluginAccountDataEraseRecoveryController: createRecoveryController,
}));

afterEach(() => {
    standardCleanup();
    eraseKnownPlugin.mockClear();
    eraseOrphanedPlugin.mockClear();
    retire.mockClear();
    createRecoveryController.mockClear();
});

describe('PluginAccountDataEraseRecoverySection', () => {
    it('presents the installed plugin path through the same recovery controller', async () => {
        const { PluginAccountDataEraseRecoverySection } = await import('./PluginAccountDataEraseRecoverySection');
        const screen = await renderScreen(
            <PluginAccountDataEraseRecoverySection
                pluginId="example.installed-plugin"
                testID="settings.plugins.detail.example.installed-plugin.accountDataErase"
            />,
        );

        const row = screen.findByTestId('settings.plugins.detail.example.installed-plugin.accountDataErase');
        expect(row?.props.destructive).toBe(true);
        await act(async () => {
            row?.props.onPress();
            await Promise.resolve();
        });
        expect(eraseKnownPlugin).toHaveBeenCalledExactlyOnceWith('example.installed-plugin');
        expect(eraseOrphanedPlugin).not.toHaveBeenCalled();
    });

    it('keeps the mounted installed-plugin recovery available through the StrictMode effect replay', async () => {
        const { PluginAccountDataEraseRecoverySection } = await import('./PluginAccountDataEraseRecoverySection');
        const screen = await renderScreen(
            <React.StrictMode>
                <PluginAccountDataEraseRecoverySection
                    pluginId="example.installed-plugin"
                    testID="settings.plugins.detail.example.installed-plugin.accountDataErase"
                />
            </React.StrictMode>,
        );

        const row = screen.findByTestId('settings.plugins.detail.example.installed-plugin.accountDataErase');
        await act(async () => {
            row?.props.onPress();
            await Promise.resolve();
        });

        expect(eraseKnownPlugin).toHaveBeenCalledExactlyOnceWith('example.installed-plugin');
    });

    it('keeps an orphaned id reachable from Settings without requiring an installed catalog entry', async () => {
        const { PluginAccountDataEraseRecoverySection } = await import('./PluginAccountDataEraseRecoverySection');
        const screen = await renderScreen(
            <PluginAccountDataEraseRecoverySection testID="settings.plugins.accountDataErase" />,
        );

        const row = screen.findByTestId('settings.plugins.accountDataErase');
        await act(async () => {
            row?.props.onPress();
            await Promise.resolve();
        });
        expect(eraseOrphanedPlugin).toHaveBeenCalledTimes(1);
        expect(eraseKnownPlugin).not.toHaveBeenCalled();
    });
});
