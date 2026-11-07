import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentFlowCostObserver, type DeploymentFlowCostObserver } from './workflow.deploymentFlowCosts.testkit';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { Socket } from 'socket.io-client';
import {
    sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
    openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1, WorkflowRunSummaryV1Schema,
    type AutomationAccountCurrentnessWitnessV1, type WorkflowAcceptedSnapshotV1, type ExternalActionExecutionAuthorizationV1, type ActionExecutorContext,
    DeploymentPublishInputV1Schema, DeploymentEnvironmentCreateResultV1Schema, type DeploymentPublishInputV1, type DeploymentPrepareInputV1,
    type MachineSetupApplyInputV1, type MachineSetupCombinedPlanInputV1, type MachineSetupAppChildV1, type MachinePresetItemV1, type MachineSetupDesiredV1,
    MachineSetupCombinedPlanResultV1Schema,
    DeploymentTemplateInstantiateInputV1Schema, DeploymentTemplateInstantiateResultV1Schema,
    type WorkflowDefinitionV1, type WorkflowCheckpointEnvelopeV1, type ExternalActionDaemonDispatchRequest,
    WorkflowRunStartRequestV1Schema,
    admitCombinedActionWorkflowHostV1,
    resolveCombinedActionWorkflowHostV1, WorkflowRunInvocationIndexV1Schema, DeploymentActionOutputSchemasV1,
    deriveWorkflowReplacementId, ArtifactJsonCreateHttpInputV1Schema, createEmptyMachineSetupDesiredV1,
} from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import {
    MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1,
    machinePresetActionEndpointPathV1, type MachinePresetActionInputV1,
} from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import * as actionResultProjection from '../../../../packages/protocol/src/actions/executor/resultProjection';
import { redactBugReportSensitiveText } from '../../../../packages/protocol/src/bugs/reports/redaction';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { WorkflowOperationErrorCodeV1Schema, WorkflowTargetUnavailableDetailsV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { ProjectSourcesCreateInputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { getActionSpec, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { resolveApprovalExecutor } from '../../../../packages/protocol/src/approvals/resolveApprovalExecutor';
import { createWorkflowCoordinator } from '../../../../apps/cli/src/daemon/workflows/coordinator';
import { DurableWorkflowCoordinatorStore, createProductionWorkflowRunCoordinator } from '../../../../apps/cli/src/daemon/workflows/production';
import { createWorkflowActionContextResolver } from '../../../../apps/cli/src/daemon/workflows/workflowActionContext';
import * as workflowApprovedOperationOwner from '../../../../apps/cli/src/daemon/workflows/workflowApprovedOperation';
import { createCoordinatorWorkspaceResolver, prepareWorkflowAcceptedWorkspaceTarget } from '../../../../apps/cli/src/daemon/workflows/resolveWorkflowWorkspace';
import { createCredentialedWorkflowMaterializationHostV1 } from '../../../../apps/cli/src/session/actions/workflowMaterializationHost';
import { createWorkflowAcceptedAuthorizationCurrentness } from '../../../../apps/cli/src/daemon/workflows/daemonRuntime';
import { createWorkflowRunStorageClient } from '../../../../apps/cli/src/daemon/workflows/workflowRunStorageClient';
import { createWorkflowInvocationRecoveryObserver, observeWorkflowInvocationRecoveryEvidence, resolveWorkflowSessionConversation } from '../../../../apps/cli/src/daemon/workflows/invocationRecoveryObserver';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { createWorkflowInvocationRecoveryFactWriter } from '../../../../apps/cli/src/daemon/workflows/recovery';
import { createWorkflowRunActionOwner } from '../../../../apps/cli/src/session/actions/workflowRunActions';
import { createWorkflowActionExecutor } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { createCliWorkflowRunStorage } from '../../../../apps/cli/src/session/actions/workflowRunStorage';
import { createCliApprovalsArtifactStore } from '../../../../apps/cli/src/session/actions/approvals/artifactStore';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '../../../../apps/cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { readHttpStatus } from '../../../../apps/cli/src/api/client/httpStatusError';
import { resolveAutomationWorkerAccountEncryption } from '../../../../apps/cli/src/daemon/automation/automationWorker';
import { prepareExternalActionRequesterAccountAuthorization, prepareExternalActionRequesterAccountAuthorizationWithEnvelope,
    dispatchOriginalAccountAction,
    projectExternalActionRequesterHttpAuthorization,
    resolveExternalActionServerRequestHeaders,
    verifyExternalActionExecutionAuthorizationCurrent } from '../../../../apps/cli/src/api/externalActionExecutionAuthorization';
import { projectRequesterAccountActionAuthorization, prepareRequesterAccountActionContext, prepareInstalledRequesterAccountActionContext, admitRequesterAccountActionContext,
    type RequesterAccountActionContext } from '../../../../apps/cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { createCurrentMachineExecutionOriginContextResolver } from '../../../../apps/cli/src/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createActionSettingsProvider } from '../../../../apps/cli/src/settings/actionsSettingsProvider';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createGitWorkspace, runGit } from '../../../../apps/cli/src/scm/rpc/__tests__/testRpcHarness';
import { removeTempDir } from '../../../../apps/cli/src/testkit/fs/tempDir';
import { pluginReloadController } from '../../../../apps/cli/src/plugins/runtime/reload/singleton';
import { acquireRequesterAccountEncryptionCurrentness } from '../../../../apps/cli/src/api/client/accountEncryptionCurrentnessObservation';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { registerExternalActionRpcHandler, type ExternalActionIngressOwner } from '../../../../apps/cli/src/rpc/handlers/externalAction';
import type { RpcHandler, RpcHandlerContext } from '../../../../apps/cli/src/api/rpc/types';
import { ACTION_API_SERVER_ORIGIN, SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, ExternalActionHttpErrorSchema, parseExternalActionDaemonDispatchResult,
    projectDeploymentPreparationAdmissionV1, projectDeploymentReadAdmissionV1,
    projectExternalActionRunNowIdempotencyKeyV1, projectExternalActionManagedAdmissionV1,
    projectRegistryAppUpdateAdmissionV1, projectExternalActionApprovalDecisionAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createActionExecutorBoundaryFixture } from '../../src/testkit/actionExecutorBoundary';
import { createCliActionDeps } from '../../../../apps/cli/src/session/actions/createCliActionDeps';
import { fetchServerFeaturesSnapshot, readServerIdentityIdFromFeaturesSnapshot } from '../../../../apps/cli/src/features/serverFeaturesClient';
import { createCliActionExecutor } from '../../../../apps/cli/src/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from '../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker } from '../../../../apps/cli/src/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createCredentialedTargetActionCurrentIntent } from '../../../../apps/cli/src/session/actions/approvals/credentialedTargetActionCurrentIntent';
import { prepareSessionCreationTarget } from '../../../../apps/cli/src/session/creation/prepareSessionCreationTarget';
import { createPublishProjectActionDeps, buildPublishWorkflow } from '../../../../apps/cli/src/workspaces/publishProject';
import { createPreparedPublishTestFixture } from '../../../../apps/cli/src/workspaces/publishProject.testkit';
import { buildMachineSetupWorkflow, buildMachineSetupTargetApplyInput, createCombinedMachineSetupActionDeps } from '../../../../apps/cli/src/machines/setup/composeMachineSetup';
import { createHostActionOperationRuntime } from '../../../../apps/cli/src/daemon/actionOperations/createHostActionOperationRuntime';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { ApiMachineClient } from '../../../../apps/cli/src/api/apiMachine';
import { RpcHandlerManager } from '../../../../apps/cli/src/api/rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ApiClient } from '../../../../apps/cli/src/api/api';
import { startDaemonSessionControlRuntime } from '../../../../apps/cli/src/daemon/startup/startDaemonSessionControlRuntime';
import { createManagedProviderOperationAuthority } from '../../../../apps/cli/src/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '../../../../apps/cli/src/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../../../../apps/cli/src/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createEnvKeyScope } from '../../../../apps/cli/src/testkit/env/envScope';
import { createMachineSetupPlanAction } from '../../../../apps/cli/src/machines/setup/machineSetupAction';
import * as setupAcceptedAppRuns from '../../../../apps/cli/src/machines/setup/acceptedAppRuns';
import * as deploymentDefinitionAdmission from '../../../../apps/cli/src/deployments/deploymentDefinitionAdmission';
import * as externalActionAuthorization from '../../../../apps/cli/src/api/externalActionExecutionAuthorization';
import { createApiSessionSocketStub } from '../../../../apps/cli/src/testkit/backends/apiSessionSocketHarness';
import type { Machine as ApiMachine } from '../../../../apps/cli/src/api/types';
import { configuration, reloadConfiguration } from '../../../../apps/cli/src/configuration';
import { adoptServerProfileHomeConnectionDescriptor } from '../../../../apps/cli/src/server/serverProfiles';
import { logger } from '../../../../apps/cli/src/ui/logger';
import { writeDaemonState, clearDaemonStateForTestTeardown, type StoredCredentials } from '../../../../apps/cli/src/persistence';
import { encodeBase64, decodeBase64, encryptWithDataKey, decryptWithDataKey } from '../../../../apps/cli/src/api/encryption';
import { resolveWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { callExactMachineRpc } from '../../../../apps/cli/src/session/transport/rpc/machineRpc';
import * as machineRpcTransport from '../../../../apps/cli/src/session/transport/rpc/machineRpc';
import { ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MachineSetupApplyInputV1Schema, MachineSetupPlanInputV1Schema,
    readMachineSetupPlanChildInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createOwnServerDockerBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createOwnServerDeploymentRuntimeForHost } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import * as ownServerHostRuntime from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import * as deploymentOutputValidation from '../../../../apps/cli/src/deployments/outputValidation';
import { createDaemonDeploymentActionDeps } from '../../../../apps/cli/src/deployments/createDaemonDeploymentActionDeps';
import { createCliDeploymentActionDeps, type DeploymentReceiptDispatchV1 } from '../../../../apps/cli/src/deployments/createCliDeploymentActionDeps';
import { createCliProjectAdmission } from '../../../../apps/cli/src/session/actions/cliActionDeps/projectAdmission';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '../../../../apps/cli/src/plugins/testkit/admittedRuntime';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { createCliRegistryHostV1 } from '../../../../apps/cli/src/registries/createCliRegistryHost';
import { createFilesystemEffectAdmission } from '../../../../apps/cli/src/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { RpcActionExecutorContext } from '../../../../apps/cli/src/rpc/handlers/_actionDispatchAdapter';
import { updateAccountSettingsV2OnceAgainstLatest } from '../../../../apps/cli/src/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { DeploymentEnvironmentContentV1Schema, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';

const nativeBoundary = vi.hoisted(() => ({
    costRead: null as ((kind: string) => void) | null,
    machineId: null as string | null,
    identity: null as import('@happier-dev/protocol').MachineInstallationIdentityV1 | null,
    credentials: null as import('../../../../apps/cli/src/persistence').StoredCredentials | null,
    launches: [] as Array<{ file: string; args: string[]; machineId: string | null }>,
    ptySpawnFault: null as { machineId: string; observed: boolean } | null,
    failedPtyStarts: [] as string[],
    installationScope: null as AsyncLocalStorage<Readonly<{
        machineId: string;
        identity: import('@happier-dev/protocol').MachineInstallationIdentityV1;
        credentials: import('../../../../apps/cli/src/persistence').StoredCredentials;
    }>> | null,
}));

function failArmedNativeSpawn(machineId: string | null): void {
    const fault = nativeBoundary.ptySpawnFault;
    if (!machineId || fault?.machineId !== machineId) return;
    if (!fault.observed) {
        fault.observed = true;
        nativeBoundary.failedPtyStarts.push(machineId);
    }
    throw Object.assign(new Error('Native executable unavailable before process creation'), { code: 'ENOENT' });
}

// Installed credential/key files and PTY loading are OS boundaries. The real
// ApiMachine, setup interpreter, task admission and terminal owner stay live.
vi.mock('../../../../apps/cli/src/persistence', async importOriginal => {
    const actual = await importOriginal<typeof import('../../../../apps/cli/src/persistence')>();
    return { ...actual,
        readStoredCredentialsForServerId: async () => { nativeBoundary.costRead?.('credentials');
            return nativeBoundary.installationScope?.getStore()?.credentials ?? nativeBoundary.credentials; },
        readSettings: async () => {
            nativeBoundary.costRead?.('settings');
            const machineId = nativeBoundary.installationScope?.getStore()?.machineId ?? nativeBoundary.machineId;
            return { ...await actual.readSettings(), ...(machineId ? { machineId } : {}) };
        },
    };
});
vi.mock('../../../../apps/cli/src/daemon/identity/store', async importOriginal => {
    const actual = await importOriginal<typeof import('../../../../apps/cli/src/daemon/identity/store')>();
    return { ...actual,
        readInstallationIdentityIfExistsSync: () => { nativeBoundary.costRead?.('identity');
            return nativeBoundary.installationScope?.getStore()?.identity ?? nativeBoundary.identity; },
        readOrCreateInstallationIdentity: async () => {
            nativeBoundary.costRead?.('identity');
            const current = nativeBoundary.installationScope?.getStore() ?? nativeBoundary;
            return current.machineId && current.identity ? current.identity : await actual.readOrCreateInstallationIdentity();
        },
    };
});
vi.mock('node:module', async importOriginal => {
    const actual = await importOriginal<typeof import('node:module')>();
    return { ...actual, createRequire: (...args: Parameters<typeof actual.createRequire>) => {
        const original = actual.createRequire(...args);
        return Object.assign((id: string) => {
            if (id === '@homebridge/node-pty-prebuilt-multiarch') {
                // Preserve optional backend availability: a missing package
                // must still fail its actual require rather than be invented.
                const loaded: unknown = original(id);
                if (!loaded || typeof loaded !== 'object' || !('spawn' in loaded) || typeof loaded.spawn !== 'function') return loaded;
                const spawn = loaded.spawn;
                return { ...loaded, spawn: (...spawnArgs: unknown[]) => {
                    failArmedNativeSpawn(nativeBoundary.installationScope?.getStore()?.machineId ?? nativeBoundary.machineId);
                    return Reflect.apply(spawn, loaded, spawnArgs);
                } };
            }
            if (id !== 'node-pty') return original(id);
            return { spawn(file: string, argv: string[]) {
                const machineId = nativeBoundary.installationScope?.getStore()?.machineId ?? nativeBoundary.machineId;
                failArmedNativeSpawn(machineId);
                nativeBoundary.launches.push({ file, args: argv, machineId });
                return { pid: 2147483600, write() {}, resize() {}, kill() {},
                    onData() { return { dispose() {} }; }, onExit(listener: (event: { exitCode: number }) => void) {
                        queueMicrotask(() => listener({ exitCode: 0 })); return { dispose() {} };
                    } };
            } };
        }, original);
    } };
});
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
        const env = args[2]?.env;
        // Only the real PTY relay spawn belongs to this fault. SCM, probes,
        // migrations and all other process boundaries remain actual.
        if (typeof env?.HAPPIER_PYTHON_PTY_RELAY_COLS === 'string'
            || typeof env?.HAPPIER_PYTHON_PTY_RELAY_ROWS === 'string'
            || typeof env?.HAPPIER_NODE_PTY_RELAY_COLS === 'string'
            || typeof env?.HAPPIER_NODE_PTY_RELAY_ROWS === 'string') {
            failArmedNativeSpawn(nativeBoundary.installationScope?.getStore()?.machineId ?? null);
        }
        return actual.spawn(...args);
    } };
});

type Machine = Readonly<{ id: string; installationId: string; keys: tweetnacl.SignKeyPair }>;
type PublishHostChoice = 'environment' | 'person' | 'agent';
type DeploymentContentReference = Readonly<{ contentArtifactId: string; contentHeaderVersion: number; contentBodyVersion: number }>;
type ServerBoundary = Readonly<{
    accountId: string; tokenEpoch: number; token: string; homeId: string; baseUrl: string;
    currentness: AutomationAccountCurrentnessWitnessV1; machines: readonly Machine[];
    createDeploymentArtifact(input: Readonly<{ header: Readonly<Record<string, unknown>>; body: string }>): Promise<DeploymentContentReference>;
    createDeploymentProject(): Promise<{ projectSourceId: string; audience: readonly unknown[];
        environmentContent: DeploymentContentReference; runtimeContent: DeploymentContentReference }>;
    createDeploymentProjectSource(): Promise<{ projectSourceId: string; audience: readonly unknown[] }>;
    createPrepareWorkspace(input: Readonly<{ rootPath: string; machineId: string; baseCommit: string }>): Promise<DeploymentPrepareInputV1>;
    publisherHeader(input: { machineId: string; path: string; body: unknown }): string;
    claim(machineId: string): Promise<{ runId: string; attempt: number; revision: number }>;
    revokeAccount(): Promise<void>;
    setMachineOnline(machineId: string, active: boolean): Promise<void>;
    seedMachineSetupDesired(machineId: string, desired: MachineSetupDesiredV1): Promise<void>;
    demoteDeploymentCaller(): Promise<void>;
    readDeploymentEffects(environmentId: string): Promise<readonly Readonly<{
        id: string; requestedByAccountId: string; state: string; contentArtifactId: string;
    }>[]>;
    readMachines(): Promise<readonly { machineId: string; online: boolean }[]>;
    setReceiver(machineId: string, receive: (request: ExternalActionDaemonDispatchRequest, signal?: AbortSignal,
        transport?: Readonly<{ forward(): Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false }>> }>) => Promise<unknown>): void;
    setCostPhase(phase: string): void;
    readRequestCosts(): Array<{ phase: string; method: string; route: string; admissions: number; status: number | null }>;
    close(): Promise<void>;
}>;

// Server sources have their own @/* alias and compiler. Keep that app's
// implementation behind its owner-exported testkit rather than recursively
// including server internals in the CLI-oriented shared TypeScript program.
const serverTestkitPath = '../../../../apps/server/sources/testkit/workflowApprovedOperationServer.testkit';
type ServerFixtureInput = Readonly<{ deploymentTeamOwned?: boolean; e2ee?: Readonly<{ contentPublicKey: Uint8Array;
    encodeMachine(key: Uint8Array, value: unknown): string;
    decodeMachine(key: Uint8Array, value: string): unknown }> }>;
async function startServer(input: ServerFixtureInput = {}): Promise<ServerBoundary> {
    const { startWorkflowApprovedOperationServer } = await import(serverTestkitPath) as {
        startWorkflowApprovedOperationServer(input?: ServerFixtureInput): Promise<ServerBoundary>;
    };
    return startWorkflowApprovedOperationServer(input);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    try { for (const close of cleanups.splice(0).reverse()) await close(); }
    finally { vi.unstubAllEnvs(); }
});

/** Only installed files and Docker are substituted; preparation/storage/target stay real. */
async function createNativeSetupApp(server: ServerBoundary, machine: Machine, catalog = false,
    credentials: StoredCredentials = { token: server.token, encryption: null }, flow?: DeploymentFlowCostObserver) {
    const directory = await mkdtemp(join(tmpdir(), 'happier-combined-setup-app-'));
    cleanups.push(async function removeNativeSetupDirectory() { await removeTempDir(directory); });
    const previousHome = configuration.happyHomeDir;
    Reflect.set(configuration, 'happyHomeDir', directory);
    cleanups.push(async function restoreNativeSetupHome() { Reflect.set(configuration, 'happyHomeDir', previousHome); });
    const docker = await createOwnServerDockerBoundary(join(directory, 'tools'));
    vi.stubEnv('PATH', `${join(directory, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
    const image = await docker.registerImage('app', 'combined-setup');
    const document = JSON.stringify({ services: { app: { image: image.registryReference } } });
    const pluginId = 'com.happier.setup-catalog-fixture';
    const authored = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Setup catalog fixture', registrySources: {
        apps: { title: 'Setup apps', format: 'happier-catalog', kinds: ['app'], packageContent: { path: 'resources/apps.json' } },
    } });
    const mounted = catalog ? await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        plugins: [{ manifest: authored.manifest, files: { 'resources/apps.json': JSON.stringify({ schemaVersion: 1,
            apps: [{ itemId: 'setup-app', app: { schemaVersion: 1, title: 'Setup catalog app',
                compose: { document, profiles: [], services: ['app'] }, variables: [], generatedSecrets: [], domains: [], volumes: [] } }] }) } }],
        runtimeOptions: { pluginIds: ['happier.scm.backend.git', pluginId] } })
        : await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
    cleanups.push(async function disposeNativeSetupPluginFixture() { await mounted.dispose(); });
    const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Setup app', retainPreviousDeployments: 1,
        definition: { kind: 'stored', document, contentRevision: 1,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] },
        bindings: [], ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true } });
    const project = await (catalog ? server.createDeploymentProjectSource() : server.createDeploymentProject());
    nativeBoundary.credentials = credentials;
    nativeBoundary.identity = { version: 1, createdAt: 1, installationId: machine.installationId,
        publicKey: Buffer.from(machine.keys.publicKey).toString('base64url'), privateKey: Buffer.from(machine.keys.secretKey).toString('base64url') };
    // Pre-seeding runs at the enrolled host before its RPC front doors start.
    // Retain the same authenticated local-root custody as controlServer; the
    // real physical requester owner decides identity without inventing a role.
    const preparationLifetime = new AbortController();
    cleanups.push(async () => { preparationLifetime.abort(); });
    const preparationContext: RpcActionExecutorContext = {
        authority: 'present_user', actionCaller: { kind: 'host' }, signal: preparationLifetime.signal,
        authenticatedLocalRootCustody: { serverIdentityId: server.homeId, accountId: server.accountId,
            machineId: machine.id, installationId: machine.installationId },
    };
    const createDependencies = (preparationMachine: Machine) => {
        const filesystemAdmission = createFilesystemEffectAdmission({
            resolveHomeServerIdentityId: async () => server.homeId,
            resolveHostIdentity: async () => ({ custodianAccountId: server.accountId,
                machineId: preparationMachine.id, installationId: preparationMachine.installationId }),
        });
        const resolveRequesterIdentity = async (context: ActionExecutorContext) => {
            const requester = await filesystemAdmission.resolveActionRequester!(context);
            try { return requester.identity; } finally { await requester.dispose(); }
        };
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: server.homeId,
            serverHttpBaseUrl: server.baseUrl, machineId: preparationMachine.id,
            resolveRequesterIdentity,
            acquirePluginRuntimeRegistryLease: () => mounted.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => mounted.registry }) });
        return createDaemonDeploymentActionDeps({ credentials, serverId: server.homeId,
            serverHttpBaseUrl: server.baseUrl, machineId: preparationMachine.id, runtime, resolveRequesterIdentity });
    };
    const dependencies = createDependencies(machine);
    if (catalog) {
        const registry = createCliRegistryHostV1({ credentials });
        const selected = await runWithServerHttpBaseUrl(server.baseUrl, async () =>
            REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
                sourceId: `${pluginId}/apps`, kind: 'app', itemId: 'setup-app' })).item);
        if (selected.payload.kind !== 'app' || selected.payload.state !== 'ready' || !selected.summary.version)
            throw new Error('admitted_setup_catalog_app_required');
        const templateRef = { sourceId: `${pluginId}/apps`, itemId: 'setup-app',
            version: selected.summary.version, ref: selected.payload.ref };
        const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId: server.homeId,
            machineId: machine.id, projectSourceId: project.projectSourceId, templateRef,
            environment: { kind: 'create', name: 'Setup catalog app', requestKey: randomUUID(), protection: 'nonProduction',
                purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id },
            target: { kind: 'new', installationId: machine.installationId }, destination: { kind: 'stored' }, bindings: [],
            deploy: { requestKey: randomUUID() } });
        const child: MachineSetupAppChildV1 = { sourceIndex: 0, itemIndex: 0,
            actionId: 'deployments.templates.instantiate', input };
        const item: MachinePresetItemV1 = { kind: 'app', definition: { name: input.environment.kind === 'create'
            ? input.environment.name : 'Setup catalog app', project: { kind: 'existing', projectSourceId: project.projectSourceId },
            definition: { from: 'catalogApp', templateRef }, bindings: [] } };
        return { child, item, dependencies, createDependencies, docker, projectSourceId: project.projectSourceId,
            environmentId: undefined, definition: undefined };
    }
    const artifact = await server.createDeploymentArtifact({
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name }, body: JSON.stringify(content) });
    const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
    const response = await fetch(`${server.baseUrl}/v1/deployments/environments`, { method: 'POST', headers,
        body: JSON.stringify({ serverId: server.homeId, projectSourceId: project.projectSourceId, requestKey: randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
            buildMachineId: machine.id, ...artifact }) });
    expect(response.status).toBe(200);
    const environment = DeploymentEnvironmentCreateResultV1Schema.parse(await response.json());
    if (!environment.ok) throw new Error(environment.error);
    // Candidate preparation opens the real Artifact body envelope, not the
    // older projection-only runtime reference from createDeploymentProject.
    const runtimeContent = await server.createDeploymentArtifact({
        header: { kind: 'deployment-target-link.v1', title: 'Setup runtime' }, body: JSON.stringify({}) });
    const linkedResponse = await fetch(`${server.baseUrl}/v1/deployments/environments/${environment.environmentId}/targets`, {
        method: 'POST', headers, body: JSON.stringify({ serverId: server.homeId, environmentId: environment.environmentId,
            expectedRevision: environment.revision, requestKey: randomUUID(), targetId: 'own-server', role: 'runtime',
            machines: [{ machineId: machine.id, installationId: machine.installationId }], ...runtimeContent }) });
    expect(linkedResponse.status).toBe(200);
    const linked = DeploymentActionOutputSchemasV1['deployments.targets.link'].parse(await linkedResponse.json());
    if (!linked.ok) throw new Error(linked.error);
    const nativeInput = { serverId: server.homeId, environmentId: environment.environmentId,
        targetLinkId: linked.targetLinkId };
    const target = { kind: 'machine' as const, machineId: machine.id };
    flow?.setPhase('native-review');
    // Real Home admission owns candidate identity and its Environment audience.
    // A bare local context cannot stand in for the installed signed preparation.
    const minted = await prepareExternalActionRequesterAccountAuthorizationWithEnvelope({
        actionId: 'deployments.deploy', input: nativeInput, requestId: randomUUID(), target,
        machineId: machine.id, accountId: server.accountId, accountEncryptionMode: credentials.encryption ? 'e2ee' : 'plain',
        tokenEpochHint: server.tokenEpoch, token: server.token,
        ...(credentials.encryption?.type === 'dataKey' ? { material: credentials.encryption } : {}),
        serverId: server.homeId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
        installationId: machine.installationId, privateKey: machine.keys.secretKey });
    if (!minted) throw new Error('native_candidate_home_admission_unavailable');
    const isCurrent = () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: minted.authorization,
        effectActionId: 'deployments.deploy', target, privateKey: machine.keys.secretKey,
        installationId: machine.installationId, serverHttpBaseUrl: server.baseUrl });
    const requester = await admitRequesterAccountActionContext({ authorization: minted.authorization, credentials,
        serverId: server.homeId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
        isCurrent, isCustodyCurrent: async () => !preparationLifetime.signal.aborted, signal: preparationLifetime.signal });
    if (!requester) throw new Error('native_candidate_requester_custody_unavailable');
    cleanups.push(async () => { await requester.dispose(); });
    // Match installed ingress: admit the root once; retained custody checks its
    // actual local lifetime rather than calling the remote verifier per read.
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
        serverId: server.homeId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl, target,
        installationId: machine.installationId, privateKey: machine.keys.secretKey, isCurrent: requester.isCurrent });
    if (!authorization) throw new Error('native_candidate_http_custody_unavailable');
    const nativeContext = { ...preparationContext, externalActionExecutionAuthorization: authorization,
        originalActionEnvelope: minted.envelope };
    const preparationReads: Array<{ method: string; path: string; status: number; contentArtifactId?: string }> = [];
    const http = axios.request.bind(axios);
    const preparationHttp = vi.spyOn(axios, 'request').mockImplementation(async options => {
        const response = await http(options);
        const body: unknown = options.data;
        const materialization: unknown = body && typeof body === 'object' ? Reflect.get(body, 'materialization') : undefined;
        const contentArtifactId: unknown = materialization && typeof materialization === 'object'
            ? Reflect.get(materialization, 'contentArtifactId') : undefined;
        preparationReads.push({ method: options.method ?? 'GET', path: new URL(options.url!).pathname, status: response.status,
            ...(typeof contentArtifactId === 'string' ? { contentArtifactId } : {}) });
        return response;
    });
    let prepared: Awaited<ReturnType<typeof dependencies.prepareDeploymentAction>>;
    try {
        prepared = await runWithServerHttpBaseUrl(server.baseUrl, () => dependencies.prepareDeploymentAction({
            actionId: 'deployments.deploy', input: nativeInput, context: nativeContext }));
    } finally { preparationHttp.mockRestore(); }
    flow?.assertCandidatePublication();
    if ('errorCode' in prepared) throw new Error(`native_app_preparation_${prepared.errorCode}_${JSON.stringify({
        preparationReads, docker: await docker.readInvocations() })}`);
    if (!('input' in prepared)) throw new Error('native_app_preparation_not_prepared');
    const secretAdmissions = preparationReads.filter(read => read.path.endsWith('/secret-launch-admission'));
    expect(secretAdmissions.length).toBeGreaterThan(0);
    // P42 admission and final review must select the same real receipt, not a
    // throwaway Artifact that merely makes the admission check pass.
    expect(new Set(secretAdmissions.map(read => read.contentArtifactId))).toEqual(new Set([prepared.input.contentArtifactId]));
    expect(await docker.readInvocations()).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ args: expect.arrayContaining(['up']) }),
    ]));
    const child: MachineSetupAppChildV1 = { sourceIndex: 0, itemIndex: 0, actionId: 'deployments.deploy', input: prepared.input };
    const item: MachinePresetItemV1 = { kind: 'app', authoredKey: randomUUID(), definition: { name: content.name,
        project: { kind: 'existing', projectSourceId: project.projectSourceId },
        definition: { from: 'compose', document, profiles: [], services: ['app'] }, bindings: [] } };
    if (content.definition.kind !== 'stored') throw new Error('native_app_stored_definition_required');
    return { child, item, dependencies, createDependencies, docker, environmentId: environment.environmentId,
        projectSourceId: project.projectSourceId, definition: content.definition };
}

async function createPersistedPublishEnvironment(server: ServerBoundary, roles: Readonly<{
    builder: Machine; controller: Machine; runtime: Machine | readonly Machine[];
}>) {
    const { builder, controller, runtime } = roles;
    const runtimes = Array.isArray(runtime) ? runtime : [runtime as Machine];
    const project = await server.createDeploymentProject();
    expect(project.audience).toEqual([]);
    const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
    const createdResponse = await fetch(`${server.baseUrl}/v1/deployments/environments`, {
        method: 'POST', headers, body: JSON.stringify({ serverId: server.homeId, projectSourceId: project.projectSourceId,
            requestKey: randomUUID(), protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: controller.id, buildMachineId: builder.id, ...project.environmentContent }),
    });
    expect(createdResponse.status).toBe(200);
    const created = DeploymentEnvironmentCreateResultV1Schema.parse(await createdResponse.json());
    if (!created.ok) throw new Error(created.error);
    const environmentUrl = `${server.baseUrl}/v1/deployments/environments/${created.environmentId}`;
    const linkedResponse = await fetch(`${environmentUrl}/targets`, { method: 'POST', headers,
        body: JSON.stringify({ serverId: server.homeId, environmentId: created.environmentId, expectedRevision: created.revision,
            requestKey: randomUUID(), targetId: 'own-server', role: 'runtime',
            machines: runtimes.map(machine => ({ machineId: machine.id, installationId: machine.installationId })), ...project.runtimeContent }),
    });
    expect(linkedResponse.status).toBe(200);
    const linked = DeploymentActionOutputSchemasV1['deployments.targets.link'].parse(await linkedResponse.json());
    if (!linked.ok) throw new Error(linked.error);
    expect((await fetch(`${environmentUrl}?serverId=${server.homeId}`)).status).toBe(401);
    const readResponse = await fetch(`${environmentUrl}?serverId=${server.homeId}`, { headers });
    expect(readResponse.status).toBe(200);
    const read = DeploymentActionOutputSchemasV1['deployments.environments.get'].parse(await readResponse.json());
    if (!read.ok) throw new Error(read.error);
    expect(read.environment).toMatchObject({ id: created.environmentId, projectSourceId: project.projectSourceId,
        owner: { kind: 'account', accountId: server.accountId }, controllerMachineId: controller.id,
        buildMachineId: builder.id, runtimeTargetLinkId: linked.targetLinkId });
    expect(read.targetLinks).toMatchObject([{ id: linked.targetLinkId, machines: runtimes.map(machine => machine.id) }]);
    const listResponse = await fetch(`${server.baseUrl}/v1/deployments/environments?serverId=${server.homeId}&projectSourceId=${project.projectSourceId}`, { headers });
    expect(listResponse.status).toBe(200);
    const listed = DeploymentActionOutputSchemasV1['deployments.environments.list'].parse(await listResponse.json());
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.items).toEqual([read.environment]);
    return listed.items;
}

describe('explicit present-user Workflow parent approval replay', () => {
    it.each(['exact', 'causal_ceiling'] as const)('creates the Action-only Run only within the retained host and permission ceiling (%s)', async control => {
        const server = await startServer();
        cleanups.push(server.close);
        const [host, decidingDevice] = server.machines;
        if (!host || !decidingDevice) throw new Error('two_enrolled_machines_required');
        const runId = randomUUID();
        const requestId = randomUUID();
        const target = { kind: 'machine' as const, machineId: host.id,
            project: { machineId: host.id, directory: '/workflow-project' } };
        const child = ProjectSourcesCreateInputV1Schema.parse({ serverId: server.homeId,
            requestKey: randomUUID(), name: 'standing-approval-source', audience: [], repository: {
                provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'happier-dev/happier' }, protocol: 'https',
            } });
        const input = WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition: {
            version: 1, defaults: { permissionMode: control === 'causal_ceiling' ? 'acceptEdits' : 'default' },
            inputs: [], blocks: [0, 1].map(index => ({ kind: 'action', id: `source-${index}`,
                actionId: 'projects.sources.create', input: Object.fromEntries(Object.entries(child).map(([key, value]) =>
                    [key, { kind: 'literal', value }])) })),
        } } });
        const storage = createWorkflowRunStorageClient({ token: server.token, machineId: host.id, serverHttpBaseUrl: server.baseUrl,
            createPublisherHeader: async ({ path, body }) => server.publisherHeader({ machineId: host.id, path, body }) });
        const credentials = { token: server.token, encryption: null };
        const approvals = createCliApprovalsArtifactStore({ credentials, serverId: 'test-profile',
            serverHttpBaseUrl: server.baseUrl, getAccountEncryptionMode: async () => 'plain' });
        const approvalsGet: typeof approvals.approvalsGet = args => runWithServerHttpBaseUrl(server.baseUrl,
            () => approvals.approvalsGet(args));
        const unusedDefinitionBoundary = (): never => { throw new Error('inline_definition_requires_no_artifact'); };
        const definitions = createWorkflowDefinitionActions({ artifactStore: {
            read: unusedDefinitionBoundary, list: unusedDefinitionBoundary, create: unusedDefinitionBoundary,
            update: unusedDefinitionBoundary, delete: unusedDefinitionBoundary,
        }, encodeListCursor: unusedDefinitionBoundary, assertDefinitionWriteAllowed: unusedDefinitionBoundary });
        const owner = createWorkflowRunActionOwner({ storage: { ...storage,
            // The real HTTP boundary validates the owner's opaque operation.
            execute: (operation, options) => storage.execute(operation as Parameters<typeof storage.execute>[0], options),
        }, resolveAccountId: async () => server.accountId,
            definitions,
            resolveEncryption: async () => {
                const encryption = await runWithServerHttpBaseUrl(server.baseUrl,
                    () => resolveAutomationWorkerAccountEncryption({ token: server.token }));
                if (encryption.kind !== 'available') throw new Error('account_encryption_unavailable');
                return encryption;
            },
            // Filesystem/readiness are the OS boundary, not Workflow admission.
            prepareWorkspace: async ({ projectTarget }) => ({ ok: true,
                workspaceTarget: { project: { ...projectTarget, checkoutRootPath: projectTarget.directory } } }),
            resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
                readActionContract: async actionId => {
                    if (actionId !== 'projects.sources.create') throw new Error('unexpected_source_child');
                    return freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(actionId)));
                } } }),
        });
        const originCurrentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: server.accountId,
            machineId: host.id, serverId: 'test-profile',
            resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: host.id, serverIdentityId: server.homeId }),
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: server.baseUrl }),
            resolveCurrentPermissionMode: async () => control === 'causal_ceiling' ? 'yolo' : 'default',
            isAccountCurrent: async () => (await fetch(`${server.baseUrl}/v1/account/encryption`, {
                headers: { Authorization: `Bearer ${server.token}` } })).ok,
            listAccountApiTokens: async () => { throw new Error('unsigned_person_has_no_API_token'); },
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            approvalsCreate: args => runWithServerHttpBaseUrl(server.baseUrl, () => approvals.approvalsCreate(args)),
            approvalsGet,
            approvalsUpdate: args => runWithServerHttpBaseUrl(server.baseUrl, () => approvals.approvalsUpdate(args)),
            isApprovalExecutionOriginCurrent: originCurrentness,
            workflowAction: createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions, runs: owner }),
        }));
        const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: 'test-profile', serverIdentityId: server.homeId, runtimeAccountId: server.accountId,
            callerPermissionMode: control === 'causal_ceiling' ? 'yolo' : 'default',
            ...(control === 'causal_ceiling' ? { causalPermissionAuthority: {
                kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const,
            } } : {}), actionRequestId: requestId, externalActionTarget: target,
            defaultSessionMachineId: host.id };
        const created = await executor.execute('approval.request.create', { actionId: 'workflow.run.start', actionArgs: input,
            summary: 'Approve the exact two Source children', createdBy: { surface: 'cli' } }, context);
        expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
        if (!created.ok || !created.result || typeof created.result !== 'object'
            || !('artifactId' in created.result) || typeof created.result.artifactId !== 'string') throw new Error('parent_approval_missing');
        const artifactId = created.result.artifactId;
        expect(await approvalsGet({ artifactId })).toMatchObject({ status: 'open', actionArgs: input,
            executionOriginV1: { target, machineId: host.id, callerPermissionMode: context.callerPermissionMode } });
        const decision = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
            ...context, actionRequestId: randomUUID(), defaultSessionMachineId: decidingDevice.id,
            callerPermissionMode: control === 'causal_ceiling' ? 'yolo' : 'read-only',
            externalActionTarget: { kind: 'machine', machineId: decidingDevice.id,
                project: { machineId: decidingDevice.id, directory: '/different-project' } },
        });
        if (control === 'causal_ceiling') {
            expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true,
                result: { status: 'failed', execution: { ok: false, errorCode: 'run_access_denied' } } });
            await expect(storage.execute({ operation: 'get', runId })).rejects.toMatchObject({ response: { status: 404 } });
            return;
        }
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true,
            result: { status: 'executed', execution: { ok: true } } });
        const stored = await storage.execute({ operation: 'get', runId });
        if (!stored || typeof stored !== 'object' || !('acceptedEnvelope' in stored)) throw new Error('missing_stored_snapshot');
        const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(stored.acceptedEnvelope) });
        if (opened.kind !== 'available') throw new Error(`stored_snapshot_${opened.kind}`);
        expect(opened.content).toMatchObject({ machineId: host.id,
            authorization: { admittedPermissionCeiling: 'default' }, approvedOperation: {
            parent: { actionId: 'workflow.run.start', input }, approvedBy: { accountId: server.accountId },
            steps: [{ actionId: 'projects.sources.create', input: child }, { actionId: 'projects.sources.create', input: child }],
        } });
    });
});

function reviewedSetupSources(presetRevision = 1): NonNullable<DeploymentPublishInputV1['preparedChildren']['setup']>[number]['targets'][number]['sources'] {
    return [{ kind: 'accountPreset', presetId: 'reviewed-preset', presetRevision,
        setup: { scripts: [{ body: 'echo machine-setup', affects: 'none' }] } },
        { kind: 'direct', setup: {} }];
}

async function fixture(control: 'exact' | 'changed' | 'stricter' | 'reader_removed' | 'second_reply_lost'
    | 'retained_permission' | 'missing_permission' = 'exact',
    publishHostChoice?: PublishHostChoice, registeredPublish = false, registeredSetup = false, preparedApp = false,
    authoredSetup?: 'multi' | 'app_missing', deploymentAdmission?: 'owner' | 'non_deployer', catalogAccountMode?: 'plain' | 'e2ee', flow?: DeploymentFlowCostObserver) {
    nativeBoundary.installationScope ??= new AsyncLocalStorage();
    const mode = catalogAccountMode ?? 'plain';
    const catalog = catalogAccountMode !== undefined;
    const contentKeys = mode === 'e2ee' ? tweetnacl.box.keyPair() : null;
    const server = await startServer({ deploymentTeamOwned: deploymentAdmission !== undefined,
        ...(contentKeys ? { e2ee: { contentPublicKey: contentKeys.publicKey,
            encodeMachine: (key: Uint8Array, value: unknown) => encodeBase64(encryptWithDataKey(value, key)),
            decodeMachine: (key: Uint8Array, value: string): unknown => decryptWithDataKey(decodeBase64(value), key) } } : {}) });
    flow?.attach(server);
    if (flow) {
        nativeBoundary.costRead = kind => flow.recordDaemonRead(kind);
        cleanups.push(async () => { nativeBoundary.costRead = null; });
    }
    const credentials: StoredCredentials = { token: server.token, encryption: contentKeys
        ? { type: 'dataKey', publicKey: contentKeys.publicKey, machineKey: contentKeys.secretKey } : null };
    cleanups.push(server.close);
    const workflowDirectory = await mkdtemp(join(tmpdir(), 'happier-combined-workflow-project-'));
    cleanups.push(async function removeWorkflowProjectDirectory() { await removeTempDir(workflowDirectory); });
    const profileId = registeredPublish || registeredSetup ? server.homeId : 'test-profile';
    const nativeLaunchIndex = nativeBoundary.launches.length;
    const receivingDiagnostics: Array<Readonly<Record<string, string | boolean>>> = [];
    if (catalog) {
        const createReader = workflowApprovedOperationOwner.createWorkflowApprovedOperationReader;
        const readerObservation = vi.spyOn(workflowApprovedOperationOwner, 'createWorkflowApprovedOperationReader')
            .mockImplementation(params => {
                const read = createReader(params);
                return async request => {
                    const result = await read(request);
                    if (request.actionId === 'deployments.templates.instantiate') receivingDiagnostics.push({
                        boundary: 'catalog-reviewed-child-admission', phase: request.phase,
                        admitted: result !== null, continuation: result?.invokeReviewedChild !== undefined,
                        semanticInputPresent: request.semanticInput !== undefined,
                    });
                    return result;
                };
            });
        cleanups.push(async () => { readerObservation.mockRestore(); });
    }
    const readRuntimeDiagnostics: Array<() => Promise<Array<Readonly<Record<string, string | boolean>>>>> = [];
    if (registeredSetup) {
        if (catalog) {
            const roles = vi.spyOn(deploymentDefinitionAdmission, 'resolveDeploymentDefinitionRoleForHost');
            const reviews = vi.spyOn(externalActionAuthorization, 'isReviewedMachineSetupPlanChild');
            cleanups.push(async function restoreCatalogRoleObservations() { roles.mockRestore(); reviews.mockRestore(); });
            readRuntimeDiagnostics.push(async () => Promise.all(roles.mock.calls.map(async ([context, host], index) => {
                const observed = roles.mock.results[index];
                const role = observed?.type === 'return' ? await observed.value.catch(() => null) : null;
                const authorization = context.externalActionExecutionAuthorization;
                return { boundary: 'catalog-definition-role', admitted: role !== null,
                    requesterProjectionPresent: authorization?.requesterAccountProjection !== undefined,
                    targetMatches: authorization?.binding.machineId === host.machineId,
                    originalEnvelopePresent: context.originalActionEnvelope !== undefined };
            })));
            readRuntimeDiagnostics.push(async () => Promise.all(reviews.mock.calls.map(async ([request], index) => {
                const observed = reviews.mock.results[index];
                const reviewed = observed?.type === 'return' ? await observed.value.catch(() => false) : false;
                return { boundary: 'catalog-plan-child-review', reviewed,
                    requesterProjectionPresent: request.authorization.requesterAccountProjection !== undefined,
                    originalEnvelopePresent: request.envelope !== undefined };
            })));
        }
        // Passthrough observation only: retain the real association reader and
        // emit shape/current-root facts, never credentials or accepted content.
        const associations = vi.spyOn(setupAcceptedAppRuns, 'prepareMachineSetupAcceptedAppRuns');
        cleanups.push(async function restoreSetupAssociationObservation() { associations.mockRestore(); });
        readRuntimeDiagnostics.push(async () => Promise.all(associations.mock.calls.map(async ([request], index) => {
            const authorization = request.context.externalActionExecutionAuthorization;
            const observed = associations.mock.results[index];
            const result = observed?.type === 'return' ? await observed.value.catch(() => null) : null;
            return { boundary: 'setup-app-association',
                appChildrenPresent: Boolean(request.input.appChildren?.length),
                authorizationPresent: authorization !== undefined,
                requesterProjectionPresent: authorization?.requesterAccountProjection !== undefined,
                requesterExecutorPresent: authorization?.requesterAccountExecutor !== undefined,
                runOriginPresent: authorization?.binding.workflowActionOrigin?.runId !== undefined,
                actionMatches: authorization?.binding.actionId === 'machines.setup.apply',
                homeMatches: authorization?.binding.serverIdentityId === request.input.homeId,
                machineMatches: authorization?.binding.machineId === request.input.machineId,
                requesterMatches: Boolean(authorization?.requesterAccountProjection
                    && authorization.requesterAccountProjection.accountId === authorization.binding.accountId),
                factsReady: result !== null };
        })));
        // Observe the genuine HTTP boundary without replacing Run readers or
        // retaining headers, opaque envelopes, ids or private Action operands.
        const observeRunRead = (config: unknown, status: unknown, data: unknown) => {
            if (!config || typeof config !== 'object') return;
            const url: unknown = Reflect.get(config, 'url');
            if (url !== `${server.baseUrl}/v3/automations/runs/workflow-storage`) return;
            let body: unknown = Reflect.get(config, 'data');
            if (typeof body === 'string') {
                try { body = JSON.parse(body); } catch { return; }
            }
            if (!body || typeof body !== 'object' || Reflect.get(body, 'operation') !== 'get') return;
            receivingDiagnostics.push({ boundary: 'workflow-read-http',
                status: typeof status === 'number' ? String(status) : 'unavailable',
                acceptedEnvelopePresent: Boolean(data && typeof data === 'object'
                    && typeof Reflect.get(data, 'acceptedEnvelope') === 'string'),
                keyCensusPresent: Boolean(data && typeof data === 'object' && Reflect.get(data, 'keyCensus')), });
        };
        const observeCatalogRead = (config: unknown, status: unknown, data: unknown) => {
            if (!config || typeof config !== 'object') return;
            const method: unknown = Reflect.get(config, 'method');
            const rawUrl: unknown = Reflect.get(config, 'url');
            if (typeof rawUrl !== 'string') return;
            const url = new URL(rawUrl, server.baseUrl);
            if (url.origin !== new URL(server.baseUrl).origin) return;
            const readFamily = method !== 'get' && method !== 'GET' ? undefined
                : url.pathname.startsWith('/v1/projects/sources/') ? 'source'
                : /^\/v1\/projects\/[^/]+\/deployment-defaults$/u.test(url.pathname) ? 'defaults'
                : url.pathname.startsWith('/v1/artifacts/') ? 'artifact' : undefined;
            const family = readFamily ?? (url.pathname === '/v1/actions/deployments.templates.instantiate/execution-authorization'
                ? 'catalog-authorization' : url.pathname === '/v1/actions/deployments.templates.instantiate'
                    ? 'catalog-dispatch' : undefined);
            if (!family) return;
            const facts: Record<string, string | boolean> = { boundary: 'catalog-read-http', family,
                status: typeof status === 'number' ? String(status) : 'unavailable' };
            if (data && typeof data === 'object') for (const key of ['error', 'errorCode', 'code']) {
                const value: unknown = Reflect.get(data, key);
                if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(value)) facts[key] = value;
            }
            receivingDiagnostics.push(facts);
        };
        const responseObserver = axios.interceptors.response.use(response => {
            observeRunRead(response.config, response.status, response.data);
            observeCatalogRead(response.config, response.status, response.data);
            return response;
        }, (error: unknown) => {
            if (axios.isAxiosError(error)) {
                observeRunRead(error.config, error.response?.status, error.response?.data);
                observeCatalogRead(error.config, error.response?.status, error.response?.data);
            }
            return Promise.reject(error);
        });
        cleanups.push(async function removeRunReadHttpObservation() { axios.interceptors.response.eject(responseObserver); });
        // Observe the existing file-logging boundary without changing execution
        // or retaining payloads, credentials, arbitrary thrown values or prose.
        for (const method of ['warnLocalFile', 'infoFile'] as const) {
            const write = logger[method].bind(logger);
            const observation = vi.spyOn(logger, method).mockImplementation((message, ...args) => {
                write(message, ...args);
                if (message.startsWith('{')) {
                    let diagnostic: unknown;
                    try { diagnostic = JSON.parse(message); } catch { return; }
                    if (diagnostic && typeof diagnostic === 'object'
                        && 'event' in diagnostic && diagnostic.event === 'workflow_action_failure') {
                        const fields: Record<string, string | boolean> = { boundary: 'workflow_action_failure' };
                        for (const key of ['errorCode', 'originalCode', 'operation']) {
                            const field: unknown = Reflect.get(diagnostic, key);
                            if (typeof field === 'string') fields[key] = field;
                        }
                        receivingDiagnostics.push(fields);
                    }
                    return;
                }
                if (message !== '[external-action-phase]' && message !== '[RPC] Request completed') return;
                for (const value of args) {
                    if (!value || typeof value !== 'object') continue;
                    const fields: Record<string, string | boolean> = { boundary: message };
                    if (message === '[RPC] Request completed') fields.externalAction = Reflect.get(value, 'method') === EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1;
                    if (message === '[RPC] Request completed') {
                        // Identify only a canonical RPC method, never a request
                        // operand, Machine id, credential or opaque diagnostic.
                        const rawMethod: unknown = Reflect.get(value, 'method');
                        const method = typeof rawMethod === 'string' ? Object.values(RPC_METHODS)
                            .find(candidate => rawMethod === candidate || rawMethod.endsWith(`:${candidate}`)) : undefined;
                        if (method) fields.method = method;
                    }
                    for (const key of ['phase', 'refusalBranch', 'errorClass', 'outcomeCode', 'admissionPredicate', 'callerClass']) {
                        const field: unknown = Reflect.get(value, key);
                        if (typeof field === 'string') fields[key] = field;
                    }
                    receivingDiagnostics.push(fields);
                    if (message === '[external-action-phase]') {
                        // The canonical diagnostic owner already removes the
                        // Error message. Retain only repository source pointers.
                        const frames: unknown = Reflect.get(value, 'stackFrames');
                        for (const frame of Array.isArray(frames) ? frames : []) {
                            if (!frame || typeof frame !== 'object') continue;
                            const file: unknown = Reflect.get(frame, 'file');
                            const line: unknown = Reflect.get(frame, 'line');
                            const column: unknown = Reflect.get(frame, 'column');
                            const source = typeof file === 'string'
                                ? /((?:apps\/cli\/src|packages)\/[\w./@+-]+\.(?:[cm]?js|tsx?))$/u.exec(file.replaceAll('\\', '/'))?.[1] : undefined;
                            if (source && typeof line === 'number' && Number.isInteger(line)
                                && typeof column === 'number' && Number.isInteger(column)) receivingDiagnostics.push({
                                boundary: 'external-action-source', source: `${source}:${line}:${column}`,
                            });
                        }
                    }
                }
            });
            cleanups.push(async function restoreReceivingLogObservation() { observation.mockRestore(); });
        }
    }
    const readReceivingDiagnostics = async () => [...receivingDiagnostics,
        ...(await Promise.all(readRuntimeDiagnostics.map(read => read()))).flat()];
    // Native compositions use the same installed controller ingress as catalog Setup.
    // Manual admission remains only for the focused policy/replay controls.
    const installedParent = catalog || preparedApp && control === 'exact' && registeredSetup;
    let installedDirectory: string | undefined;
    if (registeredSetup || preparedApp || deploymentAdmission) {
        installedDirectory = await mkdtemp(join(tmpdir(), 'happier-combined-setup-installed-'));
        const directory = installedDirectory;
        cleanups.push(async function removeInstalledSetupDirectory() { await removeTempDir(directory); });
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL']);
        env.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_ACTIVE_SERVER_ID: profileId, HAPPIER_SERVER_URL: server.baseUrl });
        reloadConfiguration();
        cleanups.push(async function restoreInstalledSetupEnvironment() { env.restore(); reloadConfiguration(); });
        // The real native identity resolver consumes an enrolled Home, not
        // just environment URL hints. This writer touches only the fixture's
        // isolated installed settings; HTTP/storage/admission remain real.
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profileId, createIfMissing: true,
            observation: 'exact', descriptor: { v: 1, homeServerIdentityId: server.homeId,
                canonicalServerUrl: server.baseUrl, revision: 1, endpoints: [{ kind: 'https', url: server.baseUrl }] } });
    }
    if (installedParent) {
        // The installed host consumes actual Account policy, not the manual
        // executor's caller-supplied fixture context. Require one parent review.
        const policy = await runWithServerHttpBaseUrl(server.baseUrl, () => updateAccountSettingsV2OnceAgainstLatest({
            credentials, mutate: settings => ({ ...settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: { [registeredPublish ? 'deployments.publish' : 'machines.setup.apply']: { approvalRequiredSurfaces: ['cli'] } } }) }) }));
        expect(policy.status).toBe('applied');
    }
    // Real workspace preparation reads SCM through the daemon-applied runtime,
    // including Action-only parents with an ordinary directory.
    {
        const mounted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        cleanups.push(async function disposeWorkflowWorkspacePluginRuntime() { await mounted.dispose(); });
    }
    const [environmentController, personChoice, agentMachine] = server.machines;
    if (!environmentController || !personChoice || !agentMachine) throw new Error('three_enrolled_machines_required');
    const environments = publishHostChoice === undefined || publishHostChoice === 'person' ? [] : await createPersistedPublishEnvironment(server, {
        controller: environmentController, builder: personChoice, runtime: agentMachine,
    });
    if (publishHostChoice === 'person') {
        expect(resolveCombinedActionWorkflowHostV1({ actionId: 'deployments.publish', machines: await server.readMachines() }))
            .toMatchObject({ kind: 'selection_required', review: { machineId: null } });
    }
    const selection = resolveCombinedActionWorkflowHostV1({ actionId: 'deployments.publish', machines: await server.readMachines(),
        projectEnvironmentControllerMachineIds: environments.map(environment => environment.controllerMachineId),
        ...(publishHostChoice === 'person' ? { selectedMachineId: personChoice.id } : {}),
        ...(publishHostChoice === 'agent' ? { agentMachineId: agentMachine.id } : {}),
        ...(publishHostChoice === undefined ? { selectedMachineId: environmentController.id } : {}),
    });
    if (selection.kind !== 'ready') throw new Error(`publish_host_${selection.kind}`);
    const host = server.machines.find(machine => machine.id === selection.machineId);
    const others = server.machines.filter(machine => machine.id !== selection.machineId);
    const [first, second] = others;
    if (!host || !first || !second) throw new Error('existing_publish_host_required');
    if (registeredPublish || registeredSetup) {
        const previousMachineId = nativeBoundary.machineId;
        const previousIdentity = nativeBoundary.identity;
        nativeBoundary.machineId = host.id;
        nativeBoundary.identity = { version: 1, createdAt: 1, installationId: host.installationId,
            publicKey: Buffer.from(host.keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(host.keys.secretKey).toString('base64url') };
        cleanups.push(async () => { nativeBoundary.machineId = previousMachineId; nativeBoundary.identity = previousIdentity; });
    }
    let runId: string = randomUUID();
    const parentRequestId = randomUUID();
    const rootId = randomUUID();
    const steps: Array<{ actionId: 'machines.setup.apply'; input: MachineSetupApplyInputV1 }> = (deploymentAdmission ? [] : [first, second]).map(machine => ({ actionId: 'machines.setup.apply' as const,
        input: { homeId: server.homeId, machineId: machine.id, targets: [{ homeId: server.homeId, machineId: machine.id,
            desiredRevision: 0, recipePlans: [], exclusions: [], sources: reviewedSetupSources() }] } }));
    const setupInput: MachineSetupApplyInputV1 = { homeId: server.homeId, machineId: host.id,
        targets: steps.flatMap(step => step.input.targets) };
    if (authoredSetup === 'app_missing') {
        const target = setupInput.targets[0];
        const source = target?.sources[0];
        if (!target || !source) throw new Error('authored_app_source_required');
        const project = await server.createDeploymentProject();
        const item: MachinePresetItemV1 = { kind: 'app', authoredKey: randomUUID(), definition: { name: 'Authored app',
            project: { kind: 'existing', projectSourceId: project.projectSourceId },
            definition: { from: 'compose', document: 'services:\n  app:\n    image: nginx:alpine\n', profiles: [], services: ['app'] },
            bindings: [] } };
        target.sources = [{ ...source, setup: { ...source.setup, items: [item] } }, ...target.sources.slice(1)];
        setupInput.machineId = target.machineId;
        setupInput.targets = [target];
    }
    // Permission replay exercises the admitted Publish host, not cross-host
    // preparation. Its signed parent cannot stand in for target A admission.
    const permissionReplay = control === 'retained_permission' || control === 'missing_permission';
    const nativeMachine = deploymentAdmission || permissionReplay ? host : first;
    const nativeApp = preparedApp || deploymentAdmission || catalog ? await createNativeSetupApp(server, nativeMachine, catalog, credentials, flow) : undefined;
    if (nativeApp && (registeredPublish || registeredSetup)) {
        nativeBoundary.identity = { version: 1, createdAt: 1, installationId: host.installationId,
            publicKey: Buffer.from(host.keys.publicKey).toString('base64url'), privateKey: Buffer.from(host.keys.secretKey).toString('base64url') };
    }
    if (nativeApp && registeredSetup) {
        const target = setupInput.targets[0];
        const source = target?.sources[0];
        if (!target || !source) throw new Error('setup_app_source_required');
        target.sources = [{ ...source, setup: { ...source.setup, items: [nativeApp.item] } }, ...target.sources.slice(1)];
        target.appChildren = [nativeApp.child];
    }
    if (registeredSetup && !authoredSetup) runId = deriveWorkflowReplacementId(['machines.setup.apply', server.homeId, server.accountId, parentRequestId]);
    let publishFixture: Readonly<{ input: DeploymentPublishInputV1 }> | undefined;
    if (registeredPublish && nativeApp) {
        if (nativeApp.child.actionId !== 'deployments.deploy' || !nativeApp.environmentId || !nativeApp.definition)
            throw new Error('prepared_publish_deployment_required');
        publishFixture = { input: DeploymentPublishInputV1Schema.parse({ serverId: server.homeId,
            requestKey: randomUUID(), hostMachineId: host.id,
            project: { kind: 'existing', projectSourceId: nativeApp.projectSourceId, sourceRevision: 1 },
            definition: { kind: 'stored', contentRevision: nativeApp.definition.contentRevision,
                composeDigest: nativeApp.definition.composeDigest },
            destination: { kind: 'ownServer', controllerMachineId: nativeMachine.id, buildMachineId: nativeMachine.id,
                machines: [{ machineId: nativeMachine.id, installationId: nativeMachine.installationId }] },
            environment: { kind: 'existing', environmentId: nativeApp.environmentId,
                expectedRevision: nativeApp.child.input.expectedRevision },
            preparedChildren: { setup: steps.map(step => step.input), deploy: nativeApp.child.input } }) };
        runId = deriveWorkflowReplacementId(['deployments.publish', server.homeId, server.accountId, publishFixture.input.requestKey]);
    } else if (registeredPublish) {
        const [environment] = await createPersistedPublishEnvironment(server, { controller: host, builder: first, runtime: [first, second] });
        if (!environment?.runtimeTargetLinkId) throw new Error('persisted_publish_environment_required');
        const response = await fetch(`${server.baseUrl}/v1/deployments/environments/${environment.id}?serverId=${server.homeId}`,
            { headers: { Authorization: `Bearer ${server.token}` } });
        const loaded = DeploymentActionOutputSchemasV1['deployments.environments.get'].parse(await response.json());
        if (!loaded.ok) throw new Error(loaded.error);
        const runtime = loaded.targetLinks.find(link => link.id === environment.runtimeTargetLinkId);
        if (!runtime) throw new Error('persisted_runtime_required');
        const operands = { serverId: server.homeId, accountId: server.accountId, hostMachineId: host.id,
            controllerMachineId: environment.controllerMachineId, buildMachineId: environment.buildMachineId,
            projectSourceId: environment.projectSourceId, sourceRevision: 1,
            environmentId: environment.id, environmentRevision: environment.revision,
            targetLinkId: runtime.id, targetLinkRevision: runtime.revision,
            machines: [first, second].map(machine => ({ machineId: machine.id, installationId: machine.installationId })),
            setup: steps.map(step => step.input) };
        const candidate = createPreparedPublishTestFixture(operands);
        const artifact = await server.createDeploymentArtifact(candidate.artifact);
        publishFixture = createPreparedPublishTestFixture({ ...operands, artifactId: artifact.contentArtifactId,
            artifactHeaderVersion: artifact.contentHeaderVersion, artifactBodyVersion: artifact.contentBodyVersion });
        runId = deriveWorkflowReplacementId(['deployments.publish', server.homeId, server.accountId, publishFixture.input.requestKey]);
    }
    const definition: WorkflowDefinitionV1 = authoredSetup ? { version: 1, defaults: {}, inputs: [], blocks: [{
        kind: 'action', id: 'authored-setup', actionId: 'machines.setup.apply',
        input: Object.fromEntries(Object.entries(setupInput).map(([key, value]) => [key,
            { kind: 'literal' as const, value: projectNativeJsonValueForTransport(value) }])),
    }] } : registeredSetup ? buildMachineSetupWorkflow(setupInput) : publishFixture ? buildPublishWorkflow(publishFixture.input)
      : { version: 1, inputs: [], defaults: {}, blocks: steps.map((step, index) => ({
        kind: 'action', id: `setup-${index}`, actionId: step.actionId,
        input: Object.fromEntries(Object.entries(step.input).map(([key, value]) => [key, { kind: 'literal' as const, value }])),
    })) };
    const storage = createWorkflowRunStorageClient({ token: server.token, machineId: host.id, serverHttpBaseUrl: server.baseUrl,
        createPublisherHeader: async ({ path, body }) => server.publisherHeader({ machineId: host.id, path, body }) });
    if (authoredSetup) {
        const previousCredentials = nativeBoundary.credentials;
        nativeBoundary.credentials = credentials;
        cleanups.push(async function restoreAuthoredHostCredentials() { nativeBoundary.credentials = previousCredentials; });
    }
    const readRunEncryption = async (selectedRunId = runId) => {
        const stored = await storage.execute({ operation: 'get', runId: selectedRunId });
        if (!stored || typeof stored !== 'object' || !('acceptedEnvelope' in stored) || !('keyCensus' in stored))
            throw new Error('missing_stored_snapshot');
        // Storage returns opaque content, not workflow.run.get's decoded DTO.
        // Use the same field codecs as the production coordinator reader.
        const acceptedEnvelope = parseWorkflowStoredContentEnvelopeV1(stored.acceptedEnvelope);
        const census = WorkflowRunRecipientCensusResponseV1Schema.parse(stored.keyCensus);
        const accountEncryption = await runWithServerHttpBaseUrl(server.baseUrl,
            () => resolveAutomationWorkerAccountEncryption({ token: server.token, credentials }));
        if (accountEncryption.kind !== 'available') throw new Error('account_encryption_unavailable');
        const resolved = resolveWorkflowRunDataKeyV1({ encryption: accountEncryption, census });
        if (resolved.kind !== 'available') throw new Error('workflow_run_key_unavailable');
        return { acceptedEnvelope, encryption: resolved.encryption };
    };
    const readStoredSnapshot = async (selectedRunId = runId) => {
        const { acceptedEnvelope, encryption } = await readRunEncryption(selectedRunId);
        const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...encryption.runCrypto,
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId: selectedRunId },
            envelope: acceptedEnvelope });
        if (opened.kind !== 'available') throw new Error(`stored_snapshot_${opened.kind}`);
        expect(acceptedEnvelope).toMatchObject({ t: mode === 'e2ee' ? 'encrypted' : 'plain' });
        return opened.content;
    };
    const approvals = createCliApprovalsArtifactStore({ credentials, serverId: profileId,
        serverHttpBaseUrl: server.baseUrl, getAccountEncryptionMode: async () => mode });
    const parentPrompts: unknown[] = [];
    const approvalsCreate: typeof approvals.approvalsCreate = args => runWithServerHttpBaseUrl(server.baseUrl,
        () => approvals.approvalsCreate(args));
    const approvalsGet: typeof approvals.approvalsGet = args => runWithServerHttpBaseUrl(server.baseUrl,
        () => approvals.approvalsGet(args));
    const approvalsUpdate: typeof approvals.approvalsUpdate = args => runWithServerHttpBaseUrl(server.baseUrl,
        () => approvals.approvalsUpdate(args));
    let lastPublishRunRequest: Readonly<{ method: string; path: string; operation: unknown; runId: unknown;
        httpStatus?: number; httpFailure?: string }> | undefined;
    let parentWorkflowFailure: Readonly<{ code: string | null; name: string;
        firstFrame?: string;
        schemaIssues: Array<{ code: string; path: Array<string | number> }> }> | undefined;
    const recordParentWorkflowFailure = (error: unknown) => {
        const issues = error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues) ? error.issues : [];
        const workflowCode = WorkflowOperationErrorCodeV1Schema.safeParse(error && typeof error === 'object' && 'code' in error ? error.code : undefined);
        const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replaceAll('\\', '/');
        const firstFrame = (error instanceof Error ? error.stack?.split('\n').slice(1) ?? [] : []).flatMap(line => {
            if (!/^\s+at /.test(line)) return [];
            const normalized = line.replaceAll('\\', '/');
            const rootAt = normalized.indexOf(repoRoot);
            if (rootAt < 0) return [];
            const match = normalized.slice(rootAt + repoRoot.length).match(/^([A-Za-z0-9_@./-]+\.(?:[cm]?js|tsx?)):(\d+):\d+\)?$/);
            return match ? [`${match[1]}:${match[2]}`] : [];
        })[0];
        parentWorkflowFailure = { code: workflowCode.success ? workflowCode.data : readRpcErrorCode(error) ?? null,
            name: error instanceof Error ? error.name : typeof error, ...(firstFrame ? { firstFrame } : {}),
            schemaIssues: issues.flatMap((issue: unknown) => issue && typeof issue === 'object'
                && 'code' in issue && typeof issue.code === 'string' && 'path' in issue && Array.isArray(issue.path)
                ? [{ code: issue.code, path: issue.path.filter((part: unknown): part is string | number => typeof part === 'string' || typeof part === 'number') }] : []) };
    };
    const createOwner = (context?: ActionExecutorContext, setupParentInput = setupInput) => {
        const ownerStorage = context && (publishFixture || registeredSetup) ? createCliWorkflowRunStorage(
            { token: server.token, serverHttpBaseUrl: server.baseUrl },
            async key => key === 'machineId' ? host.id : null,
            (requestContext, effectActionId, request) => {
                const resolved = resolveExternalActionServerRequestHeaders({ context: requestContext,
                    effectActionId, ...request, daemonToken: server.token, serverIdentityId: server.homeId,
                    privateKey: host.keys.secretKey, installationId: host.installationId });
                return resolved.ok ? resolved.headers : null;
            }, value => typeof value === 'string' && value.trim() ? value.trim() : null,
        ).createWorkflowRunStorage({ parent: registeredSetup
            ? { actionId: 'machines.setup.apply', input: setupParentInput }
            : { actionId: 'deployments.publish', input: publishFixture!.input }, context })
        : context ? createWorkflowRunStorageClient({ token: server.token,
            machineId: host.id, serverHttpBaseUrl: server.baseUrl,
            createPublisherHeader: async ({ path, body }) => server.publisherHeader({ machineId: host.id, path, body }),
            resolveAuthorizationHeaders: request => {
                const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
                lastPublishRunRequest = { method: request.method, path: request.path, operation: body.operation, runId: body.runId };
                const resolved = resolveExternalActionServerRequestHeaders({ context,
                    effectActionId: registeredSetup ? 'machines.setup.apply' : 'deployments.publish', method: request.method, path: request.path, body: request.body,
                    daemonToken: server.token, serverIdentityId: server.homeId,
                    privateKey: host.keys.secretKey, installationId: host.installationId });
                return resolved.ok ? resolved.headers : null;
            } }) : storage;
        return createWorkflowRunActionOwner({ storage: { ...ownerStorage,
        // The shared owner carries opaque storage operands; the real HTTP
        // transport/server validates their operation-specific schemas.
        // Publish uses the production caller-bound factory's retained requester
        // Run authority and default installed publisher signer.
        execute: async (operation, options) => {
            if (context && (publishFixture || registeredSetup)) lastPublishRunRequest = { method: 'POST',
                path: '/v3/automations/runs/workflow-storage', operation: operation.operation, runId: operation.runId };
            try {
                return await ownerStorage.execute(operation as Parameters<typeof storage.execute>[0],
                    { ...options, ...(context?.externalActionExecutionAuthorization ? { publisherMachineId: host.id } : {}) });
            } catch (error) {
                const httpStatus = readHttpStatus(error);
                const response = error && typeof error === 'object' && 'response' in error ? error.response : undefined;
                const payload = response && typeof response === 'object' && 'data' in response ? response.data : undefined;
                const refusal = ExternalActionHttpErrorSchema.safeParse(payload);
                const httpFailure = refusal.success ? 'code' in refusal.data ? refusal.data.code : refusal.data.error
                    : payload === null ? 'empty_response' : undefined;
                if (context && lastPublishRunRequest && httpStatus !== null) lastPublishRunRequest = { ...lastPublishRunRequest, httpStatus,
                    ...(httpFailure ? { httpFailure } : {}) };
                throw error;
            }
        },
    }, resolveAccountId: async () => server.accountId,
        definitions: { get: async () => { throw new Error('inline_parent_does_not_read_saved_definition'); } },
        resolveEncryption: async () => {
            const encryption = await runWithServerHttpBaseUrl(server.baseUrl,
                () => resolveAutomationWorkerAccountEncryption({ token: server.token, credentials }));
            if (encryption.kind !== 'available') throw new Error('account_encryption_unavailable');
            return encryption;
        },
        prepareWorkspace: ({ projectTarget, definition }) => prepareWorkflowAcceptedWorkspaceTarget({ projectTarget, definition }),
        observeRecovery: ({ run, progress, signal }) => observeWorkflowInvocationRecoveryEvidence({ runId: run.id, credentials,
            machineId: run.machineId, progress,
            getOperation: operation => callExactMachineRpc({ credentials, machineId: operation.machineId,
                serverUrl: server.baseUrl, method: ACTION_OPERATION_RPC_METHODS_V2.get,
                request: { operationId: operation.operationId }, authorityCeiling: 'account_automation',
                ...(signal ? { signal } : {}) }),
            getRun: async () => { throw new Error('setup_has_no_agent_run'); },
            ...(signal ? { signal } : {}) }),
        resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
            readActionContract: async actionId => {
                if (actionId !== 'machines.setup.apply' && actionId !== 'deployments.deploy'
                    && actionId !== 'deployments.templates.instantiate') throw new Error('unexpected_child_action');
                return freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(actionId)));
            } } }),
        });
    };
    const owner = createOwner();
    const startInput = WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition }, executionTarget: { kind: 'session' } });
    const input = registeredSetup && !authoredSetup ? setupInput : publishFixture?.input ?? startInput;
    const parentActionId = registeredSetup && !authoredSetup ? 'machines.setup.apply' as const : publishFixture ? 'deployments.publish' as const : 'workflow.run.start' as const;
    const parentTarget = { kind: 'machine' as const, machineId: host.id,
        ...(publishFixture || registeredSetup && !authoredSetup ? {} : { project: { machineId: host.id, directory: workflowDirectory } }) };
    const verifyParentAuthorization = (authorization: ExternalActionExecutionAuthorizationV1) => verifyExternalActionExecutionAuthorizationCurrent({
        authorization, effectActionId: parentActionId, target: parentTarget, privateKey: host.keys.secretKey,
        installationId: host.installationId, serverHttpBaseUrl: server.baseUrl });
    const observation = acquireRequesterAccountEncryptionCurrentness({ accountId: server.accountId,
        token: server.token, serverBaseUrl: server.baseUrl });
    cleanups.push(async function disposeRequesterObservation() { await observation.dispose(); });
    await observation.read();
    const parentLifetime = new AbortController();
    cleanups.push(async () => { parentLifetime.abort(); });
    const projectParentAuthorization = async (authorization: ExternalActionExecutionAuthorizationV1) => {
        if (registeredPublish || registeredSetup) {
            const requester = await admitRequesterAccountActionContext({ authorization, credentials,
                serverId: profileId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
                isCurrent: () => verifyParentAuthorization(authorization),
                isCustodyCurrent: async () => !parentLifetime.signal.aborted, signal: parentLifetime.signal });
            if (!requester) return null;
            cleanups.push(async function disposeRequesterCustody() { await requester.dispose(); });
            // Match installed ingress: strict Account admission precedes the
            // private HTTP projection, which preserves retained requester ports.
            return projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
                serverId: profileId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
                target: parentTarget, installationId: host.installationId, privateKey: host.keys.secretKey,
                isCurrent: requester.isCurrent });
        }
        const signed = await projectExternalActionRequesterHttpAuthorization({ authorization,
            serverId: profileId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
            target: parentTarget, installationId: host.installationId, privateKey: host.keys.secretKey,
            isCurrent: () => verifyParentAuthorization(authorization) });
        if (!signed) return null;
        return projectRequesterAccountActionAuthorization({
        authorization: signed, serverIdentityId: server.homeId, bootstrap: { credentials, serverHttpBaseUrl: server.baseUrl,
            attribution: { accountId: server.accountId, serverId: profileId, machineId: host.id, installationId: host.installationId },
            isCurrent: () => verifyParentAuthorization(authorization) } });
    };
    const minted = installedParent ? null : await prepareExternalActionRequesterAccountAuthorizationWithEnvelope({ actionId: parentActionId, input,
        requestId: parentRequestId, target: parentTarget, machineId: host.id, accountId: server.accountId,
        accountEncryptionMode: mode, tokenEpochHint: server.tokenEpoch, token: server.token,
        ...(credentials.encryption?.type === 'dataKey' ? { material: credentials.encryption } : {}),
        serverId: profileId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
        installationId: host.installationId, privateKey: host.keys.secretKey });
    const parentAuthorization = minted ? await projectParentAuthorization(minted.authorization) : null;
    if (!installedParent && (!minted || !parentAuthorization)) throw new Error(`parent_account_admission_unavailable_${minted ? 'requester_projection' : 'mint'}`);
    const originCurrentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: server.accountId,
        machineId: host.id, serverId: profileId,
        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: host.id, serverIdentityId: server.homeId }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: server.baseUrl }),
        // The original local host's deliberate permission choice is an
        // environment operand; the real currentness owner compares it.
        resolveCurrentPermissionMode: async () => 'default',
        externalActionMachinePublicKey: host.keys.publicKey,
        verifyExternalExecutionAuthorization: ({ authorization }) => verifyParentAuthorization(authorization),
        isAccountCurrent: async () => (await fetch(`${server.baseUrl}/v1/account/encryption`, {
            headers: { Authorization: `Bearer ${server.token}` } })).ok,
        listAccountApiTokens: async () => { throw new Error('Account_origin_has_no_API_token'); },
    });
    // This Action-only host has no Session content. Account encryption is
    // established independently by Home currentness and the keyed credentials.
    const publishReadDeps = createCliActionDeps({ token: server.token, credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId: profileId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
        externalActionMachineInstallationId: host.installationId, externalActionMachineRequestPrivateKey: host.keys.secretKey });
    let deploymentPreparationCalls = 0;
    let replayedPublishPermissionMode: ActionExecutorContext['callerPermissionMode'];
    const publishDeps = createPublishProjectActionDeps({
        ...(nativeApp ? { prepareDeploymentAction: async request => {
            deploymentPreparationCalls++;
            const preparationMachine = preparedApp ? host : nativeMachine;
            const preparationDependencies = preparationMachine === nativeMachine ? nativeApp.dependencies
                : nativeApp.createDependencies(preparationMachine);
            const scope = nativeBoundary.installationScope;
            if (!scope) throw new Error('native_preparation_installation_scope_required');
            // These daemons share a process, not installed identity files.
            // Preparation runs as the real Publish host; production target
            // review routes each native render through its receiving daemon.
            const prepared = await scope.run({ machineId: preparationMachine.id, credentials, identity: { version: 1, createdAt: 1,
                installationId: preparationMachine.installationId,
                publicKey: Buffer.from(preparationMachine.keys.publicKey).toString('base64url'),
                privateKey: Buffer.from(preparationMachine.keys.secretKey).toString('base64url') } },
                () => preparationDependencies.prepareDeploymentAction(request));
            if ('errorCode' in prepared) {
                const ingress = request.context as RpcActionExecutorContext;
                receivingDiagnostics.push({ boundary: 'publish-native-preparation', errorCode: prepared.errorCode,
                    bindingMachineMatches: request.context.externalActionExecutionAuthorization?.binding.machineId === preparationMachine.id,
                    signedRole: request.context.externalActionExecutionAuthorization?.binding.admittedMachineRole ?? 'absent',
                    receivingMachineMatches: ingress.machineAdmission?.machineId === preparationMachine.id,
                    receivingInstallationMatches: ingress.machineAdmission?.installationId === preparationMachine.installationId,
                    receivingRole: ingress.machineAdmission?.role ?? 'absent',
                    verifierPresent: ingress.verifyMachineAdmissionCurrent !== undefined });
            }
            return prepared;
        } } : {}),
        orchestrationDirectory: workflowDirectory,
        readHostFacts: async () => ({ machines: await server.readMachines() }),
        startCombined: async request => {
            replayedPublishPermissionMode = request.context.callerPermissionMode;
            try { return await createOwner(request.context).startCombined(request); }
            catch (error) { recordParentWorkflowFailure(error); throw error; }
        },
        waitForRun: request => createOwner(request.context).execute({ actionId: 'workflow.run.wait',
            input: { runId: request.start.runId, conditions: ['terminal'] }, context: request.context }),
        readInvocations: (request, input) => createOwner(request.context).execute({ actionId: 'workflow.run.invocations.list',
            input, context: request.context }),
    });
    const setupArtifactReads: Array<{ artifactAvailable: boolean; documentAvailable: boolean }> = [];
    const setupDeps = createCombinedMachineSetupActionDeps({ readDeps: () => publishReadDeps,
        targetPlan: async request => {
            try { return await publishReadDeps.machineSetupPlan!(request); }
            catch (error) {
                const authorization = request.context.externalActionExecutionAuthorization;
                const code = readRpcErrorCode(error);
                // Diagnose the real network boundary without echoing request
                // operands, credentials, arbitrary exception prose or ids.
                throw new Error(JSON.stringify({ phase: 'setup_target_plan_transport', method: RPC_METHODS.MACHINE_SETUP_PLAN,
                    errorCode: code ?? 'unclassified',
                    authorizationPresent: authorization !== undefined,
                    accountProjectionPresent: authorization?.requesterAccountProjection !== undefined,
                    accountExecutorPresent: authorization?.requesterAccountExecutor !== undefined,
                    workflowOriginPresent: authorization?.binding.workflowActionOrigin !== undefined,
                    explicitMode: 'targets' in request.input ? false : request.input.mode !== undefined,
                    sourceCopiesPresent: 'targets' in request.input ? false : request.input.sources !== undefined,
                    receivingDiagnostics: receivingDiagnostics.filter(diagnostic => diagnostic.boundary === '[RPC] Request completed'
                        && diagnostic.method === RPC_METHODS.MACHINE_SETUP_PLAN),
                }));
            }
        }, orchestrationDirectory: workflowDirectory,
        readHostFacts: async () => ({ machines: await server.readMachines() }),
        startCombined: request => createOwner(request.context,
            request.parent.actionId === 'machines.setup.apply' ? request.parent.input : setupInput).startCombined(request),
        waitForRun: request => createOwner(request.context,
            request.parent.actionId === 'machines.setup.apply' ? request.parent.input : setupInput).execute({ actionId: 'workflow.run.wait',
            input: { runId: request.start.runId, conditions: ['terminal'] }, context: request.context }),
    });
    const operations = createHostActionOperationRuntime({ machineId: host.id, serverId: profileId,
        custodyBinding: { serverId: profileId, installationId: host.installationId },
        resolveAccountId: async () => server.accountId });
    const admission = createActionExecutor(createActionExecutorBoundaryFixture({
        ...(registeredSetup ? { ...setupDeps, runActionOperation: operations.runActionOperation }
            : publishFixture ? { ...publishDeps, runActionOperation: operations.runActionOperation } : {}),
        approvalsCreate: async args => { parentPrompts.push(args.request); return approvalsCreate(args); },
        approvalsGet, approvalsUpdate, isApprovalExecutionOriginCurrent: originCurrentness,
        prepareApprovalExecutionAuthorization: async ({ authorization }) => {
            const projected = await projectParentAuthorization(authorization);
            return projected ? { authorization: projected } : null;
        },
        workflowAction: async args => {
            if (args.actionId !== 'workflow.run.start') throw new Error('unexpected_parent_workflow_action');
            try { return await owner.execute(args); }
            catch (error) {
                recordParentWorkflowFailure(error);
                throw error;
            }
        },
    }));
    const parentContext = { surface: 'cli' as const, authority: 'account_automation' as const,
        // This journey exercises one reviewed parent, independent of the
        // generic Workflow-start default; child policy stays at its receiver.
        actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
            [parentActionId]: { approvalRequiredSurfaces: ['cli'] },
        } }),
        actionCaller: { kind: 'host' as const }, actionRequestId: parentRequestId,
        ...(parentAuthorization ? { externalActionExecutionAuthorization: parentAuthorization } : {}),
        // Installed ingress retains the producer's bound root envelope for
        // read-only target preparation before approving the combined Action.
        ...(minted ? { originalActionEnvelope: minted.envelope } : {}),
        signExternalActionApprovalInput: ({ authorization, ...request }) => signExternalActionApprovalInputV1({
            ...request, authorizationToken: authorization.token, privateKey: host.keys.secretKey }),
        serverId: profileId, serverIdentityId: server.homeId, runtimeAccountId: server.accountId,
        ...(control === 'missing_permission' ? {} : { callerPermissionMode: 'default' as const }),
        defaultSessionMachineId: host.id, externalActionTarget: parentTarget } satisfies ActionExecutorContext;
    const effects: Array<{ machineId: string; presetRevision: number }> = [];
    const prompts: unknown[] = [];
    const receiverRefusals: string[] = [];
    const hostSetupFailures: Array<{ errorCode: string; error: string }> = [];
    const approvalCoordinator = createBlockingApprovalCoordinator();
    cleanups.push(async function disposeWorkflowApprovalCoordinator() { await approvalCoordinator.dispose(); });
    const receiverLifetime = new AbortController();
    cleanups.push(async function abortWorkflowReceiverLifetime() { receiverLifetime.abort(); });
    let reportHold: (artifactId: string) => void = () => { throw new Error('approval_hold_not_initialized'); };
    const held = new Promise<string>(resolve => { reportHold = resolve; });
    const receivingSettings = normalizeActionsSettingsV1(control === 'stricter' ? { v: 1, actions: {
        'machines.setup.apply': { approvalRequiredSurfaces: ['agent'] },
    } } : null);
    let installedHostTransport: Parameters<typeof createCliActionExecutorFromCredentials>[0]['machineActionDirectTargetTransport'];
    const receiver = async (machine: Machine, installation: NonNullable<typeof nativeBoundary.identity>) => {
      const nativeReceiver = !deploymentAdmission && nativeApp !== undefined && nativeApp !== null && machine.id === first.id;
      const desired: MachineSetupDesiredV1 = { version: 1, revision: 0, sources: registeredSetup
        ? (setupInput.targets.find(target => target.machineId === machine.id)?.sources ?? reviewedSetupSources()).map(source => ({
            ...source, setup: { ...source.setup, ...(source.setup.items ? {
                // This is admitted state before first Apply. App intent first
                // joins the Machine copy at successful native settlement.
                items: source.setup.items.filter(item => item.kind !== 'app'),
            } : {}) },
        })) : reviewedSetupSources(), exclusions: [] };
      const model: ApiMachine = { id: machine.id, encryptionMode: mode, metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0, metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev',
          homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier',
          setup: desired } };
      if (registeredSetup) await server.seedMachineSetupDesired(machine.id, desired);
      const previousIdentity = nativeBoundary.identity;
      let client: ApiMachineClient;
      try {
        // Each daemon captures its installed identity when its client is born.
        nativeBoundary.identity = installation;
        client = await runWithServerHttpBaseUrl(server.baseUrl, async () => {
            if (!nativeReceiver && !registeredSetup && !(installedParent && machine.id === host.id)) return new ApiMachineClient(server.token, model);
            // Native transport consumes the real stored key basis and the same
            // snapshot/recovery loader as the daemon bootstrap owner.
            const api = await ApiClient.create(credentials);
            if ((authoredSetup || installedParent) && machine.id === host.id) {
                // machineSyncClient consumes the daemon's retained Home
                // observation, not an unobserved caller-selected identity.
                const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: server.baseUrl, token: credentials.token });
                if (readServerIdentityIdFromFeaturesSnapshot(snapshot) !== server.homeId)
                    throw new Error(`authored_host_home_observation_unavailable: ${JSON.stringify(snapshot.status === 'ready'
                        ? { status: snapshot.status, provenance: snapshot.provenance,
                            identity: readServerIdentityIdFromFeaturesSnapshot(snapshot), expectedIdentity: server.homeId }
                        : snapshot)}`);
                api.setServerFeaturesSnapshotProvider(() => snapshot);
            }
            const published = await api.getMachine(machine.id);
            if (!published) throw new Error('native_deployment_machine_unavailable');
            return api.machineSyncClient(published);
        });
      } finally { nativeBoundary.identity = previousIdentity; }
      if (registeredSetup) {
        // A passthrough observation: no replacement implementation or private
        // admission/context reconstruction. Read only the original settled calls.
        const runtime = vi.spyOn(client, 'resolveMachineSetupRuntime');
        cleanups.push(async function restoreSetupRuntimeObservation() { runtime.mockRestore(); });
        readRuntimeDiagnostics.push(async () => Promise.all(runtime.mock.calls.map(async ([ingress], index) => {
            const result = runtime.mock.results[index];
            const resolved = result?.type === 'return' ? await result.value.catch(() => null) : null;
            return { boundary: 'setup-runtime', machineId: machine.id,
                admissionPresent: ingress.machineAdmission !== undefined,
                verifierPresent: ingress.verifyMachineAdmissionCurrent !== undefined,
                admissionMachineMatches: ingress.machineAdmission?.machineId === machine.id,
                admissionInstallationMatches: ingress.machineAdmission?.installationId === installation.installationId,
                capturedHomeMatches: Reflect.get(client, 'machineRuntimeServerId') === profileId,
                capturedInstallationMatches: Reflect.get(client, 'machineRuntimeInstallationId') === installation.installationId,
                signalAborted: ingress.signal.aborted, runtimeAvailable: resolved !== null };
        })));
      }
      if (registeredSetup || nativeReceiver || installedParent && machine.id === host.id) {
        if (!installedDirectory) throw new Error('installed_setup_directory_required');
        const directory = installedDirectory;
        const previous = { credentials: nativeBoundary.credentials, identity: nativeBoundary.identity, machineId: nativeBoundary.machineId };
        nativeBoundary.credentials = credentials;
        nativeBoundary.identity = installation;
        nativeBoundary.machineId = machine.id;
        let runtime: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>>;
        try {
            const api = await ApiClient.create(credentials);
            // This journey uses enrolled Machines, with no provider credentials.
            // Keep the native authority real; only its persistent/OS ports refuse
            // credential work, so target-retention discovery runs normally.
            const noProviderCredentials = async (): Promise<never> => { throw new Error('setup_catalog_has_no_provider_credentials'); };
            const managedProviderOperationAuthority = createManagedProviderOperationAuthority({
                materializationBaseDir: join(directory, machine.id, 'connected-services'),
                purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
                    store: { read: async () => ({ v: 1, bindings: [] }), update: noProviderCredentials, subscribe: () => ({ dispose() {} }) },
                    selectTarget: noProviderCredentials, resolveTarget: noProviderCredentials, materializeAccount: noProviderCredentials,
                    projectTargetAccounts: noProviderCredentials, assertTargetAccountMaterializable: noProviderCredentials,
                }),
                requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
                resolveRequestAuthHttpPort: () => { throw new Error('setup_catalog_has_no_provider_request_auth'); },
                createRedactionLease: () => ({ add() {}, close() {} }),
            });
            runtime = await runWithServerHttpBaseUrl(server.baseUrl, () => startDaemonSessionControlRuntime({
                machineId: machine.id, credentials, serverId: profileId, serverBaseUrl: server.baseUrl,
                externalActionAccountId: server.accountId, api,
                managedProviderOperationAuthority,
                connectedServicesMaterializationBaseDir: join(directory, machine.id, 'connected-services'),
                daemonSessionMutationCustody: {
                    stageTranscriptEvent: async () => { throw new Error('setup_has_no_session_events'); },
                    stageTranscriptMessage: async () => { throw new Error('setup_has_no_session_messages'); },
                },
                getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
                pidToTrackedSession: new Map(), pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
                getApiMachineForSessions: () => client, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
                connectedServicesRestartRequestedPids: new Set(),
                resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                    serverUrl: server.baseUrl, resolveCurrentMachineId: () => machine.id,
                    resolveCurrentServerIdentityId: () => server.homeId }),
                beforeShutdown: async () => {}, onHappySessionWebhook: async () => { throw new Error('setup_has_no_session'); },
                requestShutdown() {}, processEnv: {},
            }));
        } finally { Object.assign(nativeBoundary, previous); }
        cleanups.push(async function stopInstalledSetupRuntime() { await runtime.stopControlServer(); });
        const installed = runtime.externalActionIngressOwner;
        if (!installed) throw new Error('installed_setup_ingress_unavailable');
        const previousRegistrationIdentity = nativeBoundary.identity;
        nativeBoundary.identity = installation;
        let registration: ReturnType<ApiMachineClient['setRPCHandlers']>;
        try {
            registration = client.setRPCHandlers({
                spawnSession: async () => { throw new Error('setup_has_no_session'); },
                stopSession: async () => ({ status: 'not_found' }), requestShutdown() {},
            }, { externalActionIngressOwner: installed });
        } finally { nativeBoundary.identity = previousRegistrationIdentity; }
        cleanups.push(async function disposeInstalledSetupRegistration() { await registration.dispose(); });
        // Match startDaemon's installed child registration, then let the real
        // Machine transport publish it to Home. Installed setup delivery must
        // enter this registered manager, not a separately invoked raw handler.
        client.registerDeploymentChildRoutes(receiverLifetime.signal);
        cleanups.push(async function stopNativeDeploymentMachine() { await client.shutdown(); });
        const previousConnect = { credentials: nativeBoundary.credentials, identity: nativeBoundary.identity, machineId: nativeBoundary.machineId };
        nativeBoundary.credentials = credentials;
        nativeBoundary.identity = installation;
        nativeBoundary.machineId = machine.id;
        try {
            await runWithServerHttpBaseUrl(server.baseUrl, () => new Promise<void>((resolve, reject) => client.connect({
                onConnect: resolve,
                onOwnershipConflict: () => reject(new Error('native_deployment_machine_ownership_conflict')),
            })));
            const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
            if (!(manager instanceof RpcHandlerManager)) throw new Error('native_deployment_rpc_manager_required');
            // Match ApiMachine's initial 10s registration plus 10s replay phase.
            expect(await manager.waitForRegisteredHandlers([EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
                RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, RPC_METHODS.MACHINE_SETUP_PLAN], { timeoutMs: 20_000 }))
                .toEqual({ status: 'ready' });
            const socket: unknown = Reflect.get(client, 'socket');
            if (!(socket instanceof Socket)) throw new Error('installed_setup_socket_required');
            const scope = nativeBoundary.installationScope!;
            // These two installed daemons share a test process, not physical
            // files. Bind only their OS boundary to the real incoming socket,
            // including raw Plan RPCs and asynchronous native work it admits.
            const listeners = socket.listeners(SOCKET_RPC_EVENTS.REQUEST).map(listener => {
                const scoped = (...args: Parameters<typeof listener>) => scope.run({
                    machineId: machine.id, identity: installation, credentials,
                }, () => listener.apply(socket, args));
                socket.off(SOCKET_RPC_EVENTS.REQUEST, listener);
                socket.on(SOCKET_RPC_EVENTS.REQUEST, scoped);
                return { listener, scoped };
            });
            cleanups.push(async function restoreInstalledSetupSocketBoundary() {
                for (const { listener, scoped } of listeners) {
                    socket.off(SOCKET_RPC_EVENTS.REQUEST, scoped);
                    socket.on(SOCKET_RPC_EVENTS.REQUEST, listener);
                }
            });
        } finally { Object.assign(nativeBoundary, previousConnect); }
        if (registeredSetup || installedParent && machine.id === host.id) {
            if (installedParent && machine.id === host.id) {
                // The Workflow runner uses this installed daemon's real local
                // transport, just as daemonRuntime does. Only its OS boundary
                // is scoped because the fixture hosts several daemons in-process.
                const scope = nativeBoundary.installationScope!;
                installedHostTransport = { machineId: machine.id,
                    invoke: (method, request, options) => scope.run({
                        machineId: machine.id, identity: installation, credentials,
                    }, () => client.invokeLocalMachineAction(method, request, options)),
                    machineServiceAction: request => scope.run({
                        machineId: machine.id, identity: installation, credentials,
                    }, () => client.executeMachineServiceAction(request)),
                };
            }
            return { executor: installed.executor, installed, accountExecutor: null,
                control: { port: runtime.controlPort, token: runtime.controlToken } };
        }
      }
      if (!nativeReceiver) {
        Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, payload) => {
            if (!payload || typeof payload !== 'object') throw new Error('native_machine_metadata_write_required');
            return { result: 'success', version: model.metadataVersion + 1, metadata: Reflect.get(payload, 'metadata') };
        } }));
      }
      const receivingReadDeps = createCliActionDeps({ token: server.token, credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId: profileId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
        externalActionMachineInstallationId: machine.installationId, externalActionMachineRequestPrivateKey: machine.keys.secretKey });
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        ...(nativeApp && machine.id === first.id ? { ...nativeApp.dependencies,
            runActionOperation: createHostActionOperationRuntime({ machineId: machine.id, serverId: profileId,
                custodyBinding: { serverId: profileId, installationId: machine.installationId },
                resolveAccountId: async () => server.accountId }).runActionOperation } : {}),
        ...(control === 'reader_removed' ? {} : { readApprovedOperation: receivingReadDeps.readApprovedOperation }),
        prepareApprovalExecutionOriginContext: async () => ({ serverIdentityId: server.homeId }),
        approvalsCreate: async args => {
            StoredApprovalRequestSchema.parse(args.request);
            prompts.push(args.request);
            return approvalsCreate(args);
        },
        approvalsUpdate,
        approvalsWaitForDecision: async args => {
            // Use the same real blocking owner as the CLI. The test withdraws
            // its receiver after observing durable open approval and live custody.
            const waiting = approvalCoordinator.waitForDecision({ ...args,
                readRequest: () => approvalsGet({ artifactId: args.artifactId }) });
            reportHold(args.artifactId);
            const decision = await waiting;
            return { ...decision, request: StoredApprovalRequestSchema.parse(decision.request) };
        },
        machineSetupApply: async ({ input }) => {
            const preset = input.targets[0]?.sources.find(source => source.kind === 'accountPreset');
            if (!preset || preset.kind !== 'accountPreset') throw new Error('expected_reviewed_preset_child');
            effects.push({ machineId: machine.id, presetRevision: preset.presetRevision });
            return { operationId: randomUUID() };
        },
      }));
      return { executor, installed: undefined, accountExecutor: executor };
    };
    const delivered: Array<{ publisher: string; receiver: string; runId: string }> = [];
    let coordinatingRunId = runId;
    let loseSecondReply = control === 'second_reply_lost';
    let installedHostExecutor: ExternalActionIngressOwner['executor'] | undefined;
    const installedReplayFailures: Array<Readonly<{ boundary: string; name: string; code: string; message: string; stack: string[] }>> = [];
    const catalogExecutionEvents: Array<Readonly<Record<string, string | boolean>>> = [];
    const recordCatalogError = (boundary: string, error: unknown, code?: string) => {
        const sanitize = (text: string) => redactBugReportSensitiveText(text)
            .split(server.token).join('[REDACTED]').replace(/[A-Za-z0-9_+/=-]{64,}/gu, '[OPAQUE]');
        const errorCode = code ?? readRpcErrorCode(error) ?? (error && typeof error === 'object'
            && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown');
        installedReplayFailures.push({ boundary, name: error instanceof Error ? sanitize(error.name) : typeof error,
            code: sanitize(errorCode), message: error instanceof Error ? sanitize(error.message) : 'non_error_throw',
            stack: error instanceof Error ? (error.stack ?? '').split('\n')
                .filter(line => /^\s+at /u.test(line)).slice(0, 6).map(sanitize) : [] });
    };
    for (const machine of [first, second, ...(authoredSetup || installedParent ? [host] : [])]) {
        const installation: NonNullable<typeof nativeBoundary.identity> = { version: 1, createdAt: 1,
            installationId: machine.installationId, publicKey: Buffer.from(machine.keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(machine.keys.secretKey).toString('base64url') };
        const receiving = await receiver(machine, installation);
        const { executor, installed, accountExecutor } = receiving;
        if (machine.id === host.id) {
            if (installedParent) {
                if (!installed) throw new Error('catalog_installed_host_required');
                installedHostExecutor = installed.executor;
                // Passthrough observation of the normalizer the real installed
                // executor calls before hiding a post-entry throw as unknown.
                // Do not replace that executor, its dependencies or its result.
                const normalize = actionResultProjection.normalizeActionExecutorThrownError;
                const observation = vi.spyOn(actionResultProjection, 'normalizeActionExecutorThrownError')
                    .mockImplementation(error => {
                        const result = normalize(error);
                        recordCatalogError('installed.normalizer', error, result.errorCode);
                        return result;
                    });
                cleanups.push(async function restoreInstalledReplayObservation() { observation.mockRestore(); });
            }
            if (!('control' in receiving) || !receiving.control) throw new Error('authored_host_control_runtime_required');
            // Publish the actual runtime's minted loopback token/port in this
            // isolated fixture Home, through the canonical fixture-only writer.
            writeDaemonState({ pid: process.pid, httpPort: receiving.control.port, startedAt: Date.now(),
                startedWithCliVersion: configuration.currentCliVersion, controlToken: receiving.control.token,
                machineId: host.id, accountId: server.accountId });
            cleanups.push(async function clearAuthoredHostControlPublication() {
                await clearDaemonStateForTestTeardown({ includeLockFile: false });
            });
            const controlUrl = `http://127.0.0.1:${receiving.control.port}/actions/root/execute`;
            const originalFetch = globalThis.fetch;
            const controlShapes = new Map<string, { fields: Record<string, string | boolean>; count: number }>();
            const controlObservation = vi.spyOn(globalThis, 'fetch').mockImplementation(async (resource, options) => {
                let contractRead = false;
                if (resource === controlUrl && typeof options?.body === 'string') {
                    try {
                        const body: unknown = JSON.parse(options.body);
                        contractRead = body !== null && typeof body === 'object'
                            && Reflect.get(body, 'actionId') === 'action.spec.get';
                        if (body !== null && typeof body === 'object') {
                            const actionId: unknown = Reflect.get(body, 'actionId');
                            const input: unknown = Reflect.get(body, 'input');
                            const leafActionId: unknown = input !== null && typeof input === 'object' ? Reflect.get(input, 'id') : undefined;
                            if (typeof actionId === 'string') flow?.recordLocalRootExecution(actionId,
                                typeof leafActionId === 'string' ? leafActionId : undefined);
                        }
                    } catch { /* The actual HTTP owner still handles malformed input. */ }
                }
                const response = await originalFetch(resource, options);
                if (contractRead) {
                    let body: unknown;
                    try { body = await response.clone().json(); } catch { body = undefined; }
                    const fields: Record<string, string | boolean> = { boundary: 'authored-host-action-contract',
                        actionId: 'action.spec.get', httpStatus: String(response.status), httpOk: response.ok,
                        bodyShape: body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body };
                    if (body && typeof body === 'object') {
                        fields.executionOk = Reflect.get(body, 'ok') === true;
                        const result: unknown = Reflect.get(body, 'result');
                        fields.resultShape = typeof result;
                        const discovery = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].safeParse(result);
                        fields.discoveryParse = discovery.success;
                        if (discovery.success) {
                            fields.outputSchemaPresent = discovery.data.actionSpec.outputSchema !== undefined;
                            fields.completionPresent = discovery.data.actionSpec.completion !== undefined;
                            fields.schemaSectionPresent = discovery.data.schemaSection !== undefined;
                        }
                        const code: unknown = Reflect.get(body, 'errorCode');
                        if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(code)) fields.errorCode = code;
                    }
                    const key = JSON.stringify(fields);
                    const previous = controlShapes.get(key);
                    if (previous) previous.fields.observationCount = String(++previous.count);
                    else {
                        fields.observationCount = '1';
                        controlShapes.set(key, { fields, count: 1 });
                        receivingDiagnostics.push(fields);
                    }
                }
                return response;
            });
            cleanups.push(async function restoreAuthoredHostControlObservation() { controlObservation.mockRestore(); });
        }
        const receivingContext = (context?: ActionExecutorContext): ActionExecutorContext =>
            ({ ...context, serverIdentityId: server.homeId, actionsSettings: receivingSettings });
        const receivingExecutor: Parameters<typeof registerExternalActionRpcHandler>[1]['executor'] = { execute: (actionId, value, context) =>
            executor.execute(actionId, value, receivingContext(context)) };
        const receivingAccountExecutor: ExternalActionExecutionAuthorizationV1['requesterAccountExecutor'] = accountExecutor
            ? { execute: (actionId, value, context) => accountExecutor.execute(actionId, value, receivingContext(context)) } : undefined;
        // Raw socket delivery is untyped; the registered production handler parses it.
        let handler: RpcHandler | undefined;
        if (!installed) registerExternalActionRpcHandler({ registerHandler: (method, receive) => {
            if (method !== EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1) throw new Error('unexpected_receiver_method');
            handler = receive;
        } }, {
            machineId: machine.id, currentServerId: profileId, currentServerHttpBaseUrl: server.baseUrl,
            resolveAccountId: async () => server.accountId, resolveInstallationId: () => machine.installationId,
            externalActionMachineRequestPrivateKey: machine.keys.secretKey,
            verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                privateKey: machine.keys.secretKey, installationId: machine.installationId, serverHttpBaseUrl: server.baseUrl }),
            prepareRequesterAccountContext: request => {
                if (!receivingAccountExecutor) return Promise.resolve(null);
                return prepareInstalledRequesterAccountActionContext({ ...request,
                    purpose: request.purpose ?? { kind: 'external_action' },
                    machineId: machine.id, serverId: profileId, serverHttpBaseUrl: server.baseUrl, ownCredentials: credentials,
                    resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                        serverUrl: server.baseUrl, resolveCurrentMachineId: () => machine.id,
                        resolveCurrentServerIdentityId: () => server.homeId }),
                    createExecutor: () => receivingAccountExecutor,
                });
            },
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: server.baseUrl }),
            executor: receivingExecutor,
        });
        server.setReceiver(machine.id, async (request, signal, transport) => {
            if (!installed && !handler) throw new Error('receiving_front_door_not_registered');
            if (machine.id !== host.id) expect(request.executionAuthorization?.binding).toMatchObject({ machineId: machine.id,
                installationId: machine.installationId, workflowActionOrigin: { runId: coordinatingRunId } });
            if (machine.id !== host.id && registeredSetup && request.envelope.v === 1 && request.executionAuthorization) {
                const { binding } = request.executionAuthorization;
                const { input } = request.envelope;
                const checks = [
                    ['preparationMatches', () => sameStrictJsonValue(binding.deploymentPreparationAdmission,
                        projectDeploymentPreparationAdmissionV1(request.actionId, input))],
                    ['nativeReadMatches', () => sameStrictJsonValue(binding.deploymentReadAdmission,
                        projectDeploymentReadAdmissionV1(request.actionId, input))],
                    ['registryMatches', () => sameStrictJsonValue(binding.registryAppUpdateAdmission,
                        projectRegistryAppUpdateAdmissionV1(request.actionId, input))],
                    ['approvalMatches', () => binding.approvalDecisionAdmission === undefined || sameStrictJsonValue(binding.approvalDecisionAdmission,
                        projectExternalActionApprovalDecisionAdmissionV1(input))],
                    ['idempotencyMatches', () => projectExternalActionRunNowIdempotencyKeyV1(request.actionId, input) === request.envelope.idempotencyKey
                        && binding.idempotencyKey === request.envelope.idempotencyKey],
                    ['managedMatches', () => !binding.managedAdmission || sameStrictJsonValue(binding.managedAdmission,
                        projectExternalActionManagedAdmissionV1(request.actionId, input))],
                ] as const;
                const observed: Record<string, string | boolean> = { boundary: 'opened-input-projectors',
                    preparationPresent: binding.deploymentPreparationAdmission !== undefined,
                    preparationHomeExact: Boolean(input && typeof input === 'object' && 'homeId' in input
                        && input.homeId === binding.serverIdentityId) };
                for (const [name, check] of checks) {
                    try { observed[name] = check(); }
                    catch { observed[name] = false; observed[`${name}Threw`] = true; }
                }
                receivingDiagnostics.push(observed);
            }
            if (machine.id !== host.id) delivered.push({ publisher: host.id, receiver: machine.id, runId: coordinatingRunId });
            // Installed credential/key reads belong to this receiving daemon,
            // then return to the publisher's files when its socket call ends.
            const previous = { credentials: nativeBoundary.credentials,
                identity: nativeBoundary.identity, machineId: nativeBoundary.machineId };
            nativeBoundary.credentials = credentials;
            nativeBoundary.identity = installation;
            nativeBoundary.machineId = machine.id;
            let response: Awaited<ReturnType<RpcHandler>>;
            try {
                if (installed) {
                    if (!transport) throw new Error('installed_machine_transport_required');
                    // Home builds the unchanged RPC packet, rechecks the actual
                    // socket installation, and mints admission under that guard.
                    // Its registered manager owns decoding, currentness and cancel.
                    const forwarded = await transport.forward();
                    response = forwarded.ok ? forwarded.result : forwarded;
                } else {
                    if (!handler) throw new Error('receiving_front_door_not_registered');
                    response = await handler(request, { authorization: ACTION_API_SERVER_ORIGIN,
                        signal: signal ? AbortSignal.any([signal, receiverLifetime.signal]) : receiverLifetime.signal });
                }
            } finally { Object.assign(nativeBoundary, previous); }
            // The receiving daemon finished; only the socket reply is lost.
            // Restoring delivery must not authorize replay of either target.
            if (machine.id === second.id && loseSecondReply) {
                loseSecondReply = false;
                throw new Error('receiver_reply_lost');
            }
            return response;
        });
    }
    const invokeInstalledHost = (actionId: Parameters<typeof dispatchOriginalAccountAction>[0]['actionId'],
        actionInput: unknown, requestId: string, person = false) => {
        if (!installedHostExecutor) throw new Error('catalog_installed_host_required');
        return dispatchOriginalAccountAction({ actionId, input: actionInput, requestId, target: parentTarget,
            credentials, serverHttpBaseUrl: server.baseUrl, serverIdentityId: server.homeId,
            authority: person ? 'present_user' : 'account_automation', invocation: { caller: { kind: 'host' },
                surface: person ? 'ui' : 'cli', authority: person ? 'present_user' : 'account_automation' },
            signal: receiverLifetime.signal });
    };
    let effectiveHostDeps: Parameters<typeof createActionExecutor>[0];
    const hostActionDeps = createCliActionDeps({ token: server.token, credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId: profileId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
        resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: server.baseUrl, token: credentials.token }),
        externalActionMachineInstallationId: host.installationId, externalActionMachineRequestPrivateKey: host.keys.secretKey,
        machineActionDirectTargetTransport: { machineId: host.id,
            invoke: async (method, request, options) => {
                if (!authoredSetup) throw new Error('signed_child_must_reach_Home_not_local_RPC');
                return callExactMachineRpc({ credentials, machineId: host.id, serverUrl: server.baseUrl,
                    method, request, authorityCeiling: 'account_automation', requireCurrentMachine: true, timeoutMs: null,
                    ...(options?.signal ? { signal: options.signal } : {}) });
            } } }, () => effectiveHostDeps);
    const nativeReceiptAdmissions: DeploymentReceiptDispatchV1['receipt'][] = [];
    const projectAdmission = createCliProjectAdmission({ credentials, serverId: profileId, serverHttpBaseUrl: server.baseUrl }, {
        projectHomeId: profileId, actionHomeId: server.homeId,
        executionRunActionFailure: code => ({ ok: false, errorCode: code, error: code }),
    });
    const deploymentStorage = deploymentAdmission ? createCliDeploymentActionDeps({
        serverHttpBaseUrl: server.baseUrl, admitAccount: projectAdmission.projectAccountAdmission,
        resolveRequestHeaders: (context, effectActionId, request) => {
            const headers = resolveExternalActionServerRequestHeaders({ context, effectActionId, ...request,
                daemonToken: server.token, serverIdentityId: server.homeId,
                privateKey: host.keys.secretKey, installationId: host.installationId });
            return headers.ok ? headers.headers : null;
        },
        // The receipt is real Home storage. Stop at the native-effect boundary:
        // this test proves server admission, not execution or a live deployment.
        dispatchReceipt: async ({ receipt }) => {
            nativeReceiptAdmissions.push(receipt);
            return { ok: false, errorCode: 'deployment_executor_unavailable', error: 'deployment_executor_unavailable' };
        },
    }) : undefined;
    effectiveHostDeps = createActionExecutorBoundaryFixture({
        ...(deploymentStorage ? { runActionOperation: operations.runActionOperation } : {}),
        ...(authoredSetup ? { prepareMachineSetupApply: hostActionDeps.prepareMachineSetupApply,
            runActionOperation: operations.runActionOperation } : {}),
        readApprovedOperation: hostActionDeps.readApprovedOperation,
        prepareApprovalExecutionOriginContext: async () => ({ serverIdentityId: server.homeId }),
        approvalsCreate: async args => {
            StoredApprovalRequestSchema.parse(args.request);
            prompts.push(args.request);
            return approvalsCreate(args);
        },
        approvalsUpdate,
        approvalsWaitForDecision: async args => {
            const waiting = approvalCoordinator.waitForDecision({ ...args,
                readRequest: () => approvalsGet({ artifactId: args.artifactId }) });
            reportHold(args.artifactId);
            const decision = await waiting;
            return { ...decision, request: StoredApprovalRequestSchema.parse(decision.request) };
        },
        machineSetupApply: async args => {
            if (!hostActionDeps.machineSetupApply) throw new Error('installed_sender_not_bound');
            try {
                let result: unknown;
                if (control === 'changed') {
                    // Model a hostile installed sender AFTER the ordinary local
                    // classifier. The canonical sender signs changed bytes, while
                    // Home still reads the unchanged approved Run and child id.
                    const requestId = args.context.actionRequestId;
                    if (!requestId) throw new Error('installed_sender_request_id_required');
                    result = await dispatchOriginalAccountAction({ actionId: 'machines.setup.apply',
                        input: { ...args.input, targets: args.input.targets.map(target => ({ ...target,
                            sources: target.sources.map(source => source.kind === 'accountPreset'
                                ? { ...source, presetRevision: source.presetRevision + 1 } : source) })) },
                        requestId, target: { kind: 'machine', machineId: args.input.machineId },
                        credentials, serverHttpBaseUrl: server.baseUrl, serverIdentityId: server.homeId,
                        authority: 'account_automation', installedWorkflow: { context: args.context,
                            machineId: host.id, installationId: host.installationId, privateKey: host.keys.secretKey },
                        signal: receiverLifetime.signal });
                    const refusal = ActionExecuteFailureSchema.safeParse(result);
                    if (refusal.success) receiverRefusals.push(refusal.data.errorCode);
                } else result = await hostActionDeps.machineSetupApply({ ...args, signal: receiverLifetime.signal });
                const refusal = ActionExecuteFailureSchema.safeParse(result);
                if (refusal.success) hostSetupFailures.push({ errorCode: refusal.data.errorCode, error: refusal.data.error });
                if (authoredSetup && refusal.success) {
                    const unavailable = WorkflowTargetUnavailableDetailsV1Schema.safeParse(refusal.data.details);
                    if (unavailable.success) receivingDiagnostics.push({ boundary: 'authored-host-setup-refusal',
                        errorCode: unavailable.data.code, reason: unavailable.data.reason });
                }
                return result;
            } catch (error) {
                receiverRefusals.push(readRpcErrorCode(error) ??
                    (error && typeof error === 'object' && 'code' in error ? String(error.code)
                        : error instanceof Error ? error.message : 'unknown'));
                throw error;
            }
        },
        ...(publishFixture || nativeApp ? { deploymentAction: deploymentStorage?.deploymentAction ?? hostActionDeps.deploymentAction } : {}),
        ...(nativeApp ? { resolveEnvironmentApprovalScope: deploymentStorage?.resolveEnvironmentApprovalScope ?? publishReadDeps.resolveEnvironmentApprovalScope } : {}),
    });
    if (catalog) {
        if (!nativeApp || nativeApp.child.actionId !== 'deployments.templates.instantiate')
            throw new Error('catalog_setup_app_required');
        const target = setupInput.targets[0];
        if (!target) throw new Error('catalog_setup_target_required');
        const { deploy: _deploy, ...definitionOnly } = nativeApp.child.input;
        const omittedInput = { ...setupInput, targets: [{ ...target,
            appChildren: [{ ...nativeApp.child, input: definitionOnly }] }] };
        // Observe the real RPC transport without replacing its review or delivery.
        const targetTransport = vi.spyOn(machineRpcTransport, 'callExactMachineRpc');
        let deploymentSourceReads = 0;
        const preparationHttpFacts: Array<Readonly<{ route: string; status: number }>> = [];
        const machineReadFacts: Array<Readonly<Record<string, string | boolean>>> = [];
        const machineObservation = axios.interceptors.response.use(response => {
            const path = new URL(response.config.url!, response.config.baseURL).pathname;
            const route = path === `/v1/projects/sources/${encodeURIComponent(nativeApp.projectSourceId)}` ? 'source'
                : path === `/v1/projects/${encodeURIComponent(nativeApp.projectSourceId)}/deployment-defaults` ? 'project-defaults'
                : path.startsWith('/v1/deployments/') ? 'deployment'
                : path.startsWith('/v1/machines/setup/') ? 'setup-home' : undefined;
            if (route) preparationHttpFacts.push({ route, status: response.status });
            if (!path.startsWith('/v1/machines/')) return response;
            const machine: unknown = response.data && typeof response.data === 'object'
                ? Reflect.get(response.data, 'machine') : undefined;
            const access: unknown = machine && typeof machine === 'object' ? Reflect.get(machine, 'access') : undefined;
            machineReadFacts.push({ status: String(response.status), target: path.endsWith(`/${target.machineId}`),
                host: path.endsWith(`/${host.id}`),
                manage: Boolean(access && typeof access === 'object' && Reflect.get(access, 'role') === 'manage'),
                revoked: Boolean(machine && typeof machine === 'object' && Reflect.get(machine, 'revokedAt') != null),
                replaced: Boolean(machine && typeof machine === 'object' && Reflect.get(machine, 'replacedByMachineId') != null) });
            return response;
        });
        const observation = axios.interceptors.request.use(request => {
            if (new URL(request.url!, request.baseURL).pathname
                === `/v1/projects/sources/${encodeURIComponent(nativeApp.projectSourceId)}`) deploymentSourceReads++;
            return request;
        });
        try {
            // Setup installs the app. Definition-only instantiate remains valid
            // outside Setup, but cannot stand in for its literal deploy leaf.
            // The ordinary installed Apply prepares its real target Plan
            // before creating the parent's approval or any native work.
            const omittedDeploy = await invokeInstalledHost('machines.setup.apply', omittedInput, randomUUID());
            const targetTransportFacts = targetTransport.mock.calls.filter(([call]) => call.method === RPC_METHODS.MACHINE_SETUP_PLAN)
                .map(([call]) => {
                    const context = call.externalAction?.context;
                    const authorization = context?.externalActionExecutionAuthorization;
                    const envelope = ExternalActionRequestEnvelopeSchema.safeParse(context?.originalActionEnvelope);
                    const child = MachineSetupPlanInputV1Schema.safeParse(call.request);
                    const root = envelope.success && envelope.data.v === 1
                        ? MachineSetupApplyInputV1Schema.safeParse(envelope.data.input) : null;
                    const expected = { homeId: target.homeId, machineId: target.machineId, sources: target.sources,
                        exclusions: target.exclusions, appChildren: omittedInput.targets[0]!.appChildren, mode: 'effects' };
                    return { authorizationPresent: authorization !== undefined, envelopePresent: envelope.success,
                        envelopeBound: Boolean(authorization && envelope.success && isExternalActionAuthorizationBoundToEnvelope(
                            authorization.binding, { actionId: authorization.binding.actionId,
                                machineId: authorization.binding.machineId, envelope: envelope.data })),
                        childParsed: child.success, plainRootParsed: root?.success ?? false,
                        plainRootMatches: Boolean(root?.success && sameStrictJsonValue(root.data, omittedInput)),
                        rootActionMatches: authorization?.binding.actionId === 'machines.setup.apply',
                        plainRootHomeMatches: Boolean(root?.success && root.data.homeId === authorization?.binding.serverIdentityId),
                        canonicalChildMatches: Boolean(authorization && envelope.success && envelope.data.v === 1
                            && readMachineSetupPlanChildInputV1({ rootActionId: authorization.binding.actionId,
                                rootInput: envelope.data.input, machineId: call.machineId, input: call.request })),
                        ...Object.fromEntries(Object.entries(expected).map(([key, value]) => [key,
                            child.success && sameStrictJsonValue(Reflect.get(child.data, key), value)])) };
                });
            const omittedDiagnostics = JSON.stringify({ result: omittedDeploy, deploymentSourceReads, preparationHttpFacts,
                machineReadFacts, targetTransportFacts, receivingDiagnostics: await readReceivingDiagnostics() });
            expect(deploymentSourceReads, omittedDiagnostics).toBe(0);
            expect(omittedDeploy, omittedDiagnostics).toMatchObject({ ok: false,
                errorCode: 'machine_setup_app_plan_changed' });
        } finally {
            axios.interceptors.request.eject(observation);
            axios.interceptors.response.eject(machineObservation);
            targetTransport.mockRestore();
        }
        const response = await fetch(`${server.baseUrl}/v1/deployments/environments?serverId=${server.homeId}&projectSourceId=${nativeApp.projectSourceId}`,
            { headers: { Authorization: `Bearer ${server.token}` } });
        expect(response.status).toBe(200);
        expect(DeploymentActionOutputSchemasV1['deployments.environments.list'].parse(await response.json()))
            .toMatchObject({ ok: true, items: [] });
        expect((await nativeApp.docker.readInvocations()).filter(call => call.args.includes('up'))).toEqual([]);
        expect(nativeBoundary.launches.slice(nativeLaunchIndex)).toEqual([]);
    }
    // Parent effects review reaches real target Plan: install receiving daemons first.
    flow?.setPhase('review');
    const requested = installedParent ? await invokeInstalledHost(parentActionId, input, parentRequestId)
        : await admission.execute(parentActionId, input, parentContext);
    if (!requested.ok) throw new Error(`parent_approval_${requested.errorCode}_${JSON.stringify({ setupArtifactReads,
        installedReplayFailures, receivingDiagnostics: await readReceivingDiagnostics() })}`);
    expect(requested).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
    if (!requested.ok || !requested.result || typeof requested.result !== 'object'
        || !('artifactId' in requested.result) || typeof requested.result.artifactId !== 'string') throw new Error('parent_approval_not_created');
    const artifactId = requested.result.artifactId;
    const openApproval = await approvalsGet({ artifactId });
    expect(openApproval).toMatchObject({ status: 'open', actionId: parentActionId });
    if (control === 'retained_permission') expect(openApproval).toMatchObject({
        executionOriginV1: { callerPermissionMode: 'default' } });
    if (control === 'missing_permission') expect(openApproval).not.toHaveProperty('executionOriginV1.callerPermissionMode');
    if (installedParent) parentPrompts.push(openApproval);
    if (deploymentAdmission) expect(deploymentPreparationCalls, 'Publish prepares the owner preview once before Ask').toBe(1);
    const { externalActionExecutionAuthorization: _originalRoot, ...decisionContext } = parentContext;
    flow?.setPhase('approve');
    const decision = installedParent ? await invokeInstalledHost('approval.request.decide', { artifactId, decision: 'approve' }, randomUUID(), true)
        : await admission.execute('approval.request.decide', { artifactId, decision: 'approve' },
            { ...decisionContext, authority: 'present_user', actionRequestId: randomUUID(),
                ...(control === 'retained_permission' ? { callerPermissionMode: 'read-only' as const }
                    : control === 'missing_permission' ? { callerPermissionMode: 'default' as const } : {}) });
    expect(decision, decision.ok ? undefined : `parent_decision_${decision.errorCode}`).toMatchObject({ ok: true });
    const settledApproval = await approvalsGet({ artifactId });
    if (permissionReplay) expect(deploymentPreparationCalls, 'An admitted Publish reuses its retained native review on approval replay').toBe(1);
    if (settledApproval?.status !== 'executed') {
        const execution = settledApproval && 'execution' in settledApproval ? settledApproval.execution : null;
        if (control === 'missing_permission') await expect(storage.execute({ operation: 'get', runId }))
            .rejects.toMatchObject({ response: { status: 404 } });
        throw Object.assign(new Error(`parent_replay_${settledApproval?.status}_${execution && !execution.ok ? execution.errorCode : 'unavailable'}_${JSON.stringify({ parentWorkflowFailure,
            ...(installedParent ? { installedReplayFailures } : {}), receivingDiagnostics: await readReceivingDiagnostics() })}${
            lastPublishRunRequest ? `_run_request_${JSON.stringify(lastPublishRunRequest)}` : ''}`),
            { code: execution && !execution.ok ? execution.errorCode : 'unavailable' });
    }
    expect(settledApproval).toMatchObject({ status: 'executed', decision: { kind: 'approve' } });
    if (deploymentAdmission) expect(deploymentPreparationCalls, 'approving the exact Publish Ask reuses its admitted owner preview').toBe(1);
    expect(parentPrompts).toHaveLength(1);
    const approved = await readStoredSnapshot();
    const { encryption: runEncryption } = await readRunEncryption();
    const sealMode = runEncryption.runCrypto.mode === 'e2ee'
        ? { ...runEncryption.runCrypto, randomBytes: tweetnacl.randomBytes } : runEncryption.runCrypto;
    const expectedSetupSteps = steps.map(step => ({ ...step, input: buildMachineSetupTargetApplyInput(step.input.targets[0]!) }));
    expect(approved.approvedOperation).toMatchObject({ parent: { actionId: parentActionId, input },
        approvedBy: { accountId: server.accountId }, steps: authoredSetup ? [{ actionId: 'machines.setup.apply', input: setupInput }] : publishFixture
            ? [...expectedSetupSteps, { actionId: 'deployments.deploy', input: publishFixture.input.preparedChildren.deploy }]
            : nativeApp ? [...expectedSetupSteps, { actionId: nativeApp.child.actionId, input: nativeApp.child.input }] : expectedSetupSteps });
    // Publish approval replays on the deciding app with its witnessed review,
    // not the original signed requester binding. It must not invent a starter.
    if (registeredPublish) {
        expect(resolveApprovalExecutor(StoredApprovalRequestSchema.parse(openApproval)))
            .toEqual({ kind: 'app', placement: 'account' });
        expect(approved.origin?.authenticatedStarterV1).toBeUndefined();
    } else expect(approved.origin?.authenticatedStarterV1).toEqual({ requestRef: parentRequestId,
        requester: { accountId: server.accountId, serverId: server.homeId } });
    let claim = await server.claim(host.id);
    expect(claim.runId).toBe(runId);
    const checkpoint: WorkflowCheckpointEnvelopeV1 = { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId,
        nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
    const initialized: unknown = await storage.execute({ operation: 'initialize', runId, parentAttempt: claim.attempt,
        expectedRevision: claim.revision, accountCurrentness: server.currentness,
        checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ ...sealMode,
            binding: { v: 1, purpose: 'checkpoint', accountId: server.accountId, runId }, checkpoint })),
        rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
            ...sealMode, binding: { v: 1, purpose: 'invocation_progress', accountId: server.accountId, runId,
                recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
            progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
                blockKind: 'root', attempt: '0', logicalInvocationRecordId: rootId } })) } });
    const initial = initialized as { run: unknown };
    const initializedRun = WorkflowRunSummaryV1Schema.parse(initial.run);
    const parentExecutor = (() => {
        if (!installedParent) return createActionExecutor(effectiveHostDeps);
        if (!installedHostExecutor || !installedHostTransport) throw new Error('catalog_installed_host_required');
        // The parent still enters the installed external ingress. Its accepted
        // Run uses daemonRuntime's full prepared Action factory, not that
        // ingress's intentionally execute-only transport interface.
        const composed = createCliActionExecutorFromCredentials({ credentials,
            serverId: profileId, serverApiUrl: server.baseUrl, serverIdentityId: server.homeId,
            machineId: host.id, externalActionMachineInstallationId: host.installationId,
            externalActionMachineRequestPrivateKey: host.keys.secretKey,
            machineActionDirectTargetTransport: installedHostTransport,
            workflowAcceptedAuthorizationCurrentness: createWorkflowAcceptedAuthorizationCurrentness({
                accountId: server.accountId,
                listAccountApiTokens: async () => { throw new Error('host_principal_has_no_API_token'); },
                resolveCurrentPluginOccurrenceId: async () => { throw new Error('host_principal_has_no_plugin'); },
                isMediatedSourceCurrent: async () => { throw new Error('host_principal_has_no_mediator'); } }),
            pluginActionExecutionOwner: 'current_process',
            listContributedActionDefinitions: createCommittedContributedActionDefinitionLister(),
            invokeContributedAction: createCommittedContributedActionInvoker({
                requestCurrentIntent: createCredentialedTargetActionCurrentIntent(credentials) }),
        });
        // Observe the real prepared invocation, including exceptions the
        // coordinator intentionally settles as uncertain. No effect is retried.
        const observed: typeof composed = { ...composed, prepare: async (...args) => {
            try {
                const prepared = await composed.prepare(...args);
                catalogExecutionEvents.push({ boundary: 'catalog.prepare', actionId: args[0], kind: prepared.kind });
                if (prepared.kind !== 'ready') return prepared;
                return { ...prepared, invocation: { ...prepared.invocation, run: async () => {
                    try {
                        const result = await prepared.invocation.run();
                        catalogExecutionEvents.push({ boundary: 'catalog.invocation.result', actionId: args[0], ok: result.ok,
                            ...(!result.ok ? { errorCode: result.errorCode } : {}) });
                        return result;
                    } catch (error) { recordCatalogError('catalog.invocation.run', error); throw error; }
                } } };
            } catch (error) { recordCatalogError('catalog.prepare', error); throw error; }
        } };
        const loadStore = DurableWorkflowCoordinatorStore.load;
        const admissionObservation = vi.spyOn(DurableWorkflowCoordinatorStore, 'load')
            .mockImplementation(async (...args) => {
                const store = await loadStore(...args);
                const commitFact = store.commitFact;
                const observation = vi.spyOn(store, 'commitFact').mockImplementation(async (...factArgs) => {
                    try {
                        const result = await commitFact(...factArgs);
                        if (factArgs[0].lifecycle === 'admitting') catalogExecutionEvents.push({
                            boundary: 'catalog.admission-cas', status: 'committed' });
                        return result;
                    } catch (error) { recordCatalogError(`catalog.commitFact.${factArgs[0].lifecycle}`, error); throw error; }
                });
                cleanups.push(async function restoreCatalogStoreObservation() { observation.mockRestore(); });
                return store;
            });
        cleanups.push(async function restoreCatalogAdmissionObservation() { admissionObservation.mockRestore(); });
        return observed;
    })();
    const resolveWorkflowContext = createWorkflowActionContextResolver(
        createCredentialedWorkflowMaterializationHostV1({ credentials, accountId: server.accountId,
            serverId: profileId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
            callMachineAction: async request => await callExactMachineRpc({ credentials,
                machineId: request.machineId, serverUrl: server.baseUrl, method: request.method,
                request: request.request, authorityCeiling: 'account_automation', requireCurrentMachine: true,
                ...(request.signal ? { signal: request.signal } : {}) }),
            readWorkflowDefinition: async () => { throw new Error('inline_fixture_workflow_has_no_definition_reference'); },
        }));
    const coordinate = async (snapshot: WorkflowAcceptedSnapshotV1 = approved) => {
        // Every call reconstructs the real durable store and reader, proving
        // approved input survives a daemon/coordinator replacement.
        const store = await DurableWorkflowCoordinatorStore.load({ accountId: server.accountId, runId,
            parentAttempt: claim.attempt, storage, encryption: runEncryption,
            rootRecordId: rootId, checkpoint, revision: initializedRun.revision, definition: snapshot.definition,
            authoredDefinition: snapshot.authoredDefinition, frozenChildren: snapshot.frozenChildren });
        const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootId,
            executeStep: async () => { throw new Error('no_agent_step_in_this_operation'); },
            resolveWorkspace: createCoordinatorWorkspaceResolver({ store, projectWorkspace: snapshot.workspaceTarget.project,
                ...(snapshot.workspaceTarget.originalCommittedRevision
                    ? { originalCommittedRevision: snapshot.workspaceTarget.originalCommittedRevision } : {}) }),
            isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId: server.accountId,
                listAccountApiTokens: async () => { throw new Error('host_principal_has_no_API_token'); },
                resolveCurrentPluginOccurrenceId: async () => { throw new Error('host_principal_has_no_plugin'); },
                isMediatedSourceCurrent: async () => { throw new Error('host_principal_has_no_mediator'); } }),
            action: { executor: parentExecutor, buildContext: async execution => ({
                ...await resolveWorkflowContext(execution),
                serverId: profileId, serverIdentityId: server.homeId, runtimeAccountId: server.accountId }),
                observeRun: async () => { throw new Error('no_agent_run_in_this_operation'); } },
        });
        const previousCoordinatingRunId = coordinatingRunId;
        coordinatingRunId = runId;
        try { return await coordinator.run({ ...snapshot, runId, signal: receiverLifetime.signal }); }
        finally { coordinatingRunId = previousCoordinatingRunId; }
    };
    const coordinateProduction = async (selectedClaim = claim) => {
        const action = { executor: parentExecutor, buildContext: async (execution: Parameters<typeof resolveWorkflowContext>[0]) => ({
            ...await resolveWorkflowContext(execution), serverId: profileId, serverIdentityId: server.homeId,
            runtimeAccountId: server.accountId }),
            observeRun: async () => { throw new Error('setup_has_no_agent_run'); } };
        const coordinator = createProductionWorkflowRunCoordinator({ token: server.token, accountId: server.accountId,
            machineId: host.id, storage,
            resolveAccountEncryption: () => runWithServerHttpBaseUrl(server.baseUrl,
                () => resolveAutomationWorkerAccountEncryption({ token: server.token, credentials })).then(encryption => {
                    if (encryption.kind !== 'available') throw new Error('account_encryption_unavailable');
                    return encryption;
                }),
            isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId: server.accountId,
                listAccountApiTokens: async () => { throw new Error('host_principal_has_no_API_token'); },
                resolveCurrentPluginOccurrenceId: async () => { throw new Error('host_principal_has_no_plugin'); },
                isMediatedSourceCurrent: async () => { throw new Error('host_principal_has_no_mediator'); } }),
            resolveControllerContext: async () => ({ surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: profileId, serverIdentityId: server.homeId, runtimeAccountId: server.accountId }),
            execution: { credentials, serverId: profileId, serverIdentityId: server.homeId,
                // Genuine Session enqueue transport is outside this Action-only journey.
                machineAdmissionTransport: async () => { throw new Error('setup_has_no_session_input'); },
                resolveExistingSessionConversation: request => resolveWorkflowSessionConversation({ credentials, ...request }),
                detachedRun: { actionExecutor: parentExecutor, buildActionContext: resolveWorkflowContext }, action },
        });
        const previousCoordinatingRunId = coordinatingRunId;
        coordinatingRunId = selectedClaim.runId;
        try { return await runWithServerHttpBaseUrl(server.baseUrl, () => coordinator({ runId: selectedClaim.runId, attempt: selectedClaim.attempt,
            expectedRevision: selectedClaim.revision, accountCurrentness: server.currentness, signal: receiverLifetime.signal })); }
        finally { coordinatingRunId = previousCoordinatingRunId; }
    };
    const reconcileInvocations = async () => {
        const stored = await storage.execute({ operation: 'get', runId });
        if (!stored || typeof stored !== 'object' || !('run' in stored)) throw new Error('missing_stored_run');
        const run = WorkflowRunSummaryV1Schema.parse(stored.run);
        const writer = createWorkflowInvocationRecoveryFactWriter({ accountId: server.accountId, run,
            parentAttempt: claim.attempt, storage, encryption: runEncryption });
        const listed = await storage.execute({ operation: 'invocations.list', runId,
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        if (!listed || typeof listed !== 'object' || !('invocations' in listed) || !Array.isArray(listed.invocations)) {
            throw new Error('missing_stored_invocations');
        }
        if ('nextCursor' in listed && listed.nextCursor) throw new Error('fixture_invocations_exceed_one_page');
        const observer = createWorkflowInvocationRecoveryObserver({ credentials, machineId: host.id, actionExecutor: parentExecutor });
        const invocations = [];
        for (const raw of listed.invocations) {
            const index = WorkflowRunInvocationIndexV1Schema.parse(raw);
            const invocation = await writer.readInvocation(index.id);
            if (!invocation || invocation.progress.blockKind !== 'action') continue;
            const observation = index.lifecycle === 'outcome_uncertain'
                ? await observer({ progress: invocation.progress, run, index,
                    terminalParent: false, cancellationRequested: false, observationOnly: true,
                    frozenActionContract: approved.materializedLeaves.find(leaf => leaf.kind === 'action'
                        && leaf.blockId === invocation.progress.invocationPath.blockId)?.actionContract })
                : undefined;
            if (observation) await writer.commitObservation(invocation, observation);
            invocations.push({ index, progress: invocation.progress, observation });
        }
        return invocations;
    };
    const publicActionContext = (): ActionExecutorContext => ({ surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: profileId, serverIdentityId: server.homeId, runtimeAccountId: server.accountId,
        actionRequestId: randomUUID() });
    const failNativeStarts = (machineId: string) => {
        if (!registeredSetup || ![first.id, second.id].includes(machineId)) throw new Error('registered_setup_target_required');
        const fault = { machineId, observed: false };
        nativeBoundary.ptySpawnFault = fault;
        const disarm = () => { if (nativeBoundary.ptySpawnFault === fault) nativeBoundary.ptySpawnFault = null; };
        cleanups.push(async () => { disarm(); });
        return disarm;
    };
    const publicSetupPlan = (targets?: MachineSetupCombinedPlanInputV1['targets'], selectedMachineId?: string) => {
        const input = { homeId: server.homeId, machineId: host.id,
            ...(selectedMachineId === undefined ? {} : { selectedMachineId }),
            targets: targets ?? [first, second].map(machine => ({ homeId: server.homeId, machineId: machine.id })) };
        return installedParent ? invokeInstalledHost('machines.setup.plan', input, randomUUID())
            : createActionExecutor({ ...effectiveHostDeps, machineSetupPlan: hostActionDeps.machineSetupPlan })
                .execute('machines.setup.plan', input, publicActionContext());
    };
    const publicSetupApply = async (input: MachineSetupApplyInputV1) => {
        if (!registeredSetup || authoredSetup || input.machineId !== host.id) throw new Error('reviewed_setup_host_required');
        const requestId = randomUUID();
        const fresh = installedParent ? null : await prepareExternalActionRequesterAccountAuthorizationWithEnvelope({ actionId: 'machines.setup.apply', input,
            requestId, target: parentTarget, machineId: host.id, accountId: server.accountId,
            accountEncryptionMode: mode, tokenEpochHint: server.tokenEpoch, token: server.token,
            ...(credentials.encryption?.type === 'dataKey' ? { material: credentials.encryption } : {}),
            serverId: profileId, serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
            installationId: host.installationId, privateKey: host.keys.secretKey });
        const authorization = fresh ? await projectParentAuthorization(fresh.authorization) : null;
        if (!installedParent && (!fresh || !authorization)) throw new Error('fresh_setup_account_admission_unavailable');
        const context: ActionExecutorContext = { ...parentContext, actionRequestId: requestId,
            ...(authorization ? { externalActionExecutionAuthorization: authorization } : {}),
            ...(fresh ? { originalActionEnvelope: fresh.envelope } : {}) };
        const requested = installedParent ? await invokeInstalledHost('machines.setup.apply', input, requestId)
            : await admission.execute('machines.setup.apply', input, context);
        expect(requested, JSON.stringify(requested)).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
        if (!requested.ok || !requested.result || typeof requested.result !== 'object'
            || !('artifactId' in requested.result) || typeof requested.result.artifactId !== 'string') throw new Error('fresh_setup_approval_missing');
        const artifactId = requested.result.artifactId;
        const open = await approvalsGet({ artifactId });
        expect(open).toMatchObject({ status: 'open', actionId: 'machines.setup.apply', actionArgs: input });
        if (installedParent) parentPrompts.push(open);
        const { externalActionExecutionAuthorization: _root, ...decisionContext } = context;
        const decision = installedParent ? await invokeInstalledHost('approval.request.decide', { artifactId, decision: 'approve' }, randomUUID(), true)
            : await admission.execute('approval.request.decide', { artifactId, decision: 'approve' },
                { ...decisionContext, authority: 'present_user', actionRequestId: randomUUID() });
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
        expect(await approvalsGet({ artifactId })).toMatchObject({ status: 'executed', decision: { kind: 'approve' } });
        return { requestId, artifactId, runId: deriveWorkflowReplacementId(['machines.setup.apply', server.homeId, server.accountId, requestId]) };
    };
    const publicSetupPreparation = (input: MachineSetupApplyInputV1) => hostActionDeps.prepareMachineSetupApply!({ input,
        context: publicActionContext() });
    return { server, coordinate, coordinateProduction, publicSetupPlan, publicSetupApply, publicSetupPreparation, failNativeStarts, workflowDirectory, get effects() {
        return registeredSetup ? nativeBoundary.launches.slice(nativeLaunchIndex).flatMap(launch => {
            const preset = setupInput.targets.find(target => target.machineId === launch.machineId)?.sources.find(source => source.kind === 'accountPreset');
            return launch.machineId && preset?.kind === 'accountPreset' ? [{ machineId: launch.machineId, presetRevision: preset.presetRevision }] : [];
        }) : effects;
    }, prompts, parentPrompts, host, first, second, storage, runId, delivered, readStoredSnapshot,
        selection, environments, environmentController, personChoice, agentMachine, publishFixture, nativeApp, nativeReceiptAdmissions,
        readDeploymentPreparationCalls: () => deploymentPreparationCalls, replayedPublishPermissionMode,
        readApprovalRequests: () => runWithServerHttpBaseUrl(server.baseUrl, () => approvals.approvalsList({ serverId: profileId })),
        held, approvalCoordinator, receiverLifetime, approvalsGet, receiverRefusals, hostSetupFailures, reconcileInvocations,
        readReceivingDiagnostics, readCatalogExecutionDiagnostics: () => ({ installedReplayFailures, catalogExecutionEvents }) };
}

describe('server-stored combined Workflow approval across two receiving Action front doors', () => {
    it.each([
        { kind: 'multi' as const, code: 'approval_required' },
        { kind: 'app_missing' as const, code: 'machine_setup_app_preparation_unavailable' },
    ])('keeps authored $kind setup at its canonical composer rather than the native receiver', async ({ kind, code }) => {
        const run = await fixture('exact', undefined, false, true, false, kind);
        const accepted = await run.readStoredSnapshot();
        expect(accepted.workspaceTarget.project).toMatchObject({ machineId: run.host.id, directory: run.workflowDirectory });
        expect(accepted.workspaceTarget.project.directory).not.toBe(configuration.happyHomeDir);
        expect(await run.coordinate()).toMatchObject({ state: 'failed' });
        expect(await run.reconcileInvocations(), JSON.stringify({ hostSetupFailures: run.hostSetupFailures,
            receivingDiagnostics: await run.readReceivingDiagnostics() })).toMatchObject([
            { index: { lifecycle: 'failed' }, progress: { reason: { code } } },
        ]);
        expect(run.effects).toEqual([]);
        expect(run.delivered).toEqual([]);
        expect(run.parentPrompts).toHaveLength(1);
        expect(run.prompts).toEqual([]);
    });

    it('prepares combined setup on the first online install target rather than the routing host, with explicit Change', async () => {
        const server = await startServer();
        cleanups.push(server.close);
        const [routing, first, second] = server.machines;
        if (!routing || !first || !second) throw new Error('three_enrolled_machines_required');
        const targets = [first, second].map(machine => ({ homeId: server.homeId, machineId: machine.id }));
        const nativePlans = new Map([first, second].map(machine => {
            const apiMachine = new ApiMachineClient(server.token, {
                id: machine.id, encryptionMode: 'plain', metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
                metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'test', homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier',
                    setup: createEmptyMachineSetupDesiredV1() },
            });
            Reflect.set(apiMachine, 'socket', createApiSessionSocketStub({ connected: true }));
            return [machine.id, createMachineSetupPlanAction({ homeId: server.homeId, machineId: machine.id, apiMachine })] as const;
        }));
        const combined = createCombinedMachineSetupActionDeps({
            readDeps: () => createActionExecutorBoundaryFixture({}),
            // Socket delivery is the boundary: all target Plan/metadata logic is real.
            targetPlan: request => {
                const plan = nativePlans.get(request.input.machineId);
                if (!plan) throw new Error('unknown_target');
                return plan(request);
            }, readHostFacts: async () => ({ machines: await server.readMachines() }),
            orchestrationDirectory: '/workflow-project',
            startCombined: async () => { throw new Error('plan_cannot_start_workflow'); },
            waitForRun: async () => { throw new Error('plan_cannot_wait_for_workflow'); },
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture(combined));
        const input = { homeId: server.homeId, machineId: routing.id, targets };
        const context = { surface: 'cli' as const, authority: 'present_user' as const };
        const defaultPlan = await executor.execute('machines.setup.plan', input, context);
        if (!defaultPlan.ok) throw new Error(`combined_plan_${defaultPlan.errorCode}_${defaultPlan.error}`);
        expect(defaultPlan)
            .toMatchObject({ ok: true, result: { review: { machineId: first.id }, targets: targets.map(target => ({ ...target, plan: { desiredRevision: 0 } })) } });
        expect(await executor.execute('machines.setup.plan', { ...input, selectedMachineId: second.id }, context))
            .toMatchObject({ ok: true, result: { review: { machineId: second.id } } });
        await server.setMachineOnline(first.id, false);
        expect(await executor.execute('machines.setup.plan', input, context))
            .toMatchObject({ ok: true, result: { review: { machineId: second.id } } });
    });
    it.each(['person', 'agent', 'agentWaived', 'agentRejected'] as const)('keeps signed Prepare person confirmation and agent Ask distinct from ordinary Session admission (%s)', async actor => {
        const server = await startServer();
        cleanups.push(server.close);
        const machine = server.machines[0];
        if (!machine) throw new Error('prepare_workspace_machine_required');
        const directory = createGitWorkspace('happier-signed-prepare-');
        cleanups.push(async () => removeTempDir(directory));
        runGit(directory, ['commit', '--allow-empty', '-m', 'base']);
        runGit(directory, ['remote', 'add', 'origin', 'https://github.com/prepare/app.git']);
        const input = await server.createPrepareWorkspace({ rootPath: directory, machineId: machine.id,
            baseCommit: runGit(directory, ['rev-parse', 'HEAD']) });
        const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git', 'happier.scm.forge.github'] } });
        cleanups.push(() => runtime.dispose());
        const credentials = { token: server.token, encryption: null };
        const approvalStore = createCliApprovalsArtifactStore({ credentials, serverId: server.homeId, serverHttpBaseUrl: server.baseUrl });
        const delivered: string[] = [];
        const childExecutions: unknown[] = [];
        const authorizationResponses: Array<{ path: string; status: number; code?: string;
            schemaIssues?: Array<{ code: string; path: readonly PropertyKey[] }> }> = [];
        const receiverLifetime = new AbortController();
        cleanups.push(async () => receiverLifetime.abort());
        let reportApproval: (artifactId: string) => void = () => { throw new Error('prepare_approval_observer_uninitialized'); };
        const createdApproval = new Promise<string>(resolve => { reportApproval = resolve; });
        const post = axios.post.bind(axios);
        // Observe the actual durable Artifact HTTP acknowledgement; no policy,
        // storage response, or internal approval implementation is replaced.
        const artifactHttp = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
            const response = await post(url, body, options);
            if (String(url).startsWith(server.baseUrl) && String(url).endsWith('/execution-authorization')) {
                const { ExternalActionExecutionAuthorizationV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
                const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(response.data);
                const refusal = ExternalActionHttpErrorSchema.safeParse(response.data);
                authorizationResponses.push({ path: new URL(String(url)).pathname, status: response.status,
                    ...(refusal.success && 'code' in refusal.data ? { code: refusal.data.code } : {}),
                    ...(!parsed.success && response.status >= 200 && response.status < 300
                        ? { schemaIssues: parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path })) } : {}) });
            }
            if (String(url) === `${server.baseUrl}/v1/artifacts`) {
                const request = ArtifactJsonCreateHttpInputV1Schema.parse(body);
                const value: unknown = response.data;
                if (response.status === 200 && value && typeof value === 'object' && 'id' in value
                    && value.id === request.id) reportApproval(request.id);
            }
            return response;
        });
        cleanups.push(async () => artifactHttp.mockRestore());
        let nativeEffects = 0;
        // Requiring the child uses its ordinary policy. Prepare's direct press
        // cannot supply that independent Session decision.
        const settings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
            'session.spawn_new': { approvalRequiredSurfaces: actor === 'agentWaived' ? ['mcp'] : ['ui'] },
        }, ...(actor === 'agentWaived' ? { approvalWaivedSurfaces: { 'deployments.prepare': ['mcp'] } } : {}) } });
        const executor = (requester?: RequesterAccountActionContext) =>
            createCliActionExecutor({ token: server.token, credentials: requester?.credentials ?? credentials,
                sessionId: '', mode: 'plain', ctx: null, serverId: server.homeId, serverIdentityId: server.homeId,
                serverHttpBaseUrl: server.baseUrl, externalActionMachineInstallationId: machine.installationId,
                externalActionMachineRequestPrivateKey: machine.keys.secretKey,
                ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}),
                actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings, allowEnvironmentOverride: false }),
                machineActionDirectTargetTransport: { machineId: machine.id, invoke: async () => {
                    nativeEffects += 1;
                    throw new Error('Session native effect requires its separate approval');
                } },
                sessionSpawnDirectTargetTransport: { machineId: machine.id,
                    prepare: (request, options) => prepareSessionCreationTarget({ request, signal: options?.signal }),
                    spawnedSession: { spawn: async () => {
                        nativeEffects += 1;
                        throw new Error('Session runner requires its separate approval');
                    }, resolveSpawnSessionByNonce: async () => { throw new Error('No Session runner was submitted'); } },
                },
            });
        let handler: RpcHandler | undefined;
        const verify: Parameters<typeof registerExternalActionRpcHandler>[1]['verifyExecutionAuthorization'] = request =>
            verifyExternalActionExecutionAuthorizationCurrent({ ...request, privateKey: machine.keys.secretKey,
                installationId: machine.installationId, serverHttpBaseUrl: server.baseUrl });
        registerExternalActionRpcHandler({ registerHandler: (_method, receive) => { handler = receive; } }, {
            machineId: machine.id, currentServerId: server.homeId, currentServerHttpBaseUrl: server.baseUrl,
            resolveAccountId: async () => server.accountId, resolveInstallationId: () => machine.installationId,
            externalActionMachineRequestPrivateKey: machine.keys.secretKey, verifyExecutionAuthorization: verify,
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: server.baseUrl }),
            prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ ...request,
                purpose: { kind: 'external_action' }, machineId: machine.id, installationId: machine.installationId,
                installationPrivateKey: machine.keys.secretKey, serverId: server.homeId, serverIdentityId: server.homeId,
                serverHttpBaseUrl: server.baseUrl, ownCredentials: credentials,
                isCurrent: () => verify({ authorization: request.authorization, effectActionId: request.authorization.binding.actionId,
                    target: request.authorization.binding.target, ...(request.signal ? { signal: request.signal } : {}) }),
                createExecutor: executor,
            }), executor: executor(),
        });
        server.setReceiver(machine.id, async (packet, signal) => {
            if (!handler) throw new Error('prepare_receiver_required');
            delivered.push(packet.actionId);
            // Match the installed CLI executor's captured Home scope for all
            // Artifact/Settings transports, not the developer's active Home.
            const response = await runWithServerHttpBaseUrl(server.baseUrl, () => handler!(packet,
                { authorization: ACTION_API_SERVER_ORIGIN,
                    signal: signal ? AbortSignal.any([signal, receiverLifetime.signal]) : receiverLifetime.signal }));
            if (packet.actionId === 'session.spawn_new') {
                const parsed = parseExternalActionDaemonDispatchResult(response);
                if (parsed?.kind !== 'response' || !('execution' in parsed.prepared.response)) throw new Error('prepare_plain_child_response_required');
                childExecutions.push(parsed.prepared.response.execution);
            }
            return response;
        });
        const invoke = (person: boolean) => dispatchOriginalAccountAction({ actionId: 'deployments.prepare', input,
            requestId: randomUUID(), target: { kind: 'machine', machineId: machine.id }, credentials,
            serverHttpBaseUrl: server.baseUrl, serverIdentityId: server.homeId,
            authority: person ? 'present_user' : 'account_automation', invocation: { caller: { kind: 'host' },
                surface: person ? 'ui' : 'mcp', authority: person ? 'present_user' : 'account_automation' } });
        const pending = invoke(actor === 'person');
        const artifactId = await Promise.race([createdApproval, pending.then(result => {
            throw new Error(`prepare_settled_before_approval_${JSON.stringify({ result, delivered, childExecutions, authorizationResponses })}`);
        })]);
        const approval = await runWithServerHttpBaseUrl(server.baseUrl, () => approvalStore.approvalsGet({ artifactId }));
        if (!approval) {
            const stored = await runWithServerHttpBaseUrl(server.baseUrl, () => approvalStore.promptLibraryStore.read(artifactId));
            const parsed = typeof stored?.body === 'string' ? StoredApprovalRequestSchema.safeParse(JSON.parse(stored.body)) : null;
            throw new Error(JSON.stringify({ phase: 'prepare_approval_read', artifactReadable: Boolean(stored),
                schemaIssues: parsed && !parsed.success ? parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path })) : [],
                headerKeys: stored?.header ? Object.keys(stored.header) : [] }));
        }
        const prepareHeld = actor === 'agent' || actor === 'agentRejected';
        expect(approval).toMatchObject({ status: 'open', actionId: prepareHeld ? 'deployments.prepare' : 'session.spawn_new' });
        expect(delivered).toEqual(prepareHeld ? ['deployments.prepare'] : ['deployments.prepare', 'session.spawn_new']);
        expect(nativeEffects).toBe(0);
        if (actor === 'agentRejected') {
            // A real Account UI mint supplies the person's cause to the
            // installed receiver; a UI label on a CLI executor cannot do so.
            const decision = await dispatchOriginalAccountAction({ actionId: 'approval.request.decide',
                input: { artifactId, decision: 'reject' }, requestId: randomUUID(),
                target: { kind: 'machine', machineId: machine.id }, credentials,
                serverHttpBaseUrl: server.baseUrl, serverIdentityId: server.homeId,
                authority: 'present_user', invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' } });
            expect(decision, JSON.stringify({ decision, authorizationResponses })).toMatchObject({ ok: true });
            expect(await runWithServerHttpBaseUrl(server.baseUrl, () => approvalStore.approvalsGet({ artifactId })))
                .toMatchObject({ status: 'rejected', actionId: 'deployments.prepare' });
        }
        if (actor === 'agent') receiverLifetime.abort();
        const result = await pending;
        if (actor === 'agentRejected') {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
            expect(delivered).toEqual(['deployments.prepare', 'approval.request.decide']);
            expect(childExecutions).toEqual([]);
        } else if (actor !== 'agent') {
            const deferred = { ok: true, result: { kind: 'approval_request_created', artifactId, actionId: 'session.spawn_new' } };
            expect(childExecutions).toEqual([deferred]);
            expect(result, JSON.stringify({ result, childExecutions })).toEqual(deferred);
        } else {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect(childExecutions).toEqual([]);
        }
        if (actor === 'agentWaived') {
            receiverLifetime.abort();
            expect(await runWithServerHttpBaseUrl(server.baseUrl, () => approvalStore.approvalsGet({ artifactId })))
                .toMatchObject({ status: 'open', actionId: 'session.spawn_new' });
        }
        expect(nativeEffects).toBe(0);
    });

    it('keeps offline setup targets in public combined Plan without converting revoked authority into offline', async () => {
        const run = await fixture('exact', undefined, false, true);
        const initialPlan = await run.publicSetupPlan();
        expect(initialPlan, JSON.stringify(initialPlan)).toMatchObject({ ok: true, result: {
            targets: [run.first, run.second].map(machine => ({ homeId: run.server.homeId, machineId: machine.id,
                plan: { desiredRevision: 0 } })), review: { machineId: run.first.id },
        } });
        await run.server.setMachineOnline(run.second.id, false);
        expect(await run.publicSetupPlan()).toMatchObject({ ok: true, result: {
            targets: [
                { homeId: run.server.homeId, machineId: run.first.id, plan: { desiredRevision: 0 } },
                { homeId: run.server.homeId, machineId: run.second.id,
                    status: 'unavailable', reason: 'offline', errorCode: 'machine_offline' },
            ], review: { machineId: run.first.id },
        } });
        await run.server.setMachineOnline(run.first.id, false);
        expect(await run.publicSetupPlan()).toMatchObject({ ok: true, result: {
            targets: [run.first, run.second].map(machine => ({ homeId: run.server.homeId, machineId: machine.id,
                status: 'unavailable', reason: 'offline', errorCode: 'machine_offline' })),
            review: { machineId: null },
        } });
        await run.server.revokeAccount();
        const revoked = await run.publicSetupPlan();
        expect(revoked).toMatchObject({ ok: false });
        expect(revoked).not.toHaveProperty('result');
        expect(run.effects).toEqual([]);
        expect(run.delivered).toEqual([]);
    });
    it('retries only failed B through a fresh public setup Plan and Apply without replaying completed A', async () => {
        const run = await fixture('exact', undefined, false, true);
        const acceptedBefore = await run.readStoredSnapshot();
        const approvedBefore = acceptedBefore.approvedOperation;
        const failuresBefore = nativeBoundary.failedPtyStarts.length;
        const launchesBefore = nativeBoundary.launches.length;
        const disarmNativeSpawnFailure = run.failNativeStarts(run.second.id);
        const firstOutcome = await run.coordinateProduction();
        expect(firstOutcome.state, JSON.stringify({ state: firstOutcome.state,
            failedPtyStarts: nativeBoundary.failedPtyStarts.slice(failuresBefore),
            launchMachineIds: nativeBoundary.launches.slice(launchesBefore).map(launch => launch.machineId),
            effects: run.effects, receivingDiagnostics: await run.readReceivingDiagnostics() })).toBe('failed');
        expect(nativeBoundary.failedPtyStarts.slice(failuresBefore)).toEqual([run.second.id]);
        expect(run.effects).toEqual([{ machineId: run.first.id, presetRevision: 1 }]);
        const initial = await run.reconcileInvocations();
        expect(initial).toMatchObject([{ index: { lifecycle: 'completed' } }, { index: { lifecycle: 'failed' } }]);
        disarmNativeSpawnFailure();
        // Retry is a new public Action. Explicit Change retains this online
        // Workflow host; only B's fresh native Plan contributes effect operands.
        const planned = await run.publicSetupPlan([{ homeId: run.server.homeId,
            machineId: run.second.id, mode: 'effects' }], run.host.id);
        expect(planned, JSON.stringify(planned)).toMatchObject({ ok: true });
        if (!planned.ok) throw new Error(`fresh_setup_plan_${planned.errorCode}`);
        const review = MachineSetupCombinedPlanResultV1Schema.parse(planned.result);
        expect(review).toMatchObject({ targets: [{ homeId: run.server.homeId, machineId: run.second.id,
            plan: { desiredRevision: 0 } }], review: { machineId: run.host.id } });
        expect(review.targets).toHaveLength(1);
        const target = review.targets[0];
        if (!target || !('plan' in target) || !review.review.machineId) throw new Error('fresh_failed_target_plan_required');
        const freshInput: MachineSetupApplyInputV1 = { homeId: run.server.homeId, machineId: review.review.machineId,
            targets: [{ homeId: target.homeId, machineId: target.machineId,
                desiredRevision: target.plan.desiredRevision, sources: target.plan.sources,
                recipePlans: target.plan.recipePlans ?? [], exclusions: target.plan.exclusions,
                ...(target.plan.removeItemKeys === undefined ? {} : { removeItemKeys: target.plan.removeItemKeys }),
                ...(target.appChildren === undefined ? {} : { appChildren: target.appChildren }) }] };
        expect(run.effects).toEqual([{ machineId: run.first.id, presetRevision: 1 }]);
        const fresh = await run.publicSetupApply(freshInput);
        expect(fresh.runId).not.toBe(run.runId);
        const acceptedFresh = await run.readStoredSnapshot(fresh.runId);
        expect(acceptedFresh.approvedOperation).toMatchObject({
            parent: { actionId: 'machines.setup.apply', input: freshInput },
            steps: [{ actionId: 'machines.setup.apply', input: buildMachineSetupTargetApplyInput(freshInput.targets[0]!) }],
        });
        expect(acceptedFresh.approvedOperation?.steps).toHaveLength(1);
        expect(acceptedFresh.origin?.authenticatedStarterV1).toMatchObject({ requestRef: fresh.requestId });
        expect(acceptedFresh.origin?.authenticatedStarterV1?.requestRef)
            .not.toBe(acceptedBefore.origin?.authenticatedStarterV1?.requestRef);
        const freshClaim = await run.server.claim(run.host.id);
        expect(freshClaim.runId).toBe(fresh.runId);
        expect(await run.coordinateProduction(freshClaim)).toMatchObject({ state: 'succeeded' });
        expect(run.effects).toEqual([{ machineId: run.first.id, presetRevision: 1 }, { machineId: run.second.id, presetRevision: 1 }]);
        expect(run.effects).toHaveLength(2);
        expect(run.delivered.map(delivery => delivery.receiver)).toEqual([run.first.id, run.second.id, run.second.id]);
        expect(run.delivered.map(delivery => delivery.runId)).toEqual([run.runId, run.runId, fresh.runId]);
        expect((await run.readStoredSnapshot()).approvedOperation).toEqual(approvedBefore);
        expect(await run.storage.execute({ operation: 'get', runId: run.runId })).toMatchObject({ run: { state: 'failed' } });
        expect(await run.storage.execute({ operation: 'get', runId: fresh.runId })).toMatchObject({ run: { state: 'succeeded' } });
        expect(await run.publicSetupPlan([{ homeId: run.server.homeId, machineId: run.second.id }]))
            .toMatchObject({ ok: true, result: { targets: [{ machineId: run.second.id,
                plan: { desiredRevision: target.plan.desiredRevision, sources: target.plan.sources } }] } });
        expect(run.parentPrompts).toHaveLength(2);
        expect(run.prompts).toEqual([]);
    });
    it('runs one setup parent through exact full-list singleton children without replaying a completed target', async () => {
        const run = await fixture('second_reply_lost', undefined, false, true);
        const accepted = await run.readStoredSnapshot();
        expect(accepted.approvedOperation?.parent.actionId).toBe('machines.setup.apply');
        expect(accepted.approvedOperation?.steps).toHaveLength(2);
        expect(accepted.materializedLeaves.filter(leaf => leaf.kind === 'action').map(leaf => leaf.actionId))
            .toEqual(['machines.setup.apply', 'machines.setup.apply']);
        const outcome = await run.coordinate();
        if (run.effects.length !== 2) {
            const invocations = await run.reconcileInvocations();
            throw new Error(JSON.stringify({ phase: 'setup_native_children', state: outcome.state,
                delivered: run.delivered.length, refusals: run.receiverRefusals,
                receivingDiagnostics: await run.readReceivingDiagnostics(),
                children: invocations.map(({ index, progress }) => ({ lifecycle: index.lifecycle,
                    reason: progress.reason?.code })) }));
        }
        expect(run.effects).toEqual([{ machineId: run.first.id, presetRevision: 1 }, { machineId: run.second.id, presetRevision: 1 }]);
        await run.reconcileInvocations();
        await run.coordinate();
        expect(run.effects).toHaveLength(2);
        expect(run.parentPrompts).toHaveLength(1);
        expect(run.prompts).toEqual([]);
    });
    it('admits a replayed Publish with its stored permission mode instead of the deciding mode', async () => {
        const run = await fixture('retained_permission', undefined, true, false, true);
        expect(run.replayedPublishPermissionMode).toBe('default');
        expect(await run.readStoredSnapshot()).toMatchObject({
            approvedOperation: { parent: { actionId: 'deployments.publish' } },
        });
    });
    it('refuses a replayed Publish whose stored permission mode is missing with the Workflow code', async () => {
        await expect(fixture('missing_permission', undefined, true, false, true)).rejects.toMatchObject({ code: 'run_access_denied' });
    });
    it('runs setup A+B then its real prepared existing-Project app with one approval and no native replay', async () => {
        const flow = createDeploymentFlowCostObserver();
        cleanups.push(async () => { console.info('FLOWBUDGET_COUNTS', JSON.stringify(await flow.result('native-deploy'))); flow.dispose(); });
        const run = await fixture('exact', undefined, false, true, true, undefined, undefined, undefined, flow);
        if (!run.nativeApp) throw new Error('native_setup_app_required');
        flow.observeNativeCommands(() => run.nativeApp!.docker.readInvocations());
        const accepted = await run.readStoredSnapshot();
        expect(accepted.approvedOperation?.parent.actionId).toBe('machines.setup.apply');
        expect(accepted.materializedLeaves.filter(leaf => leaf.kind === 'action').map(leaf => leaf.actionId))
            .toEqual(['machines.setup.apply', 'machines.setup.apply', 'deployments.deploy']);
        flow.setPhase('execute');
        const outcome = await run.coordinate();
        if (run.effects.length !== 2) {
            const invocations = await run.reconcileInvocations();
            throw new Error(JSON.stringify({ phase: 'setup_native_children_before_app', state: outcome.state,
                delivered: run.delivered.length, refusals: run.receiverRefusals,
                receivingDiagnostics: await run.readReceivingDiagnostics(),
                children: invocations.map(({ index, progress }) => ({ lifecycle: index.lifecycle,
                    reason: progress.reason?.code })) }));
        }
        expect(run.effects).toEqual([{ machineId: run.first.id, presetRevision: 1 }, { machineId: run.second.id, presetRevision: 1 }]);
        const readReceipt = async () => {
            const response = await fetch(`${run.server.baseUrl}/v1/deployments/environments/${run.nativeApp!.environmentId}/deployments?serverId=${run.server.homeId}`,
                { headers: { Authorization: `Bearer ${run.server.token}` } });
            expect(response.status).toBe(200);
            const listed = DeploymentActionOutputSchemasV1['deployments.receipts.list'].parse(await response.json());
            if (!listed.ok) throw new Error(listed.error);
            return listed.items;
        };
        flow.setPhase('settle');
        const receipts = await readReceipt();
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ state: 'succeeded' });
        const activations = () => run.nativeApp!.docker.readInvocations().then(calls => calls.filter(call => call.args.includes('up')));
        expect(await activations()).toHaveLength(1);
        flow.setPhase('replay');
        await run.coordinate();
        expect(await activations()).toHaveLength(1);
        expect(await readReceipt()).toEqual(receipts);
        expect(run.effects).toHaveLength(2);
        expect(run.parentPrompts).toHaveLength(1);
        expect(run.prompts).toEqual([]);

        await flow.captureNativeCommands();
        flow.assertShape();
        flow.setPhase('neighbor');

        // A new reviewed native change consumes the native writer's actual
        // correspondence and the stored Run's current completed invocation.
        // The authored app stays in its certified source; it has no new leaf.
        const current = await run.publicSetupPlan();
        expect(current, JSON.stringify(current)).toMatchObject({ ok: true });
        if (!current.ok) throw new Error('current_setup_plan_required');
        const currentPlan = MachineSetupCombinedPlanResultV1Schema.parse(current.result);
        const first = currentPlan.targets.find(target => target.machineId === run.first.id);
        if (!first || !('plan' in first)) throw new Error('current_first_setup_plan_required');
        const sources = first.plan.sources.map(source => source.kind === 'direct'
            ? { ...source, setup: { ...source.setup, scripts: [{ body: 'echo changed-native-setup', affects: 'none' as const }] } }
            : source);
        const updated = await run.publicSetupPlan([{ homeId: run.server.homeId, machineId: run.first.id,
            sources, removeItemKeys: [], appChildren: [], mode: 'effects' }]);
        expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true });
        if (!updated.ok) throw new Error('changed_native_setup_plan_required');
        const result = MachineSetupCombinedPlanResultV1Schema.parse(updated.result);
        const target = result.targets[0];
        if (!target || !('plan' in target)) throw new Error('changed_native_target_plan_required');
        expect(target.plan.sources).toEqual(sources);
        expect(target.plan.sources[0]?.setup.items).toEqual([run.nativeApp.item]);
        expect(target.plan.sources.find(source => source.kind === 'direct')?.setup.scripts)
            .toContainEqual({ body: 'echo changed-native-setup', affects: 'none' });
        expect(target.plan.review?.apps).toEqual([{ sourceIndex: 0, itemIndex: 0,
            kind: 'completed', environmentId: run.nativeApp.environmentId }]);
        expect(target.appChildren ?? []).toEqual([]);
        const reviewed: MachineSetupApplyInputV1 = { homeId: run.server.homeId, machineId: run.host.id,
            targets: [{ homeId: run.server.homeId, machineId: run.first.id,
                desiredRevision: target.plan.desiredRevision, sources: target.plan.sources,
                recipePlans: target.plan.recipePlans ?? [], exclusions: target.plan.exclusions,
                removeItemKeys: target.plan.removeItemKeys, appChildren: [] }] };
        const prepared = await run.publicSetupPreparation(reviewed);
        expect(prepared, JSON.stringify(prepared)).not.toHaveProperty('errorCode');
        if ('errorCode' in prepared) throw new Error(prepared.errorCode);
        expect(prepared.input).toEqual(reviewed);
        expect(buildMachineSetupWorkflow(prepared.input).blocks.map(block => block.kind === 'action' ? block.actionId : block.kind))
            .toEqual(['machines.setup.apply']);
        expect(await activations()).toHaveLength(1);
        expect(await readReceipt()).toEqual(receipts);
    });
    it.each(['plain', 'e2ee'] as const)('deploys one literal catalog app after setup A+B and keeps it running on Update (%s)', async mode => {
        // Observe only the canonical sanitized parser failure. Native execution
        // and every internal owner remain real; rejected content is not logged.
        const nativeOutputValidation = vi.spyOn(deploymentOutputValidation, 'deploymentOutputValidationFailure');
        cleanups.push(async () => { nativeOutputValidation.mockRestore(); });
        const rejectedHeaderMeasurements: { status: number; headers: { name: string; bytes: number }[] }[] = [];
        let largestChildHeaders: { status: number; headers: { name: string; bytes: number }[] } | undefined;
        const headerObservation = axios.interceptors.response.use(response => {
            const measurement = { status: response.status,
                headers: Object.entries(response.config.headers.toJSON()).map(([name, value]) => ({
                    name, bytes: Buffer.byteLength(String(value)),
                })) };
            if (response.status === 431) rejectedHeaderMeasurements.push(measurement);
            if (measurement.headers.some(header => header.name === 'x-happier-action-deployment-child')
                && (!largestChildHeaders || measurement.headers.reduce((size, header) => size + header.bytes, 0)
                    > largestChildHeaders.headers.reduce((size, header) => size + header.bytes, 0))) largestChildHeaders = measurement;
            return response;
        });
        cleanups.push(async () => { axios.interceptors.response.eject(headerObservation); });
        const run = await fixture('exact', undefined, false, true, false, undefined, undefined, mode);
        const app = run.nativeApp;
        if (!app || app.child.actionId !== 'deployments.templates.instantiate') throw new Error('catalog_setup_app_required');
        expect(run.server.currentness.mode).toBe(mode);
        const readSetupApprovalActions = async () => {
            const queue = await run.readApprovalRequests();
            expect(queue.nextCursor).toBeNull();
            return queue.items.filter(item => item.actionId === 'machines.setup.apply'
                || item.actionId === 'deployments.templates.instantiate' || item.actionId === 'deployments.deploy')
                .map(item => item.actionId);
        };
        const headers = { Authorization: `Bearer ${run.server.token}` };
        const readEnvironments = async () => {
            const response = await fetch(`${run.server.baseUrl}/v1/deployments/environments?serverId=${run.server.homeId}&projectSourceId=${app.projectSourceId}`, { headers });
            expect(response.status).toBe(200);
            const listed = DeploymentActionOutputSchemasV1['deployments.environments.list'].parse(await response.json());
            if (!listed.ok) throw new Error(listed.error);
            return listed.items;
        };
        const activations = () => app.docker.readInvocations().then(calls => calls.filter(call => call.args.includes('up')));
        // Parent Plan/approval may read the catalog, but creates no Environment
        // or native deployment. The literal leaf owns both after native setup.
        expect(await readEnvironments()).toEqual([]);
        expect(await activations()).toEqual([]);
        expect(run.effects).toEqual([]);
        expect(run.parentPrompts).toHaveLength(1);
        expect(await readSetupApprovalActions()).toEqual(['machines.setup.apply']);
        const accepted = await run.readStoredSnapshot();
        const leaves = accepted.materializedLeaves.filter(leaf => leaf.kind === 'action');
        expect(leaves.map(leaf => leaf.actionId))
            .toEqual(['machines.setup.apply', 'machines.setup.apply', 'deployments.templates.instantiate']);
        expect(accepted.approvedOperation?.steps.map(step => step.actionId))
            .toEqual(['machines.setup.apply', 'machines.setup.apply', 'deployments.templates.instantiate']);
        expect(leaves[2]).toMatchObject({ actionInput: app.child.input });
        expect(accepted.definition.blocks[2]).toMatchObject({ kind: 'action', actionId: 'deployments.templates.instantiate',
            input: Object.fromEntries(Object.entries(app.child.input).map(([key, value]) => [key, { kind: 'literal', value }])) });
        const outcome = await run.coordinateProduction();
        const invocations = await run.reconcileInvocations();
        const nativeFailures = nativeOutputValidation.mock.results.flatMap(result => result.type === 'return' ? [result.value] : []);
        expect(outcome.state, JSON.stringify({ state: outcome.state, refusals: run.receiverRefusals,
            nativeFailures, rejectedHeaderMeasurements,
            approvals: (await run.readApprovalRequests()).items.map(item => ({ actionId: item.actionId, status: item.status })),
            catalogExecution: run.readCatalogExecutionDiagnostics(),
            receivingDiagnostics: await run.readReceivingDiagnostics(),
            children: invocations.map(({ index, progress }) => ({ lifecycle: index.lifecycle, reason: progress.reason?.code })) }))
            .toBe('succeeded');
        expect(run.effects).toEqual([{ machineId: run.first.id, presetRevision: 1 }, { machineId: run.second.id, presetRevision: 1 }]);
        expect(run.prompts).toEqual([]);
        const template = invocations.find(row => row.progress.execution?.kind === 'action'
            && row.progress.execution.actionId === 'deployments.templates.instantiate');
        expect(template?.index.lifecycle).toBe('completed');
        const result = DeploymentTemplateInstantiateResultV1Schema.parse(template?.progress.result);
        if (result.kind !== 'applied' || !result.deployment || !('deploymentId' in result.deployment))
            throw new Error('catalog_normal_deployment_receipt_required');
        expect(result.deployment).toMatchObject({ environmentId: result.environmentId, state: 'succeeded' });
        const environments = await readEnvironments();
        expect(environments).toHaveLength(1);
        expect(environments[0]).toMatchObject({ id: result.environmentId, runtimeTargetLinkId: result.targetLinkId });
        const receipts = await run.server.readDeploymentEffects(result.environmentId);
        expect(receipts).toMatchObject([{ id: result.deployment.deploymentId, state: 'succeeded' }]);
        expect(receipts).toHaveLength(1);
        expect(rejectedHeaderMeasurements).toEqual([]);
        expect(largestChildHeaders?.status).toBe(200);
        console.info('deployment-child HTTP header sizes', JSON.stringify({ mode, ...largestChildHeaders }));
        expect(await activations()).toHaveLength(1);
        expect(await readSetupApprovalActions()).toEqual(['machines.setup.apply']);

        // Update changes only native setup. DF reads the actual composite
        // outcome; the catalog item stays authored while its leaf disappears.
        const current = await run.publicSetupPlan([{ homeId: run.server.homeId, machineId: run.first.id }], run.host.id);
        expect(current, JSON.stringify(current)).toMatchObject({ ok: true });
        if (!current.ok) throw new Error('catalog_current_setup_plan_required');
        const currentTarget = MachineSetupCombinedPlanResultV1Schema.parse(current.result).targets[0];
        if (!currentTarget || !('plan' in currentTarget)) throw new Error('catalog_current_target_plan_required');
        const sources = currentTarget.plan.sources.map(source => source.kind === 'direct'
            ? { ...source, setup: { ...source.setup, scripts: [{ body: 'echo updated-catalog-native-setup', affects: 'none' as const }] } }
            : source);
        const changed = await run.publicSetupPlan([{ homeId: run.server.homeId, machineId: run.first.id,
            sources, removeItemKeys: [], appChildren: [], mode: 'effects' }], run.host.id);
        expect(changed, JSON.stringify(changed)).toMatchObject({ ok: true });
        if (!changed.ok) throw new Error('catalog_update_plan_required');
        const target = MachineSetupCombinedPlanResultV1Schema.parse(changed.result).targets[0];
        if (!target || !('plan' in target)) throw new Error('catalog_update_target_plan_required');
        expect(target.plan.sources).toEqual(sources);
        expect(target.plan.sources[0]?.setup.items).toEqual([app.item]);
        expect(target.plan.review?.apps).toEqual([{ sourceIndex: 0, itemIndex: 0,
            kind: 'completed', environmentId: result.environmentId }]);
        expect(target.appChildren ?? []).toEqual([]);
        const input: MachineSetupApplyInputV1 = { homeId: run.server.homeId, machineId: run.host.id,
            targets: [{ homeId: target.homeId, machineId: target.machineId, desiredRevision: target.plan.desiredRevision,
                sources: target.plan.sources, recipePlans: target.plan.recipePlans ?? [], exclusions: target.plan.exclusions,
                removeItemKeys: target.plan.removeItemKeys, appChildren: [] }] };
        const fresh = await run.publicSetupApply(input);
        expect((await run.readStoredSnapshot(fresh.runId)).materializedLeaves.filter(leaf => leaf.kind === 'action')
            .map(leaf => leaf.actionId)).toEqual(['machines.setup.apply']);
        const claim = await run.server.claim(run.host.id);
        expect(claim.runId).toBe(fresh.runId);
        expect(await run.coordinateProduction(claim)).toMatchObject({ state: 'succeeded' });
        expect(await readEnvironments()).toEqual(environments);
        expect(await run.server.readDeploymentEffects(result.environmentId)).toEqual(receipts);
        expect(await activations()).toHaveLength(1);
        expect(run.effects.filter(effect => effect.machineId === run.second.id)).toHaveLength(1);
        expect(run.parentPrompts).toHaveLength(2);
        expect(run.prompts).toEqual([]);
        expect(await readSetupApprovalActions()).toEqual(['machines.setup.apply', 'machines.setup.apply']);
    });
    it('retains the admitted CRLF source after editing its plain Preset and reapplies the saved copy', async () => {
        const run = await fixture('exact', undefined, false, true);
        expect(run.server.currentness.mode).toBe('plain');
        expect(await run.coordinateProduction()).toMatchObject({ state: 'succeeded' });
        const mutatePreset = async <Id extends 'machines.presets.create' | 'machines.presets.update'>(
            actionId: Id, input: MachinePresetActionInputV1<Id>,
        ) => {
            const response = await fetch(`${run.server.baseUrl}${machinePresetActionEndpointPathV1(actionId)}`, {
                method: 'POST', headers: { Authorization: `Bearer ${run.server.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(MachinePresetActionInputSchemasV1[actionId].parse(input)),
            });
            expect(response.status).toBe(200);
            return MachinePresetActionOutputSchemasV1[actionId].parse(await response.json());
        };
        const originalBody = '\r\necho retained-plain-source\r\n';
        const editedBody = '\r\necho edited-preset-source\r\n';
        const created = await mutatePreset('machines.presets.create', {
            id: randomUUID(), homeId: run.server.homeId, name: 'Retained CRLF source',
            owner: { kind: 'account', accountId: run.server.accountId },
            setup: { scripts: [{ body: originalBody, affects: 'none' }] },
        });
        if (created.kind !== 'saved' || !created.preset.setup) throw new Error('plain_setup_preset_required');
        const sources: NonNullable<MachineSetupCombinedPlanInputV1['targets'][number]['sources']> = [{
            kind: 'accountPreset', presetId: created.preset.id, presetRevision: created.preset.revision,
            setup: created.preset.setup,
        }, { kind: 'direct', setup: {} }];
        const applyCopies = async (copies: typeof sources) => {
            const planned = await run.publicSetupPlan([{ homeId: run.server.homeId, machineId: run.first.id,
                sources: copies, mode: 'effects' }], run.host.id);
            expect(planned, JSON.stringify(planned)).toMatchObject({ ok: true });
            if (!planned.ok) throw new Error('plain_retained_plan_required');
            const target = MachineSetupCombinedPlanResultV1Schema.parse(planned.result).targets[0];
            if (!target || !('plan' in target)) throw new Error('plain_retained_target_required');
            expect(target.plan.sources).toEqual(copies);
            const input: MachineSetupApplyInputV1 = { homeId: run.server.homeId, machineId: run.host.id,
                targets: [{ homeId: target.homeId, machineId: target.machineId,
                    desiredRevision: target.plan.desiredRevision, sources: target.plan.sources,
                    recipePlans: target.plan.recipePlans ?? [],
                    appChildren: [] }] };
            const launchedBefore = nativeBoundary.launches.length;
            const applied = await run.publicSetupApply(input);
            const snapshot = await run.readStoredSnapshot(applied.runId);
            expect(snapshot.approvedOperation?.parent).toMatchObject({ actionId: 'machines.setup.apply', input });
            const claim = await run.server.claim(run.host.id);
            expect(claim.runId).toBe(applied.runId);
            expect(await run.coordinateProduction(claim)).toMatchObject({ state: 'succeeded' });
            // The PTY is an OS boundary; the real Plan, approval, server,
            // retained snapshot and native setup owners determine these bytes.
            expect(nativeBoundary.launches.slice(launchedBefore).filter(launch => launch.machineId === run.first.id)
                .map(launch => launch.args.at(-1))).toEqual([originalBody]);
            return applied;
        };
        const first = await applyCopies(sources);
        const edited = await mutatePreset('machines.presets.update', {
            homeId: run.server.homeId, id: created.preset.id, expectedRevision: created.preset.revision,
            patch: { setup: { scripts: [{ body: editedBody, affects: 'none' }] } },
        });
        if (edited.kind !== 'saved') throw new Error('plain_preset_edit_required');
        expect(edited.preset.revision).toBeGreaterThan(created.preset.revision);
        expect(edited.preset.setup?.scripts?.[0]?.body).toBe(editedBody);
        const current = await run.publicSetupPlan([{ homeId: run.server.homeId, machineId: run.first.id }], run.host.id);
        if (!current.ok) throw new Error('plain_retained_current_plan_required');
        const target = MachineSetupCombinedPlanResultV1Schema.parse(current.result).targets[0];
        if (!target || !('plan' in target)) throw new Error('plain_retained_current_target_required');
        expect(target.plan.sources).toEqual(sources);
        const second = await applyCopies(target.plan.sources);
        expect(second.runId).not.toBe(first.runId);
        expect(run.prompts).toEqual([]);
    });
    it.each(['owner', 'non_deployer'] as const)('enforces real server deployment admission for the reviewed Publish caller (%s)', async caller => {
        const run = await fixture('exact', undefined, true, false, false, undefined, caller);
        if (!run.nativeApp?.environmentId || !run.publishFixture) throw new Error('prepared_publish_admission_fixture_required');
        const accepted = await run.readStoredSnapshot();
        expect(accepted.approvedOperation?.parent.actionId).toBe('deployments.publish');
        expect(accepted.materializedLeaves.filter(leaf => leaf.kind === 'action').map(leaf => leaf.actionId))
            .toEqual(['deployments.deploy']);
        expect(await run.server.readDeploymentEffects(run.nativeApp.environmentId)).toEqual([]);
        const preparationCalls = run.readDeploymentPreparationCalls();
        expect(preparationCalls).toBe(1);
        if (caller === 'non_deployer') await run.server.demoteDeploymentCaller();
        const environment = await fetch(`${run.server.baseUrl}/v1/deployments/environments/${run.nativeApp.environmentId}?serverId=${run.server.homeId}`,
            { headers: { Authorization: `Bearer ${run.server.token}` } });
        expect(environment.status).toBe(200);
        const spec = getActionSpec('deployments.deploy');
        if (!spec.serverTransport) throw new Error('deployment_server_transport_required');
        const admissionRequest = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
            inputSchema: spec.inputSchema, input: run.publishFixture.input.preparedChildren.deploy });
        const deploymentResponses: Array<{ status: number; data: unknown }> = [];
        const previousAdapter = axios.defaults.adapter;
        const transport = axios.getAdapter(previousAdapter);
        axios.defaults.adapter = async request => {
            const response = await transport(request);
            if (new URL(request.url!, request.baseURL).pathname === admissionRequest.path
                && request.method?.toUpperCase() === admissionRequest.method.toUpperCase()) {
                deploymentResponses.push({ status: response.status, data: response.data });
            }
            return response;
        };
        cleanups.push(async () => { axios.defaults.adapter = previousAdapter; });
        const outcome = await Promise.race([run.coordinate(), run.held.then(() => ({ state: 'unexpected_child_approval' as const }))]);
        // The adapter observes serialized HTTP bytes before Axios transforms
        // them. Assert after delivery so the observer cannot change its outcome.
        const deploymentReplies = deploymentResponses.map(response => {
            const body: unknown = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
            const result = DeploymentActionOutputSchemasV1['deployments.deploy'].parse(body);
            return { status: response.status, ok: result.ok,
                ...(!result.ok ? { error: result.error } : 'deploymentId' in result ? { deploymentId: result.deploymentId } : {}) };
        });
        expect(outcome.state).not.toBe('succeeded');
        expect(outcome.state).not.toBe('unexpected_child_approval');
        const effects = await run.server.readDeploymentEffects(run.nativeApp.environmentId);
        if (deploymentReplies.length === 0) {
            const invocations = await run.reconcileInvocations();
            throw new Error(JSON.stringify({ phase: 'publish_deployment_admission', state: outcome.state,
                receiverRefusals: run.receiverRefusals, receivingDiagnostics: await run.readReceivingDiagnostics(),
                children: invocations.map(({ index, progress }) => ({ lifecycle: index.lifecycle,
                    reason: progress.reason?.code })) }));
        }
        if (caller === 'owner') {
            expect(effects).toMatchObject([{ requestedByAccountId: run.server.accountId,
                contentArtifactId: run.publishFixture.input.preparedChildren.deploy.contentArtifactId }]);
            expect(effects).toHaveLength(1);
            expect(deploymentReplies).toEqual([{ status: 200, ok: true, deploymentId: effects[0]!.id }]);
            expect(run.nativeReceiptAdmissions).toMatchObject([{ deploymentId: effects[0]!.id }]);
        } else {
            expect(deploymentReplies).toEqual([{ status: 403, ok: false, error: 'deployment_access_denied' }]);
            expect(effects).toEqual([]);
            expect(run.nativeReceiptAdmissions).toEqual([]);
        }
        expect(run.parentPrompts).toHaveLength(1);
        expect(run.prompts).toEqual([]);
        expect(run.readDeploymentPreparationCalls()).toBe(preparationCalls);
        expect((await run.nativeApp.docker.readInvocations()).filter(call => call.args.includes('up'))).toEqual([]);
    });
    it('runs one registered signed Publish parent through setup A+B before the deployment child authority boundary', async () => {
        const run = await fixture('exact', undefined, true);
        const accepted = await run.readStoredSnapshot();
        expect(accepted.approvedOperation?.parent.actionId).toBe('deployments.publish');
        expect(accepted.materializedLeaves.filter(leaf => leaf.kind === 'action').map(leaf => leaf.actionId))
            .toEqual(['machines.setup.apply', 'machines.setup.apply', 'deployments.deploy']);
        const outcome = await run.coordinate();
        expect(run.effects).toEqual([{ machineId: run.first.id, presetRevision: 1 }, { machineId: run.second.id, presetRevision: 1 }]);
        expect(run.parentPrompts).toHaveLength(1);
        expect(run.prompts).toEqual([]);
        // Native deployment is deliberately not simulated. This fixture must
        // identify its actual first refusal before attributing it to an owner.
        expect(outcome.state).not.toBe('succeeded');
        const invocations = await run.reconcileInvocations();
        expect(invocations).toMatchObject([
            { index: { lifecycle: 'completed' }, progress: { execution: { actionId: 'machines.setup.apply' } } },
            { index: { lifecycle: 'completed' }, progress: { execution: { actionId: 'machines.setup.apply' } } },
            { progress: { invocationPath: { blockId: 'deploy' }, reason: { code: 'deployment_unavailable' } } },
        ]);
        expect(invocations[2]?.progress).not.toHaveProperty('execution');
    });
    it('completes one registered signed Publish parent with a real native deployment receipt and no replay', async () => {
        const flow = createDeploymentFlowCostObserver();
        cleanups.push(async () => { console.info('FLOWBUDGET_COUNTS', JSON.stringify(await flow.result('publish'))); flow.dispose(); });
        const run = await fixture('exact', undefined, true, false, true, undefined, undefined, undefined, flow);
        flow.assertPublishPreparationReads();
        if (!run.nativeApp) throw new Error('native_publish_required');
        flow.observeNativeCommands(() => run.nativeApp!.docker.readInvocations());
        const accepted = await run.readStoredSnapshot();
        expect(accepted.approvedOperation?.parent.actionId).toBe('deployments.publish');
        // A second child prompt violates the one reviewed parent contract.
        // Observe that real event instead of waiting for the case deadline.
        flow.setPhase('execute');
        const outcome = await Promise.race([
            run.coordinate(),
            run.held.then(() => ({ state: 'unexpected_child_approval' as const })),
        ]);
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ state: 'succeeded' });
        flow.setPhase('settle');
        const response = await fetch(`${run.server.baseUrl}/v1/deployments/environments/${run.nativeApp.environmentId}/deployments?serverId=${run.server.homeId}`,
            { headers: { Authorization: `Bearer ${run.server.token}` } });
        expect(response.status).toBe(200);
        const receipts = DeploymentActionOutputSchemasV1['deployments.receipts.list'].parse(await response.json());
        expect(receipts).toMatchObject({ ok: true, items: [{ state: 'succeeded' }] });
        if (!receipts.ok) throw new Error(receipts.error);
        expect(receipts.items).toHaveLength(1);
        const activations = () => run.nativeApp!.docker.readInvocations().then(calls => calls.filter(call => call.args.includes('up')));
        expect(await activations()).toHaveLength(1);
        flow.setPhase('replay');
        expect(await run.coordinate()).toMatchObject({ state: 'succeeded' });
        expect(await activations()).toHaveLength(1);
        expect(run.effects).toHaveLength(2);
        expect(run.parentPrompts).toHaveLength(1);
        expect(run.prompts).toEqual([]);
        await flow.captureNativeCommands();
        flow.assertShape();
    });
    it('reviews one full-target setup Action before dispatching any Machine child', async () => {
        const server = await startServer();
        cleanups.push(server.close);
        const [host, first, second] = server.machines;
        if (!host || !first || !second) throw new Error('three_enrolled_machines_required');
        const credentials = { token: server.token, encryption: null };
        const approvals = createCliApprovalsArtifactStore({ credentials, serverId: 'test-profile',
            serverHttpBaseUrl: server.baseUrl, getAccountEncryptionMode: async () => 'plain' });
        const requested: unknown[] = [];
        const delivered: unknown[] = [];
        for (const machine of [first, second]) server.setReceiver(machine.id, async request => {
            delivered.push(request);
            throw new Error('setup_child_dispatched_before_parent_confirmation');
        });
        const executor = createActionExecutor({
            ...createCliActionDeps({ token: server.token, credentials, sessionId: '', mode: 'plain', ctx: null,
                serverId: 'test-profile', serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl,
                externalActionMachineInstallationId: host.installationId,
                externalActionMachineRequestPrivateKey: host.keys.secretKey }),
            approvalsCreate: async args => {
                requested.push(args.request);
                return runWithServerHttpBaseUrl(server.baseUrl, () => approvals.approvalsCreate(args));
            },
        });
        const input = { homeId: server.homeId, machineId: host.id,
            targets: [first, second].map(machine => ({ homeId: server.homeId, machineId: machine.id,
                sources: [{ kind: 'direct', setup: {}}], desiredRevision: 0, recipePlans: [] })) };
        const result = await executor.execute('machines.setup.apply', input, {
            surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
            actionRequestId: randomUUID(), defaultSessionMachineId: host.id,
            serverId: 'test-profile', serverIdentityId: server.homeId, runtimeAccountId: server.accountId,
            callerPermissionMode: 'default', actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
                'machines.setup.apply': { approvalRequiredSurfaces: ['cli'] },
            } }),
        });
        if (!result.ok) throw new Error(`combined_setup_review_${result.errorCode}`);
        expect(result).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
        if (!result.ok || !result.result || typeof result.result !== 'object'
            || !('artifactId' in result.result) || typeof result.result.artifactId !== 'string') throw new Error('combined_setup_approval_not_created');
        const artifactId = result.result.artifactId;
        expect(requested).toHaveLength(1);
        const stored = await runWithServerHttpBaseUrl(server.baseUrl,
            () => approvals.approvalsGet({ artifactId }));
        expect(stored).toMatchObject({ status: 'open', actionId: 'machines.setup.apply', actionArgs: input });
        expect(delivered).toEqual([]);
    });

    it('resolves Publish host defaults from an authenticated persisted personal Project Environment without conflating Machine roles', async () => {
        const server = await startServer();
        cleanups.push(server.close);
        const [builder, controller, runtime] = server.machines;
        if (!builder || !controller || !runtime) throw new Error('three_enrolled_machines_required');
        const environments = await createPersistedPublishEnvironment(server, { builder, controller, runtime });
        const machines = await server.readMachines();
        // This consumes actual Environment reads at the host resolver boundary.
        // It exercises the host dependency independently of the Publish composer.
        const selection = { actionId: 'deployments.publish' as const, machines,
            projectEnvironmentControllerMachineIds: environments.map(environment => environment.controllerMachineId) };
        const suggested = resolveCombinedActionWorkflowHostV1(selection);
        expect(suggested).toMatchObject({ kind: 'ready', machineId: controller.id,
            review: { machineId: controller.id, machines } });
        expect(resolveCombinedActionWorkflowHostV1({ ...selection, selectedMachineId: runtime.id }))
            .toMatchObject({ kind: 'ready', machineId: runtime.id, review: { machineId: runtime.id } });
        expect(resolveCombinedActionWorkflowHostV1({ ...selection, agentMachineId: builder.id }))
            .toMatchObject({ kind: 'ready', machineId: builder.id });
        expect(resolveCombinedActionWorkflowHostV1({ ...selection, agentMachineId: builder.id, selectedMachineId: runtime.id }))
            .toMatchObject({ kind: 'ready', machineId: runtime.id });
        expect(resolveCombinedActionWorkflowHostV1({ actionId: 'deployments.publish', machines }))
            .toMatchObject({ kind: 'selection_required', review: { machineId: null, machines } });
        expect(resolveCombinedActionWorkflowHostV1({ actionId: 'deployments.publish', machines: [] }))
            .toEqual({ kind: 'platform_only', review: { machineId: null, machines: [] } });
        const excludingCreated = resolveCombinedActionWorkflowHostV1({ ...selection, createdMachineIds: [controller.id] });
        expect(excludingCreated).toMatchObject({ kind: 'selection_required', review: { machineId: null } });
        expect(excludingCreated.review.machines.map(machine => machine.machineId)).not.toContain(controller.id);
        expect(resolveCombinedActionWorkflowHostV1({ ...selection, selectedMachineId: runtime.id, createdMachineIds: [runtime.id] }))
            .toMatchObject({ kind: 'unavailable', code: 'machine_unavailable', machineId: runtime.id, role: 'controller' });
        await server.setMachineOnline(controller.id, false);
        const freshMachines = await server.readMachines();
        expect(resolveCombinedActionWorkflowHostV1({ ...selection, machines: freshMachines }))
            .toMatchObject({ kind: 'unavailable', code: 'machine_unavailable', machineId: controller.id, role: 'controller' });
        await server.setMachineOnline(runtime.id, false);
        expect(resolveCombinedActionWorkflowHostV1({ ...selection, machines: await server.readMachines(), selectedMachineId: runtime.id }))
            .toMatchObject({ kind: 'unavailable', code: 'machine_unavailable', machineId: runtime.id, role: 'controller' });
        expect(admitCombinedActionWorkflowHostV1({ machineId: controller.id, machines: freshMachines }))
            .toEqual({ kind: 'unavailable', code: 'machine_unavailable', machineId: controller.id, role: 'controller' });
        // Starting the selected existing Machine repairs this host; choosing
        // another is explicit and never rewrites the Environment controller.
        await server.setMachineOnline(controller.id, true);
        expect(admitCombinedActionWorkflowHostV1({ machineId: controller.id, machines: await server.readMachines() }))
            .toEqual({ kind: 'ready', machineId: controller.id });
        expect(environments[0]?.controllerMachineId).toBe(controller.id);
    });

    it.each(['environment', 'person', 'agent'] as const)('uses the Publish %s host for one signed approval reaching both child Machines without replay', async choice => {
        const run = await fixture('exact', choice);
        const expectedHost = choice === 'environment' ? run.environmentController : choice === 'person' ? run.personChoice : run.agentMachine;
        expect(run.selection).toMatchObject({ kind: 'ready', machineId: expectedHost.id, review: { machineId: expectedHost.id } });
        const accepted = await run.readStoredSnapshot();
        expect(accepted).toMatchObject({ machineId: expectedHost.id,
            workspaceTarget: { project: { machineId: expectedHost.id } },
            approvedOperation: { steps: [
                { input: { machineId: run.first.id, targets: [{ sources: reviewedSetupSources() }] } },
                { input: { machineId: run.second.id, targets: [{ sources: reviewedSetupSources() }] } },
            ] } });
        expect(run.host.id).not.toBe(run.first.id);
        expect(run.host.id).not.toBe(run.second.id);
        expect(await run.coordinate()).toMatchObject({ state: 'succeeded' });
        expect(run.effects).toEqual([{ machineId: run.first.id, presetRevision: 1 }, { machineId: run.second.id, presetRevision: 1 }]);
        expect(run.prompts).toEqual([]);
        expect(run.parentPrompts).toHaveLength(1);
        expect(run.delivered).toEqual([
            { publisher: run.host.id, receiver: run.first.id, runId: run.runId },
            { publisher: run.host.id, receiver: run.second.id, runId: run.runId },
        ]);
        expect(await run.coordinate()).toMatchObject({ state: 'succeeded' });
        expect(run.effects).toHaveLength(2);
        expect(run.prompts).toEqual([]);
    });

    it('holds changed materialized child input for renewed review before signed dispatch', async () => {
        const run = await fixture('exact', 'environment');
        const accepted = await run.readStoredSnapshot();
        // Model a child operand changing after the reviewed snapshot. The real
        // coordinator resolves it; the stored approval remains the original.
        const changed: WorkflowAcceptedSnapshotV1 = { ...accepted, definition: { ...accepted.definition,
            blocks: accepted.definition.blocks.map((block, index) => index === 1 && block.kind === 'action'
                ? { ...block, input: { ...block.input, targets: { kind: 'literal', value: [{
                    homeId: run.server.homeId, machineId: run.second.id, desiredRevision: 0,
                    recipePlans: [], sources: reviewedSetupSources(2),
                }] } } } : block),
        } };
        const pending = run.coordinate(changed);
        const artifactId = await Promise.race([run.held, pending.then(outcome => {
            throw new Error(`changed_input_settled_without_hold_${outcome.state}_${run.receiverRefusals.join(',')}`);
        })]);
        expect(await run.approvalsGet({ artifactId })).toMatchObject({ status: 'open', actionId: 'machines.setup.apply',
            actionArgs: { machineId: run.second.id, targets: [{ sources: reviewedSetupSources(2) }] } });
        expect(run.approvalCoordinator.getLiveWaiterCount(artifactId)).toBe(1);
        expect(run.parentPrompts).toHaveLength(1);
        expect(run.prompts).toHaveLength(1);
        expect(run.delivered).toEqual([{ publisher: run.host.id, receiver: run.first.id, runId: run.runId }]);
        expect(run.effects).toEqual([{ machineId: run.first.id, presetRevision: 1 }]);
        run.receiverLifetime.abort();
        expect((await pending).state).not.toBe('succeeded');
    });

    it('refuses changed child input at signed Home admission before reaching a receiver', async () => {
        const run = await fixture('changed');
        expect(await run.coordinate()).not.toMatchObject({ state: 'succeeded' });
        expect(run.receiverRefusals).toEqual(['invalid_token']);
        expect(run.delivered).toEqual([]);
        expect(run.effects).toEqual([]);
    });

    it('keeps A completed and B uncertain after B loses its reply, then reconciles and reloads without replay', async () => {
        const run = await fixture('second_reply_lost');
        const outcome = await run.coordinate();
        if (outcome.state !== 'outcome_uncertain') {
            throw new Error(`lost_reply_${outcome.state}_effects_${run.effects.length}_deliveries_${run.delivered.length}_refusals_${run.receiverRefusals.join(',')}`);
        }
        expect(outcome).toMatchObject({ state: 'outcome_uncertain' });
        expect(run.effects).toEqual([{ machineId: run.first.id, presetRevision: 1 }, { machineId: run.second.id, presetRevision: 1 }]);
        const invocations = await run.reconcileInvocations();
        expect(invocations).toMatchObject([
            { index: { lifecycle: 'completed' }, progress: { execution: { actionId: 'machines.setup.apply',
                input: { machineId: run.first.id, targets: [{ sources: reviewedSetupSources() }] } } } },
            { index: { lifecycle: 'outcome_uncertain' }, progress: { execution: { actionId: 'machines.setup.apply',
                input: { machineId: run.second.id, targets: [{ sources: reviewedSetupSources() }] } } },
                observation: { kind: 'outcome_uncertain' } },
        ]);
        // This setup fixture has no retained completion correspondence. Its real
        // recovery owner preserves uncertainty; a reload cannot infer success.
        expect(await run.coordinate()).toMatchObject({ state: 'outcome_uncertain' });
        expect(run.effects).toHaveLength(2);
        expect(run.delivered).toHaveLength(2);
        expect(run.parentPrompts).toHaveLength(1);
        expect(run.prompts).toEqual([]);
    });

    it.each(['stricter', 'reader_removed'] as const)('holds instead of executing when %s at the receiver', async control => {
        const run = await fixture(control);
        const pending = run.coordinate();
        const artifactId = await Promise.race([run.held, pending.then(outcome => {
            throw new Error(`receiver_settled_without_approval_hold_${outcome.state}_${run.receiverRefusals.join(',')}`);
        })]);
        expect(await run.approvalsGet({ artifactId })).toMatchObject({ status: 'open', actionId: 'machines.setup.apply' });
        expect(run.approvalCoordinator.getLiveWaiterCount(artifactId)).toBe(1);
        expect(run.effects).toEqual([]);
        expect(run.prompts).toHaveLength(1);
        run.receiverLifetime.abort();
        const outcome = await pending;
        expect(outcome.state).not.toBe('succeeded');
    });

    it('cannot reconstruct or dispatch the approved operation after its Account credential is revoked', async () => {
        const run = await fixture();
        await run.server.revokeAccount();
        await expect(run.coordinate()).rejects.toMatchObject({ response: { status: 401 } });
        expect(run.effects).toEqual([]);
        expect(run.prompts).toEqual([]);
    });

    it('repairs the persisted Publish host against fresh Machine facts and resumes signed children without relocating it', async () => {
        const run = await fixture('exact', 'environment');
        const accepted = await run.readStoredSnapshot();
        expect(accepted.machineId).toBe(run.host.id);
        const machines = await run.server.readMachines();
        const hostInput = { actionId: 'machines.setup.apply' as const, machines,
            targetMachineIds: [run.first.id, run.second.id] };
        expect(resolveCombinedActionWorkflowHostV1(hostInput)).toMatchObject({ kind: 'ready', machineId: run.first.id,
            review: { machineId: run.first.id, machines } });
        expect(resolveCombinedActionWorkflowHostV1({ ...hostInput, agentMachineId: run.host.id }))
            .toMatchObject({ kind: 'ready', machineId: accepted.machineId });
        expect(resolveCombinedActionWorkflowHostV1({ ...hostInput, agentMachineId: run.host.id, selectedMachineId: run.second.id }))
            .toMatchObject({ kind: 'ready', machineId: run.second.id, review: { machineId: run.second.id, machines } });
        expect(resolveCombinedActionWorkflowHostV1({ ...hostInput, createdMachineIds: [run.first.id] }))
            .toMatchObject({ kind: 'ready', machineId: run.second.id,
                review: { machines: machines.filter(machine => machine.machineId !== run.first.id) } });
        await run.server.setMachineOnline(run.first.id, false);
        expect(resolveCombinedActionWorkflowHostV1({ ...hostInput, machines: await run.server.readMachines() }))
            .toMatchObject({ kind: 'ready', machineId: run.second.id });
        expect(admitCombinedActionWorkflowHostV1({ machineId: accepted.machineId, machines: await run.server.readMachines() }))
            .toMatchObject({ kind: 'ready', machineId: run.host.id });
        await run.server.setMachineOnline(run.host.id, false);
        expect(admitCombinedActionWorkflowHostV1({ machineId: accepted.machineId, machines: await run.server.readMachines() }))
            .toEqual({ kind: 'unavailable', code: 'machine_unavailable', machineId: run.host.id, role: 'controller' });
        expect(run.effects).toEqual([]);
        expect(run.delivered).toEqual([]);
        await run.server.setMachineOnline(run.host.id, true);
        await run.server.setMachineOnline(run.first.id, true);
        expect(admitCombinedActionWorkflowHostV1({ machineId: accepted.machineId, machines: await run.server.readMachines() }))
            .toEqual({ kind: 'ready', machineId: run.host.id });
        expect((await run.readStoredSnapshot()).machineId).toBe(accepted.machineId);
        const repaired = await run.coordinate();
        if (repaired.state !== 'succeeded') throw new Error(`offline_repair_${repaired.state}_${run.receiverRefusals.join(',')}`);
        expect(repaired).toMatchObject({ state: 'succeeded' });
        expect(run.delivered).toEqual([
            { publisher: accepted.machineId, receiver: run.first.id, runId: run.runId },
            { publisher: accepted.machineId, receiver: run.second.id, runId: run.runId },
        ]);
        expect(run.parentPrompts).toHaveLength(1);
        expect(run.prompts).toEqual([]);
        // This proves the composer's host dependency, not the complete Publish journey.
    });
});
