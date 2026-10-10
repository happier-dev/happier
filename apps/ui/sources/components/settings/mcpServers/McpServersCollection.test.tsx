import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    AccountSettingsDefaults,
    DetectedMcpServerV1,
    McpServersSettingsV1,
} from '@happier-dev/protocol';
import { createMachineFixture, flushHookEffects } from '@/dev/testkit';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';

import { listMcpPreviewAgentIds } from './mcpServerScreenHelpers';
import {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

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

type McpServersSettingsRaw = AccountSettingsDefaults['mcpServersSettingsV1'];

const settingsState: { value: McpServersSettingsRaw } = {
    value: { v: 1, strictMode: false, servers: [], bindings: [] },
};

const administrationTargetState = vi.hoisted(() => ({
    current: {
        target: { serverIdentityId: 'identity-1', machineId: 'machine-1' },
        serverId: 'server-1',
        machine: {
            id: 'machine-1',
            metadata: {
                displayName: 'Machine 1',
                host: 'machine-1.local',
            },
        },
    } as {
        target: { serverIdentityId: string; machineId: string };
        serverId: string;
        machine: { id: string; metadata: { displayName: string; host: string } };
    } | null,
}));

// The index route's view comes from the collection layout; a test states it directly.
const collectionIndexView = vi.hoisted(() => ({ value: null as null | 'pending' | 'land' | 'list' }));
vi.mock('@happier-dev/plugin-ui/presentation', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown> & { useHappierCollectionIndexView: () => string }>();
    return {
        ...actual,
        useHappierCollectionIndexView: () => collectionIndexView.value ?? actual.useHappierCollectionIndexView(),
    };
});
vi.mock('@/components/settings/mcpServers/McpServerBadgePills', () => ({
    McpServerBadgePills: (props: any) => React.createElement('McpServerBadgePills', props),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (action: any) => [false, action],
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: any) => React.createElement('MachineAdministrationTargetSelector', props),
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({
        selectedTarget: administrationTargetState.current?.target ?? null,
        canExecute: administrationTargetState.current !== null,
        resolveExecutionTarget: () => administrationTargetState.current,
    }),
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
                    useSetting: createUseSettingMock({ fallback: (key) => {
                        if (key === 'serverSelectionGroups') return [];
                        return null;
                    } }),
                    useSettingMutable: createUseSettingMutableMockFromReader((key) => {
                        if (key === 'mcpServersSettingsV1') {
                            return [settingsState.value, setMcpSettingsSpy];
                        }
                        if (key === 'secrets') return [[], vi.fn()];
                        if (key === 'favoriteDirectories') return [[], vi.fn()];
                        return [null, vi.fn()];
                    }),
                },
            });
        },
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            return createExpoRouterMock({
                pathname: '/(app)/settings/mcp-servers',
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

describe('MCP servers collection and tools', () => {
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
        administrationTargetState.current = {
            target: { serverIdentityId: 'identity-1', machineId: 'machine-1' },
            serverId: 'server-1',
            machine: {
                id: 'machine-1',
                metadata: {
                    displayName: 'Machine 1',
                    host: 'machine-1.local',
                },
            },
        };
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockReset();
        vi.mocked(Modal.show).mockReset();
        vi.mocked(Modal.prompt).mockReset();
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
    });

    it.each(['land', 'list'] as const)('invites an empty collection with one primary way to add and retains machine tools (%s)', async (view) => {
        settingsState.value = { v: 1, strictMode: false, servers: [], bindings: [] };
        collectionIndexView.value = view;
        try {
            const { McpSettingsIndex } = await import('./McpSettingsIndex');
            const screen = await renderSettingsView(React.createElement(McpSettingsIndex));
            const addMenu = screen.find((node) => node.props?.testID === 'settings.mcpServers.addMenu' && typeof node.props?.onSelect === 'function');
            // One primary: "Add MCP server" is the add menu's own trigger; no other way to add sits beside it.
            const trigger = addMenu.props.trigger({ open: false, toggle: () => {}, openMenu: () => {}, closeMenu: () => {}, selectedItem: null });
            expect(trigger.props.testID).toBe('settings.mcpServers.invitation.add');
            const otherWays = screen.findAll((node) => node.props?.testID?.startsWith?.('settings.mcpServers.invitation.')
                && (typeof node.props?.onPress === 'function' || typeof node.props?.action === 'function')
                && node.props.testID !== 'settings.mcpServers.invitation.add');
            expect(otherWays).toHaveLength(0);
            // The menu holds every way: configure, paste JSON, from this machine (and presets).
            expect(addMenu.props.items.map((item: { id: string }) => item.id)).toEqual(
                expect.arrayContaining(['configure', 'import-json', 'from-machine']),
            );
            expect(screen.findRow('settings.mcpServers.tool.onMachine')).not.toBeNull();
            expect(screen.findRow('settings.mcpServers.tool.preview')).not.toBeNull();
        } finally {
            collectionIndexView.value = null;
        }
    });

    it('lists each server with where it applies, flags one that applies nowhere, and adds in the collection', async () => {
        settingsState.value = {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 'server-1', name: 'playwright', transport: 'stdio',
                    stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, env: {}, createdAt: 1, updatedAt: 1,
                },
                {
                    id: 'server-2', name: 'context7', transport: 'http', remote: { url: 'https://example.com/mcp', headers: {} },
                    env: {}, createdAt: 2, updatedAt: 2,
                },
            ],
            bindings: [{
                id: 'binding-1', serverId: 'server-1', enabled: true,
                target: { t: 'machine', machineId: 'machine-1' }, createdAt: 1, updatedAt: 1,
            }],
        };
        const { McpServerCollection } = await import('./collection/McpServerCollection');
        const screen = await renderSettingsView(React.createElement(McpServerCollection, { variant: 'rail', selectedServerId: 'server-1' }));

        const bound = screen.findRow('mcp.server.card.server-1');
        expect(bound!.props.title).toBe('playwright');
        expect(bound!.props.subtitle).toBe('Machine 1');
        expect(bound!.props.selected).toBe(true);
        expect(bound!.props.subtitleLeading).toBeUndefined();
        const unbound = screen.findRow('mcp.server.card.server-2');
        expect(unbound!.props.subtitle).toBe('mcpSettings.unbound');
        expect(unbound!.props.subtitleLeading).toBeTruthy();

        await screen.pressRow('mcp.server.card.server-2');
        expect(routerReplaceSpy).toHaveBeenLastCalledWith('/settings/mcp/server-2');

        const addMenu = screen.find((node) => node.props?.testID === 'settings.mcpServers.addMenu' && typeof node.props?.onSelect === 'function');
        await act(async () => { addMenu.props.onSelect('preset:playwright'); });
        expect(routerReplaceSpy).toHaveBeenLastCalledWith('/settings/mcp/new?addMode=quick-install&presetId=playwright');
        await act(async () => { addMenu.props.onSelect('configure'); });
        expect(routerReplaceSpy).toHaveBeenLastCalledWith('/settings/mcp/new');
        await act(async () => { addMenu.props.onSelect('from-machine'); });
        expect(routerReplaceSpy).toHaveBeenLastCalledWith('/settings/mcp/on-machine');
    });

    it('scans every discovery source on the managed machine and imports a found server into the collection', async () => {
        machineMcpServersDetectSpy.mockResolvedValue({
            ok: true,
            servers: [{
                provider: 'codex',
                name: 'github',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
                envKeys: [],
                enabled: true,
                source: { kind: 'user', path: '~/.codex/config.toml' },
            }],
        });
        const { McpDetectedServersScreen } = await import('./McpDetectedServersScreen');
        const screen = await renderSettingsView(React.createElement(McpDetectedServersScreen));
        await flushHookEffects();

        // No provider filter travels: the selected machine's daemon scans every
        // MCP discovery source its own registry holds, including an installed
        // Agent's, instead of this binary's bundled Agent list.
        expect(machineMcpServersDetectSpy).toHaveBeenCalledWith('machine-1', {
            directory: undefined,
        }, { serverId: 'server-1' });

        await act(async () => {
            await screen.find((node) => node.props?.testID === 'mcp.detected.import.0' && typeof node.props?.onPress === 'function').props.onPress();
        });
        await flushHookEffects();

        const { Modal } = await import('@/modal');
        expect(Modal.confirm).toHaveBeenCalled();
        expect(setMcpSettingsSpy).toHaveBeenCalledTimes(1);
        const written = setMcpSettingsSpy.mock.calls[0]![0] as McpServersSettingsV1;
        const imported = written.servers.find((server) => server.name === 'github');
        expect(imported).toBeTruthy();
        expect(routerReplaceSpy).toHaveBeenLastCalledWith(`/settings/mcp/${imported!.id}`);
    });

    it('offers every agent that receives MCP tools in the session preview and records the failure policy', async () => {
        const { McpSessionPreviewScreen } = await import('./McpSessionPreviewScreen');
        const screen = await renderSettingsView(React.createElement(McpSessionPreviewScreen));

        const agentDropdown = screen.find((node) => node.props?.itemTrigger?.title === 'settings.mcpServersPreviewAgentTitle');
        expect(agentDropdown!.props.items.map((item: { id: string }) => item.id)).toEqual(listMcpPreviewAgentIds());

        await act(async () => {
            screen.find((node) => node.props?.testIDPrefix === 'settings.mcpServers.strictMode' && typeof node.props?.onChange === 'function').props.onChange('stop');
        });
        expect(setMcpSettingsSpy).toHaveBeenCalledWith(expect.objectContaining({ strictMode: true }));
    });

    it('says nothing would be delivered when a check finds no server, and names the agent\'s tool delivery', async () => {
        const { McpPreviewServersTab } = await import('./McpPreviewServersTab');
        const common = {
            agentItems: [],
            selectedAgentTools: { delivery: 'native_mcp' } as never,
            selectedMachineId: 'machine-1',
            selectedServerId: 'server-1',
            canExecute: true,
            selectedAgentId: 'claude' as never,
            onSelectAgentId: vi.fn(),
            agentMenuOpen: false,
            onAgentMenuOpenChange: vi.fn(),
            directory: '/repo',
            onChangeDirectory: vi.fn(),
            loading: false,
            onRefresh: vi.fn(),
        };
        const unchecked = await renderSettingsView(React.createElement(McpPreviewServersTab, { ...common, preview: null }));
        expect(unchecked.findRow('settings.mcpServers.preview.empty')).toBeTruthy();
        expect(unchecked.findRow('settings.mcpServers.preview.nothing')).toBeFalsy();
        const delivery = unchecked.findRow('settings.mcpServers.preview.delivery');
        expect(delivery!.props.detail).toBe('settings.mcpServersDeliveryNativeTitle');

        const checked = await renderSettingsView(React.createElement(McpPreviewServersTab, {
            ...common,
            preview: { ok: true, builtIn: [], managed: [], detected: [] } as never,
        }));
        expect(checked.findRow('settings.mcpServers.preview.nothing')).toBeTruthy();
        expect(checked.findRow('settings.mcpServers.preview.empty')).toBeFalsy();
    });

    it.each([
        ['a future settings version', {
            v: 2,
            strictMode: false,
            servers: [],
            bindings: [],
        }],
        ['a schema-invalid duplicate server id', {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 'duplicate',
                    name: 'first',
                    transport: 'stdio',
                    stdio: { command: 'node', args: [] },
                    env: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'duplicate',
                    name: 'second',
                    transport: 'stdio',
                    stdio: { command: 'node', args: [] },
                    env: {},
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
            bindings: [],
        }],
        ['an additive field from a newer writer', {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
            futureV2: { retained: true },
        }],
    ] satisfies ReadonlyArray<readonly [string, McpServersSettingsRaw]>)('does not overwrite %s when changing what happens to a server that cannot start', async (_case, rawSettings) => {
        settingsState.value = rawSettings;

        const { McpSessionPreviewScreen } = await import('./McpSessionPreviewScreen');
        const screen = await renderSettingsView(React.createElement(McpSessionPreviewScreen));

        await act(async () => {
            screen.find((node) => node.props?.testIDPrefix === 'settings.mcpServers.strictMode' && typeof node.props?.onChange === 'function').props.onChange('stop');
        });

        expect(setMcpSettingsSpy).not.toHaveBeenCalled();
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

        const { McpDetectedServersScreen } = await import('./McpDetectedServersScreen');
        const screen = await renderSettingsView(React.createElement(McpDetectedServersScreen));
        await flushHookEffects();

        const detectedRow = screen.findRow('mcp.detected.card.0');
        expect(detectedRow).toBeTruthy();

        await act(async () => {
            screen.changeTextByTestId('settings.mcpServers.detect.directoryInput', '/repo/project');
        });
        await flushHookEffects();

        const detectedRowAfterRefresh = screen.findRow('mcp.detected.card.0');
        expect(detectedRowAfterRefresh).toBeTruthy();

        expect(machineMcpServersDetectSpy).toHaveBeenLastCalledWith('machine-1', {
            directory: '/repo/project',
        }, { serverId: 'server-1' });
    });

    it('uses the fresh Administration target and fails closed after it becomes unavailable', async () => {
        administrationTargetState.current = {
            target: { serverIdentityId: 'identity-target', machineId: 'machine-target' },
            serverId: 'server-target',
            machine: {
                id: 'machine-target',
                metadata: {
                    displayName: 'Target machine',
                    host: 'target.local',
                },
            },
        };

        const { McpDetectedServersScreen } = await import('./McpDetectedServersScreen');
        const screen = await renderSettingsView(React.createElement(McpDetectedServersScreen));
        await flushHookEffects();

        expect(machineMcpServersDetectSpy).toHaveBeenCalledWith('machine-target', {
            directory: undefined,
        }, { serverId: 'server-target' });

        machineMcpServersDetectSpy.mockClear();
        administrationTargetState.current = null;
        await act(async () => {
            await screen.pressRow('settings.mcpServers.detect.refresh');
        });

        expect(machineMcpServersDetectSpy).not.toHaveBeenCalled();
    });
});
