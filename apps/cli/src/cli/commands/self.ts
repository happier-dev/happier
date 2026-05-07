import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import packageJson from '../../../package.json';
import { configuration } from '@/configuration';
import type { CommandContext } from '@/cli/commandRegistry';
import {
  FIRST_PARTY_COMPONENT_IDS,
  installVersionedPayload,
  resolveInstalledFirstPartyComponentPaths,
  resolveFirstPartyComponentPublicReleaseVariant,
  resolveManagedCliReleaseChannelSync,
  resolveManagedCliToolNameForRing,
} from '@happier-dev/cli-common/firstPartyRuntime';
import type { FirstPartyComponentId } from '@happier-dev/cli-common/firstPartyRuntime';
import { createStepPrinter } from '@happier-dev/cli-common/output';
import {
  compareVersions,
  readNpmDistTagVersion,
  readUpdateCache,
  resolveNpmPackageNameOverride,
  writeUpdateCache,
} from '@happier-dev/cli-common/update';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';
import {
  getReleaseRingCatalogEntry,
  getReleaseRingPublicLabel,
  normalizePublicReleaseRingId,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';
import {
  resolveCliBinaryAssetBundleFromReleaseAssets,
  updateInstalledCliPayloadFromReleaseAssets,
} from '@/cli/runtime/update/binarySelfUpdate';
import { handleSelfMigrateCommand } from './self/handleSelfMigrateCommand';
import { maybeRunVersionGatedRuntimeMigration } from './self/maybeRunVersionGatedRuntimeMigration';
import { maybeRunDoctorRepair } from './self/maybeRunDoctorRepair';
import { quiesceInstalledCliWindowsPayloadOwners } from '@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners';

type SelfChannel = PublicReleaseRingId;

function usage(): string {
  return [
    `${chalk.bold('happier self')} - Self update + update checks`,
    '',
    `${chalk.bold('Usage:')}`,
    `  happier self check [--preview|--dev|--channel=<preview|dev>] [--quiet]`,
    `  happier self update [--preview|--dev|--channel=<preview|dev>] [--to <versionOrTag>]`,
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

/**
 * The `next` npm dist-tag is shared by both preview and dev channels. When
 * `npm view @happier-dev/cli@next version` returns a version, it might be from
 * either channel. Verify the fetched version's prerelease identifier matches
 * the channel we're on — otherwise we'd announce "update available" across
 * channels (e.g. dev 0.2.5 being "updated" to preview 0.2.2).
 *
 * Prerelease tag contracts:
 *  - stable:  no prerelease identifier (e.g. "0.2.3")
 *  - preview: "-preview." prerelease (e.g. "0.2.3-preview.17...")
 *  - dev:     "-dev." prerelease     (e.g. "0.2.5-dev.17...")
 */
export function doesVersionMatchChannel(version: string | null, channel: SelfChannel): boolean {
  const v = String(version ?? '').trim();
  if (!v) return false;
  const prereleaseIndex = v.indexOf('-');
  const prerelease = prereleaseIndex >= 0 ? v.slice(prereleaseIndex + 1) : '';
  if (channel === 'stable') {
    return prerelease === '';
  }
  if (channel === 'preview') {
    return prerelease.startsWith('preview.') || prerelease === 'preview';
  }
  // publicdev
  return prerelease.startsWith('dev.') || prerelease === 'dev';
}

function resolveSelfReleaseChannel(params: Readonly<{
  args: readonly string[];
  rawArgv?: readonly string[];
  invokedPath?: string | null;
}>): ReturnType<typeof resolveManagedCliReleaseChannelSync> {
  return resolveManagedCliReleaseChannelSync({
    args: params.args,
    argv: params.rawArgv ?? process.argv,
    invokedPath: params.invokedPath ?? process.argv[1] ?? '',
    processEnv: process.env,
  });
}

export function parseSelfChannel(args: string[], invokedPath = process.argv[1] ?? ''): SelfChannel {
  return resolveSelfReleaseChannel({ args, invokedPath }).ringId;
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

function resolvePublicReleaseRingSuffix(ring: SelfChannel): 'stable' | 'preview' | 'dev' {
  return getReleaseRingPublicLabel(ring);
}

function updateCachePath(channel: SelfChannel): string {
  const suffix = resolvePublicReleaseRingSuffix(channel);
  const fileName = suffix === 'stable' ? 'update.json' : `update.${suffix}.json`;
  return join(configuration.happyHomeDir, 'cache', fileName);
}

function runtimeDir(channel: SelfChannel): string {
  const suffix = resolvePublicReleaseRingSuffix(channel);
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

async function runSelfUpdateStep<T>(
  steps: ReturnType<typeof createStepPrinter>,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  steps.start(label);
  try {
    const result = await fn();
    steps.stop('✓', label);
    return result;
  } catch (error) {
    steps.stop('x', label);
    throw error;
  }
}

async function cmdCheck(argv: string[], rawArgv: readonly string[] = process.argv): Promise<void> {
  const channelResolution = resolveSelfReleaseChannel({ args: argv, rawArgv });
  const channel = channelResolution.ringId;
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
      console.log(chalk.gray('Run:'), chalk.cyan(`${resolveManagedCliToolNameForRing(channel)} self update`));
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

  const rawLatest = readNpmDistTagVersion({ packageName: pkgName, distTag, cwd: process.cwd(), env: process.env });
  // Reject cross-channel results (preview/dev share the `next` dist-tag).
  const latest = doesVersionMatchChannel(rawLatest, channel) ? rawLatest : null;
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
    console.log(chalk.gray('Run:'), chalk.cyan(`${resolveManagedCliToolNameForRing(channel)} self update`));
    return;
  }
  console.log(chalk.green('Up to date.'));
}

async function cmdUpdate(argv: string[], rawArgv: readonly string[] = process.argv): Promise<void> {
  const channelResolution = resolveSelfReleaseChannel({ args: argv, rawArgv });
  const channel = channelResolution.ringId;
  const steps = createStepPrinter({ enabled: true });
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
  const release = await runSelfUpdateStep(steps, 'Resolving release metadata', async () => {
    return await fetchGitHubReleaseByTag({
      githubRepo,
      tag,
      githubToken,
      userAgent: 'happier-cli',
    });
  });
  const assets = typeof release === 'object' && release != null && 'assets' in release ? (release as any).assets : null;
  resolveCliBinaryAssetBundleFromReleaseAssets({
    assets,
    os,
    arch,
    preferVersion: effective.preferVersion,
  });

  await quiesceInstalledCliWindowsPayloadOwners({
    channel: effective.channel,
    processEnv: {
      ...process.env,
      HAPPIER_HOME_DIR: configuration.happyHomeDir,
    },
  });

  const result = await runSelfUpdateStep(steps, 'Downloading and installing payload', async () => {
    return await updateInstalledCliPayloadFromReleaseAssets({
      assets,
      os,
      arch,
      happyHomeDir: configuration.happyHomeDir,
      preferVersion: effective.preferVersion,
      minisignPubkeyFile,
      channel: effective.channel,
    });
  });

  // Refresh cache best-effort.
  await runSelfUpdateStep(steps, 'Refreshing update cache', async () => {
    await cmdCheck([
      'check',
      '--quiet',
      ...(effective.channel === 'preview'
        ? ['--preview']
        : effective.channel === 'publicdev'
          ? ['--dev']
          : []),
    ]);
  });
  const updatedToolName = resolveManagedCliToolNameForRing(effective.channel);
  console.log(chalk.green(`✓ Updated ${updatedToolName} to ${result.updatedTo}`));
  const migrationRan = await maybeRunVersionGatedRuntimeMigration({
    fromVersion: result.previousVersionId,
    toVersion: result.updatedTo,
    hadLegacyCurrentInstallWithoutVersionMarkers: result.hadLegacyCurrentInstallWithoutVersionMarkers,
    argv: ['repair'],
    commandPath: `${updatedToolName} doctor`,
  });
  await maybeRunDoctorRepair({
    migrationRan,
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

async function withInstalledCliMigrationRuntime<T>(params: Readonly<{
  channel: PublicReleaseRingId;
  run: () => Promise<T>;
}>): Promise<T> {
  const installedCliPaths = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel: params.channel,
    processEnv: process.env,
  });
  const scopedEnvUpdates = {
    HAPPIER_DAEMON_SERVICE_CHANNEL: params.channel,
    HAPPIER_PUBLIC_RELEASE_CHANNEL: getReleaseRingCatalogEntry(params.channel).publicLabel,
    HAPPIER_DAEMON_SERVICE_NODE_PATH: installedCliPaths.binaryPath,
    HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
  } as const;
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(scopedEnvUpdates)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await params.run();
  } finally {
    for (const [key, previousValue] of previousEnv.entries()) {
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

async function cmdInternalInstallPayload(argv: string[], rawArgv: readonly string[] = process.argv): Promise<void> {
  const componentId = parseFirstPartyComponentId(resolveInternalInstallPayloadArgValue(argv, '--component'));
  const payloadRoot = resolveInternalInstallPayloadArgValue(argv, '--payload-root');
  const versionId = resolveInternalInstallPayloadArgValue(argv, '--version');
  const channel = normalizePublicReleaseRingId(resolveInternalInstallPayloadArgValue(argv, '--channel'))
    || resolveSelfReleaseChannel({ args: argv, rawArgv }).ringId;

  if (!payloadRoot) {
    throw new Error('--payload-root is required');
  }
  if (!versionId) {
    throw new Error('--version is required');
  }

  if (componentId === 'happier-cli') {
    await quiesceInstalledCliWindowsPayloadOwners({
      channel,
      processEnv: process.env,
    });
  }

  const promotion = await installVersionedPayload({
    componentId,
    channel,
    payloadRoot,
    processEnv: process.env,
    versionId,
  });

  if (componentId === 'happier-cli') {
    await withInstalledCliMigrationRuntime({
      channel,
      run: async () => await maybeRunVersionGatedRuntimeMigration({
        fromVersion: promotion.previousVersionId,
        toVersion: promotion.currentVersionId,
        hadLegacyCurrentInstallWithoutVersionMarkers: promotion.hadLegacyCurrentInstallWithoutVersionMarkers,
        argv: ['repair'],
        commandPath: 'happier doctor',
        // Install-payload promotion is spawned by installer scripts with no
        // controlling TTY — migration must run headlessly here.
        forceNonInteractive: true,
      }),
    });
    return;
  }
}

export async function handleSelfCliCommand(context: CommandContext): Promise<void> {
  try {
    const argv = context.args.slice(1);
    const sub = argv[0] ?? 'help';
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      console.log(usage());
      return;
    }
    if (sub === 'check') {
      await cmdCheck(argv.slice(1), context.rawArgv);
      return;
    }
    if (sub === 'update') {
      await cmdUpdate(argv.slice(1), context.rawArgv);
      return;
    }
    if (sub === 'migrate') {
      await handleSelfMigrateCommand(argv.slice(1));
      return;
    }
    if (sub === '__install-payload') {
      await cmdInternalInstallPayload(argv.slice(1), context.rawArgv);
      return;
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
