import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { completeTerminalConnectForTest } from '@happier-tests/ui-terminal-enrollment';
import { readAccountIdFromToken } from '../../../../../apps/cli/src/cloud/decodeJwtPayload';
import { decodeStoredCredentials, type Settings } from '../../../../../apps/cli/src/persistence';
import { createCliActionExecutorFromCredentials } from '../../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { observeSessionSocketEvents } from '../../../../../apps/cli/src/session/transport/socket/sessionSocketAgentState';
import { consumeDeferredCliApprovalResult } from '../../../../../apps/cli/src/session/actions/approvals/deferredResult';
import { acquireRequesterAccountEncryptionCurrentness, sameRequesterAccountEncryptionCurrentness } from '../../../../../apps/cli/src/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '../../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext } from '../../../../../apps/cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { createRequesterAccountSettingsPublication } from '../../../../../apps/cli/src/settings/accountSettings/requesterAccountSettingsPublication';
import { createInvocationSavedSecretOperationContextV1 } from '../../../../../apps/cli/src/settings/secrets/savedSecretOperationContext';
import { createSnapshotActionSettingsProvider } from '../../../../../apps/cli/src/settings/actionsSettingsProvider';
import { createTestAuth, createTestTerminalAuth } from '../auth';
import { buildTestAccountCliAuthCredentials } from '../cliAuth';
import { fetchJson } from '../http';
import type { EnvOverrides } from '../env';
import { startHttpRequestRecordingProxy, type HttpRequestRecordingProxy, type RecordedHttpProxyRequest } from '../httpRequestRecordingProxy';
import { startServerLight, type TestDbProvider } from '../process/serverLight';
import { claimTestHomeOwner } from '../homeOwner';
import { fetchSessionMetadataV2 } from '../sessionHandoffMetadata';
import { startTestDaemon, type StartedDaemon } from './daemon';
import { resolveMachineIdForServerFromSettings } from '../../../../../apps/cli/src/daemon/resolveMachineIdForServerFromSettings';
import { type CliTestLaunchSpec } from '../process/cliLaunchSpec';
import { withWorkspaceSourceRuntime } from '../process/tsxImportHook';
import type { TestAccountCliAuthCredentials } from '../cliAuth';
import { startCliAuthLoginForTerminalConnect } from '../uiE2e/cliTerminalConnect';
import { waitFor } from '../timing';
import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { createEphemeralTlsServerFixture } from '../tls/ephemeralTlsServerFixture.mjs';

/** Project journeys compose the existing authenticated daemon harness. Account
 * and terminal credentials come from their committed auth/cliAuth owners;
 * every consent is made separately by the person through the real UI client. */
export async function startProjectDaemonFixture(params: Readonly<{
  testDir: string;
  /** Real TLS ingress; a guest network may name its actual controller-side interface. */
  guestReachableHome?: boolean | Readonly<{ host: string }>;
  serverEnv?: EnvOverrides;
  dbProvider?: TestDbProvider;
  serverPreloadModules?: readonly string[];
  requestObservation?: Omit<Parameters<typeof startHttpRequestRecordingProxy>[0], 'targetBaseUrl'>;
  daemonEnv?: EnvOverrides;
  observeActionRequests?: boolean;
  beforeHttpRequest?: (request: RecordedHttpProxyRequest) => void | Promise<void>;
}>) {
  const sourceOptions = withWorkspaceSourceRuntime(process.env).NODE_OPTIONS;
  const serverSourceOptions = [sourceOptions, ...(params.serverPreloadModules ?? []).flatMap(module => ['--import', module])].join(' ');
  const port = await reserveAvailablePort();
  let ingress: HttpRequestRecordingProxy | undefined;
  let tls: Awaited<ReturnType<typeof createEphemeralTlsServerFixture>> | undefined;
  let previousCertificates: string[] | undefined;
  if (params.guestReachableHome) {
    const host = typeof params.guestReachableHome === 'object' ? params.guestReachableHome.host
      : Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
    if (!host) throw new Error('Guest Home fixture requires a non-loopback IPv4 interface');
    tls = await createEphemeralTlsServerFixture({ additionalIpAddresses: [host] });
    try {
      ingress = await startHttpRequestRecordingProxy({ ...params.requestObservation,
        targetBaseUrl: `http://127.0.0.1:${port}`, listenHost: host,
        tls: { key: await readFile(tls.privateKeyPath), cert: await readFile(tls.leafCertificatePath) } });
      // The signed-in Node UI client follows the same published TLS descriptor.
      previousCertificates = getCACertificates('default');
      setDefaultCACertificates([...previousCertificates, await readFile(tls.caCertificatePath, 'utf8')]);
    } catch (error) { await tls.cleanup(); throw error; }
  }
  const enrollmentEnv = tls ? { NODE_EXTRA_CA_CERTS: tls.caCertificatePath } : {};
  const serverEnv = { NODE_OPTIONS: serverSourceOptions, HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    // Real CLI enrollment retains the authenticated descriptor published for this ingress.
    HAPPIER_PUBLIC_SERVER_URL: ingress?.baseUrl ?? `http://127.0.0.1:${port}`, ...params.serverEnv };
  const server = await startServerLight({ testDir: join(params.testDir, 'server'), port,
    dbProvider: params.dbProvider ?? 'postgres', extraEnv: serverEnv }).catch(async error => {
      try { await ingress?.stop(); } finally {
        if (previousCertificates) setDefaultCACertificates(previousCertificates);
        await tls?.cleanup();
      }
      throw error;
    });
  const daemons: StartedDaemon[] = [];
  const accountObservers: ReturnType<typeof observeSessionSocketEvents>[] = [];
  let requestProxy: HttpRequestRecordingProxy | undefined;
  try {
    if (params.observeActionRequests || params.beforeHttpRequest || params.requestObservation) {
      requestProxy = await startHttpRequestRecordingProxy({ targetBaseUrl: server.baseUrl,
        onRequestStart: params.beforeHttpRequest, ...params.requestObservation });
    }
    const actionServerApiUrl = requestProxy?.baseUrl ?? server.baseUrl;
    const features = await fetchJson<unknown>(`${server.baseUrl}/v1/features`);
    const advertisedServerId = FeaturesResponseSchema.parse(features.data).capabilities.serverIdentity.serverIdentityId;
    if (!advertisedServerId) throw new Error('Fixture Home identity unavailable');
    const serverId = advertisedServerId;
    async function createAccount(name: string) {
      const auth = await createTestAuth(server.baseUrl);
      const terminal = await createTestTerminalAuth(server.baseUrl, auth);
      const credentials = decodeStoredCredentials(buildTestAccountCliAuthCredentials({ auth: terminal, mode: 'dataKey' }));
      if (!credentials) throw new Error('Project Account terminal credentials unavailable');
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
        const actionsSettingsProvider = createSnapshotActionSettingsProvider(() => {
          const current = savedSecretOperationContext.readSnapshot();
          if (!current) throw new Error('Project Account settings lifetime retired');
          return current;
        }, savedSecretOperationContext);
        const ensureSettingsCurrent = async (signal?: AbortSignal) => {
          if (!await settingsPublication.ensureCurrent(signal)) throw new Error('Project Account settings unavailable');
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
        const account = { name, auth, credentials,
          uiCredentials: buildTestAccountCliAuthCredentials({ auth, mode: 'dataKey' }),
          async replayApprovedApprovalRequest(artifactId: string) {
            await ensureSettingsCurrent();
            return await executor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' });
          },
          readSessionMetadata(sessionId: string) {
            return fetchSessionMetadataV2({ baseUrl: server.baseUrl, token: auth.token, sessionId,
              machineKeys: [auth.accountMachineKey] });
          },
          async executeViaVoiceSpawn(input: unknown) {
            const ui = await connectUiPersonActionClient({ serverUrl: actionServerApiUrl,
              addressAnchorUrl: server.baseUrl, accountSecret: auth.accountSigningSeed });
            try { return await ui.executeVoiceSpawn(input, randomUUID()); }
            finally { await ui.close(); }
          },
          execute,
          executeWithApproval,
          /** This fixture person approves the real Inbox request through the UI
           * person client, as in the app; the terminal credential is automation
           * and never a reviewer (isApprovalDecisionReviewerBindingV1). The retained
           * execution, including any child Ask, supplies the final typed result. */
          async executeReviewed(actionId: ActionId, input: unknown, context: Partial<ActionExecutorContext> = {}) {
            const approve = async (artifactId: string, signal: AbortSignal) =>
              await account.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' }, { signal });
            const result = await executeWithApproval(actionId, input, approve, context);
            return await consumeDeferredCliApprovalResult(result, {
              onApprovalRequested: approve,
              execute,
              token: credentials.token,
              serverHttpBaseUrl: actionServerApiUrl,
              context: { signal: context.signal },
            });
          },
          async executeAsPerson(actionId: ActionId, input: unknown, context: Partial<ActionExecutorContext> = {},
            presentation?: Readonly<{ action: PluginContributionIdentityV1; machineId: string }>) {
            const ui = await connectUiPersonActionClient({ serverUrl: actionServerApiUrl,
              addressAnchorUrl: server.baseUrl, accountSecret: auth.accountSigningSeed,
              ...(presentation ? { presentedMachineAction: { action: presentation.action,
                  target: { serverIdentityId: serverId, machineId: presentation.machineId } } } : {}) });
            try {
              if (presentation) {
                await waitFor(ui.isPresentedMachineActionReady,
                  { context: `presented Machine Action ${presentation.action.pluginId}/${presentation.action.localId}` });
              }
              return await ui.executeConfirmed(actionId, input, { ...context, surface: 'ui', authority: 'present_user',
                actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: serverId,
                actionRequestId: context.actionRequestId ?? randomUUID() });
            } finally { await ui.close(); }
          },
        };
        return account;
      } catch (error) {
        try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Project Account setup and cleanup failed'); }
        throw error;
      }
    }
    return { server, serverId, sourceOptions, actionServerApiUrl, requestProxy, createAccount,
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
      async enrollDaemon(account: Awaited<ReturnType<typeof createAccount>>, options: Readonly<{
        env?: EnvOverrides;
        /** Keep a journey's checkout independent of its retained log directory's SCM ancestry. */
        workspaceDir?: string;
        cliLaunchSpec?: Parameters<typeof startTestDaemon>[0]['cliLaunchSpec'];
        pairedHome?: Readonly<{ homeDir: string; serverId: string; machineId: string }>;
      }> = {}) {
        const directory = join(params.testDir, account.name);
        const homeDir = options.pairedHome?.homeDir ?? join(directory, 'home');
        const workspaceDir = options.workspaceDir ?? join(directory, 'workspace');
        const claudeConfigDir = join(homeDir, '.claude');
        await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(claudeConfigDir, { recursive: true })]);
        const enrollment = options.pairedHome
          ? await readEnrolledProjectDaemonHome({ homeDir, serverId, accountToken: account.auth.token })
          : await enrollProjectDaemonHome({ homeDir, testDir: directory,
            serverUrl: actionServerApiUrl, serverId, sourceOptions, account, cliLaunchSpec: options.cliLaunchSpec, env: enrollmentEnv });
        const launch = () => startTestDaemon({ testDir: directory, happyHomeDir: homeDir, requireMachineControlReady: true,
          ...(options.cliLaunchSpec ? { cliLaunchSpec: options.cliLaunchSpec } : {}), env: {
          ...process.env, ...enrollmentEnv, CI: '1', HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: actionServerApiUrl,
          HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', NODE_OPTIONS: sourceOptions,
          HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1', ...params.daemonEnv, ...options.env,
        } });
        let daemon = await launch();
        const daemonIndex = daemons.push(daemon) - 1;
        return { get daemon() { return daemon; }, homeDir, workspaceDir, cliServerId: enrollment.serverId, target: { serverId, machineId: enrollment.machineId },
          async restart() {
            await daemon.stop();
            daemon = await launch();
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

/** Await real CLI login and its Machine registration before exposing a target. */
export async function enrollProjectDaemonHome(params: Readonly<{
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
  const login = await startCliAuthLoginForTerminalConnect({ testDir: join(params.testDir, 'login'),
    cliHomeDir: homeDir, serverUrl: params.serverUrl, webappUrl: params.serverUrl,
    cliLaunchSpec, waitForConnectUrlReady: false, env: { ...process.env, ...params.env, NODE_OPTIONS: params.sourceOptions,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' } });
  try {
    await completeTerminalConnectForTest({ connectUrl: login.connectUrl,
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
  const machineId = resolveMachineIdForServerFromSettings(settings, settings.activeServerId,
    readAccountIdFromToken(params.accountToken));
  if (!machineId) throw new Error('Production terminal login omitted its Account Machine identity');
  return { homeDir, serverId: settings.activeServerId, machineId };
}
