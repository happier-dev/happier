import * as fs from 'node:fs';
import { join } from 'node:path';

import { discoverHappierServices, happierHomeDirsMatch, isDaemonStartSyncCommand, readWindowsScheduledTaskWrapperPath } from '@happier-dev/cli-common/happierRuntime';

import {
  parseLaunchdPlist,
  parseSystemdUnit,
  parseWindowsScheduledTaskWrapperPs1,
  type ParsedLaunchdPlist,
  type ParsedSystemdUnit,
  type ParsedWindowsScheduledTaskWrapperPs1,
} from '@happier-dev/cli-common/service';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  DAEMON_SERVICE_MANAGED_BY_ENV_KEY,
  DAEMON_SERVICE_AUTOSTART_ENV_KEY,
  DAEMON_SERVICE_BUNDLE_ID_ENV_KEY,
  parseDaemonServiceBundleId,
  type DaemonServiceAutostartMode,
  type DaemonServiceManagedBy,
  type DaemonServiceMode,
  type DaemonServiceTargetMode,
} from './plan';

export type InstalledDaemonServiceEntry = Readonly<{
  serverId: string;
  activeServerId?: string | null;
  name: string;
  relayUrl?: string | null;
  installed: true;
  verification: 'verified' | 'candidate';
  path: string;
  platform: 'darwin' | 'linux' | 'win32';
  mode?: DaemonServiceMode;
  happierHomeDir?: string | null;
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
  /** `desktop` when the definition carries the desktop marker; `null` (user-owned) otherwise. */
  managedBy?: DaemonServiceManagedBy | null;
}>;

function isLegacyEnvHashServiceId(serverId: string): boolean {
  return /^env_[0-9a-f]+$/iu.test(String(serverId ?? '').trim());
}

function readInstalledServiceFile(path: string, requireReadable: boolean): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (cause) {
    if (requireReadable && !(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) {
      throw Object.assign(new Error('Background service inventory could not be read', { cause }), {
        code: 'service_inventory_unavailable' as const,
      });
    }
    return null;
  }
}

type ParsedInstalledDaemonServiceDefinition =
  | ParsedLaunchdPlist
  | ParsedSystemdUnit
  | ParsedWindowsScheduledTaskWrapperPs1;

function parseInstalledDaemonServiceDefinition(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  contents: string;
}>): ParsedInstalledDaemonServiceDefinition | null {
  if (params.platform === 'darwin') {
    return parseLaunchdPlist({ contents: params.contents, sourcePath: params.path });
  }
  if (params.platform === 'linux') {
    return parseSystemdUnit({ contents: params.contents, sourcePath: params.path });
  }
  return parseWindowsScheduledTaskWrapperPs1({ contents: params.contents, sourcePath: params.path });
}

function readInstalledDaemonServiceDefinition(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  requireReadable?: boolean;
}>): ParsedInstalledDaemonServiceDefinition | null {
  const contents = readInstalledServiceFile(params.path, params.requireReadable === true);
  return contents === null
    ? null
    : parseInstalledDaemonServiceDefinition({ ...params, contents });
}

function readParsedServiceEnvValue(
  definition: ParsedInstalledDaemonServiceDefinition | null,
  key: string,
): string | null {
  const normalizedKey = String(key ?? '').trim();
  if (!normalizedKey) return null;
  const value = String(definition?.env[normalizedKey] ?? '').trim();
  return value || null;
}

function hasLegacyManagedServiceEnv(definition: ParsedInstalledDaemonServiceDefinition | null): boolean {
  return readParsedServiceEnvValue(definition, 'HAPPIER_HOME_DIR') !== null
    || readParsedServiceEnvValue(definition, 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR') !== null;
}

function isValidInstalledDaemonServiceDefinition(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  expectedLabel: string;
  definition: ParsedInstalledDaemonServiceDefinition | null;
}>): boolean {
  const { definition } = params;
  if (!definition || !isDaemonStartSyncCommand(definition.programArgs)) {
    return false;
  }
  if (params.platform === 'darwin' && definition.label !== params.expectedLabel) {
    return false;
  }
  return readParsedServiceEnvValue(definition, 'HAPPIER_DAEMON_STARTUP_SOURCE') === 'background-service'
    || hasLegacyManagedServiceEnv(definition);
}

export function readInstalledDaemonServiceEnvValue(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  key: string;
}>): string | null {
  return readParsedServiceEnvValue(readInstalledDaemonServiceDefinition(params), params.key);
}

/** The management marker a definition carries; anything but `desktop` reads as none (user-owned). */
export function readInstalledDaemonServiceManagedBy(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
}>): DaemonServiceManagedBy | null {
  const value = readInstalledDaemonServiceEnvValue({ ...params, key: DAEMON_SERVICE_MANAGED_BY_ENV_KEY });
  return value === 'desktop' ? 'desktop' : null;
}

/** Definition-owned metadata only: inherited install requests cannot change a rewrite. */
export function readInstalledDaemonServiceBundleId(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
}>): string | null {
  try {
    return parseDaemonServiceBundleId(readInstalledDaemonServiceEnvValue({ ...params, key: DAEMON_SERVICE_BUNDLE_ID_ENV_KEY }));
  } catch {
    return null;
  }
}

/** The declared trigger; real OS enablement is observed by readBackgroundServiceAutostartMode. */
export function readInstalledDaemonServiceAutostartMode(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
}>): DaemonServiceAutostartMode | null {
  const definition = readInstalledDaemonServiceDefinition(params);
  if (!definition) return null;
  if (definition.kind === 'launchd-plist') {
    return definition.runAtLoad || definition.keepAliveOnFailure ? 'at-login' : 'on-demand';
  }
  const value = readParsedServiceEnvValue(definition, DAEMON_SERVICE_AUTOSTART_ENV_KEY);
  return value === 'at-login' || value === 'on-demand' ? value : null;
}

/** Preserve optional defaults without adding a new marker to an unchanged legacy terminal install. */
export function readInstalledDaemonServiceInstallOptions(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
}>): Readonly<{ bundleId: string | null; autostart: DaemonServiceAutostartMode | undefined }> {
  const mode = readInstalledDaemonServiceAutostartMode(params);
  const recorded = readInstalledDaemonServiceEnvValue({ ...params, key: DAEMON_SERVICE_AUTOSTART_ENV_KEY });
  return {
    bundleId: readInstalledDaemonServiceBundleId(params),
    autostart: mode && (recorded || mode === 'on-demand') ? mode : undefined,
  };
}

export function isValidInstalledDaemonServiceFile(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  expectedLabel: string;
}>): boolean {
  return isValidInstalledDaemonServiceDefinition({
    platform: params.platform,
    expectedLabel: params.expectedLabel,
    definition: readInstalledDaemonServiceDefinition({ ...params, requireReadable: true }),
  });
}

/** A registered Windows task decides which wrapper owns its global task name. */
export function resolveInstalledDaemonServiceDefinitionPath(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32'; path: string; taskName: string;
}>): string {
  return params.platform === 'win32' ? readWindowsScheduledTaskWrapperPath(params.taskName) ?? params.path : params.path;
}

export function readInstalledDaemonServiceHomeDir(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32'; path: string;
}>): string | null {
  const definition = readInstalledDaemonServiceDefinition(params);
  return readParsedServiceEnvValue(definition, 'HAPPIER_HOME_DIR')
    ?? readParsedServiceEnvValue(definition, 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR');
}

export function isInstalledDaemonServiceForHappierHome(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32'; path: string; expectedLabel: string; happierHomeDir: string;
}>): boolean {
  const definition = readInstalledDaemonServiceDefinition({ ...params, requireReadable: true });
  const homeDir = readParsedServiceEnvValue(definition, 'HAPPIER_HOME_DIR')
    ?? readParsedServiceEnvValue(definition, 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR');
  return isValidInstalledDaemonServiceDefinition({ ...params, definition })
    && happierHomeDirsMatch(homeDir, params.happierHomeDir, params.platform);
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

  const { services } = await discoverHappierServices({
    platform: params.platform,
    roots: [{ path: servicesDir, scope: params.mode }],
    deep: true,
  });

  return services.flatMap((service): InstalledDaemonServiceEntry[] => {
    if (service.serviceType !== 'daemon' || !service.installed) return [];
    if (service.verification === 'verified'
      && service.startupSource !== 'background-service' && !service.happierHomeDir) return [];

    const activeServerId = service.activeServerId ?? null;
    const targetMode = service.targetMode ?? 'pinned';
    const instanceId = service.serviceInstanceId ?? 'default';
    const serviceServerId = targetMode === 'pinned' && activeServerId && isLegacyEnvHashServiceId(instanceId)
      ? activeServerId
      : instanceId;
    const profileServerId = activeServerId ?? serviceServerId;
    const profile = params.serversById[profileServerId];
    const profileRelayUrl = typeof profile === 'object'
      && profile
      && !Array.isArray(profile)
      && typeof (profile as { serverUrl?: unknown }).serverUrl === 'string'
        ? String((profile as { serverUrl: string }).serverUrl).trim() || null
        : null;
    const name = targetMode === 'default-following'
      ? 'Default automatic startup'
      : typeof profile === 'object' && profile && !Array.isArray(profile) && typeof (profile as { name?: unknown }).name === 'string'
        ? String((profile as { name: string }).name).trim() || profileServerId
        : profileServerId;
    return [{
      serverId: serviceServerId,
      ...(activeServerId ? { activeServerId } : {}),
      name,
      relayUrl: service.publicServerUrl ?? service.serverUrl ?? profileRelayUrl,
      installed: service.installed,
      verification: service.verification,
      path: service.definitionPath,
      platform: params.platform,
      mode: params.mode,
      happierHomeDir: service.happierHomeDir ?? null,
      releaseChannel: service.ring === 'dev' ? 'publicdev' : service.ring ?? 'stable',
      label: params.platform === 'win32' ? `Happier\\${service.label}` : service.label,
      targetMode,
      managedBy: service.managedBy ?? null,
    }];
  });
}
