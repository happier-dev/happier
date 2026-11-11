import { existsSync } from 'node:fs';

import {
  readDesktopInstallations,
  forgetDesktopInstallation,
  checkpointDesktopInstallationServiceCleanup,
  isDesktopServiceLauncherInventory,
  desktopInstallationsShareInstallHome,
  uninstallDesktopOwnedCli,
  PUBLIC_RELEASE_RING_IDS,
  type DesktopInstallationContext,
} from '@happier-dev/cli-common/firstPartyRuntime';

import { resolveInstalledLocalFirstPartyCommand } from './localFirstPartyCommand.js';
import { parseFirstJsonObject, runCommandCapture } from './taskRuntime.js';

/** The helper outlives the CLI child, so Windows can release and then delete its executable. */
export async function uninstallDesktopComponents(context: DesktopInstallationContext): Promise<void> {
  const targets = (await readDesktopInstallations(context)).map((installation) => {
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HAPPIER_HOME_DIR: installation.happyHomeDir,
      HAPPIER_FIRST_PARTY_INSTALL_HOME: installation.firstPartyInstallHome,
    };
    const installed = PUBLIC_RELEASE_RING_IDS.map((releaseRing) => resolveInstalledLocalFirstPartyCommand({
      componentId: 'happier-cli', releaseRing, processEnv,
    })).find((command) => command?.provenance === 'managed');
    const command = installation.cliPath && existsSync(installation.cliPath) ? installation.cliPath : installed?.command;
    if (!command && installation.serviceCleanupLaunchers === undefined) {
      throw new Error(`No installed Happier CLI can inspect background services for ${installation.happyHomeDir}. Repair the CLI before retrying cleanup.`);
    }
    return { installation, processEnv, command, launchers: installation.serviceCleanupLaunchers ?? [] };
  });
  // One install home can serve several Happier homes. Finish every service teardown while all
  // executors still exist, then audit again so removed services cannot pin the shared CLI.
  for (const target of targets) {
    if (!target.command) continue;
    // Older CLIs may ignore unknown options. Require the advertised selector before any mutation.
    const help = await runCommandCapture({ command: target.command, args: ['service', 'uninstall', '--help', '--json'], env: target.processEnv });
    const contract = parseFirstJsonObject(help.stdout);
    if (help.status !== 0 || !hasDesktopSelector(contract)) {
      throw new Error('The installed Happier CLI does not support Desktop ownership cleanup. Update it before retrying.');
    }
    await cleanupServices(context, target);
  }
  for (const target of targets) {
    if (target.command) target.launchers = await cleanupServices(context, target, true);
  }
  const cleanupTargets = targets.map((target) => ({ ...target,
    launchers: targets.filter((other) => desktopInstallationsShareInstallHome(other.installation, target.installation))
      .flatMap((other) => other.launchers),
  }));
  for (const target of cleanupTargets) {
    await checkpointDesktopInstallationServiceCleanup(context, target.installation, target.launchers);
  }
  for (const target of cleanupTargets) {
    await uninstallDesktopOwnedCli({ bundleId: context.bundleId, processEnv: target.processEnv, remainingServiceLaunchers: target.launchers });
    await forgetDesktopInstallation(context, target.installation);
  }
}

async function cleanupServices(
  context: DesktopInstallationContext,
  target: Readonly<{ command?: string; processEnv: NodeJS.ProcessEnv }>,
  dryRun = false,
): Promise<readonly (readonly string[])[]> {
  if (!target.command) throw new Error('Desktop service cleanup requires an installed CLI.');
  const result = await runCommandCapture({
    command: target.command,
    args: ['service', 'uninstall', '--all', '--desktop-bundle-id', context.bundleId, '--yes', ...(dryRun ? ['--dry-run'] : []), '--json'],
    env: target.processEnv,
    timeoutMs: 0,
  });
  const response = parseFirstJsonObject(result.stdout);
  if (result.status !== 0 || !response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'Desktop background service cleanup failed.');
  }
  if (!('remainingServiceLaunchers' in response) || !isDesktopServiceLauncherInventory(response.remainingServiceLaunchers)) {
    throw new Error('The installed CLI did not report surviving service dependencies. CLI files have been retained.');
  }
  return response.remainingServiceLaunchers;
}

function hasDesktopSelector(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('flags' in value) || !Array.isArray(value.flags)) return false;
  return value.flags.includes('--desktop-bundle-id');
}
