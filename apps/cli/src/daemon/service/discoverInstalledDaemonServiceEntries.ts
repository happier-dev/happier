import * as fs from 'node:fs';
import { basename, join } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceMode, DaemonServiceTargetMode } from './plan';

export type InstalledDaemonServiceEntry = Readonly<{
  serverId: string;
  name: string;
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
  const fileName = basename(path);
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
    ? `Happier\\${basename(path, '.ps1')}`
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

function parseLinuxUnitValue(contents: string, key: string): string | null {
  const match = new RegExp(`Environment=${key}=([^\\n\\r]+)`, 'i').exec(contents);
  return String(match?.[1] ?? '').trim() || null;
}

function parseDarwinPlistValue(contents: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, 'i').exec(contents);
  return String(match?.[1] ?? '').trim() || null;
}

function parseWindowsWrapperValue(contents: string, key: string): string | null {
  const match = new RegExp(`\\$env:${key}\\s*=\\s*['"]([^'"]+)['"]`, 'i').exec(contents);
  return String(match?.[1] ?? '').trim() || null;
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
    && parseWindowsWrapperValue(contents, 'HAPPIER_DAEMON_STARTUP_SOURCE') === 'background-service';
}

function parseInstalledServiceMetadata(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  initialReleaseChannel: PublicReleaseRingId;
  initialTargetMode: DaemonServiceTargetMode;
}>): Readonly<{
  serverId: string | null;
  happierHomeDir: string | null;
  releaseChannel: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
}> {
  const contents = readInstalledServiceFile(params.path);
  if (!contents) {
    return {
      serverId: null,
      happierHomeDir: null,
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
  const parsedReleaseChannel = normalizeParsedReleaseChannel(readValue('HAPPIER_PUBLIC_RELEASE_CHANNEL'));
  return {
    serverId: parsedServerId,
    happierHomeDir: parsedHappierHomeDir,
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
    return [];
  }

  return fileNames
    .map((fileName) => join(servicesDir, fileName))
    .flatMap((path) => {
      const parsed = parseInstalledServicePath(params.platform, path);
      if (!parsed) {
        return [];
      }
      if (!isValidInstalledDaemonServiceFile({
        platform: params.platform,
        path,
        expectedLabel: parsed.label,
      })) {
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
      const name = metadata.targetMode === 'default-following'
        ? 'Default background service'
        : typeof profile === 'object' && profile && !Array.isArray(profile) && typeof (profile as { name?: unknown }).name === 'string'
          ? String((profile as { name: string }).name).trim() || resolvedServerId
          : resolvedServerId;
      return [{
        serverId: resolvedServerId,
        name,
        installed: true as const,
        path,
        platform: params.platform,
        mode: params.mode,
        happierHomeDir: metadata.happierHomeDir,
        releaseChannel: metadata.releaseChannel,
        label: parsed.label,
        targetMode: metadata.targetMode,
      }];
    });
}
