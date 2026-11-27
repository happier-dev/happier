import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { expect, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import * as syncClient from '@happier-dev/sync-client';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, type ActionExecuteResult, type ActionId,
  type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions';
import { DeploymentChildRpcV1Schema, HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';
import { ManagedListInputV1Schema, ManagedListOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
  MachineUpdateOperationProtocolCapabilitiesResponseV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { ApprovalRequestV2Schema, resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema, projectExternalActionHttpError,
  projectExternalActionDeploymentReadEnvelopeAdmissionV1, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1,
  projectExternalActionRunNowIdempotencyKeyV1, projectExternalActionApprovalDecisionAdmissionV1, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowV1Schema, ProjectAccountRowListResponseV1Schema,
  ProjectAccountRowReadRequestV1Schema, ProjectAccountRowReadResponseV1Schema,
  ProjectAccountRowMutationResponseV1Schema, buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ProjectSourcesCreateInputV1Schema, ProjectSourcesUpdateInputV1Schema, ProjectSourcesDeleteInputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { MachineUpdateStateRequestSchema, MachineUpdateStateResponseSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveMachineRpcExternalActionEffectV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS, WorkspaceSyncSourceExecutionV1Schema, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { ApiMachineClient } from '@/api/apiMachine';
import { resolveMachineRpcWorkingDirectory } from '@/api/machine/resolveMachineRpcWorkingDirectory';
import { resolvePublishedMachineEncryptionContext } from '@/api/machine/machineDataEncryptionKey';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { requestDaemonSignedRootActionExecution } from '@/daemon/controlClient';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { handleActionsCommand } from '@/cli/commands/actions';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { logger } from '@/ui/logger';
import { ApiClient } from '@/api/api';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliPrivateLabelActionOpener } from '@/api/privateLabels';
import { listQualifiedConnectedAccountsV4, listQualifiedConnectedAccountGroupsV4, readQualifiedConnectedAccountGroupV4,
  resolveQualifiedConnectedAccountAtomicV4Negotiation } from '@/api/client/qualifiedConnectedAccountApi';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createConnectedAccountDaemonConfigurationOwner } from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import { createRequesterTeamCredentialDirectMaterialClient } from '@/daemon/connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createActiveAccountSettingsConnectedAccountPurposeBindingStore } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountActionTeamResourceCatalogReader } from '@/daemon/connectedServices/purposeBindings/actionTeamResourceCatalog';
import { createActiveAccountSettingsConnectedAccountSecrets, createQualifiedConnectedAccountDaemonPersistence } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { configuration, reloadConfiguration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import * as installationStore from '@/daemon/identity/store';
import { readStoredCredentialsForServerId, sameStoredCredentials, updateSettings, writeStoredCredentialsForServerId, encodeStoredCredentials, writeDaemonState } from '@/persistence';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { createExternalActionSourceMachineRpcExecution, projectExternalActionRequesterHttpAuthorization, verifyExternalActionExecutionAuthorizationCurrent, resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { executeExternalAction } from './executeExternalAction';
import { createDaemonApprovalExecutionAuthorizationPreparer } from './approvalExecutionAuthorization';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createDaemonSessionAccountActionAuthorizationPreparer } from '@/daemon/startup/createDaemonSessionAccountActionAuthorizationPreparer';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectWorkerAction } from '@/workspaces/execution/projectWorkerAction';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { inspectProjectSetup, reviewProjectSetupEffect } from '@/workspaces/projectSetup/projectSetupPreparation';
import { resolveProjectSetupAcceptedWorkspace } from '@/workspaces/projectSetup/projectSetupAcceptedWorkspace';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1, WorkspaceExecutionConfigReadResponseV1Schema,
  WorkspaceExecutionConfigMutationRequestV1Schema, type WorkspaceExecutionConfigContentV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { LocalServiceManagedServiceActionTargetV1Schema, createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { TerminalPtySessionManager } from '@/terminal/pty/sessions';
import { createSessionNotificationContextFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import * as ptyBoundary from '@/terminal/pty/provider';
import * as processBoundary from '@happier-dev/cli-common/process';
import * as processTerminationBoundary from '@/processes/terminate/terminateProcessTree';
import type { PtyProcess, PtyExitEvent } from '@/terminal/pty/provider';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { registerProjectOpenRpcHandlers } from '@/rpc/handlers/projects/registerProjectOpenRpcHandlers';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { admitRequesterAccountActionContext, prepareInstalledRequesterAccountActionContext, prepareRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionProjection";
import { createDaemonControlApp } from '@/daemon/controlServer';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { deriveWorkspaceSyncRelationshipId, projectWorkspaceSyncAdmissionInputV1, WorkspaceSyncAdmissionV1Schema } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { projectAdmittedExternalActionMachineContext } from './execution';
import { createProductionDaemonWorkspaceSyncRuntime, type ProductionDaemonWorkspaceSyncRuntime,
  type ProductionDaemonWorkspaceSyncFactories } from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { materializeLocalWorkspaceSyncSeed } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { createDaemonWorkspaceSyncRuntime } from '@/daemon/startup/createDaemonWorkspaceSyncRuntime';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { activateSessionsRoleForMachineClient } from '@/daemon/testkit/sessionsRole.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { WorkspaceProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { registerMachineWorkspaceSyncRpcHandlers } from '@/api/machine/rpcHandlers.workspaceSync';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent, doesWorkspaceSyncSourceRootMatchRouting } from '@/api/machine/machineRpcAuthorization';
import { mutateProjectAccountRows, readProjectAccountRows } from '@/workspaces/projectAccountRows';
import type { MutagenControlCommandV1, MutagenSessionSummaryV1 } from '@/workspaces/sync/transport/workspaceSyncBrokerProtocol';
import { createMutagenChangeWaitBoundary } from '@/workspaces/sync/transport/workspaceSyncBrokerClient.testkit';
import type { RpcRequest } from '@/api/rpc/types';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { registerActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { ActionOperationCancelV1ResponseSchema, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationAddressV1Schema } from '@happier-dev/protocol/actions/specs/actionOperations';
import { createProjectServiceRelocationRoute } from '@/daemon/local/services/actions/projectServiceRelocationRoute';
import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';

// OS process boundary only; the installed operation, preparation, success and PTY owners stay real.
class SetupBoundaryPty implements PtyProcess {
  constructor(readonly pid: number, readonly cwd: string | undefined) {}
  get ownedProcessGroupId() { return this.pid; }
  private readonly exits = new Set<(event: PtyExitEvent) => void>();
  private readonly bytes = new Set<(data: Buffer) => void>();
  write() {}
  resize() {}
  kill() {}
  onData() { return { dispose() {} }; }
  onDataBytes(listener: (data: Buffer) => void) { this.bytes.add(listener); return { dispose: () => this.bytes.delete(listener) }; }
  emitBytes(data: Buffer) { for (const listener of this.bytes) listener(data); }
  onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
  exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode }); }
}

const socketBoundary = vi.hoisted(() => ({ create: vi.fn() }));
export function resetFilesystemApprovalSocketBoundary() { socketBoundary.create.mockReset(); }
const createHomeSocket = syncClient.createHappierSocket;
const bytes = Buffer.from([0, 255, 128, 10]);
const repository = { provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git' }, protocol: 'https' as const };

// Extend the incumbent continuation harness. Production composition/registrars,
// policy, custody, codecs and effects remain real; Home transport and durable
// approval persistence are the only substituted system boundaries.
export async function createHarness(actionId: ActionId, approval: 'ask' | 'allowed' | 'denied' | 'default' = 'ask', setup = false, homeId = 'srv_n2',
  home?: Readonly<{
    token: string;
    mintAuthorization(actionId: ActionId, envelope: ExternalActionRequestEnvelope,
      authentication: Readonly<{ kind: 'account' | 'terminal'; tokenEpoch: number }>): Promise<ExternalActionExecutionAuthorizationV1>;
    request(input: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown; headers: Record<string, string> }>): Promise<{ status: number; data: unknown }> | null;
    relayWorkspaceSource?(packet: SocketRpcRequestPayload, deliver: (request: RpcRequest) => Promise<unknown>): Promise<unknown>;
  }>, worker = false, sameMachineWorker = false,
  cliPolicy?: Readonly<{ authentication: 'account' | 'terminal'; askWithUiWaiver?: boolean; hostOnlyAsk?: 'waived' | 'unavailable';
    requireMoveChild?: true; approvalDecisionActorAccountId?: string; machineCustodianAccountId?: string; machineRole?: 'manage' | 'use';
    deploymentRuntimeMachine?: true; waiveDeploymentChild?: true; additionalActionIds?: readonly ActionId[];
    /** Allowed on every surface, as the Actions settings page writes it. */
    allowedActionIds?: readonly ActionId[];
    workspaceReturn?: Readonly<{
      sessions: Map<string, ReturnType<typeof createSessionRecordFixture>>;
      openTarget: NonNullable<import('@/api/apiMachine').ApiMachineClientLifecycleDependencies['openManagedProjectWorkspace']>;
    }>;
  }>) {
  const returnFixture = cliPolicy?.workspaceReturn;
  const serviceAction = actionId.startsWith('localServices.') || actionId.startsWith('machines.services.')
    || actionId === 'projects.service.relocate';
  const ingressRefusals = vi.spyOn(logger, 'warnLocalFile');
  const deploymentAction = actionId.startsWith('deployments.') || actionId === 'projects.readiness.read';
  const workflowAction = actionId === 'workflow.trigger.run_now' || actionId === 'workflow.run.start';
  let deploymentChildDelivery: ((job: ReturnType<typeof DeploymentChildRpcV1Schema.parse>, result: unknown) => Promise<void>) | undefined;
  vi.spyOn(syncClient, 'createHappierSocket').mockImplementation(params => {
    // Substitute only the Home socket boundary; the transport adapter, RPC
    // codecs and real loopback requester-currentness connection remain real.
    if (params.clientType !== 'machine-scoped' && params.endpoint.startsWith('http://127.0.0.1:')
      || !socketBoundary.create.getMockImplementation()) return createHomeSocket(params);
    const socket = socketBoundary.create(params.endpoint, { auth: { ...params.authExtras,
      token: params.token, clientType: params.clientType, ...(params.clientType === 'machine-scoped' ? { machineId: params.machineId } : {}) } });
    return { socket, transport: syncClient.createSocketTransportAdapter(socket, { connectTimeoutMs: params.connectTimeoutMs }) };
  });
  const currentnessChannel = worker || cliPolicy?.machineCustodianAccountId ? await createRequesterCurrentnessSocketHarness() : undefined;
  if (currentnessChannel) onTestFinished(() => currentnessChannel.close());
  const directory = await mkdtemp(join(tmpdir(), 'happier-action-composition-'));
  const rootPath = join(directory, 'accepted');
  await mkdir(rootPath); await writeFile(join(rootPath, 'original'), bytes);
  if (actionId === 'projects.script.run' || worker) {
    await writeFile(join(rootPath, 'Makefile'), 'check:\n\t@echo replay-admitted\n');
    await mkdir(join(rootPath, '.happier'));
    await writeFile(join(rootPath, '.happier/project.json'), JSON.stringify({ version: 1,
      ...(setup ? { workspace: { setup: [{ kind: 'command', command: 'echo setup-reviewed' }] } } : {}),
      scripts: { lint: { ...(worker ? { execution: 'portable' } : {}), source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'check' } } },
      ...(actionId === 'projects.service.relocate' ? { services: { web: { execution: 'portable', source: {
        kind: 'command', command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"` } } } } : {}) }));
  }
  if (actionId === 'localServices.launcher.start' || actionId === 'localServices.actions.restartManaged') {
    const serviceName = actionId === 'localServices.launcher.start' ? 'checked' : 'web';
    await mkdir(join(rootPath, '.happier'), { recursive: true });
    await writeFile(join(rootPath, '.happier/project.json'), JSON.stringify({ version: 1,
      ...(setup ? { workspace: { setup: [{ kind: 'command', command: 'echo setup-reviewed' }] } } : {}),
      services: { [serviceName]: { ...(worker ? { execution: 'portable' } : {}),
        source: { kind: 'command', command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"` } } } }));
  }
  await writeFile(join(directory, 'outside'), 'outside unchanged');
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_MACHINE_RPC_WORKING_DIRECTORY',
    'HAPPIER_ACTIONS_SETTINGS_V1']);
  env.patch({ HAPPIER_HOME_DIR: join(directory, 'srv_n2'), HAPPIER_ACTIVE_SERVER_ID: 'srv_n2',
    HAPPIER_SERVER_URL: 'https://home.example.test',
    // A Machine-only shell uses the host's default directory, outside the
    // disposable Project tree. Only its OS PTY boundary is substituted below.
    HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: actionId === 'machines.terminal.open'
      ? `${directory},${resolveMachineRpcWorkingDirectory()}` : directory });
  reloadConfiguration();
  expect(configuration.activeServerId).toBe('srv_n2');
  const terminalProvenance = AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' });
  const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: cliPolicy?.machineCustodianAccountId ?? 'account', tokenEpoch: 1,
    provenance: terminalProvenance })).toString('base64url') + '.installed-signature';
  // The app's original Account HTTP request has current provenance. The
  // installed daemon keeps its independent retained credential fixture.
  const uiToken = home?.token ?? 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url') + '.signature';
  const cliToken = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: terminalProvenance })).toString('base64url') + '.signature';
  const foreignReviewerToken = cliPolicy?.approvalDecisionActorAccountId ? 'fixture.' + Buffer.from(JSON.stringify({
    sub: cliPolicy.approvalDecisionActorAccountId, tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' },
  })).toString('base64url') + '.reviewer-signature' : undefined;
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  await updateSettings(settings => ({ ...settings, activeServerId: 'srv_n2', servers: { srv_n2: { id: 'srv_n2', name: 'Home',
    homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
      canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] }),
    serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 } } }));
  await writeStoredCredentialsForServerId('srv_n2', credentials);
  const installation = await readOrCreateInstallationIdentity();
  const sourceKeys = tweetnacl.sign.keyPair();
  const sourceInstallation = { version: 1 as const, installationId: 'source-installation', createdAt: 1,
    publicKey: Buffer.from(sourceKeys.publicKey).toString('base64url'), privateKey: Buffer.from(sourceKeys.secretKey).toString('base64url') };
  const rpcInstallation = new AsyncLocalStorage<typeof installation>();
  const deploymentRuntime = cliPolicy?.deploymentRuntimeMachine
    ? { machineId: 'remote-runtime', installation: sourceInstallation } : undefined;
  if (worker || deploymentRuntime) vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(() => rpcInstallation.getStore() ?? installation);
  const privateKey = Buffer.from(installation.privateKey, 'base64url');
  const publicKey = Buffer.from(installation.publicKey, 'base64url');
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const ref = { id: 'workspace', serverId: homeId, machineId: worker && !sameMachineWorker ? 'source-machine' : target.machineId, rootPath, projectKey: 'project', createdAtMs: 1 };
  const workerRoot = join(directory, 'worker');
  if (worker) await mkdir(workerRoot);
  const workerRef = { ...ref, id: 'worker-ref', machineId: target.machineId, rootPath: workerRoot };
  const basePolicy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const relationship = WorkspaceSyncRelationshipV1Schema.parse({ v: 1, relationshipId: 'source-worker', controllerMachineId: ref.machineId,
    alphaWorkspaceRefId: ref.id, betaWorkspaceRefId: workerRef.id, mode: 'keep_synced', enabled: true,
    provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: ref.id, targetWorkspaceRefId: workerRef.id },
    contentPolicy: { ...basePolicy, policyDigest: computeWorkspaceSyncPolicyDigest(basePolicy) }, createdAtMs: 1, updatedAtMs: 1 });
  const refKey = { kind: 'workspace-ref' as const, serverId: homeId, id: ref.id };
  const organizationKey = { kind: 'project-organization' as const, serverId: homeId, projectKey: 'project' };
  const rows: ProjectAccountRowV1[] = [
    { key: refKey, revision: 2, content: { t: 'plain', v: { key: refKey, value: ref } } },
    { key: organizationKey, revision: 2, content: { t: 'plain', v: { key: organizationKey, value: { hidden: false, pinned: false,
      promptStack: [{ id: 'context-entry', enabled: true, placement: 'system_append', ref: { kind: 'doc', artifactId: 'context-doc' } }] } } } },
  ].map(row => ProjectAccountRowV1Schema.parse(row));
  if (worker) {
    const key = { kind: 'workspace-ref' as const, serverId: homeId, id: workerRef.id };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 1, content: { t: 'plain', v: { key, value: workerRef } } }));
    const graphKey = { kind: 'relationship-graph' as const };
    rows.push(ProjectAccountRowV1Schema.parse({ key: graphKey, revision: 1, content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } }));
  }
  let sourceAccountId = 'account';
  let encryptionVersion = 1;
  let protectedMoveCredentials: (import('@/persistence').Credentials & {
    encryption: Extract<import('@/persistence').AccountEncryptionCredentials, { type: 'dataKey' }>;
  }) | undefined;
  let protectedMoveRows: ProjectAccountRowV1[] | undefined;
  let protectedMoveContentKeyFingerprint: string | null = null;
  let protectedMachineKeys: Readonly<{ source: string; worker: string }> | undefined;
  const publishedMachineContent = (machine: 'source' | 'worker') => {
    const mode: 'e2ee' | 'plain' = protectedMachineKeys ? 'e2ee' : 'plain';
    return { storageMode: mode, managedMachineRef: null,
      dataEncryptionKey: protectedMachineKeys?.[machine] ?? MACHINE_PLAIN_DATA_KEY_MARKER,
      access: { custodian: { accountId: machine === 'source' ? sourceAccountId : cliPolicy?.machineCustodianAccountId ?? 'account',
        displayName: machine === 'source' ? 'Source Account' : 'Account' },
        role: cliPolicy?.machineRole ?? 'manage', resourceMode: mode, accessState: 'ready' } };
  };
  // Home is the network boundary here; preparation and source dispatch stay real.
  const mintSyncAdmission = (requestedActionId: ActionId, envelope: ExternalActionRequestEnvelope) => {
    const reviewed = envelope.v === 1 ? projectWorkspaceSyncAdmissionInputV1(requestedActionId, envelope.input)
      : envelope.workspaceSyncAdmission;
    if (!reviewed) return {};
    expect(reviewed).toMatchObject({ sourceMachineId: ref.machineId, sourceWorkspaceRefId: ref.id });
    if (envelope.requestId === undefined) throw new Error('Sync source request id was not reviewed');
    const sourceIsReceiver = reviewed.sourceMachineId === target.machineId;
    const published = publishedMachineContent(sourceIsReceiver ? 'worker' : 'source');
    return { workspaceSyncAdmission: WorkspaceSyncAdmissionV1Schema.parse({
      relationshipId: reviewed.relationshipId ?? deriveWorkspaceSyncRelationshipId(envelope.requestId),
      sourceWorkspaceRefId: reviewed.sourceWorkspaceRefId,
      source: { actorAccountId: 'account', custodianAccountId: published.access.custodian.accountId,
        machineId: reviewed.sourceMachineId, installationId: sourceIsReceiver ? installation.installationId : sourceInstallation.installationId,
        role: published.access.role, encryptionMode: published.storageMode },
    }) };
  };
  const mintActionAdmission = (requestedActionId: ActionId, envelope: ExternalActionRequestEnvelope) => ({
    ...mintSyncAdmission(requestedActionId, envelope),
    ...(requestedActionId === 'approval.request.decide' ? {
      approvalDecisionAdmission: projectExternalActionApprovalDecisionAdmissionV1(envelope.v === 1 ? envelope.input : {}),
    } : {}),
  });
  const accountCurrentness = () => ({ mode: protectedMoveCredentials ? 'e2ee' as const : 'plain' as const,
    version: encryptionVersion, updatedAt: encryptionVersion, signingKeyFingerprint: null,
    contentKeyFingerprint: protectedMoveContentKeyFingerprint });
  const protectRequester = async () => {
    const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
    const recipientPublicKey = new Uint8Array(tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey);
    protectedMoveCredentials = { token: credentials.token, encryption: { ...material, publicKey: recipientPublicKey } };
    const sealMachineKey = () => Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
      recipientPublicKey, randomBytes: tweetnacl.randomBytes })).toString('base64');
    protectedMachineKeys = { source: sealMachineKey(), worker: sealMachineKey() };
    const sourceContent = publishedMachineContent('source');
    // The standalone SOURCE transport consumes its published Machine key at
    // the same content-adoption owner as the installed ApiMachine receiver.
    sourceRpc?.adoptEncryptionContext(resolvePublishedMachineEncryptionContext({ credentials: protectedMoveCredentials,
      machineId: ref.machineId, expectedAccountMode: sourceContent.storageMode, access: sourceContent.access,
      publishedDataEncryptionKey: sourceContent.dataEncryptionKey, machineKind: 'persistent',
      installationId: sourceInstallation.installationId }));
    protectedMoveContentKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(
      tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey);
    const plain = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: tweetnacl.randomBytes });
    const encrypted = createProjectAccountRowCipherV1({ mode: 'e2ee', material, randomBytes: tweetnacl.randomBytes });
    protectedMoveRows = rows.map(row => ({ ...row, content: row.content
      ? encrypted.seal(plain.open(row.key, row.content)) : row.content }));
    encryptionVersion++;
    await currentnessChannel?.push('account', accountCurrentness());
  };
  let copies = 0;
  let nativeStreamCopy = false;
  const nativeAgentRoots: Array<Readonly<{ machineId: string; rootPath: string }>> = [];
  let afterCopy: (() => Promise<void>) | undefined;
  const accountSettings = { actionsSettingsV1: { v: 1, actions: { ...(approval === 'ask'
    ? { [actionId]: { approvalRequiredSurfaces: cliPolicy?.askWithUiWaiver ? ['cli'] : ['ui', 'rpc', 'cli'] } }
    : approval === 'denied' ? { [actionId]: { enabled: false } } : {}),
    ...(cliPolicy?.requireMoveChild ? { 'localServices.launcher.start': { approvalRequiredSurfaces: ['ui', 'rpc', 'cli'] } } : {}),
    ...(setup && actionId === 'projects.service.relocate'
      ? { 'projects.prepare': { approvalRequiredSurfaces: ['ui', 'rpc', 'cli'] } } : {}) },
    ...(approval === 'allowed' ? { approvalWaivedSurfaces: { [actionId]: ['ui', 'rpc', 'cli', ...(deploymentAction ? ['mcp'] : [])],
      ...(cliPolicy?.waiveDeploymentChild ? { 'deployments.deploy': ['ui', 'rpc', 'cli', 'mcp'] } : {}) } }
      : cliPolicy?.askWithUiWaiver ? { approvalWaivedSurfaces: { [actionId]: ['ui'] } } : {}),
    ...(actionId === 'projects.service.relocate' ? { approvalWaivedSurfaces: {
      ...(approval === 'allowed' ? { [actionId]: ['ui', 'rpc', 'cli'] } : {}),
      'projects.service.placement.set': ['ui', 'rpc', 'cli'],
      ...(!cliPolicy?.requireMoveChild ? { 'localServices.launcher.start': ['ui', 'rpc', 'cli'] } : {}),
    } } : {}),
    ...(cliPolicy?.allowedActionIds ? { approvalWaivedSurfaces: Object.fromEntries(cliPolicy.allowedActionIds
      .map(id => [id, ['ui', 'rpc', 'cli', 'mcp']])) } : {}) } };
  let artifact: Readonly<Record<string, unknown>> | undefined;
  let servicePlacementContent: WorkspaceExecutionConfigContentV1 | null = null;
  let servicePlacementRevision = 0;
  let source: ProjectSourceV1 | null = { id: 'source', revision: 2, name: 'App', repository, audience: [], createdByAccountId: 'account' };
  const networkPaths: string[] = [];
  const rpcOutcomes: unknown[] = [];
  let originalMoveIngress: ((request: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>) => Promise<Awaited<ReturnType<typeof executeExternalAction>>>) | undefined;
  const homeRequest = (method: 'GET' | 'POST', path: string, body: unknown, headers: unknown) => {
    if (!home || !headers || typeof headers !== 'object') return null;
    // projectAccountRows spends the sealed own-UI Account credential for its exact-row read.
    const ownAccountRowRead = path === '/v1/account/project-rows/read' && Reflect.get(headers, 'Authorization') === `Bearer ${home.token}`;
    if (!Object.hasOwn(headers, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER) && !ownAccountRowRead) return null;
    return home.request({ method, path, ...(body === undefined ? {} : { body }), headers: Object.fromEntries(
      Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
  };
  let trustRead: Promise<void> = Promise.resolve();
  let releaseTrustRead = () => {};
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    networkPaths.push('GET ' + path);
    if (deploymentRuntime && path === '/v2/account/settings') rpcOutcomes.push({ phase: 'fixture.settingsRead',
      installationId: (rpcInstallation.getStore() ?? installation).installationId });
    const admitted = homeRequest('GET', path, undefined, options?.headers);
    if (admitted) return await admitted;
    const returnSession = returnFixture?.sessions.get(path.slice('/v2/sessions/'.length));
    if (path.startsWith('/v2/sessions/') && returnSession) return { status: 200, data: { session: returnSession } };
    if (actionId === 'machines.terminal.open' && path === '/v2/sessions/owner-session') return { status: 200, data: { session: {
      ...createSessionNotificationContextFixture('owner-session'), encryptionMode: 'plain',
      metadata: JSON.stringify({ machineId: 'machine', path: rootPath }),
    } } };
    // Home's record of the Agent Session that asks for Move on the SOURCE (owner access).
    if (path === '/v2/sessions/move-agent-session') return { status: 200, data: { session: createSessionRecordFixture({
      id: 'move-agent-session', active: true, encryptionMode: 'plain', dataEncryptionKey: null, share: null,
      metadata: JSON.stringify({ machineId: 'source-machine', permissionMode: 'default', permissionModeUpdatedAt: 1 }) }) } };
    if (path === '/v1/account/profile') return { status: 200, data: { id:
      foreignReviewerToken && options?.headers?.Authorization === `Bearer ${foreignReviewerToken}` ? cliPolicy?.approvalDecisionActorAccountId
        : options?.headers?.Authorization === `Bearer ${token}` ? cliPolicy?.machineCustodianAccountId ?? 'account' : 'account' } };
    if (path === '/v1/account/security') return { status: 200, data: AccountSecurityGetResponseV1Schema.parse({
      v: 1, encryptionMode: accountCurrentness().mode, nativeEmail: null,
      password: { status: 'not_enrolled', revision: null },
    }) };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: accountCurrentness().mode, updatedAt: encryptionVersion } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: accountCurrentness() };
    if (path === '/v2/account/settings') return { status: 200, data: { content: protectedMoveCredentials
      ? prepareAccountSettingsV2Content({ credentials: protectedMoveCredentials, raw: accountSettings, envelopeKind: 'encrypted' })
      : { t: 'plain', v: accountSettings }, version: 1 } };
    if (path === '/v2/changes') return { status: 200, data: { changes: [], nextCursor: 0 } };
    if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200,
      data: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [] }) };
    if (path === '/v1/artifacts') return { status: 200, data: artifact ? [artifact] : [] };
    if (artifact && path === '/v1/artifacts/' + artifact.id) return foreignReviewerToken
      && options?.headers?.Authorization === `Bearer ${foreignReviewerToken}`
      ? { status: 404, data: { error: 'Artifact not found' } } : { status: 200, data: artifact };
    if (path.startsWith('/v1/artifacts/')) return { status: 404, data: { error: 'Artifact not found' } };
    if (path === '/v1/account/authoring-memory') return { status: 200, data: { rows: [] } };
    if (deploymentRuntime && path === `/v1/machines/${deploymentRuntime.machineId}`) return { status: 200, data: { machine: {
      id: deploymentRuntime.machineId, kind: 'persistent', active: true, metadata: null, metadataVersion: 0,
      daemonState: null, daemonStateVersion: 0, installationId: sourceInstallation.installationId,
      installationPublicKey: Buffer.from(sourceKeys.publicKey).toString('base64'),
      revokedAt: null, replacedByMachineId: null, ...publishedMachineContent('source') } } };
    if (worker && path === '/v1/machines/source-machine') return { status: 200, data: { machine: { id: ref.machineId,
      kind: 'persistent', active: true,
      ...(options?.headers?.Accept === 'application/json;happier-machine-projection=host-facts' ? {}
        : { metadata: protectedMoveCredentials ? null : encodePlainMachineStoredContent({ host: ref.machineId,
          platform: process.platform, arch: process.arch, happyCliVersion: 'test', homeDir: directory, happyHomeDir: directory }) }),
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      installationId: 'source-installation', revokedAt: null, replacedByMachineId: null,
      installationPublicKey: Buffer.from(sourceKeys.publicKey).toString('base64'),
      ...publishedMachineContent('source') } } };
    if (path === '/v1/machines/machine') return { status: 200, data: { machine: { id: 'machine', kind: 'persistent', active: true,
      ...(options?.headers?.Accept === 'application/json;happier-machine-projection=host-facts' ? {}
        : { metadata: protectedMoveCredentials ? null : encodePlainMachineStoredContent({ host: target.machineId,
          platform: process.platform, arch: process.arch, happyCliVersion: 'test', homeDir: directory, happyHomeDir: directory }) }),
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      installationId: installation.installationId, installationPublicKey: publicKey.toString('base64'),
      revokedAt: null, replacedByMachineId: null, ...publishedMachineContent('worker') } } };
    if (path === '/v1/machines') return { status: 200, data: [{ id: 'machine', active: true, kind: 'persistent',
      installationId: installation.installationId, revokedAt: null, replacedByMachineId: null, ...publishedMachineContent('worker') },
      ...(deploymentRuntime ? [{ id: deploymentRuntime.machineId, active: true, kind: 'persistent',
        installationId: sourceInstallation.installationId, revokedAt: null, replacedByMachineId: null,
        ...publishedMachineContent('source') }] : []),
      ...(worker && !sameMachineWorker ? [{ id: ref.machineId, active: true, kind: 'persistent', installationId: 'source-installation',
        revokedAt: null, replacedByMachineId: null, ...publishedMachineContent('source') }] : [])] };
    throw new Error('Unexpected Home GET ' + path);
  });
  const networkFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return networkFetch(url, options);
    const path = new URL(String(url)).pathname;
    networkPaths.push('FETCH ' + path);
    if (path !== '/v1/features' && path !== '/v1/features/authenticated') throw new Error('Unexpected Home fetch ' + path);
    return Response.json({ features: workflowAction ? { workflows: { enabled: true }, automations: { enabled: true } }
      : deploymentAction ? { deployments: { enabled: true } }
      : serviceAction ? { localServices: { enabled: true,
      inventory: { enabled: true }, launcher: { enabled: true }, actions: { enabled: true }, managed: { enabled: true }, preview: { enabled: true } },
      browser: { enabled: true, viewTargets: { enabled: true } } } : {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } });
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    const path = new URL(String(url)).pathname;
    networkPaths.push('POST ' + path);
    const admitted = homeRequest('POST', path, body, options?.headers);
    if (admitted) return await admitted;
    const additionalActionId = cliPolicy?.additionalActionIds?.find(id => path === `/v1/actions/${id}`
      || path === `/v1/actions/${id}/execution-authorization`);
    if (path === '/v1/actions/projects.worker.copy.inspect/execution-authorization'
      || path === '/v1/actions/projects.worker.status/execution-authorization'
      || path === '/v1/actions/approval.request.decide/execution-authorization'
      || path === `/v1/actions/${actionId}/execution-authorization`
      || additionalActionId && path === `/v1/actions/${additionalActionId}/execution-authorization`
      || path === '/v1/actions/projects.inspect/execution-authorization'
      || path === '/v1/actions/projects.execution.output.read/execution-authorization'
      || path === '/v1/actions/projects.execution.output.copy/execution-authorization'
      || Object.keys(PROJECT_FINITE_ACTION_RPC_METHODS_V1).some(id => path === `/v1/actions/${id}/execution-authorization`)) {
      const requestedActionId = path === '/v1/actions/approval.request.decide/execution-authorization' ? 'approval.request.decide'
        : path === '/v1/actions/projects.worker.copy.inspect/execution-authorization' ? 'projects.worker.copy.inspect'
        : path === '/v1/actions/projects.worker.status/execution-authorization' ? 'projects.worker.status'
        : path === '/v1/actions/projects.inspect/execution-authorization' ? 'projects.inspect'
        : path === '/v1/actions/projects.execution.output.read/execution-authorization' ? 'projects.execution.output.read'
        : path === '/v1/actions/projects.execution.output.copy/execution-authorization' ? 'projects.execution.output.copy' : additionalActionId ?? actionId;
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const authentication = { kind: options?.headers?.Authorization === `Bearer ${cliToken}` || options?.headers?.Authorization === `Bearer ${token}`
        ? 'terminal' as const : 'account' as const, tokenEpoch: 1 };
      const actorAccountId = foreignReviewerToken && options?.headers?.Authorization === `Bearer ${foreignReviewerToken}`
        ? cliPolicy!.approvalDecisionActorAccountId! : 'account';
      if (requestedActionId === 'approval.request.decide' && actorAccountId !== 'account') {
        rpcOutcomes.push({ phase: 'approval.reviewer.admission', actorAccountId });
      }
      const admissionInput = { actionId: requestedActionId, envelope: request.envelope };
      const deploymentReadAdmission = projectExternalActionDeploymentReadEnvelopeAdmissionV1(admissionInput);
      const deploymentPreparationAdmission = projectExternalActionDeploymentPreparationEnvelopeAdmissionV1(admissionInput);
      return { status: 200, data: home ? await home.mintAuthorization(requestedActionId, request.envelope, authentication)
        : ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `${requestedActionId}-home-root`, binding: {
          accountId: actorAccountId, custodianAccountId: cliPolicy?.machineCustodianAccountId ?? 'account', authentication,
          admittedMachineRole: cliPolicy?.machineRole ?? 'manage',
          ...mintActionAdmission(requestedActionId, request.envelope),
          ...(deploymentReadAdmission ? { deploymentReadAdmission } : {}),
          ...(deploymentPreparationAdmission ? { deploymentPreparationAdmission } : {}),
          // Home binds an installed Session's verified origin and source into its root.
          ...(request.sessionActionOrigin && request.sessionActionSource ? {
            sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource } : {}),
          accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: request.machineId,
          installationId: request.machineId === target.machineId ? installation.installationId : 'source-installation', actionId: requestedActionId, requestId: request.envelope.requestId,
          ...(request.envelope.idempotencyKey === undefined ? {} : { idempotencyKey: request.envelope.idempotencyKey }),
          target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        } }) };
    }
    if (path === '/v1/actions/projects.worker.status' || path === '/v1/actions/projects.worker.copy.inspect' || path === '/v1/actions/projects.inspect'
      || path === '/v1/actions/approval.request.decide'
      || path === `/v1/actions/${actionId}`
      || additionalActionId && path === `/v1/actions/${additionalActionId}`
      || path === '/v1/actions/projects.execution.output.read' || path === '/v1/actions/projects.execution.output.copy'
      || Object.keys(PROJECT_FINITE_ACTION_RPC_METHODS_V1).some(id => path === `/v1/actions/${id}`)) {
      const requestedActionId = path === '/v1/actions/approval.request.decide' ? 'approval.request.decide'
        : path === '/v1/actions/projects.worker.status' ? 'projects.worker.status'
        : path === '/v1/actions/projects.worker.copy.inspect' ? 'projects.worker.copy.inspect'
        : path === '/v1/actions/projects.inspect' ? 'projects.inspect'
        : path === '/v1/actions/projects.execution.output.read' ? 'projects.execution.output.read'
        : path === '/v1/actions/projects.execution.output.copy' ? 'projects.execution.output.copy' : additionalActionId ?? actionId;
      const originalStatus = requestedActionId === 'projects.worker.status' ? ExternalActionRequestEnvelopeV1Schema.safeParse(body) : null;
      const request = originalStatus?.success ? (() => {
        const envelope = originalStatus.data;
        const authentication = { kind: options?.headers?.Authorization === `Bearer ${token}` ? 'terminal' : 'account', tokenEpoch: 1 };
        const executionAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'worker-status-home-root', binding: {
          accountId: 'account', custodianAccountId: 'account', authentication, accountEncryptionMode: 'plain',
          serverIdentityId: homeId, machineId: target.machineId, installationId: installation.installationId,
          actionId: requestedActionId, requestId: envelope.requestId, target: envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } });
        return ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: target.machineId, envelope, executionAuthorization });
      })() : ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const authorization = request.executionAuthorization;
      rpcOutcomes.push({ phase: 'original.hostChild', actionId: requestedActionId,
        machineId: request.machineId, target: request.envelope.target });
      if (!authorization || !('authentication' in authorization.binding)) throw new Error('Missing inspection Account admission');
      if (originalMoveIngress && request.machineId === ref.machineId
        && (requestedActionId === 'projects.service.relocate' || requestedActionId === 'approval.request.decide')) {
        const result = await originalMoveIngress(request);
        if (result.kind === 'response') return { status: 200, data: result.response };
        const refusal = projectExternalActionHttpError(result.errorCode, result.requestId, undefined, undefined,
          undefined, undefined, result.failureCause, 'daemon');
        return { status: refusal.statusCode, data: refusal.payload };
      }
      if (requestedActionId === 'projects.inspect' && worker && request.machineId === ref.machineId) {
        const principal = { accountId: 'account', authority: resolveExternalActionRootInvocationAuthority(authorization),
          authentication: authorization.binding.authentication };
        const surface = authorization.binding.authentication.kind === 'terminal' ? 'cli' : 'ui';
        expect(authorization.binding).toMatchObject({ actionId: 'projects.inspect', requestId: request.envelope.requestId,
          machineId: ref.machineId, installationId: sourceInstallation.installationId,
          target: { kind: 'machine', machineId: ref.machineId } });
        const result = await rpcInstallation.run(sourceInstallation, () => executeExternalAction({ actionId: requestedActionId,
          envelope: request.envelope,
          principal, surface, executionAuthorization: authorization,
          currentMachineId: ref.machineId, currentServerId: 'srv_n2', currentServerHttpBaseUrl: params.serverHttpBaseUrl,
          currentInstallationId: sourceInstallation.installationId,
          externalActionMachineRequestPrivateKey: sourceInstallation.privateKey, verifyExecutionAuthorization: verifySourceRoot,
          resolveTarget, executor: sourceExecutor, prepareRequesterAccountContext: prepareSourceRequester }));
        if (result.kind !== 'response' || result.response.v !== 1) throw new Error('SOURCE inspection ingress refused');
        rpcOutcomes.push({ phase: 'installed.sourceInspection', actionId: authorization.binding.actionId,
          requestId: authorization.binding.requestId, machineId: authorization.binding.machineId,
          installationId: authorization.binding.installationId, ok: result.response.execution.ok,
          requesterContextOpensForSource: openExternalActionRequesterAccountContextV1({ authorization,
            purpose: { kind: 'external_action' }, machineId: ref.machineId, installationId: sourceInstallation.installationId,
            serverIdentityId: homeId, installationPrivateKey: Buffer.from(sourceInstallation.privateKey, 'base64url') }) !== null,
          requesterContextOpensForWorker: openExternalActionRequesterAccountContextV1({ authorization,
            purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: installation.installationId,
            serverIdentityId: homeId, installationPrivateKey: privateKey }) !== null,
          ...(result.response.execution.ok ? {} : { errorCode: result.response.execution.errorCode }) });
        return { status: 200, data: result.response };
      }
      const result = await executeExternalAction({ actionId: requestedActionId, envelope: request.envelope,
        // Home's readExternalActionRequestPrincipal retains the terminal token's
        // automation floor. The receiving host must consume its sealed invocation.
        principal: { accountId: authorization.binding.accountId, authority: authorization.binding.authentication.kind === 'terminal'
          ? 'account_automation' : resolveExternalActionRootInvocationAuthority(authorization), authentication: authorization.binding.authentication },
        surface: authorization.binding.authentication.kind === 'terminal' ? 'cli' : 'ui',
        executionAuthorization: authorization, currentMachineId: target.machineId, currentServerId: 'srv_n2',
        currentServerHttpBaseUrl: params.serverHttpBaseUrl, currentInstallationId: installation.installationId,
        externalActionMachineRequestPrivateKey: privateKey, verifyExecutionAuthorization: verifyRoot,
        resolveTarget, executor: owner, prepareRequesterAccountContext: prepareRequester });
      if (result.kind === 'invalid_request') {
        const refusal = projectExternalActionHttpError(result.errorCode, result.requestId, undefined, undefined,
          undefined, undefined, result.failureCause, 'daemon');
        return { status: refusal.statusCode, data: refusal.payload };
      }
      if (result.response.v === 2) return { status: 200, data: result.response };
      const parsedInspection = requestedActionId === 'projects.inspect' && result.response.execution.ok
        ? ProjectDefinitionInspectOutputSchema.safeParse(result.response.execution.result) : null;
      rpcOutcomes.push({ actionId: requestedActionId, ok: result.response.execution.ok, valid: parsedInspection?.success,
        ...(!result.response.execution.ok ? { errorCode: result.response.execution.errorCode }
          : parsedInspection && !parsedInspection.success ? { issues: parsedInspection.error.issues.map(issue => ({ code: issue.code, path: issue.path })) } : {}) });
      return { status: 200, data: result.response };
    }
    if (path === '/v1/artifacts') {
      const input = readCarrierMutation(body);
      artifact = { ...input, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
        publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: { ...artifact, created: true } };
    }
    if (artifact && path === '/v1/artifacts/' + artifact.id) {
      const input = readCarrierMutation(body);
      if (input.expectedHeaderVersion !== artifact.headerVersion || input.expectedBodyVersion !== artifact.bodyVersion) {
        return { status: 409, data: { success: false, error: 'version-mismatch' } };
      }
      const headerVersion = Number(artifact.headerVersion) + 1; const bodyVersion = Number(artifact.bodyVersion) + 1;
      artifact = { ...artifact, ...input, headerVersion, bodyVersion };
      return { status: 200, data: { success: true, headerVersion, bodyVersion } };
    }
    if (path.includes('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
    if (worker && path.endsWith('/admission/verify')) {
      const destination = body && typeof body === 'object' && Reflect.get(body, 'workspaceSyncSourceRouting')
        && path.includes('/machine/') ? { machineId: ref.machineId, installationId: sourceInstallation.installationId,
          installationPublicKey: sourceInstallation.publicKey } : undefined;
      return { status: 200, data: { v: 1, ok: true, ...(destination ? { destinationInstallation: destination } : {}) } };
    }
    if (path.endsWith('/verify')) return { status: 200, data: { v: 1, ok: true } };
    if (path === '/v1/account/project-trust/read') {
      await trustRead;
      return { status: 200, data: { status: 'absent' } };
    }
    if (path === '/v1/account/project-rows/list' || path === '/v1/account/project-rows/read') {
      if (path.endsWith('/read')) {
        const { key } = ProjectAccountRowReadRequestV1Schema.parse(body);
        const row = (protectedMoveRows ?? rows).find(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(key));
        return { status: 200, data: ProjectAccountRowReadResponseV1Schema.parse(!row ? { status: 'absent' }
          : row.content === null ? { status: 'deleted', revision: row.revision } : { status: 'present', row }) };
      }
      return { status: 200,
        data: ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: protectedMoveRows ?? rows }) };
    }
    if (path === '/v1/account/project-rows/mutate') {
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changes: ProjectAccountRowV1[] = [];
      for (const mutation of request.mutations) {
        const prior = rows.find(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(mutation.key));
        if (mutation.expectedRevision !== (prior?.revision ?? 'absent')) return { status: 409, data: { status: 'conflict',
          key: mutation.key, revision: prior?.revision ?? -1 } };
        changes.push({ key: mutation.key, revision: (prior?.revision ?? -1) + 1, content: mutation.content });
      }
      for (const row of changes) {
        const index = rows.findIndex(prior => buildProjectAccountRowPhysicalKeyV1(prior.key) === buildProjectAccountRowPhysicalKeyV1(row.key));
        if (index < 0) rows.push(row); else rows[index] = row;
      }
      // The production row writer's output must also satisfy the server response
      // consumer; parsing only the request would hide response-shape drift.
      return { status: 200, data: ProjectAccountRowMutationResponseV1Schema.parse({ status: 'updated', rows: changes, cursor: 3 }) };
    }
    throw new Error('Unexpected Home POST ' + path);
  });
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    const path = new URL(String(request.url)).pathname;
    networkPaths.push(String(request.method) + ' ' + path);
    const admitted = request.method === 'GET' || request.method === 'POST'
      ? homeRequest(request.method === 'GET' ? 'GET' : 'POST', path, request.data, request.headers) : null;
    if (admitted) return await admitted;
    // Home answer: this Account has no Action automations.
    if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) return { status: 200,
      data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    if (path === '/v1/machines/managed/actions/list') {
      expect(ManagedListInputV1Schema.parse(request.data).homeId).toBe(homeId);
      // This Home fixture enrolls personal Machines, not managed provisions.
      return { status: 200, data: ManagedListOutputV1Schema.parse({ machines: [] }) };
    }
    if (request.method === 'POST' && path === '/v1/deployments/pending/cancel') {
      expect(ActionOperationAddressV1Schema.parse(request.data)).toMatchObject({ serverId: homeId, machineId: target.machineId });
      // This Home fixture has no persisted pending deployment for any requester.
      return { status: 200, data: ActionOperationCancelV1ResponseSchema.parse({ kind: 'not_found' }) };
    }
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: accountCurrentness().mode, updatedAt: encryptionVersion } };
    if (path === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) return { status: 200,
      data: WorkspaceExecutionConfigReadResponseV1Schema.parse(servicePlacementContent
        ? { status: 'present', revision: servicePlacementRevision, content: servicePlacementContent }
        : actionId === 'projects.compute.exec'
        ? { status: 'present', revision: 1, content: { t: 'plain', v: { enabled: false,
          unavailable: 'ask', allowAdHoc: true, scriptOverrides: {}, services: {} } } }
        : { status: 'absent' }) };
    if (actionId === 'projects.service.relocate' && path === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/mutate`) {
      const mutation = WorkspaceExecutionConfigMutationRequestV1Schema.parse(request.data);
      expect(mutation.expectedRevision).toBe(servicePlacementContent ? servicePlacementRevision : 'absent');
      servicePlacementContent = mutation.content;
      return { status: 200, data: { status: 'updated', revision: ++servicePlacementRevision, cursor: servicePlacementRevision } };
    }
    if (path === '/v1/auth/api-tokens/list') return { status: 200, data: { tokens: [] } };
    if (path === '/v1/projects/sources') {
      if (request.method === 'GET') return { status: 200, data: { ok: true, sources: source ? [source] : [], coverage: { complete: true, nextCursor: null } } };
      const input = ProjectSourcesCreateInputV1Schema.parse(request.data);
      source = { id: 'created-source', revision: 1, name: input.name, repository: input.repository, audience: input.audience ?? [], createdByAccountId: 'account' };
      return { status: 201, data: { ok: true, source, canManage: true } };
    }
    if (path === '/v1/projects/sources/source' && source) {
      if (request.method === 'GET') return { status: 200, data: { ok: true, source, canManage: true } };
      if (request.method === 'PATCH') {
        const input = ProjectSourcesUpdateInputV1Schema.parse(request.data);
        if (input.expectedRevision !== source.revision) return { status: 409, data: { ok: false, error: 'source_conflict', current: source } };
        source = { ...source, name: input.patch.name ?? source.name, revision: source.revision + 1 };
        return { status: 200, data: { ok: true, source, canManage: true } };
      }
      const input = ProjectSourcesDeleteInputV1Schema.parse(request.data);
      expect(input.expectedRevision).toBe(source.revision);
      const revision = source.revision + 1; source = null;
      return { status: 200, data: { ok: true, sourceId: 'source', revision } };
    }
    throw new Error('Unexpected Home request ' + path);
  });
  const finiteIngress: Array<{ rootActionId: string | null; accountId: string; homeId: string; installationId: string; current: boolean }> = [];
  const workerAdmission = createProjectWorkerAdmission({ machineId: target.machineId,
    admissionDrain: createDaemonAdmissionDrain(), readPolicy: async () => ({ status: 'ready',
      policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) });
  const nativeIo = createProjectNativeIo();
  const spawned: SetupBoundaryPty[] = [];
  const spawnWaiters = new Map<number, (pty: SetupBoundaryPty) => void>();
  let setupTerminals: TerminalPtySessionManager | undefined;
  if (setup || worker || actionId === 'machines.terminal.open' || Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId)) {
    // Substitute the OS boundary, preserving one installed terminal store for
    // both the finite producer and the authenticated output RPC consumer.
    vi.spyOn(ptyBoundary, 'createNodePtyProvider').mockReturnValue({ spawn(params) {
      const index = spawned.length;
      const pty = new SetupBoundaryPty(3456 + index, params.options.cwd);
      spawned.push(pty); spawnWaiters.get(index)?.(pty); spawnWaiters.delete(index);
      return pty;
    } });
    const probe = processBoundary.probeProcessGroupLiveness;
    vi.spyOn(processBoundary, 'probeProcessGroupLiveness').mockImplementation((...args) =>
      spawned.some(pty => pty.pid === args[0]) ? 'absent' : probe(...args));
    const terminate = processTerminationBoundary.terminateProcessTree;
    vi.spyOn(processTerminationBoundary, 'terminateProcessTree').mockImplementation(async input => {
      const pty = spawned.find(pty => pty.pid === input.pid);
      if (pty) pty.exit(0);
      else await terminate(input);
    });
  }
  let workerWorkspaceSync: ProductionDaemonWorkspaceSyncRuntime | undefined;
  let sourceWorkspaceSync: ProductionDaemonWorkspaceSyncRuntime | undefined;
  let pluginRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  let releaseProjection: (() => void) | undefined;
  let sessionsRole: Awaited<ReturnType<typeof activateSessionsRoleForMachineClient>> | undefined;
  const syncRuntimes: ProductionDaemonWorkspaceSyncRuntime[] = [];
  const syncDaemonRuntimes: ReturnType<typeof createDaemonWorkspaceSyncRuntime>[] = [];
  let harnessClosed = false;
  onTestFinished(async () => {
    if (harnessClosed) return;
    spawned.forEach(pty => pty.exit(0)); setupTerminals?.dispose();
    try {
      await sessionsRole?.stop();
      await Promise.all(syncRuntimes.map(syncRuntime => syncRuntime.stop()));
      await remoteDeploymentRuntime?.stopControlServer();
      await remoteDeploymentClient?.shutdown();
      await client.shutdown();
      releaseProjection?.();
      await pluginRuntime?.dispose();
    } finally {
      resetInMemoryAccountSettingsContextForTests();
      env.restore(); reloadConfiguration(); await rm(directory, { recursive: true, force: true });
    }
  });
  const client = new ApiMachineClient(token, { id: target.machineId, encryptionMode: 'plain', metadata: null,
    metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }, undefined, {
      installedCredentials: credentials,
      ...(returnFixture ? { openManagedProjectWorkspace: returnFixture.openTarget } : {}),
      get workspaceSync() { return workerWorkspaceSync?.workspaceSync; },
      get workspaceSyncHandoffAdapter() { return workerWorkspaceSync?.handoffAdapter; },
      createProjectFiniteRuntime: async (ports, ingress) => {
        setupTerminals = ports.terminalSessions;
        const runtime = await createInstalledProjectFiniteRuntime({ api, credentials, externalActionAccountId: cliPolicy?.machineCustodianAccountId ?? 'account',
          finiteServerId: 'srv_n2', finiteServerHttpBaseUrl: 'https://home.example.test', registeredMachineId: target.machineId,
          admission: workerAdmission, nativeIo: { ...nativeIo,
            ...(setupTerminals ? { commandIo: { ...nativeIo.commandIo, resolveTool: async tool => ({ executablePath: `/managed/${tool}`, version: '1' }) } } : {}) },
          successHomeDir: join(directory, 'setup-success'), resolveCurrentMachineExecutionOriginContext: resolveOrigin,
          isCurrent: async () => sameStoredCredentials(credentials, await readStoredCredentialsForServerId('srv_n2')),
          prepareBetween: async (request, signal, context) => {
            if (!workerWorkspaceSync) throw new Error('Missing installed worker Workspace Sync');
            const requester = readRequesterAccountActionContext(context?.callerInputAuthorization);
            rpcOutcomes.push({ phase: 'installed.prepareBetween', hasOriginalEnvelope: Boolean(context?.originalActionEnvelope),
              hasRequesterContext: requester !== null, hasMachineAdmission: Boolean(context?.machineAdmission),
              machineAdmissionCurrent: await context?.verifyMachineAdmissionCurrent?.(), requesterCurrent: await requester?.isCurrent() });
            try { return await workerWorkspaceSync.handoffAdapter.prepareBetween(request, signal, context); }
            catch (error) {
              rpcOutcomes.push({ phase: 'installed.prepareBetween.failure',
                code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
                error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack?.split('\n').slice(0, 5) : undefined });
              throw error;
            }
          },
        })(ports, ingress);
        if (runtime) finiteIngress.push({ rootActionId: ingress.callerInputAuthorization?.binding.actionId ?? null,
          accountId: runtime.accountId, homeId: runtime.accountAuthorization?.binding.serverIdentityId ?? homeId,
          installationId: ingress.machineAdmission!.installationId, current: await runtime.isCurrent!() });
        return runtime;
      },
    });
  const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing production RPC manager');
  const rpc = manager;
  const remoteDeploymentClient = deploymentRuntime ? rpcInstallation.run(sourceInstallation, () => new ApiMachineClient(token, {
    id: deploymentRuntime.machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0,
    daemonState: null, daemonStateVersion: 0 }, undefined, { installedCredentials: credentials })) : undefined;
  const remoteDeploymentManager: unknown = remoteDeploymentClient && Reflect.get(remoteDeploymentClient, 'rpcHandlerManager');
  if (remoteDeploymentClient && !(remoteDeploymentManager instanceof RpcHandlerManager))
    throw new Error('Missing production deployment RPC manager');
  const remoteDeploymentRpc = remoteDeploymentManager instanceof RpcHandlerManager ? remoteDeploymentManager : undefined;
  const admission = { actorAccountId: 'account', custodianAccountId: cliPolicy?.machineCustodianAccountId ?? 'account', machineId: target.machineId,
    installationId: installation.installationId, role: cliPolicy?.machineRole ?? 'manage', encryptionMode: 'plain' as const };
  let moveRequesterPreparation: NonNullable<ConstructorParameters<typeof RpcHandlerManager>[0]['prepareRequesterAccountContext']> | undefined;
  const sourceRpc: RpcHandlerManager | undefined = worker ? new RpcHandlerManager({ scopePrefix: ref.machineId, localMachineId: ref.machineId, encryptionMode: 'plain',
    authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: ref.machineId,
      // Production apiMachine resolves its Home from the current execution origin;
      // without it every requester-isolated SOURCE read is refused as unknown.
      resolveHomeServerIdentityId: async () => homeId,
      resolveCustodianAccountId: async () => sourceAccountId, resolveInstallationId: () => sourceInstallation.installationId,
      verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: sourceInstallation.privateKey,
        daemonToken: token, serverHttpBaseUrl: 'https://home.example.test',
        ...(input.workspaceSyncSourceRouting ? { workspaceSyncSourceReceiver: {
          machineId: ref.machineId, installationId: sourceInstallation.installationId } } : {}) }) }),
    prepareRequesterAccountContext: request => (moveRequesterPreparation ?? prepareSourceRequester)(request),
  }) : undefined;
  let installedSocket: ReturnType<typeof createApiSessionSocketStub> | undefined;
  let sourcePreparationDeliveryFailure: (() => never) | undefined;
  socketBoundary.create.mockImplementation((_url: unknown, options?: Readonly<{ auth?: Readonly<{ clientType?: string }> }>) => {
    const boundary = createApiSessionSocketStub({ emit(event, args, socket) {
      if (event !== SOCKET_RPC_EVENTS.REGISTER) return;
      const registration = args[0];
      if (registration && typeof registration === 'object' && 'method' in registration
        && typeof registration.method === 'string') {
        socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, { method: registration.method });
      }
    } });
    if (options?.auth?.clientType === 'machine-scoped') installedSocket = boundary;
    const socket = Object.assign(boundary, {
      emitWithAck: async (event: string, packet: Readonly<{ method: string; params: unknown; requestId?: string;
        originalActionEnvelope?: Parameters<typeof executeExternalAction>[0]['envelope'];
        externalActionExecution?: SocketRpcRequestPayload['externalActionExecution'] }>
        & Pick<RpcRequest, 'workspaceSyncSourceRouting' | 'workspaceSyncSourceWriterTargetRouting' | 'workspaceSyncTargetRouting'>) => {
        if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
          expect(MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(packet).machineId).toBe(target.machineId);
          return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse({ v: 1, result: 'success', revision: 1 });
        }
        if (event === 'machine-update-state') {
          const update = MachineUpdateStateRequestSchema.parse(packet);
          return MachineUpdateStateResponseSchema.parse({ result: 'success', version: update.expectedVersion + 1,
            daemonState: update.daemonState });
        }
        if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error('Unexpected socket event ' + event);
        const execution = packet.externalActionExecution;
        if (packet.method.includes('approval')) rpcOutcomes.push({ phase: 'approval.transport',
          method: packet.method, signedExecution: execution !== undefined });
        if (worker && packet.workspaceSyncSourceRouting) {
          if (!sourceRpc || !execution || !packet.requestId) throw new Error('Missing installed SOURCE packet');
          rpcOutcomes.push({ phase: 'installed.sourceDelivery', method: packet.method,
            originalEnvelopeVersion: packet.workspaceSyncSourceRouting.originalActionEnvelope?.v });
          const signer = execution.installationId === sourceInstallation.installationId ? sourceInstallation : installation;
          expect(execution.installationId).toBe(signer.installationId);
          expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
            requesterAccountContext: execution.authorization.requesterAccountContext, workspaceSyncSourceRouting: packet.workspaceSyncSourceRouting,
            effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
            event: SOCKET_RPC_EVENTS.CALL, method: packet.method, requestId: packet.requestId, params: packet.params,
            signature: execution.machineSignature, publicKey: Buffer.from(signer.publicKey, 'base64url') })).toBe(true);
          if (packet.method.endsWith(':' + RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN)) {
            sourcePreparationDeliveryFailure?.();
          }
          const deliver = (request: RpcRequest) => rpcInstallation.run(sourceInstallation, () => sourceRpc.handleRequest(request));
          if (home?.relayWorkspaceSource) return await home.relayWorkspaceSource({ ...packet,
            originalActionEnvelope: packet.originalActionEnvelope === undefined ? undefined
              : ExternalActionRequestEnvelopeSchema.parse(packet.originalActionEnvelope) }, deliver);
          const sourceContext = packet.workspaceSyncSourceRouting.sourceContext;
          // Home preserves the signed, possibly narrower caller ceiling. Using
          // the root's maximum authority here misrepresents Account automation.
          if (!sourceContext || !doesWorkspaceSyncSourceRootMatchRouting(execution.authorization, packet.workspaceSyncSourceRouting)) {
            throw new Error('Invalid SOURCE requester routing');
          }
          const result = await deliver({
            method: packet.method, params: packet.params, requestId: packet.requestId,
            workspaceSyncSourceRouting: packet.workspaceSyncSourceRouting,
            workspaceSyncSourceExecution: WorkspaceSyncSourceExecutionV1Schema.parse({ method: packet.method, params: packet.params, requestId: packet.requestId!,
              externalActionExecution: execution }), machineAdmission: packet.workspaceSyncSourceRouting!.sourceContext!.machineAdmission,
            callerAuthority: sourceContext.callerAuthority,
            ...(sourceContext.sessionActionOrigin ? { sessionActionOrigin: sourceContext.sessionActionOrigin } : {}),
            ...(sourceContext.callerInputConstraints ? { callerInputConstraints: sourceContext.callerInputConstraints } : {}),
            callerInputAuthorization: execution.authorization });
          rpcOutcomes.push({ phase: 'installed.sourceResponse', machineId: ref.machineId,
            installationId: sourceInstallation.installationId, response: typeof result === 'string' ? 'sealed' : result });
          return { ok: true, result };
        }
        if (!execution && sourceRpc && packet.method.startsWith(ref.machineId + ':')) {
          const result = await rpcInstallation.run(sourceInstallation, () => sourceRpc.handleRequest({ method: packet.method,
            params: packet.params, requestId: packet.requestId, callerAuthority: 'present_user',
            machineAdmission: { ...admission, machineId: ref.machineId, installationId: sourceInstallation.installationId } }));
          return { ok: true, result };
        }
        if ((execution?.authorization.binding.actionId === 'projects.service.relocate'
          || execution?.authorization.binding.actionId === 'approval.request.decide'
            && packet.method === `${ref.machineId}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`) && ref.machineId !== target.machineId
          && (packet.method.startsWith(ref.machineId + ':') || packet.method.startsWith(target.machineId + ':'))) {
          // Home delivers both SOURCE inspection and destination inspection to
          // their actual installations; neither hop is a local controller read.
          const toSource = packet.method.startsWith(ref.machineId + ':');
          const receiver = toSource ? sourceRpc : rpc;
          if (!receiver) throw new Error('Missing Move child receiver');
          const receiverInstallation = toSource ? sourceInstallation : installation;
          const receiverAdmission = toSource
            ? { ...admission, machineId: ref.machineId, installationId: sourceInstallation.installationId } : admission;
          const signer = execution.authorization.binding.machineId === ref.machineId ? sourceInstallation : installation;
          expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
            requesterAccountContext: execution.authorization.requesterAccountContext, effectActionId: execution.effectActionId,
            target: execution.target, installationId: execution.installationId, event: SOCKET_RPC_EVENTS.CALL,
            ...(execution.reviewedChild ? { reviewedChild: execution.reviewedChild } : {}),
            ...(execution.deploymentChildRouting ? { deploymentChildRouting: execution.deploymentChildRouting } : {}),
            ...(execution.managedAdmission ? { managedAdmission: execution.managedAdmission } : {}),
            method: packet.method, requestId: packet.requestId!, params: packet.params,
            signature: execution.machineSignature, publicKey: Buffer.from(signer.publicKey, 'base64url') })).toBe(true);
          const result = await rpcInstallation.run(receiverInstallation, () => receiver.handleRequest({
            method: packet.method, params: packet.params, requestId: packet.requestId,
            callerAuthority: resolveExternalActionRootInvocationAuthority(execution.authorization), machineAdmission: receiverAdmission,
            callerInputAuthorization: execution.authorization,
            ...(packet.originalActionEnvelope ? { originalActionEnvelope: ExternalActionRequestEnvelopeSchema.parse(packet.originalActionEnvelope) } : {}),
            ...(execution.authorization.binding.actionId === 'projects.service.relocate' ? { workspaceSyncSourceExecution: WorkspaceSyncSourceExecutionV1Schema.parse({ method: packet.method,
              params: packet.params, requestId: packet.requestId, externalActionExecution: execution,
              originalActionEnvelope: packet.originalActionEnvelope }) } : {}),
          }));
          rpcOutcomes.push({ phase: 'installed.moveChildResponse', method: packet.method, result });
          return { ok: true, result };
        }
        const remoteDeploymentDelivery = remoteDeploymentRpc && deploymentRuntime
          && packet.method === `${deploymentRuntime.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
        const sourceDelivery = !execution && sourceRpc && ref.machineId !== target.machineId
          && packet.method.startsWith(ref.machineId + ':');
        const receiverMachineId = remoteDeploymentDelivery ? deploymentRuntime.machineId : sourceDelivery ? ref.machineId : target.machineId;
        const receiverInstallation = remoteDeploymentDelivery || sourceDelivery ? sourceInstallation : installation;
        const receiverRpc = remoteDeploymentDelivery ? remoteDeploymentRpc : sourceDelivery ? sourceRpc : rpc;
        if (execution?.authorization.requesterAccountContext && !remoteDeploymentDelivery) {
          const opensFor = (method: string) => openExternalActionRequesterAccountContextV1({ authorization: execution.authorization,
            purpose: { kind: 'machine_rpc', method, params: packet.params }, machineId: target.machineId,
            installationId: installation.installationId, serverIdentityId: homeId, installationPrivateKey: privateKey }) !== null;
          // Safe custody discriminator: never retain or print opened credentials.
          const unscopedMethod = packet.method.slice(target.machineId.length + 1);
          rpcOutcomes.push({ method: packet.method, rootActionId: execution.authorization.binding.actionId,
            mappedActionId: resolveMachineRpcExternalActionEffectV1(unscopedMethod, execution.authorization.binding),
            rootMachineMatches: execution.authorization.binding.machineId === target.machineId,
            rootInstallationMatches: execution.authorization.binding.installationId === installation.installationId,
            rootAccountMatches: execution.authorization.binding.accountId === admission.actorAccountId,
            rootCustodianMatches: execution.authorization.binding.custodianAccountId === admission.custodianAccountId,
            callerAuthority: resolveExternalActionRootInvocationAuthority(execution.authorization),
            custodyOpensForUnscopedMethod: opensFor(unscopedMethod),
            custodyOpensForScopedMethod: opensFor(packet.method) });
        }
        if (execution) expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
          requesterAccountContext: execution.authorization.requesterAccountContext,
          effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
          ...(execution.reviewedChild ? { reviewedChild: execution.reviewedChild } : {}),
          ...(execution.deploymentChildRouting ? { deploymentChildRouting: execution.deploymentChildRouting } : {}),
          ...(execution.managedAdmission ? { managedAdmission: execution.managedAdmission } : {}),
          event: SOCKET_RPC_EVENTS.CALL, method: packet.method, requestId: packet.requestId!, params: packet.params,
          signature: execution.machineSignature, publicKey }),
          `Machine RPC signature with requester custody=${Boolean(execution.authorization.requesterAccountContext)}`).toBe(true);
        const receivingAdmission = { ...admission, machineId: receiverMachineId,
          installationId: receiverInstallation.installationId,
          ...(execution ? { actorAccountId: execution.authorization.binding.accountId } : {}),
          ...(sourceDelivery ? { custodianAccountId: sourceAccountId } : {}) };
        const childDelivery = execution && packet.method === `${receiverMachineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`
          ? WorkspaceSyncSourceExecutionV1Schema.safeParse({ method: packet.method,
              params: packet.params, requestId: packet.requestId, externalActionExecution: execution,
              originalActionEnvelope: packet.originalActionEnvelope }) : undefined;
        if (childDelivery && !childDelivery.success) {
          rpcOutcomes.push({ phase: 'fixture.childDelivery', issues: childDelivery.error.issues.map(issue => ({ code: issue.code, path: issue.path })) });
          throw new Error('fixture_child_delivery_invalid');
        }
        if (remoteDeploymentDelivery) rpcOutcomes.push({ phase: 'fixture.deploymentChildReceive',
          machineId: receiverMachineId, installationId: receiverInstallation.installationId,
          kind: DeploymentChildRpcV1Schema.parse(packet.params).kind });
        const result = await rpcInstallation.run(receiverInstallation, () => receiverRpc.handleRequest({ method: packet.method, params: packet.params,
          ...(packet.requestId ? { requestId: packet.requestId } : {}),
          callerAuthority: execution ? resolveExternalActionRootInvocationAuthority(execution.authorization) : 'present_user',
          machineAdmission: receivingAdmission,
          ...(packet.originalActionEnvelope ? { originalActionEnvelope: ExternalActionRequestEnvelopeSchema.parse(packet.originalActionEnvelope) } : {}),
          ...(childDelivery?.success ? { workspaceSyncSourceExecution: childDelivery.data } : {}),
          ...(execution ? { callerInputAuthorization: execution.authorization } : {}) }));
        if (packet.method === `${receiverMachineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`) {
          await deploymentChildDelivery?.(DeploymentChildRpcV1Schema.parse(packet.params), result);
        }
        rpcOutcomes.push(result);
        return { ok: true, result };
      } });
    return socket;
  });
  const resolveTarget = createDaemonExternalActionTargetResolver({ credentials });
  const settings = createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse(accountSettings),
    allowEnvironmentOverride: false });
  const params = { token, credentials, sessionId: '', mode: 'plain' as const, ctx: null, serverId: 'srv_n2', serverIdentityId: homeId,
    serverHttpBaseUrl: 'https://home.example.test', actionsSettingsProvider: settings,
    externalActionMachineInstallationId: installation.installationId, externalActionMachineRequestPrivateKey: privateKey };
  // The real loopback Account-update channel also carries user-scoped RPCs.
  // Relay those through the same Home network boundary into installed handlers.
  currentnessChannel?.server.on('connection', socket => {
    socket.on(SOCKET_RPC_EVENTS.CALL, (packet: SocketRpcRequestPayload, ack: (response: unknown) => void) => {
      const boundary = socketBoundary.create(params.serverHttpBaseUrl, { auth: { clientType: 'user-scoped' } });
      void boundary.emitWithAck(SOCKET_RPC_EVENTS.CALL, packet).then(ack, (error: unknown) => {
        rpcOutcomes.push({ phase: 'fixture.deliveryError', error: error instanceof Error ? error.message : 'Fixture delivery failed' });
        ack({ ok: false, errorCode: 'fixture_rpc_delivery_failed', error: error instanceof Error ? error.message : 'Fixture delivery failed' });
      });
    });
  });
  const resolveOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: params.serverHttpBaseUrl,
    resolveCurrentMachineId: () => target.machineId });
  const verifyRoot: NonNullable<Parameters<typeof executeExternalAction>[0]['verifyExecutionAuthorization']> = input =>
    verifyExternalActionExecutionAuthorizationCurrent({ ...input, privateKey, installationId: installation.installationId,
      serverHttpBaseUrl: params.serverHttpBaseUrl });
  const verifySourceRoot: typeof verifyRoot = input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
    privateKey: sourceInstallation.privateKey, installationId: sourceInstallation.installationId,
    serverHttpBaseUrl: params.serverHttpBaseUrl });
  const api = await ApiClient.create(credentials);
  const sourceDefinitionAction = createProjectDefinitionAction({ serverId: 'srv_n2', machineId: ref.machineId,
    workingDirectory: rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [rootPath] }, nativeIo: {
      ...nativeIo.commandIo, resolveTool: async tool => ({ executablePath: `/managed/${tool}`, version: '1' }) },
    inspectSetup: async ({ workspace, context, reviewSetupConsent }) => {
      const authorization = context.externalActionExecutionAuthorization;
      const requesterCredentials = readRequesterAccountActionContext(authorization)?.credentials ?? credentials;
      const requester = { credentials: requesterCredentials, authorization, serverHttpBaseUrl: params.serverHttpBaseUrl };
      const association = await resolveProjectSetupAcceptedWorkspace({
        ...(authorization ? { authorization, effectActionId: authorization.binding.actionId } : { credentials: requesterCredentials }),
        serverHttpBaseUrl: params.serverHttpBaseUrl, address: workspace,
        serverId: homeId, signal: context.signal });
      return await inspectProjectSetup({ workspace: association.workspace, projectAssociation: association, requester,
        purpose: 'setup', approvalContext: context, platform: { os: process.platform, arch: process.arch },
        nativeIo: nativeIo.commandIo, successHomeDir: join(directory, 'source-setup-success'), signal: context.signal },
        reviewSetupConsent ? { reviewConsent: true } : undefined);
    } });
  const sourceParams = { ...params, externalActionMachineInstallationId: sourceInstallation.installationId,
    externalActionMachineRequestPrivateKey: sourceInstallation.privateKey, projectDefinitionAction: sourceDefinitionAction,
    machineActionDirectTargetTransport: { machineId: ref.machineId,
      invoke: (method: string, request: unknown, options: Parameters<RpcHandlerManager['invokeLocal']>[2]) => {
        if (!sourceRpc) throw new Error('Missing installed SOURCE RPC manager');
        return sourceRpc.invokeLocal(method, request, options);
      } } };
  const sourceExecutor = createActionExecutor(createCliActionDeps(sourceParams));
  const prepareSourceRequester: NonNullable<Parameters<typeof executeExternalAction>[0]['prepareRequesterAccountContext']> =
    request => prepareInstalledRequesterAccountActionContext({ ...request,
      ownCredentials: credentials,
      purpose: request.purpose ?? { kind: 'external_action' }, machineId: ref.machineId, serverId: 'srv_n2',
      serverHttpBaseUrl: params.serverHttpBaseUrl,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: ref.machineId }),
      createExecutor: context => createActionExecutor(createCliActionDeps({ ...sourceParams,
        token: context.credentials.token, credentials: context.credentials })) });
  if (sourceRpc) registerProjectDefinitionHandlers({ machineId: ref.machineId,
    rpcHandlerManager: sourceRpc, actionExecutor: sourceExecutor });
  if (sourceRpc) registerProjectOpenRpcHandlers(sourceRpc, { serverId: 'srv_n2', machineId: ref.machineId,
    runtime: { serverId: 'srv_n2', serverHttpBaseUrl: params.serverHttpBaseUrl, machineId: ref.machineId,
      accountId: 'account', readCredentials: async () => { throw new Error('Admitted Open must use its requester projection'); },
      setupPreparation: { nativeIo: nativeIo.commandIo, platform: { os: 'linux', arch: 'x64' } } } });
  const features = serviceAction || deploymentAction || workflowAction || actionId === 'machines.terminal.open'
    ? await api.getServerFeaturesSnapshot({ refresh: true }) : undefined;
  api.setServerFeaturesSnapshotProvider(() => features);
  if (actionId === 'machines.terminal.open') {
    await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force',
      honorAccountSettingsModeEnv: false, expectedAccountEncryptionMode: 'plain' });
  }
  const connectedAccountPurposeBindingRuntime = actionId === 'machines.terminal.open' ? (() => {
    const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials,
      getAccountEncryptionMode: options => api.getAccountEncryptionMode(options),
      secrets: createActiveAccountSettingsConnectedAccountSecrets({ expectedScopeKey: resolveAccountSettingsScopeKey(credentials) }),
    });
    const configurationOwner = createConnectedAccountDaemonConfigurationOwner({ reloadController: pluginReloadController,
      persistence: persistence.configuration });
    const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({ reloadController: pluginReloadController,
      credentials, getAccountEncryptionMode: (signal, options) => api.getAccountEncryptionMode({ ...options, signal }),
      configuration: persistence.configuration, configurationOwner });
    const directMaterial = createRequesterTeamCredentialDirectMaterialClient({ credentials,
      serverHttpBaseUrl: params.serverHttpBaseUrl, readAccountEncryptionMode: signal => api.getAccountEncryptionMode({ signal }) });
    return createDaemonConnectedAccountPurposeBindingRuntime({
      credentialOwnerAccountId: readAccountIdFromToken(credentials.token) ?? undefined,
      workerMachineId: target.machineId, coordinatorInventoryIsObserved: () => client.hasCurrentAccountChangesObserver(),
      establishedRuntimeOwner: established, reloadController: pluginReloadController,
      store: createActiveAccountSettingsConnectedAccountPurposeBindingStore({ credentials }),
      openTeamDirect: directMaterial.open,
      listTeamResources: createConnectedAccountActionTeamResourceCatalogReader({
        privateLabelOpen: createCliPrivateLabelActionOpener(credentials.encryption),
        homeDomainAction: (...args) => createAccountServerActionDeps({ token: credentials.token, credentials,
          serverId: 'srv_n2', serverHttpBaseUrl: params.serverHttpBaseUrl }).homeDomainAction!(...args),
      }),
      resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(features),
      resolveConnectedAccountEndpoints: request => established.readConfiguredEndpoints(request),
      qualifiedApi: {
        listAccountsForServices: (services, signal) => listQualifiedConnectedAccountsV4({ token: credentials.token, services, signal,
          requestPurpose: 'connected-accounts:daemon-coordinator' }),
        listAccounts: (service, signal) => listQualifiedConnectedAccountsV4({ token: credentials.token, service, signal,
          requestPurpose: 'connected-accounts:purpose-binding' }),
        listGroups: (service, signal) => listQualifiedConnectedAccountGroupsV4({ token: credentials.token, service, signal }),
        readGroup: (group, signal) => readQualifiedConnectedAccountGroupV4({ token: credentials.token, group, signal }),
      },
    });
  })() : undefined;
  if (worker) {
    // Installed reconciliation is scoped to the local profile; Workspace refs retain the portable Home identity.
    await readProjectAccountRows({ credentials, serverId: 'srv_n2', publication: 'installed' });
    const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
      canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] });
    const homeTarget = resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile',
      profile: { id: 'srv_n2', serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test', homeConnectionDescriptor: descriptor } });
    const composeSync = async (machineId: string) => {
      let nativeRuntime: ReturnType<typeof createDaemonWorkspaceSyncRuntime> | undefined;
      const sessions = new Map<string, MutagenSessionSummaryV1>();
      const nativeChanges = createMutagenChangeWaitBoundary();
      let endSidecar: (() => void) | undefined;
      const command = async (input: MutagenControlCommandV1, signal?: AbortSignal): Promise<unknown> => {
        if (input.t === 'wait_for_change') {
          if (!signal) throw new Error('Native change wait requires cancellation');
          return { stateIndex: await nativeChanges.waitForChange(input.previousStateIndex, signal) };
        }
        if (input.t === 'create' || input.t === 'flush') rpcOutcomes.push({ phase: 'native', machineId, command: input.t });
        if (input.t === 'shutdown') { endSidecar?.(); return null; }
        if (input.t === 'list') return { sessions: [...sessions.values()], nextCursor: null };
        if (input.t === 'create') {
          const endpoint = (value: string) => ({ protocol: 'external' as const, host: value.replace('external://', ''), path: '' as const,
            state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } });
          const session: MutagenSessionSummaryV1 = { identifier: input.session.name, name: input.session.name, labels: input.session.labels,
            alpha: endpoint(input.session.alpha), beta: endpoint(input.session.beta), mode: input.session.mode,
            paused: true, status: 'watching', successfulCycles: 0, conflictCount: 0 };
          sessions.set(session.identifier, session); nativeChanges.change(); return session;
        }
        if (input.t === 'terminate') { if (sessions.delete(input.sessionIdentifier)) nativeChanges.change(); return null; }
        const session = sessions.get(input.sessionIdentifier);
        if (!session) throw new Error('Missing native Sync session ' + input.sessionIdentifier);
        if (input.t === 'get_policy') return { selection: 'all_files', patterns: [], nextCursor: null };
        if (input.t === 'list_conflicts') return { totalCount: 0, shownCount: 0, truncatedCount: 0, conflicts: [], nextCursor: null };
        if (input.t === 'flush') {
          expect(machineId).toBe(ref.machineId);
          expect(session.labels['external.alpha_workspace_ref_id']).toBe(ref.id);
          expect(session.labels['external.beta_workspace_ref_id']).toBe(workerRef.id);
          // Mutagen is the genuine OS transfer boundary. Routing, native session,
          // target bootstrap, policy and root custody are owned by production.
          if (nativeStreamCopy) {
            if (!nativeRuntime) throw new Error('Missing native Sync runtime');
            const opened = nativeAgentRoots.length;
            const alpha = await nativeRuntime.openExternalStream({ endpointId: session.alpha.host, signal });
            try {
              const beta = await nativeRuntime.openExternalStream({ endpointId: session.beta.host, signal });
              try {
                const [source, destination] = nativeAgentRoots.slice(opened);
                if (!source || !destination) throw new Error('Missing native rooted agents');
                await cp(source.rootPath, destination.rootPath, { recursive: true });
              } finally { beta.destroy(); }
            } finally { alpha.destroy(); }
          } else await cp(rootPath, workerRoot, { recursive: true });
          copies++; await afterCopy?.();
        }
        const next = { ...session, paused: input.t === 'pause' ? true : input.t === 'resume' ? false : session.paused,
          successfulCycles: session.successfulCycles + (input.t === 'flush' ? 1 : 0) };
        sessions.set(next.identifier, next);
        if (next.paused !== session.paused || next.successfulCycles !== session.successfulCycles) nativeChanges.change();
        return next;
      };
      const overrides: Partial<ProductionDaemonWorkspaceSyncFactories> = {
        resolveRootOwnershipDirectory: () => join(directory, 'sync-root-locks'), stopRetainedNativeProcesses: async () => {},
        createDaemonRuntime: deps => {
          const runtime = createDaemonWorkspaceSyncRuntime({ ...deps,
            resolveInstalledComponentPaths: () => ({ currentPath: '/fixture-engine', resolvedCurrentPath: '/fixture-engine' }),
            resolveArtifactPaths: () => ({ managerPath: '/fixture-engine/manager', agentPath: '/fixture-engine/agent' }),
            assertArtifactPayload: () => ({ engineVersion: '0.18.1', protocolEpoch: 'external-stream-v1' }) });
          syncDaemonRuntimes.push(runtime);
          nativeRuntime = runtime;
          return runtime;
        },
        createBroker: async () => ({ bootstrapDescriptor: new Uint8Array([1]),
          waitForReady: async () => {}, command, close: async () => {} }),
        spawnSidecar: async () => {
          const terminated = new Promise<{ type: 'exited'; code: number }>(resolve => { endSidecar = () => resolve({ type: 'exited', code: 0 }); });
          return { pid: process.pid, waitForTermination: () => terminated, stop: async () => endSidecar?.() };
        },
        launchLocalAgent: async request => {
          const rootPath = request.args[request.args.indexOf('--root') + 1];
          if (!rootPath) throw new Error('Missing native agent root');
          nativeAgentRoots.push({ machineId, rootPath });
          return { stream: new PassThrough(), stop: async () => {} };
        },
        callMachineRpc: async request => {
          const receiver = request.machineId === target.machineId ? rpc : sourceRpc;
          if (!receiver) throw new Error('Missing physical Sync receiver');
          const result = await rpcInstallation.run(request.machineId === target.machineId ? installation : sourceInstallation,
            () => receiver.handleRequest({ method: request.machineId + ':' + request.method, params: request.request,
              callerAuthority: 'present_user', machineAdmission: request.machineId === target.machineId ? admission
                : { ...admission, machineId: ref.machineId, installationId: sourceInstallation.installationId } }));
          rpcOutcomes.push({ method: request.method, result });
          return result;
        },
      };
      const productionInput = { happyHomeDir: join(directory, machineId), activeServerDir: join(directory, machineId, 'servers', 'srv_n2'),
        activeServerId: 'srv_n2', homeTarget, localMachineId: machineId, releaseChannel: 'publicdev' as const, credentials,
        openMachineCarrierTunnel: async (request: Parameters<NonNullable<Parameters<typeof createProductionDaemonWorkspaceSyncRuntime>[0]['openMachineCarrierTunnel']>>[0]) => {
          const receiver = request.targetMachineId === target.machineId ? workerWorkspaceSync : sourceWorkspaceSync;
          if (!receiver) throw new Error('Missing native carrier receiver');
          const ingress = await receiver.acquireWorkspaceSyncMachineIngress({ ...request, actorAccountId: 'account' });
          return { localPort: ingress.port, localCapability: ingress.localCapability, observedPath: 'direct' as const, close: ingress.close };
        },
        isCurrent: async () => sameStoredCredentials(credentials, await readStoredCredentialsForServerId('srv_n2')),
        callWorkspacePrepareBetween: async (request: Readonly<{ machineId: string;
          sourceWorkspace: import('@happier-dev/protocol').WorkspaceRefV1;
          request: import('@happier-dev/protocol').WorkspaceSyncPrepareBetweenRequestV1 }>, context: import('@/api/rpc/types').RpcHandlerContext) => {
          if (!context.callerInputAuthorization) throw new Error('Missing signed finite root');
          try { return await client.callWorkspaceSyncProjectSource({ ...request, context, credentials,
            operationId: context.callerInputAuthorization.binding.requestId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN }); }
          catch (error) {
            rpcOutcomes.push({ phase: 'installed.physicalPrepare.failure',
              code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
              error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack?.split('\n').slice(0, 5) : undefined });
            throw error;
          }
        } };
      const composed = await createProductionDaemonWorkspaceSyncRuntime(productionInput, overrides);
      composed.start();
      syncRuntimes.push(composed); return composed;
    };
    workerWorkspaceSync = await composeSync(target.machineId);
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: rpc, service: workerWorkspaceSync.workspaceSync });
    const bootstrapped = await rpcInstallation.run(installation, () => rpc.handleRequest({
      method: target.machineId + ':' + RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE,
      params: { v: 1, bootstrapOperationId: relationship.relationshipId, owner: { kind: 'relationship', relationshipId: relationship.relationshipId },
        transientRelationship: relationship,
        targetWorkspaceRefId: workerRef.id, endpointRole: 'beta', policyDigest: relationship.contentPolicy.policyDigest,
        createIfMissing: true, targetBootstrap: 'use_existing' }, callerAuthority: 'present_user', machineAdmission: admission }));
    rpcOutcomes.push({ phase: 'installed.initialBootstrap', result: bootstrapped });
    expect(bootstrapped, JSON.stringify(bootstrapped)).toMatchObject({ state: 'ready' });
    const graphKey = { kind: 'relationship-graph' as const };
    const committed = await mutateProjectAccountRows({ credentials, serverId: homeId, request: {
      mutations: [{ key: graphKey, expectedRevision: 1, payload: { key: graphKey, value: { relationships: [relationship] } } }],
      expectedRefs: [{ key: refKey, expectedRevision: 2 }, { key: { kind: 'workspace-ref', serverId: homeId, id: workerRef.id }, expectedRevision: 1 }],
      topologyChange: true,
    } });
    expect(committed).toMatchObject({ status: 'updated' });
    await readProjectAccountRows({ credentials, serverId: 'srv_n2', publication: 'installed' });
    if (!sameMachineWorker) {
      sourceWorkspaceSync = await rpcInstallation.run(sourceInstallation, () => composeSync(ref.machineId));
      registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: sourceRpc!, service: sourceWorkspaceSync.workspaceSync });
    }
    copies = 0;
  }
  const runtimeActionExecute = api.createBrowserRuntimeActionExecutor();
  if (actionId === 'agents.models.list' || actionId === 'agents.config_options.list') {
    // The admitted external plugin is the native discovery boundary; Home
    // admission, capability dispatch and inventory projection remain real.
    pluginRuntime = await createAuthoredAdmittedPluginRuntimeFixture({
      happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: 'acme.discovery', contributes: { agents: [{
        id: 'assistant', title: 'Discovery Assistant', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      }] } }), files: {
        'runtime.mjs': `export async function createRuntime() { return { sessions: {
          open: async () => ({ send: async () => ({ status: 'admitted' }), cancel: async () => ({ status: 'requested' }),
            watch: () => ({ dispose() {} }), dispose() {} }) } }; }`,
        'daemon.mjs': `import { createRuntime } from './runtime.mjs';
          export function activate(api) { api.agents.register('assistant', createRuntime, {
            sessionRunnerFactory: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            preflightSessionControls: {
              probeModels: async () => [{ id: 'reviewed-model', name: 'Reviewed model' }],
              probeConfigOptions: async () => [{ id: 'format', name: 'Format', type: 'select',
                options: [{ value: 'text', name: 'Text' }] }],
            } }); }`,
      } }],
    });
    await pluginRuntime.registry.activateContributionsOnDemand([
      { pluginId: 'acme.discovery', family: 'agents', localId: 'assistant' },
    ]);
  }
  if (serviceAction) {
    pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
      ...(actionId === 'projects.service.relocate' || actionId.startsWith('machines.services.') ? { controller: pluginReloadController } : {}),
      runtimeOptions: { pluginIds: [], resolveCurrentMachineId: () => target.machineId } });
  }
  if (returnFixture) {
    await readProjectAccountRows({ credentials, serverId: 'srv_n2', publication: 'installed' });
    pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
      controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.scm.backend.git'],
        resolveCurrentMachineId: () => target.machineId } });
    // Seed the review with the real Git backend and executable on this controller.
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.backend.git/git',
      executableDefinition: registration.runtime!, registration,
    })]);
    const composed = await createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: configuration.happyHomeDir,
      activeServerDir: configuration.activeServerDir, activeServerId: 'srv_n2', localMachineId: target.machineId,
      releaseChannel: 'publicdev', credentials, openManagedProjectWorkspace: returnFixture.openTarget }, {
      materializeLocalSeed: request => materializeLocalWorkspaceSyncSeed({ ...request, registry }),
    });
    workerWorkspaceSync = composed;
    composed.start();
    syncRuntimes.push(composed);
  }
  const pluginChangeService = actionId === 'plugins.install'
    ? await import('@/plugins/daemon/changeService').then(async ({ createDaemonPluginChangeService }) => {
      const { createDaemonPathPluginChangePreparer } = await import('@/plugins/daemon/pathChangePreparer');
      return createDaemonPluginChangeService({ prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir: configuration.happyHomeDir,
        runtimeLifecycle: { prepare: async () => { throw new Error('The fixture must stop at Install & Trust review'); } },
      }) });
    }) : undefined;
  if (pluginChangeService) onTestFinished(() => pluginChangeService.shutdown());
  const startRuntime = (machineClient: ApiMachineClient, machineId: string,
    origin: typeof resolveOrigin) => startDaemonSessionControlRuntime({ machineId, credentials,
    ...(worker ? { resolveProjectWorkerAction: () => createProjectWorkerAction({ machineId: target.machineId, serverId: 'srv_n2',
      serverHttpBaseUrl: params.serverHttpBaseUrl, credentials, accountId: 'account', admission: workerAdmission,
      isFiniteExecutionLive: () => actionId !== 'projects.service.relocate', isServiceExecutionLive: () => true }) } : {}),
    ...(pluginRuntime ? { pluginRuntimeController: pluginRuntime.controller } : {}),
    ...(pluginChangeService ? { pluginChangeService } : {}),
    serverId: 'srv_n2', serverBaseUrl: params.serverHttpBaseUrl, externalActionAccountId: cliPolicy?.machineCustodianAccountId ?? 'account',
    api, connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
    ...(connectedAccountPurposeBindingRuntime ? { sessionConnectedAccountProcessRuntime: connectedAccountPurposeBindingRuntime } : {}),
    ...(serviceAction ? { runtimeActionExecute, resolveServerFeaturesSnapshot: () => features } : {}),
    ...(actionId === 'projects.service.relocate' || returnFixture ? { resolveWorkspaceSyncHandoffAdapter: () => workerWorkspaceSync?.handoffAdapter ?? null } : {}),
    daemonSessionMutationCustody: { stageTranscriptEvent: async () => { throw new Error('Unexpected Session event'); },
      stageTranscriptMessage: async () => { throw new Error('Unexpected Session message'); } },
    getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
    trackedSessionsByKey: new Map(), spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
    getApiMachineForSessions: () => machineClient, spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
    connectedServicesRestartRequestedSessions: new Set(), resolveCurrentMachineExecutionOriginContext: origin,
    beforeShutdown: async () => {}, onHappySessionWebhook: async () => { throw new Error('Open must never start an Agent'); },
    requestShutdown() {}, processEnv: {} });
  const runtime = await startRuntime(client, target.machineId, resolveOrigin);
  if (connectedAccountPurposeBindingRuntime) client.registerConnectedAccountPurposeBindingRuntime({
    ...connectedAccountPurposeBindingRuntime, materializeSessionProcessEnvironment: runtime.materializeSessionProcessEnvironment,
  });
  const remoteDeploymentRuntime = remoteDeploymentClient && deploymentRuntime
    ? await rpcInstallation.run(sourceInstallation, () => startRuntime(remoteDeploymentClient, deploymentRuntime.machineId,
      createCurrentMachineExecutionOriginContextResolver({ serverUrl: params.serverHttpBaseUrl,
        resolveCurrentMachineId: () => deploymentRuntime.machineId }))) : undefined;
  if (remoteDeploymentClient && remoteDeploymentRuntime) {
    const remoteIngress = remoteDeploymentRuntime.externalActionIngressOwner;
    if (!remoteIngress) throw new Error('Production deployment Action owner was not installed');
    rpcInstallation.run(sourceInstallation, () => {
      remoteDeploymentClient.setRPCHandlers({ spawnSession: async () => { throw new Error('Deploy must never start an Agent'); },
        stopSession: async () => true, requestShutdown() {} }, { actionsSettingsProvider: settings, externalActionIngressOwner: remoteIngress });
      remoteDeploymentClient.registerDeploymentChildRoutes(new AbortController().signal);
    });
  }
  releaseProjection = client.onConnectedServicesProjection(runtime.reconcileConnectedServicesProjection);
  const installed = runtime.externalActionIngressOwner;
  if (!installed) throw new Error('Production external Action owner was not installed');
  const owner = installed.executor;
  const prepareRequester = installed.prepareRequesterAccountContext;
  const registration = client.setRPCHandlers({ spawnSession: async () => { throw new Error('Open must never start an Agent'); },
    stopSession: async () => true, requestShutdown() {} }, { actionsSettingsProvider: settings,
    externalActionIngressOwner: installed });
  if (returnFixture) sessionsRole = await activateSessionsRoleForMachineClient(client, registration);
  if (actionId === 'deployments.templates.instantiate') client.registerDeploymentChildRoutes(new AbortController().signal);
  const connectInstalledMachine = async () => {
    // Connect the public client rather than bypassing its live transport check.
    await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force',
      honorAccountSettingsModeEnv: false, expectedAccountEncryptionMode: 'plain' });
    client.connect();
    await expect.poll(() => installedSocket?.connected).toBe(true);
  };
  if (actionId === 'projects.open' || worker || returnFixture) await connectInstalledMachine();
  const store = createCliApprovalsArtifactStore({ credentials, serverId: 'srv_n2' });
  const issuerParams = { ...params, ...(features ? { resolveServerFeaturesSnapshot: () => features } : {}) };
  // The production CLI composer supplies Account Actions used by placement,
  // including worker preferences; the low-level harness omits those ports.
  const cliCredentials = { ...credentials, token: cliPolicy?.authentication === 'account' ? uiToken : cliToken };
  const originalCliSettings = cliPolicy?.hostOnlyAsk ? { ...settings,
      getAccountSettings: cliPolicy.hostOnlyAsk === 'unavailable' ? () => null : settings.getAccountSettings,
      getActionsSettings: () => normalizeActionsSettingsV1({
      ...settings.getActionsSettings(), actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } },
    }) } : settings;
  const issuer = createCliActionExecutorFromCredentials({ credentials: cliCredentials,
    serverId: 'srv_n2', serverApiUrl: params.serverHttpBaseUrl, serverIdentityId: homeId,
    // Original Run discovers SOURCE before selecting its execution Machine.
    ...(actionId === 'projects.script.run' ? {} : { machineId: target.machineId }),
    actionsSettingsProvider: originalCliSettings, pluginActionExecutionOwner: 'current_process',
    readCredentials: async () => cliCredentials });
  // The app captures the portable Home; the daemon/decider has its own local
  // profile label for that same Home, as in LV2's two-device replay.
  const uiIssuer = createCliActionExecutorHarness({ ...issuerParams, token: uiToken,
    credentials: { ...credentials, token: uiToken }, serverId: homeId }).executor;
  const artifactId = () => { if (!artifact) throw new Error('Missing approval Artifact'); return String(artifact.id); };
  const ownOperations = new Set<string>();
  const retainOperation = (value: unknown) => {
    const parsed = ProjectCommandActionOutputV1Schema.safeParse(value);
    if (parsed.success) ownOperations.add(parsed.data.operation.operationId);
  };
  const deliverExternalAction = (request: Pick<Parameters<typeof executeExternalAction>[0],
    'actionId' | 'principal' | 'executionAuthorization' | 'surface' | 'signal'> & Readonly<{ envelope: ExternalActionRequestEnvelope }>) => {
    const source = worker && ref.machineId !== target.machineId && request.envelope.target?.kind === 'machine'
      && request.envelope.target.machineId === ref.machineId;
    return rpcInstallation.run(source ? sourceInstallation : installation, () => executeExternalAction({
      ...request, currentMachineId: source ? ref.machineId : target.machineId, currentServerId: 'srv_n2',
      currentServerHttpBaseUrl: params.serverHttpBaseUrl,
      currentInstallationId: source ? sourceInstallation.installationId : installation.installationId,
      externalActionMachineRequestPrivateKey: source ? sourceInstallation.privateKey : privateKey,
      verifyExecutionAuthorization: source ? verifySourceRoot : verifyRoot, resolveTarget,
      executor: source ? sourceExecutor : owner,
      prepareRequesterAccountContext: source ? prepareSourceRequester : prepareRequester,
    }));
  };
  const personMoveExecutions: ActionExecuteResult[] = [];
  const harness = { personMoveExecutions, rootPath, directory, ref, workerRef, workerRelationship: relationship, rows, rpcOutcomes, networkPaths, finiteIngress, spawned, installation, sourceInstallation, deploymentRuntime,
    refreshProjectRows: () => readProjectAccountRows({ credentials, serverId: 'srv_n2', publication: 'installed' }),
    nativeAgentRoots,
    connectInstalledMachine,
    useNativeStreamCopy() { nativeStreamCopy = true; },
    runRootControl: (input: unknown, requestedActionId: Parameters<typeof requestDaemonSignedRootActionExecution>[0]['actionId']) => requestDaemonSignedRootActionExecution({
      actionId: requestedActionId, input, target,
    }, { target: { pid: process.pid, httpPort: runtime.controlPort, controlToken: runtime.controlToken },
      authorityCeiling: 'account_automation' }),
    async ensureWorkerLink() {
      const service = sourceWorkspaceSync?.workspaceSync ?? workerWorkspaceSync?.workspaceSync;
      if (!service) throw new Error('Missing worker Sync controller');
      await service.relationshipOwner.setEnabled(relationship.relationshipId, true);
      await service.controller.get(relationship.relationshipId);
      const status = await service.controller.resume(relationship.relationshipId);
      expect(status).toMatchObject({ state: 'watching' });
      const definitions = (await harness.syncRelationships()).flatMap(result => result.relationships);
      const current = definitions.find(definition => definition.relationshipId === relationship.relationshipId);
      if (!current) throw new Error('Missing enabled worker relationship');
      harness.workerRelationship = current;
      copies = 0;
      return status;
    },
    onDeploymentChildDelivery(listener: NonNullable<typeof deploymentChildDelivery>) { deploymentChildDelivery = listener; },
    failSourcePreparationDelivery(error: unknown) {
      let failures = 0;
      sourcePreparationDeliveryFailure = () => { failures++; throw error; };
      return () => failures;
    },
    deliverExternalAction,
    deliverMachineRpc: (method: string, params: unknown) => rpcInstallation.run(installation, () => rpc.handleRequest({
      method: target.machineId + ':' + method, params, callerAuthority: 'present_user', machineAdmission: admission,
    })),
    async seedMoveService(endpoint: string | null = null, serviceId = 'web', nativeStop: 'stopped' | 'accepted' = 'stopped', onWorker = false) {
      if (!pluginRuntime) throw new Error('Missing installed Service owner');
      let phase: 'running' | 'stopped' = 'running';
      let stopCalls = 0;
      let finishStop!: () => void;
      const stopped = new Promise<void>(resolve => { finishStop = resolve; });
      onTestFinished(() => finishStop());
      const serviceWorkspace = onWorker ? workerRef : ref;
      // Native lifecycle IO only: hold the physical Stop acknowledgement until
      // the accepted approval has returned and its ingress custody is disposed.
      const handle = await pluginRuntime.registry.projectManagedServices.superviseProject({ kind: 'workspace', workspace: serviceWorkspace,
        declaration: { workspaceRefId: serviceWorkspace.id, selection: { kind: 'manifest', name: 'web' } },
        cwd: serviceWorkspace.rootPath, serviceId, specIdentity: 'web', execution: 'portable', isCurrent: () => true,
        requester: { serverId: homeId, accountId: 'account', machineId: serviceWorkspace.machineId, installationId: onWorker ? installation.installationId : sourceInstallation.installationId },
        processSpec: { mode: { kind: 'native', instance: { adapter: { pluginId: 'fixture.plugin', localId: 'web' }, nativeResourceId: 'web' },
          lifecycle: { inspect: async () => ({ phase, readiness: 'not_reported', endpoint }),
            stop: async () => { stopCalls++; await stopped; if (nativeStop === 'stopped') phase = 'stopped'; return { status: nativeStop }; } } } },
        authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, release: async () => {} }),
      });
      const workspace = { serverId: homeId, refId: ref.id };
      const destination = onWorker ? { kind: 'primary' as const }
        : { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: workerRef.machineId } };
      const request = ProjectServiceRelocateInputV1Schema.parse({ workspace, sourceMachineId: ref.machineId, serviceName: 'web', requestId: 'retained-move',
        currentTarget: LocalServiceManagedServiceActionTargetV1Schema.parse({ kind: 'managed_service', managedServiceId: handle.instanceId,
          machineId: serviceWorkspace.machineId, workspaceId: serviceWorkspace.id, cwd: serviceWorkspace.rootPath, declaration: handle.declaration }),
        destination, selectedTarget: { machineId: onWorker ? ref.machineId : workerRef.machineId }, desiredPlacement: { workspace, serviceName: 'web',
          expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: destination, unavailable: 'fail' } } });
      return { request, finishStop, snapshot: handle.snapshot, stopCalls: () => stopCalls };
    },
    async seedNativeService() {
      if (!pluginRuntime) throw new Error('Missing installed Service owner');
      let phase: 'running' | 'stopped' = 'running';
      let stopCalls = 0;
      const handle = await pluginRuntime.registry.projectManagedServices.superviseMachine({ serverId: homeId, machineId: ref.machineId,
        watch: { v: 1, watchId: 'native-web', name: 'Native web', adapter: { pluginId: 'fixture.plugin', localId: 'web' },
          nativeResourceId: 'web', lifecyclePurpose: 'development' },
        isCurrent: () => true, releaseObservation: async () => {}, lifecycle: {
          inspect: async () => ({ phase, readiness: 'not_reported', endpoint: null }),
          stop: async () => { stopCalls++; phase = 'stopped'; return { status: 'stopped' }; },
        } });
      return { target: { serverId: homeId, machineId: ref.machineId, serviceId: handle.serviceId, expectedGeneration: handle.instanceId },
        snapshot: handle.snapshot, stopCalls: () => stopCalls, finishStop: () => {} };
    },
    async runStandaloneCli(input: unknown) {
      // A standalone CLI discovers SOURCE locally, while Script placement must
      // deliver its nested worker-status child to the separately installed worker.
      const sourceExecutor = createActionExecutor(createCliActionDeps({ ...params,
        projectDefinitionAction: sourceDefinitionAction,
        machineActionDirectTargetTransport: { machineId: ref.machineId,
          invoke: (method, request, options) => sourceRpc!.invokeLocal(method, request, options) } }));
      const app = createDaemonControlApp({ machineId: ref.machineId, controlToken: 'source-control',
        getChildren: () => [], stopSession: async () => ({ status: 'not_found' }),
        spawnSession: async () => { throw new Error('Unexpected Session spawn'); }, requestShutdown() {}, onHappySessionWebhook() {},
        externalActionApi: { currentServerId: 'srv_n2', currentAccountId: 'account', executor: sourceExecutor,
          resolveTarget, verifyPat: async () => { throw new Error('Unexpected PAT'); } } });
      await app.listen({ host: '127.0.0.1', port: 0 });
      try {
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Missing SOURCE control address');
        writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test',
          httpPort: address.port, controlToken: 'source-control', machineId: ref.machineId, accountId: 'account' });
        return await createCliActionExecutorFromCredentials({ credentials: cliCredentials,
          serverId: 'srv_n2', serverApiUrl: params.serverHttpBaseUrl, serverIdentityId: homeId,
          actionsSettingsProvider: originalCliSettings, readCredentials: async () => cliCredentials,
        }).execute(actionId, input, { surface: 'cli', authority: 'account_automation', actionRequestId: 'standalone-script' });
      } finally { await app.close(); }
    },
    async runPublicCli(input: unknown, requestedActionId: ActionId,
      options?: Readonly<{ yes: true; beforeApproval?: () => void }>) {
      writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test',
        httpPort: runtime.controlPort, controlToken: runtime.controlToken, machineId: target.machineId, accountId: 'account' });
      const output = captureConsoleJsonOutput();
      const previousExitCode = process.exitCode;
      try {
        await handleActionsCommand(['invoke', requestedActionId, '--input-json', JSON.stringify(input),
          ...(options?.yes ? ['--yes'] : []), '--json'], {
          readCredentialsFn: async () => cliCredentials,
          readCredentialsForServerIdFn: async () => cliCredentials,
          createExecutorFn: executorParams => {
            const onApprovalRequested = executorParams.onApprovalRequested;
            return createCliActionExecutorFromCredentials({ ...executorParams,
              actionsSettingsProvider: originalCliSettings,
              ...(options?.beforeApproval && onApprovalRequested ? { onApprovalRequested: (...args) => {
                options.beforeApproval?.();
                return onApprovalRequested(...args);
              } } : {}),
            });
          },
        });
        return output.json();
      } finally { output.restore(); process.exitCode = previousExitCode; }
    },
    async runSavedProfileMcp(input: unknown, requestedActionId: ActionId, installedDaemon = false) {
      const serverFeaturesSnapshot = features ?? await api.getServerFeaturesSnapshot({ refresh: true });
      writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test',
        httpPort: runtime.controlPort, controlToken: runtime.controlToken, machineId: target.machineId, accountId: 'account' });
      // Standalone MCP receives its presentation policy through the command's environment snapshot.
      env.patch({ HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify(accountSettings.actionsSettingsV1) });
      const { mcp } = runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createExternalMcpServer({
        credentials: cliCredentials, machineId: target.machineId,
        ...(installedDaemon ? {} : { daemonControlTarget: null }),
        serverFeaturesSnapshot,
      }));
      const client = new Client({ name: 'managed-service-stop', version: '1' });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await mcp.connect(serverTransport); await client.connect(clientTransport);
      try {
        const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
          actionId: requestedActionId, input,
        } }));
        const body = reply.content.find(entry => entry.type === 'text');
        expect(body?.type).toBe('text');
        const result: unknown = body?.type === 'text' ? JSON.parse(body.text) : null;
        return result;
      } finally { await client.close(); await mcp.close(); }
    },
    async runOriginalCli(input: unknown, requestedActionId: ActionId = 'projects.worker.copy.inspect',
      options?: Readonly<{ serverId: string; authority: 'present_user' | 'account_automation' }>) {
      writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test',
        httpPort: runtime.controlPort, controlToken: runtime.controlToken, machineId: target.machineId, accountId: 'account' });
      return await createCliActionExecutorFromCredentials({ credentials: cliCredentials,
        serverId: options?.serverId ?? 'srv_n2', serverApiUrl: params.serverHttpBaseUrl,
        serverIdentityId: homeId, machineId: target.machineId, externalActionClient: true, actionsSettingsProvider: originalCliSettings,
        readCredentials: async () => cliCredentials,
      }).execute(requestedActionId, input, { surface: 'cli', authority: options?.authority ?? 'account_automation' });
    },
    readTerminalAs: (terminalId: string, actorAccountId: string) => rpc.handleRequest({
      method: target.machineId + ':' + RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
      params: { terminalId, byteOffset: 0 }, callerAuthority: 'present_user',
      machineAdmission: { ...admission, actorAccountId },
    }),
    directCopyPreview: (input: unknown) => rpcInstallation.run(installation, () => rpc.handleRequest({
      method: target.machineId + ':' + RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT,
      params: input, callerAuthority: 'present_user', machineAdmission: admission,
    })),
    humanToken: uiToken, installedToken: token,
    serviceInstances: () => (pluginRuntime?.registry.projectManagedServices.listProjectServices() ?? [])
      .filter((handle): handle is WorkspaceProjectManagedServiceHandle => handle.kind === 'workspace'),
    async syncRelationships() {
      return await Promise.all(syncDaemonRuntimes.map(async runtime => {
        await runtime.whenProjectsSettled();
        const result = await runtime.managedWorkspaceSync.listRelationships({ workspaceRefId: ref.id });
        return { ...result, relationships: result.relationships.map(({ definition }) => definition) };
      }));
    },
    async retireRequester() {
      encryptionVersion++;
      await currentnessChannel?.push('account', accountCurrentness());
    },
    async prepareSignedServiceStart(options: Readonly<{ protectedInput?: 'requester material' | 'other material';
      sourceWorkspaceRefId?: string; targetWorkspaceRefId?: string; selectedMachineId?: string;
      changedEnvelope?: boolean }> = {}) {
      if (!workerWorkspaceSync) throw new Error('Missing real Sync composition');
      const input = { ...await harness.serviceInput(), choice: { kind: 'workers' as const,
        destination: { kind: 'machine' as const, machineId: options.selectedMachineId ?? workerRef.machineId } } };
      if (options.protectedInput) await protectRequester();
      const requestId = randomUUID();
      const envelope = protectedMoveCredentials ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId,
        accountId: 'account', actionId: 'localServices.launcher.start', requestId, target,
        authentication: { kind: 'account', tokenEpoch: 1 } }, input,
        material: options.protectedInput === 'other material' ? { type: 'dataKey', machineKey: tweetnacl.randomBytes(32) }
          : protectedMoveCredentials.encryption, randomBytes: tweetnacl.randomBytes })
        : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target, input });
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'service-start-home-root', binding: {
        accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: protectedMoveCredentials ? 'e2ee' : 'plain', serverIdentityId: homeId,
        machineId: target.machineId, installationId: installation.installationId, actionId: 'localServices.launcher.start',
        requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        ...mintSyncAdmission('localServices.launcher.start', envelope),
      } });
      const requester = await admitRequesterAccountActionContext({ authorization,
        credentials: protectedMoveCredentials ?? credentials, serverId: 'srv_n2', serverIdentityId: homeId,
        serverHttpBaseUrl: params.serverHttpBaseUrl, isCurrent: async () => true });
      if (!requester) throw new Error('Service requester custody was not admitted');
      try {
        const projected = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
          serverId: 'srv_n2', serverIdentityId: homeId, serverHttpBaseUrl: params.serverHttpBaseUrl,
          target, installationId: installation.installationId, privateKey, isCurrent: requester.isCurrent });
        if (!projected) throw new Error('Service requester HTTP ports were not admitted');
        return await workerWorkspaceSync.handoffAdapter.prepareBetween({ sourceWorkspaceRefId: options.sourceWorkspaceRefId ?? ref.id,
          targetWorkspaceRefId: options.targetWorkspaceRefId ?? workerRef.id }, undefined, {
          signal: new AbortController().signal, machineAdmission: admission, callerAuthority: 'present_user',
          callerInputAuthorization: projected,
          originalActionEnvelope: options.changedEnvelope ? { ...envelope, requestId: randomUUID() } : envelope,
          verifyMachineAdmissionCurrent: async () => true,
        });
      } finally { await requester.dispose(); }
    },
    async prepareSignedMove(options: Readonly<{ sourceWorkspaceRefId?: string; targetWorkspaceRefId?: string;
      selectedMachineId?: string; protectedInput?: 'requester material' | 'other material';
      sourceCoordinator?: true; requesterToken?: string; activeMove?: true;
      executeMove?: import('@happier-dev/protocol/workspaces/projectServiceRelocationV1').ProjectServiceRelocateInputV1;
      originalCli?: 'default' | 'source' | 'mcp' | 'session_agent' | 'ui_person';
      proposalOnly?: true;
      approveRequiredChild?: true;
      cancelRequiredChild?: true;
      inspectRequester?: (input: Readonly<{ authorization: ExternalActionExecutionAuthorizationV1;
        envelope: ExternalActionRequestEnvelope;
        status(variant?: 'missing-packet' | 'changed-input'): Promise<unknown>;
        start(captureOnly?: true, admissionChange?: 'other-actor' | 'other-installation' | 'other-custodian'): Promise<unknown>;
        settleMove(): Promise<void>; cancelMove(): Promise<void> }>) => Promise<unknown> }> = {}) {
      const refusalTrace = vi.spyOn(logger, 'warnLocalFile');
      const refusalDiagnostics = () => refusalTrace.mock.calls
        .filter(([message]) => message === '[external-action-phase]').map(([, details]) => details);
      if (!workerWorkspaceSync) throw new Error('Missing real Sync composition');
      const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const,
        machineId: options.selectedMachineId ?? workerRef.machineId } };
      const workspace = { serverId: homeId, refId: ref.id };
      const input = options.executeMove ?? ProjectServiceRelocateInputV1Schema.parse({ workspace, sourceMachineId: ref.machineId, serviceName: 'web', requestId: 'reviewed-move',
        currentTarget: { kind: 'managed_service', machineId: ref.machineId, managedServiceId: 'native-web',
          workspaceId: ref.id, cwd: ref.rootPath, declaration: { workspaceRefId: ref.id, selection: { kind: 'manifest', name: 'web' } } },
        destination, selectedTarget: { machineId: destination.destination.machineId }, desiredPlacement: {
          workspace, serviceName: 'web', expectedRevision: 'absent', expected: { kind: 'absent' },
          value: { runsOn: destination, unavailable: 'fail' },
        } });
      if (options.protectedInput) {
        await protectRequester();
      }
      const moveTarget = options.sourceCoordinator ? { kind: 'machine' as const, machineId: ref.machineId } : target;
      const moveInstallation = options.sourceCoordinator ? sourceInstallation : installation;
      const moveKey = Buffer.from(moveInstallation.privateKey, 'base64url');
      const moveRequestId = randomUUID();
      const envelope = protectedMoveCredentials ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: { serverIdentityId: homeId,
        accountId: 'account', actionId: 'projects.service.relocate', requestId: moveRequestId, target: moveTarget,
        authentication: { kind: 'account', tokenEpoch: 1 } }, input, material: options.protectedInput === 'other material'
          ? { type: 'dataKey', machineKey: tweetnacl.randomBytes(32) } : protectedMoveCredentials.encryption,
        randomBytes: tweetnacl.randomBytes }) : { v: 1 as const, requestId: moveRequestId, target: moveTarget, input };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'move-home-root', binding: {
        ...mintSyncAdmission('projects.service.relocate', envelope),
        accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: protectedMoveCredentials ? 'e2ee' : 'plain', serverIdentityId: homeId, machineId: moveTarget.machineId,
        installationId: moveInstallation.installationId, actionId: 'projects.service.relocate', requestId: envelope.requestId,
        target: moveTarget, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      const requester = await admitRequesterAccountActionContext({ authorization,
        credentials: { ...(protectedMoveCredentials ?? credentials), token: options.requesterToken ?? credentials.token }, serverId: 'srv_n2',
        serverIdentityId: homeId, serverHttpBaseUrl: params.serverHttpBaseUrl, isCurrent: async () => true });
      if (!requester) throw new Error('Move requester custody was not admitted');
      if (options.proposalOnly) onTestFinished(() => requester.dispose());
      let finishMove: (() => void) | undefined;
      let settleMove = async () => {};
      let cancelMove = async () => {};
      if (options.activeMove) {
        if (!sourceRpc) throw new Error('Missing SOURCE operation receiver');
        const operations = createHostActionOperationRuntime({ machineId: moveTarget.machineId,
          resolveAccountId: async () => 'account', supportsCoreCancellation: () => true });
        registerActionOperationRpcHandlers(sourceRpc, operations.handlers);
        const completion = new Promise<void>(resolve => { finishMove = resolve; });
        const accepted = await operations.observeExecution({ actionId: 'projects.service.relocate', input,
          actionRequestId: envelope.requestId, execute: async operation => {
            operation.operationProgress.update({ phase: 'stopping', label: 'Stopping service' });
            operation.operationProgress.update({ phase: 'starting', label: 'Starting service' });
            await completion;
            return operation.signal.aborted ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
              : { ok: true, result: { status: 'moved' } };
          } });
        if (!accepted.ok || !accepted.result || typeof accepted.result !== 'object' || !('operation' in accepted.result)) {
          throw new Error('Missing accepted Move');
        }
        const snapshot = ActionOperationSnapshotV1Schema.parse(accepted.result.operation);
        const scope = { accountId: 'account', machineId: moveTarget.machineId };
        settleMove = async () => { finishMove?.(); await operations.runner.waitForTerminal(scope, snapshot.operationId); };
        cancelMove = async () => { operations.runner.cancel(scope, snapshot.operationId); await settleMove(); };
      }
      try {
        const projected = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
          serverId: 'srv_n2', serverIdentityId: homeId, serverHttpBaseUrl: params.serverHttpBaseUrl,
          target: moveTarget, installationId: moveInstallation.installationId, privateKey: moveKey, isCurrent: requester.isCurrent });
        if (!projected) throw new Error('Move requester HTTP ports were not admitted');
        if (options.executeMove) {
          if (!sourceRpc || !pluginRuntime) throw new Error('Missing SOURCE Move composition');
          const operations = createHostActionOperationRuntime({ machineId: moveTarget.machineId,
            resolveAccountId: async () => 'account', supportsCoreCancellation: () => true });
          registerActionOperationRpcHandlers(sourceRpc, operations.handlers);
          const featureGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => features });
          await featureGate.refresh();
          // A coordinator cannot resolve another Machine's native handle locally.
          const sourceServices = input.currentTarget.machineId === ref.machineId ? pluginRuntime
            : await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
              runtimeOptions: { pluginIds: [], resolveCurrentMachineId: () => ref.machineId } });
          if (sourceServices !== pluginRuntime) onTestFinished(() => sourceServices.dispose());
          const relocate = createProjectServiceRelocationRoute({ serverBaseUrl: params.serverHttpBaseUrl, credentials,
            projectManagedServices: sourceServices.registry.projectManagedServices,
            resolveWorkspaceSyncHandoffAdapter: () => sourceWorkspaceSync?.handoffAdapter ?? null });
          const sourceWork = new AbortController();
          const prepareSourceRequesterAccountContext: NonNullable<Parameters<typeof executeExternalAction>[0]['prepareRequesterAccountContext']> =
            request => prepareRequesterAccountActionContext({ ...request,
              purpose: request.purpose ?? { kind: 'external_action' }, machineId: ref.machineId, installationId: moveInstallation.installationId,
              installationPrivateKey: moveKey, serverId: 'srv_n2', serverIdentityId: homeId,
              serverHttpBaseUrl: params.serverHttpBaseUrl, ownCredentials: credentials, isCurrent: async () => true,
              createExecutor: () => sourceExecutor });
          const sourceBaseExecutor = createCliActionExecutorFromCredentials({ credentials, machineId: moveTarget.machineId,
            serverId: 'srv_n2', serverApiUrl: params.serverHttpBaseUrl, serverIdentityId: homeId,
            // This is the receiving SOURCE daemon, matching the production composer.
            actionsSettingsProvider: settings, pluginActionExecutionOwner: 'current_process',
            externalActionMachineInstallationId: moveInstallation.installationId, externalActionMachineRequestPrivateKey: moveKey,
            machineActionDirectTargetTransport: { machineId: ref.machineId,
              invoke: (method, input, options) => sourceRpc.invokeLocal(method, input, options) },
            runActionOperation: operations.runActionOperation,
            projectDefinitionAction: sourceDefinitionAction,
            projectWorkerAction: createProjectWorkerAction({ machineId: ref.machineId, serverId: 'srv_n2',
              serverHttpBaseUrl: params.serverHttpBaseUrl, credentials, accountId: 'account',
              admission: workerAdmission,
              isFiniteExecutionLive: () => false, isServiceExecutionLive: () => true }),
            prepareApprovalExecutionAuthorization: createDaemonApprovalExecutionAuthorizationPreparer({
              machineId: moveTarget.machineId, serverId: 'srv_n2', serverBaseUrl: params.serverHttpBaseUrl,
              resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                serverUrl: params.serverHttpBaseUrl, resolveCurrentMachineId: () => moveTarget.machineId,
              }),
              requesterAccountContext: requester, prepareRequesterAccountContext: prepareSourceRequesterAccountContext,
              daemonWorkSignal: sourceWork.signal,
            }),
            runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate,
              ingress: { signal: sourceWork.signal,
                machineAdmission: { ...admission, machineId: ref.machineId, installationId: sourceInstallation.installationId },
                verifyMachineAdmissionCurrent: async () => true }, routes: {
              relocateService: relocate,
            } }),
          });
          const sourceExecutor: ReturnType<typeof createCliActionExecutorFromCredentials> = { ...sourceBaseExecutor,
            execute: (actionId, actionInput, context) => sourceBaseExecutor.execute(actionId, actionInput,
              projectAdmittedExternalActionMachineContext(context, ref.machineId, 'plain')) };
          moveRequesterPreparation = prepareSourceRequesterAccountContext;
          registerApprovalRpcHandlers({ rpcHandlerManager: sourceRpc, actionExecutor: sourceExecutor });
          let accepted: ActionExecuteResult;
          if (options.originalCli) {
            originalMoveIngress = async request => {
              const root = request.executionAuthorization;
              if (!root || !('authentication' in root.binding)) throw new Error('Missing original Move admission');
              const rootAuthentication = root.binding.authentication;
              const sourceActionId = root.binding.actionId;
              if (sourceActionId !== 'projects.service.relocate' && sourceActionId !== 'approval.request.decide') throw new Error('Unexpected SOURCE ingress');
              return await rpcInstallation.run(moveInstallation, () => executeExternalAction({ actionId: sourceActionId, envelope: request.envelope,
                principal: { accountId: 'account', authority: resolveExternalActionRootInvocationAuthority(root), authentication: rootAuthentication },
                ...(sourceActionId === 'approval.request.decide' ? { surface: 'ui' as const } : {}),
                executionAuthorization: root, currentMachineId: ref.machineId, currentServerId: 'srv_n2',
                currentServerHttpBaseUrl: params.serverHttpBaseUrl, currentInstallationId: moveInstallation.installationId,
                externalActionMachineRequestPrivateKey: moveKey, executor: sourceExecutor, resolveTarget,
                verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                  privateKey: moveKey, installationId: moveInstallation.installationId, serverHttpBaseUrl: params.serverHttpBaseUrl }),
                prepareRequesterAccountContext: prepareSourceRequesterAccountContext,
              }));
            };
            const app = createDaemonControlApp({ machineId: ref.machineId, controlToken: 'source-control',
              getChildren: () => [], stopSession: async () => ({ status: 'not_found' }),
              spawnSession: async () => { throw new Error('Unexpected Session spawn'); }, requestShutdown() {}, onHappySessionWebhook() {},
              externalActionApi: { currentServerId: 'srv_n2', currentAccountId: 'account', executor: sourceExecutor,
                resolveTarget, verifyPat: async () => { throw new Error('Unexpected PAT'); } } });
            await app.listen({ host: '127.0.0.1', port: 0 });
            try {
              const address = app.server.address();
              if (!address || typeof address === 'string') throw new Error('Missing SOURCE control address');
              writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test',
                httpPort: address.port, controlToken: 'source-control', machineId: ref.machineId, accountId: 'account' });
              if (options.originalCli === 'mcp') {
                if (!features) throw new Error('Missing Move server features');
                const { mcp } = runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createExternalMcpServer({
                  credentials, machineId: ref.machineId, daemonControlTarget: null,
                  serverFeaturesSnapshot: features,
                }));
                const client = new Client({ name: 'service-move', version: '1' });
                const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
                await mcp.connect(serverTransport); await client.connect(clientTransport);
                try {
                  const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
                    actionId: 'projects.service.relocate', input,
                  } }));
                  const body = reply.content.find(entry => entry.type === 'text');
                  expect(body?.type).toBe('text');
                  const proposal: unknown = body?.type === 'text' ? JSON.parse(body.text) : null;
                  expect(proposal, JSON.stringify({ networkPaths, refusals: refusalDiagnostics() })).toMatchObject({ kind: 'approval_request_created' });
                  accepted = { ok: true, result: ActionApprovalRequestCreatedResultSchema.parse(proposal) };
                } finally { await client.close(); await mcp.close(); }
              } else if (options.originalCli === 'ui_person') {
                // The person's own UI press, as the UI Account transport sends it: Home mints the
                // root for the SOURCE, the sealed invocation carries the UI confirmation, and the
                // real SOURCE ingress (executeExternalAction) receives it. A carried review is
                // confirmed once, exactly as confirmOwnUiRefusal does: same input, fresh request id.
                const sendUi = async (requestId: string, reviewDigest?: string) => {
                  const uiEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target: moveTarget, input });
                  const confirmation = reviewDigest ? { actionId: 'projects.service.relocate' as const, accountId: 'account',
                    serverId: homeId, requestId, reviewDigest, target: moveTarget,
                    inputDigest: computeActionInputApprovalDigestV1('projects.service.relocate', input) } : undefined;
                  const minted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'ui-move-home-root', binding: {
                    accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
                    admittedMachineRole: cliPolicy?.machineRole ?? 'manage',
                    ...mintActionAdmission('projects.service.relocate', uiEnvelope),
                    accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: ref.machineId,
                    installationId: moveInstallation.installationId, actionId: 'projects.service.relocate',
                    requestId, target: moveTarget, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(uiEnvelope) } });
                  const executionAuthorization = sealExternalActionRequesterAccountContextV1({ authorization: minted,
                    credentials: encodeStoredCredentials(credentials),
                    invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user',
                      ...(confirmation ? { presentUserConfirmation: confirmation } : {}) },
                    purpose: { kind: 'external_action' },
                    installationPublicKey: Buffer.from(moveInstallation.publicKey, 'base64url'), randomBytes: tweetnacl.randomBytes });
                  const response = await originalMoveIngress!(ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1,
                    machineId: ref.machineId, envelope: uiEnvelope, executionAuthorization }));
                  if (response.kind !== 'response' || response.response.v !== 1) throw new Error('Expected plain SOURCE Move response');
                  const execution = response.response.execution;
                  personMoveExecutions.push(execution);
                  return execution;
                };
                const reviewed = await sendUi(envelope.requestId);
                const carried = !reviewed.ok && reviewed.details && typeof reviewed.details === 'object'
                  && 'reviewDigest' in reviewed.details && typeof reviewed.details.reviewDigest === 'string'
                  ? reviewed.details.reviewDigest : undefined;
                accepted = carried ? await sendUi(randomUUID(), carried) : reviewed;
              } else if (options.originalCli === 'session_agent') {
                // An Agent in a Session on this installed SOURCE, as its own Account:
                // the production Session executor and Home-root issuer, then this SOURCE executor.
                const agentSessionId = 'move-agent-session';
                const execute = createDaemonSessionAccountActionExecutor({ machineId: ref.machineId, serverId: 'srv_n2',
                  serverHttpBaseUrl: params.serverHttpBaseUrl, token: credentials.token, credentials,
                  readAccountEncryptionMode: async () => 'plain',
                  createExecutor: () => sourceExecutor,
                  prepareExternalActionAuthorization: createDaemonSessionAccountActionAuthorizationPreparer({ credentials,
                    requesterRuntime: null, serverHttpBaseUrl: params.serverHttpBaseUrl, serverId: 'srv_n2', machineId: ref.machineId,
                    externalActionAccountId: 'account',
                    resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                      serverUrl: params.serverHttpBaseUrl, resolveCurrentMachineId: () => ref.machineId }),
                    isSessionCallerCurrent: async ({ caller }) => caller.kind === 'session' && caller.sessionId === agentSessionId,
                    isRuntimeCurrent: () => true, readTrackedSessionAttribution: () => undefined }) });
                accepted = await rpcInstallation.run(moveInstallation, () => execute({ kind: 'action.execute',
                  actionId: 'projects.service.relocate', input, requestId: envelope.requestId, surface: 'agent',
                  witness: { turnId: 'agent-turn', inputId: 'agent-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
                    callerPermissionMode: 'default', agentStartCaller: { kind: 'session', sessionId: agentSessionId, starterDepth: 0, turnDepth: 0 } } },
                { sessionId: agentSessionId, isCurrent: async () => true }));
              } else accepted = await createCliActionExecutorFromCredentials({ credentials, serverId: 'srv_n2',
                serverApiUrl: params.serverHttpBaseUrl, serverIdentityId: homeId, externalActionClient: true,
                ...(options.originalCli === 'source' ? { machineId: ref.machineId } : {}),
                actionsSettingsProvider: settings, readCredentials: async () => credentials,
              }).execute('projects.service.relocate', input, { surface: 'cli', authority: 'present_user', actionRequestId: envelope.requestId });
              if (options.approveRequiredChild || options.cancelRequiredChild) {
                expect(accepted, JSON.stringify({ accepted, refusals: refusalDiagnostics() })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                const request = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: artifactId() }));
                if (options.originalCli === 'mcp') {
                  const root = request.executionOriginV1.externalActionExecutionAuthorization?.binding;
                  expect(root?.actionId).toBe('projects.service.relocate');
                  expect(root?.machineId).toBe(ref.machineId);
                }
                expect(request).toMatchObject({ actionId: 'projects.service.relocate', status: 'open', preview: {
                  hostReviewedChildren: { children: expect.arrayContaining([expect.objectContaining({
                    action: 'localServices.launcher.start', input: expect.objectContaining({ machineId: input.selectedTarget.machineId }),
                  })]) },
                } });
                const decided = await createCliActionExecutorFromCredentials({ credentials, serverId: 'srv_n2',
                  serverApiUrl: params.serverHttpBaseUrl, serverIdentityId: homeId, machineId: ref.machineId,
                  actionsSettingsProvider: settings, readCredentials: async () => credentials,
                }).execute('approval.request.decide', { artifactId: artifactId(), decision: options.cancelRequiredChild ? 'cancel' : 'approve' }, {
                  surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: randomUUID(),
                });
                const approved = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: artifactId() }));
                if (options.cancelRequiredChild) {
                  expect(decided).toMatchObject({ ok: true });
                  expect(approved).toMatchObject({ status: 'canceled' });
                  expect(approved.execution).toBeUndefined();
                  return decided;
                }
                const replayCode = approved.execution?.ok === false ? approved.execution.errorCode : undefined;
                expect(decided, JSON.stringify({ errorCode: decided.ok ? replayCode : decided.errorCode,
                  refusals: refusalDiagnostics() })).toMatchObject({ ok: true, result: { status: 'executed' } });
                expect(approved.execution, replayCode).toMatchObject({ ok: true });
                const execution = approved.execution;
                if (execution?.ok !== true) throw new Error('Missing successful SOURCE Move approval execution');
                accepted = { ...execution, ok: execution.ok, result: execution.result };
              }
            } finally {
              await app.close();
              if (options.proposalOnly) onTestFinished(() => { originalMoveIngress = undefined; moveRequesterPreparation = undefined; });
              else { originalMoveIngress = undefined; moveRequesterPreparation = undefined; }
            }
          } else accepted = await rpcInstallation.run(moveInstallation, () => sourceExecutor.execute('projects.service.relocate', input, {
            serverId: 'srv_n2', surface: 'ui', authority: 'present_user', actionRequestId: envelope.requestId,
            runtimeAccountId: requester.authorization.binding.accountId,
            // Match the host context of the original reviewed Move replay.
            bypassApprovals: true,
            machineAdmission: { ...admission, machineId: moveTarget.machineId,
              installationId: moveInstallation.installationId },
            externalActionTarget: moveTarget, externalActionExecutionAuthorization: projected, originalActionEnvelope: envelope,
          }));
          if (!accepted.ok || options.proposalOnly) return accepted;
          if (!accepted.result || typeof accepted.result !== 'object' || !('operation' in accepted.result)) {
            throw new Error('Missing accepted SOURCE Move operation: ' + JSON.stringify({ accepted, networkPaths, rpcOutcomes }));
          }
          const operation = ActionOperationSnapshotV1Schema.parse(accepted.result.operation);
          return await sourceRpc.invokeLocal('actionOperation.get.v2', { operationId: operation.operationId, waitForTerminal: true });
        }
        let capturedStart: RpcRequest | undefined;
        const child = async (actionId: 'projects.worker.status' | 'localServices.launcher.start', params: unknown,
          variant?: 'missing-packet' | 'changed-input' | 'capture-only', admissionChange?: 'other-actor' | 'other-installation' | 'other-custodian') => {
            const deliver = (packet: RpcRequest) => rpc.handleRequest({ ...packet,
              ...(admissionChange ? { machineAdmission: { ...admission,
                ...(admissionChange === 'other-actor' ? { actorAccountId: 'unrelated-requester' } : {}),
                ...(admissionChange === 'other-installation' ? { installationId: 'replacement-installation' } : {}),
                ...(admissionChange === 'other-custodian' ? { custodianAccountId: 'unrelated-custodian' } : {}) } } : {}) });
            if (actionId === 'localServices.launcher.start' && capturedStart) return await deliver({ ...capturedStart, requestId: randomUUID(),
              callerInputAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse(capturedStart.callerInputAuthorization),
              workspaceSyncSourceExecution: WorkspaceSyncSourceExecutionV1Schema.parse(capturedStart.workspaceSyncSourceExecution) });
            const childMethod = getActionSpec(actionId).bindings!.rpcMethod!;
            const purpose = { kind: 'machine_rpc' as const, method: childMethod, params,
              recipient: { machineId: workerRef.machineId, installationId: installation.installationId } };
            const sealed = await projected.requesterAccountProjection!.sealRequesterAccountContext!({ authorization: projected,
              purpose, installationPublicKey: publicKey });
            if (!sealed) throw new Error('Missing destination requester custody');
            const method = `${workerRef.machineId}:${childMethod}`;
            const execution = createExternalActionSourceMachineRpcExecution({ authorization: sealed,
              target: moveTarget, sourceMachineId: moveTarget.machineId, sourceInstallationId: moveInstallation.installationId,
              effectActionId: actionId, method, requestId: 'move-child', params, privateKey: moveKey });
            if (!execution) throw new Error('Missing signed Move child');
            expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: sealed.token,
              requesterAccountContext: sealed.requesterAccountContext, effectActionId: actionId,
              target: moveTarget, installationId: moveInstallation.installationId, event: SOCKET_RPC_EVENTS.CALL,
              method, requestId: 'move-child', params, signature: execution.machineSignature,
              publicKey: Buffer.from(moveInstallation.publicKey, 'base64url') })).toBe(true);
            // Home delivery is the network boundary. Receiver admission, private
            // opener, registrar, Action context, factory and eligibility stay real.
            const packet: RpcRequest = { method, requestId: 'move-child',
              params: variant === 'changed-input' ? { ...(params as Record<string, unknown>), workspace: { ...workspace, refId: 'unreviewed-source' } } : params,
              machineAdmission: admission, callerAuthority: 'present_user', callerInputAuthorization: sealed,
              originalActionEnvelope: envelope,
              ...(variant === 'missing-packet' ? {} : { workspaceSyncSourceExecution: WorkspaceSyncSourceExecutionV1Schema.parse({ method, params,
                requestId: 'move-child', externalActionExecution: execution, originalActionEnvelope: envelope }) }) };
            if (actionId === 'localServices.launcher.start') capturedStart = packet;
            if (variant === 'capture-only') return;
            return await deliver(packet);
        };
        if (options.inspectRequester) return await options.inspectRequester({ authorization: projected, envelope, settleMove, cancelMove,
          status: variant => child('projects.worker.status', { workspace,
            destination: { kind: 'machine', machineId: workerRef.machineId }, purpose: 'service-start' }, variant),
          start: (captureOnly, admissionChange) => child('localServices.launcher.start', { machineId: workerRef.machineId,
            targetId: createProjectServiceDeclarationTargetIdV1(workerRef, { kind: 'manifest', name: 'web' }),
            workspaceId: workerRef.id, workspace: { serverId: homeId, machineId: workerRef.machineId,
              workspaceId: workerRef.id, rootPath: workerRef.rootPath },
            declaration: { workspaceRefId: workerRef.id, selection: { kind: 'manifest', name: 'web' } }, choice: destination }, captureOnly ? 'capture-only' : undefined, admissionChange),
        });
        return await workerWorkspaceSync.handoffAdapter.prepareBetween({ sourceWorkspaceRefId: options.sourceWorkspaceRefId ?? ref.id,
          targetWorkspaceRefId: options.targetWorkspaceRefId ?? workerRef.id }, undefined, {
          signal: new AbortController().signal, machineAdmission: admission, callerAuthority: 'present_user',
          callerInputAuthorization: projected, originalActionEnvelope: envelope, verifyMachineAdmissionCurrent: async () => true,
        });
      } finally { await settleMove(); if (!options.proposalOnly) await requester.dispose(); }
    },
    copies: () => copies, foreignSource: () => { sourceAccountId = 'foreign'; }, retireAfterCopy: () => { afterCopy = async () => {
      encryptionVersion++;
      await currentnessChannel?.push('account', { mode: 'plain', version: encryptionVersion, updatedAt: encryptionVersion,
        signingKeyFingerprint: null, contentKeyFingerprint: null });
    }; },
    async changeRequesterWorkerRoot() {
      const otherRoot = join(directory, 'other-account-worker');
      await mkdir(otherRoot);
      const index = rows.findIndex(row => row.key.kind === 'workspace-ref' && row.key.id === workerRef.id);
      const row = rows[index];
      if (!row || row.key.kind !== 'workspace-ref') throw new Error('Missing worker WorkspaceRef');
      const replacement = ProjectAccountRowV1Schema.parse({ key: row.key, revision: row.revision + 1,
        content: { t: 'plain', v: { key: row.key, value: { ...workerRef, rootPath: otherRoot } } } });
      rows[index] = replacement;
    },
    disconnectInstalledMachine: () => installedSocket?.disconnect(),
    source: () => source, hasApproval: () => artifact !== undefined,
    reviewSetup: (workspace = ref) => reviewProjectSetupEffect({ workspace,
      projectAssociation: { workspace, project: { serverId: homeId, projectId: workspace.projectKey } },
      requester: { credentials, serverHttpBaseUrl: params.serverHttpBaseUrl }, purpose: 'setup',
      platform: { os: process.platform, arch: process.arch }, nativeIo: { ...nativeIo.commandIo,
        resolveTool: async tool => ({ executablePath: `/managed/${tool}`, version: '1' }) },
    }),
    approval: async () => {
      const request = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: artifactId() }));
      if (request.execution?.ok) retainOperation(request.execution.result);
      return request;
    },
    decide: (decision: 'approve' | 'reject' | 'cancel', authority: 'present_user' | 'account_automation' = 'present_user') => {
      const reviewerCredentials = { ...credentials, token: authority === 'present_user' ? uiToken : cliToken };
      return createCliActionExecutorFromCredentials({ credentials: reviewerCredentials,
        serverId: 'srv_n2', serverApiUrl: params.serverHttpBaseUrl, machineId: target.machineId,
        externalActionClient: true, actionsSettingsProvider: settings, readCredentials: async () => reviewerCredentials,
      }).execute('approval.request.decide', { artifactId: artifactId(), decision, serverIdentityId: homeId },
        { surface: 'cli', authority });
    },
    decideFromCli: () => {
      const reviewerCredentials = foreignReviewerToken ? { ...credentials, token: foreignReviewerToken } : cliCredentials;
      return createCliActionExecutorFromCredentials({ credentials: reviewerCredentials,
      serverId: 'srv_n2', serverApiUrl: params.serverHttpBaseUrl, machineId: target.machineId,
      externalActionClient: true, actionsSettingsProvider: settings, readCredentials: async () => reviewerCredentials,
    }).execute('approval.request.decide', { artifactId: artifactId(), decision: 'approve', serverIdentityId: homeId },
      { surface: 'cli', authority: 'present_user' });
    },
    replay: () => rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId: artifactId() }),
    decideFromMachineAs: (actorAccountId: string) => rpc.handleRequest({
      method: target.machineId + ':' + RPC_METHODS.APPROVAL_REQUEST_DECIDE,
      params: { artifactId: artifactId(), decision: 'approve', serverIdentityId: homeId },
      callerAuthority: 'present_user', machineAdmission: { ...admission, actorAccountId },
    }),
    localFinite: (input: unknown) => rpc.invokeLocal(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run'], input),
    observeActionExecution: client.observeActionExecution.bind(client),
    readOperation: (operationId: string) => (actionId === 'projects.service.relocate' ? sourceRpc! : rpc).invokeLocal('actionOperation.get.v2', { operationId }),
    readReviewedOperation: (operationId: string) => rpc.invokeLocal('actionOperation.get.v2', { operationId, refreshSetupReview: true }),
    waitForTerminal: (operationId: string) => (actionId === 'projects.service.relocate' ? sourceRpc! : rpc).invokeLocal('actionOperation.get.v2', { operationId, waitForTerminal: true }),
    waitForSpawn(index: number) {
      const present = spawned[index];
      return present ? Promise.resolve(present) : new Promise<SetupBoundaryPty>(resolve => { spawnWaiters.set(index, resolve); });
    },
    cancelOperation: (operationId: string) => (actionId === 'projects.service.relocate' ? sourceRpc! : rpc).invokeLocal('actionOperation.cancel.v1', { operationId }),
    unadmittedPeerCancel: (operationId: string) => client.getPeerMediationMachineRpcHandlerManager()
      .invokeLocal('actionOperation.cancel.v1', { operationId }),
    readTransportOperation: (operationId: string, timeoutMs: number) => rpc.handleRequest({
      method: 'machine:actionOperation.get.v2', params: { operationId }, machineAdmission: admission, timeoutMs }),
    holdTrustRead() {
      trustRead = new Promise<void>(resolve => { releaseTrustRead = resolve; });
      return () => { releaseTrustRead(); trustRead = Promise.resolve(); };
    },
    async serviceInput() {
      if (worker) return { machineId: target.machineId,
        targetId: createProjectServiceDeclarationTargetIdV1(ref, { kind: 'manifest', name: 'checked' }),
        workspace: { serverId: homeId, workspaceId: ref.id, machineId: ref.machineId, rootPath },
        declaration: { workspaceRefId: ref.id, selection: { kind: 'manifest' as const, name: 'checked' } },
        choice: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: workerRef.machineId } } };
      const result = await runtimeActionExecute({ actionId: 'localServices.launcher.snapshot',
        input: { machineId: target.machineId, scope: 'workspace', workspaceRoot: rootPath }, context: { serverId: 'srv_n2' } });
      expect(result, JSON.stringify(result)).not.toHaveProperty('errorCode');
      const snapshot = LocalServiceLauncherSnapshotV1Schema.parse(result);
      const declaration = snapshot.targets.find(candidate => candidate.declaration);
      if (!declaration) throw new Error('Accepted Service declaration unavailable');
      return { machineId: target.machineId,
        targetId: declaration.id, workspace: { serverId: 'srv_n2', workspaceId: ref.id, machineId: target.machineId, rootPath },
        declaration: declaration.declaration };
    },
    async run(input: unknown, surface: 'ui' | 'cli', proposalAtIssuer: boolean | 'unsigned-ui' = false,
      authority: 'present_user' | 'account_automation' = 'account_automation', requestedActionId: ActionId = actionId,
      requestId = 'original-request', signal?: AbortSignal, reviewDigest?: string): Promise<ActionExecuteResult> {
      const authentication = { kind: surface === 'cli' ? 'terminal' as const : 'account' as const, tokenEpoch: 1 };
      const idempotencyKey = projectExternalActionRunNowIdempotencyKeyV1(requestedActionId, input);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target, input,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
      const presentUserConfirmation = reviewDigest ? { actionId: requestedActionId, accountId: 'account', serverId: homeId,
        requestId, inputDigest: computeActionInputApprovalDigestV1(requestedActionId, input), reviewDigest, target } : undefined;
      if (proposalAtIssuer) {
        // Original CLI placement precedes Machine admission. Injecting a Run
        // root here would lend that root to the issuer's separate Inspect read.
        return await (proposalAtIssuer === 'unsigned-ui' ? uiIssuer : issuer).execute(requestedActionId, input, { surface, authority,
          serverId: 'srv_n2', serverIdentityId: homeId, runtimeAccountId: 'account', actionRequestId: requestId,
          actionCaller: { kind: 'host' },
          ...(presentUserConfirmation ? { presentUserConfirmation } : {}),
          ...(requestedActionId === 'projects.script.run' ? {} : { externalActionTarget: envelope.target }) });
      }
      let authorization: ExternalActionExecutionAuthorizationV1 = home ? await home.mintAuthorization(requestedActionId, envelope, authentication)
        : ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'synthetic-home-root', binding: { accountId: 'account', custodianAccountId: cliPolicy?.machineCustodianAccountId ?? 'account',
        ...mintActionAdmission(requestedActionId, envelope),
        admittedMachineRole: cliPolicy?.machineRole ?? 'manage', authentication, accountEncryptionMode: 'plain' as const, serverIdentityId: homeId, machineId: target.machineId,
        installationId: installation.installationId, actionId: requestedActionId, requestId: envelope.requestId, target,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
      if (surface === 'ui' || reviewDigest || cliPolicy?.machineCustodianAccountId) {
        authorization = sealExternalActionRequesterAccountContextV1({ authorization,
          credentials: { ...encodeStoredCredentials(credentials), token: surface === 'cli' ? cliToken : uiToken },
          // UI externalActionAccountTransport seals its native confirmation for the receiving host.
          invocation: { caller: { kind: 'host' }, surface, authority,
            ...(presentUserConfirmation ? { presentUserConfirmation } : {}) }, purpose: { kind: 'external_action' },
          installationPublicKey: publicKey, randomBytes: tweetnacl.randomBytes });
      }
      expect(ExternalActionExecutionAuthorizationV1Schema.safeParse(authorization).success).toBe(true);
      expect(ExternalActionRequestEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect(await resolveOrigin()).toEqual({ serverIdentityId: homeId, machineId: target.machineId });
      const binding = authorization.binding;
      const principal = 'credentialId' in binding
        ? { accountId: binding.accountId, principalId: binding.principalId, credentialId: binding.credentialId,
            authority: 'account_automation' as const, grant: binding.grant }
        : { accountId: 'account', authority, authentication: binding.authentication };
      const result = await deliverExternalAction({ actionId: requestedActionId, envelope, principal,
        surface, executionAuthorization: authorization, ...(signal ? { signal } : {}) });
      expect(result.kind, JSON.stringify({ result, networkPaths, refusals: ingressRefusals.mock.calls
        .filter(([message]) => message === '[external-action-phase]').map(([, details]) => details) })).toBe('response');
      if (result.kind !== 'response') throw new Error('External Action ingress refused');
      if (result.response.v !== 1) throw new Error('Plain external Action ingress returned an encrypted response');
      if (result.response.execution.ok) retainOperation(result.response.execution.result);
      return result.response.execution;
    },
    raw: (input: unknown, requestId: string | null = 'original-request') => rpc.handleRequest({ method: target.machineId + ':' + actionId,
      params: input, ...(requestId ? { requestId } : {}), callerAuthority: 'present_user', machineAdmission: admission }),
    async close() {
      releaseTrustRead();
      for (const operationId of ownOperations) await (actionId === 'projects.service.relocate' ? sourceRpc! : rpc).invokeLocal('actionOperation.cancel.v1', { operationId });
      spawned.forEach(pty => pty.exit(0)); setupTerminals?.dispose();
      await sessionsRole?.stop();
      for (const syncRuntime of [...syncRuntimes].reverse()) await syncRuntime.stop();
      await remoteDeploymentRuntime?.stopControlServer(); await remoteDeploymentClient?.shutdown();
      await runtime.stopControlServer(); await client.shutdown();
      releaseProjection?.();
      await pluginRuntime?.dispose();
      resetInMemoryAccountSettingsContextForTests();
      env.restore(); reloadConfiguration(); await rm(directory, { recursive: true, force: true });
      harnessClosed = true;
    },
  };
  if (worker) await harness.ensureWorkerLink();
  return harness;
}
