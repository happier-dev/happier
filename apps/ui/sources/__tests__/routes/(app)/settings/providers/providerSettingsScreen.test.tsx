import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAuthStatusData } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { AgentId } from '@/agents/catalog/catalog';
import type { ProviderSettingsPlugin } from '@/agents/providers/shared/providerSettingsPlugin';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockProviderId: string | null = 'codex';
let shouldThrowOnAppPaneScope = false;
const routerPushSpy = vi.fn();
const mockProviderSettingsPlugin = vi.hoisted(
    () => vi.fn<(providerId: string) => ProviderSettingsPlugin | null>(() => null),
);

const machineCapabilitiesInvokeMock = vi.fn(async () => ({
    supported: true,
    response: { ok: true, result: { plan: null } },
}));
const applySettingsMock = vi.fn();
const cliDetectionState = {
    available: { codex: false },
    login: { codex: null } as Record<string, boolean | null>,
    authStatus: { codex: null } as Record<string, CliAuthStatusData | null>,
    resolvedPath: { codex: null } as Record<string, string | null>,
    resolutionSource: { codex: null } as Record<string, 'override' | 'system' | 'managed' | null>,
    tmux: null,
    isDetecting: false,
    timestamp: 1,
    refresh: vi.fn(),
};
const paneApi = {
    scopeId: 'settings:provider:codex',
    scopeState: null as any,
    openRight: vi.fn(),
    closeRight: vi.fn(),
    setRightTab: vi.fn(),
    setRightTabState: vi.fn(),
    openBottom: vi.fn(),
    closeBottom: vi.fn(),
    setBottomTab: vi.fn(),
    setBottomTabState: vi.fn(),
    openDetailsTab: vi.fn(),
    setDetailsTabState: vi.fn(),
    pinDetailsTab: vi.fn(),
    unpinDetailsTab: vi.fn(),
    closeDetails: vi.fn(),
    closeDetailsTab: vi.fn(),
    setActiveDetailsTab: vi.fn(),
};
const useCLIDetectionMock = vi.fn();
const useCapabilityInstallabilityMock = vi.fn();
let machinesState = [
    { id: 'm1', metadata: { displayName: 'Machine One', host: 'm1', homeDir: '/Users/m1' } },
    { id: 'm2', metadata: { displayName: 'Machine Two', host: 'm2', homeDir: '/Users/m2' } },
    { id: 'm3', metadata: { displayName: 'Machine Three', host: 'm3', homeDir: '/Users/m3' } },
];
let machineListByServerIdState = {
    server1: [
        { id: 'm1', revokedAt: null },
        { id: 'm2', revokedAt: null },
    ],
    server2: [
        { id: 'm3', revokedAt: null },
    ],
};
let machineListStatusByServerIdState = {
    server1: { status: 'ready' },
    server2: { status: 'ready' },
};
let activeServerSnapshot: ActiveServerSnapshot = {
    serverId: 'server1',
    serverUrl: 'http://localhost:3000',
    generation: 1,
};
let activeServerSubscriber: ((snapshot: ActiveServerSnapshot) => void) | null = null;

vi.mock('react-native', () => ({
    View: 'View',
    TextInput: 'TextInput',
    Easing: {
        bezier: () => 'bezier',
        linear: 'linear',
    },
    Platform: {
        OS: 'ios',
        select: (v: any) => (v && typeof v === 'object' ? (v.ios ?? v.default) : v),
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#999',
                textDestructive: '#f00',
                success: '#34C759',
                input: { placeholder: '#999' },
                divider: '#e0e0e0',
                surfaceHigh: '#f5f5f5',
                status: { connecting: '#007AFF' },
                accent: { blue: '#007AFF' },
            },
        },
    }),
    StyleSheet: {
        create: (v: any) => v,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ providerId: mockProviderId }),
    useRouter: () => ({ push: routerPushSpy }),
    Redirect: (props: any) => React.createElement('Redirect', props),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        const toggle = () => props.onOpenChange?.(!props.open);
        const openMenu = () => props.onOpenChange?.(true);
        const closeMenu = () => props.onOpenChange?.(false);
        const triggerNode =
            typeof props.trigger === 'function'
                ? props.trigger({ open: Boolean(props.open), toggle, openMenu, closeMenu, selectedItem: null })
                : props.trigger;
        const itemTriggerNode = props.itemTrigger
            ? React.createElement('Item', {
                title: props.itemTrigger.title,
                subtitle: props.itemTrigger.subtitle,
                icon: props.itemTrigger.icon,
                detail: undefined,
                onPress: toggle,
                showChevron: false,
                selected: false,
            })
            : null;
        return React.createElement('DropdownMenu', props, itemTriggerNode ?? triggerNode ?? null);
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: applySettingsMock,
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettings: () => settingsState,
    useAllMachines: () => machinesState,
    useMachineListByServerId: () => machineListByServerIdState,
    useMachineListStatusByServerId: () => machineListStatusByServerIdState,
    useLocalSetting: (key: string) => {
        if (key === 'bottomPaneHeightPx') return 320;
        if (key === 'bottomPaneHeightBasisPx') return 900;
        return undefined;
    },
    useLocalSettingMutable: (key: string) => {
        if (key === 'bottomPaneHeightPx') return [320, vi.fn()] as const;
        if (key === 'bottomPaneHeightBasisPx') return [900, vi.fn()] as const;
        if (key === 'contextSelectionsV1') return [settingsState.contextSelectionsV1, (next: any) => { settingsState.contextSelectionsV1 = next; }] as const;
        return [undefined, vi.fn()] as const;
    },
    useSettingMutable: (key: string) => {
        if (key === 'contextSelectionsV1') return [settingsState.contextSelectionsV1, (next: any) => { settingsState.contextSelectionsV1 = next; }] as const;
        return [undefined, vi.fn()] as const;
    },
    useSetting: (key: string) => {
        if (key === 'serverSelectionGroups') return {};
        if (key === 'serverSelectionActiveTargetKind') return 'server';
        if (key === 'serverSelectionActiveTargetId') return 'server1';
        return undefined;
    },
    useMachine: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    listServerProfiles: () => [{ id: 'server1', serverUrl: 'http://localhost:3000', webappUrl: 'http://localhost:8081', name: 'server1' }],
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    subscribeActiveServer: (listener: (snapshot: ActiveServerSnapshot) => void) => {
        activeServerSubscriber = listener;
        return () => {
            if (activeServerSubscriber === listener) {
                activeServerSubscriber = null;
            }
        };
    },
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    getEffectiveServerSelectionFromRawSettings: () => ({ serverIds: ['server1'] }),
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: (...args: any[]) => useCLIDetectionMock(...args),
}));

vi.mock('@/hooks/machine/useCapabilityInstallability', () => ({
    useCapabilityInstallability: (...args: any[]) => useCapabilityInstallabilityMock(...args),
}));

vi.mock('@/sync/ops', async (importOriginal) => {
    const actual: any = await importOriginal();
    return { ...actual, machineCapabilitiesInvoke: machineCapabilitiesInvokeMock };
});

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        isAgentId: (v: any) => v === 'codex' || v === 'customAcp' || v === 'opencode',
        getAgentCore: (agentId: string) => ({
            displayNameKey:
                agentId === 'customAcp'
                    ? 'agentInput.agent.customAcp'
                    : agentId === 'opencode'
                        ? 'agentInput.agent.opencode'
                        : 'Codex',
            subtitleKey: 'subtitle',
            availability: { experimental: false },
            resume: { supportsVendorResume: false, experimental: false },
            sessionModes: { kind: 'none' },
            model: {
                supportsSelection: true,
                supportsFreeform: true,
                defaultMode: 'default',
                allowedModes: ['default'],
                dynamicProbe: 'static-only',
                nonAcpApplyScope: 'spawn_only',
                acpApplyBehavior: 'set_model',
                acpModelConfigOptionId: null,
            },
            cli: {
                detectKey: agentId,
                installBanner: { installKind: 'installer', installCommand: null, guideUrl: null },
            },
            connectedService: { name: agentId === 'customAcp' ? 'Custom ACP' : 'cloud' },
            localControl: { supported: false },
            ui: { agentPickerIconName: agentId === 'customAcp' ? 'git-network-outline' : 'code-slash' },
        }),
    };
});

vi.mock('@/agents/providers/registry/providerSettingsRegistry', () => ({
    PROVIDER_SETTINGS_PLUGINS: [],
    getProviderSettingsPlugin: (providerId: string) => mockProviderSettingsPlugin(providerId),
}));

vi.mock('@/agents/providers/registry/providerLocalAuthRegistry', () => ({
    getProviderLocalAuthPlugin: () => ({
        providerId: 'codex',
        support: 'login_terminal',
        docsUrl: 'https://example.com/codex',
        buildLoginLaunch: () => ({ initialCommand: 'codex login' }),
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeLabelForAgentType: () => 'Ask',
    getPermissionModeOptionsForAgentType: () => [
        { value: 'default', label: 'Default', description: 'Use the global default', icon: 'list-outline' },
        { value: 'ask', label: 'Ask', description: 'Ask each time', icon: 'help-circle-outline' },
    ],
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        getAgentAdvancedModeCapabilities: () => ({ supportsRuntimeModeSwitch: false }),
        getProviderCliRuntimeSpec: () => ({
            id: 'codex',
            binaryName: 'codex',
            sourcePreferenceDefault: 'system-first',
            managedInstall: {
                kind: 'github_release_binary',
                githubRepo: 'openai/codex',
                binaryName: 'codex',
            },
            manualInstallKind: 'command',
            docsUrl: 'https://github.com/openai/codex',
        }),
    };
});

vi.mock('@/components/settings/providers/ProviderCliInstallItem', () => ({
    ProviderCliInstallItem: (props: any) => React.createElement('ProviderCliInstallItem', props),
}));

vi.mock('@/components/contextBar/ContextBar', () => ({
    ContextBar: (props: any) => React.createElement('ContextBar', props),
}));

vi.mock('@/components/ui/layout/BadgeGrid', () => ({
    BadgeGrid: (props: any) => React.createElement('BadgeGrid', props),
}));

vi.mock('@/components/settings/providers/authentication/ProviderAuthenticationCard', () => ({
    ProviderAuthenticationCard: (props: any) => {
        const state = props.state;
        if (!state) return null;
        const authStatus = state.authStatus;
        if (!authStatus) return null;
        return React.createElement('ItemGroup', { title: 'settingsProviders.authentication.title' },
            authStatus.state === 'logged_in'
                ? React.createElement('Item', { title: 'settingsProviders.authentication.accountTitle', subtitle: authStatus.accountLabel })
                : state.canLaunchLogin
                    ? React.createElement('Item', { title: 'settingsProviders.authentication.logInTitle', onPress: props.onLaunchLogin })
                    : null,
        );
    },
}));

vi.mock('@/components/settings/providers/authentication/ProviderAuthenticationTerminalPane', () => ({
    ProviderAuthenticationTerminalPane: (props: any) => React.createElement('ProviderAuthenticationTerminalPane', props),
}));

vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => {
        if (shouldThrowOnAppPaneScope) {
            throw new Error('useAppPaneScope called unexpectedly');
        }
        return paneApi;
    },
}));

vi.mock('@/components/settings/providers/authentication/useProviderAuthenticationState', () => ({
    useProviderAuthenticationState: (params: any) => {
        const providerId = params.providerId;
        const authStatus = cliDetectionState.authStatus?.[providerId] ?? null;
        return {
            canLaunchLogin: true,
            machineId: null,
            machineHomeDir: null,
            loginLaunch: null,
            authStatus,
            canCheckNow: true,
            loginActionKind: authStatus?.state === 'logged_in' ? 'reauthenticate' : 'login',
            docsUrl: null,
        };
    },
}));

describe('ProviderSettingsScreen', () => {
    beforeEach(() => {
        mockProviderId = 'codex';
        shouldThrowOnAppPaneScope = false;
        applySettingsMock.mockReset();
        cliDetectionState.available = { codex: false };
        cliDetectionState.login = { codex: null };
        cliDetectionState.authStatus = { codex: null };
        cliDetectionState.resolvedPath = { codex: null };
        cliDetectionState.resolutionSource = { codex: null };
        cliDetectionState.tmux = null;
        cliDetectionState.isDetecting = false;
        cliDetectionState.timestamp = 1;
        cliDetectionState.refresh = vi.fn();
        paneApi.scopeState = null;
        paneApi.openRight.mockReset();
        paneApi.closeRight.mockReset();
        paneApi.setRightTab.mockReset();
        paneApi.setRightTabState.mockReset();
        paneApi.openBottom.mockReset();
        paneApi.closeBottom.mockReset();
        paneApi.setBottomTab.mockReset();
        paneApi.setBottomTabState.mockReset();
        paneApi.openDetailsTab.mockReset();
        paneApi.setDetailsTabState.mockReset();
        paneApi.pinDetailsTab.mockReset();
        paneApi.unpinDetailsTab.mockReset();
        paneApi.closeDetails.mockReset();
        paneApi.closeDetailsTab.mockReset();
        paneApi.setActiveDetailsTab.mockReset();
        settingsState.backendEnabledByTargetKey = {};
        settingsState.sessionDefaultPermissionModeByTargetKey = {};
        settingsState.backendCliSourcePreferenceById = {};
        settingsState.contextSelectionsV1 = undefined;
        settingsState.opencodeServerBaseUrl = '';
        settingsState.opencodeServerBaseUrlByServerIdV1 = {};
        machinesState = [
            { id: 'm1', metadata: { displayName: 'Machine One', host: 'm1', homeDir: '/Users/m1' } },
            { id: 'm2', metadata: { displayName: 'Machine Two', host: 'm2', homeDir: '/Users/m2' } },
            { id: 'm3', metadata: { displayName: 'Machine Three', host: 'm3', homeDir: '/Users/m3' } },
        ];
        machineListByServerIdState = {
            server1: [
                { id: 'm1', revokedAt: null },
                { id: 'm2', revokedAt: null },
            ],
            server2: [
                { id: 'm3', revokedAt: null },
            ],
        };
        machineListStatusByServerIdState = {
            server1: { status: 'ready' },
            server2: { status: 'ready' },
        };
        activeServerSnapshot = {
            serverId: 'server1',
            serverUrl: 'http://localhost:3000',
            generation: 1,
        };
        activeServerSubscriber = null;
        useCLIDetectionMock.mockReset();
        useCLIDetectionMock.mockImplementation(() => cliDetectionState);
        useCapabilityInstallabilityMock.mockReset();
        useCapabilityInstallabilityMock.mockReturnValue({ kind: 'installable' });
        routerPushSpy.mockReset();
        mockProviderSettingsPlugin.mockReset();
        mockProviderSettingsPlugin.mockReturnValue(null);
    });

    it('surfaces provider CLI install via capability installer item', async () => {
        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const installer = tree!.root.findByType('ProviderCliInstallItem' as any);
        expect(installer.props.machineId).toBe('m1');
        expect(installer.props.serverId).toBe('server1');
        expect(installer.props.capabilityId).toBe('cli.codex');
        expect(installer.props.installed).toBe(false);
        expect(installer.props.managedInstalled).toBe(false);
        expect(installer.props.installability).toMatchObject({ kind: 'installable' });
    });

    it('renders a machine-only context bar scoped to the active server machines', async () => {
        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const contextBar = tree!.root.findByType('ContextBar' as any);
        expect(contextBar.props.mode).toBe('machine_only');
        expect(contextBar.props.machine.selectedId).toBe('m1');
        expect(contextBar.props.machine.items.map((item: any) => item.id)).toEqual(['m1', 'm2']);
    });

    it('falls back to active server machines when the server-scoped machine cache is not populated yet', async () => {
        machinesState = [
            { id: 'm1', metadata: { displayName: 'Machine One', host: 'm1', homeDir: '/Users/m1' } },
            { id: 'm2', metadata: { displayName: 'Machine Two', host: 'm2', homeDir: '/Users/m2' } },
            { id: 'm3', metadata: { displayName: 'Machine Three', host: 'm3', homeDir: '/Users/m3' } },
        ];
        machineListByServerIdState = {
            server1: [],
            server2: [
                { id: 'm3', revokedAt: null },
            ],
        };

        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const contextBar = tree!.root.findByType('ContextBar' as any);
        expect(contextBar.props.machine.selectedId).toBe('m1');
        expect(contextBar.props.machine.items.map((item: any) => item.id)).toEqual(['m1', 'm2']);

        expect(useCLIDetectionMock).toHaveBeenLastCalledWith('m1', expect.objectContaining({
            serverId: 'server1',
        }));
        expect(useCapabilityInstallabilityMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'm1',
            serverId: 'server1',
        }));
    });

    it('uses the context bar machine selection for CLI detection and installability', async () => {
        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const contextBar = tree!.root.findByType('ContextBar' as any);
        await act(async () => {
            contextBar.props.machine.onSelect('m2');
        });

        expect(useCLIDetectionMock).toHaveBeenLastCalledWith('m2', expect.objectContaining({
            serverId: 'server1',
            agentIds: ['codex'],
        }));
        expect(useCapabilityInstallabilityMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'm2',
            serverId: 'server1',
        }));
    });

    it('marks the installer row as managed-installed when the detected CLI resolves inside Happier tools', async () => {
        cliDetectionState.available = { codex: true };
        cliDetectionState.resolutionSource = { codex: 'managed' };

        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const installer = tree!.root.findByType('ProviderCliInstallItem' as any);
        expect(installer.props.installed).toBe(true);
        expect(installer.props.managedInstalled).toBe(true);
    });

    it('updates the selected machine when the active server changes', async () => {
        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(useCLIDetectionMock).toHaveBeenLastCalledWith('m1', expect.objectContaining({
            autoDetect: true,
            includeLoginStatus: true,
            serverId: 'server1',
        }));
        expect(useCapabilityInstallabilityMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'm1',
            capabilityId: 'cli.codex',
            serverId: 'server1',
        }));

        await act(async () => {
            activeServerSnapshot = {
                serverId: 'server2',
                serverUrl: 'http://localhost:4000',
                generation: 2,
            };
            activeServerSubscriber?.(activeServerSnapshot);
        });

        const contextBar = tree!.root.findByType('ContextBar' as any);
        expect(contextBar.props.machine.selectedId).toBe('m3');
        expect(contextBar.props.machine.items.map((item: any) => item.id)).toEqual(['m3']);

        expect(useCLIDetectionMock).toHaveBeenLastCalledWith('m3', expect.objectContaining({
            autoDetect: true,
            includeLoginStatus: true,
            serverId: 'server2',
        }));
        expect(useCapabilityInstallabilityMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'm3',
            capabilityId: 'cli.codex',
            serverId: 'server2',
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('includes a permissions section to set the default permission mode for this backend', async () => {
        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const items = tree!.root.findAllByType('Item' as any);
        const permissionItem = items.find((item: any) => item?.props?.title === 'settingsSession.permissions.defaultPermissionModeTitle');
        expect(permissionItem).toBeTruthy();
    });

    it('renders an authentication section when local CLI auth details are available', async () => {
        cliDetectionState.available = { codex: true };
        cliDetectionState.login = { codex: true };
        cliDetectionState.authStatus = {
            codex: {
                state: 'logged_in',
                accountLabel: 'alice@example.com',
                method: 'oauth_cli',
                source: 'command',
                checkedAt: 123,
            },
        };
        cliDetectionState.timestamp = 123;

        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const groups = tree!.root.findAllByType('ItemGroup' as any);
        const authenticationGroup = groups.find((item: any) => item?.props?.title === 'settingsProviders.authentication.title');
        expect(authenticationGroup).toBeTruthy();
    });

    it('renders a login action when local auth is supported but logged out', async () => {
        cliDetectionState.available = { codex: true };
        cliDetectionState.login = { codex: false };
        cliDetectionState.authStatus = {
            codex: {
                state: 'logged_out',
                reason: 'missing_credentials',
                checkedAt: 123,
            },
        };
        cliDetectionState.timestamp = 123;

        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const items = tree!.root.findAllByType('Item' as any);
        const loginAction = items.find((item: any) => item?.props?.title === 'settingsProviders.authentication.logInTitle');
        expect(loginAction).toBeTruthy();
    });

    it('uses the shared pane scope host for the provider auth terminal', async () => {
        cliDetectionState.available = { codex: true };
        cliDetectionState.login = { codex: false };
        cliDetectionState.authStatus = {
            codex: {
                state: 'logged_out',
                reason: 'missing_credentials',
                checkedAt: 123,
            },
        };
        cliDetectionState.timestamp = 123;

        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const hostBefore = tree!.root.findByType('AppPaneScopeHost' as any);
        expect(hostBefore.props.bottomPane).toBeNull();
        expect(hostBefore.props.scopeId).toBe('settings:provider:codex');

        const loginAction = tree!.root.findAllByType('Item' as any).find((item: any) => item?.props?.title === 'settingsProviders.authentication.logInTitle');
        expect(loginAction).toBeTruthy();

        await act(async () => {
            loginAction!.props.onPress();
        });

        expect(paneApi.openBottom).toHaveBeenCalledWith({ tabId: 'provider-auth-terminal' });

        paneApi.scopeState = {
            bottom: {
                isOpen: true,
                activeTabId: 'provider-auth-terminal',
            },
        };

        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });

        const hostAfter = tree!.root.findByType('AppPaneScopeHost' as any);
        expect(hostAfter.props.bottomPane).toBeTruthy();
        expect(hostAfter.props.bottomPane.props.providerId).toBe('codex');
    });

    it('refreshes provider auth detection when the auth terminal pane closes', async () => {
        cliDetectionState.available = { codex: true };
        cliDetectionState.login = { codex: false };
        cliDetectionState.authStatus = {
            codex: {
                state: 'logged_out',
                reason: 'missing_credentials',
                checkedAt: 123,
            },
        };
        cliDetectionState.timestamp = 123;
        paneApi.scopeState = {
            bottom: {
                isOpen: true,
                activeTabId: 'provider-auth-terminal',
            },
        };

        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const host = tree!.root.findByType('AppPaneScopeHost' as any);
        expect(host.props.bottomPane).toBeTruthy();

        await act(async () => {
            host.props.bottomPane.props.onRequestClose();
        });

        expect(paneApi.closeBottom).toHaveBeenCalledTimes(1);
        expect(cliDetectionState.refresh).toHaveBeenCalledWith({
            bypassCache: true,
            includeLoginStatusForAgentIds: ['codex'],
        });
    });

    it('closes the auth terminal and refreshes provider auth detection when the auth terminal exits', async () => {
        cliDetectionState.available = { codex: true };
        cliDetectionState.login = { codex: false };
        cliDetectionState.authStatus = {
            codex: {
                state: 'logged_out',
                reason: 'missing_credentials',
                checkedAt: 123,
            },
        };
        cliDetectionState.timestamp = 123;
        paneApi.scopeState = {
            bottom: {
                isOpen: true,
                activeTabId: 'provider-auth-terminal',
            },
        };

        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const host = tree!.root.findByType('AppPaneScopeHost' as any);
        expect(host.props.bottomPane).toBeTruthy();

        await act(async () => {
            host.props.bottomPane.props.onTerminalExit();
        });

        expect(paneApi.closeBottom).toHaveBeenCalledTimes(1);
        expect(cliDetectionState.refresh).toHaveBeenCalledWith({
            bypassCache: true,
            includeLoginStatusForAgentIds: ['codex'],
        });
    });

    it('renders and updates the backend CLI source preference when a managed install exists', async () => {
        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const sourceMenu = tree!.root
            .findAllByType('DropdownMenu' as any)
            .find((node: any) => node.props?.itemTrigger?.title === 'settingsProviders.cliSourcePreference.title');
        expect(sourceMenu).toBeTruthy();
        expect(sourceMenu!.props.selectedId).toBe('system-first');

        await act(async () => {
            sourceMenu!.props.onSelect('managed-first');
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            backendCliSourcePreferenceById: {
                codex: 'managed-first',
            },
        });
    });

    it('reflects configured runtime-kind capability overrides in the badges', async () => {
        mockProviderId = 'codex';
        (settingsState as any).codexBackendMode = 'mcp';
        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const badgeGrid = tree!.root.findByType('BadgeGrid' as any);
        const localControlItem = badgeGrid.props.items.find((item: any) => item.id === 'localControl');
        expect(localControlItem).toMatchObject({
            status: 'negative',
            detail: 'settingsProviders.notSupported',
        });

        delete (settingsState as any).codexBackendMode;
    });

    it('redirects the custom ACP provider route back to the providers index', async () => {
        mockProviderId = 'customAcp';
        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const redirect = tree!.root.findByType('Redirect' as any);
        expect(redirect.props.href).toBe('/(app)/settings/providers');
    });

    it('reads and writes the OpenCode server url per active server', async () => {
        mockProviderId = 'opencode';
        settingsState.opencodeServerBaseUrl = 'http://127.0.0.1:4999/';
        settingsState.opencodeServerBaseUrlByServerIdV1 = {
            server1: 'http://127.0.0.1:4096/',
            server2: 'http://127.0.0.1:4097/',
        };
        mockProviderSettingsPlugin.mockReturnValue({
            providerId: 'opencode',
            title: 'OpenCode',
            icon: { ionName: 'code-slash-outline', color: '#5AC8FA' },
            settings: {},
            uiSections: [
                {
                    id: 'opencodeServer',
                    title: 'Server connection',
                    fields: [{
                        key: 'opencodeServerBaseUrl',
                        kind: 'text',
                        title: 'Existing OpenCode server URL',
                        binding: {
                            kind: 'perActiveServer',
                            fallbackSettingKey: 'opencodeServerBaseUrl',
                            byServerIdSettingKey: 'opencodeServerBaseUrlByServerIdV1',
                        },
                    }],
                },
            ],
            buildOutgoingMessageMetaExtras: () => ({}),
        });

        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        let textInputs = tree!.root.findAllByType('TextInput' as any);
        expect(textInputs).toHaveLength(1);
        expect(textInputs[0]?.props.value).toBe('http://127.0.0.1:4096/');

        await act(async () => {
            textInputs[0]?.props.onChangeText('http://127.0.0.1:5000/');
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            opencodeServerBaseUrlByServerIdV1: {
                server1: 'http://127.0.0.1:5000/',
                server2: 'http://127.0.0.1:4097/',
            },
        });

        await act(async () => {
            activeServerSnapshot = {
                serverId: 'server2',
                serverUrl: 'http://localhost:4000',
                generation: 2,
            };
            activeServerSubscriber?.(activeServerSnapshot);
        });

        textInputs = tree!.root.findAllByType('TextInput' as any);
        expect(textInputs[0]?.props.value).toBe('http://127.0.0.1:4097/');
    });

    it('renders translated number placeholders for provider settings fields', async () => {
        mockProviderId = 'opencode';
        mockProviderSettingsPlugin.mockReturnValue({
            providerId: 'opencode',
            title: { key: 'settingsProviders.plugins.opencode.title' },
            icon: { ionName: 'code-slash-outline', color: '#5AC8FA' },
            settings: {},
            uiSections: [
                {
                    id: 'limits',
                    title: { key: 'settingsProviders.cliConnection' },
                    fields: [{
                        key: 'thinkingBudget',
                        kind: 'number',
                        title: { key: 'settingsProviders.targetMachineTitle' },
                        numberSpec: {
                            placeholder: { key: 'common.default' },
                        },
                    }],
                },
            ],
            buildOutgoingMessageMetaExtras: () => ({}),
        });

        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const textInputs = tree!.root.findAllByType('TextInput' as any);
        expect(textInputs).toHaveLength(1);
        expect(textInputs[0]?.props.placeholder).toBe('common.default');
    });

    it('renders the not found screen without requiring pane context', async () => {
        mockProviderId = 'unknown';
        shouldThrowOnAppPaneScope = true;
        const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const groups = tree!.root.findAllByType('ItemGroup' as any);
        expect(groups.length).toBeGreaterThan(0);
    });
});
const settingsState = {
    backendEnabledByTargetKey: {},
    sessionDefaultPermissionModeByTargetKey: {},
    backendCliSourcePreferenceById: {},
    contextSelectionsV1: undefined as any,
    acpCatalogSettingsV1: { v: 2, backends: [] },
    opencodeServerBaseUrl: '',
    opencodeServerBaseUrlByServerIdV1: {} as Record<string, string>,
};
