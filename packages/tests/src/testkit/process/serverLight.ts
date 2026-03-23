import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import { repoRootDir } from '../paths';
import { runLoggedCommand, spawnLoggedProcess, type SpawnedProcess } from './spawnProcess';
import { terminateProcessTreeByPid } from './processTree';
import { waitForOkHealth } from '../http';
import { yarnCommand } from './commands';
import { resolveServerAppWorkspaceName } from './serverWorkspaceName';
import { createServerLightTemplateCacheKey, prepareCachedDataDir } from './serverLightTemplateCache';
import { resolveTsxImportHookPath } from './tsxImportHook';
import {
  inspectOwnedProcess,
  registerProcessOwnershipLease,
  resolveProcessOwnershipLeasesDir,
  sweepProcessOwnershipLeases,
  type ProcessInspectionResult,
  type ProcessOwnershipLease,
} from './processOwnershipLease';

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

function isHealthTimeoutDuringAuthInit(params: { error: unknown; stdoutTail: string }): boolean {
  const message = params.error instanceof Error ? params.error.message : String(params.error ?? '');
  if (!message.includes('Timed out waiting for /health')) {
    return false;
  }
  const stdoutTail = params.stdoutTail;
  return stdoutTail.includes('Initializing auth module...') && !stdoutTail.includes('Auth module initialized');
}

function composeServerStartTail(stderrTail: string, stdoutTail: string): string {
  return `${stderrTail}\n${stdoutTail}`.trim();
}

function looksLikeServerLightCommand(command: string): boolean {
  const normalized = command.replaceAll('\\', '/');
  return normalized.includes('start:light')
    && ((normalized.includes('apps/server') && (normalized.includes('dist/index') || normalized.includes('sources/main.light.ts')))
      || (normalized.includes('happier') && normalized.includes('dist/index')));
}

export type ServerLightOwnershipLease = ProcessOwnershipLease<Readonly<{
  port: number;
  baseUrl: string;
  dataDir: string;
}>>;

export function resolveServerLightOwnershipLeasesDir(rootDir: string = repoRootDir()): string {
  return resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'server-light' });
}

export async function sweepServerLightOwnershipLeases(params: {
  rootDir?: string;
  currentOwnerPid: number;
  currentOwnerStartTime: string | null;
  inspectProcess?: (pid: number) => ProcessInspectionResult;
  terminateProcessTreeByPid?: typeof terminateProcessTreeByPid;
}): Promise<void> {
  await sweepProcessOwnershipLeases({
    rootDir: params.rootDir,
    leaseKind: 'server-light',
    currentOwnerPid: params.currentOwnerPid,
    currentOwnerStartTime: params.currentOwnerStartTime,
    inspectProcess: params.inspectProcess,
    terminateProcessTreeByPid: params.terminateProcessTreeByPid,
    isOwnedProcessCommand: (command) => looksLikeServerLightCommand(command),
  });
}

async function readUtf8Tail(filePath: string, maxChars: number): Promise<string> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.length > maxChars ? raw.slice(-maxChars) : raw;
  } catch {
    return '';
  }
}

function shouldRetryPgliteWasmTrap(params: { attempt: number; maxAttempts: number; stderrTail: string }): boolean {
  if (params.attempt >= params.maxAttempts) return false;
  const idx = params.stderrTail.lastIndexOf('RuntimeError: unreachable');
  if (idx < 0) return false;
  // Ensure the trap shows up near the end of stderr (avoid retrying on stale earlier attempts).
  return idx > Math.max(0, params.stderrTail.length - 2_000);
}

function attachServerStartTailToError(params: {
  error: unknown;
  stderrTail: string;
  stdoutTail: string;
}): unknown {
  const tail = composeServerStartTail(params.stderrTail, params.stdoutTail);
  if (!tail) {
    return params.error;
  }

  if (params.error instanceof Error) {
    if (params.error.message.includes('| serverTail=')) {
      return params.error;
    }
    const next = new Error(`${params.error.message} | serverTail=${tail}`);
    next.stack = params.error.stack;
    return next;
  }

  const baseMessage = typeof params.error === 'string' ? params.error : 'Failed to start server-light';
  return new Error(`${baseMessage} | serverTail=${tail}`);
}

export function shouldRetryServerStartFromFailureContext(params: {
  attempt: number;
  maxAttempts: number;
  preflightPortAvailable: boolean;
  error: unknown;
  stderrTail: string;
  stdoutTail: string;
}): boolean {
  const contextualError = attachServerStartTailToError({
    error: params.error,
    stderrTail: params.stderrTail,
    stdoutTail: params.stdoutTail,
  });
  if (
    params.attempt < params.maxAttempts
    && isHealthTimeoutDuringAuthInit({ error: contextualError, stdoutTail: params.stdoutTail })
  ) {
    return true;
  }
  return shouldRetryServerStart({
    attempt: params.attempt,
    maxAttempts: params.maxAttempts,
    preflightPortAvailable: params.preflightPortAvailable,
    error: contextualError,
  });
}

export type StartedServer = {
  baseUrl: string;
  port: number;
  dataDir: string;
  proc: SpawnedProcess;
  stop: () => Promise<void>;
};

export type TestDbProvider = 'pglite' | 'sqlite' | 'postgres' | 'mysql';
export type ServerStartLaunchSpec = Readonly<{
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}>;

type BuildLockOwner = {
  pid: number | null;
  createdAtMs: number | null;
};

let sharedDepsReady = false;
let sharedDepsBuildPromise: Promise<void> | null = null;
let sharedGeneratedProvidersReady = false;
let sharedGenerateProvidersPromise: Promise<void> | null = null;

export function resolveTestDbProvider(env: NodeJS.ProcessEnv): TestDbProvider {
  const raw = (env.HAPPIER_E2E_DB_PROVIDER ?? env.HAPPY_E2E_DB_PROVIDER ?? '').toString().trim().toLowerCase();
  if (raw === 'sqlite') return 'sqlite';
  if (raw === 'postgres' || raw === 'postgresql') return 'postgres';
  if (raw === 'mysql') return 'mysql';
  return 'pglite';
}

export function resolveStartCommandArgs(provider: TestDbProvider): string[] {
  const script = provider === 'postgres' || provider === 'mysql' ? 'start' : 'start:light';
  return ['-s', 'workspace', resolveServerAppWorkspaceName(), script];
}

function resolveServerWorkspaceDir(rootDir: string): string {
  return resolve(rootDir, 'apps', 'server');
}

function resolveServerTsconfigPath(rootDir: string): string {
  return resolve(resolveServerWorkspaceDir(rootDir), 'tsconfig.json');
}

function resolveServerSharedDepsOutputPaths(rootDir: string): string[] {
  return [
    resolve(rootDir, 'packages', 'agents', 'dist', 'index.js'),
    resolve(rootDir, 'packages', 'protocol', 'dist', 'index.js'),
  ];
}

export function hasServerSharedDepsOutputs(rootDir: string): boolean {
  return resolveServerSharedDepsOutputPaths(rootDir).every((outputPath) => existsSync(outputPath));
}

function parseBuildLockOwner(raw: string): BuildLockOwner {
  const text = raw.trim();
  if (!text) return { pid: null, createdAtMs: null };

  try {
    const parsed = JSON.parse(text) as { pid?: unknown; createdAtMs?: unknown };
    return {
      pid: typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
      createdAtMs:
        typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs) && parsed.createdAtMs > 0
          ? parsed.createdAtMs
          : null,
    };
  } catch {
    return { pid: null, createdAtMs: null };
  }
}

function isRunningPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

export async function withServerSharedDepsBuildLock<T>(
  fn: () => Promise<T>,
  options?: {
    lockPath?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    staleAfterMs?: number;
  },
): Promise<T> {
  const lockPath = options?.lockPath ?? resolve(repoRootDir(), '.project', 'tmp', 'server-shared-deps-build.lock');
  mkdirSync(dirname(lockPath), { recursive: true });

  const timeoutMs = options?.timeoutMs ?? 240_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 250;
  const staleAfterMs = options?.staleAfterMs ?? timeoutMs;
  const startedAt = Date.now();

  let fd: number | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), 'utf8');
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;

      let reclaim = false;
      try {
        const owner = parseBuildLockOwner(readFileSync(lockPath, 'utf8'));
        if (owner.pid == null && owner.createdAtMs == null) reclaim = true;
        else if (owner.pid != null && !isRunningPid(owner.pid)) reclaim = true;
        else if (owner.createdAtMs != null && Date.now() - owner.createdAtMs > staleAfterMs) reclaim = true;
      } catch {
        reclaim = true;
      }

      if (reclaim) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // ignore and continue waiting
        }
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for server shared deps build lock: ${lockPath}`);
      }
      await sleep(pollIntervalMs);
    }
  }

  try {
    if (staleAfterMs > 0) {
      const heartbeatIntervalMs = Math.max(250, Math.min(5_000, Math.floor(staleAfterMs / 4) || 250));
      heartbeatTimer = setInterval(() => {
        try {
          writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), 'utf8');
        } catch {
          // Best-effort lease heartbeat only.
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();
    }

    return await fn();
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    try {
      if (fd != null) closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

function resolveServerGenerateProvidersSourcePaths(rootDir: string): Readonly<{
  postgresSchema: string;
  sqliteSchema: string;
  mysqlSchema: string;
}> {
  const serverDir = resolveServerWorkspaceDir(rootDir);
  return {
    postgresSchema: resolve(serverDir, 'prisma', 'schema.prisma'),
    sqliteSchema: resolve(serverDir, 'prisma', 'sqlite', 'schema.prisma'),
    mysqlSchema: resolve(serverDir, 'prisma', 'mysql', 'schema.prisma'),
  };
}

function resolveServerGenerateProvidersOutputPaths(rootDir: string): Readonly<{
  postgresDefault: string;
  postgresSchema: string;
  sqliteIndex: string;
  sqliteSchema: string;
  mysqlIndex: string;
  mysqlSchema: string;
}> {
  const serverDir = resolveServerWorkspaceDir(rootDir);
  return {
    postgresDefault: resolve(rootDir, 'node_modules', '.prisma', 'client', 'default.js'),
    postgresSchema: resolve(rootDir, 'node_modules', '.prisma', 'client', 'schema.prisma'),
    sqliteIndex: resolve(serverDir, 'generated', 'sqlite-client', 'index.js'),
    sqliteSchema: resolve(serverDir, 'generated', 'sqlite-client', 'schema.prisma'),
    mysqlIndex: resolve(serverDir, 'generated', 'mysql-client', 'index.js'),
    mysqlSchema: resolve(serverDir, 'generated', 'mysql-client', 'schema.prisma'),
  };
}

function readFileIfExists(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function normalizeGeneratedSchemaForFreshnessCheck(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .join('\n')
    .trim();
}

export function hasServerGeneratedProviderOutputs(rootDir: string, provider: TestDbProvider): boolean {
  const sourcePaths = resolveServerGenerateProvidersSourcePaths(rootDir);
  const outputPaths = resolveServerGenerateProvidersOutputPaths(rootDir);
  if (
    !existsSync(outputPaths.postgresDefault)
  ) {
    return false;
  }
  if ((provider === 'sqlite' || provider === 'pglite') && !existsSync(outputPaths.sqliteIndex)) {
    return false;
  }
  if (provider === 'mysql' && !existsSync(outputPaths.mysqlIndex)) {
    return false;
  }

  const postgresSource = readFileIfExists(sourcePaths.postgresSchema);
  const postgresGenerated = readFileIfExists(outputPaths.postgresSchema);
  if (!postgresSource || !postgresGenerated) {
    return false;
  }
  const sqliteRequired = provider === 'sqlite' || provider === 'pglite';
  const mysqlRequired = provider === 'mysql';
  const sqliteSource = sqliteRequired ? readFileIfExists(sourcePaths.sqliteSchema) : null;
  const mysqlSource = mysqlRequired ? readFileIfExists(sourcePaths.mysqlSchema) : null;
  const sqliteGenerated = sqliteRequired ? readFileIfExists(outputPaths.sqliteSchema) : null;
  const mysqlGenerated = mysqlRequired ? readFileIfExists(outputPaths.mysqlSchema) : null;
  if (sqliteRequired && (!sqliteSource || !sqliteGenerated)) {
    return false;
  }
  if (mysqlRequired && (!mysqlSource || !mysqlGenerated)) {
    return false;
  }

  return normalizeGeneratedSchemaForFreshnessCheck(postgresSource) === normalizeGeneratedSchemaForFreshnessCheck(postgresGenerated)
    && (!sqliteRequired || normalizeGeneratedSchemaForFreshnessCheck(sqliteSource!) === normalizeGeneratedSchemaForFreshnessCheck(sqliteGenerated!))
    && (!mysqlRequired || normalizeGeneratedSchemaForFreshnessCheck(mysqlSource!) === normalizeGeneratedSchemaForFreshnessCheck(mysqlGenerated!));
}

function resolveServerSourceEntrypoint(params: { rootDir: string; provider: TestDbProvider }): string {
  const fileName = params.provider === 'postgres' || params.provider === 'mysql' ? 'main.ts' : 'main.light.ts';
  return resolve(resolveServerWorkspaceDir(params.rootDir), 'sources', fileName);
}

export function shouldUseServerSourceEntrypoint(env: NodeJS.ProcessEnv): boolean {
  const raw = (
    env.HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT ??
    env.HAPPY_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT ??
    ''
  )
    .toString()
    .trim()
    .toLowerCase();

  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

export function resolveServerStartLaunchSpec(params: {
  provider: TestDbProvider;
  env: NodeJS.ProcessEnv;
  rootDir?: string;
}): ServerStartLaunchSpec {
  const rootDir = params.rootDir ?? repoRootDir();

  if (shouldUseServerSourceEntrypoint(params.env)) {
    const sourceEntrypoint = resolveServerSourceEntrypoint({ rootDir, provider: params.provider });
    if (!existsSync(sourceEntrypoint)) {
      throw new Error(`Server source entrypoint missing for test launch: ${sourceEntrypoint}`);
    }

    const tsxHookPath = resolveTsxImportHookPath();
    if (!tsxHookPath) {
      throw new Error('tsx import hook is required for server source entrypoint mode but could not be resolved');
    }

    return {
      command: process.execPath,
      args: ['--import', tsxHookPath, sourceEntrypoint],
      cwd: resolveServerWorkspaceDir(rootDir),
      env: {
        TSX_TSCONFIG_PATH: resolveServerTsconfigPath(rootDir),
      },
    };
  }

  return {
    command: yarnCommand(),
    args: resolveStartCommandArgs(params.provider),
    cwd: rootDir,
  };
}

export function resolveSharedDepsBuildArgs(): string[] {
  return ['-s', 'workspace', resolveServerAppWorkspaceName(), 'build:shared'];
}

export function shouldSkipServerSharedDepsBuild(env: NodeJS.ProcessEnv): boolean {
  const raw = (
    env.HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD ??
    env.HAPPY_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD ??
    ''
  )
    .toString()
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

export function resolveMigrateCommandArgs(provider: TestDbProvider): string[] {
  if (provider === 'sqlite') {
    return ['-s', 'workspace', resolveServerAppWorkspaceName(), 'migrate:sqlite:deploy'];
  }
  if (provider === 'pglite') {
    return ['-s', 'workspace', resolveServerAppWorkspaceName(), 'migrate:light:deploy'];
  }
  if (provider === 'mysql') {
    return ['-s', 'workspace', resolveServerAppWorkspaceName(), 'migrate:mysql:deploy'];
  }
  return ['-s', 'workspace', resolveServerAppWorkspaceName(), 'prisma', 'migrate', 'deploy'];
}

function supportsServerLightTemplateCache(provider: TestDbProvider): provider is 'sqlite' | 'pglite' {
  return provider === 'sqlite' || provider === 'pglite';
}

function resolveServerLightTemplateCacheRoot(rootDir: string): string {
  return resolve(rootDir, '.project', 'cache', 'e2e', 'server-light');
}

async function runServerMigrationCommand(params: {
  provider: TestDbProvider;
  env: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
}): Promise<void> {
  const migrateArgs = resolveMigrateCommandArgs(params.provider);
  const migrateMaxAttempts = params.provider === 'pglite' ? 3 : 1;

  for (let attempt = 1; attempt <= migrateMaxAttempts; attempt++) {
    try {
      await runLoggedCommand({
        command: yarnCommand(),
        args: migrateArgs,
        cwd: repoRootDir(),
        env: params.env,
        stdoutPath: params.stdoutPath,
        stderrPath: params.stderrPath,
        timeoutMs: params.timeoutMs,
      });
      return;
    } catch (error) {
      const stderrTail = await readUtf8Tail(params.stderrPath, 8_000);
      if (params.provider === 'pglite' && shouldRetryPgliteWasmTrap({ attempt, maxAttempts: migrateMaxAttempts, stderrTail })) {
        await sleep(250);
        continue;
      }
      const stdoutTail = await readUtf8Tail(params.stdoutPath, 8_000);
      throw attachServerStartTailToError({ error, stderrTail, stdoutTail });
    }
  }
}

async function prepareServerLightDataDir(params: {
  rootDir: string;
  testDir: string;
  dataDir: string;
  baseEnv: NodeJS.ProcessEnv;
  dbProvider: TestDbProvider;
  sqliteUrl: string;
  databaseUrlForExternalProvider?: string;
}): Promise<void> {
  if (!supportsServerLightTemplateCache(params.dbProvider)) {
    await runServerMigrationCommand({
      provider: params.dbProvider,
      env: {
        ...params.baseEnv,
        PORT: '0',
        PUBLIC_URL: 'http://127.0.0.1:0',
        ...(params.dbProvider === 'postgres' || params.dbProvider === 'mysql'
          ? { DATABASE_URL: params.databaseUrlForExternalProvider }
          : {}),
      },
      stdoutPath: resolve(params.testDir, 'server.migrate.stdout.log'),
      stderrPath: resolve(params.testDir, 'server.migrate.stderr.log'),
      timeoutMs: 180_000,
    });
    return;
  }

  const templateKey = await createServerLightTemplateCacheKey({
    rootDir: params.rootDir,
    provider: params.dbProvider,
  });

  await prepareCachedDataDir({
    cacheRootDir: resolveServerLightTemplateCacheRoot(params.rootDir),
    templateKey,
    targetDir: params.dataDir,
    buildTemplateInto: async (templateDataDir) => {
      const templateSqliteUrl = `file:${join(templateDataDir, 'happier-server-light.sqlite')}`;
      await runServerMigrationCommand({
        provider: params.dbProvider,
        env: {
          ...params.baseEnv,
          HAPPY_SERVER_LIGHT_DATA_DIR: templateDataDir,
          HAPPY_SERVER_LIGHT_DB_DIR: join(templateDataDir, 'pglite'),
          HAPPY_SERVER_LIGHT_FILES_DIR: join(templateDataDir, 'files'),
          HAPPIER_SERVER_LIGHT_DATA_DIR: templateDataDir,
          HAPPIER_SERVER_LIGHT_DB_DIR: join(templateDataDir, 'pglite'),
          HAPPIER_SERVER_LIGHT_FILES_DIR: join(templateDataDir, 'files'),
          PORT: '0',
          PUBLIC_URL: 'http://127.0.0.1:0',
          ...(params.dbProvider === 'sqlite'
            ? { DATABASE_URL: templateSqliteUrl }
            : {}),
        },
        stdoutPath: resolve(params.testDir, 'server.template.migrate.stdout.log'),
        stderrPath: resolve(params.testDir, 'server.template.migrate.stderr.log'),
        timeoutMs: 420_000,
      });
    },
  });
}

async function ensureServerSharedDepsBuilt(params: { testDir: string; env: NodeJS.ProcessEnv }): Promise<void> {
  if (shouldSkipServerSharedDepsBuild(params.env)) return;
  const rootDir = repoRootDir();
  if (sharedDepsReady) return;
  if (sharedDepsBuildPromise) {
    await sharedDepsBuildPromise;
    return;
  }

  sharedDepsBuildPromise = withServerSharedDepsBuildLock(async () => {
    if (hasServerSharedDepsOutputs(rootDir)) {
      sharedDepsReady = true;
      return;
    }

    await runLoggedCommand({
      command: yarnCommand(),
      args: resolveSharedDepsBuildArgs(),
      cwd: rootDir,
      env: { ...params.env, CI: '1' },
      stdoutPath: resolve(params.testDir, 'server.sharedDeps.stdout.log'),
      stderrPath: resolve(params.testDir, 'server.sharedDeps.stderr.log'),
      timeoutMs: 240_000,
    });

    if (!hasServerSharedDepsOutputs(rootDir)) {
      throw new Error(`Shared server workspace outputs missing after build: ${rootDir}`);
    }
    sharedDepsReady = true;
  });

  try {
    await sharedDepsBuildPromise;
  } finally {
    sharedDepsBuildPromise = null;
  }
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

async function ensureServerGeneratedProviders(params: { testDir: string; env: NodeJS.ProcessEnv; dbProvider: TestDbProvider }): Promise<void> {
  if (shouldSkipServerGenerateProviders(params.env)) return;
  const rootDir = repoRootDir();
  if (hasServerGeneratedProviderOutputs(rootDir, params.dbProvider)) {
    sharedGeneratedProvidersReady = true;
    return;
  }
  if (sharedGeneratedProvidersReady) return;
  if (sharedGenerateProvidersPromise) {
    await sharedGenerateProvidersPromise;
    return;
  }

  sharedGenerateProvidersPromise = runLoggedCommand({
    command: yarnCommand(),
    args: ['-s', 'workspace', resolveServerAppWorkspaceName(), 'generate:providers'],
    cwd: rootDir,
    env: {
      ...params.env,
      PORT: '0',
      PUBLIC_URL: 'http://127.0.0.1:0',
      DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable',
      HAPPIER_BUILD_DB_PROVIDERS: params.dbProvider,
    },
    stdoutPath: resolve(params.testDir, 'server.generate.stdout.log'),
    stderrPath: resolve(params.testDir, 'server.generate.stderr.log'),
    timeoutMs: 300_000,
  }).then(() => {
    if (!hasServerGeneratedProviderOutputs(rootDir, params.dbProvider)) {
      throw new Error(`Generated server provider outputs missing or stale after generate:providers: ${rootDir}`);
    }
    sharedGeneratedProvidersReady = true;
  });

  try {
    await sharedGenerateProvidersPromise;
  } finally {
    sharedGenerateProvidersPromise = null;
  }
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
  const currentOwnerInspection = inspectOwnedProcess(process.pid);

  const baseEnv: NodeJS.ProcessEnv = {
    ...mergedEnv,
    CI: '1',
    // Avoid global port conflicts during test runs.
    METRICS_ENABLED: 'false',
    // Auth token seed compatibility derivation can be surprisingly expensive on some machines.
    // In UI e2e we always generate a fresh HANDY_MASTER_SECRET, so the first (or second) attempt
    // should succeed; keep the attempt budget tight to avoid stalling server boot past /health timeouts.
    HAPPIER_AUTH_SEED_COMPAT_ATTEMPTS: mergedEnv.HAPPIER_AUTH_SEED_COMPAT_ATTEMPTS ?? '2',
    // Core E2E assumes a fresh auth key can always mint an account token unless a test explicitly disables it.
    AUTH_ANONYMOUS_SIGNUP_ENABLED: mergedEnv.AUTH_ANONYMOUS_SIGNUP_ENABLED ?? 'true',
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

  // Keep workspace package ESM exports current before booting server processes.
  await ensureServerSharedDepsBuilt({ testDir: params.testDir, env: baseEnv });

  const sqliteUrl = `file:${join(dataDir, 'happier-server-light.sqlite')}`;
  const databaseUrlForExternalProvider = mergedEnv.DATABASE_URL?.toString().trim();
  if ((dbProvider === 'postgres' || dbProvider === 'mysql') && !databaseUrlForExternalProvider) {
    throw new Error(`Missing DATABASE_URL for HAPPIER_E2E_DB_PROVIDER or HAPPY_E2E_DB_PROVIDER=${dbProvider}`);
  }

  // Ensure Prisma client is generated for the current schema.
  // In multi-worktree setups it's easy for @prisma/client to become stale and then
  // light-mode boot will fail at runtime (PrismaClientValidationError).
  await ensureServerGeneratedProviders({ testDir: params.testDir, env: baseEnv, dbProvider });

  if (currentOwnerInspection.ok) {
    await sweepServerLightOwnershipLeases({
      rootDir: repoRootDir(),
      currentOwnerPid: process.pid,
      currentOwnerStartTime: currentOwnerInspection.startTime,
    });
  }

  // Ensure the light database schema exists before the server boots.
  // Server light uses pglite/sqlite + Prisma but does not auto-migrate on startup.
  await prepareServerLightDataDir({
    rootDir: repoRootDir(),
    testDir: params.testDir,
    dataDir,
    baseEnv,
    dbProvider,
    sqliteUrl,
    databaseUrlForExternalProvider,
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

    const launchSpec = resolveServerStartLaunchSpec({
      provider: dbProvider,
      env,
    });

    const proc = spawnLoggedProcess({
      command: launchSpec.command,
      args: launchSpec.args,
      cwd: launchSpec.cwd,
      env: {
        ...env,
        ...(launchSpec.env ?? {}),
      },
      stdoutPath: resolve(params.testDir, 'server.stdout.log'),
      stderrPath: resolve(params.testDir, 'server.stderr.log'),
    });

    await registerProcessOwnershipLease({
      rootDir: repoRootDir(),
      leaseKind: 'server-light',
      child: proc.child,
      ownerPid: process.pid,
      ownerStartTime: currentOwnerInspection.ok ? currentOwnerInspection.startTime : null,
      metadata: {
        port,
        baseUrl,
        dataDir,
      },
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
      removeTailListeners();
      if (exitHandler) proc.child.off('exit', exitHandler);
      await proc.stop().catch(() => {});

      const contextualError = attachServerStartTailToError({
        error: e,
        stderrTail,
        stdoutTail,
      });
      lastError = contextualError;

      if (
        shouldRetryServerStartFromFailureContext({
          attempt,
          maxAttempts,
          preflightPortAvailable,
          error: contextualError,
          stderrTail,
          stdoutTail,
        })
      ) {
        continue;
      }

      throw contextualError;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to start server-light');
}
