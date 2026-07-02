import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAuthStatusData } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { ProviderSettingsBehavior, ProviderSettingsDescriptor } from '@/agents/providers/shared/providerSettingsPlugin';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { createExpoVectorIconsMock } from '@/dev/testkit/mocks/icons';
import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks } from '../sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockProviderId: string | null = 'codex';
let shouldThrowOnAppPaneScope = false;
const routerPushSpy = vi.fn();
const mockProviderSettingsDescriptor = vi.hoisted(
    () => vi.fn<(providerId: string) => ProviderSettingsDescriptor | null>(() => null),
);
const mockProviderSettingsBehavior = vi.hoisted(
    () => vi.fn<(providerId: string) => ProviderSettingsBehavior | null>(() => null),
);
const mockProviderCatalogProjection = vi.hoisted(
    () => vi.fn<(providerId: string, params?: Record<string, unknown>) => {
        providerId: string;
        providerAgentId: string | null;
        iconAgentId: string | null;
        title: string;
        subtitle: string | null;
        iconName: string;
        isBuiltIn: boolean;
        backendTargetKey: string | null;
        enabled: boolean | null;
        descriptor: ProviderSettingsDescriptor | null;
        behavior: ProviderSettingsBehavior | null;
        authPlugin: any;
        backendEntry: any;
    } | null>(() => null),
);
const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() => vi.fn());

const machineCapabilitiesInvokeMock = vi.fn(async () => ({
    supported: true,
    response: { ok: true, result: { plan: null } },
}));
const applySettingsMock = vi.fn();
const tauriDesktopState = vi.hoisted(() => ({ value: true }));
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
let activeServerSubscribers = new Set<(snapshot: ActiveServerSnapshot) => void>();
function emitActiveServerSnapshot(snapshot: ActiveServerSnapshot) {
    for (const subscriber of activeServerSubscribers) {
        subscriber(snapshot);
    }
}
const passThrough = (componentName: string) => createPassThroughModule([componentName]);

installSessionSettingsEntryModuleMocks({
    reactNative: () =>
        createReactNativeWebMock({
            View: 'View',
            TextInput: 'TextInput',
            Easing: {
                bezier: () => 'bezier',
                linear: 'linear',
            },
            Platform: {
                OS: 'ios',
                select: (value: any) => (value && typeof value === 'object' ? (value.ios ?? value.default) : value),
            },
        }),
    unistyles: () => createUnistylesMock(),
    routerModule: () => {
        const routerMock = createExpoRouterMock({
            router: {
                push: (value) => routerPushSpy(value),
                back: () => undefined,
                replace: () => undefined,
                setParams: vi.fn(),
            },
        });
        return {
            ...routerMock.module,
            useLocalSearchParams: () => ({ providerId: mockProviderId }),
            Redirect: (props: any) => React.createElement('Redirect', props),
        };
    },
    textModule: () => createTextModuleMock({ translate: (key) => key }),
    storageModule: (importOriginal) =>
        createStorageModuleMock({
            importOriginal,
            overrides: {
                // Test boundary fixture: this route reads a small subset of the storage contract.
                useSettings: (() => settingsState) as any,
                useAllMachines: (() => machinesState) as any,
                useMachineListByServerId: (() => machineListByServerIdState) as any,
                useMachineListStatusByServerId: (() => machineListStatusByServerIdState) as any,
                useLocalSetting: ((key: string) => {
                    if (key === 'bottomPaneHeightPx') return 320;
                    if (key === 'bottomPaneHeightBasisPx') return 900;
                    return undefined;
                }) as any,
                useLocalSettingMutable: ((key: string) => {
                    if (key === 'bottomPaneHeightPx') return [320, vi.fn()] as const;
                    if (key === 'bottomPaneHeightBasisPx') return [900, vi.fn()] as const;
                    if (key === 'contextSelectionsV1') {
                        return [
                            settingsState.contextSelectionsV1,
                            (next: any) => {
                                settingsState.contextSelectionsV1 = next;
                            },
                        ] as const;
                    }
                    return [undefined, vi.fn()] as const;
                }) as any,
                useSettingMutable: ((key: string) => {
                    if (key === 'contextSelectionsV1') {
                        return [
                            settingsState.contextSelectionsV1,
                            (next: any) => {
                                settingsState.contextSelectionsV1 = next;
                            },
                        ] as const;
                    }
                    return [undefined, vi.fn()] as const;
                }) as any,
                useSetting: (key: string) => {
                    if (key === 'serverSelectionGroups') return {};
                    if (key === 'serverSelectionActiveTargetKind') return 'server';
                    if (key === 'serverSelectionActiveTargetId') return 'server1';
                    return undefined;
                },
                useProfile: () => ({
                    id: 'profile-1',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServicesV2: [
                        {
                            serviceId: 'anthropic',
                            profiles: [{
                                profileId: 'work',
                                status: 'needs_reauth',
                                providerEmail: null,
                                providerAccountId: null,
                                kind: 'token',
                                expiresAt: null,
                                lastUsedAt: null,
                                health: null,
                            }],
                            groups: [],
                        },
                    ],
                }),
                useMachine: () => null,
            },
        }),
    featureEnabled: () => true,
});

vi.mock('@expo/vector-icons', () => createExpoVectorIconsMock());

vi.mock('@/components/ui/lists/ItemList', () => passThrough('ItemList'));

vi.mock('@/components/ui/lists/ItemGroup', () => passThrough('ItemGroup'));

vi.mock('@/components/ui/lists/Item', () => passThrough('Item'));

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

vi.mock('@/components/settings/connectedServices/ConnectedServicesDefaultAuthRow', () => ({
    ConnectedServicesDefaultAuthRow: (props: any) => React.createElement('ConnectedServicesDefaultAuthRow', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: applySettingsMock,
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    listServerProfiles: () => [{ id: 'server1', serverUrl: 'http://localhost:3000', webappUrl: 'http://localhost:8081', name: 'server1' }],
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    subscribeActiveServer: (listener: (snapshot: ActiveServerSnapshot) => void) => {
        activeServerSubscribers.add(listener);
        return () => {
            activeServerSubscribers.delete(listener);
        };
    },
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    getEffectiveServerSelectionFromRawSettings: () => ({ serverIds: ['server1'] }),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) =>
        machineContributionRegistryProjectionDescribeMock(...args),
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
    const createMockAgentCore = (agentId: string) => {
        if (agentId === 'claude') {
            return {
                id: agentId,
                displayNameKey: 'Claude',
                subtitleKey: 'subtitle',
                availability: { experimental: false },
                resume: { supportsVendorResume: false, experimental: false },
                sessionModes: { kind: 'none' },
                model: {
                    supportsSelection: true,
                    supportsFreeform: true,
                    defaultMode: 'claude-sonnet-4-6',
                    allowedModes: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
                    dynamicProbe: 'static-only',
                    nonAcpApplyScope: 'spawn_only',
                    acpApplyBehavior: 'set_model',
                    acpModelConfigOptionId: null,
                },
                cli: {
                    detectKey: agentId,
                    installBanner: { installKind: 'installer', installCommand: null, guideUrl: null },
                },
                connectedServices: { supportedServiceIds: ['anthropic'] },
                uiConnectedService: { serviceId: null, label: 'cloud', connectRoute: null },
                localControl: { supported: false },
                ui: { agentPickerIconName: 'sparkles-outline' },
            };
        }

        return {
            id: agentId,
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
            connectedServices: agentId === 'codex'
                ? { supportedServiceIds: ['anthropic'] }
                : undefined,
            uiConnectedService: {
                serviceId: null,
                label: agentId === 'customAcp' ? 'Custom ACP' : 'cloud',
                connectRoute: null,
            },
            localControl: { supported: false },
            ui: { agentPickerIconName: agentId === 'customAcp' ? 'git-network-outline' : 'code-slash-outline' },
        };
    };
    return {
        ...actual,
        AGENT_IDS: ['legacy.codex', 'legacy.customAcp', 'legacy.opencode'],
        isAgentId: (v: any) => v === 'codex' || v === 'customAcp' || v === 'opencode' || v === 'claude',
        getAgentCore: (agentId: string) => createMockAgentCore(agentId),
    };
});

vi.mock('@/agents/catalog/providerSettingsCatalog', () => ({
    PROVIDER_SETTINGS_DESCRIPTORS: [],
    PROVIDER_SETTINGS_PLUGINS: [],
    getProviderSettingsDescriptor: (providerId: string) => mockProviderSettingsDescriptor(providerId),
    getProviderSettingsBehavior: (providerId: string) => mockProviderSettingsBehavior(providerId),
    getProviderSettingsPlugin: (providerId: string) => {
        const descriptor = mockProviderSettingsDescriptor(providerId);
        const behavior = mockProviderSettingsBehavior(providerId);
        return descriptor && behavior ? { ...descriptor, ...behavior } : null;
    },
}));

vi.mock('@/agents/backendCatalog/providerCatalogProjection', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/backendCatalog/providerCatalogProjection')>();
    return {
        ...actual,
        getResolvedProviderCatalogEntries: (params: Record<string, unknown>) => {
            const entries = actual.getResolvedProviderCatalogEntries(
                params as Parameters<typeof actual.getResolvedProviderCatalogEntries>[0],
            );
            const currentProviderId = typeof mockProviderId === 'string' ? mockProviderId.trim().toLowerCase() : '';
            if (!currentProviderId) {
                return entries;
            }
            const mockedProjection = mockProviderCatalogProjection(currentProviderId, params);
            if (!mockedProjection || entries.some((entry) => entry.providerId === mockedProjection.providerId)) {
                return entries;
            }
            return [...entries, mockedProjection];
        },
        resolveProviderCatalogProjection: (providerId: string, params?: Record<string, unknown>) =>
            mockProviderCatalogProjection(providerId, params) ?? actual.resolveProviderCatalogProjection(providerId, params as Parameters<typeof actual.resolveProviderCatalogProjection>[1]),
    };
});

vi.mock('@/agents/providers/catalog/providerLocalAuthCatalog', () => ({
    getProviderLocalAuthPlugin: () => ({
        providerId: 'codex',
        support: 'login_terminal',
        docsUrl: 'https://example.com/codex',
        buildLoginLaunch: () => ({ initialCommand: 'codex login' }),
    }),
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
        getAgentCliRuntimeSpec: () => ({
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

vi.mock('@/components/settings/providers/ProviderCliInstallItem', () => passThrough('ProviderCliInstallItem'));

vi.mock('@/components/contextBar/ContextBar', () => passThrough('ContextBar'));

vi.mock('@/components/ui/layout/BadgeGrid', () => passThrough('BadgeGrid'));

vi.mock(
    '@/components/settings/providers/authentication/ProviderAuthenticationTerminalPane',
    () => passThrough('ProviderAuthenticationTerminalPane'),
);

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
            loginLaunch: providerId ? { initialCommand: `${providerId} login` } : null,
            authStatus,
            canCheckNow: true,
            loginActionKind: authStatus?.state === 'logged_in' ? 'reauthenticate' : 'login',
            docsUrl: null,
        };
    },
}));

async function renderProviderSettingsScreen() {
    const Screen = (await import('@/app/(app)/settings/providers/[providerId]')).default;
    return renderScreen(React.createElement(Screen));
}

describe('ProviderSettingsScreen', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        clearDaemonMergedProjectionCacheForTests();
        mockProviderId = 'codex';
        shouldThrowOnAppPaneScope = false;
        tauriDesktopState.value = true;
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
        settingsState.backendCliSourcePreferenceByTargetKey = {};
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
        activeServerSubscribers = new Set();
        useCLIDetectionMock.mockReset();
        useCLIDetectionMock.mockImplementation(() => cliDetectionState);
        useCapabilityInstallabilityMock.mockReset();
        useCapabilityInstallabilityMock.mockReturnValue({ kind: 'installable' });
        routerPushSpy.mockReset();
        mockProviderSettingsDescriptor.mockReset();
        mockProviderSettingsDescriptor.mockReturnValue(null);
        mockProviderSettingsBehavior.mockReset();
        mockProviderSettingsBehavior.mockReturnValue(null);
        mockProviderCatalogProjection.mockReset();
        mockProviderCatalogProjection.mockImplementation((providerId: string, params?: Record<string, unknown>) => {
            const descriptor = mockProviderSettingsDescriptor(providerId);
            const behavior = mockProviderSettingsBehavior(providerId);
            const isBuiltIn = providerId === 'claude' || providerId === 'codex' || providerId === 'opencode' || providerId === 'customAcp';
            if (!isBuiltIn) {
                return null;
            }
            return {
                providerId,
                providerAgentId: isBuiltIn ? providerId : null,
                iconAgentId: isBuiltIn ? providerId : null,
                title: descriptor ? (typeof descriptor.title === 'string' ? descriptor.title : descriptor.title.key) : providerId,
                subtitle: descriptor?.providerId ?? providerId,
                iconName: isBuiltIn ? 'code-slash-outline' : 'layers-outline',
                isBuiltIn,
                backendTargetKey: isBuiltIn ? `agent:${providerId}` : null,
                enabled: isBuiltIn ? true : null,
                descriptor,
                behavior,
                authPlugin: providerId === 'codex'
                    ? {
                        providerId,
                        support: 'login_terminal',
                        docsUrl: 'https://example.com/codex',
                        buildLoginLaunch: () => ({ initialCommand: 'codex login' }),
                    }
                    : null,
                backendEntry: null,
            };
        });
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: false,
            reason: 'not-supported',
        });
    });

    it('uses daemon merged projection inputs when resolving a plugin provider settings screen', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        await renderProviderSettingsScreen();

        // Flush the projection RPC -> state -> re-render before checking the projection call-site.
        await act(async () => {});
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m1', expect.objectContaining({
            serverId: 'server1',
        }));
        expect(mockProviderCatalogProjection).toHaveBeenCalledWith(
            'acme.review.provider',
            expect.objectContaining({
                mergedProviderProjectionById: expect.objectContaining({
                    'acme.review.provider': expect.objectContaining({
                        title: 'Acme Review Provider',
                    }),
                }),
                mergedBackendProjectionById: expect.objectContaining({
                    'acme.review.backend': expect.objectContaining({
                        title: 'Acme Review Backend',
                        providerAgentId: 'claude',
                        iconAgentId: 'codex',
                    }),
                }),
            }),
        );

        machineContributionRegistryProjectionDescribeMock.mockClear();

        await act(async () => {
            activeServerSnapshot = {
                serverId: 'server2',
                serverUrl: 'http://localhost:4000',
                generation: 2,
            };
            emitActiveServerSnapshot(activeServerSnapshot);
        });
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m1', expect.objectContaining({
            serverId: 'server2',
        }));
    });

    it('refetches daemon projection inputs for the selected machine instead of pinning the first machine', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderProviderSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const contextBar = screen.findByType('ContextBar' as any);
        machineContributionRegistryProjectionDescribeMock.mockClear();

        await act(async () => {
            contextBar.props.machine.onSelect('m2');
        });
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m2', expect.objectContaining({
            serverId: 'server1',
        }));
    });

    it('renders the full provider settings/auth surface for a daemon-projected plugin provider backed by a built-in provider', async () => {
        mockProviderId = 'acme.review.provider';
        mockProviderSettingsDescriptor.mockImplementation((providerId) => {
            if (providerId === 'claude') {
                return {
                    providerId: 'claude',
                    title: 'Claude',
                    icon: { ionName: 'sparkles-outline', color: 'blue' },
                    settings: {},
                    uiSections: [],
                };
            }
            return null;
        });
        mockProviderSettingsBehavior.mockImplementation((providerId) => (
            providerId === 'claude'
                ? { providerId: 'claude' }
                : null
        ));
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderProviderSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        expect(screen.findByTestId('settings-provider-auth-status')).toBeTruthy();
        expect(screen.findAllByType('ProviderCliInstallItem' as any)).toHaveLength(1);
        const items = screen.findAllByType('Item' as any);
        expect(items.some((node: any) => node.props?.title === 'Acme Review Provider')).toBe(true);
        expect(items.some((node: any) => node.props?.title === 'settingsProviders.notAvailable')).toBe(false);
        const projectedIdentityRow = items.find((node: any) => node.props?.title === 'Acme Review Provider');
        expect(projectedIdentityRow?.props?.icon?.props?.name).toBe('code-slash-outline');
    });

    it('renders the projected provider detail screen even when the provider has no built-in runtime carrier', async () => {
        mockProviderId = 'acme.headless.provider';
        mockProviderCatalogProjection.mockReturnValue({
            providerId: 'acme.headless.provider',
            providerAgentId: null,
            iconAgentId: 'claude',
            title: 'Acme Headless Provider',
            subtitle: 'Plugin provider',
            iconName: 'layers-outline',
            isBuiltIn: false,
            backendTargetKey: null,
            enabled: null,
            descriptor: {
                providerId: 'acme.headless.provider',
                title: 'Acme Headless Provider',
                icon: { ionName: 'layers-outline', color: '#999999' },
                settings: {},
                uiSections: [],
            },
            behavior: {
                providerId: 'acme.headless.provider',
            },
            authPlugin: null,
            backendEntry: null,
        });

        const screen = await renderProviderSettingsScreen();
        const items = screen.findAllByType('Item' as any);
        expect(items.some((node: any) => node.props?.title === 'Acme Headless Provider')).toBe(true);
        expect(items.some((node: any) => node.props?.title === 'settingsProviders.notAvailable')).toBe(false);
        const projectedIdentityRow = items.find((node: any) => node.props?.title === 'Acme Headless Provider');
        expect(projectedIdentityRow?.props?.icon?.props?.name).toBe('sparkles-outline');
    });

    it('does not synthesize a built-in target key for plugin-backed provider controls when projection truth is missing', async () => {
        mockProviderId = 'acme.review.provider';
        mockProviderCatalogProjection.mockReturnValue({
            providerId: 'acme.review.provider',
            providerAgentId: 'claude',
            iconAgentId: 'codex',
            title: 'Acme Review Provider',
            subtitle: 'Plugin provider',
            iconName: 'layers-outline',
            isBuiltIn: false,
            backendTargetKey: null,
            enabled: null,
            descriptor: {
                providerId: 'claude',
                title: 'Claude',
                icon: { ionName: 'sparkles-outline', color: 'blue' },
                settings: {},
                uiSections: [],
            },
            behavior: {
                providerId: 'claude',
            },
            authPlugin: null,
            backendEntry: null,
        });

        const screen = await renderProviderSettingsScreen();
        const enabledRow = screen.findAllByType('Item' as any).find((node: any) => node.props?.title === 'settingsProviders.enabledTitle');
        expect(enabledRow).toBeUndefined();
    });

    it('surfaces provider CLI install via capability installer item', async () => {
        const screen = await renderProviderSettingsScreen();
        expect(mockProviderCatalogProjection).toHaveBeenCalledWith(
            'codex',
            expect.objectContaining({
                enabledAgentIds: [],
            }),
        );
        const installer = screen.findByType('ProviderCliInstallItem' as any);
        expect(installer.props.machineId).toBe('m1');
        expect(installer.props.serverId).toBe('server1');
        expect(installer.props.capabilityId).toBe('cli.codex');
        expect(installer.props.installed).toBe(false);
        expect(installer.props.managedInstalled).toBe(false);
        expect(installer.props.installability).toMatchObject({ kind: 'installable' });
    });

    it('keeps provider CLI install available on web while hiding desktop-only auth actions', async () => {
        tauriDesktopState.value = false;

        const screen = await renderProviderSettingsScreen();

        expect(screen.findAllByType('ProviderCliInstallItem' as any)).toHaveLength(1);
        expect(screen.findAllByType('ProviderAuthenticationTerminalPane' as any)).toHaveLength(0);
        expect(screen.findByTestId('settings-provider-auth-status')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-auth-check-now')).toBeNull();
        expect(screen.findByTestId('settings-provider-auth-login')).toBeNull();
    });

    it('renders a machine-only context bar scoped to the active server machines', async () => {
        const screen = await renderProviderSettingsScreen();
        const contextBar = screen.findByType('ContextBar' as any);
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

        const screen = await renderProviderSettingsScreen();
        const contextBar = screen.findByType('ContextBar' as any);
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
        const screen = await renderProviderSettingsScreen();
        const contextBar = screen.findByType('ContextBar' as any);
        await act(async () => {
            contextBar.props.machine.onSelect('m2');
        });
        await flushHookEffects();

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

        const screen = await renderProviderSettingsScreen();
        const installer = screen.findByType('ProviderCliInstallItem' as any);
        expect(installer.props.installed).toBe(true);
        expect(installer.props.managedInstalled).toBe(true);
    });

    it('updates the selected machine when the active server changes', async () => {
        const screen = await renderProviderSettingsScreen();

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
            emitActiveServerSnapshot(activeServerSnapshot);
        });
        await flushHookEffects();

        const contextBar = screen.findByType('ContextBar' as any);
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

    });

    it('includes a permissions section to set the default permission mode for this backend', async () => {
        const screen = await renderProviderSettingsScreen();
        const items = screen.findAllByType('Item' as any);
        const permissionItem = items.find((item: any) => item?.props?.title === 'settingsSession.permissions.defaultPermissionModeTitle');
        expect(permissionItem).toBeTruthy();
    });

    it('shows the provider default model as a friendly model name instead of a raw model id', async () => {
        mockProviderId = 'claude';

        const screen = await renderProviderSettingsScreen();
        const items = screen.findAllByType('Item' as any);
        const defaultModelItem = items.find((item: any) => item?.props?.title === 'settingsProviders.defaultModelTitle');

        expect(defaultModelItem?.props?.subtitle).toBe('Sonnet 4.6');
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

        const screen = await renderProviderSettingsScreen();
        expect(screen.findByTestId('settings-provider-auth-status')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-auth-account')).toBeTruthy();
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

        const screen = await renderProviderSettingsScreen();
        expect(screen.findByTestId('settings-provider-auth-login')).toBeTruthy();
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

        const screen = await renderProviderSettingsScreen();
        const hostBefore = screen.findByType('AppPaneScopeHost' as any);
        expect(hostBefore.props.bottomPane).toBeNull();
        expect(hostBefore.props.scopeId).toBe('settings:provider:codex');

        await screen.pressByTestIdAsync('settings-provider-auth-login');
        await flushHookEffects();

        expect(paneApi.openBottom).toHaveBeenCalledWith({ tabId: 'provider-auth-terminal' });

        await act(async () => {
            paneApi.scopeState = {
                bottom: {
                    isOpen: true,
                    activeTabId: 'provider-auth-terminal',
                },
            };
        });
        const rerenderedScreen = await renderProviderSettingsScreen();

        const hostAfter = rerenderedScreen.findByType('AppPaneScopeHost' as any);
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

        const screen = await renderProviderSettingsScreen();
        const host = screen.findByType('AppPaneScopeHost' as any);
        expect(host.props.bottomPane).toBeTruthy();

        await act(async () => {
            host.props.bottomPane.props.onRequestClose();
        });
        await flushHookEffects();

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

        const screen = await renderProviderSettingsScreen();
        const host = screen.findByType('AppPaneScopeHost' as any);
        expect(host.props.bottomPane).toBeTruthy();

        await act(async () => {
            host.props.bottomPane.props.onTerminalExit();
        });
        await flushHookEffects();

        expect(paneApi.closeBottom).toHaveBeenCalledTimes(1);
        expect(cliDetectionState.refresh).toHaveBeenCalledWith({
            bypassCache: true,
            includeLoginStatusForAgentIds: ['codex'],
        });
    });

    it('renders and updates the backend CLI source preference when a managed install exists', async () => {
        const screen = await renderProviderSettingsScreen();
        const sourceMenu = screen
            .findAllByType('DropdownMenu' as any)
            .find((node: any) => node.props?.itemTrigger?.title === 'settingsProviders.cliSourcePreference.title');
        expect(sourceMenu).toBeTruthy();
        expect(sourceMenu!.props.selectedId).toBe('system-first');

        await act(async () => {
            sourceMenu!.props.onSelect('managed-first');
        });
        await flushHookEffects();

        expect(applySettingsMock).toHaveBeenCalledWith({
            backendCliSourcePreferenceByTargetKey: {
                'agent:codex': 'managed-first',
            },
        });
    });

    it('reflects configured runtime-kind capability overrides in the badges', async () => {
        mockProviderId = 'codex';
        (settingsState as any).codexBackendMode = 'mcp';
        const screen = await renderProviderSettingsScreen();
        const badgeGrid = screen.findByType('BadgeGrid' as any);
        const localControlItem = badgeGrid.props.items.find((item: any) => item.id === 'localControl');
        expect(localControlItem).toMatchObject({
            status: 'negative',
            detail: 'settingsProviders.notSupported',
        });

        delete (settingsState as any).codexBackendMode;
    });

    it('redirects the custom ACP provider route back to the providers index', async () => {
        mockProviderId = 'customAcp';
        const screen = await renderProviderSettingsScreen();
        const redirect = screen.findByType('Redirect' as any);
        expect(redirect.props.href).toBe('/(app)/settings/providers');
    });

    it('redirects the legacy custom ACP provider route to the canonical projected provider when merged projection resolves one', async () => {
        mockProviderId = 'customAcp';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderProviderSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const redirect = screen.findByType('Redirect' as any);
        expect(redirect.props.href).toEqual({
            pathname: '/(app)/settings/providers/[providerId]',
            params: {
                providerId: 'acme.review.provider',
            },
        });
    });

    it('reads and writes the OpenCode server url per active server', async () => {
        mockProviderId = 'opencode';
        settingsState.opencodeServerBaseUrl = 'http://127.0.0.1:4999/';
        settingsState.opencodeServerBaseUrlByServerIdV1 = {
            server1: 'http://127.0.0.1:4096/',
            server2: 'http://127.0.0.1:4097/',
        };
        mockProviderSettingsDescriptor.mockReturnValue({
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
        });
        mockProviderSettingsBehavior.mockReturnValue({
            providerId: 'opencode',
            ExtraSectionsComponent: passThrough('RuntimeSections').RuntimeSections,
        });

        const screen = await renderProviderSettingsScreen();
        let textInputs = screen.findAllByType('TextInput' as any);
        expect(textInputs).toHaveLength(1);
        expect(textInputs[0]?.props.value).toBe('http://127.0.0.1:4096/');

        await act(async () => {
            textInputs[0]?.props.onChangeText('http://127.0.0.1:5000/');
        });
        await flushHookEffects();

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
            emitActiveServerSnapshot(activeServerSnapshot);
        });
        await flushHookEffects();

        textInputs = screen.findAllByType('TextInput' as any);
        expect(textInputs[0]?.props.value).toBe('http://127.0.0.1:4097/');
    });

    it('renders translated number placeholders for provider settings fields', async () => {
        mockProviderId = 'opencode';
        mockProviderSettingsDescriptor.mockReturnValue({
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
        });
        mockProviderSettingsBehavior.mockReturnValue({
            providerId: 'opencode',
        });

        const screen = await renderProviderSettingsScreen();
        const textInputs = screen.findAllByType('TextInput' as any);
        expect(textInputs).toHaveLength(1);
        expect(textInputs[0]?.props.placeholder).toBe('common.default');
    });

    it('renders a descriptor-backed fallback for non-built-in provider ids without requiring pane context', async () => {
        mockProviderId = 'acme.review.backend';
        shouldThrowOnAppPaneScope = true;
        mockProviderSettingsDescriptor.mockReturnValue(null);
        mockProviderSettingsBehavior.mockReturnValue(null);
        mockProviderCatalogProjection.mockReturnValue({
            providerId: 'acme.review.backend',
            providerAgentId: null,
            iconAgentId: 'claude',
            title: 'Acme Review Backend',
            subtitle: 'acme.review.backend',
            iconName: 'code-slash-outline',
            isBuiltIn: false,
            backendTargetKey: null,
            enabled: null,
            descriptor: null,
            behavior: null,
            authPlugin: null,
            backendEntry: null,
        });

        const screen = await renderProviderSettingsScreen();
        const items = screen.findAllByType('Item' as any);
        expect(items.some((node: any) => node.props?.title === 'Acme Review Backend')).toBe(true);
        expect(items.some((node: any) => node.props?.title === 'settingsProviders.notFoundTitle')).toBe(false);
        const fallbackIdentityRow = items.find((node: any) => node.props?.title === 'Acme Review Backend');
        expect(fallbackIdentityRow?.props?.icon?.props?.name).toBe('sparkles-outline');
    });

    it('renders the not found screen without requiring pane context', async () => {
        mockProviderId = 'unknown';
        shouldThrowOnAppPaneScope = true;
        const screen = await renderProviderSettingsScreen();
        const textNodes = screen.findAllByType('Text' as any);
        expect(textNodes.some((node: any) => node.props?.children === 'settingsProviders.notFoundTitle')).toBe(true);
        expect(textNodes.some((node: any) => node.props?.children === 'settingsProviders.notFoundSubtitle')).toBe(true);
        expect(textNodes.some((node: any) => node.props?.children === 'Unknown')).toBe(false);
    });

    it('renders provider-specific extra sections from runtime behavior separately from settings descriptors', async () => {
        mockProviderId = 'opencode';
        mockProviderSettingsDescriptor.mockReturnValue({
            providerId: 'opencode',
            title: 'OpenCode',
            icon: { ionName: 'code-slash-outline', color: '#5AC8FA' },
            settings: {},
            uiSections: [],
        });
        mockProviderSettingsBehavior.mockReturnValue({
            providerId: 'opencode',
            ExtraSectionsComponent: passThrough('RuntimeSections').RuntimeSections,
        });

        const screen = await renderProviderSettingsScreen();
        expect(screen.findByType('RuntimeSections' as any)).toBeTruthy();
    });

    it('routes provider default-auth recovery rows to the service-specific settings route', async () => {
        const screen = await renderProviderSettingsScreen();

        screen
            .findByType('ConnectedServicesDefaultAuthRow' as any)
            .props.onOpenConnectedServicesSettings('anthropic');

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/[serviceId]',
            params: { serviceId: 'anthropic' },
        });
    });
});
const settingsState = {
    backendEnabledByTargetKey: {},
    sessionDefaultPermissionModeByTargetKey: {},
    backendCliSourcePreferenceByTargetKey: {},
    contextSelectionsV1: undefined as any,
    acpCatalogSettingsV1: { v: 2, backends: [] },
    opencodeServerBaseUrl: '',
    opencodeServerBaseUrlByServerIdV1: {} as Record<string, string>,
};
