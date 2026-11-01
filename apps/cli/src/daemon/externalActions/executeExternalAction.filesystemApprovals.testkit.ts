import { resolveMachineRpcWorkingDirectory } from '@/api/machine/resolveMachineRpcWorkingDirectory';
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
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';
import { AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
  MachineUpdateOperationProtocolCapabilitiesResponseV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { ApprovalRequestV2Schema, requiresExactDaemonApprovalReplay } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionRequestEnvelopeV1Schema,
  projectExternalActionRunNowIdempotencyKeyV1, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
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
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS, WorkspaceSyncSourceExecutionV1Schema, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { ApiMachineClient } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { ApiClient } from '@/api/api';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
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
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
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
import * as ptyBoundary from '@/terminal/pty/provider';
import * as processBoundary from '@happier-dev/cli-common/process';
import * as processTerminationBoundary from '@/processes/terminate/terminateProcessTree';
import type { PtyProcess, PtyExitEvent } from '@/terminal/pty/provider';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { admitRequesterAccountActionContext, prepareInstalledRequesterAccountActionContext, prepareRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionProjection";
import { createDaemonControlApp } from '@/daemon/controlServer';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createProductionDaemonWorkspaceSyncRuntime, type ProductionDaemonWorkspaceSyncRuntime,
  type ProductionDaemonWorkspaceSyncFactories } from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime';
import { createDaemonWorkspaceSyncRuntime } from '@/daemon/startup/createDaemonWorkspaceSyncRuntime';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { registerMachineWorkspaceSyncRpcHandlers } from '@/api/machine/rpcHandlers.workspaceSync';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent, doesWorkspaceSyncSourceRootMatchRouting } from '@/api/machine/machineRpcAuthorization';
import { mutateProjectAccountRows, readProjectAccountRows } from '@/workspaces/projectAccountRows';
import type { MutagenControlCommandV1, MutagenSessionSummaryV1 } from '@/workspaces/sync/transport/workspaceSyncBrokerProtocol';
import type { RpcRequest } from '@/api/rpc/types';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { registerActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
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
export async function createHarness(actionId: ActionId, approval: 'ask' | 'allowed' | 'denied' = 'ask', setup = false, homeId = 'srv_n2',
  home?: Readonly<{
    token: string;
    mintAuthorization(actionId: ActionId, envelope: ExternalActionRequestEnvelope,
      authentication: Readonly<{ kind: 'account' | 'terminal'; tokenEpoch: number }>): Promise<ExternalActionExecutionAuthorizationV1>;
    request(input: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown; headers: Record<string, string> }>): Promise<{ status: number; data: unknown }> | null;
    relayWorkspaceSource?(packet: SocketRpcRequestPayload, deliver: (request: RpcRequest) => Promise<unknown>): Promise<unknown>;
  }>, worker = false, sameMachineWorker = false,
  cliPolicy?: Readonly<{ authentication: 'account' | 'terminal'; askWithUiWaiver?: boolean; hostOnlyAsk?: 'waived' | 'unavailable' }>) {
  vi.spyOn(syncClient, 'createHappierSocket').mockImplementation(params => {
    // Substitute only the Home socket boundary; the transport adapter, RPC
    // codecs and real loopback requester-currentness connection remain real.
    if (params.clientType !== 'machine-scoped' && params.endpoint.startsWith('http://127.0.0.1:')
      || !socketBoundary.create.getMockImplementation()) return createHomeSocket(params);
    const socket = socketBoundary.create(params.endpoint, { auth: { ...params.authExtras,
      token: params.token, clientType: params.clientType, ...(params.clientType === 'machine-scoped' ? { machineId: params.machineId } : {}) } });
    return { socket, transport: syncClient.createSocketTransportAdapter(socket, { connectTimeoutMs: params.connectTimeoutMs }) };
  });
  const currentnessChannel = worker ? await createRequesterCurrentnessSocketHarness() : undefined;
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
  if (actionId === 'localServices.launcher.start') {
    await mkdir(join(rootPath, '.happier'), { recursive: true });
    await writeFile(join(rootPath, '.happier/project.json'), JSON.stringify({ version: 1,
      ...(setup ? { workspace: { setup: [{ kind: 'command', command: 'echo setup-reviewed' }] } } : {}),
      services: { checked: { ...(worker ? { execution: 'portable' } : {}),
        source: { kind: 'command', command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"` } } } }));
  }
  await writeFile(join(directory, 'outside'), 'outside unchanged');
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_MACHINE_RPC_WORKING_DIRECTORY']);
  env.patch({ HAPPIER_HOME_DIR: join(directory, 'srv_n2'), HAPPIER_ACTIVE_SERVER_ID: 'srv_n2',
    HAPPIER_SERVER_URL: 'https://home.example.test',
    // A Machine-only shell uses the host's default directory, outside the
    // disposable Project tree. Only its OS PTY boundary is substituted below.
    HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: actionId === 'machines.terminal.open'
      ? `${directory},${resolveMachineRpcWorkingDirectory()}` : directory });
  reloadConfiguration();
  expect(configuration.activeServerId).toBe('srv_n2');
  const terminalProvenance = AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' });
  const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: terminalProvenance })).toString('base64url') + '.installed-signature';
  // The app's original Account HTTP request has current provenance. The
  // installed daemon keeps its independent retained credential fixture.
  const uiToken = home?.token ?? 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url') + '.signature';
  const cliToken = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: terminalProvenance })).toString('base64url') + '.signature';
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
  if (worker) vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(() => rpcInstallation.getStore() ?? installation);
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
  const accountCurrentness = () => ({ mode: protectedMoveCredentials ? 'e2ee' as const : 'plain' as const,
    version: encryptionVersion, updatedAt: encryptionVersion, signingKeyFingerprint: null,
    contentKeyFingerprint: protectedMoveContentKeyFingerprint });
  const protectRequester = async () => {
    const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
    protectedMoveCredentials = { token: credentials.token, encryption: { ...material,
      publicKey: new Uint8Array(tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey) } };
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
  let afterCopy: (() => Promise<void>) | undefined;
  const sourceHandlers = new Map<string, (input: unknown, context?: import('@/api/rpc/types').RpcHandlerContext) => Promise<unknown>>();
  const accountSettings = { actionsSettingsV1: { v: 1, actions: approval === 'ask'
    ? { [actionId]: { approvalRequiredSurfaces: cliPolicy?.askWithUiWaiver ? ['cli'] : ['ui', 'rpc', 'cli'] } }
    : approval === 'denied' ? { [actionId]: { enabled: false } } : {},
    ...(approval === 'allowed' ? { approvalWaivedSurfaces: { [actionId]: ['ui', 'rpc', 'cli'] } }
      : cliPolicy?.askWithUiWaiver ? { approvalWaivedSurfaces: { [actionId]: ['ui'] } } : {}),
    ...(actionId === 'projects.service.relocate' ? { approvalWaivedSurfaces: {
      ...(approval === 'allowed' ? { [actionId]: ['ui', 'rpc', 'cli'] } : {}),
      'projects.service.placement.set': ['ui', 'rpc', 'cli'],
      'localServices.launcher.start': ['ui', 'rpc', 'cli'],
    } } : {}) } };
  let artifact: Readonly<Record<string, unknown>> | undefined;
  let servicePlacementContent: WorkspaceExecutionConfigContentV1 | null = null;
  let servicePlacementRevision = 0;
  let source: ProjectSourceV1 | null = { id: 'source', revision: 2, name: 'App', repository, audience: [], createdByAccountId: 'account' };
  const networkPaths: string[] = [];
  const rpcOutcomes: unknown[] = [];
  let changeRequesterRowsBeforePreparation: (() => void) | undefined;
  let originalMoveIngress: ((request: ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>) => Promise<unknown>) | undefined;
  const homeRequest = (method: 'GET' | 'POST', path: string, body: unknown, headers: unknown) => {
    if (!home || !headers || typeof headers !== 'object' || !Object.hasOwn(headers, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)) return null;
    return home.request({ method, path, ...(body === undefined ? {} : { body }), headers: Object.fromEntries(
      Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
  };
  let trustRead: Promise<void> = Promise.resolve();
  let releaseTrustRead = () => {};
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    networkPaths.push('GET ' + path);
    const admitted = homeRequest('GET', path, undefined, options?.headers);
    if (admitted) return await admitted;
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'account' } };
    if (path === '/v1/account/security') return { status: 200, data: AccountSecurityGetResponseV1Schema.parse({
      v: 1, encryptionMode: accountCurrentness().mode, terminalPresentUserPolicy: 'allowed', nativeEmail: null,
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
    if (artifact && path === '/v1/artifacts/' + artifact.id) return { status: 200, data: artifact };
    if (path === '/v1/account/authoring-memory') return { status: 200, data: { rows: [] } };
    if (worker && path === '/v1/machines/source-machine') return { status: 200, data: { machine: { id: ref.machineId,
      kind: 'persistent', active: true, storageMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      installationId: 'source-installation', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
      installationPublicKey: Buffer.from(sourceKeys.publicKey).toString('base64'),
      access: { custodian: { accountId: sourceAccountId, displayName: 'Source Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
    if (path === '/v1/machines/machine') return { status: 200, data: { machine: { id: 'machine', kind: 'persistent', active: true, storageMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      installationId: installation.installationId, installationPublicKey: publicKey.toString('base64'),
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
    if (path === '/v1/machines') return { status: 200, data: [{ id: 'machine', active: true, kind: 'persistent',
      installationId: installation.installationId, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } },
      ...(worker && !sameMachineWorker ? [{ id: ref.machineId, active: true, kind: 'persistent', installationId: 'source-installation',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
        access: { custodian: { accountId: sourceAccountId, displayName: 'Source Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }] : [])] };
    throw new Error('Unexpected Home GET ' + path);
  });
  const networkFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return networkFetch(url, options);
    const path = new URL(String(url)).pathname;
    networkPaths.push('FETCH ' + path);
    if (path !== '/v1/features' && path !== '/v1/features/authenticated') throw new Error('Unexpected Home fetch ' + path);
    return Response.json({ features: actionId === 'workflow.trigger.run_now' ? { workflows: { enabled: true }, automations: { enabled: true } }
      : actionId === 'localServices.launcher.start' || actionId === 'projects.service.relocate' ? { localServices: { enabled: true,
      inventory: { enabled: true }, launcher: { enabled: true }, actions: { enabled: true }, managed: { enabled: true } },
      browser: { enabled: true, viewTargets: { enabled: true } } } : {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } });
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    const path = new URL(String(url)).pathname;
    networkPaths.push('POST ' + path);
    const admitted = homeRequest('POST', path, body, options?.headers);
    if (admitted) return await admitted;
    if (path === '/v1/actions/projects.worker.copy.inspect/execution-authorization'
      || path === '/v1/actions/projects.worker.status/execution-authorization'
      || path === `/v1/actions/${actionId}/execution-authorization`
      || path === '/v1/actions/projects.inspect/execution-authorization'
      || path === '/v1/actions/projects.execution.output.read/execution-authorization'
      || path === '/v1/actions/projects.execution.output.copy/execution-authorization'
      || Object.keys(PROJECT_FINITE_ACTION_RPC_METHODS_V1).some(id => path === `/v1/actions/${id}/execution-authorization`)) {
      const requestedActionId = path === '/v1/actions/projects.worker.copy.inspect/execution-authorization' ? 'projects.worker.copy.inspect'
        : path === '/v1/actions/projects.worker.status/execution-authorization' ? 'projects.worker.status'
        : path === '/v1/actions/projects.inspect/execution-authorization' ? 'projects.inspect'
        : path === '/v1/actions/projects.execution.output.read/execution-authorization' ? 'projects.execution.output.read'
        : path === '/v1/actions/projects.execution.output.copy/execution-authorization' ? 'projects.execution.output.copy' : actionId;
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const authentication = { kind: options?.headers?.Authorization === `Bearer ${cliToken}` || options?.headers?.Authorization === `Bearer ${token}`
        ? 'terminal' as const : 'account' as const, tokenEpoch: 1 };
      return { status: 200, data: home ? await home.mintAuthorization(requestedActionId, request.envelope, authentication)
        : ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `${requestedActionId}-home-root`, binding: {
          accountId: 'account', custodianAccountId: 'account', authentication,
          accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: request.machineId,
          installationId: request.machineId === target.machineId ? installation.installationId : 'source-installation', actionId: requestedActionId, requestId: request.envelope.requestId,
          target: request.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        } }) };
    }
    if (path === '/v1/actions/projects.worker.status' || path === '/v1/actions/projects.worker.copy.inspect' || path === '/v1/actions/projects.inspect'
      || path === `/v1/actions/${actionId}`
      || path === '/v1/actions/projects.execution.output.read' || path === '/v1/actions/projects.execution.output.copy'
      || Object.keys(PROJECT_FINITE_ACTION_RPC_METHODS_V1).some(id => path === `/v1/actions/${id}`)) {
      const requestedActionId = path === '/v1/actions/projects.worker.status' ? 'projects.worker.status'
        : path === '/v1/actions/projects.worker.copy.inspect' ? 'projects.worker.copy.inspect'
        : path === '/v1/actions/projects.inspect' ? 'projects.inspect'
        : path === '/v1/actions/projects.execution.output.read' ? 'projects.execution.output.read'
        : path === '/v1/actions/projects.execution.output.copy' ? 'projects.execution.output.copy' : actionId;
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
      if (requestedActionId === 'projects.service.relocate' && originalMoveIngress) {
        return { status: 200, data: await originalMoveIngress(request) };
      }
      if (requestedActionId === 'projects.inspect' && worker && request.machineId === ref.machineId) {
        if (request.envelope.v !== 1) throw new Error('Standalone SOURCE inspection requires a plain request');
        const handler = sourceHandlers.get(getActionSpec('projects.inspect').bindings!.rpcMethod!);
        if (!handler) throw new Error('Missing real SOURCE registrar');
        const result = await handler(request.envelope.input, { signal: new AbortController().signal, callerAuthority: 'present_user' });
        const parsedInspection = ProjectDefinitionInspectOutputSchema.safeParse(result);
        rpcOutcomes.push({ actionId: 'projects.inspect', valid: parsedInspection.success,
          ...(parsedInspection.success ? {} : { issues: parsedInspection.error.issues.map(issue => ({ code: issue.code, path: issue.path })) }) });
        return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect',
          requestId: request.envelope.requestId, execution: { ok: true, result } }) };
      }
      const result = await executeExternalAction({ actionId: requestedActionId, envelope: request.envelope,
        principal: { accountId: 'account', authority: resolveExternalActionRootInvocationAuthority(authorization), authentication: authorization.binding.authentication },
        surface: authorization.binding.authentication.kind === 'terminal' ? 'cli' : 'ui',
        executionAuthorization: authorization, currentMachineId: target.machineId, currentServerId: 'srv_n2',
        currentServerHttpBaseUrl: params.serverHttpBaseUrl, currentInstallationId: installation.installationId,
        externalActionMachineRequestPrivateKey: privateKey, verifyExecutionAuthorization: verifyRoot,
        resolveTarget, executor: owner, prepareRequesterAccountContext: prepareRequester });
      if (result.kind !== 'response') throw new Error('Inspection ingress refused');
      if (result.response.v !== 1) throw new Error('Inspection ingress returned an encrypted response');
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
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
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
      if (changeRequesterRowsBeforePreparation && rpcOutcomes.some(outcome => typeof outcome === 'object'
        && outcome !== null && 'phase' in outcome && outcome.phase === 'installed.prepareBetween')) {
        changeRequesterRowsBeforePreparation();
        changeRequesterRowsBeforePreparation = undefined;
      }
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
  const syncRuntimes: ProductionDaemonWorkspaceSyncRuntime[] = [];
  const syncDaemonRuntimes: ReturnType<typeof createDaemonWorkspaceSyncRuntime>[] = [];
  let harnessClosed = false;
  onTestFinished(async () => {
    if (harnessClosed) return;
    spawned.forEach(pty => pty.exit(0)); setupTerminals?.dispose();
    try {
      await Promise.all(syncRuntimes.map(syncRuntime => syncRuntime.stop()));
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
      get workspaceSync() { return workerWorkspaceSync?.workspaceSync; },
      get workspaceSyncHandoffAdapter() { return workerWorkspaceSync?.handoffAdapter; },
      createProjectFiniteRuntime: async (ports, ingress) => {
        setupTerminals = ports.terminalSessions;
        const runtime = await createInstalledProjectFiniteRuntime({ api, credentials, externalActionAccountId: 'account',
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
  const admission = { actorAccountId: 'account', custodianAccountId: 'account', machineId: target.machineId,
    installationId: installation.installationId, role: 'manage' as const, encryptionMode: 'plain' as const };
  const sourceRpc: RpcHandlerManager | undefined = worker ? new RpcHandlerManager({ scopePrefix: ref.machineId, localMachineId: ref.machineId, encryptionMode: 'plain',
    authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: ref.machineId,
      resolveCustodianAccountId: async () => sourceAccountId, resolveInstallationId: () => sourceInstallation.installationId,
      verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: sourceInstallation.privateKey,
        daemonToken: token, serverHttpBaseUrl: 'https://home.example.test',
        ...(input.workspaceSyncSourceRouting ? { workspaceSyncSourceReceiver: {
          machineId: ref.machineId, installationId: sourceInstallation.installationId } } : {}) }) }),
    prepareRequesterAccountContext: request => prepareInstalledRequesterAccountActionContext({ ...request,
      purpose: request.purpose ?? { kind: 'external_action' }, machineId: ref.machineId, serverId: 'srv_n2',
      serverHttpBaseUrl: 'https://home.example.test',
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: ref.machineId }),
      createExecutor: context => createActionExecutor(createCliActionDeps({ ...params,
        token: context.credentials.token, credentials: context.credentials, projectDefinitionAction: sourceDefinitionAction,
        machineActionDirectTargetTransport: { machineId: ref.machineId,
          invoke: (method, request, options) => sourceRpc!.invokeLocal(method, request, options) } })) }),
  }) : undefined;
  let installedSocket: ReturnType<typeof createApiSessionSocketStub> | undefined;
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
        if (worker && packet.workspaceSyncSourceRouting) {
          if (!sourceRpc || !execution || !packet.requestId) throw new Error('Missing installed SOURCE packet');
          rpcOutcomes.push({ phase: 'installed.sourceDelivery', method: packet.method,
            originalEnvelopeVersion: packet.workspaceSyncSourceRouting.originalActionEnvelope?.v });
          expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
            requesterAccountContext: execution.authorization.requesterAccountContext, workspaceSyncSourceRouting: packet.workspaceSyncSourceRouting,
            effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
            event: SOCKET_RPC_EVENTS.CALL, method: packet.method, requestId: packet.requestId, params: packet.params,
            signature: execution.machineSignature, publicKey })).toBe(true);
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
        if (execution?.authorization.binding.actionId === 'projects.service.relocate' && ref.machineId !== target.machineId
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
            method: packet.method, requestId: packet.requestId!, params: packet.params,
            signature: execution.machineSignature, publicKey: Buffer.from(signer.publicKey, 'base64url') })).toBe(true);
          const result = await rpcInstallation.run(receiverInstallation, () => receiver.handleRequest({
            method: packet.method, params: packet.params, requestId: packet.requestId,
            callerAuthority: resolveExternalActionRootInvocationAuthority(execution.authorization), machineAdmission: receiverAdmission,
            callerInputAuthorization: execution.authorization,
            ...(packet.originalActionEnvelope ? { originalActionEnvelope: ExternalActionRequestEnvelopeSchema.parse(packet.originalActionEnvelope) } : {}),
            workspaceSyncSourceExecution: WorkspaceSyncSourceExecutionV1Schema.parse({ method: packet.method,
              params: packet.params, requestId: packet.requestId, externalActionExecution: execution,
              originalActionEnvelope: packet.originalActionEnvelope }),
          }));
          rpcOutcomes.push({ phase: 'installed.moveChildResponse', method: packet.method, result });
          return { ok: true, result };
        }
        if (execution?.authorization.requesterAccountContext) {
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
          event: SOCKET_RPC_EVENTS.CALL, method: packet.method, requestId: packet.requestId!, params: packet.params,
          signature: execution.machineSignature, publicKey }),
          `Machine RPC signature with requester custody=${Boolean(execution.authorization.requesterAccountContext)}`).toBe(true);
        const result = await rpc.handleRequest({ method: packet.method, params: packet.params,
          ...(packet.requestId ? { requestId: packet.requestId } : {}),
          callerAuthority: execution ? resolveExternalActionRootInvocationAuthority(execution.authorization) : 'present_user',
          machineAdmission: admission,
          ...(packet.originalActionEnvelope ? { originalActionEnvelope: ExternalActionRequestEnvelopeSchema.parse(packet.originalActionEnvelope) } : {}),
          ...(execution ? { callerInputAuthorization: execution.authorization } : {}) });
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
      void boundary.emitWithAck(SOCKET_RPC_EVENTS.CALL, packet).then(ack, (error: unknown) => ack({
        ok: false, errorCode: 'fixture_rpc_delivery_failed', error: error instanceof Error ? error.message : 'Fixture delivery failed',
      }));
    });
  });
  const resolveOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: params.serverHttpBaseUrl,
    resolveCurrentMachineId: () => target.machineId });
  const verifyRoot: NonNullable<Parameters<typeof executeExternalAction>[0]['verifyExecutionAuthorization']> = input =>
    verifyExternalActionExecutionAuthorizationCurrent({ ...input, privateKey, installationId: installation.installationId,
      serverHttpBaseUrl: params.serverHttpBaseUrl });
  const originCurrent = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'account', machineId: target.machineId, serverId: 'srv_n2',
    resolveCurrentMachineExecutionOriginContext: resolveOrigin, resolveTarget, isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }),
    externalActionMachinePublicKey: publicKey, verifyExternalExecutionAuthorization: verifyRoot });
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
  if (worker) registerProjectDefinitionHandlers({ machineId: ref.machineId,
    rpcHandlerManager: { registerHandler: (method, handler) => {
      sourceHandlers.set(method, handler);
      sourceRpc!.registerHandler(method, handler);
    } },
    actionExecutor: createActionExecutor(createCliActionDeps({ ...params, projectDefinitionAction: sourceDefinitionAction,
      machineActionDirectTargetTransport: { machineId: ref.machineId,
        invoke: (method, request, options) => sourceRpc!.invokeLocal(method, request, options) } })) });
  const serviceAction = actionId === 'localServices.launcher.start' || actionId === 'projects.service.relocate';
  const features = serviceAction ? await api.getServerFeaturesSnapshot({ refresh: true }) : undefined;
  api.setServerFeaturesSnapshotProvider(() => features);
  if (worker) {
    await readProjectAccountRows({ credentials, serverId: homeId, publication: 'installed' });
    const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
      canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] });
    const homeTarget = resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile',
      profile: { id: 'srv_n2', serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test', homeConnectionDescriptor: descriptor } });
    const composeSync = async (machineId: string) => {
      const sessions = new Map<string, MutagenSessionSummaryV1>();
      let endSidecar: (() => void) | undefined;
      const command = async (input: MutagenControlCommandV1): Promise<unknown> => {
        if (input.t === 'create' || input.t === 'flush') rpcOutcomes.push({ phase: 'native', machineId, command: input.t });
        if (input.t === 'shutdown') { endSidecar?.(); return null; }
        if (input.t === 'list') return { sessions: [...sessions.values()], nextCursor: null };
        if (input.t === 'create') {
          const endpoint = (value: string) => ({ protocol: 'external' as const, host: value.replace('external://', ''), path: '' as const,
            state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } });
          const session: MutagenSessionSummaryV1 = { identifier: input.session.name, name: input.session.name, labels: input.session.labels,
            alpha: endpoint(input.session.alpha), beta: endpoint(input.session.beta), mode: input.session.mode,
            paused: true, status: 'watching', successfulCycles: 0, conflictCount: 0 };
          sessions.set(session.identifier, session); return session;
        }
        if (input.t === 'terminate') { sessions.delete(input.sessionIdentifier); return null; }
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
          await cp(rootPath, workerRoot, { recursive: true }); copies++; await afterCopy?.();
        }
        const next = { ...session, paused: input.t === 'pause' ? true : input.t === 'resume' ? false : session.paused,
          successfulCycles: session.successfulCycles + (input.t === 'flush' ? 1 : 0) };
        sessions.set(next.identifier, next); return next;
      };
      const overrides: Partial<ProductionDaemonWorkspaceSyncFactories> = {
        resolveRootOwnershipDirectory: () => join(directory, 'sync-root-locks'), stopRetainedNativeProcesses: async () => {},
        createDaemonRuntime: deps => {
          const runtime = createDaemonWorkspaceSyncRuntime({ ...deps,
            resolveInstalledComponentPaths: () => ({ currentPath: '/fixture-engine', resolvedCurrentPath: '/fixture-engine' }),
            resolveArtifactPaths: () => ({ managerPath: '/fixture-engine/manager', agentPath: '/fixture-engine/agent' }),
            assertArtifactPayload: () => ({ engineVersion: '0.18.1', protocolEpoch: 'external-stream-v1' }) });
          syncDaemonRuntimes.push(runtime);
          return runtime;
        },
        createBroker: async () => ({ bootstrapDescriptor: new Uint8Array([1]), waitForReady: async () => {}, command, close: async () => {} }),
        spawnSidecar: async () => {
          const terminated = new Promise<{ type: 'exited'; code: number }>(resolve => { endSidecar = () => resolve({ type: 'exited', code: 0 }); });
          return { pid: process.pid, waitForTermination: () => terminated, stop: async () => endSidecar?.() };
        },
        launchLocalAgent: async () => ({ stream: new PassThrough(), stop: async () => {} }),
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
    await readProjectAccountRows({ credentials, serverId: homeId, publication: 'installed' });
    if (!sameMachineWorker) {
      sourceWorkspaceSync = await rpcInstallation.run(sourceInstallation, () => composeSync(ref.machineId));
      registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: sourceRpc!, service: sourceWorkspaceSync.workspaceSync });
    }
    copies = 0;
  }
  const runtimeActionExecute = api.createBrowserRuntimeActionExecutor();
  if (serviceAction) {
    pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
      ...(actionId === 'projects.service.relocate' ? { controller: pluginReloadController } : {}),
      runtimeOptions: { pluginIds: [], resolveCurrentMachineId: () => target.machineId } });
  }
  const runtime = await startDaemonSessionControlRuntime({ machineId: target.machineId, credentials,
    ...(worker ? { resolveProjectWorkerAction: () => createProjectWorkerAction({ machineId: target.machineId, serverId: 'srv_n2',
      serverHttpBaseUrl: params.serverHttpBaseUrl, credentials, accountId: 'account', admission: workerAdmission,
      isFiniteExecutionLive: () => actionId !== 'projects.service.relocate', isServiceExecutionLive: () => true }) } : {}),
    ...(pluginRuntime ? { pluginRuntimeController: pluginRuntime.controller } : {}),
    serverId: 'srv_n2', serverBaseUrl: params.serverHttpBaseUrl, externalActionAccountId: 'account',
    api, connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
    ...(serviceAction ? { runtimeActionExecute, resolveServerFeaturesSnapshot: () => features } : {}),
    ...(actionId === 'projects.service.relocate' ? { resolveWorkspaceSyncHandoffAdapter: () => workerWorkspaceSync?.handoffAdapter ?? null } : {}),
    daemonSessionMutationCustody: { stageTranscriptEvent: async () => { throw new Error('Unexpected Session event'); },
      stageTranscriptMessage: async () => { throw new Error('Unexpected Session message'); } },
    getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
    pidToTrackedSession: new Map(), pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
    getApiMachineForSessions: () => client, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
    connectedServicesRestartRequestedPids: new Set(), resolveCurrentMachineExecutionOriginContext: resolveOrigin,
    beforeShutdown: async () => {}, onHappySessionWebhook: async () => { throw new Error('Open must never start an Agent'); },
    requestShutdown() {}, processEnv: {} });
  releaseProjection = client.onConnectedServicesProjection(runtime.reconcileConnectedServicesProjection);
  const installed = runtime.externalActionIngressOwner;
  if (!installed) throw new Error('Production external Action owner was not installed');
  const owner = installed.executor;
  const prepareRequester = installed.prepareRequesterAccountContext;
  client.setRPCHandlers({ spawnSession: async () => { throw new Error('Open must never start an Agent'); },
    stopSession: async () => true, requestShutdown() {} }, { actionsSettingsProvider: settings,
    externalActionIngressOwner: installed });
  if (actionId === 'projects.open' || worker) {
    // The real installed Open receiver is reached on a connected Machine.
    // Connect the public client rather than bypassing its live transport check.
    await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force',
      honorAccountSettingsModeEnv: false, expectedAccountEncryptionMode: 'plain' });
    client.connect();
    await expect.poll(() => installedSocket?.connected).toBe(true);
  }
  const store = createCliApprovalsArtifactStore({ credentials, serverId: 'srv_n2' });
  const issuerParams = { ...params, ...(features ? { resolveServerFeaturesSnapshot: () => features } : {}) };
  const deciding = createCliActionExecutorHarness(issuerParams, { isApprovalExecutionOriginCurrent: originCurrent,
    approvalRequestApprovedReplay: async ({ artifactId, request }): Promise<ActionExecuteResult | null> => {
      if (request.v !== 2 || !requiresExactDaemonApprovalReplay(request)) return null;
      return await harness.run({ artifactId, decision: 'approve', serverIdentityId: homeId,
        originServerId: request.executionOriginV1.serverId }, 'ui', false, 'present_user', 'approval.request.decide', 'reviewer-request');
    } }).executor;
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
  const harness = { rootPath, directory, ref, workerRef, workerRelationship: relationship, rows, rpcOutcomes, networkPaths, finiteIngress, spawned, installation, sourceInstallation,
    async seedMoveService() {
      if (!pluginRuntime) throw new Error('Missing installed Service owner');
      let phase: 'running' | 'stopped' = 'running';
      let finishStop!: () => void;
      const stopped = new Promise<void>(resolve => { finishStop = resolve; });
      onTestFinished(() => finishStop());
      // Native lifecycle IO only: hold the physical Stop acknowledgement until
      // the accepted approval has returned and its ingress custody is disposed.
      const handle = await pluginRuntime.registry.projectManagedServices.superviseProject({ workspace: ref,
        declaration: { workspaceRefId: ref.id, selection: { kind: 'manifest', name: 'web' } },
        cwd: ref.rootPath, serviceId: 'web', specIdentity: 'web', execution: 'portable', isCurrent: () => true,
        requester: { serverId: homeId, accountId: 'account', machineId: ref.machineId, installationId: sourceInstallation.installationId },
        processSpec: { mode: { kind: 'native', instance: { adapter: { pluginId: 'fixture.plugin', localId: 'web' }, nativeResourceId: 'web' },
          lifecycle: { inspect: async () => ({ phase, readiness: 'not_reported', endpoint: null }),
            stop: async () => { await stopped; phase = 'stopped'; return { status: 'stopped' }; } } } },
        authorizeLaunch: async () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, release: async () => {} }),
      });
      const workspace = { serverId: homeId, refId: ref.id };
      const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: workerRef.machineId } };
      const request = ProjectServiceRelocateInputV1Schema.parse({ workspace, serviceName: 'web', requestId: 'retained-move',
        currentTarget: LocalServiceManagedServiceActionTargetV1Schema.parse({ kind: 'managed_service', managedServiceId: handle.instanceId,
          machineId: ref.machineId, workspaceId: ref.id, cwd: ref.rootPath, declaration: handle.declaration }),
        destination, selectedTarget: { machineId: workerRef.machineId }, desiredPlacement: { workspace, serviceName: 'web',
          expectedRevision: 'absent', expected: { kind: 'absent' }, value: { runsOn: destination, unavailable: 'fail' } } });
      return { request, finishStop, snapshot: handle.snapshot };
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
    directCopyPreview: (input: unknown) => rpcInstallation.run(installation, () => rpc.handleRequest({
      method: target.machineId + ':' + RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT,
      params: input, callerAuthority: 'present_user', machineAdmission: admission,
    })),
    humanToken: uiToken, installedToken: token,
    serviceInstances: () => pluginRuntime?.registry.projectManagedServices.listProjectServices() ?? [],
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
      const envelope = protectedMoveCredentials ? sealExternalActionRequestV2({ binding: { serverIdentityId: homeId,
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
      originalCli?: 'default' | 'source';
      inspectRequester?: (input: Readonly<{ authorization: ExternalActionExecutionAuthorizationV1;
        envelope: ExternalActionRequestEnvelope;
        status(variant?: 'missing-packet' | 'changed-input'): Promise<unknown>;
        start(captureOnly?: true): Promise<unknown>; settleMove(): Promise<void>; cancelMove(): Promise<void> }>) => Promise<unknown> }> = {}) {
      if (!workerWorkspaceSync) throw new Error('Missing real Sync composition');
      const destination = { kind: 'workers' as const, destination: { kind: 'machine' as const,
        machineId: options.selectedMachineId ?? workerRef.machineId } };
      const workspace = { serverId: homeId, refId: ref.id };
      const input = options.executeMove ?? ProjectServiceRelocateInputV1Schema.parse({ workspace, serviceName: 'web', requestId: 'reviewed-move',
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
      const envelope = protectedMoveCredentials ? sealExternalActionRequestV2({ binding: { serverIdentityId: homeId,
        accountId: 'account', actionId: 'projects.service.relocate', requestId: moveRequestId, target: moveTarget,
        authentication: { kind: 'account', tokenEpoch: 1 } }, input, material: options.protectedInput === 'other material'
          ? { type: 'dataKey', machineKey: tweetnacl.randomBytes(32) } : protectedMoveCredentials.encryption,
        randomBytes: tweetnacl.randomBytes }) : { v: 1 as const, requestId: moveRequestId, target: moveTarget, input };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'move-home-root', binding: {
        accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: protectedMoveCredentials ? 'e2ee' : 'plain', serverIdentityId: homeId, machineId: moveTarget.machineId,
        installationId: moveInstallation.installationId, actionId: 'projects.service.relocate', requestId: envelope.requestId,
        target: moveTarget, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      const requester = await admitRequesterAccountActionContext({ authorization,
        credentials: { ...(protectedMoveCredentials ?? credentials), token: options.requesterToken ?? credentials.token }, serverId: 'srv_n2',
        serverIdentityId: homeId, serverHttpBaseUrl: params.serverHttpBaseUrl, isCurrent: async () => true });
      if (!requester) throw new Error('Move requester custody was not admitted');
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
          const relocate = createProjectServiceRelocationRoute({ serverBaseUrl: params.serverHttpBaseUrl, credentials,
            projectManagedServices: pluginRuntime.registry.projectManagedServices,
            resolveWorkspaceSyncHandoffAdapter: () => sourceWorkspaceSync?.handoffAdapter ?? null });
          const sourceExecutor = createCliActionExecutorFromCredentials({ credentials, machineId: moveTarget.machineId,
            serverId: 'srv_n2', serverApiUrl: params.serverHttpBaseUrl, serverIdentityId: homeId,
            // This is the receiving SOURCE daemon, matching the production composer.
            actionsSettingsProvider: settings, pluginActionExecutionOwner: 'current_process',
            externalActionMachineInstallationId: moveInstallation.installationId, externalActionMachineRequestPrivateKey: moveKey,
            runActionOperation: operations.runActionOperation,
            projectDefinitionAction: sourceDefinitionAction,
            runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({ featureGate,
              ingress: { signal: new AbortController().signal,
                machineAdmission: { ...admission, machineId: ref.machineId, installationId: sourceInstallation.installationId },
                verifyMachineAdmissionCurrent: async () => true }, routes: {
              relocateService: relocate,
            } }),
          });
          let accepted: ActionExecuteResult;
          if (options.originalCli) {
            originalMoveIngress = async request => {
              const root = request.executionAuthorization;
              if (!root || !('authentication' in root.binding)) throw new Error('Missing original Move admission');
              const result = await executeExternalAction({ actionId: 'projects.service.relocate', envelope: request.envelope,
                principal: { accountId: 'account', authority: resolveExternalActionRootInvocationAuthority(root), authentication: root.binding.authentication },
                executionAuthorization: root, currentMachineId: ref.machineId, currentServerId: 'srv_n2',
                currentServerHttpBaseUrl: params.serverHttpBaseUrl, currentInstallationId: moveInstallation.installationId,
                externalActionMachineRequestPrivateKey: moveKey, executor: sourceExecutor, resolveTarget,
                verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                  privateKey: moveKey, installationId: moveInstallation.installationId, serverHttpBaseUrl: params.serverHttpBaseUrl }),
                prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ ...request,
                  purpose: { kind: 'external_action' }, machineId: ref.machineId, installationId: moveInstallation.installationId,
                  installationPrivateKey: moveKey, serverId: 'srv_n2', serverIdentityId: homeId,
                  serverHttpBaseUrl: params.serverHttpBaseUrl, ownCredentials: credentials, isCurrent: async () => true,
                  createExecutor: () => sourceExecutor }),
              });
              if (result.kind !== 'response') throw new Error('Original SOURCE Move ingress refused');
              return result.response;
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
              accepted = await createCliActionExecutorFromCredentials({ credentials, serverId: 'srv_n2',
                serverApiUrl: params.serverHttpBaseUrl, serverIdentityId: homeId, externalActionClient: true,
                ...(options.originalCli === 'source' ? { machineId: ref.machineId } : {}),
                actionsSettingsProvider: settings, readCredentials: async () => credentials,
              }).execute('projects.service.relocate', input, { surface: 'cli', authority: 'present_user', actionRequestId: envelope.requestId });
            } finally { await app.close(); originalMoveIngress = undefined; }
          } else accepted = await sourceExecutor.execute('projects.service.relocate', input, {
            serverId: 'srv_n2', surface: 'ui', authority: 'present_user', actionRequestId: envelope.requestId,
            // Match the host context of the original reviewed Move replay.
            bypassApprovals: true,
            externalActionTarget: moveTarget, externalActionExecutionAuthorization: projected, originalActionEnvelope: envelope,
          });
          if (!accepted.ok) return accepted;
          if (!accepted.result || typeof accepted.result !== 'object' || !('operation' in accepted.result)) {
            throw new Error('Missing accepted SOURCE Move operation: ' + JSON.stringify({ accepted, networkPaths, rpcOutcomes }));
          }
          const operation = ActionOperationSnapshotV1Schema.parse(accepted.result.operation);
          return await sourceRpc.invokeLocal('actionOperation.get.v2', { operationId: operation.operationId, waitForTerminal: true });
        }
        let capturedStart: RpcRequest | undefined;
        const child = async (actionId: 'projects.worker.status' | 'localServices.launcher.start', params: unknown,
          variant?: 'missing-packet' | 'changed-input' | 'capture-only') => {
            if (actionId === 'localServices.launcher.start' && capturedStart) return await rpc.handleRequest({ ...capturedStart, requestId: randomUUID(),
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
            return await rpc.handleRequest(packet);
        };
        if (options.inspectRequester) return await options.inspectRequester({ authorization: projected, envelope, settleMove, cancelMove,
          status: variant => child('projects.worker.status', { workspace,
            destination: { kind: 'machine', machineId: workerRef.machineId }, purpose: 'service-start' }, variant),
          start: captureOnly => child('localServices.launcher.start', { machineId: workerRef.machineId,
            targetId: createProjectServiceDeclarationTargetIdV1(workerRef, { kind: 'manifest', name: 'web' }),
            workspaceId: workerRef.id, workspace: { serverId: homeId, machineId: workerRef.machineId,
              workspaceId: workerRef.id, rootPath: workerRef.rootPath },
            declaration: { workspaceRefId: workerRef.id, selection: { kind: 'manifest', name: 'web' } }, choice: destination }, captureOnly ? 'capture-only' : undefined),
        });
        return await workerWorkspaceSync.handoffAdapter.prepareBetween({ sourceWorkspaceRefId: options.sourceWorkspaceRefId ?? ref.id,
          targetWorkspaceRefId: options.targetWorkspaceRefId ?? workerRef.id }, undefined, {
          signal: new AbortController().signal, machineAdmission: admission, callerAuthority: 'present_user',
          callerInputAuthorization: projected, originalActionEnvelope: envelope, verifyMachineAdmissionCurrent: async () => true,
        });
      } finally { await settleMove(); await requester.dispose(); }
    },
    copies: () => copies, foreignSource: () => { sourceAccountId = 'foreign'; }, retireAfterCopy: () => { afterCopy = async () => {
      encryptionVersion++;
      await currentnessChannel?.push('account', { mode: 'plain', version: encryptionVersion, updatedAt: encryptionVersion,
        signingKeyFingerprint: null, contentKeyFingerprint: null });
    }; },
    async changeRequesterWorkerRoot(timing: 'immediate' | 'beforePreparation' = 'immediate') {
      const otherRoot = join(directory, 'other-account-worker');
      await mkdir(otherRoot);
      const index = rows.findIndex(row => row.key.kind === 'workspace-ref' && row.key.id === workerRef.id);
      const row = rows[index];
      if (!row || row.key.kind !== 'workspace-ref') throw new Error('Missing worker WorkspaceRef');
      const replacement = ProjectAccountRowV1Schema.parse({ key: row.key, revision: row.revision + 1,
        content: { t: 'plain', v: { key: row.key, value: { ...workerRef, rootPath: otherRoot } } } });
      // A pre-request same-Account row update may legitimately refresh the
      // installed projection during passive inspection. The preparation-refusal
      // case moves Home's root after acceptance so the guard sees a mismatch;
      // output-reader cases change the already-running workspace immediately.
      if (timing === 'beforePreparation') changeRequesterRowsBeforePreparation = () => { rows[index] = replacement; };
      else rows[index] = replacement;
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
    decide: (decision: 'approve' | 'reject' | 'cancel', authority: 'present_user' | 'account_automation' = 'present_user') =>
      deciding.execute('approval.request.decide', { artifactId: artifactId(), decision }, { surface: 'ui', authority }),
    decideFromCli: () => createCliActionExecutorFromCredentials({ credentials: cliCredentials,
      serverId: 'srv_n2', serverApiUrl: params.serverHttpBaseUrl, machineId: target.machineId,
      externalActionClient: true, actionsSettingsProvider: settings, readCredentials: async () => cliCredentials,
    }).execute('approval.request.decide', { artifactId: artifactId(), decision: 'approve', serverIdentityId: homeId },
      { surface: 'cli', authority: 'present_user' }),
    replay: () => rpc.invokeLocal(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId: artifactId() }),
    localFinite: (input: unknown) => rpc.invokeLocal(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.script.run'], input),
    readOperation: (operationId: string) => rpc.invokeLocal('actionOperation.get.v2', { operationId }),
    readReviewedOperation: (operationId: string) => rpc.invokeLocal('actionOperation.get.v2', { operationId, refreshSetupReview: true }),
    waitForTerminal: (operationId: string) => rpc.invokeLocal('actionOperation.get.v2', { operationId, waitForTerminal: true }),
    waitForSpawn(index: number) {
      const present = spawned[index];
      return present ? Promise.resolve(present) : new Promise<SetupBoundaryPty>(resolve => { spawnWaiters.set(index, resolve); });
    },
    cancelOperation: (operationId: string) => rpc.invokeLocal('actionOperation.cancel.v1', { operationId }),
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
      requestId = 'original-request', signal?: AbortSignal): Promise<ActionExecuteResult> {
      const authentication = { kind: surface === 'cli' ? 'terminal' as const : 'account' as const, tokenEpoch: 1 };
      const idempotencyKey = projectExternalActionRunNowIdempotencyKeyV1(requestedActionId, input);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target, input,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
      if (proposalAtIssuer) {
        // Original CLI placement precedes Machine admission. Injecting a Run
        // root here would lend that root to the issuer's separate Inspect read.
        return await (proposalAtIssuer === 'unsigned-ui' ? uiIssuer : issuer).execute(requestedActionId, input, { surface, authority,
          serverId: 'srv_n2', serverIdentityId: homeId, runtimeAccountId: 'account', actionRequestId: requestId });
      }
      let authorization: ExternalActionExecutionAuthorizationV1 = home ? await home.mintAuthorization(requestedActionId, envelope, authentication)
        : ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'synthetic-home-root', binding: { accountId: 'account', custodianAccountId: 'account',
        authentication, accountEncryptionMode: 'plain' as const, serverIdentityId: homeId, machineId: target.machineId,
        installationId: installation.installationId, actionId: requestedActionId, requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
      if (actionId === 'account.apiTokens.create' && requestedActionId === 'approval.request.decide') {
        authorization = sealExternalActionRequesterAccountContextV1({ authorization,
          credentials: { ...encodeStoredCredentials(credentials), token: uiToken },
          invocation: { caller: { kind: 'host' }, surface, authority }, purpose: { kind: 'external_action' },
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
      const result = await executeExternalAction({ actionId: requestedActionId, envelope, principal,
        surface, executionAuthorization: authorization, currentMachineId: target.machineId, currentServerId: 'srv_n2',
        ...(signal ? { signal } : {}),
        currentServerHttpBaseUrl: params.serverHttpBaseUrl, currentInstallationId: installation.installationId,
        externalActionMachineRequestPrivateKey: privateKey, verifyExecutionAuthorization: verifyRoot,
        resolveTarget, executor: owner, prepareRequesterAccountContext: prepareRequester });
      expect(result.kind, JSON.stringify({ result, networkPaths })).toBe('response');
      if (result.kind !== 'response') throw new Error('External Action ingress refused');
      if (result.response.v !== 1) throw new Error('Plain external Action ingress returned an encrypted response');
      if (result.response.execution.ok) retainOperation(result.response.execution.result);
      return result.response.execution;
    },
    raw: (input: unknown, requestId: string | null = 'original-request') => rpc.handleRequest({ method: target.machineId + ':' + actionId,
      params: input, ...(requestId ? { requestId } : {}), callerAuthority: 'present_user', machineAdmission: admission }),
    async close() {
      releaseTrustRead();
      for (const operationId of ownOperations) await rpc.invokeLocal('actionOperation.cancel.v1', { operationId });
      spawned.forEach(pty => pty.exit(0)); setupTerminals?.dispose();
      for (const syncRuntime of [...syncRuntimes].reverse()) await syncRuntime.stop();
      await runtime.stopControlServer(); await client.shutdown();
      releaseProjection?.();
      await pluginRuntime?.dispose();
      resetInMemoryAccountSettingsContextForTests();
      env.restore(); reloadConfiguration(); await rm(directory, { recursive: true, force: true });
      harnessClosed = true;
    },
  };
  return harness;
}

