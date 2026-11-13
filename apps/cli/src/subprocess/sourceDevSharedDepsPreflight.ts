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
import { assertSourceRuntimeDependenciesCurrent, SourceRuntimeReloadRequiredError } from '@happier-dev/cli-common/sourceRuntimeEntries';
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

export type SourceDevSharedDepsPreflightResult =
  | { type: 'ready'; checked: false; reason: 'not-source-entrypoint' }
  | { type: 'ready'; checked: false; reason: 'not-source-dev' }
  | { type: 'ready'; checked: true; reason: 'source-imports' | 'admitted-copy' }
  | { type: 'error'; errorMessage: string; code?: SourceRuntimeReloadRequiredError['code']; subtype?: SourceRuntimeReloadRequiredError['subtype'] };

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


/**
 * Admits a daemon-spawned CLI child before launch.
 *
 * A checkout source child resolves every first-party workspace import through
 * the workspace source hook (`resolveCliSourceRuntimeFlags`), which refuses
 * `dist` targets, so checkout workspace dists are not part of its runtime.
 * Its admission is the installed runtime dependency identity, plus the
 * integrity of an admitted flat copy when it runs from one.
 */
export async function prepareSourceDevSharedDepsForHappyCliSpawn(params: Readonly<{
  args: readonly string[];
  processEnv?: SourceDevSharedDepsProcessEnv;
  signal?: AbortSignal;
  launchOptions?: HappyCliSubprocessLaunchOptions;
  cliProjectPath?: string;
  resolveInvocation?: ResolveInvocation;
  workspaceNames?: readonly string[];
}>): Promise<SourceDevSharedDepsPreflightResult> {
  try {
    await assertSourceRuntimeDependenciesCurrent({
      entrypoint: (params.processEnv ?? process.env).HAPPIER_CLI_SUBPROCESS_ENTRYPOINT,
      env: params.processEnv ?? process.env,
      signal: params.signal,
    });
  } catch (error) {
    if (!(error instanceof SourceRuntimeReloadRequiredError)) throw error;
    return { type: 'error', code: error.code, subtype: error.subtype, errorMessage: error.message };
  }
  const resolveInvocation = params.resolveInvocation ?? buildHappyCliSubprocessInvocation;
  const invocation = resolveInvocation(Array.from(params.args), params.launchOptions);
  if (!isHappyCliSourceEntrypointInvocation(invocation)) {
    return { type: 'ready', checked: false, reason: 'not-source-entrypoint' };
  }

  const admittedSnapshot = inspectAdmittedSourceSnapshot({
    cliProjectPath: params.cliProjectPath ?? projectPath(),
    ...(params.workspaceNames && params.workspaceNames.length > 0
      ? { workspaceNames: params.workspaceNames }
      : {}),
  });
  if (admittedSnapshot.type === 'error') {
    return {
      type: 'error',
      errorMessage: `Source-dev CLI shared dependency admission failed before spawn: ${admittedSnapshot.message}`,
    };
  }
  if (admittedSnapshot.type === 'ready') {
    return { type: 'ready', checked: true, reason: 'admitted-copy' };
  }
  return { type: 'ready', checked: true, reason: 'source-imports' };
}

/** Bundled plugin loads from a retained flat copy verify that copy's admission. */
export async function prepareSourceDevSharedDepsForBundledPluginRuntimeLoad(params: Readonly<{
  packageName: string;
  workspaceNames?: readonly string[];
  cliProjectPath?: string;
}>): Promise<SourceDevSharedDepsPreflightResult> {
  const workspaceName = normalizeBundledWorkspaceNameFromPackageName(params.packageName);
  const admittedSnapshot = inspectAdmittedSourceSnapshot({
    cliProjectPath: params.cliProjectPath ?? projectPath(),
    ...(params.workspaceNames && params.workspaceNames.length > 0
      ? { workspaceNames: params.workspaceNames }
      : workspaceName
        ? { workspaceNames: [workspaceName] }
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
  return { type: 'ready', checked: false, reason: 'not-source-dev' };
}
