import { accessSync, closeSync, constants as fsConstants, existsSync, openSync, readSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import {
  AGENT_IDS,
  getAgentCliRuntimeSpec,
  legacyCustomAcpCompat,
  type AgentId,
  type BundledAgentId,
  type AgentCliRuntimeSpec,
  type AgentCliManagedInstallSpec,
  type AgentCliSourcePreference,
} from '@happier-dev/agents';
import { buildBackendTargetKey, buildBackendTargetKeyV2 } from '@happier-dev/protocol';

import { expandHomeDirPath } from '../path/expandHomeDirPath.js';
import { resolveWindowsCommandOnPath, resolveWindowsCommandPath } from '../process/index.js';
import {
  resolveExplicitJavaScriptRuntimeCommand,
  resolveJavaScriptRuntimeCommand,
} from './managedJavaScriptRuntime.js';
import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';

export type AgentCliResolutionSource = 'override' | 'system' | 'managed';

export type AgentCliCommandResolution = Readonly<{
  source: AgentCliResolutionSource;
  command: string;
}>;

export type AgentCliRuntimeDescriptor = Readonly<
  Omit<AgentCliRuntimeSpec, 'id'> & {
    id: string;
  }
>;

type RuntimeResolutionOptions = Readonly<{
  isBunRuntime?: boolean;
  currentExecPath?: string | null;
}>;

export type AgentCliJavaScriptRuntimeKind = 'none' | 'node' | 'bun';
/**
 * Lookup ids answered from the generated bundled CLI runtime table.
 *
 * An externally installed Agent carries its own CLI descriptor from its plugin
 * manifest and resolves through the `*ForRuntime` family instead.
 */
type AgentCliLookupId = BundledAgentId | (typeof legacyCustomAcpCompat.LEGACY_COMPAT_AGENT_IDS)[number];

const AGENT_CLI_SOURCE_OVERRIDE_FILE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;
const AGENT_CLI_SHEBANG_RUNTIME_FILE_EXTENSIONS = /\.(?:[cm]?tsx?|jsx)$/i;

function readBackendCliSourcePreferenceMap(processEnv: NodeJS.ProcessEnv): Partial<Record<string, AgentCliSourcePreference>> {
  const raw = typeof processEnv.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON === 'string'
    ? processEnv.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON.trim()
    : '';
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value === 'system-first' || value === 'managed-first'),
    ) as Partial<Record<string, AgentCliSourcePreference>>;
  } catch {
    return {};
  }
}

function isBuiltInAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

function getAgentCliRuntimeSpecForLookupId(agentId: AgentCliLookupId): AgentCliRuntimeDescriptor {
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec();
  }
  return getAgentCliRuntimeSpec(agentId);
}

export function readBackendCliSourcePreferenceForAgent(
  agentId: string,
  sourcePreferenceDefault: AgentCliSourcePreference,
  processEnv: NodeJS.ProcessEnv = process.env,
): AgentCliSourcePreference {
  const preferences = readBackendCliSourcePreferenceMap(processEnv);
  let targetKeyV2: string | null = null;
  try {
    targetKeyV2 = buildBackendTargetKeyV2({ kind: 'backend', backendId: agentId });
  } catch {
    targetKeyV2 = null;
  }
  const targetKey = isBuiltInAgentId(agentId)
    ? buildBackendTargetKey({ kind: 'builtInAgent', agentId: agentId })
    : null;
  return (targetKeyV2 ? preferences[targetKeyV2] : undefined)
    ?? (targetKey ? preferences[targetKey] : undefined)
    ?? preferences[agentId]
    ?? sourcePreferenceDefault;
}

export function readBackendCliSourcePreference(
  agentId: AgentCliLookupId,
  processEnv: NodeJS.ProcessEnv = process.env,
): AgentCliSourcePreference {
  return readBackendCliSourcePreferenceForAgent(
    agentId,
    getAgentCliRuntimeSpecForLookupId(agentId).sourcePreferenceDefault,
    processEnv,
  );
}

function resolveManagedCommandBasename(spec: AgentCliManagedInstallSpec): string {
  if (process.platform !== 'win32') return spec.binaryName;
  return spec.kind === 'github_release_binary' ? `${spec.binaryName}.exe` : `${spec.binaryName}.cmd`;
}

function resolveAgentCliOverrideEnvKey(agentId: string): string {
  const normalized = agentId.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return `HAPPIER_${normalized || agentId.toUpperCase()}_PATH`;
}

export function readAgentCliOverrideForRuntime(
  runtimeSpec: AgentCliRuntimeDescriptor,
  processEnv: NodeJS.ProcessEnv = process.env,
): string | null {
  const envKey = resolveAgentCliOverrideEnvKey(runtimeSpec.id);
  const override = expandHomeDirPath(
    typeof processEnv[envKey] === 'string' ? String(processEnv[envKey]).trim() : '',
    processEnv,
  );
  return override || null;
}

export function readAgentCliOverride(agentId: AgentCliLookupId, processEnv: NodeJS.ProcessEnv = process.env): string | null {
  return readAgentCliOverrideForRuntime(getAgentCliRuntimeSpecForLookupId(agentId), processEnv);
}

function agentCliCandidatePathExists(runtimeSpec: AgentCliRuntimeDescriptor, candidatePath: string): boolean {
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(candidatePath, accessMode);
    return true;
  } catch {
    if (!runtimeSpec.acceptsJavaScriptFileOverride || process.platform === 'win32') return false;
    if (!AGENT_CLI_SOURCE_OVERRIDE_FILE_EXTENSIONS.test(candidatePath)) return false;
    try {
      accessSync(candidatePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function resolveAgentCliOverride(runtimeSpec: AgentCliRuntimeDescriptor, processEnv: NodeJS.ProcessEnv): string | null {
  const override = readAgentCliOverrideForRuntime(runtimeSpec, processEnv);
  if (!override) return null;
  if (process.platform === 'win32') {
    const normalizedOverride =
      (override.includes('/') || override.includes('\\') || override.includes(':'))
        ? resolveWindowsCommandPath(override, processEnv)
        : resolveWindowsCommandOnPath(override, processEnv);
    if (normalizedOverride) return normalizedOverride;
  }
  if (!isAbsolute(override)) return null;
  return agentCliCandidatePathExists(runtimeSpec, override) ? override : null;
}

export function resolveAgentCliManagedCommandPathForRuntime(
  runtimeSpec: AgentCliRuntimeDescriptor,
  opts: Readonly<{ happyHomeDir?: string | null; processEnv?: NodeJS.ProcessEnv }> = {},
): string {
  const managedInstall = runtimeSpec.managedInstall;
  if (!managedInstall) {
    throw new Error(`Agent ${runtimeSpec.id} does not define a managed CLI install path`);
  }
  const processEnv = opts.processEnv ?? process.env;
  const happyHomeDir = typeof opts.happyHomeDir === 'string' && opts.happyHomeDir.trim().length > 0
    ? opts.happyHomeDir.trim()
    : resolveHappyHomeDirFromEnvironment(processEnv);
  // On-disk layout contract: tools/providers/<agentId> is where existing managed installs live (kept in R.16).
  return join(happyHomeDir, 'tools', 'providers', runtimeSpec.id, 'current', 'bin', resolveManagedCommandBasename(managedInstall));
}

export function resolveAgentCliManagedCommandPath(
  agentId: AgentCliLookupId,
  opts: Readonly<{ happyHomeDir?: string | null; processEnv?: NodeJS.ProcessEnv }> = {},
): string {
  return resolveAgentCliManagedCommandPathForRuntime(getAgentCliRuntimeSpecForLookupId(agentId), opts);
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
  let fd: number | null = null;
  try {
    fd = openSync(candidatePath, 'r');
    const header = Buffer.alloc(512);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return header.subarray(0, Math.max(0, bytesRead)).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close for header probes.
      }
    }
  }
}

function resolveUnixScriptRuntimeKind(candidatePath: string): AgentCliJavaScriptRuntimeKind {
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

function resolveJavaScriptSourceOverrideRuntimeKind(candidatePath: string): AgentCliJavaScriptRuntimeKind {
  const shebangRuntimeKind = process.platform === 'win32'
    ? 'none'
    : resolveUnixScriptRuntimeKind(candidatePath);
  if (shebangRuntimeKind !== 'none') {
    return shebangRuntimeKind;
  }

  // Source-file overrides still need a JS runtime even when the file itself
  // does not declare one via shebang. Prefer Bun for raw TS/TSX/JSX sources.
  return 'bun';
}

export function resolveAgentCliJavaScriptRuntimeKind(candidatePath: string): AgentCliJavaScriptRuntimeKind {
  if (/\.(?:c?js|mjs)$/i.test(candidatePath)) {
    return 'node';
  }

  if (AGENT_CLI_SHEBANG_RUNTIME_FILE_EXTENSIONS.test(candidatePath)) {
    return resolveJavaScriptSourceOverrideRuntimeKind(candidatePath);
  }

  if (process.platform === 'win32') {
    return 'none';
  }

  return resolveUnixScriptRuntimeKind(candidatePath);
}

export function agentCliPathRequiresJavaScriptRuntime(candidatePath: string): boolean {
  return resolveAgentCliJavaScriptRuntimeKind(candidatePath) !== 'none';
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

export function resolveAgentCliJavaScriptRuntimeCommand(
  commandPath: string,
  processEnv: NodeJS.ProcessEnv,
  runtimeOptions: RuntimeResolutionOptions,
): string | null {
  const runtimeKind = resolveAgentCliJavaScriptRuntimeKind(commandPath);
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

function resolveCommandInKnownUserDirs(
  runtimeSpec: AgentCliRuntimeDescriptor,
  command: string,
  processEnv: NodeJS.ProcessEnv,
): string | null {
  const homeDir = typeof processEnv.HOME === 'string' ? processEnv.HOME.trim() : '';
  if (!homeDir) return null;

  const suffixes = runtimeSpec.knownUserBinDirSuffixes ?? [];
  for (const suffix of suffixes) {
    const candidate = join(homeDir, suffix, command);
    if (process.platform === 'win32') {
      const resolved = resolveWindowsCommandPath(candidate, processEnv);
      if (resolved) return resolved;
      continue;
    }
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

function resolveAgentCliSystemCommand(
  runtimeSpec: AgentCliRuntimeDescriptor,
  processEnv: NodeJS.ProcessEnv,
  runtimeOptions: RuntimeResolutionOptions,
): string | null {
  const binaryNames = [runtimeSpec.binaryName, ...(runtimeSpec.alternativeBinaryNames ?? [])];
  const candidates = binaryNames.map((binaryName) => ({
    knownUserCommand: resolveCommandInKnownUserDirs(runtimeSpec, binaryName, processEnv),
    pathCommand: resolveCommandOnPath(binaryName, processEnv),
  }));
  if (runtimeSpec.systemCommandResolutionStrategy !== 'known-user-first-runnable') {
    for (const candidate of candidates) {
      const command = candidate.pathCommand ?? candidate.knownUserCommand;
      if (command) return command;
    }
    return null;
  }

  for (const candidate of candidates) {
    for (const command of [candidate.knownUserCommand, candidate.pathCommand]) {
      if (!command) continue;
      if (isAgentCliPathRunnable(command, processEnv, runtimeOptions)) {
        return command;
      }
    }
  }
  return null;
}

function resolveAgentCliManagedCommand(runtimeSpec: AgentCliRuntimeDescriptor, processEnv: NodeJS.ProcessEnv): string | null {
  if (!runtimeSpec.managedInstall) return null;
  const managedPath = resolveAgentCliManagedCommandPathForRuntime(runtimeSpec, { processEnv });
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(managedPath, accessMode);
    return managedPath;
  } catch {
    return null;
  }
}

export function isAgentCliPathRunnable(
  commandPath: string,
  processEnv: NodeJS.ProcessEnv,
  runtimeOptions: RuntimeResolutionOptions,
): boolean {
  if (!agentCliPathRequiresJavaScriptRuntime(commandPath)) {
    return true;
  }

  return Boolean(resolveAgentCliJavaScriptRuntimeCommand(commandPath, processEnv, runtimeOptions));
}

export function resolveAgentCliCommand(
  agentId: AgentCliLookupId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv } & RuntimeResolutionOptions> = {},
): AgentCliCommandResolution | null {
  return resolveAgentCliCommandForRuntime(getAgentCliRuntimeSpecForLookupId(agentId), opts);
}

export function resolveAgentCliCommandForRuntime(
  runtimeSpec: AgentCliRuntimeDescriptor,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv } & RuntimeResolutionOptions> = {},
): AgentCliCommandResolution | null {
  const processEnv = opts.processEnv ?? process.env;
  const rawOverride = readAgentCliOverrideForRuntime(runtimeSpec, processEnv);
  if (rawOverride) {
    const override = resolveAgentCliOverride(runtimeSpec, processEnv);
    if (!override) return null;
    if (!isAgentCliPathRunnable(override, processEnv, opts)) return null;
    return { source: 'override', command: override };
  }

  const systemCommand = resolveAgentCliSystemCommand(runtimeSpec, processEnv, opts);
  const managedCommand = resolveAgentCliManagedCommand(runtimeSpec, processEnv);
  const sourcePreference = readBackendCliSourcePreferenceForAgent(
    runtimeSpec.id,
    runtimeSpec.sourcePreferenceDefault,
    processEnv,
  );

  if (sourcePreference === 'managed-first') {
    if (managedCommand && isAgentCliPathRunnable(managedCommand, processEnv, opts)) {
      return { source: 'managed', command: managedCommand };
    }
    if (systemCommand && isAgentCliPathRunnable(systemCommand, processEnv, opts)) {
      return { source: 'system', command: systemCommand };
    }
    return null;
  }

  if (systemCommand && isAgentCliPathRunnable(systemCommand, processEnv, opts)) {
    return { source: 'system', command: systemCommand };
  }
  if (managedCommand && isAgentCliPathRunnable(managedCommand, processEnv, opts)) {
    return { source: 'managed', command: managedCommand };
  }
  return null;
}
