import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createServerUrlComparableKey } from '@happier-dev/protocol';

import { readSettings } from '@/persistence';
import {
  discoverInstalledDaemonServiceEntries,
  readInstalledDaemonServiceEnvValue,
  type InstalledDaemonServiceEntry,
} from '@/daemon/service/discoverInstalledDaemonServiceEntries';
import { type DaemonStartupSource, isDaemonStartupSourceServiceManaged } from '@/daemon/ownership/daemonOwnershipMetadata';
import { resolveHappierHomeDirComparableKey } from '@/daemon/ownership/happierHomeDirComparableKey';
import { resolveDaemonServicePaths, type DaemonServiceCliRuntime, type DaemonServiceListEntry } from '@/daemon/service/cli';
import type { DaemonServiceMode } from '@/daemon/service/plan';

function resolveDiscoveryModes(platform: DaemonServiceCliRuntime['platform']): readonly DaemonServiceMode[] {
  return platform === 'linux' ? ['user', 'system'] : ['user'];
}

async function discoverInstalledEntriesForMode(
  runtime: DaemonServiceCliRuntime,
  mode: DaemonServiceMode,
): Promise<readonly InstalledDaemonServiceEntry[]> {
  const settings = await readSettings();
  return await discoverInstalledDaemonServiceEntries({
    platform: runtime.platform,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
    mode,
    serversById: (settings.servers ?? {}) as Readonly<Record<string, unknown>>,
  });
}

function normalizeComparableServerUrl(url: string | null | undefined): string | null {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return null;
  try {
    return createServerUrlComparableKey(trimmed);
  } catch {
    return null;
  }
}

type SettingsSnapshot = Readonly<{
  activeServerId: string;
  servers: Readonly<Record<string, SettingsServerSnapshot>>;
}>;

type SettingsServerSnapshot = Readonly<{
  id?: string;
  serverUrl?: string;
  localServerUrl?: string | null;
  name?: string;
}>;

function isSettingsServerSnapshot(value: unknown): value is SettingsServerSnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInstalledServiceEnvValue(
  entry: Pick<InstalledDaemonServiceEntry, 'platform' | 'path'>,
  key: string,
): string | null {
  let contents = '';
  try {
    contents = readFileSync(entry.path, 'utf8');
  } catch {
    return null;
  }

  const match =
    entry.platform === 'linux'
      ? new RegExp(`Environment=${key}=([^\\n\\r]+)`, 'i').exec(contents)
      : entry.platform === 'darwin'
        ? new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, 'i').exec(contents)
        : new RegExp(`\\$env:${key}\\s*=\\s*['"]([^'"]+)['"]`, 'i').exec(contents);

  const value = String(match?.[1] ?? '').trim();
  return value || null;
}

function normalizeSettingsSnapshot(value: unknown): SettingsSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const activeServerId = String((value as { activeServerId?: unknown }).activeServerId ?? '').trim();
  const rawServers = (value as { servers?: unknown }).servers;
  if (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
    return null;
  }

  const servers: Record<string, SettingsServerSnapshot> = {};
  for (const [serverId, server] of Object.entries(rawServers as Record<string, unknown>)) {
    if (!isSettingsServerSnapshot(server)) {
      continue;
    }
    servers[serverId] = server;
  }

  return {
    activeServerId,
    servers,
  };
}

function readSettingsSnapshotForHomeDir(homeDir: string | null | undefined): SettingsSnapshot | null {
  const resolvedHomeDir = String(homeDir ?? '').trim();
  if (!resolvedHomeDir) return null;

  try {
    const parsed = JSON.parse(readFileSync(join(resolvedHomeDir, 'settings.json'), 'utf8'));
    return normalizeSettingsSnapshot(parsed);
  } catch {
    return null;
  }
}

function resolveDefaultFollowingRelayMatchFromSettings(
  settings: SettingsSnapshot | null,
  runtime: DaemonServiceCliRuntime,
): boolean {
  const activeServerId = String(settings?.activeServerId ?? '').trim() || 'cloud';
  const activeServer = settings?.servers?.[activeServerId];
  if (!activeServer) {
    return runtime.instanceId === 'cloud';
  }

  if (runtime.instanceId !== activeServer.id) {
    return false;
  }

  const currentRelayKey = normalizeComparableServerUrl(runtime.serverUrl);
  if (!currentRelayKey) {
    return true;
  }

  const activeRelayKeys = [
    normalizeComparableServerUrl(activeServer.serverUrl),
    normalizeComparableServerUrl(activeServer.localServerUrl ?? null),
  ].filter((value): value is string => Boolean(value));

  return activeRelayKeys.length === 0 || activeRelayKeys.includes(currentRelayKey);
}

async function resolveDefaultFollowingRelayMatch(
  runtime: DaemonServiceCliRuntime,
): Promise<boolean> {
  const settings = await readSettings().catch(() => null);
  return resolveDefaultFollowingRelayMatchFromSettings(normalizeSettingsSnapshot(settings), runtime);
}

function resolveInstalledServiceHomeDir(entry: InstalledDaemonServiceEntry): string | null {
  return parseInstalledServiceEnvValue(entry, 'HAPPIER_HOME_DIR')
    ?? parseInstalledServiceEnvValue(entry, 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR');
}

async function resolveDefaultFollowingRelayMatchForInstalledService(
  entry: InstalledDaemonServiceEntry,
  runtime: DaemonServiceCliRuntime,
): Promise<boolean> {
  const serviceHomeDir = resolveInstalledServiceHomeDir(entry);
  if (!serviceHomeDir) {
    return await resolveDefaultFollowingRelayMatch(runtime);
  }

  const serviceSettings = readSettingsSnapshotForHomeDir(serviceHomeDir);
  if (!serviceSettings) {
    return resolveHappierHomeDirComparableKey(serviceHomeDir) === resolveHappierHomeDirComparableKey(runtime.happierHomeDir)
      ? await resolveDefaultFollowingRelayMatch(runtime)
      : false;
  }

  return resolveDefaultFollowingRelayMatchFromSettings(serviceSettings, runtime);
}

export async function resolveInstalledDaemonServiceInventoryForCurrentRelay(
  runtime: DaemonServiceCliRuntime,
): Promise<readonly DaemonServiceListEntry[]> {
  const entries = await Promise.all(
    resolveDiscoveryModes(runtime.platform).map(async (mode) => await discoverInstalledEntriesForMode(runtime, mode)),
  );
  const matchingEntries: InstalledDaemonServiceEntry[] = [];
  for (const entry of entries.flat()) {
    if (entry.targetMode !== 'default-following') {
      if (entry.serverId === runtime.instanceId) {
        matchingEntries.push(entry);
      }
      continue;
    }
    if (await resolveDefaultFollowingRelayMatchForInstalledService(entry, runtime)) {
      matchingEntries.push(entry);
    }
  }
  return matchingEntries.filter(
    (entry, index, allEntries) => allEntries.findIndex((candidate) => candidate.path === entry.path) === index,
  );
}

function describeDaemonServiceInventoryEntry(entry: InstalledDaemonServiceEntry | DaemonServiceListEntry): string {
  return `${entry.label} (${entry.releaseChannel}, ${entry.targetMode}) — ${entry.path}`;
}

export function renderDaemonServiceInventory(entries: readonly DaemonServiceListEntry[]): Readonly<{
  title: string;
  lines: readonly string[];
}> {
  if (entries.length === 0) {
    return {
      title: 'Installed background services for this relay:',
      lines: ['  (none)'],
    };
  }

  return {
    title: 'Installed background services for this relay:',
    lines: entries.map((entry) => `  ${describeDaemonServiceInventoryEntry(entry)}`),
  };
}

export function renderDaemonInstalledServiceConflict(params: Readonly<{
  action: 'session-autostart' | 'daemon-start' | 'daemon-start-sync' | 'daemon-restart';
  services: readonly DaemonServiceListEntry[];
}>): Readonly<{ title: string; lines: readonly string[] }> {
  const actionDescription =
    params.action === 'session-autostart'
      ? 'continue without taking over the background service'
      : params.action === 'daemon-start'
        ? 'start a manual relay runtime'
        : params.action === 'daemon-start-sync'
          ? 'start a manual relay runtime synchronously'
          : 'restart a manual relay runtime';
  const serviceCommand =
    params.action === 'daemon-restart'
      ? 'Use `happier service restart` to switch the installed background service to this installation.'
      : 'Use `happier service start` to start the installed background service instead of starting a new relay runtime.';
  const serviceSummary = renderDaemonServiceInventory(params.services);
  return {
    title: 'A background service is already installed for this relay.',
    lines: [
      ...serviceSummary.lines,
      serviceCommand,
      `If you want to ${actionDescription}, stop or replace the installed background service first.`,
    ],
  };
}

export async function evaluateDaemonStartupServiceConflict(params: Readonly<{
  startupSource: DaemonStartupSource | null | undefined;
  runtime: DaemonServiceCliRuntime;
}>): Promise<Readonly<{ kind: 'none' }> | Readonly<{ kind: 'installed-background-service-conflict'; services: readonly DaemonServiceListEntry[] }>> {
  if (isDaemonStartupSourceServiceManaged(params.startupSource) || params.startupSource === 'self-restart') {
    return { kind: 'none' };
  }

  const services = await resolveInstalledDaemonServiceInventoryForCurrentRelay(params.runtime);
  if (services.length === 0) {
    return { kind: 'none' };
  }

  return { kind: 'installed-background-service-conflict', services };
}

function normalizeServicePathForComparison(path: string, platform: DaemonServiceCliRuntime['platform']): string {
  const trimmed = String(path ?? '').trim();
  if (!trimmed) return '';
  const normalizedSeparators = platform === 'win32'
    ? trimmed.replaceAll('/', '\\')
    : trimmed.replaceAll('\\', '/');
  return platform === 'win32'
    ? normalizedSeparators.toLowerCase()
    : normalizedSeparators;
}

export function hasInstalledBackgroundServiceConflictForCurrentInstallation(params: Readonly<{
  services: readonly DaemonServiceListEntry[];
  runtime: DaemonServiceCliRuntime;
}>): boolean {
  const runtimeHomeComparableKey = resolveHappierHomeDirComparableKey(params.runtime.happierHomeDir);
  for (const service of params.services) {
    const declaredServiceHome = String(service.happierHomeDir ?? '').trim();
    if (declaredServiceHome) {
      const declaredComparableKey = resolveHappierHomeDirComparableKey(declaredServiceHome);
      if (declaredComparableKey && declaredComparableKey === runtimeHomeComparableKey) {
        return true;
      }
    }

    const configuredServiceHome = readInstalledDaemonServiceEnvValue({
      platform: params.runtime.platform,
      path: service.path,
      key: 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
    }) ?? readInstalledDaemonServiceEnvValue({
      platform: params.runtime.platform,
      path: service.path,
      key: 'HAPPIER_HOME_DIR',
    });
    if (configuredServiceHome) {
      const configuredComparableKey = resolveHappierHomeDirComparableKey(configuredServiceHome);
      if (configuredComparableKey && configuredComparableKey === runtimeHomeComparableKey) {
        return true;
      }
    }
  }

  const expectedPaths = resolveDiscoveryModes(params.runtime.platform)
    .map((mode) => resolveDaemonServicePaths(params.runtime, { mode }).installedPath)
    .map((path) => normalizeServicePathForComparison(path, params.runtime.platform));
  if (expectedPaths.length === 0) {
    return false;
  }

  return params.services.some((service) => {
    const servicePath = normalizeServicePathForComparison(service.path, params.runtime.platform);
    return expectedPaths.includes(servicePath);
  });
}
