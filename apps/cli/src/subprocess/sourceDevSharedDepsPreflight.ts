import { spawn } from 'node:child_process';
import {
  existsSync as nodeExistsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  posix,
  relative,
  sep,
  win32,
} from 'node:path';

import { projectPath } from '@/projectPath';
import {
  buildHappyCliSubprocessInvocation,
  type HappyCliSubprocessInvocation,
  type HappyCliSubprocessLaunchOptions,
} from '@/utils/spawnHappyCLI';

type ResolveInvocation = (
  args: string[],
  launchOptions?: HappyCliSubprocessLaunchOptions,
) => HappyCliSubprocessInvocation;

type SourceDevSharedDepsProcessEnv = Readonly<Record<string, string | undefined>>;
type SourceDevSharedDepsProgress = Readonly<{
  stage: string;
  event?: string;
  detail?: string;
  workspaceName?: string;
  tsconfigPath?: string;
  elapsedMs?: number;
  lockTimeoutMs?: number;
}>;
type RunSyncProcess = (input: Readonly<{
  scriptPath: string;
  checkOnly?: boolean;
  timeoutMs: number;
  lockTimeoutMs: number;
  workspaceBuildTimeoutMs: number;
  progressIntervalMs: number;
  workspaceNames?: readonly string[];
  processEnv: SourceDevSharedDepsProcessEnv;
  onProgress: (progress: SourceDevSharedDepsProgress) => void;
}>) => Promise<void>;

const SOURCE_DEV_PREFLIGHT_PROCESS_TIMEOUT_MS = 300_000;
const SOURCE_DEV_PREFLIGHT_LOCK_TIMEOUT_MS = 240_000;
const SOURCE_DEV_PREFLIGHT_WORKSPACE_BUILD_TIMEOUT_MS = 60_000;
const SOURCE_DEV_PREFLIGHT_PROGRESS_INTERVAL_MS = 15_000;
const MAX_SOURCE_DEV_PREFLIGHT_OUTPUT_CHARS = 4_000;
const SOURCE_DEV_SHARED_DEPS_PROGRESS_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_PROGRESS';
const SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_MS';
const SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_MS';
const SOURCE_DEV_SHARED_DEPS_WORKSPACES_ENV = 'HAPPIER_SOURCE_DEV_SHARED_DEPS_WORKSPACES';
const SOURCE_DEV_SHARED_DEPS_PROGRESS_VALUE = 'json-v1';
const SOURCE_DEV_SHARED_DEPS_PROGRESS_PREFIX = '[happier-source-dev-shared-deps-progress] ';

export type SourceDevSharedDepsPreflightResult =
  | { type: 'ready'; checked: false; reason: 'not-source-entrypoint' }
  | { type: 'ready'; checked: false; reason: 'not-source-dev' }
  | { type: 'ready'; checked: true; reason: 'current' | 'synced' | 'admitted-copy' }
  | { type: 'error'; errorMessage: string };

function normalizePathSeparators(pathLike: string): string {
  return pathLike.replaceAll('\\', '/');
}

function isCliSourceEntrypointArg(arg: string): boolean {
  return normalizePathSeparators(arg).endsWith('/src/index.ts');
}

export function isHappyCliSourceEntrypointInvocation(invocation: HappyCliSubprocessInvocation): boolean {
  if (invocation.runtime !== 'node') return false;
  return invocation.argv.some((arg) => isCliSourceEntrypointArg(arg));
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendBoundedOutput(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  if (next.length <= MAX_SOURCE_DEV_PREFLIGHT_OUTPUT_CHARS) {
    return next;
  }
  return next.slice(next.length - MAX_SOURCE_DEV_PREFLIGHT_OUTPUT_CHARS);
}

function readProgressStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readProgressNumberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseSourceDevSharedDepsProgressLine(line: string): SourceDevSharedDepsProgress | null {
  if (!line.startsWith(SOURCE_DEV_SHARED_DEPS_PROGRESS_PREFIX)) return null;

  try {
    const parsed = JSON.parse(line.slice(SOURCE_DEV_SHARED_DEPS_PROGRESS_PREFIX.length)) as Record<string, unknown>;
    const stage = readProgressStringField(parsed.stage);
    if (!stage) return null;
    return {
      stage,
      event: readProgressStringField(parsed.event),
      detail: readProgressStringField(parsed.detail),
      workspaceName: readProgressStringField(parsed.workspaceName),
      tsconfigPath: readProgressStringField(parsed.tsconfigPath),
      elapsedMs: readProgressNumberField(parsed.elapsedMs),
      lockTimeoutMs: readProgressNumberField(parsed.lockTimeoutMs),
    };
  } catch {
    return null;
  }
}

function formatSourceDevSharedDepsProgressSummary(progress: SourceDevSharedDepsProgress | null): string {
  if (!progress) return 'none';
  const parts = [
    progress.stage,
    progress.event,
    progress.workspaceName,
    progress.detail,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  const suffix = progress.tsconfigPath ? ` (${progress.tsconfigPath})` : '';
  return `${parts.join(' ')}${suffix}`;
}

function formatSourceDevSharedDepsLastProgress(progress: SourceDevSharedDepsProgress | null): string {
  if (!progress) return '';
  return `last progress: ${formatSourceDevSharedDepsProgressSummary(progress)}`;
}

function appendLastProgressToErrorMessage(message: string, progress: SourceDevSharedDepsProgress | null): string {
  const lastProgress = formatSourceDevSharedDepsLastProgress(progress);
  if (!lastProgress || message.includes('last progress:')) return message;
  return `${message}; ${lastProgress}`;
}

function createProgressLineConsumer(onProgress: (progress: SourceDevSharedDepsProgress) => void): (chunk: unknown) => void {
  let buffered = '';
  return (chunk: unknown) => {
    buffered += String(chunk);
    if (buffered.length > MAX_SOURCE_DEV_PREFLIGHT_OUTPUT_CHARS) {
      buffered = buffered.slice(buffered.length - MAX_SOURCE_DEV_PREFLIGHT_OUTPUT_CHARS);
    }

    while (true) {
      const newlineIndex = buffered.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = buffered.slice(0, newlineIndex).trimEnd();
      buffered = buffered.slice(newlineIndex + 1);
      const progress = parseSourceDevSharedDepsProgressLine(line);
      if (progress) onProgress(progress);
    }
  };
}

function buildSourceDevSharedDepsProcessEnv(params: Readonly<{
  processEnv: SourceDevSharedDepsProcessEnv;
  lockTimeoutMs: number;
  workspaceBuildTimeoutMs: number;
  workspaceNames?: readonly string[];
}>): NodeJS.ProcessEnv {
  const workspaceNames = (params.workspaceNames ?? [])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean);
  return {
    ...params.processEnv,
    [SOURCE_DEV_SHARED_DEPS_PROGRESS_ENV]: SOURCE_DEV_SHARED_DEPS_PROGRESS_VALUE,
    [SOURCE_DEV_SHARED_DEPS_LOCK_TIMEOUT_ENV]: String(params.lockTimeoutMs),
    [SOURCE_DEV_SHARED_DEPS_WORKSPACE_BUILD_TIMEOUT_ENV]: String(params.workspaceBuildTimeoutMs),
    ...(workspaceNames.length > 0
      ? { [SOURCE_DEV_SHARED_DEPS_WORKSPACES_ENV]: workspaceNames.join(',') }
      : {}),
  } as NodeJS.ProcessEnv;
}

function formatSourceDevPreflightProcessError(params: Readonly<{
  scriptPath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}>): Error {
  const status = params.exitCode === null
    ? `signal ${params.signal ?? 'unknown'}`
    : `exit code ${params.exitCode}`;
  const output = params.output.trim();
  return new Error(
    output
      ? `source-dev shared-deps helper ${params.scriptPath} failed with ${status}: ${output}`
      : `source-dev shared-deps helper ${params.scriptPath} failed with ${status}`,
  );
}

async function runSourceDevSharedDepsSyncProcess(params: Readonly<{
  scriptPath: string;
  checkOnly?: boolean;
  timeoutMs: number;
  lockTimeoutMs: number;
  workspaceBuildTimeoutMs: number;
  progressIntervalMs: number;
  workspaceNames?: readonly string[];
  processEnv: SourceDevSharedDepsProcessEnv;
  onProgress: (progress: SourceDevSharedDepsProgress) => void;
}>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [params.scriptPath, ...(params.checkOnly ? ['--check'] : [])],
      {
        env: buildSourceDevSharedDepsProcessEnv({
          processEnv: params.processEnv,
          lockTimeoutMs: params.lockTimeoutMs,
          workspaceBuildTimeoutMs: params.workspaceBuildTimeoutMs,
          workspaceNames: params.workspaceNames,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    let lastProgress: SourceDevSharedDepsProgress | null = null;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const killChild = () => {
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5_000);
    };
    const consumeProgressLines = createProgressLineConsumer((progress) => {
      lastProgress = progress;
      params.onProgress(progress);
    });
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, params.timeoutMs);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      callback();
    };

    const consumeChildOutput = (chunk: unknown) => {
      output = appendBoundedOutput(output, chunk);
      consumeProgressLines(chunk);
    };
    child.stdout?.on('data', consumeChildOutput);
    child.stderr?.on('data', consumeChildOutput);
    child.once('error', (error) => {
      finish(() => reject(error));
    });
    child.once('close', (exitCode, signal) => {
      finish(() => {
        if (timedOut) {
          const outputTail = output.trim();
          const lastProgressMessage = formatSourceDevSharedDepsLastProgress(lastProgress);
          reject(new Error([
            `source-dev shared-deps helper ${params.scriptPath} timed out after ${params.timeoutMs}ms`,
            lastProgressMessage,
            outputTail ? `output tail: ${outputTail}` : '',
          ].filter(Boolean).join('; ')));
          return;
        }
        if (exitCode === 0) {
          resolve();
          return;
        }
        reject(formatSourceDevPreflightProcessError({
          scriptPath: params.scriptPath,
          exitCode,
          signal,
          output,
        }));
      });
    });
  });
}

async function runSourceDevSharedDepsSync(params: Readonly<{
  scriptPath: string;
  checkOnly?: boolean;
  runSyncProcess: RunSyncProcess;
  processEnv: SourceDevSharedDepsProcessEnv;
  timeoutMs: number;
  lockTimeoutMs: number;
  workspaceBuildTimeoutMs: number;
  progressIntervalMs: number;
  workspaceNames?: readonly string[];
  logDebug?: (message: string, payload?: unknown) => void;
  beforeLogMessage: string;
  afterLogMessage: string;
  errorPrefix: string;
  readyReason?: 'current' | 'synced';
}>): Promise<SourceDevSharedDepsPreflightResult> {
  const startedAtMs = Date.now();
  let lastProgress: SourceDevSharedDepsProgress | null = null;
  const logProgress = (progress: SourceDevSharedDepsProgress) => {
    lastProgress = progress;
    params.logDebug?.('[DAEMON RUN] Source-dev CLI shared deps preflight progress', {
      ...progress,
      elapsedMs: Date.now() - startedAtMs,
      timeoutMs: params.timeoutMs,
      lockTimeoutMs: params.lockTimeoutMs,
    });
  };
  const heartbeatTimer = params.progressIntervalMs > 0
    ? setInterval(() => {
      params.logDebug?.('[DAEMON RUN] Source-dev CLI shared deps preflight still running', {
      elapsedMs: Date.now() - startedAtMs,
      timeoutMs: params.timeoutMs,
      lockTimeoutMs: params.lockTimeoutMs,
      lastProgress,
    });
    }, params.progressIntervalMs)
    : null;
  heartbeatTimer?.unref();

  try {
    params.logDebug?.(params.beforeLogMessage);
    await params.runSyncProcess({
      scriptPath: params.scriptPath,
      ...(params.checkOnly ? { checkOnly: true } : {}),
      timeoutMs: params.timeoutMs,
      lockTimeoutMs: params.lockTimeoutMs,
      workspaceBuildTimeoutMs: params.workspaceBuildTimeoutMs,
      progressIntervalMs: params.progressIntervalMs,
      ...(params.workspaceNames && params.workspaceNames.length > 0
        ? { workspaceNames: params.workspaceNames }
        : {}),
      processEnv: params.processEnv,
      onProgress: logProgress,
    });
    params.logDebug?.(params.afterLogMessage);
    return {
      type: 'ready',
      checked: true,
      reason: params.readyReason ?? 'synced',
    };
  } catch (error) {
    const errorMessage = appendLastProgressToErrorMessage(formatErrorMessage(error), lastProgress);
    return {
      type: 'error',
      errorMessage: `${params.errorPrefix}: ${errorMessage}`,
    };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

function isTestProcessEnv(env: SourceDevSharedDepsProcessEnv): boolean {
  return env.VITEST !== undefined
    || env.VITEST_WORKER_ID !== undefined
    || env.NODE_ENV === 'test';
}

const SOURCE_SNAPSHOT_ADMISSION_FILE_NAME = '.cli-source-snapshot-admission.json';

type SourceSnapshotAdmissionOutput = Readonly<{
  path: string;
  size: number;
  mtimeMs: number;
}>;

type SourceSnapshotAdmissionPackage = Readonly<{
  dependencies: readonly string[];
  outputs: readonly SourceSnapshotAdmissionOutput[];
  dist: Readonly<{
    fileCount: number;
    totalBytes: number;
  }>;
}>;

type SourceSnapshotAdmissionInspection =
  | { type: 'absent' }
  | { type: 'ready' }
  | { type: 'error'; message: string };

function readSourceSnapshotAdmissionPackage(value: unknown): SourceSnapshotAdmissionPackage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.dependencies)
    || !Array.isArray(record.outputs)
    || !record.dist
    || typeof record.dist !== 'object'
    || Array.isArray(record.dist)
  ) {
    return null;
  }
  const dist = record.dist as Record<string, unknown>;
  if (
    typeof dist.fileCount !== 'number'
    || !Number.isSafeInteger(dist.fileCount)
    || Number(dist.fileCount) < 0
    || typeof dist.totalBytes !== 'number'
    || !Number.isSafeInteger(dist.totalBytes)
    || Number(dist.totalBytes) < 0
  ) {
    return null;
  }
  const dependencies = record.dependencies.filter(
    (dependency): dependency is string =>
      typeof dependency === 'string' && isSafeSnapshotWorkspaceName(dependency),
  );
  if (dependencies.length !== record.dependencies.length) return null;
  const outputs: SourceSnapshotAdmissionOutput[] = [];
  for (const output of record.outputs) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
    const outputRecord = output as Record<string, unknown>;
    if (
      typeof outputRecord.path !== 'string'
      || typeof outputRecord.size !== 'number'
      || !Number.isFinite(outputRecord.size)
      || typeof outputRecord.mtimeMs !== 'number'
      || !Number.isFinite(outputRecord.mtimeMs)
    ) {
      return null;
    }
    outputs.push({
      path: outputRecord.path,
      size: Number(outputRecord.size),
      mtimeMs: Number(outputRecord.mtimeMs),
    });
  }
  if (!outputs.some((output) => output.path === 'package.json')) return null;
  return {
    dependencies,
    outputs,
    dist: {
      fileCount: Number(dist.fileCount),
      totalBytes: Number(dist.totalBytes),
    },
  };
}

function normalizeSnapshotRequestedWorkspaceName(value: string): string | null {
  const raw = String(value ?? '').trim();
  const workspaceName = raw.startsWith('@happier-dev/')
    ? raw.slice('@happier-dev/'.length).trim()
    : raw;
  return isSafeSnapshotWorkspaceName(workspaceName) ? workspaceName : null;
}

function isSafeSnapshotWorkspaceName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function resolveContainedSnapshotOutputPath(packageDir: string, relativePath: string): string | null {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  const segments = normalizedPath.split('/');
  if (
    posix.isAbsolute(normalizedPath)
    || win32.isAbsolute(normalizedPath)
    || segments.length === 0
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }
  const outputPath = join(packageDir, ...segments);
  const containedRelativePath = relative(packageDir, outputPath);
  if (
    !containedRelativePath
    || containedRelativePath === '..'
    || containedRelativePath.startsWith(`..${sep}`)
    || isAbsolute(containedRelativePath)
  ) {
    return null;
  }
  return outputPath;
}

function isContainedPathFreeOfSymlinks(packageDir: string, outputPath: string): boolean {
  const containedRelativePath = relative(packageDir, outputPath);
  const segments = containedRelativePath.split(sep);
  let currentPath = packageDir;
  try {
    for (const segment of segments) {
      currentPath = join(currentPath, segment);
      if (lstatSync(currentPath).isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function inspectAdmittedSourceSnapshot(params: Readonly<{
  cliProjectPath: string;
  workspaceNames?: readonly string[];
}>): SourceSnapshotAdmissionInspection {
  const admissionPath = join(params.cliProjectPath, SOURCE_SNAPSHOT_ADMISSION_FILE_NAME);
  if (!nodeExistsSync(admissionPath)) return { type: 'absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(admissionPath, 'utf8'));
  } catch (error) {
    return {
      type: 'error',
      message: `admitted source snapshot record is unreadable: ${formatErrorMessage(error)}`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { type: 'error', message: 'admitted source snapshot record is malformed' };
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1
    || !record.packages
    || typeof record.packages !== 'object'
    || Array.isArray(record.packages)
  ) {
    return { type: 'error', message: 'admitted source snapshot record has an unsupported shape' };
  }

  const packageValues = record.packages as Record<string, unknown>;
  const packages = new Map<string, SourceSnapshotAdmissionPackage>();
  for (const [workspaceName, packageValue] of Object.entries(packageValues)) {
    const packageAdmission = readSourceSnapshotAdmissionPackage(packageValue);
    if (!isSafeSnapshotWorkspaceName(workspaceName) || !packageAdmission) {
      return { type: 'error', message: 'admitted source snapshot package record is malformed' };
    }
    packages.set(workspaceName, packageAdmission);
  }

  const requestedWorkspaceNames = (params.workspaceNames ?? [])
    .map((workspaceName) => normalizeSnapshotRequestedWorkspaceName(workspaceName))
    .filter((workspaceName): workspaceName is string => workspaceName !== null);
  const pending = requestedWorkspaceNames.length > 0
    ? [...new Set(requestedWorkspaceNames)]
    : [...packages.keys()];
  const visited = new Set<string>();
  for (const localClosureRoot of [
    join(params.cliProjectPath, 'node_modules'),
    join(params.cliProjectPath, 'node_modules', '@happier-dev'),
  ]) {
    try {
      const stats = lstatSync(localClosureRoot);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return {
          type: 'error',
          message: 'admitted source snapshot aliases live node_modules',
        };
      }
    } catch {
      return {
        type: 'error',
        message: 'admitted source snapshot is missing its local node_modules closure',
      };
    }
  }
  while (pending.length > 0) {
    const workspaceName = pending.pop() as string;
    if (visited.has(workspaceName)) continue;
    visited.add(workspaceName);
    const packageAdmission = packages.get(workspaceName);
    if (!packageAdmission) {
      return {
        type: 'error',
        message: `admitted source snapshot is missing requested workspace ${workspaceName}`,
      };
    }
    pending.push(...packageAdmission.dependencies);

    const packageDir = join(
      params.cliProjectPath,
      'node_modules',
      '@happier-dev',
      workspaceName,
    );
    try {
      if (lstatSync(packageDir).isSymbolicLink()) {
        return {
          type: 'error',
          message: `admitted source snapshot workspace ${workspaceName} aliases live node_modules`,
        };
      }
    } catch {
      return {
        type: 'error',
        message: `admitted source snapshot is missing requested workspace ${workspaceName}`,
      };
    }

    for (const output of packageAdmission.outputs) {
      const outputPath = resolveContainedSnapshotOutputPath(packageDir, output.path);
      if (!outputPath) {
        return {
          type: 'error',
          message: `admitted source snapshot workspace ${workspaceName} has an invalid output path`,
        };
      }
      try {
        if (!isContainedPathFreeOfSymlinks(packageDir, outputPath)) {
          throw new Error('output is a symlink');
        }
        const stats = statSync(outputPath);
        if (
          !stats.isFile()
          || stats.size !== output.size
          || stats.mtimeMs !== output.mtimeMs
        ) {
          throw new Error('output signature changed');
        }
      } catch {
        return {
          type: 'error',
          message: `admitted source snapshot workspace ${workspaceName} output is missing or corrupt: ${output.path}`,
        };
      }
    }

    let distFileCount = 0;
    let distTotalBytes = 0;
    const visitDist = (dir: string): boolean => {
      if (!nodeExistsSync(dir)) return true;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const entryPath = join(dir, entry.name);
          const stats = lstatSync(entryPath);
          if (stats.isSymbolicLink()) return false;
          if (stats.isDirectory()) {
            if (!visitDist(entryPath)) return false;
            continue;
          }
          if (!stats.isFile()) continue;
          distFileCount += 1;
          distTotalBytes += stats.size;
        }
        return true;
      } catch {
        return false;
      }
    };
    if (
      !visitDist(join(packageDir, 'dist'))
      || distFileCount !== packageAdmission.dist.fileCount
      || distTotalBytes !== packageAdmission.dist.totalBytes
    ) {
      return {
        type: 'error',
        message: `admitted source snapshot workspace ${workspaceName} dist output tree is missing or corrupt`,
      };
    }
  }

  return { type: 'ready' };
}

export function normalizeBundledWorkspaceNameFromPackageName(packageName: string): string | null {
  const raw = String(packageName ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('@happier-dev/')) {
    const workspaceName = raw.slice('@happier-dev/'.length).trim();
    return workspaceName.length > 0 ? workspaceName : null;
  }
  return raw.startsWith('plugins-') ? raw : null;
}

export async function prepareSourceDevSharedDepsForHappyCliSpawn(params: Readonly<{
  args: readonly string[];
  launchOptions?: HappyCliSubprocessLaunchOptions;
  logDebug?: (message: string, payload?: unknown) => void;
  cliProjectPath?: string;
  existsSync?: (path: string) => boolean;
  resolveInvocation?: ResolveInvocation;
  runSyncProcess?: RunSyncProcess;
  timeoutMs?: number;
  lockTimeoutMs?: number;
  workspaceBuildTimeoutMs?: number;
  progressIntervalMs?: number;
  workspaceNames?: readonly string[];
}>): Promise<SourceDevSharedDepsPreflightResult> {
  const resolveInvocation = params.resolveInvocation ?? buildHappyCliSubprocessInvocation;
  const invocation = resolveInvocation(Array.from(params.args), params.launchOptions);
  if (!isHappyCliSourceEntrypointInvocation(invocation)) {
    return { type: 'ready', checked: false, reason: 'not-source-entrypoint' };
  }

  const cliProjectPath = params.cliProjectPath ?? projectPath();
  const scriptPath = join(cliProjectPath, 'scripts', 'syncSharedDepsForDev.mjs');
  const exists = params.existsSync ?? nodeExistsSync;
  const runSyncProcess = params.runSyncProcess ?? runSourceDevSharedDepsSyncProcess;

  try {
    const admittedSnapshot = inspectAdmittedSourceSnapshot({
      cliProjectPath,
      ...(params.workspaceNames && params.workspaceNames.length > 0
        ? { workspaceNames: params.workspaceNames }
        : {}),
    });
    if (admittedSnapshot.type === 'error') {
      throw new Error(admittedSnapshot.message);
    }
    if (admittedSnapshot.type === 'ready') {
      return { type: 'ready', checked: true, reason: 'admitted-copy' };
    }

    if (!exists(scriptPath)) {
      throw new Error('source-dev shared-deps helper is missing from apps/cli/scripts/syncSharedDepsForDev.mjs');
    }

    return await runSourceDevSharedDepsSync({
      scriptPath,
      checkOnly: true,
      runSyncProcess,
      processEnv: process.env,
      timeoutMs: params.timeoutMs ?? SOURCE_DEV_PREFLIGHT_PROCESS_TIMEOUT_MS,
      lockTimeoutMs: params.lockTimeoutMs ?? SOURCE_DEV_PREFLIGHT_LOCK_TIMEOUT_MS,
      workspaceBuildTimeoutMs: params.workspaceBuildTimeoutMs ?? SOURCE_DEV_PREFLIGHT_WORKSPACE_BUILD_TIMEOUT_MS,
      progressIntervalMs: params.progressIntervalMs ?? SOURCE_DEV_PREFLIGHT_PROGRESS_INTERVAL_MS,
      ...(params.workspaceNames && params.workspaceNames.length > 0
        ? { workspaceNames: params.workspaceNames }
        : {}),
      logDebug: params.logDebug,
      beforeLogMessage: '[DAEMON RUN] Checking source-dev CLI shared deps before source child spawn',
      afterLogMessage: '[DAEMON RUN] Source-dev CLI shared deps admission completed',
      errorPrefix: 'Source-dev CLI shared dependency admission failed before spawn',
      readyReason: 'current',
    });
  } catch (error) {
    return {
      type: 'error',
      errorMessage: `Source-dev CLI shared dependency admission failed before spawn: ${formatErrorMessage(error)}`,
    };
  }
}

export async function prepareSourceDevSharedDepsForBundledPluginRuntimeLoad(params: Readonly<{
  packageName: string;
  workspaceNames?: readonly string[];
  admittedCopyOnly?: boolean;
  logDebug?: (message: string, payload?: unknown) => void;
  cliProjectPath?: string;
  existsSync?: (path: string) => boolean;
  runSyncProcess?: RunSyncProcess;
  processEnv?: SourceDevSharedDepsProcessEnv;
  timeoutMs?: number;
  lockTimeoutMs?: number;
  workspaceBuildTimeoutMs?: number;
  progressIntervalMs?: number;
}>): Promise<SourceDevSharedDepsPreflightResult> {
  const cliProjectPath = params.cliProjectPath ?? projectPath();
  const scriptPath = join(cliProjectPath, 'scripts', 'syncSharedDepsForDev.mjs');
  const exists = params.existsSync ?? nodeExistsSync;
  const admittedSnapshot = inspectAdmittedSourceSnapshot({
    cliProjectPath,
    ...(params.workspaceNames && params.workspaceNames.length > 0
      ? { workspaceNames: params.workspaceNames }
      : normalizeBundledWorkspaceNameFromPackageName(params.packageName)
        ? { workspaceNames: [normalizeBundledWorkspaceNameFromPackageName(params.packageName) as string] }
        : {}),
  });
  if (admittedSnapshot.type === 'error') {
    return {
      type: 'error',
      errorMessage: `Source-dev CLI shared dependency preflight failed before loading bundled plugin ${params.packageName}: ${admittedSnapshot.message}`,
    };
  }
  if (admittedSnapshot.type === 'ready') {
    return { type: 'ready', checked: true, reason: 'admitted-copy' };
  }
  if (params.admittedCopyOnly || isTestProcessEnv(params.processEnv ?? process.env)) {
    return { type: 'ready', checked: false, reason: 'not-source-dev' };
  }
  if (!exists(scriptPath)) {
    return { type: 'ready', checked: false, reason: 'not-source-dev' };
  }

  return await runSourceDevSharedDepsSync({
    scriptPath,
    runSyncProcess: params.runSyncProcess ?? runSourceDevSharedDepsSyncProcess,
    processEnv: params.processEnv ?? process.env,
    timeoutMs: params.timeoutMs ?? SOURCE_DEV_PREFLIGHT_PROCESS_TIMEOUT_MS,
    lockTimeoutMs: params.lockTimeoutMs ?? SOURCE_DEV_PREFLIGHT_LOCK_TIMEOUT_MS,
    workspaceBuildTimeoutMs: params.workspaceBuildTimeoutMs ?? SOURCE_DEV_PREFLIGHT_WORKSPACE_BUILD_TIMEOUT_MS,
    progressIntervalMs: params.progressIntervalMs ?? SOURCE_DEV_PREFLIGHT_PROGRESS_INTERVAL_MS,
    ...(params.workspaceNames && params.workspaceNames.length > 0
      ? { workspaceNames: params.workspaceNames }
      : normalizeBundledWorkspaceNameFromPackageName(params.packageName)
        ? { workspaceNames: [normalizeBundledWorkspaceNameFromPackageName(params.packageName) as string] }
      : {}),
    logDebug: params.logDebug,
    beforeLogMessage: '[PLUGIN RUNTIME] Refreshing source-dev CLI shared deps before bundled plugin runtime load',
    afterLogMessage: '[PLUGIN RUNTIME] Source-dev CLI shared deps preflight completed',
    errorPrefix: `Source-dev CLI shared dependency preflight failed before loading bundled plugin ${params.packageName}`,
  });
}
