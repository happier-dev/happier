import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, win32 as win32Path } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';

import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';

export type InstalledDaemonServiceEntry = Readonly<{
  serverId: string;
  name: string;
  relayUrl?: string | null;
  installed: true;
  path: string;
  platform: 'darwin' | 'linux' | 'win32';
  mode?: DaemonServiceMode;
  happierHomeDir?: string | null;
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
}>;

type InstalledServicePathMatch = Readonly<{
  serverId: string;
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
}>;

function parseInstalledServicePath(platform: 'darwin' | 'linux' | 'win32', path: string): InstalledServicePathMatch | null {
  const fileName = platform === 'win32' ? win32Path.basename(path) : basename(path);
  const rawLegacyMatch =
    platform === 'linux'
      ? /^happier-daemon\.service$/i.test(fileName)
      : platform === 'darwin'
        ? /^com\.happier\.cli\.daemon\.plist$/i.test(fileName)
        : /^happier-daemon\.ps1$/i.test(fileName);
  if (rawLegacyMatch) {
    const label = platform === 'win32'
      ? `Happier\\${win32Path.basename(path, '.ps1')}`
      : platform === 'darwin'
        ? basename(path, '.plist')
        : basename(path, '.service');
    return {
      serverId: 'default',
      releaseChannel: 'stable',
      label,
      targetMode: 'default-following',
    };
  }

  const match =
    platform === 'linux'
      ? /^happier-daemon(?:\.(preview|dev))?\.(.+)\.service$/i.exec(fileName)
      : platform === 'darwin'
        ? /^com\.happier\.cli\.daemon(?:\.(preview|dev))?\.(.+)\.plist$/i.exec(fileName)
        : /^happier-daemon(?:\.(preview|dev))?\.(.+)\.ps1$/i.exec(fileName);
  if (!match) {
    return null;
  }
  const channelSegment = String(match[1] ?? '').trim().toLowerCase();
  const serverId = String(match[2] ?? '').trim();
  if (!serverId) {
    return null;
  }
  const releaseChannel = channelSegment === 'preview'
    ? 'preview'
    : channelSegment === 'dev'
      ? 'publicdev'
      : 'stable';
  const targetMode: DaemonServiceTargetMode = serverId === 'default' ? 'default-following' : 'pinned';
  const label = platform === 'win32'
    ? `Happier\\${win32Path.basename(path, '.ps1')}`
    : platform === 'darwin'
      ? basename(path, '.plist')
      : basename(path, '.service');
  return { serverId, releaseChannel, label, targetMode };
}

function normalizeParsedReleaseChannel(value: string | null): PublicReleaseRingId | null {
  if (value === 'preview') return 'preview';
  if (value === 'dev') return 'publicdev';
  if (value === 'stable') return 'stable';
  return null;
}

function readInstalledServiceFile(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function unescapeSystemdValue(value: string): string {
  return String(value ?? '')
    .replaceAll('%%', '%')
    .replaceAll('\\n', '\n')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\');
}

function stripSystemdQuotes(value: string): string {
  const s = String(value ?? '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return unescapeSystemdValue(s.slice(1, -1));
  }
  return unescapeSystemdValue(s);
}

function parseLinuxUnitValue(contents: string, key: string): string | null {
  const normalizedKey = String(key ?? '').trim();
  if (!normalizedKey) return null;

  const lines = String(contents ?? '').split(/\r?\n/u);
  for (const lineRaw of lines) {
    const line = String(lineRaw ?? '').trim();
    if (!line || !/^Environment=/i.test(line)) continue;

    let assignment = line.slice('Environment='.length).trim();
    assignment = stripSystemdQuotes(assignment);

    const eqIdx = assignment.indexOf('=');
    if (eqIdx <= 0) continue;

    const foundKey = assignment.slice(0, eqIdx).trim();
    if (foundKey !== normalizedKey) continue;

    const rawValue = assignment.slice(eqIdx + 1);
    const value = stripSystemdQuotes(rawValue).trim();
    return value || null;
  }

  return null;
}

function parseDarwinPlistValue(contents: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, 'i').exec(contents);
  return String(match?.[1] ?? '').trim() || null;
}

function parseWindowsWrapperValue(contents: string, key: string): string | null {
  const match = new RegExp(`\\$env:${key}\\s*=\\s*['"]([^'"]+)['"]`, 'i').exec(contents);
  return String(match?.[1] ?? '').trim() || null;
}

function parseCsvFirstField(line: string): string | null {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  const match = /^"((?:[^"]|"")*)"/u.exec(trimmed);
  if (!match) return null;
  return match[1]?.replaceAll('""', '"').trim() || null;
}

function normalizeWindowsScheduledTaskName(taskName: string): string | null {
  const normalized = String(taskName ?? '')
    .trim()
    .replaceAll('/', '\\')
    .replace(/\\+/gu, '\\')
    .replace(/^\\+/u, '');
  return normalized || null;
}

function parseWindowsScheduledTaskWrapperPathFromXml(contents: string): string | null {
  const argumentsMatch = /<Arguments>([\s\S]*?)<\/Arguments>/iu.exec(String(contents ?? ''));
  if (!argumentsMatch) return null;
  const argumentsText = argumentsMatch[1]
    ?.replaceAll('&quot;', '"')
    ?.replaceAll('&apos;', '\'')
    ?.replaceAll('&amp;', '&')
    ?.trim();
  if (!argumentsText) return null;

  const quotedMatch = /-File\s+"([^"]+\.ps1)"/iu.exec(argumentsText);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  const bareMatch = /-File\s+([^\s]+\.ps1)/iu.exec(argumentsText);
  return bareMatch?.[1]?.trim() || null;
}

function parseWindowsScheduledTaskWrapperPathFromTaskToRun(taskToRunText: string): string | null {
  const taskToRun = String(taskToRunText ?? '').trim();
  if (!taskToRun) {
    return null;
  }
  const quotedMatch = /-File\s+"([^"]+\.ps1)"/iu.exec(taskToRun);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  const bareMatch = /-File\s+([^\s]+\.ps1)/iu.exec(taskToRun);
  return bareMatch?.[1]?.trim() || null;
}

function runWindowsSchtasksCommand(args: readonly string[]): ReturnType<typeof spawnSync> {
  const timeoutMs = readPositiveIntEnv('HAPPIER_WINDOWS_SCHTASKS_TIMEOUT_MS', 15_000);
  return spawnSync('schtasks', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
}

function readWindowsScheduledTaskWrapperPath(taskName: string): string | null {
  const normalizedTaskName = normalizeWindowsScheduledTaskName(taskName);
  if (!normalizedTaskName) return null;

  try {
    const result = runWindowsSchtasksCommand(['/Query', '/TN', normalizedTaskName, '/XML']);
    if (result.status !== 0) {
      const fallback = runWindowsSchtasksCommand(['/Query', '/TN', normalizedTaskName, '/FO', 'LIST', '/V']);
      if (fallback.status !== 0) {
        return null;
      }
      return parseWindowsScheduledTaskWrapperPathFromTaskToRun(String(fallback.stdout ?? ''));
    }
    return parseWindowsScheduledTaskWrapperPathFromXml(String(result.stdout ?? ''))
      ?? (() => {
        const fallback = runWindowsSchtasksCommand(['/Query', '/TN', normalizedTaskName, '/FO', 'LIST', '/V']);
        if (fallback.status !== 0) {
          return null;
        }
        return parseWindowsScheduledTaskWrapperPathFromTaskToRun(String(fallback.stdout ?? ''));
      })();
  } catch {
    return null;
  }
}

function deriveWindowsScheduledTaskWrapperPath(taskName: string, servicesDir: string): string | null {
  const normalizedTaskName = normalizeWindowsScheduledTaskName(taskName);
  if (!normalizedTaskName) return null;

  const resolvedWrapperPath = readWindowsScheduledTaskWrapperPath(normalizedTaskName);
  if (resolvedWrapperPath) {
    return resolvedWrapperPath;
  }
  return null;
}

function deriveWindowsServiceHomeDirFromWrapperPath(wrapperPath: string | null): string | null {
  const normalizedPath = String(wrapperPath ?? '').trim();
  if (!normalizedPath) return null;
  const servicesSuffix = `${String.raw`\services`}`.toLowerCase();
  const normalizedLower = normalizedPath.toLowerCase();
  const index = normalizedLower.lastIndexOf(servicesSuffix);
  if (index <= 0) {
    return null;
  }
  return normalizedPath.slice(0, index);
}

function listWindowsScheduledTaskWrapperPaths(servicesDir: string): readonly string[] {
  try {
    const result = runWindowsSchtasksCommand(['/Query', '/FO', 'CSV', '/NH']);
    if (result.status !== 0) {
      return [];
    }

    return String(result.stdout ?? '')
      .split(/\r?\n/u)
      .map((line) => parseCsvFirstField(line))
      .filter((taskName): taskName is string => Boolean(taskName))
      .map((taskName) => normalizeWindowsScheduledTaskName(taskName))
      .filter((taskName): taskName is string => Boolean(taskName))
      .filter((taskName) => taskName.toLowerCase().startsWith('happier\\happier-daemon'))
      .map((taskName) => deriveWindowsScheduledTaskWrapperPath(taskName, servicesDir))
      .filter((wrapperPath): wrapperPath is string => Boolean(wrapperPath));
  } catch {
    return [];
  }
}

function hasDaemonStartSyncCommand(contents: string): boolean {
  return /\bdaemon\b[\s"']+\bstart-sync\b/i.test(contents);
}

function hasDarwinDaemonStartSyncCommand(contents: string): boolean {
  return /<string>\s*daemon\s*<\/string>\s*<string>\s*start-sync\s*<\/string>/i.test(contents);
}

function hasLegacyManagedLinuxServiceEnv(path: string): boolean {
  return readInstalledDaemonServiceEnvValue({ platform: 'linux', path, key: 'HAPPIER_HOME_DIR' }) !== null
    || readInstalledDaemonServiceEnvValue({ platform: 'linux', path, key: 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR' }) !== null;
}

function hasLegacyManagedDarwinServiceEnv(path: string): boolean {
  return readInstalledDaemonServiceEnvValue({ platform: 'darwin', path, key: 'HAPPIER_HOME_DIR' }) !== null
    || readInstalledDaemonServiceEnvValue({ platform: 'darwin', path, key: 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR' }) !== null;
}

function hasLegacyManagedWindowsServiceEnv(path: string): boolean {
  return readInstalledDaemonServiceEnvValue({ platform: 'win32', path, key: 'HAPPIER_HOME_DIR' }) !== null
    || readInstalledDaemonServiceEnvValue({ platform: 'win32', path, key: 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR' }) !== null;
}

export function readInstalledDaemonServiceEnvValue(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  key: string;
}>): string | null {
  const contents = readInstalledServiceFile(params.path);
  if (!contents) {
    return null;
  }

  if (params.platform === 'linux') {
    return parseLinuxUnitValue(contents, params.key);
  }
  if (params.platform === 'darwin') {
    return parseDarwinPlistValue(contents, params.key);
  }
  return parseWindowsWrapperValue(contents, params.key);
}

export function isValidInstalledDaemonServiceFile(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  expectedLabel: string;
}>): boolean {
  const contents = readInstalledServiceFile(params.path);
  if (!contents) {
    return false;
  }

  if (params.platform === 'darwin') {
    return parseDarwinPlistValue(contents, 'Label') === params.expectedLabel
      && hasDarwinDaemonStartSyncCommand(contents)
      && (
        parseDarwinPlistValue(contents, 'HAPPIER_DAEMON_STARTUP_SOURCE') === 'background-service'
        || hasLegacyManagedDarwinServiceEnv(params.path)
      );
  }

  if (params.platform === 'linux') {
    return /(^|\n)ExecStart=/.test(contents)
      && hasDaemonStartSyncCommand(contents)
      && (
        parseLinuxUnitValue(contents, 'HAPPIER_DAEMON_STARTUP_SOURCE') === 'background-service'
        || hasLegacyManagedLinuxServiceEnv(params.path)
      );
  }

  return hasDaemonStartSyncCommand(contents)
    && (
      parseWindowsWrapperValue(contents, 'HAPPIER_DAEMON_STARTUP_SOURCE') === 'background-service'
      || hasLegacyManagedWindowsServiceEnv(params.path)
    );
}

function parseInstalledServiceMetadata(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  initialReleaseChannel: PublicReleaseRingId;
  initialTargetMode: DaemonServiceTargetMode;
}>): Readonly<{
  serverId: string | null;
  happierHomeDir: string | null;
  relayUrl: string | null;
  releaseChannel: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
}> {
  const contents = readInstalledServiceFile(params.path);
  if (!contents) {
    return {
      serverId: null,
      happierHomeDir: null,
      relayUrl: null,
      releaseChannel: params.initialReleaseChannel,
      targetMode: params.initialTargetMode,
    };
  }

  const readValue = (key: string) => readInstalledDaemonServiceEnvValue({
    platform: params.platform,
    path: params.path,
    key,
  });

  const parsedTargetMode = readValue('HAPPIER_DAEMON_SERVICE_TARGET_MODE');
  const parsedServerId = readValue('HAPPIER_ACTIVE_SERVER_ID');
  const parsedHappierHomeDir = readValue('HAPPIER_HOME_DIR') ?? readValue('HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR');
  const parsedRelayUrl = readValue('HAPPIER_PUBLIC_SERVER_URL') ?? readValue('HAPPIER_SERVER_URL');
  const parsedReleaseChannel = normalizeParsedReleaseChannel(readValue('HAPPIER_PUBLIC_RELEASE_CHANNEL'));
  return {
    serverId: parsedServerId,
    happierHomeDir: parsedHappierHomeDir,
    relayUrl: parsedRelayUrl,
    releaseChannel: parsedReleaseChannel ?? params.initialReleaseChannel,
    targetMode: parsedTargetMode === 'default-following' ? 'default-following' : params.initialTargetMode,
  };
}

export async function discoverInstalledDaemonServiceEntries(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  userHomeDir: string;
  happierHomeDir: string;
  mode: DaemonServiceMode;
  serversById: Readonly<Record<string, unknown>>;
}>): Promise<readonly InstalledDaemonServiceEntry[]> {
  const servicesDir =
    params.platform === 'linux'
      ? params.mode === 'system'
        ? join('/etc', 'systemd', 'system')
        : join(params.userHomeDir, '.config', 'systemd', 'user')
      : params.platform === 'darwin'
        ? join(params.userHomeDir, 'Library', 'LaunchAgents')
        : join(params.happierHomeDir, 'services');

  let fileNames: string[] = [];
  try {
    fileNames = fs.readdirSync(servicesDir);
  } catch {
    if (params.platform !== 'win32') {
      return [];
    }
  }

  const discoveredCandidates = [
    ...fileNames.map((fileName) => ({ path: join(servicesDir, fileName), source: 'file' as const })),
    ...(params.platform === 'win32'
      ? listWindowsScheduledTaskWrapperPaths(servicesDir).map((path) => ({ path, source: 'task' as const }))
      : []),
  ].filter((candidate, index, allCandidates) => allCandidates.findIndex((other) => other.path === candidate.path) === index);

  return discoveredCandidates
    .flatMap(({ path, source }) => {
      const parsed = parseInstalledServicePath(params.platform, path);
      if (!parsed) {
        return [];
      }
      const definitionExists = isValidInstalledDaemonServiceFile({
        platform: params.platform,
        path,
        expectedLabel: parsed.label,
      });
      if (!definitionExists && source !== 'task') {
        return [];
      }
      const metadata = parseInstalledServiceMetadata({
        platform: params.platform,
        path,
        initialReleaseChannel: parsed.releaseChannel,
        initialTargetMode: parsed.targetMode,
      });
      const resolvedServerId = String(metadata.serverId ?? '').trim() || parsed.serverId;
      const profile = params.serversById[resolvedServerId];
      const profileRelayUrl = typeof profile === 'object'
        && profile
        && !Array.isArray(profile)
        && typeof (profile as { serverUrl?: unknown }).serverUrl === 'string'
          ? String((profile as { serverUrl: string }).serverUrl).trim() || null
          : null;
      const name = metadata.targetMode === 'default-following'
        ? 'Default automatic startup'
        : typeof profile === 'object' && profile && !Array.isArray(profile) && typeof (profile as { name?: unknown }).name === 'string'
          ? String((profile as { name: string }).name).trim() || resolvedServerId
          : resolvedServerId;
      return [{
        serverId: resolvedServerId,
        name,
        relayUrl: metadata.relayUrl ?? profileRelayUrl,
        installed: true as const,
        path,
        platform: params.platform,
        mode: params.mode,
        happierHomeDir: metadata.happierHomeDir ?? (
          params.platform === 'win32' && !definitionExists
            ? deriveWindowsServiceHomeDirFromWrapperPath(path)
            : null
        ),
        releaseChannel: metadata.releaseChannel,
        label: parsed.label,
        targetMode: metadata.targetMode,
      }];
    });
}
