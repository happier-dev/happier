import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AgentToolsDeliveryRuntimeContext } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';

export type PiShellBridgeAvailability =
  | Readonly<{
      available: true;
      shellPath: string | null;
      source: 'configured_shell_path' | 'git_bash' | 'path' | 'non_windows';
    }>
  | Readonly<{
      available: false;
      reason: 'configured_shell_path_not_found' | 'bash_not_found';
      errorMessage: string;
      configuredShellPath?: string;
      searchedPaths: readonly string[];
    }>;

type PiShellBridgeEnvironment = Readonly<Record<string, string | undefined>>;

function buildPiWindowsShellBridgeErrorMessage(searchedPaths: readonly string[]): string {
  return [
    'Pi requires Bash to use Happier tools on Windows.',
    'Install Git for Windows (https://git-scm.com/download/win), add a Pi-recognized Bash executable to PATH, or set shellPath in Pi settings.json.',
    ...(searchedPaths.length > 0 ? ['Searched Git Bash in:', ...searchedPaths.map((candidate) => `  ${candidate}`)] : []),
  ].join('\n');
}

export function resolvePiShellBridgeAvailability(params: Readonly<{
  platform: NodeJS.Platform;
  env: PiShellBridgeEnvironment;
  configuredShellPath: string | null;
  pathExists: (candidate: string) => boolean;
  findBashOnPath: () => string | null;
}>): PiShellBridgeAvailability {
  if (params.platform !== 'win32') {
    return { available: true, shellPath: null, source: 'non_windows' };
  }

  if (params.configuredShellPath) {
    if (params.pathExists(params.configuredShellPath)) {
      return {
        available: true,
        shellPath: params.configuredShellPath,
        source: 'configured_shell_path',
      };
    }
    return {
      available: false,
      reason: 'configured_shell_path_not_found',
      configuredShellPath: params.configuredShellPath,
      searchedPaths: [],
      errorMessage: `Pi shellPath does not exist: ${params.configuredShellPath}. Update shellPath in Pi settings.json or install Git for Windows (https://git-scm.com/download/win).`,
    };
  }

  const searchedPaths = [
    ...(params.env.ProgramFiles ? [`${params.env.ProgramFiles}\\Git\\bin\\bash.exe`] : []),
    ...(params.env['ProgramFiles(x86)'] ? [`${params.env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`] : []),
  ];
  for (const candidate of searchedPaths) {
    if (params.pathExists(candidate)) {
      return { available: true, shellPath: candidate, source: 'git_bash' };
    }
  }

  const bashOnPath = params.findBashOnPath();
  if (bashOnPath && params.pathExists(bashOnPath)) {
    return { available: true, shellPath: bashOnPath, source: 'path' };
  }

  return {
    available: false,
    reason: 'bash_not_found',
    searchedPaths,
    errorMessage: buildPiWindowsShellBridgeErrorMessage(searchedPaths),
  };
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readSettingsShellPath(settings: Record<string, unknown> | null): string | null {
  const value = settings?.shellPath;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveEffectivePiConfiguredShellPath(params: Readonly<{
  globalShellPath: string | null;
  projectShellPath: string | null;
  projectTrusted: boolean;
}>): string | null {
  return params.projectTrusted && params.projectShellPath
    ? params.projectShellPath
    : params.globalShellPath;
}

function resolvePiProjectTrusted(params: Readonly<{
  agentDir: string;
  directory: string;
  globalSettings: Record<string, unknown> | null;
  platform: NodeJS.Platform;
}>): boolean {
  const pathApi = params.platform === 'win32' ? win32 : { dirname, join, resolve };
  const canonicalize = (candidate: string): string => {
    const resolved = pathApi.resolve(candidate);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  const trust = readJsonRecord(pathApi.join(params.agentDir, 'trust.json'));
  let current = canonicalize(params.directory);
  while (trust) {
    const decision = trust[current];
    if (decision === true || decision === false) return decision;
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return params.globalSettings?.defaultProjectTrust === 'always';
}

function normalizePiShellPath(
  shellPath: string,
  platform: NodeJS.Platform,
  homeDir: string,
): string {
  let normalized = shellPath;
  if (platform === 'win32' && normalized.startsWith('/') && !normalized.startsWith('//') && !normalized.includes('\\')) {
    const match = normalized.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) {
      normalized = `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`;
    }
  }
  if (normalized === '~') return homeDir;
  if (normalized.startsWith('~/') || (platform === 'win32' && normalized.startsWith('~\\'))) {
    const suffix = normalized.slice(2);
    return platform === 'win32' ? win32.join(homeDir, suffix) : join(homeDir, suffix);
  }
  return normalized;
}

function findPiBashOnWindowsPath(env: PiShellBridgeEnvironment): string | null {
  try {
    const result = spawnSync('where', ['bash.exe'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      env: { ...env },
    });
    if (result.status !== 0 || !result.stdout) return null;
    return result.stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export function resolvePiShellBridgeAvailabilityForRuntime(params: Readonly<{
  platform?: NodeJS.Platform;
  env?: PiShellBridgeEnvironment;
  directory?: string | null;
  includeProjectSettings?: boolean;
}> = {}): PiShellBridgeAvailability {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  if (platform !== 'win32') {
    return { available: true, shellPath: null, source: 'non_windows' };
  }

  const pathApi = platform === 'win32' ? win32 : { dirname, join, resolve };
  const homeDir = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir();
  const explicitAgentDir = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = explicitAgentDir || pathApi.join(homeDir, '.pi', 'agent');
  const globalSettings = readJsonRecord(pathApi.join(agentDir, 'settings.json'));
  const globalShellPath = readSettingsShellPath(globalSettings);
  const projectSettings = params.includeProjectSettings === true && params.directory
    ? readJsonRecord(pathApi.join(params.directory, '.pi', 'settings.json'))
    : null;
  const projectShellPath = readSettingsShellPath(projectSettings);
  const projectTrusted = projectShellPath !== null && params.directory
    ? resolvePiProjectTrusted({
      agentDir,
      directory: params.directory,
      globalSettings,
      platform,
    })
    : false;
  const configuredShellPath = resolveEffectivePiConfiguredShellPath({
    globalShellPath,
    projectShellPath,
    projectTrusted,
  });

  return resolvePiShellBridgeAvailability({
    platform,
    env,
    configuredShellPath: configuredShellPath
      ? normalizePiShellPath(configuredShellPath, platform, homeDir)
      : null,
    pathExists: existsSync,
    findBashOnPath: () => findPiBashOnWindowsPath(env),
  });
}

export function resolvePiToolsDeliveryAvailability(
  context: AgentToolsDeliveryRuntimeContext,
): boolean {
  return resolvePiShellBridgeAvailabilityForRuntime({
    platform: context.platform,
    env: context.environmentVariables,
    directory: context.directory,
    includeProjectSettings: true,
  }).available;
}
