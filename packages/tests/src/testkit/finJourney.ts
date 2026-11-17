import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import tweetnacl from 'tweetnacl';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1, HomeOwnerClaimCommandOutputV1Schema } from '@happier-dev/protocol/home/governance/claim';
import { createCliActionExecutorFromCredentials } from '../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { createTestAuth, createTestTerminalAuth } from './auth';
import { buildTestAccountCliAuthCredentials, seedCliAuthForTestAccount } from './cliAuth';
import { startTestDaemon, type StartedDaemon } from './daemon/daemon';
import { fakeClaudeFixturePath } from './fakeClaude';
import { fetchJson } from './http';
import { reserveAvailablePort } from './network/reserveAvailablePort';
import { repoRootDir } from './paths';
import { startServerLight, resolveServerStartLaunchSpec, renderServerLightSqliteDatabaseUrl } from './process/serverLight';
import { runLoggedCommand } from './process/spawnProcess';

/** FIN composition of committed server/auth/daemon fixtures, with its own SQLite DB.
 * Provider executables are the only substituted boundary. Account B is a real
 * second Account; no shared QA data or foreign in-flight fixture is consumed. */
export async function startFinJourneyFixture(params: Readonly<{ testDir: string; serverEnv?: NodeJS.ProcessEnv }>) {
  const port = await reserveAvailablePort();
  const sourceOptions = [process.env.NODE_OPTIONS, '--import', pathToFileURL(resolve(repoRootDir(),
    'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
  // Native requester custody resolves this Home through its published descriptor.
  const serverEnv = { ...process.env, NODE_OPTIONS: sourceOptions, HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1', ...params.serverEnv,
    HAPPIER_PUBLIC_SERVER_URL: `http://127.0.0.1:${port}` };
  const server = await startServerLight({ testDir: params.testDir, dbProvider: 'sqlite', port, extraEnv: serverEnv });
  const daemons: StartedDaemon[] = [];
  try {
    const features = await fetchJson<unknown>(`${server.baseUrl}/v1/features`);
    const discoveredServerId = FeaturesResponseSchema.parse(features.data).capabilities.serverIdentity.serverIdentityId;
    if (!discoveredServerId) throw new Error('FIN Home did not publish its identity');
    const serverId = discoveredServerId;
    async function createAccount(name: string) {
      const auth = await createTestAuth(server.baseUrl);
      const terminal = await createTestTerminalAuth(server.baseUrl, auth);
      const credentials = { token: terminal.token, encryption: { type: 'dataKey' as const,
        machineKey: auth.accountMachineKey, publicKey: tweetnacl.box.keyPair.fromSecretKey(auth.accountMachineKey).publicKey },
        credentialProvenance: 'stored_session' as const };
      const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
        serverId, serverIdentityId: serverId, serverApiUrl: server.baseUrl });
      return { name, auth, credentials, uiCredentials: buildTestAccountCliAuthCredentials({ auth, mode: 'dataKey' }),
        execute(actionId: ActionId, input: unknown, context: Partial<ActionExecutorContext> = {}) {
          return executor.execute(actionId, input, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId, serverIdentityId: serverId, actionRequestId: randomUUID(), ...context });
        },
      };
    }
    async function enrollDaemon(account: Awaited<ReturnType<typeof createAccount>>, options: Readonly<{
      env?: NodeJS.ProcessEnv;
      prepareHome?: (homeDir: string) => Promise<void>;
    }> = {}) {
      const directory = join(params.testDir, account.name);
      const homeDir = join(directory, 'home');
      const workspaceDir = join(directory, 'workspace');
      const claudeConfigDir = join(homeDir, '.claude');
      await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(claudeConfigDir, { recursive: true })]);
      await options.prepareHome?.(homeDir);
      const seeded = await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth: account.auth, mode: 'dataKey' });
      const daemon = await startTestDaemon({ testDir: directory, happyHomeDir: homeDir,
        requireMachineControlReady: true, env: {
        ...process.env, CI: '1', HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl, HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(), HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        NODE_OPTIONS: sourceOptions, ...options.env,
      } });
      daemons.push(daemon);
      return { daemon, homeDir, workspaceDir, cliServerId: seeded.serverId,
        target: { serverId, machineId: seeded.machineId } };
    }
    async function claimHomeOwner(account: Awaited<ReturnType<typeof createAccount>>) {
      const launch = resolveServerStartLaunchSpec({ provider: 'sqlite', env: { ...process.env, ...serverEnv } });
      const stdoutPath = join(server.dataDir, 'fin-claim.stdout.log');
      await runLoggedCommand({ ...launch, args: [...launch.args,
        `${HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1}=${readAccountIdFromToken(account.auth.token)}`],
        env: { ...process.env, ...serverEnv, ...launch.env, HAPPIER_DB_PROVIDER: 'sqlite', HAPPY_DB_PROVIDER: 'sqlite',
          HAPPIER_SERVER_LIGHT_DATA_DIR: server.dataDir, HAPPY_SERVER_LIGHT_DATA_DIR: server.dataDir,
          DATABASE_URL: renderServerLightSqliteDatabaseUrl({ dbPath: join(server.dataDir, 'happier-server-light.sqlite') }) },
        stdoutPath, stderrPath: join(server.dataDir, 'fin-claim.stderr.log'), timeoutMs: null });
      const output = (await readFile(stdoutPath, 'utf8')).split(/\r?\n/).some(line => {
        try { return HomeOwnerClaimCommandOutputV1Schema.safeParse(JSON.parse(line)).success; } catch { return false; }
      });
      if (!output) throw new Error('FIN Home owner claim did not return its structured result');
    }
    return { server, serverId, sourceOptions, actionServerApiUrl: server.baseUrl,
      createAccount, enrollDaemon, claimHomeOwner,
      async stop() { try { await Promise.all(daemons.map(daemon => daemon.stop())); } finally { await server.stop(); } },
    };
  } catch (error) { await server.stop(); throw error; }
}
export type FinJourneyFixture = Awaited<ReturnType<typeof startFinJourneyFixture>>;
