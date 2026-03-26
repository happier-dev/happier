import * as React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSessionHandoffCommonModuleMocks } from './sessionHandoffTestHelpers';

const refreshMachinesThrottledMock = vi.fn(async () => {});
let credentialsReady = true;


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState: Record<string, any> = {};
let machineListByServerIdState: Record<string, any> = {};
let allMachinesState: any[] = [];
let sessionsState: any[] = [];
let sessionsByIdState: Record<string, any> = {};

vi.mock('@happier-dev/protocol', () => ({
    getActionSpec: () => ({ id: 'session.handoff', title: 'session.handoff.title', description: 'session.handoff.description' }),
    evaluateSessionHandoffWorkspaceTransferSourcePathSafety: (params: {
        sourcePath?: string;
        sourceHomeDir?: string;
        fallbackSourceHomeDir?: string;
    }) => {
        const rawSourcePath = String(params?.sourcePath ?? '').trim();
        if (!rawSourcePath) {
            return { allowed: false, reasonCode: 'missing_source_path' };
        }
        if (rawSourcePath === '~' || rawSourcePath === '~/') {
            return { allowed: false, reasonCode: 'path_is_home_directory' };
        }
        const isAbsolute = rawSourcePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rawSourcePath) || /^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/.test(rawSourcePath);
        if (!isAbsolute) {
            return { allowed: false, reasonCode: 'path_is_not_absolute' };
        }
        const sourceHomeDir = String(params?.sourceHomeDir ?? '').trim() || String(params?.fallbackSourceHomeDir ?? '').trim();
        const samePath = rawSourcePath === sourceHomeDir;
        return samePath
            ? { allowed: false, reasonCode: 'path_is_home_directory' }
            : { allowed: true, reasonCode: null };
    },
}));

installSessionHandoffCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useMachineListByServerId: () => machineListByServerIdState,
            useMachineRecordValues: () => allMachinesState,
            useSessions: () => sessionsState,
            useSession: (id: string) => sessionsByIdState[id] ?? null,
            useSettingMutable: (key: string) => [
                settingsState[key],
                (next: any) => {
                    settingsState[key] = next;
                },
            ],
        });
    },
});

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

vi.mock('@/utils/sessions/recentMachines', () => ({
    getRecentMachinesFromSessions: () => [],
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: refreshMachinesThrottledMock,
        getCredentials: () => (credentialsReady ? ({ token: 'test' } as any) : null),
    },
}));

describe('SessionHandoffPickerModal', () => {
    beforeEach(() => {
        refreshMachinesThrottledMock.mockClear();
        credentialsReady = true;
        machineListByServerIdState = {
            server_a: [
                { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
            ],
        };
        allMachinesState = [
            { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
        ];
        sessionsByIdState = {
            sess_1: {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    path: '~/projects/happier',
                    homeDir: '/Users/tester',
                    directSessionV1: { source: 'claudeConfig' },
                },
            },
        };
        sessionsState = [
            {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    // Session list view may format the path relative to home; the picker must use the canonical
                    // session record path for safety decisions (not the display string).
                    path: '~',
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
        tree = (await renderScreen(<SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />)).tree;

        await act(async () => {});
        expect(refreshMachinesThrottledMock).toHaveBeenCalled();

        const machineSelector = tree.findByType('MachineSelector' as any);
        expect(machineSelector.props.testIdPrefix).toBe('session-handoff-machine');
        await act(async () => {
            invokeTestInstanceHandler(machineSelector, 'onSelect', { id: 'machine_target', metadata: { displayName: 'Target machine' } });
        });

        const startButton = findTestInstanceByTypeWithProps(tree, 'RoundButton' as any, { testID: 'session-handoff-start' });
        expect(startButton).toBeTruthy();
        await act(async () => {
            await pressTestInstanceAsync(startButton!);
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
        expect(onClose).not.toHaveBeenCalled();
    });

    it('forces conflictPolicy=replace_existing when workspace transfer strategy is sync_changes', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(<SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />)).tree;

        await act(async () => {});

        const machineSelector = tree.findByType('MachineSelector' as any);
        await act(async () => {
            invokeTestInstanceHandler(machineSelector, 'onSelect', { id: 'machine_target', metadata: { displayName: 'Target machine' } });
        });

        const dropdowns = tree.findAllByType('DropdownMenu' as any);
        const strategyMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.workspaceTransfer.strategy.title');
        const conflictMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.conflictPolicy.title');

        expect(strategyMenu).toBeTruthy();
        expect(conflictMenu).toBeTruthy();
        expect(conflictMenu?.props.selectedId).toBe('create_sibling_copy');

        await act(async () => {
            invokeTestInstanceHandler(strategyMenu!, 'onSelect', 'sync_changes');
        });

        const dropdownsAfter = tree.findAllByType('DropdownMenu' as any);
        const conflictMenuAfter = dropdownsAfter.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.conflictPolicy.title');
        expect(conflictMenuAfter?.props.selectedId).toBe('replace_existing');

        const startButton = findTestInstanceByTypeWithProps(tree, 'RoundButton' as any, { testID: 'session-handoff-start' });
        await act(async () => {
            await pressTestInstanceAsync(startButton!);
        });

        expect(onResolve).toHaveBeenCalledWith({
            targetMachineId: 'machine_target',
            targetSessionStorageMode: 'persisted',
            workspaceTransfer: {
                enabled: true,
                strategy: 'sync_changes',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'include_selected',
                ignoredIncludeGlobs: ['dist/**'],
            },
        });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('forces workspace transfer off for sessions rooted at the machine home directory', async () => {
        sessionsByIdState = {
            sess_1: {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    path: '/Users/tester',
                    homeDir: '/Users/tester',
                    directSessionV1: { source: 'claudeConfig' },
                },
            },
        };
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
        tree = (await renderScreen(<SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />)).tree;

        const switchNode = tree.findByType('Switch' as any);
        expect(switchNode.props.value).toBe(false);
        expect(switchNode.props.disabled).toBe(true);

        const machineSelector = tree.findByType('MachineSelector' as any);
        await act(async () => {
            invokeTestInstanceHandler(machineSelector, 'onSelect', { id: 'machine_target', metadata: { displayName: 'Target machine' } });
        });

        const startButton = findTestInstanceByTypeWithProps(tree, 'RoundButton' as any, { testID: 'session-handoff-start' });
        await act(async () => {
            await pressTestInstanceAsync(startButton!);
        });

        expect(onResolve).toHaveBeenCalledWith({
            targetMachineId: 'machine_target',
            targetSessionStorageMode: 'persisted',
        });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('forces workspace transfer off when session metadata is missing homeDir but the source machine home directory matches the path', async () => {
        sessionsByIdState = {
            sess_1: {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    path: '/Users/tester',
                },
            },
        };
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
        tree = (await renderScreen(<SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />)).tree;

        const switchNode = tree.findByType('Switch' as any);
        expect(switchNode.props.value).toBe(false);
        expect(switchNode.props.disabled).toBe(true);
    });

    it('falls back to current session machineId when sourceMachineId prop is missing', async () => {
        sessionsByIdState = {
            sess_1: {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    path: '/Users/tester',
                },
            },
        };
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
        tree = (await renderScreen(<SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    serverId="server_a"
                />)).tree;

        const switchNode = tree.findByType('Switch' as any);
        expect(switchNode.props.value).toBe(false);
        expect(switchNode.props.disabled).toBe(true);

        const machineSelector = tree.findByType('MachineSelector' as any);
        expect(machineSelector.props.machines).toEqual([
            { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
        ]);
    });

    it('forces workspace transfer off for home-directory shorthand paths', async () => {
        sessionsByIdState = {
            sess_1: {
                id: 'sess_1',
                metadata: {
                    flavor: 'claude',
                    machineId: 'machine_source',
                    path: '~',
                },
            },
        };
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
        tree = (await renderScreen(<SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    serverId="server_a"
                />)).tree;

        const switchNode = tree.findByType('Switch' as any);
        expect(switchNode.props.value).toBe(false);
        expect(switchNode.props.disabled).toBe(true);
    });

    it('omits workspace transfer from the picker result when transfer stays disabled', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(<SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />)).tree;

        const machineSelector = tree.findByType('MachineSelector' as any);
        await act(async () => {
            invokeTestInstanceHandler(machineSelector, 'onSelect', { id: 'machine_target', metadata: { displayName: 'Target machine' } });
        });

        const switchNode = tree.findByType('Switch' as any);
        await act(async () => {
            invokeTestInstanceHandler(switchNode, 'onValueChange', false);
        });

        const dropdowns = tree.findAllByType('DropdownMenu' as any);
        const strategyMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.workspaceTransfer.strategy.title');
        const conflictMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.conflictPolicy.title');
        const directModeMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.directTargetMode.title');
        const ignoredMenu = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.includeIgnoredMode.title');

        expect(strategyMenu?.props?.itemTrigger?.itemProps).toMatchObject({
            testID: 'session-handoff-workspace-transfer-strategy-trigger',
            disabled: true,
        });
        expect(conflictMenu?.props?.itemTrigger?.itemProps).toMatchObject({ disabled: true });
        expect(ignoredMenu?.props?.itemTrigger?.itemProps).toMatchObject({ disabled: true });

        await act(async () => {
            invokeTestInstanceHandler(strategyMenu!, 'onSelect', 'sync_changes');
            conflictMenu!.props.onSelect('replace_existing');
            ignoredMenu!.props.onSelect('include_selected');
            directModeMenu!.props.onSelect('keep_direct');
        });

        const globInput = tree.findByType('TextInput' as any);
        expect(globInput.props.editable).toBe(false);
        await act(async () => {
            globInput.props.onChangeText('dist/**, .env.local');
        });

        const dropdownsAfterAttempt = tree.findAllByType('DropdownMenu' as any);
        const strategyMenuAfterAttempt = dropdownsAfterAttempt.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.workspaceTransfer.strategy.title');
        const conflictMenuAfterAttempt = dropdownsAfterAttempt.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.conflictPolicy.title');
        const ignoredMenuAfterAttempt = dropdownsAfterAttempt.find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.handoff.includeIgnoredMode.title');

        expect(strategyMenuAfterAttempt?.props.selectedId).toBe('transfer_snapshot');
        expect(conflictMenuAfterAttempt?.props.selectedId).toBe('create_sibling_copy');
        expect(ignoredMenuAfterAttempt?.props.selectedId).toBe('include_selected');
        expect(tree.findByType('TextInput' as any).props.value).toBe('dist/**');

        const startButton = findTestInstanceByTypeWithProps(tree, 'RoundButton' as any, { title: 'session.handoff.title' });
        await act(async () => {
            await pressTestInstanceAsync(startButton!);
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
        tree = (await renderScreen(<SessionHandoffPickerModal
                    onClose={onClose}
                    onResolve={onResolve}
                    sessionId="sess_1"
                    sourceMachineId="machine_source"
                    serverId="server_a"
                />)).tree;

        const machineSelector = tree.findByType('MachineSelector' as any);
        expect(machineSelector.props.machines).toEqual([
            { id: 'machine_target', metadata: { displayName: 'Target machine', host: 'target.local' } },
        ]);
    });

    it('retries the machine refresh once credentials are hydrated', async () => {
        vi.useFakeTimers();
        credentialsReady = false;

        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { SessionHandoffPickerModal } = await import('./SessionHandoffPickerModal');

        await renderScreen(<SessionHandoffPickerModal
            onClose={onClose}
            onResolve={onResolve}
            sessionId="sess_1"
            sourceMachineId="machine_source"
            serverId="server_a"
        />);

        await act(async () => {});
        expect(refreshMachinesThrottledMock).not.toHaveBeenCalled();

        credentialsReady = true;
        await vi.advanceTimersByTimeAsync(300);
        await act(async () => {});

        expect(refreshMachinesThrottledMock).toHaveBeenCalled();
        vi.useRealTimers();
    });
});
