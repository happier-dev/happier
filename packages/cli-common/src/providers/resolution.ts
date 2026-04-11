import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import {
  getProviderCliRuntimeSpec,
  type AgentId,
  type ProviderCliManagedInstallSpec,
  type ProviderCliSourcePreference,
} from '@happier-dev/agents';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { expandHomeDirPath } from '../path/expandHomeDirPath.js';
import { resolveWindowsCommandOnPath, resolveWindowsCommandPath } from '../process/index.js';
import {
  resolveExplicitJavaScriptRuntimeCommand,
  resolveJavaScriptRuntimeCommand,
} from './managedJavaScriptRuntime.js';
import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';

export type ProviderCliResolutionSource = 'override' | 'system' | 'managed';

export type ProviderCliCommandResolution = Readonly<{
  source: ProviderCliResolutionSource;
  command: string;
}>;

type RuntimeResolutionOptions = Readonly<{
  isBunRuntime?: boolean;
  currentExecPath?: string | null;
}>;

export type ProviderCliJavaScriptRuntimeKind = 'none' | 'node' | 'bun';

const PROVIDER_CLI_SOURCE_OVERRIDE_FILE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;
const PROVIDER_CLI_SHEBANG_RUNTIME_FILE_EXTENSIONS = /\.(?:[cm]?tsx?|jsx)$/i;

function readBackendCliSourcePreferenceMap(processEnv: NodeJS.ProcessEnv): Partial<Record<AgentId, ProviderCliSourcePreference>> {
  const raw = typeof processEnv.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON === 'string'
    ? processEnv.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON.trim()
    : '';
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value === 'system-first' || value === 'managed-first'),
    ) as Partial<Record<AgentId, ProviderCliSourcePreference>>;
  } catch {
    return {};
  }
}

export function readBackendCliSourcePreference(
  agentId: AgentId,
  processEnv: NodeJS.ProcessEnv = process.env,
): ProviderCliSourcePreference {
  const preferences = readBackendCliSourcePreferenceMap(processEnv);
  const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId });
  return preferences[targetKey as AgentId] ?? preferences[agentId] ?? getProviderCliRuntimeSpec(agentId).sourcePreferenceDefault;
}

function resolveManagedCommandBasename(spec: ProviderCliManagedInstallSpec): string {
  if (process.platform !== 'win32') return spec.binaryName;
  return spec.kind === 'github_release_binary' ? `${spec.binaryName}.exe` : `${spec.binaryName}.cmd`;
}

export function readProviderCliOverride(agentId: AgentId, processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const envKey = `HAPPIER_${agentId.toUpperCase()}_PATH`;
  const override = expandHomeDirPath(
    typeof processEnv[envKey] === 'string' ? String(processEnv[envKey]).trim() : '',
    processEnv,
  );
  return override || null;
}

function providerCliCandidatePathExists(agentId: AgentId, candidatePath: string): boolean {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(candidatePath, accessMode);
    return true;
  } catch {
    if (!runtimeSpec.acceptsJavaScriptFileOverride || process.platform === 'win32') return false;
    if (!PROVIDER_CLI_SOURCE_OVERRIDE_FILE_EXTENSIONS.test(candidatePath)) return false;
    try {
      accessSync(candidatePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function resolveProviderCliOverride(agentId: AgentId, processEnv: NodeJS.ProcessEnv): string | null {
  const override = readProviderCliOverride(agentId, processEnv);
  if (!override) return null;
  if (process.platform === 'win32') {
    const normalizedOverride =
      (override.includes('/') || override.includes('\\') || override.includes(':'))
        ? resolveWindowsCommandPath(override, processEnv)
        : resolveWindowsCommandOnPath(override, processEnv);
    if (normalizedOverride) return normalizedOverride;
  }
  return providerCliCandidatePathExists(agentId, override) ? override : null;
}

export function resolveProviderCliManagedCommandPath(
  agentId: AgentId,
  opts: Readonly<{ happyHomeDir?: string | null; processEnv?: NodeJS.ProcessEnv }> = {},
): string {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  const managedInstall = runtimeSpec.managedInstall;
  if (!managedInstall) {
    throw new Error(`Provider ${agentId} does not define a managed CLI install path`);
  }
  const processEnv = opts.processEnv ?? process.env;
  const happyHomeDir = typeof opts.happyHomeDir === 'string' && opts.happyHomeDir.trim().length > 0
    ? opts.happyHomeDir.trim()
    : resolveHappyHomeDirFromEnvironment(processEnv);
  return join(happyHomeDir, 'tools', 'providers', agentId, 'current', 'bin', resolveManagedCommandBasename(managedInstall));
}

function resolveCommandOnPath(command: string, processEnv: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath(command, processEnv) ?? null;
  }

  const pathDirs = String(processEnv.PATH ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, command);
    if (!existsSync(candidate)) continue;
    // On Unix, verify the file is executable
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // File exists but is not executable; continue searching
      continue;
    }
  }
  return null;
}

function readFileHeader(candidatePath: string): string | null {
  try {
    return readFileSync(candidatePath, 'utf8').slice(0, 512);
  } catch {
    return null;
  }
}

function resolveUnixScriptRuntimeKind(candidatePath: string): ProviderCliJavaScriptRuntimeKind {
  const header = readFileHeader(candidatePath);
  if (!header?.startsWith('#!')) return 'none';
  const firstLine = header.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) return 'none';
  if (/(?:^#!.*\b(?:env(?:\s+-S)?\s+)?)\bnode(?:\s|$)/i.test(firstLine)) {
    return 'node';
  }
  if (/(?:^#!.*\b(?:env(?:\s+-S)?\s+)?)\bbun(?:\s|$)/i.test(firstLine)) {
    return 'bun';
  }
  return 'none';
}

export function resolveProviderCliJavaScriptRuntimeKind(candidatePath: string): ProviderCliJavaScriptRuntimeKind {
  if (/\.(?:c?js|mjs)$/i.test(candidatePath)) {
    return 'node';
  }

  if (PROVIDER_CLI_SHEBANG_RUNTIME_FILE_EXTENSIONS.test(candidatePath)) {
    return resolveUnixScriptRuntimeKind(candidatePath);
  }

  if (process.platform === 'win32') {
    return 'none';
  }

  return resolveUnixScriptRuntimeKind(candidatePath);
}

export function providerCliPathRequiresJavaScriptRuntime(candidatePath: string): boolean {
  return resolveProviderCliJavaScriptRuntimeKind(candidatePath) !== 'none';
}

function resolveBunRuntimeCommand(
  commandPath: string,
  processEnv: NodeJS.ProcessEnv,
  runtimeOptions: RuntimeResolutionOptions,
): string | null {
  const explicitRuntime = resolveExplicitJavaScriptRuntimeCommand(processEnv);
  if (explicitRuntime) {
    const normalized = process.platform === 'win32'
      ? explicitRuntime.toLowerCase()
      : explicitRuntime;
    if (/(^|[\\/])bun(?:\.exe)?$/i.test(normalized)) {
      return explicitRuntime;
    }
  }

  const currentExecPath =
    typeof runtimeOptions.currentExecPath === 'string' && runtimeOptions.currentExecPath.trim().length > 0
      ? runtimeOptions.currentExecPath.trim()
      : process.execPath;
  if (/(^|[\\/])bun(?:\.exe)?$/i.test(currentExecPath)) {
    try {
      accessSync(currentExecPath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return currentExecPath;
    } catch {
      // Fall through to sibling/PATH lookup.
    }
  }

  const siblingBun = join(
    dirname(commandPath),
    process.platform === 'win32' ? 'bun.exe' : 'bun',
  );
  try {
    accessSync(siblingBun, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return siblingBun;
  } catch {
    // Fall through to PATH lookup.
  }

  let currentDir = dirname(commandPath);
  let previousDir: string | null = null;
  while (currentDir !== previousDir) {
    if (/^\.bun$/i.test(currentDir.split(/[\\/]/).pop() ?? '')) {
      const bunFromEnclosingHome = join(
        currentDir,
        'bin',
        process.platform === 'win32' ? 'bun.exe' : 'bun',
      );
      try {
        accessSync(bunFromEnclosingHome, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return bunFromEnclosingHome;
      } catch {
        break;
      }
    }
    previousDir = currentDir;
    currentDir = dirname(currentDir);
  }

  return resolveCommandOnPath('bun', processEnv);
}

export function resolveProviderCliJavaScriptRuntimeCommand(
  commandPath: string,
  processEnv: NodeJS.ProcessEnv,
  runtimeOptions: RuntimeResolutionOptions,
): string | null {
  const runtimeKind = resolveProviderCliJavaScriptRuntimeKind(commandPath);
  if (runtimeKind === 'none') return null;
  if (runtimeKind === 'bun') {
    return resolveBunRuntimeCommand(commandPath, processEnv, runtimeOptions);
  }
  return resolveJavaScriptRuntimeCommand({
    isBunRuntime: runtimeOptions.isBunRuntime ?? (typeof process.versions.bun === 'string'),
    processEnv,
    currentExecPath: runtimeOptions.currentExecPath,
  });
}

function resolveCommandInKnownUserDirs(agentId: AgentId, command: string, processEnv: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') return null;
  const homeDir = typeof processEnv.HOME === 'string' ? processEnv.HOME.trim() : '';
  if (!homeDir) return null;

  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  const suffixes = runtimeSpec.knownUserBinDirSuffixes ?? [];
  for (const suffix of suffixes) {
    const candidate = join(homeDir, suffix, command);
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function resolveProviderCliSystemCommand(agentId: AgentId, processEnv: NodeJS.ProcessEnv): string | null {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  return resolveCommandOnPath(runtimeSpec.binaryName, processEnv) ?? resolveCommandInKnownUserDirs(agentId, runtimeSpec.binaryName, processEnv);
}

function resolveProviderCliManagedCommand(agentId: AgentId, processEnv: NodeJS.ProcessEnv): string | null {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  if (!runtimeSpec.managedInstall) return null;
  const managedPath = resolveProviderCliManagedCommandPath(agentId, { processEnv });
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(managedPath, accessMode);
    return managedPath;
  } catch {
    return null;
  }
}

export function isProviderCliPathRunnable(
  commandPath: string,
  processEnv: NodeJS.ProcessEnv,
  runtimeOptions: RuntimeResolutionOptions,
): boolean {
  if (!providerCliPathRequiresJavaScriptRuntime(commandPath)) {
    return true;
  }

  return Boolean(resolveProviderCliJavaScriptRuntimeCommand(commandPath, processEnv, runtimeOptions));
}

export function resolveProviderCliCommand(
  agentId: AgentId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv } & RuntimeResolutionOptions> = {},
): ProviderCliCommandResolution | null {
  const processEnv = opts.processEnv ?? process.env;
  const rawOverride = readProviderCliOverride(agentId, processEnv);
  if (rawOverride) {
    const override = resolveProviderCliOverride(agentId, processEnv);
    if (!override) return null;
    if (!isProviderCliPathRunnable(override, processEnv, opts)) return null;
    return { source: 'override', command: override };
  }

  const systemCommand = resolveProviderCliSystemCommand(agentId, processEnv);
  const managedCommand = resolveProviderCliManagedCommand(agentId, processEnv);
  const sourcePreference = readBackendCliSourcePreference(agentId, processEnv);

  if (sourcePreference === 'managed-first') {
    if (managedCommand && isProviderCliPathRunnable(managedCommand, processEnv, opts)) {
      return { source: 'managed', command: managedCommand };
    }
    if (systemCommand && isProviderCliPathRunnable(systemCommand, processEnv, opts)) {
      return { source: 'system', command: systemCommand };
    }
    return null;
  }

  if (systemCommand && isProviderCliPathRunnable(systemCommand, processEnv, opts)) {
    return { source: 'system', command: systemCommand };
  }
  if (managedCommand && isProviderCliPathRunnable(managedCommand, processEnv, opts)) {
    return { source: 'managed', command: managedCommand };
  }
  return null;
}
