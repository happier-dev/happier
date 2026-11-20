import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  renderPrismaCompatibleSqliteDatabaseUrl,
  resolveServerLightSqliteDatabaseUrlOptionsFromEnv,
} from '@happier-dev/cli-common/firstPartyRuntime';

import { areRequestedPrismaOutputsCurrent, type BuildDbProvider } from '../../../../../apps/server/scripts/generateClients';
import { repoRootDir } from '../paths';
import { shouldSkipServerSharedDepsBuild } from './providerSourcePreparation.mjs';
import type { EnvOverrides } from '../env';
import { runLoggedCommand, spawnLoggedProcess, type SpawnedProcess } from './spawnProcess';
import { terminateProcessTreeByPid } from './processTree';
import { waitForOkHealth } from '../http';
import { pnpmCommand } from './commands';
import { resolveServerAppWorkspaceName } from './serverWorkspaceName';
import { createServerLightTemplateCacheKey, prepareCachedDataDir, resolveServerLightTemplateCacheRoot as resolveTemplateCacheRoot } from './serverLightTemplateCache.mjs';
import { withWorkspaceSourceRuntime } from './tsxImportHook';
import { withTestProcessLease } from './testProcessLease';
import { prepareDisposableTestDatabase } from '../../../scripts/disposableTestDatabase.mjs';
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
  return await isPortAvailableForListenWithError(port, host).then((result) => result.available);
}

type PortListenAvailability = Readonly<{
  available: boolean;
  error: unknown | null;
}>;

async function isPortAvailableForListenWithError(port: number, host: string): Promise<PortListenAvailability> {
  return await new Promise((resolve) => {
    const probe = createServer();

    probe.once('error', (error) => {
      try {
        probe.close();
      } catch {
        // ignore
      }
      resolve({ available: false, error });
    });

    probe.listen(port, host, () => {
      probe.close(() => resolve({ available: true, error: null }));
    });
  });
}

function renderListenAvailabilityErrorSuffix(error: unknown | null): string {
  if (!error) return '';
  if (typeof error !== 'object') return '';
  const row = error as { code?: unknown; message?: unknown };
  const code = typeof row.code === 'string' ? row.code : '';
  const message = typeof row.message === 'string' ? row.message : '';
  if (code && message) return ` (lastError=${code}: ${message})`;
  if (code) return ` (lastError=${code})`;
  if (message) return ` (lastError=${message})`;
  return '';
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

function isSilentHealthTimeoutDuringStartup(params: { error: unknown; stderrTail: string; stdoutTail: string }): boolean {
  const message = params.error instanceof Error ? params.error.message : String(params.error ?? '');
  if (!message.includes('Timed out waiting for /health')) return false;
  if (!message.includes('lastStatus=none')) return false;
  if (!message.includes('lastError=fetch failed')) return false;

  const substantiveStdout = params.stdoutTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // pnpm prints the selected workspace script before the server itself emits anything.
    .filter((line) => !/^\$ node \.\/scripts\/runTsx\.mjs --tsconfig \.\/tsconfig\.json \.\/sources\/main(?:\.light)?\.ts$/.test(line));
  if (substantiveStdout.length > 0) return false;

  const substantiveStderr = params.stderrTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.includes("Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set."))
    .filter((line) => !line.includes('Use `node --trace-warnings ...` to show where the warning was created'))
    .filter((line) => !line.includes('[DEP0205] DeprecationWarning: `module.register()` is deprecated'));

  return substantiveStderr.length === 0;
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

function prepareServerStartAttemptLogs(params: { testDir: string; attempt: number }): {
  stdoutPath: string;
  stderrPath: string;
} {
  const stdoutPath = resolve(params.testDir, `server.attempt-${params.attempt}.stdout.log`);
  const stderrPath = resolve(params.testDir, `server.attempt-${params.attempt}.stderr.log`);
  const currentStdoutPath = resolve(params.testDir, 'server.stdout.log');
  const currentStderrPath = resolve(params.testDir, 'server.stderr.log');

  writeFileSync(stdoutPath, '');
  writeFileSync(stderrPath, '');

  for (const [attemptPath, currentPath] of [
    [stdoutPath, currentStdoutPath],
    [stderrPath, currentStderrPath],
  ] as const) {
    try {
      unlinkSync(currentPath);
    } catch (error) {
      if (
        !error
        || typeof error !== 'object'
        || !('code' in error)
        || error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
    // Preserve the long-lived convenience paths without copying a live process log.
    linkSync(attemptPath, currentPath);
  }

  return { stdoutPath, stderrPath };
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
  if (
    params.attempt < params.maxAttempts
    && isSilentHealthTimeoutDuringStartup({
      error: contextualError,
      stderrTail: params.stderrTail,
      stdoutTail: params.stdoutTail,
    })
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
  /** The connection selected by this fixture, including disposable database isolation. */
  databaseUrl?: string;
  /** Source guest payload prepared for this Home and available on the fixture controller. */
  guestCliPayloadRoot?: string;
  proc: SpawnedProcess;
  stop: () => Promise<void>;
};

export type TestDbProvider = 'pglite' | 'sqlite' | 'postgres' | 'mysql';
export type ServerStartLaunchSpec = Readonly<{
  command: string;
  args: string[];
  cwd: string;
  env?: EnvOverrides;
}>;

let sharedDepsBuildPromise: Promise<void> | null = null;
let sharedGenerateProvidersPromise: Promise<void> | null = null;

export function resolveTestDbProvider(
  env: NodeJS.ProcessEnv,
  options?: Readonly<{ fallbackProvider?: TestDbProvider }>,
): TestDbProvider {
  const raw = (env.HAPPIER_E2E_DB_PROVIDER ?? env.HAPPY_E2E_DB_PROVIDER ?? '').toString().trim().toLowerCase();
  if (raw === 'pglite') return 'pglite';
  if (raw === 'sqlite') return 'sqlite';
  if (raw === 'postgres' || raw === 'postgresql') return 'postgres';
  if (raw === 'mysql') return 'mysql';
  return options?.fallbackProvider ?? 'pglite';
}

export function resolveServerLightDatabaseUrlEnv(params: {
  dbProvider: TestDbProvider;
  generatedSqliteUrl: string;
  explicitDatabaseUrl?: string;
}): EnvOverrides {
  const explicitDatabaseUrl = params.explicitDatabaseUrl?.trim();
  if (params.dbProvider === 'sqlite') {
    return {
      DATABASE_URL: explicitDatabaseUrl || params.generatedSqliteUrl,
    };
  }
  if ((params.dbProvider === 'postgres' || params.dbProvider === 'mysql') && explicitDatabaseUrl) {
    return {
      DATABASE_URL: explicitDatabaseUrl,
    };
  }
  return {};
}

export function renderServerLightSqliteDatabaseUrl(params: Readonly<{
  dbPath: string;
  platform?: string;
}>): string {
  return renderPrismaCompatibleSqliteDatabaseUrl({
    dbPath: params.dbPath,
    platform: params.platform ?? process.platform,
    sqlite: resolveServerLightSqliteDatabaseUrlOptionsFromEnv({}),
  });
}

export function resolveStartCommandArgs(provider: TestDbProvider): string[] {
  const script = provider === 'postgres' || provider === 'mysql' ? 'start' : 'start:light';
  return ['--filter', resolveServerAppWorkspaceName(), 'run', '--silent', script];
}

function resolveServerWorkspaceDir(rootDir: string): string {
  return resolve(rootDir, 'apps', 'server');
}

function resolveServerTsconfigPath(rootDir: string): string {
  return resolve(resolveServerWorkspaceDir(rootDir), 'tsconfig.exec.json');
}

function resolveServerSharedDepsOutputPaths(rootDir: string): string[] {
  return [
    resolve(rootDir, 'packages', 'agents', 'dist', 'index.js'),
    resolve(rootDir, 'packages', 'protocol', 'dist', 'index.js'),
    resolve(rootDir, 'packages', 'cli-common', 'dist', 'tailscale', 'index.js'),
  ];
}

export function hasServerSharedDepsOutputs(rootDir: string): boolean {
  return resolveServerSharedDepsOutputPaths(rootDir).every((outputPath) => existsSync(outputPath));
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
  // Waiters wait while a live, heartbeating holder builds (the build itself has no harness
  // deadline); a dead holder's lease goes stale and is reclaimed.
  return await withTestProcessLease(async () => await fn(), {
    lockPath,
    timeoutMs: options?.timeoutMs ?? Number.POSITIVE_INFINITY,
    pollIntervalMs: options?.pollIntervalMs,
    staleAfterMs: options?.staleAfterMs ?? 240_000,
    errorLabel: 'server shared deps build lock',
  });
}

export async function hasServerGeneratedProviderOutputs(rootDir: string, provider: TestDbProvider): Promise<boolean> {
  // The generator owns freshness, including Prisma's formatting and source stamps.
  return areRequestedPrismaOutputsCurrent({
    serverRoot: resolveServerWorkspaceDir(rootDir),
    providers: new Set<BuildDbProvider>(provider === 'sqlite' ? ['postgres', 'sqlite']
      : provider === 'mysql' ? ['postgres', 'mysql'] : ['postgres']),
  });
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

    return {
      command: process.execPath,
      args: [sourceEntrypoint],
      cwd: resolveServerWorkspaceDir(rootDir),
      env: {
        NODE_OPTIONS: withWorkspaceSourceRuntime(params.env, rootDir).NODE_OPTIONS,
        TSX_TSCONFIG_PATH: resolveServerTsconfigPath(rootDir),
      },
    };
  }

  return {
    command: pnpmCommand(),
    args: resolveStartCommandArgs(params.provider),
    cwd: rootDir,
    env: {
      TSX_TSCONFIG_PATH: resolveServerTsconfigPath(rootDir),
    },
  };
}

export function resolveSharedDepsBuildArgs(): string[] {
  return ['--filter', resolveServerAppWorkspaceName(), 'run', '--silent', 'build:shared'];
}

export { shouldSkipServerSharedDepsBuild };
export function resolveMigrateCommandArgs(provider: TestDbProvider): string[] {
  if (provider === 'sqlite') {
    return ['--filter', resolveServerAppWorkspaceName(), 'run', '--silent', 'migrate:sqlite:deploy'];
  }
  if (provider === 'pglite') {
    return ['--filter', resolveServerAppWorkspaceName(), 'run', '--silent', 'migrate:light:deploy'];
  }
  if (provider === 'mysql') {
    return ['--filter', resolveServerAppWorkspaceName(), 'run', '--silent', 'migrate:mysql:deploy'];
  }
  return ['--filter', resolveServerAppWorkspaceName(), 'run', '--silent', 'migrate:full:deploy'];
}

function supportsServerLightTemplateCache(provider: TestDbProvider): provider is 'sqlite' | 'pglite' {
  return provider === 'sqlite' || provider === 'pglite';
}

export function resolveServerLightTemplateCacheRoot(rootDir: string = repoRootDir()): string {
  return resolveTemplateCacheRoot(rootDir);
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
        command: pnpmCommand(),
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
        ...(params.dbProvider === 'mysql'
          ? {
              // The Docker/E2E database is isolated and has no predecessor writers.
              HAPPIER_DB_MIGRATION_APPROVAL:
                '20260729102000_add_voice_conversation_grant_provenance',
            }
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
      const templateSqliteUrl = renderServerLightSqliteDatabaseUrl({
        dbPath: join(templateDataDir, 'happier-server-light.sqlite'),
      });
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

/**
 * Once per test run (the Vitest and Playwright global setups): build the server's shared workspace
 * dependencies through the canonical builder, then let every server start in the run skip it.
 * Workers inherit the skip through the environment. Before, each server start (one per test file)
 * re-ran the builder: a pnpm build invocation per file, and on shared hosts a package-dist
 * admission wait per file.
 */
export async function prepareServerSharedDepsForRun(params: { testDir: string; env: NodeJS.ProcessEnv }): Promise<void> {
  if (shouldSkipServerSharedDepsBuild(params.env)) return;
  mkdirSync(params.testDir, { recursive: true });
  await ensureServerSharedDepsBuilt(params);
  process.env.HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD = '1';
}

async function ensureServerSharedDepsBuilt(params: { testDir: string; env: NodeJS.ProcessEnv }): Promise<void> {
  if (shouldSkipServerSharedDepsBuild(params.env)) return;
  const rootDir = repoRootDir();
  if (sharedDepsBuildPromise) {
    await sharedDepsBuildPromise;
    return;
  }

  sharedDepsBuildPromise = withServerSharedDepsBuildLock(async () => {
    // The canonical builder owns freshness and its no-op decision; output presence is not freshness.
    await runLoggedCommand({
      command: pnpmCommand(),
      args: resolveSharedDepsBuildArgs(),
      cwd: rootDir,
      env: { ...params.env, CI: '1' },
      stdoutPath: resolve(params.testDir, 'server.sharedDeps.stdout.log'),
      stderrPath: resolve(params.testDir, 'server.sharedDeps.stderr.log'),
      // The publisher owns readiness and may wait for admission or workspace locks, as the CLI
      // shared-deps build does: a 240 s harness deadline failed every UI spec on shared hosts.
      timeoutMs: null,
    });

    if (!hasServerSharedDepsOutputs(rootDir)) {
      throw new Error(`Shared server workspace outputs missing after build: ${rootDir}`);
    }
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

export async function ensureServerGeneratedProviderOutputs(params: Readonly<{
  dbProvider: TestDbProvider;
  hasOutputs: (provider: TestDbProvider) => boolean | Promise<boolean>;
  generate: (provider: TestDbProvider) => Promise<void>;
}>): Promise<void> {
  while (!await params.hasOutputs(params.dbProvider)) {
    if (sharedGenerateProvidersPromise) {
      await sharedGenerateProvidersPromise;
      continue;
    }

    const generation = params.generate(params.dbProvider).then(async () => {
      if (!await params.hasOutputs(params.dbProvider)) {
        throw new Error(`Generated server provider outputs missing or stale after generate:providers: ${repoRootDir()}`);
      }
    });
    sharedGenerateProvidersPromise = generation;
    try {
      await generation;
    } finally {
      if (sharedGenerateProvidersPromise === generation) {
        sharedGenerateProvidersPromise = null;
      }
    }
  }
}

async function ensureServerGeneratedProviders(params: { testDir: string; env: NodeJS.ProcessEnv; dbProvider: TestDbProvider }): Promise<void> {
  if (shouldSkipServerGenerateProviders(params.env)) return;
  const rootDir = repoRootDir();
  await ensureServerGeneratedProviderOutputs({
    dbProvider: params.dbProvider,
    hasOutputs: (provider) => hasServerGeneratedProviderOutputs(rootDir, provider),
    generate: async (provider) => {
      await runLoggedCommand({
        command: pnpmCommand(),
        args: ['--filter', resolveServerAppWorkspaceName(), 'run', '--silent', 'generate:providers'],
        cwd: rootDir,
        env: {
          ...params.env,
          PORT: '0',
          PUBLIC_URL: 'http://127.0.0.1:0',
          DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable',
          HAPPIER_BUILD_DB_PROVIDERS: provider,
        },
        stdoutPath: resolve(params.testDir, 'server.generate.stdout.log'),
        stderrPath: resolve(params.testDir, 'server.generate.stderr.log'),
        timeoutMs: 300_000,
      });
    },
  });
}
export async function startServerLight(params: {
  testDir: string;
  /** Source-loaded process fixtures can share their caller's startup budget. */
  startupTimeoutMs?: number;
  extraEnv?: EnvOverrides;
  dbProvider?: TestDbProvider;
  dataDirMode?: 'fresh' | 'reuse-existing';
  preserveExistingDataDir?: boolean;
  /**
   * Pin the loopback port instead of allocating a random one. Required when a
   * caller must render port-dependent runtime configuration (for example a
   * Personal Home's canonical `http://127.0.0.1:<port>` auth audience) before
   * the process starts, or must reuse the same origin across a restart.
   */
  port?: number;
  /**
   * Test-only hook: override port selection to force EADDRINUSE scenarios.
   * Not part of the public API; used to validate retry behavior deterministically.
   */
  __portAllocator?: () => Promise<number>;
  /** Test-only artifact preparation after server setup and immediately before each process spawn. */
  __beforeSpawnAttempt?: () => Promise<void>;
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

  const sqliteUrl = renderServerLightSqliteDatabaseUrl({
    dbPath: join(dataDir, 'happier-server-light.sqlite'),
  });
  const explicitSqliteDatabaseUrl = params.extraEnv?.DATABASE_URL?.toString().trim();
  let databaseUrlForExternalProvider = mergedEnv.DATABASE_URL?.toString().trim();
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
  const shouldReuseExistingDataDir =
    (params.dataDirMode === 'reuse-existing' || params.preserveExistingDataDir === true)
    && existsSync(dataDir)
    && readdirSync(dataDir).length > 0;
  if ((dbProvider === 'postgres' || dbProvider === 'mysql') && databaseUrlForExternalProvider) {
    // A data directory is the existing fixture identity across server restarts.
    // PostgreSQL identifiers allow 63 bytes: the prefix leaves 47 hex bytes.
    const databaseName = `happier_fixture_${createHash('sha256').update(dataDir).digest('hex').slice(0, 47)}`;
    databaseUrlForExternalProvider = prepareDisposableTestDatabase({ databaseName, dbProvider,
      sourceDatabaseUrl: databaseUrlForExternalProvider, reuseExisting: shouldReuseExistingDataDir, env: mergedEnv,
    }) ?? databaseUrlForExternalProvider;
    baseEnv.DATABASE_URL = databaseUrlForExternalProvider;
  }
  if (!shouldReuseExistingDataDir) {
    await prepareServerLightDataDir({
      rootDir: repoRootDir(),
      testDir: params.testDir,
      dataDir,
      baseEnv,
      dbProvider,
      sqliteUrl,
      databaseUrlForExternalProvider,
    });
  }

  let preparedSourceLaunch: ServerStartLaunchSpec | undefined;
  if (shouldUseServerSourceEntrypoint(baseEnv) && baseEnv.HAPPIER_DEV_GUEST_CLI_EXPORT === '1') {
    const rootDir = repoRootDir();
    const [producer, launcher] = await Promise.all([
      import(/* @vite-ignore */ pathToFileURL(resolve(rootDir, 'apps/stack/scripts/build/build_source_runtime.mjs')).href),
      import(/* @vite-ignore */ pathToFileURL(resolve(rootDir, 'apps/stack/scripts/runtime/launch/resolveServerRuntimeLaunchSpec.mjs')).href),
    ]);
    // Stack's JavaScript producer owns this untyped boundary and the archive metadata.
    const built: Readonly<{ entrypoint: string; serverDir: string; env: NodeJS.ProcessEnv }> = await producer.buildSourceRuntimeBundle({
      repoDir: rootDir,
      outputDir: join(params.testDir, 'source-runtime'),
      component: 'server',
      serverComponent: dbProvider === 'postgres' || dbProvider === 'mysql' ? 'happier-server' : 'happier-server-light',
      dbProvider,
      env: baseEnv,
    });
    const launch: Omit<ServerStartLaunchSpec, 'cwd'> = launcher.resolveServerRuntimeLaunchSpec({
      sourceRuntimeLaunch: built, migrationsEnabled: false, env: baseEnv,
    });
    preparedSourceLaunch = { ...launch, cwd: built.serverDir };
  }

  const pinnedPort = params.port;
  const portAllocator = params.__portAllocator
    ?? (pinnedPort !== undefined ? async () => pinnedPort : async () => pickPortCandidate());
  const maxAttempts = 5;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await portAllocator();
    const portAvailability = await isPortAvailableForListenWithError(port, '127.0.0.1');
    const preflightPortAvailable = portAvailability.available;
    if (!preflightPortAvailable) {
      if (attempt < maxAttempts) {
        lastError = portAvailability.error;
        continue;
      }
      throw new Error(
        `server-light could not allocate an available port after ${maxAttempts} attempts (lastPort=${port})${renderListenAvailabilityErrorSuffix(portAvailability.error)}`,
      );
    }

    const baseUrl = `http://127.0.0.1:${port}`;
    const databaseUrlEnv = resolveServerLightDatabaseUrlEnv({
      dbProvider,
      generatedSqliteUrl: sqliteUrl,
      explicitDatabaseUrl: dbProvider === 'sqlite' ? explicitSqliteDatabaseUrl : databaseUrlForExternalProvider,
    });

    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(port),
      PUBLIC_URL: baseUrl,
      // Key-challenge auth (terminal sign-in) is bound to the canonical Home
      // origin and answers 503 without one; a test server is its own origin.
      HAPPIER_CANONICAL_SERVER_URL: params.extraEnv?.HAPPIER_CANONICAL_SERVER_URL ?? baseUrl,
      ...databaseUrlEnv,
    };

    const launchSpec = preparedSourceLaunch ?? resolveServerStartLaunchSpec({
      provider: dbProvider,
      env,
    });
    const attemptLogs = prepareServerStartAttemptLogs({ testDir: params.testDir, attempt });

    await params.__beforeSpawnAttempt?.();

    const proc = spawnLoggedProcess({
      command: launchSpec.command,
      args: launchSpec.args,
      cwd: launchSpec.cwd,
      env: {
        ...env,
        ...(launchSpec.env ?? {}),
      },
      stdoutPath: attemptLogs.stdoutPath,
      stderrPath: attemptLogs.stderrPath,
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
      await Promise.race([waitForOkHealth(baseUrl, { timeoutMs: params.startupTimeoutMs ?? 90_000 }), exitedEarly]);

      removeTailListeners();
      if (exitHandler) proc.child.off('exit', exitHandler);

      const guestCliPayloadRoot = preparedSourceLaunch?.env?.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT;
      return {
        baseUrl,
        port,
        dataDir,
        ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
        ...(guestCliPayloadRoot ? { guestCliPayloadRoot } : {}),
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
