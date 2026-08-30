import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants as fsConstants, existsSync, openSync, readSync, readdirSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import {
  getProviderCliBinaryNames,
  getProviderCliRuntimeSpec,
  type AgentId,
  type ProviderCliKnownCommandCandidate,
  type ProviderCliManagedInstallSpec,
  type ProviderCliSourcePreference,
} from '@happier-dev/agents';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '../path/expandHomeDirPath.js';
import { resolveWindowsCommandOnPath, resolveWindowsCommandPath } from '../process/index.js';
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

type ResolvedProviderCliSystemCommand = Readonly<{
  command: string;
  binaryName: string;
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

export function resolveProviderCliManagedCommandRelativePath(agentId: AgentId): string {
  const managedInstall = getProviderCliRuntimeSpec(agentId).managedInstall;
  if (!managedInstall) {
    throw new Error(`Provider ${agentId} does not define a managed CLI install path`);
  }
  return join('bin', resolveManagedCommandBasename(managedInstall));
}

export function readProviderCliOverride(agentId: AgentId, processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const envKey = `HAPPIER_${agentId.toUpperCase()}_PATH`;
  const override = expandHomeDirPath(
    typeof processEnv[envKey] === 'string' ? String(processEnv[envKey]).trim() : '',
    processEnv,
  );
  return override || null;
}

export { expandHomeDirPath, resolveHomeDirFromEnvironment };

function providerCliCandidatePathExists(agentId: AgentId, candidatePath: string): boolean {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(candidatePath, accessMode);
    return true;
  } catch {
    if (!runtimeSpec.acceptsJavaScriptFileOverride || process.platform === 'win32') return false;
    if (!/\.(?:c?js|mjs)$/i.test(candidatePath)) return false;
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
  const normalizedOverride = override.includes('/') || override.includes('\\')
    ? (isAbsolute(override) ? override : resolve(override))
    : override;
  return providerCliCandidatePathExists(agentId, normalizedOverride) ? normalizedOverride : null;
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
  const installRoot = join(happyHomeDir, 'tools', 'providers', agentId);
  const commandRelativePath = resolveProviderCliManagedCommandRelativePath(agentId);
  const activeCommandPath = join(installRoot, 'active', commandRelativePath);
  // Existing runner snapshots still resolve current. New POSIX promotions retain it and switch active atomically.
  if (process.platform !== 'win32' && existsSync(activeCommandPath)) return activeCommandPath;
  return join(installRoot, 'current', commandRelativePath);
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

function compareSemverLikeNamesDescending(a: string, b: string): number {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!match) return null;
    const major = Number.parseInt(match[1]!, 10);
    const minor = Number.parseInt(match[2]!, 10);
    const patch = Number.parseInt(match[3]!, 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
    return [major, minor, patch];
  };

  const parsedA = parse(a);
  const parsedB = parse(b);
  if (!parsedA && !parsedB) return b.localeCompare(a);
  if (!parsedA) return 1;
  if (!parsedB) return -1;
  for (let index = 0; index < 3; index += 1) {
    const diff = parsedB[index]! - parsedA[index]!;
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

function resolveProviderCliInVersionedDir(agentId: AgentId, versionsDir: string, processEnv: NodeJS.ProcessEnv): ResolvedProviderCliSystemCommand | null {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  const commandNames = getProviderCliBinaryNames(agentId, processEnv).flatMap((binaryName) => (
    process.platform === 'win32'
      ? [{ candidateName: `${binaryName}.exe`, binaryName }, { candidateName: binaryName, binaryName }]
      : [{ candidateName: binaryName, binaryName }]
  ));
  const extraEntryNames = runtimeSpec.acceptsJavaScriptFileOverride
    ? ['cli.js', 'cli.cjs', 'cli.mjs'].map((candidateName) => ({ candidateName, binaryName: runtimeSpec.binaryName }))
    : [];

  try {
    const entries = readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareSemverLikeNamesDescending);

    for (const entry of entries) {
      for (const { candidateName, binaryName } of [...commandNames, ...extraEntryNames]) {
        const directCandidate = join(versionsDir, entry, candidateName);
        if (providerCliCandidatePathExists(agentId, directCandidate)) {
          return { command: directCandidate, binaryName };
        }
        const nestedCandidate = join(versionsDir, entry, 'bin', candidateName);
        if (providerCliCandidatePathExists(agentId, nestedCandidate)) {
          return { command: nestedCandidate, binaryName };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function basenameForKnownCandidatePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop()?.replace(/\.(?:exe|cmd)$/i, '') ?? path;
}

function resolveKnownCommandCandidate(agentId: AgentId, candidate: ProviderCliKnownCommandCandidate, processEnv: NodeJS.ProcessEnv): ResolvedProviderCliSystemCommand | null {
  const homeDir = resolveHomeDirFromEnvironment(processEnv);
  switch (candidate.kind) {
    case 'homeBinDir': {
      for (const binaryName of getProviderCliBinaryNames(agentId, processEnv)) {
        const commandPath = join(homeDir, candidate.relativeDir, binaryName);
        if (providerCliCandidatePathExists(agentId, commandPath)) return { command: commandPath, binaryName };
      }
      return null;
    }
    case 'homePath': {
      const commandPath = join(homeDir, candidate.relativePath);
      return providerCliCandidatePathExists(agentId, commandPath)
        ? { command: commandPath, binaryName: basenameForKnownCandidatePath(candidate.relativePath) }
        : null;
    }
    case 'absolutePath':
      return providerCliCandidatePathExists(agentId, candidate.path)
        ? { command: candidate.path, binaryName: basenameForKnownCandidatePath(candidate.path) }
        : null;
    case 'homeVersionedDir':
      return resolveProviderCliInVersionedDir(agentId, join(homeDir, candidate.relativeDir), processEnv);
  }
  return null;
}

function resolveCommandInKnownLocations(agentId: AgentId, processEnv: NodeJS.ProcessEnv): ResolvedProviderCliSystemCommand | null {
  const candidates = getProviderCliRuntimeSpec(agentId).knownCommandCandidates ?? [];
  for (const candidate of candidates) {
    const resolved = resolveKnownCommandCandidate(agentId, candidate, processEnv);
    if (resolved) return resolved;
  }
  return null;
}

function commandMatchesAlternativeIdentityProbe(
  agentId: AgentId,
  resolvedCommand: ResolvedProviderCliSystemCommand,
  processEnv: NodeJS.ProcessEnv,
): boolean {
  const runtimeSpec = getProviderCliRuntimeSpec(agentId);
  if (resolvedCommand.binaryName === runtimeSpec.binaryName) return true;
  if (!(runtimeSpec.alternativeBinaryNames ?? []).includes(resolvedCommand.binaryName)) return true;
  const probe = runtimeSpec.alternativeBinaryIdentityProbe;
  if (!probe) return true;

  const result = spawnSync(resolvedCommand.command, [...probe.args], {
    env: processEnv,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: probe.timeoutMs,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return false;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    return Boolean(
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && typeof (parsed as Record<string, unknown>)[probe.stdoutJsonStringField] === 'string'
      && String((parsed as Record<string, unknown>)[probe.stdoutJsonStringField]).trim().length > 0,
    );
  } catch {
    return false;
  }
}

function resolveProviderCliSystemCommand(agentId: AgentId, processEnv: NodeJS.ProcessEnv): string | null {
  for (const binaryName of getProviderCliBinaryNames(agentId, processEnv)) {
    const command = resolveCommandOnPath(binaryName, processEnv);
    if (command) {
      const resolved = { command, binaryName };
      if (commandMatchesAlternativeIdentityProbe(agentId, resolved, processEnv)) return command;
    }
  }
  const knownCommand = resolveCommandInKnownLocations(agentId, processEnv);
  if (!knownCommand) return null;
  return commandMatchesAlternativeIdentityProbe(agentId, knownCommand, processEnv) ? knownCommand.command : null;
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
