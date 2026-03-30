import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';

import { installContextBarCommonModuleMocks } from './contextBarTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const onSelectMachineMock = vi.fn();
const onChangePathMock = vi.fn();
const openMachinePathBrowserModalMock = vi.hoisted(() => vi.fn());

installContextBarCommonModuleMocks({
    unistyles: () =>
        createUnistylesMock({
            theme: {
                colors: {
                    divider: '#ddd',
                    textSecondary: '#666',
                    input: { background: '#fff', text: '#111', placeholder: '#666' },
                    accent: { blue: '#00f', indigo: '#40f' },
                },
            },
        }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.subtitle ?? null),
}));

vi.mock('@/components/ui/text/Text', () => ({
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: (input: unknown) => openMachinePathBrowserModalMock(input),
}));

describe('ContextBar', () => {
    beforeEach(() => {
        onSelectMachineMock.mockReset();
        onChangePathMock.mockReset();
        openMachinePathBrowserModalMock.mockReset();
    });

    it('renders machine and workspace controls in machine_and_workspace mode', async () => {
        const { ContextBar } = await import('./ContextBar');

        const screen = await renderScreen(React.createElement(ContextBar, {
            mode: 'machine_and_workspace',
            machine: {
                selectedId: 'machine-1',
                subtitle: 'Laptop',
                items: [
                    { id: 'machine-1', title: 'Laptop' },
                    { id: 'machine-2', title: 'Desktop' },
                ],
                onSelect: onSelectMachineMock,
            },
            workspace: {
                value: '/repo',
                placeholder: 'Project directory',
                onChange: onChangePathMock,
            },
        }));

        const dropdown = screen.findByType('DropdownMenu');
        const input = screen.findByType('TextInput');
        expect(dropdown).toBeTruthy();
        expect(input).toBeTruthy();

        dropdown.props.onSelect?.('machine-2');
        expect(onSelectMachineMock).toHaveBeenCalledWith('machine-2');

        input.props.onChangeText?.('/repo/subdir');
        expect(onChangePathMock).toHaveBeenCalledWith('/repo/subdir');
    });

    it('omits the workspace input in machine_only mode', async () => {
        const { ContextBar } = await import('./ContextBar');

        const screen = await renderScreen(React.createElement(ContextBar, {
            mode: 'machine_only',
            machine: {
                selectedId: 'machine-1',
                subtitle: 'Laptop',
                items: [{ id: 'machine-1', title: 'Laptop' }],
                onSelect: onSelectMachineMock,
            },
        }));

        expect(screen.findByType('DropdownMenu')).toBeTruthy();
        expect(screen.findAllByType('TextInput')).toHaveLength(0);
    });

    it('uses a custom machine title when provided', async () => {
        const { ContextBar } = await import('./ContextBar');

        const screen = await renderScreen(React.createElement(ContextBar, {
            mode: 'machine_only',
            machine: {
                title: 'settingsProviders.targetMachineTitle',
                selectedId: 'machine-1',
                subtitle: 'Laptop',
                items: [{ id: 'machine-1', title: 'Laptop' }],
                onSelect: onSelectMachineMock,
            },
        }));

        const dropdown = screen.findByType('DropdownMenu');
        expect(dropdown.props.itemTrigger.title).toBe('settingsProviders.targetMachineTitle');
    });

    it('shows a workspace browse button when browse config is provided', async () => {
        openMachinePathBrowserModalMock.mockResolvedValueOnce('/repo/from-browser');
        const { ContextBar } = await import('./ContextBar');

        const screen = await renderScreen(React.createElement(ContextBar, {
            mode: 'workspace_only',
            workspace: {
                value: '/repo',
                placeholder: 'Project directory',
                onChange: onChangePathMock,
                browse: {
                    machineId: 'machine-1',
                    serverId: 'server-1',
                },
            },
        }));

        const browseButton = screen.findByTestId('path-browser-trigger');
        expect(browseButton).toBeTruthy();
        await browseButton?.props?.onPress?.();

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            initialPath: '/repo',
        }));
    });
});
