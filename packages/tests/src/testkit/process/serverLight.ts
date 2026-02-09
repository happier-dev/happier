import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';

import { repoRootDir } from '../paths';
import { runLoggedCommand, spawnLoggedProcess, type SpawnedProcess } from './spawnProcess';
import { waitForOkHealth } from '../http';
import { yarnCommand } from './commands';

function pickPortCandidate(): number {
  // Avoid privileged / common ports.
  return randomInt(20_000, 60_000);
}

export async function isPortAvailableForListen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = createServer();

    probe.once('error', () => {
      try {
        probe.close();
      } catch {
        // ignore
      }
      resolve(false);
    });

    probe.listen(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

export function isAddrInUseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const row = error as { code?: unknown; message?: unknown };
  if (row.code === 'EADDRINUSE') return true;
  if (typeof row.message === 'string' && row.message.includes('EADDRINUSE')) return true;
  return false;
}

export function shouldRetryServerStart(params: {
  attempt: number;
  maxAttempts: number;
  preflightPortAvailable: boolean;
  error: unknown;
}): boolean {
  if (params.attempt >= params.maxAttempts) return false;
  if (!params.preflightPortAvailable) return true;
  return isAddrInUseError(params.error);
}

export type StartedServer = {
  baseUrl: string;
  port: number;
  dataDir: string;
  proc: SpawnedProcess;
  stop: () => Promise<void>;
};

export type TestDbProvider = 'pglite' | 'sqlite' | 'postgres' | 'mysql';

export function resolveTestDbProvider(env: NodeJS.ProcessEnv): TestDbProvider {
  const raw = (env.HAPPIER_E2E_DB_PROVIDER ?? env.HAPPY_E2E_DB_PROVIDER ?? '').toString().trim().toLowerCase();
  if (raw === 'sqlite') return 'sqlite';
  if (raw === 'postgres' || raw === 'postgresql') return 'postgres';
  if (raw === 'mysql') return 'mysql';
  return 'pglite';
}

export function resolveStartCommandArgs(provider: TestDbProvider): string[] {
  const script = provider === 'postgres' || provider === 'mysql' ? 'start' : 'start:light';
  return ['-s', 'workspace', '@happier-dev/server', script];
}

export function resolveMigrateCommandArgs(provider: TestDbProvider): string[] {
  if (provider === 'sqlite') {
    return ['-s', 'workspace', '@happier-dev/server', 'migrate:sqlite:deploy'];
  }
  if (provider === 'pglite') {
    return ['-s', 'workspace', '@happier-dev/server', 'migrate:light:deploy'];
  }
  if (provider === 'mysql') {
    return ['-s', 'workspace', '@happier-dev/server', 'migrate:mysql:deploy'];
  }
  return ['-s', 'workspace', '@happier-dev/server', 'prisma', 'migrate', 'deploy'];
}

export function shouldSkipServerGenerateProviders(env: NodeJS.ProcessEnv): boolean {
  const raw = (
    env.HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE ??
    env.HAPPY_E2E_PROVIDER_SKIP_SERVER_GENERATE ??
    ''
  )
    .toString()
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

export async function startServerLight(params: {
  testDir: string;
  extraEnv?: NodeJS.ProcessEnv;
  dbProvider?: TestDbProvider;
  /**
   * Test-only hook: override port selection to force EADDRINUSE scenarios.
   * Not part of the public API; used to validate retry behavior deterministically.
   */
  __portAllocator?: () => Promise<number>;
}): Promise<StartedServer> {
  const dataDir = resolve(params.testDir, 'server-light-data');
  mkdirSync(dataDir, { recursive: true });

  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...params.extraEnv,
  };

  const dbProvider = params.dbProvider ?? resolveTestDbProvider(mergedEnv);

  const baseEnv: NodeJS.ProcessEnv = {
    ...mergedEnv,
    CI: '1',
    // Avoid global port conflicts during test runs.
    METRICS_ENABLED: 'false',
    // Core E2E suite expects public file storage to work without extra services (Minio/S3).
    HAPPIER_FILES_BACKEND: 'local',
    HAPPY_SERVER_LIGHT_DATA_DIR: dataDir,
    HAPPY_SERVER_LIGHT_DB_DIR: join(dataDir, 'pglite'),
    HAPPY_SERVER_LIGHT_FILES_DIR: join(dataDir, 'files'),
    HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
    HAPPIER_SERVER_LIGHT_DB_DIR: join(dataDir, 'pglite'),
    HAPPIER_SERVER_LIGHT_FILES_DIR: join(dataDir, 'files'),
    HAPPIER_DB_PROVIDER: dbProvider,
    HAPPY_DB_PROVIDER: dbProvider,
    // Some sandboxed environments disallow binding to 0.0.0.0; prefer loopback for E2E.
    HAPPIER_SERVER_HOST: '127.0.0.1',
    HAPPY_SERVER_HOST: '127.0.0.1',
  };

  const sqliteUrl = `file:${join(dataDir, 'happier-server-light.sqlite')}`;
  const databaseUrlForExternalProvider = mergedEnv.DATABASE_URL?.toString().trim();
  if ((dbProvider === 'postgres' || dbProvider === 'mysql') && !databaseUrlForExternalProvider) {
    throw new Error(`Missing DATABASE_URL for HAPPIER_E2E_DB_PROVIDER or HAPPY_E2E_DB_PROVIDER=${dbProvider}`);
  }

  // Ensure Prisma client is generated for the current schema.
  // In multi-worktree setups it's easy for @prisma/client to become stale and then
  // light-mode boot will fail at runtime (PrismaClientValidationError).
  if (!shouldSkipServerGenerateProviders(baseEnv)) {
    await runLoggedCommand({
      command: yarnCommand(),
      args: ['-s', 'workspace', '@happier-dev/server', 'generate:providers'],
      cwd: repoRootDir(),
      env: {
        ...baseEnv,
        PORT: '0',
        PUBLIC_URL: 'http://127.0.0.1:0',
        // Prisma schema requires DATABASE_URL for `prisma generate`.
        // `generate:providers` sets per-provider placeholders, but we still pass one here for consistency.
        DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable',
        HAPPIER_BUILD_DB_PROVIDERS: dbProvider,
      },
      stdoutPath: resolve(params.testDir, 'server.generate.stdout.log'),
      stderrPath: resolve(params.testDir, 'server.generate.stderr.log'),
      timeoutMs: 180_000,
    });
  }

  // Ensure the light database schema exists before the server boots.
  // Server light uses pglite + Prisma but does not auto-migrate on startup.
  const migrateArgs = resolveMigrateCommandArgs(dbProvider);
  await runLoggedCommand({
    command: yarnCommand(),
    args: migrateArgs,
    cwd: repoRootDir(),
    env: {
      ...baseEnv,
      PORT: '0',
      PUBLIC_URL: 'http://127.0.0.1:0',
      ...(dbProvider === 'sqlite'
        ? { DATABASE_URL: sqliteUrl }
        : dbProvider === 'postgres' || dbProvider === 'mysql'
          ? { DATABASE_URL: databaseUrlForExternalProvider }
          : {}),
    },
    stdoutPath: resolve(params.testDir, 'server.migrate.stdout.log'),
    stderrPath: resolve(params.testDir, 'server.migrate.stderr.log'),
    timeoutMs: 180_000,
  });

  const portAllocator = params.__portAllocator ?? (async () => pickPortCandidate());
  const maxAttempts = 5;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await portAllocator();
    const preflightPortAvailable = await isPortAvailableForListen(port);
    if (!preflightPortAvailable) {
      if (attempt < maxAttempts) {
        continue;
      }
      throw new Error(`server-light could not allocate an available port after ${maxAttempts} attempts (lastPort=${port})`);
    }

    const baseUrl = `http://127.0.0.1:${port}`;

    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(port),
      PUBLIC_URL: baseUrl,
      ...(dbProvider === 'sqlite'
        ? { DATABASE_URL: sqliteUrl }
        : dbProvider === 'postgres' || dbProvider === 'mysql'
          ? { DATABASE_URL: databaseUrlForExternalProvider }
          : {}),
    };

    const proc = spawnLoggedProcess({
      command: yarnCommand(),
      args: resolveStartCommandArgs(dbProvider),
      cwd: repoRootDir(),
      env,
      stdoutPath: resolve(params.testDir, 'server.stdout.log'),
      stderrPath: resolve(params.testDir, 'server.stderr.log'),
    });

    let stderrTail = '';
    let stdoutTail = '';
    const maxTail = 8_000;
    const onStderr = (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-maxTail);
    };
    const onStdout = (chunk: Buffer) => {
      stdoutTail = (stdoutTail + chunk.toString('utf8')).slice(-maxTail);
    };
    proc.child.stderr?.on('data', onStderr);
    proc.child.stdout?.on('data', onStdout);

    const removeTailListeners = () => {
      proc.child.stderr?.off('data', onStderr);
      proc.child.stdout?.off('data', onStdout);
    };

    let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
    const exitedEarly = new Promise<never>((_, reject) => {
      exitHandler = (code, signal) => {
        const detail = signal ? `signal=${signal}` : `code=${code ?? 'null'}`;
        reject(new Error(`server-light exited before /health was ready (${detail})`));
      };
      proc.child.once('exit', exitHandler);
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
        const code = proc.child.exitCode;
        const signal = proc.child.signalCode as NodeJS.Signals | null;
        proc.child.off('exit', exitHandler);
        exitHandler(code, signal);
      }
    });

    try {
      await Promise.race([waitForOkHealth(baseUrl, { timeoutMs: 90_000 }), exitedEarly]);

      removeTailListeners();
      if (exitHandler) proc.child.off('exit', exitHandler);

      return {
        baseUrl,
        port,
        dataDir,
        proc,
        stop: async () => {
          await proc.stop();
        },
      };
    } catch (e) {
      lastError = e;
      removeTailListeners();
      if (exitHandler) proc.child.off('exit', exitHandler);
      await proc.stop().catch(() => {});

      if (
        shouldRetryServerStart({
          attempt,
          maxAttempts,
          preflightPortAvailable,
          error: e,
        })
      ) {
        continue;
      }

      const combinedTail = `${stderrTail}\n${stdoutTail}`.trim();
      if (combinedTail.length > 0 && e instanceof Error) {
        e.message = `${e.message} | serverTail=${combinedTail}`;
      }

      throw e;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to start server-light');
}
