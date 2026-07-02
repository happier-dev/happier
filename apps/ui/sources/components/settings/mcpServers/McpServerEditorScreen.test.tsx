import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';
import { createPartialStorageModuleMock } from '@/dev/testkit/createPartialStorageModuleMock';
import { findTestInstanceByTypeContainingText, renderScreen } from '@/dev/testkit/render/renderScreen';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type PromptUnsavedChangesAlertArgs = Parameters<
    typeof promptUnsavedChangesAlert
>;
type PromptUnsavedChangesAlertReturn = ReturnType<
    typeof promptUnsavedChangesAlert
>;

const setMcpSettingsSpy = vi.fn();
const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async (..._args: any[]) => true);
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const navigationDispatchSpy = vi.fn();
const navigationSetOptionsSpy = vi.fn();
const navigationBeforeRemoveHandlers: Array<(event: any) => void | Promise<void>> = [];
const promptUnsavedChangesAlertSpy = vi.hoisted(
    () => vi.fn<typeof promptUnsavedChangesAlert>(),
);
let navigationCanGoBack = false;
let liveMcpSettings: {
    v: 1;
    strictMode: boolean;
    servers: Array<{
        id: string;
        name: string;
        transport: 'stdio' | 'http' | 'sse';
        stdio?: { command: string; args: string[] };
        remote?: { url: string; headers: Record<string, unknown> };
        env: Record<string, unknown>;
        createdAt: number;
        updatedAt: number;
    }>;
    bindings: Array<{
        id: string;
        serverId: string;
        enabled: boolean;
        target: { t: 'machine'; machineId: string };
        createdAt: number;
        updatedAt: number;
    }>;
};
let liveSecrets: SavedSecret[] = [];
let liveMachines = [{ id: 'machine-1', metadata: { displayName: 'Machine 1' } }];
const liveSettingListeners = new Set<() => void>();

function notifyLiveSettingListeners() {
    for (const listener of liveSettingListeners) {
        listener();
    }
}

function resetLiveSettings() {
    liveMcpSettings = {
        v: 1,
        strictMode: false,
        servers: [{
            id: 'server-1',
            name: 'server',
            transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] },
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
    liveSecrets = [];
    liveMachines = [{ id: 'machine-1', metadata: { displayName: 'Machine 1' } }];
    liveSettingListeners.clear();
    setMcpSettingsSpy.mockReset();
    modalAlertSpy.mockReset();
    modalConfirmSpy.mockReset();
    navigationDispatchSpy.mockReset();
    navigationSetOptionsSpy.mockReset();
    navigationBeforeRemoveHandlers.length = 0;
    promptUnsavedChangesAlertSpy.mockReset();
    promptUnsavedChangesAlertSpy.mockResolvedValue('discard');
}

function updateLiveSecrets(next: SavedSecret[]) {
    liveSecrets = next;
    notifyLiveSettingListeners();
}

const mcpServersCommonModuleMockOptions = {
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            spies: {
                alert: modalAlertSpy,
                confirm: (...args) => modalConfirmSpy(...args) as any,
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: {
                get: () => ({ width: 1440, height: 900 }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: {
                back: routerBackSpy,
                replace: routerReplaceSpy,
            },
            navigation: {
                canGoBack: () => navigationCanGoBack,
                dispatch: navigationDispatchSpy,
                setOptions: navigationSetOptionsSpy,
                addListener: (event: string, handler: (evt: any) => void | Promise<void>) => {
                    if (event === 'beforeRemove') {
                        navigationBeforeRemoveHandlers.push(handler);
                    }
                    return () => {};
                },
            },
        });

        return {
            ...routerMock.module,
            useLocalSearchParams: () => mcpServersModuleState.routerSearchParams,
            useGlobalSearchParams: () => mcpServersModuleState.routerSearchParams,
        };
    },
    routerSearchParams: { serverId: 'server-1' },
    storage: async (importOriginal: <T = unknown>() => Promise<T>) => {
        const actual = (await importOriginal()) as typeof import('@/sync/domains/state/storage');
        return {
            ...actual,
            useAllMachines: () => liveMachines,
            useSettingMutable: (key: string) => {
                const ReactModule = require('react') as typeof React;
                const [, forceUpdate] = ReactModule.useReducer((value: number) => value + 1, 0);

                ReactModule.useEffect(() => {
                    const listener = () => forceUpdate();
                    liveSettingListeners.add(listener);
                    return () => {
                        liveSettingListeners.delete(listener);
                    };
                }, []);

                if (key === 'mcpServersSettingsV1') {
                    return [liveMcpSettings, (next: typeof liveMcpSettings) => {
                        setMcpSettingsSpy(next);
                        liveMcpSettings = next;
                        liveSettingListeners.forEach((listener) => listener());
                    }];
                }
                if (key === 'secrets') {
                    return [liveSecrets, (next: SavedSecret[]) => {
                        liveSecrets = next;
                        liveSettingListeners.forEach((listener) => listener());
                    }];
                }
                return [null, vi.fn()];
            },
        };
    },
};

installMcpServersCommonModuleMocks(mcpServersCommonModuleMockOptions);

vi.mock('@/utils/ui/promptUnsavedChangesAlert', () => ({
    promptUnsavedChangesAlert: (...args: PromptUnsavedChangesAlertArgs) => promptUnsavedChangesAlertSpy(...args),
}));

vi.mock('@/components/ui/forms/InlineAddExpander', () => ({
    InlineAddExpander: (props: any) =>
        React.createElement('InlineAddExpander', props, props.isOpen ? props.children : null),
}));

vi.mock('@/components/settings/mcpServers/McpServerBindingEditor', () => ({
    McpServerBindingEditor: () => React.createElement('McpServerBindingEditor'),
}));

vi.mock('@/components/settings/mcpServers/McpServerTestPanel', () => ({
    McpServerTestPanel: () => React.createElement('McpServerTestPanel'),
}));

vi.mock('@/components/settings/mcpServers/McpValueRefMapEditor', () => ({
    McpValueRefMapEditor: () => React.createElement('McpValueRefMapEditor'),
}));

vi.mock('@/sync/ops/machineMcpServers', async () => {
    const actual = await vi.importActual<any>('@/sync/ops/machineMcpServers');
    return {
        ...actual,
        machineMcpServersPreview: vi.fn(async () => ({ ok: true, builtIn: [], managed: [], detected: [] })),
    };
});

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid',
}));

vi.mock('@/constants/Typography', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/constants/Typography')>();
    return {
        ...actual,
        Typography: {
            ...actual.Typography,
            default: () => ({}),
        },
    };
});

async function renderEditorScreen() {
    const { McpServerEditorScreen } = await import('./McpServerEditorScreen');
    return renderScreen(React.createElement(McpServerEditorScreen));
}

beforeEach(() => {
    resetMcpServersCommonModuleMockState();
    resetLiveSettings();
    navigationCanGoBack = false;
    routerBackSpy.mockReset();
    routerReplaceSpy.mockReset();
    installMcpServersCommonModuleMocks(mcpServersCommonModuleMockOptions);
    mcpServersModuleState.routerSearchParams = { serverId: 'server-1' };
});

describe('McpServerEditorScreen', () => {
    it('replaces to the MCP servers settings screen when cancelling quick install even if a back stack exists', async () => {
        vi.useFakeTimers();
        navigationCanGoBack = true;

        Object.defineProperty(globalThis, 'location', {
            value: { href: 'http://localhost/settings/mcp-server?addMode=quick-install', pathname: '/settings/mcp-server' },
            writable: true,
            configurable: true,
        });
        Object.defineProperty(globalThis, 'history', {
            value: { back: vi.fn() },
            writable: true,
            configurable: true,
        });

        mcpServersModuleState.routerSearchParams = { addMode: 'quick-install', presetId: 'sequential-thinking' };
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };

        const screen = await renderEditorScreen();

        await act(async () => {
            screen.pressByTestId('mcp.server.quickInstall.cancel');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/mcp');

        vi.useRealTimers();
    });

    it('prompts to discard unsaved changes when navigating away via the navigation back action', async () => {
        const screen = await renderEditorScreen();

        const initialHeaderRightCall = navigationSetOptionsSpy.mock.calls
            .map((call) => call[0])
            .find((options) => options && typeof options === 'object' && 'headerRight' in options) as any;
        expect(initialHeaderRightCall).toBeTruthy();

        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'server_edited');
        });

        expect(navigationBeforeRemoveHandlers.length).toBeGreaterThan(0);

        const lastHeaderRightCall = navigationSetOptionsSpy.mock.calls
            .map((call) => call[0])
            .filter((options) => options && typeof options === 'object' && 'headerRight' in options)
            .at(-1) as any;
        const headerRight = lastHeaderRightCall?.headerRight as (() => React.ReactElement | null) | undefined;
        expect(typeof headerRight).toBe('function');
        const headerRightNode = headerRight?.();
        expect(React.isValidElement(headerRightNode)).toBe(true);
        expect((headerRightNode as any).props.disabled).toBe(false);

        const preventDefaultSpy = vi.fn();
        const action = { type: 'GO_BACK' };

        const beforeRemove = navigationBeforeRemoveHandlers[navigationBeforeRemoveHandlers.length - 1];

        await act(async () => {
            await beforeRemove?.({
                preventDefault: preventDefaultSpy,
                data: { action },
            });
            await flushHookEffects({ cycles: 1, turns: 3 });
        });

        expect(preventDefaultSpy).toHaveBeenCalled();
        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalled();
        expect(navigationDispatchSpy).toHaveBeenCalledWith(action);
    });

    it('saves the draft before completing navigation when the user chooses save in the unsaved-changes prompt', async () => {
        promptUnsavedChangesAlertSpy.mockResolvedValueOnce('save');

        const screen = await renderEditorScreen();

        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'server_edited');
        });

        const preventDefaultSpy = vi.fn();
        const action = { type: 'GO_BACK' };
        const beforeRemove = navigationBeforeRemoveHandlers[navigationBeforeRemoveHandlers.length - 1];

        await act(async () => {
            await beforeRemove?.({
                preventDefault: preventDefaultSpy,
                data: { action },
            });
            await flushHookEffects({ cycles: 1, turns: 3 });
        });

        expect(preventDefaultSpy).toHaveBeenCalled();
        expect(promptUnsavedChangesAlertSpy).toHaveBeenCalled();
        expect(setMcpSettingsSpy).toHaveBeenCalled();
        expect(navigationDispatchSpy).toHaveBeenCalledWith(action);
    });

    it('falls back to the MCP settings screen after delete when there is no back stack entry', async () => {
        const screen = await renderEditorScreen();

        await act(async () => {
            screen.pressByTestId('mcp.server.editor.secondaryAction');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(setMcpSettingsSpy).toHaveBeenCalledWith({
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        });
        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/mcp');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('preserves a new server draft when unrelated secrets settings change', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'qa_remote_http_20260306');
        });

        const transportTabs = screen.findAllByType('SegmentedTabBar')[1];
        expect(transportTabs).toBeTruthy();
        await act(async () => {
            transportTabs?.props.onSelectTab?.('http');
        });

        await act(async () => {
            screen.findByProps({ placeholder: 'https://example.com/mcp' }).props.onChangeText?.('http://127.0.0.1:63254/mcp');
        });

        await act(async () => {
            updateLiveSecrets([{
                id: 'secret-live',
                name: 'qa_remote_http_auth_livefix_20260306',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'qa-remote-auth-1772754949' },
                createdAt: 1,
                updatedAt: 1,
            }]);
        });

        expect(screen.findByTestId('mcp.server.editor.name')?.props.value).toBe('qa_remote_http_20260306');
        expect(screen.findByProps({ placeholder: 'https://example.com/mcp' })?.props.value).toBe('http://127.0.0.1:63254/mcp');
        expect(screen.findAllByType('SegmentedTabBar')[1]?.props.activeTabId).toBe('http');
    });

    it('shows configure/import-json/quick-install add-flow tabs for new servers', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        const addFlowTabs = screen.findAllByType('SegmentedTabBar')[0];
        expect(addFlowTabs).toBeTruthy();
        await act(async () => {
            addFlowTabs?.props.onSelectTab?.('importJson');
        });
        expect(screen.findByTestId('mcp.server.importJson.input')).toBeTruthy();

        await act(async () => {
            addFlowTabs?.props.onSelectTab?.('quickInstall');
        });
        expect(screen.findByTestId('mcp.server.quickInstall.preset.github')).toBeTruthy();
    });

    it('disables JSON import when a saved-secret mapping is missing a value', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        const addFlowTabs = screen.findAllByType('SegmentedTabBar')[0];
        await act(async () => {
            addFlowTabs?.props.onSelectTab?.('importJson');
        });

        await act(async () => {
            screen.changeTextByTestId('mcp.server.importJson.input', `{
                "mcp": {
                    "inputs": {
                        "github_token": {
                            "type": "promptString",
                            "password": true
                        }
                    },
                    "servers": {
                        "github": {
                            "command": "npx",
                            "args": ["-y", "@modelcontextprotocol/server-github"],
                            "env": {
                                "GITHUB_TOKEN": "\${input:github_token}"
                            }
                        }
                    }
                }
            }`);
        });

        expect(screen.findByTestId('mcp.server.importJson.import')?.props.disabled).toBe(true);
    });

    it('allows selecting multiple quick-install presets while preserving required-auth validation', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        const addFlowTabs = screen.findAllByType('SegmentedTabBar')[0];
        await act(async () => {
            addFlowTabs?.props.onSelectTab?.('quickInstall');
        });

        await act(async () => {
            screen.pressByTestId('mcp.server.quickInstall.preset.github');
        });

        await act(async () => {
            screen.pressByTestId('mcp.server.quickInstall.preset.sequential-thinking');
        });

        expect(screen.findByTestId('mcp.server.quickInstall.preset.github')?.props.selected).toBe(true);
        expect(screen.findByTestId('mcp.server.quickInstall.preset.sequential-thinking')?.props.selected).toBe(true);
        expect(screen.findByTestId('mcp.server.quickInstall.install')?.props.disabled).toBe(true);
    });

    it('opens add binding as a draft expander instead of creating a binding immediately', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        expect(screen.findAllByType('McpServerBindingEditor')).toHaveLength(0);

        const addBindingExpander = screen.findByType('InlineAddExpander');
        expect(addBindingExpander).toBeTruthy();
        expect(addBindingExpander.props.title).toBe('settings.mcpServersAddApplyRule');
        expect(addBindingExpander.props.isOpen).toBe(false);

        await act(async () => {
            addBindingExpander.props.onOpenChange?.(true);
        });

        const addBindingExpanderAfterOpen = screen.findByType('InlineAddExpander');
        expect(screen.findAllByType('McpServerBindingEditor')).toHaveLength(0);
        expect(addBindingExpanderAfterOpen?.props.isOpen).toBe(true);
    });

    it('keeps a draft binding on all machines when no machine-scoped target can be selected', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMachines = [];
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        await act(async () => {
            screen.findByType('InlineAddExpander').props.onOpenChange?.(true);
        });

        expect(screen.findAllByProps({ title: 'settings.mcpServersBindingMachine' })).toHaveLength(0);
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'settings.mcpServersBindingTargetAllMachines')).toBeTruthy();

        await act(async () => {
            screen.findByType('DropdownMenu').props.onSelect?.('machine');
        });

        expect(screen.findAllByProps({ title: 'settings.mcpServersBindingMachine' })).toHaveLength(0);
        expect(screen.findAllByType('McpServerBindingEditor')).toHaveLength(0);
    });

    it('updates the binding target scope from the draft editor', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        await act(async () => {
            screen.findByType('InlineAddExpander').props.onOpenChange?.(true);
        });
        await act(async () => {
            screen.findAllByType('DropdownMenu')[0].props.onSelect?.('allMachines');
        });

        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'settings.mcpServersBindingTargetAllMachines')).toBeTruthy();
    });

    it('shows a validation alert when no machine is selected for the add binding draft', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMachines = [];
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        await act(async () => {
            screen.findByType('InlineAddExpander').props.onOpenChange?.(true);
        });
        await act(async () => {
            screen.findAllByType('DropdownMenu')[0].props.onSelect?.('allMachines');
        });

        await act(async () => {
            screen.findAllByType('DropdownMenu')[0].props.onSelect?.('machine');
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'settings.mcpServersNoMachineSelected');
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'settings.mcpServersBindingTargetAllMachines')).toBeTruthy();
        expect(screen.findAllByProps({ title: 'settings.mcpServersBindingMachine' })).toHaveLength(0);
    });
});
