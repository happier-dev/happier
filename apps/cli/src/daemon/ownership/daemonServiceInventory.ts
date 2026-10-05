import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createServerUrlComparableKey } from '@happier-dev/protocol';

import { readSettings } from '@/persistence';
import {
  discoverInstalledDaemonServiceEntries,
  readInstalledDaemonServiceHomeDir,
  type InstalledDaemonServiceEntry,
} from '@/daemon/service/discoverInstalledDaemonServiceEntries';
import { type DaemonStartupSource, isDaemonStartupSourceServiceManaged } from '@/daemon/ownership/daemonOwnershipMetadata';
import { happierHomeDirsMatch } from '@/daemon/ownership/happierHomeDirComparableKey';
import { type DaemonServiceCliRuntime, type DaemonServiceListEntry } from '@/daemon/service/paths';
import type { DaemonServiceMode } from '@/daemon/service/plan';
import { readBackgroundServiceActivity, type BackgroundServiceActivity } from '@/daemon/service/readBackgroundServiceHealth';

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
  const discoveredHomeDir = String(entry.happierHomeDir ?? '').trim();
  if (discoveredHomeDir) {
    return discoveredHomeDir;
  }
  return readInstalledDaemonServiceHomeDir({
    platform: entry.platform,
    path: entry.path,
  });
}

async function resolveDefaultFollowingRelayMatchForInstalledService(
  entry: InstalledDaemonServiceEntry,
  runtime: DaemonServiceCliRuntime,
): Promise<boolean> {
  const serviceHomeDir = resolveInstalledServiceHomeDir(entry);
  if (!happierHomeDirsMatch(serviceHomeDir, runtime.happierHomeDir, runtime.platform)) return false;

  const serviceSettings = readSettingsSnapshotForHomeDir(serviceHomeDir);
  if (!serviceSettings) {
    return await resolveDefaultFollowingRelayMatch(runtime);
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

/**
 * The pinned services of this Happier home that serve `serverId`. A daemon's lock is per Happier
 * home and server, so such a service is that server's owner (R10 D3): the default-following service
 * yields the server to it rather than compete for the lock. Only a pinned service its manager is
 * running or starting counts (RV3-C3): a stopped one serves nobody, so the default service serves
 * the server as before. `unknown` (the manager could not be asked) still counts, so a failed read
 * never starts a competing daemon.
 */
export function selectPinnedServicesServingServer(params: Readonly<{
  services: readonly DaemonServiceListEntry[];
  runtime: DaemonServiceCliRuntime;
  serverId: string;
  readActivity?: (service: DaemonServiceListEntry) => BackgroundServiceActivity;
}>): readonly DaemonServiceListEntry[] {
  const readActivity = params.readActivity ?? ((service: DaemonServiceListEntry) => readBackgroundServiceActivity({
    platform: service.platform,
    uid: params.runtime.uid,
    label: service.label,
    mode: service.mode ?? null,
  }));
  return params.services.filter((service) => (
    service.targetMode === 'pinned'
    && service.serverId === params.serverId
    && hasInstalledBackgroundServiceConflictForCurrentInstallation({ services: [service], runtime: params.runtime })
    && readActivity(service) !== 'inactive'
  ));
}

/** The pinned services the default-following service stands by for (none for any other service). */
export async function resolveDefaultFollowingStandBy(
  runtime: DaemonServiceCliRuntime,
): Promise<readonly DaemonServiceListEntry[]> {
  if (runtime.targetMode !== 'default-following') return [];
  return selectPinnedServicesServingServer({
    services: await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime),
    runtime,
    serverId: runtime.instanceId,
  });
}

/**
 * Startup of the default-following background service (`start-sync` from its own definition, or
 * its self-restart). It follows whichever server the terminal selects; when that server has this
 * home's pinned service, the pinned one serves it and this one stands by instead of starting a
 * second daemon for the same server. The caller then exits cleanly, which every service manager
 * treats as "stay stopped" (launchd, systemd and Task Scheduler restart only failures), until the
 * service is restarted after the selection changes (`server use` follow-up) or at the next login.
 */
export async function evaluateDefaultFollowingServiceStartup(params: Readonly<{
  startupSource: DaemonStartupSource | null | undefined;
  processEnv: NodeJS.ProcessEnv;
  resolveRuntime: () => DaemonServiceCliRuntime;
}>): Promise<Readonly<{ kind: 'serve' }> | Readonly<{ kind: 'yield-to-pinned-service'; services: readonly DaemonServiceListEntry[] }>> {
  const serviceStartup = isDaemonStartupSourceServiceManaged(params.startupSource) || params.startupSource === 'self-restart';
  if (!serviceStartup || String(params.processEnv.HAPPIER_DAEMON_SERVICE_TARGET_MODE ?? '').trim() !== 'default-following') {
    return { kind: 'serve' };
  }
  const services = await resolveDefaultFollowingStandBy(params.resolveRuntime());
  return services.length > 0 ? { kind: 'yield-to-pinned-service', services } : { kind: 'serve' };
}

export function renderDefaultFollowingServiceStandingBy(params: Readonly<{
  serverId: string;
  services: readonly DaemonServiceListEntry[];
}>): Readonly<{ title: string; lines: readonly string[] }> {
  return {
    title: `Relay ${params.serverId} has its own background service, so the default background service stands by.`,
    lines: [
      ...params.services.map((service) => `  ${describeDaemonServiceInventoryEntry(service)}`),
      'The default background service follows the next relay you select with `happier server use <relay>`.',
    ],
  };
}

export function hasInstalledBackgroundServiceConflictForCurrentInstallation(params: Readonly<{
  services: readonly DaemonServiceListEntry[];
  runtime: DaemonServiceCliRuntime;
}>): boolean {
  return params.services.some((service) => happierHomeDirsMatch(
    service.happierHomeDir ?? readInstalledDaemonServiceHomeDir({ platform: params.runtime.platform, path: service.path }),
    params.runtime.happierHomeDir,
    params.runtime.platform,
  ));
}
