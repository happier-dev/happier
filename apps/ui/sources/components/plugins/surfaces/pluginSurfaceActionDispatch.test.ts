import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPluginUiHostApiClient } from '@happier-dev/plugin-sdk/ui/client';
import type { PluginUiHostApi, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import {
    buildQualifiedPluginContributionKey,
    ApprovalRequestV2Schema,
    createActionExecutor,
    decideApprovalRequestTransition,
    DaemonPluginStructuredMessageActionExecuteRequestSchema,
    DaemonPluginStructuredMessageActionExecuteResponseSchema,
    isApprovalRequiredByActionsSettings,
    normalizeActionsSettingsV1,
    PLUGIN_INVOCABLE_ACTION_IDS,
    PluginProjectionInstalledPackageV2Schema,
    PluginProjectedActionV2Schema,
    PluginJsonValueV2Schema,
    pluginSourceCustodyV1Equal,
    type ActionExecutorDeps,
    type ApprovalRequest,
    type PluginActionCurrentIntentResult,
    type PluginContributionIdentityV1,
    type PluginMachineExecutionOriginV1,
    type PluginProjectedActionV2,
    type PluginSourceCustodyV1,
} from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
} from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import {
    PluginUiArtifactsManifestEntryV2Schema,
    PluginHostedWebBridgeEnvelopeV1Schema,
    PluginUiExecuteActionRequestV1Schema,
    PluginUiJsonValueV1Schema,
    PluginUiTargetedContributionsV1Schema,
    type
    CurrentUiContextSnapshotV1,
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
    PluginUiSurfaceContextV1,
    type PluginUiArtifactsManifestEntryV2,
} from '@happier-dev/protocol/plugins/ui';

import { createPluginHostedWebHostApiBridgeHandler } from '@/components/plugins/hostApi/hostedWebAdapter';
import { resetMachineProjectionReadsForTests } from '@/sync/ops/machineContributionRegistryProjection';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';

import { projectPluginUiTheme } from './pluginUiThemeProjection';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import {
    getInstalledPluginUiClientExecutableComposition,
    resolvePluginUiClientActionRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import {
    createPluginSurfaceActionHostApi as createPluginSurfaceActionHostApiImpl,
    dispatchPluginSurfaceAction as dispatchPluginSurfaceActionImpl,
    type DispatchPluginSurfaceActionInput,
    type PluginSurfaceContributedActionTransport,
    type PluginSurfaceHostActionExecute,
} from './pluginSurfaceActionDispatch';
import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';
import { createPluginSurfaceStoredImageOwner } from './pluginSurfaceStoredImage';
import { dispatchPluginResolvedSemanticCommand } from './dispatchPluginResolvedSemanticCommand';
import { getPluginUiEphemeralSharedScope } from './pluginUiEphemeralSharedScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { createPluginEntityDragDropBinding, executeMountedPluginEntityDropAction, settlePluginEntityDropActionResult } from './entityDragDrop/pluginEntityDragDropBinding';
import { createActionOperationRunner } from '../../../../../cli/src/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '../../../../../cli/src/daemon/actionOperations/actionOperationStore';

// The dispatcher and serializer stay real. The server-scoped RPC is the
// system boundary that terminates this UI-side transport path.
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const newSessionNavigation = vi.hoisted(() => vi.fn());
const nestedActionConfirmation = vi.hoisted(() => ({
    onShow: null as null | ((confirm: () => void, cancel: () => void) => void),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: newSessionNavigation } }).module;
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

/**
 * Action schemas are not in the projection; the daemon answers them per Action.
 * Fixtures declare them here and the machine-RPC boundary serves them.
 */
const clientActionSchemasByQualifiedId = new Map<string, Readonly<{ inputSchema: object; outputSchema?: object }>>();

function answerActionSchemasRead(request: unknown): unknown {
    const { method, payload } = request as Readonly<{
        method?: string;
        payload?: Readonly<{ qualifiedActionId?: string }>;
    }>;
    if (method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return undefined;
    const schemas = clientActionSchemasByQualifiedId.get(payload?.qualifiedActionId ?? '');
    return schemas
        ? { ok: true, ...schemas }
        : { ok: false, code: 'plugin_action_schemas_unavailable' };
}

beforeEach(() => {
    resetMachineProjectionReadsForTests();
    machineRpcWithServerScopeMock.mockImplementation(async (request: unknown) => answerActionSchemasRead(request));
});

// Semantic routing keeps the real transient-interaction owner; only its
// platform dialog boundary is substituted in this non-rendering suite.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: {
        // Native modal presentation is the boundary; the real transient Interaction owner settles the decision.
        show: vi.fn((config: { props: { onConfirm(): void; onCancel(): void } }) => {
            if (nestedActionConfirmation.onShow) nestedActionConfirmation.onShow(config.props.onConfirm, config.props.onCancel);
            else queueMicrotask(() => config.props.onCancel?.());
            return 'nested-action-confirmation';
        }) as never,
    } }).module;
});

const CALLER_PLUGIN_ID = 'happier.inspector';
const TARGET_SOURCE_CUSTODY = { kind: 'development', registeredRootId: 'inspector-root' } as const;
const CONTRIBUTOR_SOURCE_CUSTODY = { kind: 'development', registeredRootId: 'reviewer-root' } as const;
const CALLER_MATERIALIZATION = {
    pluginId: CALLER_PLUGIN_ID,
    machineId: 'machine-1',
    materializationId: 'materialization-inspector-current',
} as const;

function mountedCallerBinding(input: Readonly<{
    pluginId?: string;
    contributionLocalId?: string;
    occurrenceId?: string;
    machineId?: string;
    materializationId?: string;
}> = {}) {
    const pluginId = input.pluginId ?? CALLER_PLUGIN_ID;
    const contributionLocalId = input.contributionLocalId ?? 'inspector-app';
    const machineId = input.machineId ?? 'machine-1';
    return {
        pluginId,
        contributionLocalId,
        occurrenceId: input.occurrenceId ?? `${pluginId}:current`,
        materializationRef: {
            pluginId,
            machineId,
            materializationId: input.materializationId ?? 'materialization-inspector-current',
        },
    } as const;
}

function mountedActionBinding(input: Readonly<{ machineId?: string }> = {}) {
    return {
        machineId: input.machineId ?? 'machine-1',
    } as const;
}

const CLIENT_ACTION_TARGET = Object.freeze({
    artifactId: 'client-action-bundle',
    exportName: 'execute',
    platform: 'web' as const,
});
const CLIENT_ACTION_ORIGIN: PluginMachineExecutionOriginV1 = Object.freeze({
    serverIdentityId: 'srv_client_action',
    materializationRef: Object.freeze({
        pluginId: CALLER_PLUGIN_ID,
        machineId: 'machine-client-action',
        materializationId: 'materialization-client-action',
    }),
});
const CLIENT_ACTION_GENERATION = 9;
function clientAccountLifetime() {
    let current = true;
    const listeners = new Set<() => void>();
    return {
        scope: { serverId: 'server-client-action', accountId: 'test-account' },
        isCurrent: () => current,
        onRetire(listener: () => void) {
            listeners.add(listener);
            return { dispose: () => { listeners.delete(listener); } };
        },
        retire() {
            current = false;
            for (const listener of listeners) listener();
            listeners.clear();
        },
    } satisfies ActiveServerAccountScopeLifetime & { retire(): void };
}
const CLIENT_ACTION_ARTIFACT_GRAPH = PluginUiArtifactsManifestEntryV2Schema.parse({
    artifactId: CLIENT_ACTION_TARGET.artifactId,
    tier: 'reactNative',
    entry: 'react-native/client-action-bundle/entry.cjs.bundle',
    files: [{
        relativePath: 'react-native/client-action-bundle/entry.cjs.bundle',
        digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        byteSize: 10,
    }],
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    builtWith: { bundler: 'esbuild', version: '0.27.2' },
    executable: { exports: [CLIENT_ACTION_TARGET.exportName] },
    hostUiApiRange: '^1.0.0',
});
const CLIENT_ACTION_HOST_ORIGIN = Object.freeze({
    machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
    serverId: 'server-client-action',
    generation: CLIENT_ACTION_GENERATION,
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: CLIENT_ACTION_ORIGIN,
});

function clientActionExecutionOrigin(pluginId: string): PluginMachineExecutionOriginV1 {
    return pluginId === CALLER_PLUGIN_ID
        ? CLIENT_ACTION_ORIGIN
        : Object.freeze({
            ...CLIENT_ACTION_ORIGIN,
            materializationRef: Object.freeze({
                ...CLIENT_ACTION_ORIGIN.materializationRef,
                pluginId,
                materializationId: `materialization-${pluginId}`,
            }),
        });
}

function clientActionIdentity(
    localId: string,
    pluginId = CALLER_PLUGIN_ID,
    artifactGraph = CLIENT_ACTION_ARTIFACT_GRAPH,
): PluginReactNativeBundleCacheIdentity {
    return Object.freeze({
        pluginId,
        contributionId: localId,
        artifactId: CLIENT_ACTION_TARGET.artifactId,
        artifactDigest: artifactGraph.digest,
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        platform: CLIENT_ACTION_TARGET.platform,
        channel: 'internal',
        nativeCapabilitiesDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        projectionGeneration: CLIENT_ACTION_GENERATION,
    });
}
const CLIENT_ACTION_AUTHORIZATION = Object.freeze({
    generation: Object.freeze({
        targetGeneration: String(CLIENT_ACTION_GENERATION),
        desiredGeneration: String(CLIENT_ACTION_GENERATION),
        appliedGeneration: String(CLIENT_ACTION_GENERATION),
    }),
    resourceSelections: Object.freeze([]),
    scopedGrants: Object.freeze([]),
    serviceAvailability: Object.freeze([]),
    operatingSystemAuthorization: Object.freeze([]),
});

function createClientTargetAction(input: Readonly<{
    identity: PluginContributionIdentityV1;
    dangerLevel?: 'safe' | 'writesRemote';
    surfaces?: PluginProjectedActionV2['surfaces'];
}>): PluginProjectedActionV2 {
    const dangerLevel = input.dangerLevel ?? 'safe';
    const executionOrigin = clientActionExecutionOrigin(input.identity.pluginId);
    return PluginProjectedActionV2Schema.parse({
        id: input.identity.localId,
        pluginId: input.identity.pluginId,
        occurrenceId: `occurrence-${input.identity.pluginId}`,
        title: input.identity.localId,
        scopes: ['global'],
        surfaces: input.surfaces ?? ['ui'],
        placementBindings: ['detailsPanel'],
        execution: {
            target: 'client',
            client: {
                artifactId: CLIENT_ACTION_TARGET.artifactId,
                                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [CLIENT_ACTION_TARGET.platform],
        },
        serverIdentityId: executionOrigin.serverIdentityId,
        materializationRef: executionOrigin.materializationRef,
        dangerLevel,
        ...(dangerLevel === 'safe'
            ? {}
            : {
                confirmation: {
                    title: 'Confirm client action',
                    body: 'This action changes remote state.',
                },
            }),
        available: true,
        authorization: CLIENT_ACTION_AUTHORIZATION,
    });
}

function createClientActionActivation(input: Readonly<{
    pluginId?: string;
    localId?: string;
    dangerLevel?: 'safe' | 'writesRemote';
    surfaces?: PluginProjectedActionV2['surfaces'];
    inputSchema?: object;
    outputSchema?: object;
    handler: PluginClientActionHandler;
    accountLifetime?: ActiveServerAccountScopeLifetime;
    occurrenceId?: string;
    artifactGraph?: PluginUiArtifactsManifestEntryV2;
}>) {
    const pluginId = input.pluginId ?? CALLER_PLUGIN_ID;
    const localId = input.localId ?? 'refresh-index';
    const executionOrigin = clientActionExecutionOrigin(pluginId);
    const hostOrigin = Object.freeze({
        ...CLIENT_ACTION_HOST_ORIGIN,
        machineId: executionOrigin.materializationRef.machineId,
        executionOrigin,
    });
    const action = createClientTargetAction({
        identity: { pluginId, localId },
        dangerLevel: input.dangerLevel,
        surfaces: input.surfaces,
    });
    clientActionSchemasByQualifiedId.set(`${pluginId}/${localId}`, {
        inputSchema: input.inputSchema ?? {},
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    });
    const artifactGraph = input.artifactGraph ?? CLIENT_ACTION_ARTIFACT_GRAPH;
    const identity = clientActionIdentity(localId, pluginId, artifactGraph);
    const projectedAction = Object.freeze({
        ...action,
        occurrenceId: input.occurrenceId ?? `occurrence-${pluginId}`,
        serverIdentityId: executionOrigin.serverIdentityId,
        materializationRef: executionOrigin.materializationRef,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
    });
    const bundleId = `reactNativeBundle:${pluginId}:${localId}`;
    const projection = Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: CLIENT_ACTION_GENERATION,
        installedPackagesById: Object.freeze({
            [pluginId]: PluginProjectionInstalledPackageV2Schema.parse({
                id: pluginId,
                displayName: 'Happier Inspector',
                version: '1.2.3',
                enabled: true,
                source: { kind: 'localPath', locator: pluginId },
            }),
        }),
        actionsById: Object.freeze({
            [`${pluginId}/${localId}`]: projectedAction,
        }),
        reactNativeBundlesById: Object.freeze({
            [bundleId]: Object.freeze({
                id: bundleId,
                pluginId,
                occurrenceId: projectedAction.occurrenceId,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: localId,
                generatedOwnerKind: 'clientContribution' as const,
                artifactGraph,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity: Object.freeze({ artifactDigest: artifactGraph.digest }),
                }),
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin,
            }),
        }),
    }) satisfies PluginUiProjectionModel;
    const resolved = resolveProjectedPluginUiClientExecutables({
        actionProjection: Object.freeze({ projection }),
        platform: CLIENT_ACTION_TARGET.platform,
    });
    const resolvedAction = resolved[0];
    if (!resolvedAction || resolved.length !== 1) {
        throw new Error('client Action fixture did not resolve through the production projection');
    }
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity: resolvedAction.cacheIdentity,
        bytes: new Uint8Array([47, 47, 32, 99, 108, 105, 101, 110, 116]),
        format: 'plainJs',
    });
    const activate = vi.fn((api: PluginClientApi) => {
        // The registration transaction is real: only the artifact loader is a
        // system-boundary test double.
        api.actions.register(localId, input.handler);
    });
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
        backendId: 'commonJs',
        available: true,
        loadInstalledBundle: vi.fn(async () => activate as PluginReactNativeExecutableExport),
    });
    const activation = Object.freeze({
        pluginId: resolvedAction.pluginId,
        ...(resolvedAction.pluginVersion === undefined ? {} : { pluginVersion: resolvedAction.pluginVersion }),
        hostUiApiRange: resolvedAction.hostUiApiRange,
        contributes: resolvedAction.contributes,
        target: resolvedAction.target,
        executionOrigin: resolvedAction.executionOrigin,
        cache,
        identity: resolvedAction.cacheIdentity,
        moduleReference: resolvedAction.moduleReference,
        backend,
        authority: resolvedAction.authority,
        accountLifetime: input.accountLifetime,
        occurrenceId: projectedAction.occurrenceId,
        isCurrent: () => true,
    });
    return Object.freeze({
        activation,
        activate,
        projection,
        action: projectedAction as PluginProjectedActionV2,
        composition: getInstalledPluginUiClientExecutableComposition(),
    });
}

function resolveExactClientAction(action: PluginProjectedActionV2) {
    return (identity: PluginContributionIdentityV1): PluginProjectedActionV2 | null => (
        identity.pluginId === action.pluginId && identity.localId === action.id
            ? action
            : null
    );
}

function resolveDaemonTargetAction(
    identity: PluginContributionIdentityV1,
): PluginProjectedActionV2 {
    return {
        id: identity.localId,
        pluginId: identity.pluginId,
        occurrenceId: `occurrence-${identity.pluginId}`,
        title: identity.localId,
        scopes: ['session'],
        surfaces: ['ui'],
        execution: { target: 'daemon' },
        dangerLevel: 'safe',
        available: true,
    };
}

/** Test-only raw projection producer for pre-existing daemon-arm cases. */
function dispatchPluginSurfaceAction(input: DispatchPluginSurfaceActionInput) {
    return dispatchPluginSurfaceActionImpl({
        ...input,
        resolveContributedAction: input.resolveContributedAction ?? resolveDaemonTargetAction,
    });
}

/** Keeps existing host-API cases on the same raw V2 descriptor path. */
function createPluginSurfaceActionHostApi(
    input: Parameters<typeof createPluginSurfaceActionHostApiImpl>[0],
) {
    return createPluginSurfaceActionHostApiImpl({
        ...input,
        resolveContributedAction: input.resolveContributedAction ?? resolveDaemonTargetAction,
    });
}

/**
 * A first-party ActionSpec that really carries `surfaces.plugin`. Read from the
 * canonical runtime companion so this suite cannot drift from the master key:
 * if `surfaces.plugin` were reverted, every branch-1 case fails loudly instead of
 * silently reclassifying as a contributed action.
 */
const HOST_ACTION_ID = 'plugins.reload';

function surfaceContext(pluginId = CALLER_PLUGIN_ID): PluginUiSurfaceContextV1 {
    return {
        pluginId,
        contributionId: 'inspector-app',
        surfaceId: `surfacePlacement:${pluginId}:inspector-app`,
        placement: 'appSurface',
        platform: 'web',
        channel: 'internal',
        resourceScope: [],
        diagnostics: [],
    };
}

function executeActionRequest(payload: PluginUiJsonValueV1): PluginUiHostApiRequestEnvelopeV1 {
    return {
        version: 1,
        requestId: 'request-1',
        surface: surfaceContext(),
        method: 'executeAction',
        payload,
    };
}

describe('stored image custody from delivered Actions', () => {
    it.each(['raw Session events', 'contributed result'] as const)(
        'admits a native image from a successful %s, never before delivery or after failure',
        async (source) => {
            const media = { mediaId: 'image-delivered', mediaKind: 'image', width: 100, height: 60, sizeBytes: 24,
                file: { sessionId: 'session-1', storage: 'daemon', path: '.happier/uploads/artifacts/session-1/image.png',
                    sha256: 'a'.repeat(64), mimeType: 'image/png' } } satisfies PluginUiJsonValueV1;
            // getSessionEvents success page, including the real semantic-item and pagination shape.
            const result = { ok: true, sessionId: 'session-1', items: [{ id: 'message-image', seq: 1, createdAt: 1,
                storedMessageRole: 'agent', semanticRole: 'assistant', role: 'assistant', kind: 'message', raw: { image: media } }],
                nextCursor: null, hasMore: false,
                diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } };
            const image = { bytesBase64: 'cG5n', mimeType: 'image/png' as const, width: 100, height: 60 };
            const readRequest = { ...executeActionRequest({}), method: 'readStoredImage' as const,
                payload: { image: { sessionId: 'session-1', mediaId: media.mediaId } } };
            const readInputs: unknown[] = [];
            const owner = createPluginSurfaceStoredImageOwner({ pluginId: CALLER_PLUGIN_ID, occurrenceId: 'occ-1',
                machineId: 'machine-1', serverId: null, isCurrent: () => true, lifetimeSignal: new AbortController().signal,
                // The daemon read transport is the boundary; real result admission and custody stay intact.
                read: async (_machineId, input) => { readInputs.push(input); return { ok: true, image }; } });
            let succeeds = false;
            const delivered: PluginUiJsonValueV1[] = [];
            const deps = {
                // Session event retrieval is the authenticated network/data port; Action execution remains real.
                sessionEventsGet: async () => succeeds ? result
                    : { ok: false, errorCode: 'media_unavailable', error: 'media_unavailable' },
            } satisfies Partial<ActionExecutorDeps>;
            // The boundary fixture supplies only the exercised Session read port, not unrelated Agent services.
            const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
            const api = createPluginSurfaceActionHostApi({ surfaceContext: surfaceContext(), callerBinding: mountedCallerBinding(),
                hostAction: { execute: executor.execute },
                contributedAction: { ...mountedActionBinding(), execute: async () => ({ supported: true,
                    result: succeeds ? { ok: true, result } : { ok: false, code: 'media_unavailable' } }) },
                onActionResult: (value) => { delivered.push(value); owner.retainActionResult(value); },
                mountedHostApiHandlers: { readStoredImage: owner.readStoredImage },
            });
            const action = source === 'raw Session events' ? 'session.events.get' : { pluginId: 'acme.media', localId: 'read' };
            const actionRequest = executeActionRequest({ action, input: { sessionId: 'session-1', includeRaw: true } });
            try {
                expect(await api.handleRequest(readRequest)).toMatchObject({ code: 'unavailable' });
                expect(await api.handleRequest(actionRequest)).toMatchObject({ code: 'unavailable' });
                expect(await api.handleRequest(readRequest)).toMatchObject({ code: 'unavailable' });
                expect(readInputs).toEqual([]);
                expect(delivered).toEqual([]);
                succeeds = true;
                expect(await api.handleRequest(actionRequest)).toEqual(result);
                expect(await api.handleRequest(readRequest)).toEqual(image);
                expect(readInputs).toEqual([{ callerPluginId: CALLER_PLUGIN_ID, expectedCallerOccurrenceId: 'occ-1', media }]);
                expect(delivered).toEqual([result]);
            } finally {
                api.dispose?.();
                owner.dispose();
            }
        },
    );
});

async function runMountedHomeApproval(custody: PluginSourceCustodyV1, retireBeforeReplay = false, entityDrop = false, waived = false) {
    let stored: ApprovalRequest | null = null;
    let currentCustody = custody;
    const effects: Parameters<NonNullable<ActionExecutorDeps['homeDomainAction']>>[0][] = [];
    const settings = normalizeActionsSettingsV1(retireBeforeReplay ? {
        v: 1,
        approvalWaivedSurfaces: { 'teams.members.remove': ['plugin'] },
        actions: { 'teams.members.remove': { approvalRequiredSurfaces: ['plugin'] } },
    } : waived ? { v: 1, approvalWaivedSurfaces: { 'teams.members.remove': ['plugin'] } } : { v: 1 });
    // Only persistence and Home/daemon request boundaries are substituted. The
    // public dispatcher, policy, Artifact transitions and replay remain real.
    const deps = {
        isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
        homeDomainAction: async (request) => {
            effects.push(request);
            return { status: 'removed', membershipId: 'membership-1' };
        },
        approvalsCreate: async ({ request }) => {
            stored = ApprovalRequestV2Schema.parse(request);
            return { artifactId: 'approval-home-1' };
        },
        approvalsGet: async () => stored,
        approvalsUpdate: async ({ request }) => {
            if (!stored) throw new Error('Approval not created');
            const transition = decideApprovalRequestTransition(stored, request);
            if (!transition.ok) return transition;
            stored = ApprovalRequestV2Schema.parse(request);
            return { ok: true as const };
        },
        isApprovalExecutionOriginCurrent: async ({ origin }) => origin.caller.kind === 'plugin'
            && origin.caller.pluginId === CALLER_PLUGIN_ID
            && pluginSourceCustodyV1Equal(origin.caller.sourceCustody, currentCustody),
    } satisfies Partial<ActionExecutorDeps>;
    // This boundary fixture intentionally omits unrelated Session/Agent ports; only the exercised external ports are supplied.
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    const api = createPluginSurfaceActionHostApi({
        surfaceContext: surfaceContext(),
        callerBinding: mountedCallerBinding(),
        callerSourceCustody: custody,
        hostAction: {
            execute: executor.execute,
            context: {
                serverId: 'home-1', runtimeAccountId: 'account-1',
                actionRequestId: 'request-home-1', executionRunTargetMachineId: 'machine-1',
            },
        },
    });
    try {
        const actionInput = { v: 1, teamId: 'team-1', membershipId: 'membership-1' };
        let response: PluginUiJsonValueV1 = null;
        let dropOutcome;
        if (entityDrop) {
            const runtime = createEntityDragDropRuntime();
            const scope = { serverId: 'home-1', accountId: 'account-1' };
            const target = { descriptor: { id: 'team', title: 'Team', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web' as const], acceptedKinds: ['session' as const], actions: [{ kind: 'host' as const, actionId: 'teams.members.remove' as const }] },
                resolve: () => ({ status: 'allowed' as const, effect: { actionId: 'teams.members.remove', input: actionInput, preview: { verb: 'Remove', target: 'Member' } } }), isCurrent: () => true };
            const binding = createPluginEntityDragDropBinding({ runtime, pluginId: CALLER_PLUGIN_ID, mountKey: 'surface', scope, isCurrent: () => true, readSource: () => null, readTarget: () => target,
                executeAction: async (action, input) => {
                    response = await api.handleRequest(executeActionRequest({ action, input }));
                    return settlePluginEntityDropActionResult(response, action);
                } });
            runtime.registerSource({ id: 'session', scope, isCurrent: () => true, getItem: () => ({ kind: 'session', scope, address: { serverId: 'home-1', sessionId: 'session-1' } }) });
            binding.mountTarget({ mountId: 'team', targetId: 'team', getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) });
            const carry = runtime.begin('session')!; carry.move({ x: 10, y: 10 });
            dropOutcome = await carry.release();
            binding.dispose();
        } else response = await api.handleRequest(executeActionRequest({ action: 'teams.members.remove', input: actionInput }));
        if (!waived) {
            expect(response).toMatchObject({ kind: 'approval_request_created', artifactId: 'approval-home-1' });
            expect(effects).toEqual([]);
        }
        const effectsAtDrop = [...effects];
        if (retireBeforeReplay) currentCustody = { kind: 'development', registeredRootId: 'replacement-root' };
        const decision = waived ? null : await executor.execute('approval.request.decide', {
            artifactId: 'approval-home-1', decision: 'approve',
        }, { surface: 'ui', authority: 'present_user', serverId: 'home-1' });
        return { response, decision, effects, dropOutcome, effectsAtDrop, stored: () => stored };
    } finally {
        api.dispose?.();
    }
}

describe('plugin-surface action branch selection', () => {
    it.each(['same input', 'changed input'] as const)('executes independent physical drops with %s separately while exact request replay stays once', async (variation) => {
        const identity = { pluginId: CALLER_PLUGIN_ID, localId: 'publish-drop' };
        const projected = PluginProjectedActionV2Schema.parse({
            ...resolveDaemonTargetAction(identity),
            operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } },
        });
        const store = createActionOperationStore();
        const runner = createActionOperationRunner({ store, resolveAction: actionId => ({ actionId, title: 'Publish drop', operation: projected.operation }) });
        const effects: unknown[] = [];
        const issued: PluginUiHostApiRequestEnvelopeV1[] = [];
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(), callerBinding: mountedCallerBinding(),
            resolveContributedAction: requested => requested.pluginId === identity.pluginId && requested.localId === identity.localId ? projected : null,
            contributedAction: { ...mountedActionBinding(),
                // This is the UI-to-daemon transport boundary. The canonical
                // daemon observer/store remain real, not a duplicate deduper.
                execute: async (_machineId, request) => {
                    const result = await runner.observe({ actionId: request.qualifiedActionId, requestId: request.requestId,
                        input: request.input, scope: { accountId: 'account-1', machineId: 'machine-1' },
                        // The third-party plugin effect is outside the host's deterministic logic.
                        execute: async () => { effects.push(request.input); return { ok: true, result: { published: effects.length } }; },
                    });
                    return { supported: true, result: DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(result.ok
                        ? result : { ok: false, code: result.errorCode }) };
                },
            },
        });
        const mounted = { surfaceContext: surfaceContext(), hostApi: { handleRequest: (request: PluginUiHostApiRequestEnvelopeV1) => {
            issued.push(request); return api.handleRequest(request);
        } } };
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'server-1', accountId: 'account-1' };
        let input: PluginUiJsonValueV1 = { title: 'First' };
        const target = { descriptor: { id: 'publish', title: 'Publish', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web' as const],
            acceptedKinds: ['session' as const], actions: [{ kind: 'plugin' as const, action: identity }] },
            resolve: () => ({ status: 'allowed' as const, effect: { actionId: `plugin:${buildQualifiedPluginContributionKey(identity)}`, input,
                preview: { verb: 'Publish', target: 'Session' } } }), isCurrent: () => true };
        const binding = createPluginEntityDragDropBinding({ runtime, pluginId: CALLER_PLUGIN_ID, mountKey: 'repeat-drop', scope, isCurrent: () => true,
            readSource: () => null, readTarget: () => target,
            executeAction: (action, value) => executeMountedPluginEntityDropAction(mounted, action, value),
        });
        const retireSource = runtime.registerSource({ id: 'session', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'session-1' } }) });
        binding.mountTarget({ mountId: 'publish', targetId: 'publish', getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) });
        try {
            const first = runtime.begin('session')!; first.move({ x: 10, y: 10 });
            expect(await first.release()).toEqual({ status: 'applied' });
            if (variation === 'changed input') input = { title: 'Second' };
            const second = runtime.begin('session')!; second.move({ x: 10, y: 10 });
            expect(await second.release()).toEqual({ status: 'applied' });
            expect(effects).toEqual([{ title: 'First' }, variation === 'changed input' ? { title: 'Second' } : { title: 'First' }]);
            expect(store.list({ accountId: 'account-1', machineId: 'machine-1' }).items).toHaveLength(2);
            expect(new Set(issued.map(request => request.requestId)).size).toBe(2);
            expect(await api.handleRequest(issued[0]!)).toEqual({ published: 1 });
            expect(effects).toHaveLength(2);
        } finally { binding.dispose(); retireSource(); api.dispose?.(); }
    });
    it('keeps mounted entity drops on the real approval/provenance and explicit-waiver front door', async () => {
        const custody = { kind: 'development' as const, registeredRootId: 'caller-root' };
        const approval = await runMountedHomeApproval(custody, false, true);
        expect(approval.dropOutcome).toMatchObject({ status: 'refused', reason: { code: 'approval_required' } });
        expect(approval.effectsAtDrop).toEqual([]);
        expect(approval.stored()).toMatchObject({ executionOriginV1: { caller: { kind: 'plugin', pluginId: CALLER_PLUGIN_ID, sourceCustody: custody } } });
        const waiver = await runMountedHomeApproval(custody, false, true, true);
        expect(waiver.dropOutcome).toEqual({ status: 'applied' });
        expect(waiver.effectsAtDrop).toHaveLength(1);
        expect(waiver.stored()).toBeNull();
    });
    it('requires real UI approval for an automated nested mutation and retains an issued acknowledgement loss as unknown', async () => {
        const nestedIdentity = { pluginId: CALLER_PLUGIN_ID, localId: 'change-remote' };
        const nestedAction = PluginProjectedActionV2Schema.parse({
            id: nestedIdentity.localId, pluginId: nestedIdentity.pluginId, occurrenceId: `occurrence-${CALLER_PLUGIN_ID}`,
            title: 'Change remote state', scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' },
            dangerLevel: 'writesRemote', confirmation: { title: 'Apply change?' }, available: true,
        });
        let confirm!: () => void;
        let dialogShown!: () => void;
        const shown = new Promise<void>((resolve) => { dialogShown = resolve; });
        nestedActionConfirmation.onShow = (approve) => { confirm = approve; dialogShown(); };
        const requests: unknown[] = [];
        machineRpcWithServerScopeMock.mockImplementation(async (request: Readonly<{ method: string; payload?: unknown; onIssued?: () => void }>) => {
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) return answerActionSchemasRead(request);
            requests.push(request.payload); request.onIssued?.();
            throw new Error('acknowledgement lost after the nested mutation was emitted');
        });
        const activation = createClientActionActivation({
            surfaces: ['agent'], handler: async (_input, context) => await context.ui.executeAction(nestedIdentity, {}),
        });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const pending = dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, invocationSurface: 'agent',
                resolveContributedAction: (identity) => identity.localId === nestedIdentity.localId ? nestedAction : resolveExactClientAction(activation.action)(identity),
                clientAction: {},
            });
            await shown;
            expect(requests).toEqual([]);
            confirm();
            expect(await pending).toMatchObject({ ok: false, reason: 'plugin_ui_action_outcome_unknown' });
            expect(requests).toEqual([expect.objectContaining({ executionSurface: 'agent', presentUserIntent: 'confirmed', invocation: expect.objectContaining({ kind: 'clientPluginAction' }) })]);
            expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse(requests[0]).success).toBe(true);
        } finally { nestedActionConfirmation.onShow = null; await activation.composition.unload(); }
    });

    it('opens the canonical New Session draft from an unmounted client Action', async () => {
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({
            accountLifetime,
            handler: async (_input, context) => {
                await context.ui.openNewSession({ prompt: 'Repair the selected issue' });
                return null;
            },
        });
        newSessionNavigation.mockClear();
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            await expect(dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
            })).resolves.toEqual({ ok: true, result: null });
            const route = newSessionNavigation.mock.calls[0]?.[0] as Readonly<{ pathname: string; params: { draftId: string } }>;
            expect(route.pathname).toBe('/new');
            const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
            expect(readNewSessionDraftFromRepository({ scope: accountLifetime.scope, draftId: route.params.draftId }))
                .toMatchObject({ input: 'Repair the selected issue' });
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('reads an unmounted client Action target projection from its registered authority', async () => {
        const targetedContributions = {
            target: { pluginId: CALLER_PLUGIN_ID, occurrenceId: `occurrence-${CALLER_PLUGIN_ID}`, sourceCustody: TARGET_SOURCE_CUSTODY },
            points: [],
        };
        machineRpcWithServerScopeMock.mockImplementation(async (request: Readonly<{ method: string }>) => (
            request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ
                ? { status: 'current', targetedContributions, targetedSurfaceMounts: [] }
                : answerActionSchemasRead(request)
        ));
        const activation = createClientActionActivation({
            accountLifetime: clientAccountLifetime(),
            handler: async (_input, context) => ({
                ...(await context.ui.context()),
                supportsSelection: context.ui.version().methods.includes('selectActionInput'),
            }),
        });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            await expect(dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                input: null,
                resolveContributedAction: resolveExactClientAction(activation.action),
                clientAction: {},
            })).resolves.toEqual({ ok: true, result: { targetedContributions, supportsSelection: true } });
            expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
                method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ,
                machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
                serverId: 'server-client-action',
                payload: expect.objectContaining({ pluginId: CALLER_PLUGIN_ID }),
            }));
        } finally {
            await activation.composition.unload();
        }
    });

    it('refuses source handles from a newer target occurrence while the client Action remains registered', async () => {
        machineRpcWithServerScopeMock.mockImplementation(async (request: Readonly<{ method: string }>) => (
            request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ
                ? { status: 'current', targetedContributions: {
                    target: { pluginId: CALLER_PLUGIN_ID, occurrenceId: 'replacement-target', sourceCustody: TARGET_SOURCE_CUSTODY },
                    points: [],
                }, targetedSurfaceMounts: [] }
                : answerActionSchemasRead(request)
        ));
        const activation = createClientActionActivation({
            accountLifetime: clientAccountLifetime(),
            handler: async (_input, context) => {
                await expect(context.ui.context()).rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
                return { refused: true };
            },
        });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            await expect(dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: null,
                resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
            })).resolves.toEqual({ ok: true, result: { refused: true } });
        } finally {
            await activation.composition.unload();
        }
    });

    it('relays only host-admitted input from an unmounted client Action through its bound daemon authority', async () => {
        const operation = COMPOSED_TARGETED_OPERATION;
        const targetedContributions = { ...COMPOSED_TARGETED_CONTRIBUTIONS, target: {
            ...COMPOSED_TARGETED_CONTRIBUTIONS.target, occurrenceId: `occurrence-${CALLER_PLUGIN_ID}`,
        } };
        const selectedAction = PluginProjectedActionV2Schema.parse({
            id: operation.action.localId, pluginId: operation.action.pluginId,
            occurrenceId: operation.contributor.occurrenceId, title: 'Prepare',
            scopes: ['global'], surfaces: ['plugin'], execution: { target: 'daemon' },
            dangerLevel: 'safe', available: true,
        });
        const relayAction = PluginProjectedActionV2Schema.parse({
            id: 'start-reviewed', pluginId: CALLER_PLUGIN_ID, occurrenceId: `occurrence-${CALLER_PLUGIN_ID}`,
            title: 'Start reviewed', scopes: ['global'], surfaces: ['ui'], execution: { target: 'daemon' },
            dangerLevel: 'safe', available: true,
        });
        // Selection reads the declared schema from its daemon, not the projection.
        clientActionSchemasByQualifiedId.set(buildQualifiedPluginContributionKey(operation.action), {
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        });
        machineRpcWithServerScopeMock.mockImplementation(async (request: Readonly<{ method: string }>) => {
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
                return { status: 'current', targetedContributions, targetedSurfaceMounts: [] };
            }
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {},
                    installedPackagesById: { [selectedAction.pluginId]: {
                        id: selectedAction.pluginId, displayName: 'Reviewer', version: '1.0.0', enabled: true,
                        source: { kind: 'localPath', locator: 'reviewer' },
                    } }, actionsById: { [`${selectedAction.pluginId}/${selectedAction.id}`]: selectedAction },
                } };
            }
            return answerActionSchemasRead(request);
        });
        const transported: unknown[] = [];
        const activation = createClientActionActivation({
            accountLifetime: clientAccountLifetime(),
            handler: async (_input, context) => {
                const selected = await context.ui.selectActionInput({ operation, draft: {} });
                if (selected.kind !== 'submitted') throw new Error('selection did not submit');
                const carrier = { operation, result: selected };
                await expect(context.ui.executeAction('start-reviewed', {}, {
                    selectedActionInput: { ...carrier, result: { ...selected, input: { forged: true } } },
                })).rejects.toMatchObject({ code: 'plugin_surface_targeted_selection_invalid' });
                await context.ui.executeAction('start-reviewed', { selection: selected }, { selectedActionInput: carrier });
                return { selected };
            },
        });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const result = await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: null,
                resolveContributedAction: (identity) => identity.localId === relayAction.id
                    ? relayAction : resolveExactClientAction(activation.action)(identity),
                clientAction: { execute: async (machineId, request) => {
                    transported.push({ machineId, ...request });
                    return { supported: true, result: { ok: true, result: null } };
                } },
            });
            expect(result).toEqual({ ok: true, result: expect.objectContaining({ selected: expect.objectContaining({ kind: 'submitted', input: {} }) }) });
            expect(transported).toEqual([expect.objectContaining({
                machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
                serverId: 'server-client-action',
                invocation: expect.objectContaining({ kind: 'clientPluginAction' }),
                selectedActionInputCarrier: expect.objectContaining({ operation,
                    result: expect.objectContaining({ selection: expect.objectContaining({ target: {
                        pluginId: CALLER_PLUGIN_ID, sourceCustody: TARGET_SOURCE_CUSTODY,
                    } }) }),
                }),
            })]);
        } finally {
            await activation.composition.unload();
        }
    });

    it('reads the current UI snapshot only after current-intent approval for a writes-remote client Action', async () => {
        const snapshotAtDispatch: CurrentUiContextSnapshotV1 = {
            navigation: { area: 'app' as const, screen: 'initial' },
            commands: [],
        };
        let currentSnapshot = snapshotAtDispatch;
        const snapshotAfterApproval: CurrentUiContextSnapshotV1 = {
            navigation: { area: 'plugin' as const, screen: 'issue-detail', title: 'Issue 42' },
            entity: { kind: 'issue', label: 'Issue 42' },
            commands: [],
        };
        const readCurrentUiContext = vi.fn(() => currentSnapshot);
        let resolveCurrentIntent!: (result: Readonly<{
            status: 'approved';
            fingerprint: string;
        }>) => void;
        let requestedFingerprint!: string;
        let currentIntentRequested!: () => void;
        const currentIntentRequestedPromise = new Promise<void>((resolve) => {
            currentIntentRequested = resolve;
        });
        const handler = vi.fn(async (_input: PluginUiJsonValueV1, context: Parameters<PluginClientActionHandler>[1]) => ({
            currentUiContext: context.currentUiContext ?? null,
        }));
        const activation = createClientActionActivation({
            dangerLevel: 'writesRemote',
            handler,
        });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const requestCurrentIntent = vi.fn(({ fingerprint }: Readonly<{ fingerprint: string }>) => {
                requestedFingerprint = fingerprint;
                currentIntentRequested();
                return new Promise<PluginActionCurrentIntentResult>((resolve) => { resolveCurrentIntent = resolve; });
            });
            const pending = dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(activation.action),
                clientAction: {
                    currentUiContext: readCurrentUiContext,
                },
                requestCurrentIntent,
            });
            await currentIntentRequestedPromise;
            expect(readCurrentUiContext).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();

            currentSnapshot = snapshotAfterApproval;
            resolveCurrentIntent({
                status: 'approved',
                fingerprint: requestedFingerprint,
            });

            await expect(pending).resolves.toEqual({
                ok: true,
                result: {
                    currentUiContext: snapshotAfterApproval,
                },
            });
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith(null, expect.objectContaining({
                currentUiContext: snapshotAfterApproval,
            }));
            expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
            expect(readCurrentUiContext).toHaveBeenCalledTimes(1);
        } finally {
            await activation.composition.unload();
        }
    });

    it('invokes an Action-only exact client registration without daemon fallback', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { daemonShouldNotRun: true } },
        }));
        let receivedContext: unknown;
        const handler = vi.fn(async (input: PluginUiJsonValueV1, context: unknown) => {
            receivedContext = context;
            return { input, executed: true };
        });
        const clientHandler: PluginClientActionHandler = async (input, context) => handler(input, context);
        const activation = createClientActionActivation({ handler: clientHandler });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await expect(activation.composition.reconcile([activation.activation])).resolves.toEqual([
                expect.objectContaining({ result: { ok: true } }),
            ]);

            await expect(dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: { source: 'surface' },
                resolveContributedAction: resolveExactClientAction(action),
                // A daemon outage must not decide a client Action's availability.
                isContributedActionAvailable: () => false,
                contributedAction: {
                    ...mountedActionBinding(),
                    execute: contributed,
                },
                clientAction: {
                },
            })).resolves.toEqual({
                ok: true,
                result: {
                    input: { source: 'surface' },
                    executed: true,
                },
            });

            expect(receivedContext).toEqual(expect.objectContaining({
                plugin: { id: CALLER_PLUGIN_ID, version: '1.2.3' },
                contribution: {
                    id: 'refresh-index',
                    qualifiedId: `${CALLER_PLUGIN_ID}/actions/refresh-index`,
                },
                invocationSurface: 'ui',
            }));

            expect(resolvePluginUiClientActionRegistration({
                action,
                platform: CLIENT_ACTION_TARGET.platform,
                reader: activation.composition,
            })).not.toBeNull();
            expect(handler).toHaveBeenCalledTimes(1);
            expect(contributed).not.toHaveBeenCalled();
        } finally {
            await activation.composition.unload();
        }
    });

    it('addresses a client Action by its member generation while the union generation fences currentness', async () => {
        const handler = vi.fn(async () => ({ executed: true }));
        const activation = createClientActionActivation({ handler });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            await expect(dispatchPluginResolvedSemanticCommand({
                projection: Object.freeze({
                    ...activation.projection,
                }),
                callerPluginId: CALLER_PLUGIN_ID,
                command: {
                    kind: 'executeAction',
                    action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                },
                scopedLaunchFacts: {
                    serverId: null,
                    machineId: null,
                    interactionEnabled: true,
                },
                scopeIsCurrent: () => true,
            })).resolves.toEqual({ ok: true, result: { executed: true } });

            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await activation.composition.unload();
        }
    });

    it('retains exact-origin nested daemon transport through the real client semantic Action router', async () => {
        const transport = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true,
            result: { ok: true, result: { rows: ['observed'] } },
        }));
        const activation = createClientActionActivation({
            handler: async (_input, context) => context.ui.executeAction('list', { limit: 1 }),
        });
        const list = resolveDaemonTargetAction({ pluginId: CALLER_PLUGIN_ID, localId: 'list' });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const observed = await dispatchPluginResolvedSemanticCommand({
                projection: {
                    ...activation.projection,
                    actionsById: { ...activation.projection.actionsById, [`${CALLER_PLUGIN_ID}/list`]: list },
                },
                callerPluginId: CALLER_PLUGIN_ID,
                command: { kind: 'executeAction', action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: null },
                // The per-contribution origin must win over another ambient machine.
                scopedLaunchFacts: { ...CLIENT_ACTION_HOST_ORIGIN, machineId: 'ambient-other-machine', serverId: 'ambient-other-server' },
                scopeIsCurrent: () => true,
                execute: transport,
            });
            expect(observed).toEqual({ ok: true, result: { rows: ['observed'] } });
            expect(transport).toHaveBeenCalledWith(CLIENT_ACTION_ORIGIN.materializationRef.machineId, expect.objectContaining({
                serverId: CLIENT_ACTION_HOST_ORIGIN.serverId,
                expectedContributorOccurrenceId: activation.action.occurrenceId,
                invocation: {
                    kind: 'clientPluginAction',
                    clientActionBinding: {
                        pluginId: activation.action.pluginId,
                        contributionLocalId: activation.action.id,
                        occurrenceId: activation.action.occurrenceId,
                        materializationRef: CLIENT_ACTION_ORIGIN.materializationRef,
                    },
                },
            }));
        } finally {
            await activation.composition.unload();
        }
    });

    it('answers cold Triage Search through activation, semantic routing and the shared acquisition owner', async () => {
        const { createTriageSearchEntriesActionHandler } = await import('../../../../../../packages/plugins/triage/src/actions/searchEntries');
        const { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema } = await import('../../../../../../packages/plugins/triage/src/actions/listEntriesProtocol');
        const { TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1 } = await import('../../../../../../packages/plugins/triage/src/actions/searchEntriesProtocol');
        const { acquireTriageListWindow } = await import('../../../../../../packages/plugins/triage/src/ui/window/mountedWindow');
        const { testkitEntryRef, testkitObservation, TRIAGE_TESTKIT_SOURCE, TESTKIT_SOURCE_INSTANCE_ID } = await import('../../../../../../packages/plugins/triage/src/corpus/testkit/observations.test-support');
        const { PluginSearchQueryV1Schema, PluginSearchResultV1Schema } = await import('@happier-dev/protocol');
        const handler = createTriageSearchEntriesActionHandler();
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({
            pluginId: 'happier.triage',
            localId: TRIAGE_SEARCH_ENTRIES_ACTION_LOCAL_ID_V1,
            handler: (value, context) => handler(PluginSearchQueryV1Schema.parse(value), context),
            accountLifetime,
            occurrenceId: 'triage-cold-search-generation',
        });
        const entryRef = testkitEntryRef();
        const result = TriageListEntriesResultV1Schema.parse({
            v: 1,
            configuredSources: [{ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, source: TRIAGE_TESTKIT_SOURCE, available: true }],
            configuredSourcesStatus: 'complete',
            window: {
                v: 1,
                rows: [{
                    entryRef,
                    lane: '1-open',
                    sortAtMs: 1,
                    presence: { kind: 'present', observedAtMs: 1 },
                    selected: { kind: 'selected', sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, reason: 'onlyPresent' },
                    observation: testkitObservation(),
                    otherObservations: [],
                    observedByCount: 1,
                }],
                lanes: [{ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, source: TRIAGE_TESTKIT_SOURCE, health: { kind: 'walkFinished' }, exhausted: true }],
                coverage: 'complete',
                assembledAtMs: 1,
            },
        });
        // Only the daemon transport is substituted. The real client handler,
        // host sharing scope, cold acquisition, folding and matching execute.
        const mountedScope = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: 'happier.triage',
            occurrenceId: 'triage-cold-search-generation',
            executionOrigin: clientActionExecutionOrigin('happier.triage'),
            isCurrent: accountLifetime.isCurrent,
        });
        let mountedLease: ReturnType<typeof acquireTriageListWindow> | undefined;
        const mountedRead = vi.fn(async () => result);
        const transport = vi.fn<PluginSurfaceContributedActionTransport>(async () => {
            // A surface joins after the client initiated the cold read. Its
            // lease retains that same window for the next warm Search.
            mountedLease ??= acquireTriageListWindow({ executeAction: mountedRead }, mountedScope);
            return { supported: true, result: { ok: true, result: PluginJsonValueV2Schema.parse(result) } };
        });
        const list = resolveDaemonTargetAction({ pluginId: 'happier.triage', localId: TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 });
        const projection = {
            ...activation.projection,
            installedPackagesById: {
                ...activation.projection.installedPackagesById,
                'happier.triage': {
                    ...activation.projection.installedPackagesById['happier.triage']!,
                    occurrenceId: 'triage-cold-search-generation',
                },
            },
            actionsById: { ...activation.projection.actionsById, [`happier.triage/${list.id}`]: list },
        };
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const outcome = await dispatchPluginResolvedSemanticCommand({
                projection,
                callerPluginId: 'happier.triage',
                command: { kind: 'executeAction', action: { pluginId: 'happier.triage', localId: activation.action.id }, input: { query: 'normalizer', limit: 8 } },
                scopedLaunchFacts: CLIENT_ACTION_HOST_ORIGIN,
                scopeIsCurrent: () => true,
                accountLifetime,
                execute: transport,
            });
            expect(outcome.ok).toBe(true);
            if (!outcome.ok || !('result' in outcome)) throw new Error('Cold Triage Search did not execute');
            expect(PluginSearchResultV1Schema.parse(outcome.result)).toMatchObject({
                items: [{ title: 'Replace the duplicated normalizer', command: { kind: 'openSurface' } }],
                truncated: false,
            });
            expect(transport).toHaveBeenCalledWith(CLIENT_ACTION_ORIGIN.materializationRef.machineId, expect.objectContaining({
                qualifiedActionId: `happier.triage/${TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1}`,
            }));
            const readsAfterColdSearch = transport.mock.calls.length;
            const warm = await dispatchPluginResolvedSemanticCommand({
                projection,
                callerPluginId: 'happier.triage',
                command: { kind: 'executeAction', action: { pluginId: 'happier.triage', localId: activation.action.id }, input: { query: 'normalizer', limit: 8 } },
                scopedLaunchFacts: CLIENT_ACTION_HOST_ORIGIN,
                scopeIsCurrent: accountLifetime.isCurrent,
                accountLifetime,
                execute: transport,
            });
            expect(warm).toEqual(outcome);
            expect(mountedRead).not.toHaveBeenCalled();
            expect(transport).toHaveBeenCalledTimes(readsAfterColdSearch);
        } finally {
            mountedLease?.release();
            accountLifetime.retire();
            await activation.composition.unload();
        }
    });

    it('rejects a new navigation from a suspended client handler after its invocation is cancelled', async () => {
        let enter!: () => void;
        let resume!: () => void;
        let finish!: () => void;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const resumed = new Promise<void>((resolve) => { resume = resolve; });
        const finished = new Promise<void>((resolve) => { finish = resolve; });
        const navigation = vi.fn(async () => ({ ok: true as const }));
        const abort = new AbortController();
        let navigationError: unknown;
        const activation = createClientActionActivation({
            handler: async (_input, context) => {
                enter();
                await resumed;
                try {
                    await context.ui.openSurface('detail', null);
                } catch (error) {
                    navigationError = error;
                } finally {
                    finish();
                }
                return null;
            },
        });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const invocation = dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: activation.action.id,
                input: null,
                resolveContributedAction: resolveExactClientAction(activation.action),
                clientAction: { openSurface: navigation },
                signal: abort.signal,
                isCurrent: () => true,
            });
            await entered;
            abort.abort();
            resume();
            await finished;
            expect(await invocation).toMatchObject({ ok: false, reason: 'plugin_ui_action_outcome_unknown' });
            expect(navigation).not.toHaveBeenCalled();
            expect(navigationError).toMatchObject({ code: 'plugin_action_aborted' });
        } finally {
            resume();
            await activation.composition.unload();
        }
    });

    it('gives a client Action the shared scope and host-stamps nested daemon Action provenance', async () => {
        const accountLifetime = clientAccountLifetime();
        let nestedRequest: Parameters<PluginSurfaceContributedActionTransport> | undefined;
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async (...request) => {
            nestedRequest = request;
            return {
                supported: true as const,
                result: { ok: true as const, result: { rows: ['shared'] } },
            };
        });
        let nestedError: unknown;
        const handler: PluginClientActionHandler = async (_input, context) => {
            expect(context.ephemeralSharedScope).not.toBeNull();
            try {
                return await context.ui.executeAction('list', { limit: 1 });
            } catch (error) {
                nestedError = error;
                throw error;
            }
        };
        const activation = createClientActionActivation({ handler, accountLifetime });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const resolveContributedAction = (identity: PluginContributionIdentityV1) => (
                identity.localId === activation.action.id
                    ? activation.action
                    : resolveDaemonTargetAction(identity)
            );
            const outcome = await dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: activation.action.id,
                input: null,
                resolveContributedAction,
                contributedAction: {
                    ...mountedActionBinding({ machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId }),
                    execute: contributed,
                },
                clientAction: {
                },
            });
            expect(nestedError).toBeUndefined();
            expect(outcome).toEqual({ ok: true, result: { rows: ['shared'] } });
            expect(contributed).toHaveBeenCalledTimes(1);
            const [machineId, options] = nestedRequest!;
            const { serverId: _serverId, timeoutMs: _timeoutMs, signal: _signal, ...wireOptions } = options;
            expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
                machineId,
                ...wireOptions,
            }).invocation).toEqual({
                kind: 'clientPluginAction',
                clientActionBinding: {
                    pluginId: CALLER_PLUGIN_ID,
                    contributionLocalId: 'refresh-index',
                    occurrenceId: activation.action.occurrenceId,
                    materializationRef: CLIENT_ACTION_ORIGIN.materializationRef,
                },
            });
        } finally {
            await activation.composition.unload();
        }
    });

    it('does not give an outer plugin shared scope to a nested cross-plugin client Action', async () => {
        const accountLifetime = clientAccountLifetime();
        const targetPluginId = 'happier.cross-plugin-target';
        const targetScope = getPluginUiEphemeralSharedScope({
            accountLifetime,
            pluginId: targetPluginId,
            occurrenceId: `occurrence-${targetPluginId}`,
            executionOrigin: clientActionExecutionOrigin(targetPluginId),
            isCurrent: () => true,
        });
        const mountedLease = targetScope!.acquire('shared-window', () => ({ value: 'target-mounted-window', dispose() {} }))!;
        const targetHandler = vi.fn<PluginClientActionHandler>(async (_input, context) => {
            const lease = context.ephemeralSharedScope?.acquire('shared-window', () => ({ value: 'wrong-cold-window', dispose() {} }));
            try { return { value: lease?.value ?? null }; } finally { lease?.release(); }
        });
        const target = createClientActionActivation({
            pluginId: targetPluginId,
            localId: 'target-action',
            surfaces: ['ui', 'voice'],
            // This is a different installed plugin module. Giving it distinct
            // bytes keeps the fixture from asking the canonical composition
            // to coalesce two unrelated activate() functions as one module.
            artifactGraph: Object.freeze({
                ...CLIENT_ACTION_ARTIFACT_GRAPH,
                digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            }),
            handler: targetHandler,
            accountLifetime,
        });
        const caller = createClientActionActivation({
            accountLifetime,
            handler: async (_input, context) => context.ui.executeAction({
                pluginId: targetPluginId,
                localId: target.action.id,
            }, null),
        });
        await caller.composition.unload();
        try {
            await caller.composition.reconcile([caller.activation, target.activation]);
            const actions = [caller.action, target.action];
            const outcome = await dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: caller.action.id,
                input: null,
                resolveContributedAction: (identity) => actions.find((candidate) => (
                    candidate.pluginId === identity.pluginId && candidate.id === identity.localId
                )) ?? null,
                clientAction: {
                },
            });
            expect(outcome).toEqual({
                ok: true,
                result: { value: 'target-mounted-window' },
            });
            expect(targetHandler).toHaveBeenCalledTimes(1);
        } finally {
            mountedLease.release();
            await caller.composition.unload();
        }
    });

    it('retires client invocation scope with its Account and refuses stale nested work', async () => {
        const accountLifetime = clientAccountLifetime();
        let retainedContext: Parameters<PluginClientActionHandler>[1] | undefined;
        const dispose = vi.fn();
        const activation = createClientActionActivation({
            accountLifetime,
            handler: async (_input, context) => {
                retainedContext = context;
                const lease = context.ephemeralSharedScope?.acquire('account-window', () => ({ value: 'account-a', dispose }));
                return { value: lease?.value ?? null };
            },
        });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            expect(await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                resolveContributedAction: resolveExactClientAction(activation.action),
                clientAction: {},
            })).toEqual({ ok: true, result: { value: 'account-a' } });
            accountLifetime.retire();
            expect(dispose).toHaveBeenCalledOnce();
            expect(retainedContext!.ephemeralSharedScope!.acquire('account-window', () => ({ value: 'invalid', dispose }))).toBeNull();
            await expect(retainedContext!.ui.executeAction('list', null)).rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
        } finally {
            accountLifetime.retire();
            await activation.composition.unload();
        }
    });

    it('validates client Action input against the per-Action daemon schema and returns trusted plugin output as-is', async () => {
        const inputSchema = defineProtocolObject({
            title: defineProtocolString({ minLength: 1 }),
        }, { policy: 'additive-open/drop' }).jsonSchema;
        const outputSchema = defineProtocolObject({
            accepted: defineProtocolLiteral(true),
        }, { policy: 'additive-open/drop' }).jsonSchema;
        const handler = vi.fn(async (input: PluginUiJsonValueV1) => ({
            accepted: true,
            privateResult: input,
        }));
        const clientHandler: PluginClientActionHandler = async (input, context) => {
            expect(context).toBeDefined();
            return handler(input);
        };
        const activation = createClientActionActivation({
            handler: clientHandler,
            inputSchema,
            outputSchema,
        });
        const action = activation.action;
        const rpcCallsBefore = machineRpcWithServerScopeMock.mock.calls.length;
        // The bulk projection carries no schemas; dispatch reads them per Action.
        expect(action).not.toHaveProperty('inputSchema');
        expect(action).not.toHaveProperty('outputSchema');
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const dispatchInput = (input: PluginUiJsonValueV1) => dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input,
                resolveContributedAction: resolveExactClientAction(action),
                clientAction: {},
            });

            await expect(dispatchInput({ title: '' })).resolves.toMatchObject({ ok: false });
            expect(handler).not.toHaveBeenCalled();
            await expect(dispatchInput({ title: 'Release', privateInput: true })).resolves.toEqual({
                ok: true,
                result: { accepted: true, privateResult: { title: 'Release' } },
            });
            expect(handler).toHaveBeenCalledWith({ title: 'Release' });
            const schemaReads = machineRpcWithServerScopeMock.mock.calls
                .slice(rpcCallsBefore)
                .map(([request]) => request as Readonly<{ method: string; machineId: string; serverId: string | null; payload: unknown }>)
                .filter((request) => request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ);
            // One read per Action occurrence, from the Action's own authority.
            expect(schemaReads).toEqual([expect.objectContaining({
                machineId: CLIENT_ACTION_HOST_ORIGIN.machineId,
                serverId: CLIENT_ACTION_HOST_ORIGIN.serverId,
                payload: {
                    machineId: CLIENT_ACTION_HOST_ORIGIN.machineId,
                    expectedOccurrenceId: action.occurrenceId,
                    qualifiedActionId: `${CALLER_PLUGIN_ID}/refresh-index`,
                },
            })]);
        } finally {
            await activation.composition.unload();
        }
    });

    it('does not repurpose an Action-only exact registration for a Voice invocation', async () => {
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const clientHandler: PluginClientActionHandler = async () => handler();
        const activation = createClientActionActivation({ handler: clientHandler });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);

            await expect(dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                invocationSurface: 'voice',
                clientAction: {},
            })).resolves.toEqual({
                ok: false,
                code: 'unavailable',
                reason: 'plugin_action_surface_unavailable',
            });
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await activation.composition.unload();
        }
    });

    it('invokes the same exact client Action registration from UI and Voice when both surfaces are declared', async () => {
        const handler = vi.fn(async (_input: PluginUiJsonValueV1, context: Parameters<PluginClientActionHandler>[1]) => ({
            invocationSurface: context.invocationSurface,
        }));
        const activation = createClientActionActivation({
            handler,
            surfaces: ['ui', 'voice'],
        });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);

            const common = {
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                clientAction: {},
            } as const;
            await expect(dispatchPluginSurfaceAction(common)).resolves.toEqual({
                ok: true,
                result: { invocationSurface: 'ui' },
            });
            await expect(dispatchPluginSurfaceAction({
                ...common,
                invocationSurface: 'voice',
            })).resolves.toEqual({
                ok: true,
                result: { invocationSurface: 'voice' },
            });

            expect(handler).toHaveBeenCalledTimes(2);
            expect(resolvePluginUiClientActionRegistration({
                action,
                platform: CLIENT_ACTION_TARGET.platform,
                reader: activation.composition,
            })).not.toBeNull();
        } finally {
            await activation.composition.unload();
        }
    });

    it('withdraws an exact client registration before a pending confirmation can enter its handler', async () => {
        let resolveIntent!: (result: Readonly<{
            status: 'approved';
            fingerprint: string;
        }>) => void;
        let intentRequested!: () => void;
        const intentRequestedPromise = new Promise<void>((resolve) => { intentRequested = resolve; });
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const clientHandler: PluginClientActionHandler = async () => handler();
        const activation = createClientActionActivation({
            dangerLevel: 'writesRemote',
            handler: clientHandler,
        });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const pending = dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: { source: 'surface' },
                resolveContributedAction: resolveExactClientAction(action),
                clientAction: {},
                requestCurrentIntent: () => {
                    intentRequested();
                    return new Promise((resolve) => { resolveIntent = resolve; });
                },
            });
            await intentRequestedPromise;
            await activation.composition.unload();
            resolveIntent({
                status: 'approved',
                fingerprint: 'the retired confirmation must not be accepted',
            });

            await expect(pending).resolves.toEqual({
                ok: false,
                code: 'stale_surface',
                reason: 'plugin_action_generation_retired',
            });
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await activation.composition.unload();
        }
    });

    it.each(['synchronous', 'asynchronous'] as const)('keeps a known %s client handler fulfillment when caller cancellation arrives afterwards', async (settlement) => {
        const cancellation = new AbortController();
        let handlerReturned!: () => void;
        const handlerReturnedPromise = new Promise<void>((resolve) => { handlerReturned = resolve; });
        const handler = vi.fn(() => {
            handlerReturned();
            const value = { committed: true };
            return settlement === 'synchronous' ? value : Promise.resolve(value);
        });
        const clientHandler: PluginClientActionHandler = () => handler();
        const activation = createClientActionActivation({ handler: clientHandler });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const pending = dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                signal: cancellation.signal,
                clientAction: {},
            });
            await handlerReturnedPromise;
            cancellation.abort(new Error('caller stopped after the client effect settled'));

            await expect(pending).resolves.toEqual({ ok: true, result: { committed: true } });
        } finally {
            await activation.composition.unload();
        }
    });

    it('projects post-handler client cancellation without a non-start proof as outcome unknown', async () => {
        const cancellation = new AbortController();
        let handlerEntered!: () => void;
        const handlerEnteredPromise = new Promise<void>((resolve) => { handlerEntered = resolve; });
        const handler = vi.fn(() => {
            handlerEntered();
            return new Promise<never>(() => {});
        });
        const clientHandler: PluginClientActionHandler = () => handler();
        const activation = createClientActionActivation({ handler: clientHandler });
        const action = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const pending = dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                signal: cancellation.signal,
                clientAction: {},
            });
            await handlerEnteredPromise;
            cancellation.abort(new Error('caller stopped after the client handler started'));

            await expect(pending).resolves.toEqual({
                ok: false,
                code: 'timeout',
                reason: 'plugin_ui_action_outcome_unknown',
            });
        } finally {
            await activation.composition.unload();
        }
    });

    it('does not bypass current-intent denial for a non-safe client Action', async () => {
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const clientHandler: PluginClientActionHandler = async () => handler();
        const activation = createClientActionActivation({
            dangerLevel: 'writesRemote',
            handler: clientHandler,
        });
        const action = activation.action;
        const requestCurrentIntent = vi.fn(async () => ({
            status: 'rejected' as const,
            code: 'plugin_action_current_intent_rejected',
        }));
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            await expect(dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                clientAction: {},
                requestCurrentIntent,
            })).resolves.toEqual({
                // A decline is a decision, not an absence. It must NOT settle as
                // `unavailable`: an autonomous caller reads that as a transient
                // gap and asks the same person again.
                ok: false,
                code: 'denied',
                reason: 'plugin_action_current_intent_rejected',
            });
            expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
            expect(handler).not.toHaveBeenCalled();
        } finally {
            await activation.composition.unload();
        }
    });

    // The selected-operation carrier is a dispatcher-level settlement, not a
    // daemon-transport detail. A client-target Action must receive the same
    // reconstructed selected input, the same exact-input comparison, and the
    // same mounted-target ownership rule as a daemon-target Action (C1).
    it('settles the host-selected operation before branching to a client Action', async () => {
        const handler = vi.fn(async (input: PluginUiJsonValueV1) => ({ received: input }));
        const clientHandler: PluginClientActionHandler = async (input) => handler(input);
        const activation = createClientActionActivation({ handler: clientHandler });
        const action = activation.action;
        const targetedOperation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: CALLER_PLUGIN_ID,
                contributionId: 'github-connection',
                occurrenceId: 'contributor-generation-a',
                sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
            },
            role: 'setup',
            action: { pluginId: CALLER_PLUGIN_ID, localId: 'refresh-index' },
        } as const;
        const account = {
            service: { pluginId: 'acme.github', localId: 'github' },
            accountId: 'account-a',
        } as const;
        const selectedActionInput = {
            kind: 'submitted' as const,
            action: targetedOperation.action,
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: {
                    pluginId: CALLER_PLUGIN_ID,
                    occurrenceId: 'target-generation-a',
                    sourceCustody: TARGET_SOURCE_CUSTODY,
                },
                point: targetedOperation.point,
                contributor: {
                    pluginId: targetedOperation.contributor.pluginId,
                    contributionId: targetedOperation.contributor.contributionId,
                    occurrenceId: targetedOperation.contributor.occurrenceId,
                    sourceCustody: targetedOperation.contributor.sourceCustody,
                },
            },
            connectedAccount: {
                kind: 'selected' as const,
                fieldPath: 'credentialRef',
                ref: account,
            },
            presentation: {
                connectedAccountLabel: 'Work account',
                machineDisplayName: 'Development Mac',
            },
        };
        const dispatch = (overrides: Partial<DispatchPluginSurfaceActionInput> = {}) => dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerSourceCustody: TARGET_SOURCE_CUSTODY,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: { pluginId: CALLER_PLUGIN_ID, localId: 'refresh-index' },
            input: { repository: 'happier-dev/happier' },
            resolveContributedAction: resolveExactClientAction(action),
            clientAction: {},
            targetedOperation,
            selectedActionInput,
            ...overrides,
        });

        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);

            // The selected Connected Account is reconstructed into the input the
            // client handler observes, exactly as on the daemon arm.
            await expect(dispatch()).resolves.toEqual({
                ok: true,
                result: {
                    received: {
                        repository: 'happier-dev/happier',
                        credentialRef: account,
                    },
                },
            });

            // A tampered input cannot ride an admitted selection.
            await expect(dispatch({ input: { repository: 'tampered' } })).resolves.toEqual({
                ok: false,
                code: 'invalid_payload',
                reason: 'plugin_surface_targeted_selection_invalid',
            });

            // The carrier is anchored to the exact mounted target.
            await expect(dispatch({
                selectedActionInput: {
                    ...selectedActionInput,
                    selection: {
                        ...selectedActionInput.selection,
                        target: { pluginId: 'other.plugin', sourceCustody: TARGET_SOURCE_CUSTODY },
                    },
                },
            })).resolves.toEqual({
                ok: false,
                code: 'invalid_payload',
                reason: 'plugin_surface_targeted_selection_invalid',
            });

            await expect(dispatch({
                selectedActionInput: {
                    ...selectedActionInput,
                    selection: {
                        ...selectedActionInput.selection,
                        target: {
                            pluginId: CALLER_PLUGIN_ID,
                            sourceCustody: {
                                kind: 'development',
                                registeredRootId: 'different-inspector-root',
                            },
                        },
                    },
                },
            })).resolves.toEqual({
                ok: false,
                code: 'invalid_payload',
                reason: 'plugin_surface_targeted_selection_invalid',
            });

            // A relay carrier is a daemon-request field with no client channel.
            // The combination is refused explicitly rather than executing with
            // the caller's selection silently dropped.
            const relayOperation = {
                ...targetedOperation,
                action: { pluginId: CALLER_PLUGIN_ID, localId: 'prepare-v1' },
            } as const;
            await expect(dispatch({
                targetedOperation: relayOperation,
                selectedActionInput: {
                    ...selectedActionInput,
                    action: relayOperation.action,
                },
            })).resolves.toEqual({
                ok: false,
                code: 'unsupported_method',
                reason: 'plugin_surface_targeted_selection_relay_unsupported',
            });

            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            await activation.composition.unload();
        }
    });

    it('composes exact mount-owned host semantics into the canonical facade and retires them with it', async () => {
        const readComposer = vi.fn(() => ({ status: 'unavailable' as const, reason: 'scopeClosed' as const }));
        const disposeHostResource = vi.fn(() => null);
        const disposeMountedHostApiHandlers = vi.fn();
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            mountedHostApiHandlers: { readComposer, disposeHostResource },
            disposeMountedHostApiHandlers,
        });
        const request = {
            version: 1 as const,
            requestId: 'composer-read',
            surface: surfaceContext(),
            method: 'readComposer' as const,
            payload: { ref: { kind: 'session' as const, sessionId: 'session-1' } },
        };

        expect(api.installedMethods).toContain('readComposer');
        expect(api.handleRequest(request)).toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        expect(readComposer).toHaveBeenCalledWith(request, undefined);

        await api.handleRequest({
            ...request,
            requestId: 'composer-dispose',
            method: 'disposeHostResource',
            payload: { subscriptionId: 'composer-watch-1' },
        });
        expect(disposeHostResource).toHaveBeenCalledTimes(1);

        api.dispose?.();
        expect(disposeMountedHostApiHandlers).toHaveBeenCalledTimes(1);
    });

    it('keeps the first-party host action id inside the canonical plugin surface key', () => {
        expect(PLUGIN_INVOCABLE_ACTION_IDS).toContain(HOST_ACTION_ID);
        expect(PLUGIN_INVOCABLE_ACTION_IDS).not.toContain('refresh-index');
    });

    it.each(['reject', 'approve'] as const)('settles each mounted host capture viewing through canonical Action approval (%s)', async (decision) => {
        let stored: ApprovalRequest | undefined;
        const approvalRequests: ApprovalRequest[] = [];
        const settings = normalizeActionsSettingsV1({ v: 1 });
        // Storage, mount currentness and the person's decision are external boundaries.
        const deps = {
            isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
            approvalsCreate: async ({ request }) => {
                stored = ApprovalRequestV2Schema.parse(request);
                approvalRequests.push(stored);
                return { artifactId: `capture-approval-${approvalRequests.length}` };
            },
            approvalsUpdate: async ({ request }) => {
                stored = ApprovalRequestV2Schema.parse(request);
                return { ok: true as const };
            },
            approvalsWaitForDecision: async () => ({ decision, request: stored! }),
            isApprovalExecutionOriginCurrent: async () => true,
        } satisfies Partial<ActionExecutorDeps>;
        // Unrelated Session/Agent ports are outside this boundary fixture's exercised path.
        const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            callerBinding: mountedCallerBinding(),
            callerSourceCustody: { kind: 'development', registeredRootId: 'inspector-root' },
            hostAction: {
                execute: executor.execute,
                context: { serverId: 'home-1', runtimeAccountId: 'account-1', actionRequestId: 'stale-mount-request' },
            },
        });
        try {
            for (const requestId of ['view-1', 'view-2']) {
                const captureInput = { sourceId: 'host-screen', sourceOccurrenceId: `screen-occurrence-${requestId}` };
                const response = await api.handleRequest({
                    ...executeActionRequest({ action: 'capture.view', input: captureInput }),
                    requestId,
                });
                expect(response).toEqual(decision === 'reject'
                    ? { code: 'unavailable', diagnostics: ['approval_rejected'] }
                    : { admitted: true, ...captureInput });
            }
            expect(approvalRequests).toHaveLength(2);
            expect(approvalRequests.map(request => ApprovalRequestV2Schema.parse(request).executionOriginV1.requestId))
                .toEqual(['view-1', 'view-2']);
        } finally {
            api.dispose?.();
        }
    });

    it.each([
        { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-current' } },
        { kind: 'managed', immutableGenerationId: 'installed-current', installSource: 'archive' },
        { kind: 'development', registeredRootId: 'inspector-root' },
    ] satisfies PluginSourceCustodyV1[])(
        'keeps $kind mounted custody through default Home approval and current replay',
        async (custody) => {
            const result = await runMountedHomeApproval(custody);
            expect(result.decision).toMatchObject({
                ok: true, result: { status: 'executed', execution: {
                    ok: true, result: { status: 'removed', membershipId: 'membership-1' },
                } },
            });
            expect(result.effects).toEqual([expect.objectContaining({
                actionId: 'teams.members.remove',
                input: { v: 1, teamId: 'team-1', membershipId: 'membership-1' },
                context: expect.objectContaining({ serverId: 'home-1' }),
            })]);
            expect(result.stored()).toMatchObject({
                status: 'executed',
                executionOriginV1: { caller: {
                    kind: 'plugin', pluginId: CALLER_PLUGIN_ID,
                    contributionLocalId: 'inspector-app', sourceCustody: custody,
                } },
            });
        },
    );

    it('honors explicit Home approval over a plugin waiver and refuses retired source custody at replay', async () => {
        const result = await runMountedHomeApproval(TARGET_SOURCE_CUSTODY, true);
        expect(result.decision).toMatchObject({ ok: true, result: {
            status: 'failed', execution: { ok: false, errorCode: 'approval_stale' },
        } });
        expect(result.effects).toEqual([]);
        expect(result.stored()).toMatchObject({
            status: 'failed', execution: { errorCode: 'approval_stale' },
            executionOriginV1: { caller: { sourceCustody: TARGET_SOURCE_CUSTODY } },
        });
    });

    it('routes a plugin-surfaced ActionSpec id to the host executor with the host-stamped caller', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: HOST_ACTION_ID,
            input: { pluginId: CALLER_PLUGIN_ID },
            hostAction: { execute, context: { serverId: 'server-1' } },
            contributedAction: {
                ...mountedActionBinding(),
                execute: contributed,
            },
        })).resolves.toEqual({ ok: true, result: { reloaded: true } });

        expect(contributed).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledWith(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }, {
            serverId: 'server-1',
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: CALLER_PLUGIN_ID,
                contributionLocalId: 'inspector-app',
                occurrenceId: `${CALLER_PLUGIN_ID}:current`,
                materialization: CALLER_MATERIALIZATION,
            },
        });
    });

    it('carries caller cancellation into the canonical host Action executor', async () => {
        const cancellation = new AbortController();
        const execute = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: HOST_ACTION_ID,
            input: {},
            signal: cancellation.signal,
            hostAction: { execute, context: { serverId: 'server-1' } },
            contributedAction: mountedActionBinding(),
        })).resolves.toEqual({ ok: true, result: { reloaded: true } });

        expect(execute).toHaveBeenCalledWith(HOST_ACTION_ID, {}, {
            serverId: 'server-1',
            signal: cancellation.signal,
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: CALLER_PLUGIN_ID,
                contributionLocalId: 'inspector-app',
                occurrenceId: `${CALLER_PLUGIN_ID}:current`,
                materialization: CALLER_MATERIALIZATION,
            },
        });
    });

    it('rejects a host ActionSpec that lacks an authenticated plugin caller', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));

        await expect(dispatchPluginSurfaceAction({
            action: HOST_ACTION_ID,
            input: {},
            hostAction: { execute },
        } as DispatchPluginSurfaceActionInput)).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_host_action_caller_missing',
        });

        expect(execute).not.toHaveBeenCalled();
    });

    it('fails closed before host Action dispatch when the plugin caller lacks a stamped materialization', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            action: HOST_ACTION_ID,
            input: {},
            hostAction: { execute },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_mounted_caller_unavailable',
        });

        expect(execute).not.toHaveBeenCalled();
    });

    // A host ActionSpec id that is NOT plugin-surfaced must never reach the
    // ActionSpec executor: a wrong implementation validating with `ActionIdSchema`
    // would admit every ActionSpec row to the plugin surface — a security-relevant
    // widening. It falls through to the contributed branch, where a dotted
    // first-party id is not even a valid contribution local id.
    it('does not admit a non-plugin-surfaced ActionSpec id to the host branch', async () => {
        const nonPluginActionId = 'sessions.external.candidates.list';
        expect(PLUGIN_INVOCABLE_ACTION_IDS).not.toContain(nonPluginActionId);
        const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: nonPluginActionId,
            input: {},
            hostAction: { execute },
            contributedAction: {
                ...mountedActionBinding(),
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_action_reference_invalid',
        });

        expect(execute).not.toHaveBeenCalled();
        expect(contributed).not.toHaveBeenCalled();
    });

    it('qualifies a cross-plugin structured reference without adding a caller allowlist', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { refreshed: true } },
        }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: { pluginId: 'acme.reviewer', localId: 'refresh-index' },
            input: { reason: 'cross-plugin' },
            contributedAction: {
                ...mountedActionBinding(),
                serverId: 'server-1',
                execute: contributed,
            },
        })).resolves.toEqual({ ok: true, result: { refreshed: true } });

        expect(contributed).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-1',
            expectedContributorOccurrenceId: 'occurrence-acme.reviewer',
            qualifiedActionId: 'acme.reviewer/refresh-index',
            input: { reason: 'cross-plugin' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: mountedCallerBinding(),
            },
        });
    });

    it('forwards the opaque message reference beside, not inside, the contributed action input', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { refreshed: true } },
        }));
        const messageActionReference = {
            v: 1,
            sessionId: 'session-1',
            messageId: 'message-1',
            observedRevision: 'revision-9',
        } as const;

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: { pluginId: 'acme.reviewer', localId: 'refresh-index' },
            input: { reason: 'message-action' },
            contributedAction: {
                ...mountedActionBinding(),
                messageActionReference,
                execute: contributed,
            },
        })).resolves.toEqual({ ok: true, result: { refreshed: true } });

        expect(contributed).toHaveBeenCalledWith('machine-1', {
            serverId: null,
            expectedContributorOccurrenceId: 'occurrence-acme.reviewer',
            qualifiedActionId: 'acme.reviewer/refresh-index',
            input: { reason: 'message-action' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: mountedCallerBinding(),
            },
            messageActionReference,
        });
    });

    it('dispatches a host-presented exact reference without inventing a mounted caller', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { opened: true } },
        }));
        const messageActionReference = {
            v: 1,
            sessionId: 'session-1',
            messageId: 'message-1',
            observedRevision: 'revision-9',
        } as const;

        await expect(dispatchPluginSurfaceAction({
            action: { pluginId: 'acme.preview', localId: 'open-preview' },
            input: {},
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: messageActionReference,
            },
            contributedAction: {
                machineId: 'machine-1',
                serverId: 'server-1',
                messageActionReference,
                execute: contributed,
            },
        })).resolves.toEqual({ ok: true, result: { opened: true } });

        expect(contributed).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-1',
            expectedContributorOccurrenceId: 'occurrence-acme.preview',
            qualifiedActionId: 'acme.preview/open-preview',
            input: {},
            executionSurface: 'ui',
            messageActionReference,
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: messageActionReference,
            },
        });
        const request = contributed.mock.calls[0]?.[1];
        expect(request).not.toHaveProperty('mountedBinding');
    });

    it('does not bind a bare direct-host reference to an invented caller', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            action: 'open-preview',
            input: {},
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_action_reference_invalid',
        });

        expect(contributed).not.toHaveBeenCalled();
    });

    // An action the plugin never declared is answered by the daemon front door,
    // not by a UI-side registry: the dispatcher forwards it and surfaces the
    // daemon's typed code.
    it('surfaces an undeclared contributed action as the daemon front door reported it', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: false as const, code: 'plugin_action_unavailable' },
        }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding(),
            action: 'never-declared',
            input: {},
            contributedAction: {
                ...mountedActionBinding(),
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_action_unavailable',
        });
    });

    // The dispatcher's emitted request must satisfy the daemon front-door wire
    // schema exactly — including the now-required `executionSurface` — so the
    // composed UI half and the daemon handler test meet on one contract instead
    // of two independently-shaped fixtures.
    it('emits a request the daemon front-door wire schema accepts', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: {} },
        }));

        await dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            callerContributionLocalId: 'inspector-app',
            callerBinding: mountedCallerBinding({ machineId: 'machine-wire' }),
            action: { pluginId: 'acme.reviewer', localId: 'refresh-index' },
            input: { reason: 'wire' },
            contributedAction: {
                ...mountedActionBinding({ machineId: 'machine-wire' }),
                serverId: 'server-wire',
                sessionId: 'session-wire',
                execute: contributed,
            },
        });

        const invocation = contributed.mock.calls[0];
        expect(invocation).toBeDefined();
        if (!invocation) throw new Error('Expected the contributed action transport to be invoked.');
        const [machineId, request] = invocation;
        const { serverId: _serverId, timeoutMs: _timeoutMs, signal: _signal, ...wire } = request;
        expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
            machineId,
            ...wire,
        })).toEqual({
            machineId: 'machine-wire',
            expectedContributorOccurrenceId: 'occurrence-acme.reviewer',
            qualifiedActionId: 'acme.reviewer/refresh-index',
            input: { reason: 'wire' },
            sessionId: 'session-wire',
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: mountedCallerBinding({ machineId: 'machine-wire' }),
            },
        });
    });

    it('retains an exact catalog Action occurrence for an unmounted host invocation', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { configured: true } },
        }));

        await expect(dispatchPluginSurfaceAction({
            action: { pluginId: 'acme.events', localId: 'configure-source' },
            input: { repository: 'happier-dev/happier' },
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: true,
            result: { configured: true },
        });

        expect(contributed).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            qualifiedActionId: 'acme.events/configure-source',
            expectedContributorOccurrenceId: 'occurrence-acme.events',
        }));
    });

    it('sends a mounted binding through the default daemon transport and omits it for unmounted dispatch', async () => {
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ ok: true, result: { route: 'same' } })
            .mockResolvedValueOnce({ ok: true, result: { route: 'cross' } })
            .mockResolvedValueOnce({ ok: true, result: { route: 'unmounted' } });

        const caller = {
            pluginId: 'acme.preview',
            contributionLocalId: 'message-preview',
        };
        const mountedBinding = {
            pluginId: caller.pluginId,
            contributionLocalId: caller.contributionLocalId,
            occurrenceId: 'acme.preview:current',
            materializationRef: {
                machineId: 'machine-default',
                materializationId: 'materialization-preview-current',
                pluginId: caller.pluginId,
            },
        } as const;
        const contributedAction = {
            machineId: 'machine-default',
            serverId: 'server-default',
        };

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: caller.pluginId,
            callerContributionLocalId: caller.contributionLocalId,
            callerBinding: mountedBinding,
            action: 'open-preview',
            input: { route: 'same' },
            contributedAction,
        })).resolves.toEqual({ ok: true, result: { route: 'same' } });

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: caller.pluginId,
            callerContributionLocalId: caller.contributionLocalId,
            callerBinding: mountedBinding,
            action: { pluginId: 'acme.reviewer', localId: 'publish' },
            input: { route: 'cross' },
            contributedAction,
        })).resolves.toEqual({ ok: true, result: { route: 'cross' } });

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: caller.pluginId,
            action: 'open-preview',
            input: { route: 'unmounted' },
            contributedAction: {
                machineId: contributedAction.machineId,
                serverId: contributedAction.serverId,
            },
        })).resolves.toEqual({ ok: true, result: { route: 'unmounted' } });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine-default',
            serverId: 'server-default',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: {
                machineId: 'machine-default',
                expectedContributorOccurrenceId: 'occurrence-acme.preview',
                qualifiedActionId: 'acme.preview/open-preview',
                input: { route: 'same' },
                executionSurface: 'ui',
                invocation: {
                    kind: 'mountedPluginSurface',
                    mountedBinding,
                },
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine-default',
            serverId: 'server-default',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: {
                machineId: 'machine-default',
                expectedContributorOccurrenceId: 'occurrence-acme.reviewer',
                qualifiedActionId: 'acme.reviewer/publish',
                input: { route: 'cross' },
                executionSurface: 'ui',
                invocation: {
                    kind: 'mountedPluginSurface',
                    mountedBinding,
                },
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine-default',
            serverId: 'server-default',
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: {
                machineId: 'machine-default',
                expectedContributorOccurrenceId: 'occurrence-acme.preview',
                qualifiedActionId: 'acme.preview/open-preview',
                input: { route: 'unmounted' },
                executionSurface: 'ui',
            },
        }));
        const unmountedRequest = machineRpcWithServerScopeMock.mock.calls[2]?.[0] as
            | Readonly<{ payload?: Readonly<Record<string, unknown>> }>
            | undefined;
        expect(unmountedRequest?.payload).not.toHaveProperty('mountedBinding');
        expect(unmountedRequest?.payload).not.toHaveProperty('invocation');
        expect(unmountedRequest?.payload).not.toHaveProperty('caller');
    });

    it('rejects a malformed contribution reference as a typed invalid payload', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: { pluginId: 'Not A Plugin Id', localId: 'refresh-index' },
            input: {},
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_action_reference_invalid',
        });
        expect(contributed).not.toHaveBeenCalled();
    });

    it('fails closed when the mount installed no contributed-action binding', async () => {
        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_contributed_action_unavailable',
        });
    });

    it('refuses to dispatch after cancellation, before any effect reaches the transport', async () => {
        const controller = new AbortController();
        controller.abort();
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            signal: controller.signal,
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_ui_invocation_aborted',
        });
        expect(contributed).not.toHaveBeenCalled();
    });

    it('reports a retired generation as a stale surface before dispatching', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            isCurrent: () => false,
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'stale_surface',
            reason: 'plugin_ui_generation_retired',
        });
        expect(contributed).not.toHaveBeenCalled();
    });

    // Settlement is authoritative: a success observed by the daemon must never be
    // hidden by a local retirement observed afterwards, or the caller is invited
    // to blind-retry a mutation that already happened.
    it('keeps a settled success authoritative even when the surface retires during the call', async () => {
        let current = true;
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => {
            current = false;
            return { supported: true as const, result: { ok: true as const, result: { applied: 1 } } };
        });

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            isCurrent: () => current,
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        })).resolves.toEqual({ ok: true, result: { applied: 1 } });
    });

    it('keeps a known daemon failure when the surface retires after settlement', async () => {
        let current = true;
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => {
            current = false;
            return { supported: true as const, result: { ok: false as const, code: 'plugin_action_unavailable' } };
        });

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            isCurrent: () => current,
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_action_unavailable',
        });
    });

    it('keeps a pre-handler daemon retirement as an ordinary unavailable result', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: false as const, code: 'plugin_action_generation_retired' },
        }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_action_generation_retired',
        });
    });

    it('projects a post-handler daemon retirement as outcome unknown', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: false as const, code: 'plugin_action_outcome_unknown' },
        }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            invocationSurface: 'voice',
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
            reason: 'plugin_ui_action_outcome_unknown',
        });
    });
});

function resolveConfirmedDaemonTargetAction(
    identity: PluginContributionIdentityV1,
): PluginProjectedActionV2 {
    return PluginProjectedActionV2Schema.parse({
        ...resolveDaemonTargetAction(identity),
        scopes: ['global'],
        dangerLevel: 'writesRemote',
        confirmation: {
            title: 'Publish the release?',
            body: 'This changes remote state.',
        },
    });
}

// One present-user confirmation owner for both placements (PPS §9 ruling d):
// the UI asks the person, then carries the settled intent on the daemon RPC.
// No daemon or server round trip may stand in for that local decision.
describe('present-user confirmation for daemon-target Actions', () => {
    it('sends a waived dangerous Action without asking or manufacturing present-user intent', async () => {
        const storage = getStorage();
        const previous = storage.getState();
        storage.setState(state => ({ ...state, settings: { ...state.settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                approvalWaivedSurfaces: { 'acme.releases/actions/publish': ['ui'] },
            }),
        } }));
        try {
            const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
                supported: true, result: { ok: true, result: { published: true } },
            }));
            await expect(dispatchPluginSurfaceAction({
                action: { pluginId: 'acme.releases', localId: 'publish' }, input: { tag: 'v1' },
                resolveContributedAction: resolveConfirmedDaemonTargetAction,
                requestCurrentIntent: async () => ({ status: 'unavailable', code: 'no_present_user' }),
                contributedAction: { machineId: 'machine-1', execute: contributed },
            })).resolves.toEqual({ ok: true, result: { published: true } });
            expect(contributed.mock.calls[0]?.[1]).not.toHaveProperty('presentUserIntent');
        } finally {
            storage.setState(previous);
        }
    });
    it('confirms locally before the daemon RPC and carries the settled present intent', async () => {
        const order: string[] = [];
        const requestCurrentIntent = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => {
            order.push('confirm');
            return { status: 'approved' as const, fingerprint };
        });
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => {
            order.push('transport');
            return { supported: true as const, result: { ok: true as const, result: { published: true } } };
        });

        await expect(dispatchPluginSurfaceAction({
            action: { pluginId: 'acme.releases', localId: 'publish' },
            input: { tag: 'v1' },
            resolveContributedAction: resolveConfirmedDaemonTargetAction,
            requestCurrentIntent,
            contributedAction: { machineId: 'machine-1', execute: contributed },
        })).resolves.toEqual({ ok: true, result: { published: true } });

        expect(order).toEqual(['confirm', 'transport']);
        expect(requestCurrentIntent).toHaveBeenCalledWith(expect.objectContaining({
            action: expect.objectContaining({ pluginId: 'acme.releases', id: 'publish' }),
            invocationSurface: 'ui',
        }));
        expect(contributed).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            qualifiedActionId: 'acme.releases/publish',
            executionSurface: 'ui',
            presentUserIntent: 'confirmed',
        }));
    });

    it('runs nothing and leaves nothing pending when the person cancels the local confirmation', async () => {
        const requestCurrentIntent = vi.fn(async () => ({
            status: 'rejected' as const,
            code: 'plugin_action_current_intent_rejected',
        }));
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>();
        const onDaemonActionOperationAdmitted = vi.fn();

        await expect(dispatchPluginSurfaceAction({
            action: { pluginId: 'acme.releases', localId: 'publish' },
            input: { tag: 'v1' },
            actionRequestId: 'request-cancelled',
            onDaemonActionOperationAdmitted,
            resolveContributedAction: (identity) => PluginProjectedActionV2Schema.parse({
                ...resolveConfirmedDaemonTargetAction(identity),
                operation: {
                    version: 1,
                    visibility: 'activity',
                    progress: 'indeterminate',
                    presentation: { onStart: 'activity' },
                },
            }),
            requestCurrentIntent,
            contributedAction: { machineId: 'machine-1', execute: contributed },
        })).resolves.toEqual({
            ok: false,
            code: 'denied',
            reason: 'plugin_action_current_intent_rejected',
        });

        expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
        expect(contributed).not.toHaveBeenCalled();
        expect(onDaemonActionOperationAdmitted).not.toHaveBeenCalled();
    });

    it('sends a safe daemon Action without asking and without a present intent', async () => {
        const requestCurrentIntent = vi.fn();
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: {} },
        }));

        await dispatchPluginSurfaceAction({
            action: { pluginId: 'acme.releases', localId: 'refresh' },
            input: {},
            requestCurrentIntent,
            contributedAction: { machineId: 'machine-1', execute: contributed },
        });

        expect(requestCurrentIntent).not.toHaveBeenCalled();
        expect(contributed.mock.calls[0]?.[1]).not.toHaveProperty('presentUserIntent');
    });

    it('asks locally for a safe daemon Action when the Ask-first Action setting requires approval', async () => {
        const storage = getStorage();
        const previous = storage.getState();
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({
                    v: 1,
                    actions: { 'acme.releases/actions/refresh': { approvalRequiredSurfaces: ['ui'] } },
                }),
            },
        }));
        try {
            const requestCurrentIntent = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => ({
                status: 'approved' as const,
                fingerprint,
            }));
            const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
                supported: true as const,
                result: { ok: true as const, result: {} },
            }));

            await dispatchPluginSurfaceAction({
                action: { pluginId: 'acme.releases', localId: 'refresh' },
                input: {},
                requestCurrentIntent,
                contributedAction: { machineId: 'machine-1', execute: contributed },
            });

            expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
            expect(contributed).toHaveBeenCalledWith('machine-1', expect.objectContaining({
                presentUserIntent: 'confirmed',
            }));
        } finally {
            storage.setState(previous, true);
        }
    });
});

describe('mounted executeAction handler', () => {
    it('preserves omitted declarative input as absence and explicit null as null at the daemon boundary', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { applied: true } },
        }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            callerSourceCustody: TARGET_SOURCE_CUSTODY,
            callerBinding: mountedCallerBinding(),
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        });

        await expect(api.handleRequest(
            executeActionRequest({ action: 'refresh-index' }),
        )).resolves.toEqual({ applied: true });
        const omitted = contributed.mock.calls[0]?.[1] as Readonly<Record<string, unknown>> | undefined;
        expect(omitted).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(omitted, 'input')).toBe(false);

        await expect(api.handleRequest(
            executeActionRequest({ action: 'refresh-index', input: null }),
        )).resolves.toEqual({ applied: true });
        const explicitNull = contributed.mock.calls[1]?.[1] as Readonly<Record<string, unknown>> | undefined;
        expect(explicitNull).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(explicitNull, 'input')).toBe(true);
        expect(explicitNull?.input).toBeNull();
    });

    it('rehydrates the host-selected GitHub Account ref before canonical dispatch and forwards only its exact contributor generation', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { applied: true } },
        }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            callerSourceCustody: TARGET_SOURCE_CUSTODY,
            callerBinding: mountedCallerBinding(),
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        });
        const targetedOperation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: 'acme.reviewer',
                contributionId: 'github-connection',
                occurrenceId: 'contributor-generation-a',
                sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
            },
            role: 'setup',
            action: { pluginId: 'acme.reviewer', localId: 'prepare-v1' },
        } as const;
        const account = {
            service: { pluginId: 'acme.github', localId: 'github' },
            accountId: 'account-a',
        } as const;
        const selectedActionInput = {
            kind: 'submitted' as const,
            action: targetedOperation.action,
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: {
                    pluginId: CALLER_PLUGIN_ID,
                    sourceCustody: TARGET_SOURCE_CUSTODY,
                },
                point: targetedOperation.point,
                contributor: {
                    pluginId: targetedOperation.contributor.pluginId,
                    contributionId: targetedOperation.contributor.contributionId,
                    sourceCustody: targetedOperation.contributor.sourceCustody,
                },
            },
            connectedAccount: {
                kind: 'selected' as const,
                fieldPath: 'credentialRef',
                ref: account,
            },
            presentation: {
                connectedAccountLabel: 'Work account',
                machineDisplayName: 'Development Mac',
            },
        };

        await expect(api.handleRequest(
            executeActionRequest({ action: targetedOperation.action, input: { repository: 'happier-dev/happier' } }),
            { targetedOperation, selectedActionInput },
        )).resolves.toEqual({ applied: true });
        expect(contributed).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            qualifiedActionId: 'acme.reviewer/prepare-v1',
            expectedContributorOccurrenceId: 'occurrence-acme.reviewer',
            input: {
                repository: 'happier-dev/happier',
                credentialRef: account,
            },
        }));

        await expect(api.handleRequest(
            executeActionRequest({ action: { pluginId: 'acme.reviewer', localId: 'other-v1' }, input: {} }),
            { targetedOperation, selectedActionInput },
        )).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_surface_targeted_selection_invalid'],
        });

        // The selected target contributor can be relayed only through an
        // Action owned by this exact mounted target. An arbitrary provider
        // Action cannot borrow the carrier.
        await expect(api.handleRequest(
            executeActionRequest({
                action: { pluginId: CALLER_PLUGIN_ID, localId: 'connection/create' },
                input: { providerSetupInput: { repository: 'happier-dev/happier' } },
            }),
            { targetedOperation, selectedActionInput },
        )).resolves.toEqual({ applied: true });
        expect(contributed).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            qualifiedActionId: `${CALLER_PLUGIN_ID}/connection/create`,
            input: { providerSetupInput: { repository: 'happier-dev/happier' } },
            selectedActionInputCarrier: {
                operation: targetedOperation,
                result: selectedActionInput,
            },
        }));

        await expect(api.handleRequest(
            executeActionRequest({ action: targetedOperation.action, input: { repository: 'tampered' } }),
            { targetedOperation, selectedActionInput },
        )).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_surface_targeted_selection_invalid'],
        });
        expect(contributed).toHaveBeenCalledTimes(2);
    });

    it('rejects a payload that carries no canonical action reference', async () => {
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            hostAction: { execute: vi.fn(async () => ({ ok: true as const, result: {} })) },
        });

        await expect(api.handleRequest(executeActionRequest({ input: {} }))).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_surface_action_payload_invalid'],
        });
    });

    // The predecessor `actionId` spelling is retired, not aliased: no released tag
    // and no `remote-dev` revision ships `packages/protocol/src/plugins/**`, so no
    // reachable client can send it.
    it('does not resurrect the predecessor actionId spelling', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            hostAction: { execute },
        });

        await expect(api.handleRequest(executeActionRequest({
            actionId: HOST_ACTION_ID,
            input: {},
        }))).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_surface_action_payload_invalid'],
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a structured action reference with fields outside the Protocol request contract', async () => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { shouldNotRun: true } },
        }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            callerBinding: mountedCallerBinding(),
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        });

        await expect(api.handleRequest(executeActionRequest({
            action: {
                pluginId: 'acme.reviewer',
                localId: 'refresh-index',
                unexpected: true,
            },
            input: {},
        }))).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_surface_action_payload_invalid'],
        });
        expect(contributed).not.toHaveBeenCalled();
    });

    it('host-stamps the mounted plugin rather than trusting the request payload', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext('acme.other-app-surface'),
            callerBinding: mountedCallerBinding({ pluginId: 'acme.other-app-surface' }),
            hostAction: { execute },
        });

        await expect(api.handleRequest({
            ...executeActionRequest({ action: HOST_ACTION_ID, input: { pluginId: CALLER_PLUGIN_ID } }),
            surface: surfaceContext('acme.other-app-surface'),
        })).resolves.toEqual({});
        expect(execute).toHaveBeenCalledWith(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }, {
            actionRequestId: 'request-1',
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: 'acme.other-app-surface',
                contributionLocalId: 'inspector-app',
                occurrenceId: 'acme.other-app-surface:current',
                materialization: {
                    pluginId: 'acme.other-app-surface',
                    machineId: 'machine-1',
                    materializationId: 'materialization-inspector-current',
                },
            },
        });
    });

    it('forwards caller cancellation through the mounted handler before dispatching', async () => {
        const cancellation = new AbortController();
        cancellation.abort();
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { shouldNotReachDaemon: true } },
        }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            contributedAction: {
                machineId: 'machine-cancel',
                execute: contributed,
            },
        });

        await expect(api.handleRequest(
            executeActionRequest({ action: 'refresh-index', input: {} }),
            { signal: cancellation.signal },
        )).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_ui_invocation_aborted'],
        });
        expect(contributed).not.toHaveBeenCalled();
    });
});

/**
 * Composed public-client <-> host seam (plan §7 layer 3, UI-D23).
 *
 * Every owner-level test above proves one side. This block wires the REAL public
 * SDK client (`@happier-dev/plugin-sdk/ui/client`) to the REAL hosted-web host
 * adapter to the REAL mounted host API. The only substituted pieces are the
 * iframe/postMessage hop — a genuine realm boundary — and the two terminal
 * executors, which are spied so the test can observe exactly what reaches them.
 * No envelope is hand-constructed.
 */
const COMPOSED_HOST_ORIGIN = 'https://host.happier.test';
const COMPOSED_IDENTITY = {
    instanceId: 'inspector-instance-9',
    mountNonce: 'composed-bridge-nonce',
} as const;
const COMPOSED_BRIDGE_NONCE = 'composed-bridge-nonce';
const COMPOSED_SURFACE = surfaceContext();
const COMPOSED_MOUNTED_BINDING = {
    pluginId: COMPOSED_SURFACE.pluginId,
    contributionLocalId: COMPOSED_SURFACE.contributionId,
    occurrenceId: `${COMPOSED_SURFACE.pluginId}:current`,
    materializationRef: {
        machineId: 'machine-composed',
        materializationId: 'materialization-composed-current',
        pluginId: COMPOSED_SURFACE.pluginId,
    },
} as const;
const COMPOSED_TARGETED_OPERATION = {
    point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
    contributor: {
        pluginId: 'acme.reviewer',
        contributionId: 'github-connection',
        occurrenceId: 'contributor-generation-composed',
        sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
    },
    role: 'setup',
    action: { pluginId: 'acme.reviewer', localId: 'prepare-v1' },
} as const;
// Keep this as a JSON tree, rather than reusing the operation object's nested
// records. The hosted wire deliberately rejects shared object references so a
// descriptor is always serializable across the frame boundary.
const COMPOSED_TARGETED_CONTRIBUTIONS = PluginUiTargetedContributionsV1Schema.parse({
    target: {
        pluginId: CALLER_PLUGIN_ID,
        occurrenceId: 'target-generation-composed',
        sourceCustody: TARGET_SOURCE_CUSTODY,
    },
    points: [{
        pointId: 'connection',
        protocols: [{
            protocol: { id: 'connection', version: 1 },
            contributions: [{
                contributor: {
                    pluginId: 'acme.reviewer',
                    contributionId: 'github-connection',
                    occurrenceId: 'contributor-generation-composed',
                    sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
                },
                protocol: { id: 'connection', version: 1 },
                operations: [{
                    point: {
                        pointId: 'connection',
                        protocol: { id: 'connection', version: 1 },
                    },
                    contributor: {
                        pluginId: 'acme.reviewer',
                        contributionId: 'github-connection',
                        occurrenceId: 'contributor-generation-composed',
                        sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
                    },
                    role: 'setup',
                    action: { pluginId: 'acme.reviewer', localId: 'prepare-v1' },
                }],
                // The projection contract always carries both role families,
                // even when this composed Action-only fixture has no Surface.
                surfaces: [],
            }],
        }],
    }],
});
/**
 * The canonical surface snapshot the mount projects. Its `theme` comes from the
 * canonical projection owner rather than a literal, so this suite cannot pass
 * against a hand-built neighbour envelope that the real host would never emit.
 */
const COMPOSED_CANONICAL_SURFACE: PluginUiJsonValueV1 = {
    // The public SDK sees the canonical destination-or-embedded mount union;
    // the bridge address below remains the host-private request classification.
    mount: {
        kind: 'destination',
        destination: { pluginId: CALLER_PLUGIN_ID, localId: COMPOSED_SURFACE.contributionId },
        container: 'appPage',
    },
    target: { kind: 'app' },
    accountEncryptionMode: 'plain',
    platform: 'web',
    locale: 'en',
    direction: 'ltr',
    colorScheme: 'light',
    contrast: 'normal',
    textScale: 1,
    reducedMotion: false,
    screenReaderEnabled: false,
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    theme: PluginUiJsonValueV1Schema.parse(projectPluginUiTheme(
        resolveThemeProfile({ mode: 'light', profile: null }),
    )),
    translations: {},
    targetedContributions: COMPOSED_TARGETED_CONTRIBUTIONS,
};

function composedRealmHref(): string {
    const url = new URL('https://preview.happier.test/plugin-surface');
    url.searchParams.set('happierInstanceId', COMPOSED_IDENTITY.instanceId);
    url.searchParams.set('happierBridgeNonce', COMPOSED_BRIDGE_NONCE);
    url.searchParams.set('happierHostOrigin', COMPOSED_HOST_ORIGIN);
    return url.toString();
}

type ComposedSettlement =
    | Readonly<{ settled: 'fulfilled'; result: unknown }>
    | Readonly<{ settled: 'rejected'; code: string; diagnostics: readonly string[] }>;

async function settleComposed(pending: Promise<unknown>): Promise<ComposedSettlement> {
    return pending.then(
        (result): ComposedSettlement => ({ settled: 'fulfilled', result }),
        (error: unknown): ComposedSettlement => {
            const data = error as Readonly<{
                code?: unknown;
                diagnostics?: readonly Readonly<{ code?: unknown }>[];
            }>;
            return {
                settled: 'rejected',
                code: typeof data.code === 'string' ? data.code : 'unknown',
                diagnostics: (data.diagnostics ?? [])
                    .map((diagnostic) => diagnostic.code)
                    .filter((code): code is string => typeof code === 'string'),
            };
        },
    );
}

describe('composed public SDK client to canonical plugin-surface dispatcher', () => {
    const executeHostAction = vi.fn<PluginSurfaceHostActionExecute>(async () => ({
        ok: true as const,
        result: { plugins: [] },
    }));
    const contributedActionExecute = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
        supported: true as const,
        result: { ok: true as const, result: { refreshed: true } },
    }));
    const previousGlobals = {
        window: Reflect.get(globalThis, 'window'),
        location: Reflect.get(globalThis, 'location'),
        parent: Reflect.get(globalThis, 'parent'),
        addEventListener: Reflect.get(globalThis, 'addEventListener'),
        removeEventListener: Reflect.get(globalThis, 'removeEventListener'),
    };
    let client: PluginUiHostApi;
    let bridge: ReturnType<typeof createPluginHostedWebHostApiBridgeHandler>;
    const emittedExecuteActionPayloads: PluginUiJsonValueV1[] = [];
    const emittedTargetedOperations: unknown[] = [];

    beforeAll(async () => {
        const listeners = new Set<(event: unknown) => void>();
        const deliverFromHost = (message: unknown): void => {
            // Browser `postMessage` does not re-enter the guest while it is
            // sending `ready`; preserve that ordering so bootstrap can clear
            // the client timeout that is armed immediately afterwards.
            queueMicrotask(() => {
                for (const listener of [...listeners]) {
                    listener({ data: message, origin: COMPOSED_HOST_ORIGIN, source: parent });
                }
            });
        };
        const parent = {
            postMessage(message: unknown, targetOrigin: string): void {
                // Match the browser boundary: an incorrectly addressed guest
                // message never reaches the host bridge.
                if (targetOrigin !== COMPOSED_HOST_ORIGIN) return;
                const envelope = PluginHostedWebBridgeEnvelopeV1Schema.safeParse(message);
                if (!envelope.success) return;
                void Promise.resolve(bridge(envelope.data)).then((response) => {
                    deliverFromHost(response);
                });
            },
        };
        const hostApi = createPluginSurfaceActionHostApi({
            surfaceContext: COMPOSED_SURFACE,
            callerSourceCustody: TARGET_SOURCE_CUSTODY,
            callerBinding: COMPOSED_MOUNTED_BINDING,
            hostAction: { execute: executeHostAction, context: { serverId: 'server-composed' } },
            contributedAction: {
                machineId: 'machine-composed',
                serverId: 'server-composed',
                execute: contributedActionExecute,
            },
            selectActionInput: async (request): Promise<PluginUiJsonValueV1> => {
                const operation = (request.payload as { operation?: unknown } | undefined)?.operation;
                if (JSON.stringify(operation) !== JSON.stringify(COMPOSED_TARGETED_OPERATION)) {
                    return { code: 'invalid_payload', diagnostics: ['targeted_operation_missing'] };
                }
                return {
                    kind: 'submitted',
                    action: COMPOSED_TARGETED_OPERATION.action,
                    input: { repository: 'happier-dev/happier' },
                    selection: {
                        target: {
                            pluginId: COMPOSED_TARGETED_CONTRIBUTIONS.target.pluginId,
                            sourceCustody: COMPOSED_TARGETED_CONTRIBUTIONS.target.sourceCustody,
                        },
                        point: COMPOSED_TARGETED_OPERATION.point,
                        contributor: {
                            pluginId: COMPOSED_TARGETED_OPERATION.contributor.pluginId,
                            contributionId: COMPOSED_TARGETED_OPERATION.contributor.contributionId,
                            sourceCustody: COMPOSED_TARGETED_OPERATION.contributor.sourceCustody,
                        },
                    },
                    connectedAccount: { kind: 'none' },
                    presentation: {
                        connectedAccountLabel: null,
                        machineDisplayName: 'Development Mac',
                    },
                };
            },
        });
        bridge = createPluginHostedWebHostApiBridgeHandler({
            surface: COMPOSED_SURFACE,
            requestIdPrefix: 'composed',
            identity: COMPOSED_IDENTITY,
            handleRequest: async (request, options) => {
                if (request.method === 'executeAction' && request.payload !== undefined) {
                    emittedExecuteActionPayloads.push(request.payload);
                    emittedTargetedOperations.push(options?.targetedOperation);
                }
                return await hostApi.handleRequest(request, options);
            },
            canonicalHostApi: {
                identity: COMPOSED_IDENTITY,
                surface: COMPOSED_CANONICAL_SURFACE,
                methods: ['context', 'executeAction', 'selectActionInput'],
            },
            // The real frame adapter owns a distinct host->frame delivery
            // channel. `ready` is acknowledged on the request path, but only
            // this channel carries the post-ready bootstrap.
            postToFrame: deliverFromHost,
            bootstrap: {
                frameOrigin: new URL(composedRealmHref()).origin,
            },
        });

        // The plugin realm: the SDK's own hosted-web bootstrap installs the real
        // transport from these host-issued query parameters, so the wire and
        // bridge envelopes the client sends are production-built, not fixtures.
        Reflect.set(globalThis, 'location', { href: composedRealmHref() });
        Reflect.set(globalThis, 'parent', parent);
        Reflect.set(globalThis, 'addEventListener', (_type: string, listener: (event: unknown) => void): void => {
            listeners.add(listener);
        });
        Reflect.set(globalThis, 'removeEventListener', (_type: string, listener: (event: unknown) => void): void => {
            listeners.delete(listener);
        });
        Reflect.set(globalThis, 'window', globalThis);

        client = await createPluginUiHostApiClient();
    });

    afterAll(async () => {
        bridge?.dispose();
        // Disposal sends the real terminal host message on the simulated
        // browser task queue. Keep the realm boundary installed until that
        // message releases the SDK listener, just as a browser realm remains
        // alive while its frame is being torn down.
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        for (const [key, value] of Object.entries(previousGlobals)) {
            if (value === undefined) Reflect.deleteProperty(globalThis, key);
            else Reflect.set(globalThis, key, value);
        }
    });

    it('carries a plugin-surfaced ActionSpec from the public client to the canonical executor', async () => {
        executeHostAction.mockClear();
        emittedExecuteActionPayloads.length = 0;

        await expect(client.executeAction(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }))
            .resolves.toEqual({ plugins: [] });

        expect(emittedExecuteActionPayloads).toEqual([{
            action: HOST_ACTION_ID,
            input: { pluginId: CALLER_PLUGIN_ID },
        }]);
        expect(PluginUiExecuteActionRequestV1Schema.safeParse(
            emittedExecuteActionPayloads[0],
        ).success).toBe(true);
        expect(executeHostAction).toHaveBeenCalledTimes(1);
        expect(executeHostAction).toHaveBeenCalledWith(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }, {
            actionRequestId: expect.any(String),
            actionCaller: {
                kind: 'plugin',
                pluginId: CALLER_PLUGIN_ID,
                contributionLocalId: COMPOSED_SURFACE.contributionId,
                occurrenceId: COMPOSED_MOUNTED_BINDING.occurrenceId,
                materialization: COMPOSED_MOUNTED_BINDING.materializationRef,
                sourceCustody: TARGET_SOURCE_CUSTODY,
            },
            signal: expect.any(AbortSignal),
            surface: 'plugin',
            serverId: 'server-composed',
        });
    });

    it('rejects a malformed structured Action reference before it crosses the hosted transport', async () => {
        executeHostAction.mockClear();
        contributedActionExecute.mockClear();
        emittedExecuteActionPayloads.length = 0;
        // Plugin code crosses a runtime boundary; strict Protocol validation
        // must reject this rather than silently projecting it to two fields.
        const malformedAction = {
            pluginId: CALLER_PLUGIN_ID,
            localId: 'refresh-index',
            unexpected: true,
        };

        await expect(client.executeAction(malformedAction, null)).rejects.toMatchObject({
            code: 'invalid_payload',
        });
        expect(emittedExecuteActionPayloads).toEqual([]);
        expect(executeHostAction).not.toHaveBeenCalled();
        expect(contributedActionExecute).not.toHaveBeenCalled();
    });

    // The public client legitimately encodes a contributed-action reference as
    // `{ pluginId, localId }`. It must reach the contributed-action route, NOT the
    // first-party ActionId executor.
    it('routes a structured plugin reference to the contributed-action front door', async () => {
        executeHostAction.mockClear();
        contributedActionExecute.mockClear();

        await expect(client.executeAction(
            { pluginId: 'acme.reviewer', localId: 'refresh-index' },
            { reason: 'composed-seam' },
        )).resolves.toEqual({ refreshed: true });

        expect(executeHostAction).not.toHaveBeenCalled();
        expect(contributedActionExecute).toHaveBeenCalledWith('machine-composed', {
            serverId: 'server-composed',
            expectedContributorOccurrenceId: 'occurrence-acme.reviewer',
            qualifiedActionId: 'acme.reviewer/refresh-index',
            input: { reason: 'composed-seam' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: COMPOSED_MOUNTED_BINDING,
            },
            signal: expect.anything(),
        });
    });

    it('carries a public SDK selected target operation through hosted execution only after host selection', async () => {
        contributedActionExecute.mockClear();
        emittedExecuteActionPayloads.length = 0;
        emittedTargetedOperations.length = 0;

        const selected = await client.selectActionInput({
            operation: COMPOSED_TARGETED_OPERATION,
        });
        expect(selected).toEqual({
            kind: 'submitted',
            action: COMPOSED_TARGETED_OPERATION.action,
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: {
                    pluginId: COMPOSED_TARGETED_CONTRIBUTIONS.target.pluginId,
                    sourceCustody: COMPOSED_TARGETED_CONTRIBUTIONS.target.sourceCustody,
                },
                point: COMPOSED_TARGETED_OPERATION.point,
                contributor: {
                    pluginId: COMPOSED_TARGETED_OPERATION.contributor.pluginId,
                    contributionId: COMPOSED_TARGETED_OPERATION.contributor.contributionId,
                    sourceCustody: COMPOSED_TARGETED_OPERATION.contributor.sourceCustody,
                },
            },
            connectedAccount: { kind: 'none' },
            presentation: {
                connectedAccountLabel: null,
                machineDisplayName: 'Development Mac',
            },
        });
        if (selected.kind !== 'submitted') throw new Error('expected submitted selection');

        await expect(client.executeAction(selected.action, selected.input))
            .resolves.toEqual({ refreshed: true });

        expect(emittedExecuteActionPayloads).toEqual([{
            action: COMPOSED_TARGETED_OPERATION.action,
            input: { repository: 'happier-dev/happier' },
        }]);
        expect(emittedTargetedOperations).toEqual([COMPOSED_TARGETED_OPERATION]);
        expect(contributedActionExecute).toHaveBeenCalledWith('machine-composed', {
            serverId: 'server-composed',
            expectedContributorOccurrenceId: 'occurrence-acme.reviewer',
            qualifiedActionId: 'acme.reviewer/prepare-v1',
            input: { repository: 'happier-dev/happier' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: COMPOSED_MOUNTED_BINDING,
            },
            signal: expect.anything(),
        });
    });

    // UI-D26: the `executionSurface: 'ui'` stamp is an invariant of the canonical
    // dispatcher, not an optional field each mounted transport must remember. A
    // request that reaches the daemon front door without it is evaluated on the
    // wrong surface, denying `surfaces:['ui']` actions and admitting agent-only
    // ones. Driving the real public client through the real mounted contract is
    // the only oracle that can observe the omission — a hand-built envelope
    // proves nothing.
    it('stamps the ui execution surface for a caller-local contributed action id', async () => {
        executeHostAction.mockClear();
        contributedActionExecute.mockClear();

        await expect(client.executeAction('refresh-index', { reason: 'local-ref' }))
            .resolves.toEqual({ refreshed: true });

        expect(executeHostAction).not.toHaveBeenCalled();
        expect(contributedActionExecute).toHaveBeenCalledWith('machine-composed', {
            serverId: 'server-composed',
            expectedContributorOccurrenceId: `occurrence-${CALLER_PLUGIN_ID}`,
            qualifiedActionId: `${CALLER_PLUGIN_ID}/refresh-index`,
            input: { reason: 'local-ref' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: COMPOSED_MOUNTED_BINDING,
            },
            signal: expect.anything(),
        });
    });

    it('rejects a failed host ActionSpec instead of resolving the failure envelope as a result', async () => {
        executeHostAction.mockClear();
        executeHostAction.mockResolvedValueOnce({
            ok: false as const,
            errorCode: 'plugins_reload_failed',
            error: 'reload failed',
        });

        const settlement = await settleComposed(client.executeAction(HOST_ACTION_ID, {
            pluginId: CALLER_PLUGIN_ID,
        }));

        expect(settlement.settled).toBe('rejected');
        expect(settlement.settled === 'rejected' ? settlement.diagnostics : [])
            .toContain('plugins_reload_failed');
    });

    it('rejects a failed contributed action instead of resolving the failure envelope as a result', async () => {
        contributedActionExecute.mockClear();
        contributedActionExecute.mockResolvedValueOnce({
            supported: true as const,
            result: { ok: false as const, code: 'plugin_action_surface_unavailable' },
        });

        const settlement = await settleComposed(client.executeAction('refresh-index', {}));

        expect(settlement.settled).toBe('rejected');
        expect(settlement.settled === 'rejected' ? settlement.diagnostics : [])
            .toContain('plugin_action_surface_unavailable');
    });

    it('preserves canonical contributed-action remediation on the generic dispatch outcome', async () => {
        const execute = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: {
                ok: false as const,
                code: 'channels_connection_required',
                retryable: false,
                remediation: { kind: 'openSettings' as const, path: '/settings/channels' },
            },
        }));

        await expect(dispatchPluginSurfaceAction({
            action: { pluginId: CALLER_PLUGIN_ID, localId: 'refresh-index' },
            contributedAction: {
                machineId: 'machine-1',
                execute,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'channels_connection_required',
            retryable: false,
            remediation: { kind: 'openSettings', path: '/settings/channels' },
        });
    });

    it('rejects an unreachable daemon front door as a typed failure', async () => {
        contributedActionExecute.mockClear();
        contributedActionExecute.mockResolvedValueOnce({
            supported: false as const,
            reason: 'not-supported' as const,
        });

        const settlement = await settleComposed(client.executeAction('refresh-index', {}));

        expect(settlement.settled).toBe('rejected');
        expect(settlement.settled === 'rejected' ? settlement.diagnostics : [])
            .toContain('plugin_ui_action_host_unavailable');
    });
});

/**
 * Composed React Native seam (plan §7 layer 3 / EU-2 gate).
 *
 * The canonical RN adapter is the public `PluginUiHostApi` an author holds
 * inside a React Native surface. Driving it over the real mounted host API
 * proves the same two branches and the same UI-D26 stamp reach the daemon front
 * door from RN, and that a failed dispatch REJECTS on this transport rather than
 * resolving the error envelope as an action result (UI-D08).
 */
describe('composed React Native host API to canonical plugin-surface dispatcher', () => {
    const canonicalSurface = {
        mount: {
            kind: 'embedded',
            role: 'plugin-surface-action-dispatch-test',
            presentation: 'content',
        },
        target: { kind: 'app' as const },
        accountEncryptionMode: 'e2ee' as const,
        theme: projectPluginUiTheme(resolveThemeProfile({ mode: 'light', profile: null })),
        translations: {},
        platform: 'ios' as const,
        locale: 'en',
        direction: 'ltr' as const,
        colorScheme: 'light' as const,
        contrast: 'normal' as const,
        textScale: 1,
        reducedMotion: false,
        screenReaderEnabled: false,
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        targetedContributions: {
            target: {
                pluginId: CALLER_PLUGIN_ID,
                occurrenceId: 'target-generation-a',
                sourceCustody: TARGET_SOURCE_CUSTODY,
            },
            points: [],
        },
    } as const satisfies SurfaceContext;

    function createReactNativeSurface(input: Readonly<{
        executeHostAction: PluginSurfaceHostActionExecute;
        contributedActionExecute: PluginSurfaceContributedActionTransport;
    }>) {
        const requestSurface = surfaceContext();
        const mountedBinding = {
            pluginId: requestSurface.pluginId,
            contributionLocalId: requestSurface.contributionId,
            occurrenceId: `${requestSurface.pluginId}:current`,
            materializationRef: {
                machineId: 'machine-rn',
                materializationId: 'materialization-rn-current',
                pluginId: requestSurface.pluginId,
            },
        } as const;
        const hostApi = createPluginSurfaceActionHostApi({
            surfaceContext: requestSurface,
            callerBinding: mountedBinding,
            hostAction: { execute: input.executeHostAction, context: { serverId: 'server-rn' } },
            contributedAction: {
                machineId: 'machine-rn',
                serverId: 'server-rn',
                execute: input.contributedActionExecute,
            },
        });
        return createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface,
            requestIdPrefix: 'rn-dispatch',
            handleRequest: hostApi.handleRequest,
            installedMethods: hostApi.installedMethods,
        });
    }

    it('carries both branches from the React Native public API with the host stamps intact', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));
        const contributedActionExecute = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { refreshed: true } },
        }));
        const adapter = createReactNativeSurface({
            executeHostAction,
            contributedActionExecute,
        });

        // The advertised set is EU-1's contract (`watchContext` is served locally
        // from the one context snapshot); this lane asserts only that the action
        // method is factually installed by the mount.
        expect(adapter.api.version().methods).toContain('executeAction');

        await expect(adapter.api.executeAction(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }))
            .resolves.toEqual({ reloaded: true });
        expect(executeHostAction).toHaveBeenCalledWith(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }, {
            actionRequestId: 'rn-dispatch:1',
            serverId: 'server-rn',
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: CALLER_PLUGIN_ID,
                contributionLocalId: surfaceContext().contributionId,
                occurrenceId: `${CALLER_PLUGIN_ID}:current`,
                materialization: {
                    machineId: 'machine-rn',
                    materializationId: 'materialization-rn-current',
                    pluginId: CALLER_PLUGIN_ID,
                },
            },
        });

        await expect(adapter.api.executeAction('refresh-index', { reason: 'rn' }))
            .resolves.toEqual({ refreshed: true });
        expect(contributedActionExecute).toHaveBeenCalledWith('machine-rn', {
            serverId: 'server-rn',
            expectedContributorOccurrenceId: `occurrence-${CALLER_PLUGIN_ID}`,
            qualifiedActionId: `${CALLER_PLUGIN_ID}/refresh-index`,
            input: { reason: 'rn' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    pluginId: CALLER_PLUGIN_ID,
                    contributionLocalId: surfaceContext().contributionId,
                    occurrenceId: `${CALLER_PLUGIN_ID}:current`,
                    materializationRef: {
                        machineId: 'machine-rn',
                        materializationId: 'materialization-rn-current',
                        pluginId: CALLER_PLUGIN_ID,
                    },
                },
            },
        });
    });

    it('rejects a failed dispatch on the React Native transport instead of resolving the envelope', async () => {
        const adapter = createReactNativeSurface({
            executeHostAction: vi.fn<PluginSurfaceHostActionExecute>(async () => ({
                ok: false as const,
                errorCode: 'plugins_reload_failed',
                error: 'reload failed',
            })),
            contributedActionExecute: vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
                supported: true as const,
                result: { ok: false as const, code: 'plugin_action_surface_unavailable' },
            })),
        });

        await expect(adapter.api.executeAction(HOST_ACTION_ID, {
            pluginId: CALLER_PLUGIN_ID,
        })).rejects.toMatchObject({
            code: 'unavailable',
            diagnostics: [{ code: 'plugins_reload_failed', severity: 'error' }],
        });
        await expect(adapter.api.executeAction('refresh-index', {})).rejects.toMatchObject({
            code: 'unavailable',
            diagnostics: [{ code: 'plugin_action_surface_unavailable', severity: 'error' }],
        });
    });
});
