import {
    DEFAULT_PROVIDER_SETTINGS_V1,
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
import { vi } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture } from '../fixtures/machineFixtures';
import { createPartialStorageModuleMock } from '../mocks/storage';

type ProviderRpcResponse =
    | DaemonProviderConnectionsDescribeResponseV1
    | DaemonProviderConnectionMutationResponseV1
    | DaemonProviderProbeResponseV1
    | DaemonProviderModelsResponseV1
    | DaemonProviderModelProjectionResponseV1
    | DaemonProviderModelSettingsMutationResponseV1
    | DaemonProviderModelLoadResponseV1;

export type ProviderRpcRequest = Readonly<{
    machineId: string;
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
    const serverId = options.serverId ?? 'server-a';
    const machine = createMachineFixture({
        id: 'machine-a',
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
        settings: (options.settings ?? { schemaVersion: 7, providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1 }) as unknown,
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
            state.machines = [...(options.machines ?? [machine])];
            state.settings = options.settings ?? { schemaVersion: 7, providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1 };
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
        async storageModule(importOriginal: <T>() => Promise<T>) {
            return await createPartialStorageModuleMock(importOriginal, {
                useAllMachines: () => state.machines,
                useMachineListByServerId: () => ({ [serverId]: state.machines }),
                useSettings: () => state.settings,
            });
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

export function installProviderSettingsStorageBoundary(harness: ProviderSettingsHarness): void {
    installedProviderSettingsHarness.current = harness;
    vi.doMock('@/sync/domains/state/storage', async (importOriginal) => {
        const current = installedProviderSettingsHarness.current;
        if (!current) throw new Error('Provider settings test harness is not installed');
        return await current.storageModule(importOriginal);
    });
}
