import { existsSync } from 'node:fs';

import spawn from 'cross-spawn';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';

import { findAllHappyProcesses, findWindowsHappyProcessAncestors, type HappyProcessInfo } from '@/daemon/doctor';

const TERMINATABLE_PROCESS_TYPES = new Set<string>([
  'daemon',
  'dev-daemon',
  'daemon-spawned-session',
  'dev-daemon-spawned',
  'daemon-version-check',
  'dev-daemon-version-check',
]);

/** Refuse before locks, downloads or launcher moves: stopping an ancestor can kill this updater. */
export async function assertWindowsCliUpdateIsOutsideManagedProcessTree(): Promise<void> {
  if (process.platform !== 'win32') return;
  let ancestors: HappyProcessInfo[];
  try {
    ancestors = await findWindowsHappyProcessAncestors();
  } catch (error) {
    throw new Error('Cannot verify Windows update process ancestry. Run the update from an independent terminal after resolving process inspection.', { cause: error });
  }
  if (ancestors.some((ancestor) => TERMINATABLE_PROCESS_TYPES.has(ancestor.type))) {
    throw new Error('Cannot update Happier from inside a Happier daemon or daemon-started session on Windows. Save your work and run the update from an independent terminal outside Happier.');
  }
}

const DEFAULT_PAYLOAD_OWNER_STOP_TIMEOUT_MS = 30_000;

function normalizeProcessCommand(value: string): string {
  return String(value ?? '').trim().replaceAll('\\', '/').toLowerCase();
}

function readPositiveIntFromEnv(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  name: string;
}>): number | null {
  const raw = typeof params.processEnv[params.name] === 'string'
    ? params.processEnv[params.name]!.trim()
    : '';
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

/**
 * The budget for one command the update runs against an installed or staged payload (the
 * installer's pre-install command timeout): stopping the payload's owners here, and the update
 * transaction's `--version` smoke of the staged executable.
 */
export function resolvePayloadOwnerStopTimeoutMs(processEnv: NodeJS.ProcessEnv): number {
  return readPositiveIntFromEnv({
    processEnv,
    name: 'HAPPIER_CLI_PAYLOAD_OWNER_STOP_TIMEOUT_MS',
  })
    ?? readPositiveIntFromEnv({
      processEnv,
      name: 'HAPPIER_INSTALLER_PRE_INSTALL_COMMAND_TIMEOUT_MS',
    })
    ?? DEFAULT_PAYLOAD_OWNER_STOP_TIMEOUT_MS;
}

function shouldSkipInstalledCliStopCommands(processEnv: NodeJS.ProcessEnv): boolean {
  return processEnv.HAPPIER_CLI_SKIP_PAYLOAD_OWNER_STOP_COMMANDS === '1';
}

function resolveManagedCliInvoker(paths: Readonly<{
  binaryPath: string;
  resolvedBinaryPath: string | null;
  shimPaths: readonly string[];
}>): string | null {
  // Probe the JUNCTION-FREE resolved binary first — on Windows, `existsSync`
  // through `<installRoot>/current` can return false even when the file
  // exists at the junction's target. The shimPaths sit at `<home>/bin/*.exe`
  // and don't go through the junction, so they probe reliably either way.
  const candidates = [
    ...paths.shimPaths,
    paths.resolvedBinaryPath,
    paths.binaryPath,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isManagedPayloadOwnerProcess(params: Readonly<{
  processInfo: HappyProcessInfo;
  matchNeedles: readonly string[];
}>): boolean {
  if (!TERMINATABLE_PROCESS_TYPES.has(params.processInfo.type)) {
    return false;
  }
  const normalizedCommand = normalizeProcessCommand(params.processInfo.command);
  return params.matchNeedles.some((needle) => normalizedCommand.includes(needle));
}

export async function quiesceInstalledCliWindowsPayloadOwners(params: Readonly<{
  channel: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }

  const processEnv = params.processEnv ?? process.env;
  const installedPaths = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel: params.channel,
    processEnv,
  });
  const invoker = resolveManagedCliInvoker(installedPaths);
  const stopTimeoutMs = resolvePayloadOwnerStopTimeoutMs(processEnv);

  if (invoker && !shouldSkipInstalledCliStopCommands(processEnv)) {
    for (const args of [
      ['service', 'stop', '--json'],
      ['daemon', 'stop', '--all', '--kill-sessions', '--json'],
    ] as const) {
      spawn.sync(invoker, [...args], {
        env: processEnv,
        stdio: 'ignore',
        timeout: stopTimeoutMs,
        windowsHide: true,
      });
    }
  }

  // Match against BOTH the junction path and the resolved versioned path
  // because the running process's command-line may contain either one,
  // depending on which path the runtime walked to launch the daemon. Without
  // the resolved variants we'd silently miss processes launched via the
  // version-resolved entrypoint and skip them in the kill loop.
  const matchNeedles = [
    installedPaths.installRoot,
    installedPaths.currentPath,
    installedPaths.binaryPath,
    installedPaths.resolvedCurrentPath,
    installedPaths.resolvedBinaryPath,
    ...installedPaths.shimPaths,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeProcessCommand(value));

  const matchingProcesses = (await findAllHappyProcesses())
    .filter((processInfo) => processInfo.pid !== process.pid)
    .filter((processInfo) => isManagedPayloadOwnerProcess({
      processInfo,
      matchNeedles,
    }));

  for (const processInfo of matchingProcesses) {
    spawn.sync('taskkill', ['/F', '/T', '/PID', String(processInfo.pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }

  const remainingProcesses = (await findAllHappyProcesses())
    .filter((processInfo) => processInfo.pid !== process.pid)
    .filter((processInfo) => isManagedPayloadOwnerProcess({
      processInfo,
      matchNeedles,
    }));
  if (remainingProcesses.length > 0) {
    throw new Error(
      `Failed to stop running Happier runtime processes before payload promotion: ${remainingProcesses
        .map((processInfo) => `${processInfo.pid}:${processInfo.type}`)
        .join(', ')}`,
    );
  }
}
