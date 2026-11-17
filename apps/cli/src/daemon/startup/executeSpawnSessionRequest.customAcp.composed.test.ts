import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { SessionTurnMutationV1Schema, type SessionTurnMutationV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import { activateSessionsRoleForMachineClient } from '@/daemon/testkit/sessionsRole.testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ChildProcess, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { startSessionHost } from '@/agent/runtime/lifecycle/sessionHost';
import { sessionProcessEnvironment, readHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { accountSettingsParse, FeaturesResponseSchema, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, ExecutionRunListResponseSchema,
  verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { AgentExecutionTargetV1Schema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { configuration } from '@/configuration';
import { ApiClient } from '@/api/api';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createDeferred } from '@/testkit/async/deferred';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';
import { SESSION_REQUESTED_DIRECTORY_ENV } from '@/agent/runtime/resolveRequestedSessionDirectory';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { QualifiedConnectedAccountPurposeBindingsV1Schema } from '@happier-dev/protocol';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  commitActiveAcpCatalog, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { AgentRuntimeRunnerBootstrapV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { resolveAccountConfiguredAcpLaunchForAgent } from '@/agent/runtime/registry/engineRegistry/accountConfiguredAcp';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { executeSpawnSessionRequest, type ExecuteSpawnSessionRequestParams } from './executeSpawnSessionRequest';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { prepareCgroupProcessLaunchScope } from '../platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { SpawnSessionControlErrorResponseSchema, projectSpawnSessionControlErrorResponse } from '@/session/shared/spawnSessionContract';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { resolveTrackedSessionTerminalPresentation } from '../sessions/resolveTrackedSessionTerminalPresentation';
import { projectResolvedAgentBackendTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import { requireCatalogEntry } from '@/agent/catalog/registry';
import { buildHappySessionControlArgs } from '../sessionSpawnArgs';
import { resolveDaemonCliSubcommandFromBackendTarget } from '../backendTargetRouting';
import { HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '../agentRuntime/sessionBridgeAuthorization';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { logger } from '@/ui/logger';
import { createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot, createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture, createCompactSessionListQueryResponseFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import { awaitTrackedRunnerAgentSessionOpen } from '../agentRuntime/runnerAgentSessionOpenAttestation';
import type { TrackedSession } from '../types';
import { resolveEntrypointIdentityFromLaunchSpec } from '../sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { captureProcessBirthWitness, readProcessIdentityByPid } from '../processIdentity';
import * as processTermination from '@/processes/terminate/terminateProcessTree';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { createOnChildExited } from '../sessions/onChildExited';
import { readOrCreateDeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { createDaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema,
  StoredSessionOwnerMetadataEnvelopeV1Schema, StoredSessionSharedMetadataV1Schema,
  projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readPermissionModeIntentFromMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { V2SessionByIdResponseSchema, type V2SessionByIdResponse } from '@happier-dev/protocol/sessions/control/contract';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { readRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionContext';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import { createMachineSessionDirectTargetTransport } from '@/rpc/handlers/sessionServerStartLifecycleAdapter';
import { bindRequesterSessionRuntimeMachineAdmissionCurrentness, createRequesterSessionRuntimeContextResolver,
  admitRequesterSessionBootstrap, prepareRequesterSessionBootstrap, readRequesterSessionCredentialsForChild,
  verifyRequesterSessionMachineAdmissionCurrent, releaseUnretainedRequesterSessionRuntimeContext,
  resolveRequesterSessionBootstrapFromCustody, requesterSessionCredentialPath, type RequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import { replacePrivateBearerFile } from '../privateBearerFile';
import { readStoredCredentialsForServerId, sameStoredCredentials, writeStoredCredentialsForServerId } from '@/persistence';
import { createRequesterSessionRuntimeContext } from '../sessionEncryption/createRequesterSessionRuntimeContext';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { readOrCreateInstallationIdentity } from '../identity/store';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof, RequesterSessionCurrentnessPurposeV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { ApiMachineClient } from '@/api/apiMachine';
import { createInstalledProjectFiniteRuntime } from './createInstalledProjectFiniteRuntime';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { createDaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { notifyDaemonSessionStarted } from '../controlClient';
import * as daemonControlHttp from '../controlHttp';
import { createRunnerAgentSessionRuntimeBootstrap, createRunnerAgentSessionRuntimeSource } from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import { authorizeResolvedAgentNativeExecLaunchForHost, issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { requestSessionStop } from '@/session/services/requestSessionStop';
import { setSessionArchivedState } from '@/session/services/setSessionArchivedState';
import * as machineRpcTransport from '@/session/transport/rpc/machineRpc';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { buildAcpConfiguredBackendV1 } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeStoredCredentials, encodeStoredCredentials } from '@/persistence';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { resolveSessionRoleRpcOrigin } from '@/session/actions/sessionRoleRpcOrigin';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListRequestV1Schema, ProjectAccountRowListResponseV1Schema,
  ProjectAccountRowReadRequestV1Schema, ProjectAccountRowReadResponseV1Schema, ProjectAccountRowV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { decodeExternalActionResolvedTargetV1, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions';
import { createInstalledMachineRpcDatabaseBoundary, createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createPersistedTakeoverAdmissionWaiter } from '@/daemon/spawn/persistedTakeoverAdmission';
import { resolveExternalSessionOperationAccountScope } from '@/session/actions/externalSessions/operationRecordStore';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { readBundledPluginAvailabilityHttpFixture } from '@/plugins/testkit/bundledPluginAvailabilityHttpFixture';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { QualifiedConnectedAccountGroupV4Schema, QualifiedConnectedAccountListResponseV4Schema,
  ProviderAccountUsageSnapshotV1Schema, buildProviderAccountUsageRecordId, buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from '../connectedServices/runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';
import { buildInactiveSessionResumeSpawnOptions } from '../sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';

import { PassThrough } from 'node:stream';
import { userInfo } from 'node:os';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { buildMemberAgentInstallEnvironment } from '@/capabilities/installJobs/memberInstallEnvironment';
import { runMemberAgentInstallEffect } from '@/capabilities/installJobs/memberInstallEffect';
import { resolveMemberAgentInstallCli } from '@/capabilities/installJobs/memberResolveEffect';
import { NativeSessionDirectoryCommandSchema, executeNativeSessionDirectoryPreparation } from '@/rpc/handlers/fileSystem/sessionDirectoryEffect';
import { SESSION_TRACKING_KEY_ENV, legacyPidSessionTrackingKey, trackedSessionForSingleSessionProcess, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const sessionChanges = createSessionLiveWorkProducer({
  readSessions: () => [],
  readActivity: async () => ({ session: 'unknown', input: 'unknown' }),
});

const preflightHome = vi.hoisted(() => ({ database: null as ReturnType<typeof createInstalledMachineRpcDatabaseBoundary> | null }));
// Only persistence is substituted. The UI CALL handler produces admission
// from these Machine/grant rows; no test authors a machineAdmission context.
vi.mock('../../../../server/sources/storage/db', () => ({
  get db() {
    if (!preflightHome.database) throw new Error('Preflight Home database is not installed');
    return preflightHome.database.db;
  },
  getDbProviderFromEnv: () => 'postgres',
}));

const memberRunAs = vi.hoisted(() => ({ resolvedPath: '', sessionLaunches: null as string[] | null }));
// The member RunAs process is the OS boundary: answer the member's own Agent lookup
// as that process would. Member selection, admission and the spawn path stay real.
vi.mock('@/daemon/agentIsolation/runMemberNativeOperation', async importOriginal => {
  const actual = await importOriginal<typeof import('@/daemon/agentIsolation/runMemberNativeOperation')>();
  return { ...actual, runMemberAgentEffect: async (input: Parameters<typeof actual.runMemberAgentEffect>[0]) => {
    const request = input.request as { kind?: unknown };
    if (!memberRunAs.resolvedPath || request.kind !== 'resolve') return await actual.runMemberAgentEffect(input);
    await input.launch.release();
    return input.readRecord({ t: 'resolved', launch: { source: 'managed', resolvedPath: memberRunAs.resolvedPath,
      command: memberRunAs.resolvedPath, args: [] } });
  } };
});
const storage = vi.hoisted(() => ({ home: '', persistedToken: 'df38-owner-token',
  credentials: { token: 'df38-owner-token', encryption: null }, io: vi.fn(),
  ordinaryStoredCredentials: false,
  runnerCommand: '', runnerExited: false, sourceChecks: null as Array<{ command: string; args: string[] }> | null,
  sessionHostCleanups: [] as Array<() => Promise<void>>,
  beforeTerminalAttachmentRead: null as (() => Promise<void>) | null,
  runnerBootstrapPath: '',
  runnerWrapperPid: 0,
  runnerWrapperStartTimeMs: 2,
  procfsRoot: '',
  runnerLaunches: [] as Array<{ command: string; args: string[] }>,
  uncertainTmuxCommands: null as string[][] | null,
  runnerSpawn: null as ((args: string[], env: NodeJS.ProcessEnv, cwd?: string) => import('node:child_process').ChildProcess) | null,
  daemonPort: 0, daemonControlToken: '' }));
vi.mock('socket.io-client', async importOriginal => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return { ...actual, io: (...args: Parameters<typeof actual.io>) => {
    const auth = args[1]?.auth;
    return auth && typeof auth === 'object' && Reflect.get(auth, 'clientType') === 'user-scoped'
      ? actual.io(...args) : storage.io(...args);
  } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]).endsWith('cpr536restart0000000000001.host.json')) {
      await storage.beforeTerminalAttachmentRead?.();
    }
    return actual.readFile(...args);
  }, open: async (...args: Parameters<typeof actual.open>) => {
    const path = String(args[0]);
    if (!storage.procfsRoot || !path.startsWith(`/proc/${storage.runnerWrapperPid}/`)) return actual.open(...args);
    if (storage.runnerExited) throw Object.assign(new Error('Synthetic runner exited'), { code: 'ENOENT' });
    return actual.open(join(storage.procfsRoot, path.slice(`/proc/${storage.runnerWrapperPid}/`.length)), args[1], args[2]);
  }, readdir: (async (...args: Parameters<typeof actual.readdir>) => {
    const path = String(args[0]);
    if (storage.procfsRoot && path === '/proc') return [String(process.pid), ...(storage.runnerExited ? [] : [String(storage.runnerWrapperPid)])];
    if (storage.procfsRoot && path.startsWith(`/proc/${storage.runnerWrapperPid}/`)) {
      if (storage.runnerExited) throw Object.assign(new Error('Synthetic runner exited'), { code: 'ENOENT' });
      return actual.readdir(join(storage.procfsRoot, path.slice(`/proc/${storage.runnerWrapperPid}/`.length)));
    }
    return actual.readdir(...args);
  // Only the procfs string-list overload is substituted; ordinary reads retain theirs.
  }) as typeof actual.readdir };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const [command, argv] = args;
    if (storage.uncertainTmuxCommands && command === 'tmux' && Array.isArray(argv)) {
      // The tmux process is the OS boundary. Real terminal admission, window
      // reconciliation and the daemon's uncertain-launch ownership stay active.
      storage.uncertainTmuxCommands.push([...argv]);
      const child = new actual.ChildProcess();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => child.emit('close', argv.includes('new-window') || argv.includes('new-session') || argv.includes('list-windows') || argv.includes('kill-window') ? 1 : 0, null));
      return child;
    }
    if (storage.sourceChecks && command === process.execPath && Array.isArray(argv)
      && argv[0] === join(process.cwd(), 'scripts', 'syncSharedDepsForDev.mjs')) {
      // Observe the obsolete build subprocess at the OS boundary; source
      // launches must resolve current workspace imports without invoking it.
      storage.sourceChecks.push({ command, args: [...argv] });
      const processCheck = new actual.ChildProcess();
      process.nextTick(() => processCheck.emit('close', 0, null));
      return processCheck;
    }
    const options = args[2];
    if (storage.runnerSpawn && Array.isArray(argv) && argv.includes('session-host')) {
      // The OS process is synthetic; the actual host admits each Session over
      // its owner-only endpoint and runs the retained command in its scope.
      const hostProcess = new EventEmitter();
      const child = new actual.ChildProcess();
      Object.defineProperty(child, 'pid', { value: storage.runnerWrapperPid });
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true;
      storage.runnerCommand = [command, ...argv].join(' ');
      const exit = (code: number) => { child.exitCode = code; child.emit('exit', code, null); child.emit('close', code, null); };
      const hostReady = startSessionHost({ process: hostProcess, exit,
        readTrustedCaller: () => captureProcessBirthWitness(process.pid),
        runSessionCommand: async sessionArgs => {
          const runChild = storage.runnerSpawn;
          if (!runChild) throw new Error('Missing synthetic Session command');
          storage.runnerSpawn = null;
          const session = runChild([...sessionArgs], sessionProcessEnvironment(), readHostedSessionScope()?.workingDirectory);
          const termination = registerRunnerTerminationHandlers({ process: hostProcess, exit,
            onTerminate: () => { session.exitCode = 0; session.emit('exit', 0, null); } });
          try { await new Promise<void>(resolve => session.once('exit', () => resolve())); }
          finally { termination.dispose(); }
        },
      });
      let cleanup: Promise<void> | undefined;
      const closeHost = () => cleanup ??= (async () => {
        const host = await hostReady;
        hostProcess.emit('SIGTERM');
        await host.whenEnded;
      })();
      storage.sessionHostCleanups.push(closeHost);
      onTestFinished(closeHost);
      void hostReady.then(() => {
        child.stdout?.write(`happier-session-host-ready ${process.pid}\n`);
      }, error => { child.stderr?.write(String(error)); exit(1); });
      return child;
    }
    if (storage.runnerSpawn && storage.runnerBootstrapPath && Array.isArray(argv)
      && options?.env?.HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE === storage.runnerBootstrapPath) {
      storage.runnerLaunches.push({ command, args: [...argv] });
      const entrypoint = resolveEntrypointIdentityFromLaunchSpec({ filePath: command, args: argv });
      if (entrypoint.status !== 'known') throw new Error('Own runner launch has no canonical CLI entrypoint');
      // The route's published startup argv precedes the Session control args.
      // Its physical entrypoint can be source, admitted dist or a binary; the
      // exact private bootstrap scopes this OS adapter to this one child.
      const startupFlagIndex = argv.indexOf('--happy-starting-mode');
      if (startupFlagIndex < 1) throw new Error('Own runner omitted the installed CLI startup contract');
      storage.runnerCommand = [command, ...argv].join(' ');
      const runChild = storage.runnerSpawn;
      storage.runnerSpawn = null;
      return runChild(argv.slice(startupFlagIndex - 1), options.env, options.cwd === undefined ? undefined : String(options.cwd));
    }
    if (memberRunAs.sessionLaunches && Array.isArray(argv) && argv.includes('--happy-starting-mode')) {
      memberRunAs.sessionLaunches.push(String(options?.cwd));
      throw new Error('Observed member session launch boundary');
    }
    return actual.spawn(...args);
  } };
});
// The in-process child retains real admission and runtime code; only its OS
// process command identity differs from Vitest's actual worker command.
vi.mock('../processIdentity', async importOriginal => {
  const actual = await importOriginal<typeof import('../processIdentity')>();
  return { ...actual, readProcessIdentityByPid: async (pid: number) => storage.runnerCommand && (pid === process.pid || pid === storage.runnerWrapperPid)
    // The synthetic runner may exit; the Vitest process still owns filesystem locks.
    ? storage.runnerExited && pid === storage.runnerWrapperPid ? null : { pid, command: storage.runnerCommand, processStartTimeMs: pid === storage.runnerWrapperPid ? storage.runnerWrapperStartTimeMs : 1 }
    : await actual.readProcessIdentityByPid(pid) };
});
vi.mock('../processRunState', async importOriginal => {
  const actual = await importOriginal<typeof import('../processRunState')>();
  return { ...actual, readProcessRunState: async (pid: number) => storage.runnerCommand && (pid === process.pid || pid === storage.runnerWrapperPid)
    ? storage.runnerExited ? 'dead' : 'servable'
    : await actual.readProcessRunState(pid) };
});
// OS/environment boundaries only: real admission, catalog, activation, Account custody,
// launch resolution, bootstrap publication and its strict consumer remain in the path.
vi.mock('@/configuration', async importOriginal => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual,
  configuration: { ...actual.configuration, get happyHomeDir() { return storage.home; },
    get settingsFile() { return join(storage.home, 'settings.json'); },
    get activeServerDir() { return join(storage.home, 'servers', 'active'); },
    get daemonStateFile() { return join(storage.home, 'daemon.state.json'); },
    get daemonLockFile() { return join(storage.home, 'daemon.lock'); },
    get logsDir() { return `${storage.home}/logs`; },
    get serversDir() { return join(storage.home, 'servers'); },
    get privateKeyFile() { return join(storage.home, 'private-key.json'); },
    get legacyPrivateKeyFile() { return join(storage.home, 'legacy-private-key.json'); },
    get installationIdentityFile() { return join(storage.home, 'installation-identity.json'); },
    get deviceLocalSecretKeyFile() { return join(storage.home, 'device-local-secret-key.json'); },
    activeServerId: 'df38-home', serverUrl: 'https://df38.example.test',
    apiServerUrl: 'https://df38.example.test', publicServerUrl: 'https://df38.example.test',
    publicReleaseRing: 'stable' },
  };
});
vi.mock('@/persistence', async importOriginal => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return { ...actual,
  // A privately admitted child must exercise the real scoped-file decoder;
  // the legacy fixture only substitutes the ordinary terminal credential file.
  readStoredCredentials: async () => process.env.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE !== undefined
    ? await actual.readStoredCredentials() : storage.ordinaryStoredCredentials
      ? await actual.readStoredCredentialsForServerId('df38-home') : { ...storage.credentials, token: storage.persistedToken },
  readSettings: async () => ({ ...await actual.readSettings(), machineId: 'df38-machine' }),
  readDaemonState: async () => storage.daemonPort ? { pid: process.pid, httpPort: storage.daemonPort,
    controlToken: storage.daemonControlToken, startedAt: 1, startedWithCliVersion: 'test' } : null,
  };
});

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
let api: ApiClient;
let runtimeHome = '';
let restoreCatalogReads: (() => void) | undefined;
let fixtureCatalogRow: AcpCatalogSnapshotV1 | undefined;
let spawnEnvironment: ReturnType<typeof createSpawnHappyCliEnvScope>;
let requesterHome: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
beforeAll(async () => {
  storage.home = await mkdtemp(join(tmpdir(), 'happier-df38-spawn-'));
  runtimeHome = storage.home;
  // Account observers are shared with the daemon's plugin runtime. Their Home
  // endpoint must remain available until that runtime retires, across cases.
  requesterHome = await createRequesterCurrentnessSocketHarness();
  installFixturePluginAvailabilityBoundary();
  runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
    controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.agent.custom-acp', 'happier.agent.claude', 'happier.agent.codex', 'happier.agent.opencode', 'happier.scm.backend.git'] } });
  await runtime.registry.activateContributionsOnDemand([
    { pluginId: 'happier.agent.custom-acp', family: 'agents', localId: 'custom-acp' },
    { pluginId: 'happier.agent.claude', family: 'agents', localId: 'claude' },
    { pluginId: 'happier.agent.codex', family: 'agents', localId: 'codex' },
    { pluginId: 'happier.agent.opencode', family: 'agents', localId: 'opencode' },
    { pluginId: 'happier.scm.backend.git', family: 'scmBackends', localId: 'git' },
  ]);
  api = await ApiClient.create(storage.credentials);
});
afterAll(async () => {
  await runtime?.dispose();
  await requesterHome?.close();
  resetActiveAccountSettingsSnapshotForTests();
  await rm(runtimeHome, { recursive: true, force: true });
});
async function closeFixtureSessionHosts() {
  await Promise.all(storage.sessionHostCleanups.splice(0).map(close => close()));
}
beforeEach(async () => {
  // Test-finish callbacks run in reverse registration order. Each case first
  // retires its transports, then this shared teardown removes their Home.
  onTestFinished(async () => {
    await closeFixtureSessionHosts();
    spawnEnvironment.restore();
    restoreCatalogReads?.();
    restoreCatalogReads = undefined;
    await rm(storage.home, { recursive: true, force: true });
    storage.home = runtimeHome;
  });
  spawnEnvironment = createSpawnHappyCliEnvScope();
  spawnEnvironment.patch({ HAPPIER_CLI_SUBPROCESS_PREFER_TSX: 'true',
    HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined, HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '0' });
  // The fixture controller remains one real daemon occurrence, but each
  // process replay owns its own Home/markers, just as distinct workers do.
  storage.home = await mkdtemp(join(tmpdir(), 'happier-df42-runner-'));
  await mkdir(configuration.activeServerDir, { recursive: true });
  storage.persistedToken = storage.credentials.token;
  resetServerFeaturesClientForTests();
  installFixturePluginAvailabilityBoundary();
  await seedTestServerProfile({ id: 'df38-home', homeId: 'srv_df38_owner', serverUrl: configuration.serverUrl });
  resetActiveAccountSettingsSnapshotForTests();
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
    scopeKey: resolveAccountSettingsScopeKey(storage.credentials), settingsVersion: 4,
    loadedAtMs: 1, settingsSecretsReadKeys: [],
    acpCatalog: { status: 'ready', revision: 4, record: AcpCatalogRecordV1Schema.parse({ v: 1,
      definitions: ['alpha', 'beta', 'missing'].map(id => ({ id, name: id, title: id,
        launch: { kind: 'command', command: id === 'missing' ? join(storage.home, 'missing-goose') : process.execPath, args: [`${id}.mjs`] },
        defaultModel: 'authored/default',
        env: { DF38_SELECTION: { t: 'literal', v: id }, DF41_TARGET_KEY: { t: 'literal', v: buildBackendTargetKeyV2({
          kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: id }) } },
        capabilities: { supportsLoadSession: true, supportsModes: 'unknown', supportsModels: 'unknown',
          supportsConfigOptions: 'unknown', promptImageSupport: 'no' }, createdAt: 1, updatedAt: 2 })) }) } });
  fixtureCatalogRow = getActiveAccountSettingsSnapshot()?.acpCatalog;
  // Account HTTP is the boundary: admission still hydrates and opens the real catalog.
  const reads = vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    const catalog = readFixtureCatalogResponse(path);
    if (catalog) return catalog;
    if (path === '/v1/account/encryption/currentness') return homeResponse(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    throw new Error(`Unexpected Home GET ${path}`);
  });
  restoreCatalogReads = () => reads.mockRestore();
});

function params(definitionId: string, beforeSessionRunnerLaunch: () => Promise<boolean>): ExecuteSpawnSessionRequestParams {
  return { options: { directory: storage.home,
      agentTarget: AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId }),
      beforeSessionRunnerLaunch }, credentials: storage.credentials,
    api,
    connectedServicesMaterializationBaseDir: join(storage.home, 'connected-services'),
    connectedServiceRefreshCoordinator: null, connectedServiceQuotasCoordinator: null,
    connectedServiceRuntimeRegistry: { registerTarget: () => {} },
    activateSessionPurposeBindings: createNativePurposeBindingFixture().activateSessionPurposeBindings,
    trackedSessionsByKey: new Map(), spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(),
    spawnWebhookTimeoutByKey: new Map(), spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
    resolveCanonicalTrackedSessionId: () => '', onChildExited: () => {},
    processEnv: { ...process.env } };
}

function homeResponse<T>(data: T, status = 200): AxiosResponse<T> {
  return { data, status, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

function createNativePurposeBindingFixture() {
  let bindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse({ v: 1, bindings: [] });
  return createConnectedAccountPurposeBindingOwner({
    // Persisted Account configuration is the boundary; binding authority stays real.
    store: { read: async () => bindings, update: async mutate => { bindings = mutate(bindings); return bindings; },
      subscribe: () => ({ dispose() {} }) },
    selectTarget: async () => { throw new Error('Native launch must not select connected credentials'); },
    resolveTarget: async () => null,
    materializeAccount: async () => { throw new Error('Native launch must not materialize connected credentials'); },
    projectTargetAccounts: async () => { throw new Error('Native launch must not list connected Accounts'); },
    assertTargetAccountMaterializable: async () => { throw new Error('Native launch must not disclose connected credentials'); },
  });
}

function fixtureMachineMetadata() {
  return MachinePublishedMetadataV1Schema.parse({
    host: 'fixture-machine', platform: process.platform, happyCliVersion: '0.3.0',
    homeDir: storage.home, happyHomeDir: storage.home,
  });
}

function machineAdmissionResponse(body: unknown, installation: Awaited<ReturnType<typeof readOrCreateInstallationIdentity>>) {
  if (!body || typeof body !== 'object' || !('context' in body) || !('proof' in body)) throw new Error('Missing actual Machine admission proof');
  const rpcAdmission = { context: SocketRpcMachineAdmissionContextV1Schema.parse(body.context),
    ...('method' in body ? { method: String(body.method) }
      : 'purpose' in body ? { purpose: RequesterSessionCurrentnessPurposeV1Schema.parse(body.purpose) } : {}) };
  const valid = verifyMachineInstallationProof({ publicKey: installation.publicKey,
    proof: MachineInstallationProofV1Schema.parse(body.proof), payload: {
      version: 1, accountId: 'df38-owner', machineId: 'df38-machine', installationId: installation.installationId, rpcAdmission,
    } });
  return homeResponse(valid ? { v: 1, ok: true } : { error: 'access_denied' }, valid ? 200 : 403);
}

async function installDirectoryPreflightRelay(channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>,
  machine: ApiMachineClient) {
  const installation = await readOrCreateInstallationIdentity();
  const previousDatabase = preflightHome.database;
  preflightHome.database = createInstalledMachineRpcDatabaseBoundary({ machineId: 'df38-machine', ownerAccountId: 'df38-owner', installation });
  const manager: unknown = Reflect.get(machine, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed directory preflight receiver');
  const previousIo = storage.io.getMockImplementation();
  const actualIo = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');
  storage.io.mockImplementation(actualIo.io);
  let relay: Awaited<ReturnType<typeof createInstalledMachineRpcRelay>>;
  try {
    relay = await createInstalledMachineRpcRelay({ manager, machineId: 'df38-machine', transportOwnerAccountId: 'df38-owner',
      methods: [RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT], ui: { installation, ownerAccountId: 'df38-owner' } });
  } finally {
    if (previousIo) storage.io.mockImplementation(previousIo); else storage.io.mockReset();
  }
  const stopForwarding = forwardInstalledMachineRpc(channel, relay);
  return async () => { stopForwarding(); await relay.close(); preflightHome.database = previousDatabase; };
}

function forwardInstalledMachineRpc(channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>,
  relay: Awaited<ReturnType<typeof createInstalledMachineRpcRelay>>) {
  // Redirect only the network endpoint. The actual client CALL carrier passes
  // through Home admission and each installed daemon owner.
  const detach: Array<() => void> = [];
  const connect = (socket: import('socket.io').Socket) => {
    const receive = (packet: unknown, acknowledge: (result: unknown) => void) => {
      if (!packet || typeof packet !== 'object' || !('method' in packet)
        || typeof packet.method !== 'string' || !packet.method.startsWith('df38-machine:') || !('params' in packet)) {
        throw new Error(`Unexpected directory preflight transport method: ${packet && typeof packet === 'object' && 'method' in packet ? String(packet.method) : 'missing'}`);
      }
      void relay.invokeUiRaw(packet.method.slice('df38-machine:'.length), packet.params, { packet }).then(acknowledge);
    };
    socket.on(SOCKET_RPC_EVENTS.CALL, receive);
    detach.push(() => socket.off(SOCKET_RPC_EVENTS.CALL, receive));
  };
  channel.server.on('connection', connect);
  for (const socket of channel.server.sockets.sockets.values()) connect(socket);
  return () => {
    channel.server.off('connection', connect);
    for (const stop of detach) stop();
  };
}

function createFixturePlainSession(body: unknown, sessionId: string,
  base: V2SessionByIdResponse['session'] = createSessionNotificationContextFixture(sessionId)): V2SessionByIdResponse['session'] {
  if (!body || typeof body !== 'object') throw new Error('Invalid Session create body');
  const sharedMetadata = 'sharedMetadata' in body ? body.sharedMetadata : null;
  if (!sharedMetadata || typeof sharedMetadata !== 'object' || !('ciphertext' in sharedMetadata)
    || typeof sharedMetadata.ciphertext !== 'string') throw new Error('Missing produced shared metadata');
  const ownerMetadata = StoredSessionOwnerMetadataEnvelopeV1Schema.parse('ownerMetadata' in body ? body.ownerMetadata : undefined);
  if (ownerMetadata.t !== 'plain') throw new Error('Expected the plain fixture Account');
  StoredSessionSharedMetadataV1Schema.parse(JSON.parse(sharedMetadata.ciphertext));
  const agentState = 'agentState' in body ? body.agentState : undefined;
  if (typeof agentState !== 'string' && agentState !== null) throw new Error('Invalid produced Agent state');
  if (!('metadataLayoutVersion' in body) || body.metadataLayoutVersion !== 1
    || !('encryptionMode' in body) || body.encryptionMode !== 'plain') throw new Error('Expected plain privacy-layout creation');
  return V2SessionByIdResponseSchema.parse({ session: { ...base, id: sessionId,
    encryptionMode: body.encryptionMode, metadataLayoutVersion: body.metadataLayoutVersion,
    share: null, ownerMetadata, agentState, metadata: sharedMetadata.ciphertext } }).session;
}

function installFixturePluginAvailabilityBoundary() {
  vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
    const path = new URL(String(url)).pathname;
    const availability = readBundledPluginAvailabilityHttpFixture(path, body);
    if (availability) return homeResponse(availability);
    throw new Error(`Unexpected fixture POST ${path}`);
  });
}

function readFixtureCatalogResponse(path: string) {
  if (path === '/v1/account/entity-rows/connected-accounts/purposes') {
    return homeResponse({ status: 'present', revision: 1,
      content: { t: 'plain', v: { key: 'purposes', value: QualifiedConnectedAccountPurposeBindingsV1Schema.parse({ v: 1, bindings: [] }) } } });
  }
  if (path !== '/v1/account/entity-rows/acp') return undefined;
  const catalog = fixtureCatalogRow;
  if (catalog?.status !== 'ready') throw new Error('Expected the configured ACP fixture');
  return homeResponse({ status: 'present', revision: catalog.revision, content: { t: 'plain', v: catalog.record } });
}

describe('Custom ACP fresh daemon launch composition', () => {
  it('refuses a busy local guest at Session birth before any target preparation or runner launch', async () => {
    const effects: string[] = [];
    const originalFetch = globalThis.fetch;
    onTestFinished(() => { vi.stubGlobal('fetch', originalFetch); });
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
      } }));
      if (path === '/v1/account/profile') return Response.json({ id: 'df38-owner' });
      throw new Error(`Unexpected busy target Home fetch ${path}`);
    });
    const previousPost = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      if (new URL(String(url)).pathname === '/v1/sessions') {
        effects.push('birth');
        throw Object.assign(new Error('Incumbent Session owns this guest'), { isAxiosError: true,
          response: { status: 409, data: { error: 'session-managed-target-busy' } } });
      }
      return previousPost(url, body, config);
    });
    const launch = params('alpha', async () => { effects.push('runner'); return false; });
    launch.openManagedSessionTarget = async () => { effects.push('guest'); throw new Error('Guest must not open before birth'); };
    const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'local-sandbox', creationKey: 'busy' });
    const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag, recipe: {
      execution: { machineId: 'df38-machine', directory: { kind: 'path', path: storage.home } },
      organization: { folderId: null, tagIds: [] }, agentTarget: launch.options.agentTarget,
      modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
      configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: 'persisted', terminal: null,
      agentSessionStartupInstructionsMarkerV1: null, checkout: null,
      managedCreation: { homeId: 'srv_df38_owner', managedId: 'busy-local', controller: { machineId: 'df38-machine', installationId: 'local-installation' } },
    } });
    const result = await executeSpawnSessionRequest({ ...launch, options: { ...launch.options,
      sessionCreationTag, sessionCreationCorrespondence: correspondence,
      managedTargetPlacement: { managedId: 'busy-local', workspaceRoot: '/workspace' } } });
    expect(result).toMatchObject({ type: 'error', errorDetail: { code: 'creation_conflict' } });
    expect(effects).toEqual(['birth']);
  });
  it.each(['failure', 'transport-disconnect', 'person-cancel'] as const)(
    'uses the admitted bootstrap requester and retains failed target birth for Retry unless the person Cancels (%s)', async outcome => {
    const attribution = { serverId: 'df38-home', accountId: 'df38-owner', machineId: 'df38-machine', installationId: 'requester-installation' };
    const sessionId = 'clocalcustody0000000000001';
    const targetEffects: string[] = [];
    const mutations: SessionTurnMutationV1[] = [];
    let row: V2SessionByIdResponse['session'] | undefined;
    const previousPost = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/sessions') {
        targetEffects.push('birth');
        row = createFixturePlainSession(body, sessionId);
        return homeResponse({ session: row, created: true, organizationPlacement: { folderId: null, tagIds: [] } });
      }
      if (path === `/v1/sessions/${sessionId}/turns/mutations`) {
        const mutation = SessionTurnMutationV1Schema.parse(body);
        mutations.push(mutation);
        return homeResponse({ ok: true, receipt: { v: mutation.v, sessionId, mutationId: mutation.mutationId,
          action: mutation.action, ...('turnId' in mutation ? { turnId: mutation.turnId } : {}),
          observedAt: mutation.observedAt, appliedAt: mutation.observedAt, decision: 'applied' } });
      }
      if (path === `/v2/sessions/${sessionId}/archive` && row) {
        row = { ...row, archivedAt: 123 };
        return homeResponse({ success: true, archivedAt: 123 });
      }
      return previousPost(url, body, config);
    });
    const previousRead = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      if (path === `/v2/sessions/${sessionId}` && row) return homeResponse({ session: row });
      if (path === '/v1/account/profile') return homeResponse({ id: attribution.accountId });
      if (path === '/v2/account/settings') return homeResponse({ content: { t: 'plain', v: {} }, version: 0 });
      return previousRead(url, config);
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/account/profile') return Response.json({ id: attribution.accountId });
      if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
      } }));
      throw new Error(`Unexpected requester fixture fetch ${path}`);
    });
    let requester: RequesterSessionRuntimeContext | null = null;
    try {
      const credentials = { ...storage.credentials, token: `fixture.${Buffer.from(JSON.stringify({ sub: attribution.accountId })).toString('base64url')}.signature` };
      const prepared = await prepareRequesterSessionBootstrap({ credentials, attribution,
        homeServerIdentityId: 'srv_df38_owner', boundary: { serverId: 'df38-home', serverHttpBaseUrl: configuration.serverUrl, happyHomeDir: storage.home },
        verifyMachineAdmissionCurrent: async () => true });
      if (!prepared) throw new Error('Requester bootstrap preparation failed');
      requester = await createRequesterSessionRuntimeContext({ providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap: prepared.admitted,
        activeServerDir: configuration.activeServerDir, connectedServicesMaterializationBaseDir: join(storage.home, 'connected-services'),
        resolveQualifiedConnectedAccountV4Support: () => 'indeterminate', coordinatorInput: {
          machineId: 'df38-machine', machineIdProvider: () => 'df38-machine', runtimeId: 'requester-identity-test', happyHomeDir: storage.home,
          logger: { debug() {}, info() {}, warn() {} }, processEnv: { NODE_ENV: 'test',
            HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
          trackedSessionsByKey: new Map(), connectedServiceRuntimeRegistry: new ConnectedServiceRuntimeRegistry(),
        } });
      if (!requester) throw new Error('Requester runtime preparation failed');
      const launch = params('alpha', async () => { throw new Error('Target refusal must prevent runner launch'); });
      const isolated: unknown[] = [];
      const placed: string[] = [];
      const placedBirths: unknown[] = [];
      const operations = createHostActionOperationRuntime({ machineId: attribution.machineId,
        resolveAccountId: async () => attribution.accountId, generateOperationId: () => 'placed-target-operation',
        supportsCoreCancellation: () => true });
      launch.prepareAgentIsolationMember = async input => { isolated.push(input.requesterWorkAttributionV1); return undefined; };
      launch.openManagedSessionTarget = async input => {
        targetEffects.push('guest'); placed.push(input.requesterAccountId);
        placedBirths.push(input);
        if (outcome === 'person-cancel') expect(operations.runner.cancel({ accountId: attribution.accountId,
          machineId: attribution.machineId }, 'placed-target-operation')).toEqual({ kind: 'requested' });
        throw Object.assign(new Error('unavailable'), { code: 'managed_target_unavailable',
          ...(outcome === 'transport-disconnect' ? { name: 'AbortError' } : {}) });
      };
      let result: Awaited<ReturnType<typeof executeSpawnSessionRequest>> | undefined;
      await operations.observeExecution({ actionId: 'session.spawn_new', input: {}, actionRequestId: 'placed-target-request',
        execute: async operation => {
          result = await executeSpawnSessionRequest({ ...launch, requesterSessionRuntimeContext: requester,
            options: { ...launch.options, requesterSessionBootstrap: prepared.admitted, projectSetupOperation: operation,
              spawnNonce: 'target-holder-nonce',
              requesterWorkAttributionV1: { ...attribution, accountId: 'different-inherited-account' },
              managedTargetPlacement: { managedId: 'unavailable-target', workspaceRoot: '/workspace' } } });
          return { ok: true, result: {} };
        } });
      expect(result).toMatchObject({ type: 'error', errorDetail: { code: 'managed_target_unavailable' } });
      expect(isolated).toEqual([prepared.admitted.attribution]);
      expect(placed).toEqual([prepared.admitted.attribution.accountId]);
      expect(placedBirths).toEqual([expect.objectContaining({ sessionId: 'target-holder-nonce', committedSessionId: sessionId })]);
      expect(targetEffects).toEqual(['birth', 'guest']);
      expect(mutations.map(mutation => mutation.action)).toEqual(['begin', 'fail']);
      expect(row?.archivedAt).toBe(outcome === 'person-cancel' ? 123 : null);
    } finally {
      if (requester) await releaseUnretainedRequesterSessionRuntimeContext(requester, []);
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it.skipIf(process.platform !== 'linux')('does not reject a member-installed Claude at the daemon precommit presence check', async () => {
    const home = join(storage.home, 'member');
    await mkdir(home);
    const spec = { ...getAgentCliRuntimeSpec('claude')!, manualInstallRecipes: { linux: [{ cmd: '/bin/sh', args: ['-c',
      'mkdir -p "$HOME/.local/bin"; printf "#!/bin/sh\\necho 2.1.322\\n" > "$HOME/.local/bin/claude"; chmod 755 "$HOME/.local/bin/claude"'] }] } };
    const input = new PassThrough(); const output = new PassThrough();
    let records = '';
    output.on('data', chunk => { records += String(chunk); if (records.includes('"t":"outcome"')) input.end(); });
    input.write(JSON.stringify({ kind: 'install', request: { agentId: 'claude', intent: 'install', consent: { vendorRecipe: true } },
      accountId: 'member', registry: { agents: [{ id: 'claude', runtimeSpec: spec }] }, targetInUse: false, runtimeManagedDependencyId: null }) + '\n');
    try {
      await runMemberAgentInstallEffect(input, output, new AbortController().signal, buildMemberAgentInstallEnvironment(home));
      expect(records).toContain('"kind":"succeeded"');
      expect(resolveMemberAgentInstallCli({ runtimeSpec: spec }, buildMemberAgentInstallEnvironment(home)))
        .toMatchObject({ resolvedPath: join(home, '.local/bin/claude') });
      const current = userInfo();
      const identity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home', requester: {
        serverId: 'server', accountId: 'member', machineId: 'df38-machine', installationId: 'installation',
      } }), home, username: current.username, agentUid: current.uid, agentGid: current.gid };
      const snapshot = { enabled: true, memberProvisioning: 'linuxUsersV1' as const,
        status: { kind: 'effective' as const, platform: 'linux' as const }, workspaceRoots: [home] };
      // The session process launch is the boundary past every daemon precommit check; stop there.
      memberRunAs.sessionLaunches = [];
      const launch = params('alpha', async () => true);
      launch.options = { directory: home, backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: { v: 2, bindingsByServiceId: {} } };
      launch.processEnv = { HOME: storage.home, PATH: '' };
      // Map only the native process boundary; directory preparation stays real.
      launch.prepareAgentIsolationMember = async () => ({ kind: 'member', identity, snapshot,
        requesterIdentity: { serverId: 'server', accountId: 'member', machineId: 'df38-machine', installationId: 'installation' } });
      // The daemon's Machine-level context, as startDaemon builds it: member placement, installed CLI, no member yet.
      launch.agentIsolation = { managedHappierBinaryPath: '/opt/happier/cli/current/happier', read: () => snapshot };
      memberRunAs.resolvedPath = join(home, '.local/bin/claude');
      launch.prepareNativeFilesystemEffect = async () => ({
        request: command => executeNativeSessionDirectoryPreparation(NativeSessionDirectoryCommandSchema.parse(command)),
        async dispose() {},
      });
      let reachedCommit = false;
      const originalFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: string | URL | Request) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
          encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
        } }));
        if (path === '/v1/account/profile') return Response.json({ id: 'df38-owner' });
        throw new Error(`Unexpected member launch Home fetch ${path}`);
      });
      const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const availability = readBundledPluginAvailabilityHttpFixture(new URL(String(url)).pathname, body);
        if (availability) return homeResponse(availability);
        const path = new URL(String(url)).pathname;
        reachedCommit = path === '/v2/sessions/lookup-by-tags' || path === '/v1/sessions';
        throw new Error('member_precommit_home_boundary');
      });
      try {
        const result = await executeSpawnSessionRequest(launch);
        expect({ launches: memberRunAs.sessionLaunches, reachedCommit }, JSON.stringify(result)).toEqual({ launches: [expect.any(String)], reachedCommit: false });
      } finally { writes.mockRestore(); vi.stubGlobal('fetch', originalFetch); }
    } finally { memberRunAs.resolvedPath = ''; memberRunAs.sessionLaunches = null; input.destroy(); output.destroy(); }
  });

  it.each(['quota', 'target', 'attach'] as const)('settles a committed Home Voice carrier after a pre-runner refusal (%s)', async refusal => {
    const sessionId = 'cvoiceretrydir111200000001';
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const accountId = '92fe29be-575b-4551-8e90-edaacc3ec7a4';
    const now = Date.now();
    const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'codex-pool' },
      incarnation: 'voice-retry-pool', displayName: 'Codex pool', policy: { autoSwitch: true, strategy: 'priority' },
      activeConnectedAccountId: accountId, generation: 1, runtimeStateRevision: 0, state: {}, createdAt: now, updatedAt: now,
      members: [{ v: 1, connectedAccountId: accountId, priority: 0, enabled: true, state: {}, createdAt: now, updatedAt: now }] });
    const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{ ref: { service, accountId },
      status: 'connected', authenticationModeId: 'oauth', configurationReady: false, configurationRevision: null,
      revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuv', scopes: [], providerIdentity: { accountId: 'voice-work' } }] });
    const usage = createProviderAccountUsageStore();
    const recordKey = { providerId: 'openai-codex', accountSubjectId: 'voice-work', subjectKind: 'account', quotaScope: 'account' } as const;
    usage.recordSnapshot(ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordKey,
      recordId: buildProviderAccountUsageRecordId(recordKey), providerId: recordKey.providerId,
      accountSubject: { kind: 'providerSubject', id: 'voice-work' }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'weekly', label: 'Weekly', remainingPct: 0, utilizationPct: 100, used: 100, limit: 100,
        unit: 'unknown', resetsAt: now + 60_000, status: 'ok', details: {} }] }), {
      sources: [{ serviceId: buildQualifiedPluginContributionKey(service), profileId: accountId,
        bindingKind: 'group_member', groupId: group.ref.groupId, groupGeneration: group.generation }],
    });
    const executable = await writeExecutableShim({ dir: storage.home, fileName: 'codex', contents: `#!${process.execPath}\nprocess.exit(0)\n` });
    const env = createEnvKeyScope(['HAPPIER_CODEX_PATH']);
    env.patch({ HAPPIER_CODEX_PATH: executable });
    let row: V2SessionByIdResponse['session'] | undefined;
    const mutations: SessionTurnMutationV1[] = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
      } }));
      if (path === '/v1/account/profile') return Response.json({ id: 'df38-owner' });
      throw new Error(`Unexpected Voice retry Home fetch ${path}`);
    });
    const originalGet = vi.mocked(axios.get).getMockImplementation();
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === `/v2/sessions/${sessionId}` && row) {
        if (refusal === 'attach') throw new axios.AxiosError('Home unavailable', 'ERR_BAD_RESPONSE', undefined, undefined,
          { ...homeResponse({ error: 'unavailable' }), status: 503 });
        return homeResponse({ session: row });
      }
      if (path === '/v4/connect/qualified/group') return homeResponse({ group });
      if (path === '/v4/connect/qualified/accounts') return homeResponse(accounts);
      if (originalGet) return await originalGet(url, options);
      throw new Error(`Unexpected Voice retry Home GET ${path}`);
    });
    // Home HTTP is the persistence boundary. Keep the real creation, attach,
    // allocation, quota selector, failure cleanup and Resume composition.
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      const path = new URL(String(url)).pathname;
      const availability = readBundledPluginAvailabilityHttpFixture(path, body);
      if (availability) return homeResponse(availability);
      if (path === '/v2/sessions/lookup-by-tags') return homeResponse({ sessions: [] });
      if (path === '/v1/sessions') {
        row = createFixturePlainSession(body, sessionId);
        return homeResponse({ session: row, created: true, organizationPlacement: { folderId: null, tagIds: [] } });
      }
      if (path === `/v1/sessions/${sessionId}/turns/mutations`) {
        const mutation = SessionTurnMutationV1Schema.parse(body);
        mutations.push(mutation);
        return homeResponse({ ok: true, receipt: { v: mutation.v, sessionId, mutationId: mutation.mutationId,
          action: mutation.action, ...('turnId' in mutation ? { turnId: mutation.turnId } : {}),
          observedAt: mutation.observedAt, appliedAt: mutation.observedAt, decision: 'applied' } });
      }
      if (path === `/v2/sessions/${sessionId}/archive` && row) {
        row = { ...row, archivedAt: 123 };
        return homeResponse({ success: true, archivedAt: row.archivedAt });
      }
      throw new Error(`Unexpected Voice retry Home POST ${path}`);
    });
    try {
      const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'voice-home', creationKey: 'retry-dir-1112' });
      const agentTarget = AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: { pluginId: service.pluginId, localId: 'codex' } });
      const connectedServices = { v: 2 as const, bindingsByServiceId: {
        [buildQualifiedPluginContributionKey(service)]: { source: 'connected' as const, selection: 'group' as const, groupId: group.ref.groupId },
      } };
      const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag,
        recipe: { execution: { machineId: 'df38-machine', directory: { kind: 'managed' } },
          organization: { folderId: null, tagIds: [] }, agentTarget, connectedServices,
          modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
          configuration: null, capabilitySelection: null, transcriptStorage: 'persisted',
          terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null } });
      const directories = createManagedSessionDirectories();
      const allocation = directories.prepareForCreation({ sessionCreationTag });
      const input = params('alpha', async () => { throw new Error('Exhausted pool must refuse before runner launch'); });
      const createCoordinator: NonNullable<ExecuteSpawnSessionRequestParams['createConnectedServiceLaunchAuthGroupCoordinator']> = async ({ applyGeneration }) =>
        createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({ token: storage.credentials.token,
          accountUsageStore: usage, nowMs: () => Date.now(), applyGeneration });
      const launch = { ...input, processEnv: { ...process.env }, providerAccountUsageStore: usage,
        createConnectedServiceLaunchAuthGroupCoordinator: createCoordinator };
      const quotaRefusal = { type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: 'no_eligible_member',
        errorDetail: { kind: 'launch_error', code: 'usage_limit', connectedAccountPool: {
          excluded: [expect.objectContaining({ profileId: accountId, reason: 'quota_exhausted' })],
        } } };
      const result = await executeSpawnSessionRequest({ ...launch, options: { ...input.options, agentTarget,
        directory: allocation.directory, directoryKind: 'managed', sessionCreationTag, sessionCreationCorrespondence: correspondence,
        connectedServices, creationAuthorization: { token: 'voice-home-create-admission' },
        ...(refusal === 'target' ? { managedTargetPlacement: { managedId: 'unavailable-target', workspaceRoot: '/workspace' } } : {}),
      } });
      if (refusal === 'target') {
        expect(row).toMatchObject({ archivedAt: null });
        expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
          errorDetail: { kind: 'launch_error', code: 'managed_target_unavailable' } });
        expect(mutations.filter(mutation => mutation.action === 'fail')).toEqual([expect.objectContaining({ issue: expect.objectContaining({ status: 'failed' }) })]);
        expect((await directories.listRecords()).find(record => record.allocationId === allocation.allocationId)).toMatchObject({ sessionId });
        return;
      }
      if (refusal === 'attach') {
        expect(result).toMatchObject({ type: 'error' });
        expect(row).toMatchObject({ archivedAt: 123 });
        expect((await directories.listRecords()).find(record => record.allocationId === allocation.allocationId)).toMatchObject({ sessionId });
        expect((await lstat(allocation.directory)).isDirectory()).toBe(true);
        expect(mutations.filter(mutation => mutation.action === 'fail')).toEqual([expect.objectContaining({ issue: expect.objectContaining({ status: 'failed' }) })]);
        return;
      }
      expect(result).toMatchObject(quotaRefusal);
      expect(mutations.filter(mutation => mutation.action === 'fail')).toEqual([expect.objectContaining({ issue: expect.objectContaining({ status: 'failed' }) })]);
      if (!row) throw new Error('Quota failure must happen after Home commits the carrier');
      expect((await directories.listRecords()).find(record => record.allocationId === allocation.allocationId))
        .toMatchObject({ sessionId });
      expect((await lstat(allocation.directory)).isDirectory()).toBe(true);
      const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
      if (owner.t !== 'plain') throw new Error('Expected plain fixture carrier');
      const metadata = projectSessionOwnerCompatibilityViewV1({
        sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(row.metadata!)), ownerMetadata: owner.v,
      });
      const retry = buildInactiveSessionResumeSpawnOptions({ sessionId, rawSession: row, metadata });
      if (!retry) throw new Error('Committed carrier must be eligible for ordinary Resume');
      expect(retry.existingSessionId).toBe(sessionId);
      expect(retry.directory).toBe(allocation.directory);
      // Before the fix rollback removed the unbound allocation here, so this
      // real reattach returned SESSION_DIRECTORY_MISSING instead of quota.
      expect(await executeSpawnSessionRequest({ ...launch, options: { ...retry,
        beforeSessionRunnerLaunch: input.options.beforeSessionRunnerLaunch } })).toMatchObject(quotaRefusal);
      expect(await directories.resolveForSession({ sessionId, path: allocation.directory, sessionCreationTag }))
        .toMatchObject({ ok: true, directory: allocation.directory });
    } finally {
      env.restore(); reads.mockRestore(); writes.mockRestore(); vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('seeds an already committed managed replay-fork before entering its runner launch', async () => {
    const directories = createManagedSessionDirectories();
    const source = await directories.materializeForFreshSpawn({ sessionCreationTag: 'replay-source' });
    await directories.bind({ allocationId: source.allocationId, sessionId: 'replay-source' });
    await writeFile(join(source.directory, 'retained.txt'), 'fork workspace contents');
    const sessionId = 'creplayseed000000000000001';
    const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'session.fork:replay-source', creationKey: 'seeded-child' });
    const target = directories.prepareForCreation({ sessionCreationTag });
    let reachedRunnerLaunch = false;
    const prepared = params('alpha', async () => {
      expect(await readFile(join(target.directory, 'retained.txt'), 'utf8')).toBe('fork workspace contents');
      reachedRunnerLaunch = true;
      // The process boundary refuses launch; committed birth and seeded files
      // must survive this ordinary pre-launch refusal.
      return false;
    });
    const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag,
      recipe: { execution: { machineId: 'df38-machine', directory: { kind: 'managed' } },
        organization: { folderId: null, tagIds: [] }, agentTarget: prepared.options.agentTarget,
        modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
        configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
        terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null },
    });
    const fields = buildSessionMetadataEnvelopeFields({ credentials: storage.credentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', agentState: null, metadata: { path: target.directory, machineId: 'df38-machine',
        sessionDirectoryV1: { v: 1, kind: 'managed' }, sessionCreationCorrespondenceV1: correspondence } });
    const row = V2SessionByIdResponseSchema.parse({ session: { ...createSessionNotificationContextFixture(sessionId),
      encryptionMode: 'plain', metadataLayoutVersion: 1, machineId: 'df38-machine', share: null,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState } }).session;
    const originalGet = vi.mocked(axios.get).getMockImplementation();
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      if (new URL(String(url)).pathname === `/v2/sessions/${sessionId}`) return homeResponse({ session: row });
      if (originalGet) return await originalGet(url, options);
      throw new Error('Missing replay-fork Home read boundary');
    });
    try {
      const result = await executeSpawnSessionRequest({ ...prepared, options: { ...prepared.options,
        directory: target.directory, directoryKind: 'managed', existingSessionId: sessionId,
        sessionCreationTag, freshSessionCreation: true,
        managedDirectorySeed: { sourceSessionId: 'replay-source', sourceSessionCreationTag: 'replay-source', sourcePath: source.directory },
      } });
      expect(await directories.listRecords()).toEqual(expect.arrayContaining([
        expect.objectContaining({ allocationId: target.allocationId, sessionId, sessionCreationTag }),
      ]));
      expect(reachedRunnerLaunch, result.type === 'error' ? result.errorMessage : result.type).toBe(true);
      expect(result).toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
      expect(await readFile(join(target.directory, 'retained.txt'), 'utf8')).toBe('fork workspace contents');
      expect(await readFile(join(source.directory, 'retained.txt'), 'utf8')).toBe('fork workspace contents');
    } finally { reads.mockRestore(); }
  });

  it.each([{ created: true, uncertain: false }, { created: false, uncertain: false }, { created: true, uncertain: true }])('retires only its newly created Session for a definite pre-runner refusal (created: $created, uncertain: $uncertain)', async ({ created, uncertain }) => {
    const sourceRoot = join(storage.home, 'source-bundle');
    const sourceEntrypoint = join(sourceRoot, 'apps/cli/src/index.mjs');
    const markerPath = join(storage.home, 'installed-dependencies');
    await mkdir(join(sourceRoot, 'apps/cli/src'), { recursive: true });
    await writeFile(sourceEntrypoint, uncertain ? '// Valid source entrypoint fixture.' : 'import "./removed-dependency.mjs";');
    await writeFile(markerPath, JSON.stringify({ identity: 'after-refresh' }));
    await writeFile(join(sourceRoot, 'source-bundle.json'), JSON.stringify({
      identity: 'refused-spawn-source-fixture', entrypoint: sourceEntrypoint,
      dependencyPublication: { identity: uncertain ? 'after-refresh' : 'before-refresh', generation: null, writerActive: false,
        markerPath, generationPath: join(storage.home, 'dependency-generation') },
    }));
    const sourceEnv = {
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: sourceEntrypoint,
      HAPPIER_STACK_CLI_ROOT_DIR: join(sourceRoot, 'apps/cli'),
      HAPPIER_CLI_ROOT_DIR: join(sourceRoot, 'apps/cli'),
      HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '0',
      HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: undefined,
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: undefined,
      HAPPIER_MANAGED_NODE_BIN: process.execPath,
    };
    const env = createEnvKeyScope(Object.keys(sourceEnv));
    const sessionId = 'crefusedsource000000000001';
    let row: V2SessionByIdResponse['session'] | undefined;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
      } }));
      if (path === '/v1/account/profile') return Response.json({ id: 'df38-owner' });
      throw new Error(`Unexpected refused-spawn Home fetch ${path}`);
    });
    const mutations: SessionTurnMutationV1[] = [];
    const originalSocket = storage.io.getMockImplementation();
    storage.io.mockReturnValue(createApiSessionSocketStub({ connected: true }));
    const originalGet = vi.mocked(axios.get).getMockImplementation();
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      if (new URL(String(url)).pathname === `/v2/sessions/${sessionId}` && row) return homeResponse({ session: row });
      if (originalGet) return await originalGet(url, options);
      throw new Error('Missing fixture Account read boundary');
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      const path = new URL(String(url)).pathname;
      const availability = readBundledPluginAvailabilityHttpFixture(path, body);
      if (availability) return homeResponse(availability);
      if (path === '/v2/sessions/lookup-by-tags') return homeResponse({ sessions: [] });
      if (path === '/v1/sessions') {
        row = createFixturePlainSession(body, sessionId);
        return homeResponse({ session: row, created, organizationPlacement: { folderId: null, tagIds: [] } });
      }
      if (path === `/v1/sessions/${sessionId}/turns/mutations`) {
        const mutation = SessionTurnMutationV1Schema.parse(body);
        mutations.push(mutation);
        return homeResponse({ ok: true, receipt: { v: mutation.v, sessionId, mutationId: mutation.mutationId,
          action: mutation.action, ...('turnId' in mutation ? { turnId: mutation.turnId } : {}),
          observedAt: mutation.observedAt, appliedAt: mutation.observedAt, decision: 'applied' } });
      }
      if (path === `/v2/sessions/${sessionId}/archive` && row) {
        row = { ...row, archivedAt: 123 };
        return homeResponse({ success: true, archivedAt: row.archivedAt });
      }
      throw new Error(`Unexpected refused-spawn Home POST ${path}`);
    });
    try {
      env.patch(sourceEnv);
      if (uncertain) {
        storage.uncertainTmuxCommands = [];
        await writeExecutableShim({ dir: storage.home, fileName: 'claude', contents: '#!/bin/sh\necho 2.1.322\n' });
      }
      const input = params('alpha', async () => true);
      const result = await executeSpawnSessionRequest({ ...input, processEnv: { ...process.env,
        ...(uncertain ? { PATH: `${storage.home}${delimiter}${process.env.PATH ?? ''}` } : {}) },
        options: { ...input.options, approvalProfileId: 'builtin:read-propose',
          ...(uncertain ? {
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            connectedServices: { v: 2 as const, bindingsByServiceId: {} },
            environmentVariables: { PATH: `${storage.home}${delimiter}${process.env.PATH ?? ''}`, ANTHROPIC_API_KEY: 'fixture-native-launch-only' },
            terminal: { mode: 'tmux' as const, tmux: { sessionName: 'uncertain-fixture', isolated: true } },
          } : {}) } });
      if (uncertain) {
        expect(storage.uncertainTmuxCommands?.some(args => args.includes('new-window') || args.includes('new-session')), JSON.stringify(result)).toBe(true);
        expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED' });
        expect(mutations).toEqual([]);
      } else {
        expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
          errorDetail: { kind: 'launch_error', code: 'SOURCE_RUNTIME_RELOAD_REQUIRED' } });
      }
      expect(row, JSON.stringify(result)).toBeDefined();
      expect(row?.archivedAt).toBe(created && !uncertain ? 123 : null);
      expect(input.trackedSessionsByKey.size).toBe(0);
      expect(input.spawnWebhookTimeoutByKey.size).toBe(0);
    } finally {
      storage.uncertainTmuxCommands = null;
      env.restore(); reads.mockRestore(); writes.mockRestore();
      vi.stubGlobal('fetch', originalFetch);
      storage.io.mockReset();
      if (originalSocket) storage.io.mockImplementation(originalSocket);
    }
  });

  it('refuses an unavailable recovered checkout before entering the runner launch', async () => {
    let enteredRunner = false;
    const prepared = params('alpha', async () => { enteredRunner = true; return false; });
    const result = await executeSpawnSessionRequest({ ...prepared, options: { ...prepared.options,
      checkoutCreationDraft: { kind: 'git_worktree', displayName: 'missing-source', baseRef: null, branchMode: 'new' },
    } });
    expect(result, JSON.stringify(result)).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
      errorDetail: { kind: 'launch_error', code: 'SPAWN_FAILED', message: 'checkout_unavailable' } });
    expect(enteredRunner).toBe(false);
  });

  it('realizes a recovered checkout draft and carries its nested directory to the Agent', async () => {
    const repository = join(storage.home, 'repository');
    const sourceDirectory = join(repository, 'packages', 'app');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'tracked.txt'), 'retained checkout source');
    // Git acts only on this isolated test repository; the shared checkout is untouched.
    const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    git('init', '--initial-branch=main');
    git('add', 'packages/app/tracked.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
    let runnerDirectory: string | undefined;
    let requestedDirectory: string | undefined;
    const prepared = params('alpha', async () => {
      const bootstrapDirectory = join(storage.home, 'tmp', 'runner-agent-session-bootstraps');
      const [file] = await readdir(bootstrapDirectory);
      storage.runnerBootstrapPath = join(bootstrapDirectory, file!);
      storage.sourceChecks = [];
      storage.runnerSpawn = (_args, env, cwd) => {
        runnerDirectory = cwd;
        requestedDirectory = env[SESSION_REQUESTED_DIRECTORY_ENV];
        throw new Error('Observed checkout runner launch boundary');
      };
      return true;
    });
    try {
      const result = await executeSpawnSessionRequest({ ...prepared, options: { ...prepared.options,
        directory: sourceDirectory,
        checkoutCreationDraft: { kind: 'git_worktree', displayName: 'bot-checkout', baseRef: 'main', branchMode: 'new' },
      } });
      const listed = git('worktree', 'list', '--porcelain');
      const checkout = listed.split('\n').find(line => line.startsWith('worktree ') && line !== `worktree ${repository}`)?.slice('worktree '.length);
      expect(checkout, JSON.stringify(result)).toBeDefined();
      expect(runnerDirectory, JSON.stringify(result)).toBe(process.cwd());
      expect(requestedDirectory, JSON.stringify(result)).toBe(join(checkout!, 'packages', 'app'));
      expect(await readFile(join(requestedDirectory!, 'tracked.txt'), 'utf8')).toBe('retained checkout source');
      expect(git('branch', '--show-current').trim()).toBe('main');
    } finally {
      storage.runnerSpawn = null;
      storage.runnerBootstrapPath = '';
      storage.sourceChecks = null;
    }
  });

  it('M-COV: materializes a first-Session directory through UI admission and refuses member preflight before filesystem effects', async () => {
    const originalCredentials = storage.credentials;
    const originalStoredCredentials = storage.ordinaryStoredCredentials;
    const originalIo = storage.io.getMockImplementation();
    onTestFinished(() => {
      storage.credentials = originalCredentials;
      storage.ordinaryStoredCredentials = originalStoredCredentials;
      storage.persistedToken = originalCredentials.token;
      if (originalIo) storage.io.mockImplementation(originalIo); else storage.io.mockReset();
      preflightHome.database = null;
    });
    const actualIo = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');
    storage.io.mockImplementation(actualIo.io);
    storage.credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'df38-owner', tokenEpoch: 1,
      provenance: { v: 1, kind: 'terminal', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    storage.persistedToken = storage.credentials.token;
    await writeStoredCredentialsForServerId('df38-home', storage.credentials);
    storage.ordinaryStoredCredentials = true;
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Missing canonical Account settings fixture');
    setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: resolveAccountSettingsScopeKey(storage.credentials) });
    await seedTestServerProfile({ id: 'df38-home', homeId: 'srv_preflight_owner', serverUrl: configuration.serverUrl });
    const installation = await readOrCreateInstallationIdentity();
    const database = createInstalledMachineRpcDatabaseBoundary({ machineId: 'df38-machine', ownerAccountId: 'df38-owner', installation,
      members: [{ accountId: 'member-use', accessLevel: 'view' }, { accountId: 'member-manage', accessLevel: 'admin' }] });
    preflightHome.database = database;
    let createdSession: V2SessionByIdResponse['session'] | undefined;
    const originalGet = vi.mocked(axios.get).getMockImplementation();
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return homeResponse({ id: 'df38-owner' });
      if (path === '/v1/account/encryption') return homeResponse({ mode: 'plain', updatedAt: 1 });
      if (path === '/v1/machines/df38-machine') return homeResponse({ machine: {
        ...createAvailableSessionSpawnMachineSnapshot('df38-machine'), installationId: installation.installationId,
        metadata: encodePlainMachineStoredContent(fixtureMachineMetadata()), metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
        access: { custodian: { accountId: 'df38-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
      } });
      if (path === '/v2/account/settings') return homeResponse({ content: { t: 'plain', v: snapshot.settings }, version: 4 });
      if (path === '/v1/account/settings') return homeResponse({ settings: null, settingsVersion: 0 });
      if (createdSession && path === `/v2/sessions/${createdSession.id}`) return homeResponse({ session: createdSession });
      if (originalGet) return originalGet(url, options);
      throw new Error(`Unexpected preflight GET ${path}`);
    });
    onTestFinished(() => get.mockRestore());
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      const path = new URL(String(url)).pathname;
      const availability = readBundledPluginAvailabilityHttpFixture(path, body);
      if (availability) return homeResponse(availability);
      if (path === '/v2/sessions/lookup-by-tags') return homeResponse({ sessions: [] });
      if (path === '/v1/sessions') {
        createdSession = createFixturePlainSession(body, 'cmcovfirstowner00000000001');
        return homeResponse({ session: createdSession, created: true, organizationPlacement: { folderId: null, tagIds: [] } });
      }
      if (path.endsWith('/access-key')) return homeResponse({ success: true });
      if (path === '/v1/machines/df38-machine/admission/verify') {
        if (!body || typeof body !== 'object' || !('context' in body) || !('proof' in body) || !('method' in body)) {
          throw new Error('Missing installation-signed admission request');
        }
        const context = SocketRpcMachineAdmissionContextV1Schema.parse(body.context);
        const proof = MachineInstallationProofV1Schema.parse(body.proof);
        const valid = verifyMachineInstallationProof({ publicKey: installation.publicKey, proof, payload: {
          version: 1, accountId: 'df38-owner', machineId: 'df38-machine', installationId: installation.installationId,
          rpcAdmission: { context, method: String(body.method) },
        } });
        return homeResponse(valid ? { v: 1, ok: true } : { error: 'access_denied' }, valid ? 200 : 403);
      }
      if (path === '/v1/home/governance/get') return homeResponse({ homeDefaults: null });
      throw new Error(`Unexpected preflight POST ${path}`);
    });
    onTestFinished(() => post.mockRestore());
    const originalFetch = globalThis.fetch;
    onTestFinished(() => { vi.stubGlobal('fetch', originalFetch); });
    vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return Response.json({ id: 'df38-owner' });
      if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({
        features: { sharing: { enabled: true, session: { enabled: true } } }, capabilities: { serverIdentity: { serverIdentityId: 'srv_preflight_owner' },
          encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' } },
      }));
      throw new Error(`Unexpected preflight fetch ${path}`);
    });
    const requesterChannel = requesterHome;
    const restoreRequestAdapter = installAxiosRequestMethodAdapter();
    onTestFinished(restoreRequestAdapter);
    const machine = new ApiMachineClient(storage.credentials.token, { id: 'df38-machine', encryptionMode: 'plain',
      metadata: fixtureMachineMetadata(), metadataVersion: 1, daemonState: null, daemonStateVersion: 0 }, undefined,
      { resolveCurrentServerIdentityId: () => 'srv_preflight_owner' });
    onTestFinished(() => machine.shutdown());
    const preflightDirectories: string[] = [];
    const ownerDirectory = join(storage.home, 'first-owner-directory');
    await activateSessionsRoleForMachineClient(machine, machine.setRPCHandlers({ spawnSession: async options => {
      const input = params('alpha', async () => {
        expect((await lstat(options.directory)).isDirectory()).toBe(true);
        preflightDirectories.push(options.directory);
        // The external runner process is outside this preflight contract.
        return false;
      });
      return await executeSpawnSessionRequest({ ...input, options: { ...options,
        beforeSessionRunnerLaunch: input.options.beforeSessionRunnerLaunch } });
    }, stopSession: async () => true, requestShutdown() {} }, {
      // Real startup registration supplies this observer even when launch refuses.
      awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ subscribeChanges: listener => sessionChanges.subscribe(listener), ...input, getTrackedSessions: () => [] }),
    }));
    const manager: unknown = Reflect.get(machine, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed Session receiver');
    const relay = await createInstalledMachineRpcRelay({ manager, machineId: 'df38-machine', transportOwnerAccountId: 'df38-owner',
      methods: [RPC_METHODS.SESSION_SPAWN_NEW, RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT],
      ui: { installation, ownerAccountId: 'df38-owner' } });
    const stopForwarding = forwardInstalledMachineRpc(requesterChannel, relay);
    let cleanup: Promise<void> | undefined;
    const close = () => cleanup ??= (async () => {
      stopForwarding();
      await relay.close();
      await machine.shutdown();
    })();
    onTestFinished(close);
    const request = (actor: string, directory: string) => SessionSpawnNewInputV2Schema.parse({ creationKey: `preflight-${actor}`,
      executionTarget: { serverId: 'df38-home', machineId: 'df38-machine' }, directory: { kind: 'path', path: directory },
      organizationPlacement: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
        definitionId: 'alpha' }, connectedServices: { v: 2, bindingsByServiceId: {} } });
    try {
      const ownerRaw = await relay.invokeUi(RPC_METHODS.SESSION_SPAWN_NEW, request('owner', ownerDirectory));
      // Registered Actions project a refusal as an Action result envelope.
      expect(ownerRaw, JSON.stringify(ownerRaw)).toMatchObject({ ok: false, errorCode: expect.any(String) });
      expect(preflightDirectories, JSON.stringify(ownerRaw)).toEqual([ownerDirectory]);
      expect((await lstat(ownerDirectory)).isDirectory()).toBe(true);
      for (const actorAccountId of ['member-use', 'member-manage']) {
        const directory = join(storage.home, actorAccountId);
        const result = await relay.invokeUi(RPC_METHODS.SESSION_SPAWN_NEW, request(actorAccountId, directory), { actorAccountId });
        expect(result).not.toMatchObject({ type: 'success' });
        expect(result).toHaveProperty('errorCode');
        await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(preflightDirectories).toEqual([ownerDirectory]);
    } finally {
      await close();
    }
  });

  it.each([
    ['claude', 'unifiedTerminal', 'runtime'], ['claude', 'agentSdk', undefined],
    ['opencode', 'server', 'runtime'],
  ] as const)('carries the selected %s %s terminal owner into the private runner bootstrap', async (agentId, backendMode, terminalHostOwner) => {
    const previousFeature = process.env.HAPPIER_FEATURE_AGENTS_CLAUDE_UNIFIED_TERMINAL__ENABLED;
    process.env.HAPPIER_FEATURE_AGENTS_CLAUDE_UNIFIED_TERMINAL__ENABLED = '1';
    let inspected = false;
    try {
      const executable = await writeExecutableShim({ dir: storage.home, fileName: agentId, contents: `#!${process.execPath}\nif (process.argv.slice(2).join(' ') === 'auth list') console.log('1 credential');\nprocess.exit(0)\n` });
      const prepared = params('alpha', async () => {
        const directory = join(storage.home, 'tmp', 'runner-agent-session-bootstraps');
        const [file] = await readdir(directory);
        const bootstrapFilePath = join(directory, file!);
        const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(bootstrapFilePath, 'utf8')));
        expect(bootstrap.launch).toMatchObject({ runtimeDescriptorV1: { agent: { backendMode } } });
        expect(bootstrap.launch).toEqual(expect.objectContaining(terminalHostOwner ? { terminalHostOwner } : {}));
        if (!terminalHostOwner) expect(bootstrap.launch).not.toHaveProperty('terminalHostOwner');
        const source = await createRunnerAgentSessionRuntimeBootstrap({ happyHomeDir: storage.home,
          publicReleaseRing: configuration.publicReleaseRing, bootstrapFilePath,
          authorityFilePath: join(storage.home, 'unclaimed-runner-authority.json') });
        expect(source).not.toBeNull();
        if (terminalHostOwner) expect(source).toMatchObject({ startupTerminalHostOwner: terminalHostOwner });
        else expect(source).not.toHaveProperty('startupTerminalHostOwner');
        inspected = true;
        return false;
      });
      const result = await executeSpawnSessionRequest({ ...prepared,
        processEnv: { ...prepared.processEnv, [agentId === 'claude' ? 'HAPPIER_CLAUDE_PATH' : 'HAPPIER_OPENCODE_PATH']: executable }, options: {
        directory: storage.home, backendTarget: { kind: 'backend', backendId: agentId, sourceKind: 'built_in' },
        connectedServices: { v: 2, bindingsByServiceId: {} },
        runtimeDescriptorV1: { v: 1, agentId, agent: { backendMode, terminalHostKind: 'tmux' } },
        terminal: { mode: 'tmux', tmux: { sessionName: 'owner-test' } },
        beforeSessionRunnerLaunch: prepared.options.beforeSessionRunnerLaunch,
      } });
      expect(inspected, JSON.stringify(result)).toBe(true);
    } finally {
      if (previousFeature === undefined) delete process.env.HAPPIER_FEATURE_AGENTS_CLAUDE_UNIFIED_TERMINAL__ENABLED;
      else process.env.HAPPIER_FEATURE_AGENTS_CLAUDE_UNIFIED_TERMINAL__ENABLED = previousFeature;
    }
  });

  it.each(['started', 'child-failed', 'stale-caller-resume', 'retained-requester-resume', 'retained-requester-automatic-resume',
    'retained-requester-automatic-home-replaced-during-read-resume', 'retained-requester-automatic-home-replaced-in-hook-resume',
    'retained-requester-withdrawn-resume', 'retained-requester-foreign-home-resume', 'retained-requester-incomplete-resume',
    'retained-requester-same-bearer-unavailable-resume',
    'delayed-local-stop-resume', 'stopped-before-restart', 'archive-during-explicit-resume',
    'signed-stop', 'stale-signed-stop', 'foreign-machine-stop', 'manager-child-resume', 'manager-reassigned-resume', 'archived-before-launch',
    'automation-forged-resume', 'manager-not-parent-resume', 'manager-person-hold-resume', 'manager-settings-disabled-resume',
    'manager-approval-required-resume', 'manager-launch-failed-resume', 'manager-replaced-at-launch-resume',
    'manager-prior-lead-hold-resume', 'manager-restart-resume', 'manager-home-replaced-resume',
    'manager-shared-child-resume', 'manager-requester-retired-resume'] as const)('keeps exact resume tied to canonical runner startup while the pending capability lookup is unavailable (%s)', async outcome => {
    const retainedRequesterResume = outcome.startsWith('retained-requester-');
    const automaticRetainedResume = outcome.startsWith('retained-requester-automatic');
    const lateHomeReplacement = automaticRetainedResume && outcome !== 'retained-requester-automatic-resume';
    const retainedSourceRefused = retainedRequesterResume && outcome !== 'retained-requester-resume' && !automaticRetainedResume;
    const sameBearerRecoveryUnavailable = outcome === 'retained-requester-same-bearer-unavailable-resume';
    const nativeResume = outcome === 'stale-caller-resume' || outcome === 'delayed-local-stop-resume' || retainedRequesterResume;
    const signedStop = outcome === 'signed-stop' || outcome === 'stale-signed-stop';
    const managerResume = outcome.startsWith('manager-');
    const successfulManagerResume = outcome === 'manager-child-resume' || outcome === 'manager-prior-lead-hold-resume'
      || outcome === 'manager-restart-resume' || outcome === 'manager-requester-retired-resume';
    let managerHomeChanged = false;
    let managerRequesterRetired = false;
    let retainedSourceCurrent = true;
    let retainedHomeIdentity = 'srv_df38_owner';
    let retainedSourceUnavailable = false;
    let accountPreparationAfterSourceLoss = 0;
    let retainedRecoveryProofObserved = false;
    let retainedRecoverySettingsRefusals = 0;
    let retainedCustodyBound = false;
    let automaticPrivateSessionReads = 0;
    let automaticDaemonSessionReadRefusals = 0;
    let homeReplacementObserved = false;
    let privateSessionReadsAfterHomeReplacement = 0;
    let heldStopBeforeResume: unknown = null;
    const admittedControl = signedStop || managerResume;
    const restoreRequestAdapter = admittedControl || nativeResume ? installAxiosRequestMethodAdapter() : undefined;
    const refusalDiagnostics = admittedControl || nativeResume ? vi.spyOn(logger, 'warnLocalFile') : undefined;
    const ordinaryCredentials = storage.credentials;
    const requesterLifetime = new AbortController();
    // Seeding can fail before the daemon cleanup exists. Register process-wide
    // fixture restoration as soon as these resources are acquired.
    onTestFinished(() => {
      requesterLifetime.abort();
      restoreRequestAdapter?.();
      refusalDiagnostics?.mockRestore();
      storage.credentials = ordinaryCredentials;
      storage.ordinaryStoredCredentials = false;
      storage.persistedToken = ordinaryCredentials.token;
    });
    if (admittedControl || nativeResume) {
      // The installed external ingress derives its Account from the issued
      // credential, just as the incumbent signed-Action fixture does.
      storage.credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'df38-owner', tokenEpoch: 1,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
      storage.persistedToken = storage.credentials.token;
      const account = getActiveAccountSettingsSnapshot();
      if (account) setActiveAccountSettingsSnapshot({ ...account, scopeKey: resolveAccountSettingsScopeKey(storage.credentials) });
    }
    if (nativeResume) {
      storage.ordinaryStoredCredentials = true;
      await writeStoredCredentialsForServerId('df38-home', storage.credentials);
    }
    const installedCredentials = nativeResume ? await readStoredCredentialsForServerId('df38-home') : null;
    if (nativeResume && !installedCredentials) throw new Error('Missing original resume Account credentials');
    const resumeApi = nativeResume ? await ApiClient.create(installedCredentials!) : api;
    const resumeInstallation = nativeResume ? await readOrCreateInstallationIdentity() : null;
    const nativeObservedPath = join(storage.home, 'resumed-native.json');
    if (nativeResume) await writeFile(join(storage.home, 'alpha.mjs'), `import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(nativeObservedPath)}, JSON.stringify({ pid: process.pid, definitionId: process.env.DF38_SELECTION }));\n`);
    const sessionId = 'cfixlive22pendingresume000001';
    // A separately issued bearer for the same Account is retained by the
    // canonical private custody writer, never substituted with daemon sign-in.
    const privateCredentials = sameBearerRecoveryUnavailable ? installedCredentials : retainedRequesterResume ? { token: `fixture.${Buffer.from(JSON.stringify({
      sub: 'df38-owner', tokenEpoch: 1, credentialId: 'retained-requester',
      provenance: { v: 1, kind: 'account', authority: 'present_user' },
    })).toString('base64url')}.signature`, encryption: null } : null;
    const managerId = 'cfixlive22manager0000000001';
    const target = AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'alpha' });
    const trackedSessions = new Map<SessionTrackingKey, TrackedSession>();
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const spawnResultResolverByKey: ExecuteSpawnSessionRequestParams['spawnResultResolverByKey'] = new Map();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const spawnResourceCleanupByKey: ExecuteSpawnSessionRequestParams['spawnResourceCleanupByKey'] = new Map();
    const sessionAttachCleanupByKey: ExecuteSpawnSessionRequestParams['sessionAttachCleanupByKey'] = new Map();
    let daemon: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | undefined;
    let projectMachine: ApiMachineClient | undefined;
    const requesterRuntimes: RequesterSessionRuntimeContext[] = [];
    let originalRequester: Awaited<ReturnType<typeof admitRequesterSessionBootstrap>> | undefined;
    const requesterChannel = retainedRequesterResume ? requesterHome : null;
    const actualSockets = retainedRequesterResume ? await vi.importActual<typeof import('socket.io-client')>('socket.io-client') : null;
    let child: ChildProcess | undefined;
    let report: Promise<void> | undefined;
    let lookupUnavailable = false;
    let physicalLaunches = 0;
    let beforePhysicalLaunchCalls = 0;
    let receivedResumeAuthorization: unknown;
    const stopWriteStarted = createDeferred();
    const releaseStopWrite = createDeferred();
    let localStop: Promise<Response> | undefined;
    const originalFetch = globalThis.fetch;
    const originalSocket = storage.io.getMockImplementation();
    let retainedDescriptor: ReturnType<typeof RuntimeDescriptorV1Schema.parse> | undefined;
    if (nativeResume || outcome === 'delayed-local-stop-resume' || managerResume) {
      await executeSpawnSessionRequest(params('alpha', async () => {
        const directory = join(storage.home, 'tmp', 'runner-agent-session-bootstraps');
        const [file] = await readdir(directory);
        const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(join(directory, file!), 'utf8')));
        retainedDescriptor = bootstrap.launch?.runtimeDescriptorV1;
        return false;
      }));
      if (!retainedDescriptor) throw new Error('Real preparation must produce the retained resume descriptor');
    }
    const sourceStop = { v: 1, cause: 'explicit_stop', requestId: 'signed-stop-attempt', requestedAtMs: 1,
      ...(managerResume && outcome !== 'manager-person-hold-resume' ? {
        managerSessionId: outcome === 'manager-prior-lead-hold-resume' ? 'previous-manager' : managerId,
      } : {}),
    } as const;
    const owningMachineId = outcome === 'foreign-machine-stop' ? 'another-machine' : 'df38-machine';
    const callerMetadata = { path: storage.home, machineId: owningMachineId,
      ...(outcome === 'signed-stop' || managerResume || outcome === 'automation-forged-resume' ? { sessionExplicitStopV1: sourceStop } : {}),
      ...(retainedDescriptor ? { runtimeDescriptorV1: retainedDescriptor,
        acpConfiguredBackendV1: buildAcpConfiguredBackendV1({ updatedAt: 1, backendId: 'alpha', title: 'alpha' }),
      } : {}) };
    const fields = buildSessionMetadataEnvelopeFields({ credentials: storage.credentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', metadata: callerMetadata, agentState: null });
    let row: V2SessionByIdResponse['session'] = { ...createSessionNotificationContextFixture(sessionId),
      ...(outcome === 'archived-before-launch' ? { archivedAt: 1 } : {}),
      encryptionMode: 'plain', metadataLayoutVersion: 1, machineId: owningMachineId, share: null,
      ...(managerResume ? { manager: { sessionId: outcome === 'manager-not-parent-resume' ? 'another-manager' : managerId } } : {}),
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState };
    const metadataWrites = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner') throw new Error('Expected the owner tuple from Stop/Resume');
      if (outcome === 'delayed-local-stop-resume' && patch.ownerMetadata.t === 'plain'
        && patch.ownerMetadata.v.runtime?.sessionExplicitStopV1) {
        stopWriteStarted.resolve();
        await releaseStopWrite.promise;
      }
      row = { ...row, metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
        metadataVersion: patch.sharedMetadata.expectedVersion + 1, agentState: patch.agentState.ciphertext,
        agentStateVersion: patch.agentState.expectedVersion + 1 };
      return homeResponse(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }));
    });
    const originalMachineRpc = machineRpcTransport.callMachineRpc;
    const stopTransport = vi.spyOn(machineRpcTransport, 'callMachineRpc').mockImplementation(async input => {
      if (input.method === RPC_METHODS.STOP_SESSION && input.request && typeof input.request === 'object'
        && Reflect.get(input.request, 'sessionId') === sessionId) {
        const result = await daemon!.stopSession(sessionId);
        if (outcome === 'archive-during-explicit-resume') row = { ...row, active: false };
        return result;
      }
      return await originalMachineRpc(input);
    });
    const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
    const mutationCustody = createDaemonSessionMutationCustody({ credentials: storage.credentials });
    const onHappySessionWebhook = createOnHappySessionWebhook({ trackedSessionsByKey: trackedSessions, spawnAwaiterByKey,
      deviceLocalSecretStorage,
      getParentPidFn: pid => pid === process.pid ? storage.runnerWrapperPid : null });
    const unsignedSessionReadStacks: string[] = [];
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      if (automaticRetainedResume && retainedCustodyBound && path === `/v2/sessions/${sessionId}`) {
        if (AxiosHeaders.from(config?.headers).get('Authorization') !== `Bearer ${privateCredentials!.token}`) {
          automaticDaemonSessionReadRefusals += 1;
          return homeResponse({ error: 'access_denied' }, 403);
        }
        automaticPrivateSessionReads += 1;
        if (lateHomeReplacement && retainedSourceUnavailable) privateSessionReadsAfterHomeReplacement += 1;
        if (outcome === 'retained-requester-automatic-home-replaced-during-read-resume' && !homeReplacementObserved) {
          // Automatic admission reads persisted state before native preparation.
          // Replace Home during that actual read, after private custody exists.
          homeReplacementObserved = true;
          retainedHomeIdentity = 'srv_foreign_late_resume';
          retainedSourceUnavailable = true;
        }
      }
      // A genuine settings denial after the signed recovery proof prevents
      // reconstructing the retained runtime, even when its bearer equals sign-in.
      // Acquisition reads are allowed; falling through to global preparation is not.
      if (retainedSourceUnavailable && sameBearerRecoveryUnavailable
        && retainedRecoveryProofObserved && path === '/v2/account/settings') {
        retainedRecoverySettingsRefusals += 1;
        return homeResponse({ error: 'access_denied' }, 403);
      }
      if (retainedSourceUnavailable && (path === '/v2/account/settings' || path === '/v1/account/entity-rows/acp')) {
        accountPreparationAfterSourceLoss += 1;
      }
      if (nativeResume && (path === '/v1/machines/df38-machine' || path === `/v2/sessions/${sessionId}`)
        && ![installedCredentials!.token, privateCredentials?.token].some(token => token
          && AxiosHeaders.from(config?.headers).get('Authorization') === `Bearer ${token}`)) {
        return homeResponse({ error: 'access_denied' }, 403);
      }
      const catalog = readFixtureCatalogResponse(path);
      if (catalog) return catalog;
      if (path === '/v1/account/encryption/currentness') return homeResponse(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
      if (nativeResume && path === '/v1/account/profile') return homeResponse({ id: 'df38-owner' });
      if (nativeResume && path === '/v1/account/encryption') return homeResponse({ mode: 'plain', updatedAt: 1 });
      if (nativeResume && path === '/v2/account/settings') return homeResponse({ content: { t: 'plain', v: {} }, version: 4 });
      if (nativeResume && path === '/v1/machines/df38-machine') return homeResponse({ machine: {
        id: 'df38-machine', installationId: resumeInstallation!.installationId,
        metadata: encodePlainMachineStoredContent(fixtureMachineMetadata()), metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
        access: { custodian: { accountId: 'df38-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
      } });
      if (admittedControl && path === '/v1/account/profile') return homeResponse({ id: 'df38-owner' });
      if (admittedControl && path === '/v1/account/security') return homeResponse({ v: 1, encryptionMode: 'plain',
        nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
      if (admittedControl && path === '/v2/account/settings') return homeResponse({ content: { t: 'plain', v: {} }, version: 4 });
      if (managerResume && path === `/v2/sessions/${managerId}`) return homeResponse({ session: {
        ...createSessionNotificationContextFixture(managerId), encryptionMode: 'plain', metadataLayoutVersion: 0, share: null,
        machineId: 'df38-machine', metadata: JSON.stringify({ path: storage.home, machineId: 'df38-machine', flavor: 'claude',
          runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }),
      } });
      if (path === '/v1/auth/ping') return homeResponse({ ok: true });
      if (retainedRequesterResume && path.startsWith('/v1/access-keys/')) return homeResponse({ accessKey: 'retained-machine-control' });
      if (path === '/v1/artifacts') return homeResponse([]);
      if (path === `/v2/sessions/${sessionId}`) {
        if (signedStop && !AxiosHeaders.from(config?.headers).has(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)) {
          unsignedSessionReadStacks.push(new Error('Unsigned native Stop Session read').stack ?? 'missing stack');
        }
        if (lookupUnavailable) return homeResponse({}, 404);
        return homeResponse({ session: row });
      }
      if (path === '/v2/sessions') return homeResponse({ sessions: [], hasNext: false });
      throw new Error(`Unexpected resume Home GET ${path}`);
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const path = new URL(String(url)).pathname;
      const availability = readBundledPluginAvailabilityHttpFixture(path, body);
      if (availability) return homeResponse(availability);
      if (nativeResume && path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
        if (![installedCredentials!.token, privateCredentials?.token].some(token => token
          && AxiosHeaders.from(config?.headers).get('Authorization') === `Bearer ${token}`)) {
          return homeResponse({ error: 'access_denied' }, 403);
        }
        ProjectAccountRowListRequestV1Schema.parse(body);
        return homeResponse(ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }));
      }
      if (path === '/v2/sessions/read-batch') return homeResponse(createSessionReadBatchResponseFixture({ request: body, sessions: lookupUnavailable ? [] : [row] }));
      if (retainedRequesterResume && path.endsWith('/access-key')) return homeResponse({ success: true });
      if (retainedRequesterResume && path === '/v1/machines/df38-machine/admission/verify') {
        if (!body || typeof body !== 'object' || !('context' in body) || !('purpose' in body) || !('proof' in body)) {
          throw new Error('Missing actual retained requester proof');
        }
        const proof = verifyMachineInstallationProof({ publicKey: resumeInstallation!.publicKey,
          proof: body.proof as Parameters<typeof verifyMachineInstallationProof>[0]['proof'], payload: {
            version: 1, accountId: 'df38-owner', machineId: 'df38-machine', installationId: resumeInstallation!.installationId,
            rpcAdmission: { context: SocketRpcMachineAdmissionContextV1Schema.parse(body.context),
              purpose: RequesterSessionCurrentnessPurposeV1Schema.parse(body.purpose) } } });
        const current = proof && retainedSourceCurrent;
        if (retainedSourceUnavailable && sameBearerRecoveryUnavailable && current) retainedRecoveryProofObserved = true;
        return homeResponse(current ? { v: 1, ok: true } : { error: 'access_denied' }, current ? 200 : 403);
      }
      if (outcome === 'archive-during-explicit-resume' && path === `/v2/sessions/${sessionId}/archive`) {
        if (row.active) return homeResponse({ error: 'session_active' }, 409);
        row = { ...row, archivedAt: 123 };
        return homeResponse({ success: true, archivedAt: row.archivedAt });
      }
      if (path === '/v2/sessions/query') {
        const query = SessionListQueryV1Schema.parse(body);
        return homeResponse(createCompactSessionListQueryResponseFixture({ sessions: managerResume && query.storage === 'active' ? [row] : [],
          nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }));
      }
      if (admittedControl && path.endsWith('/execution-authorization/verify')) return homeResponse({ ok: !managerRequesterRetired });
      if (path === '/v1/home/governance/get') return homeResponse({ homeDefaults: null });
      throw new Error(`Unexpected resume Home POST ${path}`);
    });
    const actualKill = process.kill;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (Math.abs(pid) === storage.runnerWrapperPid || pid === process.pid) {
        if (signal !== 0) throw new Error('Synthetic child must not signal its worker');
        return true;
      }
      return actualKill(pid, signal);
    });
    storage.sourceChecks = [];
    storage.runnerWrapperPid = process.pid + 1_000_000;
    storage.runnerCommand = `${process.execPath} ${join(process.cwd(), 'src', 'index.ts')} custom-acp`;
    storage.runnerExited = false;
    storage.io.mockImplementation((...args: Parameters<typeof import('socket.io-client')['io']>) => {
      const auth = args[1]?.auth;
      return actualSockets && auth && typeof auth === 'object' && Reflect.get(auth, 'clientType') === 'user-scoped'
        ? actualSockets.io(...args)
        : createApiSessionSocketStub({ emitWithAck: () => ({ ok: false, error: 'RPC method not available' }) });
    });
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return originalFetch(input, init);
      if (url.pathname === '/v1/account/profile') return Response.json({ id: 'df38-owner' });
      if (url.pathname.startsWith('/v1/features')) return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        ...(nativeResume ? { serverIdentity: { serverIdentityId: retainedHomeIdentity } } : {}),
        encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
      } }));
      return new Response('{}', { status: 404 });
    });
    let cleanupCompletion: Promise<void> | undefined;
    const cleanup = () => cleanupCompletion ??= (async () => {
      releaseStopWrite.resolve();
      await localStop?.catch(() => {});
      // Retire the real supervisor before ending its synthetic runner. A bare
      // child exit admits automatic respawn work into the next fixture's Home.
      await daemon?.stopSession(sessionId);
      storage.runnerExited = true;
      const hostedEnds = [...trackedSessions.values()].flatMap(tracked => tracked.hostedSession ? [tracked.hostedSession.observed] : []);
      if (child) {
        child.exitCode = 0; child.emit('exit', 0, null);
        if (hostedEnds.length === 0) await daemon?.onChildExited(storage.runnerWrapperPid, { reason: 'process-exited', code: 0, signal: null });
      }
      await closeFixtureSessionHosts();
      await Promise.all(hostedEnds);
      await report?.catch(() => {});
      // Runner exit schedules managed-service retirement in the daemon. Join
      // that owner before shutdown and before removing this case's Home.
      await daemon?.retireEndedRunnerOwnedState();
      await daemon?.stopControlServer();
      requesterLifetime.abort();
      for (const requester of requesterRuntimes) await requester.dispose();
      await originalRequester?.cleanupOnFailure();
      await projectMachine?.shutdown();
      await mutationCustody.close();
      reads.mockRestore(); writes.mockRestore(); kill.mockRestore(); metadataWrites.mockRestore(); stopTransport.mockRestore();
      if (originalSocket) storage.io.mockImplementation(originalSocket); else storage.io.mockReset();
      vi.stubGlobal('fetch', originalFetch);
      storage.runnerCommand = ''; storage.runnerExited = false; storage.runnerWrapperPid = 0;
      storage.runnerSpawn = null; storage.runnerBootstrapPath = ''; storage.sourceChecks = null;
    })();
    onTestFinished(cleanup);
    try {
      if (nativeResume && installedCredentials) {
        const finite = createInstalledProjectFiniteRuntime({ api: resumeApi, credentials: installedCredentials,
          externalActionAccountId: 'df38-owner', finiteServerId: 'df38-home', finiteServerHttpBaseUrl: configuration.serverUrl,
          nativeIo: createProjectNativeIo(), successHomeDir: join(storage.home, 'resume-project-success'),
          registeredMachineId: 'df38-machine', admission: createProjectWorkerAdmission({ machineId: 'df38-machine',
            admissionDrain: createDaemonAdmissionDrain(), readPolicy: async () => ({ status: 'ready',
              policy: { accepting: true, runAtMost: 1 }, source: 'default', metadataVersion: 1 }) }),
          // This synthetic OS child shares the worker environment. Retain the
          // daemon's real file-backed Account, not any child's private credential env.
          isCurrent: async () => sameStoredCredentials(installedCredentials, decodeStoredCredentials(JSON.parse(
            await readFile(join(configuration.serversDir, 'df38-home', 'access.key'), 'utf8')))),
          prepareBetween: async () => { throw new Error('No resume workspace transfer expected'); },
          resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: retainedHomeIdentity, machineId: 'df38-machine' }),
        });
        projectMachine = new ApiMachineClient(installedCredentials.token, { id: 'df38-machine', encryptionMode: 'plain',
          dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadata: fixtureMachineMetadata(), metadataVersion: 1, daemonState: null, daemonStateVersion: 0 },
          undefined, { createProjectFiniteRuntime: finite });
        await activateSessionsRoleForMachineClient(projectMachine, projectMachine.setRPCHandlers({ spawnSession: async () => { throw new Error('No replacement Session expected'); },
          stopSession: async () => true, requestShutdown() {} }));
      }
      const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
      const resolveRequesterRuntime = createRequesterSessionRuntimeContextResolver({ trackedSessions,
        getCreateRuntime: () => nativeResume ? async bootstrap => {
          // Match startDaemon's factory: recovered custody retains the local Home owner.
          bindRequesterSessionRuntimeMachineAdmissionCurrentness({ bootstrap, boundary: {
            machineId: 'df38-machine', daemonToken: installedCredentials!.token,
            isHomeCurrent: () => retainedSourceCurrent, getObservedServerIdentityId: () => retainedHomeIdentity,
            readInstallation: () => resumeInstallation,
          } });
          const requester = await createRequesterSessionRuntimeContext({ providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap,
            activeServerDir: configuration.activeServerDir,
            connectedServicesMaterializationBaseDir: join(storage.home, 'connected-services'),
            resolveQualifiedConnectedAccountV4Support: () => 'indeterminate', coordinatorInput: {
              machineId: 'df38-machine', machineIdProvider: () => 'df38-machine', runtimeId: 'retained-resume-runtime',
              happyHomeDir: storage.home, logger: { debug() {}, info() {}, warn() {} },
              processEnv: { NODE_ENV: 'test', HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
              trackedSessionsByKey: trackedSessions, connectedServiceRuntimeRegistry,
              connectedServiceAuthGroupPreTurnSwitchCoordinator: daemon?.connectedServiceAuthGroupPreTurnSwitchCoordinator,
            } });
          if (requester) requesterRuntimes.push(requester);
          return requester;
        } : undefined,
        recoverBootstrap: async ({ sessionId: id, attribution }) => await resolveRequesterSessionBootstrapFromCustody({
          happyHomeDir: storage.home, serverId: 'df38-home', sessionId: id, serverHttpBaseUrl: configuration.serverUrl,
          ...(attribution ? { expectedAttribution: attribution } : {}), machineAdmissionBoundary: {
            machineId: 'df38-machine', daemonToken: installedCredentials!.token,
            isHomeCurrent: () => retainedSourceCurrent, getObservedServerIdentityId: () => retainedHomeIdentity, readInstallation: () => resumeInstallation,
          } }),
      });
      if (retainedRequesterResume && privateCredentials && installedCredentials && resumeInstallation) {
        const attribution = { serverId: 'df38-home', accountId: 'df38-owner', machineId: 'df38-machine',
          installationId: resumeInstallation.installationId };
        const boundary = { machineId: 'df38-machine', daemonToken: installedCredentials.token,
          isHomeCurrent: () => retainedSourceCurrent, getObservedServerIdentityId: () => retainedHomeIdentity, readInstallation: () => resumeInstallation };
        originalRequester = await admitRequesterSessionBootstrap({ existingSessionId: sessionId,
          bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeStoredCredentials(privateCredentials) },
          boundary: { serverId: 'df38-home', serverHttpBaseUrl: configuration.serverUrl, happyHomeDir: storage.home,
            getObservedServerIdentityId: () => retainedHomeIdentity }, context: { signal: requesterLifetime.signal,
            machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: 'df38-owner', custodianAccountId: 'df38-owner',
              machineId: 'df38-machine', installationId: resumeInstallation.installationId, role: 'manage', encryptionMode: 'plain' }),
            verifyMachineAdmissionCurrent: async signal => await verifyRequesterSessionMachineAdmissionCurrent({
              credentials: privateCredentials, sessionId, attribution, serverHttpBaseUrl: configuration.serverUrl, boundary, signal }),
          } });
        if (!originalRequester) throw new Error('Real retained requester admission refused');
        bindRequesterSessionRuntimeMachineAdmissionCurrentness({ bootstrap: originalRequester.admitted, boundary });
        const custody = await originalRequester.admitted.bindExistingSession(sessionId);
        expect(Boolean(custody), 'Actual verified binding must publish original private custody').toBe(true);
        expect(privateCredentials.token === installedCredentials.token).toBe(sameBearerRecoveryUnavailable);
        await originalRequester.admitted.dispose();
        retainedCustodyBound = true;
      }
      const installation = admittedControl ? await readOrCreateInstallationIdentity() : null;
      const createDaemon = () => startDaemonSessionControlRuntime({ machineId: 'df38-machine', serverId: 'df38-home',
        serverBaseUrl: configuration.serverUrl, credentials: installedCredentials ?? storage.credentials, api: resumeApi, daemonSessionMutationCustody: mutationCustody,
        connectedServicesMaterializationBaseDir: join(storage.home, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        trackedSessionsByKey: trackedSessions, spawnAwaiterByKey, spawnResultResolverByKey, spawnWebhookTimeoutByKey,
        getApiMachineForSessions: () => projectMachine ?? null, spawnResourceCleanupByKey, sessionAttachCleanupByKey,
        deviceLocalSecretStorage, connectedServicesRestartRequestedSessions: new Set(), beforeShutdown: async () => {},
        ...(admittedControl ? { externalActionAccountId: 'df38-owner',
          resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: managerHomeChanged ? 'replacement-home' : 'df38-home', machineId: 'df38-machine' }) } : {}),
        ...(nativeResume ? { externalActionAccountId: 'df38-owner',
          resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: retainedHomeIdentity, machineId: 'df38-machine' }) } : {}),
        ...(nativeResume ? { connectedServiceRuntimeRegistry,
          resolveRequesterSessionRuntimeContext: resolveRequesterRuntime,
          releaseRequesterSessionRuntimeContext: context => releaseUnretainedRequesterSessionRuntimeContext(context,
            [...trackedSessions.values()].map(tracked => tracked.requesterSessionRuntimeContext)) } : {}),
        onHappySessionWebhook, requestShutdown: () => {}, processEnv: { ...process.env } });
      daemon = await createDaemon();
      if (outcome === 'foreign-machine-stop') {
        const response = await originalFetch(`http://127.0.0.1:${daemon.controlPort}/stop-session`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-happier-daemon-token': daemon.controlToken },
          body: JSON.stringify({ sessionId }),
        });
        expect(response.status).toBe(200);
        expect(StopSessionResultSchema.parse(await response.json())).toEqual({
          status: 'incomplete', reason: 'explicit_stop_failed',
        });
        expect(metadataWrites, 'Local control may not claim Stop custody for a Session owned by another Machine').not.toHaveBeenCalled();
        return;
      }
      if (signedStop) {
        if (!installation) throw new Error('Expected installed Stop signer');
        const target = { kind: 'machine' as const, machineId: 'df38-machine' };
        const purpose = { kind: 'machine_rpc' as const, method: RPC_METHODS.STOP_SESSION, params: { sessionId } };
        const authorization = sealExternalActionRequesterAccountContextV1({
          authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-stop-root', binding: {
            accountId: 'df38-owner', custodianAccountId: 'df38-owner', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', serverIdentityId: 'df38-home', machineId: 'df38-machine',
            installationId: installation.installationId, actionId: 'session.stop', requestId: sourceStop.requestId,
            target, requestEnvelopeDigest: 'a'.repeat(43),
          } }),
          credentials: encodeStoredCredentials(storage.credentials), purpose,
          invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
          installationPublicKey: decodeBase64(installation.publicKey, 'base64url'), randomBytes: tweetnacl.randomBytes,
        });
        const admitted = await daemon.externalActionIngressOwner?.prepareRequesterAccountContext?.({ authorization, purpose });
        expect(admitted, JSON.stringify({ ingress: Boolean(daemon.externalActionIngressOwner), refusals: refusalDiagnostics?.mock.calls })).toBeTruthy();
        if (!admitted) throw new Error('Installed Stop requester unavailable');
        try {
          const result = await admitted.executor.execute('session.stop', { sessionId }, { surface: 'ui', authority: 'present_user',
            actionRequestId: sourceStop.requestId, externalActionExecutionAuthorization: admitted.authorization,
            externalActionTarget: target, serverId: 'df38-home' });
          expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
          const sessionReads = reads.mock.calls.filter(([url]) => new URL(String(url)).pathname === `/v2/sessions/${sessionId}`);
          expect(sessionReads.length).toBeGreaterThan(0);
          for (const [, config] of sessionReads) {
            const headers = AxiosHeaders.from(config?.headers);
            const resolved = decodeExternalActionResolvedTargetV1(String(headers.get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER) ?? ''));
            expect(headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER), unsignedSessionReadStacks.join('\n')).toBe('signed-stop-root');
            expect(resolved).toEqual(target);
            expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'signed-stop-root', effectActionId: 'session.stop',
              target, installationId: installation.installationId, requestId: sourceStop.requestId,
              method: 'GET', path: `/v2/sessions/${sessionId}`, publicKey: decodeBase64(installation.publicKey, 'base64url'),
              signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER) ?? ''),
            })).toBe(true);
            expect(headers.get(EXTERNAL_ACTION_EFFECT_ACTION_HEADER)).toBe('session.stop');
          }
          const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
          if (owner.t !== 'plain') throw new Error('Expected keyless Plain Stop owner');
          expect(readSessionExplicitStopV1FromMetadata(projectSessionOwnerCompatibilityViewV1({
            sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(row.metadata!)), ownerMetadata: owner.v,
          }))).toEqual(outcome === 'signed-stop' ? sourceStop : null);
        } finally { await admitted.dispose(); }
        return;
      }
      // A committed person Stop is authored through the existing requester
      // service. Only its remote machine transport is replaced at the boundary.
      const callerRow = row;
      if (outcome === 'stopped-before-restart' || nativeResume && !automaticRetainedResume && outcome !== 'delayed-local-stop-resume') {
        await requestSessionStop({ stopIntent: 'explicit_stop', credentials: storage.credentials, idOrPrefix: sessionId });
        const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
        if (owner.t !== 'plain') throw new Error('Expected plain Stop owner metadata');
        heldStopBeforeResume = readSessionExplicitStopV1FromMetadata(projectSessionOwnerCompatibilityViewV1({
          sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(row.metadata!)), ownerMetadata: owner.v,
        }));
        expect(heldStopBeforeResume).toMatchObject({ cause: 'explicit_stop' });
      }
      if (retainedSourceRefused) {
        // Invalidate only after the real admission/bind writer and explicit
        // Stop have settled, so every case exercises public cold recovery.
        if (outcome === 'retained-requester-withdrawn-resume') retainedSourceCurrent = false;
        if (outcome === 'retained-requester-foreign-home-resume') retainedHomeIdentity = 'srv_foreign_resume';
        if (outcome === 'retained-requester-incomplete-resume') {
          const path = requesterSessionCredentialPath({ happyHomeDir: storage.home, sessionId,
            attribution: { serverId: 'df38-home' } });
          const capsule: unknown = JSON.parse(await readFile(path, 'utf8'));
          if (!capsule || typeof capsule !== 'object' || !('homeServerIdentityId' in capsule)) {
            throw new Error('Real private custody writer omitted retained Home identity');
          }
          await replacePrivateBearerFile({ path, contents: JSON.stringify(Object.fromEntries(
            Object.entries(capsule).filter(([key]) => key !== 'homeServerIdentityId'),
          )) });
        }
        retainedSourceUnavailable = true;
      }
      if (outcome === 'stopped-before-restart' || outcome === 'manager-restart-resume') {
        await daemon.stopControlServer();
        daemon = await createDaemon();
      }
      const control = daemon;
      if (outcome === 'delayed-local-stop-resume') {
        localStop = originalFetch(`http://127.0.0.1:${control.controlPort}/stop-session`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-happier-daemon-token': control.controlToken },
          body: JSON.stringify({ sessionId }),
        });
        await Promise.race([stopWriteStarted.promise, localStop.then(async response => {
          throw new Error(`Stop completed before its controlled metadata write: ${response.status} ${await response.text()}`);
        })]);
      }
      const resumeOptions = { directory: storage.home, agentTarget: target,
        existingSessionId: sessionId, spawnNonce: 'fixlive22-exact-resume',
        executionAuthorization: { provenance: 'user_request', requestId: 'fixlive22-pending' },
        beforeSessionRunnerLaunch: async () => {
          beforePhysicalLaunchCalls += 1;
          if (outcome === 'retained-requester-automatic-home-replaced-in-hook-resume') {
            homeReplacementObserved = true;
            retainedHomeIdentity = 'srv_foreign_late_resume';
            retainedSourceUnavailable = true;
          }
          if (outcome === 'manager-replaced-at-launch-resume') {
            row = { ...row, manager: { sessionId: 'replacement-manager' } };
          }
          const bootstrapDir = join(storage.home, 'tmp', 'runner-agent-session-bootstraps');
          const [file] = await readdir(bootstrapDir);
          if (!file) throw new Error('Real spawn omitted the runner bootstrap');
          storage.runnerBootstrapPath = join(bootstrapDir, file);
          const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(storage.runnerBootstrapPath, 'utf8')));
          if (outcome === 'archive-during-explicit-resume') {
            // The live cleanup overlapped cold launch preparation. Exercise the
            // real Archive -> Stop path before the final native launch check.
            row = { ...row, active: true };
            expect(await setSessionArchivedState({ credentials: storage.credentials, idOrPrefix: sessionId, archived: true }))
              .toEqual({ ok: true, sessionId, archivedAt: 123 });
          }
          storage.runnerSpawn = (_args, environment) => {
            physicalLaunches += 1;
            if (outcome === 'child-failed' || outcome === 'manager-launch-failed-resume') throw new Error('Physical child creation failed');
            // Only the OS child is synthetic. The real daemon route consumes
            // the production bootstrap and publishes canonical runner custody.
            child = new ChildProcess();
            Object.defineProperty(child, 'pid', { value: storage.runnerWrapperPid });
            child.kill = () => true;
            report = Promise.resolve().then(async () => {
              const trackingKey = environment[SESSION_TRACKING_KEY_ENV];
              // The real host starts its command while the daemon consumes the
              // add acknowledgement. Observe the daemon's resulting registration.
              const tracked = await vi.waitFor(() => {
                const current = trackingKey ? trackedSessions.get(trackingKey as SessionTrackingKey)
                  : trackedSessionForSingleSessionProcess(trackedSessions, storage.runnerWrapperPid);
                expect(current).toBeDefined();
                return current!;
              });
              if (tracked.acceptedSpawnMarkerGate && !await tracked.acceptedSpawnMarkerGate) throw new Error('Real child custody was not accepted');
              lookupUnavailable = !nativeResume && outcome !== 'delayed-local-stop-resume'
                && outcome !== 'automation-forged-resume' && !managerResume;
              const response = await originalFetch(`http://127.0.0.1:${control.controlPort}/session-started`, {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-happier-daemon-token': control.controlToken },
                body: JSON.stringify({ sessionId, metadata: createTestMetadata({ path: storage.home,
                  happyHomeDir: storage.home, hostPid: process.pid, startedBy: 'daemon', flavor: 'custom-acp',
                  runtimeDescriptorV1: bootstrap.launch?.runtimeDescriptorV1 }) }),
              });
              expect(response.status, await response.text()).toBe(200);
              if (lateHomeReplacement) return;
              if (managerResume) {
                // The synthetic OS runner sends the same authenticated open
                // report as its native adapter. Recording and observing it stay real.
                const authorityFilePath = environment[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
                if (!authorityFilePath) throw new Error('Hosted runner omitted private service authority');
                const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: storage.home,
                  publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: sessionId,
                  occurrenceId: bootstrap.descriptor.occurrenceId, runtimeAuthority: bootstrap.descriptor.runtimeAuthority });
                if (!source?.attestSessionOpen) throw new Error('Missing hosted runner open reporter');
                try {
                  await source.attestSessionOpen({ phase: 'commit', request: { kind: 'create', sessionId, cwd: storage.home },
                    providerSessionId: null, signal: new AbortController().signal });
                } finally { await source.retire?.(); }
              }
              if (nativeResume) {
                if (retainedRequesterResume) {
                  const path = environment.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE;
                  if (!path) throw new Error('Public resume omitted retained private credentials');
                  const originalSessionEnv = process.env.HAPPIER_SESSION_REQUESTER_SESSION_ID;
                  process.env.HAPPIER_SESSION_REQUESTER_SESSION_ID = sessionId;
                  try {
                    const credentials = await readRequesterSessionCredentialsForChild(path);
                    expect(credentials?.token === privateCredentials?.token, 'The child must retain the private bearer').toBe(true);
                    expect(credentials?.token === installedCredentials?.token, 'The child must not borrow daemon credentials').toBe(false);
                    expect(credentials?.requesterSessionCredentialScope?.requesterSession).toEqual({ sessionId,
                      homeServerIdentityId: 'srv_df38_owner', attribution: { serverId: 'df38-home', accountId: 'df38-owner',
                        machineId: 'df38-machine', installationId: resumeInstallation!.installationId },
                      machineAdmission: { custodianAccountId: 'df38-owner', role: 'manage' } });
                  } finally {
                    if (originalSessionEnv === undefined) delete process.env.HAPPIER_SESSION_REQUESTER_SESSION_ID;
                    else process.env.HAPPIER_SESSION_REQUESTER_SESSION_ID = originalSessionEnv;
                  }
                }
                // Consume the original actual SPAWN authority only after its
                // webhook adopts this exact resumed Session/runner. This is
                // resolved-native PluginExec, not a synthetic public process grant.
                const authorityFilePath = environment[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
                if (!authorityFilePath) throw new Error('Resumed runner omitted its private service authority');
                const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: storage.home,
                  publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: sessionId,
                  occurrenceId: bootstrap.descriptor.occurrenceId, runtimeAuthority: bootstrap.descriptor.runtimeAuthority });
                if (!source) throw new Error('Missing original resumed runner source');
                const lifetime = new AbortController();
                let nativePhase = 'configured_launch';
                try {
                  const configured = await resolveAccountConfiguredAcpLaunchForAgent({ identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
                    agentTarget: target, startupRuntimeDescriptorV1: bootstrap.launch?.runtimeDescriptorV1 });
                  if (!configured) throw new Error('Missing retained configured ACP launch');
                  const launch = await configured.resolveHostLaunch({ cwd: storage.home });
                  nativePhase = 'runner_services';
                  const services = await source.createInvocationServices({ pluginId: bootstrap.descriptor.pluginId,
                    pluginVersion: bootstrap.descriptor.pluginVersion, agentId: bootstrap.descriptor.agentId,
                    occurrenceId: bootstrap.descriptor.occurrenceId, correlationId: sessionId,
                    processOwner: { kind: 'session', sessionId }, cwd: storage.home, environment: {},
                    providerBindingActive: false, signal: lifetime.signal, isOccurrenceCurrent: () => true });
                  nativePhase = 'native_admission';
                  const native = await authorizeResolvedAgentNativeExecLaunchForHost(services.exec,
                    { command: launch.command, args: [...launch.args], cwd: storage.home, env: launch.env }, lifetime.signal,
                    issueAgentNativeLaunchQualifierForHost(services.exec));
                  try {
                    nativePhase = 'native_process';
                    const os = await vi.importActual<typeof import('node:child_process')>('node:child_process');
                    const vendor = os.spawn(native.command, [...native.args], { cwd: native.cwd, env: native.env, stdio: 'ignore' });
                    const exitCode = await new Promise<number | null>((resolve, reject) => {
                      vendor.once('error', reject); vendor.once('exit', code => resolve(code));
                    });
                    expect(exitCode).toBe(0);
                  } finally { await native.release(); }
                } catch (error) {
                  // Never print a caught private plugin payload into retained test output.
                  const failure = readSessionPreparationFailureDiagnostic(error);
                  const ownData = (value: unknown, key: string): unknown => {
                    if (!value || typeof value !== 'object') return undefined;
                    try {
                      const descriptor = Object.getOwnPropertyDescriptor(value, key);
                      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
                    } catch { return undefined; }
                  };
                  const code = ownData(error, 'code');
                  const p11 = refusalDiagnostics?.mock.calls.filter(([message]) =>
                    message === '[P11] Native execution admission refused').at(-1)?.[1];
                  const witness = {
                    isolationRefusal: code === 'agent_isolation_unavailable',
                    projectRequesterRefusal: code === 'project_requester_credentials_unavailable',
                    projectFiniteRefusal: code === 'project_finite_execution_unavailable',
                    nativeAuthorityRefusal: code === 'native_agent_privileged_effect_authority_unavailable',
                    nativeOutcomeUnknown: code === 'native_agent_privileged_effect_outcome_unknown',
                    nativeExecUnavailable: code === 'plugin_exec_native_launch_unavailable',
                    projectWorkspaceUnavailable: code === 'project_workspace_unavailable',
                    p11Phase: ownData(p11, 'phase') === 'native_execution_admission',
                    requesterUnavailable: ownData(p11, 'reason') === 'requester_authority_unavailable',
                    sessionRequesterUnavailable: ownData(p11, 'reason') === 'session_requester_unavailable',
                    memberIsolationRequired: ownData(p11, 'reason') === 'member_isolation_required',
                    workspaceNotReady: ownData(p11, 'reason') === 'workspace_not_ready',
                  };
                  throw new Error(`Resumed native launch failed (${nativePhase}: ${failure.originalCode}/${failure.reason}; ${JSON.stringify(witness)})`);
                } finally { lifetime.abort(); await source.retire?.(); }
              }
            });
            void report.catch(() => {});
            return child;
          };
          return true;
        } } satisfies Parameters<typeof control.spawnSession>[0];
      const { executionAuthorization: _explicitAuthorization, ...automaticOptions } = resumeOptions;
      if (outcome === 'manager-restart-resume') {
        expect(await control.spawnSession(automaticOptions)).toMatchObject({ type: 'error' });
        expect(physicalLaunches).toBe(0);
        const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
        if (owner.t !== 'plain') throw new Error('Expected retained manager Stop after daemon recreation');
        expect(owner.v.runtime?.sessionExplicitStopV1).toEqual(sourceStop);
      }
      const resumeManagedChild = async () => {
        if (!installation) throw new Error('Expected installed manager signer');
        const targetMachine = { kind: 'machine' as const, machineId: 'df38-machine' };
        const agentStartContext = resolveCliAgentStartContextV1({ sessionId: managerId, machineId: 'df38-machine',
          directory: storage.home, backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          metadata: {}, starterDepth: 0, turnDepth: 1, callerPermissionMode: 'default', settings: accountSettingsParse({}), roles: {},
        });
        if (!agentStartContext || 'ok' in agentStartContext) throw new Error('Expected admitted manager context');
        const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
          actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.open': {
            ...(outcome === 'manager-settings-disabled-resume' ? { enabled: false } : {}),
            ...(outcome === 'manager-approval-required-resume' ? { approvalRequiredSurfaces: ['agent'] } : {}),
          } } }),
          actionRequestId: 'manager-resume-attempt', serverId: 'df38-home', callerPermissionMode: 'default',
          actionCaller: { kind: 'session', sessionId: managerId, starterDepth: 0, turnDepth: 1 },
          sessionInputSource: { sourceSessionId: managerId, sourceTurnId: 'manager-turn', via: 'action' },
          agentStartContext,
        };
        const authorization = sealExternalActionRequesterAccountContextV1({
          authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'manager-resume-root', binding: {
            accountId: 'df38-owner', custodianAccountId: 'df38-owner', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', serverIdentityId: 'df38-home', machineId: 'df38-machine',
            installationId: installation.installationId, actionId: 'session.open', requestId: context.actionRequestId,
            target: targetMachine, requestEnvelopeDigest: 'b'.repeat(43),
            sessionActionOrigin: resolveSessionRoleRpcOrigin(context),
            sessionActionSource: { machineId: 'df38-machine', installationId: installation.installationId },
          } }),
          credentials: encodeStoredCredentials(storage.credentials), purpose: { kind: 'external_action' },
          installationPublicKey: decodeBase64(installation.publicKey, 'base64url'), randomBytes: tweetnacl.randomBytes,
        });
        const admitted = await control.externalActionIngressOwner?.prepareRequesterAccountContext?.({ authorization });
        expect(admitted, JSON.stringify(refusalDiagnostics?.mock.calls)).toBeTruthy();
        if (!admitted) throw new Error('Installed manager requester unavailable');
        try {
          const lifecycle = createSpawnNewSessionLifecycleActionHandler({
            stopSession: control.stopSession,
            awaitAgentSessionOpen: control.awaitAgentSessionOpen,
            spawnSession: options => {
            receivedResumeAuthorization = options.executionAuthorization;
            return control.spawnSession({ ...options, beforeSessionRunnerLaunch: resumeOptions.beforeSessionRunnerLaunch });
          } });
          const deps = createCliActionDeps({ token: storage.credentials.token, credentials: storage.credentials,
            sessionId: managerId, serverId: 'df38-home', serverIdentityId: 'df38-home', mode: 'plain', ctx: null,
            externalActionMachineInstallationId: installation.installationId,
            externalActionMachineRequestPrivateKey: installation.privateKey,
            actionsSettingsProvider: createActionSettingsProvider({ scopeKey: resolveAccountSettingsScopeKey(storage.credentials),
              getAccountSettings: () => readRequesterAccountActionContext(admitted.authorization)?.accountSettingsContext.settings ?? null }),
            machineActionDirectTargetTransport: { machineId: 'df38-machine', invoke: async (_method, request, options) => {
              if (outcome === 'manager-reassigned-resume') row = { ...row, manager: { sessionId: 'cfixlive22othermanager00001' } };
              if (outcome === 'manager-shared-child-resume') row = { ...row,
                effectiveAccess: { ...row.effectiveAccess, level: 'edit' } };
              managerHomeChanged = outcome === 'manager-home-replaced-resume';
              // The request already crossed the admission owner. Withdrawal
              // affects the next request while this accepted Resume finishes.
              managerRequesterRetired = outcome === 'manager-requester-retired-resume';
              return lifecycle(request, { ...(options?.signal ? { signal: options.signal } : {}),
                ...(options?.localActionContext ? { localActionContext: options.localActionContext } : {}) });
            } },
          });
          return await createActionExecutor(deps).execute('session.open', { sessionId, serverId: 'df38-home', intent: 'resume',
            resumeRequest: { type: 'resume-session', sessionId, directory: storage.home, agentTarget: target },
          }, { ...context, externalActionExecutionAuthorization: admitted.authorization, externalActionTarget: targetMachine });
        } finally { await admitted.dispose(); }
      };
      const resuming = outcome === 'automation-forged-resume'
        ? createSpawnNewSessionLifecycleActionHandler({ spawnSession: options => control.spawnSession({ ...options,
            beforeSessionRunnerLaunch: resumeOptions.beforeSessionRunnerLaunch }) })({
            type: 'resume-session', sessionId, directory: storage.home, agentTarget: target,
            executionAuthorization: resumeOptions.executionAuthorization,
          }, { localActionContext: { surface: 'rpc', authority: 'account_automation' } })
        : managerResume ? resumeManagedChild()
        : outcome === 'stopped-before-restart' || outcome === 'archived-before-launch' || automaticRetainedResume ? daemon.spawnSession(automaticOptions)
        : nativeResume || outcome === 'delayed-local-stop-resume'
        ? requestInactiveSessionResume({ credentials: storage.credentials, sessionId, requestId: 'resume-after-committed-stop',
            rawSession: callerRow, metadata: callerMetadata, executionAuthority: 'present_user',
            spawnSession: options => {
              receivedResumeAuthorization = options.executionAuthorization;
              return daemon!.spawnSession({ ...options,
                beforeSessionRunnerLaunch: resumeOptions.beforeSessionRunnerLaunch });
            },
          })
        : daemon.spawnSession(resumeOptions);
      if (outcome === 'delayed-local-stop-resume') {
        // The controlled Home write is still pending. Resume must join the
        // daemon's existing Stop barrier before entering native preparation.
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(beforePhysicalLaunchCalls).toBe(0);
        releaseStopWrite.resolve();
        expect((await localStop!).status).toBe(200);
      }
      const result = await resuming;
      await report;
      if (automaticRetainedResume && !lateHomeReplacement) {
        expect(automaticDaemonSessionReadRefusals, 'Automatic persisted-state reads must retain the private requester').toBe(0);
        expect(automaticPrivateSessionReads).toBeGreaterThan(0);
        expect(result).toMatchObject({ type: 'success', sessionId });
      }
      if (retainedSourceRefused || lateHomeReplacement) {
        if (lateHomeReplacement) {
          expect(homeReplacementObserved, 'Home replacement must occur at the actual admission or launch boundary').toBe(true);
          expect(privateSessionReadsAfterHomeReplacement).toBe(0);
          expect(automaticDaemonSessionReadRefusals).toBe(0);
          expect(result).toMatchObject({ type: 'error', errorCode: outcome === 'retained-requester-automatic-home-replaced-during-read-resume'
            ? 'DAEMON_RPC_UNAVAILABLE' : 'SPAWN_VALIDATION_FAILED',
            errorDetail: { kind: 'launch_error', code: 'requester_session_custody_unavailable' } });
        } else expect(result).toMatchObject({ ok: false, code: 'resume_failed' });
        expect(beforePhysicalLaunchCalls).toBe(outcome === 'retained-requester-automatic-home-replaced-in-hook-resume' ? 1 : 0);
        expect(physicalLaunches).toBe(0);
        // A Home change during the admission read can precede its catalog
        // preparation. The refusal still prevents native preparation/launch.
        if (outcome !== 'retained-requester-automatic-home-replaced-during-read-resume') expect(accountPreparationAfterSourceLoss).toBe(0);
        if (sameBearerRecoveryUnavailable) expect(retainedRecoverySettingsRefusals).toBeGreaterThan(0);
        const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
        if (owner.t !== 'plain') throw new Error('Expected the original held Stop after refused recovery');
        expect(readSessionExplicitStopV1FromMetadata(projectSessionOwnerCompatibilityViewV1({
          sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(row.metadata!)), ownerMetadata: owner.v,
        }))).toEqual(heldStopBeforeResume);
        return;
      }
      if (nativeResume) {
        expect(result, JSON.stringify(result)).toMatchObject(automaticRetainedResume ? { type: 'success', sessionId } : { ok: true });
        const observed: { pid: number; definitionId: string } = JSON.parse(await readFile(nativeObservedPath, 'utf8'));
        expect(observed.definitionId).toBe('alpha');
        expect(Number.isSafeInteger(observed.pid) && observed.pid > 0).toBe(true);
        expect(await readProcessIdentityByPid(observed.pid)).toBeNull();
      }
      if (outcome === 'archive-during-explicit-resume') {
        expect(result).toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
        expect(physicalLaunches).toBe(0);
        expect(row.archivedAt).toBe(123);
        return;
      }
      if (outcome === 'archived-before-launch' || outcome === 'automation-forged-resume') {
        expect(result).toMatchObject({ type: 'error' });
        expect(physicalLaunches).toBe(0);
        return;
      }
      if (managerResume && !successfulManagerResume) {
        const errorCode = outcome === 'manager-settings-disabled-resume' ? 'action_disabled'
          // The real approval owner also requires an accepted original for a durable proposal.
          : outcome === 'manager-approval-required-resume' ? 'approval_origin_unavailable'
          : outcome === 'manager-person-hold-resume' ? 'held_by_person'
          // Dispatch admits headless Resume only for the caller's direct managed child.
          : outcome === 'manager-not-parent-resume' ? 'unsupported_action' : 'resume_failed';
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode });
        if (outcome === 'manager-not-parent-resume') {
          expect(result).toMatchObject({ details: { cause: 'action_scope_restricted' } });
        }
        expect(physicalLaunches).toBe(outcome === 'manager-launch-failed-resume' ? 1 : 0);
        const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
        if (owner.t !== 'plain') throw new Error('Expected held manager-child owner metadata');
        expect(readSessionExplicitStopV1FromMetadata(projectSessionOwnerCompatibilityViewV1({
          sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(row.metadata!)), ownerMetadata: owner.v,
        }))).toEqual(sourceStop);
        return;
      }
      if (outcome === 'stopped-before-restart') {
        expect(result).toMatchObject({ type: 'error' });
        expect(physicalLaunches).toBe(0);
        const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
        if (owner.t !== 'plain') throw new Error('Expected plain held owner metadata');
        expect(readSessionExplicitStopV1FromMetadata(projectSessionOwnerCompatibilityViewV1({
          sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(row.metadata!)), ownerMetadata: owner.v,
        }))).toMatchObject({ cause: 'explicit_stop' });
        return;
      }
      expect(physicalLaunches, JSON.stringify({ result, beforePhysicalLaunchCalls, receivedResumeAuthorization })).toBe(1);
      if (outcome !== 'child-failed') {
        expect(result, JSON.stringify(result)).toMatchObject(!automaticRetainedResume && (nativeResume || outcome === 'delayed-local-stop-resume' || managerResume)
          ? { ok: true } : { type: 'success', sessionId });
        expect([...trackedSessions.values()]).toContainEqual(expect.objectContaining({ happySessionId: sessionId, sessionRunnerPid: process.pid }));
        if (nativeResume || outcome === 'delayed-local-stop-resume' || managerResume) {
          const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
          if (owner.t !== 'plain') throw new Error('Expected plain owner metadata');
          expect(readSessionExplicitStopV1FromMetadata(projectSessionOwnerCompatibilityViewV1({
            sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(row.metadata!)), ownerMetadata: owner.v,
          }))).toBeNull();
          if (managerResume) expect(receivedResumeAuthorization).toBeUndefined();
        }
      } else expect(result).toMatchObject({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' });
    } finally {
      await cleanup();
    }
  });

  it.each(['default', 'explicit', 'unsupported_binding', 'admitted_home_unavailable', 'admitted_requester_refused', 'cancelled_at_launch'] as const)('admits a configured definition from the Action front door to the launch boundary (%s)', async scenario => {
    const previousIo = storage.io.getMockImplementation();
    const actualIo = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');
    storage.io.mockImplementation(actualIo.io);
    const requesterChannel = requesterHome;
    const restoreRequestAdapter = installAxiosRequestMethodAdapter();
    const installation = await readOrCreateInstallationIdentity();
    const machine = new ApiMachineClient(storage.credentials.token, { id: 'df38-machine', encryptionMode: 'plain',
      metadata: fixtureMachineMetadata(), metadataVersion: 1, daemonState: null, daemonStateVersion: 0 }, undefined,
      { resolveCurrentServerIdentityId: () => 'srv_df38_owner' });
    await activateSessionsRoleForMachineClient(machine, machine.setRPCHandlers({
      spawnSession: async () => { throw new Error('The configured Agent uses the installed direct spawn transport'); },
      stopSession: async () => true, requestShutdown() {},
    }));
    const closePreflight = await installDirectoryPreflightRelay(requesterChannel, machine);
    const withModel = scenario === 'explicit';
    const unsupportedBinding = scenario === 'unsupported_binding';
    const cancellation = new AbortController();
    const definitionId = withModel ? 'beta' : 'alpha';
    const target = AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
      definitionId });
    let reachedLaunch = false;
    let admissionChecks = 0;
    let daemonResult: unknown;
    const boundaryReads: string[] = [];
    let createdSession: V2SessionByIdResponse['session'] | undefined;
    const snapshot = getActiveAccountSettingsSnapshot();
    if (snapshot?.acpCatalog?.status !== 'ready') throw new Error('Expected the configured ACP fixture');
    const savedCatalog = snapshot.acpCatalog;
    // A definition saved by another client is newer than the daemon's last ready projection.
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ ...snapshot,
      acpCatalog: { status: 'ready', revision: 3, record: { v: 1, definitions: [] } } });
    expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toMatchObject({ record: { definitions: [] } });
    const reads = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      boundaryReads.push(path);
      if (path === '/v1/account/profile') return homeResponse({ id: 'df38-owner' });
      if (path === '/v1/account/encryption') return homeResponse({ mode: 'plain', updatedAt: 1 });
      if (path === '/v2/account/settings') return homeResponse({ content: { t: 'plain', v: snapshot.settings }, version: 4 });
      if (path === '/v1/account/settings') return homeResponse({ settings: null, settingsVersion: 0 });
      if (path === '/v1/machines/df38-machine') return homeResponse({ machine: {
        ...createAvailableSessionSpawnMachineSnapshot('df38-machine'), installationId: installation.installationId,
        metadata: encodePlainMachineStoredContent(fixtureMachineMetadata()), metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
        access: { custodian: { accountId: 'df38-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
      } });
      if (path === '/v1/account/entity-rows/acp') return homeResponse({ status: 'present', revision: savedCatalog.revision,
        content: { t: 'plain', v: savedCatalog.record } });
      const catalog = readFixtureCatalogResponse(path);
      if (catalog) return catalog;
      if (path === '/v1/account/encryption/currentness') return homeResponse(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
      if (createdSession && path === `/v2/sessions/${createdSession.id}`) return homeResponse({ session: createdSession });
      throw new Error(`Unexpected FIX54 Home read ${path}`);
    });
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      const path = new URL(String(url)).pathname;
      const availability = readBundledPluginAvailabilityHttpFixture(path, body);
      if (availability) return homeResponse(availability);
      boundaryReads.push(path);
      if (path === '/v1/machines/df38-machine/admission/verify') return machineAdmissionResponse(body, installation);
      if (path === '/v1/home/governance/get') return homeResponse({ homeDefaults: null });
      if (path === '/v2/sessions/lookup-by-tags') return homeResponse({ sessions: [] });
      if (path === '/v1/sessions') {
        createdSession = createFixturePlainSession(body, 'cfix54actionfront000000001');
        return homeResponse({ session: createdSession, created: true, organizationPlacement: { folderId: null, tagIds: [] } });
      }
      if (path.endsWith('/access-key')) return homeResponse({ success: true });
      throw new Error(`Unexpected FIX54 Home read ${path}`);
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return new Response(JSON.stringify({ id: 'df38-owner' }), { status: 200 });
      if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {
        sharing: { enabled: true, session: { enabled: true } } }, capabilities: {
        encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
      } }));
      throw new Error(`Unexpected FIX54 Home fetch ${path}`);
    });
    try {
      const handler = createSpawnNewSessionLifecycleActionHandler({ spawnSession: async options => {
        const input = params(definitionId, async () => {
          reachedLaunch = true;
          if (scenario === 'cancelled_at_launch') cancellation.abort();
          return false;
        });
        const result = await executeSpawnSessionRequest({ ...input, options: { ...options,
          beforeSessionRunnerLaunch: input.options.beforeSessionRunnerLaunch,
          verifyRequesterMachineAdmissionCurrent: async () => {
            admissionChecks += 1;
            // Machine withdrawal affects the next admission. An accepted start
            // reaches local launch custody without asking the Machine again.
            if (admissionChecks > 1 && scenario === 'admitted_home_unavailable') {
              throw Object.assign(new Error('Home unavailable'), { response: { status: 503 } });
            }
            return scenario !== 'admitted_requester_refused' || admissionChecks === 1;
          } } });
        daemonResult = result;
        return result;
      } });
      const deps = createCliActionDeps({ token: storage.credentials.token, credentials: storage.credentials,
        sessionId: '', mode: 'plain', ctx: null,
        sessionSpawnDirectTargetTransport: createMachineSessionDirectTargetTransport({ machineId: 'df38-machine',
          spawnLifecycleHandler: handler }) });
      const result = await createActionExecutor(deps).execute('session.spawn_new', {
        creationKey: `fix54-${scenario}`,
        executionTarget: { serverId: 'df38-home', machineId: 'df38-machine' },
        directory: { kind: 'path', path: storage.home }, agentTarget: target,
        connectedServices: { v: 2, bindingsByServiceId: unsupportedBinding ? {
          'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'unsupported-account' },
        } : {} }, permissionMode: 'default',
        ...(withModel ? { modelSelection: { v: 1, updatedAt: 1,
          ref: { agentTargetKey: buildBackendTargetKeyV2(target), providerConnectionId: null, modelId: 'free/model' } } } : {}),
      }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, signal: cancellation.signal });
      const observed = { result, daemonResult, boundaryReads, reachedLaunch };
      expect(observed, JSON.stringify(observed)).toMatchObject(unsupportedBinding ? { reachedLaunch: false,
        daemonResult: { type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED' },
        result: { ok: false, errorCode: 'spawn_failed', details: { type: 'error', code: 'spawn_failed',
          launchError: { code: 'connected_service_qualified_purpose_authority_unavailable' } } },
      // Local cancellation after dispatch retains the existing unknown outcome.
      } : scenario === 'cancelled_at_launch' ? { reachedLaunch: true,
        result: { ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' } },
      } : { reachedLaunch: true, daemonResult: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
      expect(admissionChecks).toBe(1);
      expect(boundaryReads).toContain('/v1/account/entity-rows/acp');
    } finally {
      await closePreflight(); await machine.shutdown();
      if (previousIo) storage.io.mockImplementation(previousIo); else storage.io.mockReset();
      reads.mockRestore(); network.mockRestore(); vi.stubGlobal('fetch', originalFetch);
      restoreRequestAdapter();
    }
  });

  it('reads retained bundled Agent resources from the admitted development source root', async () => {
    const registration = [...runtime.registry.agentRuntimesByAgentId.values()]
      .find(value => value.pluginId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId);
    const binding = registration?.sessionRunnerFactoryBinding;
    const createServices = runtime.registry.createRetainedRunnerAgentInvocationServices;
    if (!binding || !createServices) throw new Error('Expected real admitted retained Agent services');
    const lifetime = new AbortController();
    try {
      const invocation = await createServices({ binding, sessionId: 'cdf41resources000000000001',
        runnerSnapshotIdentity: `path:${process.cwd()}`,
        correlationId: 'df41-retained-resource', cwd: storage.home, environment: {},
        providerBindingActive: false, signal: lifetime.signal, isOccurrenceCurrent: () => true });
      const resource = await invocation.services.resources.read('brand-icon');
      expect(resource).toMatchObject({ kind: 'asset', contentType: 'image/png' });
      expect(resource.bytes).toEqual(new Uint8Array(await readFile(new URL(
        '../../../../../packages/plugins/custom-acp/assets/brand.png', import.meta.url))));
    } finally {
      lifetime.abort();
    }
  });

  it.each([
    { definitionId: 'alpha', failure: null },
    { definitionId: 'beta', failure: null },
    { definitionId: 'claude-action', failure: null },
    { definitionId: 'claude-ui', failure: null },
    { definitionId: 'alpha', failure: null, ordinaryPlacement: 'unassociated' },
    { definitionId: 'alpha', failure: null, ordinaryPlacement: 'associated' },
    { definitionId: 'alpha', failure: 'registry_miss' },
    { definitionId: 'alpha', failure: 'custody_mismatch' },
    { definitionId: 'alpha', failure: 'authority_refusal' },
  ] as const)('carries qualified $definitionId runner preparation through the real daemon route ($failure, $ordinaryPlacement)', async scenario => {
    const { definitionId, failure } = scenario;
    const ordinaryPlacement = 'ordinaryPlacement' in scenario ? scenario.ordinaryPlacement : undefined;
    const originalCredentials = storage.credentials;
    storage.credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'df38-owner', session: 'ordinary-owner-terminal' })).toString('base64url')}.fixture`, encryption: null };
    storage.persistedToken = storage.credentials.token;
    storage.ordinaryStoredCredentials = true;
    const originalSnapshot = getActiveAccountSettingsSnapshot();
    if (!originalSnapshot) throw new Error('Missing original owner fixture settings');
    setActiveAccountSettingsSnapshot({ ...originalSnapshot, scopeKey: resolveAccountSettingsScopeKey(storage.credentials) });
    if (ordinaryPlacement === 'associated') {
      await mkdir(join(storage.home, '.happier'), { recursive: true });
      await writeFile(join(storage.home, '.happier/project.json'), JSON.stringify({ version: 1 }));
    }
    const spawnApi = await ApiClient.create(storage.credentials);
    const builtInClaude = definitionId.startsWith('claude-');
    const requesterChannel = requesterHome;
    const actualSockets = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');
    const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('df41-child-exit'); });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug');
    const startupInfo = vi.spyOn(logger, 'info');
    const constructionInfo = vi.spyOn(logger, 'infoFile');
    const refusalLog = vi.spyOn(logger, 'warnLocalFile');
    const retainedServicesDescriptor = Object.getOwnPropertyDescriptor(runtime.registry, 'createRetainedRunnerAgentInvocationServices');
    const actualFetch = globalThis.fetch;
    const networkSpies: Array<{ mockRestore(): void }> = [];
    networkSpies.push({ mockRestore: installAxiosRequestMethodAdapter() });
    const daemonServiceDeliveries: Array<{ request: ReturnType<typeof AgentRuntimeDaemonServiceRequestV1Schema.parse>;
      response: ReturnType<typeof AgentRuntimeDaemonServiceResponseV1Schema.parse> }> = [];
    const daemonServiceObservations: Array<{ operation: string; status: number; ok: boolean; errorCode?: string }> = [];
    const homeObservations: Array<{ method: string; path: string }> = [];
    let daemon: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | undefined;
    const daemonMutationCustody = createDaemonSessionMutationCustody({ credentials: storage.credentials });
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Expected the admitted fixture Account');
    const rawSettings = { ...snapshot.settings };
    setActiveAccountSettingsSnapshot({ ...snapshot, rawSettings, loadedAtMs: Date.now(),
      settings: accountSettingsParse(rawSettings),
      mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [],
        catalog: McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] }) },
      promptLibraryCatalog: { status: 'ready', rows: PromptLibraryCatalogKeyV1Schema.options
        .map(key => ({ record: emptyPromptLibraryRecordV1(key, 1), revision: 1 })), tombstones: [], diagnostics: [] } });
    const initialProcessOwner = process.env[PROCESS_OWNER_ENV_KEY];
    const daemonEnvironment = { ...process.env, HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto',
      ...(builtInClaude ? { PATH: `${storage.home}${delimiter}${process.env.PATH ?? ''}` } : {}) };
    vi.stubEnv(PROCESS_OWNER_ENV_KEY, initialProcessOwner);
    storage.runnerCommand = `${process.execPath} ${join(process.cwd(), 'src', 'index.ts')}`;
    // The managed Linux launch has an OS wrapper and a distinct Session runner.
    // Model those process identities at the OS boundary instead of making the
    // worker stand in for both roles, which skips canonical child adoption.
    storage.runnerWrapperPid = process.pid + 1_000_000;
    storage.sourceChecks = [];
    storage.runnerLaunches = [];
    let sessionId = 'cdf41qualified000000000001';
    let sessionRow: V2SessionByIdResponse['session'] = createSessionNotificationContextFixture(sessionId);
    const trackedSessions = new Map<SessionTrackingKey, TrackedSession>();
    const installation = await readOrCreateInstallationIdentity();
    const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
    let requester: RequesterSessionRuntimeContext | null = null;
    let requesterRecoveryStage = 'not_requested';
    const createRequesterRuntime = (bootstrap: Parameters<typeof createRequesterSessionRuntimeContext>[0]['bootstrap']) =>
      createRequesterSessionRuntimeContext({ providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap, activeServerDir: configuration.activeServerDir,
        connectedServicesMaterializationBaseDir: join(storage.home, 'connected-services'),
        resolveQualifiedConnectedAccountV4Support: () => 'indeterminate', coordinatorInput: {
          machineId: 'df38-machine', machineIdProvider: () => 'df38-machine', runtimeId: 'fix63-runtime', happyHomeDir: storage.home,
          logger: { debug() {}, info() {}, warn() {} }, processEnv: { NODE_ENV: 'test',
            HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
          trackedSessionsByKey: trackedSessions, connectedServiceRuntimeRegistry,
          connectedServiceAuthGroupPreTurnSwitchCoordinator: daemon?.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    const resolveRequesterRuntime = createRequesterSessionRuntimeContextResolver({
      trackedSessions,
      getCreateRuntime: () => async bootstrap => {
        requesterRecoveryStage = 'runtime';
        requester = await createRequesterRuntime(bootstrap);
        requesterRecoveryStage = requester ? 'ready' : 'runtime_refused';
        return requester;
      },
      recoverBootstrap: async ({ sessionId: id, attribution }) => {
        if (id !== sessionId) return null;
        requesterRecoveryStage = 'bootstrap';
        const bootstrap = await resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: storage.home,
          serverId: 'df38-home', sessionId: id, serverHttpBaseUrl: configuration.serverUrl,
          ...(attribution ? { expectedAttribution: attribution } : {}),
          legacyOwnerCredentials: storage.credentials, machineAdmissionBoundary: { machineId: 'df38-machine',
            daemonToken: storage.credentials.token, isHomeCurrent: () => true, readInstallation: () => installation } });
        if (!bootstrap) requesterRecoveryStage = 'bootstrap_refused';
        return bootstrap;
      },
    });
    await writeStoredCredentialsForServerId('df38-home', storage.credentials);
    const installedCredentials = await readStoredCredentialsForServerId('df38-home');
    if (!installedCredentials) throw new Error('Missing installed credentials');
    const finite = createInstalledProjectFiniteRuntime({ api: spawnApi, credentials: installedCredentials,
      externalActionAccountId: 'df38-owner', finiteServerId: 'df38-home', finiteServerHttpBaseUrl: configuration.serverUrl,
      nativeIo: createProjectNativeIo(), successHomeDir: join(storage.home, 'project-success'),
      registeredMachineId: 'df38-machine', admission: createProjectWorkerAdmission({ machineId: 'df38-machine',
        admissionDrain: createDaemonAdmissionDrain(), readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 }, source: 'default', metadataVersion: 1 }) }),
      // This daemon and its synthetic child share Vitest's environment, unlike
      // real processes. Read the daemon-owned file at the filesystem boundary;
      // the child's private credential environment must not retarget that host.
      isCurrent: async () => sameStoredCredentials(installedCredentials, decodeStoredCredentials(JSON.parse(
        await readFile(join(configuration.serversDir, 'df38-home', 'access.key'), 'utf8')))),
      prepareBetween: async () => { throw new Error('No workspace transfer expected'); },
      resolveCurrentMachineExecutionOriginContext: async () => null });
    const projectMachine = new ApiMachineClient(storage.credentials.token, { id: 'df38-machine', encryptionMode: 'plain',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadata: fixtureMachineMetadata(), metadataVersion: 1, daemonState: null, daemonStateVersion: 0 },
      undefined, { createProjectFiniteRuntime: finite });
    await activateSessionsRoleForMachineClient(projectMachine, projectMachine.setRPCHandlers({ spawnSession: async () => { throw new Error('No replacement Session expected'); },
      stopSession: async () => true, requestShutdown() {} }));
    const closePreflight = await installDirectoryPreflightRelay(requesterChannel, projectMachine);
    const spawnAwaiterByKey = new Map<SessionTrackingKey, (session: TrackedSession) => void>();
    const spawnResultResolverByKey: ExecuteSpawnSessionRequestParams['spawnResultResolverByKey'] = new Map();
    const spawnWebhookTimeoutByKey = new Map<SessionTrackingKey, NodeJS.Timeout>();
    const spawnResourceCleanupByKey: ExecuteSpawnSessionRequestParams['spawnResourceCleanupByKey'] = new Map();
    const sessionAttachCleanupByKey: ExecuteSpawnSessionRequestParams['sessionAttachCleanupByKey'] = new Map();
    const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
    const exitSettlements: Promise<void>[] = [];
    const observeChildExit = createOnChildExited({ trackedSessionsByKey: trackedSessions, spawnResourceCleanupByKey,
      sessionAttachCleanupByKey, getApiMachineForSessions: () => null });
    const onChildExited: typeof observeChildExit = (pid, exit) => {
      const settlement = observeChildExit(pid, exit);
      exitSettlements.push(settlement);
      return settlement;
    };
    const onHappySessionWebhook = createOnHappySessionWebhook({ trackedSessionsByKey: trackedSessions, spawnAwaiterByKey,
      deviceLocalSecretStorage,
      getParentPidFn: pid => pid === process.pid ? storage.runnerWrapperPid : null });
    let child: ChildProcess | undefined;
    let borrowed: Awaited<ReturnType<typeof prepareRequesterSessionBootstrap>> | undefined;
    const actualKill = process.kill;
    networkSpies.push(vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (storage.runnerCommand && (Math.abs(pid) === process.pid || Math.abs(pid) === storage.runnerWrapperPid)) {
        if (signal !== 0) throw new Error('A synthetic runner must never signal the Vitest worker');
        if (pid < 0 || storage.runnerExited) throw Object.assign(new Error('Synthetic runner is absent'), { code: 'ESRCH' });
        return true;
      }
      return actualKill(pid, signal);
    }));
    const terminateActualProcess = processTermination.terminateProcessTree;
    networkSpies.push(vi.spyOn(processTermination, 'terminateProcessTree').mockImplementation(async (processToStop, options) => {
      if (processToStop !== child) return await terminateActualProcess(processToStop, options);
      storage.runnerExited = true;
      if (child) { child.exitCode = 0; child.emit('exit', 0, null); }
    }));
    const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true },
      sharing: { enabled: true, session: { enabled: true } } }, capabilities: {
      serverIdentity: { serverIdentityId: 'srv_df38_owner' },
      accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2,
        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1' },
      encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
      session: { runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 } },
    } });
    const workspaceRow = ProjectAccountRowV1Schema.parse({ key: { kind: 'workspace-ref', serverId: 'df38-home', id: 'df41-workspace' },
      revision: 1, content: { t: 'plain', v: { key: { kind: 'workspace-ref', serverId: 'df38-home', id: 'df41-workspace' },
        value: { id: 'df41-workspace', serverId: 'df38-home', machineId: 'df38-machine', rootPath: storage.home,
          projectKey: 'df41-project', createdAtMs: 1 } } } });
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'df38-machine' });
    const transcript = createSessionTranscriptHomeStub();
    const socket = createApiSessionSocketStub({ connected: true,
      emitWithAck: (event, payload) => activity.answer(event, payload) ?? transcript.answer(event, payload) ?? { ok: true, result: 'success',
        version: 1, id: 'df41-message', seq: 1, localId: 'df41-message' },
      emit: (event, args) => {
        const callback = args.at(-1);
        if (typeof callback === 'function') callback(activity.answer(event, args[0]) ?? transcript.answer(event, args[0]) ?? { ok: true, result: 'success', version: 1 });
      } });
    storage.io.mockImplementation((...args: Parameters<typeof actualSockets.io>) => {
      const auth = args[1]?.auth;
      // Home Account observation owns a separate socket lifetime. Session
      // shutdown/handler replacement must not retire requester currentness.
      return typeof args[0] === 'string' && args[0].startsWith('http://127.0.0.1:')
        || auth && typeof auth === 'object' && Reflect.get(auth, 'clientType') === 'user-scoped'
        ? actualSockets.io(...args) : socket;
    });
    try {
      // Home HTTP/Socket.IO are external boundaries. Session construction,
      // metadata/privacy serialization, authority, installed command, native
      // Agent factory and ACP transport all execute their production owners.
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
          return actualFetch(input, init);
        }
        if (url.pathname.startsWith('/v1/features')) return Response.json(features);
        if (url.pathname === '/v1/account/profile') return Response.json({ id: 'df38-owner' });
        return new Response('{}', { status: 404 });
      }));
      const readControlHttp = daemonControlHttp.readDaemonControlHttpResponse;
      networkSpies.push(vi.spyOn(daemonControlHttp, 'readDaemonControlHttpResponse').mockImplementation(async params => {
          // Decorate the real HTTP adapter: current control traffic uses its
          // own Undici dispatcher and deliberately bypasses global fetch.
          const serviceRequest = AgentRuntimeDaemonServiceRequestV1Schema.safeParse(params.body);
          if (serviceRequest?.success && serviceRequest.data.operation.kind === 'plugin_services.prepare_v1') {
            // Force actual owner inputs/registry wiring, never substitute its
            // preparation, authority, custody verifier or refusal implementation.
            if (failure === 'registry_miss') {
              Reflect.deleteProperty(runtime.registry, 'createRetainedRunnerAgentInvocationServices');
            } else if (failure === 'custody_mismatch') {
              const tracked = [...trackedSessions.values()].find(value => value.happySessionId === sessionId);
              const authorityPath = tracked?.agentRuntimeDaemonServiceAuthorityFilePath;
              if (!authorityPath) throw new Error('Expected the produced private runner authority');
              const authority = JSON.parse(await readFile(authorityPath, 'utf8'));
              // The real HTTP reader consumes a retained binding whose version
              // no longer matches its actual source manifest. The original
              // capability, process identity and source custody remain exact.
              authority.retainedAgent.pluginVersion = 'df43-unavailable-version';
              await writeFile(authorityPath, JSON.stringify(authority), 'utf8');
            } else if (failure === 'authority_refusal') {
              const request = AgentRuntimeDaemonServiceRequestV1Schema.parse({ ...serviceRequest.data,
                operation: { ...serviceRequest.data.operation, witness: { turnId: 'df43-unadmitted-turn',
                  inputId: 'df43-unadmitted-input', userMessageSeq: null, userMessageSeqs: [] } } });
              params = { ...params, body: request };
            }
          }
          const response = await readControlHttp(params);
          if (serviceRequest?.success) {
            const output = AgentRuntimeDaemonServiceResponseV1Schema.safeParse(JSON.parse(response.body));
            daemonServiceObservations.push({ operation: serviceRequest.data.operation.kind, status: response.status,
              ok: output.success && output.data.ok,
              ...(output.success && !output.data.ok ? { errorCode: output.data.error.code } : {}) });
          }
          if (response.ok && serviceRequest?.success && serviceRequest.data.operation.kind === 'plugin_services.prepare_v1') {
            daemonServiceDeliveries.push({ request: serviceRequest.data,
              response: AgentRuntimeDaemonServiceResponseV1Schema.parse(JSON.parse(response.body)) });
          }
          return response;
      }));
      networkSpies.push(vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        homeObservations.push({ method: 'GET', path });
        const catalog = readFixtureCatalogResponse(path);
        if (catalog) return catalog;
        if (path === '/v1/auth/ping') return homeResponse({ ok: true });
        if (path === '/v1/account/profile') return homeResponse({ id: 'df38-owner' });
        if (path === '/v1/account/encryption') return homeResponse(AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }));
        if (path === '/v2/account/settings') return homeResponse({ content: { t: 'plain', v: rawSettings }, version: 4 });
        if (path === '/v1/machines/df38-machine') return homeResponse({ machine: { ...createAvailableSessionSpawnMachineSnapshot('df38-machine'), installationId: installation.installationId,
          metadata: encodePlainMachineStoredContent(fixtureMachineMetadata()), metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
          access: { custodian: { accountId: 'df38-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } });
        if (path === '/v1/account/encryption/currentness') return homeResponse(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
        if (path === `/v2/sessions/${sessionId}`) return homeResponse(V2SessionByIdResponseSchema.parse({ session: sessionRow }));
        if (path.startsWith('/v1/access-keys/')) return homeResponse({ accessKey: 'df41-machine-control' });
        if (path === '/v1/artifacts') return homeResponse([]);
        if (path.endsWith('/messages')) return homeResponse({ messages: [], hasMore: false });
        throw new Error(`Unexpected Home GET ${path}`);
      }));
      networkSpies.push(vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
        const parsedUrl = new URL(String(url));
        if (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost') {
          const headers = new Headers();
          for (const [key, value] of Object.entries(AxiosHeaders.from(config?.headers).toJSON())) {
            if (value !== undefined && value !== null && value !== false) headers.set(key, String(value));
          }
          if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
          const signal = config?.signal;
          if (signal && !(signal instanceof AbortSignal)) throw new Error('Expected an AbortSignal at the HTTP boundary');
          const response = await actualFetch(String(url), { method: 'POST', headers, body: JSON.stringify(body), signal });
          return homeResponse(await response.json(), response.status);
        }
        homeObservations.push({ method: 'POST', path: parsedUrl.pathname });
        const availability = readBundledPluginAvailabilityHttpFixture(parsedUrl.pathname, body);
        if (availability) return homeResponse(availability);
        if (parsedUrl.pathname === '/v1/home/governance/get') return homeResponse({ homeDefaults: null });
        if (parsedUrl.pathname === '/v1/sessions') {
          sessionRow = createFixturePlainSession(body, sessionId, sessionRow);
          return homeResponse({ session: sessionRow, created: true, organizationPlacement: { folderId: null, tagIds: [] } });
        }
        if (parsedUrl.pathname === '/v2/sessions/lookup-by-tags') return homeResponse({ sessions: [] });
        if (parsedUrl.pathname === '/v1/machines/df38-machine/admission/verify') return machineAdmissionResponse(body, installation);
        if (parsedUrl.pathname === '/v1/account/project-rows/list') {
          const request = ProjectAccountRowListRequestV1Schema.parse(body);
          if (ordinaryPlacement === 'unassociated' || request.serverId && request.serverId !== 'df38-home') {
            return homeResponse(ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }));
          }
          return homeResponse(ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [workspaceRow] }));
        }
        if (parsedUrl.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) {
          const { key } = ProjectAccountRowReadRequestV1Schema.parse(body);
          return homeResponse(ProjectAccountRowReadResponseV1Schema.parse(ordinaryPlacement !== 'unassociated'
            && key.kind === 'workspace-ref' && key.serverId === 'df38-home' && key.id === 'df41-workspace'
            ? { status: 'present', row: workspaceRow } : { status: 'absent' }));
        }
        if (parsedUrl.pathname.endsWith('/access-key')) return homeResponse({ success: true });
        throw new Error(`Unexpected Home POST ${parsedUrl.pathname}`);
      }));
      networkSpies.push(vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
        if (new URL(String(url)).pathname !== `/v2/sessions/${sessionId}`) throw new Error('Unexpected Home PATCH');
        const patch = SessionMetadataTuplePatchV1Schema.parse(body);
        if (patch.mode !== 'owner') throw new Error('Expected the ordinary owner metadata tuple');
        sessionRow = V2SessionByIdResponseSchema.parse({ session: { ...sessionRow, metadataLayoutVersion: patch.metadataLayoutVersion,
          metadata: patch.sharedMetadata.ciphertext, metadataVersion: patch.sharedMetadata.expectedVersion + 1,
          ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext,
          agentStateVersion: patch.agentState.expectedVersion + 1 } }).session;
        return homeResponse(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
          sharedMetadata: { version: sessionRow.metadataVersion }, agentState: { version: sessionRow.agentStateVersion } }));
      }));
      borrowed = await prepareRequesterSessionBootstrap({ credentials: installedCredentials,
        attribution: { accountId: 'df38-owner', serverId: 'df38-home', machineId: 'df38-machine', installationId: installation.installationId },
        homeServerIdentityId: 'srv_df38_owner',
        boundary: { serverId: 'df38-home', serverHttpBaseUrl: configuration.serverUrl, happyHomeDir: storage.home },
        verifyMachineAdmissionCurrent: async () => true });
      expect(borrowed).not.toBeNull();
      daemon = await startDaemonSessionControlRuntime({ machineId: 'df38-machine', serverId: 'df38-home',
        serverBaseUrl: configuration.serverUrl, credentials: installedCredentials, api: spawnApi,
        resolveCurrentMachineExecutionOriginContext: async () => ({
          serverIdentityId: 'srv_df38_owner', machineId: 'df38-machine' }),
        daemonSessionMutationCustody: daemonMutationCustody,
        connectedServicesMaterializationBaseDir: join(storage.home, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        trackedSessionsByKey: trackedSessions, spawnAwaiterByKey, spawnResultResolverByKey, spawnWebhookTimeoutByKey,
        getApiMachineForSessions: () => projectMachine, spawnResourceCleanupByKey, sessionAttachCleanupByKey,
        externalActionAccountId: 'df38-owner', connectedServiceRuntimeRegistry,
        resolveRequesterSessionRuntimeContext: resolveRequesterRuntime,
        releaseRequesterSessionRuntimeContext: context => releaseUnretainedRequesterSessionRuntimeContext(context,
          [...trackedSessions.values()].map(tracked => tracked.requesterSessionRuntimeContext)),
        deviceLocalSecretStorage,
        connectedServicesRestartRequestedSessions: new Set(), beforeShutdown: async () => {},
        onHappySessionWebhook, requestShutdown: () => {}, processEnv: daemonEnvironment });
      storage.daemonPort = daemon.controlPort;
      storage.daemonControlToken = daemon.controlToken;
      if (builtInClaude && borrowed) {
        bindRequesterSessionRuntimeMachineAdmissionCurrentness({ bootstrap: borrowed.admitted,
          boundary: { machineId: 'df38-machine', daemonToken: storage.credentials.token,
            isHomeCurrent: () => true, readInstallation: () => installation } });
        requester = await createRequesterRuntime(borrowed.admitted);
        expect(requester).not.toBeNull();
      }
      {
        sessionId = definitionId === 'alpha' ? 'cdf41qualified00000000000a' : 'cdf41qualified00000000000b';
        sessionRow = createSessionNotificationContextFixture(sessionId);
        vi.unstubAllEnvs();
        vi.stubEnv(PROCESS_OWNER_ENV_KEY, initialProcessOwner);
        storage.runnerExited = false;
        const observedPath = join(storage.home, `${definitionId}-first-model.json`);
        const script = writeAcpTestAgentScript({ dir: storage.home, fileName: `${definitionId}.mjs`, source: `
          import { writeFileSync } from 'node:fs';
          let buffer = '';
          process.stdin.on('data', chunk => {
            buffer += chunk;
            const lines = buffer.split('\\n'); buffer = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              const request = JSON.parse(line);
              if (request.method === 'session/set_model') {
                writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ definitionId: process.env.DF38_SELECTION,
                  agentTargetKey: process.env.DF41_TARGET_KEY, pid: process.pid, request }));
                process.exit(0);
              }
              const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }
                : request.method === 'session/new' ? { sessionId: 'df41-vendor', models: { currentModelId: 'other', availableModels: [{ modelId: 'ollama/qwen2.5:3b', name: 'Qwen' }] } }
                : {};
              if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
            }
          });
        ` });
        expect(script).toBe(join(storage.home, `${definitionId}.mjs`));
        if (builtInClaude) await writeExecutableShim({ dir: storage.home, fileName: 'claude', contents: `#!${process.execPath}
          const { writeFileSync } = require('node:fs');
          if (process.argv.includes('--version')) { process.stdout.write('2.1.0 (Claude Code)\\n'); process.exit(0); }
          writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
          // Deliberate vendor failure after observing actual qualified native
          // process creation. No provider tenant or assistant reply is simulated.
          process.exit(17);
        ` });
        if (builtInClaude) vi.stubEnv('PATH', daemonEnvironment.PATH);
        let runnerFailure: unknown;
        let runnerPublicationCurrent: boolean | undefined;
        let runnerCompletion: Promise<void> | undefined;
        storage.runnerSpawn = (args, environment) => {
          // The OS adapter runs the child in this worker. All argv, environment,
          // tracked registration, markers and private authority come from the
          // production spawn and webhook producers, never a fixture reassembly.
          child = new ChildProcess();
          Object.defineProperty(child, 'pid', { value: storage.runnerWrapperPid });
          child.kill = () => true;
          runnerCompletion = Promise.resolve().then(async () => {
            try {
              // Match the canonical Session-host harness: initialized runner
              // reporting follows tracked registration and accepted custody.
              const tracked = await vi.waitFor(() => {
                const current = environment[SESSION_TRACKING_KEY_ENV]
                  ? trackedSessions.get(environment[SESSION_TRACKING_KEY_ENV] as SessionTrackingKey)
                  : trackedSessionForSingleSessionProcess(trackedSessions, storage.runnerWrapperPid);
                if (!current) throw new Error('Session not tracked yet');
                return current;
              });
              if (tracked.acceptedSpawnMarkerGate && !await tracked.acceptedSpawnMarkerGate) {
                throw new Error('Real spawn marker was not accepted');
              }
              for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
              const command = args[0];
              if (!command) throw new Error('Real spawn produced no Agent command');
              if (builtInClaude) {
                // The OS child boundary consumes the actual birth metadata,
                // bootstrap and daemon-issued authority. Run the real runner
                // source/Exec path without sharing a second CLI process's
                // Account catalog singleton with this in-process daemon.
                const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(sessionRow.ownerMetadata);
                if (owner.t !== 'plain') throw new Error('Expected the born Plain Session');
                const metadata = projectSessionOwnerCompatibilityViewV1({
                  sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(sessionRow.metadata!)), ownerMetadata: owner.v });
                await notifyDaemonSessionStarted(sessionId, { ...metadata, path: storage.home, host: 'fixture',
                  version: 'test', os: 'linux', hostPid: process.pid, startedBy: 'daemon', happyHomeDir: storage.home },
                { sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } });
                const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(storage.runnerBootstrapPath, 'utf8')));
                const authorityFilePath = environment[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
                if (!authorityFilePath) throw new Error('The real spawn omitted runner service authority');
                const source = await createRunnerAgentSessionRuntimeSource({ happyHomeDir: storage.home,
                  publicReleaseRing: configuration.publicReleaseRing, authorityFilePath, expectedSessionId: sessionId,
                  occurrenceId: bootstrap.descriptor.occurrenceId, runtimeAuthority: bootstrap.descriptor.runtimeAuthority });
                if (!source) throw new Error('Missing admitted runner source');
                const lifetime = new AbortController();
                try {
                  const services = await source.createInvocationServices({ pluginId: bootstrap.descriptor.pluginId,
                    pluginVersion: bootstrap.descriptor.pluginVersion, agentId: bootstrap.descriptor.agentId,
                    occurrenceId: bootstrap.descriptor.occurrenceId, correlationId: sessionId,
                    processOwner: { kind: 'session', sessionId }, cwd: storage.home, environment: {},
                    providerBindingActive: false, signal: lifetime.signal, isOccurrenceCurrent: () => true });
                  const native = await authorizeResolvedAgentNativeExecLaunchForHost(services.exec,
                    { command: join(storage.home, 'claude'), args: ['--output-format', 'stream-json'],
                      cwd: storage.home, env: { PATH: environment.PATH } }, lifetime.signal,
                    issueAgentNativeLaunchQualifierForHost(services.exec));
                  try {
                    const os = await vi.importActual<typeof import('node:child_process')>('node:child_process');
                    const vendor = os.spawn(native.command, [...native.args], { cwd: native.cwd, env: native.env, stdio: 'ignore' });
                    await new Promise<void>((resolve, reject) => { vendor.once('error', reject); vendor.once('exit', () => resolve()); });
                  } finally { await native.release(); }
                } finally { lifetime.abort(); await source.retire?.(); }
                return;
              }
              runnerPublicationCurrent = pluginReloadController.isRuntimeRegistryCurrent(runtime.registry);
              const handler = await requireCatalogEntry(command).getCliCommandHandler!();
              fatal.mockClear();
              if (ordinaryPlacement) {
                try { await handler({ args, rawArgv: ['happier', ...args], terminalRuntime: null }); }
                catch (error) { if (!(error instanceof Error) || error.message !== 'df41-child-exit') throw error; }
              } else await expect(handler({ args, rawArgv: ['happier', ...args], terminalRuntime: null })).rejects.toThrow('df41-child-exit');
              runnerFailure = fatal.mock.calls.at(-1)?.[0];
            } catch (error) {
              runnerFailure = error;
            } finally {
              storage.runnerExited = true;
              if (child) { child.exitCode = 0; child.emit('exit', 0, null); }
            }
          });
          return child;
        };
        const spawnInput = { ...params(builtInClaude ? 'alpha' : definitionId, async () => {
          const bootstrapDir = join(storage.home, 'tmp', 'runner-agent-session-bootstraps');
          const files = await readdir(bootstrapDir);
          expect(files).toHaveLength(1);
          storage.runnerBootstrapPath = join(bootstrapDir, files[0]!);
          const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(storage.runnerBootstrapPath, 'utf8')));
          if (builtInClaude) expect(bootstrap.descriptor.agentId).toBe('claude');
          else expect(bootstrap.launch?.runtimeDescriptorV1.agent.definitionId).toBe(definitionId);
          return true;
        }), api: spawnApi };
        // Fresh daemon startup is correlated by the request's existing nonce;
        // the real marker owner requires it when adopting a PID placeholder.
        spawnInput.options.spawnNonce = `df41-${definitionId}-launch`;
        // The Home-issued birth authorization makes the real daemon create
        // owner commit the Session before the wrapped runner attaches to it.
        spawnInput.options.creationAuthorization = { token: 'df42-home-create-authorization' };
        // Restricted runners deliberately cannot read hosting Account defaults.
        // The public spawn request carries the user's admitted permission intent.
        spawnInput.options.permissionMode = definitionId === 'alpha' ? 'read-only' : 'yolo';
        const admittedTarget = AgentExecutionTargetV1Schema.parse(builtInClaude
          ? { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }
          : { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId });
        spawnInput.options.agentTarget = admittedTarget;
        if (builtInClaude) spawnInput.options.environmentVariables = {
          PATH: `${storage.home}${delimiter}${process.env.PATH ?? ''}`, ANTHROPIC_API_KEY: 'fixture-native-launch-only',
        };
        spawnInput.options.modelSelection = SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1, ref: {
          agentTargetKey: buildBackendTargetKeyV2(admittedTarget),
          providerConnectionId: null, modelId: builtInClaude ? 'claude-haiku-4-5' : 'ollama/qwen2.5:3b' } });
        let result: Awaited<ReturnType<typeof executeSpawnSessionRequest>> | undefined;
        const spawnSession = async (options: typeof spawnInput.options) => {
          result = await executeSpawnSessionRequest({ ...spawnInput, options: { ...spawnInput.options, ...options },
            trackedSessionsByKey: trackedSessions, spawnAwaiterByKey, spawnResultResolverByKey, spawnWebhookTimeoutByKey,
            spawnResourceCleanupByKey, sessionAttachCleanupByKey, deviceLocalSecretStorage, onChildExited,
            ...(requester ? { requesterSessionRuntimeContext: requester,
              activateSessionPurposeBindings: requester.activateSessionPurposeBindings } : {}),
            processEnv: daemonEnvironment, resolveCanonicalTrackedSessionId: trackingKey => trackedSessions.get(trackingKey)?.happySessionId ?? '' });
          return result;
        };
        if (failure) await spawnSession(spawnInput.options);
        else {
          const handler = createSpawnNewSessionLifecycleActionHandler({ serverId: 'df38-home', spawnSession });
          const deps = createCliActionDeps({ token: storage.credentials.token, credentials: storage.credentials,
            sessionId: '', mode: 'plain', ctx: null,
            sessionSpawnDirectTargetTransport: createMachineSessionDirectTargetTransport({ machineId: 'df38-machine',
              spawnLifecycleHandler: builtInClaude ? (request, context) => handler(request, {
                ...context, requesterSessionBootstrap: borrowed?.admitted,
              }) : handler }) });
          const action = await createActionExecutor(deps).execute('session.spawn_new', SessionSpawnNewInputV2Schema.parse({
            creationKey: `fix63-native-${definitionId}`, executionTarget: { serverId: 'df38-home', machineId: 'df38-machine' },
            directory: { kind: 'path', path: storage.home }, agentTarget: spawnInput.options.agentTarget,
            connectedServices: { v: 2, bindingsByServiceId: {} },
            permissionMode: spawnInput.options.permissionMode, modelSelection: spawnInput.options.modelSelection,
            ...(builtInClaude ? { environmentVariables: spawnInput.options.environmentVariables } : {}),
          }), { surface: definitionId === 'claude-ui' ? 'rpc' : 'cli', authority: 'present_user', actionCaller: { kind: 'host' } });
          expect(action, JSON.stringify(action)).toMatchObject({ ok: true });
          expect(result, JSON.stringify(action)).toBeDefined();
        }
        await runnerCompletion;
        storage.runnerSpawn = null;
        if (ordinaryPlacement) expect(daemonServiceObservations).toContainEqual({
          operation: 'plugin_exec.resolved_agent_launch.authorize_v1', status: 200, ok: true,
        });
        const observed = await readFile(observedPath, 'utf8').catch(() => null);
        if (failure) {
          const cause = failure === 'registry_miss'
            ? { code: 'plugin_services_retained_generation_unavailable', stage: 'retained_agent_services' }
            : failure === 'custody_mismatch'
              ? { code: 'plugin_services_retained_managed_dependency_unavailable', stage: 'retained_agent_services' }
              : { code: 'plugin_services_turn_authority_unavailable', stage: 'turn_authority' };
          expect(daemonServiceDeliveries, 'The refusal must traverse the strict real HTTP consumer').toHaveLength(1);
          expect(daemonServiceDeliveries[0]?.response).toEqual({ ok: false, error: {
            code: cause.code, message: `Runner PluginServices preparation failed (${cause.stage}: ${cause.code})`, cause,
            retryable: false, failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: cause.code, httpStatus: null } } });
          expect(runnerFailure).toMatchObject({ name: 'PluginError', code: cause.code, details: { cause } });
          expect(refusalLog.mock.calls.filter(([message]) => message.includes('runner_plugin_services_prepare_refused'))
            .map(([message]) => JSON.parse(message)))
            .toEqual([expect.objectContaining({ kind: 'runner_plugin_services_prepare_refused', cause })]);
          expect(observed, 'A refused preparation must not start the vendor model operation').toBeNull();
          return;
        }
        const snapshotFailure = debug.mock.calls.filter(([message]) => String(message).includes('Failed to sync session snapshot')).at(-1);
        const requesterRefusals = debug.mock.calls.filter(([message]) => String(message).includes('Native launch requester refusal'));
        const projectRefusals = debug.mock.calls.filter(([message]) => String(message).includes('[ProjectFinite] Runtime resolution refused'));
        expect(observed, `Spawn result: ${JSON.stringify(result)}\nOwn OS launch: ${JSON.stringify(storage.runnerLaunches)}\nRunner failed before native model call: ${runnerFailure instanceof Error
          ? runnerFailure.stack : String(runnerFailure)}\nRunner publication current: ${runnerPublicationCurrent}\nRunner startup phases: ${JSON.stringify(startupInfo.mock.calls
            .filter(([message]) => String(message).includes(' startup phase')))}\nRunner construction phases: ${JSON.stringify(constructionInfo.mock.calls
            .filter(([message]) => String(message).includes('Startup phase') || String(message).includes('Session construction failed')))}\nRunner cause code: ${runnerFailure && typeof runnerFailure === 'object'
            ? String(Reflect.get(runnerFailure, 'code')) : 'none'}\nDaemon operation outcomes: ${JSON.stringify(daemonServiceObservations)}\nHome paths: ${JSON.stringify(homeObservations.slice(-30))}\nRequester recovery: ${requesterRecoveryStage}\nRequester refusal: ${JSON.stringify(requesterRefusals)}\nProject refusal: ${JSON.stringify(projectRefusals)}\nRunner stderr: ${JSON.stringify(stderr.mock.calls)}\nSnapshot transport: ${JSON.stringify(snapshotFailure?.slice(1))}\nSpawn boundary: ${JSON.stringify(debug.mock.calls
              .filter(([message]) => String(message).includes('preflight') || String(message).includes('Failed to spawn')
                || String(message).includes('Canonical Session startup readiness failed')
                || String(message).includes('Canonical adoption ownership mismatch')).slice(-3)
              .map(([message, cause]) => [message, cause instanceof Error ? cause.stack : cause]))}`).not.toBeNull();
        const prepared = daemonServiceDeliveries.filter(({ request }) => request.context.sessionId === sessionId);
        expect(prepared, 'Installed runner must prepare PluginServices through the real daemon loopback route').not.toHaveLength(0);
        expect(prepared.map(({ response }) => response)).toEqual(expect.arrayContaining([
          expect.objectContaining({ ok: true, result: expect.objectContaining({ kind: 'plugin_services.result_v1' }) }),
        ]));
        expect(result).toMatchObject({ type: 'success', sessionId });
        expect(storage.sourceChecks).toEqual([]);
        // ACP itself transports a native model id, not host Agent identity.
        // The real selected definition's environment qualifies the physical
        // vendor process receiving that first model request.
        const firstModel = JSON.parse(observed!);
        if (builtInClaude) expect(firstModel.args).toContain('--output-format');
        else expect(firstModel).toMatchObject({ definitionId, agentTargetKey: buildBackendTargetKeyV2(admittedTarget), request: {
          method: 'session/set_model', params: { modelId: 'ollama/qwen2.5:3b' } } });
        const ownerMetadata = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(sessionRow.ownerMetadata);
        if (ownerMetadata.t !== 'plain') throw new Error('Expected the plain produced owner metadata');
        const producedMetadata = projectSessionOwnerCompatibilityViewV1({
          sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(sessionRow.metadata!)),
          ownerMetadata: ownerMetadata.v });
        if (builtInClaude) {
          expect(SessionCreationCorrespondenceV1Schema.parse(producedMetadata.sessionCreationCorrespondenceV1)
            .recipe.requestedPermissionMode).toBe('yolo');
        } else expect(readPermissionModeIntentFromMetadata(producedMetadata), 'Session startup must preserve the admitted permission intent')
          .toMatchObject({ permissionMode: definitionId === 'alpha' ? 'read-only' : 'yolo' });
        expect(Number.isSafeInteger(firstModel.pid) && firstModel.pid > 0).toBe(true);
        expect(await readProcessIdentityByPid(firstModel.pid), 'The real owned ACP vendor process must be retired').toBeNull();
        expect(storage.runnerExited, 'The owned in-process runner must be retired').toBe(true);
        if (builtInClaude) {
          expect(exitSettlements, 'The OS exit must reach the canonical Session exit owner').not.toHaveLength(0);
          await Promise.all(exitSettlements);
          expect(await requester!.isCurrent(), 'Session exit must retire requester authority before fixture teardown').toBe(false);
        }
      }
    } finally {
      if (retainedServicesDescriptor) Object.defineProperty(runtime.registry, 'createRetainedRunnerAgentInvocationServices', retainedServicesDescriptor);
      await closeFixtureSessionHosts();
      await Promise.all(exitSettlements);
      await daemon?.retireEndedRunnerOwnedState();
      await daemon?.stopControlServer();
      await requester?.dispose();
      await borrowed?.cleanupOnFailure();
      await closePreflight();
      await projectMachine.shutdown();
      await daemonMutationCustody.close();
      for (const spy of networkSpies.reverse()) spy.mockRestore();
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
      storage.runnerCommand = ''; storage.runnerExited = false; storage.sourceChecks = null;
      storage.runnerWrapperPid = 0;
      storage.runnerSpawn = null;
      storage.runnerBootstrapPath = '';
      storage.daemonPort = 0; storage.daemonControlToken = '';
      storage.ordinaryStoredCredentials = false;
      storage.credentials = originalCredentials;
      storage.persistedToken = originalCredentials.token;
      fatal.mockRestore(); exit.mockRestore(); stderr.mockRestore(); debug.mockRestore(); refusalLog.mockRestore();
      startupInfo.mockRestore(); constructionInfo.mockRestore();
    }
  }, 180_000);

  it.each(['internal-stop', 'previous-stop', 'late-stop', 'topology-repair', 'topology-repair-stop', 'post-stop-resume'] as const)('admits stopped Sessions and fences retired replacements through the real spawn owner (%s)', async (retirement) => {
    const originalCredentials = storage.credentials;
    storage.credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'df38-owner', session: 'retained-owner-terminal' })).toString('base64url')}.fixture`, encryption: null };
    storage.persistedToken = storage.credentials.token;
    storage.ordinaryStoredCredentials = true;
    await writeStoredCredentialsForServerId('df38-home', storage.credentials);
    const installedCredentials = await readStoredCredentialsForServerId('df38-home');
    if (!installedCredentials) throw new Error('Missing retained owner credentials');
    const originalSnapshot = getActiveAccountSettingsSnapshot();
    if (!originalSnapshot) throw new Error('Missing retained owner settings');
    setActiveAccountSettingsSnapshot({ ...originalSnapshot, scopeKey: resolveAccountSettingsScopeKey(installedCredentials) });
    const spawnApi = await ApiClient.create(installedCredentials);
    const installation = await readOrCreateInstallationIdentity();
    if (retirement === 'late-stop') vi.stubEnv('HAPPIER_CLI_SUBPROCESS_PREFER_TSX', 'true');
    let daemon: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | undefined;
    const daemonMutationCustody = createDaemonSessionMutationCustody({ credentials: storage.credentials });
    storage.sourceChecks = [];
    let launchReached = false;
    let launchAdmissionChecks = 0;
    let signalSent = false;
    let physicalLaunchReached = false;
    let secondResume: ReturnType<Awaited<ReturnType<typeof startDaemonSessionControlRuntime>>['spawnSession']> | undefined;
    const repairsTopology = retirement === 'topology-repair' || retirement === 'topology-repair-stop' || retirement === 'post-stop-resume';
    const sessionId = 'cpr536restart0000000000001';
    const originalFetch = globalThis.fetch;
    const spies: Array<{ mockRestore(): void }> = [{ mockRestore: installAxiosRequestMethodAdapter() }];
    const target = AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'alpha' });
    const base = params('alpha', async () => false);
    let producedDescriptor: ReturnType<typeof RuntimeDescriptorV1Schema.parse> | undefined;
    await executeSpawnSessionRequest(params('alpha', async () => {
      const bootstrapDir = join(storage.home, 'tmp', 'runner-agent-session-bootstraps');
      const [file] = await readdir(bootstrapDir);
      const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(join(bootstrapDir, file!), 'utf8')));
      producedDescriptor = bootstrap.launch?.runtimeDescriptorV1;
      return false;
    }));
    if (!producedDescriptor) throw new Error('Real spawn preparation did not publish the retained descriptor');
    storage.runnerWrapperPid = process.pid + 1_000_000;
    storage.runnerCommand = `${process.execPath} /tmp/versions/0.2.10/package-dist/index.mjs custom-acp --happy-starting-mode remote --started-by daemon`;
    storage.runnerExited = false;
    // The synthetic launcher already has an OS identity above. Supply its same
    // native generation to the real census/tree owner, using actual file handles.
    storage.runnerWrapperStartTimeMs = 1000;
    storage.procfsRoot = join(storage.home, 'fixture-runner-proc');
    await mkdir(join(storage.procfsRoot, 'task', String(storage.runnerWrapperPid)), { recursive: true });
    const stat = Array<string>(22).fill('0');
    stat[0] = 'S'; stat[1] = '1'; stat[2] = String(storage.runnerWrapperPid); stat[3] = String(storage.runnerWrapperPid); stat[19] = '100';
    await Promise.all([
      writeFile(join(storage.procfsRoot, 'stat'), `${storage.runnerWrapperPid} (fixture-runner) ${stat.join(' ')}`),
      writeFile(join(storage.procfsRoot, 'status'), `Uid:\t${process.getuid?.() ?? 1000}\t0\t0\t0\n`),
      writeFile(join(storage.procfsRoot, 'cmdline'), storage.runnerCommand.split(' ').join('\0')),
      ...['environ', 'cgroup', join('task', String(storage.runnerWrapperPid), 'children')].map(path => writeFile(join(storage.procfsRoot, path), '')),
    ]);
    const preparePhysicalLaunchSentinel = async () => {
      const bootstrapDir = join(storage.home, 'tmp', 'runner-agent-session-bootstraps');
      const [file] = await readdir(bootstrapDir);
      storage.runnerBootstrapPath = join(bootstrapDir, file!);
      storage.runnerSpawn = () => { physicalLaunchReached = true; throw new Error('Observed physical launch boundary'); };
    };
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(storage.runnerWrapperPid), startedBy: 'daemon', pid: storage.runnerWrapperPid,
      happySessionId: sessionId, processCommand: storage.runnerCommand, processStartTimeMs: storage.runnerWrapperStartTimeMs,
      processCommandHash: (await import('node:crypto')).createHash('sha256').update(storage.runnerCommand).digest('hex'),
      vendorResumeId: 'pr536-native-thread', spawnOptions: { ...base.options, agentTarget: target,
        backendTarget: projectResolvedAgentBackendTarget(target, producedDescriptor.agentId),
        runtimeDescriptorV1: producedDescriptor, existingSessionId: sessionId, resume: 'pr536-native-thread',
        beforeSessionRunnerLaunch: async () => {
          launchReached = true;
          launchAdmissionChecks += 1;
          await preparePhysicalLaunchSentinel();
          if (retirement === 'late-stop') {
            // Source subprocesses no longer build workspace dists. Retire at
            // the route's final public launch-admission hook instead.
            if (launchAdmissionChecks === 2) {
              await daemon?.stopSession(sessionId);
              signalSent = true;
            }
          } else if (retirement === 'internal-stop') await daemon?.stopSession(sessionId);
          else if (!repairsTopology) await daemon?.stopControlServer();
          return true;
        } } };
    const trackedSessions = new Map([[tracked.trackingKey, tracked]]);
    const metadata = buildSessionMetadataEnvelopeFields({ credentials: installedCredentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', agentState: null, metadata: { path: storage.home, machineId: 'df38-machine',
        hostPid: tracked.pid, hostProcessStartTimeMs: tracked.processStartTimeMs, terminal: { mode: 'plain' },
        runtimeDescriptorV1: producedDescriptor, acpConfiguredBackendV1: buildAcpConfiguredBackendV1({
          updatedAt: 1, backendId: 'alpha', title: 'alpha' }) } });
    let row = V2SessionByIdResponseSchema.parse({ session: { ...createSessionNotificationContextFixture(sessionId),
      encryptionMode: 'plain', metadataLayoutVersion: 1, share: null, machineId: 'df38-machine',
      metadata: metadata.sharedMetadata.ciphertext, ownerMetadata: metadata.ownerMetadata, agentState: metadata.agentState } }).session;
    const actualKill = process.kill;
    spies.push(vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (Math.abs(pid) === tracked.pid) {
        if (signal === 0 && storage.runnerExited) throw Object.assign(new Error('Synthetic predecessor exited'), { code: 'ESRCH' });
        if (signal !== 0) {
          signalSent = true;
        }
        return true;
      }
      return actualKill(pid, signal);
    }));
    spies.push(vi.spyOn(axios, 'get').mockImplementation(async url => {
      const pathname = new URL(String(url)).pathname;
      const catalog = readFixtureCatalogResponse(pathname);
      if (catalog) return catalog;
      if (pathname === `/v2/sessions/${sessionId}`) return homeResponse({ session: row });
      if (pathname === '/v1/machines/df38-machine') return homeResponse({ machine: { id: 'df38-machine',
        installationId: installation.installationId, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
        access: { custodian: { accountId: 'df38-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } });
      if (pathname === '/v1/account/encryption/currentness') return homeResponse(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
      if (pathname === '/v1/auth/ping') return homeResponse({ ok: true });
      if (pathname === '/v1/artifacts') return homeResponse([]);
      throw new Error(`Unexpected test Home GET ${pathname}`);
    }));
    spies.push(vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
      if (new URL(String(url)).pathname !== `/v2/sessions/${sessionId}`) throw new Error('Unexpected retirement Home PATCH');
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner') throw new Error('Expected the retained owner tuple');
      row = V2SessionByIdResponseSchema.parse({ session: { ...row, metadata: patch.sharedMetadata.ciphertext,
        metadataVersion: patch.sharedMetadata.expectedVersion + 1, ownerMetadata: patch.ownerMetadata,
        agentState: patch.agentState.ciphertext, agentStateVersion: patch.agentState.expectedVersion + 1 } }).session;
      return homeResponse(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }));
    }));
    const previousSocketBoundary = storage.io.getMockImplementation();
    const idleChildRuns = ExecutionRunListResponseSchema.parse({ runs: [] });
    // The Session Home RPC is a network boundary. A planned restart observes
    // its real child-Run guard instead of inheriting a previous case's socket.
    storage.io.mockImplementation((_url, options) => {
      expect(options?.auth).toMatchObject({ clientType: 'user-scoped', token: storage.credentials.token });
      return createApiSessionSocketStub({ emitWithAck: (event, payload) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        if (payload && typeof payload === 'object'
          && Reflect.get(payload, 'method') === `${sessionId}:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`) {
          const request: unknown = Reflect.get(payload, 'params');
          if (!request || typeof request !== 'object') throw new Error('Expected restart admission request');
          // The planned-restart gate reads the live host's settled activity before it signals.
          if (Reflect.get(request, 'action') === 'activity_read') {
            return { ok: true, result: { nativeRuntimeActivity: 'settled', session: 'settled', input: 'settled' } };
          }
          expect(request).toMatchObject({ expectedPid: tracked.pid });
          return { ok: true, result: { status: 'ready' } };
        }
        const method = `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_LIST}`;
        expect(payload).toMatchObject({ method, params: {}, timeoutMs: null });
        return { ok: true, result: idleChildRuns };
      } });
    });
    let cleanupCompletion: Promise<void> | undefined;
    const cleanup = () => cleanupCompletion ??= (async () => {
      await daemon?.stopControlServer();
      await daemonMutationCustody.close();
      for (const spy of spies.reverse()) spy.mockRestore();
      if (previousSocketBoundary) storage.io.mockImplementation(previousSocketBoundary);
      else storage.io.mockReset();
      vi.stubGlobal('fetch', originalFetch);
      storage.runnerCommand = ''; storage.runnerExited = false; storage.runnerWrapperPid = 0;
      storage.runnerWrapperStartTimeMs = 2; storage.procfsRoot = '';
      storage.runnerSpawn = null; storage.runnerBootstrapPath = '';
      storage.sourceChecks = null;
      vi.unstubAllEnvs();
      storage.beforeTerminalAttachmentRead = null;
      storage.ordinaryStoredCredentials = false;
      storage.credentials = originalCredentials;
      storage.persistedToken = originalCredentials.token;
    })();
    onTestFinished(cleanup);
    try {
      const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
        capabilities: { serverIdentity: { serverIdentityId: 'srv_df38_owner' } } });
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return url.pathname.startsWith('/v1/features') ? Response.json(features) : await originalFetch(input, init);
      });
      daemon = await startDaemonSessionControlRuntime({ machineId: 'df38-machine', serverId: 'df38-home',
        serverBaseUrl: configuration.serverUrl, credentials: installedCredentials, api: spawnApi,
        resolveCurrentMachineExecutionOriginContext: async () => ({
          serverIdentityId: 'srv_df38_owner', machineId: 'df38-machine' }),
        daemonSessionMutationCustody: daemonMutationCustody, externalActionAccountId: 'df38-owner',
        connectedServicesMaterializationBaseDir: join(storage.home, 'connected-services'),
        getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
        trackedSessionsByKey: trackedSessions, spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
        getApiMachineForSessions: () => null, spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
        connectedServicesRestartRequestedSessions: new Set(), beforeShutdown: async () => {}, onHappySessionWebhook: () => {},
        ...(repairsTopology ? { startupTerminalRecovery: { disconnectedTerminalHostCandidates: [],
          unresolvedTerminalHostSessionIds: [sessionId] } } : {}),
        requestShutdown: () => {}, processEnv: { ...process.env } });
      // The public runtime entry feeds Machine RPC. An earlier Stop must
      // allow new explicit Resume, while Stop during preparation still fences it.
      trackedSessions.delete(tracked.trackingKey);
      storage.runnerExited = true;
      if (retirement === 'previous-stop') await daemon.stopSession(sessionId);
      let repairReadStarted!: () => void;
      let releaseRepairRead!: () => void;
      const repairRead = new Promise<void>(resolve => { repairReadStarted = resolve; });
      const repairRelease = new Promise<void>(resolve => { releaseRepairRead = resolve; });
      if (retirement === 'topology-repair-stop' || retirement === 'post-stop-resume') storage.beforeTerminalAttachmentRead = async () => {
        storage.beforeTerminalAttachmentRead = null;
        repairReadStarted();
        await repairRelease;
      };
      const resume = daemon.spawnSession(tracked.spawnOptions!);
      let externalStop: ReturnType<typeof daemon.stopSession> | undefined;
      if (retirement === 'topology-repair-stop' || retirement === 'post-stop-resume') {
        // Hold only descriptor filesystem I/O inside the real repair Stop.
        // External Stop then joins that retirement's coalesced physical operation.
        await repairRead;
        externalStop = daemon.stopSession(sessionId);
        releaseRepairRead();
      }
      if (retirement === 'post-stop-resume') {
        await externalStop;
        secondResume = daemon.spawnSession({ ...tracked.spawnOptions!, beforeSessionRunnerLaunch: async () => {
          await preparePhysicalLaunchSentinel();
          return true;
        } });
      }
      const response = await resume;
      await externalStop;
      if (retirement === 'previous-stop' || retirement === 'topology-repair') {
        expect(physicalLaunchReached, JSON.stringify(response)).toBe(true);
      } else {
        if (retirement !== 'topology-repair-stop' && retirement !== 'post-stop-resume') expect(launchReached).toBe(true);
        if (retirement === 'late-stop') expect(signalSent, 'Stop must complete at final launch admission').toBe(true);
        expect(response, JSON.stringify(response)).toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
        if (response.type !== 'error') throw new Error('Expected retired launch custody refusal');
        expect(SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(response)))
          .toMatchObject({ errorCode: 'DAEMON_RPC_UNAVAILABLE' });
      }
      if (retirement === 'post-stop-resume') {
        expect(secondResume, 'A fresh Resume must be issued after Stop completes').toBeDefined();
        expect(await secondResume, 'The post-Stop Resume must reach its own launch, not join the stale predecessor')
          .toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED' });
      }
      expect(physicalLaunchReached).toBe(retirement === 'previous-stop' || retirement === 'topology-repair' || retirement === 'post-stop-resume');
      await vi.waitFor(() => expect(daemon?.hasPendingRunnerRestarts()).toBe(false));
    } finally {
      await cleanup();
    }
  });

  it('carries the admitted bootstrap through the real catalog runner into strict model ingress', async () => {
    // Process exit and file logging are OS boundaries. No runner, catalog,
    // model resolver or host runtime is replaced. Absent daemon authority
    // stops this in-process child before a real vendor process can start.
    const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('df40-child-exit'); });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const definitionId of ['alpha', 'beta']) {
        let enteredRunner = false;
        const failures: Array<Readonly<{ modelDefinition: string; error: unknown }>> = [];
        const result = await executeSpawnSessionRequest(params(definitionId, async () => {
          const bootstrapDir = join(configuration.happyHomeDir, 'tmp', 'runner-agent-session-bootstraps');
          const [file] = await readdir(bootstrapDir);
          const bootstrapPath = join(bootstrapDir, file!);
          const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(bootstrapPath, 'utf8')));
          const target = AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId });
          const backendTarget = projectResolvedAgentBackendTarget(target, bootstrap.descriptor.agentId);
          const command = resolveDaemonCliSubcommandFromBackendTarget(backendTarget)!;
          const handler = await requireCatalogEntry(command).getCliCommandHandler!();
          vi.stubEnv(HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY, bootstrapPath);
          vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, '');
          for (const modelDefinition of [definitionId, 'wrong-definition']) {
            fatal.mockClear();
            const selection = SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1,
              ref: { agentTargetKey: `agent:happier.agent.custom-acp/custom-acp:definition:${modelDefinition}`,
                providerConnectionId: null, modelId: 'ollama/qwen2.5:3b' } });
            const args = [command, '--started-by', 'daemon', ...buildHappySessionControlArgs({ backendTarget, modelSelection: selection })];
            await expect(handler({ args, rawArgv: ['happier', ...args], terminalRuntime: null })).rejects.toThrow('df40-child-exit');
            failures.push({ modelDefinition, error: fatal.mock.calls.at(-1)?.[0] });
          }
          enteredRunner = true;
          return false;
        }));
        expect({ enteredRunner, result }, JSON.stringify(result)).toMatchObject({ enteredRunner: true,
          result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
        expect(failures[0]?.error).toMatchObject({ code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING' });
        expect(failures[1]?.error).toMatchObject({ code: 'model_selection_agent_target_mismatch' });
      }
    } finally {
      vi.unstubAllEnvs();
      fatal.mockRestore();
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  it('carries each qualified definition through execution surfaces and bootstrap into its exact spawn specification', async () => {
    for (const definitionId of ['alpha', 'beta']) {
      let reachedLaunch = false;
      const result = await executeSpawnSessionRequest(params(definitionId, async () => {
        const bootstrapDir = join(configuration.happyHomeDir, 'tmp', 'runner-agent-session-bootstraps');
        const files = await readdir(bootstrapDir);
        expect(files).toHaveLength(1);
        const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(join(bootstrapDir, files[0]!), 'utf8')));
        const descriptor = RuntimeDescriptorV1Schema.parse(bootstrap.launch?.runtimeDescriptorV1);
        expect(descriptor.agent.definitionId).toBe(definitionId);
        const selectedTarget = AgentExecutionTargetV1Schema.parse({ kind: 'agent',
          identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId });
        expect(await resolveTrackedSessionTerminalPresentation({ trackingKey: legacyPidSessionTrackingKey(process.pid), startedBy: 'daemon', pid: process.pid,
          spawnOptions: { directory: storage.home, agentTarget: selectedTarget,
            backendTarget: projectResolvedAgentBackendTarget(selectedTarget, descriptor.agentId),
            runtimeDescriptorV1: descriptor } }, 'plain')).toEqual({ kind: 'none' });
        const launch = await resolveAccountConfiguredAcpLaunchForAgent({ identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
          startupRuntimeDescriptorV1: descriptor });
        expect(await launch?.resolveHostLaunch({ cwd: storage.home })).toMatchObject({
          command: process.execPath, args: [`${definitionId}.mjs`], env: { DF38_SELECTION: definitionId } });
        reachedLaunch = true;
        // The production pre-launch custody hook refuses physical execution;
        // the test observes the real spec without launching another daemon.
        return false;
      }));
      expect({ reachedLaunch, result }, JSON.stringify(result)).toMatchObject({ reachedLaunch: true,
        result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
    }
  });

  it('verifies member Machine authority once per start and independently admits the next start', async () => {
    const memberCredentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'df38-member' })).toString('base64url')}.signature`,
      encryption: null };
    const installation = await readOrCreateInstallationIdentity();
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Expected admitted Account settings');
    setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: resolveAccountSettingsScopeKey(memberCredentials) });
    const originalGet = vi.mocked(axios.get).getMockImplementation();
    let access = true;
    const admissionRequests: unknown[] = [];
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return homeResponse({ id: 'df38-member' });
      if (path === '/v1/machines/df38-machine') return homeResponse({ machine: {
        id: 'df38-machine', installationId: installation.installationId,
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
        access: { custodian: { accountId: 'df38-owner', displayName: 'Owner' }, role: 'use',
          resourceMode: 'plain', accessState: 'ready' },
      } });
      if (originalGet) return originalGet(url, options);
      throw new Error(`Unexpected member start GET ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      const path = new URL(String(url)).pathname;
      const availability = readBundledPluginAvailabilityHttpFixture(path, body);
      if (availability) return homeResponse(availability);
      if (path === '/v2/sessions/lookup-by-tags') return homeResponse({ sessions: [] });
      if (path !== '/v1/machines/df38-machine/admission/verify') throw new Error(`Unexpected member start POST ${path}`);
      if (!body || typeof body !== 'object' || !('context' in body) || !('purpose' in body) || !('proof' in body)) {
        throw new Error('Missing signed member admission request');
      }
      const context = SocketRpcMachineAdmissionContextV1Schema.parse(body.context);
      const purpose = RequesterSessionCurrentnessPurposeV1Schema.parse(body.purpose);
      const proof = MachineInstallationProofV1Schema.parse(body.proof);
      const valid = context.actorAccountId === 'df38-member' && context.custodianAccountId === 'df38-owner'
        && context.role === 'use' && verifyMachineInstallationProof({ publicKey: installation.publicKey, proof,
          payload: { version: 1, accountId: 'df38-owner', machineId: 'df38-machine', installationId: installation.installationId,
            rpcAdmission: { context, purpose } } });
      admissionRequests.push({ actorAccountId: context.actorAccountId, valid });
      return homeResponse(access && valid ? { v: 1, ok: true } : { error: 'access_denied' }, access && valid ? 200 : 403);
    });
    let launchPreparations = 0;
    const originalPersistedToken = storage.persistedToken;
    try {
      // Configured ACP opens the selected Account's ordinary credential file.
      // Keep the custodian daemon bearer separate for signed Home admission.
      storage.persistedToken = memberCredentials.token;
      const input = { ...params('alpha', async () => { launchPreparations++; return false; }),
        credentials: memberCredentials, api: await ApiClient.create(memberCredentials) };
      input.options.verifyRequesterMachineAdmissionCurrent = () => verifyRequesterSessionMachineAdmissionCurrent({
        credentials: memberCredentials, attribution: { serverId: 'df38-home', accountId: 'df38-member',
          machineId: 'df38-machine', installationId: installation.installationId }, sessionId: 'member-start',
        serverHttpBaseUrl: configuration.serverUrl, boundary: { machineId: 'df38-machine', daemonToken: storage.credentials.token,
          isHomeCurrent: () => true, readInstallation: () => installation },
      });
      const admitted = await executeSpawnSessionRequest(input);
      expect({ launchPreparations, admitted }, JSON.stringify(admitted.type === 'error'
        ? projectSpawnSessionControlErrorResponse(admitted) : admitted)).toMatchObject({ launchPreparations: 1,
        admitted: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
      // This counts the signed Home authority boundary, through the real start
      // and preparation owners, rather than calls to an internal helper spy.
      const admittedRequests = [...admissionRequests];
      access = false;
      const refused = await executeSpawnSessionRequest(input);
      expect(refused).toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
      expect(launchPreparations).toBe(1);
      expect(admissionRequests.slice(admittedRequests.length)).toEqual([{ actorAccountId: 'df38-member', valid: true }]);
      expect(admittedRequests).toEqual([{ actorAccountId: 'df38-member', valid: true }]);
    } finally {
      storage.persistedToken = originalPersistedToken;
      get.mockRestore();
      post.mockRestore();
    }
  });

  it.each(['requester_machine_admission_unavailable', 'requester_home_unavailable', 'session_handoff_launch_custody_unavailable'] as const)(
    'identifies the start admission and handoff refusal cause (%s)', async (cause) => {
      const diagnostic = vi.spyOn(logger, 'infoFile');
      const input = params('alpha', async () => cause !== 'session_handoff_launch_custody_unavailable');
      // Requester authority is checked at admission; the independent handoff
      // custody boundary remains immediately before the physical launch.
      input.options.verifyRequesterMachineAdmissionCurrent = async () => {
        if (cause === 'requester_home_unavailable') {
          throw Object.assign(new Error('Home unavailable'), { response: { status: 503 } });
        }
        return cause !== 'requester_machine_admission_unavailable';
      };
      const result = await executeSpawnSessionRequest(input);
      expect(result).toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
      expect(diagnostic).toHaveBeenCalledWith('[DAEMON RUN] Spawn launch admission refused', expect.objectContaining({ cause }));
      if (result.type !== 'error') throw new Error('Expected launch admission refusal');
      expect(SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(result)))
        .toMatchObject({ errorCode: 'DAEMON_RPC_UNAVAILABLE',
          ...(cause === 'requester_home_unavailable' ? { errorDetail: { kind: 'requester_home_unavailable' } } : {}) });
      if (cause !== 'requester_home_unavailable') expect(result.errorDetail).toBeUndefined();
    },
  );

  it.each(['permission', 'ceiling'] as const)('retains a thrown typed %s launch cause through the Session result presenter', async cause => {
    const code = cause === 'ceiling' ? 'SPAWN_VALIDATION_FAILED' : 'EACCES';
    const result = await executeSpawnSessionRequest(params('alpha', async () => {
      if (cause === 'ceiling') {
        await prepareCgroupProcessLaunchScope({ memoryHighBytes: 1073741824,
          procfsRootDir: join(storage.home, 'missing-proc'), environment: { PATH: storage.home },
          systemdUserResourceGovernorExecFile: async () => { throw new Error('No user manager'); } });
        return false;
      }
      throw Object.assign(new Error('Launch permission refused'), { code: 'EACCES' });
    }));
    expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
      errorDetail: { kind: 'launch_error', code, message: expect.any(String) } });
    if (result.type !== 'error') throw new Error('Expected a launch failure');
    const response = SpawnSessionControlErrorResponseSchema.parse(projectSpawnSessionControlErrorResponse(result));
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: response.errorCode!, errorMessage: response.error, errorDetail: response.errorDetail,
    }))).toMatchObject({ code: 'spawn_failed', launchError: { code, message: result.errorDetail?.kind === 'launch_error' ? result.errorDetail.message : '' } });
  });

  it('refuses a missing selected executable with the Agent-not-installed code before runner launch', async () => {
    const result = await executeSpawnSessionRequest(params('missing', async () => {
      throw new Error('A missing executable must never reach runner admission');
    }));
    expect(result, JSON.stringify(result)).toMatchObject({ type: 'error', errorCode: 'agent_cli_missing', agentId: 'custom-acp' });
  });

  it('refuses a launch for a backend disabled in Account Settings before runner launch', async () => {
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Expected the fixture Account Settings snapshot');
    setActiveAccountSettingsSnapshot({ ...snapshot, settingsVersion: snapshot.settingsVersion + 1, settings: accountSettingsParse({
      backendEnabledByTargetKey: { [buildBackendTargetKeyV2({
        kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'alpha' })]: false },
    }) });
    const result = await executeSpawnSessionRequest(params('alpha', async () => {
      throw new Error('A disabled backend must never reach runner admission');
    }));
    expect(result, JSON.stringify(result)).toMatchObject({ type: 'error', errorCode: 'backend_disabled' });
  });

  // A daemon prepares every launch under its own credentials. When the ambient
  // Account no longer matches them, a captured takeover is refused before
  // launch (visible, retryable) rather than prepared under another Account.
  it('refuses a captured-Account takeover before launch after an ambient Account switch while a new launch admits independently', async () => {
    const snapshot = getActiveAccountSettingsSnapshot();
    if (!snapshot) throw new Error('Expected the fixture Account Settings snapshot');
    const capturedCredentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'takeover-account-a' })).toString('base64url')}.signature`, encryption: null };
    const ambientCredentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'takeover-account-b' })).toString('base64url')}.signature`, encryption: null };
    const targetKey = buildBackendTargetKeyV2({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'alpha' });
    const waiter = createPersistedTakeoverAdmissionWaiter();
    const correlation = { mode: 'external_linked' as const, operationId: 'captured-takeover', attemptId: 'captured-attempt' };
    const accountScope = resolveExternalSessionOperationAccountScope(configuration.activeServerDir, capturedCredentials.token);
    if (!accountScope) throw new Error('Expected captured Account scope');
    waiter.register(correlation, { context: { credentials: capturedCredentials, accountScope } });
    setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: resolveAccountSettingsScopeKey(ambientCredentials),
      settings: accountSettingsParse({ backendEnabledByTargetKey: { [targetKey]: false } }) });
    const ambientSnapshot = getActiveAccountSettingsSnapshot();
    const originalPersistedToken = storage.persistedToken;
    storage.persistedToken = ambientCredentials.token;
    const originalGet = vi.mocked(axios.get).getMockImplementation();
    const settingsSubjects: string[] = [];
    const catalogSubjects: string[] = [];
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      const authorization = AxiosHeaders.from(options?.headers).get('Authorization');
      if (path === '/v1/account/entity-rows/acp') {
        catalogSubjects.push(authorization === `Bearer ${capturedCredentials.token}` ? 'a' : 'other');
      }
      if (path === '/v2/account/settings') {
        settingsSubjects.push(authorization === `Bearer ${capturedCredentials.token}` ? 'a' : 'other');
        return homeResponse({ content: { t: 'plain', v: snapshot.settings }, version: snapshot.settingsVersion });
      }
      if (originalGet) return originalGet(url, options);
      throw new Error(`Unexpected takeover GET ${path}`);
    });
    let reachedCapturedLaunch = false;
    try {
      const ordinary = params('alpha', async () => { reachedCapturedLaunch = true; return false; });
      const input = { ...ordinary, persistedTakeoverAdmissionWaiter: waiter,
        options: { ...ordinary.options, persistedTakeoverAdmission: correlation } };
      const result = await executeSpawnSessionRequest(input);
      expect({ reachedCapturedLaunch, result }).toMatchObject({ reachedCapturedLaunch: false,
        result: { type: 'error', errorCode: 'INVALID_REQUEST' } });
      expect([...settingsSubjects, ...catalogSubjects]).not.toContain('a');
      expect(getActiveAccountSettingsSnapshot()).toBe(ambientSnapshot);
      const fresh = { ...params('alpha', async () => { throw new Error('A newly admitted launch must use the ambient Account policy'); }),
        credentials: ambientCredentials, api: await ApiClient.create(ambientCredentials) };
      expect(await executeSpawnSessionRequest(fresh)).toMatchObject({ type: 'error', errorCode: 'backend_disabled' });
    } finally { reads.mockRestore(); storage.persistedToken = originalPersistedToken; }
  });

  it('supplies a cause code for an unexpected uncoded launch failure', async () => {
    const result = await executeSpawnSessionRequest(params('alpha', async () => { throw new Error('Unexpected launch failure'); }));
    expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
      errorDetail: { kind: 'launch_error', code: 'SPAWN_FAILED', message: 'Unexpected launch failure' } });
  });

  it('preserves the first Account launch-custody refusal code', async () => {
    storage.persistedToken = 'foreign-account-token';
    const result = await executeSpawnSessionRequest(params('alpha', async () => {
      throw new Error('Unavailable Account launch custody must not reach runner admission');
    }));
    expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
      errorDetail: { kind: 'launch_error', code: 'connected_account_purpose_catalog_unavailable' } });
  });

  it('validates the selected command on the supplied launch PATH', async () => {
    const bin = await mkdtemp(join(storage.home, 'bin-'));
    const command = 'df38-path-only-agent';
    await writeExecutableShim({ dir: bin, fileName: command,
      contents: process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n' });
    const snapshot = getActiveAccountSettingsSnapshot()!;
    if (snapshot.acpCatalog?.status !== 'ready') throw new Error('Expected the ready launch catalog');
    commitActiveAcpCatalog({ scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { ...snapshot.acpCatalog, revision: 5, record: AcpCatalogRecordV1Schema.parse({ v: 1,
        definitions: snapshot.acpCatalog.record.definitions.map(definition => definition.id === 'alpha'
          ? { ...definition, launch: { kind: 'command', command, args: [] } } : definition) }) } });
    fixtureCatalogRow = getActiveAccountSettingsSnapshot()?.acpCatalog;
    let reached = false;
    const input = params('alpha', async () => { reached = true; return false; });
    const result = await executeSpawnSessionRequest({ ...input,
      processEnv: { ...input.processEnv, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` } });
    expect({ reached, result }, JSON.stringify(result)).toMatchObject({ reached: true,
      result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
  });

  it('validates a relative configured command from the Session directory', async () => {
    const command = 'df38-relative-agent';
    await writeExecutableShim({ dir: storage.home, fileName: command,
      contents: process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n' });
    const snapshot = getActiveAccountSettingsSnapshot()!;
    if (snapshot.acpCatalog?.status !== 'ready') throw new Error('Expected the ready launch catalog');
    commitActiveAcpCatalog({ scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { ...snapshot.acpCatalog, revision: 5, record: AcpCatalogRecordV1Schema.parse({ v: 1,
        definitions: snapshot.acpCatalog.record.definitions.map(definition => definition.id === 'alpha'
          ? { ...definition, launch: { kind: 'command', command: `./${command}`, args: [] } } : definition) }) } });
    fixtureCatalogRow = getActiveAccountSettingsSnapshot()?.acpCatalog;
    let reached = false;
    const result = await executeSpawnSessionRequest(params('alpha', async () => { reached = true; return false; }));
    expect({ reached, result }, JSON.stringify(result)).toMatchObject({ reached: true,
      result: { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' } });
  });

  it('refuses a selected command whose required JavaScript runtime cannot resolve', async () => {
    const command = await writeExecutableShim({ dir: storage.home, fileName: 'df40-node-agent',
      contents: '#!/usr/bin/env node\nprocess.exit(0);\n' });
    const snapshot = getActiveAccountSettingsSnapshot()!;
    if (snapshot.acpCatalog?.status !== 'ready') throw new Error('Expected the ready launch catalog');
    commitActiveAcpCatalog({ scopeKey: snapshot.scopeKey!, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
      catalog: { ...snapshot.acpCatalog, revision: 5, record: AcpCatalogRecordV1Schema.parse({ v: 1,
        definitions: snapshot.acpCatalog.record.definitions.map(definition => definition.id === 'alpha'
          ? { ...definition, launch: { kind: 'command', command, args: [] } } : definition) }) } });
    fixtureCatalogRow = getActiveAccountSettingsSnapshot()?.acpCatalog;
    let reachedRunner = false;
    const input = params('alpha', async () => { reachedRunner = true; return false; });
    // An explicit invalid runtime override is exclusive at the real managed
    // JavaScript resolver. A present vendor script alone is not launchability.
    const result = await executeSpawnSessionRequest({ ...input,
      processEnv: { ...input.processEnv, HAPPIER_JS_RUNTIME_PATH: 'df40-unresolved-runtime' } });
    expect({ reachedRunner, result }, JSON.stringify(result)).toMatchObject({ reachedRunner: false,
      result: { type: 'error', errorCode: 'agent_cli_missing', agentId: 'custom-acp' } });
  });
});
