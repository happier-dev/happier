import * as fs from 'node:fs';
import * as os from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { configuration, reloadConfiguration } from '@/configuration';
import { readCredentials, readDaemonState, readSettings } from '@/persistence';
import { getActiveServerProfile, upsertServerProfileByUrl } from '@/server/serverProfiles';
import { isBun } from '@/utils/runtime';
import { buildMissingLocalRelayError, resolveLocalRelay } from '@/utils/localRelay';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { defaultNameFromUrl, defaultWebappUrlFromServerUrl } from '@/cli/commands/server/commandUtilities';
import { applyDaemonServiceInstallPlan, runDaemonServiceCommands } from './apply';
import { buildServiceCommandEnv } from '@happier-dev/cli-common/service';

import { resolveCliVersionFromBinary } from './resolveCliVersionFromBinary';
import {
  describeDaemonServiceInstallConflict,
  installDaemonService,
  previewDaemonServiceInstall,
  uninstallDaemonService,
} from './installer';
import {
  planDaemonServiceInstall,
  planDaemonServiceLifecycle,
  planDaemonServiceUninstall,
  resolveLaunchAgentPlistPath,
  resolveSystemdUserUnitPath,
  resolveSystemdSystemUnitPath,
  resolveWindowsDaemonWrapperPath,
  resolveWindowsDaemonTaskName,
  resolveWindowsDaemonServiceLogPaths,
  resolveDaemonServiceLaunchdLabel,
  resolveDaemonServiceSystemdUnitName,
  resolveDaemonServiceChannelSegment,
  type DaemonServiceMode,
  type DaemonServiceTargetMode,
} from './plan';
import { collectWindowsServiceLaunchDiagnostics } from './collectWindowsServiceLaunchDiagnostics';
import { commandExistsInPath } from './commandExistsInPath';
import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget';
import { resolveDaemonServiceInstallRuntimeTarget } from './resolveDaemonServiceInstallRuntimeTarget';
import { resolveLinuxSystemUserPaths } from './resolveLinuxSystemUserPaths';
import { getReleaseRingPublicLabel, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { expandHomeDirPath } from '@happier-dev/cli-common/providers';
import {
  DAEMON_SERVICE_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
  resolveManagedCliReleaseChannelSync,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { stopDaemon } from '@/daemon/controlClient';
import { restartDaemonAndWait } from '@/daemon/restartDaemonAndWait';

import { discoverInstalledDaemonServiceEntries } from './discoverInstalledDaemonServiceEntries';
import { isValidInstalledDaemonServiceFile } from './discoverInstalledDaemonServiceEntries';
import { resolveDaemonServiceDiscoveryTargets } from './resolveDaemonServiceDiscoveryTargets';
import type { DaemonServiceInstallStrategy } from './daemonInstallConflict';
import { assertDaemonServiceModeSupported } from './assertDaemonServiceModeSupported';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { doesInstalledDaemonServiceDefinitionMatchExpected } from './doesInstalledDaemonServiceDefinitionMatchExpected';
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
import { resolveInstalledDaemonServiceInventoryForCurrentRelay, renderDaemonServiceInventory } from '@/daemon/ownership/daemonServiceInventory';
import {
  evaluateDaemonServiceLifecycleOwnership,
  renderDaemonServiceStopOwnershipNote,
  renderDaemonServiceLifecycleOwnershipConflict,
} from '@/daemon/ownership/evaluateServiceLifecycleOwnership';
import { waitForDaemonRunningWithinBudget } from '@/daemon/waitForDaemonRunningWithinBudget';
import {
  buildDaemonServiceTakeoverHint,
  buildDaemonServiceTakeoverNotice,
  resolveDaemonServiceTakeoverDecision,
} from './resolveDaemonServiceTakeoverDecision';

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
    return 'manual daemon start';
  }
  return 'unknown';
}

function refreshDarwinLaunchAgentDefinitionForBootstrap(installedPath: string): void {
  const path = String(installedPath ?? '').trim();
  if (!path) {
    return;
  }

  const currentMtimeMs = (() => {
    try {
      return fs.statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  })();
  const refreshTime = new Date(Math.max(Date.now(), currentMtimeMs + 1000));
  fs.utimesSync(path, refreshTime, refreshTime);
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

function parseCliFlags(argv: readonly string[]): Readonly<{ json: boolean; dryRun: boolean; help: boolean }> {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  return {
    json: flags.has('--json'),
    dryRun: flags.has('--dry-run') || flags.has('--plan'),
    help: flags.has('--help') || flags.has('-h'),
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
    yes: boolean;
    takeover: boolean;
    replaceExisting: 'ring' | 'all' | null;
    ring: PublicReleaseRingId | null;
    instanceId: string | null;
  }>;
  action: DaemonServiceCliAction;
  mode: DaemonServiceMode;
  modeExplicit: boolean;
  systemUser: string;
}> {
  const filtered: string[] = [];
  let modeFromArgs: DaemonServiceMode | null = null;
  let modeExplicit = false;
  let systemUserFromArgs: string | null = null;
  let yes = false;
  let takeover = false;
  let replaceExisting: 'ring' | 'all' | null = null;
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
      modeExplicit = true;
      i += 1;
      continue;
    }
    if (a.startsWith('--mode=')) {
      modeFromArgs = resolveModeFromText(a.slice('--mode='.length), '--mode');
      modeExplicit = true;
      continue;
    }
    if (a === '--system') {
      modeFromArgs = 'system';
      modeExplicit = true;
      continue;
    }
    if (a === '--user') {
      modeFromArgs = 'user';
      modeExplicit = true;
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
    if (a === '--ring') {
      const next = String(argv[i + 1] ?? '').trim().toLowerCase();
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --ring (expected stable|preview|dev)');
      }
      if (next === 'stable') ring = 'stable';
      else if (next === 'preview') ring = 'preview';
      else if (next === 'dev') ring = 'publicdev';
      else throw new Error(`Invalid --ring value "${next}" (expected stable|preview|dev)`);
      i += 1;
      continue;
    }
    if (a.startsWith('--ring=')) {
      const value = a.slice('--ring='.length).trim().toLowerCase();
      if (value === 'stable') ring = 'stable';
      else if (value === 'preview') ring = 'preview';
      else if (value === 'dev') ring = 'publicdev';
      else throw new Error(`Invalid --ring value "${value}" (expected stable|preview|dev)`);
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

  return {
    argvFiltered: filtered,
    flags: { ...flags, yes, takeover, replaceExisting, ring, instanceId },
    action,
    mode,
    modeExplicit,
    systemUser,
  };
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

function resolveDaemonServiceDiscoveryModes(params: Readonly<{
  platform: SupportedPlatform;
  mode?: DaemonServiceMode;
  includeAllModes?: boolean;
}>): readonly DaemonServiceMode[] {
  if (params.platform !== 'linux') {
    return ['user'];
  }
  if (params.includeAllModes === true) {
    return ['user', 'system'];
  }
  return [params.mode === 'system' ? 'system' : 'user'];
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

      if (ownership.kind !== 'compatible') {
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
  /**
   * Windows-only post-mortem hooks. When the wait times out on Windows we
   * query scheduled-task launch metadata and tail the wrapper's stdout/stderr
   * logs so the resulting error tells the user *why* the daemon never claimed
   * ownership instead of just "180000ms".
   */
  windowsLaunchDiagnostics?: Readonly<{
    taskName: string;
    stdoutPath: string;
    stderrPath: string;
  }> | null;
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

  let message =
    `Background service ${params.action} completed, but the expected background service did not become the active daemon for the selected relay ` +
    `within ${effectiveTimeoutMs}ms. Run \`happier service status\` to inspect the active owner and system service state.`;

  if (params.platform === 'win32' && params.windowsLaunchDiagnostics) {
    const diagnostics = collectWindowsServiceLaunchDiagnostics({
      taskName: params.windowsLaunchDiagnostics.taskName,
      stdoutPath: params.windowsLaunchDiagnostics.stdoutPath,
      stderrPath: params.windowsLaunchDiagnostics.stderrPath,
    });
    if (diagnostics) {
      message += `\n\n${diagnostics}`;
    }
  }

  throw new Error(message);
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
        `Failed to ${params.action} the background service after stopping the current manually started daemon. ` +
        `The previous manual daemon was restored.\n${originalMessage}`,
      );
    }
    throw new Error(
      `Failed to ${params.action} the background service after stopping the current manually started daemon, ` +
      `and restoring the previous manual daemon also failed.\n${originalMessage}`,
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
  return String(raw ?? '').trim().toLowerCase() === 'default-following' ? 'default-following' : 'pinned';
}

function resolveDaemonServiceServerTargets(processEnv: NodeJS.ProcessEnv): Readonly<{
  serverUrl: string;
  publicServerUrl: string;
  webappUrl: string;
}> {
  const explicitServerUrl = String(processEnv.HAPPIER_SERVER_URL ?? '').trim();
  const explicitLocalServerUrl = String(processEnv.HAPPIER_LOCAL_SERVER_URL ?? '').trim();
  const explicitPublicServerUrl = String(processEnv.HAPPIER_PUBLIC_SERVER_URL ?? '').trim();
  const explicitWebappUrl = String(processEnv.HAPPIER_WEBAPP_URL ?? '').trim();

  if (explicitPublicServerUrl || explicitServerUrl) {
    const publicServerUrl = explicitPublicServerUrl || explicitServerUrl;
    const serverUrl = explicitLocalServerUrl || (explicitPublicServerUrl ? explicitServerUrl : '') || publicServerUrl;
    return {
      serverUrl,
      publicServerUrl,
      webappUrl: explicitWebappUrl || configuration.webappUrl,
    };
  }

  return {
    serverUrl: configuration.apiServerUrl,
    publicServerUrl: configuration.serverUrl,
    webappUrl: configuration.webappUrl,
  };
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
    throw new Error('Daemon service is currently only supported on macOS, Linux, and Windows');
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
  const shouldPreferSudoInvokerHappierHomeDir =
    platform === 'linux'
    && options.mode !== 'system'
    && uid === 0
    && Boolean(sudoInvokerUserPaths?.happierHomeDir)
    && !explicitHappierHomeDir
    && !String(processEnv.HAPPIER_HOME_DIR ?? '').trim();
  const happierHomeDir = systemUserPaths?.happierHomeDir
    || explicitHappierHomeDir
    || (shouldPreferSudoInvokerHappierHomeDir ? sudoInvokerUserPaths?.happierHomeDir : null)
    || configuration.happyHomeDir;
  const targetMode = options.targetMode ?? resolveDaemonServiceTargetModeFromText(processEnv.HAPPIER_DAEMON_SERVICE_TARGET_MODE || 'default-following');
  const instanceId = String(options.instanceId ?? '').trim() || (processEnv.HAPPIER_DAEMON_SERVICE_INSTANCE_ID ?? '').trim() || configuration.activeServerId;
  const resolvedServerTargets = resolveDaemonServiceServerTargets(processEnv);
  const serverUrl = (processEnv.HAPPIER_DAEMON_SERVICE_SERVER_URL ?? '').trim() || resolvedServerTargets.serverUrl;
  const webappUrl = (processEnv.HAPPIER_DAEMON_SERVICE_WEBAPP_URL ?? '').trim() || resolvedServerTargets.webappUrl;
  const publicServerUrl = (processEnv.HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL ?? '').trim() || resolvedServerTargets.publicServerUrl;
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
    resolveManagedCliReleaseChannelSync({
      processEnv,
      argv: process.argv,
      envKeys: DAEMON_SERVICE_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
      additionalCandidates: [
        explicitEntryPath,
        runtimeTarget.entryPath,
        runtimeTarget.nodePath,
      ],
    }).ringId;

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
  relayUrl?: string | null;
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

export type DaemonServiceInventoryEntry = Readonly<{
  serviceType: 'daemon';
  platform: SupportedPlatform;
  serverId: string;
  name: string;
  relayUrl?: string | null;
  path: string;
  mode?: DaemonServiceMode;
  label: string;
  ring: PublicReleaseRingId;
  targetMode: DaemonServiceTargetMode;
  installed: boolean;
  running: boolean;
  configuredCliVersion: string | null;
  runningCliVersion: string | null;
}>;

export function resolveDaemonServiceInstallationSnapshotFromEnv(options: Readonly<{
  mode?: DaemonServiceMode;
  systemUser?: string;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): DaemonServiceInstallationSnapshot {
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
  const logPaths = runtime.platform === 'win32'
    ? resolveWindowsDaemonServiceLogPaths({
        happierHomeDir: runtime.happierHomeDir,
        instanceId: runtime.instanceId,
        channel: runtime.channel,
        targetMode: runtime.targetMode,
      })
    : (() => {
        const logPrefix = runtime.targetMode === 'default-following'
          ? ''
          : (() => {
              const channelSegment = resolveDaemonServiceChannelSegment(runtime.channel);
              return channelSegment ? `${channelSegment}.` : '';
            })();
        const logInstanceId = runtime.targetMode === 'default-following' ? 'default' : runtime.instanceId;
        return {
          stdoutPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.out.log`),
          stderrPath: join(runtime.happierHomeDir, 'logs', `daemon-service.${logPrefix}${logInstanceId}.err.log`),
        };
      })();
  return {
    platform: runtime.platform,
    label,
    unitName,
    plistPath,
    unitPath,
    wrapperPath,
    taskName,
    installedPath,
    stdoutPath: logPaths.stdoutPath,
    stderrPath: logPaths.stderrPath,
  };
}

export async function resolveDaemonServiceListEntries(
  runtime: DaemonServiceCliRuntime,
  options: Readonly<{ mode?: DaemonServiceMode; includeAllModes?: boolean; systemUser?: string }> = {},
): Promise<readonly DaemonServiceListEntry[]> {
  const settings = await readSettings();
  const allowedModes = new Set(resolveDaemonServiceDiscoveryModes({
    platform: runtime.platform,
    mode: options.mode,
    includeAllModes: options.includeAllModes,
  }));
  const entries = await Promise.all(
    resolveDaemonServiceDiscoveryTargets({
      platform: runtime.platform,
      mode: options.mode,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
    })
      .filter((target) => allowedModes.has(target.mode))
      .map(async (target) => await discoverInstalledDaemonServiceEntries({
        platform: runtime.platform,
        userHomeDir: target.userHomeDir,
        happierHomeDir: target.happierHomeDir,
        mode: target.mode,
        serversById: (settings.servers ?? {}) as Readonly<Record<string, unknown>>,
      })),
  );

  const resolvedEntries = entries
    .flat()
    .filter((entry, index, allEntries) => allEntries.findIndex((candidate) => candidate.path === entry.path) === index);

  if (!options.mode) {
    return resolvedEntries;
  }
  if (runtime.platform === 'linux' && options.mode === 'system' && !String(options.systemUser ?? '').trim()) {
    return resolvedEntries;
  }

  const expectedDefaultRuntimeTarget = await resolveDaemonServiceInstallRuntimeTarget({
    allowBootstrap: false,
    currentExecPath: runtime.nodePath,
    targetMode: 'default-following',
    processEnv: {
      ...process.env,
      HAPPIER_HOME_DIR: runtime.happierHomeDir,
    },
  }).catch(() => ({
    nodePath: runtime.nodePath,
    entryPath: runtime.entryPath,
  }));

  const expectedDefaultPlan = planDaemonServiceInstall({
    platform: runtime.platform,
    mode: options.mode,
    systemUser: options.mode === 'system' ? String(options.systemUser ?? '').trim() : undefined,
    channel: runtime.channel,
    targetMode: 'default-following',
    instanceId: runtime.instanceId,
    uid: runtime.uid ?? undefined,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
    serverUrl: runtime.serverUrl,
    webappUrl: runtime.webappUrl,
    publicServerUrl: runtime.publicServerUrl,
    nodePath: expectedDefaultRuntimeTarget.nodePath,
    entryPath: expectedDefaultRuntimeTarget.entryPath,
  });
  const expectedDefaultFile = expectedDefaultPlan.files[0] ?? null;
  if (!expectedDefaultFile) {
    return resolvedEntries;
  }

  return resolvedEntries.map((entry) => {
    if (
      entry.targetMode !== 'default-following'
      || entry.releaseChannel !== runtime.channel
    ) {
      return entry;
    }

    return {
      ...entry,
      installedDefinitionMatchesExpected: entry.path === expectedDefaultFile.path
        && doesInstalledDaemonServiceDefinitionMatchExpected({
          installedPath: entry.path,
          expectedContents: expectedDefaultFile.content,
        }),
    };
  });
}

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

  const resolveInventoryLabelForEntry = (entry: DaemonServiceListEntry): string => {
    const explicitLabel = String(entry.label ?? '').trim();
    if (explicitLabel) {
      return explicitLabel;
    }
    return resolveDaemonServiceLaunchdLabel(entry.serverId, entry.releaseChannel, entry.targetMode);
  };

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
      if (!installedPath) {
        return '';
      }
      if (entry.platform === 'linux' && (entry.mode ?? 'user') === 'user') {
        const marker = `${String.raw`/.config/systemd/user/`}`;
        const index = installedPath.indexOf(marker);
        if (index > 0) {
          return join(installedPath.slice(0, index), '.happier');
        }
      }
      if (entry.platform === 'darwin') {
        const marker = `${String.raw`/Library/LaunchAgents/`}`;
        const index = installedPath.indexOf(marker);
        if (index > 0) {
          return join(installedPath.slice(0, index), '.happier');
        }
      }
      if (entry.platform === 'win32') {
        const normalizedPath = installedPath.replaceAll('/', '\\');
        const marker = '\\services\\';
        const lowerPath = normalizedPath.toLowerCase();
        const index = lowerPath.lastIndexOf(marker.toLowerCase());
        if (index > 0) {
          return normalizedPath.slice(0, index);
        }
      }
      return '';
    })();
    const happierHomeDir = String(entry.happierHomeDir ?? '').trim() || derivedHappierHomeDir;
    if (!happierHomeDir) {
      return null;
    }

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
    const versionTimeoutMs = readPositiveIntEnv('HAPPIER_DAEMON_SERVICE_VERSION_TIMEOUT_MS', 2000);
    const version = resolveCliVersionFromBinary({
      binaryPath,
      platform: entry.platform,
      timeoutMs: versionTimeoutMs,
    });
    configuredCliVersionByBinaryPathCache.set(binaryPath, version);
    return version;
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
      const label = resolveInventoryLabelForEntry(entry);
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
    platform: entry.platform,
    serverId: entry.serverId,
    name: entry.name,
    relayUrl: entry.relayUrl ?? null,
    path: entry.path,
    mode: entry.mode,
    label: entry.label,
    ring: entry.releaseChannel,
    targetMode: entry.targetMode,
    installed: entry.installed,
    running: resolveRunningStateForEntry(entry),
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

export async function resolveDaemonServiceInventoryEntries(params: Readonly<{
  runtime: DaemonServiceCliRuntime;
  mode?: DaemonServiceMode;
  includeAllModes?: boolean;
  systemUser?: string;
}>): Promise<readonly DaemonServiceInventoryEntry[]> {
  const entries = await resolveDaemonServiceListEntries(params.runtime, {
    mode: params.mode,
    systemUser: params.systemUser,
    includeAllModes: params.includeAllModes,
  });
  const ownership = await evaluateCurrentDaemonOwner();
  return mapDaemonServiceListEntriesToInventory(entries, {
    activeServiceLabel: ownership.kind !== 'none' && ownership.owner.serviceManaged === true
      ? ownership.owner.state.serviceLabel
      : null,
    activeOwnerCliVersion: ownership.kind !== 'none' && ownership.owner.serviceManaged === true
      ? ownership.owner.state.startedWithCliVersion
      : null,
  });
}

/**
 * When `--local-relay` is passed to `service install`, resolve the current
 * channel's local relay URL and ensure it's the active server profile before
 * the install runs (install uses the active profile to bake `HAPPIER_ACTIVE_SERVER_ID`
 * for pinned services, or as the default-follow target for default-following).
 *
 * Returns the argv with `--local-relay` stripped.
 */
async function handleLocalRelayFlag(argv: readonly string[]): Promise<string[]> {
  if (!argv.includes('--local-relay')) {
    return [...argv];
  }
  const match = await resolveLocalRelay();
  if (!match) {
    const currentChannel = getReleaseRingPublicLabel(
      resolveManagedCliReleaseChannelSync({ processEnv: process.env, argv: process.argv }).ringId,
    );
    throw new Error(await buildMissingLocalRelayError(currentChannel));
  }
  // Surface the resolved channel so the user sees which relay is being picked.
  console.log(`  (local relay on ${match.channel} channel: ${match.url})`);
  const activeBefore = await getActiveServerProfile();
  const needsActivate = activeBefore.id === 'cloud'
    || (activeBefore.serverUrl !== match.url && activeBefore.localServerUrl !== match.url);
  if (needsActivate) {
    await upsertServerProfileByUrl({
      name: defaultNameFromUrl(match.url),
      serverUrl: match.url,
      webappUrl: defaultWebappUrlFromServerUrl(match.url),
      use: true,
    });
    reloadConfiguration();
  }
  return argv.filter((a) => a !== '--local-relay');
}

export async function runDaemonServiceCliCommand(params: Readonly<{ argv: readonly string[] }>): Promise<void> {
  const argvAfterLocalRelay = await handleLocalRelayFlag(params.argv);
  const parsed = parseDaemonServiceCliInvocation(argvAfterLocalRelay);
  const flags = parsed.flags;
  const mode = parsed.mode;
  const systemUser = parsed.systemUser;
  const targetMode: DaemonServiceTargetMode =
    flags.ring || flags.instanceId
      ? 'pinned'
      : resolveDaemonServiceTargetModeFromText(process.env.HAPPIER_DAEMON_SERVICE_TARGET_MODE || 'default-following');
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({
    mode,
    systemUser,
    channel: flags.ring,
    targetMode,
    instanceId: flags.instanceId,
  });
  if (!flags.help) {
    assertDaemonServiceModeSupported(runtime.platform, mode);
  }
  const paths = resolveDaemonServicePaths(runtime, { mode });
  const action = parsed.action;

  if (flags.help) {
      if (flags.json) {
        printJson({
          ok: true,
          commands: ['list', 'paths', 'install', 'uninstall', 'repair', 'start', 'stop', 'restart', 'status', 'logs', 'tail'],
          flags: ['--json', '--dry-run', '--yes', '--takeover', '--replace-existing=ring|all', '--ring', '--instance', '--all'],
        });
        return;
    }
    process.stdout.write(
      [
        'happier service',
        '',
        'Usage:',
        '  happier service list [--json]',
        '  happier service paths [--json]',
        '  happier service status [--json]',
        '  happier service install [--local-relay] [--dry-run] [--yes] [--takeover] [--replace-existing=ring|all] [--json]',
        '  happier service uninstall [--ring <stable|preview|dev>] [--instance <id>] [--all] [--yes] [--dry-run] [--json]',
        '  happier service repair [--yes] [--json] (legacy alias for `happier doctor repair`)',
        '  happier service start|stop|restart [--dry-run] [--takeover] [--json]',
        '  happier service logs [--json]',
        '  happier service tail',
        '',
        'Compatibility aliases:',
        '  happier daemon service ...',
        '',
      ].join('\n'),
    );
    return;
  }

  if (action === 'list') {
    const includeAllModes = runtime.platform === 'linux' && parsed.modeExplicit !== true;
    const entries = await resolveDaemonServiceListEntries(runtime, {
      mode,
      systemUser,
      includeAllModes,
    });
    if (flags.json) {
      printJson({
        entries,
        services: await resolveDaemonServiceInventoryEntries({
          runtime,
          mode,
          systemUser,
          includeAllModes,
        }),
      });
      return;
    }

    if (entries.length === 0) {
      process.stdout.write('(no background services installed)\n');
      return;
    }

    for (const entry of entries) {
      const modeSuffix = entry.mode ? `, ${entry.mode}` : '';
      process.stdout.write(`${entry.name} (${entry.serverId}, ${entry.releaseChannel}${modeSuffix})\n`);
      process.stdout.write(`  ${entry.installed ? 'installed' : 'not installed'}: ${entry.path}\n`);
    }
    return;
  }

  if (action === 'paths') {
    if (flags.json) {
      printJson({
        ok: true,
        platform: runtime.platform,
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
        ? [...message.lines, buildDaemonServiceTakeoverHint({ commandPath: 'happier service', action: 'install' })]
        : [...message.lines];
      if (flags.json) {
        printJson({
          ok: false,
          error: 'owner_conflict',
          message: `${message.title} ${lines.join(' ')}`.trim(),
          platform: installRuntime.platform,
        });
        return;
      }
      process.stderr.write(`${message.title}\n`);
      for (const line of lines) {
        process.stderr.write(`  ${line}\n`);
      }
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

    const strategy: DaemonServiceInstallStrategy | undefined =
      flags.replaceExisting === 'ring' ? 'replace-ring'
      : flags.replaceExisting === 'all' ? 'replace-all'
      : flags.yes ? 'add'
      : undefined;

    if (flags.dryRun) {
      const preview = await previewDaemonServiceInstall({
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
        strategy,
        serverUrl: installRuntime.serverUrl,
        webappUrl: installRuntime.webappUrl,
        publicServerUrl: installRuntime.publicServerUrl,
        nodePath: installRuntime.nodePath,
        entryPath: installRuntime.entryPath,
      });
      const installConflict = describeDaemonServiceInstallConflict({
        exactTargetExists: preview.exactTargetExists,
        strategy: preview.strategy,
        conflictPlan: preview.conflictPlan,
      });
      if (flags.json) {
        printJson({
          ok: true,
          platform: installRuntime.platform,
          plan: preview.plan,
          installConflict: installConflict ? {
            blocking: installConflict.blocking,
            message: installConflict.message,
            exactTargetExists: preview.exactTargetExists,
            competingServices: preview.conflictPlan.competingServices,
            servicesToRemove: preview.conflictPlan.servicesToRemove,
          } : undefined,
          takeover: takeoverNotice ? `${takeoverNotice.title} ${takeoverNotice.lines.join(' ')}`.trim() : undefined,
        });
        return;
      }
      process.stdout.write(`[dry-run] would write: ${preview.plan.files.map((f) => f.path).join(', ')}\n`);
      for (const c of preview.plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      if (installConflict) {
        process.stdout.write(`${installConflict.message}\n`);
      }
      if (takeoverNotice) {
        process.stdout.write(`${takeoverNotice.title}\n`);
        for (const line of takeoverNotice.lines) {
          process.stdout.write(`  ${line}\n`);
        }
      }
      return;
    }

    try {
      await withManualRelayTakeoverRecovery({
        shouldTakeOverManualOwner: takeoverDecision.kind === 'manual-owner-takeover',
        action: 'install',
        run: async () => {
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
          });
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
            windowsLaunchDiagnostics: installRuntime.platform === 'win32'
              ? {
                  taskName: resolveWindowsDaemonTaskName({
                    instanceId: installRuntime.instanceId,
                    channel: installRuntime.channel,
                    targetMode: installRuntime.targetMode,
                  }),
                  ...resolveWindowsDaemonServiceLogPaths({
                    happierHomeDir: installRuntime.happierHomeDir,
                    instanceId: installRuntime.instanceId,
                    channel: installRuntime.channel,
                    targetMode: installRuntime.targetMode,
                  }),
                }
              : null,
          });
        },
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
        takeover: takeoverNotice ? `${takeoverNotice.title} ${takeoverNotice.lines.join(' ')}`.trim() : undefined,
      });
      return;
    }
    process.stdout.write('Background service installed.\n');
    if (takeoverNotice) {
      process.stdout.write(`${takeoverNotice.title}\n`);
      for (const line of takeoverNotice.lines) {
        process.stdout.write(`  ${line}\n`);
      }
    }
    return;
  }

  if (action === 'uninstall') {
    if (runtime.platform === 'linux' && mode === 'system') {
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Root privileges are required for system mode service uninstall');
      }
    }

    const wantsAll = parsed.argvFiltered.includes('--all');
    const confirmed = flags.yes;
    if (wantsAll) {
      const entries = await resolveDaemonServiceListEntries(runtime, {
        mode,
        systemUser,
        includeAllModes: runtime.platform === 'linux' && mode === 'system',
      });
      const discoveryTargetByMode = new Map(
        resolveDaemonServiceDiscoveryTargets({
          platform: runtime.platform,
          mode,
          userHomeDir: runtime.userHomeDir,
          happierHomeDir: runtime.happierHomeDir,
        }).map((target) => [target.mode, target] as const),
      );
      const plans = entries.map((entry) => {
        const entryMode = entry.mode ?? mode;
        const discoveryTarget = discoveryTargetByMode.get(entryMode) ?? {
          mode: entryMode,
          userHomeDir: runtime.userHomeDir,
          happierHomeDir: runtime.happierHomeDir,
        };
        return planDaemonServiceUninstall({
          platform: runtime.platform,
          mode: entryMode,
          channel: entry.releaseChannel,
          targetMode: entry.targetMode,
          instanceId: entry.serverId,
          uid: runtime.uid ?? undefined,
          userHomeDir: discoveryTarget.userHomeDir,
          happierHomeDir: discoveryTarget.happierHomeDir,
          installedPath: entry.path,
        });
      });

      if (flags.dryRun || !confirmed) {
        if (flags.json) {
          printJson({ ok: true, platform: runtime.platform, removed: entries.length, plans });
          return;
        }
        for (const plan of plans) {
          process.stdout.write(`[dry-run] would remove: ${plan.filesToRemove.join(', ')}\n`);
          for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
        }
        return;
      }

      for (const entry of entries) {
        const entryMode = entry.mode ?? mode;
        const discoveryTarget = discoveryTargetByMode.get(entryMode) ?? {
          mode: entryMode,
          userHomeDir: runtime.userHomeDir,
          happierHomeDir: runtime.happierHomeDir,
        };
        await stopCurrentWindowsServiceOwnerIfNeeded({
          platform: runtime.platform,
          ownership: await evaluateCurrentDaemonOwner(),
          expectedServiceLabel: entry.label,
          action: 'uninstall',
        });
        await uninstallDaemonService({
          platform: runtime.platform,
          uid: runtime.uid ?? undefined,
          userHomeDir: discoveryTarget.userHomeDir,
          happierHomeDir: discoveryTarget.happierHomeDir,
          mode: entryMode,
          channel: entry.releaseChannel,
          targetMode: entry.targetMode,
          instanceId: entry.serverId,
          installedPath: entry.path,
          runCommands: true,
        });
      }

      if (flags.json) {
        printJson({ ok: true, platform: runtime.platform, removed: entries.length });
        return;
      }
      process.stdout.write(`Removed ${entries.length} background services.\n`);
      return;
    }

    const plan = planDaemonServiceUninstall({
      platform: runtime.platform,
      mode,
      channel: runtime.channel,
      targetMode: runtime.targetMode,
      instanceId: runtime.instanceId,
      uid: runtime.uid ?? undefined,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
    });

    if (flags.dryRun) {
      if (flags.json) {
        printJson({ ok: true, platform: runtime.platform, plan });
        return;
      }
      process.stdout.write(`[dry-run] would remove: ${plan.filesToRemove.join(', ')}\n`);
      for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      return;
    }

    await stopCurrentWindowsServiceOwnerIfNeeded({
      platform: runtime.platform,
      ownership: await evaluateCurrentDaemonOwner(),
      expectedServiceLabel: paths.label,
      action: 'uninstall',
    });
    await uninstallDaemonService({
      platform: runtime.platform,
      uid: runtime.uid ?? undefined,
      userHomeDir: runtime.userHomeDir,
      happierHomeDir: runtime.happierHomeDir,
      mode,
      channel: runtime.channel,
      targetMode: runtime.targetMode,
      instanceId: runtime.instanceId,
      runCommands: true,
    });

    if (flags.json) {
      printJson({ ok: true, platform: runtime.platform });
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
      const msg = `Background service is not installed (${paths.installedPath}). Run: happier service install`;
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

    const shouldKickstartCurrentDarwinService = runtime.platform === 'darwin'
      && ownership.kind !== 'none'
      && ownership.owner.serviceManaged === true
      && ownership.owner.state.serviceLabel === paths.label;

    // Auto-refresh drifted plist: an installed plist written by an older CLI
    // may not reflect current defaults (e.g. missing the `--takeover` arg).
    // launchctl bootout → bootstrap re-reads whatever's on disk, so if we
    // don't rewrite the file before the lifecycle commands, the daemon will
    // spawn with stale args. Only triggered for start/restart; stop doesn't
    // care about content drift.
    if (action === 'start' || action === 'restart') {
      try {
        const expectedPlan = planDaemonServiceInstall({
          platform: runtime.platform,
          mode,
          systemUser: mode === 'system' ? systemUser : undefined,
          channel: runtime.channel,
          targetMode: runtime.targetMode,
          instanceId: runtime.instanceId,
          uid: runtime.uid ?? undefined,
          userHomeDir: runtime.userHomeDir,
          happierHomeDir: runtime.happierHomeDir,
          serverUrl: runtime.serverUrl,
          webappUrl: runtime.webappUrl,
          publicServerUrl: runtime.publicServerUrl,
          nodePath: runtime.nodePath,
          entryPath: runtime.entryPath,
        });
        const expectedFile = expectedPlan.files[0];
        if (expectedFile) {
          const matches = doesInstalledDaemonServiceDefinitionMatchExpected({
            installedPath: paths.installedPath,
            expectedContents: expectedFile.content,
          });
          if (!matches) {
            process.stderr.write('Refreshing background service definition (drifted from current template).\n');
            await applyDaemonServiceInstallPlan(expectedPlan, { runCommands: false });
          }
        }
      } catch (err) {
        // Drift-refresh is best-effort; never block the lifecycle command on it.
        process.stderr.write(`Drift check skipped: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

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

    if (action === 'start' || action === 'restart') {
      const lifecycleOwnership = evaluateDaemonServiceLifecycleOwnership({
        ownership,
        expectedServiceLabel: paths.label,
      });
      const takeoverDecision = resolveDaemonServiceTakeoverDecision({
        lifecycleOwnership,
        takeoverRequested: flags.takeover,
      });
      const takeoverNotice = takeoverDecision.kind === 'manual-owner-takeover'
        ? buildDaemonServiceTakeoverNotice({ action })
        : null;
      if (takeoverDecision.kind === 'conflict') {
        const message = renderDaemonServiceLifecycleOwnershipConflict({
          action,
          conflict: takeoverDecision.conflict,
        });
        const lines = takeoverDecision.conflict.kind === 'manual-owner-conflict'
          ? [...message.lines, buildDaemonServiceTakeoverHint({ commandPath: 'happier service', action })]
          : [...message.lines];
        if (flags.json) {
          printJson({
            ok: false,
            error: 'owner_conflict',
            message: `${message.title} ${lines.join(' ')}`.trim(),
            platform: runtime.platform,
          });
          return;
        }
        process.stderr.write(`${message.title}\n`);
        for (const line of lines) {
          process.stderr.write(`  ${line}\n`);
        }
        return;
      }
      const warningText = [takeoverNotice ? `${takeoverNotice.title} ${takeoverNotice.lines.join(' ')}`.trim() : undefined, stopOwnershipNote
        ? `${stopOwnershipNote.title} ${stopOwnershipNote.lines.join(' ')}`.trim()
        : undefined].filter(Boolean).join(' ') || undefined;

      if (flags.dryRun) {
        if (flags.json) {
          printJson({
            ok: true,
            platform: runtime.platform,
            plan,
            warning: warningText,
          });
          return;
        }
        for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
        if (takeoverNotice) {
          process.stdout.write(`${takeoverNotice.title}\n`);
          for (const line of takeoverNotice.lines) {
            process.stdout.write(`  ${line}\n`);
          }
        }
        if (stopOwnershipNote) {
          process.stdout.write(`${stopOwnershipNote.title}\n`);
          for (const line of stopOwnershipNote.lines) {
            process.stdout.write(`  ${line}\n`);
          }
        }
        return;
      }

      await withManualRelayTakeoverRecovery({
        shouldTakeOverManualOwner: takeoverDecision.kind === 'manual-owner-takeover',
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
            healthCommand: resolveDaemonServiceOwnershipHealthCommand({
              runtime,
              mode,
            }),
            windowsLaunchDiagnostics: runtime.platform === 'win32'
              ? {
                  taskName: resolveWindowsDaemonTaskName({
                    instanceId: runtime.instanceId,
                    channel: runtime.channel,
                    targetMode: runtime.targetMode,
                  }),
                  ...resolveWindowsDaemonServiceLogPaths({
                    happierHomeDir: runtime.happierHomeDir,
                    instanceId: runtime.instanceId,
                    channel: runtime.channel,
                    targetMode: runtime.targetMode,
                  }),
                }
              : null,
          });
        },
      });

      if (flags.json) {
        printJson({
          ok: true,
          platform: runtime.platform,
          warning: warningText,
        });
        return;
      }
      // By this point the ownership wait has succeeded (see
      // assertExpectedDaemonServiceOwnership above) — the service IS the
      // active daemon. Use past-tense so users see the real outcome, not a
      // vague "requested" that implies async completion.
      const pastTense = action === 'start' ? 'started' : action === 'restart' ? 'restarted' : `${action}ed`;
      process.stdout.write(`✓ Background service ${pastTense}.\n`);
      if (takeoverNotice) {
        process.stdout.write(`${takeoverNotice.title}\n`);
        for (const line of takeoverNotice.lines) {
          process.stdout.write(`  ${line}\n`);
        }
      }
      if (stopOwnershipNote) {
        process.stdout.write(`${stopOwnershipNote.title}\n`);
        for (const line of stopOwnershipNote.lines) {
          process.stdout.write(`  ${line}\n`);
        }
      }
      return;
    }

    if (flags.dryRun) {
      if (flags.json) {
        printJson({
          ok: true,
          platform: runtime.platform,
          plan,
          warning: stopOwnershipNote
            ? `${stopOwnershipNote.title} ${stopOwnershipNote.lines.join(' ')}`.trim()
            : undefined,
        });
        return;
      }
      for (const c of plan.commands) process.stdout.write(`[dry-run] would run: ${c.cmd} ${c.args.join(' ')}\n`);
      if (stopOwnershipNote) {
        process.stdout.write(`${stopOwnershipNote.title}\n`);
        for (const line of stopOwnershipNote.lines) {
          process.stdout.write(`  ${line}\n`);
        }
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
          ? `${stopOwnershipNote.title} ${stopOwnershipNote.lines.join(' ')}`.trim()
          : undefined,
      });
      return;
    }
    // `stop` runs bootout (which deregisters the service synchronously at
    // launchctl-api level even though the process teardown is async). Past
    // tense reflects what the user can observe via `launchctl list`.
    const pastTense = action === 'stop' ? 'stopped' : action === 'start' ? 'started' : action === 'restart' ? 'restarted' : `${action}ed`;
    process.stdout.write(`✓ Background service ${pastTense}.\n`);
    if (stopOwnershipNote) {
      process.stdout.write(`${stopOwnershipNote.title}\n`);
      for (const line of stopOwnershipNote.lines) {
        process.stdout.write(`  ${line}\n`);
      }
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
      serviceManaged: resolveDaemonStartupSourceServiceManagedState(state.startupSource, state.serviceLabel),
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
        installed,
        installedPath: paths.installedPath,
        services: mapDaemonServiceListEntriesToInventory(services, {
          activeServiceLabel: ownership.kind !== 'none' && ownership.owner.serviceManaged === true
            ? ownership.owner.state.serviceLabel
            : null,
          activeOwnerCliVersion: ownership.kind !== 'none' && ownership.owner.serviceManaged === true
            ? ownership.owner.state.startedWithCliVersion
            : null,
        }),
        daemon: pid ? { pid, running: pidAlive, startedAt: state?.startedAt ?? null } : { pid: null, running: false, startedAt: null },
        owner,
        system: { ok: systemStatus.ok, output: systemStatus.out },
      });
      return;
    }

    process.stdout.write(installed ? 'Background service: installed\n' : 'Background service: not installed\n');
    process.stdout.write(pidAlive ? `Daemon: running (pid ${pid})\n` : 'Daemon: not running\n');
    const inventory = renderDaemonServiceInventory(services);
    process.stdout.write(`${inventory.title}\n`);
    for (const line of inventory.lines) {
      process.stdout.write(`${line}\n`);
    }
    if (owner) {
      process.stdout.write(`Started by: ${describeCurrentRelayOwner(owner.serviceManaged)}\n`);
      if (owner.serviceLabel) {
        process.stdout.write(`Background service label: ${owner.serviceLabel}\n`);
      }
      if (owner.startedWithPublicReleaseChannel || owner.startedWithCliVersion) {
        process.stdout.write(`Running CLI: ${owner.startedWithPublicReleaseChannel ?? 'unknown'} • ${owner.startedWithCliVersion ?? 'unknown'}\n`);
      }
      if (owner.currentInvocationMatches === false) {
        process.stdout.write(owner.serviceManaged === true
          ? 'Warning: Current CLI differs from the running daemon. Use `happier doctor repair` if you want automatic startup to switch to this installation.\n'
          : owner.serviceManaged === false
            ? 'Warning: Current CLI differs from the running daemon. Use `happier daemon restart` if you want the manually started daemon to switch to this installation.\n'
            : 'Warning: Current CLI differs from the running daemon. Restart the current daemon before trying to switch this installation.\n');
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
      process.stderr.write('tail is not supported on Windows yet. Use: happier service logs\n');
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

  const msg = `Unknown background service subcommand: ${action}`;
  if (flags.json) printJson({ ok: false, error: 'invalid_subcommand', message: msg });
  else process.stderr.write(`${msg}\n`);
}
