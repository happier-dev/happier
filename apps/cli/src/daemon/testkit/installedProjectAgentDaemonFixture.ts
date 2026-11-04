import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, onTestFinished } from 'vitest';
import { readStoredCredentialsForServerId, writeCredentialsTokenOnly, writeStoredCredentialsForServerId, type StoredCredentials } from '@/persistence';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema, type AgentRuntimeDaemonServiceRequestV1, type AgentRuntimeDaemonServiceResponseV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import type { TrackedSession } from '@/daemon/types';
import type { AgentSessionRunnerBindingV1 } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createRequesterSessionRuntimeContextResolver, releaseUnretainedRequesterSessionRuntimeContext,
  resolveRequesterSessionBootstrapFromCustody, type RequesterSessionRuntimeContext, type ResolveRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { createOnHappySessionWebhook } from '@/daemon/sessions/onHappySessionWebhook';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import { createInstalledProjectAgentLaunchFixture } from './installedProjectAgentLaunchFixture';

type InstalledProjectAgentLaunchFixture = Awaited<ReturnType<typeof createInstalledProjectAgentLaunchFixture>>;
type InstalledProjectAgentDaemonFixtureOwners = Readonly<{
  signal: AbortSignal;
  cwd: string;
  dispatch(operation: AgentRuntimeDaemonServiceRequestV1['operation'], executionRunSnapshotId?: string): Promise<AgentRuntimeDaemonServiceResponseV1>;
  operationBase(invocationId?: string): { invocationId: string; requestId: string };
  sessionId: string;
  retainedAgent: AgentSessionRunnerBindingV1;
  requester: RequesterSessionRuntimeContext;
  runner: Readonly<{ pid: number; processStartTimeMs: number; processCommandHash: string; snapshotIdentity: string }>;
  tracked: TrackedSession;
  plugin: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>;
  pidToTrackedSession: Map<number, TrackedSession>;
  connectedServiceRuntimeRegistry: ConnectedServiceRuntimeRegistry;
  pidToAwaiter: Map<number, (tracked: TrackedSession) => void>;
  daemon: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>>;
  resolveRequesterRuntime: ResolveRequesterSessionRuntimeContext;
  readRequesterRecoveryStage(): string;
  replaceRequesterRuntime(): Promise<RequesterSessionRuntimeContext>;
}>;
/** Named so declaration emit references the composed owners instead of
 * serializing their inferred shapes. */
export type InstalledProjectAgentDaemonFixture = Omit<InstalledProjectAgentLaunchFixture, keyof InstalledProjectAgentDaemonFixtureOwners>
  & InstalledProjectAgentDaemonFixtureOwners;

export async function createInstalledProjectAgentDaemonFixture(readControl: () => Parameters<typeof startDaemonControlServer>[0] | null, bundledAgentId?: string, unassociated = false,
  authoredPlugin?: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins'][number],
  controller?: PluginReloadController,
  requesterOptions?: Partial<Pick<Parameters<typeof createRequesterSessionRuntimeContext>[0], 'resolveQualifiedConnectedAccountV4Support'>>
    & Partial<Pick<Parameters<typeof startDaemonSessionControlRuntime>[0], 'resolveCurrentMachineExecutionOriginContext' | 'processEnv' | 'openTeamCredentialProviderBinding'>>
    & Partial<Pick<Parameters<typeof startDaemonSessionControlRuntime>[0], 'credentials' | 'externalActionAccountId' | 'agentIsolation' | 'onLocalServicesRoutesReady' | 'resolveServerFeaturesSnapshot' | 'releaseSessionOwnedNativeBindings' | 'getApiMachineForSessions'>>
    & Pick<NonNullable<Parameters<typeof createInstalledProjectAgentLaunchFixture>[0]>, 'machineAccess' | 'serverId' | 'homeServerIdentityId' | 'accountSettings' | 'machineRpcMethods'>
    & { requesterCredentials?: StoredCredentials; ordinaryAccountSession?: boolean }): Promise<InstalledProjectAgentDaemonFixture> {
  let daemonCredentials = requesterOptions?.credentials ?? { token: 'custodian-token', encryption: null };
  const serverId = requesterOptions?.serverId ?? 'session-home';
  // This Home fixture owns original admission; normal fixtures retain its
  // actual held identity rather than relying on later legacy recovery to invent birth.
  const fixtureHome = requesterOptions?.homeServerIdentityId
    ?? (await requesterOptions?.resolveCurrentMachineExecutionOriginContext?.())?.serverIdentityId
    ?? 'srv_installed_project_fixture';
  const birth = {
    homeServerIdentityId: fixtureHome, boundSessionId: 'project-session',
  };
  const accountActionCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester',
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const fixture = await createInstalledProjectAgentLaunchFixture(unassociated
    ? { prepareProject: false, serverId, ...birth, requesterCredentials: requesterOptions?.requesterCredentials, machineAccess: requesterOptions?.machineAccess,
      accountSettings: requesterOptions?.accountSettings,
      machineRpcMethods: requesterOptions?.machineRpcMethods,
      resolveCurrentMachineExecutionOriginContext: requesterOptions?.resolveCurrentMachineExecutionOriginContext,
      ...(requesterOptions?.ordinaryAccountSession ? { accountActionCredentials } : {}) }
    : { serverId, ...birth, accountActionCredentials, machineAccess: requesterOptions?.machineAccess,
      accountSettings: requesterOptions?.accountSettings,
      machineRpcMethods: requesterOptions?.machineRpcMethods,
      resolveCurrentMachineExecutionOriginContext: requesterOptions?.resolveCurrentMachineExecutionOriginContext });
  const { f, machine } = fixture;
  const signal: AbortSignal = fixture.signal;
  const runtimeController = controller ?? pluginReloadController;
  const cwd = unassociated ? join(f.directory, 'fresh-unassociated') : fixture.cwd;
  if (unassociated) await mkdir(cwd);
  await writeCredentialsTokenOnly(accountActionCredentials);
  await writeStoredCredentialsForServerId(serverId, accountActionCredentials);
  expect((await readStoredCredentialsForServerId(serverId))?.token === accountActionCredentials.token,
    'The Account Action fixture must retain its canonical Home credentials').toBe(true);
  if (requesterOptions?.ordinaryAccountSession) {
    daemonCredentials = (await readStoredCredentialsForServerId(serverId))!;
  }
  const plugin = bundledAgentId ? await createAdmittedPluginRuntimeFixture({ happyHomeDir: f.directory,
    controller: runtimeController, runtimeOptions: { pluginIds: [`happier.agent.${bundledAgentId}`] } })
    : await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: f.directory, controller: runtimeController,
    plugins: [authoredPlugin ?? { manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', contributes: { agents: [{ id: 'agent', title: 'Project launch Agent',
      runtime: { kind: 'custom' }, primary: 'sessions', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }] } }),
      files: { 'agent.mjs': `export function factory() { return { sessions: { open() { throw new Error('No Agent open at authorization'); } } }; }`,
        'daemon.mjs': `import { factory } from './agent.mjs';
        export function activate(api) { api.agents.register('agent', factory, {
          sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } }); }` } }] });
  onTestFinished(() => plugin.dispose());
  const pluginId = bundledAgentId ? `happier.agent.${bundledAgentId}` : 'acme.project-launch';
  const agent = [...plugin.registry.contributes.agentDefinitionsById.values()]
    .find(definition => definition.identity?.pluginId === pluginId);
  if (!agent?.identity) throw new Error(`Missing installed Agent declaration: ${pluginId}`);
  await plugin.registry.activateContributionsOnDemand([{ ...agent.identity, family: 'agents' }]);
  const retainedAgent = plugin.registry.agentRuntimesByAgentId.get(agent.id)?.sessionRunnerFactoryBinding;
  if (!retainedAgent) throw new Error(`Missing genuine retained Agent binding (${bundledAgentId ?? 'acme.project-launch/agent'}); registered: ${[...plugin.registry.agentRuntimesByAgentId.keys()].join(', ')}; diagnostics: ${JSON.stringify(plugin.registry.pluginDiagnosticsByPluginId[bundledAgentId ? `happier.agent.${bundledAgentId}` : 'acme.project-launch'])}`);
  const runner = { pid: process.pid, processStartTimeMs: 1, processCommandHash: 'a'.repeat(64), snapshotIdentity: 'fixture-runner' };
  const sessionId = requesterOptions?.ordinaryAccountSession ? 'ordinary-native-owner' : 'project-session';
  const tracked: TrackedSession = { pid: process.pid, sessionRunnerPid: process.pid, startedBy: 'daemon', happySessionId: sessionId,
    ...(requesterOptions?.ordinaryAccountSession ? {} : { requesterWorkAttributionV1: f.bootstrap.attribution }),
    processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
    runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
    runnerAgentBootstrapIdentity: { agentId: retainedAgent.agentId, backendId: retainedAgent.agentId },
    runnerAgentInvocationContext: { cwd, environment: {}, providerBindingActive: false },
    spawnOptions: { directory: cwd, backendTarget: { kind: 'backend', backendId: retainedAgent.agentId } } };
  const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
  const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
  let createRequesterRuntime: ((bootstrap: typeof f.bootstrap) => ReturnType<typeof createRequesterSessionRuntimeContext>) | null = null;
  let requesterRecoveryStage = 'not_requested';
  const resolveRequesterRuntime = createRequesterSessionRuntimeContextResolver({
    trackedSessions: pidToTrackedSession,
    // Startup precedes construction of the real requester runtime factory.
    getCreateRuntime: () => createRequesterRuntime,
    recoverBootstrap: async ({ sessionId: id, attribution }) => {
      if (id !== sessionId) return null;
      requesterRecoveryStage = 'bootstrap';
      const bootstrap = await resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: f.directory, serverId,
        serverHttpBaseUrl: 'https://session-home.test', sessionId: id, legacyOwnerCredentials: f.bootstrap.credentials,
        ...(attribution ? { expectedAttribution: attribution } : {}), machineAdmissionBoundary: {
          machineId: 'machine', daemonToken: daemonCredentials.token, isHomeCurrent: f.isHomeCurrent, readInstallation: () => f.installation } });
      if (!bootstrap) requesterRecoveryStage = 'bootstrap_refused';
      return bootstrap;
    },
  });
  const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(f.directory, 'fixture-device-secret') });
  const pidToAwaiter = new Map<number, (tracked: TrackedSession) => void>();
  const skillStore = createSkillStore({ happyHomeDir: f.directory });
  onTestFinished(async () => {
    await skillStore.releaseSkillSessionDirs(sessionId);
    await skillStore.collectSkillCache({ libraryDigests: [] });
  });
  const daemon = await startDaemonSessionControlRuntime({ machineId: 'machine', serverId, serverBaseUrl: 'https://session-home.test',
    agentIsolation: requesterOptions?.agentIsolation,
    skillStore,
    resolveCurrentMachineExecutionOriginContext: requesterOptions?.resolveCurrentMachineExecutionOriginContext,
    openTeamCredentialProviderBinding: requesterOptions?.openTeamCredentialProviderBinding,
    onLocalServicesRoutesReady: requesterOptions?.onLocalServicesRoutesReady,
    resolveServerFeaturesSnapshot: requesterOptions?.resolveServerFeaturesSnapshot,
    releaseSessionOwnedNativeBindings: requesterOptions?.releaseSessionOwnedNativeBindings,
    externalActionAccountId: requesterOptions?.externalActionAccountId ?? 'custodian', credentials: daemonCredentials, api: {} as never,
    deviceLocalSecretStorage,
    pluginRuntimeController: plugin.controller, connectedServiceRuntimeRegistry,
    daemonSessionMutationCustody: { stageTranscriptMessage: async () => { throw new Error('No transcript mutation'); },
      stageTranscriptEvent: async () => ({ persisted: true, delivered: true }) },
    connectedServicesMaterializationBaseDir: join(f.directory, 'connected-services'),
    getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
    pidToTrackedSession, pidToAwaiter, pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
    getApiMachineForSessions: requesterOptions?.getApiMachineForSessions ?? (() => machine), spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
    resolveRequesterSessionRuntimeContext: resolveRequesterRuntime,
    releaseRequesterSessionRuntimeContext: async context => {
      await releaseUnretainedRequesterSessionRuntimeContext(context,
        [...pidToTrackedSession.values()].map(session => session.requesterSessionRuntimeContext));
    },
    connectedServicesRestartRequestedPids: new Set(), beforeShutdown: async () => {},
    onHappySessionWebhook: createOnHappySessionWebhook({ pidToTrackedSession, pidToAwaiter, deviceLocalSecretStorage }),
    requestShutdown() {}, processEnv: { NODE_ENV: 'test', ...requesterOptions?.processEnv } });
  onTestFinished(() => daemon.stopControlServer());
  // Full daemon startup binds its produced Account ingress to the Machine.
  // The launch-only fixture predates that owner and cannot publish its routes.
  machine.setRPCHandlers({ spawnSession: daemon.spawnSession, stopSession: daemon.stopSession, requestShutdown() {} }, {
    ...(daemon.externalActionIngressOwner ? { externalActionIngressOwner: daemon.externalActionIngressOwner } : {}),
  });
  createRequesterRuntime = async bootstrap => {
    requesterRecoveryStage = 'runtime';
    const context = await createRequesterSessionRuntimeContext({ bootstrap,
      providerAccountUsageStore: daemon.resolveProviderAccountUsageStore(bootstrap.attribution),
      activeServerDir: f.directory, connectedServicesMaterializationBaseDir: join(f.directory, 'requester-connected-services'),
      resolveQualifiedConnectedAccountV4Support: requesterOptions?.resolveQualifiedConnectedAccountV4Support ?? (() => 'indeterminate'),
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'project-runtime', happyHomeDir: f.directory,
        logger: { debug() {}, info() {}, warn() {} }, processEnv: { NODE_ENV: 'test',
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession, connectedServiceRuntimeRegistry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: daemon.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (context) onTestFinished(() => context.dispose());
    requesterRecoveryStage = context ? 'ready' : 'runtime_refused';
    return context;
  };
  // Keep the separately admitted Account runtime for fixture materialization;
  // native dispatch still resolves the ordinary tracked Session itself.
  const requester = requesterOptions?.ordinaryAccountSession
    ? await createRequesterRuntime(f.bootstrap) : await resolveRequesterRuntime(sessionId, f.bootstrap.attribution);
  if (!requester) throw new Error(`Missing requester runtime (${requesterRecoveryStage})`);
  const services = readControl()?.agentRuntimeDaemonServices;
  if (!services) throw new Error('Missing production private dispatcher');
  let sequence = 0;
  const dispatch = async (operation: AgentRuntimeDaemonServiceRequestV1['operation'], executionRunSnapshotId?: string) => AgentRuntimeDaemonServiceResponseV1Schema.parse(await services.dispatch(
    AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1, context: { token: 'a'.repeat(43), sessionId,
      ...(executionRunSnapshotId ? { executionRunSnapshotId } : {}) }, operation }),
    { sessionId, runner, retainedAgent, trackedSession: tracked, invocationContext: tracked.runnerAgentInvocationContext!,
      isCurrent: async () => true, signal }));
  const operationBase = (invocationId = 'cold-invocation') => ({ invocationId, requestId: `request-${++sequence}` });
  return { ...fixture, signal, cwd, dispatch, operationBase, sessionId, retainedAgent, requester, runner, tracked, plugin, pidToTrackedSession, connectedServiceRuntimeRegistry, pidToAwaiter, daemon,
    resolveRequesterRuntime,
    readRequesterRecoveryStage: () => requesterRecoveryStage,
    async replaceRequesterRuntime() {
      await tracked.requesterSessionRuntimeContext?.dispose();
      const replacement = await resolveRequesterRuntime(sessionId, tracked.requesterWorkAttributionV1);
      if (!replacement) throw new Error('Missing replacement requester runtime');
      return replacement;
    },
  };
}
