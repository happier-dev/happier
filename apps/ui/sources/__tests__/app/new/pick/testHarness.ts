import type { Settings } from '@/sync/domains/settings/settings';
import React from 'react';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_ERROR_CODES} from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS} from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { AcpBackendDefinitionV1Schema, type AcpCatalogSettingsV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

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
export type MachineContributionRegistryProjectionDescribeResult =
    Awaited<ReturnType<MachineContributionRegistryProjectionModule['machineContributionRegistryProjectionDescribe']>>;
export type MachineContributionRegistryProjectionDescribeFn = (
    machineId: string,
    scope: Readonly<{ serverId?: string | null; accountId?: string | null }>,
) => Promise<MachineContributionRegistryProjectionDescribeResult>;
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
 * The daemon's answer at the Socket SDK boundary. Projection parsing,
 * normalization, cache, Account custody and every picker resolver stay real.
 */
export type PickerProjectionSeamOptions = Readonly<{
    describe: MachineContributionRegistryProjectionDescribeFn;
    ownIsolationStatus?: (machineId: string) => import('@happier-dev/protocol/machines/agentIsolationV1').MachineAgentIsolationOwnStatusV1;
    /** Home profiles the account-scope resolver may bind; defaults to `srv_picker_2`. */
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
    { id: 'srv_picker_2', serverUrl: 'https://server-2.example.test' },
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
    let account: Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').restoreServerAccountForTest>> | undefined;
    let homes: ReturnType<typeof import('@/dev/testkit/harness/homeGovernanceHarness').createHomeGovernanceHarness> | undefined;
    const machineRpcRequests: Array<Readonly<{ serverId: string; accountId: string; machineId: string; method: string; params: unknown }>> = [];
    async function restoreHome(serverId: string) {
        const seam = pickerCommonModuleMocksState.options.projectionSeam;
        const profile = (seam?.serverProfiles ?? PICKER_PROJECTION_SEAM_SERVER_PROFILES).find(candidate => candidate.id === serverId);
        if (!profile || !homes) throw new Error('Picker Home boundary unavailable');
        homes.answer(serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
        }) });
        await account?.dispose();
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        account = await restoreServerAccountForTest({ serverUrl: profile.serverUrl,
            serverIdentityId: normalizeServerIdentityIdCapability(profile.id) ?? undefined,
            accountId: `account:${profile.id}`, request: async (input, init) => {
                if (!homes) throw new Error('Picker Home boundary unavailable');
                const url = new URL(String(input));
                if (url.pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
                    return createMachineReadBatchResponseFixture(init.body, id => createPlainMachineRowFixture({
                        id, accountId: `account:${profile.id}`,
                    }));
                }
                if ((init?.method ?? 'GET') === 'GET' && url.pathname.startsWith('/v1/machines/')) {
                    const home = homes.findByServerUrl(url.origin);
                    if (!home) throw new Error(`Unexpected Machine lookup Home: ${url.origin}`);
                    homes.answer(home.serverId, url.pathname, { body: { machine: createPlainMachineRowFixture({
                        id: decodeURIComponent(url.pathname.slice('/v1/machines/'.length)), accountId: `account:${profile.id}`,
                    }) } });
                }
                return homes.request(input, init);
            } });
        const { refreshAcpCatalog } = await import('@/sync/engine/settings/acpCatalogEngine');
        await refreshAcpCatalog({ serverId: account.serverId, accountId: `account:${account.serverId}` });
    }
    // These factories consume caller configuration, so register them after that
    // configuration exists. Hoisting can resolve a default Web/router fixture
    // while the caller's static testkit imports are still evaluating.

    if (options.projectionSeam) {
        beforeAll(async () => {
            await initializeRealAppRuntimeForTests();
        });
    }

    beforeEach(async () => {
        const seam = pickerCommonModuleMocksState.options.projectionSeam;
        if (seam) {
            const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
            await loadSyncSingletonForTests();
            installDisconnectedServerSocketBoundary((socket, serverUrl) => {
                vi.mocked(socket.connect).mockImplementation(() => {
                    socket.connected = true;
                    for (const listener of socket.listeners('connect')) listener();
                    return socket;
                });
                vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
                    if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error(`Unexpected Socket ACK event: ${event}`);
                    if (!payload || typeof payload !== 'object' || !('method' in payload)
                        || typeof payload.method !== 'string' || !('params' in payload)) {
                        throw new Error('Invalid Machine RPC envelope');
                    }
                    const split = payload.method.indexOf(':');
                    if (split < 1) throw new Error('Missing Machine RPC target');
                    const machineId = payload.method.slice(0, split);
                    const method = payload.method.slice(split + 1);
                    const profiles = seam.serverProfiles ?? PICKER_PROJECTION_SEAM_SERVER_PROFILES;
                    const profile = profiles.find((candidate) => candidate.serverUrl === serverUrl);
                    if (!profile) throw new Error(`Unexpected Socket Home: ${serverUrl}`);
                    const token = typeof socket.auth === 'object' && typeof socket.auth.token === 'string'
                        ? socket.auth.token : null;
                    if (!token) throw new Error('Missing Socket Account credential');
                    const { parseToken } = await import('@/utils/auth/parseToken');
                    const accountId = parseToken(token);
                    machineRpcRequests.push({ serverId: profile.id, accountId, machineId, method, params: payload.params });
                    if (method === RPC_METHODS.MACHINES_AGENT_ISOLATION_STATUS && seam.ownIsolationStatus) {
                        return { ok: true, result: await seam.ownIsolationStatus(machineId) };
                    }
                    if (method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                        return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                    }
                    const answer = await seam.describe(machineId, { serverId: profile.id, accountId });
                    if (!answer.supported) {
                        if (answer.reason !== 'not-supported') throw new Error(answer.reason);
                        return { ok: false, error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
                    }
                    return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                        protocolVersion: 1, projection: answer.projection,
                        ...(answer.composerSurfaceCatalog ? { composerSurfaceCatalog: answer.composerSurfaceCatalog } : {}),
                        ...(answer.automationEligibleEvents ? { automationEligibleEvents: answer.automationEligibleEvents } : {}),
                    }) };
                });
            });
            const { createHomeGovernanceHarness } = await import('@/dev/testkit/harness/homeGovernanceHarness');
            homes = createHomeGovernanceHarness();
            await homes.reset();
            const profiles = seam.serverProfiles ?? PICKER_PROJECTION_SEAM_SERVER_PROFILES;
            const profile = profiles[0];
            if (!profile) throw new Error('Picker projection requires a real Home');
            // Preserve retained device route ids, including pre-identity Home profiles.
            await seedPersistedHomeProfilesForTests({ activeServerId: profile.id,
                profiles: profiles.map(candidate => ({ id: candidate.id, name: candidate.id,
                    serverUrl: candidate.serverUrl,
                    serverIdentityId: normalizeServerIdentityIdCapability(candidate.id) ?? undefined,
                    createdAt: 1, updatedAt: 1, lastUsedAt: 1, source: 'manual' })),
            });
            for (const profile of profiles) {
                await homes.addHome({ name: ('name' in profile ? profile.name : undefined) ?? profile.id, serverUrl: profile.serverUrl,
                    serverIdentityId: normalizeServerIdentityIdCapability(profile.id) ?? undefined,
                    accountId: `account:${profile.id}`, active: false });
            }
            await restoreHome(profile.id);
        }
        const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        clearDaemonMergedProjectionCacheForTests();
        machineRpcRequests.length = 0;
    });
    afterEach(async () => {
        await account?.dispose();
        account = undefined;
        await homes?.reset();
        homes = undefined;
        const { clearBrowserRecords } = await import('@/sync/domains/state/browserRecordStorage');
        await clearBrowserRecords();
    });

    // IndexedDB is the browser persistence port; the real Pending owners above it stay live.
    vi.doMock('@/sync/domains/state/browserRecordStorage', async () =>
        (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

    vi.doMock('@/utils/sessions/tempDataStore', async (importOriginal) => {
        const original = await importOriginal<TempDataStoreModule>();
        return {
            ...original,
            ...pickerCommonModuleMocksState.options.tempDataStore,
        };
    });

    vi.doMock('@/text', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.doMock('react-native', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.doMock('expo-router', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.expoRouter) {
            return await activeOptions.expoRouter();
        }
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.doMock('@react-navigation/native', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.reactNavigationNative) {
            return await activeOptions.reactNavigationNative();
        }

        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        return createReactNavigationNativeMock();
    });

    vi.doMock('@expo/vector-icons', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.vectorIcons) {
            return await activeOptions.vectorIcons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.doMock('react-native-typography', async () => {
        const { createReactNativeTypographyMock } = await import('@/dev/testkit/mocks/reactNativeTypography');
        return createReactNativeTypographyMock();
    });

    vi.doMock('@/components/ui/lists/ItemList', async (importOriginal) => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.itemList) {
            return await activeOptions.itemList();
        }

        return await importOriginal();
    });

    vi.doMock('react-native-unistyles', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.doMock('@/modal', async () => {
        const activeOptions = pickerCommonModuleMocksState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    if (options.storage) {
        vi.doMock('@/sync/domains/state/storage', async (importOriginal) => {
            const storageFactory = pickerCommonModuleMocksState.options.storage;
            if (!storageFactory) throw new Error('Picker storage boundary configuration unavailable');
            return await storageFactory(importOriginal);
        });
    }

    return {
        restoreHome,
        get homeBoundary() {
            if (!homes) throw new Error('Picker Home has not been restored');
            return homes;
        },
        get accountScope() {
            if (!account) throw new Error('Picker Account has not been restored');
            return { serverId: account.serverId, accountId: `account:${account.serverId}` };
        },
        get machineRpcRequests() {
            return machineRpcRequests;
        },
        get homeRequests() {
            if (!homes) throw new Error('Picker Home has not been restored');
            return homes.requests;
        },
    };
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
 * A retained configured ACP route input. Current picker writes normalize it
 * to the Custom ACP Agent contribution plus its exact definition id.
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

export function createConfiguredAgentRouteParams(definitionId: string) {
    return {
        backendTarget: JSON.stringify({ kind: 'agent',
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId }),
        backendTargetKey: `agent:happier.agent.custom-acp/custom-acp:definition:${definitionId}`,
    } as const;
}

/**
 * The `acpCatalogSettingsV1` entry a suite stores to make a configured backend
 * id resolvable (or, by omission, stale) for `resolvePreferredBackendTarget`.
 */
export function createConfiguredAcpBackendCatalogSettings(configuredBackendId: string): AcpCatalogSettingsV1 {
    return {
        v: 2,
        backends: [AcpBackendDefinitionV1Schema.parse({
            id: configuredBackendId,
            name: configuredBackendId,
            title: 'Review Bot',
            launch: { kind: 'command', command: configuredBackendId, args: [] },
            env: {},
            capabilities: {
                supportsLoadSession: false,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
            },
            createdAt: 1,
            updatedAt: 1,
        })],
    };
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
 * The qualified Review Bot Agent a plugin case adds to
 * `createSupportedClaudeProjection`. The projection proves the contribution
 * is installed, and its `externalSessions` block makes the real browse
 * resolver pick that Agent over the bundled one.
 */
export function createReviewBotPluginProjectionContributions() {
    return {
        additionalAgentsById: {
            'acme.review-bot/review-bot': {
                id: 'acme.review-bot/review-bot',
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

/** Seed each real owner at the picker fixture boundary. */
export async function applyPickerFixtureSettings(delta: Partial<Settings>): Promise<void> {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const { rememberLastUsedBackendSelection } = await import('@/sync/domains/state/newSessionTargetUiState');
    rememberLastUsedBackendSelection(storage.getState().settingsScope, settingsParse({ ...storage.getState().settings, ...delta }));
    storage.getState().applySettingsLocal(delta);
}
