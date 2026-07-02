import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MarketplaceSourceRegistryV1 } from '@happier-dev/protocol';
import {
    clearDaemonMergedProjectionCacheForTests,
    loadDaemonMergedProjectionCacheEntry,
} from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

type InstalledPluginDiagnostic = Readonly<{
    code: string;
    message: string;
}>;

type InstalledPluginEntry = Readonly<{
    pluginId: string;
    title: string;
    description: string | null;
    version: string;
    enabled: boolean;
    source: Readonly<{
        kind: string;
        locator: string;
        trustPolicy?: string;
        installPolicy?: string;
        resolvedPath?: string;
        resolvedDigest?: string | null;
    }>;
    install: Readonly<{
        mode: string;
        manifestVersion: string;
        manifestDigest?: string | null;
        installedPath?: string | null;
    }>;
    compatibility: Readonly<{
        status: string;
        diagnostics: readonly InstalledPluginDiagnostic[];
    }>;
    diagnostics: readonly InstalledPluginDiagnostic[];
}>;

type MachineCapabilitiesResponse = Readonly<{
    protocolVersion: 1;
    results: Readonly<Record<string, Readonly<{
        ok: true;
        checkedAt: number;
        data?: { installedPlugins?: readonly InstalledPluginEntry[] } | null;
    }>>>;
}>;

type MachineCapabilitiesState = Readonly<{
    status: 'loaded';
    snapshot: Readonly<{
        response: MachineCapabilitiesResponse;
    }>;
}>;

const usePrimaryMachineFromActiveSelectionMock = vi.hoisted(() => vi.fn());
const getActiveServerIdMock = vi.hoisted(() => vi.fn());
const useMachineCapabilitiesCacheMock = vi.hoisted(() => vi.fn());
const invokeWithAlertsMock = vi.hoisted(() => vi.fn());
const refreshMachineCapabilitiesMock = vi.hoisted(() => vi.fn());
const machineMarketplaceSourceRegistryGetMock = vi.hoisted(() => vi.fn());
const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const navigationSetOptionsSpy = vi.hoisted(() => vi.fn());

const MARKETPLACE_CAPABILITY_ID = 'tool.plugins';

function createInstalledPlugin(overrides: Partial<InstalledPluginEntry> & Pick<InstalledPluginEntry, 'pluginId' | 'title' | 'version'>): InstalledPluginEntry {
    return {
        description: 'Installed plugin',
        enabled: true,
        source: {
            kind: 'catalog',
            locator: 'https://marketplace.example.test/catalog.json',
            trustPolicy: 'trusted',
            installPolicy: 'allow',
            resolvedPath: '/plugins/sample',
            resolvedDigest: 'sha256:abc123',
        },
        install: {
            mode: 'catalog',
            manifestVersion: '1',
            manifestDigest: 'sha256:manifest',
            installedPath: '/plugins/sample',
        },
        compatibility: {
            status: 'compatible',
            diagnostics: [],
        },
        diagnostics: [],
        ...overrides,
    };
}

function createMachineCapabilitiesState(installedPlugins: readonly InstalledPluginEntry[]): MachineCapabilitiesState {
    return {
        status: 'loaded',
        snapshot: {
            response: {
                protocolVersion: 1,
                results: {
                    [MARKETPLACE_CAPABILITY_ID]: {
                        ok: true,
                        checkedAt: Date.now(),
                        data: {
                            installedPlugins,
                        },
                    },
                },
            },
        },
    };
}

function createMarketplaceCatalogEntry(params: Readonly<{
    pluginId: string;
    title?: string;
    description?: string;
    version?: string;
    entryId?: string;
    sourceUrl?: string;
    packageUrl?: string;
    categories?: readonly string[];
}>): Readonly<{
    id: string;
    manifestId: string;
    title: string;
    description: string;
    version: string;
    sourceUrl: string;
    packageUrl: string;
    categories: readonly string[];
}> {
    return {
        id: params.entryId ?? `marketplace.${params.pluginId}`,
        manifestId: params.pluginId,
        title: params.title ?? params.pluginId,
        description: params.description ?? 'Catalog descriptor',
        version: params.version ?? '1.0.0',
        sourceUrl: params.sourceUrl ?? `https://marketplace.example.test/entries/${params.pluginId}.json`,
        packageUrl: params.packageUrl ?? `https://marketplace.example.test/plugins/${params.pluginId}.tgz`,
        categories: params.categories ?? [],
    };
}

function flushAsync(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function createDeferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Text: 'Text',
            TextInput: 'TextInput',
            Platform: {
                OS: 'web',
                select: (options: any) => (options && 'default' in options ? options.default : undefined),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: (value) => routerPushSpy(value),
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
            navigation: {
                setOptions: (options: Readonly<Record<string, unknown>>) => navigationSetOptionsSpy(options),
            },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => true),
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useProfile: () => ({ id: 'prof_1', firstName: '', connectedServices: [] }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection', () => ({
    usePrimaryMachineFromActiveSelection: () => usePrimaryMachineFromActiveSelectionMock(),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => getActiveServerIdMock(),
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: (...args: unknown[]) => useMachineCapabilitiesCacheMock(...args),
}));

vi.mock('@/hooks/machine/useMachineCapabilityInvokeWithAlerts', () => ({
    useMachineCapabilityInvokeWithAlerts: () => ({
        isInvoking: false,
        invokeWithAlerts: invokeWithAlertsMock,
    }),
}));

vi.mock('@/sync/ops/machineMarketplaceSources', () => ({
    machineMarketplaceSourceRegistryGet: (...args: unknown[]) => machineMarketplaceSourceRegistryGetMock(...args),
    resolvePreferredMachineMarketplaceSource: (registry: MarketplaceSourceRegistryV1) =>
        registry.sources.find((entry) => entry.enabled && entry.origin === 'curated') ?? registry.sources.find((entry) => entry.enabled) ?? null,
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) => machineContributionRegistryProjectionDescribeMock(...args),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex'],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: (agentId: string) => ({
        displayNameKey: `agents.${agentId}.name`,
        uiConnectedService: { serviceId: null, label: agentId, connectRoute: null },
        ui: { agentPickerIconName: 'terminal-outline' },
    }),
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => null,
    isAgentId: (agentId: unknown) => agentId === 'claude' || agentId === 'codex',
    resolveAgentIdFromConnectedServiceId: () => null,
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => createPassThroughModule(['ItemRowActions']));

vi.mock('@/agents/catalog/providerSettingsCatalog', () => ({
    PROVIDER_SETTINGS_DESCRIPTORS: [],
    PROVIDER_SETTINGS_PLUGINS: [],
    PROVIDER_SETTINGS_BEHAVIORS: [],
    getProviderSettingsDescriptor: () => null,
    getProviderSettingsBehavior: () => null,
    getProviderSettingsPlugin: () => null,
}));

vi.mock('@happier-dev/agents', () => {
    const base = {
        AGENT_IDS: ['claude', 'codex'],
        AGENT_PROVIDER_IDS: ['claude', 'codex'],
        CANONICAL_AGENT_IDS: ['claude', 'codex'],
        DEFAULT_AGENT_ID: 'claude',
        getAgentCore: (agentId: string) => ({
            connectedServices: null,
            ui: { agentPickerIconName: 'terminal-outline' },
            displayNameKey: `agents.${agentId}.name`,
        }),
        getAgentLocalCliConfig: () => ({
            detectKey: 'codex',
            machineLoginKey: 'codex',
        }),
        getAllProviderDefinitions: () => [],
        getAllProviderSettingsDefinitions: () => [],
        getAgentCliRuntimeSpec: () => ({ binaryName: null }),
        getProviderCliInstallGuideUrl: () => null,
        isAgentId: (agentId: unknown) => agentId === 'claude' || agentId === 'codex',
        legacyCustomAcpCompat: {
            LEGACY_COMPAT_AGENT_IDS: ['customAcp'],
            getLegacyCustomAcpAgentLocalCliConfig: () => ({
                detectKey: 'customAcp',
                machineLoginKey: 'customAcp',
            }),
            getLegacyCustomAcpProviderSettingsDescriptor: () => null,
            getLegacyCustomAcpProviderSettingsBehavior: () => null,
        },
    } as Record<string, unknown>;

    return new Proxy(base, {
        get(target, prop) {
            if (typeof prop === 'string' && prop in target) {
                return target[prop];
            }
            if (typeof prop === 'string' && (prop.startsWith('get') || prop.startsWith('resolve') || prop.startsWith('build') || prop.startsWith('evaluate'))) {
                return () => null;
            }
            return undefined;
        },
        has() {
            return true;
        },
    });
});

afterEach(() => {
    clearDaemonMergedProjectionCacheForTests();
    usePrimaryMachineFromActiveSelectionMock.mockReset();
    getActiveServerIdMock.mockReset();
    useMachineCapabilitiesCacheMock.mockReset();
    invokeWithAlertsMock.mockReset();
    refreshMachineCapabilitiesMock.mockReset();
    machineMarketplaceSourceRegistryGetMock.mockReset();
    machineContributionRegistryProjectionDescribeMock.mockReset();
    routerPushSpy.mockReset();
    navigationSetOptionsSpy.mockReset();
    vi.unstubAllGlobals();
});

beforeEach(() => {
    clearDaemonMergedProjectionCacheForTests();
    usePrimaryMachineFromActiveSelectionMock.mockReturnValue('machine-1');
    getActiveServerIdMock.mockReturnValue('server-a');
    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
        supported: true,
        projection: { v: 1, providersById: {}, backendsById: {} },
    });
});

describe('PluginSettingsHomeScreen', () => {
    it('navigates installed plugin rows to a detail route instead of inlining plugin details on the home screen', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                uiDescriptorsById: {},
                diagnostics: [],
            },
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.installed.installed-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.status')).toBeFalsy();

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.installed.installed-plugin');
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/plugins/[pluginId]',
            params: { pluginId: 'installed-plugin' },
        });
    });

    it('renders host-projected plugin detail, descriptor fields, diagnostics, and reload action on the detail screen', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
            diagnostics: [{ code: 'install.note', message: 'Installed via host-owned flow' }],
        });
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh,
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {
                    'installed-plugin.refresh': {
                        id: 'installed-plugin.refresh',
                        pluginId: 'installed-plugin',
                        title: 'Refresh installed plugin',
                        description: 'Refresh plugin-owned resources',
                        scopes: ['settings'],
                        surfaces: ['settings'],
                        placement: 'detailsPanel',
                        dangerLevel: 'safe',
                        available: true,
                    },
                    'installed-plugin.runSetup': {
                        id: 'installed-plugin.runSetup',
                        pluginId: 'installed-plugin',
                        title: 'Run setup',
                        description: 'Run plugin setup',
                        scopes: ['settings'],
                        surfaces: ['settings'],
                        placement: 'detailsPanel',
                        dangerLevel: 'safe',
                        available: true,
                    },
                },
                toolsById: {},
                commandsById: {},
                resourcesById: {
                    'installed-plugin.prompt': {
                        id: 'installed-plugin.prompt',
                        pluginId: 'installed-plugin',
                        resourceKind: 'prompt',
                        path: 'resources/review.md',
                        digest: 'sha256:prompt',
                        contentType: 'text/markdown',
                    },
                },
                uiDescriptorsById: {
                    'installed-plugin.settings.b': {
                        id: 'installed-plugin.settings.b',
                        pluginId: 'installed-plugin',
                        surface: 'settings',
                        title: 'B section',
                        description: 'Second section by order',
                        order: 2,
                        tone: 'warning',
                        helpUrl: 'https://example.com/installed-plugin/help',
                        fields: [
                            {
                                id: 'reviewHooks',
                                type: 'boolean',
                                title: 'Review hooks',
                                description: 'Host-rendered toggle',
                                order: 2,
                                options: [],
                            },
                            {
                                id: 'mode',
                                type: 'select',
                                title: 'Mode',
                                order: 1,
                                options: [
                                    { value: 'safe', label: 'Safe' },
                                ],
                            },
                            {
                                id: 'secret',
                                type: 'secret',
                                title: 'API secret',
                                options: [],
                            },
                            {
                                id: 'runSetup',
                                type: 'action',
                                title: 'Run setup',
                                actionId: 'installed-plugin.runSetup',
                                options: [],
                            },
                        ],
                    },
                    'installed-plugin.settings.a': {
                        id: 'installed-plugin.settings.a',
                        pluginId: 'installed-plugin',
                        surface: 'settings',
                        title: 'A section',
                        description: 'First section by order',
                        order: 1,
                        fields: [
                            {
                                id: 'alpha',
                                type: 'text',
                                title: 'Alpha',
                                options: [],
                            },
                        ],
                    },
                    'installed-plugin.setup': {
                        id: 'installed-plugin.setup',
                        pluginId: 'installed-plugin',
                        surface: 'setup',
                        title: 'Setup',
                        description: 'First-run setup steps',
                        fields: [
                            {
                                id: 'connect',
                                type: 'action',
                                title: 'Connect account',
                                actionId: 'installed-plugin.refresh',
                                options: [],
                            },
                        ],
                    },
                    'installed-plugin.providerSettings': {
                        id: 'installed-plugin.providerSettings',
                        pluginId: 'installed-plugin',
                        surface: 'providerSettings',
                        title: 'Provider settings',
                        fields: [
                            {
                                id: 'providerSecret',
                                type: 'secret',
                                title: 'Provider secret',
                                options: [],
                            },
                        ],
                    },
                    'installed-plugin.agentSettings': {
                        id: 'installed-plugin.agentSettings',
                        pluginId: 'installed-plugin',
                        surface: 'agentSettings',
                        title: 'Agent settings',
                        fields: [
                            {
                                id: 'agentSecret',
                                type: 'secret',
                                title: 'Agent secret',
                                options: [],
                            },
                        ],
                    },
                    'installed-plugin.backendSettings': {
                        id: 'installed-plugin.backendSettings',
                        pluginId: 'installed-plugin',
                        surface: 'backendSettings',
                        title: 'Backend settings',
                        fields: [
                            {
                                id: 'maxParallel',
                                type: 'number',
                                title: 'Max parallel',
                                options: [],
                            },
                        ],
                    },
                    'installed-plugin.status': {
                        id: 'installed-plugin.status',
                        pluginId: 'installed-plugin',
                        surface: 'status',
                        title: 'Runtime',
                        order: 10,
                        tone: 'info',
                        fields: [
                            {
                                id: 'generation',
                                type: 'text',
                                title: 'Registry generation',
                                options: [],
                            },
                        ],
                    },
                },
                diagnostics: [
                    {
                        severity: 'warning',
                        code: 'registry.warning',
                        message: 'Registry rebuilt with warnings',
                    },
                    {
                        severity: 'info',
                        code: 'plugin.activated',
                        message: 'Plugin activated',
                        pluginId: 'installed-plugin',
                    },
                ],
            },
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { ok: true } },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, { pluginId: 'installed-plugin' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
        }));
        expect(navigationSetOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({
            headerTitle: 'Installed Plugin',
        }));
        expect(screen.findRow('settings.plugins.detail.installed-plugin.header')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.summary')).toBeTruthy();
        expect(screen.getTextContent()).toContain('trusted');
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.a.alpha')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.b.mode')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.b.reviewHooks')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.b.secret')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.b.runSetup')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.setup.installed-plugin.setup.connect')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.agentSettings.installed-plugin.agentSettings.agentSecret')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.providerSettings.installed-plugin.providerSettings.providerSecret')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.backendSettings.installed-plugin.backendSettings.maxParallel')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.status.installed-plugin.status.generation')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.contribution.action.installed-plugin.refresh')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.contribution.resource.installed-plugin.prompt')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.action.reload')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Plugin activated');
        expect(screen.getTextContent()).toContain('Registry rebuilt with warnings');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.unsupportedDescriptorField');
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.b.help')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.b.tone')).toBeTruthy();

        const settingsFieldRows = screen.listRows('settings.plugins.detail.installed-plugin.descriptor.settings.');
        const settingsRowTestIds = settingsFieldRows.map((row) => row.props?.testID).filter(Boolean);
        expect(settingsRowTestIds[0]).toBe('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.a.alpha');

        const sectionBFieldRows = screen.listRows('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.b.')
            .filter((row) => {
                const testID = row.props?.testID;
                return typeof testID === 'string' && !testID.endsWith('.help') && !testID.endsWith('.tone');
            });
        const sectionBTestIdsRaw = sectionBFieldRows.map((row) => row.props?.testID).filter(Boolean);
        const sectionBTestIds: string[] = [];
        const seen = new Set<string>();
        for (const id of sectionBTestIdsRaw) {
            if (typeof id !== 'string' || seen.has(id)) {
                continue;
            }
            seen.add(id);
            sectionBTestIds.push(id);
        }
        expect(sectionBTestIds[0]).toBe('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.b.mode');
        expect(sectionBTestIds[1]).toBe('settings.plugins.detail.installed-plugin.descriptor.settings.installed-plugin.settings.b.reviewHooks');

        await act(async () => {
            screen.pressRow('settings.plugins.detail.installed-plugin.action.reload');
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: expect.objectContaining({
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'reload',
                params: expect.objectContaining({ pluginId: 'installed-plugin' }),
            }),
        }));
        expect(refresh).toHaveBeenCalledWith({ bypassCache: true });
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(2);
    });

    it('keeps projected plugin details visible on the detail screen while installed inventory refreshes', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loading',
                snapshot: createMachineCapabilitiesState([installedPlugin]).snapshot,
            },
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                uiDescriptorsById: {},
                diagnostics: [],
            },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, { pluginId: 'installed-plugin' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.header')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.summary')).toBeTruthy();
    });

    it('reuses the shared daemon projection cache on the detail screen when the scoped projection is already warm', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([
                createInstalledPlugin({
                    pluginId: 'installed-plugin',
                    title: 'Installed Plugin',
                    version: '1.0.0',
                }),
            ]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 7,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                uiDescriptorsById: {},
                diagnostics: [],
            },
        });

        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-a',
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, { pluginId: 'installed-plugin' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.summary')).toBeTruthy();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);
    });

    it('clears machine-scoped projection and preferred catalog state when the selected machine changes', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        const curatedMarketplaceRegistry = {
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [
                {
                    id: 'marketplace:curated-default',
                    title: 'Happier curated marketplace',
                    sourceUrl: 'https://marketplace.example.test/catalog.json',
                    enabled: true,
                    origin: 'curated' as const,
                    description: 'Official curated source',
                    addedAtMs: 1,
                    updatedAtMs: 1,
                },
            ],
        };

        usePrimaryMachineFromActiveSelectionMock.mockReturnValue('machine-1');
        getActiveServerIdMock.mockReturnValue('server-a');
        useMachineCapabilitiesCacheMock.mockImplementation(({ machineId }: { machineId: string | null }) => ({
            state: createMachineCapabilitiesState(machineId === 'machine-1' ? [installedPlugin] : [installedPlugin]),
            refresh: vi.fn(),
        }));
        machineMarketplaceSourceRegistryGetMock.mockImplementation(async (machineId: string) => (
            machineId === 'machine-1' ? curatedMarketplaceRegistry : null
        ));
        machineContributionRegistryProjectionDescribeMock.mockImplementation(async (machineId: string) => (
            machineId === 'machine-1'
                ? {
                    supported: true,
                    projection: {
                        v: 2,
                        generation: 12,
                        installedPackagesById: {
                            'installed-plugin': {
                                id: 'installed-plugin',
                                displayName: 'Installed Plugin',
                                version: '1.0.0',
                                enabled: true,
                                source: {
                                    kind: 'path',
                                    locator: '/plugins/installed-plugin',
                                },
                                digest: 'sha256:manifest',
                            },
                        },
                        providersById: {},
                        backendsById: {},
                        actionsById: {},
                        toolsById: {},
                        commandsById: {},
                        resourcesById: {},
                        uiDescriptorsById: {},
                        diagnostics: [
                            {
                                severity: 'warning',
                                code: 'plugin_runtime_capability_missing',
                                message: 'Missing actions capability',
                            },
                        ],
                    },
                }
                : {
                    supported: false,
                }
        ));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const RerenderablePluginSettingsHomeScreen = PluginSettingsHomeScreen as unknown as React.ComponentType<{
            scopeToken: string;
        }>;
        const screen = await renderSettingsView(React.createElement(RerenderablePluginSettingsHomeScreen, {
            scopeToken: 'machine-1',
        }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        expect(input?.props.value).toBe('https://marketplace.example.test/catalog.json');
        expect(screen.findRow('settings.plugins.registryDiagnostic.plugin_runtime_capability_missing.0')).toBeTruthy();

        usePrimaryMachineFromActiveSelectionMock.mockReturnValue('machine-2');
        getActiveServerIdMock.mockReturnValue('server-b');

        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginSettingsHomeScreen, {
                scopeToken: 'machine-2',
            }));
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.registryDiagnostic.plugin_runtime_capability_missing.0')).toBeFalsy();
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.value).toBe('');
    });

    it('drops an in-flight projection response when the selected machine becomes unavailable', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh,
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);

        let resolveProjection!: (value: Readonly<{
            supported: true;
            projection: Readonly<{
                v: 2;
                generation: number;
                installedPackagesById: Readonly<Record<string, Readonly<{
                    id: string;
                    displayName: string;
                    version: string | null;
                    enabled: boolean | null;
                    source: Readonly<{
                        kind: string;
                        locator: string;
                    }>;
                    digest: string | null;
                }>>>;
                providersById: Record<string, never>;
                backendsById: Record<string, never>;
                actionsById: Record<string, never>;
                toolsById: Record<string, never>;
                commandsById: Record<string, never>;
                resourcesById: Record<string, never>;
                uiDescriptorsById: Record<string, never>;
                diagnostics: readonly [];
            }>;
        }>) => void;
        const projectionPromise = new Promise<Parameters<typeof resolveProjection>[0]>((resolve) => {
            resolveProjection = resolve;
        });
        machineContributionRegistryProjectionDescribeMock.mockImplementation(async (machineId: string) => {
            if (machineId === 'machine-1') {
                return await projectionPromise;
            }
            return { supported: false };
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const RerenderablePluginSettingsHomeScreen = PluginSettingsHomeScreen as unknown as React.ComponentType<{
            scopeToken: string;
        }>;
        const screen = await renderSettingsView(React.createElement(RerenderablePluginSettingsHomeScreen, {
            scopeToken: 'machine-1',
        }));

        await act(async () => {
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.generation')).toBeFalsy();

        usePrimaryMachineFromActiveSelectionMock.mockReturnValue(null);
        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginSettingsHomeScreen, {
                scopeToken: 'machine-none',
            }));
            await flushAsync();
        });

        resolveProjection({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                uiDescriptorsById: {},
                diagnostics: [],
            },
        });

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.generation')).toBeFalsy();
    });

    it('renders duplicate registry diagnostic codes with stable unique rows', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                uiDescriptorsById: {},
                diagnostics: [
                    {
                        severity: 'warning',
                        code: 'plugin_runtime_capability_missing',
                        message: 'Missing actions capability',
                    },
                    {
                        severity: 'warning',
                        code: 'plugin_runtime_capability_missing',
                        message: 'Missing resources capability',
                    },
                ],
            },
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.registryDiagnostic.plugin_runtime_capability_missing.0')).toBeTruthy();
        expect(screen.findRow('settings.plugins.registryDiagnostic.plugin_runtime_capability_missing.1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Missing actions capability');
        expect(screen.getTextContent()).toContain('Missing resources capability');
    });

    it('loads curated descriptors from a catalog URL and preserves the machine-installed inventory', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: false,
            source: {
                kind: 'catalog',
                locator: 'https://marketplace.example.test/catalog.json',
                trustPolicy: 'trusted',
                installPolicy: 'allow',
                resolvedPath: '/plugins/installed-plugin',
                resolvedDigest: 'sha256:installed',
            },
            compatibility: {
                status: 'incompatible',
                diagnostics: [{ code: 'compatibility', message: 'Requires a newer runtime' }],
            },
            diagnostics: [{ code: 'provenance', message: 'Installed via host-owned flow' }],
        });
        const curatedMarketplaceRegistry = {
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [
                {
                    id: 'marketplace:curated-default',
                    title: 'Happier curated marketplace',
                    sourceUrl: 'https://marketplace.example.test/catalog.json',
                    enabled: true,
                    origin: 'curated' as const,
                    description: 'Official curated source',
                    addedAtMs: 1,
                    updatedAtMs: 1,
                },
            ],
        };

        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh,
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(curatedMarketplaceRegistry);

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input)).toBe('https://marketplace.example.test/catalog.json');
            return {
                ok: true,
                json: async () => ({
                    t: 'happier_plugin_marketplace_catalog_v1',
                    schemaVersion: 1,
                    sourceUrl: 'https://marketplace.example.test/catalog.json',
                    title: 'Curated Marketplace',
                    description: 'Curated plugin descriptors',
                    entries: [
                        createMarketplaceCatalogEntry({
                            pluginId: 'installed-plugin',
                            title: 'Installed Plugin',
                            description: 'Descriptor for the installed plugin',
                            version: '1.1.0',
                        }),
                        createMarketplaceCatalogEntry({
                            pluginId: 'new-plugin',
                            title: 'New Plugin',
                            description: 'Descriptor for an uninstalled plugin',
                            version: '0.1.0',
                        }),
                    ],
                }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy);

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(useMachineCapabilitiesCacheMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            enabled: true,
            request: expect.objectContaining({
                requests: [{ id: MARKETPLACE_CAPABILITY_ID }],
            }),
        }));
        expect(machineMarketplaceSourceRegistryGetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
        }));

        const installedRow = screen.findRow('settings.plugins.marketplace.installed.installed-plugin');
        expect(installedRow).toBeTruthy();
        expect(screen.getTextContent()).toContain('common.disabled');
        expect(screen.getTextContent()).toContain('Installed via host-owned flow');
        expect(screen.getTextContent()).toContain('catalog: https://marketplace.example.test/catalog.json');
        expect(screen.getTextContent()).toContain('incompatible');

        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        expect(input?.props.value).toBe('https://marketplace.example.test/catalog.json');

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(screen.findGroup('Curated Marketplace')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.entry.installed-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.entry.new-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.action.update.installed-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.action.enable.installed-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.action.install.new-plugin')).toBeTruthy();
    });

    it('keeps the previous catalog visible while a refresh is loading', async () => {
        const firstCatalogUrl = 'https://marketplace.example.test/catalog-a.json';
        const secondCatalogUrl = 'https://marketplace.example.test/catalog-b.json';
        const secondCatalogGate = createDeferred();

        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === firstCatalogUrl) {
                return {
                    ok: true,
                    json: async () => ({
                        t: 'happier_plugin_marketplace_catalog_v1',
                        schemaVersion: 1,
                        sourceUrl: firstCatalogUrl,
                        title: 'Curated Marketplace',
                        description: 'First catalog',
                        entries: [
                            createMarketplaceCatalogEntry({
                                pluginId: 'sample-plugin',
                                title: 'Sample Plugin',
                                description: 'Descriptor for the first catalog',
                                version: '1.0.0',
                                sourceUrl: `${firstCatalogUrl}#sample-plugin`,
                                packageUrl: 'https://marketplace.example.test/plugins/sample-plugin.tgz',
                            }),
                        ],
                    }),
                } as Response;
            }

            if (url === secondCatalogUrl) {
                await secondCatalogGate.promise;
                return {
                    ok: true,
                    json: async () => ({
                        t: 'happier_plugin_marketplace_catalog_v1',
                        schemaVersion: 1,
                        sourceUrl: secondCatalogUrl,
                        title: 'Curated Marketplace Refreshed',
                        description: 'Second catalog',
                        entries: [
                            createMarketplaceCatalogEntry({
                                pluginId: 'replacement-plugin',
                                title: 'Replacement Plugin',
                                description: 'Descriptor for the refreshed catalog',
                                version: '2.0.0',
                                sourceUrl: `${secondCatalogUrl}#replacement-plugin`,
                                packageUrl: 'https://marketplace.example.test/plugins/replacement-plugin.tgz',
                            }),
                        ],
                    }),
                } as Response;
            }

            throw new Error(`Unexpected marketplace catalog URL: ${url}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText(firstCatalogUrl);
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        const sampleEntry = screen.findRow('settings.plugins.marketplace.entry.sample-plugin');
        expect(sampleEntry).toBeTruthy();

        await act(async () => {
            input?.props.onChangeText(secondCatalogUrl);
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.entry.sample-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.catalog.loading')).toBeTruthy();

        secondCatalogGate.resolve();
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(screen.findRow('settings.plugins.marketplace.entry.replacement-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.entry.sample-plugin')).toBeFalsy();
    });

    it('routes marketplace install actions through the host capability and refreshes installed inventory', async () => {
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh,
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { action: 'install', pluginId: 'new-plugin' } },
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://marketplace.example.test/catalog.json',
                title: 'Curated Marketplace',
                description: 'Curated plugin descriptors',
                entries: [
                    createMarketplaceCatalogEntry({
                        pluginId: 'new-plugin',
                        title: 'New Plugin',
                        description: 'Descriptor for an uninstalled plugin',
                        version: '0.1.0',
                    }),
                ],
            }),
        }) as Response));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText('https://marketplace.example.test/catalog.json');
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.action.install.new-plugin');
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledTimes(1);
        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: expect.objectContaining({
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'install',
                params: expect.objectContaining({
                    pluginId: 'new-plugin',
                    sourceUrl: 'https://marketplace.example.test/catalog.json',
                }),
            }),
        }));
        expect(refresh).toHaveBeenCalledWith({ bypassCache: true });
    });

    it('routes marketplace update, enable, and disable actions through the host capability', async () => {
        const enabledPlugin = createInstalledPlugin({
            pluginId: 'existing-plugin',
            title: 'Existing Plugin',
            version: '1.0.0',
            enabled: true,
            source: {
                kind: 'catalog',
                locator: 'https://marketplace.example.test/catalog.json',
                trustPolicy: 'trusted',
                installPolicy: 'allow',
                resolvedPath: '/plugins/existing-plugin',
                resolvedDigest: 'sha256:existing',
            },
            compatibility: {
                status: 'compatible',
                diagnostics: [],
            },
            diagnostics: [],
        });

        const disabledPlugin = createInstalledPlugin({
            pluginId: 'disabled-plugin',
            title: 'Disabled Plugin',
            version: '2.0.0',
            enabled: false,
            source: {
                kind: 'catalog',
                locator: 'https://marketplace.example.test/catalog.json',
                trustPolicy: 'trusted',
                installPolicy: 'allow',
                resolvedPath: '/plugins/disabled-plugin',
                resolvedDigest: 'sha256:disabled',
            },
            compatibility: {
                status: 'compatible',
                diagnostics: [],
            },
            diagnostics: [],
        });

        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([enabledPlugin, disabledPlugin]),
            refresh,
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { ok: true } },
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://marketplace.example.test/catalog.json',
                title: 'Curated Marketplace',
                description: 'Curated plugin descriptors',
                entries: [
                    createMarketplaceCatalogEntry({
                        pluginId: 'existing-plugin',
                        title: 'Existing Plugin',
                        description: 'Descriptor for an installed plugin with an update',
                        version: '1.1.0',
                    }),
                    createMarketplaceCatalogEntry({
                        pluginId: 'disabled-plugin',
                        title: 'Disabled Plugin',
                        description: 'Descriptor for an installed plugin that is disabled',
                        version: '2.0.0',
                    }),
                ],
            }),
        }) as Response));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText('https://marketplace.example.test/catalog.json');
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.action.update.existing-plugin');
            await flushAsync();
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.action.disable.existing-plugin');
            await flushAsync();
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.action.enable.disabled-plugin');
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            request: expect.objectContaining({
                method: 'update',
                params: expect.objectContaining({
                    pluginId: 'existing-plugin',
                    sourceUrl: 'https://marketplace.example.test/catalog.json',
                }),
            }),
        }));
        expect(invokeWithAlertsMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            request: expect.objectContaining({
                method: 'disable',
                params: expect.objectContaining({
                    pluginId: 'existing-plugin',
                }),
            }),
        }));
        expect(invokeWithAlertsMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            request: expect.objectContaining({
                method: 'enable',
                params: expect.objectContaining({
                    pluginId: 'disabled-plugin',
                }),
            }),
        }));
        expect(refresh).toHaveBeenCalledTimes(3);
        expect(refresh).toHaveBeenNthCalledWith(1, { bypassCache: true });
        expect(refresh).toHaveBeenNthCalledWith(2, { bypassCache: true });
        expect(refresh).toHaveBeenNthCalledWith(3, { bypassCache: true });
    });

    it('uses the installed plugin source as the update source even when another catalog is loaded', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'existing-plugin',
            title: 'Existing Plugin',
            version: '1.0.0',
            enabled: true,
            source: {
                kind: 'catalog',
                locator: 'https://catalog-a.example.test/catalog.json',
                trustPolicy: 'trusted',
                installPolicy: 'allow',
                resolvedPath: '/plugins/existing-plugin',
                resolvedDigest: 'sha256:existing',
            },
            compatibility: {
                status: 'compatible',
                diagnostics: [],
            },
            diagnostics: [],
        });

        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { ok: true } },
        });

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://catalog-b.example.test/catalog.json',
                title: 'Other Marketplace',
                description: 'Another catalog source',
                entries: [
                    createMarketplaceCatalogEntry({
                        pluginId: 'existing-plugin',
                        title: 'Existing Plugin',
                        description: 'Descriptor from a different catalog source',
                        version: '9.9.9',
                        sourceUrl: 'https://catalog-b.example.test/entries/existing-plugin.json',
                        packageUrl: 'https://catalog-b.example.test/plugins/existing-plugin.tgz',
                    }),
                ],
            }),
        }) as Response));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText('https://catalog-b.example.test/catalog.json');
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        const rowActions = screen.findAllByType('ItemRowActions' as any);
        const updateAction = rowActions
            .find((node) => node.props.title === 'Existing Plugin')
            ?.props.actions.find((action: { id: string }) => action.id === 'update');
        expect(updateAction).toBeTruthy();

        await act(async () => {
            updateAction?.onPress();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                method: 'update',
                params: expect.objectContaining({
                    pluginId: 'existing-plugin',
                    sourceUrl: 'https://catalog-a.example.test/catalog.json',
                }),
            }),
        }));
    });

    it('keeps unrelated plugin rows interactive while a plugin action is in flight', async () => {
        const deferred = createDeferred();
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([
                createInstalledPlugin({
                    pluginId: 'installed-plugin',
                    title: 'Installed Plugin',
                    version: '1.0.0',
                    enabled: true,
                }),
            ]),
            refresh,
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                uiDescriptorsById: {},
                diagnostics: [],
            },
        });
        invokeWithAlertsMock.mockImplementation(async () => {
            await deferred.promise;
            return {
                supported: true,
                response: { ok: true, result: { ok: true } },
            };
        });
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://marketplace.example.test/catalog.json',
                title: 'Curated Marketplace',
                description: 'Curated plugin descriptors',
                entries: [
                    createMarketplaceCatalogEntry({
                        pluginId: 'new-plugin',
                        title: 'New Plugin',
                        description: 'Descriptor for an uninstalled plugin',
                        version: '0.1.0',
                    }),
                ],
            }),
        }) as Response));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText('https://marketplace.example.test/catalog.json');
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        const rowActions = screen.findAllByType('ItemRowActions' as any);
        const reloadAction = rowActions
            .find((node) => node.props.title === 'Installed Plugin')
            ?.props.actions.find((action: { id: string }) => action.id === 'reload');
        expect(reloadAction).toBeTruthy();

        await act(async () => {
            reloadAction?.onPress();
            await flushAsync();
        });

        const reloadedReloadAction = screen.findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'Installed Plugin')
            ?.props.actions.find((action: { id: string }) => action.id === 'reload');
        expect(reloadedReloadAction?.disabled).toBe(true);
        expect(screen.findRow('settings.plugins.marketplace.action.install.new-plugin')?.props.disabled).not.toBe(true);

        deferred.resolve();
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(refresh).toHaveBeenCalledWith({ bypassCache: true });
    });
});
