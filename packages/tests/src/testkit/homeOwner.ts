import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HomeOwnerClaimCommandOutputV1Schema, HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1,
  type HomeOwnerClaimCommandOutputV1 } from '@happier-dev/protocol/home/governance/claim';
import { renderServerLightSqliteDatabaseUrl, resolveServerLightDatabaseUrlEnv, resolveServerStartLaunchSpec,
  type StartedServer, type TestDbProvider } from './process/serverLight';
import { runLoggedCommand } from './process/spawnProcess';
import type { EnvOverrides } from './env';

/** Operator claim against this fixture's disposable Home, through its real server command. */
export async function claimTestHomeOwner(input: Readonly<{
  server: StartedServer;
  accountId: string;
  dbProvider: TestDbProvider;
  env: EnvOverrides;
}>): Promise<HomeOwnerClaimCommandOutputV1> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...input.env,
    HAPPIER_DB_PROVIDER: input.dbProvider, HAPPY_DB_PROVIDER: input.dbProvider,
    HAPPIER_SERVER_LIGHT_DATA_DIR: input.server.dataDir, HAPPY_SERVER_LIGHT_DATA_DIR: input.server.dataDir,
    HAPPIER_SERVER_LIGHT_DB_DIR: join(input.server.dataDir, 'pglite'),
    HAPPY_SERVER_LIGHT_DB_DIR: join(input.server.dataDir, 'pglite'),
    PUBLIC_URL: input.server.baseUrl, HAPPIER_CANONICAL_SERVER_URL: input.server.baseUrl,
    ...resolveServerLightDatabaseUrlEnv({ dbProvider: input.dbProvider,
      generatedSqliteUrl: renderServerLightSqliteDatabaseUrl({ dbPath: join(input.server.dataDir, 'happier-server-light.sqlite') }),
      explicitDatabaseUrl: input.server.databaseUrl ?? (input.dbProvider === 'sqlite' ? input.env.DATABASE_URL
        : input.env.DATABASE_URL ?? process.env.DATABASE_URL) }),
  };
  const launch = resolveServerStartLaunchSpec({ provider: input.dbProvider, env });
  const stdoutPath = join(input.server.dataDir, 'claim-owner.stdout.log');
  let commandError: unknown;
  try {
    await runLoggedCommand({ command: launch.command,
      args: [...launch.args, `${HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1}=${input.accountId}`], cwd: launch.cwd,
      env: { ...env, ...launch.env }, stdoutPath,
      stderrPath: join(input.server.dataDir, 'claim-owner.stderr.log'), timeoutMs: null });
  } catch (error) { commandError = error; }
  const lines = (await readFile(stdoutPath, 'utf8')).split(/\r?\n/);
  for (const line of lines.reverse()) {
    try {
      const parsed = HomeOwnerClaimCommandOutputV1Schema.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data;
    } catch { /* Server diagnostics are interleaved with the structured command result. */ }
  }
  if (commandError) throw commandError;
  throw new Error(`Home owner claim returned no structured result (${stdoutPath})`);
}
