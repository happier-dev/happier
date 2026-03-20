import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Platform: {
        OS: 'web',
        select: (options: Record<string, unknown>) => options?.web ?? options?.default,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: {
                    blue: 'blue',
                    orange: 'orange',
                    indigo: 'indigo',
                },
            },
        },
    }),
}));

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
        await act(async () => {
            tree = renderer.create(React.createElement(MachineSetupFlowScreen));
        });

        const itemTitles = tree.root.findAllByType('Item' as any).map((node: any) => node.props.title);

        expect(itemTitles).toContain('settings.machineSetupCurrentMachineTitle');
        expect(itemTitles).toContain('settings.machineSetupSshMachineTitle');
        expect(itemTitles).toContain('settings.machineSetupStageConnect');
        expect(itemTitles).toContain('settings.machineSetupStageInstall');
        expect(itemTitles).toContain('settings.machineSetupStageFinish');
    });
});
