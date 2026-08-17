import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey, type PluginProjectionV2 } from '@happier-dev/protocol';
import type { CliAuthStatusData } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
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
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockProviderId: string | null = 'codex';
let mockAgentPluginId: string | null = null;
let mockRecoveryMachineId: string | null = null;
let mockRecoveryServerId: string | null = null;
let mockInstallIntent: string | null = null;
let mockAgentModelOverride: Readonly<{
    defaultMode: string | null;
    allowedModes: readonly string[];
}> | null = null;
let mockAgentStaticModelsOverride: readonly Readonly<{ id: string; name: string }>[] | null = null;
let shouldThrowOnAppPaneScope = false;
const routerPushSpy = vi.fn();
const mockAgentCatalogProjection = vi.hoisted(
    () => vi.fn<(agentId: string, params?: Record<string, unknown>) => {
        agentId: string;
        catalogAgentId: string | null;
        iconAgentId: string | null;
        title: string;
        subtitle: string | null;
        iconName: string;
        isBuiltIn: boolean;
        backendTargetKey: string | null;
        enabled: boolean | null;
        authPlugin: any;
        backendEntry: any;
    } | null>(() => null),
);
const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() => vi.fn());
const machinePluginSessionHooksRpcMock = vi.hoisted(() => vi.fn());
const administrationTargetState = vi.hoisted(() => ({
    selectedTarget: {
        serverIdentityId: 'server1',
        machineId: 'm1',
    } as { serverIdentityId: string; machineId: string } | null,
    executionTarget: {
        target: {
            serverIdentityId: 'server1',
            machineId: 'm1',
        },
        serverId: 'server1',
        machine: {
            id: 'm1',
            metadata: { displayName: 'Machine One', host: 'm1', homeDir: '/Users/m1' },
            daemonStateVersion: 0,
        },
    } as {
        target: { serverIdentityId: string; machineId: string };
        serverId: string;
        machine: {
            id: string;
            metadata: { displayName: string; host: string; homeDir: string };
            daemonStateVersion: number;
        };
    } | null,
}));

const machineCapabilitiesInvokeMock = vi.fn(async () => ({
    supported: true,
    response: { ok: true, result: { plan: null } },
}));
const applySettingsMock = vi.fn();
const mutateAccountSettingsMock = vi.fn();
const tauriDesktopState = vi.hoisted(() => ({ value: true }));
const cliDetectionState = {
    available: { codex: false } as Record<string, boolean | null>,
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
let serverIdentityByProfileId: Record<string, string> = {
    server1: 'server1',
};
let activeServerSubscribers = new Set<(snapshot: ActiveServerSnapshot) => void>();
function emitActiveServerSnapshot(snapshot: ActiveServerSnapshot) {
    for (const subscriber of activeServerSubscribers) {
        subscriber(snapshot);
    }
}
const passThrough = (componentName: string) => createPassThroughModule([componentName]);

function buildExternalSessionsAgentProjection() {
    return {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        installedPackagesById: {
            'happier.agent.codex': {
                id: 'happier.agent.codex',
                displayName: 'Codex',
                enabled: true,
                source: { kind: 'bundled', locator: 'happier.agent.codex' },
            },
        },
        agentsById: {
            codex: {
                id: 'codex',
                title: 'Codex',
                externalSessions: {
                    agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    generation: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.generation,
                    operations: {
                        listCandidates: true,
                        resolveLinkIdentity: true,
                        pageTranscript: true,
                        readAfterTranscript: true,
                    },
                    sources: [{
                        sourceKind: 'codexHome',
                        schema: {
                            fields: [
                                { name: 'kind', kind: 'literal', value: 'codexHome' },
                                { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
                            ],
                        },
                        key: {
                            segments: [
                                { kind: 'literal', value: 'codexHome' },
                                { kind: 'homeMode', field: 'home' },
                            ],
                        },
                        instances: [{ kind: 'default', constants: { home: 'user' } }],
                    }],
                },
            },
        },
        backendsById: {},
        diagnostics: [],
    };
}

function buildBuiltInAgentSettingsProjection(): PluginProjectionV2 {
    return {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        installedPackagesById: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById,
            'happier.agent.codex': {
                id: 'happier.agent.codex',
                displayName: 'Codex',
                version: '1.0.0',
                enabled: true,
                source: { kind: 'bundled', locator: 'happier.agent.codex' },
            },
        },
        settingsById: {
            'happier.agent.codex.agent-settings': {
                id: 'agent-settings',
                pluginId: 'happier.agent.codex',
                version: 1,
                title: 'Codex settings',
                scope: { kind: 'account' },
                presentation: { sections: [], subagentSections: [] },
                target: {
                    kind: 'agent',
                    agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                },
                fields: [],
            },
        },
    };
}

function buildCollidingInstalledAgentProjection(): PluginProjectionV2 {
    return {
        v: 2,
        generation: 12,
        installedPackagesById: {
            'acme.voice': {
                id: 'acme.voice',
                displayName: 'Acme Voice',
                version: '1.0.0',
                enabled: true,
                source: { kind: 'path', locator: '/plugins/acme-voice' },
            },
            'other.voice': {
                id: 'other.voice',
                displayName: 'Other Voice',
                version: '1.0.0',
                enabled: true,
                source: { kind: 'path', locator: '/plugins/other-voice' },
            },
        },
        agentsById: {
            'acme.voice.claude': {
                id: 'acme.voice.claude',
                identity: { pluginId: 'acme.voice', localId: 'claude' },
                title: 'Acme Voice Claude',
                subtitle: 'Acme Voice Agent',
                channel: 'plugin',
                isBuiltIn: false,
                catalogAgentId: 'claude',
                iconAgentId: 'claude',
                providerOwnedEnvironmentKeys: [],
                cli: {
                    executable: { binaryName: 'acme-voice', sourcePreference: 'system-first' },
                    install: { manual: { kind: 'none' } },
                    auth: {
                        support: 'login_terminal',
                        probe: { parser: 'unknown', backgroundChecks: 'safe' },
                        loginLaunches: [{ kind: 'primary', args: ['login'] }],
                    },
                },
                externalSessions: {
                    agent: { pluginId: 'acme.voice', localId: 'claude' },
                    generation: 12,
                    operations: {
                        listCandidates: true,
                        resolveLinkIdentity: true,
                        pageTranscript: true,
                        readAfterTranscript: true,
                    },
                    sources: [{
                        sourceKind: 'claudeHome',
                        schema: {
                            fields: [
                                { name: 'kind', kind: 'literal', value: 'claudeHome' },
                                { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
                            ],
                        },
                        key: {
                            segments: [
                                { kind: 'literal', value: 'claudeHome' },
                                { kind: 'homeMode', field: 'home' },
                            ],
                        },
                        instances: [{ kind: 'default', constants: { home: 'user' } }],
                    }],
                },
            },
            'other.voice.claude': {
                id: 'other.voice.claude',
                identity: { pluginId: 'other.voice', localId: 'claude' },
                title: 'Other Voice Claude',
                subtitle: 'Other Voice Agent',
                channel: 'plugin',
                isBuiltIn: false,
                catalogAgentId: 'claude',
                iconAgentId: 'claude',
                providerOwnedEnvironmentKeys: [],
                cli: {
                    executable: { binaryName: 'other-voice', sourcePreference: 'system-first' },
                    install: { manual: { kind: 'none' } },
                    auth: {
                        support: 'login_terminal',
                        probe: { parser: 'unknown', backgroundChecks: 'safe' },
                        loginLaunches: [{ kind: 'primary', args: ['login'] }],
                    },
                },
            },
        },
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {},
        diagnostics: [],
    };
}

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
            useLocalSearchParams: () => ({
                agentId: mockProviderId,
                pluginId: mockAgentPluginId,
                machineId: mockRecoveryMachineId,
                serverId: mockRecoveryServerId,
                installIntent: mockInstallIntent,
            }),
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
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'serverSelectionGroups') return {};
                    if (key === 'serverSelectionActiveTargetKind') return 'server';
                    if (key === 'serverSelectionActiveTargetId') return 'server1';
                    return undefined;
                } }),
                useProfile: () => ({
                    id: 'profile-1',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServiceCredentialRevisionsV1: [],
                    connectedAccountsV4: [],
                    connectedAccountGroupsV4: [],
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

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: 'Icon',
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));

vi.mock('@/components/ui/lists/ItemList', () => passThrough('ItemList'));

vi.mock('@/components/ui/lists/ItemGroup', () => passThrough('ItemGroup'));

vi.mock('@/components/ui/lists/Item', () => passThrough('Item'));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: 'VirtualizedList',
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
        mutateAccountSettings: mutateAccountSettingsMock,
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    listServerProfiles: () => [{ id: 'server1', serverUrl: 'http://localhost:3000', webappUrl: 'http://localhost:8081', name: 'server1' }],
    getServerProfileById: (serverId: string) => {
        const serverIdentityId = serverIdentityByProfileId[serverId];
        return serverIdentityId
            ? { id: serverId, serverIdentityId }
            : null;
    },
    areServerProfileIdentifiersEquivalent: (left: string | null | undefined, right: string | null | undefined) => left === right,
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
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    // This screen does not exercise daemon-scoped plugin Settings I/O. Keep
    // the canonical Settings/secret/watch runtime boundary explicitly
    // unavailable instead of leaving a partial module mock with absent
    // exports.
    machinePluginSettingsGet: async () => ({ supported: false, reason: 'not-supported' }),
    machinePluginSettingsSet: async () => ({ supported: false, reason: 'not-supported' }),
    watchMachinePluginSettingsChanges: () => ({ dispose: () => {} }),
    machinePluginSecretStatus: async () => ({ supported: false, reason: 'not-supported' }),
    machinePluginSecretSet: async () => ({ supported: false, reason: 'not-supported' }),
    machinePluginSecretDelete: async () => ({ supported: false, reason: 'not-supported' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machinePluginSessionHooksRpcMock(...args),
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: (...args: any[]) => useCLIDetectionMock(...args),
}));

vi.mock('@/hooks/machine/useCapabilityInstallability', () => ({
    useCapabilityInstallability: (...args: any[]) => useCapabilityInstallabilityMock(...args),
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => {
        const [, rerender] = React.useState(0);
        return {
            selectedTarget: administrationTargetState.selectedTarget,
            resolveExecutionTarget: () => administrationTargetState.executionTarget,
            candidates: [
                { target: { serverIdentityId: 'server1', machineId: 'm1' } },
                { target: { serverIdentityId: 'server1', machineId: 'm2' } },
                { target: { serverIdentityId: 'server2', machineId: 'm3' } },
            ],
            selectTarget: (target: { serverIdentityId: string; machineId: string }) => {
                const machineNames: Record<string, string> = {
                    m1: 'Machine One',
                    m2: 'Machine Two',
                    m3: 'Machine Three',
                };
                const displayName = machineNames[target.machineId] ?? target.machineId;
                administrationTargetState.selectedTarget = target;
                administrationTargetState.executionTarget = {
                    target,
                    serverId: target.serverIdentityId,
                    machine: {
                        id: target.machineId,
                        metadata: {
                            displayName,
                            host: target.machineId,
                            homeDir: `/Users/${target.machineId}`,
                        },
                        daemonStateVersion: 0,
                    },
                };
                rerender((current) => current + 1);
            },
            clearTarget: () => {
                administrationTargetState.selectedTarget = null;
                administrationTargetState.executionTarget = null;
                rerender((current) => current + 1);
            },
        };
    },
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Record<string, unknown>) => (
        React.createElement('MachineAdministrationTargetSelector', props)
    ),
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
                uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.claude', connectRoute: null },
                localControl: { supported: false },
                ui: { agentPickerIconName: 'sparkles-outline' },
            };
        }

        if (agentId === 'antigravity') {
            return {
                id: agentId,
                displayNameKey: 'Antigravity',
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
                    detectKey: 'agy',
                    installBanner: { installKind: 'installer', installCommand: null, guideUrl: null },
                },
                connectedServices: undefined,
                uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.antigravity', connectRoute: null },
                localControl: { supported: false },
                ui: { agentPickerIconName: 'code-slash-outline' },
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
                labelKey: agentId === 'customAcp' ? 'agentInput.agent.customAcp' : 'agentInput.agent.codex',
                connectRoute: null,
            },
            localControl: { supported: false },
            ui: { agentPickerIconName: agentId === 'customAcp' ? 'git-network-outline' : 'code-slash-outline' },
        };
    };
    return {
        ...actual,
        AGENT_IDS: ['legacy.codex', 'legacy.customAcp', 'legacy.opencode'],
        isAgentId: (v: any) => v === 'codex' || v === 'customAcp' || v === 'opencode' || v === 'claude' || v === 'antigravity',
        getAgentCore: (agentId: string) => {
            const core = createMockAgentCore(agentId);
            return mockAgentModelOverride
                ? {
                    ...core,
                    model: {
                        ...core.model,
                        ...mockAgentModelOverride,
                    },
                }
                : core;
        },
    };
});

vi.mock('@/agents/backendCatalog/agentCatalogProjection', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/backendCatalog/agentCatalogProjection')>();
    return {
        ...actual,
        getResolvedAgentCatalogEntries: (params: Record<string, unknown>) => {
            const entries = actual.getResolvedAgentCatalogEntries(
                params as Parameters<typeof actual.getResolvedAgentCatalogEntries>[0],
            );
            const currentAgentId = typeof mockProviderId === 'string' ? mockProviderId.trim().toLowerCase() : '';
            if (!currentAgentId) {
                return entries;
            }
            const mockedProjection = mockAgentCatalogProjection(currentAgentId, params);
            if (!mockedProjection || entries.some((entry) => entry.agentId === mockedProjection.agentId)) {
                return entries;
            }
            return [...entries, mockedProjection];
        },
        resolveAgentCatalogProjection: (agentId: string, params?: Record<string, unknown>) =>
            mockAgentCatalogProjection(agentId, params) ?? actual.resolveAgentCatalogProjection(agentId, params as Parameters<typeof actual.resolveAgentCatalogProjection>[1]),
    };
});

vi.mock('@/agents/catalog/localAuth/agentLocalAuthCatalog', () => ({
    getAgentLocalAuthPlugin: () => ({
        agentId: 'codex',
        support: 'login_terminal',
        docsUrl: 'https://example.com/codex',
        buildLoginLaunch: () => ({ initialCommand: 'codex login' }),
    }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeLabelForAgentType: () => 'Ask',
    getPermissionModeOptionsForAgentType: () => [
        { value: 'default', label: 'Default', description: 'Use the global default', icon: 'list' },
        { value: 'ask', label: 'Ask', description: 'Ask each time', icon: 'question' },
    ],
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        getAgentStaticModels: (agentId: string) =>
            mockAgentStaticModelsOverride ?? actual.getAgentStaticModels(agentId),
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

vi.mock('@/components/settings/agents/AgentCliInstallItem', () => passThrough('AgentCliInstallItem'));

vi.mock('@/components/ui/layout/BadgeGrid', () => passThrough('BadgeGrid'));

vi.mock(
    '@/components/settings/agents/authentication/AgentAuthenticationTerminalPane',
    () => passThrough('AgentAuthenticationTerminalPane'),
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

vi.mock('@/components/settings/agents/authentication/useAgentAuthenticationState', () => ({
    useAgentAuthenticationState: (params: any) => {
        const agentId = params.agentId;
        const authStatus = cliDetectionState.authStatus?.[agentId] ?? null;
        return {
            canLaunchLogin: true,
            machineId: null,
            machineHomeDir: null,
            loginLaunch: agentId ? { initialCommand: `${agentId} login` } : null,
            authStatus,
            canCheckNow: true,
            loginActionKind: authStatus?.state === 'logged_in' ? 'reauthenticate' : 'login',
            docsUrl: null,
        };
    },
}));

async function renderPluginAgentSettingsScreen() {
    const Screen = (await import('@/app/(app)/settings/agents/[agentId]')).default;
    return renderScreen(React.createElement(Screen));
}

function setAdministrationExecutionTarget(machineId: string, serverId: string) {
    const displayName = ({
        m1: 'Machine One',
        m2: 'Machine Two',
        m3: 'Machine Three',
    } as Record<string, string>)[machineId] ?? machineId;
    administrationTargetState.selectedTarget = { serverIdentityId: serverId, machineId };
    administrationTargetState.executionTarget = {
        target: { serverIdentityId: serverId, machineId },
        serverId,
        machine: {
            id: machineId,
            metadata: { displayName, host: machineId, homeDir: `/Users/${machineId}` },
            daemonStateVersion: 0,
        },
    };
}

function buildCanonicalBackendTargetKey(backendId: string): string {
    return resolveBackendTargetKeyV2({ kind: 'backend', backendId });
}

function buildLegacyBuiltInTargetKey(agentId: 'antigravity' | 'claude' | 'codex' | 'customAcp' | 'opencode'): string {
    return buildBackendTargetKey({ kind: 'builtInAgent', agentId });
}

describe('PluginAgentSettingsScreen', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        clearDaemonMergedProjectionCacheForTests();
        mockProviderId = 'codex';
        mockAgentPluginId = null;
        mockRecoveryMachineId = null;
        mockRecoveryServerId = null;
        mockInstallIntent = null;
        mockAgentModelOverride = null;
        mockAgentStaticModelsOverride = null;
        setAdministrationExecutionTarget('m1', 'server1');
        shouldThrowOnAppPaneScope = false;
        tauriDesktopState.value = true;
        applySettingsMock.mockReset();
        mutateAccountSettingsMock.mockReset();
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
        settingsState.externalSessionsSettingsV1 = undefined;
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
        serverIdentityByProfileId = { server1: 'server1' };
        activeServerSubscribers = new Set();
        useCLIDetectionMock.mockReset();
        useCLIDetectionMock.mockImplementation(() => cliDetectionState);
        useCapabilityInstallabilityMock.mockReset();
        useCapabilityInstallabilityMock.mockReturnValue({ kind: 'installable' });
        routerPushSpy.mockReset();
        mockAgentCatalogProjection.mockReset();
        mockAgentCatalogProjection.mockImplementation((agentId: string, params?: Record<string, unknown>) => {
            const isBuiltIn = agentId === 'claude' || agentId === 'codex' || agentId === 'opencode' || agentId === 'customAcp' || agentId === 'antigravity';
            if (!isBuiltIn) {
                return null;
            }
            return {
                agentId,
                catalogAgentId: isBuiltIn ? agentId : null,
                iconAgentId: isBuiltIn ? agentId : null,
                title: agentId,
                subtitle: agentId,
                iconName: isBuiltIn ? 'code-slash-outline' : 'layers-outline',
                isBuiltIn,
                backendTargetKey: isBuiltIn ? buildCanonicalBackendTargetKey(agentId) : null,
                enabled: isBuiltIn ? true : null,
                authPlugin: agentId === 'codex'
                    ? {
                        agentId,
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
        machinePluginSessionHooksRpcMock.mockReset();
        machinePluginSessionHooksRpcMock.mockResolvedValue({
            ok: false,
            diagnostic: {
                code: 'installation_unsupported',
                retryable: false,
            },
        });
    });

    it('uses the canonical Administration exact target for projection, CLI detection, and install', async () => {
        setAdministrationExecutionTarget('m2', 'server-selected');
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        expect(screen.findByType('MachineAdministrationTargetSelector')).toBeTruthy();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m2', expect.objectContaining({
            serverId: 'server-selected',
        }));
        expect(useCLIDetectionMock).toHaveBeenLastCalledWith('m2', expect.objectContaining({
            serverId: 'server-selected',
        }));
        const installer = screen.findByType('AgentCliInstallItem');
        expect(installer.props).toMatchObject({
            machineId: 'm2',
            serverId: 'server-selected',
        });
    });

    it('keeps Account Settings identity independent from the Administration daemon target for a built-in Agent', async () => {
        activeServerSnapshot = {
            serverId: 'account-profile-a',
            serverUrl: 'http://account-a.example.test',
            generation: 1,
        };
        serverIdentityByProfileId = {
            'account-profile-a': 'account-identity-a',
        };
        setAdministrationExecutionTarget('m2', 'admin-identity-b');
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildBuiltInAgentSettingsProjection(),
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const { PluginDetailGenericSettingsSection } = await import(
            '@/components/settings/plugins/detail/PluginDetailGenericSettingsSection'
        );
        const settingsSection = screen.findByType(PluginDetailGenericSettingsSection);
        expect(settingsSection.props).toMatchObject({
            accountServerIdentityId: 'account-identity-a',
            daemonServerIdentityId: 'admin-identity-b',
            machineId: 'm2',
            serverId: 'admin-identity-b',
        });
    });

    it('uses daemon merged projection inputs when resolving a plugin provider settings screen', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderPluginAgentSettingsScreen();

        // Flush the projection RPC -> state -> re-render before checking the projection call-site.
        await act(async () => {});
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m1', expect.objectContaining({
            serverId: 'server1',
        }));
        expect(mockAgentCatalogProjection).toHaveBeenCalledWith(
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
                        catalogAgentId: 'claude',
                        iconAgentId: 'codex',
                    }),
                }),
            }),
        );

        machineContributionRegistryProjectionDescribeMock.mockClear();

        const targetSelector = screen.findByType('MachineAdministrationTargetSelector');
        await act(async () => {
            targetSelector.props.selection.selectTarget({
                serverIdentityId: 'server2',
                machineId: 'm3',
            });
        });
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m3', expect.objectContaining({
            serverId: 'server2',
        }));
    });

    it('opens Agent browse with the selected machine, server, and qualified Agent scope', async () => {
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildExternalSessionsAgentProjection(),
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const targetSelector = screen.findByType('MachineAdministrationTargetSelector' as any);
        await act(async () => {
            targetSelector.props.selection.selectTarget({
                serverIdentityId: 'server1',
                machineId: 'm2',
            });
        });
        await flushHookEffects();

        const browseItem = screen.findAllByType('Item' as any).find(
            (node: any) => node.props?.testID === 'settings-external-sessions-agent-browse',
        );
        expect(browseItem).toBeTruthy();

        await act(async () => {
            browseItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/external/browse',
            params: {
                machineId: 'm2',
                serverId: 'server1',
                agentId: 'codex',
                agentPluginId: 'happier.agent.codex',
                agentLocalId: 'codex',
            },
        });
    });

    it('opens the global External Sessions settings hub with the selected machine context', async () => {
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildExternalSessionsAgentProjection(),
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const targetSelector = screen.findByType('MachineAdministrationTargetSelector' as any);
        await act(async () => {
            targetSelector.props.selection.selectTarget({
                serverIdentityId: 'server1',
                machineId: 'm2',
            });
        });
        await flushHookEffects();

        const manageAllItem = screen.findAllByType('Item' as any).find(
            (node: any) => node.props?.testID === 'settings-external-sessions-manage-all',
        );
        expect(manageAllItem).toBeTruthy();

        await act(async () => {
            manageAllItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/settings/external-sessions',
            params: {
                machineId: 'm2',
            },
        });
    });

    it('shows an honest unavailable state when the selected daemon cannot project External Sessions for the Agent', async () => {
        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const status = screen.findByTestId(
            'settings-external-sessions-inventory-status',
        );
        expect(status?.props.title).toBe(
            'externalSessions.settingsIntegrationInventoryErrorTitle',
        );
        expect(status?.props.loading).toBe(false);
        expect(screen.findByTestId(
            'settings-external-sessions-agent-browse',
        )).toBeNull();
        expect(screen.findByTestId(
            'settings-external-sessions-manage-all',
        )).toBeTruthy();
        expect(machinePluginSessionHooksRpcMock).not.toHaveBeenCalled();
    });

    it('shows only persisted enabled auto-link policies for the selected machine and Agent and removes them offline', async () => {
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildExternalSessionsAgentProjection(),
        });
        const qualifiedIdentity = {
            v: 1 as const,
            agent: {
                pluginId: 'happier.agent.codex',
                localId: 'codex',
            },
            source: {
                kind: 'codexHome',
                contractVersion: 1,
            },
        };
        settingsState.externalSessionsSettingsV1 = {
            v: 1,
            keepPassivelyFollowingAfterRestart: false,
            autoLinkSourcePolicies: [
                {
                    machineId: 'm1',
                    qualifiedIdentity,
                    sourcePolicyId: `es-source-policy:v1:${'a'.repeat(64)}`,
                    enabledAtMs: 100,
                },
                {
                    machineId: 'm2',
                    qualifiedIdentity,
                    sourcePolicyId: `es-source-policy:v1:${'b'.repeat(64)}`,
                    enabledAtMs: 101,
                },
                {
                    machineId: 'm1',
                    qualifiedIdentity: {
                        ...qualifiedIdentity,
                        agent: {
                            pluginId: 'happier.agent.other',
                            localId: 'other',
                        },
                    },
                    sourcePolicyId: `es-source-policy:v1:${'c'.repeat(64)}`,
                    enabledAtMs: 102,
                },
            ],
        };

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const policyRows = screen.findAllByType('Item' as any).filter(
            (node: any) => node.props?.testID === 'settings-external-sessions-auto-link-source',
        );
        expect(policyRows).toHaveLength(1);

        const toggle = policyRows[0]!.props.rightElement;
        await act(async () => {
            toggle.props.onValueChange(false);
            await Promise.resolve();
        });

        expect(mutateAccountSettingsMock).toHaveBeenCalledTimes(1);
        const mutate = mutateAccountSettingsMock.mock.calls[0]![0];
        const next = mutate({
            externalSessionsSettingsV1: settingsState.externalSessionsSettingsV1,
        });
        expect(next.externalSessionsSettingsV1.autoLinkSourcePolicies).toEqual([
            expect.objectContaining({ sourcePolicyId: `es-source-policy:v1:${'b'.repeat(64)}` }),
            expect.objectContaining({ sourcePolicyId: `es-source-policy:v1:${'c'.repeat(64)}` }),
        ]);
    });

    it('renders the selected qualified Agent hook status through the shared machine controller', async () => {
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildExternalSessionsAgentProjection(),
        });
        machinePluginSessionHooksRpcMock.mockResolvedValue({
            ok: true,
            rows: [{
                agent: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
                status: {
                    state: 'installed_disabled',
                    installationId: 'installation-current',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        expect(screen.findByTestId(
            'settings-external-sessions-integration-m1\u0000happier.agent.codex\u0000codex\u0000installation:installation-current',
        )).toBeTruthy();
        expect(machinePluginSessionHooksRpcMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server1',
            method: 'daemon.plugins.sessionHooks.status.get',
            payload: {
                machineId: 'm1',
                intent: 'passive_inventory',
                agent: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
                limit: 50,
            },
        });
    });

    it('keeps a retired Agent durable hook installation visible and uninstallable on its canonical detail route', async () => {
        const projection = buildExternalSessionsAgentProjection();
        const {
            externalSessions: _retiredExternalSessions,
            ...retiredCodexAgent
        } = projection.agentsById.codex;
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                ...projection,
                installedPackagesById: {},
                agentsById: {
                    codex: retiredCodexAgent,
                },
                contributionIntrospection: {
                    version: 1,
                    generation: projection.generation,
                    contributions: [{
                        contribution: {
                            kind: 'localId',
                            pluginId: 'happier.agent.codex',
                            family: 'agents',
                            qualifiedId: 'happier.agent.codex/agents/codex',
                            localId: 'codex',
                        },
                        stability: 'stable',
                        progression: {
                            declared: true,
                            normalized: true,
                            merged: true,
                        },
                        registration: {
                            requirement: 'notRequired',
                            state: 'notRequired',
                        },
                        activation: {
                            state: 'notRequired',
                        },
                        projection: {
                            state: 'projected',
                        },
                        consumer: 'agent-catalog',
                        platforms: ['cli'],
                        diagnostics: [],
                    }],
                    diagnostics: [],
                },
            },
        });
        machinePluginSessionHooksRpcMock.mockResolvedValue({
            ok: true,
            rows: [
                {
                    agent: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    status: {
                        state: 'unavailable',
                        installationId: 'installation-retired',
                    },
                },
                {
                    agent: {
                        pluginId: 'happier.agent.other',
                        localId: 'codex',
                    },
                    status: {
                        state: 'unavailable',
                        installationId: 'installation-other',
                    },
                },
            ],
            nextCursor: null,
            diagnostics: [],
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        expect(screen.findByTestId(
            'settings-external-sessions-integration-m1\u0000happier.agent.codex\u0000codex\u0000installation:installation-retired',
        )).toBeTruthy();
        expect(screen.findByTestId(
            'settings-external-sessions-action-m1\u0000happier.agent.codex\u0000codex\u0000installation:installation-retired-uninstall',
        )).toBeTruthy();
        expect(screen.findByTestId(
            'settings-external-sessions-integration-m1\u0000happier.agent.other\u0000codex\u0000installation:installation-other',
        )).toBeNull();
        expect(machinePluginSessionHooksRpcMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server1',
            method: 'daemon.plugins.sessionHooks.status.get',
            payload: {
                machineId: 'm1',
                intent: 'passive_inventory',
                agent: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
                limit: 50,
            },
        });
    });

    it('keeps the projected provider detail visible while a new active-server projection loads', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const initialItems = screen.findAllByType('Item' as any);
        expect(initialItems.some((node: any) => node.props?.title === 'Acme Review Provider')).toBe(true);

        let resolveReload!: (value: {
            supported: true;
            projection: typeof PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE;
        }) => void;
        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => new Promise((resolve) => {
            resolveReload = resolve;
        }));

        const targetSelector = screen.findByType('MachineAdministrationTargetSelector' as any);
        await act(async () => {
            targetSelector.props.selection.selectTarget({
                serverIdentityId: 'server2',
                machineId: 'm3',
            });
        });
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m3', expect.objectContaining({
            serverId: 'server2',
        }));
        const loadingItems = screen.findAllByType('Item' as any);
        expect(loadingItems.some((node: any) => node.props?.title === 'Acme Review Provider')).toBe(true);
        expect(loadingItems.some((node: any) => node.props?.title === 'settingsAgents.notAvailable')).toBe(false);

        await act(async () => {
            resolveReload({
                supported: true,
                projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
            });
        });
    });

    it('refetches daemon projection inputs for the selected machine instead of pinning the first machine', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const targetSelector = screen.findByType('MachineAdministrationTargetSelector' as any);
        machineContributionRegistryProjectionDescribeMock.mockClear();

        await act(async () => {
            targetSelector.props.selection.selectTarget({
                serverIdentityId: 'server1',
                machineId: 'm2',
            });
        });
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m2', expect.objectContaining({
            serverId: 'server1',
        }));
    });

    it('renders the full provider settings/auth surface for a daemon-projected plugin provider backed by a built-in provider', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        expect(screen.findByTestId('settings-provider-auth-status')).toBeTruthy();
        expect(screen.findAllByType('AgentCliInstallItem' as any)).toHaveLength(1);
        const items = screen.findAllByType('Item' as any);
        expect(items.some((node: any) => node.props?.title === 'Acme Review Provider')).toBe(true);
        expect(items.some((node: any) => node.props?.title === 'settingsAgents.notAvailable')).toBe(false);
        expect(items.some((node: any) => node.props?.subtitle === 'settingsAgents.channelPlugin')).toBe(true);
        const projectedIdentityRow = items.find((node: any) => node.props?.title === 'Acme Review Provider');
        expect(projectedIdentityRow?.props?.icon?.props?.name).toBe('code-slash-outline');
    });

    it('renders the projected provider detail screen even when the provider has no built-in runtime carrier', async () => {
        mockProviderId = 'acme.headless.provider';
        mockAgentCatalogProjection.mockReturnValue({
            agentId: 'acme.headless.provider',
            catalogAgentId: null,
            iconAgentId: 'claude',
            title: 'Acme Headless Provider',
            subtitle: 'Plugin provider',
            iconName: 'stack-simple',
            isBuiltIn: false,
            backendTargetKey: null,
            enabled: null,
            authPlugin: null,
            backendEntry: null,
        });

        const screen = await renderPluginAgentSettingsScreen();
        const items = screen.findAllByType('Item' as any);
        expect(items.some((node: any) => node.props?.title === 'Acme Headless Provider')).toBe(true);
        expect(items.some((node: any) => node.props?.title === 'settingsAgents.notAvailable')).toBe(false);
        const projectedIdentityRow = items.find((node: any) => node.props?.title === 'Acme Headless Provider');
        expect(projectedIdentityRow?.props?.icon?.props?.name).toBe('sparkles-outline');
    });

    it('does not synthesize a built-in target key for plugin-backed provider controls when projection truth is missing', async () => {
        mockProviderId = 'acme.review.provider';
        mockAgentCatalogProjection.mockReturnValue({
            agentId: 'acme.review.provider',
            catalogAgentId: 'claude',
            iconAgentId: 'codex',
            title: 'Acme Review Provider',
            subtitle: 'Plugin provider',
            iconName: 'stack-simple',
            isBuiltIn: false,
            backendTargetKey: null,
            enabled: null,
            authPlugin: null,
            backendEntry: null,
        });

        const screen = await renderPluginAgentSettingsScreen();
        const enabledRow = screen.findAllByType('Item' as any).find((node: any) => node.props?.title === 'settingsAgents.enabledTitle');
        expect(enabledRow).toBeUndefined();
    });

    it('surfaces provider CLI install via capability installer item', async () => {
        const screen = await renderPluginAgentSettingsScreen();
        expect(mockAgentCatalogProjection).toHaveBeenCalledWith(
            'codex',
            expect.objectContaining({
                enabledAgentIds: [],
            }),
        );
        const installer = screen.findByType('AgentCliInstallItem' as any);
        expect(installer.props.machineId).toBe('m1');
        expect(installer.props.serverId).toBe('server1');
        expect(installer.props.capabilityId).toBe('cli.codex');
        expect(installer.props.installed).toBe(false);
        expect(installer.props.managedInstalled).toBe(false);
        expect(installer.props.installability).toMatchObject({ kind: 'installable' });
    });

    it('targets the exact selected machine for Voice runtime update and re-probes after success', async () => {
        mockRecoveryMachineId = 'm2';
        mockRecoveryServerId = 'server1';
        mockInstallIntent = 'update';

        const screen = await renderPluginAgentSettingsScreen();
        await flushHookEffects();

        const installer = screen.findByType('AgentCliInstallItem' as any);
        expect(installer.props).toMatchObject({
            machineId: 'm2',
            serverId: 'server1',
            capabilityId: 'cli.codex',
            intent: 'update',
        });

        act(() => installer.props.onManagedUpdateConfirmed());
        expect(applySettingsMock).toHaveBeenCalledWith({
            backendCliSourcePreferenceByTargetKey: {
                [buildCanonicalBackendTargetKey('codex')]: 'managed-first',
            },
        });

        act(() => installer.props.onInstalled());
        expect(cliDetectionState.refresh).toHaveBeenCalledWith({
            bypassCache: true,
            includeLoginStatusForAgentIds: ['codex'],
        });
    });

    it('uses the route plugin id to select the exact installed Agent display, installer, and operation', async () => {
        mockProviderId = 'claude';
        mockAgentPluginId = 'acme.voice';
        mockAgentCatalogProjection.mockReturnValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildCollidingInstalledAgentProjection(),
        });
        machinePluginSessionHooksRpcMock.mockResolvedValue({
            ok: true,
            rows: [
                {
                    agent: { pluginId: 'other.voice', localId: 'claude' },
                    status: { state: 'installed_disabled', installationId: 'other-installation' },
                },
                {
                    agent: { pluginId: 'acme.voice', localId: 'claude' },
                    status: { state: 'installed_disabled', installationId: 'acme-installation' },
                },
            ],
            nextCursor: null,
            diagnostics: [],
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const items = screen.findAllByType('Item' as any);
        expect(items.some((node: any) => node.props?.title === 'Acme Voice Claude')).toBe(true);
        expect(items.some((node: any) => node.props?.title === 'Other Voice Claude')).toBe(false);
        const installer = screen.findByType('AgentCliInstallItem' as any);
        expect(installer.props).toMatchObject({
            capabilityId: 'cli.acme.voice.claude',
            providerTitle: 'Acme Voice Claude',
        });
        expect(machinePluginSessionHooksRpcMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server1',
            method: 'daemon.plugins.sessionHooks.status.get',
            payload: {
                machineId: 'm1',
                intent: 'passive_inventory',
                agent: { pluginId: 'acme.voice', localId: 'claude' },
                limit: 50,
            },
        });
        expect(screen.findByTestId(
            'settings-external-sessions-integration-m1\u0000acme.voice\u0000claude\u0000installation:acme-installation',
        )).toBeTruthy();
        expect(screen.findByTestId(
            'settings-external-sessions-integration-m1\u0000other.voice\u0000claude\u0000installation:other-installation',
        )).toBeNull();
    });

    it('fails closed when the route plugin id does not match an installed Agent declaration', async () => {
        mockProviderId = 'claude';
        mockAgentPluginId = 'missing.voice';
        mockAgentCatalogProjection.mockReturnValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildCollidingInstalledAgentProjection(),
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const textNodes = screen.findAllByType('Text' as any);
        expect(textNodes.some((node: any) => node.props?.children === 'settingsAgents.notFoundTitle')).toBe(true);
        expect(screen.findAllByType('AgentCliInstallItem' as any)).toHaveLength(0);
        expect(machinePluginSessionHooksRpcMock).not.toHaveBeenCalled();
    });

    it('uses provider capability ids for provider settings when the binary detect key differs', async () => {
        mockProviderId = 'antigravity';
        cliDetectionState.available = { antigravity: false };
        cliDetectionState.login = { antigravity: null };
        cliDetectionState.authStatus = { antigravity: null };
        cliDetectionState.resolvedPath = { antigravity: null };
        cliDetectionState.resolutionSource = { antigravity: null };

        const screen = await renderPluginAgentSettingsScreen();

        expect(useCLIDetectionMock).toHaveBeenLastCalledWith('m1', expect.objectContaining({
            agentIds: ['antigravity'],
        }));
        expect(useCapabilityInstallabilityMock).toHaveBeenLastCalledWith(expect.objectContaining({
            capabilityId: 'cli.antigravity',
        }));
        const installer = screen.findByType('AgentCliInstallItem' as any);
        expect(installer.props.capabilityId).toBe('cli.antigravity');
    });

    it('keeps provider CLI install available on web while hiding desktop-only auth actions', async () => {
        tauriDesktopState.value = false;

        const screen = await renderPluginAgentSettingsScreen();

        expect(screen.findAllByType('AgentCliInstallItem' as any)).toHaveLength(1);
        expect(screen.findAllByType('AgentAuthenticationTerminalPane' as any)).toHaveLength(0);
        expect(screen.findByTestId('settings-provider-auth-status')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-auth-check-now')).toBeNull();
        expect(screen.findByTestId('settings-provider-auth-login')).toBeNull();
    });

    it('renders the canonical Administration target selector instead of a route-owned machine picker', async () => {
        const screen = await renderPluginAgentSettingsScreen();
        const targetSelector = screen.findByType('MachineAdministrationTargetSelector' as any);
        expect(targetSelector.props.selection.selectedTarget).toEqual({
            serverIdentityId: 'server1',
            machineId: 'm1',
        });
    });

    it('keeps the canonical target when active-server machine lists are incomplete', async () => {
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

        const screen = await renderPluginAgentSettingsScreen();
        const targetSelector = screen.findByType('MachineAdministrationTargetSelector' as any);
        expect(targetSelector.props.selection.selectedTarget).toEqual({
            serverIdentityId: 'server1',
            machineId: 'm1',
        });

        expect(useCLIDetectionMock).toHaveBeenLastCalledWith('m1', expect.objectContaining({
            serverId: 'server1',
        }));
        expect(useCapabilityInstallabilityMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'm1',
            serverId: 'server1',
        }));
    });

    it('uses the canonical target selection for CLI detection and installability', async () => {
        const screen = await renderPluginAgentSettingsScreen();
        const targetSelector = screen.findByType('MachineAdministrationTargetSelector' as any);
        await act(async () => {
            targetSelector.props.selection.selectTarget({
                serverIdentityId: 'server1',
                machineId: 'm2',
            });
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

        const screen = await renderPluginAgentSettingsScreen();
        const installer = screen.findByType('AgentCliInstallItem' as any);
        expect(installer.props.installed).toBe(true);
        expect(installer.props.managedInstalled).toBe(true);
    });

    it('does not retarget Agent operations when the active server changes', async () => {
        const screen = await renderPluginAgentSettingsScreen();

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

        const targetSelector = screen.findByType('MachineAdministrationTargetSelector' as any);
        expect(targetSelector.props.selection.selectedTarget).toEqual({
            serverIdentityId: 'server1',
            machineId: 'm1',
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

    });

    it('includes a permissions section to set the default permission mode for this backend', async () => {
        const screen = await renderPluginAgentSettingsScreen();
        const items = screen.findAllByType('Item' as any);
        const permissionItem = items.find((item: any) => item?.props?.title === 'settingsSession.permissions.defaultPermissionModeTitle');
        expect(permissionItem).toBeTruthy();
    });

    it('reflects compatibility-only provider enablement from the resolved projection and still writes the canonical backend key', async () => {
        const antigravityTargetKey = buildCanonicalBackendTargetKey('antigravity');
        settingsState.backendEnabledByTargetKey = {
            [buildCanonicalBackendTargetKey('antigravity-localharness')]: false,
        };
        mockProviderId = 'antigravity';
        mockAgentCatalogProjection.mockReturnValue({
            agentId: 'antigravity',
            catalogAgentId: 'antigravity',
            iconAgentId: 'antigravity',
            title: 'Antigravity',
            subtitle: 'antigravity',
            iconName: 'code',
            isBuiltIn: true,
            backendTargetKey: antigravityTargetKey,
            enabled: false,
            authPlugin: null,
            backendEntry: null,
        });

        const screen = await renderPluginAgentSettingsScreen();
        const enabledItem = screen.findAllByType('Item' as any).find((item: any) => item?.props?.title === 'settingsAgents.enabledTitle');

        expect(enabledItem?.props?.rightElement?.props?.value).toBe(false);

        await act(async () => {
            enabledItem?.props?.onPress();
        });
        await flushHookEffects();

        expect(applySettingsMock).toHaveBeenCalledWith({
            backendEnabledByTargetKey: {
                [buildCanonicalBackendTargetKey('antigravity-localharness')]: false,
                [antigravityTargetKey]: true,
            },
        });
    });

    it('reads legacy built-in permission preferences from compatibility target keys and still writes the canonical backend key', async () => {
        const codexLegacyTargetKey = buildLegacyBuiltInTargetKey('codex');
        const codexTargetKey = buildCanonicalBackendTargetKey('codex');
        settingsState.sessionDefaultPermissionModeByTargetKey = {
            [codexLegacyTargetKey]: 'ask',
        };

        const screen = await renderPluginAgentSettingsScreen();
        const permissionMenu = screen
            .findAllByType('DropdownMenu' as any)
            .find((node: any) => node.props?.itemTrigger?.title === 'settingsSession.permissions.defaultPermissionModeTitle');

        expect(permissionMenu?.props?.selectedId).toBe('ask');

        await act(async () => {
            permissionMenu?.props?.onSelect('default');
        });
        await flushHookEffects();

        expect(applySettingsMock).toHaveBeenCalledWith({
            sessionDefaultPermissionModeByTargetKey: {
                [codexLegacyTargetKey]: 'ask',
                [codexTargetKey]: 'default',
            },
        });
    });

    it('shows the provider default model as a friendly model name instead of a raw model id', async () => {
        mockProviderId = 'claude';

        const screen = await renderPluginAgentSettingsScreen();
        const items = screen.findAllByType('Item' as any);
        const defaultModelItem = items.find((item: any) => item?.props?.title === 'settingsAgents.defaultModelTitle');
        const acpApplyBehaviorItem = items.find((item: any) => item?.props?.title === 'settingsAgents.acpApplyBehaviorTitle');

        expect(defaultModelItem?.props?.subtitle).toBe('Sonnet 4.6');
        expect(acpApplyBehaviorItem?.props?.subtitle).toBe('settingsAgents.acpApplyBehaviorSetModel');
    });

    it('does not fabricate a static model catalog for an Agent with dynamic models only', async () => {
        mockAgentModelOverride = {
            defaultMode: null,
            allowedModes: [],
        };
        mockAgentStaticModelsOverride = [];

        const screen = await renderPluginAgentSettingsScreen();
        const items = screen.findAllByType('Item' as any);
        const defaultModelItem = items.find((item: any) => item?.props?.title === 'settingsAgents.defaultModelTitle');
        const catalogModelListItem = items.find((item: any) => item?.props?.title === 'settingsAgents.catalogModelListTitle');

        expect(defaultModelItem?.props?.subtitle).toBe('settingsAgents.notAvailable');
        expect(catalogModelListItem?.props?.subtitle).toBe('settingsAgents.catalogModelListEmpty');
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

        const screen = await renderPluginAgentSettingsScreen();
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

        const screen = await renderPluginAgentSettingsScreen();
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

        const screen = await renderPluginAgentSettingsScreen();
        const hostBefore = screen.findByType('AppPaneScopeHost' as any);
        expect(hostBefore.props.bottomPaneBuiltinAdapter.render()).toBeNull();
        expect(hostBefore.props.scopeId).toBe('settings:provider:codex');

        await screen.pressByTestIdAsync('settings-provider-auth-login');
        await flushHookEffects();

        expect(paneApi.openBottom).toHaveBeenCalledWith({ tabId: 'agent-auth-terminal' });

        await act(async () => {
            paneApi.scopeState = {
                bottom: {
                    isOpen: true,
                    activeTabId: 'agent-auth-terminal',
                },
            };
        });
        const rerenderedScreen = await renderPluginAgentSettingsScreen();

        const hostAfter = rerenderedScreen.findByType('AppPaneScopeHost' as any);
        const bottomPane = hostAfter.props.bottomPaneBuiltinAdapter.render();
        expect(bottomPane).toBeTruthy();
        expect(bottomPane.props.agentId).toBe('codex');
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
                activeTabId: 'agent-auth-terminal',
            },
        };

        const screen = await renderPluginAgentSettingsScreen();
        const host = screen.findByType('AppPaneScopeHost' as any);
        const bottomPane = host.props.bottomPaneBuiltinAdapter.render();
        expect(bottomPane).toBeTruthy();

        await act(async () => {
            bottomPane.props.onRequestClose();
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
                activeTabId: 'agent-auth-terminal',
            },
        };

        const screen = await renderPluginAgentSettingsScreen();
        const host = screen.findByType('AppPaneScopeHost' as any);
        const bottomPane = host.props.bottomPaneBuiltinAdapter.render();
        expect(bottomPane).toBeTruthy();

        await act(async () => {
            bottomPane.props.onTerminalExit();
        });
        await flushHookEffects();

        expect(paneApi.closeBottom).toHaveBeenCalledTimes(1);
        expect(cliDetectionState.refresh).toHaveBeenCalledWith({
            bypassCache: true,
            includeLoginStatusForAgentIds: ['codex'],
        });
    });

    it('renders and updates the backend CLI source preference when a managed install exists', async () => {
        const screen = await renderPluginAgentSettingsScreen();
        const sourceMenu = screen
            .findAllByType('DropdownMenu' as any)
            .find((node: any) => node.props?.itemTrigger?.title === 'settingsAgents.cliSourcePreference.title');
        expect(sourceMenu).toBeTruthy();
        expect(sourceMenu!.props.selectedId).toBe('system-first');

        await act(async () => {
            sourceMenu!.props.onSelect('managed-first');
        });
        await flushHookEffects();

        expect(applySettingsMock).toHaveBeenCalledWith({
            backendCliSourcePreferenceByTargetKey: {
                [buildCanonicalBackendTargetKey('codex')]: 'managed-first',
            },
        });
    });

    it('reads legacy built-in CLI source preferences from compatibility target keys and still writes the canonical backend key', async () => {
        const codexLegacyTargetKey = buildLegacyBuiltInTargetKey('codex');
        const codexTargetKey = buildCanonicalBackendTargetKey('codex');
        settingsState.backendCliSourcePreferenceByTargetKey = {
            [codexLegacyTargetKey]: 'managed-first',
        };

        const screen = await renderPluginAgentSettingsScreen();
        const sourceMenu = screen
            .findAllByType('DropdownMenu' as any)
            .find((node: any) => node.props?.itemTrigger?.title === 'settingsAgents.cliSourcePreference.title');

        expect(sourceMenu?.props?.selectedId).toBe('managed-first');

        await act(async () => {
            sourceMenu?.props?.onSelect('system-first');
        });
        await flushHookEffects();

        expect(applySettingsMock).toHaveBeenCalledWith({
            backendCliSourcePreferenceByTargetKey: {
                [codexLegacyTargetKey]: 'managed-first',
                [codexTargetKey]: 'system-first',
            },
        });
    });

    it('reflects the canonical configured runtime-kind surface in the badges', async () => {
        mockProviderId = 'codex';
        (settingsState as any).codexBackendMode = 'mcp';
        const screen = await renderPluginAgentSettingsScreen();
        const badgeGrid = screen.findByType('BadgeGrid' as any);
        const localControlItem = badgeGrid.props.items.find((item: any) => item.id === 'localControl');
        expect(localControlItem).toMatchObject({
            status: 'positive',
            detail: 'settingsAgents.supported',
        });

        delete (settingsState as any).codexBackendMode;
    });

    it('redirects the custom ACP provider route back to the providers index', async () => {
        mockProviderId = 'customAcp';
        const screen = await renderPluginAgentSettingsScreen();
        const redirect = screen.findByType('Redirect' as any);
        expect(redirect.props.href).toBe('/(app)/settings/agents');
    });

    it('redirects the legacy custom ACP provider route to the canonical projected provider when merged projection resolves one', async () => {
        mockProviderId = 'customAcp';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const redirect = screen.findByType('Redirect' as any);
        expect(redirect.props.href).toEqual({
            pathname: '/(app)/settings/agents/[agentId]',
            params: {
                agentId: 'acme.review.provider',
            },
        });
    });

    it('renders a projected fallback for non-built-in provider ids without requiring pane context', async () => {
        mockProviderId = 'acme.review.backend';
        shouldThrowOnAppPaneScope = true;
        mockAgentCatalogProjection.mockReturnValue({
            agentId: 'acme.review.backend',
            catalogAgentId: null,
            iconAgentId: 'claude',
            title: 'Acme Review Backend',
            subtitle: 'acme.review.backend',
            iconName: 'code',
            isBuiltIn: false,
            backendTargetKey: null,
            enabled: null,
            authPlugin: null,
            backendEntry: null,
        });

        const screen = await renderPluginAgentSettingsScreen();
        const items = screen.findAllByType('Item' as any);
        expect(items.some((node: any) => node.props?.title === 'Acme Review Backend')).toBe(true);
        expect(items.some((node: any) => node.props?.title === 'settingsAgents.notFoundTitle')).toBe(false);
        const fallbackIdentityRow = items.find((node: any) => node.props?.title === 'Acme Review Backend');
        expect(fallbackIdentityRow?.props?.icon?.props?.name).toBe('sparkles-outline');
    });

    it('uses projected native auth metadata to detect an external agent CLI', async () => {
        mockProviderId = 'acme.native';
        mockAgentCatalogProjection.mockReturnValue({
            agentId: 'acme.native',
            catalogAgentId: null,
            iconAgentId: null,
            title: 'Acme Native',
            subtitle: 'acme.native',
            iconName: 'terminal',
            isBuiltIn: false,
            backendTargetKey: null,
            enabled: true,
            authPlugin: {
                agentId: 'acme.native',
                support: 'login_terminal',
                buildLoginLaunch: () => ({ initialCommand: 'acme login' }),
            },
            backendEntry: null,
        });

        await renderPluginAgentSettingsScreen();

        expect(useCLIDetectionMock).toHaveBeenLastCalledWith('m1', expect.objectContaining({
            agentIds: ['acme.native'],
        }));
    });

    it('renders the not found screen without requiring pane context', async () => {
        mockProviderId = 'unknown';
        shouldThrowOnAppPaneScope = true;
        const screen = await renderPluginAgentSettingsScreen();
        const textNodes = screen.findAllByType('Text' as any);
        expect(textNodes.some((node: any) => node.props?.children === 'settingsAgents.notFoundTitle')).toBe(true);
        expect(textNodes.some((node: any) => node.props?.children === 'settingsAgents.notFoundSubtitle')).toBe(true);
        expect(textNodes.some((node: any) => node.props?.children === 'Unknown')).toBe(false);
    });

    it('routes provider default-auth recovery rows to the service-specific settings route', async () => {
        const screen = await renderPluginAgentSettingsScreen();

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
    externalSessionsSettingsV1: undefined as any,
};
