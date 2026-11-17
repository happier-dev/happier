import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createServer } from 'node:http';
import axios from 'axios';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createProjectNativeToolchainIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { updateSettings, writeStoredCredentialsForServerId } from '@/persistence';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonExecutionRunListResponseSchema } from '@happier-dev/protocol/daemon/executionRuns';
import { writeExecutionRunMarker, removeExecutionRunMarker } from '../executionRunRegistry';
import * as processCensus from '@/processes/census/processCensus';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { dispatchOriginalAccountAction, resolveExternalActionRootInvocationAuthority, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionMachineBootstrapV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';

import {
  type MachineLiveStreamFrameV1,
  type WorkspaceSyncRuntimeReadinessV1,
  type WorkspaceSyncStatusV1,
} from '@happier-dev/protocol';
import type { DaemonState } from '@/api/types';
import type { ApiMachineClient } from '@/api/apiMachine';
import { decryptLegacy, encryptLegacy } from '@/api/encryption';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import { createLocalServicesDaemonRuntime } from '../local/services/runtime';
import type { LocalServiceListenerFact } from '../local/services/inventory/scanner';

import type { MachineLiveStreamCaptureAdapter } from '../peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { createMachineLiveStreamRelayTerminator } from '../peer/mediation/stream/relay';
import type {
  AutomationWorkerHandle,
  startAutomationWorker,
} from '../automation/automationWorker';
import { cleanupAndShutdown } from '../lifecycle/cleanupAndShutdown';
import { createServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { isWorkflowRuntimeEnabled } from '../automation/workflowFeatureGate';
import type { WorkflowCoordinatorResult } from '../workflows/coordinator';

import { createDaemonMachineBootstrapRuntime, createProjectFiniteSourceManifestInspector } from './createDaemonMachineBootstrapRuntime';
import { createBeforeShutdownDrain } from '../lifecycle/createBeforeShutdownDrain';
import { createDaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import { retireMachineSyncRuntimeAttempt } from '../machine/bootstrapMachineSyncRuntime';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { getMachineFinitePolicyV1 } from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { DaemonVoiceInferenceStatusResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createWorkflowAccountRunActionOwner, materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import { DiscussionMachinePublicationV2Schema, DISCUSSION_AGENT_POST_EVENT_V1 } from '@happier-dev/protocol/discussions/api';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createWorkflowRunStorageTestkit, type WorkflowRunStorageTestkitOperation } from '../workflows/workflowRunStorage.testkit';
import { createWorkflowRunRecoveryReader } from '../workflows/recovery';
import { createWorkflowDiscussionResultPublisher } from '../workflows/workflowDiscussionPublication';
import { buildWorkflowActionContext } from '../workflows/workflowActionContext';
import { createDiscussionReplyReturnPublisher } from '@/discussions/discussionReplyReturnPublisher';
import { createApprovedDiscussionAgentPublisher } from '@/discussions/approvedDiscussionAgentPublisher';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '../externalActions/daemonExternalActionTargetResolver';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { WorkflowInvocationGetRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';

const automationWorkerMocks = vi.hoisted(() => ({
  startAutomationWorker: vi.fn(),
}));

vi.mock('../automation/automationWorker', () => ({
  startAutomationWorker: automationWorkerMocks.startAutomationWorker,
}));

const deviceLocalSecretStorage = {
  sealJson: vi.fn(() => 'sealed'),
  openJson: vi.fn(() => null),
  deriveOpaqueIdentity: vi.fn(() => 'a'.repeat(64)),
} as never;

function createBaseRuntimeParams(overrides: Partial<Parameters<typeof createDaemonMachineBootstrapRuntime>[0]> = {}) {
  const workspaceSyncHandoffAdapter = {
    prepare: vi.fn(),
    prepareBetween: vi.fn(),
    finalize: vi.fn(),
    commit: vi.fn(),
    abort: vi.fn(),
  };
  return {
    // Test fixture boundary: this test only inspects returned PMS config; API methods are not invoked.
    api: {
      machineSyncClient: vi.fn(),
    } as never,
    controlPort: 41233,
    credentials: {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    },
    deviceLocalSecretStorage,
    workspaceSyncHandoffAdapter,
    runtimeId: 'runtime_1',
    publicReleaseChannel: 'dev' as const,
    startupSource: 'manual',
    serviceLabel: undefined,
    transferRuntimeStatePublisher: null,
    spawnSessionForInternalResume: vi.fn(),
    spawnSession: vi.fn(),
    stopSession: vi.fn(),
    awaitAgentSessionOpen: vi.fn(),
    isSessionAlreadyRunning: vi.fn(),
    loadLocalSessionMetadataForHandoff: vi.fn(),
    beforeShutdown: vi.fn(),
    requestShutdown: vi.fn(),
    directPeerServerLifecycle: null,
    // Test fixture boundary: transfer registries are pass-through values and are not invoked by this test.
    directTransferRegistryHost: {} as never,
    daemonServerWorkScheduler: {} as never,
    setDaemonServerWorkOnline: vi.fn(),
    onMachineConnectionOnline: vi.fn(),
    reconcileConnectedServicesProjection: vi.fn(),
    isShuttingDown: () => false,
    ...overrides,
  } satisfies Parameters<typeof createDaemonMachineBootstrapRuntime>[0];
}

describe('createDaemonMachineBootstrapRuntime', () => {
  it('uses current machine CPU capacity for execution-run statistics after bootstrap', async () => {
    const credentials = { token: 'cpu-capacity-account', encryption: null };
    const runId = 'fin-type-1109b-capacity';
    let effectiveCores = 0.5;
    let sample = 0;
    // HTTP and native process census are system boundaries; bootstrap, API,
    // handler registration and CPU sampling remain real.
    const home = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'cpu-capacity-account' } });
    const census = vi.spyOn(processCensus, 'readProcessCensus').mockImplementation(async () => ({
      status: 'ok', capturedAtMs: ++sample * 1_000, logicalCpus: 8,
      rows: [{ pid: process.pid, ppid: null, start: { startTimeMs: 1 }, principal: null,
        name: 'execution-run', memory: null, cpuTimeUs: sample * 250_000 }],
    }));
    const registrations = vi.spyOn(RpcHandlerManager.prototype, 'registerHandler');
    const params = { ...createBaseRuntimeParams({ api: await ApiClient.create(credentials), credentials,
      workspaceSyncHandoffAdapter: undefined }), readMachineEffectiveCores: () => effectiveCores };
    const bootstrap = createDaemonMachineBootstrapRuntime(params);
    const machine = await bootstrap.createConnectedApiMachine({ id: 'cpu-capacity-machine', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    try {
      if (!machine) throw new Error('Missing actual Machine client');
      machine.setRPCHandlers({ spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        stopSession: async () => true, requestShutdown() {} });
      const handler = registrations.mock.calls.find(([method]) => method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST)?.[1];
      if (!handler) throw new Error('Missing execution-run handler');
      await writeExecutionRunMarker({ pid: process.pid, happySessionId: 'capacity-session', runId, callId: 'capacity-call',
        sidechainId: 'capacity-side', intent: 'review', backendTarget: { kind: 'backend', backendId: 'claude' },
        status: 'running', startedAtMs: 1, updatedAtMs: 1 });
      const readCpu = async () => DaemonExecutionRunListResponseSchema.parse(await handler({})).runs
        .find(run => run.runId === runId)?.process?.cpu;
      expect(await readCpu()).toBeUndefined();
      expect(await readCpu()).toBe(50);
      effectiveCores = 0.25;
      expect(await readCpu()).toBeUndefined();
      expect(await readCpu()).toBe(100);
    } finally {
      await removeExecutionRunMarker(runId);
      await machine?.shutdown();
      await bootstrap.beforeShutdown();
      registrations.mockRestore();
      census.mockRestore();
      home.mockRestore();
    }
  });

  it('retains failed-attachment finite custody before plugin disposal while attempt cleanup is still waiting', async () => {
    const credentials = { token: 'failed-attachment-token', encryption: null };
    const admissionDrain = createDaemonAdmissionDrain();
    const admission = createProjectWorkerAdmission({ machineId: 'attachment-worker', admissionDrain,
      readPolicy: () => getMachineFinitePolicyV1({ read: async () => ({ status: 'ready', metadataVersion: 1,
        metadata: { finitePolicyV1: { accepting: true, runAtMost: 1 } } }),
        compareAndSwap: async () => ({ status: 'unavailable' }) }),
    });
    // Home profile/publication and the process/peer-stop adapters are the only
    // controlled boundaries. Bootstrap, Api, registration, runner and drain stay real.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'attachment-account' } });
    const bootstrap = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: await ApiClient.create(credentials), credentials, admissionDrain,
      workspaceSyncHandoffAdapter: undefined,
    }));
    const apiMachine = await bootstrap.createConnectedApiMachine({ id: 'attachment-worker',
      encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    });
    if (!apiMachine) throw new Error('Missing actual Machine client');
    apiMachine.setRPCHandlers({ spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      stopSession: async () => true, requestShutdown() {},
    }, { createProjectFiniteRuntime: async ports => ({ ...ports,
      serverId: 'home', machineId: 'attachment-worker', accountId: 'attachment-account', credentials,
      serverHttpBaseUrl: 'https://attachment-home.invalid', workerAdmission: admission,
      nativeIo: { resolveTool: async () => null }, resolveWorkspaceExecutionConfig: async () => null,
      environmentIo: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }),
    }) });
    const events: string[] = [];
    let settleProcess!: () => void;
    const processSettled = new Promise<void>(resolve => { settleProcess = resolve; });
    let releasePeerStop!: () => void;
    const peerStopped = new Promise<void>(resolve => { releasePeerStop = resolve; });
    let attemptCleanup: Promise<void> | undefined;
    let shutdown: Promise<void> | undefined;
    try {
      expect(await apiMachine.observeActionExecution({ actionId: 'projects.compute.exec', input: {},
        actionRequestId: 'failed-attachment-exec', execute: operation => {
          if (!operation.operationAcceptance) throw new Error('Missing actual finite operation');
          return admission.execute({ operationId: operation.operationAcceptance.operationId,
            workspaceRefId: 'attachment-copy', signal: operation.signal,
            accept: handle => {
              operation.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'exec',
                serverId: 'home', machineId: 'attachment-worker', workspaceRefId: 'attachment-copy', cwd: '/project' } });
              operation.operationAcceptance?.accept(handle);
            }, run: async reservation => {
              reservation.phase('running');
              operation.operationOwnerUpdate.update({ state: 'running' });
              operation.operationCancellation?.onRequest(() => {
                events.push('stop-unconfirmed');
                operation.operationOwnerUpdate.update({ observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
              });
              await processSettled;
              events.push('process-settled');
              return { kind: 'process_settled', result: { ok: false, errorCode: 'cancelled', error: 'cancelled' } };
            },
          });
        },
      })).toMatchObject({ ok: true, result: { operation: { state: 'accepted' } } });
      await expect.poll(async () => {
        const snapshot = await admission.load();
        return snapshot.kind === 'known' ? snapshot.running : null;
      }).toBe(1);
      // The failed handoff cleared the routing projection. Existing attempt
      // cleanup has not reached Api.shutdown because its peer stop is pending.
      attemptCleanup = retireMachineSyncRuntimeAttempt({ apiMachine, automationWorker: null,
        roleActivations: null, machineConnectionStateCleanup: null,
        disposeInactiveSessionUsageLimitRecovery: null, stopMachineIrohAcceptor: async () => await peerStopped,
        stopPeerMediationLoopbackServer: async () => {},
      });
      const beforeShutdown = createBeforeShutdownDrain({ admissionDrain,
        spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
        shutdownSpawnDrainGraceMs: 0, shutdownSpawnDrainPollMs: 10, getApiMachineForSessions: () => null,
        // Final shutdown consumes the same retained bootstrap owner, not the
        // cleared session-routing projection.
        retireFiniteExecution: bootstrap.retireProjectFiniteExecution,
        buildUnexpectedSpawnResult: errorMessage => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage }),
        disposePluginRuntimeRegistry: async () => { events.push('plugin-disposed'); },
      });
      shutdown = beforeShutdown();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(events).toEqual(['stop-unconfirmed']);
      expect(await admission.load()).toMatchObject({ running: 1 });
      settleProcess();
      await shutdown;
      expect(events).toEqual(['stop-unconfirmed', 'process-settled', 'plugin-disposed']);
    } finally {
      settleProcess();
      releasePeerStop();
      await Promise.all([attemptCleanup, shutdown]);
      await apiMachine.shutdown();
      vi.restoreAllMocks();
    }
  });
  it('reads the personal SOURCE manifest through portable Home admission and refuses lost binding or cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'finite-source-inspection-'));
    const home = await mkdtemp(join(tmpdir(), 'finite-source-home-'));
    const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL']);
    const serverId = 'source-local-profile';
    const homeId = 'srv_sourceHome';
    const serverHttpBaseUrl = 'https://source-home.invalid';
    const accountId = 'source-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const source = { id: 'source-ref', serverId: homeId, machineId: 'source-machine', rootPath: root, projectKey: 'project', createdAtMs: 1 };
    let custodian: string | undefined = accountId;
    let malformedReply = false;
    let issued = 0;
    let sourcePublicationReads = 0;
    const sourcePublicationProjections: unknown[] = [];
    let publicationState: 'current' | 'missing' | 'revoked' | 'replaced' = 'current';
    let publicationStatus = 200;
    let accountModeReply: 'plain' | 'invalid' | 'throw' = 'plain';
    const accountModeError = new Error('Fixture Account mode read failed');
    const inspectionInputs: unknown[] = [];
    let currentnessChannel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>> | undefined;
    try {
      scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: serverId, HAPPIER_SERVER_URL: serverHttpBaseUrl });
      reloadConfiguration();
      const profile = { id: serverId, name: 'Source', serverUrl: serverHttpBaseUrl, webappUrl: serverHttpBaseUrl,
        createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
        homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
          canonicalServerUrl: serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: serverHttpBaseUrl }] }) };
      await updateSettings(settings => ({ ...settings, activeServerId: serverId, servers: { [serverId]: profile } }));
      await writeStoredCredentialsForServerId(serverId, credentials);
      reloadConfiguration();
      currentnessChannel = await createRequesterCurrentnessSocketHarness();
      const installation = await readOrCreateInstallationIdentity();
      const machinePublication = () => ({ ...ExternalActionMachineBootstrapV1Schema.parse({
        id: source.machineId, kind: 'persistent', active: true, installationId: installation.installationId,
        revokedAt: publicationState === 'revoked' ? 1 : null,
        replacedByMachineId: publicationState === 'replaced' ? 'replacement-machine' : null,
        dataEncryptionKey: null, runnerContentKeyBinding: null,
        ...(custodian === undefined ? {} : { access: {
          custodian: { accountId: custodian, displayName: 'Source owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready',
        } }),
      }), installationPublicKey: Buffer.from(installation.publicKey, 'base64url').toString('base64') });
      await mkdir(join(root, '.happier'));
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
        scripts: { check: { source: { kind: 'command', command: 'must-not-run' }, execution: 'portable',
          memoryDemand: { bytes: 123, basis: { kind: 'declared' } } } } }));
      // Home HTTP is the boundary for original-Account admission and delivery.
      // The Machine decoder, Action executor/registrar and manifest reader stay real.
      vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        expect(url).toMatch(/^https:\/\/source-home\.invalid\//);
        expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
        if (url.endsWith('/v2/account/settings')) {
          return { status: 200, data: { content: { t: 'plain', v: {} }, version: 0 } };
        }
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
        if (url.endsWith('/v1/account/encryption')) {
          if (accountModeReply === 'throw') throw accountModeError;
          return { status: 200, data: accountModeReply === 'invalid' ? {} : { mode: 'plain', updatedAt: 0 } };
        }
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
          mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        } };
        if (url.endsWith('/v1/machines')) return { status: 200, data: [machinePublication()] };
        if (url.endsWith(`/v1/machines/${source.machineId}`)) {
          sourcePublicationReads++;
          sourcePublicationProjections.push(options?.headers?.Accept);
          if (publicationState === 'missing') return { status: 404, data: { error: 'not_found' } };
          if (publicationStatus !== 200) {
            // Mirror Axios' genuine response-status boundary for each requested projection.
            if (options?.validateStatus && !options.validateStatus(publicationStatus))
              throw createHttpStatusError(publicationStatus, 'Fixture Machine publication refused');
            return { status: publicationStatus, data: { error: 'access_denied' } };
          }
          return { status: 200, data: { machine: {
            ...machinePublication(), storageMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
          } } };
        }
        return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      });
      const sourceRpc = new RpcHandlerManager({ scopePrefix: source.machineId, localMachineId: source.machineId, encryptionMode: 'plain' });
      const projectDefinitionAction = createProjectDefinitionAction({ serverId, machineId: source.machineId, workingDirectory: root,
        accessPolicy: { kind: 'restrictedRoots', roots: [root] } });
      const sourceParams = { token, credentials, sessionId: '', mode: 'plain' as const, ctx: null,
        serverId, serverIdentityId: homeId, serverHttpBaseUrl, projectDefinitionAction,
        externalActionMachineInstallationId: installation.installationId, externalActionMachineRequestPrivateKey: installation.privateKey,
        machineActionDirectTargetTransport: { machineId: source.machineId,
          invoke: (method: string, input: unknown, options: Parameters<RpcHandlerManager['invokeLocal']>[2]) => sourceRpc.invokeLocal(method, input, options) } };
      const sourceExecutor = createActionExecutor(createCliActionDeps(sourceParams));
      registerProjectDefinitionHandlers({ machineId: source.machineId,
        rpcHandlerManager: sourceRpc, actionExecutor: sourceExecutor,
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
        expect(resolveServerHttpBaseUrl()).toBe(serverHttpBaseUrl);
        if (url.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
        expect(options?.headers?.Authorization).toBe(`Bearer ${token}`);
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
        expect(request.machineId).toBe(source.machineId);
        inspectionInputs.push(envelope.input);
        expect(envelope).toMatchObject({ target: { kind: 'machine', machineId: source.machineId },
          input: { workspace: { serverId: expect.stringMatching(new RegExp(`^(${homeId}|${serverId})$`)),
            workspaceId: source.id, machineId: source.machineId, rootPath: root } } });
        if (url.endsWith(bindExternalActionExecutionAuthorizationHttpPathV1('projects.inspect'))) {
          return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
            token: 'source-home-authorization', binding: { accountId, custodianAccountId: accountId,
              authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
              serverIdentityId: homeId, machineId: source.machineId, installationId: installation.installationId,
              actionId: 'projects.inspect', requestId: envelope.requestId, target: envelope.target,
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } }) };
        }
        expect(url).toBe(`${serverHttpBaseUrl}/v1/actions/projects.inspect`);
        expect(options?.headers?.[AUTHORITY_CEILING_HEADER_V1]).toBe('account_automation');
        expect(request.executionAuthorization?.binding).toMatchObject({ serverIdentityId: homeId,
          accountId, machineId: source.machineId, installationId: installation.installationId });
        issued++;
        const authorization = request.executionAuthorization;
        if (!authorization || !('authentication' in authorization.binding)) throw new Error('Missing SOURCE Account admission');
        const result = await executeExternalAction({ actionId: 'projects.inspect', envelope,
          principal: { accountId, authority: resolveExternalActionRootInvocationAuthority(authorization), authentication: authorization.binding.authentication },
          currentMachineId: source.machineId, currentServerId: serverId, currentServerHttpBaseUrl: serverHttpBaseUrl,
          currentInstallationId: installation.installationId, externalActionMachineRequestPrivateKey: installation.privateKey,
          executionAuthorization: authorization, resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: sourceExecutor,
          verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
            privateKey: installation.privateKey, installationId: installation.installationId, serverHttpBaseUrl }),
          prepareRequesterAccountContext: input => prepareInstalledRequesterAccountActionContext({ ...input,
            purpose: input.purpose ?? { kind: 'external_action' }, machineId: source.machineId, serverId, serverHttpBaseUrl,
            ownCredentials: credentials,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: source.machineId }),
            createExecutor: context => createActionExecutor(createCliActionDeps({ ...sourceParams,
              token: context.credentials.token, credentials: context.credentials })) }),
        });
        if (result.kind !== 'response') throw new Error(`SOURCE inspection ingress refused: ${result.errorCode}`);
        if (result.response.v !== 1) throw new Error(`Unexpected SOURCE response version: ${result.response.v}`);
        return { status: 200, data: malformedReply ? ExternalActionResponseEnvelopeV1Schema.parse({ ...result.response,
          execution: { ok: true, result: { definition: result.response.execution, detection: {}, extraAuthority: true } } }) : result.response };
      });
      vi.spyOn(machineTransport, 'callExactMachineRpc').mockRejectedValue(new Error('Source inspection must use Home admission'));
      vi.spyOn(machineTransport, 'callMachineRpc').mockRejectedValue(new Error('Source inspection must not retarget'));
      const inspect = createProjectFiniteSourceManifestInspector({ credentials, serverId, serverHttpBaseUrl, accountId,
        ingress: { signal: new AbortController().signal } });
      const signal = new AbortController().signal;
      const inspected = await inspect({ source, signal, command: { usage: 'script', name: 'check' } });
      expect(inspectionInputs[0]).toMatchObject({ read: { kind: 'execution', command: { usage: 'script', name: 'check' } } });
      expect(inspected).toMatchObject({ document: { status: 'valid', manifest: {
        scripts: { check: { execution: 'portable', memoryDemand: { bytes: 123 } } },
      } } });
      expect(inspected.document).not.toHaveProperty('bytes');
      expect(inspected.document).not.toHaveProperty('original');
      expect(issued).toBe(1);
      // The original-Account dispatcher reads one publication for admission;
      // Inspect must not surround that decision with extra custody reads.
      expect(sourcePublicationReads - issued).toBe(0);
      expect(sourcePublicationProjections).not.toContain('application/json;happier-machine-projection=host-facts');
      expect(await inspect({ source: { ...source, serverId }, signal })).toMatchObject({ document: { status: 'valid' } });
      expect(issued).toBe(2);
      expect(sourcePublicationReads - issued).toBe(0);
      for (const scenario of ['ambiguous', 'retired'] as const) {
        await updateSettings(settings => {
          const servers: Record<string, typeof profile> = scenario === 'ambiguous'
            ? { [serverId]: profile, duplicate: { ...profile, id: 'duplicate' } } : {};
          return { ...settings, servers };
        });
        await expect(inspect({ source, signal })).rejects.toMatchObject({ code: 'target_mismatch' });
      }
      await updateSettings(settings => ({ ...settings, servers: { [serverId]: profile } }));
      for (const [unproved, errorCode] of [
        ['foreign-account', 'requester_account_material_unavailable'],
        [undefined, 'admission_unavailable'],
      ] as const) {
        custodian = unproved;
        const readsBeforeRefusal = sourcePublicationReads;
        await expect(inspect({ source, signal })).rejects.toMatchObject({ code: errorCode });
        expect(sourcePublicationReads - readsBeforeRefusal).toBe(1);
        expect(issued).toBe(2);
      }
      custodian = accountId;
      for (const unavailable of ['missing', 'revoked', 'replaced'] as const) {
        publicationState = unavailable;
        const readsBeforeRefusal = sourcePublicationReads;
        await expect(inspect({ source, signal })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(sourcePublicationReads - readsBeforeRefusal).toBe(1);
        expect(issued).toBe(2);
      }
      publicationState = 'current';
      const dispatchAtHome = () => dispatchOriginalAccountAction({ actionId: 'projects.inspect',
        input: { workspace: { serverId: source.serverId, workspaceId: source.id, machineId: source.machineId, rootPath: source.rootPath },
          read: { kind: 'execution', command: { usage: 'script', name: 'check' } } },
        requestId: 'source-publication-refusal', target: { kind: 'machine', machineId: source.machineId }, credentials,
        serverHttpBaseUrl, serverIdentityId: homeId, authority: 'account_automation', signal,
      });
      publicationStatus = 403;
      await expect(dispatchAtHome()).rejects.toMatchObject({ code: 'machine_inventory_unavailable', cause: { response: { status: 403 } } });
      accountModeReply = 'invalid';
      await expect(dispatchAtHome()).resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
      accountModeReply = 'throw';
      await expect(dispatchAtHome()).rejects.toBe(accountModeError);
      expect(issued).toBe(2);
      accountModeReply = 'plain';
      publicationStatus = 200;
      await expect(inspect({ source: { ...source, serverId: 'wrong-home' }, signal })).rejects.toMatchObject({ code: 'target_mismatch' });
      const cancellation = new AbortController(); cancellation.abort();
      await expect(inspect({ source, signal: cancellation.signal })).rejects.toMatchObject({ code: 'cancelled' });
      expect(issued).toBe(2);
      malformedReply = true;
      await expect(inspect({ source, signal })).rejects.toMatchObject({ code: 'invalid_action_output' });
      malformedReply = false;
    } finally {
      await currentnessChannel?.close();
      vi.restoreAllMocks();
      scope.restore(); reloadConfiguration();
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('publishes summary changes once and republishes on reconnect and API replacement', async () => {
    let scanListeners: readonly LocalServiceListenerFact[] = [];
    const scan = vi.fn(async () => ({ listeners: scanListeners, processes: new Map(), workspaces: [], diagnostics: [] }));
    const services = createLocalServicesDaemonRuntime({ machineId: 'machine-a', inventoryEnabled: () => true, scan, startLoop: false });
    const publications: unknown[] = [];
    const listeners = new Set<(state: ManagedConnectionState) => void>();
    let delayPublication = false;
    const pendingPublications: Array<() => void> = [];
    const stateFor = (phase: ManagedConnectionState['phase']): ManagedConnectionState => ({ phase, reason: null, attempt: 0, nextRetryAt: null, lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null });
    const apiMachine = () => {
      let state: DaemonState | null = null;
      return {
        onConnectionStateChange(listener: (state: ManagedConnectionState) => void) {
          listeners.add(listener);
          listener(stateFor('idle'));
          return () => { listeners.delete(listener); };
        },
        async updateDaemonState(handler: Parameters<ApiMachineClient['updateDaemonState']>[0]) {
          if (delayPublication) {
            await new Promise<void>((resolve) => pendingPublications.push(() => {
              state = handler(state);
              publications.push(state.localServices);
              resolve();
            }));
            return 'published' as const;
          }
          state = handler(state);
          publications.push(state.localServices);
          return 'published' as const;
        },
      };
    };
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      // API socket publication is the genuine external boundary; inventory and projection are real.
      api: { machineSyncClient: vi.fn(apiMachine) } as never,
      localServiceSummary: services,
    }));
    const connection = (phase: ManagedConnectionState['phase']) => { for (const listener of listeners) listener(stateFor(phase)); };
    await runtime.createConnectedApiMachine({ id: 'machine-a' } as never);
    expect(publications).toEqual([]);
    connection('online');
    await vi.waitFor(() => expect(publications.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 }));
    delayPublication = true;
    scanListeners = [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' }];
    await services.refreshInventoryNow();
    scanListeners = [];
    await services.refreshInventoryNow();
    expect(pendingPublications).toHaveLength(2);
    // A transport/CAS attempt may execute after a newer scan. Even the older handler
    // must read the current owner rather than reverting the machine to its captured count.
    pendingPublications.shift()?.();
    expect(publications.at(-1)).toEqual({ v: 1, state: 'ready', runningCount: 0 });
    pendingPublications.shift()?.();
    delayPublication = false;
    const published = publications.length;
    await services.refreshInventoryNow();
    expect(publications).toHaveLength(published);
    connection('offline');
    connection('online');
    await vi.waitFor(() => expect(publications).toHaveLength(published + 1));
    await runtime.createConnectedApiMachine({ id: 'machine-a' } as never);
    connection('online');
    await vi.waitFor(() => expect(publications).toHaveLength(published + 2));
    expect(listeners.size).toBe(1);
    await runtime.beforeShutdown?.();
    expect(listeners.size).toBe(0);
    await services.stop();
  });
  it('authorizes the exact Runner broker readiness request before publishing the fixed application target', async () => {
    const request = {
      v: 1 as const,
      kind: 'provider_broker_readiness' as const,
      homeServerIdentityId: 'srv_home',
      activationId: '00000000-0000-4000-8000-000000000010',
      launchManifestCommitment: 'A'.repeat(43),
      resourceId: 'resource-1',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      protocol: 'openai-responses' as const,
      modelId: 'gpt-5',
      initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) },
      target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) },
      activationSignature: 'A'.repeat(86),
      installationSignature: 'A'.repeat(86),
    };
    const authorization = {
      v: 1 as const,
      binding: {
        homeServerIdentityId: request.homeServerIdentityId,
        activationId: request.activationId,
        launchManifestCommitment: request.launchManifestCommitment,
        resourceId: request.resourceId,
        agentTargetKey: request.agentTargetKey,
        protocol: request.protocol,
        modelId: request.modelId,
        initiator: request.initiator,
        target: request.target,
      },
      credentialSelectionBinding: {
        v: 1 as const,
        resourceId: request.resourceId,
        brokerMachineId: request.target.machineId,
        revision: 7,
        application: {
          agentTargetKey: request.agentTargetKey,
          implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
          endpointTemplateId: 'responses',
          protocol: request.protocol,
        },
        sourceRevision: 'source-revision-7',
      },
      readiness: { kind: 'available' as const },
    };
    const authorizeRunnerBrokerReadiness = vi.fn()
      .mockResolvedValueOnce(authorization)
      .mockResolvedValueOnce({
        ...authorization,
        binding: {
          ...authorization.binding,
          activationId: '00000000-0000-4000-8000-000000000011',
        },
      })
      .mockResolvedValueOnce({ ...authorization, readiness: { kind: 'resource_unavailable' as const } })
      .mockRejectedValueOnce(new Error('home unavailable'));
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient: vi.fn(), authorizeRunnerBrokerReadiness } as never,
    }));
    const resolve = runtime.peerMediationMachineRpc?.resolveRunnerBrokerReadinessApplicationTarget;
    expect(resolve).toBeDefined();
    const signal = new AbortController().signal;

    try {
      await expect(resolve?.({
        request,
        authenticatedRemoteEndpointId: request.initiator.endpointId,
        localEndpointId: request.target.endpointId,
        signal,
      } as never)).resolves.toEqual({ port: expect.any(Number) });
      expect(authorizeRunnerBrokerReadiness).toHaveBeenCalledWith(request, signal);
      await expect(resolve?.({
        request,
        authenticatedRemoteEndpointId: request.initiator.endpointId,
        localEndpointId: request.target.endpointId,
        signal,
      } as never)).resolves.toBeNull();
      await expect(resolve?.({
        request,
        authenticatedRemoteEndpointId: request.initiator.endpointId,
        localEndpointId: request.target.endpointId,
        signal,
      } as never)).resolves.toBeNull();
      await expect(resolve?.({
        request,
        authenticatedRemoteEndpointId: request.initiator.endpointId,
        localEndpointId: request.target.endpointId,
        signal,
      } as never)).resolves.toBeNull();
    } finally {
      await runtime.beforeShutdown();
    }
  });

  it('installs the broker application for the registered machine, advertises it only while live, and shuts it down', async () => {
    const resolveProviderBrokerApplicationTarget = vi.fn(async () => ({ port: 47_001, localCapability: 'local-capability' }));
    const resolveExternalProviderBrokerApplicationTarget = vi.fn(async () => ({ port: 47_002, localCapability: 'external-capability' }));
    const checkRunnerCredentialSelectionCurrentness = vi.fn(async () => ({ kind: 'available' as const }));
    const close = vi.fn(async () => undefined);
    const setProviderBrokerIngressLive = vi.fn(async () => undefined);
    const startProviderBrokerApplication = vi.fn(async () => ({
      accountConnectionIngress: false,
      resolveProviderBrokerApplicationTarget,
      resolveExternalProviderBrokerApplicationTarget,
      checkRunnerCredentialSelectionCurrentness,
      close,
    }));
    const withOwner = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: {
        machineSyncClient: vi.fn(() => ({ setProviderBrokerIngressLive })),
      } as never,
      startProviderBrokerApplication,
    }));
    const input = {
      handshake: { v: 1, kind: 'provider_broker' },
      authority: {},
      authenticatedRemoteEndpointId: 'a'.repeat(64),
      localEndpointId: 'b'.repeat(64),
      signal: new AbortController().signal,
    } as never;
    await expect(withOwner.peerMediationMachineRpc?.resolveProviderBrokerApplicationTarget?.(input))
      .resolves.toBeNull();
    await withOwner.createConnectedApiMachine({ id: 'registered-machine' } as never);
    expect(startProviderBrokerApplication).toHaveBeenCalledWith({
      machineId: 'registered-machine',
      apiMachine: expect.anything(),
    });
    expect(setProviderBrokerIngressLive).toHaveBeenCalledWith(true, false);
    await expect(withOwner.peerMediationMachineRpc?.resolveProviderBrokerApplicationTarget?.(input))
      .resolves.toEqual({ port: 47_001, localCapability: 'local-capability' });
    expect(resolveProviderBrokerApplicationTarget).toHaveBeenCalledWith(input);
    const externalInput = { binding: { v: 1, requestId: 'request-1' } } as never;
    await expect(withOwner.peerMediationMachineRpc?.resolveExternalProviderBrokerApplicationTarget?.(externalInput))
      .resolves.toEqual({ port: 47_002, localCapability: 'external-capability' });
    expect(resolveExternalProviderBrokerApplicationTarget).toHaveBeenCalledWith(externalInput);
    await withOwner.beforeShutdown();
    expect(setProviderBrokerIngressLive).toHaveBeenLastCalledWith(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(setProviderBrokerIngressLive.mock.invocationCallOrder.at(-1))
      .toBeLessThan(close.mock.invocationCallOrder[0]!);

    const withoutOwner = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams());
    expect(withoutOwner.peerMediationMachineRpc?.resolveProviderBrokerApplicationTarget).toBeUndefined();
  });

  it('does not start the daemon inference worker while its canonical feature decision is disabled', async () => {
    const previous = process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED;
    process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED = 'false';
    try {
      const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams());
      await expect(runtime.startVoiceInferenceWorkerForMachine('machine_1', 'account_1'))
        .resolves.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED;
      else process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED = previous;
    }
  });

  it.each([
    { override: undefined, forwardWorker: true },
    { override: 'false', forwardWorker: true },
    { override: undefined, forwardWorker: false },
  ])('wires bootstrap inference into Machine RPC with local override $override and forwarding $forwardWorker without loading models', async ({ override, forwardWorker }) => {
    const home = await mkdtemp(join(tmpdir(), 'daemon-inference-default-'));
    const envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR', 'HAPPIER_FEATURE_POLICY_ENV', 'HAPPIER_BUILD_FEATURES_ALLOW',
      'HAPPIER_BUILD_FEATURES_DENY', 'HAPPIER_FEATURE_VOICE__ENABLED',
      'HAPPIER_FEATURE_VOICE_AGENT__ENABLED', 'HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED',
      'HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED',
    ]);
    envScope.patch({
      HAPPIER_HOME_DIR: home, HAPPIER_FEATURE_POLICY_ENV: '',
      HAPPIER_BUILD_FEATURES_ALLOW: undefined, HAPPIER_BUILD_FEATURES_DENY: undefined,
      HAPPIER_FEATURE_VOICE__ENABLED: undefined, HAPPIER_FEATURE_VOICE_AGENT__ENABLED: undefined,
      HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED: undefined,
      HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED: override,
    });
    reloadConfiguration();
    const credentials = { token: 'inference-default-token', encryption: null };
    // Only Home HTTP is controlled; bootstrap, worker, RPC registration and schemas stay real.
    const homeRead = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'inference-account' } });
    const features = FeaturesResponseSchema.parse({ features: { voice: { enabled: true } } });
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: await ApiClient.create(credentials), credentials,
      getServerFeaturesSnapshot: () => ({ status: 'ready', features }),
      workspaceSyncHandoffAdapter: undefined,
    }));
    let apiMachine: ApiMachineClient | null = null;
    let worker: Awaited<ReturnType<typeof runtime.startVoiceInferenceWorkerForMachine>> = null;
    try {
      worker = await runtime.startVoiceInferenceWorkerForMachine('inference-machine', 'inference-account');
      apiMachine = await runtime.createConnectedApiMachine({
        id: 'inference-machine',
        encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      });
      if (!apiMachine) throw new Error('Missing Machine client');
      apiMachine.setRPCHandlers({
        spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        stopSession: async () => true, requestShutdown() {},
        ...(worker && forwardWorker ? { voiceInference: worker } : {}),
      }, { getServerFeaturesSnapshot: () => ({ status: 'ready', features }) });
      expect(worker === null).toBe(override === 'false');
      if (override === undefined && forwardWorker) {
        const response = DaemonVoiceInferenceStatusResponseSchema.parse(
          await apiMachine.invokeLocalMachineAction(RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS, {}),
        );
        expect(response).toMatchObject({ ok: true });
        if (!response.ok) throw new Error(response.errorCode);
        expect(response.models.every(model => model.installState === 'not_installed')).toBe(true);
        expect(worker!.readProcessRoots()).toEqual([]);
      } else {
        await expect(apiMachine.invokeLocalMachineAction(RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS, {}))
          .resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
      }
    } finally {
      await apiMachine?.shutdown();
      await worker?.stop();
      await runtime.beforeShutdown();
      homeRead.mockRestore();
      envScope.restore();
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps daemon quiescence out of ownership metadata and forwards the daemon feature refresh owner as a lifecycle dependency', async () => {
    const machineSyncClient = vi.fn((
      _machine: unknown,
      _metadata: unknown,
      _lifecycleDependencies: Readonly<{
        resolveServerFeaturesSnapshot?: () => Promise<unknown>;
      }>,
    ) => ({}));
    const isShuttingDown = vi.fn(() => false);
    const workspaceSyncHandoffAdapter = {
      prepare: vi.fn(),
      prepareBetween: vi.fn(),
      finalize: vi.fn(),
      commit: vi.fn(),
      abort: vi.fn(),
    };
    const workspaceSync = {
      controller: {},
      readFileAtTarget: vi.fn(),
    } as never;
    const serverFeaturesSnapshot = { status: 'ready', features: { capabilities: {} } } as const;
    const refreshServerFeaturesSnapshot = vi.fn(async () => serverFeaturesSnapshot as never);
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      // Test fixture boundary: only machineSyncClient call arguments are observed.
      api: { machineSyncClient } as never,
      isShuttingDown,
      workspaceSyncHandoffAdapter,
      workspaceSync,
      getServerFeaturesSnapshot: () => serverFeaturesSnapshot as never,
      refreshServerFeaturesSnapshot,
    }));
    expect(runtime.deviceLocalSecretStorage).toBe(
      deviceLocalSecretStorage,
    );
    const machine = {
      id: 'machine_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy' as const,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    await runtime.createConnectedApiMachine(machine);

    expect(machineSyncClient).toHaveBeenCalledWith(
      machine,
      expect.not.objectContaining({ isDaemonQuiescing: expect.any(Function) }),
      expect.objectContaining({
        controlPort: 41233,
        isDaemonQuiescing: isShuttingDown,
        workspaceSyncHandoffAdapter,
        workspaceSync,
        resolveServerFeaturesSnapshot: expect.any(Function),
      }),
    );
    const lifecycleDependencies = machineSyncClient.mock.calls[0]?.[2];
    await expect(lifecycleDependencies?.resolveServerFeaturesSnapshot?.()).resolves.toBe(serverFeaturesSnapshot);
    expect(refreshServerFeaturesSnapshot).toHaveBeenCalledOnce();
  });

  it('hands the peer service-export tunnel owner to the daemon so requester revocation can close its tunnels', () => {
    const onServiceExportTunnelsReady = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({ onServiceExportTunnelsReady }));
    expect(runtime.onServiceExportTunnelsReady).toBe(onServiceExportTunnelsReady);
  });

  it('constructs workspace sync from the registered machine identity before publishing the machine client', async () => {
    const updateDaemonState = vi.fn(async (_updater: (state: DaemonState | null) => DaemonState) => {});
    const machineSyncClient = vi.fn(() => ({ updateDaemonState }));
    const handoffAdapter = {
      prepare: vi.fn(),
      prepareBetween: vi.fn(),
      finalize: vi.fn(),
      commit: vi.fn(),
      abort: vi.fn(),
    };
    const workspaceSync = {
      controller: {},
      readFileAtTarget: vi.fn(),
    } as never;
    const createWorkspaceSyncRuntime = vi.fn(async ({ machineId, onReadinessPublished, onStatusPublished }: Readonly<{
      machineId: string;
      onReadinessPublished(readiness: WorkspaceSyncRuntimeReadinessV1): void;
      onStatusPublished(status: WorkspaceSyncStatusV1): void;
    }>) => {
      onReadinessPublished({
        engine: { state: 'ready' },
        carrier: { state: 'unavailable', errorCode: 'machine_carrier_unavailable' },
      });
      onStatusPublished({
        relationshipId: 'relationship_1',
        controllerMachineId: machineId,
        state: 'watching',
        alphaPath: '/alpha',
        betaPath: '/beta',
        mode: 'keep_synced',
        endpointStates: {
          alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
          beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        },
        conflictCount: 0,
        lastCycleObservedAtMs: null,
      });
      return {
        handoffAdapter,
        workspaceSync,
      };
    });
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient } as never,
      workspaceSyncHandoffAdapter: undefined,
      workspaceSync: undefined,
      createWorkspaceSyncRuntime,
    }));
    const machine = {
      id: 'registered-machine',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy' as const,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    await runtime.createConnectedApiMachine(machine);

    expect(createWorkspaceSyncRuntime).toHaveBeenCalledWith({
      machineId: 'registered-machine',
      onReadinessPublished: expect.any(Function),
      onStatusPublished: expect.any(Function),
    });
    expect(machineSyncClient).toHaveBeenCalledWith(
      machine,
      expect.any(Object),
      expect.objectContaining({
        workspaceSyncHandoffAdapter: handoffAdapter,
        workspaceSync,
      }),
    );
    await vi.waitFor(() => expect(updateDaemonState).toHaveBeenCalledOnce());
    const update = updateDaemonState.mock.calls[0]?.[0];
    // Inspect the entire decrypted shared blob, rather than a redacted UI view.
    const published = decryptLegacy(encryptLegacy(update?.(null), machine.encryptionKey), machine.encryptionKey);
    expect(published).toEqual({
      status: 'running',
      workspaceSync: {
        v: 1,
        readiness: {
          engine: { state: 'ready' },
          carrier: { state: 'unavailable', errorCode: 'machine_carrier_unavailable' },
        },
      },
    });
  });

  it('forwards the daemon-owned inventory snapshot reader without creating a second scanner', () => {
    const readLocalServiceInventorySnapshot = vi.fn();
    const getServerFeaturesSnapshot = vi.fn();
    const resolvePeerMediationTrustRoots = vi.fn(() => []);
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      readLocalServiceInventorySnapshot,
      getServerFeaturesSnapshot,
      resolvePeerMediationTrustRoots,
    }));
    expect(runtime.readLocalServiceInventorySnapshot).toBe(readLocalServiceInventorySnapshot);
    expect(runtime.getServerFeaturesSnapshot).toBe(getServerFeaturesSnapshot);
    expect(runtime.resolvePeerMediationTrustRoots).toBe(resolvePeerMediationTrustRoots);
  });

  it('forwards the durable connected-services projection reconciler into machine cursor composition', () => {
    const reconcileConnectedServicesProjection = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      reconcileConnectedServicesProjection,
    }));

    expect(runtime.reconcileConnectedServicesProjection).toBe(reconcileConnectedServicesProjection);
  });

  it('keeps disabled Workflow recovery cold and uses the existing lifecycle boundary after enabling', async () => {
    let enabled = false;
    let constructions = 0;
    let assignmentReads = 0;
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient: vi.fn(() => ({})) } as never,
      isWorkflowFeatureEnabled: () => enabled,
      createWorkflowRecoveryForMachine: ({ machineId }) => {
        constructions++;
        return createWorkflowRunRecoveryReader({ accountId: 'account', machineId,
          // The persisted Run transport is the boundary; recovery logic remains real.
          storage: { execute: async operation => {
            if (operation.operation !== 'recovery.list') throw new Error('Unexpected storage operation');
            assignmentReads++;
            return { candidates: [] };
          } },
          resolveAccountEncryption: async () => ({ kind: 'available',
            witness: { mode: 'plain', version: 0, contentKeyFingerprint: null } }),
          reconcileInvocation: async () => { throw new Error('Empty assignments cannot reconcile'); },
        });
      },
    }));
    await runtime.createConnectedApiMachine({ id: 'machine_1', encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    await runtime.recoverWorkflowRuns?.('startup');
    expect({ constructions, assignmentReads }).toEqual({ constructions: 0, assignmentReads: 0 });
    enabled = true;
    await runtime.recoverWorkflowRuns?.('control');
    expect({ constructions, assignmentReads }).toEqual({ constructions: 1, assignmentReads: 1 });
    await runtime.recoverWorkflowRuns?.('reconnect');
    expect({ constructions, assignmentReads }).toEqual({ constructions: 1, assignmentReads: 2 });
    enabled = false;
    await runtime.recoverWorkflowRuns?.('resume');
    expect({ constructions, assignmentReads }).toEqual({ constructions: 1, assignmentReads: 2 });
  });

  it('cancels a pending recovery storage request when the daemon shuts down', async () => {
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    let receivedSignal: AbortSignal | undefined;
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient: () => ({ enqueueSessionPendingByMachine: async () => {} }) } as never,
      isWorkflowFeatureEnabled: () => true,
      createWorkflowRecoveryForMachine: ({ machineId }) => createWorkflowRunRecoveryReader({ accountId: 'account', machineId,
        resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        reconcileInvocation: async () => { throw new Error('No invocation was loaded'); },
        storage: { execute: async (_operation, options) => await new Promise((_resolve, reject) => {
          receivedSignal = options?.signal;
          release = () => reject(Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' }));
          receivedSignal?.addEventListener('abort', release, { once: true });
          entered();
        }) },
      }),
    }));
    await runtime.createConnectedApiMachine({ id: 'machine_1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const recovery = runtime.recoverWorkflowRuns!('startup');
    recovery.catch(() => {});
    await sending;
    try {
      expect.soft(receivedSignal).toBeInstanceOf(AbortSignal);
      await runtime.beforeShutdown();
      expect.soft(receivedSignal?.aborted).toBe(true);
    } finally { release(); await recovery.catch(() => {}); }
  });

  it('constructs one workflow recovery reader for the connected machine and forwards lifecycle triggers', async () => {
    const recover = vi.fn(async () => {});
    const createWorkflowRecoveryForMachine = vi.fn(() => recover);
    const enqueueSessionPendingByMachine = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: {
        machineSyncClient: vi.fn(() => ({ enqueueSessionPendingByMachine })),
      } as never,
      isWorkflowFeatureEnabled: () => true,
      createWorkflowRecoveryForMachine,
    }));
    const machine = {
      id: 'machine_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy' as const,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    await runtime.createConnectedApiMachine(machine);
    await runtime.recoverWorkflowRuns?.('startup');

    expect(createWorkflowRecoveryForMachine).toHaveBeenCalledWith(expect.objectContaining({
      machineId: machine.id,
      machineAdmissionTransport: expect.any(Function),
    }));
    expect(recover).toHaveBeenCalledWith('startup', expect.any(AbortSignal), undefined);
  });

  it('retires cancelled publication custody after the last approved original returns without reconnecting', async () => {
    const accountId = 'account';
    const machineId = 'publication-worker';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`, encryption: null };
    const origin = { discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 };
    const sessionId = 'c123456789012345678901234';
    const returned = new Set<string>();
    const artifacts = new Map<string, Record<string, unknown>>();
    const httpCalls: string[] = [];
    const home = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      response.setHeader('connection', 'close');
      const path = request.url?.split('?')[0] ?? '';
      httpCalls.push(`${request.method} ${path}`);
      const reply = (value: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(value)); };
      if (path === '/v1/features') return reply({ features: { sessions: { enabled: true, conversations: { enabled: true } },
        sharing: { enabled: true, session: { enabled: true } } }, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } });
      if (path === '/v1/account/profile') return reply({ id: accountId });
      if (path === '/v1/account/encryption') return reply({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/account/encryption/currentness') return reply({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (path === '/v2/account/settings') return reply({ version: 1, content: { t: 'plain', v: {} } });
      if (path === `/v2/sessions/${sessionId}`) return reply({ session: createSessionRecordFixture({ id: sessionId,
        active: false, encryptionMode: 'plain', metadata: JSON.stringify({ machineId, path: '/repo' }) }) });
      if (path === '/v1/discussions/discussion/participants') return reply({ discussionId: 'discussion', ownerAccountId: accountId,
        access: 'owner', grants: [], participants: [{ participant: { kind: 'session', sessionId }, answerPolicy: 'drafts_for_approval', createdAt: 1 }] });
      if (path === '/v1/discussions/discussion') return reply({ discussion: { id: 'discussion', ownerAccountId: accountId,
        encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'create',
        titleContent: { t: 'plain', v: { v: 1, title: 'Question' } }, latestMessage: { id: 'question', localId: 'question', seq: 1,
          authorAccountId: accountId, accountActor: { v: 1, accountId, profile: null }, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } } });
      if (path.startsWith('/v1/artifacts')) {
        const id = decodeURIComponent(path.split('/')[3] ?? '');
        if (path.endsWith('/access/recipients')) return reply({ artifactId: id, ownerAccountId: accountId, encryptionMode: 'plain',
          access: 'owner', dataEncryptionKey: artifacts.get(id)?.dataEncryptionKey, callerDataEncryptionKey: artifacts.get(id)?.dataEncryptionKey, recipients: [] });
        if (request.method === 'GET') return reply(artifacts.get(id) ?? { error: 'not_found' }, artifacts.has(id) ? 200 : 404);
        let bytes = ''; for await (const chunk of request) bytes += chunk.toString();
        const body: Record<string, unknown> = JSON.parse(bytes);
        if (path === '/v1/artifacts' && typeof body.id === 'string') {
          if (artifacts.has(body.id)) return reply({ error: 'conflict' }, 409);
          artifacts.set(body.id, { ...body, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
          return reply(artifacts.get(body.id));
        }
        const row = artifacts.get(id);
        if (!row) return reply({ error: 'not_found' }, 404);
        if (row.headerVersion !== body.expectedHeaderVersion || row.bodyVersion !== body.expectedBodyVersion) return reply({ success: false, error: 'version-mismatch' });
        Object.assign(row, { header: body.header, body: body.body, headerVersion: Number(row.headerVersion) + 1,
          bodyVersion: Number(row.bodyVersion) + 1, seq: Number(row.seq) + 1, updatedAt: Number(row.updatedAt) + 1 });
        return reply({ success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion });
      }
      return reply({ error: 'not_found' }, 404);
    });
    await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve())));
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Missing Home address');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    await runWithServerHttpBaseUrl(serverUrl, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      onTestFinished(() => resetActiveAccountSettingsSnapshotForTests());
      const admitted = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, inputs: [], defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'test' } },
      }, blocks: ['one', 'two'].map(id => ({ kind: 'step' as const, id,
        document: { text: 'Answer', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } })) },
        context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
          origin: { kind: 'direct', discussion: origin }, resultDelivery: { kind: 'originating_discussion', ...origin },
          authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
        effects: { resolveTargetAvailability: async () => true } });
      if (!admitted.ok) throw new Error('Workflow admission failed');
      const storage = createWorkflowRunStorageTestkit({ accountId, machineId, runId, origin: { kind: 'direct' },
        acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
          binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: admitted.snapshot })) });
      const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint: { kind: 'happier.workflow-checkpoint.v1',
          rootRecordId: 'root', nextSequence: '3', frontier: { nextBlockOrdinal: 2, paused: false } } }));
      const seal = (id: string, sequence: string) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: id, sequence,
          parentRecordId: id === 'root' ? null : 'root', memberOrdinal: id === 'two' ? '1' : '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: id === 'root' ? '$root' : id, scope: [] },
          blockKind: id === 'root' ? 'root' : 'step', attempt: '0', logicalInvocationRecordId: id,
          ...(id === 'root' ? {} : { execution: { kind: 'session' as const, sessionId, localInputId: id } }) } }));
      await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
        rootInvocation: { id: 'root', contentEnvelope: seal('root', '0') } });
      await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope,
        invocations: ['one', 'two'].map((id, index) => ({ id, sequence: String(index + 1), parentRecordId: 'root',
          memberOrdinal: String(index), lifecycle: 'cancelled', contentEnvelope: seal(id, String(index + 1)) })) });
      storage.requestControl('cancelled');
      const runOwner = createWorkflowAccountRunActionOwner({ storage, resolveAccountId: async () => accountId,
        definitions: { get: async () => { throw new Error('No mutable definition read'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('No plain Account keys'); } });
      const recoverySelections: unknown[] = [];
      // HTTP and Machine Socket.IO are the only substituted boundaries. The
      // bootstrap, strict packets, stored readers, publisher and settlement stay real.
      const get = axios.get.bind(axios);
      vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        if (!url.includes('/messages/by-local-id/')) return get(new URL(url, serverUrl).pathname.startsWith('/v1/artifacts')
          ? url : serverUrl + new URL(url).pathname, config);
        const id = decodeURIComponent(url.split('/messages/by-local-id/')[1]!.split('/')[0]!);
        return { status: 200, data: { v: 1, status: 'available', progress: {
          v: 1, mode: 'wait', workflow: { purpose: 'invocation', runId, invocationRecordId: id },
          discussion: { discussionId: 'discussion', messageId: 'question', throughSeq: 1, participantSessionId: sessionId },
          disposition: returned.has(id) ? 'returned' : 'observing', outcome: { kind: 'cancelled' },
        } } };
      });
      const publish = createDiscussionReplyReturnPublisher({ credentials, machineId, serverId: 'home', serverHttpBaseUrl: serverUrl,
        workflowActionContext: buildWorkflowActionContext({ ...admitted.snapshot, runId }),
        signal: new AbortController().signal, isCurrent: async () => true,
        actionsSettingsProvider: { getAccountSettings: () => accountSettingsParse({}), getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
          actions: { 'discussion.reply': { approvalRequiredSurfaces: ['agent'] } } }) },
        postWorkflowMessage: async (publication, options) => {
          if (!client) throw new Error('Missing actual Machine client');
          return await client.postAgentDiscussionMessage(publication, options);
        } });
      const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
        api: await ApiClient.create(credentials), credentials, workspaceSyncHandoffAdapter: undefined,
        isWorkflowFeatureEnabled: () => true,
        createWorkflowRecoveryForMachine: () => createWorkflowRunRecoveryReader({ accountId, machineId,
          storage: { execute: async (operation, options) => {
            if (operation.operation === 'recovery.list') {
              recoverySelections.push(operation.runId);
              return { candidates: storage.run().workflowCustodyState === 'pending' ? [{ run: storage.run(), parentAttempt: 0 }] : [] };
            }
            return await storage.execute(operation as WorkflowRunStorageTestkitOperation, options);
          } },
          resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
          reconcileInvocation: async () => { throw new Error('A terminal child must not execute again'); },
          onInvocationSettled: async ({ invocation }) => await createWorkflowDiscussionResultPublisher({ credentials, origin,
            isCurrent: async () => true, publish,
          })({ runId, invocation }),
        }),
      }));
      const client = await runtime.createConnectedApiMachine({ id: machineId, encryptionMode: 'plain',
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
      if (!client) throw new Error('Missing actual Machine client');
      try {
        const publications: unknown[] = [];
        const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, raw) => {
          if (event !== DISCUSSION_AGENT_POST_EVENT_V1) throw new Error('Unexpected native work');
          const packet = DiscussionMachinePublicationV2Schema.parse(raw);
          if (packet.operation !== 'approved_replay' || !packet.publication.replyReturn?.workflow) throw new Error('Expected Workflow approval replay');
          const publication = packet.publication;
          returned.add(publication.replyReturn!.requestLocalId);
          publications.push(packet);
          return { v: 1, ok: true, value: { messageSeq: publications.length + 1, message: { id: `reply-${publications.length}`,
            discussionId: 'discussion', localId: publication.request.localId, seq: publications.length + 1, authorAccountId: accountId,
            accountActor: { v: 1, accountId, profile: null }, producerV1: { v: 1, kind: 'agent', sessionId },
            content: publication.request.content, mentionedAccountIds: [], createdAt: 1 } } };
        } });
        Reflect.set(client, 'socket', socket);
        await runtime.recoverWorkflowRuns?.('startup');
        expect(storage.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'pending' });
        const store = createCliApprovalsArtifactStore({ credentials, serverId: 'home', serverHttpBaseUrl: serverUrl });
        const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId, serverId: 'home',
          serverApiUrl: serverUrl });
        if (!currentness) throw new Error('Missing approval currentness');
        const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
          serverId: 'home', serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
          postAgentDiscussionMessage: async (request, options) => {
            if (!options?.approvedActionReplay) throw new Error('Expected recorded approval execution');
            return await createApprovedDiscussionAgentPublisher({ credentials, machineId, serverId: 'home', serverUrl,
              isApprovalExecutionOriginCurrent: currentness, publish: (publication, options) => client.postAgentDiscussionMessage(publication, options),
              executeSourceAction: async (actionId, input, context) => actionId === 'workflow.run.invocations.get'
                ? { ok: true, result: await runOwner.execute({ actionId, input: WorkflowInvocationGetRequestV1Schema.parse(input), context }) }
                : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' },
            })(request, { ...options, approvedActionReplay: options.approvedActionReplay, callerAuthority: 'present_user' });
          },
        }, { isApprovalExecutionOriginCurrent: currentness });
        for (const id of ['one', 'two']) {
          // Startup owns the first Ask; the first committed return wakes the
          // same reader to reach the second. The test never requests a retry.
          const { artifactId, captured } = await vi.waitFor(async () => {
            const candidates = await Promise.all([...artifacts.keys()].map(async artifactId => ({ artifactId,
              request: await store.approvalsGet({ artifactId }) })));
            const pending = candidates.find(({ request }) => request?.v === 2 && request.status === 'open'
              && request.executionOriginV1.discussionReplyReturn && 'requestLocalId' in request.executionOriginV1.discussionReplyReturn
              && request.executionOriginV1.discussionReplyReturn.requestLocalId === id);
            if (pending?.request?.v !== 2) throw new Error(`Missing ${id} publication approval`);
            return { artifactId: pending.artifactId, captured: pending.request };
          });
          const approved = ApprovalRequestV2Schema.parse({ ...captured, status: 'approved', updatedAtMs: captured.updatedAtMs + 1,
            decision: { kind: 'approve', authority: 'present_user', decidedAtMs: captured.updatedAtMs + 1 } });
          expect(await store.approvalsUpdate({ artifactId, request: approved })).toEqual({ ok: true });
          const replayed = await runWithServerHttpBaseUrl(serverUrl, () => executor.replayApprovedApprovalRequest({ artifactId,
            callerAuthority: 'present_user' }));
          expect(replayed, JSON.stringify({ replayed, httpCalls })).toMatchObject({ ok: true, result: { status: 'executed' } });
          if (id === 'one') {
            await vi.waitFor(() => expect(recoverySelections).toEqual([undefined, runId]));
            expect(storage.run().workflowCustodyState).toBe('pending');
          }
        }
        await vi.waitFor(() => expect(storage.run()).toMatchObject({ state: 'cancelled', workflowCustodyState: 'settled' }));
        expect([...returned]).toEqual(['one', 'two']);
        expect(publications).toHaveLength(2);
        expect(recoverySelections).toEqual([undefined, runId, runId]);
      } finally { await client.shutdown(); vi.restoreAllMocks(); }
    });
  });

  it('forwards the daemon runtime-open attestation reader into machine bootstrap', () => {
    const awaitAgentSessionOpen = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      awaitAgentSessionOpen,
    }));

    expect(runtime.awaitAgentSessionOpen).toBe(awaitAgentSessionOpen);
  });

  it('connects the registered machine through the canonical API client', async () => {
    const apiMachine = { enqueueSessionPendingByMachine: vi.fn() };
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient: () => apiMachine } as never,
    }));
    const machine = {
      id: 'machine_1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const,
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    };
    expect(await runtime.createConnectedApiMachine(machine)).toBe(apiMachine);
  });

  it('publishes the worker to shutdown ownership before downstream bootstrap can continue', async () => {
    const worker: AutomationWorkerHandle = {
      liveWorkProducer: { read: () => ({ coverage: 'complete', items: [] }), subscribe: () => () => {} },
      stop: vi.fn(),
      refreshAssignments: vi.fn(async () => {}),
      catchUp: vi.fn(async () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
      handleServerUpdate: vi.fn(),
    };
    automationWorkerMocks.startAutomationWorker.mockReturnValueOnce(worker);
    let shutdownOwnedWorker: AutomationWorkerHandle | null = null;
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      onAutomationWorkerStarted: (startedWorker) => {
        shutdownOwnedWorker = startedWorker;
      },
    }));

    const startedWorker = await runtime.startAutomationWorkerForMachine('machine_1');
    expect(startedWorker).toBe(worker);
    expect(shutdownOwnedWorker).toBe(worker);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (() => undefined as never) as typeof process.exit,
    );
    try {
      // This is the barrier between factory publication and the next bootstrap
      // action (Memory/onMachineSyncRuntime). Shutdown must retain this exact
      // early handle rather than wait for the later runtime result.
      await cleanupAndShutdown({
        source: 'happier-cli',
        processEnv: {},
        resolvePositiveIntEnv: (_raw, fallback) => fallback,
        restartOnStaleVersionAndHeartbeat: null,
        connectedServiceRefreshLoopHandle: null,
        connectedServiceQuotasLoopHandle: null,
        apiMachine: null,
        machineConnectionStateCleanup: null,
        automationWorker: shutdownOwnedWorker,
        memoryWorker: null,
        voiceInferenceWorker: null,
        trackedSessionCount: 0,
        stopDirectPeerServer: async () => {},
        stopTailscaleTransferServeLifecycle: async () => {},
        stopControlServer: async () => {},
        stopKeepAwake: async () => {},
        daemonLockHandle: null,
        releaseDaemonLock: async () => {},
      });
      expect(worker.stop).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('injects the production workflow coordinator into the existing Automation worker after Machine sync exists', async () => {
    const enqueueSessionPendingByMachine = vi.fn();
    const apiMachine = { enqueueSessionPendingByMachine, dispatchSessionServerStart: vi.fn() } as never;
    const coordinateWorkflowRun = vi.fn();
    const createWorkflowRunCoordinatorForMachine = vi.fn(() => coordinateWorkflowRun);
    automationWorkerMocks.startAutomationWorker.mockReturnValueOnce({
      stop: vi.fn(), catchUp: async () => {}, refreshAssignments: vi.fn(), pause: vi.fn(), resume: vi.fn(), handleServerUpdate: vi.fn(),
    });
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient: vi.fn(() => apiMachine) } as never,
      isWorkflowFeatureEnabled: () => true,
      createWorkflowRunCoordinatorForMachine,
    }));

    await runtime.createConnectedApiMachine({ id: 'machine_1' } as never);
    await runtime.startAutomationWorkerForMachine('machine_1');

    const workerParams = automationWorkerMocks.startAutomationWorker.mock.calls.at(-1)?.[0] as
      | Parameters<typeof startAutomationWorker>[0]
      | undefined;
    await expect(workerParams?.coordinateWorkflowRun?.({} as never)).resolves.toBeUndefined();
    expect(createWorkflowRunCoordinatorForMachine).toHaveBeenCalledWith({
      machineId: 'machine_1',
      machineAdmissionTransport: expect.any(Function),
      machineActionDirectTargetTransport: {
        machineId: 'machine_1',
        machineServiceAction: expect.any(Function),
        invoke: expect.any(Function),
      },
    });
    expect(coordinateWorkflowRun).toHaveBeenCalledOnce();
  });

  it('uses the live server feature decision for the existing Workflow coordinator without restarting Automation', async () => {
    const enabledFeatures = {
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: {
        features: {
          automations: { enabled: true },
          workflows: { enabled: true },
        },
        capabilities: {},
      },
    };
    const disabledFeatures = {
      ...enabledFeatures,
      features: {
        ...enabledFeatures.features,
        features: {
          automations: { enabled: true },
          workflows: { enabled: false },
        },
      },
    };
    const fetchSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('Home unavailable'))
      .mockResolvedValueOnce(enabledFeatures)
      .mockResolvedValueOnce(disabledFeatures);
    const featureStore = createServerFeaturesSnapshotStore({ fetchSnapshot });
    const coordinatedOutcome: WorkflowCoordinatorResult = { state: 'succeeded' };
    const coordinateWorkflowRun = vi.fn(async () => coordinatedOutcome);
    const recoverWorkflowRuns = vi.fn(async () => {});
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: {
        machineSyncClient: vi.fn(() => ({
          enqueueSessionPendingByMachine: vi.fn(),
          dispatchSessionServerStart: vi.fn(),
        })),
      } as never,
      isWorkflowFeatureEnabled: () => isWorkflowRuntimeEnabled({}, featureStore.getSnapshot()),
      createWorkflowRunCoordinatorForMachine: vi.fn(() => coordinateWorkflowRun),
      createWorkflowRecoveryForMachine: vi.fn(() => recoverWorkflowRuns),
    }));
    automationWorkerMocks.startAutomationWorker.mockReturnValueOnce({
      stop: vi.fn(), catchUp: async () => {}, refreshAssignments: vi.fn(), pause: vi.fn(), resume: vi.fn(), handleServerUpdate: vi.fn(),
    });

    await runtime.createConnectedApiMachine({ id: 'machine_1' } as never);
    await runtime.startAutomationWorkerForMachine('machine_1');
    const workerParams = automationWorkerMocks.startAutomationWorker.mock.calls.at(-1)?.[0] as
      | Parameters<typeof startAutomationWorker>[0]
      | undefined;
    const coordinate = workerParams?.coordinateWorkflowRun;
    expect(coordinate).toBeDefined();

    await expect(coordinate?.({} as never)).rejects.toThrow('Workflow Run coordinator is unavailable');
    await runtime.recoverWorkflowRuns?.('startup');
    expect(recoverWorkflowRuns).not.toHaveBeenCalled();
    await featureStore.refresh();
    await expect(coordinate?.({} as never)).rejects.toThrow('Workflow Run coordinator is unavailable');
    await featureStore.refresh();
    await expect(coordinate?.({} as never)).resolves.toEqual(coordinatedOutcome);
    await runtime.recoverWorkflowRuns?.('reconnect');
    expect(coordinateWorkflowRun).toHaveBeenCalledOnce();
    expect(recoverWorkflowRuns).toHaveBeenCalledOnce();
    await featureStore.refresh();
    await expect(coordinate?.({} as never)).rejects.toThrow('Workflow Run coordinator is unavailable');
    await runtime.recoverWorkflowRuns?.('reconnect');
    expect(coordinateWorkflowRun).toHaveBeenCalledOnce();
    expect(recoverWorkflowRuns).toHaveBeenCalledOnce();
  });

  it('wires the production peer-mediation live-stream capture adapter into machine bootstrap config', () => {
    const cancelConnectedServiceRuntimeAuthRecovery = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      cancelConnectedServiceRuntimeAuthRecovery,
    }));

    expect(runtime.peerMediationMachineRpc?.stream?.captureAdapter).toEqual({
      start: expect.any(Function),
    });
    expect(runtime.cancelConnectedServiceRuntimeAuthRecovery).toBe(cancelConnectedServiceRuntimeAuthRecovery);
  });

  it('uses the shared PMS capture registry for relayed live-stream capture sources', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    const offeredFrames: MachineLiveStreamFrameV1[] = [];
    const sourceAdapter: MachineLiveStreamCaptureAdapter = {
      start: async (input) => {
        input.offerFrame({
          v: 1,
          streamId: input.streamId,
          sequence: 1,
          timestampMs: 1_000,
          payloadKind: 'image_keyframe',
          payloadEncoding: 'binary_base64',
          payloadBase64: 'AQID',
          payloadSizeBytes: 3,
        });
        return { ok: true, session: { stop: () => undefined } };
      },
    };
    registry.register({
      sourceId: 'ios-simulator:A1B2-C3D4:screen',
      streamFamily: 'ios-simulator:A1B2-C3D4:screen',
      adapter: sourceAdapter,
      capabilities: {
        v: 1,
        sourceId: 'ios-simulator:A1B2-C3D4:screen',
        sourceKind: 'simulator',
        supportedCodecs: ['image.mjpeg'],
        maxFramesPerSecond: 30,
        inputMode: 'exclusive',
        sidebands: ['capture_health'],
        health: { status: 'available' },
      },
    });

    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      liveStreamCaptureRegistry: registry,
    }));
    const captureAdapter = runtime.peerMediationMachineRpc?.stream?.captureAdapter;
    expect(captureAdapter).toBeDefined();
    if (!captureAdapter) throw new Error('expected live-stream capture adapter');

    const result = await captureAdapter.start({
      streamId: 'stream_1',
      streamFamily: 'ios-simulator:A1B2-C3D4:screen',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      caps: {
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 8_192,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
      },
      startRequest: {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'ios-simulator:A1B2-C3D4:screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 8_192,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
      },
      startedAtMs: 1_000,
      expiresAtMs: 61_000,
      nowMs: () => 1_000,
      offerFrame: (frame) => {
        offeredFrames.push(frame);
        return { ok: true };
      },
      applyControl: () => ({ ok: true }),
      emitReceipt: () => undefined,
    });

    expect(result).toMatchObject({ ok: true });
    expect(offeredFrames.map((frame) => frame.sequence)).toEqual([1]);
  });

  it('carries admitted Browser input policy through the production bootstrap adapter into the relay', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    let receivedText = '';
    registry.register({ sourceId: 'browser-source', streamFamily: 'browser.streamed',
      capabilities: { v: 1, sourceId: 'browser-source', sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
        inputMode: 'shared', sidebands: [], health: { status: 'available' } },
      adapter: { start: async () => ({ ok: true, session: { stop: () => undefined,
        applySidebandControl: control => { if (control.kind === 'keyboard_text') receivedText += control.text; return { ok: true }; },
      } }) },
    });
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({ liveStreamCaptureRegistry: registry }));
    const relay = createMachineLiveStreamRelayTerminator({ machineId: 'machine_source',
      captureAdapter: runtime.peerMediationMachineRpc?.stream?.captureAdapter, nowMs: () => 1_000, emitEnvelope: () => undefined });
    try {
      expect(await relay.start({ v: 1, streamId: 'stream', streamFamily: 'browser.streamed', sourceId: 'browser-source',
        sourceMachineId: 'machine_source', targetMachineId: 'machine_target', routeKind: 'server_relay',
        authorization: { payload: { v: 1, grantId: 'grant', accountId: 'account', flowKind: 'live_stream',
          routeKind: 'server_relay', sourceMachineId: 'machine_source', targetMachineId: 'machine_target', streamId: 'stream',
          streamFamily: 'browser.streamed', sourceId: 'browser-source', iat: 1_000, exp: 61_000,
          aud: 'happier-live-stream-relay-authorization' }, signature: { keyId: 'key', alg: 'Ed25519', valueBase64Url: 'AQID' } },
      }, 'present_user')).toEqual({ ok: true, streamId: 'stream' });
      expect(relay.applyControl({ v: 1, sourceMachineId: 'machine_source', targetMachineId: 'machine_target',
        message: { kind: 'sideband_control', control: { v: 1, streamId: 'stream', sourceId: 'browser-source',
          eventId: 'typing', kind: 'keyboard_text', text: 'HUMAN' } },
      })).toEqual({ ok: true });
      expect(receivedText).toBe('HUMAN');
    } finally { await relay.dispose(); }
  });
});
