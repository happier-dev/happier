import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import {
    DaemonProviderConnectionViewV1Schema,
    DaemonProviderConnectionMutationResponseV1Schema,
    DaemonProviderBindingStatusResponseV1Schema,
    DaemonProviderConnectionsDescribeResponseV1Schema,
    DaemonProviderModelLoadResponseV1Schema,
    DaemonProviderModelProjectionResponseV1Schema,
    DaemonProviderModelProjectionGroupV1Schema,
    DaemonProviderModelSettingsMutationResponseV1Schema,
    DaemonProviderModelsResponseV1Schema,
    DaemonProviderProbeResponseV1Schema,
    DaemonProviderProfileMigrationPreviewResponseV1Schema,
    DaemonProviderProfileMigrationConfirmResponseV1Schema,
    DaemonProviderProfileMigrationConflictConfirmResponseV1Schema,
    RPC_METHODS,
    type DaemonProviderConnectionMutationResponseV1,
    type DaemonProviderBindingStatusResponseV1,
    type DaemonProviderConnectionsDescribeResponseV1,
    type DaemonProviderConnectionViewV1,
    type DaemonProviderModelLoadResponseV1,
    type DaemonProviderModelProjectionGroupV1,
    type DaemonProviderModelProjectionResponseV1,
    type DaemonProviderModelSettingsMutationResponseV1,
    type DaemonProviderModelsResponseV1,
    type DaemonProviderProbeResponseV1,
    type DaemonProviderProfileMigrationPreviewResponseV1,
    type DaemonProviderProfileMigrationConfirmResponseV1,
    type DaemonProviderProfileMigrationConflictConfirmResponseV1,
} from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { vi } from 'vitest';
import { createSessionReadBatchFetchBoundary } from './sessionReadBatchHttpBoundary';
import type { Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
// IndexedDB is the genuine browser persistence leaf; record transactions and Sync stay real.
import 'fake-indexeddb/auto';
import { ActionsSettingsV1Schema, type ActionSettingsActionId } from '@happier-dev/protocol/actions/actionSettings';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '../fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '../fixtures/accountBootstrapHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance, type AddHomeOptions, type HomeGovernanceHarness, type HomeDomainAnswer } from './homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from './serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from './syncSingletonLoader';
import { createAccountSettingsHttpBoundary } from './actionHomesHttpHarness';
import { createSessionMetadataHttpBoundary } from './sessionMetadataHttpBoundary';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsRowMutationV1Schema, ProviderConnectionsRowMutationResponseV1Schema,
    type ProviderConnectionsCatalogV1, type ProviderConnectionsContentV1,
    type ProviderConnectionsRowMutationV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { parseToken } from '@/utils/auth/parseToken';
import { listServerProfiles, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';

/** Stateful Home HTTP leaf; Account semantics, encryption, CAS and receipt classification stay real. */
export function installProviderConnectionsCatalogHttpBoundary(input: Readonly<{
    home: HomeGovernanceHarness;
    serverId: string;
    catalog: ProviderConnectionsCatalogV1;
    reply?: (mutation: ReturnType<typeof ProviderConnectionsRowMutationV1Schema.parse>) => HomeDomainAnswer;
}>) {
    let catalog = input.catalog;
    let revision = 1;
    let writes = 0;
    input.home.answer(input.serverId, '/v1/account/encryption/currentness', {
        body: createPlainAccountEncryptionCurrentnessFixture(),
    });
    input.home.answer(input.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
        select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
    });
    input.home.answer(input.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
        select: value => {
            const mutation = ProviderConnectionsRowMutationV1Schema.parse(value);
            if (mutation.expectedRevision !== revision) return { body: { status: 'conflict', revision } };
            if (mutation.content?.t !== 'plain') throw new Error('Expected a keyless Plain Account catalog write');
            catalog = mutation.content.v;
            revision += 1;
            writes += 1;
            return input.reply?.(mutation) ?? { body: { status: 'updated', revision, cursor: revision } };
        },
    });
    return { get catalog(): ProviderConnectionsCatalogV1 { return catalog; }, get revision() { return revision; }, get writes() { return writes; } };
}

type ProviderRpcResponse =
    | ReturnType<typeof DaemonContributionRegistryProjectionDescribeResponseSchema.parse>
    | DaemonProviderConnectionsDescribeResponseV1
    | DaemonProviderConnectionMutationResponseV1
    | DaemonProviderBindingStatusResponseV1
    | DaemonProviderProbeResponseV1
    | DaemonProviderModelsResponseV1
    | DaemonProviderModelProjectionResponseV1
    | DaemonProviderModelSettingsMutationResponseV1
    | DaemonProviderModelLoadResponseV1
    | DaemonProviderProfileMigrationPreviewResponseV1
    | DaemonProviderProfileMigrationConfirmResponseV1
    | DaemonProviderProfileMigrationConflictConfirmResponseV1;

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
type ProviderRpcAcknowledgementTransformer = (
    request: ProviderRpcRequest,
    acknowledgement: Readonly<{ ok: true; result: unknown }>,
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
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
}> = {}): Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }> {
    return DaemonProviderModelProjectionResponseV1Schema.parse({
        status: 'success',
        agentTargetKey: input.agentTargetKey ?? 'backend:codex',
        groups: input.groups ?? [createProviderModelProjectionGroupFixture()],
        currentSelectionRecovery: null,
        ...(input.teamCredentialResources ? { teamCredentialResources: input.teamCredentialResources } : {}),
    }) as Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }>;
}

/**
 * An experimental personal source projected by the selected worker, before any Account confirmation.
 */
export function createExperimentalProviderModelProjectionFixture(input: Readonly<{
    agentTargetKey: string;
    modelId: string;
    modelName?: string;
    confirmationSource?: Readonly<{ connectionId: string; catalogSourceKey: string }>;
}>): Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }> {
    const confirmationSource = input.confirmationSource
        ?? { connectionId: 'connected-source:recipient', catalogSourceKey: 's'.repeat(43) };
    return createProviderModelProjectionFixture({ agentTargetKey: input.agentTargetKey,
        groups: [createProviderModelProjectionGroupFixture({ connectionId: confirmationSource.connectionId,
            connectionRevision: 0, rows: [{
                ref: { agentTargetKey: input.agentTargetKey, providerConnectionId: confirmationSource.connectionId, modelId: input.modelId },
                descriptor: { id: input.modelId, name: input.modelName ?? input.modelId }, confirmationSource,
                sources: { manual: false, static: false, probe: false }, confidence: 'account_unverified',
                compatibility: { result: { status: 'experimental', reasons: ['compatibility_evidence_missing'],
                    selectedProtocol: 'openai-responses', confirmationScope: { kind: 'model', modelId: input.modelId } },
                    compatibilityFingerprint: 'compatibility:v1:worker', confirmed: false },
                endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
            }] })] });
}

function defaultResponses(): ProviderRpcResponseByMethod {
    return {
        [RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS]: DaemonProviderBindingStatusResponseV1Schema.parse({ status: 'current' }),
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
        case RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS:
            return DaemonProviderBindingStatusResponseV1Schema.parse(response);
        case RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE:
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
        case RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW:
            return DaemonProviderProfileMigrationPreviewResponseV1Schema.parse(response);
        case RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM:
            return DaemonProviderProfileMigrationConfirmResponseV1Schema.parse(response);
        case RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFLICT_CONFIRM:
            return DaemonProviderProfileMigrationConflictConfirmResponseV1Schema.parse(response);
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
        acknowledgementTransformers: new Map<string, ProviderRpcAcknowledgementTransformer>(),
        requests: [] as ProviderRpcRequest[],
    };
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of listeners) listener(); };

    const harness = {
        state,
        /** Physical daemon RPC admission and response settlement. */
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
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
        /** Corrupt a received wire ACK only after the valid typed handler and request capture. */
        transformAcknowledgement(method: string, transformer: ProviderRpcAcknowledgementTransformer) {
            state.acknowledgementTransformers.set(method, transformer);
        },
        reset() {
            state.responses = { ...defaultResponses() };
            state.queues.clear();
            state.interceptors.clear();
            state.acknowledgementTransformers.clear();
            state.requests.length = 0;
            state.machines = [...(options.machines ?? [{ ...machine, activeAt: Date.now() }])];
            state.settings = options.settings ?? { schemaVersion: 7 };
        },
        async machineRpc(input: ProviderRpcRequest): Promise<ProviderRpcResponse> {
            state.requests.push(input);
            notify();
            try {
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
            } finally { notify(); }
        },
    };
    return harness;
}

export function installProviderSettingsRpcBoundary(harness: ProviderSettingsHarness): void {
    installedProviderSettingsHarness.current = harness;
    installDisconnectedServerSocketBoundary(configureProviderSettingsSocket);
}

/** A fixture Machine admits the real bundled declarations, not a mocked classifier/writer. */
export function installBundledProviderDeclarationsRpcBoundary(harness: ProviderSettingsHarness): void {
    harness.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async () => {
        const { readAccountProviderDeclarations } = await import('@/providers/catalog/accountProviderDeclarations');
        const { BUNDLED_CANONICAL_AGENT_DECLARATIONS } = await import('@/agents/registry/generatedBundledPluginEntries');
        return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projection: { v: 2, generation: 1,
                agentsById: Object.fromEntries(Object.entries(BUNDLED_CANONICAL_AGENT_DECLARATIONS).flatMap(([id, declaration]) =>
                    declaration ? [[id, { id, identity: declaration.identity,
                        ...(declaration.providerRequirements ? { providerRequirements: declaration.providerRequirements } : {}),
                    }]] : [])),
                familiesById: { providers: { family: 'providers',
                entriesById: Object.fromEntries(readAccountProviderDeclarations({ kind: 'account' }).map(row => [
                    row.contributionKey, { id: row.contributionKey,
                        pluginId: row.contributionKey.slice(0, row.contributionKey.indexOf('/')),
                        provenance: row.provenance, sourceKind: 'bundled', definition: row.definition },
                ])),
            } } },
        });
    });
}

function configureProviderSettingsSocket(socket: Socket, serverUrl: string | undefined): void {
    socket.connect = vi.fn<typeof socket.connect>(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event: string, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
            || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Malformed Provider Socket RPC');
        const current = installedProviderSettingsHarness.current;
        if (!current) throw new Error('Provider settings test harness is not installed');
        const profile = listServerProfiles().find(candidate => candidate.serverUrl === serverUrl);
        const auth = socket.auth;
        if (!profile || !auth || typeof auth !== 'object' || typeof auth.token !== 'string') throw new Error('Provider Socket has no credentialed Home');
        const separator = payload.method.indexOf(':');
        if (separator < 1) throw new Error('Provider Socket has no Machine target');
        const request = {
            machineId: payload.method.slice(0, separator), serverId: resolveServerProfileScopeId(profile),
            accountId: parseToken(auth.token), method: payload.method.slice(separator + 1), payload: payload.params,
        };
        const acknowledgement = { ok: true as const, result: await current.machineRpc(request) };
        const transform = current.state.acknowledgementTransformers.get(request.method);
        return transform ? await transform(request, acknowledgement) : acknowledgement;
    });
}

/** Account admission, row publication and retirement stay real; only Home HTTP and Socket transport are substituted. */
export function createProviderSettingsAccountHarness() {
    const home = createHomeGovernanceHarness();
    const sessionReadRequest = createSessionReadBatchFetchBoundary(home.request);
    const bootstrapHome: typeof home = {
        ...home,
        request: async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const requestInit = input instanceof Request && init?.method === undefined
                ? { ...init, method: input.method }
                : init;
            const record = home.findByServerUrl(url.origin);
            const path = `${url.pathname}${url.search}`;
            const method = (requestInit?.method ?? 'GET').toUpperCase();
            // Keep the original leaf's request census and every explicit error/response override.
            const response = await sessionReadRequest(input, requestInit);
            if (!record || record.answers.has(`${method} ${path}`) || record.answers.has(path)
                || record.answers.has(`${method} ${url.pathname}`) || record.answers.has(url.pathname)) return response;
            return createEmptyAccountBootstrapHttpResponse(path, requestInit) ?? response;
        },
    };
    installHomeGovernanceBoundaries(bootstrapHome);
    installDisconnectedServerSocketBoundary(configureProviderSettingsSocket);
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
    const serverUrl = 'https://provider-settings-account.test';
    let serverId = '';
    let catalogRow: { revision: number | null; content: ProviderConnectionsContentV1 | null } | null = null;
    let catalogMutationInterceptor: ((input: ProviderConnectionsRowMutationV1, next: () => HomeDomainAnswer)
        => HomeDomainAnswer | Promise<HomeDomainAnswer>) | null = null;
    const catalogMutations: ProviderConnectionsRowMutationV1[] = [];
    const defaultFeatures = (serverIdentityId?: string) => createRootLayoutFeaturesResponse({ features: {
        providers: { enabled: true, localDiscovery: { enabled: true }, localModelManagement: { enabled: true } },
    }, ...(serverIdentityId ? { capabilities: { serverIdentity: { serverIdentityId } } } : {}) });
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
        const accountId = parseToken(homeRecord.token);
        const machineRows = machines.map(machine => MachinePublishedRowV1Schema.parse({
            ...createPlainMachineRowFixture({ id: machine.id, accountId }),
            ...machine, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, storageMode: 'plain',
            metadata: encodePlainMachineStoredContent(machine.metadata),
            daemonState: encodePlainMachineStoredContent(machine.daemonState),
        }));
        home.answer(targetServerId, '/v1/machines', { body: machineRows });
        home.answer(targetServerId, 'POST /v1/machines/read-batch', {
            select: async input => ({ body: await createMachineReadBatchResponseFixture(input,
                id => machineRows.find(machine => machine.id === id) ?? null).json() }),
        });
        for (const machine of machineRows) home.answer(targetServerId, `/v1/machines/${encodeURIComponent(machine.id)}`, {
            body: { machine },
        });
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
        catalogMutations: catalogMutations as ProviderConnectionsRowMutationV1[],
        readCatalogRow() { return catalogRow; },
        interceptCatalogMutation(interceptor: NonNullable<typeof catalogMutationInterceptor>) {
            catalogMutationInterceptor = interceptor;
        },
        publishFeatures,
        publishMachines,
        selectMachine,
        async addHome(options: AddHomeOptions & Readonly<{ features?: ReturnType<typeof createRootLayoutFeaturesResponse> }>) {
            const targetServerId = await home.addHome(options);
            await publishFeatures(targetServerId, options.features ?? defaultFeatures(options.serverIdentityId));
            // Re-adding a fixture Home must not inherit another case's live
            // Machine census and become the selector's sole candidate.
            await publishMachines(targetServerId, []);
            for (const machine of installedProviderSettingsHarness.current?.state.machines ?? []) {
                home.answer(targetServerId, `/v1/machines/${encodeURIComponent(machine.id)}`, {
                    body: { machine: { id: machine.id, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } },
                });
            }
            return targetServerId;
        },
        async restore(options: Readonly<{
            accountId?: string;
            /** Authenticated ordinary-Account ingress for exact-daemon Action replay. */
            currentAccount?: boolean;
            /** Use the real serialized switch when a staged Home leaves the prior runtime applied. */
            activation?: 'switch';
            serverIdentityId?: string;
            settings?: Readonly<Record<string, unknown>>;
            /** Null serves an absent row before the real catalog observer initializes it. */
            catalog?: ProviderConnectionsCatalogV1 | null;
            waivedActions?: readonly ActionSettingsActionId[];
            machines?: readonly Machine[];
            features?: ReturnType<typeof createRootLayoutFeaturesResponse>;
            /** Explicit synthetic E2EE Account fixture, not a key-presence mode decision. */
            e2eeSecret?: Uint8Array;
        }> = {}) {
            installHomeGovernanceBoundaries(bootstrapHome);
            await loadSyncSingletonForTests();
            await connection?.dispose();
            const accountId = options.accountId ?? 'account-a';
            if (!serverId) serverId = await home.addHome({ name: 'Provider settings', serverUrl, accountId,
                serverIdentityId: options.serverIdentityId, currentAccount: options.currentAccount });
            else await home.switchAccount(serverId, accountId, { currentAccount: options.currentAccount });
            await publishFeatures(serverId, options.features ?? defaultFeatures(options.serverIdentityId));
            let credentials: import('@/auth/storage/tokenStorage').AuthCredentials | undefined;
            if (options.currentAccount) credentials = { token: home.findByServerUrl(serverUrl)!.token! };
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
            const settingsContent = encryption ? { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({
                kind: 'account_settings', material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() }, payload: settings,
                // Synthetic boundary fixture only; no production keys or private data are used.
                randomBytes: length => new Uint8Array(length).fill(17),
            }) }
                : { t: 'plain' as const, v: settings };
            if (secret) home.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body:
                ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }),
            });
            const catalog = options.catalog ?? DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
            const catalogContent = secret ? (await import('@happier-dev/protocol/providers/connections/connectionRowsV1'))
                .sealProviderConnectionsContentV1({ mode: 'e2ee', material: { type: 'legacy', secret }, catalog })
                : { t: 'plain' as const, v: catalog };
            const row: NonNullable<typeof catalogRow> = options.catalog === null
                ? { revision: null, content: null } : { revision: 1, content: catalogContent };
            catalogRow = row;
            catalogMutations.length = 0;
            const settingsHttp = createAccountSettingsHttpBoundary({ serverUrl, initialAccounts: [
                { accountId, snapshot: AccountSettingsV2GetResponseSchema.parse({ version: 1, content: settingsContent }) },
            ] });
            home.answer(serverId, '/v2/account/settings', { select: async (_input, request) => {
                const response = settingsHttp.handle(request.url, request.init);
                if (!response) throw new Error('Missing Provider Account settings HTTP fixture');
                return { status: response.status, body: await response.json() };
            } });
            home.answer(serverId, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { select: () => ({ body: row.revision === null
                ? { status: 'absent' } : {
                    status: row.content === null ? 'deleted' : 'present', revision: row.revision,
                    ...(row.content === null ? {} : { content: row.content }),
                } }) });
            home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { select: async input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                catalogMutations.push(mutation);
                const next = (): HomeDomainAnswer => {
                    if (mutation.expectedRevision !== (row.revision ?? 'absent')) return { body:
                        ProviderConnectionsRowMutationResponseV1Schema.parse({ status: 'conflict', revision: row.revision ?? -1 }) };
                    if (mutation.content !== null && mutation.content.t !== (secret ? 'encrypted' : 'plain')) return { body:
                        ProviderConnectionsRowMutationResponseV1Schema.parse({ status: 'account-mode-mismatch' }) };
                    // Only the wire row is persisted here. Catalog operations, validation,
                    // materialization and publication remain in the real Account owners.
                    row.content = mutation.content;
                    row.revision = (row.revision ?? 0) + 1;
                    return { body: ProviderConnectionsRowMutationResponseV1Schema.parse({
                        status: 'updated', revision: row.revision, cursor: row.revision,
                    }) };
                };
                return await catalogMutationInterceptor?.(mutation, next) ?? next();
            } });
            home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
            // Provider fixtures own an empty Session census. Let real Sync finish
            // its bootstrap rather than retain retries for unclaimed list routes
            // across the next Account restoration.
            const sessions = createSessionMetadataHttpBoundary(() => ({}));
            for (const path of ['/v2/sessions', '/v2/sessions/active', '/v2/session-organization']) {
                home.answer(serverId, `GET ${path}`, { select: async () => {
                    const response = sessions.handle(new URL(path, serverUrl));
                    if (!response) throw new Error(`Missing Provider bootstrap fixture: ${path}`);
                    return { status: response.status, body: await response.json() };
                } });
            }
            const machines = options.machines ?? installedProviderSettingsHarness.current?.state.machines;
            if (machines) await publishMachines(serverId, machines);
            connection = await restoreServerAccountForTest({ serverUrl, accountId, request: bootstrapHome.request, credentials,
                ...(options.activation ? { activation: options.activation } : {}) });
            // Account restoration scopes its bootstrap port to one Home. Subsequent
            // peer Provider reads use every declared Home's same HTTP response owner.
            installHomeGovernanceBoundaries(bootstrapHome);
            const { storage } = await import('@/sync/domains/state/storage');
            await waitForHomeGovernance(() => {
                const scope = storage.getState().profileScope;
                if (scope?.accountId !== accountId) throw new Error('Provider fixture Account is not mounted');
            });
            const waivedActions = options.waivedActions;
            if (waivedActions?.length) {
                await waitForHomeGovernance(() => {
                    const policy = storage.getState().settings.actionsSettingsV1;
                    if (waivedActions.some(id => !policy.approvalWaivedSurfaces?.[id]?.includes('ui'))) {
                        throw new Error('Provider fixture approval policy is not hydrated');
                    }
                });
            }
            if (machines) {
                await waitForHomeGovernance(() => {
                    if (!storage.getState().isDataReady) throw new Error('Provider fixture Sync bootstrap is not ready');
                });
                await publishMachines(serverId, machines);
            }
            // Removing the prior fixture's only Home may restore the device's
            // default public Home. This fixture owns one Account: its feature
            // audience must not wait for that unrelated, uncredentialed Home.
            await home.selectHomes([serverId]);
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
            catalogRow = null;
            catalogMutationInterceptor = null;
            catalogMutations.length = 0;
            serverId = '';
        },
    };
}
