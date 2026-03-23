import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpServerBindingV1, McpServerCatalogEntryV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installMcpServersCommonModuleMocks();
const openMachinePathBrowserModalMock = mcpServersModuleState.openMachinePathBrowserModalSpy;

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (action: (...args: readonly unknown[]) => Promise<unknown>) => [false, action],
}));

vi.mock('@/sync/ops/machineMcpServers', () => ({
    machineMcpServersTest: vi.fn(async () => ({ ok: true, toolCount: 1, durationMs: 1 })),
}));

describe('McpServerTestPanel', () => {
    beforeEach(() => {
        resetMcpServersCommonModuleMockState();
        mcpServersModuleState.openMachinePathBrowserModalSpy.mockResolvedValue('/repo/from-browser');
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
            machines={[{ id: 'machine-1', serverId: 'server-1', metadata: { displayName: 'Machine 1', host: 'machine-1.local' } } as any]}
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
});
