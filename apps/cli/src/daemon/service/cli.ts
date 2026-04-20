import { basename, join } from 'node:path';
import { readFileSync, statSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { configuration } from '@/configuration';
import { readCredentials, readDaemonState } from '@/persistence';
import { stopDaemon } from '@/daemon/controlClient';
import { restartDaemonAndWait } from '@/daemon/restartDaemonAndWait';
import { waitForDaemonRunningWithinBudget } from '@/daemon/waitForDaemonRunningWithinBudget';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { describeBackgroundServiceTargetMode } from '@happier-dev/cli-common/happierRuntime';
import { errorFrame, kv, neutral, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';
import { buildServiceCommandEnv } from '@happier-dev/cli-common/service';

import { installDaemonService, uninstallDaemonService } from './installer';
import { runDaemonServiceCommands } from './apply';
import {
  planDaemonServiceInstall,
  planDaemonServiceLifecycle,
  planDaemonServiceUninstall,
  resolveDaemonServiceLaunchdLabel,
  resolveWindowsDaemonTaskName,
  type DaemonServiceMode,
  type DaemonServiceTargetMode,
} from './plan';
import { commandExistsInPath } from './commandExistsInPath';
import { resolveDaemonServiceInstallRuntimeTarget } from './resolveDaemonServiceInstallRuntimeTarget';
import {
  resolveDaemonServiceCliRuntimeFromEnv,
  resolveDaemonServiceTargetModeFromText,
} from './daemonServiceCliRuntime';
import { resolveDaemonServiceListEntries, resolveDaemonServiceInstallationSnapshotFromEnv } from './resolveDaemonServiceListEntries';
import { resolveDaemonServicePaths } from './resolveDaemonServicePaths';
import { parseDaemonServiceUninstallFlagValue, resolveDaemonServiceUninstallSelection, type DaemonServiceSelectableEntry } from './uninstallSelection';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
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
import { isValidInstalledDaemonServiceFile } from './discoverInstalledDaemonServiceEntries';

export {
  resolveDaemonServiceCliRuntimeFromEnv,
  resolveDaemonServiceTargetModeFromText,
} from './daemonServiceCliRuntime';
export {
  resolveDaemonServiceListEntries,
  resolveDaemonServiceInstallationSnapshotFromEnv,
} from './resolveDaemonServiceListEntries';
export { resolveDaemonServicePaths } from './resolveDaemonServicePaths';

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

export type SupportedPlatform = 'darwin' | 'linux' | 'win32';

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

function shouldStopCurrentWindowsServiceOwnerBeforeLifecycleAction(params: Readonly<{
  platform: SupportedPlatform;
  ownership: Awaited<ReturnType<typeof evaluateCurrentDaemonOwner>>;
  expectedServiceLabel: string;
  action: 'install' | 'uninstall' | 'start' | 'stop' | 'restart';
}>): boolean {
  if (params.platform !== 'win32' || params.ownership.kind === 'none') {
    return false;
  }

  const owner = params.ownership.owner;
  if (owner.serviceManaged !== true || owner.state.serviceLabel !== params.expectedServiceLabel) {
    return false;
  }

  if (params.action === 'start') {
    return params.ownership.kind === 'conflict';
  }

  return true;
}

function describeDaemonServiceLifecycleAction(action: 'install' | 'uninstall' | 'start' | 'stop' | 'restart'): string {
  switch (action) {
    case 'install':
      return 'install';
    case 'uninstall':
      return 'uninstall';
    case 'start':
      return 'start';
    case 'stop':
      return 'stop';
    case 'restart':
      return 'restart';
  }
}

async function stopCurrentWindowsServiceOwnerIfNeeded(params: Readonly<{
  platform: SupportedPlatform;
  ownership: Awaited<ReturnType<typeof evaluateCurrentDaemonOwner>>;
  expectedServiceLabel: string;
  action: 'install' | 'uninstall' | 'start' | 'stop' | 'restart';
}>): Promise<void> {
  if (!shouldStopCurrentWindowsServiceOwnerBeforeLifecycleAction(params)) {
    return;
  }

  try {
    await stopDaemon();
  } catch (error) {
    const actionText = describeDaemonServiceLifecycleAction(params.action);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to stop the current background service owner before ${actionText}ing the background service.\n${detail}`,
    );
  }
}

function runCommandCaptureBestEffort(command: Readonly<{ cmd: string; args: readonly string[] }>): { ok: boolean; out: string | null } {
  try {
    const res = spawnSync(command.cmd, [...command.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildServiceCommandEnv({ cmd: command.cmd, args: command.args, env: process.env }),
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
  allowOwnerVersionMismatch?: boolean;
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

      const ownerMatches = ownership.kind === 'compatible'
        || (params.allowOwnerVersionMismatch === true && ownership.kind === 'conflict');
      if (!ownerMatches) {
        stableSince = null;
        return false;
      }

      if (ownership.owner.serviceManaged !== true) {
        stableSince = null;
        return false;
      }

      if (ownership.owner.state.serviceLabel !== params.expectedServiceLabel) {
        stableSince = null;
        return false;
      }

      if (
        params.allowOwnerVersionMismatch === true
        && !ownership.owner.releaseChannelMatches
        && Boolean(ownership.owner.state.startedWithPublicReleaseChannel)
      ) {
        stableSince = null;
        return false;
      }

      if (params.platform !== 'darwin' && params.healthCommand && !runCommandCaptureBestEffort(params.healthCommand).ok) {
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

      const ownershipMatches = params.allowOwnerVersionMismatch === true
        ? ownership.owner.serviceManaged === true
          && ownership.owner.state.serviceLabel === params.expectedServiceLabel
        : evaluateDaemonServiceLifecycleOwnership({
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
  allowOwnerVersionMismatch?: boolean;
  expectedInstalledServiceContents?: string | null;
  installedServicePath?: string | null;
  healthCommand?: Readonly<{ cmd: string; args: readonly string[] }> | null;
}>): Promise<void> {
  const waitTimeoutOverrideRaw = String(process.env.HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS ?? '').trim();
  const defaultTimeoutMs = params.platform === 'win32' ? 120_000 : 15_000;
  const timeoutMs = readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_TIMEOUT_MS', defaultTimeoutMs);
  // Task Scheduler can return before the wrapper actually relaunches the managed runtime on Windows.
  // Give Windows an extra default grace window, while still letting explicit env overrides take precedence.
  const defaultActiveGraceTimeoutMs = waitTimeoutOverrideRaw
    ? timeoutMs
    : params.platform === 'win32'
      ? 60_000
      : timeoutMs;
  const activeGraceTimeoutMs = readPositiveIntEnv(
    'HAPPIER_DAEMON_SERVICE_OWNERSHIP_ACTIVE_GRACE_TIMEOUT_MS',
    defaultActiveGraceTimeoutMs,
  );
  const pollMs = readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_OWNERSHIP_WAIT_POLL_MS', 100);
  const stableMs = readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_OWNERSHIP_STABLE_MS', 1000);
  const expectedOwnerObserved = await waitForExpectedDaemonServiceOwnership({
    platform: params.platform,
    expectedServiceLabel: params.expectedServiceLabel,
    timeoutMs,
    pollMs,
    stableMs,
    allowOwnerVersionMismatch: params.allowOwnerVersionMismatch,
    expectedInstalledServiceContents: params.expectedInstalledServiceContents,
    installedServicePath: params.installedServicePath,
    healthCommand: params.healthCommand,
  });
  if (expectedOwnerObserved) {
    return;
  }

  const serviceHealthyButStillConverging = activeGraceTimeoutMs > 0
    && params.healthCommand
    && runCommandCaptureBestEffort(params.healthCommand).ok;

  if (serviceHealthyButStillConverging) {
    const expectedOwnerObservedDuringGrace = await waitForExpectedDaemonServiceOwnership({
      platform: params.platform,
      expectedServiceLabel: params.expectedServiceLabel,
      timeoutMs: activeGraceTimeoutMs,
      pollMs,
      stableMs,
      expectedInstalledServiceContents: params.expectedInstalledServiceContents,
      installedServicePath: params.installedServicePath,
      healthCommand: params.healthCommand,
    });
    if (expectedOwnerObservedDuringGrace) {
      return;
    }
  }

  const effectiveTimeoutMs = serviceHealthyButStillConverging ? timeoutMs + activeGraceTimeoutMs : timeoutMs;

  throw new Error(
    `Background service ${params.action} completed, but the expected background service did not take ownership of the current relay ` +
    `within ${effectiveTimeoutMs}ms. Run \`happier service status\` to inspect the active owner and system service state.`,
  );
}

async function withManualRelayTakeoverRecovery<T>(params: Readonly<{
  shouldTakeOverManualOwner: boolean;
  action: 'install' | 'start' | 'restart';
  stopBeforeRun?: boolean;
  run: () => Promise<T> | T;
}>): Promise<T> {
  if (!params.shouldTakeOverManualOwner) {
    return await params.run();
  }

  const shouldStopBeforeRun = params.stopBeforeRun !== false;
  if (shouldStopBeforeRun) {
    await stopDaemon();
  }

  try {
    return await params.run();
  } catch (error) {
    if (!shouldStopBeforeRun) {
      await stopDaemon();
    }
    const restored = await restartDaemonAndWait({ takeover: true }).catch(() => false);
    const originalMessage = error instanceof Error ? error.message : String(error);
    const failurePrefix = shouldStopBeforeRun
      ? `Failed to ${params.action} the background service after stopping the current manual relay runtime.`
      : `Failed to ${params.action} the background service while taking over the current manual relay runtime.`;
    if (restored) {
      throw new Error(
        `${failurePrefix} ` +
        `The previous manual relay runtime was restored.\n${originalMessage}`,
      );
    }
    throw new Error(
      `${failurePrefix.replace(/\.$/, '')}, ` +
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

export type DaemonServiceInstallationSnapshot = Readonly<{
  platform: SupportedPlatform;
  installed: boolean;
  installedPath: string;
  label: string;
}>;

export type DaemonServiceListEntry = Readonly<{
  serverId: string;
  name: string;
  installed: boolean;
  path: string;
  platform: SupportedPlatform;
  mode?: DaemonServiceMode;
  happierHomeDir?: string | null;
  releaseChannel: PublicReleaseRingId;
  label: string;
  targetMode: DaemonServiceTargetMode;
  installedDefinitionMatchesExpected?: boolean;
}>;

type DaemonServiceInventoryEntry = Readonly<{
  serviceType: 'daemon';
  label: string;
  ring: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
  mode?: DaemonServiceMode;
  installed: boolean;
  running: boolean;
  definitionPath: string;
  instanceId: string;
  configuredCliVersion: string | null;
  runningCliVersion: string | null;
}>;

function mapDaemonServiceListEntriesToInventory(
  entries: readonly DaemonServiceListEntry[],
  options: Readonly<{
    activeServiceLabel?: string | null;
    activeOwnerCliVersion?: string | null;
  }> = {},
): readonly DaemonServiceInventoryEntry[] {
  const activeServiceLabel = String(options.activeServiceLabel ?? '').trim();
  const activeOwnerCliVersion = String(options.activeOwnerCliVersion ?? '').trim() || null;
  const configuredCliVersionByBinaryPathCache = new Map<string, string | null>();
  const runningStateTimeoutMs = readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_LIST_IS_ACTIVE_TIMEOUT_MS', 2000);

  const resolveOwnerComparableLabelsForEntry = (entry: DaemonServiceListEntry): readonly string[] => {
    const labels = new Set<string>();
    const explicitLabel = String(entry.label ?? '').trim();
    if (explicitLabel) {
      labels.add(explicitLabel);
    }
    labels.add(resolveDaemonServiceLaunchdLabel(entry.serverId, entry.releaseChannel, entry.targetMode));
    return [...labels];
  };

  const isEntryCurrentActiveOwner = (entry: DaemonServiceListEntry): boolean => {
    if (activeServiceLabel.length === 0) {
      return false;
    }
    return resolveOwnerComparableLabelsForEntry(entry).includes(activeServiceLabel);
  };

  const resolveConfiguredCliVersionForEntry = (entry: DaemonServiceListEntry): string | null => {
    const installedPath = String(entry.path ?? '').trim();
    const derivedHappierHomeDir = (() => {
      if (!installedPath) return '';
      if (entry.platform === 'linux' && (entry.mode ?? 'user') === 'user') {
        const marker = '/.config/systemd/user/';
        const index = installedPath.indexOf(marker);
        if (index > 0) return join(installedPath.slice(0, index), '.happier');
      }
      if (entry.platform === 'darwin') {
        const marker = '/Library/LaunchAgents/';
        const index = installedPath.indexOf(marker);
        if (index > 0) return join(installedPath.slice(0, index), '.happier');
      }
      if (entry.platform === 'win32') {
        const normalizedPath = installedPath.replaceAll('/', '\\');
        const marker = '\\services\\';
        const index = normalizedPath.toLowerCase().lastIndexOf(marker.toLowerCase());
        if (index > 0) return normalizedPath.slice(0, index);
      }
      return '';
    })();
    const happierHomeDir = String(entry.happierHomeDir ?? '').trim() || derivedHappierHomeDir;
    if (!happierHomeDir) return null;

    const installRoot = entry.releaseChannel === 'preview'
      ? 'cli-preview'
      : entry.releaseChannel === 'publicdev'
        ? 'cli-dev'
        : 'cli';
    const binaryName = entry.platform === 'win32' ? 'happier.exe' : 'happier';
    const binaryPath = join(happierHomeDir, installRoot, 'current', binaryName);
    if (configuredCliVersionByBinaryPathCache.has(binaryPath)) {
      return configuredCliVersionByBinaryPathCache.get(binaryPath) ?? null;
    }
    if (!readFileSync || !statSync) {
      configuredCliVersionByBinaryPathCache.set(binaryPath, null);
      return null;
    }
    try {
      statSync(binaryPath);
    } catch {
      configuredCliVersionByBinaryPathCache.set(binaryPath, null);
      return null;
    }

    try {
      const versionTimeoutMs = readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_VERSION_TIMEOUT_MS', 2000);
      let res = spawnSync(binaryPath, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: versionTimeoutMs,
        env: buildServiceCommandEnv({ cmd: binaryPath, args: ['--version'], env: process.env }),
      });
      if (res.status !== 0 && entry.platform !== 'win32') {
        res = spawnSync('bash', [binaryPath, '--version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: versionTimeoutMs,
          env: buildServiceCommandEnv({ cmd: 'bash', args: [binaryPath, '--version'], env: process.env }),
        });
      }
      const version = String(res.stdout ?? '').trim().split(/\r?\n/u)[0]?.trim() || null;
      const normalizedVersion = res.status === 0 && version ? version : null;
      configuredCliVersionByBinaryPathCache.set(binaryPath, normalizedVersion);
      return normalizedVersion;
    } catch {
      configuredCliVersionByBinaryPathCache.set(binaryPath, null);
      return null;
    }
  };

  const resolveRunningStateForEntry = (entry: DaemonServiceListEntry): boolean => {
    if (isEntryCurrentActiveOwner(entry)) {
      return true;
    }

    if (!entry.installed) {
      return false;
    }

    if (entry.platform === 'linux') {
      const unitName = basename(String(entry.path ?? '').trim());
      if (!unitName || unitName === '.' || unitName === '..') {
        return false;
      }

      const args = (entry.mode ?? 'user') === 'system'
        ? ['is-active', unitName]
        : ['--user', 'is-active', unitName];

      try {
        const res = spawnSync('systemctl', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: runningStateTimeoutMs,
          env: buildServiceCommandEnv({ cmd: 'systemctl', args, env: process.env }),
        });

        const out = `${res.stdout ? String(res.stdout) : ''}${res.stderr ? String(res.stderr) : ''}`
          .trim()
          .toLowerCase();
        if (!out) return false;

        const state = out.split(/\s+/)[0] ?? '';
        return state === 'active' || state === 'activating' || state === 'reloading';
      } catch {
        return false;
      }
    }

    if (entry.platform === 'darwin') {
      const uid = process.getuid?.();
      if (typeof uid !== 'number' || uid < 0) {
        return false;
      }
      const label = String(entry.label ?? '').trim()
        || resolveDaemonServiceLaunchdLabel(entry.serverId, entry.releaseChannel, entry.targetMode);
      if (!label) {
        return false;
      }
      const args = ['print', `gui/${uid}/${label}`];
      try {
        const res = spawnSync('launchctl', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: runningStateTimeoutMs,
          env: buildServiceCommandEnv({ cmd: 'launchctl', args, env: process.env }),
        });
        if ((res.status ?? 1) !== 0) {
          return false;
        }
        const out = `${res.stdout ? String(res.stdout) : ''}${res.stderr ? String(res.stderr) : ''}`
          .trim()
          .toLowerCase();
        return /(^|\n)\s*state\s*=\s*running(\r?\n|$)/u.test(out);
      } catch {
        return false;
      }
    }

    if (entry.platform === 'win32') {
      const taskName = resolveWindowsDaemonTaskName({
        instanceId: entry.serverId,
        channel: entry.releaseChannel,
        targetMode: entry.targetMode,
      });
      const args = ['/Query', '/TN', taskName, '/FO', 'LIST', '/V'];
      try {
        const res = spawnSync('schtasks', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: runningStateTimeoutMs,
          env: buildServiceCommandEnv({ cmd: 'schtasks', args, env: process.env }),
        });
        const out = `${res.stdout ? String(res.stdout) : ''}${res.stderr ? String(res.stderr) : ''}`
          .trim()
          .toLowerCase();
        if ((res.status ?? 1) !== 0 || !out) {
          return false;
        }
        return /(^|\n)\s*status:\s*running(\r?\n|$)/u.test(out);
      } catch {
        return false;
      }
    }

    return false;
  };

  return entries.map((entry) => ({
    serviceType: 'daemon',
    label: entry.label,
    ring: entry.releaseChannel,
    targetMode: entry.targetMode,
    mode: entry.mode,
    installed: entry.installed,
    running: resolveRunningStateForEntry(entry),
    definitionPath: entry.path,
    instanceId: entry.serverId,
    configuredCliVersion: resolveConfiguredCliVersionForEntry(entry),
    runningCliVersion: (() => {
      if (!activeOwnerCliVersion || activeServiceLabel.length === 0) {
        return null;
      }
      if (isEntryCurrentActiveOwner(entry)) {
        return activeOwnerCliVersion;
      }
      return null;
    })(),
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
    mode: entry.mode ?? mode,
    definitionPath: entry.path,
    ring: entry.releaseChannel,
    instanceId: entry.serverId,
    targetMode: entry.targetMode,
  }));
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
    const entries = await resolveDaemonServiceListEntries(runtime, { mode, systemUser, deep: flags.deep });
    const ownership = await evaluateCurrentDaemonOwner();
    const activeServiceLabel = ownership.kind !== 'none' && ownership.owner.serviceManaged === true
      ? ownership.owner.state.serviceLabel
      : null;
    const activeOwnerCliVersion = ownership.kind !== 'none' && ownership.owner.serviceManaged === true
      ? ownership.owner.state.startedWithCliVersion
      : null;
    const services = mapDaemonServiceListEntriesToInventory(entries, { activeServiceLabel, activeOwnerCliVersion });

    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform, entries, services });
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
      if (service.mode) process.stdout.write(`  ${kv('Mode:', service.mode)}\n`);
      process.stdout.write(`  ${kv('Target:', describeBackgroundServiceTargetMode(service.targetMode))}\n`);
      if (service.configuredCliVersion) process.stdout.write(`  ${kv('Configured CLI version:', service.configuredCliVersion)}\n`);
      if (service.runningCliVersion) process.stdout.write(`  ${kv('Running CLI version:', service.runningCliVersion)}\n`);
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

    const runInstall = async (): Promise<void> => {
      await stopCurrentWindowsServiceOwnerIfNeeded({
        platform: installRuntime.platform,
        ownership,
        expectedServiceLabel: paths.label,
        action: 'install',
      });
      await installDaemonService({
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
        startExisting: true,
      });
      if (takeoverDecision.kind === 'manual-owner-takeover') {
        await assertExpectedDaemonServiceOwnership({
          action: 'install',
          platform: installRuntime.platform,
          expectedServiceLabel: paths.label,
          allowOwnerVersionMismatch: true,
          expectedInstalledServiceContents: plan.files[0]?.content ?? null,
          installedServicePath: paths.installedPath,
        });
      }
    };

    try {
      if (takeoverDecision.kind === 'manual-owner-takeover') {
        await withManualRelayTakeoverRecovery({
          shouldTakeOverManualOwner: true,
          action: 'install',
          stopBeforeRun: false,
          run: runInstall,
        });
      } else {
        await runInstall();
      }
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
      ? await resolveDaemonServiceListEntries(runtime, { mode, systemUser })
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
          installedPath: service.definitionPath,
        }))
      : [{
          platform: runtime.platform,
          mode,
          channel: runtime.channel,
          targetMode: runtime.targetMode,
          instanceId: runtime.instanceId,
          installedPath: null,
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
          mode: service.mode,
          definitionPath: service.definitionPath,
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
      await stopCurrentWindowsServiceOwnerIfNeeded({
        platform: target.platform,
        ownership: await evaluateCurrentDaemonOwner(),
        expectedServiceLabel: paths.label,
        action: 'uninstall',
      });
      await uninstallDaemonService({
        platform: target.platform,
        uid: runtime.uid ?? undefined,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        mode: target.mode,
        channel: target.channel,
        targetMode: target.targetMode,
        instanceId: target.instanceId,
        installedPath: target.installedPath,
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
          await stopCurrentWindowsServiceOwnerIfNeeded({
            platform: runtime.platform,
            ownership,
            expectedServiceLabel: paths.label,
            action,
          });
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
            allowOwnerVersionMismatch: true,
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

    await stopCurrentWindowsServiceOwnerIfNeeded({
      platform: runtime.platform,
      ownership,
      expectedServiceLabel: paths.label,
      action: 'stop',
    });
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
