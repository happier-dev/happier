import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DetectedMcpServerV1, McpServersSettingsV1 } from '@happier-dev/protocol';
import { createMachineFixture, flushHookEffects } from '@/dev/testkit';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';

import { listDetectedMcpProviderIds, listMcpPreviewAgentIds } from './mcpServerScreenHelpers';
import {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

function createEmptyDetectedServersResponse() {
    return { ok: true, servers: [] as DetectedMcpServerV1[] };
}

function createEmptyPreviewResponse() {
    return { ok: true, builtIn: [], managed: [], detected: [] as [] };
}

const {
    machineMcpServersDetectSpy,
    machineMcpServersPreviewSpy,
    routerPushSpy,
    routerReplaceSpy,
    routerSetParamsSpy,
    setMcpSettingsSpy,
} = vi.hoisted(() => ({
    machineMcpServersDetectSpy: vi.fn(async () => createEmptyDetectedServersResponse()),
    machineMcpServersPreviewSpy: vi.fn(async () => createEmptyPreviewResponse()),
    routerPushSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    routerSetParamsSpy: vi.fn(),
    setMcpSettingsSpy: vi.fn(),
}));

const settingsState: { value: McpServersSettingsV1 } = {
    value: { v: 1, strictMode: false, servers: [], bindings: [] },
};

async function selectHeaderTab(
    screen: { find: (predicate: (node: { props?: { testIDPrefix?: string; onSelectTab?: (tabId: string) => void } }) => boolean) => { props: { onSelectTab?: (tabId: string) => void } } },
    tabId: string,
): Promise<void> {
    const header = screen.find((node) => node.props?.testIDPrefix === 'settings.mcpServers.segment');
    await act(async () => {
        header.props.onSelectTab?.(tabId);
    });
    await flushHookEffects();
}

vi.mock('@/components/settings/mcpServers/McpServerRowSummary', () => ({
    McpServerRowSummary: (props: any) => React.createElement('McpServerRowSummary', props),
}));

vi.mock('@/components/settings/mcpServers/McpServerBadgePills', () => ({
    McpServerBadgePills: (props: any) => React.createElement('McpServerBadgePills', props),
}));

vi.mock('@/components/settings/mcpServers/McpSegmentedHeader', () => ({
    McpSegmentedHeader: (props: any) => React.createElement('McpSegmentedHeader', props),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (action: any) => [false, action],
}));

vi.mock('@/sync/ops/machineMcpServers', async () => {
    const actual = await vi.importActual<any>('@/sync/ops/machineMcpServers');
    return {
        ...actual,
        machineMcpServersDetect: machineMcpServersDetectSpy,
        machineMcpServersPreview: machineMcpServersPreviewSpy,
    };
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid',
}));

function installMcpServersScreenMocks() {
    installMcpServersCommonModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Dimensions: { get: () => ({ width: 1440, height: 900 }) },
            });
        },
        storage: async (importOriginal) => {
            const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
            return createStorageModuleMock({
                importOriginal,
                overrides: {
                    useAllMachines: () => [createMachineFixture({
                        id: 'machine-1',
                        metadata: {
                            displayName: 'Machine 1',
                            host: 'machine-1.local',
                            platform: 'darwin',
                            happyCliVersion: '0.0.0-test',
                            happyHomeDir: '/Users/tester/.happy-dev',
                            homeDir: '/Users/tester',
                        },
                    })],
                    useMachineListByServerId: () => ({}),
                    useMachineListStatusByServerId: () => ({}),
                    useSetting: (key: string) => {
                        if (key === 'serverSelectionGroups') return [];
                        return null;
                    },
                    useSettingMutable: (key: string) => {
                        if (key === 'mcpServersSettingsV1') {
                            return [settingsState.value, setMcpSettingsSpy];
                        }
                        if (key === 'secrets') return [[], vi.fn()];
                        if (key === 'favoriteDirectories') return [[], vi.fn()];
                        return [null, vi.fn()];
                    },
                },
            });
        },
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            return createExpoRouterMock({
                pathname: '/settings/mcp-servers',
                segments: ['(app)', 'settings', 'mcp-servers'],
                router: {
                    push: routerPushSpy,
                    replace: routerReplaceSpy,
                    back: mcpServersModuleState.routerBackSpy,
                    setParams: routerSetParamsSpy,
                },
            }).module;
        },
        modal: async () => {
            const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
            return createModalModuleMock({ confirmResult: true }).module;
        },
    });
}

installMcpServersScreenMocks();

describe('McpServersSettingsScreen', () => {
    beforeEach(async () => {
        resetMcpServersCommonModuleMockState();
        installMcpServersScreenMocks();
        machineMcpServersDetectSpy.mockReset();
        machineMcpServersPreviewSpy.mockReset();
        routerPushSpy.mockReset();
        routerReplaceSpy.mockReset();
        routerSetParamsSpy.mockReset();
        setMcpSettingsSpy.mockReset();
        machineMcpServersDetectSpy.mockResolvedValue(createEmptyDetectedServersResponse());
        machineMcpServersPreviewSpy.mockResolvedValue(createEmptyPreviewResponse());
        settingsState.value = {
            v: 1,
            strictMode: false,
            servers: [{
                id: 'server-1',
                name: 'playwright',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
                env: {},
                createdAt: 1,
                updatedAt: 1,
            }],
            bindings: [{
                id: 'binding-1',
                serverId: 'server-1',
                enabled: true,
                target: { t: 'machine', machineId: 'machine-1' },
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockReset();
        vi.mocked(Modal.show).mockReset();
        vi.mocked(Modal.prompt).mockReset();
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
    });

    it('renders the canonical MCP settings hero, tabs, and quick install rows', async () => {
        const { McpServersSettingsScreen } = await import('./McpServersSettingsScreen');
        const screen = await renderSettingsView(React.createElement(McpServersSettingsScreen));

        const header = screen.find((node) => node.props?.testIDPrefix === 'settings.mcpServers.segment');
        expect(header.props.title).toBe('settings.mcpServers');
        const tabIds = header.props.tabs.map((tab: { id: string }) => tab.id);
        expect(tabIds).toEqual([
            'configured',
            'detected',
            'preview',
        ]);

        const configuredRow = screen.findRow('mcp.server.card.server-1');
        expect(configuredRow).toBeTruthy();
        expect(configuredRow!.props.title).toBe('playwright');
        expect(configuredRow!.props.subtitle).toBe('npx -y @playwright/mcp@latest');
        expect(configuredRow!.props.detail).toBeUndefined();
        expect(configuredRow!.props.rightElement).toBeTruthy();
        const configuredBadgePills = configuredRow!.props.subtitleAccessory;
        expect(configuredBadgePills).toBeTruthy();
        expect(configuredBadgePills.props.size).toBe('compact');
        expect(configuredBadgePills.props.badges).toEqual([
            { key: 'server-1:scope:0', label: 'Machine 1' },
        ]);

        const configuredRowActions = configuredRow!.props.rightElement;
        expect(configuredRowActions.props.actions.map((action: { id: string }) => action.id)).toEqual(['edit', 'delete']);

        const addServerRow = screen.findRow('settings.mcpServers.addServer');
        const quickInstallPlaywright = screen.findRow('settings.mcpServers.quickInstall.playwright');
        expect(addServerRow).toBeTruthy();
        expect(quickInstallPlaywright).toBeTruthy();

        const allRows = screen.listRows('');
        const configuredIndex = allRows.indexOf(configuredRow!);
        const addServerIndex = allRows.indexOf(addServerRow!);
        const quickInstallIndex = allRows.indexOf(quickInstallPlaywright!);
        expect(addServerIndex).toBeGreaterThan(configuredIndex);
        expect(addServerIndex).toBeLessThan(quickInstallIndex);

        await screen.pressRow('settings.mcpServers.quickInstall.playwright');
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/mcp-server?addMode=quick-install&presetId=playwright');

        await selectHeaderTab(screen, 'detected');
        expect(screen.findRow('settings.mcpServers.detect.refresh')).toBeTruthy();
        expect(machineMcpServersDetectSpy).toHaveBeenCalledWith('machine-1', {
            providers: listDetectedMcpProviderIds(),
            directory: undefined,
        });

        await selectHeaderTab(screen, 'preview');
        expect(screen.findRow('settings.mcpServers.preview.refresh')).toBeTruthy();

        const agentDropdown = screen.find((node) => node.props?.itemTrigger?.title === 'settings.mcpServersPreviewAgentTitle');
        expect(agentDropdown!.props.items.map((item: { id: string }) => item.id)).toEqual(
            expect.arrayContaining([...listMcpPreviewAgentIds()]),
        );

        await selectHeaderTab(screen, 'configured');
        expect(screen.findRow('settings.mcpServers.addServer')).toBeTruthy();
        await screen.pressRow('settings.mcpServers.addServer');

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/mcp-server');

        const configuredRowAfterReturn = screen.findRow('mcp.server.card.server-1');
        const deleteAction = configuredRowAfterReturn!.props.rightElement.props.actions[1];
        expect(deleteAction).toBeTruthy();
        await act(async () => {
            await deleteAction.onPress();
        });
        const { Modal } = await import('@/modal');
        expect(Modal.confirm).toHaveBeenCalled();
        expect(setMcpSettingsSpy).toHaveBeenCalledWith({
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        });
    });

    it('refreshes detected servers when the user requests a detect pass with the current context', async () => {
        machineMcpServersDetectSpy.mockResolvedValue({
            ok: true,
            servers: [{
                provider: 'codex',
                name: 'playwright',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
                envKeys: [],
                enabled: true,
                source: { kind: 'user', path: '~/.codex/config.toml' },
            }],
        });

        const { McpServersSettingsScreen } = await import('./McpServersSettingsScreen');
        const screen = await renderSettingsView(React.createElement(McpServersSettingsScreen));

        await selectHeaderTab(screen, 'detected');

        const detectedRow = screen.findRow('mcp.detected.card.0');
        expect(detectedRow).toBeTruthy();

        await act(async () => {
            screen.changeTextByTestId('settings.mcpServers.detect.directoryInput', '/repo/project');
        });
        await flushHookEffects();

        const detectedRowAfterRefresh = screen.findRow('mcp.detected.card.0');
        expect(detectedRowAfterRefresh).toBeTruthy();

        expect(machineMcpServersDetectSpy).toHaveBeenLastCalledWith('machine-1', {
            providers: listDetectedMcpProviderIds(),
            directory: '/repo/project',
        });
    });
});
