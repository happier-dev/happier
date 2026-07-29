import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, extname, dirname, relative as relativePath, resolve as resolvePath } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRootDir } from '../paths';
import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { runLoggedCommand } from './spawnProcess';
import { readPositiveEnvInt } from './uiWebEnv';
import type { StartedUiWeb } from './uiWebTypes';
import { terminateProcessTreeByPid } from './processTree';
import { buildUiWebExportCacheKey } from './uiWebExportCacheKey';
import { redactHarnessLogText } from './harnessLogRedaction';
import { type JsonOwnerFileLockLease, withJsonOwnerFileLock } from './jsonOwnerFileLock';
import {
  createUiWebExportStartupStallGuard,
  isUiWebExportMetroCacheCorruptionError,
	  stderrHasUiWebExportMetroCacheCorruption,
	} from './createUiWebExportStartupStallGuard';
import {
  ensureUiWebWorkspacePrebuild,
  isUiWebWorkspacePrebuildSharedCliDistBuildLockActiveError,
  isUiWebWorkspacePrebuildTimeoutError,
} from './uiWebWorkspacePrebuild';

function resolveExpoCliEntrypoint(workspaceRootDir: string): string {
  return resolvePath(workspaceRootDir, 'node_modules', 'expo', 'bin', 'cli');
}

export function resolveUiWebExportRootDir(env: NodeJS.ProcessEnv = process.env): string {
  const rootDir = resolvePath(repoRootDir(), '.project', 'tmp', 'ui-web-export');
  const namespace = String(env.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE ?? '').trim();
  return namespace ? resolvePath(rootDir, namespace) : rootDir;
}

function resolveUiWebExportRootDirForParams(params: {
  env: NodeJS.ProcessEnv;
  testDir?: string;
  cacheKey?: string;
}): string {
  const explicitNamespace = String(params.env.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE ?? '').trim();
  if (explicitNamespace) {
    return resolveUiWebExportRootDir(params.env);
  }
  const cacheKey = String(params.cacheKey ?? '').trim();
  if (cacheKey.length > 0) {
    const sharedNamespace = `cache-${createHash('sha1').update(cacheKey).digest('hex').slice(0, 12)}`;
    return resolveUiWebExportRootDir({
      ...params.env,
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: sharedNamespace,
    });
  }

  const normalizedTestDir = typeof params.testDir === 'string' ? params.testDir.trim() : '';
  if (!normalizedTestDir) {
    return resolveUiWebExportRootDir(params.env);
  }

  const derivedNamespace = `auto-${createHash('sha1').update(normalizedTestDir).digest('hex').slice(0, 12)}`;
  return resolveUiWebExportRootDir({
    ...params.env,
    HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: derivedNamespace,
  });
}

function hasExplicitUiWebExportNamespace(env: NodeJS.ProcessEnv): boolean {
  return String(env.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE ?? '').trim().length > 0;
}

let sharedExportPromise: Promise<string> | null = null;
let sharedExportDir: string | null = null;
let sharedExportCacheKey: string | null = null;
let sharedExportRootDir: string | null = null;
const UI_WEB_EXPORT_MANIFEST_VERSION = 1;

export const __testables = {
  resetSharedUiWebExportState(): void {
    sharedExportPromise = null;
    sharedExportDir = null;
    sharedExportCacheKey = null;
    sharedExportRootDir = null;
  },
  shouldReclaimUiWebExportLock,
  withUiWebExportLock,
  removePathWithRetries,
};

type UiWebRuntimeConfig = Readonly<{
  serverUrl: string;
  syncTuningJson: string;
}>;

type LockOwner = {
  pid: number | null;
  createdAtMs: number | null;
  stagingDir: string | null;
};

function parseLockOwner(raw: string): LockOwner {
  const text = raw.trim();
  if (!text) return { pid: null, createdAtMs: null, stagingDir: null };
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; createdAtMs?: unknown; stagingDir?: unknown };
    return {
      pid: typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
      createdAtMs:
        typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs) && parsed.createdAtMs > 0
          ? parsed.createdAtMs
          : null,
      stagingDir: typeof parsed.stagingDir === 'string' && parsed.stagingDir.trim().length > 0
        ? parsed.stagingDir.trim()
        : null,
    };
  } catch {
    return { pid: null, createdAtMs: null, stagingDir: null };
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removePathWithRetries(
  path: string,
  options?: Readonly<{
    timeoutMs?: number;
    intervalMs?: number;
    removePath?: typeof rm;
  }>,
): Promise<void> {
  const removePath = options?.removePath ?? rm;
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const intervalMs = options?.intervalMs ?? 100;
  const retryableCodes = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);
  const startedAtMs = Date.now();

  while (true) {
    try {
      await removePath(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (!retryableCodes.has(code ?? '')) {
        throw error;
      }
      if (Date.now() - startedAtMs >= timeoutMs) {
        throw error;
      }
      await sleep(intervalMs);
    }
  }
}

function isTransientUiWebExportMetroCleanupError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ENOTEMPTY') || message.includes('EBUSY') || message.includes('EPERM');
}

async function readLatestMtimeMs(currentPath: string): Promise<number> {
  const currentStat = await stat(currentPath).catch(() => null);
  if (!currentStat) {
    return 0;
  }
  if (currentStat.isFile()) {
    return currentStat.mtimeMs;
  }
  if (!currentStat.isDirectory()) {
    return 0;
  }

  const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
  let latestMtimeMs = currentStat.mtimeMs;
  for (const entry of entries) {
    latestMtimeMs = Math.max(latestMtimeMs, await readLatestMtimeMs(resolvePath(currentPath, entry.name)));
  }
  return latestMtimeMs;
}

async function hasRecentUiWebExportStagingProgress(rootDir: string, staleAfterMs: number): Promise<boolean> {
  const cutoffMs = Date.now() - staleAfterMs;
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('dist-staging-')) continue;
    const stagingLatestMtimeMs = await readLatestMtimeMs(resolvePath(rootDir, entry.name));
    if (stagingLatestMtimeMs > cutoffMs) {
      return true;
    }
  }
  return false;
}

async function hasRecentUiWebExportOwnerStagingProgress(params: {
  rootDir: string;
  staleAfterMs: number;
  ownerStagingDir: string;
}): Promise<boolean> {
  const cutoffMs = Date.now() - params.staleAfterMs;
  const ownerStagingPath = params.ownerStagingDir.startsWith('/')
    ? params.ownerStagingDir
    : resolvePath(params.rootDir, params.ownerStagingDir);
  if (!basename(ownerStagingPath).startsWith('dist-staging-')) {
    return false;
  }
  const stagingLatestMtimeMs = await readLatestMtimeMs(ownerStagingPath);
  return stagingLatestMtimeMs > cutoffMs;
}

function writeUiWebExportLockOwnerMetadata(lease: JsonOwnerFileLockLease, stagingDir: string): void {
  lease.updateOwnerMetadata({ stagingDir });
}

function listUiWebExportOwnerProcessPids(ownerStagingPath: string): number[] {
  const result = spawnSync('ps', ['-axo', 'pid=,args=', '-ww'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length === 0) {
    return [];
  }

  const matches = new Set<number>();
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? '', 10);
    const command = match[2] ?? '';
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!command.includes('expo export')) continue;
    if (!command.includes('--output-dir')) continue;
    if (!command.includes(ownerStagingPath)) continue;
    matches.add(pid);
  }
  return [...matches];
}

async function terminateOrphanedUiWebExportOwnerProcesses(ownerStagingPath: string): Promise<void> {
  const processPids = listUiWebExportOwnerProcessPids(ownerStagingPath);
  for (const pid of processPids) {
    await terminateProcessTreeByPid(pid, {
      graceMs: 250,
      pollMs: 25,
    }).catch(() => {});
  }
}

async function shouldReclaimUiWebExportLockRaw(
  lockPath: string,
  rawOwner: string | null,
  staleAfterMs: number,
): Promise<boolean> {
  try {
    const owner = parseLockOwner(rawOwner ?? '');
    const rootDir = dirname(lockPath);
    if (owner.pid == null && owner.createdAtMs == null) {
      return !(await hasRecentUiWebExportStagingProgress(rootDir, staleAfterMs));
    }
    if (owner.pid != null && !isRunningPid(owner.pid)) {
      if (owner.stagingDir) {
        const ownerStagingPath = owner.stagingDir.startsWith('/')
          ? owner.stagingDir
          : resolvePath(rootDir, owner.stagingDir);
        await terminateOrphanedUiWebExportOwnerProcesses(ownerStagingPath);
      }
      return true;
    }
    if (owner.createdAtMs != null && Date.now() - owner.createdAtMs > staleAfterMs) {
      const ownerHasRecentProgress = owner.stagingDir
        ? await hasRecentUiWebExportOwnerStagingProgress({
          rootDir,
          staleAfterMs,
          ownerStagingDir: owner.stagingDir,
        })
        : await hasRecentUiWebExportStagingProgress(rootDir, staleAfterMs);
      return !ownerHasRecentProgress;
    }
    return false;
  } catch {
    return true;
  }
}

export async function shouldReclaimUiWebExportLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  try {
    return await shouldReclaimUiWebExportLockRaw(lockPath, readFileSync(lockPath, 'utf8'), staleAfterMs);
  } catch {
    return true;
  }
}

async function withUiWebExportLock<T>(
  lockPath: string,
  fn: (lease: JsonOwnerFileLockLease) => Promise<T>,
  options?: { timeoutMs?: number; staleAfterMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 900_000;
  const staleAfterMs = options?.staleAfterMs ?? timeoutMs;
  return await withJsonOwnerFileLock(fn, {
    lockPath,
    timeoutMs,
    pollIntervalMs: 250,
    staleAfterMs,
    heartbeat: false,
    errorLabel: 'UI web export build lock',
    shouldReclaimSnapshot: async ({ snapshot }) =>
      await shouldReclaimUiWebExportLockRaw(lockPath, snapshot.raw, staleAfterMs),
  });
}

export function resolveUiWebExportBuildTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS, 480_000);
}

export function resolveUiWebExportWorkspacePrebuildTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(
    env.HAPPIER_E2E_UI_WEB_EXPORT_WORKSPACE_PREBUILD_TIMEOUT_MS,
    resolveUiWebExportBuildTimeoutMs(env),
  );
}

export function resolveUiWebExportHardTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = String(env.HAPPIER_E2E_UI_WEB_EXPORT_HARD_TIMEOUT_MS ?? '').trim();
  if (!raw) return null;
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_EXPORT_HARD_TIMEOUT_MS, 0);
}

export function resolveUiWebExportAbortSettleTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_EXPORT_ABORT_SETTLE_TIMEOUT_MS, 500);
}

export function resolveUiWebExportLockTimeoutMs(env: NodeJS.ProcessEnv): number {
  return readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_EXPORT_LOCK_TIMEOUT_MS, resolveUiWebExportBeforeAllTimeoutMs(env));
}

export function resolveUiWebExportBeforeAllTimeoutMs(env: NodeJS.ProcessEnv): number {
  const minTimeoutMs = readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_BEFORE_ALL_MIN_TIMEOUT_MS, 900_000);
  const headroomMs = readPositiveEnvInt(env.HAPPIER_E2E_UI_WEB_BEFORE_ALL_HEADROOM_MS, 60_000);
  const exportIdleTimeoutMs = resolveUiWebExportBuildTimeoutMs(env);
  const exportHardTimeoutMs = resolveUiWebExportHardTimeoutMs(env);
  const exportBudgetMs = exportHardTimeoutMs == null ? exportIdleTimeoutMs : Math.max(exportIdleTimeoutMs, exportHardTimeoutMs);
  return Math.max(minTimeoutMs, exportBudgetMs + headroomMs);
}

function readServerUrlFromEnv(env: NodeJS.ProcessEnv): string {
  return String(
    env.EXPO_PUBLIC_HAPPIER_SERVER_URL
    ?? env.EXPO_PUBLIC_HAPPY_SERVER_URL
    ?? env.EXPO_PUBLIC_SERVER_URL
    ?? '',
  ).trim();
}

function readSyncTuningJsonFromEnv(env: NodeJS.ProcessEnv): string {
  return String(env.EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON ?? '').trim();
}

function buildRuntimeConfig(env: NodeJS.ProcessEnv): UiWebRuntimeConfig {
  return {
    serverUrl: readServerUrlFromEnv(env),
    syncTuningJson: readSyncTuningJsonFromEnv(env),
  };
}

function buildExportEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const debug = String(env.EXPO_PUBLIC_DEBUG ?? '1').trim() || '1';
  const nodeEnvRaw = String(env.HAPPIER_E2E_UI_WEB_EXPORT_NODE_ENV ?? 'production').trim().toLowerCase();
  const nodeEnv = nodeEnvRaw === 'development' ? 'development' : 'production';
  const metroCacheVersionBust = createHash('sha256')
    .update(buildUiWebExportCacheKey(env))
    .digest('hex')
    .slice(0, 16);
  return {
    ...process.env,
    ...env,
    CI: '1',
    NODE_ENV: nodeEnv,
    EXPO_NO_TELEMETRY: '1',
    EXPO_NO_INTERACTIVE: '1',
    EXPO_PUBLIC_DEBUG: debug,
    EXPO_PUBLIC_POSTHOG_KEY: String(env.EXPO_PUBLIC_POSTHOG_KEY ?? 'phc-clear-export').trim() || 'phc-clear-export',
    EXPO_PUBLIC_HAPPIER_SERVER_URL: '',
    EXPO_PUBLIC_HAPPY_SERVER_URL: '',
    EXPO_PUBLIC_SERVER_URL: '',
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: '',
    EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: '',
    HAPPIER_UI_METRO_CACHE_VERSION_BUST: metroCacheVersionBust,
  };
}

function parseEnvBool(raw: unknown): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'y' || value === 'on';
}

function resolveUiWebExportNoMinify(env: NodeJS.ProcessEnv): boolean {
  return parseEnvBool(env.HAPPIER_E2E_UI_WEB_EXPORT_NO_MINIFY);
}

function resolveUiWebExportDev(env: NodeJS.ProcessEnv): boolean {
  return parseEnvBool(env.HAPPIER_E2E_UI_WEB_EXPORT_DEV);
}

function resolveUiWebExportSourceMapsMode(env: NodeJS.ProcessEnv): string | null {
  const raw = String(env.HAPPIER_E2E_UI_WEB_EXPORT_SOURCE_MAPS ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'true' || raw === 'false' || raw === 'inline' || raw === 'external') return raw;
  return null;
}

function shouldBoundUiWebExportAbortDrain(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('expo export startup stalled after');
}

async function waitForUiWebExportRunPromiseAfterAbort(params: {
  runPromise: Promise<void>;
  error: unknown;
  env: NodeJS.ProcessEnv;
  stagingDir: string;
}): Promise<void> {
  if (!shouldBoundUiWebExportAbortDrain(params.error)) {
    await params.runPromise.catch(() => {});
    return;
  }

  let settled = false;
  await Promise.race([
    params.runPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    ),
    sleep(resolveUiWebExportAbortSettleTimeoutMs(params.env)),
  ]);

  if (!settled) {
    await terminateOrphanedUiWebExportOwnerProcesses(params.stagingDir).catch(() => {});
  }
}

function readPersistedUiWebExportCacheKey(cacheKeyPath: string): string | null {
  try {
    if (!existsSync(cacheKeyPath)) return null;
    const raw = readFileSync(cacheKeyPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { cacheKey?: unknown };
    const cacheKey = typeof parsed.cacheKey === 'string' ? parsed.cacheKey.trim() : '';
    return cacheKey || null;
  } catch {
    return null;
  }
}

function writePersistedUiWebExportCacheKey(cacheKeyPath: string, cacheKey: string): void {
  writeFileSync(cacheKeyPath, JSON.stringify({ cacheKey }), 'utf8');
}

function hasPersistedUiWebExportManifest(manifestPath: string): boolean {
  try {
    if (!existsSync(manifestPath)) return false;
    const raw = readFileSync(manifestPath, 'utf8').trim();
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { formatVersion?: unknown };
    return parsed.formatVersion === UI_WEB_EXPORT_MANIFEST_VERSION;
  } catch {
    return false;
  }
}

function writePersistedUiWebExportManifest(manifestPath: string): void {
  writeFileSync(manifestPath, JSON.stringify({
    formatVersion: UI_WEB_EXPORT_MANIFEST_VERSION,
    createdAtMs: Date.now(),
  }), 'utf8');
}

const REQUIRED_UI_WEB_EXPORT_FILES = ['index.html', 'metadata.json'] as const;

type UiWebExportFailureSnapshot = Readonly<{
  fileCount: number;
  publishPhaseFileCount: number;
  sampleFiles: readonly string[];
}>;

async function readUiWebExportFailureSnapshot(rootDir: string, currentPath = rootDir): Promise<UiWebExportFailureSnapshot> {
  const currentStat = await stat(currentPath).catch(() => null);
  if (!currentStat) {
    return {
      fileCount: 0,
      publishPhaseFileCount: 0,
      sampleFiles: [],
    };
  }

  if (currentStat.isFile()) {
    const relativeName = relativePath(rootDir, currentPath);
    return {
      fileCount: 1,
      publishPhaseFileCount: REQUIRED_UI_WEB_EXPORT_FILES.includes(relativeName as (typeof REQUIRED_UI_WEB_EXPORT_FILES)[number]) ? 1 : 0,
      sampleFiles: [relativeName],
    };
  }

  if (!currentStat.isDirectory()) {
    return {
      fileCount: 0,
      publishPhaseFileCount: 0,
      sampleFiles: [],
    };
  }

  const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
  let fileCount = 0;
  let publishPhaseFileCount = 0;
  const sampleFiles: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childSnapshot = await readUiWebExportFailureSnapshot(rootDir, resolvePath(currentPath, entry.name));
    fileCount += childSnapshot.fileCount;
    publishPhaseFileCount += childSnapshot.publishPhaseFileCount;
    for (const sampleFile of childSnapshot.sampleFiles) {
      if (sampleFiles.length >= 8) break;
      sampleFiles.push(sampleFile);
    }
  }

  return {
    fileCount,
    publishPhaseFileCount,
    sampleFiles,
  };
}

async function classifyUiWebExportFailure(params: {
  error: unknown;
  stdoutTail: string;
  stderrTail: string;
  stagingDir: string;
}): Promise<string | null> {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  const metroStarted = `${params.stdoutTail}\n${params.stderrTail}`.includes('Starting Metro Bundler');
  const stderrLooksLikeUnresolvedModuleImport = params.stderrTail.includes('Unable to resolve module')
    || /ENOENT: no such file or directory, open '.*\/apps\/ui\/sources\/.+\.(?:ts|tsx|js|jsx|mjs|cjs)'/i.test(params.stderrTail);

  if (message.includes('workspace build preflight timed out after')) {
    return 'workspace_preflight_timeout';
  }

  if (message.includes('shared CLI dist build lock is active:')) {
    return 'shared_cli_dist_build_lock_active';
  }

  if (message.includes('expo export startup stalled after')) {
    return metroStarted
      ? 'startup_stalled_after_metro_startup_no_staging_progress'
      : 'startup_stalled_before_metro_startup';
  }

  if (!message.includes('expo export timed out after')) {
    if (stderrLooksLikeUnresolvedModuleImport) {
      return 'expo_export_unresolved_module_import';
    }
    const snapshot = await readUiWebExportFailureSnapshot(params.stagingDir);
    if (snapshot.fileCount > 0 && snapshot.publishPhaseFileCount < REQUIRED_UI_WEB_EXPORT_FILES.length) {
      return 'expo_export_frozen_partial_output';
    }
    return null;
  }

  const snapshot = await readUiWebExportFailureSnapshot(params.stagingDir);
  if (snapshot.publishPhaseFileCount >= REQUIRED_UI_WEB_EXPORT_FILES.length) {
    return 'timed_out_after_metro_publish_phase_output_present';
  }
  if (snapshot.fileCount > 0) {
    return 'timed_out_after_metro_partial_staging';
  }
  if (!metroStarted) {
    return 'timed_out_before_metro_startup';
  }
  return 'timed_out_after_metro_no_staging_output';
}

async function assertCompleteUiWebExportDir(distDir: string): Promise<void> {
  const missingFiles: string[] = [];
  for (const fileName of REQUIRED_UI_WEB_EXPORT_FILES) {
    try {
      await stat(resolvePath(distDir, fileName));
    } catch {
      missingFiles.push(fileName);
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(`UI web export incomplete: missing publish-required files ${missingFiles.join(', ')} in ${distDir}`);
  }
}

function canReusePersistedUiWebExport(
  params: { distDir: string; cacheKeyPath: string; cacheKey: string; manifestPath: string },
): boolean {
  if (!existsSync(resolvePath(params.distDir, 'index.html'))) return false;
  if (!existsSync(resolvePath(params.distDir, 'metadata.json'))) return false;
  if (!hasPersistedUiWebExportManifest(params.manifestPath)) return false;
  return readPersistedUiWebExportCacheKey(params.cacheKeyPath) === params.cacheKey;
}

async function findReusableUiWebExportRoot(params: {
  rootDir: string;
  cacheKey: string;
  excludeRootDirs?: readonly string[];
  excludeAutoDerivedNamespaces?: boolean;
}): Promise<string | null> {
  const excludedRoots = new Set(
    (params.excludeRootDirs ?? [])
      .map((rootDir) => rootDir.trim())
      .filter((rootDir) => rootDir.length > 0),
  );

  const candidateRoots = new Set<string>();
  if (!excludedRoots.has(params.rootDir)) {
    candidateRoots.add(params.rootDir);
  }

  const entries = await readdir(params.rootDir, { withFileTypes: true, encoding: 'utf8' }).catch(() => null);
  if (!entries) {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (params.excludeAutoDerivedNamespaces && entry.name.startsWith('auto-')) continue;
    candidateRoots.add(resolvePath(params.rootDir, entry.name));
  }

  for (const candidateRoot of candidateRoots) {
    if (excludedRoots.has(candidateRoot)) continue;
    if (canReusePersistedUiWebExport({
      distDir: resolvePath(candidateRoot, 'dist'),
      cacheKeyPath: resolvePath(candidateRoot, 'cache-key.json'),
      cacheKey: params.cacheKey,
      manifestPath: resolvePath(candidateRoot, 'export-manifest.json'),
    })) {
      return candidateRoot;
    }
  }

  return null;
}

async function ensureUiWebExportBuilt(params: { testDir: string; env: NodeJS.ProcessEnv }): Promise<string> {
  const cacheKey = buildUiWebExportCacheKey(params.env);
  const clearRaw = (params.env.HAPPIER_E2E_EXPO_CLEAR ?? '').toString().trim().toLowerCase();
  let clearCache = clearRaw === '1' || clearRaw === 'true' || clearRaw === 'yes' || clearRaw === 'y';
  const explicitNamespace = hasExplicitUiWebExportNamespace(params.env);
  const sharedDefaultRoot = explicitNamespace ? null : resolveUiWebExportRootDir(params.env);
  const canonicalSharedRoot = resolveUiWebExportRootDir();
  const exportedDistParent = resolveUiWebExportRootDirForParams({
    ...params,
    cacheKey,
  });
  const exportedDistDir = resolvePath(exportedDistParent, 'dist');
  const exportedDistLockPath = resolvePath(exportedDistParent, 'build.lock');
  const exportedDistCacheKeyPath = resolvePath(exportedDistParent, 'cache-key.json');
  const exportedDistManifestPath = resolvePath(exportedDistParent, 'export-manifest.json');

  if (!clearCache && explicitNamespace && canonicalSharedRoot !== exportedDistParent && canReusePersistedUiWebExport({
    distDir: resolvePath(canonicalSharedRoot, 'dist'),
    cacheKeyPath: resolvePath(canonicalSharedRoot, 'cache-key.json'),
    cacheKey,
    manifestPath: resolvePath(canonicalSharedRoot, 'export-manifest.json'),
  })) {
    const reusableDistDir = resolvePath(canonicalSharedRoot, 'dist');
    sharedExportDir = reusableDistDir;
    sharedExportCacheKey = cacheKey;
    sharedExportRootDir = canonicalSharedRoot;
    return reusableDistDir;
  }

  if (!clearCache && sharedDefaultRoot && sharedDefaultRoot !== exportedDistParent) {
    const reusableRootDir = await findReusableUiWebExportRoot({
      rootDir: sharedDefaultRoot,
      cacheKey,
      excludeRootDirs: [exportedDistParent],
      excludeAutoDerivedNamespaces: true,
    });
    if (reusableRootDir) {
      const reusableDistDir = resolvePath(reusableRootDir, 'dist');
      sharedExportDir = reusableDistDir;
      sharedExportCacheKey = cacheKey;
      sharedExportRootDir = reusableRootDir;
      return reusableDistDir;
    }
  }

  if (!clearCache) {
    if (sharedExportDir && sharedExportCacheKey === cacheKey && sharedExportRootDir === exportedDistParent) {
      return sharedExportDir;
    }
    if (sharedExportPromise && sharedExportCacheKey === cacheKey && sharedExportRootDir === exportedDistParent) {
      return await sharedExportPromise;
    }
  }
  if (canReusePersistedUiWebExport({
    distDir: exportedDistDir,
    cacheKeyPath: exportedDistCacheKeyPath,
    cacheKey,
    manifestPath: exportedDistManifestPath,
  }) && !clearCache) {
    sharedExportDir = exportedDistDir;
    sharedExportCacheKey = cacheKey;
    sharedExportRootDir = exportedDistParent;
    return exportedDistDir;
  }

  const workspaceRootDir = resolvePath(repoRootDir(), 'apps', 'ui');
  try {
    await ensureUiWebWorkspacePrebuild({
      testDir: params.testDir,
      env: params.env,
      workspaceRootDir,
      logPrefix: 'ui-web-export',
      timeoutMs: resolveUiWebExportWorkspacePrebuildTimeoutMs(params.env),
      stdoutPath: resolvePath(params.testDir, 'ui.web.export.stdout.log'),
      stderrPath: resolvePath(params.testDir, 'ui.web.export.stderr.log'),
    });
  } catch (error) {
    const stdoutTail = await readFile(resolvePath(params.testDir, 'ui.web.export.stdout.log'), 'utf8').catch(() => '');
    const stderrTail = await readFile(resolvePath(params.testDir, 'ui.web.export.stderr.log'), 'utf8').catch(() => '');
    const safeStdoutTail = redactHarnessLogText(stdoutTail);
    const safeStderrTail = redactHarnessLogText(stderrTail);
    const classification = isUiWebWorkspacePrebuildTimeoutError(error)
      ? 'workspace_preflight_timeout'
      : isUiWebWorkspacePrebuildSharedCliDistBuildLockActiveError(error)
        ? 'shared_cli_dist_build_lock_active'
        : null;
    const tailLimit = 8_000;
    throw new Error([
      error instanceof Error ? error.message : String(error),
      classification ? `classification=${classification}` : null,
      `stdoutTail=${JSON.stringify(safeStdoutTail.slice(Math.max(0, safeStdoutTail.length - tailLimit)))}`,
      `stderrTail=${JSON.stringify(safeStderrTail.slice(Math.max(0, safeStderrTail.length - tailLimit)))}`,
    ].filter(Boolean).join(' | '));
  }

  const buildPromise = withUiWebExportLock(exportedDistLockPath, async (lockLease) => {
    const stagingDir = resolvePath(exportedDistParent, `dist-staging-${process.pid}-${Date.now()}`);
    const stdoutPath = resolvePath(params.testDir, 'ui.web.export.stdout.log');
    const stderrPath = resolvePath(params.testDir, 'ui.web.export.stderr.log');

    await mkdir(params.testDir, { recursive: true });
    await mkdir(exportedDistParent, { recursive: true });
    await removePathWithRetries(stagingDir).catch(() => {});
    writeUiWebExportLockOwnerMetadata(lockLease, stagingDir);

    for (;;) {
      try {
        const exportEnv = buildExportEnv(params.env);
        const shouldPinMetroPort = !exportEnv.RCT_METRO_PORT && !exportEnv.EXPO_METRO_PORT && !exportEnv.METRO_PORT;
        const metroPort = shouldPinMetroPort ? await reserveAvailablePort() : null;
        const pinnedExportEnv = shouldPinMetroPort && metroPort != null
          ? {
            ...exportEnv,
            RCT_METRO_PORT: String(metroPort),
            EXPO_METRO_PORT: String(metroPort),
            METRO_PORT: String(metroPort),
          }
          : exportEnv;

        const runExportBuildAttempt = async (forceClear: boolean): Promise<void> => {
          const buildTimeoutMs = resolveUiWebExportBuildTimeoutMs(params.env);
          const buildHardTimeoutMs = resolveUiWebExportHardTimeoutMs(params.env) ?? buildTimeoutMs;
          let buildTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
          const abortController = new AbortController();
          const startupStallGuard = createUiWebExportStartupStallGuard({
            stdoutPath,
            stderrPath,
            stagingDir,
            env: params.env,
            abortController,
          });
          let timedOut = false;
          const buildTimeoutError = new Error(`expo export timed out after ${buildHardTimeoutMs}ms`);
          const buildTimeoutPromise = new Promise<never>((_, reject) => {
            buildTimeoutTimer = setTimeout(() => {
              timedOut = true;
              if (!abortController.signal.aborted) {
                abortController.abort(buildTimeoutError);
              }
              reject(buildTimeoutError);
            }, buildHardTimeoutMs);
            if (typeof buildTimeoutTimer === 'object' && buildTimeoutTimer !== null && 'unref' in buildTimeoutTimer) {
              buildTimeoutTimer.unref();
            }
          });
          const expoCliEntrypoint = resolveExpoCliEntrypoint(workspaceRootDir);
          if (!existsSync(expoCliEntrypoint)) {
            throw new Error(
              `expo CLI entrypoint not found at ${expoCliEntrypoint}. ` +
                `Fix: ensure apps/ui dependencies are installed (the expo package must exist under apps/ui/node_modules).`,
            );
          }

          const runPromise = runLoggedCommand({
            // Avoid `yarn expo ...` resolution: some installs omit workspace `.bin` shims, causing
            // "Command \"expo\" not found" even though `apps/ui/node_modules/expo` exists.
            command: process.execPath,
            args: [
              expoCliEntrypoint,
              'export',
              '--non-interactive',
              '--platform',
              'web',
              '--output-dir',
              stagingDir,
              ...(resolveUiWebExportDev(params.env) ? ['--dev'] : []),
              ...(resolveUiWebExportNoMinify(params.env) ? ['--no-minify'] : []),
              ...(() => {
                const mode = resolveUiWebExportSourceMapsMode(params.env);
                return mode ? ['--source-maps', mode] : [];
              })(),
              ...((clearCache || forceClear) ? ['--clear'] : []),
            ],
            cwd: workspaceRootDir,
            env: pinnedExportEnv,
            stdoutPath,
            stderrPath,
            timeoutMs: buildHardTimeoutMs,
            abortSignal: abortController.signal,
          });

        try {
          await Promise.race([runPromise, startupStallGuard.promise, buildTimeoutPromise]);
          await runPromise;
        } catch (error) {
          if (!abortController.signal.aborted) {
            abortController.abort(error);
          }
          if (!timedOut && !isUiWebExportMetroCacheCorruptionError(error)) {
            await waitForUiWebExportRunPromiseAfterAbort({
              runPromise,
              error,
              env: params.env,
              stagingDir,
            });
          }
          throw error;
        } finally {
          if (buildTimeoutTimer != null) {
            clearTimeout(buildTimeoutTimer);
            buildTimeoutTimer = null;
          }
          startupStallGuard.stop();
        }
        };

        try {
          await runExportBuildAttempt(false);
        } catch (error) {
          const stderrTail = await readFile(stderrPath, 'utf8').catch(() => '');
          if (!clearCache && stderrHasUiWebExportMetroCacheCorruption(stderrTail)) {
            clearCache = true;
            await removePathWithRetries(stagingDir).catch(() => {});
            await writeFile(stdoutPath, '', 'utf8').catch(() => {});
            await writeFile(stderrPath, '', 'utf8').catch(() => {});
            await runExportBuildAttempt(true);
          } else if (!clearCache && isTransientUiWebExportMetroCleanupError(error)) {
            clearCache = true;
            await removePathWithRetries(stagingDir).catch(() => {});
            await writeFile(stdoutPath, '', 'utf8').catch(() => {});
            await writeFile(stderrPath, '', 'utf8').catch(() => {});
            await runExportBuildAttempt(true);
          } else {
            throw error;
          }
        }

      await assertCompleteUiWebExportDir(stagingDir);
      await removePathWithRetries(exportedDistDir).catch(() => {});
      await rename(stagingDir, exportedDistDir);
      writePersistedUiWebExportCacheKey(exportedDistCacheKeyPath, cacheKey);
      writePersistedUiWebExportManifest(exportedDistManifestPath);
      return exportedDistDir;
    } catch (error) {
      const stdoutTail = await readFile(stdoutPath, 'utf8').catch(() => '');
      const stderrTail = await readFile(stderrPath, 'utf8').catch(() => '');
      const safeStdoutTail = redactHarnessLogText(stdoutTail);
      const safeStderrTail = redactHarnessLogText(stderrTail);
      if (!clearCache && stderrTail.includes('Unable to deserialize cloned data')) {
        clearCache = true;
        await removePathWithRetries(stagingDir).catch(() => {});
        continue;
      }
      const classification = isUiWebWorkspacePrebuildTimeoutError(error)
        ? 'workspace_preflight_timeout'
        : await classifyUiWebExportFailure({
          error,
          stdoutTail,
          stderrTail,
          stagingDir,
        });
      const tailLimit = 8_000;
      throw new Error([
        error instanceof Error ? error.message : String(error),
        classification ? `classification=${classification}` : null,
        `stdoutTail=${JSON.stringify(safeStdoutTail.slice(Math.max(0, safeStdoutTail.length - tailLimit)))}`,
        `stderrTail=${JSON.stringify(safeStderrTail.slice(Math.max(0, safeStderrTail.length - tailLimit)))}`,
      ].filter(Boolean).join(' | '));
    } finally {
      await removePathWithRetries(stagingDir).catch(() => {});
    }
  }
  }, {
        timeoutMs: resolveUiWebExportLockTimeoutMs(params.env),
        staleAfterMs: resolveUiWebExportBuildTimeoutMs(params.env),
      });
  sharedExportPromise = buildPromise;
  sharedExportCacheKey = cacheKey;
  sharedExportRootDir = exportedDistParent;

  try {
    const builtDir = await buildPromise;
    if (sharedExportPromise === buildPromise) {
      sharedExportDir = builtDir;
      sharedExportCacheKey = cacheKey;
      sharedExportRootDir = exportedDistParent;
    }
    return builtDir;
  } catch (error) {
    if (!clearCache && !explicitNamespace) {
      const fallbackRootDir = await findReusableUiWebExportRoot({
        rootDir: resolveUiWebExportRootDir(params.env),
        cacheKey,
        excludeRootDirs: [exportedDistParent],
      });
      if (fallbackRootDir) {
        const fallbackDistDir = resolvePath(fallbackRootDir, 'dist');
        sharedExportDir = fallbackDistDir;
        sharedExportCacheKey = cacheKey;
        sharedExportRootDir = fallbackRootDir;
        return fallbackDistDir;
      }
    }
    throw error;
  } finally {
    if (sharedExportPromise === buildPromise) {
      sharedExportPromise = null;
    }
  }
}

function mimeTypeFor(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.map': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function escapeInlineScriptJson(value: string): string {
  return value.replace(/</g, '\\u003c');
}

function buildBootstrapScript(config: UiWebRuntimeConfig): string {
  const runtimeConfigJson = escapeInlineScriptJson(JSON.stringify(config.serverUrl ? { serverUrl: config.serverUrl } : {}));
  const syncTuningJsonLiteral = config.syncTuningJson ? escapeInlineScriptJson(JSON.stringify(config.syncTuningJson)) : 'null';
  return [
    '<script>',
    '(function(){',
    `window.__HAPPIER_WEB_RUNTIME_CONFIG__=${runtimeConfigJson};`,
    `var syncTuningJson=${syncTuningJsonLiteral};`,
    "try {",
    "  if (syncTuningJson) window.localStorage.setItem('HAPPIER_SYNC_TUNING_JSON', syncTuningJson);",
    "  else window.localStorage.removeItem('HAPPIER_SYNC_TUNING_JSON');",
    '} catch {}',
    '})();',
    '</script>',
  ].join('');
}

function injectBootstrap(html: string, config: UiWebRuntimeConfig): string {
  const bootstrap = buildBootstrapScript(config);
  const headCloseIndex = html.toLowerCase().indexOf('</head>');
  if (headCloseIndex >= 0) {
    return `${html.slice(0, headCloseIndex)}${bootstrap}${html.slice(headCloseIndex)}`;
  }
  return `${bootstrap}${html}`;
}

function resolveRequestFilePath(distDir: string, pathname: string): { filePath: string; isHtmlShell: boolean } {
  const normalizedPath = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolvePath(distDir, `.${normalizedPath}`);
  const isWithinDist = candidate === distDir || candidate.startsWith(`${distDir}/`);
  if (isWithinDist && existsSync(candidate)) {
    return { filePath: candidate, isHtmlShell: candidate.endsWith('index.html') };
  }
  if (extname(normalizedPath)) {
    return { filePath: candidate, isHtmlShell: false };
  }
  return { filePath: resolvePath(distDir, 'index.html'), isHtmlShell: true };
}

async function startStaticUiServer(params: {
  testDir: string;
  distDir: string;
  port?: number;
  runtimeConfig: UiWebRuntimeConfig;
}): Promise<StartedUiWeb> {
  const port = typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0
    ? params.port
    : await reserveAvailablePort();
  const stdoutPath = resolvePath(params.testDir, 'ui.web.stdout.log');
  const stderrPath = resolvePath(params.testDir, 'ui.web.stderr.log');
  const indexHtml = await readFile(resolvePath(params.distDir, 'index.html'), 'utf8');

  const sockets = new Set<import('node:net').Socket>();
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }

      const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const { filePath, isHtmlShell } = resolveRequestFilePath(params.distDir, requestUrl.pathname);

      if (isHtmlShell) {
        const html = injectBootstrap(indexHtml, params.runtimeConfig);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        if (method === 'HEAD') {
          res.end();
          return;
        }
        res.end(html);
        return;
      }

      if (!existsSync(filePath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Not Found');
        return;
      }

      res.writeHead(200, {
        'content-type': mimeTypeFor(filePath),
        'cache-control': 'no-store',
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(filePath).pipe(res);
    } catch (error) {
      await appendFile(stderrPath, `[ui-web-export] request failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`).catch(() => {});
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  await appendFile(stdoutPath, `http://127.0.0.1:${port}\n`).catch(() => {});

  return {
    mode: 'export',
    baseUrl: `http://127.0.0.1:${port}`,
    proc: null,
    stop: async () => {
      await new Promise<void>((resolve) => {
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        }
        server.close(() => resolve());
      });
    },
  };
}

export async function startUiWebExport(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
  port?: number;
}): Promise<StartedUiWeb> {
  const distDir = await ensureUiWebExportBuilt(params);
  return await startStaticUiServer({
    testDir: params.testDir,
    distDir,
    port: params.port,
    runtimeConfig: buildRuntimeConfig(params.env),
  });
}

export async function startExistingUiWebExport(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
  distDir: string;
  port?: number;
}): Promise<StartedUiWeb> {
  const distDir = resolvePath(params.distDir);
  await assertCompleteUiWebExportDir(distDir);
  return await startStaticUiServer({
    testDir: params.testDir,
    distDir,
    port: params.port,
    runtimeConfig: buildRuntimeConfig(params.env),
  });
}
