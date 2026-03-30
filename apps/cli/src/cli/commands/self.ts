import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import packageJson from '../../../package.json';
import { configuration } from '@/configuration';
import type { CommandContext } from '@/cli/commandRegistry';
import {
  FIRST_PARTY_COMPONENT_IDS,
  installVersionedPayload,
  resolveFirstPartyComponentPublicReleaseVariant,
} from '@happier-dev/cli-common/firstPartyRuntime';
import type { FirstPartyComponentId } from '@happier-dev/cli-common/firstPartyRuntime';
import {
  compareVersions,
  readNpmDistTagVersion,
  readUpdateCache,
  resolveNpmPackageNameOverride,
  writeUpdateCache,
} from '@happier-dev/cli-common/update';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolvePublicReleaseRingIdFromCliArgs } from '@/cli/runtime/publicReleaseChannel';
import {
  resolveCliBinaryAssetBundleFromReleaseAssets,
  updateInstalledCliPayloadFromReleaseAssets,
} from '@/cli/runtime/update/binarySelfUpdate';

type SelfChannel = PublicReleaseRingId;

function usage(): string {
  return [
    `${chalk.bold('happier self')} - Self update + update checks`,
    '',
    `${chalk.bold('Usage:')}`,
    `  happier self check [--preview|--dev|--channel=<preview|dev>] [--quiet]`,
    `  happier self update [--preview|--dev|--channel=<preview|dev>] [--to <versionOrTag>]`,
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
  return ring === 'publicdev' ? 'dev' : ring;
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
      console.log(chalk.gray('Run:'), chalk.cyan('happier self update'));
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

  await installVersionedPayload({
    componentId,
    channel,
    payloadRoot,
    processEnv: process.env,
    versionId,
  });
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
      await cmdCheck(argv.slice(1));
      return;
    }
    if (sub === 'update') {
      await cmdUpdate(argv.slice(1));
      return;
    }
    if (sub === '__install-payload') {
      await cmdInternalInstallPayload(argv.slice(1));
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
