import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpServerBindingV1, McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import type { FreshMachineAdministrationExecutionTargetV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installMcpServersCommonModuleMocks();
const openMachinePathBrowserModalMock = mcpServersModuleState.openMachinePathBrowserModalSpy;
const machineMcpServersTestMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, toolCount: 1, durationMs: 1 })));
const administrationTargetState = vi.hoisted(() => {
    const createExecutionTarget = (
        serverIdentityId: string = 'identity-1',
        machineId: string = 'machine-1',
        serverId: string = 'server-1',
    ) => ({
        kind: 'resolved' as const,
        target: { serverIdentityId, machineId },
        serverId,
        profile: {
            id: serverId,
            name: `Server ${serverId}`,
            serverUrl: `https://${serverId}.example.test`,
            serverIdentityId,
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
        },
        machine: {
            id: machineId,
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: {
                displayName: `Machine ${machineId}`,
                host: `${machineId}.local`,
                platform: 'darwin',
                happyCliVersion: '0.0.0-test',
                happyHomeDir: '/Users/tester/.happy-dev',
                homeDir: '/Users/tester',
            },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
        },
    }) satisfies FreshMachineAdministrationExecutionTargetV1;

    const state: {
        current: FreshMachineAdministrationExecutionTargetV1 | null;
        createExecutionTarget: typeof createExecutionTarget;
    } = {
        current: createExecutionTarget(),
        createExecutionTarget,
    };
    return state;
});

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (action: (...args: readonly unknown[]) => Promise<unknown>) => [false, action],
}));

vi.mock('@/sync/ops/machineMcpServers', () => ({
    machineMcpServersTest: machineMcpServersTestMock,
}));

describe('McpServerTestPanel', () => {
    beforeEach(() => {
        resetMcpServersCommonModuleMockState();
        mcpServersModuleState.openMachinePathBrowserModalSpy.mockResolvedValue('/repo/from-browser');
        machineMcpServersTestMock.mockReset();
        machineMcpServersTestMock.mockResolvedValue({ ok: true, toolCount: 1, durationMs: 1 });
        administrationTargetState.current = administrationTargetState.createExecutionTarget();
    });

    it('opens the shared path browser from the test directory input and applies the selected directory', async () => {
        const { McpServerTestPanel } = await import('./McpServerTestPanel');

        const server: McpServerCatalogEntryV1 = {
            id: 'server-1',
            name: 'playwright',
            transport: 'stdio',
            stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
            env: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const bindings: McpServerBindingV1[] = [];

        const screen = await renderScreen(<McpServerTestPanel
            server={server}
            bindings={bindings}
            machines={[administrationTargetState.current!.machine]}
            targetSelection={{
                selectedTarget: administrationTargetState.current?.target ?? null,
                resolveExecutionTarget: () => administrationTargetState.current,
            }}
        />);

        await act(async () => {
            screen.changeTextByTestId('mcp.server.test.directory.input', '/repo/current');
        });

        await act(async () => {
            await screen.findByTestId('path-browser-trigger')?.props.onPress?.();
        });

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            initialPath: '/repo/current',
            title: 'settings.mcpServersTestDirectoryTitle',
        });

        expect(screen.findByTestId('mcp.server.test.directory.input')?.props.value).toBe('/repo/from-browser');
    });

    it('uses the fresh Administration target for test RPCs and does not fall back after target loss', async () => {
        administrationTargetState.current = administrationTargetState.createExecutionTarget(
            'identity-target',
            'machine-target',
            'server-target',
        );
        const { McpServerTestPanel } = await import('./McpServerTestPanel');
        const server: McpServerCatalogEntryV1 = {
            id: 'server-1',
            name: 'playwright',
            transport: 'stdio',
            stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
            env: {},
            createdAt: 1,
            updatedAt: 1,
        };
        const screen = await renderScreen(<McpServerTestPanel
            server={server}
            bindings={[]}
            machines={[]}
            targetSelection={{
                selectedTarget: administrationTargetState.current?.target ?? null,
                resolveExecutionTarget: () => administrationTargetState.current,
            }}
        />);

        await act(async () => {
            await screen.findByTestId('mcp.server.test.run')?.props.onPress?.();
        });

        expect(machineMcpServersTestMock).toHaveBeenCalledWith('machine-target', expect.objectContaining({
            t: 'draft',
        }), { serverId: 'server-target' });

        machineMcpServersTestMock.mockClear();
        administrationTargetState.current = null;
        await act(async () => {
            await screen.findByTestId('mcp.server.test.run')?.props.onPress?.();
        });

        expect(machineMcpServersTestMock).not.toHaveBeenCalled();
    });
});
