import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import packageJson from '../../../package.json';
import { configuration } from '@/configuration';
import type { CommandContext } from '@/cli/commandRegistry';
import {
  FIRST_PARTY_COMPONENT_IDS,
  FirstPartyPayloadMutationLockError,
  installVersionedPayload,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveFirstPartyComponentRelease,
  resolveInstalledFirstPartyComponentPaths,
  resolveManagedCliReleaseChannelSync,
  resolveManagedCliToolNameForRing,
  runManagedCliUpdate,
} from '@happier-dev/cli-common/firstPartyRuntime';
import type { FirstPartyComponentId } from '@happier-dev/cli-common/firstPartyRuntime';
import { cmd, createStepPrinter, fail } from '@happier-dev/cli-common/output';
import {
  compareVersions,
  readCachedCliUpdateState,
  readNpmDistTagVersion,
  recordCliUpdateCheck,
  resolveNpmPackageNameOverride,
} from '@happier-dev/cli-common/update';
import {
  getReleaseRingCatalogEntry,
  normalizePublicReleaseRingId,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';
import { handleSelfMigrateCommand } from './self/handleSelfMigrateCommand';
import { maybeRunVersionGatedRuntimeMigration } from './self/maybeRunVersionGatedRuntimeMigration';
import { maybeRunDoctorRepair } from './self/maybeRunDoctorRepair';
import { resolveRunningCliPackageManagerOrigin } from '@/cli/runtime/update/cliUpdateFacts';
import { reportUpdaterAdmission } from '@/cli/runtime/update/updaterAdmission';
import {
  quiesceInstalledCliWindowsPayloadOwners,
  resolvePayloadOwnerStopTimeoutMs,
} from '@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners';
import { planServiceDaemonsRestartAfterUpdate } from '@/cli/runtime/update/restartServiceDaemonAfterUpdate';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { resolveCliVersionFromBinary } from '@/daemon/service/resolveCliVersionFromBinary';

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
    `  stable  → npm dist-tag ${cmd('latest')}`,
    `  preview → npm dist-tag ${cmd('next')}`,
    `  dev     → npm dist-tag ${cmd('next')} (${chalk.gray('dev rolling binaries')})`,
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

function npmUpgradeCommand(params: Readonly<{ packageName: string; channel: SelfChannel; to: string }>): string {
  const pkg = String(params.packageName ?? '').trim();
  const to = String(params.to ?? '').trim();
  if (to) return `npm install -g ${pkg}@${to}`;
  return `npm install -g ${pkg}@${resolveSelfNpmDistTag(params.channel)}`;
}

function runtimeDir(channel: SelfChannel): string {
  const suffix = getReleaseRingCatalogEntry(channel).publicLabel;
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
    // The acquisition owner's own release lookup: the version `self update` would install, on
    // every OS the release publishes (Windows included).
    const { versionId: latest } = await resolveFirstPartyComponentRelease({
      componentId: 'happier-cli',
      channel,
      githubRepo: resolveBinaryUpdateRepo(process.env),
      githubToken: resolveBinaryUpdateToken(process.env),
      userAgent: 'happier-cli',
    });
    const current = configuration.currentCliVersion || null;
    recordCliUpdateCheck({
      homeDir: configuration.happyHomeDir,
      publicReleaseRing: channel,
      latest,
      current,
      runtimeVersion: null,
      invokerVersion: configuration.currentCliVersion,
    });
    if (quiet) return;
    printCheckResult({ channel, current, latest });
    return;
  }
  const distTag = resolveSelfNpmDistTag(channel);
  const pkgName = resolveUpdatePackageName();

  const runtimePkgJson = packageJsonPathForNodeModules({ rootDir: runtimeDir(channel), packageName: pkgName });
  const runtimeVersion = runtimePkgJson ? readPackageJsonVersion(runtimePkgJson) : null;
  const invokerVersion = configuration.currentCliVersion;
  const current = runtimeVersion || invokerVersion || null;

  // Rejects cross-channel results itself (preview/dev share the `next` dist-tag).
  recordCliUpdateCheck({
    homeDir: configuration.happyHomeDir,
    publicReleaseRing: channel,
    latest: readNpmDistTagVersion({ packageName: pkgName, distTag, cwd: process.cwd(), env: process.env }),
    current,
    runtimeVersion,
    invokerVersion,
  });
  if (quiet) return;
  const cached = current
    ? readCachedCliUpdateState({ homeDir: configuration.happyHomeDir, publicReleaseRing: channel, currentVersion: current })
    : null;
  if (!cached?.latestVersion) {
    console.log(chalk.gray('Unable to determine latest version (npm view failed).'));
    return;
  }
  printCheckResult({ channel, current, latest: cached.latestVersion });
}

function printCheckResult(params: Readonly<{ channel: SelfChannel; current: string | null; latest: string }>): void {
  if (params.current && compareVersions(params.latest, params.current) > 0) {
    console.log(chalk.yellow(`Update available: ${params.current} → ${params.latest}`));
    console.log(chalk.gray('Run:'), cmd(`${resolveManagedCliToolNameForRing(params.channel)} self update`));
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
    console.log(chalk.gray('Run instead:'), cmd(upgrade));
    reportUpdaterAdmission({ admitted: false, code: 'cli_not_managed', message: `This Happier CLI was installed with npm. Update it with: ${upgrade}` });
    return;
  }
  const origin = resolveRunningCliPackageManagerOrigin({
    invokedPath: process.argv[1] ?? '',
    execPath: process.execPath,
    npmPackageName: resolveUpdatePackageName(),
  });
  if (origin?.kind === 'brew') {
    console.log(chalk.yellow('Detected a Homebrew install; Homebrew updates it.'));
    console.log(chalk.gray('Run instead:'), cmd(origin.updateCommand));
    reportUpdaterAdmission({ admitted: false, code: 'cli_not_managed', message: `This Happier CLI was installed with Homebrew. Update it with: ${origin.updateCommand}` });
    return;
  }

  const effective = (() => {
    const raw = String(toArg ?? '').trim();
    if (raw === 'latest') return { channel: 'stable' as const, targetVersion: undefined };
    if (raw === 'next') return { channel: 'preview' as const, targetVersion: undefined };
    const v = raw.startsWith('v') ? raw.slice(1) : raw;
    return { channel, targetVersion: v || undefined };
  })();
  const processEnv = { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir };

  // Observed before anything changes: on Windows the update stops the payload's processes (every
  // relay's daemon), and only this observation still knows which service daemons must come back.
  const restartPlan = await planServiceDaemonsRestartAfterUpdate({
    channel: effective.channel,
    ownerBeforeUpdate: await evaluateCurrentDaemonOwner(),
    processEnv,
  });

  const result = await runSelfUpdateStep(steps, 'Downloading, verifying and installing', async () => await runManagedCliUpdate({
    channel: effective.channel,
    processEnv,
    // A daemon that started this run (remote `cli.update.v1`) answers its task only after this.
    onAdmitted: () => reportUpdaterAdmission({ admitted: true }),
    targetVersion: effective.targetVersion,
    preparePayload: async (params) => await prepareFirstPartyComponentPayloadFromGitHubRelease({
      ...params,
      githubRepo: resolveBinaryUpdateRepo(process.env),
      githubToken: resolveBinaryUpdateToken(process.env),
      userAgent: 'happier-cli',
      minisignPubkeyFile: String(process.env.HAPPIER_MINISIGN_PUBKEY ?? '').trim() || undefined,
    }),
    readVersion: async (command) => resolveCliVersionFromBinary({
      binaryPath: command,
      platform: process.platform,
      timeoutMs: resolvePayloadOwnerStopTimeoutMs(processEnv),
    }),
    beforeActivate: process.platform === 'win32'
      ? async () => await quiesceInstalledCliWindowsPayloadOwners({ channel: effective.channel, processEnv })
      : undefined,
    restartServiceDaemon: restartPlan.restart,
  }));
  if (result.outcome !== 'succeeded') {
    throw new Error(result.message);
  }

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
  console.log(chalk.green(result.changed
    ? `✓ Updated ${updatedToolName} to ${result.targetVersion}`
    : `✓ ${updatedToolName} is already ${result.targetVersion}`));
  if (result.restarted) {
    console.log(chalk.green(restartPlan.labels.length > 1
      ? `✓ The background services (${restartPlan.labels.join(', ')}) now run ${result.targetVersion}`
      : `✓ The background service now runs ${result.targetVersion}`));
  }
  if (restartPlan.unmanagedMessage) {
    console.log(chalk.yellow(restartPlan.unmanagedMessage));
  }
  const migrationRan = await maybeRunVersionGatedRuntimeMigration({
    fromVersion: result.previousVersion,
    toVersion: result.targetVersion,
    argv: ['repair'],
    commandPath: `${updatedToolName} doctor`,
  });
  await maybeRunDoctorRepair({
    migrationRan,
    channel: effective.channel,
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

function shouldSkipInstallPayloadMigration(processEnv: NodeJS.ProcessEnv): boolean {
  return processEnv.HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION === '1';
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

  // On Windows promotion stops every daemon of the payload (every relay's); the service daemons
  // observed running here come back afterwards through the same rule `self update` uses.
  const windowsServiceRestart = componentId === 'happier-cli' && process.platform === 'win32'
    ? await planServiceDaemonsRestartAfterUpdate({ channel, processEnv: process.env })
    : null;
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
    payloadRootAlreadyFiltered: true,
    processEnv: process.env,
    versionId,
    // The official installers run this for the channel the user asked them to install, and that
    // choice is what makes a channel the default `happier` command (install.sh / install.ps1).
    selectAsDefaultReleaseChannel: true,
  });

  if (windowsServiceRestart?.restart && promotion.currentVersionId) {
    // The installer continues either way (it installs the default service next); a daemon that did
    // not come back is named rather than failing the promotion.
    await windowsServiceRestart.restart({ expectedVersion: promotion.currentVersionId, phase: 'activated' })
      .catch((error: unknown) => {
        console.error(chalk.yellow(`Background services stopped for the update did not all come back: ${error instanceof Error ? error.message : String(error)}`));
      });
  }

  if (componentId === 'happier-cli' && !shouldSkipInstallPayloadMigration(process.env)) {
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
    console.error(fail(`Unknown self subcommand: ${sub}`));
    console.log(usage());
    process.exit(1);
  } catch (error) {
    // A detached updater that ends before admission tells the daemon waiting for it (no-op otherwise).
    reportUpdaterAdmission({
      admitted: false,
      code: error instanceof FirstPartyPayloadMutationLockError ? 'cli_update_in_progress' : 'cli_update_failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
