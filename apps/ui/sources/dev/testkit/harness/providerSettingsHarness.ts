import {
    ProviderConnectionIdSchema,
    createProviderErrorV1,
} from '@happier-dev/protocol';
import {
    DaemonProviderConnectionViewV1Schema,
    DaemonProviderConnectionMutationResponseV1Schema,
    DaemonProviderConnectionsDescribeResponseV1Schema,
    DaemonProviderModelLoadResponseV1Schema,
    DaemonProviderModelProjectionResponseV1Schema,
    DaemonProviderModelProjectionGroupV1Schema,
    DaemonProviderModelSettingsMutationResponseV1Schema,
    DaemonProviderModelsResponseV1Schema,
    DaemonProviderProbeResponseV1Schema,
    RPC_METHODS,
    type DaemonProviderConnectionMutationResponseV1,
    type DaemonProviderConnectionsDescribeResponseV1,
    type DaemonProviderConnectionViewV1,
    type DaemonProviderModelLoadResponseV1,
    type DaemonProviderModelProjectionGroupV1,
    type DaemonProviderModelProjectionResponseV1,
    type DaemonProviderModelSettingsMutationResponseV1,
    type DaemonProviderModelsResponseV1,
    type DaemonProviderProbeResponseV1,
} from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { vi } from 'vitest';
// IndexedDB is the genuine browser persistence leaf; record transactions and Sync stay real.
import 'fake-indexeddb/auto';
import { ActionsSettingsV1Schema, type ActionSettingsActionId } from '@happier-dev/protocol/actions/actionSettings';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture } from '../fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance, type AddHomeOptions } from './homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from './serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from './syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

type ProviderRpcResponse =
    | ReturnType<typeof DaemonContributionRegistryProjectionDescribeResponseSchema.parse>
    | DaemonProviderConnectionsDescribeResponseV1
    | DaemonProviderConnectionMutationResponseV1
    | DaemonProviderProbeResponseV1
    | DaemonProviderModelsResponseV1
    | DaemonProviderModelProjectionResponseV1
    | DaemonProviderModelSettingsMutationResponseV1
    | DaemonProviderModelLoadResponseV1;

export type ProviderRpcRequest = Readonly<{
    machineId: string;
    /** Present on the real Action-to-RPC dispatch, including same-Home Account switches. */
    accountId?: string;
    serverId: string | null;
    method: string;
    payload: unknown;
}>;

type ProviderRpcNext = () => Promise<ProviderRpcResponse>;
type ProviderRpcInterceptor = (
    request: ProviderRpcRequest,
    next: ProviderRpcNext,
) => unknown | Promise<unknown>;

type ProviderRpcResponseByMethod = Readonly<Record<string, ProviderRpcResponse>>;

const installedProviderSettingsHarness = vi.hoisted(() => ({
    current: null as ProviderSettingsHarness | null,
}));

function createDefaultConnection(): DaemonProviderConnectionViewV1 {
    return {
        connectionId: ProviderConnectionIdSchema.parse('pc_a'),
        contributionKey: 'acme.plugin/acme',
        provenance: 'first_party',
        displayName: 'Acme',
        providerName: 'Acme',
        icon: null,
        role: 'default',
        displayNameMode: 'automatic',
        sourceStatus: 'available',
        probeCapability: 'catalog',
        manualModelPolicy: 'allowed',
        compatibility: [],
        grants: {
            accountEnabled: true,
            enabledMachineIds: [],
            accountState: 'valid',
            machineState: 'absent',
            effectiveState: 'valid',
        },
        credential: null,
        teamCredentialSourceOffer: null,
        deployment: { kind: 'external' },
        managedLocalOption: null,
        endpoints: [],
        scope: 'account',
        authorized: true,
        authorizationError: null,
        revision: 1,
        probeObservationIdentity: null,
        runtime: {
            health: 'available',
            modelCount: 1,
            checkedAt: 1,
            endpoints: [],
        },
    };
}

export function createProviderConnectionViewFixture(
    overrides: Omit<Partial<DaemonProviderConnectionViewV1>, 'connectionId'> & { connectionId?: string } = {},
): DaemonProviderConnectionViewV1 {
    return DaemonProviderConnectionViewV1Schema.parse({
        ...createDefaultConnection(),
        ...overrides,
        grants: {
            ...createDefaultConnection().grants,
            ...overrides.grants,
        },
        runtime: {
            ...createDefaultConnection().runtime,
            ...overrides.runtime,
        },
    });
}

export function createProviderConnectionsDescribeFixture(input: Readonly<{
    connections?: readonly DaemonProviderConnectionViewV1[];
    available?: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>['available'];
    discoveryCandidates?: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>['discoveryCandidates'];
    localInstallations?: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>['localInstallations'];
    authoringPreview?: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>['authoringPreview'];
}> = {}): Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }> {
    return DaemonProviderConnectionsDescribeResponseV1Schema.parse({
        status: 'success',
        connections: input.connections ?? [createProviderConnectionViewFixture()],
        available: input.available ?? [],
        discoveryCandidates: input.discoveryCandidates ?? [],
        discoveryCandidatesTruncated: false,
        localInstallations: input.localInstallations ?? [],
        diagnosticsTruncated: false,
        diagnostics: [],
        availableTruncated: false,
        ...(input.authoringPreview ? { authoringPreview: input.authoringPreview } : {}),
    }) as Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;
}

export function createProviderModelsFixture(input: Readonly<{
    connectionId?: string;
    connectionRevision?: number;
    models?: Extract<DaemonProviderModelsResponseV1, { status: 'success' }>['models'];
    manualModelPolicy?: 'allowed' | 'catalog-only';
    modelLoadAction?: 'available' | 'descriptor_absent' | 'feature_disabled';
}> = {}): Extract<DaemonProviderModelsResponseV1, { status: 'success' }> {
    return DaemonProviderModelsResponseV1Schema.parse({
        status: 'success',
        connectionId: input.connectionId ?? 'pc_a',
        connectionRevision: input.connectionRevision ?? 1,
        manualModelPolicy: input.manualModelPolicy ?? 'allowed',
        modelLoadAction: input.modelLoadAction ?? 'descriptor_absent',
        models: input.models ?? [{
            id: 'model-a',
            name: 'Model A',
            source: 'static',
            stale: false,
            loadState: 'loaded',
            visibility: 'visible',
        }],
    }) as Extract<DaemonProviderModelsResponseV1, { status: 'success' }>;
}

export function createProviderModelProjectionGroupFixture(
    overrides: Omit<Partial<DaemonProviderModelProjectionGroupV1>, 'connectionId' | 'rows'> & {
        connectionId?: string;
        rows?: readonly unknown[];
    } = {},
): DaemonProviderModelProjectionGroupV1 {
    return DaemonProviderModelProjectionGroupV1Schema.parse({
        connectionId: ProviderConnectionIdSchema.parse('pc_a'),
        providerName: 'Acme',
        connectionName: 'Acme',
        connectionRole: 'default',
        connectionDisplayNameMode: 'automatic',
        connectionRevision: 1,
        modelLoadAction: 'descriptor_absent',
        authorization: { authorized: true },
        manualModelPolicy: 'allowed',
        supportsFreeformModelIds: true,
        suppressedConnectedServiceIds: [],
        rows: [],
        ...overrides,
    });
}

export function createProviderModelProjectionFixture(input: Readonly<{
    agentTargetKey?: string;
    groups?: readonly DaemonProviderModelProjectionGroupV1[];
}> = {}): Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }> {
    return DaemonProviderModelProjectionResponseV1Schema.parse({
        status: 'success',
        agentTargetKey: input.agentTargetKey ?? 'backend:codex',
        groups: input.groups ?? [createProviderModelProjectionGroupFixture()],
        currentSelectionRecovery: null,
    }) as Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }>;
}

function defaultResponses(): ProviderRpcResponseByMethod {
    return {
        [RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE]: createProviderConnectionsDescribeFixture(),
        [RPC_METHODS.DAEMON_PROVIDERS_PROBE]: DaemonProviderProbeResponseV1Schema.parse({
            status: 'success', models: [], requestFingerprint: 'probe-request:v1:test',
        }),
        [RPC_METHODS.DAEMON_PROVIDERS_MODELS]: createProviderModelsFixture(),
        [RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION]: createProviderModelProjectionFixture(),
        [RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD]: DaemonProviderModelLoadResponseV1Schema.parse({
            status: 'not_supported', reason: 'descriptor_absent',
        }),
        [RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE]: DaemonProviderModelSettingsMutationResponseV1Schema.parse({
            status: 'success', action: 'setVisibility',
        }),
        [RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE]: DaemonProviderConnectionMutationResponseV1Schema.parse({
            status: 'success', action: 'setEnabled', connection: createProviderConnectionViewFixture(),
        }),
    };
}

function parseResponse(method: string, response: unknown): ProviderRpcResponse {
    switch (method) {
        case RPC_METHODS.DAEMON_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE:
            return DaemonContributionRegistryProjectionDescribeResponseSchema.parse(response);
        case RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE:
            return DaemonProviderConnectionsDescribeResponseV1Schema.parse(response);
        case RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE:
            return DaemonProviderConnectionMutationResponseV1Schema.parse(response);
        case RPC_METHODS.DAEMON_PROVIDERS_PROBE:
            return DaemonProviderProbeResponseV1Schema.parse(response);
        case RPC_METHODS.DAEMON_PROVIDERS_MODELS:
            return DaemonProviderModelsResponseV1Schema.parse(response);
        case RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION:
            return DaemonProviderModelProjectionResponseV1Schema.parse(response);
        case RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE:
            return DaemonProviderModelSettingsMutationResponseV1Schema.parse(response);
        case RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD:
            return DaemonProviderModelLoadResponseV1Schema.parse(response);
        default:
            throw new Error(`Unexpected Provider RPC method: ${method}`);
    }
}

function connectionMutationResponse(payload: unknown): DaemonProviderConnectionMutationResponseV1 {
    const request = payload as Readonly<{
        action?: string;
        connectionId?: string;
        newConnectionId?: string;
        contributionKey?: string;
    }>;
    if (request.action === 'delete') {
        return {
            status: 'success',
            action: 'delete',
            deletedConnectionId: ProviderConnectionIdSchema.parse(request.connectionId ?? 'pc_a'),
        };
    }
    if (request.action === 'startLocal') {
        return {
            status: 'success',
            action: 'startLocal',
            contributionKey: request.contributionKey ?? 'acme.plugin/acme',
            phase: 'detecting',
        };
    }
    const action = request.action;
    if (action === 'createContribution' || action === 'createCustom' || action === 'enableDetected'
        || action === 'update' || action === 'setEndpointOverride' || action === 'duplicate'
        || action === 'setEnabled' || action === 'bindSecret') {
        const connectionId = action === 'duplicate'
            ? request.newConnectionId
            : request.connectionId;
        return {
            status: 'success',
            action,
            connection: createProviderConnectionViewFixture({ connectionId: connectionId ?? 'pc_a' }),
        };
    }
    return { status: 'error', error: createProviderErrorV1('provider_connection_invalid') };
}

function modelSettingsMutationResponse(payload: unknown): DaemonProviderModelSettingsMutationResponseV1 {
    const action = (payload as Readonly<{ action?: string }>).action;
    if (action === 'manualAdd' || action === 'manualRemove' || action === 'setVisibility'
        || action === 'resetVisibility' || action === 'bulkVisibility' || action === 'confirmExperimental') {
        return { status: 'success', action };
    }
    return { status: 'error', error: createProviderErrorV1('provider_connection_invalid') };
}

export type ProviderSettingsHarness = ReturnType<typeof createProviderSettingsHarness>;

export function createProviderSettingsHarness(options: Readonly<{
    serverId?: string;
    machines?: readonly Machine[];
    settings?: unknown;
}> = {}) {
    const machine = createMachineFixture({
        id: 'machine-a',
        activeAt: Date.now(),
        metadata: {
            displayName: 'Mac',
            host: 'mac.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy-dev',
            homeDir: '/Users/tester',
        },
    });
    const state = {
        machines: [...(options.machines ?? [machine])],
        settings: (options.settings ?? { schemaVersion: 7 }) as unknown,
        responses: { ...defaultResponses() } as Record<string, ProviderRpcResponse>,
        queues: new Map<string, ProviderRpcResponse[]>(),
        interceptors: new Map<string, ProviderRpcInterceptor>(),
        requests: [] as ProviderRpcRequest[],
    };

    const harness = {
        state,
        setResponse(method: string, response: ProviderRpcResponse) {
            state.responses[method] = parseResponse(method, response);
        },
        enqueueResponse(method: string, response: ProviderRpcResponse) {
            const queue = state.queues.get(method) ?? [];
            queue.push(parseResponse(method, response));
            state.queues.set(method, queue);
        },
        intercept(method: string, interceptor: ProviderRpcInterceptor) {
            state.interceptors.set(method, interceptor);
        },
        reset() {
            state.responses = { ...defaultResponses() };
            state.queues.clear();
            state.interceptors.clear();
            state.requests.length = 0;
            state.machines = [...(options.machines ?? [{ ...machine, activeAt: Date.now() }])];
            state.settings = options.settings ?? { schemaVersion: 7 };
        },
        async machineRpc(input: ProviderRpcRequest): Promise<ProviderRpcResponse> {
            state.requests.push(input);
            const next = async (): Promise<ProviderRpcResponse> => {
                const queued = state.queues.get(input.method)?.shift();
                if (queued) return queued;
                if (input.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE) {
                    return connectionMutationResponse(input.payload);
                }
                if (input.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE) {
                    return modelSettingsMutationResponse(input.payload);
                }
                const response = state.responses[input.method];
                if (!response) throw new Error(`No Provider test response for ${input.method}`);
                return response;
            };
            const interceptor = state.interceptors.get(input.method);
            const response = interceptor ? await interceptor(input, next) : await next();
            return parseResponse(input.method, response);
        },
    };
    return harness;
}

export function installProviderSettingsRpcBoundary(harness: ProviderSettingsHarness): void {
    installedProviderSettingsHarness.current = harness;
    vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
        machineRpcWithServerScope: (input: ProviderRpcRequest) => {
            const current = installedProviderSettingsHarness.current;
            if (!current) throw new Error('Provider settings test harness is not installed');
            return current.machineRpc(input);
        },
    }));
}

/** Account admission, row publication and retirement stay real; only Home HTTP and Socket transport are substituted. */
export function createProviderSettingsAccountHarness() {
    const home = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(home);
    installDisconnectedServerSocketBoundary();
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
    const serverUrl = 'https://provider-settings-account.test';
    let serverId = '';
    const defaultFeatures = () => createRootLayoutFeaturesResponse({ features: {
        providers: { enabled: true, localDiscovery: { enabled: true }, localModelManagement: { enabled: true } },
    } });
    async function publishFeatures(targetServerId: string, features: ReturnType<typeof createRootLayoutFeaturesResponse>) {
        home.answer(targetServerId, '/v1/features', { body: features });
        home.answer(targetServerId, '/v1/features/authenticated', { body: features });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: targetServerId, snapshot: { status: 'ready', features } });
    }
    async function publishMachines(targetServerId: string, machines: readonly Machine[]) {
        const [{ storage }, { fetchAndApplyMachines }, profiles] = await Promise.all([
            import('@/sync/domains/state/storage'),
            import('@/sync/engine/machines/syncMachines'),
            import('@/sync/domains/server/serverProfiles'),
        ]);
        const profile = profiles.getServerProfileById(profiles.resolveServerProfileScopeIdForIdentifier(targetServerId));
        const homeRecord = profile ? home.findByServerUrl(profile.serverUrl) : null;
        if (!homeRecord?.token) throw new Error('Provider Machine publication requires a credentialed Home');
        home.answer(targetServerId, '/v1/machines', { body: machines.map(machine => ({
            ...machine, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, storageMode: 'plain',
            metadata: encodePlainMachineStoredContent(machine.metadata),
            daemonState: encodePlainMachineStoredContent(machine.daemonState),
        })) });
        await fetchAndApplyMachines({ credentials: { token: homeRecord.token }, expectedAccountMode: 'plain', encryption: null,
            // This fixture publishes a complete HTTP census, including an authoritative empty list.
            machineDataKeys: new Map(), sourceServerId: targetServerId, throwOnError: true, replace: true,
            request: (path, init) => home.request(new URL(path, homeRecord.serverUrl), init),
            applyMachines: (rows, replace) => storage.getState().applyMachines(rows, replace, { sourceServerId: targetServerId }),
        });
    }
    async function selectMachine(targetServerId: string, machineId: string | null, selectionKey?: string) {
        const [{ storage }, { getSyncSingleton }, profiles, preferences] = await Promise.all([
            import('@/sync/domains/state/storage'),
            import('@/sync/runtime/getSyncSingleton'),
            import('@/sync/domains/server/serverProfiles'),
            import('@/sync/domains/machines/administration/selectionPreferences'),
        ]);
        const current = storage.getState();
        const key = selectionKey ?? preferences.MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.providers;
        const profile = profiles.getServerProfileById(profiles.resolveServerProfileScopeIdForIdentifier(targetServerId));
        if (machineId !== null && !profile?.serverIdentityId) {
            throw new Error('Provider Machine selection requires a Home-published portable identity');
        }
        const targets = machineId === null
            ? preferences.clearMachineAdministrationTargetPreference(current.settings.machineAdministrationTargetsLocalV1, key)
            : preferences.setMachineAdministrationTargetPreference(current.settings.machineAdministrationTargetsLocalV1, key, {
                serverIdentityId: profile!.serverIdentityId!, machineId,
            });
        getSyncSingleton().applySettings({ machineAdministrationTargetsLocalV1: targets }, {
            expectedSettingsScope: current.settingsScope, source: 'ui',
        });
    }
    return {
        home,
        get serverId() { return serverId; },
        publishFeatures,
        publishMachines,
        selectMachine,
        async addHome(options: AddHomeOptions & Readonly<{ features?: ReturnType<typeof createRootLayoutFeaturesResponse> }>) {
            const targetServerId = await home.addHome(options);
            await publishFeatures(targetServerId, options.features ?? defaultFeatures());
            return targetServerId;
        },
        async restore(options: Readonly<{
            accountId?: string;
            serverIdentityId?: string;
            settings?: Readonly<Record<string, unknown>>;
            catalog?: ProviderConnectionsCatalogV1;
            waivedActions?: readonly ActionSettingsActionId[];
            machines?: readonly Machine[];
            features?: ReturnType<typeof createRootLayoutFeaturesResponse>;
            /** Explicit synthetic E2EE Account fixture, not a key-presence mode decision. */
            e2eeSecret?: Uint8Array;
        }> = {}) {
            installHomeGovernanceBoundaries(home);
            await loadSyncSingletonForTests();
            await connection?.dispose();
            const accountId = options.accountId ?? 'account-a';
            if (!serverId) serverId = await home.addHome({ name: 'Provider settings', serverUrl, accountId,
                serverIdentityId: options.serverIdentityId });
            else await home.switchAccount(serverId, accountId);
            await publishFeatures(serverId, options.features ?? defaultFeatures());
            let credentials: import('@/auth/storage/tokenStorage').AuthCredentials | undefined;
            const secret = options.e2eeSecret;
            if (secret) {
                const [{ encodeBase64 }, { createAccountScopedCryptoMaterialSnapshotV1 },
                    { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 }] = await Promise.all([
                    import('@/encryption/base64'), import('@happier-dev/protocol/crypto/accountScopedCipher'),
                    import('@happier-dev/protocol/account/encryptionKeyFingerprintV1'),
                ]);
                credentials = { token: home.findByServerUrl(serverUrl)!.token!, secret: encodeBase64(secret, 'base64url') };
                const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
                        material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
                home.answer(serverId, '/v1/account/encryption', { body: { mode: 'e2ee', updatedAt: 1 } });
                home.answer(serverId, '/v1/account/encryption/currentness', { body: {
                    mode: 'e2ee', version: 1, signingKeyFingerprint: 'provider-fixture-signing', contentKeyFingerprint: fingerprint,
                    updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
                } });
            } else {
                home.answer(serverId, '/v1/account/encryption', { body: { mode: 'plain', updatedAt: 1 } });
                home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
            }
            const { profileDefaults } = await import('@/sync/domains/profiles/profile');
            home.answer(serverId, '/v1/account/profile', { body: { ...profileDefaults, id: accountId } });
            const settings = { ...options.settings,
                ...(options.waivedActions ? { actionsSettingsV1: ActionsSettingsV1Schema.parse({
                    v: 1, actions: {}, approvalWaivedSurfaces: Object.fromEntries(options.waivedActions.map(id => [id, ['ui']])),
                }) } : {}),
            };
            const encryption = secret ? await (await import('@/sync/encryption/encryption')).Encryption.create(secret) : null;
            const settingsContent = encryption ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                kind: 'account_settings', material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() }, payload: settings,
                // Synthetic boundary fixture only; no production keys or private data are used.
                randomBytes: length => new Uint8Array(length).fill(17),
            }) }
                : { t: 'plain', v: settings };
            if (secret) home.answer(serverId, PROJECT_ACCOUNT_ROWS_ROUTE_V1, { body:
                ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }),
            });
            const catalog = options.catalog ?? DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
            const catalogContent = secret ? (await import('@happier-dev/protocol/providers/connections/connectionRowsV1'))
                .sealProviderConnectionsContentV1({ mode: 'e2ee', material: { type: 'legacy', secret }, catalog })
                : { t: 'plain', v: catalog };
            home.answer(serverId, '/v2/account/settings', { body: { version: 1, content: settingsContent } });
            home.answer(serverId, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { body: {
                status: 'present', revision: 1, content: catalogContent,
            } });
            home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
            if (options.machines) await publishMachines(serverId, options.machines);
            connection = await restoreServerAccountForTest({ serverUrl, accountId, request: home.request, credentials });
            // The connection helper mounts one Home; credential lookups for a
            // foreign Provider target must still answer for that exact Home.
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async url => {
                const token = home.findByServerUrl(url)?.token;
                if (!token) return null;
                return credentials && url === serverUrl ? credentials : { token };
            });
            const { storage } = await import('@/sync/domains/state/storage');
            await waitForHomeGovernance(() => {
                const scope = storage.getState().profileScope;
                if (scope?.accountId !== accountId) throw new Error('Provider fixture Account is not mounted');
            });
            if (options.machines) {
                await waitForHomeGovernance(() => {
                    if (!storage.getState().isDataReady) throw new Error('Provider fixture Sync bootstrap is not ready');
                });
                await publishMachines(serverId, options.machines);
            }
            return { serverId, accountId };
        },
        async reset() {
            await connection?.dispose();
            connection = null;
            const [{ resetSavedSecretCatalogEngineForTests }, { resetSavedSecretCatalogSnapshotsForTests },
                { resetProviderCatalogEngineForTests }, { resetProviderCatalogSnapshotsForTests }] = await Promise.all([
                import('@/sync/engine/settings/savedSecretCatalogEngine'),
                import('@/sync/store/settings/savedSecretCatalogSnapshot'),
                import('@/sync/engine/settings/providerCatalogEngine'),
                import('@/sync/store/settings/providerCatalogSnapshot'),
            ]);
            resetSavedSecretCatalogEngineForTests();
            resetSavedSecretCatalogSnapshotsForTests();
            resetProviderCatalogEngineForTests();
            resetProviderCatalogSnapshotsForTests();
            const { clearBrowserRecords } = await import('@/sync/domains/state/browserRecordStorage');
            await clearBrowserRecords();
            await home.reset();
            serverId = '';
        },
    };
}
