import React from 'react';
import { beforeAll, beforeEach, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import {
    createExpoRouterMock,
    createStackOptionsCapture as createRawStackOptionsCapture,
    type StackOptionsCapture,
    type StackScreenOptions,
    type StackScreenOptionsInput,
} from '@/dev/testkit/mocks/router';
import type { ServerProfileMockProfile } from '@/dev/testkit/mocks/serverProfiles';

type MachineContributionRegistryProjectionModule =
    typeof import('@/sync/ops/machineContributionRegistryProjection');
export type MachineContributionRegistryProjectionDescribeFn =
    MachineContributionRegistryProjectionModule['machineContributionRegistryProjectionDescribe'];
export type MachineContributionRegistryProjectionDescribeResult =
    Awaited<ReturnType<MachineContributionRegistryProjectionDescribeFn>>;
type TempDataStoreModule = typeof import('@/utils/sessions/tempDataStore');

type ReactActEnvironmentGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type HeaderButtonElement = React.ReactElement<{
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  testID?: string;
  /** `AppHeaderCloseButton` presentation: the picker routes' Cancel is `'text'`. */
  appearance?: 'glyph' | 'text';
}> | null | undefined;

export type PickerStackScreenOptions = StackScreenOptions & Readonly<{
  presentation?: string;
  headerLeft?: () => HeaderButtonElement;
  headerRight?: () => HeaderButtonElement;
}>;

export type PickerStackOptionsCapture = Omit<StackOptionsCapture, 'getResolved'> & Readonly<{
  getResolved: () => PickerStackScreenOptions | null;
}>;

export type { StackScreenOptionsInput as PickerStackOptionsInput };

export type PickerNavigationRoute = Readonly<{
    key: string;
    name?: string;
    path?: string;
    params?: Record<string, unknown>;
}>;

export type PickerNavigationState = Readonly<{
    index: number;
    routes: PickerNavigationRoute[];
}>;

export function createStackOptionsCapture(): PickerStackOptionsCapture {
    const capture = createRawStackOptionsCapture();
    return {
        ...capture,
        getResolved: () => capture.getResolved() as PickerStackScreenOptions | null,
    };
}

export function enableReactActEnvironment() {
    (globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
}

type PickerModuleFactory = () => unknown | Promise<unknown>;
type PickerStorageModuleFactory = (importOriginal: <T>() => Promise<T>) => unknown | Promise<unknown>;

/**
 * The daemon projection seam a picker reaches through the real
 * `loadDaemonMergedProjectionInputs` graph. Only the describe transport is
 * replaced; every other real export of the projection module (Settings,
 * secret, watch, UI-resource seams) stays live so consumers such as scoped
 * plugin settings resolve their imports. The genuine transport, credential,
 * and Home-profile boundaries beneath it are the canonical testkit mocks.
 */
export type PickerProjectionSeamOptions = Readonly<{
    describe: MachineContributionRegistryProjectionDescribeFn;
    /** Home profiles the account-scope resolver may bind; defaults to `server-2`. */
    serverProfiles?: readonly ServerProfileMockProfile[];
}>;

type PickerCommonModuleMocksOptions = Readonly<{
    expoRouter?: PickerModuleFactory;
    itemList?: PickerModuleFactory;
    modal?: PickerModuleFactory;
    reactNavigationNative?: PickerModuleFactory;
    reactNative?: PickerModuleFactory;
    vectorIcons?: PickerModuleFactory;
    storage?: PickerStorageModuleFactory;
    text?: PickerModuleFactory;
    unistyles?: PickerModuleFactory;
    projectionSeam?: PickerProjectionSeamOptions;
    /**
     * Overrides layered over the real in-memory one-shot store so a suite can
     * pin a returned id or a peeked draft while every other export stays real.
     */
    tempDataStore?: Partial<TempDataStoreModule>;
}>;

const pickerCommonModuleMocksState = vi.hoisted(() => ({
    options: {} as PickerCommonModuleMocksOptions,
}));

export const PICKER_PROJECTION_SEAM_SERVER_PROFILES = [
    { id: 'server-2', serverUrl: 'https://server-2.example.test' },
] as const satisfies readonly ServerProfileMockProfile[];

/**
 * A describe transport spy that reports the daemon as not projection-capable
 * until a test resolves a projection through it.
 */
export function createProjectionDescribeMock() {
    return vi.fn<MachineContributionRegistryProjectionDescribeFn>(
        async () => ({ supported: false, reason: 'not-supported' }),
    );
}

export function installPickerCommonModuleMocks(options: PickerCommonModuleMocksOptions = {}) {
    pickerCommonModuleMocksState.options = options;

    if (options.projectionSeam) {
        beforeAll(async () => {
            // The real projection/seam graph loaded by the shared harness costs
            // more than the 60s hook timeout to evaluate once per file. Warm it
            // here where a longer timeout applies.
            await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        }, 300_000);
    }

    beforeEach(async () => {
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        clearDaemonMergedProjectionCacheForTests();
    });

    vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => {
        const original = await importOriginal<MachineContributionRegistryProjectionModule>();
        const seam = pickerCommonModuleMocksState.options.projectionSeam;
        if (!seam) {
            return original;
        }
        return {
            ...original,
            machineContributionRegistryProjectionDescribe: (
                ...args: Parameters<MachineContributionRegistryProjectionDescribeFn>
            ) => seam.describe(...args),
        };
    });

    vi.mock(
        '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
        async (importOriginal) => {
            if (!pickerCommonModuleMocksState.options.projectionSeam) {
                return await importOriginal();
            }
            const { installServerScopedMachineRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
            return installServerScopedMachineRpcModuleMock({
                // Genuine transport boundary: no machine socket exists in a picker
                // suite. Every caller maps a failure to a typed not-supported/error result.
                machineRpcWithServerScope: () => Promise.reject(new Error('machine RPC unavailable in test')),
            })(importOriginal);
        },
    );

    vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
        const seam = pickerCommonModuleMocksState.options.projectionSeam;
        if (!seam) {
            return await importOriginal();
        }
        const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
        return createPartialServerProfilesModuleMock(importOriginal, {
            profiles: seam.serverProfiles ?? PICKER_PROJECTION_SEAM_SERVER_PROFILES,
        });
    });

    vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
        if (!pickerCommonModuleMocksState.options.projectionSeam) {
            return await importOriginal();
        }
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

    vi.mock('@/utils/sessions/tempDataStore', async (importOriginal) => {
        const original = await importOriginal<TempDataStoreModule>();
        return {
            ...original,
            ...pickerCommonModuleMocksState.options.tempDataStore,
        };
    });

    vi.mock('@/text', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('react-native', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.expoRouter) {
            return await activeOptions.expoRouter();
        }
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@react-navigation/native', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.reactNavigationNative) {
            return await activeOptions.reactNavigationNative();
        }

        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        return createReactNavigationNativeMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.vectorIcons) {
            return await activeOptions.vectorIcons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('react-native-typography', async () => {
        const { createReactNativeTypographyMock } = await import('@/dev/testkit/mocks/reactNativeTypography');
        return createReactNativeTypographyMock();
    });

    vi.mock('@/components/ui/lists/ItemList', async (importOriginal) => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.itemList) {
            return await activeOptions.itemList();
        }

        return await importOriginal();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }
        return await importOriginal();
    });
}

export const PICKER_NAV_STATE = { index: 1, routes: [{ key: 'a' }, { key: 'b' }] } as const;

export const PICKER_THEME_COLORS = {
  background: { canvas: '#ffffff' },
  border: { default: '#ddd' },
  chrome: { header: { foreground: '#000' } },
  input: { background: '#fff', placeholder: '#aaa', text: '#000' },
  status: { connected: '#0f0', disconnected: '#f00', error: '#f00' },
  surface: { base: '#fff', inset: '#ffffff' },
  textSecondary: '#666',
} as const;

export function createRouterMock() {
    const { spies } = createExpoRouterMock();
    return {
        push: spies.push,
        back: spies.back,
        replace: spies.replace,
        setParams: spies.setParams,
    };
}

export function createNavigationMock(): {
    dispatch: ReturnType<typeof vi.fn>;
    getState: () => PickerNavigationState;
    goBack: ReturnType<typeof vi.fn>;
    setParams: ReturnType<typeof vi.fn>;
} {
    return {
        dispatch: vi.fn(),
        getState: () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        }),
        goBack: vi.fn(),
        setParams: vi.fn(),
    };
}

export function cloneNavigationState(state: PickerNavigationState): PickerNavigationState {
    return {
        index: state.index,
        routes: state.routes.map((route) => ({
            key: route.key,
            ...(route.name ? { name: route.name } : {}),
            ...(route.path ? { path: route.path } : {}),
            ...(route.params ? { params: route.params } : {}),
        })),
    };
}

export function parseJsonRouteParam(value: unknown): unknown {
    if (typeof value !== 'string') {
        throw new Error(`Expected JSON route param string, got ${typeof value}`);
    }
    return JSON.parse(value);
}

/**
 * A bundled Agent resolved from route params or settings
 * (`resolvePreferredBackendTarget`) is a V2 `agent` target, which
 * `buildBackendTargetRouteParams` serializes only through the backendTarget
 * fields under its canonical qualified contribution identity: the retired
 * `backend:<bundledId>` spelling and the `agentType` compat carrier are not
 * re-emitted for it.
 */
export const BUNDLED_AGENT_ROUTE_PARAMS = {
    claude: {
        backendTarget: JSON.stringify({
            kind: 'agent',
            identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        }),
        backendTargetKey: 'agent:happier.agent.claude/claude',
    },
    codex: {
        backendTarget: JSON.stringify({
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        }),
        backendTargetKey: 'agent:happier.agent.codex/codex',
    },
} as const;

/**
 * A settings-owned configured ACP backend keeps its `backend` target kind and
 * `configuredBackendId` carrier through every picker round trip; only the
 * legacy `sourceKind` and the `customAcp` compat `agentType` are dropped.
 */
export function createConfiguredBackendRouteParams(configuredBackendId: string) {
    return {
        backendTarget: JSON.stringify({
            kind: 'backend',
            backendId: configuredBackendId,
            configuredBackendId,
        }),
        backendTargetKey: `backend:${configuredBackendId}:configured:${configuredBackendId}`,
    } as const;
}

/**
 * The `acpCatalogSettingsV1` entry a suite stores to make a configured backend
 * id resolvable (or, by omission, stale) for `resolvePreferredBackendTarget`.
 */
export function createConfiguredAcpBackendCatalogSettings(configuredBackendId: string) {
    return {
        v: 2,
        backends: [{
            id: configuredBackendId,
            name: configuredBackendId,
            title: 'Review Bot',
            command: configuredBackendId,
            args: [],
            env: {},
            transportProfile: 'generic',
            capabilities: {
                supportsLoadSession: false,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
            },
            createdAt: 1,
            updatedAt: 1,
        }],
    } as const;
}

/**
 * The canonical daemon `PluginProjectionV2` a resume picker suite feeds through
 * the real `machineContributionRegistryProjectionDescribe` seam: the bundled
 * Claude Agent with a browseable `claudeConfig` External Sessions source, plus
 * optional extra packages/Agents for plugin-carrier cases. Schema-parsed
 * so a fixture drift fails here rather than as a silent projection `error` phase.
 */
export function createSupportedClaudeProjection(params: Readonly<{
    additionalAgentsById?: Readonly<Record<string, unknown>>;
    additionalInstalledPackagesById?: Readonly<Record<string, unknown>>;
    /**
     * Models an ACP `session/list`-backed source: listing plus "resume in
     * Happier" only, with no link identity and no follow/takeover claim.
     */
    resumeOnlySource?: boolean;
}> = {}) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        installedPackagesById: {
            'happier.agent.claude': {
                id: 'happier.agent.claude',
                displayName: 'Claude',
                enabled: true,
                source: { kind: 'bundled', locator: 'happier.agent.claude' },
            },
            ...params.additionalInstalledPackagesById,
            'acme.review-bot': {
                id: 'acme.review-bot',
                displayName: 'Review Bot',
                enabled: true,
                source: { kind: 'local', locator: 'acme.review-bot' },
            },
        },
        agentsById: {
            ...params.additionalAgentsById,
            claude: {
                id: 'claude',
                title: 'Claude',
                catalogAgentId: 'claude',
                iconAgentId: 'claude',
                identity: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude',
                },
                externalSessions: {
                    agent: {
                        pluginId: 'happier.agent.claude',
                        localId: 'claude',
                    },
                    generation: 1,
                    operations: {
                        listCandidates: true,
                        resolveLinkIdentity: params.resumeOnlySource !== true,
                        pageTranscript: true,
                        readAfterTranscript: true,
                    },
                    sources: [{
                        sourceKind: 'claudeConfig',
                        ...(params.resumeOnlySource === true ? { resumeOnly: true } : {}),
                        schema: {
                            fields: [
                                { name: 'kind', kind: 'literal', value: 'claudeConfig' },
                                { name: 'configDir', kind: 'string', min: 1, max: 10_000, nullish: true },
                                { name: 'projectId', kind: 'string', min: 1, max: 2_000, nullish: true },
                            ],
                        },
                        key: {
                            segments: [
                                { kind: 'literal', value: 'claudeConfig' },
                                { kind: 'field', field: 'configDir' },
                                { kind: 'field', field: 'projectId' },
                            ],
                        },
                        instances: [{ kind: 'default', constants: {} }],
                    }],
                },
            },
        },
    });
}

/**
 * The `plugin:review-bot` Agent with its settings-backed carrier that a plugin
 * case adds to `createSupportedClaudeProjection`: the projection is the
 * only authority that proves which qualified contribution owns the
 * settings-backed plugin backend, and its `externalSessions` block is what
 * makes the real browse resolver pick that carrier over the bundled one.
 */
export function createReviewBotPluginProjectionContributions() {
    return {
        additionalAgentsById: {
            'plugin:review-bot': {
                id: 'plugin:review-bot',
                title: 'Review Bot Plugin',
                subtitle: 'plugin provider',
                channel: 'plugin',
                isBuiltIn: false,
                catalogAgentId: 'claude',
                iconAgentId: 'claude',
                identity: {
                    pluginId: 'acme.review-bot',
                    localId: 'review-bot',
                },
                externalSessions: {
                    agent: {
                        pluginId: 'acme.review-bot',
                        localId: 'review-bot',
                    },
                    generation: 1,
                    operations: {
                        listCandidates: true,
                        resolveLinkIdentity: true,
                        pageTranscript: true,
                        readAfterTranscript: true,
                    },
                    sources: [{
                        sourceKind: 'reviewBotConfig',
                        schema: {
                            fields: [
                                { name: 'kind', kind: 'literal', value: 'reviewBotConfig' },
                                { name: 'configDir', kind: 'string', min: 1, max: 10_000, nullish: true },
                            ],
                        },
                        key: {
                            segments: [
                                { kind: 'literal', value: 'reviewBotConfig' },
                                { kind: 'field', field: 'configDir' },
                            ],
                        },
                        instances: [{ kind: 'default', constants: {} }],
                    }],
                },
                settingsBackendId: 'plugin-review-bot',
            },
        },
    } as const;
}

/**
 * A supported describe result whose merged projection lists a discovered
 * plugin backend next to the bundled Claude Agent. Picker closeout must still
 * fall back to the preferred built-in target when route params only carry a
 * legacy `customAcp` carrier, rather than adopting a discovered plugin backend.
 */
export function createDiscoveredPluginBackendDescribeResult() {
    return {
        supported: true,
        projection: createSupportedClaudeProjection(createReviewBotPluginProjectionContributions()),
    } as const;
}
