import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { projectedActionToDefinition } from '@/components/appShell/currentUiContext/contributedActionDefinition';
import {
    type ActionSessionTargetDeclarationV1} from '@happier-dev/protocol/actions/sessionTargetV1';
import {
    formatQualifiedPluginActionId} from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';

import { createPluginUiHostApiClient } from '@happier-dev/plugin-sdk/ui/client';
import { PluginError, isPluginError, definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
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
import type { PluginClientActionHandler, PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
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

import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';

import { projectPluginUiTheme } from './pluginUiThemeProjection';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import type {
    DispatchPluginSurfaceActionInput,
    PluginSurfaceContributedActionTransport,
    PluginSurfaceHostActionExecute,
} from './pluginSurfaceActionDispatch';
import type { PluginAppPage } from '@/components/appShell/plugins/pluginAppPages';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { createActionOperationRunner } from '../../../../../cli/src/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '../../../../../cli/src/daemon/actionOperations/actionOperationStore';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { NotificationsNotifyMeResultV1Schema } from '@happier-dev/protocol/account/notifications/notifyMeV1';
import { DOC_EDIT_PROPOSAL_HTTP_PATHS_V1, DocCollaborationActionOutputSchemasV1,
    DocEditAcceptTransportInputV1Schema, DocEditDeclineTransportInputV1Schema,
    DocEditDecisionResultV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { captureDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import { DiscussionReadResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { externalAuthoringPlugin, readExternalDoc, commentOnExternalDoc, proposeExternalDocEdit,
    requestExternalDocAcceptance, requestExternalDocDecline } from '../../../../../../packages/plugin-ui/fixtures/external-authoring/src/index';
import { manifest as authoredAccountManifest, activate as activateAuthoredAccount } from '../../../../../../packages/plugin-sdk/fixtures/account-actions/src/accountRuntime';
// Configure responses only at the physical daemon boundary, after real scoped
// Home/Account and per-caller read admission have run.
const daemonRpc = vi.hoisted(() => vi.fn());
const newSessionNavigation = vi.hoisted(() => vi.fn());
const nestedActionConfirmation = vi.hoisted(() => ({
    onShow: null as null | ((confirm: () => void, cancel: () => void) => void),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: newSessionNavigation } }).module;
});

// Install transport before runtime fixtures: pluginSurfaceContext reaches the
// Account encryption reader, which otherwise retains the real Socket.IO import.
const network = await installSessionOpsNetworkBoundary();
const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
const { createPluginHostedWebHostApiBridgeHandler } = await import('@/components/plugins/hostApi/hostedWebAdapter');
const { machinePluginStructuredMessageActionExecute, resetMachineProjectionReadsForTests } = await import('@/sync/ops/machineContributionRegistryProjection');
const { getMachineContributionRegistryProjectionRevision } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { resolveReasonCopy } = await import('@/sync/domains/surfaces/copy');
const { createCanonicalPluginReactNativeHostApiAdapter } = await import('@/components/plugins/reactNative/hostApi');
const { createPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
const { getInstalledPluginUiClientExecutableComposition, resolvePluginUiClientActionRegistration } = await import('@/components/plugins/reactNative/clientExecutableContributions');
const { resolveProjectedPluginUiClientExecutables } = await import('@/components/plugins/reactNative/clientExecutableProjection');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { createPluginSurfaceActionHostApi: createPluginSurfaceActionHostApiImpl, dispatchPluginSurfaceAction: dispatchPluginSurfaceActionImpl } = await import('./pluginSurfaceActionDispatch');
const { createBoundPluginSurfaceController, useBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');
const { createPluginActionInputSelectionFactsPublication } = await import('./pluginActionInputSelectionFacts');
const { createPluginSurfaceStoredImageOwner } = await import('./pluginSurfaceStoredImage');
const { observePluginSurfaceActionRead } = await import('./pluginSurfaceActionReadObservation');
const { dispatchPluginResolvedSemanticCommand } = await import('./dispatchPluginResolvedSemanticCommand');
const { dispatchPluginAppPageHeaderAction } = await import('@/components/appShell/plugins/pluginAppPageHeaderActions');
const { getPluginUiEphemeralSharedScope } = await import('./pluginUiEphemeralSharedScope');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { getCurrentAuth, setCurrentAuth } = await import('@/auth/context/currentAuth');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { readCredentialAuthorityKind } = await import('@/auth/context/credentialAuthority');
const { createEntityDragDropRuntime } = await import('@/components/ui/treeDragDrop/entityDragDropRuntime');
const { createPluginEntityDragDropBinding, executeMountedPluginEntityDropAction, settlePluginEntityDropActionResult } = await import('./entityDragDrop/pluginEntityDragDropBinding');
const { createUiAccountActionTransport } = await import('@/sync/ops/actions/accountActionTransport');
const { answerDiscussionThreadForTests, createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
const { createCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
const { executeCurrentUiContextContributedAction, registerCurrentUiContextActionPort } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
const { markSessionListQueryResultV1 } = await import('@happier-dev/protocol/sessions/awareness/action');
const { listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
const rpcHomes = new Map<string, Awaited<ReturnType<typeof network.addHome>>>();

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

beforeEach(async () => {
    network.resetRequests();
    resetMachineProjectionReadsForTests();
    daemonRpc.mockReset();
    daemonRpc.mockImplementation(async (request: unknown) => answerActionSchemasRead(request));
    await Promise.all(['server-client-action', 'server-wire', 'server-default', 'schema-home', 'server-composed', 'server-rn', 'server-1'].map(async name => {
        const home = await network.addHome(`https://${name}`, 'test-account',
            name === 'server-client-action' ? { serverIdentityId: 'srv_client_action' } : {});
        rpcHomes.set(name, home);
    }));
    await setActiveServer({ serverId: rpcHomes.get('server-client-action')!.id });
    network.setHttpResponder(async (url, init) => createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init));
    network.setRpcResponder(async request => daemonRpc({
        machineId: request.targetId,
        serverId: listServerProfiles().find(home => home.serverUrl === request.serverUrl)?.id,
        method: request.method,
        payload: request.payload,
        timeoutMs: request.timeoutMs,
    }));
});

afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    resetScopedMachineTransportCacheForTests();
});
afterAll(async () => { await network.dispose(); });

async function readContributedActionWire(machineId: string, options: Parameters<PluginSurfaceContributedActionTransport>[1]) {
    let payload: unknown;
    // Observe the actual serializer at its network boundary, including its issuance fence.
    daemonRpc.mockImplementationOnce(async (request: unknown) => {
        if (!request || typeof request !== 'object' || !('payload' in request)) throw new Error('Expected an RPC payload');
        expect('method' in request && request.method).toBe(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        payload = request.payload;
        return { ok: true, result: {} };
    });
    expect(await machinePluginStructuredMessageActionExecute(machineId, options)).toMatchObject({ supported: true, result: { ok: true } });
    return DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(payload);
}

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
    const lifetime = {
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
    onTestFinished(lifetime.retire);
    return lifetime;
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
        artifactId: artifactGraph.artifactId,
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
    dangerLevel?: PluginProjectedActionV2['dangerLevel'];
    confirmationWhen?: PluginProjectedActionV2['confirmationWhen'];
    surfaces?: PluginProjectedActionV2['surfaces'];
    accountPlacement?: boolean;
    sessionTarget?: ActionSessionTargetDeclarationV1;
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
        execution: input.accountPlacement ? { target: 'account', account: {
            artifactId: CLIENT_ACTION_TARGET.artifactId, exportName: CLIENT_ACTION_TARGET.exportName,
        } } : {
            target: 'client',
            client: {
                artifactId: CLIENT_ACTION_TARGET.artifactId,
                                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [CLIENT_ACTION_TARGET.platform],
        },
        ...(input.accountPlacement ? {} : { executionOrigin }),
        dangerLevel,
        ...(input.sessionTarget ? { sessionTarget: input.sessionTarget } : {}),
        ...(input.confirmationWhen ? { confirmationWhen: input.confirmationWhen } : {}),
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
    dangerLevel?: PluginProjectedActionV2['dangerLevel'];
    confirmationWhen?: PluginProjectedActionV2['confirmationWhen'];
    surfaces?: PluginProjectedActionV2['surfaces'];
    inputSchema?: object;
    outputSchema?: object;
    handler?: PluginClientActionHandler;
    accountHandler?: PluginAccountActionHandler;
    readOnly?: import('@happier-dev/protocol/plugins/actions/v2').PluginActionContributionV2['readOnly'];
    observeRead?: import('@happier-dev/plugin-sdk/actions').PluginActionReadObserver<PluginUiJsonValueV1, import('@happier-dev/plugin-sdk/actions').PluginAccountActionContext>;
    accountLifetime?: ActiveServerAccountScopeLifetime;
    occurrenceId?: string;
    artifactGraph?: PluginUiArtifactsManifestEntryV2;
    accountPlacement?: boolean;
    authoredAccount?: boolean;
    accountManifest?: typeof authoredAccountManifest;
    accountAvailability?: { when: { fact: 'session.exists'; operator: 'equals'; value: boolean } };
    sessionTarget?: ActionSessionTargetDeclarationV1;
    inputHints?: PluginProjectedActionV2['inputHints'];
}>) {
    const pluginId = input.authoredAccount ? authoredAccountManifest.id : input.pluginId ?? CALLER_PLUGIN_ID;
    const pluginVersion = input.authoredAccount ? authoredAccountManifest.version : '1.2.3';
    const localId = input.localId ?? 'refresh-index';
    const executionOrigin = clientActionExecutionOrigin(pluginId);
    const hostOrigin = Object.freeze({
        ...CLIENT_ACTION_HOST_ORIGIN,
        machineId: executionOrigin.materializationRef.machineId,
        executionOrigin,
    });
    const baseAction = createClientTargetAction({
        identity: { pluginId, localId },
        dangerLevel: input.dangerLevel,
        surfaces: input.surfaces,
        accountPlacement: input.accountPlacement,
        sessionTarget: input.sessionTarget,
        confirmationWhen: input.confirmationWhen,
    });
    const authoredDeclaration = input.authoredAccount ? authoredAccountManifest.contributes?.actions?.find(row => row.id === localId) : undefined;
    if (input.authoredAccount && !authoredDeclaration) throw new Error('Authored Account Action missing');
    const action = authoredDeclaration ? PluginProjectedActionV2Schema.parse({ ...baseAction,
        title: authoredDeclaration.title, scopes: authoredDeclaration.scopes, surfaces: authoredDeclaration.surfaces,
        execution: authoredDeclaration.execution, placementBindings: authoredDeclaration.placementBindings,
        dangerLevel: authoredDeclaration.dangerLevel, confirmation: authoredDeclaration.confirmation,
    }) : baseAction;
    clientActionSchemasByQualifiedId.set(`${pluginId}/${localId}`, {
        inputSchema: input.inputSchema ?? {},
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    });
    const artifactGraph = input.artifactGraph ?? (input.authoredAccount ? PluginUiArtifactsManifestEntryV2Schema.parse({
        ...CLIENT_ACTION_ARTIFACT_GRAPH, artifactId: 'account-runtime', executable: { exports: ['activate'] },
        entry: 'react-native/account-runtime/entry.cjs.bundle',
        files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({ ...file, relativePath: 'react-native/account-runtime/entry.cjs.bundle' })),
    }) : CLIENT_ACTION_ARTIFACT_GRAPH);
    const identity = clientActionIdentity(localId, pluginId, artifactGraph);
    const accountOrigin = input.accountPlacement ? { serverId: 'server-client-action', accountId: 'test-account',
        custodyId: input.occurrenceId ?? `occurrence-${pluginId}`,
        sourceCustody: { kind: 'account_release', pluginId, version: pluginVersion, archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
    } : undefined;
    const accountDeclaration = input.accountManifest ?? (input.authoredAccount ? authoredAccountManifest : input.accountPlacement ? {
        schemaVersion: 2, id: pluginId, version: '1.2.3', displayName: 'Account author fixture', runtime: { apiVersion: 1 },
        contributes: { actions: [{ id: action.id, title: action.title, scopes: action.scopes, surfaces: action.surfaces,
            execution: action.execution, dangerLevel: action.dangerLevel, placementBindings: action.placementBindings,
            ...(action.confirmation ? { confirmation: action.confirmation } : {}), inputSchema: input.inputSchema ?? {},
            ...(input.accountAvailability ? { availability: input.accountAvailability } : {}),
            ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
            ...(input.outputSchema ? { resultSchema: input.outputSchema } : {}) }] },
    } : undefined);
    const projectedAction = Object.freeze({
        ...action,
        ...(input.inputHints ? { inputHints: input.inputHints } : {}),
        occurrenceId: input.occurrenceId ?? `occurrence-${pluginId}`,
        authorization: {
            ...CLIENT_ACTION_AUTHORIZATION,
            generation: {
                targetGeneration: input.occurrenceId ?? `occurrence-${pluginId}`,
                desiredGeneration: input.occurrenceId ?? `occurrence-${pluginId}`,
                appliedGeneration: input.occurrenceId ?? `occurrence-${pluginId}`,
            },
        },
        ...(accountOrigin ? { hostAccountOrigin: accountOrigin,
            accountActionDeclaration: accountDeclaration?.contributes.actions?.find(candidate => candidate.id === action.id) }
            : { executionOrigin, [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin }),
    });
    const bundleId = `reactNativeBundle:${pluginId}:${localId}`;
    const projectedActions = input.authoredAccount ? Object.fromEntries((authoredAccountManifest.contributes?.actions ?? []).map(declaration => [
        `${pluginId}/${declaration.id}`, Object.freeze({ ...projectedAction, id: declaration.id,
            title: declaration.title, scopes: declaration.scopes, surfaces: declaration.surfaces,
            execution: declaration.execution, placementBindings: declaration.placementBindings,
            dangerLevel: declaration.dangerLevel, confirmation: declaration.confirmation,
            accountActionDeclaration: declaration }),
    ])) : { [`${pluginId}/${localId}`]: projectedAction };
    const projection = Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: CLIENT_ACTION_GENERATION,
        installedPackagesById: Object.freeze({
            [pluginId]: PluginProjectionInstalledPackageV2Schema.parse({
                id: pluginId,
                displayName: 'Happier Inspector',
                version: pluginVersion,
                enabled: true,
                source: { kind: 'localPath', locator: pluginId },
            }),
        }),
        actionsById: Object.freeze(projectedActions),
        reactNativeBundlesById: Object.freeze(Object.fromEntries(Object.values(projectedActions).map(projected => {
            const id = input.authoredAccount ? `reactNativeBundle:${pluginId}:${projected.id}` : bundleId;
            return [id, Object.freeze({
                id,
                pluginId,
                occurrenceId: projectedAction.occurrenceId,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: projected.id,
                generatedOwnerKind: 'clientContribution' as const,
                artifactGraph,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity: Object.freeze({ artifactDigest: artifactGraph.digest }),
                }),
                ...(accountOrigin ? { hostAccountOrigin: accountOrigin }
                    : { [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin }),
            })];
        }))),
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
    const activate = vi.fn(input.authoredAccount ? activateAuthoredAccount : (api: PluginClientApi) => {
        // The registration transaction is real: only the artifact loader is a
        // system-boundary test double.
        if (input.accountHandler) {
            // The selected Account realm is checked by the real registration scope.
            (api as unknown as import('@happier-dev/plugin-sdk').PluginAccountApi).actions.register(localId, input.accountHandler,
                input.observeRead ? { observeRead: input.observeRead } : undefined);
        } else api.actions.register(localId, input.handler ?? (() => { throw new Error('Handler fixture missing'); }));
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

describe('Account Action placement through the executable dispatcher', () => {
    it.each([
        { coldBinding: false, settlement: 'ready' },
        { coldBinding: true, settlement: 'ready' },
        { coldBinding: true, settlement: 'unavailable' },
        { coldBinding: true, settlement: 'cancelled' },
        { coldBinding: true, settlement: 'withdrawn' },
        { coldBinding: true, settlement: 'retargeted' },
        { coldBinding: true, settlement: 'declaration-withdrawn' },
        { coldBinding: true, settlement: 'declaration-replaced' },
    ] as const)('waits for the mounted Machine settlement before nested Account continuation dispatch ($settlement, cold binding=$coldBinding)', async ({ coldBinding, settlement }) => {
        const accountLifetime = clientAccountLifetime();
        const sourceId = 'acme.provider-source';
        let provider = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction({ pluginId: sourceId, localId: 'list' }), surfaces: ['plugin'] });
        let providerCurrent = true;
        const machine = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({ supported: true,
            result: { ok: true, result: { rows: ['provider'] } } }));
        let entered = 0;
        let enteredSignal: AbortSignal | undefined;
        const target = definePlugin({ id: CALLER_PLUGIN_ID, version: '1.2.3', actions: {
            'refresh-index': { title: 'Account entry', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: CLIENT_ACTION_TARGET.artifactId,
                    exportName: CLIENT_ACTION_TARGET.exportName } }, run: async () => null },
        } });
        const parsed = ingestPluginManifestV2(target.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        replacePluginAccountAvailabilityProjection({ scope: accountLifetime.scope, snapshot: { availabilityCursor: 1,
            materializations: [], snapshots: [], intentReads: [{ pluginId: parsed.manifest.id, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId: parsed.manifest.id, desiredVersion: parsed.manifest.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId: parsed.manifest.id, version: parsed.manifest.version },
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: parsed.manifest,
                    collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } }] } });
        const selected = readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecution(CALLER_PLUGIN_ID);
        if (selected.kind !== 'available') throw new Error('Expected current Account requester custody');
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountManifest: target.manifest, occurrenceId: selected.custodyId,
            accountHandler: async (_value, context) => {
                entered += 1;
                enteredSignal = context.signal;
                return await context.services.actions.execute({ pluginId: sourceId, localId: 'list' }, {});
            } });
        await activation.composition.unload();
        await activation.composition.reconcile([activation.activation]);
        const actionInputSelectionFactsKey = createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: CALLER_PLUGIN_ID });
        const facts = { pluginId: CALLER_PLUGIN_ID, contributionId: 'panel', surfaceId: 'nested-pending-panel',
            placement: 'appSurface' as const, platform: 'web' as const, channel: 'internal' as const,
            machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, serverId: accountLifetime.scope.serverId, occurrenceId: selected.custodyId,
            accountExecutionOrigin: { serverId: accountLifetime.scope.serverId, accountId: accountLifetime.scope.accountId,
                custodyId: selected.custodyId, sourceCustody: selected.sourceCustody },
            executionOrigin: CLIENT_ACTION_ORIGIN, accountLifetime, actionInputSelectionFactsKey,
            interactionEnabled: true, pluginUiProjection: activation.projection,
            resolveContributedAction: (identity: PluginContributionIdentityV1) => identity.pluginId === sourceId
                ? (providerCurrent ? provider : null) : resolveExactClientAction(activation.action)(identity) };
        type Admission = { daemonReady: boolean; originCurrent: boolean; pending: boolean; bound: boolean; machineId?: string };
        const hook = await renderHook((admission: Admission) => useBoundPluginSurfaceController({
            facts: { ...facts, daemonOccurrenceId: admission.bound ? 'machine-lease-current' : undefined,
                machineId: admission.machineId ?? facts.machineId,
                daemonConnectionFailure: { code: 'timeout', reasonCode: 'plugin_machine_unreachable' },
                daemonInteractionEnabled: admission.daemonReady, isDaemonConnectionPending: () => admission.pending },
            binding: { executeContributedAction: machine, isExecutionOriginCurrent: () => admission.originCurrent },
        }), { initialProps: { daemonReady: false, originCurrent: true, pending: true, bound: !coldBinding } });
        try {
            const controller = hook.getCurrent();
            expect(controller.isRequesterAdmitted()).toBe(true);
            expect(controller.interactive).toBe(true);
            expect(controller.canInteractWithDaemon()).toBe(false);
            let settled = false;
            const cancellation = new AbortController();
            const read = Promise.resolve(controller.hostApi.handleRequest({ version: 1, requestId: 'nested-pending-read',
                surface: controller.surfaceContext, method: 'executeAction',
                payload: { action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {} },
            }, { signal: cancellation.signal }));
            void read.then(() => { settled = true; }, () => { settled = true; });
            await vi.waitFor(() => expect(entered).toBe(1));
            await act(async () => {});
            expect(enteredSignal?.aborted).toBe(false);
            expect(machine).not.toHaveBeenCalled();
            expect(settled, 'daemon readiness is pending even though caller interaction and origin currentness are admitted').toBe(false);
            expect(await hook.rerender({ daemonReady: true, originCurrent: false, pending: true, bound: true })).toBe(controller);
            expect(controller.canInteractWithDaemon()).toBe(false);
            expect(settled).toBe(false);
            expect(machine).not.toHaveBeenCalled();
            if (settlement === 'unavailable') {
                expect(await hook.rerender({ daemonReady: false, originCurrent: true, pending: false, bound: false })).toBe(controller);
                await expect(read).resolves.toMatchObject({ code: 'timeout', diagnostics: expect.arrayContaining(['plugin_machine_unreachable']) });
            } else if (settlement === 'cancelled' || settlement === 'withdrawn') {
                if (settlement === 'cancelled') cancellation.abort();
                else accountLifetime.retire();
                await expect(read).resolves.toMatchObject({ code: 'timeout', diagnostics: ['plugin_ui_action_outcome_unknown'] });
                expect(enteredSignal?.aborted).toBe(true);
            } else if (settlement === 'retargeted') {
                await hook.rerender({ daemonReady: true, originCurrent: true, pending: false, bound: true, machineId: 'replacement-machine' });
                await expect(read).resolves.toMatchObject({ code: 'unavailable', diagnostics: ['plugin_ui_generation_retired'] });
            } else if (settlement === 'declaration-withdrawn') {
                providerCurrent = false;
                await hook.rerender({ daemonReady: true, originCurrent: true, pending: false, bound: true });
                await expect(read).resolves.toMatchObject({ code: 'unavailable', diagnostics: ['plugin_surface_action_projection_unavailable'] });
            } else if (settlement === 'declaration-replaced') {
                provider = { ...provider, occurrenceId: 'replacement-contributor' };
                await hook.rerender({ daemonReady: true, originCurrent: true, pending: false, bound: true });
                await expect(read).resolves.toMatchObject({ code: 'unavailable', diagnostics: ['plugin_ui_generation_retired'] });
            }
            if (settlement !== 'ready') {
                expect(entered).toBe(1);
                expect(machine).not.toHaveBeenCalled();
                return;
            }
            expect(await hook.rerender({ daemonReady: true, originCurrent: true, pending: false, bound: true })).toBe(controller);
            await expect(read).resolves.toEqual({ rows: ['provider'] });
            expect(enteredSignal?.aborted).toBe(false);
            expect(entered).toBe(1);
            expect(machine).toHaveBeenCalledTimes(1);
            expect(machine.mock.calls[0]?.[0]).toBe(CLIENT_ACTION_ORIGIN.materializationRef.machineId);
        } finally { await hook.unmount(); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('does not replay an entered Account handler that throws an unavailable diagnostic while its Machine is pending', async () => {
        const accountLifetime = clientAccountLifetime();
        let entered = 0;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async () => {
                entered += 1;
                throw new PluginError({ code: 'plugin_surface_contributed_action_unavailable' });
            } });
        await activation.composition.unload();
        await activation.composition.reconcile([activation.activation]);
        const actionInputSelectionFactsKey = createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: CALLER_PLUGIN_ID });
        const hook = await renderHook((pending: boolean) => useBoundPluginSurfaceController({ facts: {
            pluginId: CALLER_PLUGIN_ID, contributionId: 'panel', surfaceId: 'entered-account-failure',
            placement: 'appSurface', platform: 'web', channel: 'internal',
            machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, serverId: accountLifetime.scope.serverId,
            occurrenceId: 'requester-current', executionOrigin: CLIENT_ACTION_ORIGIN, accountLifetime, actionInputSelectionFactsKey,
            interactionEnabled: true, daemonInteractionEnabled: !pending, isDaemonConnectionPending: () => pending,
            pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action),
        } }), { initialProps: true });
        try {
            let settled = false;
            const read = hook.getCurrent().dispatchAction({ pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, {});
            void read.then(() => { settled = true; }, () => { settled = true; });
            await vi.waitFor(() => expect(entered).toBe(1));
            await act(async () => {});
            expect(settled, 'an entered handler failure is terminal, not pre-invocation connection admission').toBe(true);
            await expect(read).resolves.toMatchObject({ code: 'unavailable', diagnostics: ['plugin_surface_contributed_action_unavailable'] });
            await hook.rerender(false);
            expect(entered).toBe(1);
        } finally { await hook.unmount(); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('finishes an entered Account Action across its unchanged caller Resource declaration refresh', async () => {
        const accountLifetime = clientAccountLifetime();
        let enteredSignal: AbortSignal | undefined;
        let release = () => {};
        const settled = new Promise<void>(resolve => { release = resolve; });
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async (_value, context) => {
                enteredSignal = context.signal;
                await settled;
                return { read: true };
            } });
        const actionInputSelectionFactsKey = createPluginActionInputSelectionFactsPublication()
            .publish({ targetPluginId: CALLER_PLUGIN_ID });
        const facts = {
            pluginId: CALLER_PLUGIN_ID, contributionId: 'panel', surfaceId: 'caller-panel',
            placement: 'appSurface' as const, platform: 'web' as const, channel: 'internal' as const,
            machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
            serverId: accountLifetime.scope.serverId, occurrenceId: 'requester-current',
            executionOrigin: CLIENT_ACTION_ORIGIN, accountLifetime, actionInputSelectionFactsKey,
            interactionEnabled: true, daemonInteractionEnabled: true,
            resourceCapability: { readable: true, dynamic: true },
            resolveContributedAction: resolveExactClientAction(activation.action),
            pluginUiProjection: activation.projection,
        };
        await activation.composition.unload();
        await activation.composition.reconcile([activation.activation]);
        const hook = await renderHook(({ projection }: { projection: PluginUiProjectionModel }) =>
            useBoundPluginSurfaceController({ facts: { ...facts, pluginUiProjection: projection } }),
        { initialProps: { projection: activation.projection } });
        try {
            const pending = hook.getCurrent().dispatchAction({ pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, {});
            await vi.waitFor(() => expect(enteredSignal).toBeDefined());
            await hook.rerender({ projection: { ...activation.projection, resourcesById: {
                [`${CALLER_PLUGIN_ID}/status`]: { id: 'status', pluginId: CALLER_PLUGIN_ID,
                    resourceKind: 'config', scope: 'global', contentType: 'application/json' },
            } } });
            expect(enteredSignal!.aborted).toBe(false);
            release();
            expect(await pending).toEqual({ read: true });
        } finally {
            release();
            await hook.unmount();
            await activation.composition.unload();
            accountLifetime.retire();
        }
    });

    it('refuses an admitted Account Action until its exact executable registration commits, and again after withdrawal', async () => {
        const accountLifetime = clientAccountLifetime();
        let effects = 0;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async () => { effects += 1; return { read: true }; } });
        const dispatch = () => dispatchPluginSurfaceAction({
            action: { pluginId: activation.action.pluginId, localId: activation.action.id },
            input: {}, clientAction: {}, pluginUiProjection: activation.projection,
            resolveContributedAction: resolveExactClientAction(activation.action),
        });
        await activation.composition.unload();
        try {
            expect(await dispatch()).toMatchObject({ ok: false, code: 'unavailable',
                reason: 'plugin_surface_client_action_unavailable' });
            expect(effects).toBe(0);
            expect((await activation.composition.reconcile([activation.activation])).map(attempt => attempt.result))
                .toEqual([{ ok: true }]);
            expect(await dispatch()).toEqual({ ok: true, result: { read: true } });
            expect(effects).toBe(1);
            await activation.composition.unload();
            expect(await dispatch()).toMatchObject({ ok: false, code: 'unavailable',
                reason: 'plugin_surface_client_action_unavailable' });
            expect(effects).toBe(1);
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('does not adopt a replacement contributor for an admitted source occurrence', async () => {
        const accountLifetime = clientAccountLifetime();
        let effects = 0;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async () => { effects += 1; return null; } });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const dispatch = (expectedContributorOccurrenceId: string) => dispatchPluginSurfaceAction({
                action: { pluginId: activation.action.pluginId, localId: activation.action.id }, input: {},
                expectedContributorOccurrenceId, clientAction: {}, pluginUiProjection: activation.projection,
                resolveContributedAction: resolveExactClientAction(activation.action),
            });
            expect(await dispatch('previous-admitted-source')).toMatchObject({ ok: false });
            expect(effects).toBe(0);
            expect(await dispatch(activation.action.occurrenceId)).toEqual({ ok: true, result: null });
            expect(effects).toBe(1);
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('preserves the public failure metadata of a nested Account Action', async () => {
        const accountLifetime = clientAccountLifetime();
        const target = createClientActionActivation({ pluginId: 'acme.account-failure', accountPlacement: true,
            artifactGraph: PluginUiArtifactsManifestEntryV2Schema.parse({ ...CLIENT_ACTION_ARTIFACT_GRAPH,
                digest: `sha256:${'b'.repeat(64)}` }),
            accountLifetime, surfaces: ['plugin'], accountHandler: async () => { throw new PluginError({
                code: 'source_temporarily_unavailable', message: 'Try again after reconnecting', retryable: true,
            }); } });
        const parent = createClientActionActivation({ accountPlacement: true, accountLifetime, accountHandler: async (_input, context) => {
            try { await context.services.actions.execute({ pluginId: target.action.pluginId, localId: target.action.id }, {}); }
            catch (error) {
                if (!isPluginError(error)) throw error;
                return { code: error.code, retryable: error.retryable, message: error.message };
            }
            throw new Error('The nested Action must fail');
        } });
        const projection = { ...parent.projection,
            actionsById: { ...parent.projection.actionsById, ...target.projection.actionsById },
            reactNativeBundlesById: { ...parent.projection.reactNativeBundlesById, ...target.projection.reactNativeBundlesById },
        };
        await parent.composition.unload();
        try {
            expect((await parent.composition.reconcile([parent.activation, target.activation])).map(attempt => attempt.result))
                .toEqual([{ ok: true }, { ok: true }]);
            expect(await dispatchPluginSurfaceAction({
                action: { pluginId: parent.action.pluginId, localId: parent.action.id }, input: {}, clientAction: {},
                pluginUiProjection: projection,
                resolveContributedAction: identity => projection.actionsById[`${identity.pluginId}/${identity.localId}`] ?? null,
            })).toEqual({ ok: true, result: { code: 'source_temporarily_unavailable', retryable: true, message: 'Try again after reconnecting' } });
        } finally { await parent.composition.unload(); accountLifetime.retire(); }
    });

    it('keeps Account execution local when an optional Machine transport is present', async () => {
        const accountLifetime = clientAccountLifetime();
        const machine = vi.fn<PluginSurfaceContributedActionTransport>(async () => { throw new Error('Account handler must not be sent to a Machine'); });
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async () => ({ host: 'invoking-process' }) });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            expect(await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                clientAction: {}, contributedAction: { machineId: 'optional-provider-machine', serverId: 'server-client-action', execute: machine },
                pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action),
            })).toEqual({ ok: true, result: { host: 'invoking-process' } });
            expect(machine).not.toHaveBeenCalled();
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each([false, true])('preserves the host Action branch before an identically named local daemon Action: explicit=%s', async (explicit) => {
        const accountLifetime = clientAccountLifetime();
        const target = definePlugin({ id: CALLER_PLUGIN_ID, version: '1.2.3', actions: {
            'refresh-index': { title: 'Account entry', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: CLIENT_ACTION_TARGET.artifactId,
                    exportName: CLIENT_ACTION_TARGET.exportName } }, run: async () => null },
            wait: { title: 'Local wait', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' }, run: async () => null },
        } });
        const parsed = ingestPluginManifestV2(target.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        replacePluginAccountAvailabilityProjection({ scope: accountLifetime.scope, snapshot: { availabilityCursor: 1,
            materializations: [], snapshots: [], intentReads: [{ pluginId: parsed.manifest.id, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId: parsed.manifest.id, desiredVersion: parsed.manifest.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId: parsed.manifest.id, version: parsed.manifest.version },
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: parsed.manifest,
                    collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } }] } });
        const selected = readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecution(CALLER_PLUGIN_ID);
        if (selected.kind !== 'available') throw new Error('Expected current Account execution');
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountManifest: target.manifest, occurrenceId: selected.custodyId, accountHandler: async (_value, context) => {
                try { return await context.services.actions.execute(explicit ? { pluginId: CALLER_PLUGIN_ID, localId: 'wait' } : 'wait', {}); }
                catch (error) { if (isPluginError(error)) return { code: error.code }; throw error; }
            } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            expect(await dispatchPluginSurfaceAction({ action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                clientAction: {}, pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action),
                hostAction: { execute: executor.execute, context: { serverId: accountLifetime.scope.serverId, runtimeAccountId: accountLifetime.scope.accountId } },
            })).toEqual({ ok: true, result: { code: explicit ? 'plugin_action_machine_required' : 'invalid_parameters' } });
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('retains the UI origin at the strict Machine boundary of a nested Account Action', async () => {
        const accountLifetime = clientAccountLifetime();
        const sourceId = 'acme.provider-source';
        const provider = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction({ pluginId: sourceId, localId: 'list' }), surfaces: ['plugin'] });
        const requests: ReturnType<typeof DaemonPluginStructuredMessageActionExecuteRequestSchema.parse>[] = [];
        const machine: PluginSurfaceContributedActionTransport = async (machineId, request) => {
            requests.push(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
                machineId, qualifiedActionId: request.qualifiedActionId,
                expectedContributorOccurrenceId: request.expectedContributorOccurrenceId,
                executionSurface: request.executionSurface, invocation: request.invocation,
                input: request.input,
            }));
            return { supported: true, result: { ok: true, result: { rows: ['provider'] } } };
        };
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async (_value, context) => context.services.actions.execute({ pluginId: sourceId, localId: 'list' }, {}) });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            expect(await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                invocationSurface: 'ui', clientAction: {},
                contributedAction: { machineId: 'provider-machine', serverId: 'server-client-action', execute: machine },
                pluginUiProjection: activation.projection,
                resolveContributedAction: identity => identity.pluginId === sourceId ? provider : resolveExactClientAction(activation.action)(identity),
            })).toEqual({ ok: true, result: { rows: ['provider'] } });
            expect(requests).toHaveLength(1);
            expect(requests[0]).toMatchObject({ executionSurface: 'ui', invocation: { kind: 'clientPluginAction' } });
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['semantic', 'page-header'] as const)('uses the selected Machine only for a nested provider Action from the Account %s entry', async (entry) => {
        const accountLifetime = clientAccountLifetime();
        const sourceId = 'acme.provider-source';
        const provider = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction({ pluginId: sourceId, localId: 'list' }), surfaces: ['plugin'] });
        const machine = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({ supported: true, result: { ok: true, result: { rows: ['provider'] } } }));
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async (_value, context) => context.services.actions.execute({ pluginId: sourceId, localId: 'list' }, {}) });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const projection = { ...activation.projection, actionsById: { ...activation.projection.actionsById, [`${sourceId}/list`]: provider } };
            const command = { kind: 'executeAction' as const, action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {} };
            const outcome = entry === 'semantic' ? await dispatchPluginResolvedSemanticCommand({
                projection, callerPluginId: CALLER_PLUGIN_ID, command,
                scopedLaunchFacts: { serverId: 'server-client-action', machineId: 'provider-machine', interactionEnabled: true },
                execute: machine, accountLifetime, scopeIsCurrent: () => accountLifetime.isCurrent(),
            }) : await dispatchPluginAppPageHeaderAction({
                action: { id: 'read-provider', title: 'Read provider', command },
                page: { pluginId: CALLER_PLUGIN_ID } as PluginAppPage,
                projection, resolveContributedAction: identity => projection.actionsById[`${identity.pluginId}/${identity.localId}`] ?? null,
                actionAuthority: { serverId: 'server-client-action', machineId: 'provider-machine',
                    occurrenceId: activation.action.occurrenceId, executionOrigin: null, accountLifetime },
                execute: machine, openSurface: async () => ({ ok: true }), isCurrent: () => accountLifetime.isCurrent(),
            });
            expect(outcome).toEqual({ ok: true, result: { rows: ['provider'] } });
            expect(machine).toHaveBeenCalledOnce();
            expect(machine.mock.calls[0]?.[1]).toMatchObject({ qualifiedActionId: `${sourceId}/list`, invocation: { kind: 'clientPluginAction', clientActionBinding: {
                pluginId: CALLER_PLUGIN_ID, sourceCustody: { kind: 'account_release' },
            } } });
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each([true, false])('admits a Machine source through the Account dispatcher with Machine available=%s', async (machineAvailable) => {
        const accountLifetime = clientAccountLifetime();
        const schema = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
        const protocol = defineContributionProtocol({ id: 'source', version: 1, operations: {
            inspect: { required: true, input: { kind: 'protocolDefined', schema }, resultSchema: schema,
                action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
        } });
        const target = definePlugin({ id: CALLER_PLUGIN_ID, version: '1.2.3',
            contributionPoints: { sources: protocol.point() }, actions: {
                'refresh-index': { title: 'Read source', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe',
                    execution: { target: 'account', account: { artifactId: CLIENT_ACTION_TARGET.artifactId, exportName: CLIENT_ACTION_TARGET.exportName } },
                    run: async () => null },
            } });
        const source = definePlugin({ id: 'acme.machine-source', version: '1.0.0', actions: {
            inspect: { title: 'Read', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
                inputSchema: schema, resultSchema: schema, run: async value => value },
        }, contributesTo: { [CALLER_PLUGIN_ID]: { sources: {
            external: protocol.contribute({ operations: { inspect: protocol.operations.inspect.bind('inspect') } }),
        } } } });
        const parsedTarget = ingestPluginManifestV2(target.manifest);
        const parsedSource = ingestPluginManifestV2(source.manifest);
        if (!parsedTarget.ok || !parsedSource.ok) throw new Error('Public manifests must be admitted');
        replacePluginAccountAvailabilityProjection({ scope: accountLifetime.scope, snapshot: {
            availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [parsedTarget.manifest, parsedSource.manifest].map(manifest => ({ pluginId: manifest.id, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId: manifest.id, version: manifest.version },
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest,
                    collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } })),
        } });
        const selected = readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecution(CALLER_PLUGIN_ID);
        if (selected.kind !== 'available') throw new Error('Expected current Account target');
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountManifest: target.manifest, occurrenceId: selected.custodyId, accountHandler: async (_value, context) => {
                const observation = context.services.targetedContributions.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
                try {
                    const snapshot = await observation.readCurrent();
                    expect(snapshot.contributions).toHaveLength(1);
                    try {
                        return await context.services.actions.executeAdmittedTargetedOperation(snapshot.contributions[0]!.operations.inspect, { key: 'source read' });
                    } catch (error) {
                        if (!machineAvailable && isPluginError(error)) return { code: error.code };
                        throw error;
                    }
                } finally { observation.dispose(); }
            } });
        const provider = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction({ pluginId: source.manifest.id, localId: 'inspect' }),
            occurrenceId: 'machine-source-current', surfaces: ['plugin'] });
        const requests: ReturnType<typeof DaemonPluginStructuredMessageActionExecuteRequestSchema.parse>[] = [];
        daemonRpc.mockImplementation(async (request: { method: string; payload: unknown; onIssued?: () => void }) => {
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return {
                status: 'sourceDeclarations', pluginId: CALLER_PLUGIN_ID, sourceDeclarations: [{ occurrenceId: provider.occurrenceId,
                    sourceCustody: { kind: 'development', registeredRootId: 'machine-source-root' },
                    manifest: { id: parsedSource.manifest.id, contributes: { actions: parsedSource.manifest.contributes.actions,
                        pluginContributionPoints: [], targetedPluginContributions: parsedSource.manifest.contributes.targetedPluginContributions,
                        ui: { renderers: [] } } } }],
            };
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) throw new Error('Unexpected Machine request');
            requests.push(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload));
            return { ok: true, result: { key: 'source read' } };
        });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const projection = { ...activation.projection, actionsById: { ...activation.projection.actionsById, [`${source.manifest.id}/inspect`]: provider } };
            expect(await dispatchPluginResolvedSemanticCommand({ projection, callerPluginId: CALLER_PLUGIN_ID,
                command: { kind: 'executeAction', action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {} },
                scopedLaunchFacts: { serverId: 'server-client-action', machineId: machineAvailable ? 'provider-machine' : null, interactionEnabled: true },
                accountLifetime, scopeIsCurrent: () => accountLifetime.isCurrent(),
            })).toEqual({ ok: true, result: machineAvailable ? { key: 'source read' } : { code: 'plugin_action_machine_required' } });
            expect(requests).toHaveLength(machineAvailable ? 1 : 0);
            if (machineAvailable) expect(requests[0]).toMatchObject({ machineId: 'provider-machine', qualifiedActionId: `${source.manifest.id}/inspect`,
                expectedContributorOccurrenceId: provider.occurrenceId, executionSurface: 'ui' });
        } finally {
            await activation.composition.unload(); accountLifetime.retire(); clearPluginAccountAvailabilityProjection();
        }
    });

    it.each(['get', 'list', 'configure', 'client', 'origin', 'routing', 'late', 'cleanup-reject'] as const)('observes an ordinary mixed Account Action without executing its handler (%s)', async scenario => {
        const accountLifetime = clientAccountLifetime();
        const demand = new AbortController();
        const observerCancellation = new AbortController();
        const cleanupFailure = new Error('External observer cleanup refused');
        let rejectCleanup: ((error: unknown) => void) | undefined;
        const cleanupBarrier = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
        let handlers = 0;
        let observerCalls = 0;
        let disposed = 0;
        let nestedSignal: AbortSignal | undefined;
        let observedCaller: unknown;
        let nestedObserver: import('@happier-dev/plugin-sdk').Disposable | undefined;
        let publish = () => {};
        let release: ((subscription: import('@happier-dev/plugin-sdk').Disposable) => void) | undefined;
        const target = createClientActionActivation({ pluginId: 'example.ordinary-observed-source',
            accountPlacement: scenario !== 'client', accountLifetime, surfaces: ['plugin'],
            readOnly: { op: 'or', any: [{ op: 'eq', path: 'kind', value: 'get' }, { op: 'eq', path: 'kind', value: 'list' }] },
            inputSchema: { type: 'object', properties: { kind: { enum: ['get', 'list', 'configure'] } }, required: ['kind'], additionalProperties: false },
            ...(scenario === 'client' ? { handler: async () => { handlers++; return null; } }
                : { accountHandler: async () => { handlers++; return null; },
                    observeRead: (_value, invalidate, context) => {
                        observerCalls++; nestedSignal = context.signal; observedCaller = context.caller; publish = invalidate;
                        if (scenario === 'late') return new Promise(resolve => { release = resolve; });
                        return { dispose() { disposed++;
                            if (scenario === 'cleanup-reject') return cleanupBarrier;
                        } };
                    } }),
        });
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            surfaces: ['plugin'], readOnly: true, accountHandler: async () => { handlers++; return null; },
            observeRead: async (_value, invalidate, context) => {
                nestedObserver = await context.services.actions.observe(
                    { pluginId: target.action.pluginId, localId: target.action.id },
                    { kind: scenario === 'list' || scenario === 'configure' ? scenario : 'get' }, invalidate,
                    scenario === 'origin' ? { expectedExecutionOrigin: CLIENT_ACTION_ORIGIN }
                        : scenario === 'routing' ? { expectedExecutionRouting: { serverIdentityId: CLIENT_ACTION_ORIGIN.serverIdentityId,
                            machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, pluginId: target.action.pluginId } }
                        : scenario === 'cleanup-reject' ? { signal: observerCancellation.signal } : undefined,
                );
                return nestedObserver;
            },
        });
        const actions = { ...activation.projection.actionsById, ...target.projection.actionsById };
        const invalidated = vi.fn();
        let observer: import('@happier-dev/plugin-sdk').Disposable | undefined;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation, target.activation]);
            const pending = dispatchPluginSurfaceAction({ action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                invocationSurface: 'plugin', originSurface: 'ui', clientAction: {}, requiredReadOnly: true,
                signal: demand.signal, isCurrent: () => accountLifetime.isCurrent(),
                pluginUiProjection: { ...activation.projection, actionsById: actions },
                resolveContributedAction: identity => actions[`${identity.pluginId}/${identity.localId}`] ?? null,
                readObservation: { invalidate: invalidated, accept(value) { observer = value; } },
            });
            if (scenario === 'late') {
                await vi.waitFor(() => expect(nestedSignal).toBeDefined());
                demand.abort();
                release?.({ async dispose() { disposed++; } });
            }
            const result = await pending;
            expect(handlers).toBe(0);
            if (scenario === 'configure' || scenario === 'client') {
                expect(result).toMatchObject({ ok: false, reason: 'plugin_action_read_only_required' });
                expect(observerCalls).toBe(0);
            } else if (scenario === 'origin' || scenario === 'routing') {
                expect(result).toMatchObject({ ok: false, reason: 'plugin_action_read_observation_unavailable' });
                expect(observerCalls).toBe(0);
            } else if (scenario === 'late') {
                expect(result).toMatchObject({ ok: false });
                expect(observer).toBeUndefined();
                expect(nestedSignal?.aborted).toBe(true);
                expect(disposed).toBe(1);
            } else {
                expect(result).toEqual({ ok: true, result: null });
                expect(observerCalls).toBe(1);
                expect(observedCaller).toMatchObject({ kind: 'plugin', pluginId: CALLER_PLUGIN_ID,
                    contribution: { id: activation.action.id }, occurrenceId: activation.action.occurrenceId });
                publish(); expect(invalidated).toHaveBeenCalledTimes(1);
                if (scenario === 'cleanup-reject') {
                    observerCancellation.abort();
                    expect(nestedSignal?.aborted).toBe(true);
                    expect(disposed).toBe(1);
                    const firstCleanup = nestedObserver?.dispose();
                    expect(firstCleanup).toBeInstanceOf(Promise);
                    expect(nestedObserver?.dispose()).toBe(firstCleanup);
                    const rejected = expect(firstCleanup).rejects.toBe(cleanupFailure);
                    rejectCleanup?.(cleanupFailure);
                    await rejected;
                    // Let AbortSignal's EventTarget rejection handling run before the test ends.
                    await new Promise<void>(resolve => setTimeout(resolve, 0));
                    publish(); expect(invalidated).toHaveBeenCalledTimes(1);
                    return;
                }
                await observer?.dispose();
                expect(nestedSignal?.aborted).toBe(true);
                expect(disposed).toBe(1);
                publish(); expect(invalidated).toHaveBeenCalledTimes(1);
            }
        } finally { demand.abort(); observerCancellation.abort(); release?.({ dispose() { disposed++; } });
            if (scenario === 'cleanup-reject') {
                rejectCleanup?.(cleanupFailure);
                await Promise.resolve(observer?.dispose()).catch(() => {});
            } else await observer?.dispose();
            await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('awaits accepted external observer cleanup when cancellation wins before dispatch settlement', async () => {
        const accountLifetime = clientAccountLifetime();
        const demand = new AbortController();
        const cleanupFailure = new Error('External admission cleanup refused');
        let rejectCleanup: ((error: unknown) => void) | undefined;
        const cleanupBarrier = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
        let disposed = 0;
        let accepted = false;
        let completed = false;
        let handlers = 0;
        let admissionFailure: PluginError | undefined;
        const target = createClientActionActivation({ pluginId: 'example.admission-observed-source',
            accountPlacement: true, accountLifetime, surfaces: ['plugin'], readOnly: true,
            accountHandler: async () => { handlers++; return null; },
            observeRead: () => ({ dispose() { disposed++; return cleanupBarrier; } }),
        });
        await target.composition.unload();
        let outcome: Promise<Readonly<{ kind: 'value' }> | Readonly<{ kind: 'error'; error: unknown }>> | undefined;
        try {
            await target.composition.reconcile([target.activation]);
            outcome = observePluginSurfaceActionRead({ signal: demand.signal, isCurrent: () => accountLifetime.isCurrent(),
                invalidate() {},
                async invoke(observation, signal) {
                    const result = await dispatchPluginSurfaceAction({
                        action: { pluginId: target.action.pluginId, localId: target.action.id }, input: {},
                        invocationSurface: 'plugin', originSurface: 'ui', clientAction: {}, requiredReadOnly: true,
                        signal, pluginUiProjection: target.projection, resolveContributedAction: resolveExactClientAction(target.action),
                        readObservation: { invalidate: observation.invalidate, accept(subscription) {
                            observation.accept(subscription);
                            accepted = true;
                            // Cancellation is allowed after the registered handle was accepted
                            // but before the asynchronous canonical invocation has settled.
                            demand.abort();
                        } },
                    });
                    if (!result.ok) {
                        admissionFailure = new PluginError({ code: result.reason });
                        throw admissionFailure;
                    }
                    return result.result;
                },
            }).then(() => ({ kind: 'value' as const }), error => ({ kind: 'error' as const, error }))
                .finally(() => { completed = true; });
            await vi.waitFor(() => expect(disposed).toBe(1));
            expect(accepted).toBe(true);
            expect(handlers).toBe(0);
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            expect(completed).toBe(false);
            rejectCleanup?.(cleanupFailure);
            const result = await outcome;
            expect(admissionFailure).toBeDefined();
            expect(result).toEqual({ kind: 'error', error: admissionFailure });
            expect(disposed).toBe(1);
        } finally {
            demand.abort(); rejectCleanup?.(cleanupFailure); await outcome;
            await target.composition.unload(); accountLifetime.retire();
        }
    });

    it('uses current invocation facts for a session-conditioned Account Action', async () => {
        const accountLifetime = clientAccountLifetime();
        let effects = 0;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountAvailability: { when: { fact: 'session.exists', operator: 'equals', value: true } },
            handler: async () => { effects += 1; return null; } });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const dispatch = (sessionId?: string) => dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                clientAction: { ...(sessionId ? { sessionId } : {}) }, pluginUiProjection: activation.projection,
                resolveContributedAction: resolveExactClientAction(activation.action),
            });
            expect(await dispatch()).toMatchObject({ ok: false });
            expect(effects).toBe(0);
            expect(await dispatch('session-account')).toEqual({ ok: true, result: null });
            expect(effects).toBe(1);
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('invokes the separately authored public Account plugin without a Machine', async () => {
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({ accountPlacement: true, authoredAccount: true, localId: 'echo',
            accountLifetime, handler: async () => { throw new Error('Author implementation must be used'); } });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            daemonRpc.mockClear();
            const dispatch = (value: PluginUiJsonValueV1) => dispatchPluginSurfaceAction({
                action: { pluginId: authoredAccountManifest.id, localId: 'echo' }, input: value,
                invocationSurface: 'ui', clientAction: {}, pluginUiProjection: activation.projection,
                resolveContributedAction: resolveExactClientAction(activation.action),
            });
            expect(await dispatch({ key: 42 })).toMatchObject({ ok: false, reason: 'plugin_action_input_schema_invalid' });
            expect(await dispatchPluginResolvedSemanticCommand({
                projection: activation.projection, callerPluginId: authoredAccountManifest.id,
                command: { kind: 'executeAction', action: { pluginId: authoredAccountManifest.id, localId: 'echo' }, input: { key: 'public path' } },
                scopedLaunchFacts: { machineId: null, serverId: 'server-client-action', interactionEnabled: true },
                accountLifetime, scopeIsCurrent: () => accountLifetime.isCurrent(),
            })).toEqual({ ok: true, result: { key: 'public path', surface: 'ui' } });
            expect(daemonRpc).not.toHaveBeenCalled();
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['decline', 'disable', 'release-retired'] as const)('refuses Account effects after %s at the ordinary approval gate', async (decision) => {
        const storage = getStorage();
        const previous = storage.getState();
        const accountLifetime = clientAccountLifetime();
        let effects = 0;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime, dangerLevel: 'writesRemote',
            handler: async () => { effects += 1; return { applied: true }; } });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const result = await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                invocationSurface: 'ui', clientAction: {}, pluginUiProjection: activation.projection,
                resolveContributedAction: resolveExactClientAction(activation.action),
                requestCurrentIntent: async ({ fingerprint }) => {
                    if (decision === 'decline') return { status: 'unavailable', code: 'plugin_action_current_intent_rejected' };
                    if (decision === 'disable') storage.setState(state => ({ ...state, settings: { ...state.settings,
                        actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                            [`${CALLER_PLUGIN_ID}/actions/${activation.action.id}`]: { enabled: false },
                        } }),
                    } }));
                    else await activation.composition.unload();
                    return { status: 'approved', fingerprint };
                },
            });
            expect(result).toMatchObject({ ok: false });
            expect(effects).toBe(0);
        } finally { storage.setState(previous); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['ui', 'agent', 'mcp', 'cli'] as const)('validates and preserves an uncertain result without a Machine on %s', async (surface) => {
        let effects = 0;
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({
            accountPlacement: true, accountLifetime, surfaces: ['ui', 'agent', 'mcp', 'cli'],
            inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
            handler: async (value, context) => {
                expect(context).toHaveProperty('surface', surface);
                expect(context).toHaveProperty('services.storage.account');
                expect(context).not.toHaveProperty('services.fs');
                effects += 1;
                return { kind: 'uncertain', value };
            },
        });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            daemonRpc.mockClear();
            const dispatch = (value: PluginUiJsonValueV1) => dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: value,
                invocationSurface: surface, clientAction: {}, pluginUiProjection: activation.projection,
                resolveContributedAction: resolveExactClientAction(activation.action),
            });
            expect(await dispatch({ value: 1 })).toMatchObject({ ok: false });
            expect(effects).toBe(0);
            expect(await dispatch({ value: 'one write' })).toEqual({ ok: true, result: { kind: 'uncertain', value: { value: 'one write' } } });
            expect(effects).toBe(1);
            expect(daemonRpc).not.toHaveBeenCalled();
            accountLifetime.retire();
            expect(await dispatch({ value: 'retired' })).toMatchObject({ ok: false });
            expect(effects).toBe(1);
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });
});

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

describe('native image references delivered by Actions', () => {
    it.each(['raw Session events', 'contributed result'] as const)(
        'delivers a native image from a successful %s without making Action delivery read authority',
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
                payload: { image: media } };
            const readInputs: unknown[] = [];
            const owner = createPluginSurfaceStoredImageOwner({ pluginId: CALLER_PLUGIN_ID, occurrenceId: 'occ-1',
                machineId: 'machine-1', serverId: null, isCurrent: () => true, lifetimeSignal: new AbortController().signal,
                // The daemon read transport is the boundary; real Action result admission stays intact.
                read: async (_machineId, input) => { readInputs.push(input); return { ok: true, image }; } });
            let succeeds = false;
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
                mountedHostApiHandlers: { readStoredImage: owner.readStoredImage },
            });
            const action = source === 'raw Session events' ? 'session.events.get' : { pluginId: 'acme.media', localId: 'read' };
            const actionRequest = executeActionRequest({ action, input: { sessionId: 'session-1', includeRaw: true } });
            try {
                expect(await api.handleRequest(readRequest)).toEqual(image);
                expect(await api.handleRequest(actionRequest)).toMatchObject({ code: 'unavailable' });
                expect(await api.handleRequest(readRequest)).toEqual(image);
                succeeds = true;
                expect(await api.handleRequest(actionRequest)).toEqual(result);
                expect(await api.handleRequest(readRequest)).toEqual(image);
                expect(readInputs).toEqual(Array.from({ length: 3 }, () =>
                    ({ callerPluginId: CALLER_PLUGIN_ID, expectedCallerOccurrenceId: 'occ-1', media })));
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
        isApprovalExecutionOriginCurrent: async ({ origin, reportStale }) => {
            const current = origin.caller.kind === 'plugin'
                && origin.caller.pluginId === CALLER_PLUGIN_ID
                && pluginSourceCustodyV1Equal(origin.caller.sourceCustody, currentCustody);
            if (!current) reportStale?.('origin_version');
            return current;
        },
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
    it('admits a bounded mounted Plugin continuation without inheriting present-user authority', async () => {
        const admitted: unknown[] = [];
        // Only the daemon network boundary is substituted. Protected mounted
        // dispatch, Action admission and the canonical Account transport stay real.
        const relay = createUiAccountActionTransport({ account: { serverId: 'home-plugin', accountId: 'account-plugin', assertCurrent() {} },
            resolveFallbackMachineId: () => 'machine-plugin', transport: async request => {
                admitted.push(request.invocation);
                return { attemptedChannels: 1, deliveredChannels: 1 };
            } });
        const deps = { notificationsNotifyMe: async (input, context) => {
            const result = await relay({ actionId: 'notifications.notify_me', input, context });
            const refusal = ActionExecuteFailureSchema.safeParse(result);
            return refusal.success ? refusal.data : NotificationsNotifyMeResultV1Schema.parse(result);
        } } satisfies Partial<ActionExecutorDeps>;
        // The fixture supplies only its genuine daemon port; unrelated Agent ports are not exercised.
        const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
        const api = createPluginSurfaceActionHostApi({ surfaceContext: surfaceContext(), callerBinding: mountedCallerBinding(),
            hostAction: { execute: executor.execute, context: { serverId: 'home-plugin', runtimeAccountId: 'account-plugin',
                authority: 'present_user', callerPermissionMode: 'read-only',
                callerInputConstraints: { models: null, permissionModes: ['read-only'] }, agentStartWorkspaceWrites: 'deny' } } });
        try {
            expect(await api.handleRequest(executeActionRequest({ action: 'notifications.notify_me', input: { message: 'Review' } })))
                .toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
            expect(admitted).toEqual([{ caller: { kind: 'plugin', pluginId: CALLER_PLUGIN_ID, contributionLocalId: 'inspector-app',
                occurrenceId: `${CALLER_PLUGIN_ID}:current`, materialization: CALLER_MATERIALIZATION }, surface: 'plugin',
                authority: 'account_automation', callerPermissionMode: 'read-only',
                callerInputConstraints: { models: null, permissionModes: ['read-only'] }, workspaceWrites: 'deny' }]);
        } finally { api.dispose?.(); }
    });
    it.each(['Ask-first', 'default', 'waived'] as const)(
        'evaluates a nested host Action independently of its admitted parent: %s',
        async (policy) => {
            const settings = normalizeActionsSettingsV1({
                v: 1,
                ...(policy === 'Ask-first' ? { actions: { 'teams.members.remove': { approvalRequiredSurfaces: ['plugin'] } } } : {}),
                ...(policy === 'waived' ? { approvalWaivedSurfaces: { 'teams.members.remove': ['plugin'] } } : {}),
            });
            const effects: unknown[] = [];
            const approvals: ApprovalRequest[] = [];
            const deps = {
                isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
                // Home transport and Artifact persistence are the system boundaries.
                homeDomainAction: async (request) => { effects.push(request); return { status: 'removed', membershipId: 'member-1' }; },
                approvalsCreate: async ({ request }) => { approvals.push(ApprovalRequestV2Schema.parse(request)); return { artifactId: 'child-approval' }; },
            } satisfies Partial<ActionExecutorDeps>;
            const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
            const activation = createClientActionActivation({
                surfaces: ['mcp'],
                handler: async (_input, context) => await context.ui.executeAction('teams.members.remove', {
                    v: 1, teamId: 'team-1', membershipId: 'member-1',
                }),
            });
            await activation.composition.unload();
            try {
                await activation.composition.reconcile([activation.activation]);
                const result = await dispatchPluginSurfaceAction({
                    action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, invocationSurface: 'mcp',
                    resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
                    hostAction: { execute: executor.execute, context: {
                        serverId: 'home-1', runtimeAccountId: 'account-1', actionRequestId: 'parent-request',
                        executionRunTargetMachineId: 'machine-1', authority: 'account_automation', bypassApprovals: true,
                    } },
                });
                if (policy === 'waived') {
                    expect(result).toMatchObject({ ok: true, result: { status: 'removed', membershipId: 'member-1' } });
                    expect(effects).toHaveLength(1);
                    expect(approvals).toEqual([]);
                } else {
                    expect(effects).toEqual([]);
                    // A bare client registration has no durable source custody.
                    // Ordinary approval must refuse it, never borrow the parent's bypass.
                    expect(result).toMatchObject({ ok: false, reason: 'approval_origin_unavailable' });
                    expect(approvals).toEqual([]);
                    const admittedChild = await dispatchPluginSurfaceAction({
                        callerPluginId: CALLER_PLUGIN_ID,
                        callerSourceCustody: TARGET_SOURCE_CUSTODY,
                        action: 'teams.members.remove',
                        input: { v: 1, teamId: 'team-1', membershipId: 'member-1' },
                        invocation: { kind: 'clientPluginAction', clientActionBinding: {
                            pluginId: CALLER_PLUGIN_ID, contributionLocalId: activation.action.id,
                            occurrenceId: activation.action.occurrenceId!,
                        } },
                        hostAction: { execute: executor.execute, context: {
                            serverId: 'home-1', runtimeAccountId: 'account-1', actionRequestId: 'child-request',
                            executionRunTargetMachineId: 'machine-1', authority: 'account_automation', bypassApprovals: true,
                        } },
                    });
                    expect(admittedChild).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'child-approval' } });
                    expect(effects).toEqual([]);
                    expect(approvals).toMatchObject([{ actionId: 'teams.members.remove', executionOriginV1: {
                        authority: 'account_automation', surface: 'plugin', caller: { kind: 'plugin', pluginId: CALLER_PLUGIN_ID },
                    } }]);
                }
            } finally { await activation.composition.unload(); }
        },
    );
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
        daemonRpc.mockImplementation(async (request: Readonly<{ method: string; payload?: unknown; onIssued?: () => void }>) => {
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) return answerActionSchemasRead(request);
            requests.push(request.payload);
            throw new Error('acknowledgement lost after the nested mutation was emitted');
        });
        const authorErrors: unknown[] = [];
        const activation = createClientActionActivation({
            surfaces: ['agent'], handler: async (_input, context) => {
                try { return await context.ui.executeAction(nestedIdentity, {}); }
                catch (error) { authorErrors.push(error); throw error; }
            },
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
            expect(await pending).toMatchObject({ ok: false, code: 'timeout', reason: 'plugin_ui_action_outcome_unknown' });
            expect(authorErrors).toEqual([expect.objectContaining({ code: 'plugin_action_outcome_unknown' })]);
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
        daemonRpc.mockImplementation(async (request: Readonly<{ method: string }>) => (
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
            expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({
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
        daemonRpc.mockImplementation(async (request: Readonly<{ method: string }>) => (
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
        daemonRpc.mockImplementation(async (request: Readonly<{ method: string }>) => {
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
        daemonRpc.mockImplementation(async (request: Readonly<{ method: string }>) => (
            request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ
                ? { status: 'current', targetedContributions: PluginUiTargetedContributionsV1Schema.parse({
                    target: { pluginId: activation.action.pluginId, occurrenceId: activation.action.occurrenceId,
                        sourceCustody: TARGET_SOURCE_CUSTODY }, points: [],
                }), targetedSurfaceMounts: [] }
                : answerActionSchemasRead(request)
        ));
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
            executionOrigin: activation.activation.executionOrigin,
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
            expect(outcome).toMatchObject({ ok: true });
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
            expect((await readContributedActionWire(machineId, options)).invocation).toEqual({
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
        const rpcCallsBefore = network.requests.length;
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
            const schemaReads = network.requests
                .slice(rpcCallsBefore)
                .filter((request) => request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ);
            // One read per Action occurrence, from the Action's own authority.
            expect(schemaReads).toEqual([expect.objectContaining({
                targetId: CLIENT_ACTION_HOST_ORIGIN.machineId,
                serverUrl: rpcHomes.get(CLIENT_ACTION_HOST_ORIGIN.serverId)!.serverUrl,
                token: rpcHomes.get(CLIENT_ACTION_HOST_ORIGIN.serverId)!.token,
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

    it.each([
        { accountPlacement: false, readOnly: false },
        { accountPlacement: true, readOnly: false },
        { accountPlacement: true, readOnly: true },
    ])('projects post-handler cancellation according to declared effect ($accountPlacement, readOnly=$readOnly)', async ({ accountPlacement, readOnly }) => {
        const cancellation = new AbortController();
        let handlerEntered!: () => void;
        const handlerEnteredPromise = new Promise<void>((resolve) => { handlerEntered = resolve; });
        const handler = vi.fn(() => {
            handlerEntered();
            return new Promise<never>(() => {});
        });
        const clientHandler: PluginClientActionHandler = () => handler();
        const accountLifetime = accountPlacement ? clientAccountLifetime() : undefined;
        const activation = createClientActionActivation({ handler: clientHandler, accountPlacement, accountLifetime, readOnly });
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
                layer: 'transport',
                phase: 'settlement',
                retryable: readOnly,
            });
            expect(handler).toHaveBeenCalledOnce();
        } finally {
            await activation.composition.unload();
            accountLifetime?.retire();
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
        const executor = createActionExecutor(createActionExecutorBoundaryFixture(deps));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            callerBinding: mountedCallerBinding(),
            callerSourceCustody: { kind: 'development', registeredRootId: 'inspector-root' },
            hostAction: {
                execute: executor.execute,
                context: { serverId: 'home-1', runtimeAccountId: 'account-1', actionRequestId: 'stale-mount-request',
                    defaultSessionMachineId: 'machine-1' },
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
        expect(result.decision).toMatchObject({ ok: false, effectAttempted: false,
            errorCode: 'approval_stale', details: { reason: 'origin_version' },
        });
        expect(result.effects).toEqual([]);
        expect(result.stored()).toMatchObject({
            status: 'approved',
            executionOriginV1: { caller: { sourceCustody: TARGET_SOURCE_CUSTODY } },
        });
        expect(result.stored()?.execution).toBeUndefined();
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
            authority: 'account_automation',
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
            authority: 'account_automation',
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
            isCurrent: expect.any(Function),
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
            isCurrent: expect.any(Function),
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
            isCurrent: expect.any(Function),
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
        expect(await readContributedActionWire(machineId, request)).toEqual({
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
        daemonRpc.mockReset();
        daemonRpc
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

        expect(daemonRpc).toHaveBeenNthCalledWith(1, expect.objectContaining({
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
        expect(daemonRpc).toHaveBeenNthCalledWith(2, expect.objectContaining({
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
        expect(daemonRpc).toHaveBeenNthCalledWith(3, expect.objectContaining({
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
        const unmountedRequest = daemonRpc.mock.calls[2]?.[0] as
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

    it('keeps a pre-handler daemon retirement pending on a refreshed projection', async () => {
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
            code: 'stale_surface',
            reason: 'plugin_action_generation_retired',
            message: resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: 'plugin_action_generation_retired' }).body,
        });
    });

    it('refreshes a stale occurrence refused by the Action schema read before dispatch', async () => {
        const scope = { serverId: 'schema-home', machineId: 'schema-machine' };
        const before = getMachineContributionRegistryProjectionRevision(scope);
        daemonRpc.mockResolvedValueOnce({ ok: false, code: 'plugin_occurrence_stale' });
        const result = await dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input: {},
            contributedAction: scope,
            resolveContributedAction: identity => ({ ...resolveDaemonTargetAction(identity), confirmationWhen: { presentUserUi: false } }),
        });
        expect(result).toMatchObject({ ok: false, code: 'stale_surface', reason: 'plugin_occurrence_stale' });
        expect(getMachineContributionRegistryProjectionRevision(scope)).toBeGreaterThan(before);
    });

    it.each([
        { readOnly: undefined, input: {}, retryable: false },
        { readOnly: true, input: {}, retryable: true },
        { readOnly: { op: 'eq', path: 'kind', value: 'get' }, input: { kind: 'get' }, retryable: true },
        { readOnly: { op: 'eq', path: 'kind', value: 'get' }, input: { kind: 'set' }, retryable: false },
    ] satisfies readonly { readOnly: PluginProjectedActionV2['readOnly']; input: PluginUiJsonValueV1; retryable: boolean }[])(
        'projects unknown daemon settlement using declared read effect ($retryable, $input)', async ({ readOnly, input, retryable }) => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: false as const, code: 'plugin_action_outcome_unknown' },
        }));

        await expect(dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID,
            action: 'refresh-index',
            input,
            invocationSurface: 'voice',
            resolveContributedAction: identity => ({ ...resolveDaemonTargetAction(identity), readOnly }),
            contributedAction: {
                machineId: 'machine-1',
                execute: contributed,
            },
        })).resolves.toEqual({
            ok: false,
            code: 'timeout',
            reason: 'plugin_ui_action_outcome_unknown',
            layer: 'transport',
            phase: 'settlement',
            retryable,
        });
        expect(contributed).toHaveBeenCalledOnce();
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
    it('uses the selected Home credential for authored UI confirmation rather than the focused Home', async () => {
        const previousAuth = getCurrentAuth();
        const terminalToken = `header.${Buffer.from(JSON.stringify({ sub: 'terminal-account', tokenEpoch: 0,
            provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' }),
        })).toString('base64url')}.signature`;
        const targetHome = await network.addHome('https://plugin-target.example.test', 'terminal-account', { credentials: { token: terminalToken } });
        const focusedHome = await network.addHome('https://plugin-focused.example.test', 'focused-account', {
            credentials: { token: createAccountTokenForTests('focused-account', { currentAccount: true }) },
        });
        await setActiveServer({ serverId: focusedHome.id });
        const focusedCredentials = await TokenStorage.getCredentialsForServerUrl(focusedHome.serverUrl, { serverId: focusedHome.id });
        if (!focusedCredentials) throw new Error('Focused Home credential missing');
        setCurrentAuth({ isAuthenticated: true, credentials: focusedCredentials,
            credentialAuthorityKind: readCredentialAuthorityKind(focusedCredentials.token),
            login: async () => { throw new Error('Unused auth boundary'); },
            loginWithCredentials: async () => { throw new Error('Unused auth boundary'); },
            logout: async () => { throw new Error('Unused auth boundary'); }, refreshFromActiveServer: async () => {},
        });
        const requestCurrentIntent = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => ({ status: 'approved' as const, fingerprint }));
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true, result: { ok: true, result: { completed: true } },
        }));
        clientActionSchemasByQualifiedId.set('qa.collection-detail/set-complete', { inputSchema: { type: 'object' } });
        try {
            expect(await dispatchPluginSurfaceAction({
                action: { pluginId: 'qa.collection-detail', localId: 'set-complete' }, input: { completed: true },
                resolveContributedAction: identity => PluginProjectedActionV2Schema.parse({
                    ...resolveConfirmedDaemonTargetAction(identity), dangerLevel: 'writesLocal',
                    confirmationWhen: { presentUserUi: false },
                }), requestCurrentIntent,
                contributedAction: { machineId: 'machine-1', serverId: targetHome.id, execute: contributed },
            })).toMatchObject({ ok: true });
            expect(requestCurrentIntent).toHaveBeenCalledOnce();
            expect(contributed.mock.calls[0]?.[1].presentUserIntent).toBe('confirmed');
            expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)).toEqual([
                expect.objectContaining({ serverUrl: targetHome.serverUrl, token: terminalToken, targetId: 'machine-1' }),
            ]);
        } finally { setCurrentAuth(previousAuth); }
    });

    it.each([
        { ask: false, authority: 'present_user', confirms: false },
        { ask: true, authority: 'present_user', confirms: true },
        { ask: false, authority: 'account_automation', confirms: true },
    ] as const)('honors authored UI confirmation with $authority and explicit Ask=$ask', async ({ ask, authority, confirms }) => {
        const storage = getStorage();
        const previous = storage.getState();
        const qualifiedId = 'qa.collection-detail/actions/set-complete';
        storage.setState(state => ({ ...state, settings: { ...state.settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: ask ? { [qualifiedId]: { approvalRequiredSurfaces: ['ui'] } } : {},
            }),
        } }));
        const requestCurrentIntent = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => ({
            status: 'approved' as const, fingerprint,
        }));
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true, result: { ok: true, result: { completed: true } },
        }));
        try {
            const { createCollectionDetailPlugin } = await import('../../../../../../packages/plugin-sdk/fixtures/qa-plugin-authoring/qa-collection-detail/index');
            const declaration = createCollectionDetailPlugin().manifest.contributes?.actions?.find(action => action.id === 'set-complete');
            if (!declaration) throw new Error('Collection completion declaration missing');
            if (declaration.inputSchema) clientActionSchemasByQualifiedId.set('qa.collection-detail/set-complete', { inputSchema: declaration.inputSchema });
            expect(await dispatchPluginSurfaceAction({
                action: { pluginId: 'qa.collection-detail', localId: 'set-complete' },
                input: { rowId: 'release-guide', completed: true },
                hostAction: { execute: vi.fn(), context: { authority } },
                resolveContributedAction: identity => PluginProjectedActionV2Schema.parse({
                    ...resolveConfirmedDaemonTargetAction(identity),
                    dangerLevel: declaration.dangerLevel,
                    confirmation: declaration.confirmation,
                    confirmationWhen: declaration.confirmationWhen,
                }),
                requestCurrentIntent, contributedAction: { machineId: 'machine-1', execute: contributed },
            })).toEqual({ ok: true, result: { completed: true } });
            expect(requestCurrentIntent).toHaveBeenCalledTimes(confirms ? 1 : 0);
            expect(contributed.mock.calls[0]?.[1]).toMatchObject({ executionSurface: 'ui' });
            expect(contributed.mock.calls[0]?.[1].presentUserIntent).toBe(confirms ? 'confirmed' : undefined);
        } finally { storage.setState(previous); }
    });

    it.each([false, true])('uses a declared read default while respecting explicit Ask-first=%s', async required => {
        const storage = getStorage();
        const previous = storage.getState();
        const qualifiedId = 'acme.bindings/actions/manage';
        storage.setState(state => ({ ...state, settings: { ...state.settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: required ? { [qualifiedId]: { approvalRequiredSurfaces: ['ui'] } } : {},
            }),
        } }));
        clientActionSchemasByQualifiedId.set('acme.bindings/manage', { inputSchema: {
            type: 'object', properties: { kind: { type: 'string', enum: ['list', 'attach'] } },
            required: ['kind'], additionalProperties: false,
        } });
        const requestCurrentIntent = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => ({
            status: 'approved' as const, fingerprint,
        }));
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true, result: { ok: true, result: { bindings: [] } },
        }));
        try {
            const dispatch = (input: PluginUiJsonValueV1) => dispatchPluginSurfaceAction({
                action: { pluginId: 'acme.bindings', localId: 'manage' }, input,
                resolveContributedAction: identity => PluginProjectedActionV2Schema.parse({
                    ...resolveConfirmedDaemonTargetAction(identity),
                    confirmationWhen: { op: 'not', predicate: { op: 'eq', path: 'kind', value: 'list' } },
                }),
                requestCurrentIntent, contributedAction: { machineId: 'machine-1', execute: contributed },
            });
            expect(await dispatch({ kind: 'list' })).toEqual({ ok: true, result: { bindings: [] } });
            expect(requestCurrentIntent).toHaveBeenCalledTimes(required ? 1 : 0);
            expect(contributed.mock.calls[0]?.[1].presentUserIntent).toBe(required ? 'confirmed' : undefined);
            expect(await dispatch({ kind: 'list', extra: 'invalid' })).toMatchObject({ ok: false, reason: 'plugin_action_input_schema_invalid' });
            expect(contributed).toHaveBeenCalledTimes(1);
            expect(await dispatch({ kind: 'attach' })).toEqual({ ok: true, result: { bindings: [] } });
            expect(contributed.mock.calls[1]?.[1].presentUserIntent).toBe('confirmed');
        } finally { storage.setState(previous); }
    });

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
            authority: 'account_automation',
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

        await expect(Promise.resolve(api.handleRequest(
            executeActionRequest({ action: 'refresh-index', input: {} }),
            { signal: cancellation.signal },
        ))).resolves.toEqual({
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
    | Readonly<{ settled: 'rejected'; code: string; message?: string; diagnostics: readonly string[] }>;

async function settleComposed(pending: Promise<unknown>): Promise<ComposedSettlement> {
    return pending.then(
        (result): ComposedSettlement => ({ settled: 'fulfilled', result }),
        (error: unknown): ComposedSettlement => {
            const data = error as Readonly<{
                code?: unknown;
                message?: string;
                diagnostics?: readonly Readonly<{ code?: unknown }>[];
            }>;
            return {
                settled: 'rejected',
                code: typeof data.code === 'string' ? data.code : 'unknown',
                message: data.message,
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
            authority: 'account_automation',
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
            isCurrent: expect.any(Function),
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
            isCurrent: expect.any(Function),
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
            isCurrent: expect.any(Function),
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
        const scope = { serverId: 'server-composed', machineId: 'machine-composed' };
        const before = getMachineContributionRegistryProjectionRevision(scope);
        contributedActionExecute.mockClear();
        contributedActionExecute.mockResolvedValueOnce({
            supported: true as const,
            result: { ok: false as const, code: 'plugin_action_surface_unavailable', message: 'Reconnect the integration account before continuing.' },
        });

        const settlement = await settleComposed(client.executeAction('refresh-index', {}));

        expect(settlement.settled).toBe('rejected');
        expect(settlement.settled === 'rejected' ? settlement.diagnostics : [])
            .toContain('plugin_action_surface_unavailable');
        expect(settlement).toMatchObject({ message: 'Reconnect the integration account before continuing.' });
        expect(getMachineContributionRegistryProjectionRevision(scope)).toBe(before);
        await expect(client.executeAction('refresh-index', {})).resolves.toEqual({ refreshed: true });
    });

    it.each(['plugin_generation_stale', 'plugin_occurrence_stale'])('refreshes the superseded projection for %s without exposing daemon diagnostics', async (code) => {
        const scope = { serverId: 'server-composed', machineId: 'machine-composed' };
        const before = getMachineContributionRegistryProjectionRevision(scope);
        contributedActionExecute.mockResolvedValueOnce({
            supported: true as const,
            result: { ok: false as const, code, message: 'Plugin occurrenceId is stale' },
        });
        const settlement = await settleComposed(client.executeAction('refresh-index', {}));
        expect(settlement).toMatchObject({
            settled: 'rejected', code: 'stale_surface',
            message: resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: code }).body,
        });
        expect(settlement.settled === 'rejected' ? settlement.diagnostics : []).toContain(code);
        expect(getMachineContributionRegistryProjectionRevision(scope)).toBeGreaterThan(before);
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
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface,
            requestIdPrefix: 'rn-dispatch',
            handleRequest: (request, options) => {
                requests.push(request);
                return hostApi.handleRequest(request, options);
            },
            installedMethods: hostApi.installedMethods,
        });
        return { ...adapter, requests };
    }

    it('carries both branches from the React Native public API with the host stamps intact', async () => {
        const executeHostAction = vi.fn<PluginSurfaceHostActionExecute>(async () => ({ ok: true as const, result: { reloaded: true } }));
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
            actionRequestId: adapter.requests[0]?.requestId,
            serverId: 'server-rn',
            surface: 'plugin',
            authority: 'account_automation',
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

        await expect(adapter.api.executeAction(HOST_ACTION_ID, { pluginId: CALLER_PLUGIN_ID }))
            .resolves.toEqual({ reloaded: true });
        expect(adapter.requests[0]?.requestId).toBeTruthy();
        expect(adapter.requests[1]?.requestId).toBeTruthy();
        expect(adapter.requests[1]?.requestId).not.toBe(adapter.requests[0]?.requestId);
        expect(executeHostAction.mock.calls[1]?.[2]?.actionRequestId).toBe(adapter.requests[1]?.requestId);

        await expect(adapter.api.executeAction('refresh-index', { reason: 'rn' }))
            .resolves.toEqual({ refreshed: true });
        expect(contributedActionExecute).toHaveBeenCalledWith('machine-rn', {
            serverId: 'server-rn',
            isCurrent: expect.any(Function),
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
                result: { ok: false as const, code: 'plugin_action_surface_unavailable', message: 'Reconnect the integration account before continuing.' },
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
            message: 'Reconnect the integration account before continuing.',
            diagnostics: [{ code: 'plugin_action_surface_unavailable', severity: 'error' }],
        });
    });
});

/** Reuse the real physical carrier owners; only the browser realm hop is synthetic. */
async function externalDocCarrier(transport: 'hosted-web' | 'react-native',
    host: ReturnType<typeof createPluginSurfaceActionHostApi>, isCurrent: () => boolean, mode: 'plain' | 'e2ee') {
    const pluginId = externalAuthoringPlugin.manifest.id;
    const requestSurface = { ...COMPOSED_SURFACE, pluginId, contributionId: 'external-authoring-semantic' };
    const surface = createPluginSurfaceContextFixture({ accountEncryptionMode: mode, target: { kind: 'app' },
        mount: { kind: 'destination', destination: { pluginId, localId: requestSurface.contributionId }, container: 'appPage' },
        targetedContributions: { target: { pluginId, occurrenceId: 'external-doc-occurrence', sourceCustody: TARGET_SOURCE_CUSTODY }, points: [] } });
    if (transport === 'react-native') {
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface, requestSurface,
            requestIdPrefix: 'external-doc-rn', handleRequest: host.handleRequest,
            installedMethods: host.installedMethods, isCurrent });
        return { api: adapter.api, retire: () => { adapter.dispose(); }, dispose: () => { adapter.dispose(); } };
    }
    const previousWindow = Reflect.get(globalThis, 'window');
    const listeners = new Set<(event: unknown) => void>();
    let bridge: ReturnType<typeof createPluginHostedWebHostApiBridgeHandler>;
    const deliver = (data: unknown) => queueMicrotask(() => {
        for (const listener of listeners) listener({ data, origin: COMPOSED_HOST_ORIGIN, source: parent });
    });
    const parent = { postMessage(message: unknown, origin: string) {
        if (origin !== COMPOSED_HOST_ORIGIN) return;
        const envelope = PluginHostedWebBridgeEnvelopeV1Schema.parse(message);
        void Promise.resolve(bridge(envelope)).then(deliver);
    } };
    bridge = createPluginHostedWebHostApiBridgeHandler({ surface: requestSurface, identity: COMPOSED_IDENTITY,
        requestIdPrefix: 'external-doc-hosted', handleRequest: host.handleRequest, isCurrent,
        canonicalHostApi: { identity: COMPOSED_IDENTITY, surface: PluginUiJsonValueV1Schema.parse(surface),
            methods: host.installedMethods }, postToFrame: deliver,
        bootstrap: { frameOrigin: new URL(composedRealmHref()).origin } });
    // A real frame has its own realm. The SDK retains its bootstrap on that realm,
    // so reusing globalThis here would acquire another test frame's retired client.
    Reflect.set(globalThis, 'window', { parent, location: { href: composedRealmHref() },
        addEventListener: (_kind: string, listener: (event: unknown) => void) => { listeners.add(listener); },
        removeEventListener: (_kind: string, listener: (event: unknown) => void) => { listeners.delete(listener); } });
    const api = await createPluginUiHostApiClient();
    return { api, retire: () => { bridge.dispose(); }, dispose: async () => {
        bridge.dispose();
        await new Promise<void>(resolve => queueMicrotask(resolve));
        if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
        else Reflect.set(globalThis, 'window', previousWindow);
    } };
}

describe('external author Doc collaboration through physical SDK carriers', () => {
    it.each([['hosted-web', 'plain'], ['react-native', 'e2ee']] as const)(
        'reads, comments and proposes through %s with %s content without acquiring person authority', async (transport, mode) => {
        const homes = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(homes);
        await homes.reset();
        const serverId = await homes.addHome({ name: 'External Doc review', serverUrl: `https://external-doc-${transport}.test`,
            accountId: 'alice', currentAccount: true, accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }),
                secret: Buffer.from(new Uint8Array(32).fill(24)).toString('base64url') } } : {}) });
        const network = answerDiscussionThreadForTests(homes, serverId, { mode, loseCreate: false, loseFirstRejoin: false });
        // Only the Home HTTP decision boundary is substituted. Proposal lookup,
        // acceptance preparation, encryption and Action policy remain real.
        for (const decision of ['accept', 'decline'] as const) {
            homes.answer(serverId, `POST ${DOC_EDIT_PROPOSAL_HTTP_PATHS_V1[decision]}`, { select: input => {
                const accepting = decision === 'accept' ? DocEditAcceptTransportInputV1Schema.parse(input) : null;
                const request = accepting ?? DocEditDeclineTransportInputV1Schema.parse(input);
                const message = network.messages.find(row => row.id === request.proposalRef.messageId
                    && row.discussionId === request.proposalRef.discussion.discussionId);
                if (!message?.docEditProposalDispositionV1) return { status: 404, body: { error: 'not_found' } };
                if (message.docEditProposalDispositionV1.state === 'open') {
                    const decidedBy = { accountId: 'alice', atMs: 20 };
                    if (accepting) {
                        expect(accepting.preparation).toBeDefined();
                        const preparation = accepting.preparation!;
                        const store = homes.artifacts(serverId);
                        const artifact = store.read(preparation.doc.ref.artifactId)!;
                        expect(preparation.doc.revision).toEqual({ headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion });
                        // updateArtifactTx clears old revision provenance when
                        // a body write supplies no replacement attribution.
                        store.replaceStoredRow({ ...artifact, body: preparation.body, bodyVersion: artifact.bodyVersion! + 1,
                            provenance: null, seq: artifact.seq + 1, updatedAt: artifact.updatedAt + 1 });
                        message.docEditProposalDispositionV1 = { state: 'accepted', decidedBy,
                            acceptedRevision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion! + 1 } };
                    } else message.docEditProposalDispositionV1 = { state: 'declined', decidedBy };
                }
                return { body: DocEditDecisionResultV1Schema.parse({ proposalRef: request.proposalRef,
                    docEditProposalDispositionV1: message.docEditProposalDispositionV1 }) };
            } });
        }
        const [{ captureLazyActionAccountContext }, { createUiArtifactAction }, { executeDiscussionActionInAccountContext },
            { createFrontDoorActionExecute }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/actions/artifactActionDeps'),
            import('@/sync/api/discussions/discussionActions'), import('@/sync/ops/actions/frontDoorRuntimeActionExecutor'),
        ]);
        const account = await captureLazyActionAccountContext(serverId);
        const source = 'Keep this. Review this passage. Keep that.';
        const created = await account.createArtifactDocument({ header: { kind: 'artifact.legacy', title: 'Author review' }, body: source });
        const ref = { kind: 'doc' as const, serverId, artifactId: created.artifactId };
        let enabled = true;
        const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
            'doc.comment.reply': ['plugin'], 'doc.edit.propose': ['plugin'], 'doc.edit.accept': ['plugin'], 'doc.edit.decline': ['plugin'],
        } });
        const executor = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
            isActionEnabled: () => enabled,
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, actionsSettings, context),
            artifactAction: createUiArtifactAction(account),
            discussionAction: args => executeDiscussionActionInAccountContext(account, 'available', args),
        })));
        const lifetime = new AbortController();
        let current = true;
        const pluginId = externalAuthoringPlugin.manifest.id;
        const host = createPluginSurfaceActionHostApi({ surfaceContext: { ...COMPOSED_SURFACE, pluginId, contributionId: 'external-authoring-semantic' },
            callerBinding: mountedCallerBinding({ pluginId, contributionLocalId: 'external-authoring-semantic', occurrenceId: 'external-doc-occurrence' }),
            callerSourceCustody: TARGET_SOURCE_CUSTODY, resourceLifetimeSignal: lifetime.signal, isCurrent: () => current,
            hostAction: { execute: executor, context: { serverId, runtimeAccountId: 'alice', actionsSettings,
                // A mounted plugin must not inherit this host's present person or bypass.
                authority: 'present_user', bypassApprovals: true } } });
        const carrier = await externalDocCarrier(transport, host, () => current, mode);
        try {
            const read = DocCollaborationActionOutputSchemasV1['doc.read'].parse(await readExternalDoc(carrier.api, { ref }));
            expect(read.artifact.body).toBe(source);
            expect(read.artifact.revision).toEqual(created.revision);
            const target = captureDocPassageV1({ ref: read.ref, revision: read.artifact.revision, source,
                range: { start: 11, end: 30 } });
            const comment = DocCollaborationActionOutputSchemasV1['doc.comment.reply'].parse(await commentOnExternalDoc(carrier.api, {
                target, localId: 'external-comment', content: { v: 1, parts: [{ t: 'text', text: 'Please clarify this passage.' }] },
            }));
            const proposalInput = { target, discussionRef: comment.message.messageRef.discussion,
                replyTo: comment.message.messageRef, localId: 'external-proposal', baseRevision: target.revision,
                before: target.quote, after: 'Reviewed replacement.', reason: 'Explain the point directly.' };
            const proposal = DocCollaborationActionOutputSchemasV1['doc.edit.propose'].parse(await proposeExternalDocEdit(carrier.api, proposalInput));
            expect(proposal.message.content).toMatchObject({ kind: 'doc_edit_proposal', proposal: { before: target.quote,
                after: proposalInput.after, target } });
            expect(proposal.message.docEditProposalDispositionV1).toEqual({ state: 'open' });
            expect(await proposeExternalDocEdit(carrier.api, proposalInput)).toEqual(proposal);
            const reopened = DiscussionReadResultV1Schema.parse(await carrier.api.executeAction('discussion.read', {
                discussionId: comment.message.discussionId,
            }));
            expect(reopened.messages.find(message => message.id === proposal.message.id)).toEqual(proposal.message);
            expect(network.messages).toHaveLength(2);
            if (mode === 'e2ee') {
                const wire = JSON.stringify(homes.requestsFor('/v1/discussions').map(request => request.input));
                expect(wire).not.toContain(target.quote);
                expect(wire).not.toContain(proposalInput.after);
            }
            expect((await readExternalDoc(carrier.api, { ref }))).toEqual({ ...read, openCommentCount: 1 });
            const proposalRef = proposal.message.messageRef;
            expect(await requestExternalDocDecline(carrier.api, { proposalRef })).toMatchObject({
                proposalRef, docEditProposalDispositionV1: { state: 'declined' },
            });
            expect(homes.artifacts(serverId).read(created.artifactId)?.bodyVersion).toBe(created.revision.bodyVersion);
            const acceptedProposal = DocCollaborationActionOutputSchemasV1['doc.edit.propose'].parse(await proposeExternalDocEdit(carrier.api, {
                ...proposalInput, localId: 'external-accepted-proposal',
            }));
            expect(await requestExternalDocAcceptance(carrier.api, {
                proposalRef: acceptedProposal.message.messageRef, expectedRevision: created.revision,
            })).toMatchObject({ proposalRef: acceptedProposal.message.messageRef,
                docEditProposalDispositionV1: { state: 'accepted', acceptedRevision: {
                    headerVersion: created.revision.headerVersion, bodyVersion: created.revision.bodyVersion + 1,
                } },
            });
            expect(await account.readArtifact(created.artifactId)).toMatchObject({ isDecrypted: true,
                body: source.replace(target.quote, proposalInput.after),
                headerVersion: created.revision.headerVersion, bodyVersion: created.revision.bodyVersion + 1,
            });
            const cancellation = new AbortController(); cancellation.abort();
            const beforeCancellation = homes.requests.length;
            expect(await settleComposed(commentOnExternalDoc(carrier.api, { target, localId: 'cancelled',
                content: { v: 1, parts: [{ t: 'text', text: 'Do not publish.' }] } }, { signal: cancellation.signal })))
                .toMatchObject({ settled: 'rejected' });
            expect(homes.requests).toHaveLength(beforeCancellation);
            enabled = false;
            expect(await settleComposed(readExternalDoc(carrier.api, { ref }))).toMatchObject({ settled: 'rejected' });
            enabled = true;
            current = false; lifetime.abort(); carrier.retire();
            expect(await settleComposed(readExternalDoc(carrier.api, { ref }))).toMatchObject({ settled: 'rejected',
                code: transport === 'hosted-web' ? 'host_api_handler_disposed' : 'stale_surface' });
            expect(network.messages).toHaveLength(2);
            expect(homes.artifacts(serverId).read(created.artifactId)?.bodyVersion).toBe(created.revision.bodyVersion);
        } finally { await carrier.dispose(); host.dispose?.(); account.dispose(); await homes.reset(); }
    });
});


describe('client Action Session-open continuation', () => {
    it.each(['sameAccount', 'foreignAccount', 'retiredCapture'] as const)(
        'fences raw mounted exact Session addresses to the captured Account (%s)', async mode => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { buildSessionTurnsProjectionV1 } = await import('@happier-dev/protocol/sessions/turns/sessionTurnV1');
        const accountLifetime = clientAccountLifetime();
        const originHome = rpcHomes.get('server-client-action')!.id;
        const targetHome = mode === 'foreignAccount'
            ? (await network.addHome('https://raw-address-foreign-account', 'another-account')).id
            : rpcHomes.get('server-wire')!.id;
        const opened: Array<{ sessionId: string; serverId?: string }> = [];
        let sessionReads = 0;
        const displayWarnings = vi.spyOn(console, 'warn');
        onTestFinished(() => displayWarnings.mockRestore());
        const execute = createFrontDoorActionExecute(createDefaultActionExecutor({
            openSession: (sessionId, options) => { opened.push({ sessionId, serverId: options?.serverId }); },
        }));
        network.setHttpResponder(async (url, init) => {
            const parsedUrl = new URL(String(url));
            if (mode === 'retiredCapture' && parsedUrl.origin === rpcHomes.get('server-wire')!.serverUrl) accountLifetime.retire();
            if (parsedUrl.pathname === '/v2/sessions/reviewed') {
                if ((init?.method ?? 'GET') === 'GET') sessionReads += 1;
                // End a regressed continuation at the network boundary so the
                // count assertion reports the loop instead of a test timeout.
                if (sessionReads > 4) accountLifetime.retire();
                return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id: 'reviewed' })));
            }
            if (parsedUrl.pathname === '/v1/sessions/reviewed/turns') {
                return Response.json(buildSessionTurnsProjectionV1({ sessionId: 'reviewed', updatedAt: 1, turns: [] }));
            }
            return createEmptyAccountBootstrapHttpResponse(parsedUrl.pathname, init);
        });
        const controller = createBoundPluginSurfaceController({ facts: {
            ...surfaceContext(), serverId: originHome, accountLifetime,
            machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
            executionOrigin: CLIENT_ACTION_ORIGIN, occurrenceId: 'raw-address-mount',
            interactionEnabled: true, daemonInteractionEnabled: true,
        }, binding: { executeHostAction: execute } });
        try {
            const outcome = await controller.hostApi.handleRequest(executeActionRequest({ action: 'session.open',
                input: { sessionId: 'reviewed' }, sessionAddress: { serverId: targetHome, sessionId: 'reviewed' } }))
                .then(value => ({ kind: 'value' as const, value }), error => ({ kind: 'error' as const, error }));
            if (mode === 'retiredCapture' && outcome.kind === 'error') {
                expect(outcome.error).toMatchObject({ name: 'AbortError' });
                expect(opened).toEqual([]);
                return;
            }
            expect(outcome.kind).toBe('value');
            if (outcome.kind !== 'value') throw outcome.error;
            const result = outcome.value;
            if (mode === 'sameAccount') {
                expect(sessionReads).toBe(1);
                expect(result, JSON.stringify(result)).toMatchObject({ status: 'opened', sessionId: 'reviewed', serverId: targetHome });
                expect(opened).toEqual([{ sessionId: 'reviewed', serverId: targetHome }]);
                const readsAtIdle = sessionReads;
                displayWarnings.mockClear();
                await new Promise(resolve => setTimeout(resolve, 0));
                expect(sessionReads).toBe(readsAtIdle);
                expect(displayWarnings.mock.calls.filter(([message]) => String(message).includes('[SessionDisplay]'))).toHaveLength(0);
            } else {
                expect(result, JSON.stringify(result)).toMatchObject({ code: 'unavailable' });
                expect(opened).toEqual([]);
            }
        } finally { controller.dispose(); accountLifetime.retire(); }
    });

    it('opens the canonical Automation Event editor through a registered client Action', async () => {
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { readAutomationEventAuthoringSeed } = await import('@/sync/domains/workflows/automationEventAuthoringSeed');
        const { consumeWorkflowEditorDraftSeed } = await import('@/sync/domains/workflows/workflowEditorDraftSeed');
        const previousScope = getStorage().getState().profileScope;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const accountLifetime = clientAccountLifetime();
        getStorage().setState({ profileScope: accountLifetime.scope });
        publishAppliedActiveServerSnapshot({ serverId: accountLifetime.scope.serverId,
            serverUrl: 'https://client-action.example', generation: 0 });
        const intent = { eventRef: { pluginId: CALLER_PLUGIN_ID, localId: 'service-health' },
            monitoringMachineId: 'chosen-observer', setupInput: { subject: 'watched-service' } };
        const activation = createClientActionActivation({ accountLifetime, handler: async (_input, context) => {
            await context.ui.openAutomationEvent(intent);
            return null;
        } });
        newSessionNavigation.mockClear();
        let seedId: string | undefined;
        try {
            await activation.composition.reconcile([activation.activation]);
            await expect(dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
            })).resolves.toEqual({ ok: true, result: null });
            const route = newSessionNavigation.mock.calls[0]?.[0] as Readonly<{
                pathname: string; params: { automationEventSeedId: string; serverId: string };
            }>;
            expect(route.pathname).toBe('/workflows');
            expect(Object.keys(route.params).sort()).toEqual(['automationEventSeedId', 'serverId']);
            seedId = route.params.automationEventSeedId;
            expect(readAutomationEventAuthoringSeed(seedId, accountLifetime.scope)).toEqual(intent);
        } finally {
            if (seedId) consumeWorkflowEditorDraftSeed(seedId);
            await activation.composition.unload(); accountLifetime.retire();
            getStorage().setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        }
    });


});

describe('client Action declared SessionTarget admission', () => {
    it.each(['global daemon', 'Session daemon', 'global client', 'global account'] as const)(
        'creates a private-input request before executable validation for a confidential %s Action', async placement => {
        const sessionScoped = placement === 'Session daemon';
        const inputSchema = { type: 'object', properties: { token: { type: 'string' },
            ...(sessionScoped ? { sessionId: { type: 'string' } } : {}) },
            required: ['token', ...(sessionScoped ? ['sessionId'] : [])], additionalProperties: false };
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({ accountLifetime,
            accountPlacement: placement === 'global account', dangerLevel: 'writesRemote', inputSchema,
            inputHints: { fields: [{ path: 'token', title: 'Token', widget: 'secret', required: true }] },
            ...(sessionScoped ? { sessionTarget: { field: 'sessionId', cardinality: 'one' } } : {}),
        });
        const action = placement.endsWith('daemon')
            ? { ...activation.action, execution: { target: 'daemon' as const } } : activation.action;
        const identity = { pluginId: action.pluginId, localId: action.id };
        let mountServerId = 'server-client-action';
        const requests: ApprovalRequest[] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            listContributedActionDefinitions: () => [projectedActionToDefinition(action, activation.projection)],
            approvalsCreate: async ({ request }) => {
                requests.push(ApprovalRequestV2Schema.parse(request));
                return { artifactId: 'confidential-input-request' };
            },
            resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: {
                serverId: 'server-client-action', sessionId: sessionId! } }),
        }));
        nestedActionConfirmation.onShow = approve => approve();
        try {
            const outcome = await dispatchPluginSurfaceAction({ action: identity,
                input: sessionScoped ? { sessionId: 'selected-session' } : {},
                invocationSurface: 'ui', pluginUiProjection: activation.projection,
                clientAction: {},
                ...(placement === 'global daemon' ? {
                    callerPluginId: CALLER_PLUGIN_ID, callerContributionLocalId: 'inspector-app',
                    callerBinding: mountedCallerBinding({ machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId }),
                    callerSourceCustody: TARGET_SOURCE_CUSTODY,
                } : {}),
                resolveContributedAction: resolveExactClientAction(action),
                contributedAction: { serverId: mountServerId, machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
                    // The daemon transport is the system boundary. Its real schema parser
                    // reproduces the registry's refusal before any plugin effect can run.
                    execute: async (_machineId, options) => {
                        const { createPluginActionInvocation } = await import('@happier-dev/protocol/plugins/actions/invocation');
                        const invocation = createPluginActionInvocation({ ...identity, inputSchema,
                            occurrenceSignal: new AbortController().signal, isCurrent: () => true });
                        const prepared = invocation.prepare(options.input);
                        if (prepared.kind !== 'settled') throw new Error('Private input must be requested before dispatch');
                        return { supported: true, result: prepared.result };
                    } },
                hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
                    serverId: mountServerId, runtimeAccountId: 'test-account',
                    authority: 'present_user' as const,
                    defaultSessionMachineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
                    actionRequestId: 'confidential-input-request', actionCaller: { kind: 'host' },
                } },
            });
            expect(outcome).toEqual({ ok: true, result: { kind: 'approval_request_created',
                artifactId: 'confidential-input-request', actionId: 'action.invoke' } });
            expect(requests).toHaveLength(1);
            expect(requests[0]).toMatchObject({ status: 'open', actionId: 'action.invoke',
                executionOriginV1: { authority: 'present_user' },
                actionArgs: { action: identity, input: sessionScoped ? { sessionId: 'selected-session' } : {} },
                preview: { confidentialInputs: { kind: 'action_inputs', paths: ['input.token'] } } });
            expect(requests[0]!.actionArgs).not.toHaveProperty('input.token');
        } finally { nestedActionConfirmation.onShow = null; await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['ui', 'agent', 'mcp', 'workers', 'foreignHome', 'presenter', 'retired', 'readRelations'] as const)(
        'admits the real Channels daemon Session operand before confirmation and serialized dispatch (%s)', async mode => {
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/channels/src/manifest');
        const { SessionIdSchema } = await import('@happier-dev/plugin-sdk/sessions');
        const declaration = PLUGIN_MANIFEST.contributes?.actions?.find(action => action.id === 'session-pull-request-binding-v1');
        if (!declaration) throw new Error('Channels binding declaration is unavailable');
        const source = createClientActionActivation({ pluginId: PLUGIN_MANIFEST.id, localId: declaration.id,
            dangerLevel: declaration.dangerLevel, confirmationWhen: declaration.confirmationWhen,
            sessionTarget: declaration.sessionTarget, inputSchema: declaration.inputSchema, surfaces: declaration.surfaces });
        const action = { ...source.action, execution: { target: 'daemon' as const } };
        const invocationSurface = mode === 'mcp' || mode === 'readRelations' ? 'mcp'
            : mode === 'agent' || mode === 'retired' ? 'agent' : 'ui';
        const common = { action: { pluginId: action.pluginId, localId: action.id },
            input: mode === 'readRelations' ? { kind: 'readRelations', credentialRef: null }
                : { kind: 'attach', sessionId: { selector: mode === 'workers' ? 'workers' : 'manager', of: 'parent' },
                    pullRequestUrl: 'https://github.com/example/repository/pull/1' } } satisfies PluginUiJsonValueV1;
        // Automated UI entry reaches the daemon through a genuinely registered
        // client handler, which owns the strict clientPluginAction provenance.
        const wrapper = createClientActionActivation({ surfaces: ['agent', 'mcp'],
            handler: (_value, context) => context.ui.executeAction(common.action, common.input) });
        const projection = { ...source.projection,
            installedPackagesById: { ...source.projection.installedPackagesById, ...wrapper.projection.installedPackagesById },
            reactNativeBundlesById: { ...source.projection.reactNativeBundlesById, ...wrapper.projection.reactNativeBundlesById },
            actionsById: { ...wrapper.projection.actionsById, [`${action.pluginId}/${action.id}`]: action } };
        const previousSettings = getStorage().getState().settings;
        if (mode === 'presenter' || mode === 'retired') getStorage().setState({ settings: { ...previousSettings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                [formatQualifiedPluginActionId(common.action)]: { approvalRequiredSurfaces: [invocationSurface] },
            } }) } });
        let manager = 'reviewed-session';
        let resolutions = 0;
        let confirmations = 0;
        let current = true;
        const issued: Array<{ sessionId?: string; invocation: unknown; serverId?: string }> = [];
        daemonRpc.mockImplementation(async (request: Readonly<{ method: string; serverId?: string; payload?: unknown }>) => {
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) return answerActionSchemasRead(request);
            const payload = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
            const value = payload.input;
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected the admitted Channels operand');
            // This is the same exact-ID gate used by the real Channels management handler.
            const sessionId = value.kind === 'readRelations' ? undefined : SessionIdSchema.parse(value.sessionId);
            issued.push({ sessionId, invocation: payload.invocation, serverId: request.serverId });
            if (value.kind === 'readRelations') return { ok: true, result: { kind: 'relations', links: [] } };
            return { ok: true, result: { kind: 'attached', bindingId: 'binding-exact-target' } };
        });
        const createPort = (invocationSurface: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['invocationSurface'],
            hostAction?: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['hostAction']) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction, readProjection: () => projection, readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            listContributedActionDefinitions: () => createPort('ui').listCurrentContributedActionDefinitions?.('allSurfaces') ?? [],
            resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: { serverId: 'server-client-action', sessionId: sessionId! } }),
            readSessionManager: async () => { resolutions += 1; return { kind: 'manager', address: {
                serverId: mode === 'foreignHome' ? 'other-target-home' : 'server-client-action', sessionId: manager } }; },
            sessionList: async ({ query }) => markSessionListQueryResultV1({ sessions: ['worker-a', 'worker-b'].map(id => ({ id,
                active: false, presence: 'offline', updatedAt: 1, manager: { sessionId: query?.underSessionId } })),
                nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }),
            isActionApprovalRequired: () => false,
            invokeContributedAction: request => executeCurrentUiContextContributedAction(request, {
                execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
            }),
        }));
        const unregister = registerCurrentUiContextActionPort(createPort);
        nestedActionConfirmation.onShow = approve => {
            confirmations += 1;
            expect(issued).toEqual([]);
            expect(resolutions).toBe(1);
            manager = 'replacement-session';
            if (mode === 'retired') current = false;
            approve();
        };
        try {
            await wrapper.composition.unload();
            if (invocationSurface !== 'ui') await wrapper.composition.reconcile([wrapper.activation]);
            const binding = { resolveContributedAction: (identity: PluginContributionIdentityV1) =>
                resolveExactClientAction(action)(identity) ?? resolveExactClientAction(wrapper.action)(identity),
                isCurrent: () => current,
                contributedAction: { serverId: 'server-client-action', machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId },
                hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
                    serverId: 'server-client-action', defaultSessionId: 'reviewed-session',
                    authority: invocationSurface === 'ui' ? 'present_user' as const : 'account_automation' as const,
                    actionCaller: { kind: 'host' as const },
                } } };
            const result = invocationSurface === 'ui' && mode !== 'presenter'
                ? await createPluginSurfaceActionHostApi({ ...binding, surfaceContext: surfaceContext(),
                    callerBinding: mountedCallerBinding({ machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId }),
                    callerSourceCustody: TARGET_SOURCE_CUSTODY }).handleRequest(executeActionRequest(common))
                : await dispatchPluginSurfaceAction({ ...binding,
                    ...(invocationSurface === 'ui' ? common : { action: { pluginId: wrapper.action.pluginId, localId: wrapper.action.id }, clientAction: {} }),
                    invocationSurface,
                    ...(mode === 'presenter' ? { requestCurrentIntent: async (
                        request: Parameters<NonNullable<DispatchPluginSurfaceActionInput['requestCurrentIntent']>>[0],
                    ) => {
                        confirmations += 1;
                        expect(issued).toEqual([]);
                        expect(resolutions).toBe(1);
                        manager = 'replacement-session';
                        return { status: 'approved' as const, fingerprint: request.fingerprint };
                    } } : {}) });
            if (mode === 'readRelations') {
                expect(result).toEqual({ ok: true, result: { kind: 'relations', links: [] } });
                expect(resolutions).toBe(0);
                expect(confirmations).toBe(0);
                expect(issued).toHaveLength(1);
                expect(issued[0]!.sessionId).toBeUndefined();
            } else if (mode === 'retired') {
                expect(result).toMatchObject({ ok: false });
                expect(confirmations, JSON.stringify({ result, resolutions, issued })).toBe(1);
                expect(issued).toEqual([]);
            } else if (mode === 'workers' || mode === 'foreignHome') {
                expect(result).toMatchObject({ code: 'unavailable', diagnostics: [mode === 'workers'
                    ? 'session_target_cardinality_mismatch' : 'session_target_home_mismatch'] });
                expect(confirmations).toBe(0);
                expect(issued).toEqual([]);
            } else {
                expect(result, JSON.stringify({ result, resolutions, confirmations, issued })).toMatchObject(invocationSurface === 'ui' && mode !== 'presenter' ? { kind: 'attached' }
                    : { ok: true, result: { kind: 'attached' } });
                expect(resolutions).toBe(1);
                expect(confirmations).toBe(mode === 'presenter' ? 1 : 0);
                expect(issued).toHaveLength(1);
                expect(issued[0]!.sessionId).toBe('reviewed-session');
                if (invocationSurface === 'ui' && mode !== 'presenter') expect(issued[0]!.invocation).toMatchObject({ kind: 'mountedPluginSurface',
                    mountedBinding: { pluginId: CALLER_PLUGIN_ID, occurrenceId: mountedCallerBinding().occurrenceId } });
                if (invocationSurface !== 'ui') expect(issued[0]!.invocation).toMatchObject({ kind: 'clientPluginAction',
                    clientActionBinding: { pluginId: wrapper.action.pluginId, contributionLocalId: wrapper.action.id,
                        occurrenceId: wrapper.action.occurrenceId } });
            }
        } finally { nestedActionConfirmation.onShow = null; unregister();
            getStorage().setState({ settings: previousSettings }); await wrapper.composition.unload(); }
    });

});
