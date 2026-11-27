import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import {
  PROJECT_ACCOUNT_ROWS_ROUTE_V1,
  ProjectAccountRowReadRequestV1Schema,
  ProjectAccountRowReadResponseV1Schema,
  type ProjectAccountRowKeyV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { completeTerminalConnectForTest } from '@happier-tests/ui-terminal-enrollment';
import { readAccountIdFromToken } from '../../../../../apps/cli/src/cloud/decodeJwtPayload';
import { decodeStoredCredentials, type Settings } from '../../../../../apps/cli/src/persistence';
import { createCliActionExecutorFromCredentials } from '../../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { observeSessionSocketEvents } from '../../../../../apps/cli/src/session/transport/socket/sessionSocketAgentState';
import { consumeDeferredCliApprovalResult } from '../../../../../apps/cli/src/session/actions/approvals/deferredResult';
import { acquireRequesterAccountEncryptionCurrentness, sameRequesterAccountEncryptionCurrentness } from '../../../../../apps/cli/src/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '../../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext } from '../../../../../apps/cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { createRequesterAccountSettingsPublication } from '../../../../../apps/cli/src/settings/accountSettings/requesterAccountSettingsPublication';
import { createRequesterApprovalProfilePublication } from '../../../../../apps/cli/src/settings/profiles/hydrateProfileCatalog';
import { createInvocationSavedSecretOperationContextV1 } from '../../../../../apps/cli/src/settings/secrets/savedSecretOperationContext';
import { createSnapshotActionSettingsProvider } from '../../../../../apps/cli/src/settings/actionsSettingsProvider';
import { createTestAuth, createTestTerminalAuth } from '../auth';
import { buildTestAccountCliAuthCredentials, seedCliAuthForTestAccount } from '../cliAuth';
import { fetchJson } from '../http';
import { runCliJson } from '../uiE2e/cliJson';
import type { EnvOverrides } from '../env';
import { startHttpRequestRecordingProxy, type HttpRequestRecordingProxy, type RecordedHttpProxyRequest } from '../httpRequestRecordingProxy';
import { startServerLight, type TestDbProvider } from '../process/serverLight';
import { claimTestHomeOwner } from '../homeOwner';
import { fetchSessionMetadataV2 } from '../sessionHandoffMetadata';
import { replaceTestDaemonWithoutStoppingSessions, startTestDaemon, type StartedDaemon } from './daemon';
import { resolveCliHomeStoragePaths } from '../../../../../apps/cli/src/configuration/homeStoragePaths';
import { readStoredMachineRegistration, resolveMachineRegistrationPath, resolveRegisteredMachineId } from '@happier-dev/cli-common/firstPartyRuntime/cliMachineRegistration';
import { type CliTestLaunchSpec } from '../process/cliLaunchSpec';
import { withWorkspaceSourceRuntime } from '../process/tsxImportHook';
import type { TestAccountCliAuthCredentials } from '../cliAuth';
import { startCliAuthLoginForTerminalConnect } from '../uiE2e/cliTerminalConnect';
import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { waitFor } from '../timing';
import { createEphemeralTlsServerFixture } from '../tls/ephemeralTlsServerFixture.mjs';

type ExecuteProjectPersonAction = (actionId: ActionId, input: unknown,
  context?: Partial<ActionExecutorContext>) => Promise<ActionExecuteResult>;

/** Project journeys compose the existing authenticated daemon harness. Account
 * and terminal credentials come from their committed auth/cliAuth owners;
 * every consent is made separately by the person through the real UI client. */
export async function startProjectDaemonFixture(params: Readonly<{
  testDir: string;
  /** Use the Account's real terminal credential when pairing is outside the journey. */
  daemonAuthentication?: 'existing-terminal';
  completeTerminalConnect?: typeof completeTerminalConnectForTest;
  /** Real TLS ingress; a guest network may name its actual controller-side interface. */
  guestReachableHome?: boolean | Readonly<{ host: string }>;
  serverEnv?: EnvOverrides;
  dbProvider?: TestDbProvider;
  serverPreloadModules?: readonly string[];
  requestObservation?: Omit<Parameters<typeof startHttpRequestRecordingProxy>[0], 'targetBaseUrl'>;
  daemonEnv?: EnvOverrides;
  /** Core Action journeys can omit AppShell while retaining the signed-in Account lifecycle. */
  personActionSurface?: 'coreAction';
  /** Vitest suites can collect the real Action client with their other runtime dependencies. */
  personActionClient?: Pick<typeof import('@happier-tests/ui-action-client'),
    'connectUiPersonActionClient' | 'connectUiSignedInActionClient'>;
  observeActionRequests?: boolean;
  advertiseRequestObservationEndpoint?: boolean;
  beforeHttpRequest?: (request: RecordedHttpProxyRequest) => void | Promise<void>;
}>) {
  const sourceOptions = withWorkspaceSourceRuntime(process.env).NODE_OPTIONS;
  const serverSourceOptions = [sourceOptions, ...(params.serverPreloadModules ?? []).flatMap(module => ['--import', module])].join(' ');
  const port = await reserveAvailablePort();
  const homeTarget = `http://127.0.0.1:${port}`;
  const requestObservation = { onRequestStart: params.beforeHttpRequest, ...params.requestObservation };
  let ingress: HttpRequestRecordingProxy | undefined;
  let requestProxy: HttpRequestRecordingProxy | undefined;
  let tls: Awaited<ReturnType<typeof createEphemeralTlsServerFixture>> | undefined;
  let previousCertificates: string[] | undefined;
  if (params.guestReachableHome) {
    const host = typeof params.guestReachableHome === 'object' ? params.guestReachableHome.host
      : Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
    if (!host) throw new Error('Guest Home fixture requires a non-loopback IPv4 interface');
    tls = await createEphemeralTlsServerFixture({ additionalIpAddresses: [host] });
    try {
      ingress = await startHttpRequestRecordingProxy({ ...params.requestObservation,
        targetBaseUrl: homeTarget, listenHost: host,
        tls: { key: await readFile(tls.privateKeyPath), cert: await readFile(tls.leafCertificatePath) } });
      // The signed-in Node UI client follows the same published TLS descriptor.
      previousCertificates = getCACertificates('default');
      setDefaultCACertificates([...previousCertificates, await readFile(tls.caCertificatePath, 'utf8')]);
    } catch (error) { await tls.cleanup(); throw error; }
  }
  if (params.advertiseRequestObservationEndpoint && !ingress) {
    requestProxy = await startHttpRequestRecordingProxy({ ...requestObservation, targetBaseUrl: homeTarget });
  }
  const enrollmentEnv = tls ? { NODE_EXTRA_CA_CERTS: tls.caCertificatePath } : {};
  const serverEnv = { NODE_OPTIONS: serverSourceOptions, HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    // Real CLI enrollment retains the authenticated descriptor published for this ingress.
    HAPPIER_PUBLIC_SERVER_URL: ingress?.baseUrl ?? requestProxy?.baseUrl ?? homeTarget, ...params.serverEnv };
  // Transform the real UI approver while Home is being prepared. Enrollment
  // still waits for it before asking the CLI for an expiring pairing link.
  const terminalApprover = params.daemonAuthentication === 'existing-terminal' ? undefined
    : params.completeTerminalConnect ? Promise.resolve(params.completeTerminalConnect)
    : loadTerminalEnrollmentApprover();
  void terminalApprover?.catch(() => {}); // Enrollment reports the rejection if needed.
  // Transform the real Action receiver alongside Home setup, before a person
  // starts an Action. Loading it does not sign in or select an Account.
  const loadPersonActions = async () => params.personActionClient ?? await import('@happier-tests/ui-action-client');
  const personActions = params.personActionSurface === 'coreAction' ? loadPersonActions() : undefined;
  void personActions?.catch(() => {}); // The person client reports the rejection.
  const server = await startServerLight({ testDir: join(params.testDir, 'server'), port,
    dbProvider: params.dbProvider ?? 'postgres', extraEnv: serverEnv }).catch(async error => {
      try { await (ingress ?? requestProxy)?.stop(); } finally {
        if (previousCertificates) setDefaultCACertificates(previousCertificates);
        await tls?.cleanup();
      }
      throw error;
    });
  const daemons: StartedDaemon[] = [];
  const accountObservers: ReturnType<typeof observeSessionSocketEvents>[] = [];
  try {
    if (!requestProxy && (params.observeActionRequests || params.beforeHttpRequest || params.requestObservation)) {
      requestProxy = await startHttpRequestRecordingProxy({ ...requestObservation, targetBaseUrl: server.baseUrl });
    }
    const actionServerApiUrl = requestProxy?.baseUrl ?? server.baseUrl;
    // The observer carries bytes for this Home; the device profile keeps its canonical address.
    const personActionConnection = { serverUrl: actionServerApiUrl, addressAnchorUrl: server.baseUrl };
    const features = await fetchJson<unknown>(`${server.baseUrl}/v1/features`);
    const advertisedServerId = FeaturesResponseSchema.parse(features.data).capabilities.serverIdentity.serverIdentityId;
    if (!advertisedServerId) throw new Error('Fixture Home identity unavailable');
    const serverId = advertisedServerId;
    async function createAccount(name: string) {
      const auth = await createTestAuth(server.baseUrl);
      const terminal = await createTestTerminalAuth(server.baseUrl, auth);
      const decodedCredentials = decodeStoredCredentials(buildTestAccountCliAuthCredentials({ auth: terminal, mode: 'dataKey' }));
      if (!decodedCredentials) throw new Error('Project Account terminal credentials unavailable');
      const credentials = decodedCredentials;
      let live = true;
      const disposals: (() => void | Promise<void>)[] = [];
      const dispose = async () => {
        if (!live) return;
        live = false;
        const errors: unknown[] = [];
        for (const close of disposals.reverse()) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Project Account cleanup failed');
      };
      accountObservers.push({ dispose });
      try {
        const accountId = readAccountIdFromToken(credentials.token);
        if (!accountId) throw new Error('Project Account terminal credential omitted its Account ID');
        const observation = acquireRequesterAccountEncryptionCurrentness({ accountId,
          token: credentials.token, serverBaseUrl: actionServerApiUrl });
        disposals.push(() => observation.dispose());
        const currentness = await observation.readWitness();
        const snapshot = await runWithServerHttpBaseUrl(actionServerApiUrl, () => bootstrapAccountSettingsContext({
          credentials, mode: 'blocking', publication: 'invocation', allowCacheFallback: false,
          expectedAccountEncryptionMode: currentness.mode, minSettingsVersion: currentness.settingsVersion,
          honorAccountSettingsModeEnv: false,
        }));
        const savedSecretOperationContext = runWithServerHttpBaseUrl(actionServerApiUrl,
          () => createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
            serverHttpBaseUrl: actionServerApiUrl, isCurrent: async signal => {
              if (!live || signal?.aborted) return false;
              if (observation.isCurrent(currentness)) return true;
              const observed = await observation.read(signal);
              return live && !signal?.aborted && sameRequesterAccountEncryptionCurrentness(observed, currentness);
            } }));
        disposals.push(async () => { savedSecretOperationContext.withdrawCatalog(); await savedSecretOperationContext.isCurrent(); });
        const settingsPublication = createRequesterAccountSettingsPublication({ observation, currentness,
          operationContext: savedSecretOperationContext });
        disposals.push(() => settingsPublication.dispose());
        const approvalProfilesLifetime = new AbortController();
        const approvalProfiles = createRequesterApprovalProfilePublication({ observation,
          operationContext: savedSecretOperationContext, signal: approvalProfilesLifetime.signal });
        disposals.push(() => { approvalProfilesLifetime.abort(); approvalProfiles.dispose(); });
        const actionsSettingsProvider = createSnapshotActionSettingsProvider(() => {
          const current = savedSecretOperationContext.readSnapshot();
          if (!current) throw new Error('Project Account settings lifetime retired');
          return current;
        }, savedSecretOperationContext);
        const ensureSettingsCurrent = async (signal?: AbortSignal) => {
          if (!await settingsPublication.ensureCurrent(signal)) throw new Error('Project Account settings unavailable');
          if (!await approvalProfiles.ensureCurrent(signal)) throw new Error('Project Account approval profiles unavailable');
        };
        // The held Account publication above and this Automation observer consume
        // real pushes independently of whichever person UI is currently focused.
        await new Promise<void>((resolve, reject) => {
          const automationObserver = observeSessionSocketEvents({ token: credentials.token,
            serverUrl: actionServerApiUrl, scope: 'user' }, { onConnected: resolve, onError: reject });
          disposals.push(() => automationObserver.dispose());
        });
        const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
          serverId, serverIdentityId: serverId, serverApiUrl: actionServerApiUrl,
          actionsSettingsProvider, savedSecretOperationContext });
        const execute = async (actionId: ActionId, input: unknown, context: Partial<ActionExecutorContext> = {}) => {
          await ensureSettingsCurrent(context.signal);
          return await executor.execute(actionId, input, { surface: 'cli', authority: 'present_user',
            actionCaller: { kind: 'host' }, serverId, serverIdentityId: serverId,
            actionRequestId: randomUUID(), ...context });
        };
        /** Retain the real CLI waiter while a person answers its Inbox Ask. */
        async function executeWithApproval(actionId: ActionId, input: unknown,
          onApprovalRequested: NonNullable<Parameters<typeof createCliActionExecutorFromCredentials>[0]['onApprovalRequested']>,
          context: Partial<ActionExecutorContext> = {}) {
          await ensureSettingsCurrent(context.signal);
          const lifetime = new AbortController();
          const signal = context.signal ? AbortSignal.any([context.signal, lifetime.signal]) : lifetime.signal;
          const liveExecutor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
            serverId, serverIdentityId: serverId, serverApiUrl: actionServerApiUrl, onApprovalRequested,
            actionsSettingsProvider, savedSecretOperationContext,
          }).bindInvocation(signal, { actionId, signal, surface: 'cli' });
          try {
            return await liveExecutor.execute(actionId, input, { surface: 'cli', authority: 'present_user',
              actionCaller: { kind: 'host' }, serverId, serverIdentityId: serverId,
              actionRequestId: randomUUID(), ...context, signal });
          } finally { lifetime.abort(); }
        }
        const account = { name, auth, terminal, credentials,
          uiCredentials: buildTestAccountCliAuthCredentials({ auth, mode: 'dataKey' }),
          async readProjectOrganizationRevision(project: Omit<Extract<ProjectAccountRowKeyV1, { kind: 'project-organization' }>, 'kind'>) {
            const key = { kind: 'project-organization', ...project };
            const response = await fetchJson<unknown>(new URL(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`, actionServerApiUrl).href, {
              method: 'POST',
              headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(ProjectAccountRowReadRequestV1Schema.parse({ key })),
            });
            if (response.status !== 200) throw new Error(`Project organization read refused (${response.status})`);
            const result = ProjectAccountRowReadResponseV1Schema.parse(response.data);
            if (result.status === 'absent') return 'absent' as const;
            if (result.status !== 'present') throw new Error(`Project organization read returned ${result.status}`);
            if (result.row.key.kind !== key.kind || result.row.key.serverId !== key.serverId
              || result.row.key.projectKey !== key.projectKey) throw new Error('Project organization read returned another row');
            return result.row.revision;
          },
          async replayApprovedApprovalRequest(artifactId: string) {
            await ensureSettingsCurrent();
            return await executor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' });
          },
          readSessionMetadata(sessionId: string) {
            return fetchSessionMetadataV2({ baseUrl: server.baseUrl, token: auth.token, sessionId,
              machineKeys: [auth.accountMachineKey] });
          },
          async executeViaVoiceSpawn(input: unknown) {
            const { connectUiPersonActionClient } = await import('@happier-tests/ui-action-client');
            const ui = await connectUiPersonActionClient({ ...personActionConnection, accountSecret: auth.accountSigningSeed });
            try { return await ui.executeVoiceSpawn(input, randomUUID()); }
            finally { await ui.close(); }
          },
          execute,
          executeWithApproval,
          /** This fixture person approves the real Inbox request through the UI
           * person client, as in the app; the terminal credential is automation
           * and never a reviewer (isApprovalDecisionReviewerBindingV1). The retained
           * execution, including any child Ask, supplies the final typed result. */
          async executeReviewed(actionId: ActionId, input: unknown, context: Partial<ActionExecutorContext> = {},
            executeAsPerson?: ExecuteProjectPersonAction) {
            const approve = (artifactId: string, signal: AbortSignal) => {
              const decide = (executeAction: ExecuteProjectPersonAction) =>
                executeAction('approval.request.decide', { artifactId, decision: 'approve' }, { signal });
              return executeAsPerson ? decide(executeAsPerson)
                : account.withPersonActionClient(decide, { surface: 'coreAction' });
            };
            const result = await executeWithApproval(actionId, input, approve, context);
            return await consumeDeferredCliApprovalResult(result, {
              onApprovalRequested: approve,
              execute,
              token: credentials.token,
              serverHttpBaseUrl: actionServerApiUrl,
              context: { signal: context.signal },
            });
          },
          async withPersonActionClient<T>(run: (execute: ExecuteProjectPersonAction) => Promise<T>,
            options: Readonly<{ presentation?: Readonly<{ action: PluginContributionIdentityV1; machineId: string }>;
              surface?: 'coreAction'; confirmation?: 'presented' }> = {}): Promise<T> {
            const { connectUiPersonActionClient, connectUiSignedInActionClient } = await (personActions ?? loadPersonActions());
            const signIn = { ...personActionConnection, accountSecret: auth.accountSigningSeed };
            const { presentation } = options;
            const personUi = (options.surface ?? params.personActionSurface) === 'coreAction' && !presentation
              ? undefined
              : await connectUiPersonActionClient({ ...signIn,
                ...(presentation ? { presentedMachineAction: { action: presentation.action,
                  target: { serverIdentityId: serverId, machineId: presentation.machineId } } } : {}) });
            // Core Actions use the real restored Account connection. The
            // full AppShell case above owns mounting the app's lifecycle.
            const ui = personUi ?? await connectUiSignedInActionClient({ ...signIn, withAccountLifecycle: false });
            try {
              if (presentation && personUi) {
                await waitFor(personUi.isPresentedMachineActionReady,
                  { context: `presented Machine Action ${presentation.action.pluginId}/${presentation.action.localId}` });
              }
              const execute = options.confirmation === 'presented' ? ui.executePresented : ui.executeConfirmed;
              return await run((actionId, input, context = {}) => execute(actionId, input, {
                ...context, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: ui.serverId, serverIdentityId: serverId,
                actionRequestId: context.actionRequestId ?? randomUUID(),
              }));
            } finally { await ui.close(); }
          },
          executeAsPerson(actionId: ActionId, input: unknown, context: Partial<ActionExecutorContext> = {},
            presentation?: Readonly<{ action: PluginContributionIdentityV1; machineId: string }>) {
            return account.withPersonActionClient(executeAction => executeAction(actionId, input, context), { presentation });
          },
        };
        return account;
      } catch (error) {
        try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Project Account setup and cleanup failed'); }
        throw error;
      }
    }
    return { server, serverId, sourceOptions, actionServerApiUrl, personActionConnection, requestProxy, createAccount,
      // Public fixture CA only; native guests install it through ordinary OS trust.
      guestHomeCaCertificatePath: tls?.caCertificatePath,
      takeRequestObservations() {
        if (!requestProxy) throw new Error('Project Action request observation was not enabled');
        const observations = requestProxy.entries().map(({ method, path, statusCode }) => ({ method, path, statusCode }));
        requestProxy.clear();
        return observations;
      },
      async assertKnownGoodSessionControl(account: Awaited<ReturnType<typeof createAccount>>,
      machine: Readonly<{ target: Readonly<{ serverId: string; machineId: string }>; workspaceDir: string }>,
      agentTarget?: AgentExecutionTargetV1) {
      const updatedAtMs = Date.now();
      const result = await account.execute('session.spawn_new', {
        executionTarget: machine.target,
        directory: { kind: 'path', path: machine.workspaceDir },
        agentTarget: agentTarget ?? { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        permissionMode: 'read-only', approvalProfileId: null,
        configuration: { mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'explicit' },
          permissionIntent: { value: 'read-only', updatedAtMs }, options: {} },
        connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
      });
      if (!result.ok) {
        throw new Error(`Project fixture Session creation refused (${result.errorCode}); error=${JSON.stringify(result.error)}`);
      }
      const created = SessionSpawnNewActionResultV1Schema.parse(result.result);
      if (created.type !== 'success') {
        const failedRequests = requestProxy?.entries().filter(request => request.statusCode !== null && request.statusCode >= 400)
          .map(({ method, path, statusCode }) => ({ method, path: new URL(path, server.baseUrl).pathname, statusCode }));
        throw new Error(`F baseline Session did not settle (${JSON.stringify(created)}); failedHttp=${JSON.stringify(failedRequests ?? [])}`);
      }
      const metadata = await account.readSessionMetadata(created.sessionId);
      if (metadata.machineId !== machine.target.machineId) throw new Error('F baseline Session Machine metadata mismatch');
      return { sessionId: created.sessionId, metadata };
    },
      createSessionFromArgv(machine: Readonly<{ homeDir: string; workspaceDir: string }>, args: string[], label: string) {
        return runCliJson({ testDir: params.testDir, cliHomeDir: machine.homeDir,
          serverUrl: actionServerApiUrl, webappUrl: server.baseUrl, label, acceptedExitCodes: [1],
          env: { ...process.env, NODE_OPTIONS: sourceOptions },
          launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true },
          args: ['session', 'create', '--path', machine.workspaceDir, '--terminal-json', '{"mode":"plain"}', '--json', ...args],
        });
      },
      async enrollDaemon(account: Awaited<ReturnType<typeof createAccount>>, options: Readonly<{
        env?: EnvOverrides;
        /** Keep a journey's checkout independent of its retained log directory's SCM ancestry. */
        workspaceDir?: string;
        cliLaunchSpec?: Parameters<typeof startTestDaemon>[0]['cliLaunchSpec'];
        beforeDaemonSpawn?: (homeDir: string) => Promise<void>;
        preserveRuntimeOnRestart?: boolean;
        pairedHome?: Readonly<{ homeDir: string; serverId: string; machineId: string }>;
      }> = {}) {
        const accountDir = join(params.testDir, account.name);
        await mkdir(accountDir, { recursive: true });
        const directory = await mkdtemp(join(accountDir, 'machine-'));
        const homeDir = options.pairedHome?.homeDir ?? join(directory, 'home');
        const workspaceDir = options.workspaceDir ?? join(directory, 'workspace');
        const claudeConfigDir = join(homeDir, '.claude');
        await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(claudeConfigDir, { recursive: true })]);
        const enrollment = await (async () => {
          if (options.pairedHome) return readEnrolledProjectDaemonHome({ homeDir, serverId, accountToken: account.auth.token });
          if (params.daemonAuthentication === 'existing-terminal') {
            return seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: actionServerApiUrl,
              auth: account.terminal, mode: 'dataKey', expectedHomeServerIdentityId: serverId });
          }
          return enrollProjectDaemonHome({ homeDir, testDir: directory,
            serverUrl: actionServerApiUrl, serverId, sourceOptions, account, cliLaunchSpec: options.cliLaunchSpec, env: enrollmentEnv,
            completeTerminalConnect: await terminalApprover });
        })();
        const env = {
          ...process.env, ...enrollmentEnv, CI: '1', HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: actionServerApiUrl,
          HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', NODE_OPTIONS: sourceOptions,
          HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1', ...params.daemonEnv, ...options.env,
        };
        const daemonOptions = { testDir: directory, happyHomeDir: homeDir, env, requireMachineControlReady: true,
          ...(options.cliLaunchSpec ? { cliLaunchSpec: options.cliLaunchSpec } : {}),
          ...(options.preserveRuntimeOnRestart ? { cleanupDescendantsOnExit: false } : {}),
        };
        const beforeDaemonSpawn = options.beforeDaemonSpawn;
        const launch = () => startTestDaemon({ ...daemonOptions,
          ...(beforeDaemonSpawn ? { __beforeSpawn: () => beforeDaemonSpawn(homeDir) } : {}) });
        let daemon = await launch();
        const daemonIndex = daemons.push(daemon) - 1;
        return { get daemon() { return daemon; }, homeDir, workspaceDir, cliServerId: enrollment.serverId, target: { serverId, machineId: enrollment.machineId },
          async restart() {
            if (options.preserveRuntimeOnRestart) {
              daemon = await replaceTestDaemonWithoutStoppingSessions({ ...daemonOptions, originalDaemon: daemon });
            } else {
              await daemon.stop();
              daemon = await launch();
            }
            daemons[daemonIndex] = daemon;
          },
        };
      },
      claimHomeOwner(account: Awaited<ReturnType<typeof createAccount>>) {
        const accountId = readAccountIdFromToken(account.credentials.token);
        if (!accountId) throw new Error('Home owner fixture token omitted its Account ID');
        return claimTestHomeOwner({ server, accountId,
          dbProvider: params.dbProvider ?? 'postgres', env: serverEnv });
      },
      stop,
    };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Project daemon fixture startup and cleanup failed'); }
    throw error;
  }

  async function stop() {
    const errors: unknown[] = [];
    for (const close of [...accountObservers].reverse().map(observer => () => observer.dispose())
      .concat([...daemons].reverse().map(daemon => () => daemon.stop()))
      .concat(async () => { await requestProxy?.stop(); }, () => server.stop(),
        async () => { await ingress?.stop(); }, async () => {
          if (previousCertificates) setDefaultCACertificates(previousCertificates);
          await tls?.cleanup();
        })) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Project daemon fixture cleanup failed');
  }
}

export type ProjectDaemonFixture = Awaited<ReturnType<typeof startProjectDaemonFixture>>;

async function loadTerminalEnrollmentApprover(): Promise<typeof completeTerminalConnectForTest> {
  return (await import('@happier-tests/ui-terminal-enrollment')).completeTerminalConnectForTest;
}

/** Await real CLI login and its Machine registration before exposing a target. */
export async function enrollProjectDaemonHome(params: Readonly<{
  completeTerminalConnect?: typeof completeTerminalConnectForTest;
  serverUrl: string;
  serverId: string;
  sourceOptions: string;
  account: Readonly<{ uiCredentials: TestAccountCliAuthCredentials; auth: Readonly<{ token: string }> }>;
  testDir: string;
  homeDir: string;
  cliLaunchSpec?: CliTestLaunchSpec;
  env?: EnvOverrides;
}>) {
  const { account, cliLaunchSpec, homeDir } = params;
  // Load the real UI approver before issuing the expiring pairing request.
  const completeTerminalConnect = params.completeTerminalConnect ?? await loadTerminalEnrollmentApprover();
  const login = await startCliAuthLoginForTerminalConnect({ testDir: join(params.testDir, 'login'),
    cliHomeDir: homeDir, serverUrl: params.serverUrl, webappUrl: params.serverUrl,
    cliLaunchSpec, waitForConnectUrlReady: false, env: { ...process.env, ...params.env, NODE_OPTIONS: params.sourceOptions,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' } });
  try {
    await completeTerminalConnect({ connectUrl: login.connectUrl,
      canonicalServerUrl: params.serverUrl, homeServerIdentityId: params.serverId,
      credentials: account.uiCredentials, waitForSuccess: () => login.waitForSuccess() });
  } finally { await login.stop(); }
  return readEnrolledProjectDaemonHome({ homeDir, serverId: params.serverId, accountToken: account.auth.token });
}

async function readEnrolledProjectDaemonHome(params: Readonly<{
  homeDir: string;
  serverId: string;
  accountToken: string;
}>) {
  const { homeDir } = params;
  // This is the settings file just committed by the canonical CLI login owner.
  const settings = JSON.parse(await readFile(join(homeDir, 'settings.json'), 'utf8')) as Settings;
  if (!settings || typeof settings !== 'object' || !('activeServerId' in settings)
    || typeof settings.activeServerId !== 'string') {
    throw new Error('Production terminal login did not persist Machine registration');
  }
  const profile = settings.servers?.[settings.activeServerId];
  const descriptor = HomeConnectionDescriptorV1Schema.safeParse(profile?.homeConnectionDescriptor);
  if (profile?.homeConnectionDescriptorAuthority !== 'exact' || !descriptor.success
    || descriptor.data.homeServerIdentityId !== params.serverId) {
    throw new Error(`Production terminal login did not persist its authenticated Home descriptor in active profile ${settings.activeServerId}`);
  }
  const { serversDir } = resolveCliHomeStoragePaths(homeDir);
  const registration = await readStoredMachineRegistration(resolveMachineRegistrationPath(serversDir, settings.activeServerId));
  const machineId = registration && resolveRegisteredMachineId(registration, readAccountIdFromToken(params.accountToken));
  if (!machineId) throw new Error('Production terminal login omitted its Account Machine identity');
  return { homeDir, serverId: settings.activeServerId, machineId };
}
