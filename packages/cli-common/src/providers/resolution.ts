import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import {
  getProviderCliRuntimeSpec,
  type AgentId,
  type ProviderCliManagedInstallSpec,
  type ProviderCliSourcePreference,
} from '@happier-dev/agents';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { resolveWindowsCommandOnPath } from '../process/index.js';
import { resolveJavaScriptRuntimeCommand } from './managedJavaScriptRuntime.js';
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
  const override = typeof processEnv[envKey] === 'string' ? String(processEnv[envKey]).trim() : '';
  return override || null;
}

function resolveProviderCliOverride(agentId: AgentId, processEnv: NodeJS.ProcessEnv): string | null {
  const override = readProviderCliOverride(agentId, processEnv);
  if (!override) return null;
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(override, accessMode);
    return override;
  } catch {
    const runtimeSpec = getProviderCliRuntimeSpec(agentId);
    if (!runtimeSpec.acceptsJavaScriptFileOverride || process.platform === 'win32') return null;
    if (!/\.(?:c?js|mjs)$/i.test(override)) return null;
    try {
      accessSync(override, fsConstants.F_OK);
      return override;
    } catch {
      return null;
    }
  }
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

function unixScriptRequiresJavaScriptRuntime(candidatePath: string): boolean {
  const header = readFileHeader(candidatePath);
  if (!header?.startsWith('#!')) return false;
  const firstLine = header.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) return false;
  return /(?:^#!.*\b(?:env(?:\s+-S)?\s+)?)\b(?:node|bun)(?:\s|$)/i.test(firstLine);
}

export function providerCliPathRequiresJavaScriptRuntime(candidatePath: string): boolean {
  if (/\.(?:c?js|mjs)$/i.test(candidatePath)) {
    return true;
  }

  if (process.platform === 'win32') {
    return false;
  }

  return unixScriptRequiresJavaScriptRuntime(candidatePath);
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

  return Boolean(resolveJavaScriptRuntimeCommand({
    isBunRuntime: runtimeOptions.isBunRuntime ?? (typeof process.versions.bun === 'string'),
    processEnv,
    currentExecPath: runtimeOptions.currentExecPath,
  }));
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
