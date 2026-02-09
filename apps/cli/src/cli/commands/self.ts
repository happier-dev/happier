import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import packageJson from '../../../package.json';
import { configuration } from '@/configuration';
import type { CommandContext } from '@/cli/commandRegistry';
import {
  compareVersions,
  installRuntimeFromNpm,
  readNpmDistTagVersion,
  readUpdateCache,
  resolveNpmPackageNameOverride,
  writeUpdateCache,
} from '@happier-dev/cli-common/update';

type SelfChannel = 'stable' | 'preview';

function usage(): string {
  return [
    `${chalk.bold('happier self')} - Self update + update checks`,
    '',
    `${chalk.bold('Usage:')}`,
    `  happier self check [--preview|--channel=preview] [--quiet]`,
    `  happier self update [--preview|--channel=preview] [--to <versionOrTag>]`,
    `  happier self-update [--check] [--preview|--channel=preview] [--to <versionOrTag>]`,
    '',
    `${chalk.bold('Channels:')}`,
    `  stable  → npm dist-tag ${chalk.cyan('latest')}`,
    `  preview → npm dist-tag ${chalk.cyan('next')}`,
    '',
    `${chalk.bold('Environment:')}`,
    `  HAPPIER_CLI_UPDATE_CHECK=0                 Disable update notice + background check`,
    `  HAPPIER_CLI_UPDATE_PACKAGE_NAME=@scope/pkg Override the npm package name checked/installed`,
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

export function parseSelfChannel(args: string[]): SelfChannel {
  if (args.includes('--preview')) return 'preview';
  const ch = args.find((a) => a === '--channel' || a.startsWith('--channel='));
  if (!ch) return 'stable';
  const value = ch === '--channel' ? (args[args.indexOf(ch) + 1] ?? '') : ch.slice('--channel='.length);
  return String(value).trim() === 'preview' ? 'preview' : 'stable';
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
  return `${pkg}@${params.channel === 'preview' ? 'next' : 'latest'}`;
}

export function detectInstallSource(path: string): 'npm' | 'binary' {
  const raw = String(path ?? '').trim();
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.includes('/node_modules/')) return 'npm';
  return 'binary';
}

function npmUpgradeCommand(params: Readonly<{ packageName: string; channel: SelfChannel; to: string }>): string {
  const pkg = String(params.packageName ?? '').trim();
  const to = String(params.to ?? '').trim();
  if (to) return `npm install -g ${pkg}@${to}`;
  return `npm install -g ${pkg}@${params.channel === 'preview' ? 'next' : 'latest'}`;
}

function cachePath(): string {
  return join(configuration.happyHomeDir, 'cache', 'update.json');
}

function runtimeDir(): string {
  return join(configuration.happyHomeDir, 'runtime');
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
  const distTag = channel === 'preview' ? 'next' : 'latest';
  const pkgName = resolveUpdatePackageName();

  const runtimePkgJson = packageJsonPathForNodeModules({ rootDir: runtimeDir(), packageName: pkgName });
  const runtimeVersion = runtimePkgJson ? readPackageJsonVersion(runtimePkgJson) : null;
  const invokerVersion = configuration.currentCliVersion;
  const current = runtimeVersion || invokerVersion || null;

  const latest = readNpmDistTagVersion({ packageName: pkgName, distTag, cwd: process.cwd(), env: process.env });
  const updateAvailable = Boolean(current && latest && compareVersions(latest, current) > 0);

  const existing = readUpdateCache(cachePath());
  const checkedAt = Date.now();
  writeUpdateCache(cachePath(), {
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

  const pkgName = resolveUpdatePackageName();
  const installSource = detectInstallSource(process.argv[1] ?? '');
  if (installSource === 'npm') {
    const upgrade = npmUpgradeCommand({ packageName: pkgName, channel, to: toArg });
    console.log(chalk.yellow('Detected npm-based install; in-place runtime update is disabled.'));
    console.log(chalk.gray('Run instead:'), chalk.cyan(upgrade));
    return;
  }
  const spec = computeSelfUpdateSpec({ packageName: pkgName, channel, to: toArg });
  const res = installRuntimeFromNpm({ runtimeDir: runtimeDir(), spec, cwd: process.cwd(), env: process.env });
  if (!res.ok) {
    console.error(chalk.red('Error:'), res.errorMessage);
    process.exit(1);
  }

  // Refresh cache best-effort.
  await cmdCheck(['check', '--quiet', ...(channel === 'preview' ? ['--preview'] : [])]);
  console.log(chalk.green('✓ Updated runtime.'));
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
