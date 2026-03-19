import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState: Record<string, any> = {};
let machineListByServerIdState: Record<string, any> = {};
let allMachinesState: any[] = [];
let sessionsState: any[] = [];

vi.mock('react-native', () => ({
    Pressable: (props: any) => React.createElement('Pressable', props, typeof props.children === 'function' ? props.children({ pressed: false }) : props.children),
    View: (props: any) => React.createElement('View', props, props.children),
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@happier-dev/protocol', () => ({
    getActionSpec: () => ({ id: 'session.handoff', title: 'session.handoff.title', description: 'session.handoff.description' }),
    evaluateSessionHandoffWorkspaceTransferSourcePathSafety: (params: {
        sourcePath?: string;
        sourceHomeDir?: string;
        fallbackSourceHomeDir?: string;
    }) => {
        const sourcePath = String(params?.sourcePath ?? '').trim();
        if (sourcePath === '~' || sourcePath === '~/') {
            return { allowed: false, reasonCode: 'path_is_home_directory' };
        }
        const sourceHomeDir = String(params?.sourceHomeDir ?? '').trim() || String(params?.fallbackSourceHomeDir ?? '').trim();
        const samePath = sourcePath === sourceHomeDir;
        return samePath
            ? { allowed: false, reasonCode: 'path_is_home_directory' }
            : { allowed: true, reasonCode: null };
    },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                surface: '#111',
                shadow: { color: '#000' },
                divider: '#333',
                text: '#fff',
                textSecondary: '#aaa',
                header: { tint: '#fff' },
                accent: {
                    blue: '#00f',
                    green: '#0f0',
                    orange: '#f80',
                    indigo: '#80f',
                },
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#111',
                shadow: { color: '#000' },
                divider: '#333',
                text: '#fff',
                textSecondary: '#aaa',
                header: { tint: '#fff' },
                accent: {
                    blue: '#00f',
                    green: '#0f0',
                    orange: '#f80',
                    indigo: '#80f',
                },
            },
        },
    }),
}));

vi.mock('@/modal', () => ({
    Modal: { show: vi.fn() },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: (props: any) => React.createElement('MachineSelector', props),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null, props.children ?? null),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useMachineListByServerId: () => machineListByServerIdState,
    useMachineRecordValues: () => allMachinesState,
    useSessions: () => sessionsState,
    useSettingMutable: (key: string) => [
        settingsState[key],
        (next: any) => {
            settingsState[key] = next;
        },
    ],
}));

vi.mock('@/utils/sessions/recentMachines', () => ({
    getRecentMachinesFromSessions: () => [],
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

describe('SessionHandoffPickerModal', () => {
    beforeEach(() => {
        machineListByServerIdState = {
            server_a: [
                { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
            ],
        };
        allMachinesState = [
            { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
        ];
        sessionsState = [
            {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    path: '/Users/tester/projects/happier',
                    homeDir: '/Users/tester',
                    directSessionV1: { source: 'claudeConfig' },
                },
            },
        ];
        settingsState.favoriteMachines = [];
        settingsState.sessionHandoffDefaultsV1 = {
            v: 1,
            workspaceTransferEnabled: true,
            workspaceTransferStrategy: 'transfer_snapshot',
            conflictPolicy: 'create_sibling_copy',
            includeIgnoredMode: 'include_selected',
            ignoredIncludeGlobs: ['dist/**'],
            directTargetMode: 'convert_to_persisted',
        };
    });

    it('returns the selected machine and default handoff options', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />,
            );
        });

        const machineSelector = tree.root.findByType('MachineSelector' as any);
        expect(machineSelector.props.testIdPrefix).toBe('session-handoff-machine');
        await act(async () => {
            machineSelector.props.onSelect({ id: 'machine_target', metadata: { displayName: 'Target machine' } });
        });

        const startButton = tree.root.findAllByType('RoundButton' as any).find((node: any) => node.props?.testID === 'session-handoff-start');
        expect(startButton).toBeTruthy();
        await act(async () => {
            startButton!.props.onPress();
        });

        expect(onResolve).toHaveBeenCalledWith({
            targetMachineId: 'machine_target',
            targetSessionStorageMode: 'persisted',
            workspaceTransfer: {
                enabled: true,
                strategy: 'transfer_snapshot',
                conflictPolicy: 'create_sibling_copy',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
        });
        expect(onClose).toHaveBeenCalled();
    });

    it('forces workspace transfer off for sessions rooted at the machine home directory', async () => {
        sessionsState = [
            {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    path: '/Users/tester',
                    homeDir: '/Users/tester',
                    directSessionV1: { source: 'claudeConfig' },
                },
            },
        ];
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />,
            );
        });

        const switchNode = tree.root.findByType('Switch' as any);
        expect(switchNode.props.value).toBe(false);
        expect(switchNode.props.disabled).toBe(true);

        const machineSelector = tree.root.findByType('MachineSelector' as any);
        await act(async () => {
            machineSelector.props.onSelect({ id: 'machine_target', metadata: { displayName: 'Target machine' } });
        });

        const startButton = tree.root.findAllByType('RoundButton' as any).find((node: any) => node.props?.testID === 'session-handoff-start');
        await act(async () => {
            startButton!.props.onPress();
        });

        expect(onResolve).toHaveBeenCalledWith({
            targetMachineId: 'machine_target',
            targetSessionStorageMode: 'persisted',
        });
        expect(onClose).toHaveBeenCalled();
    });

    it('forces workspace transfer off when session metadata is missing homeDir but the source machine home directory matches the path', async () => {
        sessionsState = [
            {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    path: '/Users/tester',
                },
            },
        ];
        machineListByServerIdState = {
            server_a: [
                { id: 'machine_source', metadata: { displayName: 'Source machine', host: 'source.local', homeDir: '/Users/tester' } },
                { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
            ],
        };
        allMachinesState = [
            { id: 'machine_source', metadata: { displayName: 'Source machine', host: 'source.local', homeDir: '/Users/tester' } },
            { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
        ];

        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />,
            );
        });

        const switchNode = tree.root.findByType('Switch' as any);
        expect(switchNode.props.value).toBe(false);
        expect(switchNode.props.disabled).toBe(true);
    });

    it('falls back to current session machineId when sourceMachineId prop is missing', async () => {
        sessionsState = [
            {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    path: '/Users/tester',
                },
            },
        ];
        machineListByServerIdState = {
            server_a: [
                { id: 'machine_source', metadata: { displayName: 'Source machine', host: 'source.local', homeDir: '/Users/tester' } },
                { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
            ],
        };
        allMachinesState = [
            { id: 'machine_source', metadata: { displayName: 'Source machine', host: 'source.local', homeDir: '/Users/tester' } },
            { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
        ];

        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    serverId="server_a"
                />,
            );
        });

        const switchNode = tree.root.findByType('Switch' as any);
        expect(switchNode.props.value).toBe(false);
        expect(switchNode.props.disabled).toBe(true);

        const machineSelector = tree.root.findByType('MachineSelector' as any);
        expect(machineSelector.props.machines).toEqual([
            { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
        ]);
    });

    it('forces workspace transfer off for home-directory shorthand paths', async () => {
        sessionsState = [
            {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    path: '~',
                },
            },
        ];

        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    serverId="server_a"
                />,
            );
        });

        const switchNode = tree.root.findByType('Switch' as any);
        expect(switchNode.props.value).toBe(false);
        expect(switchNode.props.disabled).toBe(true);
    });

    it('omits workspace transfer from the picker result when transfer stays disabled', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />,
            );
        });

        const machineSelector = tree.root.findByType('MachineSelector' as any);
        await act(async () => {
            machineSelector.props.onSelect({ id: 'machine_target', metadata: { displayName: 'Target machine' } });
        });

        const switchNode = tree.root.findByType('Switch' as any);
        await act(async () => {
            switchNode.props.onValueChange(false);
        });

        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
        const strategyMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.workspaceTransfer.strategy.title');
        const conflictMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.conflictPolicy.title');
        const directModeMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.directTargetMode.title');
        const ignoredMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.includeIgnoredMode.title');

        expect(strategyMenu?.props?.itemTrigger?.itemProps).toMatchObject({
            testID: 'session-handoff-workspace-transfer-strategy-trigger',
        });

        await act(async () => {
            strategyMenu!.props.onSelect('sync_changes');
            conflictMenu!.props.onSelect('replace_existing');
            ignoredMenu!.props.onSelect('include_selected');
            directModeMenu!.props.onSelect('keep_direct');
        });

        const globInput = tree.root.findByType('TextInput' as any);
        await act(async () => {
            globInput.props.onChangeText('dist/**, .env.local');
        });

        const startButton = tree.root.findAllByType('RoundButton' as any).find((node: any) => node.props?.title === 'session.handoff.title');
        await act(async () => {
            startButton!.props.onPress();
        });

        expect(onResolve).toHaveBeenCalledWith({
            targetMachineId: 'machine_target',
            targetSessionStorageMode: 'direct',
        });
    });

    it('falls back to the active machine record when the server-scoped list lags behind', async () => {
        machineListByServerIdState = {
            server_a: [
                { id: 'machine_source', metadata: { displayName: 'Source machine', host: 'source.local' } },
            ],
        };
        allMachinesState = [
            { id: 'machine_source', metadata: { displayName: 'Source machine', host: 'source.local' } },
            { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
        ];

        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />,
            );
        });

        const machineSelector = tree.root.findByType('MachineSelector' as any);
        expect(machineSelector.props.machines).toEqual([
            { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
        ]);
    });
});
