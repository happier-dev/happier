import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKey, type PluginProjectionV2 } from '@happier-dev/protocol';
import type { ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { activateStorageAccountScope } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { createExpoVectorIconsMock } from '@/dev/testkit/mocks/icons';
import { createMachineAdministrationTargetSelectionMock } from '@/dev/testkit/mocks/machineAdministrationTargetSelection';
import {
    flushHookEffects,
    createMachineFixture,
    renderHook,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks } from '../sessionSettingsEntryTestHelpers';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { applyConnectedAccountCatalogSnapshot, beginConnectedAccountCatalogLoad, resetConnectedAccountCatalogSnapshotsForTests } from '@/sync/store/settings/connectedAccountCatalogSnapshot';

const initialAgentSettingsStorage = storage.getState();
let activeStorageScope: Readonly<{ dispose(): void }> | null = null;
let purposes = createConnectedPurposeCatalogHttpBoundary();

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockProviderId: string | null = 'codex';
let mockAgentPluginId: string | null = null;
let mockRecoveryMachineId: string | null = null;
let mockRecoveryServerIdentityId: string | null = null;
let mockInstallIntent: string | null = null;
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
        qualifiedId?: string;
        identity?: Readonly<{ pluginId: string; localId: string }> | null;
        connectedAccounts?: readonly Readonly<{
            purpose: string;
            service: Readonly<{ pluginId: string; localId: string }>;
            required: boolean;
        }>[];
        authPlugin: any;
        cli?: any;
        backendEntry: any;
    } | null>(() => null),
);
const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() => vi.fn());
const machineProjectionRevisionState = vi.hoisted(() => ({
    revision: 0,
    listeners: new Set<() => void>(),
}));
const machinePluginSessionHooksRpcMock = vi.hoisted(() => vi.fn());
const administrationMachines = [
    { machineId: 'm1', displayName: 'Machine One', homeDir: '/Users/m1', daemonStateVersion: 0, serverIdentityId: 'server1', serverId: 'server1' },
    { machineId: 'm2', displayName: 'Machine Two', homeDir: '/Users/m2', daemonStateVersion: 0, serverIdentityId: 'server1', serverId: 'server1' },
    { machineId: 'm3', displayName: 'Machine Three', homeDir: '/Users/m3', daemonStateVersion: 0, serverIdentityId: 'server2', serverId: 'server2' },
];
const administrationSelection = createMachineAdministrationTargetSelectionMock({
    serverId: 'server1', serverIdentityId: 'server1', machines: administrationMachines,
});

const machineCapabilitiesInvokeMock = vi.hoisted(() => vi.fn(async () => ({
    supported: true,
    response: { ok: true, result: { plan: null } },
})));
const applySettingsMock = vi.hoisted(() => vi.fn());
const observedActionResults = vi.hoisted(() => [] as unknown[]);
const settingsWriteSpy = vi.fn();
const mutateAccountSettingsOnceMock = vi.hoisted(() => vi.fn());
const tauriDesktopState = vi.hoisted(() => ({ value: true }));
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
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                title: 'Codex',
                subtitle: 'Codex Agent',
                channel: 'stable',
                isBuiltIn: true,
                catalogAgentId: 'codex',
                iconAgentId: 'codex',
                providerOwnedEnvironmentKeys: [],
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
        diagnostics: [],
    };
}

function buildRunnablePluginProviderProjection(): PluginProjectionV2 {
    return {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        agentsById: {
            'acme.review.provider': {
                ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById['acme.review.provider'],
                capabilities: {
                    surfaces: ['terminal'],
                    sessions: {
                        open: ['create', 'resume'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
                cli: {
                    executable: {
                        binaryName: 'acme-review',
                        sourcePreference: 'managed-first',
                    },
                    install: {
                        managed: {
                            kind: 'managed_package',
                            packageName: '@acme/review',
                            binaryName: 'acme-review',
                        },
                        manual: { kind: 'none' },
                        docsUrl: 'https://example.com/acme-review',
                    },
                    auth: {
                        support: 'login_terminal',
                        loginLaunches: [{ kind: 'primary', args: ['login'] }],
                    },
                },
            },
        },
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
        agentsById: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById,
            codex: {
                id: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                title: 'Codex',
                subtitle: 'Codex',
                channel: 'stable',
                isBuiltIn: true,
                catalogAgentId: 'codex',
                iconAgentId: 'codex',
                providerOwnedEnvironmentKeys: [],
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

function buildPluginProviderProjectionWithCli(): PluginProjectionV2 {
    return {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        agentsById: {
            'acme.review.provider': {
                ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById['acme.review.provider'],
                cli: {
                    executable: {
                        binaryName: 'acme-review',
                        sourcePreference: 'system-first',
                    },
                    install: {
                        manual: { kind: 'none' },
                    },
                    auth: {
                        support: 'login_terminal',
                        loginLaunches: [{ kind: 'primary', args: ['login'] }],
                    },
                },
            },
        },
    };
}

/**
 * An installed Agent with no bundled runtime carrier and no CLI auth plugin that
 * still contributes editable Agent-targeted settings. This is the shape the
 * Agent settings route resolves to its fallback presentation, so it is the exact
 * case that proves the contributed settings are still reachable there.
 */
function buildHeadlessAgentSettingsProjection(): PluginProjectionV2 {
    return {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        installedPackagesById: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById,
            'acme.headless': {
                id: 'acme.headless',
                displayName: 'Acme Headless',
                version: '1.0.0',
                enabled: true,
                source: { kind: 'path', locator: '/plugins/acme-headless' },
            },
        },
        settingsById: {
            'acme.headless.agent-settings': {
                id: 'agent-settings',
                pluginId: 'acme.headless',
                version: 1,
                title: 'Acme Headless settings',
                scope: { kind: 'account' },
                presentation: { sections: [], subagentSections: [] },
                // The exact qualified identity the daemon projects for this
                // Agent. A local id is a contributor-local token, never the
                // host routing id, so the settings target must name `provider`
                // rather than the `acme.headless.provider` routing key.
                target: {
                    kind: 'agent',
                    agent: { pluginId: 'acme.headless', localId: 'provider' },
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
                        loginLaunches: [{ kind: 'primary', args: ['login'] }],
                    },
                },
            },
        },
        actionsById: {},


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
                serverIdentityId: mockRecoveryServerIdentityId,
                installIntent: mockInstallIntent,
            }),
            Redirect: (props: any) => React.createElement('Redirect', props),
        };
    },
    textModule: () => createTextModuleMock({ translate: (key) => key }),
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

vi.mock('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser', () => ({
    ConnectedAccountPurposeTargetChooser: (props: any) => React.createElement('ConnectedAccountPurposeTargetChooser', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => tauriDesktopState.value,
    desktopHostKind: () => tauriDesktopState.value ? 'tauri' : null,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: applySettingsMock,
        mutateAccountSettingsOnce: mutateAccountSettingsOnceMock,
        // No admitted Account transport exists in this fixture: Action Account context capture
        // observes an absent binding instead of throwing.
        getAccountEncryptionObservationBinding: () => undefined,
    },
}));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    const create = createFrontDoorActionExecuteForVitest(original);
    return { ...original, createFrontDoorActionExecute: (...args: Parameters<typeof create>) => {
        const execute = create(...args);
        return Object.assign(async (...input: Parameters<typeof execute>) => {
            try {
                const result = await execute(...input);
                observedActionResults.push(result);
                return result;
            } catch (error) {
                observedActionResults.push(error instanceof Error ? error.stack : String(error));
                throw error;
            }
        }, { prepare: execute.prepare });
    } };
});

vi.mock('@/sync/store/settingsWriters', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/store/settingsWriters')>(),
    useApplySettings: () => applySettingsMock,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createPartialServerProfilesModuleMock(importOriginal, {
        profiles: [{ id: 'server1', serverIdentityId: 'server1', serverUrl: 'http://localhost:3000', name: 'server1' }],
        overrides: {
    getServerProfilesGeneration: () => 0,
    subscribeServerProfiles: () => () => undefined,
    getActiveServerSnapshot: () => activeServerSnapshot,
    loadHomeViewState: () => null,
    getServerProfileById: (serverId: string) => {
        const serverIdentityId = serverIdentityByProfileId[serverId] ?? serverId;
        return {
            id: serverId,
            name: serverId,
            serverUrl: `https://${serverIdentityId}.example.test`,
            serverIdentityId,
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
        };
    },
    resolveServerProfileScopeIdForIdentifier: (serverId: string | null | undefined) => (
        serverId ? serverIdentityByProfileId[serverId] ?? serverId : ''
    ),
    // Mirrors the real owner: two identifiers are the same profile when one is the
    // other or both resolve to the same profile — including a device-local profile
    // id whose canonical identity is the other side.
    areServerProfileIdentifiersEquivalent: (left: string | null | undefined, right: string | null | undefined) => (
        left === right
        || serverIdentityByProfileId[String(left ?? '')] === right
        || serverIdentityByProfileId[String(right ?? '')] === left
    ),
    } });
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    subscribeActiveServer: (listener: (snapshot: ActiveServerSnapshot) => void) => {
        activeServerSubscribers.add(listener);
        return () => {
            activeServerSubscribers.delete(listener);
        };
    },
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async (_serverUrl, options) => {
                const accountId = `account:${options?.serverId ?? 'unknown'}`;
                const payload = Buffer.from(JSON.stringify({ sub: accountId })).toString('base64');
                return { token: `header.${payload}.signature` };
            },
        },
    });
});

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    getEffectiveServerSelectionFromRawSettings: () => ({ serverIds: ['server1'] }),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) => machineContributionRegistryProjectionDescribeMock(...args),
    getMachineContributionRegistryProjectionRevision: () => machineProjectionRevisionState.revision,
    subscribeMachineContributionRegistryProjectionInvalidation: (_scope: unknown, listener: () => void) => {
        machineProjectionRevisionState.listeners.add(listener);
        return () => machineProjectionRevisionState.listeners.delete(listener);
    },
    publishMachineContributionRegistryProjectionInvalidation: () => {
        machineProjectionRevisionState.revision += 1;
        for (const listener of machineProjectionRevisionState.listeners) listener();
    },
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


vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetPickerRows: () => administrationSelection.module.useMachineAdministrationTargetPickerRows(),
    resolveFreshMachineAdministrationExecutionTarget: (target: Parameters<typeof administrationSelection.module.resolveFreshMachineAdministrationExecutionTarget>[0]) =>
        administrationSelection.module.resolveFreshMachineAdministrationExecutionTarget(target),
    useMachineAdministrationTargetSelection: (key: string, options?: { initialTarget?: { serverIdentityId: string; machineId: string } | null }) => {
        const selection = administrationSelection.module.useMachineAdministrationTargetSelection(key, options);
        return {
            ...selection,
            selectedTargetServerMatchesActiveAccount: selection.selectedTarget?.serverIdentityId
                === (serverIdentityByProfileId[activeServerSnapshot.serverId] ?? activeServerSnapshot.serverId),
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
        isBundledAgentId: (v: any) => v === 'codex' || v === 'customAcp' || v === 'opencode' || v === 'claude' || v === 'antigravity',
        getAgentCore: (agentId: string) => createMockAgentCore(agentId),
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
        { value: 'read-only', label: 'Read only', description: 'Inspect without edits', icon: 'eye' },
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


vi.mock('@/components/ui/layout/BadgeGrid', () => passThrough('BadgeGrid'));

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


async function renderPluginAgentSettingsScreen() {
    storage.setState({
        settings: settingsParse({ ...settingsDefaults, ...settingsState }),
        localSettings: localSettingsParse({ bottomPaneHeightPx: 320, bottomPaneHeightBasisPx: 900,
            contextSelectionsV1: settingsState.contextSelectionsV1,
            serverSelectionGroups: {}, serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'server1' }),
        profile: { ...profileDefaults, id: 'account:server1', connectedServicesV2: [{
            serviceId: 'anthropic', profiles: [{ profileId: 'work', status: 'needs_reauth', providerEmail: null,
                providerAccountId: null, kind: 'token', expiresAt: null, lastUsedAt: null, health: null }], groups: [],
        }] },
    });
    for (const [serverId, rows] of Object.entries(machineListByServerIdState)) {
        const machines = rows.flatMap(row => {
            const source = machinesState.find(machine => machine.id === row.id);
            return source ? [createMachineFixture({ id: source.id, activeAt: Date.now(),
                metadata: { ...createMachineFixture().metadata!, ...source.metadata } })] : [];
        });
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId, sourceAccountId: `account:${serverId}` });
        if (Object.entries(machineListStatusByServerIdState).find(([id]) => id === serverId)?.[1].status === 'ready') {
            storage.getState().markMachineListSettled(serverId);
        }
    }
    purposes = createConnectedPurposeCatalogHttpBoundary({
        initialValue: settingsState.connectedAccountPurposeBindingsV1,
        settingsRequest: async (input, init) => {
            const body = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init?.body)));
            if (body.content?.t !== 'plain') throw new Error('Expected Plain Account Settings');
            settingsWriteSpy(body.content.v);
            return Response.json({ success: true, version: 8 });
        },
    });
    applyConnectedAccountCatalogSnapshot({ serverId: 'server1', accountId: 'account:server1' }, 'purposes', {
        status: 'ready', revision: 1, record: { key: 'purposes', value: purposes.value },
    }, true);
    const Screen = (await import('@/app/(app)/settings/agents/[agentId]')).default;
    return renderScreen(React.createElement(Screen));
}

type RenderedAgentScreen = Awaited<ReturnType<typeof renderPluginAgentSettingsScreen>>;

/** The page-header enabled switch of an agent detail. */
function findEnabledSwitch(screen: RenderedAgentScreen) {
    return screen.findAll((node: any) => node.type === 'Switch' && node.props?.testID === 'settings.agents.detail.enabled')[0];
}

/** The agent detail's page header (identity: title, description and identity mark). */
function findAgentHeader(screen: RenderedAgentScreen) {
    return screen.findAll((node: any) => typeof node.type !== 'string'
        && node.props?.testID === 'settings.agents.detail.header'
        && typeof node.props?.title === 'string')[0];
}

function readAgentHeaderIconAgentId(screen: RenderedAgentScreen): unknown {
    return findAgentHeader(screen)?.findAll((node: any) => node.props?.entry !== undefined)[0]?.props.entry.iconAgentId;
}

/**
 * A control a row or section carries as its accessory (`rightElement`, `action`). The list
 * primitives are pass-through mocks here, so those elements are read from the owner's props.
 */
function findAccessoryByTestId(screen: RenderedAgentScreen, testID: string): React.ReactElement<any> | null {
    for (const node of screen.findAll((candidate: any) => Boolean(candidate.props?.rightElement || candidate.props?.action))) {
        for (const element of [node.props.rightElement, node.props.action]) {
            if (React.isValidElement(element) && (element.props as { testID?: string }).testID === testID) return element;
        }
    }
    return null;
}

/** A segmented choice row (two to four visible options) by its title. */
function findSegmentedChoice(screen: RenderedAgentScreen, title: string) {
    return screen.findAll((node: any) => (
        typeof node.type !== 'string'
        && node.props?.title === title
        && Array.isArray(node.props?.options)
        && typeof node.props?.onChange === 'function'
    ))[0];
}

function setAdministrationExecutionTarget(machineId: string, serverId: string) {
    const machine = administrationMachines.find(row => row.machineId === machineId);
    administrationSelection.controller.setMachines([
        ...administrationMachines,
        ...(!administrationMachines.some(row => row.machineId === machineId && row.serverIdentityId === serverId)
            ? [{ machineId, displayName: machine?.displayName ?? machineId, homeDir: '/Users/' + machineId,
                daemonStateVersion: 0, serverIdentityId: serverId, serverId }]
            : []),
    ]);
    administrationSelection.controller.select(machineId, serverId);
}

function selectAdministrationTarget(target: Readonly<{ machineId: string; serverIdentityId: string }>) {
    administrationSelection.controller.select(target.machineId, target.serverIdentityId);
}

function buildCanonicalBackendTargetKey(backendId: string): string {
    return resolveBackendTargetKeyV2({ kind: 'backend', backendId });
}

function buildLegacyBuiltInTargetKey(agentId: 'antigravity' | 'claude' | 'codex' | 'customAcp' | 'opencode'): string {
    return buildBackendTargetKey({ kind: 'builtInAgent', agentId });
}

describe('PluginAgentSettingsScreen', () => {
    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
        standardCleanup();
        activeStorageScope?.dispose();
        activeStorageScope = null;
        storage.setState(initialAgentSettingsStorage, true);
    });

    beforeEach(async () => {
        resetConnectedAccountCatalogEngineForTests();
        resetConnectedAccountCatalogSnapshotsForTests();
        const scope = { serverId: 'server1', accountId: 'account:server1' };
        activeStorageScope = await activateStorageAccountScope(scope);
        storage.setState({ settingsVersion: 7, settingsScope: scope });
        settingsWriteSpy.mockReset();
        observedActionResults.length = 0;
        const request: RuntimeFetch = async (input, init) => {
            const purposeResponse = await purposes.handle(input, init);
            if (purposeResponse) return purposeResponse;
            const path = new URL(String(input)).pathname;
            if (path === '/health') return new Response(null, { status: 200 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                const body = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                if (body.content?.t !== 'plain') throw new Error('Expected a Plain Account Settings write');
                settingsWriteSpy(body.content.v);
                return Response.json({ success: true, version: 8 });
            }
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settingsState }, version: 7 });
            return Response.json({}, { status: 404 });
        };
        purposes = createConnectedPurposeCatalogHttpBoundary({ settingsRequest: request });
        setRuntimeFetch(request);
        clearDaemonMergedProjectionCacheForTests();
        mockProviderId = 'codex';
        mockAgentPluginId = null;
        mockRecoveryMachineId = null;
        mockRecoveryServerIdentityId = null;
        mockInstallIntent = null;
        administrationSelection.controller.reset();
        setAdministrationExecutionTarget('m1', 'server1');
        shouldThrowOnAppPaneScope = false;
        tauriDesktopState.value = true;
        applySettingsMock.mockReset();
        mutateAccountSettingsOnceMock.mockReset();
        mutateAccountSettingsOnceMock.mockImplementation(async (input: Readonly<{
            mutate: (settings: Record<string, unknown>) => Readonly<{
                settings: Record<string, unknown>;
                value: unknown;
            }>;
        }>) => {
            const result = input.mutate({
                externalSessionsSettingsV1: settingsState.externalSessionsSettingsV1,
            });
            return {
                status: 'applied',
                settingsVersion: 8,
                value: result.value,
            };
        });
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
        settingsState.connectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
        settingsState.connectedServicesDefaultAuthByAgentIdV1 = undefined;
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
        routerPushSpy.mockReset();
        mockAgentCatalogProjection.mockReset();
        mockAgentCatalogProjection.mockImplementation((agentId: string, params?: Record<string, unknown>) => {
            const isBuiltIn = agentId === 'claude' || agentId === 'codex' || agentId === 'opencode' || agentId === 'customAcp' || agentId === 'antigravity';
            if (!isBuiltIn) {
                return null;
            }
            return {
                agentId,
                qualifiedId: agentId,
                catalogAgentId: isBuiltIn ? agentId : null,
                iconAgentId: isBuiltIn ? agentId : null,
                title: agentId,
                subtitle: agentId,
                iconName: isBuiltIn ? 'code-slash-outline' : 'layers-outline',
                isBuiltIn,
                backendTargetKey: isBuiltIn ? buildCanonicalBackendTargetKey(agentId) : null,
                enabled: isBuiltIn ? true : null,
                identity: (
                    params?.mergedProviderProjectionById as
                        | Record<string, { identity?: { pluginId: string; localId: string } | null }>
                        | null
                        | undefined
                )?.[agentId]?.identity ?? null,
                connectedAccounts: [],
                cli: {
                    executable: { binaryName: agentId, sourcePreference: 'system-first' },
                    install: {
                        managed: agentId === 'codex' ? { kind: 'github_release_binary', githubRepo: 'openai/codex', binaryName: 'codex' } : null,
                        manual: { kind: 'none' },
                        docsUrl: agentId === 'codex' ? 'https://github.com/openai/codex' : null,
                    },
                    auth: {
                        support: agentId === 'codex' ? 'login_terminal' : 'unsupported',
                        loginLaunches: agentId === 'codex' ? [{ kind: 'primary', args: ['login'] }] : [],
                    },
                },
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
        machineProjectionRevisionState.revision = 0;
        machineProjectionRevisionState.listeners.clear();
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

    it('uses the canonical Administration exact target for its daemon projection', async () => {
        setAdministrationExecutionTarget('m2', 'server-selected');
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m2', expect.objectContaining({
            serverId: 'server-selected',
        }));
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
            perActiveServerIdentityId: 'admin-identity-b',
            accountOperationsAvailable: false,
            machineId: 'm2',
            serverId: 'admin-identity-b',
        });
        const daemonTarget = {
            kind: 'daemon' as const,
            serverIdentityId: 'admin-identity-b',
            machineId: 'm2',
            serverId: 'admin-identity-b',
        };
        expect(settingsSection.props.isDaemonTargetCurrent(daemonTarget)).toBe(true);
        administrationSelection.controller.setMachines([{
            machineId: 'm2', displayName: 'Machine Two', serverIdentityId: 'admin-identity-b',
            serverId: 'admin-identity-b', daemonStateVersion: 1,
        }]);
        expect(settingsSection.props.isDaemonTargetCurrent(daemonTarget)).toBe(false);

        const { AgentContributedSettingsSection } = await import('@/components/settings/agents/AgentSettingsScreen');
        const offlineScreen = await renderScreen(
            <AgentContributedSettingsSection
                pluginSettingsProjection={settingsSection.props.projection}
                targetSelection={{
                    candidates: [],
                    pickerRows: [],
                    state: {
                        kind: 'missing',
                        target: { serverIdentityId: 'admin-identity-b', machineId: 'm2' },
                        snapshot: null,
                    },
                    selectedTarget: { serverIdentityId: 'admin-identity-b', machineId: 'm2' },
                    selectedTargetServerMatchesActiveAccount: false,
                    canExecute: false,
                    selectTarget: () => {},
                    clearTarget: () => {},
                    resolveExecutionTarget: () => null,
                }}
                executionTarget={null}
                daemonOperationsAvailable={false}
            />,
        );
        expect(offlineScreen.findByType(PluginDetailGenericSettingsSection).props).toMatchObject({
            accountServerIdentityId: 'account-identity-a',
            daemonServerIdentityId: null,
            perActiveServerIdentityId: 'admin-identity-b',
            accountOperationsAvailable: false,
            machineId: null,
            serverId: null,
        });
    });

    it('keeps foreign-server daemon actions available while disabling every Account settings writer', async () => {
        activeServerSnapshot = {
            serverId: 'account-profile-a',
            serverUrl: 'http://account-a.example.test',
            generation: 1,
        };
        serverIdentityByProfileId = {
            'account-profile-a': 'account-identity-a',
        };
        setAdministrationExecutionTarget('m3', 'server2');
        mockAgentCatalogProjection.mockImplementation((agentId: string) => ({
            agentId,
            catalogAgentId: agentId,
            iconAgentId: agentId,
            title: agentId,
            subtitle: agentId,
            iconName: 'code-slash-outline',
            isBuiltIn: true,
            backendTargetKey: buildCanonicalBackendTargetKey(agentId),
            enabled: true,
            identity: { pluginId: 'acme.review', localId: 'provider' },
            connectedAccounts: [{
                purpose: 'primary',
                service: { pluginId: 'acme.review', localId: 'account' },
                required: false,
            }],
            cli: {
                executable: { binaryName: agentId, sourcePreference: 'system-first' },
                install: {
                    managed: { kind: 'github_release_binary', githubRepo: 'openai/codex', binaryName: 'codex' },
                    manual: { kind: 'none' },
                    docsUrl: 'https://github.com/openai/codex',
                },
                auth: { support: 'unsupported', loginLaunches: [] },
            },
            authPlugin: null,
            backendEntry: null,
        }));
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildBuiltInAgentSettingsProjection(),
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const enabledSwitch = findEnabledSwitch(screen);
        expect(enabledSwitch?.props.disabled).toBe(true);
        enabledSwitch?.props.onValueChange?.(false);
        // One notice explains why every Account writer on the page is read-only.
        expect(screen.findByTestId('settings.agents.detail.accountScope')).toBeTruthy();

        const permissionChoice = findSegmentedChoice(screen, 'settingsSession.permissions.defaultPermissionModeTitle');
        expect(permissionChoice?.props.disabled).toBe(true);
        permissionChoice?.props.onChange('read-only');

        const sourceChoice = findSegmentedChoice(screen, 'settingsAgents.cliSourcePreference.title');
        expect(sourceChoice?.props.disabled).toBe(true);
        sourceChoice?.props.onChange('managed-first');

        const chooser = screen.findByType('ConnectedAccountPurposeTargetChooser' as any);
        expect(chooser.props.disabled).toBe(true);
        chooser.props.onChange({
            kind: 'account',
            account: {
                service: { pluginId: 'acme.review', localId: 'account' },
                accountId: 'work',
            },
        });

        expect(applySettingsMock).not.toHaveBeenCalled();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m3', expect.objectContaining({ serverId: 'server2' }));
    });

    it('uses daemon merged projection inputs when resolving a plugin provider settings screen', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildRunnablePluginProviderProjection(),
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
                        catalogAgentId: 'claude',
                        iconAgentId: 'codex',
                    }),
                }),
            }),
        );

        machineContributionRegistryProjectionDescribeMock.mockClear();

        await act(async () => {
            selectAdministrationTarget({
                serverIdentityId: 'server2',
                machineId: 'm3',
            });
        });
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m3', expect.objectContaining({
            serverId: 'server2',
        }));
    });

    it('shows projection loading instead of claiming an external Agent is absent during a cold load', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => new Promise(() => {}));

        const screen = await renderPluginAgentSettingsScreen();
        await flushHookEffects();

        expect(screen.findByTestId('settings.agents.projection.status')?.props).toMatchObject({
            title: 'common.loading',
            loading: true,
        });
        expect(screen.getTextContent()).not.toContain('settingsAgents.notFoundTitle');
    });

    it('keeps the same-target last-known Agent detail visible while projection refresh fails', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });

        const screen = await renderPluginAgentSettingsScreen();
        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(findAgentHeader(screen)?.props.title).toBe('Acme Review Provider');

        machineContributionRegistryProjectionDescribeMock.mockRejectedValueOnce(new Error('projection unavailable'));
        machineProjectionRevisionState.revision += 1;
        await act(async () => {
            for (const listener of machineProjectionRevisionState.listeners) listener();
        });
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(findAgentHeader(screen)?.props.title).toBe('Acme Review Provider');
        expect(screen.getTextContent()).not.toContain('settingsAgents.notFoundTitle');
    });

    it('opens Agent browse with the selected machine, server, and qualified Agent scope', async () => {
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildExternalSessionsAgentProjection(),
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        await act(async () => {
            selectAdministrationTarget({
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

        await act(async () => {
            selectAdministrationTarget({
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
                serverIdentityId: 'server1',
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

    // An installed Agent without the current UI declaration can retain durable
    // hooks. Its selected-machine inventory must still report a failed read.
    it('reads the selected machine’s hook inventory without assuming an absent UI declaration means no durable hooks', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildRunnablePluginProviderProjection(),
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'm1',
            descriptorsByAgentId: {
                'acme.review.provider': {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme.review',
                    agentId: 'acme.review.provider',
                    version: 1,
                    behavior: { externalSessions: { browse: { order: 10 } } },
                },
            },
        });
        publishProjectedAgentUiBehaviorDescriptors({ machineId: 'm2', descriptorsByAgentId: {} });
        mockAgentCatalogProjection.mockImplementation((agentId: string) => ({
            agentId,
            qualifiedId: 'acme.review.provider',
            identity: { pluginId: 'acme.review', localId: 'provider' },
            catalogAgentId: null,
            iconAgentId: null,
            title: 'Acme Review Provider',
            subtitle: agentId,
            iconName: 'layers-outline',
            isBuiltIn: false,
            backendTargetKey: buildCanonicalBackendTargetKey(agentId),
            enabled: true,
            cli: {
                executable: {
                    binaryName: 'acme',
                    sourcePreference: 'system-first',
                },
                install: {
                    managed: null,
                    manual: { kind: 'none' },
                    docsUrl: null,
                },
                auth: {
                    support: 'login_terminal',
                    loginLaunches: [{ kind: 'primary', args: ['login'] }],
                },
            },
            authPlugin: {
                agentId,
                support: 'login_terminal',
                docsUrl: 'https://example.com/acme',
                buildLoginLaunch: () => ({ initialCommand: 'acme login' }),
            },
            backendEntry: null,
        }));

        setAdministrationExecutionTarget('m1', 'server1');
        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        // The declared machine's unavailable inventory is reported honestly.
        expect(screen.findByTestId(
            'settings-external-sessions-inventory-status',
        )?.props.title).toBe('externalSessions.settingsIntegrationInventoryErrorTitle');

        await act(async () => {
            selectAdministrationTarget({
                serverIdentityId: 'server1',
                machineId: 'm2',
            });
        });
        await flushHookEffects();

        expect(machinePluginSessionHooksRpcMock).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm2' }));
        expect(screen.findByTestId(
            'settings-external-sessions-inventory-status',
        )?.props.title).toBe('externalSessions.settingsIntegrationInventoryErrorTitle');
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

        expect(mutateAccountSettingsOnceMock).toHaveBeenCalledTimes(1);
        const mutate = mutateAccountSettingsOnceMock.mock.calls[0]![0].mutate;
        const next = mutate({
            externalSessionsSettingsV1: settingsState.externalSessionsSettingsV1,
        });
        expect(next.settings.externalSessionsSettingsV1.autoLinkSourcePolicies).toEqual([
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
            signal: expect.any(AbortSignal),
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
            signal: expect.any(AbortSignal),
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

    it('does not render or probe with the previous machine Agent projection while a new target loads', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: buildRunnablePluginProviderProjection(),
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        expect(findAgentHeader(screen)?.props.title).toBe('Acme Review Provider');

        let resolveReload!: (value: {
            supported: true;
            projection: PluginProjectionV2;
        }) => void;
        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => new Promise((resolve) => {
            resolveReload = resolve;
        }));

        await act(async () => {
            selectAdministrationTarget({
                serverIdentityId: 'server2',
                machineId: 'm3',
            });
        });
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m3', expect.objectContaining({
            serverId: 'server2',
        }));
        const loadingItems = screen.findAllByType('Item' as any);
        expect(findAgentHeader(screen)).toBeUndefined();
        expect(loadingItems.some((node: any) => node.props?.title === 'common.loading')).toBe(true);
        expect(screen.getTextContent()).not.toContain('settingsAgents.notFoundTitle');

        await act(async () => {
            resolveReload({
                supported: true,
                projection: buildPluginProviderProjectionWithCli(),
            });
        });
        await flushHookEffects();

        expect(findAgentHeader(screen)?.props.title).toBe('Acme Review Provider');
    });

    it('refetches daemon projection inputs for the selected machine instead of pinning the first machine', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildRunnablePluginProviderProjection(),
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        machineContributionRegistryProjectionDescribeMock.mockClear();

        await act(async () => {
            selectAdministrationTarget({
                serverIdentityId: 'server1',
                machineId: 'm2',
            });
        });
        await flushHookEffects();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m2', expect.objectContaining({
            serverId: 'server1',
        }));
    });

    it('renders provider Account settings from daemon-projected runtime and CLI metadata without inventory facts', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildPluginProviderProjectionWithCli(),
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const items = screen.findAllByType('Item' as any);
        expect(findAgentHeader(screen)?.props.title).toBe('Acme Review Provider');
        expect(items.some((node: any) => node.props?.title === 'settingsAgents.notAvailable')).toBe(false);
        expect(findAgentHeader(screen)?.props.description).toContain('settingsAgents.channelPlugin');
        expect(readAgentHeaderIconAgentId(screen)).toBe('codex');
    });

    it('renders the projected provider detail screen even when the provider has no built-in runtime carrier', async () => {
        mockProviderId = 'acme.headless.provider';
        mockAgentCatalogProjection.mockReturnValue({
            agentId: 'acme.headless.provider',
            qualifiedId: 'acme.headless/provider',
            identity: { pluginId: 'acme.headless', localId: 'provider' },
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
        expect(findAgentHeader(screen)?.props.title).toBe('Acme Headless Provider');
        expect(items.some((node: any) => node.props?.title === 'settingsAgents.notAvailable')).toBe(false);
        expect(readAgentHeaderIconAgentId(screen)).toBe('claude');
    });

    it('renders the installed Agent plugin settings on the no-CLI Agent screen', async () => {
        mockProviderId = 'acme.headless.provider';
        mockAgentCatalogProjection.mockReturnValue({
            agentId: 'acme.headless.provider',
            qualifiedId: 'acme.headless/provider',
            // An installed Agent always carries its qualified identity: that is
            // what binds its contributed settings, and it is the exact fact the
            // detail screen compares instead of a local id.
            identity: { pluginId: 'acme.headless', localId: 'provider' },
            catalogAgentId: null,
            iconAgentId: 'claude',
            title: 'Acme Headless Provider',
            subtitle: 'Plugin provider',
            iconName: 'stack-simple',
            isBuiltIn: false,
            backendTargetKey: 'agent:acme.headless/provider',
            enabled: true,
            authPlugin: null,
            backendEntry: null,
        });
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: buildHeadlessAgentSettingsProjection(),
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const { PluginDetailGenericSettingsSection } = await import(
            '@/components/settings/plugins/detail/PluginDetailGenericSettingsSection'
        );
        const settingsSection = screen.findByType(PluginDetailGenericSettingsSection);
        expect(settingsSection.props).toMatchObject({ pluginId: 'acme.headless' });
        expect(settingsSection.props.projection.editableSettingsGroups).toHaveLength(1);
    });

    it('renders qualified Connected Account purposes on the no-CLI Agent screen', async () => {
        mockProviderId = 'acme.headless.provider';
        mockAgentCatalogProjection.mockReturnValue({
            agentId: 'acme.headless.provider',
            qualifiedId: 'acme.headless/provider',
            identity: { pluginId: 'acme.headless', localId: 'provider' },
            catalogAgentId: null,
            iconAgentId: null,
            title: 'Acme Headless Provider',
            subtitle: 'Plugin provider',
            iconName: 'stack-simple',
            isBuiltIn: false,
            backendTargetKey: null,
            enabled: null,
            authPlugin: null,
            connectedAccounts: [{
                purpose: 'primary',
                service: { pluginId: 'acme.headless', localId: 'account' },
                required: false,
            }],
            backendEntry: null,
        });

        const screen = await renderPluginAgentSettingsScreen();
        expect(screen.findByType('ConnectedAccountPurposeTargetChooser' as any).props.declaration).toEqual({
            purpose: 'primary',
            service: { pluginId: 'acme.headless', localId: 'account' },
            required: false,
        });
    });

    it('keeps plugin-backed enablement informational when projection truth has no target key', async () => {
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
        expect(findEnabledSwitch(screen)).toBeUndefined();
    });

    it('addresses the recovery handoff to its exact portable target', async () => {
        // A route handoff admits only a canonical `srv_…` server identity.
        administrationSelection.controller.setMachines([...administrationMachines, {
            machineId: 'm2', displayName: 'Machine Two', homeDir: '/Users/m2', daemonStateVersion: 0,
            serverIdentityId: 'srv_portable', serverId: 'srv_portable',
        }]);
        mockRecoveryMachineId = 'm2';
        mockRecoveryServerIdentityId = 'srv_portable';
        mockInstallIntent = 'update';
        await renderPluginAgentSettingsScreen();
        await flushHookEffects();
        expect(administrationSelection.controller.selectedTargets).toEqual([{ serverIdentityId: 'srv_portable', machineId: 'm2' }]);
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m2', expect.objectContaining({ serverId: 'srv_portable' }));
    });

    it('rejects a device-local profile id in the recovery handoff as non-portable selection authority', async () => {
        // The route names a profile/routing id whose canonical identity *is* a live candidate.
        // Equivalence must never promote it: only the exact portable serverIdentityId admits a
        // recovery target.
        serverIdentityByProfileId = {
            server1: 'server1',
            'legacy-profile-9': 'server1',
        };
        mockRecoveryMachineId = 'm2';
        mockRecoveryServerIdentityId = 'legacy-profile-9';
        mockInstallIntent = 'update';

        await renderPluginAgentSettingsScreen();
        await flushHookEffects();

        expect(administrationSelection.controller.selectedTargets).toEqual([]);
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m1', expect.objectContaining({ serverId: 'server1' }));
    });

    it('uses the route plugin id for the exact installed Agent display and qualified hook operation', async () => {
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

        expect(findAgentHeader(screen)?.props.title).toBe('Acme Voice Claude');
        expect(machinePluginSessionHooksRpcMock).toHaveBeenCalledWith({
            machineId: 'm1',
            serverId: 'server1',
            signal: expect.any(AbortSignal),
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
        expect(screen.findByTestId('settings.agents.detail.machines')).toBeNull();
        expect(machinePluginSessionHooksRpcMock).not.toHaveBeenCalled();
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
        expect(administrationSelection.module.resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: 'server1', machineId: 'm1' })?.target).toEqual({
            serverIdentityId: 'server1',
            machineId: 'm1',
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m1', expect.objectContaining({ serverId: 'server1' }));
    });

    it('does not retarget Agent operations when the active server changes', async () => {
        const screen = await renderPluginAgentSettingsScreen();

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m1', expect.objectContaining({ serverId: 'server1' }));

        await act(async () => {
            activeServerSnapshot = {
                serverId: 'server2',
                serverUrl: 'http://localhost:4000',
                generation: 2,
            };
            emitActiveServerSnapshot(activeServerSnapshot);
        });
        await flushHookEffects();

        expect(administrationSelection.module.resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: 'server1', machineId: 'm1' })?.target).toEqual({
            serverIdentityId: 'server1',
            machineId: 'm1',
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('m1', expect.objectContaining({ serverId: 'server1' }));

    });

    it('keeps account-level settings usable with no machine selected and asks for a machine only where one matters', async () => {
        administrationSelection.controller.select(null);
        const { useAgentsAdministrationTargetSelection, useAgentsMachineScope } = await import('@/components/settings/agents/collection/useAgentAdministrationCatalog');
        const scope = await renderHook(() => useAgentsMachineScope(useAgentsAdministrationTargetSelection()));
        expect(scope.getCurrent().projectionScope).toBeNull();
        expect(scope.getCurrent().executionTarget).toBeNull();
        // There is no selected-target projection or CLI declaration. The
        // separate Account-wide Machine inventory remains visible.
        mockAgentCatalogProjection.mockImplementation((agentId: string) => (agentId === 'codex' ? {
            agentId,
            catalogAgentId: agentId,
            iconAgentId: agentId,
            title: 'Codex',
            subtitle: agentId,
            iconName: 'code-slash-outline',
            isBuiltIn: true,
            backendTargetKey: buildCanonicalBackendTargetKey(agentId),
            enabled: true,
            identity: null,
            connectedAccounts: [],
            cli: null,
            authPlugin: null,
            backendEntry: null,
        } : null));

        const screen = await renderPluginAgentSettingsScreen();
        await flushHookEffects();

        expect(findEnabledSwitch(screen)?.props.disabled).toBe(false);
        const permissionChoice = findSegmentedChoice(screen, 'settingsSession.permissions.defaultPermissionModeTitle');
        expect(permissionChoice).toBeTruthy();
        await act(async () => {
            permissionChoice?.props.onChange('yolo');
        });
        await vi.waitFor(() => expect(settingsWriteSpy, JSON.stringify(observedActionResults)).toHaveBeenCalledWith(expect.objectContaining({
            sessionDefaultPermissionModeByTargetKey: { [buildCanonicalBackendTargetKey('codex')]: 'yolo' },
        })));
        expect(findAgentHeader(screen)).toBeTruthy();
        // No selected-target projection is read; the Account-wide Machine inventory
        // (AgentMachinesSection) reads each listed Machine's own projection.
        for (const [machineId] of machineContributionRegistryProjectionDescribeMock.mock.calls) {
            expect(administrationMachines.map(row => row.machineId)).toContain(machineId);
        }
    });

    it('shows account-level settings immediately while the machine projection is still loading', async () => {
        machineContributionRegistryProjectionDescribeMock.mockReturnValue(new Promise(() => {}));
        mockAgentCatalogProjection.mockImplementation((agentId: string) => (agentId === 'codex' ? {
            agentId,
            catalogAgentId: agentId,
            iconAgentId: agentId,
            title: 'Codex',
            subtitle: agentId,
            iconName: 'code-slash-outline',
            isBuiltIn: true,
            backendTargetKey: buildCanonicalBackendTargetKey(agentId),
            enabled: true,
            identity: null,
            connectedAccounts: [],
            cli: null,
            authPlugin: null,
            backendEntry: null,
        } : null));

        const screen = await renderPluginAgentSettingsScreen();
        await flushHookEffects();

        expect(screen.findByTestId('settings.agents.projection.status')).toBeNull();
        expect(findSegmentedChoice(screen, 'settingsSession.permissions.defaultPermissionModeTitle')).toBeTruthy();
        expect(findAgentHeader(screen)).toBeTruthy();
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
        const enabledSwitch = findEnabledSwitch(screen);

        expect(enabledSwitch?.props?.value).toBe(false);

        await act(async () => {
            enabledSwitch?.props?.onValueChange(true);
        });
        await flushHookEffects();

        await vi.waitFor(() => expect(settingsWriteSpy, JSON.stringify(observedActionResults)).toHaveBeenCalledWith(expect.objectContaining({
            backendEnabledByTargetKey: {
                [buildCanonicalBackendTargetKey('antigravity-localharness')]: false,
                [antigravityTargetKey]: true,
            },
        })));
    });

    it('reads legacy built-in permission preferences from compatibility target keys and still writes the canonical backend key', async () => {
        const codexLegacyTargetKey = buildLegacyBuiltInTargetKey('codex');
        const codexTargetKey = buildCanonicalBackendTargetKey('codex');
        settingsState.sessionDefaultPermissionModeByTargetKey = {
            [codexLegacyTargetKey]: 'read-only',
        };

        const screen = await renderPluginAgentSettingsScreen();
        const permissionChoice = findSegmentedChoice(screen, 'settingsSession.permissions.defaultPermissionModeTitle');

        expect(permissionChoice?.props?.value).toBe('read-only');

        await act(async () => {
            permissionChoice?.props?.onChange('default');
        });
        await flushHookEffects();

        await vi.waitFor(() => expect(settingsWriteSpy, JSON.stringify(observedActionResults)).toHaveBeenCalledWith(expect.objectContaining({
            sessionDefaultPermissionModeByTargetKey: {
                [codexTargetKey]: 'default',
            },
        })));
    });

    it('renders and updates the backend CLI source preference when a managed install exists', async () => {
        const screen = await renderPluginAgentSettingsScreen();
        const sourceChoice = findSegmentedChoice(screen, 'settingsAgents.cliSourcePreference.title');
        expect(sourceChoice).toBeTruthy();
        expect(sourceChoice!.props.value).toBe('system-first');
        expect(sourceChoice!.props.disabled).toBe(false);

        await act(async () => {
            sourceChoice!.props.onChange('managed-first');
        });
        await flushHookEffects();

        await vi.waitFor(() => expect(settingsWriteSpy, JSON.stringify(observedActionResults)).toHaveBeenCalledWith(expect.objectContaining({
            backendCliSourcePreferenceByTargetKey: {
                [buildCanonicalBackendTargetKey('codex')]: 'managed-first',
            },
        })));
    });

    it('reads legacy built-in CLI source preferences from compatibility target keys and still writes the canonical backend key', async () => {
        const codexLegacyTargetKey = buildLegacyBuiltInTargetKey('codex');
        const codexTargetKey = buildCanonicalBackendTargetKey('codex');
        settingsState.backendCliSourcePreferenceByTargetKey = {
            [codexLegacyTargetKey]: 'managed-first',
        };

        const screen = await renderPluginAgentSettingsScreen();
        const sourceChoice = findSegmentedChoice(screen, 'settingsAgents.cliSourcePreference.title');

        expect(sourceChoice?.props?.value).toBe('managed-first');

        await act(async () => {
            sourceChoice?.props?.onChange('system-first');
        });
        await flushHookEffects();

        await vi.waitFor(() => expect(settingsWriteSpy, JSON.stringify(observedActionResults)).toHaveBeenCalledWith(expect.objectContaining({
            backendCliSourcePreferenceByTargetKey: {
                [codexTargetKey]: 'system-first',
            },
        })));
    });

    it('redirects the custom ACP provider route back to the providers index', async () => {
        mockProviderId = 'customAcp';
        const screen = await renderPluginAgentSettingsScreen();
        const redirect = screen.findByType('Redirect' as any);
        expect(redirect.props.href).toBe('/(app)/settings/agents');
    });

    it('redirects the legacy custom ACP provider route to the canonical projected provider when merged projection resolves one', async () => {
        mockProviderId = 'customAcp';
        let resolveProjection!: (value: Readonly<{
            supported: true;
            projection: PluginProjectionV2;
        }>) => void;
        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => new Promise((resolve) => {
            resolveProjection = resolve;
        }));

        const screen = await renderPluginAgentSettingsScreen();
        await flushHookEffects();
        expect(screen.findByTestId('settings.agents.projection.status')).toBeTruthy();

        await act(async () => {
            resolveProjection({
                supported: true,
                projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
            });
        });
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
        expect(findAgentHeader(screen)?.props.title).toBe('Acme Review Backend');
        expect(items.some((node: any) => node.props?.title === 'settingsAgents.notFoundTitle')).toBe(false);
        // The page header carries the agent's identity mark.
        const header = screen.findByTestId('settings.agents.detail.header');
        expect(header?.findAll((node: any) => node.props?.entry?.iconAgentId === 'claude').length).toBeGreaterThan(0);
        expect(screen.findAllByType('BadgeGrid' as any)).toHaveLength(0);
        expect(items.some((node: any) => node.props?.title === 'settingsProviders.models.manage')).toBe(false);
    });

    it('renders external Agent capabilities and CLI details only from its exact current public projection', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
                agentsById: {
                    'acme.review.provider': {
                        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById['acme.review.provider'],
                        capabilities: {
                            surfaces: ['terminal'],
                            sessions: {
                                open: ['create', 'resume'],
                                delivery: ['newTurn'],
                                cancel: true,
                            },
                        },
                        cli: {
                            executable: {
                                binaryName: 'acme-review',
                                sourcePreference: 'managed-first',
                            },
                            install: {
                                managed: {
                                    kind: 'managed_package',
                                    packageName: '@acme/review',
                                    binaryName: 'acme-review',
                                },
                                manual: { kind: 'none' },
                                docsUrl: 'https://example.com/acme-review',
                            },
                            auth: {
                                support: 'unsupported',
                                loginLaunches: [],
                            },
                        },
                    },
                },
            } satisfies PluginProjectionV2,
        });

        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        // Capabilities sit in a closed disclosure whose header summarizes them.
        const capabilitiesHeader = screen.findByTestId('settings.agents.detail.capabilities.header');
        expect(capabilitiesHeader?.props.detail).toBe('settingsAgents.resumeSupportTitle · settingsAgents.localControlTitle');
        await act(async () => {
            capabilitiesHeader?.props.onPress();
        });
        expect(screen.findByType('BadgeGrid' as any).props.items).toEqual([
            expect.objectContaining({ id: 'resume', status: 'positive' }),
            expect.objectContaining({ id: 'localControl', status: 'positive' }),
        ]);
        expect(screen.findAllByType('Item' as any).some(
            (node: any) => node.props?.title === 'settingsAgents.defaultModelTitle',
        )).toBe(false);
    });

    /**
     * Protocol admits an AUXILIARY-ONLY Agent: it declares the
     * `externalSessions` surface and neither a runtime nor CLI/auth. Such an
     * Agent lands on the fallback detail screen, so External Sessions has to be
     * composed there too — its reachability is a property of the Agent, not of
     * whether the same Agent happens to carry a bundled runtime or a login UI.
     */
    it('renders External Sessions on the detail screen of an auxiliary-only Agent', async () => {
        mockProviderId = 'acme.transcripts';
        // The fallback branch is exactly "no runtime carrier and no auth UI",
        // and it must not require pane context.
        shouldThrowOnAppPaneScope = true;
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'm1',
            descriptorsByAgentId: {
                'acme.transcripts': {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme.transcripts',
                    agentId: 'acme.transcripts',
                    version: 1,
                    behavior: { externalSessions: { browse: { order: 10 } } },
                },
            },
        });
        mockAgentCatalogProjection.mockImplementation((agentId: string) => ({
            agentId,
            qualifiedId: 'acme.transcripts/acme.transcripts',
            identity: { pluginId: 'acme.transcripts', localId: 'acme.transcripts' },
            catalogAgentId: null,
            iconAgentId: null,
            title: 'Acme Transcripts',
            subtitle: agentId,
            iconName: 'layers-outline',
            isBuiltIn: false,
            backendTargetKey: null,
            enabled: null,
            authPlugin: null,
            backendEntry: null,
        }));

        setAdministrationExecutionTarget('m1', 'server1');
        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        // The fallback screen really is the one rendering (identity row), and
        // the canonical External Sessions section is composed alongside it.
        expect(findAgentHeader(screen)?.props.title).toBe('Acme Transcripts');
        expect(screen.findByTestId('settings-external-sessions-manage-all')).toBeTruthy();
        // The machine declares External Sessions while its daemon projects no
        // Agent for it, so the honest state is the same error the primary
        // screen shows — not silence.
        expect(screen.findByTestId(
            'settings-external-sessions-inventory-status',
        )?.props.title).toBe('externalSessions.settingsIntegrationInventoryErrorTitle');
    });


    it('renders the not found screen without requiring pane context', async () => {
        mockProviderId = 'unknown';
        shouldThrowOnAppPaneScope = true;
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        });
        const screen = await renderPluginAgentSettingsScreen();
        const textNodes = screen.findAllByType('Text' as any);
        expect(textNodes.some((node: any) => node.props?.children === 'settingsAgents.notFoundTitle')).toBe(true);
        expect(textNodes.some((node: any) => node.props?.children === 'settingsAgents.notFoundSubtitle')).toBe(true);
        expect(textNodes.some((node: any) => node.props?.children === 'Unknown')).toBe(false);
    });

    it('does not resurrect a legacy Agent default after the canonical purpose catalog is explicitly empty', async () => {
        mockProviderId = 'acme.review.provider';
        // The shape the Connected Services page persisted before the purpose-binding store owned Agent defaults.
        settingsState.connectedServicesDefaultAuthByAgentIdV1 = {
            v: 1,
            bindingsByAgentId: {
                'acme.review.provider': {
                    v: 1,
                    bindingsByServiceId: {
                        'acme.review/account': { source: 'connected', selection: 'profile', profileId: 'legacy-work' },
                    },
                },
            },
        };
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
                agentsById: {
                    ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById,
                    'acme.review.provider': {
                        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById['acme.review.provider'],
                        connectedAccounts: [{
                            purpose: 'primary',
                            service: { pluginId: 'acme.review', localId: 'account' },
                            required: false,
                        }],
                    },
                },
            },
        });
        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const chooser = screen.findByType('ConnectedAccountPurposeTargetChooser' as any);
        expect(chooser.props.value).toBeNull();
        chooser.props.onChange(null);
        await vi.waitFor(() => expect(settingsWriteSpy, JSON.stringify(observedActionResults)).toHaveBeenCalledWith(expect.objectContaining({
            connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
        })));
    });

    it('keeps the last-known purpose selection available during refetch and withdraws it when authority is lost', async () => {
        mockProviderId = 'acme.headless.provider';
        mockAgentCatalogProjection.mockReturnValue({
            agentId: 'acme.headless.provider',
            identity: { pluginId: 'acme.headless', localId: 'provider' },
            catalogAgentId: null, iconAgentId: null, title: 'Acme Headless Provider',
            subtitle: null, iconName: 'stack-simple', isBuiltIn: false,
            backendTargetKey: null, enabled: null, authPlugin: null, backendEntry: null,
            connectedAccounts: [{ purpose: 'primary', service: { pluginId: 'acme.headless', localId: 'account' }, required: false }],
        });
        settingsState.connectedAccountPurposeBindingsV1 = { v: 1, bindings: [{
            purpose: { consumer: { pluginId: 'acme.headless', localId: 'provider' }, purpose: 'primary' },
            target: { kind: 'account', account: { service: { pluginId: 'acme.headless', localId: 'account' }, accountId: 'work' } },
        }] };
        const screen = await renderPluginAgentSettingsScreen();
        await flushHookEffects();
        const chooser = () => screen.findByType('ConnectedAccountPurposeTargetChooser' as any);
        expect(chooser().props.value).toMatchObject({ kind: 'account', account: { accountId: 'work' } });
        expect(chooser().props.disabled).toBe(false);
        const scope = { serverId: 'server1', accountId: 'account:server1' };
        await act(async () => { beginConnectedAccountCatalogLoad(scope, 'purposes'); });
        expect(chooser().props.value).toMatchObject({ kind: 'account', account: { accountId: 'work' } });
        expect(chooser().props.disabled).toBe(false);
        expect(chooser().props.disabledReason).toBeUndefined();
        await act(async () => {
            applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'unavailable', reason: 'unauthorized' }, true);
        });
        expect(chooser().props.value).toBeNull();
        expect(chooser().props.disabled).toBe(true);
    });

    it('writes projected Agent account defaults through the qualified purpose binding owner', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
                agentsById: {
                    ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById,
                    'acme.review.provider': {
                        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById['acme.review.provider'],
                        connectedAccounts: [{
                            purpose: 'primary',
                            service: { pluginId: 'acme.review', localId: 'account' },
                            required: false,
                        }],
                    },
                },
            },
        });
        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const chooser = screen.findByType('ConnectedAccountPurposeTargetChooser' as any);
        expect(chooser.props.declaration).toMatchObject({
            purpose: 'primary',
            service: { pluginId: 'acme.review', localId: 'account' },
        });
        chooser.props.onChange({
            kind: 'account',
            account: {
                service: { pluginId: 'acme.review', localId: 'account' },
                accountId: 'work',
            },
        });
        await vi.waitFor(() => expect(purposes.value, JSON.stringify(observedActionResults)).toMatchObject({
                v: 1,
                bindings: [{
                    purpose: {
                        consumer: { pluginId: 'acme.review', localId: 'provider' },
                        purpose: 'primary',
                    },
                    target: {
                        kind: 'account',
                        account: {
                            service: { pluginId: 'acme.review', localId: 'account' },
                            accountId: 'work',
                        },
                    },
                }],
        }));
    });
    it('writes a Team resource choice as the canonical Team selection, never a purpose target', async () => {
        mockProviderId = 'acme.review.provider';
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
                agentsById: {
                    ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById,
                    'acme.review.provider': {
                        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById['acme.review.provider'],
                        connectedAccounts: [{
                            purpose: 'primary',
                            service: { pluginId: 'acme.review', localId: 'account' },
                            required: false,
                        }],
                    },
                },
            },
        });
        const screen = await renderPluginAgentSettingsScreen();
        await act(async () => {});
        await flushHookEffects();

        const chooser = screen.findByType('ConnectedAccountPurposeTargetChooser' as any);
        expect(chooser.props.declaration).toMatchObject({
            purpose: 'primary',
            service: { pluginId: 'acme.review', localId: 'account' },
        });
        const teamResource = {
            teamId: 'team-acme',
            selection: { source: 'team_resource' as const, resourceId: 'resource-pool', deliveryMode: 'brokered' as const },
        };
        chooser.props.onChange(null, teamResource);
        // Lane 10 child 02 :271 / child 06 :506: the purpose target union stays
        // `account | group`; the Agent default persists the Team selection.
        await vi.waitFor(() => expect(purposes.value, JSON.stringify(observedActionResults)).toMatchObject({
                v: 1,
                bindings: [],
                teamResourceSelections: [{
                    purpose: {
                        consumer: { pluginId: 'acme.review', localId: 'provider' },
                        purpose: 'primary',
                    },
                    ...teamResource,
                }],
        }));
    });
});
const settingsState = {
    actionsSettingsV1: { v: 1 as const, approvalWaivedSurfaces: {
        'settings.set': ['ui' as const],
        'connectedServices.purposes.default.set': ['ui' as const],
        'connectedServices.accounts.purposeDefault.set': ['ui' as const],
    } },
    backendEnabledByTargetKey: {},
    sessionDefaultPermissionModeByTargetKey: {},
    backendCliSourcePreferenceByTargetKey: {},
    contextSelectionsV1: undefined as any,
    acpCatalogSettingsV1: { v: 2, backends: [] },
    opencodeServerBaseUrl: '',
    opencodeServerBaseUrlByServerIdV1: {} as Record<string, string>,
    externalSessionsSettingsV1: undefined as any,
    connectedAccountPurposeBindingsV1: { v: 1 as const, bindings: [] as any[] },
    connectedServicesDefaultAuthByAgentIdV1: undefined as any,
};

// Load the real Action/catalog graph after the boundary factories above are configured,
// during collection rather than spending the first test hook's budget on cold transforms.
const { resetConnectedAccountCatalogEngineForTests } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
