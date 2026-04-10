import * as os from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { configuration } from '@/configuration';
import { readCredentials, readDaemonState, readSettings } from '@/persistence';
import { stopDaemon } from '@/daemon/controlClient';
import { restartDaemonAndWait } from '@/daemon/restartDaemonAndWait';
import { waitForDaemonRunningWithinBudget } from '@/daemon/waitForDaemonRunningWithinBudget';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { isBun } from '@/utils/runtime';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';
import { describeBackgroundServiceTargetMode } from '@happier-dev/cli-common/happierRuntime';
import { errorFrame, kv, neutral, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

import { installDaemonService, uninstallDaemonService } from './installer';
import { runDaemonServiceCommands } from './apply';
import {
  planDaemonServiceInstall,
  planDaemonServiceLifecycle,
  planDaemonServiceUninstall,
  resolveLaunchAgentPlistPath,
  resolveSystemdUserUnitPath,
  resolveSystemdSystemUnitPath,
  resolveWindowsDaemonWrapperPath,
  resolveWindowsDaemonTaskName,
  resolveDaemonServiceLaunchdLabel,
  resolveDaemonServiceSystemdUnitName,
  resolveDaemonServiceChannelSegment,
  type DaemonServiceMode,
  type DaemonServiceTargetMode,
} from './plan';
import { commandExistsInPath } from './commandExistsInPath';
import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget';
import { resolveDaemonServiceInstallRuntimeTarget } from './resolveDaemonServiceInstallRuntimeTarget';
import { resolveLinuxSystemUserPaths } from './resolveLinuxSystemUserPaths';
import { parseDaemonServiceUninstallFlagValue, resolveDaemonServiceUninstallSelection, type DaemonServiceSelectableEntry } from './uninstallSelection';
import { inferPublicReleaseRingIdFromEnvAndArgv } from '@/cli/runtime/publicReleaseChannel';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
import {
  evaluateDaemonServiceLifecycleOwnership,
  renderDaemonServiceStopOwnershipNote,
  renderDaemonServiceLifecycleOwnershipConflict,
} from '@/daemon/ownership/evaluateServiceLifecycleOwnership';
import {
  renderDaemonServiceInventory,
  resolveInstalledDaemonServiceInventoryForCurrentRelay,
} from '@/daemon/ownership/daemonServiceInventory';
import {
  buildDaemonServiceTakeoverHint,
  buildDaemonServiceTakeoverNotice,
  resolveDaemonServiceTakeoverDecision,
} from './resolveDaemonServiceTakeoverDecision';
import { discoverInstalledDaemonServiceEntries, isValidInstalledDaemonServiceFile } from './discoverInstalledDaemonServiceEntries';

export type DaemonServiceCliAction =
  | 'list'
  | 'paths'
  | 'install'
  | 'uninstall'
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'logs'
  | 'tail';

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

function describeCurrentRelayOwner(serviceManaged: boolean | null): string {
  if (serviceManaged === true) {
    return 'background service';
  }
  if (serviceManaged === false) {
    return 'manual relay runtime';
  }
  return 'relay owner';
}

function refreshDarwinLaunchAgentDefinitionForBootstrap(installedPath: string): void {
  const path = String(installedPath ?? '').trim();
  if (!path) {
    return;
  }

  const currentMtimeMs = (() => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  })();
  const refreshTime = new Date(Math.max(Date.now(), currentMtimeMs + 1000));
  utimesSync(path, refreshTime, refreshTime);
}

function resolveSupportedPlatform(p: string): SupportedPlatform | null {
  const normalized = (p ?? '').toString().trim().toLowerCase();
  if (normalized === 'darwin' || normalized === 'mac' || normalized === 'macos' || normalized === 'osx') return 'darwin';
  if (normalized === 'linux') return 'linux';
  if (normalized === 'win32' || normalized === 'windows' || normalized === 'win') return 'win32';
  return null;
}

function resolvePlatformFromProcess(): SupportedPlatform | null {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  return null;
}

function parseCliFlags(argv: readonly string[]): Readonly<{ json: boolean; dryRun: boolean; help: boolean; deep: boolean }> {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  return {
    json: flags.has('--json'),
    dryRun: flags.has('--dry-run') || flags.has('--plan'),
    help: flags.has('--help') || flags.has('-h'),
    deep: flags.has('--deep'),
  };
}

function resolveModeFromText(raw: string, source: string): DaemonServiceMode {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'user' || value === 'system') return value;
  throw new Error(`Invalid ${source} value "${String(raw ?? '').trim()}" (expected user|system)`);
}

function resolveOptionalModeFromText(raw: string, source: string): DaemonServiceMode | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  return resolveModeFromText(value, source);
}

function parseDaemonServiceCliInvocation(argv: readonly string[]): Readonly<{
  argvFiltered: string[];
  flags: Readonly<{
    json: boolean;
    dryRun: boolean;
    help: boolean;
    deep: boolean;
    yes: boolean;
    takeover: boolean;
    replaceExisting: 'ring' | 'all' | null;
    all: boolean;
    ring: PublicReleaseRingId | null;
    instanceId: string | null;
  }>;
  action: DaemonServiceCliAction;
  mode: DaemonServiceMode;
  systemUser: string;
}> {
  const filtered: string[] = [];
  let modeFromArgs: DaemonServiceMode | null = null;
  let systemUserFromArgs: string | null = null;
  let yes = false;
  let takeover = false;
  let replaceExisting: 'ring' | 'all' | null = null;
  let all = false;
  let ring: PublicReleaseRingId | null = null;
  let instanceId: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] ?? '');

    if (a === '--mode') {
      const next = String(argv[i + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --mode (expected user|system)');
      }
      modeFromArgs = resolveModeFromText(next, '--mode');
      i += 1;
      continue;
    }
    if (a.startsWith('--mode=')) {
      modeFromArgs = resolveModeFromText(a.slice('--mode='.length), '--mode');
      continue;
    }
    if (a === '--system') {
      modeFromArgs = 'system';
      continue;
    }
    if (a === '--user') {
      modeFromArgs = 'user';
      continue;
    }
    if (a === '--yes' || a === '-y' || a === '--allow-multiple') {
      yes = true;
      continue;
    }
    if (a === '--takeover') {
      takeover = true;
      continue;
    }
    if (a === '--all') {
      all = true;
      continue;
    }
    if (a === '--ring') {
      const next = String(argv[i + 1] ?? '').trim();
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --ring (expected stable|preview|dev)');
      }
      ring = parseDaemonServiceUninstallFlagValue(next);
      if (!ring) {
        throw new Error(`Invalid --ring value "${next}" (expected stable|preview|dev)`);
      }
      i += 1;
      continue;
    }
    if (a.startsWith('--ring=')) {
      const value = a.slice('--ring='.length);
      ring = parseDaemonServiceUninstallFlagValue(value);
      if (!ring) {
        throw new Error(`Invalid --ring value "${value}" (expected stable|preview|dev)`);
      }
      continue;
    }
    if (a === '--instance') {
      const next = String(argv[i + 1] ?? '').trim();
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --instance');
      }
      instanceId = next;
      i += 1;
      continue;
    }
    if (a.startsWith('--instance=')) {
      instanceId = a.slice('--instance='.length).trim() || null;
      continue;
    }
    if (a === '--replace-existing') {
      const next = String(argv[i + 1] ?? '').trim().toLowerCase();
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --replace-existing (expected ring|all)');
      }
      if (next !== 'ring' && next !== 'all') {
        throw new Error(`Invalid --replace-existing value "${next}" (expected ring|all)`);
      }
      replaceExisting = next;
      i += 1;
      continue;
    }
    if (a.startsWith('--replace-existing=')) {
      const value = a.slice('--replace-existing='.length).trim().toLowerCase();
      if (value !== 'ring' && value !== 'all') {
        throw new Error(`Invalid --replace-existing value "${value}" (expected ring|all)`);
      }
      replaceExisting = value;
      continue;
    }

    if (a === '--system-user') {
      const next = String(argv[i + 1] ?? '');
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --system-user');
      }
      systemUserFromArgs = next.trim();
      i += 1;
      continue;
    }
    if (a.startsWith('--system-user=')) {
      systemUserFromArgs = a.slice('--system-user='.length).trim();
      continue;
    }

    filtered.push(a);
  }

  const flags = parseCliFlags(filtered);
  if (replaceExisting && !yes) {
    throw new Error('--replace-existing requires --yes');
  }
  const action = resolveAction(filtered);
  const mode = modeFromArgs ?? resolveOptionalModeFromText(process.env.HAPPIER_DAEMON_SERVICE_MODE ?? '', 'HAPPIER_DAEMON_SERVICE_MODE') ?? 'user';
  const systemUser = systemUserFromArgs ?? String(process.env.HAPPIER_DAEMON_SERVICE_SYSTEM_USER ?? '').trim();

  return { argvFiltered: filtered, flags: { ...flags, yes, takeover, replaceExisting, all, ring, instanceId }, action, mode, systemUser };
}

function resolveAction(argv: readonly string[]): DaemonServiceCliAction {
  const positionals = argv.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const action = (positionals[0] ?? 'status').toString().trim();
  if (!action) return 'status';
  if (action === 'help') return 'status';
  return action as DaemonServiceCliAction;
}

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function runCommandCaptureBestEffort(command: Readonly<{ cmd: string; args: readonly string[] }>): { ok: boolean; out: string | null } {
  try {
    const res = spawnSync(command.cmd, [...command.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const ok = (res.status ?? 1) === 0;
    const out = (res.stdout ? String(res.stdout) : '') + (res.stderr ? String(res.stderr) : '');
    return { ok, out: out.trim() ? out : null };
  } catch {
    return { ok: false, out: null };
  }
}

function resolveDaemonServiceStatusCommand(params: Readonly<{
  runtime: DaemonServiceCliRuntime;
  mode: DaemonServiceMode;
}>): Readonly<{ cmd: string; args: readonly string[] }> | null {
  const plan = planDaemonServiceLifecycle({
    platform: params.runtime.platform,
    action: 'status',
    mode: params.mode,
    channel: params.runtime.channel,
    targetMode: params.runtime.targetMode,
    instanceId: params.runtime.instanceId,
    userHomeDir: params.runtime.userHomeDir,
    happierHomeDir: params.runtime.happierHomeDir,
    uid: params.runtime.uid ?? undefined,
  });
  return plan.commands[0] ?? null;
}

function resolveDaemonServiceOwnershipHealthCommand(params: Readonly<{
  runtime: DaemonServiceCliRuntime;
  mode: DaemonServiceMode;
}>): Readonly<{ cmd: string; args: readonly string[] }> | null {
  const statusCommand = resolveDaemonServiceStatusCommand(params);
  if (!statusCommand || params.runtime.platform !== 'linux') {
    return statusCommand;
  }

  const args = [...statusCommand.args];
  const statusIndex = args.indexOf('status');
  if (statusIndex >= 0) {
    args[statusIndex] = 'is-active';
  }
  return {
    cmd: statusCommand.cmd,
    args: args.filter((arg) => arg !== '--no-pager'),
  };
}

function doesInstalledDaemonServiceDefinitionMatchExpected(params: Readonly<{
  installedPath: string;
  expectedContents: string;
}>): boolean {
  try {
    return readFileSync(params.installedPath, 'utf-8').trim() === params.expectedContents.trim();
  } catch {
    return false;
  }
}

async function isExpectedDaemonServiceWaitingForInitialAuth(params: Readonly<{
  platform: SupportedPlatform;
  expectedInstalledServiceContents?: string | null;
  installedServicePath?: string | null;
  healthCommand?: Readonly<{ cmd: string; args: readonly string[] }> | null;
}>): Promise<boolean> {
  const credentials = await readCredentials().catch(() => null);
  if (credentials) {
    return false;
  }

  if (params.healthCommand && !runCommandCaptureBestEffort(params.healthCommand).ok) {
    return false;
  }

  if (params.platform === 'darwin' && params.expectedInstalledServiceContents && params.installedServicePath) {
    return doesInstalledDaemonServiceDefinitionMatchExpected({
      installedPath: params.installedServicePath,
      expectedContents: params.expectedInstalledServiceContents,
    });
  }

  return true;
}

async function waitForExpectedDaemonServiceOwnership(params: Readonly<{
  platform: SupportedPlatform;
  expectedServiceLabel: string;
  timeoutMs: number;
  pollMs: number;
  stableMs: number;
  expectedInstalledServiceContents?: string | null;
  installedServicePath?: string | null;
  healthCommand?: Readonly<{ cmd: string; args: readonly string[] }> | null;
}>): Promise<boolean> {
  let stableSince: number | null = null;
  return await waitForDaemonRunningWithinBudget({
    timeoutMs: params.timeoutMs,
    pollMs: params.pollMs,
    isRunning: async () => {
      const ownership = await evaluateCurrentDaemonOwner();
      if (ownership.kind === 'none') {
        const waitingForInitialAuth = await isExpectedDaemonServiceWaitingForInitialAuth({
          platform: params.platform,
          expectedInstalledServiceContents: params.expectedInstalledServiceContents,
          installedServicePath: params.installedServicePath,
          healthCommand: params.healthCommand,
        });
        if (!waitingForInitialAuth) {
          stableSince = null;
          return false;
        }

        const now = Date.now();
        if (stableSince === null) {
          stableSince = now;
        }
        return now - stableSince >= params.stableMs;
      }

      if (ownership.owner.serviceManaged !== true) {
        stableSince = null;
        return false;
      }

      if (ownership.owner.state.serviceLabel !== params.expectedServiceLabel) {
        stableSince = null;
        return false;
      }

      if (params.healthCommand && !runCommandCaptureBestEffort(params.healthCommand).ok) {
        stableSince = null;
        return false;
      }

      if (params.platform === 'darwin' && params.expectedInstalledServiceContents && params.installedServicePath) {
        const installedDefinitionMatches = doesInstalledDaemonServiceDefinitionMatchExpected({
          installedPath: params.installedServicePath,
          expectedContents: params.expectedInstalledServiceContents,
        });
        if (!installedDefinitionMatches) {
          stableSince = null;
          return false;
        }
      }

      const ownershipMatches = evaluateDaemonServiceLifecycleOwnership({
        ownership,
        expectedServiceLabel: params.expectedServiceLabel,
      }).kind === 'ok';
      if (!ownershipMatches) {
        stableSince = null;
        return false;
      }

      const now = Date.now();
      if (stableSince === null) {
        stableSince = now;
      }

      return now - stableSince >= params.stableMs;
    },
  });
}

async function assertExpectedDaemonServiceOwnership(params: Readonly<{
  action: 'install' | 'start' | 'restart';
  platform: SupportedPlatform;
  expectedServiceLabel: string;
  expectedInstalledServiceContents?: string | null;
  installedServicePath?: string | null;
  healthCommand?: Readonly<{ cmd: string; args: readonly string[] }> | null;
}>): Promise<void> {
  const timeoutMs = readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS', 15000);
  const pollMs = readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS', 100);
  const stableMs = readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS', 1000);
  const expectedOwnerObserved = await waitForExpectedDaemonServiceOwnership({
    platform: params.platform,
    expectedServiceLabel: params.expectedServiceLabel,
    timeoutMs,
    pollMs,
    stableMs,
    expectedInstalledServiceContents: params.expectedInstalledServiceContents,
    installedServicePath: params.installedServicePath,
    healthCommand: params.healthCommand,
  });
  if (expectedOwnerObserved) {
    return;
  }

  throw new Error(
    `Background service ${params.action} completed, but the expected background service did not take ownership of the current relay ` +
    `within ${timeoutMs}ms. Run \`happier service status\` to inspect the active owner and system service state.`,
  );
}

async function withManualRelayTakeoverRecovery<T>(params: Readonly<{
  shouldTakeOverManualOwner: boolean;
  action: 'install' | 'start' | 'restart';
  run: () => Promise<T> | T;
}>): Promise<T> {
  if (!params.shouldTakeOverManualOwner) {
    return await params.run();
  }

  await stopDaemon();

  try {
    return await params.run();
  } catch (error) {
    const restored = await restartDaemonAndWait({ takeover: true }).catch(() => false);
    const originalMessage = error instanceof Error ? error.message : String(error);
    if (restored) {
      throw new Error(
        `Failed to ${params.action} the background service after stopping the current manual relay runtime. ` +
        `The previous manual relay runtime was restored.\n${originalMessage}`,
      );
    }
    throw new Error(
      `Failed to ${params.action} the background service after stopping the current manual relay runtime, ` +
      `and restoring the previous manual relay runtime also failed.\n${originalMessage}`,
    );
  }
}

export type DaemonServiceCliRuntime = Readonly<{
  platform: SupportedPlatform;
  channel: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
  instanceId: string;
  uid: number | null;
  userHomeDir: string;
  happierHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  publicServerUrl: string;
  nodePath: string;
  entryPath: string;
}>;

function resolveDaemonServiceTargetModeFromText(raw: string | null | undefined): DaemonServiceTargetMode {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'default-following' ? 'default-following' : 'pinned';
}

export function resolveDaemonServiceCliRuntimeFromEnv(options: Readonly<{
  mode?: DaemonServiceMode;
  systemUser?: string;
  channel?: PublicReleaseRingId | null;
  targetMode?: DaemonServiceTargetMode | null;
  instanceId?: string | null;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): DaemonServiceCliRuntime {
  const processEnv = options.processEnv ?? process.env;
  const platform =
    resolveSupportedPlatform(processEnv.HAPPIER_DAEMON_SERVICE_PLATFORM ?? '') ??
    resolvePlatformFromProcess();
  if (!platform) {
    throw new Error('Background service management is currently only supported on macOS, Linux, and Windows');
  }

  const uidEnvRaw = (processEnv.HAPPIER_DAEMON_SERVICE_UID ?? '').trim();
  const uidEnv = uidEnvRaw ? Number(uidEnvRaw) : null;
  const uidFromProc = process.getuid ? process.getuid() : null;
  const uid = uidEnv !== null && Number.isFinite(uidEnv) && uidEnv >= 0 ? uidEnv : uidFromProc;

  const explicitUserHomeDir = expandHomeDirPath((processEnv.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR ?? '').trim(), processEnv);
  const explicitHappierHomeDir = expandHomeDirPath((processEnv.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR ?? '').trim(), processEnv);
  const systemUserPaths =
    platform === 'linux' && options.mode === 'system' && String(options.systemUser ?? '').trim()
      ? resolveLinuxSystemUserPaths({
          systemUser: String(options.systemUser ?? '').trim(),
          userHomeDirOverride: explicitUserHomeDir,
          happierHomeDirOverride: explicitHappierHomeDir,
        })
      : null;
  const sudoInvokerUserPaths =
    platform === 'linux'
      && options.mode !== 'system'
      && !explicitUserHomeDir
      && uid === 0
      && String(processEnv.SUDO_USER ?? '').trim()
      ? (() => {
          try {
            return resolveLinuxSystemUserPaths({
              systemUser: String(processEnv.SUDO_USER ?? '').trim(),
            });
          } catch {
            return null;
          }
        })()
      : null;

  let resolvedRealHomeDir = '';
  try {
    resolvedRealHomeDir = String(os.userInfo()?.homedir ?? '').trim();
  } catch {
    resolvedRealHomeDir = '';
  }
  const userHomeDir = systemUserPaths?.userHomeDir
    || explicitUserHomeDir
    || sudoInvokerUserPaths?.userHomeDir
    || resolvedRealHomeDir
    || os.homedir();
  const happierHomeDir = systemUserPaths?.happierHomeDir ?? (explicitHappierHomeDir || configuration.happyHomeDir);
  const targetMode = options.targetMode ?? resolveDaemonServiceTargetModeFromText(processEnv.HAPPIER_DAEMON_SERVICE_TARGET_MODE);
  const instanceId = String(options.instanceId ?? '').trim() || (processEnv.HAPPIER_DAEMON_SERVICE_INSTANCE_ID ?? '').trim() || configuration.activeServerId;
  const serverUrl = (processEnv.HAPPIER_DAEMON_SERVICE_SERVER_URL ?? '').trim() || configuration.serverUrl;
  const webappUrl = (processEnv.HAPPIER_DAEMON_SERVICE_WEBAPP_URL ?? '').trim() || configuration.webappUrl;
  const publicServerUrl = (processEnv.HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL ?? '').trim() || configuration.publicServerUrl;
  const explicitNodePath = (processEnv.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '').trim();
  const explicitEntryPath = (processEnv.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '').trim();
  const runtimeTarget = resolveDaemonServiceRuntimeTarget({
    currentExecPath: process.execPath,
    runtimeExecutable: explicitNodePath
      ? null
      : resolveJavaScriptRuntimeExecutable({
          isBunRuntime: isBun(),
          processEnv,
        }),
    explicitNodePath,
    explicitEntryPath,
  });
  const channel = options.channel ||
    normalizePublicReleaseRingId(String(processEnv.HAPPIER_DAEMON_SERVICE_CHANNEL ?? '').trim()) ||
    inferPublicReleaseRingIdFromEnvAndArgv({
      env: processEnv,
      argv: process.argv,
      additionalCandidates: [
        explicitEntryPath,
        runtimeTarget.entryPath,
        runtimeTarget.nodePath,
      ],
    });

  return {
    platform,
    channel,
    targetMode,
    instanceId,
    uid,
    userHomeDir,
    happierHomeDir,
    serverUrl,
    webappUrl,
    publicServerUrl,
    nodePath: runtimeTarget.nodePath,
    entryPath: runtimeTarget.entryPath,
  };
}

export type DaemonServiceInstallationSnapshot = Readonly<{
  platform: SupportedPlatform;
  installed: boolean;
  installedPath: string;
}>;

export type DaemonServiceListEntry = Readonly<{
  serverId: string;
  name: string;
  installed: boolean;
  path: string;
  platform: SupportedPlatform;
  mode?: DaemonServiceMode;
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
}>;

type DaemonServiceInventoryEntry = Readonly<{
  serviceType: 'daemon';
  label: string;
  ring: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
  installed: boolean;
  running: boolean;
  definitionPath: string;
  instanceId: string;
}>;

export async function resolveDaemonServiceInstallationSnapshotFromEnv(options: Readonly<{
  mode?: DaemonServiceMode;
  systemUser?: string;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): Promise<DaemonServiceInstallationSnapshot> {
  const runtime = resolveDaemonServiceCliRuntimeFromEnv(options);
  const paths = resolveDaemonServicePaths(runtime, { mode: options.mode });
  return {
    platform: runtime.platform,
    installed: isValidInstalledDaemonServiceFile({
      platform: runtime.platform,
      path: paths.installedPath,
      expectedLabel: paths.label,
    }),
    installedPath: paths.installedPath,
  };
}

export async function resolveDaemonServiceListEntries(
  runtime: DaemonServiceCliRuntime,
  options: Readonly<{ mode?: DaemonServiceMode }> = {},
): Promise<readonly DaemonServiceListEntry[]> {
  const settings = await readSettings();
  return await discoverInstalledDaemonServiceEntries({
    platform: runtime.platform,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
    mode: options.mode === 'system' ? 'system' : 'user',
    serversById: (settings.servers ?? {}) as Readonly<Record<string, unknown>>,
  });
}

function mapDaemonServiceListEntriesToInventory(
  entries: readonly DaemonServiceListEntry[],
  options: Readonly<{ activeServiceLabel?: string | null }> = {},
): readonly DaemonServiceInventoryEntry[] {
  const activeServiceLabel = String(options.activeServiceLabel ?? '').trim();
  return entries.map((entry) => ({
    serviceType: 'daemon',
    label: entry.label,
    ring: entry.releaseChannel,
    targetMode: entry.targetMode,
    installed: entry.installed,
    running: activeServiceLabel.length > 0 && entry.label === activeServiceLabel,
    definitionPath: entry.path,
    instanceId: entry.serverId,
  }));
}

function resolveDaemonServiceSelectableEntries(
  entries: readonly DaemonServiceListEntry[],
  mode: DaemonServiceMode,
): readonly DaemonServiceSelectableEntry[] {
  const scope = mode === 'system' ? 'system' : 'user';
  const backendPrefix =
    entries[0]?.platform === 'darwin'
      ? `launchd-${scope}`
      : entries[0]?.platform === 'win32'
        ? `schtasks-${scope}`
        : `systemd-${scope}`;
  return entries.map((entry) => ({
    id: `${backendPrefix}:${entry.label}`,
    label: entry.label,
    platform: entry.platform,
    scope,
    ring: entry.releaseChannel,
    instanceId: entry.serverId,
    targetMode: entry.targetMode,
  }));
}

export function resolveDaemonServicePaths(
  runtime: DaemonServiceCliRuntime,
  options: Readonly<{ mode?: DaemonServiceMode }> = {},
): Readonly<{
  platform: SupportedPlatform;
  label: string;
  unitName: string;
  plistPath: string;
  unitPath: string;
  wrapperPath: string;
  taskName: string;
  installedPath: string;
  stdoutPath: string;
  stderrPath: string;
}> {
  const mode: DaemonServiceMode = options.mode === 'system' ? 'system' : 'user';
  const logPrefix = runtime.targetMode === 'default-following'
    ? ''
    : (() => {
        const channelSegment = resolveDaemonServiceChannelSegment(runtime.channel);
        return channelSegment ? `${channelSegment}.` : '';
      })();
  const logInstanceId = runtime.targetMode === 'default-following' ? 'default' : runtime.instanceId;
  const label = resolveDaemonServiceLaunchdLabel(runtime.instanceId, runtime.channel, runtime.targetMode);
  const unitName = resolveDaemonServiceSystemdUnitName(runtime.instanceId, runtime.channel, runtime.targetMode);
  const plistPath = resolveLaunchAgentPlistPath({
    userHomeDir: runtime.userHomeDir,
    instanceId: runtime.instanceId,
    channel: runtime.channel,
    targetMode: runtime.targetMode,
  });
  const unitPath =
    runtime.platform === 'linux' && mode === 'system'
      ? resolveSystemdSystemUnitPath({ instanceId: runtime.instanceId, channel: runtime.channel, targetMode: runtime.targetMode })
      : resolveSystemdUserUnitPath({
          userHomeDir: runtime.userHomeDir,
          instanceId: runtime.instanceId,
          channel: runtime.channel,
          targetMode: runtime.targetMode,
        });
  const wrapperPath = runtime.platform === 'win32'
    ? resolveWindowsDaemonWrapperPath({
        happierHomeDir: runtime.happierHomeDir,
        instanceId: runtime.instanceId,
        channel: runtime.channel,
        targetMode: runtime.targetMode,
      })
    : '';
  const taskName = runtime.platform === 'win32'
    ? resolveWindowsDaemonTaskName({ instanceId: runtime.instanceId, channel: runtime.channel, targetMode: runtime.targetMode })
    : '';
  const installedPath = runtime.platform === 'darwin'
    ? plistPath
    : runtime.platform === 'linux'
      ? unitPath
      : wrapperPath;
  return {
    platform: runtime.platform,
    label,
    unitName,
    plistPath,
    unitPath,
    wrapperPath,
    taskName,
    installedPath,
    stdoutPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.out.log`),
    stderrPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.err.log`),
  };
}

export async function runDaemonServiceCliCommand(
  params: Readonly<{ argv: readonly string[]; commandPath?: string }>,
): Promise<void> {
  const parsed = parseDaemonServiceCliInvocation(params.argv);
  const commandPath = params.commandPath ?? 'happier service';
  const flags = parsed.flags;
  const mode = parsed.mode;
  const systemUser = parsed.systemUser;
  const runtimeTargetMode =
    flags.ring || flags.instanceId
      ? 'pinned'
      : resolveDaemonServiceTargetModeFromText(process.env.HAPPIER_DAEMON_SERVICE_TARGET_MODE || 'default-following');
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    mode,
    systemUser,
    channel: flags.ring,
    targetMode: runtimeTargetMode,
    instanceId: flags.instanceId,
  });
  const paths = resolveDaemonServicePaths(runtime, { mode });
  const action = parsed.action;

  if (flags.help) {
    if (flags.json) {
        printJson({
          ok: true,
          commands: ['list', 'paths', 'install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'tail'],
          flags: ['--json', '--deep', '--dry-run', '--yes', '--takeover', '--replace-existing=ring|all', '--ring', '--instance', '--all'],
        });
        return;
    }
    process.stdout.write(
      [
        commandPath,
        '',
        'Usage:',
        `  ${commandPath} list [--deep] [--json]`,
        `  ${commandPath} paths [--json]`,
        `  ${commandPath} status [--json]`,
        `  ${commandPath} install [--mode user|system] [--dry-run] [--yes] [--takeover] [--replace-existing=ring|all] [--json]`,
        `  ${commandPath} uninstall [--mode user|system] [--ring <stable|preview|dev>] [--instance <id>] [--all] [--yes] [--dry-run] [--json]`,
        `  ${commandPath} start|stop|restart [--dry-run] [--takeover] [--json]`,
        `  ${commandPath} logs [--json]`,
        `  ${commandPath} tail`,
        '',
      ].join('\n'),
    );
    return;
  }

  if (action === 'list') {
    const entries = await resolveDaemonServiceListEntries(runtime, { mode });
    const ownership = await evaluateCurrentDaemonOwner();
    const activeServiceLabel = ownership.kind !== 'none' && ownership.owner.serviceManaged === true
      ? ownership.owner.state.serviceLabel
      : null;
    const services = mapDaemonServiceListEntriesToInventory(entries, { activeServiceLabel });

    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform, services });
      return;
    }

    if (services.length === 0) {
      process.stdout.write(`${neutral('(no background services installed)')}\n`);
      return;
    }

    process.stdout.write(`${sectionTitle('Background services')}\n`);
    for (const service of services) {
      const statusText = service.running ? ok(service.label) : warn(service.label);
      process.stdout.write(`${statusText}\n`);
      process.stdout.write(`  ${kv('Installed:', service.installed ? 'yes' : 'no')}\n`);
      process.stdout.write(`  ${kv('Running:', service.running ? 'yes' : 'no')}\n`);
      process.stdout.write(`  ${kv('Target:', describeBackgroundServiceTargetMode(service.targetMode))}\n`);
      process.stdout.write(`  ${kv('Type:', service.serviceType)}\n`);
      process.stdout.write(`  ${kv('Definition:', service.definitionPath)}\n`);
      if (service.ring) process.stdout.write(`  ${kv('Ring:', service.ring)}\n`);
      if (service.instanceId) process.stdout.write(`  ${kv('Instance:', service.instanceId)}\n`);
    }
    return;
  }

  if (action === 'paths') {
    if (flags.json) {
      printJson({
        ok: true,
        platform: runtime.platform,
        targetMode: runtime.targetMode,
        releaseChannel: runtime.channel,
        paths: runtime.platform === 'darwin'
          ? { plistPath: paths.plistPath, label: paths.label, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath }
          : runtime.platform === 'win32'
            ? { taskName: paths.taskName, wrapperPath: paths.wrapperPath, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath }
            : { unitPath: paths.unitPath, unitName: paths.unitName, stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath },
      });
      return;
    }

    process.stdout.write(
      runtime.platform === 'darwin'
        ? `LaunchAgent: ${paths.plistPath}\nLabel: ${paths.label}\n`
          : runtime.platform === 'win32'
          ? `Scheduled Task: ${paths.taskName}\nWrapper: ${paths.wrapperPath}\n`
          : `systemd unit: ${paths.unitPath}\nUnit name: ${paths.unitName}\n`,
    );
    process.stdout.write(`target: ${describeBackgroundServiceTargetMode(runtime.targetMode)}\n`);
    process.stdout.write(`stdout: ${paths.stdoutPath}\nstderr: ${paths.stderrPath}\n`);
    return;
  }

  if (action === 'install') {
    if (runtime.platform === 'linux' && mode === 'system') {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Root privileges are required for system mode service install');
      }
      if (!systemUser) {
        throw new Error('Missing --system-user (required for system mode)');
      }
    }

    const installRuntimeTarget = await resolveDaemonServiceInstallRuntimeTarget({
      currentExecPath: process.execPath,
      explicitNodePath: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH ?? '',
      explicitEntryPath: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH ?? '',
      targetMode: runtime.targetMode,
      processEnv: process.env,
    });
    const installRuntime = {
      ...runtime,
      nodePath: installRuntimeTarget.nodePath,
      entryPath: installRuntimeTarget.entryPath,
    };
    const ownership = await evaluateCurrentDaemonOwner();
    const lifecycleOwnership = evaluateDaemonServiceLifecycleOwnership({
      ownership,
      expectedServiceLabel: paths.label,
    });
    const takeoverDecision = resolveDaemonServiceTakeoverDecision({
      lifecycleOwnership,
      takeoverRequested: flags.takeover,
    });
    const takeoverNotice = takeoverDecision.kind === 'manual-owner-takeover'
      ? buildDaemonServiceTakeoverNotice({ action: 'install' })
      : null;
    if (takeoverDecision.kind === 'conflict') {
      const message = renderDaemonServiceLifecycleOwnershipConflict({
        action: 'install',
        conflict: takeoverDecision.conflict,
      });
      const lines = takeoverDecision.conflict.kind === 'manual-owner-conflict'
        ? [...message.lines, buildDaemonServiceTakeoverHint({ commandPath, action: 'install' })]
        : [...message.lines];
      const flattenedMessage = [message.title, ...lines].join(' ');
      if (flags.json) {
        printJson({
          ok: false,
          error: 'owner_conflict',
          message: flattenedMessage,
          platform: installRuntime.platform,
        });
        return;
      }
      process.stderr.write(`${errorFrame(message.title, lines)}\n`);
      return;
    }

    const plan = planDaemonServiceInstall({
      platform: installRuntime.platform,
      mode,
      systemUser,
      channel: installRuntime.channel,
      targetMode: installRuntime.targetMode,
      instanceId: installRuntime.instanceId,
      uid: installRuntime.uid ?? undefined,
      userHomeDir: installRuntime.userHomeDir,
      happierHomeDir: installRuntime.happierHomeDir,
      serverUrl: installRuntime.serverUrl,
      webappUrl: installRuntime.webappUrl,
      publicServerUrl: installRuntime.publicServerUrl,
      nodePath: installRuntime.nodePath,
      entryPath: installRuntime.entryPath,
    });
    const shouldKickstartCurrentDarwinInstall = installRuntime.platform === 'darwin'
      && ownership.kind !== 'none'
      && ownership.owner.serviceManaged === true
      && ownership.owner.state.serviceLabel === paths.label;

    if (flags.dryRun) {
      const previewPlan = shouldKickstartCurrentDarwinInstall
        ? planDaemonServiceInstall({
          platform: installRuntime.platform,
          mode,
          systemUser,
          channel: installRuntime.channel,
          targetMode: installRuntime.targetMode,
          instanceId: installRuntime.instanceId,
          uid: installRuntime.uid ?? undefined,
          userHomeDir: installRuntime.userHomeDir,
          happierHomeDir: installRuntime.happierHomeDir,
          serverUrl: installRuntime.serverUrl,
          webappUrl: installRuntime.webappUrl,
          publicServerUrl: installRuntime.publicServerUrl,
          nodePath: installRuntime.nodePath,
          entryPath: installRuntime.entryPath,
          darwinInstallMode: 'kickstart',
        })
        : plan;
      if (flags.json) {
        printJson({
          ok: true,
          platform: installRuntime.platform,
          plan: previewPlan,
          takeover: takeoverNotice ? [takeoverNotice.title, ...takeoverNotice.lines].join(' ') : undefined,
        });
        return;
      }
      process.stdout.write(`[dry-run] would write: ${previewPlan.files.map((f) => f.path).join(', ')}\n`);
      for (const c of previewPlan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      if (takeoverNotice) {
        process.stdout.write(`${warn(takeoverNotice.title)}\n`);
        process.stdout.write(`${takeoverNotice.lines.map((line) => `  ${line}`).join('\n')}\n`);
      }
      return;
    }

    const strategy =
      flags.replaceExisting === 'ring' ? 'replace-ring'
      : flags.replaceExisting === 'all' ? 'replace-all'
      : flags.yes ? 'add'
      : undefined;

    try {
      await withManualRelayTakeoverRecovery({
        shouldTakeOverManualOwner: takeoverDecision.kind === 'manual-owner-takeover',
        action: 'install',
        run: async () => await installDaemonService({
          platform: installRuntime.platform,
          uid: installRuntime.uid ?? undefined,
          userHomeDir: installRuntime.userHomeDir,
          happierHomeDir: installRuntime.happierHomeDir,
          mode,
          systemUser,
          channel: installRuntime.channel,
          targetMode: installRuntime.targetMode,
          darwinInstallMode: shouldKickstartCurrentDarwinInstall ? 'kickstart' : undefined,
          instanceId: installRuntime.instanceId,
          serverUrl: installRuntime.serverUrl,
          webappUrl: installRuntime.webappUrl,
          publicServerUrl: installRuntime.publicServerUrl,
          nodePath: installRuntime.nodePath,
          entryPath: installRuntime.entryPath,
          strategy,
          runCommands: true,
          commandFailureMode: 'strict',
        }).then(async () => {
          await assertExpectedDaemonServiceOwnership({
            action: 'install',
            platform: installRuntime.platform,
            expectedServiceLabel: paths.label,
            expectedInstalledServiceContents: plan.files[0]?.content ?? null,
            installedServicePath: paths.installedPath,
            healthCommand: resolveDaemonServiceOwnershipHealthCommand({
              runtime: installRuntime,
              mode,
            }),
          });
        }),
      });
    } catch (error) {
      const conflict = error as Error & { code?: string; conflicts?: Array<{ label?: string }> };
      if (flags.json && conflict.code === 'daemon_service_conflict') {
        printJson({
          ok: false,
          error: conflict.code,
          message: conflict.message,
          conflicts: conflict.conflicts ?? [],
          platform: installRuntime.platform,
        });
        return;
      }
      throw error;
    }

    if (flags.json) {
      printJson({
        ok: true,
        platform: installRuntime.platform,
        takeover: takeoverNotice ? [takeoverNotice.title, ...takeoverNotice.lines].join(' ') : undefined,
      });
      return;
    }
    process.stdout.write('Background service installed.\n');
    if (takeoverNotice) {
      process.stdout.write(`${warn(takeoverNotice.title)}\n`);
      process.stdout.write(`${takeoverNotice.lines.map((line) => `  ${line}`).join('\n')}\n`);
    }
    return;
  }

  if (action === 'uninstall') {
    if (runtime.platform === 'linux' && mode === 'system') {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Root privileges are required for system mode service uninstall');
      }
    }

    const hasExplicitSelection = flags.all || Boolean(flags.ring) || Boolean(flags.instanceId);
    const entries = hasExplicitSelection
      ? await resolveDaemonServiceListEntries(runtime, { mode })
      : null;
    const selectedServices = entries
      ? resolveDaemonServiceUninstallSelection({
          services: resolveDaemonServiceSelectableEntries(entries, mode),
          platform: runtime.platform,
          mode,
          defaultRing: runtime.channel,
          defaultInstanceId: runtime.instanceId,
          filters: {
            ring: flags.ring,
            instanceId: flags.instanceId,
            all: flags.all,
          },
        })
      : [];
    const uninstallTargets = selectedServices.length > 0
      ? selectedServices.map((service) => ({
          platform: service.platform,
          mode: service.scope === 'system' ? 'system' as const : 'user' as const,
          channel: normalizePublicReleaseRingId(service.ring) || runtime.channel,
          targetMode: service.targetMode,
          instanceId: service.instanceId || runtime.instanceId,
        }))
      : [{
          platform: runtime.platform,
          mode,
          channel: runtime.channel,
          targetMode: runtime.targetMode,
          instanceId: runtime.instanceId,
        }];
    if (hasExplicitSelection && selectedServices.length === 0) {
      const message = 'No verified background services matched the requested uninstall target.';
      if (flags.json) {
        printJson({ ok: false, error: 'service_not_found', message, platform: runtime.platform });
        return;
      }
      throw new Error(message);
    }
    const plans = uninstallTargets.map((target) => planDaemonServiceUninstall({
      platform: target.platform,
      mode: target.mode,
      channel: target.channel,
      targetMode: target.targetMode,
      instanceId: target.instanceId,
      uid: runtime.uid ?? undefined,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
    }));
    const previewOnly = flags.dryRun || ((selectedServices.length > 1 || flags.all) && !flags.yes);

    if (previewOnly) {
      if (flags.json) {
        printJson({
          ok: true,
          platform: runtime.platform,
          executed: false,
          ...(plans.length === 1 ? { plan: plans[0] } : { plans }),
          selectedServices: selectedServices.map((service) => ({
            id: service.id,
            label: service.label,
            ring: service.ring,
            instanceId: service.instanceId,
          })),
        });
        return;
      }
      for (const plan of plans) {
        process.stdout.write(`[dry-run] would remove: ${plan.filesToRemove.join(', ')}\n`);
        for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      }
      if ((selectedServices.length > 1 || flags.all) && !flags.yes && !flags.dryRun) {
        process.stdout.write('Re-run with --yes to apply multi-service removal.\n');
      }
      return;
    }

    for (const target of uninstallTargets) {
      await uninstallDaemonService({
        platform: target.platform,
        uid: runtime.uid ?? undefined,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        mode: target.mode,
        channel: target.channel,
        targetMode: target.targetMode,
        instanceId: target.instanceId,
        runCommands: true,
      });
    }

    if (flags.json) {
      printJson({
        ok: true,
        platform: runtime.platform,
        executed: true,
        selectedServices: selectedServices.map((service) => ({
          id: service.id,
          label: service.label,
          ring: service.ring,
          instanceId: service.instanceId,
        })),
      });
      return;
    }
    process.stdout.write('Background service uninstalled.\n');
    return;
  }

  if (action === 'start' || action === 'stop' || action === 'restart') {
    if (runtime.platform === 'linux' && mode === 'system') {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Root privileges are required for system mode service lifecycle actions');
      }
    }

    if (!isValidInstalledDaemonServiceFile({
      platform: runtime.platform,
      path: paths.installedPath,
      expectedLabel: paths.label,
    })) {
      const msg = `Background service is not installed (${paths.installedPath}). Run: ${commandPath} install`;
      if (flags.json) printJson({ ok: false, error: 'not_installed', message: msg, platform: runtime.platform });
      else process.stderr.write(`${msg}\n`);
      return;
    }

    const ownership = await evaluateCurrentDaemonOwner();
    const stopOwnershipNote = action === 'stop'
      ? renderDaemonServiceStopOwnershipNote({
        ownership,
        expectedServiceLabel: paths.label,
      })
      : null;
    let takeoverNotice: Readonly<{ title: string; lines: readonly string[] }> | null = null;
    let shouldTakeOverManualOwner = false;

    if (action === 'start' || action === 'restart') {
      const lifecycleOwnership = evaluateDaemonServiceLifecycleOwnership({
        ownership,
        expectedServiceLabel: paths.label,
      });
      const takeoverDecision = resolveDaemonServiceTakeoverDecision({
        lifecycleOwnership,
        takeoverRequested: flags.takeover,
      });
      shouldTakeOverManualOwner = takeoverDecision.kind === 'manual-owner-takeover';
      takeoverNotice = takeoverDecision.kind === 'manual-owner-takeover'
        ? buildDaemonServiceTakeoverNotice({ action })
        : null;
      if (takeoverDecision.kind === 'conflict') {
        const message = renderDaemonServiceLifecycleOwnershipConflict({
          action,
          conflict: takeoverDecision.conflict,
        });
        const lines = takeoverDecision.conflict.kind === 'manual-owner-conflict'
          ? [...message.lines, buildDaemonServiceTakeoverHint({ commandPath, action })]
          : [...message.lines];
        const flattenedMessage = [message.title, ...lines].join(' ');
        if (flags.json) {
          printJson({
            ok: false,
            error: 'owner_conflict',
            message: flattenedMessage,
            platform: runtime.platform,
          });
        } else {
          process.stderr.write(`${errorFrame(message.title, lines)}\n`);
        }
        return;
      }
    }

    const shouldKickstartCurrentDarwinService = runtime.platform === 'darwin'
      && ownership.kind !== 'none'
      && ownership.owner.serviceManaged === true
      && ownership.owner.state.serviceLabel === paths.label;

    const plan = planDaemonServiceLifecycle({
      platform: runtime.platform,
      action,
      mode,
      channel: runtime.channel,
      targetMode: runtime.targetMode,
      instanceId: runtime.instanceId,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      uid: runtime.uid ?? undefined,
      darwinStartMode: action === 'start' && shouldKickstartCurrentDarwinService
        ? 'kickstart'
        : undefined,
      darwinRestartMode: action === 'restart' && shouldKickstartCurrentDarwinService
        ? 'kickstart'
        : undefined,
    });

    if (flags.dryRun) {
      if (flags.json) {
        printJson({
          ok: true,
          platform: runtime.platform,
          plan,
          warning: [takeoverNotice
            ? [takeoverNotice.title, ...takeoverNotice.lines].join(' ')
            : undefined, stopOwnershipNote
              ? [stopOwnershipNote.title, ...stopOwnershipNote.lines].join(' ')
              : undefined].filter(Boolean).join(' ') || undefined,
        });
        return;
      }
      for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      if (takeoverNotice) {
        process.stdout.write(`${warn(takeoverNotice.title)}\n`);
        process.stdout.write(`${takeoverNotice.lines.map((line) => `  ${line}`).join('\n')}\n`);
      }
      if (stopOwnershipNote) {
        process.stdout.write(`${warn(stopOwnershipNote.title)}\n`);
        process.stdout.write(`${stopOwnershipNote.lines.map((line) => `  ${line}`).join('\n')}\n`);
      }
      return;
    }

    if (action === 'start' || action === 'restart') {
      await withManualRelayTakeoverRecovery({
        shouldTakeOverManualOwner,
        action,
        run: async () => {
          if (
            runtime.platform === 'darwin'
            && plan.commands.some((command) => command.cmd === 'launchctl' && command.args[0] === 'bootstrap')
          ) {
            refreshDarwinLaunchAgentDefinitionForBootstrap(paths.installedPath);
          }
          runDaemonServiceCommands(plan.commands, { failureMode: 'strict' });
          await assertExpectedDaemonServiceOwnership({
            action,
            platform: runtime.platform,
            expectedServiceLabel: paths.label,
            healthCommand: resolveDaemonServiceOwnershipHealthCommand({
              runtime,
              mode,
            }),
          });
        },
      });

      if (flags.json) {
        printJson({
          ok: true,
          platform: runtime.platform,
          warning: [takeoverNotice
            ? [takeoverNotice.title, ...takeoverNotice.lines].join(' ')
            : undefined, stopOwnershipNote
              ? [stopOwnershipNote.title, ...stopOwnershipNote.lines].join(' ')
              : undefined].filter(Boolean).join(' ') || undefined,
        });
        return;
      }
      process.stdout.write(`Background service ${action} requested.\n`);
      if (takeoverNotice) {
        process.stdout.write(`${warn(takeoverNotice.title)}\n`);
        process.stdout.write(`${takeoverNotice.lines.map((line) => `  ${line}`).join('\n')}\n`);
      }
      if (stopOwnershipNote) {
        process.stdout.write(`${warn(stopOwnershipNote.title)}\n`);
        process.stdout.write(`${stopOwnershipNote.lines.map((line) => `  ${line}`).join('\n')}\n`);
      }
      return;
    }

    runDaemonServiceCommands(plan.commands, { failureMode: 'strict' });

    if (flags.json) {
      printJson({
        ok: true,
        platform: runtime.platform,
        warning: stopOwnershipNote
          ? [stopOwnershipNote.title, ...stopOwnershipNote.lines].join(' ')
          : undefined,
      });
      return;
    }
    process.stdout.write(`Background service ${action} requested.\n`);
    if (stopOwnershipNote) {
      process.stdout.write(`${warn(stopOwnershipNote.title)}\n`);
      process.stdout.write(`${stopOwnershipNote.lines.map((line) => `  ${line}`).join('\n')}\n`);
    }
    return;
  }

  if (action === 'status') {
    const installed = isValidInstalledDaemonServiceFile({
      platform: runtime.platform,
      path: paths.installedPath,
      expectedLabel: paths.label,
    });
    const ownership = await evaluateCurrentDaemonOwner();
    const services = await resolveInstalledDaemonServiceInventoryForCurrentRelay(runtime);

    const state = await readDaemonState().catch(() => null);
    const pid = typeof state?.pid === 'number' ? state.pid : null;
    const pidAlive = (() => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();

    const systemPlan = planDaemonServiceLifecycle({
      platform: runtime.platform,
      action: 'status',
      mode,
      channel: runtime.channel,
      targetMode: runtime.targetMode,
      instanceId: runtime.instanceId,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      uid: runtime.uid ?? undefined,
    });

    const systemStatus = installed && !flags.dryRun && systemPlan.commands.length
      ? runCommandCaptureBestEffort(systemPlan.commands[0]!)
      : { ok: false, out: null };
    const owner = state ? {
      running: pidAlive,
      startedAt: state.startedAt ?? null,
      startedWithCliVersion: state.startedWithCliVersion ?? null,
      startedWithPublicReleaseChannel: state.startedWithPublicReleaseChannel ?? null,
      startupSource: state.startupSource ?? null,
      serviceManaged: resolveDaemonStartupSourceServiceManagedState(state.startupSource),
      serviceLabel: state.serviceLabel ?? null,
      currentInvocationMatches: ownership.kind === 'compatible'
        ? true
        : ownership.kind === 'conflict'
          ? false
          : null,
    } : null;

    if (flags.json) {
      printJson({
        ok: true,
        platform: runtime.platform,
        targetMode: runtime.targetMode,
        releaseChannel: runtime.channel,
        installed,
        installedPath: paths.installedPath,
        services,
        daemon: pid ? { pid, running: pidAlive, startedAt: state?.startedAt ?? null } : { pid: null, running: false, startedAt: null },
        owner,
        system: { ok: systemStatus.ok, output: systemStatus.out },
      });
      return;
    }

    process.stdout.write(installed ? 'Service: installed\n' : 'Service: not installed\n');
    process.stdout.write(`Target: ${describeBackgroundServiceTargetMode(runtime.targetMode)}\n`);
    process.stdout.write(pidAlive ? `Daemon: running (pid ${pid})\n` : 'Daemon: not running\n');
    const inventory = renderDaemonServiceInventory(services);
    process.stdout.write(`${inventory.title}\n`);
    for (const line of inventory.lines) {
      process.stdout.write(`${line}\n`);
    }
    if (owner) {
      process.stdout.write(`Current owner: ${describeCurrentRelayOwner(owner.serviceManaged)}\n`);
      if (owner.serviceLabel) {
        process.stdout.write(`Background service label: ${owner.serviceLabel}\n`);
      }
      if (owner.startedWithPublicReleaseChannel || owner.startedWithCliVersion) {
        process.stdout.write(`Owner CLI: ${owner.startedWithPublicReleaseChannel ?? 'unknown'} • ${owner.startedWithCliVersion ?? 'unknown'}\n`);
      }
      if (owner.currentInvocationMatches === false) {
        process.stdout.write(owner.serviceManaged === true
          ? 'Warning: Current CLI differs from the running relay owner. Use `happier service restart` if you want automatic startup to switch to this installation.\n'
          : owner.serviceManaged === false
            ? 'Warning: Current CLI differs from the running relay owner. Use `happier daemon restart` if you want the manual relay runtime to switch to this installation.\n'
            : 'Warning: Current CLI differs from the running relay owner. Restart the current relay owner before trying to switch this installation.\n');
      }
    }
    if (systemStatus.out) process.stdout.write(`\n${systemStatus.out}\n`);
    return;
  }

  if (action === 'logs') {
    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform, logs: { stdoutPath: paths.stdoutPath, stderrPath: paths.stderrPath } });
      return;
    }
    process.stdout.write(`${paths.stdoutPath}\n${paths.stderrPath}\n`);
    return;
  }

  if (action === 'tail') {
    if (flags.json) {
      printJson({ ok: false, error: 'not_supported', message: 'tail is interactive; omit --json', platform: runtime.platform });
      return;
    }
    if (runtime.platform === 'win32') {
      process.stderr.write(`tail is not supported on Windows yet. Use: ${commandPath} logs\n`);
      return;
    }
    // Best-effort: follow both stdout + stderr if tail exists.
    if (!commandExistsInPath({ cmd: 'tail', envPath: process.env.PATH, platform: process.platform, pathext: process.env.PATHEXT })) {
      process.stderr.write('tail not found on PATH\n');
      return;
    }
    spawnSync('tail', ['-n', '200', '-f', paths.stdoutPath, paths.stderrPath], { stdio: 'inherit', env: process.env });
    return;
  }

  const msg = `Unknown service subcommand: ${action}`;
  if (flags.json) printJson({ ok: false, error: 'invalid_subcommand', message: msg });
  else process.stderr.write(`${msg}\n`);
}
