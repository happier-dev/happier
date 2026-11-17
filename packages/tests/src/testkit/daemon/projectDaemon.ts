import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { HomeOwnerClaimCommandOutputV1Schema, HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1 } from '@happier-dev/protocol/home/governance/claim';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { readAccountIdFromToken } from '../../../../../apps/cli/src/cloud/decodeJwtPayload';
import { decodeStoredCredentials, type Settings } from '../../../../../apps/cli/src/persistence';
import { createCliActionExecutorFromCredentials } from '../../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createTestAuth, createTestTerminalAuth } from '../auth';
import { buildTestAccountCliAuthCredentials } from '../cliAuth';
import { fetchJson } from '../http';
import { startHttpRequestRecordingProxy, type HttpRequestRecordingProxy, type RecordedHttpProxyRequest } from '../httpRequestRecordingProxy';
import { repoRootDir } from '../paths';
import { startServerLight, renderServerLightSqliteDatabaseUrl, resolveServerLightDatabaseUrlEnv,
  resolveServerStartLaunchSpec, type TestDbProvider } from '../process/serverLight';
import { runLoggedCommand } from '../process/spawnProcess';
import { fetchSessionMetadataV2 } from '../sessionHandoffMetadata';
import { startTestDaemon, type StartedDaemon } from './daemon';
import { approveTerminalPairing } from '../../../../../apps/ui/sources/auth/terminal/approveTerminalPairing';
import { buildEstablishedHomeTransportDescriptor, resolveHomeEnrollmentTransport } from '../../../../../apps/ui/sources/auth/enrollment/homeEnrollmentTransport';
import { decodeBase64 } from '../../../../../apps/ui/sources/encryption/base64';
import { parseTerminalConnectUrl } from '../../../../../apps/ui/sources/utils/path/terminalConnectUrl';
import { resolveMachineIdForServerFromSettings } from '../../../../../apps/cli/src/daemon/resolveMachineIdForServerFromSettings';
import type { CliTestLaunchSpec } from '../process/cliLaunchSpec';
import type { TestAccountCliAuthCredentials } from '../cliAuth';
import { startCliAuthLoginForTerminalConnect } from '../uiE2e/cliTerminalConnect';
import { reserveAvailablePort } from '../network/reserveAvailablePort';

/** Project journeys compose the existing authenticated daemon harness. Account
 * and terminal credentials come from their committed auth/cliAuth owners;
 * every consent is made separately by the person through the real UI client. */
export async function startProjectDaemonFixture(params: Readonly<{
  testDir: string;
  serverEnv?: NodeJS.ProcessEnv;
  dbProvider?: TestDbProvider;
  serverPreloadModules?: readonly string[];
  requestObservation?: Omit<Parameters<typeof startHttpRequestRecordingProxy>[0], 'targetBaseUrl'>;
  daemonEnv?: NodeJS.ProcessEnv;
  observeActionRequests?: boolean;
  beforeHttpRequest?: (request: RecordedHttpProxyRequest) => void | Promise<void>;
}>) {
  const sourceOptions = [process.env.NODE_OPTIONS, '--import',
    pathToFileURL(resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  const serverSourceOptions = [sourceOptions, ...(params.serverPreloadModules ?? []).flatMap(module => ['--import', module])].join(' ');
  const port = await reserveAvailablePort();
  const serverEnv = { NODE_OPTIONS: serverSourceOptions, HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    // Real CLI enrollment retains the authenticated descriptor published for this ingress.
    HAPPIER_PUBLIC_SERVER_URL: `http://127.0.0.1:${port}`, ...params.serverEnv };
  const server = await startServerLight({ testDir: join(params.testDir, 'server'), port,
    dbProvider: params.dbProvider ?? 'postgres', extraEnv: serverEnv });
  const daemons: StartedDaemon[] = [];
  let requestProxy: HttpRequestRecordingProxy | undefined;
  try {
    if (params.observeActionRequests || params.beforeHttpRequest || params.requestObservation) {
      requestProxy = await startHttpRequestRecordingProxy({ targetBaseUrl: server.baseUrl,
        onRequestStart: params.beforeHttpRequest, ...params.requestObservation });
    }
    const actionServerApiUrl = requestProxy?.baseUrl ?? server.baseUrl;
    const features = await fetchJson<unknown>(`${server.baseUrl}/v1/features`);
    const serverId = FeaturesResponseSchema.parse(features.data).capabilities.serverIdentity.serverIdentityId;
    if (!serverId) throw new Error('Fixture Home identity unavailable');
    async function createAccount(name: string) {
      const auth = await createTestAuth(server.baseUrl);
      const terminal = await createTestTerminalAuth(server.baseUrl, auth);
      const credentials = decodeStoredCredentials(buildTestAccountCliAuthCredentials({ auth: terminal, mode: 'dataKey' }));
      if (!credentials) throw new Error('Project Account terminal credentials unavailable');
      const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
        serverId, serverIdentityId: serverId, serverApiUrl: actionServerApiUrl });
      return { name, auth, credentials,
        uiCredentials: buildTestAccountCliAuthCredentials({ auth, mode: 'dataKey' }),
        replayApprovedApprovalRequest(artifactId: string) {
          return executor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' });
        },
        readSessionMetadata(sessionId: string) {
          return fetchSessionMetadataV2({ baseUrl: server.baseUrl, token: auth.token, sessionId,
            machineKeys: [auth.accountMachineKey] });
        },
        async executeViaVoiceSpawn(input: unknown) {
          const ui = await connectUiPersonActionClient({ serverUrl: actionServerApiUrl, accountSecret: auth.accountSigningSeed });
          try { return await ui.executeVoiceSpawn(input, randomUUID()); }
          finally { await ui.close(); }
        },
        execute(actionId: ActionId, input: unknown, context: Partial<ActionExecutorContext> = {}) {
          return executor.execute(actionId, input, { surface: 'cli', authority: 'present_user',
            actionCaller: { kind: 'host' }, serverId, serverIdentityId: serverId,
            actionRequestId: randomUUID(), ...context });
        },
        async executeAsPerson(actionId: ActionId, input: unknown, context: Partial<ActionExecutorContext> = {}) {
          const ui = await connectUiPersonActionClient({ serverUrl: actionServerApiUrl, accountSecret: auth.accountSigningSeed });
          try {
            return await ui.executeConfirmed(actionId, input, { ...context, surface: 'ui', authority: 'present_user',
              actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: serverId,
              actionRequestId: randomUUID() });
          } finally { await ui.close(); }
        },
      };
    }
    return { server, serverId, sourceOptions, actionServerApiUrl, requestProxy, createAccount,
      takeRequestObservations() {
        if (!requestProxy) throw new Error('Project Action request observation was not enabled');
        const observations = requestProxy.entries().map(({ method, path, statusCode }) => ({ method, path, statusCode }));
        requestProxy.clear();
        return observations;
      },
      async assertKnownGoodSessionControl(account: Awaited<ReturnType<typeof createAccount>>,
      machine: Readonly<{ target: Readonly<{ serverId: string; machineId: string }>; workspaceDir: string }>) {
      const updatedAtMs = Date.now();
      const result = await account.execute('session.spawn_new', {
        executionTarget: machine.target,
        directory: { kind: 'path', path: machine.workspaceDir },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        permissionMode: 'read-only', approvalProfileId: null,
        configuration: { mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'explicit' },
          permissionIntent: { value: 'read-only', updatedAtMs }, options: {} },
        connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
      });
      if (!result.ok) {
        const targetRefusal = result.errorCode === 'machine_target_not_current'
          ? /RPC target refused: ([a-z_]+(?:[/][a-z_]+)?)/u.exec(result.error)?.[1] : undefined;
        throw new Error(`F baseline Session creation refused (${result.errorCode}${targetRefusal ? `/${targetRefusal}` : ''}); error=${JSON.stringify(result.error)}`);
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
        env?: NodeJS.ProcessEnv;
        cliLaunchSpec?: Parameters<typeof startTestDaemon>[0]['cliLaunchSpec'];
        pairedHome?: Readonly<{ homeDir: string; serverId: string; machineId: string }>;
      }> = {}) {
        const directory = join(params.testDir, account.name);
        const homeDir = options.pairedHome?.homeDir ?? join(directory, 'home');
        const workspaceDir = join(directory, 'workspace');
        const claudeConfigDir = join(homeDir, '.claude');
        await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(claudeConfigDir, { recursive: true })]);
        const enrollment = options.pairedHome
          ? await readEnrolledProjectDaemonHome({ homeDir, serverId, accountToken: account.auth.token })
          : await enrollProjectDaemonHome({ homeDir, testDir: directory,
            serverUrl: actionServerApiUrl, serverId, sourceOptions, account, cliLaunchSpec: options.cliLaunchSpec });
        const launch = () => startTestDaemon({ testDir: directory, happyHomeDir: homeDir, requireMachineControlReady: true,
          ...(options.cliLaunchSpec ? { cliLaunchSpec: options.cliLaunchSpec } : {}), env: {
          ...process.env, CI: '1', HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: actionServerApiUrl,
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
      async claimHomeOwner(account: Awaited<ReturnType<typeof createAccount>>) {
        const dbProvider = params.dbProvider ?? 'postgres';
        const env: NodeJS.ProcessEnv = { ...process.env, ...serverEnv,
          HAPPIER_DB_PROVIDER: dbProvider, HAPPY_DB_PROVIDER: dbProvider,
          HAPPIER_SERVER_LIGHT_DATA_DIR: server.dataDir, HAPPY_SERVER_LIGHT_DATA_DIR: server.dataDir,
          HAPPIER_SERVER_LIGHT_DB_DIR: join(server.dataDir, 'pglite'),
          HAPPY_SERVER_LIGHT_DB_DIR: join(server.dataDir, 'pglite'),
          PUBLIC_URL: server.baseUrl, HAPPIER_CANONICAL_SERVER_URL: server.baseUrl,
          ...resolveServerLightDatabaseUrlEnv({ dbProvider,
            generatedSqliteUrl: renderServerLightSqliteDatabaseUrl({ dbPath: join(server.dataDir, 'happier-server-light.sqlite') }),
            explicitDatabaseUrl: dbProvider === 'sqlite' ? serverEnv.DATABASE_URL
              : serverEnv.DATABASE_URL ?? process.env.DATABASE_URL }),
        };
        const launch = resolveServerStartLaunchSpec({ provider: dbProvider, env });
        const stdoutPath = join(server.dataDir, 'claim-owner.stdout.log');
        await runLoggedCommand({ command: launch.command,
          args: [...launch.args, `${HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1}=${readAccountIdFromToken(account.credentials.token)}`],
          cwd: launch.cwd, env: { ...env, ...launch.env }, stdoutPath,
          stderrPath: join(server.dataDir, 'claim-owner.stderr.log'), timeoutMs: null });
        for (const line of (await readFile(stdoutPath, 'utf8')).split(/\r?\n/).reverse()) {
          try {
            const parsed = HomeOwnerClaimCommandOutputV1Schema.safeParse(JSON.parse(line));
            if (parsed.success) return parsed.data;
          } catch { /* The server command interleaves diagnostics with its structured result. */ }
        }
        throw new Error(`Home owner claim returned no structured result (${stdoutPath})`);
      },
      stop,
    };
  } catch (error) {
    try { await stop(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Project daemon fixture startup and cleanup failed'); }
    throw error;
  }

  async function stop() {
    const errors: unknown[] = [];
    for (const close of [...daemons].reverse().map(daemon => () => daemon.stop())
      .concat(async () => { await requestProxy?.stop(); }, () => server.stop())) {
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
}>) {
  const { account, cliLaunchSpec, homeDir } = params;
  const login = await startCliAuthLoginForTerminalConnect({ testDir: join(params.testDir, 'login'),
    cliHomeDir: homeDir, serverUrl: params.serverUrl, webappUrl: params.serverUrl,
    cliLaunchSpec, waitForConnectUrlReady: false, env: { ...process.env, NODE_OPTIONS: params.sourceOptions,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' } });
  try {
    const link = parseTerminalConnectUrl(login.connectUrl);
    if (!link?.pairing) throw new Error('Production CLI did not publish a current terminal pairing link');
    const descriptor = link.homeConnectionDescriptor ?? buildEstablishedHomeTransportDescriptor({
      canonicalServerUrl: params.serverUrl, homeServerIdentityId: params.serverId });
    if (!descriptor) throw new Error('Established fixture Home transport unavailable');
    const resolution = await resolveHomeEnrollmentTransport(descriptor);
    if (!resolution.ok) throw new Error(`Fixture Home pairing unavailable: ${resolution.reason}`);
    try {
      const result = await approveTerminalPairing({ target: resolution.transport, targetCredentials: account.uiCredentials,
        requesterPublicKey: decodeBase64(link.publicKeyB64Url, 'base64url'),
        pairingContext: { secret: decodeBase64(link.pairing.secretB64Url, 'base64url'),
          createdAtMs: link.pairing.createdAtMs, expiresAtMs: link.pairing.expiresAtMs },
        supportsTokenOnly: link.supportsTokenOnly === true });
      if (result !== 'approved') throw new Error(`Production terminal approval did not complete: ${result}`);
      await login.waitForSuccess();
    } finally { await resolution.transport.close(); }
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
