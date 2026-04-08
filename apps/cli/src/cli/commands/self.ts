import chalk from 'chalk';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import packageJson from '../../../package.json';
import { configuration } from '@/configuration';
import type { CommandContext } from '@/cli/commandRegistry';
import {
  FIRST_PARTY_COMPONENT_IDS,
  installVersionedPayload,
  readDefaultManagedReleaseChannel,
  resolveDesiredShimTargets,
  resolveFirstPartyComponentPublicReleaseVariant,
  resolveInstalledFirstPartyComponentPaths,
  syncInstalledFirstPartyShims,
  writeDefaultManagedReleaseChannel,
} from '@happier-dev/cli-common/firstPartyRuntime';
import type { FirstPartyComponentId } from '@happier-dev/cli-common/firstPartyRuntime';
import {
  deriveManagedReleaseChannelInventory,
  discoverHappierServices,
  discoverHappierInstallations,
  type HappierInstallationInventory,
  type ManagedReleaseChannelInventory,
} from '@happier-dev/cli-common/happierRuntime';
import {
  compareVersions,
  readNpmDistTagVersion,
  readUpdateCache,
  resolveNpmPackageNameOverride,
  writeUpdateCache,
} from '@happier-dev/cli-common/update';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';
import {
  normalizePublicReleaseRingId,
  resolveCliInvokerNameForPublicRing,
  resolvePublicReleaseRingLabelForId,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';
import { resolvePublicReleaseRingIdFromCliArgs } from '@/cli/runtime/publicReleaseChannel';
import {
  resolveCliBinaryAssetBundleFromReleaseAssets,
  updateInstalledCliPayloadFromReleaseAssets,
} from '@/cli/runtime/update/binarySelfUpdate';
import { isInteractiveTerminal, promptInput, runCliAction } from './server/commandUtilities';
import {
  hasInstalledDefaultFollowingDaemonService,
  runDefaultFollowingBackgroundServiceRestartFollowUp,
} from './backgroundServiceFollowUp';
import { maybeRunVersionGatedRuntimeMigration } from './self/maybeRunVersionGatedRuntimeMigration';

type SelfChannel = PublicReleaseRingId;

function usage(): string {
  return [
    `${chalk.bold('happier self')} - Self update + update checks`,
    '',
    `${chalk.bold('Usage:')}`,
    `  happier self check [--preview|--dev|--channel=<preview|dev>] [--quiet]`,
    `  happier self update [--preview|--dev|--channel=<preview|dev>] [--to <versionOrTag>]`,
    `  happier self release-channel status [--json]`,
    `  happier self release-channel list [--json]`,
    `  happier self release-channel use <stable|preview|dev>`,
    `  happier self migrate [--yes] [--json]`,
    `  happier self-update [--check] [--preview|--dev|--channel=<preview|dev>] [--to <versionOrTag>]`,
    '',
    `${chalk.bold('Channels:')}`,
    `  stable  → npm dist-tag ${chalk.cyan('latest')}`,
    `  preview → npm dist-tag ${chalk.cyan('next')}`,
    `  dev     → npm dist-tag ${chalk.cyan('next')} (${chalk.gray('dev rolling binaries')})`,
    '',
    `${chalk.bold('Environment:')}`,
    `  HAPPIER_CLI_UPDATE_CHECK=0                 Disable update notice + background check`,
    `  HAPPIER_CLI_UPDATE_PACKAGE_NAME=@scope/pkg Override the npm package name checked/installed`,
    `  HAPPIER_GITHUB_REPO=happier-dev/happier    Override GitHub repo for binary updates`,
    `  HAPPIER_GITHUB_TOKEN=...                   GitHub token for release API (optional)`,
    '',
  ].join('\n');
}

function isSafeNpmNameSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function isSafeUpdateTarget(value: string): boolean {
  // Accept npm dist-tags and exact semver-like versions only.
  return /^(?:latest|next|[A-Za-z0-9][A-Za-z0-9._-]*|v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.test(value);
}

export function packageJsonPathForNodeModules({ rootDir, packageName }: { rootDir: string; packageName: string }): string | null {
  const name = String(packageName ?? '').trim();
  if (!name) return null;
  const parts = name.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return null;

  if (name.startsWith('@')) {
    if (parts.length !== 2) return null;
    const [scope, pkg] = parts;
    if (!scope?.startsWith('@')) return null;
    if (!isSafeNpmNameSegment(scope.slice(1))) return null;
    if (!isSafeNpmNameSegment(pkg ?? '')) return null;
  } else {
    if (parts.length !== 1) return null;
    if (!isSafeNpmNameSegment(parts[0] ?? '')) return null;
  }

  return join(rootDir, 'node_modules', ...parts, 'package.json');
}

function readPackageJsonVersion(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    const v = String(parsed?.version ?? '').trim();
    return v || null;
  } catch {
    return null;
  }
}

function resolveSelfNpmDistTag(channel: SelfChannel): 'latest' | 'next' {
  return channel === 'stable' ? 'latest' : 'next';
}

export function parseSelfChannel(args: string[], invokedPath = process.argv[1] ?? ''): SelfChannel {
  return resolvePublicReleaseRingIdFromCliArgs({ args, invokedPath });
}

export function computeSelfUpdateSpec(params: Readonly<{ packageName: string; channel: SelfChannel; to: string }>): string {
  const pkg = String(params.packageName ?? '').trim();
  const to = String(params.to ?? '').trim();
  if (to) {
    if (!isSafeUpdateTarget(to)) {
      throw new Error(`Invalid --to value: ${to}`);
    }
    return `${pkg}@${to}`;
  }
  return `${pkg}@${resolveSelfNpmDistTag(params.channel)}`;
}

export function detectInstallSource(path: string): 'npm' | 'binary' {
  const raw = String(path ?? '').trim();
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.includes('/node_modules/')) return 'npm';
  return 'binary';
}

export function resolveSelfUpdateCommandForRing(ring: SelfChannel): string {
  return `${resolveCliInvokerNameForPublicRing(ring)} self update`;
}

function resolveBinaryUpdateRepo(env: NodeJS.ProcessEnv): string {
  const raw = String(env.HAPPIER_GITHUB_REPO ?? '').trim();
  return raw || 'happier-dev/happier';
}

function resolveBinaryUpdateToken(env: NodeJS.ProcessEnv): string {
  return String(env.HAPPIER_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? '').trim();
}

function resolveBinaryUpdatePlatform(env: NodeJS.ProcessEnv): Readonly<{ os: string; arch: string }> {
  const forcedOs = String(env.HAPPIER_SELF_UPDATE_OS ?? '').trim();
  const forcedArch = String(env.HAPPIER_SELF_UPDATE_ARCH ?? '').trim();
  if (forcedOs && forcedArch) return { os: forcedOs, arch: forcedArch };

  const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : 'unsupported';
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'unsupported';
  if (os === 'unsupported' || arch === 'unsupported') {
    throw new Error(`Unsupported platform for binary updates: ${process.platform}/${process.arch}`);
  }
  return { os, arch };
}

function resolveBinaryUpdateTag(channel: SelfChannel): string {
  return resolveFirstPartyComponentPublicReleaseVariant({
    componentId: 'happier-cli',
    channel,
  }).releaseTag;
}

function npmUpgradeCommand(params: Readonly<{ packageName: string; channel: SelfChannel; to: string }>): string {
  const pkg = String(params.packageName ?? '').trim();
  const to = String(params.to ?? '').trim();
  if (to) return `npm install -g ${pkg}@${to}`;
  return `npm install -g ${pkg}@${resolveSelfNpmDistTag(params.channel)}`;
}

function updateCachePath(channel: SelfChannel): string {
  const suffix = resolvePublicReleaseRingLabelForId(channel);
  const fileName = suffix === 'stable' ? 'update.json' : `update.${suffix}.json`;
  return join(configuration.happyHomeDir, 'cache', fileName);
}

function runtimeDir(channel: SelfChannel): string {
  const suffix = resolvePublicReleaseRingLabelForId(channel);
  return suffix === 'stable'
    ? join(configuration.happyHomeDir, 'runtime')
    : join(configuration.happyHomeDir, `runtime.${suffix}`);
}

function resolveUpdatePackageName(): string {
  return resolveNpmPackageNameOverride({
    envValue: process.env.HAPPIER_CLI_UPDATE_PACKAGE_NAME,
    fallback: String(packageJson.name ?? '').trim(),
  });
}

async function cmdCheck(argv: string[]): Promise<void> {
  const channel = parseSelfChannel(argv);
  const quiet = argv.includes('--quiet');
  const installSource = detectInstallSource(process.argv[1] ?? '');

  if (installSource === 'binary') {
    const { os, arch } = resolveBinaryUpdatePlatform(process.env);
    const githubRepo = resolveBinaryUpdateRepo(process.env);
    const githubToken = resolveBinaryUpdateToken(process.env);
    const tag = resolveBinaryUpdateTag(channel);

    const release = await fetchGitHubReleaseByTag({ githubRepo, tag, githubToken, userAgent: 'happier-cli' });
    const assets = typeof release === 'object' && release != null && 'assets' in release ? (release as any).assets : null;
    const bundle = resolveCliBinaryAssetBundleFromReleaseAssets({ assets, os, arch, preferVersion: null });

    const latest = bundle.version;
    const invokerVersion = configuration.currentCliVersion;
    const current = invokerVersion || null;
    const updateAvailable = Boolean(current && latest && compareVersions(latest, current) > 0);

    const existing = readUpdateCache(updateCachePath(channel));
    const checkedAt = Date.now();
    writeUpdateCache(updateCachePath(channel), {
      checkedAt,
      latest,
      current,
      runtimeVersion: null,
      invokerVersion,
      updateAvailable,
      notifiedAt: existing?.notifiedAt ?? null,
    });

    if (quiet) return;

    if (updateAvailable) {
      console.log(chalk.yellow(`Update available: ${current ?? 'current'} → ${latest}`));
      console.log(chalk.gray('Run:'), chalk.cyan(resolveSelfUpdateCommandForRing(channel)));
      return;
    }
    console.log(chalk.green('Up to date.'));
    return;
  }
  const distTag = resolveSelfNpmDistTag(channel);
  const pkgName = resolveUpdatePackageName();

  const runtimePkgJson = packageJsonPathForNodeModules({ rootDir: runtimeDir(channel), packageName: pkgName });
  const runtimeVersion = runtimePkgJson ? readPackageJsonVersion(runtimePkgJson) : null;
  const invokerVersion = configuration.currentCliVersion;
  const current = runtimeVersion || invokerVersion || null;

  const latest = readNpmDistTagVersion({ packageName: pkgName, distTag, cwd: process.cwd(), env: process.env });
  const updateAvailable = Boolean(current && latest && compareVersions(latest, current) > 0);

  const existing = readUpdateCache(updateCachePath(channel));
  const checkedAt = Date.now();
  writeUpdateCache(updateCachePath(channel), {
    checkedAt,
    latest,
    current,
    runtimeVersion,
    invokerVersion,
    updateAvailable,
    notifiedAt: existing?.notifiedAt ?? null,
  });

  if (quiet) return;

  if (!latest) {
    console.log(chalk.gray('Unable to determine latest version (npm view failed).'));
    return;
  }
  if (updateAvailable) {
    console.log(chalk.yellow(`Update available: ${current ?? 'current'} → ${latest}`));
    console.log(chalk.gray('Run:'), chalk.cyan('happier self update'));
    return;
  }
  console.log(chalk.green('Up to date.'));
}

async function cmdUpdate(argv: string[]): Promise<void> {
  const channel = parseSelfChannel(argv);
  const toArg = (() => {
    const i = argv.indexOf('--to');
    if (i >= 0) return argv[i + 1] ?? '';
    const eq = argv.find((a) => a.startsWith('--to='));
    return eq ? eq.slice('--to='.length) : '';
  })();

  const installSource = detectInstallSource(process.argv[1] ?? '');
  if (installSource === 'npm') {
    const pkgName = resolveUpdatePackageName();
    const upgrade = npmUpgradeCommand({ packageName: pkgName, channel, to: toArg });
    console.log(chalk.yellow('Detected npm-based install; in-place runtime update is disabled.'));
    console.log(chalk.gray('Run instead:'), chalk.cyan(upgrade));
    return;
  }

  const effective = (() => {
    const raw = String(toArg ?? '').trim();
    if (raw === 'latest') return { channel: 'stable' as const, preferVersion: null };
    if (raw === 'next') return { channel: 'preview' as const, preferVersion: null };
    const v = raw.startsWith('v') ? raw.slice(1) : raw;
    return { channel, preferVersion: v || null };
  })();

  const { os, arch } = resolveBinaryUpdatePlatform(process.env);
  const githubRepo = resolveBinaryUpdateRepo(process.env);
  const githubToken = resolveBinaryUpdateToken(process.env);
  const tag = resolveBinaryUpdateTag(effective.channel);
  const minisignPubkeyFile = String(process.env.HAPPIER_MINISIGN_PUBKEY ?? '').trim() || undefined;
  const release = await fetchGitHubReleaseByTag({
    githubRepo,
    tag,
    githubToken,
    userAgent: 'happier-cli',
  });
  const assets = typeof release === 'object' && release != null && 'assets' in release ? (release as any).assets : null;
  resolveCliBinaryAssetBundleFromReleaseAssets({
    assets,
    os,
    arch,
    preferVersion: effective.preferVersion,
  });

  const result = await updateInstalledCliPayloadFromReleaseAssets({
    assets,
    os,
    arch,
    happyHomeDir: configuration.happyHomeDir,
    preferVersion: effective.preferVersion,
    minisignPubkeyFile,
    channel: effective.channel,
  });

  // Refresh cache best-effort.
  await cmdCheck([
    'check',
    '--quiet',
    ...(effective.channel === 'preview'
      ? ['--preview']
      : effective.channel === 'publicdev'
        ? ['--dev']
        : []),
  ]);
  console.log(chalk.green(`✓ Updated happier to ${result.updatedTo}`));
  await maybeRunVersionGatedRuntimeMigration({
    fromVersion: result.previousVersionId,
    toVersion: result.updatedTo,
    argv: ['repair'],
    commandPath: 'happier self migrate',
  });
}

function resolveInternalInstallPayloadArgValue(argv: string[], flagName: string): string {
  const positionalIndex = argv.indexOf(flagName);
  if (positionalIndex >= 0) {
    return String(argv[positionalIndex + 1] ?? '').trim();
  }
  const equalsArg = argv.find((arg) => arg.startsWith(`${flagName}=`));
  return String(equalsArg?.slice(flagName.length + 1) ?? '').trim();
}

function parseFirstPartyComponentId(value: string): FirstPartyComponentId {
  if ((FIRST_PARTY_COMPONENT_IDS as readonly string[]).includes(value)) {
    return value as FirstPartyComponentId;
  }
  throw new Error(`Unknown first-party component: ${value}`);
}

async function cmdInternalInstallPayload(argv: string[]): Promise<void> {
  const componentId = parseFirstPartyComponentId(resolveInternalInstallPayloadArgValue(argv, '--component'));
  const payloadRoot = resolveInternalInstallPayloadArgValue(argv, '--payload-root');
  const versionId = resolveInternalInstallPayloadArgValue(argv, '--version');
  const channel = normalizePublicReleaseRingId(resolveInternalInstallPayloadArgValue(argv, '--channel')) || parseSelfChannel(argv);

  if (!payloadRoot) {
    throw new Error('--payload-root is required');
  }
  if (!versionId) {
    throw new Error('--version is required');
  }

  const promotion = await installVersionedPayload({
    componentId,
    channel,
    payloadRoot,
    processEnv: process.env,
    versionId,
  });

  if (componentId === 'happier-cli') {
    await maybeRunVersionGatedRuntimeMigration({
      fromVersion: promotion.previousVersionId,
      toVersion: promotion.currentVersionId,
      argv: ['repair'],
      commandPath: 'happier self migrate',
    });
  }
}

function resolveReleaseChannelArg(argv: string[]): PublicReleaseRingId {
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
    try {
      return realpathSync(defaultShimTarget.shimPath) === realpathSync(defaultShimTarget.binaryPath);
    } catch {
      return false;
    }
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

async function cmdReleaseChannelStatus(argv: string[]): Promise<void> {
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
    console.log(JSON.stringify(data));
    return;
  }

  console.log(`Default release channel: ${data.defaultReleaseChannel}`);
  console.log(`happier shim aligned: ${status.happierShimMatchesDefaultReleaseChannel ? 'yes' : 'no'}`);
}

async function cmdReleaseChannelList(argv: string[]): Promise<void> {
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
    console.log(JSON.stringify(data));
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

async function cmdReleaseChannelUse(argv: string[]): Promise<void> {
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

  const serviceInventory = await discoverHappierServices({
    processEnv: process.env,
    platform,
  });
  if (!hasInstalledDefaultFollowingDaemonService(serviceInventory.services)) {
    return;
  }

  await runDefaultFollowingBackgroundServiceRestartFollowUp({
    interactive: isInteractiveTerminal(),
    promptInput,
    runCliAction,
    subject: `${normalizeReleaseChannelLabel(releaseChannel)} release-channel`,
    log: console.log,
  });
}

async function cmdMigrate(argv: string[]): Promise<void> {
  const forwardedArgv = ['repair', ...argv];
  const { handleServiceRepairCliCommand } = await import('./serviceRepair/handleServiceRepairCliCommand');
  await handleServiceRepairCliCommand({
    argv: forwardedArgv,
    commandPath: 'happier self migrate',
  });
}

export async function handleSelfCliCommand(context: CommandContext): Promise<void> {
  try {
    const argv = context.args.slice(1);
    const sub = argv[0] ?? 'help';
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      console.log(usage());
      process.exitCode = 0;
      return;
    }
    if (sub === 'check') {
      await cmdCheck(argv.slice(1));
      process.exitCode = 0;
      return;
    }
    if (sub === 'update') {
      await cmdUpdate(argv.slice(1));
      process.exitCode = 0;
      return;
    }
    if (sub === '__install-payload') {
      await cmdInternalInstallPayload(argv.slice(1));
      process.exitCode = 0;
      return;
    }
    if (sub === 'migrate') {
      await cmdMigrate(argv.slice(1));
      process.exitCode = 0;
      return;
    }
    if (sub === 'release-channel') {
      const releaseChannelSubcommand = argv[1] ?? 'status';
      if (releaseChannelSubcommand === 'status') {
        await cmdReleaseChannelStatus(argv.slice(2));
        process.exitCode = 0;
        return;
      }
      if (releaseChannelSubcommand === 'list') {
        await cmdReleaseChannelList(argv.slice(2));
        process.exitCode = 0;
        return;
      }
      if (releaseChannelSubcommand === 'use') {
        await cmdReleaseChannelUse(argv.slice(2));
        process.exitCode = 0;
        return;
      }
      console.error(chalk.red('Error:'), `Unknown self release-channel subcommand: ${releaseChannelSubcommand}`);
      console.log(usage());
      process.exit(1);
    }
    console.error(chalk.red('Error:'), `Unknown self subcommand: ${sub}`);
    console.log(usage());
    process.exit(1);
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
