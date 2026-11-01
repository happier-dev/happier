import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { ModalProvider, useOptionalModal } from '@/modal';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { parseToken } from '@/utils/auth/parseToken';

import { isPluginError } from '@happier-dev/plugin-sdk';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    manifest as publicAuthoringManifest,
} from '../../../../../../packages/plugin-sdk/examples/public-authoring/index.ts';
import {
    activate as activatePublicAuthoringReviewClientActions,
} from '../../../../../../packages/plugin-sdk/examples/public-authoring/ui/reviewClientActions.ts';
import {
    formatQualifiedPluginActionId,
    PluginProjectionInstalledPackageV2Schema,
    PluginProjectedActionV2Schema,
    type CurrentUiContextSnapshotV1,
    type PluginContributionClientPlatform,
    type PluginMachineExecutionOriginV1,
    type PluginProjectedActionV2,
} from '@happier-dev/protocol';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiActionProjection, PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { getInstalledPluginUiClientExecutableComposition, resolvePluginUiClientActionRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import { dispatchPluginSurfaceAction } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import { preloadTranslationsForSettings, setPreferredLanguageFromSettings } from '@/text';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, SocketRpcCancellationPayloadSchema, SocketRpcRequestIdSchema } from '@happier-dev/protocol/socketRpc';

// Daemon replies are an external Socket boundary. Home selection, Account
// mode, machine transport, mediation policy and issuance/cancellation stay real.
const daemonReply = vi.hoisted(() => vi.fn<(request: Readonly<{
    machineId: string; method: string; payload: unknown; signal: AbortSignal;
}>) => Promise<unknown>>());
const clientExecutablePlatformState = vi.hoisted(() => ({
    platform: 'ios' as PluginContributionClientPlatform,
}));
const transportSockets = vi.hoisted(() => [] as import('socket.io-client').Socket[]);

vi.mock('socket.io-client', async original => {
    const boundary = await (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original);
    // Observe the canonical SDK boundary's wire receipts, not private RPC state.
    const createSocket = (...args: Parameters<typeof boundary.io>) => {
        const socket = boundary.io(...args);
        transportSockets.push(socket);
        return socket;
    };
    const io = Object.assign(createSocket, boundary.io, { io: createSocket, connect: createSocket });
    return { ...boundary, io, connect: io, default: io };
});
// Native OS identity is the input to the actual preview-platform resolver.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: {
        get OS() { return clientExecutablePlatformState.platform; },
        select: <T,>(values: Partial<Record<PluginContributionClientPlatform | 'default' | 'native', T>>) =>
            values[clientExecutablePlatformState.platform] ?? values.native ?? values.default,
    } });
});
const daemonRequests = installSessionActionRpcBoundary((request, context) => {
    const separator = request.method.indexOf(':');
    return daemonReply({ machineId: request.method.slice(0, separator), method: request.method.slice(separator + 1),
        payload: request.params, signal: context.signal });
});
let homes: ReturnType<typeof createHomeGovernanceHarness>;
let actionHomeId: string;
let clientHomeId: string;
let publicHomeId: string;
let modalScreen: Awaited<ReturnType<typeof renderScreen>>;
let visibleModalCount = 0;
let onVisibleVoiceConfirmation: (() => void) | undefined;
const credentialsToRestore: NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>[] = [];
const initialState = getStorage().getState();
function ModalStateProbe() {
    visibleModalCount = useOptionalModal()?.state.modals.length ?? 0;
    React.useEffect(() => { if (visibleModalCount > 0) onVisibleVoiceConfirmation?.(); });
    return null;
}

/** Declared Action schemas the daemon answers per Action; never projected. */
const actionSchemasByQualifiedId = new Map<string, Readonly<{ inputSchema?: object; outputSchema?: object }>>();

beforeEach(async () => {
    actionSchemasByQualifiedId.clear();
    resetMachineProjectionReadsForTests();
    daemonRequests.length = 0;
    transportSockets.length = 0;
    daemonReply.mockReset();
    daemonReply.mockImplementation(async (request) => {
        if (request.method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return undefined;
        const payload = request.payload;
        const schemas = payload && typeof payload === 'object' && 'qualifiedActionId' in payload
            && typeof payload.qualifiedActionId === 'string' ? actionSchemasByQualifiedId.get(payload.qualifiedActionId) : null;
        return schemas ? { ok: true, ...schemas } : { ok: false, code: 'plugin_action_schemas_unavailable' };
    });
    clientExecutablePlatformState.platform = 'ios';
    homes = createHomeGovernanceHarness();
    setRuntimeFetch(homes.request);
    const add = async (serverUrl: string, serverIdentityId: string, machineId: string) => {
        const serverId = await homes.addHome({ name: 'Current UI Home', serverUrl, serverIdentityId, accountId: 'current-ui-account', currentAccount: true });
        const credential = await TokenStorage.setCredentialsForServerUrlWithRollback(serverUrl, { serverId }, { token: createAccountTokenForTests('current-ui-account', { currentAccount: true }) });
        if (!credential) throw new Error('Current UI fixture credentials were not persisted');
        credentialsToRestore.push(credential);
        // The real scoped transport first proves this Home accepts its Account.
        homes.answer(serverId, '/v1/auth/ping', { body: { ok: true } });
        // Public feature discovery precedes credential-scoped transport preparation.
        homes.answer(serverId, '/health', { body: { status: 'ok' } });
        homes.answer(serverId, '/v1/machines/' + machineId, { body: { machine: createPlainMachineRowFixture({ id: machineId, accountId: 'current-ui-account' }) } });
        return serverId;
    };
    actionHomeId = await add('https://current-ui-actions.test', 'srv_actions', 'machine-actions');
    clientHomeId = await add('https://current-ui-client.test', 'srv_current_ui_client_action', 'machine-current-ui-client-action');
    publicHomeId = await add('https://current-ui-public.test', 'srv_public_authoring_client_action', 'machine-public-authoring-client-action');
    getStorage().getState().activateProfileScope({ serverId: publicHomeId, accountId: 'current-ui-account' });
    modalScreen = await renderScreen(React.createElement(ModalProvider, null, React.createElement(ModalStateProbe)));
});
afterEach(async () => {
    await modalScreen?.unmount();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    resetScopedMachineTransportCacheForTests();
    for (const credentials of credentialsToRestore.splice(0).reverse()) await credentials.rollback();
    await homes?.reset();
    resetRuntimeFetch();
    getStorage().setState(initialState, true);
});

import { resetMachineProjectionReadsForTests } from '@/sync/ops/machineContributionRegistryProjection';
import type { CurrentUiContextResolvedCommand } from './CurrentUiContextProvider';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from './currentUiContextActionRuntime';
import {
    createCurrentUiContributedActionRpcHandler,
    bindCurrentUiContextVoiceToolPortToAdmission,
    createCurrentUiContextVoiceToolPort,
    type CurrentUiContextVoiceInvocationOutcome,
} from './currentUiContextVoiceToolPort';

const COMMAND_ID = 'current-ui-command:1';
const ACTION_ID = Object.freeze({ pluginId: 'acme.triage', localId: 'file-ticket' });
const ACTION_DISCOVERY_ID = formatQualifiedPluginActionId(ACTION_ID);
const ACTION_ORIGIN = Object.freeze({
    machineId: 'machine-actions',
    get serverId() { return actionHomeId; },
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: {
        serverIdentityId: 'srv_actions',
        materializationRef: {
            pluginId: ACTION_ID.pluginId,
            machineId: 'machine-actions',
            materializationId: 'action-materialization-current',
        },
    },
});

const CLIENT_ACTION_ID = Object.freeze({ pluginId: 'acme.current-ui', localId: 'retiring-client-action' });
const CLIENT_ACTION_TARGET = Object.freeze({
    artifactId: 'current-ui-client-action-bundle',
    exportName: 'activate',
    platform: 'ios' as const,
});
const CLIENT_ACTION_GENERATION = 41;
const CLIENT_ACTION_OCCURRENCE_ID = `current-ui-client-action-occurrence-${CLIENT_ACTION_GENERATION}`;
const CLIENT_ACTION_EXECUTION_ORIGIN = Object.freeze({
    serverIdentityId: 'srv_current_ui_client_action',
    materializationRef: Object.freeze({
        pluginId: CLIENT_ACTION_ID.pluginId,
        machineId: 'machine-current-ui-client-action',
        materializationId: 'materialization-current-ui-client-action',
    }),
}) satisfies PluginMachineExecutionOriginV1;
const CLIENT_ACTION_HOST_ORIGIN = Object.freeze({
    machineId: CLIENT_ACTION_EXECUTION_ORIGIN.materializationRef.machineId,
    get serverId() { return clientHomeId; },
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: CLIENT_ACTION_EXECUTION_ORIGIN,
});
const CLIENT_ACTION_ARTIFACT_GRAPH = PluginUiArtifactsManifestEntryV2Schema.parse({
    artifactId: CLIENT_ACTION_TARGET.artifactId,
    tier: 'reactNative',
    entry: 'react-native/current-ui-client-action-bundle/entry.cjs.bundle',
    files: [{
        relativePath: 'react-native/current-ui-client-action-bundle/entry.cjs.bundle',
        digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        byteSize: 10,
    }],
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    builtWith: { bundler: 'esbuild', version: '0.27.2' },
    executable: { exports: [CLIENT_ACTION_TARGET.exportName] },
    hostUiApiRange: '^1.0.0',
});
const CLIENT_ACTION_AUTHORIZATION = Object.freeze({
    generation: Object.freeze({
        targetGeneration: CLIENT_ACTION_OCCURRENCE_ID,
        desiredGeneration: CLIENT_ACTION_OCCURRENCE_ID,
        appliedGeneration: CLIENT_ACTION_OCCURRENCE_ID,
    }),
    resourceSelections: Object.freeze([]),
    scopedGrants: Object.freeze([]),
    serviceAvailability: Object.freeze([]),
    operatingSystemAuthorization: Object.freeze([]),
});

const PUBLIC_AUTHORING_CLIENT_ACTION_GENERATION = 52;
const PUBLIC_AUTHORING_CLIENT_ACTION_OCCURRENCE_ID = `public-authoring-client-action-occurrence-${PUBLIC_AUTHORING_CLIENT_ACTION_GENERATION}`;
const PUBLIC_AUTHORING_CLIENT_ACTION_EXECUTION_ORIGIN = Object.freeze({
    serverIdentityId: 'srv_public_authoring_client_action',
    materializationRef: Object.freeze({
        pluginId: 'examples.public-sdk-review-assistant',
        machineId: 'machine-public-authoring-client-action',
        materializationId: 'materialization-public-authoring-client-action',
    }),
}) satisfies PluginMachineExecutionOriginV1;
const PUBLIC_AUTHORING_CLIENT_ACTION_HOST_ORIGIN = Object.freeze({
    machineId: PUBLIC_AUTHORING_CLIENT_ACTION_EXECUTION_ORIGIN.materializationRef.machineId,
    get serverId() { return publicHomeId; },
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: PUBLIC_AUTHORING_CLIENT_ACTION_EXECUTION_ORIGIN,
});
const PUBLIC_AUTHORING_CLIENT_ACTION_LOCAL_IDS = [
    'open-review-status',
    'open-review-status-web-only-fixture',
] as const;
type PublicAuthoringClientActionLocalId = (typeof PUBLIC_AUTHORING_CLIENT_ACTION_LOCAL_IDS)[number];

const PUBLIC_AUTHORING_CLIENT_ACTION_ARTIFACT_DIGESTS = Object.freeze({
    web: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ios: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    android: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
}) satisfies Readonly<Record<
    PluginContributionClientPlatform,
    PluginReactNativeBundleCacheIdentity['artifactDigest']
>>;

function publicAuthoringClientActionArtifactDigest(
    platform: PluginContributionClientPlatform,
): PluginReactNativeBundleCacheIdentity['artifactDigest'] {
    return PUBLIC_AUTHORING_CLIENT_ACTION_ARTIFACT_DIGESTS[platform];
}

function readPublicAuthoringActionDeclaration(
    value: unknown,
    localId: PublicAuthoringClientActionLocalId,
): object | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Reflect.get(value, 'id') === localId ? value : null;
}

function createPublicAuthoringClientActionFixture(input: Readonly<{
    localId: PublicAuthoringClientActionLocalId;
    platform: PluginContributionClientPlatform;
}>) {
    const declarations = publicAuthoringManifest.contributes.actions ?? [];
    const declaration = declarations
        .map((candidate) => readPublicAuthoringActionDeclaration(candidate, input.localId))
        .find((candidate) => candidate !== null);
    if (!declaration) {
        throw new Error(`public_authoring_client_action_missing:${input.localId}`);
    }
    const {
        inputSchema: declaredInputSchema,
        outputSchema: declaredOutputSchema,
        ...projectedDeclaration
    } = declaration as Readonly<Record<string, unknown>>;
    actionSchemasByQualifiedId.set(`${publicAuthoringManifest.id}/${input.localId}`, {
        inputSchema: (declaredInputSchema as object | undefined) ?? {},
        ...(declaredOutputSchema ? { outputSchema: declaredOutputSchema as object } : {}),
    });
    const action = PluginProjectedActionV2Schema.parse({
        ...projectedDeclaration,
        pluginId: publicAuthoringManifest.id,
        occurrenceId: PUBLIC_AUTHORING_CLIENT_ACTION_OCCURRENCE_ID,
        executionOrigin: PUBLIC_AUTHORING_CLIENT_ACTION_EXECUTION_ORIGIN,
        available: true,
        authorization: {
            generation: {
                targetGeneration: PUBLIC_AUTHORING_CLIENT_ACTION_OCCURRENCE_ID,
                desiredGeneration: PUBLIC_AUTHORING_CLIENT_ACTION_OCCURRENCE_ID,
                appliedGeneration: PUBLIC_AUTHORING_CLIENT_ACTION_OCCURRENCE_ID,
            },
            resourceSelections: [],
            scopedGrants: [],
            serviceAvailability: [],
            operatingSystemAuthorization: [],
        },
    });
    if (action.execution.target !== 'client') {
        throw new Error(`public_authoring_client_action_not_client:${input.localId}`);
    }
    const projectedAction = Object.freeze({
        ...action,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: PUBLIC_AUTHORING_CLIENT_ACTION_HOST_ORIGIN,
    });
    const supportsPlatform = action.execution.platforms.includes(input.platform);
    const bundleId = `reactNativeBundle:${action.pluginId}:${action.id}`;
    const artifactDigest = publicAuthoringClientActionArtifactDigest(input.platform);
    const cacheIdentity: PluginReactNativeBundleCacheIdentity = Object.freeze({
        pluginId: action.pluginId,
        contributionId: action.id,
        artifactId: action.execution.client.artifactId,
        artifactDigest,
        platform: input.platform,
    });
    const artifactGraph = supportsPlatform
        ? PluginUiArtifactsManifestEntryV2Schema.parse({
            artifactId: action.execution.client.artifactId,
            tier: 'reactNative',
            entry: 'react-native/review-client-actions/entry.cjs.bundle',
            files: [{
                relativePath: 'react-native/review-client-actions/entry.cjs.bundle',
                digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                byteSize: 9,
            }],
            digest: artifactDigest,
            builtWith: { bundler: 'esbuild', version: '0.27.2' },
            executable: { exports: [action.execution.client.exportName] },
            hostUiApiRange: '^1.0.0',
        })
        : null;
    const projection = Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: PUBLIC_AUTHORING_CLIENT_ACTION_GENERATION,
        installedPackagesById: Object.freeze({
            [action.pluginId]: PluginProjectionInstalledPackageV2Schema.parse({
                id: action.pluginId,
                displayName: publicAuthoringManifest.displayName,
                version: publicAuthoringManifest.version,
                enabled: true,
                source: { kind: 'localPath', locator: action.pluginId },
            }),
        }),
        actionsById: Object.freeze({
            [`${action.pluginId}/${action.id}`]: projectedAction,
        }),
        reactNativeBundlesById: Object.freeze(artifactGraph === null ? {} : {
            [bundleId]: Object.freeze({
                id: bundleId,
                pluginId: action.pluginId,
                occurrenceId: action.occurrenceId,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: action.id,
                generatedOwnerKind: 'clientContribution' as const,
                artifactGraph,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity: Object.freeze({ artifactDigest: cacheIdentity.artifactDigest }),
                }),
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: PUBLIC_AUTHORING_CLIENT_ACTION_HOST_ORIGIN,
            }),
        }),
    }) satisfies PluginUiProjectionModel;
    const resolved = resolveProjectedPluginUiClientExecutables({
        actionProjection: Object.freeze({ projection }),
        platform: input.platform,
    });
    const executable = resolved[0];
    if (supportsPlatform && (!executable || resolved.length !== 1)) {
        throw new Error('public_authoring_client_action_did_not_resolve_through_generic_projection');
    }
    const cache = createPluginReactNativeBundleCache();
    if (executable) {
        cache.putInstalledArtifact({
            identity: executable.cacheIdentity,
            bytes: new Uint8Array([47, 47, 32, 99, 108, 105, 101, 110, 116]),
            format: 'plainJs',
        });
    }
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
        backendId: 'commonJs',
        available: true,
        loadInstalledBundle: vi.fn(async () => (
            activatePublicAuthoringReviewClientActions as PluginReactNativeExecutableExport
        )),
    });
    const activation = executable
        ? Object.freeze({
            pluginId: executable.pluginId,
            occurrenceId: executable.occurrenceId,
            hostUiApiRange: executable.hostUiApiRange,
            ...(executable.pluginVersion === undefined ? {} : { pluginVersion: executable.pluginVersion }),
            contributes: executable.contributes,
            target: executable.target,
            executionOrigin: executable.executionOrigin,
            cache,
            identity: executable.cacheIdentity,
            moduleReference: executable.moduleReference,
            backend,
            authority: executable.authority,
            isCurrent: () => true,
        })
        : null;
    return Object.freeze({
        action: projectedAction as PluginProjectedActionV2,
        projection,
        resolved,
        activation,
        composition: getInstalledPluginUiClientExecutableComposition(),
    });
}

function clientActionIdentity(): PluginReactNativeBundleCacheIdentity {
    return Object.freeze({
        pluginId: CLIENT_ACTION_ID.pluginId,
        contributionId: CLIENT_ACTION_ID.localId,
        artifactId: CLIENT_ACTION_TARGET.artifactId,
        artifactDigest: CLIENT_ACTION_ARTIFACT_GRAPH.digest,
        platform: CLIENT_ACTION_TARGET.platform,
    });
}

function createCurrentUiClientActionFixture(input: Readonly<{
    handler: PluginClientActionHandler;
    scopes?: PluginProjectedActionV2['scopes'];
    surfaces?: PluginProjectedActionV2['surfaces'];
    serverId?: string;
    dangerLevel?: PluginProjectedActionV2['dangerLevel'];
    confirmation?: PluginProjectedActionV2['confirmation'];
    placementBindings?: PluginProjectedActionV2['placementBindings'];
}>) {
    actionSchemasByQualifiedId.set(`${CLIENT_ACTION_ID.pluginId}/${CLIENT_ACTION_ID.localId}`, { inputSchema: {} });
    const action = PluginProjectedActionV2Schema.parse({
        id: CLIENT_ACTION_ID.localId,
        pluginId: CLIENT_ACTION_ID.pluginId,
        occurrenceId: CLIENT_ACTION_OCCURRENCE_ID,
        title: 'Retiring client action',
        scopes: input.scopes ?? ['global'],
        surfaces: input.surfaces ?? ['voice'],
        execution: {
            target: 'client',
            client: {
                artifactId: CLIENT_ACTION_TARGET.artifactId,
                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [CLIENT_ACTION_TARGET.platform],
        },
        executionOrigin: CLIENT_ACTION_EXECUTION_ORIGIN,
        dangerLevel: input.dangerLevel ?? 'safe',
        ...(input.dangerLevel && input.dangerLevel !== 'safe' ? { confirmation: input.confirmation ?? { title: 'Confirm client mutation' } } : {}),
        available: true,
        authorization: CLIENT_ACTION_AUTHORIZATION,
        ...(input.placementBindings ? { placementBindings: input.placementBindings } : {}),
    });
    const hostOrigin = { ...CLIENT_ACTION_HOST_ORIGIN, serverId: input.serverId ?? CLIENT_ACTION_HOST_ORIGIN.serverId };
    const projectedAction = Object.freeze({
        ...action,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
    });
    const identity = clientActionIdentity();
    const bundleId = `reactNativeBundle:${CLIENT_ACTION_ID.pluginId}:${CLIENT_ACTION_ID.localId}`;
    const projection = Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: CLIENT_ACTION_GENERATION,
        installedPackagesById: Object.freeze({
            [CLIENT_ACTION_ID.pluginId]: PluginProjectionInstalledPackageV2Schema.parse({
                id: CLIENT_ACTION_ID.pluginId,
                displayName: 'Current UI test plugin',
                version: '1.2.3',
                enabled: true,
                source: { kind: 'localPath', locator: CLIENT_ACTION_ID.pluginId },
            }),
        }),
        actionsById: Object.freeze({
            [`${CLIENT_ACTION_ID.pluginId}/${CLIENT_ACTION_ID.localId}`]: projectedAction,
        }),
        reactNativeBundlesById: Object.freeze({
            [bundleId]: Object.freeze({
                id: bundleId,
                pluginId: CLIENT_ACTION_ID.pluginId,
                occurrenceId: action.occurrenceId,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: CLIENT_ACTION_ID.localId,
                generatedOwnerKind: 'clientContribution' as const,
                artifactGraph: CLIENT_ACTION_ARTIFACT_GRAPH,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity: Object.freeze({ artifactDigest: identity.artifactDigest }),
                }),
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
            }),
        }),
    }) satisfies PluginUiProjectionModel;
    const resolved = resolveProjectedPluginUiClientExecutables({
        actionProjection: Object.freeze({ projection }),
        platform: CLIENT_ACTION_TARGET.platform,
    });
    const executable = resolved[0];
    if (!executable || resolved.length !== 1) {
        throw new Error('current UI client Action fixture did not resolve through the production projection');
    }
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity: executable.cacheIdentity,
        bytes: new Uint8Array([47, 47, 32, 99, 108, 105, 101, 110, 116]),
        format: 'plainJs',
    });
    const activate = vi.fn((api: PluginClientApi) => {
        api.actions.register(CLIENT_ACTION_ID.localId, input.handler);
    });
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
        backendId: 'commonJs',
        available: true,
        loadInstalledBundle: vi.fn(async () => activate as PluginReactNativeExecutableExport),
    });
    const activation = Object.freeze({
        pluginId: executable.pluginId,
        occurrenceId: executable.occurrenceId,
        hostUiApiRange: executable.hostUiApiRange,
        ...(executable.pluginVersion === undefined ? {} : { pluginVersion: executable.pluginVersion }),
        contributes: executable.contributes,
        target: executable.target,
        executionOrigin: executable.executionOrigin,
        cache,
        identity: executable.cacheIdentity,
        moduleReference: executable.moduleReference,
        backend,
        authority: executable.authority,
        isCurrent: () => true,
    });
    return Object.freeze({
        action: projectedAction as PluginProjectedActionV2,
        projection,
        activation,
        composition: getInstalledPluginUiClientExecutableComposition(),
    });
}

function withoutAbortSignalAny(): () => void {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        writable: true,
        value: undefined,
    });
    return () => {
        if (original) {
            Object.defineProperty(AbortSignal, 'any', original);
        } else {
            Reflect.deleteProperty(AbortSignal, 'any');
        }
    };
}

function createDaemonActionProjection(input: Readonly<{
    dangerLevel?: PluginProjectedActionV2['dangerLevel'];
    sessionTarget?: PluginProjectedActionV2['sessionTarget'];
}> = {}): PluginUiProjectionModel {
    const dangerLevel = input.dangerLevel ?? 'safe';
    const daemonAction = PluginProjectedActionV2Schema.parse({
        id: ACTION_ID.localId,
        pluginId: ACTION_ID.pluginId,
        occurrenceId: 'acme-triage-occurrence-27',
        title: 'File ticket',
        scopes: ['global'],
        surfaces: ['voice'],
        execution: { target: 'daemon' },
        dangerLevel,
        ...(input.sessionTarget ? { sessionTarget: input.sessionTarget } : {}),
        ...(dangerLevel === 'safe'
            ? {}
            : { confirmation: { title: 'Confirm ticket creation' } }),
        available: true,
    });
    const action: PluginUiActionProjection = Object.freeze({
        ...daemonAction,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: ACTION_ORIGIN,
    });
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 27,
        actionsById: Object.freeze({
            [`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]: action,
        }),
    });
}

function createOpenCommand(): CurrentUiContextResolvedCommand {
    return {
        id: COMMAND_ID,
        command: {
            kind: 'openSurface',
            destination: { pluginId: 'acme.triage', localId: 'issues' },
            input: { issueNumber: 124, privateQuery: 'must-remain-local' },
        },
        retirementSignal: new AbortController().signal,
    };
}

function requireCommandInvoker(port: ReturnType<typeof createCurrentUiContextVoiceToolPort>) {
    if (!port.invokeCurrentUiCommand) throw new Error('missing current UI command invoker');
    return port.invokeCurrentUiCommand;
}

function requireActionInvoker(port: ReturnType<typeof createCurrentUiContextVoiceToolPort>) {
    if (!port.invokeAction) throw new Error('missing current UI action invoker');
    return port.invokeAction;
}

async function startSpokenConfirmation(serverId: string, adapterId: string, canApproveRequests = true) {
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol/features/serverEnabledBit');
    const features = createRootLayoutFeaturesResponse();
    tryWriteServerEnabledBitInPlace(features, 'voice', true);
    homes.answer(serverId, '/v1/features', { body: features });
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const voice = { ...settingsDefaults.voice, canApproveRequests };
    homes.answer(serverId, 'GET /v2/account/settings', { body: { version: 1, content: { t: 'plain', v: { voice } } } });
    getStorage().getState().applySettingsLocal({ voice });
    const store = await import('@/voice/session/voiceSessionStore');
    store.setVoiceSessionSnapshot({ adapterId, sessionId: 'contributed-voice', status: 'connected', mode: 'listening', canStop: true });
    return store;
}

describe('current UI context Voice tool port', () => {
    it.each(['native', 'local', 'altered', 'command', 'tap', 'unavailable'] as const)('binds spoken confirmation to the prepared contributed inner effect (%s)', async runtimeShape => {
        const handler = vi.fn(async (value: unknown) => ({ applied: value }));
        const fixture = createCurrentUiClientActionFixture({ handler, surfaces: ['voice'], dangerLevel: 'writesRemote',
            confirmation: { title: 'Confirm client mutation', inputFields: [{ path: 'ticket', title: 'Ticket' }] } });
        const summary = 'Confirm client mutation\n\nTicket: original';
        await fixture.composition.reconcile([fixture.activation]);
        const { getVoiceSessionSpokenActionConfirmation, resetVoiceSessionStoreForTests } = await startSpokenConfirmation(clientHomeId, runtimeShape, runtimeShape !== 'tap');
        const command: CurrentUiContextResolvedCommand = { id: COMMAND_ID, command: { kind: 'executeAction', action: CLIENT_ACTION_ID, input: { ticket: 'original' } }, retirementSignal: new AbortController().signal };
        const port = createCurrentUiContextVoiceToolPort({
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => command, subscribe: () => () => {} },
            readProjection: () => fixture.projection, readNavigationBinding: () => null,
        });
        const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
        const playHostText = vi.fn(async () => runtimeShape === 'unavailable'
            ? { status: 'unavailable' as const, code: 'host_text_playback_unavailable' }
            : { status: 'completed' as const });
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: clientHomeId, currentUiContext: port,
            ...(['native', 'command', 'tap', 'unavailable'].includes(runtimeShape) ? { playHostText } : {}),
        });
        const controller = new AbortController();
        const tappedConfirmation = new Promise<'tap'>(resolve => { onVisibleVoiceConfirmation = () => resolve('tap'); });
        let pending!: Promise<string>;
        const invoke = (ticket = 'original', confirmation?: import('@happier-dev/protocol/voice/actions').VoiceActionConfirmationBinding) =>
            (runtimeShape === 'command' ? handlers.invokeCurrentUiCommand! : handlers.invokeAction!)(runtimeShape === 'command'
                ? { commandId: COMMAND_ID } : { action: CLIENT_ACTION_ID, input: { ticket } },
            { serverId: clientHomeId, effectId: confirmation ? 'person-answer-yes' : 'contributed-person-request', signal: controller.signal, ...(confirmation ? { confirmation } : {}) });
        await act(async () => { pending = invoke(); });
        try {
            const result = await Promise.race([pending.then(JSON.parse), tappedConfirmation]);
            if (runtimeShape === 'tap' || runtimeShape === 'unavailable') {
                expect(result).toBe('tap');
                expect(handler).not.toHaveBeenCalled();
                if (runtimeShape === 'tap') expect(playHostText).not.toHaveBeenCalled();
                else expect(playHostText).toHaveBeenCalledWith(expect.objectContaining({ text: summary }));
                await modalScreen.pressByTestIdAsync('app-shell-confirmation-confirm');
                expect(JSON.parse(await pending)).toMatchObject({ ok: true, result: { applied: { ticket: 'original' } } });
                expect(handler).toHaveBeenCalledOnce();
                return;
            }
            expect(result).not.toBe('tap');
            if (runtimeShape === 'native' || runtimeShape === 'command') {
                expect(playHostText).toHaveBeenCalledWith(expect.objectContaining({ text: summary }));
                expect(result).toMatchObject({ ok: true, result: { applied: { ticket: 'original' } } });
                expect(handler).toHaveBeenCalledOnce();
            } else {
                expect(handler).not.toHaveBeenCalled();
                const carrier = getVoiceSessionSpokenActionConfirmation()!;
                const readBack = carrier.readPending();
                expect(readBack?.operation.summary).toBe(summary);
                expect(carrier.completeReadBack(readBack)).toBe(true);
                const confirmation = (result as { result: { confirmation: import('@happier-dev/protocol/voice/actions').VoiceActionConfirmationBinding } }).result.confirmation;
                const resumed = JSON.parse(await invoke(runtimeShape === 'altered' ? 'changed' : 'original', confirmation));
                if (runtimeShape === 'altered') {
                    expect(resumed).toMatchObject({ ok: false });
                    expect(handler).not.toHaveBeenCalled();
                } else {
                    expect(resumed).toMatchObject({ ok: true, result: { applied: { ticket: 'original' } } });
                    expect(handler).toHaveBeenCalledOnce();
                }
            }
        } finally { onVisibleVoiceConfirmation = undefined; controller.abort(); await pending.catch(() => {}); resetVoiceSessionStoreForTests(); await fixture.composition.unload(); }
    });
    it.each(['native', 'local', 'retired', 'session'] as const)('binds spoken confirmation to the exact daemon target and occurrence (%s)', async runtimeShape => {
        const store = await startSpokenConfirmation(actionHomeId, runtimeShape);
        let projection = createDaemonActionProjection({ dangerLevel: 'writesRemote',
            ...(runtimeShape === 'session' ? { sessionTarget: { field: 'sessionId', cardinality: 'one' } as const } : {}) });
        if (runtimeShape === 'session') {
            const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
            const session = createPlainSessionByIdResponseFixture(createSessionFixture({ id: 'voice-target' }));
            for (const suffix of ['', '?accessProjectionVersion=1']) {
                homes.answer(actionHomeId, `/v2/sessions/voice-target${suffix}`, { body: session });
            }
        }
        const operands = { ticket: 'original', ...(runtimeShape === 'session' ? { sessionId: 'voice-target' } : {}) };
        actionSchemasByQualifiedId.set(`${ACTION_ID.pluginId}/${ACTION_ID.localId}`, { inputSchema: {
            type: 'object', properties: { ticket: { type: 'string' }, sessionId: { type: 'string' } }, required: ['ticket'], additionalProperties: false,
        } });
        const schemaRead = daemonReply.getMockImplementation()!;
        daemonReply.mockImplementation(async request => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE
            ? { ok: true, result: { applied: true } } : schemaRead(request));
        const port = createCurrentUiContextVoiceToolPort({
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            readProjection: () => projection, readNavigationBinding: () => null,
        });
        const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
        const playHostText = vi.fn(async () => ({ status: 'completed' as const }));
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: actionHomeId, currentUiContext: port,
            ...(['native', 'session'].includes(runtimeShape) ? { playHostText } : {}) });
        const controller = new AbortController();
        const invoke = (confirmation?: import('@happier-dev/protocol/voice/actions').VoiceActionConfirmationBinding) => handlers.invokeAction!(
            { action: ACTION_ID, input: operands }, { serverId: actionHomeId, effectId: confirmation ? 'person-answer-yes' : 'daemon-person-request', signal: controller.signal,
                ...(confirmation ? { confirmation } : {}) });
        const effects = () => daemonReply.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        const tapped = new Promise<'tap'>(resolve => { onVisibleVoiceConfirmation = () => resolve('tap'); });
        let pending!: Promise<string>;
        await act(async () => { pending = invoke(); });
        try {
            let result = await Promise.race([pending.then(JSON.parse), tapped]);
            expect(result).not.toBe('tap');
            if (runtimeShape !== 'native' && runtimeShape !== 'session') {
                expect(effects()).toHaveLength(0);
                const carrier = store.getVoiceSessionSpokenActionConfirmation()!;
                const readBack = carrier.readPending();
                expect(readBack?.operation.summary).toBe('Confirm ticket creation');
                expect(carrier.completeReadBack(readBack)).toBe(true);
                if (runtimeShape === 'retired') {
                    const key = `${ACTION_ID.pluginId}/${ACTION_ID.localId}`;
                    projection = { ...projection, actionsById: { [key]: { ...projection.actionsById[key]!, occurrenceId: 'replacement-occurrence' } } };
                }
                result = JSON.parse(await invoke((result as { result: { confirmation: import('@happier-dev/protocol/voice/actions').VoiceActionConfirmationBinding } }).result.confirmation));
            }
            if (runtimeShape === 'retired') {
                expect(result).toMatchObject({ ok: false });
                expect(effects()).toHaveLength(0);
            } else {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { applied: true } });
                expect(effects()).toHaveLength(1);
                if (runtimeShape === 'native' || runtimeShape === 'session') {
                    expect(playHostText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Confirm ticket creation' }));
                }
                expect(effects()[0]![0].payload).toMatchObject({ input: operands,
                    expectedContributorOccurrenceId: 'acme-triage-occurrence-27', presentUserIntent: 'confirmed' });
                if (runtimeShape === 'session') {
                    // A Session operand must not re-enter the dispatcher and
                    // normalize the same operation before its inner read-back.
                    expect(daemonReply.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)).toHaveLength(1);
                }
            }
        } finally { onVisibleVoiceConfirmation = undefined; controller.abort(); await pending.catch(() => {}); store.resetVoiceSessionStoreForTests(); }
    });
    it('retains the strict daemon SessionTarget declaration in Voice discovery', () => {
        const projection = createDaemonActionProjection({ sessionTarget: { field: 'sessionId', cardinality: 'one' } });
        const port = createCurrentUiContextVoiceToolPort({
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            readProjection: () => projection, readNavigationBinding: () => null,
        });
        expect(port.listCurrentContributedActionDefinitions?.()).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: formatQualifiedPluginActionId(ACTION_ID), sessionTarget: { field: 'sessionId', cardinality: 'one' } }),
        ]));
    });

    it('resolves an opaque committed message reference after reverse CLI Action admission before the client handler sees text', async () => {
        const reference = { v: 1 as const, sessionId: 'message-session', messageId: 'committed-message', observedRevision: 'revision-1' };
        const snapshot = { sessionId: reference.sessionId, messageId: reference.messageId, observedRevision: reference.observedRevision,
            role: 'agent', contentCategory: 'text', seq: 3, visibleText: 'Committed task request',
            structuredPresentationSummary: null, provenanceCategory: 'owner' };
        const handler = vi.fn<PluginClientActionHandler>(async (_input, context) => ({ message: context.messageAction ?? null, surface: context.invocationSurface }));
        const fixture = createCurrentUiClientActionFixture({ handler, surfaces: ['cli'], scopes: ['message', 'session'],
            placementBindings: ['message.menu'], dangerLevel: 'writesRemote' });
        const defaultReply = daemonReply.getMockImplementation()!;
        daemonReply.mockImplementation(async request => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE
            ? { ok: true, result: snapshot } : defaultReply(request));
        const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            readProjection: () => fixture.projection, readNavigationBinding: () => null,
        }));
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const receive = createCurrentUiContributedActionRpcHandler({ machineId: CLIENT_ACTION_HOST_ORIGIN.machineId,
                serverId: clientHomeId, readProjection: () => fixture.projection, isCurrent: () => true,
                execute: createDefaultActionExecutor().execute });
            const request = { v: 1, action: CLIENT_ACTION_ID, input: null, surface: 'cli',
                expectedContributorOccurrenceId: fixture.action.occurrenceId, messageActionReference: reference };
            let pending!: ReturnType<typeof receive>;
            await act(async () => { pending = receive(request); });
            await vi.waitFor(() => expect(modalScreen.findByTestId('app-shell-confirmation-confirm')).not.toBeNull());
            expect(daemonReply.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toEqual([]);
            expect(handler).not.toHaveBeenCalled();
            await modalScreen.pressByTestIdAsync('app-shell-confirmation-confirm');
            expect(await pending).toEqual({ ok: true, result: { message: snapshot, surface: 'cli' } });
            expect(daemonReply).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
                payload: expect.objectContaining({ executionSurface: 'cli', resolveClientMessageContext: true,
                    messageActionReference: reference, invocation: { kind: 'clientPluginAction', clientActionBinding: expect.objectContaining({
                        pluginId: CLIENT_ACTION_ID.pluginId, contributionLocalId: CLIENT_ACTION_ID.localId, occurrenceId: fixture.action.occurrenceId,
                    }) } }) }));
            expect(handler).toHaveBeenCalledTimes(1);
            daemonReply.mockImplementation(async request => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE
                ? { ok: false, code: 'plugin_message_action_unavailable' } : defaultReply(request));
            await act(async () => { pending = receive(request); });
            await vi.waitFor(() => expect(modalScreen.findByTestId('app-shell-confirmation-confirm')).not.toBeNull());
            await modalScreen.pressByTestIdAsync('app-shell-confirmation-confirm');
            expect(await pending).toMatchObject({ ok: false, errorCode: 'plugin_message_action_unavailable' });
            expect(handler).toHaveBeenCalledTimes(1);
        } finally { unregister(); await fixture.composition.unload(); }
    });
    it('delivers contributed Actions through the real Machine reverse registration and refuses a mis-bound receiver', async () => {
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://current-ui-client.test',
            accountId: 'current-ui-account', request: homes.request });
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const answeringServerId = getActiveServerSnapshot().serverId;
        const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
        const { AppShellPluginUiProjectionValueProvider, useAppShellPluginUiProjection } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { createClientActionMachineRpcExecutor } = await import('../../../../../cli/src/plugins/runtime/invocation/actions/clientActionMachineRpc');
        const machineId = CLIENT_ACTION_HOST_ORIGIN.machineId;
        let fixture = createCurrentUiClientActionFixture({ serverId: answeringServerId,
            surfaces: ['agent', 'mcp', 'cli'], handler: async (_input, context) => ({ surface: context.invocationSurface }) });
        const unregisterPort = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            readProjection: () => fixture.projection, readNavigationBinding: () => null,
        }));
        await fixture.composition.unload();
        await fixture.composition.reconcile([fixture.activation]);
        const machine = createMachineFixture({ id: machineId, activeAt: Date.now(), storageMode: 'plain' });
        getStorage().setState(state => ({ ...state, profile: { ...state.profile!, id: 'current-ui-account' },
            machines: { [machineId]: machine }, machineListByServerId: {} }));
        const socket = transportSockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
        if (!socket) throw new Error('Real Account transport did not install its reverse receiver');
        const methods = new Set<string>();
        const emit = vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
            const payload: unknown = args[0];
            if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
                if (event === SOCKET_RPC_EVENTS.REGISTER) methods.add(payload.method);
                if (event === SOCKET_RPC_EVENTS.UNREGISTER) methods.delete(payload.method);
            }
            return socket;
        });
        let deliveries = 0;
        const dispatch = createClientActionMachineRpcExecutor(() => ({
            hasConnectedClientRpcHandler: method => methods.has(`${machineId}:${method}`),
            callConnectedClientRpc: async (method, payload, options) => {
                options.onIssued(); deliveries += 1;
                const result = await new Promise<unknown>(resolve => {
                    for (const receive of socket.listeners(SOCKET_RPC_EVENTS.REQUEST)) {
                        receive({ method: `${machineId}:${method}`, params: JSON.parse(JSON.stringify(payload)) }, resolve);
                    }
                });
                return { ok: true, result };
            },
        }));
        function Runtime({ projection }: Readonly<{ projection: PluginUiProjectionModel | null }>) {
            const defaults = useAppShellPluginUiProjection();
            return React.createElement(AppShellPluginUiProjectionValueProvider, { value: { ...defaults,
                pluginUiProjection: projection, phase: projection ? 'current' : 'unavailable',
                interactionEnabled: projection !== null, serverId: answeringServerId,
                accountLifetime: captureActiveServerAccountScopeLifetime(),
            }, children: React.createElement(ClientActionReverseRuntime) });
        }
        const runtime = await renderScreen(React.createElement(Runtime, { projection: null }));
        try {
            expect(methods.has(`${machineId}:${RPC_METHODS.UI_ACTION_EXECUTE}`)).toBe(true);
            // An app with no current contributed client declaration is not an
            // answering receiver merely because it sees the Machine census.
            expect(methods.has(`${machineId}:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`)).toBe(false);
            await runtime.update(React.createElement(Runtime, { projection: fixture.projection }));
            const { readCurrentAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
            expect(readCurrentAppShellPluginUiProjection()).toBe(fixture.projection);
            expect(resolvePluginUiClientActionRegistration({ action: fixture.projection.actionsById[`${CLIENT_ACTION_ID.pluginId}/${CLIENT_ACTION_ID.localId}`]!, platform: CLIENT_ACTION_TARGET.platform })).not.toBeNull();
            for (const surface of ['agent', 'mcp', 'cli'] as const) {
                expect(await dispatch({ v: 1, action: CLIENT_ACTION_ID, input: null, surface,
                    expectedContributorOccurrenceId: fixture.action.occurrenceId }, {}))
                    .toEqual({ ok: true, result: { surface } });
            }
            await act(async () => {
                getStorage().setState({ machines: { [machineId]: { ...machine, active: false, activeAt: 1 } } });
            });
            expect(methods.has(`${machineId}:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`)).toBe(false);
            await act(async () => {
                getStorage().setState({ machines: { [machineId]: { ...machine, activeAt: Date.now() } } });
            });
            expect(methods.has(`${machineId}:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`)).toBe(true);
            await fixture.composition.unload();
            const dangerousHandler = vi.fn(async () => ({ applied: true }));
            fixture = createCurrentUiClientActionFixture({ serverId: answeringServerId,
                surfaces: ['cli'], dangerLevel: 'writesRemote', handler: dangerousHandler });
            await fixture.composition.reconcile([fixture.activation]);
            await runtime.update(React.createElement(Runtime, { projection: fixture.projection }));
            let dangerous!: ReturnType<typeof dispatch>;
            await act(async () => { dangerous = dispatch({ v: 1, action: CLIENT_ACTION_ID, input: null, surface: 'cli',
                expectedContributorOccurrenceId: fixture.action.occurrenceId }, {}); });
            await vi.waitFor(() => expect(modalScreen.findByTestId('app-shell-confirmation-decline')).not.toBeNull());
            let settled = false;
            void dangerous.then(() => { settled = true; });
            await runtime.update(React.createElement(Runtime, { projection: { ...fixture.projection,
                actionsById: { ...fixture.projection.actionsById } } }));
            expect(modalScreen.findByTestId('app-shell-confirmation-decline')).not.toBeNull();
            expect(settled).toBe(false);
            expect(dangerousHandler).not.toHaveBeenCalled();
            await modalScreen.pressByTestIdAsync('app-shell-confirmation-decline');
            await expect(dangerous).resolves.toMatchObject({ ok: false });
            expect(dangerousHandler).not.toHaveBeenCalled();
            methods.delete(`${machineId}:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`);
            expect(await dispatch({ v: 1, action: CLIENT_ACTION_ID, input: null, surface: 'cli',
                expectedContributorOccurrenceId: fixture.action.occurrenceId }, {}))
                .toMatchObject({ ok: false, errorCode: 'plugin_action_client_target_unavailable' });
            expect(deliveries).toBe(4);
        } finally {
            await runtime.unmount(); emit.mockRestore(); unregisterPort();
            await fixture.composition.unload(); await connection.dispose();
        }
    });
    it('keeps a known reverse client Action result when its own navigation changes the viewed Session', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { getStorage } = await import('@/sync/domains/state/storage');
        const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
        const initialState = getStorage().getState();
        const serverId = (await upsertAndActivateServer({ serverUrl: 'https://reverse-action.test', name: 'Reverse Action Home' })).id;
        getStorage().getState().activateProfileScope({ serverId, accountId: 'reverse-account' });
        const token = createAccountTokenForTests('reverse-account');
        const credentials = await TokenStorage.setCredentialsForServerUrlWithRollback(
            'https://reverse-action.test', { serverId }, { token },
        );
        if (!credentials) throw new Error('Reverse Action Home credentials were not persisted');
        const machineBatchRequests: unknown[] = [];
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/auth/ping') return Response.json({ ok: true });
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
                expect(new URL(String(url)).origin).toBe('https://reverse-action.test');
                expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
                const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
                machineBatchRequests.push(body);
                return createMachineReadBatchResponseFixture(body, id => id === 'machine-current-ui-client-action'
                    ? createPlainMachineRowFixture({ id, accountId: 'reverse-account' }) : null);
            }
            if (path === '/v1/machines/machine-current-ui-client-action') return Response.json({
                machine: createPlainMachineRowFixture({ id: 'machine-current-ui-client-action', accountId: 'reverse-account' }),
            });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return new Response('{}', { status: 404 });
        });
        let viewedSessionId = 'unrelated-viewed-session';
        const listeners = new Set<() => void>();
        const fixture = createCurrentUiClientActionFixture({
            serverId, scopes: ['session'], surfaces: ['agent'],
            handler: async (_input, context) => {
                await context.ui.openSurface('result');
                return { navigated: true };
            },
        });
        const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction,
            reader: {
                readCurrentSessionId: () => viewedSessionId,
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => ({ targetKind: 'app', registerOwner: () => () => {}, openSurface: async () => {
                viewedSessionId = 'created-session';
                for (const listener of listeners) listener();
                return { ok: true };
            } }),
        }));
        await fixture.composition.unload();
        try {
            expect(await fixture.composition.reconcile([fixture.activation])).toMatchObject([{ result: { ok: true } }]);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const handler = createCurrentUiContributedActionRpcHandler({
                machineId: CLIENT_ACTION_HOST_ORIGIN.machineId, serverId,
                readProjection: () => fixture.projection, isCurrent: () => true,
                execute: createDefaultActionExecutor().execute,
            });
            expect(await handler({ v: 1, action: CLIENT_ACTION_ID, input: null, surface: 'agent',
                expectedContributorOccurrenceId: fixture.action.occurrenceId, defaultSessionId: 'invoking-session' }))
                .toEqual({ ok: true, result: { navigated: true } });
            expect(viewedSessionId).toBe('created-session');
            expect(machineBatchRequests).toContainEqual({ machineIds: ['machine-current-ui-client-action'] });
        } finally {
            unregister(); await fixture.composition.unload(); await credentials.rollback(); resetRuntimeFetch();
            getStorage().setState(initialState, true); invalidateAccountEncryptionModeCache();
        }
    });

    it('routes generic action.invoke through the answering default UI executor', async () => {
        expect(visibleModalCount).toBe(0);
        const fixture = createCurrentUiClientActionFixture({
            surfaces: ['agent', 'mcp', 'cli'],
            handler: async (_input, context) => ({ surface: context.invocationSurface }),
        });
        await fixture.composition.unload();
        const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            readProjection: () => fixture.projection, readNavigationBinding: () => null,
        }));
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            for (const surface of ['agent', 'mcp', 'cli'] as const) {
                const outcome = await createDefaultActionExecutor().execute('action.invoke', { action: CLIENT_ACTION_ID, input: null }, {
                    surface, expectedContributedActionOccurrenceId: fixture.action.occurrenceId,
                });
                expect(daemonRequests, JSON.stringify(homes.requests)).not.toEqual([]);
                expect(outcome).toEqual({ ok: true, result: { surface } });
            }
            expect(visibleModalCount).toBe(0);
        } finally { unregister(); await fixture.composition.unload(); }
    });

    it('asks before executing a dangerous reverse client Action from an ordinary CLI caller', async () => {
        const handler = vi.fn(async () => ({ applied: true }));
        const fixture = createCurrentUiClientActionFixture({ handler, surfaces: ['cli'], dangerLevel: 'writesRemote' });
        await fixture.composition.unload();
        const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            readProjection: () => fixture.projection, readNavigationBinding: () => null,
        }));
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const receive = createCurrentUiContributedActionRpcHandler({
                machineId: CLIENT_ACTION_HOST_ORIGIN.machineId, serverId: clientHomeId,
                readProjection: () => fixture.projection, isCurrent: () => true,
                execute: createDefaultActionExecutor().execute,
            });
            let pending!: ReturnType<typeof receive>;
            await act(async () => { pending = receive({ v: 1, action: CLIENT_ACTION_ID, input: null, surface: 'cli',
                expectedContributorOccurrenceId: fixture.action.occurrenceId }); });
            await vi.waitFor(() => expect(modalScreen.findByTestId('app-shell-confirmation-confirm')).not.toBeNull());
            expect(handler).not.toHaveBeenCalled();
            await modalScreen.pressByTestIdAsync('app-shell-confirmation-confirm');
            await expect(pending).resolves.toEqual({ ok: true, result: { applied: true } });
        } finally { unregister(); await fixture.composition.unload(); }
    });

    it('rejects a reverse client Action for a replaced contributor occurrence before its handler runs', async () => {
        const handler = vi.fn(async () => ({ entered: true }));
        const fixture = createCurrentUiClientActionFixture({ handler, surfaces: ['agent', 'mcp', 'cli'] });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const port = createCurrentUiContextVoiceToolPort({
                invocationSurface: 'agent',
                reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
                readProjection: () => fixture.projection, readNavigationBinding: () => null,
            });
            expect(await requireActionInvoker(port)({ action: CLIENT_ACTION_ID, expectedContributorOccurrenceId: 'retired-occurrence' }))
                .toMatchObject({ ok: false, code: 'stale_surface', actionHandlerInvocation: 'notStarted' });
            expect(handler).not.toHaveBeenCalled();
        } finally { await fixture.composition.unload(); }
    });

    it('enforces the safe-only guard at generic default execution before a client handler can start', async () => {
        const handler = vi.fn(async () => ({ mutated: true }));
        const fixture = createCurrentUiClientActionFixture({ handler, surfaces: ['agent'], dangerLevel: 'writesRemote' });
        await fixture.composition.unload();
        const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            readProjection: () => fixture.projection, readNavigationBinding: () => null,
        }));
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            expect(await createDefaultActionExecutor().execute('action.invoke', { action: CLIENT_ACTION_ID, input: null }, {
                surface: 'agent', expectedContributedActionOccurrenceId: fixture.action.occurrenceId,
                requiredContributedActionDangerLevel: 'safe',
            })).toEqual({ ok: false, errorCode: 'plugin_action_read_requires_safe', error: 'plugin_action_read_requires_safe',
                details: { actionHandlerInvocation: 'notStarted' } });
            expect(handler).not.toHaveBeenCalled();
            unregister();
            expect(await createDefaultActionExecutor().execute('action.invoke', { action: CLIENT_ACTION_ID, input: null }, {
                surface: 'agent',
            })).toMatchObject({ ok: false, details: { actionHandlerInvocation: 'notStarted' } });
        } finally { unregister(); await fixture.composition.unload(); }
    });

    it('binds nested builtin Actions to the canonical executor for each automated client origin', async () => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const fixture = createCurrentUiClientActionFixture({
            surfaces: ['agent', 'mcp', 'cli'],
            handler: async (_input, context) => ({ surface: context.invocationSurface, projects: await context.ui.executeAction('projects.list', {}) }),
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            for (const invocationSurface of ['agent', 'mcp', 'cli'] as const) {
                const port = createCurrentUiContextVoiceToolPort({
                    invocationSurface, hostAction: { execute: executor.execute },
                    reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
                    readProjection: () => fixture.projection, readNavigationBinding: () => null,
                });
                expect(await requireActionInvoker(port)({ action: CLIENT_ACTION_ID, expectedContributorOccurrenceId: fixture.action.occurrenceId }))
                    .toEqual({ ok: true, result: { surface: invocationSurface, projects: { items: [], truncated: false, coverage: 'complete' } } });
            }
        } finally { await fixture.composition.unload(); }
    });

    it('fails closed across every port capability after its admitting lifetime retires while preserving a known in-flight settlement', async () => {
        const admission = new AbortController();
        const snapshot: CurrentUiContextSnapshotV1 = { navigation: { area: 'settings', screen: 'settings_page' }, commands: [] };
        const sourceListeners = new Set<() => void>();
        let readCount = 0;
        let commandInvocations = 0;
        let forwardedSignal: AbortSignal | undefined;
        let settleKnownInvocation!: (outcome: CurrentUiContextVoiceInvocationOutcome) => void;
        const command: CurrentUiContextResolvedCommand = {
            id: 'current-ui-command:admission', retirementSignal: new AbortController().signal,
            command: { kind: 'hostLocal', invoke: ({ signal }) => {
                commandInvocations += 1;
                forwardedSignal = signal;
                return new Promise<CurrentUiContextVoiceInvocationOutcome>(resolve => { settleKnownInvocation = resolve; });
            } },
        };
        const source = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => { readCount += 1; return snapshot; },
                resolveCurrentUiCommand: id => id === command.id ? command : null,
                subscribe: listener => { sourceListeners.add(listener); return () => { sourceListeners.delete(listener); }; },
            },
            readProjection: () => null, readNavigationBinding: () => null,
        });
        const port = bindCurrentUiContextVoiceToolPortToAdmission(source, admission.signal);
        const listener = vi.fn();
        const release = port.subscribe(listener);
        if (!port.invokeCurrentUiCommand || !port.invokeAction || !port.listCurrentContributedActionDefinitions) throw new Error('expected bound current UI capability surface');
        expect(port.readCurrentUiContext()).toBe(snapshot);
        expect(port.resolveCurrentUiCommand(command.id)).toBe(command);
        expect(port.listCurrentContributedActionDefinitions()).toEqual([]);
        for (const notify of sourceListeners) notify();
        expect(listener).toHaveBeenCalledTimes(1);
        const pendingKnownInvocation = port.invokeCurrentUiCommand({ commandId: command.id });
        expect(forwardedSignal?.aborted).toBe(false);
        admission.abort(new Error('the admitting Account retired'));
        expect(forwardedSignal?.aborted).toBe(true);
        settleKnownInvocation({ ok: true, result: { committed: true } });
        await expect(pendingKnownInvocation).resolves.toEqual({ ok: true, result: { committed: true } });
        expect(port.readCurrentUiContext()).toBeNull();
        expect(port.resolveCurrentUiCommand(command.id)).toBeNull();
        expect(port.listCurrentContributedActionDefinitions()).toEqual([]);
        for (const notify of sourceListeners) notify();
        release();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(sourceListeners.size).toBe(0);
        expect(readCount).toBe(1);
        await expect(port.invokeCurrentUiCommand({ commandId: 'current-ui-command:retired' })).resolves.toEqual({ ok: false, code: 'unavailable' });
        await expect(port.invokeAction({ action: ACTION_ID })).resolves.toEqual({ ok: false, code: 'unavailable' });
        expect(commandInvocations).toBe(1);
        expect(daemonRequests).toEqual([]);
    });

    it('derives exact Voice Action definitions from the latest current AppShell projection', async () => {
        let projection = createDaemonActionProjection();
        const current = projection.actionsById[`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]!;
        const inputSchema = {
            type: 'object',
            properties: {
                priority: { type: 'string', enum: ['normal', 'urgent'] },
            },
            required: ['priority'],
            additionalProperties: false,
        } as const;
        const outputSchema = {
            type: 'object',
            properties: { issueId: { type: 'string' } },
            required: ['issueId'],
            additionalProperties: false,
        } as const;
        actionSchemasByQualifiedId.set(`${ACTION_ID.pluginId}/${ACTION_ID.localId}`, { inputSchema, outputSchema });
        const voiceAction: PluginUiActionProjection = {
            ...current,
            description: 'Creates an issue in the current project.',
            inputHints: {
                title: 'File ticket',
                fields: [{
                    path: 'priority',
                    title: 'Priority',
                    widget: 'select',
                    options: [
                        { value: 'normal', label: 'Normal' },
                        { value: 'urgent', label: 'Urgent' },
                    ],
                }],
            },
        };
        const actionsById: Record<string, PluginUiActionProjection> = {
            ...projection.actionsById,
            [`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]: voiceAction,
            'acme.triage/hidden': {
                ...current,
                id: 'hidden',
                available: false,
            },
            'acme.triage/ui-only': {
                ...current,
                id: 'ui-only',
                surfaces: ['ui'],
            },
            'acme.triage/stale': {
                ...current,
                id: 'stale',
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: Object.freeze({
                    ...ACTION_ORIGIN,
                    phase: 'retainedOffline',
                }),
            },
        };
        projection = Object.freeze({
            ...projection,
            actionsById: Object.freeze(actionsById),
        });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => undefined,
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        expect(port.listCurrentContributedActionDefinitions?.()).toEqual([{
            id: ACTION_DISCOVERY_ID,
            title: 'File ticket',
            description: 'Creates an issue in the current project.',
            safety: 'safe',
            approval: { result: 'none' },
            placements: [],
            slash: null,
            bindings: null,
            examples: null,
            surfaces: {
                ui: false,
                voice: true,
                agent: false,
                mcp: false,
                cli: false,
                rpc: false,
                api: false,
                plugin: false,
            },
            inputHints: {
                title: 'File ticket',
                fields: [{
                    path: 'priority',
                    title: 'Priority',
                    widget: 'select',
                    options: [
                        { value: 'normal', label: 'Normal' },
                        { value: 'urgent', label: 'Urgent' },
                    ],
                }],
            },
        }]);
        // Schemas are not listed; they are read per Action from its machine.
        await expect(port.readCurrentContributedActionSchemas?.(ACTION_DISCOVERY_ID)).resolves.toEqual({
            inputSchema,
            outputSchema,
        });
        await expect(port.readCurrentContributedActionSchemas?.(
            formatQualifiedPluginActionId({ pluginId: ACTION_ID.pluginId, localId: 'ui-only' }),
        )).resolves.toBeNull();
        expect(daemonRequests).toHaveLength(1);
        const machineRead = homes.requests.find(request => request.serverId === actionHomeId
            && request.path === '/v1/machines/read-batch');
        expect(machineRead).toMatchObject({ input: { machineIds: ['machine-actions'] } });
        expect(machineRead?.token && parseToken(machineRead.token)).toBe('current-ui-account');
        expect(daemonReply).toHaveBeenCalledWith(expect.objectContaining({
            machineId: ACTION_ORIGIN.machineId,
            method: RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ,
            payload: expect.objectContaining({
                qualifiedActionId: `${ACTION_ID.pluginId}/${ACTION_ID.localId}`,
                expectedOccurrenceId: current.occurrenceId,
            }),
        }));
    });

    it('describes a current contributed Action without a declared input constraint', async () => {
        const projection = createDaemonActionProjection();
        actionSchemasByQualifiedId.set(`${ACTION_ID.pluginId}/${ACTION_ID.localId}`, {});
        const port = createCurrentUiContextVoiceToolPort({
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null,
                subscribe: () => () => {} },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });
        await expect(port.readCurrentContributedActionSchemas?.(ACTION_DISCOVERY_ID)).resolves.toEqual({ inputSchema: {} });
    });

    it('resolves the same localized Action title and input hints that UI presentation consumes', async () => {
        await preloadTranslationsForSettings('es');
        setPreferredLanguageFromSettings('es');
        try {
            const projection = createDaemonActionProjection();
            const current = projection.actionsById[`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]!;
            const localizedAction: PluginUiActionProjection = {
                ...current,
                title: { key: 'actions.fileTicket.title', fallback: 'File ticket' },
                description: {
                    key: 'actions.fileTicket.description',
                    fallback: 'Creates an issue in the current project.',
                },
                inputHints: {
                    title: { key: 'actions.fileTicket.form.title', fallback: 'File ticket' },
                    submitLabel: { key: 'actions.fileTicket.form.submit', fallback: 'Create ticket' },
                    fields: [{
                        path: 'priority',
                        title: { key: 'actions.fileTicket.form.priority', fallback: 'Priority' },
                        widget: 'select',
                        options: [{
                            value: 'normal',
                            label: { key: 'actions.fileTicket.form.priority.normal', fallback: 'Normal' },
                        }],
                    }],
                },
            };
            const localizedProjection: PluginUiProjectionModel = Object.freeze({
                ...projection,
                translationsByPluginId: Object.freeze({
                    [ACTION_ID.pluginId]: Object.freeze({
                        id: `translations:${ACTION_ID.pluginId}`,
                        pluginId: ACTION_ID.pluginId,
                        contributionKind: 'translations' as const,
                        locales: ['en', 'es'],
                        bundles: Object.freeze({
                            en: Object.freeze({}),
                            es: Object.freeze({
                                'actions.fileTicket.title': 'Crear ticket',
                                'actions.fileTicket.description': 'Crea un ticket en el proyecto actual.',
                                'actions.fileTicket.form.title': 'Crear ticket',
                                'actions.fileTicket.form.submit': 'Crear ticket',
                                'actions.fileTicket.form.priority': 'Prioridad',
                                'actions.fileTicket.form.priority.normal': 'Normal',
                            }),
                        }),
                    }),
                }),
                actionsById: Object.freeze({
                    [`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]: localizedAction,
                }),
            });
            const port = createCurrentUiContextVoiceToolPort({
                reader: {
                    readCurrentUiContext: () => null,
                    resolveCurrentUiCommand: () => null,
                    subscribe: () => () => undefined,
                },
                readProjection: () => localizedProjection,
                readNavigationBinding: () => null,
            });

            expect(port.listCurrentContributedActionDefinitions?.()).toEqual([
                expect.objectContaining({
                    title: 'Crear ticket',
                    description: 'Crea un ticket en el proyecto actual.',
                    inputHints: {
                        title: 'Crear ticket',
                        submitLabel: 'Crear ticket',
                        fields: [{
                            path: 'priority',
                            title: 'Prioridad',
                            widget: 'select',
                            options: [{ value: 'normal', label: 'Normal' }],
                        }],
                    },
                }),
            ]);

            await preloadTranslationsForSettings('ja');
            setPreferredLanguageFromSettings('ja');
            expect(port.listCurrentContributedActionDefinitions?.()).toEqual([
                expect.objectContaining({
                    title: 'File ticket',
                    description: 'Creates an issue in the current project.',
                    inputHints: {
                        title: 'File ticket',
                        submitLabel: 'Create ticket',
                        fields: [{
                            path: 'priority',
                            title: 'Priority',
                            widget: 'select',
                            options: [{ value: 'normal', label: 'Normal' }],
                        }],
                    },
                }),
            ]);
        } finally {
            setPreferredLanguageFromSettings(null);
        }
    });

    it('does not advertise a client Voice Action before its exact client registration commits', () => {
        const projection = createDaemonActionProjection();
        const current = projection.actionsById[`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]!;
        const clientAction: PluginUiActionProjection = {
            ...current,
            id: 'client-only',
            surfaces: ['voice'],
            execution: {
                target: 'client',
                client: {
                    artifactId: 'client-runtime',
                    exportName: 'activate',
                },
                platforms: ['web'],
            },
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => undefined,
            },
            readProjection: () => Object.freeze({
                ...projection,
                actionsById: Object.freeze({
                    [`${ACTION_ID.pluginId}/${clientAction.id}`]: clientAction,
                }),
            }),
            readNavigationBinding: () => null,
        });

        expect(port.listCurrentContributedActionDefinitions?.()).toEqual([]);
    });

    it('activates and dispatches the public-authoring review Action through the generic executable projection on web, iOS, and Android', async () => {
        const composition = getInstalledPluginUiClientExecutableComposition();
        // Switching OS inputs also switches the real credential owner's storage
        // backend. Supply only browser-origin persistence, not credential readers.
        const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        const browserValues = new Map<string, string>();
        const browserStorage: Storage = {
            get length() { return browserValues.size; },
            key: index => [...browserValues.keys()][index] ?? null,
            getItem: key => browserValues.get(key) ?? null,
            setItem: (key, value) => { browserValues.set(key, value); },
            removeItem: key => { browserValues.delete(key); },
            clear: () => { browserValues.clear(); },
        };
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: browserStorage });
        await composition.unload();
        try {
            for (const platform of ['web', 'ios', 'android'] as const) {
                clientExecutablePlatformState.platform = platform;
                const credential = await TokenStorage.setCredentialsForServerUrlWithRollback('https://current-ui-public.test',
                    { serverId: publicHomeId }, { token: createAccountTokenForTests('current-ui-account', { currentAccount: true }) });
                if (!credential) throw new Error(`Public-authoring ${platform} credentials were not persisted`);
                const fixture = createPublicAuthoringClientActionFixture({
                    localId: 'open-review-status',
                    platform,
                });
                if (!fixture.activation) {
                    throw new Error(`public_authoring_client_action_activation_missing:${platform}`);
                }
                const openSurface = vi.fn(async () => ({ ok: true as const }));
                try {
                    expect(fixture.resolved).toHaveLength(1);
                    expect(await fixture.composition.reconcile([fixture.activation])).toMatchObject([{ result: { ok: true } }]);
                    const { resolvePluginUiClientExecutablePlatform } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');
                    expect(resolvePluginUiClientExecutablePlatform()).toBe(platform);
                    expect(resolvePluginUiClientActionRegistration({ action: fixture.action, platform })).not.toBeNull();

                    const outcome = await dispatchPluginSurfaceAction({
                        action: { pluginId: fixture.action.pluginId, localId: fixture.action.id },
                        resolveContributedAction: (identity) => (
                            identity.pluginId === fixture.action.pluginId
                                && identity.localId === fixture.action.id
                                ? fixture.action
                                : null
                        ),
                        invocationSurface: 'voice',
                        clientAction: {
                            openSurface,
                        },
                        isCurrent: () => true,
                    });

                    expect(outcome).toEqual({ ok: true, result: null });
                    expect(openSurface).toHaveBeenCalledWith({
                        destination: {
                            pluginId: publicAuthoringManifest.id,
                            localId: 'review-session-status-details',
                        },
                    });
                } finally {
                    await fixture.composition.unload();
                    await credential.rollback();
                }
            }
        } finally {
            clientExecutablePlatformState.platform = 'ios';
            await composition.unload();
            if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
            else Reflect.deleteProperty(globalThis, 'localStorage');
        }
    });

    it.each(['ios', 'android'] as const)(
        'keeps the public-authoring web-only fixture unavailable through the canonical dispatcher on %s',
        async (platform) => {
            const composition = getInstalledPluginUiClientExecutableComposition();
            await composition.unload();
            clientExecutablePlatformState.platform = platform;
            const fixture = createPublicAuthoringClientActionFixture({
                localId: 'open-review-status-web-only-fixture',
                platform,
            });
            try {
                expect(fixture.resolved).toEqual([]);
                await expect(dispatchPluginSurfaceAction({
                    action: { pluginId: fixture.action.pluginId, localId: fixture.action.id },
                    resolveContributedAction: (identity) => (
                        identity.pluginId === fixture.action.pluginId
                            && identity.localId === fixture.action.id
                            ? fixture.action
                            : null
                    ),
                    invocationSurface: 'voice',
                    clientAction: {
                    },
                    isCurrent: () => true,
                })).resolves.toEqual({
                    ok: false,
                    code: 'unavailable',
                    reason: 'plugin_surface_client_action_unavailable',
                });
            } finally {
                clientExecutablePlatformState.platform = 'ios';
                await composition.unload();
            }
        },
    );

    it('delegates the exact opaque open-surface command through the incumbent navigation binding without returning its semantic payload', async () => {
        let current: CurrentUiContextResolvedCommand | null = createOpenCommand();
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => ({
                    navigation: { area: 'plugin', screen: 'triage' },
                    commands: [{ id: COMMAND_ID, title: 'Open issue #124' }],
                }),
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => null,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => {} }),
        });

        const outcome = await requireCommandInvoker(port)({ commandId: COMMAND_ID });

        expect(openSurface).toHaveBeenCalledWith({
            destination: { pluginId: 'acme.triage', localId: 'issues' },
            input: { issueNumber: 124, privateQuery: 'must-remain-local' },
        });
        expect(outcome).toEqual({ ok: true });
        expect(JSON.stringify(outcome)).not.toContain('privateQuery');
        expect(JSON.stringify(outcome)).not.toContain(COMMAND_ID);
    });

    it('re-resolves an opaque command at the effect boundary and never opens a command retired before navigation starts', async () => {
        let current: CurrentUiContextResolvedCommand | null = createOpenCommand();
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => null,
            readNavigationBinding: () => {
                current = null;
                return { targetKind: 'app' as const, openSurface, registerOwner: () => () => {} };
            },
        });

        await expect(requireCommandInvoker(port)({ commandId: COMMAND_ID })).resolves.toEqual({
            ok: false,
            code: 'stale_surface',
        });
        expect(openSurface).not.toHaveBeenCalled();
    });

    it('preserves a known navigation success when the publishing mount retires while navigation settles', async () => {
        let current: CurrentUiContextResolvedCommand | null = createOpenCommand();
        const openSurface = vi.fn(async () => {
            current = null;
            return { ok: true as const };
        });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => null,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => {} }),
        });

        await expect(requireCommandInvoker(port)({ commandId: COMMAND_ID })).resolves.toEqual({ ok: true });
        expect(openSurface).toHaveBeenCalledTimes(1);
    });

    it('dispatches an opaque client command as Agent/MCP rather than borrowing Voice admission', async () => {
        const fixture = createCurrentUiClientActionFixture({
            surfaces: ['agent', 'mcp'],
            handler: async (_input, context) => ({ surface: context.invocationSurface }),
        });
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID, retirementSignal: new AbortController().signal,
            command: { kind: 'executeAction', action: CLIENT_ACTION_ID },
        };
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            for (const invocationSurface of ['agent', 'mcp'] as const) {
                const port = createCurrentUiContextVoiceToolPort({
                    invocationSurface,
                    reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => current, subscribe: () => () => {} },
                    readProjection: () => fixture.projection, readNavigationBinding: () => null,
                });
                expect(await requireCommandInvoker(port)({ commandId: COMMAND_ID })).toEqual({ ok: true, result: { surface: invocationSurface } });
                const unregister = registerCurrentUiContextActionPort((surface) => surface === invocationSurface ? port : null);
                try {
                    expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: COMMAND_ID }, context: { surface: invocationSurface } }))
                        .toEqual({ ok: true, result: { surface: invocationSurface } });
                } finally { unregister(); }
                expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: COMMAND_ID }, context: { surface: invocationSurface } }))
                    .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
            }
        } finally {
            await fixture.composition.unload();
        }
    });

    it('preserves a known client-Action navigation failure when its exact Action retires while navigation settles', async () => {
        type NavigationDeniedOutcome = Readonly<{
            ok: false;
            code: 'denied';
            reason: 'denied';
        }>;
        let settleNavigation!: (outcome: NavigationDeniedOutcome) => void;
        let navigationStarted!: () => void;
        const navigationStartedPromise = new Promise<void>((resolve) => { navigationStarted = resolve; });
        const openSurface = vi.fn(() => new Promise<NavigationDeniedOutcome>((resolve) => {
            settleNavigation = resolve;
            navigationStarted();
        }));
        const handler: PluginClientActionHandler = vi.fn(async (_input, context) => {
            try {
                await context.ui.openSurface('issue-details');
            } catch (error) {
                return { navigationFailure: isPluginError(error) ? error.code : 'unexpected' };
            }
            return { navigationFailure: 'unexpected_success' };
        });
        const fixture = createCurrentUiClientActionFixture({ handler });
        let currentProjection: PluginUiProjectionModel | null = fixture.projection;
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => {},
            },
            readProjection: () => currentProjection,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => {} }),
        });

        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const pending = requireActionInvoker(port)({ action: CLIENT_ACTION_ID });
            await navigationStartedPromise;
            currentProjection = null;
            settleNavigation({ ok: false, code: 'denied', reason: 'denied' });

            await expect(pending).resolves.toEqual({
                ok: true,
                result: { navigationFailure: 'denied' },
            });
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await fixture.composition.unload();
        }
    });

    it('preserves a known opaque-command navigation failure when its exact command retires while navigation settles', async () => {
        type NavigationDeniedOutcome = Readonly<{
            ok: false;
            code: 'denied';
            reason: 'denied';
        }>;
        let current: CurrentUiContextResolvedCommand | null = createOpenCommand();
        let settleNavigation!: (outcome: NavigationDeniedOutcome) => void;
        let navigationStarted!: () => void;
        const navigationStartedPromise = new Promise<void>((resolve) => { navigationStarted = resolve; });
        const openSurface = vi.fn(() => new Promise<NavigationDeniedOutcome>((resolve) => {
            settleNavigation = resolve;
            navigationStarted();
        }));
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => null,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => {} }),
        });

        const pending = requireCommandInvoker(port)({ commandId: COMMAND_ID });
        await navigationStartedPromise;
        current = null;
        settleNavigation({ ok: false, code: 'denied', reason: 'denied' });

        await expect(pending).resolves.toEqual({ ok: false, code: 'denied' });
        expect(openSurface).toHaveBeenCalledTimes(1);
    });

    it('returns only a typed navigation failure and never starts an effect after cancellation', async () => {
        const current = createOpenCommand();
        const openSurface = vi.fn(async () => ({
            ok: false as const,
            code: 'denied' as const,
            reason: 'private navigation policy detail',
        }));
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => null,
            readNavigationBinding: () => ({ targetKind: 'app' as const, openSurface, registerOwner: () => () => {} }),
        });

        const failure = await requireCommandInvoker(port)({ commandId: COMMAND_ID });
        expect(failure).toEqual({ ok: false, code: 'denied' });
        expect(JSON.stringify(failure)).not.toContain('private navigation policy detail');

        const aborted = new AbortController();
        aborted.abort();
        await expect(requireCommandInvoker(port)({
            commandId: COMMAND_ID,
            signal: aborted.signal,
        })).resolves.toEqual({ ok: false, code: 'unavailable' });
        expect(openSurface).toHaveBeenCalledTimes(1);
    });

    it('delegates a generic Voice Action through the canonical dispatcher with its exact origin and returns only its bounded settlement', async () => {
        daemonReply.mockReset();
        daemonReply.mockResolvedValue({
            ok: true,
            result: { ticketId: 'T-124' },
        });
        const projection = createDaemonActionProjection();
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                readCurrentSessionId: () => 'host-daemon-session',
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        const outcome = await requireActionInvoker(port)({
            action: ACTION_ID,
            input: { title: 'private ticket title' },
        });

        expect(outcome).toEqual({ ok: true, result: { ticketId: 'T-124' } });
        expect(JSON.stringify(outcome)).not.toContain('private ticket title');
        expect(daemonReply).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-actions',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: expect.objectContaining({
                expectedContributorOccurrenceId: 'acme-triage-occurrence-27',
                qualifiedActionId: 'acme.triage/file-ticket',
                input: { title: 'private ticket title' },
                executionSurface: 'voice',
                sessionId: 'host-daemon-session',
            }),
        }));
    });

    it('projects an issued daemon Action acknowledgement loss to the retained Voice outcome_unknown settlement', async () => {
        daemonReply.mockReset();
        daemonReply.mockImplementation(async () => {
            throw new Error('active Action socket acknowledgement timed out after emission');
        });
        const projection = createDaemonActionProjection();
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        await expect(requireActionInvoker(port)({
            action: ACTION_ID,
            input: { title: 'private ticket title' },
        })).resolves.toEqual({ ok: false, code: 'outcome_unknown' });
        expect(daemonReply).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
        }));
    });

    it('retains a post-handler daemon retirement as outcome_unknown', async () => {
        daemonReply.mockReset();
        daemonReply.mockResolvedValue({
            ok: false,
            code: 'plugin_action_outcome_unknown',
        });
        const projection = createDaemonActionProjection();
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        await expect(requireActionInvoker(port)({
            action: ACTION_ID,
            input: { title: 'private ticket title' },
        })).resolves.toEqual({ ok: false, code: 'outcome_unknown' });
        expect(daemonReply).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
        }));
    });

    it('delegates an opaque execute-Action command through that same dispatcher and preserves a known success after its publication retires', async () => {
        let current: CurrentUiContextResolvedCommand | null = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: ACTION_ID,
                input: { localSemanticInput: 'must-not-reach-provider-result' },
            },
            retirementSignal: new AbortController().signal,
        };
        daemonReply.mockReset();
        daemonReply.mockImplementation(async () => {
            current = null;
            return { ok: true, result: { ticketId: 'T-125' } };
        });
        const projection = createDaemonActionProjection();
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        const outcome = await requireCommandInvoker(port)({ commandId: COMMAND_ID });

        expect(outcome).toEqual({ ok: true, result: { ticketId: 'T-125' } });
        expect(JSON.stringify(outcome)).not.toContain('localSemanticInput');
        expect(JSON.stringify(outcome)).not.toContain(COMMAND_ID);
    });

    it('keeps a known daemon Action failure after its current command retires', async () => {
        let current: CurrentUiContextResolvedCommand | null = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: ACTION_ID,
            },
            retirementSignal: new AbortController().signal,
        };
        daemonReply.mockReset();
        daemonReply.mockImplementation(async () => {
            current = null;
            return { ok: false, code: 'plugin_action_unavailable' };
        });
        const projection = createDaemonActionProjection();
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        await expect(requireCommandInvoker(port)({ commandId: COMMAND_ID })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            errorCode: 'plugin_action_unavailable',
        });
        expect(current).toBeNull();
        expect(daemonReply).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
        }));
    });

    it('forwards exact command retirement before a non-safe daemon Action dispatches', async () => {
        const retirement = new AbortController();
        let current: CurrentUiContextResolvedCommand | null = {
            id: COMMAND_ID,
            command: { kind: 'executeAction', action: ACTION_ID },
            retirementSignal: retirement.signal,
        };
        const projection = createDaemonActionProjection({ dangerLevel: 'writesRemote' });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: id => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });
        let pending!: Promise<CurrentUiContextVoiceInvocationOutcome>;
        await act(async () => { pending = requireCommandInvoker(port)({ commandId: COMMAND_ID }); });
        await vi.waitFor(() => expect(modalScreen.findByTestId('app-shell-confirmation-confirm')).not.toBeNull());
        current = null;
        await act(async () => {
            retirement.abort(new Error('the exact command retired before dispatch'));
            await expect(pending).resolves.toEqual({ ok: false, code: 'unavailable', errorCode: 'plugin_ui_invocation_aborted' });
        });
        await vi.waitFor(() => expect(visibleModalCount).toBe(0));
        expect(daemonRequests).toEqual([]);
    });

    it('retains outcome_unknown and sends correlated cancellation when an already-dispatched non-safe daemon Action retires', async () => {
        const retirement = new AbortController();
        let current: CurrentUiContextResolvedCommand | null = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: ACTION_ID,
                input: { localSemanticInput: 'must-not-reach-provider-result' },
            },
            retirementSignal: retirement.signal,
        };
        let rpcStarted!: () => void;
        const rpcStartedPromise = new Promise<void>((resolve) => { rpcStarted = resolve; });
        let resolveRpc = (_result: Readonly<{ ok: false; code: string }>): void => {
            throw new Error('daemon Action RPC did not start');
        };
        let observedSignal: AbortSignal | undefined;
        daemonReply.mockReset();
        daemonReply.mockImplementation((input: Readonly<{ signal?: AbortSignal }>) => (
            new Promise<Readonly<{ ok: false; code: string }>>((resolve) => {
                observedSignal = input.signal;
                resolveRpc = resolve;
                rpcStarted();
            })
        ));
        const projection = createDaemonActionProjection({ dangerLevel: 'writesRemote' });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => projection,
            readNavigationBinding: () => null,
        });

        let pending!: Promise<CurrentUiContextVoiceInvocationOutcome>;
        await act(async () => { pending = requireCommandInvoker(port)({ commandId: COMMAND_ID }); });
        await vi.waitFor(() => expect(modalScreen.findByTestId('app-shell-confirmation-confirm')).not.toBeNull());
        expect(daemonRequests).toEqual([]);
        await modalScreen.pressByTestIdAsync('app-shell-confirmation-confirm');
        await rpcStartedPromise;
        current = null;
        await act(async () => { retirement.abort(new Error('the exact command retired while confirmation was pending')); });
        try {
            expect(observedSignal?.aborted).toBe(true);
        } finally {
            resolveRpc({ ok: false, code: 'plugin_action_aborted' });
        }
        await expect(pending).resolves.toEqual({ ok: false, code: 'outcome_unknown' });
        const calls = transportSockets.flatMap(socket => vi.mocked(socket.emitWithAck).mock.calls);
        const dispatched = calls.find(([event, payload]) => event === SOCKET_RPC_EVENTS.CALL
            && payload && typeof payload === 'object' && 'method' in payload
            && payload.method === `machine-actions:${RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE}`);
        expect(dispatched).toBeDefined();
        const requestId = SocketRpcRequestIdSchema.parse(dispatched?.[1]?.requestId);
        const cancellations = transportSockets.flatMap(socket => vi.mocked(socket.emit).mock.calls)
            .filter(([event]) => event === SOCKET_RPC_EVENTS.CANCEL)
            .map(([, payload]) => SocketRpcCancellationPayloadSchema.parse(payload));
        expect(cancellations.map(receipt => receipt.requestId)).toEqual([requestId]);
    });

    it.each(['action', 'command'] as const)('admits a Session-scoped client %s using only the host current Session binding', async (entryPoint) => {
        const fixture = createCurrentUiClientActionFixture({
            scopes: ['session'],
            handler: async () => ({ admitted: true }),
        });
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID,
            command: { kind: 'executeAction', action: CLIENT_ACTION_ID },
            retirementSignal: new AbortController().signal,
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                readCurrentSessionId: () => 'host-current-session',
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            await expect(entryPoint === 'action'
                ? requireActionInvoker(port)({ action: CLIENT_ACTION_ID })
                : requireCommandInvoker(port)({ commandId: COMMAND_ID })
            ).resolves.toEqual({ ok: true, result: { admitted: true } });
        } finally {
            await fixture.composition.unload();
        }
    });

    it('does not take Session authority from Action input when the host has no current Session', async () => {
        const handler = vi.fn(async () => ({ admitted: true }));
        const fixture = createCurrentUiClientActionFixture({ scopes: ['session'], handler });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                readCurrentSessionId: () => null,
                resolveCurrentUiCommand: () => null,
                subscribe: () => () => {},
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            await expect(requireActionInvoker(port)({
                action: CLIENT_ACTION_ID,
                input: { sessionId: 'caller-chosen-session' },
            })).resolves.toEqual({ ok: false, code: 'unavailable', errorCode: 'plugin_action_session_required' });
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await fixture.composition.unload();
        }
    });

    it('retires a pending Session Action when the host moves away and back before navigation', async () => {
        let sessionId = 'host-session-a';
        const listeners = new Set<() => void>();
        let entered!: () => void;
        const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
        let resume!: () => void;
        const providerReply = new Promise<void>((resolve) => { resume = resolve; });
        let observedSignal: AbortSignal | undefined;
        const navigation = vi.fn(async () => ({ ok: true as const }));
        const fixture = createCurrentUiClientActionFixture({
            scopes: ['session'],
            handler: async (_input, context) => {
                observedSignal = context.signal;
                entered();
                await providerReply;
                await context.ui.openSurface('review-status');
                return { opened: true };
            },
        });
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                readCurrentSessionId: () => sessionId,
                resolveCurrentUiCommand: () => null,
                subscribe: (listener) => {
                    listeners.add(listener);
                    return () => { listeners.delete(listener); };
                },
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => ({ targetKind: 'app', openSurface: navigation, registerOwner: () => () => {} }),
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const pending = requireActionInvoker(port)({ action: CLIENT_ACTION_ID });
            await handlerEntered;
            sessionId = 'host-session-b';
            for (const listener of listeners) listener();
            sessionId = 'host-session-a';
            for (const listener of listeners) listener();
            expect(observedSignal?.aborted).toBe(true);
            resume();
            await expect(pending).resolves.toEqual({ ok: false, code: 'outcome_unknown' });
            expect(navigation).not.toHaveBeenCalled();
            expect(listeners.size).toBe(0);
        } finally {
            resume();
            await fixture.composition.unload();
        }
    });

    it('does not enter a client handler when its exact current command retirement is already signaled', async () => {
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const fixture = createCurrentUiClientActionFixture({ handler });
        const retirement = new AbortController();
        const attempt = new AbortController();
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: CLIENT_ACTION_ID,
            },
            retirementSignal: retirement.signal,
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            retirement.abort(new Error('the exact current command retired before the client Action entered'));
            const restoreAbortSignalAny = withoutAbortSignalAny();
            try {
                await expect(requireCommandInvoker(port)({
                    commandId: COMMAND_ID,
                    signal: attempt.signal,
                })).resolves.toEqual({ ok: false, code: 'unavailable' });
            } finally {
                restoreAbortSignalAny();
            }
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await fixture.composition.unload();
        }
    });

    it('projects a retirement after a client handler begins as outcome_unknown', async () => {
        let handlerEntered!: () => void;
        const handlerEnteredPromise = new Promise<void>((resolve) => { handlerEntered = resolve; });
        const handler = vi.fn(() => {
            handlerEntered();
            return new Promise<never>(() => {});
        });
        const fixture = createCurrentUiClientActionFixture({ handler });
        const retirement = new AbortController();
        const attempt = new AbortController();
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: CLIENT_ACTION_ID,
            },
            retirementSignal: retirement.signal,
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const restoreAbortSignalAny = withoutAbortSignalAny();
            try {
                const pending = requireCommandInvoker(port)({
                    commandId: COMMAND_ID,
                    signal: attempt.signal,
                });
                await handlerEnteredPromise;
                retirement.abort(new Error('the exact current command retired after its client Action entered'));
                await expect(pending).resolves.toEqual({ ok: false, code: 'outcome_unknown' });
            } finally {
                restoreAbortSignalAny();
            }
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await fixture.composition.unload();
        }
    });

    it('retains a known client settlement when the exact current command retires afterward', async () => {
        let handlerReturned!: () => void;
        const handlerReturnedPromise = new Promise<void>((resolve) => { handlerReturned = resolve; });
        const handler = vi.fn(() => {
            handlerReturned();
            return { committed: true };
        });
        const fixture = createCurrentUiClientActionFixture({ handler });
        const retirement = new AbortController();
        const attempt = new AbortController();
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: CLIENT_ACTION_ID,
            },
            retirementSignal: retirement.signal,
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: () => fixture.projection,
            readNavigationBinding: () => null,
        });
        await fixture.composition.unload();
        try {
            await fixture.composition.reconcile([fixture.activation]);
            const restoreAbortSignalAny = withoutAbortSignalAny();
            try {
                const pending = requireCommandInvoker(port)({
                    commandId: COMMAND_ID,
                    signal: attempt.signal,
                });
                await handlerReturnedPromise;
                retirement.abort(new Error('the exact current command retired after the client Action settled'));
                await expect(pending).resolves.toEqual({ ok: true, result: { committed: true } });
            } finally {
                restoreAbortSignalAny();
            }
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await fixture.composition.unload();
        }
    });
});
