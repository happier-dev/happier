import * as React from 'react';
import { act } from 'react-test-renderer';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderScreen } from '@/dev/testkit';
import type { McpServerBindingV1 } from '@happier-dev/protocol';

import {
    installMcpServersCommonModuleMocks,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installMcpServersCommonModuleMocks();

vi.mock('@/components/ui/forms/InlineAddExpander', () => ({
    InlineAddExpander: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('InlineAddExpander', props, props.children),
}));

describe('McpWorkspaceRootPickerModal openers', () => {
    beforeEach(() => {
        resetMcpServersCommonModuleMockState();
    });

    it('passes the selected machine platform from the binding editor into the workspace-root picker', async () => {
        const machine = createMachineFixture({
            id: 'machine-win',
            metadata: {
                host: 'win.local',
                platform: 'win32',
                happyCliVersion: '0.0.0-test',
                happyHomeDir: 'C:\\Users\\Ada\\.happier',
                homeDir: 'C:\\Users\\Ada',
            },
        });
        const binding: McpServerBindingV1 = {
            id: 'binding-1',
            serverId: 'server-1',
            enabled: true,
            target: { t: 'workspace', machineId: 'machine-win', workspaceRoot: 'C:\\repo' },
            createdAt: 1,
            updatedAt: 1,
        };
        const { McpServerBindingEditor } = await import('./McpServerBindingEditor');

        const screen = await renderScreen(
            <McpServerBindingEditor
                binding={binding}
                serverTransport="stdio"
                secrets={[]}
                onChangeSecrets={() => {}}
                machines={[machine]}
                onChange={() => {}}
                onDelete={() => {}}
            />,
        );

        const workspaceRootRow = screen.findAllByType('Item')
            .find((row) => row.props.title === 'settings.mcpServersBindingWorkspaceRootTitle');
        expect(workspaceRootRow).toBeTruthy();
        workspaceRootRow?.props.onPress?.();

        const { Modal } = await import('@/modal');
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({
                machineId: 'machine-win',
                machineHomeDir: 'C:\\Users\\Ada',
                machinePlatform: 'win32',
            }),
        }));
    });

    it('passes the selected machine platform from the draft expander into the workspace-root picker', async () => {
        const machine = createMachineFixture({
            id: 'machine-win',
            metadata: {
                host: 'win.local',
                platform: 'win32',
                happyCliVersion: '0.0.0-test',
                happyHomeDir: 'C:\\Users\\Ada\\.happier',
                homeDir: 'C:\\Users\\Ada',
            },
        });
        const { McpServerBindingDraftExpander } = await import('./McpServerBindingDraftExpander');

        const screen = await renderScreen(
            <McpServerBindingDraftExpander
                serverId="server-1"
                machines={[machine]}
                favoriteDirectories={[]}
                onChangeFavoriteDirectories={() => {}}
                onAddBinding={() => {}}
            />,
        );

        const targetTypeDropdown = screen.findAllByType('DropdownMenu')
            .find((dropdown) => dropdown.props.selectedId === 'allMachines');
        expect(targetTypeDropdown).toBeTruthy();
        await act(async () => {
            targetTypeDropdown?.props.onSelect?.('workspace');
        });

        const machineDropdown = screen.findAllByType('DropdownMenu')
            .find((dropdown) => dropdown.props.title === 'settings.mcpServersBindingMachine');
        expect(machineDropdown?.props.selectedId).toBeNull();
        await act(async () => {
            machineDropdown?.props.onSelect?.('machine-win');
        });

        const workspaceRootRow = screen.findAllByType('Item')
            .find((row) => row.props.title === 'settings.mcpServersBindingWorkspaceRootTitle');
        expect(workspaceRootRow).toBeTruthy();
        workspaceRootRow?.props.onPress?.();

        const { Modal } = await import('@/modal');
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({
                machineId: 'machine-win',
                machineHomeDir: 'C:\\Users\\Ada',
                machinePlatform: 'win32',
            }),
        }));
    });
});
