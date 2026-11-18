import axios from 'axios';
import { mkdtemp, mkdir, rm, writeFile, readFile, access, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { createAccountServerWorkspaceWorkerPreferenceClient } from '@/api/workspaces/workspaceWorkerPreferences';
import { logger } from '@/ui/logger';
import type { WorkerDestinationV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { MachinePoolPrivateViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import * as machineRpcTransport from '@/session/transport/rpc/machineRpc';
import { createProjectWorkerAction } from '@/workspaces/execution/projectWorkerAction';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1, ProjectSetupConsentFailureDetailsV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { createProjectDefinitionAction } from '@/rpc/handlers/projectDefinitions';
import { ProjectTrustMutationRequestV1Schema, type ProjectTrustContentV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { createProjectSetupTrustClient } from './projectSetupTrust';
import { readProjectManifest } from './projectManifestFile';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerProjectFiniteRpcHandlers } from '@/rpc/handlers/projects/registerProjectFiniteRpcHandlers';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createNativeSessionDeleteAction } from '@/daemon/sessions/sessionDeleteAction';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import type { HostEventEnvelopeV1 } from '@happier-dev/protocol/plugins/events/hostV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncAdmissionV1Schema, deriveWorkspaceSyncRelationshipId } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { ProjectWorkerStatusInputV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1, type WorkspaceRefV1,
    type WorkspaceSyncStatusV1 } from '@happier-dev/protocol';
import { createWorkspaceSyncWorkerPreparation, resolveWorkspaceSyncWorkerTarget, prepareWorkspaceSyncBetween } from '@/workspaces/sync/workspaceSyncPreparation';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission, type ProjectWorkerMemoryObservation } from '@/workspaces/execution/projectWorkerAdmission';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess, PtySpawnParams } from '@/terminal/pty/provider';
import { createProjectFiniteAction, type ProjectFiniteActionRuntime } from './projectFiniteAction';
import { createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import * as processTreeBoundary from '@/processes/terminate/terminateProcessTree';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import * as installationStore from '@/daemon/identity/store';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { projectExternalActionRequesterHttpAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import nacl from 'tweetnacl';
import type { ApiMachineClient } from '@/api/apiMachine';
import { ApiClient } from '@/api/api';
import { reviewProjectSetupEffect } from './projectSetupPreparation';
import { createProjectSetupSuccessStore } from './projectSetupSuccess';
import { updateSettings, readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { prepareProjectCheckoutRemoval } from './projectCheckoutRemoval';
import { createAdmittedCheckoutRepositoryFiles } from '@/deployments/admittedCheckoutRepositoryFiles';
import { createDeploymentGitRegistry } from '@/deployments/targets/ownServer/exactCommitRelease.testkit';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol/scm/worktrees';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { createProjectAccountRowsHttpBoundary, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { mutateProjectAccountOrganization } from '@/workspaces/projectAccountRows';
import { updateProjectOrganizationV1 } from '@happier-dev/protocol/projects/projectOrganizationV1';
import { ProjectAccountRowListResponseV1Schema, ProjectAccountRowReadResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { inspectProjectSetupFromRuntime } from './projectSetupReadiness';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { assertActionOutputContract } from '@/testkit/actionOutputContract';
import { executeWaitActionV1 } from '../../../../../packages/protocol/src/actions/executor/waitAction';
import { executeActionOperationActionV1 } from '../../../../../packages/protocol/src/actions/executor/actionOperationActions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { TerminalStreamReadResponseSchema, decodeTerminalStreamBytesFrame } from '@happier-dev/protocol/terminal/stream';
import { ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { authorizeMachineRpcRequest, readMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';

import { createWorkspaceSyncTargetAuthority } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { workspaceSyncMaterializationReceiptPath } from '@/workspaces/sync/workspaceSyncTargetBootstrap';
import { beginWorkspaceTargetMaterialization } from '@/scm/workspace/workspaceExportMaterialization';
import { computeWorkspaceSyncRootFingerprint, readWorkspaceSyncRootObjectIdentity } from '@/workspaces/sync/workspaceSyncRootIdentity';
import { createWorkspaceSyncSourceOperationContinuation, openWorkspaceSyncTargetOperationContinuation } from '@/api/rpc/workspaceSyncOperationContinuation';
import type { SocketRpcContinuationCall, SocketRpcContinuationHandler } from '@happier-dev/sync-client';

/** Direct owner tests supply the same captured identity as installed runtime composition. */
// Native controller responses are the network boundary; preparation and selection remain real.
function observedSyncStatuses(relationships: readonly WorkspaceSyncRelationshipV1[]): WorkspaceSyncStatusV1[] {
    return relationships.map(relationship => ({ relationshipId: relationship.relationshipId,
        controllerMachineId: relationship.controllerMachineId, mode: relationship.mode, state: 'watching',
        alphaPath: '/source', betaPath: '/worker', conflictCount: 0, lastCycleObservedAtMs: null,
        endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
            beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } } }));
}

function createFiniteActionWithCapturedRequester(runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext,
    removalOperation?: Parameters<typeof createProjectFiniteAction>[2]): ReturnType<typeof createProjectFiniteAction> {
    return async args => {
        const home = runtime.resolveHostHomeServerIdentityId
            ? await runtime.resolveHostHomeServerIdentityId(ingress.signal) : await resolveServerProfileHomeIdentityId(runtime.serverId);
        return createProjectFiniteAction({ ...runtime, requesterIdentity: runtime.requesterIdentity
            ?? selectHostRequesterExecutionIdentity({ rpcContext: ingress, hostHomeServerIdentityId: home }) }, ingress, removalOperation)(args);
    };
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
// The Home HTTP boundary publishes this fixture Account identity; it is not caller-supplied Action authority.
const ownerToken = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJvd25lciJ9.signature';
const portableNativeManifest = { version: 1, scripts: { checked: { execution: 'portable',
    source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } } as const;
class BoundaryPty implements PtyProcess {
    readonly pid = 3456;
    readonly ownedProcessGroupId = 3456;
    private readonly exits = new Set<(event: PtyExitEvent) => void>();
    private readonly data = new Set<(data: string | Buffer) => void>();
    write() {}
    resize() {}
    kill() {}
    onData(listener: (data: string) => void) { const receive = (data: string | Buffer) => listener(String(data)); this.data.add(receive); return { dispose: () => this.data.delete(receive) }; }
    onDataBytes(listener: (data: string | Buffer) => void) { this.data.add(listener); return { dispose: () => this.data.delete(listener) }; }
    output(data: string | Buffer) { for (const listener of this.data) listener(data); }
    onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
    exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode }); }
}

describe('authenticated finite Project Action owner', () => {
    let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
    beforeEach(async () => { channel = await createRequesterCurrentnessSocketHarness(); });
    const roots: string[] = [];
    const managers: Array<ReturnType<typeof createTerminalPtySessionManager>> = [];
    const releaseRequesterContexts: Array<() => Promise<void>> = [];
    afterEach(async () => { managers.splice(0).forEach(manager => manager.dispose()); await channel.close(); await Promise.all(releaseRequesterContexts.splice(0).map(release => release())); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
    async function harness(manifest?: unknown, runAtMost: number | null = null, sourceMachineId = 'machine', credentialToken = 'requester', runtimeProfileId = 'home', homeId = 'home') {
        const root = await mkdtemp(join(tmpdir(), 'happier-project-finite-'));
        roots.push(root);
        if (manifest) { await mkdir(join(root, '.happier')); await writeFile(join(root, '.happier/project.json'), JSON.stringify(manifest)); }
        await writeFile(join(root, 'Makefile'), 'check:\n\techo checked\n');
        const workspace = { id: 'accepted', serverId: homeId, machineId: sourceMachineId, rootPath: root, createdAtMs: 1, projectKey: 'project' };
        const address = { serverId: homeId, machineId: sourceMachineId, rootPath: root, workspaceId: 'accepted' };
        const workspaceRefs: WorkspaceRefV1[] = [workspace];
        const relationships: WorkspaceSyncRelationshipV1[] = [];
        const organizationRows: unknown[] = [];
        const organizationHttp = createProjectAccountRowsHttpBoundary(organizationRows);
        let trustContent: ProjectTrustContentV1 | null = null;
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/project-rows/mutate')) return organizationHttp(String(url), body);
            if (String(url).endsWith('/project-trust/read')) return { status: 200, data: trustContent
                ? { status: 'present', revision: 1, content: trustContent } : { status: 'absent' } };
            if (String(url).endsWith('/project-trust/mutate')) {
                const mutation = ProjectTrustMutationRequestV1Schema.parse(body);
                trustContent = mutation.content;
                return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
            }
            return projectAccountRowsReadHttpResponse([...organizationRows, ...workspaceRefs.map(value => {
                const key = { kind: 'workspace-ref', serverId: homeId, id: value.id };
                return { key, revision: 1, content: { t: 'plain', v: { key, value } } };
            }), { key: { kind: 'relationship-graph' }, revision: 1,
                content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships } } } }], String(url), body);
        });
        const spawned: Array<{ params: PtySpawnParams; pty: BoundaryPty }> = [];
        let notifyFirstSpawn!: () => void;
        const firstSpawn = new Promise<void>(resolve => { notifyFirstSpawn = resolve; });
        const terminalSessions = createTerminalPtySessionManager({
            ptyProvider: { spawn(params) { const pty = new BoundaryPty(); spawned.push({ params, pty }); notifyFirstSpawn(); return pty; } },
            config: { bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000,
                urlParseBufferLimit: 32_768, maxWriteChunkBytes: 16_384, defaultCols: 80, defaultRows: 24 },
            // The fake OS process has no descendants after its exit event.
            env: {}, platform: 'linux', stopProcessTree: async () => {}, probeProcessGroup: () => 'absent',
        });
        managers.push(terminalSessions);
        let sequence = 0;
        const operationRuntime = createHostActionOperationRuntime({ machineId: 'machine', custodyBinding: { serverId: homeId, installationId: 'installation' },
            resolveAccountId: async () => 'owner',
            generateOperationId: () => ++sequence === 1 ? 'operation' : `operation-${sequence}` });
        let allowAdHoc = false;
        let workersEnabled = false;
        let unavailable: 'ask' | 'primary' | 'fail' = 'ask';
        let workerDestination: WorkerDestinationV1 = { kind: 'machine', machineId: 'machine' };
        const workspaceExecutionConfig = createWorkspaceExecutionConfigClientV1({ mode: 'plain', material: null, isCurrent: () => true,
            randomBytes: length => new Uint8Array(length), transport: {
                read: async () => ({ status: 'present', revision: 1, content: { t: 'plain', v: {
                    enabled: workersEnabled, unavailable, allowAdHoc, scriptOverrides: {}, services: {},
                    ...(workersEnabled ? { destination: workerDestination } : {}),
                } } }), mutate: async () => { throw new Error('read only'); },
            } });
        let accepting = true;
        let availableMemory: ProjectWorkerMemoryObservation | null = null;
        const workerAdmission = createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
            readMemory: () => availableMemory,
            readPolicy: async () => ({ status: 'ready', policy: { accepting, runAtMost }, source: 'stored', metadataVersion: 1 }) });
        const receivingInstallation = nacl.sign.keyPair();
        const context: RpcHandlerContext = { signal: new AbortController().signal, transportRequestId: 'transport',
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true };
        let nativeExecutablePath: string | undefined;
        let nativeExecutableRelativePath: string | undefined;
        const configEnvironment: Record<string, string> = { MODE: 'original' };
        let credentialCurrent = true;
        let continueCopy = () => {};
        let copyAllowed = Promise.resolve();
        const holdCopy = () => { copyAllowed = new Promise<void>(resolve => { continueCopy = resolve; }); };
        holdCopy();
        const runtime: ProjectFiniteActionRuntime = {
            accountId: 'owner', serverId: runtimeProfileId, machineId: 'machine', credentials: { token: credentialToken, encryption: null }, serverHttpBaseUrl: 'https://home.example',
            resolveHostHomeServerIdentityId: async () => homeId,
            isCurrent: async () => credentialCurrent,
            terminalSessions, operationRuntime, workerAdmission, resolveWorkspaceExecutionConfig: async () => workspaceExecutionConfig,
            nativeIo: { resolveTool: async (tool, request) => ({ executablePath: nativeExecutableRelativePath
                ? join(request.cwd, nativeExecutableRelativePath) : nativeExecutablePath ?? `/managed/${tool}`, version: '1' }) },
            environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }),
            platform: 'linux', arch: 'x64', hostEnvironment: {}, successHomeDir: join(root, 'success'),
            configEnvironment,
            // The system transport boundary invokes the real passive definition owner on the SOURCE host.
            inspectSourceProjectManifest: async ({ source, signal, command }) => {
                const inspect = createProjectDefinitionAction({ serverId: source.serverId, machineId: source.machineId,
                    workingDirectory: source.rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [source.rootPath] }, nativeIo: runtime.nativeIo });
                const result = await inspect({ actionId: 'projects.inspect', input: { workspace: { serverId: source.serverId,
                    machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath },
                    read: { kind: 'execution', ...(command ? { command } : {}) } }, context: { signal, serverId: source.serverId } });
                const inspection = ProjectDefinitionInspectOutputSchema.parse(result);
                return { ...inspection.definition, commands: inspection.commands, toolchainExecutionInputs: inspection.toolchainExecutionInputs };
            },
            resolveWorkerTarget: async ({ source }) => {
                const resolved = resolveWorkspaceSyncWorkerTarget({ serverId: homeId, sourceWorkspaceRefId: source.id, targetMachineId: 'machine', workspaceRefs, relationships,
                    relationshipStatuses: observedSyncStatuses(relationships) });
                if (!resolved.ok) throw Object.assign(new Error(resolved.errorCode), { code: resolved.errorCode });
                return resolved;
            },
            prepareDequeue: async ({ basis, signal }) => {
                if (!basis) return;
                const prepared = await prepareWorkspaceSyncBetween({ serverId: homeId, sourceWorkspaceRefId: basis.source.id,
                    targetWorkspaceRefId: basis.target.id, readCurrent: async () => ({ workspaceRefs, relationships }), signal,
                    // This boundary stands for the external Sync controller's actual file-copy and clean-status response.
                    flush: async relationshipId => {
                        await copyAllowed;
                        await cp(basis.source.rootPath, basis.target.rootPath, { recursive: true });
                        return { relationshipId, controllerMachineId: sourceMachineId, state: 'watching', alphaPath: basis.source.rootPath, betaPath: basis.target.rootPath,
                            mode: 'keep_synced', endpointStates: {
                                alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                                beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                            }, conflictCount: 0, lastCycleObservedAtMs: null };
                    },
                });
                if (!prepared.ok) throw Object.assign(new Error(prepared.errorCode), { code: prepared.errorCode });
            },
        };
        let setupApprovalWaived = false;
        const actionSettings = () => normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: {
            'projects.script.run': ['rpc', 'api', 'agent'], 'projects.compute.exec': ['rpc', 'api', 'agent'],
            ...(setupApprovalWaived ? { 'projects.prepare': ['rpc', 'api', 'agent'] } : {}),
        } });
        const invoke = (actionId: 'projects.prepare' | 'projects.script.run' | 'projects.compute.exec', input: unknown, ingress = context) =>
            createFiniteActionWithCapturedRequester(runtime, ingress)({ actionId, input, context: { authority: 'account_automation', surface: 'agent', actionsSettings: actionSettings(), actionRequestId: ingress.transportRequestId ?? 'request', serverId: homeId } });
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        const registrar: RpcHandlerRegistrar = { registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
            // RPC ingress is untyped; registered production handlers validate the request beneath this boundary.
            handlers.set(method, (request, ingress) => handler(request as TRequest, ingress));
        } };
        let invocationApprovalRequired = false;
        registerProjectFiniteRpcHandlers(registrar, { serverId: runtimeProfileId, machineId: 'machine',
            runtime: async ingress => {
                if (!ingress.callerInputAuthorization) return runtime;
                const { credentials: _credentials, ...signedRuntime } = runtime;
                return { ...signedRuntime, accountAuthorization: ingress.callerInputAuthorization };
            },
            createActionExecutor: async (current, ingress) => {
                const credentials = current.accountAuthorization
                    ? readRequesterAccountActionContext(current.accountAuthorization)?.credentials : current.credentials;
                if (!credentials) throw new Error('Expected the fixture requester credentials');
                const { createCliActionExecutorHarness } = await import('@/session/actions/createCliActionExecutorHarness');
                return createCliActionExecutorHarness({ token: credentials.token,
                credentials, mode: 'plain', ctx: null, sessionId: 'fixture-session', serverId: current.serverId, serverHttpBaseUrl: current.serverHttpBaseUrl,
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
                    actions: invocationApprovalRequired ? { 'projects.script.run': { approvalRequiredSurfaces: ['rpc', 'api'] } } : {},
                    ...(invocationApprovalRequired ? {} : { approvalWaivedSurfaces: actionSettings().approvalWaivedSurfaces }),
                }) },
                }, { runActionOperation: operationRuntime.runActionOperation,
                    machinePoolAction: createAccountServerActionDeps({ token: credentials.token, credentials,
                    serverId: current.serverId, serverHttpBaseUrl: current.serverHttpBaseUrl, serverIdentityId: homeId,
                    externalActionMachineInstallationId: 'installation',
                    externalActionMachineRequestPrivateKey: receivingInstallation.secretKey }).machinePoolAction,
                    projectAction: createFiniteActionWithCapturedRequester(current, ingress) }).executor;
            },
        });
        let rpcRequestSequence = 0;
        const rpcInvoke = (actionId: 'projects.prepare' | 'projects.script.run' | 'projects.compute.exec', input: unknown, ingress?: RpcHandlerContext) =>
            handlers.get(PROJECT_FINITE_ACTION_RPC_METHODS_V1[actionId])!(input, ingress
                ?? { ...context, transportRequestId: `transport-${++rpcRequestSequence}` });
        const addWorkerTarget = async () => {
            const targetRoot = await mkdtemp(join(tmpdir(), 'happier-project-worker-'));
            roots.push(targetRoot);
            await mkdir(join(targetRoot, '.happier'));
            await writeFile(join(targetRoot, '.happier/project.json'), 'invalid before clean copy');
            const target = { ...workspace, id: 'worker-target', machineId: 'machine', rootPath: targetRoot };
            workspaceRefs.push(target);
            const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
            relationships.push({ v: 1, relationshipId: 'source-worker', controllerMachineId: sourceMachineId,
                alphaWorkspaceRefId: workspace.id, betaWorkspaceRefId: target.id, mode: 'keep_synced', enabled: true,
                contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1,
                provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: workspace.id, targetWorkspaceRefId: target.id } });
            workersEnabled = true;
            return target;
        };
        const installPreferenceReadHttpBoundary = () => vi.spyOn(axios, 'request').mockImplementation(async config => {
            expect(config.headers).toMatchObject({ Authorization: `Bearer ${credentialToken}` });
            if (config.url === 'https://home.example/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            expect(config.url).toBe(`https://home.example${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`);
            expect(config.data).toEqual({ address: { serverId: homeId, refId: address.workspaceId } });
            const preference = await workspaceExecutionConfig.get({ workspace: { serverId: homeId, refId: address.workspaceId } });
            if (preference.status !== 'ready') throw new Error('Fixture workspace preference unavailable');
            return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { ...preference.preference, services: {} } } } };
        });
        // Home HTTP fixture facts mirror auth/workspaceSyncAdmission.ts; no Machine-read authority is widened.
        const homeSourceAdmission = (requestId: string, installationId: string) => WorkspaceSyncAdmissionV1Schema.parse({
            relationshipId: deriveWorkspaceSyncRelationshipId(requestId), sourceWorkspaceRefId: workspace.id,
            source: { ...context.machineAdmission, machineId: sourceMachineId, installationId },
        });
        return { root, runtime, terminalSessions, context, address, workspaceRefs, relationships, invoke, rpcInvoke, spawned, firstSpawn, operationRuntime, workspaceExecutionConfig, get, post, homeSourceAdmission, receivingInstallation, allowAdHoc: () => { allowAdHoc = true; },
            observeMemory: (observation: ProjectWorkerMemoryObservation) => { availableMemory = observation; },
            setToolExecutable: (path: string) => { nativeExecutablePath = path; }, refuseAdmission: () => { accepting = false; },
            setToolRelativeExecutable: (path: string) => { nativeExecutableRelativePath = path; },
            setConfigEnvironment: (name: string, value: string) => { configEnvironment[name] = value; },
            retireCredentials: () => { credentialCurrent = false; }, requireInvocationApproval: () => { invocationApprovalRequired = true; },
            waiveSetupApproval: () => { setupApprovalWaived = true; },
            askSetupApproval: () => { setupApprovalWaived = false; },
            addWorkerTarget, continueCopy: () => continueCopy(), holdCopy,
            setWorkerDestination: (machineId: string) => { workerDestination = { kind: 'machine', machineId }; },
            setWorkerUnavailable: (value: 'ask' | 'primary' | 'fail') => { unavailable = value; },
            setWorkerPool: (poolId: string) => { workersEnabled = true; workerDestination = { kind: 'pool', poolId, selection: 'automatic' }; },
            isFiniteExecutionLive: () => handlers.has(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run'])
                && handlers.has(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.compute.exec']),
            installPreferenceReadHttpBoundary,
            rememberSetup: (reviewedEffectDigest: string) => createProjectSetupTrustClient({ credentials: runtime.credentials,
                serverHttpBaseUrl: runtime.serverHttpBaseUrl }).approveReviewedEffect({ project: { serverId: homeId, projectId: 'project' },
                reviewedEffectDigest, currentEffectDigest: reviewedEffectDigest, approvedAtMs: 1, expectedRevision: 'absent', authority: 'present_user' }),
        };
    }

    it('keeps registered finite Exec useful through Machine admission and the canonical finalizer when owner isolation is off', async () => {
        const h = await harness();
        h.allowAdHoc();
        Object.assign(h.runtime, { agentIsolation: { read: () => ({ enabled: false,
            status: { kind: 'disabled' }, workspaceRoots: [] }) } } satisfies Pick<ProjectFiniteActionRuntime, 'agentIsolation'>);
        const ingress = { ...h.context, callerAuthority: 'account_automation' as const };
        const input = { workspace: h.address, executable: '/managed/check', argv: ['literal; not a shell'], cwd: h.root };
        try {
            expect(await authorizeMachineRpcRequest({ method: `machine:${PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.compute.exec']}`,
                params: input, machineAdmission: ingress.machineAdmission, callerAuthority: ingress.callerAuthority }, {
                machineId: 'machine', resolveInstallationId: () => 'installation', resolveHomeServerIdentityId: async () => 'home',
                resolveCustodianAccountId: async () => 'owner', verifyMachineAdmission: async () => true,
            })).toEqual({ ok: true });
            expect(await h.rpcInvoke('projects.compute.exec', input, ingress)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => h.spawned.length || h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state === 'failed').toBeTruthy();
            expect(h.spawned).toHaveLength(1);
            expect(h.spawned[0]!.params.args).toEqual(['literal; not a shell']);
            h.spawned[0]!.pty.exit(0);
            expect(await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation'))
                .toMatchObject({ state: 'succeeded' });
        } finally { await h.operationRuntime.runner.retireProjectFiniteOperations(); }
    });

    it.each(['invocation', 'project'] as const)('acquires the installed Account vault field through the %s reference binding', async bindingScope => {
        const homeId = 'srv_finite_vault';
        const installedToken = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
        const h = await harness({ version: 1, environmentVariables: [{ name: 'TOKEN', kind: 'secret', required: true }],
            scripts: { checked: { source: { kind: 'command', command: '/managed/check' } } } },
            null, 'machine', installedToken, 'home', homeId);
        h.allowAdHoc();
        const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
        const home = await mkdtemp(join(tmpdir(), 'finite-vault-home-')); roots.push(home);
        environment.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'home' }); reloadConfiguration();
        await updateSettings(settings => ({ ...settings, activeServerId: 'home', servers: { home: {
            id: 'home', name: 'Home', serverUrl: 'https://home.example', webappUrl: 'https://home.example',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }),
        } } }));
        await writeStoredCredentialsForServerId('home', h.runtime.credentials!);
        const credentials = await readStoredCredentialsForServerId('home');
        if (!credentials) throw new Error('Installed credential unavailable');
        const plugin = definePlugin({ id: 'acme.finite-vault', version: '1.0.0', displayName: 'Finite vault',
            entrypoints: { daemon: './daemon.mjs' }, secretSources: { field: {
                declaration: { title: 'Finite vault field' }, runtime: { async acquire(input) {
                    const response = await axios.get<{ value: string }>('https://vault.test/finite-field', {
                        params: { account: input.account, reference: input.reference },
                    });
                    return { ok: true, value: response.data.value };
                } },
            } } });
        const source = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
                instantiateCommittedModule: () => ({ activate: plugin.activate }) }], coldStart: true,
            async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            })); },
        });
        const keys = nacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        let nativeReads = 0;
        let nativeValue = 'private-finite-value';
        const ref = formatSharedSavedSecretRefV1('finite-credential');
        const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: 'finite-credential', mode: 'plain', content: {
            v: 2, name: 'Finite credential', kind: 'token', source: { kind: 'external',
                contribution: { pluginId: 'acme.finite-vault', localId: 'field' }, account: 'owner-vault', reference: 'op://finite/field' },
        } });
        const binding = { ref, revision: 1 };
        const bind = (reference: typeof binding | null, expectedRevision: 'absent' | number) => updateProjectOrganizationV1({
            accountScope: () => ({ serverId: homeId, accountId: 'owner' }),
            mutateOrganization: input => mutateProjectAccountOrganization({ ...input, credentials: h.runtime.credentials! }),
        }, { projectRef: { serverId: homeId, projectKey: 'project' }, expectedRevision,
            environmentBinding: { name: 'TOKEN', reference } });
        expect(await bind(bindingScope === 'project' ? binding : { ...binding, revision: 2 }, 'absent'))
            .toMatchObject({ ok: true, revision: 0 });
        h.get.mockImplementation(async (url, options) => {
            if (url === 'https://vault.test/finite-field') {
                nativeReads++;
                expect(options?.params).toEqual({ account: 'owner-vault', reference: 'op://finite/field' });
                return { status: 200, data: { value: nativeValue } };
            }
            if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (String(url).endsWith('/v1/account/saved-secrets/resources/materials')) return { status: 200, data: { resources: [{
                resourceId: 'finite-credential', encryptionMode: 'plain', recipientEnvelope: null, storedContent,
                entry: { ref, source: 'shared_resource', relationship: 'owner', ownerAccountId: 'owner', name: 'Finite credential', kind: 'token',
                    revision: 1, materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] } };
            return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        h.installPreferenceReadHttpBoundary();
        const factory = createInstalledProjectFiniteRuntime({ api: { getMachine: async () => { throw new Error('Unexpected Machine read'); } },
            credentials, externalActionAccountId: 'owner', finiteServerId: 'home', finiteServerHttpBaseUrl: 'https://home.example',
            registeredMachineId: 'machine', admission: h.runtime.workerAdmission, isCurrent: h.runtime.isCurrent!,
            nativeIo: { commandIo: h.runtime.nativeIo, environmentIo: h.runtime.environmentIo }, plugins: source.registry,
            agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
            successHomeDir: join(h.root, 'success'), prepareBetween: async () => { throw new Error('Unexpected Sync'); },
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }) });
        try {
            const runtime = await factory({ operationRuntime: h.operationRuntime, terminalSessions: h.terminalSessions }, h.context);
            if (!runtime) throw new Error('Installed runtime unavailable');
            const action = createFiniteActionWithCapturedRequester(runtime, h.context);
            const inspection = await inspectProjectSetupFromRuntime({ runtime, ingress: h.context, workspace: h.address, context: { serverId: homeId } });
            if (bindingScope === 'project') {
                expect(inspection).toMatchObject({ setupReadiness: { kind: 'notRequired' },
                    setupReview: { reviewedEffectDigest: expect.any(String) } });
            }
            // A successful Project-bound review validates its selected field;
            // each later Run acquires fresh material in its own admitted lifetime.
            const reviewReads = bindingScope === 'project' ? 1 : 0;
            expect(nativeReads).toBe(reviewReads);
            expect(h.spawned).toEqual([]);
            expect(JSON.stringify(inspection)).not.toContain('private-finite-value');
            const run = (actionRequestId?: string) => action(bindingScope === 'project' ? {
                actionId: 'projects.script.run', input: { workspace: h.address, selection: { kind: 'named', name: 'checked' } },
                context: { serverId: homeId, bypassApprovals: true, ...(actionRequestId ? { actionRequestId } : {}) },
            } : { actionId: 'projects.compute.exec', input: { workspace: h.address,
                executable: '/managed/check', argv: [], cwd: h.root,
                environmentBindings: { v: 1, bindings: { TOKEN: { ref, revision: 1 } } } },
                context: { serverId: homeId, bypassApprovals: true, ...(actionRequestId ? { actionRequestId } : {}) } });
            const accepted = await run();
            expect(accepted).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => h.spawned.length || h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state === 'failed').toBeTruthy();
            expect(h.spawned, JSON.stringify(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation'))).toHaveLength(1);
            expect(h.spawned[0]!.params.options.env).toMatchObject({ TOKEN: 'private-finite-value' });
            expect(nativeReads).toBe(reviewReads + 1);
            h.spawned[0]!.pty.exit(0);
            const terminal = await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation');
            expect(terminal).toMatchObject({ state: 'succeeded' });
            expect(JSON.stringify({ accepted, terminal })).not.toContain('private-finite-value');
            nativeValue = 'rotated-finite-value';
            const next = await run('next-vault-operation');
            expect(next).toMatchObject({ operation: { operationId: 'operation-2' } });
            await expect.poll(() => h.spawned.length).toBe(2);
            expect(h.spawned[1]!.params.options.env).toMatchObject({ TOKEN: 'rotated-finite-value' });
            expect(nativeReads).toBe(reviewReads + 2);
            h.spawned[1]!.pty.exit(0);
            const nextTerminal = await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation-2');
            expect(nextTerminal).toMatchObject({ state: 'succeeded' });
            expect(JSON.stringify({ next, nextTerminal })).not.toContain('rotated-finite-value');
            if (bindingScope === 'project') {
                expect(await bind(null, 0)).toMatchObject({ ok: true, revision: 1, row: {} });
                const missing = await run('unbound-vault-operation');
                expect(missing).toMatchObject({ operation: { operationId: 'operation-3' } });
                expect(await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation-3'))
                    .toMatchObject({ state: 'failed', error: { errorCode: 'project_environment_binding_unavailable' } });
                expect(h.spawned).toHaveLength(2);
                expect(nativeReads).toBe(reviewReads + 2);
                expect(await bind(binding, 1)).toMatchObject({ ok: true, revision: 2 });
                expect(await run('rebound-vault-operation')).toMatchObject({ operation: { operationId: 'operation-4' } });
                await expect.poll(() => h.spawned.length).toBe(3);
                expect(h.spawned[2]!.params.options.env).toMatchObject({ TOKEN: 'rotated-finite-value' });
                h.spawned[2]!.pty.exit(0);
                expect(await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation-4'))
                    .toMatchObject({ state: 'succeeded' });
                expect(nativeReads).toBe(reviewReads + 3);
            }
            expect(JSON.stringify(h.post.mock.calls)).not.toContain(nativeValue);
        } finally {
            h.spawned.forEach(({ pty }) => pty.exit(0)); await h.operationRuntime.runner.retireProjectFiniteOperations();
            await source.dispose(); environment.restore(); reloadConfiguration();
        }
    });

    it.each((['projects.script.run', 'projects.compute.exec'] as const).flatMap(actionId =>
        [true, false].map(published => ({ actionId, published }))))('keeps $actionId inside the held Agent isolation authority before any PTY effect (published: $published)', async ({ actionId, published }) => {
        const h = await harness();
        h.allowAdHoc();
        Object.assign(h.runtime, { agentIsolation: { read: () => ({ enabled: true,
            status: { kind: 'unavailable', code: 'provisioning_unavailable' }, workspaceRoots: [published ? h.root : process.cwd()] }) } } satisfies Pick<ProjectFiniteActionRuntime, 'agentIsolation'>);
        const input = actionId === 'projects.script.run'
            ? { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } }
            : { workspace: h.address, executable: '/managed/check', argv: ['literal; not a shell'], cwd: h.root };
        try {
            expect(await h.invoke(actionId, input)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => h.spawned.length || h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state === 'failed').toBeTruthy();
            for (const child of h.spawned) child.pty.exit(0);
            expect(await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation'))
                .toMatchObject({ state: 'failed', error: { errorCode: 'agent_isolation_unavailable' } });
            expect(h.spawned).toEqual([]);
        } finally { await h.operationRuntime.runner.retireProjectFiniteOperations(); }
    });

    it.each([
        ['nix_flake', 'flake.nix', '2.35.2', '{ outputs = inputs: {}; }'],
        ['devenv', 'devenv.nix', '2.4.0', '{ pkgs, ... }: { env.NATIVE_VALUE = "prepared"; }'],
    ] as const)('reviews unevaluated %s before native effects and resumes the original Project Run after human approval', async (tool, configPath, version, content) => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const h = await harness({ version: 1, toolchain: { kind: 'toolchain', tool, configPath } }, 1, 'machine', token);
        await writeFile(join(h.root, configPath), content);
        const evaluated = join(h.root, 'native-evaluated');
        Object.assign(h.runtime, {
            nativeIo: { resolveTool: async (id: string) => ({ executablePath: `/managed/${id}`, version: id === 'make' ? '1' : version }) },
            environmentIo: createProjectNativeToolchainIoForHost({
                // The installed-tool OS boundary substitutes a real supervised
                // process; admission, review, native production and PTY stay real.
                resolveTool: async () => ({ executablePath: process.execPath, version, args: ['-e',
                    `require('node:fs').writeFileSync(${JSON.stringify(evaluated)},'evaluated');process.stdout.write('\\0HAPPIER_NATIVE_ENV_V1\\0NATIVE_VALUE=prepared\\0');`, '--'] }),
            }),
        });
        const scope = { accountId: 'owner', machineId: 'machine' };
        try {
            expect(await h.rpcInvoke('projects.script.run', { workspace: h.address,
                selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } }))
                .toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => {
                const snapshot = h.operationRuntime.store.get(scope, 'operation');
                return snapshot?.setupReview?.code ?? snapshot?.error?.errorCode ?? snapshot?.state;
            }).toBe('project_setup_consent_required');
            const review = ProjectSetupConsentFailureDetailsV1Schema.parse(h.operationRuntime.store.get(scope, 'operation')!.setupReview);
            expect(review.reviewedEffect).toMatchObject({ toolchain: { selection: { kind: 'toolchain', tool, configPath } },
                files: [expect.objectContaining({ file: configPath, digest: expect.any(String) })] });
            await expect(access(evaluated)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(h.spawned).toEqual([]);
            h.waiveSetupApproval();
            expect(await h.rpcInvoke('projects.prepare', { workspace: h.address, phase: 'setup', heldOperationId: 'operation',
                expectedEffectDigest: review.reviewedEffectDigest, consentScope: 'thisTime' },
            { ...h.context, callerAuthority: 'present_user', transportRequestId: 'approve-native-evaluation' }))
                .toMatchObject({ operation: { operationId: 'operation' } });
            await h.firstSpawn;
            expect(h.spawned).toHaveLength(1);
            expect(await readFile(evaluated, 'utf8')).toBe('evaluated');
            expect(h.spawned[0]!.params).toMatchObject({ file: '/managed/make', args: ['-f', join(h.root, 'Makefile'), 'check'],
                options: { cwd: h.root, env: { NATIVE_VALUE: 'prepared' } } });
            h.spawned[0]!.pty.exit(0);
            expect(await h.operationRuntime.runner.waitForTerminal(scope, 'operation')).toMatchObject({ state: 'succeeded' });
            expect(h.operationRuntime.store.list(scope).items).toHaveLength(1);
            expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/project-trust/mutate'))).toEqual([]);
        } finally { await h.operationRuntime.runner.retireProjectFiniteOperations(); }
    });

    it.each(['missing', 'unqualified'] as const)('retains the typed refusal for a %s selected Nix tool without native evaluation or host fallback', async mode => {
        const h = await harness({ version: 1, toolchain: { kind: 'toolchain', tool: 'nix_flake', configPath: 'flake.nix' } });
        await writeFile(join(h.root, 'flake.nix'), '{ outputs = inputs: {}; }');
        const evaluated = join(h.root, 'must-not-evaluate');
        const tool = mode === 'missing' ? null : { executablePath: process.execPath, version: '2.35.999', args: ['-e',
            `require('node:fs').writeFileSync(${JSON.stringify(evaluated)},'unexpected');`, '--'] };
        Object.assign(h.runtime, { nativeIo: { resolveTool: async (id: string) => id === 'nix' ? tool : { executablePath: `/managed/${id}`, version: '1' } },
            environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => tool }) });
        h.waiveSetupApproval();
        try {
            const result = await h.rpcInvoke('projects.script.run', { workspace: h.address,
                selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } });
            if (mode === 'missing') expect(result).toMatchObject({ ok: false, errorCode: 'native_tool_unavailable' });
            else {
                expect(result).toMatchObject({ operation: { operationId: 'operation' } });
                expect(await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation'))
                    .toMatchObject({ state: 'failed', error: { errorCode: 'native_version_not_characterized' } });
            }
            await expect(access(evaluated)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(h.spawned).toEqual([]);
        } finally { await h.operationRuntime.runner.retireProjectFiniteOperations(); }
    });

    it.for([{ commands: [], recovery: 'stop', capacity: 'runAtMost' }, { commands: ['echo must-not-run'], recovery: 'stop', capacity: 'runAtMost' },
        { commands: [], recovery: 'exit', capacity: 'runAtMost' }, { commands: [], recovery: 'exit', capacity: 'declaredMemory' }])(
        'settles the original built-in native environment after $recovery while retaining the $capacity reservation, setup $commands', async ({ commands, recovery, capacity }, { task }) => {
        const h = await harness({ version: 1, toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
            workspace: { setup: commands.map(command => ({ kind: 'command', command })),
                ...(capacity === 'declaredMemory' ? { memoryDemand: { bytes: 60, basis: { kind: 'declared' } } } : {}) } },
        capacity === 'runAtMost' ? 1 : null);
        if (capacity === 'declaredMemory') h.observeMemory({ totalBytes: 100, availableBytes: 100 });
        await writeFile(join(h.root, 'mise.toml'), '[env]\nMODE = "native"\n');
        const pidFile = join(h.root, 'builtin-helper.pid');
        const io = createProjectNativeToolchainIoForHost({
            // Replace only the external installed Mise tool boundary with a
            // process implementing its admitted Linux argv/version contract.
            // Actual evaluation, Exec supervision, operation and FIFO are real.
            resolveTool: async () => ({ executablePath: process.execPath, version: '2026.10.4', args: ['-e',
                `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`] }),
        });
        Object.assign(h.runtime, { environmentIo: io });
        const scope = { accountId: 'owner', machineId: 'machine' };
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        const originalIngress = { ...h.context, transportRequestId: 'builtin-original' };
        let helperPid: number | undefined;
        let allowTermination = false;
        let terminationAttempts = 0;
        const terminate = processTreeBoundary.terminateProcessTree;
        const boundary = vi.spyOn(processTreeBoundary, 'terminateProcessTree').mockImplementation(async (...args) => {
            terminationAttempts++;
            if (!allowTermination) throw new Error('OS cannot yet prove native environment tree absent');
            await terminate(...args);
        });
        try {
            expect(await h.rpcInvoke('projects.script.run', input, originalIngress)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => {
                const snapshot = h.operationRuntime.store.get(scope, 'operation');
                return snapshot?.setupReview?.code ?? snapshot?.error?.errorCode ?? snapshot?.state;
            }).toBe('project_setup_consent_required');
            await h.rememberSetup(h.operationRuntime.store.get(scope, 'operation')!.setupReview!.reviewedEffectDigest);
            expect(await h.rpcInvoke('projects.script.run', input, originalIngress)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(async () => {
                try { helperPid = Number(await readFile(pidFile, 'utf8')); return Number.isSafeInteger(helperPid) && helperPid > 0; }
                catch { return false; }
            }).toBe(true);
            expect(process.kill(helperPid!, 0)).toBe(true);
            expect(h.spawned).toEqual([]);
            expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: 'builtin-next' }))
                .toMatchObject({ operation: { operationId: 'operation-2' } });
            expect(await h.runtime.workerAdmission.load()).toMatchObject({ kind: 'known', running: 1, queued: 1 });
            expect(await h.operationRuntime.handlers.cancel({ operationId: 'operation' })).toEqual({ kind: 'requested' });
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.observation?.kind).toBe('outcome_uncertain');
            expect(terminationAttempts).toBeGreaterThan(0);
            expect(process.kill(helperPid!, 0)).toBe(true);
            expect(h.spawned).toEqual([]);
            allowTermination = true;
            if (recovery === 'exit') process.kill(helperPid!, 'SIGKILL');
            else expect(await h.operationRuntime.handlers.cancel({ operationId: 'operation' })).toEqual({ kind: 'requested' });
            // Stop acknowledges a request; native census, signaling and exit
            // reconciliation finish asynchronously without a phase deadline.
            // Use the containing test's budget, then require OS absence as soon
            // as the owning operation claims cancellation.
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state, { timeout: task.timeout }).toBe('cancelled');
            expect(() => process.kill(helperPid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
            // The next entry may enter native preparation only after the first
            // operation's actual tree proof, never while it remains unknown.
            await expect.poll(() => h.runtime.workerAdmission.dependencies()[0]?.operationId).toBe('operation-2');
            const firstPid = helperPid;
            await expect.poll(async () => Number(await readFile(pidFile, 'utf8')) !== firstPid).toBe(true);
            helperPid = Number(await readFile(pidFile, 'utf8'));
            expect(await h.operationRuntime.handlers.cancel({ operationId: 'operation-2' })).toEqual({ kind: 'requested' });
            expect(await h.operationRuntime.runner.waitForTerminal(scope, 'operation-2')).toMatchObject({ state: 'cancelled' });
        } finally {
            allowTermination = true;
            boundary.mockRestore();
            h.operationRuntime.runner.cancel(scope, 'operation');
            h.operationRuntime.runner.cancel(scope, 'operation-2');
            if (helperPid) {
                try { process.kill(helperPid, 'SIGKILL'); } catch { /* Already proven absent on success. */ }
            }
        }
    });

    it('admits portable Home script and prepare through the real finite owner and refuses invalid bindings', async () => {
        await withTempDir('finite-portable-home-', async home => {
            const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
            const profileId = 'local-finite-profile';
            const serverId = 'srv_finiteHome';
            try {
                scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: profileId });
                reloadConfiguration();
                const serverUrl = 'https://home.example';
                const profile = { id: profileId, name: 'Finite Home', serverUrl, webappUrl: serverUrl,
                    createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
                    homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: serverId, canonicalServerUrl: serverUrl,
                        revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] }) };
                await updateSettings(settings => ({ ...settings, activeServerId: profileId, servers: { [profileId]: profile } }));
                const h = await harness(undefined, null, 'machine', ownerToken, profileId, serverId);
                h.waiveSetupApproval();
                expect.soft(await inspectProjectSetupFromRuntime({ runtime: h.runtime, ingress: h.context,
                    workspace: h.address, context: { serverId } })).toMatchObject({ setupReadiness: { kind: 'notRequired' } });
                const selection = { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } as const;
                expect(await h.rpcInvoke('projects.script.run', { workspace: h.address, selection }))
                    .toMatchObject({ operation: { operationId: 'operation', state: 'accepted', domainRef: { sourceWorkspace: h.address } } });
                await expect.poll(() => h.spawned.length).toBe(1);
                h.spawned[0]!.pty.exit(0);
                await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state).toBe('succeeded');
                expect(await h.rpcInvoke('projects.prepare', { workspace: h.address, phase: 'setup' },
                    { ...h.context, transportRequestId: 'portable-prepare' }))
                    .toMatchObject({ operation: { state: 'accepted' } });
                await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')?.state).toBe('succeeded');
                expect(await h.rpcInvoke('projects.prepare', { workspace: { ...h.address, serverId: 'wrong-home' }, phase: 'setup' }))
                    .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
                const worker = await harness(portableNativeManifest, null, 'source-machine', ownerToken, profileId, serverId);
                const target = await worker.addWorkerTarget();
                const previousGet = worker.get.getMockImplementation()!;
                worker.get.mockImplementation(async (...args) => String(args[0]).includes('/v1/machines/')
                    ? { status: 200, data: { machine: { id: decodeURIComponent(String(args[0]).split('/').at(-1)!),
                        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, storageMode: 'plain', managedMachineRef: null } } }
                    : previousGet(...args));
                vi.spyOn(machineRpcTransport, 'callMachineRpc').mockResolvedValue({ statuses: observedSyncStatuses(worker.relationships) });
                const preparation = createWorkspaceSyncWorkerPreparation({ serverId: profileId,
                    serverHttpBaseUrl: worker.runtime.serverHttpBaseUrl, credentials: worker.runtime.credentials, targetMachineId: 'machine',
                    prepareBetween: (request, signal) => prepareWorkspaceSyncBetween({ ...request,
                        signal, serverId, readCurrent: async () => ({ workspaceRefs: worker.workspaceRefs, relationships: worker.relationships }),
                        // Only the remote controller's file-transfer/clean-status reply is substituted.
                        flush: async relationshipId => {
                            await cp(worker.root, target.rootPath, { recursive: true });
                            return { relationshipId, controllerMachineId: 'source-machine', state: 'watching', alphaPath: worker.root,
                                betaPath: target.rootPath, mode: 'keep_synced', endpointStates: {
                                    alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                                    beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
                                conflictCount: 0, lastCycleObservedAtMs: 1, lastCleanSyncAtMs: 2 };
                        } }) });
                Object.assign(worker.runtime, preparation);
                const source = worker.workspaceRefs[0]!;
                const signal = worker.context.signal;
                const basis = await preparation.resolveWorkerTarget({ source, signal });
                expect(basis).toMatchObject({ source: { serverId }, target: { serverId, id: target.id } });
                await preparation.prepareDequeue({ workspace: source, basis, signal,
                    choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } });
                expect(await worker.rpcInvoke('projects.script.run', { workspace: worker.address, selection: { kind: 'named', name: 'checked' },
                    choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } }))
                    .toMatchObject({ operation: { state: 'accepted' } });
                await expect.poll(() => worker.spawned.length).toBe(1);
                worker.spawned[0]!.pty.exit(0);
                await expect.poll(() => worker.runtime.workerAdmission.dependencies()).toEqual([]);
                await expect(preparation.resolveWorkerTarget({ source: { ...source, serverId: 'wrong-home' }, signal }))
                    .rejects.toMatchObject({ code: 'target_mismatch' });
                worker.relationships.splice(0);
                await expect(preparation.prepareDequeue({ workspace: source, basis, signal,
                    choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } }))
                    .rejects.toMatchObject({ code: 'relationship_changed' });
                for (const scenario of ['ambiguous', 'retired'] as const) {
                    await updateSettings(settings => {
                        const servers: NonNullable<typeof settings.servers> = scenario === 'retired' ? {}
                            : { [profileId]: profile, duplicate: { ...profile, id: 'duplicate' } };
                        return { ...settings, servers };
                    });
                    expect(await h.rpcInvoke('projects.prepare', { workspace: h.address, phase: 'setup' }))
                        .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
                    expect(await h.rpcInvoke('projects.script.run', { workspace: h.address, selection }))
                        .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
                    await expect(preparation.resolveWorkerTarget({ source, signal })).rejects.toMatchObject({ code: 'target_mismatch' });
                    expect(await inspectProjectSetupFromRuntime({ runtime: h.runtime, ingress: h.context,
                        workspace: h.address, context: { serverId } })).toMatchObject({ setupReadiness: { kind: 'unknown', code: 'target_mismatch' } });
                }
                const cancelled = new AbortController(); cancelled.abort();
                await expect(preparation.resolveWorkerTarget({ source, signal: cancelled.signal }))
                    .rejects.toMatchObject({ name: 'AbortError' });
                expect(h.spawned).toHaveLength(1);
            } finally { scope.restore(); reloadConfiguration(); }
        });
    });

    it.each(['projects.prepare', 'projects.script.run', 'projects.compute.exec'] as const)(
        'emits registered %s, operation, Wait and output contracts through real preparation/runner/byte-ring owners', async actionId => {
        let clock = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => clock);
        const source = { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } as const;
        const h = await harness(actionId === 'projects.prepare'
            ? { version: 1, workspace: { setup: [source] } } : undefined);
        if (actionId === 'projects.prepare') {
            h.waiveSetupApproval();
            const workspace = h.workspaceRefs[0]!;
            const review = await reviewProjectSetupEffect({ workspace,
                projectAssociation: { workspace, project: { serverId: 'home', projectId: 'project' } },
                requester: { credentials: h.runtime.credentials, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl },
                purpose: 'setup', platform: { os: 'linux', arch: 'x64' }, nativeIo: h.runtime.nativeIo,
                successHomeDir: h.runtime.successHomeDir });
            if (review.kind !== 'reviewed') throw new Error(review.code);
            await h.rememberSetup(review.plan.reviewedEffectDigest);
        }
        if (actionId === 'projects.compute.exec') h.allowAdHoc();
        const input = actionId === 'projects.prepare' ? { workspace: h.address, phase: 'setup' }
            : actionId === 'projects.script.run' ? { workspace: h.address, selection: { kind: 'native', source } }
            : { workspace: h.address, executable: '/installed/echo', argv: ['', '界🚀'.repeat(700)], cwd: h.root };
        const accepted = await h.rpcInvoke(actionId, input);
        assertActionOutputContract(actionId, accepted);
        expect(accepted).toMatchObject({ operation: { operationId: 'operation', state: 'accepted' } });
        await expect.poll(() => h.spawned.length).toBe(1);
        const runningOutput = async () => {
            const value = await h.operationRuntime.handlers.getV2({ operationId: 'operation' }, h.context);
            assertActionOutputContract('action.operations.get', value);
            return value;
        };
        h.spawned[0]!.pty.output(Buffer.from('older line\r\n\u001b[32mchecking '));
        h.spawned[0]!.pty.output(Buffer.from('世界🚀\u001b[0m\r\n'));
        expect(await runningOutput()).toMatchObject({ operation: {
            state: 'running', progress: { kind: 'indeterminate', label: 'checking 世界🚀' },
        } });
        h.spawned[0]!.pty.output(Buffer.from('x'.repeat(ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1 + 1) + '\n'));
        expect(await runningOutput()).toMatchObject({ operation: {
            progress: { kind: 'indeterminate', label: 'x'.repeat(ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1) },
        } });
        h.spawned[0]!.pty.output(Buffer.from('世界🚀\u0000\n'));
        h.spawned[0]!.pty.exit(actionId === 'projects.script.run' ? 7 : 0);
        const scope = { accountId: 'owner', machineId: 'machine' };
        const terminal = await h.operationRuntime.runner.waitForTerminal(scope, 'operation');
        expect(terminal?.state).toBe(actionId === 'projects.script.run' ? 'failed' : 'succeeded');
        const address = { serverId: 'home', machineId: 'machine', operationId: 'operation' };
        const operation = await h.operationRuntime.handlers.getV2({ operationId: address.operationId }, h.context);
        assertActionOutputContract('action.operations.get', operation);
        const waited = await executeWaitActionV1({ target: { kind: 'action_operation', ...address }, condition: { kind: 'terminal' } }, {
            // The Machine transport reaches the real operation owner, not a fabricated snapshot.
            operation: async () => ({ disposition: 'matched', snapshot: await h.operationRuntime.runner.waitForTerminal(scope, address.operationId) }),
        });
        assertActionOutputContract('wait', waited);
        expect(waited.disposition).toBe('matched');
        clock += 600_001;
        const output = await executeActionOperationActionV1({ actionId: 'projects.execution.output.read',
            input: { ...address, byteOffset: 0 }, transport: async request => {
                if (request.method === 'actionOperation.get.v2') return await h.operationRuntime.handlers.getV2(request.payload, h.context);
                if (request.method !== RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) throw new Error(request.method);
                const { TerminalStreamReadRequestSchema } = await import('@happier-dev/protocol/terminal/stream');
                return h.terminalSessions.readByteStream(TerminalStreamReadRequestSchema.parse(request.payload));
            } });
        assertActionOutputContract('projects.execution.output.read', output);
        expect(output).toMatchObject({ ok: true, terminalId: expect.any(String) });
        const replay = TerminalStreamReadResponseSchema.parse(output);
        if (!replay.ok) throw new Error(replay.code);
        expect(Buffer.concat(replay.frames.flatMap(frame => frame.t === 'bytes' ? [decodeTerminalStreamBytesFrame(frame)] : [])).toString('utf8')).toBe(
            'older line\r\n\u001b[32mchecking 世界🚀\u001b[0m\r\n' + 'x'.repeat(ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1 + 1) + '\n世界🚀\u0000\n');
        expect(replay.done).toBe(true);
    });

    it('isolates retained requester output by Account for the same operation id', async () => {
        const h = await harness();
        const selection = { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } as const;
        const accepted = await h.rpcInvoke('projects.script.run', { workspace: h.address, selection });
        expect(accepted).toMatchObject({ operation: { operationId: 'operation', state: 'accepted' } });
        await expect.poll(() => h.spawned.length).toBe(1);
        h.spawned[0]!.pty.output(Buffer.from('requester output\r\n'));
        h.spawned[0]!.pty.exit(0);
        await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation');

        const readOutput = (context: RpcHandlerContext) => executeActionOperationActionV1({
            actionId: 'projects.execution.output.read',
            input: { serverId: 'home', machineId: 'machine', operationId: 'operation', byteOffset: 0 },
            transport: async request => {
                if (request.method === 'actionOperation.get.v2') return h.operationRuntime.handlers.getV2(request.payload, context);
                if (request.method !== RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) throw new Error(request.method);
                // The OS byte ring remains readable: Account isolation must be decided by the retained operation owner.
                const { TerminalStreamReadRequestSchema } = await import('@happier-dev/protocol/terminal/stream');
                return h.terminalSessions.readByteStream(TerminalStreamReadRequestSchema.parse(request.payload));
            },
        });
        const ownOutput = TerminalStreamReadResponseSchema.parse(await readOutput(h.context));
        expect(ownOutput).toMatchObject({ ok: true, done: true });
        if (!ownOutput.ok) throw new Error(ownOutput.code);
        expect(Buffer.concat(ownOutput.frames.flatMap(frame => frame.t === 'bytes'
            ? [decodeTerminalStreamBytesFrame(frame)] : [])).toString('utf8')).toBe('requester output\r\n');

        const foreignContext: RpcHandlerContext = { ...h.context, machineAdmission: {
            ...h.context.machineAdmission!, actorAccountId: 'different-account',
        } };
        // Same Home, Machine, installation, operation and cursor; only the admitted requester Account changes.
        expect(await readOutput(foreignContext)).toEqual({ ok: false, errorCode: 'operation_not_found', error: 'operation_not_found' });
        expect(await readOutput(h.context)).toEqual(ownOutput);
    });

    it('runs a detected native source without importing a manifest and observes the real nonzero process outcome', async () => {
        const h = await harness();
        const selection = { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } as const;
        const script = { source: selection.source };
        const result = await h.rpcInvoke('projects.script.run', { workspace: h.address, selection });
        expect.soft(result).toMatchObject({ operation: { operationId: 'operation', state: 'accepted', domainRef: { purpose: 'script', workspaceRefId: 'accepted', sourceWorkspace: h.address, script } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned).toHaveLength(1);
        expect.soft(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toMatchObject({
            state: 'running', progress: { kind: 'phase', phase: 'script', label: expect.any(String) },
            domainRef: { purpose: 'script', sourceWorkspace: h.address, script, terminalId: expect.any(String) },
        });
        const running = h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation');
        expect(running?.domainRef).not.toHaveProperty('exitCode');
        expect(running?.domainRef).not.toHaveProperty('script.name');
        expect(h.spawned[0]!.params).toMatchObject({ file: '/managed/make', args: ['-f', join(h.root, 'Makefile'), 'check'], options: { cwd: h.root } });
        h.spawned[0]!.pty.exit(7);
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state).toBe('failed');
        const failed = h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation');
        expect(failed).toMatchObject({ state: 'failed', error: { errorCode: 'project_command_step_failed' }, domainRef: { purpose: 'script', sourceWorkspace: h.address, script, exitCode: 7, terminalId: expect.any(String) }, startedAt: running?.startedAt, settledAt: expect.any(Number) });
        await expect(access(join(h.root, '.happier/project.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps primary native preparation truthful without reporting a worker copy before launch', async () => {
        const h = await harness();
        const scope = { accountId: 'owner', machineId: 'machine' };
        const resolveTool = h.runtime.nativeIo.resolveTool;
        let continueTool!: () => void;
        const toolAllowed = new Promise<void>(resolve => { continueTool = resolve; });
        let toolPending = false;
        // Hold the external installed-tool boundary after dequeue revalidation; all
        // native preparation, reservation and snapshot logic remains real.
        vi.spyOn(h.runtime.nativeIo, 'resolveTool').mockImplementation(async (tool, request) => {
            if (h.runtime.workerAdmission.dependencies().some(entry => entry.operationId === 'operation' && entry.state === 'copying')) {
                toolPending = true;
                await toolAllowed;
            }
            return resolveTool(tool, request);
        });
        try {
            expect(await h.rpcInvoke('projects.script.run', { workspace: h.address,
                selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } }))
                .toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => toolPending).toBe(true);
            const preparing = h.operationRuntime.store.get(scope, 'operation');
            expect.soft(preparing).toMatchObject({ state: 'accepted', progress: { kind: 'phase', phase: 'preparing' },
                domainRef: { machineId: 'machine', workspaceRefId: 'accepted', cwd: h.root } });
            expect(preparing?.domainRef).not.toHaveProperty('terminalId');
            expect(h.spawned).toEqual([]);
            continueTool();
            await expect.poll(() => h.spawned.length).toBe(1);
            h.spawned[0]!.pty.exit(0);
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('succeeded');
        } finally {
            continueTool();
            h.operationRuntime.runner.cancel(scope, 'operation');
        }
    });

    it('refuses raw caller authority, missing/stale transport admission, and foreign requester credentials before network or process effects', async () => {
        const h = await harness();
        const input = { workspace: h.address, phase: 'setup' };
        expect(await h.invoke('projects.prepare', { ...input, actorAccountId: 'owner' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await h.invoke('projects.prepare', input, { signal: h.context.signal })).toMatchObject({ ok: false, errorCode: 'machine_admission_required' });
        expect(await h.invoke('projects.prepare', input, { ...h.context, machineAdmission: { ...h.context.machineAdmission!, actorAccountId: 'teammate' } })).toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
        expect(h.get).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled(); expect(h.spawned).toEqual([]);
        // Structurally bound reads remain Home-authorized; the reservation's
        // single currentness admission refuses stale custody before effects.
        expect(await h.invoke('projects.prepare', input, { ...h.context, verifyMachineAdmissionCurrent: async () => false }))
            .toMatchObject({ operation: { operationId: 'operation' } });
        await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation');
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation'))
            .toMatchObject({ state: 'failed', error: { errorCode: 'machine_admission_changed' } });
        expect(h.spawned).toEqual([]);
    });

    it.each([false, true])('readmits the primary association at actual native effects (setup: %s)', async setup => {
        const h = await harness(setup ? { version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } } : undefined,
            null, 'machine', setup ? 'withdrawal-setup' : 'withdrawal-command');
        h.waiveSetupApproval();
        const resolveTool = h.runtime.nativeIo.resolveTool;
        let withdrawn = false;
        const post = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => {
            const response = await post(url, body, options);
            if (!withdrawn || !/\/v1\/account\/project-rows\/(?:read|list)$/u.test(String(url))) return response;
            if (!response || typeof response !== 'object' || !('data' in response)) throw new Error('Expected Home response');
            if (String(url).endsWith('/read')) {
                const read = ProjectAccountRowReadResponseV1Schema.parse(response.data);
                return read.status === 'present' && read.row.key.kind === 'workspace-ref'
                    ? { ...response, data: { status: 'deleted', revision: read.row.revision + 1 } } : response;
            }
            const listed = ProjectAccountRowListResponseV1Schema.parse(response.data);
            if (listed.status !== 'listed') return response;
            // Real withdrawal is a newer tombstone, not absence from an inventory page.
            return { ...response, data: { ...listed, rows: listed.rows.map(row => row.key.kind === 'workspace-ref'
                ? { ...row, revision: row.revision + 1, content: null } : row) } };
        });
        vi.spyOn(h.runtime.nativeIo, 'resolveTool').mockImplementation(async (tool, request) => {
            if (h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')) {
                withdrawn = true;
            }
            return resolveTool(tool, request);
        });
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address,
            selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } }))
            .toMatchObject({ operation: { operationId: 'operation' } });
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state).toBe('failed');
        expect(withdrawn).toBe(true);
        expect(h.spawned).toEqual([]);
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation'))
            .toMatchObject({ error: { errorCode: 'project_workspace_unavailable' } });
    });

    it('reads Home once per distinct decision through registered Script preparation', async () => {
        const environment = createEnvKeyScope(['HAPPIER_WEB_LATENCY_TRACE']);
        environment.patch({ HAPPIER_WEB_LATENCY_TRACE: '1' });
        // Stage tracing is a routine local debug write (4bf6b3f98ea).
        const diagnostics = vi.spyOn(logger, 'debugLocalFile').mockImplementation(() => {});
        const h = await harness(undefined, null, 'machine', ownerToken);
        const credentials = h.runtime.credentials!;
        h.get.mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            throw new Error('Unexpected Home GET request');
        });
        const observation = await import('@/api/client/accountEncryptionCurrentnessObservation');
        const currentness = observation.acquireRequesterAccountEncryptionCurrentness({ accountId: 'owner',
            token: credentials.token, serverBaseUrl: h.runtime.serverHttpBaseUrl });
        await currentness.read();
        const getCallsAtStart = h.get.mock.calls.length;
        const requests: string[] = [];
        const phaseReads: Record<string, Array<{ config: number; project: number }>> = {};
        const startedReads = new Map<string, { config: number; project: number }>();
        const counts = () => ({ config: requests.filter(path => path.endsWith('/read')).length,
            project: h.post.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/project-rows/read')).length });
        diagnostics.mockImplementation((event, fields) => {
            if (event !== '[external-action-stage]' || !fields || typeof fields !== 'object' || !('stage' in fields)
                || typeof fields.stage !== 'string') return;
            const name = fields.stage.replace(/\.(begin|end)$/, '');
            if (fields.stage.endsWith('.begin')) startedReads.set(name, counts());
            else if (fields.stage.endsWith('.end')) {
                const start = startedReads.get(name);
                const end = counts();
                if (start) (phaseReads[name] ??= []).push({ config: end.config - start.config, project: end.project - start.project });
            }
        });
        const request = vi.spyOn(axios, 'request').mockImplementation(async config => {
            const path = new URL(config.url!).pathname;
            requests.push(path);
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) return { status: 200,
                data: { status: 'absent' } };
            throw new Error('Unexpected Home request');
        });
        const resolveWorkspaceExecutionConfig: ProjectFiniteActionRuntime['resolveWorkspaceExecutionConfig'] = async context => await createAccountServerWorkspaceWorkerPreferenceClient({
            token: credentials.token, credentials, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl,
            signal: h.context.signal, context, actionId: 'projects.script.run',
            isCredentialCurrent: h.runtime.isCurrent,
            resolveRequestHeaders: () => ({ Authorization: `Bearer ${credentials.token}` }),
        });
        Object.assign(h.runtime, { resolveWorkspaceExecutionConfig });
        try {
            const result = await h.rpcInvoke('projects.script.run', { workspace: h.address,
                selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } },
                { ...h.context, transportRequestId: '10000000-0000-4000-8000-000000000089' });
            expect(result).not.toMatchObject({ ok: false });
            expect(ProjectCommandActionOutputV1Schema.parse(result)).toMatchObject({ operation: { actionId: 'projects.script.run' } });
            await h.firstSpawn;
            // Acceptance, dequeue and final native admission remain separate decisions.
            // A no-effect setup and a primary Sync no-op introduce no new decision.
            // Currentness is descriptive; each decision still reads fresh mode authority.
            // Dequeue can start its next fresh read before the accepted RPC
            // returns. Count each decision below, not that scheduling race.
            expect.soft(requests.filter(path => path.endsWith('/read'))).toHaveLength(3);
            const projectReads = h.post.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/project-rows/read'));
            expect.soft(projectReads).toHaveLength(2);
            expect.soft(h.post.mock.calls).toHaveLength(2);
            // Project row snapshot reads borrow the held Account observation (085cab5b331).
            expect.soft(h.get.mock.calls.slice(getCallsAtStart)).toEqual([]);
            expect.soft(phaseReads['project.placement.review']).toEqual([{ config: 1, project: 0 }, { config: 1, project: 0 }]);
            expect.soft(phaseReads['project.command.review']).toEqual([{ config: 0, project: 0 }, { config: 1, project: 0 }]);
            expect.soft(phaseReads['project.sync.prepare']).toEqual([{ config: 0, project: 0 }]);
            expect(requests.filter(path => path === '/v1/account/encryption')).toHaveLength(3);
            const stages = diagnostics.mock.calls.filter(([event]) => event === '[external-action-stage]')
                .map(([, fields]) => fields);
            expect(stages).toEqual(expect.arrayContaining([
                expect.objectContaining({ stage: 'project.workspace.resolve.begin' }),
                expect.objectContaining({ stage: 'project.placement.review.end' }),
                expect.objectContaining({ stage: 'project.command.review.end' }),
                expect.objectContaining({ stage: 'project.sync.prepare.end' }),
            ]));
        } finally {
            h.spawned.forEach(({ pty }) => pty.exit(0));
            await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation');
            request.mockRestore();
            await currentness.dispose();
            environment.restore();
        }
    });

    it('does not borrow the owner credentials for a same-actor constrained caller without a finite proof producer', async () => {
        const h = await harness();
        const result = await h.invoke('projects.prepare', { workspace: h.address, phase: 'setup' }, { ...h.context,
            callerInputConstraints: { models: null, permissionModes: null } });
        expect(result).toMatchObject({ ok: false, errorCode: 'project_requester_authorization_unavailable' });
        expect(h.get).not.toHaveBeenCalled(); expect(h.post).not.toHaveBeenCalled(); expect(h.spawned).toEqual([]);
    });

    it('uses admitted requester custody for Account topology reads while keeping effects signed', async () => {
        const h = await harness();
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'worker-status-proof', binding: {
            accountId: 'bob', principalId: 'bob', credentialId: 'pat', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
            serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation', actionId: 'projects.worker.status',
            requestId: 'worker-status', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
            grant: { v: 1, actions: { families: [], ids: ['projects.worker.status'] }, targets: { sessions: [], machines: ['machine'] },
                approve: false, origins: [], models: null, permissionModes: null, create: null },
        } });
        h.get.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/profile') ? { id: 'bob' }
            : url.endsWith('/v2/account/settings') ? { content: { t: 'plain', v: {} }, version: 1 }
            : { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }));
        const post = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => String(url).endsWith('/verify')
            ? { status: 200, data: { ok: true } } : post(url, body, options));
        const admitted = await admitRequesterAccountActionContext({ authorization, credentials: { token: 'bob', encryption: null },
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true });
        if (!admitted) throw new Error('Requester custody not admitted');
        try {
            const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
                serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example',
                target: authorization.binding.target, installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey,
                isCurrent: admitted.isCurrent });
            if (!carrier?.requesterHttpProjection) throw new Error('Requester HTTP custody not admitted');
            const headers = (method: string, path: string, effectActionId = 'projects.worker.status') =>
                carrier.requesterHttpProjection!.createRequestHeaders({ effectActionId, method, path, ...(method === 'POST' ? { body: {} } : {}) });
            expect(await headers('GET', '/v1/machines/source')).toEqual({ Authorization: 'Bearer bob' });
            expect(await headers('POST', '/v1/account/project-rows/list')).toEqual({ Authorization: 'Bearer bob' });
            for (const [method, path, effect] of [['GET', '/v1/machines/machine', 'projects.worker.status'],
                ['POST', '/v1/account/project-rows/mutate', 'projects.worker.status'],
                ['GET', '/v1/machines/source', 'projects.script.run']] as const) {
                expect(await headers(method, path, effect)).not.toHaveProperty('Authorization');
            }
            await admitted.dispose();
            expect(await headers('GET', '/v1/machines/source')).toBeNull();
        } finally { await admitted.dispose(); }
    });

    it.each(['native', 'secret-exec', 'portable Home'] as const)('retains restricted requester custody without borrowing owner authority when Agent launch context is unavailable (%s)', async kind => {
        const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
        const profileId = kind === 'portable Home' ? 'private-finite-profile' : 'home';
        const homeId = kind === 'portable Home' ? 'srv_privateFiniteHome' : 'home';
        try {
        if (kind === 'portable Home') {
            const home = await mkdtemp(join(tmpdir(), 'finite-private-home-'));
            roots.push(home);
            scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: profileId });
            reloadConfiguration();
            const serverUrl = 'https://home.example';
            await updateSettings(settings => ({ ...settings, activeServerId: profileId, servers: { [profileId]: {
                id: profileId, name: 'Private finite', serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
                homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
                    canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] }),
            } } }));
        }
        const h = await harness(kind === 'secret-exec' ? { version: 1,
            environmentVariables: [{ name: 'API_KEY', kind: 'secret', required: true }] } : undefined, null, 'machine', 'requester', profileId, homeId);
        const actionId = kind !== 'secret-exec' ? 'projects.script.run' : 'projects.compute.exec';
        const serverIdentityId = homeId;
        h.allowAdHoc();
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
            accountId: 'bob', principalId: 'bob', credentialId: 'pat', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
            serverIdentityId, machineId: 'machine', installationId: 'installation', actionId,
            requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
            grant: { v: 1, actions: { families: [], ids: [actionId] }, targets: { sessions: [], machines: ['machine'] },
                approve: false, origins: [], models: null, permissionModes: null, create: null },
        } });
        h.get.mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: { secrets: [{
                id: 'bob-key', name: 'Requester key', kind: 'token', createdAt: 1, updatedAt: 1,
                encryptedValue: { _isSecretValue: true, value: 'bob-private-value' },
            }] } }, version: 1 } };
            return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        const admitted = await admitRequesterAccountActionContext({ authorization, credentials: { token: 'bob', encryption: null },
            serverId: profileId, serverIdentityId, serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true });
        if (!admitted) throw new Error('Requester custody not admitted');
        try {
        const keys = nacl.sign.keyPair();
        // Home verification and row IO are HTTP boundaries; custody/crypto/finite logic remain real.
        const rowPost = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => String(url).endsWith('/verify')
            ? { status: 200, data: { ok: true } } : rowPost(url, body, options));
        const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
            serverId: profileId, serverIdentityId, serverHttpBaseUrl: 'https://home.example',
            target: authorization.binding.target, installationId: 'installation', privateKey: keys.secretKey, isCurrent: admitted.isCurrent });
        if (!carrier) throw new Error('Requester HTTP custody not admitted');
        if (kind === 'portable Home') {
            expect(carrier.requesterAccountProjection?.serverId).toBe(profileId);
            expect(carrier.requesterHttpProjection?.serverId).toBe(profileId);
            await expect.soft(readProjectAccountRows({ authorization: carrier, effectActionId: actionId, serverId: homeId,
                selection: { kinds: ['workspace-ref'], serverId: homeId } }))
                .resolves.toMatchObject({ workspaceRefs: [expect.objectContaining({ serverId: homeId })] });
            const trust = createProjectSetupTrustClient({ authorization: carrier, effectActionId: actionId,
                serverHttpBaseUrl: 'https://home.example' });
            await expect.soft(trust.read({ serverId: homeId, projectId: 'project' })).resolves.toEqual({ status: 'absent' });
            await expect(readProjectAccountRows({ authorization: carrier, effectActionId: actionId, serverId: 'srv_wrongHome',
                selection: { kinds: ['workspace-ref'] } }))
                .rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
            await expect(trust.read({ serverId: 'srv_wrongHome', projectId: 'project' }))
                .rejects.toMatchObject({ code: 'project_trust_identity_mismatch' });
        }
        const { credentials: _owner, ...ports } = h.runtime;
        const runtime: ProjectFiniteActionRuntime = { ...ports, accountId: 'bob', accountAuthorization: carrier, isCurrent: admitted.isCurrent,
            agentIsolation: { read: () => ({ enabled: true,
                status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [h.root] }) } };
        const ingress: RpcHandlerContext = { ...h.context, callerInputAuthorization: carrier,
            callerInputConstraints: { models: null, permissionModes: null },
            machineAdmission: { ...h.context.machineAdmission!, actorAccountId: 'bob', role: 'use' } };
        const result = await createFiniteActionWithCapturedRequester(runtime, ingress)({ actionId,
            input: kind !== 'secret-exec' ? { workspace: h.address,
                selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } }
                : { workspace: h.address, executable: '/managed/checked', argv: [], cwd: h.root,
                    environmentBindings: { v: 1, bindings: { API_KEY: { ref: 'bob-key' } } } },
            context: { serverId: homeId, authority: 'account_automation', actionRequestId: 'request' } });
        expect(result).toMatchObject({ operation: { scope: { accountId: 'bob' } } });
        await admitted.dispose();
        // With Machine isolation enabled, Account custody cannot replace the
        // missing prepared Agent isolation/material context with host Exec.
        expect(await h.operationRuntime.runner.waitForTerminal({ accountId: 'bob', machineId: 'machine' }, 'operation'))
            .toMatchObject({ state: 'failed', error: { errorCode: 'agent_isolation_unavailable' } });
        expect(h.spawned).toEqual([]);
        expect(JSON.stringify(result)).not.toContain('bob-private-value');
        for (const [url, , options] of h.post.mock.calls.filter(([url]) => !String(url).endsWith('/verify'))) {
            if (/\/v1\/account\/project-rows\/(?:read|list)$/u.test(String(url))) {
                expect(options?.headers).toMatchObject({ Authorization: 'Bearer bob' });
            } else {
                expect(options?.headers).not.toHaveProperty('Authorization');
            }
        }
        expect(await admitted.isCurrent()).toBe(false);
        } finally {
            h.spawned.forEach(({ pty }) => pty.exit(0));
            await admitted.dispose();
        }
        } finally { scope.restore(); reloadConfiguration(); }
    });

    it.each([
        ['projects.inspect', 'factory custody'],
        ['projects.inspect', 'current'], ['projects.inspect', 'revoked'], ['projects.inspect', 'mode'], ['projects.inspect', 'disconnect'],
        ['projects.script.run', 'current'],
        ['projects.script.run', 'revoked'], ['projects.script.run', 'mode'], ['projects.script.run', 'disconnect'],
        ['projects.script.run', 'setup revoked'],
        ['projects.script.run', 'environment revoked'], ['projects.script.run', 'setup environment revoked'],
    ] as const)('keeps requester encryption observed through real socket custody and HTTP on %s (%s)', async (actionId, change) => {
        const nativeEnvironment = change === 'environment revoked' || change === 'setup environment revoked';
        const h = await harness({ version: 1,
            ...(change === 'setup revoked' || change === 'setup environment revoked' ? { workspace: { setup: [
                { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' },
            ] } } : {}),
            ...(nativeEnvironment ? { toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' } } : {}),
        });
        const environmentEffect = join(h.root, 'native-environment-effect');
        if (nativeEnvironment) await writeFile(join(h.root, 'mise.toml'), '[env]\nNATIVE_VALUE = "prepared"\n');
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
            accountId: 'bob', principalId: 'bob', credentialId: 'pat', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
            serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation', actionId,
            requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
            grant: { v: 1, actions: { families: [], ids: [actionId] }, targets: { sessions: [], machines: ['machine'] },
                approve: false, origins: [], models: null, permissionModes: null, create: null },
        } });
        // Only Home HTTP is substituted for these custody/read decisions; all
        // admission, private projections, signing, rows and Action owners are real.
        h.get.mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            throw new Error(`Unexpected requester read ${url}`);
        });
        const rowPost = h.post.getMockImplementation()!;
        let revoked = false;
        let retireOnProjectRowRead = change === 'revoked';
        h.post.mockImplementation(async (url, body, options) => {
            if (!String(url).endsWith('/verify')) {
                const response = await rowPost(url, body, options);
                if (actionId === 'projects.inspect' && String(url).includes('/project-rows/') && retireOnProjectRowRead) {
                    if (change === 'revoked') revoked = true;
                    else if (change === 'disconnect') await channel.disconnect();
                    else await channel.push('bob', { mode: 'e2ee', version: 2, updatedAt: 2,
                        signingKeyFingerprint: 'changed-signing', contentKeyFingerprint: 'changed-content' });
                }
                return response;
            }
            await new Promise(resolve => setTimeout(resolve, 20));
            return revoked ? { status: 403, data: { error: 'not_authenticated' } } : { status: 200, data: {
                ...(String(url).includes('/admission/verify') ? { v: 1 } : {}), ok: true,
            } };
        });
        const privateKey = nacl.sign.keyPair().secretKey;
        const admitted = await admitRequesterAccountActionContext({ authorization, credentials: { token: 'bob', encryption: null },
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', isCurrent: async () =>
                await h.runtime.isCurrent!() && await verifyExternalActionExecutionAuthorizationCurrent({ authorization,
                    effectActionId: actionId, target: authorization.binding.target, installationId: 'installation',
                    privateKey, serverHttpBaseUrl: 'https://home.example' }), isCustodyCurrent: h.runtime.isCurrent });
        if (!admitted) throw new Error('Requester custody not admitted');
        const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', target: authorization.binding.target,
            installationId: 'installation', privateKey, isCurrent: admitted.isCustodyCurrent });
        if (!carrier) throw new Error('Requester HTTP custody not admitted');
        // Admission also obtains its fresh Settings floor. The zero-read
        // assertion below measures warm encryption custody after admission.
        expect(ExternalActionExecutionAuthorizationV1Schema.parse(carrier)).toEqual(authorization);
        const { credentials: _owner, ...ports } = h.runtime;
        let changed = false;
        const runtime: ProjectFiniteActionRuntime = { ...ports, accountId: 'bob', accountAuthorization: carrier, isCurrent: admitted.isCustodyCurrent,
            nativeIo: { ...ports.nativeIo, async resolveTool(tool, request) {
                // Change the genuine authority/Socket.IO fact during an OS tool
                // probe after acceptance, before the irreversible native spawn.
                if (change !== 'current' && !changed && h.operationRuntime.store.get({ accountId: 'bob', machineId: 'machine' }, 'operation')) {
                    changed = true;
                    if (change === 'revoked' || change === 'setup revoked' || nativeEnvironment) revoked = true;
                    else if (change === 'disconnect') await channel.disconnect();
                    else await channel.push('bob', { mode: 'e2ee', version: 2, updatedAt: 2,
                        signingKeyFingerprint: 'changed-signing', contentKeyFingerprint: 'changed-content' });
                }
                const resolved = await ports.nativeIo.resolveTool(tool, request);
                return resolved && tool === 'mise' ? { ...resolved, version: '2026.10.4' } : resolved;
            } }, ...(nativeEnvironment ? { environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => ({
                executablePath: process.execPath, version: '2026.10.4', args: ['-e',
                    `require('node:fs').writeFileSync(${JSON.stringify(environmentEffect)},'ran');process.stdout.write('NATIVE_VALUE=prepared\\0');`, '--'],
            }) }) } : {}) };
        const ingress: RpcHandlerContext = { ...h.context, callerInputAuthorization: carrier,
            callerInputConstraints: { models: null, permissionModes: null },
            machineAdmission: { ...h.context.machineAdmission!, actorAccountId: 'bob' },
            verifyMachineAdmissionCurrent: () => admitted.isCurrent() };
        const createInspectionIngress = async (): Promise<RpcHandlerContext> => {
            const signal = new AbortController().signal;
            const method = `machine:${getActionSpec('projects.inspect').bindings?.rpcMethod}`;
            // RpcHandlerManager admits each new request before building its
            // handler context; ApiMachineClient uses this same signed HTTP owner.
            // The private root stays on ingress. Ordinary inspection admission
            // sends the Machine receipt, rather than a routed child/SOURCE root.
            const admission = await authorizeMachineRpcRequest({ method, params: { workspace: h.address },
                machineAdmission: ingress.machineAdmission, callerInputAuthorization: carrier,
                callerAuthority: 'account_automation', signal }, {
                machineId: 'machine', resolveInstallationId: () => 'installation',
                resolveHomeServerIdentityId: async () => 'stable-home', resolveCustodianAccountId: async () => 'owner',
                verifyMachineAdmission: request => readMachineRpcAdmissionCurrent({ ...request,
                    privateKey, daemonToken: 'owner', serverHttpBaseUrl: 'https://home.example' }),
            });
            return { ...ingress, signal, verifyMachineAdmissionCurrent: async () => admission.ok && !signal.aborted };
        };
        h.get.mockClear(); h.post.mockClear();
        try {
            if (actionId === 'projects.inspect') {
                // The installation filesystem adapter is the only substituted
                // boundary in the installed finite factory; its custody is real.
                vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
                    version: 1, installationId: 'installation', createdAt: 1,
                    publicKey: Buffer.from(privateKey.subarray(32)).toString('base64url'),
                    privateKey: Buffer.from(privateKey).toString('base64url'),
                });
                const installed = createInstalledProjectFiniteRuntime({
                    api: { getMachine: async () => { throw new Error('Unexpected Machine HTTP read'); } },
                    credentials: h.runtime.credentials!, externalActionAccountId: 'owner',
                    finiteServerId: 'home', finiteServerHttpBaseUrl: 'https://home.example', registeredMachineId: 'machine',
                    admission: h.runtime.workerAdmission, isCurrent: h.runtime.isCurrent!,
                    nativeIo: { commandIo: h.runtime.nativeIo, environmentIo: h.runtime.environmentIo },
                    successHomeDir: join(h.root, 'success'),
                    prepareBetween: async () => { throw new Error('Unexpected Sync transport'); },
                    resolveCurrentMachineExecutionOriginContext: async () => { throw new Error('Unexpected origin HTTP read'); },
                });
                if (change === 'factory custody') {
                    const installedRuntime = await installed({
                        operationRuntime: h.operationRuntime, terminalSessions: h.terminalSessions,
                    }, ingress);
                    expect(installedRuntime).not.toBeNull();
                    expect(installedRuntime).not.toHaveProperty('credentials');
                    expect(installedRuntime?.accountAuthorization).toBe(carrier);
                    return;
                }
                const { ApiMachineClient } = await import('@/api/apiMachine');
                const client: ApiMachineClient = Object.assign(Object.create(ApiMachineClient.prototype), {
                    machine: { id: 'machine' }, machineRpcWorkingDirectory: h.root,
                    filesystemAccessPolicy: { kind: 'restrictedRoots', roots: [h.root] },
                    rpcLifecycleRegistrations: [{ resolveProjectFiniteRuntime: (currentIngress: RpcHandlerContext) => installed({
                        operationRuntime: h.operationRuntime, terminalSessions: h.terminalSessions,
                    }, currentIngress) }],
                });
                const read = async () => client.createProjectDefinitionAction('home', await createInspectionIngress())({
                    actionId, input: { workspace: h.address }, context: { serverId: 'home' } });
                if (change !== 'current' && change !== 'revoked') {
                    expect(ProjectDefinitionInspectOutputSchema.parse(await read())).toMatchObject({ setupReadiness: { kind: 'notRequired' } });
                    retireOnProjectRowRead = true;
                    const refused = ActionExecuteFailureSchema.parse(await read());
                    expect(refused).toMatchObject({ ok: false, errorCode: 'project_workspace_unavailable' });
                    expect(refused).not.toHaveProperty('effectiveDefinition');
                    expect(h.spawned).toEqual([]);
                    return;
                }
                if (change === 'revoked') {
                    expect(ProjectDefinitionInspectOutputSchema.parse(await read())).toMatchObject({ setupReadiness: { kind: 'notRequired' } });
                    h.post.mockClear();
                    const refused = ActionExecuteFailureSchema.parse(await read());
                    expect(refused).toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
                    expect(refused).not.toHaveProperty('effectiveDefinition');
                    expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
                    expect(h.post.mock.calls.some(([url]) => String(url).includes('/project-rows/'))).toBe(false);
                    return;
                }
                await read(); // Warm module/plugin loading before comparing the same passive composition.
                for (let sample = 0; sample < 3; sample++) {
                    h.get.mockClear(); h.post.mockClear();
                    const output = await read();
                    expect(ProjectDefinitionInspectOutputSchema.parse(output)).toMatchObject({ setupReadiness: { kind: 'notRequired' } });
                    expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
                }
                expect(h.spawned).toEqual([]);
            } else {
                const result = await createFiniteActionWithCapturedRequester(runtime, ingress)({ actionId, input: { workspace: h.address,
                    selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } },
                    context: { serverId: 'home', authority: 'account_automation', actionRequestId: 'request', surface: 'agent',
                        actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: {
                            'projects.prepare': ['agent', 'rpc', 'api'],
                        } }) } });
                expect(result, JSON.stringify(result)).toMatchObject({ operation: { scope: { accountId: 'bob' } } });
                expect(ProjectCommandActionOutputV1Schema.safeParse(result).success).toBe(true);
                if (change !== 'current') {
                    const terminal = await Promise.race([
                        h.operationRuntime.runner.waitForTerminal({ accountId: 'bob', machineId: 'machine' }, 'operation'),
                        h.firstSpawn.then(() => ({ state: 'unexpected_native_spawn' })),
                    ]);
                    expect(changed).toBe(true);
                    expect(terminal).toMatchObject({ state: 'failed' });
                    expect(h.spawned).toEqual([]);
                    if (nativeEnvironment) await expect(readFile(environmentEffect)).rejects.toMatchObject({ code: 'ENOENT' });
                    return;
                }
                expect(await h.operationRuntime.runner.waitForTerminal({ accountId: 'bob', machineId: 'machine' }, 'operation'))
                    .toMatchObject({ state: 'failed', error: { errorCode: 'agent_isolation_unavailable' } });
                expect(h.spawned).toEqual([]);
                return;
            }
            const counts = { encryption: h.get.mock.calls.filter(([url]) => String(url).endsWith('/currentness')).length,
                verify: h.post.mock.calls.filter(([url]) => String(url).endsWith('/verify')).length };
            if (actionId === 'projects.inspect') {
                // One requester admission belongs to this inspection request.
                // Private reads remain authorized by Home; passive phases add none.
                expect(counts).toEqual({ encryption: 0, verify: 1 });
                h.post.mockClear();
                expect(await inspectProjectSetupFromRuntime({ runtime,
                    ingress: await createInspectionIngress(), workspace: h.address, context: {} })).toMatchObject({ setupReadiness: { kind: 'notRequired' } });
                expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
                revoked = true;
                h.post.mockClear();
                expect(await inspectProjectSetupFromRuntime({ runtime, ingress: await createInspectionIngress(), workspace: h.address, context: {} }))
                    .toMatchObject({ setupReadiness: { kind: 'unknown', code: 'project_requester_credentials_unavailable' } });
                expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
                expect(h.post.mock.calls.some(([url]) => String(url).includes('/project-rows/'))).toBe(false);
                revoked = false;
                h.post.mockClear();
                expect(await inspectProjectSetupFromRuntime({ runtime, ingress: { ...await createInspectionIngress(), machineAdmission: undefined },
                    workspace: h.address, context: {} }))
                    .toMatchObject({ setupReadiness: { kind: 'unknown', code: 'machine_admission_required' } });
                expect(h.post.mock.calls.some(([url]) => String(url).includes('/project-rows/'))).toBe(false);
                const cancelled = new AbortController();
                cancelled.abort();
                h.post.mockClear();
                expect(await inspectProjectSetupFromRuntime({ runtime, ingress: await createInspectionIngress(), workspace: h.address, context: { signal: cancelled.signal } }))
                    .toMatchObject({ setupReadiness: { kind: 'unknown', code: 'cancelled' } });
                expect(h.post.mock.calls.some(([url]) => String(url).includes('/project-rows/'))).toBe(false);
                const currentPost = h.post.getMockImplementation()!;
                h.post.mockImplementation(async (...args) => {
                    const response = await currentPost(...args);
                    if (String(args[0]).includes('/project-rows/')) revoked = true;
                    return response;
                });
                expect(await inspectProjectSetupFromRuntime({ runtime, ingress: await createInspectionIngress(), workspace: h.address, context: {} }))
                    .toMatchObject({ setupReadiness: { kind: 'notRequired' } });
                expect(h.spawned).toEqual([]);
            }
            else expect(counts).toEqual({ encryption: 0, verify: 4 });
        } finally {
            h.spawned.forEach(({ pty }) => pty.exit(0));
            const operationScope = { accountId: 'bob', machineId: 'machine' };
            if (actionId === 'projects.script.run' && h.operationRuntime.store.get(operationScope, 'operation')) {
                h.operationRuntime.runner.cancel(operationScope, 'operation');
                await h.operationRuntime.runner.waitForTerminal(operationScope, 'operation');
            }
            await admitted.dispose();
        }
    });

    it('uses the installed readiness owner for current bytes and withdraws readiness on requester retirement', async () => {
        const h = await harness();
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-proof', binding: {
            accountId: 'bob', principalId: 'bob', credentialId: 'pat', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
            serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation', actionId: 'projects.inspect',
            requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
            grant: { v: 1, actions: { families: [], ids: ['projects.inspect'] }, targets: { sessions: [], machines: ['machine'] },
                approve: false, origins: [], models: null, permissionModes: null, create: null },
        } });
        h.get.mockImplementation(async (url: string) => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        const admitted = await admitRequesterAccountActionContext({ authorization, credentials: { token: 'bob', encryption: null },
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true });
        if (!admitted) throw new Error('Requester custody not admitted');
        const rowPost = h.post.getMockImplementation()!;
        h.post.mockImplementation(async (url, body, options) => String(url).endsWith('/verify')
            ? { status: 200, data: { ok: true } } : rowPost(url, body, options));
        const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
            serverId: 'home', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://home.example', target: authorization.binding.target,
            installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey, isCurrent: admitted.isCurrent });
        if (!carrier) throw new Error('Requester HTTP custody not admitted');
        const { credentials: _owner, ...ports } = h.runtime;
        const runtime: ProjectFiniteActionRuntime = { ...ports, accountId: 'bob', accountAuthorization: carrier, isCurrent: admitted.isCurrent };
        const ingress: RpcHandlerContext = { ...h.context, callerInputAuthorization: carrier,
            callerInputConstraints: { models: null, permissionModes: null },
            machineAdmission: { ...h.context.machineAdmission!, actorAccountId: 'bob' } };
        // Install the real runtime fixture as constructor state; unrelated sockets/Session registration are outside this inspection.
        const { ApiMachineClient } = await import('@/api/apiMachine');
        const client: ApiMachineClient = Object.assign(Object.create(ApiMachineClient.prototype), {
            machine: { id: 'machine' }, machineRpcWorkingDirectory: h.root,
            filesystemAccessPolicy: { kind: 'restrictedRoots', roots: [h.root] },
            rpcLifecycleRegistrations: [{ resolveProjectFiniteRuntime: async () => runtime }],
        });
        const action = Reflect.apply(client.createProjectDefinitionAction, client, ['home', ingress]);
        const inspect = () => action({ actionId: 'projects.inspect', input: { workspace: h.address }, context: { serverId: 'home' } });
        expect(await inspect()).toMatchObject({ setupReadiness: { kind: 'notRequired' } });
        await mkdir(join(h.root, '.happier'));
        const save = (manifest: unknown) => writeFile(join(h.root, '.happier/project.json'), JSON.stringify(manifest));
        await save({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } });
        expect(await inspect()).toMatchObject({ setupReadiness: { kind: 'unprepared' } });
        const workspace = h.workspaceRefs[0]!;
        const reviewed = await reviewProjectSetupEffect({ workspace, projectAssociation: { workspace, project: { serverId: 'home', projectId: 'project' } },
            requester: { authorization: carrier, effectActionId: 'projects.inspect', serverHttpBaseUrl: runtime.serverHttpBaseUrl },
            purpose: 'setup', platform: { os: 'linux', arch: 'x64' }, nativeIo: h.runtime.nativeIo });
        if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
        await createProjectSetupSuccessStore({ homeDir: h.runtime.successHomeDir! }).recordCompletion({ serverId: 'home', machineId: 'machine', workspaceRefId: workspace.id },
            { v: 1, workspaceRefId: workspace.id, completedAtMs: 123, ...reviewed.plan.successBasis });
        expect(await inspect()).toMatchObject({ setupReadiness: { kind: 'current', completedAtMs: 123 } });
        await save({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo changed' }] } });
        expect(await inspect()).toMatchObject({ setupReadiness: { kind: 'unprepared' } });
        await save({ version: 1, environmentVariables: [{ name: 'UNBOUND', kind: 'config', required: true }] });
        expect(await inspect()).toMatchObject({ setupReadiness: { kind: 'needsReview', code: 'project_environment_binding_unavailable' } });
        for (const [url, , options] of h.post.mock.calls.filter(([url]) => !String(url).endsWith('/verify'))) {
            if (/\/v1\/account\/project-rows\/(?:read|list)$/u.test(String(url))) {
                expect(options?.headers).toMatchObject({ Authorization: 'Bearer bob' });
            } else {
                expect(options?.headers).not.toHaveProperty('Authorization');
            }
        }
        await admitted.dispose();
        h.post.mockClear();
        const refused = ActionExecuteFailureSchema.parse(await inspect());
        expect(refused).toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
        expect(refused).not.toHaveProperty('effectiveDefinition');
        expect(h.post).not.toHaveBeenCalled();
        expect(h.spawned).toEqual([]);
    });

    it('keeps setup-effect consent distinct from an already-approved invocation and returns only reviewed data', async () => {
        const h = await harness({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } });
        const result = await h.invoke('projects.script.run', { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } });
        expect(result).toMatchObject({ operation: { operationId: 'operation' } });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation');
            return snapshot?.setupReview?.code ?? snapshot?.error?.errorCode ?? snapshot?.state;
        }).toBe('project_setup_consent_required');
        const preparing = h.operationRuntime.store.get(scope, 'operation');
        expect(preparing).toMatchObject({ state: 'accepted', progress: { kind: 'phase', phase: 'setup' },
            domainRef: { purpose: 'script', machineId: 'machine', workspaceRefId: 'accepted', cwd: h.root } });
        expect(preparing?.domainRef).not.toHaveProperty('terminalId');
        const reviewed = ProjectSetupConsentFailureDetailsV1Schema.parse(h.operationRuntime.store.get(scope, 'operation')!.setupReview);
        // This contract compares consent intent, not concurrent operation-id
        // allocation. Admit each original request before asserting its receipt.
        for (const [index, consentScope] of (['thisTime'] as const).entries()) {
            const pending = await h.invoke('projects.prepare', {
                workspace: h.address, phase: 'setup', expectedEffectDigest: reviewed.reviewedEffectDigest, consentScope,
            }, { ...h.context, transportRequestId: `prepare-${consentScope}` });
            const operationId = `operation-${index + 2}`;
            expect(pending).toMatchObject({ operation: { operationId } });
            await expect.poll(() => h.operationRuntime.store.get(scope, operationId)?.setupReview?.code).toBe('project_setup_consent_required');
            expect(h.operationRuntime.store.get(scope, operationId)).toMatchObject({ state: 'accepted', setupReview: {
                kind: 'pendingApproval', reviewedEffectDigest: reviewed.reviewedEffectDigest,
                consentScope,
            } });
        }
        expect(await h.rpcInvoke('projects.prepare', { workspace: h.address, phase: 'setup', consentScope: 'thisTime' }))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        // Remembered consent belongs to the approving app, never the native preparation RPC.
        expect(await createFiniteActionWithCapturedRequester(h.runtime, h.context)({ actionId: 'projects.prepare',
            input: { workspace: h.address, phase: 'setup', heldOperationId: 'operation',
                expectedEffectDigest: reviewed.reviewedEffectDigest, consentScope: 'untilChanged' },
            context: { authority: 'present_user', surface: 'ui', serverId: h.address.serverId } }))
            .toMatchObject({ ok: false, errorCode: 'project_setup_consent_invalid' });
        expect(await h.rpcInvoke('projects.prepare', { workspace: h.address, phase: 'setup', expectedEffectDigest: reviewed.reviewedEffectDigest,
            consentScope: 'forever' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await h.rpcInvoke('projects.prepare', { workspace: h.address, phase: 'setup', expectedEffectDigest: reviewed.reviewedEffectDigest,
            consentScope: 'thisTime', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(JSON.stringify(result)).not.toContain('requester'); expect(JSON.stringify(result)).not.toContain('successBasis');
        expect(h.spawned).toEqual([]);
        expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/project-trust/mutate'))).toEqual([]);
    });

    it('accepts a held This time or Skip decision from the verified present-user ingress', async () => {
        const h = await harness({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } });
        const scope = { accountId: 'owner', machineId: 'machine' };
        const held = ProjectCommandActionOutputV1Schema.parse(await h.invoke('projects.prepare', { workspace: h.address, phase: 'setup' }));
        await expect.poll(() => h.operationRuntime.store.get(scope, held.operation.operationId)?.setupReview?.code)
            .toBe('project_setup_consent_required');
        const reviewed = ProjectSetupConsentFailureDetailsV1Schema.parse(h.operationRuntime.store.get(scope, held.operation.operationId)!.setupReview);
        const decide = createFiniteActionWithCapturedRequester(h.runtime, { ...h.context, callerAuthority: 'present_user' });
        const result = await decide({ actionId: 'projects.prepare', input: {
            workspace: h.address, phase: 'setup', heldOperationId: held.operation.operationId,
            expectedEffectDigest: reviewed.reviewedEffectDigest, consentScope: 'thisTime',
        }, context: { ...h.context, authority: 'account_automation', surface: 'agent', actionRequestId: 'present-user-decision' } });
        expect(result, JSON.stringify(result)).toMatchObject({ operation: { state: 'accepted' } });
    });

    it('satisfies the held same-digest setup after This time completion without a second native setup and leaves a different digest held', async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const manifest = { version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } };
        const h = await harness(manifest, null, 'machine', token);
        const scope = { accountId: 'owner', machineId: 'machine' };
        const input = { workspace: h.address, phase: 'setup' };
        const held = ProjectCommandActionOutputV1Schema.parse(await h.invoke('projects.prepare', input));
        await expect.poll(() => h.operationRuntime.store.get(scope, held.operation.operationId)?.setupReview?.code)
            .toBe('project_setup_consent_required');
        const reviewed = ProjectSetupConsentFailureDetailsV1Schema.parse(h.operationRuntime.store.get(scope, held.operation.operationId)!.setupReview);
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ version: 1,
            workspace: { setup: [{ kind: 'command', command: 'echo different setup' }] } }));
        const different = ProjectCommandActionOutputV1Schema.parse(await h.invoke('projects.prepare', input,
            { ...h.context, transportRequestId: 'different-effect' }));
        await expect.poll(() => h.operationRuntime.store.get(scope, different.operation.operationId)?.setupReview?.code)
            .toBe('project_setup_consent_required');
        const differentReview = ProjectSetupConsentFailureDetailsV1Schema.parse(h.operationRuntime.store.get(scope, different.operation.operationId)!.setupReview);
        expect(differentReview.reviewedEffectDigest).not.toBe(reviewed.reviewedEffectDigest);
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify(manifest));
        // The authenticated user's invocation policy allows this RPC; only the
        // exact This time decision authorizes its setup effect, never Trust.
        h.waiveSetupApproval();
        try {
            const oneTime = ProjectCommandActionOutputV1Schema.parse(await h.rpcInvoke('projects.prepare', {
                ...input, expectedEffectDigest: reviewed.reviewedEffectDigest, consentScope: 'thisTime',
            }, { ...h.context, transportRequestId: 'this-time' }));
            await expect.poll(() => h.spawned.length).toBe(1);
            expect(h.operationRuntime.store.get(scope, held.operation.operationId)).toHaveProperty('setupReview');
            h.spawned[0]!.pty.exit(0);
            await expect.poll(() => h.operationRuntime.store.get(scope, oneTime.operation.operationId)?.state).toBe('succeeded');
            await expect.poll(() => h.operationRuntime.store.get(scope, held.operation.operationId)?.state).toBe('succeeded');
            const satisfied = ActionOperationSnapshotV1Schema.parse(h.operationRuntime.store.get(scope, held.operation.operationId));
            expect(satisfied).not.toHaveProperty('setupReview');
            expect(satisfied).toMatchObject({ result: { kind: 'success', reviewedEffectDigest: reviewed.reviewedEffectDigest } });
            expect(h.operationRuntime.store.get(scope, different.operation.operationId)).toMatchObject({ state: 'accepted', setupReview: differentReview });
            // Exact original replay can observe completion but cannot execute it again.
            expect(ProjectCommandActionOutputV1Schema.parse(await h.invoke('projects.prepare', input)).operation.state).toBe('succeeded');
            expect(h.spawned).toHaveLength(1);
            expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/project-trust/mutate'))).toEqual([]);
        } finally {
            await h.operationRuntime.runner.retireProjectFiniteOperations();
        }
    });

    it.each(['primary', 'workers'] as const)('consumes This time and Skip on the original one-slot %s reservation and actual target', async placement => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const manifest = { ...portableNativeManifest, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } };
        const h = await harness(manifest, 1, placement === 'workers' ? 'source-machine' : 'machine', token);
        const target = placement === 'workers' ? await h.addWorkerTarget() : h.workspaceRefs[0]!;
        const workspace = { serverId: target.serverId, workspaceId: target.id, machineId: target.machineId, rootPath: target.rootPath };
        const scope = { accountId: 'owner', machineId: 'machine' };
        const run = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: placement === 'workers' ? { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } : { kind: 'primary' } };
        h.continueCopy();
        try {
            expect(await h.rpcInvoke('projects.script.run', run)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.setupReview?.code).toBe('project_setup_consent_required');
            const reviewed = h.operationRuntime.store.get(scope, 'operation')!.setupReview!;
            // Waive invocation approval only on this human decision; the held Run's policy is unchanged.
            h.waiveSetupApproval();
            const decide = (heldOperationId: string, reviewedEffectDigest: string, skipForInvocation = false) => h.rpcInvoke('projects.prepare', {
                workspace, phase: 'setup', heldOperationId, expectedEffectDigest: reviewedEffectDigest,
                ...(skipForInvocation ? { skipForInvocation: true } : { consentScope: 'thisTime' }),
            }, { ...h.context, callerAuthority: 'present_user', transportRequestId: `decide-${heldOperationId}` });
            expect(await decide('operation', reviewed.reviewedEffectDigest)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => h.spawned.length).toBe(1);
            expect(h.spawned[0]!.params.options.cwd).toBe(target.rootPath);
            expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'operation', state: 'setup' }]);
            h.spawned[0]!.pty.exit(0);
            await expect.poll(() => h.spawned.length).toBe(2);
            expect(h.spawned[1]!.params.options.cwd).toBe(target.rootPath);
            h.spawned[1]!.pty.exit(0);
            expect(await h.operationRuntime.runner.waitForTerminal(scope, 'operation')).toMatchObject({ state: 'succeeded' });
            expect(h.operationRuntime.store.list(scope).items).toHaveLength(1);

            // A new digest holds again. Skip releases only this Run, with no target completion.
            await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...manifest,
                workspace: { setup: [{ kind: 'command', command: 'echo changed setup' }] } }));
            h.askSetupApproval();
            expect(await h.invoke('projects.script.run', run, { ...h.context, transportRequestId: 'skip-run' }))
                .toMatchObject({ operation: { operationId: 'operation-2' } });
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.setupReview?.code).toBe('project_setup_consent_required');
            const skippedReview = h.operationRuntime.store.get(scope, 'operation-2')!.setupReview!;
            h.waiveSetupApproval();
            expect(await decide('operation-2', skippedReview.reviewedEffectDigest, true)).toMatchObject({ operation: { operationId: 'operation-2' } });
            await expect.poll(() => h.spawned.length).toBe(3);
            expect(h.spawned[2]!.params.file).toBe('/managed/make');
            h.spawned[2]!.pty.exit(0);
            expect(await h.operationRuntime.runner.waitForTerminal(scope, 'operation-2')).toMatchObject({ state: 'succeeded' });
            const current = await reviewProjectSetupEffect({ workspace: target,
                projectAssociation: { workspace: target, project: { serverId: 'home', projectId: 'project' } },
                requester: { credentials: h.runtime.credentials, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl }, purpose: 'setup',
                platform: { os: 'linux', arch: 'x64' }, nativeIo: h.runtime.nativeIo, configEnvironment: h.runtime.configEnvironment });
            if (current.kind !== 'reviewed') throw new Error(current.code);
            expect(await createProjectSetupSuccessStore({ homeDir: h.runtime.successHomeDir! }).matches({ serverId: 'home',
                machineId: 'machine', workspaceRefId: target.id }, current.plan.successBasis)).toBe(false);
            expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/project-trust/mutate'))).toEqual([]);
        } finally { await h.operationRuntime.runner.retireProjectFiniteOperations(); }
    });

    it('keeps a changed retained digest held and refuses late decisions after cancellation or from automation', async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const manifest = { ...portableNativeManifest, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } };
        const h = await harness(manifest, 1, 'machine', token);
        const scope = { accountId: 'owner', machineId: 'machine' };
        try {
            await h.invoke('projects.script.run', { workspace: h.address, selection: { kind: 'named', name: 'checked' } });
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.setupReview?.code).toBe('project_setup_consent_required');
            const reviewed = h.operationRuntime.store.get(scope, 'operation')!.setupReview!;
            const decision = { workspace: h.address, phase: 'setup', heldOperationId: 'operation',
                expectedEffectDigest: reviewed.reviewedEffectDigest, consentScope: 'thisTime' };
            expect(await h.invoke('projects.prepare', decision, { ...h.context, transportRequestId: 'automation-decision' }))
                .toMatchObject({ ok: false, errorCode: 'project_setup_consent_invalid' });
            await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...manifest,
                workspace: { setup: [{ kind: 'command', command: 'echo changed setup' }] } }));
            h.waiveSetupApproval();
            expect(await h.rpcInvoke('projects.prepare', decision, { ...h.context, callerAuthority: 'present_user', transportRequestId: 'stale-decision' }))
                .toMatchObject({ operation: { operationId: 'operation', setupReview: { code: 'project_setup_effect_changed' } } });
            expect(h.spawned).toEqual([]);
            expect(h.operationRuntime.store.list(scope).items).toHaveLength(1);
            expect(h.operationRuntime.runner.cancel(scope, 'operation')).toEqual({ kind: 'requested' });
            expect(await h.operationRuntime.runner.waitForTerminal(scope, 'operation')).toMatchObject({ state: 'cancelled' });
            expect(await h.rpcInvoke('projects.prepare', { ...decision,
                expectedEffectDigest: h.operationRuntime.store.get(scope, 'operation')?.setupReview?.reviewedEffectDigest ?? reviewed.reviewedEffectDigest,
            }, { ...h.context, callerAuthority: 'present_user', transportRequestId: 'late-decision' })).toMatchObject({ ok: false, errorCode: 'project_setup_review_unavailable' });
            expect(h.spawned).toEqual([]);
            expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        } finally { await h.operationRuntime.runner.retireProjectFiniteOperations(); }
    });

    it('honours a setup policy waiver on the authenticated finite Run without granting remembered trust', async () => {
        const h = await harness({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } });
        h.waiveSetupApproval();
        const result = await h.rpcInvoke('projects.script.run', { workspace: h.address,
            selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } });
        expect(result).toMatchObject({ operation: { operationId: 'operation' } });
        await expect.poll(() => h.spawned.length).toBe(1);
        const scope = { accountId: 'owner', machineId: 'machine' };
        expect(h.operationRuntime.store.get(scope, 'operation')?.setupReview).toBeUndefined();
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.spawned.length).toBe(2);
        h.spawned[1]!.pty.exit(0);
        expect(await h.operationRuntime.runner.waitForTerminal(scope, 'operation')).toMatchObject({ state: 'succeeded' });
        expect(h.post.mock.calls.filter(([url]) => String(url).endsWith('/project-trust/mutate'))).toEqual([]);
    });

    it('refuses primary-only compute worker intent before launch and admits the primary with exact argv', async () => {
        const h = await harness();
        h.allowAdHoc();
        const input = { workspace: h.address, execution: 'primary', executable: '/managed/echo', argv: ['one argument'], cwd: h.root };
        expect(await h.invoke('projects.compute.exec', { ...input,
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker' } },
        })).toMatchObject({ ok: false, errorCode: 'primary_only' });
        expect(h.spawned).toHaveLength(0);
        expect(await h.invoke('projects.compute.exec', { ...input, choice: { kind: 'primary' } }))
            .toMatchObject({ operation: { domainRef: { purpose: 'exec' } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params).toMatchObject({ file: '/managed/echo', args: ['one argument'], options: { cwd: h.root } });
        h.spawned[0]!.pty.exit(0); await turn(); await turn();
    });

    it('uses the canonical opt-in policy for exact ad-hoc argv/cwd', async () => {
        const h = await harness();
        const input = { workspace: h.address, executable: '/managed/echo', argv: ['one argument', 'two'], cwd: h.root };
        expect(await h.invoke('projects.compute.exec', input)).toMatchObject({ ok: false, errorCode: 'ad_hoc_disabled' });
        h.allowAdHoc();
        expect(await h.invoke('projects.compute.exec', input)).toMatchObject({ operation: { domainRef: { purpose: 'exec' } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params).toMatchObject({ file: '/managed/echo', args: ['one argument', 'two'], options: { cwd: h.root } });
        h.spawned[0]!.pty.exit(0); await turn(); await turn();
    });

    it('revalidates the exact script after queued admission and refuses changed native bytes without a second launch', async () => {
        const h = await harness(undefined, 1);
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        await h.invoke('projects.script.run', input);
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(await h.invoke('projects.script.run', input, { ...h.context, transportRequestId: 'second' })).toMatchObject({ operation: { operationId: 'operation-2', state: 'accepted' } });
        expect(h.runtime.workerAdmission.dependencies({ workspaceRefId: 'accepted' })).toMatchObject([
            { operationId: 'operation', state: 'running' }, { operationId: 'operation-2', state: 'queued' },
        ]);
        await writeFile(join(h.root, 'Makefile'), 'check:\n\techo changed after approval\n');
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')).toMatchObject({ error: { errorCode: 'project_script_effect_changed' } });
        expect(h.spawned).toHaveLength(1);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('revalidates the in-root script a literal command runs after queued admission and refuses changed bytes without a second launch', async () => {
        const h = await harness({ version: 1, scripts: { checked: { source: { kind: 'command', command: 'sh ./check.sh' } } } }, 1);
        await writeFile(join(h.root, 'check.sh'), 'echo reviewed');
        const input = { workspace: h.address, selection: { kind: 'named', name: 'checked' } };
        await h.invoke('projects.script.run', input);
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(await h.invoke('projects.script.run', input, { ...h.context, transportRequestId: 'second' })).toMatchObject({ operation: { operationId: 'operation-2', state: 'accepted' } });
        await writeFile(join(h.root, 'check.sh'), 'echo changed after approval');
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')).toMatchObject({ error: { errorCode: 'project_script_effect_changed' } });
        expect(h.spawned).toHaveLength(1);
    });

    it('refuses detected native worker execution before accepting an operation, copying or spawning', async () => {
        const h = await harness(undefined, 1, 'source-machine');
        const target = await h.addWorkerTarget();
        try {
            const result = await h.rpcInvoke('projects.script.run', { workspace: h.address,
                selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } },
                choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
            });
            expect.soft(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'primary_only' });
            expect.soft(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toBeNull();
            expect.soft(h.runtime.workerAdmission.dependencies()).toEqual([]);
            expect.soft(await readFile(join(target.rootPath, '.happier/project.json'), 'utf8')).toBe('invalid before clean copy');
            expect.soft(h.spawned).toEqual([]);
        } finally {
            h.operationRuntime.runner.cancel({ accountId: 'owner', machineId: 'machine' }, 'operation');
            h.continueCopy();
            await turn();
            await turn();
        }
    });

    it.each(['missing', 'ordinary'] as const)('returns a typed no-acceptance refusal for a %s worker copy without choosing or creating a folder', async kind => {
        const h = await harness({ version: 1, scripts: { checked: { execution: 'portable', source: { kind: 'command', command: 'echo checked' } } } }, 1, 'source-machine');
        if (kind === 'ordinary') {
            await h.addWorkerTarget();
            delete h.relationships[0]!.provenance;
        }
        const result = await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } });
        expect(result).toMatchObject({ ok: false, errorCode: 'worker_copy_missing', details: {
            kind: 'no_worker_can_accept', reason: 'worker_copy_missing', workerCopy: {
                serverId: 'home', sourceWorkspaceRefId: 'accepted', sourceMachineId: 'source-machine', targetMachineId: 'machine',
            },
        } });
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toBeNull();
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
        expect(h.relationships).toHaveLength(kind === 'ordinary' ? 1 : 0);
        expect(h.workspaceRefs).toHaveLength(kind === 'ordinary' ? 2 : 1);
    });

    it.each(['command', 'native config', 'native executable', 'ordinary data', 'native ordinary data'] as const)('retains the accepted portable Script effect through worker copy while allowing fresh %s', async changed => {
        const native = changed === 'native config' || changed === 'native executable' || changed === 'native ordinary data';
        const localExecutable = changed === 'native executable' ? 'project-make' : changed === 'native ordinary data' ? 'a-project-make' : undefined;
        const manifest = { version: 1, scripts: { checked: { execution: 'portable',
            source: native
                ? { kind: 'native', tool: 'make', file: changed === 'native ordinary data' ? './Makefile' : 'Makefile', target: 'check' }
                : { kind: 'command', command: 'echo original' } } } };
        const h = await harness(manifest, 1, 'source-machine');
        const target = await h.addWorkerTarget();
        if (localExecutable) {
            await writeFile(join(h.root, localExecutable), 'original executable bytes');
            h.setToolRelativeExecutable(localExecutable);
        }
        await writeFile(join(h.root, 'input.txt'), 'original ordinary data');
        const input = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        const scope = { accountId: 'owner', machineId: 'machine' };
        try {
            expect(await h.rpcInvoke('projects.script.run', input)).toEqual(expect.objectContaining({
                operation: expect.objectContaining({ operationId: 'operation' }),
            }));
            h.continueCopy();
            await expect.poll(() => h.spawned.length).toBe(1);
            expect(h.spawned[0]!.params.args).toEqual(native
                ? ['-f', join(target.rootPath, 'Makefile'), 'check'] : ['-c', 'echo original']);
            if (localExecutable) expect(h.spawned[0]!.params.file).toBe(join(target.rootPath, localExecutable));
            h.holdCopy();
            expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: `accepted-worker-${changed}` }))
                .toMatchObject({ operation: { operationId: 'operation-2' } });
            await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation-2')?.state).toBe('queued');
            if (changed === 'command') {
                await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...manifest, scripts: { checked: {
                    ...manifest.scripts.checked, source: { kind: 'command', command: 'echo changed-after-acceptance' },
                } } }));
            } else if (changed === 'native config') await writeFile(join(h.root, 'Makefile'), 'check:\n\techo changed-after-acceptance\n');
            else if (changed === 'native executable') await writeFile(join(h.root, 'project-make'), 'changed executable bytes');
            else await writeFile(join(h.root, 'input.txt'), 'fresh ordinary data');
            h.spawned[0]!.pty.exit(0);
            h.continueCopy();
            await expect.poll(() => h.spawned.length === 2 || h.operationRuntime.store.get(scope, 'operation-2')?.state === 'failed').toBe(true);
            if (changed !== 'ordinary data' && changed !== 'native ordinary data') {
                expect(h.spawned).toHaveLength(1);
                expect(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({ state: 'failed', error: {
                    errorCode: 'project_script_effect_changed', details: { kind: 'pendingApproval', code: 'project_script_effect_changed',
                        reviewedEffectDigest: expect.any(String), reviewedEffect: expect.anything() },
                } });
                expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
            } else {
                expect(h.spawned).toHaveLength(2);
                expect(h.spawned[1]!.params.args).toEqual(native ? ['-f', join(target.rootPath, 'Makefile'), 'check'] : ['-c', 'echo original']);
                if (localExecutable) expect(h.spawned[1]!.params.file).toBe(join(target.rootPath, localExecutable));
                expect(await readFile(join(target.rootPath, 'input.txt'), 'utf8')).toBe('fresh ordinary data');
                h.spawned[1]!.pty.exit(0);
                await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('succeeded');
                expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
            }
        } finally {
            // The OS boundary must settle even when the unsafe extra launch is
            // the deciding RED, so the original reservation cannot leak.
            h.spawned[1]?.pty.exit(0);
            h.continueCopy();
        }
    });

    it('publishes observed copying after leaving the queue without claiming a process has launched', async () => {
        const h = await harness(portableNativeManifest, 1, 'source-machine');
        await h.addWorkerTarget();
        const input = { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        h.holdCopy();
        expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: 'queued-preparation' }))
            .toMatchObject({ operation: { operationId: 'operation-2' } });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation-2')?.state).toBe('queued');
        const queued = h.operationRuntime.store.get(scope, 'operation-2');
        expect(await h.operationRuntime.handlers.getV2({ operationId: 'operation-2' }, h.context)).toMatchObject({ kind: 'found', operation: {
            state: 'accepted', progress: { kind: 'phase', phase: 'queued', queueAhead: 0, label: expect.any(String) },
        } });
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation-2')?.state).toBe('copying');
        expect(h.spawned).toHaveLength(1);
        const preparing = h.operationRuntime.store.get(scope, 'operation-2');
        expect(preparing).toMatchObject({ state: 'accepted', progress: { kind: 'phase', phase: 'copying', label: expect.any(String) } });
        expect(preparing!.revision).toBeGreaterThan(queued!.revision);
        expect(preparing?.progress).not.toHaveProperty('current');
        expect(preparing?.progress).not.toHaveProperty('total');
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(2);
        h.spawned[1]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('succeeded');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('settles no-launch preparation on the same admitted operation without making a Session', async () => {
        const h = await harness();
        expect(await h.invoke('projects.prepare', { workspace: h.address, phase: 'setup' })).toMatchObject({ operation: { operationId: 'operation' } });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('succeeded');
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ result: { kind: 'notRequired', reviewedEffectDigest: expect.any(String) } });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it('keeps the exact execution environment basis when setup consent and Script effect are reviewed separately', async () => {
        const h = await harness({ version: 1, environmentVariables: [{ name: 'MODE', kind: 'config', required: true }] }, 1);
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        await h.invoke('projects.script.run', input);
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params.options.env).toMatchObject({ MODE: 'original' });
        await h.invoke('projects.script.run', input, { ...h.context, transportRequestId: 'second' });
        h.setConfigEnvironment('MODE', 'changed after admission');
        h.spawned[0]!.pty.exit(0);
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({ error: { errorCode: 'project_script_effect_changed' } });
        expect(h.spawned).toHaveLength(1);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('retains the original host baseline in the prepared finite launch when no explicit host snapshot is supplied', async () => {
        const environment = createEnvKeyScope(['HAPPIER_PROJECT_BASELINE']);
        environment.patch({ HAPPIER_PROJECT_BASELINE: 'captured-host-baseline' });
        try {
            const h = await harness({ version: 1,
                environmentVariables: [{ name: 'HAPPIER_PROJECT_BASELINE', kind: 'config', required: true }] });
            Object.assign(h.runtime, { hostEnvironment: undefined });
            await h.invoke('projects.script.run', { workspace: h.address,
                selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } });
            await expect.poll(() => h.spawned.length).toBe(1);
            expect(h.spawned[0]!.params.options.env?.HAPPIER_PROJECT_BASELINE).toBe('captured-host-baseline');
            h.spawned[0]!.pty.exit(0);
            await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state).toBe('succeeded');
        } finally { environment.restore(); }
    });

    it('keeps cancelled admission reserved until the actual process exit is observed', async () => {
        const h = await harness();
        await h.invoke('projects.script.run', { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        const scope = { accountId: 'owner', machineId: 'machine' };
        h.operationRuntime.runner.cancel(scope, 'operation');
        await turn();
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({
            state: 'running', progress: { kind: 'phase', phase: 'stopping', label: expect.any(String) },
        });
        expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'operation', state: 'running' }]);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('cancelled');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('refuses a changed project-local native executable after queued admission', async () => {
        const h = await harness(undefined, 1);
        const executable = join(h.root, 'project-make');
        await writeFile(executable, 'original executable bytes');
        h.setToolExecutable(executable);
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        await h.invoke('projects.script.run', input);
        await expect.poll(() => h.spawned.length).toBe(1);
        await h.invoke('projects.script.run', input, { ...h.context, transportRequestId: 'second' });
        await writeFile(executable, 'changed executable bytes');
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')).toMatchObject({ error: { errorCode: 'project_script_effect_changed' } });
        expect(h.spawned).toHaveLength(1);
    });

    it('returns a typed refusal rather than successful finite output when the Machine is not accepting', async () => {
        const h = await harness();
        h.refuseAdmission();
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } })).toMatchObject({ ok: false, errorCode: 'not_accepting' });
        expect(h.spawned).toEqual([]);
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state).toBe('failed');
    });

    it.each(['ask', 'primary', 'fail'] as const)('retains configured %s fallback on a receiving worker refusal without copying or launching', async unavailable => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        await h.addWorkerTarget();
        h.setWorkerUnavailable(unavailable);
        h.refuseAdmission();
        const result = await h.rpcInvoke('projects.script.run', { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } });
        expect.soft(result).toMatchObject({ ok: false, errorCode: 'not_accepting',
            details: { kind: 'no_worker_can_accept', unavailable, reason: 'not_accepting' } });
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation'))
            .toMatchObject({ state: 'failed', error: { errorCode: 'not_accepting',
                details: { kind: 'no_worker_can_accept', unavailable, reason: 'not_accepting' } } });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it('runs an unchanged named native Script after completed setup but refuses a setup digest as its Script precondition', async () => {
        const h = await harness({ version: 1,
            workspace: { setup: [{ kind: 'command', command: 'echo setup' }] },
            scripts: { checked: { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } },
        });
        h.waiveSetupApproval();
        const prepared = await h.invoke('projects.prepare', { workspace: h.address, phase: 'setup' });
        expect(prepared).toMatchObject({ operation: { operationId: 'operation' } });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.spawned.length).toBe(1);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('succeeded');
        const preparationResult = h.operationRuntime.store.get(scope, 'operation')!.result;
        if (!preparationResult || typeof preparationResult !== 'object' || !('reviewedEffectDigest' in preparationResult)) throw new Error('missing preparation review');
        h.askSetupApproval();
        const input = { workspace: h.address, selection: { kind: 'named', name: 'checked' } };
        expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: 'named-after-setup' }))
            .toMatchObject({ operation: { operationId: 'operation-2' } });
        await expect.poll(() => h.spawned.length).toBe(2);
        expect(h.spawned[1]!.params).toMatchObject({ file: '/managed/make', args: ['-f', join(h.root, 'Makefile'), 'check'] });
        h.spawned[1]!.pty.output(Buffer.from('checked\r\n'));
        h.spawned[1]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('succeeded');
        const output = await executeActionOperationActionV1({ actionId: 'projects.execution.output.read',
            input: { serverId: 'home', machineId: 'machine', operationId: 'operation-2', byteOffset: 0 },
            transport: async request => {
                if (request.method === 'actionOperation.get.v2') return h.operationRuntime.handlers.getV2(request.payload, h.context);
                if (request.method !== RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) throw new Error(request.method);
                const { TerminalStreamReadRequestSchema } = await import('@happier-dev/protocol/terminal/stream');
                return h.terminalSessions.readByteStream(TerminalStreamReadRequestSchema.parse(request.payload));
            } });
        const replay = TerminalStreamReadResponseSchema.parse(output);
        if (!replay.ok) throw new Error(replay.code);
        expect(Buffer.concat(replay.frames.flatMap(frame => frame.t === 'bytes' ? [decodeTerminalStreamBytesFrame(frame)] : []))
            .toString('utf8')).toBe('checked\r\n');
        expect(await h.rpcInvoke('projects.script.run', { ...input,
            expectedEffectDigest: preparationResult.reviewedEffectDigest }, { ...h.context, transportRequestId: 'wrong-setup-precondition' }))
            .toMatchObject({ operation: { operationId: 'operation-3' } });
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-3')?.state).toBe('failed');
        expect(h.operationRuntime.store.get(scope, 'operation-3')).toMatchObject({ error: {
            errorCode: 'project_script_effect_changed', details: { reviewedEffect: { purpose: 'script',
                setupEffect: preparationResult.reviewedEffectDigest, command: { source: { tool: 'make', target: 'check' } } } },
        } });
        expect(h.spawned).toHaveLength(2);
    });

    it('admits a finite reservation once, finishes after revocation, and refuses the next request', async () => {
        const h = await harness();
        const scope = { accountId: 'owner', machineId: 'machine' };
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        let current = true;
        const authorityPhases: string[] = [];
        const phase = () => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation')?.state ?? 'request';
        Object.assign(h.runtime, { isCurrent: async () => { authorityPhases.push(phase()); return current; } });
        const resolveTool = h.runtime.nativeIo.resolveTool;
        vi.spyOn(h.runtime.nativeIo, 'resolveTool').mockImplementation(async (tool, request) => {
            if (phase() === 'copying') current = false;
            return resolveTool(tool, request);
        });
        try {
            expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => h.spawned.length || h.operationRuntime.store.get(scope, 'operation')?.state === 'failed').toBeTruthy();
            expect(current).toBe(false);
            expect(h.spawned).toHaveLength(1);
            expect(authorityPhases).toEqual(['reserved']);
            console.info('Project finite admission phases', authorityPhases);
            h.spawned[0]!.pty.exit(0);
            expect(await h.operationRuntime.runner.waitForTerminal(scope, 'operation')).toMatchObject({ state: 'succeeded' });
            expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: 'revoked-next' }))
                .toMatchObject({ operation: { operationId: 'operation-2' } });
            expect(await h.operationRuntime.runner.waitForTerminal(scope, 'operation-2'))
                .toMatchObject({ state: 'failed', error: { errorCode: 'project_requester_credentials_unavailable' } });
        } finally {
            h.spawned.forEach(({ pty }) => pty.exit(0));
            h.operationRuntime.runner.cancel(scope, 'operation');
        }
    });

    it('refuses a queued invocation when its actual requester credential lifetime retires', async () => {
        const h = await harness(undefined, 1);
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        await h.invoke('projects.script.run', input);
        await expect.poll(() => h.spawned.length).toBe(1);
        await h.invoke('projects.script.run', input, { ...h.context, transportRequestId: 'second' });
        h.retireCredentials();
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation-2')).toMatchObject({ error: { errorCode: 'project_requester_credentials_unavailable' } });
        expect(h.spawned).toHaveLength(1);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('keeps installed worker callbacks inside the single finite admission after authority revocation', async () => {
        const homeId = 'srv_finite_installed';
        const installedToken = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const h = await harness(portableNativeManifest, null, 'source-machine', installedToken, 'home', homeId);
        const target = await h.addWorkerTarget();
        vi.spyOn(machineRpcTransport, 'callMachineRpc').mockResolvedValue({ statuses: observedSyncStatuses(h.relationships) });
        const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
        const home = await mkdtemp(join(tmpdir(), 'finite-installed-home-')); roots.push(home);
        environment.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'home' }); reloadConfiguration();
        await updateSettings(settings => ({ ...settings, activeServerId: 'home', servers: { home: {
            id: 'home', name: 'Home', serverUrl: 'https://home.example', webappUrl: 'https://home.example',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
                canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }),
        } } }));
        const phase = () => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation')?.state ?? 'request';
        let authorityCurrent = true;
        const authorityPhases: string[] = [], installedPhases: string[] = [];
        const credentials = h.runtime.credentials!;
        Object.assign(credentials, { credentialProvenance: 'stored_session' });
        const publication = ExternalActionMachineBootstrapV1Schema.parse({ id: 'source-machine', installationId: 'source-installation',
            kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null, managedMachineRef: null,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
        const sourceRow = MachinePublishedRowV1Schema.parse({ ...publication,
            metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'SOURCE', platform: 'linux',
                happyCliVersion: 'test', homeDir: h.root, happyHomeDir: join(h.root, '.happier') })), metadataVersion: 1,
            daemonState: null, daemonStateVersion: 0, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
        const sourceKeys = nacl.sign.keyPair();
        h.get.mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
            if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            const published = { ...sourceRow, installationPublicKey: Buffer.from(sourceKeys.publicKey).toString('base64') };
            if (String(url).endsWith('/v1/machines')) return { status: 200, data: [published] };
            if (String(url).endsWith('/v1/machines/source-machine')) return { status: 200, data: { machine: published } };
            if (String(url).endsWith('/v1/machines/machine')) return { status: 200, data: { machine: { ...published,
                id: 'machine', installationId: 'installation' } } };
            return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        const request = { workspace: h.address, selection: { kind: 'named' as const, name: 'checked' } };
        const requestId = 'installed-finite';
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId,
            input: request, target: { kind: 'machine', machineId: 'machine' } });
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'installed-finite-proof', binding: {
            accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: 'machine', installationId: 'installation',
            actionId: 'projects.script.run', requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            workspaceSyncAdmission: h.homeSourceAdmission(requestId, publication.installationId!),
            target: { kind: 'machine', machineId: 'machine' },
        } });
        const admitted = await admitRequesterAccountActionContext({ authorization, credentials, serverId: 'home', serverIdentityId: homeId,
            serverHttpBaseUrl: 'https://home.example', isCurrent: async () => authorityCurrent, isCustodyCurrent: h.runtime.isCurrent });
        if (!admitted) throw new Error('Requester custody not admitted');
        const keys = nacl.sign.keyPair();
        const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
            serverId: 'home', serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.example', target: authorization.binding.target,
            installationId: 'installation', privateKey: keys.secretKey, isCurrent: admitted.isCustodyCurrent });
        if (!carrier) throw new Error('Requester HTTP custody not admitted');
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, installationId: 'installation', createdAt: 1,
            publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const rowPost = h.post.getMockImplementation()!;
        const sourceAction = createProjectDefinitionAction({ serverId: 'home', machineId: 'source-machine', workingDirectory: h.root,
            accessPolicy: { kind: 'restrictedRoots', roots: [h.root] }, nativeIo: h.runtime.nativeIo });
        h.post.mockImplementation(async (url, body, options) => {
            if (!String(url).includes('/v1/actions/projects.inspect')) return rowPost(url, body, options);
            const packet = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(packet.envelope);
            if (String(url).endsWith(bindExternalActionExecutionAuthorizationHttpPathV1('projects.inspect'))) return { status: 200,
                data: { v: 1, token: 'source-proof', binding: { ...authorization.binding, workspaceSyncAdmission: undefined, machineId: 'source-machine', installationId: 'source-installation',
                    actionId: 'projects.inspect', requestId: envelope.requestId, target: envelope.target,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } } };
            const result = await sourceAction({ actionId: 'projects.inspect', input: envelope.input, context: { serverId: 'home' } });
            return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect', requestId: envelope.requestId,
                execution: { ok: true, result } }) };
        });
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            expect(config.headers).toMatchObject({ 'x-happier-action-execution-authorization': authorization.token });
            if (config.url === 'https://home.example/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            expect(config.url).toBe(`https://home.example${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`);
            expect(config.data).toEqual({ address: { serverId: homeId, refId: h.address.workspaceId } });
            const preference = await h.workspaceExecutionConfig.get({ workspace: { serverId: homeId, refId: h.address.workspaceId } });
            if (preference.status !== 'ready') throw new Error('Fixture preference unavailable');
            return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { ...preference.preference, services: {} } } } };
        });
        const ingress: RpcHandlerContext = { ...h.context, originalActionEnvelope: envelope, callerInputAuthorization: carrier, verifyMachineAdmissionCurrent: async () => {
            authorityPhases.push(phase()); return admitted.isCurrent();
        } };
        const factory = createInstalledProjectFiniteRuntime({ api: await ApiClient.create(credentials), credentials,
            externalActionAccountId: 'owner', finiteServerId: 'home', finiteServerHttpBaseUrl: 'https://home.example', registeredMachineId: 'machine',
            admission: h.runtime.workerAdmission, nativeIo: { commandIo: h.runtime.nativeIo, environmentIo: h.runtime.environmentIo },
            agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) }, successHomeDir: join(h.root, 'success'),
            isCurrent: async () => { installedPhases.push(phase()); return h.runtime.isCurrent!(); },
            prepareBetween: async () => { await cp(h.root, target.rootPath, { recursive: true }); authorityCurrent = false;
                return { ok: true, traversed: [] }; },
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }) });
        try {
            const runtime = await factory({ operationRuntime: h.operationRuntime, terminalSessions: h.terminalSessions }, ingress);
            if (!runtime) throw new Error('Installed finite runtime unavailable');
            const action = createFiniteActionWithCapturedRequester(runtime, ingress);
            const accepted = await action({ actionId: 'projects.script.run', input: request, context: { serverId: 'home', bypassApprovals: true } });
            expect(accepted, JSON.stringify({ accepted, reads: h.get.mock.calls.map(([url]) => String(url)),
                writes: h.post.mock.calls.map(([url]) => String(url)) }))
                .toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => h.spawned.length || h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state === 'failed').toBeTruthy();
            expect(h.spawned, JSON.stringify(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation'))).toHaveLength(1);
            expect(authorityCurrent).toBe(false);
            expect(authorityPhases).toEqual(['reserved']);
            expect(installedPhases.filter(value => value !== 'request' && value !== 'reserved')).toEqual([]);
            h.spawned[0]!.pty.exit(0);
            expect(await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation')).toMatchObject({ state: 'succeeded' });
        } finally { h.spawned.forEach(({ pty }) => pty.exit(0)); await admitted.dispose(); environment.restore(); reloadConfiguration(); }
    });

    it('does not infer configured Script invocation approval from raw Home-stamped Machine access', async () => {
        const h = await harness();
        h.requireInvocationApproval();
        const result = await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } });
        expect(result).toMatchObject({ ok: false });
        expect(h.spawned).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.operationRuntime.store.list({ accountId: 'owner', machineId: 'machine' }).items).toEqual([]);
    });

    it.each([
        { exitCode: 0, transport: 'local', stop: false }, { exitCode: 7, transport: 'local', stop: false },
        { exitCode: 0, transport: 'remote', stop: false }, { exitCode: 7, transport: 'remote', stop: false },
        { exitCode: 0, transport: 'remote', stop: true },
    ] as const)('runs $transport Sync-copy cleanup in its original retirement operation before removing bytes (exit $exitCode, stop $stop)', async ({ exitCode, transport, stop }) => {
        const h = await harness({ version: 1, workspace: { teardown: [{ kind: 'command', command: 'true' }] } });
        const plugin = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
        releaseRequesterContexts.push(() => plugin.dispose());
        const facts: HostEventEnvelopeV1[] = [];
        const subscription = plugin.registry.stableEventsBroker!.subscribeHost({
            target: { eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } },
            isCurrent: () => true, listener: event => { facts.push(event); },
        });
        releaseRequesterContexts.push(async () => { await subscription.dispose(); });
        h.waiveSetupApproval();
        const stateRoot = await mkdtemp(join(tmpdir(), 'project-sync-removal-'));
        roots.push(stateRoot);
        const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(stateRoot, 'locks') });
        const copyRelationshipId = 'cleanup-copy';
        const workerCopyCreation = { serverId: 'home', relationshipId: copyRelationshipId,
            sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'accepted' };
        const materialization = await beginWorkspaceTargetMaterialization({ targetPath: h.root,
            backupDirectoryPrefix: '.happier-sync-backup',
            receiptPath: workspaceSyncMaterializationReceiptPath(stateRoot, copyRelationshipId, 'beta'),
            targetFence: { state: 'nonempty', identity: await readWorkspaceSyncRootObjectIdentity(h.root), workerCopyCreation } });
        if (!materialization.previousTargetPath) throw new Error('Expected the real materialization source');
        await cp(materialization.previousTargetPath, h.root, { recursive: true });
        await materialization.custody.bindPromotedTarget();
        await materialization.custody.commit();
        const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const expectedRelationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: copyRelationshipId,
            controllerMachineId: 'machine', alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'accepted',
            mode: 'keep_synced', enabled: true, createdAtMs: 1, updatedAtMs: 1,
            contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
            provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'accepted' } };
        const authority = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: 'machine',
            getProjectSnapshot: () => ({ source: 'network', scopeKey: 'owner', graphRevision: 1, loadedAtMs: 1,
                rows: [], organizations: [], relationships: [], workspaceRefs: [...h.workspaceRefs,
                    { id: 'source', serverId: 'home', machineId: 'source-machine', rootPath: '/source', createdAtMs: 1 }] }),
            callMachineRpc: async () => { throw new Error('No remote Machine is part of this local-copy journey'); },
            // Home approval and OS process exit are the external boundaries.
            assertCommittedCopyRemovalAuthorized: async () => {}, readCommittedCopyDependencies: async () => [],
            resolveProjectRuntime: async ingress => ({ ...h.runtime, requesterIdentity: selectHostRequesterExecutionIdentity({
                rpcContext: ingress, hostHomeServerIdentityId: 'home' }) }),
            bootstrap: { rootOwnershipManager, materializationDirectory: stateRoot } });
        const actionInput = { workspace: { serverId: 'home', refId: 'source' }, machineId: 'machine', expectedRelationship,
            removeTargetCopy: { workspaceRefId: 'accepted', rootFingerprint: await computeWorkspaceSyncRootFingerprint(h.root) } };
        const pending = h.operationRuntime.observeExecution({ actionId: 'projects.worker.copy.retire', input: actionInput,
            actionRequestId: 'retire-copy', execute: async operation => {
                const source = createWorkspaceSyncSourceOperationContinuation(operation);
                let target: SocketRpcContinuationHandler = async () => null;
                // The network is the boundary. Both original-operation and target
                // continuation owners execute unchanged across asynchronous delivery.
                const callSource: SocketRpcContinuationCall = async value => source(value, callTarget);
                const callTarget: SocketRpcContinuationCall = async value => target(value, callSource);
                const targetController = new AbortController();
                operation.signal.addEventListener('abort', () => targetController.abort(), { once: true });
                const targetOperation = transport === 'remote'
                    ? await openWorkspaceSyncTargetOperationContinuation({ call: callSource,
                        notify: async value => { await callSource(value); } }, targetController.signal,
                        handler => { target = handler; }, () => targetController.abort()) : operation;
                try {
                    await authority.removeCommittedCopyHere({ actionReceiptId: 'retire-copy', actionInput }, {
                        ...h.context, signal: operation.signal,
                        localActionContext: { ...targetOperation, surface: 'rpc', authority: 'present_user',
                            actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {},
                                approvalWaivedSurfaces: { 'projects.prepare': ['rpc'] } }) } });
                } finally {
                    if ('flushOperationUpdates' in targetOperation) await targetOperation.flushOperationUpdates();
                    source.dispose?.();
                }
                return { ok: true, result: { status: 'retired' } };
            } });
        let completed: unknown;
        void pending.then(result => { completed = result; }, error => { completed = error; });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.setupReview?.code)
            .toBe('project_setup_consent_required');
        expect(completed).toBeUndefined();
        expect(h.spawned).toEqual([]);
        await expect(access(join(h.root, '.happier/project.json'))).resolves.toBeUndefined();
        expect(facts).toEqual([]);
        if (stop) {
            expect(await h.operationRuntime.handlers.cancel({ operationId: 'operation' })).toEqual({ kind: 'requested' });
            await pending.catch(() => undefined);
            expect(await h.operationRuntime.runner.waitForTerminal(scope, 'operation')).toMatchObject({ state: 'cancelled' });
            expect(await readFile(join(h.root, '.happier/project.json'), 'utf8')).toContain('teardown');
            expect(facts).toEqual([]);
            expect(h.spawned).toEqual([]);
            expect(h.operationRuntime.store.list(scope).items).toHaveLength(1);
            await authority.releaseAllRetainedBootstraps();
            return;
        }
        await h.rememberSetup(h.operationRuntime.store.get(scope, 'operation')!.setupReview!.reviewedEffectDigest);
        await h.operationRuntime.handlers.getV2({ operationId: 'operation' });
        await expect.poll(() => h.spawned.length).toBe(1);
        await expect(access(join(h.root, '.happier/project.json'))).resolves.toBeUndefined();
        h.spawned[0]!.pty.exit(exitCode);
        if (exitCode === 0) {
            expect(await pending).toMatchObject({ ok: true });
            await expect.poll(() => facts.length).toBe(1);
            expect(facts[0]).toMatchObject({ payload: { kind: 'worktreeRemoved', removal: {
                operationId: 'operation', workspace: h.address, project: { serverId: 'home', projectId: 'project' },
                outcome: 'removed', removalKind: 'deleted',
            } } });
        } else {
            await expect(pending).rejects.toMatchObject({ rpcErrorCode: 'project_setup_step_failed', details: {
                kind: 'finiteCommand', phase: 'teardown', step: 0, exitCode: 7, signal: null,
            } });
            expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ state: 'failed',
                error: { errorCode: 'project_setup_step_failed' } });
            expect(facts).toEqual([]);
        }
        if (exitCode === 0) await expect(access(h.root)).rejects.toMatchObject({ code: 'ENOENT' });
        else await expect(access(join(h.root, '.happier/project.json'))).resolves.toBeUndefined();
        expect(h.operationRuntime.store.list({ accountId: 'owner', machineId: 'machine' }).items).toHaveLength(1);
        await authority.releaseAllRetainedBootstraps();
    });

    it.each([false, true])('automatically removes a PR worktree and reports skipped untrusted teardown (associated=%s)', async associated => {
        const h = await harness({ version: 1, workspace: { teardown: [{ kind: 'command', command: 'echo cleanup' }] } });
        const plugin = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
        releaseRequesterContexts.push(() => plugin.dispose());
        runScmExecutable(h.root, 'git', ['init', '--quiet']);
        runScmExecutable(h.root, 'git', ['config', 'user.name', 'Project test']);
        runScmExecutable(h.root, 'git', ['config', 'user.email', 'project@example.test']);
        runScmExecutable(h.root, 'git', ['add', '.happier/project.json']);
        runScmExecutable(h.root, 'git', ['commit', '--quiet', '-m', 'Project teardown']);
        const worktreePath = join(h.root, 'temporary-pr');
        runScmExecutable(h.root, 'git', ['worktree', 'add', '--quiet', '-b', 'temporary-pr', worktreePath]);
        if (associated) h.workspaceRefs.push({ ...h.workspaceRefs[0]!, id: 'temporary-pr', rootPath: worktreePath });
        const request = { cwd: h.root, worktreePath, confirmed: true,
            authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN };
        const scope = { accountId: 'owner', machineId: 'machine' };
        try {
            expect(await h.operationRuntime.observeExecution({ actionId: 'scm.worktree.remove', input: request,
                actionRequestId: 'automatic-pr-cleanup', response: 'admission', execute: async operation => {
                    const host = createAdmittedCheckoutRepositoryFiles({ root: h.root,
                        context: { ...operation, authority: 'present_user', surface: 'rpc', serverId: 'home' },
                        registry: createDeploymentGitRegistry(), resolveRemovalRuntime: async () => ({
                            runtime: { ...h.runtime, requesterIdentity: selectHostRequesterExecutionIdentity({
                                rpcContext: h.context, hostHomeServerIdentityId: 'home' }) }, ingress: h.context,
                        }) });
                    const removed = await host.executeScm('scm.worktree.remove', request);
                    expect(removed).toMatchObject({ success: true });
                    return { ok: true, result: {} };
                } })).toMatchObject({ ok: true });
            if (associated) {
                await expect.poll(() => {
                    const snapshot = h.operationRuntime.store.get(scope, 'operation');
                    return snapshot?.setupReview !== undefined || snapshot?.state === 'succeeded' || snapshot?.state === 'failed';
                }).toBe(true);
            } else await h.operationRuntime.runner.waitForTerminal(scope, 'operation');
            expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ state: 'succeeded',
                ...(associated ? { progress: { kind: 'phase', phase: 'teardown.skipped' } } : {}) });
            expect(h.operationRuntime.store.get(scope, 'operation')?.setupReview).toBeUndefined();
            expect(h.spawned).toEqual([]);
            expect(h.post.mock.calls.some(([url]) => String(url).endsWith('/project-trust/mutate'))).toBe(false);
            await expect(access(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(access(join(h.root, '.happier/project.json'))).resolves.toBeUndefined();
        } finally {
            h.operationRuntime.runner.cancel(scope, 'operation');
            await h.operationRuntime.runner.waitForTerminal(scope, 'operation');
        }
    });

    it('preserves the accepted projectless Workspace in the settled removal fact', async () => {
        const h = await harness({ version: 1, workspace: { teardown: [{ kind: 'command', command: 'true' }] } });
        delete h.workspaceRefs[0]!.projectKey;
        const plugin = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
        releaseRequesterContexts.push(() => plugin.dispose());
        const facts: HostEventEnvelopeV1[] = [];
        const subscription = plugin.registry.stableEventsBroker!.subscribeHost({
            target: { eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } },
            isCurrent: () => true, listener: event => { facts.push(event); },
        });
        releaseRequesterContexts.push(async () => { await subscription.dispose(); });
        await access(h.root);
        const accepted = await h.operationRuntime.observeExecution({ actionId: 'scm.worktree.remove',
            input: { cwd: h.root, worktreePath: h.root, confirmed: true }, actionRequestId: 'remove-projectless',
            execute: async operation => {
                const removal = await prepareProjectCheckoutRemoval({ runtime: { ...h.runtime,
                    requesterIdentity: selectHostRequesterExecutionIdentity({ rpcContext: h.context, hostHomeServerIdentityId: 'home' }) },
                    ingress: h.context, operation, worktreePath: h.root,
                    context: { authority: 'present_user', surface: 'rpc', serverId: 'home' } });
                await rm(h.root, { recursive: true });
                removal.settle('deleted');
                return { ok: true, result: {} };
            } });
        expect(accepted).toMatchObject({ ok: true });
        expect(h.spawned).toEqual([]);
        await expect(access(h.root)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect.poll(() => facts.length).toBe(1);
        expect(facts[0]).toMatchObject({ payload: { kind: 'worktreeRemoved', removal: {
            workspace: { workspaceId: 'accepted', rootPath: h.root }, project: null,
            operationId: 'operation', outcome: 'removed', removalKind: 'deleted',
        } } });
    });

    it('retains the second teardown failure and original redacted review on the removal operation', async () => {
        const h = await harness({ version: 1, environmentVariables: [{ name: 'PRIVATE_URL', kind: 'config', required: true }],
            workspace: { teardown: [{ kind: 'command', command: 'echo first' }, { kind: 'command', command: 'echo second' }] } });
        await writeFile(join(h.root, '.env'), 'PRIVATE_URL=private-cleanup-sentinel\n');
        const plugin = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
        releaseRequesterContexts.push(() => plugin.dispose());
        let receiverFailure: unknown;
        const scope = { accountId: 'owner', machineId: 'machine' };
        const accepted = h.operationRuntime.observeExecution({ actionId: 'scm.worktree.remove',
            input: { cwd: h.root, worktreePath: h.root, confirmed: true }, actionRequestId: 'remove', response: 'admission',
            execute: async operation => {
                try {
                    await prepareProjectCheckoutRemoval({ runtime: { ...h.runtime,
                        requesterIdentity: selectHostRequesterExecutionIdentity({ rpcContext: h.context, hostHomeServerIdentityId: 'home' }) },
                        ingress: h.context, operation, worktreePath: h.root,
                        context: { authority: 'present_user', surface: 'rpc', serverId: 'home' } });
                    return { ok: true, result: {} };
                } catch (error) {
                    receiverFailure = normalizeActionExecutorThrownError(error);
                    throw error;
                }
            } });
        expect(await accepted).toMatchObject({ ok: true });
        await expect.poll(() => {
            const operation = h.operationRuntime.store.get(scope, 'operation');
            return { code: operation?.setupReview?.code, state: operation?.state, error: operation?.error };
        }).toEqual({ code: 'project_setup_consent_required', state: 'running', error: undefined });
        const reviewed = h.operationRuntime.store.get(scope, 'operation')!.setupReview!;
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ actionId: 'scm.worktree.remove',
            setupReview: { reviewedEffectDigest: expect.any(String), reviewedEffect: expect.anything() } });
        expect(JSON.stringify(reviewed)).not.toContain('private-cleanup-sentinel');
        expect(h.spawned).toEqual([]);
        await h.rememberSetup(reviewed.reviewedEffectDigest);
        await h.operationRuntime.handlers.getV2({ operationId: 'operation' });
        await expect.poll(() => h.spawned.length).toBe(1);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.spawned.length).toBe(2);
        expect(h.spawned[1]!.params.options.env?.PRIVATE_URL).toBe('private-cleanup-sentinel');
        h.spawned[1]!.pty.exit(7);
        await h.operationRuntime.runner.waitForTerminal(scope, 'operation');
        expect(receiverFailure).toMatchObject({ errorCode: 'project_setup_step_failed',
            details: { kind: 'finiteCommand', phase: 'teardown', step: 1, exitCode: 7, signal: null } });
        const failed = h.operationRuntime.store.get(scope, 'operation');
        expect(failed?.error?.errorCode).toBe('project_setup_step_failed');
        expect(failed?.error?.details).toEqual({ kind: 'finiteCommand', phase: 'teardown', step: 1, exitCode: 7, signal: null });
        expect(failed?.state).toBe('failed');
        expect(JSON.stringify(failed)).not.toContain('private-cleanup-sentinel');
        expect(h.operationRuntime.store.list(scope).items).toHaveLength(1);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it.each(['projects.script.run', 'session.spawn_new'] as const)('reuses only the exact finite operation owner, not an outer %s operation', async outerActionId => {
        const h = await harness();
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        const accepted = await h.operationRuntime.observeExecution({ actionId: outerActionId, input: outerActionId === 'projects.script.run' ? input : { creationKey: 'outer' },
            actionRequestId: 'outer', execute: async operation => {
                const nested = await h.invoke('projects.script.run', input, { ...h.context, localActionContext: {
                    actionRequestId: operation.actionRequestId, operationAcceptance: operation.operationAcceptance,
                    operationOwnerUpdate: operation.operationOwnerUpdate, operationProgress: operation.operationProgress,
                } });
                const failed = ActionExecuteFailureSchema.safeParse(nested);
                return failed.success ? failed.data : { ok: true, result: nested };
            } });
        const expectedId = outerActionId === 'projects.script.run' ? 'operation' : 'operation-2';
        expect(accepted).toMatchObject({ ok: true, result: { operation: { actionId: 'projects.script.run', operationId: expectedId } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        const scope = { accountId: 'owner', machineId: 'machine' };
        expect(h.operationRuntime.store.list(scope).items).toHaveLength(outerActionId === 'projects.script.run' ? 1 : 2);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get(scope, expectedId)?.state).toBe('succeeded');
    });

    it.each(['run', 'cancelled'] as const)('reads Script placement preferences while SOURCE tool inspection is pending (%s)', async scenario => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        await h.addWorkerTarget();
        const preferenceHttp = h.installPreferenceReadHttpBoundary();
        Object.assign(h.runtime, { resolveWorkspaceExecutionConfig: async (context: Parameters<ProjectFiniteActionRuntime['resolveWorkspaceExecutionConfig']>[0]) =>
            createAccountServerWorkspaceWorkerPreferenceClient({ token: 'requester', credentials: h.runtime.credentials,
                serverHttpBaseUrl: h.runtime.serverHttpBaseUrl, context, actionId: 'projects.script.run',
                resolveRequestHeaders: () => ({ Authorization: 'Bearer requester' }) }) });
        const resolveTool = h.runtime.nativeIo.resolveTool;
        let inspectionStarted = false;
        let releaseInspection!: () => void;
        const heldInspection = new Promise<void>(resolve => { releaseInspection = resolve; });
        const nativeIo: ProjectFiniteActionRuntime['nativeIo'] = { ...h.runtime.nativeIo, resolveTool: async (tool, input) => {
            if (input.cwd === h.root) { inspectionStarted = true; await heldInspection; }
            return resolveTool(tool, input);
        } };
        Object.assign(h.runtime, { nativeIo });
        const transport = new AbortController();
        const pending = h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } }, { ...h.context, signal: transport.signal });
        try {
            await vi.waitFor(() => expect(inspectionStarted).toBe(true));
            // Two necessary passive Home reads share one wave; neither may
            // accept work or begin copying while SOURCE facts are outstanding.
            await vi.waitFor(() => expect(preferenceHttp.mock.calls.filter(([config]) =>
                config.url === `https://home.example${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`)).toHaveLength(1));
            expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
            expect(h.spawned).toEqual([]);
        } finally {
            if (scenario === 'cancelled') transport.abort();
            releaseInspection();
        }
        const result = await pending;
        if (scenario === 'cancelled') {
            expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ ok: false });
            expect(h.spawned).toEqual([]);
            expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        } else {
            expect(result).toMatchObject({ operation: { operationId: 'operation' } });
            h.continueCopy();
            await h.firstSpawn;
            h.spawned[0]!.pty.exit(0);
            await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
        }
    });

    it('admits the immutable remote SOURCE before clean-copy and reviews only the copied worker target bytes', async () => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        const target = await h.addWorkerTarget();
        expect(await h.workspaceExecutionConfig.get({ workspace: { serverId: 'home', refId: h.address.workspaceId } }))
            .toMatchObject({ status: 'ready', preference: { enabled: true, destination: { kind: 'machine', machineId: 'machine' } } });
        const sourceInput = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        expect(await h.rpcInvoke('projects.script.run', sourceInput)).toMatchObject({ operation: { operationId: 'operation', domainRef: { workspaceRefId: target.id } } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies({ workspaceRefId: h.address.workspaceId, relationshipId: 'source-worker' })[0]?.state).toBe('copying');
        const copying = h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation');
        expect.soft(copying).toMatchObject({ state: 'accepted', progress: { kind: 'phase', phase: 'copying' },
            domainRef: { purpose: 'script', machineId: 'machine', workspaceRefId: target.id, cwd: target.rootPath,
                sourceWorkspace: h.address, script: { name: 'checked' } } });
        expect(copying?.domainRef).not.toHaveProperty('terminalId');
        expect(h.spawned).toEqual([]);
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params).toMatchObject({ args: ['-f', join(target.rootPath, 'Makefile'), 'check'], options: { cwd: target.rootPath } });
        expect(sourceInput.workspace.machineId).toBe('source-machine');
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(await h.rpcInvoke('projects.script.run', { ...sourceInput, choice: { kind: 'primary' } }, { ...h.context, transportRequestId: 'remote-primary' }))
            .toMatchObject({ ok: false, errorCode: 'target_not_local' });
        expect(h.spawned).toHaveLength(1);
    });

    it.each(['explicit', 'workspace', 'withdrawn_after_copy'] as const)
    ('admits only the current authorized pool member at the addressed receiving Machine (%s)', async scenario => {
        // The Home authentication boundary supplies the current issued-token
        // provenance and epoch consumed by original Account Action delivery.
        const token = scenario === 'workspace' ? `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature` : 'requester';
        const h = await harness({ version: 1, scripts: { checked: { execution: 'portable',
            source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } }, null, 'source-machine', token);
        const target = await h.addWorkerTarget();
        const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
        h.setWorkerPool(poolId);
        // Pool label opening reads the Account's current storage contract over Home HTTP.
        h.get.mockImplementation(async url => ({ status: 200, data: String(url).endsWith('/v1/account/encryption/currentness')
            ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
            : { mode: 'plain', updatedAt: 1 } }));
        let members: MachinePoolPrivateViewV1['pool']['members'] = [
            ...(scenario === 'workspace' ? [] : [{ machineId: 'another-machine', priorityTier: 0, enabled: true, state: 'connected' as const }]),
            { machineId: 'machine', priorityTier: 1, enabled: true, state: 'connected' },
        ];
        // Home HTTP is the genuine pool boundary; the Action parser/transport and receiving membership check stay real.
        vi.spyOn(axios, 'request').mockImplementation(async config => {
            if (config.headers?.Authorization) expect(config.headers).toMatchObject({ Authorization: `Bearer ${token}` });
            else expect(config.headers).toMatchObject({ 'x-happier-action-execution-authorization': 'home-issued-finite-authorization' });
            if (config.url === 'https://home.example/v1/account/encryption') {
                return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            }
            if (scenario === 'workspace' && config.url === `https://home.example${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) {
                expect(config.data).toEqual({ address: { serverId: 'home', refId: h.address.workspaceId } });
                const preference = await h.workspaceExecutionConfig.get({ workspace: { serverId: 'home', refId: h.address.workspaceId } });
                if (preference.status !== 'ready') throw new Error('Fixture workspace preference unavailable');
                return { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { ...preference.preference, services: {} } } } };
            }
            expect(config.url).toBe('https://home.example/v1/machines/pools/get');
            expect(config.method).toBe('POST');
            expect(config.data).toEqual({ poolId });
            // Home returns recipient projections; the canonical Action opens them before receiving admission.
            const view: MachinePoolPrivateViewV1 = { pool: { id: poolId, name: { kind: 'available', label: { content: { t: 'plain', v: 'Workers' }, recipientEnvelope: null } }, description: null, revision: 1, createdAt: 1, updatedAt: 1, members },
                availability: { state: 'known', connectedCount: members.filter(member => member.enabled && member.state === 'connected').length,
                    enabledCount: members.filter(member => member.enabled).length } };
            return { status: 200, data: view };
        });
        const input = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            ...(scenario === 'workspace' ? {} : { choice: { kind: 'workers', destination: { kind: 'pool', poolId, selection: 'automatic' } } }) };
        let result: unknown;
        if (scenario === 'workspace') {
            const serverIdentityId = h.address.serverId;
            const installation = h.receivingInstallation;
            const installed = ExternalActionMachineBootstrapV1Schema.parse({ id: 'machine', installationId: 'installation',
                active: true, revokedAt: null, replacedByMachineId: null, kind: 'persistent', managedMachineRef: null,
                access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            });
            const sourcePublished = ExternalActionMachineBootstrapV1Schema.parse({ ...installed, id: 'source-machine', installationId: 'source-installation' });
            const machineRows = [installed, sourcePublished]
                .map(machine => MachinePublishedRowV1Schema.parse({ ...machine,
                    metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
                        host: machine.id, platform: process.platform, happyCliVersion: 'test',
                        homeDir: h.root, happyHomeDir: join(h.root, '.happier'),
                    })), metadataVersion: 0,
                    daemonState: null, daemonStateVersion: 0, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER }));
            h.get.mockImplementation(async url => {
                if (String(url) === 'https://home.example/v1/machines') return { status: 200, data: machineRows };
                const machine = machineRows.find(row => String(url) === `https://home.example/v1/machines/${row.id}`);
                if (machine) return { status: 200, data: { machine: { ...machine,
                    installationPublicKey: Buffer.from(installation.publicKey).toString('base64') } } };
                if (String(url) === 'https://home.example/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                if (String(url) === 'https://home.example/v1/account/profile') return { status: 200, data: { id: 'owner' } };
                if (String(url) === 'https://home.example/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
                if (String(url) === 'https://home.example/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                throw new Error(`Unexpected pool Home read: ${url}`);
            });
            const homePost = h.post.getMockImplementation();
            if (!homePost) throw new Error('Expected existing Home HTTP fixture');
            h.post.mockImplementation(async (url, body, config) => {
                if (String(url) === 'https://home.example/v1/actions/projects.worker.status') {
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
                    expect(request.executionAuthorization?.binding).toMatchObject({ serverIdentityId,
                        machineId: installed.id, installationId: installed.installationId, actionId: 'projects.worker.status',
                        requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                        target: envelope.target });
                    const result = await worker({ actionId: 'projects.worker.status', input: ProjectWorkerStatusInputV1Schema.parse(envelope.input),
                        context: { surface: 'rpc', serverId: 'home', runtimeAccountId: 'owner', authority: 'account_automation' } });
                    return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.worker.status',
                        requestId: envelope.requestId, execution: { ok: true, result } }) };
                }
                // Original worker observations need the same Home Machine admission
                // as inspection and finite execution, including on an own Machine.
                const authorizationAction = (['projects.inspect', 'projects.script.run', 'projects.worker.status'] as const)
                    .find(actionId => String(url) === `https://home.example${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`);
                if (authorizationAction) {
                    expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                    const requestId = request.envelope.requestId;
                    if (!requestId) throw new Error('Expected a bound pool requester ID');
                    const targetMachine = authorizationAction === 'projects.inspect' ? sourcePublished : installed;
                    expect(request.machineId).toBe(targetMachine.id);
                    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-finite-authorization',
                        binding: { accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId,
                            machineId: targetMachine.id, custodianAccountId: 'owner', installationId: targetMachine.installationId,
                            accountEncryptionMode: 'plain', actionId: authorizationAction, requestId,
                            ...(authorizationAction === 'projects.script.run' ? { workspaceSyncAdmission:
                                h.homeSourceAdmission(requestId, sourcePublished.installationId!) } : {}),
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: request.envelope.target,
                        } });
                    return { status: 200, data: authorization };
                }
                if (String(url) === 'https://home.example/v1/actions/projects.inspect') {
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                    if (request.envelope.v !== 1) throw new Error('Expected a v1 inspect request');
                    expect(request.executionAuthorization?.binding).toMatchObject({ serverIdentityId,
                        machineId: sourcePublished.id, installationId: sourcePublished.installationId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) });
                    const raw = await createProjectDefinitionAction({ serverId: 'home', machineId: sourcePublished.id, workingDirectory: h.root,
                        accessPolicy: { kind: 'restrictedRoots', roots: [h.root] }, nativeIo: h.runtime.nativeIo })({
                        actionId: 'projects.inspect', input: request.envelope.input, context: { serverId: 'home' } });
                    return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect',
                        requestId: request.envelope.requestId, execution: { ok: true, result: raw } }) };
                }
                if (String(url) !== 'https://home.example/v1/actions/projects.script.run') return await homePost(url, body, config);
                expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
                expect(request.executionAuthorization?.binding).toMatchObject({ serverIdentityId, machineId: installed.id,
                    installationId: installed.installationId, requestId: envelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target });
                expect(envelope.target).toEqual({ kind: 'machine', machineId: 'machine' });
                const target = envelope.target;
                if (!target) throw new Error('Expected the explicit receiving Machine target');
                if (!request.executionAuthorization || !h.runtime.credentials) throw new Error('Expected original requester custody');
                // The simulated receiving process admits the caller's known Account credentials through the real owner.
                const admitted = await admitRequesterAccountActionContext({ authorization: request.executionAuthorization, credentials: h.runtime.credentials,
                    serverId: 'home', serverIdentityId, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl,
                    isCurrent: async () => true, isCustodyCurrent: h.runtime.isCurrent });
                if (!admitted) throw new Error('Pool requester Account custody not admitted');
                releaseRequesterContexts.push(admitted.dispose);
                const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
                    serverId: 'home', serverIdentityId, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl, target,
                    installationId: 'installation', privateKey: installation.secretKey, isCurrent: admitted.isCustodyCurrent });
                if (!carrier) throw new Error('Pool requester HTTP custody not admitted');
                const raw = await h.rpcInvoke('projects.script.run', envelope.input, { ...h.context, transportRequestId: envelope.requestId,
                    originalActionEnvelope: envelope, callerInputAuthorization: carrier });
                const failure = ActionExecuteFailureSchema.safeParse(raw);
                return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.script.run',
                    requestId: envelope.requestId, execution: failure.success ? failure.data : { ok: true, result: raw } }) };
            });
            const worker = createProjectWorkerAction({ serverId: 'home', machineId: 'machine', accountId: 'owner',
                credentials: h.runtime.credentials, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl,
                admission: h.runtime.workerAdmission, isFiniteExecutionLive: h.isFiniteExecutionLive });
            vi.spyOn(machineRpcTransport, 'callMachineRpc').mockResolvedValue({ statuses: observedSyncStatuses(h.relationships) });
            vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async request => {
                expect(request.machineId).toBe('machine');
                if (request.method === 'projects.worker.status') return await worker({ actionId: 'projects.worker.status', input: ProjectWorkerStatusInputV1Schema.parse(request.request),
                    signal: request.signal, context: { surface: 'rpc', serverId: 'home', runtimeAccountId: 'owner', authority: 'account_automation' } });
                throw new Error('Personal finite execution must enter the original Account Home Action front door');
            });
            // The local OS credential boundary captured a stored-session token, not an API-token caller claiming present_user.
            const credentials = { ...h.runtime.credentials, credentialProvenance: 'stored_session' as const };
            const params = { credentials, token, mode: 'plain' as const, ctx: null, sessionId: 'pool-requester',
                serverId: 'home', serverIdentityId, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl };
            const requester = createCliActionExecutor({ ...params, pluginActionExecutionOwner: 'current_process',
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }) },
                accountServerActionDeps: createAccountServerActionDeps(params) });
            const executed = await requester.execute('projects.script.run', input, { surface: 'cli', authority: 'present_user',
                presentUserConfirmation: { actionId: 'projects.script.run' }, actionRequestId: 'pool-request' });
            expect(executed, JSON.stringify(executed, null, 2)).toMatchObject({ ok: true });
            result = executed.ok ? executed.result : executed;
        } else result = await h.rpcInvoke('projects.script.run', input);
        expect(result).toMatchObject({ operation: { operationId: 'operation', domainRef: { workspaceRefId: target.id } } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies()[0]?.state).toBe('copying');
        expect(h.spawned).toEqual([]);
        if (scenario === 'withdrawn_after_copy') members = members.filter(member => member.machineId !== 'machine');
        h.continueCopy();
        const scope = { accountId: 'owner', machineId: 'machine' };
        if (scenario === 'withdrawn_after_copy') {
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('failed');
            expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ error: { errorCode: 'target_not_local' } });
            expect(h.spawned).toEqual([]);
        } else {
            await expect.poll(() => h.spawned.length).toBe(1);
            expect(h.spawned[0]!.params.options.cwd).toBe(target.rootPath);
            h.spawned[0]!.pty.exit(0);
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('succeeded');
        }
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('does not widen the held worker memory after copying a previously unavailable declaration', async () => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        await h.addWorkerTarget();
        expect(await h.workspaceExecutionConfig.get({ workspace: { serverId: 'home', refId: h.address.workspaceId } }))
            .toMatchObject({ status: 'ready', preference: { enabled: true, destination: { kind: 'machine', machineId: 'machine' } } });
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
        })).toMatchObject({ operation: { operationId: 'operation' } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies()[0]?.state).toBe('copying');
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...portableNativeManifest,
            workspace: { memoryDemand: { bytes: 1024, basis: { kind: 'declared' } } } }));
        expect((await readProjectManifest({ root: h.root })).document).toMatchObject({ status: 'valid' });
        h.continueCopy();
        await expect.poll(() => h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.state).toBe('failed');
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toMatchObject({ error: { errorCode: 'project_script_effect_changed' } });
        expect(h.spawned).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it.each(['queued', 'copied', 'consent_wake'] as const)('keeps the accepted effective memory bytes when only declaration labels change (%s)', async placement => {
        const manifest = { ...portableNativeManifest, workspace: { memoryDemand: { bytes: 1024, basis: { kind: 'declared' } },
            ...(placement === 'consent_wake' ? { setup: [{ kind: 'command', command: 'echo setup' }] } : {}),
        } };
        const h = await harness(manifest, placement === 'queued' ? 1 : null,
            placement === 'queued' ? 'machine' : 'source-machine');
        h.observeMemory({ totalBytes: 4096, availableBytes: 4096 });
        if (placement !== 'queued') await h.addWorkerTarget();
        const input = { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            ...(placement !== 'queued' ? { choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } } : {}),
        };
        const scope = { accountId: 'owner', machineId: 'machine' };
        let operationId = 'operation';
        if (placement === 'queued') {
            expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId } });
            await expect.poll(() => h.spawned.length).toBe(1);
            operationId = 'operation-2';
        }
        expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: 'same-bytes' }))
            .toMatchObject({ operation: { operationId } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === operationId)?.state)
            .toBe(placement === 'queued' ? 'queued' : 'copying');
        if (placement === 'consent_wake') {
            h.continueCopy();
            await expect.poll(() => h.operationRuntime.store.get(scope, operationId)?.setupReview?.code)
                .toBe('project_setup_consent_required');
        }
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...manifest,
            workspace: { ...manifest.workspace, memoryDemand: { bytes: 1024, basis: { kind: 'measured',
                operation: { serverId: 'home', machineId: 'source-machine', operationId: 'measurement' },
            } } },
        }));
        if (placement === 'queued') h.spawned[0]!.pty.exit(0);
        else if (placement === 'consent_wake') {
            await h.rememberSetup(h.operationRuntime.store.get(scope, operationId)!.setupReview!.reviewedEffectDigest);
            expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, transportRequestId: 'same-bytes' }))
                .toMatchObject({ operation: { operationId } });
        }
        else h.continueCopy();
        await expect.poll(() => h.operationRuntime.store.get(scope, operationId)?.state).toBe('running');
        expect(h.spawned).toHaveLength(placement === 'queued' ? 2 : 1);
        h.spawned.at(-1)!.pty.exit(0);
        if (placement === 'consent_wake') {
            await expect.poll(() => h.spawned.length).toBe(2);
            h.spawned[1]!.pty.exit(0);
        }
        await expect.poll(() => h.operationRuntime.store.get(scope, operationId)?.state).toBe('succeeded');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('projects the accepted SOURCE-relative ad-hoc cwd onto the copied target without rewriting the invocation', async () => {
        const h = await harness({ version: 1 }, null, 'source-machine');
        const target = await h.addWorkerTarget();
        h.allowAdHoc();
        await mkdir(join(h.root, 'nested'));
        const input = { workspace: h.address, executable: '/managed/echo', argv: ['one argument'], cwd: join(h.root, 'nested'),
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        expect(await h.rpcInvoke('projects.compute.exec', { ...input, cwd: join(h.root, '..', 'outside') },
            { ...h.context, transportRequestId: 'outside-source' })).toMatchObject({ ok: false, errorCode: 'outside_root' });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(await h.rpcInvoke('projects.compute.exec', input)).toMatchObject({ operation: { operationId: 'operation', domainRef: { workspaceRefId: target.id } } });
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params).toMatchObject({ file: '/managed/echo', args: ['one argument'], options: { cwd: join(target.rootPath, 'nested') } });
        expect(input.cwd).toBe(join(h.root, 'nested'));
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('preserves authenticated host workflow origin through the real direct Machine Action transport', async () => {
        const h = await harness(undefined, null, 'machine', ownerToken);
        h.installPreferenceReadHttpBoundary();
        const account = { token: h.runtime.credentials.token, credentials: h.runtime.credentials,
            serverId: 'home', serverHttpBaseUrl: h.runtime.serverHttpBaseUrl };
        const outer = createCliActionExecutor({ ...account, mode: 'plain', ctx: null, pluginActionExecutionOwner: 'current_process',
            sessionId: 'workflow-host', serverId: 'home', serverHttpBaseUrl: h.runtime.serverHttpBaseUrl,
            accountServerActionDeps: createAccountServerActionDeps(account),
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
                approvalWaivedSurfaces: { 'projects.script.run': ['agent'] } }) },
            machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (method, request, options) => {
                if (method === 'daemon.projects.inspect.v1') return await createProjectDefinitionAction({ serverId: 'home', machineId: 'machine',
                    workingDirectory: h.root, accessPolicy: { kind: 'restrictedRoots', roots: [h.root] }, nativeIo: h.runtime.nativeIo })({
                    actionId: 'projects.inspect', input: request, context: { serverId: 'home', signal: options?.signal } });
                expect(method).toBe(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run']);
                return h.rpcInvoke('projects.script.run', request, { ...h.context,
                    ...(options?.localActionContext ? { localActionContext: options.localActionContext } : {}) });
            } },
        });
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        expect(await outer.execute('projects.script.run', input, { surface: 'agent', authority: 'account_automation',
            actionRequestId: 'workflow-leaf', executionRunWorkflowRunId: 'admitted-workflow',
            actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'projects.script.run': ['agent'] } }),
        })).toMatchObject({ ok: true, result: { operation: { domainRef: {
            originRun: { kind: 'workflow_run', serverId: 'home', runId: 'admitted-workflow' },
        } } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('receives finite origin from the actual accepted Workflow Action context producer', async () => {
        const h = await harness();
        const { buildWorkflowActionContext } = await import('@/daemon/workflows/daemonRuntime');
        const executionContext = buildWorkflowActionContext({ runId: 'accepted-host-run',
            authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } });
        const input = { workspace: h.address, selection: { kind: 'native', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } };
        expect(await h.rpcInvoke('projects.script.run', input, { ...h.context, localActionContext: {
            ...(executionContext.executionRunWorkflowRunId ? { executionRunWorkflowRunId: executionContext.executionRunWorkflowRunId } : {}),
        } })).toMatchObject({ operation: { domainRef: {
            originRun: { kind: 'workflow_run', serverId: 'home', runId: 'accepted-host-run' },
        } } });
        await expect.poll(() => h.spawned.length).toBe(1);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it.each([false, true])('retains the actual final-target clean Sync timestamp through a worker Run (setup: %s)', async setup => {
        const source = { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } as const;
        const h = await harness({ version: 1,
            ...(setup ? { workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } } : {}),
            scripts: { checked: { execution: 'portable', source } },
        }, null, 'source-machine', ownerToken);
        const target = await h.addWorkerTarget();
        const hubRoot = await mkdtemp(join(tmpdir(), 'happier-project-sync-hub-'));
        roots.push(hubRoot);
        const hub = { ...h.workspaceRefs[0]!, id: 'hub', machineId: 'hub-machine', rootPath: hubRoot };
        h.workspaceRefs.push(hub);
        const original = h.relationships[0]!;
        h.relationships.splice(0, 1,
            { ...original, relationshipId: 'source-hub', controllerMachineId: hub.machineId,
                alphaWorkspaceRefId: hub.id, betaWorkspaceRefId: h.address.workspaceId, mode: 'keep_both_in_sync', provenance: undefined },
            { ...original, relationshipId: 'hub-target', controllerMachineId: hub.machineId,
                alphaWorkspaceRefId: hub.id, betaWorkspaceRefId: target.id,
                provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: hub.id, targetWorkspaceRefId: target.id } });
        const previousGet = h.get.getMockImplementation()!;
        h.get.mockImplementation(async (...args) => {
            const url = String(args[0]);
            if (!url.includes('/v1/machines/')) return await previousGet(...args);
            const machineId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
            return { status: 200, data: { machine: { id: machineId, metadata: null, metadataVersion: 0,
                daemonState: null, daemonStateVersion: 0, storageMode: 'plain', revokedAt: null, replacedByMachineId: null,
                managedMachineRef: null } } };
        });
        let permitFlush!: () => void;
        const flushAllowed = new Promise<void>(resolve => { permitFlush = resolve; });
        vi.spyOn(machineRpcTransport, 'callMachineRpc').mockResolvedValue({ statuses: observedSyncStatuses(h.relationships) });
        const workerPreparation = createWorkspaceSyncWorkerPreparation({ serverId: 'home',
            serverHttpBaseUrl: h.runtime.serverHttpBaseUrl, targetMachineId: 'machine', credentials: h.runtime.credentials,
            prepareBetween: async (request, signal) => prepareWorkspaceSyncBetween({ ...request, signal, serverId: 'home',
                readCurrent: async () => ({ workspaceRefs: h.workspaceRefs, relationships: h.relationships }),
                // Only the external Sync controller's completed file-transfer reply is substituted.
                flush: async relationshipId => {
                    await flushAllowed;
                    const first = relationshipId === 'source-hub';
                    const from = first ? h.root : hub.rootPath;
                    const to = first ? hub.rootPath : target.rootPath;
                    await cp(from, to, { recursive: true });
                    return { relationshipId, controllerMachineId: hub.machineId, state: 'watching',
                        alphaPath: hub.rootPath, betaPath: first ? h.root : target.rootPath,
                        mode: first ? 'keep_both_in_sync' : 'keep_synced',
                        endpointStates: {
                            alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                            beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                        }, conflictCount: 0, lastCycleObservedAtMs: 999,
                        lastCleanSyncAtMs: first ? 222 : 450,
                    };
                },
            }),
        }) satisfies Pick<ProjectFiniteActionRuntime, 'resolveWorkerTarget' | 'prepareDequeue'>;
        Object.assign(h.runtime, workerPreparation);
        const input = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        const scope = { accountId: 'owner', machineId: 'machine' };
        const ingress = { ...h.context, transportRequestId: 'sync-worker-run' };
        expect(await h.rpcInvoke('projects.script.run', input, ingress)).toMatchObject({ operation: { operationId: 'operation' } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies()[0]?.state).toBe('copying');
        expect(h.operationRuntime.store.get(scope, 'operation')?.domainRef).not.toHaveProperty('lastCleanSyncAtMs');
        permitFlush();
        if (setup) {
            await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.setupReview?.code).toBe('project_setup_consent_required');
            expect.soft(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({
                domainRef: { workspaceRefId: target.id, lastCleanSyncAtMs: 450 } });
            await h.rememberSetup(h.operationRuntime.store.get(scope, 'operation')!.setupReview!.reviewedEffectDigest);
            expect(await h.rpcInvoke('projects.script.run', input, ingress)).toMatchObject({ operation: { operationId: 'operation' } });
            await expect.poll(() => h.spawned.length).toBe(1);
            expect.soft(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ state: 'running',
                domainRef: { purpose: 'setup', workspaceRefId: target.id, lastCleanSyncAtMs: 450 } });
            h.spawned[0]!.pty.exit(0);
        }
        await expect.poll(() => h.spawned.length).toBe(setup ? 2 : 1);
        expect.soft(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ state: 'running',
            domainRef: { purpose: 'script', workspaceRefId: target.id, lastCleanSyncAtMs: 450 } });
        h.spawned.at(-1)!.pty.exit(0);
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('succeeded');
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ domainRef: { lastCleanSyncAtMs: 450 } });
    });

    it.each([true, false])('admits a portable named SOURCE declaration using canonical inspection (explicit workers: %s)', async explicit => {
        const source = { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } as const;
        const h = await harness({ version: 1, scripts: { checked: { execution: 'portable', memoryDemand: { bytes: 1024, basis: { kind: 'declared' } },
            source } } }, null, 'source-machine');
        h.observeMemory({ totalBytes: 4096, availableBytes: 4096 });
        const target = await h.addWorkerTarget();
        const inspectSource = vi.spyOn(h.runtime, 'inspectSourceProjectManifest');
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            ...(explicit ? { choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } } : {}),
        })).toMatchObject({ operation: { operationId: 'operation', domainRef: { workspaceRefId: target.id, machineId: 'machine',
            sourceWorkspace: h.address, script: { name: 'checked', source } } } });
        expect(inspectSource).toHaveBeenCalledWith(expect.objectContaining({ command: { usage: 'script', name: 'checked' } }));
        await expect.poll(() => h.runtime.workerAdmission.dependencies()[0]?.state).toBe('copying');
        expect(h.spawned).toEqual([]);
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toMatchObject({
            domainRef: { machineId: 'machine', workspaceRefId: target.id, sourceWorkspace: h.address, script: { name: 'checked', source } },
        });
        expect(h.spawned[0]!.params).toMatchObject({ args: ['-f', join(target.rootPath, 'Makefile'), 'check'], options: { cwd: target.rootPath } });
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('does not assume a named SOURCE declaration is portable when explicit workers were requested', async () => {
        const h = await harness({ version: 1, scripts: { checked: { execution: 'primary',
            source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } }, null, 'source-machine');
        await h.addWorkerTarget();
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
        })).toMatchObject({ ok: false, errorCode: 'primary_only' });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it.each([['workers', 'setup'], ['workers', 'script'], ['primary', 'script']] as const)('retains current setup review inside the original %s reservation and resumes the exact operation after real Remember (%s failure)', async (placement, failedPhase) => {
        const manifest = { version: 1, scripts: { checked: { execution: 'portable',
            source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } };
        const h = await harness(manifest, 1, placement === 'workers' ? 'source-machine' : 'machine');
        if (placement === 'workers') await h.addWorkerTarget();
        const selection = { kind: 'named', name: 'checked' } as const;
        const script = { name: selection.name, source: manifest.scripts.checked.source };
        const input = { workspace: h.address,
            selection,
            choice: placement === 'workers' ? { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } : { kind: 'primary' },
        };
        expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        h.holdCopy();
        const ingress = { ...h.context, transportRequestId: 'queued-named-script' };
        expect.soft(await h.rpcInvoke('projects.script.run', input, ingress)).toMatchObject({
            operation: { operationId: 'operation-2', domainRef: { purpose: 'script', sourceWorkspace: h.address, script } },
        });
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation-2')?.state).toBe('queued');
        expect.soft(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({
            state: 'accepted', domainRef: { purpose: 'script', sourceWorkspace: h.address, script },
        });
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...manifest,
            workspace: { setup: [{ kind: 'command', command: 'echo setup' }] },
        }));
        h.spawned[0]!.pty.exit(0);
        if (placement === 'workers') {
            await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation-2')?.state).toBe('copying');
            h.continueCopy();
        }
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation-2');
            return snapshot?.setupReview !== undefined || snapshot?.state === 'failed';
        }).toBe(true);
        const pending = h.operationRuntime.store.get(scope, 'operation-2');
        expect.soft(pending).toMatchObject({ state: 'accepted', setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required',
            reviewedEffectDigest: expect.any(String), reviewedEffect: expect.any(Object) }, domainRef: { sourceWorkspace: h.address, script } });
        expect(h.spawned).toHaveLength(1);
        expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'operation-2', state: 'setup' }]);
        await h.rememberSetup(pending!.setupReview!.reviewedEffectDigest);
        expect(await h.operationRuntime.handlers.getV2({ operationId: 'operation-2' }))
            .toMatchObject({ kind: 'found', operation: { operationId: 'operation-2' } });
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation-2');
            return { spawned: h.spawned.length, state: snapshot?.state, error: snapshot?.error,
                setupReviewDigest: snapshot?.setupReview?.reviewedEffectDigest,
                dependencies: h.runtime.workerAdmission.dependencies() };
        }).toEqual(expect.objectContaining({ spawned: 2 }));
        expect.soft(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({
            state: 'running', domainRef: { purpose: 'setup', sourceWorkspace: h.address, script, terminalId: expect.any(String) },
        });
        const setupAttachment = h.operationRuntime.store.get(scope, 'operation-2')!.domainRef;
        const setupTerminalId = setupAttachment?.kind === 'projectCommand' ? setupAttachment.terminalId : undefined;
        let failedTerminalId = setupTerminalId;
        h.spawned[1]!.pty.exit(failedPhase === 'setup' ? 7 : 0);
        if (failedPhase === 'script') {
            await expect.poll(() => h.spawned.length).toBe(3);
            expect.soft(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({
                state: 'running', domainRef: { purpose: 'script', sourceWorkspace: h.address, script, terminalId: expect.any(String) },
            });
            const scriptAttachment = h.operationRuntime.store.get(scope, 'operation-2')!.domainRef;
            failedTerminalId = scriptAttachment?.kind === 'projectCommand' ? scriptAttachment.terminalId : undefined;
            expect(failedTerminalId).not.toBe(setupTerminalId);
            h.spawned[2]!.pty.exit(7);
        }
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation-2')?.state).toBe('failed');
        expect(h.operationRuntime.store.get(scope, 'operation-2')).toMatchObject({
            error: { errorCode: failedPhase === 'setup' ? 'project_setup_step_failed' : 'project_command_step_failed' },
            domainRef: { purpose: failedPhase, sourceWorkspace: h.address, script, exitCode: 7, terminalId: failedTerminalId },
        });
        expect(h.spawned).toHaveLength(failedPhase === 'setup' ? 2 : 3);
        expect(h.operationRuntime.store.list(scope).items).toHaveLength(2);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('cancels an accepted worker waiting for post-copy setup consent without releasing before no-effect settlement', async () => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        await h.addWorkerTarget();
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
        })).toMatchObject({ operation: { operationId: 'operation' } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation')?.state).toBe('copying');
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...portableNativeManifest, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } }));
        h.continueCopy();
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation');
            return snapshot?.setupReview !== undefined || snapshot?.state === 'failed';
        }).toBe(true);
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ setupReview: { code: 'project_setup_consent_required' } });
        expect(h.runtime.workerAdmission.dependencies()).toHaveLength(1);
        expect(h.operationRuntime.runner.cancel(scope, 'operation')).toEqual({ kind: 'requested' });
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('cancelled');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it('refuses an actually invalid SOURCE declaration before worker acceptance or target file reads', async () => {
        const h = await harness({ version: 1 }, null, 'source-machine');
        await h.addWorkerTarget();
        await writeFile(join(h.root, '.happier/project.json'), 'invalid source JSON');
        expect(await h.rpcInvoke('projects.script.run', { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
        })).toMatchObject({ ok: false, errorCode: 'invalid_manifest' });
        expect(h.operationRuntime.store.list({ accountId: 'owner', machineId: 'machine' }).items).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it.each(['source-machine', 'machine'])('preserves the accepted host Machine baseline over SOURCE worker preferences (%s)', async sourceMachineId => {
        const h = await harness({ version: 1, scripts: { checked: { execution: 'portable',
            source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } } }, null, sourceMachineId);
        const target = await h.addWorkerTarget();
        h.setWorkerDestination('different-worker');
        const { buildWorkflowActionContext } = await import('@/daemon/workflows/daemonRuntime');
        const context = buildWorkflowActionContext({ runId: 'accepted-run', workspace: { machineId: 'machine' },
            authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } });
        const localActionContext = { surface: context.surface, authority: context.authority,
            executionRunTargetMachineId: context.executionRunTargetMachineId ?? undefined, executionRunWorkflowRunId: context.executionRunWorkflowRunId };
        const sourceInput = { workspace: h.address, selection: { kind: 'named', name: 'checked' } };
        const { projectWorkflowFiniteActionInputV1 } = await import('@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1');
        const effectiveInput = sourceMachineId === 'machine' ? projectWorkflowFiniteActionInputV1({ machineId: 'machine',
            actionId: 'projects.script.run', input: sourceInput }) : sourceInput;
        expect(await h.rpcInvoke('projects.script.run', effectiveInput,
            { ...h.context, localActionContext })).toMatchObject({ operation: { operationId: 'operation', domainRef: {
                workspaceRefId: sourceMachineId === 'machine' ? h.address.workspaceId : target.id,
            } } });
        h.continueCopy();
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.spawned[0]!.params.options.cwd).toBe(sourceMachineId === 'machine' ? h.root : target.rootPath);
        h.spawned[0]!.pty.exit(0);
        await expect.poll(() => h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it('refuses an unreviewed override of the accepted host Machine through the real direct Action transport', async () => {
        const h = await harness(portableNativeManifest, null, 'source-machine', ownerToken);
        await h.addWorkerTarget();
        h.installPreferenceReadHttpBoundary();
        vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async request => {
            expect(request.machineId).toBe('source-machine');
            expect(request.method).toBe('daemon.projects.inspect.v1');
            return await createProjectDefinitionAction({ serverId: 'home', machineId: 'source-machine', workingDirectory: h.root,
                accessPolicy: { kind: 'restrictedRoots', roots: [h.root] }, nativeIo: h.runtime.nativeIo })({
                actionId: 'projects.inspect', input: request.request, context: { serverId: 'home', signal: request.signal } });
        });
        const { buildWorkflowActionContext } = await import('@/daemon/workflows/daemonRuntime');
        const context = buildWorkflowActionContext({ runId: 'accepted-run', workspace: { machineId: 'accepted-machine' },
            authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } });
        const account = { token: h.runtime.credentials.token, credentials: h.runtime.credentials,
            serverId: 'home', serverHttpBaseUrl: h.runtime.serverHttpBaseUrl };
        const outer = createCliActionExecutor({ ...account, mode: 'plain', ctx: null, pluginActionExecutionOwner: 'current_process',
            sessionId: 'workflow-host', serverId: 'home', serverHttpBaseUrl: h.runtime.serverHttpBaseUrl,
            accountServerActionDeps: createAccountServerActionDeps(account),
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
                approvalWaivedSurfaces: { 'projects.script.run': ['agent'] } }) },
            machineActionDirectTargetTransport: { machineId: 'machine', invoke: async (_method, request, options) => h.rpcInvoke('projects.script.run', request,
                { ...h.context, ...(options?.localActionContext ? { localActionContext: options.localActionContext } : {}) }) },
        });
        expect(await outer.execute('projects.script.run', { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } },
        }, { ...context, actionRequestId: 'original-leaf', actionsSettings: normalizeActionsSettingsV1({ v: 1,
            approvalWaivedSurfaces: { 'projects.script.run': ['agent'] } }) }))
            .toMatchObject({ ok: false, errorCode: 'override_requires_review' });
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it('settles changed Source Script review after Remember inspection without using the setup grant to launch', async () => {
        const h = await harness({ ...portableNativeManifest, workspace: { setup: [{ kind: 'command', command: 'echo original setup' }] } }, 1, 'source-machine');
        await h.addWorkerTarget();
        const input = { workspace: h.address, selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
        h.continueCopy();
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.setupReview !== undefined).toBe(true);
        const pending = h.operationRuntime.store.get(scope, 'operation')!.setupReview!;
        expect(h.spawned).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'operation', state: 'setup' }]);
        await h.rememberSetup(pending.reviewedEffectDigest);
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...portableNativeManifest,
            scripts: { checked: { execution: 'portable', source: { kind: 'command', command: 'echo changed Script' } } },
            workspace: { setup: [{ kind: 'command', command: 'echo original setup' }] },
        }));
        // Consume the actual public observation boundary's rejection on RED;
        // the deciding fact is whether its original retained operation settles.
        const inspection = await h.operationRuntime.handlers.getV2({ operationId: 'operation' }).catch(error => ({
            refreshError: error instanceof Error && 'code' in error ? error.code : 'unknown',
        }));
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation');
            return { state: snapshot?.state, error: snapshot?.error, setupReviewDigest: snapshot?.setupReview?.reviewedEffectDigest,
                dependencies: h.runtime.workerAdmission.dependencies(), spawned: h.spawned.length };
        }).toEqual(expect.objectContaining({ state: 'failed' }));
        expect(inspection).toMatchObject({ kind: 'found' });
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ state: 'failed', error: {
            errorCode: 'project_script_effect_changed', details: { kind: 'pendingApproval', code: 'project_script_effect_changed',
                reviewedEffectDigest: expect.any(String), reviewedEffect: expect.anything() },
        } });
        expect(h.operationRuntime.store.get(scope, 'operation')).not.toHaveProperty('setupReview');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
        expect(h.spawned).toEqual([]);
    });

    it('re-copies the same accepted Sync route after review wake and does not use Remember for changed source effects', async () => {
        const h = await harness(portableNativeManifest, null, 'source-machine');
        await h.addWorkerTarget();
        const input = { workspace: h.address,
            selection: { kind: 'named', name: 'checked' },
            choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'machine' } } };
        expect(await h.rpcInvoke('projects.script.run', input)).toMatchObject({ operation: { operationId: 'operation' } });
        await expect.poll(() => h.runtime.workerAdmission.dependencies().find(entry => entry.operationId === 'operation')?.state).toBe('copying');
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...portableNativeManifest, workspace: { setup: [{ kind: 'command', command: 'echo original setup' }] } }));
        h.continueCopy();
        const scope = { accountId: 'owner', machineId: 'machine' };
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation');
            return snapshot?.setupReview !== undefined || snapshot?.state === 'failed';
        }).toBe(true);
        expect(h.operationRuntime.store.get(scope, 'operation')).toMatchObject({ setupReview: { code: 'project_setup_consent_required' } });
        const firstDigest = h.operationRuntime.store.get(scope, 'operation')!.setupReview!.reviewedEffectDigest;
        await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ ...portableNativeManifest, workspace: { setup: [{ kind: 'command', command: 'echo changed setup' }] } }));
        expect(await h.operationRuntime.handlers.getV2({ operationId: 'operation', refreshSetupReview: true }))
            .toMatchObject({ kind: 'found', operation: { operationId: 'operation', setupReview: {
                reviewedEffectDigest: expect.not.stringMatching(new RegExp(`^${firstDigest}$`)),
            } } });
        // The producer must expose the new effect before any Trust write, not
        // only discover it after granting the stale displayed target effect.
        await h.rememberSetup(firstDigest);
        await h.operationRuntime.handlers.getV2({ operationId: 'operation', refreshSetupReview: true });
        await expect.poll(() => {
            const snapshot = h.operationRuntime.store.get(scope, 'operation');
            return { reviewChanged: Boolean(snapshot?.setupReview && snapshot.setupReview.reviewedEffectDigest !== firstDigest),
                state: snapshot?.state, error: snapshot?.error, setupReviewDigest: snapshot?.setupReview?.reviewedEffectDigest,
                dependencies: h.runtime.workerAdmission.dependencies(), spawned: h.spawned.length };
        }).toEqual(expect.objectContaining({ reviewChanged: true }));
        expect(h.spawned).toEqual([]);
        expect(h.runtime.workerAdmission.dependencies()).toMatchObject([{ operationId: 'operation', state: 'setup' }]);
        expect(h.operationRuntime.runner.cancel(scope, 'operation')).toEqual({ kind: 'requested' });
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('cancelled');
        expect(h.runtime.workerAdmission.dependencies()).toEqual([]);
    });

    it.each(['removed', 'home-refused', 'cleanup-refused'] as const)('retains native Session bytes through Home refusal and settles only removal (%s)', async outcome => {
        const h = await harness({ version: 1, workspace: { teardown: [{ kind: 'command', command: 'true' }] } });
        const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
        const home = await mkdtemp(join(tmpdir(), 'finite-session-removal-'));
        roots.push(home);
        environment.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'home' });
        reloadConfiguration();
        const directories = createManagedSessionDirectories({});
        const allocation = await directories.materializeForFreshSpawn({ sessionCreationTag: 'native-session-remove' });
        await directories.bind({ allocationId: allocation.allocationId, sessionId: 'managed-session' });
        await cp(join(h.root, '.happier'), join(allocation.directory, '.happier'), { recursive: true });
        await writeFile(join(allocation.directory, 'kept'), 'private-session-bytes');
        h.workspaceRefs[0]!.rootPath = allocation.directory;
        h.address.rootPath = allocation.directory;
        const plugin = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
        releaseRequesterContexts.push(() => plugin.dispose());
        const facts: HostEventEnvelopeV1[] = [];
        const subscription = plugin.registry.stableEventsBroker!.subscribeHost({
            target: { eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } },
            isCurrent: () => true, listener: event => { facts.push(event); },
        });
        let homePresent = true;
        let homeDeletes = 0;
        let custodyRetired = false;
        let receiverResult: unknown;
        const executor = createActionExecutor({
            sessionDelete: createNativeSessionDeleteAction({ ingress: h.context,
                resolveRuntime: async () => ({ ...h.runtime, requesterIdentity: selectHostRequesterExecutionIdentity({
                    rpcContext: h.context, hostHomeServerIdentityId: 'home' }) }),
                isSessionActive: async () => false,
                retireRequesterCustody: async () => { custodyRetired = true; return true; },
                // Host allocations never cross the OS member-launch boundary.
                nativeOperationRuntime: { readMemberFolderOwner: async () => null,
                    prepareNativeOperation: async () => { throw new Error('Unexpected member launch for a host allocation'); } },
            }),
            // The Home HTTP boundary refuses or accepts the real root Action;
            // admission, native preparation, teardown and deletion stay real.
            homeDomainAction: async () => {
                homeDeletes++;
                expect(await readFile(join(allocation.directory, 'kept'), 'utf8')).toBe('private-session-bytes');
                expect(facts).toEqual([]);
                if (outcome === 'home-refused') return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
                homePresent = false;
                return { success: true };
            },
        });
        const scope = { accountId: 'owner', machineId: 'machine' };
        try {
            const accepted = h.operationRuntime.observeExecution({ actionId: 'session.delete', input: { sessionId: 'managed-session' },
                actionRequestId: 'remove-session', response: 'admission', execute: async operation => {
                    const result = await executor.execute('session.delete', { sessionId: 'managed-session' }, {
                        ...operation, authority: 'present_user', actionCaller: { kind: 'host' }, surface: 'rpc', serverId: 'home',
                        presentUserConfirmation: { actionId: 'session.delete' }, actionsSettings: normalizeActionsSettingsV1({
                            v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.prepare': ['rpc'] },
                        }),
                    });
                    receiverResult = result;
                    return result;
                } });
            expect(await accepted).toMatchObject({ ok: true });
            await expect.poll(() => h.spawned.length || h.operationRuntime.store.get(scope, 'operation')?.state === 'failed').toBeTruthy();
            expect(h.spawned).toHaveLength(1);
            expect(homePresent).toBe(true);
            expect(homeDeletes).toBe(0);
            expect(await readFile(join(allocation.directory, 'kept'), 'utf8')).toBe('private-session-bytes');
            h.spawned[0]!.pty.exit(outcome === 'cleanup-refused' ? 7 : 0);
            await h.operationRuntime.runner.waitForTerminal(scope, 'operation');
            expect(h.operationRuntime.store.list(scope).items).toHaveLength(1);
            if (outcome === 'removed') {
                expect(receiverResult).toEqual({ ok: true, result: { success: true } });
                expect(homePresent).toBe(false);
                expect(custodyRetired).toBe(true);
                await expect(access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
                expect(await directories.listRecords()).toEqual([]);
                await expect.poll(() => facts.length).toBe(1);
                expect(facts[0]).toMatchObject({ payload: { kind: 'worktreeRemoved', removal: {
                    operationId: 'operation', workspace: { workspaceId: 'accepted', rootPath: allocation.directory },
                    removalKind: 'deleted', outcome: 'removed',
                } } });
            } else {
                expect(receiverResult).toMatchObject({ ok: false,
                    errorCode: outcome === 'home-refused' ? 'credential_scope_denied' : 'project_setup_step_failed' });
                expect(homePresent).toBe(true);
                expect(homeDeletes).toBe(outcome === 'home-refused' ? 1 : 0);
                expect(custodyRetired).toBe(false);
                expect(await readFile(join(allocation.directory, 'kept'), 'utf8')).toBe('private-session-bytes');
                expect(await directories.listRecords()).toMatchObject([{ sessionId: 'managed-session' }]);
                expect(facts).toEqual([]);
            }
        } finally {
            await subscription.dispose();
            await h.operationRuntime.runner.retireProjectFiniteOperations();
            environment.restore(); reloadConfiguration();
        }
    });

    it('runs teardown under the admitted removal operation without creating a child operation', async () => {
        const h = await harness({ version: 1, workspace: { teardown: [{ kind: 'command', command: 'true' }] } });
        h.waiveSetupApproval();
        const scope = { accountId: 'owner', machineId: 'machine' };
        const accepted = h.operationRuntime.observeExecution({ actionId: 'scm.worktree.remove',
            input: { cwd: h.root, worktreePath: h.root, confirmed: true }, actionRequestId: 'remove', response: 'admission',
            execute: async operation => {
                const nested = await createFiniteActionWithCapturedRequester(h.runtime, h.context, { operation })({
                    actionId: 'projects.prepare', input: { workspace: h.address, phase: 'teardown' },
                    context: { authority: 'present_user', surface: 'ui', serverId: 'home', actionsSettings: normalizeActionsSettingsV1({
                        v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.prepare': ['ui'] },
                    }) },
                });
                const failed = ActionExecuteFailureSchema.safeParse(nested);
                return failed.success ? failed.data : { ok: true, result: nested };
            } });
        await expect.poll(() => h.spawned.length).toBe(1);
        expect(h.operationRuntime.store.list(scope).items).toHaveLength(1);
        h.spawned[0]!.pty.exit(0);
        expect(await accepted).toMatchObject({ ok: true });
        await expect.poll(() => h.operationRuntime.store.get(scope, 'operation')?.state).toBe('succeeded');
    });


});
