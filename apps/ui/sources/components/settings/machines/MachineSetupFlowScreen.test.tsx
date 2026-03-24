import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';


(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: {
                        blue: 'blue',
                        orange: 'orange',
                        indigo: 'indigo',
                    },
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('Group', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

describe('MachineSetupFlowScreen', () => {
    it('renders local and SSH bootstrap entry points alongside the setup stages', async () => {
        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(MachineSetupFlowScreen))).tree;

        const itemTitles = tree.findAllByType('Item' as any).map((node: any) => node.props.title);

        expect(itemTitles).toContain('settings.machineSetupCurrentMachineTitle');
        expect(itemTitles).toContain('settings.machineSetupSshMachineTitle');
        expect(itemTitles).toContain('settings.machineSetupStageConnect');
        expect(itemTitles).toContain('settings.machineSetupStageInstall');
        expect(itemTitles).toContain('settings.machineSetupStageFinish');
    });
});
