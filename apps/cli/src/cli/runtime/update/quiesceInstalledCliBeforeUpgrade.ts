import { existsSync } from 'node:fs';
import spawn from 'cross-spawn';
import chalk from 'chalk';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';

import { resolvePayloadOwnerStopTimeoutMs } from './quiesceInstalledCliWindowsPayloadOwners';

function shouldSkipInstalledCliStopCommands(processEnv: NodeJS.ProcessEnv): boolean {
  return processEnv.HAPPIER_CLI_SKIP_PAYLOAD_OWNER_STOP_COMMANDS === '1';
}

function resolveManagedCliInvoker(paths: Readonly<{
  binaryPath: string;
  resolvedBinaryPath: string | null;
  shimPaths: readonly string[];
}>): string | null {
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

/**
 * Stop the running Happier daemon and services before replacing the CLI binary
 * during an upgrade on non-Windows platforms.
 *
 * On Windows, `quiesceInstalledCliWindowsPayloadOwners` handles this with process killing.
 * On Linux/macOS, we gracefully stop the daemon and let the service/autostart mechanism
 * restart it after the upgrade completes.
 *
 * This prevents "text file busy" errors and stale daemon processes running old code.
 */
export async function quiesceInstalledCliBeforeUpgrade(params: Readonly<{
  channel: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<void> {
  if (process.platform === 'win32') {
    // Windows path uses quiesceInstalledCliWindowsPayloadOwners instead
    return;
  }

  const processEnv = params.processEnv ?? process.env;
  const installedPaths = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel: params.channel,
    processEnv,
  });

  const invoker = resolveManagedCliInvoker(installedPaths);
  if (!invoker || shouldSkipInstalledCliStopCommands(processEnv)) {
    return;
  }

  const stopTimeoutMs = resolvePayloadOwnerStopTimeoutMs(processEnv);

  // Stop the daemon gracefully. The service/autostart mechanism will restart it
  // after the upgrade completes if it was configured.
  const result = spawn.sync(
    invoker,
    ['daemon', 'stop', '--all', '--kill-sessions', '--json'],
    {
      env: processEnv,
      stdio: 'pipe',
      timeout: stopTimeoutMs,
      encoding: 'utf-8',
    },
  );

  // Best-effort: if daemon stop fails or times out, we continue anyway.
  // The binary replacement may fail with "text file busy", in which case
  // the installer will report that error.
  if (result.status !== 0 && result.status !== null) {
    // Non-zero exit means daemon was running but stop failed
    console.error(chalk.yellow(`Note: Could not stop the daemon before upgrade (exit ${result.status}). The upgrade will continue.`));
  }
}
