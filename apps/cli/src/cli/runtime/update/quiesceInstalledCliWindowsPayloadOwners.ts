import { existsSync } from 'node:fs';

import spawn from 'cross-spawn';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';

import { findAllHappyProcesses, type HappyProcessInfo } from '@/daemon/doctor';
import {
  normalizeProcessCommandPathValue,
  processCommandContainsPathFragment,
} from '@/subprocess/processCommandPathMatch';

const TERMINATABLE_PROCESS_TYPES = new Set([
  'daemon',
  'dev-daemon',
  'daemon-version-check',
  'dev-daemon-version-check',
] as const);

const DEFAULT_PAYLOAD_OWNER_STOP_TIMEOUT_MS = 30_000;

function readPositiveIntFromEnv(value: string | undefined, fallback: number): number {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolvePayloadOwnerStopTimeoutMs(processEnv: NodeJS.ProcessEnv): number {
  return readPositiveIntFromEnv(
    processEnv.HAPPIER_INSTALLER_PRE_INSTALL_COMMAND_TIMEOUT_MS,
    DEFAULT_PAYLOAD_OWNER_STOP_TIMEOUT_MS,
  );
}

function shouldSkipInstalledCliStopCommands(processEnv: NodeJS.ProcessEnv): boolean {
  const raw = String(processEnv.HAPPIER_CLI_SKIP_PAYLOAD_OWNER_STOP_COMMANDS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
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
  if (!TERMINATABLE_PROCESS_TYPES.has(params.processInfo.type as (typeof TERMINATABLE_PROCESS_TYPES extends Set<infer T> ? T : never))) {
    return false;
  }
  const normalizedCommand = normalizeProcessCommandPathValue(params.processInfo.command);
  return params.matchNeedles.some((needle) => processCommandContainsPathFragment(normalizedCommand, needle));
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
      ['service', 'stop', '--transfer-managed-local-services', '--json'],
      ['daemon', 'stop', '--all', '--transfer-managed-local-services', '--json'],
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
    .map((value) => normalizeProcessCommandPathValue(value));

  const matchingProcesses = (await findAllHappyProcesses())
    .filter((processInfo) => processInfo.pid !== process.pid)
    .filter((processInfo) => isManagedPayloadOwnerProcess({
      processInfo,
      matchNeedles,
    }));

  for (const processInfo of matchingProcesses) {
    // Do not use `/T`: the daemon's Agent/session-runner and managed-runtime
    // descendants must survive for the new CLI payload to adopt them.
    spawn.sync('taskkill', ['/F', '/PID', String(processInfo.pid)], {
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
