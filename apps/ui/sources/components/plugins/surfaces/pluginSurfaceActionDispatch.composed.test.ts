import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { renderHook, renderScreen } from '@/dev/testkit';
import type { AppShellPluginUiProjectionValue, AppShellClientExecutableActivationState,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import type { ActionSettlementV1 } from '@happier-dev/protocol/actions/executor/actionSettlement';
import { projectAutomationSubjectStructuralV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { DATABASE_PLUGIN_ID_V1, DATABASE_TARGETS_FORGET_ACTION_ID_V1, databaseActionLocalIdV1,
    DatabaseTargetsForgetInputV1ProtocolSchema } from '@happier-dev/database-protocol';
import { readAutomationDatabaseSubjectV1 } from '@happier-dev/plugin-sdk/automations';
import { DatabaseManualTargetV1Schema } from '@happier-dev/plugin-sdk/database';

import { createPluginUiHostApiClient } from '@happier-dev/plugin-sdk/ui/client';
import { PluginError, isPluginError, definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { pluginActionDeclarationRequiresConfirmationForInput, pluginActionRequiresPresentUserIntent } from '@happier-dev/protocol/plugins/actions/invocation';
import type { PluginUiHostApi, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import {
    buildQualifiedPluginContributionKey} from '@happier-dev/protocol/plugins/contribution-key';
import {
    formatQualifiedPluginActionId} from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import {
    ApprovalRequestV2Schema,
    type ApprovalRequest} from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
    createActionExecutor, createHostReviewedChildPortV1} from '@happier-dev/protocol/actions/actionExecutor';
import {
    decideApprovalRequestTransition} from '@happier-dev/protocol/approvals/approvalRequestTransition';
import {
    DaemonPluginStructuredMessageActionExecuteRequestSchema} from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import {
    DaemonPluginStructuredMessageActionExecuteResponseSchema,
    PluginProjectionInstalledPackageV2Schema,
    PluginProjectionV2Schema,
    PluginProjectedActionV2Schema,
    type PluginProjectedActionV2} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import {
    normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import {
    PLUGIN_INVOCABLE_ACTION_IDS} from '@happier-dev/protocol/actions/pluginActionSurface';
import {
    PluginJsonValueV2Schema} from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import {
    pluginSourceCustodyV1Equal,
    type PluginSourceCustodyV1,
} from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import {
    type ActionExecutorDeps, type ActionExecutorContext} from '@happier-dev/protocol/actions/executor/types';
import {
    type ActionSessionTargetDeclarationV1} from '@happier-dev/protocol/actions/sessionTargetV1';
import {
    type PluginActionCurrentIntentResult} from '@happier-dev/protocol/plugins/actions/invocation';
import {
    type PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import { getPluginMachineExecutionOriginRef,
    type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
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
    PluginUiOpenNewSessionRequestV1Schema,
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
import { projectedActionToDefinition } from '@/components/appShell/currentUiContext/contributedActionDefinition';

import { projectPluginUiTheme } from './pluginUiThemeProjection';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import { createPluginUiProjectedActionResolver, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import type {
    DispatchPluginSurfaceActionInput,
    PluginSurfaceContributedActionTransport,
    PluginSurfaceHostActionExecute,
} from './pluginSurfaceActionDispatch';
import type { PluginPage } from '@/components/plugins/pages/pluginPages';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { createActionOperationRunner } from '../../../../../cli/src/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '../../../../../cli/src/daemon/actionOperations/actionOperationStore';
import { ActionExecuteFailureSchema, ActionFailureCauseV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { NotificationsNotifyMeResultV1Schema } from '@happier-dev/protocol/account/notifications/notifyMeV1';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { DOC_EDIT_PROPOSAL_HTTP_PATHS_V1, DocCollaborationActionOutputSchemasV1,
    DocEditAcceptTransportInputV1Schema, DocEditDeclineTransportInputV1Schema,
    DocEditDecisionResultV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { SessionTargetV1ProtocolSchema } from '@happier-dev/protocol/actions/sessionTargetV1';
import { captureDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import { DiscussionReadResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { externalAuthoringPlugin, readExternalDoc, commentOnExternalDoc, proposeExternalDocEdit,
    requestExternalDocAcceptance, requestExternalDocDecline } from '../../../../../../packages/plugin-ui/fixtures/external-authoring/src/index';
import { manifest as authoredAccountManifest, activateAccount as activateAuthoredAccount } from '../../../../../../packages/plugin-sdk/fixtures/account-actions/src/accountRuntime';
import { createExternalWorkItemsPluginFixture } from '@/dev/testkit/fixtures/workItemsPlugin';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { buildV2PluginProjectionById } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
// Configure responses only at the physical daemon boundary, after real scoped
// Home/Account and per-caller read admission have run.
const daemonRpc = vi.hoisted(() => vi.fn());
// O-OPS browser placement is covered by the public Account composition suite;
// these local execution/admission cases retain the desktop native HTTP host.
const accountBrowserRelay = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/utils/platform/tauri/transferFetch', () => ({
    resolveTauriRuntimeFetch: async () => accountBrowserRelay.enabled ? null
        : (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
// The OS picker is the only substituted media owner; capability admission and
// transfer routing below still run through the real Home/Account network path.
const openerMediaPicker = vi.hoisted(() => ({ getDocumentAsync: vi.fn(async () => ({ canceled: true, assets: null })) }));
vi.mock('expo-document-picker', () => openerMediaPicker);
const newSessionNavigation = vi.hoisted(() => vi.fn());
const nestedActionConfirmation = vi.hoisted(() => ({
    onShow: null as null | ((confirm: () => void, cancel: () => void) => void),
}));

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/sessionOpsNetworkBoundary'))
    .createSessionOpsSocketIoClientBoundary(importOriginal));

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
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry, readObservedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
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
const { createPluginSurfaceHostApi } = await import('./createPluginSurfaceHostApi');
const { ComposerSnapshotV1Schema } = await import('@happier-dev/protocol/plugins/ui/composer');
const { createComposerPresentationHostHandlers, createComposerPresentationTransactionApplier,
    registerComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { observePluginSurfaceActionRead } = await import('./pluginSurfaceActionReadObservation');
const { dispatchPluginResolvedSemanticCommand } = await import('./dispatchPluginResolvedSemanticCommand');
const { dispatchPluginPageHeaderAction: dispatchPluginAppPageHeaderAction } = await import('@/components/plugins/pages/pluginPageHeaderActions');
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
const { listServerProfiles, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
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
    clearDaemonMergedProjectionCacheForTests();
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

it.each([
    { pendingCapabilityRead: 1, retire: true },
    { pendingCapabilityRead: 2, retire: true },
    { pendingCapabilityRead: 1, retire: false },
])('admits the OS media picker only for a current bound opener (capability $pendingCapabilityRead, retire $retire)', async ({ pendingCapabilityRead, retire }) => {
    const home = rpcHomes.get('server-client-action')!;
    const scope = { serverId: home.id, accountId: home.accountId };
    const ref = { kind: 'discussion', discussionId: 'retiring-media-opener' } as const;
    const snapshot = ComposerSnapshotV1Schema.parse({
        revision: 1, ref, text: 'opener', references: [], attachments: [], layout: 'wrap',
        capabilities: { text: true, references: true, attachments: true, submit: true },
        state: { focused: false, editable: true, submittable: true, submitting: false, running: false },
    });
    const unregister = registerComposerPresentationTarget(ref, {
        readScope: () => scope, readSnapshot: () => snapshot,
        readRevision: () => 1, replace: () => 1,
    });
    onTestFinished(unregister);
    const identity = { pluginId: 'acme.media-opener', localId: 'image' };
    const attachment: import('@/sync/domains/plugins/ui/projection').PluginUiComposerAttachmentProjection = {
        id: 'acme.media-opener/image', pluginId: identity.pluginId, identity, occurrenceId: 'media-generation',
        definition: { id: 'image', title: 'Image', icon: 'file', cardinality: 'many', valueSchema: { type: 'object' } },
        valueValidator: () => true,
    };
    const handlers = createComposerPresentationHostHandlers({
        scope, mountedComposer: ref,
        owner: { identity, occurrenceId: 'media-generation', surfaceInstanceKey: 'media-opener' },
        transactionApplier: createComposerPresentationTransactionApplier({ scope, composerAttachmentsById: { [attachment.id]: attachment } }),
        executionTarget: { serverId: home.id, machineId: 'machine-1' },
        isCurrent: () => true,
    });
    onTestFinished(handlers.dispose);
    const surface = { ...surfaceContext(), pluginId: identity.pluginId, contributionId: identity.localId };
    const api = createPluginSurfaceHostApi({ surfaceContext: surface, handlers });
    let finishCapability!: () => void;
    const capabilityReply = new Promise<void>(resolve => { finishCapability = resolve; });
    let capabilitiesRead = 0;
    daemonRpc.mockImplementation(async (request: { method: string }) => {
        if (request.method !== RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1) throw new Error('Unexpected media RPC');
        capabilitiesRead += 1;
        if (capabilitiesRead === pendingCapabilityRead) await capabilityReply;
        return { success: true, available: true, capability: 'composer.mediaContent.v1' };
    });
    openerMediaPicker.getDocumentAsync.mockClear();
    const pending = api.handleRequest({ version: 1, requestId: 'retiring-media', surface,
        method: 'pickComposerMedia', payload: { ref, request: { attachmentLocalId: 'image', kinds: ['image'] } } });
    await network.waitForRpcRequest((request, all) => request.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1
        && all.filter(value => value.method === request.method).length === pendingCapabilityRead);
    if (retire) unregister();
    finishCapability();
    expect(await pending).toMatchObject({ code: 'unavailable' });
    expect(openerMediaPicker.getDocumentAsync).toHaveBeenCalledTimes(retire ? 0 : 1);
    unregister();
    let readsAfterSettlement = 0;
    onTestFinished(registerComposerPresentationTarget(ref, {
        readScope: () => { readsAfterSettlement += 1; return scope; }, readSnapshot: () => snapshot,
        readRevision: () => 1, replace: () => 1,
    }));
    // A settled operation must not observe later document publications.
    expect(readsAfterSettlement).toBe(0);
});

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
        show: vi.fn((config: { props: { onConfirm?(): void; onCancel?(): void; onAnswer?(confirmed: boolean): void } }) => {
            const confirm = config.props.onConfirm ?? (() => config.props.onAnswer?.(true));
            const cancel = config.props.onCancel ?? (() => config.props.onAnswer?.(false));
            if (nestedActionConfirmation.onShow) nestedActionConfirmation.onShow(confirm, cancel);
            else queueMicrotask(cancel);
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
function clientAccountLifetime(serverId = 'server-client-action') {
    let current = true;
    const listeners = new Set<() => void>();
    const lifetime = {
        scope: { serverId, accountId: 'test-account' },
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
    approvalScope?: PluginProjectedActionV2['approvalScope'];
    dangerLevel?: PluginProjectedActionV2['dangerLevel'];
    confirmationWhen?: PluginProjectedActionV2['confirmationWhen'];
    surfaces?: PluginProjectedActionV2['surfaces'];
    accountPlacement?: boolean;
    invokingUi?: true;
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
        ...(input.approvalScope ? { approvalScope: input.approvalScope } : {}),
        surfaces: input.surfaces ?? ['ui'],
        placementBindings: ['detailsPanel'],
        execution: input.accountPlacement ? { target: 'account', ...(input.invokingUi ? { invokingUi: true } : {}), account: {
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
    approvalScope?: PluginProjectedActionV2['approvalScope'];
    localId?: string;
    dangerLevel?: PluginProjectedActionV2['dangerLevel'];
    confirmationWhen?: PluginProjectedActionV2['confirmationWhen'];
    surfaces?: PluginProjectedActionV2['surfaces'];
    inputSchema?: object;
    inputHints?: PluginProjectedActionV2['inputHints'];
    sessionTarget?: ActionSessionTargetDeclarationV1;
    outputSchema?: object;
    handler?: PluginClientActionHandler;
    activate?: (api: PluginClientApi) => void;
    accountHandler?: PluginAccountActionHandler;
    accountActivate?: (api: import('@happier-dev/plugin-sdk').PluginAccountApi) => unknown;
    readOnly?: import('@happier-dev/protocol/plugins/actions/v2').PluginActionContributionV2['readOnly'];
    observeRead?: import('@happier-dev/plugin-sdk/actions').PluginActionReadObserver<PluginUiJsonValueV1, import('@happier-dev/plugin-sdk/actions').PluginAccountActionContext>;
    accountLifetime?: ActiveServerAccountScopeLifetime;
    occurrenceId?: string;
    artifactGraph?: PluginUiArtifactsManifestEntryV2;
    accountPlacement?: boolean;
    invokingUi?: true;
    accountActionDeclaration?: import('@happier-dev/protocol/plugins/actions/v2').PluginActionContributionV2;
    omitProjectedAccountDeclaration?: boolean;
    accountSourceCustody?: Extract<PluginSourceCustodyV1, { kind: 'account_release' | 'bundled_first_party' }>;
    machineSourceCustody?: PluginSourceCustodyV1;
    machineExecutionOrigin?: PluginMachineExecutionOriginV1;
    authoredAccount?: boolean;
    accountManifest?: typeof authoredAccountManifest;
    accountAvailability?: { when: { fact: 'session.exists'; operator: 'equals'; value: boolean } };
    authorization?: Partial<NonNullable<PluginProjectedActionV2['authorization']>>;
}>) {
    const pluginId = input.authoredAccount ? authoredAccountManifest.id : input.pluginId ?? CALLER_PLUGIN_ID;
    const pluginVersion = input.accountManifest?.version ?? (input.authoredAccount ? authoredAccountManifest.version : '1.2.3');
    const localId = input.localId ?? 'refresh-index';
    const executionOrigin = input.machineExecutionOrigin ?? clientActionExecutionOrigin(pluginId);
    const hostOrigin = Object.freeze({
        ...CLIENT_ACTION_HOST_ORIGIN,
        machineId: getPluginMachineExecutionOriginRef(executionOrigin).machineId,
        executionOrigin,
    });
    const baseAction = createClientTargetAction({
        identity: { pluginId, localId },
        approvalScope: input.approvalScope,
        dangerLevel: input.dangerLevel,
        surfaces: input.surfaces,
        accountPlacement: input.accountPlacement,
        invokingUi: input.invokingUi,
        sessionTarget: input.sessionTarget,
        confirmationWhen: input.confirmationWhen,
    });
    const authoredDeclaration = input.accountActionDeclaration ?? (input.accountManifest ?? (input.authoredAccount ? authoredAccountManifest : undefined))
        ?.contributes?.actions?.find(row => row.id === localId);
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
    const artifactGraph = input.artifactGraph ?? (input.authoredAccount && authoredDeclaration?.execution.target === 'account' ? PluginUiArtifactsManifestEntryV2Schema.parse({
        ...CLIENT_ACTION_ARTIFACT_GRAPH, artifactId: 'account-runtime', executable: { exports: [authoredDeclaration.execution.account.exportName] },
        entry: 'react-native/account-runtime/entry.cjs.bundle',
        files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({ ...file, relativePath: 'react-native/account-runtime/entry.cjs.bundle' })),
    }) : CLIENT_ACTION_ARTIFACT_GRAPH);
    const identity = clientActionIdentity(localId, pluginId, artifactGraph);
    const accountOrigin = input.accountPlacement ? { serverId: input.accountLifetime?.scope.serverId ?? 'server-client-action',
        accountId: input.accountLifetime?.scope.accountId ?? 'test-account',
        custodyId: input.occurrenceId ?? `occurrence-${pluginId}`,
        sourceCustody: input.accountSourceCustody ?? { kind: 'account_release', pluginId, version: pluginVersion, archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
    } : undefined;
    const accountDeclaration = input.accountManifest ?? (input.authoredAccount ? authoredAccountManifest : input.accountPlacement ? {
        schemaVersion: 2, id: pluginId, version: '1.2.3', displayName: 'Account author fixture', runtime: { apiVersion: 1 },
        contributes: { actions: [{ id: action.id, title: action.title, scopes: action.scopes, surfaces: action.surfaces,
            ...(action.approvalScope ? { approvalScope: action.approvalScope } : {}),
            execution: action.execution, dangerLevel: action.dangerLevel, placementBindings: action.placementBindings,
            ...(action.confirmation ? { confirmation: action.confirmation } : {}), inputSchema: input.inputSchema ?? {},
            ...(action.confirmationWhen ? { confirmationWhen: action.confirmationWhen } : {}),
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
            ...input.authorization,
            generation: {
                targetGeneration: input.occurrenceId ?? `occurrence-${pluginId}`,
                desiredGeneration: input.occurrenceId ?? `occurrence-${pluginId}`,
                appliedGeneration: input.occurrenceId ?? `occurrence-${pluginId}`,
            },
        },
        ...(accountOrigin ? { hostAccountOrigin: accountOrigin,
            accountActionDeclaration: input.omitProjectedAccountDeclaration ? undefined
                : input.accountActionDeclaration ?? accountDeclaration?.contributes.actions?.find(candidate => candidate.id === action.id) }
            : { executionOrigin, [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: hostOrigin }),
    });
    const bundleId = `reactNativeBundle:${pluginId}:${localId}`;
    const completeAccountArtifact = input.accountManifest ?? (input.authoredAccount ? authoredAccountManifest : undefined);
    const projectedActions = completeAccountArtifact ? Object.fromEntries((completeAccountArtifact.contributes?.actions ?? [])
        .filter(declaration => declaration.execution.target === 'account'
            && declaration.execution.account.artifactId === artifactGraph.artifactId)
        .map(declaration => [
        `${pluginId}/${declaration.id}`, Object.freeze({ ...projectedAction, id: declaration.id,
            title: declaration.title, scopes: declaration.scopes, surfaces: declaration.surfaces,
            execution: declaration.execution, placementBindings: declaration.placementBindings,
            dangerLevel: declaration.dangerLevel, confirmation: declaration.confirmation,
            readOnly: declaration.readOnly, sessionTarget: declaration.sessionTarget,
            confirmationWhen: declaration.confirmationWhen,
            accountActionDeclaration: declaration }),
    ])) : { [`${pluginId}/${localId}`]: projectedAction };
    const projectedResources = completeAccountArtifact ? Object.fromEntries((completeAccountArtifact.contributes?.resources ?? [])
        .filter(declaration => declaration.execution?.target === 'account'
            && declaration.execution.account.artifactId === artifactGraph.artifactId)
        .map(declaration => [
        `${pluginId}/${declaration.id}`, { id: declaration.id, pluginId, occurrenceId: projectedAction.occurrenceId,
            source: declaration.source, scope: declaration.scope, resourceKind: declaration.kind,
            contentType: declaration.contentType, execution: declaration.execution, hostAccountOrigin: accountOrigin },
    ])) : {};
    const projectedConnectedAccounts = completeAccountArtifact ? Object.fromEntries(
        (completeAccountArtifact.contributes?.connectedAccountDescriptors ?? [])
            .filter(definition => definition.authentication.account?.artifactId === artifactGraph.artifactId)
            .map(definition => [`${pluginId}/${definition.id}`, {
                id: definition.id, pluginId, occurrenceId: projectedAction.occurrenceId, definition,
                hostAccountOrigin: accountOrigin,
            }]),
    ) : {};
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
                ...(input.machineSourceCustody ? { occurrenceId: projectedAction.occurrenceId, executionOrigin,
                    sourceCustody: input.machineSourceCustody } : {}),
            }),
        }),
        actionsById: Object.freeze(projectedActions),
        resourcesById: Object.freeze(projectedResources),
        connectedAccountDescriptorsById: Object.freeze(projectedConnectedAccounts),
        reactNativeBundlesById: Object.freeze(Object.fromEntries([
            ...Object.values(projectedActions).map(projected => projected.id),
            ...Object.values(projectedResources).map(resource => `resources/${resource.id}`),
            ...Object.values(projectedConnectedAccounts).map(descriptor => `connectedAccountDescriptors/${descriptor.id}`),
        ].map(contributionId => {
            const id = completeAccountArtifact ? `reactNativeBundle:${pluginId}:${contributionId}` : bundleId;
            return [id, Object.freeze({
                id,
                pluginId,
                occurrenceId: projectedAction.occurrenceId,
                contributionKind: 'reactNativeBundle' as const,
                contributionId,
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
    const activate = vi.fn(input.accountActivate ?? input.activate ?? (input.authoredAccount ? activateAuthoredAccount : (api: PluginClientApi) => {
        // The registration transaction is real: only the artifact loader is a
        // system-boundary test double.
        if (input.accountHandler) {
            // The selected Account realm is checked by the real registration scope.
            (api as unknown as import('@happier-dev/plugin-sdk').PluginAccountApi).actions.register(localId, input.accountHandler,
                input.observeRead ? { observeRead: input.observeRead } : undefined);
        } else api.actions.register(localId, input.handler ?? (() => { throw new Error('Handler fixture missing'); }));
    }));
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
        daemonAction: PluginProjectedActionV2Schema.parse({ ...action, occurrenceId: projectedAction.occurrenceId,
            authorization: projectedAction.authorization }),
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

it('settles Viewed writes through the native mount without an AppShell Action origin', async () => {
    const { ScmComparisonSchema } = await import('@happier-dev/protocol/scm/comparison');
    const { PluginHostApiProvider, PluginUiHostPresentationScope } = await import('@happier-dev/plugin-ui/advanced');
    const { projectHappierUiEnvironment } = await import('@happier-dev/plugin-ui/environment');
    const { useScmFileViewed } = await import('@happier-dev/plugin-ui/hostApi');
    const { createPluginUiPrivatePresentationHost } = await import('./pluginUiPrivatePresentationHost');
    const lifetime = clientAccountLifetime();
    let viewed = false;
    const activation = createClientActionActivation({ localId: 'file-viewed', accountLifetime: lifetime,
        handler: async input => {
            if (input !== null && typeof input === 'object' && !Array.isArray(input) && input.kind === 'set') {
                viewed = input.viewed === true;
                return { kind: 'ready', path: 'a.ts', state: viewed ? 'viewed' : 'unviewed' };
            }
            return { kind: 'ready', headOid: 'head', files: [{ path: 'a.ts', state: viewed ? 'viewed' : 'unviewed' }] };
        } });
    const identity = { pluginId: activation.action.pluginId, localId: activation.action.id };
    const comparison = ScmComparisonSchema.parse({ id: 'mounted-viewed-pr', repository: { rootPath: '/repo' },
        source: { kind: 'pullRequest', locator: { providerId: identity.pluginId, repository: 'example/repo', number: 17,
            fileViewedActions: { read: { action: identity, input: { kind: 'read' } }, set: { action: identity, input: { kind: 'set' } } } } },
        endpoints: { after: 'head' }, freshness: 'current', inventory: { state: 'complete', reasons: [], files: [] } });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
    const host = createPluginSurfaceActionHostApi({ surfaceContext: surfaceContext(),
        callerBinding: mountedCallerBinding({ machineId: 'machine-client-action' }), callerSourceCustody: TARGET_SOURCE_CUSTODY,
        hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
            serverId: lifetime.scope.serverId, runtimeAccountId: lifetime.scope.accountId,
            authority: 'present_user', actionCaller: { kind: 'host' },
        } },
        pluginUiProjection: activation.projection,
        resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {}, actionAccountLifetime: lifetime,
        contributedAction: { machineId: 'machine-client-action', serverId: lifetime.scope.serverId, accountLifetime: lifetime } });
    const surface = createPluginSurfaceContextFixture({ accountScope: lifetime.scope, target: { kind: 'app' } });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface, requestSurface: surfaceContext(),
        installedMethods: host.installedMethods, handleRequest: host.handleRequest, isCurrent: lifetime.isCurrent });
    let source: import('@happier-dev/plugin-sdk/scm').ScmFileViewedSource | null = null;
    function Files() {
        source = useScmFileViewed({ comparison, serverId: lifetime.scope.serverId, host: null });
        return null;
    }
    await activation.composition.reconcile([activation.activation]);
    await expect(adapter.api.executeAction(identity, { kind: 'read' })).resolves.toMatchObject({ kind: 'ready' });
    const screen = await renderScreen(React.createElement(PluginHostApiProvider,
        { hostApi: adapter.api, surfaceActivity: { active: true } },
        React.createElement(PluginUiHostPresentationScope, { environment: projectHappierUiEnvironment(surface),
            presentationHost: createPluginUiPrivatePresentationHost(undefined) }, React.createElement(Files))));
    try {
        await vi.waitFor(() => expect({ status: source?.getSnapshot(), file: source?.getFile('a.ts') }).toEqual({
            status: { status: 'ready', headOid: 'head', errorCode: null },
            file: { state: 'unviewed', pending: false, errorCode: null },
        }));
        await act(async () => { expect(await source?.setViewed('a.ts', true)).toBe(true); });
        expect(viewed).toBe(true);
        expect(source?.getFile('a.ts')).toEqual({ state: 'viewed', pending: false, errorCode: null });
        await act(async () => { expect(await source?.setViewed('a.ts', false)).toBe(true); });
        expect(viewed).toBe(false);
        expect(source?.getFile('a.ts')).toEqual({ state: 'unviewed', pending: false, errorCode: null });
    } finally {
        await screen.unmount(); adapter.dispose(); host.dispose?.(); await activation.composition.unload();
    }
});

// Collect the cross-package source graph before timing the mounted gesture.
await Promise.all([
    import('@/sync/ops/actions/defaultActionExecutor'),
    import('@/dev/testkit/harness/externalActionAccountHttpBoundary'),
    import('../../../../../cli/src/daemon/externalActions/externalActionRuntime.testkit'),
    import('../../../../../cli/src/daemon/externalActions/createDaemonExternalActionContributedInvoker'),
    import('../../../../../cli/src/daemon/externalActions/executeExternalAction'),
    import('../../../../../cli/src/session/actions/approvals/targetActionCurrentIntent'),
]);

describe('mounted picker approval through the Account relay to the daemon', () => {
    it.each(['source', 'account'] as const)('retires an unbound raw confirmation with its mounted %s lifetime', async change => {
        const lifetime = clientAccountLifetime();
        const definition = definePlugin({ id: 'acme.confirmed-surface', version: '1.2.3' });
        const parsed = ingestPluginManifestV2(definition.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const publish = (digest: string, cursor: number) => replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
            snapshot: { availabilityCursor: cursor, materializations: [], snapshots: [], intentReads: [{ pluginId: parsed.manifest.id,
                response: { availabilityCursor: cursor, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                    intent: { pluginId: parsed.manifest.id, desiredVersion: parsed.manifest.version, enabled: true,
                        offlineUiHosting: 'disabled', writableCollections: [], revision: String(cursor) },
                    release: { ref: { pluginId: parsed.manifest.id, version: parsed.manifest.version }, archiveDigestSha256: digest,
                        normalizedManifest: parsed.manifest, collectionContracts: [], uiSlots: [],
                        packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [] } },
                } }] } });
        publish(`sha256:${'a'.repeat(64)}`, 1);
        const selected = readPluginAccountAvailability(lifetime.scope).readCurrentAccountExecution(parsed.manifest.id);
        if (selected.kind !== 'available') throw new Error('Expected admitted Account surface custody');
        const controller = createBoundPluginSurfaceController({ facts: {
            pluginId: parsed.manifest.id, contributionId: 'panel', surfaceId: 'confirmed-account-surface', placement: 'appSurface',
            platform: 'web', channel: 'internal', serverId: lifetime.scope.serverId, occurrenceId: selected.custodyId,
            accountExecutionOrigin: { ...lifetime.scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody },
            accountLifetime: lifetime, interactionEnabled: true, daemonInteractionEnabled: false,
            actionInputSelectionFactsKey: createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: parsed.manifest.id }),
        } });
        nestedActionConfirmation.onShow = confirm => {
            if (change === 'source') publish(`sha256:${'b'.repeat(64)}`, 2);
            else lifetime.retire();
            queueMicrotask(confirm);
        };
        try {
            const result = await controller.hostApi.handleRequest({ version: 1, requestId: 'admitted-account-confirmation',
                surface: controller.surfaceContext, method: 'confirm', payload: { message: 'Apply the reviewed change?' } });
            expect(result).toMatchObject({ code: 'stale_surface' });
        } finally { nestedActionConfirmation.onShow = null; controller.dispose(); lifetime.retire(); }
    });

    it.each([
        { name: 'executes the exact approved mutation once without another approval Artifact', change: 'none' },
        { name: 'executes the exact bundled approved mutation once', change: 'bundled' },
        { name: 'prompts for a contributed control whose Action does not declare a mounted review', change: 'contributed-control' },
        { name: 'runs a contributed Action with its declared exact mounted review and no second prompt', change: 'reviewed-control' },
        { name: 'refuses a declared mounted review when preparation changes the reviewed input', change: 'changed-control' },
        { name: 'COORD R2 confirms an explicitly Ask-gated Account Action through the runtime relay', change: 'ask-control' },
        { name: 'COORD R2 leaves a declined carried review editable without executing the Action', change: 'ask-cancel' },
        { name: 'retains the acquired declaration when the mounted Account row is cold', change: 'cold-declaration' },
        { name: 'does not execute a declined picker mutation', change: 'decline' },
        { name: 'executes the approved operands after the trusted Account source changes', change: 'source' },
        { name: 'retains the host repair confirmation through the same Account relay', change: 'raw-host' },
        { name: 'refuses host repair consent after its projected target occurrence changes', change: 'raw-host-target' },
        { name: 'does not reuse consent after the normalized input changes', change: 'input' },
        { name: 'does not reuse consent for another Action', change: 'action' },
        { name: 'does not reuse consent for another Account', change: 'account' },
        { name: 'does not reuse consent for another Home', change: 'home' },
        { name: 'does not reuse consent for another request', change: 'request' },
        { name: 'does not reuse consent for another selected Machine', change: 'machine' },
    ] as const)('$name', async ({ change }) => {
        const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const { createExternalActionRuntime, publishAccountExternalActionRuntime } = await import('../../../../../cli/src/daemon/externalActions/externalActionRuntime.testkit');
        const { createDaemonExternalActionContributedInvoker } = await import('../../../../../cli/src/daemon/externalActions/createDaemonExternalActionContributedInvoker');
        const { executeExternalAction } = await import('../../../../../cli/src/daemon/externalActions/executeExternalAction');
        const { createTargetActionCurrentIntentAdapter } = await import('../../../../../cli/src/session/actions/approvals/targetActionCurrentIntent');
        const { createPluginUiPrivatePresentationHost } = await import('./pluginUiPrivatePresentationHost');
        const home = rpcHomes.get('server-client-action')!;
        const lifetime = clientAccountLifetime(home.id);
        const mountedReview = change === 'reviewed-control' || change === 'changed-control';
        const usesInlineReview = mountedReview || change === 'contributed-control';
        const pluginId = 'acme.reviewed-picker';
        const localId = 'assign';
        const input = { issue: 'ISSUE-42', assignee: 'alice' };
        const carriedReview = change === 'ask-control' || change === 'ask-cancel';
        const isControl = change === 'contributed-control' || carriedReview || mountedReview;
        const previous = getStorage().getState();
        let effects = 0;
        let secondArtifacts = 0;
        let receivedCaller: unknown;
        let receivedAuthority: unknown;
        const carriedRequests: { requestId: string; reviewDigest: string | undefined; result: unknown }[] = [];
        let boundaryFailure: unknown;
        let dispatches = 0;
        const accountSource = change === 'bundled' || mountedReview
            ? { kind: 'bundled_first_party' as const, packagedRuntime: { kind: 'cli_version_root' as const, versionRootId: 'fixture-cli-root' } }
            : { kind: 'account_release' as const, pluginId, version: '1.2.3', archiveDigestSha256: `sha256:${'a'.repeat(64)}` };
        const runtimeOptions = { localId, surfaces: ['ui', 'plugin'] as const, placementBindings: ['detailsPanel'] as const,
            ...(mountedReview ? { approvalInputCustody: 'live_only' as const } : { executionTarget: 'account' as const }),
            pluginVersion: '1.2.3', sourceCustody: accountSource, onInput: (value: unknown) => expect(value).toEqual(input),
            ...(mountedReview ? { confirmation: { title: 'Assign reviewer?', mountedReview: 'exact_input' as const } } : {}),
            ...(carriedReview ? { confirmationWhen: { presentUserUi: false } } : {}),
        };
        const runtime = createExternalActionRuntime('global', pluginId, () => { effects++; }, mountedReview ? () => ({
            serverIdentityId: 'srv_client_action', materializationRef: { pluginId, machineId: 'machine-local', materializationId: 'fixture-materialization' },
        }) : undefined, undefined,
            undefined, undefined, 'writesRemote', undefined, runtimeOptions);
        const published = mountedReview ? undefined : await publishAccountExternalActionRuntime(runtime);
        onTestFinished(() => published ? published.dispose() : runtime.dispose());
        let selectedColdOccurrence: string | undefined;
        if (change === 'cold-declaration') {
            replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
                availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId, response: {
                    availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                    intent: { pluginId, desiredVersion: runtime.manifest.version, enabled: true, offlineUiHosting: 'disabled',
                        writableCollections: [], revision: 'reviewed' },
                    release: { ref: { pluginId, version: runtime.manifest.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                        normalizedManifest: runtime.manifest, collectionContracts: [], uiSlots: [],
                        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
                } }],
            } });
            const selected = readPluginAccountAvailability(lifetime.scope).readCurrentAccountExecution(pluginId);
            if (selected.kind !== 'available') throw new Error('Expected the canonical acquired Account declaration');
            selectedColdOccurrence = selected.custodyId;
        }
        const declaration = runtime.contributes.actions.find(action => action.definition.id === localId)?.admittedTarget?.declaration;
        if (!declaration) throw new Error('Expected the canonical admitted Account declaration');
        const changedRuntime = change === 'source' || change === 'raw-host-target'
            ? createExternalActionRuntime('global', pluginId, () => { effects++; }, undefined, undefined,
                undefined, undefined, 'writesRemote', undefined, { ...runtimeOptions,
                    ...(change === 'source' ? { sourceCustody: { kind: 'account_release', pluginId,
                        version: '1.2.3', archiveDigestSha256: `sha256:${'b'.repeat(64)}` } }
                        : {}) }) : runtime;
        const rawHost = change === 'raw-host' || change === 'raw-host-target';
        const invoke = createDaemonExternalActionContributedInvoker({ acquireRuntimeRegistryLease: published?.acquire ?? (async () => ({
            registry: runtime, source: 'ephemeral', durableRevision: runtime.durableRevision ?? -1, release: async () => {},
        })),
            requestCurrentIntent: createTargetActionCurrentIntentAdapter({
                create: async () => { secondArtifacts++; throw new Error('A second approval Artifact was requested'); },
                read: async () => null, update: async () => ({ ok: true }),
            }) });
        const askSettings = normalizeActionsSettingsV1({ v: 1, actions: {
            'action.invoke': { approvalRequiredSurfaces: ['ui'] },
        } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ invokeContributedAction: invoke,
            // Trigger the receiving executor's real carried review. This models
            // an Ask discovered after the originating UI has dispatched.
            ...(carriedReview ? { readActionsSettings: () => askSettings } : {}),
        }));
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://server-client-action',
            serverIdentityId: 'srv_client_action', accountId: lifetime.scope.accountId, machineId: 'machine-local',
            actionId: 'action.invoke', tokenEpoch: 0, failure: value => {
                const failure = ActionExecuteFailureSchema.safeParse(value);
                return failure.success ? failure.data : null;
            }, execute: async (value, context) => {
                dispatches++;
                if (changedRuntime !== runtime) await published?.adopt(changedRuntime, change === 'source' ? `sha256:${'b'.repeat(64)}` : undefined);
                receivedCaller = context.invocation.caller;
                receivedAuthority = context.invocation.authority;
                if (carriedReview) {
                    // The Home fixture opened the actual requester box. Use the
                    // receiving executor with the test host's signing boundary.
                    const result = await executor.execute('action.invoke', value, {
                        surface: 'ui', actionCaller: context.invocation.caller, authority: context.invocation.authority,
                        actionRequestId: context.authorization.binding.requestId,
                        runtimeAccountId: lifetime.scope.accountId, serverId: home.id, serverIdentityId: 'srv_client_action',
                        externalActionTarget: context.target, externalActionExecutionAuthorization: context.authorization,
                        presentUserConfirmation: context.invocation.presentUserConfirmation,
                        signExternalActionApprovalInput: () => 'fixture-receiver-signature',
                    });
                    carriedRequests.push({ requestId: context.authorization.binding.requestId,
                        reviewDigest: context.invocation.presentUserConfirmation?.reviewDigest, result });
                    return result.ok ? result.result : result;
                }
                // Mutate only the opened transport payload, then enter the real
                // outer Action executor and target gate with the stale consent.
                const confirmation = context.invocation.presentUserConfirmation;
                if (confirmation) {
                    if (change === 'input' || change === 'action') {
                        const { fingerprintPluginAccountActionConfirmation } = await import('@happier-dev/protocol/plugins/actions/invocation');
                        confirmation.inputDigest = fingerprintPluginAccountActionConfirmation({ pluginId, pluginVersion: '1.2.3',
                            sourceCustody: accountSource, declaration, input: {
                                action: { pluginId, localId: change === 'action' ? 'another-action' : localId },
                                input: { ...input, assignee: change === 'input' ? 'bob' : input.assignee },
                            } })!;
                    }
                    if (change === 'account') confirmation.accountId = 'another-account';
                    if (change === 'home') confirmation.serverId = 'another-home';
                    if (change === 'request') confirmation.requestId = 'another-request';
                    if (change === 'machine') confirmation.target = { kind: 'machine', machineId: 'another-machine' };
                }
                const result = await executeExternalAction({ actionId: 'action.invoke', envelope: context.envelope,
                    principal: { accountId: lifetime.scope.accountId, authentication: { kind: 'account', tokenEpoch: 0 }, authority: 'present_user' },
                    currentMachineId: 'machine-local', currentAccountId: lifetime.scope.accountId, currentServerId: home.id,
                    currentInstallationId: context.authorization.binding.installationId,
                    externalActionMachineRequestPrivateKey: boundary.installationPrivateKey,
                    executionAuthorization: context.authorization, verifyExecutionAuthorization: async () => true,
                    prepareRequesterAccountContext: async () => ({ authorization: context.authorization, executor,
                        invocation: context.invocation, resolveEncryption: async () => null, dispose: async () => {} }),
                    resolveTarget: async ({ target }) => target ?? null, executor,
                });
                if (result.kind !== 'response' || !('execution' in result.response)) throw new Error(JSON.stringify(result));
                if (!result.response.execution.ok) return result.response.execution;
                return result.response.execution.result;
            } });
        const machine = boundary.machine;
        const callerOrigin = await runtime.resolveCurrentPluginExecutionOrigin!(pluginId);
        if (!callerOrigin) throw new Error('Expected the fixture runtime caller origin');
        const { createHydratedPlainMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const visible = createHydratedPlainMachineFixture({ id: machine.id, accountId: lifetime.scope.accountId,
            machine: { activeAt: Date.now(), access: machine.access } });
        getStorage().getState().applyMachines([visible], true, { sourceServerId: home.id });
        network.setHttpResponder(async (url, init) => {
            try {
                return await boundary.handle(new URL(String(url)), init)
                    ?? createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init);
            } catch (error) {
                boundaryFailure = error && typeof error === 'object' ? {
                    name: 'name' in error ? error.name : undefined,
                    code: 'code' in error ? error.code : undefined,
                    frames: 'stack' in error && typeof error.stack === 'string'
                        ? error.stack.split('\n').slice(1, 5) : undefined,
                    issues: 'issues' in error && Array.isArray(error.issues) ? error.issues.map((issue: unknown) =>
                        issue && typeof issue === 'object' ? {
                            path: 'path' in issue ? issue.path : undefined,
                            code: 'code' in issue ? issue.code : undefined,
                        } : null) : undefined,
                } : null;
                throw error;
            }
        });
        const activation = mountedReview ? null : createClientActionActivation({ pluginId, localId, accountPlacement: true, accountLifetime: lifetime,
            dangerLevel: 'writesRemote', surfaces: ['ui', 'plugin'], accountActionDeclaration: declaration,
            confirmationWhen: runtimeOptions.confirmationWhen,
            omitProjectedAccountDeclaration: change === 'cold-declaration', occurrenceId: selectedColdOccurrence ?? published!.selection.custodyId,
            accountSourceCustody: accountSource, artifactGraph: PluginUiArtifactsManifestEntryV2Schema.parse({
                ...CLIENT_ACTION_ARTIFACT_GRAPH, artifactId: 'portable', executable: { exports: ['activate'] },
                entry: 'react-native/portable/entry.cjs.bundle', files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({
                    ...file, relativePath: 'react-native/portable/entry.cjs.bundle',
                })),
            }), accountHandler: () => { throw new Error('Browser must relay'); } });
        const qualifiedId = buildQualifiedPluginContributionKey({ pluginId, localId });
        const daemonAction = activation?.daemonAction ?? PluginProjectedActionV2Schema.parse({
            id: localId, pluginId, occurrenceId: runtime.readPluginOccurrenceId!(pluginId), available: true, approvalScope: 'environment',
            title: declaration.title, scopes: declaration.scopes, surfaces: declaration.surfaces, execution: declaration.execution,
            dangerLevel: declaration.dangerLevel, confirmation: declaration.confirmation,
        });
        const action = activation?.action ?? {
            ...daemonAction, executionOrigin: callerOrigin,
            [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: { ...CLIENT_ACTION_HOST_ORIGIN, machineId: machine.id, executionOrigin: callerOrigin },
        };
        const projection = activation?.projection ?? { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            actionsById: { [qualifiedId]: action },
            installedPackagesById: { [pluginId]: PluginProjectionInstalledPackageV2Schema.parse({ id: pluginId,
                displayName: 'Reviewed picker', version: '1.2.3', enabled: true, source: { kind: 'localPath', locator: pluginId },
                sourceCustody: accountSource, occurrenceId: daemonAction.occurrenceId, executionOrigin: callerOrigin }) },
        };
        if (activation) {
            await activation.composition.unload();
            await activation.composition.reconcile([activation.activation]);
        }
        if (isControl) daemonRpc.mockImplementation(async (request: { method: string }) =>
            request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                ? { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {},
                    actionsById: { [qualifiedId]: daemonAction } }) }
                : answerActionSchemasRead(request));
        let confirmations = 0;
        nestedActionConfirmation.onShow = (confirm, cancel) => {
            confirmations++;
            queueMicrotask(change === 'decline' || change === 'ask-cancel' ? cancel : confirm);
        };
        accountBrowserRelay.enabled = true;
        const withdrawProjection = isControl ? publishCommittedAppShellPluginUiProjection(() => projection) : () => {};
        onTestFinished(withdrawProjection);
        const hook = await renderHook(() => useBoundPluginSurfaceController({ facts: {
            pluginId, contributionId: 'issue-assignee-picker', surfaceId: 'approved-picker', placement: 'appSurface', platform: 'web', channel: 'internal',
            machineId: machine.id, serverId: home.id, occurrenceId: runtime.readPluginOccurrenceId!(pluginId)!, executionOrigin: callerOrigin,
            accountLifetime: lifetime, interactionEnabled: true, daemonInteractionEnabled: true,
            actionInputSelectionFactsKey: createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: pluginId }),
            pluginUiProjection: projection, resolveContributedAction: resolveExactClientAction(action),
        } }));
        const { Action, PropertyList, useExecutePluginAction } = await import('@happier-dev/plugin-ui');
        const { PluginUiProvider } = await import('@happier-dev/plugin-ui/advanced');
        const controller = hook.getCurrent();
        const surface = createPluginSurfaceContextFixture({ mount: { kind: 'destination',
            destination: { pluginId, localId: 'issue-assignee-picker' }, container: 'rightPane' }, target: { kind: 'app' } });
        const facade = createCanonicalPluginReactNativeHostApiAdapter({ surface, requestSurface: controller.surfaceContext,
            requestIdPrefix: 'picker-consent', installedMethods: controller.hostApi.admissionMethods,
            handleRequest: controller.hostApi.handleRequest });
        let settledStatus = 'idle';
        let settledExecution: unknown;
        const unregisterControlPort = isControl
            ? registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
                invocationSurface, hostAction, readProjection: () => projection, readNavigationBinding: () => null,
                reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            })) : () => {};
        function AssignmentPicker() {
            const action = useExecutePluginAction({ pluginId, localId });
            settledStatus = action.execution.status;
            settledExecution = action.execution;
            return React.createElement(PropertyList, { items: [{ id: 'assignee', label: 'Assignee', value: 'Unassigned',
                editor: { kind: 'choice', value: null, choices: [{ id: 'alice', label: 'Alice' }],
                    onCommit: async selected => { await action.execute({ ...input, assignee: selected }); } } }] });
        }
        function ContributedControl() {
            return React.createElement(Action.Control, { action: { pluginId, localId }, title: mountedReview ? 'Apply' : 'Assign reviewer',
                ...(usesInlineReview ? { reviewedInput: change === 'changed-control' ? { ...input, assignee: 'bob' } : input } : {}),
                controller: { prepare: () => ({ input }), onSettled: execution => {
                    settledExecution = execution;
                    settledStatus = execution.ok ? 'success' : 'error';
                } } });
        }
        const screen = await renderScreen(React.createElement(PluginUiProvider, { hostApi: facade.api, context: surface,
            ...(usesInlineReview && controller.actionControls ? { presentationHost: createPluginUiPrivatePresentationHost(undefined, {
                actionControls: controller.actionControls,
            }) } : {}),
        },
            React.createElement(isControl ? ContributedControl : AssignmentPicker)));
        try {
            if (usesInlineReview) {
                await vi.waitFor(() => expect(controller.actionControls?.getSnapshot()).toHaveLength(1));
                const id = controller.actionControls!.getSnapshot()[0]!.id;
                await screen.pressByTestIdAsync(`plugin-surface-action-control:${id}`);
                await vi.waitFor(() => expect(settledStatus).not.toBe('idle'));
            } else await act(async () => {
                if (rawHost) {
                    const result = await machinePluginStructuredMessageActionExecute(machine.id, {
                        qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId, localId }), input,
                        expectedContributorOccurrenceId: runtime.readPluginOccurrenceId!(pluginId)!, executionSurface: 'ui',
                        serverId: home.id, accountLifetime: lifetime, presentUserIntent: 'confirmed',
                    });
                    expect(result).toMatchObject({ supported: true, result: { ok: change === 'raw-host' } });
                } else if (isControl) {
                    const controls = controller.actionControls;
                    if (!controls) throw new Error('Mounted host Action controls missing');
                    expect(controls.getSnapshot()).toHaveLength(1);
                    await controls.press(controls.getSnapshot()[0]!.id);
                } else {
                    const editor = screen.root.findByType(PropertyList).props.items[0].editor;
                    await editor.onCommit('alice');
                }
            });
            if (change === 'changed-control') {
                expect(settledExecution).toMatchObject({ ok: false, errorCode: 'approval_stale', effectAttempted: false });
                expect(dispatches).toBe(0);
                expect({ confirmations, effects, secondArtifacts }).toEqual({ confirmations: 0, effects: 0, secondArtifacts: 0 });
                return;
            }
            if (change === 'ask-cancel') {
                expect(settledExecution, JSON.stringify(carriedRequests)).toMatchObject({ ok: false, errorCode: 'approval_canceled', effectAttempted: false });
                expect(carriedRequests).toEqual([expect.objectContaining({ reviewDigest: undefined,
                    result: expect.objectContaining({ errorCode: 'action_interactive_review_required', details: expect.objectContaining({ reviewDigest: expect.any(String) }) }) })]);
                expect(controller.actionControls?.getSnapshot()[0]).toMatchObject({ busy: false });
                expect({ confirmations, effects, secondArtifacts }).toEqual({ confirmations: 1, effects: 0, secondArtifacts: 0 });
                return;
            }
            if (change === 'none' || change === 'cold-declaration' || change === 'bundled' || change === 'source' || isControl) {
                const receiver = readObservedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: home.id,
                    accountLifetime: lifetime, sections: ['actionsById'] });
                expect(settledExecution, JSON.stringify({ confirmations, effects, secondArtifacts, receivedCaller, receivedAuthority, boundaryFailure, carriedRequests,
                    receiver: receiver && { kind: receiver.kind, reason: receiver.kind === 'error' ? receiver.reason : undefined },
                    daemonRequests: network.requests.map(request => ({ method: request.method, machineId: request.targetId })),
                    requests: network.httpRequests.map(request => ({ method: request.method, path: new URL(request.url).pathname })),
                    execution: settledExecution })).toMatchObject(isControl ? { ok: true } : { status: 'success' });
            }
            if (carriedReview) {
                expect(carriedRequests).toHaveLength(2);
                const [first, confirmed] = carriedRequests;
                expect(first!.result).toMatchObject({ errorCode: 'action_interactive_review_required', details: { reviewDigest: confirmed!.reviewDigest } });
                expect(confirmed!.reviewDigest).toEqual(expect.any(String));
                expect(confirmed!.requestId).not.toBe(first!.requestId);
            }
            expect({ settledStatus, effects, secondArtifacts }).toEqual(change === 'none' || change === 'cold-declaration' || change === 'bundled' || change === 'source' || change === 'raw-host' || isControl
                ? { settledStatus: change === 'raw-host' ? 'idle' : 'success', effects: 1, secondArtifacts: 0 }
                : { settledStatus: rawHost ? 'idle' : 'error', effects: 0, secondArtifacts: 0 });
            expect({ confirmations, execution: settledExecution }).toMatchObject({ confirmations: rawHost || mountedReview ? 0 : 1 });
            if (rawHost || isControl) {
                expect(receivedCaller).toEqual({ kind: 'host' });
                expect(receivedAuthority).toBe('present_user');
            } else if (change !== 'decline') {
                expect(receivedCaller).toMatchObject({ kind: 'plugin', pluginId, contributionLocalId: 'issue-assignee-picker' });
                expect(receivedAuthority).toBe('account_automation');
            }
        } finally {
            accountBrowserRelay.enabled = false;
            nestedActionConfirmation.onShow = null;
            unregisterControlPort();
            await screen.unmount(); await hook.unmount(); await activation?.composition.unload(); lifetime.retire(); getStorage().setState(previous, true);
        }
    });
});

describe('action.invoke target occurrence through the real current-UI owner', () => {
    it.each(['exact', 'retired', 'conflict'] as const)('honors the wrapper occurrence expectation (%s)', async scenario => {
        const lifetime = clientAccountLifetime(rpcHomes.get('server-client-action')!.id);
        let effects = 0;
        const activation = createClientActionActivation({ pluginId: 'acme.exact-target', localId: 'read',
            accountPlacement: true, accountLifetime: lifetime, surfaces: ['ui'], accountHandler: () => { effects++; return { ok: true }; } });
        await activation.composition.unload();
        await activation.composition.reconcile([activation.activation]);
        const unregister = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface: surface, hostAction, readProjection: () => activation.projection, readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => ({ navigation: { area: 'settings', screen: 'plugins' }, commands: [] }),
                resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ invokeContributedAction: request =>
            executeCurrentUiContextContributedAction(request, { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context }) }));
        try {
            const result = await executor.execute('action.invoke', { action: { pluginId: 'acme.exact-target', localId: 'read' },
                input: { issue: 'ISSUE-42' }, expectedContributorOccurrenceId: scenario === 'retired' ? 'retired-target' : activation.action.occurrenceId },
            { surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
                ...(scenario === 'conflict' ? { expectedContributedActionOccurrenceId: 'different-host-target' } : {}) });
            expect({ ok: result.ok, effects }).toEqual({ ok: scenario === 'exact', effects: scenario === 'exact' ? 1 : 0 });
            if (!result.ok) expect(result.errorCode).toBe('plugin_action_generation_retired');
        } finally { unregister(); await activation.composition.unload(); lifetime.retire(); }
    });
});

describe('cold mounted caller Actions through the executable dispatcher', () => {
    async function publishManageMachine(serverId: string, machineId: string) {
        const { createMachineFixture, createMachineListByServerIdFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const previous = getStorage().getState();
        getStorage().setState({
            machineListByServerId: { ...previous.machineListByServerId,
                ...createMachineListByServerIdFixture([createMachineFixture({ id: machineId, isShared: false })], serverId) },
            machineListStatusByServerId: { ...previous.machineListStatusByServerId, [serverId]: 'idle' },
        });
        onTestFinished(() => getStorage().setState({ machineListByServerId: previous.machineListByServerId,
            machineListStatusByServerId: previous.machineListStatusByServerId }));
    }

    it.each(['issueClose', 'issueReopen'] as const)('acquires an unprojected same-plugin source mutation before confirmation (%s)', async mutation => {
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
        const { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } = await import('../../../../../../packages/plugins/scm-github/src/triage/contribution');
        const { GithubIssueCloseInputV1Schema, GithubIssueReopenInputV1Schema, GithubIssueDeltaResultV1Schema } = await import('../../../../../../packages/plugins/scm-github/src/triage/mutations/contracts');
        const { GITHUB_CONNECTED_ACCOUNT_PURPOSE } = await import('../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts');
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const normalized = ingestPluginManifestV2(PLUGIN_MANIFEST);
        if (!normalized.ok) throw new Error('GitHub manifest must ingest');
        const identity = { pluginId: PLUGIN_MANIFEST.id, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1[mutation] };
        const declaration = normalized.manifest.contributes.actions.find(action => action.id === identity.localId)!;
        const accountLifetime = clientAccountLifetime(resolveServerProfileScopeIdForIdentifier(rpcHomes.get('server-client-action')!.id));
        await publishManageMachine(accountLifetime.scope.serverId, 'machine-1');
        const executionOrigin = { ...clientActionExecutionOrigin(identity.pluginId), materializationRef: {
            ...clientActionExecutionOrigin(identity.pluginId).materializationRef, machineId: 'machine-1' } };
        const action = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction(identity),
            title: declaration.title, scopes: declaration.scopes, surfaces: declaration.surfaces,
            execution: declaration.execution, dangerLevel: declaration.dangerLevel,
            confirmation: declaration.confirmation, confirmationWhen: declaration.confirmationWhen,
            readOnly: declaration.readOnly, sessionTarget: declaration.sessionTarget,
            occurrenceId: 'github:71', executionOrigin });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            actionsById: { [buildQualifiedPluginContributionKey(identity)]: action } });
        const mountedProjection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1 }), 'web');
        const target = { v: 1, instance: { v: 1, instance: { source: { pluginId: identity.pluginId, localId: 'github-forge' },
            sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70' },
            binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: {
                service: { pluginId: identity.pluginId, localId: 'github-account' }, accountId: 'account-1' } },
            localInstanceKey: 'github.com', configuration: { v: 1, token: 'github-configuration-token-v1' } },
            localRef: { kindId: 'issue', collisionScope: 'github:1424792902', entryId: '64' }, routingToken: 'happier-dev/triage-qa-sandbox' };
        const value = mutation === 'issueClose' ? GithubIssueCloseInputV1Schema.parse({ ...target, stateReason: 'completed' })
            : GithubIssueReopenInputV1Schema.parse(target);
        const result = GithubIssueDeltaResultV1Schema.parse({ kind: 'uncertain' });
        clientActionSchemasByQualifiedId.set(buildQualifiedPluginContributionKey(identity), {
            inputSchema: declaration.inputSchema, outputSchema: declaration.resultSchema });
        const writes: unknown[] = [];
        let describes = 0;
        daemonRpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
            const schemas = answerActionSchemasRead(request);
            if (schemas !== undefined) return schemas;
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                describes++;
                return { protocolVersion: 1, projection };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                const wire = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
                expect(wire.qualifiedActionId).toBe(buildQualifiedPluginContributionKey(identity));
                expect(wire.expectedContributorOccurrenceId).toBe('github:71');
                writes.push(wire.input);
                return { ok: true, result };
            }
            throw new Error(`Unexpected RPC: ${request.method}`);
        });
        const controller = await renderHook(() => useBoundPluginSurfaceController({ facts: {
            pluginId: identity.pluginId, contributionId: 'github-triage-detail', surfaceId: 'source-issue64',
            placement: 'appSurface', platform: 'web', channel: 'internal', machineId: 'machine-1',
            serverId: accountLifetime.scope.serverId, occurrenceId: 'github:71', executionOrigin, accountLifetime,
            actionInputSelectionFactsKey: createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: identity.pluginId }),
            interactionEnabled: true, daemonInteractionEnabled: true, pluginUiProjection: mountedProjection,
            resolveContributedAction: createPluginUiProjectedActionResolver(mountedProjection.actionsById),
        } }));
        onTestFinished(() => controller.unmount());
        const mounted = controller.getCurrent();
        const confirmations: unknown[] = [];
        nestedActionConfirmation.onShow = confirm => { confirmations.push('confirmed'); confirm(); };
        onTestFinished(() => { nestedActionConfirmation.onShow = null; });
        const outcome = await mounted.hostApi.handleRequest({ version: 1, requestId: `source-${mutation}`,
            surface: mounted.surfaceContext, method: 'executeAction', payload: { action: identity, input: value } });
        expect(outcome).toEqual(result);
        expect(confirmations).toHaveLength(1);
        expect(writes).toEqual([value]);
        // A later operation at the same projection revision acquires from the
        // held answer; an advanced revision describes again.
        const execute = async (requestId: string) => await mounted.hostApi.handleRequest({ version: 1, requestId,
            surface: mounted.surfaceContext, method: 'executeAction', payload: { action: identity, input: value } });
        await expect(execute(`source-${mutation}-again`)).resolves.toEqual(result);
        expect({ describes, writes: writes.length }).toEqual({ describes: 1, writes: 2 });
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: accountLifetime.scope.serverId }, 'refresh');
        await expect(execute(`source-${mutation}-revised`)).resolves.toEqual(result);
        expect({ describes, writes: writes.length }).toEqual({ describes: 2, writes: 3 });
    });
    it.each(['delayed', 'pending', 'read-unavailable', 'absent', 'invalid'] as const)('settles the %s Channels attach projection for a createdHere SCM card without replaying attach', async readiness => {
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/channels/src/manifest');
        const { TriageScmPullRequestCard } = await import('../../../../../../packages/plugins/triage/src/ui/scmPullRequestCard');
        const { PluginUiProvider } = await import('../../../../../../packages/plugin-ui/src/components/PluginUiProvider');
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const identity = { pluginId: PLUGIN_MANIFEST.id, localId: 'session-pull-request-binding-v1' };
        const ingested = ingestPluginManifestV2(PLUGIN_MANIFEST);
        if (!ingested.ok) throw new Error('Channels manifest must ingest');
        const declaration = ingested.manifest.contributes.actions!.find(action => action.id === identity.localId)!;
        clientActionSchemasByQualifiedId.set(`${identity.pluginId}/${identity.localId}`, {
            inputSchema: declaration.inputSchema, outputSchema: declaration.outputSchema,
        });
        const action = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction(identity),
            surfaces: declaration.surfaces, dangerLevel: declaration.dangerLevel, readOnly: declaration.readOnly,
            confirmation: declaration.confirmation, confirmationWhen: declaration.confirmationWhen, sessionTarget: declaration.sessionTarget });
        const machineProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            actionsById: { [`${identity.pluginId}/${identity.localId}`]: action } });
        const machineUiProjection = normalizePluginUiProjection(machineProjection, 'web');
        const { projectedActionToDefinition } = await import('@/components/appShell/currentUiContext/contributedActionDefinition');
        let finishProjection!: () => void;
        const projectionReady = new Promise<void>(resolve => { finishProjection = resolve; });
        onTestFinished(finishProjection);
        const requests: string[] = [];
        const projectionUnavailable = readiness === 'absent' || readiness === 'invalid';
        let connectionPending = readiness === 'pending' || projectionUnavailable;
        daemonRpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
            const schemas = answerActionSchemasRead(request);
            if (schemas !== undefined) return schemas;
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                requests.push('projection');
                if (readiness === 'pending' && connectionPending) throw new Error('Machine connection pending');
                await projectionReady;
                if (readiness === 'invalid') return { protocolVersion: 1, projection: { v: 'invalid' } };
                return { protocolVersion: 1, projection: readiness === 'absent'
                    ? PluginProjectionV2Schema.parse({ v: 2, generation: 1 }) : machineProjection };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                requests.push('attach');
                const wire = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
                expect(wire.qualifiedActionId).toBe(`${identity.pluginId}/${identity.localId}`);
                expect(wire.input).toEqual({ kind: 'attach', sessionId: 'created-session', pullRequestUrl: 'https://github.com/acme/widgets/pull/60' });
                return { ok: true, result: { kind: 'attached', bindingId: 'binding-60' } };
            }
            throw new Error(`Unexpected RPC: ${request.method}`);
        });
        const accountLifetime = clientAccountLifetime(resolveServerProfileScopeIdForIdentifier(rpcHomes.get('server-client-action')!.id));
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1 }), 'web');
        const surface = createPluginSurfaceContextFixture({ mount: { kind: 'destination',
            destination: { pluginId: 'happier.triage', localId: 'scm-pull-request' }, container: 'rightPane' },
            target: { kind: 'session', sessionId: 'created-session' }, accountScope: accountLifetime.scope });
        const requestSurface = {
            pluginId: 'happier.triage', contributionId: 'scm-pull-request', surfaceId: 'created-scm-card',
            placement: 'sessionPane', platform: 'web', channel: 'internal', sessionId: 'created-session', resourceScope: [], diagnostics: [],
        } as const satisfies PluginUiSurfaceContextV1;
        let admittedInvocations = 0;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            listContributedActionDefinitions: () => [projectedActionToDefinition(
                machineUiProjection.actionsById[`${identity.pluginId}/${identity.localId}`]!, machineUiProjection)],

            resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique',
                address: { serverId: accountLifetime.scope.serverId, sessionId: sessionId! } }),
            invokeContributedAction: request => {
                expect(++admittedInvocations).toBe(1);
                expect(request.context.sessionTargetsV1).toBeDefined();
                return executeCurrentUiContextContributedAction(request, {
                    execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
                });
            },
        }));
        const api = createPluginSurfaceActionHostApiImpl({ surfaceContext: requestSurface,
            isConnectionPending: () => connectionPending,
            callerSourceCustody: { kind: 'development', registeredRootId: 'triage-root' },
            hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }),
                context: { serverId: accountLifetime.scope.serverId, defaultSessionId: 'created-session' } },
            callerBinding: mountedCallerBinding({ pluginId: 'happier.triage', contributionLocalId: 'scm-pull-request' }),
            contributedAction: { machineId: 'machine-1', serverId: accountLifetime.scope.serverId, accountLifetime },
            resolveContributedAction: createPluginUiProjectedActionResolver(projection.actionsById) });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface,
            requestSurface,
            installedMethods: api.installedMethods, handleRequest: api.handleRequest });
        onTestFinished(() => { adapter.dispose(); api.dispose?.(); });
        const { createSessionGitPullRequest } = await import('@/components/sessions/panes/git/pullRequest/createSessionGitPullRequest');
        const { resolveGitPullRequestFormAfterCreate } = await import('@/components/sessions/panes/git/pullRequest/gitPullRequestFormState');
        const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const scm = await import('@/sync/ops/sessionScm');
        // Only the SCM RPC is replaced. Creation, form result, mounted card,
        // automatic effect and contributed Action admission all remain real.
        const createRpc = vi.spyOn(scm, 'sessionScmPullRequestOpenOrReuse').mockResolvedValue({
            success: true, reused: false, nextAction: { kind: 'none' }, pullRequest: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/widgets' },
                number: 60, url: 'https://github.com/acme/widgets/pull/60', title: 'Created PR', baseBranch: 'main', headBranch: 'topic', state: 'open',
            } });
        projectManager.addSession(createSessionFixture({ id: 'created-session', metadata: {
            machineId: 'machine-1', path: '/repo', host: 'fixture', version: '1' } }));
        onTestFinished(() => { createRpc.mockRestore(); projectManager.removeSession('created-session'); });
        const outcome = await createSessionGitPullRequest({ sessionId: 'created-session', machineReachable: true, draftSupported: true,
            request: { base: 'main', head: 'topic', title: 'Created PR', body: '', draft: false }, state: {
                beginSessionProjectScmOperation: (sessionId, operation) => projectManager.beginSessionProjectScmOperation(sessionId, operation),
                finishSessionProjectScmOperation: (sessionId, operationId) => projectManager.finishSessionProjectScmOperation(sessionId, operationId),
                updateSessionProjectScmOperationProgress: (sessionId, operationId, progress) => projectManager.updateSessionProjectScmOperationProgress(sessionId, operationId, progress),
                appendSessionProjectScmOperation: (sessionId, entry) => projectManager.appendSessionProjectScmOperation(sessionId, entry),
            } });
        const created = resolveGitPullRequestFormAfterCreate(outcome).created;
        expect(created).not.toBeNull();
        expect(createRpc).toHaveBeenCalledTimes(1);
        const failures: unknown[] = [];
        const results: unknown[] = [];
        const hostApi: PluginUiHostApi = { ...adapter.api,
            executeAction: async (action, value, options) => {
                try {
                    const result = await adapter.api.executeAction(action, value, options);
                    results.push(result);
                    return result;
                }
                catch (error) { failures.push(error); throw error; }
            },
            // Resource and Session transport ports are genuine host boundaries.
            readResource: async () => {
                if (readiness === 'read-unavailable') throw new PluginError({ code: 'unavailable', retryable: false,
                    details: { requestId: 'r110-resource-read' },
                    diagnostics: [{ code: 'plugin_resource_transport_unavailable', severity: 'error' }] });
                return { contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
                    bytes: new TextEncoder().encode(JSON.stringify({ kind: 'ready', sessionId: 'created-session', pullRequests: [] })) };
            },
            watchResource: async () => ({ dispose() {} }),
            readSession: async () => null, watchSession: async () => ({ dispose() {} }),
        };
        const render = () => React.createElement(PluginUiProvider, { hostApi, context: surface },
            React.createElement(TriageScmPullRequestCard, { signal: new AbortController().signal,
                launchInput: { homeServerId: accountLifetime.scope.serverId, origin: 'createdHere', pullRequest: created! } }));
        const screen = await renderScreen(render());
        onTestFinished(() => screen.unmount());
        await vi.waitFor(() => expect(requests).toEqual(['projection']));
        if (readiness === 'pending') {
            // The connection owner pushes readiness. No author retry and no
            // already-entered attach is replayed at this boundary.
            connectionPending = false;
            api.notifyConnectionSettled?.();
            await vi.waitFor(() => expect(requests).toEqual(['projection', 'projection']));
        }
        finishProjection();
        if (projectionUnavailable) {
            // An empty section or malformed answer is settled unavailable even
            // while an unrelated Machine prerequisite still reports loading.
            await vi.waitFor(() => expect(failures).toHaveLength(1));
            expect(failures[0]).toMatchObject({ code: 'unavailable', details: { requestId: expect.any(String) },
                diagnostics: [{ code: 'plugin_surface_action_projection_unavailable', severity: 'error' }] });
            expect(results).toEqual([]);
            expect(requests).toEqual(['projection']);
            expect(admittedInvocations).toBe(0);
            return;
        }
        await vi.waitFor(() => {
            expect(failures).toEqual([]);
            expect(results).toEqual([{ kind: 'attached', bindingId: 'binding-60' }]);
        });
        await screen.update(render());
        expect(failures).toEqual([]);
        expect(admittedInvocations).toBe(1);
        expect(requests).toEqual(readiness === 'pending' ? ['projection', 'projection', 'attach'] : ['projection', 'attach']);
    });
    it('settles the actual Triage PR54 link and Resource refresh through mounted Account and Machine dispatch', async () => {
        const { Session } = await import('node:inspector/promises');
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/triage/src/manifest');
        const { activate } = await import('../../../../../../packages/plugins/triage/src/accountRuntime');
        const { PLUGIN_MANIFEST: githubManifest } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
        const { GITHUB_TRIAGE_ACTION_IDS_V1 } = await import('../../../../../../packages/plugins/scm-github/src/triage/contribution');
        const { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_ID } = await import('../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts');
        const { encodeGithubTriageConfiguration } = await import('../../../../../../packages/plugins/scm-github/src/triage/configuration');
        const { CORPUS_SOURCE_INSTANCE_LIFECYCLE, CORPUS_IDENTITY_TAG_LENGTH } = await import('../../../../../../packages/plugins/triage/src/corpus/collections/ids');
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { DaemonPluginUiTargetedContributionsReadResponseSchema, DaemonContributionRegistryProjectionDescribeResponseSchema,
            DaemonPluginActionSchemasReadResponseSchema, DaemonPluginUiResourceWatchOpenResponseSchema,
            DaemonPluginUiResourceWatchNextResponseSchema, DaemonPluginUiResourceWatchCloseResponseSchema,
        } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const { TriageConfiguredSourceInstanceV1Schema, TriageSourceReadSessionLinksResultV1Schema,
            TriageSourceLinkSessionResultV1Schema } = await import('@happier-dev/triage-protocol/v1');
        const { normalizePluginAccountCollectionContractsV1, PluginCollectionQueryRequestV1Schema,
            PluginCollectionQueryResultV1Schema, PluginCollectionGetResultV1Schema,
            PluginCollectionContractReadRequestV1Schema, PluginCollectionContractReadResultV1Schema } = await import('@happier-dev/protocol/plugins/data/collectionsV1');
        const { encodePluginCollectionLogicalValueV1 } = await import('@happier-dev/protocol/plugins/data/collectionLogicalCodecV1');
        const { compilePluginJsonSchema } = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } = await import('@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1');
        const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const pluginId = PLUGIN_MANIFEST.id;
        const localId = 'sessions/link-entry-v1';
        const sessionId = 'cmvwnqhz7008hmczhhd7ns2hi';
        const sourceInstanceId = 'e8be844f-e132-4f0c-97bd-da5b749fc44b';
        const input = { v: 1, sessionId, entryRef: { source: { pluginId: githubManifest.id, localId: 'github-forge' },
            kindId: 'pull-request', collisionScope: 'github:1424792902', entryId: '54' }, sourceInstanceId,
            display: { locator: { v: 1, displayPath: 'happier-dev/triage-qa-sandbox#54', routingToken: 'happier-dev/triage-qa-sandbox' },
                scopeLabel: 'happier-dev/triage-qa-sandbox' } };
        const accountLifetime = clientAccountLifetime(resolveServerProfileScopeIdForIdentifier(rpcHomes.get('server-client-action')!.id));
        const previous = getStorage().getState();
        const normalized = ingestPluginManifestV2(PLUGIN_MANIFEST);
        const normalizedGithub = ingestPluginManifestV2(githubManifest);
        if (!normalized.ok || !normalizedGithub.ok) throw new Error('Canonical manifests must ingest');
        const contracts = normalizePluginAccountCollectionContractsV1({ pluginId,
            contributions: normalized.manifest.contributes.accountCollections });
        const refs = contracts.map(({ pluginId, collectionId, schemaVersion, contractDigest }) => ({ pluginId, collectionId, schemaVersion, contractDigest }));
        const availability = { scope: accountLifetime.scope, snapshot: {
            availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId, desiredVersion: PLUGIN_MANIFEST.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: refs, revision: 'one' },
                release: { ref: { pluginId, version: PLUGIN_MANIFEST.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest: normalized.manifest, collectionContracts: refs, uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } }],
        } } satisfies Parameters<typeof replacePluginAccountAvailabilityProjection>[0];
        replacePluginAccountAvailabilityProjection(availability);
        const selected = readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecution(pluginId);
        if (selected.kind !== 'available') throw new Error('Expected declared Triage Account occurrence');
        const declaration = normalized.manifest.contributes.actions.find(action => action.id === localId)!;
        if (declaration.execution.target !== 'account') throw new Error('Expected portable link Action');
        const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({ ...CLIENT_ACTION_ARTIFACT_GRAPH,
            artifactId: declaration.execution.account.artifactId, executable: { exports: [declaration.execution.account.exportName] },
            entry: `react-native/${declaration.execution.account.artifactId}/entry.cjs.bundle`,
            files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({ ...file,
                relativePath: `react-native/${declaration.execution.account.artifactId}/entry.cjs.bundle` })) });
        const activation = createClientActionActivation({ pluginId, localId, accountPlacement: true,
            accountLifetime, accountManifest: normalized.manifest, occurrenceId: selected.custodyId,
            artifactGraph, accountActivate: activate });
        const origin = clientActionExecutionOrigin(githubManifest.id);
        const executionOrigin = { ...origin, materializationRef: { ...origin.materializationRef, machineId: 'provider-machine' } };
        const githubActions = Object.fromEntries(normalizedGithub.manifest.contributes.actions.filter(action =>
            action.id === GITHUB_TRIAGE_ACTION_IDS_V1.linkSession || action.id === GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks).map(action => {
            const projected = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction({ pluginId: githubManifest.id, localId: action.id }),
                title: action.title, scopes: action.scopes, surfaces: action.surfaces, execution: action.execution,
                dangerLevel: action.dangerLevel, confirmation: action.confirmation, readOnly: action.readOnly, sessionTarget: action.sessionTarget,
                occurrenceId: 'pr54-github-current', executionOrigin });
            clientActionSchemasByQualifiedId.set(`${githubManifest.id}/${action.id}`, {
                inputSchema: action.inputSchema, ...(action.resultSchema ? { outputSchema: action.resultSchema } : {}),
            });
            return [`${githubManifest.id}/${action.id}`, projected];
        }));
        const published = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [githubManifest.id]: { id: githubManifest.id, displayName: 'GitHub',
                version: githubManifest.version, enabled: true, source: { kind: 'local', locator: '/plugins/github' },
                occurrenceId: 'pr54-github-current', executionOrigin, declaresContributionPoints: false } },
            actionsById: githubActions, familiesById: {},
        });
        // Privacy-projected r3 records contain request methods, IDs and timing,
        // but no response bodies; this is not a recorded-response replay.
        // These are explicitly CONSTRUCTED schema-valid HTTP/RPC fixtures;
        // the production Account handler, admission, schemas and Resource stay real.
        const configured = TriageConfiguredSourceInstanceV1Schema.parse({ v: 1,
            instance: { source: input.entryRef.source, sourceInstanceId },
            binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: { service: { pluginId: githubManifest.id, localId: GITHUB_CONNECTED_ACCOUNT_ID }, accountId: 'pr54-fixture' } },
            localInstanceKey: 'github.com', configuration: { v: 1,
                token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: 'happier-dev/triage-qa-sandbox' } }) } });
        const contract = contracts.find(contract => contract.collectionId === 'source-instances')!;
        const encoded = encodePluginCollectionLogicalValueV1({ contract, isValidLogicalValue: compilePluginJsonSchema(contract.schema),
            value: { instanceTag: 'a'.repeat(CORPUS_IDENTITY_TAG_LENGTH), sourceQualifiedId: `${githubManifest.id}/github-forge`,
                lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1, configured }, encryptionMode: 'plain', material: null,
            randomBytes: length => new Uint8Array(length) });
        if (encoded.status !== 'encoded') throw new Error(`Configured source fixture: ${encoded.reason}`);
        const sourceRow = { rowId: encoded.rowId, revision: 1, content: encoded.content, projection: encoded.projection };
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: accountLifetime.scope.serverId },
            accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion,
                declarationTransport: 'http-header-and-socket-auth-v1' },
        } });
        const session = createSessionFixture({ id: sessionId, encryptionMode: 'plain',
            metadata: { machineId: 'provider-machine', path: '/repos/triage-qa-sandbox' } });
        getStorage().setState({ profileScope: accountLifetime.scope, sessionLocalStateScope: accountLifetime.scope,
            sessions: { ...previous.sessions, [sessionId]: session } });
        const counts = new Map<string, number>();
        const count = (key: string) => { counts.set(key, (counts.get(key) ?? 0) + 1); };
        let failRepeatedMachineAdmission: (error: Error) => void = () => {};
        const repeatedMachineAdmission = new Promise<never>((_, reject) => { failRepeatedMachineAdmission = reject; });
        const machineRows = new Map<string, ReturnType<typeof createPlainMachineRowFixture>>();
        network.setHttpResponder(async (url, init) => {
            const path = new URL(String(url)).pathname;
            count(`http:${path}`);
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === `/v2/sessions/${sessionId}`) return Response.json(createPlainSessionByIdResponseFixture(session));
            if (path === '/v1/machines/read-batch') {
                // Test-only escape for the reproduced pre-source admission recursion
                // (2,019 reads in 8.8 seconds), not a product read budget.
                if (counts.get(`http:${path}`) === 32 && !counts.get(`rpc:${RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE}`)) {
                    console.info('PR54 repeated Session admission', JSON.stringify(Object.fromEntries(counts)));
                    failRepeatedMachineAdmission(new Error('Session admission did not converge before the source operation: 32 physical Machine reads'));
                }
                return createMachineReadBatchResponseFixture(init?.body, id => {
                    let row = machineRows.get(id);
                    if (!row) { row = createPlainMachineRowFixture({ id, accountId: accountLifetime.scope.accountId }); machineRows.set(id, row); }
                    return row;
                });
            }
            if (path === '/v1/plugins/data/contract') {
                const { ref } = PluginCollectionContractReadRequestV1Schema.parse(JSON.parse(String(init?.body)));
                const contract = contracts.find(contract => contract.collectionId === ref.collectionId);
                return Response.json(PluginCollectionContractReadResultV1Schema.parse({ access: 'writable', contract }));
            }
            if (path === '/v1/plugins/data/query') {
                const request = PluginCollectionQueryRequestV1Schema.parse(JSON.parse(String(init?.body)));
                count(`collection:${request.collectionId}:${request.indexId}`);
                return Response.json(PluginCollectionQueryResultV1Schema.parse({ rows: request.collectionId === 'source-instances' ? [sourceRow] : [], changeCursor: 1 }));
            }
            if (path === '/v1/plugins/data/get') return Response.json(PluginCollectionGetResultV1Schema.parse({ row: null, absenceEpoch: 0 }));
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        let linked = false;
        let changed: (() => void) | undefined;
        const pendingWatchers = new Map<string, () => void>();
        const githubContributions = normalizedGithub.manifest.contributes.targetedPluginContributions.filter(
            contribution => contribution.target.pluginId === pluginId);
        const targetedActionIds = new Set(githubContributions.flatMap(contribution => Object.values(contribution.operations)));
        const targetedRendererIds = new Set(githubContributions.flatMap(contribution => Object.values(contribution.surfaces ?? {})
            .flatMap(surface => [surface.renderer, ...(surface.fallbackRenderers ?? [])])));
        // Match the daemon producer's requested-target slice, including referenced declarations.
        const targetedResponse = DaemonPluginUiTargetedContributionsReadResponseSchema.parse({
            status: 'sourceDeclarations', pluginId, sourceDeclarations: [{ occurrenceId: 'pr54-github-current',
                sourceCustody: { kind: 'development', registeredRootId: 'pr54-github-root' },
                manifest: { id: githubManifest.id, contributes: {
                    actions: normalizedGithub.manifest.contributes.actions.filter(action => targetedActionIds.has(action.id)),
                    pluginContributionPoints: [], targetedPluginContributions: githubContributions,
                    ui: { renderers: normalizedGithub.manifest.contributes.ui.renderers.filter(renderer => targetedRendererIds.has(renderer.id)) } } } },
                { occurrenceId: 'pr54-triage-machine-current', sourceCustody: { kind: 'development', registeredRootId: 'pr54-triage-root' },
                    manifest: { id: pluginId, contributes: { actions: [], pluginContributionPoints: [], targetedPluginContributions: [], ui: { renderers: [] } } } }],
        });
        const describeResponse = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: published });
        const schemasResponses = new Map([...clientActionSchemasByQualifiedId].map(([id, schemas]) => [id,
            DaemonPluginActionSchemasReadResponseSchema.parse({ ok: true, ...schemas })]));
        const closedResponse = DaemonPluginUiResourceWatchCloseResponseSchema.parse({ ok: true, closed: true });
        daemonRpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
            count(`rpc:${request.method}`);
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return describeResponse;
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return targetedResponse;
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return schemasResponses.get(
                (request.payload as { qualifiedActionId: string }).qualifiedActionId);
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) return DaemonPluginUiResourceWatchOpenResponseSchema.parse({ ok: true,
                subscriptionId: (request.payload as { subscriptionId: string }).subscriptionId });
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT) {
                const subscriptionId = (request.payload as { subscriptionId: string }).subscriptionId;
                return await new Promise(resolve => {
                    const publish = () => resolve(DaemonPluginUiResourceWatchNextResponseSchema.parse({
                        ok: true, status: 'event', event: { version: 1, subscriptionId, kind: 'readInvalidated' } }));
                    pendingWatchers.set(subscriptionId, publish);
                    changed = () => { for (const publish of pendingWatchers.values()) publish(); pendingWatchers.clear(); };
                });
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) return closedResponse;
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                const action = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
                count(`source:${action.qualifiedActionId}`);
                if (action.qualifiedActionId === `${githubManifest.id}/${GITHUB_TRIAGE_ACTION_IDS_V1.linkSession}`) {
                    linked = true; changed?.();
                    return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true,
                        result: TriageSourceLinkSessionResultV1Schema.parse({ status: 'linked' }) });
                }
                if (action.qualifiedActionId === `${githubManifest.id}/${GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks}`) return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
                    ok: true, result: TriageSourceReadSessionLinksResultV1Schema.parse({ kind: 'complete', links: linked ? [{
                        localRef: { kindId: input.entryRef.kindId, collisionScope: input.entryRef.collisionScope, entryId: input.entryRef.entryId },
                        sessionId, linkedAtMs: 1, displayPath: input.display.locator.displayPath, locator: input.display.locator,
                    }] : [] }),
                });
                throw new Error(`Unexpected source Action ${action.qualifiedActionId}`);
            }
            throw new Error(`Unexpected physical RPC ${request.method}`);
        });
        await activation.composition.unload();
        await activation.composition.reconcile([activation.activation]);
        expect(await getServerFeaturesSnapshot({ serverId: accountLifetime.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
        const projection = activation.projection;
        const withdrawProjection = publishCommittedAppShellPluginUiProjection(() => projection);
        // Match the Session SCM mount: Account renderer custody and the
        // Session's Machine describe, whose Resource rows have no Account stamp.
        const triageOrigin = { ...executionOrigin, materializationRef: { ...executionOrigin.materializationRef, pluginId } };
        const machineProjection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({
            ...published,
            installedPackagesById: { ...published.installedPackagesById, [pluginId]: {
                id: pluginId, displayName: PLUGIN_MANIFEST.displayName, version: PLUGIN_MANIFEST.version,
                enabled: true, source: { kind: 'local', locator: '/plugins/triage' },
                occurrenceId: 'pr54-triage-machine-current', executionOrigin: triageOrigin,
            } },
            resourcesById: Object.fromEntries(normalized.manifest.contributes.resources.map(resource => [
                `${pluginId}/${resource.id}`, { id: resource.id, pluginId, resourceKind: resource.kind,
                    occurrenceId: 'pr54-triage-machine-current', executionOrigin: triageOrigin,
                    ...('path' in resource ? { path: resource.path } : {}),
                    ...('scope' in resource ? { scope: resource.scope } : {}),
                    contentType: resource.contentType, execution: resource.execution },
            ])),
        }), 'web', undefined, { resourceDeclarations: 'complete' });
        const controller = createBoundPluginSurfaceController({ facts: {
            pluginId, contributionId: 'scm-pull-request', surfaceId: 'surfacePlacement:happier.triage:scm-pull-request',
            placement: 'sessionPane', platform: 'web', channel: 'internal', sessionId,
            machineId: 'provider-machine', serverId: accountLifetime.scope.serverId,
            occurrenceId: selected.custodyId,
            accountExecutionOrigin: { ...accountLifetime.scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody },
            accountLifetime, interactionEnabled: true, daemonInteractionEnabled: true,
            resourceCapability: { readable: false, dynamic: false }, pluginUiProjection: machineProjection,
        } });
        onTestFinished(() => controller.dispose());
        const resourceStore = controller.resourceStore;
        if (!resourceStore) throw new Error('Expected declared Account Resource store');
        const entry = resourceStore.getEntry('session-links-v1');
        let snapshotPublications = 0;
        let renders = 0;
        const subscribe = (listener: () => void) => entry.subscribe(() => { snapshotPublications++; listener(); }, true);
        const decode = () => {
            const snapshot = entry.getSnapshot();
            if (!snapshot.value) return { error: snapshot.error, pending: snapshot.pending };
            return JSON.parse(new TextDecoder().decode(snapshot.value.bytes));
        };
        const inspector = new Session();
        inspector.connect();
        await inspector.post('Profiler.enable');
        await inspector.post('Profiler.start');
        let unmount = async () => {};
        try {
            await Promise.race([repeatedMachineAdmission, (async () => {
                console.info('PR54 composed phase: Resource.mount');
                const hook = await renderHook(() => { renders++; return React.useSyncExternalStore(subscribe, entry.getSnapshot); });
                unmount = hook.unmount;
                await act(async () => {
                    await vi.waitFor(() => expect(decode()).toMatchObject({ links: [] }));
                    await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
                });
                console.info('PR54 composed observation admission', JSON.stringify({
                    subscription: entry.getSnapshot().subscription, error: entry.getSnapshot().error,
                    baseline: decode(), counts: Object.fromEntries(counts),
                }));
                console.info('PR54 composed phase: link.dispatch');
                await act(async () => {
                    expect(await dispatchPluginResolvedSemanticCommand({ projection, callerPluginId: pluginId,
                        command: { kind: 'executeAction', action: { pluginId, localId }, input },
                        scopedLaunchFacts: { serverId: accountLifetime.scope.serverId, machineId: null, interactionEnabled: true },
                        accountLifetime, scopeIsCurrent: accountLifetime.isCurrent,
                    })).toEqual({ ok: true, result: { v: 1, status: 'linked' } });
                    console.info('PR54 composed phase: Resource.awaitAutomaticRefresh');
                    await vi.waitFor(() => expect(decode()).toMatchObject({ links: [{ entryRef: input.entryRef, sessionId, sourceInstanceId }] }));
                    await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
                });
                const settled = Object.fromEntries(counts);
                await new Promise(resolve => setImmediate(resolve));
                await new Promise(resolve => setImmediate(resolve));
                expect(Object.fromEntries(counts)).toEqual(settled);
                expect(counts.get(`source:${githubManifest.id}/${GITHUB_TRIAGE_ACTION_IDS_V1.linkSession}`)).toBe(1);
                expect(counts.get(`source:${githubManifest.id}/${GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks}`)).toBe(2);
                console.info('PR54 composed settled counts', JSON.stringify({ counts: settled,
                    fixtureBasis: 'constructed schema-valid HTTP/RPC responses; r3 request input preserved' }));
                const stablePublications = snapshotPublications;
                const stableRenders = renders;
                await act(async () => {
                    for (let cursor = 2; cursor <= 25; cursor++) replacePluginAccountAvailabilityProjection({
                        ...availability, snapshot: { ...availability.snapshot, availabilityCursor: cursor },
                    });
                    await new Promise(resolve => setImmediate(resolve));
                    await new Promise(resolve => setImmediate(resolve));
                });
                console.info('PR54 composed cursor-only churn', JSON.stringify({ publications: snapshotPublications - stablePublications,
                    renders: renders - stableRenders, counts: Object.fromEntries(counts) }));
                expect(Object.fromEntries(counts)).toEqual(settled);
                expect(snapshotPublications).toBe(stablePublications);
                expect(renders).toBe(stableRenders);
            })()]);
        } finally {
            await act(async () => { controller.dispose(); await unmount(); });
            const { profile } = await inspector.post('Profiler.stop');
            if (process.env.UNION_CHURN_PROFILE_PATH) {
                const { writeFile } = await import('node:fs/promises');
                await writeFile(process.env.UNION_CHURN_PROFILE_PATH, JSON.stringify(profile));
            }
            inspector.disconnect(); withdrawProjection();
            await activation.composition.unload(); accountLifetime.retire();
            clearPluginAccountAvailabilityProjection();
            getStorage().setState({ sessions: previous.sessions, profileScope: previous.profileScope,
                sessionLocalStateScope: previous.sessionLocalStateScope });
        }
    });

    it.each(['Account', 'daemon'] as const)('compiles only the selected Triage link schemas once across mounted %s dispatches', async placement => {
        const { Session } = await import('node:inspector/promises');
        const { compilePluginJsonSchema } = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const { TriageLinkEntryToSessionInputV1Schema, TriageLinkEntryToSessionActionResultV1Schema,
            TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 } = await import('../../../../../../packages/plugins/triage/src/actions/sessionLinksProtocol');
        const { testkitEntryRef, testkitLocator } = await import('../../../../../../packages/plugins/triage/src/corpus/testkit/observations.test-support');
        const lifetime = clientAccountLifetime();
        if (placement === 'daemon') await publishManageMachine(lifetime.scope.serverId, CLIENT_ACTION_ORIGIN.materializationRef.machineId);
        const pluginId = 'happier.triage';
        const localId = TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1;
        // Real authoring, registration and invocation; the artifact loader is
        // the existing system boundary. No Account storage write is needed to
        // exercise the mounted input/result schema preparation contract.
        const execution = { target: 'account' as const, account: {
            artifactId: CLIENT_ACTION_TARGET.artifactId, exportName: CLIENT_ACTION_TARGET.exportName,
        } };
        const received: unknown[] = [];
        const plugin = definePlugin({ id: pluginId, version: '1.2.3', actions: {
            [localId]: { title: 'Link entry', surfaces: ['ui', 'plugin'], dangerLevel: 'safe', execution,
                inputSchema: TriageLinkEntryToSessionInputV1Schema,
                resultSchema: TriageLinkEntryToSessionActionResultV1Schema,
                run: async value => { received.push(value); return { v: 1 as const, status: 'linked' as const }; },
            },
            unrelated: { title: 'Unrelated', surfaces: ['ui'], dangerLevel: 'safe', execution,
                inputSchema: defineProtocolObject({ mountedUnrelatedSchemaProbe: defineProtocolString() }, { policy: 'closed' }),
                run: async () => null,
            },
        } });
        const activation = createClientActionActivation({ pluginId, localId, accountPlacement: true,
            accountLifetime: lifetime, accountManifest: plugin.manifest,
            accountActivate: plugin.activateAccount,
        });
        await activation.composition.unload();
        expect((await activation.composition.reconcile([activation.activation])).map(attempt => attempt.result)).toEqual([{ ok: true }]);
        if (placement === 'daemon') {
            // The app entry owns loading the real sync runtime; its public
            // facade no longer initializes it as an import side effect.
            await import('@/sync/syncEngine');
            const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
            const { createSessionReadBatchFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
            const session = createSessionFixture({ id: 'linked-session', encryptionMode: 'plain',
                metadata: { machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, path: '/example/repository' } });
            network.setHttpResponder(createSessionReadBatchFetchBoundary(async (url, init) => new URL(String(url)).pathname === '/v2/sessions/linked-session'
                ? Response.json(createPlainSessionByIdResponseFixture(session))
                : createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init)));
            clientActionSchemasByQualifiedId.set(`${pluginId}/${localId}`, {
                // Keep this cold probe distinct from the preceding Account
                // schema: the compiler now reuses equal-content validators.
                inputSchema: { ...TriageLinkEntryToSessionInputV1Schema.jsonSchema, title: 'Mounted daemon Triage link cold probe' },
                outputSchema: TriageLinkEntryToSessionActionResultV1Schema.jsonSchema,
            });
            daemonRpc.mockImplementation(async request => answerActionSchemasRead(request) ?? {
                ok: true, result: { v: 1, status: 'linked' },
            });
        }
        let unrelatedSchemaReads = 0;
        const unrelated = activation.projection.actionsById[`${pluginId}/unrelated`]!;
        const unrelatedDeclaration = unrelated.accountActionDeclaration!;
        const selectedAction = placement === 'Account' ? activation.action : {
            ...resolveDaemonTargetAction({ pluginId, localId }),
            sessionTarget: { field: 'sessionId', cardinality: 'one' as const },
        };
        const projection = { ...activation.projection, actionsById: { ...activation.projection.actionsById,
            [`${pluginId}/${localId}`]: selectedAction,
            [`${pluginId}/unrelated`]: { ...unrelated, accountActionDeclaration: new Proxy(unrelatedDeclaration, {
                get(target, property, receiver) {
                    if (property === 'inputSchema' || property === 'resultSchema') unrelatedSchemaReads += 1;
                    return Reflect.get(target, property, receiver);
                },
            }) },
        } };
        const hook = await renderHook(() => useBoundPluginSurfaceController({ facts: {
            pluginId, contributionId: 'session-links', surfaceId: 'link-schema-cost',
            placement: 'appSurface', platform: 'web', channel: 'internal',
            machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, serverId: lifetime.scope.serverId,
            occurrenceId: 'requester-current', executionOrigin: clientActionExecutionOrigin(pluginId),
            accountLifetime: lifetime, interactionEnabled: true, daemonInteractionEnabled: placement === 'daemon',
            actionInputSelectionFactsKey: createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: pluginId }),
            pluginUiProjection: projection,
            resolveContributedAction: identity => projection.actionsById[`${identity.pluginId}/${identity.localId}`] ?? null,
        } }));
        const inspector = new Session();
        const scripts = new Set<string>();
        inspector.connect();
        inspector.on('Debugger.scriptParsed', ({ params }) => scripts.add(params.scriptId));
        const compilationCounts: number[] = [];
        const schemaCompilationCounts: { input: number; result: number; unrelated: number }[] = [];
        const inputPreparationMs: number[] = [];
        const dispatchMs: number[] = [];
        try {
            await inspector.post('Debugger.enable');
            await inspector.post('Profiler.enable');
            await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
            unrelatedSchemaReads = 0;
            for (const entryId of ['54', '55', '56']) {
                await inspector.post('Profiler.takePreciseCoverage');
                scripts.clear();
                await inspector.post('Profiler.start');
                const started = performance.now();
                const result = await hook.getCurrent().dispatchAction({ pluginId, localId }, {
                    v: 1, sessionId: 'linked-session', entryRef: testkitEntryRef({ entryId }),
                    display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
                });
                dispatchMs.push(performance.now() - started);
                expect(result).toEqual({ v: 1, status: 'linked' });
                const { profile } = await inspector.post('Profiler.stop');
                const byId = new Map(profile.nodes.map(node => [node.id, node]));
                const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(child => [child, node.id] as const)));
                inputPreparationMs.push((profile.samples ?? []).reduce((total, sample, index) => {
                    for (let id: number | undefined = sample; id !== undefined; id = parents.get(id)) {
                        const frame = byId.get(id)?.callFrame;
                        if (frame?.functionName === 'prepareInputSchemas') {
                            return total + (profile.timeDeltas?.[index] ?? 0) / 1000;
                        }
                    }
                    return total;
                }, 0));
                const coverage = await inspector.post('Profiler.takePreciseCoverage');
                const compiler = coverage.result.find(script => script.functions.some(fn => fn.functionName === 'createAjv'));
                compilationCounts.push(compiler?.functions.filter(fn => fn.functionName === 'createAjv')
                    .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0) ?? 0);
                const generatedSources = await Promise.all([...scripts].map(async scriptId => (
                    await inspector.post('Debugger.getScriptSource', { scriptId })
                ).scriptSource));
                schemaCompilationCounts.push({
                    input: generatedSources.filter(source => source.includes('function validate')
                        && source.includes('entryRef') && source.includes('sessionId') && source.includes('sourceInstanceId')).length,
                    result: generatedSources.filter(source => source.includes('function validate')
                        && source.includes('data.status') && !source.includes('entryRef')).length,
                    unrelated: generatedSources.filter(source => source.includes('function validate')
                        && source.includes('mountedUnrelatedSchemaProbe')).length,
                });
            }
            console.info('mounted Triage link schema cost', JSON.stringify({ placement, compilationCounts, schemaCompilationCounts,
                inputPreparationMs, dispatchMs, unrelatedSchemaReads }));
            await inspector.post('Profiler.takePreciseCoverage');
            expect(await hook.getCurrent().dispatchAction({ pluginId, localId }, {
                v: 2, sessionId: 'linked-session', entryRef: testkitEntryRef({ entryId: '57' }),
                display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
            })).toMatchObject({ code: 'unavailable', diagnostics: ['plugin_action_input_schema_invalid'] });
            const invalidInputCoverage = await inspector.post('Profiler.takePreciseCoverage');
            expect(invalidInputCoverage.result.flatMap(script => script.functions).filter(fn => fn.functionName === 'createAjv')
                .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0)).toBe(0);
            // V8 omits unexecuted scripts. A genuine fresh compile outside the
            // measured dispatches proves that zero is an observed cost rather
            // than a broken detector or an unrelated script URL convention.
            await inspector.post('Profiler.takePreciseCoverage');
            expect(compilePluginJsonSchema({ type: 'null', title: `Fresh mounted schema cost control: ${placement}` })(null)).toBe(true);
            const control = await inspector.post('Profiler.takePreciseCoverage');
            expect(control.result.flatMap(script => script.functions).filter(fn => fn.functionName === 'createAjv')
                .reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0)).toBeGreaterThan(0);
            if (placement === 'Account') expect(received).toHaveLength(3);
            else expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toHaveLength(3);
            expect(unrelatedSchemaReads).toBe(0);
            expect(schemaCompilationCounts.reduce((total, counts) => total + counts.input, 0)).toBe(1);
            expect(schemaCompilationCounts.reduce((total, counts) => total + counts.result, 0)).toBeLessThanOrEqual(1);
            expect(schemaCompilationCounts.map(counts => counts.unrelated)).toEqual([0, 0, 0]);
            expect(compilationCounts.slice(1)).toEqual([0, 0]);
            expect(compilationCounts[0]).toBeLessThanOrEqual(1);
        } finally {
            await inspector.post('Profiler.stopPreciseCoverage');
            await inspector.post('Profiler.disable');
            await inspector.post('Debugger.disable');
            inspector.disconnect();
            await hook.unmount();
            await activation.composition.unload();
            lifetime.retire();
        }
    });

    it('matches the selected Database operand through the client dispatcher', async () => {
        const home = rpcHomes.get('server-client-action')!;
        const lifetime = clientAccountLifetime(resolveServerProfileScopeIdForIdentifier(home.id));
        const target = DatabaseManualTargetV1Schema.parse({ kind: 'manual', accountId: lifetime.scope.accountId,
            workspace: { serverId: home.serverIdentityId, machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
                workspaceId: 'database-workspace', rootPath: '/example/repository' },
            installationId: 'database-installation', projectKey: 'database-project', savedSecretId: 'selected-secret' });
        const selected = readAutomationDatabaseSubjectV1(home.serverIdentityId, target);
        const neighbor = readAutomationDatabaseSubjectV1(home.serverIdentityId, { ...target, savedSecretId: 'neighbor-secret' });
        if (!selected.ok || !neighbor.ok) throw new Error('Canonical Database subject unavailable');
        let effects = 0;
        const settled: string[][] = [];
        const activation = createClientActionActivation({ pluginId: DATABASE_PLUGIN_ID_V1,
            localId: databaseActionLocalIdV1(DATABASE_TARGETS_FORGET_ACTION_ID_V1), accountLifetime: lifetime,
            dangerLevel: 'writesLocal', confirmationWhen: { presentUserUi: false }, surfaces: ['ui'],
            inputSchema: DatabaseTargetsForgetInputV1ProtocolSchema.jsonSchema,
            handler: async () => { effects++; return { ok: true }; } });
        const port = createActionAutomationPortV1({ accountId: lifetime.scope.accountId,
            seed: async () => ({ v: 1, rows: [selected.subject, neighbor.subject].map((subject, index) => ({
                automationId: index === 0 ? 'selected-database' : 'neighbor-database', triggerId: 'after', triggerRevision: 1,
                workflowId: 'workflow', workflowRevision: 1, ownerAccountId: lifetime.scope.accountId,
                actionIds: [DATABASE_TARGETS_FORGET_ACTION_ID_V1], phase: 'after' as const,
                ...projectAutomationSubjectStructuralV1(subject),
            })) }),
            settle: async ({ selection }) => { settled.push(selection.after.map(row => row.automationId)); } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
        try {
            expect((await activation.composition.reconcile([activation.activation])).map(attempt => attempt.result)).toEqual([{ ok: true }]);
            const outcome = await dispatchPluginSurfaceAction({
                action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: activation.action.id }, input: { target },
                clientAction: {}, pluginUiProjection: activation.projection,
                resolveContributedAction: resolveExactClientAction(activation.action), actionAccountLifetime: lifetime,
                hostAction: { execute: executor.execute, context: {
                    surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
                    serverIdentityId: home.serverIdentityId, runtimeAccountId: lifetime.scope.accountId,
                    defaultSessionMachineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
                    actionRequestId: 'database-forget', actionAutomationPort: port,
                } },
            });
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { ok: true } });
            expect(effects).toBe(1);
            expect(settled).toEqual([['selected-database']]);
        } finally { port.dispose(); await activation.composition.unload(); lifetime.retire(); }
    });

    it.each([
        { name: 'conditional', readOnly: { op: 'eq', path: 'mode', value: 'preview' } as const, modes: ['preview', 'save'], expected: 1 },
        { name: 'read', readOnly: true as const, modes: ['save'], expected: 0 },
        { name: 'effect', readOnly: false as const, modes: ['save'], expected: 1 },
        { name: 'recursive', readOnly: false as const, modes: ['outer'], expected: 2 },
    ])('settles actual UI-hosted $name plugin effects from the admitted prepared input', async ({ name, readOnly, modes, expected }) => {
        const home = rpcHomes.get('server-client-action')!;
        const lifetime = clientAccountLifetime(resolveServerProfileScopeIdForIdentifier(home.id));
        const events: ActionSettlementV1[] = [];
        let effects = 0;
        const activation = createClientActionActivation({ pluginId: `acme.ui-effect-${name}`, localId: 'effect',
            accountPlacement: true, invokingUi: true, accountLifetime: lifetime, readOnly, surfaces: ['ui', 'plugin'],
            inputSchema: { type: 'object', properties: { mode: { type: 'string' } }, additionalProperties: false },
            accountHandler: async (input, context) => {
                effects += 1;
                if (name === 'recursive' && input && typeof input === 'object' && !Array.isArray(input) && input.mode === 'outer') {
                    await context.services.actions.execute({ pluginId: `acme.ui-effect-${name}`, localId: 'effect' }, { mode: 'inner' });
                }
                return input;
            } });
        const identity = { pluginId: activation.action.pluginId, localId: activation.action.id };
        const actionId = formatQualifiedPluginActionId(identity);
        const notice = { code: 'action_automation_skipped', reason: 'machine_required', automationId: 'automation',
            triggerId: 'after', workflowId: 'workflow' } as const;
        const port = createActionAutomationPortV1({ accountId: lifetime.scope.accountId,
            seed: async () => ({ v: 1, rows: [{ automationId: 'automation', triggerId: 'after', triggerRevision: 1,
                workflowId: 'workflow', workflowRevision: 1, ownerAccountId: lifetime.scope.accountId,
                actionIds: [actionId], phase: 'after' }] }),
            settle: async request => { events.push(request.event); return [notice]; } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
        try {
            expect((await activation.composition.reconcile([activation.activation])).map(attempt => attempt.result)).toEqual([{ ok: true }]);
            for (const mode of modes) {
                const result = await dispatchPluginSurfaceAction({ action: identity, input: { mode }, clientAction: {},
                    pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action),
                    actionAccountLifetime: lifetime, hostAction: { execute: executor.execute, context: {
                        surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
                        serverIdentityId: home.serverIdentityId, runtimeAccountId: lifetime.scope.accountId,
                        actionRequestId: `${name}-${mode}`, actionAutomationPort: port,
                    } } });
                expect(result).toMatchObject({ ok: true, result: { mode } });
                if (name !== 'read' && mode !== 'preview') expect(result).toMatchObject({ automationNotices: [notice] });
            }
            expect(effects).toBe(name === 'recursive' ? 2 : modes.length);
            expect(events).toHaveLength(expected);
            expect(events.every(event => event.actionId === actionId && event.status === 'succeeded')).toBe(true);
            if (name === 'recursive') expect(new Set(events.map(event => event.requestId)).size).toBe(2);
        } finally { port.dispose(); await activation.composition.unload(); lifetime.retire(); }
    });

    it.each([
        { state: 'failed', entry: 'UI' }, { state: 'succeeded', entry: 'UI' },
        { state: 'failed', entry: 'Voice' }, { state: 'succeeded', entry: 'Voice' },
    ] as const)('honors a $state admitted before-wait for a $entry-hosted contributed effect', async ({ state, entry }) => {
        const home = rpcHomes.get('server-client-action')!;
        const lifetime = clientAccountLifetime(resolveServerProfileScopeIdForIdentifier(home.id));
        let effects = 0;
        const events: ActionSettlementV1[] = [];
        let stored: ApprovalRequest | null = null;
        const activation = createClientActionActivation({ pluginId: `acme.ui-before-${entry.toLowerCase()}-${state}`, localId: 'effect',
            accountPlacement: true, invokingUi: true, accountLifetime: lifetime, readOnly: false, surfaces: ['ui', 'voice'],
            inputSchema: { type: 'object', additionalProperties: false },
            accountHandler: async () => { effects++; return { applied: true }; } });
        const identity = { pluginId: activation.action.pluginId, localId: activation.action.id };
        const actionId = formatQualifiedPluginActionId(identity);
        const rows = [{ automationId: 'automation', triggerId: 'before', triggerRevision: 1,
                workflowId: 'workflow', workflowRevision: 1, ownerAccountId: lifetime.scope.accountId,
                actionIds: [actionId], phase: 'before', mode: 'wait', onFailure: 'refuse' },
                { automationId: 'automation', triggerId: 'after', triggerRevision: 1, workflowId: 'workflow',
                    workflowRevision: 1, ownerAccountId: lifetime.scope.accountId, actionIds: [actionId], phase: 'after' }] as const;
        const { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } = await import('@happier-dev/protocol/actions/executor/actionAutomationAdmission');
        network.setHttpResponder(async (url, init) => new URL(String(url)).pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1
            ? Response.json({ v: 1, rows })
            : createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init));
        const port = createActionAutomationPortV1({ accountId: lifetime.scope.accountId,
            seed: async () => ({ v: 1, rows }),
            start: async ({ selected }) => ({ runs: selected.map(row => ({ automationId: row.automationId,
                triggerId: row.triggerId, runId: `${state}-run` })), notices: [] }),
            settle: async ({ event }) => { events.push(event); } });
        const actionAutomations = { ...port, wait: async () => ({ state, ...(state === 'failed' ? { errorCode: 'step_failed' } : {}) }) };
        const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction, readProjection: () => activation.projection, readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ actionAutomations,
            listContributedActionDefinitions: () => [projectedActionToDefinition(activation.action, activation.projection)],
            invokeContributedAction: request => executeCurrentUiContextContributedAction(request, {
                execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
            }),
            approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'before-ui-approval' }; },
            approvalsGet: async () => stored,
            approvalsUpdate: async ({ request }) => { stored = request; return { ok: true }; },
            isApprovalExecutionOriginCurrent: async () => true,
        }));
        try {
            expect((await activation.composition.reconcile([activation.activation])).map(attempt => attempt.result)).toEqual([{ ok: true }]);
            const hostAction = { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
                surface: entry === 'UI' ? 'ui' as const : 'voice' as const,
                authority: entry === 'UI' ? 'present_user' as const : 'account_automation' as const,
                ...(entry === 'Voice' ? { externalActionTarget: { kind: 'machine' as const, machineId: 'machine-client-action' } } : {}),
                serverId: lifetime.scope.serverId, serverIdentityId: home.serverIdentityId,
                runtimeAccountId: lifetime.scope.accountId, actionRequestId: 'ui-before-original', actionAutomationPort: actionAutomations,
            } };
            const { createAppShellPluginUiInvocationHost } = await import('@/components/appShell/plugins/pluginUiInvocationHost');
            const operation = entry === 'UI'
                ? dispatchPluginSurfaceAction({ action: identity, input: {}, clientAction: {},
                    pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action),
                    actionAccountLifetime: lifetime, hostAction })
                : createAppShellPluginUiInvocationHost({ pluginId: identity.pluginId, contributionId: 'conversation',
                    occurrenceId: activation.action.occurrenceId, machineId: 'machine-client-action', serverId: lifetime.scope.serverId,
                    signal: new AbortController().signal, isCurrent: () => true, pluginUiProjection: activation.projection,
                    resolveContributedAction: resolveExactClientAction(activation.action), hostAction,
                }).executeAction(identity, {});
            if (entry === 'Voice' && state === 'failed') {
                await expect(operation).rejects.toMatchObject({ code: 'action_interception_rejected' });
                expect(effects).toBe(0);
                expect(events).toMatchObject([{ actionId, status: 'failed', errorCode: 'action_interception_rejected' }]);
                return;
            }
            const result = await operation;
            if (state === 'failed') {
                expect(effects, 'A failed before check must refuse the UI handler before its native effect').toBe(0);
                expect(result, JSON.stringify(result)).toMatchObject({ ok: false, reason: 'action_interception_rejected', effectAttempted: false });
                expect(events).toMatchObject([{ actionId, status: 'failed', errorCode: 'action_interception_rejected' }]);
            } else {
                expect(result, JSON.stringify(result)).toMatchObject(entry === 'UI' ? { ok: true, result: { applied: true } } : { applied: true });
                expect(effects, 'A successful before check must resume the admitted UI handler once').toBe(1);
                expect(events).toMatchObject([{ actionId, status: 'succeeded' }]);
            }
        } finally { unregister(); port.dispose(); await activation.composition.unload(); lifetime.retire(); }
    });

    it('dispatches ordinary daemon and client Actions from the real caller-scoped producer', async () => {
        const { normalizePluginManifestV2 } = await import('../../../../../cli/src/plugins/manifest/normalize');
        const { projectLoadedPluginContributes } = await import('../../../../../cli/src/plugins/projection/registry/fullProjection');
        const { createResolvedContributionRegistry } = await import('../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry');
        const { buildPluginMountedActionsProjectionV2 } = await import('../../../../../cli/src/plugins/projection/registry/projection/v2');
        const { createPluginRuntimeOccurrenceId } = await import('../../../../../cli/src/plugins/runtime/runtimeSlots');
        const { DaemonContributionRegistryProjectionDescribeResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const pluginId = 'acme.cold-mounted';
        const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
        const clientHandler = vi.fn(async () => ({ selectedView: 'A' }));
        const activation = createClientActionActivation({ pluginId, localId: 'select-view', occurrenceId, handler: clientHandler });
        const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: '1.2.3', displayName: 'Cold caller',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { actions: [
                { id: 'inspect', title: 'Inspect', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                    dangerLevel: 'safe', execution: { target: 'daemon' } },
                { id: activation.action.id, title: 'Select view', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                    dangerLevel: 'safe', execution: activation.action.execution },
            ] } });
        const resolved = projectLoadedPluginContributes({ provenance: 'external', loadResult: { diagnosticsByPluginId: {}, loadedPlugins: [{
            pluginId, manifest, pluginRootPath: `/plugins/${pluginId}`, manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
            daemonEntryPath: null, devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: `/plugins/${pluginId}`, trustPolicy: 'local_trusted', installPolicy: 'link' },
        }] } });
        const registry = createResolvedContributionRegistry({ ...resolved, occurrenceIdsByPluginId: { [pluginId]: occurrenceId } });
        const produced = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projection: buildPluginMountedActionsProjectionV2({ registry, generation: CLIENT_ACTION_GENERATION,
                actions: [], callerPluginIds: [pluginId] }),
        }).projection;
        expect(Object.keys(produced.actionsById)).toEqual([`${pluginId}/inspect`, `${pluginId}/select-view`]);
        // Keep the harness's admitted Machine/policy and installed-byte custody,
        // but take every Action declaration from the real cold producer.
        const actionsById = Object.fromEntries(Object.entries(produced.actionsById).map(([key, declaration]) => [key, {
            ...activation.projection.actionsById[`${pluginId}/select-view`], ...declaration,
        }]));
        const projection = { ...activation.projection, actionsById };
        await activation.composition.unload();
        try {
            expect((await activation.composition.reconcile([activation.activation])).map(attempt => attempt.result)).toEqual([{ ok: true }]);
            const dispatch = (localId: string) => dispatchPluginSurfaceAction({ action: { pluginId, localId }, input: {},
                clientAction: {}, pluginUiProjection: projection,
                resolveContributedAction: identity => projection.actionsById[`${identity.pluginId}/${identity.localId}`] ?? null,
                contributedAction: { machineId: 'machine-client-action', serverId: 'server-client-action',
                    execute: async () => ({ supported: true, result: { ok: true, result: { inspected: true } } }) },
            });
            expect(await dispatch('select-view')).toEqual({ ok: true, result: { selectedView: 'A' } });
            expect(clientHandler).toHaveBeenCalledTimes(1);
            expect(await dispatch('inspect')).toEqual({ ok: true, result: { inspected: true } });
        } finally { await activation.composition.unload(); }
    });
});

describe('Board task controls through the contributed Action front door', () => {
    it('resolves a Work Item through its Account-scoped read Action services', async () => {
        const { readBoardTaskItems } = await import('@/components/boards/model/boardTaskItems');
        const { createPluginUiClientExecutableRegistrationIndex } = await import('@/components/plugins/reactNative/clientExecutableContributions');
        const [{ PluginContributesV2Schema}, { buildWorkBoardItemKeyV1}] = await Promise.all([import('@happier-dev/protocol/plugins/contributions/v2'), import('@happier-dev/protocol/boards/workBoardV1')]);
        const lifetime = clientAccountLifetime();
        const pluginId = 'acme.work-item-context';
        const client = { artifactId: 'work-items', exportName: 'activate' };
        const plugin = definePlugin({ id: pluginId, version: '1.2.3',
            workItems: { 'work-items': { client, platforms: ['web'] } },
            actions: { 'read-task': { title: 'Read task', surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
                execution: { target: 'account', account: { artifactId: CLIENT_ACTION_TARGET.artifactId,
                    exportName: CLIENT_ACTION_TARGET.exportName } },
                inputSchema: defineProtocolObject({}, { policy: 'closed' }),
                run: async () => ({ title: 'Account-owned task' }),
            } },
        });
        let reads = 0;
        const account = createClientActionActivation({ pluginId, localId: 'read-task', accountPlacement: true,
            accountLifetime: lifetime, accountManifest: plugin.manifest, surfaces: ['plugin'], readOnly: true,
            accountHandler: async () => { reads += 1; return { title: 'Account-owned task' }; } });
        await account.composition.unload();
        const activation = await account.composition.reconcile([account.activation]);
        expect(activation.map(attempt => attempt.result)).toEqual([{ ok: true }]);
        const index = createPluginUiClientExecutableRegistrationIndex();
        const contributes = PluginContributesV2Schema.parse(plugin.manifest.contributes);
        const executionOrigin = clientActionExecutionOrigin(pluginId);
        const controller = new AbortController();
        const scope = index.createScope({ pluginId, contributes, target: { ...client, platform: 'web' },
            executionOrigin, occurrenceId: 'current', pluginVersion: '1.2.3', accountLifetime: lifetime,
            authority: { serverId: lifetime.scope.serverId, machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId },
            lifecycle: { signal: controller.signal, isCurrent: lifetime.isCurrent } });
        const failures: unknown[] = [];
        scope.api.workItems.register('work-items', {
            async resolve({ itemIds }, context) {
                try {
                    expect(context.accountScope).toEqual(lifetime.scope);
                    const value: unknown = await context.services.actions.execute({ pluginId, localId: 'read-task' }, {});
                    if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string') {
                        throw new Error('Account read returned no task title');
                    }
                    const title = value.title;
                    return Object.fromEntries(itemIds.map(id => [id, { title, category: 'unstarted' as const, linkedSessions: [] }]));
                } catch (error) { failures.push(error); throw error; }
            },
        });
        scope.commit();
        const source = { id: `${pluginId}/work-items`, pluginId, pluginVersion: '1.2.3', occurrenceId: 'current',
            definition: contributes.workItems[0]!, executionOrigin };
        const ref = { kind: 'task' as const, pluginId, qualifiedId: { serverId: lifetime.scope.serverId, id: 'task' } };
        try {
            const result = await readBoardTaskItems({ serverId: lifetime.scope.serverId, refs: [ref], sessions: [],
                sources: [source], platform: 'web', reader: index, signal: controller.signal, pluginUiProjection: account.projection });
            expect(failures).toEqual([]);
            expect(result.complete).toBe(true);
            expect(result.items.get(buildWorkBoardItemKeyV1(ref))?.title).toBe('Account-owned task');
            expect(reads).toBe(1);
        } finally {
            controller.abort(); await scope.unwind(); await account.composition.unload(); lifetime.retire();
        }
    });

    it('renders an external live item and dispatches its declared transition as the viewer under normal policy', async () => {
        const { renderScreen, standardCleanup } = await import('@/dev/testkit');
        const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { BoardCardView } = await import('@/components/boards/cards/BoardCardView');
        const { useBoardTaskItems, BoardTaskRefreshContext } = await import('@/components/boards/model/useBoardTaskItems');
        const { buildBoardCards } = await import('@/components/boards/model/boardCards');
        const [{ PluginContributesV2Schema}, { buildWorkBoardItemKeyV1}] = await Promise.all([import('@happier-dev/protocol/plugins/contributions/v2'), import('@happier-dev/protocol/boards/workBoardV1')]);
        const fixture = createExternalWorkItemsPluginFixture({ issue: { title: 'Fix checkout', category: 'unstarted', linkedSessions: [],
            transitions: [{ id: 'start', label: 'Start work', category: 'started' }] } });
        const producer = await createPluginTestkit({ manifest: fixture.plugin.manifest, module: fixture.plugin });
        const pluginId = fixture.plugin.manifest.id;
        const baseLifetime = clientAccountLifetime();
        const serverId = rpcHomes.get('server-client-action')!.id;
        const lifetime = { ...baseLifetime, scope: { ...baseLifetime.scope, serverId } };
        const executionOrigin = clientActionExecutionOrigin(pluginId);
        const contributes = PluginContributesV2Schema.parse(fixture.plugin.manifest.contributes);
        const hostOrigin = { ...CLIENT_ACTION_HOST_ORIGIN, serverId, executionOrigin };
        const source = { id: `${pluginId}/work-items`, pluginId, pluginVersion: '1.0.0', occurrenceId: 'current',
            definition: contributes.workItems[0]!, executionOrigin, hostOrigin };
        const declaration = fixture.plugin.manifest.contributes!.actions![0]!;
        clientActionSchemasByQualifiedId.set(`${pluginId}/transition`, { inputSchema: declaration.inputSchema ?? {} });
        const action = { ...PluginProjectedActionV2Schema.parse({ id: declaration.id, title: declaration.title,
            scopes: declaration.scopes, surfaces: declaration.surfaces, execution: declaration.execution,
            dangerLevel: declaration.dangerLevel, confirmation: declaration.confirmation, confirmationWhen: declaration.confirmationWhen,
            pluginId, occurrenceId: 'current', available: true }),
            executionOrigin, hostOrigin: { ...CLIENT_ACTION_HOST_ORIGIN, serverId, executionOrigin } };
        const path = 'react-native/tasks/entry.cjs.bundle';
        const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ ...CLIENT_ACTION_ARTIFACT_GRAPH,
            artifactId: fixture.client.artifactId, executable: { exports: [fixture.client.exportName] }, entry: path,
            files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({ ...file, relativePath: path })) });
        const bundleId = `reactNativeBundle:${pluginId}:workItems/work-items`;
        const projection: PluginUiProjectionModel = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            installedPackagesById: { [pluginId]: PluginProjectionInstalledPackageV2Schema.parse({ id: pluginId,
                displayName: 'External tasks', version: '1.0.0', enabled: true, source: { kind: 'localPath', locator: pluginId } }) },
            workItemsById: { [source.id]: source }, actionsById: { [`${pluginId}/transition`]: action },
            reactNativeBundlesById: { [bundleId]: { id: bundleId, pluginId, occurrenceId: 'current',
                contributionKind: 'reactNativeBundle', contributionId: 'workItems/work-items', generatedOwnerKind: 'clientContribution',
                artifactGraph: graph, hostOrigin, runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' },
                    cacheIdentity: { artifactDigest: graph.digest } } } } };
        const composition = getInstalledPluginUiClientExecutableComposition();
        const cache = createPluginReactNativeBundleCache();
        const resolved = resolveProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: 'web' });
        expect(resolved).toHaveLength(1);
        for (const entry of resolved) cache.putInstalledArtifact({ identity: entry.cacheIdentity,
            bytes: new Uint8Array([47, 47, 32, 102, 105, 120, 116, 117, 114, 101]), format: 'plainJs' });
        const activations = await composition.reconcile(resolved.map(entry => ({ ...entry, cache, identity: entry.cacheIdentity,
            accountLifetime: lifetime, isCurrent: lifetime.isCurrent, backend: { backendId: 'commonJs' as const, available: true,
                // Installed bytes are the external loader boundary; real source registration stays below it.
                loadInstalledBundle: async () => (api: PluginClientApi) => api.workItems.register('work-items', {
                    resolve: fixture.runtime.resolve, findLinked: fixture.runtime.findLinked,
                }),
            } })));
        expect(activations.map(attempt => attempt.result)).toEqual([{ ok: true }]);
        const ref = { kind: 'task' as const, pluginId, qualifiedId: { serverId, id: 'issue' } };
        const refs = [ref];
        const key = buildWorkBoardItemKeyV1(ref);
        function LiveTask() {
            const result = useBoardTaskItems(serverId, refs, undefined);
            const card = buildBoardCards([{ key, ref, available: true, picked: true, sourced: false }], {
                nowMs: Date.now(), task: () => result.items.get(key) ?? null, session: () => null,
                workflow: () => null, workflowRun: () => null, machine: () => null,
                accountScopedHome: () => true, machineSessionCounts: new Map() })[0]!;
            return React.createElement(BoardTaskRefreshContext.Provider, { value: result.refresh }, React.createElement(BoardCardView, { card }));
        }
        const owner: AppShellPluginUiProjectionValue = { pluginUiProjection: projection, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId, platform: 'web', accountLifetime: lifetime,
            clientExecutableActivation: { status: 'ready' }, reloadConnectedAccountProjection: () => {}, reloadClientExecutables: () => {} };
        const render = (value = owner) => React.createElement(AppShellPluginUiProjectionValueProvider, { value }, React.createElement(LiveTask));
        const requests: ReturnType<typeof DaemonPluginStructuredMessageActionExecuteRequestSchema.parse>[] = [];
        daemonRpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) return answerActionSchemasRead(request);
            const wire = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
            requests.push(wire);
            return { ok: true, result: await producer.invokeAction('transition', wire.input, { surface: wire.executionSurface }) };
        });
        const previous = getStorage().getState();
        try {
            const screen = await renderScreen(render());
            const transitionId = `board-card:${key}:transition:start`;
            const control = screen.findHostByTestId(transitionId);
            expect(control).not.toBeNull();
            await act(async () => control!.props.onPress());
            expect(requests).toHaveLength(1);
            expect(requests[0]).toMatchObject({ qualifiedActionId: `${pluginId}/transition`, executionSurface: 'ui',
                input: { serverId, itemId: 'issue', transitionId: 'start' } });
            expect(requests[0]!.invocation).toBeUndefined();
            expect(screen.findHostByTestId(`board-card:${key}:word`)?.props.children).toBe('Start work');
            expect(screen.findHostByTestId(transitionId)?.props.disabled).toBe(false);
            const { transitionAction: _transitionAction, ...readOnly } = source.definition;
            await screen.update(render({ ...owner, pluginUiProjection: { ...projection,
                workItemsById: { [source.id]: { ...source, definition: readOnly } } } }));
            expect(screen.findHostByTestId(transitionId)).toBeNull();
            expect(screen.getTextContent()).toContain('Fix checkout');
            await screen.update(render());
            getStorage().setState(state => ({ settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: { [`${pluginId}/actions/transition`]: { approvalRequiredSurfaces: ['ui'] } } }) } }));
            // The existing native confirmation boundary cancels; no provider write follows.
            await act(async () => screen.findHostByTestId(transitionId)!.props.onPress());
            expect(requests).toHaveLength(1);
            expect(screen.findHostByTestId(transitionId)?.props.disabled).toBe(false);
            getStorage().setState(state => ({ settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: { [`${pluginId}/actions/transition`]: { enabled: false } } }) } }));
            await act(async () => screen.findHostByTestId(transitionId)!.props.onPress());
            expect(requests).toHaveLength(1);
            getStorage().setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {} }) } }));
            await act(async () => screen.findHostByTestId(transitionId)!.props.onPress());
            expect(requests).toHaveLength(2);
            lifetime.retire();
            await act(async () => screen.findHostByTestId(transitionId)?.props.onPress());
            expect(requests).toHaveLength(2);
        } finally {
            await standardCleanup(); await composition.unload(); await producer.dispose();
            getStorage().setState(previous);
        }
    });
});

describe('Account Action placement through the executable dispatcher', () => {
    it('opens native Review proposals across the strict plugin result boundary', async () => {
        const comment = ReviewCommentV1Schema.parse({
            v: 1, id: 'proposal-1', accountId: 'account-1', projectId: undefined,
            workspace: { machineId: 'machine-1', path: '/repo' }, sessionId: 'session-1',
            anchor: { kind: 'file', filePath: 'src/gateway.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
            body: 'Proposed reply', bodyVersion: 1, edits: [], author: { kind: 'user', userId: 'account-1' },
            state: 'proposed', flags: {}, dispositions: {}, threadId: 'proposal-1', transitions: [],
            createdAt: 1, updatedAt: 1, serverRevision: 1,
        });
        // Substitute only the Reviews HTTP port; Action parsing, dispatch and both host envelopes remain real.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            reviewCommentAction: async () => ({ items: [comment], cursor: null }),
        }));
        const api = createPluginSurfaceActionHostApi({ surfaceContext: surfaceContext(),
            callerBinding: mountedCallerBinding(),
            hostAction: { execute: executor.execute, context: { serverId: 'home-1', runtimeAccountId: 'account-1' } },
        });
        try {
            const { settlePluginSurfaceHostApiRequest } = await import('./createPluginSurfaceHostApi');
            const invocation = executeActionRequest({ action: 'reviews.comments.list', input: { sessionId: 'session-1' } });
            const result = await settlePluginSurfaceHostApiRequest(invocation, () => api.handleRequest(invocation));
            expect(result).toMatchObject({ kind: 'result', payload: { cursor: null,
                items: [{ id: comment.id, body: comment.body, snapshot: comment.snapshot }] } });
        } finally { api.dispose?.(); }
    });
    it.each(['equivalent', 'retired'] as const)('retains an entered Account read only while its execution remains current (%s)', async change => {
        const accountLifetime = clientAccountLifetime();
        let enter!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const activation = createClientActionActivation({ pluginId: 'acme.external-account-reader', accountPlacement: true, accountLifetime,
            accountHandler: async (_value, context) => {
                enter();
                await blocked;
                // This reads the same currentness fence as Account storage,
                // through the real public services facade and nested dispatcher.
                try { return await context.services.actions.execute('wait', {}); }
                catch (error) { if (isPluginError(error)) return { code: error.code }; throw error; }
            } });
        let currentAction = activation.action;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
            const pending = dispatchPluginSurfaceAction({
                action: { pluginId: activation.action.pluginId, localId: activation.action.id }, input: {}, clientAction: {},
                pluginUiProjection: activation.projection,
                resolveContributedAction: identity => resolveExactClientAction(currentAction)(identity),
                hostAction: { execute: executor.execute, context: {
                    serverId: accountLifetime.scope.serverId, runtimeAccountId: accountLifetime.scope.accountId,
                } },
            });
            await entered;
            currentAction = { ...activation.action, ...(change === 'retired' ? { occurrenceId: 'replacement-custody' } : {}) };
            release();
            // The host Action validates its own input. It must be reached after
            // equivalent publication; true custody replacement must stop first.
            await expect(pending).resolves.toMatchObject(change === 'equivalent'
                ? { ok: true, result: { code: 'invalid_parameters' } }
                : { ok: true, result: { code: 'plugin_action_generation_retired' } });
        } finally { release(); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['account', 'client'] as const)('collects and validates omitted %s Action input while daemon execution is unavailable', async target => {
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({ accountPlacement: target === 'account', accountLifetime,
            inputHints: { fields: [{ path: 'name', title: 'Name', widget: 'text', required: true }] },
            inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
            ...(target === 'account' ? { accountHandler: async value => value } : { handler: async value => value }),
        });
        await activation.composition.unload();
        await activation.composition.reconcile([activation.activation]);
        const { Modal } = await import('@/modal');
        type Form = import('@/components/plugins/actions/pluginContributedActionController').PluginContributedActionSelectionForm;
        let form: Form | undefined;
        const show = vi.spyOn(Modal, 'show').mockImplementation(config => {
            form = (config.props as Readonly<{ form: Form }>).form;
            return 'placement-aware-action-input';
        });
        const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        const hook = await renderHook(() => useBoundPluginSurfaceController({ facts: {
            pluginId: CALLER_PLUGIN_ID, contributionId: 'panel', surfaceId: 'placement-aware-form',
            placement: 'appSurface', platform: 'web', channel: 'internal',
            machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
            serverId: accountLifetime.scope.serverId, occurrenceId: 'requester-current',
            executionOrigin: CLIENT_ACTION_ORIGIN,
            accountLifetime, actionInputSelectionFactsKey: createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: CALLER_PLUGIN_ID }),
            interactionEnabled: true, daemonInteractionEnabled: false,
            pluginUiProjection: activation.projection, pluginProjectionById: buildV2PluginProjectionById(activation.projection),
            resolveContributedAction: resolveExactClientAction(activation.action),
        } }));
        try {
            const pending = hook.getCurrent().dispatchAction({ pluginId: CALLER_PLUGIN_ID, localId: activation.action.id });
            await vi.waitFor(() => expect(form).toBeDefined());
            form!.replaceInput({ name: '' });
            expect(await form!.submit()).toMatchObject({ kind: 'unavailable' });
            form!.replaceInput({ name: 'Research' });
            await form!.submit();
            await expect(pending).resolves.toEqual({ name: 'Research' });
            if (target === 'account') expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)).toEqual([]);
        } finally {
            form?.cancel(); await hook.unmount(); await activation.composition.unload(); accountLifetime.retire(); show.mockRestore(); hide.mockRestore();
        }
    });

    it('delivers a real Artifact refusal through the mounted dispatcher and native author API while peer activation is pending', async () => {
        const { createPluginAccountAvailabilityReaderStore } = await import('@/sync/domains/plugins/availability/reader');
        const { reconcileProjectedPluginUiClientExecutables } = await import('@/components/plugins/reactNative/clientExecutableActivation');
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime, accountHandler: async () => {
            throw new Error('A refused target must not execute');
        } });
        await activation.composition.unload();
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope: accountLifetime.scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const hook = await renderHook(() => useBoundPluginSurfaceController({ facts: { pluginId: CALLER_PLUGIN_ID,
            contributionId: 'panel', surfaceId: 'terminal-artifact-refusal', placement: 'appSurface', platform: 'web', channel: 'internal',
            machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, serverId: accountLifetime.scope.serverId,
            occurrenceId: 'requester-current', executionOrigin: CLIENT_ACTION_ORIGIN, accountLifetime,
            actionInputSelectionFactsKey: createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: CALLER_PLUGIN_ID }),
            interactionEnabled: true, daemonInteractionEnabled: false,
            pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action),
            readClientExecutableAdmission: () => ({ projection: activation.projection, platform: 'web',
                activation: { status: 'establishing' }, accountLifetime }),
        } }));
        const controller = hook.getCurrent();
        const native = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({ mount: { kind: 'destination',
                destination: { pluginId: CALLER_PLUGIN_ID, localId: 'panel' }, container: 'rightPane' }, target: { kind: 'app' } }),
            requestSurface: controller.surfaceContext, requestIdPrefix: 'terminal-artifact',
            installedMethods: controller.hostApi.admissionMethods, handleRequest: controller.hostApi.handleRequest,
        });
        try {
            let settled = false;
            const pending = native.api.executeAction({ pluginId: activation.action.pluginId, localId: activation.action.id }, {}).catch(error => error);
            void pending.then(() => { settled = true; });
            await act(async () => {});
            expect(settled).toBe(false);
            await act(async () => {
                await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection: activation.projection },
                    platform: 'web', accountLifetime, reader: store.bind(accountLifetime.scope) });
            });
            const error: unknown = await pending;
            expect(error).toMatchObject({ code: 'artifact_not_current', retryable: false,
                details: { layer: 'artifact', phase: 'preparation' },
                message: resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: 'artifact_not_current' }).body });
            controller.hostApi.notifyConnectionSettled?.();
            controller.hostApi.notifyConnectionSettled?.();
            expect(activation.activate).not.toHaveBeenCalled();
            expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)).toEqual([]);
        } finally { native.dispose(); await hook.unmount(); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['ready', 'routed-ready', 'routed-unavailable', 'routed-cancelled', 'foreign-account', 'retired-owner', 'unavailable', 'nonparticipating', 'already-registered', 'cancelled', 'replaced', 'abandoned', 'scoped-replaced', 'scoped-withdrawn', 'scoped-unavailable'] as const)(
        'settles only its expected cold Account executable through the mounted admission owner (%s)', async settlement => {
        const { AppShellPluginUiProjectionValueProvider, useAppShellPluginUiProjection } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const accountLifetime = clientAccountLifetime();
        // The physical Host binds routed credentials independently from the
        // AppShell active Account owner, even when both scopes are current.
        const mountedLifetime = settlement.startsWith('routed-') ? Object.freeze({ ...accountLifetime }) : accountLifetime;
        const ownerLifetime = settlement === 'foreign-account'
            ? Object.freeze({ ...accountLifetime, scope: { ...accountLifetime.scope, accountId: 'another-account' } })
            : settlement === 'retired-owner' ? Object.freeze({ ...accountLifetime, isCurrent: () => false }) : accountLifetime;
        let entered = 0;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async () => { entered += 1; return { read: true }; } });
        let currentAction: PluginProjectedActionV2 | null = activation.action;
        let scopedProjection = activation.projection;
        let ownerProjection = activation.projection;
        let candidateRendered = false;
        const suspended = new Promise<void>(() => {});
        await activation.composition.unload();
        if (settlement === 'already-registered') await activation.composition.reconcile([activation.activation]);
        let activationState: AppShellClientExecutableActivationState = { status: 'establishing' };
        const actionInputSelectionFactsKey = createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: CALLER_PLUGIN_ID });
        function Owner(props: React.PropsWithChildren) {
            const value: AppShellPluginUiProjectionValue = { pluginUiProjection: settlement === 'nonparticipating'
                ? EMPTY_PLUGIN_UI_PROJECTION : ownerProjection, pluginBrowserProjection: null,
                phase: 'current', interactionEnabled: true, machineId: null, serverId: accountLifetime.scope.serverId,
                platform: 'web', accountLifetime: ownerLifetime, clientExecutableActivation: activationState,
                reloadConnectedAccountProjection: () => {}, reloadClientExecutables: () => {} };
            return React.createElement(React.Suspense, { fallback: null },
                React.createElement(AppShellPluginUiProjectionValueProvider, { value }, props.children));
        }
        const hook = await renderHook((candidate: boolean) => {
            const owner = useAppShellPluginUiProjection();
            const selectedAction = currentAction;
            const facts = { pluginId: CALLER_PLUGIN_ID, contributionId: 'panel', surfaceId: 'cold-account-executable',
                placement: 'appSurface' as const, platform: 'web' as const, channel: 'internal' as const,
                machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, serverId: accountLifetime.scope.serverId,
                occurrenceId: 'requester-current', executionOrigin: CLIENT_ACTION_ORIGIN, accountLifetime: mountedLifetime, actionInputSelectionFactsKey,
                interactionEnabled: true, daemonInteractionEnabled: true, isDaemonConnectionPending: () => false,
                pluginUiProjection: scopedProjection,
                resolveContributedAction: selectedAction ? resolveExactClientAction(selectedAction) : () => null,
                readClientExecutableAdmission: () => ({ projection: owner.pluginUiProjection, platform: owner.platform,
                    activation: owner.clientExecutableActivation, accountLifetime: owner.accountLifetime }),
            };
            const controller = useBoundPluginSurfaceController({ facts });
            if (candidate) { candidateRendered = true; throw suspended; }
            return controller;
        }, { wrapper: Owner, initialProps: false });
        try {
            const controller = hook.getCurrent();
            expect(controller.isRequesterAdmitted()).toBe(true);
            expect(controller.canInteractWithDaemon()).toBe(true);
            const cancellation = new AbortController();
            let settled = false;
            const read = Promise.resolve(controller.hostApi.handleRequest({ version: 1, requestId: 'cold-account-read',
                surface: controller.surfaceContext, method: 'executeAction',
                payload: { action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {} },
            }, { signal: cancellation.signal }));
            void read.then(() => { settled = true; }, () => { settled = true; });
            await act(async () => {});
            if (settlement === 'nonparticipating' || settlement === 'foreign-account' || settlement === 'retired-owner') {
                await expect(read).resolves.toMatchObject({ code: 'unavailable', diagnostics: ['plugin_surface_client_action_unavailable'] });
                expect(entered).toBe(0);
                return;
            }
            if (settlement === 'already-registered') {
                await expect(read).resolves.toEqual({ read: true });
                expect(entered).toBe(1);
                return;
            }
            expect(settled, 'positive exact-target establishment must not publish a pre-handler unavailable result').toBe(false);
            expect(entered).toBe(0);
            if (settlement === 'scoped-replaced' || settlement === 'scoped-withdrawn' || settlement === 'scoped-unavailable') {
                if (settlement === 'scoped-replaced') {
                    const replacement = createClientActionActivation({ accountPlacement: true, accountLifetime,
                        occurrenceId: 'replacement-scoped-account-custody', accountHandler: async () => null });
                    currentAction = replacement.action;
                    scopedProjection = replacement.projection;
                } else if (settlement === 'scoped-unavailable') {
                    currentAction = { ...activation.action, available: false };
                    scopedProjection = { ...activation.projection,
                        actionsById: { [`${CALLER_PLUGIN_ID}/${activation.action.id}`]: currentAction } };
                } else {
                    currentAction = null;
                    scopedProjection = { ...activation.projection, actionsById: {} };
                }
                expect(await hook.rerender(false)).toBe(controller);
                expect(settled, 'the committed scoped declaration must still authorize the waiting request').toBe(true);
                await expect(read).resolves.toMatchObject({ code: settlement === 'scoped-replaced' ? 'stale_surface' : 'unavailable', diagnostics: [settlement === 'scoped-replaced'
                    ? 'plugin_ui_generation_retired' : 'plugin_surface_action_projection_unavailable'] });
                expect(entered).toBe(0);
                return;
            }
            if (settlement === 'replaced' || settlement === 'abandoned') {
                currentAction = { ...activation.action, execution: { target: 'account',
                    account: { artifactId: 'replacement-account-runtime', exportName: CLIENT_ACTION_TARGET.exportName } } };
                if (settlement === 'replaced') {
                    const replacement = createClientActionActivation({ accountPlacement: true, accountLifetime,
                        occurrenceId: 'replacement-account-custody', accountHandler: async () => null });
                    currentAction = replacement.action;
                    ownerProjection = replacement.projection;
                    expect(resolveProjectedPluginUiClientExecutables({ actionProjection: { projection: ownerProjection }, platform: 'web' }))
                        .toMatchObject([{ occurrenceId: 'replacement-account-custody' }]);
                    expect(await hook.rerender(false)).toBe(controller);
                    expect(settled, 'withdrawn A must not wait for replacement B to establish').toBe(true);
                    await expect(read).resolves.toMatchObject({ code: 'stale_surface', diagnostics: ['plugin_ui_generation_retired'] });
                    expect(entered).toBe(0);
                } else {
                    const child: unknown = hook.tree.root.findByType(Owner).props.children;
                    if (!React.isValidElement<{ hookProps: boolean }>(child)) throw new Error('Expected canonical hook harness');
                    await act(async () => { React.startTransition(() => {
                        hook.tree.update(React.createElement(Owner, null, React.cloneElement(child, { hookProps: true })));
                    }); });
                    expect(candidateRendered).toBe(true);
                    const peer = createClientActionActivation({ pluginId: 'acme.unrelated-callee', accountPlacement: true,
                        accountLifetime, accountHandler: async () => null });
                    await peer.composition.reconcile([peer.activation]);
                    await act(async () => {});
                    expect(settled, 'an unrelated index publication must not expose an uncommitted resolver').toBe(false);
                    await activation.composition.reconcile([activation.activation]);
                    await expect(read).resolves.toEqual({ read: true });
                    expect(entered).toBe(1);
                    currentAction = activation.action;
                    await hook.rerender(false);
                }
                return;
            }
            if (settlement === 'ready' || settlement === 'routed-ready') {
                // The requested registration can commit before the whole set
                // settles. Its existing publication must wake this one read.
                await activation.composition.reconcile([activation.activation]);
                await expect(read).resolves.toEqual({ read: true });
                expect(activationState.status).toBe('establishing');
                expect(entered).toBe(1);
            } else if (settlement === 'unavailable' || settlement === 'routed-unavailable') {
                activationState = { status: 'unavailable', failures: [{ pluginId: CALLER_PLUGIN_ID,
                    target: activation.activation.target, executionOrigin: null,
                    occurrenceId: activation.action.occurrenceId, code: 'activation_failed' }] };
                expect(await hook.rerender()).toBe(controller);
                await expect(read).resolves.toMatchObject({ code: 'unavailable', diagnostics: ['plugin_surface_client_action_unavailable'] });
                expect(entered).toBe(0);
            } else {
                cancellation.abort();
                await expect(read).resolves.toMatchObject({ code: 'unavailable', diagnostics: ['plugin_ui_invocation_aborted'] });
                expect(entered).toBe(0);
            }
        } finally { await hook.unmount(); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['client', 'account'] as const)('uses the preview template approval once and retains admission after policy changes (%s)', async target => {
        const storage = getStorage();
        const previous = storage.getState();
        const home = rpcHomes.get('server-client-action')!;
        const template = createDeploymentEnvironmentHeaderV1({ serverId: 'srv_client_action' });
        const child = createDeploymentEnvironmentHeaderV1({ id: 'preview-child', serverId: 'srv_client_action',
            purpose: 'preview', previewTemplateEnvironmentId: template.id, previewRepositoryId: 'source-app',
            previewPullRequestId: 'pr-42', previewTargetLinkId: 'template-link' });
        const actionId = 'acme.releases/actions/publish';
        const scope = { kind: 'environment', environmentId: template.id } as const;
        let reads = 0;
        network.setHttpResponder(async (url, init) => {
            if (new URL(String(url)).pathname === `/v1/deployments/environments/${child.id}`) {
                reads++;
                return Response.json({ ok: true, environment: child, targetLinks: [] });
            }
            return createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init);
        });
        const handler = vi.fn(async () => ({ published: true }));
        const accountLifetime = clientAccountLifetime(resolveServerProfileScopeIdForIdentifier(home.id));
        const activation = createClientActionActivation({ pluginId: 'acme.releases', localId: 'publish',
            approvalScope: 'environment', dangerLevel: 'writesRemote', accountLifetime,
            accountPlacement: target === 'account', handler, accountHandler: handler, inputSchema: {
            type: 'object', properties: { serverId: { type: 'string' }, environmentId: { type: 'string' } },
            required: ['serverId', 'environmentId'], additionalProperties: false,
        } });
        await activation.composition.reconcile([activation.activation]);
        const requestCurrentIntent = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => {
            storage.setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                    actions: { [actionId]: { enabled: false } },
                }),
            } }));
            return { status: 'approved' as const, fingerprint };
        });
        const dispatch = () => dispatchPluginSurfaceAction({
            action: { pluginId: 'acme.releases', localId: 'publish' },
            input: { serverId: home.id, environmentId: child.id },
            clientAction: {},
            pluginUiProjection: activation.projection,
            resolveContributedAction: resolveExactClientAction(activation.action),
            requestCurrentIntent,
        });
        try {
            storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({
                v: 1, scopedApprovalPreferences: [{ actionId, scope,
                    approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['ui'] }],
            }) } }));
            const waived = await dispatch();
            expect(waived, JSON.stringify(waived)).toMatchObject({ ok: true, result: { published: true } });
            expect(requestCurrentIntent).not.toHaveBeenCalled();
            expect(reads).toBe(1);
            storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({
                v: 1, scopedApprovalPreferences: [{ actionId, scope,
                    approvalRequiredSurfaces: ['ui'], approvalWaivedSurfaces: [] }],
            }) } }));
            expect(await dispatch()).toMatchObject({ ok: true, result: { published: true } });
            expect(requestCurrentIntent).toHaveBeenCalledOnce();
            expect(reads).toBe(2);
            expect(handler).toHaveBeenCalledTimes(2);
        } finally { storage.setState(previous); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('reports signed-out Account admission instead of an unavailable deployment for an Environment-scoped Account Action', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const home = rpcHomes.get('server-client-action')!;
        const accountLifetime = clientAccountLifetime(resolveServerProfileScopeIdForIdentifier(home.id));
        const handler = vi.fn(async () => ({ published: true }));
        const activation = createClientActionActivation({ pluginId: 'acme.releases', localId: 'publish',
            approvalScope: 'environment', dangerLevel: 'writesRemote', accountLifetime,
            accountPlacement: true, handler, accountHandler: handler, inputSchema: {
                type: 'object', properties: { serverId: { type: 'string' }, environmentId: { type: 'string' } },
                required: ['serverId', 'environmentId'], additionalProperties: false,
            } });
        await activation.composition.reconcile([activation.activation]);
        // Persistent credential storage is the system boundary. Account capture,
        // Environment admission and the dispatcher remain real.
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(null);
        try {
            const result = await dispatchPluginSurfaceAction({ action: { pluginId: 'acme.releases', localId: 'publish' },
                input: { serverId: home.id, environmentId: 'preview-child' }, clientAction: {},
                pluginUiProjection: activation.projection,
                resolveContributedAction: resolveExactClientAction(activation.action),
            });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: false, reason: 'action_home_signed_out' });
            expect(handler).not.toHaveBeenCalled();
        } finally { credentials.mockRestore(); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each([
        { placement: 'declaration', explicitTarget: false, refuses: false },
        { placement: 'explicit target', explicitTarget: true, refuses: false },
        { placement: 'typed refusal', explicitTarget: false, refuses: true },
        { placement: 'global catalog form', explicitTarget: false, refuses: false },
    ])('submits a global catalog Account Action form or direct Machine-hosted request through its public owner ($placement)', async ({ placement, explicitTarget, refuses }) => {
        const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const lifetime = clientAccountLifetime();
        const identity = { pluginId: 'acme.placement', localId: 'read' };
        const action = { ...createClientTargetAction({ identity, accountPlacement: true }),
            placementBindings: ['commandPalette'] as const,
            inputHints: { fields: [{ path: 'subject', title: 'Subject', widget: 'text' as const, required: true }] },
            hostOrigin: { ...CLIENT_ACTION_HOST_ORIGIN, executionOrigin: clientActionExecutionOrigin(identity.pluginId) } };
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            installedPackagesById: { [identity.pluginId]: PluginProjectionInstalledPackageV2Schema.parse({
                id: identity.pluginId, displayName: 'Account placement', version: '1.2.3', enabled: true,
                source: { kind: 'localPath', locator: identity.pluginId },
            }) },
            actionsById: { 'acme.placement/read': action } };
        const release = publishCommittedAppShellPluginUiProjection(() => projection);
        const payload = { choices: [{ id: 'investigate', startable: true }], linkedSessionId: 'retained-finding' };
        const failureCause = ActionFailureCauseV1Schema.parse({ phase: 'dispatch', errorClass: 'ManagedMachineControllerError',
            errorCode: 'admission_unavailable', httpStatus: null });
        const received: unknown[] = [];
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://server-client-action',
            serverIdentityId: 'srv_client_action', accountId: lifetime.scope.accountId, machineId: CLIENT_ACTION_HOST_ORIGIN.machineId,
            actionId: 'action.invoke', tokenEpoch: 0, execute: request => { received.push(request); return payload; },
            failure: () => refuses ? { errorCode: 'admission_unavailable', error: 'admission_unavailable', details: { failureCause } } : null });
        network.setHttpResponder(async (url, init) => await boundary.handle(new URL(String(url)), init)
            ?? createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init));
        accountBrowserRelay.enabled = true;
        const controller = new AbortController();
        const port = createCurrentUiContextVoiceToolPort({ invocationSurface: 'ui', readProjection: () => projection,
            readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            hostAction: { execute: async () => { throw new Error('No local Action effect'); }, context: {
                serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
                runtimeAccountId: lifetime.scope.accountId, surface: 'ui', authority: 'present_user',
                ...(explicitTarget ? { externalActionTarget: { kind: 'machine' as const, machineId: boundary.machine.id } } : {}),
            } },
        });
        try {
            const outcome = placement === 'global catalog form' ? await (async () => {
                const { createPluginContributedActionController } = await import('../actions/pluginContributedActionController');
                const { createHydratedPlainMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
                const previous = getStorage().getState();
                const machine = createHydratedPlainMachineFixture({ id: boundary.machine.id, accountId: lifetime.scope.accountId,
                    machine: { access: boundary.machine.access } });
                getStorage().setState({ machines: { [machine.id]: machine },
                    machineListByServerId: { [lifetime.scope.serverId]: [machine] },
                    machineListStatusByServerId: { [lifetime.scope.serverId]: 'idle' } });
                onTestFinished(() => getStorage().setState({ machines: previous.machines,
                    machineListByServerId: previous.machineListByServerId,
                    machineListStatusByServerId: previous.machineListStatusByServerId }));
                const catalog = createPluginContributedActionController({ resolveCurrent: () => ({
                    pluginProjectionById: buildV2PluginProjectionById(projection), pluginUiProjection: projection,
                    resolveContributedAction: resolveExactClientAction(action),
                    host: { machineId: boundary.machine.id, serverId: lifetime.scope.serverId, accountLifetime: lifetime },
                }) });
                const descriptor = catalog.list({ placement: 'commandPalette', scope: 'global' })[0];
                expect(descriptor).toBeDefined();
                if (!descriptor) throw new Error('Missing catalog Account Action');
                const opened = await catalog.open(descriptor);
                expect(opened.kind).toBe('form');
                if (opened.kind !== 'form') throw new Error('Missing catalog Account form');
                opened.form.replaceInput({ subject: 'receipt' });
                const submitted = await opened.form.submit();
                expect(submitted.kind).toBe('settled');
                if (submitted.kind !== 'settled') throw new Error('Account form did not settle');
                return submitted.outcome;
            })() : await port.invokeAction!({ action: identity, input: { subject: 'receipt' }, signal: controller.signal });
            if (refuses) expect(outcome).toMatchObject({ ok: false, errorCode: 'admission_unavailable', failureCause });
            else expect(outcome).toEqual({ ok: true, result: payload });
            expect(received).toHaveLength(1);
        } finally { controller.abort(); release(); accountBrowserRelay.enabled = false; }
    });

    it.each(['missing', 'unavailable', 'offline', 'none', 'cold', 'explicit', 'explicit-offline'] as const)('places Account Actions using receiver runtime availability (%s)', async state => {
        const { executeAccountActionAtRuntimeHost } = await import('./accountActionPlacement');
        const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const { createMachineFixture, createMachineReadBatchResponseFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { publishMachineActivityForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { buildDeferredDaemonProjectionSections } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const lifetime = clientAccountLifetime();
        const account = await captureLazyActionAccountContext(lifetime.scope.serverId);
        const previous = getStorage().getState();
        const identity = { pluginId: 'acme.placement', localId: 'read' };
        const action = createClientTargetAction({ identity, accountPlacement: true });
        let effects = 0;
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://server-client-action',
            serverIdentityId: 'srv_client_action', accountId: lifetime.scope.accountId, machineId: 'usable',
            actionId: 'action.invoke', tokenEpoch: 0, execute: () => { effects++; return { selected: 'usable' }; } });
        const fixtureBoundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://server-client-action',
            serverIdentityId: 'srv_client_action', accountId: lifetime.scope.accountId, machineId: 'fixture',
            actionId: 'action.invoke', tokenEpoch: 0, execute: () => ({ selected: 'fixture' }) });
        const offline = state === 'offline' || state === 'explicit-offline';
        const machines = ['fixture', 'usable'].map(id => createMachineFixture({ id, createdAt: id === 'fixture' ? 2 : 1,
            active: !offline || id !== 'fixture', activeAt: id === 'fixture' && offline ? 0 : Date.now(), access: boundary.machine.access }));
        publishMachineActivityForTest(machines);
        getStorage().setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            machineListByServerId: { [lifetime.scope.serverId]: machines }, machineListStatusByServerId: { [lifetime.scope.serverId]: 'idle' } });
        daemonRpc.mockImplementation(async (request: { method: string; machineId: string; payload?: { sectionRead?: { digest: string; offset: number; includeDigests?: readonly string[] } } }) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return undefined;
            const usable = request.machineId === 'usable' && state !== 'none';
            const snapshot = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: (usable ? 'a' : 'b').repeat(64), projection: {
                v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
                actionsById: usable || state === 'unavailable' || state === 'offline'
                    ? { 'acme.placement/read': { ...action, available: usable || state === 'offline' } } : {},
            } });
            const read = request.payload?.sectionRead;
            return read ? snapshot.read(read.digest, read.offset, read.includeDigests) : snapshot.manifest;
        });
        network.setHttpResponder(async (url, init) => {
            if (new URL(String(url)).pathname === '/v1/machines/read-batch') {
                return createMachineReadBatchResponseFixture(init?.body, id =>
                    [boundary, fixtureBoundary].find(item => item.machine.id === id)?.machine ?? null);
            }
            return await boundary.handle(new URL(String(url)), init)
                ?? await fixtureBoundary.handle(new URL(String(url)), init)
                ?? createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init);
        });
        accountBrowserRelay.enabled = true;
        try {
            for (const machine of machines) {
                if (!machine.active || state === 'cold' || state === 'explicit' || state === 'explicit-offline') continue;
                const answer = await loadDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: account.serverId,
                    accountLifetime: account.accountLifetime, sections: ['actionsById'], reuseFreshReady: true });
                expect(answer, JSON.stringify(answer)).toMatchObject({ kind: 'ready' });
            }
            const reads = network.requests.length;
            const result = executeAccountActionAtRuntimeHost({ accountScope: lifetime.scope, action: identity,
                execution: { target: 'account', account: { artifactId: 'fixture', exportName: 'activate' } }, input: {},
                context: { serverId: lifetime.scope.serverId, runtimeAccountId: lifetime.scope.accountId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                    ...(state === 'explicit' || state === 'explicit-offline'
                        ? { externalActionTarget: { kind: 'machine' as const, machineId: state === 'explicit-offline' ? 'fixture' : 'usable' } } : {}) },
                signal: new AbortController().signal, executeLocal: () => { throw new Error('No local fallback on browser'); } });
            if (state === 'none') await expect(result).rejects.toMatchObject({ code: 'target_unavailable' });
            else if (state === 'explicit-offline') await expect(result).rejects.toMatchObject({ code: 'machine_unreachable' });
            else await expect(result).resolves.toEqual({ selected: 'usable' });
            expect(effects).toBe(state === 'none' || state === 'explicit-offline' ? 0 : 1);
            if (state === 'cold') {
                expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
                    && !(request.payload as { sectionRead?: unknown }).sectionRead)).toHaveLength(2);
            } else expect(network.requests.length).toBe(reads);
        } finally {
            accountBrowserRelay.enabled = false; account.dispose(); lifetime.retire();
            getStorage().setState({ machines: previous.machines, machineListByServerId: previous.machineListByServerId,
                machineListStatusByServerId: previous.machineListStatusByServerId });
        }
    });

    it('retains the Account refusal proof through the HTTP carrier and client invocation', async () => {
        const { executeAccountActionAtRuntimeHost } = await import('./accountActionPlacement');
        const { createPluginSurfaceActionFailureError, projectClientActionInvocationFailure } = await import('./actionFailure');
        const { triageTaskWriteInvocationFailureV1 } = await import('../../../../../../packages/plugins/triage/src/actions/taskWriteFailure');
        const { createPluginActionInvocation } = await import('@happier-dev/protocol/plugins/actions/invocation');
        const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const home = rpcHomes.get('server-client-action')!;
        const lifetime = clientAccountLifetime(home.id);
        const code = 'plugin_action_current_intent_mismatch';
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://server-client-action',
            serverIdentityId: 'srv_client_action', accountId: lifetime.scope.accountId, machineId: 'machine-local',
            actionId: 'action.invoke', tokenEpoch: 0, failure: () => ({ errorCode: code, error: code,
                details: { name: 'PluginError', code, message: code, actionHandlerInvocation: 'notStarted' } }),
            execute: () => ({ ok: false, errorCode: code, error: code,
                details: { name: 'PluginError', code, message: code, actionHandlerInvocation: 'notStarted' } }),
        });
        network.setHttpResponder(async (url, init) => await boundary.handle(new URL(String(url)), init)
            ?? createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init));
        try {
            const declaration = { readOnly: false };
            const invocation = createPluginActionInvocation({ pluginId: 'acme.releases', localId: 'publish', declaration,
                occurrenceSignal: new AbortController().signal, isCurrent: () => true });
            const result = await invocation.invoke({}, { handler: () => executeAccountActionAtRuntimeHost({
                accountScope: lifetime.scope, action: { pluginId: 'acme.releases', localId: 'publish' },
                execution: { target: 'account', account: { artifactId: 'fixture', exportName: 'publish' } }, input: {},
                context: { surface: 'plugin', authority: 'account_automation',
                    externalActionTarget: { kind: 'machine', machineId: boundary.machine.id } },
                signal: new AbortController().signal, executeLocal: () => { throw new Error('Expected relay'); },
            }) });
            expect(result.status).toBe('failed');
            if (result.status === 'executed') throw new Error('Expected refusal');
            const outcome = projectClientActionInvocationFailure(result, declaration, {});
            expect(triageTaskWriteInvocationFailureV1(createPluginSurfaceActionFailureError(outcome)))
                .toEqual({ kind: 'refused', reason: code });
        } finally { lifetime.retire(); }
    });

    it.each([
        { code: 'plugin_action_current_intent_unavailable', actionHandlerInvocation: 'notStarted', kind: 'refused' },
        { code: 'plugin_action_outcome_unknown', actionHandlerInvocation: undefined, kind: 'uncertain' },
    ] as const)('retains the daemon dispatch evidence for a nested source refusal ($kind)', async ({ code, actionHandlerInvocation, kind }) => {
        const { createPluginSurfaceActionFailureError } = await import('./actionFailure');
        const { triageTaskWriteInvocationFailureV1 } = await import('../../../../../../packages/plugins/triage/src/actions/taskWriteFailure');
        // The daemon RPC is a process boundary; the real dispatcher, error
        // projection and Triage outcome owner remain underneath this response.
        const requestId = 'nested-source-transport-refusal';
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true, result: { ok: false, code, requestId,
                ...(actionHandlerInvocation ? { actionHandlerInvocation } : {}) },
        }));
        const outcome = await dispatchPluginSurfaceAction({ action: { pluginId: 'acme.releases', localId: 'publish' },
            input: {},
            hostAction: { execute: vi.fn(), context: { authority: 'present_user' } },
            resolveContributedAction: resolveConfirmedDaemonTargetAction,
            requestCurrentIntent: async ({ fingerprint }) => ({ status: 'approved', fingerprint }),
            contributedAction: { machineId: 'machine-1', execute: contributed },
        });
        expect(contributed).toHaveBeenCalledExactlyOnceWith('machine-1', expect.objectContaining({ presentUserIntent: 'confirmed' }));
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error('Expected source refusal');
        expect(triageTaskWriteInvocationFailureV1(createPluginSurfaceActionFailureError(outcome)))
            .toMatchObject(kind === 'refused' ? { kind, reason: code, retryable: false, requestId }
                : { kind, failure: { class: 'unknown', code, requestId } });
    });

    it('lets the daemon Environment admission request UI confirmation without a second UI policy read', async () => {
        let approvalRequired = false;
        let environmentReads = 0;
        network.setHttpResponder(async (url, init) => {
            if (new URL(String(url)).pathname.includes('/deployments/environments/')) environmentReads++;
            return createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init);
        });
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async (_machine, options) => {
            if (approvalRequired && options.presentUserIntent !== 'confirmed') return {
                supported: true, result: { ok: false, code: 'plugin_action_current_intent_unavailable',
                    actionHandlerInvocation: 'notStarted' },
            };
            return { supported: true, result: { ok: true, result: { published: true } } };
        });
        const requestCurrentIntent = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => ({
            status: 'approved' as const, fingerprint,
        }));
        const dispatch = () => dispatchPluginSurfaceAction({ action: { pluginId: 'acme.releases', localId: 'publish' },
            input: { serverId: 'server-composed', environmentId: 'preview-child' },
            resolveContributedAction: identity => ({ ...resolveConfirmedDaemonTargetAction(identity), approvalScope: 'environment' as const }),
            requestCurrentIntent, contributedAction: { machineId: 'machine-1', serverId: 'server-composed', execute: contributed },
        });
        expect(await dispatch()).toMatchObject({ ok: true, result: { published: true } });
        expect(requestCurrentIntent).not.toHaveBeenCalled();
        approvalRequired = true;
        expect(await dispatch()).toMatchObject({ ok: true, result: { published: true } });
        expect(requestCurrentIntent).toHaveBeenCalledOnce();
        expect(contributed).toHaveBeenCalledTimes(3);
        expect(environmentReads).toBe(0);
    });

    it.each([
        { coldBinding: false, settlement: 'ready' },
        { coldBinding: true, settlement: 'ready' },
        { coldBinding: true, settlement: 'ready-with-account-caller' },
        { coldBinding: true, settlement: 'current' },
        { coldBinding: false, settlement: 'current' },
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
                try {
                    return await context.services.actions.execute({ pluginId: sourceId, localId: 'list' }, {},
                        settlement === 'current' ? { machineAvailability: 'current' } : undefined);
                } catch (error) {
                    if (settlement !== 'current' || !isPluginError(error)) throw error;
                    return { unavailable: error.code };
                }
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
        type Admission = { daemonReady: boolean; originCurrent: boolean; pending: boolean; bound: boolean; machineId?: string;
            targetSourceCustody?: typeof selected.sourceCustody | typeof TARGET_SOURCE_CUSTODY };
        const cancellation = new AbortController();
        const hook = await renderHook((admission: Admission) => useBoundPluginSurfaceController({
            facts: { ...facts, daemonOccurrenceId: admission.bound ? 'machine-lease-current' : undefined,
                executionOrigin: settlement === 'ready-with-account-caller' ? null : facts.executionOrigin,
                targetSourceCustody: admission.targetSourceCustody ?? selected.sourceCustody,
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
            const read = Promise.resolve(controller.hostApi.handleRequest({ version: 1, requestId: 'nested-pending-read',
                surface: controller.surfaceContext, method: 'executeAction',
                payload: { action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {} },
            }, { signal: cancellation.signal }));
            void read.then(() => { settled = true; }, () => { settled = true; });
            await vi.waitFor(() => expect(entered).toBe(1));
            await act(async () => {});
            expect(enteredSignal?.aborted).toBe(false);
            expect(machine).not.toHaveBeenCalled();
            if (settlement === 'current') {
                await vi.waitFor(() => expect(settled, 'a current-availability read must settle without a Machine readiness edge').toBe(true));
                await expect(read).resolves.toEqual({ unavailable: 'plugin_surface_contributed_action_unavailable' });
                expect(await hook.rerender({ daemonReady: true, originCurrent: true, pending: false, bound: true })).toBe(controller);
                await expect(controller.hostApi.handleRequest({ version: 1, requestId: 'available-source-read',
                    surface: controller.surfaceContext, method: 'executeAction',
                    payload: { action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {} },
                })).resolves.toEqual({ rows: ['provider'] });
                expect(machine).toHaveBeenCalledTimes(1);
                return;
            }
            expect(settled, 'daemon readiness is pending even though caller interaction and origin currentness are admitted').toBe(false);
            if (settlement === 'ready' || settlement === 'ready-with-account-caller') {
                expect(await hook.rerender({ daemonReady: false, originCurrent: true, pending: true, bound: !coldBinding,
                    targetSourceCustody: TARGET_SOURCE_CUSTODY }),
                'late Machine target custody must not replace its unchanged Account caller').toBe(controller);
                expect(enteredSignal?.aborted).toBe(false);
                expect(settled).toBe(false);
            }
            expect(await hook.rerender({ daemonReady: true, originCurrent: false, pending: true, bound: true })).toBe(controller);
            expect(controller.canInteractWithDaemon()).toBe(false);
            expect(settled).toBe(false);
            expect(machine).not.toHaveBeenCalled();
            if (settlement === 'unavailable') {
                expect(await hook.rerender({ daemonReady: false, originCurrent: true, pending: false, bound: false })).toBe(controller);
                await expect(read).resolves.toMatchObject({ code: 'plugin_machine_unreachable', diagnostics: expect.arrayContaining(['plugin_machine_unreachable']) });
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
            if (settlement !== 'ready' && settlement !== 'ready-with-account-caller') {
                expect(entered).toBe(1);
                expect(machine).not.toHaveBeenCalled();
                return;
            }
            expect(await hook.rerender({ daemonReady: true, originCurrent: true, pending: false,
                bound: settlement !== 'ready-with-account-caller' })).toBe(controller);
            if (settlement === 'ready-with-account-caller') {
                // A portable renderer can also invoke the daemon read directly.
                // Its Account custody never becomes a daemon Resource occurrence.
                await expect(controller.hostApi.handleRequest({ version: 1, requestId: 'account-renderer-read',
                    surface: controller.surfaceContext, method: 'executeAction',
                    payload: { action: { pluginId: sourceId, localId: 'list' }, input: {} },
                })).resolves.toEqual({ rows: ['provider'] });
            }
            await expect(read).resolves.toEqual({ rows: ['provider'] });
            expect(enteredSignal?.aborted).toBe(false);
            expect(entered).toBe(1);
            expect(machine).toHaveBeenCalledTimes(settlement === 'ready-with-account-caller' ? 2 : 1);
            expect(machine.mock.calls[0]?.[0]).toBe(CLIENT_ACTION_ORIGIN.materializationRef.machineId);
        } finally { cancellation.abort(); await hook.unmount(); await activation.composition.unload(); accountLifetime.retire(); }
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

    it('finishes an admitted Account read after the presenting view generation retires', async () => {
        const accountLifetime = clientAccountLifetime();
        let current = true;
        let enteredSignal: AbortSignal | undefined;
        let release = () => {};
        const settled = new Promise<void>(resolve => { release = resolve; });
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async (_value, context) => {
                enteredSignal = context.signal;
                await settled;
                return { rows: ['entry'] };
            } });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const cancellation = new AbortController();
            const pending = dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: { pluginId: activation.action.pluginId, localId: activation.action.id },
                input: {}, clientAction: {}, signal: cancellation.signal,
                isCurrent: () => current,
                pluginUiProjection: activation.projection,
                resolveContributedAction: resolveExactClientAction(activation.action),
            });
            await vi.waitFor(() => expect(enteredSignal).toBeDefined());
            current = false;
            cancellation.abort(new Error('presenting view detached'));
            release();
            expect(enteredSignal!.aborted).toBe(false);
            await expect(pending).resolves.toEqual({ ok: true, result: { rows: ['entry'] } });
        } finally {
            release();
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

    it.each(['buffered', 'streamOpen', 'streamRead'] as const)('keeps selected secret bytes out of the public Account Action %s failure', async mode => {
        const secret = 'registered-native-transport-secret';
        const home = rpcHomes.get('server-client-action')!;
        const accountLifetime = clientAccountLifetime(home.id);
        network.setHttpResponder(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [{
                resourceId: 'selected', encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: { t: 'plain', v: { v: 1, name: 'Selected', kind: 'token', value: secret } },
                entry: { ref: 'happier:shared-secret:v1:selected', source: 'shared_resource', relationship: 'owner', name: 'Selected', kind: 'token',
                    revision: 1, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] });
            if (path === '/native/failure') {
                if (mode !== 'streamRead') throw new Error(`Native transport failed: ${secret}`);
                return new Response(new ReadableStream({ pull(controller) { controller.error(new Error(`Native body failed: ${secret}`)); } }));
            }
            return createEmptyAccountBootstrapHttpResponse(path, init);
        });
        let opened = false;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime, surfaces: ['plugin'],
            accountHandler: async (_input, context) => {
                expect(await context.services.secrets.readSavedSecret('happier:shared-secret:v1:selected')).toBe(secret);
                opened = true;
                const request = { url: `${home.serverUrl}/native/failure`, redirect: 'error' as const };
                if (mode === 'buffered') await context.services.http.request(request);
                else {
                    const response = await context.services.http.requestStream(request);
                    try { for await (const _chunk of response.chunks) { /* The body error is the observed native boundary. */ } }
                    finally { await response.dispose(); }
                }
                return null;
            } });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const outcome = await dispatchPluginSurfaceAction({ action: { pluginId: activation.action.pluginId, localId: activation.action.id },
                input: {}, invocationSurface: 'plugin', originSurface: 'ui', clientAction: {},
                pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action) });
            expect(opened, JSON.stringify(outcome)).toBe(true);
            expect(outcome.ok).toBe(false);
            expect(JSON.stringify(outcome)).not.toContain(secret);
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['health Notice', 'failed Receipt'] as const)('carries the %s investigation origin to the native failure Action catalog', async scenario => {
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const { handleTriageNativeFailure } = await import('../../../../../../packages/plugins/triage/src/actions/nativeFailure');
        const { createAccountNoticeInvestigation } = await import('@/hooks/inbox/accountNoticeInvestigation');
        const { createServiceHealthNoticeArtifactFixture } = await import('@/dev/testkit/fixtures/usageNoticeFixtures');
        const { readAccountNoticeArtifactHeader } = await import('@/sync/domains/artifacts/usageNoticeArtifacts');
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const { resolveOriginalAccountPluginInvocation } = await import('@/sync/api/externalActionAccountTransport');
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        const { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, TriageRunConfiguredActionInputV1Schema } = await import('../../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol');
        await prepareSessionDraftPersistenceStorage();
        const lifetime = clientAccountLifetime();
        const scope = lifetime.scope;
        const pluginId = 'acme.notice-origin';
        const catalogId = 'actions/read-v1';
        const receipt = scenario === 'failed Receipt';
        const custody = { kind: 'managed', immutableGenerationId: 'triage-generation', installSource: 'localPath' } as const;
        const choice = { configuredActionId: 'deployments.investigate', sessionChoice: { kind: 'new' },
            agentChoice: { kind: 'configured' }, delivery: 'compose' } as const;
        const catalogAnswer = { v: 1, kind: 'choices' as const, defaultActionId: receipt ? choice.configuredActionId : null,
            actions: receipt ? [{ label: 'Investigate', selection: choice }] : [] };
        const parent = createClientActionActivation({ pluginId, localId: 'native-failure/handle-v1', accountLifetime: lifetime,
            machineSourceCustody: custody, handler: handleTriageNativeFailure });
        const accountDeclaration = (id: string, invokingUi?: true): import('@happier-dev/protocol/plugins/actions/v2').PluginActionContributionV2 => ({
            id, title: id, scopes: ['global'], surfaces: ['ui', 'plugin'], placementBindings: [], dangerLevel: 'safe', inputSchema: {},
            execution: { target: 'account', ...(invokingUi ? { invokingUi } : {}), account: {
                artifactId: CLIENT_ACTION_TARGET.artifactId, exportName: CLIENT_ACTION_TARGET.exportName,
            } },
        });
        const catalog = createClientActionActivation({ pluginId, localId: catalogId, accountPlacement: true,
            accountLifetime: lifetime, surfaces: ['ui', 'plugin'], readOnly: true,
            artifactGraph: PluginUiArtifactsManifestEntryV2Schema.parse({ ...CLIENT_ACTION_ARTIFACT_GRAPH,
                digest: `sha256:${'b'.repeat(64)}` }),
            ...(receipt ? {
                accountManifest: { ...authoredAccountManifest, id: pluginId, contributes: { actions: [
                    { ...accountDeclaration(catalogId), readOnly: true },
                    accountDeclaration(TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, true),
                ] } },
                accountActivate: api => {
                    api.actions.register(catalogId, () => catalogAnswer);
                    api.actions.register(TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, async (input, context) => {
                        const launch = TriageRunConfiguredActionInputV1Schema.parse(input);
                        if (launch.handoff.context.kind !== 'failure' || launch.handoff.context.subject.kind !== 'deploymentReceipt') {
                            throw new Error('Expected the failed Receipt to reach the configured Action');
                        }
                        await context.ui!.openNewSession({ prompt: `Investigate Receipt ${launch.handoff.context.subject.deploymentId}.` });
                        return { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } };
                    });
                },
            } : { accountHandler: () => catalogAnswer }),
        });
        const projection = { ...parent.projection,
            actionsById: { ...parent.projection.actionsById, ...catalog.projection.actionsById },
            reactNativeBundlesById: { ...parent.projection.reactNativeBundlesById, ...catalog.projection.reactNativeBundlesById },
        };
        const createPort = (invocationSurface: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['invocationSurface'],
            hostAction?: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['hostAction']) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction, readProjection: () => projection, readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        });
        let catalogCaller: unknown;
        let catalogAuthority: unknown;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            listContributedActionDefinitions: () => createPort('ui').listCurrentContributedActionDefinitions?.('allSurfaces') ?? [],
            invokeContributedAction: request => {
                if (request.action.localId === catalogId) {
                    catalogCaller = request.context.actionCaller;
                    catalogAuthority = request.context.authority;
                }
                // Admission at the Machine Action transport is the boundary where the launch can refuse.
                if (receipt && request.action.localId === TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1) {
                    const invocation = resolveOriginalAccountPluginInvocation(request.context.actionCaller);
                    if (!invocation.ok) return Promise.resolve(invocation);
                }
                return executeCurrentUiContextContributedAction(request, {
                    execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
                });
            },
        }));
        const execute = createFrontDoorActionExecute(executor);
        const unregister = registerCurrentUiContextActionPort(createPort);
        const withdrawProjection = publishCommittedAppShellPluginUiProjection(() => projection);
        const artifact = createServiceHealthNoticeArtifactFixture(scope.serverId, { ownerAccountId: scope.accountId });
        const entry = receipt ? { kind: 'deploymentReceipt' as const, serverId: scope.serverId,
            environmentId: 'receipt-environment', deploymentId: 'failed-receipt' }
            : { artifact, header: readAccountNoticeArtifactHeader(artifact, scope.accountId)! };
        const investigation = createAccountNoticeInvestigation({ scope, execute, isCurrent: () => lifetime.isCurrent(),
            binding: { pluginId, action: parent.action.id } });
        await parent.composition.unload();
        try {
            expect((await parent.composition.reconcile([parent.activation, catalog.activation])).map(attempt => attempt.result))
                .toEqual([{ ok: true }, { ok: true }]);
            await expect(execute('action.invoke', { action: { pluginId, localId: catalogId }, input: {} },
                { surface: 'ui', serverId: scope.serverId })).resolves.toMatchObject({ ok: true, result: catalogAnswer });
            expect(investigation.isEligible(entry)).toBe(true);
            newSessionNavigation.mockClear();
            const outcome = await investigation.launch(entry, receipt ? { delivery: 'compose' } : {});
            if (receipt) {
                expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'started', handoff: { kind: 'composed' } });
                const route = newSessionNavigation.mock.calls[0]?.[0] as { pathname: string; params: { draftId: string } } | undefined;
                expect(route?.pathname).toBe('/new');
                const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
                expect(readNewSessionDraftFromRepository({ scope, draftId: route!.params.draftId }))
                    .toMatchObject({ input: 'Investigate Receipt failed-receipt.' });
                expect(catalogCaller).toMatchObject({ contributionLocalId: parent.action.id,
                    occurrenceId: parent.action.occurrenceId, sourceCustody: custody });
            } else {
                expect(outcome).toMatchObject({ kind: 'unavailable', code: 'configuredActionUnavailable', recovery: 'configure' });
            }
            expect(catalogCaller).toMatchObject({ kind: 'plugin', pluginId, originSurface: 'ui' });
            expect(catalogAuthority).toBe('account_automation');
            await expect(createPort('plugin').invokeAction!({ action: { pluginId, localId: catalogId }, input: {} }))
                .resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_origin_unavailable' });
        } finally {
            unregister(); withdrawProjection(); await parent.composition.unload(); lifetime.retire();
        }
    });

    it.each([true, false])('preserves nested Account Action failure metadata with one declaration read on a projection miss (mounted=%s)', async mounted => {
        const accountLifetime = clientAccountLifetime();
        const pluginId = 'acme.account-failure';
        const localId = 'refresh-index';
        const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({ ...CLIENT_ACTION_ARTIFACT_GRAPH,
            digest: `sha256:${'b'.repeat(64)}` });
        const targetDefinition = definePlugin({ id: pluginId, version: '1.2.3', actions: {
            [localId]: { title: 'Nested Account failure', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: CLIENT_ACTION_TARGET.artifactId,
                    exportName: CLIENT_ACTION_TARGET.exportName } }, run: async () => null },
        } });
        const parsed = ingestPluginManifestV2(targetDefinition.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        replacePluginAccountAvailabilityProjection({ scope: accountLifetime.scope, snapshot: { availabilityCursor: 1,
            materializations: [], snapshots: [], intentReads: [{ pluginId, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId, desiredVersion: parsed.manifest.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId, version: parsed.manifest.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest: parsed.manifest, collectionContracts: [],
                    uiSlots: [{ contributionId: localId, tier: 'reactNative', platform: 'web', artifactId: artifactGraph.artifactId,
                        artifactDigest: artifactGraph.digest, hostUiApiRange: artifactGraph.hostUiApiRange, artifactGraph }],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } }] } });
        const selected = readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecution(pluginId);
        if (selected.kind !== 'available') throw new Error('Expected a declared Account callee');
        const target = createClientActionActivation({ pluginId, localId, accountPlacement: true, artifactGraph,
            accountLifetime, accountManifest: targetDefinition.manifest, occurrenceId: selected.custodyId,
            accountHandler: async () => { throw new PluginError({
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
        const projection = mounted ? { ...parent.projection,
            actionsById: { ...parent.projection.actionsById, ...target.projection.actionsById },
            reactNativeBundlesById: { ...parent.projection.reactNativeBundlesById, ...target.projection.reactNativeBundlesById },
        } : parent.projection;
        const availabilityModule = await import('@/sync/domains/plugins/availability/projection');
        let declarationReads = 0;
        const availabilitySpy = vi.spyOn(availabilityModule, 'readPluginAccountAvailability').mockImplementation(scope => {
            const owner = readPluginAccountAvailability(scope);
            return { ...owner, ensureCurrentAccountExecution(id) {
                if (id === pluginId) declarationReads++;
                return owner.ensureCurrentAccountExecution(id);
            } };
        });
        await parent.composition.unload();
        try {
            expect((await parent.composition.reconcile([parent.activation, target.activation])).map(attempt => attempt.result))
                .toEqual([{ ok: true }, { ok: true }]);
            expect(await dispatchPluginSurfaceAction({
                action: { pluginId: parent.action.pluginId, localId: parent.action.id }, input: {}, clientAction: {},
                pluginUiProjection: projection,
                resolveContributedAction: identity => projection.actionsById[`${identity.pluginId}/${identity.localId}`] ?? null,
            })).toEqual({ ok: true, result: { code: 'source_temporarily_unavailable', retryable: true, message: 'Try again after reconnecting' } });
            expect(declarationReads).toBe(mounted ? 0 : 1);
        } finally {
            availabilitySpy.mockRestore();
            await parent.composition.unload();
            accountLifetime.retire();
        }
    });

    it.each([
        { capability: 'services', confirmed: true, direct: false },
        { capability: 'ui', confirmed: true, direct: false },
        { capability: 'services', confirmed: false, direct: false },
        { capability: 'ui', confirmed: false, direct: false },
        { capability: 'services', confirmed: true, direct: true },
        { capability: 'ui', confirmed: true, direct: true },
    ] as const)('carries admitted Account intent to nested writes through $capability: confirmed=$confirmed direct=$direct', async ({ capability, confirmed, direct }) => {
        const [{ createProfileOperations }, { createProfileActionExecuteV1 }, { LaunchProfileV2Schema }, { createPromptDocInLibrary }] = await Promise.all([
            import('@happier-dev/protocol/profiles/profileOperations'),
            import('@happier-dev/protocol/profiles/profileActionsV1'),
            import('@happier-dev/protocol/profiles/v2/schema'),
            import('@happier-dev/protocol/prompts/library/promptLibraryActionOperations'),
        ]);
        const accountLifetime = clientAccountLifetime();
        const profiles: import('@happier-dev/protocol/profiles/profileRecordV1').ProfileRecordV1[] = [];
        const contexts: ActionExecutorContext[] = [];
        const documents = new Map<string, import('@happier-dev/protocol/prompts/library/promptLibraryActionOperations').PromptLibraryStoredArtifact>();
        const store: import('@happier-dev/protocol/prompts/library/promptLibraryActionOperations').PromptLibraryArtifactStore = {
            read: async id => documents.get(id) ?? null,
            update: async ({ artifactId, header, body }) => { documents.set(artifactId, { id: artifactId, header, body,
                revision: { headerVersion: 1, bodyVersion: 2 } }); },
            create: async ({ header, body }) => {
                const artifactId = 'saved-prompt';
                documents.set(artifactId, { id: artifactId, header, body, revision: { headerVersion: 1, bodyVersion: 1 } });
                return artifactId;
            },
        };
        let confirmations = 0;
        let approvals = 0;
        const actionsSettings = normalizeActionsSettingsV1({ v: 1,
            actions: { 'launch_profiles.create': { approvalRequiredSurfaces: ['plugin'] },
                [formatQualifiedPluginActionId({ pluginId: CALLER_PLUGIN_ID, localId: 'refresh-index' })]: { approvalRequiredSurfaces: direct ? ['plugin'] : ['plugin', 'ui'] } } });
        // Only persistent Profile/approval storage and the native dialog are
        // substituted; registration, nested dispatch and Profile policy stay real.
        const operations = createProfileOperations({
            readCatalog: () => ({ source: 'destination', authority: 'active', controlRevision: 1,
                control: { revision: 1, record: { v: 1, phase: 'active', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } },
                status: 'ready', records: profiles.map(record => ({ record, revision: 1 })), diagnostics: [], referenceGuardRevision: 1 }),
            artifactsById: () => new Map(),
            writeRecord: async ({ record }) => { profiles.push(record); return { status: 'updated', id: record.id, revision: 1 }; },
            deleteRecord: async () => { throw new Error('Unexpected Profile deletion'); },
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            readActionsSettings: () => actionsSettings,
            profileActionExecute: async (request, context) => {
                contexts.push(context);
                return createProfileActionExecuteV1({ operations })(request, context);
            },
            promptDocCreate: async (request, context) => {
                if (context) contexts.push(context);
                return createPromptDocInLibrary({ store, request });
            },
            approvalsCreate: async () => { approvals++; return { artifactId: 'nested-profile-approval' }; },
        }));
        const profileInput = { expectedRevision: 'absent', profile: LaunchProfileV2Schema.parse({ v: 2, id: 'reviewed-default', name: 'Reviewed default',
            extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
            compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1 }) };
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            dangerLevel: 'writesRemote', surfaces: ['ui', 'plugin'],
            confirmationWhen: { presentUserUi: false },
            accountHandler: async (_input, context) => {
                if (capability === 'services') {
                    await context.services.actions.execute('launch_profiles.create', profileInput);
                    return context.services.actions.execute('prompt_doc.create', { title: 'Saved default', markdown: 'Fix it carefully.' });
                }
                await context.ui!.executeAction('launch_profiles.create', profileInput);
                return context.ui!.executeAction('prompt_doc.create', { title: 'Saved default', markdown: 'Fix it carefully.' });
            },
        });
        nestedActionConfirmation.onShow = approve => { confirmations++; approve(); };
        await activation.composition.unload();
        try {
            expect((await activation.composition.reconcile([activation.activation])).map(attempt => attempt.result)).toEqual([{ ok: true }]);
            const outcome = await dispatchPluginSurfaceAction({
                action: { pluginId: activation.action.pluginId, localId: activation.action.id }, input: {},
                invocationSurface: confirmed ? 'ui' : 'plugin', clientAction: {},
                originSurface: confirmed ? 'ui' : 'agent',
                pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action),
                hostAction: { execute: executor.execute, context: {
                    serverId: accountLifetime.scope.serverId, runtimeAccountId: accountLifetime.scope.accountId,
                    actionsSettings,
                    authority: confirmed ? 'present_user' : 'account_automation',
                    ...(confirmed ? {} : { interactivePresentation: 'unavailable' as const }),
                } },
            });
            if (confirmed) {
                expect(outcome, JSON.stringify({ outcome, confirmations, approvals })).toMatchObject({ ok: true, result: { ok: true, artifactId: 'saved-prompt' } });
                expect(profiles.map(record => record.id)).toEqual(['reviewed-default']);
                expect(documents.get('saved-prompt')?.body).toContain('Fix it carefully.');
                expect(contexts).toHaveLength(2);
                for (const context of contexts) expect(context).toEqual(expect.objectContaining({ surface: 'plugin', authority: 'account_automation',
                    actionCaller: expect.objectContaining({ kind: 'plugin', pluginId: activation.action.pluginId,
                        contributionLocalId: activation.action.id, occurrenceId: activation.action.occurrenceId }) }));
            } else {
                expect(outcome).toMatchObject({ ok: false, reason: 'action_interactive_review_required' });
                expect(profiles).toEqual([]);
                expect(contexts).toEqual([]);
                expect(documents.size).toBe(0);
            }
            expect(confirmations).toBe(confirmed && !direct ? 1 : 0);
            expect(approvals).toBe(0);
        } finally { nestedActionConfirmation.onShow = null; await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['account', 'materialized Machine', 'source-backed Machine'] as const)('retains %s client-executable custody through the nested Account host transport', async placement => {
        const [{ projectExternalActionRequesterInvocationContextV1 }, { resolveOriginalAccountPluginInvocation }] = await Promise.all([
            import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1'), import('@/sync/api/externalActionAccountTransport'),
        ]);
        const accountLifetime = clientAccountLifetime(rpcHomes.get('server-client-action')!.id);
        const accountSourceCustody = { kind: 'account_release' as const, pluginId: CALLER_PLUGIN_ID,
            version: '1.2.3', archiveDigestSha256: `sha256:${'a'.repeat(64)}` };
        const developmentSource = { kind: 'development' as const, registeredRootId: 'client-action-root' };
        const materializedSource = { kind: 'managed' as const, immutableGenerationId: 'client-generation', installSource: 'localPath' as const };
        const sourceCustody = placement === 'account' ? accountSourceCustody
            : placement === 'materialized Machine' ? materializedSource : developmentSource;
        const issued: unknown[] = [];
        const callers: unknown[] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            notificationsNotifyMe: async (_input, context) => {
                const caller = resolveOriginalAccountPluginInvocation(context.actionCaller);
                if (!caller.ok) return caller;
                callers.push(caller.pluginInvocation);
                issued.push(projectExternalActionRequesterInvocationContextV1(context));
                return { attemptedChannels: 1, deliveredChannels: 1 };
            },
        }));
        const activation = createClientActionActivation({ accountLifetime, ...(placement === 'account'
            ? { accountPlacement: true, accountSourceCustody,
                accountHandler: async (_input, context) => context.ui!.executeAction('notifications.notify_me', { message: 'Review ready' }) }
            : { ...(placement === 'materialized Machine' ? { machineSourceCustody: materializedSource }
                : { machineExecutionOrigin: { serverIdentityId: CLIENT_ACTION_ORIGIN.serverIdentityId, sourceRef: {
                    machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, pluginId: CALLER_PLUGIN_ID, sourceCustody: developmentSource,
                } } }),
                handler: async (_input, context) => context.ui.executeAction('notifications.notify_me', { message: 'Review ready' }) }) });
        await activation.composition.unload();
        try {
            expect((await activation.composition.reconcile([activation.activation])).map(attempt => attempt.result)).toEqual([{ ok: true }]);
            const outcome = await dispatchPluginSurfaceAction({
                action: { pluginId: activation.action.pluginId, localId: activation.action.id }, input: {},
                invocationSurface: 'ui', originSurface: 'ui', clientAction: {},
                pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action),
                hostAction: { execute: executor.execute, context: {
                    serverId: accountLifetime.scope.serverId, runtimeAccountId: accountLifetime.scope.accountId, authority: 'present_user',
                } },
            });
            expect(outcome, JSON.stringify(outcome)).toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
            expect(callers).toEqual([{ kind: 'clientPluginAction', clientActionBinding: {
                pluginId: CALLER_PLUGIN_ID, contributionLocalId: activation.action.id, occurrenceId: activation.action.occurrenceId,
                sourceCustody,
                ...(placement === 'account' ? { pluginVersion: accountSourceCustody.version }
                    : placement === 'materialized Machine' ? { materializationRef: CLIENT_ACTION_ORIGIN.materializationRef } : {}),
            } }]);
            expect(issued).toEqual([expect.objectContaining({ surface: 'plugin', authority: 'account_automation',
                caller: expect.objectContaining({ kind: 'plugin', pluginId: CALLER_PLUGIN_ID,
                    contributionLocalId: activation.action.id, occurrenceId: activation.action.occurrenceId, sourceCustody }) })]);
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('keeps Account execution local when an optional Machine transport is present', async () => {
        const accountLifetime = clientAccountLifetime();
        const machine = vi.fn<PluginSurfaceContributedActionTransport>(async () => { throw new Error('Account handler must not be sent to a Machine'); });
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async (_input, context) => ({ host: 'invoking-process', invocationId: context.invocationId ?? null,
                requestId: context.requestId ?? null }) });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            expect(await dispatchPluginSurfaceAction({
                actionRequestId: 'optional-machine-read-request',
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                clientAction: {}, contributedAction: { machineId: 'optional-provider-machine', serverId: 'server-client-action', execute: machine },
                pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action),
            })).toEqual({ ok: true, result: { host: 'invoking-process', invocationId: 'optional-machine-read-request',
                requestId: 'optional-machine-read-request' } });
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

    it.each(['mounted', 'host', 'host Session', 'host Run', 'host cold', 'Session operand', 'Session unavailable', 'Session outer unavailable', 'Session projection unavailable'] as const)('routes or refuses a nested Account Action using the selected Machine and UI origin (%s)', async placement => {
        const accountLifetime = clientAccountLifetime();
        const sessionOperand = placement.startsWith('Session ');
        const sourceId = 'acme.provider-source';
        const provider = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction({ pluginId: sourceId, localId: 'list' }), surfaces: ['plugin'],
            ...(sessionOperand ? { sessionTarget: { field: 'sessionId', cardinality: 'one' } } : {}) });
        clientActionSchemasByQualifiedId.set(`${sourceId}/list`, { inputSchema: {} });
        const origin = clientActionExecutionOrigin(sourceId);
        const executionOrigin = { ...origin, materializationRef: { ...origin.materializationRef, machineId: 'provider-machine' } };
        const published = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [sourceId]: { id: sourceId, displayName: 'Source', version: '1.2.3', enabled: true,
                source: { kind: 'local', locator: '/plugins/source' }, occurrenceId: provider.occurrenceId,
                executionOrigin, declaresContributionPoints: false } },
            actionsById: { [`${sourceId}/list`]: { ...provider, executionOrigin } }, familiesById: {},
        });
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
            ...(placement === 'Session outer unavailable' ? { sessionTarget: { field: 'sessionId', cardinality: 'one' as const } } : {}),
            accountHandler: async (_value, context) => context.services.actions.execute({ pluginId: sourceId, localId: 'list' },
                sessionOperand ? { sessionId: 'source-session' } : {}) });
        daemonRpc.mockImplementation(async request => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                if (placement === 'Session projection unavailable') throw new Error('Machine projection transport is unavailable');
                return { protocolVersion: 1, projection: published };
            }
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) return answerActionSchemasRead(request);
            const reply = await machine(request.machineId, request.payload);
            if (!reply.supported) throw new Error('Expected the Machine boundary to support the Action');
            return reply.result;
        });
        const { scopedHomeActionExecutor } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
        const executor = sessionOperand ? { execute: scopedHomeActionExecutor(accountLifetime.scope) }
            : createActionExecutor(createActionExecutorBoundaryFixture({}));
        if (sessionOperand) {
            const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
            const session = createSessionFixture({ id: 'source-session', encryptionMode: 'plain',
                metadata: { ...(placement === 'Session unavailable' || placement === 'Session outer unavailable' ? {} : { machineId: 'provider-machine' }), path: '/source-project' } });
            network.setHttpResponder(async (url, init) => new URL(String(url)).pathname === '/v2/sessions/source-session'
                ? Response.json(createPlainSessionByIdResponseFixture(session))
                : createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init));
        }
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const settleContributedAction: NonNullable<DispatchPluginSurfaceActionInput['settleContributedAction']> = async (_identity, options) => options.placement === 'daemon'
                ? { ok: false, code: 'unavailable', reason: 'plugin_surface_contributed_action_unavailable' }
                : { ok: true, binding: undefined };
            const outcome = await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                input: placement === 'Session outer unavailable' ? { sessionId: 'source-session' } : {},
                ...(placement === 'Session outer unavailable' ? { settleContributedAction } : {}),
                invocationSurface: 'ui', clientAction: {},
                ...(placement === 'mounted' ? {
                    contributedAction: { machineId: 'provider-machine', serverId: 'server-client-action', execute: machine },
                } : { hostAction: { execute: executor.execute, context: {
                    serverId: accountLifetime.scope.serverId, runtimeAccountId: accountLifetime.scope.accountId,
                    ...(placement === 'host' || placement === 'host cold' ? { externalActionTarget: { kind: 'machine' as const, machineId: 'provider-machine' } }
                        : placement === 'host Session' ? { defaultSessionMachineId: 'provider-machine' }
                            : placement === 'host Run' ? { executionRunTargetMachineId: 'provider-machine' }
                                : { defaultSessionMachineId: 'other-machine' }),
                } } }),
                pluginUiProjection: activation.projection,
                resolveContributedAction: identity => identity.pluginId === sourceId && placement !== 'host cold'
                    ? (sessionOperand ? { ...provider, occurrenceId: 'ambient-source-occurrence' } : provider)
                    : resolveExactClientAction(activation.action)(identity),
            });
            if (placement === 'Session unavailable' || placement === 'Session outer unavailable' || placement === 'Session projection unavailable') {
                expect(outcome).toMatchObject({ ok: false, reason: placement !== 'Session projection unavailable'
                    ? 'plugin_action_machine_required' : 'plugin_surface_action_projection_unavailable' });
                expect(requests).toHaveLength(0);
                return;
            }
            expect(outcome).toEqual({ ok: true, result: { rows: ['provider'] } });
            expect(requests).toHaveLength(1);
            expect(requests[0]).toMatchObject({ machineId: 'provider-machine', expectedContributorOccurrenceId: provider.occurrenceId,
                executionSurface: 'ui', invocation: { kind: 'clientPluginAction' } });
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['link', 'unlink', 'attach', 'remove'] as const)(
        'dispatches the declared Session PR %s through a mounted Account caller with zero confirmation dialogs', async operation => {
        const { PLUGIN_MANIFEST: github, GITHUB_TRIAGE_ACTION_IDS_V1 } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
        const { PLUGIN_MANIFEST: channels } = await import('../../../../../../packages/plugins/channels/src/manifest');
        const manifest = operation === 'link' || operation === 'unlink' ? github : channels;
        const id = manifest === github ? GITHUB_TRIAGE_ACTION_IDS_V1.linkSession : 'session-pull-request-binding-v1';
        const declaration = manifest.contributes.actions?.find(action => action.id === id);
        if (!declaration) throw new Error('Expected the Session PR relationship declaration');
        // Exercise the declaration's approval facts through production dispatch;
        // exact Session operand admission has its separate composed coverage below.
        const provider = PluginProjectedActionV2Schema.parse({
            ...resolveDaemonTargetAction({ pluginId: manifest.id, localId: id }),
            surfaces: declaration.surfaces, dangerLevel: declaration.dangerLevel,
            confirmation: declaration.confirmation, confirmationWhen: declaration.confirmationWhen,
        });
        const value = manifest === github ? { sessionId: 'session-a', linked: operation === 'link' }
            : { sessionId: 'session-a', kind: operation === 'attach' ? 'attach' : 'unlink' };
        // This boundary fixture carries only approval-relevant operands; the
        // owning plugin suites exercise the complete relationship input schema.
        clientActionSchemasByQualifiedId.set(buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: id }), {
            inputSchema: { type: 'object' },
        });
        const result = { status: operation === 'link' || operation === 'attach' ? 'linked' : 'unlinked' };
        const accountLifetime = clientAccountLifetime();
        let confirmations = 0;
        let writes = 0;
        nestedActionConfirmation.onShow = (_approve, reject) => { confirmations += 1; reject(); };
        // Machine transport is the system boundary. Keep the daemon's shared
        // physical-origin policy real; no fabricated confirmed intent is accepted.
        const machine: PluginSurfaceContributedActionTransport = async (_machineId, request) => {
            if (pluginActionRequiresPresentUserIntent(provider, request.executionSurface, request.input, 'account_automation')
                && request.presentUserIntent !== 'confirmed') {
                return { supported: true, result: { ok: false, code: 'plugin_action_current_intent_unavailable' } };
            }
            expect(request.executionSurface).toBe('ui');
            expect(request.presentUserIntent).toBeUndefined();
            writes += 1;
            return { supported: true, result: { ok: true, result } };
        };
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async (_value, context) => context.services.actions.execute({ pluginId: manifest.id, localId: id }, value) });
        await activation.composition.unload();
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let outcome: unknown;
        try {
            await activation.composition.reconcile([activation.activation]);
            const api = createPluginSurfaceActionHostApi({ surfaceContext: surfaceContext(),
                callerBinding: mountedCallerBinding({ machineId: 'provider-machine' }), callerSourceCustody: TARGET_SOURCE_CUSTODY,
                clientAction: {}, contributedAction: { machineId: 'provider-machine', serverId: 'server-client-action', execute: machine },
                pluginUiProjection: activation.projection,
                resolveContributedAction: identity => identity.pluginId === manifest.id ? provider : resolveExactClientAction(activation.action)(identity),
            });
            screen = await renderScreen(React.createElement('button', { testID: 'link-direct', onPress: async () => {
                outcome = await api.handleRequest(executeActionRequest({ action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {} }));
            } }));
            await screen.pressByTestIdAsync('link-direct');
            expect(confirmations).toBe(0);
            expect(outcome).toEqual(result);
            expect(writes).toBe(1);
        } finally {
            screen?.unmount();
            nestedActionConfirmation.onShow = null;
            await activation.composition.unload(); accountLifetime.retire();
        }
    });

    it.each(['executed', 'presenterUnavailable'] as const)('carries a bound inline gesture through the registered Account Action entry (%s)', async settlement => {
        const { createPluginSurfaceActionControls } = await import('./pluginSurfaceActionControls');
        const { Modal } = await import('@/modal');
        const accountLifetime = clientAccountLifetime();
        let writes = 0;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            dangerLevel: 'writesLocal', confirmationWhen: { presentUserUi: settlement === 'presenterUnavailable' },
            accountHandler: async (_input, context) => { writes++; return { status: 'updated', requestId: context.requestId ?? null }; } });
        await activation.composition.unload();
        const createPort = (invocationSurface: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['invocationSurface'],
            hostAction?: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['hostAction']) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction, readProjection: () => activation.projection, readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            listContributedActionDefinitions: () => createPort('ui').listCurrentContributedActionDefinitions?.('allSurfaces') ?? [],
            invokeContributedAction: request => executeCurrentUiContextContributedAction(request, {
                execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
            }),
        }));
        const unregister = registerCurrentUiContextActionPort(createPort);
        const bound = createPluginSurfaceActionControls({ pluginId: CALLER_PLUGIN_ID, surfaceId: 'surfacePlacement:test',
            hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
                serverId: accountLifetime.scope.serverId, runtimeAccountId: accountLifetime.scope.accountId,
            } }, signal: new AbortController().signal,
            isCurrent: () => true, captureCurrentBinding: () => () => true });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let outcome: unknown;
        const show = settlement === 'presenterUnavailable' ? vi.spyOn(Modal, 'show').mockImplementation(config => {
            queueMicrotask(() => config.onHostUnmount?.());
            return 'unmounted-inline-confirmation';
        }) : undefined;
        try {
            await activation.composition.reconcile([activation.activation]);
            screen = await renderScreen(React.createElement('button', { testID: 'inline-write', onPress: async () => {
                outcome = await bound.commit({ action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                    prepare: () => ({ input: {} }), onSettled: value => value }, undefined);
            } }));
            await screen.pressByTestIdAsync('inline-write');
            const uuid = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            if (settlement === 'executed') expect(outcome).toMatchObject({ ok: true, result: { status: 'updated', requestId: uuid } });
            else expect(outcome).toMatchObject({ ok: false, errorCode: 'plugin_action_current_intent_unavailable', requestId: uuid,
                details: { details: { currentIntentPresentation: { status: 'unavailable', requestId: uuid } } } });
            expect(writes).toBe(settlement === 'executed' ? 1 : 0);
        } finally { show?.mockRestore(); screen?.unmount(); bound.dispose(); unregister(); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['approved', 'rejected'] as const)('settles UI current intent before an Account Action invokes a nested Machine mutation (%s)', async decision => {
        const accountLifetime = clientAccountLifetime();
        const sourceId = 'acme.provider-source';
        const provider = PluginProjectedActionV2Schema.parse({
            ...resolveDaemonTargetAction({ pluginId: sourceId, localId: 'link-session' }),
            surfaces: ['plugin'], dangerLevel: 'writesLocal', confirmation: { title: 'Link this Session?' },
        });
        let confirmations = 0;
        let writes = 0;
        nestedActionConfirmation.onShow = (approve, reject) => {
            confirmations += 1;
            expect(writes).toBe(0);
            if (decision === 'approved') approve();
            else reject();
        };
        // Substitute the Machine transport only. Its existing physical-origin
        // policy refuses a mutation without current intent before any write.
        const machine: PluginSurfaceContributedActionTransport = async (_machineId, request) => {
            if (pluginActionRequiresPresentUserIntent(provider, request.executionSurface, request.input, 'account_automation')
                && request.presentUserIntent !== 'confirmed') {
                return { supported: true, result: { ok: false, code: 'plugin_action_current_intent_unavailable' } };
            }
            writes += 1;
            return { supported: true, result: { ok: true, result: { status: 'linked' } } };
        };
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            accountHandler: async (_value, context) => context.services.actions.execute({ pluginId: sourceId, localId: provider.id }, {}) });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const outcome = await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                invocationSurface: 'ui', clientAction: {},
                contributedAction: { machineId: 'provider-machine', serverId: 'server-client-action', execute: machine },
                pluginUiProjection: activation.projection,
                resolveContributedAction: identity => identity.pluginId === sourceId ? provider : resolveExactClientAction(activation.action)(identity),
            });
            if (decision === 'approved') expect(outcome).toEqual({ ok: true, result: { status: 'linked' } });
            else expect(outcome).toMatchObject({ ok: false });
            expect(confirmations).toBe(1);
            expect(writes).toBe(decision === 'approved' ? 1 : 0);
        } finally {
            nestedActionConfirmation.onShow = null;
            await activation.composition.unload(); accountLifetime.retire();
        }
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
                page: { pluginId: CALLER_PLUGIN_ID } as PluginPage,
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

    it.each([true, false, 'Session origin', 'mounted Online Auto', 'mounted offline', 'mounted native read'] as const)('observes and reads a Machine source through the Account dispatcher with Machine available=%s', async placement => {
        const mounted = typeof placement === 'string' && placement.startsWith('mounted');
        const machineAvailable = placement !== false && placement !== 'mounted offline';
        const sessionTarget = placement === 'Session origin' ? { field: 'sessionId', cardinality: 'one' as const } : undefined;
        const accountLifetime = clientAccountLifetime(rpcHomes.get('server-client-action')!.id);
        const schema = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
        const protocol = defineContributionProtocol({ id: 'source', version: 1, operations: {
            inspect: { required: true, input: { kind: 'protocolDefined', schema }, resultSchema: schema,
                action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
        } });
        const target = definePlugin({ id: CALLER_PLUGIN_ID, version: '1.2.3',
            contributionPoints: { sources: protocol.point() }, actions: {
                'refresh-index': { title: 'Read source', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe',
                    ...(sessionTarget ? { sessionTarget } : {}),
                    execution: { target: 'account', account: { artifactId: CLIENT_ACTION_TARGET.artifactId, exportName: CLIENT_ACTION_TARGET.exportName } },
                    ...(sessionTarget ? { inputSchema: defineProtocolObject({ sessionId: defineProtocolString() }, { policy: 'closed' }) } : {}),
                    run: async () => null },
            } });
        const source = definePlugin({ id: 'acme.machine-source', version: '1.0.0', actions: {
            inspect: { title: 'Read', surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true, execution: { target: 'daemon' },
                inputSchema: schema, resultSchema: schema, run: async value => value },
        }, contributesTo: { [CALLER_PLUGIN_ID]: { sources: {
            external: protocol.contribute({ operations: { inspect: protocol.operations.inspect.bind('inspect') } }),
        } } } });
        const parsedTarget = ingestPluginManifestV2(target.manifest);
        const parsedSource = ingestPluginManifestV2(source.manifest);
        if (!parsedTarget.ok || !parsedSource.ok) throw new Error(JSON.stringify({
            target: parsedTarget.ok ? null : parsedTarget, source: parsedSource.ok ? null : parsedSource,
        }));
        replacePluginAccountAvailabilityProjection({ scope: accountLifetime.scope, snapshot: {
            availabilityCursor: 1, materializations: [], snapshots: [], intentReads: (mounted ? [parsedTarget.manifest] : [parsedTarget.manifest, parsedSource.manifest]).map(manifest => ({ pluginId: manifest.id, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId: manifest.id, version: manifest.version },
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest,
                    collectionContracts: [], uiSlots: manifest.id === CALLER_PLUGIN_ID ? [{ contributionId: 'refresh-index', tier: 'reactNative', platform: 'web',
                        artifactId: CLIENT_ACTION_ARTIFACT_GRAPH.artifactId, artifactDigest: CLIENT_ACTION_ARTIFACT_GRAPH.digest,
                        hostUiApiRange: CLIENT_ACTION_ARTIFACT_GRAPH.hostUiApiRange, artifactGraph: CLIENT_ACTION_ARTIFACT_GRAPH }] : [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } })),
        } });
        const selected = readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecution(CALLER_PLUGIN_ID);
        if (selected.kind !== 'available') throw new Error('Expected current Account target');
        let invalidations = 0;
        let observerOpens = 0;
        let observerCloses = 0;
        let sourceValue = 'initial source';
        let selectedOccurrence: string | undefined;
        let publish: (() => void) | undefined;
        let sessionReads = 0;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            ...(sessionTarget ? { sessionTarget } : {}),
            accountManifest: target.manifest, occurrenceId: selected.custodyId, accountHandler: async (_value, context) => {
                const observation = context.services.targetedContributions.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
                let native: import('@happier-dev/plugin-sdk').Disposable | undefined;
                try {
                    const snapshot = await observation.readCurrent();
                    if (placement === 'mounted native read') {
                        expect(snapshot.contributions).toHaveLength(1);
                        return await context.services.actions.executeAdmittedTargetedOperation(
                            snapshot.contributions[0]!.operations.inspect, { key: 'source read' });
                    }
                    if (mounted) return { sources: snapshot.contributions.map(contribution => contribution.contributor.pluginId) };
                    expect(snapshot.contributions).toHaveLength(1);
                    if (sessionTarget) {
                        const placementReads = sessionReads;
                        await observation.readCurrent();
                        expect(sessionReads).toBe(placementReads);
                    }
                    selectedOccurrence = snapshot.contributions[0]!.operations.inspect.identity.contributor.occurrenceId;
                    try {
                        native = await context.services.actions.observeAdmittedTargetedOperation(
                            snapshot.contributions[0]!.operations.inspect, { key: 'source read' }, () => { invalidations++; });
                        // Dependency admission must not run the native read. A real
                        // source change is delivered before its consumer rereads.
                        expect(requests).toHaveLength(0);
                        await vi.waitFor(() => expect(publish).toBeDefined());
                        publish!();
                        await vi.waitFor(() => expect(invalidations).toBe(1));
                        return await context.services.actions.executeAdmittedTargetedOperation(snapshot.contributions[0]!.operations.inspect, { key: 'source read' });
                    } catch (error) {
                        if (!machineAvailable && isPluginError(error)) return { code: error.code };
                        throw error;
                    }
                } finally { await native?.dispose(); observation.dispose(); }
            } });
        const provider = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction({ pluginId: source.manifest.id, localId: 'inspect' }),
            occurrenceId: 'machine-source-current', surfaces: ['plugin'] });
        const origin = clientActionExecutionOrigin(source.manifest.id);
        const executionOrigin = { ...origin, materializationRef: { ...origin.materializationRef, machineId: 'provider-machine' } };
        const published = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [source.manifest.id]: { id: source.manifest.id, displayName: 'Source', version: '1.0.0', enabled: true,
                source: { kind: 'local', locator: '/plugins/source' }, occurrenceId: provider.occurrenceId,
                executionOrigin, declaresContributionPoints: false } },
            actionsById: { [`${source.manifest.id}/inspect`]: { ...provider, executionOrigin } }, familiesById: {},
        });
        const requests: ReturnType<typeof DaemonPluginStructuredMessageActionExecuteRequestSchema.parse>[] = [];
        daemonRpc.mockImplementation(async (request: { method: string; payload: unknown; onIssued?: () => void }) => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection: published };
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return {
                status: 'sourceDeclarations', pluginId: CALLER_PLUGIN_ID, sourceDeclarations: [{ occurrenceId: provider.occurrenceId,
                    sourceCustody: { kind: 'development', registeredRootId: 'machine-source-root' },
                    manifest: { id: parsedSource.manifest.id, contributes: { actions: parsedSource.manifest.contributes.actions,
                        pluginContributionPoints: [], targetedPluginContributions: parsedSource.manifest.contributes.targetedPluginContributions,
                        ui: { renderers: [] } } } }],
            };
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) {
                observerOpens++;
                expect(request.payload).toMatchObject({ callerPluginId: source.manifest.id,
                    expectedCallerOccurrenceId: provider.occurrenceId,
                    resource: { actionRead: { qualifiedActionId: `${source.manifest.id}/inspect`,
                        expectedContributorOccurrenceId: provider.occurrenceId, requiredReadOnly: true,
                        invocation: { kind: 'clientPluginAction', clientActionBinding: { pluginId: CALLER_PLUGIN_ID } } } } });
                return { ok: true, subscriptionId: (request.payload as { subscriptionId: string }).subscriptionId };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT) {
                const subscriptionId = (request.payload as { subscriptionId: string }).subscriptionId;
                return await new Promise(resolve => { publish = () => {
                    sourceValue = 'changed source';
                    resolve({ ok: true, status: 'event', event: { version: 1, subscriptionId, kind: 'readInvalidated' } });
                }; });
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) {
                observerCloses++;
                return { ok: true, closed: true };
            }
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) throw new Error('Unexpected Machine request');
            requests.push(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload));
            return { ok: true, result: { key: sourceValue } };
        });
        await activation.composition.unload();
        if (sessionTarget) {
            const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
            const session = createSessionFixture({ id: 'source-session', encryptionMode: 'plain',
                metadata: { machineId: 'provider-machine', path: '/source-project' } });
            network.setHttpResponder(async (url, init) => {
                if (new URL(String(url)).pathname === '/v2/sessions/source-session') {
                    sessionReads++;
                    return Response.json(createPlainSessionByIdResponseFixture(session));
                }
                return createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init);
            });
        }
        try {
            await activation.composition.reconcile([activation.activation]);
            // Use the Account producer's declaration: a hand-built Action used
            // to hide dropped Session placement facts in this composed path.
            const accountProjection = readPluginAccountAvailability(accountLifetime.scope).readAccountUiProjection();
            const projection = { ...activation.projection, actionsById: {
                ...activation.projection.actionsById, ...accountProjection?.actionsById,
                ...(placement === 'mounted native read' ? {} : { [`${source.manifest.id}/inspect`]: provider }),
            } };
            const controller = mounted ? createBoundPluginSurfaceController({ facts: {
                ...surfaceContext(), machineId: 'provider-machine', serverId: accountLifetime.scope.serverId,
                occurrenceId: selected.custodyId,
                accountExecutionOrigin: { ...accountLifetime.scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody },
                accountLifetime, interactionEnabled: true, daemonInteractionEnabled: false,
                daemonReachable: machineAvailable, pluginUiProjection: projection,
            } }) : null;
            if (controller) onTestFinished(() => controller.dispose());
            const outcome = controller ? await controller.hostApi.handleRequest(executeActionRequest({
                action: activation.action.id, input: {},
            })) : sessionTarget ? await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: { sessionId: 'source-session' },
                clientAction: {}, pluginUiProjection: projection,
                resolveContributedAction: createPluginUiProjectedActionResolver(projection.actionsById),
                hostAction: { execute: (await import('@/sync/ops/actions/scopedHomeActionExecutor')).scopedHomeActionExecutor(accountLifetime.scope),
                    context: { serverId: accountLifetime.scope.serverId, runtimeAccountId: accountLifetime.scope.accountId } },
            }) : await dispatchPluginResolvedSemanticCommand({ projection, callerPluginId: CALLER_PLUGIN_ID,
                command: { kind: 'executeAction', action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {} },
                scopedLaunchFacts: { serverId: accountLifetime.scope.serverId, machineId: machineAvailable ? 'provider-machine' : null, interactionEnabled: true },
                accountLifetime, scopeIsCurrent: () => accountLifetime.isCurrent(),
            });
            if (mounted) {
                expect(outcome).toEqual(placement === 'mounted native read'
                    ? { key: 'initial source' } : { sources: machineAvailable ? [source.manifest.id] : [] });
                expect(requests).toHaveLength(placement === 'mounted native read' ? 1 : 0);
                return;
            }
            expect(outcome).toEqual({ ok: true, result: machineAvailable ? { key: 'changed source' } : { code: 'plugin_action_machine_required' } });
            if (machineAvailable) expect(selectedOccurrence).toBe(provider.occurrenceId);
            expect(requests).toHaveLength(machineAvailable ? 1 : 0);
            expect(observerOpens).toBe(machineAvailable ? 1 : 0);
            if (machineAvailable) await vi.waitFor(() => expect(observerCloses).toBe(1));
            publish?.();
            await Promise.resolve();
            expect(invalidations).toBe(machineAvailable ? 1 : 0);
            if (machineAvailable) expect(requests[0]).toMatchObject({ machineId: 'provider-machine', qualifiedActionId: `${source.manifest.id}/inspect`,
                expectedContributorOccurrenceId: provider.occurrenceId, executionSurface: 'ui' });
        } finally {
            await activation.composition.unload(); accountLifetime.retire(); clearPluginAccountAvailabilityProjection();
        }
    });

    it.each(['demand', 'subscription', 'account'] as const)('admits Resource reads and dependency observation without running it to observe, retiring on %s', async termination => {
        const accountLifetime = clientAccountLifetime();
        let reads = 0;
        let disposed = 0;
        let publish = () => {};
        let observerSignal: AbortSignal | undefined;
        let allowSession = true;
        let resolutions = 0;
        const callers: unknown[] = [];
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            surfaces: ['plugin'], readOnly: { op: 'eq', path: 'kind', value: 'get' },
            sessionTarget: { field: 'sessionId', cardinality: 'one' },
            inputSchema: { type: 'object', properties: { kind: { enum: ['get', 'configure'] }, sessionId: SessionTargetV1ProtocolSchema.jsonSchema }, required: ['kind'], additionalProperties: false },
            accountHandler: async (_value, context) => { reads++; callers.push(context.caller); return { value: 'read' }; },
            observeRead: (_value, invalidate, context) => {
                expect(context.ui).toBeUndefined();
                observerSignal = context.signal; callers.push(context.caller); publish = invalidate;
                return { dispose() { disposed++; } };
            } });
        await activation.composition.unload();
        const demand = new AbortController();
        const invalidated = vi.fn();
        let subscription: import('@happier-dev/plugin-sdk').Disposable | undefined;
        const createPort = (invocationSurface: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['invocationSurface'],
            hostAction?: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['hostAction']) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction, readProjection: () => activation.projection, readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            listContributedActionDefinitions: () => createPort('plugin').listCurrentContributedActionDefinitions?.('allSurfaces') ?? [],

            resolveSessionReference: async ({ sessionId }) => {
                resolutions++;
                return allowSession ? { kind: 'unique', address: { serverId: accountLifetime.scope.serverId, sessionId: sessionId! } }
                    : { kind: 'none' };
            },
            invokeContributedAction: request => executeCurrentUiContextContributedAction(request, {
                execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
            }),
        }));
        const unregister = registerCurrentUiContextActionPort(createPort);
        try {
            await activation.composition.reconcile([activation.activation]);
            const origin = activation.projection.actionsById[`${CALLER_PLUGIN_ID}/${activation.action.id}`]!.hostAccountOrigin!;
            const dispatch = (kind: string, observe = false, sessionId?: string | { selector: 'manager' }) => dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: { kind, ...(sessionId ? { sessionId } : {}) },
                invocationSurface: 'plugin', originSurface: 'ui', clientAction: { sessionId: 'selected-session' },
                callerPluginId: CALLER_PLUGIN_ID,
                resourceCaller: { pluginId: CALLER_PLUGIN_ID, serverId: accountLifetime.scope.serverId, contributionLocalId: 'status-resource',
                    occurrenceId: activation.action.occurrenceId, sourceCustody: origin.sourceCustody,
                    sessionId: 'selected-session' },
                requiredReadOnly: true, ...(observe ? { readObservation: { invalidate() {
                    // The caller-owned sink keeps its Account authority after the target observer settles.
                    if (accountLifetime.isCurrent() && !demand.signal.aborted) invalidated();
                },
                    accept(value: import('@happier-dev/plugin-sdk').Disposable) { subscription = value; } } } : {}),
                signal: demand.signal, isCurrent: () => accountLifetime.isCurrent(),
                hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
                    serverId: accountLifetime.scope.serverId, defaultSessionId: 'selected-session', authority: 'account_automation',
                } },
                pluginUiProjection: activation.projection, resolveContributedAction: resolveExactClientAction(activation.action),
            });
            expect(await dispatch('configure')).toMatchObject({ ok: false, reason: 'plugin_action_read_only_required' });
            expect(await dispatch('get', false, 'another-session')).toMatchObject({ ok: false, reason: 'plugin_action_resource_session_mismatch' });
            expect(await dispatch('get', true, { selector: 'manager' })).toMatchObject({ ok: false, reason: 'plugin_action_resource_session_mismatch' });
            expect(resolutions).toBe(0);
            allowSession = false;
            expect(await dispatch('get', true, 'selected-session')).toMatchObject({ ok: false });
            expect(reads).toBe(0);
            expect(observerSignal).toBeUndefined();
            allowSession = true;
            expect(await dispatch('get', false, 'selected-session')).toEqual({ ok: true, result: { value: 'read' } });
            expect(await dispatch('get', true, 'selected-session')).toEqual({ ok: true, result: null });
            expect(reads).toBe(1);
            expect(observerSignal?.aborted).toBe(false);
            expect(callers).toEqual([expect.objectContaining({ kind: 'plugin', pluginId: CALLER_PLUGIN_ID,
                contribution: { id: 'status-resource', qualifiedId: `${CALLER_PLUGIN_ID}/resources/status-resource` } }),
                expect.objectContaining({ contribution: { id: 'status-resource', qualifiedId: `${CALLER_PLUGIN_ID}/resources/status-resource` } })]);
            publish(); expect(invalidated).toHaveBeenCalledTimes(1);
            if (termination === 'demand') demand.abort();
            else if (termination === 'account') accountLifetime.retire();
            else await subscription?.dispose();
            expect(observerSignal?.aborted).toBe(true);
            expect(disposed).toBe(1);
            publish(); expect(invalidated).toHaveBeenCalledTimes(1);
            subscription?.dispose(); expect(disposed).toBe(1);
        } finally { unregister(); demand.abort(); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['admitted', 'ordinary', 'selector', 'shorthand'] as const)('observes an admitted external Account source operation through the same registered dependency path without running either Action (%s)', async observationKind => {
        const accountLifetime = clientAccountLifetime();
        const schema = defineProtocolObject({ key: defineProtocolString(),
            sessionId: observationKind === 'admitted' ? defineProtocolString() : SessionTargetV1ProtocolSchema,
        }, { policy: 'closed' });
        const relation = defineContributionProtocol({ id: 'observed-source', version: 1, operations: {
            inspect: { required: true, input: { kind: 'protocolDefined', schema }, resultSchema: schema,
                action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
        } });
        const execution = { target: 'account' as const, account: { artifactId: CLIENT_ACTION_TARGET.artifactId,
            exportName: CLIENT_ACTION_TARGET.exportName } };
        const target = definePlugin({ id: CALLER_PLUGIN_ID, version: '1.2.3', contributionPoints: { sources: relation.point() }, actions: {
            'refresh-index': { title: 'Observe source', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
                execution, run: async () => null },
        } });
        const source = definePlugin({ id: 'example.observed-source', version: '1.2.3', actions: {
            inspect: { title: 'Inspect source', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
                execution, sessionTarget: { field: 'sessionId', cardinality: 'one' }, inputSchema: schema, resultSchema: schema, run: async value => value },
        }, contributesTo: { [CALLER_PLUGIN_ID]: { sources: {
            personal: relation.contribute({ operations: { inspect: relation.operations.inspect.bind('inspect') } }),
        } } } });
        const manifests = [target.manifest, source.manifest].map(manifest => {
            const parsed = ingestPluginManifestV2(manifest);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
            return parsed.manifest;
        });
        replacePluginAccountAvailabilityProjection({ scope: accountLifetime.scope, snapshot: {
            availabilityCursor: 1, materializations: [], snapshots: [], intentReads: manifests.map(manifest => ({ pluginId: manifest.id, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId: manifest.id, version: manifest.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } })),
        } });
        const selectedTarget = readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecution(target.manifest.id);
        const selectedSource = readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecution(source.manifest.id);
        if (selectedTarget.kind !== 'available' || selectedSource.kind !== 'available') throw new Error('Expected both admitted Account plugins');
        let reads = 0;
        let publish = () => {};
        let disposed = 0;
        let nestedSignal: AbortSignal | undefined;
        const sourceActivation = createClientActionActivation({ pluginId: source.manifest.id, localId: 'inspect',
            accountPlacement: true, accountLifetime, accountManifest: source.manifest, occurrenceId: selectedSource.custodyId,
            sessionTarget: { field: 'sessionId', cardinality: 'one' },
            surfaces: ['plugin'], inputSchema: schema.jsonSchema, outputSchema: schema.jsonSchema,
            accountHandler: async value => { reads++; return value; },
            observeRead: (_value, invalidate, context) => { nestedSignal = context.signal; publish = invalidate;
                return { dispose() { disposed++; } }; },
        });
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime, accountManifest: target.manifest,
            occurrenceId: selectedTarget.custodyId, surfaces: ['plugin'], accountHandler: async () => { reads++; return null; },
            observeRead: async (_value, invalidate, context) => {
                if (observationKind !== 'admitted') {
                    return await context.services.actions.observe(source.actionContracts.inspect, { key: 'selected',
                        sessionId: observationKind === 'selector' ? { selector: 'manager' }
                            : observationKind === 'shorthand' ? 'workers' : 'selected-session',
                    }, invalidate);
                }
                const catalog = context.services.targetedContributions.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
                try {
                    const snapshot = await catalog.readCurrent();
                    const operation = snapshot.contributions[0]!.operations.inspect;
                    const observer = await context.services.actions.observeAdmittedTargetedOperation(operation,
                        { key: 'selected', sessionId: 'selected-session' }, invalidate);
                    return { async dispose() { catalog.dispose(); await observer.dispose(); } };
                } catch (error) { catalog.dispose(); throw error; }
            },
        });
        const invalidated = vi.fn();
        let observer: import('@happier-dev/plugin-sdk').Disposable | undefined;
        const actions = { ...activation.projection.actionsById, ...sourceActivation.projection.actionsById };
        const projection = { ...activation.projection, actionsById: actions };
        const createPort = (invocationSurface: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['invocationSurface'],
            hostAction?: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['hostAction']) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction, readProjection: () => projection, readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            listContributedActionDefinitions: () => createPort('plugin').listCurrentContributedActionDefinitions?.('allSurfaces') ?? [],

            resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: { serverId: accountLifetime.scope.serverId, sessionId: sessionId! } }),
            invokeContributedAction: request => executeCurrentUiContextContributedAction(request, {
                execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
            }),
        }));
        const unregister = registerCurrentUiContextActionPort(createPort);
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation, sourceActivation.activation]);
            const rpcCount = daemonRpc.mock.calls.length;
            const outcome = await dispatchPluginSurfaceAction({ action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                invocationSurface: 'plugin', originSurface: 'ui', clientAction: {}, requiredReadOnly: true,
                resolveContributedAction: identity => actions[`${identity.pluginId}/${identity.localId}`] ?? null,
                readObservation: { invalidate: invalidated, accept(value) { observer = value; } },
                hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
                    serverId: accountLifetime.scope.serverId, defaultSessionId: 'selected-session', authority: 'account_automation',
                } },
            });
            if (observationKind === 'selector' || observationKind === 'shorthand') {
                expect(outcome).toMatchObject({ ok: false, reason: 'plugin_action_read_observation_session_unresolved' });
                expect(reads).toBe(0);
                expect(nestedSignal).toBeUndefined();
                return;
            }
            expect(outcome).toEqual({ ok: true, result: null });
            expect(daemonRpc.mock.calls).toHaveLength(rpcCount);
            expect(reads).toBe(0);
            expect(nestedSignal?.aborted).toBe(false);
            publish(); expect(invalidated).toHaveBeenCalledTimes(1);
            await observer?.dispose();
            expect(nestedSignal?.aborted).toBe(true);
            expect(disposed).toBe(1);
            publish(); expect(invalidated).toHaveBeenCalledTimes(1);
        } finally { unregister(); await observer?.dispose(); await activation.composition.unload(); accountLifetime.retire(); clearPluginAccountAvailabilityProjection(); }
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

    it.each(['target', 'caller', 'late-target'] as const)('invalidates a demanded Resource when its external Action registration retires, preserving %s cleanup', async retirement => {
        const accountLifetime = clientAccountLifetime();
        const demand = new AbortController();
        let reads = 0;
        let disposed = 0;
        let publish = () => {};
        let settleObserver: ((subscription: import('@happier-dev/plugin-sdk').Disposable) => void) | undefined;
        const owner = createClientActionActivation({ accountPlacement: true, accountLifetime, surfaces: ['plugin'], readOnly: true,
            accountHandler: async () => { reads++; return null; } });
        const target = createClientActionActivation({ pluginId: 'example.observed-dependency', accountPlacement: true, accountLifetime,
            surfaces: ['plugin'], readOnly: true, accountHandler: async () => { reads++; return null; },
            observeRead: (_input, invalidate) => {
                publish = invalidate;
                if (retirement === 'late-target') return new Promise(resolve => { settleObserver = resolve; });
                return { dispose() { disposed++; } };
            } });
        const invalidated = vi.fn();
        const accept = vi.fn();
        await owner.composition.unload();
        try {
            await owner.composition.reconcile([owner.activation, target.activation]);
            const ownerRegistration = resolvePluginUiClientActionRegistration({ action: owner.action, platform: CLIENT_ACTION_TARGET.platform })?.registration;
            if (!ownerRegistration) throw new Error('Expected an independently live Resource owner registration');
            const sourceCustody = owner.projection.actionsById[`${CALLER_PLUGIN_ID}/${owner.action.id}`]!.hostAccountOrigin!.sourceCustody;
            const watching = dispatchPluginSurfaceAction({ action: { pluginId: target.action.pluginId, localId: target.action.id }, input: {},
                invocationSurface: 'plugin', originSurface: 'ui', clientAction: {}, callerPluginId: CALLER_PLUGIN_ID,
                resourceCaller: { pluginId: CALLER_PLUGIN_ID, serverId: accountLifetime.scope.serverId,
                    contributionLocalId: 'status-resource', occurrenceId: owner.action.occurrenceId, sourceCustody },
                signal: demand.signal, isCurrent: () => accountLifetime.isCurrent() && ownerRegistration.lifecycle.isCurrent(),
                requiredReadOnly: true, readObservation: { invalidate: invalidated, accept },
                resolveContributedAction: resolveExactClientAction(target.action),
            });
            if (retirement === 'late-target') {
                await vi.waitFor(() => expect(settleObserver).toBeDefined());
                await owner.composition.reconcile([owner.activation]);
                expect(await watching).toMatchObject({ ok: false });
                settleObserver!({ dispose() { disposed++; } });
                await vi.waitFor(() => expect(disposed).toBe(1));
                expect(accept).not.toHaveBeenCalled();
            } else {
                expect(await watching).toEqual({ ok: true, result: null });
                if (retirement === 'caller') demand.abort();
                await owner.composition.reconcile([owner.activation]);
                expect(disposed).toBe(1);
            }
            expect(ownerRegistration.lifecycle.isCurrent()).toBe(true);
            expect(invalidated).toHaveBeenCalledTimes(retirement === 'caller' ? 0 : 1);
            publish();
            expect(invalidated).toHaveBeenCalledTimes(retirement === 'caller' ? 0 : 1);
            expect(reads).toBe(0);
        } finally { demand.abort(); await owner.composition.unload(); accountLifetime.retire(); }
    });

    it('reports a legacy snapshot Action without an observer before checking its undeclared read predicate', async () => {
        const accountLifetime = clientAccountLifetime();
        let reads = 0;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime, surfaces: ['plugin'],
            accountHandler: async () => { reads++; return null; } });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const base = { action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                requiredReadOnly: true as const, invocationSurface: 'plugin' as const, originSurface: 'ui' as const,
                clientAction: {}, resolveContributedAction: resolveExactClientAction(activation.action) };
            expect(await dispatchPluginSurfaceAction({ ...base, readObservation: { invalidate() {}, accept() {} } }))
                .toMatchObject({ ok: false, reason: 'plugin_action_read_observation_unavailable' });
            expect(await dispatchPluginSurfaceAction(base)).toMatchObject({ ok: false, reason: 'plugin_action_read_only_required' });
            expect(reads).toBe(0);
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each(['before-dispatch', 'after-start'] as const)('rejects canceled Resource observation and disposes late attachment (%s)', async cancellation => {
        const accountLifetime = clientAccountLifetime();
        const demand = new AbortController();
        let settleObserver: ((subscription: import('@happier-dev/plugin-sdk').Disposable) => void) | undefined;
        let observerSignal: AbortSignal | undefined;
        let reads = 0;
        let disposed = 0;
        const accept = vi.fn();
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime, surfaces: ['plugin'], readOnly: true,
            accountHandler: async () => { reads++; return null; },
            observeRead: (_input, _invalidate, context) => {
                observerSignal = context.signal;
                return new Promise(resolve => { settleObserver = resolve; });
            } });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            if (cancellation === 'before-dispatch') demand.abort();
            const dispatch = dispatchPluginSurfaceAction({ action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                invocationSurface: 'plugin', originSurface: 'ui', clientAction: {},
                requiredReadOnly: true, readObservation: { invalidate() {}, accept }, signal: demand.signal,
                resolveContributedAction: resolveExactClientAction(activation.action) });
            if (cancellation === 'before-dispatch') {
                expect(await dispatch).toMatchObject({ ok: false });
                expect(settleObserver).toBeUndefined();
                expect(accept).not.toHaveBeenCalled();
                expect(reads).toBe(0);
                return;
            }
            await vi.waitFor(() => expect(settleObserver).toBeDefined());
            demand.abort();
            expect(await dispatch).toMatchObject({ ok: false });
            expect(observerSignal?.aborted).toBe(true);
            settleObserver!({ dispose() { disposed++; } });
            await vi.waitFor(() => expect(disposed).toBe(1));
            expect(accept).not.toHaveBeenCalled();
            expect(reads).toBe(0);
        } finally { demand.abort(); await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('refuses safe client effects and daemon placements that cannot carry the actual Resource caller', async () => {
        const accountLifetime = clientAccountLifetime();
        let effects = 0;
        const activation = createClientActionActivation({ accountLifetime, surfaces: ['plugin'],
            handler: async () => { effects++; return null; } });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const base = { callerPluginId: CALLER_PLUGIN_ID,
                resourceCaller: { pluginId: CALLER_PLUGIN_ID, serverId: accountLifetime.scope.serverId,
                    contributionLocalId: 'status-resource', occurrenceId: 'resource-occurrence', sourceCustody: TARGET_SOURCE_CUSTODY },
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {}, requiredReadOnly: true as const,
                invocationSurface: 'plugin' as const, originSurface: 'ui' as const, clientAction: {},
            };
            expect(await dispatchPluginSurfaceAction({ ...base, resolveContributedAction: resolveExactClientAction(activation.action) }))
                .toMatchObject({ ok: false, reason: 'plugin_action_read_only_required' });
            const rpcCount = daemonRpc.mock.calls.length;
            expect(await dispatchPluginSurfaceAction({ ...base,
                resolveContributedAction: identity => resolveDaemonTargetAction(identity) }))
                .toMatchObject({ ok: false, reason: 'plugin_action_resource_placement_unavailable' });
            expect(daemonRpc.mock.calls).toHaveLength(rpcCount);
            expect(effects).toBe(0);
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
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

    it('submits a global catalog Account Action form from a portable registration', async () => {
        const accountLifetime = clientAccountLifetime();
        const localId = 'catalog-account-echo';
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime,
            localId, inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
            inputHints: { fields: [{ path: 'name', title: 'Name', widget: 'text', required: true }] },
            accountActionDeclaration: { id: localId, title: 'Account echo', scopes: ['global'], surfaces: ['ui'],
                placementBindings: ['commandPalette'], dangerLevel: 'safe', execution: { target: 'account', invokingUi: true,
                    account: { artifactId: CLIENT_ACTION_TARGET.artifactId, exportName: CLIENT_ACTION_TARGET.exportName } } },
            accountHandler: async value => ({ echoed: value }),
        });
        try {
            await activation.composition.reconcile([activation.activation]);
            const { createPluginContributedActionController } = await import('../actions/pluginContributedActionController');
            const controller = createPluginContributedActionController({ resolveCurrent: () => ({
                pluginProjectionById: buildV2PluginProjectionById(activation.projection),
                pluginUiProjection: activation.projection,
                resolveContributedAction: resolveExactClientAction(activation.action),
                host: { serverId: accountLifetime.scope.serverId, accountLifetime },
            }) });
            const action = controller.list({ placement: 'commandPalette', scope: 'global' })[0];
            expect(action, 'the global palette must expose the admitted Account Action').toBeDefined();
            if (!action) throw new Error('Missing global Account Action');
            const opened = await controller.open(action);
            expect(opened.kind).toBe('form');
            if (opened.kind !== 'form') throw new Error('Missing Account Action form');
            opened.form.replaceInput({ name: 'from the global palette' });
            expect(await opened.form.submit()).toMatchObject({ kind: 'settled', outcome: {
                ok: true, result: { echoed: { name: 'from the global palette' } },
            } });
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('invokes the separately authored public Account plugin without a Machine', async () => {
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({ accountPlacement: true, authoredAccount: true, localId: 'echo',
            accountLifetime, handler: async () => { throw new Error('Author implementation must be used'); } });
        await activation.composition.unload();
        try {
            const attempts = await activation.composition.reconcile([activation.activation]);
            expect({ results: attempts.map(attempt => attempt.result),
                activation: activation.activate.mock.results.map(result => result.type === 'throw' && result.value instanceof Error
                    ? { type: result.type, name: result.value.name, message: result.value.message }
                    : { type: result.type }) }, 'the real Account Artifact must commit before testing input admission')
                .toEqual({ results: [{ ok: true }], activation: [{ type: 'return' }] });
            const registration = activation.composition.read({ family: 'actions', pluginId: authoredAccountManifest.id,
                localId: 'echo', target: activation.activation.target,
                executionOrigin: activation.activation.executionOrigin, occurrenceId: activation.action.occurrenceId });
            expect({ indexed: registration !== null, accountCurrent: accountLifetime.isCurrent(),
                registrationCurrent: registration?.lifecycle.isCurrent(), signalAborted: registration?.lifecycle.signal.aborted,
                projectedRegistration: resolvePluginUiClientActionRegistration({ action: activation.action, platform: 'web' }) !== null },
            'exact current Account registration is a fixture precondition')
                .toEqual({ indexed: true, accountCurrent: true, registrationCurrent: true, signalAborted: false, projectedRegistration: true });
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

    it.each(['decline', 'disable', 'release-retired'] as const)('consumes admitted Account consent after %s without rechecking policy', async (decision) => {
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
            expect(result).toMatchObject({ ok: decision === 'disable' });
            expect(effects).toBe(decision === 'disable' ? 1 : 0);
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

describe('client Action declared SessionTarget admission', () => {
    it.each([
        ['global daemon', false], ['Session daemon', false], ['global client', false], ['global account', false],
        ['global client', true], ['global account', true],
    ] as const)(
        'creates a private-input request before executable validation for a confidential %s Action (registration Home=%s)', async (placement, useRegistrationHome) => {
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
        if (useRegistrationHome) {
            expect((await activation.composition.reconcile([activation.activation])).map(attempt => attempt.result))
                .toEqual([{ ok: true }]);
            const terminalToken = `header.${Buffer.from(JSON.stringify({ sub: 'test-account', tokenEpoch: 0,
                provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' }),
            })).toString('base64url')}.signature`;
            const mountHome = await network.addHome('https://confidential-mount.example.test', 'test-account', {
                credentials: { token: terminalToken },
            });
            mountServerId = mountHome.id;
        }
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
                        const invocation = createPluginActionInvocation({ ...identity, declaration: action, inputSchema,
                            occurrenceSignal: new AbortController().signal, isCurrent: () => true });
                        const prepared = invocation.prepare(options.input);
                        if (prepared.kind !== 'settled') throw new Error('Private input must be requested before dispatch');
                        return { supported: true, result: prepared.result };
                    } },
                hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
                    serverId: mountServerId, runtimeAccountId: 'test-account',
                    ...(useRegistrationHome ? {} : { authority: 'present_user' as const }),
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

    it.each(['sameAccount', 'foreignAccount', 'retiredCapture'] as const)(
        'fences raw mounted exact Session addresses to the captured Account (%s)', async mode => {
        await import('@/sync/syncEngine');
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

    it.each(['sameHome', 'crossHome', 'foreignAccount', 'cancelled', 'mismatch', 'unsupported', 'contributed', 'account', 'scopeAnchor', 'scopeHome', 'missingAnchor', 'retiredCapture'] as const)(
        'binds exact Session Action addresses through real registered callers and Account capture (%s)', async mode => {
        await import('@/sync/syncEngine');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { buildSessionTurnsProjectionV1 } = await import('@happier-dev/protocol/sessions/turns/sessionTurnV1');
        const accountLifetime = clientAccountLifetime();
        const originHome = rpcHomes.get('server-client-action')!.id;
        const targetHome = mode === 'sameHome' || mode === 'scopeAnchor' ? originHome : mode === 'foreignAccount'
            ? (await network.addHome('https://address-foreign-account', 'another-account')).id : rpcHomes.get('server-wire')!.id;
        const opened: Array<{ sessionId: string; serverId?: string }> = [];
        const execute = createFrontDoorActionExecute(createDefaultActionExecutor({
            openSession: (sessionId, options) => { opened.push({ sessionId, serverId: options?.serverId }); },
        }));
        const cancellation = new AbortController();
        network.setHttpResponder(async (url, init) => {
            const parsedUrl = new URL(String(url));
            if (mode === 'retiredCapture' && parsedUrl.origin === rpcHomes.get('server-wire')!.serverUrl) accountLifetime.retire();
            if (parsedUrl.pathname === '/v2/sessions/reviewed') {
                return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id: 'reviewed' })));
            }
            if (parsedUrl.pathname === '/v1/sessions/reviewed/turns') {
                return Response.json(buildSessionTurnsProjectionV1({ sessionId: 'reviewed', updatedAt: 1, turns: [] }));
            }
            return createEmptyAccountBootstrapHttpResponse(parsedUrl.pathname, init);
        });
        const options = { sessionAddress: { serverId: targetHome, sessionId: 'reviewed' } };
        const action = mode === 'contributed' ? { pluginId: CALLER_PLUGIN_ID, localId: 'not-a-host-action' }
            : mode === 'unsupported' ? 'plugins.list' : 'session.open';
        const value = mode === 'unsupported' ? {} : { sessionId: mode === 'mismatch' ? 'other-session' : 'reviewed' };
        const activation = createClientActionActivation({ accountPlacement: mode === 'account', accountLifetime,
            ...(mode === 'account' ? { accountHandler: (_input, context) =>
                context.services.actions.execute('session.open', { sessionId: 'reviewed' }, options) }
                : { handler: (_input, context) => context.ui.executeAction(action, value, options) }),
        });
        try {
            await activation.composition.reconcile([activation.activation]);
            if (mode === 'cancelled') cancellation.abort();
            const result = await dispatchPluginSurfaceAction({ action: { pluginId: activation.action.pluginId, localId: activation.action.id },
                clientAction: {}, resolveContributedAction: resolveExactClientAction(activation.action), signal: cancellation.signal,
                hostAction: { execute, context: { serverId: originHome,
                    ...(mode === 'missingAnchor' ? {} : { defaultSessionId: mode === 'scopeHome' ? 'reviewed' : 'unrelated-session' }),
                    ...(mode === 'scopeAnchor' || mode === 'scopeHome' || mode === 'missingAnchor' ? { sessionListAccess: 'current_session' as const } : {}),
                    runtimeAccountId: 'test-account', authority: 'present_user' } },
            });
            if (mode === 'foreignAccount' || mode === 'cancelled' || mode === 'mismatch' || mode === 'unsupported' || mode === 'contributed'
                || mode === 'scopeAnchor' || mode === 'scopeHome' || mode === 'missingAnchor' || mode === 'retiredCapture') {
                expect(result).toMatchObject({ ok: false });
                expect(opened).toEqual([]);
            } else {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'opened',
                    sessionId: 'reviewed', serverId: targetHome } });
                expect(opened).toEqual([{ sessionId: 'reviewed', serverId: targetHome }]);
            }
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it.each([
        { actionKind: 'bindingUpdate', change: 'widening', input: { bindingId: 'binding-1', expectedRevision: 5, allowBotSenders: true } },
        { actionKind: 'bindingUpdate', change: 'narrowing', input: { bindingId: 'binding-1', expectedRevision: 5, inputMode: 'directMentionsOnly' } },
        { actionKind: 'bindingCreate', change: 'enabled creation', input: { enabled: true } },
        { actionKind: 'bindingSetEnabled', change: 'resuming', input: { bindingId: 'binding-1', expectedRevision: 5, enabled: true } },
    ] as const)('uses the real Channels $actionKind click but retains ordinary Ask for agent/MCP/Plugin $change', async ({ actionKind, input }) => {
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/channels/src/manifest');
        const { CONVERSATION_MANAGEMENT_ACTION_IDS_V1 } = await import('@happier-dev/channels-protocol/v1');
        const parsed = parsePluginManifest(PLUGIN_MANIFEST);
        if (!parsed.ok) throw new Error(parsed.diagnostics.map(diagnostic => diagnostic.message).join('; '));
        const action = parsed.manifest.contributes.actions?.find(
            declaration => declaration.id === CONVERSATION_MANAGEMENT_ACTION_IDS_V1[actionKind],
        );
        if (action === undefined) throw new Error('Expected the Channels binding Action');
        expect(pluginActionDeclarationRequiresConfirmationForInput(action, 'ui', input, 'present_user')).toBe(false);
        for (const surface of ['agent', 'mcp', 'plugin'] as const) {
            expect(action.surfaces).toContain(surface);
            expect(pluginActionDeclarationRequiresConfirmationForInput(action, surface, input)).toBe(true);
        }
        expect(pluginActionDeclarationRequiresConfirmationForInput(action, 'ui', input, 'account_automation')).toBe(true);
        // The click answers the default only; an explicit Ask preference remains with the host.
        expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: true },
            'ui', input, 'present_user')).toBe(true);
    });

    it.each(['ui', 'agent', 'mcp', 'workers', 'foreignHome', 'presenter', 'retired', 'readRelations'] as const)(
        'admits the real Channels daemon Session operand before confirmation and serialized dispatch (%s)', async mode => {
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/channels/src/manifest');
        const { SessionIdSchema } = await import('@happier-dev/plugin-sdk/sessions');
        const { SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1 } = await import('@happier-dev/channels-protocol/v1');
        const declaration = PLUGIN_MANIFEST.contributes?.actions?.find(action => action.id === SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1);
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
            if (mode === 'presenter') {
                // The host-presented call has no mounted plugin caller. It sends
                // its confirmation through the Home's installed Machine transport.
                const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
                const { ACTION_INVOKE_ACTION_ID_V1 } = await import('@happier-dev/protocol/actions/actionIds');
                const home = rpcHomes.get('server-client-action')!;
                const machineId = CLIENT_ACTION_ORIGIN.materializationRef.machineId;
                const boundary = await createExternalActionAccountHttpBoundary({
                    serverUrl: home.serverUrl, serverIdentityId: 'srv_client_action', accountId: home.accountId,
                    machineId, installationId: 'channels-fixture-installation', actionId: ACTION_INVOKE_ACTION_ID_V1,
                    tokenEpoch: 0, requesterInvocation: 'required',
                    execute: (input, { invocation, requestId }) => {
                        const call = input as { input?: { kind?: string; sessionId?: unknown } };
                        expect(call.input?.kind).toBe('attach');
                        const sessionId = SessionIdSchema.parse(call.input?.sessionId);
                        expect(invocation.presentUserConfirmation).toMatchObject({
                            actionId: ACTION_INVOKE_ACTION_ID_V1, requestId, target: { kind: 'machine', machineId },
                        });
                        issued.push({ sessionId, invocation: undefined, serverId: home.id });
                        return { kind: 'attached', bindingId: 'binding-exact-target' };
                    },
                });
                network.setHttpResponder(async (url, init) => {
                    const parsed = new URL(String(url));
                    return await boundary.handle(parsed, init) ?? createEmptyAccountBootstrapHttpResponse(parsed.pathname, init);
                });
            }
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
                const code = mode === 'workers' ? 'session_target_cardinality_mismatch' : 'session_target_home_mismatch';
                expect(result).toMatchObject({ code, diagnostics: [code] });
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

    it.each([{ ask: false, foreignHome: false, compose: false, health: false }, { ask: true, foreignHome: false, compose: false, health: false },
        { ask: false, foreignHome: true, compose: false, health: false }, { ask: false, foreignHome: false, compose: true, health: false },
        { ask: false, foreignHome: false, compose: true, health: true },
        ...(['owner', 'participant', 'nonparticipant', 'otherAccount', 'unissued', 'wrongCaller', 'crossHomeConstrained', 'sameHomeConstrained',
            'recent', 'recentFabricated', 'recentWrongCaller', 'recentOtherLifetime', 'recentUnqualified'] as const).map(picked => ({
            ask: false, foreignHome: false, compose: false, health: false, picked,
        }))])(
        'runs the actual configured handoff from an external plugin with Ask=$ask and foreign Home=$foreignHome and compose=$compose and health=$health and picked=$picked', async scenario => {
        const { ask, foreignHome, compose, health } = scenario;
        const picked = 'picked' in scenario ? scenario.picked : undefined;
        const recent = picked?.startsWith('recent') === true;
        const deniedSelection = picked === 'nonparticipant' || picked === 'otherAccount' || picked === 'unissued' || picked === 'wrongCaller' || picked === 'crossHomeConstrained'
            || picked === 'recentFabricated' || picked === 'recentWrongCaller' || picked === 'recentOtherLifetime' || picked === 'recentUnqualified';
        const expectConfirmation = ask || Boolean(picked && !deniedSelection && !recent);
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/triage/src/manifest');
        const { activate: activateTriageAccount } = await import('../../../../../../packages/plugins/triage/src/accountRuntime');
        const { resolveTriageActionInstructionV1 } = await import('../../../../../../packages/plugins/triage/src/sessions/actionResolution');
        const { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } = await import('../../../../../../packages/plugins/triage/src/settings/actions');
        const { createEmptyPluginAccountKvRowV1, setPluginAccountKvEntryV1, PluginAccountStorageReadResponseV1Schema } = await import('@happier-dev/protocol/plugins/data/accountKvV1');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } = await import('@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1');
        const { createSessionFixture, createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { createProjectAccountRowsFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { listProjectsForActions } = await import('@/sync/ops/actions/listProjects');
        const { createServiceHealthNoticeArtifactFixture } = await import('@/dev/testkit/fixtures/usageNoticeFixtures');
        const { readAccountNoticeArtifactHeader } = await import('@/sync/domains/artifacts/usageNoticeArtifacts');
        const { createAccountNoticeInvestigation } = await import('@/hooks/inbox/accountNoticeInvestigation');
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const { buildAgentTargetKeyV2 } = await import('@happier-dev/plugin-sdk/agents');
        const declaration = PLUGIN_MANIFEST.contributes?.actions?.find(action => action.id === 'sessions/run-configured-v1');
        if (!declaration || declaration.execution.target !== 'account') throw new Error('Configured handoff must use its single portable Account declaration');
        const normalized = ingestPluginManifestV2(PLUGIN_MANIFEST);
        if (!normalized.ok) throw new Error(JSON.stringify(normalized.diagnostics));
        if (compose) {
            const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
            await prepareSessionDraftPersistenceStorage();
        }
        const previous = getStorage().getState();
        const accountLifetime = { ...clientAccountLifetime(),
            scope: { serverId: resolveServerProfileScopeIdForIdentifier(rpcHomes.get('server-client-action')!.id), accountId: 'test-account' } };
        const targetHome = foreignHome ? 'different-target-home' : accountLifetime.scope.serverId;
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: accountLifetime.scope.serverId },
            accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion,
                declarationTransport: 'http-header-and-socket-auth-v1' },
        } });
        const qualifiedId = formatQualifiedPluginActionId({ pluginId: PLUGIN_MANIFEST.id, localId: declaration.id });
        const handoffSessions = { ...previous.sessions };
        if (picked === 'nonparticipant' || picked === 'otherAccount') delete handoffSessions['reviewed-session'];
        else handoffSessions['reviewed-session'] = createSessionFixture({ id: 'reviewed-session',
            access: createSessionAccessFixture(picked === 'participant' ? 'edit' : 'owner', { readTranscript: false }) });
        getStorage().setState({ profileScope: accountLifetime.scope, sessionLocalStateScope: accountLifetime.scope,
            sessions: handoffSessions,
            settings: { ...previous.settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: ask ? { [qualifiedId]: { approvalRequiredSurfaces: ['ui'] } } : {} }) },
        });
        const repository = { kind: 'github', deployment: 'https://github.com', repository: 'example/repository' } as const;
        const project = { id: '46ebacd7-3bc4-487e-b737-e67a39c07a49', serverId: accountLifetime.scope.serverId,
            machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, rootPath: '/repos/release', createdAtMs: 1,
            repositoryIdentity: repository };
        const projectRows = createProjectAccountRowsFixture(accountLifetime.scope, { workspaceRefs: [project] });
        if (compose) {
            await publishMachineInventoryForTest(accountLifetime.scope, [createMachineFixture({ id: project.machineId, activeAt: Date.now() })]);
        }
        const agentTarget = { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'investigator' } } as const;
        const targetKey = buildAgentTargetKeyV2(agentTarget);
        const service = { kind: 'deployment', machineId: project.machineId, environmentId: 'environment',
            environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } as const;
        const notice = createServiceHealthNoticeArtifactFixture(accountLifetime.scope.serverId, {
            ownerAccountId: accountLifetime.scope.accountId,
            header: { source: { kind: 'host', topic: 'service_health', subject: service },
                page: { kind: 'host', page: 'machine_service', machine: { serverId: project.serverId, machineId: service.machineId }, service,
                    environment: { serverId: project.serverId, projectSourceId: 'project', environmentId: service.environmentId } } },
        });
        const noticeHeader = readAccountNoticeArtifactHeader(notice, accountLifetime.scope.accountId)!;
        const configured = { actionId: health ? 'investigate' : 'fix', label: 'Repair', enabled: true, appliesTo: ['issue'], profileId: null,
            workspaceMode: compose && !health ? 'repository' : 'reference_only', target: { kind: 'agent', promptInvocationId: null,
                seededFallbackInstruction: 'Repair this issue.', delivery: compose ? 'compose' : 'send' } } as const;
        replacePluginAccountAvailabilityProjection({ scope: accountLifetime.scope, snapshot: {
            availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: PLUGIN_MANIFEST.id, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId: PLUGIN_MANIFEST.id, desiredVersion: PLUGIN_MANIFEST.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest: normalized.manifest, collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } }],
        } });
        const catalogueOrigin = readPluginAccountAvailability(accountLifetime.scope).readCurrentAccountExecution(PLUGIN_MANIFEST.id);
        if (catalogueOrigin.kind !== 'available') throw new Error('Expected the declared Account catalogue');
        const activation = createClientActionActivation({ pluginId: PLUGIN_MANIFEST.id, localId: declaration.id,
            accountPlacement: true, accountLifetime, accountManifest: normalized.manifest, occurrenceId: catalogueOrigin.custodyId,
            inputSchema: declaration.inputSchema, surfaces: declaration.surfaces, sessionTarget: declaration.sessionTarget,
            dangerLevel: declaration.dangerLevel, confirmationWhen: declaration.confirmationWhen,
            artifactGraph: PluginUiArtifactsManifestEntryV2Schema.parse({ ...CLIENT_ACTION_ARTIFACT_GRAPH,
                artifactId: declaration.execution.account.artifactId,
                executable: { exports: [declaration.execution.account.exportName] },
                entry: `react-native/${declaration.execution.account.artifactId}/entry.cjs.bundle`,
                files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({ ...file,
                    relativePath: `react-native/${declaration.execution.account.artifactId}/entry.cjs.bundle` })) }),
            accountActivate: activateTriageAccount,
        });
        const row = createEmptyPluginAccountKvRowV1();
        setPluginAccountKvEntryV1(row, TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, { v: 1, actions: [configured] }, undefined);
        let catalogueReads = 0;
        // Account KV HTTP persistence is the boundary; the registered catalogue
        // handler, admission, storage adapter and logical-key parser stay real.
        network.setHttpResponder(async (url, init) => {
            const parsedUrl = new URL(String(url));
            if (parsedUrl.pathname === '/v1/features' || parsedUrl.pathname === '/v1/features/authenticated') {
                return Response.json(features);
            }
            if (parsedUrl.pathname === `/v1/account/plugin-storage/${PLUGIN_MANIFEST.id}`) {
                catalogueReads += 1;
                expect(init?.method ?? 'GET').toBe('GET');
                return Response.json(PluginAccountStorageReadResponseV1Schema.parse({ status: 'present', revision: 1,
                    content: { t: 'plain', v: row } }));
            }
            return createEmptyAccountBootstrapHttpResponse(parsedUrl.pathname, init);
        });
        daemonRpc.mockImplementation(async (request: Readonly<{ method: string; payload?: Readonly<{ qualifiedActionId?: string }> }>) => {
            if (health && request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return {
                status: 'current', targetedContributions: {
                    target: { pluginId: activation.action.pluginId, occurrenceId: activation.action.occurrenceId,
                        sourceCustody: TARGET_SOURCE_CUSTODY }, points: [],
                }, targetedSurfaceMounts: [],
            };
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) return answerActionSchemasRead(request);
            throw new Error(`Unexpected daemon Action: ${request.payload?.qualifiedActionId}`);
        });
        const projection = activation.projection;
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const withdrawProjection = publishCommittedAppShellPluginUiProjection(() => projection);
        const readProjection = () => projection;
        const createPort = (invocationSurface: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['invocationSurface'],
            hostAction?: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['hostAction']) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction, readProjection, readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        });
        const sent: Parameters<NonNullable<ActionExecutorDeps['sessionSendMessage']>>[0][] = [];
        let manager = 'reviewed-session';
        let resolutions = 0;
        let confirmations = 0;
        const confirmationSnapshots: Array<{ sentCount: number; resolutions: number; catalogueReads: number }> = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            listContributedActionDefinitions: () => createPort('ui').listCurrentContributedActionDefinitions?.('allSurfaces') ?? [],
            projectsList: args => listProjectsForActions(args, projectRows),
            sessionList: async () => ({ sessions: [{ id: picked === 'recentFabricated' ? 'another-session' : 'reviewed-session',
                ...(picked === 'recentUnqualified' ? {} : { serverId: targetHome }),
                active: false, presence: null, updatedAt: 1 }], nextCursor: null, hasNext: false }),
            agentsBackendsList: async () => ({ items: [{ targetKey, label: 'Investigator', enabled: true, agentTarget }] }),
            spawnProfilesList: async () => ({ items: [{ id: 'profile-investigate', name: 'Investigate', preferredAgentTargetKey: targetKey }] }),
            artifactAction: async request => {
                if (request.actionId !== 'artifact.get') throw new Error(`Unexpected Artifact mutation ${request.actionId}`);
                return { artifact: { artifactId: notice.id, ownerAccountId: notice.ownerAccountId, access: notice.access,
                    publicAudience: notice.publicAudience, header: notice.header, body: notice.body,
                    revision: { headerVersion: notice.headerVersion, bodyVersion: notice.bodyVersion },
                    seq: notice.seq, createdAt: notice.createdAt, updatedAt: notice.updatedAt } };
            },
            runtimeActionExecute: async request => {
                if (request.actionId !== 'localServices.launcher.snapshot') throw new Error(`Unexpected native Action ${request.actionId}`);
                return { v: 1, machineId: service.machineId, updatedAt: 1, targets: [{ id: service.serviceId,
                    source: 'managed_service', machineId: service.machineId, lifecyclePurpose: 'deployment', title: 'web',
                    confidence: 'high', state: 'available', serviceState: 'unhealthy', actions: [],
                    environment: { environmentId: service.environmentId, environmentInstanceId: service.environmentInstanceId,
                        deploymentId: 'receipt-a', composeService: service.composeService } }] };
            },
            resolveSessionReference: async ({ sessionId }) => {
                return picked === 'nonparticipant' || picked === 'otherAccount' ? { kind: 'none' }
                    : { kind: 'unique', address: { serverId: accountLifetime.scope.serverId, sessionId: sessionId! } };
            },
            readSessionManager: async () => { resolutions += 1; return { kind: 'manager',
                address: { serverId: targetHome, sessionId: manager } }; },

            sessionSendMessage: async request => { sent.push(request); return { status: 'accepted', localId: 'configured-handoff-input' }; },
            invokeContributedAction: request => executeCurrentUiContextContributedAction(request, {
                execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
            }),
        }));
        const unregister = registerCurrentUiContextActionPort(createPort);
        nestedActionConfirmation.onShow = approve => {
            confirmations += 1;
            confirmationSnapshots.push({ sentCount: sent.length, resolutions, catalogueReads });
            manager = 'replacement-session';
            approve();
        };
        try {
            // Observe the real physical features response so the ordinary
            // capability owner admits Account storage; no synthetic cache bit.
            expect(await getServerFeaturesSnapshot({ serverId: accountLifetime.scope.serverId, force: true })).toMatchObject({ status: 'ready' });
            await activation.composition.reconcile([activation.activation]);
            newSessionNavigation.mockClear();
            const caller = mountedCallerBinding({ pluginId: 'happier.scm.forge.github', contributionLocalId: 'releases' });
            const surface = { ...surfaceContext(caller.pluginId), contributionId: caller.contributionLocalId,
                surfaceId: `surfacePlacement:${caller.pluginId}:${caller.contributionLocalId}` };
            const createMountedApi = (binding = caller, lifetime = accountLifetime) => createPluginSurfaceActionHostApi({
                surfaceContext: { ...surface, pluginId: binding.pluginId, contributionId: binding.contributionLocalId }, callerBinding: binding,
                callerSourceCustody: TARGET_SOURCE_CUSTODY, clientAction: {}, actionAccountLifetime: lifetime,
                resolveContributedAction: identity => projection.actionsById[`${identity.pluginId}/${identity.localId}`] ?? null,
                hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
                    serverId: picked === 'crossHomeConstrained' ? 'source-home' : accountLifetime.scope.serverId,
                    defaultSessionId: picked === 'crossHomeConstrained' || picked === 'sameHomeConstrained' ? 'reviewed-session' : 'parent',
                    ...(picked === 'crossHomeConstrained' || picked === 'sameHomeConstrained' ? { sessionListAccess: 'current_session' as const } : {}),
                    authority: 'present_user', actionCaller: { kind: 'host' },
                } },
            });
            const api = createMountedApi();
            if (recent) {
                // The recent menu receives these rows through the public host
                // Action, then returns their tuple without opening a modal.
                const listCaller = picked === 'recentWrongCaller' ? mountedCallerBinding() : caller;
                const listApi = createMountedApi(listCaller, picked === 'recentOtherLifetime' ? { ...accountLifetime } : accountLifetime);
                expect(await listApi.handleRequest(executeActionRequest({ action: 'session.list',
                    input: { view: 'summary', resumableOnly: true } }))).toMatchObject({ sessions: [{
                    id: picked === 'recentFabricated' ? 'another-session' : 'reviewed-session',
                }] });
            } else if (picked && picked !== 'unissued') {
                const { createPluginActionInputSelector } = await import('./pluginActionInputSelectionHostApi');
                const { Modal } = await import('@/modal');
                const show = vi.spyOn(Modal, 'show').mockImplementation(config => {
                    const props = config.props as Readonly<{ onResolve(selection: unknown): void }>;
                    queueMicrotask(() => props.onResolve({ kind: 'existingSession', serverId: targetHome, sessionId: 'reviewed-session' }));
                    return 'handoff-session-picker';
                });
                const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
                try {
                    const select = createPluginActionInputSelector({ host: { accountLifetime, serverId: targetHome,
                        targetPluginId: picked === 'wrongCaller' ? 'acme.other-plugin' : caller.pluginId }, isCurrent: accountLifetime.isCurrent });
                    expect(await select({ hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' } }))
                        .toEqual({ kind: 'sessionAddress', session: { serverId: targetHome, sessionId: 'reviewed-session' } });
                } finally { show.mockRestore(); hide.mockRestore(); }
            }
            const request = executeActionRequest({ action: { pluginId: PLUGIN_MANIFEST.id, localId: declaration.id },
                ...(picked ? { sessionAddress: { serverId: targetHome, sessionId: 'reviewed-session' } } : {}),
                input: { v: 1, handoff: { task: 'draftReleaseNotes', configuredActionId: 'fix',
                    context: { kind: 'repository', repository, ...(compose ? { workspace: {
                        workspaceId: project.id, serverId: project.serverId, machineId: project.machineId, rootPath: project.rootPath,
                    } } : {}) }, evidence: [{ kind: 'releaseNotes', repository,
                        selector: { kind: 'proposed', tagName: 'v1', targetCommitish: 'main' }, contextText: 'The original release context' }],
                    sessionChoice: compose ? { kind: 'configured' } : { kind: 'existing', session: picked ? 'reviewed-session' : { selector: 'manager' } },
                    agentChoice: { kind: 'configured' }, delivery: compose ? 'compose' : 'send',
                } },
            });
            const result = health ? await createAccountNoticeInvestigation({ scope: accountLifetime.scope,
                isCurrent: accountLifetime.isCurrent, execute: createFrontDoorActionExecute(executor),
            }).run({ artifact: notice, header: noticeHeader }, {
                configuredActionId: 'investigate', sessionChoice: { kind: 'new' },
                agentChoice: { kind: 'profile', profileId: 'profile-investigate' }, delivery: 'compose',
            }) : await api.handleRequest({ ...request, surface });
            const handoffResult = health && result && 'ok' in result && result.ok ? result.result : result;
            expect(confirmationSnapshots, JSON.stringify({ result, confirmations })).toEqual(expectConfirmation ? [{ sentCount: 0, resolutions: picked ? 0 : 1, catalogueReads: 0 }] : []);
            expect(resolutions, JSON.stringify({ result, sent })).toBe(compose || picked ? 0 : 1);
            expect(catalogueReads, JSON.stringify({ result, sent })).toBe(deniedSelection ? 0 : 1);
            expect(confirmations).toBe(expectConfirmation ? 1 : 0);
            if (deniedSelection) {
                expect(result).toMatchObject({ code: expect.stringMatching(/invalid_payload|unavailable/) });
                if (recent) expect(result).toMatchObject({ code: 'invalid_payload', diagnostics: ['session_address_unsupported'] });
                if (picked === 'crossHomeConstrained') expect(result).toMatchObject({ diagnostics: ['action_scope_restricted'] });
                expect(sent).toEqual([]);
            } else if (compose) {
                expect(handoffResult, JSON.stringify(handoffResult)).toMatchObject({ v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } });
                expect(sent).toEqual([]);
                expect(newSessionNavigation).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/new' }));
                const route = newSessionNavigation.mock.calls[0]![0] as Readonly<{ params: { draftId: string } }>;
                const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
                const draft = readNewSessionDraftFromRepository({ scope: accountLifetime.scope, draftId: route.params.draftId });
                expect(newSessionNavigation).toHaveBeenCalledTimes(1);
                expect(draft).toMatchObject(health ? { selectedProfileId: 'profile-investigate', agentTarget,
                    selectedMachineId: service.machineId, targetServerId: accountLifetime.scope.serverId,
                    directoryKind: 'managed', executionTarget: { kind: 'machine', target: {
                        serverId: accountLifetime.scope.serverId, machineId: service.machineId } } }
                    : { input: resolveTriageActionInstructionV1(configured, null,
                        { task: 'draftReleaseNotes', context: 'repository' }),
                        selectedMachineId: project.machineId, selectedPath: project.rootPath });
            } else if (foreignHome) {
                expect(result).toMatchObject({ v: 1, handoff: { kind: 'unavailable', reason: 'sessionUnavailable' } });
                expect(sent).toEqual([]);
            } else {
                expect(result).toMatchObject({ v: 1, handoff: { kind: 'sendResult',
                    session: { serverId: targetHome, sessionId: 'reviewed-session' },
                    result: { status: 'accepted', localId: 'configured-handoff-input' } } });
                expect(sent).toHaveLength(1);
                expect(sent[0]).toMatchObject({ serverId: targetHome, sessionId: 'reviewed-session' });
                if (recent) expect(newSessionNavigation).not.toHaveBeenCalled();
            }
        } finally {
            nestedActionConfirmation.onShow = null; unregister(); withdrawProjection();
            await activation.composition.unload(); accountLifetime.retire();
            getStorage().setState({ sessions: previous.sessions, settings: previous.settings,
                machineListByServerId: previous.machineListByServerId, machineListStatusByServerId: previous.machineListStatusByServerId,
                profileScope: previous.profileScope, sessionLocalStateScope: previous.sessionLocalStateScope });
        }
    });

    it.each(['exact', 'manager', 'workers', 'absent', 'external', 'retired', 'presenter'] as const)(
        'uses the canonical executor before client effects (%s)', async selection => {
        let manager = 'reviewed-manager';
        let managerReads = 0;
        let referenceReads = 0;
        let effects = 0;
        let confirmations = 0;
        let callerCurrent = true;
        let mountedPresenterCalls = 0;
        const invokingCallers: unknown[] = [];
        const activation = createClientActionActivation({
            ...(selection === 'external' ? { pluginId: 'acme.session-target' } : {}),
            sessionTarget: { field: 'handoff.sessionChoice.session', cardinality: 'one' },
            dangerLevel: selection === 'exact' || selection === 'absent' ? 'safe' : 'writesRemote',
            handler: (value, context) => {
                effects += 1;
                return { input: value, targets: context.sessionTargetsV1 ?? null };
            },
        });
        const reader = { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} };
        const createPort = (invocationSurface: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['invocationSurface'],
            hostAction?: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['hostAction']) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction, reader, readProjection: () => activation.projection, readNavigationBinding: () => null,
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            listContributedActionDefinitions: () => createPort('ui').listCurrentContributedActionDefinitions?.() ?? [],
            resolveSessionReference: async ({ sessionId }) => {
                referenceReads += 1;
                return { kind: 'unique', address: { serverId: 'exact-target-home', sessionId: sessionId! } };
            },
            readSessionManager: async () => {
                managerReads += 1;
                return { kind: 'manager', address: { serverId: 'exact-target-home', sessionId: manager } };
            },
            sessionList: async ({ query }) => markSessionListQueryResultV1({
                sessions: ['worker-a', 'worker-b'].map(id => ({ id, active: false, presence: 'offline', updatedAt: 1,
                    manager: { sessionId: query?.underSessionId } })),
                nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
            }),

            invokeContributedAction: request => {
                invokingCallers.push(request.context.actionCaller);
                return executeCurrentUiContextContributedAction(request, { execute: executor.execute, context: request.context });
            },
        }));
        const unregister = registerCurrentUiContextActionPort(createPort);
        nestedActionConfirmation.onShow = approve => {
            confirmations += 1;
            expect(effects).toBe(0);
            expect(managerReads).toBe(1);
            manager = 'replacement-manager';
            if (selection === 'retired') callerCurrent = false;
            approve();
        };
        const mountedPresenter: NonNullable<DispatchPluginSurfaceActionInput['requestCurrentIntent']> = async request => {
            mountedPresenterCalls += 1;
            expect(effects).toBe(0);
            expect(managerReads).toBe(1);
            manager = 'replacement-manager';
            return { status: 'approved', fingerprint: request.fingerprint };
        };
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const sessionChoice = selection === 'absent' ? { kind: 'new' }
                : { kind: 'existing', session: selection === 'exact' ? 'exact-session' : { selector: selection === 'workers' ? 'workers' : 'manager' } };
            const binding = { resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
                hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: { serverId: 'source-home', defaultSessionId: 'parent',
                    authority: 'present_user' as const, actionCaller: { kind: 'host' as const } } } };
            const action = { pluginId: activation.action.pluginId, localId: activation.action.id };
            const value = { handoff: { sessionChoice } };
            const result = selection === 'external'
                ? { ok: true, result: await createPluginSurfaceActionHostApi({ ...binding, surfaceContext: surfaceContext(),
                    callerBinding: mountedCallerBinding(), callerSourceCustody: TARGET_SOURCE_CUSTODY,
                }).handleRequest(executeActionRequest({ action, input: value })) }
                : await dispatchPluginSurfaceAction({ ...binding, action, input: value, isCurrent: () => callerCurrent,
                    ...(selection === 'presenter' ? { requestCurrentIntent: mountedPresenter } : {}) });
            if (selection === 'retired') {
                expect(result).toMatchObject({ ok: false, code: 'stale_surface' });
                expect(effects).toBe(0);
                expect(confirmations).toBe(1);
            } else if (selection === 'workers') {
                expect(result).toMatchObject({ ok: false, reason: 'session_target_cardinality_mismatch' });
                expect(effects).toBe(0);
                expect(confirmations).toBe(0);
            } else if (selection === 'absent') {
                expect(result).toMatchObject({ ok: true, result: { targets: null, input: { handoff: { sessionChoice: { kind: 'new' } } } } });
                expect(referenceReads).toBe(0);
                expect(managerReads).toBe(0);
                expect(effects).toBe(1);
            } else {
                const sessionId = selection === 'exact' ? 'exact-session' : 'reviewed-manager';
                expect(result).toMatchObject({ ok: true, result: {
                    input: { handoff: { sessionChoice: { kind: 'existing', session: sessionId } } },
                    targets: { actionId: 'action.invoke', field: 'input.handoff.sessionChoice.session',
                        targets: [{ serverId: 'exact-target-home', sessionId }] },
                } });
                expect(referenceReads).toBe(1);
                expect(managerReads).toBe(selection === 'exact' ? 0 : 1);
                expect(confirmations).toBe(selection === 'exact' || selection === 'presenter' ? 0 : 1);
                expect(mountedPresenterCalls).toBe(selection === 'presenter' ? 1 : 0);
                expect(effects).toBe(1);
                if (selection === 'external') expect(invokingCallers).toEqual([expect.objectContaining({
                    kind: 'plugin', pluginId: CALLER_PLUGIN_ID, occurrenceId: mountedCallerBinding().occurrenceId,
                })]);
            }
        } finally {
            nestedActionConfirmation.onShow = null;
            unregister();
            await activation.composition.unload();
        }
    });
});

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
        readActionsSettings: () => settings,
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
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(rpcHomes.get('server-client-action')!.id);
        onTestFinished(() => account.dispose());
        // Only the daemon network boundary is substituted. Protected mounted
        // dispatch, Action admission and the canonical Account transport stay real.
        const relay = createUiAccountActionTransport({ account,
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
            hostAction: { execute: executor.execute, context: { serverId: account.serverId, runtimeAccountId: account.accountId,
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
    it.each(['host', 'contributed', 'unrelated'] as const)('keeps picked parent proof separate from child admission: %s', async childKind => {
        const accountLifetime = clientAccountLifetime(rpcHomes.get('server-client-action')!.id);
        const childSessionId = childKind === 'unrelated' ? 'unrelated-session' : 'parent-session';
        const child = createClientActionActivation({ pluginId: 'acme.child-target', accountLifetime,
            sessionTarget: { field: 'destination.sessionId', cardinality: 'one' },
            handler: async (_input, context) => ({ admitted: context.sessionTargetsV1 ?? null,
                result: await context.ui.executeAction('session.message.send', { sessionId: childSessionId,
                    message: 'Continue the admitted child Session', idempotencyKey: 'admitted-child-send' },
                    { sessionAddress: { serverId: accountLifetime.scope.serverId, sessionId: childSessionId } }) }),
        });
        const activation = createClientActionActivation({ pluginId: 'acme.relay-parent', accountLifetime,
            sessionTarget: { field: 'sessionId', cardinality: 'one' },
            handler: async (_input, context) => childKind === 'host'
                ? context.ui.executeAction('session.message.send', { sessionId: 'child-session',
                    message: 'Continue the child Session', idempotencyKey: 'independent-child-send' })
                : context.ui.executeAction({ pluginId: child.action.pluginId, localId: child.action.id },
                    { destination: { sessionId: childSessionId } },
                    { sessionAddress: { serverId: accountLifetime.scope.serverId, sessionId: childSessionId } }),
        });
        const projection = { ...activation.projection,
            actionsById: { ...activation.projection.actionsById, ...child.projection.actionsById },
            installedPackagesById: { ...activation.projection.installedPackagesById, ...child.projection.installedPackagesById },
            reactNativeBundlesById: { ...activation.projection.reactNativeBundlesById, ...child.projection.reactNativeBundlesById } };
        const createPort = (invocationSurface: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['invocationSurface'],
            hostAction?: Parameters<typeof createCurrentUiContextVoiceToolPort>[0]['hostAction']) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction, readProjection: () => projection, readNavigationBinding: () => null,
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
        });
        const sent: Parameters<NonNullable<ActionExecutorDeps['sessionSendMessage']>>[0][] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            listContributedActionDefinitions: () => createPort('ui').listCurrentContributedActionDefinitions?.() ?? [],
            resolveSessionReference: async ({ sessionId }) => ({ kind: 'unique', address: { serverId: accountLifetime.scope.serverId, sessionId: sessionId! } }),

            sessionSendMessage: async request => { sent.push(request); return { status: 'accepted', localId: 'child-input' }; },
            invokeContributedAction: request => executeCurrentUiContextContributedAction(request, {
                execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: request.context,
            }),
        }));
        const unregister = registerCurrentUiContextActionPort(createPort);
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show').mockImplementation(config => {
            const props = config.props as Readonly<{ onResolve(selection: unknown): void }>;
            queueMicrotask(() => props.onResolve({ kind: 'existingSession', serverId: accountLifetime.scope.serverId, sessionId: 'parent-session' }));
            return 'parent-session-picker';
        });
        const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        try {
            await activation.composition.reconcile([activation.activation, child.activation]);
            const { createPluginActionInputSelector } = await import('./pluginActionInputSelectionHostApi');
            const select = createPluginActionInputSelector({ host: { accountLifetime, serverId: accountLifetime.scope.serverId,
                targetPluginId: CALLER_PLUGIN_ID }, isCurrent: accountLifetime.isCurrent });
            const selected = await select({ hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' } });
            expect(selected).toMatchObject({ kind: 'sessionAddress' });
            const api = createPluginSurfaceActionHostApi({ surfaceContext: surfaceContext(), callerBinding: mountedCallerBinding(),
                actionAccountLifetime: accountLifetime, clientAction: {}, callerSourceCustody: TARGET_SOURCE_CUSTODY,
                resolveContributedAction: identity => resolveExactClientAction(activation.action)(identity) ?? resolveExactClientAction(child.action)(identity),
                hostAction: { execute: Object.assign(executor.execute, { prepare: executor.prepare }), context: {
                    serverId: accountLifetime.scope.serverId, authority: 'present_user', actionCaller: { kind: 'host' },
                } },
            });
            const result = await api.handleRequest(executeActionRequest({ action: { pluginId: activation.action.pluginId, localId: activation.action.id },
                input: { sessionId: 'parent-session' }, sessionAddress: { serverId: accountLifetime.scope.serverId, sessionId: 'parent-session' } }));
            if (childKind === 'unrelated') {
                expect(result).toMatchObject({ code: 'unavailable', diagnostics: ['session_address_unsupported'] });
                expect(sent).toEqual([]);
            } else {
                expect(result).toMatchObject(childKind === 'host' ? { status: 'accepted', localId: 'child-input' } : {
                    admitted: { actionId: 'action.invoke', field: 'input.destination.sessionId',
                        targets: [{ serverId: accountLifetime.scope.serverId, sessionId: 'parent-session' }] },
                    result: { status: 'accepted', localId: 'child-input' } });
                expect(sent).toHaveLength(1);
                expect(sent[0]).toMatchObject({ sessionId: childKind === 'host' ? 'child-session' : 'parent-session', serverId: accountLifetime.scope.serverId });
            }
        } finally { unregister(); await activation.composition.unload(); show.mockRestore(); hide.mockRestore(); }
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
                readActionsSettings: () => settings,
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

    it.each(['invalid draft', 'prepared execution'] as const)('selects a daemon review operation on the checkout chosen by an Account Action (%s)', async mode => {
        const { DaemonPluginUiTargetedContributionsReadResponseSchema, DaemonPluginStructuredMessageActionExecuteResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { PLUGIN_MANIFEST: triage } = await import('../../../../../../packages/plugins/triage/src/manifest');
        const { PLUGIN_MANIFEST: github } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
        const { createTriageSourceV1Fixture } = await import('@happier-dev/triage-protocol/testing/v1');
        const { TriageSourceCredentialInputsV1 } = await import('@happier-dev/triage-protocol/v1');
        const lifetime = clientAccountLifetime();
        const manifests = [triage, github].map(manifest => {
            const parsed = ingestPluginManifestV2(manifest);
            if (!parsed.ok) throw new Error('Canonical manifest must ingest');
            return parsed.manifest;
        });
        const graphs = new Map(manifests.filter(manifest => manifest.id === triage.id).map(manifest => {
            const declaration = manifest.contributes.actions.find(action => action.id ===
                (manifest.id === triage.id ? 'actions/read-v1' : 'triage/prepare-github-review-workspace'))!;
            if (declaration.execution.target !== 'account') throw new Error('Expected Account Action');
            const artifactId = declaration.execution.account.artifactId;
            return [manifest.id, { declaration, graph: { ...CLIENT_ACTION_ARTIFACT_GRAPH, artifactId,
                entry: `react-native/${artifactId}/entry.cjs.bundle`,
                files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({ ...file,
                    relativePath: `react-native/${artifactId}/entry.cjs.bundle` })),
                executable: { exports: [declaration.execution.account.exportName] } } }];
        }));
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
            availabilityCursor: 1, materializations: [], snapshots: [], intentReads: manifests.map(manifest => ({
                pluginId: manifest.id, response: { availabilityCursor: 1, hostingCapability: { enabled: false },
                    packageAssets: [], uiArtifacts: [], intent: { pluginId: manifest.id, desiredVersion: manifest.version,
                        enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                    release: { ref: { pluginId: manifest.id, version: manifest.version },
                        archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest,
                        collectionContracts: [], uiSlots: graphs.has(manifest.id) ? [{ contributionId: graphs.get(manifest.id)!.declaration.id,
                            tier: 'reactNative', platform: 'web', artifactId: graphs.get(manifest.id)!.graph.artifactId,
                            artifactDigest: graphs.get(manifest.id)!.graph.digest,
                            hostUiApiRange: graphs.get(manifest.id)!.graph.hostUiApiRange, artifactGraph: graphs.get(manifest.id)!.graph }] : [], packageAssetArchive: {
                            archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
                },
            })),
        } });
        const selected = readPluginAccountAvailability(lifetime.scope).readCurrentAccountExecution(triage.id);
        if (selected.kind !== 'available') throw new Error('Expected Triage Account execution');
        const declaration = manifests[0]!.contributes.actions.find(action => action.id === 'actions/read-v1')!;
        if (declaration.execution.target !== 'account') throw new Error('Expected Account Action');
        const { Modal } = await import('@/modal');
        const serverId = resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId);
        const candidate = { projectKey: { id: 'review-project' }, serverId, machineId: 'chosen-review-machine',
            rootPath: '/review', reachable: true, worktrees: [] };
        vi.spyOn(Modal, 'show').mockImplementation(config => {
            if (config.props && 'form' in config.props) {
                const form = config.props.form as import('@/components/plugins/actions/pluginContributedActionController').PluginContributedActionSelectionForm;
                queueMicrotask(() => { form.replaceInput(validDraft); void form.submit(); });
                return 'review-input';
            }
            if (config.props && 'onConfirm' in config.props && typeof config.props.onConfirm === 'function') {
                const confirm = config.props.onConfirm;
                queueMicrotask(() => confirm());
                return 'review-current-intent';
            }
            const props = config.props as import('@/components/ui/selectionList').SelectionListProps;
            const section = props.rootStep?.sections[0];
            if (section?.kind !== 'static') throw new Error('Expected placement picker');
            queueMicrotask(() => section.options[0]?.onSelect?.());
            return 'review-placement';
        });
        const githubDeclaration = manifests[1]!.contributes.actions.find(action => action.id === 'triage/prepare-github-review-workspace')!;
        clientActionSchemasByQualifiedId.set(`${github.id}/${githubDeclaration.id}`, { inputSchema: githubDeclaration.inputSchema });
        const reviewOccurrenceId = `${github.id}:75`;
        const githubContributions = manifests[1]!.contributes.targetedPluginContributions.filter(contribution => contribution.target.pluginId === triage.id);
        const targetedActionIds = new Set(githubContributions.flatMap(contribution => Object.values(contribution.operations)));
        const targetedRendererIds = new Set(githubContributions.flatMap(contribution => Object.values(contribution.surfaces ?? {})
            .flatMap(surface => [surface.renderer, ...(surface.fallbackRenderers ?? [])])));
        const targetedResponse = DaemonPluginUiTargetedContributionsReadResponseSchema.parse({
            status: 'sourceDeclarations', pluginId: triage.id, sourceDeclarations: [{
                occurrenceId: reviewOccurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: 'chosen-github-root' },
                manifest: { id: github.id, contributes: {
                    actions: manifests[1]!.contributes.actions.filter(action => targetedActionIds.has(action.id)),
                    pluginContributionPoints: [], targetedPluginContributions: githubContributions,
                    ui: { renderers: manifests[1]!.contributes.ui.renderers.filter(renderer => targetedRendererIds.has(renderer.id)) },
                } },
            }],
        });
        const fixtureDraft = createTriageSourceV1Fixture().prepareReviewWorkspaceInput;
        const nativeService = { pluginId: github.id, localId: 'github-account' };
        const validDraft = TriageSourceCredentialInputsV1.prepareReviewWorkspace.parse({ ...fixtureDraft,
            instance: { ...fixtureDraft.instance, instance: { ...fixtureDraft.instance.instance,
                source: { pluginId: github.id, localId: 'github-forge' } },
                binding: { purpose: 'github-connected-account', source: 'native', service: nativeService } },
            workspace: { serverId, machineId: candidate.machineId, rootPath: candidate.rootPath },
        });
        const githubAction = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction({ pluginId: github.id, localId: githubDeclaration.id }),
            title: githubDeclaration.title, execution: githubDeclaration.execution,
            scopes: githubDeclaration.scopes, surfaces: githubDeclaration.surfaces,
            dangerLevel: githubDeclaration.dangerLevel, confirmation: githubDeclaration.confirmation,
            readOnly: githubDeclaration.readOnly, sessionTarget: githubDeclaration.sessionTarget,
            ...(mode === 'prepared execution' ? { inputHints: githubDeclaration.inputHints } : {}),
            confirmationWhen: githubDeclaration.confirmationWhen,
            occurrenceId: reviewOccurrenceId });
        let chosenProjectionReads = 0;
        network.setRpcResponder(async request => {
            const schemas = answerActionSchemasRead(request);
            if (schemas !== undefined) return schemas;
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return targetedResponse;
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE) {
                return { ok: true, options: [{ value: nativeService, label: 'GitHub CLI', nativeServicePath: 'instance.binding.service' }] };
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: false, code: 'unavailable',
                    message: 'Fixture daemon preparation unavailable' });
            }
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                chosenProjectionReads++;
                return { protocolVersion: 1, projectionDigest: 'review-source', projection: {
                    v: 2, generation: 1, familiesById: {}, installedPackagesById: { [github.id]: {
                        id: github.id, displayName: 'GitHub', version: github.version, enabled: true,
                        source: { kind: 'localPath', locator: 'github' } } },
                    actionsById: { [`${github.id}/${githubDeclaration.id}`]: githubAction },
                } };
            }
            throw new Error(`Unexpected RPC ${request.method}`);
        });
        const activation = createClientActionActivation({ pluginId: triage.id, localId: declaration.id,
            accountPlacement: true, accountLifetime: lifetime,
            accountManifest: { ...manifests[0]!, contributes: { ...manifests[0]!.contributes,
                actions: [declaration], resources: [], connectedAccountDescriptors: [] } },
            accountActionDeclaration: declaration, occurrenceId: selected.custodyId,
            artifactGraph: { ...CLIENT_ACTION_ARTIFACT_GRAPH, artifactId: declaration.execution.account.artifactId,
                entry: `react-native/${declaration.execution.account.artifactId}/entry.cjs.bundle`,
                files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({ ...file,
                    relativePath: `react-native/${declaration.execution.account.artifactId}/entry.cjs.bundle` })),
                executable: { exports: [declaration.execution.account.exportName] } },
            // Keep the real target declaration, input selector and schema owners.
            // Exercise schema refusal and prepared execution through the same canonical source identity.
            inputSchema: {}, accountHandler: async (_value, context) => {
                const snapshot = await context.ui!.context();
                const operation = snapshot.targetedContributions?.points.flatMap(point => point.protocols)
                    .flatMap(protocol => protocol.contributions).flatMap(contribution => contribution.operations)
                    .find(operation => operation.role === 'prepareReviewWorkspace' && operation.action.pluginId === github.id);
                if (!operation) throw new Error('Expected real GitHub review operation');
                expect(operation.contributor.occurrenceId).not.toBe(reviewOccurrenceId);
                await context.ui!.selectActionInput({ hostAction: { action: 'session.spawn_new', projection: 'sessionPlacement' }, candidates: [candidate] });
                try {
                    const result = await context.ui!.selectActionInput({ operation, draft: mode === 'invalid draft' ? {} : validDraft });
                    if (mode === 'invalid draft' || result.kind !== 'submitted') return result;
                    await context.ui!.openNewSession({ checkoutIntent: 'preparedReviewWorkspace' }, {
                        preparedReviewWorkspace: { operation, result },
                    });
                    return null;
                }
                catch (error) {
                    if (!isPluginError(error)) throw error;
                    return { code: error.code, data: error.data };
                }
            } });
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const outcome = await dispatchPluginSurfaceAction({ action: { pluginId: triage.id, localId: declaration.id },
                input: { v: 1 }, pluginUiProjection: activation.projection,
                resolveContributedAction: identity => identity.pluginId === github.id
                    ? githubAction : resolveExactClientAction(activation.action)(identity), clientAction: {},
            });
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: {
                ...(mode === 'invalid draft'
                    ? { code: 'invalid_payload', data: { diagnostics: [expect.objectContaining({ code: 'invalid_draft' })] } }
                    : { code: 'unavailable' }),
            } });
            if (mode === 'prepared execution') {
                expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE), JSON.stringify(outcome))
                    .toEqual([expect.objectContaining({ targetId: candidate.machineId, payload: expect.objectContaining({
                        expectedContributorOccurrenceId: reviewOccurrenceId, input: validDraft,
                    }) })]);
            }
            expect(chosenProjectionReads).toBeGreaterThan(0);
            expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
                .map(request => request.targetId)).toEqual([candidate.machineId]);
            expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ)
                .map(request => request.targetId)).toEqual([candidate.machineId]);
        } finally { await activation.composition.unload(); lifetime.retire(); }
    });

    it('selects an Account Session through a registered Account Action without Machine authority', async () => {
        const { Modal } = await import('@/modal');
        const { createTriageConfiguredActionHost } = await import('../../../../../../packages/plugins/triage/src/actions/configuredActionHost');
        const accountLifetime = clientAccountLifetime();
        const serverId = resolveServerProfileScopeIdForIdentifier(accountLifetime.scope.serverId);
        let methods: readonly string[] | undefined;
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime, readOnly: true,
            accountHandler: async (_input, context) => {
                const host = createTriageConfiguredActionHost(context);
                methods = host.version().methods;
                const selected = await host.selectActionInput({
                    hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' },
                });
                return { methods: [...host.version().methods], selected };
            },
        });
        const shown: string[] = [];
        // Native modal presentation is the person/platform boundary; the
        // Account activation, dispatch, configured adapter and selector are real.
        const show = vi.spyOn(Modal, 'show').mockImplementation(config => {
            const props = config.props as Readonly<{ sourceServerId: string; selectionOnly: boolean;
                onResolve: (selection: Readonly<{ kind: 'existingSession'; serverId: string; sessionId: string }>) => void }>;
            expect(props.selectionOnly).toBe(true);
            shown.push(props.sourceServerId);
            queueMicrotask(() => props.onResolve({ kind: 'existingSession',
                serverId: props.sourceServerId, sessionId: 'account-selected-session' }));
            return 'account-session-selection';
        });
        const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        try {
            await activation.composition.reconcile([activation.activation]);
            const result = await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                pluginUiProjection: activation.projection,
                resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
            });
            expect(methods, JSON.stringify(result)).toContain('selectActionInput');
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { methods: expect.arrayContaining(['selectActionInput']),
                selected: { kind: 'sessionAddress', session: { serverId,
                    sessionId: 'account-selected-session' } } } });
            expect(shown).toEqual([serverId]);
        } finally {
            show.mockRestore(); hide.mockRestore();
            await activation.composition.unload(); accountLifetime.retire();
        }
    });

    it('opens the canonical Automation Event editor through a registered client Action', async () => {
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { readWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
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
            })).resolves.toMatchObject({ ok: true, result: null });
            const route = newSessionNavigation.mock.calls[0]?.[0] as Readonly<{
                pathname: string; params: { id: string; definitionDraftSeedId: string; serverId: string };
            }>;
            expect(route.pathname).toBe('/workflows/[id]');
            expect(Object.keys(route.params).sort()).toEqual(['definitionDraftSeedId', 'id', 'serverId']);
            expect(route.params.id).toBe('new');
            seedId = route.params.definitionDraftSeedId;
            expect(readWorkflowDefinitionDraftSeed(seedId, accountLifetime.scope)).toMatchObject({ initialView: 'sentence', eventSeed: intent });
        } finally {
            if (seedId) consumeWorkflowEditorDraftSeed(seedId);
            await activation.composition.unload(); accountLifetime.retire();
            getStorage().setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        }
    });

    it('keeps Set it up on the invoking browser with an eligible own Machine instead of an empty headless placement choice', async () => {
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/triage/src/manifest');
        const { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1 } = await import('../../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol');
        const { TriageSessionHandoffResultV1Schema } = await import('@happier-dev/triage-protocol/v1');
        const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const lifetime = clientAccountLifetime();
        const previous = getStorage().getState();
        const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1)!;
        const subject = { kind: 'deploymentEnvironment', serverId: lifetime.scope.serverId, environmentId: 'serving-environment' } as const;
        const input = { v: 1, handoff: { task: 'investigate', configuredActionId: 'deployments.set-up',
            context: { kind: 'failure', subject }, evidence: [{ kind: 'failure', subject }],
            sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'compose' } };
        const emptyHeadlessChoice = TriageSessionHandoffResultV1Schema.parse({ kind: 'placement_choice_required',
            reason: 'ambiguous_workspace', candidates: [], agents: [] });
        let relayed = 0;
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://server-client-action',
            serverIdentityId: 'srv_client_action', accountId: lifetime.scope.accountId, machineId: 'setup-machine',
            actionId: 'action.invoke', tokenEpoch: 0, execute: async () => {
                relayed++;
                return { v: 1, handoff: emptyHeadlessChoice };
            } });
        const machine = createMachineFixture({ id: boundary.machine.id, activeAt: Date.now(), access: boundary.machine.access });
        getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [lifetime.scope.serverId]: [machine] },
            machineListStatusByServerId: { [lifetime.scope.serverId]: 'idle' } });
        network.setHttpResponder(async (url, init) => await boundary.handle(new URL(String(url)), init)
            ?? createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init));
        const activation = createClientActionActivation({ pluginId: PLUGIN_MANIFEST.id, localId: declaration.id,
            accountPlacement: true, accountLifetime: lifetime, accountActionDeclaration: declaration,
            confirmationWhen: declaration.confirmationWhen,
            inputSchema: declaration.inputSchema, outputSchema: declaration.resultSchema,
            artifactGraph: { ...CLIENT_ACTION_ARTIFACT_GRAPH, artifactId: 'triage-account-runtime', executable: { exports: ['activate'] } },
            accountHandler: async (_input, context) => {
                if (!context.ui) throw new Error('Invoking UI capability was lost');
                await context.ui.openNewSession({ prompt: 'Inspect the serving Environment and its existing Compose file before changing it.' });
                return { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } };
            } });
        newSessionNavigation.mockClear();
        accountBrowserRelay.enabled = true;
        await activation.composition.unload();
        let finiteActivation: ReturnType<typeof createClientActionActivation> | undefined;
        try {
            await activation.composition.reconcile([activation.activation]);
            const outcome = await dispatchPluginSurfaceAction({ action: { pluginId: PLUGIN_MANIFEST.id, localId: declaration.id },
                input, resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {} });
            expect(outcome).toEqual({ ok: true, result: { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } });
            expect(relayed).toBe(0);
            const route = newSessionNavigation.mock.calls[0]?.[0] as Readonly<{ pathname: string; params: { draftId: string } }>;
            expect(route.pathname).toBe('/new');
            const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
            expect(readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: route.params.draftId }))
                .toMatchObject({ input: 'Inspect the serving Environment and its existing Compose file before changing it.' });
            await activation.composition.unload();
            finiteActivation = createClientActionActivation({ accountPlacement: true, accountLifetime: lifetime,
                accountHandler: () => { throw new Error('Finite Account work must keep the Machine relay'); } });
            await finiteActivation.composition.unload();
            await finiteActivation.composition.reconcile([finiteActivation.activation]);
            await expect(dispatchPluginSurfaceAction({ action: { pluginId: CALLER_PLUGIN_ID, localId: finiteActivation.action.id },
                input: {}, resolveContributedAction: resolveExactClientAction(finiteActivation.action), clientAction: {} }))
                .resolves.toEqual({ ok: true, result: { v: 1, handoff: emptyHeadlessChoice } });
            expect(relayed).toBe(1);
        } finally {
            accountBrowserRelay.enabled = false;
            await finiteActivation?.composition.unload();
            await activation.composition.unload(); lifetime.retire();
            getStorage().setState({ machines: previous.machines, machineListByServerId: previous.machineListByServerId,
                machineListStatusByServerId: previous.machineListStatusByServerId });
        }
    });

    it('reaches the canonical catalog transport from the real configured browser handler', async () => {
        const { createTriageRunConfiguredActionHandler } = await import('../../../../../../packages/plugins/triage/src/actions/configuredActionRun');
        const { createTriageReadActionsActionHandler } = await import('../../../../../../packages/plugins/triage/src/actions/actionsCatalog');
        const { TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, TriageReadActionsActionInputV1Schema } = await import('../../../../../../packages/plugins/triage/src/actions/actionsCatalogProtocol');
        const { createTestkitAccountKv } = await import('../../../../../../packages/plugins/triage/src/settings/testkit/accountKv.test-support');
        const { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } = await import('../../../../../../packages/plugins/triage/src/settings/actions');
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/triage/src/manifest');
        const { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1 } = await import('../../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol');
        const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const lifetime = clientAccountLifetime();
        const previous = getStorage().getState();
        const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
        if (!admitted.ok) throw new Error('Triage manifest must be admitted');
        const declaration = admitted.manifest.contributes.actions.find(action => action.id === TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1)!;
        const subject = { kind: 'deploymentEnvironment', serverId: lifetime.scope.serverId, environmentId: 'serving-environment' } as const;
        const input = { v: 1, handoff: { task: 'investigate', configuredActionId: 'deployments.set-up',
            context: { kind: 'failure', subject }, evidence: [{ kind: 'failure', subject }],
            sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'compose' } };
        let relayed = 0;
        let requesterInvocation: unknown;
        const catalog = createTestkitAccountKv({ [TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1]: { v: -1 } });
        // Only persistent Account KV and the remote host's contribution service
        // are boundary fixtures; the remote catalog handler and parser are real.
        const catalogContext = { signal: new AbortController().signal, services: {
            storage: { account: { kv: catalog.kv } },
            targetedContributions: { observeForSelf: () => ({
                readCurrent: async () => ({ contributions: [] }), dispose: () => {},
            }) },
        } } as unknown as import('../../../../../../packages/plugins/triage/src/actions/dataContext').TriageDataActionContext;
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://server-client-action',
            serverIdentityId: 'srv_client_action', accountId: lifetime.scope.accountId, machineId: 'setup-machine',
            actionId: 'action.invoke', tokenEpoch: 0, execute: async (value, context) => {
                relayed++;
                requesterInvocation = context.invocation;
                const request = PluginUiExecuteActionRequestV1Schema.parse(value);
                return await createTriageReadActionsActionHandler()(TriageReadActionsActionInputV1Schema.parse(request.input), catalogContext);
            } });
        const machine = createMachineFixture({ id: boundary.machine.id, activeAt: Date.now(), access: boundary.machine.access });
        await publishMachineInventoryForTest(lifetime.scope, [machine]);
        network.setHttpResponder(async (url, init) => await boundary.handle(new URL(String(url)), init)
            ?? createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init));
        const activation = createClientActionActivation({ pluginId: PLUGIN_MANIFEST.id, localId: declaration.id,
            accountPlacement: true, accountLifetime: lifetime, accountActionDeclaration: declaration,
            confirmationWhen: declaration.confirmationWhen,
            inputSchema: declaration.inputSchema, outputSchema: declaration.resultSchema,
            artifactGraph: PluginUiArtifactsManifestEntryV2Schema.parse({ ...CLIENT_ACTION_ARTIFACT_GRAPH,
                artifactId: 'triage-account-runtime', executable: { exports: ['activate'] },
                entry: 'react-native/triage-account-runtime/entry.cjs.bundle',
                files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({ ...file, relativePath: 'react-native/triage-account-runtime/entry.cjs.bundle' })),
            }),
            accountManifest: { ...admitted.manifest, contributes: { actions: admitted.manifest.contributes.actions.filter(action =>
                action.id === declaration.id || action.id === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1) } },
            accountActivate: api => {
                api.actions.register(declaration.id, createTriageRunConfiguredActionHandler());
                api.actions.register(TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, createTriageReadActionsActionHandler());
            } });
        const catalogId = buildQualifiedPluginContributionKey({ pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1 });
        const { hostAccountOrigin: _origin, accountActionDeclaration: _declaration, ...receiverAction } = activation.projection.actionsById[catalogId]!;
        const receiverProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            actionsById: { [catalogId]: receiverAction },
        });
        daemonRpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { protocolVersion: 1, projection: receiverProjection };
            }
            return answerActionSchemasRead(request);
        });
        newSessionNavigation.mockClear();
        accountBrowserRelay.enabled = true;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const { scopedHomeActionExecutor } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
            const outcome = await dispatchPluginSurfaceAction({ action: { pluginId: PLUGIN_MANIFEST.id, localId: declaration.id },
                input, hostAction: { execute: scopedHomeActionExecutor(lifetime.scope), context: { serverId: lifetime.scope.serverId, runtimeAccountId: lifetime.scope.accountId, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } },
                resolveContributedAction: identity => activation.projection.actionsById[`${identity.pluginId}/${identity.localId}`] ?? null, clientAction: {} });
            expect(relayed, JSON.stringify(outcome)).toBe(1);
            expect(requesterInvocation).toMatchObject({ caller: { kind: 'plugin', pluginId: PLUGIN_MANIFEST.id }, authority: 'account_automation' });
            expect(requesterInvocation).not.toHaveProperty('reviewedParent');
            expect(outcome).toMatchObject({ ok: true, result: { handoff: { kind: 'unavailable', reason: 'configuredActionUnavailable' } } });
        } finally {
            accountBrowserRelay.enabled = false;
            await activation.composition.unload(); lifetime.retire();
            getStorage().setState({ machines: previous.machines, machineListByServerId: previous.machineListByServerId,
                machineListStatusByServerId: previous.machineListStatusByServerId });
        }
    });

    it.each(['parent', 'unadmitted', 'child'] as const)('keeps a nested Account Action on its admitted own or managed shared Machine (%s binding)', async bindingOwner => {
        const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/triage/src/manifest');
        const { createTriageReadTaskOriginErrorActionHandler } = await import('../../../../../../packages/plugins/triage/src/actions/taskOrigin');
        const { TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, TriageReadTaskOriginErrorInputV1Schema } = await import('../../../../../../packages/plugins/triage/src/actions/taskOriginProtocol');
        const { createInMemoryAccountCollection } = await import('../../../../../../packages/plugins/triage/src/corpus/collections/inMemoryAccountCollection');
        const { testkitEntryRef } = await import('../../../../../../packages/plugins/triage/src/corpus/testkit/observations.test-support');
        const lifetime = clientAccountLifetime();
        const previous = getStorage().getState();
        const normalized = ingestPluginManifestV2(PLUGIN_MANIFEST);
        if (!normalized.ok) throw new Error('Triage manifest must be admitted');
        const manifest = normalized.manifest;
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
            availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: manifest.id, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId: manifest.id, version: manifest.version },
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest,
                    collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } }] } });
        const selected = readPluginAccountAvailability(lifetime.scope).readCurrentAccountExecution(manifest.id);
        if (selected.kind !== 'available') throw new Error('Expected admitted Account Task surface');
        const declaration = manifest.contributes.actions.find(action => action.id === TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1)!;
        if (declaration.execution.target !== 'account') throw new Error('Expected Account Task Action');
        let relayed = 0;
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://server-client-action',
            serverIdentityId: 'srv_client_action', accountId: lifetime.scope.accountId, machineId: 'granted-task-controller',
            ...(bindingOwner === 'child' ? {} : { custodian: { accountId: 'another-account', displayName: 'Machine owner' }, sharedMachineRole: 'manage' }),
            actionId: 'action.invoke', tokenEpoch: 0, execute: async (value, context) => {
                relayed++;
                const request = PluginUiExecuteActionRequestV1Schema.parse(value);
                expect(request.action).toEqual({ pluginId: manifest.id, localId: declaration.id });
                // Only the remote HTTP transport and durable collection storage are fixtures.
                // The declared Task handler, collection binding and mark read remain real.
                return createTriageReadTaskOriginErrorActionHandler()(TriageReadTaskOriginErrorInputV1Schema.parse(request.input), {
                    signal: context.signal ?? new AbortController().signal, invokedAtMs: 1,
                    services: { storage: { account: { collection: (definition: Parameters<typeof createInMemoryAccountCollection>[0]['definition']) => createInMemoryAccountCollection({
                        definition, accountEncryptionMode: 'plain', material: null,
                    }).collection } } },
                } as unknown as import('../../../../../../packages/plugins/triage/src/actions/dataContext').TriageDataActionContext);
            } });
        const machine = createMachineFixture({ id: boundary.machine.id, activeAt: Date.now(), access: boundary.machine.access });
        const parentMachineId = bindingOwner === 'child' ? 'other-parent-controller' : machine.id;
        await publishMachineInventoryForTest(lifetime.scope, [machine,
            ...(bindingOwner === 'child' ? [{ ...machine, id: parentMachineId }] : [])]);
        network.setHttpResponder(async (url, init) => await boundary.handle(new URL(String(url)), init)
            ?? createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init));
        const activation = createClientActionActivation({ pluginId: manifest.id, localId: declaration.id,
            accountPlacement: true, accountLifetime: lifetime, occurrenceId: selected.custodyId,
            accountManifest: { ...manifest, contributes: { actions: [declaration], resources: [] } },
            inputSchema: declaration.inputSchema, outputSchema: declaration.resultSchema,
            artifactGraph: PluginUiArtifactsManifestEntryV2Schema.parse({ ...CLIENT_ACTION_ARTIFACT_GRAPH,
                artifactId: declaration.execution.account.artifactId, executable: { exports: [declaration.execution.account.exportName] },
                entry: `react-native/${declaration.execution.account.artifactId}/entry.cjs.bundle`,
                files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({ ...file, relativePath: `react-native/${declaration.execution.account.artifactId}/entry.cjs.bundle` })) }),
            accountHandler: () => { throw new Error('The browser must relay the finite Task read'); } });
        accountBrowserRelay.enabled = true;
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const facts = { ...surfaceContext(manifest.id), serverId: lifetime.scope.serverId,
                occurrenceId: selected.custodyId,
                accountExecutionOrigin: { ...lifetime.scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody },
                accountLifetime: lifetime, interactionEnabled: true, pluginUiProjection: activation.projection,
                resolveContributedAction: createPluginUiProjectedActionResolver(activation.projection.actionsById) };
            const parent = createBoundPluginSurfaceController({ facts: { ...facts, machineId: parentMachineId,
                daemonOccurrenceId: 'admitted-parent-occurrence', daemonInteractionEnabled: bindingOwner !== 'unadmitted' } });
            const child = createBoundPluginSurfaceController({ facts: { ...facts,
                surfaceId: 'cold-task-detail', parentLifetime: parent, daemonInteractionEnabled: bindingOwner === 'child',
                ...(bindingOwner === 'child' ? { machineId: machine.id, daemonOccurrenceId: 'admitted-child-occurrence' } : {}) } });
            onTestFinished(() => { child.dispose(); parent.dispose(); });
            const outcome = await child.hostApi.handleRequest({ version: 1, requestId: 'cold-task-origin',
                surface: child.surfaceContext, method: 'executeAction', payload: {
                    action: { pluginId: manifest.id, localId: declaration.id }, input: { v: 1,
                        entryRef: testkitEntryRef({ kindId: 'task', entryId: 'cold-task' }) },
                } });
            expect(outcome).toMatchObject(bindingOwner !== 'unadmitted' ? { v: 1, originError: null }
                : { code: 'target_unavailable' });
            expect(relayed).toBe(bindingOwner !== 'unadmitted' ? 1 : 0);
        } finally {
            accountBrowserRelay.enabled = false;
            await activation.composition.unload(); lifetime.retire(); clearPluginAccountAvailabilityProjection();
            getStorage().setState({ profileScope: previous.profileScope,
                machineRecordsByServerId: previous.machineRecordsByServerId,
                machineDisplayById: previous.machineDisplayById,
                machinePresenceById: previous.machinePresenceById, machinePresenceByServerId: previous.machinePresenceByServerId,
                machines: previous.machines, machineListByServerId: previous.machineListByServerId,
                machineListStatusByServerId: previous.machineListStatusByServerId });
        }
    });

    it.each(['browser', 'native'] as const)('keeps an Environment Account read on its controller when another own Machine is first (%s)', async httpHost => {
        const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const lifetime = clientAccountLifetime();
        const previous = getStorage().getState();
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://server-client-action',
            serverIdentityId: 'srv_client_action', accountId: lifetime.scope.accountId, machineId: 'environment-controller',
            actionId: 'action.invoke', tokenEpoch: 0,
            execute: () => ({ availability: 'parsed', items: ['database'] }) });
        const machines = ['older-own-machine', boundary.machine.id].map(id => createMachineFixture({ id,
            createdAt: id === 'older-own-machine' ? 2 : 1,
            activeAt: Date.now(), access: boundary.machine.access }));
        await publishMachineInventoryForTest(lifetime.scope, machines);
        // Only the controller answers the physical transport. A request to the
        // arbitrary first Machine fails at this boundary, as in the recorded page failure.
        network.setHttpResponder(async (url, init) => await boundary.handle(new URL(String(url)), init)
            ?? createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init));
        const activation = createClientActionActivation({ accountPlacement: true, accountLifetime: lifetime,
            accountHandler: () => { throw new Error('This finite Account read must run on its subject Machine'); } });
        accountBrowserRelay.enabled = httpHost === 'browser';
        await activation.composition.unload();
        try {
            const { resolveUiAccountActionFallbackMachineId } = await import('@/sync/ops/actions/accountActionDeps');
            expect(resolveUiAccountActionFallbackMachineId(lifetime.scope)).toBe('older-own-machine');
            await activation.composition.reconcile([activation.activation]);
            await expect(dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, input: {},
                resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
                hostAction: { execute: createActionExecutor({}).execute, context: {
                    serverId: lifetime.scope.serverId, runtimeAccountId: lifetime.scope.accountId,
                    externalActionTarget: { kind: 'machine', machineId: boundary.machine.id },
                } },
            })).resolves.toEqual({ ok: true, result: { availability: 'parsed', items: ['database'] } });
        } finally {
            accountBrowserRelay.enabled = false;
            await activation.composition.unload(); lifetime.retire();
            getStorage().setState({ profileScope: previous.profileScope,
                machineRecordsByServerId: previous.machineRecordsByServerId,
                machineDisplayById: previous.machineDisplayById,
                machinePresenceById: previous.machinePresenceById, machinePresenceByServerId: previous.machinePresenceByServerId,
                sessionListIndexByServerId: previous.sessionListIndexByServerId,
                machines: previous.machines, machineListByServerId: previous.machineListByServerId,
                machineListStatusByServerId: previous.machineListStatusByServerId });
        }
    });

    it.each(['unavailable', 'filesystem_identity_custody_unavailable'])(
        'retains preparation refusal %s through the real Action dispatcher and New Session settlement', async code => {
            const { createPluginOpenNewSessionHostApiHandler } = await import('./pluginOpenNewSessionHostApi');
            const { settlePluginSurfaceHostApiRequest } = await import('./createPluginSurfaceHostApi');
            const accountLifetime = clientAccountLifetime();
            const activation = createClientActionActivation({ accountLifetime, localId: 'prepare-review-workspace',
                // This is the fixture plugin's actual declared handler, invoked through its registered runtime.
                handler: async () => { throw new PluginError({ code, retryable: false,
                    details: { layer: 'policy', phase: 'admission' },
                    diagnostics: [{ code: 'filesystem_identity_custody_unavailable', severity: 'error' }] }); },
            });
            const operation = {
                point: { pointId: 'review', protocol: { id: 'review', version: 1 } },
                contributor: { pluginId: CALLER_PLUGIN_ID, contributionId: 'review-source',
                    occurrenceId: activation.action.occurrenceId, sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY },
                role: 'prepareReviewWorkspace', action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
            } as const;
            const selected = { kind: 'submitted' as const, action: operation.action, input: {},
                selection: { target: { pluginId: CALLER_PLUGIN_ID, sourceCustody: TARGET_SOURCE_CUSTODY },
                    point: operation.point, contributor: { pluginId: operation.contributor.pluginId,
                        contributionId: operation.contributor.contributionId, sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY } },
                connectedAccount: { kind: 'none' as const },
                presentation: { connectedAccountLabel: null, machineDisplayName: 'Development Mac' },
            };
            const api = createPluginSurfaceActionHostApi({ surfaceContext: surfaceContext(),
                callerBinding: mountedCallerBinding(), callerSourceCustody: TARGET_SOURCE_CUSTODY,
                targetSourceCustody: TARGET_SOURCE_CUSTODY,
                resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
                createOpenNewSession: executeSelectedOperation => createPluginOpenNewSessionHostApiHandler({
                    pluginId: CALLER_PLUGIN_ID, accountLifetime, isCurrent: () => true,
                    executionTarget: { serverId: accountLifetime.scope.serverId, machineId: 'machine-client-action' },
                    executeSelectedOperation,
                }),
            });
            newSessionNavigation.mockReset();
            try {
                await activation.composition.reconcile([activation.activation]);
                const request = { ...executeActionRequest({ checkoutIntent: 'preparedReviewWorkspace' }),
                    method: 'openNewSession' as const };
                const response = await settlePluginSurfaceHostApiRequest(request, () => api.handleRequest(request, {
                    targetedOperation: operation, selectedActionInput: selected,
                }));
                expect(response).toMatchObject({ kind: 'error', requestId: request.requestId,
                    payload: { code, layer: 'policy', phase: 'admission', retryable: false,
                        diagnostics: ['filesystem_identity_custody_unavailable'] } });
                expect(network.requests).toContainEqual(expect.objectContaining({
                    method: RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ,
                    payload: expect.objectContaining({ qualifiedActionId: `${CALLER_PLUGIN_ID}/${activation.action.id}` }),
                }));
                expect(newSessionNavigation).not.toHaveBeenCalled();
            } finally {
                api.dispose?.(); await activation.composition.unload(); accountLifetime.retire();
            }
        },
    );

    it.each([
        { publication: 'initial snapshot', settlement: 'prepared', detached: false },
        { publication: 'pushed snapshot', settlement: 'prepared', detached: false },
        { publication: 'pushed snapshot', settlement: 'typed refusal', detached: false },
        { publication: 'pushed snapshot', settlement: 'unrelated failed result', detached: false },
        { publication: 'initial snapshot', settlement: 'prepared', detached: true },
        { publication: 'pushed snapshot', settlement: 'prepared', detached: true },
        { publication: 'pushed snapshot', settlement: 'prepared', detached: true, transport: 'react-native' },
        { publication: 'pushed snapshot', settlement: 'prepared', detached: true, transport: 'hosted-web' },
        { publication: 'pushed snapshot', settlement: 'prepared', detached: true, navigationRefusal: true },
        { publication: 'pushed snapshot', settlement: 'prepared', detached: true, clientAction: true },
        { publication: 'pushed snapshot', settlement: 'aborted before admission', detached: false },
        { publication: 'pushed snapshot', settlement: 'cancelled deliberately', detached: false },
    ] as const)(
        'awaits the prepared parent operation while presenting native approval from its $publication ($settlement, detached=$detached, transport=$transport, navigationRefusal=$navigationRefusal, clientAction=$clientAction)', async scenario => {
            const { publication, settlement, detached } = scenario;
            const navigationRefusal = 'navigationRefusal' in scenario;
            const fromClientAction = 'clientAction' in scenario;
            const { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
            const { ActionApprovalRequestCreatedResultSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
            const { createActionApprovalContinuationObserver } = await import('@/components/approvals/actionApprovalContinuation');
            const { consumeActionOperationSnapshotPush } = await import('@/sync/domains/actionOperations/consumeActionOperationSnapshotPush');
            const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
            const { getActionOperation } = await import('@/sync/ops/actionOperations');
            const { createPluginOpenNewSessionHostApiHandler } = await import('./pluginOpenNewSessionHostApi');
            const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
            const { contributedActionFailureResult } = await import('../../../../../cli/src/plugins/runtime/invocation/actions/contributedActionFailure');
            await prepareSessionDraftPersistenceStorage();
            actionOperationStore.reset();
            const accountLifetime = clientAccountLifetime();
            const scope = { accountId: accountLifetime.scope.accountId,
                machineId: fromClientAction ? CLIENT_ACTION_ORIGIN.materializationRef.machineId : 'machine-1' };
            const identity = { pluginId: CALLER_PLUGIN_ID, localId: 'prepare-review-workspace' };
            const projected = PluginProjectedActionV2Schema.parse({ ...resolveDaemonTargetAction(identity), scopes: ['global'], surfaces: ['ui', 'plugin'],
                operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } } });
            const store = createActionOperationStore();
            const runner = createActionOperationRunner({ store, resolveAction: actionId => ({ actionId,
                title: 'Prepare review workspace', operation: projected.operation }) });
            const approvals = ['native-first-ask', 'native-second-ask'].map(artifactId =>
                ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created', artifactId,
                    actionId: 'workspace.materialize' }));
            const refusal = new PluginError({ code: 'channels_connection_required', message: 'Set up Channels first', retryable: false,
                details: { privateProviderFact: 'must-not-cross' },
                remediation: { kind: 'openSettings', path: '/settings/plugins/happier.channels/connections' } });
            const failed = { ok: false as const, errorCode: refusal.code, error: refusal.message,
                retryable: refusal.retryable, data: refusal.data };
            let finishPreparation!: () => void;
            const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
            let publishNextApproval!: () => void;
            let effects = 0;
            let observedRequestId: string | undefined;
            let observedActionId: string | undefined;
            let joinedParent = false;
            const registered: string[] = [];
            const approval = createActionApprovalContinuationObserver({ onExecuted() {} });
            clientActionSchemasByQualifiedId.set(buildQualifiedPluginContributionKey(identity), {
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            });
            network.setRpcResponder(async request => {
                if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
                    return { status: 'current', targetedSurfaceMounts: [], targetedContributions };
                }
                if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                    return { protocolVersion: 1, projectionDigest: 'prepared-source-digest', projection: {
                        v: 2, generation: 1, familiesById: {}, installedPackagesById: { [identity.pluginId]: {
                            id: identity.pluginId, displayName: 'Reviewer', version: '1.0.0', enabled: true,
                            source: { kind: 'localPath', locator: 'reviewer' },
                        } }, actionsById: { [buildQualifiedPluginContributionKey(identity)]: projected },
                    } };
                }
                if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                    const payload = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
                    observedRequestId = payload.requestId;
                    observedActionId = payload.qualifiedActionId;
                    return await runner.observe({ actionId: payload.qualifiedActionId, requestId: payload.requestId,
                        failureResult: settlement === 'unrelated failed result'
                            ? { ...contributedActionFailureResult,
                                project: () => ({ ok: true, result: { kind: 'prepared', repositoryPath: '/must-not-open' } }) }
                            : contributedActionFailureResult,
                        input: payload.input, scope, cancellation: 'supported', execute: async context => {
                            // The fixture plugin's effect stays held by the real finite runner after acceptance.
                            effects++;
                            const publish = (receipt: typeof approvals[number]) => context.updateProgress({
                                phase: 'waiting_for_approval', label: 'Waiting for approval', approval: receipt });
                            publish(approvals[0]!);
                            publishNextApproval = () => publish(approvals[1]!);
                            context.operationAcceptance?.accept(approvals[0]!);
                            if (publication === 'initial snapshot') publishNextApproval();
                            await preparation;
                            if (context.signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
                            return settlement === 'prepared'
                                ? { ok: true, result: { kind: 'prepared', repositoryPath: '/workspaces/review-final' } } : failed;
                        } });
                }
                if (request.method === ACTION_OPERATION_RPC_METHODS_V2.list) {
                    return store.list({ ...scope, ...(request.payload as { requestIdentity?: { actionId: string; requestId: string } }) });
                }
                if (request.method === ACTION_OPERATION_RPC_METHODS_V2.get) {
                    const payload = request.payload as { operationId: string; waitForTerminal?: boolean };
                    joinedParent ||= payload.waitForTerminal === true;
                    const operation = payload.waitForTerminal
                        ? await runner.waitForTerminal(scope, payload.operationId) : store.get(scope, payload.operationId);
                    return operation ? { kind: 'found', operation } : { kind: 'not_found' };
                }
                if (request.method === ACTION_OPERATION_RPC_METHODS_V1.cancel) {
                    return runner.cancel(scope, (request.payload as { operationId: string }).operationId);
                }
                return answerActionSchemasRead(request);
            });
            const operation = { point: { pointId: 'review', protocol: { id: 'review', version: 1 } },
                contributor: { pluginId: identity.pluginId, contributionId: 'review-source',
                    occurrenceId: projected.occurrenceId!, sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY },
                role: 'prepareReviewWorkspace', action: identity } as const;
            const selected = { kind: 'submitted' as const, action: identity, input: {},
                selection: { target: { pluginId: CALLER_PLUGIN_ID, sourceCustody: TARGET_SOURCE_CUSTODY },
                    point: operation.point, contributor: { pluginId: identity.pluginId, contributionId: 'review-source',
                        sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY } }, connectedAccount: { kind: 'none' as const },
                presentation: { connectedAccountLabel: null, machineDisplayName: 'Development Mac' } };
            const targetedContributions = PluginUiTargetedContributionsV1Schema.parse({
                target: { pluginId: CALLER_PLUGIN_ID, occurrenceId: `occurrence-${CALLER_PLUGIN_ID}`,
                    sourceCustody: TARGET_SOURCE_CUSTODY },
                points: [{ pointId: operation.point.pointId, protocols: [{ protocol: operation.point.protocol,
                    contributions: [{ contributor: operation.contributor, protocol: operation.point.protocol,
                        operations: [operation], surfaces: [] }] }] }],
            });
            const physicalCarrier = 'transport' in scenario;
            const selectorInputs = physicalCarrier ? await loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
                machineId: scope.machineId, serverId: accountLifetime.scope.serverId, accountLifetime, reuseFreshReady: false }) : null;
            if (physicalCarrier && selectorInputs?.kind !== 'ready') throw new Error('Prepared source projection did not load');
            const { createPluginActionInputSelectionHostApiHandler } = await import('./pluginActionInputSelectionHostApi');
            const contributedAction = { ...scope, serverId: accountLifetime.scope.serverId, accountLifetime,
                    onApprovalPending: registration => {
                        registered.push(typeof registration === 'string' ? registration : registration.artifactId);
                        approval.requestApproval(registration);
                    } } satisfies NonNullable<DispatchPluginSurfaceActionInput['contributedAction']>;
            const api = createPluginSurfaceActionHostApi({ surfaceContext: surfaceContext(),
                callerBinding: mountedCallerBinding(), callerSourceCustody: TARGET_SOURCE_CUSTODY,
                targetSourceCustody: TARGET_SOURCE_CUSTODY, resolveContributedAction: resolveExactClientAction(projected),
                contributedAction,
                ...(selectorInputs?.kind === 'ready' ? { selectActionInput: createPluginActionInputSelectionHostApiHandler({
                    pluginProjectionById: selectorInputs.inputs.pluginProjectionById,
                    pluginUiProjection: selectorInputs.inputs.pluginUiProjection, targetedContributions,
                    resolveContributedAction: resolveExactClientAction(projected), isCurrent: () => true,
                    host: { machineId: scope.machineId, serverId: accountLifetime.scope.serverId,
                        targetPluginId: CALLER_PLUGIN_ID, accountLifetime },
                }) } : {}),
                createOpenNewSession: executeSelectedOperation => createPluginOpenNewSessionHostApiHandler({
                    pluginId: CALLER_PLUGIN_ID, accountLifetime, isCurrent: () => true,
                    executionTarget: { serverId: accountLifetime.scope.serverId, machineId: scope.machineId }, executeSelectedOperation,
                }) });
            newSessionNavigation.mockReset();
            let settled = false;
            const caller = new AbortController();
            const request = { ...executeActionRequest({ checkoutIntent: 'preparedReviewWorkspace',
                prompt: 'Review the selected pull request and explain the changes.',
                attachments: [{ attachmentLocalId: 'entry', value: {
                    key: 'pull-request:42', value: { v: 1, number: 42 }, presentation: { label: 'PR #42' },
                } }],
            }), method: 'openNewSession' as const };
            const carrier = 'transport' in scenario
                ? await physicalHostApiCarrier(scenario.transport, api, () => true, 'plain', request.surface) : null;
            const carrierSelection = carrier ? await carrier.api.selectActionInput({ operation, draft: {} }, { signal: caller.signal }) : null;
            if (carrierSelection && carrierSelection.kind !== 'submitted') throw new Error('Prepared source selection did not submit');
            const activation = fromClientAction ? createClientActionActivation({ accountLifetime, localId: 'start-prepared-review',
                handler: async (_input, context) => {
                    const selectedInput = await context.ui.selectActionInput({ operation, draft: {} });
                    if (selectedInput.kind !== 'submitted') throw new Error('Prepared source selection did not submit');
                    await context.ui.openNewSession(PluginUiOpenNewSessionRequestV1Schema.parse(request.payload), {
                        preparedReviewWorkspace: { operation, result: selectedInput },
                    });
                    return null;
                } }) : null;
            if (activation) await activation.composition.reconcile([activation.activation]);
            if (settlement === 'aborted before admission') caller.abort();
            let invocationResult: unknown;
            const pending = Promise.resolve(activation ? dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id }, signal: caller.signal,
                callerSourceCustody: TARGET_SOURCE_CUSTODY, targetSourceCustody: TARGET_SOURCE_CUSTODY,
                resolveContributedAction: action => action.localId === activation.action.id
                    ? activation.action : resolveExactClientAction(projected)(action), clientAction: {}, contributedAction,
            }).then(outcome => outcome.ok ? outcome.result : outcome.reason) : carrier
                ? carrier.api.openNewSession(PluginUiOpenNewSessionRequestV1Schema.parse(request.payload), { signal: caller.signal,
                    preparedReviewWorkspace: { operation, result: carrierSelection ?? selected } }).then(() => null,
                        error => { if (!caller.signal.aborted) throw error; return null; })
                : api.handleRequest(request, { targetedOperation: operation, selectedActionInput: selected, signal: caller.signal }))
                .then(result => { settled = true; invocationResult = result; return result; });
            void pending.catch(() => {});
            try {
                if (settlement === 'aborted before admission') {
                    expect(await pending).toMatchObject({ code: 'unavailable', diagnostics: ['plugin_ui_invocation_aborted'] });
                    expect(effects).toBe(0);
                    expect(store.list(scope).items).toEqual([]);
                    expect(newSessionNavigation).not.toHaveBeenCalled();
                    return;
                }
                if (fromClientAction) await vi.waitFor(() => expect(effects,
                    `Invocation result before daemon admission: ${JSON.stringify(invocationResult)}`).toBe(1));
                await vi.waitFor(() => expect(registered, `Invocation result: ${JSON.stringify(invocationResult)}`)
                    .toContain(approvals[0]!.artifactId));
                expect(settled).toBe(false);
                expect(approval.getSnapshot().approval?.artifactId).toBe(approvals[0]!.artifactId);
                await vi.waitFor(() => expect(joinedParent).toBe(true));
                if (publication === 'pushed snapshot') {
                    publishNextApproval();
                    const snapshot = store.list(scope).items[0]!;
                    await consumeActionOperationSnapshotPush({ accountId: scope.accountId, accountEncryptionMode: 'plain',
                        sourceServerId: accountLifetime.scope.serverId,
                        update: { type: 'action-operation-updated', machineId: scope.machineId, content: { t: 'plain', v: snapshot } },
                        readSnapshot: operationId => getActionOperation({ ...scope, serverId: accountLifetime.scope.serverId, operationId }) });
                }
                await vi.waitFor(() => expect(registered).toContain(approvals[1]!.artifactId));
                expect(settled).toBe(false);
                expect(newSessionNavigation).not.toHaveBeenCalled();
                if (detached) caller.abort();
                if (settlement === 'cancelled deliberately') {
                    const admitted = [...actionOperationStore.getSnapshot().operationsByKey.values()]
                        .find(value => value.snapshot.requestId === observedRequestId);
                    expect(admitted).toBeDefined();
                    const { requestActionOperationStop } = await import('@/components/inbox/actionOperations/requestActionOperationStop');
                    const { Modal } = await import('@/modal');
                    vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
                    expect(await requestActionOperationStop(admitted!)).toEqual({ kind: 'requested' });
                    expect(caller.signal.aborted).toBe(false);
                }
                finishPreparation();
                const result = await pending;
                expect(observedActionId).toBe(`${identity.pluginId}/${identity.localId}`);
                expect(observedRequestId).toBeTruthy();
                expect(network.requests.filter(value => value.method === ACTION_OPERATION_RPC_METHODS_V2.list)
                    .map(value => value.payload)).toEqual([{ requestIdentity: { actionId: observedActionId, requestId: observedRequestId } }]);
                expect(effects).toBe(1);
                if (settlement === 'prepared') {
                    if (detached) {
                        expect(newSessionNavigation).not.toHaveBeenCalled();
                        await vi.waitFor(() => {
                            const retained = [...actionOperationStore.getSnapshot().operationsByKey.values()]
                                .find(value => value.snapshot.requestId === observedRequestId);
                            expect(retained?.snapshot.state).toBe('succeeded');
                            expect(retained?.resumeNewSession).toBeTypeOf('function');
                        });
                        const completed = [...actionOperationStore.getSnapshot().operationsByKey.values()]
                            .find(value => value.snapshot.requestId === observedRequestId);
                        expect(completed?.snapshot).toMatchObject({ state: 'succeeded',
                            result: { kind: 'prepared', repositoryPath: '/workspaces/review-final' } });
                        const { createActionOperationPresentationCoordinator } = await import('@/components/inbox/actionOperations/actionOperationPresentationCoordinator');
                        const { acknowledgeActionOperationPresented } = await import('@/sync/domains/actionOperations/acknowledgeActionOperationPresented');
                        const coordinator = createActionOperationPresentationCoordinator({
                            openDetail() {}, openDestination() {}, markPresented: operation => {
                                acknowledgeActionOperationPresented(operation.snapshot, operation.serverId);
                            },
                        });
                        if (navigationRefusal) {
                            // Router/native navigation is the physical boundary; the seed
                            // producer and refusal-to-attention path remain real.
                            newSessionNavigation.mockImplementationOnce(() => { throw new Error('Router unavailable'); });
                            coordinator.open(completed!);
                            await vi.waitFor(() => expect(actionOperationStore.getSnapshot().followUpAttentionByRequestKey.size).toBe(1));
                            expect(newSessionNavigation).toHaveBeenCalledTimes(1);
                            expect([...actionOperationStore.getSnapshot().operationsByKey.values()]
                                .find(value => value.snapshot.requestId === observedRequestId)?.resumeNewSession).toBeTypeOf('function');
                        }
                        // Activity/Details is a returning view of the existing operation.
                        // Reopening it must consume the retained composer handoff once.
                        coordinator.open(completed!);
                        await vi.waitFor(() => expect(newSessionNavigation).toHaveBeenCalledTimes(navigationRefusal ? 2 : 1));
                        if (navigationRefusal) await vi.waitFor(() =>
                            expect(actionOperationStore.getSnapshot().followUpAttentionByRequestKey.size).toBe(0));
                        coordinator.open(completed!);
                        await act(async () => {});
                    } else expect(result).toBeNull();
                    expect(newSessionNavigation).toHaveBeenCalledTimes(navigationRefusal ? 2 : 1);
                    const route = newSessionNavigation.mock.calls[navigationRefusal ? 1 : 0]![0] as { params: { draftId: string } };
                    const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
                    expect(readNewSessionDraftFromRepository({ scope: accountLifetime.scope, draftId: route.params.draftId }))
                        .toMatchObject({ selectedPath: '/workspaces/review-final',
                            input: 'Review the selected pull request and explain the changes.',
                            composerAttachmentSeeds: [expect.objectContaining({ pluginId: CALLER_PLUGIN_ID, attachmentLocalId: 'entry',
                                value: { key: 'pull-request:42', value: { v: 1, number: 42 }, presentation: { label: 'PR #42' } } })] });
                } else if (settlement === 'cancelled deliberately') {
                    expect(newSessionNavigation).not.toHaveBeenCalled();
                    expect(store.list(scope).items[0]?.state).toBe('cancelled');
                    expect(result).not.toBeNull();
                } else {
                    expect(newSessionNavigation).not.toHaveBeenCalled();
                    expect(result).toMatchObject(settlement === 'typed refusal'
                        ? { code: 'unavailable', diagnostics: [refusal.code] }
                        : { code: 'timeout', diagnostics: ['plugin_ui_action_outcome_unknown'] });
                    // The host envelope exposes retryability; recovery destinations remain on the
                    // canonical contributed failure consumed by the dispatch outcome.
                    expect(result).toMatchObject({ retryable: false });
                    expect(JSON.stringify(result)).not.toContain('must-not-cross');
                }
            } finally {
                finishPreparation(); await pending; await carrier?.dispose(); await activation?.composition.unload(); api.dispose?.(); approval.dispose(); accountLifetime.retire(); actionOperationStore.reset();
            }
        },
    );

    it('opens the canonical New Session draft from an unmounted client Action', async () => {
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({
            accountLifetime,
            handler: async (_input, context) => {
                await context.ui.openNewSession({ prompt: 'Repair the selected issue',
                    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'worker' } } });
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
                .toMatchObject({ input: 'Repair the selected issue',
                    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'worker' } } });
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('preserves the shared New Session refusal diagnostic through the public client Action', async () => {
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({ accountLifetime, handler: async (_input, context) => {
            await context.ui.openNewSession({ prompt: 'Repair the selected issue' });
            return null;
        } });
        newSessionNavigation.mockReset();
        // The physical router is the system boundary. The seed, draft and
        // navigation owners produce the actual navigation_unavailable refusal.
        newSessionNavigation.mockImplementationOnce(() => { throw new Error('Router unavailable'); });
        const hostApi = createPluginSurfaceActionHostApi({ surfaceContext: surfaceContext(),
            callerBinding: mountedCallerBinding(), callerSourceCustody: TARGET_SOURCE_CUSTODY,
            resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {} });
        const native = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({ mount: { kind: 'destination',
                destination: { pluginId: CALLER_PLUGIN_ID, localId: 'inspector-app' }, container: 'rightPane' }, target: { kind: 'app' } }),
            requestSurface: surfaceContext(), installedMethods: hostApi.installedMethods,
            handleRequest: hostApi.handleRequest,
        });
        try {
            await activation.composition.reconcile([activation.activation]);
            const action = { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id };
            const error: unknown = await native.api.executeAction(action, {}).catch(error => error);
            expect(error).toMatchObject({ code: 'unavailable', retryable: false,
                diagnostics: [{ code: 'navigation_unavailable', severity: 'error' }] });
            hostApi.notifyConnectionSettled?.();
            hostApi.notifyConnectionSettled?.();
            await act(async () => {});
            expect(newSessionNavigation).toHaveBeenCalledTimes(1);
            await expect(native.api.executeAction(action, {})).resolves.toBeNull();
            expect(newSessionNavigation).toHaveBeenCalledTimes(2);
            const route = newSessionNavigation.mock.calls[1]![0] as Readonly<{ params: { draftId: string } }>;
            const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
            expect(readNewSessionDraftFromRepository({ scope: accountLifetime.scope, draftId: route.params.draftId }))
                .toMatchObject({ input: 'Repair the selected issue' });
        } finally {
            native.dispose(); await activation.composition.unload(); accountLifetime.retire(); newSessionNavigation.mockReset();
        }
    });

    it('exposes the ordinary exact Composer boundary to an unmounted client Action without sending', async () => {
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({ accountLifetime,
            handler: async (_input, context) => {
                const ref = { kind: 'session', sessionId: 'unmounted-destination' } as const;
                const read = await context.ui.readComposer(ref);
                const applied = await context.ui.applyComposer(ref, { expectedRevision: 0,
                    operations: [{ kind: 'text.insert', position: { offset: 0 }, text: 'Repair' }] });
                return { read, applied };
            } });
        try {
            await activation.composition.reconcile([activation.activation]);
            await expect(dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
            })).resolves.toEqual({ ok: true, result: {
                read: { status: 'unavailable', reason: 'scopeClosed' }, applied: { status: 'composerUnavailable' },
            } });
        } finally { await activation.composition.unload(); accountLifetime.retire(); }
    });

    it('reads a retained hidden New Session draft through a client Action without admitting hidden edits or a retired draft', async () => {
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const { createNewSessionComposerDocumentOwner } = await import('@/components/sessions/composer/newSessionComposerDocumentOwner');
        const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
        const { registerComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const accountLifetime = { ...clientAccountLifetime(),
            scope: { serverId: resolveServerProfileScopeIdForIdentifier(rpcHomes.get('server-client-action')!.id), accountId: 'test-account' } };
        const ref = { kind: 'newSession', instanceId: 'retained-client-action-draft' } as const;
        const previous = getStorage().getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
        getStorage().setState({ sessionLocalStateScope: accountLifetime.scope, profileScope: accountLifetime.scope });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const owner = createNewSessionComposerDocumentOwner({ scope: accountLifetime.scope, ref });
        let presented = false;
        owner.replaceDocument({ text: 'Retained note', structuredInputMentions: [], composerAttachments: [] });
        const release = registerComposerPresentationTarget(ref, {
            readScope: () => accountLifetime.scope, readRevision: () => owner.read().revision,
            replace: () => owner.read().revision, isPresented: () => presented,
            readSnapshot: () => projectComposerDocumentSnapshot({ owner, attachmentCatalog: { entriesById: null },
                presentation: { layout: 'wrap', focused: false, editable: true, submittable: true, submitting: false, running: false } }),
            commitDocument: ({ expectedRevision, mutation }) => owner.apply(expectedRevision, mutation),
            commitDocumentEmitsChange: true,
        });
        const activation = createClientActionActivation({ accountLifetime, handler: async (_input, context) => ({
            read: await context.ui.readComposer(ref),
            applied: await context.ui.applyComposer(ref, { expectedRevision: owner.read().revision,
                operations: [{ kind: 'text.set', text: 'Presented edit' }] }),
        }) });
        const dispatch = () => dispatchPluginSurfaceAction({
            action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
            resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
        });
        try {
            await activation.composition.reconcile([activation.activation]);
            const outcome = await dispatch();
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: {
                read: { status: 'ready', snapshot: { ref, text: 'Retained note' } },
                applied: { status: 'composerUnavailable' },
            } });
            expect(owner.read().document.text).toBe('Retained note');
            presented = true;
            expect(await dispatch()).toMatchObject({ ok: true, result: {
                read: { status: 'ready', snapshot: { text: 'Retained note' } }, applied: { status: 'applied' },
            } });
            expect(owner.read().document.text).toBe('Presented edit');
            release();
            expect(await dispatch()).toMatchObject({ ok: true, result: {
                read: { status: 'unavailable', reason: 'scopeClosed' }, applied: { status: 'composerUnavailable' },
            } });
        } finally {
            release(); await activation.composition.unload(); accountLifetime.retire();
            getStorage().setState({ sessionLocalStateScope: previous.sessionLocalStateScope, profileScope: previous.profileScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousRuntimeAvailable);
        }
    });

    it('applies a client Action Composer transaction to its real scoped draft while preserving prior text', async () => {
        const { createExistingSessionComposerDocumentOwner } = await import('@/components/sessions/composer/existingSessionComposerDocumentOwner');
        const { projectComposerDocumentSnapshot } = await import('@/components/sessions/composer/composerSnapshotProjection');
        const { registerSessionComposerPresentationTarget, readMountedComposerPresentationSnapshot } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { createSessionFixture, createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const accountLifetime = { ...clientAccountLifetime(),
            scope: { serverId: resolveServerProfileScopeIdForIdentifier(rpcHomes.get('server-client-action')!.id), accountId: 'test-account' } };
        const ref = { kind: 'session', sessionId: 'handoff-composer' } as const;
        const previous = getStorage().getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
        getStorage().setState({ sessionLocalStateScope: accountLifetime.scope, profileScope: accountLifetime.scope,
            sessions: { ...previous.sessions, [ref.sessionId]: createSessionFixture({ id: ref.sessionId,
                access: createSessionAccessFixture('owner', { readTranscript: false }) }) } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const owner = createExistingSessionComposerDocumentOwner({ scope: accountLifetime.scope, ref });
        owner.replaceDocument({ text: 'Existing note', structuredInputMentions: [], composerAttachments: [] });
        const readSnapshot = () => projectComposerDocumentSnapshot({ owner,
            attachmentCatalog: { entriesById: null }, presentation: {
                layout: 'wrap', focused: true, editable: true, submittable: true, submitting: false, running: false,
            } });
        const release = registerSessionComposerPresentationTarget({ serverId: accountLifetime.scope.serverId, sessionId: ref.sessionId }, {
            readScope: () => accountLifetime.scope, readRevision: () => owner.read().revision,
            replace: () => owner.read().revision, readSnapshot,
            commitDocument: ({ expectedRevision, mutation }) => owner.apply(expectedRevision, mutation),
            commitDocumentEmitsChange: true,
        });
        const activation = createClientActionActivation({ accountLifetime,
            handler: async (_input, context) => {
                const session = await context.ui.readSession(ref.sessionId);
                const read = await context.ui.readComposer(ref);
                if (read.status !== 'ready') throw new Error('Expected the mounted Composer');
                const result = await context.ui.applyComposer(ref, { expectedRevision: read.snapshot.revision,
                    operations: [{ kind: 'text.insert', position: { offset: read.snapshot.text.length }, text: '\nRepair' }] });
                return { sessionId: session?.sessionId ?? null, result };
            } });
        try {
            expect({ scope: getActiveServerAccountScope(), snapshot: readMountedComposerPresentationSnapshot({ ref, scope: accountLifetime.scope }) })
                .toMatchObject({ scope: accountLifetime.scope, snapshot: { text: 'Existing note' } });
            await activation.composition.reconcile([activation.activation]);
            const outcome = await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
            });
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true,
                result: { sessionId: ref.sessionId, result: { status: 'applied' } } });
            expect(owner.read().document.text).toBe('Existing note\nRepair');
            expect(network.requests.filter(request => request.method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)).toEqual([]);
        } finally {
            release(); await activation.composition.unload(); accountLifetime.retire();
            getStorage().setState({ sessions: previous.sessions, sessionLocalStateScope: previous.sessionLocalStateScope,
                profileScope: previous.profileScope });
            publishAppliedActiveServerSnapshot(previousApplied, previousRuntimeAvailable);
        }
    });

    it.each(['dispatcher', 'catalog'] as const)('preserves a host trigger anchor when an unmounted client Action asks for a Session address (%s)', async entry => {
        const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = getStorage().getState().profileScope;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        getStorage().setState({ profileScope: { serverId: 'server-client-action', accountId: 'test-account' } });
        publishAppliedActiveServerSnapshot({ serverId: 'server-client-action', serverUrl: 'https://client-action.example', generation: 0 });
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        onTestFinished(() => {
            retireActiveServerAccountScopeLifetime();
            getStorage().setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        });
        if (!accountLifetime) throw new Error('Missing real captured Account lifetime');
        const anchor = { kind: 'rect', rect: { left: 24, top: 36, width: 32, height: 32 } } as const;
        const activation = createClientActionActivation({ accountLifetime,
            handler: async (_input, context) => await context.ui.selectActionInput({
                hostAction: { action: 'session.transcript.get', projection: 'sessionAddress' },
            }),
        });
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show').mockImplementation(config => {
            const props = config.props as Readonly<{ onResolve(selection: unknown): void }>;
            queueMicrotask(() => props.onResolve({ kind: 'existingSession', serverId: accountLifetime.scope.serverId, sessionId: 'chosen' }));
            return 'action-session-selector';
        });
        const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        try {
            await activation.composition.reconcile([activation.activation]);
            const outcome = entry === 'dispatcher' ? await dispatchPluginSurfaceAction({
                action: { pluginId: CALLER_PLUGIN_ID, localId: activation.action.id },
                resolveContributedAction: resolveExactClientAction(activation.action), clientAction: {},
                actionInputAnchor: anchor,
            }) : await (async () => {
                const { createPluginContributedActionController } = await import('../actions/pluginContributedActionController');
                const { openPluginContributedAction } = await import('../actions/openPluginContributedAction');
                const plugin = {
                    pluginId: CALLER_PLUGIN_ID, title: 'Selector tools', description: null, version: '1.2.3',
                    enabled: true, generation: CLIENT_ACTION_GENERATION, generationLabel: String(CLIENT_ACTION_GENERATION),
                    immutableGenerationId: activation.action.occurrenceId, status: null, provenance: null, diagnostics: [],
                    actions: [{ id: activation.action.id, occurrenceId: activation.action.occurrenceId,
                        title: 'Choose a Session', description: null, icon: null, scopes: ['global'], surfaces: ['ui'],
                        placementBindings: ['detailsPanel'], slash: null, priority: null, dangerLevel: 'safe', confirmation: null,
                        available: true }], resources: [], editableSettingsGroups: [],
                } satisfies import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters').PluginProjectionEntry;
                const controller = createPluginContributedActionController({ resolveCurrent: () => ({
                    pluginProjectionById: { [CALLER_PLUGIN_ID]: plugin },
                    resolveContributedAction: resolveExactClientAction(activation.action),
                    host: { machineId: CLIENT_ACTION_HOST_ORIGIN.machineId, serverId: accountLifetime.scope.serverId, accountLifetime },
                }) });
                const action = controller.list({ placement: 'detailsPanel', scope: 'global' })[0];
                expect(action).toBeDefined();
                if (!action) throw new Error('Missing registered catalog Action');
                const opened = await openPluginContributedAction({ controller, action, anchor });
                expect(opened.kind).toBe('direct');
                return opened.kind === 'direct' ? opened.outcome : null;
            })();
            expect(outcome).toMatchObject({ ok: true, result: { kind: 'sessionAddress', session: { sessionId: 'chosen' } } });
            const { validateContributedActionSessionAddressV1 } = await import('@happier-dev/protocol/actions/executor/sessionTargets');
            expect(validateContributedActionSessionAddressV1({ selectionScope: accountLifetime, callerPluginId: CALLER_PLUGIN_ID,
                sessionAddress: { serverId: accountLifetime.scope.serverId, sessionId: 'chosen' } })).toMatchObject({ ok: true });
            expect(show.mock.calls.at(-1)?.[0].chrome).toMatchObject({ anchor, phonePresentation: 'sheet' });
        } finally { await activation.composition.unload(); show.mockRestore(); hide.mockRestore(); }
    });

    it.each(['catalog', 'reference', 'denied', 'stale', 'wrong-row', 'machine-missing'] as const)('admits Account client message menu context and keeps reference refusals at dispatch (%s)', async entry => {
        const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousScope = getStorage().getState().profileScope;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        getStorage().setState({ profileScope: { serverId: 'server-client-action', accountId: 'test-account' } });
        publishAppliedActiveServerSnapshot({ serverId: 'server-client-action', serverUrl: rpcHomes.get('server-client-action')!.serverUrl, generation: 0 });
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        onTestFinished(() => {
            retireActiveServerAccountScopeLifetime();
            getStorage().setState({ profileScope: previousScope });
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
        });
        if (!accountLifetime) throw new Error('Missing real captured Account lifetime');
        let handlerEntered = false;
        let receivedMessage: unknown;
        const reference = { v: 1, sessionId: 'message-session', messageId: 'assistant-message', observedRevision: 'revision-1' } as const;
        const { createSessionFixture, createPlainSessionByIdResponseFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { createSessionReadBatchFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
        const { SessionMessageV1Schema } = await import('@happier-dev/protocol/sessions/messages/sessionMessagesPageV1');
        const session = createSessionFixture({ id: reference.sessionId, encryptionMode: 'plain' });
        const row = SessionMessageV1Schema.parse({ id: reference.messageId, seq: 1, localId: null, createdAt: 1,
            messageRole: 'agent', messageActionReference: reference,
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Selected answer' } } } });
        network.setHttpResponder(createSessionReadBatchFetchBoundary(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/messages/action-reference/resolve') && entry === 'denied') return Response.json({ error: 'forbidden' }, { status: 403 });
            if (path.endsWith('/messages/action-reference/resolve')) return Response.json({ status: 'available', message: {
                sessionId: reference.sessionId, messageId: reference.messageId, observedRevision: reference.observedRevision, seq: 1, messageRole: 'agent',
            } });
            if (path === '/v2/sessions/message-session') return Response.json(createPlainSessionByIdResponseFixture(session));
            if (path === '/v1/sessions/message-session/messages') return Response.json({ messages: [{ ...row, ...(entry === 'wrong-row' ? { id: 'another-message' } : {}),
                messageActionReference: { ...reference, ...(entry === 'stale' ? { observedRevision: 'revision-2' } : {}) } }], hasMore: false });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        }));
        const activation = createClientActionActivation({ accountLifetime, accountPlacement: true,
            accountActionDeclaration: {
                id: 'refresh-index', title: 'Create task', scopes: ['message'], surfaces: ['ui'],
                placementBindings: ['message.menu'], dangerLevel: 'safe',
                execution: { target: 'client', client: {
                    artifactId: CLIENT_ACTION_TARGET.artifactId, exportName: CLIENT_ACTION_TARGET.exportName,
                }, platforms: [CLIENT_ACTION_TARGET.platform] },
            },
            handler: async (_input, context) => { handlerEntered = true; receivedMessage = context.messageAction; return {}; },
        });
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert').mockImplementation(() => {});
        try {
            await activation.composition.reconcile([activation.activation]);
            const { createPluginContributedActionController } = await import('../actions/pluginContributedActionController');
            const { openPluginContributedAction } = await import('../actions/openPluginContributedAction');
            const plugin = {
                pluginId: CALLER_PLUGIN_ID, title: 'Message tools', description: null, version: '1.2.3',
                enabled: true, generation: CLIENT_ACTION_GENERATION, generationLabel: String(CLIENT_ACTION_GENERATION),
                immutableGenerationId: activation.action.occurrenceId, status: null, provenance: null, diagnostics: [],
                actions: [{ id: activation.action.id, occurrenceId: activation.action.occurrenceId,
                    title: 'Create task', description: null, icon: null, scopes: ['message'], surfaces: ['ui'],
                    placementBindings: ['message.menu'], slash: null, priority: null, dangerLevel: 'safe', confirmation: null,
                    available: true }], resources: [], editableSettingsGroups: [],
            } satisfies import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters').PluginProjectionEntry;
            const controller = createPluginContributedActionController({ resolveCurrent: () => ({
                pluginProjectionById: { [CALLER_PLUGIN_ID]: plugin },
                resolveContributedAction: resolveExactClientAction(entry === 'machine-missing'
                    ? PluginProjectedActionV2Schema.parse({ ...activation.action, execution: { target: 'daemon' } }) : activation.action),
                host: { machineId: entry === 'machine-missing' ? undefined : CLIENT_ACTION_HOST_ORIGIN.machineId, serverId: accountLifetime.scope.serverId, accountLifetime,
                    sessionId: 'message-session', messageActionReference: {
                        v: 1, sessionId: 'message-session', messageId: 'assistant-message', observedRevision: 'revision-1',
                    },
                },
            }) });
            if (entry === 'machine-missing') {
                expect(controller.list({ placement: 'message.menu', scope: 'message' })).toEqual([]);
                expect(handlerEntered).toBe(false);
                return;
            }
            if (entry === 'catalog') {
                const action = controller.list({ placement: 'message.menu', scope: 'message' })[0];
                if (!action) throw new Error('Missing registered catalog Action');
                const opened = await openPluginContributedAction({ controller, action });
                expect(opened).toMatchObject({ kind: 'direct', outcome: {
                    ok: true, result: {},
                } });
            } else {
                const dispatched = await controller.invokeReference({
                    pluginId: CALLER_PLUGIN_ID, localId: activation.action.id,
                }, {});
                if (entry === 'reference') {
                    expect(dispatched).toMatchObject({ kind: 'settled', outcome: { ok: true, result: {} } });
                } else {
                    expect(dispatched).toMatchObject({ kind: 'settled', outcome: {
                        ok: false, code: 'unavailable', reason: 'plugin_message_action_unavailable',
                    } });
                }
            }
            if (entry === 'catalog' || entry === 'reference') {
                expect(handlerEntered).toBe(true);
                expect(receivedMessage).toMatchObject({ sessionId: reference.sessionId, messageId: reference.messageId,
                    observedRevision: reference.observedRevision, visibleText: 'Selected answer' });
                expect(alert).not.toHaveBeenCalled();
                expect(network.httpRequests.filter(request => new URL(request.url).pathname === '/v1/sessions/message-session/messages')).toHaveLength(1);
                expect(daemonRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toHaveLength(0);
                return;
            }
            expect(handlerEntered).toBe(false);
            expect(alert).not.toHaveBeenCalled();
        } finally { await activation.composition.unload(); alert.mockRestore(); }
    });

    it('reads an unmounted client Action target projection from its registered authority', async () => {
        const accountLifetime = clientAccountLifetime();
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
            accountLifetime,
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
            })).resolves.toEqual({ ok: true, result: { targetedContributions, accountScope: accountLifetime.scope, supportsSelection: true } });
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
        const accountLifetime = clientAccountLifetime();
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
                return { protocolVersion: 1, projectionDigest: 'operation-input-digest', projection: { v: 2, generation: 1, familiesById: {},
                    installedPackagesById: { [selectedAction.pluginId]: {
                        id: selectedAction.pluginId, displayName: 'Reviewer', version: '1.0.0', enabled: true,
                        source: { kind: 'localPath', locator: 'reviewer' },
                    } }, actionsById: { [`${selectedAction.pluginId}/${selectedAction.id}`]: selectedAction },
                } };
            }
            return answerActionSchemasRead(request);
        });
        expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
            serverId: 'server-client-action', accountLifetime, reuseFreshReady: false })).toMatchObject({ kind: 'ready' });
        const transported: unknown[] = [];
        const activation = createClientActionActivation({
            accountLifetime,
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
            const describes = daemonRpc.mock.calls.map(([request]) => request).filter(request =>
                request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            expect(describes).toHaveLength(2);
            expect(describes[1].payload).toMatchObject({ knownProjectionDigest: 'operation-input-digest' });
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

    // Account Search's real manifest → activation → default palette dispatch is covered by
    // triageAccountDispatch.composed.test.tsx (personal search), including zero-Machine execution.
    // SEARCH-TRIAGE's approved Account migration superseded the client shared-window contract.

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
            expect(await invocation).toEqual({ ok: true, result: null });
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
        const targetIdentity = {
            accountLifetime,
            pluginId: targetPluginId,
            occurrenceId: target.activation.occurrenceId,
            artifactDigest: target.activation.identity.artifactDigest,
            executionOrigin: clientActionExecutionOrigin(targetPluginId),
            isCurrent: () => true,
        };
        const targetScope = getPluginUiEphemeralSharedScope(targetIdentity);
        const mountedLease = targetScope!.acquire('shared-window', () => ({ value: 'target-mounted-window', dispose() {} }))!;
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
        let finishHandler!: (result: { committed: true }) => void;
        const handler = vi.fn(() => {
            handlerEntered();
            return new Promise<{ committed: true }>(resolve => { finishHandler = resolve; });
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

            if (readOnly) {
                await expect(pending).resolves.toEqual({
                    ok: false,
                    code: 'timeout',
                    reason: 'plugin_ui_action_outcome_unknown',
                    layer: 'transport',
                    phase: 'settlement',
                    retryable: true,
                });
                finishHandler({ committed: true });
            } else {
                finishHandler({ committed: true });
                await expect(pending).resolves.toEqual({ ok: true, result: { committed: true } });
            }
            expect(handler).toHaveBeenCalledOnce();
        } finally {
            await activation.composition.unload();
            accountLifetime?.retire();
        }
    });

    it.each(['unreviewed', 'unbranded', 'mismatched-input', 'foreign-action', 'admitted-agent',
        'admitted-unavailable', 'admitted-denied', 'admitted-surface'] as const)(
        'consumes only exact admitted child review for a non-safe Account Action, proof=%s', async proof => {
        const handler = vi.fn(async () => ({ committed: true }));
        const clientHandler: PluginClientActionHandler = async () => handler();
        const accountLifetime = clientAccountLifetime();
        const activation = createClientActionActivation({
            dangerLevel: 'writesRemote',
            handler: clientHandler,
            accountPlacement: true,
            accountLifetime,
            ...(proof === 'admitted-unavailable' ? { accountAvailability: {
                when: { fact: 'session.exists' as const, operator: 'equals' as const, value: true },
            } } : {}),
            ...(proof === 'admitted-denied' ? { authorization: { scopedGrants: [{
                id: 'selected-account', required: true, status: 'missing' as const, requiredScope: {},
            }] } } : {}),
            ...(proof === 'admitted-surface' ? { surfaces: ['voice' as const] } : {}),
        });
        const action = activation.action;
        const requestCurrentIntent = vi.fn(async () => ({
            status: 'rejected' as const,
            code: 'plugin_action_current_intent_rejected',
        }));
        await activation.composition.unload();
        try {
            await activation.composition.reconcile([activation.activation]);
            const dispatch = (context?: ActionExecutorContext) => dispatchPluginSurfaceAction({
                callerPluginId: CALLER_PLUGIN_ID,
                action: 'refresh-index',
                input: null,
                resolveContributedAction: resolveExactClientAction(action),
                clientAction: {},
                requestCurrentIntent,
                ...(context ? { hostAction: { context, execute: createActionExecutor({}).execute } } : {}),
            });
            const assertOutcome = async (context?: ActionExecutorContext) => {
                if (proof === 'admitted-unavailable' || proof === 'admitted-denied' || proof === 'admitted-surface') {
                    await expect(dispatch(context)).resolves.toMatchObject({ ok: false });
                    expect(requestCurrentIntent).not.toHaveBeenCalled();
                    expect(handler).not.toHaveBeenCalled();
                    return;
                }
                if (proof === 'admitted-agent') {
                    await expect(dispatch(context)).resolves.toEqual({ ok: true, result: { committed: true } });
                    expect(requestCurrentIntent).not.toHaveBeenCalled();
                    expect(handler).toHaveBeenCalledOnce();
                    return;
                }
                await expect(dispatch(context)).resolves.toEqual({
                    // A decline is a decision, not an absence. It must NOT settle as
                    // `unavailable`: an autonomous caller reads that as a transient
                    // gap and asks the same person again.
                    ok: false,
                    code: 'denied',
                    reason: 'plugin_action_current_intent_rejected',
                });
                expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
                expect(handler).not.toHaveBeenCalled();
            };
            if (proof === 'unreviewed') await assertOutcome();
            else {
                const action = { pluginId: CALLER_PLUGIN_ID, localId: proof === 'foreign-action' ? 'other-action' : 'refresh-index' };
                const operand = proof === 'mismatched-input' ? { reviewed: true } : null;
                const context: ActionExecutorContext = proof === 'admitted-agent'
                    ? { surface: 'agent', authority: 'account_automation', interactivePresentation: 'unavailable' }
                    : { surface: 'ui', authority: 'present_user' };
                const port = createHostReviewedChildPortV1({ actionId: 'machines.managed.power.set', input: { managedId: 'retained' },
                    context, plan: { children: [{ action, role: 'power' }] },
                    ...(proof === 'unbranded' ? {} : { reviewAdmitted: true as const,
                        policies: [{ action, role: 'power', surface: context.surface! }] }),
                    execute: async (_input, childContext) => { await assertOutcome(childContext); return { ok: true }; },
                });
                await port.invoke({ action, role: 'power', input: operand });
            }
        } finally {
            await activation.composition.unload();
            accountLifetime.retire();
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
            targetSourceCustody: TARGET_SOURCE_CUSTODY,
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
            readActionsSettings: () => settings,
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

    it('preserves the explicit read-only constraint in the strict daemon payload', async () => {
        const wire = await readContributedActionWire('machine-wire', {
            serverId: 'server-wire', expectedContributorOccurrenceId: 'occurrence-acme.reviewer',
            qualifiedActionId: 'acme.reviewer/refresh-index', input: { reason: 'read' }, executionSurface: 'ui',
            requiredReadOnly: true,
            invocation: { kind: 'mountedPluginSurface', mountedBinding: mountedCallerBinding({ machineId: 'machine-wire' }) },
        });
        expect(wire.requiredReadOnly).toBe(true);
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

    it('makes an unknown daemon read-observation settlement manually retryable', async () => {
        daemonRpc.mockImplementation(async (request: { method: string }) => {
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) {
                return { ok: false, code: 'plugin_action_outcome_unknown', reason: 'unavailable' };
            }
            throw new Error(`Unexpected daemon method: ${request.method}`);
        });
        const accept = vi.fn();
        const outcome = await dispatchPluginSurfaceAction({
            callerPluginId: CALLER_PLUGIN_ID, action: 'refresh-index', input: {},
            contributedAction: { machineId: 'machine-1' },
            resolveContributedAction: identity => ({ ...resolveDaemonTargetAction(identity), sessionTarget: undefined, readOnly: true }),
            invocation: { kind: 'clientPluginAction', clientActionBinding: {
                pluginId: CALLER_PLUGIN_ID, contributionLocalId: 'outer-read', occurrenceId: 'outer-occurrence',
            } },
            requiredReadOnly: true, readObservation: { invalidate() {}, accept },
        });
        expect(outcome).toMatchObject({ ok: false, code: 'timeout', retryable: true });
        expect(accept).not.toHaveBeenCalled();
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
    it('keeps release publication behind one real host decision for people and default automated callers', async () => {
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
        const { ForgeReleaseDraftPublishInputV1Schema } = await import('@happier-dev/triage-protocol/releases/v1');
        const { createForgeReleaseV1Fixture } = await import('@happier-dev/triage-protocol/releases/testing/v1');
        const declaration = PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === 'github/releases/draft-publish');
        if (!declaration?.inputSchema) throw new Error('Release publication declaration missing');
        const identity = { pluginId: PLUGIN_MANIFEST.id, localId: declaration.id };
        clientActionSchemasByQualifiedId.set(`${identity.pluginId}/${identity.localId}`, { inputSchema: declaration.inputSchema });
        const reviewed = createForgeReleaseV1Fixture({ assets: {
            rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null,
        } });
        const operand = PluginUiJsonValueV1Schema.parse(ForgeReleaseDraftPublishInputV1Schema.parse({
            repository: reviewed.repository, repositoryId: reviewed.repositoryId, releaseId: reviewed.releaseId,
            reviewed, makeLatest: 'legacy',
        }));
        // Substitute only the daemon transport. Policy, schema admission and the
        // app-shell transient Interaction/dialog lifecycle remain the real owners.
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true, result: { ok: true, result: { kind: 'confirmed', release: PluginJsonValueV2Schema.parse({ ...reviewed, draft: false }) } },
        }));
        let dialogs = 0;
        try {
            for (const [surface, authority, accept] of [
                ['ui', 'present_user', false], ['ui', 'present_user', true], ['agent', 'account_automation', false],
            ] as const) {
                const before = contributed.mock.calls.length;
                nestedActionConfirmation.onShow = (confirm, cancel) => {
                    dialogs += 1;
                    expect(contributed).toHaveBeenCalledTimes(before);
                    if (accept) confirm();
                    else cancel();
                };
                const result = await dispatchPluginSurfaceAction({
                    action: identity, input: operand, invocationSurface: surface,
                    hostAction: { execute: vi.fn(), context: { authority } },
                    resolveContributedAction: id => PluginProjectedActionV2Schema.parse({
                        ...resolveConfirmedDaemonTargetAction(id), dangerLevel: declaration.dangerLevel,
                        irreversible: declaration.irreversible, surfaces: declaration.surfaces,
                        confirmation: declaration.confirmation,
                    }),
                    contributedAction: { machineId: 'machine-1', execute: contributed },
                });
                expect(result).toMatchObject(accept ? { ok: true, result: { kind: 'confirmed' } }
                    : { ok: false, reason: 'plugin_action_current_intent_rejected' });
                expect(contributed).toHaveBeenCalledTimes(before + (accept ? 1 : 0));
            }
            expect(dialogs).toBe(3);
            expect(contributed).toHaveBeenCalledOnce();
            expect(contributed.mock.calls[0]?.[1]).toMatchObject({ input: operand, presentUserIntent: 'confirmed' });
        } finally { nestedActionConfirmation.onShow = null; }
    });

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

    it.each(['untyped', 'typed'] as const)('retains the cause and request of a failing current-intent presenter before Machine dispatch (%s)', async kind => {
        clientActionSchemasByQualifiedId.set(`${CALLER_PLUGIN_ID}/set-complete`, { inputSchema: { type: 'object' } });
        let effects = 0;
        const result = await dispatchPluginSurfaceAction({
            actionRequestId: '813be538-5ae3-43a5-bf45-5f24df072540',
            action: { pluginId: CALLER_PLUGIN_ID, localId: 'set-complete' }, input: {},
            hostAction: { execute: async () => ({ ok: true, result: null }), context: { authority: 'present_user' } },
            resolveContributedAction: resolveConfirmedDaemonTargetAction,
            requestCurrentIntent: async () => {
                if (kind === 'typed') throw new PluginError({ code: 'action_interactive_review_required',
                    failureCause: { phase: 'action.current_intent', errorClass: 'TypeError', errorCode: null, httpStatus: null } });
                throw new TypeError('private presenter content');
            },
            contributedAction: { machineId: 'machine-1', execute: async () => {
                effects++; return { supported: true, result: { ok: true, result: null } };
            } },
        });
        expect(result).toMatchObject({ ok: false, reason: kind === 'typed' ? 'action_interactive_review_required' : 'plugin_action_execution_failed',
            requestId: '813be538-5ae3-43a5-bf45-5f24df072540', effectAttempted: false,
            failureCause: { phase: 'action.current_intent', errorClass: 'TypeError', errorCode: null, httpStatus: null } });
        expect(JSON.stringify(result)).not.toContain('private presenter content');
        expect(effects).toBe(0);
    });

    it.each([
        { caller: 'mounted raw plugin', mounted: true, authority: undefined },
        { caller: 'mounted plugin borrowing host context', mounted: true, authority: 'present_user' as const },
        { caller: 'host-mediated control', mounted: false, authority: 'present_user' as const },
    ])('keeps $caller at its own invocation authority', async ({ mounted, authority }) => {
        clientActionSchemasByQualifiedId.set(`${CALLER_PLUGIN_ID}/set-complete`, { inputSchema: { type: 'object' } });
        const requestCurrentIntent = vi.fn(async () => ({
            status: 'unavailable' as const, code: 'plugin_action_current_intent_unavailable',
        }));
        // Only Machine RPC is substituted; caller resolution and approval policy stay real.
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true, result: { ok: true, result: { completed: true } },
        }));
        const result = await dispatchPluginSurfaceAction({
            ...(mounted ? { callerPluginId: CALLER_PLUGIN_ID, callerContributionLocalId: 'inspector-app',
                callerBinding: mountedCallerBinding() } : {}),
            action: { pluginId: CALLER_PLUGIN_ID, localId: 'set-complete' }, input: {},
            hostAction: { execute: vi.fn(), context: { ...(authority ? { authority } : {}) } },
            resolveContributedAction: identity => PluginProjectedActionV2Schema.parse({
                ...resolveConfirmedDaemonTargetAction(identity), dangerLevel: 'writesLocal',
                confirmationWhen: { presentUserUi: false },
            }),
            requestCurrentIntent, contributedAction: { machineId: 'machine-1', serverId: rpcHomes.get('server-client-action')!.id, execute: contributed },
        });
        expect(result).toMatchObject(mounted
            ? { ok: false, reason: 'plugin_action_current_intent_unavailable' }
            : { ok: true, result: { completed: true } });
        expect(requestCurrentIntent).toHaveBeenCalledTimes(mounted ? 1 : 0);
        if (mounted) expect(contributed).not.toHaveBeenCalled();
        else expect(contributed.mock.calls[0]?.[1].presentUserIntent).toBeUndefined();
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

    it('admits a narrowing caller-owned write (admissionOnly) by the declared input default, prompting only a consequential one', async () => {
        // OG-H5: Channels paused/narrowing saves admit through the surface's ordinary per-Action default on the prepared input.
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
        const admit = (input: PluginUiJsonValueV1) => dispatchPluginSurfaceAction({
            admissionOnly: true,
            action: { pluginId: 'acme.bindings', localId: 'manage' }, input,
            resolveContributedAction: identity => PluginProjectedActionV2Schema.parse({
                ...resolveConfirmedDaemonTargetAction(identity),
                confirmationWhen: { op: 'not', predicate: { op: 'eq', path: 'kind', value: 'list' } },
            }),
            requestCurrentIntent, contributedAction: { machineId: 'machine-1', execute: contributed },
        });
        expect(await admit({ kind: 'list' })).toMatchObject({ ok: true, result: { admitted: true } });
        expect(requestCurrentIntent).not.toHaveBeenCalled();
        // Owner-positive: a consequential write still follows its declared default.
        expect(await admit({ kind: 'attach' })).toMatchObject({ ok: true, result: { admitted: true } });
        expect(requestCurrentIntent).toHaveBeenCalledOnce();
        expect(contributed).not.toHaveBeenCalled();
    });

    it('validates reviewed daemon operands before presenting the exact input and dispatching', async () => {
        clientActionSchemasByQualifiedId.set('acme.releases/publish', { inputSchema: {
            type: 'object', properties: { skippedRequirements: { type: 'array', items: {
                type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false,
            } } }, required: ['skippedRequirements'], additionalProperties: false,
        } });
        const presented: unknown[] = [];
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true, result: { ok: true, result: { published: true } },
        }));
        const dispatch = (input: PluginUiJsonValueV1) => dispatchPluginSurfaceAction({
            action: { pluginId: 'acme.releases', localId: 'publish' }, input,
            resolveContributedAction: identity => PluginProjectedActionV2Schema.parse({
                ...resolveConfirmedDaemonTargetAction(identity),
                confirmation: { title: 'Publish?', inputFields: [{ path: 'skippedRequirements.[].label', title: 'Skipping' }] },
            }),
            requestCurrentIntent: async request => {
                presented.push(request.input);
                return { status: 'approved', fingerprint: request.fingerprint };
            },
            contributedAction: { machineId: 'machine-1', execute: contributed },
        });
        expect(await dispatch({ skippedRequirements: [{ label: 42 }] })).toMatchObject({ ok: false, reason: 'plugin_action_input_schema_invalid' });
        expect(presented).toEqual([]);
        expect(contributed).not.toHaveBeenCalled();
        const input = { skippedRequirements: [{ label: 'CI / Linux' }, { label: 'Required review' }] };
        expect(await dispatch(input)).toEqual({ ok: true, result: { published: true } });
        expect(presented).toEqual([input]);
        expect(contributed).toHaveBeenCalledOnce();
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
    it.each(['unchanged', 'policy', 'operands'] as const)('confirms locally before the daemon RPC and retains the admitted policy (changed: %s)', async change => {
        const storage = getStorage();
        const previous = storage.getState();
        const order: string[] = [];
        const requestCurrentIntent = vi.fn(async ({ fingerprint, input }: Readonly<{ fingerprint: string; input: unknown }>) => {
            order.push('confirm');
            // Coordination 2026-11-10 10:44: settings affect the next admission.
            if (change === 'policy') storage.setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                    actions: { 'acme.releases/actions/publish': { enabled: false } },
                }),
            } }));
            if (change === 'operands' && input && typeof input === 'object' && 'tag' in input) input.tag = 'v2';
            return { status: 'approved' as const, fingerprint };
        });
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => {
            order.push('transport');
            return { supported: true as const, result: { ok: true as const, result: { published: true } } };
        });

        try {
            const result = await dispatchPluginSurfaceAction({
                action: { pluginId: 'acme.releases', localId: 'publish' },
                input: { tag: 'v1' },
                resolveContributedAction: resolveConfirmedDaemonTargetAction,
                requestCurrentIntent,
                contributedAction: { machineId: 'machine-1', execute: contributed },
            });
            if (change === 'operands') {
                expect(result).toMatchObject({ ok: false, reason: 'plugin_action_current_intent_mismatch' });
                expect(contributed).not.toHaveBeenCalled();
                return;
            }
            expect(result).toEqual({ ok: true, result: { published: true } });

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
        } finally { storage.setState(previous); }
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
            requestId: 'request-cancelled',
            effectAttempted: false,
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

    it.each([
        TARGET_SOURCE_CUSTODY,
        { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-current' } },
    ] satisfies PluginSourceCustodyV1[])('rehydrates the host-selected Account ref for a $kind caller while retaining Machine target custody', async (callerSourceCustody) => {
        const contributed = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { applied: true } },
        }));
        const api = createPluginSurfaceActionHostApi({
            surfaceContext: surfaceContext(),
            callerSourceCustody,
            targetSourceCustody: TARGET_SOURCE_CUSTODY,
            callerBinding: { pluginId: CALLER_PLUGIN_ID, contributionLocalId: 'inspector-app',
                occurrenceId: `${CALLER_PLUGIN_ID}:current`, sourceCustody: callerSourceCustody },
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
        // Neither an unrelated Machine generation nor the Account caller's
        // own custody may stand in for the admitted target-operation source.
        for (const sourceCustody of [
            { kind: 'development', registeredRootId: 'other-machine-root' },
            ...(callerSourceCustody.kind === 'bundled_first_party' ? [callerSourceCustody] : []),
        ] satisfies PluginSourceCustodyV1[]) {
            await expect(api.handleRequest(
                executeActionRequest({ action: { pluginId: CALLER_PLUGIN_ID, localId: 'connection/create' }, input: {} }),
                { targetedOperation, selectedActionInput: { ...selectedActionInput,
                    selection: { ...selectedActionInput.selection, target: { pluginId: CALLER_PLUGIN_ID, sourceCustody } } } },
            )).resolves.toEqual({ code: 'invalid_payload', diagnostics: ['plugin_surface_targeted_selection_invalid'] });
        }
        expect(contributed).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            invocation: { kind: 'mountedPluginSurface', mountedBinding: expect.objectContaining({ sourceCustody: callerSourceCustody }) },
        }));
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
            targetSourceCustody: TARGET_SOURCE_CUSTODY,
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
            requestId: expect.any(String),
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
            requestId: expect.any(String),
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
            requestId: expect.any(String),
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

    it('correlates a declaration-free daemon refusal with the Request ID exposed by the native API', async () => {
        let daemonRequest: ReturnType<typeof DaemonPluginStructuredMessageActionExecuteRequestSchema.parse> | undefined;
        // The physical daemon RPC is the boundary; the public adapter, dispatcher and serializer stay real.
        daemonRpc.mockImplementationOnce(async (request: { payload: unknown }) => {
            daemonRequest = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
            return { ok: false, code: 'plugin_action_current_intent_mismatch' };
        });
        const adapter = createReactNativeSurface({
            executeHostAction: async () => ({ ok: true, result: null }),
            contributedActionExecute: machinePluginStructuredMessageActionExecute,
        });
        try {
            const refusal: unknown = await adapter.api.executeAction('refresh-index', { reason: 'correlation' })
                .catch(error => error);
            expect(refusal).toMatchObject({ details: { requestId: adapter.requests[0]?.requestId },
                diagnostics: [{ code: 'plugin_action_current_intent_mismatch' }] });
            expect(daemonRequest).toMatchObject({ requestId: adapter.requests[0]?.requestId });
        } finally { adapter.dispose(); }
    });

    it('exposes the issued native read identity without changing the domain failure or daemon identity', async () => {
        const failure = { kind: 'unavailable', failure: { class: 'rateLimited', code: 'provider-rate-limited' } };
        let daemonRequestId: string | undefined;
        const adapter = createReactNativeSurface({
            executeHostAction: async () => ({ ok: true, result: null }),
            contributedActionExecute: async (_machineId, request) => {
                daemonRequestId = request.requestId;
                return { supported: true, result: { ok: true, result: failure } };
            },
        });
        const onIssued = vi.fn();
        try {
            await expect(adapter.api.executeAction('refresh-index', {}, { onIssued })).resolves.toEqual(failure);
            expect(onIssued).toHaveBeenCalledWith(adapter.requests[0]?.requestId);
            expect(daemonRequestId).toBe(adapter.requests[0]?.requestId);
        } finally { adapter.dispose(); }
    });

    it('does not issue a diagnostic identity for a locally refused native read', async () => {
        const adapter = createReactNativeSurface({
            executeHostAction: async () => ({ ok: true, result: null }),
            contributedActionExecute: async () => ({ supported: true, result: { ok: true, result: null } }),
        });
        const onIssued = vi.fn();
        const controller = new AbortController();
        controller.abort();
        try {
            await expect(adapter.api.executeAction('refresh-index', {}, { signal: controller.signal, onIssued }))
                .rejects.toMatchObject({ code: 'unavailable', diagnostics: [{ code: 'aborted', severity: 'error' }] });
            expect(onIssued).not.toHaveBeenCalled();
            expect(adapter.requests).toEqual([]);
        } finally { adapter.dispose(); }
    });

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
            requestId: adapter.requests[2]?.requestId,
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
async function physicalHostApiCarrier(transport: 'hosted-web' | 'react-native',
    host: ReturnType<typeof createPluginSurfaceActionHostApi>, isCurrent: () => boolean, mode: 'plain' | 'e2ee',
    requestSurface: PluginUiSurfaceContextV1 = { ...COMPOSED_SURFACE, pluginId: externalAuthoringPlugin.manifest.id,
        contributionId: 'external-authoring-semantic' }) {
    const pluginId = requestSurface.pluginId;
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
            readActionsSettings: () => actionsSettings,
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
        const carrier = await physicalHostApiCarrier(transport, host, () => current, mode);
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
            expect(network.messages).toHaveLength(3);
            expect(homes.artifacts(serverId).read(created.artifactId)?.bodyVersion).toBe(created.revision.bodyVersion + 1);
        } finally { await carrier.dispose(); host.dispose?.(); account.dispose(); await homes.reset(); }
    });
});

it('preserves GitHub Settings caller and admitted source for Account Triage create without source id', async () => {
    const { createTriageAdministerSourceInstanceActionHandler } = await import('../../../../../../packages/plugins/triage/src/actions/administerSourceInstanceAction');
    const { createTestkitCorpusCollections } = await import('../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support');
    const { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_ID } = await import('../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts');
    const { encodeGithubTriageConfiguration } = await import('../../../../../../packages/plugins/scm-github/src/triage/configuration');
    const { collections } = createTestkitCorpusCollections();
    const administer = createTriageAdministerSourceInstanceActionHandler({ mintSourceInstanceId: () => '11111111-1111-4111-8111-111111111111', nowMs: () => 1 });
    const [{ PLUGIN_MANIFEST: triage }, { PLUGIN_MANIFEST: github }] = await Promise.all([
        import('../../../../../../packages/plugins/triage/src/manifest'),
        import('../../../../../../packages/plugins/scm-github/src/manifest'),
    ]);
    const accountLifetime = clientAccountLifetime(rpcHomes.get('server-client-action')!.id);
    const manifests = [triage, github].map(manifest => {
        const parsed = ingestPluginManifestV2(manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed));
        return parsed.manifest;
    });
    replacePluginAccountAvailabilityProjection({ scope: accountLifetime.scope, snapshot: {
        availabilityCursor: 1, materializations: [], snapshots: [], intentReads: manifests.map(manifest => ({ pluginId: manifest.id, response: {
            availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
            intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true,
                offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
            release: { ref: { pluginId: manifest.id, version: manifest.version },
                archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest,
                collectionContracts: [], uiSlots: [],
                packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
        } })),
    } });
    const availability = readPluginAccountAvailability(accountLifetime.scope);
    const target = availability.readCurrentAccountExecution(triage.id);
    const source = availability.readCurrentAccountExecution(github.id);
    if (target.kind !== 'available' || source.kind !== 'available') throw new Error('Expected admitted Account releases');
    let receivedCaller: unknown;
    let receivedRequestId: string | undefined;
    const normalizedTarget = manifests[0]!;
    const declaration = normalizedTarget.contributes.actions.find(action => action.id === 'sources/administer-v1')!;
    if (declaration.execution.target !== 'account') throw new Error('Expected Account administration');
    const activation = createClientActionActivation({ pluginId: triage.id, localId: 'sources/administer-v1',
        accountPlacement: true, accountLifetime, // Load only this real declaration in the diagnostic executable; admission above uses both complete manifests.
        accountManifest: { ...normalizedTarget, contributes: { ...normalizedTarget.contributes, actions: [declaration], resources: [] } }, occurrenceId: target.custodyId,
        inputSchema: declaration.inputSchema,
        artifactGraph: PluginUiArtifactsManifestEntryV2Schema.parse({ ...CLIENT_ACTION_ARTIFACT_GRAPH,
            artifactId: declaration.execution.account.artifactId, executable: { exports: [declaration.execution.account.exportName] },
            entry: `react-native/${declaration.execution.account.artifactId}/entry.cjs.bundle`,
            files: CLIENT_ACTION_ARTIFACT_GRAPH.files.map(file => ({ ...file, relativePath: `react-native/${declaration.execution.account.artifactId}/entry.cjs.bundle` })) }),
        accountHandler: async (value, context) => {
            receivedCaller = context.caller;
            receivedRequestId = context.requestId;
            const { TriageSourceAdministrationActionInputV1Schema } = await import('@happier-dev/triage-protocol/v1');
            return administer(TriageSourceAdministrationActionInputV1Schema.parse(value), { ...context, services: {
                ...context.services, storage: { account: { collection: definition => {
                    if (definition.id === 'source-instances') return collections.sourceInstances;
                    if (definition.id === 'session-links') return collections.sessionLinks;
                    if (definition.id === 'user-marks') return collections.userMarks;
                    throw new Error(`Unexpected collection: ${definition.id}`);
                } } },
            } });
        } });
    await activation.composition.unload();
    nestedActionConfirmation.onShow = approve => approve();
    try {
        expect((await activation.composition.reconcile([activation.activation])).map(attempt => attempt.result)).toEqual([{ ok: true }]);
        const controller = createBoundPluginSurfaceController({ facts: {
            ...surfaceContext(github.id), contributionId: 'triage-sources',
            serverId: accountLifetime.scope.serverId, occurrenceId: source.custodyId,
            accountExecutionOrigin: { ...accountLifetime.scope, custodyId: source.custodyId, sourceCustody: source.sourceCustody },
            accountLifetime, interactionEnabled: true, daemonInteractionEnabled: false,
            pluginUiProjection: activation.projection,
            resolveContributedAction: createPluginUiProjectedActionResolver(activation.projection.actionsById),
        } });
        onTestFinished(() => controller.dispose());
        const outcome = await controller.hostApi.handleRequest({ version: 1, method: 'executeAction',
            requestId: 'source-caller-create', surface: controller.surfaceContext,
            payload: { action: { pluginId: triage.id, localId: activation.action.id },
            input: { v: 1, kind: 'create', draft: { v: 1,
                binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service: { pluginId: github.id, localId: GITHUB_CONNECTED_ACCOUNT_ID } },
                localInstanceKey: 'github.com', keyStability: 'locatorDerived',
                configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1,
                    selection: { kind: 'selected', unitIds: ['leeroybrun/test-happier-scm'] } }) },
                locator: { v: 1, displayLabel: 'Use this machine’s GitHub CLI login' } } },
            },
        });
        expect(outcome).toEqual({ kind: 'active', sourceInstanceId: '11111111-1111-4111-8111-111111111111' });
        expect(receivedCaller).toMatchObject({ kind: 'plugin', pluginId: github.id, contribution: { id: 'triage-sources' } });
        expect(receivedRequestId).toBe('source-caller-create');
    } finally {
        nestedActionConfirmation.onShow = null;
        await activation.composition.unload(); accountLifetime.retire(); clearPluginAccountAvailabilityProjection();
    }
});
