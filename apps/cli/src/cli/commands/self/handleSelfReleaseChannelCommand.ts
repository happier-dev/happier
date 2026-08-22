import { existsSync } from 'node:fs';

import {
  resolveDesiredShimTargets,
  resolveInstalledFirstPartyComponentPaths,
  syncInstalledFirstPartyShims,
  writeDefaultManagedReleaseChannel,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  deriveManagedReleaseChannelInventory,
  discoverHappierInstallations,
  type HappierInstallationInventory,
  type ManagedReleaseChannelInventory,
} from '@happier-dev/cli-common/happierRuntime';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import {
  resolveDaemonServiceCliRuntimeFromEnv,
  resolveDaemonServiceListEntries,
} from '@/daemon/service/cli';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';

import {
  resolveInstalledDefaultFollowingDaemonServiceModes,
  runDefaultFollowingBackgroundServiceRestartFollowUp,
} from '../backgroundServiceFollowUp.js';
import { isInteractiveTerminal, promptInput, runCliAction } from '../server/commandUtilities';
import { areManagedShimAndBinaryAligned } from './areManagedShimAndBinaryAligned.js';

function resolveReleaseChannelArg(argv: readonly string[]): PublicReleaseRingId {
  const candidate = normalizePublicReleaseRingId(argv[0] ?? '');
  if (!candidate) {
    throw new Error('Expected release channel: stable|preview|dev');
  }
  return candidate;
}

async function readManagedReleaseChannelStatus(): Promise<Readonly<{
  inventory: HappierInstallationInventory;
  managed: ManagedReleaseChannelInventory;
  happierShimMatchesDefaultReleaseChannel: boolean;
}>> {
  const inventory = await discoverHappierInstallations({ processEnv: process.env });
  const managed = await deriveManagedReleaseChannelInventory({
    inventory,
    processEnv: process.env,
  });
  const defaultEntry = managed.managedReleaseChannels.find((entry) => entry.isDefault) ?? null;
  const happierShimMatchesDefaultReleaseChannel = await (async () => {
    if (!defaultEntry) return false;
    const desiredTargets = await resolveDesiredShimTargets({
      componentId: 'happier-cli',
      channel: defaultEntry.releaseChannel,
      processEnv: process.env,
    });
    const defaultShimTarget = desiredTargets.find((target) => target.shimPath === resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      channel: 'stable',
      processEnv: process.env,
    }).shimPaths[0]);
    if (!defaultShimTarget) {
      return false;
    }
    if (!existsSync(defaultShimTarget.shimPath) || !existsSync(defaultShimTarget.binaryPath)) {
      return false;
    }
    return areManagedShimAndBinaryAligned({
      shimPath: defaultShimTarget.shimPath,
      binaryPath: defaultShimTarget.binaryPath,
      platform: process.platform,
    });
  })();
  return {
    inventory,
    managed,
    happierShimMatchesDefaultReleaseChannel,
  };
}

function normalizeReleaseChannelLabel(releaseChannel: PublicReleaseRingId): 'stable' | 'preview' | 'dev' {
  return releaseChannel === 'publicdev' ? 'dev' : releaseChannel;
}

async function cmdReleaseChannelStatus(argv: readonly string[]): Promise<void> {
  const json = argv.includes('--json');
  const status = await readManagedReleaseChannelStatus();
  const data = {
    defaultReleaseChannel: normalizeReleaseChannelLabel(status.managed.defaultReleaseChannel),
    happierShimMatchesDefaultReleaseChannel: status.happierShimMatchesDefaultReleaseChannel,
    managedReleaseChannels: status.managed.managedReleaseChannels.map((entry) => ({
      ...entry,
      releaseChannel: normalizeReleaseChannelLabel(entry.releaseChannel),
    })),
    activeInvocation: status.inventory.activeInvocation,
  };

  if (json) {
    await writeJsonStdout(data);
    return;
  }

  console.log(`Default release channel: ${data.defaultReleaseChannel}`);
  console.log(`happier shim aligned: ${status.happierShimMatchesDefaultReleaseChannel ? 'yes' : 'no'}`);
}

async function cmdReleaseChannelList(argv: readonly string[]): Promise<void> {
  const json = argv.includes('--json');
  const status = await readManagedReleaseChannelStatus();
  const managedInstallationIds = new Set(status.managed.managedReleaseChannels.map((entry) => entry.installationId));
  const otherInstallations = status.inventory.installations.filter((installation) => !managedInstallationIds.has(installation.id));

  const data = {
    defaultReleaseChannel: normalizeReleaseChannelLabel(status.managed.defaultReleaseChannel),
    managedReleaseChannels: status.managed.managedReleaseChannels.map((entry) => ({
      ...entry,
      releaseChannel: normalizeReleaseChannelLabel(entry.releaseChannel),
    })),
    otherInstallations,
  };

  if (json) {
    await writeJsonStdout(data);
    return;
  }

  console.log('Managed release channels');
  for (const entry of data.managedReleaseChannels) {
    const markers = [
      entry.isDefault ? 'default' : null,
      entry.onPath ? 'on PATH' : null,
    ].filter(Boolean).join(', ');
    console.log(`- ${entry.label}${markers ? ` (${markers})` : ''}`);
    if (entry.version) {
      console.log(`  version: ${entry.version}`);
    }
    console.log(`  path: ${entry.installationPath}`);
  }

  if (otherInstallations.length > 0) {
    console.log('Other Happier installs');
    for (const installation of otherInstallations) {
      const source = installation.source === 'npmGlobal'
        ? 'npm global'
        : installation.source === 'fromSource'
          ? 'from source'
          : installation.source === 'pathBinary'
            ? 'PATH binary'
            : installation.source;
      console.log(`- ${source}`);
      console.log(`  path: ${installation.path}`);
    }
  }
}

async function cmdReleaseChannelUse(argv: readonly string[]): Promise<void> {
  const releaseChannel = resolveReleaseChannelArg(argv);
  const installPaths = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel: releaseChannel,
    processEnv: process.env,
  });
  if (!existsSync(installPaths.binaryPath)) {
    const label = releaseChannel === 'publicdev' ? 'dev' : releaseChannel;
    throw new Error(`Cannot set default release channel to ${label}: managed CLI install is missing`);
  }

  await writeDefaultManagedReleaseChannel({
    processEnv: process.env,
    releaseChannel,
  });
  await syncInstalledFirstPartyShims({
    componentId: 'happier-cli',
    channel: releaseChannel,
    processEnv: process.env,
  });

  console.log(`Default release channel set to ${releaseChannel === 'publicdev' ? 'dev' : releaseChannel}.`);

  const platform = process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
    ? process.platform
    : null;
  if (!platform) {
    return;
  }

  const runtimeModes = platform === 'linux'
    ? ['user', 'system'] as const
    : ['user'] as const;
  const installedDefaultFollowingServiceModes = resolveInstalledDefaultFollowingDaemonServiceModes(
    (await Promise.all(runtimeModes.map(async (mode) => {
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ mode });
      return await resolveDaemonServiceListEntries(runtime, { mode });
    }))).flat(),
  );
  if (installedDefaultFollowingServiceModes.length === 0) {
    return;
  }

  await runDefaultFollowingBackgroundServiceRestartFollowUp({
    interactive: isInteractiveTerminal(),
    promptInput,
    runCliAction,
    subject: `${normalizeReleaseChannelLabel(releaseChannel)} release-channel`,
    modes: installedDefaultFollowingServiceModes,
    log: console.log,
  });
}

export async function handleSelfReleaseChannelCommand(argv: readonly string[]): Promise<void> {
  const releaseChannelSubcommand = argv[0] ?? 'status';
  if (releaseChannelSubcommand === 'status') {
    await cmdReleaseChannelStatus(argv.slice(1));
    return;
  }
  if (releaseChannelSubcommand === 'list') {
    await cmdReleaseChannelList(argv.slice(1));
    return;
  }
  if (releaseChannelSubcommand === 'use') {
    await cmdReleaseChannelUse(argv.slice(1));
    return;
  }
  throw new Error(`Unknown self release-channel subcommand: ${releaseChannelSubcommand}`);
}
