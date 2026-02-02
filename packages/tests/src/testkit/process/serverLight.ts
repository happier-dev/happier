import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

import { repoRootDir } from '../paths';
import { runLoggedCommand, spawnLoggedProcess, type SpawnedProcess } from './spawnProcess';
import { waitForOkHealth } from '../http';

function yarnCommand(): string {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        srv.close();
        reject(new Error('Failed to allocate free port'));
        return;
      }
      const port = address.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolvePort(port);
      });
    });
  });
}

export type StartedServer = {
  baseUrl: string;
  port: number;
  dataDir: string;
  proc: SpawnedProcess;
  stop: () => Promise<void>;
};

export async function startServerLight(params: {
  testDir: string;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<StartedServer> {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const dataDir = resolve(params.testDir, 'server-light-data');
  mkdirSync(dataDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...params.extraEnv,
    CI: '1',
    // Avoid global port conflicts during test runs.
    METRICS_ENABLED: 'false',
    // Prisma schema requires DATABASE_URL for `prisma generate` even in light mode.
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable',
    PORT: String(port),
    PUBLIC_URL: baseUrl,
    HAPPY_SERVER_LIGHT_DATA_DIR: dataDir,
    HAPPY_SERVER_LIGHT_DB_DIR: join(dataDir, 'pglite'),
    HAPPY_SERVER_LIGHT_FILES_DIR: join(dataDir, 'files'),
    HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
    HAPPIER_SERVER_LIGHT_DB_DIR: join(dataDir, 'pglite'),
    HAPPIER_SERVER_LIGHT_FILES_DIR: join(dataDir, 'files'),
  };

  // Ensure Prisma client is generated for the current schema.
  // In multi-worktree setups it's easy for @prisma/client to become stale and then
  // light-mode boot will fail at runtime (PrismaClientValidationError).
  await runLoggedCommand({
    command: yarnCommand(),
    args: ['-s', 'workspace', '@happier-dev/server', 'generate'],
    cwd: repoRootDir(),
    env,
    stdoutPath: resolve(params.testDir, 'server.generate.stdout.log'),
    stderrPath: resolve(params.testDir, 'server.generate.stderr.log'),
    timeoutMs: 180_000,
  });

  // Ensure the light database schema exists before the server boots.
  // Server light uses pglite + Prisma but does not auto-migrate on startup.
  await runLoggedCommand({
    command: yarnCommand(),
    args: ['-s', 'workspace', '@happier-dev/server', 'migrate:light:deploy'],
    cwd: repoRootDir(),
    env,
    stdoutPath: resolve(params.testDir, 'server.migrate.stdout.log'),
    stderrPath: resolve(params.testDir, 'server.migrate.stderr.log'),
    timeoutMs: 180_000,
  });

  const proc = spawnLoggedProcess({
    command: yarnCommand(),
    args: ['-s', 'workspace', '@happier-dev/server', 'start:light'],
    cwd: repoRootDir(),
    env,
    stdoutPath: resolve(params.testDir, 'server.stdout.log'),
    stderrPath: resolve(params.testDir, 'server.stderr.log'),
  });

  try {
    await waitForOkHealth(baseUrl, { timeoutMs: 90_000 });
  } catch (e) {
    await proc.stop();
    throw e;
  }

  return {
    baseUrl,
    port,
    dataDir,
    proc,
    stop: async () => {
      await proc.stop();
    },
  };
}
