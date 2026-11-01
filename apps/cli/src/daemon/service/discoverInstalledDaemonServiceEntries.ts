import * as fs from 'node:fs';
import {
  buildListWindowsScheduledTaskFolderPowerShellCommand,
  isWindowsScheduledTaskLauncherActionExpected,
  parsePowerShellQuotedString,
  parseWindowsScheduledTaskFolderPowerShellJson,
  resolveInstalledWindowsServiceLauncherPaths,
  runWindowsScheduledTaskQuery,
  validateWindowsServiceLauncherPe,
} from '@happier-dev/cli-common/service';
import { basename, join, win32 as win32Path } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { happierHomeDirsMatch } from '@/daemon/ownership/happierHomeDirComparableKey';

import {
  DAEMON_SERVICE_AUTOSTART_ENV_KEY,
  DAEMON_SERVICE_BUNDLE_ID_ENV_KEY,
  DAEMON_SERVICE_MANAGED_BY_ENV_KEY,
  parseDaemonServiceBundleId,
  type DaemonServiceAutostartMode,
  type DaemonServiceManagedBy,
  type DaemonServiceMode,
  type DaemonServiceTargetMode,
} from './plan';
import { resolveDaemonWindowsServiceLauncherInstallSpec } from './windowsServiceLauncher';

export type InstalledDaemonServiceEntry = Readonly<{
  serverId: string;
  activeServerId?: string | null;
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
  /** `desktop` when the definition carries the desktop marker; `null` (user-owned) otherwise. */
  managedBy?: DaemonServiceManagedBy | null;
  /** True when the registered task does not have a validated current native launcher action. */
  windowsLauncherUpgradeNeeded?: boolean;
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

function isLegacyEnvHashServiceId(serverId: string): boolean {
  return /^env_[0-9a-f]+$/iu.test(String(serverId ?? '').trim());
}

function resolveDiscoveredServiceIdentity(params: Readonly<{
  parsed: InstalledServicePathMatch;
  activeServerId: string | null;
}>): string {
  if (
    params.parsed.targetMode === 'pinned'
    && params.activeServerId
    && isLegacyEnvHashServiceId(params.parsed.serverId)
  ) {
    return params.activeServerId;
  }
  return params.parsed.serverId;
}

function readInstalledServiceFile(path: string, requireReadable = false): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (error) {
    if (requireReadable && !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw inventoryUnavailable(error);
    }
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

/** A `<true/>`/`<false/>` plist key, or `null` when the definition declares neither. */
function parseDarwinPlistBoolean(contents: string, key: string): boolean | null {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`, 'i').exec(contents);
  const value = String(match?.[1] ?? '').trim().toLowerCase();
  return value === 'true' ? true : value === 'false' ? false : null;
}

function parseWindowsWrapperValue(contents: string, key: string): string | null {
  const match = new RegExp(`^\\$env:${key}\\s*=\\s*(.+)$`, 'im').exec(contents);
  return match ? parsePowerShellQuotedString(match[1])?.trim() || null : null;
}

function normalizeWindowsScheduledTaskName(taskName: string): string | null {
  const normalized = String(taskName ?? '')
    .trim()
    .replaceAll('/', '\\')
    .replace(/\\+/gu, '\\')
    .replace(/^\\+/u, '');
  return normalized || null;
}

type WindowsScheduledTaskDefinition = Readonly<{
  wrapperPath: string;
  actionKind: 'native-launcher' | 'legacy-powershell';
  launcherPath?: string;
  /** Registered arguments of a native-launcher action, compared exactly against the expected action. */
  launcherArguments?: string;
  /** XML proves the full action set; the localized LIST fallback does not expose its shape. */
  hasSingleExecAction?: boolean;
}>;

function decodeWindowsTaskXmlText(value: string): string {
  return String(value ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', '\'')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function parseWindowsScheduledTaskDefinitionFromAction(executable: string, argumentsText: string): WindowsScheduledTaskDefinition | null {
  const argumentsValue = String(argumentsText ?? '').trim();
  const nativeQuoted = /--wrapper\s+"([^"]+\.ps1)"/iu.exec(argumentsValue);
  const nativeBare = /--wrapper\s+([^\s]+\.ps1)/iu.exec(argumentsValue);
  const nativeWrapperPath = nativeQuoted?.[1]?.trim() || nativeBare?.[1]?.trim() || null;
  if (nativeWrapperPath) {
    return {
      wrapperPath: nativeWrapperPath,
      actionKind: 'native-launcher',
      launcherPath: String(executable ?? '').trim().replace(/^"|"$/gu, ''),
      launcherArguments: argumentsValue,
    };
  }

  const legacyQuoted = /-File\s+"([^"]+\.ps1)"/iu.exec(argumentsValue);
  const legacyBare = /-File\s+([^\s]+\.ps1)/iu.exec(argumentsValue);
  const legacyWrapperPath = legacyQuoted?.[1]?.trim() || legacyBare?.[1]?.trim() || null;
  return legacyWrapperPath
    ? { wrapperPath: legacyWrapperPath, actionKind: 'legacy-powershell' }
    : null;
}

function parseWindowsScheduledTaskDefinitionFromXml(contents: string): WindowsScheduledTaskDefinition | null {
  const actions = /<Actions\b[^>]*>([\s\S]*?)<\/Actions>/iu.exec(String(contents ?? ''))?.[1];
  const execAction = /<Exec\b[^>]*>([\s\S]*?)<\/Exec>/iu.exec(actions ?? '');
  if (!execAction) return null;
  const executable = decodeWindowsTaskXmlText(
    /<Command>([\s\S]*?)<\/Command>/iu.exec(execAction[1] ?? '')?.[1] ?? '',
  );
  const argumentsMatch = /<Arguments>([\s\S]*?)<\/Arguments>/iu.exec(execAction[1] ?? '');
  if (!argumentsMatch) return null;
  const definition = parseWindowsScheduledTaskDefinitionFromAction(
    executable,
    decodeWindowsTaskXmlText(argumentsMatch[1] ?? ''),
  );
  return definition ? { ...definition, hasSingleExecAction: actions?.trim() === execAction[0] } : null;
}

function parseWindowsScheduledTaskDefinitionFromTaskToRun(taskToRunText: string): WindowsScheduledTaskDefinition | null {
  const taskToRun = String(taskToRunText ?? '').trim();
  if (!taskToRun) return null;
  // `schtasks /FO LIST /V` reports the action as one localized field among many, so locate the
  // native action by its own shape on its line instead of by field label.
  for (const line of taskToRun.split(/\r?\n/u)) {
    const nativeAction = /("?(?:[A-Za-z]:)?[\\/][^"\r\n]*?happier-service-launcher\.exe"?)\s+(--wrapper\s.*)$/iu.exec(line);
    if (nativeAction) {
      return parseWindowsScheduledTaskDefinitionFromAction(nativeAction[1] ?? '', nativeAction[2] ?? '');
    }
  }
  return parseWindowsScheduledTaskDefinitionFromAction('', taskToRun);
}

function isInstalledWindowsLauncherActionHealthy(definition: WindowsScheduledTaskDefinition): boolean {
  if (definition.actionKind !== 'native-launcher' || !definition.launcherPath || definition.hasSingleExecAction === false) return false;
  const expected = resolveInstalledWindowsServiceLauncherPaths({
    definitionPath: definition.wrapperPath,
    label: win32Path.basename(definition.wrapperPath, '.ps1'),
    version: resolveDaemonWindowsServiceLauncherInstallSpec().version,
  });
  if (!isWindowsScheduledTaskLauncherActionExpected({
    taskToRun: `${definition.launcherPath} ${definition.launcherArguments ?? ''}`,
    launcherPath: expected.launcherPath,
    definitionPath: definition.wrapperPath,
    diagnosticLogPath: expected.diagnosticLogPath,
  })) return false;
  try {
    validateWindowsServiceLauncherPe(fs.readFileSync(expected.launcherPath), expected.launcherPath);
    return true;
  } catch {
    return false;
  }
}

function readWindowsScheduledTaskDefinition(taskName: string): WindowsScheduledTaskDefinition | null {
  const normalizedTaskName = normalizeWindowsScheduledTaskName(taskName);
  if (!normalizedTaskName) return null;

  const result = runWindowsScheduledTaskQuery('schtasks', ['/Query', '/TN', normalizedTaskName, '/XML']);
  const xmlDefinition = !result.error && result.status === 0
    ? parseWindowsScheduledTaskDefinitionFromXml(String(result.stdout ?? '')) : null;
  if (xmlDefinition) return xmlDefinition;
  const fallback = runWindowsScheduledTaskQuery('schtasks', ['/Query', '/TN', normalizedTaskName, '/FO', 'LIST', '/V']);
  const listDefinition = !fallback.error && fallback.status === 0
    ? parseWindowsScheduledTaskDefinitionFromTaskToRun(String(fallback.stdout ?? '')) : null;
  if (listDefinition) return listDefinition;

  // Failed detail reads cannot prove absence. A successful listing can establish that a task
  // disappeared between enumeration and inspection, without parsing localized error messages.
  try {
    if (!listWindowsScheduledTaskNames().some((name) => name.toLowerCase() === normalizedTaskName.toLowerCase())) return null;
  } catch (error) {
    throw new Error(`Could not inspect Happier scheduled task ${normalizedTaskName}`, { cause: error });
  }
  throw new Error(`Could not inspect Happier scheduled task ${normalizedTaskName}: ${String(fallback.stderr ?? result.stderr ?? '').trim() || 'its wrapper could not be read'}`, { cause: fallback.error ?? result.error });
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

function listWindowsScheduledTaskNames(): readonly string[] {
  // Only the Happier folder: enumerating every task on the machine can outlast the timeout.
  const result = runWindowsScheduledTaskQuery('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    buildListWindowsScheduledTaskFolderPowerShellCommand({ taskFolder: '\\Happier\\' }),
  ]);
  if (result.error) throw result.error;
  const taskPaths = result.status === 0 ? parseWindowsScheduledTaskFolderPowerShellJson(String(result.stdout ?? '')) : null;
  if (!taskPaths) {
    throw new Error(`Could not enumerate Happier scheduled tasks: ${String(result.stderr ?? '').trim() || `powershell exited with status ${result.status}`}`);
  }

  return taskPaths
    .map((taskName) => normalizeWindowsScheduledTaskName(taskName))
    .filter((taskName): taskName is string => Boolean(taskName))
    .filter((taskName) => taskName.toLowerCase().startsWith('happier\\happier-daemon'));
}

function listWindowsScheduledTaskDefinitions(): readonly (WindowsScheduledTaskDefinition & Readonly<{ taskName: string }>)[] {
  return listWindowsScheduledTaskNames()
    .map((taskName) => {
      try {
        const definition = readWindowsScheduledTaskDefinition(taskName);
        return definition ? { ...definition, taskName } : null;
      } catch (cause) {
        throw new Error(`Could not inspect Happier scheduled task ${taskName}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
    })
    .filter((definition): definition is WindowsScheduledTaskDefinition & Readonly<{ taskName: string }> => Boolean(definition));
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
  // Proving absence requires a missing definition, not an unreadable one. Optional metadata
  // readers retain their nullable unknown result through the same file reader.
  const contents = readInstalledServiceFile(params.path, true);
  return contents ? isValidInstalledDaemonServiceDefinition(params, contents) : false;
}

/** Task names are global to the login, so its registered wrapper decides before a local file. */
export function resolveInstalledDaemonServiceDefinitionPath(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32'; path: string; taskName: string;
}>): string {
  return params.platform === 'win32'
    ? readWindowsScheduledTaskDefinition(params.taskName)?.wrapperPath ?? params.path
    : params.path;
}

export function readInstalledDaemonServiceHomeDir(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32'; path: string;
}>): string | null {
  return readInstalledDaemonServiceEnvValue({ ...params, key: 'HAPPIER_HOME_DIR' })
    ?? readInstalledDaemonServiceEnvValue({ ...params, key: 'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR' });
}

export function isInstalledDaemonServiceForHappierHome(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32'; path: string; expectedLabel: string; happierHomeDir: string;
}>): boolean {
  return isValidInstalledDaemonServiceFile(params)
    && happierHomeDirsMatch(readInstalledDaemonServiceHomeDir(params), params.happierHomeDir);
}

function isValidInstalledDaemonServiceDefinition(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  expectedLabel: string;
}>, contents: string): boolean {
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

/**
 * The one rule for reading an installed service definition's target mode.
 *
 * The definition declares the mode the installer chose, so that declaration decides. The file
 * name is only the fallback for a definition that predates the declaration: it cannot decide on
 * its own, because a stable-ring service pinned to the profile named `default` occupies exactly
 * the file name the default-following installation uses.
 */
function resolveInstalledDaemonServiceTargetMode(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  pathTargetMode: DaemonServiceTargetMode;
}>): DaemonServiceTargetMode {
  const declared = readInstalledDaemonServiceEnvValue({
    platform: params.platform,
    path: params.path,
    key: 'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  });
  if (declared === 'default-following' || declared === 'pinned') {
    return declared;
  }
  return params.pathTargetMode;
}

/** The management marker a definition carries; anything but `desktop` reads as none (user-owned). */
export function readInstalledDaemonServiceManagedBy(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
}>): DaemonServiceManagedBy | null {
  const value = readInstalledDaemonServiceEnvValue({ ...params, key: DAEMON_SERVICE_MANAGED_BY_ENV_KEY });
  return value === 'desktop' ? 'desktop' : null;
}

/** R16 — the desktop app bundle a managed definition records; `null` when none (or unreadable). */
export function readInstalledDaemonServiceBundleId(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
}>): string | null {
  const value = readInstalledDaemonServiceEnvValue({ ...params, key: DAEMON_SERVICE_BUNDLE_ID_ENV_KEY });
  try {
    return parseDaemonServiceBundleId(value);
  } catch {
    return null;
  }
}

/**
 * The autostart mode of the service installed at `path`, or `null` when nothing proves one —
 * every definition written before the autostart dimension existed proves none, and `null` is
 * unknown rather than a mode a caller may act on.
 *
 * On darwin the login trigger IS the plist's own `RunAtLoad`, so that key decides: the recorded
 * declaration cannot outvote what launchd will actually do, which is what makes a hand-edited or
 * `launchctl`-rewritten plist report honestly. Linux and Windows keep the recorded declaration,
 * because their real trigger is a systemd enable symlink / a scheduled-task trigger and reading
 * either needs a `systemctl is-enabled` / `schtasks /Query` subprocess — this reader is
 * synchronous and runs on the healthy `daemon status` fast path, so it does not spawn one.
 *
 * This is the one rule for recovering the mode of an installed service, so a reinstall,
 * drift-refresh or repair preserves the choice the user made instead of silently restoring the
 * login trigger.
 */
export function readInstalledDaemonServiceAutostartMode(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
}>): DaemonServiceAutostartMode | null {
  if (params.platform === 'darwin') {
    const contents = readInstalledServiceFile(params.path);
    const runAtLoad = contents ? parseDarwinPlistBoolean(contents, 'RunAtLoad') : null;
    if (runAtLoad !== null) {
      return runAtLoad ? 'at-login' : 'on-demand';
    }
    return null;
  }

  const declared = readInstalledDaemonServiceEnvValue({
    platform: params.platform,
    path: params.path,
    key: DAEMON_SERVICE_AUTOSTART_ENV_KEY,
  });
  const normalized = String(declared ?? '').trim().toLowerCase();
  if (normalized === 'on-demand' || normalized === 'at-login') {
    return normalized;
  }
  return null;
}

/**
 * The target mode of the service definition installed at `path`, or `null` when this path holds
 * no readable Happier service definition. `null` is unknown — never a mode a caller may act on.
 */
export function readInstalledDaemonServiceTargetMode(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
}>): DaemonServiceTargetMode | null {
  const parsed = parseInstalledServicePath(params.platform, params.path);
  if (!parsed) {
    return null;
  }
  const contents = readInstalledServiceFile(params.path);
  if (!contents || !isValidInstalledDaemonServiceDefinition({
    platform: params.platform,
    path: params.path,
    expectedLabel: parsed.label,
  }, contents)) {
    return null;
  }
  return resolveInstalledDaemonServiceTargetMode({
    platform: params.platform,
    path: params.path,
    pathTargetMode: parsed.targetMode,
  });
}

function parseInstalledServiceMetadata(params: Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  path: string;
  initialReleaseChannel: PublicReleaseRingId;
  initialTargetMode: DaemonServiceTargetMode;
}>): Readonly<{
  activeServerId: string | null;
  happierHomeDir: string | null;
  relayUrl: string | null;
  releaseChannel: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
}> {
  const contents = readInstalledServiceFile(params.path);
  if (!contents) {
    return {
      activeServerId: null,
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

  const parsedServerId = readValue('HAPPIER_ACTIVE_SERVER_ID');
  const parsedHappierHomeDir = readInstalledDaemonServiceHomeDir(params);
  const parsedRelayUrl = readValue('HAPPIER_PUBLIC_SERVER_URL') ?? readValue('HAPPIER_SERVER_URL');
  const parsedReleaseChannel = normalizeParsedReleaseChannel(readValue('HAPPIER_PUBLIC_RELEASE_CHANNEL'));
  return {
    activeServerId: parsedServerId,
    happierHomeDir: parsedHappierHomeDir,
    relayUrl: parsedRelayUrl,
    releaseChannel: parsedReleaseChannel ?? params.initialReleaseChannel,
    targetMode: resolveInstalledDaemonServiceTargetMode({
      platform: params.platform,
      path: params.path,
      pathTargetMode: params.initialTargetMode,
    }),
  };
}

function inventoryUnavailable(cause: unknown): Error & Readonly<{ code: 'service_inventory_unavailable' }> {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return Object.assign(new Error(
    `This computer's background services could not be listed. Check access to the service directory and OS service manager, then try again.\n${detail}`,
    { cause },
  ), { code: 'service_inventory_unavailable' as const });
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
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      if (params.platform !== 'win32') return [];
    } else {
      throw inventoryUnavailable(error);
    }
  }

  let scheduledTaskDefinitions: readonly (WindowsScheduledTaskDefinition & Readonly<{ taskName: string }>)[] = [];
  try {
    if (params.platform === 'win32') scheduledTaskDefinitions = listWindowsScheduledTaskDefinitions();
  } catch (error) {
    throw inventoryUnavailable(error);
  }
  const discoveredCandidates: Array<{
    path: string;
    source: 'file' | 'task';
    windowsLauncherUpgradeNeeded?: boolean;
  }> = [
    ...scheduledTaskDefinitions.map((definition) => ({
      path: definition.wrapperPath,
      source: 'task' as const,
      windowsLauncherUpgradeNeeded: !isInstalledWindowsLauncherActionHealthy(definition),
    })),
    ...fileNames.map((fileName) => ({ path: join(servicesDir, fileName), source: 'file' as const })),
  ].filter((candidate, index, allCandidates) => allCandidates.findIndex((other) => other.path === candidate.path) === index);

  return discoveredCandidates
    .flatMap(({ path, source, windowsLauncherUpgradeNeeded }) => {
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
      const activeServerId = String(metadata.activeServerId ?? '').trim() || null;
      const serviceServerId = resolveDiscoveredServiceIdentity({ parsed, activeServerId });
      const profileServerId = activeServerId ?? serviceServerId;
      const profile = params.serversById[profileServerId];
      const profileRelayUrl = typeof profile === 'object'
        && profile
        && !Array.isArray(profile)
        && typeof (profile as { serverUrl?: unknown }).serverUrl === 'string'
          ? String((profile as { serverUrl: string }).serverUrl).trim() || null
          : null;
      const name = metadata.targetMode === 'default-following'
        ? 'Default automatic startup'
        : typeof profile === 'object' && profile && !Array.isArray(profile) && typeof (profile as { name?: unknown }).name === 'string'
          ? String((profile as { name: string }).name).trim() || profileServerId
          : profileServerId;
      return [{
        serverId: serviceServerId,
        ...(activeServerId ? { activeServerId } : {}),
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
        managedBy: readInstalledDaemonServiceManagedBy({ platform: params.platform, path }),
        ...(typeof windowsLauncherUpgradeNeeded === 'boolean' ? { windowsLauncherUpgradeNeeded } : {}),
      }];
    });
}
